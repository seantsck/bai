// LAD / INTERNATIONAL / 2017-18: closes the identification questions researched on 2026-10-20 (after
// lad-international-2016-18.mjs). Evidence: MLB season rosters of every Dodgers rookie-level club, 2017-2019
// (docs/evidence/lad-international-2016-18-reconciliation.md, Phase 7). Nothing is imported; coverage stays partial.
//   node --env-file-if-exists=.env.local research/runbooks/lad-international-phase7.mjs
import { cli } from './run.mjs'

const R = 'bai-backfill-research'
const run = (cmd, args) => cli(cmd, args, { operator: R })
const J = 'LAD/INTERNATIONAL/2017-18/CLASS_NOT_RECONSTRUCTED'
const rosters = "MLB season rosters (rosterType=fullSeason) of DSL Dodgers 611/612 and AZL Dodgers 2690/5427, 2017-2019, checked 2026-10-20"
run('job', ['--job', `${J}/identify-jonathan-alvarez`, '--state', 'UNRESOLVED', '--rationale',
  `Unknown after research: announced 2017-07-03 (Dodgers Digest), but no LAD signing entry on the MLB wire, no MLBAM identity, and absent from ${rosters}. Not imported; reopen with a new job if a club or MLB source identifies him.`])
run('job', ['--job', `${J}/identify-jaime-perez-2017`, '--state', 'UNRESOLVED', '--rationale',
  `Unknown after research: only one Cuban OF Jaime Perez (MLBAM 676015, signed 2017-05-29) appears in ${rosters}; the reported second player (doubted by the reporting article itself) leaves no trace. Not imported.`])
run('job', ['--job', `${J}/martin-santana-date`, '--state', 'DONE', '--rationale',
  'Announced 2017-07-03; the wire dates the contract 2017-10-20. Both dates fall in 2017-18, so the class is unaffected; the official contract date stays the signing date and the announcement is noted. He played for the DSL Dodgers in 2018 and 2019 (MLBAM 679756).'])
run('class', ['--org', 'LAD', '--channel', 'international', '--period', '2017-18'])
