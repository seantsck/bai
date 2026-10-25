// Phase 18 hardening of the public transaction read model (migration 030). FICTIONAL data throughout.
//   1. club-level performance is shown once per club and provider, never repeated per counterparty (the three-team primary-key collision);
//   2. a withdrawn publication grant, a revoked verification and a changed record leave nothing stale for anon or authenticated, before any refresh;
//   3. the raw transaction tables are not a second public door, while draft and international reads are unchanged.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as T from '../../scripts/research/lib/transactions.mjs'

let db, rv
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-rmh-'))
before(async () => { await h.startServer(); db = await h.freshDatabase(); rv = await h.login(db, 'rmh_reviewer', { reviewer: true }) }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const RETRO = { source_key: 'hist:retrosheet-0123456789', source_type: 'REFERENCE_DATABASE', authority_level: 'REPUTABLE_SECONDARY', title: 'Retrosheet transactions database (fixture)', publisher: 'Retrosheet', url: 'https://www.retrosheet.org/transactions/tran.txt', retrieved_date: '2026-10-22' }
const SECOND = { source_key: 'hist:wikipedia-2030-fixture-r1', source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Wikipedia: fixture, revision 1', publisher: 'Wikimedia Foundation (contributors)', url: 'https://en.wikipedia.org/w/index.php?title=Fixture&oldid=1', retrieved_date: '2026-10-22' }
const BREF = { source_key: 'rmh:bref', source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Baseball-Reference WAR (fixture)', publisher: 'Sports Reference', url: 'https://www.baseball-reference.com/', retrieved_date: '2026-10-22' }
const FG = { source_key: 'rmh:fg', source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'FanGraphs WAR (fixture)', publisher: 'FanGraphs', url: 'https://www.fangraphs.com/', retrieved_date: '2026-10-22' }
const pl = (n) => ({ full_name: `Hardening Player ${n}`, external_ids: { MLBAM: String(9880000 + n) } })
const pk = (from, to, players, keys) => ({ from, to, source_keys: keys, players: players.map((p) => ({ player: p, source_keys: keys })), other_assets: [] })
let n = 0
async function trade (ref, date, decls, packages, ext, groups) {
  const doc = T.prepareTradeDoc({ format: 'bai-research-import/1', batch_key: `h-${ref}`, channel: 'TRADES', sources: decls, records: [{ type: 'TRADE', schema: 2, ref, organization: packages[0].from, date, source_key: groups[0].source_key, sources: groups, packages, external_ids: [{ scheme: 'TEST', id: ext, source_key: groups[0].source_key }] }] })
  const f = path.join(dir, `b-${++n}.json`); fs.writeFileSync(f, JSON.stringify(doc))
  const { batch } = await P.stageFile(db, f, {}); assert.ok((await P.validateBatch(db, batch.id)).ok)
  await P.applyBatch(db, batch.id, { write: true })
  return Number((await h.one(db, "select transaction_id id from transaction_external_ids where external_id = $1", [ext])).id)
}
const rg = (k, group) => ({ source_key: k, role: 'REFERENCE', independence_group: group ?? `g-${k}` })
const refresh = () => db.query('select public.refresh_transaction_read_models() g')
const asBoth = async (fn) => { for (const role of ['anon', 'authenticated']) await h.asRole(db, role, () => fn(role)) }
const PUBLIC_RM = ['rm_transactions', 'rm_transaction_assets', 'rm_transaction_sources', 'rm_transaction_players', 'rm_transaction_returns', 'rm_transaction_packages', 'rm_transaction_followups', 'rm_transaction_coverage', 'rm_transaction_club_seasons', 'rm_transaction_overview']
const withdrawals = async () => (await h.one(db, 'select count(*)::int n, coalesce(sum(withdrawn_transactions), 0)::int t from rm_transaction_withdrawals')) // owner only
const orgId = async (k) => Number((await h.one(db, 'select id from organizations where franchise_key = $1', [k])).id)
const playerId = async (k) => Number((await h.one(db, "select player_id id from player_external_ids where id_system = 'MLBAM' and external_id = $1", [String(9880000 + k)])).id)
let three, two, bref, fg

test('setup: a three-club trade (one club sends two packages), a two-club trade, WAR from two providers', async () => {
  three = await trade('t3', '2030-07-01', [RETRO], [pk('KC', 'MIN', [pl(101), pl(102)], [RETRO.source_key]), pk('KC', 'CLE', [pl(103)], [RETRO.source_key]), pk('MIN', 'KC', [pl(104)], [RETRO.source_key]), pk('CLE', 'KC', [pl(105)], [RETRO.source_key])], 'H-3', [rg(RETRO.source_key)])
  two = await trade('t2', '2030-07-02', [RETRO], [pk('LAD', 'SEA', [pl(111)], [RETRO.source_key]), pk('SEA', 'LAD', [pl(112)], [RETRO.source_key])], 'H-2', [rg(RETRO.source_key)])
  bref = (await db.query("insert into sources (source_key, source_type, authority_level, title, publisher, url, retrieved_date) values ($1, $2, $3, $4, $5, $6, $7) returning id", [BREF.source_key, BREF.source_type, BREF.authority_level, BREF.title, BREF.publisher, BREF.url, BREF.retrieved_date])).rows[0].id
  fg = (await db.query("insert into sources (source_key, source_type, authority_level, title, publisher, url, retrieved_date) values ($1, $2, $3, $4, $5, $6, $7) returning id", [FG.source_key, FG.source_type, FG.authority_level, FG.title, FG.publisher, FG.url, FG.retrieved_date])).rows[0].id
  const war = (player, sys, org, v, src) => db.query("insert into war_observations (player_id, war_system, scope, season, organization_id, through_season, war_value, observed_on, source_id) values ($1, $2, 'SEASON', 2031, $3, 2031, $4, '2031-11-01', $5)", [player, sys, org, v, src])
  const kc = await orgId('KC'); const lad = await orgId('LAD'); const sea = await orgId('SEA')
  await war(await playerId(104), 'BREF', kc, 2.0, bref); await war(await playerId(105), 'BREF', kc, 1.5, bref)   // KC received 104 and 105
  await war(await playerId(104), 'FANGRAPHS', kc, 4.0, fg)                                                      // FanGraphs has only one of them
  await war(await playerId(112), 'BREF', lad, 0.5, bref); await war(await playerId(111), 'BREF', sea, 1.0, bref)
  await db.query("insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('RETROSHEET', 'fixture: a person recorded the basis', 'fixture scope'), ('BASEBALL_REFERENCE', 'fixture', 'fixture')")
  await refresh()
})

test('three-club trade: the club-level figure appears once per club and provider, never per counterparty (the primary-key collision)', async () => {
  const kc = await orgId('KC')
  // the analytics view repeats the club figure on each package row the club sent: summing it would double count. This documents why the read model groups.
  const raw = await h.one(db, "select count(*)::int n, sum(return_war_known)::float8 s, count(distinct return_war_known)::int d from analytics.trade_returns where transaction_id = $1 and organization_id = $2 and war_system = 'BREF'", [three, kc])
  assert.deepEqual([raw.n, raw.s, raw.d], [2, 7, 1], 'two package rows for KC carry the same 3.5')
  const rows = await h.rows(db, 'select club_key, provider, packages_sent, players_sent, players_received, return_war_known::float8 w, evidence from rm_transaction_returns where transaction_id = $1 order by club_key, provider', [three])
  const kcRows = rows.filter((r) => r.club_key === 'KC')
  assert.equal(kcRows.length, 2, 'one row per provider for KC')
  const b = kcRows.find((r) => r.provider === 'BREF'); const f = kcRows.find((r) => r.provider === 'FANGRAPHS')
  assert.deepEqual([b.packages_sent, b.players_sent, b.players_received, b.w], [2, 3, 2, 3.5], 'summed once: 2.0 + 1.5, not 7.0')
  assert.ok(['OBSERVED_COMPLETE', 'OBSERVED_PARTIAL'].includes(b.evidence))
  assert.deepEqual([f.w, f.evidence], [null, 'WITHHELD_PERMISSION'], 'FanGraphs is not licensed for display here, whatever BREF is: the providers are never combined')
})

test('the withheld provider figure is hidden, an authorized one shown; NULL and partial coverage stay honest', async () => {
  // as stored: the FanGraphs figure is withheld, so it must read null
  const rows = await h.rows(db, "select club_key, provider, return_war_known, evidence from rm_transaction_returns where transaction_id = $1", [three])
  const f = rows.find((r) => r.club_key === 'KC' && r.provider === 'FANGRAPHS')
  assert.deepEqual([f.return_war_known, f.evidence], [null, 'WITHHELD_PERMISSION'])
  for (const club of ['MIN', 'CLE']) for (const r of rows.filter((x) => x.club_key === club)) assert.deepEqual([r.return_war_known, r.evidence], [null, 'NOT_OBSERVED'], `${club} ${r.provider}: no evidence is not zero`)
  await db.query("insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('OTHER_PUBLICATION', 'fixture', 'fixture')")
  await refresh()
  const after = await h.rows(db, "select provider, return_war_known::float8 w from rm_transaction_returns where transaction_id = $1 and club_key = 'KC' order by provider", [three])
  assert.deepEqual(after.map((r) => [r.provider, r.w]), [['BREF', 3.5], ['FANGRAPHS', 4]])
  await db.query("delete from ingest.source_publication_grants where attribution_category = 'OTHER_PUBLICATION'")
})

test('two-club trade: one row per club and provider, package counts kept separately', async () => {
  await refresh()
  const rows = await h.rows(db, "select club_key, provider, packages_sent, players_sent, players_received, return_war_known::float8 w from rm_transaction_returns where transaction_id = $1 and provider = 'BREF' order by club_key", [two])
  assert.deepEqual(rows.map((r) => [r.club_key, r.packages_sent, r.players_sent, r.players_received, r.w]), [['LAD', 1, 1, 1, 0.5], ['SEA', 1, 1, 1, 1]])
  const pkgs = await h.rows(db, 'select from_key, to_key, players_sent, other_assets_sent from rm_transaction_packages where transaction_id = $1 order by from_key', [three])
  assert.deepEqual(pkgs.map((p) => [p.from_key, p.to_key, p.players_sent]), [['CLE', 'KC', 1], ['KC', 'CLE', 1], ['KC', 'MIN', 2], ['MIN', 'KC', 1]], 'package level kept apart from the club totals, nothing lost')
  assert.equal(pkgs.reduce((a, p) => a + p.players_sent, 0), 5)
  const cols = (await h.rows(db, "select column_name c from information_schema.columns where table_name = 'rm_transaction_packages'")).map((x) => x.c)
  assert.ok(!cols.some((c) => /war|return/i.test(c)), 'no WAR figure at the package level')
})

test('A. a publication grant withdrawn without a refresh leaves nothing readable by anon or authenticated; a re-grant does not republish', async () => {
  await refresh()
  await asBoth(async () => { assert.ok((await h.one(db, 'select count(*)::int n from rm_transactions')).n >= 2) })
  const before = await withdrawals()
  await db.query("delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'")   // no refresh
  await asBoth(async (role) => {
    for (const t of PUBLIC_RM) assert.equal((await h.one(db, `select count(*)::int n from ${t}`)).n, 0, `${role}: ${t} is empty after the grant is withdrawn`)
    assert.equal((await h.one(db, 'select count(*)::int n from v_source_attribution where domain = $1', ['TRANSACTION'])).n, 0, `${role}: the public summary no longer counts them`)
  })
  assert.ok((await withdrawals()).n > before.n, 'the withdrawal is logged (internal)')
  await db.query("insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('RETROSHEET', 'fixture: granted again', 'fixture scope')")
  await asBoth(async () => { assert.equal((await h.one(db, 'select count(*)::int n from rm_transactions')).n, 0, 'a new grant publishes nothing until the owner refreshes') })
  await refresh()
  await asBoth(async () => { assert.ok((await h.one(db, 'select count(*)::int n from rm_transactions')).n >= 2); assert.ok((await h.one(db, 'select count(*)::int n from v_source_attribution where domain = $1', ['TRANSACTION'])).n >= 1) })
  // truncating the grants withdraws as well
  await db.query('truncate ingest.source_publication_grants')
  await asBoth(async () => { assert.equal((await h.one(db, 'select count(*)::int n from rm_transactions')).n, 0) })
  await db.query("insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('RETROSHEET', 'fixture', 'fixture'), ('BASEBALL_REFERENCE', 'fixture', 'fixture')")
  await refresh()
})

test('a withdrawal empties the counts that could be stale; the refresh restores exactly what was there (convergence)', async () => {
  const snap = async () => (await h.one(db, `select md5(string_agg(x, '|' order by x)) m from (select (to_jsonb(t) - 'generation_id')::text x from rm_transactions t union all select a::text from rm_transaction_assets a union all select s::text from rm_transaction_sources s
    union all select r::text from rm_transaction_returns r union all select k::text from rm_transaction_packages k union all select p::text from rm_transaction_players p union all select f::text from rm_transaction_followups f
    union all select c::text from rm_transaction_coverage c union all select cs::text from rm_transaction_club_seasons cs) y`)).m
  const a = await snap()
  await db.query("delete from ingest.source_publication_grants where attribution_category = 'BASEBALL_REFERENCE'")
  assert.equal((await h.one(db, 'select count(*)::int n from rm_transaction_overview')).n, 0, 'the overview, whose counts could be stale, is gone')
  assert.equal((await h.one(db, 'select count(*)::int n from rm_transaction_returns')).n, 0, 'performance figures resting on the revoked group are gone')
  assert.ok((await h.one(db, 'select count(*)::int n from rm_transactions')).n >= 2, 'transactions that do not cite the revoked group stay')
  await db.query("insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('BASEBALL_REFERENCE', 'fixture', 'fixture')")
  await refresh()
  assert.equal(await snap(), a)
  await refresh()
  assert.equal(await snap(), a, 'convergent')
})

async function verify (tx) {
  const sources = await h.rows(db, 'select id from transaction_sources where transaction_id = $1', [tx])
  for (const s of sources) {
    await db.query('insert into transaction_source_links (transaction_source_id, trade_package_id) select $1, id from trade_packages where transaction_id = $2 on conflict do nothing', [s.id, tx])
    await db.query('insert into transaction_source_links (transaction_source_id, trade_package_asset_id) select $1, a.id from trade_package_assets a join trade_packages k on k.id = a.trade_package_id where k.transaction_id = $2 on conflict do nothing', [s.id, tx])
  }
  await rv.query('select * from research.verify_transaction($1, $2, $3)', [tx, 'checked both sources against each asset', 'a reference record and a separately written wire report'])
}
let vt
test('B. a verification revoked without a refresh leaves no obsolete VERIFIED_COMPLETE claim', async () => {
  vt = await trade('tv', '2030-08-01', [RETRO, SECOND], [pk('SD', 'SF', [pl(121)], [RETRO.source_key, SECOND.source_key]), pk('SF', 'SD', [pl(122)], [RETRO.source_key, SECOND.source_key])], 'H-V',
    [{ source_key: RETRO.source_key, role: 'PRIMARY_ANNOUNCEMENT', independence_group: 'g-retro' }, { source_key: SECOND.source_key, role: 'CORROBORATION', independence_group: 'g-wire' }])
  await rv.query("select * from research.enroll_reviewer('Hardening Reviewer')")
  await rv.query("select * from research.set_certification_gate(true, 'isolated test database')")
  await verify(vt)
  await refresh()
  await asBoth(async () => { const r = await h.one(db, 'select status, verified_on from rm_transactions where transaction_id = $1', [vt]); assert.deepEqual([r.status, Boolean(r.verified_on)], ['VERIFIED_COMPLETE', true]) })
  await rv.query('select * from research.revoke_transaction_verification($1, $2)', [vt, 'the reviewer withdrew it'])   // no refresh
  await asBoth(async (role) => {
    assert.equal((await h.one(db, 'select count(*)::int n from rm_transactions where transaction_id = $1', [vt])).n, 0, `${role}: the withdrawn claim is not readable`)
    assert.equal((await h.one(db, "select count(*)::int n from rm_transactions where status = 'VERIFIED_COMPLETE'")).n, 0, `${role}: no obsolete VERIFIED_COMPLETE anywhere`)
    for (const t of PUBLIC_RM.slice(1, 7)) assert.equal((await h.one(db, `select count(*)::int n from ${t} where transaction_id = $1`, [vt])).n, 0, `${role}: ${t}`)
  })
  await refresh()
  const r = await h.one(db, 'select status, verified_on from rm_transactions where transaction_id = $1', [vt])
  assert.deepEqual([r.status, r.verified_on], ['PARTIAL', null], 'republished only as what it now is')
})

test('importing a new transaction costs no withdrawal; a record nobody can see is not "withdrawn"', async () => {
  const before = await withdrawals()
  await trade('t4', '2030-09-01', [RETRO], [pk('HOU', 'TEX', [pl(131)], [RETRO.source_key]), pk('TEX', 'HOU', [pl(132)], [RETRO.source_key])], 'H-4', [rg(RETRO.source_key)])
  assert.equal((await withdrawals()).n, before.n, 'adding a transaction withdraws nothing already published')
  await refresh()
})

test('C. a verified record whose assets, sources or provenance change is withdrawn before any refresh', async () => {
  const mutate = {
    'an asset': (tx) => db.query("update trade_package_assets set description = 'edited' where trade_package_id in (select id from trade_packages where transaction_id = $1)", [tx]),
    'a source link': (tx) => db.query("update transaction_sources set locator = 'p. 99' where transaction_id = $1 and role = 'CORROBORATION'", [tx]),
    'a source row (provenance)': (tx) => db.query("update sources set url = url || '?edition=2' where id = (select source_id from transactions where id = $1)", [tx]),
    'a source link removed': (tx) => db.query('delete from transaction_source_links where trade_package_id in (select id from trade_packages where transaction_id = $1)', [tx]),
    'an added asset': (tx) => db.query("insert into trade_package_assets (trade_package_id, asset_type, description) select id, 'CASH', 'added later' from trade_packages where transaction_id = $1 limit 1", [tx])
  }
  for (const [name, fn] of Object.entries(mutate)) {
    // bring the transaction to a verified, published state
    await refresh()
    if ((await h.one(db, 'select status from rm_transactions where transaction_id = $1', [vt])).status !== 'VERIFIED_COMPLETE') {
      // an earlier change (a source row) can leave an ACTIVE verification that no longer matches the record: a person withdraws it, then verifies what is there now
      if (await h.one(db, "select 1 ok from research.transaction_verifications where transaction_id = $1 and state = 'ACTIVE'", [vt])) await rv.query('select * from research.revoke_transaction_verification($1, $2)', [vt, 'superseded'])
      await verify(vt); await refresh()
    }
    await asBoth(async () => assert.equal((await h.one(db, 'select status from rm_transactions where transaction_id = $1', [vt])).status, 'VERIFIED_COMPLETE', `${name}: precondition`))
    await fn(vt)   // no refresh
    await asBoth(async (role) => {
      assert.equal((await h.one(db, "select count(*)::int n from rm_transactions where transaction_id = $1", [vt])).n, 0, `${role}: after changing ${name} the old claim is not readable`)
      assert.equal((await h.one(db, 'select count(*)::int n from rm_transaction_assets where transaction_id = $1', [vt])).n, 0, `${role}: ${name}: the old assets are not readable`)
    })
    await refresh()
    const r = await h.one(db, 'select status, verified_on from rm_transactions where transaction_id = $1', [vt])
    assert.notEqual(r?.status, 'VERIFIED_COMPLETE', `${name}: not verified after the change`)
    assert.equal(r.verified_on, null)
  }
})

test('the raw transaction tables are not readable by anon or authenticated; the read model and unrelated public reads are', async () => {
  const raw = ['transactions', 'trade_packages', 'trade_package_assets', 'transaction_player_moves', 'transaction_sources', 'transaction_external_ids', 'transaction_source_links', 'ptbnl_resolutions', 'transaction_conflicts',
    'rm_transaction_refreshes', 'rm_transaction_withdrawals', 'analytics.transaction_completeness', 'analytics.trade_returns', 'research.transaction_verifications', 'ingest.source_publication_grants']
  const denied = (role, sql, re = /permission denied/) => assert.rejects(h.asRole(db, role, () => db.query(sql)), re, `${role}: ${sql}`)   // one transaction per attempt: a refusal aborts it
  for (const role of ['anon', 'authenticated']) {
    for (const t of raw) await denied(role, `select * from ${t} limit 1`)
    for (const sql of ['select public.rm_withdraw_transactions(array[1]::bigint[], $$x$$)', 'select public.refresh_transaction_read_models()', 'delete from rm_transactions', 'update rm_transaction_assets set position = 1', 'select public.rm_grant_changed()'])
      await denied(role, sql, /permission denied|trigger functions can only be called as triggers/)
  }
  // no policy remains that could reopen them, and the registry says why
  assert.equal((await h.one(db, "select count(*)::int n from pg_policy where polrelid in ('public.transactions'::regclass, 'public.trade_packages'::regclass, 'public.trade_package_assets'::regclass)")).n, 0)
  assert.equal((await h.one(db, "select count(*)::int n from public.internal_objects where object_name in ('transactions', 'trade_packages', 'trade_package_assets', 'transaction_player_moves', 'rm_transaction_withdrawals')")).n, 5)
  // legitimate public reads are untouched
  await asBoth(async (role) => {
    for (const t of ['drafts', 'draft_selections', 'organizations', 'players', 'sources', 'international_signings', 'v_source_attribution', 'rm_transactions']) await db.query(`select * from ${t} limit 1`)
  })
})
