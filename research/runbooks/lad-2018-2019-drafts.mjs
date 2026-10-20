// LAD / DRAFT / 2018 and 2019, researched 2026-10-20 and brought to COVERAGE_REVIEW. Certification is NOT run here.
//   node --env-file-if-exists=.env.local research/runbooks/lad-2018-2019-drafts.mjs
//
// Import files (scripts/research/sources/):
//   20YY-draft-lad.json          draft-class-import.mjs: MLB Stats API draft (teamId=119) + Baseball-Reference draft page
//                                (2018: capture 2025-10-01; 2019: capture 2025-02-16, with --same-person 971 for "Danny"/"Dan" Sinatro)
//   20YY-draft-lad-slots.json    mlbcom-draft-money-import.mjs: MLB.com pick values (2018 sum = $5,288,200 pool; 2019 = $8,069,100)
//   20YY-draft-lad-wire.json     draft-signings-from-wire.mjs: SGN/SFA entries (2018: 32 of 32 signed; 2019: 31 of 31)
//   2019-draft-lad-dd.json       draft-bonus-report-import.mjs: Kody Hoese's bonus (Dodgers Digest 2019-07-12; MLB.com reported the same)
//   20YY-draft-lad-outcomes.json outcome-audits-import.mjs as of 2026-10-20 (B-Ref career WAR from the draft-page captures)
import { cli, pickObservation, refresh } from './run.mjs'

const R = 'bai-backfill-research'
const run = (cmd, args) => cli(cmd, args, { operator: R })
for (const y of ['2018', '2019']) {
  const C = ['--org', 'LAD', '--channel', 'draft', '--year', y]
  const J = `LAD/DRAFT/${y}-JUNE_AMATEUR`
  const cap = y === '2018' ? '20251001040305' : '20250216101048'
  const ingest = (file, key) => {
    run('import', ['--file', file, '--org', 'LAD', '--class', J])
    run('validate', ['--batch', key])
    run('apply', ['--batch', key])
    run('apply', ['--batch', key, '--write'])
    run('plan', C)
  }
  run('class', [...C, '--create'])
  run('start', [...C, '--batch', `lad-${y}-draft-a`, '--take', '3', '--goal', `Reconstruct the LAD ${y} draft class`])
  run('lead', ['--job', `${J}/EXPECTED_UNIVERSE_UNKNOWN/class`, '--url', `https://statsapi.mlb.com/api/v1/draft/${y}?teamId=119`, '--source-type', 'OFFICIAL_LEAGUE', '--authority', 'OFFICIAL',
    '--access', 'ACCESSIBLE', '--retrieved', '2026-10-20', '--fields', 'overall_pick,round_code,round_pick,player,birth_date', '--note', `Official MLB draft data lists ${y === '2018' ? 40 : 41} Dodgers selections`])
  run('lead', ['--job', `${J}/CLASS_NOT_RECONSTRUCTED/class`, '--url', `https://www.baseball-reference.com/draft/?team_ID=LAD&year_ID=${y}&draft_type=junreg&query_type=franch_year`,
    '--archived', `http://web.archive.org/web/${cap}/https://www.baseball-reference.com/draft/index.fcgi?team_ID=LAD&year_ID=${y}&draft_type=junreg&query_type=franch_year`,
    '--source-type', 'REFERENCE_DATABASE', '--authority', 'AGGREGATOR', '--access', 'ARCHIVE_ONLY', '--retrieved', '2026-10-20', '--fields', 'signing_status,signing_bonus_usd,position,school',
    '--note', 'Live page refuses automated requests; the archive capture lists every pick with Signed and Bonus columns'])
  ingest(`research/imports/${y}-draft-lad.json`, `${y}-draft-lad`)
  run('complete', ['--batch', `lad-${y}-draft-a`])
  run('start', [...C, '--batch', `lad-${y}-draft-b`, '--take', '40', '--goal', 'Financials, signing dates and reconciliation'])
  ingest(`research/imports/${y}-draft-lad-slots.json`, `${y}-draft-lad-slots`)
  ingest(`research/imports/${y}-draft-lad-wire.json`, `${y}-draft-lad-wire`)
  if (y === '2019') {
    ingest('research/imports/2019-draft-lad-dd.json', '2019-draft-lad-dd')
    // Jimmy Lewis #78: MLB's compensation round 2C (BAI code C-2), pick 1; Baseball-Reference numbers it inside round 2 (pick 37). Same
    // overall pick; MLB's official structure is kept and B-Ref's label stays on record (as for Sheffield 2016).
    const why = "Pick 78 was a compensation pick after round 2 (MLB's '2C', BAI's C-2, pick 1, for Yasmani Grandal per MLB.com's pick values); Baseball-Reference numbers it inside round 2. Both agree on overall pick 78. Keep MLB's structure; B-Ref's label stays on record."
    for (const field of ['round_code', 'round_pick']) {
      const o = await pickObservation('2019-JUNE_AMATEUR', 78, 'draft_selections', field, 'lad2019:mlb-statsapi-draft-2019-lad')
      cli('resolve', ['--table', 'draft_selections', '--id', String(o.subject_id), '--field', field, '--observation', String(o.observation_id), '--operator', 'bai-backfill-review', '--rationale', why, '--write'], { operator: R })
    }
    run('plan', C)
  }
  run('complete', ['--batch', `lad-${y}-draft-b`, '--release'])   // outcome jobs it took go back to the queue for batch c
  run('start', [...C, '--batch', `lad-${y}-draft-c`, '--take', '45', '--goal', 'Outcome audits as of 2026-10-20'])
  run('import', ['--file', `research/imports/${y}-draft-lad-outcomes.json`, '--org', 'LAD', '--class', J])
  run('validate', ['--batch', `${y}-draft-lad-outcomes`])
  run('apply', ['--batch', `${y}-draft-lad-outcomes`])
  run('apply', ['--batch', `${y}-draft-lad-outcomes`, '--write'])
  run('plan', C)
  run('complete', ['--batch', `lad-${y}-draft-c`])
  for (let i = 0; i < 7; i++) run('stage', [...C, '--rationale', 'class review'])
  run('class', C)
}
refresh()
