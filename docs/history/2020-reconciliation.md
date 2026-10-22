# Reconciling a Wikipedia-sourced draft year (method; first used on 2020)

The data and the report stay local (`.local/history/<year>/`, gitignored). This page records the method and the rules only.

## Commands (`npm run history:wikipedia -- <command> --year YYYY`)
| Command | Does |
|---|---|
| `fetch` | The article revision through the cached, checksummed fetcher. |
| `identify` | Chadwick candidates (name, birth-year window, career start), Wikidata people by printed name, by the article's own links (page → Wikibase item) and by each candidate's MLB id. Writes `identity.json`. |
| `build [--only-picks n,n --suffix dN]` | Review batches, one per club. A supplement run adds picks an earlier run held; a staged batch is immutable, so a changed batch gets a new key. |
| `dob-compare` | Birth dates found in public pages by a research agent that was not shown the register's dates, compared with the candidate's. Proposals only. |
| `release-check` | Census reconciliation, integrity, signing rows, permissions (local and hosted), per-club evidence comparison. Writes `release-candidate.json`. |
Import with `BAI_HISTORY_OUT=.local/history npm run history -- import --year YYYY [--write --no-plan]`, then `npm run refresh:read-models`.

## Identity tiers (never mixed)
- **VERIFIED:** one Chadwick candidate tied to a Wikidata person by Q-id, MLB id, or a full birth date. The article's link counts only if it points at the same item; a link to a different item is recorded as a conflict and confirms nothing. Verified identities carry Chadwick ids, attributed to it.
- **SINGLE_SOURCE:** one candidate in one source. Imported name-only, no ids attached. A candidate narrowed from several by Chadwick career fields (MLB id present, professional start within three seasons of the draft, a college record that fits the school type) is still single-source until a second source ties it.
- **AMBIGUOUS:** candidates the sources cannot tell apart. Held, never imported.
- **UNMATCHED:** no candidate. Imported name-only.
Two people are never joined because their names agree. An existing local player is linked only through an identifier the pipeline accepts (`EXACT_EXTERNAL_ID`), never by name.

## Census and coverage
A club's class is `COMPLETE_CENSUS` only when an independent list names the same people and nothing was held. A second list that may share the league's list upstream, or one the publisher does not describe, raises confidence but is not recorded as independent compilation. Every club stays `PARTIAL_RECONSTRUCTION` until a person judges otherwise.

## Evidence lists
Other publishers' lists are read one page at a time like a person would, never bulk-fetched, and only facts (pick, club, name, school) are keyed into a local file. A site that refuses (HTTP 429/403) is not worked around: the page is marked unread and a person reads it. Pages on sources the catalog restricts (MLB, Sports Reference) are not fetched without a recorded grant.

## Signing status
Never changed by this process. An aggregate statement ("all picks signed") is recorded with its source and what it does and does not establish; a person decides what, if anything, becomes a per-player observation, and only from sources BAI may cite.

## Research agents
Every brief carries `AGENT_REQUEST_RULES` (`scripts/history/lib/agent-brief.mjs`): web access only through the search and fetch tools, project-URL identification only, no personal information in any request or report, no workarounds when refused.
