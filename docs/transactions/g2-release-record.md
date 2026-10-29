# Gate G2 — release record: migration 029 applied to hosted BAI

**Status: COMPLETE (2026-10-29).** Migration `029_value_view_scale.sql` — and nothing else — was applied to the hosted BAI project (`dbnmktidheefoxaztivm`). Hosted is at level **029** (it was 028). Migration 030 was **not** applied or recorded. No import, publication change, read-model refresh or application deployment took place. Exactly one guarded `db push` was run.

This was the first gate released on **automated** off-site backup evidence (`final-parity --offsite-record`, [offsite-automation.md](offsite-automation.md)) instead of owner-attested hashes. The owner's backup-specific authorization remained mandatory and was cited in the final-parity record.

## What was released

| Item | Value |
| --- | --- |
| Migration | 028 → 029, `029_value_view_scale.sql` (changes three views; writes no data) |
| Migration 029 SHA-256 | `296bc757bc14f0fcd5136a16f4f8006ea74d630279acfef190cd77cd7a5932bd` |
| Gate | `g2-v3.gate.json`, SHA-256 `c3b5f91b44e912dadd96529a4af74a2bbda5f756fc290198463579a3ebf9428d` |
| Pinned commit | `59180b78a6cb111c74d28348302dcacb972f33ac` (protocol v2 enforced; has `--offsite-record`) |
| Restricted worktree | `~/tmp-bai/g2-release-v3` (migrations 001–029 only; 030 absent) |
| Backup | `g1-20261029T193408Z`, started 2026-10-29T19:34:08Z, eligible until 2026-10-30T01:34:08Z |
| Protocol-v2 manifest SHA-256 | `99a43d3f2cb37c3183efaf39c62a8087985524936e16ff3235b2e8c1ec79d8eb` |
| Encrypted archive SHA-256 | `59c7210f3e2f66084cb4b5477c5eb5cf18fb318bc36cfe109e80284497d4a321` (1,131,723 bytes) |
| Content-tree SHA-256 | `e1a9615d46e33a54ed2f34426c8de14767eb0fd3802afdfefc4a313bd4548885` |
| Automated verification record | `g1-20261029T193408Z.offsite-verification.json`; internal `record_sha256` `db03d932760e13f8b09245417f40008968879261e2c7222abbad36ed92ba9ebc` (file SHA-256 `911d933c0be7cd009808106327fa0693c22d2da4e5aca14afead94a801cdc7a4`) |
| Owner encryption key (primary fingerprint) | `47AB7918CDED25B47AE056C5E204499803387355` (public half only on the server) |
| Off-site destination | Google Drive, `gdrive:BAI-G1-backups/g1-20261029T193408Z/attempt-20261029T193636Z` (4 objects, `drive.file` scope) |
| Owner authorization | Phase A (backup) and a separate backup-specific Phase C authorization, 2026-10-29; text saved outside the repository, SHA-256 `eabe6ffa5787d61ff58e31cf0c7aa0dc561afe1d25d3aa530771aa750f91c4fe` |
| `final-parity` record | `g2-final-parity-20261029T194355Z.json` (file SHA-256 `4124d0be9622a5d2df60cb517b4dc59fcda816dc4b1c6b6fcb539f4aa9451c31`; expired after 10 minutes; evidence only) |

## Timeline (UTC) and results
1. **Phase A, 19:34–19:37.** `backup-run.mjs all --gate g2-v3.gate.json`: gate offline check, snapshot, logical export, snapshot verification, disposable restore check and strict hosted preflight at level 028 all PASS; encrypted (AES-256 OpenPGP), session key wrapped to the owner's public key, uploaded with provider MD5 match, fresh download byte-identical, decrypted with content hash and internal checksums equal to the backup, evidence accepted by the protocol-v2 check. **Automated Google Drive verification: PASS.** An independent re-check (`backup-run.mjs check`) and the release-evidence check both returned VERIFIED with zero problems.
2. **Identity re-validated, 19:43.** Gate and 029 checksums, pinned commit, clean worktree, 030 absent, backup 0.16 h old, hashes as authorized.
3. **`final-parity`, 19:43–19:45 (`--offsite-record … --offsite-recipient 47AB…7355`): FINAL PARITY OK.** Backup sound and within six hours; content hash equals the off-site verified one; strict preflight (level 028, checksum, every table byte-identical); fresh logical export identical to the backup's roles, schema, data and migration history.
4. **`db push`, 19:46:04–19:46:10: PASS.** Gate check including the read-only hosted-history check; the dry run listed exactly `029_value_view_scale.sql`; the parity record re-verified; the CLI applied `["029_value_view_scale.sql"]` with no seeds or roles. One push; no retry.
5. **`migrate.mjs --confirm-hosted dbnmktidheefoxaztivm`: PASS.** 029 recorded in the BAI ledger after verification against the Supabase history. (The temporary ledger lag described in [g1-release-record.md](g1-release-record.md#expected-order-of-operations--and-the-temporary-ledger-mismatch) was not observed because the post-migration check ran after this step.)
6. **`hosted-preflight --after 029`: PREFLIGHT OK.** Recorded level 029; Supabase history exactly up to 029; every recorded and pushed migration equals its committed file; every snapshot table unchanged in its original columns; no new tables. Row counts unchanged (e.g. 65 transactions, 1,612 players, 1,291 draft selections).

## Read-only closing checks (2026-10-29, after the release)
Both scripts were inspected first: neither can write to hosted. `security.mjs --read-only` runs one `begin read only` transaction behind a statement allow-list and sends HTTP GET/HEAD only; `parity.mjs` builds its reference on a throwaway local PostgreSQL and only SELECTs from the target. Both reach hosted only through the guarded `ownerDatabaseUrl()` (remote opt-in, host must match `BAI_SUPABASE_PROJECT_REF`).

* **`hosted:security` — SECURITY OK (read-only audit).** 80 functions audited (25 SECURITY DEFINER); none executable by PUBLIC, anon or authenticated; none with an unset `search_path`. 14 of 30 behavioural probes were plain SELECTs and ran; the 16 that write or call functions did not run (privileges verified from the catalog). Data API probes behaved as expected (internal schemas 401/406; public read 200). Notes, not failures: Supabase's own `public.rls_auto_enable()` event trigger is platform-managed; the certification gate is disabled with no enrolled reviewers (recorded since migration 021).
* **`hosted:parity` — PARITY OK.** Migrations compared: **29**; BAI-owned objects compared: 3,075; **BAI-owned differences: 0**; Supabase migration history: 29 versions, matching the files. One explained platform difference (`postgres` USAGE on schema `public`, granted by Supabase). Seed data is not compared (the target holds 198 import batches).

## Final state
* Hosted migration level **029**; Supabase history and BAI ledger both end at 029.
* **030 was not applied.** No second push, repair or retry.
* Gate, migration files and restricted worktree unchanged; hosted data unchanged.

## Notes for later gates
* The protocol-v2 manifest hash in the record is the `manifest_sha256` field inside `snapshot/manifest.json`; it is not the hash of that file.
* The automated evidence did not replace the owner's authorization, only the owner-attested recovery hashes.
* The private recovery key exists in one copy (the owner's computer); see the risk section of [offsite-automation.md](offsite-automation.md).
