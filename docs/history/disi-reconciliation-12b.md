# DISI ↔ BAI evidence verification (Phase 12B): method and aggregate findings

Tracking issue: #28; follows `disi-reconciliation-12a.md`. Read-only: no database was written (hosted or local), nothing was imported, DISI was read only as a local restore of its committed lineage (uncommitted migration-053 work excluded). Candidate-level evidence, source citations and the import plan stay in the gitignored `.local/reconciliation/disi-bai/phase12b/` workspace.

## Method
For the 13 Dodgers international signings present in both systems, each Phase 12A difference was re-examined against sources read in this phase: Wikipedia revisions (cleared for facts with the revision id), a CBS Los Angeles article and an MLB Trade Rumors page that could be read in full, and search-result summaries where pages blocked automated reading (HTTP 403 for Baseball America and Dodgers Digest; no workaround was attempted). Per BAI policy a value seen only in a search tool's paraphrase is a lead, not a record. For each proposed fact the register separates public accessibility, whether it could be read, and whether BAI may publish a fact from it.

## Findings (aggregate)
- **Missing bonuses (4):** one verified from two pages read in full; one lead only because no page stating the amount could be read; one genuine disagreement between publishers (BAI already notes one figure as unverified) which is excluded as a single value; one remains excluded (a secondary Wikipedia statement now exists, not primary evidence).
- **Signing-date conflicts (2):** one is a difference in date semantics (an agreement reported on the last day of one period versus the MLB transaction date in the next), which BAI already models with an agreement-reported-date observation; the other favours BAI's date (Wikipedia, citing the Los Angeles Times, agrees with it) and is a DISI review candidate.
- **Pathway conflicts (2):** both are vocabulary. BAI's amateur/professional distinction records pool status (age and experience); DISI's pathway labels record league experience. DISI's own record agrees with BAI for one of them; the other has no sourced pool-treatment statement.
- **DISI records without a date (7):** five are supported by a dated club announcement equal to BAI's existing date; two are agreement reports BAI already holds. Their DISI signing date stays UNKNOWN.
- **The 35-row expansion** consists of two opening-day classes (22 and 13 players), each a bounded announcement of the opening of its period, not a census of the signing period; the full periods have no known size. The "complete census" label must not be carried into BAI.
- **Duplicates:** two of the candidate facts already exist in BAI as observations and must be skipped; the others would be new observations on existing rows.

## Rights
Publication of facts from Wikipedia revisions is cleared by the catalog. News publishers and Baseball America are unreviewed (their terms could not be read automatically); MLB-derived facts are blocked pending authorization. Public accessibility is not publication permission.

## Recommendation
A Phase 12C of at most three facts on two existing signings, conditional on (1) the owner's decision about the news-publisher precedent and (2) a person reading one source for a lead. Everything else waits for evidence or a rights decision. Unresolved decisions are listed in the local decision register.
