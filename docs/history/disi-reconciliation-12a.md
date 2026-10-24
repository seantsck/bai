# DISI ↔ BAI read-only reconciliation (Phase 12A): method and aggregate findings

Tracking issue: #28. This phase compared DISI's verified Dodgers international signings with what BAI already holds. It migrated nothing, wrote nothing to either system and is not a statement that DISI is certified or authoritative over BAI. Per-player outputs stay in the gitignored `.local/reconciliation/disi-bai/` workspace.

## Method
1. **Sources, read-only.** DISI was read as a disposable local restore of its committed canonical SQL lineage (a `git archive` of the pinned commit replayed into PostgreSQL 17); no DISI database was contacted and the DISI working tree was not used. BAI was read from hosted through the public web role (read-only transaction, `set local role anon`), the same role the public site uses; no owner credential was needed.
2. **Identity.** MLBAM id first; Baseball-Reference id, FanGraphs id and birth date only corroborate, and a differing corroborator sends the pair to review. Never by name, birthplace, position or approximate year. Same-name players with different ids are listed as review pointers, never links. DISI's own identifiers were also corroborated against the cleared Chadwick register BAI already caches.
3. **Facts compared** per matched Dodgers signing: signing date (and announcement / formal-transaction semantics), period, organization, pathway and market (through an explicit mapping rule), each cost component (NULL is unknown, never zero; rounded or derived bases are flagged), outcome audit and observation-through date, MLB debut, bWAR (Baseball-Reference only, batting and pitching kept apart, never blended with fWAR), and transactions.
4. **Categories:** MATCH, BAI_MISSING, DISI_MISSING, VALUE_CONFLICT, IDENTITY_REVIEW, AS_OF_OR_SCOPE_MISMATCH, SOURCE_RIGHTS_BLOCKED (a gap whose every DISI source is rights-blocked for BAI), UNVERIFIED_IN_DISI. A discrepancy is not automatically an error in either system.
5. **Rights.** DISI source rows were classified with BAI's source catalog; MLB-family hosts not yet catalogued were treated as blocked pending review. A fact being present in DISI does not clear it for BAI.
6. **Aggregates** are recomputed from row-level data inside comparable populations only. Dashboard totals are not copied, and no rate is computed.

## Aggregate findings (no per-player or source-restricted rows)
- 15 of 220 DISI Dodgers players are in BAI, all by MLBAM with corroboration and no identifier conflict; 13 have a Dodgers international signing on both sides.
- On those 13 the organization agrees everywhere, the period in 12, signing dates in 4 (2 conflicts, 7 DISI undated), bonuses in 9 (4 absent from BAI), posting and transfer fees in all 13 (equal or both unknown); 4 conflicts need a primary source.
- DISI's identifiers are corroborated independently for 218 of 220 players, and all 47 DISI debut seasons equal the register's first MLB season.
- 47 gaps BAI could fill from DISI are SOURCE_RIGHTS_BLOCKED: DISI's outcome audits, debuts and bWAR rest on MLB Stats API or Baseball-Reference pages.
- DISI-internal caveats: 22 signing bonuses and 1 transfer fee rest only on legacy carry-forward ledger rows; DISI's "verified no-MLB outcomes" dashboard figure counts 4 players still in the minors and 1 unknown beyond the 41 career-ended outcomes.
- The two systems' populations are different definitions (DISI: a union of scopes, no complete class; BAI: a wire-discovery rule, partial in every period); only the shared players are comparable.

## Recommended next step (separate approval)
A narrow cohort: the shared players. Add independently sourced bonus observations after reviewing the cited publishers, and review the conflicts against primary sources. Outcomes, WAR and transactions stay blocked until their source rights are decided. A larger step (the DISI complete-census class rows) needs a rights decision on club releases first.
