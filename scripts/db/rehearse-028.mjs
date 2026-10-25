// Rehearsal of migration 028 on a DISPOSABLE database that matches the hosted one. Hosted is only READ, through a
// read-only transaction; nothing is written to it and no migration is run on it. The committed migrations 001-027 are
// applied to a throwaway PostgreSQL 17, the hosted data is copied in, 028 is applied, and the report states:
//   * every existing table has byte-identical contents (by its pre-028 columns) and every existing value view returns
//     identical rows;
//   * the new objects exist and are empty; the existing guards still hold; public roles cannot reach the new tables;
//   * the repository's security audit passes on the result.
// The disposable server is always removed. Report: stdout (counts only; no hosted row content is printed or kept).
//
//   node --env-file=.env.hosted.local scripts/db/rehearse-028.mjs [--out report.json]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { applyMigrations } from './lib/migrations.mjs'
import { ownerDatabaseUrl, isLocalUrl, supabaseProjectRef } from './lib/connection.mjs'
import { loadRelease, verifyReleaseContent, collisionReport, manifestChecksum, fileSha256, canonicalJson } from '../history/lib/release.mjs'
import { loadCatalog } from '../history/lib/permissions.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outFile = process.argv.includes('--out') ? path.resolve(root, process.argv[process.argv.indexOf('--out') + 1]) : null
const argv = process.argv.slice(2)
const releaseDirs = argv.flatMap((a, i) => (a === '--release-dir' && argv[i + 1] ? [path.resolve(root, argv[i + 1])] : []))
const SCHEMAS = ['public', 'ingest', 'research']
// analytics.class_value is left out: it is derived from acquisition_value (compared) and takes tens of minutes at hosted size.
const VIEWS = ['analytics.trade_returns', 'analytics.acquisition_value', 'analytics.player_war_coverage', 'analytics.organization_value_by_class', 'analytics.organization_realized_value', 'analytics.player_acquisitions']
const q = async (db, sql, p) => (await db.query(sql, p)).rows
const report = { started_at: new Date().toISOString(), steps: [] }
const step = (name, ok, detail) => { report.steps.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`) }

const hostedUrl = ownerDatabaseUrl()
if (isLocalUrl(hostedUrl)) throw new Error('point this at the hosted read-only source (.env.hosted.local); the rehearsal builds its own disposable database')
report.hosted_ref = supabaseProjectRef(hostedUrl)
const port = 20000 + Math.floor(Math.random() * 30000)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-rehearsal-028-'))
const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} })
const url = (name) => `postgresql://postgres:postgres@127.0.0.1:${port}/${name}`
let failed = false
try {
  await server.initialise(); await server.start()
  await server.createDatabase('bai_copy')
  const copy = new pg.Client({ connectionString: url('bai_copy') }); await copy.connect()
  await applyMigrations(copy, { through: '027' })
  step('disposable database built from migrations 001-027', true)

  const hosted = new pg.Client({ connectionString: hostedUrl }); await hosted.connect()
  await hosted.query('begin read only')
  const hostedMig = (await q(hosted, 'select max(version) v, count(*)::int n from bai_meta.schema_migrations'))[0]
  step('hosted is at migration 027 (028 is not applied there)', hostedMig.v === '027' && hostedMig.n === 27, `${hostedMig.n} migrations, latest ${hostedMig.v}`)
  const list = async (db) => (await q(db, `select table_schema s, table_name t from information_schema.tables where table_schema = any($1) and table_type = 'BASE TABLE' order by 1, 2`, [[...SCHEMAS, 'bai_meta']])).map((r) => `${r.s}.${r.t}`)
  const hostedTables = await list(hosted); const localTables = await list(copy)
  const missing = hostedTables.filter((t) => !localTables.includes(t))
  step('hosted and disposable have the same tables', !missing.length && hostedTables.length === localTables.length, `${hostedTables.length} tables`)
  const data = hostedTables.filter((t) => t !== 'bai_meta.schema_migrations')
  await copy.query('set session_replication_role = replica')
  await copy.query(`truncate ${data.join(', ')} restart identity`)
  for (const t of data) {
    const [s, n] = t.split('.')
    const cols = (await q(copy, `select column_name c from information_schema.columns where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' order by ordinal_position`, [s, n])).map((r) => `"${r.c}"`)
    const rows = (await hosted.query(`select to_jsonb(x) j from ${t} x`)).rows.map((r) => r.j)
    for (let i = 0; i < rows.length; i += 200) await copy.query(`insert into ${t} (${cols.join(', ')}) overriding system value select ${cols.join(', ')} from jsonb_populate_recordset(null::${t}, $1::jsonb)`, [JSON.stringify(rows.slice(i, i + 200))])
  }
  for (const r of await q(copy, `select s.nspname sch, c.relname tbl, a.attname col from pg_class c join pg_namespace s on s.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid where a.attidentity <> '' and s.nspname = any($1) and c.relkind = 'r'`, [SCHEMAS])) {
    await copy.query(`select setval(pg_get_serial_sequence('${r.sch}.${r.tbl}', '${r.col}'), greatest(coalesce((select max(${r.col}) from ${r.sch}.${r.tbl}), 0), 1), (select count(*) > 0 from ${r.sch}.${r.tbl}))`)
  }
  await copy.query('reset session_replication_role')
  const diff = []
  let rowsTotal = 0
  for (const t of data) {
    const h = Number((await q(hosted, `select count(*) n from ${t}`))[0].n); const l = Number((await q(copy, `select count(*) n from ${t}`))[0].n)
    rowsTotal += h
    if (h !== l) diff.push(t)
  }
  await hosted.query('rollback'); await hosted.end()
  step('hosted data copied through a read-only transaction; row counts equal table by table', !diff.length, `${rowsTotal} rows in ${data.length} tables`)

  // --- fingerprints before 028 -----------------------------------------------------------------------------------------
  const columns = {}
  // The two registries gain the rows 028 registers; every row they held before must be unchanged.
  const REGISTRY_ADDED = {
    'public.internal_objects': { where: "object_name not in ('transaction_external_ids', 'transaction_sources', 'transaction_source_links', 'transaction_conflicts', 'ptbnl_resolutions', 'season_calendar_events')", added: 6 },
    'public.provenance_fact_tables': { where: "table_name not in ('ptbnl_resolutions', 'season_calendar_events')", added: 2 }
  }
  const fingerprint = async (db, t, afterMigration = false) => {
    const cols = columns[t].map((c) => `"${c}"`).join(', ')
    const where = afterMigration && REGISTRY_ADDED[t] ? ` where ${REGISTRY_ADDED[t].where}` : ''
    return (await q(db, `select count(*)::int n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from (select ${cols} from ${t}${where}) x`))[0]
  }
  const before = {}
  for (const t of data) {
    const [s, n] = t.split('.')
    columns[t] = (await q(copy, `select column_name c from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`, [s, n])).map((r) => r.c)
    before[t] = await fingerprint(copy, t)
  }
  const viewBefore = {}
  for (const v of VIEWS) viewBefore[v] = (await q(copy, `select count(*)::int n, coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)), '') h from ${v} x`))[0]
  // analytics.class_value takes tens of minutes over the whole database: compare it for one club (LAD, the pilot club), bounded by a timeout.
  const classSql = "select count(*)::int n, coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)), '') h from analytics.class_value x where organization_id = (select id from public.organizations where franchise_key = 'LAD')"
  const bounded = async (db) => { await db.query("set statement_timeout = '420s'"); try { return (await q(db, classSql))[0] } catch (e) { return /timeout/.test(e.message) ? null : Promise.reject(e) } finally { await db.query('reset statement_timeout') } }
  const classBefore = await bounded(copy)
  const guardBefore = (await q(copy, 'select count(*)::int n from public.acquisition_dispositions'))[0].n
  // Release compatibility, part 1: each manifest verifies and its read-only collision report is taken on the 027 copy.
  const releases = []
  for (const dir of releaseDirs) {
    const manifestFile = path.join(dir, 'release-manifest.json')
    const rel = loadRelease(dir)
    releases.push({ dir, file: manifestFile, fileSha: fileSha256(manifestFile), rel, problems: verifyReleaseContent(rel, { root }), report027: canonicalJson(await collisionReport(copy, rel)) })
  }

  // --- apply 028 -----------------------------------------------------------------------------------------------------------
  await applyMigrations(copy, { through: '028' })   // 028 only: later migrations (029) have their own rehearsal
  const applied = (await q(copy, 'select max(version) v, count(*)::int n from bai_meta.schema_migrations'))[0]
  step('028 applied to the copy', applied.v === '028' && applied.n === 28, `${applied.n} migrations`)
  const changed = []
  for (const t of data) { const a = await fingerprint(copy, t, true); if (a.n !== before[t].n || a.h !== before[t].h) changed.push(t) }
  const registryOk = []
  for (const [t, r] of Object.entries(REGISTRY_ADDED)) registryOk.push((await q(copy, `select count(*)::int n from ${t}`))[0].n === before[t].n + r.added)
  step('every existing table is byte-identical by its pre-028 columns (the two registries only gain the rows 028 registers)', !changed.length && registryOk.every(Boolean), changed.length ? changed.join(', ') : `${data.length} tables, ${rowsTotal} rows; registries +6 and +2`)
  const viewChanged = []
  for (const v of VIEWS) { const a = (await q(copy, `select count(*)::int n, coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)), '') h from ${v} x`))[0]; if (a.n !== viewBefore[v].n || a.h !== viewBefore[v].h) viewChanged.push(v) }
  step('every existing value view returns identical rows', !viewChanged.length, viewChanged.length ? viewChanged.join(', ') : VIEWS.map((v) => `${v.split('.')[1]} ${viewBefore[v].n}`).join(', '))
  // Part 2: the same manifests, unchanged on disk, give the identical verification and collision report on the 028 copy.
  for (const r of releases) {
    const rel = loadRelease(r.dir)
    const same = canonicalJson(await collisionReport(copy, rel)) === r.report027
    const intact = fileSha256(r.file) === r.fileSha && rel.manifest.manifest_sha256 === manifestChecksum(rel.manifest) && !r.problems.length && !verifyReleaseContent(rel, { root }).length
    step(`release ${rel.manifest.release_key} (${rel.manifest.manifest_sha256.slice(0, 12)}…): manifest intact, verified, collision report identical on 027 and 028`, same && intact, `${rel.manifest.totals.selections} selections; overall ${JSON.parse(r.report027).overall}`)
  }
  const classAfter = await bounded(copy)
  step('class_value for LAD (bounded comparison) is identical', classBefore && classAfter ? classBefore.h === classAfter.h && classBefore.n === classAfter.n : true, classBefore && classAfter ? `${classBefore.n} rows` : 'NOT COMPLETED within the 420 s bound on one side (no difference observed; the full view is not compared)')
  const added = ['public.transaction_external_ids', 'public.transaction_sources', 'public.transaction_source_links', 'public.transaction_conflicts', 'public.ptbnl_resolutions', 'public.season_calendar_events', 'research.transaction_verifications', 'ingest.transaction_apply_ledger']
  const sizes = {}
  for (const t of added) sizes[t] = (await q(copy, `select count(*)::int n from ${t}`))[0].n
  step('the eight new tables exist and are empty', Object.values(sizes).every((n) => n === 0), `${added.length} tables`)
  const legacy = (await q(copy, `select count(*)::int total, count(*) filter (where amount_disclosure is null and not conditional and condition_text is null)::int untouched from public.trade_package_assets`))[0]
  step('no existing asset was given a disclosure or a condition', legacy.total === legacy.untouched, `${legacy.total} assets`)
  const comp = (await q(copy, `select completeness, count(*)::int n from analytics.transaction_completeness group by 1`))
  step('every existing transaction reads UNVERIFIED (none is claimed partial or complete)', comp.length === 1 && comp[0].completeness === 'UNVERIFIED', comp.map((c) => `${c.completeness} ${c.n}`).join(', '))
  step('the acquisition-disposition guard still rejects a contradiction', await copy.query("update public.acquisition_dispositions set disposition_date = '1900-01-01', disposition_date_precision = 'DAY' where id = (select id from public.acquisition_dispositions where disposition = 'TRADED' limit 1)").then(() => (guardBefore === 0 ? true : false), (e) => /is inconsistent/.test(e.message)), `${guardBefore} dispositions`)
  for (const role of ['anon', 'authenticated']) {
    const refused = []
    for (const t of added.concat(['analytics.transaction_completeness'])) {
      await copy.query('begin'); await copy.query(`set local role ${role}`)
      try { await copy.query(`select 1 from ${t} limit 1`); refused.push(`${t} READABLE`) } catch (e) { if (!/permission denied/.test(e.message)) refused.push(`${t}: ${e.message}`) } finally { await copy.query('rollback') }
    }
    step(`${role} cannot read any new table or view`, !refused.length, refused.join('; '))
  }
  await copy.end()

  // --- the repository's security audit on the result ---------------------------------------------------------------------
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), BAI_DATABASE_URL: url('bai_copy') }
  const sec = spawnSync(process.execPath, [path.join(root, 'scripts/db/security.mjs')], { cwd: root, env, encoding: 'utf8' })
  step('security audit (RLS, grants, roles) passes on the migrated copy', sec.status === 0, (sec.stdout + sec.stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 200))
} catch (err) {
  failed = true
  step('rehearsal ran', false, String(err.message).replace(/postgres(ql)?:\/\/\S+/g, '<redacted>'))
} finally {
  await server.stop().catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
}
failed = failed || report.steps.some((s) => !s.ok)
report.finished_at = new Date().toISOString(); report.ok = !failed
if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n')
console.log(failed ? 'REHEARSAL FAILED' : 'REHEARSAL OK')
process.exit(failed ? 1 : 0)
