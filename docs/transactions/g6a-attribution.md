# G6A: Retrosheet attribution on the website, and the Data API

Retrosheet's notice (https://www.retrosheet.org/notice.txt) requires its statement to appear prominently wherever its data is used. The grant row (`ingest.source_publication_grants`) is conditioned on that.

## What the website shows
`lib/attribution.ts` holds the one verbatim statement and the notice link as constants (tests keep it identical to the migration-030 seed, the importer and the history catalog). Retrosheet's box is rendered **from those constants only**: no database read can remove it.

| Page | Retrosheet-derived content | Rule |
|---|---|---|
| `/players`, `/players/[slug]` | 3,643 players (names, birth dates) that exist because a Retrosheet transaction names them | **unconditional**, independent of read-model refresh and of the attribution tables |
| `/sources` | the group table and credit | unconditional |
| `/transactions` | the ledger | owed unless the page proves none is shown: shown when any displayed row names it (`rm_transactions.attribution_required`), when the overview lists it as published, **or when the overview is unavailable** |
| `/transactions/[id]` | one record | follows the record's own `source_categories`; an unknown set counts as Retrosheet; independent of the overview and of the statements lookup |
| `/transactions/coverage` | aggregates of the published rows | owed when any season or club-season figure is positive, when a read failed, when the overview is unavailable or lists it |
| other pages | none | none |

Why not the overview alone: after a promotion the overview (a read model, refreshed separately) can lag, while the promoted players are already publicly readable. Page tests (`tests/app/attribution-pages.test.mjs`) render the real pages against PostgreSQL as the website role and cover: a Retrosheet player visible before any refresh; the attribution lookup failing; the overview unavailable; the overview stale with no authorized categories; the detail lookup failing; and the baseline with no historical transaction publication (no statement, no rows on the transaction pages).

## Direct REST exposure (measured on the full-size promoted local copy, `anon`)
`anon` and `authenticated` read `players` (+3,643), `source_observations` (+7,286 Retrosheet-sourced: `players.full_name`, `players.birth_date`), `coverage_assessments` (+360), `sources` (the Retrosheet row; its `notes` carry the statement) and `v_source_attribution` (Retrosheet: 11,257 transaction records, 7,286 observations). The transactions tables and every `rm_*` table are closed to them. A REST response cannot display a statement: a direct caller gets Retrosheet-derived data and can only find the statement by following `source_id` to `sources.notes`. That is not prominent and not enforceable.

## Options for the Data API (a decision and a new migration are needed; nothing is implemented here)
Row-level security alone is **not** a confidentiality boundary here: G5 tests showed that `Prefer: count=planned|estimated` returns planner statistics that include rows a policy hides (the hidden rows are live rows, so `ANALYZE` does not help). A restrictive policy would therefore stop reading the rows but still disclose how many exist.

| Option | Mechanism | Closes reads | Closes planned/estimated counts | Effect on existing baseline records and consumers |
|---|---|---|---|---|
| A. Deny `SELECT` to `anon`/`authenticated` on the affected tables; grant it explicitly to `bai_site` | `revoke select`; `grant select to bai_site` | yes | yes (a denied table answers 401/403 in all three count modes; G5-5B/5F verified this for the emergency close) | **Removes the table from the Data API for everyone**, including the 1,612 baseline players, 3,318 baseline ids, 12,732 baseline observations, 175 coverage rows and 177 sources: any public REST consumer of those loses them. The website keeps working (it reads as `bai_site`). Also closes the views over them (`v_source_attribution`, the draft explorer views) as seen in the emergency close-api exercise. |
| B. Split exposure: leave the existing tables as they are and publish a separate, deliberately filtered API surface (views or a schema owned and granted explicitly) for the Data API roles, with Retrosheet-derived rows omitted or carrying the statement in every row | new objects; `revoke` on nothing existing | for the new surface | the surface is a view: its counts come from the view's plan, which still estimates from the underlying table unless the surface is a materialized/table copy | Baseline consumers keep their URLs only if the old names are preserved on the new surface; a copy is needed to make counts honest. More objects to keep in step with the base tables. |
| C. Accept exposure with the statement in `sources.notes` and a documented REST terms note | none | no | no | No change for anyone. Does not meet "prominently wherever its data is used" for direct REST callers; needs Retrosheet's agreement or an owner risk acceptance. |
| D. Restrictive RLS on the Retrosheet-sourced rows only | `create policy ... as restrictive` | rows of `source_observations`/`coverage_assessments` only | **no**: planned/estimated counts still include the hidden rows | Baseline records unaffected. Not sufficient on its own; usable only together with A or B. |

Recommendation to evaluate: **A for `source_observations` and `coverage_assessments`** (the tables whose Retrosheet rows are source-attributed) if the owner accepts that those two tables leave the public REST surface, with `bai_site` granted explicitly; otherwise B. D is not to be used alone. Whichever is chosen is a migration plus a re-run of the G5 REST count tests (exact, planned, estimated, views).

**Update (G6B):** the owner chose Option A for the raw identities and evidence; migration 033 and its tests are described in `g6b-rest-boundary.md`. The decisions below that 033 settles are marked.

## Unresolved owner decisions
1. **The 3,643 Retrosheet-created player identities.** `players` has no source column, so no policy can single them out, and `players`/`player_external_ids` also hold the 1,612/3,318 baseline rows that public consumers use today. Either (i) accept that REST serves these identity rows (names and birth dates matched through the Chadwick Register), with the statement on every website page and in `sources.notes`; (ii) add a provenance marker (a migration) so that A/B can treat them separately; or (iii) close `players` and `player_external_ids` to the Data API as in A, with the baseline impact above. This is a rights decision, not a technical one.
2. Which of A, B, C the project adopts for `source_observations` and `coverage_assessments`, and whether the Data API remains a supported public interface at all.
3. Chadwick (ODC-By 1.0) has the same property for the ids: it is credited on `/sources` only. Not changed here.

Until these are decided, promoting the Retrosheet data publishes the Retrosheet-sourced observations and identities to the Data API.
