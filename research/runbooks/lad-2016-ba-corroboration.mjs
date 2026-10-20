// LAD / DRAFT / 2016: Baseball America's "2016 Draft Selections" table as a third bonus source (2026-10-20), after
// lad-2016-draft.mjs. It agrees with 25 recorded figures, supplies Saige Jenco's bonus (#731, $75,000; Baseball-Reference
// blank), and sides with Baseball-Reference on Devin Smeltzer (#161, $497,500 against MLB.com's $500,000).
// The new claim reopens the Smeltzer conflict. It is left OPEN for the human reviewer (item 1 of
// docs/evidence/lad-2016-review-checklist.md): the declared rule would keep MLB.com's $500,000, the evidence favours $497,500,
// and a recorded resolution cannot be re-decided later. Until it is decided, the class shows a CONFLICTS blocker.
// Certification is NOT run here.
//   node --env-file-if-exists=.env.local research/runbooks/lad-2016-ba-corroboration.mjs
//
// Import file: 2016-draft-lad-ba.json, scripts/research/sources/ba-draft-bonuses-import.mjs from the 2026-04-29 capture.
import { cli, refresh } from './run.mjs'

const C = ['--org', 'LAD', '--channel', 'draft', '--year', '2016']
const J = 'LAD/DRAFT/2016-JUNE_AMATEUR'
const R = 'bai-backfill-research'
const run = (cmd, args) => cli(cmd, args, { operator: R })

run('import', ['--file', 'research/imports/2016-draft-lad-ba.json', '--org', 'LAD', '--class', J])
run('validate', ['--batch', '2016-draft-lad-ba'])
run('apply', ['--batch', '2016-draft-lad-ba'])
run('apply', ['--batch', '2016-draft-lad-ba', '--write'])
run('job', ['--job', `${J}/ACQUISITION_COST_MISSING/pick-731`, '--state', 'SUPERSEDED', '--rationale', "Answered by a later source: Baseball America's 2016 Draft Selections table gives $75,000 (batch 2016-draft-lad-ba)."])
run('plan', C)
refresh()
run('class', C)
