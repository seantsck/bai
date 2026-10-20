# Reviewer packages: open LAD evidence questions (Phase 8)

Prepared 2026-10-20 by the research automation for an independent human reviewer. **Nothing here is decided.** Every
item is a proposal, an open conflict, or an operator decision awaiting ratification. Records are named by natural keys
(draft, pick, MLBAM id); database ids differ between local and hosted.

## How a reviewer acts

Every action below runs on **your own PostgreSQL login** (`BAI_REVIEWER_DATABASE_URL`; see
[decision-history.md](../decision-history.md)). The database records the login as your identity. No command takes a
reviewer name.

| To | Command |
|---|---|
| Accept a proposal | `npm run research:accept -- --proposal <id> --reason "..." --write` |
| Reject a proposal | `npm run research:proposals -- --reject <id> --reason "..."` |
| Confirm an operator decision as it stands | `npm run research:ratify -- --resolution <id> --reason "..." --write` |
| Choose another claim in a decided field | `npm run research:reconsider -- --table t --id n --field f --observation <obs> --reason "..." --authorize --write` |

Find the ids with `npm run research:proposals` and `npm run research:conflicts`; resolution ids appear in
`research:class` (`DECISIONS` blocker). Without `--write`, each command is a dry run.

---

## 1. Devin Smeltzer, LAD 2016 #161: bonus, gross or net (proposal 1)

**Question.** What was Smeltzer's signing bonus: $500,000 or $497,500?

| Claim | Source | Authority |
|---|---|---|
| $500,000 | MLB.com 2016 signing tracker | OFFICIAL |
| $497,500 | Baseball-Reference 2016 LAD draft page | AGGREGATOR |
| $497,500 | Baseball America "2016 Draft Selections" | REPUTABLE_SECONDARY |

**Evidence** (`research/evidence/smeltzer-2016-bonus.json`):
- **Dodgers Digest, 2016-07-18:** gives gross figures. The Dodgers record $2,500 less per signed pick, an accounting deduction that Dodgers Digest's headline ("avoid losing picks by $524") reflects.
- **MLB.com's tracker:** for 11 of the 12 LAD picks in rounds 1–10, it shows exactly Dodgers Digest's figure minus $2,500, which is the net figure. Pick 161 is the only exception: it shows $500,000, Dodgers Digest's gross figure.

**Proposal 1** (agent): choose $497,500 (net), the convention MLB.com follows for every other pick in the class, and keep $500,000 on record as the gross figure.

**Note.** The declared rule (PREFER_HIGHER_AUTHORITY) would pick MLB.com's $500,000. Nobody has applied it, because this is a judgment about convention, not authority.

**Impact.** This is the only conflict on a LAD 2016 bonus. Either decision unblocks that `CONFLICTS` item.

---

## 2. Connor Wong, LAD 2017 #100: career bWAR through 2025 (proposal 2)

| Claim | Source |
|---|---|
| 3.3 | Baseball-Reference 2017 LAD draft page, capture of 2026-01-05 (WAR column) |
| 3.6 | Baseball-Reference player page, pre-2026 capture; its season splits sum to 3.6 |

**Proposal 2** (agent): prefer 3.6. Both values cover the same seasons, and B-Ref revises WAR between captures.

**Impact.**
- WAR is not a certification requirement, so this doesn't block LAD 2017.
- Value attribution uses the season splits, which already sum to 3.6.
- Deciding it after the class is certified would revoke that certification.

---

## 3. Jordan Sheffield (2016 #36) and Errol Robinson (2016 #191): how they left (proposals 3 and 4)

**Question.** Was each 2020-12-10 departure a waiver claim (`LOST_WAIVERS`) or a Rule 5 selection (`LOST_RULE_5`)?

| Claim | Source |
|---|---|
| `LOST_WAIVERS` | MLB transaction wire (OFFICIAL): codes both as `CLW` on 2020-12-10 |
| `LOST_RULE_5` | MLB.com, "Dodgers lose 8 players in Rule 5 Draft" (2020-12-10, archived), OFFICIAL: Sheffield was taken 7th in the Major League phase by Colorado; Robinson by Cincinnati in the Minor League phase |

**Background.**
- The wire codes the 2017 class's Rule 5 losses (de Geus, Roller, Chiu) the same way; the 2017 audits already record them as `LOST_RULE_5`.
- Before migration 022 the 2016 values could only be changed by rebuilding the whole outcomes batch.
- They are now per-acquisition dispositions, so the Rule 5 claim is a normal, cited observation. The conflict stays open (`acquisition_dispositions`, field `disposition`).

**Proposals 3 and 4** (agent): choose `LOST_RULE_5` for each, citing `research/evidence/rule5-2020-lad.json`. The wire's coding stays on record.

**Impact.** These are two `CONFLICTS` blockers on LAD 2016.

**Note.** Sheffield's round label (CB-A, pick 2, against B-Ref's round 1, pick 36) is a separate operator decision (resolutions on `draft_selections` #36 `round_code` and `round_pick`, by `bai-backfill-review`). It needs ratification or reconsideration; see `DECISIONS` in `research:class`.

---

## 4. Nathan Witt (2017 #520) and Donovan Casey (2017 #610): did they sign?

| Claim | Source |
|---|---|
| `DID_NOT_SIGN` | Baseball-Reference 2017 LAD draft page (AGGREGATOR) |
| `SIGNED` 2017-07-06 | MLB transaction wire (OFFICIAL): "Los Angeles Dodgers signed RHP Nathan Witt" / "signed OF Donovan Casey" |

**Corroboration.**
- **Dodgers Digest, 2017-07-07**, quoting MLB.com's Ken Gurnick: "17th-rounder RHP Nathan Witt, 20th-rounder OF Donovan Casey … 33 of 40 total picks signed".
- **LA Dodger Talk, 2017-07-08:** also counts 33 signed.
- **Later careers:** both players' MLB records show affiliated seasons and trades from LAD (Witt to TB in 2019; Casey to WSH in 2021). A pick that never signed couldn't have been traded.

**Decision on record.** `SIGNED` for both, by the operator label `bai-backfill-review` (Phase 6). It was **not** taken in a reviewer session, so it blocks certification as `DECISIONS` (2 items) until a reviewer ratifies or reconsiders it.

**Recommendation.** Ratify both.

---

## 5. Josh McLain and Deacon Liput: two acquisitions each (data correction, no decision needed)

**What was wrong (Phase 7).**
- Both were drafted by LAD in 2017 and didn't sign, then were drafted by LAD again in 2018 and signed.
- Dispositions were stored on the player's outcome audit, so the 2018 signing displayed the 2017 `UNSIGNED`. The resulting conflict didn't appear in `research:conflicts`.

**What changed (migration 022).**
- Dispositions now belong to each acquisition.
- The database refuses `UNSIGNED` on a signed acquisition, and refuses an exit on a pick that never signed.
- Each acquisition now carries its own history, as follows.

| Player (MLBAM) | Acquisition | Signed | Disposition | Evidence |
|---|---|---|---|---|
| Josh McLain (656717) | LAD 2017, #430 (round 14) | No | `UNSIGNED` | 2017 draft batches; no SGN on the wire in 2017 |
| | LAD 2018, #284 (round 9) | Yes, 2018-06-18, $7,500 | `RETIRED` 2019-11-07 | MLB wire: "Los Angeles Dodgers signed OF Josh McLain" (2018-06-18); "CF Josh McLain retired" (2019-11-07) |
| Deacon Liput (663937) | LAD 2017, #880 (round 29) | No | `UNSIGNED` | 2017 draft batches |
| | LAD 2018, #314 (round 10) | Yes, 2018-07-03, $134,300 | `UNKNOWN` | MLB wire: signed 2018-07-03. The last entry, 2022-03-07, places him on the restricted list with Great Lakes; MLB lists him inactive. No release or retirement is recorded, so the exit stays unknown. |

**Value attribution.** The 2017 acquisitions are `NOT_SIGNED` and earn nothing. Any value belongs to the 2018 signings. Neither player reached MLB.

**For the reviewer.** Nothing to decide. Confirm the two rows per player when certifying 2017 and 2018. Liput's `UNKNOWN` is "unknown after research", not "retained".

---

## Other decisions awaiting ratification

| Class | Decision | By | Package |
|---|---|---|---|
| LAD 2016 | Sheffield #36 `round_code` CB-A, `round_pick` 2 (MLB structure kept over B-Ref's round 1, pick 36) | `bai-backfill-review` | [lad-2016-draft-certification.md](lad-2016-draft-certification.md) |
| LAD 2019 | Jimmy Lewis #78 `round_code` C-2, `round_pick` 1 (MLB's "2C" over B-Ref's round 2, pick 37) | `bai-backfill-review` | [lad-2018-2019-draft-certification.md](lad-2018-2019-draft-certification.md) |
| LAD 2015 (pilot) | Pick 74 `round_code` CB-B, `round_pick` 4 | `bai-pilot-review` | pilot docs |

LAD 2018 has no open conflict and no unratified decision. It is the only class with no certification blockers. It still can't be certified until a reviewer exists and the certification gate is opened (see [decision-history.md](../decision-history.md#what-remains-before-certification)).
