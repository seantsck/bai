# Identity resolution

Every staged record names a player. `ingest.resolve_identity(jsonb)` decides who that is before anything canonical is written. Strong external ids dominate weak name matching, and name-only matching never merges players automatically.

## Inputs
- **External ids:** `MLBAM`, `BBREF`, `BBREF_MINORS`, `FANGRAPHS` and other systems in `player_external_ids`. Each id is unique per system, and a player has at most one id per system.
- **Name:** the full name, normalized (accent fold, case, punctuation), plus aliases in `player_aliases`.
- **Birth date** (day precision only) and **birth country**.
- **School and event context:** carried on the record for researchers' review, not used for automatic links.

## States

| State | Rule | Auto-link? |
|---|---|---|
| `EXACT_EXTERNAL_ID` | At least one supplied id resolves, all supplied ids resolve to the same player, and that player holds no different id in a supplied system | **yes** |
| `EXACT_COMPOSITE` | No id matched. Exactly one candidate matches name (or alias) **and** exact birth date, with a compatible birth country, and no other name candidate exists | **yes** |
| `PROBABLE_MATCH` | Exactly one name candidate, without birth-date confirmation (including a candidate whose birth date differs) | no, held |
| `AMBIGUOUS` | More than one name candidate | no, held |
| `NO_MATCH` | No candidate. Name matches that provably differ (they hold a different id in a supplied system) are excluded | creates a new player |
| `CONFLICT` | Supplied ids resolve to different players, or the matched player holds a different id in a supplied system | no, held |

Notes:
- **Birth-date disagreement under an id match:** when the external id matched but the birth date differs, the player is still linked (`EXACT_EXTERNAL_ID`). The disagreement becomes a field conflict on `players.birth_date` with rule `REQUIRE_OPERATOR`. Ids identify people; birth dates are claims about them.
- **No silent re-pointing:** a new id is added to a player only if it belongs to no one else and the player has no id in that system. An existing id is never replaced.
- **Within one batch:** identity is re-resolved at apply time against current state, record by record. A player created by an earlier record is found by the same id in a later record. This is how the four re-drafted 2015 Dodgers picks joined their own earlier selections.

## Research queue and decisions
- **Held records:** PROBABLE_MATCH, AMBIGUOUS and CONFLICT records are `HELD` on apply and write nothing. They appear in the `IDENTITY_AMBIGUOUS` queue (priority 1) with their candidates and the reason each was considered.
- **Recording a decision:**

  ```
  npm run research:identity -- --record <staged id> --player <slug> --operator <you> --note "why"   # link
  npm run research:identity -- --record <staged id> --new-player --operator <you> --note "why"      # different person
  npm run research:identity -- --record <staged id> --reject --operator <you> --note "why"          # leave out
  ```

  The decision (`review_state`, `reviewed_by`, `review_note`) is stored on the staged record. It takes effect on the next `research:apply --write`.

## Slugs
New players get `slugify(display name)`. On a collision the slug becomes `name-<birth year>`, then `name-2`, `name-3` and so on. Slugs are presentation only. The stable keys are `players.id`, `players.player_key`, and the external ids.
