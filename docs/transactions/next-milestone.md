# After G1: the next milestone, what migration 029 does, and the smallest next step

Read-only review of the repository on 2026-10-28; nothing was run against hosted. Sources: `roadmap.md`, `phase18-merge-and-release-plan.md` §6, `value-view-scale.md`, the migration files.

## Where BAI stands
Hosted is at **028**. The transaction foundation (tables, completeness analytics, importer support) exists on hosted but is empty of new data and invisible to users: the production site runs pre-028 code, hosted holds 65 trades and no source-publication grants, and the public transaction read model (030) does not exist yet. The remaining road to a user-visible Historical Acquisition Explorer is already planned as gates **G2–G7** (`phase18-merge-and-release-plan.md` §6): 029 → 030 → Retrosheet grant review → import 2010–2021 → read-model refresh → public deployment. `roadmap.md` has no transaction entry after Phase 5's heading; its "Next" list predates Phases 15–18 and should be updated when the next gate is scheduled.

**Next product milestone: "Historical Acquisition Explorer live" — Retrosheet-derived trades and signings for 2010–2021, shown as PARTIAL (never "verified complete"), with the source's attribution verbatim.** It is G2 through G7; G1 was its first gate.

## What migration 029 would enable (not applied)
`029_value_view_scale.sql` (SHA-256 `296bc757bc14f0fcd5136a16f4f8006ea74d630279acfef190cd77cd7a5932bd`, recorded in the plan) redefines three analytics views — `analytics.trade_returns`, `acquisition_value`, `class_value` — with the same columns, types and meaning, and then revokes table privileges on `analytics` from the public roles (the same posture as before). No table, row or stored value changes.

It matters because the 023/028 definitions do not scale: with 401 trades `acquisition_value` took 266–368 s and the whole view did not finish in 45 minutes; the new definitions run in about a second, with value-for-value identical output on 401 trades (`value-view-scale.md` §4). At today's 65 trades nothing is broken, so **029 enables nothing a user sees by itself; it makes the 2010–2021 import (336+ trades) and the 030 read model computable.** 030 is built on 029 and refuses its own premise without it.

**Prerequisites (from the plan, G2):**
1. Explicit owner authorization naming the commit and the 029 checksum (recomputed at that time).
2. A new gate: `gate.mjs create --gate G2 --commit <a main commit that enforces protocol v2> --through 029 --project-ref dbnmktidheefoxaztivm`, and a restricted worktree through 029 (030 absent). Hosted must be exactly at 028 with the BAI ledger recorded (G1 done).
3. A fresh protocol-v2 backup (≤ 6 h), the owner's independent off-site verification, `final-parity` and the backup-specific authorization, in the same order as G1.
4. The scale rehearsal reviewed (`scale-full-vs-reference` IDENTICAL).
5. After: the three views return identical rows before and after on hosted (smoke-tested read-only), then `migrate.mjs` and `--after 029` in the documented order ([g1-release-record.md](g1-release-record.md)).
6. The read-only G1 closing checks (`hosted:security` read-only mode, `hosted:parity` from the restricted directory) were run on 2026-10-28 after the release and **both passed** at level 028 ([g1-release-record.md](g1-release-record.md#post-release-read-only-verification-2026-10-28-after-the-release--both-pass)); seed-data parity was not performed (hosted holds import batches).

## Recommendation: the smallest next step
**Do not bundle; do G2 (029) next, as the same ceremony G1 just proved, and in parallel start the one human task that has no engineering cost: the G4 Retrosheet publication-grant review.**

* Why G2 first: it is the smallest remaining production change (three views, no data), is reversible by a new migration, and is the prerequisite for both the import (G5) and 030 (G3). Each later gate is blocked on it.
* Why not jump to import or deployment: with no 029, importing 336+ trades makes the value views unusable; with no 030 there is nothing safe to display, and the raw tables are still publicly readable.
* G4 is a person reading `retrosheet.org/notice.txt`, comparing its hash with the repository's record, and recording one grant. It publishes nothing by itself (the read model stays empty until G6), so it can happen while G2/G3 proceed.
* What a user will first be able to do: browse a ledger of PARTIAL trades and signings 2010–2021 with attribution, after G6/G7. Nothing user-visible happens before G7; the earliest honest "useful" demo is a local `npm run hosted:start` against the refreshed read model at G6.
