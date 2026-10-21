# Publication audit: historical importer (PR #11)

An audit on 2026-10-21 of what PR #11 (`feature/historical-drafts`) published in this **public** repository, how the
release was separated, and what removing published objects can and cannot do. No public Git history was rewritten.

## Inventory of PR #11

| Class | Files | Contents | Disposition |
|---|---|---|---|
| **Reusable source code and schema** | Migration 024, `scripts/history/` (fetcher, normalizer, builder, evidence parser, CLI, plan, benchmark), research-pipeline changes, explorer pages, `lib/search.ts`, docs | Code and prose | Carried into the release branch |
| **Synthetic test fixtures** | `tests/db/historical-drafts.test.mjs`, `tests/app/search.test.mjs`, the benchmark (`research/history/reports/benchmark.json`) | Fictional players and ids (the 987xxxx range, "Fixture …" names) and synthetic timings | Carried |
| **Licensed open data and metadata** | `research/history/sources.json`; `research/history/manifest.json` (URL, size, SHA-256 and time per downloaded file, with no content); Wikipedia-sourced calendar rows (CC BY-SA, facts with revision ids) | Decisions and metadata | Carried. The catalog moved to format 2 (permission gates) |
| **Restricted, permission-pending research data** | 51 batch files (`research/history/batches/1965,1985,2005/`); 3 build reports (`reports/<year>-build.json`); `plan.json`; `docs/history/pilot-results.md` (named findings) | **Player names, MLBAM ids, picks, schools and birth dates from MLB's draft feed**; per-year feed counts; **names and pick numbers from archived Baseball-Reference pages** (in coverage gap notes and reports) | **Excluded** from the release branch. Kept in `.restricted/history/` (gitignored) and backed up |
| **Restricted, operational** | `reports/<year>-import-timings.json`; calendar rows dated only by MLB's phase names | Batch keys and timings; MLB phase names | Excluded (local), to keep the rule simple: output of restricted runs stays local |

**Where the restricted data sits in history.** It all arrived in one commit, `43b8ed3` ("research: historical pilot
…"). The other two commits of PR #11 (`78cf01c` schema, `04a80fe` importer and explorer) contain only code, docs and
synthetic tests. The PR description describes the findings without names.

**Backup.** `~/bai-restricted-research/history-pilot-20261021.tar.gz` (with `.sha256`, mode 600, outside the repository)
holds:
- the download cache (82 MB, every file checksummed in the manifest);
- the original batches, reports and plan;
- the original pilot document.

The working copy is in `.restricted/history/`. It includes the rebuilt batches, the reports, the full plan, the
restricted calendar rows and the exception register.

## Release branch

`feature/historical-importer-hardened` is built from `main` with every reusable file of PR #11 plus the hardening. **No
commit on it has ever contained restricted data**, so merging it with a merge commit brings none into `main`'s history.
Merging PR #11 itself would bring commit `43b8ed3` into `main` permanently, so PR #11 should be closed unmerged.

`npm run history:publication-check` (in `npm run check`) now fails the gate if restricted output is committed again. It
checks for:
- restricted paths;
- governed source keys without `publish_repository`;
- unknown `hist:` keys.

## Exposure through prior commits and the PR

- **Exposure window.** Commit `43b8ed3` has been public since PR #11 was opened (2026-10-21 02:32 UTC). It is reachable
  through:
  - `refs/heads/feature/historical-drafts`;
  - `refs/pull/11/head`;
  - `refs/pull/11/merge`;
  - the PR's "Files changed" view.
- **Forks.** The repository has 0 forks (checked 2026-10-21). Clones and caches outside GitHub cannot be checked.
- **Closing the PR or deleting the branch does not remove the objects.** GitHub keeps `refs/pull/11/*` for every pull
  request, closed or not. The commit stays reachable by SHA, and its diff stays visible in the PR.
- **Rewriting history doesn't remove them either.** A force-push of the branch without `43b8ed3` (not done; it needs
  explicit approval) would remove the commit from the branch only. The PR refs, cached views and any existing clones
  would keep it.
- **Full removal from GitHub** requires a request to GitHub Support to purge the pull request refs and cached views,
  after the branch is deleted or rewritten. Even then, copies already fetched by others cannot be recalled.
- **What remains true.** The exposed content is facts (names, picks, schools, birth dates) for 1,809 selections in three
  years. It also includes a few dozen names and pick numbers from archived Baseball-Reference pages. It holds no
  credentials or personal data beyond what those public sources show.

## Recommended actions (need approval)

1. **Close PR #11 without merging,** and review the release branch's PR instead.
2. **Delete the remote branch** `feature/historical-drafts`. The local copy and the backup keep everything.
3. **Optionally, ask GitHub Support** to purge `refs/pull/11/*` and the cached views of commit `43b8ed3`.
4. **Decide whether to rewrite history** for full removal. This is only useful together with step 3.

Older research batches on `main` (`research/imports/`) cite MLB and Baseball-Reference per class. They predate the gates
and are reviewed with the hosted records in [hosted-provenance.md](hosted-provenance.md).

## Release review (Phase 9.2, 2026-10-21)

The full PR #12 diff against `main` was reviewed before merge, and these gaps were closed:
- **Aliases and unrecognized keys.**
  - Governance now also follows URLs (`governs_hosts`, `governs_url_patterns`).
  - Keys match case-insensitively.
  - Unknown `hist:` keys are refused.
  - Historical years need every source catalogued.
- **Alternative import paths.** The hosted gate moved into the research pipeline (`stageFile`, `applyBatch --write`).
  Runbooks and scripts that bypass the CLIs are therefore covered too.
- **Other download paths.** The two research-program downloaders that reach MLB's Stats API and archived
  Baseball-Reference pages are now gated (`fetch_targeted`). No other script in the repository fetches source data:
  - `scripts/app/smoke.mjs` reads BAI's own app;
  - `scripts/db/security.mjs` and `scripts/deploy/` call Supabase and Vercel administration APIs;
  - the source importers read files a researcher already downloaded.
- **New research files.** Any tracked file under `research/history/` must be on a reviewed list, or the publication
  check fails.

**Files added by PR #12 under `research/`:** `research/history/sources.json`, `manifest.json`, `calendar.json` and
`reports/benchmark.json`. All four are reviewed:
- the catalog;
- the download metadata;
- the Wikipedia-sourced calendar rows;
- the synthetic benchmark.

No other research file was added.
