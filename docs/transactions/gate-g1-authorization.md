# Gate G1 — hosted migration 028: preflight, hardening and authorization handoff

**Status: READY FOR YOUR SIGNATURE, with two remaining conditions (section 6). G1 has not been executed. Nothing in this document, and nothing run to produce it, wrote to the hosted database. PR #43 is merged; the commit and gate hash below are real.**

First preflight 2026-10-25 ≈ 18:40–19:30 UTC; backup, audit and isolation hardening 2026-10-25 ≈ 19:00–21:00 UTC. Hosted was read through read-only transactions, read-only dumps and GET requests only, with disposable local PostgreSQL 17 for every rehearsal.

## 1. Preflight results

| # | Item | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Exact BAI hosted project identity | **Verified** | Supabase project `BAI`, ref `dbnmktidheefoxaztivm`, region `ca-central-1`, `ACTIVE_HEALTHY`, PostgreSQL 17.11. The connection's ref equals `BAI_SUPABASE_PROJECT_REF`; the five BAI schemas are present. The access token sees exactly one project. |
| 2 | Hosted migration level is 027 | **Verified** | `bai_meta.schema_migrations`: 27 rows, highest `027`, no `028`; Supabase history: the same 27 versions. |
| 3 | 028's SHA-256 | **Verified** | `7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501` (the raw file hash equals the BAI checksum). |
| 4 | No unrecognized schema changes | **Verified** | 2,818 BAI-owned catalog objects compared with a clean 001–027 reference: **0 differences**. All 27 recorded checksums and all 27 pushed statements equal the committed files; the only committed-but-unpushed versions are 028, 029, 030. |
| 5 | Trade, player and WAR counts | **Verified, exactly** | All 92 tables are byte-identical to the checksummed snapshot: 65 transactions, 83 packages, 111 assets, 1,612 players, 354 WAR rows. A second snapshot taken 13 hours later with the new consistent method has the **same** `manifest_sha256` (`b7f8858c…17a1`): nothing changed. |
| 6 | A restorable backup and a documented restoration procedure | **Verified (free strategy)** | `backup-and-recovery.md`. A consistent snapshot and a Supabase-compatible logical export were taken, restored into fresh PostgreSQL 17 databases and verified (section 2). The encrypted off-workstation copy is a tested procedure, **not yet created** (condition 2, section 6). |
| 7 | 027→028 disposable rehearsal | **Verified** | On a database restored from the new snapshot: 028 applies in well under a second, +11 tables/views, +12 functions, +21 triggers; existing rows untouched; the release migration guard accepts the database before and after. |
| 8 | Security audit | **Verified, locally in full and on hosted in read-only mode** | Full behavioural audit on the rehearsed 028 database: SECURITY OK (62 attempts as `anon`/`authenticated`). Hosted: the new **read-only** audit — 14 SELECT probes per public role, 68 functions and the whole catalog, 8 HTTP requests all `GET` — SECURITY OK (section 3). |
| 9 | Historical draft and international records unchanged | **Verified** | Hosted equals the snapshot in every draft, international and release-audit table; after 028 on the rehearsal database `hosted-preflight --after 028` reports all 92 tables unchanged in their original columns (only `internal_objects` +6 and `provenance_fact_tables` +2 gained rows). |
| 10 | The pending 2025 draft release is unaffected | **Verified** | The manifest (`8998d505…e30f8`, 126 selections) previews 126 SAFE and applies identically on disposable copies of hosted at 027 and at 028 (same 1,417 selections, same row hash); the original release directory is byte-identical before and after; nothing under `research/` changed on main. Hosted holds 0 releases and 6 audits. |

## 2. Backup and restore (assignment A)

Details, commands and limits are in `backup-and-recovery.md`. Results:

* **Snapshot** (`snapshot-hosted.mjs`, rewritten): one `REPEATABLE READ, READ ONLY` transaction; the migration level and all 92 tables from the same database snapshot. A test commits a write from a second session in the middle of the snapshot: it appears in no part of it; a `READ COMMITTED` control shows the inconsistency the guarantee removes. Earlier snapshots still verify and restore; the script no longer deletes or overwrites any directory (the Phase 17 benchmark snapshot is untouched and still verifies).
* **Archive verification** (`verify-snapshot.mjs`): manifest, SHA-256 of every file, row counts, columns, no unlisted file, `manifest_sha256` — 92 tables, 30,604 rows, OK; tampered byte, missing or extra file, wrong count are each detected.
* **Restore** into a fresh PostgreSQL 17: 92 tables / 30,604 rows; `hosted-preflight` reports every table, original column and row equal to the snapshot (98 checks, 0 failed); a tampered row is detected.
* **Logical export** (`logical-export.sh`, the three scripts the official `supabase db dump --dry-run` prints, run with the local `pg_dump` 18.6 because Docker is not available to this user): `roles.sql` 770 B (no passwords), `schema.sql` 391 KB, `data.sql` 7.3 MB, the CLI's migration history (27 rows), `SHA256SUMS`. Restored into plain PostgreSQL 17 with stand-in platform roles: rows equal the snapshot; the restored catalog equals the migrations' except six explained differences; 36 platform-only errors, no other. What it cannot restore (role passwords, the Supabase platform's own state, the CLI migration history until repaired, extensions to enable, and a restore onto Supabase itself, which is **not rehearsed**) is listed in `backup-and-recovery.md`.
* **Encrypted copy:** `backup-pack.sh` (GnuPG symmetric AES-256 over tar + zstd) round-trips on synthetic data, leaks no plaintext, refuses a wrong passphrase, a tampered file and an overwrite. No database content has been encrypted, copied off the machine or uploaded.

## 3. The hosted security audit is read-only (assignment B)

`scripts/db/security.mjs` was split into `scripts/db/lib/security-audit.mjs` with two explicit modes. Your decision stands: **the previous hosted command is withdrawn.**

| Probe class | Where it runs now |
| --- | --- |
| Catalog and permission checks (grants, RLS, policies, view/function settings, reviewer boundary, `bai_web`) | both modes (SELECTs only) |
| SQL write, DDL and function-call probes run as `anon`/`authenticated` and rolled back (16 of the 30) | FULL mode only — a **disposable local** database |
| SELECT probes run as the public roles (14 of the 30) | both modes |
| HTTP POST/PATCH/DELETE Data API probes (4) | FULL mode only, and only if both the database and the Data API URL are local; a hosted Data API never receives one |
| HTTP GET probes (Management API exposed-schemas lookup; 7 Data API reads) | both modes |

READ-ONLY mode (`--read-only`; `npm run hosted:security` is now exactly this): one `begin read only` transaction (the server refuses any write, even from a function), a client-side allow-list (select / show / with, savepoints, `set local role anon|authenticated` only; a multi-statement string is refused), and an HTTP wrapper that throws on anything but GET/HEAD. **A non-local database without `--read-only` is refused before any connection is made** (exit 2); there is no flag, environment variable or failure path that turns READ-ONLY into FULL. Tests (`tests/db/security-readonly.test.mjs`): the statement log of a read-only run contains no mutating statement; PostgreSQL's own tuple counters show 0 inserted/updated/deleted tuples (with a calibration showing the counter does see a rolled-back insert); the HTTP stub saw only GET; the guard refuses 17 kinds of non-read statement; FULL refuses a non-local target; the CLI refuses a hosted-looking URL without connecting.

Run on hosted today: **SECURITY OK, mode READ-ONLY**, 68 functions audited, 30 probe results, 8 HTTP requests (1 Management API GET, 7 Data API GETs), 0 failures. Two other existing hosted commands also write inside a rolled-back transaction and are **not authorized**: `hosted:verify` (inserts fixtures, including a publication-grant row, and runs `refresh_read_models()`) and `hosted:rehearse` (executes migrations); they stay local.

## 4. Migration isolation (assignment C)

Tooling: `scripts/db/gate.mjs` + `lib/gate.mjs`; the refusal is in `scripts/db/supabase-hosted.mjs`. A *gate file* (JSON; its SHA-256 is quoted in the authorization) pins the commit, the migration, the checksums of 001–028 and their list hash, and the project ref.

1. **Exact reviewed code commit.** `gate create` refuses a commit that is not an ancestor of `origin/main`; `gate check` demands `HEAD` equal the gate's commit and a working tree with no change except the removal of later migrations.
2. **001–028 and nothing later.** `gate workdir` makes a detached worktree at that commit with 029 and 030 deleted; `gate check` refuses any migration later than the gate's, a missing or altered earlier one (per-file checksum and the list hash), a stray file.
3. **Dry run lists exactly 028 — shown on the real hosted project (read-only), with the real gate (commit `41cb3da…`).** Verbatim, from the restricted directory:

   ```
   DRY RUN: migrations will *not* be pushed to the database.
   Connecting to remote database...
   Would push these migrations:
    • 028_transaction_forensics_foundation.sql
   {"upToDate":false,"dryRun":true,"migrations":["028_transaction_forensics_foundation.sql"],"seeds":[],"roles":[],"message":"Finished supabase db push."}
   ```

   `gate check --dry-run` there: `GATE CHECK OK` (commit and working directory; migration files and checksums; project reference; hosted migration history, read-only; dry run lists exactly the gate migration). The restricted worktree had 28 migrations (001 … 028), no 029/030, and its `git status` showed only the two removed files. From the full repository the same dry run lists 028, 029 **and** 030 and the gate check fails (shown earlier with a rehearsal gate) — the hazard is real and the guard catches it.
4. **029/030 cannot be applied by accident.** They do not exist in the restricted directory; `db push` is refused unless `BAI_GATE_FILE` names a gate file, `gate check --dry-run` passes and no widening flag (`--include-all`, `--include-roles`, `--include-seed`, `--db-url`) is present; the recording step (`hosted:migrate`) cannot record 028 from the full repository. Tested with a fake `supabase` binary that logs its calls: every refusal case produced no `push` call, and the authorized case produced exactly `db push --linked` (`tests/db/gate-guard.test.mjs`, 7 tests). **The real `db push` was never run.**
5. **Unexpected changes are refused:** a different project ref (environment, `supabase/.temp`, or the connection), a changed migration or checksum, a drifted commit, a modified working tree, hosted at a different level than the gate's starting level, extra or missing versions in `bai_meta` or the Supabase history, a recorded checksum that differs from the file.

## 5. The authorization statement for your signature

Identity (all verified on 2026-10-25 after the merge):

| | |
| --- | --- |
| PR #43 merge commit = the gate's code commit | `41cb3da70a8daef2b4792d1053c982a7e9fad349` (parents: `190b5e6…` and PR head `6bcaa2b…`; tree identical to the tested candidate) |
| Gate file | `~/bai-gates/g1.gate.json`, 2,545 bytes, SHA-256 **`5d6103348404f162def5402d0c7eb5d7ef9e955897c85cdd4335368656f6a0bb`**; regenerates byte-identically with the command in the statement |
| `migrations_hash` (001–028) | `43278e476a80866c4594a0baaffb5ef4a8bc1a35aa83d0e401224e00c68aa6da` — equals the required value, and recomputed from the 28 checksums in the file |
| Migration 028 SHA-256 | `7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501` — equals the required value, the gate file's entry, and `git show 41cb3da:database/migrations/028_…sql | sha256sum` |
| CI on `main` @ `41cb3da` | `check` succeeded; Vercel: "Canceled by Ignored Build Step" (production build skipped), 0 deployments |
| `npm run check` on the merge candidate and again on `main` | exit 0, 51 / 104 / 294 tests passed, 0 failed (2 skips from missing local caches) |

> **AUTHORIZATION — BAI production gate G1, hosted migration 028 only**
>
> I authorize exactly the following, and nothing else, on the hosted BAI database:
>
> 1. **Code commit:** `41cb3da70a8daef2b4792d1053c982a7e9fad349` (the merge commit of PR #43 on `main`).
> 2. **Gate file:** `node scripts/db/gate.mjs create --gate G1 --commit 41cb3da70a8daef2b4792d1053c982a7e9fad349 --through 028 --project-ref dbnmktidheefoxaztivm --out <gate.json>`; the file's SHA-256 must be **`5d6103348404f162def5402d0c7eb5d7ef9e955897c85cdd4335368656f6a0bb`** and its `migrations_hash` **`43278e476a80866c4594a0baaffb5ef4a8bc1a35aa83d0e401224e00c68aa6da`**.
> 3. **Target:** Supabase project **BAI**, ref **`dbnmktidheefoxaztivm`**, region ca-central-1, database `postgres`, now at migration 027.
> 4. **Migration:** `database/migrations/028_transaction_forensics_foundation.sql`, SHA-256 **`7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501`**. Migrations 029 and 030 are **not** authorized and must not be pushed or recorded.
> 5. **Backup condition, all met before the push, on the day:** a fresh consistent snapshot and logical export (taken no more than 30 minutes before the push), `verify-snapshot` and `hosted-preflight --expect-level 027` passing; the encrypted file made by me in my own terminal with my passphrase from my password manager; copied to my private Google Drive folder *(name: ______)*; and a **fresh download** of it passing `backup-offsite.sh check` (`offsite-backup.md`), reported to the assistant as "off-site copy verified".
> 6. **Method:** from the restricted working directory created by `gate.mjs workdir`: `gate.mjs check --dry-run` (must pass), then `BAI_GATE_FILE=<gate.json> npm run hosted:supabase -- db push`, then `npm run hosted:migrate -- --confirm-hosted dbnmktidheefoxaztivm`.
> 7. **Expected changes:** 11 new empty internal tables/views (`ingest.transaction_apply_ledger`; `public.transaction_external_ids`, `transaction_sources`, `transaction_source_links`, `transaction_conflicts`, `ptbnl_resolutions`, `season_calendar_events`; `research.transaction_verifications`; `analytics.trade_asset_players`, `transaction_completeness`, `transaction_deadline_context`), 12 functions, 21 triggers, three new columns on `public.trade_package_assets` (`amount_disclosure` null, `conditional` false, `condition_text` null) with every existing row untouched, `analytics.trade_returns` redefined with identical results, six rows added to `internal_objects` and two to `provenance_fact_tables`. No existing row rewritten; no data imported; no publication grant; the certification gate stays closed; no read model refreshed; nothing deployed.
> 8. **Verification I authorize afterwards (all read-only):** `hosted-preflight --after 028`, `npm run hosted:security` (read-only mode only), `npm run hosted:parity` run from the restricted directory, `npm run hosted:supabase -- db advisors --type all`. I do **not** authorize `hosted:verify`, `hosted:rehearse` or any mutating mode of the security audit.
> 9. **Stop conditions:** any in section 7; on any of them nothing further is attempted.
>
> *Signed / date:*

## 6. Remaining conditions before G1 can run

PR #43 is merged and the gate identity is real, so the first two conditions of the earlier draft are done. What remains:

1. **The real off-machine copy**, made and verified by you on the day, following `offsite-backup.md`: your passphrase (typed into gpg in your own terminal), your private Google Drive folder, a fresh download that passes `check`, and your message "off-site copy verified". **No day-of copy exists.** The procedure was rehearsed successfully on 2026-10-27 on the 2026-10-25 backup (see `offsite-backup.md` §6: encrypted file `445743098f74…cdec5`, content tree `a4ddf6d01f8d…29c5`, owner-reported Drive upload, fresh download, decryption and content check), which proves the route but not a copy fit for the push: that backup is more than a day old. The safeguards (`backup-offsite.sh`: byte-level outer-packet check of the ciphertext, typed destination, hash re-verification, no passphrase handling, no network code) are built and tested.
2. **Your signature** on the statement above.

Not blockers: the platform backup (declined; replaced by the verified free strategy), the hosted security audit (read-only now), the 029/030 isolation (proved, tested, shown on the real hosted dry run). Residual risks, stated plainly: the Supabase CLI's behaviour when a push fails part-way was not rehearsed (so a failed push must be followed by `hosted-preflight --expect-level 027` before anything else), and a restore onto a new Supabase project was not rehearsed (only plain PostgreSQL 17).

## 7. Stop conditions (any one: stop, do not retry, report)

* `gate check --dry-run` fails, or the dry run lists anything other than `028_transaction_forensics_foundation.sql`;
* any checksum, project ref, migration level, gate-file hash or snapshot comparison differs from this document or the signed statement;
* the pre-push `hosted-preflight` fails, hosted changed since the snapshot, or the snapshot is more than 30 minutes old at push time (take a new one);
* the owner has not reported "off-site copy verified" for a fresh download of the encrypted file, or any plaintext export is about to leave `~/bai-backups/`;
* the push reports an error (verify with `hosted-preflight --expect-level 027` before anything else; do not retry until understood);
* `hosted:migrate` does not record exactly one migration (028);
* the post-check, parity or the read-only audit reports anything other than the expected result;
* any request to apply 029 or 030, create a publication grant, import data, refresh a read model, enable certification, run a mutating hosted check, or deploy the application as part of this gate.

**Rollback:** 028 is additive; there is no automated down-migration. A failed push is expected to leave nothing (verify, do not assume). A successful but unwanted 028 is corrected by a new forward migration (028 is frozen once applied); no existing row is touched, and the snapshot and export taken before the push are the restore sources (`backup-and-recovery.md`).
