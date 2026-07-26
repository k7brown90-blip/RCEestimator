# Red Cedar Electric — Electrical Health Record
## Technician Inspection Checklist & PWA Blueprint (v2 — comprehensive)

**What changed from v1:** v1 was a 14-item highlight reel. A real electrician would
see the gaps immediately — grounding and bonding alone is 8+ distinct checks, not one
line. This version walks the code the way a house is actually built and inspected:
**service → grounding & bonding → panel/overcurrent → branch circuits → devices →
life safety**. Every item is anchored to a 2017 NEC article verified in the code book.

**Purpose:** single source of truth so every trained technician performs the identical
inspection and every report reads with identical reasoning. Also the training
curriculum. Hand to Claude Code to build the offline-first field PWA.

---

## Core principles (unchanged, apply to every item)

1. **Four reasoning points, always:** *What we check · Why code cares · What we found ·
   Why it matters.* Fixed text except the measured "found" value and the merged result.
2. **Measure, don't guess.** Every numeric item needs a real instrument reading.
3. **Jurisdiction set once per job** — loads correct edition & citations (table below).
4. **Result states:** `PASS` (green) · `MONITOR` (amber) · `ACTION` (red);
   `OPTIONAL` sub-label where an item is genuinely not required in that jurisdiction.
5. **Customer decides.** State finding + code position + consequence; never "you must
   buy." The number always travels with a plain consequence and a required/not-required
   statement — that pairing is the anti-upsell mechanism.
6. **Every citation must be verifiable in the code book.**

## Jurisdiction profiles (verified from each adopting authority)

| Jurisdiction | Edition | Government source | Inspections |
|---|---|---|---|
| Murfreesboro | 2017 | City Ord. 18-O-71 | City (exempt) |
| Brentwood | 2017 (state base) | Defers to TN SFMO | State inspector |
| Rutherford Co. (unincorp.) | 2017 (state base) | TN SFMO 0780-02 | State inspector |
| Franklin | 2023 | City Ord. 2025-33 (eff. 1/1/26) | City |
| Nashville / Davidson | 2023 + Metro amds | Metro Code Ch. 16.20 | Metro (exempt) |

**Edition-dependent requirements:** SPD (230.67) not-required under 2017 / required
under 2023 · GFCI & AFCI scope broader under 2023 · Nashville adds Metro amendments.
TN state amendment: AFCI optional in baths, laundry, garages, unfinished basements;
110.24 fault-current marking optional.

---

# SECTION A — SERVICE ENTRANCE & SUPPLY

### A1. Service drop / lateral clearances & condition
- **Code:** 230.24 (overhead clearances: 10 ft at entrance/over pedestrian, 12 ft over
  residential drive, 3 ft above roof), 230.26 (attach ≥10 ft), 230.28 (mast strength)
- **Input:** Measure/observe drop clearances; condition of mast, weatherhead, drip loop.
- **Logic:** PASS if clearances met & mast sound. ACTION if clearance violation or
  damaged/loose mast (storm-vulnerable — the weatherhead is a common ice-storm failure).
- **What we check:** The height and condition of the overhead service where it reaches
  the house — the mast, weatherhead, and clearances above the roof and yard.
- **Why code cares:** 230.24 sets minimum clearances (e.g. 10 ft at the entrance, 12 ft
  over a driveway, 3 ft above the roof) so conductors stay out of reach and survive weather.
- **What we found:** Roof clearance `{roof_clr}`, drive/yard clearance `{yard_clr}`, mast
  condition `{mast_cond}`.
- **Why it matters:** A low or damaged service is a shock and outage risk; a compromised
  mast can be torn off in a storm, and the utility won't restore power until a licensed
  contractor rebuilds it. `{plain_result}`.

### A2. Service rating vs. calculated load
- **Code:** 230.79(C) (one-family dwelling ≥100 A, 3-wire), 230.42 (conductor ampacity),
  Article 220 (load calculation)
- **Input:** Service size (A); Article 220 calculated load for the dwelling.
- **Logic:** PASS if service ≥ calculated load and ≥100 A. MONITOR if near capacity.
  ACTION if undersized for load.
- **What we check:** Whether the service size is adequate for the home's calculated
  load and meets the minimum for a house.
- **Why code cares:** 230.79(C) sets a 100-amp minimum for a one-family dwelling, and
  Article 220 defines how the load is calculated. An undersized service overheats and
  nuisance-trips.
- **What we found:** Service rated `{service_amps}` A; Article 220 calculated load
  `{calc_load}` A.
- **Why it matters:** `{plain_result}` — headroom matters if you add EV charging, HVAC,
  or an addition later.

### A3. Meter base (external condition) & main disconnect
- **Code:** 230.66 (service equipment listed/labeled), 312 (enclosure integrity); scope note
  below
- **SCOPE LIMIT — do not open the meter socket.** A licensed electrician's scope begins past
  the weatherhead. The meter socket **cannot be opened** to inspect its internal terminations
  without the utility present and confirming de-energization. Those terminations are **not
  inspected and not scored** — record as "refer to utility," photograph the exterior. Inspect
  only: the **external condition** of the meter base and the **main disconnect after the
  meter**.
- **Input:** Meter base *external* condition (corrosion, heat marks, secure mounting, weather
  sealing); main disconnect condition. `{meter_ext_cond}`, `{main_disc_cond}`. Meter-socket
  internals → `{utility_referral}` (photo, unscored).
- **Logic:** PASS if external condition sound. ACTION if external corrosion/heat/damage or
  insecure mounting. Meter-socket internals never drive PASS/ACTION.
- **What we check:** The outside condition of the meter enclosure and the main disconnect
  after it — corrosion, heat marks, secure mounting, weather sealing. We do **not** open the
  meter socket; that's the utility's equipment.
- **Why code cares:** 230.66/312 require listed, intact service equipment. External corrosion
  or heat marks are visible warning signs even without opening anything.
- **What we found:** Meter base exterior `{meter_ext_cond}`; main disconnect
  `{main_disc_cond}`; meter-socket internals `{utility_referral}`.
- **Why it matters:** We flag what we can see and refer anything behind the utility's seal to
  them — so you get an honest read without anyone touching equipment they're not permitted to
  open. `{plain_result}`.

---

# SECTION B — SERVICE DISCONNECT & WORKING SPACE

### B1. Service disconnect — location, marking, rating
- **Code:** 230.70(A) (readily accessible, outside or nearest point of entry; **not in a
  bathroom**), 230.70(B) (marked as service disconnect), 230.71 (≤6 disconnects),
  230.77 (indicates on/off)
- **Input:** Disconnect location, count, marking, indicating type.
- **Logic:** PASS if accessible, marked, ≤6 motions to kill power. ACTION if in a
  prohibited location, unmarked, or >6 disconnects.
- **What we check:** Where the main service disconnect is, that it's clearly marked, and
  that the whole house can be shut off in no more than six switch throws.
- **Why code cares:** 230.70(A) requires it readily accessible and never in a bathroom;
  230.71 caps it at six disconnects so power can be killed fast in an emergency.
- **What we found:** Location `{disc_loc}`; `{disc_count}` disconnect(s); marking
  `{disc_mark}`.
- **Why it matters:** In a fire or shock emergency, first responders must find and kill
  power fast. `{plain_result}`.

### B2. Panel working space & dedicated space
- **Code:** 110.26(A) (≥36 in. deep, ≥30 in. wide, ≥6.5 ft high clear in front),
  110.26(E) (dedicated space above; no piping/ducts foreign to electrical)
- **Input:** Measure clear depth/width/height in front; check for foreign piping/ducts
  in dedicated space above.
- **Logic:** PASS if all clearances met. ACTION if space obstructed or foreign systems
  in dedicated zone.
- **What we check:** The clear working space in front of the panel (36 in. deep, 30 in.
  wide, 6.5 ft high) and that nothing foreign (plumbing, ducts) crowds the space above it.
- **Why code cares:** 110.26 requires this clearance so the panel can be safely worked on
  energized; 110.26(E) keeps water lines and ducts out of the dedicated zone.
- **What we found:** Clear depth `{depth}`, width `{width}`, height `{height}`; dedicated
  space `{dedicated_state}`.
- **Why it matters:** A panel boxed in by shelving, furnace, or plumbing is a safety
  violation and a real hazard for anyone servicing it — extremely common in finished
  basements and remodels. `{plain_result}`.

---

# SECTION C — GROUNDING & BONDING (Article 250 — the system, not one line)

### C1. Grounding electrode(s) present & type
- **Code:** 250.50 (all present electrodes bonded into system), 250.52 (permitted
  electrode types: rod, Ufer/concrete-encased, water pipe, ground ring)
- **Input:** Identify all electrodes present (ground rod(s), rebar/Ufer, water pipe).
- **Logic:** PASS if a compliant electrode system exists. ACTION if none / improper.
- **What we check:** What grounding electrodes the home actually has — driven rod(s), a
  concrete-encased (Ufer) electrode, or a metal water-pipe electrode.
- **Why code cares:** 250.50 requires all present electrodes to be bonded together into
  one grounding electrode system — it's the foundation the whole safety system stands on.
- **What we found:** Electrodes present: `{electrode_types}`.
- **Why it matters:** The grounding system is what gives a fault a safe path to earth and
  stabilizes your voltage. `{plain_result}`.

### C2. Ground-rod resistance (measured)
- **Code:** 250.53(A)(2) Exception (single rod ≤25 Ω, else supplemental electrode
  required), 250.53(G) (≥8 ft rod in soil)
- **Input:** Measured resistance to earth (Ω); count of rods; spacing (≥6 ft if multiple).
- **Logic:** PASS if ≤25 Ω on single rod OR supplemental present. ACTION if >25 Ω with
  no supplemental.
- **What we check:** The actual resistance of the ground rod to earth — measured with an
  instrument, not assumed.
- **Why code cares:** 250.53(A)(2) allows a single rod only if it measures 25 ohms or
  less; above that, a second rod at least 6 ft away is required.
- **What we found:** `{ground_ohms}` Ω (limit 25 Ω), `{rod_count}` rod(s), supplemental
  `{supp_state}`.
- **Why it matters:** Almost nobody measures this — most installers drive one rod and
  assume. A high-resistance ground can't clear faults properly. Yours `{plain_result}`.

### C3. Grounding electrode conductor (GEC) — size & connection
- **Code:** 250.66 (GEC sizing per Table 250.66), 250.70 (listed connection, no solder),
  250.64 (routing/protection)
- **Input:** GEC size vs service size; connection method & condition at electrode.
- **Logic:** PASS if sized per 250.66 & properly connected. ACTION if undersized or
  connection loose/corroded/soldered.
- **What we check:** The conductor that ties the panel to the grounding electrodes — its
  size and the integrity of its clamp at the rod.
- **Why code cares:** 250.66 sizes the GEC to the service; 250.70 requires a listed
  connection (solder is prohibited) so it stays intact under fault current.
- **What we found:** GEC `{gec_size}` (service `{service_amps}` A); connection
  `{gec_conn}`.
- **Why it matters:** A loose or undersized grounding conductor silently defeats the
  whole grounding system — it looks fine until a fault it can't handle. `{plain_result}`.

### C4. Main bonding jumper & EGC-bar bonding at the service
- **Code:** 250.24(B) (MBJ connects the EGCs *and* the enclosure to the grounded conductor),
  250.28 (MBJ material — *"wire, bus, screw, or similar"* — size per Table 250.102(C)(1)),
  250.24(A)(4) (a wire/busbar from the neutral bar to the EGC bar is an explicitly recognized
  MBJ form), 408.3(C) (service panelboard MBJ bonds neutral to frame), 250.118 (enclosure is
  *not* a listed EGC type)
- **FIRST determine the bus configuration — it changes everything:**
  - **Shared bus** (grounds and neutrals land together on the bonded bus): permitted at the
    service. The green screw/strap bonds that single bus to the can and *is* the complete MBJ.
    No bar-to-bar conductor applies (there's only one bar).
  - **Separated buses** (grounds on their own bar, neutrals on theirs): the green screw bonds
    the neutral bus to the can, but then **the only path between the EGC bar and the neutral is
    the can itself** — and the can may be *part of the grounding system* but is **not an EGC**
    (250.118). Bolting a ground bar to the can is electrically the same as machine-screwing a
    lug to the can: it leaves the enclosure acting as the EGC, which the code does not allow.
    A **conductor from the EGC bar to the neutral bar is REQUIRED** to complete the grounding
    system in copper; the green screw stays (it keeps the can bonded for contact safety).
- **Input:** Bus configuration `{bus_config}` (shared / separated); MBJ present & form
  `{mbj_state}`; **EGC-bar-to-neutral conductor** `{egc_to_neutral}` (size `{egc_bond_size}`,
  per Table 250.102(C)(1) → ~#6–#4 Cu residential); can bonded `{can_bond}`.
- **Logic:**
  - **PASS** — shared bus with a proper MBJ; OR separated buses with a proper EGC-bar-to-neutral
    conductor **and** the can bonded.
  - **ACTION (immediate-fix / banner)** — no MBJ; OR **separated buses where the only EGC-to-
    neutral connection is the can** (green screw present but no bar-to-bar conductor — the
    grounding conductors are relying on the enclosure as an EGC); OR EGC bar mounted so it isn't
    actually bonded (insulating standoff, missing bonding screw/strap).
- **What we check:** First, whether grounds and neutrals share one bonded bus or sit on
  separate bars. If separate, whether a real conductor ties the EGC bar to the neutral bar —
  not the can standing in for it.
- **Why code cares:** 250.24(B) requires the EGCs *and* the enclosure bonded to the grounded
  conductor at the service. The enclosure isn't a listed EGC (250.118), so when the bars are
  separated the grounding conductors must reach the neutral through a conductor, not through the
  sheet-metal box. 250.24(A)(4) is the code-sanctioned way to do exactly that.
- **What we found:** Configuration `{bus_config}`; MBJ `{mbj_state}`; EGC-bar-to-neutral
  `{egc_to_neutral}`; can bond `{can_bond}`.
- **Why it matters:** If the bars are separated and only the can links them, every equipment
  ground in the house is trying to return fault current through a bolted sheet-metal path the
  code never qualified for the job — the breaker may not clear and metal can energize. The fix
  is a copper conductor bar-to-bar, with the can still bonded. `{plain_result}`.

### C5. Neutral-ground separation at subpanels
- **Code:** 250.24(A)(5) (no re-grounding of neutral on load side of service), 408.41
  (neutrals isolated in subpanels)
- **Input:** At each subpanel, confirm neutral bus isolated from ground bus (bonding
  screw removed / separate bars).
- **Logic:** PASS if separated at every subpanel. ACTION if neutral & ground bonded in a
  subpanel.
- **What we check:** That at every subpanel the neutral and ground are kept separate —
  the bonding screw removed, separate bars.
- **Why code cares:** 250.24(A)(5) prohibits re-bonding neutral to ground past the
  service. Bonding them at a subpanel puts normal current on the ground wires and metal.
- **What we found:** Subpanels checked `{subpanel_count}`; neutral/ground separation
  `{ng_sep_state}`.
- **Why it matters:** A subpanel with neutral and ground bonded energizes ground wires
  and metal enclosures with normal current — a shock hazard hidden in plain sight, and one
  of the most common mistakes we find. `{plain_result}`.

### C6. Metal water pipe & gas pipe bonding
- **Code:** 250.104(A) (metal water piping bonded, sized per 250.102), 250.104(B) (other
  metal piping incl. gas likely to be energized bonded)
- **Input:** Confirm water pipe bonded within 5 ft of entry; CSST/gas bonded per listing.
- **Logic:** PASS if bonded & sized. ACTION if unbonded metal water/gas piping.
- **What we check:** That the metal water piping (and gas piping where required) is bonded
  back to the electrical system.
- **Why code cares:** 250.104 requires metal piping that could become energized to be
  bonded, so a fault can't make your pipes live. CSST gas line bonding is a documented
  fire-safety issue.
- **What we found:** Water pipe bond `{water_bond}`; gas/CSST bond `{gas_bond}`.
- **Why it matters:** Unbonded metal plumbing can become energized during a fault —
  you'd get shocked touching a faucet. Unbonded CSST gas line is a lightning fire risk.
  `{plain_result}`.

### C7. Intersystem bonding termination (ISBT)
- **Code:** 250.94 (accessible IBT with ≥3 terminals for cable/phone/satellite bonding)
- **Input:** Confirm an accessible intersystem bonding terminal at the service.
- **Logic:** PASS if present & accessible. MONITOR if absent (common on older homes).
- **What we check:** Whether there's an accessible bonding point for the cable, phone, and
  satellite services to tie into the grounding system.
- **Why code cares:** 250.94 requires an intersystem bonding termination so low-voltage
  services share the same ground — preventing voltage differences that damage equipment.
- **What we found:** Intersystem bonding termination `{isbt_state}`.
- **Why it matters:** Without a common bonding point, a surge or fault can create damaging
  voltage differences between your power and your cable/internet. `{plain_result}`.

---

# SECTION D — PANEL, OVERCURRENT & CONNECTIONS

### D1. Connection integrity (torque + thermal)
- **Code:** 110.14 (connections), 110.14(D) (torque to spec, calibrated tool, Annex I
  tables), 110.12(B) (no corroded/overheated parts)
- **Input:** Thermal scan + visual of all terminations; re-torque to spec.
- **Logic:** PASS if all tight, no heat/corrosion. ACTION if any overheated/loose/corroded.
- **What we check:** That every connection in the panel is tight to the manufacturer's
  torque spec and free of corrosion or heat damage.
- **Why code cares:** 110.14(D) requires terminations torqued to spec with a calibrated
  tool; 110.12(B) forbids parts deteriorated by corrosion or overheating.
- **What we found:** `{termination_result}` — `{detail}`.
- **Why it matters:** Research on glowing connections (NIST; IEEE Holm) shows a loose
  junction can exceed **1000 °C — hotter than copper melts** — while drawing normal
  current, so breakers never trip. A documented fire-ignition source a torque wrench and
  thermal scan catch early.

### D2. Breaker-to-conductor sizing
- **Code:** 240.4 (conductors protected at ampacity), 240.4(D) (15 A/14 AWG, 20 A/12 AWG,
  30 A/10 AWG small-conductor limits), 240.6 (standard ratings)
- **Input:** Each circuit's breaker rating vs conductor gauge.
- **Logic:** PASS if all matched. ACTION if any breaker oversized for its wire.
- **What we check:** That every breaker matches the wire it protects — a 15-amp wire never
  on a 20- or 30-amp breaker.
- **Why code cares:** 240.4 requires conductors protected at their ampacity. An oversized
  breaker lets the wire overheat without ever tripping.
- **What we found:** `{matched_count}` of `{total_count}` circuits matched;
  `{mismatch_detail}`.
- **Why it matters:** An oversized breaker is a classic hidden fire cause and a common DIY
  error. `{plain_result}`.

### D3. Breaker compatibility & panel condition
- **Code:** 110.3(B) (equipment used per listing), 408.54 (max devices), 110.12(B)
  (condition); hazard/delisted panels fail 110.3(B)/listing in practice
- **Input:** Panel make/model against the hazard-panel reference table below; breaker brand
  compatibility; double-taps; corrosion/heat marks; recall/hazard status.
- **Logic:** PASS if listed breakers, no double-taps, sound panel, not on hazard list.
  ACTION if mismatched/double-tapped breakers, damage, or a hazard/delisted panel.
- **What we check:** The panel make and model against the known hazard-panel list, that the
  breakers are the type listed for this panel, and that there are no double-taps or heat damage.
- **Why code cares:** 110.3(B) requires equipment installed per its listing; mixing breaker
  brands or double-tapping voids that. Several panel lines have documented failure-to-trip
  histories and are no longer UL-listed / no longer approved for sale.
- **What we found:** Panel `{make_model}`; hazard-list match `{hazard_match}`; breaker
  compatibility `{breaker_compat}`; double-taps `{double_tap}`; heat/corrosion `{panel_damage}`.
- **Why it matters:** A breaker that won't trip is worse than no breaker — the homeowner
  thinks they're protected. Some of these also exhibit a "false-off," where the handle reads
  OFF but the circuit stays live, a lethal shock trap for anyone who works on it. These panels
  are a documented insurance and fire issue and frequently trigger coverage denial or
  cancellation. `{plain_result}`.

> **Hazard / delisted panel reference table** (the app should flag any match and default the
> item to ACTION, with the specific failure mode shown to the customer). Failure modes differ,
> which matters for how it's explained:
>
> | Brand / line | Identify by | Documented failure mode | Class |
> |---|---|---|---|
> | **Federal Pacific (FPE) Stab-Lok** | "Federal Pacific," "FPE," "Stab-Lok" label | Breakers fail to trip 25–65%+ of the time (CPSC/Aronstein); bus-bar & breaker fires; UL listing compromised | Delisted-grade / replace |
> | **Zinsco / GTE-Sylvania / Kearney** | "Zinsco," "GTE-Sylvania"; colored breakers, horizontal layout; logo above breakers | Aluminum clip/bus overheats; breaker welds/fuses to bus → cannot trip; "false-off" live-when-off; ~25% trip failure in testing; no longer UL-approved for sale | Delisted-grade / replace |
> | **Challenger** | "Challenger" on handle/door; yellow "test" buttons | Breakers detach/arc; 1994 CA-series breaker recall; 2014 Eaton shock-hazard recall on certain models; often lacks AFCI/GFCI provisions | Recall history / evaluate–replace |
> | **Pushmatic / Bulldog (ITE)** | Push-button breakers (no toggle) | Push-button mechanism stiffens & fails to trip with age; no main in many; obsolete parts | Obsolete-hazard / replace |
> | **Wadsworth** | "Wadsworth" label; rectangular activation buttons | Not defective as-built, but company gone (1990); parts obsolete, no longer meets current standards | Obsolete / evaluate |
> | **Certain Siemens/Murray QP & QPF breakers** | Siemens or Murray panel; specific QP/QPF date-code breakers | Named recalls: may not trip on overload — verify model/date code against active recall notices | Model-specific recall / verify |
> | **Certain Eaton/Cutler-Hammer BR & CH breakers** | Cutler-Hammer/Eaton panel | Most are safe; specific BR/CH series recall actions exist — verify model/date code | Model-specific recall / verify |
>
> `[gov/std]` CPSC FPE investigation record. `[peer-reviewed/industry]` Aronstein FPE
> testing; inspectapedia Zinsco field-failure collection (shared with CPSC). `[industry]`
> Great American / insurer loss-control bulletins; manufacturer recall notices. Note: only
> some of these carry a formal CPSC *recall* (Challenger CA-series 1994, Eaton 2014, Siemens/
> Murray QP/QPF); FPE and Zinsco were never formally recalled but are delisted-grade hazards
> documented over decades. The app should show the customer *which* class applies rather than
> lumping all as "recalled."

### D4. Panel circuit directory (verified schedule)
- **Code:** 408.4(A) (every circuit legibly identified, clear/specific purpose; spares
  labeled; no transient-occupancy descriptions)
- **Input:** CircuitIQ trace; build & install verified schedule + QR.
- **Logic:** PASS once verified schedule installed. NOTE pre-existing label state.
- **What we check:** That every breaker is accurately labeled to its true circuit — traced,
  not copied from the old door.
- **Why code cares:** 408.4(A) requires each circuit legibly identified by clear, specific
  purpose with spares marked. Most panels don't meet this.
- **What we found:** Prior labeling `{prior_label_state}`; verified schedule of
  `{circuit_count}` circuits installed with QR.
- **Why it matters:** In an emergency, a correct directory is how anyone kills the right
  circuit fast — and it's exactly what 408.4 requires and almost no home has. `{plain_result}`.

### D5. Aluminum branch-circuit wiring
- **Code:** 110.14 (connections, dissimilar-metal listing), 110.3(B) (devices used per
  listing — CO/ALR-rated); CPSC hazard findings on pre-1972 solid aluminum branch wiring
- **Input:** Identify solid aluminum branch wiring (15/20 A circuits); check device
  compatibility (CO/ALR or approved AlumiConn/COPALUM repair); look for heat/oxidation at
  terminations.
- **Logic:** PASS if none present, or properly mitigated (CO/ALR devices or listed repair).
  ACTION if solid aluminum branch wiring on standard devices / signs of overheating.
  (N/A if all-copper.)
- **What we check:** Whether the home has old-style solid aluminum branch wiring (common
  ~1965–1973) and, if so, whether the connections have been properly mitigated.
- **Why code cares:** Solid aluminum branch wiring expands, oxidizes, and loosens at
  terminations more than copper; CPSC found homes with it far more likely to reach fire-hazard
  conditions at connections unless mitigated with listed devices or repairs.
- **What we found:** Aluminum branch wiring `{al_wiring_state}`; mitigation `{al_mitigation}`;
  termination condition `{al_term_cond}`.
- **Why it matters:** This is a leading cause of connection overheating and a frequent
  insurance flag — but it's fixable without a full rewire using listed connectors. Ignored, it
  quietly degrades at every outlet and switch. `{plain_result}`.

---

# SECTION E — BRANCH-CIRCUIT PROTECTION

### E1. GFCI protection (shock)
- **Code (2017):** 210.8(A) (bathrooms, garages, outdoors, crawl spaces, unfinished
  basements, kitchens, within 6 ft of sinks, laundry, dishwasher 210.8(D))
- **Code (2023):** expanded to nearly all 125–250 V receptacles in listed areas; 210.8(F)
  outdoor outlets
- **Input:** Test every required-location device for trip.
- **Logic:** PASS if all required GFCIs present & tripping. ACTION if any required location
  unprotected or non-tripping.
- **What we check:** That GFCI protection is present and actually trips in every wet or
  outdoor location the code lists.
- **Why code cares:** 210.8 requires GFCI protection to prevent electrocution where water
  and electricity meet. `{edition_note}`
- **What we found:** `{gfci_result}` — `{gfci_detail}`.
- **Why it matters:** A working GFCI is the difference between a nuisance trip and an
  electrocution. `{plain_result}`.

### E2. AFCI protection (arc-fault fire)
- **Code (2017):** 210.12(A) (kitchens, family/living/dining, bedrooms, hallways, laundry,
  closets, sunrooms…); 210.12(D) (add on modify/replace/extend). **TN amd:** optional in
  baths, laundry, garages, unfinished basements.
- **Code (2023):** broadened.
- **Input:** Identify circuits with/without AFCI.
- **Logic:** MONITOR if existing circuits lack AFCI (grandfathered per 210.12(D)). ACTION
  only if new/modified work lacks required AFCI.
- **What we check:** Whether living-space circuits have arc-fault protection that trips on
  the arcing that starts fires behind walls.
- **Why code cares:** 210.12 requires AFCI in living areas; 210.12(D) triggers it on
  existing homes only when a circuit is modified, replaced, or extended. `{tn_amendment_note}`
- **What we found:** `{afci_result}` — `{afci_detail}`.
- **Why it matters:** No violation on untouched wiring, but AFCI meaningfully lowers hidden-
  arc fire risk. Adding it is `{required_or_optional}` here — your call.

### E3. Surge protection (SPD)
- **Code (2017):** not required. **Code (2023):** 230.67 REQUIRED on dwelling services
  (min 10 kA) and on service/panel replacement.
- **Input:** SPD present? (Y/N)
- **Logic:** MONITOR/OPTIONAL if absent under 2017; ACTION if absent under 2023.
- **What we check:** Whether a surge-protective device is installed at the service to
  absorb voltage spikes before they reach your circuits.
- **Why code cares:** `{spd_code_stance}` It protects everything downstream — appliances
  and the safety devices themselves (AFCI, GFCI, smoke alarms).
- **What we found:** SPD `{spd_state}`.
- **Why it matters:** A single lightning or grid surge can destroy electronics and degrade
  safety devices. `{spd_requirement_line}`

---

# SECTION F — DEVICES, RECEPTACLES & LIGHTING

### F1. Receptacle placement & condition
- **Code:** 210.52(A) (spacing: no point along wall >6 ft from a receptacle; walls ≥2 ft),
  210.52(B) (kitchen small-appliance), 210.52(C) (countertop), 406.4(D) (replacement
  rules), 406.12 (tamper-resistant)
- **Input:** Spot-check spacing, tamper-resistant where required, condition (scorching,
  loose, reversed polarity, open ground).
- **Logic:** PASS if compliant & sound. ACTION if scorched/reverse-polarity/open-ground;
  MONITOR spacing gaps in existing work.
- **What we check:** Receptacle spacing, condition, correct wiring (polarity, ground), and
  tamper-resistant type where required.
- **Why code cares:** 210.52 sets spacing so people don't rely on extension cords; 406.4(D)
  governs safe replacement; scorched or mis-wired receptacles are shock/fire hazards.
- **What we found:** Spacing `{recep_spacing}`; condition `{recep_cond}`; wiring
  `{recep_wiring}`.
- **Why it matters:** A scorched or reverse-wired outlet is an active hazard; sparse
  spacing drives unsafe extension-cord use. `{plain_result}`.

### F2. Egress / Security lighting
- **Code:** 210.70(A) (lighting outlet in every habitable room, hall, stair, and at the
  exterior of outdoor entrances; switch-controlled), 404 (switch use)
- **Input:** Confirm required switched lighting present & functional at interior egress paths
  (rooms, halls, stairs) and at exterior entrances; note any exterior entry with no lighting.
- **Logic:** PASS if required egress/entry lighting present & working. MONITOR/ACTION if
  missing required lighting control at a stair, egress path, or exterior entrance.
- **What we check:** Switched lighting along the paths people use to get out and at exterior
  entries — habitable rooms, halls, stairways, and outdoor entrances alike.
- **Why code cares:** 210.70 requires switched lighting in these areas so no one navigates a
  dark stairway, egress path, or entry — a fall/egress-safety provision that doubles as
  exterior security lighting.
- **What we found:** Interior egress lighting `{egress_lighting_state}`; exterior entrance
  lighting `{exterior_lighting_state}`.
- **Why it matters:** Missing lighting on a stair or egress path is a genuine fall hazard, and
  a dark exterior entry is both a safety and a security gap — not just an inconvenience.
  `{plain_result}`.

### F3. Box fill, cable support & protection
- **Code:** 314.16 (box fill limits), 314.17 (cable clamping), 300.4 (protection from
  physical damage / nail plates), 334.30 (NM cable support)
- **Input:** Spot-check accessible boxes for overfill, unsupported/unclamped cable,
  unprotected NM through framing, missing box covers (314.25).
- **Logic:** PASS if compliant. ACTION if overfilled boxes, unprotected cable, or open
  splices/missing covers.
- **What we check:** In accessible areas (attic, basement, unfinished spaces): box fill,
  cable support, protection where cable passes through framing, and that boxes are covered.
- **Why code cares:** 314.16 limits box fill to prevent overheating/damaged insulation;
  300.4 requires protection so nails/screws don't pierce cable; 314.25 requires covers on
  every box.
- **What we found:** Box fill `{box_fill}`; cable support `{cable_support}`; physical
  protection `{cable_protect}`; open boxes `{open_box}`.
- **Why it matters:** Overstuffed boxes cook conductor insulation; unprotected cable
  through a stud is one drywall screw away from a fault; open splices are shock and fire
  risks. `{plain_result}`.

---

# SECTION G — EQUIPMENT DISCONNECTS & LOAD BALANCE

### G1. Water heater disconnect
- **Code:** 422.31(B) (permanently-connected appliance >300 VA: switch/breaker within
  sight or lockable per 110.25); Article 100 ("within sight" = visible, ≤50 ft)
- **Logic:** PASS if within sight or lockable. ACTION if neither.
- **What we check:** A way to shut power to the water heater within sight of it, or a
  lockable breaker.
- **Why code cares:** 422.31(B) requires a disconnect within sight or lockable so anyone
  servicing it can kill power and see it stays off.
- **What we found:** Disconnect `{wh_disc_state}` (`{wh_distance}`).
- **Why it matters:** `{plain_result}`.

### G2. HVAC / heating disconnect
- **Code:** 440.14 (A/C disconnect within sight of equipment), 424.19 (fixed electric heat)
- **Logic:** PASS if within sight. ACTION if missing/out of sight.
- **What we check:** That HVAC equipment has a disconnect within sight of the unit.
- **Why code cares:** 440.14 / 424.19 require a disconnect within sight so a service tech
  can safely de-energize before working.
- **What we found:** HVAC disconnect `{hvac_disc_state}`.
- **Why it matters:** `{plain_result}`.

### G3. Load balance (measured, fixed/dedicated circuits)
- **Code:** Article 220 (load calculation methodology)
- **Input:** Measured amp draw per fixed/dedicated circuit; compute A/B leg totals.
- **Logic:** PASS if leg imbalance <20% on measured fixed loads. MONITOR if skewed.
- **What we check:** How evenly the two legs of the panel carry the fixed loads — dryer,
  range, HVAC, water heater, disposal.
- **Why code cares:** Article 220 governs load distribution. Balanced legs keep the shared
  neutral quiet and voltage steady.
- **What we found:** Leg A `{leg_a}` A, Leg B `{leg_b}` A (`{imbalance_pct}`% imbalance).
- **Why it matters:** A skewed panel pushes extra current onto the neutral and sags voltage
  under load. We balance to real measured usage. `{plain_result}`.

---

# SECTION H — LIFE SAFETY & PANEL LIFE

### H1. Smoke & CO alarms
- **Code:** NFPA 72 (10-yr replacement life), IRC R314/R315 (placement: each bedroom,
  outside each sleeping area, each level; CO outside sleeping areas; interconnection)
- **Input:** Count, date-stamp/age, type (smoke/CO/combo), placement, interconnection.
- **Logic:** PASS if all ≤10 yrs & correctly placed. ACTION if any expired/missing/mis-placed.
- **What we check:** Age, type, placement, and interconnection of every smoke and CO alarm.
- **Why code cares:** NFPA 72 sets a hard 10-year life because the sensor degrades; IRC
  R314/R315 fix placement so nowhere is unprotected.
- **What we found:** `{in_life_count}` of `{total_alarms}` within life; placement
  `{placement_result}`; oldest `{oldest_year}`; CO `{co_state}`.
- **Why it matters:** Expired sensors respond slower to real smoke or CO. The most literal
  life-safety item in the home, and the fix is cheap. `{plain_result}`.

### H2. Panel condition & remaining life
- **Code:** manufacturer rated life (~30 yrs); 110.12(B) condition
- **Input:** Install year, make/model, corrosion/heat/recall status.
- **Logic:** MONITOR by age; ACTION if damaged/corroded/known-hazard.
- **What we check:** Panel age, corrosion, heat damage, hazard status vs ~30-yr rated life.
- **Why code cares:** 110.12(B) requires equipment free of corrosion/overheating;
  manufacturers rate panels for a finite life.
- **What we found:** Installed `{install_year}` (`{age}` yrs), `{make_model}`, condition
  `{condition}`.
- **Why it matters:** `{plain_result}` — budget replacement before end of life rather than
  waiting for a surprise failure.

---

# SECTION I — NASHVILLE / DAVIDSON METRO AMENDMENTS (conditional card)

### I1. Metro-specific amendments (Nashville only)
- **Code:** Metro Code Title 16, Ch. 16.20 amendments to 2023 NEC
- **Input:** main service disconnect ≤5 ft from where service conductors enter building;
  240 V water heater on multipole breaker (no single-pole tie handles); crawl-space light
  fixtures guarded.
- **Logic:** PASS if all met; ACTION per item if not. *(Hidden outside Nashville.)*
- **What we check:** The Metro-specific rules Nashville adds on top of the 2023 NEC.
- **Why code cares:** Metro Code Ch. 16.20 amends the base code — local requirements an
  out-of-town contractor or inspector routinely misses.
- **What we found:** Main disconnect `{disc_result}`; water-heater breaker
  `{wh_breaker_result}`; crawl-space light guards `{crawl_result}`.
- **Why it matters:** Meeting these Metro rules is what keeps the work compliant in Davidson
  County specifically. `{plain_result}`.

---

## Report assembly rules (for the PWA)

1. **Health score** — reproducible from identical inputs, no randomness. Weight ACTION
   heavier than MONITOR; PASS neutral. (Full rubric to be finalized separately, per section.)
2. **Five glance roll-ups:** *Service & Panel* (A,B,D2–D4,H2) · *Grounding & Bonding*
   (all of C — **immediate-fix section: any fault-path deficiency here forces the whole
   system red and the critical banner**) · *Branch Circuits* (D1,E) · *Devices & Wiring* (F)
   · *Life Safety* (G disconnects, H1, + Metro I). Worst child sets parent color.
3. **Layered output:** glance verdict → per-item cards (four fixed fields) → technical
   appendix (all measured values + citations + provenance-labeled source list).
4. **Provenance labels:** `[gov/std]` for adopting ordinance & NEC/NFPA text;
   `[peer-reviewed]` for NIST / IEEE Holm / NAFE. Never blend.
5. **Offline-first PWA:** enter values with no signal; generate locally; sync record + QR
   when back online.
6. **One record per property, versioned by date** — year-over-year trend; Red Cedar becomes
   the system of record.
7. **Sections can be marked N/A** (e.g. no subpanels → C5 N/A; no gas → C6 gas portion N/A),
   but N/A must be an explicit technician choice, logged, not a skip.

## Source register (verified against 2017 NEC this pass)

**Government-adopted / standards `[gov/std]`:**
230.24 / 230.70(A) / 230.71 / 230.79(C) (service, disconnect, rating) · 110.26(A)/(E)
(working & dedicated space) · 250.50 / 250.52 / 250.53(A)(2)&(G) / 250.66 / 250.70 /
250.24(A)(5)&(B) / 250.28 / 250.94 / 250.104(A)&(B) / 408.41 (full grounding & bonding) ·
110.14 / 110.14(D) / Annex I / 110.12(B) (connections) · 240.4 / 240.4(D) / 240.6 /
110.3(B) / 408.54 (overcurrent & panel) · 408.4(A) (directory) · 210.8(A)/(D) /
210.12(A)/(D) (GFCI/AFCI) · 210.52 / 210.70(A) / 406.4(D) / 406.12 (devices/lighting) ·
314.16 / 314.17 / 314.25 / 300.4 / 334.30 (boxes/cable) · 422.31(B) / 440.14 / 424.19
(disconnects) · Article 220 (load) · NFPA 72 / IRC R314–R315 (alarms). Jurisdiction
editions: Murfreesboro Ord. 18-O-71 · Franklin Ord. 2025-33 · Metro Ch. 16.20 · TN SFMO
0780-02 · 230.67 (2023 SPD).

**Peer-reviewed / authoritative `[peer-reviewed]`:**
Meese & Beausoliel, "Exploratory Study of Glowing Electrical Connections," U.S. NBS
(NIST) · Shea, "Glowing Contact Physics"; Sletbak et al., "Glowing Contact Areas in Loose
Copper Wire Connections," IEEE Holm Conf. · Korinek, "Poor Electrical Connections," J. NAFE
· NFPA 921 (I²R heating at poor connections).

> **Contractor verification note:** all base-NEC citations validated against the 2017 code
> book in project this pass. Still to confirm against the correct edition/source before
> customer release: 2023-only items (230.67; expanded 210.8/210.12) against a 2023 book;
> Nashville Ch. 16.20 full amendment list; and any local amendment in Murfreesboro/Franklin
> beyond the base adoption. Known-hazard panel identification (D3) is field judgment backed
> by documented failure histories, not a single NEC citation.
