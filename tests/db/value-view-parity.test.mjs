// Exact old-versus-new parity of the organizational-value views (migration 029 against 023/028) on identical FICTIONAL data:
// two disposable databases, one at 028 (the old views) and one at 029, receive the same drafts, outcome audits, season WAR from both
// providers, two-club, three-club and PTBNL trades, a player traded away and returning, and unobserved or partial coverage. Every
// row of trade_returns, acquisition_value and class_value must be equal, NULLs, coverage states, arrays and numerics included.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as T from '../../scripts/research/lib/transactions.mjs'

let oldDb, newDb
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-parity-'))
before(async () => {
  await h.startServer()
  oldDb = await h.freshDatabase({ migrate: false }); await applyMigrations(oldDb, { through: '028' })
  newDb = await h.freshDatabase()
}, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const src = (key, authority = 'OFFICIAL') => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: authority, title: `Parity fixture ${key}` })
let n = 0
async function run (db, doc) {
  const f = path.join(dir, `b-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', ...doc }))
  const { batch } = await P.stageFile(db, f, {})
  const v = await P.validateBatch(db, batch.id)
  assert.ok(v.ok, JSON.stringify(v.counts))
  return P.applyBatch(db, batch.id, { write: true })
}
const who = (id, name) => ({ full_name: name, external_ids: { MLBAM: String(id) } })
const season = (s, org, value, system = 'BREF') => ({ system, scope: 'SEASON', season: s, organization: org, through_season: 2026, value, observed_on: '2026-10-20', source_key: system === 'BREF' ? 'p:bref' : 'p:fg' })
const career = (value, system = 'BREF') => ({ system, scope: 'CAREER', through_season: 2026, value, observed_on: '2026-10-20', source_key: system === 'BREF' ? 'p:bref' : 'p:fg' })
const pick = (id, name, i, signed = true) => ({ type: 'DRAFT_SELECTION', source_key: 'p:draft', draft_key: '2016-JUNE_AMATEUR', round_code: String(i), overall_pick: i * 30 - 10, round_pick: 20, organization: 'LAD', player: who(id, name),
  school: { name: 'Parity U', school_type: 'COLLEGE' }, signing: signed ? { status: 'SIGNED', bonus_usd: 100000 * i, source_key: 'p:draft' } : { status: 'DID_NOT_SIGN', source_key: 'p:draft' } })
const audit = (id, name, state, extra = {}) => ({ type: 'OUTCOME_AUDIT', source_key: 'p:mlb', organization: 'LAD', player: who(id, name), audit_state: state, observation_through_season: 2026, audited_on: '2026-10-20', ...extra })
const GROUPS = [{ source_key: 'p:mlb', role: 'REFERENCE', independence_group: 'fixture-a' }]
const v2 = (ref, date, packages, ext) => T.prepareTradeDoc({ format: 'bai-research-import/1', batch_key: `p-${ref}`, channel: 'TRADES', sources: [src('p:mlb'), src('p:bref', 'AGGREGATOR'), src('p:fg', 'AGGREGATOR')],
  records: [{ type: 'TRADE', schema: 2, ref, organization: packages[0].from, date, source_key: 'p:mlb', sources: GROUPS, external_ids: [{ scheme: 'MLB_TXN', id: ext }], packages }] })
const pk = (from, to, players, others = []) => ({ from, to, source_keys: ['p:mlb'], players: players.map((p) => ({ player: p, source_keys: ['p:mlb'] })), other_assets: others.map((o) => ({ source_keys: ['p:mlb'], ...o })) })

async function build (db) {
  await run(db, { batch_key: 'p-draft', channel: 'DRAFT', sources: [src('p:draft')], records: [
    pick(9870001, 'Parity Retained', 1), pick(9870002, 'Parity Traded', 2), pick(9870003, 'Parity Traded Two', 3), pick(9870004, 'Parity Unsigned', 4, false),
    pick(9870005, 'Parity No MLB', 5), pick(9870006, 'Parity Not Audited', 6), pick(9870007, 'Parity Career Only', 7), pick(9870008, 'Parity Partial', 8)] })
  const trade = { ref: 'pt-2018-07-18', type: 'TRADE', date: '2018-07-18', from_organization: 'LAD', to_organization: 'BAL', description: 'parity fixture trade' }
  await run(db, { batch_key: 'p-outcomes', channel: 'OUTCOMES', sources: [src('p:mlb'), src('p:bref', 'AGGREGATOR'), src('p:fg', 'AGGREGATOR')], records: [
    audit(9870001, 'Parity Retained', 'AUDITED_REACHED_MLB', { debut: { date: '2019-05-28', organization: 'LAD' }, details: { as_of_date: '2026-10-20', current_status: 'WITH_ACQUIRING_ORGANIZATION', disposition: 'RETAINED' },
      war: [career(10.0), season(2019, 'LAD', 3.0), season(2020, 'LAD', 3.5), season(2021, 'LAD', 3.5), career(8.0, 'FANGRAPHS'), season(2019, 'LAD', 2.0, 'FANGRAPHS'), season(2020, 'LAD', 3.0, 'FANGRAPHS'), season(2021, 'LAD', 3.0, 'FANGRAPHS')] }),
    audit(9870002, 'Parity Traded', 'AUDITED_REACHED_MLB', { debut: { date: '2020-09-06', organization: 'BAL' }, transactions: [trade],
      details: { as_of_date: '2026-10-20', current_status: 'WITH_OTHER_ORGANIZATION', disposition: 'TRADED', disposition_transaction_ref: 'pt-2018-07-18' }, war: [career(4.0), season(2020, 'BAL', 1.0), season(2021, 'BAL', 3.0), career(3.0, 'FANGRAPHS'), season(2020, 'BAL', 1.0, 'FANGRAPHS'), season(2021, 'BAL', 2.0, 'FANGRAPHS')] }),
    audit(9870003, 'Parity Traded Two', 'AUDITED_NO_MLB', { transactions: [trade], details: { as_of_date: '2026-10-20', current_status: 'INACTIVE', disposition: 'TRADED', disposition_transaction_ref: 'pt-2018-07-18' } }),
    audit(9870004, 'Parity Unsigned', 'AUDITED_REACHED_MLB', { debut: { date: '2021-05-18', organization: 'MIN' }, details: { as_of_date: '2026-10-20', current_status: 'WITH_OTHER_ORGANIZATION', disposition: 'UNSIGNED' }, war: [career(6.0), season(2021, 'MIN', 2.0), season(2022, 'MIN', 4.0)] }),
    audit(9870005, 'Parity No MLB', 'AUDITED_NO_MLB', { details: { as_of_date: '2026-10-20', current_status: 'RELEASED', disposition: 'RELEASED' } }),
    audit(9870007, 'Parity Career Only', 'AUDITED_REACHED_MLB', { debut: { date: '2022-08-10', organization: 'ATH' }, war: [career(-0.5)] }),
    audit(9870008, 'Parity Partial', 'AUDITED_REACHED_MLB', { debut: { date: '2021-04-09', organization: 'LAD' }, war: [career(5.0), season(2021, 'LAD', 1.0)] })] })
  // BAL sent a star to LAD in 2018-07-18; LAD trades him on to SD in 2019 and later he returns (a later stint must not count as that trade's return)
  await run(db, { batch_key: 'p-trade-back', channel: 'TRADES', sources: [src('p:mlb'), src('p:bref', 'AGGREGATOR'), src('p:fg', 'AGGREGATOR')], records: [{ type: 'TRADE', source_key: 'p:mlb', organization: 'LAD', ref: 'pt-2018-07-18', date: '2018-07-18', packages: [
    { from: 'BAL', to: 'LAD', players: [{ player: { ...who(9870101, 'Parity Star'), source_key: 'p:mlb' }, war: [career(30.0), season(2017, 'BAL', 4.0), season(2018, 'BAL', 3.5), season(2018, 'LAD', 1.5), season(2019, 'LAD', 2.0), season(2019, 'SD', 5.0), season(2021, 'LAD', 4.0), career(20.0, 'FANGRAPHS'), season(2018, 'LAD', 1.0, 'FANGRAPHS'), season(2019, 'LAD', 1.5, 'FANGRAPHS')] }] },
    { from: 'LAD', to: 'BAL', players: [{ player: { ...who(9870002, 'Parity Traded'), source_key: 'p:mlb' } }, { player: { ...who(9870003, 'Parity Traded Two'), source_key: 'p:mlb' } }, { player: { ...who(9870102, 'Parity Extra'), source_key: 'p:mlb' } }] }] }] })
  await run(db, { batch_key: 'p-onward', channel: 'TRADES', sources: [src('p:mlb')], records: [{ type: 'TRADE', source_key: 'p:mlb', organization: 'LAD', ref: 'pt-2019-06-01', date: '2019-06-01', packages: [
    { from: 'LAD', to: 'SD', players: [{ player: { ...who(9870101, 'Parity Star'), source_key: 'p:mlb' } }] }, { from: 'SD', to: 'LAD', players: [{ player: { ...who(9870103, 'Parity Prospect'), source_key: 'p:mlb' } }] }] }] })
  // two-club trade with a PTBNL named after the trade (v2), and a three-club trade
  await run(db, v2('pt-ptbnl', '2019-08-01', [pk('LAD', 'SEA', [who(9870201, 'Parity Out One')], [{ asset_type: 'PLAYER_TO_BE_NAMED', description: 'ptbnl', condition_text: 'later' }]), pk('SEA', 'LAD', [who(9870202, 'Parity In One')],
    [{ asset_type: 'PLAYER_TO_BE_NAMED', description: 'ptbnl', resolution: { kind: 'PLAYER', player: who(9870203, 'Parity Named Later'), resolved_on: '2020-01-15', source_key: 'p:mlb' } }])], 'PT-1'))
  await run(db, v2('pt-three', '2020-07-30', [pk('LAD', 'NYY', [who(9870301, 'Parity A')]), pk('NYY', 'TB', [who(9870302, 'Parity B'), who(9870303, 'Parity C')]), pk('TB', 'LAD', [who(9870304, 'Parity D')], [{ asset_type: 'CASH', description: 'cash', amount_disclosure: 'UNKNOWN' }])], 'PT-2'))
  // a trade that sends LAD only cash (no player received), and one that returns a player audited without MLB time (a known zero)
  await run(db, v2('pt-cash', '2020-08-15', [pk('LAD', 'HOU', [who(9870401, 'Parity Out Two')]), pk('HOU', 'LAD', [], [{ asset_type: 'CASH', description: 'cash', amount_usd: 250000 }])], 'PT-3'))
  await run(db, v2('pt-nomlb', '2020-09-01', [pk('MIA', 'LAD', [who(9870005, 'Parity No MLB')]), pk('LAD', 'MIA', [who(9870305, 'Parity E')])], 'PT-4'))
  // WAR for players of the v2 trades: both providers, before and after the naming date and after a later departure
  const sid = async (k) => Number((await h.one(db, 'select id from sources where source_key = $1', [k])).id)
  const bref = await sid('p:bref'); const fg = await sid('p:fg')
  const org = async (k) => Number((await h.one(db, 'select id from organizations where franchise_key = $1', [k])).id)
  const pid = async (m) => Number((await h.one(db, "select player_id id from player_external_ids where id_system = 'MLBAM' and external_id = $1", [String(m)])).id)
  const add = async (m, system, season, orgKey, value) => db.query("insert into war_observations (player_id, war_system, scope, season, organization_id, through_season, war_value, observed_on, source_id) values ($1, $2, 'SEASON', $3, $4, 2026, $5, '2026-10-20', $6)",
    [await pid(m), system, season, await org(orgKey), value, system === 'BREF' ? bref : fg])
  for (const [m, sys, s, o, v] of [[9870203, 'BREF', 2019, 'LAD', 9], [9870203, 'BREF', 2020, 'LAD', 2], [9870203, 'BREF', 2021, 'LAD', 1], [9870203, 'FANGRAPHS', 2020, 'LAD', 1.5], [9870202, 'BREF', 2019, 'LAD', 0.5], [9870202, 'BREF', 2020, 'SEA', 2.5],
    [9870304, 'BREF', 2020, 'LAD', 1.1], [9870304, 'FANGRAPHS', 2020, 'LAD', 0.9], [9870302, 'BREF', 2020, 'TB', 0.4], [9870103, 'BREF', 2019, 'LAD', 0.7], [9870103, 'BREF', 2020, 'LAD', 1.3]]) await add(m, sys, s, o, v)
  await db.query("insert into war_observations (player_id, war_system, scope, through_season, war_value, observed_on, source_id) values ($1, 'BREF', 'CAREER', 2026, 5.0, '2026-10-20', $2)", [await pid(9870203), bref])
}
const VIEWS = ['trade_returns', 'acquisition_value', 'class_value']
const dump = (db, v) => h.rows(db, `select to_jsonb(x)::text j from analytics.${v} x order by to_jsonb(x)::text`).then((r) => r.map((x) => x.j))

test('the same fixtures give identical rows in every value view, old (028) and new (029)', async () => {
  await build(oldDb); await build(newDb)
  const cols = async (db, v) => (await h.rows(db, `select attname, format_type(atttypid, atttypmod) t from pg_attribute where attrelid = 'analytics.${v}'::regclass and attnum > 0 and not attisdropped order by attnum`)).map((r) => `${r.attname}:${r.t}`)
  for (const v of VIEWS) {
    assert.deepEqual(await cols(newDb, v), await cols(oldDb, v), `${v}: same columns, types and order`)
    const [a, b] = [await dump(oldDb, v), await dump(newDb, v)]
    assert.ok(a.length > 0, `${v} has rows`)
    assert.deepEqual(b, a, `${v}: every row identical`)
  }
})

test('the fixtures exercise what the optimization must preserve (so equality means something)', async () => {
  const tr = await h.rows(newDb, 'select * from analytics.trade_returns')
  assert.ok(tr.some((r) => r.war_system === 'BREF') && tr.some((r) => r.war_system === 'FANGRAPHS'), 'both providers')
  assert.ok(tr.some((r) => r.return_coverage === 'COMPLETE') && tr.some((r) => r.return_coverage === 'PARTIAL') && tr.some((r) => r.return_coverage === 'NO_PLAYERS_RECEIVED'), 'COMPLETE, PARTIAL and no players received')
  assert.ok(tr.some((r) => r.return_war_known === null) && tr.some((r) => r.return_war_known !== null), 'known and not-observed returns')
  assert.ok(tr.some((r) => r.received_player_ids.length > 1) && tr.some((r) => r.sent_player_ids.length > 2), 'multi-player packages')
  assert.ok(tr.some((r) => r.organization_id !== r.counterparty_id) && new Set(tr.map((r) => r.transaction_id)).size >= 4, 'several transactions including the three-club trade')
  const ptbnl = await h.one(newDb, `select r.return_war_known::float8 w, r.received_player_ids from analytics.trade_returns r join transaction_external_ids x on x.transaction_id = r.transaction_id and x.external_id = 'PT-1'
    where r.war_system = 'BREF' and r.organization_id = (select id from organizations where franchise_key = 'LAD')`)
  assert.equal(ptbnl.w, 0.5 + 3, 'the in-player (0.5 in 2019, 2.5 for SEA not counted) and the player named in 2020 (2020 and 2021, not his 2019)')
  assert.equal(ptbnl.received_player_ids.length, 2)
  const av = await h.rows(newDb, 'select * from analytics.acquisition_value')
  assert.ok(av.some((r) => r.trade_package_id !== null) && av.some((r) => r.war_coverage === 'NOT_SIGNED') && av.some((r) => r.war_coverage === 'NO_MLB') && av.some((r) => r.war_coverage === 'CAREER_ONLY') && av.some((r) => r.war_coverage === 'PARTIAL'), 'trade ties, unsigned, no-MLB, career-only and partial coverage')
  const star = await h.one(newDb, `select r.return_war_known::float8 w from analytics.trade_returns r where r.war_system = 'BREF' and r.transaction_id = (select id from transactions where transaction_date = '2018-07-18')
    and r.organization_id = (select id from organizations where franchise_key = 'LAD')`)
  assert.equal(star.w, 1.5 + 2.0, 'the star counts for LAD until LAD traded him away (2018, 2019); his 2021 return is not this trade\'s return, his SD season is not LAD\'s')
})

test('the new views keep their grants: analytics stays closed to public roles', async () => {
  for (const role of ['anon', 'authenticated']) for (const v of VIEWS) await assert.rejects(h.asRole(newDb, role, () => newDb.query(`select 1 from analytics.${v} limit 1`)), /permission denied/)
  const defs = await h.rows(newDb, `select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'analytics' and c.relname = any ($1)`, [VIEWS])
  for (const d of defs) assert.ok(d.reloptions.includes('security_invoker=true'), d.relname)
})
