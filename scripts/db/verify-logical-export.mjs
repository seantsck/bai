// Proves a Supabase logical export (roles.sql, schema.sql, data.sql from `supabase db dump`: --role-only, default schema, --data-only --use-copy) is readable and
// restorable, in a THROWAWAY PostgreSQL 17 that has none of the Supabase platform. Local only; nothing hosted is contacted.
//   node scripts/db/verify-logical-export.mjs --export-dir <dir with roles.sql schema.sql data.sql> --snapshot-dir <checksummed snapshot of the same moment>
// 1. minimal stand-ins for the platform roles/schemas the export refers to (anon, authenticated, service_role, authenticator, supabase_* ...);
// 2. roles.sql, schema.sql, data.sql through psql, collecting every error; each must be one of the known PLATFORM-ONLY classes below, anything else fails;
// 3. the restored rows must equal the snapshot (hosted-preflight, strict); 4. the restored BAI catalog must equal a reference built from the migrations
//    (scripts/db/lib/catalog.mjs), differing only where the platform is involved. Prints what the export could NOT restore.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { applyMigrations } from './lib/migrations.mjs'
import { catalogSnapshot, diffSnapshots } from './lib/catalog.mjs'

const argv = process.argv.slice(2)
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const exportDir = opt('export-dir'); const snapDir = opt('snapshot-dir')
if (!exportDir || !snapDir) { console.error('usage: --export-dir <dir> --snapshot-dir <dir>'); process.exit(2) }
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
for (const f of ['roles.sql', 'schema.sql', 'data.sql']) if (!fs.existsSync(path.join(exportDir, f))) { console.error(`missing ${f}`); process.exit(2) }

/** Errors that exist only because the target is not a Supabase project. Each class says why; anything unmatched fails the verification. */
const PLATFORM_ONLY = [
  [/extension "(pg_stat_statements|supabase_vault)" is not available|could not open extension control file.*(pg_stat_statements|supabase_vault)/, 'a Supabase-provided extension (pg_stat_statements, supabase_vault) is not installed on plain PostgreSQL'],
  [/role "(supabase_[a-z_]+|dashboard_user|pgbouncer|cli_login[a-z_]*)" does not exist/, 'a Supabase platform role is absent'],
  [/schema "(vault|extensions)" does not exist/, 'a Supabase platform schema is absent'],
  [/parameter "log_min_messages"|GRANT SET ON PARAMETER/, 'a platform-role parameter grant (supabase_realtime_admin)'],
  [/relation "vault\./, 'an object that depends on the supabase_vault extension'],
  [/schema "(auth|storage)" does not exist|relation "(auth|storage)\.[a-z_]+" does not exist/, 'Supabase auth/storage platform tables in the data dump (BAI keeps nothing there)'],
  [/publication "supabase_realtime" does not exist/, 'the Supabase realtime publication']
]
/** Catalog differences that the platform or pg_dump itself explains. Anything not matched here fails. */
const explainCatalog = (d) => {
  if (/^(function|execute)\|public\.rls_auto_enable\(\)$/.test(d.key)) return 'public.rls_auto_enable() is Supabase\'s event-trigger function; it exists on hosted and is not created by BAI\'s migrations'
  if (d.key === 'schema|public' && String(d.target).replace(/postgres:USAGE ?/, '') === String(d.reference)) return 'Supabase grants postgres USAGE on schema public (the same platform difference scripts/db/parity.mjs explains)'
  if (/^view\|/.test(d.key)) {
    const norm = (t) => String(t).replace(/\s+AS\s+("?[?a-z_0-9]+"?)(?=[,\s]|$)/gi, '').replace(/\s+/g, ' ').trim()
    if (norm(d.reference) === norm(d.target)) return 'pg_dump writes explicit aliases (AS text) for unnamed view columns; the definition is otherwise identical'
  }
  return null
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-lexp-'))
const port = 20000 + Math.floor(Math.random() * 30000)
const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} })
let failed = false
const report = { restored_errors: {}, unexpected: [] }
try {
  await server.initialise(); await server.start()
  await server.createDatabase('bai_export_restore'); await server.createDatabase('bai_reference')
  const url = (d) => `postgresql://postgres:postgres@127.0.0.1:${port}/${d}`
  const admin = new pg.Client({ connectionString: url('bai_export_restore') }); await admin.connect()
  // 1. stand-ins: roles only (no passwords, no privileges of their own) and the two schemas the platform extensions live in
  for (const r of ['anon', 'authenticated', 'service_role', 'authenticator', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin', 'supabase_realtime_admin', 'dashboard_user']) await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`)
  await admin.query('create schema if not exists extensions')
  await admin.end()
  const psql = (file) => {
    const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=0', '-d', url('bai_export_restore'), '-f', path.join(exportDir, file)], { encoding: 'utf8', maxBuffer: 1 << 28 })
    const errs = (r.stderr ?? '').split('\n').filter((l) => /ERROR:/.test(l)).map((l) => l.replace(/^.*ERROR:\s*/, '').trim())
    return { file, status: r.status, errors: errs }
  }
  const results = ['roles.sql', 'schema.sql', 'data.sql'].map(psql)
  for (const r of results) {
    if (r.status !== 0 && r.status !== null) { failed = true; report.unexpected.push(`${r.file}: psql exited ${r.status}`) }
    for (const e of r.errors) {
      const known = PLATFORM_ONLY.find(([re]) => re.test(e))
      if (known) report.restored_errors[known[1]] = (report.restored_errors[known[1]] ?? 0) + 1
      else report.unexpected.push(`${r.file}: ${e.slice(0, 200)}`)
    }
  }
  // 3. rows
  const pre = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/db/hosted-preflight.mjs'), '--snapshot-dir', snapDir, '--expect-level', JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8')).migrations.v], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), BAI_DATABASE_URL: url('bai_export_restore') } })
  report.rows_equal_snapshot = pre.status === 0
  report.preflight = pre.stdout.split('\n').filter((l) => /^(ok  |FAIL)/.test(l) && !/snapshot file/.test(l)).join('\n')
  if (pre.status !== 0) failed = true
  // 4. schema: restored BAI catalog vs a reference built by the BAI runner from the migrations through the snapshot's level
  const ref = new pg.Client({ connectionString: url('bai_reference') }); await ref.connect()
  await applyMigrations(ref, { through: JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8')).migrations.v })
  const refSnap = await catalogSnapshot(ref); await ref.end()
  const rst = new pg.Client({ connectionString: url('bai_export_restore') }); await rst.connect()
  const restoredSnap = await catalogSnapshot(rst); await rst.end()
  const diffs = diffSnapshots(refSnap, restoredSnap)
  report.catalog_objects = refSnap.size
  report.catalog_explained_differences = diffs.filter((d) => explainCatalog(d)).map((d) => `${d.key}: ${explainCatalog(d)}`)
  const unexplained = diffs.filter((d) => !explainCatalog(d))
  report.catalog_unexplained_differences = unexplained.map((d) => `${d.key}: reference ${String(d.reference).slice(0, 90)} | restored ${String(d.target).slice(0, 90)}`)
  if (unexplained.length) failed = true
} catch (e) { failed = true; report.unexpected.push(`verification crashed: ${e.message}`) } finally { await server.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
if (report.unexpected.length) failed = true
console.log(JSON.stringify({ ok: !failed, ...report }, null, 1))
process.exit(failed ? 1 : 0)
