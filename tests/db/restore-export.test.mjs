// G5-5E: the authoritative staging restore (scripts/db/restore-export.mjs, scripts/db/lib/export-restore.mjs). A FICTIONAL source database stands in for hosted: migrations through 030, the promotion
// fixture baseline, sequences that run ahead of the data (ids used and deleted), a grant with microsecond precision, and the platform's SECURITY DEFINER event-trigger handler. It is
// exported with pg_dump (schema, data), snapshotted with the repository's snapshot library, and restored two ways: the snapshot restore (which loses sequence values) and the logical-export
// restore (which must lose nothing). Needs psql and pg_dump on the PATH (skipped, loudly, without them).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as h from './harness.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { takeSnapshot } from '../../scripts/db/lib/snapshot.mjs'
import { runSecurityAudit } from '../../scripts/db/lib/security-audit.mjs'
import { checkMigrations, collectBaseline, compareBaselines, compareSequences, emulatePlatformEventTriggers, eventTriggerFunctions, prepareStandIns, runExport, sequencesInDatabase, sequencesInExport } from '../../scripts/db/lib/export-restore.mjs'
import { buildBaseline } from './promotion-fixture.mjs'

const have = (c) => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0
const SKIP = have('psql') && have('pg_dump') ? false : 'SKIPPED: psql and pg_dump are required'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-g55e-'))
const B = path.join(dir, 'backup'); const EXP = path.join(B, 'export'); const SNAP = path.join(B, 'snapshot')
let admin, src, PORT, SRC
const url = (d) => `postgresql://postgres:postgres@127.0.0.1:${PORT}/${d}`
const rows = (c, sql, p) => h.rows(c, sql, p)
const newDb = async (name) => { await admin.query(`create database ${name}`); return h.connect(name) }
// the hosted function, verbatim in behaviour (G5-5D, read-only observation): enables RLS on tables created in schema public
const RLS_FN = `create function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path to 'pg_catalog' as $f$
  declare cmd record; tbl name; begin
    for cmd in select * from pg_event_trigger_ddl_commands() where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') and object_type in ('table','partitioned table') loop
      if cmd.schema_name = 'public' then select c.relname into tbl from pg_catalog.pg_class c where c.oid = cmd.objid; execute format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl); end if;
    end loop; end $f$`
const dump = (flags, out) => { const r = spawnSync('pg_dump', ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', SRC, '--no-owner', ...flags, '-f', out], { encoding: 'utf8', env: { PATH: process.env.PATH, PGPASSWORD: 'postgres' } }); assert.equal(r.status, 0, r.stderr) }

before(async () => {
  if (SKIP) return
  await h.startServer(); admin = await h.connect('postgres'); PORT = admin.port; SRC = 'g55e_src'
  src = await newDb(SRC)
  await applyMigrations(src, { through: '030' }); await buildBaseline(src, dir)
  await src.query(RLS_FN)
  // sequences ahead of the data: ids used and deleted, as on hosted (the highest id in the table is lower than the sequence)
  for (const t of ['players', 'sources', 'player_external_ids']) { await src.query(`select setval(pg_get_serial_sequence('public.${t}', 'id'), (select max(id) from public.${t}) + 37)`) }
  await src.query("select setval('ingest.import_batches_id_seq', (select max(id) from ingest.import_batches) + 5)")
  fs.mkdirSync(EXP, { recursive: true })
  await takeSnapshot(src, SNAP)
  fs.writeFileSync(path.join(EXP, 'roles.sql'), 'SET client_encoding = \'UTF8\';\n')
  dump(['--schema-only'], path.join(EXP, 'schema.sql')); dump(['--data-only'], path.join(EXP, 'data.sql'))
  // as the Supabase dump scripts write them: IF NOT EXISTS on schemas, and data loaded with triggers and foreign keys off (session_replication_role = replica)
  fs.writeFileSync(path.join(EXP, 'schema.sql'), fs.readFileSync(path.join(EXP, 'schema.sql'), 'utf8').replace(/^CREATE SCHEMA (?!IF)/gm, 'CREATE SCHEMA IF NOT EXISTS '))
  fs.writeFileSync(path.join(EXP, 'data.sql'), 'SET session_replication_role = replica;\n' + fs.readFileSync(path.join(EXP, 'data.sql'), 'utf8'))
  fs.writeFileSync(path.join(EXP, 'MANIFEST.txt'), `taken_at_utc: ${new Date(Date.now() + 1000).toISOString()}\n`)
  const mig = (await rows(src, 'select version from bai_meta.schema_migrations order by version')).map((r) => ({ version: r.version, name: r.version }))
  fs.writeFileSync(path.join(EXP, 'supabase_migrations_history.json'), JSON.stringify(mig))
}, { timeout: 120000 })
after(async () => { if (!SKIP) await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

let R, REC
const restore = async (name, { emulate = true } = {}) => {
  const db = await newDb(name); await prepareStandIns(db); const r = runExport(url(name), EXP); if (emulate) await emulatePlatformEventTriggers(db); return { db, ...r }
}

test('the snapshot restore loses the sequence values (the gap this tool closes); the logical-export restore loses nothing', { skip: SKIP }, async () => {
  const snapDb = await newDb('g55e_snap')
  const r = spawnSync(process.execPath, ['scripts/db/restore-snapshot.mjs', '--snapshot-dir', SNAP, '--database-url', url('g55e_snap')], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.homedir() } }); assert.equal(r.status, 0, r.stderr + r.stdout)
  const want = sequencesInExport(EXP); const got = await sequencesInDatabase(snapDb)
  const gap = compareSequences(want, got); assert.ok(gap.length >= 4 && gap.some((g) => g.startsWith('public.players_id_seq')), `the snapshot restore differs from the export in: ${gap.join('; ')}`)
  REC = await collectBaseline(src)
  R = await restore('g55e_exp')
  assert.deepEqual(R.unexpected, [], R.unexpected.join('\n')); assert.deepEqual(compareSequences(want, await sequencesInDatabase(R.db)), [], 'every sequence equals the export')
  assert.deepEqual(compareBaselines(REC, await collectBaseline(R.db)), [], 'every table fingerprint, every sequence and the grant rows equal the source')
})

test('the migration ledger keeps its checksums and applied_at; a re-applied ledger is detected', { skip: SKIP }, async () => {
  const m = await checkMigrations(R.db, EXP, '030'); assert.deepEqual(m.problems, []); assert.equal(m.versions, 30)
  const a = (await rows(R.db, 'select md5(string_agg(applied_at::text, \',\' order by version)) m from bai_meta.schema_migrations'))[0].m; assert.equal(a, (await rows(src, 'select md5(string_agg(applied_at::text, \',\' order by version)) m from bai_meta.schema_migrations'))[0].m, 'applied_at equal to the microsecond')
  const old = fs.readFileSync(path.join(EXP, 'MANIFEST.txt'), 'utf8'); fs.writeFileSync(path.join(EXP, 'MANIFEST.txt'), 'taken_at_utc: 2000-01-01T00:00:00Z\n')
  try { assert.match((await checkMigrations(R.db, EXP, '030')).problems.join(), /re-applied/) } finally { fs.writeFileSync(path.join(EXP, 'MANIFEST.txt'), old) }
})

test('the grant keeps its microseconds; a millisecond-truncated copy (the G5-5A reconstruction defect) is detected', { skip: SKIP }, async () => {
  const g = (await rows(R.db, 'select to_char(granted_at at time zone \'UTC\', \'YYYY-MM-DD HH24:MI:SS.US\') t from ingest.source_publication_grants'))[0].t
  assert.equal(g, (await rows(src, 'select to_char(granted_at at time zone \'UTC\', \'YYYY-MM-DD HH24:MI:SS.US\') t from ingest.source_publication_grants'))[0].t); assert.ok(!/\.\d\d\d000$/.test(g), 'the fixture grant really has sub-millisecond digits')
  const trunc = JSON.parse(JSON.stringify(REC)); trunc.grants[0].granted_at = String(trunc.grants[0].granted_at).replace(/(\.\d{3})\d+/, '$1')
  assert.notEqual(trunc.grants[0].granted_at, REC.grants[0].granted_at, 'the copy really lost digits')
  assert.ok(compareBaselines(trunc, await collectBaseline(R.db)).some((p) => /grants differ/.test(p)))
  const edited = JSON.parse(JSON.stringify(REC)); const k = Object.keys(edited.fingerprints)[0]; edited.fingerprints[k].md5 = '0'.repeat(32)
  assert.ok(compareBaselines(edited, await collectBaseline(R.db)).some((p) => p.includes(k)), 'a changed row fingerprint is named by table')
})

test('sequence tampering is detected, per sequence', { skip: SKIP }, async () => {
  const want = sequencesInExport(EXP); want['public.players_id_seq'] = { ...want['public.players_id_seq'], value: '1' }
  assert.deepEqual(compareSequences(want, await sequencesInDatabase(R.db)).map((p) => p.split(':')[0]), ['public.players_id_seq'])
})

test('security audit strategy: the platform handler is skipped only because its event trigger exists; without it the audit fails; any other SECURITY DEFINER function still fails', { skip: SKIP }, async () => {
  assert.deepEqual(await eventTriggerFunctions(R.db), ['public.rls_auto_enable()'], 'the only event-trigger handler is the allowed platform one')
  for (const o of [{ readOnly: false, localDb: true }, { readOnly: true, localDb: true }]) { const a = await runSecurityAudit(R.db, o); assert.deepEqual(a.failures, [], JSON.stringify(a.failures)); assert.ok(a.notes.some((n) => /platform function public\.rls_auto_enable/.test(n))) }
  // a rogue SECURITY DEFINER function in public is NOT hidden by the allowance
  await R.db.query('create function public.g55e_rogue() returns int language sql security definer set search_path = pg_catalog as $$ select 1 $$')
  try { const a = await runSecurityAudit(R.db, { readOnly: false, localDb: true }); assert.ok(a.failures.some((f) => /g55e_rogue/.test(f)), JSON.stringify(a.failures)) } finally { await R.db.query('drop function public.g55e_rogue()') }
  // the same restore WITHOUT the event trigger: the audit reports the function (nothing is suppressed globally)
  const bare = await restore('g55e_bare', { emulate: false })
  const a = await runSecurityAudit(bare.db, { readOnly: false, localDb: true }); assert.ok(a.failures.some((f) => /rls_auto_enable/.test(f)), 'without the event trigger the audit reports it')
  // an extra event trigger on a BAI-schema handler would be skipped by the audit: the restore tool refuses it
  await R.db.query('create function public.g55e_evt() returns event_trigger language plpgsql security definer set search_path = pg_catalog as $$ begin null; end $$; create event trigger g55e_evt on ddl_command_end execute function public.g55e_evt()')
  try { assert.deepEqual((await eventTriggerFunctions(R.db)).sort(), ['public.g55e_evt()', 'public.rls_auto_enable()']) } finally { await R.db.query('drop event trigger g55e_evt; drop function public.g55e_evt()') }
})

test('after migration 032 on the restore: ten more internal_objects, no other baseline table changes, the audits pass; the platform trigger does not touch 032 (it creates no public table)', { skip: SKIP }, async () => {
  const before = await collectBaseline(R.db); await applyMigrations(R.db)
  const after = await collectBaseline(R.db)
  const changed = Object.keys(after.fingerprints).filter((t) => JSON.stringify(before.fingerprints[t]) !== JSON.stringify(after.fingerprints[t]))
  assert.deepEqual(changed, ['public.internal_objects']); assert.equal(after.fingerprints['public.internal_objects'].n - before.fingerprints['public.internal_objects'].n, 10)
  for (const o of [{ readOnly: false, localDb: true }, { readOnly: true, localDb: true }]) assert.deepEqual((await runSecurityAudit(R.db, o)).failures, [])
  assert.equal((await rows(R.db, "select count(*)::int n from pg_roles where rolname = 'bai_site' and not rolcanlogin and not rolsuper and not rolbypassrls"))[0].n, 1)
  assert.equal((await rows(R.db, "select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ingest' and c.relname like 'promotion\\_%' and c.relkind = 'r' and not c.relrowsecurity"))[0].n, 4, 'the four promotion tables are in ingest, outside ensure_rls')
})

test('the command line is local-only and refuses a non-empty database', { skip: SKIP }, async () => {
  const run = (u) => spawnSync(process.execPath, ['scripts/db/restore-export.mjs', '--export-dir', EXP, '--snapshot-dir', SNAP, '--database-url', u], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.homedir() } })
  assert.equal(run('postgresql://postgres:x@db.abcdefghijklmnopqrst.supabase.co:5432/postgres').status, 2)   // credential-scan:allow (a placeholder host and password)
  const r = run(url('g55e_exp')); assert.equal(r.status, 1); assert.match(r.stdout, /already holds BAI schemas/)
})
