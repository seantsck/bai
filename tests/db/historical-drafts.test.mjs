// Historical drafts (migration 024) and the historical importer. Draft structures follow real eras (the 1965 first draft,
// 1985's four phases, relocated and renamed franchises), but every player, id and value is FICTIONAL fixture data.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as B from '../../scripts/research/lib/backfill.mjs'
import { normalizePhase, roundCode, schoolFromLabel } from '../../scripts/history/lib/mlb.mjs'
import { buildPhaseBatches } from '../../scripts/history/lib/build.mjs'
import { compareClubLists } from '../../scripts/history/lib/evidence.mjs'
import { createFetcher, BudgetExhausted } from '../../scripts/history/lib/fetch.mjs'

let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-history-'))
before(async () => {
  await h.startServer()
  db = await h.freshDatabase()
  await db.query(`insert into sources (source_key, source_type, authority_level, title) values ('x:cal', 'TEST_FIXTURE', 'OFFICIAL', 'Historical calendar fixture')`)
  for (const [key, year, kind, date, prec, rounds] of [['1965-JUNE_AMATEUR', 1965, 'JUNE_AMATEUR', '1965-06-08', 'DAY', 72], ['1985-JANUARY_REGULAR', 1985, 'JANUARY_REGULAR', '1985-01-01', 'MONTH', 21],
    ['1985-JUNE_AMATEUR', 1985, 'JUNE_AMATEUR', '1985-06-01', 'MONTH', 39], ['1985-JUNE_SECONDARY', 1985, 'JUNE_SECONDARY', '1985-06-01', 'MONTH', 7]]) {
    await db.query(`insert into drafts (draft_key, draft_year, draft_kind, start_date, start_date_precision, total_rounds, source_id) values ($1, $2, $3, $4, $5, $6, (select id from sources where source_key = 'x:cal'))`, [key, year, kind, date, prec, rounds])
  }
}, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const src = (key) => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: 'OFFICIAL', title: `History fixture ${key}` })
let n = 0
async function run (doc, org) {
  const f = path.join(dir, `b-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', channel: 'DRAFT', sources: [src('x:hist')], ...doc }))
  const { batch } = await P.stageFile(db, f, { organization: org })
  const v = await P.validateBatch(db, batch.id)
  assert.ok(v.ok, JSON.stringify(v))
  return P.applyBatch(db, batch.id, { write: true })
}
const sel = (draft, overall, round, org, mlbam, name) => ({ type: 'DRAFT_SELECTION', source_key: 'x:hist', draft_key: draft, round_code: round, overall_pick: overall, round_pick: overall,
  organization: org, player: { full_name: name, external_ids: { MLBAM: mlbam } }, signing: { status: 'UNKNOWN' } })

test('franchises across seasons: names, relocations and league alignment resolve by year', async () => {
  const key = async (name, season) => (await h.one(db, 'select o.franchise_key from organizations o where o.id = resolve_organization($1, $2)', [name, season]))?.franchise_key ?? null
  assert.equal(await key('Montreal Expos', 1985), 'WSH')
  assert.equal(await key('Washington Senators', 1965), 'TEX')          // the expansion Senators (1961-71) became Texas
  assert.equal(await key('Washington Senators', 1955), 'MIN')          // the first Senators became Minnesota
  assert.equal(await key('Kansas City Athletics', 1965), 'ATH')
  assert.equal(await key('Seattle Pilots', 1969), 'MIL')
  assert.equal(await key('California Angels', 1985), 'LAA')
  assert.equal(await key('Florida Marlins', 2005), 'MIA')
  assert.equal(await key('Montreal Expos', 2010), null)                // not that franchise's name in 2010
  const league = async (fk, season) => h.one(db, `select x.league::text, x.division from organization_league_seasons x join organizations o on o.id = x.organization_id where o.franchise_key = $1 and x.seasons @> $2::int`, [fk, season])
  assert.deepEqual(await league('MIL', 1985), { league: 'AL', division: 'East' })
  assert.deepEqual(await league('MIL', 2005), { league: 'NL', division: 'Central' })
  assert.deepEqual(await league('HOU', 2012), { league: 'NL', division: 'Central' })
  assert.deepEqual(await league('HOU', 2013), { league: 'AL', division: 'West' })
  assert.deepEqual(await league('LAD', 1965), { league: 'NL', division: null })
  assert.equal(await league('SD', 1965), undefined)
})

test('a selection by a club that did not exist yet is refused, by the database and by research classes', async () => {
  await assert.rejects(run({ batch_key: 'h-sd-1965', records: [sel('1965-JUNE_AMATEUR', 1, '1', 'SD', '9870001', 'Fixture Expansion')] }, 'SD'), /did not exist in 1965/)
  await assert.rejects(B.createClass(db, { org: 'SD', channel: 'draft', year: 1965 }, { actor: 'test' }), /SD did not exist in 1965/)
  const { cls } = await B.createClass(db, { org: 'WSH', channel: 'draft', year: 1985, kind: 'JANUARY_REGULAR' }, { actor: 'test' })
  assert.equal(cls.class_key, 'WSH/DRAFT/1985-JANUARY_REGULAR')
  await assert.rejects(B.createClass(db, { org: 'WSH', channel: 'draft', year: 1985, kind: 'LEGION' }, { actor: 'test' }), /unknown draft phase/)
})

test('phases are separate drafts: one player in two phases of a year has two acquisitions; twice in one phase is refused', async () => {
  await run({ batch_key: 'h-jan-1985', records: [sel('1985-JANUARY_REGULAR', 7, '1', 'WSH', '9870002', 'Fixture Twophase')] }, 'WSH')
  await run({ batch_key: 'h-jun-1985', records: [sel('1985-JUNE_AMATEUR', 40, '2', 'LAD', '9870002', 'Fixture Twophase')] }, 'LAD')
  const acq = await h.rows(db, `select o.franchise_key, d.draft_key from draft_selections s join drafts d on d.id = s.draft_id join organizations o on o.id = s.organization_id
    join player_external_ids x on x.player_id = s.player_id where x.external_id = '9870002' order by d.start_date`)
  assert.deepEqual(acq.map((a) => `${a.franchise_key} ${a.draft_key}`), ['WSH 1985-JANUARY_REGULAR', 'LAD 1985-JUNE_AMATEUR'])
  const r = await run({ batch_key: 'h-jun-1985-dup', records: [sel('1985-JUNE_AMATEUR', 41, '2', 'LAD', '9870002', 'Fixture Twophase')] }, 'LAD')
  assert.equal(r.conflicts.length, 1, 'a second pick of the same person in one phase is a conflict, never a second row')
  assert.equal(Number((await h.one(db, "select count(*) n from draft_selections s join drafts d on d.id = s.draft_id where d.draft_key = '1985-JUNE_AMATEUR'")).n), 1)
})

test('drafted but never signed, and unknown signing, stay distinct', async () => {
  await run({ batch_key: 'h-1965-signing', records: [
    { ...sel('1965-JUNE_AMATEUR', 2, '1', 'LAD', '9870003', 'Fixture Nosign'), signing: { status: 'DID_NOT_SIGN', source_key: 'x:hist' } },
    sel('1965-JUNE_AMATEUR', 3, '1', 'ATH', '9870004', 'Fixture Unknown')] }, null)
  const rows = await h.rows(db, `select display_name, signing_status, organization_name_then, league_then from v_draft_explorer where draft_key = '1965-JUNE_AMATEUR' order by overall_pick`)
  assert.deepEqual(rows, [
    { display_name: 'Fixture Nosign', signing_status: 'DID_NOT_SIGN', organization_name_then: 'Los Angeles Dodgers', league_then: 'NL' },
    { display_name: 'Fixture Unknown', signing_status: 'UNKNOWN', organization_name_then: 'Kansas City Athletics', league_then: 'AL' }])
})

test('month-precision dates, coverage cells per existing club, and the public views', async () => {
  await h.rejects(db, `insert into drafts (draft_key, draft_year, draft_kind, start_date, start_date_precision, source_id) values ('1985-AUGUST_LEGION', 1985, 'AUGUST_LEGION', '1985-08-15', 'MONTH', 1)`, [], /drafts_month_precision_first_day/)
  await db.query('select refresh_read_models()')
  const cells = await h.rows(db, `select scope_key, count(*)::int n from rm_research_coverage where domain = 'DRAFT' and scope_key in ('1965-JUNE_AMATEUR', '1985-JUNE_AMATEUR') group by 1 order by 1`)
  assert.deepEqual(cells, [{ scope_key: '1965-JUNE_AMATEUR', n: 20 }, { scope_key: '1985-JUNE_AMATEUR', n: 26 }])
  const cov = await h.asRole(db, 'anon', () => h.one(db, `select clubs, imported_selections, expected_selections, start_date_precision::text from rm_draft_year_coverage where draft_key = '1985-JANUARY_REGULAR'`))
  assert.deepEqual(cov, { clubs: 26, imported_selections: 1, expected_selections: null, start_date_precision: 'MONTH' })
  await h.asRole(db, 'anon', async () => assert.ok((await h.rows(db, 'select * from v_draft_explorer limit 5')).length > 0))
  // Each refusal in its own transaction (a refused statement aborts the transaction it runs in).
  await h.asRole(db, 'anon', () => assert.rejects(db.query('select * from v_draft_year_coverage limit 1'), /permission denied/))
  await h.asRole(db, 'anon', () => assert.rejects(db.query('select organization_exists_in_season(1, 1965)'), /permission denied/))
})

test('importer: phase normalization, round codes, school types and duplicate detection', () => {
  assert.equal(roundCode('1C'), 'C-1'); assert.equal(roundCode('C-2'), 'C-2'); assert.equal(roundCode('CBA'), 'CB-A'); assert.equal(roundCode('07'), '7')
  assert.equal(schoolFromLabel('Great Bridge HS, VA').school_type, 'HIGH_SCHOOL')
  assert.equal(schoolFromLabel('Crenshaw HS (Los Angeles, CA)').city, 'Los Angeles')
  assert.equal(schoolFromLabel('Arizona State').school_type, 'COLLEGE')
  assert.equal(schoolFromLabel('Seminole CC').school_type, 'JUNIOR_COLLEGE')
  assert.equal(schoolFromLabel('Somewhere').school_type, null)          // no explicit word: untyped, never guessed
  const pick = (n, team, person, extra = {}) => ({ pickRound: String(Math.ceil(n / 2)), pickNumber: n, roundPickNumber: 1, year: '1965', isDrafted: true, isPass: false,
    draftType: { code: 'JR' }, team: { id: team }, person: { id: person, fullName: `Fixture ${person}` }, school: { name: 'Fixture HS, CA' }, ...extra })
  const r = normalizePhase({ drafts: { rounds: [{ picks: [pick(1, 119, 1), pick(2, 133, 2), pick(4, 133, 1), pick(5, 119, 3, { isPass: true })] }] } }, { year: 1965, code: 'JR' })
  assert.deepEqual(r.picks.map((p) => [p.overall_pick, p.hold ?? null]), [[1, null], [2, null], [4, 'same MLBAM person as pick #1 in this phase']])
  assert.deepEqual(r.findings.map((f) => f.kind).sort(), ['NOT_A_SELECTION', 'PICK_NUMBER_GAPS', 'SAME_PERSON_TWICE'])
})

test('importer: a census is claimed only when an independent list agrees; batches are deterministic', () => {
  const picks = normalizePhase({ drafts: { rounds: [{ picks: [1, 2, 3].map((n) => ({ pickRound: '1', pickNumber: n, roundPickNumber: n, year: '1985', isDrafted: true, draftType: { code: 'JR' },
    team: { id: n === 3 ? 133 : 119 }, person: { id: 9870100 + n, fullName: ['Fixture Alpha', 'Fixture Beta', 'Fixture Gamma'][n - 1] } })) }] } }, { year: 1985, code: 'JR' }).picks
  const ctx = (evidence) => ({ year: 1985, code: 'JR', phase: { label: 'June regular phase' }, organizations: [{ franchise_key: 'LAD', mlb_team_id: 119 }, { franchise_key: 'ATH', mlb_team_id: 133 }],
    crosswalk: new Map([['9870101', { ids: { BBREF: 'fixtal01' } }]]), commit: 'abcdef1234567', mlbEntry: { url: 'https://example.test/d', retrieved_at: '2026-10-21T00:00:00Z', sha256: 'x' },
    chadwickRetrieved: '2026-10-21', evidence })
  const lad = compareClubLists(picks.filter((p) => p.team_id === 119), [{ overall: 1, round: '1', name: 'Fixture Alpha' }, { overall: 2, round: '1', name: 'Fixture Beta' }])
  const ath = compareClubLists(picks.filter((p) => p.team_id === 133), [{ overall: 3, round: '1', name: 'Fixture Gammma' }])
  assert.equal(lad.unmatched.length, 0); assert.equal(ath.unmatched.length, 1)
  const out = buildPhaseBatches(picks, ctx({ LAD: { agrees: true, count: 2, note: 'agrees' }, ATH: { agrees: false, count: 1, note: 'spelling differs' } }))
  const claim = (fk) => out.batches.find((b) => b.org === fk).doc.coverage_claims[0]
  assert.equal(claim('LAD').coverage_state, 'COMPLETE_CENSUS'); assert.equal(claim('LAD').expected_count, 2)
  assert.equal(claim('ATH').coverage_state, 'PARTIAL_RECONSTRUCTION'); assert.equal(claim('ATH').expected_count, undefined)
  assert.equal(buildPhaseBatches(picks, ctx({})).batches.find((b) => b.org === 'LAD').doc.coverage_claims[0].coverage_state, 'PARTIAL_RECONSTRUCTION', 'no evidence, no census')
  const rec = out.batches.find((b) => b.org === 'LAD').doc.records[0]
  assert.deepEqual(rec.player.external_id_sources, { BBREF: 'hist:chadwick-register-abcdef1' })
  assert.deepEqual(rec.signing, { status: 'UNKNOWN' })
  assert.equal(JSON.stringify(buildPhaseBatches(picks, ctx({ LAD: { agrees: true, count: 2, note: 'agrees' } }))), JSON.stringify(buildPhaseBatches(picks, ctx({ LAD: { agrees: true, count: 2, note: 'agrees' } }))))
})

test('importer: crosswalk ids are recorded with their own source', async () => {
  await run({ batch_key: 'h-1985-ids', sources: [src('x:hist'), src('x:chadwick')], records: [{ ...sel('1985-JUNE_SECONDARY', 1, '1', 'LAD', '9870005', 'Fixture Crosswalk'),
    player: { full_name: 'Fixture Crosswalk', external_ids: { MLBAM: '9870005', FANGRAPHS: '987005' }, external_id_sources: { FANGRAPHS: 'x:chadwick' }, source_key: 'x:hist' } }] }, 'LAD')
  const ids = await h.rows(db, `select x.id_system::text, s.source_key from player_external_ids x join sources s on s.id = x.source_id join player_external_ids m on m.player_id = x.player_id
    where m.external_id = '9870005' order by 1`)
  assert.deepEqual(ids, [{ id_system: 'FANGRAPHS', source_key: 'x:chadwick' }, { id_system: 'MLBAM', source_key: 'x:hist' }])
})

test('fetcher: cache with checksums, offline replay, tamper detection, request budget and source hosts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-fetch-'))
  const cleared = { state: 'CLEARED', basis: 'fixture' }
  const catalog = { sources: [{ id: 's', hosts: ['example.test'], url_prefixes: ['https://example.test/'], uses: { fetch_targeted: cleared, fetch_bulk: cleared, process_local: cleared, publish_repository: cleared, publish_site: cleared } }] }
  let calls = 0
  const fetchImpl = async () => { calls++; return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }) }
  const f = createFetcher({ root, catalog, maxRequests: 1, minIntervalMs: 0, userAgent: 'test', fetchImpl })
  assert.equal((await f.get('a/one.json', 'https://example.test/1', { source: 's', use: 'fetch_bulk' })).cached, false)
  assert.equal((await f.get('a/one.json', 'https://example.test/1', { source: 's', use: 'fetch_bulk' })).cached, true)
  await assert.rejects(f.get('a/two.json', 'https://example.test/2', { source: 's', use: 'fetch_bulk' }), BudgetExhausted)
  await assert.rejects(createFetcher({ root, catalog, userAgent: 't', fetchImpl }).get('b.json', 'https://elsewhere.test/', { source: 's', use: 'fetch_bulk' }), /does not belong to source s/)
  const offline = createFetcher({ root, catalog, offline: true, userAgent: 't', fetchImpl })
  assert.equal((await offline.get('a/one.json', 'https://example.test/1', { source: 's', use: 'fetch_bulk' })).cached, true)
  await assert.rejects(offline.get('a/new.json', 'https://example.test/3', { source: 's', use: 'fetch_bulk' }), /offline replay/)
  fs.writeFileSync(path.join(root, '.cache/history/a/one.json'), '{"ok":2}')
  await assert.rejects(offline.get('a/one.json', 'https://example.test/1', { source: 's', use: 'fetch_bulk' }), /does not match its manifest checksum/)
  assert.equal(calls, 1)
  fs.rmSync(root, { recursive: true, force: true })
})
