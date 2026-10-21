// Organizational value (migration 023): season-by-team WAR, value for the acquiring club vs other clubs, trade returns
// per package, cost and timeline, per provider, never estimated. The trades mirror the SHAPE of known historical
// transactions (the 2018-07-18 LAD -> BAL package of five players for one, a single-player trade, an unsigned pick who
// produced elsewhere), but every player, id and WAR value here is FICTIONAL fixture data (TEST_FIXTURE sources).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'

let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-value-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const src = (key, authority = 'OFFICIAL') => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: authority, title: `Value fixture ${key}` })
let n = 0
async function stage (doc, org = 'LAD') {
  const f = path.join(dir, `b-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', ...doc }))
  const { batch } = await P.stageFile(db, f, { organization: org })
  return { batch, validation: await P.validateBatch(db, batch.id) }
}
async function run (doc, org = 'LAD') {
  const s = await stage(doc, org)
  assert.ok(s.validation.ok, JSON.stringify(s.validation.counts))
  return P.applyBatch(db, s.batch.id, { write: true })
}
const ID = { retained: '9850001', traded: '9850002', traded2: '9850003', unsigned: '9850004', nomlb: '9850005', notaudited: '9850006', careeronly: '9850007', partial: '9850008', star: '9850101', extra: '9850102' }
const who = (k, name) => ({ full_name: name, external_ids: { MLBAM: ID[k] } })
const pick = (k, name, i, signed = true) => ({ type: 'DRAFT_SELECTION', source_key: 'v:draft', draft_key: '2016-JUNE_AMATEUR', round_code: String(i), overall_pick: i * 30 - 10, round_pick: 20,
  organization: 'LAD', player: who(k, name), school: { name: 'Value U', school_type: 'COLLEGE' },
  signing: signed ? { status: 'SIGNED', bonus_usd: 100000 * i, source_key: 'v:draft' } : { status: 'DID_NOT_SIGN', source_key: 'v:draft' } })
const season = (s, org, value, system = 'BREF') => ({ system, scope: 'SEASON', season: s, organization: org, through_season: 2026, value, observed_on: '2026-10-20', source_key: system === 'BREF' ? 'v:bref' : 'v:fg' })
const career = (value, system = 'BREF') => ({ system, scope: 'CAREER', through_season: 2026, value, observed_on: '2026-10-20', source_key: system === 'BREF' ? 'v:bref' : 'v:fg' })
const audit = (k, name, state, extra = {}) => ({ type: 'OUTCOME_AUDIT', source_key: 'v:mlb', organization: 'LAD', player: who(k, name), audit_state: state, observation_through_season: 2026, audited_on: '2026-10-20', ...extra })
const value = async (k, system = 'BREF') => h.one(db, `select v.war_coverage, v.career_war::float8 career, v.original_org_war::float8 orig, v.other_org_war::float8 other, v.trade_package_return_war::float8 ret, v.returning_stint_war::float8 back, v.credited,
    v.trade_package_players pkg, v.trade_return_coverage rc, v.acquisition_cost_usd::float8 cost, v.seasons_to_debut, v.debut_age
  from analytics.acquisition_value v join player_external_ids x on x.player_id = v.player_id and x.id_system = 'MLBAM' where x.external_id = $1 and v.war_system = $2`, [ID[k], system])

test('setup: a LAD draft class, outcome audits with season splits, and the return side of its trades', async () => {
  await run({ batch_key: 'v-draft', channel: 'DRAFT', sources: [src('v:draft')], records: [
    pick('retained', 'Value Retained', 1), pick('traded', 'Value Traded', 2), pick('traded2', 'Value Traded Two', 3), pick('unsigned', 'Value Unsigned', 4, false),
    pick('nomlb', 'Value No MLB', 5), pick('notaudited', 'Value Not Audited', 6), pick('careeronly', 'Value Career Only', 7), pick('partial', 'Value Partial', 8)] })
  const trade = { ref: 'tr-2018-07-18', type: 'TRADE', date: '2018-07-18', from_organization: 'LAD', to_organization: 'BAL', description: 'LAD traded five players to BAL for one (fixture)' }
  await run({ batch_key: 'v-outcomes', channel: 'OUTCOMES', sources: [src('v:mlb'), src('v:bref', 'AGGREGATOR'), src('v:fg', 'AGGREGATOR')], records: [
    audit('retained', 'Value Retained', 'AUDITED_REACHED_MLB', { debut: { date: '2019-05-28', organization: 'LAD' },
      details: { as_of_date: '2026-10-20', current_status: 'WITH_ACQUIRING_ORGANIZATION', disposition: 'RETAINED' },
      war: [career(10.0), season(2019, 'LAD', 3.0), season(2020, 'LAD', 3.5), season(2021, 'LAD', 3.5), career(8.0, 'FANGRAPHS'), season(2019, 'LAD', 2.0, 'FANGRAPHS')] }),
    audit('traded', 'Value Traded', 'AUDITED_REACHED_MLB', { debut: { date: '2020-09-06', organization: 'BAL' }, transactions: [trade],
      details: { as_of_date: '2026-10-20', current_status: 'WITH_OTHER_ORGANIZATION', disposition: 'TRADED', disposition_transaction_ref: 'tr-2018-07-18' },
      war: [career(4.0), season(2020, 'BAL', 1.0), season(2021, 'BAL', 3.0)] }),
    audit('traded2', 'Value Traded Two', 'AUDITED_NO_MLB', { transactions: [trade],
      details: { as_of_date: '2026-10-20', current_status: 'INACTIVE', disposition: 'TRADED', disposition_transaction_ref: 'tr-2018-07-18' } }),
    audit('unsigned', 'Value Unsigned', 'AUDITED_REACHED_MLB', { debut: { date: '2021-05-18', organization: 'MIN' },
      details: { as_of_date: '2026-10-20', current_status: 'WITH_OTHER_ORGANIZATION', disposition: 'UNSIGNED' },
      war: [career(6.0), season(2021, 'MIN', 2.0), season(2022, 'MIN', 4.0)] }),
    audit('nomlb', 'Value No MLB', 'AUDITED_NO_MLB', { details: { as_of_date: '2026-10-20', current_status: 'RELEASED', disposition: 'RELEASED' } }),
    audit('careeronly', 'Value Career Only', 'AUDITED_REACHED_MLB', { debut: { date: '2022-08-10', organization: 'ATH' }, war: [career(-0.5)] }),
    audit('partial', 'Value Partial', 'AUDITED_REACHED_MLB', { debut: { date: '2021-04-09', organization: 'LAD' }, war: [career(5.0), season(2021, 'LAD', 1.0)] })] })
  // The return side: BAL sent one player to LAD; his WAR before the trade (for BAL) and after leaving (for SD) is not a return.
  await run({ batch_key: 'v-trades', channel: 'TRADES', sources: [src('v:mlb'), src('v:bref', 'AGGREGATOR')], records: [{ type: 'TRADE', source_key: 'v:mlb', organization: 'LAD', ref: 'tr-2018-07-18',
    date: '2018-07-18', description: 'fixture trade, shaped like the 2018-07-18 LAD-BAL trade', packages: [
      { from: 'BAL', to: 'LAD', players: [{ player: { ...who('star', 'Value Star'), source_key: 'v:mlb' },
        war: [career(30.0), season(2017, 'BAL', 4.0), season(2018, 'BAL', 3.5), season(2018, 'LAD', 1.5), season(2019, 'SD', 21.0)] }] },
      { from: 'LAD', to: 'BAL', players: [{ player: { ...who('traded', 'Value Traded'), source_key: 'v:mlb' } }, { player: { ...who('traded2', 'Value Traded Two'), source_key: 'v:mlb' } },
        { player: { ...who('extra', 'Value Extra'), source_key: 'v:mlb' } }] }] }] })
})

test('one trade is one transaction whichever side came first; each direction is one package', async () => {
  const t = await h.rows(db, "select t.id, count(distinct k.id)::int packages from transactions t join trade_packages k on k.transaction_id = t.id where t.transaction_date = '2018-07-18' group by t.id")
  assert.deepEqual(t.map((x) => x.packages), [2])
  const sent = await h.one(db, "select players_sent, cardinality(received_player_ids) received from analytics.trade_returns where transaction_date = '2018-07-18' and war_system = 'BREF' and organization_id = (select id from organizations where franchise_key = 'LAD')")
  assert.deepEqual(sent, { players_sent: 3, received: 1 })
})

test('value for the acquiring club, value elsewhere, and trade returns are kept apart', async () => {
  // Retained: everything was produced for LAD.
  assert.deepEqual(await value('retained'), { war_coverage: 'COMPLETE', career: 10, orig: 10, other: 0, ret: null, back: 0, credited: true, pkg: null, rc: null, cost: 100000, seasons_to_debut: 3, debut_age: null })
  // Traded before debut: all of his WAR is BAL's; LAD's value is the return, the star's LAD seasons from the trade on (1.5),
  // never his BAL seasons (4.0, 3.5) nor his later SD season (21.0). The return belongs to the package of three.
  const t = await value('traded')
  assert.deepEqual([t.war_coverage, t.orig, t.other, t.ret, t.pkg, t.rc], ['COMPLETE', 0, 4, 1.5, 3, 'COMPLETE'])
  const t2 = await value('traded2')
  assert.deepEqual([t2.war_coverage, t2.orig, t2.other, t2.ret], ['NO_MLB', 0, 0, 1.5])
  // Unsigned: the pick earns nothing at all (another club's production is never value delivered to LAD), and
  // the player's career is not shown on an acquisition that never happened.
  assert.deepEqual(await value('unsigned').then((v) => [v.war_coverage, v.credited, v.career, v.orig, v.other, v.ret, v.back, v.cost, v.seasons_to_debut]), ['NOT_SIGNED', false, null, null, null, null, null, null, null])
  // Audited without MLB time: zero is a fact. Not audited: unknown, never zero.
  assert.deepEqual(await value('nomlb').then((v) => [v.war_coverage, v.orig, v.other]), ['NO_MLB', 0, 0])
  assert.deepEqual(await value('notaudited').then((v) => [v.war_coverage, v.orig, v.other]), ['NOT_OBSERVED', null, null])
  // Career value without season splits cannot be attributed; splits that do not add up are PARTIAL (known sums only).
  assert.deepEqual(await value('careeronly').then((v) => [v.war_coverage, v.career, v.orig, v.other]), ['CAREER_ONLY', -0.5, null, null])
  assert.deepEqual(await value('partial').then((v) => [v.war_coverage, v.career, v.orig, v.other]), ['PARTIAL', 5, 1, 0])
})

test('providers stay separate: FanGraphs is its own row, never filled from Baseball-Reference', async () => {
  assert.deepEqual(await value('retained', 'FANGRAPHS').then((v) => [v.war_coverage, v.career, v.orig]), ['PARTIAL', 8, 2])
  assert.deepEqual(await value('traded', 'FANGRAPHS').then((v) => [v.war_coverage, v.career, v.orig, v.ret]), ['NOT_OBSERVED', null, null, null])
  assert.deepEqual(await value('retained', 'BREF').then((v) => [v.career, v.orig]), [10, 10], 'unchanged by the FanGraphs rows')
})

test('class rollup: known sums with coverage counts, no total while anything is uncovered, each package counted once', async () => {
  const c = await h.one(db, `select acquisitions, credited_acquisitions, war_covered, war_not_observed, original_org_war_known::float8 orig, other_org_war_known::float8 other, original_org_war_total,
      trade_return_war_known::float8 ret, trade_packages, trade_packages_shared, known_cost_usd::float8 cost, cost_known
    from analytics.class_value v join organizations o on o.id = v.organization_id where o.franchise_key = 'LAD' and scope_key = '2016-JUNE_AMATEUR' and war_system = 'BREF'`)
  // The unsigned pick is an acquisition row but earns nothing: his 6.0 elsewhere is in no sum.
  assert.deepEqual(c, { acquisitions: 8, credited_acquisitions: 7, war_covered: 4, war_not_observed: 1, orig: 11, other: 4, original_org_war_total: null, ret: 1.5, trade_packages: 1, trade_packages_shared: 1, cost: 3200000, cost_known: 7 })
})

test('trades: re-applying changes nothing; a rival WAR value is a conflict; weak identities and outsiders are refused', async () => {
  const again = await stage({ batch_key: 'v-trades-again', channel: 'TRADES', sources: [src('v:mlb')], records: [{ type: 'TRADE', source_key: 'v:mlb', organization: 'LAD', ref: 'tr-2018-07-18', date: '2018-07-18',
    packages: [{ from: 'BAL', to: 'LAD', players: [{ player: { ...who('star', 'Value Star'), source_key: 'v:mlb' } }] }] }] })
  assert.ok(again.validation.ok)
  assert.deepEqual((await P.applyBatch(db, again.batch.id, { write: true })).report.actions, { NO_CHANGE: 1 })
  const rival = await run({ batch_key: 'v-trades-rival', channel: 'TRADES', sources: [src('v:other', 'OTHER')], records: [{ type: 'TRADE', source_key: 'v:other', organization: 'LAD', ref: 'tr-2018-07-18', date: '2018-07-18',
    packages: [{ from: 'BAL', to: 'LAD', players: [{ player: { ...who('star', 'Value Star'), source_key: 'v:other' }, war: [{ ...season(2018, 'LAD', 1.7), source_key: 'v:other' }] }] }] }] })
  assert.deepEqual(rival.report.actions, { CONFLICT: 1 })
  assert.equal((await value('traded')).ret, 1.5, 'no overwrite')
  const bad = await stage({ batch_key: 'v-trades-bad', channel: 'TRADES', sources: [src('v:mlb')], records: [
    { type: 'TRADE', source_key: 'v:mlb', organization: 'LAD', ref: 'tr-x', date: '2019-01-01', packages: [{ from: 'NYY', to: 'BOS', players: [{ player: { full_name: 'Somebody', external_ids: { MLBAM: '9859999' } } }] }] },
    { type: 'TRADE', source_key: 'v:mlb', organization: 'LAD', ref: 'tr-y', date: '2019-01-02', packages: [{ from: 'LAD', to: 'NYY', players: [{ player: { full_name: 'No Strong Id' } }] }] }] })
  assert.equal(bad.validation.counts.invalid, 2)
  const errs = (await h.rows(db, "select validation_errors from ingest.staged_records r join ingest.import_batches b on b.id = r.batch_id where b.batch_key = 'v-trades-bad' order by record_index")).map((r) => r.validation_errors.join(' '))
  assert.match(errs[0], /not a party/); assert.match(errs[1], /MLBAM/)
})

test('a return of players who never reached MLB is a known zero; an unaccounted return stays unknown', async () => {
  await run({ batch_key: 'v-trades-zero', channel: 'TRADES', sources: [src('v:mlb')], records: [{ type: 'TRADE', source_key: 'v:mlb', organization: 'LAD', ref: 'tr-2022-01-10', date: '2022-01-10',
    packages: [{ from: 'LAD', to: 'NYY', players: [{ player: { ...who('partial', 'Value Partial'), source_key: 'v:mlb' } }] },
      { from: 'NYY', to: 'LAD', players: [{ player: { full_name: 'Value Prospect', external_ids: { MLBAM: '9850103' }, source_key: 'v:mlb' } }] }] }] })
  assert.equal((await value('partial')).ret, null, 'no trade return until the acquisition is known to have ended in that trade')
  // The acquisition's own disposition, per acquisition (022): it ended in the 2022 trade.
  await run({ batch_key: 'v-partial-disposition', channel: 'OUTCOMES', sources: [src('v:mlb')], records: [
    audit('partial', 'Value Partial', 'AUDITED_REACHED_MLB', { debut: { date: '2021-04-09', organization: 'LAD' }, acquisition: { draft_key: '2016-JUNE_AMATEUR', overall_pick: 230 },
      transactions: [{ ref: 'tr-2022', type: 'TRADE', date: '2022-01-10', from_organization: 'LAD', to_organization: 'NYY' }],
      disposition: { value: 'TRADED', transaction_ref: 'tr-2022', as_of_date: '2026-10-20' } })] })
  const pending = await value('partial')
  assert.deepEqual([pending.ret, pending.rc], [null, 'PARTIAL'], 'the received prospect is not accounted for yet: unknown, not zero')
  await run({ batch_key: 'v-prospect-audit', channel: 'OUTCOMES', sources: [src('v:mlb')], records: [
    { type: 'OUTCOME_AUDIT', source_key: 'v:mlb', organization: 'LAD', player: { full_name: 'Value Prospect', external_ids: { MLBAM: '9850103' } }, audit_state: 'AUDITED_NO_MLB', observation_through_season: 2026, audited_on: '2026-10-20' }] })
  const done = await value('partial')
  assert.deepEqual([done.ret, done.rc], [0, 'COMPLETE'])
})

test('regressions: split seasons, a return to the club, a player acquired twice, a package shared by two classes, a received player who left', async () => {
  const P2 = { mid: '9850201', bosret: '9850202', twice: '9850203', share16: '9850204', share17: '9850205', tbret: '9850206' }
  const p2 = (k, name) => ({ full_name: name, external_ids: { MLBAM: P2[k] }, source_key: 'v:mlb' })
  const sel = (k, name, draft, pickNo, org, signed) => ({ type: 'DRAFT_SELECTION', source_key: 'v:draft', draft_key: draft, round_code: String(Math.ceil(pickNo / 30)), overall_pick: pickNo, round_pick: pickNo % 30 || 30,
    organization: org, player: { full_name: name, external_ids: { MLBAM: P2[k] } }, school: { name: 'Value U', school_type: 'COLLEGE' },
    signing: signed ? { status: 'SIGNED', bonus_usd: 50000, source_key: 'v:draft' } : { status: 'DID_NOT_SIGN', source_key: 'v:draft' } })
  await run({ batch_key: 'v2-lad-2016', channel: 'DRAFT', sources: [src('v:draft')], records: [sel('mid', 'Split Season', '2016-JUNE_AMATEUR', 260, 'LAD', true),
    sel('twice', 'Drafted Twice', '2016-JUNE_AMATEUR', 290, 'LAD', false), sel('share16', 'Shared Sixteen', '2016-JUNE_AMATEUR', 320, 'LAD', true)] })
  await run({ batch_key: 'v2-lad-2017', channel: 'DRAFT', sources: [src('v:draft')], records: [sel('share17', 'Shared Seventeen', '2017-JUNE_AMATEUR', 60, 'LAD', true)] })
  await run({ batch_key: 'v2-bos-2017', channel: 'DRAFT', sources: [src('v:draft')], records: [sel('twice', 'Drafted Twice', '2017-JUNE_AMATEUR', 50, 'BOS', true)] }, 'BOS')
  const tx = (ref, date, from, to) => ({ ref, type: 'TRADE', date, from_organization: from, to_organization: to })
  const out = (k, name, org, acquisition, disposition, extra = {}) => ({ type: 'OUTCOME_AUDIT', source_key: 'v:mlb', organization: org, player: { full_name: name, external_ids: { MLBAM: P2[k] } },
    audit_state: 'AUDITED_REACHED_MLB', observation_through_season: 2026, audited_on: '2026-10-20', acquisition, disposition: { as_of_date: '2026-10-20', ...disposition }, ...extra })
  await run({ batch_key: 'v2-outcomes', channel: 'OUTCOMES', sources: [src('v:mlb'), src('v:bref', 'AGGREGATOR')], records: [
    // Traded in the middle of 2019 (two rows that season), back with LAD as a free agent in 2021.
    out('mid', 'Split Season', 'LAD', { draft_key: '2016-JUNE_AMATEUR', overall_pick: 260 }, { value: 'TRADED', transaction_ref: 'tr-mid' }, {
      debut: { date: '2018-06-01', organization: 'LAD' }, transactions: [tx('tr-mid', '2019-07-31', 'LAD', 'BOS')],
      war: [career(4.0), season(2018, 'LAD', 0.5), season(2019, 'LAD', 1.0), season(2019, 'BOS', 0.5), season(2021, 'LAD', 2.0)] }),
    // Drafted by LAD in 2016 (did not sign), by BOS in 2017 (signed): one career, two acquisitions, credited once.
    out('twice', 'Drafted Twice', 'LAD', { draft_key: '2016-JUNE_AMATEUR', overall_pick: 290 }, { value: 'UNSIGNED' }, {
      debut: { date: '2019-05-01', organization: 'BOS' }, war: [career(2.0), season(2019, 'BOS', 2.0)] }),
    out('twice', 'Drafted Twice', 'BOS', { draft_key: '2017-JUNE_AMATEUR', overall_pick: 50 }, { value: 'RETAINED' }, { debut: { date: '2019-05-01', organization: 'BOS' }, cross_organization: 'fixture: his signing club audited in the same batch' }),
    // Two LAD classes sent together in one package.
    out('share16', 'Shared Sixteen', 'LAD', { draft_key: '2016-JUNE_AMATEUR', overall_pick: 320 }, { value: 'TRADED', transaction_ref: 'tr-tb' }, {
      debut: { date: '2021-04-01', organization: 'TB' }, transactions: [tx('tr-tb', '2020-02-01', 'LAD', 'TB')], war: [career(0.4), season(2021, 'TB', 0.4)] }),
    out('share17', 'Shared Seventeen', 'LAD', { draft_key: '2017-JUNE_AMATEUR', overall_pick: 60 }, { value: 'TRADED', transaction_ref: 'tr-tb' }, {
      debut: { date: '2022-04-01', organization: 'TB' }, transactions: [tx('tr-tb', '2020-02-01', 'LAD', 'TB')], war: [career(0.0), season(2022, 'TB', 0.0)] })] })
  await run({ batch_key: 'v2-trades', channel: 'TRADES', sources: [src('v:mlb'), src('v:bref', 'AGGREGATOR')], records: [
    { type: 'TRADE', source_key: 'v:mlb', organization: 'LAD', ref: 'tr-mid', date: '2019-07-31', packages: [
      { from: 'LAD', to: 'BOS', players: [{ player: p2('mid', 'Split Season') }] },
      // Received in 2019, traded away again in 2021, back with LAD in 2023: his 2023 season is not this trade's return.
      { from: 'BOS', to: 'LAD', players: [{ player: p2('bosret', 'Boston Return'), war: [career(6.0), season(2019, 'LAD', 0.3), season(2020, 'LAD', 0.7), season(2023, 'LAD', 5.0)] }] }] },
    { type: 'TRADE', source_key: 'v:mlb', organization: 'LAD', ref: 'tr-bosret-out', date: '2021-03-01', packages: [{ from: 'LAD', to: 'SD', players: [{ player: p2('bosret', 'Boston Return') }] }] },
    { type: 'TRADE', source_key: 'v:mlb', organization: 'LAD', ref: 'tr-tb', date: '2020-02-01', packages: [
      { from: 'LAD', to: 'TB', players: [{ player: p2('share16', 'Shared Sixteen') }, { player: p2('share17', 'Shared Seventeen') }] },
      { from: 'TB', to: 'LAD', players: [{ player: p2('tbret', 'Tampa Return'), war: [career(1.2), season(2020, 'LAD', 1.2)] }] }] }] })
  const row = async (mlbam, org, scope) => h.one(db, `select v.war_coverage, v.credited, v.original_org_war::float8 orig, v.returning_stint_war::float8 back, v.other_org_war::float8 other,
      v.trade_package_return_war::float8 ret, v.trade_package_players pkg, v.disposition::text, v.tenure_end_known
    from analytics.acquisition_value v join player_external_ids x on x.player_id = v.player_id and x.id_system = 'MLBAM' join organizations o on o.id = v.organization_id
    where x.external_id = $1 and o.franchise_key = $2 and v.scope_key = $3 and v.war_system = 'BREF'`, [mlbam, org, scope])
  // Split season: both 2019 rows count, each for its own club; the exit season's LAD row is the acquisition's; 2021 is a
  // second stint, reported and never credited. The return is the received player's LAD seasons until LAD traded him on.
  assert.deepEqual(await row(P2.mid, 'LAD', '2016-JUNE_AMATEUR'), { war_coverage: 'COMPLETE', credited: true, orig: 1.5, back: 2, other: 0.5, ret: 1, pkg: 1, disposition: 'TRADED', tenure_end_known: true })
  // Acquired twice: the LAD pick that did not sign earns nothing; the BOS signing earns his BOS value. Summed: 2.0, not 4.0.
  assert.deepEqual(await row(P2.twice, 'LAD', '2016-JUNE_AMATEUR'), { war_coverage: 'NOT_SIGNED', credited: false, orig: null, back: null, other: null, ret: null, pkg: null, disposition: 'UNSIGNED', tenure_end_known: false })
  assert.deepEqual(await row(P2.twice, 'BOS', '2017-JUNE_AMATEUR'), { war_coverage: 'COMPLETE', credited: true, orig: 2, back: 0, other: 0, ret: null, pkg: null, disposition: 'RETAINED', tenure_end_known: true })
  const both = await h.one(db, `select sum(v.original_org_war)::float8 s from analytics.acquisition_value v join player_external_ids x on x.player_id = v.player_id and x.id_system = 'MLBAM'
    where x.external_id = $1 and v.war_system = 'BREF'`, [P2.twice])
  assert.equal(both.s, 2)
  // Shared package: each acquisition shows the whole package return (never split); each class counts the package once
  // and flags it as shared, so class rollups are never added together.
  for (const [id, scope] of [[P2.share16, '2016-JUNE_AMATEUR'], [P2.share17, '2017-JUNE_AMATEUR']]) {
    const r = await row(id, 'LAD', scope)
    assert.deepEqual([r.ret, r.pkg], [1.2, 2])
  }
  const c17 = await h.one(db, `select trade_return_war_known::float8 ret, trade_packages, trade_packages_shared from analytics.class_value v join organizations o on o.id = v.organization_id
    where o.franchise_key = 'LAD' and scope_key = '2017-JUNE_AMATEUR' and war_system = 'BREF'`)
  assert.deepEqual(c17, { ret: 1.2, trade_packages: 1, trade_packages_shared: 1 })
  const c16 = await h.one(db, `select trade_return_war_known::float8 ret, trade_packages, trade_packages_shared, returning_stint_war_known::float8 back from analytics.class_value v join organizations o on o.id = v.organization_id
    where o.franchise_key = 'LAD' and scope_key = '2016-JUNE_AMATEUR' and war_system = 'BREF'`)
  // 2016 packages: BAL 2018 (1.5), BOS 2019 (1.0), TB 2020 (1.2), NYY 2022 (0): each once. Shared with players from
  // outside the class: BAL (a player BAI does not hold in any class) and TB (the 2017 pick).
  assert.deepEqual(c16, { ret: 3.7, trade_packages: 4, trade_packages_shared: 2, back: 2 })
})
