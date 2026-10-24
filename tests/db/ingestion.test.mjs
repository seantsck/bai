// Research ingestion: batch lifecycle, dry run, idempotent apply, identity resolution, conflict preservation, coverage.
// All players and sources here are FICTIONAL test data (TEST_FIXTURE sources); the calendars are the real seeded ones.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import { validateSource, validateEnvelope } from '../../scripts/research/lib/import-format.mjs'

let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-ingest-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const src = (key, authority = 'OTHER') => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: authority, title: `Test source ${key}` })
let n = 0
function file (doc) {
  const f = path.join(dir, `batch-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', sources: [], ...doc }))
  return f
}
const pick = (overrides = {}) => ({
  type: 'DRAFT_SELECTION', source_key: 'test:official', draft_key: '2017-JUNE_AMATEUR', round_code: '3', overall_pick: 80, round_pick: 5, organization: 'SEA',
  position: 'RHP', player: { full_name: 'Testy McFixture', birth_date: '1996-02-02', external_ids: { MLBAM: '9800001' } },
  school: { name: 'Fixture Tech', school_type: 'COLLEGE', region: 'OR', country: 'USA' },
  signing: { status: 'SIGNED', bonus_usd: 500000, source_key: 'test:official' }, ...overrides
})
const counts = async () => h.one(db, `select (select count(*) from players)::int players, (select count(*) from draft_selections)::int selections,
  (select count(*) from draft_signings)::int signings, (select count(*) from international_signings)::int intl, (select count(*) from source_observations)::int observations,
  (select count(*) from sources)::int sources, (select count(*) from coverage_assessments)::int coverage, (select count(*) from schools)::int schools`)
async function run (doc, { write = true } = {}) {
  const { batch } = await P.stageFile(db, file(doc))
  const v = await P.validateBatch(db, batch.id)
  if (!v.ok) return { validation: v }
  return { validation: v, ...(await P.applyBatch(db, batch.id, { write })) }
}

test('source authority: ranked metadata, required on import, never a truth value', async () => {
  const r = await h.rows(db, "select unnest(enum_range(null::source_authority))::text a, source_authority_rank(unnest(enum_range(null::source_authority))) r")
  assert.deepEqual(r.map((x) => x.a), ['OFFICIAL', 'PRIMARY_PUBLIC', 'REPUTABLE_SECONDARY', 'AGGREGATOR', 'ARCHIVE', 'OTHER'])
  assert.deepEqual(r.map((x) => x.r), [1, 2, 3, 4, 5, 6])
  assert.match(validateSource({ source_key: 'x', source_type: 'NEWS_REPORT', title: 't', url: 'https://example.org', retrieved_date: '2026-10-19' }).join(), /authority_level required/)
  assert.match(validateSource({ source_key: 'x', source_type: 'NEWS_REPORT', authority_level: 'OTHER', title: 't', retrieved_date: '2026-10-19' }).join(), /url or reference required/)
  await h.rejects(db, "insert into sources (source_key, source_type, title) values ('nowhere', 'NEWS_REPORT', 'No locator')", [], /sources_locatable_check/)
})

test('provenance required: undeclared sources and unsourced signings are invalid; nothing is staged from a malformed file', async () => {
  const before = await counts()
  const { validation } = await run({ batch_key: 'test-provenance', channel: 'DRAFT', sources: [src('test:official', 'OFFICIAL')], records: [pick({ source_key: 'test:missing' })] })
  assert.equal(validation.ok, false)
  const bad = await h.one(db, "select validation_status, validation_errors from ingest.staged_records r join ingest.import_batches b on b.id = r.batch_id where b.batch_key = 'test-provenance'")
  assert.equal(bad.validation_status, 'INVALID')
  assert.match(bad.validation_errors.join(), /test:missing is not declared/)
  await assert.rejects(P.applyBatch(db, 'test-provenance', { write: true }), /failed validation/)
  assert.ok(validateEnvelope({ format: 'bai-research-import/1', batch_key: 'x', channel: 'DRAFT', sources: [{ source_key: 'y', source_type: 'NEWS_REPORT', authority_level: 'OTHER', title: 't' }], records: [pick()] }).some((e) => /url or reference/.test(e)))
  assert.deepEqual(await counts(), before)
})

test('batch lifecycle: STAGED -> VALIDATED -> APPLIED; the same file is never staged twice; a batch key cannot be reused', async () => {
  const doc = { batch_key: 'test-lifecycle', channel: 'DRAFT', sources: [src('test:official', 'OFFICIAL')], records: [pick()] }
  const f = file(doc)
  const s1 = await P.stageFile(db, f)
  assert.equal(s1.batch.status, 'STAGED')
  await assert.rejects(P.applyBatch(db, s1.batch.id), /not been validated/)
  assert.equal((await P.stageFile(db, f)).already, true)
  await assert.rejects(P.stageFile(db, file({ ...doc, description: 'changed' })), /already used by a different file/)
  assert.equal((await P.validateBatch(db, s1.batch.id)).batch.status, 'VALIDATED')
  await P.applyBatch(db, s1.batch.id, { write: true })
  const b = await h.one(db, 'select status, applied_at from ingest.import_batches where id = $1', [s1.batch.id])
  assert.equal(b.status, 'APPLIED'); assert.ok(b.applied_at)
})

test('dry run writes nothing canonical but reports exactly what apply would do', async () => {
  const before = await counts()
  const doc = { batch_key: 'test-dry-run', channel: 'DRAFT', sources: [src('test:official', 'OFFICIAL')], records: [pick({ overall_pick: 81, round_pick: 6, player: { full_name: 'Dry Run Arm', external_ids: { MLBAM: '9800002' } } })] }
  const dry = await run(doc, { write: false })
  assert.equal(dry.report.step, 'dry-run')
  assert.equal(dry.report.actions.INSERT, 1)
  assert.equal(dry.report.new_players, 1)
  assert.deepEqual(await counts(), before, 'canonical tables unchanged')
  const staged = await h.one(db, "select proposed_action, applied_action from ingest.staged_records r join ingest.import_batches b on b.id = r.batch_id where b.batch_key = 'test-dry-run'")
  assert.equal(staged.proposed_action, 'INSERT'); assert.equal(staged.applied_action, null)
  const real = await P.applyBatch(db, 'test-dry-run', { write: true })
  assert.deepEqual(real.report.actions, dry.report.actions, 'apply does what the dry run said')
})

test('apply is deterministic and idempotent: re-applying changes nothing', async () => {
  const before = await counts()
  const again = await P.applyBatch(db, 'test-lifecycle', { write: true })
  assert.equal(again.report.actions.INSERT ?? 0, 0)
  assert.equal(again.report.new_players, 0)
  assert.deepEqual(await counts(), before)
})

test('strong identity: an external id links despite a different name spelling, and adds the new id', async () => {
  const r = await run({ batch_key: 'test-strong-id', channel: 'DRAFT', sources: [src('test:official', 'OFFICIAL')],
    records: [pick({ draft_key: '2018-JUNE_AMATEUR', overall_pick: 200, round_pick: 20, round_code: '6', player: { full_name: 'Testy Mc Fixture Jr', external_ids: { MLBAM: '9800001', BBREF_MINORS: 'mcfixt000tes' } } })] })
  assert.equal(r.results[0].identity, 'EXACT_EXTERNAL_ID')
  const ids = await h.rows(db, "select id_system::text, external_id from player_external_ids x join players p on p.id = x.player_id where p.slug = 'testy-mcfixture' order by 1")
  assert.deepEqual(ids.map((i) => i.id_system), ['BBREF_MINORS', 'MLBAM'])
  assert.equal((await h.one(db, "select count(*)::int n from draft_selections s join players p on p.id = s.player_id where p.slug = 'testy-mcfixture'")).n, 2, 'one player, two drafts')
})

test('composite identity: name + exact birth date links when no id is given', async () => {
  const r = await run({ batch_key: 'test-composite', channel: 'INTERNATIONAL', sources: [src('test:official', 'OFFICIAL')],
    records: [{ type: 'INTERNATIONAL_SIGNING', source_key: 'test:official', organization: 'TEX', signing_date: '2016-07-02', signing_date_precision: 'DAY', pathway: 'OTHER',
      player: { full_name: 'Testy McFixture', birth_date: '1996-02-02' }, costs: {} }] })
  assert.equal(r.results[0].identity, 'EXACT_COMPOSITE')
})

test('ambiguous identity is refused: name-only matches are held, never merged, until a researcher decides', async () => {
  for (const [slug, dob] of [['shared-name-1', '1999-01-01'], ['shared-name-2', '2000-02-02']]) {
    await db.query("insert into players (slug, full_name, display_name, birth_date, birth_date_precision) values ($1, 'Shared Name', 'Shared Name', $2, 'DAY')", [slug, dob])
  }
  await db.query("insert into players (slug, full_name, display_name) values ('lonely-name', 'Lonely Name', 'Lonely Name')")
  const before = await counts()
  const r = await run({ batch_key: 'test-ambiguous', channel: 'DRAFT', sources: [src('test:official', 'OFFICIAL')], records: [
    pick({ overall_pick: 90, round_pick: 15, player: { full_name: 'Shared Name' } }),
    pick({ overall_pick: 91, round_pick: 16, player: { full_name: 'Lonely Name' } })] })
  assert.deepEqual(r.validation.counts.identity, { AMBIGUOUS: 1, PROBABLE_MATCH: 1 })
  assert.deepEqual(r.results.map((x) => x.action), ['HELD', 'HELD'])
  assert.deepEqual(await counts(), before, 'held records write nothing')
  const q = await h.rows(db, "select detail from v_research_queue where queue_key = 'IDENTITY_AMBIGUOUS' order by detail")
  assert.equal(q.length, 2)
  // An external-id contradiction is a CONFLICT state, also held.
  const c = await h.one(db, "select state from ingest.resolve_identity('{\"full_name\":\"Testy McFixture\",\"external_ids\":{\"MLBAM\":\"9800001\",\"BBREF_MINORS\":\"someone-else\"}}')")
  assert.equal(c.state, 'CONFLICT')
  // Researcher decision: link the probable match, reject the ambiguous one.
  const recs = await h.rows(db, "select r.id, r.payload #>> '{player,full_name}' as name from ingest.staged_records r join ingest.import_batches b on b.id = r.batch_id where b.batch_key = 'test-ambiguous' order by record_index")
  await assert.rejects(P.decideIdentity(db, recs[1].id, { playerSlug: 'lonely-name', operator: 'tester' }), /--operator and --note/)
  await P.decideIdentity(db, recs[1].id, { playerSlug: 'lonely-name', operator: 'tester', note: 'same school and year in a second source' })
  await P.decideIdentity(db, recs[0].id, { reject: true, operator: 'tester', note: 'cannot tell the two apart yet' })
  const after = await P.applyBatch(db, 'test-ambiguous', { write: true })
  assert.deepEqual(after.results.map((x) => x.action), ['HELD', 'INSERT'])
  assert.equal((await h.one(db, "select count(*)::int n from draft_selections s join players p on p.id = s.player_id where p.slug = 'lonely-name'")).n, 1)
})

test('conflicts are preserved, never last-write-wins; resolution is explicit and traceable', async () => {
  const signing = (bonus, source, date = '2016-07-02') => ({ type: 'INTERNATIONAL_SIGNING', source_key: source, organization: 'MIN', signing_date: date, signing_date_precision: 'DAY',
    pathway: 'INTERNATIONAL_AMATEUR', market: { key: 'VEN', name: 'Venezuela' }, player: { full_name: 'Conflicted Prospect', birth_date: '2000-03-03', external_ids: { MLBAM: '9800010' } },
    costs: { signing_bonus_usd: bonus } })
  await run({ batch_key: 'test-conflict-1', channel: 'INTERNATIONAL', sources: [src('test:blog', 'OTHER')], records: [signing(1200000, 'test:blog')] })
  const second = await run({ batch_key: 'test-conflict-2', channel: 'INTERNATIONAL', sources: [src('test:club', 'OFFICIAL')], records: [signing(1100000, 'test:club', '2016-07-03')] })
  assert.equal(second.results[0].action, 'CONFLICT')
  const row = await h.one(db, "select s.id, s.signing_bonus_usd::float8 bonus, s.signing_date::text d from international_signings s join players p on p.id = s.player_id where p.slug = 'conflicted-prospect'")
  assert.equal(row.bonus, 1200000, 'canonical value not overwritten by the later batch')
  assert.equal(row.d, '2016-07-02')
  const conflicts = (await P.openConflicts(db)).filter((c) => String(c.subject_id) === String(row.id))
  assert.deepEqual(conflicts.map((c) => c.field_name).sort(), ['signing_bonus_usd', 'signing_date'])
  const bonus = conflicts.find((c) => c.field_name === 'signing_bonus_usd')
  assert.equal(bonus.observations.length, 2, 'both observations kept')
  assert.equal(bonus.declared_rule, 'PREFER_HIGHER_AUTHORITY')
  const official = bonus.observations.find((o) => o.authority === 'OFFICIAL')
  assert.equal(bonus.rule_outcome, official.observation_id)
  // The date rule does not decide two day-precision dates: operator required.
  const date = conflicts.find((c) => c.field_name === 'signing_date')
  assert.equal(date.rule_outcome, null)
  await assert.rejects(P.resolveConflict(db, { subjectTable: 'international_signings', subjectId: row.id, field: 'signing_date', useRule: true, write: true }), /operator must choose/)
  const dry = await P.resolveConflict(db, { subjectTable: 'international_signings', subjectId: row.id, field: 'signing_bonus_usd', useRule: true })
  assert.equal(dry.written, false)
  assert.equal((await h.one(db, 'select signing_bonus_usd::float8 b from international_signings where id = $1', [row.id])).b, 1200000, 'dry-run resolve changes nothing')
  await P.resolveConflict(db, { subjectTable: 'international_signings', subjectId: row.id, field: 'signing_bonus_usd', useRule: true, write: true })
  assert.equal((await h.one(db, 'select signing_bonus_usd::float8 b from international_signings where id = $1', [row.id])).b, 1100000)
  const fr = await h.one(db, "select decided_by, rule::text, cardinality(considered_observation_ids) n from fact_resolutions where subject_table = 'international_signings' and subject_id = $1", [row.id])
  assert.deepEqual(fr, { decided_by: 'rule:PREFER_HIGHER_AUTHORITY', rule: 'PREFER_HIGHER_AUTHORITY', n: 2 })
  assert.equal((await h.one(db, "select count(*)::int n from source_observations where subject_table = 'international_signings' and subject_id = $1 and field_name = 'signing_bonus_usd'", [row.id])).n, 2, 'losing evidence is kept')
  await P.resolveConflict(db, { subjectTable: 'international_signings', subjectId: row.id, field: 'signing_date', observationId: date.observations[0].observation_id, operator: 'tester', rationale: 'transaction date is canonical', write: true })
  assert.equal((await P.openConflicts(db)).filter((c) => String(c.subject_id) === String(row.id)).length, 0)
})

test('unsigned picks stay selections; a re-drafted player keeps one identity with two selections and two statuses', async () => {
  const p = { full_name: 'Twice Drafted', birth_date: '1997-07-07', external_ids: { MLBAM: '9800020' } }
  const r = await run({ batch_key: 'test-redraft', channel: 'DRAFT', sources: [src('test:official', 'OFFICIAL')], records: [
    pick({ draft_key: '2017-JUNE_AMATEUR', overall_pick: 120, round_pick: 9, round_code: '4', organization: 'LAD', player: p, signing: { status: 'DID_NOT_SIGN', source_key: 'test:official' } }),
    pick({ draft_key: '2018-JUNE_AMATEUR', overall_pick: 110, round_pick: 3, round_code: '4', organization: 'DET', player: p, signing: { status: 'SIGNED', bonus_usd: null, source_key: 'test:official' } })] })
  assert.equal(r.report.new_players, 1)
  assert.deepEqual(r.results.map((x) => x.identity), ['NO_MATCH', 'EXACT_EXTERNAL_ID'])
  const picks = await h.rows(db, "select draft_year, signing_status, signing_bonus_usd from v_draft_picks v join players p on p.id = v.player_id where p.slug = 'twice-drafted' order by draft_year")
  assert.deepEqual(picks, [{ draft_year: 2017, signing_status: 'DID_NOT_SIGN', signing_bonus_usd: null }, { draft_year: 2018, signing_status: 'SIGNED', signing_bonus_usd: null }])
})

test('unknown signing status writes no signing row; later evidence fills it; a contradicting status is a conflict', async () => {
  const p = { full_name: 'Status Unknown', external_ids: { MLBAM: '9800030' } }
  await run({ batch_key: 'test-unknown-1', channel: 'DRAFT', sources: [src('test:official', 'OFFICIAL')], records: [pick({ overall_pick: 300, round_pick: 3, round_code: '10', player: p, signing: { status: 'UNKNOWN' } })] })
  const v = await h.one(db, "select signing_status from v_draft_picks v join players p on p.id = v.player_id where p.slug = 'status-unknown'")
  assert.equal(v.signing_status, 'UNKNOWN')
  assert.equal((await h.one(db, "select count(*)::int n from v_research_queue q join players p on p.id = q.player_id where p.slug = 'status-unknown' and queue_key = 'DRAFT_SIGNING_STATUS_UNKNOWN'")).n, 1)
  await run({ batch_key: 'test-unknown-2', channel: 'DRAFT', sources: [src('test:ref', 'AGGREGATOR')], records: [pick({ source_key: 'test:ref', overall_pick: 300, round_pick: 3, round_code: '10', player: p, signing: { status: 'SIGNED', source_key: 'test:ref' } })] })
  assert.equal((await h.one(db, "select signing_status from v_draft_picks v join players p on p.id = v.player_id where p.slug = 'status-unknown'")).signing_status, 'SIGNED')
  const r3 = await run({ batch_key: 'test-unknown-3', channel: 'DRAFT', sources: [src('test:news', 'REPUTABLE_SECONDARY')], records: [pick({ source_key: 'test:news', overall_pick: 300, round_pick: 3, round_code: '10', player: p, signing: { status: 'DID_NOT_SIGN', source_key: 'test:news' } })] })
  assert.equal(r3.results[0].action, 'CONFLICT')
  assert.equal((await h.one(db, "select signing_status from v_draft_picks v join players p on p.id = v.player_id where p.slug = 'status-unknown'")).signing_status, 'SIGNED', 'no last-write-wins')
  assert.ok((await P.openConflicts(db)).some((c) => c.subject_table === 'draft_signings' && c.field_name === 'signing_status' && c.declared_rule === 'REQUIRE_OPERATOR'))
})

test('a signing date fills an unknown date with its precision; a different date is a conflict, and resolving one keeps date and precision together', async () => {
  const p = { full_name: 'Dated Signee', external_ids: { MLBAM: '9800090' } }
  const at = (key, source, date) => ({ batch_key: key, channel: 'DRAFT', sources: [src(source, 'OFFICIAL')], records: [pick({ source_key: source, overall_pick: 340, round_pick: 13, round_code: '11', player: p,
    signing: { status: 'SIGNED', bonus_usd: null, source_key: source, ...(date ? { date, date_precision: 'DAY' } : {}) } })] })
  await run(at('test-dated-1', 'test:club', null))
  const row = () => h.one(db, "select g.id, g.signing_date::text d, g.signing_date_precision::text p from draft_signings g join draft_selections s on s.id = g.draft_selection_id join players x on x.id = s.player_id where x.slug = 'dated-signee'")
  assert.deepEqual(await row().then(({ d, p }) => ({ d, p })), { d: null, p: null })
  const r2 = await run(at('test-dated-2', 'test:wire', '2017-06-20'))
  assert.equal(r2.results[0].action, 'UPDATE_UNKNOWN')
  assert.deepEqual(await row().then(({ d, p }) => ({ d, p })), { d: '2017-06-20', p: 'DAY' })
  const r3 = await run(at('test-dated-3', 'test:other', '2017-06-22'))
  assert.equal(r3.results[0].action, 'CONFLICT')
  const { id } = await row()
  const c = (await P.openConflicts(db)).find((x) => x.subject_table === 'draft_signings' && String(x.subject_id) === String(id) && x.field_name === 'signing_date')
  const chosen = c.observations.find((o) => o.source_key === 'test:other')
  await P.resolveConflict(db, { subjectTable: 'draft_signings', subjectId: id, field: 'signing_date', observationId: chosen.observation_id, operator: 'tester', rationale: 'fixture: the later contract date', write: true })
  assert.deepEqual(await row().then(({ d, p }) => ({ d, p })), { d: '2017-06-22', p: 'DAY' })
})

test('equal claims compare equal across sources: values are stored with one JSON type per field', async () => {
  const sel = await h.one(db, "select s.id from draft_selections s join players p on p.id = s.player_id where p.slug = 'status-unknown'")
  const vals = await h.rows(db, "select field_name, jsonb_typeof(observed_value) t, count(distinct observed_value)::int n from source_observations where subject_table = 'draft_selections' and subject_id = $1 and field_name in ('round_code', 'round_pick') group by 1, 2 order by 1", [sel.id])
  assert.deepEqual(vals, [{ field_name: 'round_code', t: 'string', n: 1 }, { field_name: 'round_pick', t: 'number', n: 1 }])
  assert.equal(P.observedJson('round_code', 10), '"10"')
  assert.equal(P.observedJson('signing_bonus_usd', '1777500.00'), '1777500')
})

test('unknown cost is not zero, and a known zero stays zero', async () => {
  await run({ batch_key: 'test-costs', channel: 'INTERNATIONAL', sources: [src('test:official', 'OFFICIAL')], records: [
    { type: 'INTERNATIONAL_SIGNING', source_key: 'test:official', organization: 'KC', signing_date: '2023-01-15', signing_date_precision: 'DAY', pathway: 'INTERNATIONAL_AMATEUR', player: { full_name: 'Unknown Cost', external_ids: { MLBAM: '9800040' } }, costs: {} },
    { type: 'INTERNATIONAL_SIGNING', source_key: 'test:official', organization: 'KC', signing_date: '2023-01-16', signing_date_precision: 'DAY', pathway: 'POSTING_SYSTEM', player: { full_name: 'Known Zero Fee', external_ids: { MLBAM: '9800041' } }, costs: { signing_bonus_usd: 100000, posting_fee_usd: 0 } }] })
  const rows = await h.rows(db, "select p.slug, s.known_total_cost_usd::float8 t, s.cost_completeness::text c, s.posting_fee_usd::float8 f, ip.period_key from international_signings s join players p on p.id = s.player_id join international_signing_periods ip on ip.id = s.signing_period_id where p.slug in ('unknown-cost', 'known-zero-fee') order by 1")
  assert.deepEqual(rows, [{ slug: 'known-zero-fee', t: 100000, c: 'PARTIAL', f: 0, period_key: '2023' }, { slug: 'unknown-cost', t: null, c: 'UNKNOWN', f: null, period_key: '2023' }])
  assert.ok((await h.rows(db, "select 1 from v_research_queue q join players p on p.id = q.player_id where p.slug = 'unknown-cost' and queue_key = 'MISSING_COST'")).length === 1)
})

test('a signing date outside every period, or outside its declared period, fails validation', async () => {
  const rec = (date, period) => ({ type: 'INTERNATIONAL_SIGNING', source_key: 'test:official', organization: 'KC', signing_date: date, signing_date_precision: 'DAY', period_key: period, pathway: 'OTHER', player: { full_name: 'Gap Signee' }, costs: {} })
  const gap = await run({ batch_key: 'test-gap', channel: 'INTERNATIONAL', sources: [src('test:official', 'OFFICIAL')], records: [rec('2020-11-01')] })
  assert.equal(gap.validation.ok, false)
  const wrong = await run({ batch_key: 'test-wrong-period', channel: 'INTERNATIONAL', sources: [src('test:official', 'OFFICIAL')], records: [rec('2019-07-02', '2018-19')] })
  assert.equal(wrong.validation.ok, false)
})

test('coverage follows applied data: claims apply to their scope only, other touched cells are INDIVIDUALLY_VERIFIED', async () => {
  const r = await run({ batch_key: 'test-coverage', channel: 'DRAFT', sources: [src('test:official', 'OFFICIAL')],
    coverage_claims: [{ scope_key: '2019-JUNE_AMATEUR', organization: 'ATL', coverage_state: 'PARTIAL_RECONSTRUCTION', gap_notes: 'test' }],
    records: [pick({ draft_key: '2019-JUNE_AMATEUR', overall_pick: 400, round_pick: 1, round_code: '13', organization: 'ATL', player: { full_name: 'Coverage One', external_ids: { MLBAM: '9800050' } } }),
      pick({ draft_key: '2019-JUNE_AMATEUR', overall_pick: 401, round_pick: 2, round_code: '13', organization: 'ATL', player: { full_name: 'Coverage Two', external_ids: { MLBAM: '9800051' } } }),
      pick({ draft_key: '2019-JUNE_AMATEUR', overall_pick: 402, round_pick: 3, round_code: '13', organization: 'BOS', player: { full_name: 'Coverage Three', external_ids: { MLBAM: '9800052' } } })] })
  assert.deepEqual(r.report.coverage.map((c) => [c.organization, c.state, c.tracked]), [['ATL', 'PARTIAL_RECONSTRUCTION', 2], ['BOS', 'INDIVIDUALLY_VERIFIED', 1]])
  const bad = await run({ batch_key: 'test-coverage-census', channel: 'DRAFT', sources: [src('test:official', 'OFFICIAL')],
    coverage_claims: [{ scope_key: '2019-JUNE_AMATEUR', organization: 'CIN', coverage_state: 'COMPLETE_CENSUS' }],
    records: [pick({ draft_key: '2019-JUNE_AMATEUR', overall_pick: 403, round_pick: 4, round_code: '13', organization: 'CIN', player: { full_name: 'Coverage Four', external_ids: { MLBAM: '9800053' } } })] }).catch((e) => e)
  assert.match(bad.message, /coverage_assessments_check|check constraint/, 'a complete census needs an expected count and a source')
})

test('coverage dashboard and queue read models: bounded, public, no internals exposed', async () => {
  await db.query('select refresh_read_models()')
  const cells = await h.one(db, 'select count(*)::int n from rm_research_coverage')
  assert.equal(cells.n, (12 + 12) * 30)
  const atl = await h.one(db, "select tracked_records, coverage_state::text s, supports_population_rate r from rm_research_coverage c join organizations o on o.id = c.organization_id where o.franchise_key = 'ATL' and scope_key = '2019-JUNE_AMATEUR'")
  assert.deepEqual(atl, { tracked_records: 2, s: 'PARTIAL_RECONSTRUCTION', r: false })
  const q = await h.rows(db, 'select queue_key, open_items from rm_research_queue_summary order by priority, queue_key')
  assert.equal(q.length, 10)
  await h.asRole(db, 'anon', async () => {
    assert.equal((await h.one(db, 'select count(*)::int n from rm_research_coverage')).n, 720)
    assert.equal((await h.one(db, 'select count(*)::int n from rm_research_queue_summary')).n, 10)
  })
  for (const sql of ['select * from v_research_queue', 'select * from v_open_fact_conflicts', 'select * from fact_resolutions', 'select * from ingest.import_batches', 'select * from ingest.staged_records', 'select * from analytics.research_coverage_cells']) {
    await assert.rejects(h.asRole(db, 'anon', () => db.query(sql)), /permission denied/, sql)
  }
})

test('the prospect promotion incentive pick imports as the published round PPI with the existing PRIZE phase, between round 1 and competitive balance A', async () => {
  const rec = (overall, round, type, name, mlbam) => pick({ draft_key: '2023-JUNE_AMATEUR', round_code: round, overall_pick: overall, round_pick: 1, selection_type: type, organization: 'SEA', player: { full_name: name, external_ids: { MLBAM: mlbam } }, signing: { status: 'UNKNOWN' } })
  const out = await run({ batch_key: 'test-ppi', channel: 'DRAFT', sources: [src('test:official', 'OFFICIAL')], records: [rec(29, 'PPI', 'PRIZE', 'Ppi Fixture One', '9981001'), rec(30, 'CB-A', 'COMPETITIVE_BALANCE', 'Ppi Fixture Two', '9981002'), rec(5, '1', 'STANDARD', 'Ppi Fixture Three', '9981003')] })
  assert.equal(out.validation.ok, true)
  const rounds = (await h.rows(db, `select r.round_code, r.phase::text phase, r.round_order from draft_rounds r join drafts d on d.id = r.draft_id where d.draft_key = '2023-JUNE_AMATEUR' and r.round_code in ('1', 'PPI', 'CB-A') order by r.round_order`))
  assert.deepEqual(rounds.map((r) => [r.round_code, r.phase]), [['1', 'REGULAR'], ['PPI', 'PRIZE'], ['CB-A', 'COMPETITIVE_BALANCE_A']])
  const sel = await h.one(db, `select s.selection_type::text t, r.round_code c from draft_selections s join draft_rounds r on r.id = s.round_id where s.overall_pick = 29 and s.draft_id = (select id from drafts where draft_key = '2023-JUNE_AMATEUR')`)
  assert.deepEqual(sel, { t: 'PRIZE', c: 'PPI' })
})
