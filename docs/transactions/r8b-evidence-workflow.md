# R8B evidence-workflow pilot (local only)

**A package is a research PROPOSAL, never a verification.** It records what BAI already holds about one published trade and what a researcher found; a human reviewer decides everything. Packages and the PTBNL triage view are source-derived work products: they are written to a new directory **outside every git work tree** (mode 700/600) and never committed. Nothing here reads or writes a source's article text.

```
node --env-file=<hosted env> scripts/research/r8b-evidence.mjs init     --queue <queue csv> --count 10 --out <new dir>
node --env-file=<hosted env> scripts/research/r8b-evidence.mjs validate --dir <dir>
node --env-file=<hosted env> scripts/research/r8b-evidence.mjs triage   --queue <ptbnl queue csv> --out <new dir>
```
The database session is forced read-only; `init` and `triage` read the published read model only. Candidates are added by editing the package JSON (or `savePackage`); every write is validated first (`lib/r8b-evidence.mjs`).

## What a package records
Transaction identity, date, clubs and assets (from BAI); origin source and its independence group (Retrosheet, one group); candidate second sources (publisher, title, URL, role, locator, retrieval date, how it was found, whether the page text was actually read); the source-rights status; an independence assessment; package-level and asset-level coverage; gaps; recommended human action; and the unresolved claims.

## Rules the validator enforces
* `human_verification` and `human_reviewer` are null. Coverage statuses are `UNRESOLVED | UNSUPPORTED | PARTIAL | PROPOSED_CORROBORATED`; independence is `UNASSESSED | LIKELY_DERIVED | LIKELY_INDEPENDENT`. `CORROBORATED`, `VERIFIED_COMPLETE` and "confirmed" are not expressible.
* The source category is **derived from the host** (`mlb.com` -> MLB, `baseball-reference.com` -> BASEBALL_REFERENCE, `wikipedia.org` -> WIKIPEDIA, otherwise OTHER_PUBLICATION) and cannot be declared; the display consequence follows from it.
* Retrosheet, Baseball-Reference and the Chadwick register are never `LIKELY_INDEPENDENT` (partly derived from the origin). `LIKELY_INDEPENDENT` needs a lineage note and a group other than the origin.
* Every package side and every asset has an entry; an unresolved one stays `UNRESOLVED` and cannot cite candidates; a coverage claim must cite a candidate.
* No field named text/excerpt/quote/body; fields are length-bounded; URLs are https, without credentials; the retrieval date is real; `found_by` says how.

## PTBNL triage
One row per unresolved player-to-be-named asset: the question to answer ("who was named", or "who, or cash, and how much if disclosed"), the clubs and date window as search hints (not evidence), whether the asset may resolve as cash, whether other cash is unknown, the action (`RESOLVE_PLAYER` / `RESOLVE_PLAYER_OR_CASH`) and priority (P1A / P1B). The named player must already exist in BAI `players`; a missing player is a separate identity task.

## Pilot result (10 clean trades, ranks 1-10 of queue 2; 2026-11-06)
23 candidate sources: MLB 9, OTHER_PUBLICATION 13, WIKIPEDIA 1. 21 are `LIKELY_INDEPENDENT` of the Retrosheet origin on the evidence visible (club announcements and contemporaneous press), 2 `UNASSESSED`. Only one page could be read (MLB.com refuses automated fetching and no workaround was attempted), so 36 of 40 coverage cells are `PARTIAL` and 4 are `PROPOSED_CORROBORATED`. **None of the 10 has a rights-cleared independent candidate:** linking any of them would take the transaction out of the public read model until permission exists. Findings for a human: two date mismatches against the record (a one-day difference between the announcement and BAI's date), one probably re-post date, and one report of salary coverage that BAI does not record as an asset.
