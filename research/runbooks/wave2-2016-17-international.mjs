// Wave 2 (ATL, BAL, HOU, NYY, SD, TB): 2016-17 international signing candidates from MLB's transaction wire (Phase 8,
// 2026-10-20). Run after wave2-2016-slice.mjs.
//   * Discovery, never a census: each club's SFA/SGN entries in the 2016-17 window, classified by the documented rule
//     (born outside the draft-eligible areas, never drafted, 22 or younger at signing, no earlier affiliated season).
//     Every imported record is flagged PATHWAY_BY_RULE; the class stays PARTIAL_RECONSTRUCTION with an unknown size.
//   * Foreign-born signees outside the rule (older players, earlier affiliated seasons, drafted players) are listed by
//     the builder and NOT imported: their classification stays unresolved rather than guessed.
//   * No bonus is imported (the wire gives none). ATL's 2016-17 signings include contracts MLB later voided (the
//     November 2017 sanctions); which ones is not established here, so nothing is marked voided.
//   node --env-file-if-exists=.env.local research/runbooks/wave2-2016-17-international.mjs
//
// Built with scripts/research/sources/intl-signings-from-wire.mjs from MLB Stats API downloads (transactions, people,
// milb_all seasons) retrieved 2026-10-20.
import { cli, refresh } from './run.mjs'

const R = 'bai-backfill-research'
const run = (cmd, args) => cli(cmd, args, { operator: R })
for (const org of ['ATL', 'BAL', 'HOU', 'NYY', 'SD', 'TB']) {
  const key = `2016-17-international-${org.toLowerCase()}`
  run('import', ['--file', `research/imports/${key}.json`, '--org', org, '--class', `${org}/INTERNATIONAL/2016-17`])
  run('validate', ['--batch', key])
  run('apply', ['--batch', key])
  run('apply', ['--batch', key, '--write'])
  run('plan', ['--org', org, '--channel', 'international', '--period', '2016-17'])
}
run('progress', [])
refresh()
