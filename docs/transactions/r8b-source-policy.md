# R8B source-policy assessment: what can corroborate a published trade, and what may be shown

Context. A Retrosheet trade can reach VERIFIED_COMPLETE only with a PRIMARY_ANNOUNCEMENT source and a second independent source linked to every package and asset (`research.transaction_gaps`). A transaction is in the public read model only if **every** source it cites is authorized for display: an openly licensed group, or a category with a recorded publication grant (today RETROSHEET). Evidence that is not linked cannot count; evidence that is linked is cited (title, publisher, URL, locator) on the page. There is no "internal-only" link in the current schema.

| # | Class | Examples | Independent of Retrosheet? | Displayable today? | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | **Independently usable, rights-cleared** | WIKIPEDIA (CC BY-SA), WIKIDATA (CC0); CHADWICK_REGISTER is openly licensed but identity-only; BAI_RESEARCH is BAI's own notes, not a third party | Wikipedia: only if its own cited sources are independent (lineage check needed); Wikidata/Chadwick: no, identity data | Yes, no grant needed | Usable now. In the 10-trade pilot, 1 of 23 candidates is in this class and its lineage was not examined. A first-hand announcement is almost never in this class |
| 2 | **Citation-metadata-only** (publication of title / publisher / URL / locator for sources whose text is restricted) | team and league announcements, newspapers, OTHER_PUBLICATION | Yes (first-hand) | **No.** Authorization is per category and all-or-nothing; a category with no grant blocks the transaction | Only a deliberate **owner decision with legal advice** could make this legitimate (a grant that is understood to cover citation metadata only, and a check that no source text is stored: the pilot packages store none). Not assumed; nothing was granted |
| 3 | **Requires additional permission** | MLB (9 of 23 pilot candidates), BASEBALL_REFERENCE (partly derived from Retrosheet, so weak as corroboration anyway) | MLB yes; B-Ref partly derived | No | Needs the rights holder's permission and a grant row; **not granted, not requested here.** B-Ref/MLB-derived data must also never be committed to the repository |
| 4 | **Internal-only evidence** | a page read by a researcher but not linked, screenshots, licensed databases | n/a | Never exposed | Useful for a reviewer's own judgment and for the audit note, but it **cannot satisfy** the corroboration gaps (they read linked sources) and the schema cannot carry it: a new, owner-approved migration would be needed (a private evidence table that `transaction_gaps` may count while the read model never cites it). That is a design decision with security consequences, not part of this work |

## What the pilot shows
All 10 sampled trades have first-hand, apparently independent candidates, and all 10 are blocked on rights (every independent candidate is MLB or OTHER_PUBLICATION). Under today's rules the realistic ceiling is therefore **zero verified-complete records** until a policy decision is made.

## Options for the owner (none selected here)
A. Grant display of citation metadata for OTHER_PUBLICATION (and separately decide MLB) after advice; verification then proceeds with the pilot method.
B. Use only class 1 sources: a small number of trades, each needing a lineage check.
C. Build the private-evidence path (class 4) by a reviewed migration; larger change, separate authorization.
D. Pause R8B; keep records PARTIAL and clearly labelled.
Whichever is chosen, categories are never relabelled to bypass a permission, and a grant change is itself a withdrawal-triggering, owner-authorized act.
