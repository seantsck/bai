// NOTE (G6B): runs on the 032 stage (migrations through 032): the mechanism of the planner-based counts for tables the Data API can read; 033 closes the identity tables (tests/db/rest-boundary.test.mjs).
// G5-5C Part A: the Data API's planner-based counts (Prefer: count=planned | estimated) around a withdrawal, against a REAL PostgREST (a pinned local binary: BAI_POSTGREST_BIN,
// default ~/tmp-bai/g5-2-bin/postgrest; skipped, loudly, without it). A DELETE does not change the planner's row estimate until ANALYZE, so a client could read how many rows a withdrawal
// had removed. migration 032 analyzes inside the withdrawal transaction; these tests observe what independent REST clients actually see before, during and after the commit, with both orders of
// a duplicated Prefer header, and after a withdrawal that fails. FICTIONAL data, at a scale (a few thousand promoted players) where the estimate is not trivially exact.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as h from './harness.mjs'
import { BIN, SKIP } from '../support/postgrest.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { SESSION_SQL, analyzeStatistics, buildPackage, promote, sha256, withdraw } from '../../scripts/db/lib/promotion.mjs'
import { buildBaseline, importSample } from './promotion-fixture.mjs'

const BULK = Number(process.env.BAI_COUNTS_BULK ?? 2500)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-g55c-'))
const MAIN = 'g55c_counts'
const TABLES = ['players', 'player_external_ids', 'source_observations', 'coverage_assessments', 'sources']
const MODES = ['exact', 'planned', 'estimated']
let admin, main, rest = null, port = 0, batches
const SECRET = crypto.randomBytes(32).toString('hex'); const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const JWT = (() => { const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'authenticated' })}`; return `${head}.${crypto.createHmac('sha256', SECRET).update(head).digest('base64url')}` })()
const open = async (name) => { const c = await h.connect(name); c.on('error', () => {}); await c.query(SESSION_SQL); return c }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = (c, sql, p) => h.rows(c, sql, p)
const config = () => ({ category: 'RETROSHEET', authorization: { effective_from: '2026-10-30', expires_on: '2027-01-22' },
  attribution: { evidence_sha256: sha256('fixture evidence'), verified_at: new Date().toISOString(), max_age_hours: 72 }, archive: { name: 'fixture', sha256: sha256('a') }, expectBatches: batches })

// a request with ANY list of Prefer header lines (fetch cannot repeat a header)
const get = (p, auth, prefers) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/' + p, agent: false, headers: { ...(auth ? { Authorization: `Bearer ${JWT}` } : {}), Prefer: prefers } }, (res) => {
    let body = ''; res.on('data', (d) => { body += d }); res.on('end', () => resolve({ status: res.statusCode, total: res.headers['content-range']?.split('/')[1] ?? null, body })) })
  req.on('error', (e) => resolve({ status: 0, total: null, body: String(e) })); req.end()
})
const count = async (t, mode, auth = false) => { const r = await get(`${t}?select=id&limit=1`, auth, `count=${mode}`); assert.ok([200, 206].includes(r.status), `${t} ${mode} -> ${r.status} ${r.body.slice(0, 100)}`); return Number(r.total) }
const snapshot = async (auth = false) => { const o = {}; for (const t of TABLES) for (const m of MODES) o[`${t}/${m}`] = await count(t, m, auth); return o }
const startRest = async () => {
  rest?.kill(); await sleep(400); port = 30000 + Math.floor(Math.random() * 20000)
  rest = spawn(BIN, [], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', PGRST_DB_URI: `postgresql://authenticator:local@127.0.0.1:${main.port}/${MAIN}`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_SERVER_PORT: String(port), PGRST_SERVER_HOST: '127.0.0.1', PGRST_JWT_SECRET: SECRET } })
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).status < 500) return } catch { /* starting */ } await sleep(250) }
  throw new Error('PostgREST did not start')
}
// independent REST clients polling all (table, mode) pairs for both roles until stopped
const pollers = () => {
  const log = []; let on = true; const t0 = performance.now()
  const loops = []
  for (const auth of [false, true]) for (const t of TABLES) loops.push((async () => { while (on) for (const m of MODES) { const ts = performance.now() - t0; const r = await get(`${t}?select=id&limit=1`, auth, `count=${m}`); log.push({ ts, key: `${auth ? 'authenticated' : 'anon'}/${t}/${m}`, v: [200, 206].includes(r.status) ? Number(r.total) : `HTTP ${r.status}` }) } })())
  return { log, now: () => performance.now() - t0, stop: async () => { on = false; await Promise.all(loops) } }
}
const truth = async () => { const o = {}; for (const t of TABLES) o[t] = (await rows(main, `select count(*)::int n from public.${t}`))[0].n; return o }
let PK

before(async () => {
  if (SKIP) return
  await h.startServer(); admin = await h.connect('postgres'); await admin.query(`create database ${MAIN}`)
  main = await open(MAIN)
  await applyMigrations(main, { through: '030' }); await main.query("create role authenticator login noinherit password 'local'")
  await buildBaseline(main, dir); await applyMigrations(main, { through: '032' }); // the 032 stage: the identity tables are still readable by the Data API roles (033 closes them: tests/db/rest-boundary.test.mjs)
  await main.query('grant anon, authenticated to authenticator')
  // a plain table for the mechanism test (no promotion involved)
  await main.query(`create table public.zz_big (id bigint generated always as identity primary key, v text); insert into public.zz_big (v) select md5(g::text) from generate_series(1, 5000) g;
    alter table public.zz_big enable row level security; create policy public_read on public.zz_big for select to anon, authenticated using (true); grant select on public.zz_big to anon, authenticated`)
  await main.end(); await admin.query(`create database g55c_counts_stage template ${MAIN}`)
  const s = await open('g55c_counts_stage'); batches = await importSample(s, dir, { bulk: BULK }); await s.end(); main = await open(MAIN)
  await startRest()
}, { timeout: 240000 })
after(async () => { rest?.kill(); if (!SKIP) await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

test('mechanism: a bare DELETE leaves count=planned and count=estimated at the old size until ANALYZE (why a withdrawal must analyze)', { skip: SKIP }, async () => {
  await main.query('analyze public.zz_big'); assert.equal(await count('zz_big', 'planned'), 5000)
  await main.query('delete from public.zz_big where id > 100')
  assert.equal(await count('zz_big', 'exact'), 100)
  assert.equal(await count('zz_big', 'planned'), 5000, 'planned still shows the deleted rows')
  assert.equal(await count('zz_big', 'estimated'), 5000, 'and so does estimated, whenever the estimate is large enough for PostgREST to use it')
  await main.query('analyze public.zz_big'); assert.equal(await count('zz_big', 'planned'), 100); assert.equal(await count('zz_big', 'estimated'), 100)
})

test('before the withdrawal all three counts agree with the table, for both Data API roles and both orders of a duplicated Prefer header', { skip: SKIP }, async () => {
  PK = await buildPackage({ connect: open, admin, baseName: MAIN, stageName: 'g55c_counts_stage', config: config() })
  assert.equal((await promote({ connect: open, name: MAIN, pkg: PK })).result, 'PROMOTED'); await main.query('analyze')   // the steady state a database reaches after a promotion
  const t = await truth(); assert.ok(t.players > BULK, `players ${t.players}`)
  for (const auth of [false, true]) { const s = await snapshot(auth); for (const tb of TABLES) for (const m of MODES) assert.equal(s[`${tb}/${m}`], tb === 'coverage_assessments' && m !== 'exact' ? Math.max(1, t[tb]) : t[tb], `${tb} ${m} ${auth}`) }
  for (const tb of ['players', 'source_observations']) for (const [a, b] of [['exact', 'planned'], ['planned', 'exact'], ['exact', 'estimated'], ['estimated', 'exact']]) {
    const r = await get(`${tb}?select=id&limit=1`, false, [`count=${a}`, `count=${b}`]); assert.equal(Number(r.total), t[tb], `${tb} ${a}+${b}`)
  }
})

test('a committed withdrawal: after the commit exact, planned and estimated all show the withdrawn state, for every order of a duplicated Prefer header; independent clients never see the old size afterwards', { skip: SKIP }, async () => {
  const before = await truth(); const p = pollers(); await sleep(400)
  const w = await open(MAIN); await w.query('begin'); await w.query("select ingest.withdraw_promotion($1, 'G5-5C: count test', false)", [PK.sha])
  const open1 = { exact: await count('players', 'exact'), estimated: await count('players', 'estimated') }
  await sleep(600)
  assert.equal(open1.exact, before.players, 'exact shows the published rows until the commit'); assert.equal(open1.estimated, before.players, 'estimated too')
  const tc0 = p.now(); await w.query('commit'); const tc1 = p.now(); await sleep(700); await p.stop(); await w.end()
  const after2 = await truth(); assert.ok(after2.players < before.players / 10, `players ${before.players} -> ${after2.players}`)
  for (const auth of [false, true]) { const s = await snapshot(auth); for (const tb of TABLES) {
    assert.equal(s[`${tb}/exact`], after2[tb]); assert.ok(s[`${tb}/planned`] <= after2[tb] + 1, `${tb} planned ${s[`${tb}/planned`]} vs ${after2[tb]}`); assert.ok(s[`${tb}/estimated`] <= after2[tb] + 1, `${tb} estimated ${s[`${tb}/estimated`]} vs ${after2[tb]}`) } }
  for (const tb of ['players', 'source_observations']) for (const [a, b] of [['exact', 'planned'], ['planned', 'exact'], ['exact', 'estimated'], ['estimated', 'exact'], ['planned', 'estimated'], ['estimated', 'planned']]) {
    const r = await get(`${tb}?select=id&limit=1`, false, [`count=${a}`, `count=${b}`]); assert.ok(Number(r.total) <= after2[tb] + 1, `${tb} ${a}+${b} -> ${r.total}`)
  }
  // the zero-disclosure property: every observation STARTED after the commit returned is the withdrawn state (nothing over the true count)
  const late = p.log.filter((x) => x.ts > tc1 + 15); assert.ok(late.length > 200, `${late.length} late observations`)
  const bad = late.filter((x) => typeof x.v !== 'number' || x.v > after2[x.key.split('/')[1]] + 1); assert.deepEqual(bad.slice(0, 3), [], 'no request started after the commit saw the old size')
  // what was seen while the transaction was open and during the commit itself: only the old state or the new one, never anything in between
  const seen = new Set(p.log.filter((x) => x.ts >= tc0 - 800 && x.ts <= tc1 + 15 && x.key.endsWith('players/exact')).map((x) => x.v)); for (const v of seen) assert.ok(v === before.players || v === after2.players, `exact players ${v}`)
})

test('a withdrawal that fails after its ANALYZE: planned is repaired by the tool, never left over-stated, and a retry succeeds', { skip: SKIP }, async () => {
  PK = await buildPackage({ connect: open, admin, baseName: MAIN, stageName: 'g55c_counts_stage', config: config() })
  assert.equal((await promote({ connect: open, name: MAIN, pkg: PK })).result, 'PROMOTED'); await main.query('analyze')
  const t = await truth()
  // a deferred trigger that fails at COMMIT, after the whole withdrawal, including its ANALYZE, has run
  await main.query(`create function public.zz_fail_at_commit() returns trigger language plpgsql as $$ begin raise exception 'injected failure at commit'; end $$;
    create constraint trigger zz_fail after delete on public.sources deferrable initially deferred for each row execute function public.zz_fail_at_commit()`)
  // 1. without the tool's repair (raw SQL): reltuples was updated in place and is NOT rolled back: planned now UNDER-states the table. Never over-states; documented.
  await assert.rejects(main.query("select ingest.withdraw_promotion($1, 'G5-5C: failing', false)", [PK.sha]), /injected failure/)
  assert.equal(await count('players', 'exact'), t.players, 'nothing was withdrawn'); assert.ok(await count('players', 'planned') < t.players / 10, 'planned under-states after the rolled-back analyze (the documented hazard)')
  // 2. the tool repairs it at once
  await analyzeStatistics(main, PK.sha); assert.equal(await count('players', 'planned'), t.players)
  await assert.rejects(withdraw(main, PK.sha, 'G5-5C: failing through the tool'), /injected failure/)
  for (const tb of TABLES) for (const m of MODES) assert.ok(Math.abs((await count(tb, m)) - t[tb]) <= 1, `${tb} ${m} is repaired after the tool's failed withdrawal`)
  assert.equal((await rows(main, 'select ingest.promotion_state($1) s', [PK.sha]))[0].s, 'PROMOTED')
  // 3. retry
  await main.query('drop trigger zz_fail on public.sources'); const r = await withdraw(main, PK.sha, 'G5-5C: retry'); assert.ok(r.statistics.tables_analyzed >= 10); assert.ok(r.maintenance.vacuumed >= 10, JSON.stringify(r.maintenance), 'the tool vacuums and analyzes the touched tables after the commit')
  assert.ok(Math.abs((await count('players', 'planned')) - (await truth()).players) <= 1)
})
