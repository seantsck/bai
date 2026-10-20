// Research decision history (migration 021): append-only judgments, authorized human reconsideration, registered
// reviewers, and certification revocation when the evidence under a certified class changes.
// FICTIONAL players and TEST_FIXTURE sources only.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as B from '../../scripts/research/lib/backfill.mjs'

let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-decisions-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
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

test('reviewers: only humans register them; automation names never qualify; registrations are immutable and never deleted', async () => {
  await assert.rejects(B.addReviewer(db, { reviewer: 'Someone', actor: 'agent:scout' }), /only a human/)
  for (const name of ['agent:scout', 'rule:PREFER_HIGHER_AUTHORITY', 'system:x', 'bai-backfill-review']) {
    await assert.rejects(B.addReviewer(db, { reviewer: name, actor: 'admin' }), /named human/)
    await h.rejects(db, "insert into research.reviewers (reviewer, added_by) values ($1, 'admin')", [name], /reviewers_reviewer_check/)
  }
  assert.equal((await B.addReviewer(db, { reviewer: REVIEWER, actor: 'admin', note: 'fixture' })).reviewer, REVIEWER)
  assert.equal(await B.addReviewer(db, { reviewer: REVIEWER, actor: 'admin' }), undefined, 'registering twice changes nothing')
  await h.rejects(db, 'delete from research.reviewers where reviewer = $1', [REVIEWER], /never deleted/)
  await h.rejects(db, "update research.reviewers set added_by = 'someone else' where reviewer = $1", [REVIEWER], /immutable/)
})

test('setup: a two-pick census class with one conflict resolved by rule; the first decision is recorded with its evidence', async () => {
  await run({ batch_key: 'kc-2019', channel: 'DRAFT', sources: [src('d:official', 'OFFICIAL')],
    coverage_claims: [{ scope_key: '2019-JUNE_AMATEUR', organization: 'KC', coverage_state: 'COMPLETE_CENSUS', expected_count: 2, source_key: 'd:official' }],
    records: [pick(1, 500000, 'd:official'), pick(2, 100000, 'd:official')] })
  await run({ batch_key: 'kc-2019-ref', channel: 'DRAFT', sources: [src('d:ref', 'AGGREGATOR')], records: [pick(1, 497500, 'd:ref')] })
  const sig = await signingOf(1)
  await P.resolveConflict(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', useRule: true, write: true })
  const [first] = await history()
  assert.equal(first.kind, 'RESOLVED')
  assert.equal(first.decided_by, 'rule:PREFER_HIGHER_AUTHORITY')
  assert.equal(first.new_value, 500000)
  assert.equal(first.new_source_key, 'd:official')
  assert.deepEqual(first.evidence.map((e) => [e.source_key, e.value]).sort(), [['d:official', 500000], ['d:ref', 497500]])
  assert.equal(first.certification_impact, 'NONE', 'no research class exists yet')
  await B.createClass(db, KC, { actor: 'cli' })
  await B.planClass(db, KC, { actor: 'cli' })
  for (let i = 0; i < 7; i++) await B.advanceStage(db, KC, { actor: 'cli' })
})

test('permissions: a recorded judgment changes only through an authorized human reconsideration; never deleted; certification needs a registered reviewer', async () => {
  const sig = await signingOf(1)
  const ref = await obsOf(sig, 'd:ref')
  // Direct overwrite with the same evidence: refused.
  await h.rejects(db, "update fact_resolutions set chosen_observation_id = $1, decided_by = 'someone', rationale = 'changed my mind' where subject_table = 'draft_signings' and subject_id = $2",
    [ref, sig], /only through research:reconsider/)
  // Authorized flag but not a registered reviewer: refused.
  await db.query('begin')
  try {
    await db.query("select set_config('bai.reconsideration', 'authorized', true)")
    await assert.rejects(db.query("update fact_resolutions set chosen_observation_id = $1, decided_by = 'Unregistered Person', rationale = 'x' where subject_table = 'draft_signings' and subject_id = $2", [ref, sig]), /registered, active human reviewer/)
  } finally { await db.query('rollback') }
  await h.rejects(db, 'delete from fact_resolutions where subject_table = $1 and subject_id = $2', ['draft_signings', sig], /never deleted/)
  for (const who of ['agent:scout', 'rule:PREFER_HIGHER_AUTHORITY', 'system:x']) {
    await assert.rejects(P.reconsiderResolution(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, reviewer: who, reason: 'r', write: true }), /human decision/)
  }
  await assert.rejects(P.reconsiderResolution(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, reviewer: 'Unregistered Person', reason: 'r', write: true }), /not a registered/)
  await assert.rejects(P.reconsiderResolution(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, reviewer: REVIEWER, write: true }), /--reason/)
  // Certification: agents and unregistered names are refused, in the library and in the database.
  await assert.rejects(B.certify(db, KC, { actor: 'agent:scout' }), /agent cannot certify/)
  await assert.rejects(B.certify(db, KC, { actor: 'Unregistered Person' }), /not a registered, active human reviewer/)
  await h.rejects(db, "insert into research.certifications (class_id, certified_by, coverage_state, report) select id, 'Unregistered Person', 'COMPLETE_CENSUS', '{}' from research.classes where class_key = 'KC/DRAFT/2019-JUNE_AMATEUR'", [], /registered, active human reviewer/)
  assert.equal((await history()).length, 1, 'refused attempts leave no history')
})

test('certification is logged; a human reconsideration revokes it, records both judgments, and is idempotent', async () => {
  const cert = await B.certify(db, KC, { actor: REVIEWER })
  assert.equal(cert.certified, true, JSON.stringify(cert.blockers))
  assert.equal((await history()).at(-1).kind, 'CERTIFIED')
  const sig = await signingOf(1)
  const ref = await obsOf(sig, 'd:ref')
  const off = await obsOf(sig, 'd:official')
  // Dry run writes nothing.
  const dry = await P.reconsiderResolution(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, reviewer: REVIEWER, reason: 'net-of-deduction convention', write: false })
  assert.equal(dry.written, false)
  assert.equal((await activeCert()).revoked_by, null)
  const r = await P.reconsiderResolution(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, reviewer: REVIEWER,
    reason: 'net-of-deduction convention', evidence: ['https://example.org/gross-vs-net'], write: true })
  assert.deepEqual(r.canonical_update, { from: '500000.00', to: 497500 })
  const h2 = await history()
  const rec = h2.find((x) => x.kind === 'RECONSIDERED')
  assert.equal(rec.previous_value, 500000); assert.equal(rec.new_value, 497500)
  assert.equal(rec.previous_source_key, 'd:official'); assert.equal(rec.new_source_key, 'd:ref')
  assert.equal(rec.previous_observation_id, String(off)); assert.equal(rec.decided_by, REVIEWER)
  assert.equal(rec.reason, 'net-of-deduction convention')
  assert.ok(rec.evidence.some((e) => e.reviewer_evidence === 'https://example.org/gross-vs-net'))
  assert.equal(rec.certification_impact, 'CERTIFICATION_REVOKED')
  assert.equal((await activeCert()).revoked_by, 'system:evidence-changed')
  assert.equal(await stage(), 'COVERAGE_REVIEW')
  assert.ok(h2.some((x) => x.kind === 'CERTIFICATION_REVOKED'))
  // The earlier judgment is still there, unchanged.
  assert.equal(h2[0].kind, 'RESOLVED'); assert.equal(h2[0].new_value, 500000)
  // Idempotent: choosing the same claim again changes nothing and adds no history.
  const again = await P.reconsiderResolution(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: ref, reviewer: REVIEWER, reason: 'again', write: true })
  assert.equal(again.unchanged, true)
  assert.equal((await history()).length, h2.length)
  // A revoked certification is final; a certification is never deleted; the history is append-only.
  await h.rejects(db, "update research.certifications set revoked_at = null, revoked_by = null, revoke_reason = null where revoked_by = 'system:evidence-changed'", [], /final/)
  await h.rejects(db, 'delete from research.certifications', [], /never deleted/)
  await h.rejects(db, "update research.decision_history set reason = 'rewritten'", [], /append-only/)
  await h.rejects(db, 'delete from research.decision_history', [], /append-only/)
  await h.rejects(db, 'truncate research.decision_history', [], /append-only/)
})

test('applied evidence that contests a record of a certified class revokes it (not in a dry run); new evidence may be re-decided by rule', async () => {
  assert.equal((await B.certify(db, KC, { actor: REVIEWER })).certified, true)
  const doc = { batch_key: 'kc-2019-news', channel: 'DRAFT', sources: [src('d:news', 'REPUTABLE_SECONDARY')], records: [pick(2, 125000, 'd:news')] }
  const dry = await run(doc, { write: false })
  assert.deepEqual(dry.report.certifications_revoked, ['KC/DRAFT/2019-JUNE_AMATEUR'], 'the dry run says what would happen')
  assert.equal((await activeCert()).revoked_by, null, 'and changes nothing')
  // (the dry run left the batch VALIDATED; apply it for real)
  const batch = (await h.one(db, "select id from ingest.import_batches where batch_key = 'kc-2019-news'")).id
  const wet = await P.applyBatch(db, batch, { write: true })
  assert.deepEqual(wet.report.certifications_revoked, ['KC/DRAFT/2019-JUNE_AMATEUR'])
  assert.equal((await activeCert()).revoked_by, 'system:evidence-changed')
  const ev = (await history()).filter((x) => x.kind === 'EVIDENCE_CHANGED')
  assert.equal(ev.length, 1); assert.equal(ev[0].subject_table, 'draft_signings'); assert.equal(ev[0].import_batch_id, String(batch))
  // The new claim reopened nothing already decided (pick 2 had no conflict before); the rule decides it as a first resolution.
  const sig2 = await signingOf(2)
  await P.resolveConflict(db, { subjectTable: 'draft_signings', subjectId: sig2, field: 'signing_bonus_usd', useRule: true, write: true })
  // New evidence on pick 1 reopens its recorded decision; re-deciding it is RESOLVED_WITH_NEW_EVIDENCE, no authorization needed.
  await run({ batch_key: 'kc-2019-more', channel: 'DRAFT', sources: [src('d:other', 'OTHER')], records: [pick(1, 490000, 'd:other')] })
  const sig1 = await signingOf(1)
  await P.resolveConflict(db, { subjectTable: 'draft_signings', subjectId: sig1, field: 'signing_bonus_usd', useRule: true, write: true })
  const kinds = (await history()).map((x) => x.kind)
  assert.ok(kinds.includes('RESOLVED_WITH_NEW_EVIDENCE'))
  assert.equal(await stage(), 'COVERAGE_REVIEW', 'a human must certify again')
})

test('proposals: an agent may propose, never decide; a registered reviewer accepts (linked in the history) or rejects; proposals are immutable', async () => {
  const sig = await signingOf(2)
  const obs = (await h.rows(db, `select o.id, s.source_key from source_observations o join sources s on s.id = o.source_id
    where o.subject_table = 'draft_signings' and o.subject_id = $1 and o.field_name = 'signing_bonus_usd' order by o.id`, [sig]))
  const news = obs.find((o) => o.source_key === 'd:news').id
  const official = obs.find((o) => o.source_key === 'd:official').id
  const p1 = await P.proposeDecision(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: news, proposedBy: 'agent:research', rationale: 'fixture: the reported figure', evidence: ['https://example.org/a'] })
  assert.equal(p1.created, true); assert.equal(p1.path, 'reconsider')
  assert.equal((await P.proposeDecision(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: news, proposedBy: 'agent:research', rationale: 'again' })).created, false, 'idempotent')
  const before = (await history()).length
  // The agent cannot accept its own proposal, by reconsideration or by resolution, and a rule never accepts one.
  await assert.rejects(P.reconsiderResolution(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: news, reviewer: 'agent:research', reason: 'x', proposalId: p1.proposal.id, write: true }), /human decision/)
  await h.rejects(db, "update research.decision_proposals set status = 'ACCEPTED', decided_by = 'agent:research', decided_at = now() where id = $1", [p1.proposal.id], /registered, active human reviewer/)
  await h.rejects(db, "update research.decision_proposals set rationale = 'edited' where id = $1", [p1.proposal.id], /immutable/)
  await h.rejects(db, 'delete from research.decision_proposals where id = $1', [p1.proposal.id], /never deleted/)
  // A decision must match the proposal it accepts.
  await assert.rejects(P.reconsiderResolution(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: official, reviewer: REVIEWER, reason: 'x', proposalId: p1.proposal.id, write: true }), /must match/)
  assert.equal((await history()).length, before, 'nothing decided yet')
  // The reviewer accepts it.
  await P.reconsiderResolution(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: news, reviewer: REVIEWER, reason: 'accepted after review', proposalId: p1.proposal.id, write: true })
  const last = (await history()).at(-1)
  assert.equal(last.kind, 'RECONSIDERED'); assert.equal(last.proposal_id, String(p1.proposal.id)); assert.equal(last.decided_by, REVIEWER)
  assert.deepEqual(await h.one(db, 'select status::text, decided_by from research.decision_proposals where id = $1', [p1.proposal.id]), { status: 'ACCEPTED', decided_by: REVIEWER })
  await assert.rejects(P.reconsiderResolution(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: official, reviewer: REVIEWER, reason: 'y', proposalId: p1.proposal.id, write: true }), /ACCEPTED/)
  // A second proposal is rejected by the reviewer, with a reason; an agent cannot reject.
  const p2 = await P.proposeDecision(db, { subjectTable: 'draft_signings', subjectId: sig, field: 'signing_bonus_usd', observationId: official, proposedBy: 'agent:research', rationale: 'fixture: back to official' })
  await assert.rejects(P.closeProposal(db, p2.proposal.id, { status: 'REJECTED', by: 'agent:research', reason: 'r' }), /registered, active human reviewer/)
  assert.equal((await P.closeProposal(db, p2.proposal.id, { status: 'REJECTED', by: REVIEWER, reason: 'evidence favours the report' })).status, 'REJECTED')
})
