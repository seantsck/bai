// The public transaction read model (migration 030): three separate states (a source licensed for display, a transaction VERIFIED_COMPLETE, a club-season
// COMPLETE_CENSUS), refresh-time authorization of every cited source, no internal or reviewer detail, anon boundary. FICTIONAL data throughout.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as T from '../../scripts/research/lib/transactions.mjs'
import * as R from '../../scripts/research/lib/retrosheet-transactions.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let db, rv
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-rm-'))
before(async () => { await h.startServer(); db = await h.freshDatabase(); rv = await h.login(db, 'rm_reviewer', { reviewer: true }) }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const RETRO = { source_key: 'hist:retrosheet-0123456789', source_type: 'REFERENCE_DATABASE', authority_level: 'REPUTABLE_SECONDARY', title: 'Retrosheet transactions database (fixture)', publisher: 'Retrosheet', url: 'https://www.retrosheet.org/transactions/tranDB.zip', retrieved_date: '2026-10-22' }
const MLB = { source_key: 'rm:mlb', source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: 'MLB transactions (fixture)', publisher: 'MLB Advanced Media', url: 'https://statsapi.mlb.com/api/v1/transactions', retrieved_date: '2026-10-22' }
const BREF = { source_key: 'rm:bref', source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Baseball-Reference WAR (fixture)', publisher: 'Sports Reference', url: 'https://www.baseball-reference.com/', retrieved_date: '2026-10-22' }
// an openly licensed group (Wikipedia, facts with a revision id) as the independent second source, so the corroborated trade is displayable
const SECOND = { source_key: 'hist:wikipedia-2030-fixture-r1', source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Wikipedia: fixture, revision 1', publisher: 'Wikimedia Foundation (contributors)', url: 'https://en.wikipedia.org/w/index.php?title=Fixture&oldid=1', retrieved_date: '2026-10-22' }
const pl = (n, name) => ({ full_name: name ?? `Model Player ${n}`, external_ids: { MLBAM: String(9890000 + n) } })
const pk = (from, to, players, keys, others = []) => ({ from, to, source_keys: keys, players: players.map((p) => ({ player: p, source_keys: keys })), other_assets: others.map((o) => ({ source_keys: keys, ...o })) })
let n = 0
async function trade (ref, date, sourceDecls, packages, ext, groups) {
  const doc = T.prepareTradeDoc({ format: 'bai-research-import/1', batch_key: `m-${ref}`, channel: 'TRADES', sources: sourceDecls, records: [{ type: 'TRADE', schema: 2, ref, organization: packages[0].from, date, source_key: groups[0].source_key, sources: groups, packages, external_ids: [{ scheme: 'MLB_TXN', id: ext }] }] })
  const f = path.join(dir, `b-${++n}.json`); fs.writeFileSync(f, JSON.stringify(doc))
  const { batch } = await P.stageFile(db, f, {}); assert.ok((await P.validateBatch(db, batch.id)).ok)
  await P.applyBatch(db, batch.id, { write: true })
  return Number((await h.one(db, 'select transaction_id id from transaction_external_ids where external_id = $1', [ext])).id)
}
const rg = (k) => ({ source_key: k, role: 'REFERENCE', independence_group: `g-${k}` })
const refresh = () => db.query('select public.refresh_transaction_read_models() g')
const rm = (sql, p) => h.rows(db, sql, p)
let txRetro, txMixed, txMlb, txVerified

test('setup: Retrosheet-sourced trade and signing, an MLB-sourced trade, a mixed-source trade, and a fully corroborated trade', async () => {
  txRetro = await trade('r1', '2030-06-01', [RETRO], [pk('LAD', 'SEA', [pl(1)], [RETRO.source_key], [{ asset_type: 'CASH', description: 'cash', amount_disclosure: 'UNKNOWN' }, { asset_type: 'PLAYER_TO_BE_NAMED', description: 'ptbnl' }]), pk('SEA', 'LAD', [pl(2)], [RETRO.source_key])], 'RM-1', [rg(RETRO.source_key)])
  txMlb = await trade('m1', '2030-06-02', [MLB], [pk('HOU', 'TEX', [pl(3)], [MLB.source_key]), pk('TEX', 'HOU', [pl(4)], [MLB.source_key])], 'RM-2', [rg(MLB.source_key)])
  txMixed = await trade('x1', '2030-06-03', [RETRO, MLB], [pk('NYY', 'BOS', [pl(5)], [RETRO.source_key, MLB.source_key]), pk('BOS', 'NYY', [pl(6)], [RETRO.source_key, MLB.source_key])], 'RM-3',
    [{ source_key: RETRO.source_key, role: 'REFERENCE', independence_group: 'g-retro' }, { source_key: MLB.source_key, role: 'PRIMARY_ANNOUNCEMENT', independence_group: 'g-mlb' }])
  txVerified = await trade('v1', '2030-06-04', [RETRO, SECOND], [pk('SD', 'SF', [pl(7)], [RETRO.source_key, SECOND.source_key]), pk('SF', 'SD', [pl(8)], [RETRO.source_key, SECOND.source_key])], 'RM-4',
    [{ source_key: RETRO.source_key, role: 'PRIMARY_ANNOUNCEMENT', independence_group: 'g-retro' }, { source_key: SECOND.source_key, role: 'CORROBORATION', independence_group: 'g-wire' }])
  assert.equal((await h.one(db, "select category from (select public.source_attribution_category(url, source_key, publisher, title, source_type) category from sources where source_key = $1) x", [RETRO.source_key])).category, 'RETROSHEET')
})

test('no grant, no display: the read model is empty, and says how many transactions it withholds', async () => {
  await refresh()
  assert.equal((await h.one(db, 'select count(*)::int n from rm_transactions')).n, 0)
  const o = await h.one(db, 'select * from rm_transaction_overview')
  // The count of withheld transactions must not disclose how many HELD transactions exist (032): the three that cite the unreleased Retrosheet source (the Retrosheet-only trade, the
  // mixed trade, the corroborated trade) are left out of it, and the MLB-only trade, which was never held by a release, is still counted as withheld for want of a grant.
  assert.equal((await h.one(db, 'select count(*)::int n from transactions')).n, 4, 'four transactions exist')
  const citing = (await rm("select distinct ts.transaction_id::text id from transaction_sources ts join sources s on s.id = ts.source_id where s.attribution_category = 'RETROSHEET' order by 1")).map((x) => Number(x.id)).sort((a, b) => a - b)
  assert.deepEqual(citing, [txRetro, txMixed, txVerified].sort((a, b) => a - b), 'exactly those three cite the held source')
  assert.deepEqual([o.transactions, o.withheld_unauthorized], [0, 1], 'HELD: 4 transactions, 3 held and not counted, 1 MLB-only withheld')
  assert.equal((await h.one(db, 'select withheld_unauthorized w from rm_transaction_refreshes order by generation_id desc limit 1')).w, 1, 'the refresh log says the same')
  assert.ok(!o.display_authorized_categories.includes('RETROSHEET') && !o.display_authorized_categories.includes('MLB'), 'only openly licensed groups before any grant')
  for (const t of ['rm_transaction_assets', 'rm_transaction_sources', 'rm_transaction_players', 'rm_transaction_returns', 'rm_transaction_coverage']) assert.equal((await h.one(db, `select count(*)::int n from ${t}`)).n, 0, t)
})

test('the grants table accepts the RETROSHEET category, and a person\'s grant (not code) opens display for exactly that source group', async () => {
  await db.query("insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('RETROSHEET', 'fixture: a person recorded the basis', 'fixture scope')")
  await h.releaseRetrosheet(db)
  await refresh()
  const t = await rm('select transaction_id, status, category, source_categories, attribution_required from rm_transactions order by transaction_id')
  assert.deepEqual(t.map((x) => Number(x.transaction_id)), [txRetro, txVerified], 'the MLB-sourced trade and the mixed trade stay withheld')
  assert.ok(t.every((x) => x.status === 'PARTIAL' && x.attribution_required && x.source_categories.includes('RETROSHEET')), 'licensed for display: PARTIAL, not verified')
  const o = await h.one(db, 'select * from rm_transaction_overview')
  assert.deepEqual([o.transactions, o.withheld_unauthorized, o.verified_complete], [2, 2, 0]); assert.ok(o.display_authorized_categories.includes('RETROSHEET') && !o.display_authorized_categories.includes('MLB'))
  assert.equal((await h.one(db, 'select count(*)::int n from rm_transactions where transaction_id = any ($1)', [[txMixed, txMlb]])).n, 0)
  assert.equal((await h.one(db, 'select withheld_unauthorized w from rm_transaction_refreshes order by generation_id desc limit 1')).w, 2, 'RELEASED: the MLB-only trade and the mixed trade (its MLB source has no grant) are withheld; the two Retrosheet trades are shown')
})

test('WITHDRAWN: deleting the release hides the Retrosheet transactions again at the commit, with no refresh, and the withheld count returns to what HELD says', async () => {
  await h.withdrawRetrosheet(db)    // no refresh follows
  assert.equal((await h.one(db, 'select count(*)::int n from rm_transactions')).n, 0)
  assert.equal((await h.one(db, 'select count(*)::int n from rm_transaction_overview')).n, 0, 'the withdrawal removes the cached overview, so no stale count (of shown or of withheld trades) can be read')
  await refresh()
  const o = await h.one(db, 'select * from rm_transaction_overview')
  assert.deepEqual([o.transactions, o.withheld_unauthorized, o.verified_complete], [0, 1, 0], 'and the next refresh counts only the MLB-only trade as withheld, as HELD does')
  for (const t of ['rm_transaction_assets', 'rm_transaction_sources', 'rm_transaction_players', 'rm_transaction_returns', 'rm_transaction_coverage']) assert.equal((await h.one(db, `select count(*)::int n from ${t}`)).n, 0, t)
  await h.releaseRetrosheet(db); await refresh()
  assert.deepEqual((await rm('select transaction_id from rm_transactions order by transaction_id')).map((x) => Number(x.transaction_id)), [txRetro, txVerified], 'released again: the same two are shown')
})

test('three separate states: licensed for display is not verified, and verified is not a complete census', async () => {
  const before = await h.one(db, "select status, gaps from rm_transactions where transaction_id = $1", [txVerified])
  assert.equal(before.status, 'PARTIAL'); assert.ok(before.gaps.includes('FEWER_THAN_TWO_INDEPENDENT_SOURCES') === false, 'two groups exist, so the gap is a link or human gap, not a licence gap')
  // links for every package and asset by both groups, then a human verification
  const sources = await rm('select id, source_id from transaction_sources where transaction_id = $1', [txVerified])
  for (const s of sources) {
    await db.query('insert into transaction_source_links (transaction_source_id, trade_package_id) select $1, id from trade_packages where transaction_id = $2 on conflict do nothing', [s.id, txVerified])
    await db.query('insert into transaction_source_links (transaction_source_id, trade_package_asset_id) select $1, a.id from trade_package_assets a join trade_packages k on k.id = a.trade_package_id where k.transaction_id = $2 on conflict do nothing', [s.id, txVerified])
  }
  await rv.query("select * from research.enroll_reviewer('Model Reviewer')")
  await rv.query("select * from research.set_certification_gate(true, 'isolated test database')")
  await rv.query('select * from research.verify_transaction($1, $2, $3)', [txVerified, 'checked both sources against each asset', 'a reference record and a separately written wire report'])
  await refresh()
  const v = await h.one(db, 'select status, verified_on, gaps from rm_transactions where transaction_id = $1', [txVerified])
  assert.deepEqual([v.status, v.gaps], ['VERIFIED_COMPLETE', []]); assert.ok(v.verified_on)
  assert.equal((await h.one(db, 'select status from rm_transactions where transaction_id = $1', [txRetro])).status, 'PARTIAL', 'the other licensed transaction stays partial')
  assert.equal((await h.one(db, 'select verified_complete from rm_transaction_overview')).verified_complete, 1)
  assert.equal((await h.one(db, 'select complete_census_club_seasons from rm_transaction_overview')).complete_census_club_seasons, 0, 'a verified transaction is not a census')
  // any change revokes the verification; the next refresh shows PARTIAL again
  await db.query("update trade_package_assets set description = 'edited' where trade_package_id in (select id from trade_packages where transaction_id = $1) and asset_type = 'PLAYER' and false", [txVerified])
  await db.query("update transaction_sources set locator = 'p. 3' where transaction_id = $1 and role = 'CORROBORATION'", [txVerified])
  await refresh()
  assert.equal((await h.one(db, 'select status from rm_transactions where transaction_id = $1', [txVerified])).status, 'PARTIAL')
  assert.equal((await h.one(db, 'select count(*)::int n from rm_transactions where verified_on is not null')).n, 0)
})

test('a club-season COMPLETE_CENSUS is a separate fact from every transaction status', async () => {
  const org = (await h.one(db, "select id from organizations where franchise_key = 'LAD'")).id
  const src = (await h.one(db, "select id from sources where source_key = $1", [RETRO.source_key])).id
  await h.withdrawRetrosheet(db)   // a coverage row citing a released source is written with the release withdrawn, then the source is released again
  await db.query("insert into coverage_assessments (domain, scope_key, organization_id, coverage_state, tracked_count, expected_count, source_id, assessed_on) values ('TRANSACTIONS', '2030', $1, 'COMPLETE_CENSUS', 1, 1, $2, current_date)", [org, src])
  await h.releaseRetrosheet(db); await refresh()
  const cs = await rm("select club_key, coverage_state, expected_count from rm_transaction_club_seasons where season = 2030 order by club_key")
  assert.deepEqual(cs.find((x) => x.club_key === 'LAD'), { club_key: 'LAD', coverage_state: 'COMPLETE_CENSUS', expected_count: 1 })
  assert.ok(cs.filter((x) => x.club_key !== 'LAD').every((x) => x.coverage_state === 'NOT_ASSESSED'))
  assert.equal((await h.one(db, 'select status from rm_transactions where transaction_id = $1', [txRetro])).status, 'PARTIAL', 'a complete census does not make its transactions verified')
  await db.query("delete from coverage_assessments where domain::text = 'TRANSACTIONS'")
})

test('assets, unknowns, sources and later movement are shown as the database knows them', async () => {
  await refresh()
  const a = await rm('select from_key, to_key, asset_kind, player_name, amount_status, amount_usd, conditional, resolution_kind from rm_transaction_assets where transaction_id = $1 order by position', [txRetro])
  assert.ok(a.some((x) => x.asset_kind === 'CASH' && x.amount_status === 'UNKNOWN' && x.amount_usd === null), 'unknown cash is unknown, never zero')
  assert.ok(a.some((x) => x.asset_kind === 'PLAYER_TO_BE_NAMED' && x.conditional && x.resolution_kind === null), 'a PTBNL with no resolution is pending')
  assert.equal(a.filter((x) => x.asset_kind === 'PLAYER').length, 2)
  const t = await h.one(db, 'select has_unresolved_ptbnl, cash_unknown, gaps from rm_transactions where transaction_id = $1', [txRetro])
  assert.deepEqual([t.has_unresolved_ptbnl, t.cash_unknown], [true, true]); assert.ok(t.gaps.includes('PENDING_PTBNL') && t.gaps.includes('CASH_AMOUNT_UNKNOWN'))
  const s = await rm('select title, attribution_category, role, independence_group from rm_transaction_sources where transaction_id = $1 order by position', [txRetro])
  assert.ok(s.every((x) => x.attribution_category === 'RETROSHEET'))
  // a later transaction of the same player is established by the ledger itself
  await h.withdrawRetrosheet(db)   // a batch citing a released source is applied only with the release withdrawn; it is recorded again below
  const later = await trade('r2', '2030-09-01', [RETRO], [pk('SEA', 'NYY', [pl(2)], [RETRO.source_key]), pk('NYY', 'SEA', [pl(9)], [RETRO.source_key])], 'RM-5', [rg(RETRO.source_key)])
  await h.releaseRetrosheet(db); await refresh()
  const f = await rm('select later_transaction_id, step, later_club_keys from rm_transaction_followups where transaction_id = $1 and later_transaction_id = $2', [txRetro, later])
  assert.deepEqual(f.map((x) => [Number(x.later_transaction_id), x.step, x.later_club_keys]), [[later, 1, ['NYY', 'SEA']]])
})

test('performance figures are shown only where the provider\'s sources are authorized; evidence is never a score', async () => {
  const bref = (await db.query("insert into sources (source_key, source_type, authority_level, title, publisher, url, retrieved_date) values ($1, 'REFERENCE_DATABASE', 'AGGREGATOR', $2, $3, $4, '2026-10-22') returning id", [BREF.source_key, BREF.title, BREF.publisher, BREF.url])).rows[0].id
  const p = Number((await h.one(db, "select player_id id from player_external_ids where id_system = 'MLBAM' and external_id = '9890002'")).id)
  const lad = Number((await h.one(db, "select id from organizations where franchise_key = 'LAD'")).id)
  await db.query("insert into war_observations (player_id, war_system, scope, season, organization_id, through_season, war_value, observed_on, source_id) values ($1, 'BREF', 'SEASON', 2031, $2, 2031, 3.5, '2031-11-01', $3)", [p, lad, bref])
  await refresh()
  const withheld = await h.one(db, "select return_war_known, evidence from rm_transaction_returns where transaction_id = $1 and club_key = 'LAD' and provider = 'BREF'", [txRetro])
  assert.deepEqual([withheld.return_war_known, withheld.evidence], [null, 'WITHHELD_PERMISSION'])
  await db.query("insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('BASEBALL_REFERENCE', 'fixture', 'fixture')")
  await refresh()
  const shown = await h.one(db, "select return_war_known::float8 w, evidence from rm_transaction_returns where transaction_id = $1 and club_key = 'LAD' and provider = 'BREF'", [txRetro])
  assert.deepEqual([shown.w, shown.evidence], [3.5, 'OBSERVED_PARTIAL'])
  const cols = (await rm("select column_name c from information_schema.columns where table_schema = 'public' and table_name like 'rm_transaction%'")).map((x) => x.c)
  for (const c of cols) assert.doesNotMatch(c, /score|grade|rank|winner|verified_by|reviewer|notes|description/i, c)
})

test('the refresh is convergent and the public boundary holds: readable facts, no writes, no internals, no refresh', async () => {
  const hash = async () => (await h.one(db, `select md5(string_agg(x, '|' order by x)) m from (select (to_jsonb(t) - 'generation_id')::text x from rm_transactions t union all select a::text from rm_transaction_assets a union all select s::text from rm_transaction_sources s union all select r::text from rm_transaction_returns r union all select f::text from rm_transaction_followups f) q`)).m
  await refresh(); const a = await hash(); await refresh(); const b = await hash()
  assert.equal(a, b)
  for (const role of ['anon', 'authenticated']) {
    await h.asRole(db, role, async () => {
      assert.ok((await h.one(db, 'select count(*)::int n from rm_transactions')).n >= 2)
      assert.ok((await h.one(db, 'select count(*)::int n from source_attribution_statements')).n === 1)
    })
    for (const sql of ['select * from transaction_player_moves', 'select * from transaction_sources', 'select * from analytics.transaction_completeness', 'select * from research.transaction_verifications', 'select * from rm_transaction_refreshes',
      'select public.refresh_transaction_read_models()', 'insert into rm_transactions (transaction_id) values (1)', 'delete from rm_transactions', "update source_attribution_statements set statement = 'x'", 'select * from ingest.source_publication_grants']) {
      await assert.rejects(h.asRole(db, role, () => db.query(sql)), /permission denied/, `${role}: ${sql}`)
    }
  }
})

test('the Retrosheet attribution statement is the notice\'s, verbatim', async () => {
  const stored = (await h.one(db, "select statement, notice_url from source_attribution_statements where attribution_category = 'RETROSHEET'"))
  assert.equal(stored.statement, R.RETROSHEET_ATTRIBUTION)
  assert.equal(stored.notice_url, 'https://www.retrosheet.org/notice.txt')
  const cached = path.join(root, '.local/retrosheet/notice.txt')
  if (fs.existsSync(cached)) {
    const text = fs.readFileSync(cached, 'utf8').replace(/\s+/g, ' ')
    assert.ok(text.includes(R.RETROSHEET_ATTRIBUTION.replace(/\s+/g, ' ')), 'the official notice contains the statement')
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(cached)).digest('hex'), JSON.parse(fs.readFileSync(path.join(root, 'research/history/manifest.json'), 'utf8')).entries['retrosheet/notice.txt'].sha256)
  }
})
