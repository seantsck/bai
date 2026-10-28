# Gate G1 — release record: migration 028 applied to hosted BAI

**Status: COMPLETE (2026-10-28).** Migration `028_transaction_forensics_foundation.sql` — and nothing else — was applied to the hosted BAI project (`dbnmktidheefoxaztivm`). Hosted is at level **028**. Migrations 029 and 030 were not applied or recorded. No import, publication change, read-model refresh or deployment took place.

## What was released

| Item | Value |
| --- | --- |
| Release commit (merge of PR #49, protocol v2 active) | `8d742f3ac2ad6a21c260ddaf4c92aa3ca03a8714` |
| Gate file SHA-256 | `783a757b18ec707255c9a2babfdfb1c044f57f7aa220b5cc566a8e4fe6069621` |
| Migration 028 SHA-256 | `7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501` |
| Restricted worktree | `~/tmp-bai/g1-release-v2` (migrations 001–028 only) |
| Backup relied on | `g1-20261028T193747Z`, snapshot start 2026-10-28T19:37:48Z (expiry 2026-10-29T01:37:47Z) |
| Encrypted SHA-256 / content-tree SHA-256 | `d69fbc9d…4491` / `ab16b918…595b` |
| Owner authorization | Sean Cannon, 2026-10-28T20:46:50Z (backup-specific, protocol v2); off-site recovery verified by the owner |
| `final-parity` | 20:48 UTC, backup 1.17 h old; record `~/bai-gates/g1-final-parity-20261028T204810Z.json` (expired after 10 minutes; evidence only) |
| `db push` (028 only) | begun 20:50:17 UTC, finished 20:50:23 UTC |

## Timeline (UTC) and results
1. Identity re-validated (commit, gate, 028 checksum, 28 migration files, offline gate check including "release protocol v2 enforced").
2. `final-parity`: backup sound and ≤ 6 h, content hash equal to the off-site verified one; strict preflight (level 027, 028 checksum, all 92 tables byte-identical); fresh logical export identical to the backup's roles, schema, data and migration history.
3. `db push` from the restricted worktree: the gate dry run listed exactly 028; the parity record verified; the CLI applied only 028.
4. `hosted-preflight --after 028` — **first run FAILED one check** ("the recorded migration level is 028": BAI's own ledger still said 025–027). See the next section: this is expected.
5. `hosted:migrate --confirm-hosted dbnmktidheefoxaztivm` (restricted worktree) recorded 028 after verifying it against the Supabase history.
6. `hosted-preflight --after 028`: **PREFLIGHT OK, 100 checks.** Original columns and rows of every pre-existing table unchanged (registries only gained rows); eight new tables present; CLI migration list shows 028 local and remote.

## Expected order of operations — and the temporary ledger mismatch
There are **two** migration records on hosted, written by two different tools:

| Record | Written by | After `db push` |
| --- | --- | --- |
| Supabase history (`supabase_migrations`) | `supabase db push` (the gated `hosted:supabase -- db push`) | has 028 |
| BAI ledger (`bai_meta.schema_migrations`, with checksums) | `hosted:migrate` (`scripts/db/migrate.mjs`) | **still ends at 027** until `hosted:migrate` runs |

So every gate must run in this order, from the restricted worktree:
1. `final-parity` (write the record), then `BAI_GATE_FILE=… BAI_PARITY_RECORD=… node --env-file=<env> scripts/db/supabase-hosted.mjs db push` (within 10 minutes of the record).
2. `node --env-file=<env> scripts/db/migrate.mjs --confirm-hosted dbnmktidheefoxaztivm` — verifies the pushed statements against the committed files and records exactly the pushed migration. It refuses to run from a worktree that holds unpushed migrations (this is why it must run from the restricted one).
3. `hosted-preflight --snapshot-dir <backup>/snapshot --after <NNN>` — the final check.

**If `hosted-preflight --after NNN` is run between steps 1 and 2, it fails with exactly one failing check, "the recorded migration level is NNN" (`recorded` ends one version earlier), while "the Supabase history holds exactly versions up to NNN" and "every pushed migration equals its committed file" pass.** That is the ledger lag, not damage: run step 2 and repeat step 3. Any other failing check, or a failure that persists after step 2, is a real failure: stop, do not repair, report. (Seen on 2026-10-28; resolved by step 2 without any other action.)

## Not run — recorded honestly
The G1 row of `phase18-merge-and-release-plan.md` also lists `hosted:security` (read-only mode) and `hosted:parity` as post-checks. They were **not run** during this release (no hosted access was in scope after the preflight). They are read-only and can be run as a separate, explicitly authorized closing check before G2.

## Preserved evidence (do not delete)
* Backup `~/bai-backups/g1-20261028T193747Z/` (`snapshot/`, `export/`), its encrypted archive and companions, the owner's returned copy `returned-g1-20261028T193747Z/`, and the fresh comparison export `g1-20261028T193747Z.final-20261028T204810Z/`.
* The earlier backups (2026-10-25, -27, -28T04) and rehearsal copies; none was used to authorize 028.
* Logs: `~/tmp-bai/phaseA-g1-20261028T193747Z/` (snapshot, export, restore, preflight, final-parity, push, migration list, ledger recording, post-preflight).
* Gate files: `~/bai-gates/g1-v2.gate.json`; retired `~/bai-gates/retired/g1.gate.json.retired-pinned-41cb3da7`.
* 028 is now **frozen**: any change is a new migration.

## What 028 gave hosted
Eight new tables (`ingest.transaction_apply_ledger`, `public.ptbnl_resolutions`, `public.season_calendar_events`, `public.transaction_conflicts`, `public.transaction_external_ids`, `public.transaction_source_links`, `public.transaction_sources`, `research.transaction_verifications`) plus the transaction-completeness and trade-return analytics. Nothing is user-visible yet: the application at production still runs the pre-028 code, and no transaction is published.
