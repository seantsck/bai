// LOCAL-ONLY restore of a hosted logical export into a fresh database: the AUTHORITATIVE staging baseline for a promotion (G5-5E). Unlike restore-snapshot.mjs it preserves the
// hosted sequence values and the migration ledger's applied_at (see scripts/db/lib/export-restore.mjs), and the schema as hosted holds it.
//   node scripts/db/restore-export.mjs --backup-dir ~/bai-backups/g1-<UTC> --database-url postgresql://…@127.0.0.1:…/<new empty database> [--hosted-state <collector json>] [--audit]
//   (or --export-dir <dir> --snapshot-dir <dir> instead of --backup-dir)
// Steps: stand-in roles; roles.sql, schema.sql, data.sql through psql (every error must be a known platform-only class); the platform's ensure_rls event trigger re-created as hosted has it;
// then independent checks, all of which must pass: every row equals the checksummed snapshot (hosted-preflight); every sequence equals the export's setval; the migration ledger is the
// committed migrations with their checksums, the CLI history matches, and applied_at precedes the export; the only event-trigger handler is the allowed platform one; the BAI catalog equals
// a reference built from the migrations except for explained platform differences; with --hosted-state, the per-table fingerprints, sequences and grant rows equal the recorded hosted state.
// --audit also runs the security audit (full and read-only) on the result. Hosted is never contacted; nothing here applies migration 032.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { isLocalUrl } from './lib/connection.mjs'
import { applyMigrations } from './lib/migrations.mjs'
import { catalogSnapshot, diffSnapshots } from './lib/catalog.mjs'
import { runSecurityAudit } from './lib/security-audit.mjs'
import { PLATFORM_EVENT_FUNCTIONS, collectBaseline, compareBaselines, compareSequences, checkMigrations, emulatePlatformEventTriggers, eventTriggerFunctions, explainCatalog, prepareStandIns, runExport, sequencesInDatabase, sequencesInExport } from './lib/export-restore.mjs'

const argv = process.argv.slice(2)
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const backup = opt('backup-dir'); const exportDir = opt('export-dir') ?? (backup && path.join(backup, 'export')); const snapDir = opt('snapshot-dir') ?? (backup && path.join(backup, 'snapshot'))
const url = opt('database-url'); const hostedState = opt('hosted-state')
if (!exportDir || !snapDir || !url) { console.error('usage: --backup-dir <dir> (or --export-dir and --snapshot-dir) --database-url <local empty database> [--hosted-state <json>] [--audit]'); process.exit(2) }
if (!isLocalUrl(url)) { console.error('refusing: restore is local-only'); process.exit(2) }
for (const f of ['roles.sql', 'schema.sql', 'data.sql', 'MANIFEST.txt', 'supabase_migrations_history.json']) if (!fs.existsSync(path.join(exportDir, f))) { console.error(`missing ${f} in ${exportDir}`); process.exit(2) }
const level = JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8')).migrations.v
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const report = { database_level: level, restore_errors_by_platform_class: {}, problems: [] }
const db = new pg.Client({ connectionString: url }); await db.connect()
try {
  if ((await db.query("select count(*)::int n from information_schema.schemata where schema_name in ('bai_meta','analytics','research','ingest')")).rows[0].n > 0) throw new Error('the target already holds BAI schemas; restore into a new empty database')
  await prepareStandIns(db)
  const r = runExport(url, exportDir); report.restore_errors_by_platform_class = r.classes; report.problems.push(...r.unexpected)
  report.event_triggers_created = await emulatePlatformEventTriggers(db)
  // rows equal the snapshot
  const pre = spawnSync(process.execPath, [path.join(root, 'scripts/db/hosted-preflight.mjs'), '--snapshot-dir', snapDir, '--expect-level', level], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, BAI_DATABASE_URL: url } })
  report.rows_equal_snapshot = pre.status === 0; if (pre.status !== 0) report.problems.push('rows differ from the snapshot: ' + pre.stdout.split('\n').filter((l) => /^FAIL/.test(l)).slice(0, 5).join(' | '))
  // sequences, migration ledger, event-trigger handlers
  const seqProblems = compareSequences(sequencesInExport(exportDir), await sequencesInDatabase(db)); report.sequences_equal_export = seqProblems.length === 0; report.problems.push(...seqProblems.map((p) => `sequence: ${p}`))
  const mig = await checkMigrations(db, exportDir, level); report.migration_ledger = { versions: mig.versions, ok: mig.problems.length === 0 }; report.problems.push(...mig.problems)
  const handlers = await eventTriggerFunctions(db); report.event_trigger_handlers = handlers; for (const f of handlers) if (!PLATFORM_EVENT_FUNCTIONS.includes(f)) report.problems.push(`unexpected event-trigger handler ${f}: the security audit would skip it`)
  // catalog against a reference built from the migrations
  const refName = `${new URL(url).pathname.slice(1)}__reference`; const admin = new pg.Client({ connectionString: url.replace(/\/[^/?]+(\?|$)/, '/postgres$1') }); await admin.connect()
  await admin.query(`drop database if exists "${refName}"`); await admin.query(`create database "${refName}"`)
  const ref = new pg.Client({ connectionString: url.replace(/\/[^/?]+(\?|$)/, `/${refName}$1`) }); await ref.connect()
  try { await applyMigrations(ref, { through: level }); const diffs = diffSnapshots(await catalogSnapshot(ref), await catalogSnapshot(db))
    report.catalog_explained_differences = diffs.filter((d) => explainCatalog(d)).map((d) => `${d.key}: ${explainCatalog(d)}`)
    const un = diffs.filter((d) => !explainCatalog(d)); report.problems.push(...un.map((d) => `catalog ${d.key}: reference ${String(d.reference).slice(0, 80)} | restored ${String(d.target).slice(0, 80)}`)) } finally { await ref.end(); await admin.query(`drop database if exists "${refName}"`); await admin.end() }
  const restored = await collectBaseline(db); report.baseline = { tables: Object.keys(restored.fingerprints).length, rows: Object.values(restored.fingerprints).reduce((a, f) => a + f.n, 0) }
  if (hostedState) { const rec = JSON.parse(fs.readFileSync(hostedState, 'utf8')).state ?? JSON.parse(fs.readFileSync(hostedState, 'utf8')); const p = compareBaselines(rec, restored); report.equals_recorded_hosted_state = p.length === 0; report.problems.push(...p) }
  if (argv.includes('--audit')) {
    report.security_audit = {}
    for (const [name, o] of [['full', { readOnly: false, localDb: true }], ['read_only', { readOnly: true, localDb: true }]]) { const a = await runSecurityAudit(db, o); report.security_audit[name] = { failures: a.failures, notes: a.notes.filter((n) => /platform function/.test(n)) }; report.problems.push(...a.failures.map((f) => `security audit (${name}): ${f}`)) }
  }
} catch (e) { report.problems.push(`restore crashed: ${e.message}`) } finally { await db.end() }
report.ok = report.problems.length === 0
console.log(JSON.stringify(report, null, 1)); process.exit(report.ok ? 0 : 1)
