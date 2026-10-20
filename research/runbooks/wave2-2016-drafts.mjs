// Wave 2 (ATL, BAL, HOU, NYY, SD, TB): the 2016 draft classes, universe and identity first (Phase 8, 2026-10-20).
// Run after wave2-2016-slice.mjs.
//   * Universe: MLB's official draft data per club (draft/2016?teamId=…), a sourced COMPLETE_CENSUS claim of 42, 41, 40,
//     40, 43 and 41 picks.
//   * Identity: MLBAM ids from MLB; Baseball-Reference ids from the club's 2016 draft page (Wayback captures,
//     2025-08 to 2026-08). Four spellings were confirmed by hand as one player: same pick, same club, same school in both
//     sources (NYY #728 Joseph/Joe Burton, SD #594 Dominic/Dom DiSabatino, SD #954 Ariel Burgos Garcia/Ariel Burgos,
//     SD #1134 William/Will Solomon).
//   * Signing status and bonuses: Baseball-Reference alone for now (a single AGGREGATOR source; blank = unknown, never
//     zero). Slots, MLB.com's tracker, Baseball America and the wire's signing dates are the next stages.
//   * Numbering: where B-Ref numbers a competitive-balance pick as a regular-round pick (ATL #40 and #76, SD #71, TB #77),
//     its claim is a conflict. A proposal asks the reviewer to keep MLB's structure, as for LAD's Sheffield (2016) and
//     Jimmy Lewis (2019). Nothing is decided here.
//   node --env-file-if-exists=.env.local research/runbooks/wave2-2016-drafts.mjs
//
// Built with scripts/research/sources/draft-class-import.mjs (--same-person for the four confirmed spellings).
import { cli, pickObservation } from './run.mjs'

const R = 'bai-backfill-research'
const run = (cmd, args) => cli(cmd, args, { operator: R })
const CLUBS = [
  { org: 'ATL', team: 144, disputes: [40, 76] }, { org: 'BAL', team: 110, disputes: [] }, { org: 'HOU', team: 117, disputes: [] },
  { org: 'NYY', team: 147, disputes: [] }, { org: 'SD', team: 135, disputes: [71] }, { org: 'TB', team: 139, disputes: [77] }
]
for (const c of CLUBS) {
  const lo = c.org.toLowerCase()
  const key = `2016-draft-${lo}`
  run('import', ['--file', `research/imports/${key}.json`, '--org', c.org, '--class', `${c.org}/DRAFT/2016-JUNE_AMATEUR`])
  run('validate', ['--batch', key])
  run('apply', ['--batch', key])
  run('apply', ['--batch', key, '--write'])
  for (const pick of c.disputes) {
    for (const field of ['round_code', 'round_pick']) {
      const o = await pickObservation('2016-JUNE_AMATEUR', pick, 'draft_selections', field, `${lo}2016:mlb-statsapi-draft-2016-${lo}`)
      cli('propose', ['--table', 'draft_selections', '--id', String(o.subject_id), '--field', field, '--observation', String(o.observation_id), '--agent', 'bai-research',
        '--rationale', `Keep MLB's official structure for ${c.org} 2016 #${pick}: a competitive-balance pick, labelled and numbered within that round. Baseball-Reference numbers it as a regular-round pick; both sources agree on overall pick ${pick}. B-Ref's label stays on record. Same decision as LAD 2016 #36 (Sheffield).`,
        '--evidence', `https://statsapi.mlb.com/api/v1/draft/2016?teamId=${c.team}`])
    }
  }
  run('plan', ['--org', c.org, '--channel', 'draft', '--year', '2016'])
}
run('progress', [])
