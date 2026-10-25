// The later-added-assets PROPOSAL (docs/transactions/later-added/proposed-031-later-added-assets.sql) applied to a disposable database at 029:
// it must change nothing while its tables are empty, keep PTBNL resolutions, additions and amendments distinguishable, count an added player once
// from the day he was added, refuse contradictions, and move the verification fingerprint. FICTIONAL data. The proposal is not a migration.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as T from '../../scripts/research/lib/transactions.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const proposal = fs.readFileSync(path.join(root, 'docs/transactions/later-added/proposed-031-later-added-assets.sql'), 'utf8')
let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-later-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const src = (key, a = 'OFFICIAL') => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: a, title: `Later fixture ${key}` })
const pl = (n, name) => ({ full_name: name ?? `Later Player ${n}`, external_ids: { MLBAM: String(9880000 + n) } })
const GROUPS = [{ source_key: 'l:a', role: 'REFERENCE', independence_group: 'fixture-a' }]
const pk = (from, to, players, others = []) => ({ from, to, source_keys: ['l:a'], players: players.map((p) => ({ player: p, source_keys: ['l:a'] })), other_assets: others.map((o) => ({ source_keys: ['l:a'], ...o })) })
let n = 0
async function trade (ref, date, packages, ext) {
  const doc = T.prepareTradeDoc({ format: 'bai-research-import/1', batch_key: `l-${ref}`, channel: 'TRADES', sources: [src('l:a'), src('l:bref', 'AGGREGATOR')],
    records: [{ type: 'TRADE', schema: 2, ref, organization: packages[0].from, date, source_key: 'l:a', sources: GROUPS, external_ids: [{ scheme: 'MLB_TXN', id: ext }], packages }] })
  const f = path.join(dir, `b-${++n}.json`); fs.writeFileSync(f, JSON.stringify(doc))
  const { batch } = await P.stageFile(db, f, {}); assert.ok((await P.validateBatch(db, batch.id)).ok)
  await P.applyBatch(db, batch.id, { write: true })
  return Number((await h.one(db, 'select transaction_id id from transaction_external_ids where external_id = $1', [ext])).id)
}
const views = async () => ({ tr: await h.rows(db, 'select to_jsonb(x)::text j from analytics.trade_returns x order by 1'), av: await h.rows(db, 'select to_jsonb(x)::text j from analytics.acquisition_value x order by 1'), cv: await h.rows(db, 'select to_jsonb(x)::text j from analytics.class_value x order by 1') })
const pid = async (m) => Number((await h.one(db, "select player_id id from player_external_ids where id_system = 'MLBAM' and external_id = $1", [String(9880000 + m)])).id)
const pkg = async (tx, from) => Number((await h.one(db, 'select k.id from trade_packages k join organizations o on o.id = k.from_organization_id where k.transaction_id = $1 and o.franchise_key = $2', [tx, from])).id)
let txA, txB, p3, before0

test('setup: a two-club trade, a trade with a PTBNL named later (028 semantics), and a player who will be added later', async () => {
  txA = await trade('la', '2030-06-01', [pk('LAD', 'SEA', [pl(1)]), pk('SEA', 'LAD', [pl(2)])], 'LA-1')
  txB = await trade('lb', '2030-06-10', [pk('HOU', 'TEX', [pl(10)], [{ asset_type: 'PLAYER_TO_BE_NAMED', description: 'ptbnl', condition_text: 'later',
    resolution: { kind: 'PLAYER', player: pl(11), resolved_on: '2030-09-01', source_key: 'l:a' } }]), pk('TEX', 'HOU', [pl(12)])], 'LB-1')
  const a = Number((await h.one(db, "select id from sources where source_key = 'l:a'")).id)
  const bref = Number((await h.one(db, "select id from sources where source_key = 'l:bref'")).id)
  p3 = Number((await h.one(db, "insert into players (slug, full_name, display_name) values ('later-player-3', 'Later Player 3', 'Later Player 3') returning id")).id)
  await db.query("insert into player_external_ids (player_id, id_system, external_id, source_id) values ($1, 'MLBAM', '9880003', $2)", [p3, a])
  const lad = Number((await h.one(db, "select id from organizations where franchise_key = 'LAD'")).id)
  for (const [season, v] of [[2030, 9], [2031, 2], [2032, 1]]) {
    await db.query("insert into war_observations (player_id, war_system, scope, season, organization_id, through_season, war_value, observed_on, source_id) values ($1, 'BREF', 'SEASON', $2, $3, 2032, $4, '2032-11-01', $5)", [p3, season, lad, v, bref])
  }
  before0 = await views()
  assert.ok(before0.tr.length >= 4)
})

test('applying the proposal changes no existing view row while its tables are empty', async () => {
  await db.query(proposal)
  assert.deepEqual(await views(), before0)
  assert.deepEqual((await h.rows(db, 'select count(*)::int n from trade_asset_additions union all select count(*)::int from transaction_amendments')).map((r) => r.n), [0, 0])
})

test('guards: an addition cannot predate the trade, repeat an original or PTBNL-named player, or repeat itself', async () => {
  const ladPkg = await pkg(txA, 'SEA'); const texPkg = await pkg(txB, 'HOU')
  const a = Number((await h.one(db, "select id from sources where source_key = 'l:a'")).id)
  const ins = "insert into trade_asset_additions (trade_package_id, player_id, addition_kind, added_on, source_id) values ($1, $2, $3, $4, $5)"
  await h.rejects(db, ins, [ladPkg, p3, 'ADDED_LATER_UNSTATED', '2030-05-31', a], /before the trade/)
  await h.rejects(db, ins, [ladPkg, await pid(2), 'ADDED_LATER_UNSTATED', '2030-07-01', a], /already part of this package/)
  await h.rejects(db, ins, [texPkg, await pid(11), 'ADDED_TO_TRADE', '2030-10-01', a], /already part of this package/)
  await h.rejects(db, ins, [ladPkg, p3, 'WHATEVER', '2030-07-01', a], /check/)
})

test('an added player is counted once, from the day he was added, and the PTBNL record is untouched', async () => {
  const fpBefore = (await h.one(db, 'select research.transaction_fingerprint($1) f', [txA])).f
  const a = Number((await h.one(db, "select id from sources where source_key = 'l:a'")).id)
  const k = await pkg(txA, 'SEA')
  await db.query("insert into trade_asset_additions (trade_package_id, player_id, addition_kind, added_on, source_id, locator) values ($1, $2, 'ADDED_LATER_UNSTATED', '2031-01-15', $3, 'row 3')", [k, p3, a])
  await h.rejects(db, "insert into trade_asset_additions (trade_package_id, player_id, addition_kind, added_on, source_id) values ($1, $2, 'ADDED_TO_TRADE', '2031-02-01', $3)", [k, p3, a], /duplicate key|unique/)
  const lad = "(select id from organizations where franchise_key = 'LAD')"
  const r = await h.one(db, `select return_war_known::float8 w, received_player_ids ids from analytics.trade_returns where war_system = 'BREF' and transaction_id = $1 and organization_id = ${lad}`, [txA])
  assert.equal(r.w, 3, 'his 2031 and 2032 seasons for LAD; the 9.0 of 2030 came before he was added')
  assert.equal(r.ids.length, 2)
  assert.ok(r.ids.map(String).includes(String(p3)))
  const sent = await h.one(db, `select sent_player_ids ids from analytics.trade_returns where war_system = 'BREF' and transaction_id = $1 and organization_id = (select id from organizations where franchise_key = 'SEA')`, [txA])
  assert.ok(sent.ids.map(String).includes(String(p3)), 'SEA is the club that sent him')
  const after = await views()
  const untouched = (rows) => rows.filter((j) => JSON.parse(j.j).transaction_id !== txA).map((x) => x.j)
  assert.deepEqual(untouched(after.tr), untouched(before0.tr), 'every other transaction is unchanged')
  assert.notEqual((await h.one(db, 'select research.transaction_fingerprint($1) f', [txA])).f, fpBefore, 'the verification fingerprint covers additions')
  const kinds = await h.rows(db, `select via_ptbnl, via_addition, count(*)::int n from analytics.trade_asset_players where player_id is not null and (via_ptbnl or via_addition) group by 1, 2 order by 1, 2`)
  assert.deepEqual(kinds, [{ via_ptbnl: false, via_addition: true, n: 1 }, { via_ptbnl: true, via_addition: false, n: 1 }], 'a PTBNL resolution and an addition are different things')
})

test('amendments: a condition applies only to a conditional asset of the same transaction, and never predates it', async () => {
  const a = Number((await h.one(db, "select id from sources where source_key = 'l:a'")).id)
  const ptbnl = Number((await h.one(db, `select x.id from trade_package_assets x join trade_packages k on k.id = x.trade_package_id where k.transaction_id = $1 and x.asset_type = 'PLAYER_TO_BE_NAMED'`, [txB])).id)
  const original = Number((await h.one(db, `select x.id from trade_package_assets x join trade_packages k on k.id = x.trade_package_id where k.transaction_id = $1 and x.asset_type = 'PLAYER' limit 1`, [txB])).id)
  const ins = 'insert into transaction_amendments (transaction_id, amendment_kind, effective_on, trade_package_asset_id, source_id) values ($1, $2, $3, $4, $5)'
  const fpBefore = (await h.one(db, 'select research.transaction_fingerprint($1) f', [txB])).f
  await db.query(ins, [txB, 'CONDITION_MET', '2030-09-01', ptbnl, a])
  await h.rejects(db, ins, [txB, 'CONDITION_MET', '2030-09-01', original, a], /only a conditional asset/)
  await h.rejects(db, ins, [txA, 'CONDITION_MET', '2030-09-01', ptbnl, a], /belongs to another transaction/)
  await h.rejects(db, ins, [txB, 'CONDITION_NOT_MET', '2030-09-01', null, a], /check/)
  await h.rejects(db, ins, [txB, 'TRADE_VOIDED', '2030-06-01', null, a], /predate the transaction/)
  await db.query(ins, [txB, 'TRADE_VOIDED', '2030-12-01', null, a])
  assert.notEqual((await h.one(db, 'select research.transaction_fingerprint($1) f', [txB])).f, fpBefore, 'the fingerprint covers amendments')
  assert.equal((await h.one(db, 'select count(*)::int n from ptbnl_resolutions')).n, 1, 'the existing PTBNL resolution is not reinterpreted')
})

test('the new tables are internal: RLS on, closed to public roles', async () => {
  for (const t of ['trade_asset_additions', 'transaction_amendments']) {
    assert.equal((await h.one(db, 'select relrowsecurity r from pg_class where oid = $1::regclass', [`public.${t}`])).r, true)
    for (const role of ['anon', 'authenticated']) await assert.rejects(h.asRole(db, role, () => db.query(`select 1 from ${t}`)), /permission denied/)
  }
})
