import type { ChecklistItemDef } from '../domain/types'

/**
 * The consolidated assessment walk (Kyle, 2026-08-26: "I need the check to be
 * organized like this exactly… I want this consolidated because right now there
 * is a lot of duplicate information that is disorganized.")
 *
 * Nine rows, in Kyle's order, each one place on site. The old 23-item A1…I1
 * checklist folded into these — what didn't fit was cut on his word ("fold what
 * fits and cut the rest"). The old ids live on in domain/compat.ts
 * RETIRED_ITEM_TITLES so historical records still name what they assessed.
 *
 * "Interior Panel / Sub-Panel" is repeatable: the app clones its def per added
 * sub-panel (id `SUB:<slug>`, ItemResult.locationId carries the location name).
 *
 * bannerListed mirrors the explicit list in src/data/criticalItems.ts.
 */
/** Stable slug for a sub-panel location label — the instance id and ledger key. */
export function subPanelSlug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
}

/**
 * Clone the SUB def for one added sub-panel ("Add Sub-Panel Option available if
 * there are more that one sub panel" — Kyle, 2026-08-26). The id embeds the
 * location slug so the ledger keys stay stable across visits to the same
 * address; ItemResult.locationId carries the display label to the report.
 */
export function subPanelInstanceDef(label: string): ChecklistItemDef {
  const base = checklist.find((item) => item.id === 'SUB')
  if (!base) throw new Error('SUB item missing from checklist')
  return { ...base, id: `SUB:${subPanelSlug(label)}`, title: `Interior Panel / Sub-Panel — ${label.trim()}` }
}

export const checklist: ChecklistItemDef[] = [
  {
    id: 'LOAD',
    section: 'Assessment',
    title: 'Calculated Load',
    citations: ['NEC 220.82', 'NEC 230.42'],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    phase: 1,
    group: 'LOAD',
    appliesTo: ['service_exterior'],
    repeatable: false,
    inputFields: [
      {
        id: 'service_amps',
        label: 'Service rating',
        type: 'number',
        unit: 'A',
        min: 30,
        max: 800,
        required: true,
        helpText: 'Read from the main breaker or disconnect, not from the meter base.',
      },
      {
        id: 'calc_load',
        label: 'Calculated demand (NEC 220)',
        type: 'number',
        unit: 'A',
        min: 0,
        helpText: 'Filled by the load calculator below.',
        thresholds: [
          { when: { gt: 0 }, verdict: 'PASS' },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'The start with every customer: an NEC Article 220 load calculation for the home against the service rating, so every recommendation that follows is grounded in what the service can actually carry.',
      whyCodeCares:
        'NEC 230.42 requires the service to carry the calculated load. An overloaded service runs hot at the very equipment that feeds everything else.',
      whatWeFound:
        'Calculated demand {calc_load} A on a {service_amps} A service.',
      whyItMatters:
        'This number decides whether the home can take an EV charger, a hot tub, or a heat-pump conversion without a service upgrade — and whether anything already installed is pushing the service past its rating.',
    },
  },
  {
    id: 'METER',
    section: 'Assessment',
    title: 'Meter & Service Mast',
    citations: ['NEC 230.28', 'NEC 110.12(B)', 'NEC 344.30'],
    jurisdictionDependent: false,
    bannerListed: true, // supply-side damage sits ahead of every breaker in the house
    lifeSafetyClass: false,
    naAllowed: false,
    phase: 1,
    group: 'METER',
    appliesTo: ['service_exterior'],
    repeatable: false,
    inputFields: [
      {
        id: 'mast_cond',
        label: 'Mast & attachment',
        type: 'select',
        options: [
          { value: 'secure', label: 'Secure & straight', reportLabel: 'secure and straight' },
          { value: 'pulling', label: 'Pulling / leaning', reportLabel: 'pulling away or leaning' },
          { value: 'damaged', label: 'Damaged', reportLabel: 'damaged' },
        ],
      },
      {
        id: 'weatherhead',
        label: 'Weatherhead & seal',
        type: 'select',
        options: [
          { value: 'intact', label: 'Intact', reportLabel: 'intact' },
          { value: 'degraded', label: 'Degraded', reportLabel: 'degraded' },
          { value: 'open', label: 'Open / missing', reportLabel: 'open or missing' },
        ],
        helpText: 'A failed weatherhead lets water track down the service conductors into the meter base.',
      },
      {
        id: 'meter_ext_cond',
        label: 'Meter base exterior',
        type: 'select',
        options: [
          { value: 'clean', label: 'Clean & tight', reportLabel: 'clean and tight' },
          { value: 'rust_minor', label: 'Surface rust', reportLabel: 'showing surface rust' },
          { value: 'corrosion_active', label: 'Active corrosion', reportLabel: 'showing active corrosion' },
          { value: 'heat_marks', label: 'Heat marks', reportLabel: 'showing heat marks' },
          { value: 'loose', label: 'Loose from wall', reportLabel: 'loose from the wall' },
        ],
        helpText: 'Exterior only — we never open the meter socket; that is the utility’s equipment.',
      },
      {
        id: 'utility_referral',
        label: 'Refer to utility',
        type: 'boolean',
        helpText: 'Anything on the utility side of the meter that warrants their attention.',
      },
    ],
    reasoning: {
      whatWeCheck:
        'The service mast, weatherhead, and meter base exterior — rust, corrosion, heat marks, secure mounting, weather sealing. We do not open the meter socket; that is the utility’s equipment.',
      whyCodeCares:
        'Everything here sits ahead of every breaker in the house (NEC 230.28, 110.12(B)). Damage on the supply side has no overcurrent protection between it and the transformer.',
      whatWeFound:
        'Mast {mast_cond}; weatherhead {weatherhead}; meter base exterior {meter_ext_cond}.',
      whyItMatters:
        'Corrosion or a failing connection at the service entrance affects every circuit in the home, and a fault here cannot be cleared by any breaker you own.',
    },
  },
  {
    id: 'MAIN',
    section: 'Assessment',
    title: 'Main Panel / Main Disconnect',
    citations: ['NEC 110.12', 'NEC 110.14', 'NEC 240.4(D)', 'NEC 408.4', 'NEC 110.3(B)'],
    jurisdictionDependent: false,
    bannerListed: true, // hazard panels, defeated overcurrent protection
    lifeSafetyClass: false,
    naAllowed: false,
    phase: 1,
    group: 'MAIN',
    appliesTo: ['panel'],
    repeatable: false,
    inputFields: [
      {
        id: 'panel_cond',
        label: 'Enclosure condition',
        type: 'select',
        options: [
          { value: 'clean', label: 'Clean', reportLabel: 'clean and dry' },
          { value: 'rust_minor', label: 'Surface rust', reportLabel: 'showing surface rust' },
          { value: 'corrosion_active', label: 'Active corrosion', reportLabel: 'showing active corrosion' },
          { value: 'water_evidence', label: 'Water intrusion', reportLabel: 'showing evidence of water intrusion' },
          { value: 'damage', label: 'Physical damage', reportLabel: 'physically damaged' },
        ],
      },
      {
        id: 'hazard_panel',
        label: 'Known-hazard brand',
        type: 'select',
        options: [
          { value: 'none', label: 'None', reportLabel: 'not a known-hazard brand' },
          { value: 'fpe', label: 'FPE Stab-Lok', reportLabel: 'a Federal Pacific Stab-Lok — a documented failure-to-trip hazard' },
          { value: 'zinsco', label: 'Zinsco', reportLabel: 'a Zinsco — a documented failure-to-trip hazard' },
          { value: 'pushmatic', label: 'Pushmatic', reportLabel: 'a Pushmatic — obsolete with no replacement parts' },
          { value: 'other', label: 'Other concern', reportLabel: 'a brand with documented concerns' },
        ],
      },
      {
        id: 'breaker_fit',
        label: 'Breaker fit / listing',
        type: 'select',
        options: [
          { value: 'listed', label: 'All listed for panel', reportLabel: 'all listed for this panel' },
          { value: 'unlisted_present', label: 'Unlisted breakers found', reportLabel: 'includes breakers not listed for this panel' },
        ],
        helpText: 'NEC 110.3(B) — a breaker not listed for the panel may not trip when it must.',
      },
      {
        id: 'wire_size_mismatch',
        label: 'Breaker/wire size mismatches',
        type: 'number',
        min: 0,
        helpText: 'Breakers oversized for the conductor they protect (240.4). 0 when all match.',
        thresholds: [
          { when: { gte: 1 }, verdict: 'FAIL', message: 'An oversized breaker lets a wire overheat before it ever trips.' },
        ],
      },
      {
        id: 'double_tap_count',
        label: 'Double-tapped breakers',
        type: 'number',
        min: 0,
        thresholds: [
          { when: { gte: 1 }, verdict: 'FAIL', message: 'Two conductors under a lug listed for one is a loose connection waiting to happen.' },
        ],
      },
      {
        id: 'terminations',
        label: 'Terminations (torque / thermal)',
        type: 'select',
        options: [
          { value: 'verified', label: 'Checked — tight & cool', reportLabel: 'checked and found tight, with no heat signature' },
          { value: 'loose_found', label: 'Loose found', reportLabel: 'found loose at one or more lugs' },
          { value: 'overheating', label: 'Overheating found', reportLabel: 'found overheating at one or more lugs' },
        ],
        helpText: 'Loose connections run hot, and heat is how electrical fires start.',
      },
      {
        id: 'openings',
        label: 'Unlawful openings',
        type: 'select',
        options: [
          { value: 'none', label: 'None — closed up', reportLabel: 'fully closed' },
          { value: 'missing_blanks', label: 'Missing blanks/KOs', reportLabel: 'with open knockouts or missing blank fillers' },
        ],
        helpText: 'NEC 110.12(A) — every opening exposes live parts.',
      },
      {
        id: 'disc_marking',
        label: 'Main disconnect marked & reachable',
        type: 'select',
        options: [
          { value: 'ok', label: 'Marked & accessible', reportLabel: 'clearly marked and accessible' },
          { value: 'unmarked', label: 'Unmarked', reportLabel: 'not marked as the service disconnect' },
          { value: 'blocked', label: 'Blocked', reportLabel: 'blocked or hard to reach' },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'The main panel and main disconnect as one piece of equipment: rust and corrosion, known-hazard brands, breaker-to-wire sizing, lawful terminations, double-taps, openings, and whether the disconnect is marked and reachable.',
      whyCodeCares:
        'This is where every circuit is protected — or isn’t. Oversized breakers (240.4), unlisted breakers (110.3(B)), loose terminations (110.14), and open enclosures (110.12) are each a documented fire or shock path.',
      whatWeFound:
        'Enclosure {panel_cond}; {hazard_panel}; breakers {breaker_fit}; {wire_size_mismatch} size mismatch(es); {double_tap_count} double-tap(s); terminations {terminations}; enclosure {openings}.',
      whyItMatters:
        'The panel is the home’s safety net. A breaker that cannot trip, a wire protected by the wrong size breaker, or a connection running hot defeats the protection everything else depends on.',
    },
  },
  {
    id: 'SUB',
    section: 'Assessment',
    title: 'Interior Panel / Sub-Panel',
    citations: ['NEC 110.12', 'NEC 110.14', 'NEC 240.4(D)', 'NEC 408.4', 'NEC 250.32', 'NEC 408.40'],
    jurisdictionDependent: false,
    bannerListed: true, // neutral-ground bond error energizes every metal part downstream
    lifeSafetyClass: false,
    naAllowed: true, // many homes have no sub-panel — an explicit "none here" is a real answer
    phase: 1,
    group: 'SUB',
    appliesTo: ['panel'],
    repeatable: true,
    inputFields: [
      {
        id: 'feeds',
        label: 'What this panel feeds',
        type: 'text',
        placeholder: 'e.g. garage, HVAC, upstairs',
      },
      {
        id: 'panel_cond',
        label: 'Enclosure condition',
        type: 'select',
        options: [
          { value: 'clean', label: 'Clean', reportLabel: 'clean and dry' },
          { value: 'rust_minor', label: 'Surface rust', reportLabel: 'showing surface rust' },
          { value: 'corrosion_active', label: 'Active corrosion', reportLabel: 'showing active corrosion' },
          { value: 'water_evidence', label: 'Water intrusion', reportLabel: 'showing evidence of water intrusion' },
          { value: 'damage', label: 'Physical damage', reportLabel: 'physically damaged' },
        ],
      },
      {
        id: 'hazard_panel',
        label: 'Known-hazard brand',
        type: 'select',
        options: [
          { value: 'none', label: 'None', reportLabel: 'not a known-hazard brand' },
          { value: 'fpe', label: 'FPE Stab-Lok', reportLabel: 'a Federal Pacific Stab-Lok — a documented failure-to-trip hazard' },
          { value: 'zinsco', label: 'Zinsco', reportLabel: 'a Zinsco — a documented failure-to-trip hazard' },
          { value: 'pushmatic', label: 'Pushmatic', reportLabel: 'a Pushmatic — obsolete with no replacement parts' },
          { value: 'other', label: 'Other concern', reportLabel: 'a brand with documented concerns' },
        ],
      },
      {
        id: 'neutral_ground',
        label: 'Neutral–ground separation',
        type: 'select',
        options: [
          { value: 'separated', label: 'Properly separated', reportLabel: 'properly separated' },
          { value: 'bonded_error', label: 'Bonded here (error)', reportLabel: 'improperly bonded at this panel' },
        ],
        helpText: 'Neutral and ground must be kept apart downstream of the service (250.32) — bonded here, normal current flows on metal parts.',
      },
      {
        id: 'breaker_fit',
        label: 'Breaker fit / listing',
        type: 'select',
        options: [
          { value: 'listed', label: 'All listed for panel', reportLabel: 'all listed for this panel' },
          { value: 'unlisted_present', label: 'Unlisted breakers found', reportLabel: 'includes breakers not listed for this panel' },
        ],
      },
      {
        id: 'wire_size_mismatch',
        label: 'Breaker/wire size mismatches',
        type: 'number',
        min: 0,
        thresholds: [
          { when: { gte: 1 }, verdict: 'FAIL', message: 'An oversized breaker lets a wire overheat before it ever trips.' },
        ],
      },
      {
        id: 'double_tap_count',
        label: 'Double-tapped breakers',
        type: 'number',
        min: 0,
        thresholds: [
          { when: { gte: 1 }, verdict: 'FAIL', message: 'Two conductors under a lug listed for one is a loose connection waiting to happen.' },
        ],
      },
      {
        id: 'terminations',
        label: 'Terminations (torque / thermal)',
        type: 'select',
        options: [
          { value: 'verified', label: 'Checked — tight & cool', reportLabel: 'checked and found tight, with no heat signature' },
          { value: 'loose_found', label: 'Loose found', reportLabel: 'found loose at one or more lugs' },
          { value: 'overheating', label: 'Overheating found', reportLabel: 'found overheating at one or more lugs' },
        ],
      },
      {
        id: 'openings',
        label: 'Unlawful openings',
        type: 'select',
        options: [
          { value: 'none', label: 'None — closed up', reportLabel: 'fully closed' },
          { value: 'missing_blanks', label: 'Missing blanks/KOs', reportLabel: 'with open knockouts or missing blank fillers' },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'Each interior panel and sub-panel gets the same examination as the main: rust and corrosion, hazard brands, breaker-to-wire sizing, lawful terminations and openings — plus neutral-ground separation, which only applies downstream of the service.',
      whyCodeCares:
        'A sub-panel with neutral bonded to ground (250.32) puts normal circuit current on every metal surface it feeds. Everything else that applies to the main panel applies here too.',
      whatWeFound:
        'Enclosure {panel_cond}; {hazard_panel}; neutral/ground {neutral_ground}; breakers {breaker_fit}; {wire_size_mismatch} size mismatch(es); {double_tap_count} double-tap(s); terminations {terminations}; enclosure {openings}.',
      whyItMatters:
        'Sub-panels are out of sight and rarely opened — problems here go unnoticed for decades while feeding bedrooms, garages, and outbuildings.',
    },
  },
  {
    id: 'GES',
    section: 'Assessment',
    title: 'Grounding Electrode System',
    citations: ['NEC 250.50', 'NEC 250.53(A)(2)', 'NEC 250.66', 'NEC 250.28', 'NEC 250.104', 'NEC 250.94'],
    jurisdictionDependent: false,
    bannerListed: true, // the fault-clearing backbone for the whole home
    lifeSafetyClass: false,
    naAllowed: false,
    phase: 1,
    group: 'GES',
    appliesTo: ['service_exterior'],
    repeatable: false,
    inputFields: [
      {
        id: 'electrode_types',
        label: 'Electrodes present',
        type: 'multiselect',
        options: [
          { value: 'rods', label: 'Ground rod(s)', reportLabel: 'ground rod(s)' },
          { value: 'ufer', label: 'Concrete-encased (Ufer)', reportLabel: 'a concrete-encased electrode' },
          { value: 'water_pipe', label: 'Metal water pipe', reportLabel: 'the metal water pipe' },
          { value: 'plate_ring', label: 'Plate / ring', reportLabel: 'a plate or ring electrode' },
          { value: 'none_found', label: 'None found', reportLabel: 'no electrode found' },
        ],
      },
      {
        id: 'ground_ohms',
        label: 'Resistance to earth',
        type: 'number',
        unit: 'Ω',
        min: 0,
        thresholds: [
          { when: { lte: 25 }, verdict: 'PASS' },
          { when: { gt: 25 }, verdict: 'MONITOR', message: 'Over 25 Ω a single rod needs a supplemental electrode (250.53(A)(2)).' },
        ],
      },
      {
        id: 'gec_cond',
        label: 'GEC size, connection & protection',
        type: 'select',
        options: [
          { value: 'ok', label: 'Sized, tight, protected', reportLabel: 'properly sized, connected, and protected' },
          { value: 'undersized', label: 'Undersized', reportLabel: 'undersized for this service' },
          { value: 'loose_damaged', label: 'Loose / damaged', reportLabel: 'loose or damaged' },
          { value: 'missing', label: 'Missing', reportLabel: 'missing' },
        ],
      },
      {
        id: 'mbj_state',
        label: 'Main bonding jumper & EGC bonding',
        type: 'select',
        options: [
          { value: 'correct', label: 'Correct at service', reportLabel: 'correct at the service' },
          { value: 'incorrect', label: 'Incorrect / missing', reportLabel: 'incorrect or missing' },
        ],
        helpText: 'The bond that makes breakers trip on a fault (250.28). Without it, faults can go undetected.',
      },
      {
        id: 'water_bond',
        label: 'Water pipe bond',
        type: 'select',
        options: [
          { value: 'bonded', label: 'Bonded', reportLabel: 'bonded' },
          { value: 'not_bonded', label: 'Not bonded', reportLabel: 'not bonded' },
          { value: 'no_metal_pipe', label: 'No metal pipe', reportLabel: 'not applicable — no metal water pipe' },
        ],
      },
      {
        id: 'gas_bond',
        label: 'Gas pipe (CSST) bond',
        type: 'select',
        options: [
          { value: 'bonded', label: 'Bonded', reportLabel: 'bonded' },
          { value: 'not_bonded', label: 'Not bonded', reportLabel: 'not bonded' },
          { value: 'no_gas', label: 'No gas service', reportLabel: 'not applicable — no gas service' },
        ],
      },
      {
        id: 'isbt_state',
        label: 'Intersystem bonding kit',
        type: 'select',
        options: [
          { value: 'present', label: 'Present & used', reportLabel: 'present and in use' },
          { value: 'present_unused', label: 'Present, unused', reportLabel: 'present but unused' },
          { value: 'missing', label: 'Missing', reportLabel: 'missing' },
        ],
        helpText: 'Where TV, internet, and phone grounds tie to the house ground (250.94) — protects electronics during surges and lightning.',
      },
    ],
    reasoning: {
      whatWeCheck:
        'The whole grounding and bonding system in one look: electrodes and their resistance, the grounding electrode conductor, the main bonding jumper and equipment grounds, water and gas pipe bonding, and the intersystem bonding kit.',
      whyCodeCares:
        'Grounding is the backbone of shock protection (Article 250). Every bond here is what lets a breaker see a fault and trip — and what keeps metal pipes and communication lines from becoming energized.',
      whatWeFound:
        'Electrodes: {electrode_types}. GEC {gec_cond}; main bonding {mbj_state}; water pipe {water_bond}; gas pipe {gas_bond}; intersystem bonding {isbt_state}.',
      whyItMatters:
        'A grounding defect is invisible in daily life — everything works right up until a fault, and that is the one moment it must not fail.',
    },
  },
  {
    id: 'SPD',
    section: 'Assessment',
    title: 'Surge Protection',
    citations: ['NEC 230.67'],
    jurisdictionDependent: true,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: true,
    phase: 1,
    group: 'SPD',
    appliesTo: ['panel'],
    repeatable: false,
    inputFields: [
      {
        id: 'spd_present',
        label: 'SPD at the service',
        type: 'select',
        options: [
          { value: 'present', label: 'Installed', reportLabel: 'installed' },
          { value: 'absent', label: 'None', reportLabel: 'not installed' },
        ],
      },
      {
        id: 'spd_rating_ka',
        label: 'Surge rating',
        type: 'number',
        unit: 'kA',
        min: 0,
        requiredWhen: { fieldId: 'spd_present', equals: 'present' },
      },
      {
        id: 'spd_indicator',
        label: 'Status indicator',
        type: 'select',
        options: [
          { value: 'green', label: 'Protected', reportLabel: 'indicating protected' },
          { value: 'end_of_life', label: 'End of life', reportLabel: 'indicating end of life' },
          { value: 'none', label: 'No indicator', reportLabel: 'with no status indicator' },
        ],
        requiredWhen: { fieldId: 'spd_present', equals: 'present' },
      },
    ],
    reasoning: {
      whatWeCheck:
        'Whole-home surge protection at the panel — present, rated, and still alive (they sacrifice themselves over time).',
      whyCodeCares:
        '{spd_code_stance}',
      whatWeFound:
        'Surge protective device {spd_present}.',
      whyItMatters:
        'Everything in a modern home has a circuit board in it. One nearby lightning strike or utility switching event can take out thousands of dollars of appliances and electronics at once.',
    },
  },
  {
    id: 'HVAC',
    section: 'Assessment',
    title: 'A/C & Heating Disconnects',
    citations: ['NEC 440.14', 'NEC 110.14', 'NEC 440.4(B)'],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: true,
    phase: 1,
    group: 'HVAC',
    appliesTo: ['service_exterior', 'interior_general'],
    repeatable: false,
    inputFields: [
      {
        id: 'disc_state',
        label: 'Disconnect present & in sight',
        type: 'select',
        options: [
          { value: 'ok', label: 'Present, in sight', reportLabel: 'present and within sight of the unit' },
          { value: 'not_in_sight', label: 'Not within sight', reportLabel: 'not within sight of the unit' },
          { value: 'missing', label: 'Missing', reportLabel: 'missing' },
        ],
      },
      {
        id: 'disc_cond',
        label: 'Condition (rust / heat)',
        type: 'select',
        options: [
          { value: 'clean', label: 'Clean & cool', reportLabel: 'clean, with no heat signature' },
          { value: 'rust_corrosion', label: 'Rust / corrosion', reportLabel: 'showing rust or corrosion' },
          { value: 'overheating', label: 'Overheating signs', reportLabel: 'showing signs of overheating' },
        ],
      },
      {
        id: 'breaker_wire_cond',
        label: 'Breaker / wire size & condition',
        type: 'select',
        options: [
          { value: 'matched', label: 'Matched to nameplate', reportLabel: 'matched to the equipment nameplate' },
          { value: 'mismatched', label: 'Mismatched', reportLabel: 'mismatched against the equipment nameplate' },
          { value: 'damaged', label: 'Damaged conductors', reportLabel: 'with damaged conductors' },
        ],
        helpText: 'Check against the unit nameplate (440.4(B)) — HVAC has its own sizing rules.',
      },
    ],
    reasoning: {
      whatWeCheck:
        'The safety disconnects at the heating and cooling equipment — rust, corrosion, overheating, and breaker/wire size against the equipment nameplate.',
      whyCodeCares:
        'NEC 440.14 requires a disconnect within sight of each unit so nobody services a condenser that someone else can re-energize.',
      whatWeFound:
        'Disconnect {disc_state}, {disc_cond}; supply {breaker_wire_cond}.',
      whyItMatters:
        'These sit outdoors in the weather, carry the largest motor loads in the house, and are touched only when something breaks — corrosion here shows up as a failed compressor or a burned disconnect.',
    },
  },
  {
    id: 'WH',
    section: 'Assessment',
    title: 'Water Heater',
    citations: ['NEC 422.31(B)', 'NEC 334.15(B)'],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: true,
    phase: 1,
    group: 'WH',
    appliesTo: ['interior_general'],
    repeatable: false,
    inputFields: [
      {
        id: 'disc_means',
        label: 'Disconnecting means',
        type: 'select',
        options: [
          { value: 'local_disconnect', label: 'Local disconnect', reportLabel: 'a local disconnect at the unit' },
          { value: 'breaker_lockout', label: 'Breaker lockout', reportLabel: 'a lockable breaker at the panel' },
          { value: 'none', label: 'None', reportLabel: 'no disconnecting means or lockout' },
        ],
        helpText: '422.31(B): a disconnect at the unit, or a breaker with a lockout, so it can be serviced safely.',
      },
      {
        id: 'wiring_protected',
        label: 'Wiring protected from damage',
        type: 'select',
        options: [
          { value: 'protected', label: 'Protected', reportLabel: 'protected from physical damage' },
          { value: 'exposed', label: 'Exposed to damage', reportLabel: 'exposed to physical damage' },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'The water heater’s disconnecting means — a local disconnect or a breaker lockout — and whether its wiring is protected from physical damage.',
      whyCodeCares:
        'NEC 422.31(B) requires a way to lock the power off before anyone puts hands in a 240-volt appliance full of water.',
      whatWeFound:
        'Disconnecting means: {disc_means}; wiring {wiring_protected}.',
      whyItMatters:
        'Water heaters get serviced by plumbers who trust the breaker is off. Without a lockout, someone can flip it back on with hands inside the unit.',
    },
  },
  {
    id: 'WIRE',
    section: 'Assessment',
    title: 'General Wiring',
    citations: ['NEC 210.8', 'NEC 210.12', 'NEC 406.4(D)', 'NEC 110.12(A)', 'NFPA 72 14.4.7', 'NEC 110.14'],
    jurisdictionDependent: true,
    bannerListed: true, // dead GFCI in a wet area / no working smoke alarms are life-safety
    lifeSafetyClass: true,
    naAllowed: false,
    phase: 1,
    group: 'WIRE',
    appliesTo: ['interior_general'],
    repeatable: false,
    inputFields: [
      {
        id: 'gfci_test',
        label: 'GFCI devices (tested)',
        type: 'select',
        options: [
          { value: 'all_pass', label: 'All tested pass', reportLabel: 'all tested devices tripped and reset properly' },
          { value: 'some_fail', label: 'Failures found', reportLabel: 'one or more devices failed the test' },
          { value: 'missing_required', label: 'Missing where required', reportLabel: 'absent in locations where required' },
        ],
        helpText: 'Push-button test in kitchens, baths, garage, exterior. A GFCI that will not trip is shock protection that does not exist.',
      },
      {
        id: 'afci_test',
        label: 'AFCI devices (tested)',
        type: 'select',
        options: [
          { value: 'all_pass', label: 'All tested pass', reportLabel: 'all tested devices tripped and reset properly' },
          { value: 'some_fail', label: 'Failures found', reportLabel: 'one or more devices failed the test' },
          { value: 'missing_required', label: 'Missing where required', reportLabel: 'absent in locations where required' },
          { value: 'none_installed', label: 'None installed (older home)', reportLabel: 'not installed — common in homes wired before AFCI requirements' },
        ],
      },
      {
        id: 'recep_tension',
        label: 'Receptacle tension / condition',
        type: 'select',
        options: [
          { value: 'good', label: 'Good grip throughout', reportLabel: 'holding plugs firmly throughout the sampled rooms' },
          { value: 'loose_found', label: 'Loose/worn found', reportLabel: 'worn loose at one or more locations' },
          { value: 'damaged_found', label: 'Damaged found', reportLabel: 'damaged at one or more locations' },
        ],
        helpText: 'A worn receptacle grips loosely — loose blades arc, and arcing is heat.',
      },
      {
        id: 'missing_plates',
        label: 'Missing plates (switches/receptacles)',
        type: 'number',
        min: 0,
        thresholds: [
          { when: { gte: 1 }, verdict: 'MONITOR', message: 'Every missing plate is exposed live parts at hand height (406.6).' },
        ],
      },
      {
        id: 'smoke_detectors',
        label: 'Smoke / CO alarms',
        type: 'select',
        options: [
          { value: 'present_working', label: 'Present & working', reportLabel: 'present and responding to test' },
          { value: 'expired', label: 'Past 10-year life', reportLabel: 'past their 10-year replacement date' },
          { value: 'not_working', label: 'Dead / disabled', reportLabel: 'dead or disabled' },
          { value: 'missing', label: 'Missing locations', reportLabel: 'missing from required locations' },
        ],
        helpText: 'The ten-year replacement rule matters more than most people know (NFPA 72).',
      },
      {
        id: 'aluminum',
        label: 'Aluminum branch wiring',
        type: 'select',
        options: [
          { value: 'none', label: 'None found', reportLabel: 'not present on branch circuits' },
          { value: 'present_mitigated', label: 'Present, proper terminations', reportLabel: 'present with proper AL-rated terminations' },
          { value: 'present_unmitigated', label: 'Present, unmitigated', reportLabel: 'present without AL-rated terminations — a documented fire hazard' },
        ],
      },
    ],
    reasoning: {
      whatWeCheck:
        'The wiring the family touches every day: GFCI and AFCI devices actually tested, receptacle grip and condition, missing plates, smoke and CO alarms, and aluminum branch wiring.',
      whyCodeCares:
        'GFCI (210.8) is shock protection, AFCI (210.12) is fire protection, and alarms (NFPA 72) are the last line when either fails. {edition_note}',
      whatWeFound:
        'GFCI: {gfci_test}. AFCI: {afci_test}. Receptacles {recep_tension}; {missing_plates} missing plate(s). Smoke/CO alarms {smoke_detectors}. Aluminum wiring {aluminum}.',
      whyItMatters:
        'These are the devices between an everyday accident and an injury — a dead GFCI or a disabled smoke alarm looks fine on the wall right up until the day it was needed.',
    },
  },
]
