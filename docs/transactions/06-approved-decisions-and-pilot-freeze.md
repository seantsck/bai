# Phase 15 close-out: approved decisions, verified baseline, frozen pilot

Written 2026-10-25 after the owner approved the Phase 15 architecture. This file records decisions and freezes the pilot selection. It adds no data and changes no schema.

## 1. Approved decisions
| # | Decision | Result |
|---|---|---|
| 1 | Rights outreach | Approved to **prepare** drafts for MLBAM, SportsDataIO (licensed vendor) and Retrosheet. Nothing is sent until the owner sends it. Drafts: [outreach/](outreach/). |
| 2 | Pilot rule | Approved: LAD plus five clubs drawn by SHA-256, every trade in the 2023 and 2024 deadline windows (section 3). |
| 3 | Schema before rights answers | Approved on a **disposable database only** (Phase 16, separate PR). No hosted migration. |
| 4 | Sample thresholds (E5) | Deferred until before any ranking. |

## 2. Hosted baseline (read-only, 2026-10-25)
The earlier figures (65 trades, 354 WAR rows) were correct for transactions and are unchanged by the 2024 draft release, which touched draft tables only. Corrected whole-database context:

| Item | Value |
|---|---|
| Applied migrations | 001-027 (latest 027) |
| `transactions` / `trade_packages` / `trade_package_assets` | 65 (all TRADE) / 83 / 111 |
| `war_observations` | 354 (BREF only) |
| `acquisition_dispositions` | 163 |
| `organization_value_attributions` | 0 |
| `draft_selections` / `players` | 1,291 across 10 drafts / 1,612 |
| `ingest.release_audits` | 6 (the 2024 draft release is applied; **2025 is not**) |
| Contract, salary, executive tables | none |

Earlier planning text that called the 2024 release "pending" is superseded: only the 2025 release and the historical round corrections remain unauthorized.

## 3. Frozen pilot selection
Rule (unchanged from `05`): the 29 franchises other than LAD, ordered by the SHA-256 hex of `"phase15|" + franchise_key`, ascending; the first five are drawn. Computed from the 30 active hosted franchise keys on 2026-10-25.

| Order | Franchise key | Club | SHA-256("phase15|key") |
|---|---|---|---|
| 0 | LAD | Los Angeles Dodgers | (fixed by the owner) |
| 1 | LAA | Los Angeles Angels | 02429d1f…b6cc54 |
| 2 | NYY | New York Yankees | 04327488…c4d1 |
| 3 | SD | San Diego Padres | 130049e6…b752b7 |
| 4 | HOU | Houston Astros | 13fa5619…14675e |
| 5 | CIN | Cincinnati Reds | 1c024174…6c04a0c |

The next in order (COL, 1f0151b7…) is **not** drawn and no swap is allowed. Machine-readable copy with full hashes: [pilot-plan.json](pilot-plan.json). Reproduce with `printf 'phase15|%s' KEY | sha256sum`.

Scope, frozen with it: every trade involving a drawn club between the day after the All-Star Game and deadline day of 2023 and of 2024 (dates recorded from a cited source in `season_calendar_events` before sourcing); every counterparty and asset of those trades; no other transaction types and no contracts. A swap, an added famous trade or a dropped awkward one requires a new dated decision in this file.

## 4. Independent corroboration
Two articles repeating one announcement are one source. A `VERIFIED_COMPLETE` trade needs **two independent source groups**:
- Every cited source carries an `independence_group`. Sources share a group when one is derived from the other: a re-publication, a wire rewrite, an aggregator or reference page built from a club release, a quotation of the same announcement, or a page that cites it. When in doubt they share a group.
- The primary group is the original announcement (a club or league release, or an official transaction record). The second group must be reached by a different original act: independent reporting by a different outlet from its own reporting, a different official record (for example a league transaction log versus a club release), or a reference database that records the transaction from its own primary research. A source never counts against itself, and a group is counted once however many pages it has.
- Both groups must agree on parties, every asset, cash status, conditions and date. A disagreement is recorded as a conflict and the transaction stays incomplete until a person decides it.
- The database refuses a verification with fewer than two distinct groups (Phase 16). The importer cannot supply groups it cannot cite: a group is a free key plus a cited source row; the human verifier is accountable for the claim that two groups are independent and records why.
- Restricted sources used for corroboration stay local per the source-permission gate; the repository keeps only citations that are permitted to be published.

## 5. Authenticated human verification
- Verification is a **human-only database action**, using the same mechanism as migration 021: a PostgreSQL login role that is a member of `bai_reviewer`, not an administrator, not automation, and unable to act as the owner of a BAI schema or table; display name bound by `research.enroll_reviewer`. The identity is `session_user` (`research.session_reviewer()`), never a name passed as an argument, a CLI flag or an environment variable.
- Importers, agents, `bai_automation` and the database owner cannot create or alter a verification, and cannot set a transaction complete. Completeness is **derived**, not stored: a transaction is complete only while an active verification exists whose fingerprint equals the current content fingerprint.
- Any change to the transaction, its packages, assets, sources, links, external ids or PTBNL resolutions revokes the active verification in the same database transaction (system actor) and the record falls back to incomplete. A person revokes by explicit action with a reason.
- Verification requires, checked in the database: at least one package; every asset sourced individually; at least two independent source groups; no pending PTBNL or unresolved asset; no cash amount of unknown status (a disclosed amount, a source-stated "undisclosed", or no cash asset); no recorded conflict; and the verifier's written basis. These are the same gaps the public view lists.
- The CLI connects with the reviewer's own login (as `research:*` reviewer commands already do); it takes no reviewer-name argument.
- Verifying a trade says nothing about whether the club's list of trades is complete (`05` section 2, club-window coverage).

## 6. Design refinements adopted for Phase 16
These tighten `03` and are recorded here so PR #37 stays the planning record:
1. Completeness is derived from verification state, not a mutable column on `transactions`, so it cannot be forged or left stale, and an update to it cannot trip the migration-021 certification trigger on `transactions`.
2. `independence_group` is a field of the transaction-source row.
3. Cash disclosure is an explicit state: DISCLOSED (amount, zero allowed), UNDISCLOSED (a source says so), UNKNOWN (not established). Null never means zero.
4. A resolved PTBNL enters the existing 023 return views through one helper view, so no parallel valuation exists and existing results are unchanged.
