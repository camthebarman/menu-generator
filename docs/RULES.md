# Rules implemented by the engine

These are the deterministic rules in `src/domain/`. The live database functions re-enforce the hard constraints (status, cutoffs, quality review, pool, quantity, version).

## Pools and availability
- Each lot belongs to exactly one pool. Storage location is separate.
- Food sees Food + Shared lots; Bar sees Bar + Shared. Managers can view every pool, but discovery always respects pool boundaries.
- Shared stock is one physical balance. Moving stock between pools uses a transfer (managers only). A transfer preserves lot identity, dates, cost, and provenance; a partial transfer splits the lot into a child lot that keeps `parentLotId`.
- Free for specials = physical − active reservations − applicable unreserved menu protection, per lot and never negative.

## Dates and eligibility (`eligibility.ts`)
- Evaluated for the **planned service date** as a local calendar date in the organization's timezone. Receipt timestamps are converted with the same timezone.
- Inclusive cutoff (default): a lot is usable *on* its cutoff date. Exclusive cutoff is configurable.
- **Blocked** (never allocated, and never rescued by cooking, freezing, or mixing): statuses quarantined, spoiled, discarded, depleted, or recalled; past the hard-discard date, operational discard date, use-by date, or expiration date (the last two when policy treats them as hard, which is the default); past the earliest input cutoff for prepared outputs without a verified rule.
- **Needs review** (not allocated; makes a short line Needs review): status needs_review; unknown quantity; passed quality (best-by) date without a recorded manager review valid through the service date; a perishable lot with no cutoff, or with an unverified date (both configurable); passed sell-by when policy says so (informational by default, in line with USDA guidance that sell-by is a retail inventory date).
- A manager quality review can never extend past a hard cutoff.
- **FEFO**: dated lots ascending by effective cutoff, then undated eligible lots by receipt age (an explicit fallback, labeled in results). Priority lots chosen by the user are allocated first.
- Upcoming-date alerts (default ≤2 days) are reminders, not safety guarantees.

## Matching (`allocate.ts`, `match.ts`)
1. Resolve each line to a canonical ingredient and form. Raw, cooked, and prepared forms never substitute for each other. Unmapped lines, unknown quantities, and missing conversions become Needs review.
2. Scale to the requested yield (servings or batch quantity).
3. Normalize units. Same-dimension conversions use standard factors (US fl oz = 29.5735295625 ml). Cross-dimension, package (bottle/can/case), bar-measure (dash, sprig, wedge), and edible-yield/trim conversions require recorded ingredient-specific factors or a lot package size. Trim is applied once, at demand resolution.
4. Aggregate repeated demand per ingredient + form across all lines and all combined recipes.
5. Process components top-down: use eligible prepared stock first, then expand only the shortfall into the component recipe's raw inputs. Prepared stock and raw inputs are never double-counted, and cycles are detected and reported.
6. Allocate FEFO from free stock. Optional lines use only leftover stock, are never partially used, and every omission is disclosed.
7. Shortfalls are counted by **distinct canonical procurement ingredient**, not by line or unit. Results distinguish missing from insufficient and show have/need/short.
- **Groups**: Make now = every required check passes for the requested yield. Need 1 / Need 2 = one or two distinct ingredients short. Needs review = anything unresolved. 3+ = shown separately.
- **Capacity**: the largest yield that passes every check, found by search. A recipe whose requested yield exceeds capacity is never Make now. Capacity is marked non-exact when it relies on assumed staples.
- **Staples**: count as available only when a manager has confirmed them, and are always disclosed.
- **Allergens**: unknown data → "incomplete", never "allergen-free". Filters hide unknowns and say so. **Alcohol**: any alcoholic ingredient (bitters and vanilla extract included) makes a drink "contains alcohol".
- **Substitutions**: only declared substitutes. Each one is a separate, fully revalidated result that discloses changed quantities, allergens, and alcohol status.
- **Urgency / older stock**: the engine reports actual quantities consumed from at-risk lots and the share of each lot. Use under 20% of a lot is labeled "not evidence of waste reduction". Value is labeled "Stock value used"; it is never presented as realized savings.

## Menu protection (`stock.ts`)
- Demand = confirmed menu mappings × manually entered expected portions + explicit protected quantities. No forecasts are invented.
- Unverified or missing mappings, or missing portions, → "Current menu protection incomplete".
- Active menu-purpose reservations reduce protection demand first, so nothing is deducted twice.
- Protection holds own-pool stock first, then Shared, latest-dated first, so older stock stays available to specials. Both workspaces' protection claims apply to the same Shared lots. Relaxing protection releases only the requesting workspace's claim.

## Costs (`match.ts`)
- Costs are optional. Cost is computed from normalized quantities per allocated lot. Any unknown → "Partial cost"; none known → "Cost unknown". A complete margin is never derived from partial data.
- Target price is shown only when portion cost is complete and a target ingredient-cost % is set. Labor and overhead are excluded.

## Precision
- Quantities are stored in base units (g, ml, each): `numeric(20,6)` in Postgres, rounded to 1e-6 in TypeScript. Conversions round once at that boundary. Display rounds; shortfalls round **up**.
- Money is `numeric(14,4)` and displayed at 2 decimals.

## References
These inform the design constraints. They do not replace local rules or verified procedures.
- USDA Food Date Labeling: https://www.usda.gov/sites/default/files/documents/USDA-Food-Date-Labeling-Infographic.pdf
- FDA Food Code: https://www.fda.gov/food/retail-food-protection/fda-food-code
- Supabase secure data: https://supabase.com/docs/guides/database/secure-data
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
