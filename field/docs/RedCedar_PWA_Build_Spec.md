# Red Cedar Electric — Electrical Health Record PWA
## Build Specification (handoff to coding agent)

This is the **implementation** spec. It sits on top of three design documents that are the
source of truth for *content* and *logic* — do not duplicate their content, read from them:

- **`RedCedar_Technician_Checklist_Blueprint_v2.md`** — the 30 inspection items, each with
  four fixed reasoning fields, verified code citations, input fields (`{braces}`), and
  PASS/MONITOR/ACTION logic. **This is the single source of truth for checklist content.**
- **`RedCedar_Health_Score_Design.md`** — the scoring model (S×L×C weights, result
  multipliers, graded findings, life-safety class, floor-flag banner, bands) and the
  evidence base behind every weight.
- **`RedCedar_PressureTest_Gaps.md`** — known gaps and open decisions; several are flagged
  below as *config points that must not be hard-coded*.

---

## 1. Product in one paragraph

An **offline-first, installable PWA** a technician uses in the field (basements, attics, no
signal). They pick the property's jurisdiction, walk the checklist section by section,
enter **measured** values and photos, and the app computes a **reproducible health score**
and generates a **layered customer report**. Data is stored locally as **one versioned
record per property**; sync/QR is a later phase. Guiding principle from the brand: *"We
don't guess. We measure."* — so every numeric input is a real reading and the score is
deterministic (same inputs → same score, always).

---

## 2. Recommended stack

- **Vite + React + TypeScript** (SPA, installable).
- **Tailwind CSS** for styling (report aesthetic to match the existing EHR HTML later).
- **Dexie.js** over **IndexedDB** for offline structured storage (records, photos as Blobs).
- **Workbox** service worker for app-shell precaching → offline + installable.
- **Zod** for runtime schema validation of every stored record.
- **Photo capture:** `<input type="file" accept="image/*" capture="environment">`, stored
  as Blobs in IndexedDB alongside the item result.
- **Report export:** render a print-optimized HTML view first (browser print-to-PDF);
  add `jsPDF`/`html2pdf` only if a programmatic PDF is needed later.
- **No backend in Phase 1.** Everything is local-first. Phase 3 adds a sync API.
- **Scoring engine = a pure, dependency-free TypeScript module, unit-tested.** This is the
  most important non-UI code in the app; it must be deterministic and isolated.

---

## 3. Suggested repo structure

```
src/
  data/
    checklist.ts            // typed config transcribed from the Blueprint (30 items)
    jurisdictions.ts        // 5 jurisdiction profiles
    weights.ts              // S/L/C table + class factors — SINGLE source, see §7
  domain/
    types.ts                // all interfaces + enums (§4)
    scoring.ts              // pure scoring engine (§6)
    scoring.test.ts         // golden-case + determinism tests
    report.ts               // assembles report model from an Inspection
  db/
    database.ts             // Dexie schema, versioned records
    photos.ts               // blob storage helpers
  ui/
    screens/                // property, jurisdiction, section, item-card, review, report
    components/
  pwa/
    service-worker.ts       // Workbox
  App.tsx
```

---

## 4. Data model (enums + interfaces)

```ts
export type ResultState =
  | 'PASS'
  | 'MONITOR'
  | 'ACTION'
  | 'NA'              // logged, removed from denominator
  | 'BELOW_STANDARD'; // meets code, below Red Cedar standard (0.15×W)

export type GradedState = 'severe' | 'moderate' | 'minor'; // for graded items (e.g. D1)

export interface ChecklistItemDef {
  id: string;                 // "C4", "D1", ...
  section: string;            // "C — Grounding & Bonding"
  title: string;
  citations: string[];        // verified NEC/NFPA refs (from Blueprint — never invent)
  jurisdictionDependent: boolean;
  bannerListed: boolean;      // forces critical banner + cap ≤69 when ACTION
  lifeSafetyClass: boolean;   // score S×L only (×2.4), no concealment — see §6
  graded?: GradedState[];     // present only for graded items
  naAllowed: boolean;
  inputFields: InputFieldDef[];         // what the tech measures/records
  reasoning: {                          // the four fixed fields (with {placeholders})
    whatWeCheck: string;
    whyCodeCares: string;
    whatWeFound: string;                // contains {placeholders} merged at report time
    whyItMatters: string;
  };
}

export interface WeightDef {            // from weights.ts (§7)
  itemId: string;
  gradedState?: GradedState;
  S: number; L: number; C: number | null;  // C null ⇒ life-safety class
  W: number;                                // precomputed for reference/tests
}

export interface JurisdictionProfile {
  id: string;                 // "murfreesboro", "franklin", "nashville", ...
  label: string;
  necEdition: '2017' | '2023';
  surgeRequired: boolean;     // 230.67
  metroAmendments: boolean;   // Nashville only ⇒ show Section I
  citationOverrides: Record<string, string[]>; // itemId → edition-specific citations
  requiredOverrides: Record<string, 'required' | 'optional'>; // e.g. AFCI, SPD
}

export interface Property {
  id: string; address: string; jurisdictionId: string; createdAt: string;
}

export interface ItemResult {
  itemId: string;
  result: ResultState;
  gradedState?: GradedState;
  measured: Record<string, string | number>; // keyed by inputField id
  photoIds: string[];                          // Blob refs in IndexedDB
  note?: string;
  overrideReason?: string;                     // if a flag was manually changed
}

export interface Inspection {
  id: string;
  propertyId: string;
  jurisdictionId: string;
  technician: string;
  date: string;                 // ISO; versioning key
  items: ItemResult[];
  score: number;                // computed, stored for the record
  itemsAssessed: number;        // denominator count (see §6 / open item)
  criticalFindings: string[];   // itemIds that fired the banner
  contractorReviewed: boolean;  // required true before a report with a critical finding ships
  status: 'draft' | 'complete';
}
```

---

## 5. Checklist definition

`checklist.ts` is a typed array of `ChecklistItemDef`, **transcribed from
`RedCedar_Technician_Checklist_Blueprint_v2.md`** (Sections A–I). Rules:

- The Blueprint is the **single source of truth**. Transcribe the four reasoning fields
  verbatim, keep the `{placeholder}` tokens, and copy citations exactly — **never invent or
  "improve" a code citation.**
- Mark `bannerListed: true` for the items the Scoring Design lists under Step 4 (D1-severe,
  C2/C3, C4/C5, C6, D3, D2, H1, E1).
- Mark `lifeSafetyClass: true` for E1, E2, H1, E3 (per Step 1c).
- Add `graded` states for D1 (severe/moderate/minor), and note D5 & H2 graded per Step 1b/1d.
- Section I items load only when `jurisdiction.metroAmendments === true`.
- `naAllowed: true` where the Blueprint permits N/A (e.g. C5 no subpanels, C6 no gas,
  D5 all-copper). N/A must be an explicit logged choice, never a silent skip.

---

## 6. Scoring engine (deterministic — the core)

Implement in `scoring.ts` as **pure functions**. No randomness, no `Date.now()`, no I/O.
Follow `RedCedar_Health_Score_Design.md` exactly:

**Weight per item** (`weights.ts`, §7):
- Standard item: `W = S × L × C`.
- **Life-safety class** (`lifeSafetyClass`): `W = S × L × 2.4` (no concealment). Round to
  nearest integer to match the published table (e.g. GFCI 5×2×2.4 = 24).
- **Graded item:** weight is selected by `gradedState` (D1 severe=45, moderate=30, minor=12).

**Result multiplier:**
```
PASS            → 0
MONITOR         → 0.35 × W
ACTION          → 1.0  × W
BELOW_STANDARD  → 0.15 × W   // meets code, below Red Cedar standard
NA              → excluded from BOTH numerator and denominator
```

**Score:**
```
applicable = items where result !== 'NA'
score = 100 × (1 − Σ deduction(applicable) / Σ maxWeight(applicable))
score = round(score)                       // whole number, deterministic
itemsAssessed = applicable.length          // surfaced next to the score (see open item)
```

**Floor flags (override the number):** if any item on the **banner list** is `ACTION` (for
D1, banner only when `gradedState === 'severe'`):
- set a red **"Critical finding"** banner listing every such item;
- **cap the headline score at ≤ 69** ("Needs attention");
- the cap does **not** stack lower with multiple criticals; each critical is listed;
- each critical finding **requires a photo + the measured value** stored with it (enforce in
  UI before the item can be completed).

**Bands (headline verdict):** 90–100 Excellent · 75–89 Good · 60–74 Needs attention ·
<60 Priority · any banner ⇒ capped ≤69.

**Determinism test (required):** a fixed input `Inspection` JSON must always produce the
identical `score`, `itemsAssessed`, and `criticalFindings`. Include golden cases for:
a clean house (100), one MONITOR, one BELOW_STANDARD, one N/A (denominator shrinks), a
life-safety ACTION, a D1-severe (banner + cap), and multiple criticals.

---

## 7. Weights config (do not hard-code in the engine)

All S/L/C integers and class factors live in **`weights.ts`** as data, not in engine logic.
Reason (from the Pressure Test): **the S/L/C values are a researched starting point still
pending the licensed contractor's final lock.** Keeping them in one table means the numbers
can be ratified/tuned without touching the scoring code. Transcribe the locked table from
`RedCedar_Health_Score_Design.md` §3 (the current values after our review pass).

---

## 8. Jurisdiction profiles

`jurisdictions.ts` — five profiles from the Blueprint's jurisdiction table: Murfreesboro
(2017), Brentwood (2017), Rutherford unincorporated (2017), Franklin (2023), Nashville
(2023 + Metro). Edition-dependent behavior (surge required, GFCI/AFCI scope, Metro Section
I) is driven entirely by profile fields so the same code serves every market.

> **Config point (Pressure Test):** the 2023-only citations (230.67, expanded 210.8/210.12)
> and Nashville Metro Ch. 16.20 are **pending verification against primary sources**. Keep
> them in the jurisdiction JSON so they can be corrected without a code change, and leave a
> `// VERIFY` comment on each.

---

## 9. Screen flow

1. **Property** — select existing or create (address + jurisdiction).
2. **Jurisdiction confirm** — loads the profile; shows edition + which items are
   required/optional here.
3. **Checklist**, section by section (A→I), progress indicator; Section I only if Metro.
4. **Item card** — the four reasoning fields shown as fixed guidance; measured-value inputs;
   result selector (with graded-state picker where applicable); camera; note. Enforce
   photo+value before allowing complete on any ACTION/banner item.
5. **Review** — critical-finding banner (if any); list of ACTION/MONITOR items; require
   contractor-review acknowledgment when a critical finding is present.
6. **Score + report** — headline score, band, five system roll-ups (worst child sets parent
   color), then per-item cards, then technical appendix.
7. **Save** — write a new **versioned** record (never overwrite a prior inspection).
8. **Export** — print-optimized report view.

---

## 10. Report assembly (`report.ts`)

Produce a report view-model from an `Inspection`:
- **Glance:** headline score + band + five roll-ups. Roll-up groups (from Blueprint):
  *Service & Panel* (A,B,D2–D4,H2) · *Grounding & Bonding* (all C — any fault-path ACTION
  turns this red and fires the banner) · *Branch Circuits* (D1,E) · *Devices & Wiring* (F) ·
  *Life Safety* (G disconnects, H1, +Metro I). Worst child result sets the parent color.
- **Per-item cards:** the four fixed fields, with `{placeholders}` in *whatWeFound / whyItMatters*
  merged from `ItemResult.measured`.
- **Technical appendix:** all measured values, the item citations, and a provenance-labeled
  source list (`[gov/std]` / `[peer-reviewed]` / `[industry]`) — never blend the labels.
- Report must state the one honesty line from the Scoring Design: the score reflects
  severity, likelihood, and concealment, weighted from national fire/shock data.

---

## 11. Offline, versioning, integrity

- All reads/writes hit local IndexedDB; the app must fully function with no network.
- **One record per property, versioned by inspection date.** New inspection = new immutable
  version; enables year-over-year trend later.
- **Mandatory evidence:** any ACTION/banner item requires ≥1 photo and the measured value
  before it can be marked complete.
- **Override + sign-off:** a manually changed flag stores an `overrideReason`; any report
  containing a critical finding requires `contractorReviewed === true` before export.

---

## 12. Open config points (surface as flags/constants — don't bake in)

From the Pressure Test, these are undecided; implement them as configurable, defaulted:
- **S/L/C weights** — data in `weights.ts`, pending contractor lock.
- **MONITOR aggregate cap** — whether many small MONITORs can sink a score. Implement an
  optional cap on total MONITOR deduction; **default: off** (no cap) until decided.
- **Items-assessed display** — show `score` alongside `itemsAssessed` (e.g. "88 · 27 items
  assessed") so a 90/12-items isn't read like a 90/30-items.
- **2023 / Metro / local amendment citations** — in jurisdiction JSON, each `// VERIFY`.

---

## 13. Build phases

1. **Phase 1 (MVP):** local-first inspection flow + deterministic scoring + report + print.
   Ship this first; it's the whole value loop.
2. **Phase 2:** photo-storage hardening, QR property label, PDF polish, year-over-year view.
3. **Phase 3:** backend sync API, multi-technician, CircuitIQ panel-schedule integration.

**Start with the deterministic core** (types → weights → scoring + tests) before any UI —
it's the riskiest, most important, and everything else depends on it.
