# R8B human reviewer: minimum independent setup and evidence-approval workflow

**Status: design only. Reviewer enrollment, database permissions and transaction verification stay INACTIVE until the owner authorizes each step. No agent creates, holds or uses a reviewer credential.**

## Roles (separation of duties)
| Role | Does | Never |
| --- | --- | --- |
| Agent / researcher | Reads, builds evidence packages (proposals), triage, drafts | verifies, certifies, enrolls, holds reviewer or owner credentials, changes grants |
| Evidence recorder (owner or delegate) | After a reviewer approves a package, records the sources and PTBNL resolutions in the database | verifies its own records |
| Independent reviewer | Checks the package against the sources in their own session and verifies or rejects | gathers the evidence they verify |
| Owner | Authorizes enrollment, source policy, refreshes | delegates the database owner credential to an agent |

## Minimum safe reviewer setup (owner actions, in this order)
1. Name a human who is not the evidence gatherer (and not an automation).
2. On the owner's own machine, with the administrator credential, create a LOGIN role for them: no superuser / create-role / create-db / replication / bypass-RLS, not in `bai_automation`, not a member of any role that owns a BAI schema or table; `GRANT bai_reviewer`. `research.role_review_refusal(role)` states why a role would be refused. The password is set by the reviewer and never passes through an agent or log.
3. The reviewer connects from their own device with that credential and calls `research.enroll_reviewer(name, note)`. Check one active row in `research.reviewers`.
4. Leave `research.certification_gate` disabled (a separate later decision; it must stay off while automation holds the owner credential). Per-transaction verification (`research.verify_transaction`) does not need it.
5. Record the evidence in the release file: reviewer name, role name, date, the `research.reviewers` row, gate state.

## Evidence-approval workflow (per package)
1. **Proposal** (agent): package validated, rights status and independence assessed, gaps listed. State: `PROPOSAL`.
2. **Source policy gate** (owner decision, once): the candidate's category must be displayable (class 1) or granted; otherwise the package is held `RIGHTS_BLOCKED`.
3. **Reviewer check** (human, own session): opens every candidate, confirms players, direction, date and that nothing else changed hands, assesses independence by lineage, and either approves, requests changes or rejects, in writing, with the locator. Approval is a note, not yet a database fact.
4. **Recording** (evidence recorder): inserts the sources (`transaction_sources` with role and `independence_group`), links them to every package and asset (`transaction_source_links`), and PTBNL resolutions. Each insert withdraws that transaction from the read model immediately (migration 030 trigger) until an owner-authorized refresh.
5. **Verification** (reviewer, own session): `research.verify_transaction(id, basis, independence_note)` only when the gap list is empty; any later change to the record revokes it automatically.
6. **Refresh** (owner-authorized): republishes the record with its new sources; the verifier (`verify-promoted`) must still pass.
Conflicts (`transaction_conflicts`) are raised, never resolved by editing a fact. A rejected or unresolved package keeps every unresolved claim visible.
