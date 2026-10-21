# Sources behind the records on hosted BAI

A read-only report of which sources contributed to the records already on the hosted database, which the public site
reads. It was generated on 2026-10-21 by `npm run hosted:provenance`, which runs in a `READ ONLY` transaction. **No
hosted record was changed or deleted.**

**Context.** Hosted BAI holds:
- the LAD research program (2015–2019 drafts and the 2015–2018 international classes);
- Wave 2 (six clubs' 2016 drafts and 2016-17 international candidates);
- the reference calendars and franchise data.

The historical importer has contributed **nothing**: 0 `hist:` sources. On the same day, hosted matched `main`'s
migrations exactly (`hosted:parity` from a clean `main` checkout: 0 differences). Migration 024 is not deployed.

## Contributions by source category

"Rows citing it" counts rows in every table with a `source_id` column, where the source is that row's primary citation.
"Publicly readable" counts those the `anon` role (the public site) can select. "Field observations" counts
per-field claims in `source_observations`.

| Category | Sources | Hosts | Rows citing it (primary) | Publicly readable | From the historical importer | Field observations | Main tables |
|---|---:|---|---:|---:|---:|---:|---|
| MLB_STATS_API | 40 | statsapi.mlb.com | 2755 | 2755 | 0 | 5113 | player_external_ids 1372, draft_selections 456, international_signings 297, outcome_audit_details 166 |
| SPORTS_REFERENCE | 16 | www.baseball-reference.com | 1128 | 1128 | 0 | 1987 | draft_signings 455, war_observations 354, schools 319 |
| MLB_EDITORIAL | 43 | m.mlb.com, www.mlb.com | 69 | 69 | 0 | 137 | slot_values 43, drafts 12, international_signing_periods 11, rules_eras 3 |
| BAI_REFERENCE | 1 | www.mlb.com | 30 | 30 | 0 | 0 | organization_names 30 |
| NEWS_MEDIA | 38 | dodgerblue.com, dodgersdigest.com, masnsports.com, mlbtraderumors.com, … | 14 | 14 | 0 | 79 | slot_values 12, rules_eras 2 |
| BASEBALL_AMERICA | 9 | baseballamerica.com, www.baseballamerica.com | 1 | 1 | 0 | 87 | international_signing_periods 1 |
| FANGRAPHS | 2 | blogs.fangraphs.com | 1 | 1 | 0 | 2 | rules_eras 1 |
| WIKIPEDIA | 13 | en.wikipedia.org | 0 | 0 | 0 | 23 |  |
| OTHER | 1 | mlb.com | 0 | 0 | 0 | 1 |  |
| CHADWICK | 2 | github.com | 0 | 0 | 0 | 0 |  |

**Category rules.** The script assigns each source to the first category it matches, in this order:
1. **`BAI_REFERENCE`:** by type.
2. **`MLB_STATS_API`:** `statsapi.mlb.com`, or a title naming the Stats API or the transaction wire.
3. **`MLB_EDITORIAL`:** other `mlb.com` and `milb.com` pages.
4. **`SPORTS_REFERENCE`:** `baseball-reference.com`, Sports Reference as publisher, or Internet Archive captures of
   either.
5. **Single publishers:** FanGraphs, Baseball America, Wikipedia, Chadwick.
6. **`NEWS_MEDIA`:** other news reports.

Run `npm run hosted:provenance -- --json` for the full breakdown by table.

## Questions for review

These are publication and license questions only a person can decide. Nothing is removed or hidden automatically.

1. **MLB Stats API: the largest contributor.**
   - **Records:** draft selections, international signings, player ids, outcomes, and the transaction-wire dates behind
     LAD and Wave 2.
   - **Collection:** per class (a handful of requests each), not in bulk.
   - **The question:** the terms permit "individual, non-commercial, non-bulk use" without written MLBAM authorization.
     Is BAI's public display of these records within that?
   - **If not:** the options are authorization, or restricting display. The latter could use a per-source display flag
     in the public views, with a reviewed migration.
2. **Sports Reference (Baseball-Reference).**
   - **Records:** signing rows (bonuses), WAR observations and school records, from Baseball-Reference pages and their
     archive captures.
   - **The question:** Sports Reference's terms restrict automated collection and reuse. Are these facts, cited one page
     at a time, acceptable to display, and should any be re-sourced?
   - **WAR:** it is Baseball-Reference's own derived statistic. That is the strongest case for attribution or
     re-sourcing.
3. **Baseball America and news media.** These are facts with links (bonuses, dates). Confirm no article text, rankings or
   tables are reproduced.
4. **MLB.com editorial.** Slot values, calendars and rules eras are facts cited with links; confirm the same.
5. **Attribution on public pages.** No page credits its sources yet:
   - Wikipedia needs credit where its facts are shown;
   - Chadwick, once its ids are shown publicly (ODC-BY; none are on hosted yet);
   - FanGraphs and Baseball-Reference, if their values stay.

## Repository counterpart

These hosted records were imported from batches committed on `main` under `research/imports/` (34 files citing MLB or Baseball-Reference, plus the pilot baseline), with runbooks
and evidence. `npm run history:publication-check -- --notices` lists them as files citing MLB or Baseball-Reference
outside the history catalog. They predate the permission gates and are part of the same review. They were not removed,
because they are the reproducible record of what is on hosted. Removing them would not unpublish them either (see
[publication-audit.md](publication-audit.md)).
