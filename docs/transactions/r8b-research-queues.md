# R8B — research queues for human verification of published Retrosheet trades

**Status: tooling and method only.** Nothing here verifies, certifies, registers a reviewer, changes a grant or edits a transaction fact. The queues are lists of work for a human; the lists themselves are derived from licensed data and are written outside the repository (`scripts/research/r8b-queues.mjs` refuses to write inside a git work tree).

## The queues (published trades, read model generation 1: 602 trades)
| Queue | Records | What is missing |
| --- | --- | --- |
| 1 — unresolved PTBNL | 113 (P1A 97 with cash known, P1B 16 with unknown cash) | player-to-be-named resolution, plus everything below |
| 2 — clean candidates | 357 | a primary announcement and a second independent source linked to every package and asset |
| 3 — unknown cash | 132 | the above plus a recorded cash disclosure |

The 10,655 non-trade records have no verification rule (`NON_TRADE_VERIFICATION_NOT_DEFINED`) and stay PARTIAL until a rule is designed. Ceiling under today's rules: 454 verified-complete records (queues 1A + 2), 602 only if every unknown cash amount can be sourced.

Generate: `node --env-file=<hosted env> scripts/research/r8b-queues.mjs --out <new directory outside the repository>` (read-only transaction; prints counts only). Ranking: tier, then fewer and simpler assets, then newer season, then id (`scripts/research/lib/r8b-queue.mjs`, tested in `tests/db/r8b-queue.test.mjs`).

## What VERIFIED_COMPLETE requires (`research.transaction_gaps`, migration 030)
An external id; at least two trade packages, none empty; at least two distinct independence groups on the transaction; one `PRIMARY_ANNOUNCEMENT` source; every package and every asset linked to at least two independent groups; every PTBNL asset resolved (`ptbnl_resolutions`); no CASH or INTERNATIONAL_POOL_SPACE asset with UNKNOWN disclosure; no open conflict. An enrolled reviewer then calls `research.verify_transaction` in their own session. Any later change to the record revokes the verification.

## Procedure per record (read and cite)
1. **Identity / resolution.** Find the later announcement naming the player (or stating cash or nothing). Record `PLAYER` (the player must already exist; a missing player is a separate identity task, never invented), `CASH` (`DISCLOSED` with an amount, `UNDISCLOSED`, or `UNKNOWN`) or `NOTHING`, with date, precision, source and notes.
2. **Date and parties.** They must equal the record; a mismatch is a `transaction_conflicts` row, not an edit.
3. **Package and asset corroboration.** Match every asset on each side to the second source and link it (locator = page, section or time stamp).
4. **Independence.** By lineage, not publisher: a source that copies another, or two stories rewriting one release, share a group.
5. **Publication rights and withdrawal.** A transaction is displayed only if every source category it cites is openly licensed (`CHADWICK_REGISTER`, `WIKIPEDIA`, `BAI_RESEARCH`, `WIKIDATA`) or has a publication grant (today RETROSHEET only). Two separate mechanisms apply. (a) **Immediate:** any insert, update or delete on a published record's facts or evidence (its transaction row, packages, assets, external ids, transaction sources, source links, PTBNL resolutions, conflicts, player moves, or the source row itself) withdraws that transaction from the read model in the same database transaction (`rm_facts_changed`), whatever the category; it stays out until the next owner-run refresh. So every evidence entry takes its record offline until a refresh. (b) **At the next refresh:** the refresh re-checks every source cited by each record and publishes it only if all are authorized; a record citing `MLB`, `BASEBALL_REFERENCE` or `OTHER_PUBLICATION` (no grant) stays unpublished. **Categories are never relabelled to get around this.**
6. **Citations only.** Title, publisher, URL, date, locator, retrieved-on. No copied third-party text, tables or images.

## Open decisions (owner)
* **Second-source policy:** a grant for display of citations in `OTHER_PUBLICATION` / `MLB`, openly licensed sources only, or pause.
* **Retrosheet authorization lapses after 2027-01-22** (review due 2027-01-21); verification of Retrosheet-only records is wasted if it is not renewed.

## Registering an independent reviewer (owner actions; no agent performs them)
1. Choose a human who is not the person gathering the evidence.
2. The owner, with the database administrator credential on their own machine, creates a login role with no administrative attribute (not superuser, create-role, create-db, replication or bypass-RLS), outside `bai_automation` and outside any role that owns a BAI schema or table, and grants it `bai_reviewer`. `research.role_review_refusal(role)` says why a role would be refused. The password never passes through an agent or a log.
3. The reviewer connects with their own credential from their own device and calls `research.enroll_reviewer(name, note)`; confirm one active row in `research.reviewers`.
4. `research.certification_gate` stays **disabled** (a separate decision; it must stay off while automation holds the owner credential). Per-transaction verification does not need it.
5. Agents prepare queues, drafts and proposals only; they never hold the reviewer credential or call `verify_transaction`.

See also: [evidence workflow and pilot](r8b-evidence-workflow.md), [source-policy assessment](r8b-source-policy.md), [reviewer design](r8b-reviewer-workflow.md).
