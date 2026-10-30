// The Data API pre-request guard (migration 032): Prefer: count=planned and count=estimated return the planner's row estimate, which is made from the whole table and so tracks
// the HELD rows that row-level security hides. The guard refuses them for every Data API role but service_role, and nothing else. The SQL tests run everywhere; the HTTP tests
// run a real PostgREST (a pinned local binary: BAI_POSTGREST_BIN, default ~/tmp-bai/g5-2-bin/postgrest) against the test cluster and are skipped, loudly, when it is absent.
// FICTIONAL data throughout (slugs gt-*).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'
import * as h from './harness.mjs'
import { runSecurityAudit } from '../../scripts/db/lib/security-audit.mjs'

const BIN = process.env.BAI_POSTGREST_BIN ?? `${os.homedir()}/tmp-bai/g5-2-bin/postgrest`
const HAVE_BIN = fs.existsSync(BIN)
const SKIP = HAVE_BIN ? false : `SKIPPED: no PostgREST binary at ${BIN} (set BAI_POSTGREST_BIN); the SQL tests above still ran`
let db, rest = null, port = 0
const SECRET = crypto.randomBytes(32).toString('hex')
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (role) => { const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role })}`; return `${head}.${crypto.createHmac('sha256', SECRET).update(head).digest('base64url')}` }

before(async () => {
  await h.startServer(); const admin = await h.connect('postgres')
  await admin.query("create role authenticator login noinherit password 'local'") // before the migration, so that 032 configures it exactly as it would on a Supabase database
  db = await h.freshDatabase()
  await db.query('grant anon, authenticated to authenticator')
}, { timeout: 120000 })
after(async () => { rest?.kill(); await h.stopServer() })

const guard = async (role, headers) => h.asRole(db, role, async () => {
  if (headers !== undefined) await db.query("select set_config('request.headers', $1, true)", [typeof headers === 'string' ? headers : JSON.stringify(headers)])
  return db.query('select bai_guard.reject_planner_counts()').then(() => 'ok', (e) => e.message)
})
const refusedMsg = /BAI0[12]/

test('the guard refuses planned and estimated counts in any spelling, any order, any number of Prefer headers; exact, none and ordinary requests pass', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const v of ['count=planned', 'count=estimated', 'COUNT=PLANNED', 'Count=Estimated', 'count = planned', 'count="planned"', 'count=estimated;x=1', 'return=representation, count=planned', 'count=planned, return=minimal', 'count=exact, count=planned',
      'handling=strict, count=exact, resolution=merge-duplicates, count=estimated', 'params=single-object,count=planned,tx=rollback']) {
      assert.match(await guard(role, { prefer: v, accept: 'application/json' }), refusedMsg, `${role}: ${v}`)
    }
    // a repeated header arrives as repeated keys of the JSON object; every one is read
    assert.match(await guard(role, '{"prefer":"count=exact","accept":"*/*","prefer":"count=planned"}'), refusedMsg, 'a later duplicate')
    assert.match(await guard(role, '{"prefer":"count=planned","accept":"*/*","prefer":"count=exact"}'), refusedMsg, 'an earlier duplicate')
    assert.match(await guard(role, { Prefer: 'count=planned' }), refusedMsg, 'header name in another case')
    assert.match(await guard(role, { accept: 'application/vnd.pgrst.plan+json' }), refusedMsg, 'the plan media type')
    assert.match(await guard(role, { accept: 'application/json, application/vnd.pgrst.plan; for="application/json"' }), refusedMsg, 'the plan media type among others')
    for (const v of ['count=exact', 'count=none', 'return=representation', 'return=minimal, count=exact', 'handling=lenient', 'count=exact, tx=commit', '']) assert.equal(await guard(role, { prefer: v, accept: 'application/json' }), 'ok', `${role}: ${v}`)
    assert.equal(await guard(role, { accept: 'application/json' }), 'ok', 'no Prefer header')
    assert.equal(await guard(role, {}), 'ok', 'no headers at all')
  }
  assert.equal(await guard('anon'), 'ok', 'a direct SQL session has no request headers: nothing to inspect')
})

test('the guard fails closed: an unreadable header set raises instead of passing, and it has no exception handler', async () => {
  assert.notEqual(await guard('anon', '{not json'), 'ok')
  assert.notEqual(await guard('authenticated', '[1,2'), 'ok')
  assert.doesNotMatch((await h.one(db, "select pg_get_functiondef('bai_guard.reject_planner_counts()'::regprocedure) d")).d, /exception\s+when/i)
})

test('service_role is not restricted (it bypasses row-level security and sees every row anyway)', async () => {
  if (!(await h.one(db, "select exists (select 1 from pg_roles where rolname = 'service_role') ok")).ok) return
  assert.equal(await guard('service_role', { prefer: 'count=planned' }), 'ok')
})

test('privileges: the public roles may use the one function and nothing else in the schema; PUBLIC may not; the Data API does not expose it; the authenticator runs it', async () => {
  const f = await h.rows(db, "select p.oid::regprocedure::text sig, p.prosecdef sd from pg_proc p where pronamespace = 'bai_guard'::regnamespace")
  assert.deepEqual(f.map((x) => x.sig), ['bai_guard.reject_planner_counts()']); assert.equal(f[0].sd, false)
  assert.equal((await h.one(db, "select count(*)::int n from pg_class where relnamespace = 'bai_guard'::regnamespace")).n, 0, 'no tables or views')
  const x = await h.one(db, `select has_function_privilege('anon', 'bai_guard.reject_planner_counts()', 'EXECUTE') a, has_function_privilege('authenticated', 'bai_guard.reject_planner_counts()', 'EXECUTE') u,
    exists (select 1 from aclexplode((select proacl from pg_proc where oid = 'bai_guard.reject_planner_counts()'::regprocedure)) a where a.grantee = 0) pub,
    has_schema_privilege('anon', 'bai_guard', 'CREATE') c1, has_schema_privilege('authenticated', 'bai_guard', 'CREATE') c2`)
  assert.deepEqual([x.a, x.u, x.pub, x.c1, x.c2], [true, true, false, false, false])
  assert.deepEqual((await h.one(db, "select rolconfig from pg_roles where rolname = 'authenticator'")).rolconfig.filter((c) => c.startsWith('pgrst.')), ['pgrst.db_pre_request=bai_guard.reject_planner_counts'])
  assert.deepEqual(await h.rows(db, "select proname from pg_proc where pronamespace = 'public'::regnamespace and proname like '%planner%'"), [], 'not an RPC endpoint')
  const r = await runSecurityAudit(db, { readOnly: false, localDb: true })
  assert.deepEqual(r.failures.filter((m) => /bai_guard|pre_request|count guard/.test(m)), [])
  assert.ok(r.notes.some((n) => /pre-request guard bai_guard.reject_planner_counts is configured/.test(n)), 'the audit confirms the setting')
})

test('the audit fails when the setting is missing, another pre-request is set, or the schema is wrongly granted', async () => {
  const audit = async () => (await runSecurityAudit(db, { readOnly: false, localDb: true })).failures.filter((m) => /bai_guard|pre_request|count guard/.test(m))
  try {
    await db.query('alter role authenticator reset pgrst.db_pre_request'); assert.match((await audit()).join(), /does not run the count guard/)
    await db.query("alter role authenticator set pgrst.db_pre_request = 'public.other'"); assert.match((await audit()).join(), /does not run the count guard/)
    await db.query('alter role authenticator reset pgrst.db_pre_request'); await db.query("alter role authenticator set pgrst.db_pre_request = 'bai_guard.reject_planner_counts'")
    await db.query('revoke usage on schema bai_guard from anon'); assert.match((await audit()).join(), /anon lacks USAGE on bai_guard/); await db.query('grant usage on schema bai_guard to anon')
    await db.query('grant execute on function bai_guard.reject_planner_counts() to public'); assert.match((await audit()).join(), /executable by PUBLIC/); await db.query('revoke execute on function bai_guard.reject_planner_counts() from public')
    await db.query('grant execute on function bai_guard.reject_planner_counts() to anon, authenticated')
    assert.deepEqual(await audit(), [])
  } finally { await db.query("alter role authenticator set pgrst.db_pre_request = 'bai_guard.reject_planner_counts'") }
})

test('the migration refuses to replace a different pre-request already configured on the authenticator', async () => {
  const d2 = await h.freshDatabase({ migrate: false })
  const { applyMigrations, listMigrations } = await import('../../scripts/db/lib/migrations.mjs')
  const all = listMigrations(); const last = all.at(-1)
  try {
    await db.query('alter role authenticator reset pgrst.db_pre_request'); await db.query("alter role authenticator set pgrst.db_pre_request = 'public.someone_elses'")
    await assert.rejects(applyMigrations(d2), /authenticator already has another pgrst.db_pre_request/)
    assert.equal(last.file.startsWith('032'), true)
  } finally { await db.query('alter role authenticator reset pgrst.db_pre_request'); await db.query("alter role authenticator set pgrst.db_pre_request = 'bai_guard.reject_planner_counts'") }
})

// ---- real PostgREST -----------------------------------------------------------------------------------------------------------------------------------------------------------

const startRest = async () => {
  rest?.kill(); await new Promise((r) => setTimeout(r, 500)); port = 30000 + Math.floor(Math.random() * 20000)
  rest = spawn(BIN, [], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', PGRST_DB_URI: `postgresql://authenticator:local@127.0.0.1:${db.port}/${db.database}`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_SERVER_PORT: String(port), PGRST_SERVER_HOST: '127.0.0.1', PGRST_JWT_SECRET: SECRET, PGRST_DB_AGGREGATES_ENABLED: 'true' } })
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).status < 500) return } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)) }
  throw new Error('PostgREST did not start')
}
// raw request, so that a header can be sent more than once and in any order
const call = (path, { method = 'GET', headers = {}, token = null } = {}) => new Promise((resolve, reject) => {
  const hs = { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  const req = http.request({ host: '127.0.0.1', port, path, method, headers: hs }, (res) => { let b = ''; res.on('data', (d) => { b += d }); res.on('end', () => resolve({ status: res.statusCode, range: res.headers['content-range'] ?? null, body: b })) })
  req.on('error', reject); req.end()
})

test('fixture: 300 public players, then 500 HELD players of an unreleased Retrosheet source, statistics refreshed as autovacuum would', { skip: SKIP }, async () => {
  await db.query("insert into sources (source_key, source_type, authority_level, title, publisher, url, retrieved_date) values ('gt:base', 'REFERENCE_DATABASE', 'OTHER', 'Fixture base', 'Fixture', 'https://example.org/base', '2026-10-22')")
  await db.query("insert into sources (source_key, source_type, authority_level, title, publisher, url, retrieved_date) values ('hist:retrosheet-gt0000001', 'REFERENCE_DATABASE', 'REPUTABLE_SECONDARY', 'Retrosheet transactions database (tranDB.zip)', 'Retrosheet', 'https://www.retrosheet.org/transactions/tranDB.zip', '2026-10-22')")
  for (const [prefix, key, n] of [['gt-base', 'gt:base', 300], ['gt-held', 'hist:retrosheet-gt0000001', 500]]) {
    await db.query("insert into players (slug, full_name, display_name) select $1 || '-' || g, 'Fixture ' || g, 'Fixture ' || g from generate_series(1, $2::int) g", [prefix, n])
    await db.query("insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value, locator) select (select id from sources where source_key = $2), 'players', p.id, 'full_name', to_jsonb(p.full_name), 'fixture' from players p where p.slug like $1 || '-%'", [prefix, key])
  }
  await db.query('analyze')
  assert.equal((await h.one(db, "select count(*)::int n from players where slug like 'gt-held-%'")).n, 500)
  await startRest()
})

test('WITHOUT the guard the planner-based counts expose the held rows (why the guard exists)', { skip: SKIP }, async () => {
  await db.query('alter role authenticator reset pgrst.db_pre_request'); await startRest()
  try {
    const exact = await call('/players?select=id&limit=1', { headers: { Prefer: 'count=exact' } })
    const planned = await call('/players?select=id&limit=1', { headers: { Prefer: 'count=planned' } })
    assert.equal(exact.status, 206); assert.match(exact.range, /\/300$/, 'RLS shows the 300 public players')
    assert.equal(planned.status, 206); assert.doesNotMatch(planned.range, /\/300$/, `the planner counted the held rows too: ${planned.range}`)
    assert.equal(Number(planned.range.split('/')[1]), 400, 'half of the 800 players in the table: the estimate is made from rows nobody may see')
  } finally { await db.query("alter role authenticator set pgrst.db_pre_request = 'bai_guard.reject_planner_counts'"); await startRest() }
})

test('WITH the guard, over real HTTP: planned and estimated counts are refused for anon and authenticated, in every single-line form of the header', { skip: SKIP }, async () => {
  for (const token of [null, jwt('authenticated')]) {
    for (const t of ['players', 'player_external_ids', 'sources', 'source_observations']) {
      for (const prefer of ['count=planned', 'count=estimated', 'COUNT=Planned', 'return=representation, count=estimated', 'count=planned, count=exact', 'count=exact,count=planned']) {
        const r = await call(`/${t}?select=id&limit=1`, { headers: { Prefer: prefer }, token })
        assert.equal(r.status, 400, `${t} ${token ? 'authenticated' : 'anon'} ${JSON.stringify(prefer)} -> ${r.status} ${r.body}`)
        assert.equal(JSON.parse(r.body).code, 'BAI01'); assert.equal(r.range, null)
        assert.doesNotMatch(r.body, /\d{3,}/, 'the refusal carries no number')
      }
    }
    const head = await call('/players?select=id', { method: 'HEAD', headers: { Prefer: 'count=planned' }, token }); assert.equal(head.status, 400)
    const plan = await call('/players?select=id', { headers: { Accept: 'application/vnd.pgrst.plan+json' }, token }); assert.ok([400, 406].includes(plan.status), `plan media type -> ${plan.status}`)
  }
})

test('WITH the guard, over real HTTP: count=exact, HEAD, filters, joins, aggregates and ordinary reads all still work and show only public rows', { skip: SKIP }, async () => {
  for (const token of [null, jwt('authenticated')]) {
    for (const [t, n] of [['players', 300], ['source_observations', Number((await h.one(db, "select count(*)::int n from source_observations where source_id <> all (select id from sources where publisher = 'Retrosheet')")).n)]]) {
      const ex = await call(`/${t}?select=id&limit=1`, { headers: { Prefer: 'count=exact' }, token }); assert.equal(ex.status, 206); assert.match(ex.range, new RegExp(`/${n}$`), `${t}: ${ex.range}`)
      const hd = await call(`/${t}?select=id`, { method: 'HEAD', headers: { Prefer: 'count=exact' }, token }); assert.ok([200, 206].includes(hd.status)); assert.match(hd.range, new RegExp(`/${n}$`))
      const none = await call(`/${t}?select=id&limit=1`, { headers: { Prefer: 'count=none' }, token }); assert.equal(none.status, 200)
      assert.equal((await call(`/${t}?select=id&limit=1`, { token })).status, 200, 'plain read')
    }
    assert.equal(JSON.parse((await call('/players?select=count()', { token })).body)[0].count, 300, 'aggregate')
    assert.deepEqual(JSON.parse((await call('/players?slug=like.gt-held-*&select=id', { token })).body), [], 'filter on held rows')
    assert.equal(JSON.parse((await call('/players?slug=like.gt-base-*&select=id', { token })).body).length, 300)
    assert.equal((await call('/players?select=id&limit=1', { headers: { Prefer: 'return=representation, count=exact' }, token })).status, 206, 'mixed Prefer with exact')
    const emb = await call('/players?select=id,player_external_ids(id)&limit=1', { token }); assert.equal(emb.status, 200)
  }
})

test('WITH the guard, the planner estimate no longer changes what a caller can learn: nothing but the exact count is answered', { skip: SKIP }, async () => {
  const seen = new Set()
  for (const mode of ['planned', 'estimated']) { const r = await call('/players?select=id&limit=1', { headers: { Prefer: `count=${mode}` } }); seen.add(r.status + ':' + r.range) }
  assert.deepEqual([...seen], ['400:null'])
})

test('KNOWN LIMIT: a request that sends Prefer on two separate header lines is not covered', { skip: SKIP }, async () => {
  // PostgREST 12.2.3 applies the FIRST Prefer line but exposes only the LAST one in request.headers, so a guard that reads request.headers cannot see a first line that says
  // count=planned. A single line (what every client library and curl send, and what a proxy that folds repeated headers produces) is refused above. This test pins the
  // behaviour so that a PostgREST that fixes it, or a change here, is noticed. It does not make the gap acceptable: see the report.
  const first = await call('/players?select=id&limit=1', { headers: { Prefer: ['count=planned', 'count=exact'] } })
  const last = await call('/players?select=id&limit=1', { headers: { Prefer: ['count=exact', 'count=planned'] } })
  assert.equal(last.status, 400, 'planned on the last line is refused')
  assert.equal(first.status, 206, 'planned on the first line, exact last: the guard sees only exact')
  assert.match(first.range, /\/400$/, 'and PostgREST used the planner count (400 = half of 800), not the 300 public players')
})
