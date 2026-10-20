// Research decision history and the human certification boundary (migration 021): append-only judgments; reviewer
// identity bound to the authenticated database login (not a name); certification only through a reviewer session, a
// recorded check and an open gate; evidence changes revoke certifications in the same transaction, whoever makes them.
// Privilege escalation and identity spoofing are attempted from the owner's session, an automation login and a role
// with administrative attributes. FICTIONAL players and TEST_FIXTURE sources only.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as B from '../../scripts/research/lib/backfill.mjs'

let db      // the owner's session (what the research automation holds today)
let rv      // Pat Reviewer's own login
let bot     // an automation login with ordinary data privileges
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-decisions-'))
before(async () => {
  await h.startServer(); db = await h.freshDatabase()
  rv = await h.login(db, 'pat_login', { reviewer: true })
  bot = await h.login(db, 'scout_bot', {
    automation: true,
    grants: ['grant usage on schema public, research, ingest, analytics to $ROLE', 'grant select, insert, update on all tables in schema public, research, ingest to $ROLE',
      'alter role $ROLE bypassrls']
  })
}, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const KC = { org: 'KC', channel: 'draft', year: 2019 }
const REVIEWER = 'Pat Reviewer'
const src = (key, authority) => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: authority, title: `Decision fixture ${key}` })
let n = 0
async function run (doc, { write = true, operator = 'cli' } = {}) {
  const f = path.join(dir, `b-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', ...doc }))
  const { batch } = await P.stageFile(db, f, { organization: 'KC', operator })
  assert.ok((await P.validateBatch(db, batch.id)).ok)
  return P.applyBatch(db, batch.id, { write })
}
const pick = (i, bonus, key) => ({ type: 'DRAFT_SELECTION', source_key: key, draft_key: '2019-JUNE_AMATEUR', round_code: String(10 + i), overall_pick: 300 + i * 30, round_pick: 7,
  organization: 'KC', player: { full_name: `Decision Pick ${i}`, external_ids: { MLBAM: `984000${i}` } }, school: { name: 'Decision College', school_type: 'COLLEGE' },
  signing: { status: 'SIGNED', bonus_usd: bonus, source_key: key } })
const history = async () => h.rows(db, "select * from research.decision_history where coalesce(reason, '') not like '%[baseline:%' order by id")
const signingOf = async (i) => (await h.one(db, `select g.id from draft_signings g join draft_selections s on s.id = g.draft_selection_id join drafts d on d.id = s.draft_id
  where d.draft_key = '2019-JUNE_AMATEUR' and s.overall_pick = $1`, [300 + i * 30])).id
const obsOf = async (signingId, key) => (await h.one(db, `select o.id from source_observations o join sources s on s.id = o.source_id
  where o.subject_table = 'draft_signings' and o.subject_id = $1 and o.field_name = 'signing_bonus_usd' and s.source_key = $2`, [signingId, key])).id
const activeCert = async () => h.one(db, "select c.id, c.revoked_by from research.certifications c join research.classes k on k.id = c.class_id where k.class_key = 'KC/DRAFT/2019-JUNE_AMATEUR' order by c.id desc limit 1")
const stage = async () => (await h.one(db, "select stage from research.classes where class_key = 'KC/DRAFT/2019-JUNE_AMATEUR'")).stage
/** A check anyone records, then the reviewer certifies it on their own login. */
async function certifyKC () {
  const r = await B.recordCertificationCheck(db, KC, { actor: 'cli' })
  assert.equal(r.check.passed, true, JSON.stringify(r.blockers))
  return B.certify(rv, r.check.id)
}

test('reviewers: only the human, logged in with their own role, enrolls it; names, the owner, automation and admin roles never qualify', async () => {
  // Spoofing a name from the owner's session: the row must name the session's own role, and that role must qualify.
  await h.rejects(db, "insert into research.reviewers (reviewer, db_role) values ('Pat Reviewer', 'pat_login')", [], /enrolls their own login role/)
  await h.rejects(db, "insert into research.reviewers (reviewer, db_role) values ('Owner Person', 'postgres')", [], /cannot be a reviewer: has an administrative attribute/)
  await assert.rejects(B.enrollReviewer(db, { reviewer: 'Owner Person' }), /cannot be a reviewer: has an administrative attribute/)
  // An automation login cannot enroll, even if someone also grants it bai_reviewer; without that grant it cannot even call it.
  const helper = await h.login(db, 'helper_bot', { automation: true, reviewer: true })
  await assert.rejects(helper.query("select * from research.enroll_reviewer('Helper Bot')"), /is an automation role/)
  await assert.rejects(bot.query("select * from research.enroll_reviewer('Scout Bot')"), /permission denied for function enroll_reviewer/)
  // A login that could act as an owner of BAI tables (here: a member of the owner role) never qualifies.
  const admin = await h.login(db, 'admin_login', { reviewer: true, grants: ['grant postgres to $ROLE'] })
  await assert.rejects(B.enrollReviewer(admin, { reviewer: 'Admin Person' }), /can act as the owner/)
  const roleMaker = await h.login(db, 'rolemaker_login', { reviewer: true, grants: ['alter role $ROLE createrole'] })
  await assert.rejects(B.enrollReviewer(roleMaker, { reviewer: 'Role Maker' }), /administrative attribute/)
  // Automation-style names are refused whoever enrolls.
  for (const name of ['agent:scout', 'rule:PREFER_HIGHER_AUTHORITY', 'system:x', 'bai-backfill-review']) {
    await assert.rejects(rv.query('select * from research.enroll_reviewer($1)', [name]), /reviewers_reviewer_check/)
  }
  const me = await B.enrollReviewer(rv, { reviewer: REVIEWER, note: 'fixture' })
  assert.deepEqual([me.reviewer, me.db_role], [REVIEWER, 'pat_login'])
  await assert.rejects(B.enrollReviewer(rv, { reviewer: 'Pat Again' }), /reviewers_db_role_key/, 'one name per login')
  await h.rejects(db, 'delete from research.reviewers where reviewer = $1', [REVIEWER], /never deleted/)
  await h.rejects(db, "update research.reviewers set db_role = 'postgres' where reviewer = $1", [REVIEWER], /immutable/)
  // Session identity: the reviewer's own session is Pat; the owner's is no one, even after SET ROLE to Pat's login.
  assert.equal((await h.one(rv, "select current_user::text u")).u, 'pat_login')
  assert.equal((await h.one(db, 'select research.session_reviewer() r')).r, null)
  await db.query('begin')
  try {
    await db.query('set local role pat_login')
    assert.equal((await h.one(db, 'select session_user::text s')).s, 'postgres', 'SET ROLE does not change session_user')
  } finally { await db.query('rollback') }
  assert.equal((await h.one(db, "select research.session_reviewer() is null as none")).none, true)
})

test('setup: a two-pick census class with one conflict resolved by rule; the first decision is recorded with its evidence and session', async () => {
  await run({ batch_key: 'kc-2019', channel: 'DRAFT', sources: [src('d:official', 'OFFICIAL')],
    coverage_claims: [{ scope_key: '2019-JUNE_AMATEUR', organization: 'KC', coverage_state: 'COMPLETE_CENSUS', expected_count: 2, source_key: 'd:official' }],
    records: [pick(1, 500000, 'd:official'), pick(2, 100000, 'd:official')] })
  await run({ batch_key: 'kc-2019-ref', channel: 'DRAFT', sources: [src('d:ref', 'AGGREGATOR')], records: [pick(1, 497500, 'd:ref')] })
  const sig = await signingOf(1)
  await P.resolveConflict(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', useRule: true, write: true })
  const [first] = await history()
  assert.equal(first.kind, 'RESOLVED')
  assert.equal(first.decided_by, 'rule:PREFER_HIGHER_AUTHORITY')
  assert.equal(first.session_role, 'postgres')
  assert.equal(first.reviewer_session, false)
  assert.equal(first.new_value, 500000)
  assert.deepEqual(first.evidence.map((e) => [e.source_key, e.value]).sort(), [['d:official', 500000], ['d:ref', 497500]])
  assert.equal(first.certification_impact, 'NONE', 'no research class exists yet')
  await B.createClass(db, KC, { actor: 'cli' })
  await B.planClass(db, KC, { actor: 'cli' })
  for (let i = 0; i < 7; i++) await B.advanceStage(db, KC, { actor: 'cli' })
})

test('the certification gate is closed by default; only a reviewer session opens it; closing it is anyone\'s', async () => {
  assert.equal((await h.one(db, 'select enabled from research.certification_gate')).enabled, false)
  const r = await B.recordCertificationCheck(db, KC, { actor: 'cli' })
  assert.equal(r.check.passed, true, JSON.stringify(r.blockers))
  await assert.rejects(B.certify(rv, r.check.id), /certification is disabled/)
  await h.rejects(db, "update research.certification_gate set enabled = true, changed_by = 'Pat Reviewer', reason = 'spoofed'", [], /only an enrolled human reviewer/)
  await assert.rejects(B.setCertificationGate(db, { enabled: true, reason: 'owner tries' }), /not an enrolled, active human reviewer/)
  const g = await B.setCertificationGate(rv, { enabled: true, reason: 'test cluster: the reviewer holds the only reviewer login' })
  assert.deepEqual([g.enabled, g.changed_by, g.changed_session_role], [true, REVIEWER, 'pat_login'])
  await B.setCertificationGate(db, { enabled: false, reason: 'closing removes power', actor: 'cli' })
  await B.setCertificationGate(rv, { enabled: true, reason: 'reopened by the reviewer' })
  const gates = (await history()).filter((x) => x.kind === 'CERTIFICATION_GATE_CHANGED')
  assert.deepEqual(gates.map((x) => [x.decided_by, x.reviewer_session, x.session_role]), [[REVIEWER, true, 'pat_login'], ['cli', false, 'postgres'], [REVIEWER, true, 'pat_login']])
})

test('privilege escalation: the owner session and an automation login cannot certify, reconsider, accept, or rewrite the record', async () => {
  const sig = await signingOf(1)
  const ref = await obsOf(sig, 'd:ref')
  const chk = await B.recordCertificationCheck(db, KC, { actor: 'agent:scout' })
  // Certification: not from the owner's session (any name), not by direct insert, not from the automation login.
  await assert.rejects(B.certify(db, chk.check.id), /not an enrolled, active human reviewer/)
  await h.rejects(db, "insert into research.certifications (class_id, certified_by, coverage_state, report, certification_check_id) select class_id, 'Pat Reviewer', 'COMPLETE_CENSUS', '{}', id from research.certification_checks where id = $1",
    [chk.check.id], /enrolled human reviewer in their own authenticated session/)
  await assert.rejects(bot.query('select * from research.certify_class($1)', [chk.check.id]), /permission denied for function certify_class/)
  await assert.rejects(bot.query("insert into research.certifications (class_id, certified_by, coverage_state, report, certification_check_id) select class_id, 'Pat Reviewer', 'COMPLETE_CENSUS', '{}', id from research.certification_checks where id = $1", [chk.check.id]),
    /enrolled human reviewer in their own authenticated session/)
  // Reconsideration: the session flag alone, with a reviewer's name, from the owner's session or the automation's: refused.
  for (const c of [db, bot]) {
    await c.query('begin')
    try {
      await c.query("select set_config('bai.reconsideration', 'authorized', true)")
      await assert.rejects(c.query("update fact_resolutions set chosen_observation_id = $1, decided_by = 'Pat Reviewer', rationale = 'spoofed' where subject_table = 'draft_signings' and subject_id = $2", [ref, sig]),
        /enrolled human reviewer in their own authenticated session/)
    } finally { await c.query('rollback') }
  }
  await h.rejects(db, "update fact_resolutions set chosen_observation_id = $1, decided_by = 'someone', rationale = 'changed my mind' where subject_table = 'draft_signings' and subject_id = $2",
    [ref, sig], /only through research:reconsider/)
  await assert.rejects(P.reconsiderResolution(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, reason: 'r', write: true }), /not an enrolled, active human reviewer/)
  await h.rejects(db, 'delete from fact_resolutions where subject_table = $1 and subject_id = $2', ['draft_signings', sig], /never deleted/)
  // The automation login cannot disable the guards, rewrite the history, or open the gate.
  await assert.rejects(bot.query('alter table research.decision_history disable trigger decision_history_no_update'), /must be owner/)
  await assert.rejects(bot.query('alter table public.fact_resolutions disable trigger fact_resolutions_guard'), /must be owner/)
  await assert.rejects(bot.query("update research.decision_history set reason = 'rewritten'"), /append-only/)
  await assert.rejects(bot.query("update research.reviewers set db_role = 'scout_bot'"), /immutable/)
  await assert.rejects(bot.query('set session authorization pat_login'), /permission denied/)
  assert.equal((await history()).filter((x) => !['CERTIFICATION_GATE_CHANGED'].includes(x.kind)).length, 1, 'refused attempts leave no history')
})

test('certification certifies a checked state: a change after the check is refused; the reviewer session is recorded', async () => {
  const stale = await B.recordCertificationCheck(db, KC, { actor: 'cli' })
  // Evidence changes after the check (a corroborating source still changes the fingerprint).
  await run({ batch_key: 'kc-2019-corroborate', channel: 'DRAFT', sources: [src('d:club', 'PRIMARY_PUBLIC')], records: [pick(2, 100000, 'd:club')] })
  await assert.rejects(B.certify(rv, stale.check.id), /changed after check/)
  const cert = await certifyKC()
  assert.equal(cert.certified_by, REVIEWER)
  const last = (await history()).at(-1)
  assert.deepEqual([last.kind, last.decided_by, last.reviewer_session, last.session_role], ['CERTIFIED', REVIEWER, true, 'pat_login'])
  assert.equal(await stage(), 'CERTIFIED')
  await h.rejects(db, 'insert into research.certification_checks (class_id, checked_by, passed, report, fingerprint) values (1, \'x\', true, \'{}\', \'f\')', [], /certification_checks_check/)
  await h.rejects(db, "update research.certification_checks set passed = true", [], /append-only/)
})

test('a reviewer reconsideration revokes the certification, records both judgments, and is idempotent', async () => {
  const sig = await signingOf(1)
  const ref = await obsOf(sig, 'd:ref')
  const off = await obsOf(sig, 'd:official')
  const dry = await P.reconsiderResolution(rv, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, reason: 'net-of-deduction convention', write: false })
  assert.equal(dry.written, false)
  assert.deepEqual(dry.revoked_class_ids.length, 1, 'the dry run says what would happen')
  assert.equal((await activeCert()).revoked_by, null, 'and changes nothing')
  const r = await P.reconsiderResolution(rv, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref,
    reason: 'net-of-deduction convention', evidence: ['https://example.org/gross-vs-net'], write: true })
  assert.deepEqual(r.canonical_update, { from: '500000.00', to: 497500 })
  const h2 = await history()
  const rec = h2.find((x) => x.kind === 'RECONSIDERED')
  assert.equal(rec.previous_value, 500000); assert.equal(rec.new_value, 497500)
  assert.equal(rec.previous_source_key, 'd:official'); assert.equal(rec.new_source_key, 'd:ref')
  assert.equal(rec.previous_observation_id, String(off)); assert.equal(rec.decided_by, REVIEWER)
  assert.deepEqual([rec.session_role, rec.reviewer_session], ['pat_login', true])
  assert.ok(rec.evidence.some((e) => e.reviewer_evidence === 'https://example.org/gross-vs-net'))
  assert.equal(rec.certification_impact, 'CERTIFICATION_REVOKED')
  assert.equal((await activeCert()).revoked_by, 'system:evidence-changed')
  assert.equal(await stage(), 'COVERAGE_REVIEW')
  assert.equal(h2[0].kind, 'RESOLVED'); assert.equal(h2[0].new_value, 500000, 'the earlier judgment is still there')
  const again = await P.reconsiderResolution(rv, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, reason: 'again', write: true })
  assert.equal(again.unchanged, true)
  assert.equal((await history()).length, h2.length, 'idempotent: no new history')
  await h.rejects(db, "update research.certifications set revoked_at = null, revoked_by = null, revoke_reason = null where revoked_by = 'system:evidence-changed'", [], /final/)
  await h.rejects(db, 'delete from research.certifications', [], /never deleted/)
  await h.rejects(db, "update research.decision_history set reason = 'rewritten'", [], /append-only/)
  await h.rejects(db, 'delete from research.decision_history', [], /append-only/)
  await h.rejects(db, 'truncate research.decision_history', [], /append-only/)
})

test('evidence changes revoke in the same transaction, by any path: an applied batch (not its dry run), and a direct statement', async () => {
  await certifyKC()
  const doc = { batch_key: 'kc-2019-news', channel: 'DRAFT', sources: [src('d:news', 'REPUTABLE_SECONDARY')], records: [pick(2, 125000, 'd:news')] }
  const dry = await run(doc, { write: false })
  assert.deepEqual(dry.report.certifications_revoked, ['KC/DRAFT/2019-JUNE_AMATEUR'], 'the dry run says what would happen')
  assert.equal((await activeCert()).revoked_by, null, 'and changes nothing')
  const batch = (await h.one(db, "select id from ingest.import_batches where batch_key = 'kc-2019-news'")).id
  const wet = await P.applyBatch(db, batch, { write: true })
  assert.deepEqual(wet.report.certifications_revoked, ['KC/DRAFT/2019-JUNE_AMATEUR'])
  assert.equal((await activeCert()).revoked_by, 'system:evidence-changed')
  const ev = (await history()).filter((x) => x.kind === 'EVIDENCE_CHANGED')
  assert.equal(ev.at(-1).subject_table, 'draft_signings'); assert.equal(ev.at(-1).import_batch_id, String(batch)); assert.equal(ev.at(-1).decided_by, 'cli')
  // Re-decide pick 2's new conflict by rule, recertify, then change a certified fact with a plain UPDATE.
  await P.resolveConflict(db, { subjectTable: 'draft_signings', subjectId: await signingOf(2), field: 'signing_bonus_usd', useRule: true, write: true })
  await certifyKC()
  await db.query('begin')
  await db.query("update draft_selections set position = 'C' where overall_pick = 360")
  assert.equal((await activeCert()).revoked_by, 'system:evidence-changed', 'revoked inside the transaction')
  await db.query('rollback')
  assert.equal((await activeCert()).revoked_by, null, 'and only together with the change: rolled back, both are gone')
  await bot.query("update draft_selections set position = 'C' where overall_pick = 360")
  assert.equal((await activeCert()).revoked_by, 'system:evidence-changed', 'an automation login revokes it too')
  const last = (await history()).filter((x) => x.kind === 'EVIDENCE_CHANGED').at(-1)
  assert.deepEqual([last.subject_table, last.session_role], ['draft_selections', 'scout_bot'])
  // A new dated outcome row adds information and does not revoke; changing it does.
  await certifyKC()
  const player = (await h.one(db, 'select player_id from draft_selections where overall_pick = 360')).player_id
  await db.query("insert into outcome_audits (player_id, audit_state, observation_through_season, audited_on, source_id) select $1, 'AUDITED_NO_MLB', 2025, '2026-01-01', id from sources where source_key = 'd:official'", [player])
  assert.equal((await activeCert()).revoked_by, null)
  await db.query("update outcome_audits set audited_on = '2026-01-02' where player_id = $1", [player])
  assert.equal((await activeCert()).revoked_by, 'system:evidence-changed')
  assert.equal(await stage(), 'COVERAGE_REVIEW', 'a human must certify again')
})

test('proposals: an agent proposes; only a reviewer session accepts (open conflict or recorded decision) or rejects', async () => {
  await run({ batch_key: 'kc-2019-more', channel: 'DRAFT', sources: [src('d:other', 'OTHER')], records: [pick(1, 490000, 'd:other')] })
  const sig = await signingOf(1)
  const other = await obsOf(sig, 'd:other')
  const ref = await obsOf(sig, 'd:ref')
  const p1 = await P.proposeDecision(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, proposedBy: 'agent:research', rationale: 'fixture: keep the net figure', evidence: ['https://example.org/a'] })
  assert.equal(p1.created, true); assert.equal(p1.path, 'resolve')
  assert.equal(p1.proposal.proposed_session_role, 'postgres')
  assert.equal((await P.proposeDecision(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, proposedBy: 'agent:research', rationale: 'again' })).created, false, 'idempotent')
  const before = (await history()).length
  await assert.rejects(P.acceptProposal(db, p1.proposal.id, { reason: 'owner tries', write: true }), /not an enrolled, active human reviewer/)
  await assert.rejects(bot.query('select research.accept_proposal($1, $2)', [p1.proposal.id, 'bot tries']), /permission denied/)
  await h.rejects(db, "update research.decision_proposals set status = 'ACCEPTED', decided_by = 'Pat Reviewer', decided_at = now() where id = $1", [p1.proposal.id], /only an enrolled human reviewer/)
  await assert.rejects(P.resolveConflict(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, operator: 'x', rationale: 'y', proposalId: p1.proposal.id, write: true }), /research:accept/)
  await h.rejects(db, "update research.decision_proposals set rationale = 'edited' where id = $1", [p1.proposal.id], /immutable/)
  await h.rejects(db, 'delete from research.decision_proposals where id = $1', [p1.proposal.id], /never deleted/)
  assert.equal((await history()).length, before, 'nothing decided yet')
  // The reviewer accepts it: the reopened conflict is decided as proposed.
  const acc = await P.acceptProposal(rv, p1.proposal.id, { reason: 'accepted after review', write: true })
  assert.equal(acc.kind, 'RESOLVED_WITH_NEW_EVIDENCE')
  const last = (await history()).at(-1)
  assert.deepEqual([last.proposal_id, last.decided_by, last.reviewer_session], [String(p1.proposal.id), REVIEWER, true])
  assert.deepEqual(await h.one(db, 'select status::text, decided_by, decided_session_role::text from research.decision_proposals where id = $1', [p1.proposal.id]), { status: 'ACCEPTED', decided_by: REVIEWER, decided_session_role: 'pat_login' })
  // A proposal on the recorded decision goes through reconsideration; a second one is rejected by the reviewer.
  const p2 = await P.proposeDecision(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: other, proposedBy: 'agent:research', rationale: 'fixture: the other figure' })
  assert.equal(p2.path, 'reconsider')
  await assert.rejects(P.closeProposal(db, p2.proposal.id, { status: 'REJECTED', reason: 'owner rejects' }), /not an enrolled, active human reviewer/)
  assert.equal((await P.closeProposal(rv, p2.proposal.id, { status: 'REJECTED', reason: 'the report is not a primary source' })).status, 'REJECTED')
  const p3 = await P.proposeDecision(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: other, proposedBy: 'agent:research', rationale: 'fixture: again, with more context' })
  const r3 = await P.acceptProposal(rv, p3.proposal.id, { reason: 'convinced on second look', write: true })
  assert.equal(r3.kind, 'RECONSIDERED')
})

test('ratification: an operator decision outside a reviewer session blocks certification until a reviewer ratifies it', async () => {
  await run({ batch_key: 'kc-2019-pos', channel: 'DRAFT', sources: [src('d:pos', 'OTHER')], records: [{ ...pick(2, 125000, 'd:pos'), position: 'SS' }] })
  const conflicts = (await P.openConflicts(db)).filter((c) => c.subject_table === 'draft_selections')
  assert.equal(conflicts.length, 1, JSON.stringify(conflicts.map((c) => c.field_name)))
  const c = conflicts[0]
  const choice = c.observations.find((o) => o.source_key === 'd:pos').observation_id
  await P.resolveConflict(db, { subjectTable: 'draft_selections', subjectId: c.subject_id, field: c.field_name, observationId: choice, operator: 'bai-backfill-review', rationale: 'operator judgment', write: true })
  const blocked = await B.recordCertificationCheck(db, KC, { actor: 'cli' })
  assert.ok(blocked.blockers.some((b) => b.code === 'DECISIONS'), JSON.stringify(blocked.blockers))
  const res = await h.one(db, 'select id from fact_resolutions where subject_table = $1 and subject_id = $2', ['draft_selections', c.subject_id])
  await assert.rejects(P.ratifyResolution(db, res.id, { reason: 'owner ratifies', write: true }), /not an enrolled, active human reviewer/)
  const rat = await P.ratifyResolution(rv, res.id, { reason: 'checked the club release', write: true })
  assert.deepEqual([rat.kind, rat.decided_by, rat.reviewer_session], ['RATIFIED', REVIEWER, true])
  const ok = await B.recordCertificationCheck(db, KC, { actor: 'cli' })
  assert.ok(!ok.blockers.some((b) => b.code === 'DECISIONS'), JSON.stringify(ok.blockers))
})
