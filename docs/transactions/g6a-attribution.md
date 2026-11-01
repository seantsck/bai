# G6A: Retrosheet attribution on the website, and the Data API

Retrosheet's notice (https://www.retrosheet.org/notice.txt) requires its statement to appear prominently wherever its data is used. The grant row (`ingest.source_publication_grants`) is conditioned on that.

## What the website shows (this change)
| Page | Retrosheet-derived content | Statement |
|---|---|---|
| `/transactions`, `/transactions/[id]`, `/transactions/coverage` | the transaction ledger | already shown (published groups, or the record's own groups) |
| `/players`, `/players/[slug]` | 3,643 players (name, birth date) that exist because a Retrosheet transaction names them; 7,286 field observations | **added**: shown while Retrosheet is published, and while that is unknown |
| `/sources` | the group table and the credit | now always shown in the prominent box; the stale text "not shown on this site yet" is removed |
| other pages | none | not shown (organizations, draft, compare, research, home counts are not Retrosheet-derived) |

`lib/attribution.ts` holds the one verbatim constant (tests keep it identical to the migration-030 seed and the importer), and `requiredStatements` decides what a page owes: published groups only, every statement when the totals are unavailable, never silently none.

## Direct REST exposure (measured on the full-size promoted copy, anon role)
`anon` and `authenticated` read `players` (+3,643), `source_observations` (+7,286 Retrosheet-sourced: `players.full_name`, `players.birth_date`), `coverage_assessments` (+360), `sources` (the Retrosheet row, whose `notes` carry the statement) and `v_source_attribution` (Retrosheet: 11,257 transaction records, 7,286 observations). The transactions tables and every `rm_*` table are closed to them. A PostgREST response cannot display a statement, so what a direct caller receives is Retrosheet-derived data with the statement only reachable by following `source_id` to `sources.notes`: not "prominent", and not enforceable.

## Recommended policy (needs a decision; not implemented here, it needs a new migration)
1. **Enforce by access, not by hope:** the website role (`bai_site`) is the only role that displays Retrosheet-derived records, and every page it serves carries the statement (this change plus the tests). 
2. **Close the direct path to the Retrosheet-sourced rows:** a restrictive row-level policy for `anon` and `authenticated` on `source_observations` and `coverage_assessments` (rows whose source category is RETROSHEET), and the `sources` row stays readable (it holds the statement and the notice). `bai_site` keeps reading them.
3. **Players are the open question:** the 3,643 Retrosheet-created `players` rows carry no source column, so a policy cannot tell them apart without a marker. Either accept that identity rows (names and birth dates, matched through the Chadwick Register) are served by REST with the statement in `sources.notes`, or add a provenance marker and hide them from the Data API roles. This is a rights decision, not a technical one.
4. Chadwick (ODC-By 1.0) has the same property: the ids are credited on `/sources` only.

Until 2 is decided, a release that promotes Retrosheet data publishes the Retrosheet-sourced observations to the Data API.
