# G5 — off-hosted staging, atomic promotion and withdrawal (migration 032)

**Status: LOCAL IMPLEMENTATION ONLY. NOT AUTHORIZED FOR HOSTED RELEASE.** Nothing in this document, in migration 032 or in `scripts/db/promotion.mjs` authorizes a hosted migration, import, promotion, refresh, grant change or deployment. Every command of the tool refuses a hosted database, and `--hosted` is refused. A hosted release needs the G6 gate, a fresh verified baseline backup and the owner's written authorization for that window.

This replaces the hold-in-place design of the closed PR #62 (display-release table, row-level hiding, pre-request count guard). That design cannot be made leak-free: PostgREST answers `Prefer: count=planned|estimated` from the planner's estimate for the whole table, hidden rows included, and a request that repeats the `Prefer` header reaches PostgREST past a pre-request guard (confirmed on the hosted gateway, read-only). So **no row is ever held in a public table**: rows are staged off-hosted and enter the hosted database, in one transaction, only when they are meant to be public.

## Owner decisions (G5-4) recorded here

1. Retrosheet-derived identity information may eventually be public, conditional on explicit, prominent attribution. Source citation alone is not proof of compliance.
2. The Retrosheet `transaction_date` observations (602 on the real data) are **excluded** from the public delta. Their evidence is kept privately with the promotion, and the exclusion is recorded in the manifest (rule, count, ids, SHA-256 of the withheld rows).
3. The 360 coverage rows and the relevant summary models are in the intended public release, conditional on clear PARTIAL labelling, website attribution and an approved direct REST attribution policy (open: see the inventory below).
4. The 65 MLB-sourced trades stay withheld (no MLB grant; unchanged logic).
5. The two Jake Fox identities and the two held T2 collisions are preserved (the importer already holds them; the delta builder refuses to proceed if a baseline row changes).

## How it works

1. **Stage** (off-hosted). Restore a fresh verified baseline backup into a local database, apply migration 032 to it, and import the six pinned batches with the existing importer. Nothing in this tool imports, and the six pinned candidate files are never read or changed here; only their SHA-256 (from `ingest.import_batches`) go into the manifest, and `expectBatches` pins them.
2. **Package** (`scripts/db/promotion.mjs package`). `buildPackage` compares the staged database with the baseline row by row and refuses unless the staging changed no baseline row (the delta is insert-only). It then makes a *release candidate* copy of the staged database, appends the verbatim attribution statement to the notes of the sources the release adds, deletes the excluded rows (the database itself proves nothing else refers to them: a foreign key stops the delete and the build is refused), and computes the delta again. The package is a directory: `manifest.json`, `payload/<table>.json`, `withheld/<table>.json`, `PACKAGE.sha256.json`. The manifest (canonical JSON, named by its SHA-256) pins: the archive, every batch file hash, the migration checksums, the authorization window and the grant binding, the statement hash and the live-page verification evidence, the baseline fingerprint of every table in scope, the release-state fingerprint of every changed table, the load order, the sequences, the exclusions and the annotation. `verify` re-checks a package offline.
3. **Review.** The owner reviews the package (counts, exclusions, hashes) and the staging results. Nothing is public yet.
4. **Promote** (one owner transaction): `promote_begin` (permission, attribution, schema level, write locks on every table in scope, exact baseline drift check), `promote_load` (once per table, explicit primary keys, no `ON CONFLICT`), `promote_withhold` (the private evidence), `promote_commit` (every table equals the staged release state, the batches are exactly the manifest's, the statement is in every promoted source of the category; then the ledger and the event; the sequences move forward last). Any failure or lost connection aborts everything. After a lost acknowledgement the tool asks the ledger (`promotion_status`) and never repeats a committed promotion.
5. **Publish** is separate and unchanged: the grant (025/030) and the owner's refresh (`refresh_read_models`, `refresh_transaction_read_models`). A promotion publishes no transaction by itself.

## Withdrawal

* **Normal** (`withdraw`): one transaction. Refuses while any row that is not part of the promotion depends on a promoted row (a foreign key from any schema, or an observation or decision that names a promoted player or transaction by subject). Withdraws the read model, deletes exactly the ledger rows (each count checked), optionally the grant, recomputes every summary. Existing rows, players that received new ids, and the MLB records are untouched; ids of withdrawn rows are never reused; the withheld evidence is kept.
* **Emergency** (`emergency`): for when public exposure must stop now and the deletion is blocked. In one transaction it withdraws the read model, **deletes the category's grant** (nothing can republish it), empties the cached summaries that count promoted rows, makes every refresh fail until resolved, and **hides the promoted rows** from `anon`, `authenticated` and the website role with a RESTRICTIVE row-level policy per readable table. It deletes nothing and records what it did and the blockers. Resolve with `finish` (after the blockers are removed: deletes the rows, drops the policies, recomputes) or `revert` (false alarm: lifts the hiding; republishes nothing; the grant must be recorded again deliberately).
  * **Trade-off, stated.** Hiding stops reads of the rows, but the Data API's planner-based counts (`Prefer: count=planned|estimated`) still include the hidden rows until they are deleted. `emergency --close-api` closes every readable table that held a promoted row to the Data API roles *and* the website role altogether: that **temporarily disables those public endpoints** (players, ids, observations, coverage, sources) and so needs the owner's explicit authorization at the time. `service_role` bypasses row-level security by design and is not covered.
  * The unrelated rows are never cascade-deleted, in either mode.

## The website role and the Data API

Migration 032 adds `bai_site` (NOLOGIN, member of `anon` only, no write privilege, no RLS bypass, no administrative right). `bai_web` may `SET ROLE bai_site`. `anon` and `authenticated` lose `SELECT` on the **10** of the 12 `rm_transaction*` tables they could read (the other two, `rm_transaction_refreshes` and `rm_transaction_withdrawals`, were already closed); the tables are registered in `internal_objects`, so `apply_public_boundary()` keeps them closed. `bai_site` gets `SELECT` on those 10 and its own `site_read` policy.

* **No application code changes.** `lib/db.ts` already reads `BAI_PUBLIC_ROLE`. Set `BAI_PUBLIC_ROLE=bai_site` in the production environment and redeploy. **Order matters**: the migration (role and grants) first, then the environment variable and the deployment. Before the variable is set, the old role (`anon`) cannot read the three transaction page queries. Tests show every one of the 23 existing no-argument page queries returns the same result under `bai_site` on the baseline.
* **`v_transaction_record_sources`** is the one owner-rights view (`security_invoker = false`). It aggregates `rm_transaction_sources` alone (category, record count, source count) so that `v_source_attribution` (030, again `security_invoker`, same content) keeps working for Data API consumers without access to the closed table. Review: it reads exactly `rm_transaction_sources` and `sources` (the security audit enforces this), shows no row, id or name beyond the category, and is empty the moment the read model is withdrawn. A residual: after a withdrawal, the planner statistics of the aggregated table are stale until `ANALYZE`; the withdrawal path recomputes caches but a hosted `ANALYZE` after withdrawal is on the full-scale checklist.
* The security audit is amended for exactly this: the declared owner-rights view, the `bai_site` policies on registered-internal tables, `bai_web` membership of `anon` and `bai_site`, and a `bai_site` block (no login, no write, no private schema, no internal table other than the transaction read models).

## REST access and attribution requirements (inventory; NOT a compliance claim)

The notice's operative text is the statement below, which must appear **prominently** wherever Retrosheet-derived records are shown. It is carried verbatim in `source_attribution_statements` (RETROSHEET), on the Sources page, and — new here — appended verbatim to the `notes` of the Retrosheet source row that a promotion adds (the commit refuses a promoted source of the category without it).

> The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".

Source citation, a statement in another table, or a statement on a web page is **not** proof that a direct REST consumer receives credit. The owner must review the final public surfaces and decide each row below before any hosted release.

| Surface | What REST consumers get | Retrosheet-derived content after a promotion | Requirement and state |
| --- | --- | --- | --- |
| `rm_transaction*` (12 tables) | **Denied** (401/403) to anon and authenticated | The transaction facts | Closed by 032; website only, with the statement on the pages. |
| `v_source_attribution`, `v_transaction_record_sources` | Category, domain, record and source counts | Counts of displayed Retrosheet records | Aggregate attribution; carries the category name, not the statement. Owner to confirm. |
| `sources` | The row, including `notes` with the verbatim statement | 1 source row | Credit travels with the source row (enforced at promotion). |
| `source_observations` | Rows citing the Retrosheet source | Player `full_name` and `birth_date` observations (3,643 each on the real data); the `transaction_date` observations are **withheld** | A row names its source by id only; the statement is one join away. OPEN: owner decision on sufficiency. |
| `players` | New player rows | 3,643 identity rows whose name and birth-date observations cite Retrosheet (their ids cite the Chadwick register) | OPEN: identity data credited by citation only. |
| `player_external_ids` | New ids | All cited to the Chadwick register (including 58 ids on existing players) | Chadwick attribution, as today. |
| `coverage_assessments` | New TRANSACTIONS-domain rows | 360 rows, per club-season counts of Retrosheet transactions | Intended public (owner decision 3); OPEN: REST attribution policy. |
| Summary models (`rm_overview`, `rm_coverage_summary`, `rm_organization_summary`, `rm_research_queue_summary`) | Aggregate counts after the owner's refresh | Counts that include the Retrosheet coverage rows | Intended public (owner decision 3); OPEN: confirm. |

Pre-existing (not caused by this work, relevant to "65 trades withheld"): the hosted baseline already has 65 MLB-cited `transaction_date` observations readable through `source_observations`.

## Known limitations

* A promoted row is public in the Data API the moment the transaction commits, by design; nothing is held. Public exposure is therefore decided at promotion, not at refresh.
* The delta is deterministic apart from recorded timestamps and the random `players.player_key` UUIDs, so two stagings are not byte-identical; the manifest pins one concrete staged delta.
* The emergency hide mode leaves planner-estimate disclosure (above); the close mode disables endpoints.
* The emergency and the refresh block rely on triggers on the summary tables; a different, future refresh function that writes elsewhere must be added to that list.
* The tool and the tests are local. Behaviour on the hosted database (statement timeouts through the pooler, per-row trigger cost at full scale, fingerprint portability between a restored backup and hosted) is **unverified**.
* The real-PostgREST tests skip, loudly, without a binary (`BAI_POSTGREST_BIN`); CI skips them.

## Prerequisites for the full-scale rehearsal (not done)

1. A fresh, verified baseline backup restored locally; migration 032 applied to it; the security audit (full and read-only modes) passing on it.
2. The six pinned batches (hashes unchanged) imported into a clone of that restore, with the full regression, security and idempotency suites; 11,257 new transactions, 10,655 non-trade moves, 65 MLB trades preserved, all new PARTIAL, exactly two T2 held, both Jake Fox records separate.
3. `package` over the real data: the withheld set must equal the 602 Retrosheet `transaction_date` observations; the manifest exclusions, hashes and counts reviewed.
4. Timing at full scale: fingerprint pass over ~114 tables; promotion of ~95,000 rows; **withdrawal** of the same (per-row `rm_facts_changed`, `transaction_changed` and evidence triggers); `ANALYZE`; each against the hosted statement limit (the owner session can raise `statement_timeout` above the 2-minute default on a direct connection; unverified through the pooler).
5. Fault drills on the full package: killed connection, lost acknowledgement, drift, wrong manifest, withdrawal, emergency hide, emergency close, finish and revert.
6. Hosted fingerprint portability: the baseline fingerprint computed on the hosted database (read-only) must equal the one computed on the restore of its backup.
7. The owner's review of the public surfaces above and the written authorization of the window (backup eligibility, authorization lapse after 2027-01-22, Chadwick review due 2027-01-21).
