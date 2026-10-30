// The Data API boundary of migration 032, over real HTTP with a real PostgREST (a pinned local binary: BAI_POSTGREST_BIN, default ~/tmp-bai/g5-2-bin/postgrest). Skipped, loudly, when the
// binary is absent. It checks: the 12 rm_transaction* tables are closed to anon and authenticated; every other public relation (and the attribution summary) still answers; a promotion
// makes the identity rows public and leaves the transaction read models closed; an emergency hides exactly the promoted rows (and, closed, whole tables); nothing is deleted.
// FICTIONAL data (tests/db/promotion-fixture.mjs).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as h from './harness.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { SESSION_SQL, buildPackage, emergencyWithdraw, finishWithdrawal, promote, sha256 } from '../../scripts/db/lib/promotion.mjs'
import { buildBaseline, importSample } from './promotion-fixture.mjs'

const BIN = process.env.BAI_POSTGREST_BIN ?? `${os.homedir()}/tmp-bai/g5-2-bin/postgrest`
const SKIP = fs.existsSync(BIN) ? false : `SKIPPED: no PostgREST binary at ${BIN} (set BAI_POSTGREST_BIN)`
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-g54r-'))
const MAIN = 'g54r_main'
let admin, main, rest = null, port = 0, batches, pkg, GRANT_ROW
const SECRET = crypto.randomBytes(32).toString('hex'); const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const JWT = (() => { const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'authenticated' })}`; return `${head}.${crypto.createHmac('sha256', SECRET).update(head).digest('base64url')}` })()
const open = async (name) => { const c = await h.connect(name); c.on('error', () => {}); await c.query(SESSION_SQL); return c }
const rows = (c, sql, p) => h.rows(c, sql, p)
const RM12 = ['rm_transactions', 'rm_transaction_overview', 'rm_transaction_assets', 'rm_transaction_packages', 'rm_transaction_players', 'rm_transaction_returns', 'rm_transaction_sources', 'rm_transaction_followups', 'rm_transaction_coverage', 'rm_transaction_club_seasons', 'rm_transaction_refreshes', 'rm_transaction_withdrawals']
const PUBLIC5 = ['players', 'player_external_ids', 'source_observations', 'coverage_assessments', 'sources']

const startRest = async () => {
  rest?.kill(); await new Promise((r) => setTimeout(r, 500)); port = 30000 + Math.floor(Math.random() * 20000)
  rest = spawn(BIN, [], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', PGRST_DB_URI: `postgresql://authenticator:local@127.0.0.1:${main.port}/${MAIN}`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_SERVER_PORT: String(port), PGRST_SERVER_HOST: '127.0.0.1', PGRST_JWT_SECRET: SECRET } })
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).status < 500) return } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)) }
  throw new Error('PostgREST did not start')
}
const get = async (p, auth, prefer = 'count=exact') => { const r = await fetch(`http://127.0.0.1:${port}/${p}`, { headers: { ...(auth ? { Authorization: `Bearer ${JWT}` } : {}), Prefer: prefer } }); const body = await r.text(); return { status: r.status, total: r.headers.get('content-range')?.split('/')[1] ?? null, body } }
const counts = async (auth) => Object.fromEntries(await Promise.all(PUBLIC5.map(async (t) => [t, (await get(`${t}?select=id&limit=1`, auth)).total])))

before(async () => {
  if (SKIP) return
  await h.startServer(); admin = await h.connect('postgres'); await admin.query(`create database ${MAIN}`)
  main = await open(MAIN)
  await applyMigrations(main, { through: '030' }); await main.query("create role authenticator login noinherit password 'local'")
  await buildBaseline(main, dir); await applyMigrations(main); await main.query('grant anon, authenticated to authenticator')
  await main.end(); await admin.query(`create database g54r_stage template ${MAIN}`)
  const s = await open('g54r_stage'); batches = await importSample(s, dir); await s.end()
  main = await open(MAIN)
  GRANT_ROW = (await rows(main, "select to_jsonb(g) j from ingest.source_publication_grants g"))[0].j
  pkg = await buildPackage({ connect: open, admin, baseName: MAIN, stageName: 'g54r_stage', config: { category: 'RETROSHEET', authorization: { effective_from: '2026-10-30', expires_on: '2027-01-22' },
    attribution: { evidence_sha256: sha256('fixture evidence'), verified_at: new Date().toISOString(), max_age_hours: 72 }, archive: { name: 'fixture', sha256: sha256('a') }, expectBatches: batches } })
  await startRest()
}, { timeout: 180000 })
after(async () => { rest?.kill(); if (!SKIP) await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

test('Data API, before any promotion: the 12 transaction read models are closed to anon and authenticated; every other public relation answers', { skip: SKIP }, async () => {
  for (const t of RM12) for (const auth of [false, true]) { const r = await get(`${t}?select=*&limit=1`, auth); assert.ok([401, 403].includes(r.status), `${t} ${auth ? 'authenticated' : 'anon'} -> ${r.status}`); assert.doesNotMatch(r.body, /"transaction_id"|"id":\s*\d/, 'the refusal carries no row') }
  for (const t of [...PUBLIC5, 'v_source_attribution', 'rm_overview', 'source_attribution_statements', 'v_transaction_record_sources', 'organizations']) for (const auth of [false, true]) assert.ok([200, 206].includes((await get(`${t}?select=*&limit=1`, auth)).status), `${t} stays readable`)
  const retro = JSON.parse((await get("v_source_attribution?select=*&attribution_category=eq.RETROSHEET", false)).body); assert.deepEqual(retro, [], 'no Retrosheet attribution row exists before a promotion')
})

let baseCounts
test('Data API after a promotion and a refresh: the identity rows are public with their credit, the transaction read models are still closed, the attribution summary counts the displayed records', { skip: SKIP }, async () => {
  baseCounts = await counts(false)
  const dates = async () => JSON.parse((await get('source_observations?select=id&subject_table=eq.transactions&field_name=eq.transaction_date&limit=1000', false)).body).length
  const datesBefore = await dates()
  assert.equal((await promote({ connect: open, name: MAIN, pkg })).result, 'PROMOTED')
  await main.query('select public.refresh_read_models()'); await main.query('select public.refresh_transaction_read_models()')
  const now = await counts(false); assert.equal(Number(now.players) - Number(baseCounts.players), pkg.manifest.delta['public.players'].n)
  assert.equal(Number(now.source_observations) - Number(baseCounts.source_observations), pkg.manifest.delta['public.source_observations'].n, 'the withheld evidence is not among them')
  assert.deepEqual(await counts(true), now, 'authenticated sees the same')
  const src = JSON.parse((await get("sources?select=source_key,publisher,notes,attribution_category&attribution_category=eq.RETROSHEET", false)).body)
  assert.equal(src.length, 1); assert.match(src[0].notes, /obtained free of charge from and is copyrighted by Retrosheet/, 'a REST read of the source row carries the verbatim statement')
  for (const t of RM12) assert.ok([401, 403].includes((await get(`${t}?select=*&limit=1`, false)).status), `${t} is still closed`)
  const attr = JSON.parse((await get("v_source_attribution?select=*&attribution_category=eq.RETROSHEET&domain=eq.TRANSACTION", false)).body); assert.equal(attr.length, 1); assert.ok(attr[0].records > 0)
  assert.equal(await dates(), datesBefore, 'only the existing (MLB) transaction_date observations are public')
  const retroObs = await rows(main, "select count(*)::int n from source_observations where subject_table = 'transactions' and field_name = 'transaction_date' and source_id in (select id from sources where attribution_category = 'RETROSHEET')"); assert.equal(retroObs[0].n, 0)
})

test('Data API in an emergency (hide): exactly the promoted rows disappear from every public table and from the attribution summary; counts are exact; nothing is deleted', { skip: SKIP }, async () => {
  const player = Number((await rows(main, "select id from players where full_name like 'Stage Player%' order by id limit 1"))[0].id)
  await main.query("insert into player_aliases (player_id, alias, alias_type, source_id) select $1, 'Unrelated Alias', 'NICKNAME', s.id from sources s where s.source_key = 'g54:base'", [player])
  await emergencyWithdraw(main, pkg.sha, 'drill: licence withdrawn')
  for (const auth of [false, true]) assert.deepEqual(await counts(auth), baseCounts, `exact counts equal the baseline (${auth ? 'authenticated' : 'anon'})`)
  assert.deepEqual(JSON.parse((await get("v_source_attribution?select=*&attribution_category=eq.RETROSHEET", false)).body), [])
  assert.deepEqual(JSON.parse((await get("sources?select=id&attribution_category=eq.RETROSHEET", false)).body), [])
  assert.equal(JSON.parse((await get("players?select=id&full_name=like.Stage*", false)).body).length, 0, 'a filter on the hidden rows finds nothing')
  for (const t of RM12) assert.ok([401, 403].includes((await get(`${t}?select=*&limit=1`, false)).status))
  assert.equal((await rows(main, "select count(*)::int n from players where full_name like 'Stage Player%'"))[0].n, 4, 'still physically present, owner-visible only')
  // Known limit of hiding, measured and stated (not hidden): the planner's estimate is made from the whole table.
  const planned = Number((await get('players?select=id&limit=1', false, 'count=planned')).total); assert.ok(planned >= Number(baseCounts.players), `planned count ${planned} vs exact ${baseCounts.players}`)
})

test('Data API in an emergency (closed): the stricter mode answers 401/403 on every table that held a promoted row, so not even an estimate leaks; finishing reopens them', { skip: SKIP }, async () => {
  await main.query("delete from player_aliases where alias = 'Unrelated Alias'")
  await finishWithdrawal(main, pkg.sha, 'blocker removed')
  await main.query('insert into ingest.source_publication_grants select * from jsonb_populate_record(null::ingest.source_publication_grants, $1::jsonb)', [JSON.stringify(GRANT_ROW)])   // exactly as before
  assert.deepEqual(await counts(false), baseCounts, 'the finished withdrawal is the baseline again')
  const pkg2 = await buildPackage({ connect: open, admin, baseName: MAIN, stageName: 'g54r_stage', config: { category: 'RETROSHEET', authorization: { effective_from: '2026-10-30', expires_on: '2027-01-22' },
    attribution: { evidence_sha256: sha256('fixture evidence'), verified_at: new Date().toISOString(), max_age_hours: 72 }, archive: { name: 'fixture', sha256: sha256('a') }, expectBatches: batches } })
  assert.notEqual(pkg2.sha, pkg.sha, 'a withdrawn manifest is never reused: this is a new manifest from the same sample'); assert.equal((await promote({ connect: open, name: MAIN, pkg: pkg2 })).result, 'PROMOTED')
  await emergencyWithdraw(main, pkg2.sha, 'drill: close the endpoints', { closeApi: true })
  for (const t of PUBLIC5) for (const auth of [false, true]) assert.ok([401, 403].includes((await get(`${t}?select=id&limit=1`, auth, 'count=planned')).status), `${t} is closed (${auth ? 'authenticated' : 'anon'})`)
  assert.ok([200, 206].includes((await get('organizations?select=id&limit=1', false)).status), 'unrelated public tables still answer')
  await finishWithdrawal(main, pkg2.sha, 'done')
  await main.query('insert into ingest.source_publication_grants select * from jsonb_populate_record(null::ingest.source_publication_grants, $1::jsonb)', [JSON.stringify(GRANT_ROW)])
  assert.deepEqual(await counts(false), baseCounts, 'reopened and back to the baseline')
})
