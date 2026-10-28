# G1 release protocol v2 — implementation (ACTIVE once the activation commit is merged; before that it was inactive)

Implements the minimum of the design approved in principle on PR #47 (`189d4708888cc1bdaa97ae323446ad26c7aa67a2`): a six-hour backup age, off-site evidence tied to the backup's content, and a final read-only comparison immediately before the push. **The active G1 gate (30-minute) is replaced by protocol v2 only for gates pinned to the activation commit or later.** Nothing here applies a migration, starts a window or touches hosted by itself.

## What was added
* `scripts/db/final-parity.mjs` (+ `scripts/db/lib/final-parity.mjs`; `npm run hosted:final-parity` for a copy of the env file in the working directory, otherwise call `node --env-file=<path>` directly). Read-only. In order, stopping at the first failure (exit 1, **no record written**):
  1. the backup directory is sound (`verify-snapshot` rules, `export/SHA256SUMS` for roles, schema, data and migration history), **at most six hours old** (the OLDEST of the manifest `taken_at`, the `g1-<UTC>` directory name and the manifest file time), at the gate's starting migration level, and its **content-tree hash equals the off-site verified hash** (`--offsite-tree`);
  2. the strict `hosted-preflight` (level, 028 checksum, every table byte-identical to the backup's snapshot);
  3. a **fresh `logical-export.sh`** into a new directory outside the backup, compared with the backup's export after removing only pg_dump's random `\restrict`/`\unrestrict` lines (also in their `-- \restrict` comment form). Only file names and line numbers are reported, never data;
  4. a short-lived (10 minute), mode-600, self-hashed record (`kind g1-final-parity`) naming the gate, the backup (manifest hash, content hash), the off-site hashes and the owner authorization reference.
* `scripts/db/supabase-hosted.mjs` re-verifies that record from the files before any `db push`: hash intact, PASS, same gate, within 10 minutes, backup directory unchanged and ≤ 6 hours old *at push time*, off-site tree hash equals this backup's. It runs when `BAI_PARITY_RECORD` is set, when `BAI_REQUIRE_PARITY_RECORD=1`, or **always once `PROTOCOL_V2_ENFORCED` in `scripts/db/lib/final-parity.mjs` is changed to `true`** — that reviewed one-line change is the activation. On the activation commit it is `true`; before that commit it was `false`.
* Tests (`tests/db/final-parity.test.mjs`, a case in `tests/db/gate-guard.test.mjs`; disposable PostgreSQL, a stand-in exporter): the unchanged control passes; a changed row, a new row, a migration record, a grant, an RLS policy, a function, an RLS flag, a **sequence position** and a role attribute each fail closed (the last six are invisible to the table-byte preflight, which passes while the export comparison fails); a tampered export or snapshot file, a missing export file, a wrong off-site hash, a backup 6.5 hours old, a wrong migration level, a record inside the backup, an existing record, and `--export-script` against a non-local database are refused; the record is refused when altered, expired, future-dated, FAIL, for another gate, naming other off-site evidence, with the backup changed afterwards or too old at push time; the guard never reaches the CLI in any refusal.

## Checked against the real backups (read-only, offline)
`contentTreeHash` of `g1-20261028T040939Z` equals the value `backup-pack.sh` recorded (`93c45473…2c73`); `verifyBackupDir` passes on it; the three real exports (2026-10-25, -27, -28) compare **identical** under the precise normalization. (Correction to the proposal: the first offline check used `grep -v restrict`, which is too broad; the precise filter gives the same result, and in `data.sql` the lines are `-- \restrict …` comments.)

## Execution path, and why the gate must be re-pinned (security review, 2026-10-28)

The push is `node scripts/db/supabase-hosted.mjs db push` run **inside the restricted checkout**. Every piece is that checkout's own: the entry point and the guard it imports, `gate.mjs check` (spawned from the checkout, `repoRoot` = the checkout), the Supabase CLI (`node_modules/.bin/supabase`, a symlink to main's installed packages) run with the checkout as working directory, and the migration files (`supabase/migrations` → `../database/migrations`, 001–028 only). **Main's guard never runs.** The current restricted checkout is at `41cb3da7`, which has no `final-parity` code: flipping `PROTOCOL_V2_ENFORCED` on main would not protect a push from it (verified: its `supabase-hosted.mjs` contains no parity check).

Correction (this PR): a gate can only pin, and `gate check` can only pass on, a commit whose OWN `scripts/db/lib/final-parity.mjs` sets `PROTOCOL_V2_ENFORCED = true` (`gate.mjs create` refuses otherwise — it refuses `41cb3da7` today; `gate check` reports "does not enforce release protocol v2"). So the release must be re-pinned to the reviewed activation commit on main: **the migration files are unchanged** (001–028 are identical between `41cb3da7` and main; the 028 checksum `7598519f…b501` and the `migrations_hash` stay the same), but the gate's commit and the gate file's SHA-256 change, and the owner's authorization must name the new ones. The old gate file and the `41cb3da7` checkout must be retired (their old code cannot know about protocol v2; that is the one path code cannot close).

The guard has no protocol-v1 fallback once enforced: the constant makes the record mandatory, `BAI_REQUIRE_PARITY_RECORD` can only add the requirement, and a missing library aborts before the CLI. Tested end to end with the exact command, a fake CLI and a disposable database: no record, a missing file, an expired, altered or FAIL record, a record for another gate, another backup, another archive hash or another content hash, a backup changed afterwards, and a vanished round-trip copy are all refused with no push; a valid record gives exactly one `db push --linked`.

## Off-site evidence and owner authorization: what is checked, what is attested
* **Checked by code** (wrapper and push guard): the encrypted archive beside the backup (`<dir>.tar.zst.gpg`) exists, is an AES-256 OpenPGP file by its outer packets, and its SHA-256 and both companions equal the reported hashes; the reported content hash equals the backup directory's recomputed hash; the copy that came back from the owner's round trip (`returned-<name>/<name>.tar.zst.gpg`) exists and is byte-identical. A typed hash alone is not accepted as proof of anything.
* **Attested by the owner, not provable by code:** that the round trip went through the private Restricted Google Drive folder, and that the returned copy **decrypted** with the content hash and internal `SHA256SUMS` passing (`backup-offsite.sh check` / Windows `Check`; decryption needs the passphrase, which the tools never see). Likewise the separate backup-specific authorization: the record only carries its reference text; whether it exists, names this backup and is in force is checked by the operator against the owner's message before running the push.

## Operating it (after activation is approved)
```
E=/home/prismadmin/projects/bai/.env.hosted.local           # the one mode-600 original; no copy inside any worktree
# once: re-pin to the activation commit A on main (same migration files), then make the restricted checkout from it
node scripts/db/gate.mjs create --gate G1 --commit <A> --through 028 --project-ref dbnmktidheefoxaztivm --out ~/bai-gates/g1-v2.gate.json
node scripts/db/gate.mjs workdir --gate ~/bai-gates/g1-v2.gate.json --dir ~/tmp-bai/g1-release-v2
# Phase C, within six hours of the snapshot start
cd ~/projects/bai-ci && node --env-file=$E scripts/db/final-parity.mjs --backup-dir ~/bai-backups/g1-<UTC> --gate ~/bai-gates/g1-v2.gate.json \
    --record ~/bai-gates/parity-<UTC>.json --offsite-sha256 <encrypted hash> --offsite-tree <tree hash> --authorization-ref "<owner message and time>"
cd ~/tmp-bai/g1-release-v2 && BAI_GATE_FILE=~/bai-gates/g1-v2.gate.json BAI_PARITY_RECORD=~/bai-gates/parity-<UTC>.json node --env-file=$E scripts/db/supabase-hosted.mjs db push
```

## Limits (unchanged from the proposal; not implemented here)
Role passwords, project settings, Vault secrets and storage files remain outside any database comparison (owner attestation). Transaction-counter and settings monitoring are deferred. The record is a local file: the guard re-derives everything from the backup directory and the gate, but a person with shell access could forge a record by hand; the controls are procedural as well as technical. The restore of a backup onto Supabase itself remains unrehearsed.

## Credentials
The duplicate hosted environment file in the release worktree was removed after the release tools were shown to work from the original (mode 600): offline gate check from the worktree with `--env-file=<original>`, sourcing for the export script, and the required variables present. Only the original remains.
