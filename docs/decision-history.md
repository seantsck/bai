# Research decision history and the human certification boundary

Migration 021. Research judgments are kept forever and changed only through an explicit human path. A certification
never outlives the evidence it certified. **Who** is acting is whatever login the database authenticated, never a name
someone types.

## Identity: reviewers are database logins, not names

**A reviewer is a PostgreSQL login role that one human holds.** A role qualifies only if all of these hold:
- it is a member of the group role `bai_reviewer`;
- it has no administrative attribute: superuser, CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS;
- it is not a member of `bai_automation`;
- it cannot act as the owner of any BAI schema or table, so it cannot disable a trigger.

`research.role_review_refusal(role)` gives the reason a role fails.

**Enrollment.** The human logs in with that role and runs `research:reviewer --enroll "<Full Name>"`
(`research.enroll_reviewer`), which binds the display name to the role. A row naming any other role is refused, so no one
can enroll someone else, and the owner's session can't enroll itself. A registration is immutable. Anyone may deactivate
one, since that only removes power. Deactivated reviewers are never reactivated or deleted.

**Session identity.** `research.session_reviewer()` derives the reviewer from `session_user`. PostgreSQL verifies the
credential server-side (password or certificate). `SET ROLE` does not change `session_user`, and SECURITY DEFINER
functions keep it, so the identity holds inside the human-only functions. A name passed as an argument is never trusted.

**Human-only actions.** These are SECURITY DEFINER functions that only `bai_reviewer` may execute. The tables they write
refuse the same change from any other session, by trigger, so a direct SQL statement from the owner or an automation
login doesn't get around them.

| Action | Function | CLI (on the reviewer's own login) |
|---|---|---|
| Enroll yourself | `research.enroll_reviewer` | `research:reviewer -- --enroll "<Full Name>"` |
| Accept a proposal | `research.accept_proposal` | `research:accept -- --proposal <id> --reason "..." --write` |
| Reject a proposal | `research.reject_proposal` | `research:proposals -- --reject <id> --reason "..."` |
| Reconsider a decision (same evidence) | `research.reconsider_resolution` | `research:reconsider -- --table t --id n --field f --observation <obs> --reason "..." --authorize --write` |
| Ratify an operator decision unchanged | `research.ratify_resolution` | `research:ratify -- --resolution <id> --reason "..." --write` |
| Open the certification gate | `research.set_certification_gate` | `research:gate -- --open --reason "..."` |
| Certify a recorded check | `research.certify_class` | `research:certify -- --check <id>` |

The CLI runs these commands on `BAI_REVIEWER_DATABASE_URL`, the human's own login. It refuses to run them on the
owner's connection. The same `--confirm-hosted <ref>` rule applies to hosted writes. Without `--write`, accept,
reconsider and ratify are dry runs.

## Certification

1. **A check.** Anyone (agents included) records a deterministic certification check with
   `research:check -- --org … --channel … --year|--period …`. It stores the blockers, the metrics and a **fingerprint**
   of every record of the class: its picks or signings, slots, players, outcome records, acquisition dispositions,
   coverage claim, every observation about them and every resolution. A check certifies nothing.
2. **A reviewer certifies that check** (`research:certify -- --check <id>`). The database refuses it unless:
   - the session is an enrolled reviewer;
   - the certification gate is open;
   - the check passed and is under 7 days old;
   - the class is at `COVERAGE_REVIEW`;
   - **the fingerprint is unchanged**: the reviewer certifies exactly the state that was checked;
   - no decision on the class's records is still unratified.

**Blockers** in a check include open conflicts on the class's own records, including how each acquisition ended. They
also include `DECISIONS`: an operator-label choice (rule `REQUIRE_OPERATOR`) that no reviewer session took or confirmed.
Such a choice stays a valid research judgment, but a reviewer must ratify it (unchanged) or re-decide it before
certification. Declared-rule resolutions such as `PREFER_HIGHER_AUTHORITY` are deterministic and need no ratification.

**Certifications** are immutable except for a single, final revocation, and are never deleted. `CERTIFIED` history
rows record the reviewer's login (`session_role`) and `reviewer_session = true`.

## The certification gate is closed

`research.certification_gate` starts **disabled**, and while it is closed every certification is refused. Closing it is
allowed to anyone. Opening it is a reviewer-session action, logged as `CERTIFICATION_GATE_CHANGED`.

### What remains before certification

Binding identity to logins defends against name spoofing, a session flag that claims authorization, `SET ROLE`
impersonation, and any login without owner powers. It is tested against each.

It **cannot** defend against whoever holds the database **owner** credential. That holder can create a login role,
grant it `bai_reviewer`, set its password and log in as it, or drop a trigger. No rule inside the database can tell that
from a human.

Today the research automation works with the owner credential, both locally (a superuser) and on hosted
(`.env.hosted.local`). So the gate stays closed until all of the following are true:

1. **The automation stops holding the owner credential.**
   - Create an automation login: a member of `bai_automation`, not an owner, no CREATEROLE.
   - Grant it only the data privileges ingestion needs.
   - Point the automation's environment at it.
   - Rotate the `postgres` password, and let only the human administrator know the new one.
   - Apply migrations from the administrator's session only.
2. **Each reviewer gets a login only they know.**
   - The administrator runs, for each reviewer: `create role <name> login password '<chosen by the reviewer>'; grant bai_reviewer to <name>;` (or certificate authentication).
   - Never store the password in the repository or in any file the automation can read.
3. **Each reviewer enrolls** from their own machine: `research:reviewer -- --enroll "<Full Name>"`.
4. **Audit.** `hosted:security` lists every `bai_reviewer` member, the role that granted each membership, the enrolled
   reviewers and the gate state. It fails if a reviewer function is executable by anyone but `bai_reviewer`. Check that
   the list is exactly the people you expect.
5. **A reviewer opens the gate** with a reason: `research:gate -- --open --reason "..."`.

Until then: classes reach `COVERAGE_REVIEW` with recorded checks, and reviewers can enroll, accept, reject, ratify and
reconsider (these are logged with their login). Certification is disabled.

## What is recorded

`research.decision_history` is append-only. A trigger refuses every `UPDATE`, `DELETE` and `TRUNCATE`;
`research.certification_checks` is append-only the same way. One row is written per judgment:

| Kind | Written when |
|---|---|
| `RESOLVED` | a fact conflict is resolved the first time (`research:resolve`: an operator label or a declared rule; or `research:accept`) |
| `RESOLVED_WITH_NEW_EVIDENCE` | new observations reopened a recorded decision and it is decided again |
| `RECONSIDERED` | same evidence, a different judgment, in a reviewer session |
| `RATIFIED` | a reviewer session confirmed, unchanged, a decision taken without one |
| `EVIDENCE_CHANGED` | a change touched a record of a certified class (it revoked the certification) |
| `CERTIFIED` / `CERTIFICATION_REVOKED` | certification and revocation, by a human, or automatically because evidence changed (`system:evidence-changed`) |
| `CERTIFICATION_GATE_CHANGED` | the gate was opened or closed |

Each row carries:
- the classes the record belongs to;
- the record and field;
- the previous and new value, with their observations and sources;
- `decided_by`;
- `session_role` (the authenticated login) and `reviewer_session`;
- the reason;
- the evidence: every observation considered, plus links the reviewer adds;
- the certification impact;
- links to the resolution, certification, import batch or proposal.

Decisions recorded before 021 enter once as baseline rows marked `[baseline: recorded before migration 021]`.

## Evidence changes revoke, in the same transaction, by any path

Database triggers (`research.on_evidence_change`) revoke the certification of every affected class in the same
transaction. The class returns to `COVERAGE_REVIEW`, its certification job reopens, and the history names the import
batch, if any, and the session's login. The triggers fire on:
- any insert, update or delete of an acquisition record of a certified class: pick, signing, slot value, international signing, player, coverage claim;
- any update or delete of a dated outcome record: audit, details, debut, WAR, acquisition disposition, trade;
- any observation that **contradicts** another active claim about the same field;
- any decision on such a field.

A **new** dated outcome row (next season's audit or WAR) adds information and does not revoke; neither does a
corroborating observation.

Rolling back the change rolls back the revocation too. A dry run of an import reports what would be revoked
(`certifications_revoked`) and changes nothing. The trigger functions run with the owner's rights, so a write from any
login is guarded the same way.

## Proposals

- Anyone, automated agents included, may file one with `research:propose`: the claim to choose, the reasoning and the evidence.
- A proposal decides nothing.
- Only a reviewer session accepts one (`research:accept`: it decides the open conflict as proposed, or reconsiders the recorded decision) or rejects one.
- The proposer may withdraw it.
- Proposals are immutable and never deleted. Both the proposing and the deciding login are recorded.

## Tests

`tests/db/decision-history.test.mjs` uses three logins: the owner's (what the automation holds today), a reviewer login,
and an automation login with ordinary data privileges.
- **Spoofing:**
  - enrolling another person's role, or the owner's;
  - an automation role that was also granted `bai_reviewer`;
  - a role that can act as the table owner, or that has CREATEROLE;
  - automation names;
  - a reviewer's name passed with the authorization flag;
  - `SET ROLE` to a reviewer's login (session_user is unchanged).

  All are refused.
- **Escalation:**
  - certifying, or inserting a certification, from the owner or automation session;
  - calling reviewer functions without `bai_reviewer`;
  - disabling a guard trigger as non-owner;
  - rewriting the history;
  - `SET SESSION AUTHORIZATION`.

  All are refused.
- **Gate:**
  - closed by default;
  - the owner can neither open it nor spoof a reviewer to open it;
  - the reviewer opens it;
  - closing is anyone's;
  - every change is logged.
- **Certification:**
  - a change after the check makes it uncertifiable;
  - the `CERTIFIED` row records the reviewer's login.
- **Reconsideration:** revokes; both judgments are kept; idempotent.
- **Revocation:**
  - an applied batch revokes (its dry run only reports);
  - a direct `UPDATE` revokes inside its transaction and un-revokes on rollback;
  - an automation login's update revokes;
  - a new dated outcome row doesn't revoke, but changing one does.
- **Proposals:** the agent proposes; owner and automation cannot accept; the reviewer accepts (on an open conflict, or by reconsideration) or rejects.
- **Ratification:** an operator decision blocks the check until the reviewer ratifies it.

`tests/db/integrity.test.mjs` proves the shared invariants detect real violations. Among them is
`CERTIFICATION_WITHOUT_REVIEWER_SESSION`: an active certification without a check, an enrolled reviewer, and a
`CERTIFIED` history row from that reviewer's login. It runs with the guards removed, too. `hosted:verify` runs every
invariant against hosted.
