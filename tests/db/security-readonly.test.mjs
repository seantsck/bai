// The hosted security audit is READ-ONLY (scripts/db/lib/security-audit.mjs, mode READ-ONLY) and the full behavioural audit is for disposable local databases.
// What these tests demonstrate: the read-only mode issues no INSERT/UPDATE/DELETE/TRUNCATE/DDL (statement log, a client-side guard, and PostgreSQL's own tuple
// counters), sends no HTTP POST/PATCH/DELETE, calls no side-effect function, and never falls back to the full mode; the full mode refuses a non-local target.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as h from './harness.mjs'
import { runSecurityAudit, readOnlyGuard, READ_ONLY_PROBES } from '../../scripts/db/lib/security-audit.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let db
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer() })

const WRITE = /^\s*(insert|update|delete|truncate|create|alter|drop|grant|revoke|call|do|copy|vacuum|lock|refresh|execute|notify|listen|comment|merge|reindex|cluster|prepare|set\s+(?!local\s+role\s+(anon|authenticated)\b))/i
const recorder = (client, log) => ({ query: async (sql, p) => { log.push(typeof sql === 'string' ? sql : sql.text); return client.query(sql, p) } })
/** a fetch stand-in: the Management API answers with the exposed schemas; the Data API refuses everything except the public read surface */
const stubFetch = (calls) => async (url, init = {}) => {
  const method = (init.method ?? 'GET').toUpperCase(); calls.push({ method, url: String(url) })
  if (String(url).includes('/postgrest')) return { ok: true, status: 200, json: async () => ({ db_schema: 'public' }), text: async () => '{}' }
  const ok = /organizations\?select=franchise_key/.test(String(url))
  return { ok, status: ok ? 200 : 401, json: async () => ({}), text: async () => (ok ? '[]' : '{"message":"denied"}') }
}
const tuples = async () => { await db.query('select pg_stat_force_next_flush()'); return (await h.one(db, "select tup_inserted::int i, tup_updated::int u, tup_deleted::int d from pg_stat_database where datname = current_database()")) }
const ENV = { BAI_SUPABASE_PROJECT_REF: 'testprojectrefxxxxxxx', SUPABASE_ACCESS_TOKEN: 'sbp_test_token_not_real', BAI_SUPABASE_URL: 'https://testprojectrefxxxxxxx.supabase.co', BAI_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_not_real' }

test('read-only mode: every statement is a plain read inside one read-only transaction, and PostgreSQL itself counts no insert, update or delete', async () => {
  // calibration: the counter does see a write that is rolled back, so "unchanged" below means something
  const c0 = await tuples()
  await db.query('begin'); await db.query("insert into players (slug, full_name, display_name) values ('calibration', 'Calibration', 'Calibration')"); await db.query('rollback')
  assert.equal((await tuples()).i - c0.i, 1, 'the tuple counter detects an insert even when it is rolled back')
  const log = []; const calls = []
  const before = await tuples()
  const r = await runSecurityAudit(recorder(db, log), { readOnly: true, localDb: false, env: ENV, fetchImpl: stubFetch(calls) })
  const after = await tuples()
  assert.equal(r.ok, true, r.failures.join('; ')); assert.equal(r.mode, 'READ-ONLY')
  assert.equal(log[0], 'begin read only', 'the first statement opens a read-only transaction'); assert.equal(log.at(-1), 'rollback')
  assert.ok(log.length > 100, `${log.length} statements`)
  assert.deepEqual(log.filter((s) => WRITE.test(s)), [], 'no write, DDL, lock, copy or other mutating statement was sent')
  assert.ok(log.every((s) => /^\s*(select|show|with|savepoint probe|rollback( to savepoint probe)?|begin read only|set local role (anon|authenticated))\b/i.test(s)), 'every statement is on the allow-list')
  assert.deepEqual([after.i - before.i, after.u - before.u, after.d - before.d], [0, 0, 0], 'the server counted no inserted, updated or deleted tuple (even rolled back)')
  assert.equal((await h.one(db, 'show transaction_read_only')).transaction_read_only, 'off', 'the session itself is not left read-only')
  // behaviour: the SELECT probes ran for both roles, the rest did not
  assert.equal(r.behaviour.length, READ_ONLY_PROBES.size * 2 + 2)
  assert.ok(r.behaviour.every((b) => !/insert|update|delete|create table|invoke/.test(b.attempt)))
  assert.match(r.notes.join('\n'), /read-only mode: 14 of \d+ probes are plain SELECTs/)
})

test('read-only mode sends no HTTP POST, PATCH or DELETE (and does send GETs, so the check is not vacuous)', async () => {
  const calls = []
  const r = await runSecurityAudit(db, { readOnly: true, localDb: false, env: ENV, fetchImpl: stubFetch(calls) })
  assert.equal(r.ok, true, r.failures.join('; '))
  assert.ok(calls.length >= 8, `${calls.length} requests`)
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ['GET'])
  assert.deepEqual([...new Set(r.http_requests.map((c) => c.method))], ['GET'])
  const unsent = r.data_api.filter((p) => p.result === 'not sent (read-only mode)').map((p) => p.probe)
  assert.deepEqual(unsent.sort(), ['call refresh_read_models', 'delete organizations', 'insert a source', 'insert ingest.staged_records via profile'])
})

test('the read-only guard refuses anything that is not a plain read; the full mode cannot be reached from it', async () => {
  const g = readOnlyGuard({ query: async () => ({ rows: [] }) })
  for (const bad of ['insert into public.sources (source_key) values (1)', 'update public.organizations set slug = slug', 'delete from public.sources', 'truncate public.sources', 'create table x (a int)', 'drop table x',
    'select 1; delete from public.sources', 'select 1;\ninsert into x values (1)', 'call p()', 'do $$ begin end $$', 'copy public.sources to stdout', 'set role postgres', 'set local role postgres', 'vacuum', 'lock table x', 'begin', 'commit']) {
    await assert.rejects(g.query(bad), /read-only audit refused/, bad)
  }
  for (const good of ['select 1', ' select count(*) from public.organizations', 'show transaction_read_only', 'with x as (select 1) select * from x', 'begin read only', 'savepoint probe', 'rollback to savepoint probe', 'rollback', 'set local role anon', 'select 1;']) await g.query(good)
  // the mutating probes are not in the read-only set
  for (const label of ['insert staged record', 'update staged records', 'delete staged records', 'insert import batch', 'invoke refresh_read_models', 'invoke apply_public_boundary', 'create a table in public', 'write a public table', 'insert a source', 'invoke ingest.resolve_identity']) assert.ok(!READ_ONLY_PROBES.has(label), label)
  // an HTTP write cannot be sent in read-only mode even if a probe asked for one
  const calls = []
  const r = await runSecurityAudit(db, { readOnly: true, env: ENV, fetchImpl: stubFetch(calls) })
  assert.ok(r.http_requests.every((x) => x.method === 'GET'))
})

test('the full mode is for a disposable local database: it refuses a non-local target, and it does send its (denied, rolled-back) write probes', async () => {
  await assert.rejects(runSecurityAudit(db, { readOnly: false, localDb: false }), /disposable local databases only/)
  const log = []; const calls = []
  const r = await runSecurityAudit(recorder(db, log), { readOnly: false, localDb: true, env: { ...ENV, BAI_SUPABASE_URL: 'http://127.0.0.1:54321' }, fetchImpl: stubFetch(calls) })
  assert.equal(r.ok, true, r.failures.join('; ')); assert.equal(r.mode, 'FULL')
  assert.ok(log.some((s) => WRITE.test(s)), 'the full mode sends write probes (all denied and rolled back)')
  assert.equal(r.behaviour.length, 62)
  assert.ok(calls.some((c) => c.method === 'POST') && calls.some((c) => c.method === 'DELETE'), 'a LOCAL Data API gets the write probes')
  // a hosted Data API never gets a write probe from this script, even in full mode against a local database
  const hostedCalls = []
  await runSecurityAudit(db, { readOnly: false, localDb: true, env: ENV, fetchImpl: stubFetch(hostedCalls) })
  assert.deepEqual([...new Set(hostedCalls.map((c) => c.method))], ['GET'])
})

test('the command: a non-local database without --read-only is refused before any connection; --read-only and the local default both run and say which mode they used', () => {
  const { port, database } = db.connectionParameters
  const local = `postgresql://postgres:postgres@127.0.0.1:${port}/${database}`
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp' }
  const t0 = Date.now()
  const hostedUrl = 'postgresql://postgres:not-a-password@db.dbnmktidheefoxaztivm.supabase.co:5432/postgres' // credential-scan:allow (a deliberately fake password: the command must refuse before it connects)
  const refused = spawnSync(process.execPath, ['scripts/db/security.mjs'], { cwd: root, encoding: 'utf8', env: { ...base, BAI_DATABASE_URL: hostedUrl, BAI_ALLOW_REMOTE_DB: '1', BAI_SUPABASE_PROJECT_REF: 'dbnmktidheefoxaztivm' } })
  assert.equal(refused.status, 2); assert.match(refused.stderr, /refusing: this is not a local database/); assert.match(refused.stderr, /--read-only/)
  assert.ok(Date.now() - t0 < 5000, 'refused without trying to reach the host')
  assert.doesNotMatch(refused.stderr + refused.stdout, /ENOTFOUND|ECONNREFUSED|password authentication/, 'it never attempted a connection')
  const ro = spawnSync(process.execPath, ['scripts/db/security.mjs', '--read-only'], { cwd: root, encoding: 'utf8', env: { ...base, BAI_DATABASE_URL: local } })
  assert.equal(ro.status, 0, ro.stdout + ro.stderr); assert.match(ro.stdout, /mode: READ-ONLY/); assert.match(ro.stdout, /SECURITY OK \(read-only audit\)/)
  const full = spawnSync(process.execPath, ['scripts/db/security.mjs'], { cwd: root, encoding: 'utf8', env: { ...base, BAI_DATABASE_URL: local } })
  assert.equal(full.status, 0, full.stdout + full.stderr); assert.match(full.stdout, /mode: FULL behavioural audit/)
  const pkg = JSON.parse(spawnSyncRead('package.json'))
  assert.match(pkg.scripts['hosted:security'], /--read-only/, 'the hosted script is the read-only audit')
  assert.doesNotMatch(pkg.scripts['db:security'], /--read-only/)
})
import fs from 'node:fs'
function spawnSyncRead (f) { return fs.readFileSync(path.join(root, f), 'utf8') }
