# Backup and recovery of the hosted BAI database (no paid services)

The hosted project has no platform backup (`pitr_enabled: false`, no scheduled backups; verified 2026-10-25 through the Management API) and a paid plan was declined. This is the free strategy: **two independent, locally verified copies of the same moment, plus an encrypted off-workstation procedure**. Every command below reads the hosted database read-only; nothing writes to it.

| Copy | What it is | Restores | Tool |
| --- | --- | --- | --- |
| **Snapshot** | every row of every BAI table (`public`, `ingest`, `research`) as checksummed NDJSON, from ONE `REPEATABLE READ, READ ONLY` transaction together with the migration level | all BAI data, row for row, into a schema rebuilt from the committed migrations | `scripts/db/bench/snapshot-hosted.mjs`, `restore-snapshot.mjs`, `verify-snapshot.mjs` |
| **Logical export** | `roles.sql` (no passwords), `schema.sql`, `data.sql` (COPY), Supabase's own migration history, produced by the scripts the official `supabase db dump` prints | the BAI schemas, privileges, policies, functions, triggers and data, in the form Supabase documents for restoring a project | `scripts/db/logical-export.sh`, `verify-logical-export.mjs` |
| **Encrypted file** | either of the above (or both), `tar` + `zstd` + GnuPG symmetric AES-256 in one file | — | `scripts/db/backup-pack.sh` |

## 1. Taking the copies (immediately before a gate; never into an existing directory)

```
B=~/bai-backups/<gate>-$(date -u +%Y%m%dT%H%M%SZ) ; mkdir -p -m 700 $B
node --env-file=.env.hosted.local scripts/db/bench/snapshot-hosted.mjs --out $B/snapshot          # consistent snapshot, verified on completion
set -a; . ./.env.hosted.local; set +a; scripts/db/logical-export.sh $B/export                      # roles + schema + data
node scripts/db/verify-snapshot.mjs $B/snapshot                                                    # manifest, per-file SHA-256, row counts, columns
```

* **Consistency.** The snapshot is a single transaction at `REPEATABLE READ` and `READ ONLY` (the server enforces both). The migration level and every table come from the same database snapshot; a write that commits while it runs appears in none of it. This is tested with a concurrent writer and with a `READ COMMITTED` control that does show the inconsistency (`tests/db/snapshot-consistency.test.mjs`). The manifest records the isolation level, PostgreSQL's snapshot descriptor and the server version. Earlier snapshots (the Phase 17 benchmark input) still verify and restore: the original manifest keys are unchanged. `snapshot-hosted.mjs` no longer deletes or overwrites anything; it refuses a non-empty target.
* **The two copies agree.** Taken minutes apart, the snapshot (92 tables, 30,604 rows, `manifest_sha256` `b7f8858c…17a1`) has the same manifest hash as the snapshot taken 13 hours earlier: nothing changed in between. The logical export is not byte-reproducible only because `pg_dump` 18 writes a random `\restrict` token into a comment on every run; the content is otherwise identical.
* **About the export.** The official `supabase db dump` runs `pg_dump` inside a Docker container; this user cannot reach the Docker socket, so `logical-export.sh` takes the exact scripts the CLI prints with `--dry-run` for the three documented dumps (`--role-only`; default schema; `--data-only --use-copy`), removes the placeholder connection lines, and runs them with the local `pg_dump`/`pg_dumpall` 18.6 against the server 17.11 (a newer client is supported). The session is also forced read-only (`default_transaction_read_only=on`). Passwords come from the environment; they are not written to any file.

## 2. Verifying that a copy restores

```
node scripts/db/restore-snapshot.mjs --snapshot-dir $B/snapshot --database-url postgresql://…@127.0.0.1:…/<new empty database>
node scripts/db/hosted-preflight.mjs --snapshot-dir $B/snapshot --expect-level 027        # on the restored database (BAI_DATABASE_URL): every table byte-identical
node scripts/db/verify-logical-export.mjs --export-dir $B/export --snapshot-dir $B/snapshot
```

Results of 2026-10-25 (disposable PostgreSQL 17, hosted untouched):

* **Snapshot restore.** 92 tables / 30,604 rows restored; the preflight reports every table, every column and every row equal to the snapshot (98 checks, 0 failed). A tampered row is detected.
* **Logical export restore.** `roles.sql`, `schema.sql`, `data.sql` run through `psql` into a PostgreSQL 17 that has none of the Supabase platform (minimal stand-in roles only). The restored rows equal the snapshot; the restored BAI catalog (2,818 objects: relations, columns, constraints, indexes, views, functions, triggers, policies, grants) equals a reference built from migrations 001–027 except six differences, each explained: `public.rls_auto_enable()` (Supabase's event-trigger function), the platform's `postgres` USAGE grant on schema `public`, and three views that `pg_dump` re-emits with explicit `AS text` aliases for unnamed columns. 36 restore errors occurred, all platform-only: one unavailable extension (`supabase_vault`/`pg_stat_statements`), the `supabase_realtime` publication, and 34 `auth`/`storage` data statements. Anything else would fail the verification.

## 3. What these copies cannot restore (recovery limitations)

* **Role passwords and platform roles.** `roles.sql` has no passwords and comments out the Supabase roles. After a restore: reset `bai_web`'s password (`npm run hosted:web-role`), and re-enroll any reviewer login (there are none enrolled on hosted today). The certification gate and reviewer rows are data and are restored.
* **Supabase platform state.** `auth`, `storage`, `realtime`, `vault`, project settings, API keys, the Data API's exposed-schema setting, network restrictions, custom domains, Edge/Vercel environment values. None of it is in either copy. BAI keeps nothing in `auth`/`storage`; the settings are re-entered by hand.
* **The CLI's migration history.** `db dump` excludes `supabase_migrations`; `logical-export.sh` saves it separately (`supabase_migrations_history.json`, 27 rows today). A restored project needs it re-created (`supabase migration repair --status applied 001 … 027`) before any `db push`, or the CLI would try to apply every migration again.
* **Extensions.** A new Supabase project must have `btree_gist`, `pgcrypto` and `uuid-ossp` enabled before `schema.sql` is run.
* **Restoring onto Supabase itself** (a new project, then re-pointing the application) follows Supabase's documented procedure (`psql --single-transaction --variable ON_ERROR_STOP=1 --file roles.sql --file schema.sql --command 'SET session_replication_role = replica' --file data.sql --dbname <new project>`), **but it has not been rehearsed here** — only restores into plain PostgreSQL 17 were. Treat it as untested until it is.
* **Point-in-time.** Neither copy is continuous: anything written after the copy is lost. For a gate that writes nothing but empty tables (028) that is acceptable; for the import gates it is not a substitute for taking a fresh copy immediately before.
* **One workstation.** Both copies live on one disk. The encrypted off-workstation copy below is what removes that.

## 4. The encrypted second copy (off this workstation)

```
scripts/db/backup-pack.sh pack   $B ~/bai-backups/<name>.tar.zst.gpg          # asks for a passphrase (gpg pinentry); prints the file and content hashes
scripts/db/backup-pack.sh verify ~/bai-backups/<name>.tar.zst.gpg $B          # decrypts to a temp dir, checks SHA256SUMS and the tree hash, deletes it
#   copy the single .gpg file (and its .sha256 / .tree-sha256 companions) to a second location: another disk, another machine, or a private store of your choice
scripts/db/backup-pack.sh unpack <file.tar.zst.gpg> <new empty directory>      # on any machine with gpg, tar and zstd
```

GnuPG symmetric AES-256 with a salted, heavily iterated key derivation; no network is used and **nothing is uploaded by these scripts**. The passphrase is typed into gpg's own prompt and never appears in a command line or the environment. Keep it in a password manager, *not* beside the file: without it the backup cannot be opened and no one can recover it. The procedure is tested end to end on synthetic data (round trip, no plaintext in the ciphertext, wrong passphrase refused, tampered file refused, overwrite refused; `tests/db/backup-pack.test.mjs`).

**Status:** the procedure is ready and tested; **the real encrypted second copy has not been created** — it needs your passphrase and your choice of destination, and no database content has been encrypted, copied off this machine or uploaded.

## 5. Order of use at a gate

1. snapshot + logical export + `verify-snapshot` + restore verification (section 2) — minutes before the gate;
2. `backup-pack.sh pack` + `verify`, then copy the encrypted file off the workstation (your decision where);
3. `hosted-preflight.mjs --expect-level <current>` immediately before the push;
4. after the gate: `hosted-preflight.mjs --after <NNN>` against the same snapshot.
