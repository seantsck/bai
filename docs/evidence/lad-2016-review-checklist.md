# Human review checklist: LAD / DRAFT / 2016-JUNE_AMATEUR

Prepared 2026-10-20 by automated research (Phase 6). **Not certified.** Only a human reviewer certifies, on their own database login (Phase 8: identity is the authenticated login, not a name; certification is disabled until the conditions in [decision-history.md](../decision-history.md#what-remains-before-certification) hold). There is no force option. Evidence: [lad-2016-draft-certification.md](lad-2016-draft-certification.md).

## Where the class stands

| Database | State | Blockers |
|---|---|---|
| Hosted (replayed from PR #5's runbook, 2026-10-20) | `COVERAGE_REVIEW` / `READY_FOR_REVIEW`; 26 of 33 bonuses, 7 unknown; Smeltzer resolved by the declared rule ($500,000) | none |
| Local, this branch (adds Baseball America, `lad-2016-ba-corroboration.mjs`) | `COVERAGE_REVIEW`; 27 of 33 bonuses, 6 unknown | 1: the Smeltzer conflict, reopened by a third source and left for you (item 1) |

Recommendation: review on the local database (or on hosted after this branch merges and its runbook is replayed there), decide item 1, then certify.

## Independent verification (2026-10-20)

Each check was re-run against live or archived sources, not read back from BAI.

| # | Check | Method | Result |
|---|---|---|---|
| V1 | Official 42-pick universe | `statsapi.mlb.com/api/v1/draft/2016?teamId=119`, fetched again | 42 picks, 42 distinct overall picks (20 … 1211), identical to BAI |
| V2 | MLB debut identity and date, 18 players | `people?personIds=…` for the 18; name and `mlbDebutDate` compared with BAI | 18 of 18 match |
| V3 | The 24 no-MLB players have not debuted since | same endpoint for the 24 | 0 of 24 have a debut date |
| V4 | Signing status of all 42 | LAD transaction wire 2016-06-09..08-31, `SGN` entries | 42 of 42 agree (33 signed, 9 not) |
| V5 | Unknown bonuses stay NULL | BAI rows for the picks still without a source | 6 NULL (731 now has a figure, below), none zero |
| V6 | Smeltzer's conflicting sources preserved | active observations on the signing | 3 kept: B-Ref $497,500, MLB.com $500,000, Baseball America $497,500 |
| V7 | Sheffield and Robinson exits | player transaction wire + MLB.com's 2020 Rule 5 reports (archived) | Both were Rule 5 selections that MLB's wire codes as waiver claims |
| V8 | Chandler Eden | player transaction wire | Signed 2016-06-17, assigned to AZL Dodgers 2016-06-20; no later entry |
| V9 | Distinct states | signing status x outcome audit | 14 signed/reached, 19 signed/no MLB, 4 unsigned/reached, 5 unsigned/no MLB; no NOT_AUDITED; "undrafted" cannot occur in a draft class (an undrafted signing would be a different acquisition record) |

## New evidence found during this review

- **Baseball America "2016 Draft Selections"** (archived 2026-04-29). It agrees with 40 of the 42 Dodgers rows (25 bonuses and 15 rows without a figure). It disagrees only on Smeltzer, where it sides with Baseball-Reference. It also supplies **Saige Jenco #731: $75,000**, where Baseball-Reference is blank. That figure is imported locally, and Jenco's "unknown" job is marked `SUPERSEDED`.
- **The $2,500 accounting deduction.** Dodgers Digest's 2016-07-18 signing table lists gross bonuses and explains a "$2,500 discount on all bonuses for signed picks". Every BAI figure is the net amount; for example Lux is $2,317,000 gross and $2,314,500 recorded, and Gonsolin $5,000 gross and $2,500 recorded. On that table Smeltzer is $500,000 gross, which is $497,500 net.
- **The seven late-round signees** (and Jenco) are listed by Dodgers Digest among picks "that didn't count towards the bonus pool". Under the 2012–2016 agreement, that bounds each bonus at $100,000 or less. A bound is not a value, so nothing is imported.

## Decisions for the reviewer

Each item has a recommendation; the decision is yours.

| # | Item | Recommendation | How |
|---|---|---|---|
| 1 | **Smeltzer #161 bonus**: $500,000 (MLB.com tracker, OFFICIAL) vs $497,500 (Baseball-Reference and Baseball America) | **Choose $497,500** (proposal 1, below). Every other recorded LAD 2016 bonus is the net figure, and the tracker's $500,000 matches the gross amount Dodgers Digest lists. Two independent sources agree on the net figure. Confidence: moderate (the tracker is the official publication). | `npm run research:conflicts` shows the open conflict with its observation ids. Then `npm run research:resolve -- --table draft_signings --id <signing id> --field signing_bonus_usd --observation <Baseball America obs id> --operator "<your name>" --rationale "<reason>" --write`. Choosing the rule's figure instead: `--rule --write`. |
| 2 | **Census claim** (42 = MLB official list) | **Accept.** MLB's list, Baseball-Reference and Baseball America each list the same 42 picks. | No command; certification records the claim as reviewed. |
| 3 | **Six unknown bonuses** (761 Eden, 821 French, 851 Perkins, 941 Berman, 971 Costello, 1031 Toribio) | **Accept as unknown** (bounded at ≤ $100,000, not stored). No source with a figure was found; Baseball America prints "—". | Already `UNRESOLVED` with a rationale. To reopen, add a researcher job. |
| 4 | **Sheffield #36 and Robinson #191 dispositions** (`LOST_WAIVERS` from MLB's wire) | **Recode both to `LOST_RULE_5`.** MLB.com's 2020-12-10 report: Sheffield was taken 7th in the Major League phase by Colorado, and Robinson by Cincinnati in the Minor League phase. The evidence is in `research/evidence/rule5-2020-lad.json`. | Not applied, because the 2016 audits are under review. Applying it needs a corrective OUTCOMES batch: rebuild with `outcome-audits-import.mjs --rule5 research/evidence/rule5-2020-lad.json` (a new `as_of` date) and apply. The old and new details then show as a conflict to resolve. |
| 5 | **Chandler Eden #761**: signed, no affiliated game, no exit | **Accept `UNKNOWN`.** The wire records a signing and an AZL assignment only. A fan site's "did not sign" is contradicted by MLB's record and was not imported. | none |
| 6 | **WAR**: only Baseball-Reference career WAR (capture 2026-08-03) | **Accept for certification.** WAR is not a certification requirement; FanGraphs and tenure WAR belong to the attribution work ([organizational-war-attribution.md](../proposals/organizational-war-attribution.md)). | none |
| 7 | **Operator decisions made by the research agent**: Sheffield's round code and pick (`bai-backfill-review`) | **Confirm.** MLB's official structure (CB-A, pick 2) is kept, and B-Ref's label stays on record. | A recorded resolution cannot currently be re-decided (see the limitation below), so confirm or raise it before certifying. |

## Recording decisions (Phase 7, migration 021)

Every decision is now kept in `research.decision_history`, and no recorded judgment is silently overwritten ([../decision-history.md](../decision-history.md)).
- **Enroll first:** an administrator creates your PostgreSQL login and grants it `bai_reviewer`; you log in with it (`BAI_REVIEWER_DATABASE_URL`) and run `research:reviewer -- --enroll "<you>"`. Every reviewer command then acts as that login; none takes a name. The full set of open items is in [phase8-reviewer-packages.md](phase8-reviewer-packages.md).
- **Item 1 (Smeltzer) is filed as proposal 1** (`research:proposals`). Automated research proposed it (`agent:bai-research`) with the evidence in `research/evidence/smeltzer-2016-bonus.json`, and it decides nothing. Accept it: `research:accept -- --proposal 1 --reason "<reason>" --write`. Or reject it: `research:proposals -- --reject 1 --reason "..."`, then decide the conflict yourself.
- **Item 7 (Sheffield round label):** an operator decision; it blocks certification until you ratify it (`research:ratify -- --resolution <id> --reason "..." --write`) or re-decide it (`research:reconsider ... --reason "..." --authorize --write`). The earlier judgment stays in the history.
- **Item 4 (Sheffield and Robinson Rule 5):** now proposals 3 and 4 on the per-acquisition dispositions (Phase 8); accept or reject them like proposal 1.

**Smeltzer evidence (Phase 7):**
- For 11 of the 12 Dodgers picks in rounds 1–10, MLB.com's tracker shows exactly the gross bonus minus $2,500 (the net figure).
- Pick 161 is the only one where the tracker shows the gross figure ($500,000).
- Baseball-Reference and Baseball America both give $497,500.
- So the tracker's $500,000 is gross, and $497,500 is the net figure on the convention every other recorded LAD bonus follows.
- No source states pick 161's deduction explicitly: confidence is moderate to high.

## Certify (after items 1–7)

```bash
npm run research:class   -- --org LAD --channel draft --year 2016     # expect: certification: no blockers
npm run research:certify -- --org LAD --channel draft --year 2016 --operator "<your name>"
npm run refresh:read-models
# undo, human only, kept on record:
npm run research:revoke  -- --org LAD --channel draft --year 2016 --operator "<your name>" --reason "..."
```

On hosted, prefix with `hosted:research` and add `--confirm-hosted <ref>`. Replay `research/runbooks/lad-2016-ba-corroboration.mjs --confirm-hosted <ref>` first if the hosted class should carry Baseball America.
