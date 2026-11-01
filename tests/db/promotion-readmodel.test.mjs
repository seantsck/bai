// G5-5C Parts B, C and D: the read-model corrections of migration 032 section 6 and the withdrawal's use of them.
//   B  the per-row probe that the withdrawal triggers made against rm_transactions (50,000 calls, 37 s of a 54 s finish at full scale) is skipped once the read model is proven clean;
//   C  the three indexes that remove the 20 s of full scans from the transaction read-model refresh;
//   D  rm_transactions.search_tsv no longer depends on the physical order of rm_transaction_players.
// FICTIONAL data (tests/db/promotion-fixture.mjs). The full-scale timings are in the G5-5C report, not asserted here (they depend on the machine).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { SESSION_SQL, buildPackage, emergencyWithdraw, finishWithdrawal, promote, sha256, withdraw } from '../../scripts/db/lib/promotion.mjs'
import { buildBaseline, importSample } from './promotion-fixture.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-g55c-'))
const MAIN = 'g55c_rm'
let admin, main, batches, pkg
const open = async (name) => { const c = await h.connect(name); c.on('error', () => {}); await c.query(SESSION_SQL); return c }
const rows = (c, sql, p) => h.rows(c, sql, p)
const config = () => ({ category: 'RETROSHEET', authorization: { effective_from: '2026-10-30', expires_on: '2027-01-22' },
  attribution: { evidence_sha256: sha256('fixture evidence'), verified_at: new Date().toISOString(), max_age_hours: 72 }, archive: { name: 'fixture', sha256: sha256('a') }, expectBatches: batches })
const refreshAll = async () => { await main.query('select public.refresh_read_models()'); await main.query('select public.refresh_transaction_read_models()') }
const tsv = async () => new Map((await rows(main, 'select transaction_id, search_tsv::text t from public.rm_transactions')).map((r) => [String(r.transaction_id), r.t]))
const restoreGrant = (g) => main.query('insert into ingest.source_publication_grants select * from jsonb_populate_record(null::ingest.source_publication_grants, $1::jsonb) on conflict do nothing', [JSON.stringify(g)])
let GRANT_ROW

before(async () => {
  await h.startServer(); admin = await h.connect('postgres'); await admin.query(`create database ${MAIN}`)
  main = await open(MAIN)
  await applyMigrations(main, { through: '030' }); await buildBaseline(main, dir); await applyMigrations(main)
  GRANT_ROW = (await rows(main, "select to_jsonb(g) j from ingest.source_publication_grants g where attribution_category = 'RETROSHEET'"))[0].j
  await main.end(); await admin.query(`create database g55c_rm_stage template ${MAIN}`)
  const s = await open('g55c_rm_stage'); batches = await importSample(s, dir); await s.end(); main = await open(MAIN)
}, { timeout: 180000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

test('C: the three indexes exist and the lookups of research.transaction_gaps can use them', async () => {
  const have = (await rows(main, "select indexname from pg_indexes where schemaname = 'public' and indexname in ('trade_package_assets_package_idx', 'transaction_source_links_asset_idx', 'transaction_source_links_package_idx') order by 1")).map((r) => r.indexname)
  assert.deepEqual(have, ['trade_package_assets_package_idx', 'transaction_source_links_asset_idx', 'transaction_source_links_package_idx'])
  await main.query('begin'); await main.query('set local enable_seqscan = off')
  const plan = async (sql) => (await rows(main, `explain ${sql}`)).map((r) => r['QUERY PLAN']).join('\n')
  assert.match(await plan('select 1 from public.trade_package_assets where trade_package_id = 1'), /trade_package_assets_package_idx/)
  assert.match(await plan('select 1 from public.transaction_source_links where trade_package_asset_id = 1'), /transaction_source_links_asset_idx/)
  assert.match(await plan('select 1 from public.transaction_source_links where trade_package_id = 1'), /transaction_source_links_package_idx/)
  await main.query('rollback')
})

test('D: search_tsv is independent of the physical row order of rm_transaction_players (the string_agg now has an ORDER BY), and the old expression was not', async () => {
  const def = (await rows(main, "select pg_get_functiondef('public.refresh_transaction_read_models'::regproc) d"))[0].d
  const m = def.match(/string_agg\(public\.normalize_name\(p\.player_name\),[^)]*?\bas names/s) ?? def.match(/(string_agg\(public\.normalize_name\(p\.player_name\), ' '.*?\)) as names/s)
  assert.ok(m, 'the vector-building aggregate is in the installed function'); const expr = m[0].replace(/ as names$/, '')
  assert.match(expr, /order by/i, 'the installed aggregate has an ORDER BY')
  const bare = "string_agg(public.normalize_name(p.player_name), ' ')"
  await main.query(`create temp table zz_pl (transaction_id bigint, player_id bigint, player_name text);
    insert into zz_pl select 1 + g / 3, g, (array['Zed Alpha','Amy Beta','Carl Gamma','Ben Delta','Dan Epsilon','Eve Zeta'])[1 + (g * 7) % 6] || ' ' || g from generate_series(0, 899) g;
    create temp table zz_pl_rev as select * from zz_pl order by player_id desc; create temp table zz_pl_shuf as select * from zz_pl order by md5(player_id::text)`)
  const vec = (t, e) => `select p.transaction_id, to_tsvector('simple', coalesce(${e}, ''))::text v from ${t} p group by 1`
  const differing = async (e) => (await rows(main, `with a as (${vec('zz_pl', e)}), b as (${vec('zz_pl_rev', e)}), c as (${vec('zz_pl_shuf', e)}) select count(*) filter (where a.v <> b.v)::int rev, count(*) filter (where a.v <> c.v)::int shuf from a join b using (transaction_id) join c using (transaction_id)`))[0]
  const old = await differing(bare); assert.ok(old.rev > 100 && old.shuf > 100, `the unordered aggregate is order-dependent (control): ${JSON.stringify(old)}`)
  assert.deepEqual(await differing(expr), { rev: 0, shuf: 0 }, 'the installed aggregate is not')
})

test('D: refreshing twice, and refreshing under different plans, gives identical search_tsv; the lexemes are those of the old expression', async () => {
  pkg = await buildPackage({ connect: open, admin, baseName: MAIN, stageName: 'g55c_rm_stage', config: config() })
  assert.equal((await promote({ connect: open, name: MAIN, pkg })).result, 'PROMOTED'); await refreshAll()
  const a = await tsv(); assert.ok(a.size >= 4)
  await main.query('select public.refresh_transaction_read_models()'); const b = await tsv()
  await main.query('begin'); await main.query('set local enable_hashagg = off'); await main.query('set local enable_sort = off'); await main.query('select public.refresh_transaction_read_models()'); await main.query('commit'); const c = await tsv()
  for (const [k, v] of a) { assert.equal(b.get(k), v, `refresh #2, transaction ${k}`); assert.equal(c.get(k), v, `refresh under other plans, transaction ${k}`) }
})

test('B: rm_withdraw_transactions skips its probe only inside a promotion withdrawal whose clean-read-model flag matches; promotion_rm_assert_clean refuses a read model that still publishes the promotion', async () => {
  const T = Number((await rows(main, "select t.id from transactions t join sources s on s.id = t.source_id where s.attribution_category = 'RETROSHEET' order by t.id limit 1"))[0].id)
  const count = async () => (await rows(main, 'select count(*)::int n from public.rm_transactions where transaction_id = $1', [T]))[0].n
  const withdrawOne = async (settings) => { await main.query('begin'); for (const [k, v] of Object.entries(settings)) await main.query("select set_config($1, $2, true)", [k, v])
    const r = (await rows(main, "select public.rm_withdraw_transactions(array[$1::bigint], 'probe') n", [T]))[0].n; const left = await count(); await main.query('rollback'); return [r, left] }
  assert.equal(await count(), 1, 'the transaction is published')
  assert.deepEqual(await withdrawOne({}), [1, 0], 'an ordinary change withdraws it')
  assert.deepEqual(await withdrawOne({ 'bai.promotion_rm_clean': 'abc' }), [1, 0], 'a flag without the matching withdrawal marker does nothing')
  assert.deepEqual(await withdrawOne({ 'bai.promotion_withdrawal': 'abc' }), [1, 0], 'the withdrawal marker alone does nothing')
  assert.deepEqual(await withdrawOne({ 'bai.promotion_withdrawal': 'abc', 'bai.promotion_rm_clean': 'abd' }), [1, 0], 'different values do nothing')
  assert.deepEqual(await withdrawOne({ 'bai.promotion_withdrawal': 'abc', 'bai.promotion_rm_clean': 'abc' }), [0, 1], 'matching values: skipped (the caller proved the read model clean)')
  await main.query('begin'); await assert.rejects(main.query('select ingest.promotion_rm_assert_clean($1)', [pkg.sha]), /still in the published read model/); await main.query('rollback')
  await main.query('begin'); await main.query("select public.rm_withdraw_category('RETROSHEET', 'probe')"); await main.query('select ingest.promotion_rm_assert_clean($1)', [pkg.sha]); await main.query('rollback')
  assert.equal(await count(), 1, 'nothing above persisted')
})

test('B: finish_withdrawal after an emergency does not probe the read model once per deleted row (the full-scale 37 s), and still leaves it clean', async () => {
  await emergencyWithdraw(main, pkg.sha, 'drill: close', { closeApi: true })
  await main.query('analyze public.rm_transactions')           // the state that made the probe slow: emptied, then analyzed
  const scans = async () => { await main.query('select pg_stat_force_next_flush()'); return Number((await rows(main, "select coalesce(seq_scan, 0) + coalesce(idx_scan, 0) n from pg_stat_user_tables where relid = 'public.rm_transactions'::regclass"))[0].n) }
  const before = await scans(); const f = await finishWithdrawal(main, pkg.sha, 'drill: finish'); const used = (await scans()) - before
  assert.ok(f.rows_deleted > 30); assert.ok(used <= 40, `the read model was scanned ${used} times by the finish (the per-row triggers fired ${f.rows_deleted} times)`)
  assert.equal((await rows(main, 'select count(*)::int n from public.rm_transactions'))[0].n, 0)
  assert.equal(f.statistics.tables_analyzed >= 10, true)
  await restoreGrant(GRANT_ROW)
})

test('A: a normal withdrawal analyzes the tables it changed, last, and the estimates describe the withdrawn state', async () => {
  const pkg2 = await buildPackage({ connect: open, admin, baseName: MAIN, stageName: 'g55c_rm_stage', config: config() })
  assert.equal((await promote({ connect: open, name: MAIN, pkg: pkg2 })).result, 'PROMOTED'); await refreshAll(); await main.query('analyze')
  const est = async () => Object.fromEntries((await rows(main, "select relname, reltuples::int n from pg_class where relname in ('players', 'player_external_ids', 'source_observations', 'sources', 'rm_overview', 'rm_coverage_summary') order by 1")).map((r) => [r.relname, r.n]))
  const before = await est(); const r = await withdraw(main, pkg2.sha, 'drill: statistics'); const after = await est()
  assert.ok(before.players > after.players && before.source_observations > after.source_observations, JSON.stringify({ before, after }))
  const live = Object.fromEntries(await Promise.all(Object.keys(after).map(async (t) => [t, (await rows(main, `select count(*)::int n from public.${t}`))[0].n])))
  for (const t of Object.keys(after)) assert.ok(after[t] <= live[t] + 1, `${t}: estimate ${after[t]} vs live ${live[t]}`)
  assert.ok(r.statistics.tables_analyzed >= 10)
  // the standalone repair is idempotent and also refuses nothing here
  assert.ok((await rows(main, 'select ingest.promotion_analyze($1) r', [pkg2.sha]))[0].r.tables_analyzed >= 10)
})
