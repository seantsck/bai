# Gate G1 — hosted migration 028: preflight result and authorization handoff

**Status: BLOCKED on one item (a restorable backup), everything else verified. G1 has not been executed and nothing in this document writes to the hosted database.**

Preflight run 2026-10-25 (≈ 18:40–19:30 UTC) from `main` `190b5e631b719c433dad5456f6a1963ed0cc2004`, read-only against the hosted BAI project, with disposable local PostgreSQL 17 for the rehearsals. The hosted connection used `begin read only`; the Supabase calls were read-only API reads.

## 1. Preflight results

| # | Item | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Exact BAI hosted project identity | **Verified** | Supabase project `BAI`, ref `dbnmktidheefoxaztivm`, region `ca-central-1`, `ACTIVE_HEALTHY`, PostgreSQL 17.11, created 2026-10-19. The connection URL's ref equals the configured `BAI_SUPABASE_PROJECT_REF`; database `postgres`; the five BAI schemas are present. The access token sees exactly one project, so no other project was listed or touched. |
| 2 | Hosted migration level is 027 | **Verified** | `bai_meta.schema_migrations`: 27 rows, highest `027`, no `028`. Supabase history: 27 versions. |
| 3 | 028's SHA-256 | **Verified** | `7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501` for `028_transaction_forensics_foundation.sql` on main (the raw file hash and the BAI checksum are equal). |
| 4 | No unrecognized schema changes | **Verified** | Catalog comparison with a clean reference built from migrations 001–027: 2,818 BAI-owned objects compared, **0 differences** (the one explained platform difference is Supabase's `USAGE` grant on `public`). All 27 recorded checksums equal the committed files; all 27 pushed statements equal their files statement for statement; the only committed-but-unpushed versions are 028, 029, 030. |
| 5 | Trade, player and WAR counts match the baseline | **Verified, exactly** | All 92 tables are byte-identical to the checksummed snapshot (manifest `b7f8858c845232f86a63416890b354d0ab6c23094a59db8e1469b2ef215b17a1`, taken 05:43 UTC the same day): 65 transactions, 83 packages, 111 assets, 1,612 players, 354 WAR observations. |
| 6 | A restorable backup and a documented restoration procedure exist | **BLOCKED** | See section 2. |
| 7 | 027→028 disposable rehearsal | **Verified** | On a database rebuilt from the snapshot (hosted's exact state): 028 applies in 0.1 s; +11 tables/views, +12 functions, +21 triggers, +92 columns (all in the new objects plus 3 nullable/default columns on `trade_package_assets`); the new tables are empty; the release migration guard accepts the database before and after. |
| 8 | Security audit passes | **Verified locally; not run on hosted** | `scripts/db/security.mjs` on the rehearsed 028 database: 62 behavioural attempts as `anon`/`authenticated`, SECURITY OK. The hosted run attempts writes (denied, rolled back), so it was **not** run in this read-only preflight; it is a post-G1 verification step below and needs your explicit approval as part of the authorization. |
| 9 | Historical draft and international records unchanged | **Verified** | The hosted comparison (item 5) covers every draft, international and release-audit table. After 028 on the rehearsal database: 92 existing tables unchanged in their original columns; the registries `internal_objects` (+6) and `provenance_fact_tables` (+2) only gained rows. |
| 10 | The pending 2025 draft release is unaffected | **Verified** | The release manifest (`8998d505afab06c8965c676427f0a9b5239a78944b8cad794f9a9868311e30f8`, 126 selections, 30 batches) verifies; applied to disposable copies of hosted at 027 and at 028 it gives the same preview (126 SAFE) and the same result (126 imported, 1,417 selections, identical row hash). The original release directory (254d0b1c0b591dc5 tree hash) is byte-identical before and after, and nothing under `research/` changed on main. Hosted holds 0 releases and 6 release audits. |

## 2. The blocker: no restorable backup

* **Platform backups:** none. The Management API reports `backups: null`, `pitr_enabled: false` (`walg_enabled: true` but no physical backup data). There is nothing to restore from if a migration went wrong.
* **Documented restoration procedure:** none existed in the repository.
* **What does exist, and what this PR adds:** a read-only, checksummed, row-for-row **snapshot** of all 92 BAI tables (`snapshot-hosted.mjs`), proven today to be byte-identical to hosted, and — new in this PR — `scripts/db/restore-snapshot.mjs`, a local-only restore into an empty database (schema from the migrations through the snapshot's level, then every row), verified end to end: 92 tables / 30,604 rows restored and `hosted-preflight.mjs` reports the restored copy byte-identical to the snapshot. `hosted-preflight.mjs` is read-only and doubles as the post-migration check.
* **Limits (honest):** the snapshot covers BAI-owned schemas and rows only, not Supabase platform state (auth, storage, role passwords, project settings); it sits on one workstation; and a restore *onto hosted* (a new project and re-pointing the app) is a separate procedure that has not been rehearsed. For 028 specifically the risk is low — the migration is additive, creates empty tables, rewrites no existing row, and the BAI runner and every rehearsal here apply it as one transaction (how the Supabase CLI behaves on an error was not rehearsed, so a failed push must be checked with `hosted-preflight --expect-level 027` before anything else) — but "low risk" is your decision, not mine.

**To unblock G1, choose one:**
1. **Accept the verified snapshot as the backup (free, recommended for 028).** Conditions: take a fresh snapshot *immediately* before G1 into a new directory (`BAI_BENCH_DIR=<new dir> node --env-file=.env.hosted.local scripts/db/bench/snapshot-hosted.mjs` — the script deletes its target, so never point it at an existing snapshot), copy it to a second location off this workstation, run `hosted-preflight.mjs --snapshot-dir … --expect-level 027` (must pass), and run `restore-snapshot.mjs` into a scratch database once more. This PR supplies the scripts; merging it is part of this option.
2. **Enable platform backups** (a paid plan feature, so it needs you), then re-check `supabase backups list`.
3. **Delay G1** until one of the above is in place.

## 3. Execution constraint found by the preflight — run G1 from a restricted working directory

`supabase/migrations` is a symlink to **all** committed migrations. With 029 and 030 on main, a plain `supabase db push` would apply **028, 029 and 030 together**, and `hosted:migrate` would refuse to record 028 alone (it requires every committed file to be pushed). Both were reproduced:

* emulating the CLI's history on a database at 027 plus a pushed 028: `migrate.mjs` run from a directory containing migrations 001–028 only **records 028** (`bai_meta` 27 → 28 rows); run from the full repository it **fails** ("migration 029 … is not applied") and records nothing;
* from a restricted directory, the real `hosted:supabase -- db push --dry-run` (read-only) lists exactly one migration: `028_transaction_forensics_foundation.sql`.

So G1 (and later G2, G3) must be executed from a **purpose-built working directory** whose `database/migrations` ends at the gate's migration:

```
git worktree add --detach ~/g1-workdir 190b5e631b719c433dad5456f6a1963ed0cc2004
cd ~/g1-workdir
rm database/migrations/029_value_view_scale.sql database/migrations/030_transaction_public_read_model.sql   # local, never committed
npm ci
ln -s <main checkout>/.env.hosted.local .env.hosted.local ; cp -r <main checkout>/supabase/.temp supabase/.temp
test "$(ls database/migrations | tail -1)" = 028_transaction_forensics_foundation.sql
```

## 4. Authorization statement (for you to approve, edit or reject — not yet given)

> **AUTHORIZATION — BAI production gate G1, hosted migration 028 only**
>
> I authorize exactly the following, and nothing else, on the hosted BAI database:
>
> 1. **Release commit:** `main` @ `190b5e631b719c433dad5456f6a1963ed0cc2004` (a later commit is acceptable only if `database/migrations/001`–`028` are byte-identical to it, which the checksum list below proves).
> 2. **Target:** Supabase project **BAI**, ref **`dbnmktidheefoxaztivm`**, region ca-central-1, database `postgres`, currently at migration 027.
> 3. **Migration:** `database/migrations/028_transaction_forensics_foundation.sql`, SHA-256 **`7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501`**. Migrations 029 and 030 are **not** authorized and must not be pushed; migrations 001–028 together have the checksum-list hash `43278e476a80866c4594a0baaffb5ef4a8bc1a35aa83d0e401224e00c68aa6da` (SHA-256 of the 28 lines `NNN:checksum`, joined by newlines, no trailing newline).
> 4. **Backup condition:** *(choose)* option 1 / 2 of section 2, completed and verified before the push.
> 5. **Method:** from the restricted working directory of section 3: `npm run hosted:supabase -- db push --dry-run` (must list only 028), `npm run hosted:supabase -- db push`, then `npm run hosted:migrate -- --confirm-hosted dbnmktidheefoxaztivm`.
> 6. **Expected database changes:** 11 new tables/views (`ingest.transaction_apply_ledger`; `public.transaction_external_ids`, `transaction_sources`, `transaction_source_links`, `transaction_conflicts`, `ptbnl_resolutions`, `season_calendar_events`; `research.transaction_verifications`; views `analytics.trade_asset_players`, `transaction_completeness`, `transaction_deadline_context`), all empty and internal (no grant to `anon`/`authenticated`); 12 functions and 21 triggers; three new columns on `public.trade_package_assets` (`amount_disclosure` null, `conditional` default false, `condition_text` null) with existing rows untouched; `analytics.trade_returns` is redefined with identical results; six rows added to `internal_objects` and two to `provenance_fact_tables`. No existing row is rewritten, no row is imported, no publication grant is created, the certification gate stays closed.
> 7. **Verification I authorize afterwards:** the commands in section 5, including `hosted:security` (which attempts writes as `anon`/`authenticated` and rolls them all back): *(yes / no)*.
> 8. **Stop conditions:** I want the work stopped, and nothing further attempted, on any condition in section 6.
>
> *Signed / date:*

## 5. Verification commands and expected results

Before the push (all read-only), from the restricted directory:

```
BAI_BENCH_DIR=<new dir> node --env-file=.env.hosted.local scripts/db/bench/snapshot-hosted.mjs        # the pre-G1 snapshot and backup
node --env-file=.env.hosted.local scripts/db/hosted-preflight.mjs --snapshot-dir <new dir>/snapshot --expect-level 027 \
     --expect-checksum 028:7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501          # PREFLIGHT OK
npm run hosted:supabase -- db push --dry-run                                                          # lists exactly one file: 028
```

After the push:

```
node --env-file=.env.hosted.local scripts/db/hosted-preflight.mjs --snapshot-dir <new dir>/snapshot --after 028     # PREFLIGHT OK: original columns of all 92 tables unchanged, only the two registries gained rows
npm run hosted:parity          # BAI-owned differences: 0 (run from the restricted directory so the reference is 001–028)
npm run hosted:security        # SECURITY OK   (writes attempted and rolled back; only if authorized in item 7)
npm run hosted:verify          # read-only hosted test file
npm run hosted:supabase -- db advisors --type all   # no new finding that mentions a 028 object
```

Expected: `bai_meta.schema_migrations` has 28 rows; hosted counts equal the snapshot's (65 / 83 / 111 / 1,612 / 354 / 1,291 / 297); the new tables hold 0 rows.

## 6. Stop conditions (any one: stop, do not retry, report)

* the dry-run lists anything other than `028_transaction_forensics_foundation.sql`;
* any checksum, project ref, migration level or snapshot comparison differs from this document;
* the pre-G1 `hosted-preflight` fails, or hosted changed since the snapshot;
* the push reports an error (nothing should be applied, but confirm that with `hosted-preflight --expect-level 027` before any other step; do not retry until the state is understood);
* `hosted:migrate` does not record exactly one migration (028);
* the post-check, parity or security audit reports anything other than the expected result;
* any request to apply 029 or 030, create a publication grant, import data, refresh a read model, enable certification, or deploy the application as part of this gate.

**Rollback:** 028 is additive; there is no automated down-migration. A failed push is expected to leave nothing (verify, do not assume). A successful but unwanted 028 is corrected by a new forward migration (028 is frozen once applied); data loss is not expected because no existing row is touched, and the pre-G1 snapshot is the restore source (`restore-snapshot.mjs` into a local database; a restore onto hosted needs its own authorization).
