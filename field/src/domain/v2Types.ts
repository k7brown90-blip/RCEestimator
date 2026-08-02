/**
 * Protocol v2 capture types — the `v2` section of the inspection push.
 *
 * Mirrors the server's ingest schema (app/src/services/protocolV2Ingest.ts)
 * exactly: the server is the enforcement point, these types + domain/v2Rules
 * are the tech-facing mirror so a violation is caught while the panel is
 * still open, not at sync time.
 */

export type EnclosureType =
  | 'service_equipment'
  | 'main_disconnect'
  | 'main_panel'
  | 'subpanel'
  | 'equipment_disconnect'

export type DisconnectSubtype = 'breakered' | 'fused' | 'non_fused_switch' | 'pullout'

export interface V2Enclosure {
  locationKey: string
  enclosureType: EnclosureType
  disconnectSubtype?: DisconnectSubtype | null
  equipmentServed?: string | null
  locationDescription?: string | null
  distanceFromMainFt?: number | null
  labelTorqueValueObserved?: string | null
  labelLegible?: boolean | null
  busMaterial?: string | null
  serviceSideEnergized?: boolean
}

export type V2Classification = 'pass' | 'fail' | 'monitor' | 'upgrade'

export type MeasurementType =
  | 'voltage_unloaded'
  | 'voltage_loaded'
  | 'current'
  | 'source_impedance'
  | 'voltage_drop_pct'
  | 'torque'
  | 'thermal_delta_t'
  | 'thermal_absolute'
  | 'stab_thermal_delta_t'
  | 'grounding_resistance'
  | 'receptacle_tension'
  | 'circuit_current_at_reading'

export interface V2Measurement {
  measurementType: MeasurementType
  measuredValue: number
  unit: string
  referenceValueApplied?: number | null
  referenceSourceId?: string | null
  referenceMethod?: 'panel_label' | 'manufacturer_doc' | 'generic_fallback' | null
  comparativeReferenceItemId?: string | null
  comparativeLoadDeltaAmps?: number | null
  loadAmperageAtReading?: number | null
  ambientAtReadingC?: number | null
  methodStandard?: string | null
  methodConditionsMet?: boolean
  passed?: boolean | null
}

export interface V2BusVisual {
  corrosionLocation: 'stab_contact_patch' | 'bar_flat_non_contact' | 'bolted_joint' | 'neutral_bar' | 'ground_bar'
  corrosionProduct?: 'white_powdery' | 'green_blue' | 'black_brown' | 'red_rust' | null
  platingStatus: 'intact' | 'tarnished_intact' | 'breached_localized' | 'breached_at_contact' | 'absent'
  materialLoss: 'none' | 'surface_film' | 'light_pitting' | 'deep_pitting' | 'erosion_deformation'
  arcSignature: 'none' | 'spatter' | 'rounded_melted_edges' | 'material_transfer'
  adjacentPolymer: 'unaffected' | 'discolored' | 'browned_embrittled' | 'charred'
  heatTintMetal: 'none' | 'straw' | 'blue_purple'
}

export type ComponentType =
  | 'lug'
  | 'breaker'
  | 'bus_stab'
  | 'bus_joint'
  | 'bus_bar_section'
  | 'neutral_bar'
  | 'ground_bar'
  | 'receptacle'
  | 'switch'
  | 'fixture'
  | 'smoke_alarm'
  | 'co_alarm'
  | 'spd'
  | 'service_entrance'
  | 'weatherhead'
  | 'mast'
  | 'meter_base'

export interface V2Item {
  /** Client-side key so the list UI is stable; stripped before push. */
  clientId: string
  componentType: ComponentType
  locationKey?: string | null
  locationLabel?: string | null
  circuitNumber?: string | null
  busLeg?: string | null
  stabPosition?: number | null
  classification: V2Classification
  codeRequirementId?: string | null
  /**
   * §3.3 is per TERMINATION: true = this specific termination stays energized
   * (main/line lugs) — thermal + visual only, no torque. Branch breakers in
   * the same enclosure are load-side: switch off and torque normally. Null =
   * default by component type (line-side types in an energized service
   * enclosure are treated as energized).
   */
  serviceSideEnergized?: boolean | null
  techNote?: string | null
  customerVisible?: boolean
  measurements?: V2Measurement[]
  busVisual?: V2BusVisual | null
}

export interface V2GfciCoverage {
  locationDescriptor: string
  requiredAtInstall: boolean
  requiredCurrentCode: boolean
  protectionSource: 'none' | 'device' | 'upstream_device' | 'panel_breaker'
  functionTestResult?: 'pass' | 'fail' | 'not_tested' | null
  classification: V2Classification
}

export interface V2SamplingRecord {
  category: 'receptacle' | 'torque' | 'switch' | 'fixture'
  totalCount: number
  testedCount: number
  basis: string
  expandedDueToFail?: boolean
  untestedLocations?: string | null
}

export interface V2Capture {
  enclosures: V2Enclosure[]
  items: V2Item[]
  gfciCoverage: V2GfciCoverage[]
  samplingRecords: V2SamplingRecord[]
}

export const emptyV2Capture = (): V2Capture => ({
  enclosures: [],
  items: [],
  gfciCoverage: [],
  samplingRecords: [],
})

/** Strip client-only fields for the push payload. */
export function toPushV2(capture: V2Capture): object {
  return {
    enclosures: capture.enclosures,
    items: capture.items.map(({ clientId: _clientId, ...item }) => item),
    gfciCoverage: capture.gfciCoverage,
    samplingRecords: capture.samplingRecords,
  }
}
