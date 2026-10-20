// Acquisition dispositions (migration 022): how each ACQUISITION ended, separate from the player's career outcome.
// Shapes follow real cases (a pick unsigned in 2017 and drafted, and signed, by the same club in 2018; a pick unsigned by
// one club and signed by another the next year; an international signing voided and the player signed elsewhere; a
// trade), but every player, id and value is FICTIONAL fixture data (TEST_FIXTURE sources).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'

let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-dispositions-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const src = (key, authority = 'OFFICIAL') => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: authority, title: `Disposition fixture ${key}` })
let n = 0
async function stage (doc, org) {
  const f = path.join(dir, `b-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', ...doc }))
  const { batch } = await P.stageFile(db, f, { organization: org })
  return { batch, validation: await P.validateBatch(db, batch.id) }
}
async function run (doc, org = 'LAD') {
  const s = await stage(doc, org)
  assert.ok(s.validation.ok, JSON.stringify(s.validation))
  return P.applyBatch(db, s.batch.id, { write: true })
}
const ID = { twice: '9860001', other: '9860002', traded: '9860003', intl: '9860004', legacy: '9860005' }
const who = (k, name) => ({ full_name: name, external_ids: { MLBAM: ID[k] } })
const pick = (k, name, draft, overall, org, signed) => ({ type: 'DRAFT_SELECTION', source_key: 'x:draft', draft_key: draft, round_code: String(Math.ceil(overall / 30)), overall_pick: overall,
  round_pick: overall % 30 || 30, organization: org, player: who(k, name), school: { name: 'Fixture High', school_type: 'HIGH_SCHOOL' },
  signing: signed ? { status: 'SIGNED', bonus_usd: 125000, source_key: 'x:draft' } : { status: 'DID_NOT_SIGN', source_key: 'x:draft' } })
const audit = (k, name, org, extra) => ({ type: 'OUTCOME_AUDIT', source_key: 'x:mlb', organization: org, player: who(k, name), audit_state: 'AUDITED_NO_MLB',
  observation_through_season: 2026, audited_on: '2026-10-20', details: { as_of_date: '2026-10-20', reached_affiliated: true, current_status: 'INACTIVE' }, ...extra })
const dispositions = async (k) => h.rows(db, `select a.channel::text, o.franchise_key org, a.scope_key, a.signing_status, a.disposition::text, a.disposition_date::text
  from analytics.acquisition_tenures a join organizations o on o.id = a.organization_id join player_external_ids x on x.player_id = a.player_id and x.id_system = 'MLBAM'
  where x.external_id = $1 order by a.acquired_on`, [ID[k]])

test('setup: picks and signings, including a player drafted twice by the same club and one drafted by two clubs', async () => {
  await run({ batch_key: 'x-lad-2017', channel: 'DRAFT', sources: [src('x:draft')], records: [pick('twice', 'Twice Drafted', '2017-JUNE_AMATEUR', 430, 'LAD', false),
    pick('other', 'Other Club', '2017-JUNE_AMATEUR', 431, 'LAD', false), pick('traded', 'Later Traded', '2017-JUNE_AMATEUR', 432, 'LAD', true)] })
  await run({ batch_key: 'x-lad-2018', channel: 'DRAFT', sources: [src('x:draft')], records: [pick('twice', 'Twice Drafted', '2018-JUNE_AMATEUR', 284, 'LAD', true)] })
  await run({ batch_key: 'x-sea-2018', channel: 'DRAFT', sources: [src('x:draft')], records: [pick('other', 'Other Club', '2018-JUNE_AMATEUR', 285, 'SEA', true)] }, 'SEA')
  await run({ batch_key: 'x-intl', channel: 'INTERNATIONAL', sources: [src('x:draft')], records: [
    { type: 'INTERNATIONAL_SIGNING', source_key: 'x:draft', organization: 'ATL', signing_date: '2016-07-02', signing_date_precision: 'DAY', pathway: 'INTERNATIONAL_AMATEUR', costs: {}, player: who('intl', 'Freed Prospect') }] }, 'ATL')
  await run({ batch_key: 'x-intl-2', channel: 'INTERNATIONAL', sources: [src('x:draft')], records: [
    { type: 'INTERNATIONAL_SIGNING', source_key: 'x:draft', organization: 'LAD', signing_date: '2017-12-15', signing_date_precision: 'DAY', pathway: 'INTERNATIONAL_AMATEUR', costs: {}, player: who('intl', 'Freed Prospect') }] })
  assert.equal((await dispositions('twice')).length, 2)
})

test('a player drafted twice keeps one disposition per acquisition: the 2017 UNSIGNED never reaches the 2018 signing', async () => {
  await run({ batch_key: 'x-out-2017', channel: 'OUTCOMES', sources: [src('x:mlb')], records: [
    audit('twice', 'Twice Drafted', 'LAD', { acquisition: { draft_key: '2017-JUNE_AMATEUR', overall_pick: 430 }, disposition: { value: 'UNSIGNED', as_of_date: '2026-10-20' } })] })
  // The 2018 audit restates the same player-level details (no conflict) and gives the 2018 acquisition its own ending.
  const r = await run({ batch_key: 'x-out-2018', channel: 'OUTCOMES', sources: [src('x:mlb')], records: [
    audit('twice', 'Twice Drafted', 'LAD', { acquisition: { draft_key: '2018-JUNE_AMATEUR', overall_pick: 284 }, disposition: { value: 'RELEASED', date: '2021-03-20', as_of_date: '2026-10-20' } })] })
  assert.equal(r.report.conflicts, 0, 'player-level details agree; the acquisitions differ')
  assert.deepEqual(await dispositions('twice'), [
    { channel: 'DRAFT', org: 'LAD', scope_key: '2017-JUNE_AMATEUR', signing_status: 'DID_NOT_SIGN', disposition: 'UNSIGNED', disposition_date: null },
    { channel: 'DRAFT', org: 'LAD', scope_key: '2018-JUNE_AMATEUR', signing_status: 'SIGNED', disposition: 'RELEASED', disposition_date: '2021-03-20' }])
  // The player's career outcome is one row; nothing per-acquisition was written to it.
  assert.equal((await h.one(db, `select count(*)::int n from outcome_audits a join player_external_ids x on x.player_id = a.player_id where x.external_id = $1`, [ID.twice])).n, 1)
})

test('the database refuses contradictions, however they arrive', async () => {
  const sel = async (draft, pickNo) => (await h.one(db, 'select s.id, s.player_id, s.organization_id from draft_selections s join drafts d on d.id = s.draft_id where d.draft_key = $1 and s.overall_pick = $2', [draft, pickNo]))
  const s18 = await sel('2018-JUNE_AMATEUR', 284)
  const s17 = await sel('2017-JUNE_AMATEUR', 431)
  const srcId = (await h.one(db, "select id from sources where source_key = 'x:mlb'")).id
  const ins = (s, disp, date = null) => h.rejects(db, `insert into acquisition_dispositions (draft_selection_id, organization_id, player_id, disposition, disposition_date, disposition_date_precision, as_of_date, source_id)
    values ($1, $2, $3, $4, $5, $6, '2026-10-20', $7)`, [s.id, s.organization_id, s.player_id, disp, date, date ? 'DAY' : null, srcId], null)
  // The McLain collision itself: UNSIGNED on the signed 2018 acquisition (it already has RELEASED; the update is refused too).
  await h.rejects(db, "update acquisition_dispositions set disposition = 'UNSIGNED', disposition_date = null, disposition_date_precision = null where draft_selection_id = $1", [s18.id], /UNSIGNED, but the 2018-JUNE_AMATEUR acquisition signed/)
  // An exit on a pick that never signed; an exit before the acquisition; another club's acquisition.
  let e = await ins(s17, 'RELEASED', '2019-01-01'); assert.match(e.message, /RELEASED, but the 2017-JUNE_AMATEUR pick did not sign/)
  const tr = await sel('2017-JUNE_AMATEUR', 432)
  e = await ins(tr, 'RELEASED', '2016-01-01'); assert.match(e.message, /predates the acquisition/)
  const sea = await sel('2018-JUNE_AMATEUR', 285)
  e = await h.rejects(db, `insert into acquisition_dispositions (draft_selection_id, organization_id, player_id, disposition, as_of_date, source_id)
    values ($1, (select id from organizations where franchise_key = 'LAD'), $2, 'RETAINED', '2026-10-20', $3)`, [sea.id, sea.player_id, srcId], null)
  assert.match(e.message, /player or organization differs/)
  // A signing status that later flips to SIGNED under an UNSIGNED disposition is refused at commit.
  await h.rejects(db, "update draft_signings set signing_status = 'SIGNED' where draft_selection_id = (select id from draft_selections where overall_pick = 430 and draft_id = (select id from drafts where draft_key = '2017-JUNE_AMATEUR'))", [], /UNSIGNED, but the 2017-JUNE_AMATEUR acquisition signed/)
  // Through an import: UNSIGNED for a signed acquisition fails the whole batch; nothing is written.
  const bad = await stage({ batch_key: 'x-bad', channel: 'OUTCOMES', sources: [src('x:mlb')], records: [
    audit('traded', 'Later Traded', 'LAD', { acquisition: { draft_key: '2017-JUNE_AMATEUR', overall_pick: 432 }, disposition: { value: 'UNSIGNED', as_of_date: '2026-10-20' } })] }, 'LAD')
  assert.ok(bad.validation.ok)
  await assert.rejects(P.applyBatch(db, bad.batch.id, { write: true }), /UNSIGNED, but the 2017-JUNE_AMATEUR acquisition signed/)
  assert.deepEqual((await dispositions('traded')).map((d) => d.disposition), [null])
  // The format refuses a disposition with no acquisition, a TRADED with no trade, and a date on a non-exit.
  const fmt = await stage({ batch_key: 'x-fmt', channel: 'OUTCOMES', sources: [src('x:mlb')], records: [
    audit('traded', 'Later Traded', 'LAD', { disposition: { value: 'RELEASED', as_of_date: '2026-10-20' } }),
    audit('traded', 'Later Traded', 'LAD', { acquisition: { draft_key: '2017-JUNE_AMATEUR', overall_pick: 432 }, disposition: { value: 'TRADED', as_of_date: '2026-10-20' } }),
    audit('traded', 'Later Traded', 'LAD', { acquisition: { draft_key: '2017-JUNE_AMATEUR', overall_pick: 432 }, disposition: { value: 'RETAINED', date: '2020-01-01', as_of_date: '2026-10-20' } })] }, 'LAD')
  const errs = (await h.rows(db, "select validation_errors from ingest.staged_records r join ingest.import_batches b on b.id = r.batch_id where b.batch_key = 'x-fmt' order by record_index")).map((r) => r.validation_errors.join(' '))
  assert.match(errs[0], /needs the acquisition it ends/)
  assert.match(errs[1], /TRADED needs transaction_ref/)
  assert.match(errs[2], /RETAINED has none/)
})

test('trades: a TRADED disposition must name a trade that sent this player from this club, and takes its date', async () => {
  const r = await run({ batch_key: 'x-out-traded', channel: 'OUTCOMES', sources: [src('x:mlb')], records: [
    audit('traded', 'Later Traded', 'LAD', { acquisition: { draft_key: '2017-JUNE_AMATEUR', overall_pick: 432 }, transactions: [{ ref: 't1', type: 'TRADE', date: '2019-12-10', from_organization: 'LAD', to_organization: 'TB' }],
      disposition: { value: 'TRADED', transaction_ref: 't1', as_of_date: '2026-10-20' } })] })
  assert.equal(r.report.conflicts, 0)
  assert.deepEqual((await dispositions('traded')).map((d) => [d.disposition, d.disposition_date]), [['TRADED', '2019-12-10']])
  // A trade in the other direction cannot end LAD's acquisition.
  const tx = await h.one(db, `insert into transactions (transaction_type, transaction_date, source_id) select 'TRADE', '2020-01-05', id from sources where source_key = 'x:mlb' returning id`)
  await db.query(`insert into trade_packages (transaction_id, from_organization_id, to_organization_id) select $1, (select id from organizations where franchise_key = 'TB'), (select id from organizations where franchise_key = 'LAD')`, [tx.id])
  await h.rejects(db, `update acquisition_dispositions set disposition_transaction_id = $1, disposition_date = '2020-01-05' where draft_selection_id = (select s.id from draft_selections s join drafts d on d.id = s.draft_id where d.draft_key = '2017-JUNE_AMATEUR' and s.overall_pick = 432)`,
    [tx.id], /did not send this player from this organization/)
})

test('organizational changes: one player, two clubs, each acquisition ends on its own terms (unsigned pick, voided international signing)', async () => {
  await run({ batch_key: 'x-out-other', channel: 'OUTCOMES', sources: [src('x:mlb')], records: [
    audit('other', 'Other Club', 'LAD', { acquisition: { draft_key: '2017-JUNE_AMATEUR', overall_pick: 431 }, disposition: { value: 'UNSIGNED', as_of_date: '2026-10-20' } }),
    audit('other', 'Other Club', 'SEA', { cross_organization: 'fixture: the club that signed him a year later', acquisition: { draft_key: '2018-JUNE_AMATEUR', overall_pick: 285 },
      disposition: { value: 'RETAINED', as_of_date: '2026-10-20' } })] })
  assert.deepEqual((await dispositions('other')).map((d) => [d.org, d.signing_status, d.disposition]), [['LAD', 'DID_NOT_SIGN', 'UNSIGNED'], ['SEA', 'SIGNED', 'RETAINED']])
  // International: UNSIGNED is never an international disposition; a voided contract is OTHER with its reason.
  const bad = await stage({ batch_key: 'x-intl-bad', channel: 'OUTCOMES', sources: [src('x:mlb')], records: [
    audit('intl', 'Freed Prospect', 'ATL', { acquisition: { period_key: '2016-17' }, disposition: { value: 'UNSIGNED', as_of_date: '2026-10-20' } })] }, 'ATL')
  await assert.rejects(P.applyBatch(db, bad.batch.id, { write: true }), /UNSIGNED on an international signing/)
  await run({ batch_key: 'x-intl-out', channel: 'OUTCOMES', sources: [src('x:mlb')], records: [
    audit('intl', 'Freed Prospect', 'ATL', { acquisition: { period_key: '2016-17' }, disposition: { value: 'OTHER', date: '2017-11-21', as_of_date: '2026-10-20', notes: 'contract voided by the Commissioner; player declared a free agent' } }),
    audit('intl', 'Freed Prospect', 'LAD', { cross_organization: 'fixture: his second signing club', acquisition: { period_key: '2017-18' }, disposition: { value: 'RETAINED', as_of_date: '2026-10-20' } })] }, 'ATL')
  assert.deepEqual((await dispositions('intl')).map((d) => [d.org, d.scope_key, d.disposition, d.disposition_date]), [['ATL', '2016-17', 'OTHER', '2017-11-21'], ['LAD', '2017-18', 'RETAINED', null]])
})

test('legacy records (disposition on the player\'s details) reach an acquisition only when the player has exactly one with that club', async () => {
  // Ambiguous: two LAD acquisitions. Recorded on the legacy column only; no acquisition receives it.
  const amb = await stage({ batch_key: 'x-legacy-amb', channel: 'OUTCOMES', sources: [src('x:mlb')], records: [
    { ...audit('twice', 'Twice Drafted', 'LAD', {}), details: { as_of_date: '2026-10-20', reached_affiliated: true, current_status: 'INACTIVE', disposition: 'UNSIGNED' } }] }, 'LAD')
  assert.ok(amb.validation.ok)
  const warn = await h.one(db, "select validation_warnings w from ingest.staged_records r join ingest.import_batches b on b.id = r.batch_id where b.batch_key = 'x-legacy-amb'")
  assert.match(warn.w.join(' '), /exactly one with this organization/)
  await P.applyBatch(db, amb.batch.id, { write: true })
  assert.deepEqual((await dispositions('twice')).map((d) => d.disposition), ['UNSIGNED', 'RELEASED'], 'unchanged')
  // Unambiguous: one acquisition.
  await run({ batch_key: 'x-legacy-one', channel: 'DRAFT', sources: [src('x:draft')], records: [pick('legacy', 'Legacy Form', '2017-JUNE_AMATEUR', 433, 'LAD', true)] })
  await run({ batch_key: 'x-legacy-ok', channel: 'OUTCOMES', sources: [src('x:mlb')], records: [
    { ...audit('legacy', 'Legacy Form', 'LAD', {}), details: { as_of_date: '2026-10-20', reached_affiliated: true, current_status: 'RELEASED', disposition: 'RELEASED' } }] })
  assert.deepEqual((await dispositions('legacy')).map((d) => [d.disposition, d.disposition_date]), [['RELEASED', null]])
  // A later, explicit record fills the missing exit date (unknown -> known) without a conflict; a different value conflicts.
  const fill = await run({ batch_key: 'x-legacy-date', channel: 'OUTCOMES', sources: [src('x:wire', 'OFFICIAL')], records: [
    { ...audit('legacy', 'Legacy Form', 'LAD', { acquisition: { draft_key: '2017-JUNE_AMATEUR', overall_pick: 433 }, disposition: { value: 'RELEASED', date: '2019-03-28', as_of_date: '2026-10-20', source_key: 'x:wire' } }), details: undefined }] })
  assert.equal(fill.report.conflicts, 0)
  assert.deepEqual((await dispositions('legacy')).map((d) => [d.disposition, d.disposition_date]), [['RELEASED', '2019-03-28']])
  const rival = await run({ batch_key: 'x-legacy-rival', channel: 'OUTCOMES', sources: [src('x:other', 'OTHER')], records: [
    { ...audit('legacy', 'Legacy Form', 'LAD', { acquisition: { draft_key: '2017-JUNE_AMATEUR', overall_pick: 433 }, disposition: { value: 'LOST_WAIVERS', date: '2019-03-28', as_of_date: '2026-10-20', source_key: 'x:other' } }), details: undefined }] })
  assert.equal(rival.report.conflicts, 1)
  assert.ok((await P.openConflicts(db)).some((c) => c.subject_table === 'acquisition_dispositions' && c.field_name === 'disposition'), 'kept as a conflict, never overwritten')
})
