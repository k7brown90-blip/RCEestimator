import type { ChecklistItemDef } from '../domain/types'

// Transcribed from docs/RedCedar_Technician_Checklist_Blueprint_v2.md (single source of
// truth). Reasoning fields are verbatim with {placeholders} intact; citations are copied
// exactly — never invented or "improved."
//
// // VERIFY: the design docs describe "30 inspection items" but the Blueprint defines 29
// cards (A1–A3, B1–B2, C1–C7, D1–D5, E1–E3, F1–F3, G1–G3, H1–H2, I1). Confirm whether an
// item is missing from the Blueprint or the count in the docs is off by one.
//
// bannerListed mirrors the explicit list in src/data/criticalItems.ts. D1's banner is
// conditional (gradedState === 'severe' only) and D5's banner condition is unmitigated
// aluminum WITH heat damage — both are decided at evaluation time, so their defs carry
// bannerListed: false here.
//
// Phase 1 items take structured inputs — numbers where there's something to measure,
// option sets where there's a condition to name. Free text is for the detail that
// doesn't fit a field, never for the finding itself: a report can't compare "looks ok"
// against last year's, and a ledger can't open a finding on it.

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
    // Not N/A for an underground lateral — that's recorded on service_type, so
    // the record says which kind of service this house has rather than staying
    // silent about it.
    naAllowed: false,
    phase: 1,
    group: 'service-entrance',
    appliesTo: ['service_exterior'],
    repeatable: false,
    measurementRequired: true,
    inputFields: [
      {
        id: 'service_type',
        label: 'Service type',
        type: 'select',
        required: true,
        options: [
          { value: 'overhead', label: 'Overhead drop', reportLabel: 'an overhead drop' },
          { value: 'underground', label: 'Underground lateral', reportLabel: 'an underground lateral' },
        ],
      },
      {
        id: 'entry_clr_ft',
        label: 'Clearance at the entrance / over pedestrian areas',
        type: 'number',
        unit: 'ft',
        min: 0,
        max: 60,
        step: 0.5,
        requiredWhen: { fieldId: 'service_type', equals: 'overhead' },
        thresholds: [
          {
            when: { lt: 10 },
            verdict: 'FAIL',
            message: '230.24 requires 10 ft at the entrance and over pedestrian areas.',
          },
        ],
      },
      {
        id: 'drive_clr_ft',
        label: 'Clearance over the drive',
        type: 'number',
        unit: 'ft',
        min: 0,
        max: 60,
        step: 0.5,
        requiredWhen: { fieldId: 'service_type', equals: 'overhead' },
        thresholds: [
          {
            when: { lt: 12 },
            verdict: 'FAIL',
            message: '230.24 requires 12 ft over a residential driveway.',
          },
        ],
      },
      {
        id: 'roof_clr_ft',
        label: 'Clearance above the roof',
        type: 'number',
        unit: 'ft',
        min: 0,
        max: 60,
        step: 0.5,
        requiredWhen: { fieldId: 'service_type', equals: 'overhead' },
        helpText: 'Record the measurement whether or not an exception applies — the number is the record.',
        thresholds: [
          {
            when: { lt: 3 },
            verdict: 'FAIL',
            message: '230.24 requires 3 ft above the roof surface.',
          },
        ],
      },
      {
        id: 'attach_ht_ft',
        label: 'Point of attachment height',
        type: 'number',
        unit: 'ft',
        min: 0,
        max: 60,
        step: 0.5,
        requiredWhen: { fieldId: 'service_type', equals: 'overhead' },
        thresholds: [
          {
            when: { lt: 10 },
            verdict: 'FAIL',
            message: '230.26 requires the point of attachment at least 10 ft above finished grade.',
          },
        ],
      },
      {
        id: 'mast_cond',
        label: 'Mast / raceway condition',
        type: 'select',
        required: true,
        options: [
          { value: 'sound', label: 'Sound and plumb', reportLabel: 'sound and plumb' },
          { value: 'loose', label: 'Loose at the attachment', reportLabel: 'loose at the attachment' },
          { value: 'leaning', label: 'Leaning / pulled', reportLabel: 'leaning under the pull of the drop' },
          { value: 'unsupported', label: 'Unbraced / no guy', reportLabel: 'unbraced' },
          { value: 'corroded', label: 'Corroded', reportLabel: 'corroded' },
        ],
        thresholds: [
          {
            when: { eq: 'leaning' },
            verdict: 'FAIL',
            message: '230.28 requires the mast to have the strength to carry the drop.',
          },
          {
            when: { eq: 'unsupported' },
            verdict: 'FAIL',
            message: '230.28 — an unbraced mast cannot carry the pull of the drop.',
          },
          {
            when: { eq: 'loose' },
            verdict: 'FAIL',
            message: 'A loose attachment is what tears a mast off the wall in a storm.',
          },
          { when: { eq: 'corroded' }, verdict: 'MONITOR' },
        ],
      },
      {
        id: 'weatherhead',
        label: 'Weatherhead & drip loops',
        type: 'select',
        requiredWhen: { fieldId: 'service_type', equals: 'overhead' },
        options: [
          { value: 'sound', label: 'Sound, drip loops formed', reportLabel: 'sound with drip loops formed' },
          { value: 'no_drip_loop', label: 'No drip loops', reportLabel: 'without drip loops' },
          { value: 'damaged', label: 'Cracked / damaged', reportLabel: 'cracked or damaged' },
        ],
        thresholds: [
          {
            when: { eq: 'damaged' },
            verdict: 'FAIL',
            message: 'A failed weatherhead lets water track down the service conductors into the meter base.',
          },
          {
            when: { eq: 'no_drip_loop' },
            verdict: 'MONITOR',
            message: 'Without drip loops the conductors carry water straight to the terminations.',
          },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'The height and condition of the overhead service where it reaches the house — the mast, weatherhead, and clearances above the roof and yard.',
      whyCodeCares:
        '230.24 sets minimum clearances (e.g. 10 ft at the entrance, 12 ft over a driveway, 3 ft above the roof) so conductors stay out of reach and survive weather.',
      whatWeFound:
        'This property is served by {service_type}. Clearances measured: {entry_clr_ft} ft at the entrance, {drive_clr_ft} ft over the drive, {roof_clr_ft} ft above the roof, attached at {attach_ht_ft} ft. Mast {mast_cond}; weatherhead {weatherhead}.',
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
    phase: 1,
    group: 'service-entrance',
    appliesTo: ['service_exterior'],
    repeatable: false,
    measurementRequired: true,
    inputFields: [
      {
        id: 'service_amps',
        label: 'Service rating',
        type: 'number',
        unit: 'A',
        required: true,
        min: 0,
        max: 1200,
        helpText: 'Read from the main breaker or disconnect, not from the meter base.',
        thresholds: [
          {
            when: { lt: 100 },
            verdict: 'FAIL',
            message: '230.79(C) sets a 100 A minimum for a one-family dwelling.',
          },
        ],
      },
      {
        id: 'calc_load',
        label: 'Article 220 calculated load',
        type: 'number',
        unit: 'A',
        required: true,
        min: 0,
        max: 1200,
        helpText: 'Run the load calculation above and apply it — this field is the result, not an estimate.',
      },
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
    phase: 1,
    group: 'service-entrance',
    appliesTo: ['service_exterior'],
    repeatable: false,
    inputFields: [
      {
        id: 'meter_ext_cond',
        label: 'Meter base exterior',
        type: 'select',
        required: true,
        options: [
          { value: 'sound', label: 'Sound, weather-sealed', reportLabel: 'sound and weather-sealed' },
          { value: 'corroded', label: 'Corroded', reportLabel: 'corroded' },
          { value: 'heat_marks', label: 'Heat marks / discoloration', reportLabel: 'showing heat marks' },
          { value: 'loose_mount', label: 'Loose on its mounting', reportLabel: 'loose on its mounting' },
          { value: 'open_to_weather', label: 'Open to weather', reportLabel: 'open to weather' },
        ],
        thresholds: [
          {
            when: { eq: 'heat_marks' },
            verdict: 'FAIL',
            message:
              'Heat marks at the meter base mean a connection is failing behind the utility seal (110.12(B)). Refer to the utility — we do not open it.',
          },
          {
            when: { eq: 'open_to_weather' },
            verdict: 'FAIL',
            message: '312 requires the enclosure to keep weather out of the service equipment.',
          },
          {
            when: { eq: 'loose_mount' },
            verdict: 'FAIL',
            message: 'A loose meter base hangs the service load on the conductors instead of the wall.',
          },
          { when: { eq: 'corroded' }, verdict: 'MONITOR' },
        ],
      },
      {
        id: 'main_disc_cond',
        label: 'Main disconnect condition',
        type: 'select',
        required: true,
        options: [
          { value: 'sound', label: 'Sound, operates freely', reportLabel: 'sound and operating freely' },
          { value: 'stiff', label: 'Stiff to throw', reportLabel: 'stiff to operate' },
          { value: 'corroded', label: 'Corroded', reportLabel: 'corroded' },
          { value: 'heat_damage', label: 'Heat damage', reportLabel: 'heat-damaged' },
          { value: 'inoperable', label: 'Will not operate', reportLabel: 'inoperable' },
        ],
        thresholds: [
          {
            when: { eq: 'inoperable' },
            verdict: 'FAIL',
            message: 'A main disconnect that will not throw cannot kill the house in an emergency.',
          },
          {
            when: { eq: 'heat_damage' },
            verdict: 'FAIL',
            message: '110.12(B) forbids equipment deteriorated by overheating.',
          },
          { when: { eq: 'corroded' }, verdict: 'MONITOR' },
          { when: { eq: 'stiff' }, verdict: 'MONITOR' },
        ],
      },
      {
        id: 'utility_referral',
        label: 'Meter-socket internals',
        type: 'select',
        required: true,
        options: [
          {
            value: 'not_opened',
            label: 'Not opened — seal intact',
            reportLabel: 'not opened; the utility seal is intact',
          },
          { value: 'referred', label: 'Referred to the utility', reportLabel: 'referred to the utility' },
          {
            value: 'seal_broken',
            label: 'Found with the seal already broken',
            reportLabel: 'found with the utility seal already broken',
          },
        ],
        thresholds: [
          {
            when: { eq: 'seal_broken' },
            verdict: 'MONITOR',
            message:
              'A broken seal means someone has been inside the utility\'s equipment. The utility should be told who and when.',
          },
        ],
      },
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
    phase: 1,
    group: 'main-disconnect',
    appliesTo: ['service_exterior'],
    repeatable: false,
    measurementRequired: true,
    inputFields: [
      {
        id: 'disc_loc',
        label: 'Disconnect location',
        type: 'select',
        required: true,
        options: [
          { value: 'exterior', label: 'Outside at the meter', reportLabel: 'outside at the meter' },
          {
            value: 'nearest_entry',
            label: 'Inside, nearest point of entry',
            reportLabel: 'inside at the nearest point of entry',
          },
          {
            value: 'remote_interior',
            label: 'Inside, past the point of entry',
            reportLabel: 'well inside the building, past the point of entry',
          },
          { value: 'bathroom', label: 'In a bathroom', reportLabel: 'in a bathroom' },
          { value: 'obstructed', label: 'Not readily accessible', reportLabel: 'not readily accessible' },
        ],
        thresholds: [
          {
            when: { eq: 'bathroom' },
            verdict: 'FAIL',
            message: '230.70(A) prohibits the service disconnect in a bathroom.',
          },
          {
            when: { eq: 'remote_interior' },
            verdict: 'FAIL',
            message:
              '230.70(A)(1) requires the disconnect at the nearest point of entry — unfused service conductors should not run through the building.',
          },
          {
            when: { eq: 'obstructed' },
            verdict: 'FAIL',
            message: '230.70(A) requires the service disconnect readily accessible.',
          },
        ],
      },
      {
        id: 'disc_count',
        label: 'Throws needed to kill the whole house',
        type: 'number',
        required: true,
        min: 1,
        max: 12,
        thresholds: [
          {
            when: { gt: 6 },
            verdict: 'FAIL',
            message: '230.71 caps the service at six disconnects.',
          },
        ],
      },
      {
        id: 'disc_mark',
        label: 'Marking',
        type: 'select',
        required: true,
        options: [
          {
            value: 'marked',
            label: 'Marked as service disconnect',
            reportLabel: 'marked as the service disconnect',
          },
          { value: 'illegible', label: 'Present but illegible', reportLabel: 'marked but illegible' },
          { value: 'unmarked', label: 'Unmarked', reportLabel: 'unmarked' },
        ],
        thresholds: [
          {
            when: { eq: 'unmarked' },
            verdict: 'FAIL',
            message: '230.70(B) requires the service disconnect to be marked as such.',
          },
          {
            when: { eq: 'illegible' },
            verdict: 'FAIL',
            message: '230.70(B) — a marking nobody can read is not a marking.',
          },
        ],
      },
      {
        id: 'disc_indicates',
        label: 'On/off indication',
        type: 'select',
        required: true,
        options: [
          { value: 'indicates', label: 'Plainly indicates on/off', reportLabel: 'plainly indicating on and off' },
          {
            value: 'no_indication',
            label: 'No clear indication',
            reportLabel: 'without clear on/off indication',
          },
        ],
        thresholds: [
          {
            when: { eq: 'no_indication' },
            verdict: 'FAIL',
            message: '230.77 requires the disconnect to plainly indicate whether it is open or closed.',
          },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        "Where the main service disconnect is, that it's clearly marked, and that the whole house can be shut off in no more than six switch throws.",
      whyCodeCares:
        '230.70(A) requires it readily accessible and never in a bathroom; 230.71 caps it at six disconnects so power can be killed fast in an emergency.',
      whatWeFound:
        'The service disconnect is {disc_loc}, {disc_mark}, {disc_indicates}; {disc_count} throw(s) kill the whole house.',
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
    phase: 1,
    group: 'main-disconnect',
    appliesTo: ['service_exterior', 'panel'],
    repeatable: true,
    measurementRequired: true,
    inputFields: [
      {
        id: 'depth_in',
        label: 'Clear depth in front',
        type: 'number',
        unit: 'in',
        required: true,
        min: 0,
        max: 200,
        step: 0.5,
        thresholds: [
          {
            when: { lt: 36 },
            verdict: 'FAIL',
            message: '110.26(A)(1) requires 36 in. of clear working depth in front of the equipment.',
          },
        ],
      },
      {
        id: 'width_in',
        label: 'Clear width',
        type: 'number',
        unit: 'in',
        required: true,
        min: 0,
        max: 200,
        step: 0.5,
        thresholds: [
          {
            when: { lt: 30 },
            verdict: 'FAIL',
            message: '110.26(A)(2) requires 30 in. of clear width, or the width of the equipment if wider.',
          },
        ],
      },
      {
        id: 'height_in',
        label: 'Clear headroom',
        type: 'number',
        unit: 'in',
        required: true,
        min: 0,
        max: 200,
        step: 0.5,
        helpText: '6.5 ft is 78 in.',
        thresholds: [
          {
            when: { lt: 78 },
            verdict: 'FAIL',
            message: '110.26(A)(3) requires 6.5 ft (78 in.) of headroom in the working space.',
          },
        ],
      },
      {
        id: 'dedicated_state',
        label: 'Dedicated space above',
        type: 'select',
        required: true,
        options: [
          { value: 'clear', label: 'Clear', reportLabel: 'clear' },
          { value: 'piping', label: 'Piping through the space', reportLabel: 'crossed by piping' },
          { value: 'ducts', label: 'Ductwork through the space', reportLabel: 'crossed by ductwork' },
          { value: 'storage', label: 'Used for storage', reportLabel: 'used for storage' },
        ],
        thresholds: [
          {
            when: { eq: 'piping' },
            verdict: 'FAIL',
            message: '110.26(E) keeps piping foreign to the electrical installation out of the dedicated space.',
          },
          {
            when: { eq: 'ducts' },
            verdict: 'FAIL',
            message: '110.26(E) keeps ductwork out of the dedicated space above the equipment.',
          },
          {
            when: { eq: 'storage' },
            verdict: 'FAIL',
            message: '110.26(B) — the working space cannot be used for storage.',
          },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'The clear working space in front of the panel (36 in. deep, 30 in. wide, 6.5 ft high) and that nothing foreign (plumbing, ducts) crowds the space above it.',
      whyCodeCares:
        '110.26 requires this clearance so the panel can be safely worked on energized; 110.26(E) keeps water lines and ducts out of the dedicated zone.',
      whatWeFound:
        'Clear depth {depth_in} in., width {width_in} in., headroom {height_in} in.; the dedicated space above is {dedicated_state}.',
      whyItMatters:
        'A panel boxed in by shelving, furnace, or plumbing is a safety violation and a real hazard for anyone servicing it — extremely common in finished basements and remodels. {plain_result}.',
    },
  },

  // ── SECTION C — GROUNDING & BONDING (Article 250) ────────────────────────
  // C1 merges what used to be three separate checks (electrodes present,
  // rod resistance, GEC size & connection). They shared most of their fields and
  // are assessed in one place with one instrument, so splitting them made the
  // technician re-enter the same context three times.
  {
    id: 'C1',
    section: 'C — Grounding & Bonding',
    title: 'Grounding electrode system — electrodes, resistance & GEC',
    citations: [
      '250.50 (all present electrodes bonded into one system)',
      '250.52 (permitted electrode types: rod, Ufer/concrete-encased, water pipe, ground ring)',
      '250.53(A)(2) Exception (single rod ≤25 Ω, else supplemental electrode required)',
      '250.53(G) (≥8 ft rod in soil)',
      '250.64 (GEC routing/protection)',
      '250.66 (GEC sizing per Table 250.66)',
      '250.70 (listed connection, no solder)',
    ],
    jurisdictionDependent: false,
    bannerListed: true, // inherits the fault-path status of the checks it absorbed
    lifeSafetyClass: false,
    naAllowed: false,
    phase: 1,
    group: 'bonding-grounding',
    appliesTo: ['service_exterior'],
    repeatable: false,
    measurementRequired: true,
    inputFields: [
      {
        id: 'electrode_types',
        label: 'Electrodes present',
        type: 'multiselect',
        required: true,
        options: [
          { value: 'rod', label: 'Driven rod(s)', reportLabel: 'driven rod(s)' },
          { value: 'ufer', label: 'Concrete-encased (Ufer)', reportLabel: 'a concrete-encased (Ufer) electrode' },
          { value: 'water_pipe', label: 'Metal water pipe', reportLabel: 'a metal water-pipe electrode' },
          { value: 'ground_ring', label: 'Ground ring', reportLabel: 'a ground ring' },
          { value: 'none', label: 'None found', reportLabel: 'none found' },
        ],
      },
      {
        id: 'rod_count',
        label: 'Rod count',
        type: 'number',
        min: 0,
        max: 10,
        requiredWhen: { fieldId: 'electrode_types', includes: 'rod' },
      },
      {
        id: 'ground_ohms',
        label: 'Measured resistance to earth',
        type: 'number',
        unit: 'Ω',
        min: 0,
        step: 0.1,
        requiredWhen: { fieldId: 'electrode_types', includes: 'rod' },
        helpText: 'Measured with an instrument, not assumed — almost nobody does this.',
        thresholds: [
          {
            when: { gt: 25 },
            verdict: 'FAIL',
            message: 'Above the 25 Ω limit — 250.53(A)(2) requires a supplemental electrode at least 6 ft away.',
          },
          { when: { lte: 25 }, verdict: 'PASS' },
        ],
      },
      {
        id: 'supp_state',
        label: 'Supplemental electrode',
        type: 'select',
        options: [
          { value: 'present', label: 'Present, ≥6 ft away', reportLabel: 'present' },
          { value: 'absent', label: 'Absent', reportLabel: 'absent' },
          { value: 'not_required', label: 'Not required (≤25 Ω)', reportLabel: 'not required' },
        ],
      },
      {
        id: 'gec_size',
        label: 'GEC size',
        type: 'select',
        unit: 'AWG',
        required: true,
        options: [
          { value: '8cu', label: '#8 Cu', reportLabel: '#8 Cu' },
          { value: '6cu', label: '#6 Cu', reportLabel: '#6 Cu' },
          { value: '4cu', label: '#4 Cu', reportLabel: '#4 Cu' },
          { value: '2cu', label: '#2 Cu', reportLabel: '#2 Cu' },
          { value: '1/0cu', label: '#1/0 Cu', reportLabel: '#1/0 Cu' },
          { value: '4al', label: '#4 Al', reportLabel: '#4 Al' },
          { value: 'other', label: 'Other / undersized', reportLabel: 'an undersized conductor' },
        ],
      },
      {
        id: 'gec_conn',
        label: 'Connection method & condition',
        type: 'select',
        required: true,
        options: [
          { value: 'listed_clamp', label: 'Listed clamp, sound', reportLabel: 'a sound listed clamp' },
          { value: 'irrev_crimp', label: 'Irreversible crimp', reportLabel: 'an irreversible crimp' },
          { value: 'exothermic', label: 'Exothermic weld', reportLabel: 'an exothermic weld' },
          { value: 'soldered', label: 'Soldered (prohibited)', reportLabel: 'a soldered joint' },
          { value: 'loose', label: 'Loose', reportLabel: 'a loose connection' },
          { value: 'corroded', label: 'Corroded', reportLabel: 'a corroded connection' },
        ],
        thresholds: [
          {
            when: { eq: 'soldered' },
            verdict: 'FAIL',
            message: '250.70 prohibits solder — it fails at the temperatures a fault produces.',
          },
          { when: { eq: 'loose' }, verdict: 'FAIL', message: 'A loose GEC clamp defeats the grounding system.' },
        ],
      },
      {
        id: 'gec_protected',
        label: 'Physical protection / routing',
        type: 'select',
        options: [
          { value: 'protected', label: 'Protected', reportLabel: 'protected' },
          { value: 'unprotected', label: 'Exposed to damage', reportLabel: 'exposed to damage' },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'The whole grounding electrode system in one pass: which electrodes the home actually has, what the rod measures to earth, and the size, routing and clamp of the conductor tying it all back to the service.',
      whyCodeCares:
        '250.50 requires every present electrode bonded into one system; 250.53(A)(2) allows a single rod only at 25 ohms or less; 250.66 sizes the GEC to the service and 250.70 requires a listed connection — solder is prohibited.',
      whatWeFound:
        'Electrodes present: {electrode_types}. Measured {ground_ohms} Ω to earth (25 Ω limit) across {rod_count} rod(s), supplemental electrode {supp_state}. GEC {gec_size} for a {A2.service_amps} A service; connection {gec_conn}, {gec_protected}.',
      whyItMatters:
        "The grounding system is what gives a fault a safe path to earth and holds your voltage steady. Almost nobody measures the rod — most installers drive one and assume. A high-resistance ground, or a loose or undersized conductor, silently defeats the whole system: it looks fine right up until a fault it can't handle. {plain_result}.",
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
    phase: 1,
    group: 'bonding-grounding',
    appliesTo: ['service_exterior'],
    repeatable: false,
    inputFields: [
      {
        id: 'bus_config',
        label: 'Bus configuration',
        type: 'select',
        required: true,
        options: [
          { value: 'shared', label: 'Shared bonded bus', reportLabel: 'a single shared bonded bus' },
          { value: 'separated', label: 'Separate bars', reportLabel: 'separate ground and neutral bars' },
        ],
      },
      {
        id: 'mbj_state',
        label: 'Main bonding jumper',
        type: 'select',
        required: true,
        options: [
          { value: 'screw', label: 'Bonding screw', reportLabel: 'a bonding screw' },
          { value: 'strap', label: 'Bonding strap/bus', reportLabel: 'a bonding strap' },
          { value: 'wire', label: 'Wire jumper', reportLabel: 'a wire jumper' },
          { value: 'absent', label: 'Absent', reportLabel: 'absent' },
        ],
      },
      {
        id: 'egc_to_neutral',
        label: 'EGC-bar-to-neutral conductor',
        type: 'select',
        // Only meaningful once the bars are separated — with a shared bus there
        // is nothing to bridge.
        requiredWhen: { fieldId: 'bus_config', equals: 'separated' },
        options: [
          { value: 'conductor', label: 'Conductor present', reportLabel: 'tied by a conductor' },
          { value: 'busbar', label: 'Listed busbar', reportLabel: 'tied by a listed busbar' },
          { value: 'can_only', label: 'Can only — no conductor', reportLabel: 'linked only through the enclosure' },
        ],
        thresholds: [
          {
            when: { eq: 'can_only' },
            verdict: 'FAIL',
            message:
              'The enclosure is not a listed EGC (250.118). With the bars separated, fault current is returning through the sheet-metal box.',
          },
        ],
      },
      { id: 'egc_bond_size', label: 'EGC bond conductor size', type: 'text', unit: 'AWG' },
      {
        id: 'can_bond',
        label: 'Enclosure bonded',
        type: 'select',
        required: true,
        options: [
          { value: 'bonded', label: 'Bonded', reportLabel: 'bonded' },
          { value: 'not_bonded', label: 'Not bonded', reportLabel: 'not bonded' },
        ],
      },
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
    phase: 2,
    group: 'subpanel-bonding',
    appliesTo: ['panel'],
    repeatable: true,
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
    phase: 1,
    group: 'bonding-grounding',
    appliesTo: ['service_exterior'],
    repeatable: false,
    inputFields: [
      {
        id: 'water_bond',
        label: 'Metal water pipe bond',
        type: 'select',
        required: true,
        options: [
          { value: 'bonded', label: 'Bonded, correctly sized', reportLabel: 'bonded and correctly sized' },
          {
            value: 'undersized',
            label: 'Bonded but undersized',
            reportLabel: 'bonded with an undersized conductor',
          },
          { value: 'absent', label: 'Absent', reportLabel: 'absent' },
          {
            value: 'no_metal',
            label: 'No metal water piping',
            reportLabel: 'not applicable — no metal water piping',
          },
        ],
        thresholds: [
          {
            when: { eq: 'absent' },
            verdict: 'FAIL',
            message: '250.104(A) requires metal water piping bonded back to the service.',
          },
          {
            when: { eq: 'undersized' },
            verdict: 'FAIL',
            message: '250.104(A) sizes the bond per 250.102 — an undersized conductor will not carry the fault.',
          },
        ],
      },
      {
        id: 'water_bond_size',
        label: 'Water bond conductor size',
        type: 'text',
        unit: 'AWG',
        requiredWhen: { fieldId: 'water_bond', equals: 'bonded' },
      },
      {
        id: 'gas_bond',
        label: 'Gas / CSST bond',
        type: 'select',
        required: true,
        options: [
          { value: 'bonded', label: 'Bonded', reportLabel: 'bonded' },
          {
            value: 'csst_unbonded',
            label: 'CSST present, not bonded',
            reportLabel: 'CSST present and unbonded',
          },
          { value: 'absent', label: 'Absent', reportLabel: 'absent' },
          { value: 'no_gas', label: 'No gas piping', reportLabel: 'not applicable — no gas piping' },
        ],
        thresholds: [
          {
            when: { eq: 'csst_unbonded' },
            verdict: 'FAIL',
            message:
              'Unbonded CSST is a documented lightning fire risk; 250.104(B) covers metal piping likely to become energized.',
          },
          {
            when: { eq: 'absent' },
            verdict: 'FAIL',
            message: '250.104(B) requires bonding of metal piping likely to become energized.',
          },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'That the metal water piping (and gas piping where required) is bonded back to the electrical system.',
      whyCodeCares:
        "250.104 requires metal piping that could become energized to be bonded, so a fault can't make your pipes live. CSST gas line bonding is a documented fire-safety issue.",
      whatWeFound: 'The metal water piping is {water_bond} ({water_bond_size} AWG); the gas/CSST bond is {gas_bond}.',
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
    phase: 1,
    group: 'bonding-grounding',
    appliesTo: ['service_exterior'],
    repeatable: false,
    inputFields: [
      {
        id: 'isbt_state',
        label: 'Intersystem bonding termination',
        type: 'select',
        required: true,
        options: [
          {
            value: 'present',
            label: 'Present, ≥3 terminals, accessible',
            reportLabel: 'present and accessible with three or more terminals',
          },
          {
            value: 'insufficient',
            label: 'Present but <3 terminals or not accessible',
            reportLabel: 'present but short of the three accessible terminals 250.94 calls for',
          },
          {
            value: 'improvised',
            label: 'Low-voltage clamped to a rod or pipe',
            reportLabel: 'improvised — low-voltage services clamped to the rod or a pipe',
          },
          { value: 'absent', label: 'Absent', reportLabel: 'absent' },
        ],
        thresholds: [
          {
            when: { eq: 'absent' },
            // Not a violation on an existing installation — the NEC isn't
            // retroactive — but it is below what we'd install, which is exactly
            // what BELOW_STANDARD is for.
            verdict: 'BELOW_STANDARD',
            message:
              '250.94 requires an intersystem bonding termination at the service. The NEC is not retroactive, so this is not a violation on an older installation — it should be added the next time the service is worked on.',
          },
          {
            when: { eq: 'insufficient' },
            verdict: 'BELOW_STANDARD',
            message: '250.94 calls for at least three accessible terminals.',
          },
          {
            when: { eq: 'improvised' },
            verdict: 'MONITOR',
            message:
              'A clamp on the rod or a pipe is what 250.94 replaced — it works until someone disturbs it, and nobody re-lands it.',
          },
        ],
      },
      {
        id: 'lv_services_bonded',
        label: 'Low-voltage services actually landed on it',
        type: 'select',
        required: true,
        options: [
          { value: 'all', label: 'All present services bonded', reportLabel: 'all present services bonded to it' },
          { value: 'some', label: 'Some bonded', reportLabel: 'only some services bonded to it' },
          { value: 'none', label: 'None bonded', reportLabel: 'no services bonded to it' },
          {
            value: 'none_present',
            label: 'No low-voltage services at the house',
            reportLabel: 'no low-voltage services present',
          },
        ],
        thresholds: [
          {
            when: { eq: 'none' },
            verdict: 'MONITOR',
            message: 'A termination nothing is landed on protects nothing.',
          },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        "Whether there's an accessible bonding point for the cable, phone, and satellite services to tie into the grounding system — and whether those services are actually landed on it.",
      whyCodeCares:
        '250.94 requires an intersystem bonding termination so low-voltage services share the same ground — preventing voltage differences that damage equipment.',
      whatWeFound:
        'The intersystem bonding termination is {isbt_state}, with {lv_services_bonded}.',
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
    phase: 1,
    group: 'panel-condition',
    appliesTo: ['service_exterior', 'panel'],
    repeatable: true,
    measurementRequired: true,
    inputFields: [
      {
        id: 'terminations_checked',
        label: 'Terminations checked',
        type: 'number',
        required: true,
        min: 0,
        max: 200,
      },
      {
        id: 'scan_method',
        label: 'How they were checked',
        type: 'select',
        required: true,
        options: [
          {
            value: 'thermal_imager',
            label: 'Thermal imager, under load',
            reportLabel: 'a thermal imager with the house under load',
          },
          { value: 'ir_spot', label: 'IR spot thermometer', reportLabel: 'an infrared spot thermometer' },
          { value: 'torque_only', label: 'Torque check only', reportLabel: 'a torque check only' },
          { value: 'visual', label: 'Visual only', reportLabel: 'visual examination only' },
        ],
        thresholds: [
          {
            when: { eq: 'visual' },
            verdict: 'MONITOR',
            message: 'A glowing connection draws normal current and looks ordinary. Visual alone cannot rule it out.',
          },
        ],
      },
      {
        id: 'torque_verified',
        label: 'Torque verified to spec',
        type: 'select',
        required: true,
        options: [
          {
            value: 'calibrated',
            label: 'Yes — calibrated tool',
            reportLabel: 'verified with a calibrated torque tool',
          },
          {
            value: 'uncalibrated',
            label: 'Checked, uncalibrated tool',
            reportLabel: 'checked with an uncalibrated tool',
          },
          { value: 'not_verified', label: 'Not verified', reportLabel: 'not verified' },
        ],
        thresholds: [
          {
            when: { eq: 'not_verified' },
            verdict: 'MONITOR',
            message:
              '110.14(D) requires terminations torqued to spec with a calibrated tool. Unverified is unknown, not wrong — but it stays unknown until someone checks.',
          },
        ],
      },
      {
        id: 'hotspot_state',
        label: 'Worst termination found',
        type: 'select',
        required: true,
        options: [
          { value: 'none', label: 'None — all at ambient', reportLabel: 'every termination at ambient' },
          {
            value: 'warm',
            label: 'Warm above its neighbours',
            reportLabel: 'one termination running warm above its neighbours',
          },
          { value: 'hot', label: 'Hot under load', reportLabel: 'a termination running hot under load' },
          {
            value: 'discolored',
            label: 'Discolored / melted insulation',
            reportLabel: 'a discolored, heat-damaged termination',
          },
        ],
        thresholds: [
          {
            when: { eq: 'discolored' },
            verdict: 'FAIL',
            message: '110.12(B) forbids parts deteriorated by overheating — this one has already cooked.',
          },
          {
            when: { eq: 'hot' },
            verdict: 'FAIL',
            message: 'A termination running hot on normal current is the precursor to a glowing connection.',
          },
          { when: { eq: 'warm' }, verdict: 'MONITOR' },
        ],
      },
      {
        id: 'delta_t_c',
        label: 'Rise above the coolest comparable termination',
        type: 'number',
        unit: '°C',
        min: 0,
        max: 300,
        step: 0.1,
        requiredWhen: { fieldId: 'scan_method', equals: 'thermal_imager' },
        helpText:
          'Compare like to like — same leg, similar load. The rise over its neighbours is the finding, not the absolute temperature.',
      },
      { id: 'detail', label: 'Which terminations, and what was found', type: 'text' },
    ],
    reasoning: {
      whatWeCheck:
        "That every connection in the panel is tight to the manufacturer's torque spec and free of corrosion or heat damage.",
      whyCodeCares:
        '110.14(D) requires terminations torqued to spec with a calibrated tool; 110.12(B) forbids parts deteriorated by corrosion or overheating.',
      whatWeFound:
        '{terminations_checked} terminations checked using {scan_method}; torque {torque_verified}. Found {hotspot_state}, {delta_t_c} °C above its neighbours. {detail}.',
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
    phase: 1,
    group: 'panel-condition',
    appliesTo: ['service_exterior', 'panel'],
    repeatable: true,
    measurementRequired: true,
    inputFields: [
      {
        id: 'total_count',
        label: 'Breakers checked',
        type: 'number',
        required: true,
        min: 0,
        max: 100,
      },
      {
        id: 'mismatch_count',
        label: 'Breakers larger than the conductor allows',
        type: 'number',
        required: true,
        min: 0,
        max: 100,
        helpText: '15 A on 14 AWG, 20 A on 12 AWG, 30 A on 10 AWG — 240.4(D).',
        thresholds: [
          {
            when: { gt: 0 },
            verdict: 'FAIL',
            message: '240.4 requires every conductor protected at its ampacity.',
          },
        ],
      },
      {
        id: 'mismatch_detail',
        label: 'Which circuits, and by how much',
        type: 'text',
        helpText: 'Circuit number, breaker rating, conductor size. Required whenever the count above is not zero.',
      },
    ],
    reasoning: {
      whatWeCheck:
        'That every breaker matches the wire it protects — a 15-amp wire never on a 20- or 30-amp breaker.',
      whyCodeCares:
        '240.4 requires conductors protected at their ampacity. An oversized breaker lets the wire overheat without ever tripping.',
      whatWeFound:
        '{total_count} breakers checked; {mismatch_count} larger than the conductor allows. {mismatch_detail}.',
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
    phase: 1,
    group: 'panel-condition',
    appliesTo: ['service_exterior', 'panel'],
    repeatable: true,
    measurementRequired: true,
    inputFields: [
      { id: 'make_model', label: 'Panel make / model', type: 'text', required: true },
      {
        id: 'hazard_match',
        label: 'Known hazard panel',
        type: 'select',
        required: true,
        options: [
          { value: 'none', label: 'Not on the hazard list', reportLabel: 'not on the known hazard list' },
          { value: 'fpe', label: 'Federal Pacific Stab-Lok', reportLabel: 'a Federal Pacific Stab-Lok' },
          { value: 'zinsco', label: 'Zinsco / Sylvania-Zinsco', reportLabel: 'a Zinsco / Sylvania-Zinsco' },
          { value: 'challenger', label: 'Challenger', reportLabel: 'a Challenger' },
          { value: 'pushmatic', label: 'Pushmatic / Bulldog', reportLabel: 'a Pushmatic / Bulldog' },
          { value: 'unknown', label: 'Cannot be identified', reportLabel: 'unidentifiable' },
        ],
        thresholds: [
          {
            when: { eq: 'fpe' },
            verdict: 'FAIL',
            message:
              'Documented failure-to-trip history and no longer UL-listed. Insurers frequently decline or cancel over this panel.',
          },
          {
            when: { eq: 'zinsco' },
            verdict: 'FAIL',
            message:
              'Documented failure-to-trip and bus-burn history; replacement breakers are not listed for this enclosure.',
          },
          {
            when: { eq: 'challenger' },
            verdict: 'FAIL',
            message: 'Documented overheating at the breaker-to-bus connection.',
          },
          {
            when: { eq: 'pushmatic' },
            verdict: 'MONITOR',
            message: 'Obsolete — the mechanisms stiffen with age and parts are no longer manufactured.',
          },
          {
            when: { eq: 'unknown' },
            verdict: 'MONITOR',
            message:
              'A panel nobody can identify cannot be shown to have listed replacement breakers (110.3(B)).',
          },
        ],
      },
      {
        id: 'breaker_compat',
        label: 'Breaker listing',
        type: 'select',
        required: true,
        options: [
          { value: 'all_listed', label: 'All listed for this panel', reportLabel: 'all listed for this enclosure' },
          { value: 'mixed', label: 'Mixed brands', reportLabel: 'a mix of brands' },
          { value: 'unlisted', label: 'Unlisted for this enclosure', reportLabel: 'unlisted for this enclosure' },
        ],
        thresholds: [
          {
            when: { eq: 'mixed' },
            verdict: 'FAIL',
            message: '110.3(B) — a breaker not listed for this panelboard voids the listing of both.',
          },
          {
            when: { eq: 'unlisted' },
            verdict: 'FAIL',
            message: '110.3(B) requires equipment installed and used per its listing.',
          },
        ],
      },
      {
        id: 'double_tap_count',
        label: 'Double-tapped terminals',
        type: 'number',
        required: true,
        min: 0,
        max: 50,
        thresholds: [
          {
            when: { gt: 0 },
            verdict: 'FAIL',
            message: 'Two conductors under a terminal listed for one (110.3(B), 110.14).',
          },
        ],
      },
      {
        id: 'panel_damage',
        label: 'Enclosure condition',
        type: 'select',
        required: true,
        options: [
          { value: 'none', label: 'Sound', reportLabel: 'sound' },
          { value: 'surface_rust', label: 'Surface rust', reportLabel: 'showing surface rust' },
          { value: 'corrosion', label: 'Active corrosion', reportLabel: 'actively corroding' },
          { value: 'heat', label: 'Heat discoloration', reportLabel: 'heat-discolored' },
          { value: 'burned', label: 'Burned / melted', reportLabel: 'burned' },
        ],
        thresholds: [
          {
            when: { eq: 'burned' },
            verdict: 'FAIL',
            message: '110.12(B) — burned components are replaced, not cleaned up.',
          },
          {
            when: { eq: 'heat' },
            verdict: 'FAIL',
            message: '110.12(B) forbids equipment deteriorated by overheating.',
          },
          {
            when: { eq: 'corrosion' },
            verdict: 'FAIL',
            message: '110.12(B) forbids equipment deteriorated by corrosion.',
          },
          { when: { eq: 'surface_rust' }, verdict: 'MONITOR' },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'The panel make and model against the known hazard-panel list, that the breakers are the type listed for this panel, and that there are no double-taps or heat damage.',
      whyCodeCares:
        '110.3(B) requires equipment installed per its listing; mixing breaker brands or double-tapping voids that. Several panel lines have documented failure-to-trip histories and are no longer UL-listed / no longer approved for sale.',
      whatWeFound:
        'The panel is a {make_model}, {hazard_match}. Breakers are {breaker_compat}; {double_tap_count} double-tapped terminal(s); the enclosure is {panel_damage}.',
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
    // A strictly knife-switch or disconnect-only enclosure has no circuits to
    // identify. Every other panel — exterior main-breaker panels included — has
    // its own directory and gets one.
    naAllowed: true,
    phase: 1,
    group: 'panel-condition',
    appliesTo: ['service_exterior', 'panel'],
    repeatable: true,
    measurementRequired: true,
    inputFields: [
      {
        id: 'prior_label_state',
        label: 'Directory as found',
        type: 'select',
        required: true,
        options: [
          { value: 'accurate', label: 'Present and accurate', reportLabel: 'present and accurate' },
          { value: 'partial', label: 'Partial', reportLabel: 'only partially filled in' },
          { value: 'generic', label: 'Generic ("lights", "plugs")', reportLabel: 'generic — "lights", "plugs"' },
          { value: 'inaccurate', label: 'Present but wrong', reportLabel: 'present but inaccurate' },
          { value: 'missing', label: 'Missing', reportLabel: 'missing' },
        ],
        thresholds: [
          {
            when: { eq: 'missing' },
            verdict: 'FAIL',
            message: '408.4(A) requires every circuit legibly identified.',
          },
          {
            when: { eq: 'inaccurate' },
            verdict: 'FAIL',
            message: 'A wrong directory is worse than none — someone will trust it in an emergency.',
          },
          {
            when: { eq: 'generic' },
            verdict: 'FAIL',
            message: '408.4(A) requires a clear, specific purpose, not a category.',
          },
          {
            when: { eq: 'partial' },
            verdict: 'FAIL',
            message: '408.4(A) — every circuit, spares and spaces included.',
          },
        ],
      },
      {
        id: 'circuit_count',
        label: 'Circuits traced and verified',
        type: 'number',
        required: true,
        min: 0,
        max: 100,
        helpText: 'Traced on site, not copied off the old door.',
      },
      {
        id: 'spares_marked',
        label: 'Spares and spaces marked',
        type: 'select',
        required: true,
        options: [
          { value: 'marked', label: 'Marked', reportLabel: 'marked' },
          { value: 'unmarked', label: 'Unmarked', reportLabel: 'unmarked' },
        ],
        thresholds: [
          {
            when: { eq: 'unmarked' },
            verdict: 'FAIL',
            message: '408.4(A) requires spares and spaces identified too.',
          },
        ],
      },
      {
        id: 'schedule_installed',
        label: 'Verified schedule installed with QR',
        type: 'boolean',
      },
    ],
    reasoning: {
      whatWeCheck:
        'That every breaker is accurately labeled to its true circuit — traced, not copied from the old door.',
      whyCodeCares:
        "408.4(A) requires each circuit legibly identified by clear, specific purpose with spares marked. Most panels don't meet this.",
      whatWeFound:
        'The directory was found {prior_label_state}, spares {spares_marked}. {circuit_count} circuits traced and verified; schedule installed with QR: {schedule_installed}.',
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
    phase: 1,
    group: 'panel-condition',
    appliesTo: ['service_exterior', 'panel'],
    repeatable: true,
    inputFields: [
      {
        id: 'al_wiring_state',
        label: 'Aluminum branch wiring',
        type: 'select',
        required: true,
        options: [
          { value: 'none', label: 'None observed', reportLabel: 'not observed' },
          {
            value: 'solid_branch',
            label: 'Solid aluminum branch circuits',
            reportLabel: 'solid aluminum branch circuits present',
          },
          {
            value: 'feeder_only',
            label: 'Stranded aluminum feeders only',
            reportLabel: 'stranded aluminum feeders only — not the CPSC hazard class',
          },
          {
            value: 'unknown',
            label: 'Cannot determine from the panel',
            reportLabel: 'not determinable from the panel',
          },
        ],
        thresholds: [
          {
            when: { eq: 'unknown' },
            verdict: 'MONITOR',
            message:
              'The conductor type could not be confirmed at the panel. On a house of this era it is worth opening a device or two to settle it.',
          },
        ],
      },
      {
        id: 'al_circuit_count',
        label: 'Aluminum branch circuits counted',
        type: 'number',
        min: 0,
        max: 100,
        requiredWhen: { fieldId: 'al_wiring_state', equals: 'solid_branch' },
      },
      {
        id: 'al_mitigation',
        label: 'Mitigation',
        type: 'select',
        requiredWhen: { fieldId: 'al_wiring_state', equals: 'solid_branch' },
        options: [
          { value: 'copalum', label: 'COPALUM crimps', reportLabel: 'COPALUM crimps' },
          { value: 'alumiconn', label: 'AlumiConn connectors', reportLabel: 'AlumiConn connectors' },
          { value: 'co_alr', label: 'CO/ALR devices throughout', reportLabel: 'CO/ALR-rated devices throughout' },
          { value: 'partial', label: 'Partial / inconsistent', reportLabel: 'partial, inconsistent mitigation' },
          { value: 'none', label: 'None', reportLabel: 'no mitigation' },
        ],
        thresholds: [
          {
            when: { eq: 'none' },
            verdict: 'FAIL',
            message:
              'CPSC found homes with unmitigated solid aluminum branch wiring far more likely to reach fire-hazard conditions at connections.',
          },
          {
            when: { eq: 'partial' },
            verdict: 'FAIL',
            message: 'Partial mitigation leaves every untreated connection exactly as it was.',
          },
        ],
      },
      {
        id: 'al_term_cond',
        label: 'Termination condition',
        type: 'select',
        requiredWhen: { fieldId: 'al_wiring_state', equals: 'solid_branch' },
        options: [
          { value: 'sound', label: 'Sound', reportLabel: 'sound' },
          { value: 'oxidized', label: 'Oxidized', reportLabel: 'oxidized' },
          { value: 'heat_damage', label: 'Heat damage', reportLabel: 'heat-damaged' },
        ],
        thresholds: [
          {
            when: { eq: 'heat_damage' },
            // Unmitigated aluminum WITH heat damage is the banner condition —
            // this is the field that now makes it recordable.
            verdict: 'FAIL',
            message:
              'Heat at an aluminum termination is the documented CPSC failure mode, not a cosmetic finding.',
          },
          { when: { eq: 'oxidized' }, verdict: 'MONITOR' },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'Whether the home has old-style solid aluminum branch wiring (common ~1965–1973) and, if so, whether the connections have been properly mitigated.',
      whyCodeCares:
        'Solid aluminum branch wiring expands, oxidizes, and loosens at terminations more than copper; CPSC found homes with it far more likely to reach fire-hazard conditions at connections unless mitigated with listed devices or repairs.',
      whatWeFound:
        'Aluminum branch wiring {al_wiring_state} across {al_circuit_count} circuit(s); mitigation {al_mitigation}; terminations {al_term_cond}.',
      whyItMatters:
        "This is a leading cause of connection overheating and a frequent insurance flag — but it's fixable without a full rewire using listed connectors. Ignored, it quietly degrades at every outlet and switch. {plain_result}.",
    },
  },

  // D6/D7 are the measurement pair. D6 establishes the control — whatever the
  // utility delivers is this property's baseline, so there is no pass/fail band
  // on the absolute number. D7 then measures variance from that control, which
  // is what's actually diagnostic.
  {
    id: 'D6',
    section: 'D — Panel, Overcurrent & Connections',
    title: 'Service / main termination voltages (control reading)',
    citations: [
      '110.14 (connections)',
      'ANSI C84.1 Range A (utility delivery tolerance — informational)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    phase: 1,
    group: 'panel-measurements',
    appliesTo: ['service_exterior', 'panel'],
    repeatable: true,
    measurementRequired: true,
    inputFields: [
      {
        id: 'v_l1_l2', label: 'L1 – L2 (phase to phase)', type: 'number', unit: 'V',
        required: true, min: 0, max: 300, step: 0.1,
      },
      {
        id: 'v_l1_n', label: 'L1 – N (phase to neutral)', type: 'number', unit: 'V',
        required: true, min: 0, max: 200, step: 0.1,
        helpText: 'This becomes the reference every L1 branch reading is compared against.',
      },
      {
        id: 'v_l2_n', label: 'L2 – N (phase to neutral)', type: 'number', unit: 'V',
        required: true, min: 0, max: 200, step: 0.1,
      },
      {
        id: 'v_l1_g', label: 'L1 – G (phase to ground)', type: 'number', unit: 'V',
        required: true, min: 0, max: 200, step: 0.1,
      },
      {
        id: 'v_l2_g', label: 'L2 – G (phase to ground)', type: 'number', unit: 'V',
        required: true, min: 0, max: 200, step: 0.1,
      },
      {
        id: 'v_n_g', label: 'N – G (neutral to ground)', type: 'number', unit: 'V',
        min: 0, max: 200, step: 0.1,
        helpText: 'Elevated N–G under load points at a loaded or high-resistance neutral.',
        thresholds: [
          {
            when: { gt: 1 },
            verdict: 'MONITOR',
            message: 'Persistent neutral-to-ground voltage suggests a loaded neutral or a bond downstream of the service.',
          },
        ],
      },
      {
        id: 'meter_type', label: 'Instrument', type: 'select',
        options: [
          { value: 'trms_dmm', label: 'True-RMS DMM', reportLabel: 'a true-RMS meter' },
          { value: 'dmm', label: 'DMM', reportLabel: 'a digital multimeter' },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'Every voltage at the service or main termination: leg to leg, each leg to neutral, each leg to ground, and neutral to ground.',
      whyCodeCares:
        "There is no code band on the voltage a utility delivers — that's their side of the meter. These readings exist to establish this property's baseline, and to expose faults that show up as inconsistency between them regardless of what's being delivered.",
      whatWeFound:
        'L1–L2 {v_l1_l2} V; L1–N {v_l1_n} V; L2–N {v_l2_n} V; L1–G {v_l1_g} V; L2–G {v_l2_g} V; N–G {v_n_g} V.',
      whyItMatters:
        'A house delivered 122 volts simply runs at 122 volts — that is not a defect. What matters is what happens to it downstream. These numbers are the control every other reading in the panel is measured against, and a wide split between the two legs is itself a fault: it means the neutral is open or high-resistance. {plain_result}.',
    },
  },
  {
    id: 'D7',
    section: 'D — Panel, Overcurrent & Connections',
    title: 'Branch-circuit voltage at the OCPD',
    citations: [
      '110.14(D) (torque to spec, calibrated tool)',
      '110.12(B) (no corroded or overheated parts)',
      '210.19(A) Informational Note (3% branch / 5% total — applies to conductor runs, not to this measurement)',
    ],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: true, // a disconnect-only enclosure has no branch breakers
    phase: 1,
    group: 'panel-measurements',
    appliesTo: ['service_exterior', 'panel'],
    repeatable: true,
    measurementRequired: true,
    dependsOn: ['D6'],
    inputFields: [
      {
        id: 'branch_rows',
        label: 'Branch circuits measured',
        type: 'table',
        minRows: 1,
        columns: [
          { id: 'circuit_no', label: 'Ckt #', type: 'text', required: true },
          { id: 'description', label: 'Description', type: 'text' },
          {
            id: 'leg', label: 'Leg', type: 'select', required: true,
            options: [
              { value: 'L1', label: 'L1' },
              { value: 'L2', label: 'L2' },
            ],
          },
          {
            id: 'measured_v', label: 'V at breaker', type: 'number', unit: 'V',
            required: true, min: 0, max: 300, step: 0.1,
          },
          { id: 'unstable', label: 'Jumps / sags ≥1 V', type: 'boolean' },
          {
            id: 'delta_v', label: 'Δ vs control', type: 'computed', unit: 'V',
            formula: 'branch_drop_delta', formulaInputs: ['D6.v_l1_n', 'measured_v'],
          },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'The voltage at each branch breaker, compared against the control reading taken at the service termination.',
      whyCodeCares:
        'The 3% and 5% drop figures in the NEC informational notes describe conductor runs. There is no conductor run inside a panel — from the main lugs to a breaker stab is inches, so a measurable drop there is a defect, not a design allowance.',
      whatWeFound:
        '{branch_rows} branch circuit(s) measured against the service control.',
      whyItMatters:
        'If the service reads 120 volts and a branch breaker reads 118, something in that path is degraded — a loose termination, a tired bus stab, a damaged conductor. Catching it here, as a two-volt difference, is how you find it before it becomes heat. {plain_result}.',
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
    phase: 2,
    group: 'branch-protection',
    appliesTo: ['interior_general'],
    repeatable: false,
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
    phase: 2,
    group: 'branch-protection',
    appliesTo: ['interior_general'],
    repeatable: false,
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
      '230.67 (required at the service from the 2020 NEC onward, min 10 kA, and on any service or panel replacement)',
    ],
    jurisdictionDependent: true,
    bannerListed: false,
    lifeSafetyClass: true,
    naAllowed: false,
    // Assessed per panel, not once per property: 230.67 covers the service, but
    // Red Cedar recommends an SPD at every panel and HVAC unit — the surge that
    // takes out a heat pump doesn't care which enclosure it came through.
    phase: 1,
    group: 'surge',
    appliesTo: ['service_exterior', 'panel'],
    repeatable: true,
    inputFields: [
      {
        id: 'spd_present',
        label: 'SPD present',
        type: 'select',
        required: true,
        options: [
          { value: 'type1', label: 'Type 1 (line side)', reportLabel: 'a Type 1 device on the line side' },
          { value: 'type2', label: 'Type 2 (load side)', reportLabel: 'a Type 2 device on the load side' },
          { value: 'type3', label: 'Type 3 (point of use)', reportLabel: 'a Type 3 point-of-use device' },
          { value: 'none', label: 'None', reportLabel: 'no surge protection' },
        ],
      },
      {
        id: 'spd_rating_ka', label: 'Surge rating', type: 'number', unit: 'kA', min: 0,
        requiredWhen: { fieldId: 'spd_present', equals: 'type2' },
        thresholds: [
          {
            when: { lt: 10 },
            verdict: 'BELOW_STANDARD',
            message: '230.67 sets 10 kA as the minimum where an SPD is required.',
          },
        ],
      },
      {
        id: 'spd_indicator',
        label: 'Status indicator',
        type: 'select',
        options: [
          { value: 'active', label: 'Green / active', reportLabel: 'showing active' },
          { value: 'fault', label: 'Fault / expired', reportLabel: 'showing a fault' },
          { value: 'none', label: 'No indicator', reportLabel: 'with no status indicator' },
        ],
        thresholds: [
          {
            when: { eq: 'fault' },
            verdict: 'FAIL',
            message: 'The device has already taken its hit — it is no longer protecting anything.',
          },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'Whether this panel has a surge-protective device, what it is rated for, and whether it is still alive.',
      whyCodeCares:
        '{spd_code_stance} It protects everything downstream — appliances and the safety devices themselves (AFCI, GFCI, smoke alarms).',
      whatWeFound: 'This panel has {spd_present}, {spd_indicator}, rated {spd_rating_ka} kA.',
      whyItMatters:
        'A single lightning or grid surge can destroy electronics and quietly degrade the safety devices meant to protect the house. A spent SPD is worse than none, because the indicator is the only thing that tells you. {spd_requirement_line}',
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
    phase: 2,
    group: 'devices',
    appliesTo: ['interior_general'],
    repeatable: false,
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
    phase: 2,
    group: 'devices',
    appliesTo: ['interior_general'],
    repeatable: false,
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
    phase: 2,
    group: 'devices',
    appliesTo: ['interior_general'],
    repeatable: false,
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
    phase: 2,
    group: 'equipment-disconnects',
    appliesTo: ['interior_general'],
    repeatable: false,
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
    phase: 1,
    group: 'equipment-disconnects',
    appliesTo: ['service_exterior'],
    repeatable: false,
    inputFields: [
      {
        id: 'hvac_disc_state',
        label: 'HVAC disconnect',
        type: 'select',
        required: true,
        options: [
          { value: 'within_sight', label: 'Within sight, serviceable', reportLabel: 'present and within sight' },
          { value: 'out_of_sight', label: 'Out of sight of the unit', reportLabel: 'out of sight of the unit' },
          { value: 'damaged', label: 'Present but damaged', reportLabel: 'present but damaged' },
          { value: 'absent', label: 'Absent', reportLabel: 'absent' },
        ],
        thresholds: [
          {
            when: { eq: 'absent' },
            verdict: 'FAIL',
            message: '440.14 requires a disconnect within sight of the equipment.',
          },
          {
            when: { eq: 'out_of_sight' },
            verdict: 'FAIL',
            message: 'Within sight means visible and within 50 ft (Article 100).',
          },
        ],
      },
      {
        id: 'hvac_spd',
        label: 'Surge protection at the unit',
        type: 'select',
        options: [
          { value: 'present', label: 'Present', reportLabel: 'protected' },
          { value: 'absent', label: 'Absent', reportLabel: 'unprotected' },
          { value: 'na', label: 'N/A', reportLabel: 'not applicable' },
        ],
        thresholds: [
          {
            when: { eq: 'absent' },
            // Never a FAIL — no code anywhere requires this. It's our recommendation.
            verdict: 'BELOW_STANDARD',
            message: "Red Cedar recommends surge protection at HVAC equipment. Not code-required.",
          },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'That HVAC equipment has a disconnect within sight of the unit, and whether the unit has surge protection.',
      whyCodeCares:
        '440.14 / 424.19 require a disconnect within sight so a service tech can safely de-energize before working. Surge protection at the unit is not code-required anywhere.',
      whatWeFound: 'HVAC disconnect {hvac_disc_state}; unit surge protection {hvac_spd}.',
      whyItMatters:
        'A tech who cannot see the disconnect from the equipment cannot know it stayed off. Separately, an inverter-driven compressor is the most surge-sensitive load in most houses and the most expensive to replace — which is why we recommend protecting it even though nothing requires it. {plain_result}.',
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
    phase: 1,
    group: 'panel-measurements',
    appliesTo: ['service_exterior', 'panel'],
    repeatable: true,
    measurementRequired: true,
    inputFields: [
      { id: 'leg_a', label: 'Leg A draw', type: 'number', unit: 'A', required: true, min: 0, step: 0.1 },
      { id: 'leg_b', label: 'Leg B draw', type: 'number', unit: 'A', required: true, min: 0, step: 0.1 },
      {
        id: 'imbalance_pct', label: 'Imbalance', type: 'computed', unit: '%',
        formula: 'leg_imbalance_pct', formulaInputs: ['leg_a', 'leg_b'],
      },
      {
        id: 'neutral_amps', label: 'Calculated neutral current', type: 'computed', unit: 'A',
        formula: 'neutral_current', formulaInputs: ['leg_a', 'leg_b'],
        helpText:
          'Calculated as |L1 − L2|, which holds for linear loads. Electronic loads add harmonic current this subtraction cannot see — clamp the neutral to confirm.',
      },
      {
        id: 'neutral_amps_measured', label: 'Measured neutral (clamp)', type: 'number', unit: 'A',
        min: 0, step: 0.1,
        helpText: 'Optional. A clamp reading well above the calculated figure indicates harmonic content.',
      },
    ],
    reasoning: {
      whatWeCheck:
        'How evenly the two legs of the panel carry the fixed loads — dryer, range, HVAC, water heater, disposal — and what that leaves on the neutral.',
      whyCodeCares:
        'Article 220 governs load distribution. Balanced legs keep the shared neutral quiet and voltage steady.',
      whatWeFound:
        'Leg A {leg_a} A, Leg B {leg_b} A ({imbalance_pct}% imbalance); calculated neutral current {neutral_amps} A.',
      whyItMatters:
        'A skewed panel pushes the difference onto the neutral and sags voltage under load. The neutral figure here is calculated from the two legs, not clamped — it is accurate for ordinary loads, but electronics add harmonic current it will not show. We balance to real measured usage. {plain_result}.',
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
    phase: 2,
    group: 'life-safety',
    appliesTo: ['interior_general'],
    repeatable: false,
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
    phase: 1,
    group: 'panel-condition',
    appliesTo: ['service_exterior', 'panel'],
    repeatable: true,
    measurementRequired: true,
    inputFields: [
      {
        id: 'install_year',
        label: 'Install year',
        type: 'number',
        required: true,
        min: 1900,
        max: 2100,
        helpText: 'From the label, the permit sticker, or the date code on the breakers.',
      },
      {
        id: 'age',
        label: 'Age',
        type: 'computed',
        unit: 'yr',
        formula: 'age_from_install_year',
        formulaInputs: ['install_year'],
        thresholds: [
          {
            when: { gte: 40 },
            verdict: 'MONITOR',
            message:
              'A decade past the ~30-year rated life. Plan the replacement rather than waiting for the failure to pick the date.',
          },
          {
            when: { gte: 30 },
            verdict: 'MONITOR',
            message: 'At or past the ~30-year rated life — worth budgeting for.',
          },
        ],
      },
      { id: 'make_model', label: 'Make / model', type: 'text', required: true },
      {
        id: 'condition',
        label: 'Condition',
        type: 'select',
        required: true,
        options: [
          { value: 'sound', label: 'Sound', reportLabel: 'sound' },
          { value: 'surface_rust', label: 'Surface rust', reportLabel: 'showing surface rust' },
          { value: 'corrosion', label: 'Active corrosion', reportLabel: 'actively corroding' },
          { value: 'heat', label: 'Heat damage', reportLabel: 'heat-damaged' },
          { value: 'water', label: 'Water intrusion', reportLabel: 'showing water intrusion' },
        ],
        thresholds: [
          {
            when: { eq: 'heat' },
            verdict: 'FAIL',
            message: '110.12(B) forbids equipment deteriorated by overheating.',
          },
          {
            when: { eq: 'corrosion' },
            verdict: 'FAIL',
            message: '110.12(B) forbids equipment deteriorated by corrosion.',
          },
          {
            when: { eq: 'water' },
            verdict: 'FAIL',
            message: 'Water in a panel corrodes the bus and the breaker stabs from the inside out.',
          },
          { when: { eq: 'surface_rust' }, verdict: 'MONITOR' },
        ],
      },
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
    phase: 2,
    group: 'metro-amendments',
    appliesTo: ['interior_general'],
    repeatable: false,
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
