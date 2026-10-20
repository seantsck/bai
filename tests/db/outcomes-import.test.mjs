// Outcome audits through ingestion (migration 020, OUTCOMES channel). FICTIONAL players and TEST_FIXTURE sources only.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as B from '../../scripts/research/lib/backfill.mjs'

let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-outcomes-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const src = (key, authority = 'OFFICIAL') => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: authority, title: `Test source ${key}` })
let n = 0
const file = (doc) => { const f = path.join(dir, `b-${++n}.json`); fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', sources: [], ...doc })); return f }
async function stage (doc, org = 'SEA') {
  const { batch } = await P.stageFile(db, file(doc), { organization: org })
  return { batch, validation: await P.validateBatch(db, batch.id) }
}
async function run (doc, org = 'SEA') {
  const s = await stage(doc, org)
  assert.ok(s.validation.ok, JSON.stringify(s.validation.counts))
  return P.applyBatch(db, s.batch.id, { write: true })
}
const audit = (o) => ({ type: 'OUTCOME_AUDIT', source_key: 'o:mlb', organization: 'SEA', audited_on: '2026-10-20', observation_through_season: 2026, ...o })
const ALPHA = { full_name: 'Outcome Alpha', external_ids: { MLBAM: '9820001' } }
const BETA = { full_name: 'Outcome Beta', external_ids: { MLBAM: '9820002' } }

test('setup: two fictional SEA 2017 picks and their class', async () => {
  await run({ batch_key: 'sea-2017', channel: 'DRAFT', sources: [src('o:mlb')], records: [
    { type: 'DRAFT_SELECTION', source_key: 'o:mlb', draft_key: '2017-JUNE_AMATEUR', round_code: '1', overall_pick: 14, round_pick: 14, organization: 'SEA', player: ALPHA, school: { name: 'Outcome U', school_type: 'COLLEGE' }, signing: { status: 'SIGNED', bonus_usd: 3000000, source_key: 'o:mlb' } },
    { type: 'DRAFT_SELECTION', source_key: 'o:mlb', draft_key: '2017-JUNE_AMATEUR', round_code: '5', overall_pick: 150, round_pick: 14, organization: 'SEA', player: BETA, school: { name: 'Outcome U', school_type: 'COLLEGE' }, signing: { status: 'SIGNED', bonus_usd: 200000, source_key: 'o:mlb' } }] })
  await B.createClass(db, { org: 'SEA', channel: 'draft', year: 2017 }, { actor: 't' })
  await B.planClass(db, { org: 'SEA', channel: 'draft', year: 2017 }, { actor: 't' })
  const jobs = await h.rows(db, "select state from research.jobs where category_key = 'OUTCOME_NOT_AUDITED' and job_key like 'SEA/DRAFT/2017%'")
  assert.equal(jobs.length, 2)
})

test('outcome records never create players and refuse NOT_AUDITED or inconsistent audits', async () => {
  const ghost = await stage({ batch_key: 'ghost', channel: 'OUTCOMES', sources: [src('o:mlb')], records: [audit({ audit_state: 'AUDITED_NO_MLB', player: { full_name: 'Not Here', external_ids: { MLBAM: '9829999' } } })] })
  assert.equal(ghost.validation.ok, false)
  const errs = await h.one(db, "select validation_errors from ingest.staged_records r join ingest.import_batches b on b.id = r.batch_id where b.batch_key = 'ghost'")
  assert.match(errs.validation_errors.join(' '), /does not hold/)
  await assert.rejects(P.stageFile(db, file({ batch_key: 'bad-state', channel: 'OUTCOMES', sources: [src('o:mlb')], records: [audit({ audit_state: 'NOT_AUDITED', player: ALPHA })] }), { organization: 'SEA' }).then(async ({ batch }) => {
    const v = await P.validateBatch(db, batch.id); if (!v.ok) throw new Error('invalid')
  }), /invalid/)
  const mixed = await stage({ batch_key: 'mixed', channel: 'OUTCOMES', sources: [src('o:mlb')], records: [
    audit({ audit_state: 'AUDITED_REACHED_MLB', player: ALPHA }),
    audit({ audit_state: 'AUDITED_NO_MLB', player: BETA, debut: { date: '2020-05-01', organization: 'SEA' } })] })
  assert.equal(mixed.validation.counts.invalid, 2, 'reached needs a debut; no-MLB cannot carry one')
})

test('audits, debut, details, WAR per provider and trades apply once; re-applying changes nothing', async () => {
  const doc = { batch_key: 'sea-2017-outcomes', channel: 'OUTCOMES', sources: [src('o:mlb'), src('o:bref', 'AGGREGATOR'), src('o:fg', 'AGGREGATOR')], records: [
    audit({ audit_state: 'AUDITED_REACHED_MLB', player: ALPHA, debut: { date: '2020-07-24', organization: 'SEA' },
      transactions: [{ ref: 'trade-1', type: 'TRADE', date: '2022-03-15', from_organization: 'SEA', to_organization: 'NYY', description: 'SEA traded Outcome Alpha to NYY' }],
      details: { as_of_date: '2026-10-20', reached_affiliated: true, first_affiliated_season: 2017, mlb_games: 300, mlb_plate_appearances: 1100, current_status: 'WITH_OTHER_ORGANIZATION', disposition: 'TRADED', disposition_transaction_ref: 'trade-1' },
      war: [{ system: 'BREF', scope: 'CAREER', through_season: 2026, value: 6.4, observed_on: '2026-10-20', source_key: 'o:bref' },
        { system: 'FANGRAPHS', scope: 'CAREER', through_season: 2026, value: 5.9, observed_on: '2026-10-20', source_key: 'o:fg' }] }),
    audit({ audit_state: 'AUDITED_NO_MLB', player: BETA, details: { as_of_date: '2026-10-20', reached_affiliated: true, first_affiliated_season: 2017, current_status: 'INACTIVE', disposition: 'RELEASED' } })] }
  const r = await run(doc)
  assert.deepEqual(r.report.actions, { INSERT: 2 })
  const prof = await h.rows(db, `select x.external_id, o.audit_state, o.debut_date::text d, o.debut_age, o.career_war_bref::float8 b, o.career_war_fangraphs::float8 f, o.disposition, o.disposition_transaction_id is not null traded
    from analytics.player_outcome_profile o join player_external_ids x on x.player_id = o.player_id and x.id_system = 'MLBAM' where x.external_id in ('9820001', '9820002') order by 1`)
  assert.deepEqual(prof.map((p) => [p.external_id, p.audit_state, p.d, p.b, p.f, p.disposition, p.traded]),
    [['9820001', 'AUDITED_REACHED_MLB', '2020-07-24', 6.4, 5.9, 'TRADED', true], ['9820002', 'AUDITED_NO_MLB', null, null, null, 'RELEASED', false]])
  const trade = await h.one(db, "select p.from_organization_id <> p.to_organization_id ok, a.player_id is not null player from trade_packages p join trade_package_assets a on a.trade_package_id = p.id")
  assert.deepEqual(trade, { ok: true, player: true })
  // Re-apply: identical facts change nothing.
  const again = await P.applyBatch(db, r.batch.id, { write: true })
  assert.deepEqual(again.report.actions, { NO_CHANGE: 2 })
  assert.equal((await h.one(db, 'select count(*)::int n from transactions')).n, 1)
  // The planner closes both outcome jobs: audited (even with no MLB) is resolved; NOT_AUDITED was the absence of an audit.
  await B.planClass(db, { org: 'SEA', channel: 'draft', year: 2017 }, { actor: 't' })
  assert.deepEqual((await h.rows(db, "select state from research.jobs where category_key = 'OUTCOME_NOT_AUDITED' and job_key like 'SEA/DRAFT/2017%'")).map((j) => j.state), ['DONE', 'DONE'])
  const econ = await h.rows(db, "select reached_mlb from analytics.acquisition_economics e join player_external_ids x on x.player_id = e.player_id and x.id_system = 'MLBAM' where x.external_id in ('9820001', '9820002') order by x.external_id")
  assert.deepEqual(econ.map((e) => e.reached_mlb), [true, false])
  const rates = await h.one(db, "select rates_allowed, mlb_reach_rate from analytics.class_economics e join organizations o on o.id = e.organization_id where o.franchise_key = 'SEA' and scope_key = '2017-JUNE_AMATEUR'")
  assert.deepEqual(rates, { rates_allowed: false, mlb_reach_rate: null }, 'no rate without census coverage and certification')
})

test('a rival WAR value or debut date is a conflict, never an overwrite', async () => {
  const r = await run({ batch_key: 'sea-2017-outcomes-rival', channel: 'OUTCOMES', sources: [src('o:blog', 'OTHER')], records: [
    audit({ source_key: 'o:blog', audit_state: 'AUDITED_REACHED_MLB', player: ALPHA, debut: { date: '2020-07-25', organization: 'SEA', source_key: 'o:blog' },
      war: [{ system: 'BREF', scope: 'CAREER', through_season: 2026, value: 6.1, observed_on: '2026-10-21', source_key: 'o:blog' }] })] })
  assert.deepEqual(r.report.actions, { CONFLICT: 1 })
  const cur = await h.one(db, "select d.debut_date::text d, w.war_value::float8 w from mlb_debuts d join war_observations w on w.player_id = d.player_id and w.war_system = 'BREF' join player_external_ids x on x.player_id = d.player_id where x.external_id = '9820001'")
  assert.deepEqual(cur, { d: '2020-07-24', w: 6.4 })
  const open = (await P.openConflicts(db)).map((c) => `${c.subject_table}.${c.field_name}`).sort()
  assert.deepEqual(open, ['mlb_debuts.debut_date', 'war_observations.war_value'])
})
