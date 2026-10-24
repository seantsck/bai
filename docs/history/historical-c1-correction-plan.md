# Proposal: correct three published compensation rows from C-2 to C-1

Status: PROPOSAL ONLY. Researched read-only on 2026-10-24 (read-only transactions on hosted `dbnmktidheefoxaztivm`). Nothing was changed. Executing it needs separate owner authorization naming the target, the operator and the statement checksum.

## Affected rows (hosted)
| Draft | Pick | Club | Player | selection id | round id | Now | Proposed |
|---|---|---|---|---|---|---|---|
| 2021 | 30 | CIN | Jay Allen | 1423 | 467 | C-2, order 23 | C-1, order 13 |
| 2022 | 31 | COL | Sterlin Thompson | 1853 | 500 | C-2, order 23 | C-1, order 13 |
| 2022 | 32 | CIN | Sal Stewart | 1832 | 500 | C-2, order 23 | C-1, order 13 |

Round 467 (2021 C-2) holds only pick 30. Round 500 (2022 C-2) holds 8 selections: picks 31 and 32 plus the six genuine C-2 picks 75-80, which stay C-2. Neither draft has a C-1 round row yet.

## Evidence (no new source needed)
The pinned Wikipedia revisions, already the cited sources (audit 3 and 4 revisions): 2021 revision 1373807660 lists sections First round, **Compensatory round** (pick 30), Competitive balance A, Second round, Competitive balance B, with no later compensatory section. 2022 revision 1374495794 lists First round, **Compensatory round** (picks 31-32), Competitive balance A, Second round, Competitive balance B, then a separate **Compensatory round** (picks 75-80). A compensation table before the second round is C-1; after it, C-2. The parser now encodes that rule (tested), and cached 2020, 2023, 2024 and 2025 are unaffected.

## Related round-order normalization (also not executed)
Future code now orders second-round compensation (C-2) at 27, after Competitive Balance B (26). Existing hosted rows keep the old values (read-only listing 2026-10-24), so they sort C-2 before CB-B:
| Draft | Round row | Now | Normalized | Selections |
|---|---|---|---|---|
| 2020 | C-2 (round 432) | 23 | 27 | 6 |
| 2021 | C-2 (round 467) | 23 | 13 as C-1 (the correction above) | 1 |
| 2022 | C-2 (round 500) | 23 | 27 (the six genuine C-2 picks stay here) | 8, of which 2 move to the new C-1 |
| 2023 | C-2 (round 542) | 23 | 27 | 3 |
| 2023 | PPI (round 564) | 15 | 11 | 1 |
Each is an `UPDATE draft_rounds SET round_order` on a row nothing depends on by order (`UNIQUE (draft_id, round_order)`: 27 and 11 are free in those drafts). Order is a sort key only; display of the selections changes, their data does not. The same rehearse-first, audit-trail, rollback and verification steps apply (rollback: set the old values back). Until then public views sort those years' C-2 picks before CB-B.

## Dependent records
- `source_observations` (subject `draft_selections`), field `round_code`, status ACTIVE, value `C-2`: three rows, citing source 2998 (2021) and 3262 (2022). The organization and school observations are unaffected.
- `draft_signings`, `acquisition_dispositions`, `acquisition_expectation_links` referencing these selections: 0 rows each. `research.certifications` active: 0 (so the evidence-change trigger revokes nothing).
- Views `v_draft_explorer` and `v_draft_picks` read `round_code` and `round_order` live; no stored read-model column holds it.
- Release audits 3 (2021, `4987ca6b…`) and 4 (2022, `8005c43c…`) and their manifests record `C-2` as applied. They are immutable and stay unchanged; the correction is its own recorded event.
- Constraints: `UNIQUE (draft_id, round_code)`, `UNIQUE (draft_id, round_order)`, FK `(round_id, draft_id)`. Wikipedia-sourced rows pass the publication guard.

## Proposed change (one transaction, rehearsed first)
1. Preflight: confirm the three rows and rounds are exactly as above, audits 1-5 checksums unchanged, no signing rows; take a read-only backup.
2. 2021: update round 467 in place to `C-1`, order 13 (it holds only pick 30, so no row moves).
3. 2022: insert a `C-1` round (order 13, COMPENSATION) for the 2022 draft and repoint selections 1853 and 1832 to it. Rounds 75-80 stay in `C-2`.
4. Observations: mark the three ACTIVE `round_code = C-2` observations SUPERSEDED, add a `C-1` observation citing the same source with a note naming this correction and the section-structure evidence, and link `superseded_by_id`. Nothing is deleted.
5. Audit trail: record the correction as a new manifest-bound entry (statement SHA-256, operator, before/after for the three rows) in the release audit mechanism; audits 3 and 4 are not edited. Whether `ingest.release_audits` accepts a non-release row (it carries a draft year and manifest checksum) must be confirmed in the rehearsal; if not, add a small migration for a correction log (separate authorization).
6. Regenerate read models.

## Rollback
No dependent data exists, so the inverse is exact: repoint 1853 and 1832 to round 500, delete the 2022 C-1 round (no selections left), update round 467 back to `C-2`/23, reactivate the three superseded observations and mark the new ones withdrawn. A pre-change backup is the fallback.

## Verification
- Row counts unchanged (selections, players, ids, signings 456); only the 3 selections' round and the observation rows change.
- Each of the three picks reads C-1 in `v_draft_picks`; 2022 C-2 holds 6 rows, C-1 holds 2; 2021 C-1 holds 1; round orders unique.
- Integrity violations 0; audits 1-5 byte-identical; international tables unchanged.
- Replaying the audit 3 and 4 manifests must still report "already applied" (verify in rehearsal that the stored `C-2` in an immutable manifest does not read as a conflict); if it would, record a documented supersession rule.
- Run the whole procedure on a disposable copy first.
