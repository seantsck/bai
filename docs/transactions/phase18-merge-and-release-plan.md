# Phase 16–18 — merge readiness, merge procedure and the separately gated production plan

Nothing in this document has been executed. Merging, hosted migrations, publication grants, imports, refreshes and deployment are **separate decisions**, each needing its own explicit authorization. Checksums marked ⟨recompute⟩ must be recomputed and compared at the moment each authorization is given.

## 1. Dependency chain and heads (checked against GitHub)

```
main 77b012e  ←  #38  ←  #39  ←  #40  ←  #41            #37 (independent, base main)
```

| PR | Title (short) | Base | Head | Draft |
| --- | --- | --- | --- | --- |
| #37 | Phase 15: transaction forensics foundation (planning only) | main | `86e6eda1e` | yes |
| #38 | Phase 16: transaction foundation (migration 028 and importer) | main | `852c1afc2` | yes |
| #39 | Phase 17: Retrosheet historical acquisition pipeline | #38's branch | `6396366b1` | yes |
| #40 | Phase 17B: scale historical trade forensics (migration 029) | #39's branch | `9132ed9bc` | yes |
| #41 | Phase 18: Historical Acquisition Explorer (migration 030) | #40's branch | the branch tip (the commit that contains this file; read it with `gh pr view 41`) | yes |

All five report `MERGEABLE`. The repository has no GitHub Actions workflow and no branch protection; the only status checks are Vercel's preview deployment and its comment bot, so **`npm run check` run locally on the merge result is the required check** (it is not run by CI).

## 2. What merging does and does not do

* **No deployment.** `vercel.json`'s `ignoreCommand` skips Git-triggered production builds (the last merge to `main`, #36, shows "Canceled by Ignored Build Step"). Production is a manual `vercel deploy --prod`. Pull-request branches do build *previews*; those sit behind Vercel Authentication and read whatever database their environment names.
* **No migration.** Migrations are applied only by explicit hosted commands (`npm run hosted:migrate`). Merged-but-unapplied migrations are accepted by the historical-release guard: the rehearsal below shows `migrationProblems` is empty at 027 with 028–030 committed, so the pending 2025 draft release path is unaffected by the merge.
* **No data.** Nothing here imports, grants or refreshes anything.
* After the merge, the **production site (old code) keeps working** against hosted at 027. The new app code, if it were deployed before the migrations, would show "unavailable" on the transactions pages (queries are wrapped) and a Transactions entry in the navigation; do not deploy before section 6, gate G7.

## 3. Merge procedure (do not run until authorized)

Use **merge commits**, not squash or rebase: each PR's branch contains its parent's original commits, so squashing a parent leaves the child with duplicate, conflicting history.

0. Preflight, once. `git fetch --all`; confirm `origin/main` is still `77b012e` and every PR head equals the table above (`gh pr view <n> --json headRefOid`). If `main` moved, merge it into the bottom of the chain (`feat/phase16-transaction-foundation`) and re-run the checks before anything else. Do not delete head branches until the chain is finished.
1. **#37** (planning documents and one plan JSON under `docs/transactions/`; independent). Checked: it shares no file with #38–#41. Merge it at any point.
2. **#38** → `main`. Mark ready; `git switch --detach origin/feat/phase16-transaction-foundation && npm run check`; merge commit. Then `git fetch && git switch --detach origin/main && npm run check`.
3. **#39**: `gh pr edit 39 --base main`; `gh pr diff 39 --name-only` must list only Phase 17 files; `npm run check` on the PR head; merge commit; `npm run check` on `main`.
4. **#40**: same (`--base main`); additionally `node scripts/db/bench/rehearse-chain.mjs` (section 5).
5. **#41**: same; additionally `npm run db:security`, the rehearsal, and (optional, ~25 min) `node scripts/db/bench/build-p18-all.mjs` then `explorer.mjs`.
6. After the last merge: `git tag phase18-merged origin/main` (local note only); confirm `gh pr list --state open` shows only what you expect.

Required at every step: `npm run check` exit 0 (lint, typecheck, app/history/db tests, build, `git diff --check`, credential scan, publication check). Stop at the first failure; do not proceed down the chain.

**Rollback before any hosted migration.** Nothing external changed, so revert the merge commits in reverse order (`git revert -m 1 <merge sha>` for #41, #40, #39, #38) in one PR. Migrations 028–030 may still be amended while **no hosted database has applied them** — record the moment (gate G1) after which they are frozen: the runner refuses a changed checksum (`applied migration … has changed (frozen)`), so any later fix is a new migration (031+; 031 is reserved by the later-added proposal, so use 032 or renumber deliberately).

## 4. Outside Data API consumers of the three raw tables

Migration 030 removes `SELECT` on `public.transactions`, `public.trade_packages` and `public.trade_package_assets` from `anon` and `authenticated`.

* **This repository:** nothing reads them. The web app connects as `bai_web` and runs `set local role anon`; its queries touch only published views and `rm_*` tables. The only public view depending on them was `v_source_attribution` (hosted shows the same single dependent); 030 redefines it to count published transactions.
* **Hosted today (read-only catalog query, 2026-10-25):** hosted is at 027; all three tables are readable by `anon` and `authenticated` through an RLS `public_read` policy; they hold 65 transactions, 83 packages and 111 assets (the BAI trades). `pg_stat_user_tables` shows scans, but the counters include this project's own audits and snapshots, so they cannot identify outside readers.
* **What cannot be known here:** whether anyone calls the Supabase REST API (`/rest/v1/transactions`, `/rest/v1/trade_packages`, `/rest/v1/trade_package_assets`) with the published anon key. That needs the Supabase dashboard's API logs. **Before gate G3, review those logs for the past 90 days.** If a consumer exists, the choices are to publish an equivalent read model for them, to tell them, or to delay. The 65 rows involved are MLB-sourced and are *already public today*; closing them is a reduction, not a change to their availability through the explorer (they stay withheld until MLB-category display is separately granted).

## 5. Verification run for this gate (disposable databases only)

| Check | Result |
| --- | --- |
| `npm run check` | exit 0 (see the PR comment for counts) |
| Security audit (`db:security`, 030 applied) | SECURITY OK |
| Three-team WAR regressions, NULL-safe guard | `tests/db/transaction-read-model-hardening.test.mjs` |
| Revocation, stale-claim and raw-table tests | same file |
| Concurrent refresh/revocation (two sessions) | `tests/db/transaction-read-model-concurrency.test.mjs` |
| 027→028→029→030 rehearsal on the hosted snapshot | `node scripts/db/bench/rehearse-chain.mjs`: each step applies in ~0.1 s; release guard ok at every step; 92 existing tables unchanged (original columns); registries only gain rows (`internal_objects` +12, `provenance_fact_tables` +2); SECURITY OK |
| Draft / international / release-audit parity | `verify-unchanged.mjs`: 100 tables and the draft / international / read-model views identical (except the intended registry rows and the Sources-page TRANSACTION rows) |
| Value views 029 vs 030 | IDENTICAL (trade_returns 1,518; acquisition_value 3,176; class_value 350) |
| 11,257-published-transaction benchmark | every page query < 30 ms median; refresh ≈ 21 s |
| Population reconciliation | 65 + 602 = 667 trades; 10,655 non-trade; 11,322 total; 11,257 published; 65 withheld |
| Release-manifest compatibility | `tests/history/*` in `npm run check`; guard ok at 027 with 028–030 committed |

### Concurrency findings (two independent PostgreSQL sessions)

* **Refresh first, writer second:** the writer's statement waits on a lock (confirmed in `pg_stat_activity`), then, after the refresh commits, its trigger withdraws what the refresh just published. The committed end state exposes nothing withdrawn. Covered for a grant deletion, a verification revocation, and an asset, a source-row and a source-link edit.
* **Writer first, refresh second:** the refresh fails at once with `55P03` (lock not available), publishes nothing, and changes nothing; after the writer commits, a retry publishes the transaction as what it now is; if the writer rolls back, the retry publishes normally. This is the **only** retryable race. It is expected, it is safe, and `scripts/db/refresh-transaction-read-models.mjs` (`npm run refresh:transactions`, `npm run hosted:refresh-transactions`) retries `55P03`, `40P01` and `40001` with backoff (default 10 attempts, 0.5 s doubling to 8 s) and stops loudly on anything else or when attempts run out.
* **Deadlocks:** none. The refresh takes all its locks in one `NOWAIT` statement, so it never waits while holding a lock; a writer holding one locked table and wanting another cannot form a cycle with it (tested in both orders; `pg_stat_database.deadlocks` stays 0).
* **Lock waits:** a writer to a locked table (grants, verifications, sources, transactions and their child tables) waits for the duration of a refresh, ≈ 21 s at 11k transactions. Do not refresh while an import or a review session is running; the refresh runs in READ COMMITTED (it refuses other levels).
* **Fail-closed unchanged:** nothing was relaxed; a refresh that cannot lock publishes nothing and the previously committed read model stays exactly as it was.

## 6. Future production plan — every gate separate, nothing executed

Each gate needs a written authorization from the owner that names the gate, the commit and the checksums, and is followed by its verification before the next gate is even requested. A failed verification stops the plan.

**Common preconditions.** The chain in section 1 is merged (or the exact commit to be released is named); `npm run check` exit 0 on that commit; `.env.hosted.local` points at the BAI project only (the connection helper refuses any other project ref and every hosted write needs `--confirm-hosted <ref>`); a restorable backup of the hosted database exists (confirm point-in-time recovery for the project's plan, or take and checksum a logical dump) and its restoration path has been read; the pending 2025 draft release and the historical release audits are neither started nor disturbed.

**Execution constraint for G1–G3 (found by the G1 preflight; see `gate-g1-authorization.md`).** `supabase/migrations` is a symlink to every committed migration, so a plain `supabase db push` from the full repository applies 028, 029 and 030 together, and `hosted:migrate` refuses to record any one of them until all are pushed. Run each gate from a purpose-built working directory whose `database/migrations` ends at that gate's migration (the dry run must then list exactly one file).

**Backup status (G1 preflight, 2026-10-25).** The hosted project has no platform backup (`backups: null`, `pitr_enabled: false`) and the repository had no documented restoration procedure, so "a restorable backup exists" is **not** satisfied by the platform. `gate-g1-authorization.md` lists the choices (a fresh checksummed snapshot restored and verified with `restore-snapshot.mjs`/`hosted-preflight.mjs`, or paid platform backups). G1 stays BLOCKED until you choose.

| Gate | Action | Authorization states | Immediately before | Verification after | Stop / rollback |
| --- | --- | --- | --- | --- | --- |
| **G1** | Hosted migration **028** (transaction foundation) | commit; 028 checksum `7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501` ⟨recompute⟩ | `hosted:rehearse-028` reviewed; Data API log review not required for 028 | `hosted:verify`, `hosted:security`; `hosted:parity` where applicable; 65 BAI trades unchanged; no row counts changed in any pre-existing table | 028 is additive; fix forward with a new migration. From here 028 is frozen |
| **G2** | Hosted migration **029** (value-view scale) | commit; checksum `296bc757bc14f0fcd5136a16f4f8006ea74d630279acfef190cd77cd7a5932bd` ⟨recompute⟩ | rehearsal at scale reviewed (`scale-full-vs-reference` IDENTICAL) | the three value views return identical rows before and after on hosted; `/organizations` and valuation pages smoke-tested locally against hosted read-only | views can be restored from their 028 definitions by a new migration |
| **G3** | Hosted migration **030** (read model, raw tables closed) | commit; checksum `2aa200bbb55c7f59ea42d398e1f1c49e71155dd46034f4b83c042ba0ed2eeeae` ⟨recompute⟩; **the Data API log review of section 4 is attached** | `hosted:rehearse` reviewed; confirm no external consumer, or the decision to proceed regardless | `hosted:security` SECURITY OK; `anon` cannot read the three tables; `v_source_attribution` still answers; `rm_transactions` empty; `hosted:verify` | 030 changes grants/policies/views/functions; restoring the old exposure is a deliberate new migration, not an undo. Enum additions are permanent |
| **G4** | **Retrosheet publication-grant review** | the person recording it names the basis | read Retrosheet's current `https://www.retrosheet.org/notice.txt`; compare its sha256 with `research/history/manifest.json` (`2218abe680e21d33…` when last read, 2026-10-25) and its text with `public.source_attribution_statements` (verbatim); confirm the statement appears prominently on every page that shows Retrosheet-derived data (ledger, detail, coverage, Sources) | one row in `ingest.source_publication_grants` for `RETROSHEET`, recorded by that person; **by itself this publishes nothing** (the read model is empty until G6) | revoking the grant (delete the row) withdraws every Retrosheet transaction from the public tables in the same transaction (tested) |
| **G5** | **Historical import** (Retrosheet transactions 2010–2021) | the six batch files below, by checksum; the immutable archive and register pins | recompute every checksum; `retrosheet:rehearse` / `period-rehearsal` results reviewed; hold lists reviewed (name-only, id-name mismatch, approximate dates stay held) | counts equal the reconciliation in section 5; all records PARTIAL; no VERIFIED_COMPLETE; `hosted:provenance` | an import is not undone by deleting rows (append-only ledgers); the grant (G4) can be revoked to withdraw the display at once |
| **G6** | **Read-model refresh** | after G4 and G5 | no import or review session running | `npm run hosted:refresh-transactions -- --confirm-hosted <ref>`; published/withheld counts match; spot-check three records against the notice; anon SQL boundary tests | revoke the grant or revoke a verification to withdraw instantly; a refresh never publishes more than the grants allow |
| **G7** | **Public application deployment** | commit; Vercel preview checked | set the production variable (`npm run deploy:web-env -- --target production …`) deliberately; smoke list from `docs/vercel.md` plus `/transactions`, a trade, a signing, `/transactions/coverage`, `/sources` | run `scripts/db/bench/smoke-explorer.mjs` against `npm run hosted:start` first (previews sit behind Vercel Authentication); `vercel deploy --prod` only after that and the preview check; then by hand on the deployment: verbatim attribution, no "verified complete" badge, no winner or grade | promote the previous deployment (Vercel keeps it); the read model can be withdrawn independently |

### Immutable candidate checksums (SHA-256, local ignored files; ⟨recompute⟩ at G5)

```
migration 028   7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501
migration 029   296bc757bc14f0fcd5136a16f4f8006ea74d630279acfef190cd77cd7a5932bd
migration 030   2aa200bbb55c7f59ea42d398e1f1c49e71155dd46034f4b83c042ba0ed2eeeae
archive (2010–2021 source)   c5cd539f89991afa9a74fdc67b0f71e29413383792404013a2c69fdd450fd932
retrosheet notice.txt        2218abe680e21d3308de06352c394baefbffc7618d36a821d38ed6e97c24105d
chadwick register pin        781c175… (commit; research/history/manifest.json entries chadwick/781c175/*)
out-2010-2014/candidates-batch.json         8682c0da4a9d5ba436f3f7a17bfee06e31185b66a21b96a0c3f24cd2e68b9ae9
out/candidates-batch.json  (2015–2020)      71cea0b73a367faceb861e1ffae6ea4b8b6f4ed3b489b47606d6c07bf04f0892
out-2021/candidates-batch.json              6885137318af43bfc535cf74c77f4f38c9dd87a8d4cc5869242694eb8bc8e72d
out-acq-2010-2014/acquisitions-batch.json   863ec2e53105c45cac4982bc0d2c7e2dccad65ff40077c7c6fe95620eefbe950
out-acq-2015-2020/acquisitions-batch.json   b26e76b0792b15e165d51160ac44233dfe5352ae818379d8784b88566057423d
out-acq-2021/acquisitions-batch.json        7792c3b001745ce8c46c126b3d7e39d32ce2980ed95deb30a1d04a21c14dbf9b
```

The batch files are derived data and stay out of the repository (source permissions). At G5 regenerate nothing: stage these exact files, confirm the checksums, and let the importer record the batch checksum in `ingest.import_batches`. A different checksum is a different authorization.

### What stays out of scope until separately requested

Certification-gate enablement (human verification), any VERIFIED_COMPLETE claim, executive grades or rankings, WAR display beyond the providers' own permissions, contract or salary data, the later-added-player migration (031, not implemented), DISI, Diamond IQ, the pending 2025 draft release and the historical release audits.
