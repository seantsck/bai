# G1 release protocol v2 — PROPOSAL (not active; needs the owner's written approval)

**Status: proposed.** The active G1 gate (`gate-g1-authorization.md`: a snapshot younger than 30 minutes when the push begins) is unchanged. Nothing here authorizes migration 028, a backup window, or any hosted action. Release identities stay pinned: commit `41cb3da70a8daef2b4792d1053c982a7e9fad349`, gate file SHA-256 `5d6103348404f162def5402d0c7eb5d7ef9e955897c85cdd4335368656f6a0bb`, migration 028 SHA-256 `7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501`, restricted worktree with 001–028 only. Migrations 029/030, imports, publication changes, read-model refreshes and deployments stay excluded.

## 1. Why change it

The 30-minute rule is a proxy for "hosted still equals the backup". Two attempts (2026-10-27, 2026-10-28) completed every technical check and failed only on the owner's manual path (encrypt → upload → fresh download → recovery check → authorization), which is real, valuable and slow: attempt 2 had an encrypted file 35 s before the deadline. Measured evidence that production is quiet and that the proxy can be replaced by a proof:

* Three snapshots (10-25 22:44Z, 10-27 23:54Z, 10-28 04:09Z) have the **same `manifest_sha256`** (`b7f8858c…17a1`).
* Their three full logical exports (`roles.sql`, `schema.sql`, `data.sql`, migration history) are **identical line for line** once pg_dump's random `\restrict` comment is ignored — across three days. `data.sql` includes the `auth` and `storage` data (33 COPY blocks), 68 `setval` sequence positions, and `schema.sql` includes every extension, grant and policy.
* The server's transaction counter still advanced (4437 → 4443 → 4444): Supabase's own services consume transaction IDs without changing any dumped content. So the counter is **not** a usable "nothing happened" proof; it is informational only.

## 2. Principle

A verified backup may authorize migration 028 iff **all** of: (a) it is encrypted, uploaded, downloaded independently and recovery-verified; (b) its age is within a bound the owner approves; (c) a strict, read-only comparison run immediately before the push proves hosted still equals the state the backup captured; (d) the owner gives a separate, backup-specific written authorization for 028. Time pressure moves from the slow human steps to a ~3-minute machine check.

## 3. What must be compared — and what today's preflight cannot see

| State | Compared by today's `hosted-preflight` | Proposed |
| --- | --- | --- |
| Row data of the 92 BAI tables (`public`, `ingest`, `research`), columns | **yes**, byte-identical | keep (≈25 s) |
| Migration level; `bai_meta` and Supabase history checksums | **yes** | keep |
| 028 file checksum | **yes** | keep |
| Schema objects: relations, RLS flags, constraints, indexes, views, function bodies, triggers, types, policies, grants, `bai_web` attributes | **no** (only the committed-reference parity tool `hosted:parity` looks, and against migrations, not against the backup) | diff against the backup (see below) |
| Extensions and versions (`extensions`, `vault` schemas), default privileges, event triggers, publications, platform roles | **no** | covered by the schema/roles export diff |
| Sequence positions | **no** | covered by the data export diff (`setval`) |
| `auth` / `storage` rows and other schemas | **no** | covered by the data export diff |
| Tables the snapshot does not know | yes (strict mode) | keep |
| Row-level write activity that leaves content identical (insert+delete, rolled-back writes, identical rewrites) | **no** | optional hardening: per-table `pg_stat_user_tables` insert/update/delete counters captured with the backup, guarded by `pg_postmaster_start_time()` and `stats_reset` (a restart or reset means "unprovable", not "fine") |
| Role passwords, project settings (Data API exposed schemas, API keys, network restrictions, SSL enforcement, domains), Vault secret values, storage object *files*, Vercel environment, plan/pause state | **no, and no database query can** | owner attestation at authorization time; optionally a read-only Management API settings capture saved with the backup and diffed |

**Table-byte parity is therefore not sufficient on its own.** The proposed minimum closes the schema, grant, policy, extension, role, sequence and platform-data gaps with tools that already exist: **re-run `logical-export.sh` at the final step and diff it against the backup's export** (strip lines containing `restrict`). It needs no new comparison code, is read-only, takes ≈2 minutes, and was shown above to be stable over three days. A `catalogSnapshot` capture-and-diff (the function behind `hosted:parity`, read-only SQL) is the recommended later hardening because it localizes a difference precisely.

## 4. Protocol

**Phase 0 — policy approval (once, written):** the owner approves this document (quoting the commit that contains it) including the age bound `A` (recommended **6 hours**; hard ceiling 24 h). Until then the active 30-minute gate stands.

**Phase A — backup and off-site proof (no migration authority, no short deadline; the age clock starts at T0 = snapshot start):**
1. Release identity checks; restricted worktree check (offline).
2. Snapshot, logical export, `verify-snapshot`; restore checks into a throwaway PostgreSQL 17; strict hosted preflight (logs outside the backup directory).
3. Owner: `Pack`, `Pull`, Drive upload, fresh Drive download, `Return`, `Check` (decryption, content hash, internal `SHA256SUMS`).
4. Owner message: "Off-site copy verified for backup <name>." with both hashes.

**Phase B — authorization:** the owner reviews Phase A evidence and signs a backup-specific authorization naming the backup, T0, the age bound and the identities above, and attesting that no platform setting or secret has been changed since T0.

**Phase C — release (all in one session, start to push ≤ 5 minutes; stop if the age bound `A` would be exceeded at push):**
1. Re-verify identity and the restricted worktree; `gate check --dry-run` lists exactly `028_transaction_forensics_foundation.sql`.
2. Final **read-only** preflight against the backup's snapshot: strict `hosted-preflight --expect-level 027 --expect-checksum 028:…`.
3. Fresh logical export into a NEW directory; normalized diff of `roles.sql`, `schema.sql`, `data.sql`, `supabase_migrations_history.json` against the backup's export: must be empty.
4. Check the clock: backup age ≤ `A`.
5. `db push` through the gate guard (028 only), `hosted:migrate`, `hosted-preflight --after 028`. Stop.

## 5. Failure conditions (stop, migrate nothing, retake the backup)

Any identity or hash mismatch; a dirty or widened worktree; a dry run listing anything but 028; hosted level not 027; any table difference; **any** non-empty export diff; backup age > `A`; the off-site verification missing or not for this backup; the authorization missing, expired, or naming another backup; a server restart evident between T0 and push; an unexplained failure of any step. A deviation is never waved through on judgment: it ends the attempt.

## 6. Differences from the active G1 gate

| | Active G1 gate | v2 proposal |
| --- | --- | --- |
| Freshness | snapshot < 30 min when the push begins | backup age ≤ `A` (6 h recommended) **and** strict proof hosted equals the backup at the final step |
| Off-site proof | must fit inside the 30 minutes | completes before the release phase; no deadline pressure |
| Comparison at push | table data + migrations | table data + migrations **+ full logical export diff** (schema, grants, policies, extensions, roles, sequences, auth/storage data) |
| Authorization | before/while the window runs | after Phase A evidence; backup-specific |
| Final read-only preflight | recommended | **required**, in the same ≤ 5-minute session as the push |
| Unchanged | identities, restricted worktree, gate guard, 028 only, owner passphrase handling, no-reuse of rehearsal backups | |

## 7. Not built yet

A wrapper that runs Phase C steps 2–4 and records their output; gate-guard integration (refuse `db push` without a passing final parity record and the age check); mutation tests (each row of §3 must be shown to be detected by changing it in a disposable database); the optional counters/settings capture. None changes the active gate until the owner approves this document and the tooling is reviewed and merged. Backups already taken (`g1-20261025T224416Z`, `g1-20261027T235441Z`, `g1-20261028T040939Z`) stay preserved and are **not** reused to authorize 028; `g1-20261028T040939Z` additionally still lacks its independent off-site recovery verification.

## 8. Credentials used by the release tooling

The release worktree holds a copy of the owner's hosted environment file (git-ignored, mode 600). It contains the database password, a Supabase access token and the project's keys. Every tool reads those values from the process environment, so the file need not sit inside a worktree: keep a single mode-600 copy outside any repository and pass it with `node --env-file=<path>` (and `set -a; . <path>`), and remove the extra copy when no window is imminent.
