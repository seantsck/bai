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
