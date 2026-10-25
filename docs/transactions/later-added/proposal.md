# Later-added trade assets: study and schema proposal (not implemented)

Status: a **separately reviewable proposal**. The DDL is `proposed-031-later-added-assets.sql` in this directory. It is **not** a migration, is not in `database/migrations`, and is applied nowhere except a disposable database by `tests/db/later-added-proposal.test.mjs`. Fixtures: `fixtures.json` (fictional rows in the archive's format, with the expected label for each). Nothing existing is reinterpreted: with the new tables empty every existing view row is identical (tested), and the existing PTBNL records (migration 028) stay exactly what they are.

## 1. The study: what the later-dated members actually are
A Retrosheet trade is a group of rows sharing an id; some groups carry rows dated after the trade. Counted from the archive with `scripts/research/lib/retrosheet-later-members.mjs` (labels only, from what the source states):

| | 2010-2014 | 2015-2020 | 2021 |
|---|---|---|---|
| Trade groups with later-dated members | 75 | 88 | 11 |
| Later members | 83 | 98 | 14 |
| Player row, no placeholder in the original rows (`ADDED_LATER_UNSTATED`) | 82 | 97 | 14 |
| Player row that formally names exactly one placeholder (`PTBNL_NAMED`) | 0 | 1 | 0 |
| Source-typed "added to trade" (`Tp`) | 0 | 0 | 0 |
| Later row with no player (cash or text) | 1 | 0 | 0 |
| Members whose player has no id (minor leaguer) | 40 | 71 | 14 |
| Members in a direction absent from the original rows | 49 | 59 | 8 |
| Delay after the trade: 0-7 / 8-30 / 31-90 / 91-365 / over a year (days) | 15/36/24/8/0 | 11/45/26/16/0 | 1/2/6/5/0 |
| Trade groups that carry a PTBNL placeholder at all | 23 | 90 | 8 |
| ...of which a later player follows | 0 | 1 | 0 |

What this says:
1. **A formally resolved PTBNL is rare in the data** (1 of 88 in the validated window). 90 groups state a placeholder and almost none records who was named; 97 later players appear with no placeholder at all. Treating the second kind as the first would invent a PTBNL the source never states.
2. The later player is usually in the *opposite* direction from the original rows (59 of 98): the club that received a player later sent one back. That is consistent with a PTBNL being named, but the source does not say so, so the label stays `ADDED_LATER_UNSTATED`.
3. Everything is within a year of the trade; nothing here looks like an unrelated id reuse (which does occur, for non-trade types, and is never merged: those rows are separate groups).
4. Most later players (71 of 98 in 2015-2020) have no id and cannot be matched anyway.

## 2. What must stay distinguishable
| Situation | Source statement | Where it lives | Date semantics for value views |
|---|---|---|---|
| Original asset | on the trade date | `trade_package_assets` (unchanged) | trade date |
| **Formally resolved PTBNL** | a placeholder in the original rows names, later, exactly one player | placeholder asset + `ptbnl_resolutions` (028, unchanged) | naming date |
| **Source-typed addition** (`Tp`) | "added to trade, usually because an original player refused to report or retired" | `trade_asset_additions`, kind `ADDED_TO_TRADE` | date added |
| **Unstated later addition** | a player row under the trade id, dated later, no placeholder, no reason | `trade_asset_additions`, kind `ADDED_LATER_UNSTATED` | date added |
| Ambiguous pairing | several placeholders and fewer later players | nothing until a person pairs it (then a resolution) | none |
| **Conditional asset and its amendments** | a condition, later met or not met | the conditional asset (028 `conditional`, `condition_text`) + `transaction_amendments` (`CONDITION_MET` / `CONDITION_NOT_MET`) | amendment date |
| Void, return, substitution, removal | later `Tv`/`Tr`/other rows | `transaction_amendments` (`TRADE_VOIDED`, `TRADE_RETURNED`, `ASSET_SUBSTITUTED`, `PLAYER_REMOVED`) | amendment date |
| Cash or text added later | a later row with no player | **held**: no representation yet | none |

## 3. The proposed schema (see the SQL file)
- `public.trade_asset_additions (trade_package_id, player_id, addition_kind, added_on, added_on_precision, source_id, locator, notes)`, unique per package and player; a guard refuses an addition dated before the trade or one that repeats an original player or a PTBNL-named player of the same package (a player is counted once). The source packages' direction is the package, as for every asset.
- `public.transaction_amendments (transaction_id, amendment_kind, effective_on, effective_on_precision, trade_package_asset_id, source_id, locator, notes)`: a dated fact with a source. A condition amendment must name a conditional asset of the same transaction; no amendment predates the transaction.
- `analytics.trade_asset_players` gains the added players (effective from `added_on`, new column `via_addition`) so the 029 value views count them once from that day, exactly as a PTBNL is counted from its naming day. Existing rows are untouched.
- The verification fingerprint covers additions and amendments, and any change to either revokes a human verification (the 028 rule). Both tables are internal (RLS, no public grant), registered as provenance fact tables.
- Open items for the review, deliberately not decided here: corroboration rules for an addition (two independent source groups per added player, as for assets: a gap code `ADDITION_NOT_CORROBORATED`); whether an unstated addition may ever count toward `VERIFIED_COMPLETE` without a second source (the proposal says no); and a representation for cash or a pick added later.

## 4. How the Retrosheet adapter would use it
`classifyLaterMembers` labels each later member; the adapter today holds every group with a later member that is not exactly a one-placeholder resolution (27 groups in 2015-2020 for that reason). With this schema the adapter would stage `ADDED_TO_TRADE` and `ADDED_LATER_UNSTATED` members as additions (each with its Retrosheet line as the locator and the source date as `added_on`), leave `PTBNL_AMBIGUOUS` held, and never turn an unstated addition into a PTBNL.

## 5. Tests and fixtures
`tests/history/retrosheet-later-members.test.mjs` classifies each fixture case as documented and checks that unrelated rows are not merged; `tests/db/later-added-proposal.test.mjs` applies the proposal on top of 029 and proves: no change while empty; guards; an added player counted once from the day he was added (and his earlier season not credited); the PTBNL resolution untouched; amendments constrained; fingerprint moved; both tables closed to public roles.
