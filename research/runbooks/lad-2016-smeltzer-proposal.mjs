// LAD / DRAFT / 2016: files the Smeltzer bonus correction as a decision PROPOSAL (2026-10-20), after
// lad-2016-ba-corroboration.mjs. A proposal decides nothing: the conflict stays open until a registered human reviewer
// accepts it (research:resolve ... --proposal <id>) or rejects it. Evidence: research/evidence/smeltzer-2016-bonus.json.
//   node --env-file-if-exists=.env.local research/runbooks/lad-2016-smeltzer-proposal.mjs
import { cli, pickObservation } from './run.mjs'

const ba = await pickObservation('2016-JUNE_AMATEUR', 161, 'draft_signings', 'signing_bonus_usd', 'lad2016:ba-draft-selections-2016')
cli('propose', ['--table', 'draft_signings', '--id', String(ba.subject_id), '--field', 'signing_bonus_usd', '--observation', String(ba.observation_id), '--agent', 'bai-research',
  '--rationale', "Choose $497,500 (net). MLB.com's tracker reports the net amount (gross minus the Dodgers' $2,500 per-pick accounting deduction) for 11 of 12 LAD picks in rounds 1-10; for pick 161 it reports $500,000, the gross figure in Dodgers Digest's 2016-07-18 table. Baseball-Reference and Baseball America both give $497,500. Keep $500,000 on record as the gross figure.",
  '--evidence', 'research/evidence/smeltzer-2016-bonus.json,https://dodgersdigest.com/2016/07/18/dodgers-sign-33-of-42-picks-from-2016-mlb-draft-avoid-losing-picks-by-524/,https://www.baseballamerica.com/stories/2016-draft-selections/'])
cli('proposals', [])
