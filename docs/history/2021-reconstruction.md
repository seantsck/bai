# 2021 draft cohort: what a permitted reconstruction can and cannot reach (Phase 11)

Aggregate findings only. Per-player material (queues, collision details, signing markers) stays local under `.local/history/2021/` (gitignored).

## 1. The existing DiamondIQ draft page
`diamond-iq.io/draft/2021` shows 612 picks with pick, player, position, team, school and bonus. Its footer says **"Data via the MLB Stats API. Not affiliated with MLB."** It names no license, offers no export or repository link, and gives no last-updated date. Its header says "24 rounds" while the article-based structure is 20 rounds plus special sections, and its section headings include a 4C section that the Wikipedia article does not have; neither inconsistency can be resolved from a permitted source.

Consequences, under BAI's catalog (`mlb-statsapi-draft`: fetch PENDING, repository and site publication PROHIBITED):
- The page's rows (including bonuses) are MLB Stats API data. Owning the site does not give BAI redistribution rights over upstream data, so none of it was copied, imported or compared row by row.
- A repository or export of that dataset, if one exists, would carry the same upstream restriction. No DiamondIQ or DISI repository was opened or changed.
- The unlock is a written authorization from MLB (or a licensed dataset, see `license-outreach-drafts.md`), recorded by a person in `research/history/sources.json`.

## 2. What the permitted sources give
| Source | 2021 result |
|---|---|
| Wikipedia article, revision 1373807660 (states 612) | 207 rows: a **contiguous list of picks #1-#71** (round 1: 29, compensation 1, competitive balance A 6, round 2: 27, competitive balance B 8) and 136 rows of "Other notable selections" from rounds 3-20 |
| Retrosheet transactions | 0 draft records for 2021 |
| Wikidata | no "drafted by" statement dated 2021 |
| Chadwick register | identities only (no draft information) |

Picks #72-#612: 405 of 541 pick numbers have no row in any permitted source. **Coverage stays PARTIAL_RECONSTRUCTION for all 30 clubs** (207 of 612 rows).

Derived check, not evidence: 71 + 18 rounds x 30 + 1 further pick = 612, and all 207 rows fall in the round that layout predicts. The one extra pick is #132, which the article labels round 4; other public summaries mention two compensation rounds while the article lists one. Left unresolved.

A public tracker page that lists the full draft (CBS Sports) was tried once as independent evidence and returned HTTP 429; it is recorded as unread and no workaround was attempted. Other trackers surfaced in search were not fetched. None of them is catalogued, so none was used to populate rows.

## 3. Identities
Reusing the 2020 Chadwick + Wikidata method: 175 VERIFIED, 32 SINGLE_SOURCE (name only, no ids), 0 ambiguous. Against hosted (read-only): 205 SAFE, 2 HUMAN_REVIEW (one id already held by an existing player with no selection; one name shared by three existing players, where a single register candidate would make the player a repeat draftee but rests on one source), 0 BLOCKED. Nothing is merged by name.

## 4. Tooling in this change
- The article parser reads the "Other notable selections" table (round in its own column; rows flagged `notable_only` and never treated as a round list), keeps the article's "did not sign" `*` marker as a marker rather than part of the name, and tolerates a curly-quote cell.
- Release builds are year-generic (the Tyler Brown #101 option applies to 2020 only); coverage notes say when rows come from the notable table.
- The disposable rehearsal checks any year, not just 2020.

## 5. Signing status
The article marks 11 rows "Player did not sign": a single aggregator's statement, kept as a proposed finding. Every row is imported with signing status UNKNOWN; no dates or bonuses.

## 6. Proposed next release boundary
A partial release of the 205 rows that are SAFE now (two held for human decision), all 30 clubs PARTIAL_RECONSTRUCTION, built and rehearsed exactly like the 2020 release; or wait for a permitted source for rounds 3-20. Neither is approved or applied. Reaching the full 612 needs one of: written MLB authorization, a licensed dataset (Baseball America / The Baseball Cube), or a lawful newspaper/press transcription plan.

## 7. Structure of the 2021 draft (Phase 11.1 correction)
The draft has **20 numbered rounds**. Everything else is a labelled section, kept under its exact historical label and never counted as a further numbered round:

| Section label | Position | Picks |
|---|---|---|
| Round 1 | numbered round | 29 (Houston forfeited its first-round pick) |
| Compensation Pick | after Round 1 | 1 |
| Competitive Balance Round A | after Round 1 | 6 |
| Round 2 | numbered round | 27 |
| Competitive Balance Round B | after Round 2 | 8 |
| Rounds 3-4, 5-20 | numbered rounds | 30 each, plus the extra pick below |
| Compensation Pick (second) | after Round 4 | 1: **pick #132, Houston's fourth-round compensation selection** |

Picks #1-71 are the opening block through Competitive Balance Round B; rounds 3-20 then hold the remaining 541 picks. The derived layout check is 71 + 18 x 30 + 1 = 612 (arithmetic, not evidence of any pick).

Rules for BAI data and copy:
- `round_code` keeps the section's own label (compensation, competitive balance A/B); a compensation or competitive-balance section is never shown as "round 21" or any other numbered round. The DiamondIQ page's "24 rounds" is not adopted.
- Pick #132 is stored in the round the article gives it (round 4) and identified as the compensation selection, not as a fifth-round or additional-round pick.
- This section describes structure only. No row from an MLB-derived or unlicensed source was ingested to write it; the section labels were read from a page's headings and from the Wikipedia article.

## 8. EDSFootball.com draft results page (Phase 11.1 source-rights review)
`eatdrinkandsleepfootball.com/draft/mlb/results/year/2021.html` presents all 612 picks in 20 numbered rounds with the section labels above. Review of the page, its About and Privacy pages and its footer (one view; no rows copied or saved):

| Question | Finding |
|---|---|
| Publisher | EDSFootball.com ("Eat, Drink and Sleep Football"); About page names an individual owner and a contributor; Privacy Policy names the Company with a Torrance, CA city and ZIP only |
| Provenance of the draft data | **None stated.** No source credit, "data via" line, or last-updated date. The About page credits other sources (fantasy and accuracy-ranking providers) but nothing for MLB draft results |
| Independent or MLB-derived | Unknown. A complete 612-pick list with club, round and school is most plausibly taken from the league's feed or a licensed provider; this cannot be shown either way |
| Terms of use | **No terms page, copyright notice or license** (the /terms URL does not exist; footer links are About, Privacy, Links, Partners). No robots.txt (404) |
| Contact for permissions | info@ the site's own domain (shown on About and Privacy) |
| Authorization process | None published |

Decision (catalog id `edsfootball-mlb-draft-results`): **NOT CLEARED**. Facts such as pick numbers are not themselves protected in many jurisdictions, but BAI's rights policy does not treat silence as permission, a complete list of this kind can be a protected compilation, and if it derives from MLB data the `mlb-statsapi-draft` restriction (no bulk use without written MLBAM authorization) travels with it. So: fetch PENDING (one audit view only), bulk and local processing PROHIBITED, repository publication PROHIBITED, site publication PENDING. The page **can technically support** a full 612-row reconstruction; BAI is **not permitted** to build it from this source today.

To unlock: a written statement from the owner that (a) names the upstream source of the lists, (b) permits extraction and public republication of facts with attribution, recorded under `authorization` in the catalog with the document's SHA-256; or an MLB authorization. An inquiry is drafted in `license-outreach-drafts.md` and has not been sent.

## 9. Partial release of the permitted rows (205 of 612)
Rebuilt manifest `partial-205` (local, unapplied): 205 selections, 30 clubs all PARTIAL_RECONSTRUCTION, #492 and #359 held, signing UNKNOWN for every row with no dates or bonuses. The manifest's coverage block now records 612 documented, 205 represented, 407 absent, that later-round rows are an editor-chosen set, and that absence is not an unsigned or failed outcome. Public pages (draft years, draft picks, explorer) carry the same statements; rates stay disabled for partial coverage.
