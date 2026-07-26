import type { ChecklistItemDef } from '../domain/types'

// Transcribed from docs/RedCedar_Technician_Checklist_Blueprint_v2.md (single source of
// truth). Reasoning fields are verbatim with {placeholders} intact; citations are copied
// exactly — never invented or "improved."
//
// // VERIFY: the design docs describe "30 inspection items" but the Blueprint defines 29
// cards (A1–A3, B1–B2, C1–C7, D1–D5, E1–E3, F1–F3, G1–G3, H1–H2, I1). Confirm whether an
// item is missing from the Blueprint or the count in the docs is off by one.
//
// bannerListed mirrors the Scoring Design §3 Step 4 explicit list (see src/data/weights.ts).
// D1's banner is conditional (gradedState === 'severe' only) and D5's banner condition
// (unmitigated aluminum WITH heat damage) is pending graded-state encoding — both are
// handled in the scoring engine, so their defs carry bannerListed: false here.

export const checklist: ChecklistItemDef[] = [
  // ── SECTION A — SERVICE ENTRANCE & SUPPLY ────────────────────────────────
  {
    id: 'A1',
    section: 'A — Service Entrance & Supply',
    title: 'Service drop / lateral clearances & condition',
    citations: [
      '230.24 (overhead clearances: 10 ft at entrance/over pedestrian, 12 ft over residential drive, 3 ft above roof)',
      '230.26 (attach ≥10 ft)',
      '230.28 (mast strength)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false, // VERIFY: underground lateral services — Blueprint doesn't state whether A1 may be N/A
    inputFields: [
      { id: 'roof_clr', label: 'Roof clearance', type: 'text' },
      { id: 'yard_clr', label: 'Drive/yard clearance', type: 'text' },
      { id: 'mast_cond', label: 'Mast condition', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'The height and condition of the overhead service where it reaches the house — the mast, weatherhead, and clearances above the roof and yard.',
      whyCodeCares:
        '230.24 sets minimum clearances (e.g. 10 ft at the entrance, 12 ft over a driveway, 3 ft above the roof) so conductors stay out of reach and survive weather.',
      whatWeFound:
        'Roof clearance {roof_clr}, drive/yard clearance {yard_clr}, mast condition {mast_cond}.',
      whyItMatters:
        "A low or damaged service is a shock and outage risk; a compromised mast can be torn off in a storm, and the utility won't restore power until a licensed contractor rebuilds it. {plain_result}.",
    },
  },
  {
    id: 'A2',
    section: 'A — Service Entrance & Supply',
    title: 'Service rating vs. calculated load',
    citations: [
      '230.79(C) (one-family dwelling ≥100 A, 3-wire)',
      '230.42 (conductor ampacity)',
      'Article 220 (load calculation)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'service_amps', label: 'Service rating (A)', type: 'number' },
      { id: 'calc_load', label: 'Article 220 calculated load (A)', type: 'number' },
    ],
    reasoning: {
      whatWeCheck:
        "Whether the service size is adequate for the home's calculated load and meets the minimum for a house.",
      whyCodeCares:
        '230.79(C) sets a 100-amp minimum for a one-family dwelling, and Article 220 defines how the load is calculated. An undersized service overheats and nuisance-trips.',
      whatWeFound: 'Service rated {service_amps} A; Article 220 calculated load {calc_load} A.',
      whyItMatters:
        '{plain_result} — headroom matters if you add EV charging, HVAC, or an addition later.',
    },
  },
  {
    id: 'A3',
    section: 'A — Service Entrance & Supply',
    title: 'Meter base (external condition) & main disconnect',
    citations: [
      '230.66 (service equipment listed/labeled)',
      '312 (enclosure integrity)',
    ],
    jurisdictionDependent: false,
    bannerListed: true, // Scoring Design Step 4: supply-side damage
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'meter_ext_cond', label: 'Meter base external condition', type: 'text' },
      { id: 'main_disc_cond', label: 'Main disconnect condition', type: 'text' },
      { id: 'utility_referral', label: 'Meter-socket internals (refer to utility)', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        "The outside condition of the meter enclosure and the main disconnect after it — corrosion, heat marks, secure mounting, weather sealing. We do **not** open the meter socket; that's the utility's equipment.",
      whyCodeCares:
        '230.66/312 require listed, intact service equipment. External corrosion or heat marks are visible warning signs even without opening anything.',
      whatWeFound:
        'Meter base exterior {meter_ext_cond}; main disconnect {main_disc_cond}; meter-socket internals {utility_referral}.',
      whyItMatters:
        "We flag what we can see and refer anything behind the utility's seal to them — so you get an honest read without anyone touching equipment they're not permitted to open. {plain_result}.",
    },
  },

  // ── SECTION B — SERVICE DISCONNECT & WORKING SPACE ───────────────────────
  {
    id: 'B1',
    section: 'B — Service Disconnect & Working Space',
    title: 'Service disconnect — location, marking, rating',
    citations: [
      '230.70(A) (readily accessible, outside or nearest point of entry; not in a bathroom)',
      '230.70(B) (marked as service disconnect)',
      '230.71 (≤6 disconnects)',
      '230.77 (indicates on/off)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'disc_loc', label: 'Disconnect location', type: 'text' },
      { id: 'disc_count', label: 'Disconnect count', type: 'number' },
      { id: 'disc_mark', label: 'Marking', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        "Where the main service disconnect is, that it's clearly marked, and that the whole house can be shut off in no more than six switch throws.",
      whyCodeCares:
        '230.70(A) requires it readily accessible and never in a bathroom; 230.71 caps it at six disconnects so power can be killed fast in an emergency.',
      whatWeFound: 'Location {disc_loc}; {disc_count} disconnect(s); marking {disc_mark}.',
      whyItMatters:
        'In a fire or shock emergency, first responders must find and kill power fast. {plain_result}.',
    },
  },
  {
    id: 'B2',
    section: 'B — Service Disconnect & Working Space',
    title: 'Panel working space & dedicated space',
    citations: [
      '110.26(A) (≥36 in. deep, ≥30 in. wide, ≥6.5 ft high clear in front)',
      '110.26(E) (dedicated space above; no piping/ducts foreign to electrical)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'depth', label: 'Clear depth', type: 'text' },
      { id: 'width', label: 'Clear width', type: 'text' },
      { id: 'height', label: 'Clear height', type: 'text' },
      { id: 'dedicated_state', label: 'Dedicated space condition', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'The clear working space in front of the panel (36 in. deep, 30 in. wide, 6.5 ft high) and that nothing foreign (plumbing, ducts) crowds the space above it.',
      whyCodeCares:
        '110.26 requires this clearance so the panel can be safely worked on energized; 110.26(E) keeps water lines and ducts out of the dedicated zone.',
      whatWeFound:
        'Clear depth {depth}, width {width}, height {height}; dedicated space {dedicated_state}.',
      whyItMatters:
        'A panel boxed in by shelving, furnace, or plumbing is a safety violation and a real hazard for anyone servicing it — extremely common in finished basements and remodels. {plain_result}.',
    },
  },

  // ── SECTION C — GROUNDING & BONDING (Article 250) ────────────────────────
  {
    id: 'C1',
    section: 'C — Grounding & Bonding',
    title: 'Grounding electrode(s) present & type',
    citations: [
      '250.50 (all present electrodes bonded into system)',
      '250.52 (permitted electrode types: rod, Ufer/concrete-encased, water pipe, ground ring)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [{ id: 'electrode_types', label: 'Electrodes present', type: 'text' }],
    reasoning: {
      whatWeCheck:
        'What grounding electrodes the home actually has — driven rod(s), a concrete-encased (Ufer) electrode, or a metal water-pipe electrode.',
      whyCodeCares:
        "250.50 requires all present electrodes to be bonded together into one grounding electrode system — it's the foundation the whole safety system stands on.",
      whatWeFound: 'Electrodes present: {electrode_types}.',
      whyItMatters:
        'The grounding system is what gives a fault a safe path to earth and stabilizes your voltage. {plain_result}.',
    },
  },
  {
    id: 'C2',
    section: 'C — Grounding & Bonding',
    title: 'Ground-rod resistance (measured)',
    citations: [
      '250.53(A)(2) Exception (single rod ≤25 Ω, else supplemental electrode required)',
      '250.53(G) (≥8 ft rod in soil)',
    ],
    jurisdictionDependent: false,
    bannerListed: true, // Scoring Design Step 1d: immediate-fix fault-path class
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'ground_ohms', label: 'Measured resistance to earth (Ω)', type: 'number' },
      { id: 'rod_count', label: 'Rod count', type: 'number' },
      { id: 'supp_state', label: 'Supplemental electrode', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'The actual resistance of the ground rod to earth — measured with an instrument, not assumed.',
      whyCodeCares:
        '250.53(A)(2) allows a single rod only if it measures 25 ohms or less; above that, a second rod at least 6 ft away is required.',
      whatWeFound:
        '{ground_ohms} Ω (limit 25 Ω), {rod_count} rod(s), supplemental {supp_state}.',
      whyItMatters:
        'Almost nobody measures this — most installers drive one rod and assume. A high-resistance ground can\'t clear faults properly. Yours {plain_result}.',
    },
  },
  {
    id: 'C3',
    section: 'C — Grounding & Bonding',
    title: 'Grounding electrode conductor (GEC) — size & connection',
    citations: [
      '250.66 (GEC sizing per Table 250.66)',
      '250.70 (listed connection, no solder)',
      '250.64 (routing/protection)',
    ],
    jurisdictionDependent: false,
    bannerListed: true, // Scoring Design Step 1d: immediate-fix fault-path class
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'gec_size', label: 'GEC size', type: 'text' },
      { id: 'service_amps', label: 'Service rating (A)', type: 'number' },
      { id: 'gec_conn', label: 'Connection method & condition', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'The conductor that ties the panel to the grounding electrodes — its size and the integrity of its clamp at the rod.',
      whyCodeCares:
        '250.66 sizes the GEC to the service; 250.70 requires a listed connection (solder is prohibited) so it stays intact under fault current.',
      whatWeFound: 'GEC {gec_size} (service {service_amps} A); connection {gec_conn}.',
      whyItMatters:
        'A loose or undersized grounding conductor silently defeats the whole grounding system — it looks fine until a fault it can\'t handle. {plain_result}.',
    },
  },
  {
    id: 'C4',
    section: 'C — Grounding & Bonding',
    title: 'Main bonding jumper & EGC-bar bonding at the service',
    citations: [
      '250.24(B) (MBJ connects the EGCs and the enclosure to the grounded conductor)',
      '250.28 (MBJ material — "wire, bus, screw, or similar" — size per Table 250.102(C)(1))',
      '250.24(A)(4) (a wire/busbar from the neutral bar to the EGC bar is an explicitly recognized MBJ form)',
      '408.3(C) (service panelboard MBJ bonds neutral to frame)',
      '250.118 (enclosure is not a listed EGC type)',
    ],
    jurisdictionDependent: false,
    bannerListed: true, // Scoring Design Step 4: energized-metal bonding error
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'bus_config', label: 'Bus configuration (shared / separated)', type: 'select' },
      { id: 'mbj_state', label: 'MBJ present & form', type: 'text' },
      { id: 'egc_to_neutral', label: 'EGC-bar-to-neutral conductor', type: 'text' },
      { id: 'egc_bond_size', label: 'EGC bond conductor size', type: 'text' },
      { id: 'can_bond', label: 'Can bonded', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'First, whether grounds and neutrals share one bonded bus or sit on separate bars. If separate, whether a real conductor ties the EGC bar to the neutral bar — not the can standing in for it.',
      whyCodeCares:
        "250.24(B) requires the EGCs *and* the enclosure bonded to the grounded conductor at the service. The enclosure isn't a listed EGC (250.118), so when the bars are separated the grounding conductors must reach the neutral through a conductor, not through the sheet-metal box. 250.24(A)(4) is the code-sanctioned way to do exactly that.",
      whatWeFound:
        'Configuration {bus_config}; MBJ {mbj_state}; EGC-bar-to-neutral {egc_to_neutral}; can bond {can_bond}.',
      whyItMatters:
        'If the bars are separated and only the can links them, every equipment ground in the house is trying to return fault current through a bolted sheet-metal path the code never qualified for the job — the breaker may not clear and metal can energize. The fix is a copper conductor bar-to-bar, with the can still bonded. {plain_result}.',
    },
  },
  {
    id: 'C5',
    section: 'C — Grounding & Bonding',
    title: 'Neutral-ground separation at subpanels',
    citations: [
      '250.24(A)(5) (no re-grounding of neutral on load side of service)',
      '408.41 (neutrals isolated in subpanels)',
    ],
    jurisdictionDependent: false,
    bannerListed: true, // Scoring Design Step 4: energized-metal bonding error
    lifeSafetyClass: false,
    naAllowed: true, // no subpanels → N/A (explicit logged choice)
    inputFields: [
      { id: 'subpanel_count', label: 'Subpanels checked', type: 'number' },
      { id: 'ng_sep_state', label: 'Neutral/ground separation', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'That at every subpanel the neutral and ground are kept separate — the bonding screw removed, separate bars.',
      whyCodeCares:
        '250.24(A)(5) prohibits re-bonding neutral to ground past the service. Bonding them at a subpanel puts normal current on the ground wires and metal.',
      whatWeFound:
        'Subpanels checked {subpanel_count}; neutral/ground separation {ng_sep_state}.',
      whyItMatters:
        'A subpanel with neutral and ground bonded energizes ground wires and metal enclosures with normal current — a shock hazard hidden in plain sight, and one of the most common mistakes we find. {plain_result}.',
    },
  },
  {
    id: 'C6',
    section: 'C — Grounding & Bonding',
    title: 'Metal water pipe & gas pipe bonding',
    citations: [
      '250.104(A) (metal water piping bonded, sized per 250.102)',
      '250.104(B) (other metal piping incl. gas likely to be energized bonded)',
    ],
    jurisdictionDependent: false,
    bannerListed: true, // Scoring Design Step 1d: immediate-fix fault-path class
    lifeSafetyClass: false,
    naAllowed: true, // no gas → gas portion N/A (explicit logged choice)
    inputFields: [
      { id: 'water_bond', label: 'Water pipe bond', type: 'text' },
      { id: 'gas_bond', label: 'Gas/CSST bond', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'That the metal water piping (and gas piping where required) is bonded back to the electrical system.',
      whyCodeCares:
        "250.104 requires metal piping that could become energized to be bonded, so a fault can't make your pipes live. CSST gas line bonding is a documented fire-safety issue.",
      whatWeFound: 'Water pipe bond {water_bond}; gas/CSST bond {gas_bond}.',
      whyItMatters:
        "Unbonded metal plumbing can become energized during a fault — you'd get shocked touching a faucet. Unbonded CSST gas line is a lightning fire risk. {plain_result}.",
    },
  },
  {
    id: 'C7',
    section: 'C — Grounding & Bonding',
    title: 'Intersystem bonding termination (ISBT)',
    citations: ['250.94 (accessible IBT with ≥3 terminals for cable/phone/satellite bonding)'],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [{ id: 'isbt_state', label: 'Intersystem bonding termination', type: 'text' }],
    reasoning: {
      whatWeCheck:
        "Whether there's an accessible bonding point for the cable, phone, and satellite services to tie into the grounding system.",
      whyCodeCares:
        '250.94 requires an intersystem bonding termination so low-voltage services share the same ground — preventing voltage differences that damage equipment.',
      whatWeFound: 'Intersystem bonding termination {isbt_state}.',
      whyItMatters:
        'Without a common bonding point, a surge or fault can create damaging voltage differences between your power and your cable/internet. {plain_result}.',
    },
  },

  // ── SECTION D — PANEL, OVERCURRENT & CONNECTIONS ─────────────────────────
  {
    id: 'D1',
    section: 'D — Panel, Overcurrent & Connections',
    title: 'Connection integrity (torque + thermal)',
    citations: [
      '110.14 (connections)',
      '110.14(D) (torque to spec, calibrated tool, Annex I tables)',
      '110.12(B) (no corroded/overheated parts)',
    ],
    jurisdictionDependent: false,
    bannerListed: false, // banner fires only at gradedState 'severe' — handled in scoring engine
    lifeSafetyClass: false,
    graded: ['severe', 'moderate', 'minor'],
    naAllowed: false,
    inputFields: [
      { id: 'termination_result', label: 'Termination scan result', type: 'text' },
      { id: 'detail', label: 'Detail', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        "That every connection in the panel is tight to the manufacturer's torque spec and free of corrosion or heat damage.",
      whyCodeCares:
        '110.14(D) requires terminations torqued to spec with a calibrated tool; 110.12(B) forbids parts deteriorated by corrosion or overheating.',
      whatWeFound: '{termination_result} — {detail}.',
      whyItMatters:
        'Research on glowing connections (NIST; IEEE Holm) shows a loose junction can exceed **1000 °C — hotter than copper melts** — while drawing normal current, so breakers never trip. A documented fire-ignition source a torque wrench and thermal scan catch early.',
    },
  },
  {
    id: 'D2',
    section: 'D — Panel, Overcurrent & Connections',
    title: 'Breaker-to-conductor sizing',
    citations: [
      '240.4 (conductors protected at ampacity)',
      '240.4(D) (15 A/14 AWG, 20 A/12 AWG, 30 A/10 AWG small-conductor limits)',
      '240.6 (standard ratings)',
    ],
    jurisdictionDependent: false,
    bannerListed: true, // Scoring Design Step 4: defeated overcurrent protection
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'matched_count', label: 'Matched circuits', type: 'number' },
      { id: 'total_count', label: 'Total circuits', type: 'number' },
      { id: 'mismatch_detail', label: 'Mismatch detail', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'That every breaker matches the wire it protects — a 15-amp wire never on a 20- or 30-amp breaker.',
      whyCodeCares:
        '240.4 requires conductors protected at their ampacity. An oversized breaker lets the wire overheat without ever tripping.',
      whatWeFound: '{matched_count} of {total_count} circuits matched; {mismatch_detail}.',
      whyItMatters:
        'An oversized breaker is a classic hidden fire cause and a common DIY error. {plain_result}.',
    },
  },
  {
    id: 'D3',
    section: 'D — Panel, Overcurrent & Connections',
    title: 'Breaker compatibility & panel condition',
    citations: [
      '110.3(B) (equipment used per listing)',
      '408.54 (max devices)',
      '110.12(B) (condition)',
    ],
    jurisdictionDependent: false,
    bannerListed: true, // Scoring Design Step 4: hazard/delisted panel
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'make_model', label: 'Panel make/model', type: 'text' },
      { id: 'hazard_match', label: 'Hazard-list match', type: 'text' },
      { id: 'breaker_compat', label: 'Breaker compatibility', type: 'text' },
      { id: 'double_tap', label: 'Double-taps', type: 'text' },
      { id: 'panel_damage', label: 'Heat/corrosion', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'The panel make and model against the known hazard-panel list, that the breakers are the type listed for this panel, and that there are no double-taps or heat damage.',
      whyCodeCares:
        '110.3(B) requires equipment installed per its listing; mixing breaker brands or double-tapping voids that. Several panel lines have documented failure-to-trip histories and are no longer UL-listed / no longer approved for sale.',
      whatWeFound:
        'Panel {make_model}; hazard-list match {hazard_match}; breaker compatibility {breaker_compat}; double-taps {double_tap}; heat/corrosion {panel_damage}.',
      whyItMatters:
        'A breaker that won\'t trip is worse than no breaker — the homeowner thinks they\'re protected. Some of these also exhibit a "false-off," where the handle reads OFF but the circuit stays live, a lethal shock trap for anyone who works on it. These panels are a documented insurance and fire issue and frequently trigger coverage denial or cancellation. {plain_result}.',
    },
  },
  {
    id: 'D4',
    section: 'D — Panel, Overcurrent & Connections',
    title: 'Panel circuit directory (verified schedule)',
    citations: [
      '408.4(A) (every circuit legibly identified, clear/specific purpose; spares labeled; no transient-occupancy descriptions)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'prior_label_state', label: 'Prior labeling', type: 'text' },
      { id: 'circuit_count', label: 'Circuits in verified schedule', type: 'number' },
    ],
    reasoning: {
      whatWeCheck:
        'That every breaker is accurately labeled to its true circuit — traced, not copied from the old door.',
      whyCodeCares:
        "408.4(A) requires each circuit legibly identified by clear, specific purpose with spares marked. Most panels don't meet this.",
      whatWeFound:
        'Prior labeling {prior_label_state}; verified schedule of {circuit_count} circuits installed with QR.',
      whyItMatters:
        "In an emergency, a correct directory is how anyone kills the right circuit fast — and it's exactly what 408.4 requires and almost no home has. {plain_result}.",
    },
  },
  {
    id: 'D5',
    section: 'D — Panel, Overcurrent & Connections',
    title: 'Aluminum branch-circuit wiring',
    citations: [
      '110.14 (connections, dissimilar-metal listing)',
      '110.3(B) (devices used per listing — CO/ALR-rated)',
      'CPSC hazard findings on pre-1972 solid aluminum branch wiring',
    ],
    jurisdictionDependent: false,
    bannerListed: false, // banner condition = unmitigated WITH heat damage // VERIFY graded encoding (Scoring Design Step 1b)
    lifeSafetyClass: false,
    naAllowed: true, // all-copper → N/A (explicit logged choice)
    inputFields: [
      { id: 'al_wiring_state', label: 'Aluminum branch wiring', type: 'text' },
      { id: 'al_mitigation', label: 'Mitigation', type: 'text' },
      { id: 'al_term_cond', label: 'Termination condition', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'Whether the home has old-style solid aluminum branch wiring (common ~1965–1973) and, if so, whether the connections have been properly mitigated.',
      whyCodeCares:
        'Solid aluminum branch wiring expands, oxidizes, and loosens at terminations more than copper; CPSC found homes with it far more likely to reach fire-hazard conditions at connections unless mitigated with listed devices or repairs.',
      whatWeFound:
        'Aluminum branch wiring {al_wiring_state}; mitigation {al_mitigation}; termination condition {al_term_cond}.',
      whyItMatters:
        "This is a leading cause of connection overheating and a frequent insurance flag — but it's fixable without a full rewire using listed connectors. Ignored, it quietly degrades at every outlet and switch. {plain_result}.",
    },
  },

  // ── SECTION E — BRANCH-CIRCUIT PROTECTION ────────────────────────────────
  {
    id: 'E1',
    section: 'E — Branch-Circuit Protection',
    title: 'GFCI protection (shock)',
    citations: [
      '210.8(A) (bathrooms, garages, outdoors, crawl spaces, unfinished basements, kitchens, within 6 ft of sinks, laundry, dishwasher 210.8(D))',
    ],
    jurisdictionDependent: true, // 2023: expanded scope — see jurisdiction citationOverrides
    bannerListed: true, // Scoring Design Step 4: GFCI absent in required wet/occupied location
    lifeSafetyClass: true,
    naAllowed: false,
    inputFields: [
      { id: 'gfci_result', label: 'GFCI test result', type: 'text' },
      { id: 'gfci_detail', label: 'Detail (per-device trip results)', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'That GFCI protection is present and actually trips in every wet or outdoor location the code lists.',
      whyCodeCares:
        '210.8 requires GFCI protection to prevent electrocution where water and electricity meet. {edition_note}',
      whatWeFound: '{gfci_result} — {gfci_detail}.',
      whyItMatters:
        'A working GFCI is the difference between a nuisance trip and an electrocution. {plain_result}.',
    },
  },
  {
    id: 'E2',
    section: 'E — Branch-Circuit Protection',
    title: 'AFCI protection (arc-fault fire)',
    citations: [
      '210.12(A) (kitchens, family/living/dining, bedrooms, hallways, laundry, closets, sunrooms…)',
      '210.12(D) (add on modify/replace/extend)',
      'TN amd: optional in baths, laundry, garages, unfinished basements',
    ],
    jurisdictionDependent: true, // 2023: broadened — see jurisdiction citationOverrides
    bannerListed: false,
    lifeSafetyClass: true,
    naAllowed: false,
    inputFields: [
      { id: 'afci_result', label: 'AFCI coverage result', type: 'text' },
      { id: 'afci_detail', label: 'Detail (circuits with/without AFCI)', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'Whether living-space circuits have arc-fault protection that trips on the arcing that starts fires behind walls.',
      whyCodeCares:
        '210.12 requires AFCI in living areas; 210.12(D) triggers it on existing homes only when a circuit is modified, replaced, or extended. {tn_amendment_note}',
      whatWeFound: '{afci_result} — {afci_detail}.',
      whyItMatters:
        'No violation on untouched wiring, but AFCI meaningfully lowers hidden-arc fire risk. Adding it is {required_or_optional} here — your call.',
    },
  },
  {
    id: 'E3',
    section: 'E — Branch-Circuit Protection',
    title: 'Surge protection (SPD)',
    citations: [
      '2017: not required',
      '2023: 230.67 REQUIRED on dwelling services (min 10 kA) and on service/panel replacement', // VERIFY against a 2023 NEC book (Pressure Test Part 2 §1)
    ],
    jurisdictionDependent: true,
    bannerListed: false,
    lifeSafetyClass: true,
    naAllowed: false,
    inputFields: [{ id: 'spd_state', label: 'SPD present (Y/N)', type: 'text' }],
    reasoning: {
      whatWeCheck:
        'Whether a surge-protective device is installed at the service to absorb voltage spikes before they reach your circuits.',
      whyCodeCares:
        '{spd_code_stance} It protects everything downstream — appliances and the safety devices themselves (AFCI, GFCI, smoke alarms).',
      whatWeFound: 'SPD {spd_state}.',
      whyItMatters:
        'A single lightning or grid surge can destroy electronics and degrade safety devices. {spd_requirement_line}',
    },
  },

  // ── SECTION F — DEVICES, RECEPTACLES & LIGHTING ──────────────────────────
  {
    id: 'F1',
    section: 'F — Devices, Receptacles & Lighting',
    title: 'Receptacle placement & condition',
    citations: [
      '210.52(A) (spacing: no point along wall >6 ft from a receptacle; walls ≥2 ft)',
      '210.52(B) (kitchen small-appliance)',
      '210.52(C) (countertop)',
      '406.4(D) (replacement rules)',
      '406.12 (tamper-resistant)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'recep_spacing', label: 'Spacing', type: 'text' },
      { id: 'recep_cond', label: 'Condition', type: 'text' },
      { id: 'recep_wiring', label: 'Wiring (polarity/ground)', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'Receptacle spacing, condition, correct wiring (polarity, ground), and tamper-resistant type where required.',
      whyCodeCares:
        "210.52 sets spacing so people don't rely on extension cords; 406.4(D) governs safe replacement; scorched or mis-wired receptacles are shock/fire hazards.",
      whatWeFound:
        'Spacing {recep_spacing}; condition {recep_cond}; wiring {recep_wiring}.',
      whyItMatters:
        'A scorched or reverse-wired outlet is an active hazard; sparse spacing drives unsafe extension-cord use. {plain_result}.',
    },
  },
  {
    id: 'F2',
    section: 'F — Devices, Receptacles & Lighting',
    title: 'Egress / Security lighting',
    citations: [
      '210.70(A) (lighting outlet in every habitable room, hall, stair, and at the exterior of outdoor entrances; switch-controlled)',
      '404 (switch use)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'egress_lighting_state', label: 'Interior egress lighting', type: 'text' },
      { id: 'exterior_lighting_state', label: 'Exterior entrance lighting', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'Switched lighting along the paths people use to get out and at exterior entries — habitable rooms, halls, stairways, and outdoor entrances alike.',
      whyCodeCares:
        '210.70 requires switched lighting in these areas so no one navigates a dark stairway, egress path, or entry — a fall/egress-safety provision that doubles as exterior security lighting.',
      whatWeFound:
        'Interior egress lighting {egress_lighting_state}; exterior entrance lighting {exterior_lighting_state}.',
      whyItMatters:
        'Missing lighting on a stair or egress path is a genuine fall hazard, and a dark exterior entry is both a safety and a security gap — not just an inconvenience. {plain_result}.',
    },
  },
  {
    id: 'F3',
    section: 'F — Devices, Receptacles & Lighting',
    title: 'Box fill, cable support & protection',
    citations: [
      '314.16 (box fill limits)',
      '314.17 (cable clamping)',
      '300.4 (protection from physical damage / nail plates)',
      '334.30 (NM cable support)',
      '314.25 (missing box covers)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'box_fill', label: 'Box fill', type: 'text' },
      { id: 'cable_support', label: 'Cable support', type: 'text' },
      { id: 'cable_protect', label: 'Physical protection', type: 'text' },
      { id: 'open_box', label: 'Open boxes', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'In accessible areas (attic, basement, unfinished spaces): box fill, cable support, protection where cable passes through framing, and that boxes are covered.',
      whyCodeCares:
        "314.16 limits box fill to prevent overheating/damaged insulation; 300.4 requires protection so nails/screws don't pierce cable; 314.25 requires covers on every box.",
      whatWeFound:
        'Box fill {box_fill}; cable support {cable_support}; physical protection {cable_protect}; open boxes {open_box}.',
      whyItMatters:
        'Overstuffed boxes cook conductor insulation; unprotected cable through a stud is one drywall screw away from a fault; open splices are shock and fire risks. {plain_result}.',
    },
  },

  // ── SECTION G — EQUIPMENT DISCONNECTS & LOAD BALANCE ─────────────────────
  {
    id: 'G1',
    section: 'G — Equipment Disconnects & Load Balance',
    title: 'Water heater disconnect',
    citations: [
      '422.31(B) (permanently-connected appliance >300 VA: switch/breaker within sight or lockable per 110.25)',
      'Article 100 ("within sight" = visible, ≤50 ft)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'wh_disc_state', label: 'Disconnect state', type: 'text' },
      { id: 'wh_distance', label: 'Distance', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'A way to shut power to the water heater within sight of it, or a lockable breaker.',
      whyCodeCares:
        '422.31(B) requires a disconnect within sight or lockable so anyone servicing it can kill power and see it stays off.',
      whatWeFound: 'Disconnect {wh_disc_state} ({wh_distance}).',
      whyItMatters: '{plain_result}.',
    },
  },
  {
    id: 'G2',
    section: 'G — Equipment Disconnects & Load Balance',
    title: 'HVAC / heating disconnect',
    citations: [
      '440.14 (A/C disconnect within sight of equipment)',
      '424.19 (fixed electric heat)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [{ id: 'hvac_disc_state', label: 'HVAC disconnect', type: 'text' }],
    reasoning: {
      whatWeCheck: 'That HVAC equipment has a disconnect within sight of the unit.',
      whyCodeCares:
        '440.14 / 424.19 require a disconnect within sight so a service tech can safely de-energize before working.',
      whatWeFound: 'HVAC disconnect {hvac_disc_state}.',
      whyItMatters: '{plain_result}.',
    },
  },
  {
    id: 'G3',
    section: 'G — Equipment Disconnects & Load Balance',
    title: 'Load balance (measured, fixed/dedicated circuits)',
    citations: ['Article 220 (load calculation methodology)'],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'leg_a', label: 'Leg A (A)', type: 'number' },
      { id: 'leg_b', label: 'Leg B (A)', type: 'number' },
      { id: 'imbalance_pct', label: 'Imbalance (%)', type: 'number' },
    ],
    reasoning: {
      whatWeCheck:
        'How evenly the two legs of the panel carry the fixed loads — dryer, range, HVAC, water heater, disposal.',
      whyCodeCares:
        'Article 220 governs load distribution. Balanced legs keep the shared neutral quiet and voltage steady.',
      whatWeFound: 'Leg A {leg_a} A, Leg B {leg_b} A ({imbalance_pct}% imbalance).',
      whyItMatters:
        'A skewed panel pushes extra current onto the neutral and sags voltage under load. We balance to real measured usage. {plain_result}.',
    },
  },

  // ── SECTION H — LIFE SAFETY & PANEL LIFE ─────────────────────────────────
  {
    id: 'H1',
    section: 'H — Life Safety & Panel Life',
    title: 'Smoke & CO alarms',
    citations: [
      'NFPA 72 (10-yr replacement life)',
      'IRC R314/R315 (placement: each bedroom, outside each sleeping area, each level; CO outside sleeping areas; interconnection)',
    ],
    jurisdictionDependent: false,
    bannerListed: true, // Scoring Design Step 4: no working smoke/CO alarms
    lifeSafetyClass: true,
    naAllowed: false,
    inputFields: [
      { id: 'in_life_count', label: 'Alarms within life', type: 'number' },
      { id: 'total_alarms', label: 'Total alarms', type: 'number' },
      { id: 'placement_result', label: 'Placement', type: 'text' },
      { id: 'oldest_year', label: 'Oldest alarm year', type: 'number' },
      { id: 'co_state', label: 'CO coverage', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'Age, type, placement, and interconnection of every smoke and CO alarm.',
      whyCodeCares:
        'NFPA 72 sets a hard 10-year life because the sensor degrades; IRC R314/R315 fix placement so nowhere is unprotected.',
      whatWeFound:
        '{in_life_count} of {total_alarms} within life; placement {placement_result}; oldest {oldest_year}; CO {co_state}.',
      whyItMatters:
        'Expired sensors respond slower to real smoke or CO. The most literal life-safety item in the home, and the fix is cheap. {plain_result}.',
    },
  },
  {
    id: 'H2',
    section: 'H — Life Safety & Panel Life',
    title: 'Panel condition & remaining life',
    citations: [
      'manufacturer rated life (~30 yrs)', // VERIFY: industry rule-of-thumb, not a manufacturer-published standard (Pressure Test Part 2 §5)
      '110.12(B) condition',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    // graded per Scoring Design Step 1b: corroded/heat-damaged = S4 (ACTION) · aged-but-sound = S3 (MONITOR)
    naAllowed: false,
    inputFields: [
      { id: 'install_year', label: 'Install year', type: 'number' },
      { id: 'age', label: 'Age (yrs)', type: 'number' },
      { id: 'make_model', label: 'Make/model', type: 'text' },
      { id: 'condition', label: 'Condition', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        'Panel age, corrosion, heat damage, hazard status vs ~30-yr rated life.',
      whyCodeCares:
        '110.12(B) requires equipment free of corrosion/overheating; manufacturers rate panels for a finite life.',
      whatWeFound:
        'Installed {install_year} ({age} yrs), {make_model}, condition {condition}.',
      whyItMatters:
        '{plain_result} — budget replacement before end of life rather than waiting for a surprise failure.',
    },
  },

  // ── SECTION I — NASHVILLE / DAVIDSON METRO AMENDMENTS (conditional) ──────
  {
    id: 'I1',
    section: 'I — Nashville / Davidson Metro Amendments',
    title: 'Metro-specific amendments (Nashville only)',
    citations: [
      'Metro Code Title 16, Ch. 16.20 amendments to 2023 NEC', // VERIFY: full chapter not read — three amendments from secondary references (Pressure Test Part 2 §2)
    ],
    jurisdictionDependent: true, // loads only when jurisdiction.metroAmendments === true
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    inputFields: [
      { id: 'disc_result', label: 'Main disconnect ≤5 ft from entry', type: 'text' },
      { id: 'wh_breaker_result', label: 'Water-heater multipole breaker', type: 'text' },
      { id: 'crawl_result', label: 'Crawl-space light guards', type: 'text' },
    ],
    reasoning: {
      whatWeCheck: 'The Metro-specific rules Nashville adds on top of the 2023 NEC.',
      whyCodeCares:
        'Metro Code Ch. 16.20 amends the base code — local requirements an out-of-town contractor or inspector routinely misses.',
      whatWeFound:
        'Main disconnect {disc_result}; water-heater breaker {wh_breaker_result}; crawl-space light guards {crawl_result}.',
      whyItMatters:
        'Meeting these Metro rules is what keeps the work compliant in Davidson County specifically. {plain_result}.',
    },
  },
]
