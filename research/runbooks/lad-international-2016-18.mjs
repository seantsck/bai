// LAD / INTERNATIONAL / 2016-17 and 2017-18: reconciliation against independent lists (2026-10-20), after
// lad-2017-cohorts.mjs. Nothing is certified and neither class is claimed complete: both stay PARTIAL_RECONSTRUCTION
// (docs/evidence/lad-international-2016-18-reconciliation.md).
//   node --env-file-if-exists=.env.local research/runbooks/lad-international-2016-18.mjs
//
// Import files (scripts/research/sources/intl-list-corroboration.mjs, from transcriptions in research/evidence/):
//   2017-18-international-lad-announcement.json  the club's 2017-07-03 announcement of 26 signings: 25 match candidates,
//                                                3 with Baseball America-confirmed bonuses
//   2016-17-international-lad-reports.json       Albert Suarez, reported $300,000
//   2016-17-international-lad-professionals.json José Miguel Fernández, INTERNATIONAL_PROFESSIONAL (pool-exempt veteran)
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
const question = (scope, label, title, note) => run('job', ['--add', ...scope, '--category', 'CLASS_NOT_RECONSTRUCTED', '--label', label, '--title', title, '--note', note])

// 2016-17
const A = ['--org', 'LAD', '--channel', 'international', '--period', '2016-17']
const AJ = 'LAD/INTERNATIONAL/2016-17'
run('resume', ['--batch', 'lad-2016-17-intl-a'])
ingest('research/imports/2016-17-international-lad-reports.json', '2016-17-international-lad-reports', AJ, A)
ingest('research/imports/2016-17-international-lad-professionals.json', '2016-17-international-lad-professionals', AJ, A)
question(A, 'decide-yordan-alvarez-period', 'Decide the signing period of Yordan Alvarez (agreed 2015-16, contract dated in 2016-17)',
  'MLB wire: "signed free agent Yordan Alvarez" on 2016-07-15, so the date rule places him in 2016-17. Dodgers Digest (2016-06-16), MLB.com and Baseball America report a $2,000,000 agreement on 2016-06-15, the last day of 2015-16, charged to the 2015-16 pool (the Dodgers could not exceed $300,000 per player in 2016-17). Recommended: record him in 2015-16 with the agreement date and bonus; needs a corrective batch.')
run('pause', ['--batch', 'lad-2016-17-intl-a'])

// 2017-18
const B = ['--org', 'LAD', '--channel', 'international', '--period', '2017-18']
const BJ = 'LAD/INTERNATIONAL/2017-18'
run('resume', ['--batch', 'lad-2017-18-intl-a'])
ingest('research/imports/2017-18-international-lad-announcement.json', '2017-18-international-lad-announcement', BJ, B)
question(B, 'identify-jonathan-alvarez', 'Identify Jonathan Alvarez (RHP, Dominican Republic), announced 2017-07-03',
  'Named in the club announcement of 26 signings (Dodgers Digest 2017-07-04); no LAD signing entry on the MLB wire and no MLBAM identity found. Evidence the wire-derived population is incomplete.')
question(B, 'identify-jaime-perez-2017', 'Identify the Cuban OF Jaime Perez reported signed 2017-07-02',
  'Dodgers Digest 2017-07-03 lists him among the first-day signings (bonus report it calls unreliable) and notes he is a second Jaime Perez, distinct from MLBAM 676015 (signed 2017-05-29, 2016-17 period).')
question(B, 'martin-santana-date', 'Reconcile Martin Santana: announced 2017-07-03, wire contract 2017-10-20',
  'The club announcement lists him on 2017-07-03; the MLB wire dates his signing 2017-10-20. Both fall in 2017-18; the recorded date stays the wire date until a source settles it.')
question(B, 'classify-darien-nunez', 'Classify Darien Núñez (Cuba, 25, signed 2018-04-16): exempt professional or pool-subject',
  'Dodgers Digest 2018-04-18 infers pool exemption from his age; exemption under the 2017-21 agreement also needs six professional seasons, not established. Not imported.')
run('pause', ['--batch', 'lad-2017-18-intl-a'])
refresh()
run('class', A)
run('class', B)
