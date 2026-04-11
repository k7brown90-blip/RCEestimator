# Common Install Assembly Blueprint (90% Install Scope)

Date started: 2026-03-24
Owner: Red Cedar Estimating
Status: In progress

## Purpose
This is the working tracker for high-frequency residential installs.
Use it to review assemblies one by one, record pricing/labor/material changes, and track code/compliance improvements.

## Focus Scope (Initial)
- Branch circuits: #17, #18, #101, #102
- Kitchen/appliance: #44, #46, #47, #97
- HVAC/A-C: #48, #49
- Water heater: #43
- EV charging: #59, #60
- Laundry: #45, #98
- Exterior branch/device: #40, #42
- General equipment: #50

## Priority Review Order
1. #17 Add Dedicated 120V Circuit
2. #18 Add Dedicated 240V Circuit
3. #59 EV Charger Circuit
4. #43 Water Heater Circuit / Connection
5. #48 HVAC Condenser Circuit
6. #49 Air Handler / Furnace Electrical Connection
7. #44 Range Circuit / Connection
8. #47 Microwave / Hood Circuit
9. #46 Dishwasher / Disposal Circuit and Connection
10. #45 Dryer Circuit / Connection
11. #40 Exterior Dedicated Equipment Circuit
12. #42 Gate / Exterior Device Feed
13. #101 Outlet Circuit Extension
14. #102 Lighting Circuit Extension
15. #60 EV Charger Install with Customer-Supplied Equipment
16. #50 Garage / Shop Equipment Circuit
17. #97 Kitchen Room Package
18. #98 Laundry Room Package

## Similarity Bundles (Tune Together)
- Branch backbone: #17, #18, #101, #102
- EV + 240V equipment: #59, #60
- Appliance branch group: #46, #47, #48, #49
- 30A/50A endpoint pair: #43, #44, #45
- Exterior branch group: #40, #42
- Package wrappers: #97, #98

## Review Template (copy for each assembly)
### Assembly #<id> <name>
- Date reviewed:
- Reviewer:
- Current labor units:
- Current material lines:
- Current selectable equipment/endpoints:
- Code checks confirmed:
- Changes requested:
- Changes implemented:
- Test/validation performed:
- Open questions:
- Final decision:

## Progress Tracker
| Assembly | Name | Status | Last Update | Change Summary |
|---|---|---|---|---|
| 17 | Add Dedicated 120V Circuit | queued | 2026-03-24 | Baseline captured |
| 18 | Add Dedicated 240V Circuit | queued | 2026-03-24 | Baseline captured |
| 59 | EV Charger Circuit | updated | 2026-03-24 | Added explicit EV breaker/raceway/connection parameters |
| 43 | Water Heater Circuit / Connection | updated | 2026-03-24 | Added mandatory disconnect material/labor |
| 48 | HVAC Condenser Circuit | updated | 2026-03-24 | Added explicit breaker size/type controls |
| 49 | Air Handler / Furnace Electrical Connection | updated | 2026-03-24 | Added explicit breaker size/type controls |
| 44 | Range Circuit / Connection | queued | 2026-03-24 | Baseline captured |
| 47 | Microwave / Hood Circuit | queued | 2026-03-24 | Baseline captured |
| 46 | Dishwasher / Disposal Circuit and Connection | queued | 2026-03-24 | Baseline captured |
| 45 | Dryer Circuit / Connection | updated | 2026-03-24 | Plug-only endpoint policy (14-30/14-50) |
| 40 | Exterior Dedicated Equipment Circuit | queued | 2026-03-24 | Baseline captured |
| 42 | Gate / Exterior Device Feed | queued | 2026-03-24 | Baseline captured |
| 101 | Outlet Circuit Extension | updated | 2026-03-24 | Breaker auto-zero support for existing-circuit mode |
| 102 | Lighting Circuit Extension | updated | 2026-03-24 | Breaker auto-zero support for existing-circuit mode |
| 60 | EV Charger Install with Customer-Supplied Equipment | updated | 2026-03-24 | Added material tracking plus EV breaker controls |
| 50 | Garage / Shop Equipment Circuit | queued | 2026-03-24 | Baseline captured |
| 97 | Kitchen Room Package | queued | 2026-03-24 | Baseline captured |
| 98 | Laundry Room Package | queued | 2026-03-24 | Baseline captured |

## Change Log
| Date | Assembly | Change Type | Before | After | Why |
|---|---|---|---|---|---|
| 2026-03-24 | 39, 61, 62, 88 | Removal | Present in catalog, pricing, and references | Removed from pricing/targeted lists and blocked in API/service | Eliminate redundant assemblies and avoid workflow noise |
| 2026-03-24 | 43 | Policy update | Water-heater circuit without guaranteed disconnect line item | Added mandatory disconnect material/labor line items | Enforce company best-practice requirement |
| 2026-03-24 | 45 | Policy update | Dryer supported hardwire path | Dryer now plug-and-cord path only (14-30 or 14-50) | Align with install standard and simplify field workflow |
| 2026-03-24 | 48, 49, 59, 60 | Parameter upgrade | Limited/fallback parameterization | Added explicit breaker size/type and EV connection-method controls | Support GFCI upsells and clearer 240V/EV configuration |
| 2026-03-24 | 101, 102 | Material logic | Breaker always counted | Breaker quantity now parameter-driven via source-circuit mode | Existing-circuit extensions should not force new breaker material |
| 2026-03-24 | Breaker material lines (global) | Pricing engine | Breaker material cost largely static by template line | Breaker cost now dynamically scales by selected breaker size/type/pole configuration during expansion | Ensure pricing tracks estimator selections as work progresses |
| 2026-03-24 | Wire and raceway material lines (global) | Pricing engine | Wire/raceway material unit costs were static by template defaults | Wire and raceway unit costs now resolve from selected raceway/cable method and conductor type during expansion | Ensure estimator-selected installation method drives pricing with no hardcoded method assumptions |

## Known Gaps to Close
- Explicit standalone refrigerator circuit assembly not present.
- Explicit standalone sump pump circuit assembly not present.
- Voltage drop is not currently auto-calculated.
- Conduit/raceway sizing and conduit fill are not currently auto-calculated.
- Ampacity derating and OCP sizing are not currently auto-calculated.

## Owner Directives (2026-03-24)
- Raceway types should remain globally selectable so estimators can handle uncommon real-world conditions.
- Add 20A option to 240V branch circuits for smaller water-heater/equipment use cases.
- Water heater circuits should include local service disconnect (best-practice standard).
- Range circuits should expose GFCI breaker as an optional safety upsell (not forced).
- Dryer circuits should be cord-and-plug only (no hardwire option), with 30A and 50A plug/cord paths and optional GFCI breaker upsell.
- Dishwasher, microwave, and refrigerator can stay aligned to 2017 NEC baseline in this phase.
- HVAC condenser typical ampacity targets: 25A/30A common, 40A/50A possible.
- EV charger rules:
- 40A/50A/60A target paths.
- Support both cord-and-plug and hardwired equipment models.
- GFCI breaker required when cord-and-plug connected.
- Hardwired EVSE does not require GFCI breaker by company policy.
- Customer-supplied EVSE still tracks all material; customer receipt can be credited.
- Consolidate/remove redundant assemblies where branch builders already cover scope:
- Candidate removals: #61, #62, #39, #88.
- Reframe #40 as complete pool/spa installation checklist-driven builder.
- Reframe #42 as motor-load builder (gates/pumps/other motorized equipment) with shared motor-calculation workflow.
- Keep #101 and #102, but defer deep remodel-variable enhancements until core branch/equipment fixes are complete.
- Room packages must be square-footage driven and include modern appliance/receptacle/protection expectations.
- Distinguish new circuits versus extensions from existing circuits so breaker material is not double-counted.
- Voltage-drop review trigger target: 150 ft and above.
- Material workflow principle: load/amp draw -> breaker size -> conductor size -> conduit size/fill -> material list.

## Confirmed Decisions (2026-03-24)
- Remove assemblies #61, #62, #39, and #88 from catalog usage (full removal target, not hidden/deprecated placeholders).
- Branch-circuit breaker sizing should use a dropdown of standard NEC sizes and include full standard range up to 400A.
- Keep 70A+ visible/available for service, subpanel, and specialty use cases.
- Water-heater scope always includes disconnect installation.
- Range GFCI is optional (upsell/safety upgrade), not forced.
- Dryer is never hardwired:
- 30A plug + cord option.
- 50A plug + cord option.
- 40/50A dryer loads map to 50A cord/plug path.
- Dryer, A/C units, and other 240V household appliance circuits should also expose GFCI breaker upsell options.
- EV scope supports both cord-and-plug and hardwired installations:
- Cord-and-plug EV requires GFCI breaker.
- Hardwired EV does not require GFCI breaker by company policy.
- Raceway options remain globally selectable for estimator flexibility (do not restrict by assembly).
- Pool/spa builder and motor-load builder are postponed and excluded from immediate implementation scope.
- Existing-circuit extension path auto-sets breaker quantity to 0.
- Breaker product type selector required for upsell/fitment options:
- standard
- gfci
- afci
- tandem
- dual_function_gfci_afci
- All references to removed assemblies (#61, #62, #39, #88) must be migrated/cleaned so no stale links, suggestions, or child mappings remain.

## Immediate Implementation Scope (Locked)
- Update branch/appliance/EV assemblies first (no pool/spa/motor-load redesign in this phase).
- Implement breaker-size dropdown standards (full standard list up to 400A) and breaker-type selector.
- Implement dryer endpoint policy (30A/50A cord-and-plug only).
- Implement EV endpoint/GFCI policy split by connection method.
- Implement water-heater always-disconnect behavior.
- Implement GFCI upsell options for dryer, A/C, and other applicable 240V household appliance circuits.
- Implement existing-circuit breaker quantity auto-zero logic.
- Remove #61, #62, #39, #88 and redirect usage to core branch builders.

## Pending Decisions (Must Confirm Before Implementation)
- None. Implementation can proceed with confirmed policy.

## Current Calculation Model (As-Built)
- Component quantity math uses `quantityExpr` against input parameters (for example `run_length`, endpoint flags).
- Endpoint select values map to hidden quantity flags and cable-length keys (for example `endpoint_device -> endpoint_14_50_qty` and `run_length_6_3`).
- Cost rollup is arithmetic only:
	- Labor cost = `laborHours * laborRate * quantity`
	- Material/other cost = `unitCost * quantity`
- No electrical-engineering solver exists yet for voltage-drop %, conduit fill, raceway sizing, conductor ampacity derating, or OCP sizing.

## Compliance Checklist (Track Per Assembly Review)
- Validate load type and continuous-load multipliers where required.
- Validate OCP device type and rating against equipment MCA/MOCP and branch-circuit rules.
- Validate conductor material and insulation assumptions (Cu/Al, THHN/THWN, NM-B, SER, etc.).
- Validate raceway method and conduit fill (including EGC and adjustment factors).
- Validate voltage drop target (recommended 3% branch, 5% feeder+branch total design target).
- Validate disconnect requirements and location (within sight / lockable as applicable).
- Validate GFCI/AFCI requirements by location and equipment type.
- Validate grounding/bonding requirements for equipment and detached structures.
- Validate available interrupting rating and breaker compatibility with panel manufacturer.
- Validate permit, utility, and inspection requirements where applicable.
