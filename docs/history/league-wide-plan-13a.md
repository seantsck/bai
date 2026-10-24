# Phase 13: league-wide draft expansion, all 30 clubs (plan, pilot and gates)

Tracking: #33. Direction: BAI covers the MLB amateur draft for all 30 clubs, the Dodgers included; DISI remains authoritative for Dodgers international signings, and Dodgers draft selections are ordinary draft rows (a player's appearance in DISI is not a reason to leave a draft pick out). The paused Dodgers international items (issues #31 and #32) are untouched, and nothing already on hosted is imported again, changed or deleted here. Per-player and source-derived row artifacts stay in the gitignored `.local/history/` workspace; this page holds methodology and aggregates only.

## 1. Baseline (hosted, read-only audit)
- Migrations 001-027; three release audits (the 2020 release, its two-row supplement and the 2021 partial release); 0 certifications, 0 reviewers, 12 open fact conflicts (issue #27 stays separate).
- Draft: every one of the 29 clubs already holds a 2020 and a 2021 partial sample from the Wikipedia method (3-7 and 4-13 selections per club); coverage is PARTIAL_RECONSTRUCTION everywhere except cells set by earlier research phases. The six Wave 2 clubs (ATL, BAL, HOU, NYY, SD, TB) also hold 2016 draft and 2016-17 international records from earlier, MLB-derived research; those rows are a baseline that is not to be imported again, and their per-club counts stay local.
- International: only the six Wave 2 clubs (plus the Dodgers) hold signings, for 2016-17.
- Research classes are in DISCOVERY or COVERAGE_REVIEW; none is certified.

## 2. Two tracks compared (the draft track covers all 30 clubs)
| | A: draft selections from the cleared Wikipedia + Chadwick + Wikidata method | B: deepen the six Wave 2 clubs (2017 next) |
|---|---|---|
| Sources | Wikipedia article revisions (catalog: fetch, repository and site publication cleared, facts with the revision id); Chadwick register (cleared); Wikidata (CC0) | the MLB transaction wire and Stats API, Baseball-Reference: publication PENDING or PROHIBITED in the catalog; only individually approved sources are usable, and none is approved |
| Reach | every club each year, opening picks in full plus an editor-chosen later-round sample | six clubs, discovered by rule from a restricted feed |
| Identity | MLBAM through Chadwick, corroborated by Wikidata; ambiguous cases held | same register, but the rows cannot be published |
| Verdict | **first batch** | blocked until a source is approved |

## 3. 2022 pilot (local only, nothing applied)
- Source revision 1374495794 of the 2022 draft article (states 616 selections). It lists 186 selections: the opening 80 picks contiguously and 106 editor-chosen later-round entries. Later rounds are therefore nonrepresentative and every club stays PARTIAL_RECONSTRUCTION.
- Tooling change: the article's later-round table puts round and pick on one line with `||`; the parser now splits inline cells outside links and templates (a fictional-fixture test covers it). Without this only 83 of the 186 rows were readable.
- Scope: all 30 clubs, the Dodgers included. A Dodgers draft selection is an ordinary draft row; DISI's authority is over Dodgers international signings and is not touched. (An earlier candidate excluded the five Dodgers picks; it was a mistake, and that manifest stays as an immutable local file.) The release builder keeps a generic `--exclude-orgs` option, recorded in the manifest and enforced by `verify`, for releases that must leave a club out; it is not used here. No identity overlaps DISI's Dodgers set or BAI's own Dodgers signees, and an overlap would not exclude a draft pick.
- Identities (186 listed): 153 verified, 29 single-source name-only, 4 ambiguous (held). The hosted collision preview classed 178 of the 182 buildable rows SAFE and 4 for human review: three would link an existing player by identifier (repeat draftees, needing owner approval as in 2020) and one shares a name with an existing player (held, never linked by name).
- The eight held picks (four ambiguous identities and four collisions) are outside the proposed 178-pick manifest and stay outside it. Releasing the already-safe 178 does not depend on them: each of the eight needs its own approval or identity decision (a repeat-draftee link, a reviewed identity, or a same-name decision) and would enter later as a separate supplement manifest.
- Release candidate (manifest `8005c43c6dd2fba83c5f19cb83d91b658f361924fcaca0d466ffe8cdb4284da9`): 178 selections in 30 clubs (150 verified identities, 28 name-only), 8 held, signing status unknown for every row, no dates or bonuses, expected maxima players 178, external ids 453, source observations 1,162 (enforced inside the apply transaction), sources 3. The Dodgers contribute 5 of the 178.
- Disposable rehearsal (a copy of hosted in a throwaway PostgreSQL 17, nothing written to hosted), 2022 first of a sequential 2022 then 2023 run on one database. Exact counts before, after and after a replay: draft selections 821, 999, 999; players 1,142, 1,320, 1,320; external ids 2,318, 2,771, 2,771; sources 171, 173, 173 (limit 3); source observations 9,742, 10,904, 10,904 (+1,162, exactly the manifest maximum); signings 456 throughout; release audits 3, 4, 4. Preview SAFE; wrong checksum and agent operator refused; the release audit records every outcome; integrity 0 violations; security OK; 30 clubs partial. The rehearsal tool now has a `--sequential` mode and asserts the observation, source and audit limits for every release; after the whole sequence every release replays as already applied and no table moves.
- Public wording (applies only once rows are published; before that, no 2022 notice appears, and the explorer does not show the 2022 note for a 2022 filter until 2022 selections exist): the notice splits the absent selections into the ones the source does not list (a source gap: 430) and listed selections held for identity or collision review (8, which shrinks as approvals are applied); a club left out of a release by scope would be named separately as not a source gap. It keeps the partial-coverage, nonrepresentative-later-rounds and no-rates warnings and never reads a missing selection as an unsigned player or a failed outcome.

## 4. Year-by-year plan for the remaining organizations
Each release is a separate checksum, a hosted collision preview, a disposable rehearsal and an owner authorization; none is partial-as-complete.
| Release | Slice | What is reachable | Work before it | Human decisions and gates |
|---|---|---|---|---|
| R1 | 2022 draft, 30 clubs | 178 now; up to 186 later, as supplements, if each of the eight held picks is approved | none beyond the owner's authorization of the 178-pick manifest | the eight held picks (three repeat-draftee links, one same-name case, four ambiguous identities) are not needed to release the 178; each needs an individual approval or identity decision before a later supplement |
| R2 | 2023 draft | 166 rows listed (614 stated); opening picks and an editor-chosen sample | a prospect-promotion-incentive section is unknown to the parser and its round code needs a mapping decision (a calendar or schema change if a new round phase is required) | decide the PPI round mapping; same review gates |
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
Owner authorization naming each manifest checksum and the hosted target (for R1, the 178-pick manifest needs nothing else; the eight held picks are individual approvals for later supplements); the PPI round mapping and the layout parser variant for R2-R4; a usable source for any later-round or international expansion. Nothing is merged, migrated, imported or deployed by this phase.
