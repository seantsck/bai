# Gate G3 — release record: migration 030 applied to hosted BAI

**Status: COMPLETE (2026-10-29).** Migration `030_transaction_public_read_model.sql` — and nothing else — was applied to the hosted BAI project (`dbnmktidheefoxaztivm`). Hosted is at level **030** (it was 029). No migration beyond 030 exists or was applied. Exactly one guarded `db push` was run. No publication grant, import, read-model refresh or application deployment took place: the public read model is empty and the Transactions pages are still not deployed.

Released with the same controls as G2 ([g2-release-record.md](g2-release-record.md)): automated off-site backup evidence (`final-parity --offsite-record`), a backup-specific owner authorization, and a gate pinned to a commit that enforces protocol v2.

## What was released

| Item | Value |
| --- | --- |
| Migration | 029 → 030, `030_transaction_public_read_model.sql` |
| Migration 030 SHA-256 | `2aa200bbb55c7f59ea42d398e1f1c49e71155dd46034f4b83c042ba0ed2eeeae` |
| Gate | `g3-v1.gate.json`, SHA-256 `b493bb39f7db0ea5c5f4918831f8eaa26c2da1c7ed70f48279fb2460b0ee8155` (`migrations_hash` `90ff89db52804ef03720634f1ef04142133df05178e0c3a3f534d864de2c8dee`) |
| Pinned commit | `4048890ec9269c7ef34dbc95ef4b07be6c587135` (protocol v2 enforced; `scripts/db` identical to G2's pinned commit) |
| Restricted worktree | `~/tmp-bai/g3-release-v1` (migrations 001–030 only) |
| Backup | `g1-20261029T220416Z`, started 2026-10-29T22:04:16Z, eligible until 2026-10-30T04:04:16Z |
| Protocol-v2 manifest SHA-256 | `99a43d3f2cb37c3183efaf39c62a8087985524936e16ff3235b2e8c1ec79d8eb` (equal to the G2 backup's: it hashes table data only, and 029 changed views, not rows) |
| Encrypted archive SHA-256 | `0f67f63538517a5964fb37c904f4659babfcc907210387437b5696150f0512ff` (1,135,465 bytes) |
| Content-tree SHA-256 | `5e0b453514b0cdf07f422487cf3d772e2542b6ac0610aa482392688836b30a72` |
| Automated verification record | `g1-20261029T220416Z.offsite-verification.json`; internal `record_sha256` `32facd02e8ba22ab6b428770cf0067fdf6e26a41cb257622738e07c1c03e0d8c` (file SHA-256 `f565f08d8d4b7492e3b877badcdeef2000494c5afc2ee50fb603749a37cc16e4`) |
| Owner encryption key (primary fingerprint) | `47AB7918CDED25B47AE056C5E204499803387355` (public half only on the server) |
| Off-site destination | Google Drive, `gdrive:BAI-G1-backups/g1-20261029T220416Z/attempt-20261029T220644Z` (4 objects, `drive.file` scope) |
| Owner authorization | Phase A (backup) and a separate backup-specific Phase C authorization, 2026-10-29; Phase C text saved outside the repository, SHA-256 `8239bbfef9851ebaed9603a302ce18cffb574796d7c7daef9644696264352a5f` |
| `final-parity` record | `g3-final-parity-20261029T221828Z.json` (file SHA-256 `2af05a048dd56eae1cfcc9b2484d9f339ff1e22bbf9ac1e5daa8a5e9a5b3d29a`; expired after 10 minutes; evidence only) |

## What migration 030 does
Additive except for closing three tables. It adds the `RETROSHEET` attribution category and its verbatim attribution statement; non-trade acquisition support (two transaction types, the `ACQUISITIONS` import channel, `transaction_player_moves`); the public read model (`rm_transaction_*`, refreshed only by the owner-run `refresh_transaction_read_models()`, a transaction entering it only if every source it cites is authorized for display); fail-closed withdrawal triggers (a withdrawn grant, a revoked verification or an edit to a published transaction removes it at once); and it **removes anonymous and authenticated read access to `public.transactions`, `public.trade_packages` and `public.trade_package_assets`** (the `public_read` policies are dropped) and revokes `analytics` and public function execute privileges. Enum additions are permanent; restoring the old exposure would be a deliberate new migration.

## Timeline (UTC) and results
1. **Rehearsal (G3-0, G3-1, local only).** 028 snapshot of the G2 backup → 029 → 030 on a disposable UTF-8 PostgreSQL: release guard ok at each step, 100 existing tables unchanged, value views identical, security audit OK, read model empty then populated and withdrawn correctly on a copy; a 55-check offline validation of the G3 gate and push guard (fake CLI, zero pushes in 20 refusal cases, one `db push --linked` for a valid record); 131 repository tests passed at the pinned commit.
2. **Phase A, 22:04–22:07.** `backup-run.mjs all --gate g3-v1.gate.json` from the restricted worktree: gate offline check, snapshot, logical export, verification, disposable restore and strict hosted preflight at level 029 PASS; encrypted, key wrapped to the owner's public key, uploaded with provider MD5 match, fresh download byte-identical, decrypted with content hash and internal checksums equal to the backup; protocol-v2 evidence accepted. **Automated Google Drive verification: PASS.** Re-checked with `backup-run.mjs check` and with the release-evidence validator that Phase C uses (0 problems).
3. **Identity re-validated, 22:18.** Gate and 030 checksums, pinned commit, clean worktree, backup 0.24 h old, record re-derived from the files; gate check with the read-only hosted-history query and dry run: hosted at 029, dry run lists exactly 030.
4. **`final-parity`, 22:18–22:20: FINAL PARITY OK.** Backup sound and within six hours; content hash equals the off-site verified one; strict preflight (level 029, checksum, every table byte-identical); fresh logical export identical to the backup's roles, schema, data and migration history.
5. **`db push`, 22:20:32–22:20:38: PASS.** Gate check including the dry run (exactly 030), parity record re-verified, the CLI applied `["030_transaction_public_read_model.sql"]` with no seeds or roles. One push; no retry.
6. **`migrate.mjs --confirm-hosted dbnmktidheefoxaztivm`: PASS.** 030 recorded in the BAI ledger after verification against the Supabase history.
7. **`hosted-preflight --after 030`: PREFLIGHT OK, 108 of 108 checks.** Recorded level 030; Supabase history exactly up to 030; every recorded and pushed migration equals its committed file; nothing committed but unapplied; every snapshot table unchanged in its original columns (registries only gained rows).

## Post-release verification
Read-only (a `begin read only` transaction, then Data API GETs with the publishable key):

* **Existing data preserved:** 65 transactions, 83 trade packages, 111 package assets, 1,612 players, 1,291 draft selections, 297 international signings, 198 import batches — all unchanged.
* **Read model empty:** all 12 `rm_transaction*` tables hold 0 rows; `transaction_player_moves` holds 0 rows; no refresh was run.
* **No grants or imports:** `ingest.source_publication_grants` is empty; import batches are unchanged and none uses the `ACQUISITIONS` channel.
* **Access restrictions:** `anon` and `authenticated` are denied (42501) on `transactions`, `trade_packages`, `trade_package_assets`, the grants table and `analytics`; no `public_read` policy or table privilege remains on the raw tables. `rm_transactions` (0 rows), `source_attribution_statements` (the Retrosheet statement) and `v_source_attribution` stay readable. Data API GETs of the three raw endpoints return 401 (42501); `rm_transactions`, `source_attribution_statements` and `organizations` return 200.
* **`hosted:security` (read-only): SECURITY OK.** 88 functions audited (28 SECURITY DEFINER), none executable by PUBLIC, anon or authenticated, none with an unset `search_path`. Only the 14 plain-SELECT probes of 30 ran; the 16 that write or call functions were verified from the catalog.
* **`hosted:parity`: PARITY OK.** 30 recorded migrations (Supabase history: 30 versions, matches the files); 3,323 BAI-owned objects compared; **0 BAI-owned differences**. One explained platform difference (`postgres` USAGE on schema `public`, granted by Supabase). Seed data is not compared (hosted holds 198 import batches). `hosted:parity` is read-only: it builds its reference on a throwaway local PostgreSQL and only SELECTs from hosted.

## Accepted risk: unidentified external API consumers
Migration 030 removes anonymous access to `/rest/v1/transactions`, `/rest/v1/trade_packages` and `/rest/v1/trade_package_assets`, which were publicly readable through the Supabase Data API with the published key. The release plan asked for a review of 90 days of API logs before this gate. **That review was not possible:** the logs available to the owner covered only **2026-10-28 and 2026-10-29** (14 edge-log events and 14 PostgREST events), and no request to the three endpoints was observed in that window. Most events resembled BAI's own security probes. This is limited observational evidence; **it does not establish that there were no external consumers.**

The owner explicitly accepted, before Phase C and in the backup-specific authorization, the residual risk that unknown consumers of those endpoints lose access, and authorized the access restrictions of 030. The affected endpoints now deny anonymous access as intended (verified above). Nothing in this repository read those tables. The rows involved (the 65 BAI trades) are MLB-sourced and were already public; they remain withheld from the read model until an MLB-category display grant is recorded. Restoring access would require a new, separately gated migration.

## Notes for later gates
* **Local rehearsals need a UTF-8 locale** (validated: `en_US.utf8`, `C.utf8`). A `C`-locale database changes the generated `name_normalized` / `alias_normalized` columns (21 rows on the snapshot) and fails the snapshot comparison with no migration applied.
* **Source categories:** a transaction cites `transactions.source_id` plus every `transaction_sources` row. All 65 existing trades cite one MLB source; a `RETROSHEET` grant alone will not publish them, only an `MLB` grant would. Displaying Retrosheet data remains G4 (grant review), G5 (import) and G6 (refresh); verifying Retrosheet's notice is part of G4 and is not an authorization to publish.
* The private recovery key still exists in one copy (the owner's computer); see [offsite-automation.md](offsite-automation.md).

## Final state
Hosted level **030**; Supabase history and BAI ledger both end at 030; nothing later was applied. Gate, migration files and restricted worktree unchanged. No application deployment: production runs the pre-028 app plus the three backup pages, and the Transactions pages are not deployed.
