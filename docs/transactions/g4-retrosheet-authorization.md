# G4 — Retrosheet display authorization (draft for the owner's decision)

**Status: PROPOSED.** This document is the authorization record the source catalog (`research/history/sources.json`, source `retrosheet-transactions`, use `publish_site`) points to. The catalog change that makes it operative is a draft pull request; **merging it is not by itself the owner's decision.** The authorization of record is the owner's separate G4-B message, which must cite this file's SHA-256 (it is also written in the catalog). Until that message exists and the catalog change is merged, `publish_site` stays PENDING and no Retrosheet records may be written to hosted.

Nothing here records a publication grant. The database row in `ingest.source_publication_grants` (G4-B) is a separate act, and neither the grant nor this document imports, refreshes or publishes anything.

## 1. The evidence

| Item | Value |
| --- | --- |
| Notice URL | `https://www.retrosheet.org/notice.txt` (the entry's `license.url` and the notice the catalog designates for the transactions database) |
| Live retrieval | 2026-10-29T23:09:58Z–23:09:59Z, one bounded GET (30 s timeout, 100 kB cap), project-URL user agent only, no cookies or credentials |
| Result | HTTP 200, final URL unchanged (0 redirects), `Content-Type: text/plain; charset=UTF-8`, `Content-Length: 971`, `Last-Modified: Sun, 03 Dec 2023 04:25:41 GMT`, `ETag: "3cb-60b9364e9fae2"` |
| Live bytes / SHA-256 | 971 bytes, `2218abe680e21d3308de06352c394baefbffc7618d36a821d38ed6e97c24105d` |
| Cached copy | `retrosheet/notice.txt` in `research/history/manifest.json`, retrieved 2026-10-22T01:09:58Z, 971 bytes, the same SHA-256 |
| Comparison | **Byte-for-byte identical** (`cmp`), identical checksum |
| Data archive | `tranDB.zip` was **not** downloaded again; the cached archive (SHA-256 `c5cd539f89991afa9a74fdc67b0f71e29413383792404013a2c69fdd450fd932`, 1,203,773 bytes, retrieved 2026-10-22) is unchanged |

The notice's operative text (verbatim; the attribution block is indented in the original):

> Recipients of Retrosheet data are free to make any desired use of the information, including (but not limited to) selling it, giving it away, or producing a commercial product based upon the data. Retrosheet has one requirement for any such transfer of data or product development, which is that the following statement must appear prominently:
>
> The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".
>
> Retrosheet makes no guarantees of accuracy for the information that is supplied. … Retrosheet shall not be held responsible for any consequences arising from the use of the material presented here. All information is subject to corrections as additional data are received.

## 2. Wording comparisons
* **Migration 030 (`public.source_attribution_statements`, `RETROSHEET`)** and **the Sources page** (`app/sources/page.tsx`, `RETROSHEET_CREDIT`) and **`RETROSHEET_ATTRIBUTION`** in `scripts/history/lib/retrosheet.mjs`: all carry the identical statement. It equals the notice's attribution block exactly once the original's line breaks and its double space after "Retrosheet." are collapsed to single spaces (the notice text is unchanged and no wording was altered). The hosted row was read on 2026-10-29: statement, `notice_url` and `verified_on` 2026-10-25 as in the migration. The row's `condition_text` is a paraphrase of the notice, not a quotation, and is not what the pages render as Retrosheet's wording.
* **Production today** serves the statement on `/sources` (the deployed baseline carries it, HTML-escaped quotes aside).
* **Other forms on Retrosheet's site (open ambiguity).** A web search (search-result summaries only; those pages were *not* fetched, to keep to one request to the site) reports that some Retrosheet dataset pages carry the same statement with a postal address in place of the website as the contact (for example the CSV-downloads and some other pages), while the game-logs page and `notice.txt` use the website form. The archive's own `readme.txt` contains no attribution statement. Which form Retrosheet intends for the *transactions* dataset specifically is therefore not established by the archive; the form used here is the one in `notice.txt`, the file the catalog designates for this source. The wording has **not** been altered. If the owner wants this settled before G4-B, one further bounded read of `https://www.retrosheet.org/transactions/` (inside the catalog's allowed prefixes) would show what that page requires.

## 3. Licensing assessment
* The published terms permit **any use, including commercial**, if the statement **appears prominently**. That covers a public site that may later be monetized. The permitted uses in the catalog (`fetch_*`, `process_local`, `publish_repository`) were already CLEARED on that basis.
* **There is no formal signed licence.** The permission is a published notice. It does not define "prominently", does not address derived or aggregated data in terms, and can be changed by Retrosheet; the notice was last modified 2023-12-03. This record does not claim otherwise.
* Retrosheet disclaims accuracy and responsibility. BAI shows these records as PARTIAL (never "verified complete") and states they are Retrosheet's recorded transactions; the pages' attribution component renders the statement only, so an explicit accuracy note is a recommended addition at G7 (the notice does not require one).
* The archive is not a complete census of transactions and was last updated 2022-05-09 (records run to 2022-02-27).

## 4. Where public data could appear before the credit pages are live
* Migration 030 made the read-model tables (`rm_transaction_*`), `source_attribution_statements` and `v_source_attribution` readable by `anon`. Supabase's Data API exposes the `public` schema, so **once `rm_*` holds Retrosheet-derived rows they are readable at `/rest/v1/rm_transactions` (and the other `rm_*` tables) with the published key whether or not the website shows them.**
* The only path that puts rows into `rm_*` is `refresh_transaction_read_models()`, which is executable by the owner connection only (anon, authenticated and PUBLIC are denied; verified on hosted 2026-10-29). Importing into the raw tables (closed to anon since 030) and recording a grant expose nothing by themselves. Hosted today: 0 grants, 0 `rm_*` rows, 0 Retrosheet-category sources.
* The credit pages for this data (`/transactions`, `/transactions/[id]`, `/transactions/coverage`) are on main but **not deployed**; production serves only the `/sources` credit. The database cannot enforce "attribution is live" (no technical link exists between the refresh and the website), so the condition below is a **procedural gate on the refresh**.

## 5. Proposed authorization (operative only on the owner's G4-B message)
* **Source / use:** `retrosheet-transactions`, `publish_site`: writing Retrosheet-derived records to the hosted database, which the public site and the Data API read.
* **Scope: category-wide.** All sources in the `RETROSHEET` attribution category, not limited by year, dataset or club. The import window (2010–2021) is controlled separately by the G5 batch checksums.
* **Effective from 2026-10-30; lapses on 2027-01-22**, the entry's `review_due`, unless re-reviewed. A lapsed or unreviewed authorization refuses `publish_site` (existing permission logic).
* **Attribution requirement:** the statement of section 1, verbatim and prominent, on every page that shows Retrosheet-derived records, with the link to `notice.txt`.
* **Accuracy disclaimer:** records are shown as Retrosheet recorded them, are PARTIAL, may contain errors and are subject to Retrosheet's corrections; Retrosheet disclaims accuracy.
* **Mandatory condition (display):** *public Retrosheet data must not become accessible before compliant attribution is live.* Operationally: **no read-model refresh (G6) that can include Retrosheet-derived transactions may be run until the Transactions pages, with the attribution statement, are deployed to production and verified by a public check,** and the G6 authorization must cite that evidence. Deploying those pages first with an empty read model is safe.
* **Excluded:** `MLB`, `BASEBALL_REFERENCE`, `OTHER_PUBLICATION` and every other category; no accuracy or completeness claim; no "verified complete" status; contract or salary data.
* **Withdrawal:** deleting the `RETROSHEET` grant row withdraws all Retrosheet-derived rows from the public tables in the same transaction (migration 030); reverting the catalog entry to PENDING stops further hosted writes.
* **Next review deadline:** 2027-01-22.

## 6. What this does not decide
Creating the database grant (G4-B), importing (G5), refreshing (G6), deploying (G7), the 65 MLB-sourced trades (they stay withheld without a separate `MLB` grant), and Baseball-Reference or other sources.
