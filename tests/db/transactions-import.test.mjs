// Transaction importer (migration 028, version-2 TRADE records), verification and revocation. Every trade, player and
// club pairing here is FICTIONAL (dates in 2031-2032, MLBAM ids 988xxxx, TEST_FIXTURE sources); nothing is real data.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as T from '../../scripts/research/lib/transactions.mjs'

let db, rv, bot
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-txn-'))
before(async () => {
  await h.startServer(); db = await h.freshDatabase()
  rv = await h.login(db, 'txn_reviewer', { reviewer: true })
  bot = await h.login(db, 'txn_bot', {
    automation: true,
    grants: ['grant usage on schema public, research, ingest, analytics to $ROLE', 'grant select, insert, update on all tables in schema public, research, ingest to $ROLE', 'alter role $ROLE bypassrls']
  })
}, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const src = (key, authority = 'OFFICIAL') => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: authority, title: `Transaction fixture ${key}` })
const SRC = [src('t:club'), src('t:wire', 'REPUTABLE_SECONDARY'), src('t:echo', 'AGGREGATOR'), src('t:bref', 'AGGREGATOR')]
const GROUPS = [{ source_key: 't:club', role: 'PRIMARY_ANNOUNCEMENT', independence_group: 'club-release-a' }, { source_key: 't:wire', role: 'CORROBORATION', independence_group: 'wire-report-b' }]
const ALL = ['t:club', 't:wire']
const pl = (n, name) => ({ full_name: name ?? `Fixture Player ${n}`, external_ids: { MLBAM: String(9880000 + n) } })
const pk = (from, to, players, others = [], keys = ALL) => ({ from, to, source_keys: keys, players: players.map((p) => ({ player: p, source_keys: ALL })), other_assets: others.map((o) => ({ source_keys: ALL, ...o })) })
const rec = (ref, date, packages, extra = {}) => ({ type: 'TRADE', schema: 2, ref, organization: extra.organization ?? packages[0].from, date, source_key: 't:club', sources: GROUPS, packages, ...extra })
const mk = (key, records, sources = SRC) => T.prepareTradeDoc({ format: 'bai-research-import/1', batch_key: key, channel: 'TRADES', sources, records })
let n = 0
async function stage (doc) {
  const f = path.join(dir, `b-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify(doc))
  const { batch } = await P.stageFile(db, f, {})
  return { batch, validation: await P.validateBatch(db, batch.id) }
}
async function run (doc, { write = true } = {}) {
  const s = await stage(doc)
  assert.ok(s.validation.ok, `validation: ${JSON.stringify(s.validation.counts)} ${JSON.stringify(await h.rows(db, 'select record_index, validation_errors from ingest.staged_records where batch_id = $1', [s.batch.id]))}`)
  return P.applyBatch(db, s.batch.id, { write })
}
const invalidReasons = async (batchId) => (await h.rows(db, "select validation_errors from ingest.staged_records where batch_id = $1 and validation_status = 'INVALID'", [batchId])).flatMap((r) => r.validation_errors)
const txOf = async (scheme, id) => Number((await h.one(db, 'select transaction_id from transaction_external_ids where scheme = $1 and external_id = $2', [scheme, id])).transaction_id)
const status = async (tx) => h.one(db, 'select completeness, gaps, independent_source_groups groups, verified_by, verification_stale from analytics.transaction_completeness where transaction_id = $1', [tx])
const counts = () => h.one(db, `select (select count(*) from transactions)::int tx, (select count(*) from trade_packages)::int pk, (select count(*) from trade_package_assets)::int assets,
  (select count(*) from transaction_external_ids)::int ids, (select count(*) from transaction_sources)::int srcs, (select count(*) from transaction_source_links)::int links,
  (select count(*) from ptbnl_resolutions)::int res, (select count(*) from transaction_conflicts)::int conflicts, (select count(*) from ingest.transaction_apply_ledger)::int ledger, (select count(*) from players)::int players`)

// ---------------------------------------------------------------------------------------------------------------
// Two-team trade, dry run, replay
// ---------------------------------------------------------------------------------------------------------------

const T1 = () => rec('t1', '2031-07-20', [pk('LAD', 'BAL', [pl(1), pl(2)], [{ asset_type: 'CASH', description: 'cash considerations', amount_usd: 100000 }]), pk('BAL', 'LAD', [pl(3)])],
  { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-0001' }], description: 'fictional two-club trade' })

test('a two-club trade: the dry run writes nothing, the write records identity, sources, packages, assets and provenance', async () => {
  const doc = mk('t-two-club', [T1()])
  const dry = await run(doc, { write: false })
  assert.deepEqual(dry.report.actions, { INSERT: 1 })
  assert.deepEqual((await counts()).tx, 0, 'dry run leaves nothing')
  const done = await run(mk('t-two-club-2', [T1()]))
  assert.deepEqual(done.report.actions, { INSERT: 1 })
  const c = await counts()
  assert.deepEqual([c.tx, c.pk, c.assets, c.ids, c.srcs, c.links, c.ledger], [1, 2, 4, 1, 2, 12, 1])
  const tx = await txOf('MLB_TXN', 'FIX-0001')
  const s = await status(tx)
  assert.deepEqual([s.completeness, s.gaps, s.groups], ['PARTIAL', [], 2], 'fully sourced, awaiting a human: never complete by import')
  assert.equal((await h.one(db, 'select transaction_type, date_precision from transactions where id = $1', [tx])).transaction_type, 'TRADE')
})

test('idempotent replay: the same batch again, and the same content in a new batch, change nothing', async () => {
  const before = await counts()
  const first = (await h.one(db, "select id from ingest.import_batches where batch_key = 't-two-club-2'")).id
  assert.deepEqual((await P.applyBatch(db, first, { write: true })).report.actions, { NO_CHANGE: 1 })
  assert.deepEqual((await run(mk('t-two-club-3', [T1()]))).report.actions, { NO_CHANGE: 1 })
  const after = await counts()
  assert.deepEqual({ ...after, ledger: 0 }, { ...before, ledger: 0 })
  assert.equal(after.ledger, before.ledger + 1, 'only the new batch is recorded in the ledger; the replayed batch is recognised')
})

// ---------------------------------------------------------------------------------------------------------------
// Multi-team, same-day, collisions
// ---------------------------------------------------------------------------------------------------------------

test('a three-club trade is one transaction with a package per direction', async () => {
  const r = rec('t3', '2031-07-21', [pk('NYY', 'SEA', [pl(10)]), pk('SEA', 'TB', [pl(11), pl(12)]), pk('TB', 'NYY', [pl(13)])], { organization: 'NYY' })
  const s = await stage(mk('t-three-club', [r]))
  assert.ok(s.validation.ok)
  assert.ok((await h.one(db, 'select validation_warnings w from ingest.staged_records where batch_id = $1', [s.batch.id])).w.some((w) => /more than two clubs/.test(w)))
  assert.deepEqual((await P.applyBatch(db, s.batch.id, { write: true })).report.actions, { INSERT: 1 })
  const x = await h.one(db, `select count(distinct k.id)::int pk, count(a.id)::int a from transactions t join trade_packages k on k.transaction_id = t.id join trade_package_assets a on a.trade_package_id = k.id where t.transaction_date = '2031-07-21'`)
  assert.deepEqual(x, { pk: 3, a: 4 })
})

test('same-day trades between the same clubs: a collision is held, two trades must name each other, a named one is imported', async () => {
  const other = (ref, ext, extra = {}) => rec(ref, '2031-07-20', [pk('LAD', 'BAL', [pl(20)]), pk('BAL', 'LAD', [pl(21)])], { external_ids: [{ scheme: 'MLB_TXN', id: ext }], ...extra })
  // against what is already canonical (t1, same day, same clubs, no shared identity): held, nothing written
  const before = await counts()
  const held = await run(mk('t-collide', [other('t4', 'FIX-0004')]))
  assert.deepEqual(held.report.actions, { HELD: 1 })
  assert.match(held.results[0].reason, /COLLISION: same day and clubs as transaction \d+/)
  assert.deepEqual(await counts(), { ...before, ledger: before.ledger })
  // naming the existing trade as a different one imports it: two transactions, same day, same pair
  const t1id = 'MLB_TXN:FIX-0001'
  assert.deepEqual((await run(mk('t-collide-named', [other('t4', 'FIX-0004', { distinct_from: [t1id] })]))).report.actions, { INSERT: 1 })
  assert.equal((await h.one(db, "select count(*)::int n from transactions where transaction_date = '2031-07-20'")).n, 2)
  // two such records in one batch must each name the other
  const a = rec('t5a', '2031-09-01', [pk('MIL', 'MIN', [pl(30)]), pk('MIN', 'MIL', [pl(31)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-0005A' }] })
  const b = rec('t5b', '2031-09-01', [pk('MIL', 'MIN', [pl(32)]), pk('MIN', 'MIL', [pl(33)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-0005B' }] })
  const bad = await stage(mk('t-sameday-bad', [a, b]))
  assert.equal(bad.validation.counts.invalid, 2)
  assert.ok((await invalidReasons(bad.batch.id)).some((e) => /each must name the other in distinct_from/.test(e)))
  const ok = await run(mk('t-sameday-ok', [{ ...a, distinct_from: ['MLB_TXN:FIX-0005B'] }, { ...b, distinct_from: ['MLB_TXN:FIX-0005A'] }]))
  assert.deepEqual(ok.report.actions, { INSERT: 2 })
  assert.equal((await h.one(db, "select count(*)::int n from transactions where transaction_date = '2031-09-01'")).n, 2)
})

test('the same identity with different content in one batch is refused; an exact duplicate is refused too', async () => {
  const a = rec('d1', '2031-10-01', [pk('PIT', 'STL', [pl(40)]), pk('STL', 'PIT', [pl(41)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-0006' }] })
  const b = rec('d2', '2031-10-01', [pk('PIT', 'STL', [pl(40), pl(42)]), pk('STL', 'PIT', [pl(41)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-0006' }] })
  const s = await stage(mk('t-dup-id', [a, b]))
  assert.ok((await invalidReasons(s.batch.id)).some((e) => /FIX-0006 is also used by record \d+ with different content/.test(e)))
  const d = await stage(mk('t-dup-exact', [a, JSON.parse(JSON.stringify(a))]))
  assert.ok((await invalidReasons(d.batch.id)).some((e) => /duplicate of record/.test(e)))
})

// ---------------------------------------------------------------------------------------------------------------
// Missing and conflicting assets
// ---------------------------------------------------------------------------------------------------------------

test('missing assets and provenance are refused at validation: no source, no strong id, no description, undeclared source', async () => {
  const base = () => rec('m1', '2031-11-01', [pk('CHC', 'CIN', [pl(50)]), pk('CIN', 'CHC', [pl(51)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-0007' }] })
  const cases = {
    'asset without a source': (r) => { r.packages[0].players[0].source_keys = [] },
    'player without a strong id': (r) => { r.packages[0].players[0].player = { full_name: 'Name Only' } },
    'other asset without description': (r) => { r.packages[0].other_assets = [{ asset_type: 'DRAFT_PICK', source_keys: ALL }] },
    'source not among the record sources': (r) => { r.packages[1].source_keys = ['t:nowhere'] },
    'package with nothing in it': (r) => { r.packages[1].players = []; r.packages[1].other_assets = [] },
    'one group missing': (r) => { r.sources = [{ source_key: 't:club', role: 'PRIMARY_ANNOUNCEMENT' }] },
    'no identity': (r) => { r.external_ids = [] }
  }
  for (const [name, mutate] of Object.entries(cases)) {
    const r = JSON.parse(JSON.stringify(base()))
    mutate(r)
    const f = path.join(dir, `raw-${++n}.json`)
    // bypass the preparer (it would add the derived identity): this is a hand-written record
    fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', batch_key: `t-missing-${n}`, channel: 'TRADES', sources: SRC, records: [r] }))
    const { batch } = await P.stageFile(db, f, {})
    const v = await P.validateBatch(db, batch.id)
    assert.equal(v.counts.invalid, 1, name)
  }
})

test('conflicting values hold the whole record, keep a conflict, and change nothing canonical; additions and omissions are not conflicts', async () => {
  const tx = await txOf('MLB_TXN', 'FIX-0001')
  const snap = async () => h.one(db, `select (select count(*) from trade_package_assets a join trade_packages k on k.id = a.trade_package_id where k.transaction_id = $1)::int assets,
    (select to_char(transaction_date, 'YYYY-MM-DD') from transactions where id = $1) d, (select amount_usd::text from trade_package_assets a join trade_packages k on k.id = a.trade_package_id where k.transaction_id = $1 and a.asset_type = 'CASH') cash`, [tx])
  const before = await snap()
  const conflicting = {
    date: T1(),
    direction: T1(),
    cash: T1()
  }
  conflicting.date.date = '2031-07-22'
  conflicting.direction.packages = [pk('LAD', 'BAL', [pl(2)], [{ asset_type: 'CASH', description: 'cash considerations', amount_usd: 100000 }]), pk('BAL', 'LAD', [pl(3), pl(1)])]
  conflicting.cash.packages[0].other_assets[0].amount_usd = 200000
  const seen = []
  for (const [k, r] of Object.entries(conflicting)) {
    const res = await run(mk(`t-conflict-${k}`, [r]))
    assert.deepEqual(res.report.actions, { HELD: 1 }, k)
    seen.push(res.results[0].reason)
  }
  assert.match(seen[0], /CONFLICT: date \(2031-07-20 \(DAY\) vs 2031-07-22 \(DAY\)\)/)
  assert.match(seen[1], /players\.9880001: sent LAD>BAL vs sent BAL>LAD|players\.9880001/)
  assert.match(seen[2], /amount \(100000\.00 vs 200000\)/)
  assert.deepEqual(await snap(), before, 'canonical record untouched')
  const open = await h.rows(db, "select field_path from transaction_conflicts where transaction_id = $1 and status = 'OPEN' order by field_path", [tx])
  assert.equal(open.length, 3)
  assert.ok((await status(tx)).gaps.includes('OPEN_CONFLICT'))
  // replaying a conflicting batch does not multiply the conflict
  const batchId = (await h.one(db, "select id from ingest.import_batches where batch_key = 't-conflict-cash'")).id
  await P.applyBatch(db, batchId, { write: true })
  assert.equal((await h.one(db, 'select count(*)::int n from transaction_conflicts where transaction_id = $1', [tx])).n, 3)
  // an omission (the record names only part of the trade) is silence, not a conflict; an addition is applied
  const subset = T1(); subset.packages = [subset.packages[0]]; subset.packages[0].players = [subset.packages[0].players[0]]
  assert.deepEqual((await run(mk('t-subset', [subset]))).report.actions, { NO_CHANGE: 1 })
  assert.equal((await snap()).assets, before.assets, 'nothing removed')
  const extra = T1(); extra.packages[0].players.push({ player: pl(4), source_keys: ALL })
  assert.deepEqual((await run(mk('t-extra', [extra]))).report.actions, { UPDATE_UNKNOWN: 1 })
  assert.equal((await snap()).assets, before.assets + 1)
})

// ---------------------------------------------------------------------------------------------------------------
// Cash: unknown, undisclosed and zero are three different facts
// ---------------------------------------------------------------------------------------------------------------

test('unknown cash is not zero: UNKNOWN, UNDISCLOSED and a stated zero are stored and treated apart', async () => {
  const cash = (ext, a, pair, extra) => rec(ext.toLowerCase(), '2031-08-05', [pk(pair[0], pair[1], [pl(60 + extra)], [{ asset_type: 'CASH', description: 'cash', ...a }]), pk(pair[1], pair[0], [pl(70 + extra)])], { external_ids: [{ scheme: 'MLB_TXN', id: ext }] })
  await run(mk('t-cash', [cash('FIX-CASH-U', {}, ['MIA', 'PHI'], 1), cash('FIX-CASH-N', { amount_disclosure: 'UNDISCLOSED' }, ['COL', 'ARI'], 2), cash('FIX-CASH-0', { amount_usd: 0 }, ['KC', 'DET'], 3)]))
  const row = async (ext) => h.one(db, `select a.amount_usd::text amount, a.amount_disclosure d from trade_package_assets a join trade_packages k on k.id = a.trade_package_id join transaction_external_ids x on x.transaction_id = k.transaction_id
    where x.external_id = $1 and a.asset_type = 'CASH'`, [ext])
  assert.deepEqual(await row('FIX-CASH-U'), { amount: null, d: 'UNKNOWN' })
  assert.deepEqual(await row('FIX-CASH-N'), { amount: null, d: 'UNDISCLOSED' })
  assert.deepEqual(await row('FIX-CASH-0'), { amount: '0.00', d: 'DISCLOSED' })
  const gaps = async (ext) => (await status(await txOf('MLB_TXN', ext))).gaps
  assert.ok((await gaps('FIX-CASH-U')).includes('CASH_AMOUNT_UNKNOWN'))
  assert.ok(!(await gaps('FIX-CASH-N')).includes('CASH_AMOUNT_UNKNOWN'), 'a source-stated "undisclosed" is a known status')
  assert.ok(!(await gaps('FIX-CASH-0')).includes('CASH_AMOUNT_UNKNOWN'))
  // unknown is filled by a later source; a known value is never replaced; silence is not a change
  assert.deepEqual((await run(mk('t-cash-fill', [cash('FIX-CASH-U', { amount_usd: 50000 }, ['MIA', 'PHI'], 1)]))).report.actions, { UPDATE_UNKNOWN: 1 })
  assert.deepEqual(await row('FIX-CASH-U'), { amount: '50000.00', d: 'DISCLOSED' })
  assert.deepEqual((await run(mk('t-cash-silent', [cash('FIX-CASH-0', {}, ['KC', 'DET'], 3)]))).report.actions, { NO_CHANGE: 1 })
  assert.deepEqual(await row('FIX-CASH-0'), { amount: '0.00', d: 'DISCLOSED' })
  assert.deepEqual((await run(mk('t-cash-rival-zero', [cash('FIX-CASH-0', { amount_usd: 10 }, ['KC', 'DET'], 3)]))).report.actions, { HELD: 1 })
  assert.deepEqual((await run(mk('t-cash-rival-undisclosed', [cash('FIX-CASH-N', { amount_usd: 75000 }, ['COL', 'ARI'], 2)]))).report.actions, { HELD: 1 })
  assert.deepEqual(await row('FIX-CASH-N'), { amount: null, d: 'UNDISCLOSED' })
})

// ---------------------------------------------------------------------------------------------------------------
// PTBNL, conditional assets, historical WAR attribution, no double counting
// ---------------------------------------------------------------------------------------------------------------

const PTBNL = () => rec('p1', '2031-08-01', [pk('HOU', 'TEX', [pl(80)], [{ asset_type: 'PLAYER_TO_BE_NAMED', description: 'PTBNL or cash', condition_text: 'a player to be named, or cash, by 2032-01-31' }]), pk('TEX', 'HOU', [pl(81)])],
  { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-PTBNL' }] })
const resolveTo = (resolution) => { const r = PTBNL(); r.packages[0].other_assets[0].resolution = resolution; return r }

test('an unresolved PTBNL is a gap and contributes nothing; it is conditional by definition', async () => {
  await run(mk('t-ptbnl', [PTBNL()]))
  const tx = await txOf('MLB_TXN', 'FIX-PTBNL')
  assert.ok((await status(tx)).gaps.includes('PENDING_PTBNL'))
  const a = await h.one(db, "select conditional, condition_text, player_id from trade_package_assets where asset_type = 'PLAYER_TO_BE_NAMED' and trade_package_id in (select id from trade_packages where transaction_id = $1)", [tx])
  assert.deepEqual([a.conditional, a.player_id], [true, null])
  assert.equal((await h.one(db, 'select count(*)::int n from analytics.trade_asset_players where via_ptbnl')).n, 0)
})

test('PTBNL resolution: refused before the trade, applied once, conflicting rivals held; the named player enters the return views from the naming season only', async () => {
  const early = await stage(mk('t-ptbnl-early', [resolveTo({ kind: 'PLAYER', player: pl(82), resolved_on: '2031-07-01', source_key: 't:wire' })]))
  assert.ok((await invalidReasons(early.batch.id)).some((e) => /cannot be named before the trade/.test(e)))
  // WAR is observed for the named player: 2031 (with TEX, before he was named: not a return), 2032 and 2033 (after)
  const res = await run(mk('t-ptbnl-named', [resolveTo({ kind: 'PLAYER', player: pl(82), resolved_on: '2032-01-10', source_key: 't:wire' })]))
  assert.deepEqual(res.report.actions, { UPDATE_UNKNOWN: 1 })
  const named = await h.one(db, "select p.id from players p join player_external_ids x on x.player_id = p.id and x.id_system = 'MLBAM' where x.external_id = '9880082'")
  const org = async (k) => Number((await h.one(db, 'select id from organizations where franchise_key = $1', [k])).id)
  const tex = await org('TEX')
  const src = Number((await h.one(db, "select id from sources where source_key = 't:bref'")).id)
  for (const [season, v] of [[2031, 9.0], [2032, 2.0], [2033, 1.0]]) {
    await db.query("insert into war_observations (player_id, war_system, scope, season, organization_id, through_season, war_value, observed_on, source_id) values ($1, 'BREF', 'SEASON', $2, $3, 2033, $4, '2033-11-01', $5)", [named.id, season, tex, v, src])
  }
  const ret = await h.one(db, `select return_war_known::float8 war, return_coverage cov, received_player_ids ids from analytics.trade_returns where war_system = 'BREF' and organization_id = $1
    and transaction_id = (select transaction_id from transaction_external_ids where external_id = 'FIX-PTBNL')`, [tex])
  assert.equal(ret.war, 3, 'the 2031 value (before he was named) is not this trade\'s return; 2032 and 2033 are')
  assert.equal(ret.ids.length, 2, 'the directly traded player and the named player')
  assert.ok(ret.ids.map(String).includes(String(named.id)))
  assert.ok(!(await status(await txOf('MLB_TXN', 'FIX-PTBNL'))).gaps.includes('PENDING_PTBNL'))
  // a rival resolution (another player, or a different date) is a conflict
  const rival = await run(mk('t-ptbnl-rival', [resolveTo({ kind: 'PLAYER', player: pl(83), resolved_on: '2032-01-10', source_key: 't:wire' })]))
  assert.deepEqual(rival.report.actions, { HELD: 1 })
  assert.deepEqual((await run(mk('t-ptbnl-replay', [resolveTo({ kind: 'PLAYER', player: pl(82), resolved_on: '2032-01-10', source_key: 't:wire' })]))).report.actions, { NO_CHANGE: 1 })
})

test('no double counting: one WAR observation is credited once per organization; a named player cannot also be a direct asset', async () => {
  const w = await h.one(db, "select id, organization_id, player_id from war_observations where season = 2032 and war_value = 2.0")
  const tx = await txOf('MLB_TXN', 'FIX-PTBNL')
  const k = await h.one(db, 'select id from trade_packages where transaction_id = $1 and from_organization_id = (select id from organizations where franchise_key = $2)', [tx, 'HOU'])
  const s = Number((await h.one(db, "select id from sources where source_key = 't:club'")).id)
  const ins = "insert into organization_value_attributions (organization_id, value_class, trade_package_id, war_observation_id, source_id) values ($1, 'PACKAGE_ATTRIBUTABLE', $2, $3, $4)"
  await db.query(ins, [w.organization_id, k.id, w.id, s])
  await h.rejects(db, ins, [w.organization_id, k.id, w.id, s], /value_attribution_no_double_count/)
  // the named player is already part of the package: adding him as a direct asset is refused by the existing unique index
  await h.rejects(db, "insert into trade_package_assets (trade_package_id, asset_type, player_id) values ($1, 'PLAYER', $2)", [k.id, w.player_id], /counted once/)
  // and a resolution naming a player the package already carries is refused by the database
  const dup = Number((await h.one(db, "insert into trade_package_assets (trade_package_id, asset_type, description) values ($1, 'PLAYER_TO_BE_NAMED', 'second ptbnl') returning id", [k.id])).id)
  await h.rejects(db, "insert into ptbnl_resolutions (trade_package_asset_id, resolution, resolved_player_id, resolved_on, source_id) values ($1, 'PLAYER', $2, '2032-02-01', $3)", [dup, w.player_id, s], /counted once/)
  await db.query('delete from trade_package_assets where id = $1', [dup])
  await db.query('delete from organization_value_attributions')
})

test('a PTBNL resolved to cash or to nobody is recorded without a player; resolution applies only to a PTBNL asset', async () => {
  const k = await h.one(db, "select k.id pid, a.id aid from trade_packages k join trade_package_assets a on a.trade_package_id = k.id where a.asset_type = 'CASH' limit 1")
  const s = Number((await h.one(db, "select id from sources where source_key = 't:club'")).id)
  await h.rejects(db, "insert into ptbnl_resolutions (trade_package_asset_id, resolution, resolved_on, source_id) values ($1, 'NOTHING', '2032-03-01', $2)", [k.aid, s], /only a player-to-be-named asset/)
  await h.rejects(db, "insert into ptbnl_resolutions (trade_package_asset_id, resolution, resolved_on, source_id) select a.id, 'CASH', '2032-03-01', $1 from trade_package_assets a where a.asset_type = 'PLAYER_TO_BE_NAMED' limit 1", [s], /check/)
  const c = await run(mk('t-ptbnl-cash', [rec('p2', '2031-08-02', [pk('SF', 'SD', [pl(90)], [{ asset_type: 'PLAYER_TO_BE_NAMED', description: 'PTBNL', resolution: { kind: 'CASH', amount_disclosure: 'UNDISCLOSED', resolved_on: '2031-12-01', source_key: 't:wire' } }]), pk('SD', 'SF', [pl(91)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-PTBNL-CASH' }] })]))
  assert.deepEqual(c.report.actions, { INSERT: 1 })
  assert.deepEqual(await h.one(db, "select resolution, resolved_player_id, amount_usd, amount_disclosure from ptbnl_resolutions where resolved_on = '2031-12-01'"), { resolution: 'CASH', resolved_player_id: null, amount_usd: null, amount_disclosure: 'UNDISCLOSED' })
})

// ---------------------------------------------------------------------------------------------------------------
// Atomic import
// ---------------------------------------------------------------------------------------------------------------

test('atomic import: a database refusal in the second record rolls back the first, the ledger and the batch status', async () => {
  const good = rec('a1', '2031-12-05', [pk('WSH', 'ATL', [pl(100)]), pk('ATL', 'WSH', [pl(101)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-ATOM-1' }] })
  // names, as a PTBNL, a player the same package already carries: valid in shape, refused by the database when applied
  const poison = rec('a2', '2031-08-01', [pk('HOU', 'TEX', [], [{ asset_type: 'PLAYER_TO_BE_NAMED', description: 'poisoned ptbnl', resolution: { kind: 'PLAYER', player: pl(80), resolved_on: '2032-02-01', source_key: 't:wire' } }])],
    { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-PTBNL' }] })
  const s = await stage(mk('t-atomic', [good, poison]))
  assert.ok(s.validation.ok, JSON.stringify(s.validation.counts))
  const before = await counts()
  await assert.rejects(P.applyBatch(db, s.batch.id, { write: true }), /counted once/)
  assert.deepEqual(await counts(), before)
  assert.notEqual((await h.one(db, 'select status from ingest.import_batches where id = $1', [s.batch.id])).status, 'APPLIED')
  assert.equal((await h.one(db, "select count(*)::int n from transaction_external_ids where external_id = 'FIX-ATOM-1'")).n, 0)
})

// ---------------------------------------------------------------------------------------------------------------
// Authenticated human verification and automatic invalidation
// ---------------------------------------------------------------------------------------------------------------

const V = () => rec('v1', '2031-08-10', [pk('CLE', 'DET', [pl(110)], [{ asset_type: 'CASH', description: 'cash', amount_disclosure: 'UNDISCLOSED' }]), pk('DET', 'CLE', [pl(111)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-VERIFY' }] })
const BASIS = 'checked both sources against each asset'
const INDEP = 'club release and a separately reported wire story'

test('verification is human-only: closed gate, owner session, automation login and direct inserts are all refused', async () => {
  await run(mk('t-verify', [V()]))
  const tx = await txOf('MLB_TXN', 'FIX-VERIFY')
  assert.deepEqual((await status(tx)).gaps, [])
  await rv.query("select * from research.enroll_reviewer('Txn Reviewer')")
  await assert.rejects(rv.query('select * from research.verify_transaction($1, $2, $3)', [tx, BASIS, INDEP]), /verification is disabled \(research\.certification_gate\)/)
  await rv.query("select * from research.set_certification_gate(true, 'phase 16 test')")
  await assert.rejects(db.query('select * from research.verify_transaction($1, $2, $3)', [tx, BASIS, INDEP]), /not an enrolled, active human reviewer/)
  await assert.rejects(bot.query('select * from research.verify_transaction($1, $2, $3)', [tx, BASIS, INDEP]), /permission denied for function/)
  const direct = "insert into research.transaction_verifications (transaction_id, verified_by, content_fingerprint, basis_note, independence_note) values ($1, 'Txn Reviewer', 'deadbeef', $2, $3)"
  await assert.rejects(bot.query(direct, [tx, BASIS, INDEP]), /needs an enrolled human reviewer in their own authenticated session/)
  await assert.rejects(db.query(direct, [tx, BASIS, INDEP]), /needs an enrolled human reviewer in their own authenticated session/)
  assert.equal((await status(tx)).completeness, 'PARTIAL')
  // an automation login with data privileges can still write the records (the revoking triggers fire for it) but never verify
  const probe = await txOf('MLB_TXN', 'FIX-PTBNL-CASH')
  await bot.query('update public.transactions set description = description where id = $1', [probe])
  await bot.query("insert into public.transaction_conflicts (transaction_id, field_path, incoming_sha256) values ($1, 'probe', 'probe')", [probe])
})

test('a record with gaps cannot be verified: every reason is named, including a single independence group', async () => {
  const tx = await txOf('MLB_TXN', 'FIX-PTBNL-CASH')
  // add a PTBNL with no resolution and a cash asset of unknown amount to a fresh trade, and a one-group trade
  const oneGroup = rec('g1', '2031-08-11', [pk('ATH', 'LAA', [pl(120)]), pk('LAA', 'ATH', [pl(121)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-ONEGROUP' }], sources: [GROUPS[0], { ...GROUPS[1], independence_group: 'club-release-a' }] })
  await run(mk('t-onegroup', [oneGroup]))
  const g = await txOf('MLB_TXN', 'FIX-ONEGROUP')
  assert.deepEqual((await status(g)).gaps, ['ASSET_NOT_CORROBORATED', 'FEWER_THAN_TWO_INDEPENDENT_SOURCES', 'PACKAGE_NOT_CORROBORATED'])
  await assert.rejects(rv.query('select * from research.verify_transaction($1, $2, $3)', [g, BASIS, INDEP]), /cannot be verified complete: ASSET_NOT_CORROBORATED, FEWER_THAN_TWO_INDEPENDENT_SOURCES, PACKAGE_NOT_CORROBORATED/)
  const pending = await txOf('MLB_TXN', 'FIX-CASH-U')
  void tx; void pending
  const unresolved = await h.one(db, "select count(*)::int n from analytics.transaction_completeness where gaps <> '{}'")
  assert.ok(unresolved.n >= 2)
  const noPrimary = rec('g2', '2031-08-12', [pk('NYM', 'PHI', [pl(130)]), pk('PHI', 'NYM', [pl(131)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-NOPRIMARY' }], sources: [{ ...GROUPS[0], role: 'CORROBORATION' }, GROUPS[1]] })
  await run(mk('t-noprimary', [noPrimary]))
  assert.deepEqual((await status(await txOf('MLB_TXN', 'FIX-NOPRIMARY'))).gaps, ['NO_PRIMARY_ANNOUNCEMENT'])
})

test('a reviewer verifies; the verification is immutable; replay does not disturb it; any change revokes it automatically', async () => {
  const tx = await txOf('MLB_TXN', 'FIX-VERIFY')
  const r = (await rv.query('select * from research.verify_transaction($1, $2, $3)', [tx, BASIS, INDEP])).rows[0]
  assert.equal(r.verified_by, 'Txn Reviewer')
  assert.equal(r.verified_session_role, 'txn_reviewer')
  assert.deepEqual(await status(tx), { completeness: 'VERIFIED_COMPLETE', gaps: [], groups: 2, verified_by: 'Txn Reviewer', verification_stale: false })
  await assert.rejects(db.query("update research.transaction_verifications set basis_note = 'rewritten basis text' where id = $1", [r.id]), /immutable except for its revocation/)
  await assert.rejects(db.query('delete from research.transaction_verifications where id = $1', [r.id]), /revoked, never deleted/)
  await assert.rejects(db.query('truncate research.transaction_verifications'), /append-only|append only|never/i)
  // replaying the same content writes nothing, so the verification stands
  assert.deepEqual((await run(mk('t-verify-replay', [V()]))).report.actions, { NO_CHANGE: 1 })
  assert.equal((await status(tx)).completeness, 'VERIFIED_COMPLETE')
  // a new source for the same trade is a change to what was verified
  const more = V(); more.sources = [...GROUPS, { source_key: 't:bref', role: 'REFERENCE', independence_group: 'reference-c' }]
  assert.deepEqual((await run(mk('t-verify-change', [more]))).report.actions, { UPDATE_UNKNOWN: 1 })
  const v = await h.one(db, 'select state, revoked_by, revoked_automatically, revoked_reason from research.transaction_verifications where id = $1', [r.id])
  assert.equal(v.state, 'REVOKED'); assert.equal(v.revoked_by, 'system:evidence-changed'); assert.equal(v.revoked_automatically, true)
  assert.match(v.revoked_reason, /insert on transaction_sources changed a verified transaction/)
  const s = await status(tx)
  assert.deepEqual([s.completeness, s.verified_by], ['PARTIAL', null])
  await assert.rejects(db.query("update research.transaction_verifications set state = 'ACTIVE', revoked_at = null, revoked_by = null, revoked_reason = null where id = $1", [r.id]), /revocation is final|check constraint|violates/)
})

test('re-verification, human revocation, and a stale verification (triggers bypassed by the owner) all read as incomplete', async () => {
  const tx = await txOf('MLB_TXN', 'FIX-VERIFY')
  // direct edits of any kind, from any session, revoke: change a cash asset's disclosure through a plain UPDATE after re-verifying
  await rv.query('select * from research.verify_transaction($1, $2, $3)', [tx, BASIS, INDEP])
  assert.equal((await status(tx)).completeness, 'VERIFIED_COMPLETE')
  await db.query("update transactions set description = 'edited after verification' where id = $1", [tx])
  assert.equal((await status(tx)).completeness, 'PARTIAL')
  assert.equal((await h.one(db, "select count(*)::int n from research.transaction_verifications where transaction_id = $1 and revoked_automatically", [tx])).n, 2)
  // the reviewer revokes by hand, with a reason
  await rv.query('select * from research.verify_transaction($1, $2, $3)', [tx, BASIS, INDEP])
  const rev = (await rv.query('select * from research.revoke_transaction_verification($1, $2)', [tx, 'found a mistake in the second source'])).rows[0]
  assert.deepEqual([rev.state, rev.revoked_by, rev.revoked_automatically], ['REVOKED', 'Txn Reviewer', false])
  await assert.rejects(db.query('select * from research.revoke_transaction_verification($1, $2)', [tx, 'owner tries']), /not an enrolled, active human reviewer/)
  // defense in depth: with the revoking triggers switched off (owner privilege), the fingerprint still exposes the edit
  await rv.query('select * from research.verify_transaction($1, $2, $3)', [tx, BASIS, INDEP])
  await db.query('alter table public.trade_package_assets disable trigger user')
  await db.query("update trade_package_assets set description = 'quietly edited' where description = 'cash' and trade_package_id in (select id from trade_packages where transaction_id = $1)", [tx])
  await db.query('alter table public.trade_package_assets enable trigger user')
  const s = await status(tx)
  assert.deepEqual([s.completeness, s.verification_stale], ['PARTIAL', true])
  await rv.query('select * from research.revoke_transaction_verification($1, $2)', [tx, 'edited behind the triggers'])
})

test('open conflicts block verification and are resolved only by a human', async () => {
  const tx = await txOf('MLB_TXN', 'FIX-0001')
  const open = await h.rows(db, "select id from transaction_conflicts where transaction_id = $1 and status = 'OPEN' order by id", [tx])
  assert.equal(open.length, 3)
  await assert.rejects(db.query("update transaction_conflicts set status = 'RESOLVED', resolved_by = 'owner', resolved_at = now(), resolution_note = 'x' where id = $1", [open[0].id]), /resolved by an enrolled human reviewer/)
  await assert.rejects(bot.query("update public.transaction_conflicts set status = 'RESOLVED', resolved_by = 'Txn Reviewer', resolved_at = now(), resolution_note = 'x' where id = $1", [open[0].id]), /resolved by an enrolled human reviewer/)
  for (const o of open) {
    const c = (await rv.query('select * from research.resolve_transaction_conflict($1, $2)', [o.id, 'kept the canonical value after reading both sources'])).rows[0]
    assert.deepEqual([c.status, c.resolved_by], ['RESOLVED', 'Txn Reviewer'])
  }
  assert.ok(!(await status(tx)).gaps.includes('OPEN_CONFLICT'))
  await assert.rejects(rv.query("update public.transaction_conflicts set resolution_note = 'rewritten' where id = $1", [open[0].id]), /permission denied/)
})

// ---------------------------------------------------------------------------------------------------------------
// Calendar and preview
// ---------------------------------------------------------------------------------------------------------------

test('trade-deadline calendar: window membership is unknown, never false, without the calendar or a day-precise date', async () => {
  const s = Number((await h.one(db, "select id from sources where source_key = 't:club'")).id)
  const ctx = async (date) => h.one(db, "select in_deadline_window w, days_before_deadline d, trade_deadline::text dl from analytics.transaction_deadline_context c join transactions t on t.id = c.transaction_id where t.transaction_date = $1 limit 1", [date])
  assert.deepEqual(await ctx('2031-07-20'), { w: null, d: null, dl: null }, 'no calendar yet: unknown')
  await db.query("insert into season_calendar_events (season, event_type, event_date, source_id, notes) values (2031, 'ALL_STAR_GAME', '2031-07-15', $1, 'fictional'), (2031, 'TRADE_DEADLINE', '2031-08-01', $1, 'fictional')", [s])
  assert.deepEqual(await ctx('2031-07-20'), { w: true, d: 12, dl: '2031-08-01' })
  assert.deepEqual(await ctx('2031-08-01'), { w: true, d: 0, dl: '2031-08-01' }, 'deadline day is inside the window')
  assert.deepEqual(await ctx('2031-08-05'), { w: false, d: -4, dl: '2031-08-01' })
  assert.deepEqual(await ctx('2031-09-01'), { w: false, d: -31, dl: '2031-08-01' })
  await h.rejects(db, "insert into season_calendar_events (season, event_type, event_date, source_id) values (2032, 'TRADE_DEADLINE', '2031-08-01', $1)", [s], /check/)
  await h.rejects(db, "insert into season_calendar_events (season, event_type, event_date, source_id) values (2031, 'TRADE_DEADLINE', '2031-08-02', $1)", [s], /duplicate key|unique/)
  await h.rejects(db, "insert into season_calendar_events (season, event_type, event_date) values (2033, 'TRADE_DEADLINE', '2033-08-01')", [], /source_id|null value/)
  await db.query("update transactions set date_precision = 'MONTH' where id = (select transaction_id from transaction_external_ids where external_id = 'FIX-0004')")
  assert.deepEqual(await h.one(db, "select in_deadline_window w from analytics.transaction_deadline_context c join transaction_external_ids x on x.transaction_id = c.transaction_id where x.external_id = 'FIX-0004'"), { w: null })
  await db.query("update transactions set date_precision = 'DAY' where id = (select transaction_id from transaction_external_ids where external_id = 'FIX-0004')")
})

test('preview is read-only and exact: NEW, EXISTING, COLLISION and CONFLICT per record', async () => {
  const identityInput = (p) => ({ full_name: p.full_name, birth_date: p.birth_date ?? null, birth_country: p.birth_country ?? null, external_ids: p.external_ids ?? {} })
  const fresh = rec('pv1', '2032-02-02', [pk('BOS', 'NYY', [pl(140)]), pk('NYY', 'BOS', [pl(141)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-PV1' }] })
  const collide = rec('pv2', '2031-07-20', [pk('LAD', 'BAL', [pl(142)]), pk('BAL', 'LAD', [pl(143)])], { external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-PV2' }] })
  const moved = T1(); moved.date = '2031-07-23'; moved.ref = 't1-moved'
  const doc = mk('t-preview', [fresh, T1(), collide, moved])
  const before = await counts()
  await db.query('begin read only')
  let rows
  try { rows = await T.previewTrades(db, doc, { identityInput }) } finally { await db.query('rollback') }
  assert.deepEqual(rows.map((r) => [r.ref, r.kind]).sort(), [['pv1', 'NEW'], ['pv2', 'COLLISION'], ['t1', 'EXISTING'], ['t1-moved', 'CONFLICT']])
  assert.deepEqual(rows.find((r) => r.ref === 'pv1').new_players.sort(), ['9880140', '9880141'])
  assert.deepEqual(await counts(), before, 'preview wrote nothing (a read-only transaction would have refused)')
  const same = await T.previewTrades(db, mk('t-preview2', [T1()]), { identityInput })
  assert.equal(same[0].kind, 'EXISTING')
})

test('source permissions: a batch citing a source without a publication grant is refused for a hosted database, whatever its shape', async () => {
  const hosted = { host: 'db.projectref000000000000.supabase.co' }
  const doc = { sources: [{ source_key: 'x:mlb', source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: 'MLB transactions', url: 'https://statsapi.mlb.com/api/v1/transactions', retrieved_date: '2031-01-01' }],
    coverage_claims: [], records: [{ type: 'TRADE', schema: 2, source_key: 'x:mlb', date: '2031-01-01', packages: [] }] }
  assert.throws(() => P.requirePublishable(hosted, doc), /publish_site|permission|PENDING|not permitted|refus/i)
  assert.equal(P.requirePublishable({ host: '127.0.0.1' }, doc), null, 'local databases are not gated')
})
