# R8C: private corroborating evidence (design only, DRAFT)

Status: **design and a disposable-database proof of concept. No migration, no hosted change, no publication grant, no reviewer enrollment.** The proof of concept is `r8c-private-evidence-poc.sql`, exercised by `tests/db/r8c-private-evidence.test.mjs` with fictional fixtures.

## The problem
A trade reaches `VERIFIED_COMPLETE` only with a PRIMARY_ANNOUNCEMENT source and a second independent source on every package and asset (`research.transaction_gaps`). Every source row a public record cites must be authorized for display (migration 030): an open category or a category with a recorded grant. The independent sources a researcher finds for trades are almost all MLB or other publications (see `r8b-source-policy.md`), which are not authorized. So the evidence exists and cannot be used. Policy C asks whether BAI may *keep it privately*, as research support, without publishing it.

## Proposal in one paragraph
Add a separate schema (`evidence_private`) that website roles, the Data API and the read-model refresh cannot see, holding: an immutable **source identity** (URL, publisher, category, origin group, lineage note), append-only **permission events** (what BAI may do with that source privately, with a pointer to its basis), append-only **evidence items** (citation metadata and BAI's own paraphrase; no column for source text, screenshots or datasets), and append-only **reviews** by enrolled humans. Standing is *derived* (PROPOSED, ACCEPTED_FOR_INTERNAL_USE, REJECTED, SUPERSEDED, SUSPENDED), never a stored flag. Private evidence feeds an internal status only. It never writes `public.transaction_sources`, never calls `research.verify_transaction`, and never changes a read model.

## Requirements and how the design meets them
| Requirement | Design |
|---|---|
| Separate internal evidence from publicly displayable sources | different schema; no function, view or trigger in `public`, `research` or `analytics` references it (tested); public tables are not written |
| Authentic identity, category, origin, independence lineage | `source_identity` is append-only; category uses the existing vocabulary and is never relabelled; `origin_group` is the lineage; an item from the transaction's own origin group, or from RETROSHEET / BASEBALL_REFERENCE / CHADWICK_REGISTER, cannot be proposed as independent (trigger) |
| Store only material permitted by the terms | `permission_event` records the permission and its basis (a reference, never the text); `item` has only locator, retrieval date and a 500-character paraphrase column; adding a source with no permitted private use is refused; whether the *terms* permit even a paraphrase is a human judgement outside the database |
| No restricted text, screenshots, datasets | no such column exists; the local R8B validator also forbids text-like fields; large artefacts would stay outside the database and outside git |
| Inaccessible to website roles and the Data API | no grant to `anon`, `authenticated`, `service_role` or `public`; schema not exposed; row level security enabled with policies only for internal roles (tested with `has_*_privilege` and a real `set role anon`) |
| No automatic public VERIFIED_COMPLETE | `internal_corroboration` is a view that says `INTERNAL_ONLY_NOT_PUBLIC_STATUS`; `research.transaction_gaps` is unchanged by private items (tested) |
| Human accountability and immutable history | review requires an enrolled reviewer in their own login session (the existing `research.session_reviewer()`), an open certification gate, and a different login than the proposer; no update, delete or truncate anywhere (tested) |
| Source permission withdrawal and evidence changes | see below |

## What withdrawal and change do
* **Withdrawal of private-use permission** is a new `PRIVATE_USE_WITHDRAWN` event. Every item from that source becomes SUSPENDED at once (derived from the latest event), the internal corroboration count drops, and new items and reviews for the source are refused. Nothing is deleted; a renewed permission restores standing without rewriting history. Published records are unaffected **because they do not depend on private evidence**.
* **A change of evidence** is a new item that supersedes the old one; the old item stays and is SUPERSEDED; a review of a superseded item is refused.
* **If a future decision lets private evidence support a public verification**, that is a different and much larger change and is *not* proposed here. The rule it would have to obey: a verification that relied on private evidence must record which items, and a withdrawal or supersession must revoke that verification in the same transaction (as `research.transaction_changed` already does for public evidence), which in turn withdraws the transaction from the public read models through the existing lifecycle. Until that exists, private evidence can only guide where a human looks.

## What this does *not* give you
Private evidence cannot raise any public completeness label. Under today's rules the number of publishable VERIFIED_COMPLETE trades stays zero until a *public* source policy allows independent sources to be displayed. Policy C is therefore a research accelerator and an audit trail, not a route to the label. Two honest consequences: (1) it can mislead if its internal status were ever shown, hence the explicit status note and the absence of any public path; (2) reviewers spend effort on evidence that cannot yet be published.

## Comparison with a narrower, legally reviewed citation-metadata policy (policy A)
| | C: private evidence schema | A: grant display of citation metadata for a category after legal review |
|---|---|---|
| Public outcome | none directly | citation (title, publisher, URL, locator) shown; the transaction can publish and, with two independent sources, reach VERIFIED_COMPLETE |
| Legal exposure | low (internal; confirm the terms permit private notes) | needs advice per source family; MLB has stated restrictions; OTHER_PUBLICATION is not one rights holder |
| Engineering | new schema, guards, roles, review workflow (this PoC) | a grant row per category (already supported) plus exact scope text; but a category-wide grant clears every publisher in the category, which is why the R8B tooling refuses to treat it as clearing an unreviewed publisher |
| Reversibility | withdraw an event; nothing public depended on it | withdrawing a grant withdraws every record that cited it (existing trigger path) |
| Risk of over-claiming | internal label could leak | the public label is earned |
| Fits current evidence | yes, today | only after counsel and owner decision |

Recommendation: **do not choose between them yet.** C is safe to build (it is inert and cannot publish) but it only pays off if A, or a source-by-source rights clearance, later lets something public use the same evidence. If the owner wants one path first, A narrowed to *specific named publishers* (not a category-wide grant) after legal advice is the only route to a public label; C should be built only if reviewers are going to do the research work in the meantime.

## What a real migration would additionally need (not done)
* a numbered migration through the owner-signed promotion runner, with an exposed-schemas check proving `evidence_private` is not in the Data API schema list;
* a deliberate decision about which login roles may register sources and record permission events (owner only in the PoC);
* an enrolled independent reviewer (inactive today; `research.certification_gate` stays disabled) and the evidence-approval workflow in `r8b-reviewer-workflow.md`;
* backups: the schema would be included in the logical export; its contents are internal research, not public data, so retention and who may restore need stating;
* a decision on where non-database artefacts (notes, hashes of retrieved pages) live, outside git.

## Boundaries observed
No hosted migration; no publication grant; no reviewer enrollment; no change to production; no source text, screenshot or dataset imported; the PoC file lives under `docs/` and the numbered migrations are untouched (tested).
