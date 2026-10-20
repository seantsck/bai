// The next Wave 1 cohorts, begun on 2026-10-20 and deliberately left in progress (nothing certified):
//   LAD/DRAFT/2017-JUNE_AMATEUR    40 of 40 picks, slots for rounds 1-10, 13 of 31 bonuses; batch lad-2017-draft-b paused
//   LAD/INTERNATIONAL/2016-17      45 candidate amateur signings from the MLB transaction wire (rule-classified)
//   LAD/INTERNATIONAL/2017-18      50 candidate amateur signings from the MLB transaction wire (rule-classified)
//   node --env-file-if-exists=.env.local research/runbooks/lad-2017-cohorts.mjs
//
// Import files were built with scripts/research/sources/: draft-class-import.mjs (2017 draft), mlbcom-draft-money-import.mjs
// (2017 slots and tracker bonuses) and intl-signings-from-wire.mjs (both international periods).
import { cli, refresh } from './run.mjs'

const R = 'bai-backfill-research'
const run = (cmd, args) => cli(cmd, args, { operator: R })
const ingest = (file, key, cls, scope) => {
  run('import', ['--file', file, '--org', 'LAD', '--class', cls])
  run('validate', ['--batch', key])
  run('apply', ['--batch', key])
  run('apply', ['--batch', key, '--write'])
  run('plan', scope)
}

// LAD 2017 draft.
const D = ['--org', 'LAD', '--channel', 'draft', '--year', '2017']
const DJ = 'LAD/DRAFT/2017-JUNE_AMATEUR'
run('class', [...D, '--create'])
run('start', [...D, '--batch', 'lad-2017-draft-a', '--take', '3', '--goal', 'Reconstruct the LAD 2017 draft class'])
run('lead', ['--job', `${DJ}/EXPECTED_UNIVERSE_UNKNOWN/class`, '--url', 'https://statsapi.mlb.com/api/v1/draft/2017?teamId=119', '--source-type', 'OFFICIAL_LEAGUE', '--authority', 'OFFICIAL',
  '--access', 'ACCESSIBLE', '--retrieved', '2026-10-20', '--fields', 'overall_pick,round_code,round_pick,player,birth_date', '--note', 'Official MLB draft data lists 40 Dodgers selections in the 2017 Rule 4 draft'])
run('lead', ['--job', `${DJ}/CLASS_NOT_RECONSTRUCTED/class`, '--url', 'https://www.baseball-reference.com/draft/?team_ID=LAD&year_ID=2017&draft_type=junreg&query_type=franch_year',
  '--archived', 'http://web.archive.org/web/20260105045552/https://www.baseball-reference.com/draft/index.fcgi?query_type=franch_year&team_ID=LAD&year_ID=2017&draft_type=junreg',
  '--source-type', 'REFERENCE_DATABASE', '--authority', 'AGGREGATOR', '--access', 'ARCHIVE_ONLY', '--retrieved', '2026-10-20', '--fields', 'signing_status,signing_bonus_usd,position,school',
  '--note', 'Live page refuses automated requests; 2026-01-05 capture lists 40 picks with Signed and Bonus columns'])
ingest('research/imports/2017-draft-lad.json', '2017-draft-lad', DJ, D)
run('complete', ['--batch', 'lad-2017-draft-a'])
run('start', [...D, '--batch', 'lad-2017-draft-b', '--take', '20', '--goal', 'Financials: slots and bonuses'])
ingest('research/imports/2017-draft-lad-slots.json', '2017-draft-lad-slots', DJ, D)
ingest('research/imports/2017-draft-lad-tracker.json', '2017-draft-lad-tracker', DJ, D)
run('pause', ['--batch', 'lad-2017-draft-b'])

// International 2016-17 and 2017-18.
const outside = {
  '2016-17': 'Not imported: José Miguel Fernández (Cuba, 28, 2017-01-11; possible exempt professional), Narciso Mesa (DOM, 24), Wilmer Font (VEN, 26), Fabio Castillo (DOM, 27), Daniel Corcino (DOM, 26), Kenley Jansen (CUW, 29, MLB re-signing), Franklin Gutierrez (VEN, 33), Jair Jurrjens (CUW, 31), Justin Masterson (JAM, drafted 2006). Decide each with evidence: professional signing vs minor-league free agent.',
  '2017-18': 'Not imported: Darien Núñez (Cuba, 25, 2018-04-16; possible professional), Hamlet Marte (DOM, 23), Manny Banuelos (MEX, 26), C.C. Lee (TWN, 31), Donovan Solano (COL, 30), Guillo Zuñiga (COL; 2016 DSL Braves before signing), Shawn Zarraga (ABW, drafted 2007), Jose Brizuela (VEN, drafted 2014), Aldrich De Jongh (CUW, drafted 2018).'
}
for (const p of ['2016-17', '2017-18']) {
  const I = ['--org', 'LAD', '--channel', 'international', '--period', p]
  const IJ = `LAD/INTERNATIONAL/${p}`
  run('class', [...I, '--create'])
  run('start', [...I, '--batch', `lad-${p}-intl-a`, '--take', '3', '--goal', `Discover the LAD ${p} international class`])
  run('lead', ['--job', `${IJ}/EXPECTED_UNIVERSE_UNKNOWN/class`, '--reference', `statsapi.mlb.com/api/v1/transactions?teamId=119 (${p} window)`, '--source-type', 'OFFICIAL_LEAGUE',
    '--authority', 'OFFICIAL', '--access', 'ACCESSIBLE', '--retrieved', '2026-10-20', '--fields', 'signing_date,player,position',
    '--note', 'Transaction wire lists club signings by day; it is not a complete international class list and carries no bonuses'])
  ingest(`research/imports/${p}-international-lad.json`, `${p}-international-lad`, IJ, I)
  run('job', ['--add', ...I, '--category', 'CLASS_NOT_RECONSTRUCTED', '--label', 'review-signees-outside-rule', '--title', 'Review foreign-born signees outside the amateur rule (possible exempt professionals)', '--note', outside[p]])
  run('pause', ['--batch', `lad-${p}-intl-a`])
}
refresh()
run('progress', ['--org', 'LAD'])
