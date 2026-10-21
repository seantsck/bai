# Historical importer pilot: 1965, 1985, 2005

Run locally on 2026-10-21. Nothing was imported to hosted.

**Scope.**
- 1965 and 1985 covered limited clubs, chosen to exercise relocations and renames:
  - **1965:** LAD, the Kansas City Athletics (ATH) and the expansion Washington Senators (TEX).
  - **1985:** LAD, ATH, TEX and the Montreal Expos (WSH), in all four of its phases.
- **2005** is the complete league-wide year: all 30 clubs.

Build reports (per phase, with every finding) are in `research/history/reports/<year>-build.json`, and import timings in
`<year>-import-timings.json`. Every source file used is listed with its checksum in `research/history/manifest.json`.

## Results

| Year | Phase | In MLB's feed | Clubs | Imported (pilot clubs) | Held | Independent check (clubs agreeing) | Crosswalk to Chadwick |
|---|---|---:|---:|---:|---:|---|---:|
| 1965 | June regular | 824 picks (821 people) | 20 | 103 (3 clubs) | 3 league-wide (none at pilot clubs) | 1 of 3 | 685 / 824 |
| 1965 | August Legion | 13 | 8 | 3 (2 clubs) | 0 | 1 of 1 | 6 / 13 |
| 1985 | June regular | 832 | 26 | 121 (4 clubs) | 0 | 4 of 4 | 796 / 832 |
| 1985 | January regular | 330 | 26 | 53 | 0 | 4 of 4 | 242 / 330 |
| 1985 | January secondary | 69 | 26 | 10 | 0 | 4 of 4 | 54 / 69 |
| 1985 | June secondary | 104 | 26 | 18 | 0 | 3 of 4 | 54 / 104 |
| 2005 | June regular | 1,501 | 30 | 1,501 (30 clubs) | 0 | 29 of 30 | 1,498 / 1,501 |

**Every imported selection** has its MLBAM identity. Its signing status is UNKNOWN (not researched, never "did not
sign"). The pilot added no bonuses or outcomes.

**What was claimed.**
- **Complete census** (both sources list the same people): 46 of the 51 club-phases imported (1965: 2, 1985: 15, 2005: 29).
- **Partial reconstruction:** 5 club-phases, each with its reason in the coverage gap notes: 1965 LAD and ATH June, 1965
  ATH August (no independent page), 1985 WSH June secondary, 2005 PHI.
- **Expected count:** no year shows one, because no year has a census for every club that existed.

**Throughput.** Measured locally on the full pipeline (stage, validate, dry run, apply and plan): about 25–30 records per
second.

## What the pilot found

These are specific findings that need human review. None was resolved by preferring a source.

1. **One person listed twice in a phase (1965 June).** MLB's feed lists three people at two picks each, by different
   clubs:
   - Steven Kokor: #554 Twins, #650 Tigers;
   - Glen Borkhuis: #658 Pirates, #811 Astros;
   - Glenn Wallace: #695 Braves, #796 Orioles.

   Each is either one person picked twice (an error in the feed) or two people merged under one MLB id. The later picks
   are held out of the batches and listed in the reports.
2. **MLB's feed is missing picks (1985 June secondary, Montreal).** MLB lists 4 selections and Baseball-Reference 6.
   Louis Calvert (#58) and Frank Taylor (#77) are not in MLB's feed. This is exactly why one feed's rows are never
   treated as the population.
3. **Different players at the same pick (2005 Phillies #1322).** MLB has Christopher Siewert and Baseball-Reference has
   Luis Alvarez. The Phillies' 2005 class stays partial until it is resolved.
4. **Surname spellings.** These stop a census claim until a reviewer confirms the pair:
   - 1965 Dodgers: Paul Dennenbaum (MLB #170) / Paul Dennebaum (B-Ref #183);
   - 1965 Athletics: Gary Shephard / Gary Shepard.
5. **First-name variants.** 171 are recorded for review: nicknames and legal names (James/Jim, Joseph/Joe), but also
   different first names on the same surname and pick, such as 1965 Dodgers Gary vs Larry Griffith and Rod vs Frank Austin.
6. **Pick numbering differs in old drafts.** In 1965, 78 of the 103 checked picks carry different overall numbers in
   MLB's feed and on Baseball-Reference; they agree for 1985 and 2005. Identity therefore never relies on overall pick
   numbers before the modern era.
7. **Wikipedia's 1965 total disagrees.** It states 813 players selected, against MLB's 824 picks (821 people). The
   difference is recorded on the calendar source, not resolved.

## Source quality

| Source | Strengths | Weaknesses found |
|---|---|---|
| **MLB draft feed** | Official; every phase since 1965; franchise-stable team ids; an MLBAM id for every pick; school labels | Can miss picks (finding 2) and can merge people (finding 1); team names are today's; birth dates are rare before 2000 (19% in 1965, 40% in 1985, 99.9% in 2005); school labels are free text (56–89% carry an explicit type word, by phase) |
| **Chadwick register** | Open license; pinned and reproducible; Baseball-Reference minors ids for most professionals | No match for picks who never played professionally (83% matched in 1965, 52% in the 1985 June secondary phase, 99.8% in 2005); FanGraphs and B-Ref major-league ids only for major leaguers |
| **Archived Baseball-Reference franchise-year pages** | Independent per-club lists; caught findings 2 and 3 | Not every club-year is captured (all 30 for 2005, only some for 1965 and 1985); older captures lose accented letters; terms restrict automated use; the archive rate-limits (HTTP 429/504) |
| **Wikipedia** | Dates with revision ids | Totals and dates missing for many years; a total disagrees with MLB (finding 7) |

## Benchmarks

**Pilot database** (2,265 selections) and a **synthetic 1965–2026 database** (84,900 selections, `npm run history:benchmark`,
`research/history/reports/benchmark.json`):

| Operation | Pilot | Synthetic 84,900 |
|---|---:|---:|
| Explorer page (default) | — | 35 ms |
| Explorer: name prefix / franchise range / year and round / school prefix | — | 19 / 20 / 13 / 30 ms |
| Explorer: deepest common case (page 100, "not researched") | — | 316 ms |
| `v_draft_year_coverage` (all phases, per request; now internal) | — | 810 ms |
| `refresh_read_models()` | 2 s | 3.1 s |
| Integrity check `UNSIGNED_ACQUISITION_CREDITED`, before the fix | **552 s** | — |
| The same check after the fix | 0.6 s | — |
| Hosted round trip from this server | 110 ms | — |
| Pipeline throughput: local | 25–30 records/s | — |
| Pipeline throughput: hosted from this server | ≈ 0.07 records/s (Wave 2 replay) | — |

**Integrity check fix.** The check referenced the trade-return column of `analytics.acquisition_value`, which forced the
view's trade-returns join for every acquisition. It now leaves that column out; the trade gate is pinned by the
value-attribution tests.

**Draft-years page.** It reads `rm_draft_year_coverage`, refreshed offline.
