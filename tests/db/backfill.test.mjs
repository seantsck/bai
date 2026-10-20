// League-wide backfill framework: classes, stages, jobs, deterministic queue, resumable batches, blockers, dependencies,
// certification (draft and international), outcomes, economics gates, organization isolation, automation safety and the
// public/private boundary. All players and sources are FICTIONAL test data (TEST_FIXTURE sources, MLBAM ids 98xxxxx);
// the organizations and calendars are the real seeded ones. Classes deliberately use NYY and SEA, not LAD.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as B from '../../scripts/research/lib/backfill.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-backfill-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const ME = 'tester'
const src = (key, authority = 'OFFICIAL') => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: authority, title: `Test source ${key}` })
let n = 0
function file (doc) {
  const f = path.join(dir, `batch-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', sources: [], ...doc }))
  return f
}
async function run (doc, { org = null, operator = 'cli', write = true } = {}) {
  const { batch } = await P.stageFile(db, file(doc), { organization: org, operator })
  const v = await P.validateBatch(db, batch.id)
  assert.ok(v.ok, JSON.stringify(v.counts))
  return { batch, ...(await P.applyBatch(db, batch.id, { write })) }
}
const pick = (o) => ({
  type: 'DRAFT_SELECTION', source_key: 't:official', draft_key: '2016-JUNE_AMATEUR', organization: 'NYY', position: 'RHP',
  school: { name: `Fixture College ${o.overall_pick}`, school_type: 'COLLEGE', country: 'USA' }, ...o
})
const signing = (o) => ({ type: 'INTERNATIONAL_SIGNING', source_key: 't:official', organization: 'NYY', signing_date: '2016-07-02', signing_date_precision: 'DAY', pathway: 'INTERNATIONAL_AMATEUR', costs: {}, ...o })
const NYY_DRAFT = { org: 'NYY', channel: 'draft', year: 2016 }
const NYY_INTL = { org: 'NYY', channel: 'international', period: '2016-17' }
const jobsOf = async (classKey) => h.rows(db, 'select j.job_key, j.category_key, j.state, j.subject_label from research.jobs j join research.classes c on c.id = j.class_id where c.class_key = $1 order by j.job_key', [classKey])
const toReview = async (scope) => { for (let i = 0; i < 7; i++) await B.advanceStage(db, scope, { actor: ME }) }

test('all 30 organizations: every franchise can hold a class in either channel; history names resolve to one franchise', async () => {
  const orgs = await h.rows(db, 'select franchise_key from organizations where active and mlb_team_id is not null order by 1')
  assert.equal(orgs.length, 30)
  for (const o of orgs) {
    const d = await B.classScope(db, { org: o.franchise_key, channel: 'draft', year: 2019 })
    const i = await B.classScope(db, { org: o.franchise_key, channel: 'international', period: '2019-20' })
    assert.equal(d.classKey, `${o.franchise_key}/DRAFT/2019-JUNE_AMATEUR`)
    assert.equal(i.classKey, `${o.franchise_key}/INTERNATIONAL/2019-20`)
  }
  const key = async (name, season = null) => (await h.one(db, 'select o.franchise_key k from organizations o where o.id = resolve_organization($1, $2)', [name, season]))?.k ?? null
  assert.equal(await key('Florida Marlins', 2010), 'MIA')
  assert.equal(await key('Miami Marlins', 2016), 'MIA')
  assert.equal(await key('Florida Marlins', 2016), null, 'a name outside its seasons is refused, not guessed')
  assert.equal(await key('Tampa Bay Devil Rays', 2005), 'TB')
  assert.equal(await key('Montreal Expos', 2004), 'WSH')
  assert.equal(await key('Cleveland Indians', 2019), 'CLE')
  assert.equal(await key('Oakland Athletics', 2020), 'ATH')
  assert.equal(await key('FLA'), 'MIA')
  assert.equal(await key('Nowhere Nine'), null)
  assert.equal((await h.one(db, "select count(distinct organization_id)::int n from organization_names where name in ('Florida Marlins', 'Miami Marlins')")).n, 1, 'one franchise, two names')
  await assert.rejects(B.classScope(db, { org: 'Florida Marlins', channel: 'draft', year: 2016 }), /unknown or ambiguous/)
})

test('no club is hard-coded: the framework code never names a franchise', () => {
  for (const f of ['scripts/research/lib/backfill.mjs', 'scripts/research/cli.mjs']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    assert.doesNotMatch(s, /['"`](LAD|NYY|Dodgers)['"`]/, f)
  }
  const m = fs.readFileSync(path.join(root, 'database/migrations/019_research_backfill.sql'), 'utf8')
  assert.deepEqual([...m.matchAll(/'LAD'/g)].length, 1, 'LAD appears once, as program-wave data, not logic')
})

test('class creation: organization and scope are required, channels must be implemented, scope must match, creation is idempotent', async () => {
  await assert.rejects(B.classScope(db, { channel: 'draft', year: 2016 }), /organization is required/)
  await assert.rejects(B.classScope(db, { org: 'NYY', channel: 'draft' }), /--year/)
  await assert.rejects(B.classScope(db, { org: 'NYY', channel: 'international', period: '2099' }), /no signing period/)
  await assert.rejects(B.classScope(db, { org: 'NYY', channel: 'rule_5', year: 2016 }), /not implemented/)
  const a = await B.createClass(db, { org: 'SEA', channel: 'draft', year: 2016 }, { actor: ME })
  const b = await B.createClass(db, { org: 'SEA', channel: 'draft', year: 2016 }, { actor: ME })
  assert.equal(a.created, true)
  assert.equal(b.created, false)
  assert.equal(a.cls.stage, 'DISCOVERY')
  await h.rejects(db, "insert into research.classes (class_key, organization_id, channel_key, signing_period_id, scope_key, created_by) select 'SEA/DRAFT/bad', id, 'DRAFT', (select min(id) from international_signing_periods), 'bad', 't' from organizations where franchise_key = 'SEA'", [], /scope does not match/)
  await h.rejects(db, "insert into research.classes (class_key, organization_id, channel_key, season, scope_key, created_by) select 'SEA/RULE_5/2016', id, 'RULE_5', 2016, '2016', 't' from organizations where franchise_key = 'SEA'", [], /not implemented/)
})

test('draft class: planner jobs follow the data, are idempotent, and close themselves when the data resolves them', async () => {
  await run({ batch_key: 'nyy-2016-a', channel: 'DRAFT', sources: [src('t:official')], records: [
    pick({ overall_pick: 18, round_code: '1', round_pick: 18, player: { full_name: 'Fixture Alpha', external_ids: { MLBAM: '9810001' } }, signing: { status: 'SIGNED', bonus_usd: 2000000, source_key: 't:official' }, slot_value: { usd: 2200000, source_key: 't:official' } }),
    pick({ overall_pick: 60, round_code: '2', round_pick: 30, player: { full_name: 'Fixture Beta', external_ids: { MLBAM: '9810002' } }, signing: { status: 'UNKNOWN' } }),
    pick({ overall_pick: 500, round_code: '16', round_pick: 20, school: undefined, player: { full_name: 'Fixture Gamma', external_ids: { MLBAM: '9810003' } }, signing: { status: 'SIGNED', bonus_usd: null, source_key: 't:official' } })] }, { org: 'NYY' })
  const { cls } = await B.createClass(db, NYY_DRAFT, { actor: ME })
  const p1 = await B.planClass(db, NYY_DRAFT, { actor: ME })
  const cats = (await jobsOf(cls.class_key)).map((j) => `${j.category_key}:${j.subject_label}`)
  for (const c of ['EXPECTED_UNIVERSE_UNKNOWN:class', 'SIGNING_STATUS_UNKNOWN:pick-60', 'SLOT_VALUE_MISSING:pick-60', 'ACQUISITION_COST_MISSING:pick-500', 'SCHOOL_MISSING:pick-500',
    'OUTCOME_NOT_AUDITED:player-mlbam-9810001', 'COVERAGE_CERTIFICATION:class']) assert.ok(cats.includes(c), c)
  assert.ok(!cats.some((c) => c.startsWith('CLASS_NOT_RECONSTRUCTED')), 'tracked with an unknown universe: not flagged as unreconstructed')
  assert.ok(!cats.includes('SLOT_VALUE_MISSING:pick-500'), 'no slot job after round 10')
  const p2 = await B.planClass(db, NYY_DRAFT, { actor: ME })
  assert.deepEqual([p2.created, p2.closed, p2.reopened], [0, 0, 0], 'planning is idempotent')
  assert.ok(p1.created >= 7)
  // New evidence: pick 60 signed with a bonus and a slot; the planner closes those jobs as resolved in data.
  await run({ batch_key: 'nyy-2016-b', channel: 'DRAFT', sources: [src('t:official')], records: [
    pick({ overall_pick: 60, round_code: '2', round_pick: 30, player: { full_name: 'Fixture Beta', external_ids: { MLBAM: '9810002' } }, signing: { status: 'SIGNED', bonus_usd: 900000, source_key: 't:official' }, slot_value: { usd: 1000000, source_key: 't:official' } })] }, { org: 'NYY' })
  const p3 = await B.planClass(db, NYY_DRAFT, { actor: ME })
  assert.equal(p3.closed, 2)
  const closed = (await jobsOf(cls.class_key)).filter((j) => j.subject_label === 'pick-60')
  assert.ok(closed.every((j) => j.state === 'DONE'))
  const ev = await h.rows(db, `select e.to_state, e.actor, e.note from research.job_events e join research.jobs j on j.id = e.job_id where j.job_key = $1 order by e.id`, [`${cls.class_key}/SIGNING_STATUS_UNKNOWN/pick-60`])
  assert.deepEqual(ev.map((e) => e.to_state), ['OPEN', 'DONE'])
  assert.equal(ev[1].actor, ME)
})

test('stages: one step at a time, never skipped, CERTIFIED only through certification, moving back needs a rationale', async () => {
  await h.rejects(db, "update research.classes set stage = 'FINANCIALS' where class_key = 'NYY/DRAFT/2016-JUNE_AMATEUR'", [], /skips a stage/)
  await h.rejects(db, "update research.classes set stage = 'CERTIFIED' where class_key = 'NYY/DRAFT/2016-JUNE_AMATEUR'", [], /CERTIFIED needs|skips/)
  const r = await B.advanceStage(db, NYY_DRAFT, { actor: ME })
  assert.deepEqual([r.from, r.to], ['DISCOVERY', 'ROSTER_RECONSTRUCTION'])
  assert.ok(r.openJobsBefore >= 1, 'moving on with open discovery work is allowed and recorded')
  await assert.rejects(B.advanceStage(db, NYY_DRAFT, { actor: ME, to: 'DISCOVERY' }), /--rationale/)
  await B.advanceStage(db, NYY_DRAFT, { actor: ME, to: 'DISCOVERY', rationale: 'universe question first' })
  await assert.rejects(B.advanceStage(db, NYY_DRAFT, { actor: ME, to: 'SIGNING_STATUS' }), /skips a stage/)
  const log = await h.rows(db, "select from_stage, to_stage, open_jobs from research.stage_events e join research.classes c on c.id = e.class_id where c.class_key = 'NYY/DRAFT/2016-JUNE_AMATEUR' order by e.id")
  assert.deepEqual(log.map((l) => `${l.from_stage}>${l.to_stage}`), ['null>DISCOVERY', 'DISCOVERY>ROSTER_RECONSTRUCTION', 'ROSTER_RECONSTRUCTION>DISCOVERY'])
  assert.ok(log[1].open_jobs.DISCOVERY >= 1)
})

test('certification (draft): fails with explicit blockers, then passes once every requirement is met; coverage is unchanged by it', async () => {
  const first = await B.certify(db, NYY_DRAFT, { actor: ME })
  assert.equal(first.certified, false)
  const codes = first.blockers.map((b) => b.code)
  for (const c of ['STAGE', 'EXPECTED_UNIVERSE', 'COST', 'SCHOOL', 'OPEN_JOBS']) assert.ok(codes.includes(c), c)
  assert.equal(B.certify.length, 3, 'certify(db, class, { actor }): there is no force option')
  // A sourced census claim establishes the universe (through ingestion, never by hand).
  await run({ batch_key: 'nyy-2016-census', channel: 'DRAFT', sources: [src('t:official'), src('t:tracker')],
    coverage_claims: [{ scope_key: '2016-JUNE_AMATEUR', organization: 'NYY', coverage_state: 'COMPLETE_CENSUS', expected_count: 3, source_key: 't:tracker' }],
    records: [pick({ overall_pick: 18, round_code: '1', round_pick: 18, player: { full_name: 'Fixture Alpha', external_ids: { MLBAM: '9810001' } } })] }, { org: 'NYY' })
  await B.planClass(db, NYY_DRAFT, { actor: ME })
  const k = (cat, label) => `NYY/DRAFT/2016-JUNE_AMATEUR/${cat}/${label}`
  await assert.rejects(B.setJobState(db, k('ACQUISITION_COST_MISSING', 'pick-500'), 'UNRESOLVED', { actor: ME }), /--rationale/)
  await B.setJobState(db, k('ACQUISITION_COST_MISSING', 'pick-500'), 'UNRESOLVED', { actor: ME, rationale: 'no published bonus in tracker, club release or reference database (searched 2026-10-20)' })
  await B.setJobState(db, k('SCHOOL_MISSING', 'pick-500'), 'UNRESOLVED', { actor: ME, rationale: 'drafted out of an independent program; no school listed anywhere' })
  await toReview(NYY_DRAFT)
  const ready = await h.one(db, "select s.workflow_status from research.v_class_status s join research.classes c on c.id = s.class_id where c.class_key = 'NYY/DRAFT/2016-JUNE_AMATEUR'")
  assert.equal(ready.workflow_status, 'READY_FOR_REVIEW', 'open outcome audits do not hold a class back from review')
  const ok = await B.certify(db, NYY_DRAFT, { actor: ME })
  assert.equal(ok.certified, true, JSON.stringify(ok.blockers))
  assert.equal(ok.coverage_state, 'COMPLETE_CENSUS')
  const st = await h.one(db, "select s.workflow_status, c.stage from research.v_class_status s join research.classes c on c.id = s.class_id where c.class_key = 'NYY/DRAFT/2016-JUNE_AMATEUR'")
  assert.deepEqual(st, { workflow_status: 'CERTIFIED', stage: 'CERTIFIED' })
  const bonus = await h.one(db, "select g.signing_bonus_usd from draft_signings g join draft_selections s on s.id = g.draft_selection_id join drafts d on d.id = s.draft_id where d.draft_year = 2016 and s.overall_pick = 500")
  assert.equal(bonus.signing_bonus_usd, null, 'explicitly unknown stays unknown, never zero')
  await h.rejects(db, "update research.classes set stage = 'COVERAGE_REVIEW' where class_key = 'NYY/DRAFT/2016-JUNE_AMATEUR'", [], /revoke the certification/)
  await assert.rejects(B.revokeCertification(db, NYY_DRAFT, { actor: 'agent:x', reason: 'r' }), /agent cannot revoke/)
  await assert.rejects(B.revokeCertification(db, NYY_DRAFT, { actor: ME }), /--reason/)
  await B.revokeCertification(db, NYY_DRAFT, { actor: ME, reason: 'review found a transcription error' })
  assert.equal((await h.one(db, "select stage from research.classes where class_key = 'NYY/DRAFT/2016-JUNE_AMATEUR'")).stage, 'COVERAGE_REVIEW')
  assert.equal((await B.certify(db, NYY_DRAFT, { actor: ME })).certified, true, 'a revoked class can be certified again once checks pass')
  assert.equal((await h.one(db, "select count(*)::int n from research.certifications c join research.classes k on k.id = c.class_id where k.class_key = 'NYY/DRAFT/2016-JUNE_AMATEUR' and c.revoked_at is not null")).n, 1, 'revocations stay on record')
  assert.equal(Number((await h.one(db, 'select refresh_research_certification() n')).n), 1)
  await h.asRole(db, 'anon', async () => {
    const r = await h.rows(db, 'select domain, scope_key, certified, coverage_state_at_certification from rm_research_certification')
    assert.deepEqual(r, [{ domain: 'DRAFT', scope_key: '2016-JUNE_AMATEUR', certified: true, coverage_state_at_certification: 'COMPLETE_CENSUS' }])
  })
})

test('international: an unknown universe is never inferred; the class can certify only while it stays PARTIAL_RECONSTRUCTION', async () => {
  await run({ batch_key: 'nyy-1617', channel: 'INTERNATIONAL', sources: [src('t:official')],
    coverage_claims: [{ scope_key: '2016-17', organization: 'NYY', coverage_state: 'PARTIAL_RECONSTRUCTION', gap_notes: 'no complete list published' }],
    records: [signing({ player: { full_name: 'Fixture Delta', external_ids: { MLBAM: '9810011' } }, costs: { signing_bonus_usd: 1500000 } }),
      signing({ player: { full_name: 'Fixture Epsilon', external_ids: { MLBAM: '9810012' } } })] }, { org: 'NYY' })
  await B.createClass(db, NYY_INTL, { actor: ME })
  await B.planClass(db, NYY_INTL, { actor: ME })
  const jobs = await jobsOf('NYY/INTERNATIONAL/2016-17')
  assert.ok(jobs.some((j) => j.category_key === 'EXPECTED_UNIVERSE_UNKNOWN'))
  assert.ok(jobs.some((j) => j.category_key === 'ACQUISITION_COST_MISSING' && j.subject_label === 'signing-player-mlbam-9810012'))
  await toReview(NYY_INTL)
  const blocked = await B.certify(db, NYY_INTL, { actor: ME })
  assert.ok(blocked.blockers.some((b) => b.code === 'EXPECTED_UNIVERSE'), 'an unknown universe must be recorded as unknown after research')
  const base = 'NYY/INTERNATIONAL/2016-17'
  await B.setJobState(db, `${base}/EXPECTED_UNIVERSE_UNKNOWN/class`, 'UNRESOLVED', { actor: ME, rationale: 'no authoritative complete list of 2016-17 signings exists' })
  await B.setJobState(db, `${base}/ACQUISITION_COST_MISSING/signing-player-mlbam-9810012`, 'UNRESOLVED', { actor: ME, rationale: 'bonus never reported' })
  const ok = await B.certify(db, NYY_INTL, { actor: ME })
  assert.equal(ok.certified, true, JSON.stringify(ok.blockers))
  assert.equal(ok.coverage_state, 'PARTIAL_RECONSTRUCTION', 'two verified rows do not make a census')
  const cov = await h.one(db, "select coverage_state, expected_count from coverage_assessments c join organizations o on o.id = c.organization_id where o.franchise_key = 'NYY' and scope_key = '2016-17'")
  assert.deepEqual(cov, { coverage_state: 'PARTIAL_RECONSTRUCTION', expected_count: null })
  // A class whose coverage claims more than the evidence supports is not certifiable.
  await run({ batch_key: 'sea-1617', channel: 'INTERNATIONAL', sources: [src('t:official')],
    records: [signing({ organization: 'SEA', player: { full_name: 'Fixture Zeta', external_ids: { MLBAM: '9810021' } }, costs: { signing_bonus_usd: 10000 } })] }, { org: 'SEA' })
  const sea = { org: 'SEA', channel: 'international', period: '2016-17' }
  await B.createClass(db, sea, { actor: ME })
  await B.planClass(db, sea, { actor: ME })
  await B.setJobState(db, 'SEA/INTERNATIONAL/2016-17/EXPECTED_UNIVERSE_UNKNOWN/class', 'UNRESOLVED', { actor: ME, rationale: 'no complete list exists' })
  await toReview(sea)
  const r = await B.certify(db, sea, { actor: ME })
  assert.ok(r.blockers.some((b) => b.code === 'COVERAGE' && /PARTIAL_RECONSTRUCTION/.test(b.detail)), JSON.stringify(r.blockers))
})

test('deterministic priority: documented order, identical on every call, program waves are data', async () => {
  await B.createClass(db, { org: 'LAD', channel: 'draft', year: 2016 }, { actor: ME })
  await B.planClass(db, { org: 'LAD', channel: 'draft', year: 2016 }, { actor: ME })
  await B.planClass(db, { org: 'SEA', channel: 'draft', year: 2016 }, { actor: ME })
  await assert.rejects(B.nextJobs(db, {}), /--org .* or an explicit --league/)
  const a = await B.nextJobs(db, { league: true, limit: 100 })
  const b = await B.nextJobs(db, { league: true, limit: 100 })
  assert.deepEqual(a, b)
  const sortKey = (j) => [j.wave, j.priority_rank, new Date(j.scope_start).getTime(), j.franchise_key, j.channel_key, j.job_key]
  const sorted = [...a].sort((x, y) => { const p = sortKey(x); const q = sortKey(y); for (let i = 0; i < p.length; i++) { if (p[i] < q[i]) return -1; if (p[i] > q[i]) return 1 } return 0 })
  assert.deepEqual(a.map((j) => j.job_key), sorted.map((j) => j.job_key))
  assert.equal(a[0].franchise_key, 'LAD', 'wave 1 first')
  assert.ok(!a.some((j) => j.category_key === 'COVERAGE_CERTIFICATION' && j.class_stage !== 'COVERAGE_REVIEW'), 'certification is not actionable before review')
  const sea = await B.nextJobs(db, { org: 'SEA', limit: 100 })
  assert.ok(sea.length > 0 && sea.every((j) => j.franchise_key === 'SEA'), 'organization filter isolates')
  assert.ok((await B.nextJobs(db, { org: 'SEA', stage: 'discovery', limit: 100 })).every((j) => j.job_stage === 'DISCOVERY'))
  await B.createClass(db, { org: 'ARI', channel: 'draft', year: 2016 }, { actor: ME })
  await B.planClass(db, { org: 'ARI', channel: 'draft', year: 2016 }, { actor: ME })
  const first = (rs, k) => rs.findIndex((j) => j.franchise_key === k)
  const before = await B.nextJobs(db, { league: true, limit: 100 })
  assert.ok(first(before, 'ARI') < first(before, 'SEA'), 'same wave: franchise key breaks the tie')
  await db.query("insert into research.program_waves (organization_id, wave, rationale, set_by) select id, 1, 'benchmark', 'test' from organizations where franchise_key = 'SEA'")
  const c = await B.nextJobs(db, { league: true, limit: 100 })
  assert.ok(first(c, 'SEA') < first(c, 'ARI'), 'changing the benchmark set reorders without a migration')
})

test('resumable batches: start, pause, resume shows exactly what remains, complete, fail, supersede, with history', async () => {
  const sea = { org: 'SEA', channel: 'draft', year: 2016 }
  const s = await B.startBatch(db, sea, { key: 'sea-2016-a', actor: ME, take: 2 })
  assert.equal(s.jobs, 2)
  await assert.rejects(B.startBatch(db, sea, { key: 'sea-2016-b', actor: ME }), /already has an active batch/)
  const prog = await B.batchProgress(db, 'sea-2016-a')
  await B.setJobState(db, prog.remaining[0].job_key, 'UNRESOLVED', { actor: ME, rationale: 'no source states the class size' })
  await B.pauseBatch(db, 'sea-2016-a', { actor: ME })
  const r = await B.resumeBatch(db, 'sea-2016-a', { actor: ME })
  assert.deepEqual([r.total, r.done, r.remaining.length], [2, 1, 1])
  await assert.rejects(B.completeBatch(db, 'sea-2016-a', { actor: ME }), /not finished/)
  const sup = await B.supersedeBatch(db, 'sea-2016-a', { actor: ME, newKey: 'sea-2016-b' })
  assert.equal(sup.moved, 1)
  assert.equal((await h.one(db, "select state from research.batches where batch_key = 'sea-2016-a'")).state, 'SUPERSEDED')
  await assert.rejects(B.failBatch(db, 'sea-2016-b', { actor: ME }), /--reason/)
  await B.failBatch(db, 'sea-2016-b', { actor: ME, reason: 'source site down for the session' })
  const job = await h.one(db, "select j.state, j.assigned_to from research.jobs j where j.job_key = $1", [r.remaining[0].job_key])
  assert.deepEqual(job, { state: 'OPEN', assigned_to: null }, 'a failed batch returns its unfinished work to the queue')
  const ev = await h.rows(db, "select b.batch_key, e.from_state, e.to_state from research.batch_events e join research.batches b on b.id = e.batch_id where b.batch_key like 'sea-2016-%' order by e.id")
  assert.deepEqual(ev.map((e) => `${e.batch_key}:${e.from_state ?? '-'}>${e.to_state}`),
    ['sea-2016-a:->STARTED', 'sea-2016-a:STARTED>PAUSED', 'sea-2016-a:PAUSED>STARTED', 'sea-2016-b:->PAUSED', 'sea-2016-a:STARTED>SUPERSEDED', 'sea-2016-b:PAUSED>STARTED', 'sea-2016-b:STARTED>FAILED'])
  const c = await B.startBatch(db, sea, { key: 'sea-2016-c', actor: ME, take: 1 })
  assert.equal(c.jobs, 1)
  const done = await B.completeBatch(db, 'sea-2016-c', { actor: ME, release: true })
  assert.equal(done.released, 1)
})

test('blocked jobs and dependencies: blockers need a reason and stay visible; dependent work waits', async () => {
  const sea = { org: 'SEA', channel: 'draft', year: 2016 }
  const jobs = await jobsOf('SEA/DRAFT/2016-JUNE_AMATEUR')
  const roster = jobs.find((j) => j.category_key === 'EXPECTED_UNIVERSE_UNKNOWN').job_key
  await assert.rejects(B.setJobState(db, roster, 'BLOCKED', { actor: ME }), /--reason/)
  await B.setJobState(db, roster, 'BLOCKED', { actor: ME, reason: 'source unavailable: tracker page returns 403' })
  const a = await B.addJob(db, sea, { category: 'SIGNING_STATUS_UNKNOWN', label: 'check-club-release', title: 'Check the club release', actor: ME })
  const b = await B.addJob(db, sea, { category: 'ACQUISITION_COST_MISSING', label: 'bonus-after-release', title: 'Bonus from the release', actor: ME, dependsOn: a.job_key })
  await assert.rejects(B.setJobState(db, b.job_key, 'IN_PROGRESS', { actor: ME }), /depends on unfinished/)
  assert.ok(!(await B.nextJobs(db, { org: 'SEA', limit: 200 })).some((j) => j.job_key === b.job_key))
  await B.setJobState(db, a.job_key, 'DONE', { actor: ME, rationale: 'release found' })
  assert.ok((await B.nextJobs(db, { org: 'SEA', limit: 200 })).some((j) => j.job_key === b.job_key))
  await B.setJobState(db, b.job_key, 'CANCELLED', { actor: ME, rationale: 'covered by the roster job' })
  const report = await B.classReport(db, sea)
  assert.ok(report.blocked.some((x) => x.job_key === roster && /403/.test(x.blocking_reason)))
  // With nothing else actionable, the class reads BLOCKED.
  await db.query("update research.jobs set state = 'CANCELLED', completed_at = now(), completion_rationale = 'test' where class_id = (select id from research.classes where class_key = 'SEA/DRAFT/2016-JUNE_AMATEUR') and state = 'OPEN'")
  assert.equal((await B.classReport(db, sea)).status.workflow_status, 'BLOCKED')
  await assert.rejects(B.setJobState(db, a.job_key, 'OPEN', { actor: ME }), /cannot move/, 'terminal jobs never reopen by hand')
})

test('outcomes: NOT_AUDITED is not failure; AUDITED_NO_MLB closes the job; rates stay hidden until coverage and certification allow', async () => {
  const before = (await jobsOf('NYY/INTERNATIONAL/2016-17')).find((j) => j.subject_label === 'player-mlbam-9810011' && j.category_key === 'OUTCOME_NOT_AUDITED')
  assert.equal(before.state, 'OPEN')
  const pid = (await h.one(db, "select player_id from player_external_ids where external_id = '9810011'")).player_id
  const s = (await h.one(db, "select id from sources where source_key = 't:official'")).id
  const a = await h.one(db, "insert into outcome_audits (player_id, audit_state, observation_through_season, audited_on, source_id) values ($1, 'AUDITED_NO_MLB', 2025, '2026-10-20', $2) returning id", [pid, s])
  await db.query("insert into outcome_audit_details (outcome_audit_id, as_of_date, reached_affiliated, first_affiliated_season, current_status, disposition, source_id) values ($1, '2026-10-20', true, 2017, 'RELEASED', 'RELEASED', $2)", [a.id, s])
  await h.rejects(db, "insert into outcome_audit_details (outcome_audit_id, as_of_date, disposition, source_id) values ($1, '2026-10-20', 'TRADED', $2)", [a.id, s], /check|unique/)
  await B.planClass(db, NYY_INTL, { actor: ME })
  const after = (await jobsOf('NYY/INTERNATIONAL/2016-17')).find((j) => j.job_key === before.job_key)
  assert.equal(after.state, 'DONE', 'an audit (even AUDITED_NO_MLB) resolves the outcome job')
  const prof = await h.rows(db, "select x.external_id, e.audit_state, e.reached_mlb from analytics.acquisition_economics e join player_external_ids x on x.player_id = e.player_id and x.id_system = 'MLBAM' where x.external_id in ('9810011', '9810012') order by 1")
  assert.deepEqual(prof, [{ external_id: '9810011', audit_state: 'AUDITED_NO_MLB', reached_mlb: false }, { external_id: '9810012', audit_state: 'NOT_AUDITED', reached_mlb: null }])
  const det = await h.one(db, 'select reached_affiliated, current_status, disposition, as_of_date::text d from analytics.player_outcome_profile where player_id = $1', [pid])
  assert.deepEqual(det, { reached_affiliated: true, current_status: 'RELEASED', disposition: 'RELEASED', d: '2026-10-20' })
  const econ = await h.rows(db, "select scope_key, certified, rates_allowed, mlb_reach_rate, cost_per_mlb_player from analytics.class_economics e join organizations o on o.id = e.organization_id where o.franchise_key = 'NYY' order by 1")
  for (const e of econ) { assert.equal(e.rates_allowed, false); assert.equal(e.mlb_reach_rate, null); assert.equal(e.cost_per_mlb_player, null) }
  assert.equal((await h.one(db, "select bonus_band(0) a, bonus_band(null) b, bonus_band(1500000) c")).b, null)
})

test('source leads: a URL alone is not enough; access, evidence note and supported fields are required', async () => {
  const job = (await jobsOf('SEA/DRAFT/2016-JUNE_AMATEUR'))[0].job_key
  const lead = { url: 'https://example.org/x', source_type: 'NEWS_REPORT', authority_level: 'REPUTABLE_SECONDARY' }
  await assert.rejects(B.addLead(db, job, { ...lead, access: 'ACCESSIBLE', evidence_note: 'tiny' }, { actor: ME }), /check/)
  await assert.rejects(B.addLead(db, job, { ...lead, access: 'ACCESSIBLE', evidence_note: 'lists the full first ten rounds' }, { actor: ME }), /check/, 'accessible needs a retrieved date and fields')
  const ok = await B.addLead(db, job, { ...lead, access: 'ACCESSIBLE', retrieved_date: '2026-10-20', fields_supported: ['overall_pick', 'signing_bonus_usd'], evidence_note: 'lists the full first ten rounds' }, { actor: ME })
  assert.equal(ok.excerpt_only, false)
  const blocked = await B.addLead(db, job, { url: 'https://example.org/y', source_type: 'OFFICIAL_TEAM', authority_level: 'OFFICIAL', access: 'BLOCKED', evidence_note: 'club release URL returns 403 to every fetch' }, { actor: ME, origin: 'AGENT' })
  assert.equal(blocked.origin, 'AGENT')
  const ex = await B.addLead(db, job, { ...lead, access: 'EXCERPT_ONLY', retrieved_date: '2026-10-20', fields_supported: ['signing_bonus_usd'], evidence_note: 'search excerpt quotes the bonus only' }, { actor: ME })
  assert.equal(ex.excerpt_only, true)
})

test('conflicts are preserved and block certification until resolved', async () => {
  await run({ batch_key: 'sea-2016-draft', channel: 'DRAFT', sources: [src('t:official')],
    records: [pick({ organization: 'SEA', overall_pick: 25, round_code: '1', round_pick: 25, player: { full_name: 'Fixture Eta', external_ids: { MLBAM: '9810031' } }, signing: { status: 'SIGNED', bonus_usd: 1800000, source_key: 't:official' } })] }, { org: 'SEA' })
  await run({ batch_key: 'sea-2016-draft-rival', channel: 'DRAFT', sources: [src('t:blog', 'OTHER')],
    records: [pick({ organization: 'SEA', source_key: 't:blog', overall_pick: 25, round_code: '1', round_pick: 25, player: { full_name: 'Fixture Eta', external_ids: { MLBAM: '9810031' } }, signing: { status: 'SIGNED', bonus_usd: 1750000, source_key: 't:blog' } })] }, { org: 'SEA' })
  await B.planClass(db, { org: 'SEA', channel: 'draft', year: 2016 }, { actor: ME })
  const jobs = await jobsOf('SEA/DRAFT/2016-JUNE_AMATEUR')
  assert.ok(jobs.some((j) => j.category_key === 'SOURCE_CONFLICT' && j.subject_label === 'pick-25-signing-signing_bonus_usd'), jobs.map((j) => j.subject_label).join(','))
  const r = await B.certificationBlockers(db, { org: 'SEA', channel: 'draft', year: 2016 })
  assert.ok(r.blockers.some((b) => b.code === 'CONFLICTS'))
  assert.equal((await h.one(db, "select count(*)::int n from source_observations o join sources s on s.id = o.source_id where o.field_name = 'signing_bonus_usd' and s.source_key in ('t:official', 't:blog') and o.observed_value in ('1800000', '1750000')")).n, 2)
})

test('organization isolation: an import for one club refuses another club\'s records unless they say why', async () => {
  const doc = { batch_key: 'nyy-iso', channel: 'DRAFT', sources: [src('t:official')],
    records: [pick({ overall_pick: 61, round_code: '2', round_pick: 31, organization: 'SEA', player: { full_name: 'Fixture Theta', external_ids: { MLBAM: '9810041' } } })] }
  await assert.rejects(P.stageFile(db, file(doc), { organization: 'NYY' }), /not NYY/)
  const ok = { ...doc, batch_key: 'nyy-iso-2', records: [{ ...doc.records[0], cross_organization: 're-draft of a NYY 2015 pick' }] }
  const s = await P.stageFile(db, file(ok), { organization: 'NYY' })
  assert.equal(s.already, false)
  const claim = { ...doc, batch_key: 'nyy-iso-3', records: [{ ...doc.records[0], organization: 'NYY' }], coverage_claims: [{ scope_key: '2016-JUNE_AMATEUR', organization: 'SEA', coverage_state: 'PARTIAL_RECONSTRUCTION' }] }
  await assert.rejects(P.stageFile(db, file(claim), { organization: 'NYY' }), /coverage claim for SEA/)
  // The source's own wording must resolve to the same franchise for that season.
  const named = { batch_key: 'mia-named', channel: 'DRAFT', sources: [src('t:official')],
    records: [pick({ organization: 'MIA', organization_as_named: 'Florida Marlins', overall_pick: 62, round_code: '2', round_pick: 32, player: { full_name: 'Fixture Iota', external_ids: { MLBAM: '9810051' } } })] }
  const st = await P.stageFile(db, file(named), { organization: 'MIA' })
  const v = await P.validateBatch(db, st.batch.id)
  assert.equal(v.ok, false, 'Florida Marlins is not a 2016 name')
  const errs = await h.one(db, "select validation_errors from ingest.staged_records r join ingest.import_batches b on b.id = r.batch_id where b.batch_key = 'mia-named'")
  assert.match(errs.validation_errors.join(' '), /does not resolve to one franchise in 2016/)
})

test('automation safety: an agent may stage, validate and dry-run, never write or certify without a human', async () => {
  const doc = { batch_key: 'agent-sea-2016', channel: 'DRAFT', sources: [src('t:official')],
    records: [pick({ organization: 'SEA', overall_pick: 70, round_code: '2', round_pick: 40, player: { full_name: 'Fixture Kappa', external_ids: { MLBAM: '9810061' } }, signing: { status: 'SIGNED', bonus_usd: 700000, source_key: 't:official' } })] }
  const { batch } = await P.stageFile(db, file(doc), { organization: 'SEA', operator: 'agent:scout-1' })
  assert.ok((await P.validateBatch(db, batch.id)).ok)
  const dry = await P.applyBatch(db, batch.id, { write: false })
  assert.equal(dry.report.step, 'dry-run')
  await assert.rejects(P.applyBatch(db, batch.id, { write: true }), /a human must review it/)
  await assert.rejects(B.reviewImport(db, batch.batch_key, { reviewer: 'agent:scout-2', note: 'looks fine' }), /human/)
  await B.reviewImport(db, batch.batch_key, { reviewer: 'reviewer-1', note: 'checked every pick against the tracker' })
  const w = await P.applyBatch(db, batch.id, { write: true })
  assert.equal(w.report.step, 'apply')
  await assert.rejects(B.certify(db, { org: 'SEA', channel: 'draft', year: 2016 }, { actor: 'agent:scout-1' }), /agent cannot certify/)
  await h.rejects(db, "insert into research.certifications (class_id, certified_by, coverage_state, report) select id, 'agent:x', 'UNKNOWN', '{}' from research.classes limit 1", [], /certifications_certified_by_check/)
})

test('progress: league-wide covers all 30 organizations; no rates for incomplete classes', async () => {
  await db.query('select refresh_read_models()')
  const league = await B.progress(db)
  assert.equal(league.perOrg.length, 30)
  assert.ok(league.perOrg.every((o) => o.cells === 24), 'every organization has 12 drafts + 12 periods of cells')
  const nyy = await B.progress(db, { org: 'NYY' })
  assert.equal(nyy.perOrg.length, 1)
  assert.equal(nyy.perOrg[0].certified, 2)
  assert.equal((await h.one(db, 'select count(*)::int n from analytics.class_economics where rates_allowed')).n, 0)
})

test('public/private boundary: research workflow is invisible to public roles; only certification flags are public', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const sql of ['select * from research.classes', 'select notes from research.jobs', 'select * from research.source_leads', 'select * from research.v_next_jobs',
      'select * from analytics.class_economics', 'select refresh_research_certification()']) {
      await assert.rejects(h.asRole(db, role, () => db.query(sql)), /permission denied/, `${role}: ${sql}`)
    }
    await h.asRole(db, role, async () => { await db.query('select * from rm_research_certification'); await db.query('select * from outcome_audit_details') })
  }
  const rls = await h.rows(db, "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'research' and c.relkind = 'r' and not c.relrowsecurity")
  assert.deepEqual(rls, [], 'research tables carry RLS as defense in depth')
})

test('hosted-write guardrail: workflow commands refuse a hosted target without --confirm-hosted, before connecting', () => {
  const env = { ...process.env, BAI_DATABASE_URL: 'postgresql://postgres:x@db.abcdefghijklmnopqrst.supabase.co:5432/postgres', BAI_ALLOW_REMOTE_DB: '1', BAI_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' } // credential-scan:allow (fictional URL: fake ref, no real password)
  for (const cmd of [['plan', '--org', 'NYY', '--channel', 'draft', '--year', '2016'], ['certify', '--org', 'NYY', '--channel', 'draft', '--year', '2016'], ['block', '--job', 'x', '--reason', 'y'], ['class', '--org', 'NYY', '--channel', 'draft', '--year', '2016', '--create']]) {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts/research/cli.mjs'), ...cmd], { env, encoding: 'utf8', timeout: 20000 })
    assert.equal(r.status, 1, cmd.join(' '))
    assert.match(r.stderr, /--confirm-hosted abcdefghijklmnopqrst/, cmd.join(' '))
  }
  const noOrg = spawnSync(process.execPath, [path.join(root, 'scripts/research/cli.mjs'), 'import', '--file', 'x.json'], { env: { ...env, BAI_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' }, encoding: 'utf8', timeout: 20000 })
  assert.equal(noOrg.status, 1)
  assert.match(noOrg.stderr, /needs --org <franchise key>/)
  const noOrgNext = spawnSync(process.execPath, [path.join(root, 'scripts/research/cli.mjs'), 'next'], { env: { ...env, BAI_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' }, encoding: 'utf8', timeout: 20000 })
  assert.match(noOrgNext.stderr, /--org .* or an explicit --league/)
})
