# Research decision history and certification integrity

Migration 021. Research judgments are kept forever, changed only through an authorized human path, and a certification never outlives the evidence it certified.

## What is recorded

`research.decision_history` is append-only. A trigger refuses every `UPDATE`, `DELETE` and `TRUNCATE`, including from the owner. One row is written per judgment:

| Kind | Written when | Who may cause it |
|---|---|---|
| `RESOLVED` | a fact conflict is resolved the first time (`research:resolve`) | an operator, or a declared rule |
| `RESOLVED_WITH_NEW_EVIDENCE` | new observations reopened a recorded decision and it is decided again | an operator, or a declared rule |
| `RECONSIDERED` | the same evidence, a different judgment (`research:reconsider`) | a registered human reviewer only |
| `EVIDENCE_CHANGED` | an applied import batch changed or contested a record of a certified class | (automatic) |
| `CERTIFIED` | `research:certify` passed | a registered human reviewer only |
| `CERTIFICATION_REVOKED` | a certification was revoked: by a human (`research:revoke`), or automatically because evidence changed | human, or `system:evidence-changed` |

Each row carries:
- the classes the affected record belongs to (`research.classes_of_subject`);
- the record and field;
- the previous and new value, with their observations and sources;
- who decided and the reason;
- the evidence: every observation considered, plus links the reviewer adds;
- the certification impact (`NONE`, `CLASS_NOT_CERTIFIED`, `CERTIFICATION_REVOKED` with the revoked class ids, `CERTIFIED`);
- links to the resolution, certification, import batch or proposal.

The decisions recorded before 021 enter once as baseline rows marked `[baseline: recorded before migration 021]`.

## Rules the database enforces

- **Resolutions** (`public.fact_resolutions`):
  - never deleted;
  - their subject is immutable.
  - **Same evidence, different judgment:** a change goes through only if the transaction carries `bai.reconsideration = 'authorized'`, which only `research:reconsider` sets. `decided_by` must be a registered, active reviewer, and the reason must be new.
  - **New evidence:** a change whose considered observations grow is an ordinary re-decision.
- **Reviewers** (`research.reviewers`):
  - only a human registers one (`research:reviewer --add`);
  - `agent:`, `rule:`, `system:` and `bai-` operator labels can never be registered;
  - a registration is immutable: reviewers are deactivated, never deleted or reactivated.
- **Certifications:**
  - inserted only for a registered, active reviewer (the older `agent:` check stays as well);
  - immutable except for one revocation, which is final;
  - never deleted.
- **Evidence change revokes.** A resolution, re-decision or reconsideration touching a record of a certified class revokes that certification in the same transaction. The same applies when an applied batch inserts, fills, or contests one of its records.
  - The class returns to `COVERAGE_REVIEW`, its certification job reopens, and a human must certify again.
  - A dry run reports which classes would be revoked (`certifications_revoked`) and changes nothing.
- **Proposals** (`research.decision_proposals`):
  - Anyone, automated agents included, may file one: the claim to choose, the reasoning and the evidence (`research:propose`).
  - A proposal decides nothing. Only a registered reviewer accepts it (by resolving or reconsidering with `--proposal <id>`; the decision must match the proposal) or rejects it with a reason. The proposer may withdraw it.
  - Proposals are immutable, never deleted, and the accepted decision's history row names the proposal.

## Commands

```bash
npm run research:reviewer   -- --add "<Full Name>" --operator "<you>"               # a human registers a reviewer
npm run research:propose    -- --table draft_signings --id <n> --field signing_bonus_usd --observation <obs> --rationale "..." [--evidence a,b] [--agent bai-research]
npm run research:proposals                                                             # open proposals
npm run research:resolve    -- --table … --id … --field … --observation <obs> --operator "<reviewer>" --rationale "..." --proposal <id> --write
npm run research:reconsider -- --table … --id … --field … --observation <obs> --reviewer "<reviewer>" --reason "..." --authorize [--evidence url] [--proposal <id>] --write
npm run research:proposals  -- --reject <id> --reviewer "<reviewer>" --reason "..."
npm run research:history    -- --org LAD --channel draft --year 2016                   # or --table t --id n
```

`research:reconsider` without `--write` is a dry run. Choosing the claim already chosen changes nothing and writes no history (idempotent).

## Tests

`tests/db/decision-history.test.mjs`:
- **Permissions:** automation names can't be reviewers; a direct overwrite is refused, as are an unregistered reviewer, deletion, and agent reconsideration or certification.
- **History integrity:** both judgments are kept with values, sources, reviewer, reason and evidence; the table is append-only.
- **Idempotency:** re-choosing the same claim changes nothing.
- **Revocation:** a reconsideration revokes a certified class; an applied contesting batch revokes it, while its dry run only reports; revocations are final.
- **Proposals:** an agent proposes but cannot accept; a reviewer accepts (the history links the proposal) or rejects.

The rate and coverage invariants that hosted verification checks are in `scripts/research/lib/integrity.mjs`. Each is proven to detect a real violation by `tests/db/integrity.test.mjs`.
