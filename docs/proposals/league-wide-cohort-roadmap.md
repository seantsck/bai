# Proposal: league-wide cohort roadmap

Status: **proposal** (Phase 6, 2026-10-20). It needs no schema change. Waves are rows in `research.program_waves`, classes come from `research:class --create`, and ordering comes from the existing priority engine. The 30-organization architecture stays as it is: no club gets its own tables, columns or code paths.

## Principles

1. **Deterministic order.** `research:next` already orders actionable work by program wave, category priority, class chronology, franchise key, channel and job key. This proposal only decides which rows go into `program_waves` and in what sequence classes are created. No score comes from a model.
2. **Draft and international in parallel.** Each wave creates both channels for the same years, so neither channel's coverage runs ahead and a cross-channel comparison is possible as soon as a year is done.
3. **Year slices before club depth.** Within a wave, finish a year (draft *and* international) for every club in the wave before the next year. Comparisons need the same year across clubs more than a long series for one club.
4. **Certification gates growth.** A wave does not open its next year until the previous year's draft classes are certified by a human or explicitly parked with blockers recorded. Certification stays human-only.
5. **International honesty.** International classes are expected to stay `PARTIAL_RECONSTRUCTION` until a complete published list is read. They do not block the draft side.

## Sequence

| Step | Cohorts | Exit criterion |
|---|---|---|
| **W1a** (now) | LAD 2016 and 2017 draft: human review and certification. LAD 2016-17 and 2017-18 international: Baseball America lists, ambiguity jobs, outcome audits | both drafts certified; international universe decided or recorded unknown |
| **W1b** | LAD 2015 pilot: outcome audits and certification. LAD 2018 and 2019 draft and international (one year at a time) | per year: draft certified, international reconciled |
| **W2a** | Wave 2 benchmark clubs, **2016 draft and 2016-17 international** for all of them | every Wave 2 2016 draft class at `COVERAGE_REVIEW` |
| **W2b** | Wave 2, 2017 then 2018 slices; LAD 2020–2022 in parallel | same gate per slice |
| **W3** | All remaining organizations, year slices from 2016 | same gate; the 2015 slice last (pilot conventions differ) |
| **W4** | Outcome completion, Baseball-Reference season WAR splits, attribution ([organizational-war-attribution.md](organizational-war-attribution.md)) | rates appear only for certified, census-level, fully audited cohorts |

## Choosing Wave 2 (needs a human decision)

Wave membership is a research-value judgment. The ordering it produces is deterministic. Proposed criteria, in this order:

1. **Source availability:** an MLB.com signing tracker exists for the club's draft years, and Baseball America lists exist for its international periods.
2. **Strategy contrast with LAD:**
   - heavy international spending or penalty periods (2015–2018);
   - pick volume and compensation picks;
   - a history of over-slot signing after round 10.
3. **Natural experiments already in the evidence:**
   - **ATL:** the 2017 international sanctions freed its prospects, one of whom (Guillo Zuñiga) is already a LAD 2017-18 signing;
   - **BAL:** LAD 2016 and 2017 picks traded there, which feeds attribution;
   - **SD:** heavy 2016-17 international spending, the contrast case for LAD's $300,000 cap years.
4. **Size:** at most six clubs, so each year slice stays reviewable.

**Candidate set for review:** ATL, BAL, SD, TB, HOU, NYY. It is set with:

```sql
insert into research.program_waves (organization_id, wave, rationale, set_by)
select id, 2, '<criterion>', '<reviewer>' from public.organizations where franchise_key = '<KEY>';
```

This is data, not a migration; the reviewer's name and rationale are recorded.

## Throughput and controls

- **Per class (LAD 2016/2017 experience):** one draft class is about 60 jobs, 5–8 import batches and about 130 MLB Stats API requests for outcomes. Fetchers stay explicit-list and rate-limited (at most 60 players per run, 600 ms between requests). Archive captures are read one at a time with pauses; the Wayback Machine rate-limits.
- **Builders are club-generic.** The `--org` / `--team-id` / `--club-label` parameters already cover the draft, slot, tracker, Baseball America, wire-signing, outcome and international builders. A new club needs no code, only downloads and runbooks.
- **Hosted:** classes reach hosted only by replaying reviewed runbooks with `--confirm-hosted`, after the PR carrying them merges.
- **Agent limits:** agents propose (imports, leads, jobs) and humans review agent-staged batches and certify. That does not change with scale.

## Risks

- **Source access.** Baseball-Reference, FanGraphs and Baseball America refuse automated requests. Archive coverage of older pages is uneven, so some clubs and years will carry more `UNRESOLVED` bonuses. That is acceptable: unknown is never zero.
- **Review capacity.** Human certification is the bottleneck by design. Year slices keep each review batch small and comparable.
