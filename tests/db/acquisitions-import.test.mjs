// Non-trade acquisitions through the research pipeline on a disposable PostgreSQL 17 (migration 030): free agent, amateur free agent, waiver claim,
// purchase and Rule 5 become one transaction each with a player move and one source lineage; nothing else does. FICTIONAL rows and register.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as T from '../../scripts/research/lib/transactions.mjs'
import * as R from '../../scripts/research/lib/retrosheet-transactions.mjs'
import { indexRegisterByRetro, resolveAll } from '../../scripts/research/lib/retrosheet-identity.mjs'
import { sourceDeclarations, sourceKeys } from '../../scripts/research/lib/retrosheet-adapter.mjs'
import { buildAcquisitionCandidates } from '../../scripts/research/lib/retrosheet-acquisitions.mjs'
import { integrityViolations } from '../../scripts/research/lib/integrity.mjs'

let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-acqdb-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const q = (f) => f.map((v) => `"${v}"`).join(',')
const lg = { LAN: 'NL', SEA: 'AL', NYA: 'AL', BOS: 'AL', TEX: 'AL' }
const r = (id, date, player, type, from, to, info = '') => q([date, '', '', '', '', id, player, type, from ?? '', from ? (lg[from] ?? '(Atlantic)') : '', to ?? '', to ? lg[to] : '', '', '', '', info])
const HEAD = 'key_person,key_uuid,key_mlbam,key_retro,key_bbref,key_bbref_minors,key_fangraphs,key_npb,key_sr_nfl,key_sr_nba,key_sr_nhl,key_wikidata,name_last,name_first,name_given,name_suffix,name_matrilineal,name_nick,birth_year,birth_month,birth_day,death_year,death_month,death_day,pro_played_first,pro_played_last,mlb_played_first,mlb_played_last'
const people = [[1, 'smitj001', 'Smith', 'John'], [2, 'jonea001', 'Jones', 'Al'], [3, 'nix-j001', 'Nix', 'Jay'], [4, 'bairj001', 'Baird', 'Jim'], [5, 'cruzc001', 'Cruz', 'Carl'], [6, 'dunnd001', 'Dunn', 'Dan'], [7, 'evane001', 'Evans', 'Ed']]
const regDir = fs.mkdtempSync(path.join(dir, 'reg-'))
for (const s of '0123456789abcdef') fs.writeFileSync(path.join(regDir, `people-${s}.csv`), HEAD + '\n' + (s === '0' ? people.map(([n, id, l, f]) => `k${n},u${n},${990000 + n},${id},,,,,,,,,${l},${f},,,,,1990,5,17,,,,2010,2020,2012,2020`).join('\n') + '\n' : ''))
const KEYS = sourceKeys('c'.repeat(64), '781c175')
const DECL = sourceDeclarations({ archiveSha256: 'c'.repeat(64), retrievedOn: '2026-10-22', registerCommit: '781c175', registerCommitFull: '781c175e748b89e5730fd3f5de0086b9355b2f92', registerRetrievedOn: '2026-10-21' })
const ROWS = [
  r('1', '20300110', 'smitj001', 'F ', null, 'LAN'), r('2', '20300111', 'jonea001', 'Fa', null, 'SEA'), r('3', '20300112', 'nix-j001', 'W ', 'LAN', 'SEA'),
  r('4', '20300113', 'bairj001', 'P ', 'Long Island', 'NYA', '$'), r('5', '20300114', 'cruzc001', 'D ', 'BOS', 'LAN'),
  // not acquisitions
  r('6', '20300115', 'dunnd001', 'Fg', 'LAN', null), r('7', '20300116', 'smitj001', 'R ', 'LAN', null), r('8', '20300117', 'evane001', 'Da', null, 'BOS'), r('9', '20300118', 'nix-j001', 'Hi', 'LAN', null),
  // held: name only, voided by the source
  r('10', '20300119', 'Some Prospect', 'Fa', null, 'BOS'), r('11', '20300120', 'dunnd001', 'F ', null, 'TEX'), r('12', '20300220', 'dunnd001', 'Fv', null, 'TEX')
].join('\n') + '\n'
const rows = R.parseTran(ROWS)
const groups = R.groupRows(rows)
const resolved = resolveAll(rows, indexRegisterByRetro(regDir, new Set(rows.filter((x) => x.player.kind === 'RETROSHEET_ID').map((x) => x.player.retro_id))), { byMlbam: new Map(), byRetro: new Map() })
const cand = buildAcquisitionCandidates(groups, resolved, { from: 2030, to: 2030, declarations: DECL, keys: KEYS, batchKey: 'acq-batch' })
let n = 0
async function stage (doc) {
  const f = path.join(dir, `b-${++n}.json`); fs.writeFileSync(f, JSON.stringify(doc))
  const { batch } = await P.stageFile(db, f, {})
  return { batch, validation: await P.validateBatch(db, batch.id) }
}
const counts = () => h.one(db, `select (select count(*) from transactions)::int tx, (select count(*) from transaction_player_moves)::int moves, (select count(*) from players)::int players,
  (select count(*) from transaction_external_ids)::int ids, (select count(*) from ingest.transaction_apply_ledger)::int ledger, (select count(*) from draft_selections)::int draft`)

test('the candidates: five genuine acquisitions; the departure, release, draft selection, status row, name-only and voided rows are not staged', () => {
  assert.equal(cand.candidates, 5)
  assert.deepEqual(cand.holds.map((x) => x.reasons).flat().sort(), ['NAME_ONLY_PLAYER', 'VOIDED_BY_SOURCE_ROW'])
})

test('dry run writes nothing; the write records one transaction and one player move each, with the source\'s code and note', async () => {
  const before = await counts()
  const s = await stage(cand.doc)
  assert.ok(s.validation.ok, JSON.stringify(s.validation.counts))
  const dry = await P.applyBatch(db, s.batch.id, { write: false })
  assert.deepEqual(dry.report.actions, { INSERT: 5 })
  assert.deepEqual(await counts(), before)
  const done = await P.applyBatch(db, s.batch.id, { write: true })
  assert.deepEqual(done.report.actions, { INSERT: 5 })
  const c = await counts()
  assert.deepEqual([c.tx - before.tx, c.moves - before.moves, c.players - before.players, c.draft], [5, 5, 5, 0], 'no draft selection was created from a draft event')
  const rowsOut = await h.rows(db, `select t.transaction_type::text ty, to_char(t.transaction_date, 'YYYY-MM-DD') d, o.franchise_key to_key, f.franchise_key from_key, m.from_club_text, m.source_event_code code, m.source_info
    from transaction_player_moves m join transactions t on t.id = m.transaction_id join organizations o on o.id = m.to_organization_id left join organizations f on f.id = m.from_organization_id order by t.transaction_date`)
  assert.deepEqual(rowsOut.map((x) => [x.ty, x.to_key, x.from_key, x.from_club_text, x.code, x.source_info]), [
    ['FREE_AGENT_SIGNING', 'LAD', null, null, 'F', null], ['AMATEUR_FREE_AGENT_SIGNING', 'SEA', null, null, 'Fa', null], ['WAIVER_CLAIM', 'SEA', 'LAD', null, 'W', null],
    ['PURCHASE', 'NYY', null, 'Long Island (Atlantic)', 'P', '$'], ['RULE_5', 'LAD', 'BOS', null, 'D', null]])
  const ids = await h.one(db, "select e1.external_id mlbam, e2.external_id retro, s.source_key from player_external_ids e1 join player_external_ids e2 on e2.player_id = e1.player_id and e2.id_system = 'RETROSHEET' join sources s on s.id = e1.source_id where e1.id_system = 'MLBAM' and e1.external_id = '990001'")
  assert.deepEqual(ids, { mlbam: '990001', retro: 'smitj001', source_key: KEYS.chadwick })
})

test('replay inserts nothing, in the same batch or a new one; a duplicate acquisition under another identity is held, a changed value is a conflict', async () => {
  const before = await counts()
  const again = await stage({ ...cand.doc, batch_key: 'acq-batch-2' })
  assert.deepEqual((await P.applyBatch(db, again.batch.id, { write: true })).report.actions, { NO_CHANGE: 5 })
  const first = (await h.one(db, "select id from ingest.import_batches where batch_key = 'acq-batch'")).id
  assert.deepEqual((await P.applyBatch(db, first, { write: true })).report.actions, { NO_CHANGE: 5 })
  const b = await counts()
  assert.deepEqual({ ...b, ledger: 0 }, { ...before, ledger: 0 })
  // the same player, club, day and type under a different identity: held as a collision, not inserted
  const dup = JSON.parse(JSON.stringify(cand.doc)); dup.batch_key = 'acq-dup'
  dup.records = [{ ...dup.records.find((x) => x.acquisition_class === 'FREE_AGENT'), external_ids: [{ scheme: 'RETROSHEET_TXN', id: 'other-id', source_key: KEYS.retro }] }]
  const d = await stage(dup); assert.ok(d.validation.ok)
  const out = await P.applyBatch(db, d.batch.id, { write: true })
  assert.deepEqual(out.report.actions, { HELD: 1 }); assert.match(out.results[0].reason, /COLLISION/)
  // the same identity with a different date: a conflict, kept for a human, nothing overwritten
  const moved = JSON.parse(JSON.stringify(cand.doc)); moved.batch_key = 'acq-moved'
  moved.records = [{ ...moved.records.find((x) => x.acquisition_class === 'FREE_AGENT'), date: '2030-01-12' }]
  const m = await stage(moved)
  const mo = await P.applyBatch(db, m.batch.id, { write: true })
  assert.deepEqual(mo.report.actions, { HELD: 1 }); assert.match(mo.results[0].reason, /CONFLICT: date/)
  assert.equal((await h.one(db, "select count(*)::int n from transaction_conflicts where field_path = 'date'")).n, 1)
  assert.equal((await h.one(db, "select to_char(transaction_date, 'YYYY-MM-DD') d from transactions t join transaction_external_ids x on x.transaction_id = t.id where x.external_id like '%110%' or x.external_id like '1@%'")).d, '2030-01-10')
})

test('replay under a new batch key leaves the coverage rows untouched', async () => {
  const cov = () => h.rows(db, "select id, tracked_count, assessed_on::text a, updated_at::text u from coverage_assessments where domain::text = 'TRANSACTIONS' order by id")
  const before = await cov()
  assert.ok(before.length > 0)
  const s = await stage({ ...cand.doc, batch_key: 'acq-batch-coverage-replay' })
  const r = await P.applyBatch(db, s.batch.id, { write: true })
  assert.equal(r.report.actions.INSERT ?? 0, 0)
  assert.deepEqual(await cov(), before)
})

test('status: PARTIAL at best, never complete; verification has no rule for non-trade acquisitions; coverage is a partial reconstruction, never a census', async () => {
  const st = await h.rows(db, 'select completeness, gaps from analytics.transaction_completeness c join transaction_player_moves m on m.transaction_id = c.transaction_id')
  assert.ok(st.every((x) => x.completeness === 'PARTIAL' && x.gaps.join() === 'NON_TRADE_VERIFICATION_NOT_DEFINED'))
  const rv = await h.login(db, 'acq_reviewer', { reviewer: true })
  await rv.query("select * from research.enroll_reviewer('Acq Reviewer')")
  await rv.query("select * from research.set_certification_gate(true, 'isolated test database')")
  const tx = (await h.one(db, 'select transaction_id id from transaction_player_moves limit 1')).id
  await assert.rejects(rv.query('select * from research.verify_transaction($1, $2, $3)', [tx, 'the archive lists this signing', 'one lineage only']), /NON_TRADE_VERIFICATION_NOT_DEFINED/)
  const cov = await h.rows(db, "select coverage_state::text s, tracked_count t, source_id is not null as sourced, expected_count from coverage_assessments where domain::text = 'TRANSACTIONS' order by scope_key, organization_id")
  assert.ok(cov.length >= 4 && cov.every((c) => c.s === 'PARTIAL_RECONSTRUCTION' && c.expected_count === null && c.sourced))
  assert.deepEqual(await integrityViolations(db), [])
})

test('shape guards: a player move belongs to a non-trade acquisition only, and a trade cannot carry moves', async () => {
  const t = Number((await h.one(db, "insert into transactions (transaction_type, transaction_date, source_id) values ('TRADE', '2030-02-01', (select id from sources limit 1)) returning id")).id)
  const p = (await h.one(db, 'select player_id id from transaction_player_moves limit 1')).id
  const org = (await h.one(db, "select id from organizations where franchise_key = 'LAD'")).id
  await h.rejects(db, 'insert into transaction_player_moves (transaction_id, player_id, to_organization_id, source_event_code) values ($1, $2, $3, $4)', [t, p, org, 'T'], /non-trade acquisition/)
  const fa = (await h.one(db, 'select transaction_id id from transaction_player_moves limit 1')).id
  const other = (await h.one(db, "select id from organizations where franchise_key = 'SEA'")).id
  await h.rejects(db, 'insert into trade_packages (transaction_id, from_organization_id, to_organization_id) values ($1, $2, $3)', [fa, org, other], /belong to trades only/)
  await h.rejects(db, 'insert into transaction_player_moves (transaction_id, player_id, to_organization_id, from_organization_id, from_club_text, source_event_code) values ($1, $2, $3, $4, $5, $6)', [fa, (await h.one(db, 'select id from players order by id desc limit 1')).id, org, other, 'x', 'W'], /check/)
  await db.query('delete from transactions where id = $1', [t])
})

test('the ACQUISITIONS channel refuses departures, draft selections and amounts', async () => {
  const bad = JSON.parse(JSON.stringify(cand.doc)); bad.batch_key = 'acq-bad'
  bad.records = [{ ...bad.records[0], acquisition_class: 'DRAFT', external_ids: [{ scheme: 'X_ID', id: '1', source_key: KEYS.retro }] }]
  const s = await stage(bad)
  assert.equal(s.validation.counts.invalid, 1)
  const errs = (await h.rows(db, "select validation_errors e from ingest.staged_records where batch_id = $1", [s.batch.id]))[0].e
  assert.ok(errs.some((e) => /not acquisitions/.test(e)))
})
