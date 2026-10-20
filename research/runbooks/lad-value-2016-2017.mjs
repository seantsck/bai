// LAD 2016 and 2017 draft classes: organizational value (migration 022), researched 2026-10-20. Adds Baseball-Reference
// season-by-team WAR for the 26 audited players who reached MLB (Ryan Watson debuted in 2026: no complete-season page),
// both sides of the 19 trades that sent class players away (with the received players' WAR), and outcome audits of
// the 5 received players without an MLB debut. Run after the class runbooks.
//   node --env-file-if-exists=.env.local research/runbooks/lad-value-2016-2017.mjs
//
// Built with scripts/research/sources/: fetch-bref-player-pages.mjs (43 Wayback captures taken before 2026-03-25),
// bref-season-war-import.mjs, trades-from-wire.mjs (MLB wire per trade date; Chadwick register 781c175e for ids).
import { cli, lookup, refresh } from './run.mjs'

const R = 'bai-backfill-research'
const run = (cmd, args) => cli(cmd, args, { operator: R })
const ingest = (file, key, cls) => {
  run('import', ['--file', file, '--org', 'LAD', ...(cls ? ['--class', cls] : [])])
  run('validate', ['--batch', key])
  run('apply', ['--batch', key])
  run('apply', ['--batch', key, '--write'])
}
ingest('research/imports/2016-draft-lad-war-seasons.json', '2016-draft-lad-war-seasons', 'LAD/DRAFT/2016-JUNE_AMATEUR')
ingest('research/imports/2017-draft-lad-war-seasons.json', '2017-draft-lad-war-seasons', 'LAD/DRAFT/2017-JUNE_AMATEUR')
ingest('research/imports/lad-trades-2016-2017-classes.json', 'lad-trades-2016-2017-classes')
ingest('research/imports/lad-trade-returns-no-mlb.json', 'lad-trade-returns-no-mlb')

// Connor Wong: career bWAR through 2025 is 3.3 on the 2026-01-05 draft-page capture and 3.6 on his 2026 player-page
// capture. The conflict stays open; a proposal asks the reviewer to prefer the later capture (B-Ref revises WAR).
const wong = await lookup(`select o.id as observation_id, o.subject_id from public.source_observations o join public.sources s on s.id = o.source_id
  join public.war_observations w on w.id = o.subject_id join public.player_external_ids x on x.player_id = w.player_id and x.id_system = 'MLBAM'
  where o.subject_table = 'war_observations' and o.field_name = 'war_value' and x.external_id = '657136' and w.scope = 'CAREER' and w.through_season = 2025
    and s.source_key = 'lad:bref-player-pages-pre2026'`)
cli('propose', ['--table', 'war_observations', '--id', String(wong.subject_id), '--field', 'war_value', '--observation', String(wong.observation_id), '--agent', 'bai-research',
  '--rationale', "Prefer 3.6, the later capture of the same seasons (player page, early 2026) over 3.3 (draft page, 2026-01-05): Baseball-Reference revises WAR between captures, and the player page's season splits sum to 3.6.",
  '--evidence', 'research/imports/2017-draft-lad-war-seasons.json'])
for (const y of ['2016', '2017']) run('plan', ['--org', 'LAD', '--channel', 'draft', '--year', y])
refresh()
