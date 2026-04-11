# Red Cedar Electric — Assembly Blueprint

**Date:** 2026-03-15  
**Purpose:** Define the planned estimating assemblies before major system design and implementation.  
**Scope:** Residential-focused estimating for new construction, remodel/addition, service/diagnostic, and recurring service history.

---

## 1. Why This Exists

The app will estimate with **assemblies**, not raw parts lists.

That means the assembly catalog must be designed before the application is built deeply. If the assembly model is weak, the estimate workflow, labor model, BOM generation, plan takeoff, pricing, and NEC-reference system will all drift.

This document exists to answer:

- What assemblies will exist?
- Which assemblies are Phase 1 vs later?
- What parameters does each assembly need?
- Which labor classes apply?
- Which variants are required?
- What can be estimated cleanly vs what still needs manual handling?

---

## 2. Assembly Design Rules

Every assembly must follow these rules:

1. `atomic` and `package` assemblies are the **customer-facing units of work**; `support` assemblies may remain internal unless surfaced intentionally.
2. Each assembly must decompose into hidden atomic components for:
   - materials
   - labor
   - allowances
   - subcontract items if needed
   - permit impact flags / permit allowances when relevant
3. Assemblies must work in both:
   - `field estimate mode`
   - `blueprint/takeoff mode`
4. Assemblies must support **variants**, not duplicate templates whenever possible.
5. Assemblies must support multiple labor sourcing modes:
   - NECA-backed install labor
   - company-standard repair labor
   - diagnostic blocks
   - flat-rate mode
   - manual override
6. Assemblies should be written in estimator-friendly language first and internal technical detail second.
7. NEC references are optional and added during final review, not required at assembly creation.
8. Permit pricing is not an intrinsic assembly price component. Assemblies can indicate likely permit impact, but permit fees should resolve at the estimate option / job level.
9. Parameter names must be standardized across families. Avoid parallel names for the same concept such as `distance` vs `run_length` or `pole_count` vs `breaker_pole_config`.

---

## 2.1 Assembly Tier Taxonomy

Every numbered assembly must declare one primary tier:

- `atomic`
  - a single-scope unit of work that can stand alone on an estimate
  - examples: replace receptacle, add dedicated circuit, replace breaker
- `package`
  - a bundle of atomic and/or support assemblies presented as one customer-facing scope
  - examples: full service upgrade, detached garage package, smoke/CO package
- `support`
  - an internal attachment, allowance, or modifier that usually rides on an atomic/package assembly
  - examples: permit allowance, trenching, utility coordination, route-difficulty add-on

Rules by tier:

1. Rule 1 in Section 2 applies directly to `atomic` and `package` assemblies.
2. `support` assemblies may be internal-only or selectively customer-visible when estimator judgment requires it.
3. Macro assemblies in Section 5.15 are a subtype of `package`, not a fourth tier.
4. Every `package` assembly should define expected child assemblies.
5. Every `support` assembly should define attachment rules: what parent assemblies it can attach to, and whether it is auto-suggested or manual.

Current default tier assignment:

- `package`
  - `#32`, `#38`, `#41`, `#58`, `#65`, `#79`, `#95`, `#96`, `#97`, `#98`, `#99`
- `support`
  - `#2`, `#66` through `#74`, `#81`, `#82`, `#83`
- `atomic`
  - all other numbered assemblies (including point atoms `#90`–`#94`) unless explicitly reclassified in a later revision

---

## 3. Assembly Families

The catalog should be organized into these families:

1. Diagnostic / Service Call
2. Receptacles / Devices
3. Lighting / Switching / Life Safety Controls
4. Branch Circuits / Feeders
5. Panels / Breakers / Distribution
6. Service Entrance / Meter / Disconnect
7. Grounding / Bonding / Surge
8. Detached Structures / Exterior Power
9. Appliance / Equipment Connections
10. Home Shop / Garage Equipment
11. Generator / Transfer / Backup Power
12. EV / Specialty / Exterior Equipment
13. Pool / Spa / Hot Tub
14. Remodel / Demo / Repair Support
15. New Construction Room / System Takeoff Assemblies

---

## 4. Phase Strategy

## Phase 1 — Explicit Assignment Table

Phase 1 should be explicit, not implied. The recommended Phase 1 target is the set below.

| ID | Assembly | Tier | Why Phase 1 |
| --- | --- | --- | --- |
| 1 | Diagnostic Service Call | atomic | Core service entry point |
| 2 | Additional Diagnostic Hour | support | Extends troubleshooting cleanly |
| 3 | Make-Safe Temporary Repair | atomic | Common hazard response |
| 4 | Replace Standard Receptacle | atomic | High-frequency service item |
| 5 | Replace GFCI Receptacle | atomic | High-frequency service item |
| 6 | Add Receptacle | atomic | Common remodel/service scope |
| 7 | Relocate Existing Receptacle | atomic | Common remodel scope |
| 9 | Replace Standard Switch | atomic | High-frequency service item |
| 10 | Replace 3-Way Switch | atomic | High-frequency service item |
| 11 | Add New Switch | atomic | Common remodel scope |
| 12 | Replace Light Fixture | atomic | High-frequency service item |
| 13 | Add New Light Fixture | atomic | Common remodel/new-work scope |
| 14 | Add Recessed Light | atomic | Common remodel scope |
| 16 | Replace Exterior Light | atomic | Common service/remodel scope |
| 17 | Add Dedicated 120V Circuit | atomic | Common appliance/service scope |
| 18 | Add Dedicated 240V Circuit | atomic | Common equipment/service scope |
| 22 | Replace Breaker | atomic | High-frequency service item |
| 23 | Add Breaker to Existing Panel | atomic | Needed by many circuit additions |
| 24 | Add AFCI / GFCI Protective Device | atomic | Common code-driven upgrade |
| 27 | Replace Main Panel | atomic | Core service-upgrade scope |
| 32 | Full Residential Service Upgrade Package | package | High-value core residential package |
| 33 | Grounding Electrode System Install / Upgrade | atomic | New-construction install or corrective upgrade |
| 37 | Whole-House Surge Protection | atomic | Common upsell / code-driven add |
| 43 | Water Heater Circuit / Connection | atomic | Common appliance scope |
| 44 | Range Circuit / Connection | atomic | Common appliance scope |
| 45 | Dryer Circuit / Connection | atomic | Common appliance scope |
| 75 | Install Ceiling Fan | atomic | Common residential request |
| 76 | Upgrade Receptacle to GFCI | atomic | Common code-upgrade request |
| 77 | Replace Existing Smoke/CO Detector | atomic | High-frequency service/safety scope |
| 78 | Add New Hardwired Smoke/CO Detector | atomic | Common remodel/addition scope |
| 79 | Smoke/CO Detector Package | package | Needed for code-compliant coverage proposals |
| 80 | Bathroom Exhaust Fan Install / Replace | atomic | Common residential request |
| 81 | Load Calculation / Panel Schedule Review | support | Needed by EV/service/panel work |
| 85 | Dimmer / Smart Switch Install or Upgrade | atomic | Common residential upgrade request |
| 82 | Utility Coordination / Disconnect-Reconnect | support | Common admin labor on service work |
| 83 | Trenching / Underground Route | support | Needed by detached structures, EV, spa |
| 88 | Install Equipment Disconnect | atomic | Reusable disconnect scope across families |
| 89 | Install New Subpanel | atomic | Required by detached structures and expansions |
| 19 | Add Multiwire or Multi-Load Appliance Circuit | atomic | MWBC/common-handle paired appliance circuits; added Wave 4 for family completeness |
| 20 | Feeder to Subpanel | atomic | Conductor-run scope for same-building feeders; pairs with #89 Install New Subpanel |
| 21 | Detached Structure Feeder | atomic | Required child of #38 and #41; urgently needed for package expansion |
| 100 | Service Entrance Upgrade | atomic | Service head and entrance conductor scope (Wave 1 addition, see §5.22) |
| 101 | Outlet Circuit Extension | atomic | General branch circuit to receptacle outlet (Wave 1 addition, see §5.22) |
| 102 | Lighting Circuit Extension | atomic | General branch circuit to lighting load (Wave 1 addition, see §5.22) |
| 103 | Load Calculation Assessment | atomic | Customer-facing load review and capacity assessment (Wave 1 addition, see §5.22) |
| 104 | Install Dimmers in New Multi-Gang Cut-In Box | atomic | Purpose-built compound assembly for dimmer installation in a new gang box; gang_count and cable_length parameters eliminate standalone-assembly stacking overhead (Wave 1 addition, see §5.22) |
| 105 | Splice-Through at Device Box | atomic | Remove switch and splice through; blank_plate or constant_power_outlet end state (Wave 1 addition, see §5.22) |

## Phase 2 — Expansion Assemblies

| # | Assembly Name | Tier | Rationale |
|---|---------------|------|-----------|
| 90 | New-Construction Receptacle Point | atomic | Point atom for room packages and standalone takeoff |
| 91 | New-Construction Switch Point | atomic | Point atom for room packages and standalone takeoff |
| 92 | New-Construction Ceiling Light Point | atomic | Point atom for room packages and standalone takeoff |
| 93 | New-Construction Rough-In Only Point | atomic | Phase-split contract support (rough only) |
| 94 | New-Construction Trim-Out Only Point | atomic | Phase-split contract support (trim only) |
| 95 | Bedroom Room Package | package | Per-room new-construction / addition package |
| 96 | Bathroom Room Package | package | Per-room new-construction / addition package |
| 97 | Kitchen Room Package | package | Per-room new-construction / major remodel package |
| 98 | Laundry Room Package | package | Per-room new-construction / relocation package |
| 99 | Garage Room Package | package | Per-room new-construction package |

Additional Phase 2 scope:

- remaining appliance/HVAC expansions
- pool / spa / hot tub depth
- generator / transfer package depth
- garage/shop package depth
- low-voltage / structured wiring, if Red Cedar performs it
- advanced lighting control variants

## Phase 3 — Niche / Advanced Assemblies

1. Solar-interaction related assemblies
2. Battery / storage-prep assemblies
3. Advanced motor/control assemblies
4. High-end lighting control assemblies
5. Utility-specific service package assemblies

---

## 5. Detailed Planned Assemblies

Each entry below defines:

- `Assembly Name`
- `Primary Use`
- `Typical Labor Class`
- `Key Parameters`
- `Required Variants`
- `Notes / Limitations`

---

## 5.1 Diagnostic / Service Call

### 1. Diagnostic Service Call
- Primary use: first visit troubleshooting / assessment
- Labor class: `troubleshoot_diagnostic`
- Key parameters:
  - included_time_hours
  - travel_zone
  - emergency_flag
- Required variants:
  - standard hours
  - after-hours
  - emergency
- Notes / limitations:
  - not a repair assembly
  - may convert into repair estimate or change order

### 2. Additional Diagnostic Hour
- Primary use: ongoing troubleshooting beyond initial block
- Labor class: `troubleshoot_diagnostic`
- Key parameters:
  - added_hours
- Required variants:
  - standard
  - emergency

### 3. Make-Safe Temporary Repair
- Primary use: eliminate immediate hazard without full permanent correction
- Labor class: `make_safe`
- Key parameters:
  - hazard_type
  - material_allowance
- Required variants:
  - exposed conductor
  - failed breaker
  - unsafe splice
- Notes / limitations:
  - should often pair with recommendation for permanent repair

---

## 5.2 Receptacles / Devices

### 4. Replace Standard Receptacle
- Primary use: service/remodel replacement
- Labor class: `remove_and_replace`
- Key parameters:
  - device_grade
  - box_condition
- Required variants:
  - standard
  - tamper-resistant
  - weather-resistant

### 5. Replace GFCI Receptacle
- Primary use: service/remodel
- Labor class: `remove_and_replace`
- Key parameters:
  - line_load_configuration
  - indoor_outdoor
- Required variants:
  - interior
  - exterior
  - garage
  - kitchen/bath/laundry context

### 6. Add Receptacle
- Primary use: any new receptacle location, whether in open framing or extended from an existing source
- Labor class: `new_install` or `extend_from_existing`
- Key parameters:
  - source_method
  - run_length
  - wall_type
  - location_type
  - device_type
  - box_type
  - gang_count
  - box_usage
- Required variants:
  - open wall new install
  - extend from existing, easy access
  - extend from existing, attic fish
  - extend from existing, crawl fish
  - extend from existing, finished wall difficult access
  - exterior / weatherproof
- Notes / limitations:
  - this replaces the previously separate "extend circuit to new receptacle" assembly
  - may require panel capacity or load review outside assembly itself

### 7. Relocate Existing Receptacle
- Primary use: move an existing receptacle location without increasing total device count
- Labor class: `remove_and_replace` or `extend_from_existing`
- Key parameters:
  - wall_type
  - source_box_reuse
  - new_box_type
  - gang_count
  - box_usage
  - patch_scope
  - run_length
- Required variants:
  - same wall, easy access
  - same wall, finished wall
  - same room, attic/crawl accessible
  - exterior relocation
- Notes / limitations:
  - use this instead of `Add Receptacle` when the intent is relocation rather than net-new device count
  - significant patch/finish work should stay as allowance or support assembly

### 8. Replace Device Plate / Trim Only
- Primary use: minor service
- Labor class: `remove_and_replace`
- Key parameters:
  - plate_style
- Required variants:
  - standard
  - oversized
  - weatherproof cover

---

## 5.3 Lighting / Switching / Life Safety Controls

### 9. Replace Standard Switch
- Primary use: like-for-like replacement of an existing single-pole switch
- Labor class: `remove_and_replace`
- Key parameters:
  - device_grade
  - box_condition
  - neutral_present
- Required variants:
  - standard
  - decorative
  - weather-resistant / damp rated

### 10. Replace 3-Way Switch
- Primary use: like-for-like replacement of an existing 3-way device
- Labor class: `remove_and_replace`
- Key parameters:
  - device_grade
  - box_condition
  - traveler_count_verified
- Required variants:
  - standard
  - decorative
  - illuminated

### 11. Add New Switch
- Primary use: add control of a load that does not already have a switch at the desired location
- Labor class: `new_install` or `extend_from_existing`
- Key parameters:
  - run_length
  - wall_type
  - gang_count
  - box_type
  - switching_type
- Required variants:
  - single-pole
  - 3-way / additional control point
  - finished wall fish
  - open framing

### 12. Replace Light Fixture
- Primary use: replace an existing luminaire on an existing box
- Labor class: `remove_and_replace`
- Key parameters:
  - mounting_height
  - fixture_weight
  - box_condition
  - customer_supplied_equipment
- Required variants:
  - standard ceiling fixture
  - wall sconce
  - decorative / heavy fixture

### 13. Add New Light Fixture
- Primary use: create a new lighting outlet and install a fixture
- Labor class: `new_install` or `extend_from_existing`
- Key parameters:
  - run_length
  - ceiling_type
  - attic_access
  - box_type
  - customer_supplied_equipment
- Required variants:
  - open framing
  - finished ceiling, attic accessible
  - finished ceiling, no attic access

### 14. Add Recessed Light
- Primary use: install one new recessed / wafer fixture location
- Labor class: `new_install` or `extend_from_existing`
- Key parameters:
  - run_length
  - ceiling_type
  - insulation_contact_rating
  - attic_access
  - switching_source
- Required variants:
  - retrofit wafer
  - can / housing
  - attic accessible
  - no attic access

### 15. Add Ceiling Fan Rated Box
- Primary use: add or upgrade support so a ceiling fan can be installed safely
- Labor class: `new_install` or `repair_existing`
- Key parameters:
  - ceiling_type
  - attic_access
  - support_requirement
  - existing_box_reusable
- Required variants:
  - new fan-rated box
  - brace retrofit
  - existing box upgrade
- Notes / limitations:
  - use #75 when the fan itself is being installed as part of scope

### 16. Replace Exterior Light
- Primary use: replace an exterior luminaire on an existing circuit
- Labor class: `remove_and_replace`
- Key parameters:
  - mounting_height
  - wall_surface_type
  - weatherproofing_scope
  - customer_supplied_equipment
- Required variants:
  - standard wall light
  - flood / security light
  - motion sensor integrated

Common notes for this family:
- some decorative fixture installs may need manual labor override
- dimmer, smart-switch, timer, occupancy, fan, and smoke/CO work may share related device logic but remain separate assemblies for estimating clarity

---

## 5.4 Branch Circuits / Feeders

### 17. Add Dedicated 120V Circuit
- Primary use: single-purpose 120V branch circuit from panel to one device/outlet (e.g., refrigerator, microwave, bathroom)
- Labor class: `new_install`
- Applicable parameters: ampacity, conductor_type, conductor_size, raceway_type, run_length, conduit_size, bend_count, pull_point_count, route_segments, route_access, pull_difficulty, panel_origin, breaker_pole_config (1-pole), panel_space_impact, termination_count, voltage_drop_review_required

### 18. Add Dedicated 240V Circuit
- Primary use: single-purpose 240V branch circuit from panel to one load (e.g., dryer, range, EV charger, baseboard heater)
- Labor class: `new_install`
- Applicable parameters: ampacity, conductor_type, conductor_size, conductor_count, current_carrying_conductors, neutral_required, equipment_ground_required, raceway_type, run_length, conduit_size, bend_count, pull_point_count, route_segments, route_access, pull_difficulty, panel_origin, breaker_pole_config (2-pole), panel_space_impact, termination_count, voltage_drop_review_required

### 19. Add Multiwire or Multi-Load Appliance Circuit
- Primary use: shared-neutral or common-handle multi-load circuit for paired appliance loads (e.g., dishwasher + disposal on MWBC)
- Labor class: `new_install`
- Applicable parameters: ampacity, conductor_type, conductor_size, conductor_count, current_carrying_conductors, neutral_required, equipment_ground_required, raceway_type, run_length, breaker_pole_config, panel_space_impact, termination_count
- Notes: only for shared/common-handle or explicitly multi-load appliance circuiting, not generic dedicated-circuit work

### 20. Feeder to Subpanel
- Primary use: run feeder conductors from main panel to a new or existing subpanel in the same building
- Labor class: `new_install` or `extend_from_existing`
- Applicable parameters: ampacity, conductor_type, conductor_size, conductor_count, current_carrying_conductors, neutral_required, equipment_ground_required, raceway_type, run_length, conduit_size, bend_count, pull_point_count, route_segments, route_access, pull_difficulty, panel_origin, termination_count, voltage_drop_review_required

### 21. Detached Structure Feeder
- Primary use: run feeder from main panel or meter to a detached structure (garage, shop, ADU) — typically involves longer runs, underground routing, and separate grounding
- Labor class: `new_install`
- Applicable parameters: ampacity, conductor_type, conductor_size, conductor_count, current_carrying_conductors, neutral_required, equipment_ground_required, raceway_type, run_length, conduit_size, bend_count, pull_point_count, route_segments, route_access, pull_difficulty, panel_origin, termination_count, voltage_drop_review_required
- Notes: this is the feeder-only scope; use as a child of `#38` or `#41` when bundled into a package

Shared family variants:
- NM cable
- SE/individuals in raceway
- underground
- attic/crawl
- detached structure

Shared family notes:
- load calculation and panel capacity may affect scope but are not purely assembly-level decisions
- `#17` and `#18` are the base atomic circuit assemblies; exterior or specialty applications should wrap them rather than replace them

---

## 5.5 Panels / Breakers / Distribution

### 22. Replace Breaker
- Primary use: remove a failed or incompatible breaker and install a replacement
- Labor class: `remove_and_replace`
- Applicable parameters: panel_make, breaker_family, breaker_type, breaker_pole_config, tandem_allowed

### 23. Add Breaker to Existing Panel
- Primary use: install a new breaker in an available panel space for a new or relocated circuit
- Labor class: `new_install`
- Applicable parameters: panel_make, panel_spaces_total, spaces_used, breaker_family, breaker_type, breaker_pole_config, tandem_allowed

### 24. Add AFCI / GFCI Protective Device
- Primary use: install or upgrade to an arc-fault or ground-fault breaker for code compliance or safety improvement
- Labor class: `remove_and_replace` or `new_install`
- Applicable parameters: panel_make, breaker_family, breaker_type, breaker_pole_config

### 25. Panel Circuit Rework / Cleanup
- Primary use: customer-facing corrective scope — re-route, re-terminate, or organize existing panel wiring that is messy, non-compliant, or unsafe
- Labor class: `repair_existing`
- Applicable parameters: panel_make, panel_model, panel_amp_rating, branch_circuit_count, panel_spaces_total
- Notes: use `#25` when panel rework is the primary customer-facing scope; use support assembly `#70` when panel conductor rework is a child of a larger panel/service estimate. `#25` and `#70` must not appear on the same estimate for the same panel.

### 26. Replace Subpanel
- Primary use: remove an existing subpanel and install a replacement (same location, upgraded or same capacity)
- Labor class: `remove_and_replace`
- Applicable parameters: panel_make, panel_model, panel_amp_rating, panel_spaces_total, panel_circuits_max, panel_role, panel_bus_type, panel_location_type, branch_circuit_count, grounding_upgrade_required

### 27. Replace Main Panel
- Primary use: remove existing main panel and install replacement — core service-upgrade scope
- Labor class: `remove_and_replace`
- Applicable parameters: panel_make, panel_model, panel_amp_rating, panel_spaces_total, panel_circuits_max, panel_role, panel_bus_type, panel_location_type, branch_circuit_count, grounding_upgrade_required

Shared family variants:
- same-brand direct replacement
- universal/manual selection
- 1-pole breaker
- 2-pole breaker
- tandem breaker
- main breaker panel
- main lug panel
- interior panel
- exterior panel
- panel replacement only
- panel replacement with service work

Shared family notes:
- full panel replacements often cascade into service, grounding, bonding, permit, and utility coordination assemblies
- tandem use must be tied to panel compatibility, not estimator preference alone

---

## 5.6 Service Entrance / Meter / Disconnect

### 28. Replace Service Entrance Cable
- Primary use: replace deteriorated, undersized, or damaged SE cable between meter and panel
- Labor class: `remove_and_replace`
- Applicable parameters: service_ampacity, overhead_or_underground, conductor_type, conductor_size

### 29. Replace Meter Base
- Primary use: replace damaged, outdated, or undersized meter base
- Labor class: `remove_and_replace`
- Applicable parameters: meter_base_type, meter_base_amp_rating, meter_base_location, overhead_or_underground, utility_coordination_required

### 30. Install Exterior Disconnect
- Primary use: install service-entrance disconnecting means per NEC 230.85 (2020+) or as part of service upgrade / utility requirement — service-specific, not generic equipment disconnect
- Labor class: `new_install`
- Applicable parameters: service_ampacity, interior_or_exterior_disconnect, meter_base_location
- Notes: this is service/disconnecting-means specific; do not merge with `#88 Install Equipment Disconnect`

### 31. Service Mast / Weatherhead Repair
- Primary use: repair or replace damaged mast, weatherhead, or entrance fittings for overhead service
- Labor class: `repair_existing` or `remove_and_replace`
- Applicable parameters: service_ampacity, mast_required, overhead_or_underground

### 32. Full Residential Service Upgrade Package
- Primary use: complete residential service upgrade from meter to panel — tier: `package`
- Labor class: not applicable (package — labor derived from children)
- Applicable parameters: service_ampacity, overhead_or_underground, meter_base_type, utility_coordination_required
- Children: see Section 5.19

Shared family variants:
- overhead
- underground
- meter/main combo
- separate meter + disconnect

Shared family notes:
- utility-specific requirements should come from utility profiles, not hardcoded assembly logic

---

## 5.7 Grounding / Bonding / Surge

### 33. Grounding Electrode System Install / Upgrade
- Primary use: install a complete grounding electrode system (new construction) or upgrade/correct an existing one (remodel, service upgrade, code correction)
- Tier: `atomic`
- Labor class: `new_install` (new construction) or `repair_existing` (corrective upgrade)
- Key parameters: `electrode_type`, `conductor_size`, `routing_difficulty`, `service_configuration`, `install_context` (new_construction | correction | upgrade)
- Required variants:
  - new-construction install (rod-based, UFER, or combination)
  - corrective upgrade (adding electrodes, upsizing GEC, supplemental bonding)
- Notes: the `install_context` parameter distinguishes new-construction install from corrective work without requiring a separate assembly. Both contexts share the same electrode types, conductor sizing, and NEC anchors (250.50–250.68). Child usage within #32 Full Residential Service Upgrade Package is typically the corrective variant. Standalone new-construction use accompanies new panel/service work.

### 34. Add / Replace Ground Rod(s)
### 35. Grounding Electrode Conductor Upgrade
### 36. Bonding Correction
### 37. Whole-House Surge Protection

For this family:
- Typical labor class:
  - `repair_existing`
  - `new_install`
- Key parameters:
  - electrode_type
  - conductor_size
  - routing_difficulty
  - service_configuration
- Required variants:
  - rod-based correction
  - UFER available
  - water bond
  - gas/CSST bond

---

## 5.8 Detached Structures / Exterior Power

### 38. Detached Garage / Shop Subpanel Package
### 39. Detached Structure Exterior Receptacle
### 40. Exterior Dedicated Equipment Circuit
### 41. Shed / Outbuilding Power Package
### 42. Gate / Exterior Device Feed

For this family:
- Typical labor classes:
  - `new_install`
  - `extend_from_existing`
- Key parameters:
  - run_length
  - route_segments
  - overhead_or_underground
  - raceway_type
  - conduit_size
  - trench_required
  - subpanel_required
  - grounding_required
- Required variants:
  - detached garage
  - shed
  - pool equipment pad
  - well / pump / auxiliary structure
- Notes / limitations:
  - package assemblies in this family should expand into feeder, grounding, disconnect, receptacle, or equipment child assemblies rather than stay opaque

---

## 5.9 Appliance / Equipment Connections

### 43. Water Heater Circuit / Connection
### 44. Range Circuit / Connection
### 45. Dryer Circuit / Connection
### 46. Dishwasher / Disposal Circuit and Connection
### 47. Microwave / Hood Circuit
### 48. HVAC Condenser Circuit
### 49. Air Handler / Furnace Electrical Connection

For this family:
- Typical labor classes:
  - `new_install`
  - `remove_and_replace`
  - `extend_from_existing`
- Key parameters:
  - equipment_type
  - voltage
  - breaker_size
  - breaker_pole_config
  - disconnect_required
  - whip_length
  - run_length
  - raceway_type
  - conduit_size
  - location
- Required variants:
  - replacement connection only
  - circuit + connection
  - disconnect included
- Notes / limitations:
  - use this family for named dwelling equipment, not general workshop tools
  - `whip_length` is distinct from `run_length`; it represents only the final flexible or equipment whip segment, not the full route from panel/source
  - when disconnect scope needs to be priced and surfaced separately, use child assembly `#88 Install Equipment Disconnect`

---

## 5.10 Home Shop / Garage Equipment

### 50. Garage / Shop Equipment Circuit
### 51. Welder Receptacle / Circuit
### 52. Air Compressor Circuit / Disconnect
### 53. Stationary Tool Circuit
### 54. Single-Phase Motor Equipment Connection

For this family:
- Typical labor classes:
  - `new_install`
  - `extend_from_existing`
  - `remove_and_replace`
- Key parameters:
  - equipment_type
  - voltage
  - fla_or_nameplate
  - horsepower_or_kva
  - breaker_size
  - breaker_pole_config
  - receptacle_configuration
  - disconnect_required
  - hardwired_or_cord_connected
  - run_length
  - raceway_type
  - conduit_size
  - motor_controller_scope
  - location
- Required variants:
  - welder
  - air compressor
  - dust collector
  - stationary tool
  - hardwired motor equipment
- Notes / limitations:
  - this family exists because typical at-home shop work is common and should not be buried inside generic specialty circuits
  - motor-specific sizing/review may still require manual confirmation in early phases
  - use this family before `Specialty 240V Equipment Circuit` whenever the load is a garage/shop tool or motor-driven workshop load
  - when disconnect scope needs to be priced separately, use child assembly `#88 Install Equipment Disconnect`

---

## 5.11 Generator / Transfer / Backup Power

### 55. Portable Generator Inlet
### 56. Interlock Kit Install
### 57. Manual Transfer Switch Install
### 58. Standby Generator Electrical Package

For this family:
- Typical labor classes:
  - `new_install`
  - `remove_and_replace`
- Key parameters:
  - ampacity
  - inlet_rating
  - run_length
  - raceway_type
  - conduit_size
  - switch_type
  - whole_house_or_selected_loads
- Required variants:
  - portable generator
  - manual transfer
  - interlock
  - standby prep
- Notes / limitations:
  - full generator scope may include equipment not sold/provided by Red Cedar directly

---

## 5.12 EV / Specialty / Exterior Equipment

### 59. EV Charger Circuit
### 60. EV Charger Install with Customer-Supplied Equipment
### 61. Exterior Equipment Disconnect
### 62. Specialty 240V Equipment Circuit

For this family:
- Typical labor classes:
  - `new_install`
  - `extend_from_existing`
- Key parameters:
  - equipment_type
  - voltage
  - breaker_size
  - breaker_pole_config
  - run_length
  - raceway_type
  - conduit_size
  - customer_supplied_equipment
  - exterior_mounting_required
- Required variants:
  - EV charger circuit only
  - EV charger with customer-supplied equipment
  - exterior disconnect only
  - specialty 240V non-shop equipment
- Notes / limitations:
  - `Specialty 240V Equipment Circuit` is for uncommon non-shop loads that do not fit appliance or garage/shop families
  - EV installs often need panel capacity review, load calculation, and customer-equipment compatibility review outside the base assembly
  - use `#88 Install Equipment Disconnect` when the disconnect is a distinct scope item rather than an implicit part of the circuit assembly

---

## 5.13 Pool / Spa / Hot Tub

### 63. Hot Tub Disconnect / Feed
### 64. Pool Equipment Feed
### 65. Spa / Hot Tub Full Electrical Package

For this family:
- Typical labor classes:
  - `new_install`
  - `extend_from_existing`
- Key parameters:
  - equipment_rating
  - disconnect_required
  - run_length
  - raceway_type
  - conduit_size
  - trench_or_surface_route
  - bonding_scope
- Required variants:
  - above-ground
  - in-ground equipment only
  - hot tub/spa pad
- Notes / limitations:
  - these assemblies will depend heavily on NEC 680 review and should likely stay controlled until code layer is mature
  - use `#88 Install Equipment Disconnect` where disconnect scope should be visible separately from feed/bonding/package work

---

## 5.14 Remodel / Demo / Repair Support

These are support assemblies, not always customer-facing:

For this family:
- Typical labor classes:
  - `remove_only`
  - `repair_existing`
  - `extend_from_existing`
  - `make_safe`
- Attachment rules:
  - attach to parent atomic/package assemblies when uncertainty or scope complexity needs to be shown explicitly
  - prefer hidden/internal use first; surface customer-visible allowances only when estimator judgment requires transparency
  - support assemblies do not replace the parent assembly's primary labor class

### 66. Remove Existing Device / Fixture
- Primary use: remove and dispose of an existing device, fixture, or mounting hardware during remodel or replacement
- Labor class: `remove_only`
- Applicable parameters: device_or_fixture_type, disposal_scope

### 67. Remove Existing Circuit Segment
- Primary use: remove or abandon in place a section of existing wiring/conduit that is no longer needed
- Labor class: `remove_only`
- Applicable parameters: run_length, raceway_type, accessibility

### 68. Demo for Panel Replacement
- Primary use: demolition, cleanup, and site-prep labor specific to removing an old panel and preparing mounting for replacement
- Labor class: `remove_only`
- Applicable parameters: panel_location_type, asbestos_or_hazard_flag, cleanup_scope

### 69. Repair Existing Splice / Termination
- Primary use: fix a failed, corroded, or non-compliant splice or termination in place
- Labor class: `repair_existing`
- Applicable parameters: splice_type, access_difficulty, box_condition

### 70. Rework Existing Panel Conductors
- Primary use: support-level conductor re-routing, re-termination, or re-organization inside an existing panel during a larger panel/service scope — not a standalone customer-facing assembly
- Labor class: `repair_existing`
- Applicable parameters: branch_circuit_count, panel_make, panel_model
- Notes: use only as a support child within larger panel/service work; do not use alongside `#25` for the same panel

### 71. Access / Fish / Route Difficulty Add-On
- Primary use: additional labor allowance for difficult access, wire fishing through finished walls/ceilings, or unusual routing obstacles
- Labor class: `extend_from_existing`
- Applicable parameters: difficulty_tier, run_length, wall_type, attic_access, crawl_access

### 72. Permit Allowance
- Primary use: discrete permit cost allowance surfaced when estimator needs to show permit impact explicitly on an estimate option
- Labor class: not applicable (cost allowance)
- Applicable parameters: permit_scope, jurisdiction
- Notes: permit pricing is job/option scoped by default; only use as a support assembly when the estimator needs to surface a discrete permit allowance intentionally

### 73. Wall Repair / Patch Allowance
- Primary use: cost allowance for drywall patching, paint touch-up, or surface restoration after electrical work in finished walls/ceilings
- Labor class: not applicable (allowance — may be subcontracted)
- Applicable parameters: patch_count, surface_type, restoration_scope

### 74. Junction / Splice Box Add or Replace
- Primary use: install, replace, or add a junction or splice box where a new junction point is needed or an existing one must be corrected
- Labor class: `new_install` or `repair_existing`
- Applicable parameters: box_type, gang_count, box_usage, box_installation_type, box_environment, accessibility

These may appear as:
- hidden assembly support items
- explicit internal line items
- customer-visible allowances when uncertainty exists

---

## 5.15 New-Construction Point Assemblies and Room Packages

### Point Assemblies (atomic)

These are the leaf-node atoms that room packages decompose into. Each carries its own labor, materials, and box taxonomy. They can also be used standalone outside of a room package for ad-hoc point-count estimating.

**Dual-mode operation:** Point atoms (#90–#94) work in two contexts:
- **Standalone:** added directly to an estimate with their own `quantity` field (e.g., "6 receptacle points in the den").
- **As a child of a room package (#95–#99):** the point's per-instance count is driven by the parent package's quantity parameter (e.g., `receptacle_qty = 6` on the Bedroom package produces 6 instances of #90). The expansion engine reads the parent's `qty_parameter_ref` linkage — the point atom itself does not carry a quantity parameter for this purpose.

In both modes, the same `AssemblyTemplate` is used and the same components/labor expand identically. See ARCHITECT-BLUEPRINT-NEC-2017.md Section 10.2 "Package Expansion Engine" for the full algorithm.

### 90. New-Construction Receptacle Point
- Primary use: one complete receptacle location — rough-in box/cable + trim device/plate
- Tier: `atomic`
- Labor class: `new_install`
- Labor phases: rough 0.18 hr + trim 0.12 hr = 0.30 hr total per point
- Applicable parameters: `box_type` (new-work default), `gang_count`, `device_grade` (standard / spec / commercial), `device_type` (duplex / GFCI / WR-GFCI / USB combo), `mounting_height`, `box_environment`
- Notes: GFCI or WR variants are selected via `device_type` parameter — this changes the material and applicable NEC anchor, not the labor

### 91. New-Construction Switch Point
- Primary use: one complete switch location — rough-in box/cable + trim switch/plate
- Tier: `atomic`
- Labor class: `new_install`
- Labor phases: rough 0.15 hr + trim 0.10 hr = 0.25 hr total per point
- Applicable parameters: `box_type` (new-work default), `gang_count`, `switch_type` (single-pole / 3-way / 4-way / dimmer), `device_grade`, `mounting_height`

### 92. New-Construction Ceiling Light Point
- Primary use: one complete ceiling light location — rough-in box/cable + trim fixture
- Tier: `atomic`
- Labor class: `new_install`
- Labor phases: rough 0.20 hr + trim 0.15 hr = 0.35 hr total per point
- Applicable parameters: `box_type` (new-work / fan-rated), `fixture_type` (flush mount / recessed wafer / recessed can / pendant / fan-rated), `mounting_height`, `ceiling_type`
- Notes: if `fixture_type` = fan-rated, box must be fan-rated per 314.27(C)

### 93. New-Construction Rough-In Only Point
- Primary use: rough-in only — for phase-split contracts where rough and trim are bid separately
- Tier: `atomic`
- Labor class: `new_install`
- Applicable parameters: `point_type` (receptacle / switch / ceiling light), `box_type`, `gang_count`
- Labor: receptacle 0.18 hr, switch 0.15 hr, ceiling light 0.20 hr (driven by `point_type`)

### 94. New-Construction Trim-Out Only Point
- Primary use: trim phase only — device/fixture install + terminations on previously roughed box
- Tier: `atomic`
- Labor class: `new_install`
- Applicable parameters: `point_type` (receptacle / switch / ceiling light), `device_grade`, `device_type` or `switch_type` or `fixture_type`
- Labor: receptacle 0.12 hr, switch 0.10 hr, ceiling light 0.15 hr (driven by `point_type`)

### Branch Circuit Cable for Room Packages

Branch circuit cable is not a separate assembly. It is captured as an adjustable parameter on each room package:

- `branch_circuit_cable_length`: total feet of NM cable for all circuits serving this room
- Default values are seeded per room type (see packages below) and adjustable by the estimator
- Cable labor uses the NECA per-100-ft rate for the applicable wire gauge (typically 14/2 or 12/2)
- Cable material quantity drives the BOM directly from this parameter

---

### Room Packages (package)

Each room package is added **once per room** by the estimator. Child quantities are adjustable — the package seeds NEC-driven defaults, and the estimator overrides based on room size, design, and customer scope.

> **Expansion engine reference:** Room packages are processed by the Package Expansion Engine algorithm defined in ARCHITECT-BLUEPRINT-NEC-2017.md Section 10.2. The engine reads each child's `qty_parameter_ref`, resolves the corresponding parameter value from the parent package, clamps to `[min_quantity, max_quantity]`, and expands child components accordingly. The `branch_circuit_cable_length` parameter cascades from the parent package into child cable material calculations.

Design rules:
1. Every room package is tier: `package`, labor_class: `null` (labor derived from children)
2. Child quantities are **parameters with NEC-driven defaults and estimator-adjustable values**
3. The package expands into its child atoms at the quantities entered — the internal BOM and labor roll up from children
4. `branch_circuit_cable_length` is a package-level parameter (total feet for all circuits serving this room)
5. The estimator can add or remove optional children per room (e.g., add exhaust fan, add ceiling fan, remove recessed lights)
6. Multiple instances of the same room package (e.g., 3 bedrooms) are added as 3 separate package instances, each with their own quantities — this enables per-room customization

### 95. Bedroom Room Package
- Primary use: complete electrical scope for one bedroom — new construction or addition
- Tier: `package`
- Labor class: null (package — labor derived from children)
- NEC anchors: 210.52(A) (receptacle spacing), 210.70(A) (lighting outlet), 210.12 (AFCI)
- Package-level parameters:

| Parameter | Type | Unit | Default | min_value | max_value | child_qty_param | Notes |
|-----------|------|------|---------|-----------|-----------|-----------------|-------|
| `room_label` | text | — | — | — | — | false | Free text (e.g., "Master Bedroom") |
| `receptacle_qty` | integer | each | 4 | 2 | 12 | true | NEC 210.52(A) minimum spacing drives default |
| `switch_qty` | integer | each | 1 | 1 | 4 | true | May need 3-way for 2-entry rooms |
| `light_qty` | integer | each | 1 | 1 | 3 | true | NEC 210.70(A)(1) requires ≥1 switched lighting outlet |
| `smoke_co_qty` | integer | each | 1 | 1 | 2 | true | NEC/IRC requires detector in each bedroom |
| `closet_light_qty` | integer | each | 0 | 0 | 2 | true | Add for walk-in closets |
| `ceiling_fan_qty` | integer | each | 0 | 0 | 1 | true | Add if customer wants ceiling fan prep |
| `branch_circuit_cable_length` | number | feet | 75 | 30 | 200 | false | Total NM cable for all circuits serving this room |

- Children:

| Child | Cat # | configurable_qty | default_quantity | min_quantity | max_quantity | qty_parameter_ref | Notes |
|-------|-------|------------------|------------------|--------------|--------------|-------------------|-------|
| Receptacle point | #90 | true | 4 | 2 | 12 | `receptacle_qty` | NEC 210.52(A) minimum spacing drives default |
| Switch point | #91 | true | 1 | 1 | 4 | `switch_qty` | typically 1 single-pole; may need 3-way for 2-entry rooms |
| Ceiling light point | #92 | true | 1 | 1 | 3 | `light_qty` | NEC 210.70(A)(1) requires at least 1 switched lighting outlet |
| Smoke/CO detector | #78 | true | 1 | 1 | 2 | `smoke_co_qty` | NEC/IRC requires detector in each bedroom |
| Closet light point (optional) | #92 | true | 0 | 0 | 2 | `closet_light_qty` | add for walk-in closets |
| Ceiling fan rated box (optional) | #15 | true | 0 | 0 | 1 | `ceiling_fan_qty` | add if customer wants ceiling fan prep |

### 96. Bathroom Room Package
- Primary use: complete electrical scope for one bathroom — new construction or addition
- Tier: `package`
- Labor class: null (package — labor derived from children)
- NEC anchors: 210.11(C)(3) (dedicated 20A bathroom branch circuit), 210.8(A)(1) (GFCI), 210.70(A)(1) (lighting), 406.12 (tamper-resistant)
- Package-level parameters:

| Parameter | Type | Unit | Default | min_value | max_value | child_qty_param | Notes |
|-----------|------|------|---------|-----------|-----------|-----------------|-------|
| `room_label` | text | — | — | — | — | false | Free text (e.g., "Master Bath", "Hall Bath") |
| `bathroom_type` | enum | — | full | — | — | false | full / half / powder — affects child defaults |
| `gfci_receptacle_qty` | integer | each | 1 | 1 | 3 | true | GFCI required per 210.8(A)(1) |
| `switch_qty` | integer | each | 2 | 1 | 4 | true | Typically light + fan/vent; adjust for layout |
| `light_qty` | integer | each | 1 | 1 | 3 | true | NEC 210.70 requires switched lighting |
| `exhaust_fan_qty` | integer | each | 1 | 0 | 1 | true | Code-required by IRC without operable window |
| `dedicated_20a_circuit_qty` | integer | each | 1 | 1 | 2 | true | Per 210.11(C)(3); may share between adjacent baths |
| `branch_circuit_cable_length` | number | feet | 50 | 20 | 150 | false | Total NM cable for all circuits serving this room |

- Children:

| Child | Cat # | configurable_qty | default_quantity | min_quantity | max_quantity | qty_parameter_ref | Notes |
|-------|-------|------------------|------------------|--------------|--------------|-------------------|-------|
| GFCI receptacle point | #90 (device_type=GFCI) | true | 1 | 1 | 3 | `gfci_receptacle_qty` | GFCI required per 210.8(A)(1) |
| Switch point | #91 | true | 2 | 1 | 4 | `switch_qty` | typically light + fan/vent; adjust for layout |
| Ceiling light point | #92 | true | 1 | 1 | 3 | `light_qty` | NEC 210.70 requires switched lighting |
| Exhaust fan | #80 | true | 1 | 0 | 1 | `exhaust_fan_qty` | code-required by IRC for bathrooms without operable window |
| Dedicated 20A circuit | #17 | true | 1 | 1 | 2 | `dedicated_20a_circuit_qty` | per 210.11(C)(3); may be shared between adjacent bathrooms |

### 97. Kitchen Room Package
- Primary use: complete electrical scope for one kitchen — new construction or major remodel
- Tier: `package`
- Labor class: null (package — labor derived from children)
- NEC anchors: 210.11(C)(1) (≥2 small-appliance circuits), 210.52(B)/(C) (countertop spacing), 210.8(A)(6) (GFCI), 210.12 (AFCI), 210.70 (lighting)
- Package-level parameters:

| Parameter | Type | Unit | Default | min_value | max_value | child_qty_param | Notes |
|-----------|------|------|---------|-----------|-----------|-----------------|-------|
| `room_label` | text | — | — | — | — | false | Free text |
| `small_appliance_circuit_count` | integer | each | 2 | 2 | 4 | true | NEC 210.11(C)(1) minimum 2; practical max 4 |
| `countertop_gfci_qty` | integer | each | 4 | 2 | 8 | true | 210.52(C) spacing drives minimum; adjust for island/peninsula |
| `switch_qty` | integer | each | 2 | 1 | 6 | true | Overhead + under-cabinet; adjust for layout |
| `light_qty` | integer | each | 2 | 1 | 6 | true | Overhead + under-cabinet or recessed |
| `recessed_light_qty` | integer | each | 0 | 0 | 12 | true | Optional — add per design |
| `dishwasher_disposal_qty` | integer | each | 1 | 0 | 1 | true | Common paired appliance scope |
| `microwave_hood_qty` | integer | each | 1 | 0 | 1 | true | If microwave is hardwired or on dedicated circuit |
| `range_circuit_qty` | integer | each | 0 | 0 | 1 | true | Add if electric range; not included by default (may be gas) |
| `branch_circuit_cable_length` | number | feet | 150 | 50 | 300 | false | Kitchens have longer runs due to multiple circuits |

- Children:

| Child | Cat # | configurable_qty | default_quantity | min_quantity | max_quantity | qty_parameter_ref | Notes |
|-------|-------|------------------|------------------|--------------|--------------|-------------------|-------|
| Small-appliance circuit (20A) | #17 | true | 2 | 2 | 4 | `small_appliance_circuit_count` | 210.11(C)(1) / 210.52(B) — minimum 2 required |
| Countertop GFCI receptacle point | #90 (device_type=GFCI) | true | 4 | 2 | 8 | `countertop_gfci_qty` | 210.52(C) spacing drives minimum; adjust for island/peninsula |
| Switch point | #91 | true | 2 | 1 | 6 | `switch_qty` | typical: overhead + under-cabinet; adjust for layout |
| Ceiling light point | #92 | true | 2 | 1 | 6 | `light_qty` | overhead + under-cabinet or recessed; adjust for design |
| Recessed light | #14 | true | 0 | 0 | 12 | `recessed_light_qty` | optional — add per design |
| Dishwasher / disposal circuit | #46 | true | 1 | 0 | 1 | `dishwasher_disposal_qty` | common paired appliance scope |
| Microwave / hood circuit | #47 | true | 1 | 0 | 1 | `microwave_hood_qty` | if microwave is hardwired or on dedicated circuit |
| Range circuit | #44 | true | 0 | 0 | 1 | `range_circuit_qty` | add if electric range; not included by default (may be gas) |

### 98. Laundry Room Package
- Primary use: complete electrical scope for one laundry area — new construction or relocation
- Tier: `package`
- Labor class: null (package — labor derived from children)
- NEC anchors: 210.11(C)(2) (dedicated 20A laundry circuit), 210.52(F) (laundry receptacle), 210.12 (AFCI — TN optional for laundry)
- Package-level parameters:

| Parameter | Type | Unit | Default | min_value | max_value | child_qty_param | Notes |
|-----------|------|------|---------|-----------|-----------|-----------------|-------|
| `room_label` | text | — | — | — | — | false | Free text |
| `laundry_circuit_qty` | integer | each | 1 | 1 | 2 | true | 210.11(C)(2) dedicated circuit required |
| `receptacle_qty` | integer | each | 2 | 1 | 4 | true | Washer receptacle required per 210.52(F) |
| `switch_qty` | integer | each | 1 | 1 | 2 | true | For overhead light |
| `light_qty` | integer | each | 1 | 1 | 2 | true | |
| `dryer_circuit_qty` | integer | each | 1 | 0 | 1 | true | Set to 0 if gas dryer |
| `water_heater_circuit_qty` | integer | each | 0 | 0 | 1 | true | Add if electric water heater in laundry area |
| `branch_circuit_cable_length` | number | feet | 60 | 20 | 150 | false | Total NM cable for all circuits serving this room |

- Children:

| Child | Cat # | configurable_qty | default_quantity | min_quantity | max_quantity | qty_parameter_ref | Notes |
|-------|-------|------------------|------------------|--------------|--------------|-------------------|-------|
| Laundry circuit (20A) | #17 | true | 1 | 1 | 2 | `laundry_circuit_qty` | 210.11(C)(2) dedicated circuit required |
| Receptacle point | #90 | true | 2 | 1 | 4 | `receptacle_qty` | washer receptacle required per 210.52(F); extra per layout |
| Switch point | #91 | true | 1 | 1 | 2 | `switch_qty` | for overhead light |
| Ceiling light point | #92 | true | 1 | 1 | 2 | `light_qty` | |
| Dryer circuit | #45 | true | 1 | 0 | 1 | `dryer_circuit_qty` | set to 0 if gas dryer |
| Water heater circuit (optional) | #43 | true | 0 | 0 | 1 | `water_heater_circuit_qty` | add if electric water heater in laundry area |

### 99. Garage Room Package
- Primary use: complete electrical scope for one attached garage — new construction
- Tier: `package`
- Labor class: null (package — labor derived from children)
- NEC anchors: 210.52(G) (garage receptacle), 210.8(A)(2) (GFCI), 210.70(A)(2)(a) (lighting)
- Package-level parameters:

| Parameter | Type | Unit | Default | min_value | max_value | child_qty_param | Notes |
|-----------|------|------|---------|-----------|-----------|-----------------|-------|
| `room_label` | text | — | — | — | — | false | Free text (e.g., "2-Car Garage") |
| `garage_size` | enum | — | 2-car | — | — | false | 1-car / 2-car / 3-car / shop — affects defaults |
| `gfci_receptacle_qty` | integer | each | 2 | 1 | 6 | true | 210.52(G) requires ≥1; GFCI per 210.8(A)(2) |
| `switch_qty` | integer | each | 1 | 1 | 3 | true | For overhead lights |
| `light_qty` | integer | each | 2 | 1 | 6 | true | 210.70(A)(2)(a) requires lighting; adjust for size |
| `exterior_receptacle_qty` | integer | each | 0 | 0 | 2 | true | Front-of-garage exterior receptacle |
| `garage_door_opener_qty` | integer | each | 1 | 0 | 2 | true | Typical dedicated circuit for opener |
| `shop_equipment_circuit_qty` | integer | each | 0 | 0 | 4 | true | Add per customer scope |
| `branch_circuit_cable_length` | number | feet | 80 | 30 | 250 | false | Total NM cable; adjust for garage size and panel distance |

- Children:

| Child | Cat # | configurable_qty | default_quantity | min_quantity | max_quantity | qty_parameter_ref | Notes |
|-------|-------|------------------|------------------|--------------|--------------|-------------------|-------|
| GFCI receptacle point | #90 (device_type=GFCI) | true | 2 | 1 | 6 | `gfci_receptacle_qty` | 210.52(G) requires at least 1; GFCI per 210.8(A)(2) |
| Switch point | #91 | true | 1 | 1 | 3 | `switch_qty` | for overhead lights |
| Ceiling light point | #92 | true | 2 | 1 | 6 | `light_qty` | 210.70(A)(2)(a) requires lighting; adjust for size |
| Exterior receptacle (optional) | #39 | true | 0 | 0 | 2 | `exterior_receptacle_qty` | if front-of-garage exterior receptacle desired |
| Garage door opener circuit (optional) | #17 | true | 1 | 0 | 2 | `garage_door_opener_qty` | typical dedicated circuit for opener |
| Shop equipment circuit (optional) | #50 | true | 0 | 0 | 4 | `shop_equipment_circuit_qty` | add per customer scope |

### Usage notes for all room packages:

1. **Per-room add**: the estimator adds one instance of the room package per physical room. Three bedrooms = 3 instances of #95, each independently adjustable.
2. **Quantity adjustment**: after adding the package, the estimator reviews the default child quantities and adjusts up or down based on room size, architectural plans, and customer scope. Defaults are NEC-driven minimums or common residential practice.
3. **Cable length adjustment**: `branch_circuit_cable_length` is adjusted based on the room's distance from the panel and the number of circuits. This drives cable material cost and per-foot labor.
4. **Optional children**: children with default qty = 0 appear as available add-ons. The estimator enables them and sets quantity as needed.
5. **Smoke/CO coverage**: bedroom packages include #78 by default. Other room packages do not — whole-house smoke/CO coverage should be handled via #79 Smoke/CO Detector Package at the job level, or individual #77/#78 assemblies added where needed.
6. **Existing packages still apply**: #79 (Smoke/CO Package) and #32 (Full Residential Service Upgrade Package) remain independent job-level packages; they are not room packages and do not need the per-room model.
7. **Choosing the right level — packages, point atoms, or individual assemblies**: Room packages (#95–#99) and point atoms (#90–#94) are convenience groupings, not the only path. The estimator picks whatever combination fits the job:
   - **Standard new-construction room** with a known layout → use the matching room package and adjust child quantities.
   - **Non-standard space** (basement finish, bonus room, sunroom, workshop) that has no dedicated package → combine point atoms and individual assemblies directly. There is no need for a purpose-built package for every room type.
   - **Remodel / repair** where only a few locations are affected → use individual atomic assemblies (#1–#89) directly; point atoms and room packages are not required.
   - **Mixing is normal**: an estimate can contain room packages for some rooms, point atoms for others, and individual assemblies for one-off scopes — all on the same job. The catalog is a toolkit; the estimator assembles the right pieces.

---

## 5.16 Box Taxonomy Requirements

Boxes cannot be treated as a generic hidden material.

The assembly system must distinguish:

- gang count
  - 1-gang
  - 2-gang
  - 3-gang
  - 4-gang
- function
  - device box
  - junction / splice-only box
  - fixture box
  - fan-rated box
  - weatherproof box
- installation type
  - new-work
  - old-work / cut-in
  - surface-mounted
  - masonry / concrete
- environment
  - interior dry
  - damp
  - wet

At minimum, assemblies that create or replace boxes should capture:
- `box_type`
- `gang_count`
- `box_usage`
- `box_installation_type`
- `box_environment`

This applies especially to:
- receptacles
- switches
- lighting
- junction/splice work
- exterior device work
- fan support work

---

## 5.17 Route / Raceway Modeling Requirements

Route and raceway cannot be handled only by broad labor modifiers.

At minimum, any assembly that originates at a panel, feeder, disconnect, generator inlet, EV charger, detached structure, or equipment connection should be able to capture:

- `run_length`
- `route_segments`
  - panel to accessible space
  - accessible space to device/equipment
  - exposed / surface section
  - underground section
- `raceway_type`
  - NM / UF
  - EMT
  - PVC
  - LFNC / LFMC / FMC
  - service cable / SER / SEU where applicable
- `conduit_size`
- `conductor_count`
- `current_carrying_conductors`
- `termination_count`
- `bend_count`
- `pull_point_count`
- `pull_difficulty`
- `voltage_drop_review_required`

Rules:

1. Use `run_length` as the standard distance field across the catalog.
2. Treat `distance`, `cable_run_length`, and `feeder_length` as deprecated aliases to be normalized into `run_length`.
3. Material quantities should scale from route/raceway parameters, not only from fixed length buckets.
4. Labor should be able to scale by both length and route difficulty.
5. Voltage-drop review should be surfaced as an advisory when run length and load make it relevant.

---

## 5.18 Resolution-Pass Additions

These assemblies were added during the resolution pass because they are common residential work and materially affect quoting accuracy.

### 75. Install Ceiling Fan
- Assigned family: Lighting / Switching / Life Safety Controls
- Tier: `atomic`
- Primary use: install or replace a ceiling fan as a complete scope item
- Labor class: `remove_and_replace` or `new_install`
- Key parameters:
  - customer_supplied_equipment
  - support_box_scope
  - mounting_height
  - downrod_length
  - control_type
- Required variants:
  - existing fan-rated box
  - includes #15 support upgrade
  - standard ceiling
  - vaulted ceiling

### 76. Upgrade Receptacle to GFCI
- Assigned family: Receptacles / Devices
- Tier: `atomic`
- Primary use: convert an existing standard receptacle location to GFCI protection at the device
- Labor class: `remove_and_replace`
- Key parameters:
  - line_load_configuration
  - indoor_outdoor
  - label_required
  - box_condition
- Required variants:
  - bathroom
  - kitchen
  - garage
  - exterior

### 77. Replace Existing Smoke/CO Detector
- Assigned family: Lighting / Switching / Life Safety Controls
- Tier: `atomic`
- Primary use: replace an existing smoke alarm, CO alarm, or combo device
- Labor class: `remove_and_replace`
- Key parameters:
  - device_type
  - hardwired_or_battery
  - interconnect_type
  - ceiling_height
- Required variants:
  - smoke only
  - CO only
  - combo smoke/CO
  - hardwired interconnected

### 78. Add New Hardwired Smoke/CO Detector
- Assigned family: Lighting / Switching / Life Safety Controls
- Tier: `atomic`
- Primary use: add one new hardwired smoke/CO device and interconnect as required
- Labor class: `new_install` or `extend_from_existing`
- Key parameters:
  - device_type
  - run_length
  - interconnect_method
  - attic_access
  - circuit_source
- Required variants:
  - single added device
  - add-on to existing interconnect
  - combo smoke/CO

### 79. Smoke/CO Detector Package
- Assigned family: Lighting / Switching / Life Safety Controls
- Tier: `package`
- Primary use: deliver code-compliant smoke/CO detector coverage for remodel, addition, or new-construction proposal options
- Labor class: not applicable (package — labor derived from children)
- Key parameters:
  - floor_count
  - bedroom_count
  - existing_system_type
  - code_basis_pack
- Required variants:
  - remodel/addition coverage update
  - new-construction package
  - replace all existing devices

### 80. Bathroom Exhaust Fan Install / Replace
- Assigned family: Lighting / Switching / Life Safety Controls
- Tier: `atomic`
- Primary use: install or replace a bath exhaust fan or fan/light combo
- Labor class: `remove_and_replace` or `new_install`
- Key parameters:
  - customer_supplied_equipment
  - ducting_scope
  - switch_control_scope
  - attic_access
  - run_length
- Required variants:
  - replace existing fan
  - new fan on existing circuit
  - fan/light combo

### 81. Load Calculation / Panel Schedule Review
- Assigned family: Diagnostic / Service Call
- Tier: `support`
- Primary use: billable technical review for service capacity, feeder sizing, EV, generator, or panel-change proposals
- Labor class: `test_verify`
- Key parameters:
  - calc_scope
  - service_ampacity
  - major_load_count
  - panel_schedule_required
- Required variants:
  - dwelling load calc only
  - panel schedule review only
  - combined review

### 82. Utility Coordination / Disconnect-Reconnect
- Assigned family: Service Entrance / Meter / Disconnect
- Tier: `support`
- Primary use: utility/admin labor for disconnect scheduling, meter pull coordination, release/reconnect communication, and service cutover logistics
- Labor class: `test_verify`
- Key parameters:
  - utility_name
  - coordination_scope
  - site_visit_required
  - emergency_or_scheduled
- Required variants:
  - scheduled disconnect/reconnect
  - emergency coordination
  - meter pull / reset coordination

### 83. Trenching / Underground Route
- Assigned family: Detached Structures / Exterior Power
- Tier: `support`
- Primary use: labor and allowance for trenching or underground routing that should not stay implicit inside circuit assemblies
- Labor class: `new_install`
- Key parameters:
  - trench_length
  - surface_type
  - depth_class
  - boring_required
  - restoration_scope
- Required variants:
  - open trench
  - hand dig
  - directional bore / subcontract allowance

### 84. Doorbell / Chime Transformer Repair or Replace
- Assigned family: Lighting / Switching / Life Safety Controls
- Tier: `atomic`
- Primary use: repair or replace transformer, chime, or related low-voltage doorbell power components
- Labor class: `repair_existing` or `remove_and_replace`
- Key parameters:
  - transformer_location
  - device_scope
  - access_difficulty
- Required variants:
  - transformer only
  - chime only
  - transformer + chime

### 85. Dimmer / Smart Switch Install or Upgrade
- Assigned family: Lighting / Switching / Life Safety Controls
- Tier: `atomic`
- Primary use: upgrade an existing switch location to dimmer or smart-control functionality
- Labor class: `remove_and_replace`
- Key parameters:
  - device_type
  - neutral_present
  - load_type
  - three_way_present
  - customer_supplied_equipment
- Required variants:
  - standard dimmer
  - smart switch
  - smart dimmer

### 86. Timer / Occupancy Sensor Switch Install
- Assigned family: Lighting / Switching / Life Safety Controls
- Tier: `atomic`
- Primary use: replace or add device-level timed or sensor-based lighting/fan control
- Labor class: `remove_and_replace` or `extend_from_existing`
- Key parameters:
  - sensor_type
  - neutral_present
  - load_type
  - room_type
- Required variants:
  - timer
  - occupancy sensor
  - vacancy sensor

### 87. Electric Baseboard / Wall Heater Circuit / Connection
- Assigned family: Appliance / Equipment Connections
- Tier: `atomic`
- Primary use: install or replace a branch circuit and equipment connection for electric baseboard or wall heat
- Labor class: `new_install` or `remove_and_replace`
- Key parameters:
  - heater_type
  - voltage
  - nameplate_kw
  - thermostat_scope
  - run_length
- Required variants:
  - baseboard heater
  - wall heater
  - built-in thermostat
  - line-voltage wall thermostat

### 88. Install Equipment Disconnect
- Assigned family: EV / Specialty / Exterior Equipment
- Tier: `atomic`
- Primary use: install a non-service equipment disconnect that can be reused across shop, HVAC, spa, and specialty equipment scopes
- Labor class: `new_install` or `remove_and_replace`
- Key parameters:
  - equipment_served
  - disconnect_rating
  - fused_or_nonfused
  - indoor_outdoor
  - run_length
  - raceway_type
- Required variants:
  - HVAC / outdoor equipment disconnect
  - spa disconnect
  - shop equipment disconnect
  - generator accessory disconnect
- Notes / limitations:
  - this does not replace `#30 Install Exterior Disconnect`, which remains service/disconnecting-means specific

### 89. Install New Subpanel
- Assigned family: Panels / Breakers / Distribution
- Tier: `atomic`
- Primary use: install a new subpanel where no panel currently exists
- Labor class: `new_install`
- Key parameters:
  - panel_amp_rating
  - panel_spaces_total
  - panel_location_type
  - run_length
  - grounding_isolation_scope
- Required variants:
  - interior same-building subpanel
  - exterior subpanel
  - detached-structure subpanel

---

## 5.19 Package Decomposition / Child Relationships

Package assemblies must expand into child assemblies rather than remain opaque.

> **Schema reference:** All child entries use the `AssemblyTemplate.children` schema defined in ARCHITECT-BLUEPRINT-NEC-2017.md Section 10.2. For non-room packages below, most children have `configurable_qty: false` and fixed quantity = 1 because these are scope-driven (include or exclude) rather than quantity-driven like room packages.

### #32 Full Residential Service Upgrade Package

| Child | Cat # | configurable_qty | default_quantity | min_quantity | max_quantity | qty_parameter_ref | Notes |
|-------|-------|------------------|------------------|--------------|--------------|-------------------|-------|
| Replace Main Panel | #27 | false | 1 | 1 | 1 | — | Required |
| Replace Service Entrance Cable | #28 | false | 1 | 1 | 1 | — | Required |
| Replace Meter Base | #29 | false | 1 | 1 | 1 | — | Required |
| Install Exterior Disconnect | #30 | false | 1 | 0 | 1 | — | Required when NEC 230.85 applies |
| Grounding Electrode System Install / Upgrade | #33 | false | 1 | 1 | 1 | — | Required |
| Grounding Electrode Conductor Upgrade | #35 | true | 0 | 0 | 1 | — | Optional — include when GEC needs upsizing |
| Bonding Correction | #36 | true | 0 | 0 | 1 | — | Optional — include when bonding deficiencies found |
| Whole-House Surge Protection | #37 | true | 0 | 0 | 1 | — | Optional — add when customer requests |
| Load Calculation / Panel Schedule Review | #81 | false | 1 | 1 | 1 | — | Required |
| Utility Coordination / Disconnect-Reconnect | #82 | false | 1 | 1 | 1 | — | Required |
| Permit Allowance | #72 | true | 1 | 0 | 1 | — | Include when permit surfaced in estimate |
### #38 Detached Garage / Shop Subpanel Package

| Child | Cat # | configurable_qty | default_quantity | min_quantity | max_quantity | qty_parameter_ref | Notes |
|-------|-------|------------------|------------------|--------------|--------------|-------------------|-------|
| Detached Structure Feeder | #21 | false | 1 | 1 | 1 | — | Required |
| Install New Subpanel | #89 | false | 1 | 1 | 1 | — | Required |
| Detached Structure Exterior Receptacle | #39 | true | 1 | 0 | 2 | — | Optional — add per scope |
| Exterior Dedicated Equipment Circuit | #40 | true | 0 | 0 | 2 | — | Optional — add as needed |
| Grounding Electrode System Install / Upgrade | #33 | true | 1 | 0 | 1 | — | Required where separate grounding needed |
| Trenching / Underground Route | #83 | true | 1 | 0 | 1 | — | Include when underground route required |

### #65 Spa / Hot Tub Full Electrical Package
| Child | Cat # | configurable_qty | default_quantity | min_quantity | max_quantity | qty_parameter_ref | Notes |
|-------|-------|------------------|------------------|--------------|--------------|-------------------|-------|
| Hot Tub Disconnect / Feed | #63 | false | 1 | 1 | 1 | — | Required |
| Install Equipment Disconnect | #88 | false | 1 | 1 | 1 | — | Required |
| Bonding Correction | #36 | true | 1 | 0 | 1 | — | Include for bonding review / equipotential bonding |
| Trenching / Underground Route | #83 | true | 0 | 0 | 1 | — | Include when applicable |
| Permit Allowance | #72 | true | 1 | 0 | 1 | — | Include when permit surfaced in estimate |
| Load Calculation / Panel Schedule Review | #81 | true | 1 | 0 | 1 | — | Include if service capacity uncertain |

### #79 Smoke/CO Detector Package
| Child | Cat # | configurable_qty | default_quantity | min_quantity | max_quantity | qty_parameter_ref | Notes |
|-------|-------|------------------|------------------|--------------|--------------|-------------------|-------|
| Replace Existing Smoke/CO Detector | #77 | true | 0 | 0 | 20 | `replace_detector_qty` | Quantity = number of existing detectors to replace |
| Add New Hardwired Smoke/CO Detector | #78 | true | 0 | 0 | 10 | `new_detector_qty` | Quantity = number of new locations to add |
| Access / Fish / Route Difficulty Add-On | #71 | true | 0 | 0 | 10 | — | Add when routing is difficult (finished walls, etc.) |

### #41 Shed / Outbuilding Power Package

**Single-circuit shed variant:**

| Child | Cat # | configurable_qty | default_quantity | min_quantity | max_quantity | qty_parameter_ref | Notes |
|-------|-------|------------------|------------------|--------------|--------------|-------------------|-------|
| Add Dedicated 120V Circuit | #17 | true | 1 | 0 | 1 | — | Use for 120V shed; mutually exclusive with #18 |
| Add Dedicated 240V Circuit | #18 | true | 0 | 0 | 1 | — | Use for 240V outbuilding; mutually exclusive with #17 |
| Trenching / Underground Route | #83 | true | 1 | 0 | 1 | — | Include when underground route required |

**Multi-circuit outbuilding variant:**

| Child | Cat # | configurable_qty | default_quantity | min_quantity | max_quantity | qty_parameter_ref | Notes |
|-------|-------|------------------|------------------|--------------|--------------|-------------------|-------|
| Detached Structure Feeder | #21 | false | 1 | 1 | 1 | — | Required for multi-circuit |
| Install New Subpanel | #89 | false | 1 | 1 | 1 | — | Required for multi-circuit |
| Add Dedicated 120V Circuit | #17 | true | 1 | 0 | 6 | — | Branch circuits on load side |
| Add Dedicated 240V Circuit | #18 | true | 0 | 0 | 3 | — | Branch circuits on load side |
| Receptacle point | #90 | true | 2 | 0 | 8 | — | As needed per layout |
| Ceiling light point | #92 | true | 1 | 0 | 4 | — | As needed per layout |
| Trenching / Underground Route | #83 | true | 1 | 0 | 1 | — | Include when underground route required |

### #46 Dishwasher / Disposal Circuit and Connection
- note: re-tiered from `package` to `atomic` — this assembly covers paired dishwasher and disposal connections as a single estimating scope item; child decomposition is handled at the component level within the template, not as separate child assemblies

### Room Package Child Patterns

Room package child patterns use the full structured schema with `qty_parameter_ref` linkage. See Section 5.15 for complete definitions:

- `#95 Bedroom Room Package` → `#90` receptacle points, `#91` switch points, `#92` ceiling light points, `#78` smoke/CO detector, optional `#15` fan-rated box — all quantities adjustable per room via `qty_parameter_ref`
- `#96 Bathroom Room Package` → `#90` GFCI receptacle points, `#91` switch points, `#92` ceiling light points, `#80` exhaust fan, `#17` dedicated 20A circuit — all quantities adjustable per room via `qty_parameter_ref`
- `#97 Kitchen Room Package` → `#17` small-appliance circuits (min 2 per 210.52(B)), `#90` GFCI countertop points, `#91` switch points, `#92` ceiling light points, `#14` recessed lights, `#46` dishwasher/disposal, `#47` microwave/hood, optional `#44` range circuit — all quantities adjustable via `qty_parameter_ref`
- `#98 Laundry Room Package` → `#17` laundry circuit, `#90` receptacle points, `#91` switch point, `#92` ceiling light point, `#45` dryer circuit, optional `#43` water heater circuit — all quantities adjustable via `qty_parameter_ref`
- `#99 Garage Room Package` → `#90` GFCI receptacle points, `#91` switch points, `#92` ceiling light points, `#17` garage door opener circuit, optional `#39` exterior receptacle, optional `#50` shop equipment circuit — all quantities adjustable via `qty_parameter_ref`
- `#79 Smoke/CO Detector Package` → job-level package (not a room package)
- `#32 Full Residential Service Upgrade Package` + optional `#37` → job-level package (not a room package)

---

## 5.20 Assembly Dependency Rules

Assemblies should trigger companion reviews or child suggestions where applicable.

- `#17 Add Dedicated 120V Circuit`, `#18 Add Dedicated 240V Circuit`, `#59 EV Charger Circuit`, `#60 EV Charger Install with Customer-Supplied Equipment`, `#87 Electric Baseboard / Wall Heater Circuit / Connection`, and `#89 Install New Subpanel`
  - trigger review: panel space / capacity review
  - suggest children/support: `#23 Add Breaker to Existing Panel`, `#81 Load Calculation / Panel Schedule Review`
- `#27 Replace Main Panel` and `#32 Full Residential Service Upgrade Package`
  - trigger review: grounding and bonding correction
  - suggest children/support: `#33`, `#36`, `#82`
- `#75 Install Ceiling Fan`
  - trigger review: support box suitability
  - suggest children/support: `#15 Add Ceiling Fan Rated Box`
- `#38 Detached Garage / Shop Subpanel Package`, `#41 Shed / Outbuilding Power Package`, `#63 Hot Tub Disconnect / Feed`, `#64 Pool Equipment Feed`, `#65 Spa / Hot Tub Full Electrical Package`
  - trigger review: underground/surface route and trenching
  - suggest children/support: `#83`
- `#63`, `#64`, and `#65`
  - trigger review: bonding / GFCI / disconnect requirements
  - suggest children/support: `#36`, `#88`
- `#46 Dishwasher / Disposal Circuit and Connection`, `#48 HVAC Condenser Circuit`, `#49 Air Handler / Furnace Electrical Connection`, `#50` through `#54`, and `#62 Specialty 240V Equipment Circuit`
  - trigger review: whether disconnect scope should be separate and visible
  - suggest children/support: `#88`
- `#59 EV Charger Circuit` and `#60 EV Charger Install with Customer-Supplied Equipment`
  - trigger review: load calculation and panel capacity (EV chargers are high-draw loads that frequently require service evaluation)
  - suggest children/support: `#81 Load Calculation / Panel Schedule Review`, `#23 Add Breaker to Existing Panel`
- remodel or addition work that changes room count or adds bedrooms
  - trigger review: smoke/CO detector coverage for code compliance
  - suggest children/support: `#79 Smoke/CO Detector Package` or individual `#77`/`#78` assemblies
- any accepted estimate where hidden conditions are found
  - route through: change order flow in the master blueprint
  - common added children/support: `#66`, `#70`, `#72`, `#73`, `#83`

Mutual exclusion rules:

- `#25 Panel Circuit Rework / Cleanup` and `#70 Rework Existing Panel Conductors` must not appear on the same estimate for the same panel. Use `#25` when panel rework is the customer-facing corrective scope; use `#70` only as a support child within a larger panel/service package.

---

## 5.21 Estimate Workflow Rules at the Assembly Level

The assembly model should support real service/remodel workflow:

1. Diagnostic work can remain hourly, be converted to a not-to-exceed allowance, or be converted into fixed-scope repair assemblies after diagnosis.
2. Multiple `EstimateOption`s can price the same problem area with different assembly combinations, such as repair vs replace or good/better/best.
3. Hidden-condition discoveries during approved work should become `ChangeOrder`s that add, remove, or modify assemblies rather than ad hoc note changes.
4. Support assemblies are the preferred way to model uncertainty, access difficulty, trenching, permit allowance, and admin labor without corrupting the base atomic assembly.

---

## 5.22 Extended Catalog Assemblies (Wave 1 Additions)

These assemblies were added during Wave 1 implementation. Assembly numbers 100–105 use values above the original 1–99 range to preserve the 90–99 range for new-construction room packages (#95–#99).

### 100. Service Entrance Upgrade
- Assigned family: Service Entrance / Meter / Disconnect
- Tier: `atomic`
- Primary use: replace or upgrade service entrance conductors and service head — the weatherhead-to-meter section of a service upgrade; use alongside `#27 Replace Main Panel` and `#28 Replace Service Entrance Cable` when the service head is a distinct billable scope item
- Labor class: `new_install`
- Key parameters:
  - current_service_size
  - new_service_size
  - service_height
- Required variants:
  - remodel (existing structure)
  - new construction

### 101. Outlet Circuit Extension
- Assigned family: Branch Circuits / Feeders
- Tier: `atomic`
- Primary use: add a new general branch circuit terminating at a receptacle outlet — covers conduit, wire, box and device for a complete circuit; outlet environment (interior, exterior, damp) controls device type and conduit requirements
- Labor class: `new_install`
- Key parameters:
  - circuit_length
  - amp_rating
  - location_type
- Required variants:
  - interior
  - exterior

### 102. Lighting Circuit Extension
- Assigned family: Lighting / Switching / Life Safety Controls
- Tier: `atomic`
- Primary use: add a new general lighting branch circuit with one or more fixture locations — fixture_count scales material and trim-out labor; light_type differentiates standard vs recessed vs specialty
- Labor class: `new_install`
- Key parameters:
  - circuit_length
  - fixture_count
  - light_type
- Required variants:
  - standard
  - recessed

### 103. Load Calculation Assessment
- Assigned family: Diagnostic / Service Call
- Tier: `atomic`
- Primary use: customer-facing standalone load calculation and panel capacity review — distinct from `#81 Load Calculation / Panel Schedule Review` which is a `support` tier internal step used inside service upgrade packages; `#103` is the billable customer-facing assessment version when load review is itself the service scope
- Labor class: `test_verify`
- Key parameters:
  - existing_panel_amps
  - load_type
- Required variants:
  - residential
  - mixed_use
- Notes: use `#103` for customer-facing load assessment; use `#81` when the load calculation is a hidden support child inside a service upgrade or EV package

### 104. Install Dimmers in New Multi-Gang Cut-In Box
- Assigned family: Lighting / Switching
- Tier: `atomic`
- Labor class: `new_install`
- Primary use: install 1–4 Decora dimmers in a new old-work cut-in box; covers box, devices, plate, cable, and wire nuts in a single compound assembly — use instead of stacking multiple standalone dimmer assemblies when all devices share one new box
- Key parameters:
  - `gang_count` (integer 1–4): scales dimmer quantity, wire-nut sets
  - `cable_length` (lf): scales 12/2 NM-B material and routing labor
- Labor model: 1.5 hr fixed setup (cut-in, route, open panel) + 0.5 hr per gang (terminate and test); batch overhead is absorbed into the fixed setup rather than repeated per device
- Required variants:
  - remodel (cut-in to finished surface)
  - service_call

### 105. Splice-Through at Device Box
- Assigned family: Lighting / Switching
- Tier: `atomic`
- Labor class: `repair_existing`
- Primary use: remove an existing switch from a circuit and splice through at the box; used when a switching point is being relocated or eliminated
- Key parameters:
  - `end_state` enum:
    - `blank_plate`: switch removed, wiring spliced through, blank cover installed
    - `constant_power_outlet`: switch leg rewired always-on; use when switch leg redirects to new overhead fixture and the box is repurposed as a standard outlet
- Required variants:
  - blank_plate
  - constant_power_outlet

---

## 6. Required Parameters Across the Catalog

These parameter families should be reused wherever possible:

- `quantity`
- `run_length`
- `route_segments`
- `wall_type`
- `ceiling_type`
- `finish_type`
- `attic_access`
- `crawl_access`
- `mounting_height`
- `device_grade`
- `box_type`
- `gang_count`
- `box_usage`
- `box_installation_type`
- `box_environment`
- `indoor_outdoor`
- `garage_kitchen_bath_laundry_context`
- `breaker_size`
- `breaker_pole_config`
- `breaker_family`
- `tandem_allowed`
- `conductor_count`
- `current_carrying_conductors`
- `neutral_required`
- `equipment_ground_required`
- `raceway_type`
- `conduit_size`
- `termination_count`
- `bend_count`
- `pull_point_count`
- `pull_difficulty`
- `voltage_drop_review_required`
- `service_ampacity`
- `panel_make`
- `panel_model`
- `panel_amp_rating`
- `panel_spaces_total`
- `panel_circuits_max`
- `panel_role`
- `panel_bus_type`
- `panel_location_type`
- `meter_base_amp_rating`
- `meter_base_location`
- `interior_or_exterior_disconnect`
- `trench_required`
- `overhead_or_underground`
- `permit_scope`
- `difficulty_tier`
- `customer_supplied_equipment`

These should be standardized early to avoid template sprawl.

Canonical naming rules:

- use `run_length` instead of `distance`, `cable_run_length`, or `feeder_length`
- use `breaker_pole_config` instead of `pole_count`
- use separate `panel_make` and `panel_model` instead of `panel_make_model`
- use `permit_scope` or permit allowance logic instead of hard-coded `permit_required` pricing on the assembly itself
- keep `whip_length` as a distinct final-segment parameter for appliance/equipment connections; it is not an alias of `run_length`

Category mapping rule:

- the master `AssemblyTemplate.category` field should use a controlled vocabulary broad enough to cover all assembly families
- recommended categories: `diagnostic`, `devices`, `lighting_controls`, `circuits`, `panels`, `service`, `grounding`, `exterior_power`, `equipment`, `garage_shop`, `generator_backup`, `specialty`, `support`, `package`

---

## 7. Required Variant Types

The first variant system should support at least:

- new construction open wall
- remodel finished wall
- attic accessible
- crawl accessible
- easy access
- difficult access
- indoor
- outdoor
- replacement only
- extend from existing
- customer-supplied equipment
- 1-pole breaker
- 2-pole breaker
- tandem breaker
- main breaker panel
- main lug panel
- interior panel
- exterior panel
- overhead service
- underground service
- detached structure
- NM / cable method
- conduit / raceway method
- easy pull
- difficult pull
- surface-mounted / masonry

If a variant becomes too complex, split it into two assemblies.

---

## 8. What Should Stay Manual Early

These should not be over-automated too early:

- unusual troubleshooting
- hidden-condition pricing beyond simple allowances
- complex service upgrades with utility-specific exceptions
- rare specialty equipment
- large custom homes with heavy design variation
- pool/spa edge cases
- mixed-scope remodels involving many unknowns

The assembly system should support manual overrides without breaking the model.

---

## 9. Known Limitations To Evaluate Before Build

1. Some assemblies are actually bundles of multiple dependent assemblies.
   Example: panel replacement may require grounding, bonding, utility coordination, permits, and surge decisions.

2. Some assemblies may be better modeled as:
   - a package assembly
   - plus child assemblies
   rather than one giant template.

3. Blueprint mode can encourage overuse of macro assemblies.
   That may speed estimating but reduce accuracy unless every macro remains decomposable and reviewable.

4. Service work often starts with a diagnostic assembly and ends in a repair assembly.
   The transition from diagnosis to approved repair must be smooth.

5. NEC references should not be authored per assembly by hand at scale.
   The final system should use assembly hints + property context + scope search to suggest references during final review.

6. Material ordering will be only as good as atomic decomposition.
   If assemblies are too vague internally, supply-house lists will be weak.

7. Breaker and panel compatibility can become a major source of estimating error.
   Breaker family, pole configuration, tandem eligibility, panel spaces, and panel circuit limits must be modeled explicitly.

8. Box selection can silently affect both labor and material.
   Gang count, junction-only vs device use, and new-work vs old-work distinctions cannot stay implicit.

9. Raceway-based work is still a major risk area until conductor-count, conduit-size, bend-count, and voltage-drop logic are fully authored in the formulas.

10. Local price accuracy will remain provisional until a supplier-backed material catalog and company pricing policy are loaded.

---

## 10. Audit Findings Incorporated

This revision resolves or clarifies these issues:

- filled the numbering gap by adding `Relocate Existing Receptacle`
- preserved the earlier merge so `Add Receptacle` remains the single net-new receptacle assembly
- clarified that permits are estimate/job level by default, not hidden assembly base-price content
- normalized route/distance naming toward `run_length`
- reduced overlap between dwelling equipment, garage/shop equipment, and specialty 240V categories
- expanded raceway/conduit requirements from a general modifier concept into explicit catalog inputs

Open items still requiring architect review:

- exact conduit-size / conductor-fill / derating formula strategy
- how much motor-controller / overload detail belongs in early home-shop assemblies
- where package assemblies should stop and child assemblies should begin
- which assemblies should carry voltage-drop advisories automatically

---

## 11. Immediate Architect Questions

The architect should review this catalog planning and answer:

1. Are these assembly families correct for Red Cedar's target work?
2. Which of these should truly be Phase 1?
3. Which assemblies should be packages vs atomic assemblies?
4. Which parameters should be standardized globally now?
5. Which variants are essential vs over-engineered?
6. Which assemblies should be customer-facing vs internal support only?
7. Where are the biggest risks of estimate inaccuracy or scope creep?
8. What is missing from this assembly list?

---

## 12. Recommendation

Do not start application implementation beyond the core architecture until the architect has:

- reviewed this catalog
- grouped assemblies into atomic / package / support tiers
- identified phase-1 assemblies
- defined standard parameters
- defined required variants
- identified assemblies that must remain manual or semi-manual initially

This document should become the assembly-planning companion to the main architect blueprint.
