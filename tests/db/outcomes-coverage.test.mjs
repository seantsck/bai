// Outcomes (unaudited != failed, missing WAR != 0) and coverage-state semantics (tracked != complete population).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

let db, src
before(async () => {
  await h.startServer(); db = await h.freshDatabase({ fixtures: true })
  src = (await h.one(db, "select id from sources where source_key = 'fixture:foundation'")).id
}, { timeout: 120000 })
after(async () => { await h.stopServer() })

const pid = async (slug) => (await h.one(db, 'select id from players where slug = $1', [slug])).id

test('a player with no audit is NOT_AUDITED and is never counted as a failure', async () => {
  const status = await h.one(db, 'select audit_state, career_bwar from v_player_outcome_status where player_id = $1', [await pid('fixture-amateur-signee')])
  assert.deepEqual(status, { audit_state: 'NOT_AUDITED', career_bwar: null })
  const lad = await h.one(db, `select * from analytics.acquisition_outcome_summary s join organizations o on o.id = s.organization_id
    where o.franchise_key = 'LAD' and channel = 'INTERNATIONAL'`)
  assert.equal(Number(lad.audited_no_mlb), 0)
  assert.equal(Number(lad.not_audited), 1)
})

test('all six outcome states are representable; audited states need a through-season and a source', async () => {
  const states = (await h.rows(db, "select unnest(enum_range(null::outcome_audit_state))::text s")).map((r) => r.s)
  assert.deepEqual(states, ['NOT_AUDITED', 'AUDITED_REACHED_MLB', 'AUDITED_NO_MLB', 'ACTIVE_TOO_RECENT', 'OUT_OF_SCOPE', 'UNKNOWN'])
  const p = await pid('fixture-amateur-signee')
  await h.rejects(db, "insert into outcome_audits (player_id, audit_state, audited_on, source_id) values ($1, 'AUDITED_NO_MLB', current_date, $2)", [p, src], /outcome_audits_check/)
  await h.rejects(db, "insert into outcome_audits (player_id, audit_state, observation_through_season, audited_on) values ($1, 'AUDITED_NO_MLB', 2025, current_date)", [p], /outcome_audits_check/)
})

test('audit state must agree with debut facts', async () => {
  const p = await pid('fixture-amateur-signee')
  await h.rejects(db, "insert into outcome_audits (player_id, audit_state, observation_through_season, audited_on, source_id) values ($1, 'AUDITED_REACHED_MLB', 2025, current_date, $2)", [p, src], /inconsistent with debut/)
  const arm = await pid('fixture-college-arm')
  await h.rejects(db, "insert into outcome_audits (player_id, audit_state, observation_through_season, audited_on, source_id) values ($1, 'AUDITED_NO_MLB', 2024, current_date, $2)", [arm, src], /inconsistent with debut/)
  // NO_MLB through 2022 is consistent with a 2023 debut (the audit observed only through 2022)
  await db.query("insert into outcome_audits (player_id, audit_state, observation_through_season, audited_on, source_id) values ($1, 'AUDITED_NO_MLB', 2022, '2023-01-10', $2)", [arm, src])
  const cur = await h.one(db, 'select audit_state from v_player_outcome_status where player_id = $1', [arm])
  assert.equal(cur.audit_state, 'AUDITED_REACHED_MLB', 'the latest observation window is current')
  await h.rejects(db, 'delete from mlb_debuts where player_id = $1', [arm], /inconsistent with debut/)
})

test('missing WAR is never zero: no observation means NULL, and war_value cannot be NULL', async () => {
  const p = await pid('fixture-two-time-draftee')
  assert.equal((await h.one(db, 'select career_bwar from v_player_outcome_status where player_id = $1', [p])).career_bwar, null)
  await h.rejects(db, "insert into war_observations (player_id, war_system, scope, through_season, war_value, observed_on, source_id) values ($1, 'BREF', 'CAREER', 2025, null, current_date, $2)", [p, src], /war_value/)
  // career and organization-tenure value are separate observations for the same player
  const arm = await h.rows(db, "select scope::text, war_value from war_observations where player_id = $1 order by scope", [await pid('fixture-college-arm')])
  assert.deepEqual(arm.map((r) => r.scope), ['CAREER', 'ORGANIZATION_TENURE'])
})

test('coverage states: COMPLETE_CENSUS requires a matched known population and a source', async () => {
  const ins = 'insert into coverage_assessments (domain, scope_key, coverage_state, tracked_count, expected_count, sample_basis, gap_notes, assessed_on, source_id) values ($1, $2, $3, $4, $5, $6, $7, current_date, $8)'
  await h.rejects(db, ins, ['DRAFT', 'cc-1', 'COMPLETE_CENSUS', 10, null, null, null, src], /coverage_assessments_check/)
  await h.rejects(db, ins, ['DRAFT', 'cc-2', 'COMPLETE_CENSUS', 9, 10, null, null, src], /coverage_assessments_check/)
  await h.rejects(db, ins, ['DRAFT', 'cc-3', 'COMPLETE_CENSUS', 10, 10, null, null, null], /coverage_assessments_check/)
  await db.query(ins, ['DRAFT', 'cc-4', 'COMPLETE_CENSUS', 10, 10, null, null, src])
  await h.rejects(db, ins, ['DRAFT', 'sc-1', 'SUBSTANTIALLY_COMPLETE', 9, 10, null, null, src], /coverage_assessments_check/)
  await db.query(ins, ['DRAFT', 'sc-2', 'SUBSTANTIALLY_COMPLETE', 9, 10, null, 'one pick unresolved', src])
  await h.rejects(db, ins, ['INTERNATIONAL', 'rs-1', 'RANKED_SAMPLE', 5, null, null, null, src], /coverage_assessments_check/)
  await h.rejects(db, ins, ['DRAFT', 'over', 'PARTIAL_RECONSTRUCTION', 11, 10, null, null, null], /coverage_assessments_check/)
  await db.query(ins, ['DRAFT', 'unknown-1', 'UNKNOWN', 3, null, null, null, null])
})

test('only census-grade coverage supports population rates (tracked != complete population)', async () => {
  const r = await h.rows(db, "select s::text, coverage_supports_population_rate(s) ok from unnest(enum_range(null::coverage_state)) s")
  assert.deepEqual(Object.fromEntries(r.map((x) => [x.s, x.ok])), {
    COMPLETE_CENSUS: true, SUBSTANTIALLY_COMPLETE: true, PARTIAL_RECONSTRUCTION: false, RANKED_SAMPLE: false, INDIVIDUALLY_VERIFIED: false, UNKNOWN: false
  })
  assert.equal((await h.one(db, 'select coverage_supports_population_rate(null) ok')).ok, false)
})
