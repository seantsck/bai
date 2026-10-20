// Wave 2 preparation (proposed clubs ATL, BAL, SD, TB, HOU, NYY), 2026-10-20: the 2016 slice of both channels,
// created, planned and given their verified source leads. Nothing is imported, no claim is made, nothing is certified,
// and no program wave is set (research:wave is a human decision; docs/proposals/league-wide-cohort-roadmap.md).
//   node --env-file-if-exists=.env.local research/runbooks/wave2-2016-slice.mjs
// Counts below were read from MLB's Stats API on 2026-10-20 (draft?teamId=…; transactions?teamId=… 2016-07-02..2017-06-15).
import { cli } from './run.mjs'

const R = 'bai-backfill-research'
const run = (cmd, args) => cli(cmd, args, { operator: R })
const CLUBS = [
  { org: 'ATL', team: 144, picks: 42, signings: 76 }, { org: 'BAL', team: 110, picks: 41, signings: 61 }, { org: 'HOU', team: 117, picks: 40, signings: 53 },
  { org: 'NYY', team: 147, picks: 40, signings: 69 }, { org: 'SD', team: 135, picks: 43, signings: 91 }, { org: 'TB', team: 139, picks: 41, signings: 69 }
]
for (const c of CLUBS) {
  const D = ['--org', c.org, '--channel', 'draft', '--year', '2016']
  const I = ['--org', c.org, '--channel', 'international', '--period', '2016-17']
  run('class', [...D, '--create'])
  run('lead', ['--job', `${c.org}/DRAFT/2016-JUNE_AMATEUR/EXPECTED_UNIVERSE_UNKNOWN/class`, '--url', `https://statsapi.mlb.com/api/v1/draft/2016?teamId=${c.team}`, '--source-type', 'OFFICIAL_LEAGUE',
    '--authority', 'OFFICIAL', '--access', 'ACCESSIBLE', '--retrieved', '2026-10-20', '--fields', 'overall_pick,round_code,round_pick,player,birth_date',
    '--note', `Official MLB draft data lists ${c.picks} selections; signing status and bonuses still need Baseball-Reference / Baseball America / MLB.com (see the discovery plan)`])
  run('class', [...I, '--create'])
  run('lead', ['--job', `${c.org}/INTERNATIONAL/2016-17/EXPECTED_UNIVERSE_UNKNOWN/class`, '--reference', `statsapi.mlb.com/api/v1/transactions?teamId=${c.team} (2016-17 window)`,
    '--source-type', 'OFFICIAL_LEAGUE', '--authority', 'OFFICIAL', '--access', 'ACCESSIBLE', '--retrieved', '2026-10-20', '--fields', 'signing_date,player,position',
    '--note', `${c.signings} signing entries (SGN/SFA) on the wire in the window, before any classification; not a class list and no bonuses`])
}
run('progress', [])
