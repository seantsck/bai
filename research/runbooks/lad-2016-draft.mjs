// LAD / DRAFT / 2016: the first non-pilot validation class, replayed exactly as it was researched on 2026-10-20.
// Every decision below (leads, resolutions, explicit unknowns, stage moves) is the recorded research, so a fresh local
// database, or the hosted one with --confirm-hosted <ref>, ends in the same state. Certification is NOT run here:
// the class stops at COVERAGE_REVIEW for a human reviewer (research:certify).
//   node --env-file-if-exists=.env.local research/runbooks/lad-2016-draft.mjs
//
// How the import files were made (not replayed: it needs the downloaded files):
//   2016-draft-lad.json          scripts/research/sources/draft-class-import.mjs from the MLB Stats API draft JSON
//                                (teamId=119) and the 2026-08-03 Wayback capture of the Baseball-Reference draft page
//   2016-draft-lad-slots.json    MLB.com pick values (Callis, 2016-04-05, Wayback 2021-12-09): the Dodgers entries sit at
//                                overall positions 20, 32, 36, 65, 101 … 311 and sum to the stated $9,336,500 pool
//   2016-draft-lad-tracker.json  MLB.com signing and bonus tracker (Wayback 2019-09-22), rounds 1-10
import { cli, pickObservation, refresh } from './run.mjs'

const C = ['--org', 'LAD', '--channel', 'draft', '--year', '2016']
const J = 'LAD/DRAFT/2016-JUNE_AMATEUR'
const R = 'bai-backfill-research'
const run = (cmd, args) => cli(cmd, args, { operator: R })

run('class', [...C, '--create'])
run('next', ['--org', 'LAD', '--limit', '5'])
run('start', [...C, '--batch', 'lad-2016-draft-a', '--take', '3', '--goal', 'Reconstruct the LAD 2016 draft class'])
run('lead', ['--job', `${J}/EXPECTED_UNIVERSE_UNKNOWN/class`, '--url', 'https://statsapi.mlb.com/api/v1/draft/2016?teamId=119', '--source-type', 'OFFICIAL_LEAGUE',
  '--authority', 'OFFICIAL', '--access', 'ACCESSIBLE', '--retrieved', '2026-10-19', '--fields', 'overall_pick,round_code,round_pick,player,birth_date',
  '--note', 'Official MLB draft data lists 42 Dodgers selections in the 2016 Rule 4 draft'])
run('lead', ['--job', `${J}/CLASS_NOT_RECONSTRUCTED/class`, '--url', 'https://www.baseball-reference.com/draft/?team_ID=LAD&year_ID=2016&draft_type=junreg&query_type=franch_year',
  '--archived', 'http://web.archive.org/web/20260803214548/https://www.baseball-reference.com/draft/index.fcgi?query_type=franch_year&team_ID=LAD&year_ID=2016&draft_type=junreg',
  '--source-type', 'REFERENCE_DATABASE', '--authority', 'AGGREGATOR', '--access', 'ARCHIVE_ONLY', '--retrieved', '2026-10-19', '--fields', 'signing_status,signing_bonus_usd,position,school',
  '--note', 'Live page refuses automated requests; 2026-08-03 capture lists 42 picks with Signed and Bonus columns'])

const ingest = (file, key) => {
  run('import', ['--file', file, '--org', 'LAD', '--class', J])
  run('validate', ['--batch', key])
  run('apply', ['--batch', key])
  run('apply', ['--batch', key, '--write'])
  run('plan', C)
}
ingest('research/imports/2016-draft-lad.json', '2016-draft-lad')
run('resume', ['--batch', 'lad-2016-draft-a'])
run('complete', ['--batch', 'lad-2016-draft-a'])
run('start', [...C, '--batch', 'lad-2016-draft-b', '--take', '14', '--goal', 'Financials and source reconciliation'])
ingest('research/imports/2016-draft-lad-slots.json', '2016-draft-lad-slots')
ingest('research/imports/2016-draft-lad-tracker.json', '2016-draft-lad-tracker')

// Jordan Sheffield (#36): MLB CB-A pick 2 vs Baseball-Reference round 1 pick 36 -> operator decision.
const sheffield = "Pick 36 was a Competitive Balance Round A pick: MLB's official draft data labels it CB-A, pick 2 of that round; Baseball-Reference numbers it inside round 1 (pick 36). Both agree on overall pick 36. Keep MLB's structure; B-Ref's label stays on record."
for (const field of ['round_code', 'round_pick']) {
  const o = await pickObservation('2016-JUNE_AMATEUR', 36, 'draft_selections', field, 'lad2016:mlb-statsapi-draft-2016-lad')
  cli('resolve', ['--table', 'draft_selections', '--id', String(o.subject_id), '--field', field, '--observation', String(o.observation_id), '--operator', 'bai-backfill-review', '--rationale', sheffield, '--write'], { operator: R })
}
// Devin Smeltzer (#161): MLB tracker $500,000 vs Baseball-Reference $497,500 -> declared rule PREFER_HIGHER_AUTHORITY.
const smeltzer = await pickObservation('2016-JUNE_AMATEUR', 161, 'draft_signings', 'signing_bonus_usd', 'lad2016:mlb-signing-tracker-2016')
run('resolve', ['--table', 'draft_signings', '--id', String(smeltzer.subject_id), '--field', 'signing_bonus_usd', '--rule'])
run('resolve', ['--table', 'draft_signings', '--id', String(smeltzer.subject_id), '--field', 'signing_bonus_usd', '--rule', '--write'])
run('plan', C)

run('pause', ['--batch', 'lad-2016-draft-b'])
run('resume', ['--batch', 'lad-2016-draft-b'])
const unknown = 'Signed (Baseball-Reference Signed=Y) but no bonus published: Baseball-Reference bonus column blank; MLB.com signing tracker covers rounds 1-10 only (searched 2026-10-20). Unknown, not zero; reopen with a new job if a source appears.'
for (const pick of [731, 761, 821, 851, 941, 971, 1031]) run('job', ['--job', `${J}/ACQUISITION_COST_MISSING/pick-${pick}`, '--state', 'UNRESOLVED', '--rationale', unknown])
run('complete', ['--batch', 'lad-2016-draft-b'])
for (let i = 0; i < 7; i++) run('stage', [...C, '--rationale', 'class review'])
refresh()
run('class', C)
