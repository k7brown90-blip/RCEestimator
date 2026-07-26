import type { JurisdictionProfile } from '../domain/types'

// Jurisdiction profiles from the Blueprint's verified adoption table.
// Config point (spec §8): 2023-only citations (230.67, expanded 210.8/210.12) and
// Nashville Metro Ch. 16.20 are pending verification against primary sources — kept
// here as data with // VERIFY so they can be corrected without a code change.
// TN state amendment (applies to 2017 state-base jurisdictions): AFCI optional in
// baths, laundry, garages, unfinished basements; 110.24 marking optional.

export const jurisdictions: JurisdictionProfile[] = [
  {
    id: 'murfreesboro',
    label: 'Murfreesboro',
    necEdition: '2017',
    surgeRequired: false,
    metroAmendments: false,
    citationOverrides: {},
    requiredOverrides: {
      E3: 'optional', // 2017: SPD not required
    },
  },
  {
    id: 'brentwood',
    label: 'Brentwood',
    necEdition: '2017',
    surgeRequired: false,
    metroAmendments: false,
    citationOverrides: {},
    requiredOverrides: {
      E3: 'optional', // 2017: SPD not required
    },
  },
  {
    id: 'rutherford',
    label: 'Rutherford County (unincorporated)',
    necEdition: '2017',
    surgeRequired: false,
    metroAmendments: false,
    citationOverrides: {},
    requiredOverrides: {
      E3: 'optional', // 2017: SPD not required
    },
  },
  {
    id: 'franklin',
    label: 'Franklin',
    necEdition: '2023',
    surgeRequired: true,
    metroAmendments: false,
    citationOverrides: {
      E1: ['210.8 (2023 expanded scope) // VERIFY against 2023 NEC'],
      E2: ['210.12 (2023 broadened) // VERIFY against 2023 NEC'],
      E3: ['230.67 (min 10 kA; on service/panel replacement) // VERIFY against 2023 NEC'],
    },
    requiredOverrides: {
      E3: 'required',
    },
  },
  {
    id: 'nashville',
    label: 'Nashville / Davidson County',
    necEdition: '2023',
    surgeRequired: true,
    metroAmendments: true,
    citationOverrides: {
      E1: ['210.8 (2023 expanded scope) // VERIFY against 2023 NEC'],
      E2: ['210.12 (2023 broadened) // VERIFY against 2023 NEC'],
      E3: ['230.67 (min 10 kA; on service/panel replacement) // VERIFY against 2023 NEC'],
      I1: ['Metro Code Title 16, Ch. 16.20 // VERIFY — full amendment chapter not yet read'],
    },
    requiredOverrides: {
      E3: 'required',
    },
  },
]
