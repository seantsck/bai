// Replays the validated 2015 Dodgers pilot into an empty BAI database (local, or hosted with --confirm-hosted <ref>).
// The batches contain other clubs' re-drafts, so they are imported as explicitly league-wide (--league).
//   node --env-file-if-exists=.env.local research/runbooks/pilot-2015-lad.mjs
import { cli, pickObservation } from './run.mjs'

for (const [file, key] of [['research/imports/2015-draft-lad.json', 'pilot-2015-draft-lad'], ['research/imports/2015-international-lad.json', 'pilot-2015-international-lad']]) {
  cli('import', ['--file', file, '--league', '--operator', 'bai-pilot'])
  cli('validate', ['--batch', key])
  cli('apply', ['--batch', key])
  cli('apply', ['--batch', key, '--write'])
}
const rationale = "Pick 74 was a Competitive Balance Round B pick: MLB's official draft data labels it CB-B, pick 4 of that round; Baseball-Reference numbers CB-B picks inside round 2. Both agree on overall pick 74. Keep MLB's structure; B-Ref's label stays on record."
for (const field of ['round_code', 'round_pick']) {
  const o = await pickObservation('2015-JUNE_AMATEUR', 74, 'draft_selections', field, 'pilot2015:mlb-statsapi-draft-2015-lad')
  cli('resolve', ['--table', 'draft_selections', '--id', String(o.subject_id), '--field', field, '--observation', String(o.observation_id), '--operator', 'bai-pilot-review', '--rationale', rationale, '--write'])
}
