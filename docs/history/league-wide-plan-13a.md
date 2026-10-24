# Phase 13A: non-Dodgers league-wide expansion (plan, pilot and gates)

Tracking: #33. Direction: BAI grows across the 29 non-Dodgers organizations; DISI remains the Dodgers international-signing specialist. Dodgers player-level work (issues #31 and #32) is paused and nothing about it is imported, changed or deleted here. Per-player and source-derived row artifacts stay in the gitignored `.local/history/` workspace; this page holds methodology and aggregates only.

## 1. Baseline (hosted, read-only audit)
- Migrations 001-027; three release audits (the 2020 release, its two-row supplement and the 2021 partial release); 0 certifications, 0 reviewers, 12 open fact conflicts (issue #27 stays separate).
- Draft: every one of the 29 clubs already holds a 2020 and a 2021 partial sample from the Wikipedia method (3-7 and 4-13 selections per club); coverage is PARTIAL_RECONSTRUCTION everywhere except cells set by earlier research phases. The six Wave 2 clubs (ATL, BAL, HOU, NYY, SD, TB) also hold 2016 draft and 2016-17 international records from earlier, MLB-derived research; those rows are a baseline that is not to be imported again, and their per-club counts stay local.
- International: only the six Wave 2 clubs (plus the Dodgers) hold signings, for 2016-17.
- Research classes are in DISCOVERY or COVERAGE_REVIEW; none is certified.

## 2. Two tracks compared
| | A: draft selections from the cleared Wikipedia + Chadwick + Wikidata method | B: deepen the six Wave 2 clubs (2017 next) |
|---|---|---|
| Sources | Wikipedia article revisions (catalog: fetch, repository and site publication cleared, facts with the revision id); Chadwick register (cleared); Wikidata (CC0) | the MLB transaction wire and Stats API, Baseball-Reference: publication PENDING or PROHIBITED in the catalog; only individually approved sources are usable, and none is approved |
| Reach | every club each year, opening picks in full plus an editor-chosen later-round sample | six clubs, discovered by rule from a restricted feed |
| Identity | MLBAM through Chadwick, corroborated by Wikidata; ambiguous cases held | same register, but the rows cannot be published |
| Verdict | **first batch** | blocked until a source is approved |

## 3. 2022 pilot (local only, nothing applied)
- Source revision 1374495794 of the 2022 draft article (states 616 selections). It lists 186 selections: the opening 80 picks contiguously and 106 editor-chosen later-round entries. Later rounds are therefore nonrepresentative and every club stays PARTIAL_RECONSTRUCTION.
- Tooling change: the article's later-round table puts round and pick on one line with `||`; the parser now splits inline cells outside links and templates (a fictional-fixture test covers it). Without this only 83 of the 186 rows were readable.
- Scope: Dodgers picks are excluded (5), by a new generic `--exclude-orgs` release option that the manifest records and `verify` enforces. No DISI-overlap player exists among the identities (screened against the earlier local reconciliation artifacts and BAI's own Dodgers signees; no DISI system was contacted).
- Identities (non-Dodgers, 181 rows): 148 verified, 29 single-source name-only, 4 ambiguous (held). The hosted collision preview classed 173 of the remaining 177 SAFE and 4 for human review: three would link an existing player by identifier (repeat draftees, needing owner approval as in 2020) and one shares a name with an existing player (held, never linked by name).
- The eight held picks (four ambiguous identities and four collisions) are outside the proposed 173-pick manifest and stay outside it. Releasing the already-safe 173 does not depend on them: each of the eight needs its own approval or identity decision (a repeat-draftee link, a reviewed identity, or a same-name decision) and would enter later as a separate supplement manifest.
- Release candidate: 173 selections in 29 clubs, 13 held (5 scope, 4 ambiguous, 4 collisions), signing status unknown for every row, no dates or bonuses, expected maxima players 173, external ids 439, observations 1,127 (enforced inside the apply transaction), sources 3.
- Disposable rehearsal (a copy of hosted in a throwaway PostgreSQL 17, nothing written to hosted). Exact counts before, after and after a second replay: draft selections 821, 994, 994; players 1,142, 1,315, 1,315; external ids 2,318, 2,757, 2,757; sources 171, 173, 173 (limit 3); source observations 9,742, 10,869, 10,869 (+1,127, exactly the manifest maximum); signings 456, 456, 456; release audits 3, 4, 4. Also: preview SAFE; wrong checksum and agent operator refused; the release audit records every outcome; integrity 0 violations; security OK; 29 clubs in scope partial and the excluded club carries no coverage claim. The rehearsal check is scope-aware and now asserts the observation, source and audit limits for every release.
- Public wording (applies only once rows are published; before that, no 2022 notice appears, and the explorer does not show the 2022 note for a 2022 filter until 2022 selections exist): the notice splits the absent selections into the ones the source does not list (a source gap: 430), Dodgers selections outside the release by scope (5, not a source gap), and listed selections held for identity or collision review (8, which shrinks as approvals are applied). It keeps the partial-coverage, nonrepresentative-later-rounds and no-rates warnings and never reads a missing selection as an unsigned player or a failed outcome.

## 4. Year-by-year plan for the remaining organizations
Each release is a separate checksum, a hosted collision preview, a disposable rehearsal and an owner authorization; none is partial-as-complete.
| Release | Slice | What is reachable | Work before it | Human decisions and gates |
|---|---|---|---|---|
| R1 | 2022 draft, 29 clubs | 173 now; up to 181 later, as supplements, if each of the eight held picks is approved | none beyond the owner's authorization of the 173-pick manifest | the eight held picks (three repeat-draftee links, one same-name case, four ambiguous identities) are not needed to release the 173; each needs an individual approval or identity decision before a later supplement |
| R2 | 2023 draft | 167 rows listed (614 stated): picks 1-71 contiguous plus 97 editor-chosen later-round entries; candidate of 157 non-Dodgers selections (section 7) | done in the candidate: the prospect promotion incentive pick imports as round code `PPI` (existing PRIZE phase, no schema change) | owner authorization of the candidate's checksum; apply the 2022 release first or hold the three cross-release repeat draftees (already held) |
| R3 | 2019, 2018, 2017 drafts | each article lists the first round, compensation and competitive-balance sections and a notable table | the article layout differs (top-level sections, no "Draft selections" heading): a parser variant | check overlap with the Dodgers cohorts already on hosted; same gates |
| R4 | 2024 and 2025 drafts | not yet fetched; expected to follow the 2023 layout | parser and PPI mapping from R2 | source check of each revision |
| R5 | 2020 and 2021 completion | the two partial releases exist; later-round gaps remain | a source for rounds 3-20 that BAI may use (licensed dataset, authorization or a lawful transcription plan) | rights decision; no census claim until population evidence exists |
| R6 | international, six Wave 2 clubs, 2017-18 | feed-derived only | an approved non-MLB source | owner approval of any source; no import otherwise |
Comparability: priority goes to the same slice across all clubs (R1-R4) over deeper single-club histories. Club comparisons must always be qualified by coverage; public rates stay disabled for partial and nonrepresentative cohorts, and no certification or efficiency figure is published.

## 5. Source rights
| Source | Use | State |
|---|---|---|
| Wikipedia article revisions | selections, rounds, schools, positions (facts with the revision id) | cleared for fetch, repository and site |
| Chadwick register | identifiers and birth dates | cleared |
| Wikidata | identity corroboration | CC0, cleared |
| MLB Stats API / transaction wire | restricted | fetch pending, publication pending or prohibited |
| Baseball-Reference | restricted | publication prohibited |
| DiamondIQ public page | data via the MLB Stats API | not relicensable by BAI; not used |

## 6. Blockers before any hosted release
Owner authorization naming each manifest checksum and the hosted target (for R1, the 173-pick manifest needs nothing else; the eight held picks are individual approvals for later supplements); the PPI round mapping and the layout parser variant for R2-R4; a usable source for any later-round or international expansion. Nothing is merged, migrated, imported or deployed by this phase.

## 7. 2023 candidate (Phase 13B; local only, nothing applied)
- **Source:** revision 1373809063 of the 2023 draft article (states 614). It lists 167 selections, reconciled exactly: 70 in the opening tables (picks 1-70, contiguous: 28 first round, 1 prospect promotion pick, 10 + 6 competitive balance, 22 second round, 3 compensatory) plus 97 in the editors' "Other notable selections" table (picks 71-610). Pick 71, the third round's first selection, is the first row of that table, which is why the picks run contiguously through 71 although only 70 come from the opening tables. Later rounds are nonrepresentative and every club stays PARTIAL_RECONSTRUCTION.
- **Prospect promotion incentive pick (PPI):** the 2022 CBA adds one pick for a club whose prospect wins Rookie of the Year (or an equivalent award). The article lists it between the first round's numbered picks and Competitive Balance Round A. BAI already has the `PRIZE` round phase and selection type, and `draft_rounds.round_code` is free text, so no schema change is needed: it imports as the published round code `PPI`, phase PRIZE, selection type PRIZE, ordered after round 1 and compensation and before Competitive Balance A. The parser recognises the section title, the importer and the explorer's round filter accept the code, and a database test shows the phase and ordering. Before this the section was an unknown section and its pick was silently dropped.
- **Scope:** all 30 clubs, the Dodgers included. A Dodgers draft selection is an ordinary draft row; DISI's authority is over Dodgers international signings, and nothing in the draft release touches them.
- **Identities (167 listed):** 136 verified, 30 single-source name-only, 1 ambiguous (held); none overlaps DISI's Dodgers set or BAI's own Dodgers signees (an overlap would not exclude a draft pick in any case). The hosted collision preview classed 161 of 163 buildable rows SAFE and 2 for review (one repeat-draftee link by identifier, one same-name player); both are held.
- **Cross-release repeat draftees:** three players are unsigned 2022 selections drafted again in 2023. Built independently against hosted, each 2023 pick looked new; applied after the 2022 release the second selection collides with the first and the apply refuses until a person approves the link. The three 2023 selections are therefore held in the candidate (`--hold-picks`) and enter later as a supplement with individual approvals. A rehearsal-only supplement (clearly labelled fixture approvals, not owner approvals) shows the mechanism: 3 selections added to the existing players, no new player, no duplicate identity.
- **Candidate manifest `b4d5683acd801d547b292d1761b0a3de7e3ff8d5d385eaa3ea0a07662d159a96`:** 161 selections in 30 clubs (132 verified identities, 29 name-only), 6 held (1 ambiguous identity, 2 collisions, 3 cross-release), signing status unknown for every row, no dates or bonuses; expected maxima players 161, external ids 345, source observations 1,040, sources 3. It replaces the earlier 157-selection candidate, which wrongly excluded the Dodgers; that manifest stays as an immutable local file.
- **Public wording:** 2023 is declared (614 documented, picks 1-70 listed in full), with the source-gap / held split, shown only once 2023 rows exist.
- **Recommended next release:** R1 (the 2022 candidate), then this one, then its three-pick supplement after individual approvals; R3 (the 2017-2019 layout) after a parser variant.
