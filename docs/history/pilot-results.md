# Historical importer pilot: 1965, 1985, 2005

Run locally on 2026-10-21 and replayed from a clean database on the same day, after the permission gates were added.
Nothing was imported to hosted.

**This public page carries no source-derived records.** It has no player names, no picks and no per-year selection
counts from MLB's feed or Baseball-Reference. Those stay in the restricted local outputs, under
`.restricted/history/` (gitignored and never deployed), and are backed up outside the repository:
- batches (`batches/<year>/`);
- build reports (`reports/<year>-build.json`);
- the exception register (`exceptions.json`).

The figures below are BAI's own measurements and judgments: club-phases, findings by kind, timings.

## Scope

- **1965 and 1985** covered limited clubs, chosen to exercise relocations and renames:
  - **1965:** LAD, the Kansas City Athletics (ATH) and the expansion Washington Senators (TEX), in the June regular and
    August Legion phases;
  - **1985:** LAD, ATH, TEX and the Montreal Expos (WSH), in all four phases.
- **2005** is the complete league-wide year: all 30 clubs.
- **Sources:** MLB's draft feed, the Chadwick register (pinned commit) and archived Baseball-Reference franchise-year
  pages (independent per-club lists).

## Results

| Year | Club-phases imported | Complete census (an independent list names the same people) | Partial reconstruction |
|---|---:|---:|---:|
| 1965 | 5 | 2 | 3 |
| 1985 | 16 | 15 | 1 |
| 2005 | 30 | 29 | 1 |

- **Identity and signing.** Every imported selection has its MLBAM identity, and every signing status is UNKNOWN (not
  researched; never "did not sign"). The pilot added no bonuses or outcomes.
- **Expected counts.** No year shows one, because no year has a census for every club that existed.
- **Throughput.** Measured locally on the full pipeline (stage, validate, dry run, apply and plan): 27–31 records per
  second.
- **Determinism.**
  - **Replay:** rebuilding the 51 batches offline from the cache twice gave byte-identical files.
  - **Against the original pilot:** after the gates were added, every record and claim is identical. The only change is
    that each batch now also cites the archived page used to corroborate it, so the gates can see it.
- **Checkpoints.** Re-running an applied year skips every batch.
- **Clean rebuild.** All 14 research runbooks plus the pilot passed, with 0 integrity violations. Local security,
  parity and pilot reconciliation all passed.

## Exceptions preserved for review (none resolved automatically)

`node scripts/history/exceptions.mjs` rebuilds the register from the restricted build reports. Each entry records:
- what each source claims;
- its effect on the import (held pick, partial class, numbering ignored for identity);
- what evidence would resolve it.

Every entry is `UNRESOLVED` until a person records a decision through the research pipeline.

| Entry | Kind | Effect on the import |
|---|---|---|
| EX-1965-JR-SAME-PERSON-650, -796, -811 | One MLBAM person at two picks of the 1965 June phase, by different clubs (three cases) | Later pick held out of its batch and listed in that club's coverage gap notes; the class is partial |
| EX-1985-JS-WSH-LIST | 1985 June secondary, Montreal: the independent list names two selections that MLB's feed lacks | Class partial; the extra names were not imported |
| EX-2005-JR-PHI-LIST | 2005 Philadelphia: one pick names a different player in each source | Class partial |
| EX-1965-JR-LAD-LIST, EX-1965-JR-ATH-LIST | 1965 surname spellings that differ between the sources (one each) | Class partial until a reviewer confirms the pair |
| EX-…-NAMES (7 entries, 171 pairs) | First-name variants at the same pick or round: nicknames and legal names, but also some genuinely different first names | Census check matched by surname only; a different person would withdraw that club's census |
| EX-1965-JR-NUMBERING, EX-1965-AL-NUMBERING | 1965 overall pick numbers differ between compilers (most matched picks) | Identity never uses pre-modern overall pick numbers |
| EX-1965-CENSUS-TOTAL | Wikipedia's stated 1965 total differs from MLB's feed | No expected count for 1965 |
| EX-…-CROSSWALK (7 entries) | MLBAM ids not in the Chadwick register (mostly picks who never played professionally) | Only the MLBAM id recorded; no other id guessed |

## Source quality

| Source | Strengths | Weaknesses found |
|---|---|---|
| **MLB draft feed** | Official; every phase since 1965; franchise-stable team ids; an MLBAM id for every pick; school labels | Can miss picks and can merge people (entries above); team names are today's; birth dates are rare before 2000; school labels are free text. **Terms:** individual, non-commercial, non-bulk use only without written authorization |
| **Chadwick register** | Open license (ODC-BY); pinned and reproducible; Baseball-Reference minors ids for most professionals | No match for many picks who never played professionally, especially in the 1960s–80s secondary phases |
| **Archived Baseball-Reference franchise-year pages** | Independent per-club lists; caught the missing-pick and different-player cases | Not every club-year is captured before 2005; older captures lose accented letters; the archive rate-limits. **Terms:** Sports Reference restricts automated use, so no further collection is allowed |
| **Wikipedia** | Dates with revision ids (CC BY-SA, facts only) | Totals and dates missing for many years; one total disagrees with MLB's feed |

## Benchmarks

Synthetic 1965–2026 database with 84,900 fictional selections (`npm run history:benchmark`,
`research/history/reports/benchmark.json`):

| Operation | Synthetic 84,900 |
|---|---:|
| Explorer page (default) | 35 ms |
| Explorer: name prefix / franchise range / year and round / school prefix | 19 / 20 / 13 / 30 ms |
| Explorer: deepest common case (page 100, "not researched") | 316 ms |
| `v_draft_year_coverage` (all phases, per request; internal, behind `rm_draft_year_coverage`) | 810 ms |
| `refresh_read_models()` | 3.1 s |

**Measurements on the pilot database**
- **Integrity check fix:** `UNSIGNED_ACQUISITION_CREDITED` took 552 s before the fix and 0.6 s after.
- **Hosted round trip** from this server: 110 ms.
- **Hosted pipeline throughput** from this server: about 0.07 records/s (the Wave 2 replay).
