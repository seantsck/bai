// Coverage and rate integrity invariants (scripts/research/lib/integrity.mjs): hold on clean data, and each one detects a
// genuine violation. Violations are injected inside a transaction that is always rolled back; where the schema already
// forbids the state (CHECK constraints), the test shows that too, then removes the constraint inside the transaction to
// prove the invariant query is a real second line. FICTIONAL players and TEST_FIXTURE sources only.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import { integrityViolations, INTEGRITY_CHECKS } from '../../scripts/research/lib/integrity.mjs'

let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-integrity-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

let n = 0
async function run (doc, org) {
  const f = path.join(dir, `b-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', ...doc }))
  const { batch } = await P.stageFile(db, f, { organization: org })
  assert.ok((await P.validateBatch(db, batch.id)).ok)
  return P.applyBatch(db, batch.id, { write: true })
}
const src = { source_key: 'i:official', source_type: 'TEST_FIXTURE', authority_level: 'OFFICIAL', title: 'Integrity fixture' }
const keys = async () => (await integrityViolations(db)).map((v) => v.key).sort()
async function inTx (fn) {
  await db.query('begin')
  try { await fn(); return await keys() } finally { await db.query('rollback') }
}
async function dropCoverageChecks () {
  for (const { conname } of (await db.query("select conname from pg_constraint where conrelid = 'public.coverage_assessments'::regclass and contype = 'c'")).rows) {
    await db.query(`alter table public.coverage_assessments drop constraint ${conname}`)
  }
}

test('setup: a census draft cell and a partial international cell; the invariants hold', async () => {
  await run({ batch_key: 'int-draft', channel: 'DRAFT', sources: [src],
    coverage_claims: [{ scope_key: '2018-JUNE_AMATEUR', organization: 'CIN', coverage_state: 'COMPLETE_CENSUS', expected_count: 2, source_key: 'i:official' }],
    records: [1, 2].map((i) => ({ type: 'DRAFT_SELECTION', source_key: 'i:official', draft_key: '2018-JUNE_AMATEUR', round_code: String(i), overall_pick: i * 30, round_pick: 5,
      organization: 'CIN', player: { full_name: `Integrity Pick ${i}`, external_ids: { MLBAM: `983000${i}` } }, school: { name: 'Integrity U', school_type: 'COLLEGE' },
      signing: { status: 'SIGNED', bonus_usd: 100000 * i, source_key: 'i:official' } })) }, 'CIN')
  await run({ batch_key: 'int-intl', channel: 'INTERNATIONAL', sources: [src],
    coverage_claims: [{ scope_key: '2018-19', organization: 'CIN', coverage_state: 'PARTIAL_RECONSTRUCTION', source_key: 'i:official' }],
    records: [{ type: 'INTERNATIONAL_SIGNING', source_key: 'i:official', organization: 'CIN', signing_date: '2018-07-02', signing_date_precision: 'DAY', pathway: 'INTERNATIONAL_AMATEUR',
      player: { full_name: 'Integrity Signee', birth_date: '2002-01-01', external_ids: { MLBAM: '9830010' } }, costs: {} }] }, 'CIN')
  await db.query('select public.refresh_read_models()')
  assert.deepEqual(await keys(), [])
  assert.equal(INTEGRITY_CHECKS.length, 8)
})

test('an unsourced census claim: refused by the schema, and detected when the constraint is gone', async () => {
  await assert.rejects(inTx(() => db.query("update coverage_assessments set source_id = null where coverage_state = 'COMPLETE_CENSUS'")), /violates check constraint/)
  const found = await inTx(async () => { await dropCoverageChecks(); await db.query("update coverage_assessments set source_id = null where coverage_state = 'COMPLETE_CENSUS'") })
  assert.deepEqual(found, ['CENSUS_WITHOUT_SOURCED_UNIVERSE'])
})

test('a census that does not track its whole universe is detected', async () => {
  const found = await inTx(async () => { await dropCoverageChecks(); await db.query("update coverage_assessments set tracked_count = 1 where coverage_state = 'COMPLETE_CENSUS'") })
  assert.deepEqual(found, ['COMPLETE_CENSUS_COUNT_MISMATCH'])
})

test('a rate published for an uncertified or non-census class is detected', async () => {
  const def = (await db.query("select pg_get_viewdef('analytics.class_economics'::regclass, true) d")).rows[0].d.replace(/;\s*$/, '')
  const found = await inTx(() => db.query(`create or replace view analytics.class_economics as select channel, organization_id, scope_key, acquisitions, cost_known, known_cost_usd,
    known_slot_usd, audited, audited_reached_mlb, audited_war_bref, coverage_state, certified, true as rates_allowed, 0.5::numeric as mlb_reach_rate, cost_per_mlb_player from (${def}) o`))
  assert.deepEqual(found, ['RATE_WITHOUT_CENSUS', 'RATE_WITHOUT_CERTIFICATION'])
})

test('a partial reconstruction shown as rate-capable or as complete in the public read model is detected', async () => {
  assert.deepEqual(await inTx(() => db.query("update rm_research_coverage set supports_population_rate = true where coverage_state = 'PARTIAL_RECONSTRUCTION'")), ['PARTIAL_PRESENTED_AS_COMPLETE'])
  assert.deepEqual(await inTx(() => db.query("update rm_research_coverage set coverage_state = 'COMPLETE_CENSUS' where coverage_state = 'PARTIAL_RECONSTRUCTION'")), ['PARTIAL_PRESENTED_AS_COMPLETE'])
  assert.deepEqual(await keys(), [], 'every injection was rolled back')
})

test('a certification that no reviewer session made is detected, even with the guards removed', async () => {
  const found = await inTx(async () => {
    await db.query("insert into research.classes (class_key, organization_id, channel_key, scope_key, draft_id, created_by) select 'CIN/DRAFT/2018-JUNE_AMATEUR', o.id, 'DRAFT', '2018-JUNE_AMATEUR', d.id, 'test' from organizations o, drafts d where o.franchise_key = 'CIN' and d.draft_key = '2018-JUNE_AMATEUR'")
    await db.query('alter table research.certifications disable trigger certifications_guard')
    await db.query("insert into research.certifications (class_id, certified_by, coverage_state, report) select id, 'Somebody', 'COMPLETE_CENSUS', '{}' from research.classes where scope_key = '2018-JUNE_AMATEUR'")
  })
  assert.deepEqual(found, ['CERTIFICATION_WITHOUT_REVIEWER_SESSION'])
})

test('value credited to an acquisition that did not sign is detected', async () => {
  const def = (await db.query("select pg_get_viewdef('analytics.acquisition_value'::regclass, true) d")).rows[0].d.replace(/;\s*$/, '')
  const found = await inTx(async () => {
    await db.query("update draft_signings set signing_status = 'DID_NOT_SIGN', signing_bonus_usd = null where signing_bonus_usd = 100000")
    await db.query(`create or replace view analytics.acquisition_value as select channel, organization_id, scope_key, player_id, signing_status, acquisition_cost_usd, slot_value_usd, credited, war_system,
      war_coverage, through_season, observed_on, career_war, career_through_season, disposition, disposition_date, tenure_end_known, coalesce(original_org_war, 1.0) as original_org_war, returning_stint_war,
      other_org_war, trade_package_id, traded_on, trade_package_players, trade_package_return_war, trade_return_coverage, audit_state, debut_date, debut_age, debut_organization_id, first_affiliated_season,
      acquisition_season, seasons_to_debut from (${def}) v`)
  })
  assert.deepEqual(found, ['UNSIGNED_ACQUISITION_CREDITED'])
})

test('two overlapping signed acquisitions of one player by one club are detected', async () => {
  const found = await inTx(async () => {
    await db.query(`update international_signings set player_id = (select s.player_id from draft_selections s where s.overall_pick = 30 and s.organization_id = (select id from organizations where franchise_key = 'CIN'))`)
  })
  assert.deepEqual(found, ['OVERLAPPING_SIGNED_ACQUISITIONS'])
  assert.deepEqual(await keys(), [], 'every injection was rolled back')
})
