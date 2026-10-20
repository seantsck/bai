// LAD 2016 and 2017 draft classes: per-acquisition dispositions (migration 022), researched 2026-10-20. Run after the
// class, value and 2018-2019 runbooks.
//   * The 2016 and 2017 outcome batches were applied before 022 and carried their dispositions on the player; 022 moved
//     each to the player's only acquisition. These batches restate the audits unchanged and give every acquisition its
//     disposition explicitly, with the exit date from MLB's transaction wire (the same downloads as the outcome batches).
//   * The 2016 batch was built with the researcher-verified 2020 Rule 5 list (research/evidence/rule5-2020-lad.json):
//     Jordan Sheffield (#36) and Errol Robinson (#191) are LOST_RULE_5 there, against LOST_WAIVERS from MLB's wire coding.
//     That stays an open conflict, and a proposal asks the reviewer to choose the Rule 5 classification.
//   node --env-file-if-exists=.env.local research/runbooks/lad-dispositions-phase8.mjs
//
// Built with scripts/research/sources/outcome-audits-import.mjs --dispositions-only (2016 with --rule5; 2017 with
// --rule5, as its outcome batch was).
import { cli, lookup, refresh } from './run.mjs'

const R = 'bai-backfill-research'
const run = (cmd, args) => cli(cmd, args, { operator: R })
const ingest = (file, key, cls) => {
  run('import', ['--file', file, '--org', 'LAD', ...(cls ? ['--class', cls] : [])])
  run('validate', ['--batch', key])
  run('apply', ['--batch', key])
  run('apply', ['--batch', key, '--write'])
}
ingest('research/imports/2016-draft-lad-dispositions.json', '2016-draft-lad-dispositions', 'LAD/DRAFT/2016-JUNE_AMATEUR')
ingest('research/imports/2017-draft-lad-dispositions.json', '2017-draft-lad-dispositions', 'LAD/DRAFT/2017-JUNE_AMATEUR')

for (const [pick, name, detail] of [[36, 'Jordan Sheffield', 'taken 7th in the Major League phase by Colorado'], [191, 'Errol Robinson', 'taken by Cincinnati in the Minor League phase']]) {
  const o = await lookup(`select o.id as observation_id, o.subject_id from public.source_observations o join public.sources s on s.id = o.source_id
    join public.acquisition_dispositions a on a.id = o.subject_id join public.draft_selections sel on sel.id = a.draft_selection_id join public.drafts d on d.id = sel.draft_id
    where o.subject_table = 'acquisition_dispositions' and o.field_name = 'disposition' and d.draft_key = '2016-JUNE_AMATEUR' and sel.overall_pick = $1
      and s.source_key = 'lad:mlbcom-rule5-2020-lad' and o.status = 'ACTIVE'`, [pick])
  cli('propose', ['--table', 'acquisition_dispositions', '--id', String(o.subject_id), '--field', 'disposition', '--observation', String(o.observation_id), '--agent', 'bai-research',
    '--rationale', `Choose LOST_RULE_5 for ${name} (#${pick}). MLB's transaction wire codes the 2020-12-10 departure as a waiver claim, but MLB.com's same-day report of the 2020 Rule 5 draft names him (${detail}). The wire's code stays on record.`,
    '--evidence', 'research/evidence/rule5-2020-lad.json,http://web.archive.org/web/20260101164013/https://www.mlb.com/news/dodgers-2020-rule-5-draft-results'])
}
for (const y of ['2016', '2017']) run('plan', ['--org', 'LAD', '--channel', 'draft', '--year', y])
cli('proposals', [])
refresh()
