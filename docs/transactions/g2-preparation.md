# Gate G2 — hosted migration 029 (value-view scale): preparation record and production runbook

**Status: PREPARED, NOT EXECUTED (2026-10-28).** Nothing here has touched hosted. Hosted BAI is at migration **028** (G1 complete, [g1-release-record.md](g1-release-record.md)). Production execution needs, in this order: a fresh protocol-v2 backup, the owner's independent off-site verification, the owner's backup-specific authorization, the final parity check and a gate-checked push. None of those has been requested.

## 1. Release identity (prepared locally)

| Item | Value |
| --- | --- |
| Migration | `029_value_view_scale.sql`, SHA-256 `296bc757bc14f0fcd5136a16f4f8006ea74d630279acfef190cd77cd7a5932bd` |
| Pinned commit | `3f71263d1202ef9622b3240edd779c0271a93878` (`main` after PR #51; its own `final-parity.mjs` sets `PROTOCOL_V2_ENFORCED = true`; an ancestor of `origin/main`) |
| Gate file | `~/bai-gates/g2-v2.gate.json` (mode 600), SHA-256 `f63ed1e9d4ea6e5cc300e6959089ce057c980a71e0d820e6d186bb0cd3ffc309` |
| Starts from / through | level 028 / 029; project `dbnmktidheefoxaztivm` |
| Checksums | 001–029; **001–028 are identical to the G1 gate's**; `migrations_hash` `7298dce767ec0c9816d870f07a8a2053f7e39d823732a64c4540fde5d891a3df` |
| Restricted worktree | `~/tmp-bai/g2-release`: detached at the pinned commit, 29 migration files (001–029), **030 absent** (its only change is that deletion), `node_modules` symlinked, `supabase/.temp` link metadata copied, **no credentials file** (pass `node --env-file=/home/prismadmin/projects/bai/.env.hosted.local`) |
| Offline gate check | `GATE CHECK OK` (commit, "release protocol v2 enforced", migration checksums, project reference) |

The pinned commit does not need to be the latest `main`: documentation merged later does not change the gate. Re-pin only if code under `scripts/db/` or `database/migrations/` changes.

## 2. Rehearsal evidence (local only, 2026-10-28)
Data: the verified G1 backup `g1-20261028T193747Z` (snapshot manifest `b7f8858c…17a1`, hosted at level 027 at the time), restored into a disposable local PostgreSQL 17; 028 then 029 applied locally from `main` (the originals of the backup, archive and returned copy are unchanged: the combined hash `77034a16…` was identical before and after).

* **Restore:** 92 tables / 30,604 rows at level 027; `hosted-preflight --expect-level 027` against the manifest: PREFLIGHT OK. Checkpoints: `g2_028` (immediately after 028) and `g2_029`.
* **Expected catalog differences 028 → 029:** of 3,074 BAI-owned catalog objects, exactly four: the `migration|029` row and the redefinition of the views `analytics.trade_returns`, `analytics.acquisition_value`, `analytics.class_value`. **No grant, policy, column, constraint or privilege difference** (the trailing `revoke all` on `analytics` is a no-op against the 028 state).
* **Identical results** (columns, complete result sets, row counts and SHA-256 of the canonical row dump; old = new):

| View | 65 trades (hosted-sized) | 401 trades (336 local Retrosheet candidates, batch `71cea0b7…`) |
| --- | --- | --- |
| `trade_returns` | 166 rows, `f8e9589e…` | 1,518 rows, `9628230c…` |
| `acquisition_value` | 3,176 rows, `52996819…` | 3,176 rows, `52996819…` |
| `class_value` | 350 rows, `51656455…` | 350 rows, `51656455…` |

  The full-view comparison is against the reference views (`make-reference.mjs`: the old definition with `trade_returns` evaluated once); the reference was confirmed against the real old views on bounded runs: `trade_returns` in full, `acquisition_value` for the fixed 15-player sample (28 rows / 30 rows), `class_value` for LAD and the whole `class_value` evaluated club by club. All IDENTICAL.
* **Performance** (seconds, old → new, two runs; the old side capped at 120 s, so "NOT COMPLETED >120 s" is a censored result, not a measured time):

| Query | 65 trades | 401 trades |
| --- | --- | --- |
| `trade_returns` | 0.33 → 0.034 | 8.3 → 0.11 |
| `acquisition_value`, 15-player sample | 7.5 → 0.10 | NOT COMPLETED >120 → 0.13 |
| `acquisition_value`, full | NOT COMPLETED >120 → 0.72 | NOT COMPLETED >120 → 1.22 |
| `class_value`, LAD | 2.1 → 0.68 | 21.4 → 1.16 |
| `class_value`, whole | 2.7 → 0.72 | 21.4 → 1.21 |

  (An earlier uncapped run, 2026-10-25, measured the old full `acquisition_value` at 744 s at 65 trades; this rehearsal did not repeat it.) The draft explorer view is unchanged (about 0.005 s). The three local tests ran concurrently with the benchmark, so timings carry minor noise.
* **Tests:** `value-view-parity`, `shared-value`, `value-attribution`: 16 of 16 pass. With the gate, final-parity, off-site and OpenPGP tests: 45 of 45 pass.
* **Known reporting defect of `scripts/db/bench/parity.mjs` (NOT fixed, recorded only).** In `--per-org` mode the old rows are ordered with JavaScript's default string sort while the new rows come out of SQL `order by` under the database collation (`en_US.UTF-8`). The multiset comparison is correct (`identical = true`), but the two reported hashes differ (`7119aff2…` vs `51656455…`). Sorting both sides the same way gives `7119aff2…` for both (equal to the hash first recorded on 2026-10-25). Not a data discrepancy. Cite the whole-view `scale-full-vs-reference` hashes above, not the per-organization hash pair.
* **Evidence paths (outside the repository):** `~/tmp-bai/bench-g2/` (`logs/`, `results/g2-rehearsal.json`, `results/parity/*`, `snapshot/`, the stopped scratch cluster); `~/tmp-bai/bench-g2/logs/hash-investigation.log`.

## 3. Offline validation of the G2 gate (no hosted access)
`~/bai-gates/g2-offline-validation.mjs` (SHA-256 `69110e769a3fcfd16ecc1841983a280365b2a7f78880360351a80ba4a34dd3e9`; not in the repository) uses the real G2 gate, simulated hosted facts, a disposable local PostgreSQL at level 028 standing in for hosted, a scratch copy of the restricted checkout made with `gate.mjs workdir`, and a **fake `supabase` binary that records every call**. Result: **41 checks passed** (log `~/tmp-bai/g2-offline-validation.log`).

* Control: with hosted at 028 the gate check passes and the dry run lists exactly `029_value_view_scale.sql`; the real `final-parity.mjs` with the G2 gate passes on a level-028 backup and writes a record that verifies; it refuses a level-027 backup (no record written).
* **Rejected, each on exactly its own violation:** a changed 029 checksum; a changed 028 checksum; an added migration 030 (in the facts and as a file in the checkout); an untracked extra migration; an incorrect release commit (facts and a moved HEAD); a checkout that does not enforce protocol v2; hosted at 027 or already at 029 (level mismatch); a Supabase history without 028; a BAI ledger lagging at 027; a dry run listing 029+030, 028+029, or nothing; a wrong project reference; a tampered gate file.
* **Push refused with zero CLI push calls:** no / missing / expired (11 min) / altered / FAIL records; a record made for the G1 gate or for another commit; a record with another off-site content hash or archive hash; a backup that is 7 hours old at the push; a backup directory changed after the record; a missing returned copy.
* One valid record from the intact state produced exactly one `db push --linked` (no widening flags).

Limits: the fake CLI proves what the guard asks the CLI to do, not what the Supabase CLI does to hosted; `final-parity`'s exporter is a local stand-in; owner-attested facts (decryption, Drive round trip, passphrase custody) are not machine-checkable.

## 4. Production runbook for G2 (every step needs its own explicit instruction; nothing runs until then)
Use the G1 order and tooling unchanged ([g1-protocol-v2-implementation.md](g1-protocol-v2-implementation.md), [offsite-backup.md](offsite-backup.md)). Backup directories keep the `g1-<UTC>` naming because the helper and the age rule key on it. Expected level everywhere is **028 before, 029 after**.

**Phase A: backup (agent, read-only on hosted; owner for off-site)**
1. Re-verify identity: HEAD of `~/tmp-bai/g2-release` is `3f71263d…`; gate SHA-256 `f63ed1e9…`; `029` checksum `296bc757…`; `gate.mjs check --offline` OK; 030 absent.
2. Hosted level 028 by a read-only check; take ONE new snapshot + logical export into a new `~/bai-backups/g1-<UTC>/` (logs outside it); `verify-snapshot`; disposable restore; `hosted-preflight --snapshot-dir … --expect-level 028` locally and strict against hosted. Report the name, T0 and the six-hour expiry.
3. Owner: the Windows `g1-offsite.ps1` steps `Pack`, `Pull`, upload, fresh download, `Return`, `Check`, then "Off-site copy verified for backup <name>" with both hashes.

**Phase B: authorization (owner).** A backup-specific statement, the G1 template adapted: names gate G2, commit `3f71263d…`, gate SHA-256 `f63ed1e9…`, 029 SHA-256, the backup, T0 and expiry; excludes 030, imports, publication changes, read-model refreshes and deployment; stop if any condition fails.

**Phase C: release (agent, within six hours of T0)**
1. `final-parity` (`node --env-file=<env> scripts/db/final-parity.mjs --backup-dir … --gate ~/bai-gates/g2-v2.gate.json --record ~/bai-gates/g2-final-parity-<UTC>.json --offsite-sha256 … --offsite-tree … --authorization-ref "<owner message>"`): level 028, 029 checksum, all tables byte-identical, fresh export identical.
2. Within 10 minutes, from `~/tmp-bai/g2-release`: `BAI_GATE_FILE=~/bai-gates/g2-v2.gate.json BAI_PARITY_RECORD=<record> node --env-file=<env> scripts/db/supabase-hosted.mjs db push` (gate check lists exactly 029; one `db push --linked`).
3. **Then** `node --env-file=<env> scripts/db/migrate.mjs --confirm-hosted dbnmktidheefoxaztivm` (records 029 in the BAI ledger).
4. **Then** `node --env-file=<env> scripts/db/hosted-preflight.mjs --snapshot-dir <backup>/snapshot --after 029`.
   *Expected, not a failure:* between steps 2 and 3, `--after 029` fails exactly one check, "the recorded migration level" (the BAI ledger still ends at 028; see [g1-release-record.md](g1-release-record.md#expected-order-of-operations--and-the-temporary-ledger-mismatch)). Any other failure, or one after step 3, is real: stop, do not repair.
5. Read-only closing checks (`hosted:security` read-only; `hosted:parity` from `~/tmp-bai/g2-release`, expecting 29 migrations and 0 differences) only with explicit authorization.

**Rollback / failure.** 029 changes only three views and writes no data; the 028 definitions remain in the 028 file, so recovery is a new forward migration, never an undo. The backup remains the restore source. Stop conditions are those of G1: any identity, checksum, level, record or authorization mismatch; do not retry or repair.

## 5. Open items for the owner
* **A hosted before/after comparison of the three views is not rehearsed here.** The full old `acquisition_value` takes about 12 minutes at hosted size (744 s measured on 2026-10-25) and cannot sensibly run on hosted. The strict parity step proves hosted data equals the rehearsed snapshot, and the rehearsal proves identical output; a bounded read-only before/after (`trade_returns`, the 15-player `acquisition_value` sample, LAD `class_value`; about 10 s on the old views) is possible but needs its own authorization.
* The G2 backup, off-site ceremony and authorization have not been requested; the previous backup (`g1-20261028T193747Z`) was taken at level 027 and cannot be used (the gate starts from 028 and its six hours are over).
