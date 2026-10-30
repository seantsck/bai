# Gate G4 — release record: one RETROSHEET publication grant on hosted BAI

**Status: COMPLETE (G4-C PASS, 2026-10-30).** Exactly one row was written to `ingest.source_publication_grants` on the hosted BAI project (`dbnmktidheefoxaztivm`). By itself this publishes nothing. Hosted stays at migration level **030**. No migration, import, read-model refresh or deployment was part of this gate.

The checksum-pinned authorization document, [g4-retrosheet-authorization.md](g4-retrosheet-authorization.md), is unchanged by this record.

## What was granted

| Item | Value |
| --- | --- |
| `attribution_category` | `RETROSHEET` (category-wide; this is the only grant on hosted) |
| Committed | 2026-10-30T00:00:40Z (`granted_at` 2026-10-30T00:00:40.046Z) |
| `granted_by` | `postgres`, the database role; the person is named in `basis_reference` |
| Effective decision | G4-C owner authorization, 2026-10-29; the merged catalog authorization takes effect on 2026-10-30 |
| Authorization document SHA-256 | `63077bdd767547a2c456f4298cdd6c6d9ef0d32047427e6e133e2606e7083b82` (merged in `fa0d8b5d9314958c9b4e38b3f9516d7f9ac8f661`) |
| Retrosheet notice SHA-256 | `2218abe680e21d3308de06352c394baefbffc7618d36a821d38ed6e97c24105d` |
| Authorization lapses | after 2027-01-22, unless re-reviewed |

**`basis_reference`, verbatim:**

> BAI owner (GitHub: seantsck); G4-C owner authorization of 2026-10-29 (single RETROSHEET grant). Basis: G4 authorization document docs/transactions/g4-retrosheet-authorization.md (SHA-256 63077bdd767547a2c456f4298cdd6c6d9ef0d32047427e6e133e2606e7083b82; merged in fa0d8b5d9314958c9b4e38b3f9516d7f9ac8f661); Retrosheet's published notice https://www.retrosheet.org/notice.txt (SHA-256 2218abe680e21d3308de06352c394baefbffc7618d36a821d38ed6e97c24105d), which is published permission and not a separately signed licence.

**`scope_note`, verbatim:**

> Category-wide RETROSHEET only. Public display is subject to the notice's attribution statement appearing verbatim and prominently wherever Retrosheet-derived records are displayed. Review due 2027-01-22 (the authorization expires after that date unless re-reviewed). No authorization for MLB, BASEBALL_REFERENCE or OTHER_PUBLICATION. No read-model refresh before the G6 prerequisites are fulfilled: production attribution pages publicly verified and the direct Supabase REST API attribution question resolved. The source-stewardship and archive-date discrepancy remains an open provenance question. Retrosheet's accuracy disclaimer applies; records are PARTIAL.

## Timeline (UTC)

1. **First preflight, 2026-10-29T23:45Z: FAILED, no write.** One check failed: the merged catalog refuses `publish_site` before the authorization's effective date of 2026-10-30. The date gate behaved as designed, and nothing was written.
2. **Second preflight, 2026-10-30T00:00:26Z: all checks passed.** The full preflight was re-run once the date arrived: project identity; level 030 in both the BAI ledger and the Supabase history; document, catalog and notice hashes; catalog permission at the current UTC date; grant-table schema; no existing grant; zero `RETROSHEET` sources; all 12 read-model tables empty; 65 transactions, 198 import batches and 0 player moves.
3. **Write, 2026-10-30T00:00:38–40Z: COMMITTED.** The preflight ran again inside the write command, then exactly one controlled transaction inserted the row, confirmed that one grant existed, and committed. There was no retry.

## Postflight (read-only)

* Exactly one grant exists, `RETROSHEET`; no other grant was created or changed.
* The stored text carries the owner, the G4-C reference, both hashes, the notice URL, the review date, the exclusions and the no-refresh condition.
* Hosted is at level 030 in both histories.
* All 12 `rm_transaction*` tables hold 0 rows; the refresh and withdrawal logs hold 0 rows.
* Counts are unchanged: 65 transactions, 83 packages, 198 import batches, 0 player moves, 0 `RETROSHEET`-category sources; no `ACQUISITIONS` batch exists.
* `anon` and `authenticated` are denied (42501) on the grants table.
* The 65 MLB-sourced trades stay withheld: no `MLB` grant exists, and a `RETROSHEET` grant cannot release them.

## The G3 snapshot is no longer the current baseline

The G3 backup `g1-20261029T220416Z` was taken before migration 030 and before this grant. `hosted-preflight --after 030` against that snapshot therefore now reports one difference, `ingest.source_publication_grants: 0 -> 1`. That difference is the intended write, not drift, but the check can no longer pass against this snapshot. The G3 backup stays valid as a recovery point for the state it recorded. It must not be presented as current production: any later hosted write needs a fresh backup taken after G4-C.

## What this gate did not do

It did not import data, refresh the read model, deploy anything, or authorize `MLB`, `BASEBALL_REFERENCE` or `OTHER_PUBLICATION`. G5, G6 and G7 each still need their own authorization. The G6 prerequisites in the scope note stand. The stewardship and archive-date discrepancy recorded in the authorization document remains open.

## Evidence

Kept outside the repository in `~/bai-gates/g4c-evidence/`, read-only, with a `SHA256SUMS` file (SHA-256 `906990de5fa99d1d630c8d1c29494fd15d66e3e599485d35900e6b712c17ec18`): the owner authorization, both preflight outputs, the write output, the postflight output, the script and a closure note.
