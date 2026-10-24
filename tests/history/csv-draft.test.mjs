// The staging CSV workflow: deterministic rules, source rights, identity and the release directory it writes. FICTIONAL people and rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadCatalog } from '../../scripts/history/lib/permissions.mjs'
import { SHARDS } from '../../scripts/history/lib/chadwick.mjs'
import { CSV_COLUMNS, csvTemplate, readCsv, validateRow, buildCsvBatches, findDuplicates } from '../../scripts/history/lib/csv-draft.mjs'
import { loadRelease, verifyReleaseContent } from '../../scripts/history/lib/release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = loadCatalog(root)
const WIKI = 'https://en.wikipedia.org/w/index.php?title=2024_Major_League_Baseball_draft&oldid=1'
const q = (v) => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)
const row = (o) => [2024, o.pick, o.round ?? '1', o.rp ?? '', o.team, o.name, o.mlbam ?? '', o.pos ?? '', o.school ?? '', o.status ?? '', o.bonus ?? '', o.url ?? WIKI, o.rev ?? '1', o.perm ?? 'wikipedia-draft-articles'].map(q).join(',')
const HEADER = CSV_COLUMNS.join(',')
const REGISTER_HEAD = 'key_person,key_mlbam,key_retro,key_bbref,key_bbref_minors,key_fangraphs,name_first,name_last,birth_year,birth_month,birth_day,pro_played_first,mlb_played_first,mlb_played_last'
const person = (mlbam, first, last, by = 2003) => `p${mlbam},${mlbam},,,,,${first},${last},${by},5,6,2024,,`
const shard = (people) => `${REGISTER_HEAD}\n${people.join('\n')}\n`
const REGISTER = shard([person(900001, 'Ann', 'Able'), person(900002, 'Bo', 'Barker'), person(900005, 'Eve', 'Ebbs'), person(900010, 'Jo', 'Jay'), person(900099, 'Dee', 'Dunn'), person(900011, 'Kit', 'Kane', 1980), person(900012, 'Mia', 'Mars'), person(900013, 'Ned', 'North'), person(900014, 'Opal', 'Orr'), person(900015, 'Pat', 'Pike', ''), person(900016, 'Quin', 'Quill'), person(900017, 'Tia', 'Tate')])
const WIKIDATA = {
  900001: { qid: 'Q9000001', birth: '2003-05-06' }, 900010: { qid: 'Q9000010', birth: '2003-05-06' },
  900013: { qid: 'Q9000013', birth: '2003-07-07' },   // birth date disagrees with the register
  900014: { qid: 'Q9000014', birth: null },            // Wikidata item without a birth date: corroboration missing
  900015: { qid: 'Q9000015', birth: '2003-05-06' },    // the register has no full birth date for this id
  900016: { qid: null, ambiguous: true },              // two Wikidata items hold the id
  900017: { qid: 'Q9000017', birth: '2003-05-06' }
}   // 900012 has no item at all
const ROWS = [
  row({ pick: 1, team: 'DET', name: 'Ann Able', mlbam: 900001, pos: 'SS', school: 'Fixture State' }),
  row({ pick: 2, team: 'TEX', name: 'Bo Baker', mlbam: 900002 }),                       // MLBAM belongs to "Bo Barker"
  row({ pick: 3, team: 'KC', name: 'Cy Carter' }),                                       // no register person: name-only
  row({ pick: 4, team: 'SEA', name: 'Dee Dunn' }),                                       // same-name register person in the window: held
  row({ pick: 5, team: 'NYY', name: 'Eve Ebbs', mlbam: 900005, url: 'https://statsapi.mlb.com/api/v1/draft/2024', perm: 'mlb-statsapi-draft', rev: 'x' }),   // restricted source
  row({ pick: 6, team: 'BOS', name: 'Fay Fox', perm: 'mlb-statsapi-draft' }),            // label does not match the URL's governing source
  row({ pick: 7, team: 'CHC', name: 'Gus Gray', bonus: '500,000' }),                     // bonus without SIGNED
  row({ pick: 8, team: 'CIN', name: 'Hal Hart', status: 'SIGNED' }),                     // SIGNED, bonus unknown
  row({ pick: 9, team: 'CLE', name: 'Ivy Ito' }),                                        // blank status, blank bonus
  row({ pick: 18, team: 'COL', name: 'Rae Reed' }),                                      // two rows for pick 18: both held
  row({ pick: 18, team: 'WSH', name: 'Sol Stone' }),
  row({ pick: 19, team: 'TB', name: 'Tia Tate', mlbam: 900017 }),                        // one MLBAM id in two rows: both held
  row({ pick: 20, team: 'TB', name: 'Tia Tate', mlbam: 900017 }),
  row({ pick: 29, round: 'PPI', team: 'SEA', name: 'Jo Jay', mlbam: 900010 }),           // prospect promotion incentive pick
  row({ pick: 11, team: 'ATL', name: 'Kit Kane', url: 'https://example.org/draft', perm: 'wikipedia-draft-articles' }),   // host the catalog does not know
  row({ pick: 12, team: 'Los Angeles Dodgers', name: 'Lou Lane', status: 'DID_NOT_SIGN' }),
  row({ pick: 13, team: 'MIA', name: 'Mia Mars', mlbam: 900012 }),                      // register agrees, no Wikidata corroboration: held
  row({ pick: 14, team: 'MIN', name: 'Ned North', mlbam: 900013 }),                     // Wikidata birth date disagrees: held
  row({ pick: 15, team: 'ATH', name: 'Opal Orr', mlbam: 900014 }),                      // Wikidata has no birth date: held, never verified
  row({ pick: 16, team: 'PHI', name: 'Pat Pike', mlbam: 900015 }),                      // register has no full birth date: held
  row({ pick: 17, team: 'PIT', name: 'Quin Quill', mlbam: 900016 })                     // two Wikidata items: held
].join('\n')
const recs0 = (loaded) => loaded.batches.flatMap((b) => b.doc.records)
const CSV = `${HEADER}\n${ROWS}\n`

test('the template names exactly the documented columns, and the reader rejects a changed header or a ragged row', () => {
  assert.equal(csvTemplate().trim(), 'draft_year,overall_pick,round_code,round_pick,team,player_name,player_mlbam_id,position,school,signing_status,signing_bonus,source_url,source_revision,source_permission')
  assert.deepEqual(readCsv(csvTemplate()).rows, [])
  assert.match(readCsv('draft_year,bogus\n2024,1\n').problems.join(), /missing columns/)
  assert.match(readCsv(`${HEADER},extra\n`).problems.join(), /unknown columns: extra/)
  assert.match(readCsv(`${HEADER}\n2024,1\n`).problems.join(), /1 hold|2 cells/)
  assert.equal(readCsv(`﻿${HEADER}\n${row({ pick: 1, team: 'DET', name: 'Ann Able' })}\n\n`).rows.length, 1)
})

test('row rules: blank is unknown, a bonus needs SIGNED, and rights and labels are checked against the catalog', () => {
  const v = (o) => validateRow(readCsv(`${HEADER}\n${row(o)}\n`).rows[0], { year: 2024, catalog, root })
  const a = v({ pick: 9, team: 'CLE', name: 'Ivy Ito' }).clean
  assert.deepEqual([a.signing_status, a.bonus_usd, a.round_pick, a.mlbam], ['UNKNOWN', null, null, null], 'blank is unknown, never zero or did-not-sign')
  assert.equal(v({ pick: 8, team: 'CIN', name: 'Hal Hart', status: 'SIGNED' }).clean.bonus_usd, null)
  assert.equal(v({ pick: 8, team: 'CIN', name: 'Hal Hart', status: 'signed', bonus: '$1,250,000.50' }).clean.bonus_usd, 1250000.5)
  assert.match(v({ pick: 7, team: 'CHC', name: 'Gus Gray', bonus: '500000' }).errors.join(), /needs signing_status SIGNED/)
  assert.match(v({ pick: 7, team: 'CHC', name: 'Gus Gray', status: 'DID_NOT_SIGN', bonus: '5' }).errors.join(), /needs signing_status SIGNED/)
  assert.match(v({ pick: 1, team: 'XXX', name: 'A B' }).errors.join(), /team XXX/)
  assert.match(v({ pick: 1, round: 'ninth', team: 'DET', name: 'A B' }).errors.join(), /round_code/)
  assert.match(v({ pick: 1, team: 'DET', name: 'A B', mlbam: '12' }).errors.join(), /player_mlbam_id/)
  assert.match(v({ pick: 1, team: 'DET', name: 'A B', rev: '' }).errors.join(), /source_revision required/)
  assert.match(v({ pick: 1, team: 'DET', name: 'A B', url: 'http://en.wikipedia.org/x' }).errors.join(), /https/)
  // A Wikipedia citation is a pin only if its URL names the claimed revision.
  assert.match(v({ pick: 1, team: 'DET', name: 'A B', url: 'https://en.wikipedia.org/wiki/2024_Major_League_Baseball_draft' }).errors.join(), /must be pinned: the URL needs oldid=<revision>/)
  assert.match(v({ pick: 1, team: 'DET', name: 'A B', rev: '2' }).errors.join(), /must be pinned/)
  assert.equal(v({ pick: 1, team: 'DET', name: 'A B' }).errors.length, 0)
  // A copied MLB or Baseball-Reference table is held whoever typed it: its catalog source does not permit site publication.
  assert.match(v({ pick: 5, team: 'NYY', name: 'Eve Ebbs', url: 'https://statsapi.mlb.com/api/v1/draft/2024', perm: 'mlb-statsapi-draft' }).errors.join(), /rights: .*publish_site refused/)
  assert.match(v({ pick: 5, team: 'NYY', name: 'Eve Ebbs', url: 'https://www.baseball-reference.com/draft/', perm: 'bref-draft-archive' }).errors.join(), /rights:/)
  assert.match(v({ pick: 6, team: 'BOS', name: 'Fay Fox', perm: 'mlb-statsapi-draft' }).errors.join(), /does not match the catalog source that governs the URL \(wikipedia-draft-articles\)/)
  assert.match(v({ pick: 11, team: 'ATL', name: 'Kit Kane', url: 'https://example.org/draft' }).errors.join(), /host the source catalog does not know/)
  assert.deepEqual(v({ pick: 12, team: 'Los Angeles Dodgers', name: 'Lou Lane', status: 'DID_NOT_SIGN' }).clean.organization, 'LAD', 'Dodgers draft picks are ordinary rows')
})

test('identity is by supplied MLBAM id checked against the register, or name-only when the register has no same-name person; everything else is held', () => {
  const { rows } = readCsv(CSV)
  const clean = rows.map((r) => validateRow(r, { year: 2024, catalog, root })).filter((x) => x.clean).map((x) => x.clean)
  assert.equal(clean.length, rows.length - 4, 'four rows fail the row rules (restricted source, wrong label, bonus without SIGNED, unknown host)')
  const out = buildCsvBatches({ rows: clean, year: 2024, chadwick: { commit7: 'abc1234', commitFull: 'a'.repeat(40), shardTexts: [REGISTER] }, retrieved: '2026-10-24', csvSha256: 'f'.repeat(64), wikidata: WIKIDATA, duplicates: findDuplicates(rows) })
  const status = Object.fromEntries(out.picks.map((p) => [p.name, p.status]))
  assert.deepEqual(status, { 'Ann Able': 'VERIFIED', 'Bo Baker': 'AMBIGUOUS', 'Cy Carter': 'SINGLE_SOURCE', 'Dee Dunn': 'AMBIGUOUS', 'Hal Hart': 'SINGLE_SOURCE', 'Ivy Ito': 'SINGLE_SOURCE', 'Jo Jay': 'VERIFIED', 'Lou Lane': 'SINGLE_SOURCE', 'Mia Mars': 'SINGLE_SOURCE', 'Ned North': 'AMBIGUOUS', 'Opal Orr': 'SINGLE_SOURCE', 'Pat Pike': 'SINGLE_SOURCE', 'Quin Quill': 'AMBIGUOUS' })
  const heldBy = Object.fromEntries(out.held.map((h) => [h.name, h.reason]))
  assert.match(heldBy['Bo Baker'], /belongs to "Bo Barker" in the register, not "Bo Baker"/)
  assert.match(heldBy['Dee Dunn'], /share the name in the plausible birth window: supply the MLBAM id/)
  assert.match(heldBy['Mia Mars'], /no Wikidata corroboration/)
  assert.match(heldBy['Opal Orr'], /Wikidata item Q9000014 has no birth date: the birth-date corroboration is missing/)
  assert.match(heldBy['Pat Pike'], /register has no full birth date for MLBAM 900015/)
  assert.match(heldBy['Quin Quill'], /two Wikidata items hold MLBAM 900016/)
  // Duplicates hold every row involved, never just the later one.
  assert.match(heldBy['Rae Reed'], /pick 18 appears in 2 rows of the file \(lines \d+, \d+\): none is imported/)
  assert.match(heldBy['Sol Stone'], /pick 18 appears in 2 rows/)
  assert.equal(out.held.filter((h) => h.name === 'Tia Tate').length, 2)
  assert.match(heldBy['Tia Tate'], /MLBAM 900017 appears in 2 rows of the file/)
  assert.match(heldBy['Ned North'], /birth dates disagree \(register 2003-05-06, Wikidata 2003-07-07\)/)
  assert.deepEqual(out.signingProposals.map((s) => [s.name, s.signing_status, s.bonus_usd]), [['Hal Hart', 'SIGNED', null], ['Lou Lane', 'DID_NOT_SIGN', null]], 'signing facts are proposals, never part of the release')
  const recs = out.batches.flatMap((b) => b.doc.records)
  const by = (name) => recs.find((r) => r.player.full_name === name)
  assert.deepEqual([by('Ann Able').player.external_ids.MLBAM, by('Ann Able').player.birth_date, by('Ann Able').position, by('Ann Able').school.name], ['900001', '2003-05-06', 'SS', 'Fixture State'])
  assert.equal(by('Cy Carter').player.external_ids, undefined, 'name-only: no ids attached')
  assert.deepEqual([by('Jo Jay').round_code, by('Jo Jay').selection_type], ['PPI', 'PRIZE'])
  assert.deepEqual(by('Ivy Ito').signing, { status: 'UNKNOWN' })
  assert.deepEqual(by('Hal Hart').signing, { status: 'UNKNOWN' }, 'a release carries no signing status')
  assert.deepEqual(by('Ann Able').evidence.map((e) => [e.field, e.value]), [['wikidata_item', 'Q9000001'], ['identity_basis', 'SUPPLIED_MLBAM+REGISTER_NAME_AGREES+WIKIDATA_MLBAM_TIE+BIRTH_DATE_AGREES']])
  assert.equal(by('Lou Lane').organization, 'LAD')
  assert.ok(out.batches.every((b) => b.doc.coverage_claims[0].coverage_state === 'PARTIAL_RECONSTRUCTION'))
  assert.ok(recs.every((r) => /^hist:wikipedia-csv-2024-[0-9a-f]{8}$/.test(r.source_key)), 'sources are keyed under the governing catalog source')
})

test('build writes a release directory the ordinary tools accept: verified, immutable, partial, no unsourced signing facts, restricted rows never in it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-csv-test-'))
  try {
    const shardDir = path.join(tmp, 'chadwick'); fs.mkdirSync(shardDir)
    SHARDS.forEach((s, i) => fs.writeFileSync(path.join(shardDir, `people-${s}.csv`), i === 0 ? REGISTER : `${REGISTER_HEAD}\n`))
    const csv = path.join(tmp, 'rows.csv'); fs.writeFileSync(csv, CSV)
    const rel = path.join(tmp, 'release')
    const wdFile = path.join(tmp, 'wikidata.json'); fs.writeFileSync(wdFile, JSON.stringify(WIKIDATA))
    const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/history/csv-draft.mjs'), 'build', '--csv', csv, '--year', '2024', '--release-dir', rel, '--retrieved', '2026-10-24', '--documented', '614', '--wikidata-map', wdFile], { cwd: root, env: { ...process.env, BAI_CHADWICK_DIR: shardDir }, encoding: 'utf8' })
    const r1 = run(); assert.equal(r1.status, 0, r1.stderr + r1.stdout)
    const loaded = loadRelease(rel)
    assert.deepEqual(verifyReleaseContent(loaded, { root }), [], 'file checksums, scope, source permissions and coverage all verify')
    const m = loaded.manifest
    assert.equal(m.coverage.state, 'PARTIAL_RECONSTRUCTION')
    assert.deepEqual([m.coverage.documented_selections, m.coverage.represented_selections, m.coverage.absent_selections], [614, 6, 608])
    assert.ok(recs0(loaded).every((x) => /the cited source is the supplier's claim and was not read by BAI/.test(x.notes)), 'every record says its provenance is supplied and unverified')
    assert.ok(loaded.batches.every((b) => b.doc.sources.filter((s) => /^hist:wikipedia-csv-/.test(s.source_key)).every((s) => /BAI has not read the source/.test(s.notes))))
    assert.equal(JSON.parse(fs.readFileSync(path.join(rel, 'build.json'), 'utf8')).provenance, 'SUPPLIED_UNVERIFIED')
    assert.equal(m.expected_database_changes.draft_signings_inserted, 0, 'the release writes no signing rows; unsourced signing status stays unknown')
    const recs = loaded.batches.flatMap((b) => b.doc.records)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rel, 'signing-proposals.json'), 'utf8')).map((s) => s.name), ['Hal Hart', 'Lou Lane'])
    assert.ok(!recs.some((x) => ['Eve Ebbs', 'Fay Fox', 'Gus Gray', 'Kit Kane'].includes(x.player.full_name)), 'rows failing the rights or row rules are not in the release')
    // A second run is identical (deterministic); a changed CSV into the same directory is refused (immutable).
    const r2 = run(); assert.equal(r2.status, 0); assert.match(r2.stdout, new RegExp(m.manifest_sha256))
    fs.writeFileSync(csv, `${CSV}${row({ pick: 40, team: 'MIA', name: 'Max Moon' })}\n`)
    const r3 = run(); assert.notEqual(r3.status, 0); assert.match(r3.stderr, /immutable|different/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
