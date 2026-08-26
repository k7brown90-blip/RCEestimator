/**
 * The homeowner's dictionary for the assessment checklist. (Kyle, 2026-08-25:
 * "We need this updated to laymens terms so it is easily understood by people
 * that have zero experience or knowledge of electrical.")
 *
 * One entry per checklist item, in words a customer with zero electrical
 * knowledge recognizes. `name` is what the report calls the item; `plain` is
 * the one-sentence "what this is and why you'd care." The field app keeps its
 * technical titles — this file translates only the CUSTOMER artifact, and it
 * lives in shared/ so the server that prints the report and the app that
 * captures the data can never disagree about what A3 means.
 */

export interface ItemText {
  name: string;
  plain: string;
}

export const CHECKLIST_TEXT: Record<string, ItemText> = {
  A1: {
    name: "Overhead service wires & mast",
    plain: "The wires bringing power from the street to your home, and the pipe and anchors that hold them — checked for damage, sag, and safe clearance.",
  },
  A2: {
    name: "Service size vs. your home's needs",
    plain: "Whether the electrical service feeding the home is big enough for everything the home runs, with a code-based load calculation.",
  },
  A3: {
    name: "Meter base & main disconnect",
    plain: "The equipment where power enters your home. Corrosion or damage here affects every circuit in the house.",
  },
  B1: {
    name: "Main shut-off — location & labeling",
    plain: "The switch that can turn the whole house off in an emergency — it has to exist, be reachable, and be clearly marked.",
  },
  B2: {
    name: "Clear space around the panel",
    plain: "The working room in front of your electrical panel — required so it can be worked on and shut off safely.",
  },
  C1: {
    name: "Grounding rods & connections",
    plain: "The system that gives electricity a safe path into the earth — the backbone of shock protection for the whole home.",
  },
  C4: {
    name: "Main grounding connections at the panel",
    plain: "The bonds inside your main panel that make breakers trip when something goes wrong. If these are off, faults can go undetected.",
  },
  C5: {
    name: "Subpanel wiring separation",
    plain: "A safety rule for secondary panels: neutral and ground must be kept apart there, or metal parts can become energized.",
  },
  C6: {
    name: "Water & gas pipe bonding",
    plain: "Metal pipes must be connected to the electrical grounding system so they can never become electrified.",
  },
  C7: {
    name: "Cable/phone/internet grounding point",
    plain: "The connection point that keeps TV, internet, and phone lines tied to the same ground as the house — protects electronics during surges and lightning.",
  },
  D1: {
    name: "Connection tightness & heat scan",
    plain: "Every connection checked with a torque tool and a thermal camera — loose connections run hot, and heat is how electrical fires start.",
  },
  D2: {
    name: "Breaker-to-wire matching",
    plain: "Each breaker checked against the size of the wire it protects. An oversized breaker lets a wire overheat before it ever trips.",
  },
  D3: {
    name: "Electrical panel condition & breaker fit",
    plain: "The panel itself and whether its breakers belong in it — including known-hazard panel brands and signs of damage or corrosion inside.",
  },
  D4: {
    name: "Circuit labeling",
    plain: "Whether the panel's directory actually matches what each breaker controls — verified, not just copied.",
  },
  D5: {
    name: "Aluminum branch wiring",
    plain: "Checking for older aluminum wiring on everyday circuits, which needs special terminations to be safe.",
  },
  D6: {
    name: "Incoming voltage reading",
    plain: "The voltage arriving from the utility, measured at the main — the baseline every other reading is compared against.",
  },
  D7: {
    name: "Circuit voltage readings",
    plain: "Voltage measured at the breakers to catch problems the eye can't see.",
  },
  E1: {
    name: "Shock protection (GFCI)",
    plain: "The fast-trip outlets and breakers that protect people from shock in kitchens, bathrooms, garages, and outdoors.",
  },
  E2: {
    name: "Fire protection (AFCI)",
    plain: "Breakers that detect dangerous arcing in the walls — the kind of fault that starts fires — and shut it down.",
  },
  E3: {
    name: "Whole-home surge protection",
    plain: "A device at the panel that protects your appliances and electronics from power surges and nearby lightning.",
  },
  F1: {
    name: "Outlets — placement & condition",
    plain: "The home's receptacles checked for damage, loose connections, proper grounding, and code placement.",
  },
  F2: {
    name: "Exterior & safety lighting",
    plain: "Lighting at entries and exits — the lights that keep steps and doorways safe at night.",
  },
  F3: {
    name: "Wiring support & protection",
    plain: "How cables are routed, supported, and protected where they're visible — in attics, basements, and garages.",
  },
  G1: {
    name: "Water heater shut-off",
    plain: "The dedicated disconnect for your water heater, required so it can be serviced safely.",
  },
  G2: {
    name: "A/C & heating shut-offs",
    plain: "The safety switches at your heating and cooling equipment, required within sight of each unit.",
  },
  G3: {
    name: "Electrical load balance",
    plain: "How evenly the home's big loads are split across the service — measured, because imbalance stresses equipment.",
  },
  H1: {
    name: "Smoke & carbon monoxide alarms",
    plain: "Age, placement, and power source of the alarms — the ten-year replacement rule matters more than most people know.",
  },
  H2: {
    name: "Panel age & remaining life",
    plain: "How old the electrical panel is and what that means for planning — panels don't last forever.",
  },
  I1: {
    name: "Nashville-specific requirements",
    plain: "Extra rules Metro Nashville adds on top of the electrical code, checked only for Davidson County homes.",
  },
};

/** Homeowner name for an item id; falls back to the id so nothing renders blank. */
export function itemName(id: string): string {
  return CHECKLIST_TEXT[id]?.name ?? id;
}

export function itemPlain(id: string): string | null {
  return CHECKLIST_TEXT[id]?.plain ?? null;
}
