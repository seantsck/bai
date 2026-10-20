// LAD / DRAFT / 2017: completion of the class begun in lad-2017-cohorts.mjs (run that first), researched on 2026-10-20.
// Ends at COVERAGE_REVIEW for a human reviewer; certification is NOT run here.
//   node --env-file-if-exists=.env.local research/runbooks/lad-2017-completion.mjs
//
// Import files (built with scripts/research/sources/):
//   2017-draft-lad-wire.json        draft-signings-from-wire.mjs: 33 SGN entries on the MLB transaction wire (2017-06-12..08-31)
//   2017-draft-lad-wire-dates.json  the same, --only 520,610: dates for the two picks whose status the first batch corrects
//   2017-draft-lad-ba.json          ba-draft-bonuses-import.mjs: Baseball America "2017 Draft Selections" (13 figures; "—" elsewhere)
//   2017-draft-lad-outcomes.json    outcome-audits-import.mjs as of 2026-10-20, B-Ref career WAR through 2025 (2026-01-05 capture),
//                                   Rule 5 losses from research/evidence/rule5-2020-lad.json
import { cli, pickObservation, refresh } from './run.mjs'

const C = ['--org', 'LAD', '--channel', 'draft', '--year', '2017']
const J = 'LAD/DRAFT/2017-JUNE_AMATEUR'
const R = 'bai-backfill-research'
const run = (cmd, args) => cli(cmd, args, { operator: R })
const ingest = (file, key) => {
  run('import', ['--file', file, '--org', 'LAD', '--class', J])
  run('validate', ['--batch', key])
  run('apply', ['--batch', key])
  run('apply', ['--batch', key, '--write'])
  run('plan', C)
}

run('resume', ['--batch', 'lad-2017-draft-b'])

// Signing status. Baseball-Reference's capture marks Nathan Witt (#520) and Donovan Casey (#610) unsigned; MLB's wire records
// both signing on 2017-07-06, as do MLB.com's Ken Gurnick and Dodgers Digest (2017-07-07: "33 of 40 total picks signed",
// naming both). signing_status needs an operator decision (REQUIRE_OPERATOR); B-Ref's claim stays on record. The reviewer
// confirms or re-decides it (docs/evidence/lad-2017-draft-certification.md).
ingest('research/imports/2017-draft-lad-wire.json', '2017-draft-lad-wire')
const signed = 'MLB transaction wire (OFFICIAL) records "Los Angeles Dodgers signed" on 2017-07-06; Dodgers Digest 2017-07-07 and MLB.com\'s Ken Gurnick name the signing and count 33 of 40 signed, which only holds with this pick signed. Baseball-Reference\'s Signed=N is kept on record as a rejected claim.'
for (const pick of [520, 610]) {
  const o = await pickObservation('2017-JUNE_AMATEUR', pick, 'draft_signings', 'signing_status', 'lad2017:mlb-transactions-draft-2017')
  cli('resolve', ['--table', 'draft_signings', '--id', String(o.subject_id), '--field', 'signing_status', '--observation', String(o.observation_id), '--operator', 'bai-backfill-review', '--rationale', signed, '--write'], { operator: R })
}
ingest('research/imports/2017-draft-lad-wire-dates.json', '2017-draft-lad-wire-dates')

// Bonuses. Baseball America agrees with all 13 recorded figures and publishes none for rounds 14-40.
ingest('research/imports/2017-draft-lad-ba.json', '2017-draft-lad-ba')
const unknown = 'Signed (MLB transaction wire) but no bonus published: Baseball-Reference bonus blank; MLB.com signing tracker covers rounds 1-10; ' +
  "Baseball America's 2017 draft table prints no figure; Dodgers Digest (2017-07-05, 2017-07-07) reports late-round bonuses were not announced. " +
  'Searched 2026-10-20. Unknown, not zero; reopen with a new job if a source appears.'
for (const pick of [460, 490, 520, 550, 580, 610, 670, 700, 730, 760, 790, 820, 850, 910, 970, 1000, 1030, 1060, 1090, 1120]) {
  run('job', ['--job', `${J}/ACQUISITION_COST_MISSING/pick-${pick}`, '--state', 'UNRESOLVED', '--rationale', unknown])
}
run('complete', ['--batch', 'lad-2017-draft-b'])

// Outcomes for all 40 selections.
run('start', [...C, '--batch', 'lad-2017-draft-c', '--take', '40', '--goal', 'Outcome audits as of 2026-10-20'])
ingest('research/imports/2017-draft-lad-outcomes.json', '2017-draft-lad-outcomes')
run('complete', ['--batch', 'lad-2017-draft-c'])
for (let i = 0; i < 7; i++) run('stage', [...C, '--rationale', 'class review'])   // DISCOVERY -> COVERAGE_REVIEW
refresh()
run('class', C)
