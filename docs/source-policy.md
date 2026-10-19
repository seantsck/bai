# Source policy

## What may be a source
- **Public only.** `sources.publicly_accessible` is forced true. Paywalled, private or leaked material is never a source.
- **Locatable.** Every research source has a URL or a written reference (`sources_locatable_check`). Only test fixtures are exempt.
- **No wholesale copying.** BAI stores facts (dates, amounts, ids, labels) plus short locators. It does not store article prose. Summaries such as rules-era descriptions are written in BAI's own words.
- **No bulk scraping.** Research fetches a modest number of pages per batch. Larger backfills need a deliberate, rate-limited plan.

## Source metadata (`public.sources`)

| Column | Meaning |
|---|---|
| `source_key` | Stable id, immutable once registered. A batch reusing a key with different metadata is refused. |
| `publisher`, `title`, `source_type` | Who published it and what kind of document it is. |
| `url` / `reference` | Where it lives. The live URL is preferred. |
| `archived_url` | The archive copy actually read, when the live page was unreachable. |
| `published_date` | Publication date where the page states one. Null when unverified. |
| `retrieved_date` | When BAI read it (renamed from `accessed_date` in 012). |
| `effective_from` / `effective_to` | The period the source speaks to, when bounded (e.g. a CBA). |
| `authority_level` | See below. |
| `notes` | How it was read, e.g. "fetched in full" or "search-result excerpt only; page returned 403". |

## Authority levels

| Level | Typical sources |
|---|---|
| `OFFICIAL` | MLB / MLBAM releases, the MLB Stats API, club press releases, the transaction wire |
| `PRIMARY_PUBLIC` | Primary documents made public, e.g. CBA text or official rules |
| `REPUTABLE_SECONDARY` | Established outlets: Baseball America, AP, ESPN, MLB Trade Rumors, FanGraphs, SI |
| `AGGREGATOR` | Compilations: Baseball-Reference, Wikipedia, the Chadwick register |
| `ARCHIVE` | An archived copy where the archive itself is the evidence |
| `OTHER` | Fan sites, local outlets, anything else |

**Authority is metadata for reconciliation, never a truth value.**
- A lower-authority source is not wrong. It is kept, it can corroborate, and it can be the only evidence for a fact.
- Authority ranks sources only when the declared rule for a field is `PREFER_HIGHER_AUTHORITY`. Even then the rule must find a strictly stronger source, or it hands the decision to an operator.

### Archived copies
When the live page is unreachable and a Wayback copy is read, the source keeps the original publisher's authority, and `archived_url` records the copy. The archive changes how the page was retrieved, not who said the fact.

### Excerpt-only evidence
Some publishers block automated fetching, including several MLB.com and Baseball America pages. If a figure was seen only in a search-result excerpt:
- the source notes say so;
- the record carries an `EVIDENCE_EXCERPT_ONLY` quality flag;
- if the only trace is a search tool's paraphrase (not a quotable excerpt), the value is **not** recorded.

## Never inferred
- **Signing dates:** stored as the date a source states, at the precision it states. A transaction date and a report date are different facts.
- **Bonuses and costs:** stored as stated. Overage taxes and other derived costs are not computed. Unknown is null, never zero.
- **Signing status:** a pick without research is `UNKNOWN`, never "did not sign". Pro appearances for the drafting club can establish SIGNED; the record then says so in a flag.
- **Completeness:** a cohort is `PARTIAL_RECONSTRUCTION` unless documentary evidence establishes the population and its size.

## Conflicts between sources
Every claim is a `source_observation`, and disagreeing claims all stay. A canonical value chosen between them is recorded in `fact_resolutions`: the chosen observation, every observation considered, the rule or operator, and the rationale. See [research-ingestion.md](research-ingestion.md#conflict-rules).

### Calendar disagreements recorded so far
- **2019 draft end date:** an MLB excerpt suggested June 6, against June 5 elsewhere. June 5 was chosen; June 6 matches the completion press release date.
- **Old international window close:** a CBS explainer says "July 2 to June 25", against June 15 in every period-specific source. June 15 was chosen, and the June 25 claim stays on record against 2018-19.
- **Not adopted, kept as notes:**
  - a low-authority, garbled 2020-21 end date;
  - the 2012–16 penalty tiers, which changed during that CBA;
  - which rules era the 2022 period belongs to. It is a classification call, tagged CBA 2017–21 with the reasoning in its `timing_note`.
