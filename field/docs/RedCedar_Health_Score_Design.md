# Red Cedar Electric — Health Score Design & Severity Research
## Companion to the Technician Checklist Blueprint (v2)

**Purpose.** The health score cannot be arbitrary point weights. To be defensible to a
skeptical investor or inspector, each item's weight must come from the *real-world
consequence* of that deficiency — how bad the outcome is (severity), how likely it is to
occur (likelihood), and how hard it is to detect otherwise (concealment). This document
records the researched consequences behind each check and converts them into a scoring
model. Sources are labeled `[gov/std]`, `[peer-reviewed]`, or `[industry]`.

---

## 1. Why "consequence-based" scoring

A number like "78" is only trustworthy if it means something consistent. We score each
item on three axes, because a deficiency that can kill silently must outweigh one that's
merely a code-technicality:

- **Severity (S, 1–5):** worst realistic outcome — nuisance → property loss → fire →
  shock → death.
- **Likelihood (L, 1–3):** how often this deficiency actually leads to harm given real
  usage.
- **Concealment (C, 1–3):** how invisible it is to the homeowner / a casual inspection.
  High concealment *raises* weight, because our value is catching what others miss.

**Item weight = S × L × C.** Higher weight = larger score deduction when failed.
This keeps the score reproducible (same inputs → same score, no randomness) and lets us
*show the customer why* an item scored the way it did.

---

## 2. The evidence (what each deficiency actually causes)

### Fire-family (severity anchor: electrical fires)
`[gov/std]` Electrical distribution & lighting equipment is the **3rd leading cause of
home structure fires** — an estimated ~46,700–51,000 home electrical fires/yr, ~390–500
deaths, ~1,100+ injuries, ~$1.3B property damage (NFPA; ESFI; USFA). Arcing faults alone
start **>28,000 home fires/yr** (ESFI). This sets S=5 for the fire-ignition items.

- **D1 Connection integrity (loose/corroded terminations).** `[peer-reviewed]` Glowing-
  contact research (NIST/NBS Meese & Beausoliel; IEEE Holm — Shea, Sletbak; NAFE Korinek)
  shows junction temps **>1000 °C** at a loose connection carrying *normal* current — so
  the breaker never trips. `[peer-reviewed]` NFPA 921 documents I²R oxide heating.
  **Graded by observed condition** (a loose connection is a family, not one finding — a
  neutral burnt back several inches is not the same as a lug that never made contact), so
  the technician selects worst-case potential from evidence:
  - **severe** — active heat/char/burn-back/melted insulation (ignition in progress):
    S5 · L3 · C3 = 45, banner-listed.
  - **moderate** — loose on a live/loaded circuit, no burn yet (glowing-connection
    precursor): S5 · L2 · C3 = 30.
  - **minor** — loose but carrying no load / making no contact, no heat: S3 · L2 · C2 = 12.

- **E2 AFCI absent.** `[gov/std]` Arcing faults → 28,000+ fires/yr; AFCIs exist
  specifically to catch series/parallel arcs behind walls. Absent = that protection is
  simply not there. **Life-safety device (fire prevention): scored S5 × L2 → 24, no
  concealment discount** (see Step 1c). The paired *fire-detection* device is the smoke
  alarm — prevention and detection scored as a set.

- **D2 Breaker oversized for conductor.** `[gov/std]` NEC 240.4 — the wire can overheat
  without the breaker tripping; classic hidden fire cause. S5 · L2 · C3 (invisible unless
  gauge-checked). *Field note: an oversized breaker usually means someone swapped in a
  bigger one because the correct size kept tripping — i.e. it marks a circuit that actually
  loads up and a deliberate defeat of protection, which is why it holds the top tier.*

- **D3 Known-hazard panel (FPE Stab-Lok / Zinsco).** `[gov/std/industry]` CPSC &
  independent testing (Aronstein): FPE breakers **fail to trip 25–65 %+** of the time
  under overload (one CPSC sample 51 %); est. ~2,800 fires, ~13 deaths, ~$40M/yr; ~25M
  panels still in service. `[industry]` Insurers now **deny or cancel coverage** on these
  panels. → severity + likelihood + a financial/insurance consequence. S5 · L3 · C2.

- **F3 Box fill / cable protection / open splices.** `[gov/std]` NEC 314.16 (overfill
  cooks insulation), 300.4 (unprotected cable one screw from a fault), 314.25 (open
  splices = shock+fire). S4 · L2 · C2 (found in accessible areas).

### Shock-family (severity anchor: electrocution)
`[gov/std]` GFCI protection has driven a **long-term decline in household electrocutions**
since its introduction (CPSC/ESFI); ground-fault at receptacles is the mechanism GFCIs
interrupt. Shock deficiencies are S5 because the worst outcome is death, but often lower
L than fire items *unless* they energize touchable metal.

- **C4 Main bonding jumper / C5 neutral-ground bond error.** `[peer-reviewed/industry]`
  Bonding neutral to ground downstream (subpanel) or a "bootleg ground" puts *normal
  return current* onto grounding conductors and **energizes touchable metal** (appliance
  cases, conduit, faucets). If the neutral opens upstream, **every grounded surface can
  sit at full line voltage**. Critically, these **pass a casual visual/plug-tester
  inspection** — high concealment. S5 · L2 · C3. `[gov/std]` NEC 250.24(B)/250.28/408.3(C)
  require the MBJ; **250.24(A)(4)** recognizes a *wire from the neutral bar to the EGC bar*
  as a valid MBJ form (Table 250.102(C)(1) → ~#6–#4 Cu residential). **Bus-configuration
  dependent:** with a *shared* ground/neutral bus the green screw is the complete MBJ; with
  *separated* bars, the enclosure is the only EGC-to-neutral link unless a conductor ties the
  bars — and the can is not a listed EGC (250.118), so **separated bars with only the can
  linking them is an ACTION/banner condition**, not a below-standard note. ACTION/banner also
  for a missing MBJ or an EGC bar not actually bonded (insulating standoff / missing bonding
  screw).

- **C2/C3 Grounding electrode & GEC (missing/high-resistance/undersized).** `[gov/std]`
  NEC 250.53 (25 Ω rule), 250.66/250.70. A defeated ground can't clear faults; the
  protective system silently doesn't work. **Immediate-fix class (Step 1d): S5 · L2 · C3 =
  30, banner-listed** — this is a fault-path failure, not a mid-tier defect. Its compromise
  disables breaker tripping and energizes metal at the same time.

- **C6 Water/gas pipe bonding absent.** `[gov/std]` NEC 250.104. Unbonded metal plumbing
  can become energized in a fault (shock at a faucet); unbonded CSST gas line is a
  documented lightning-fire risk. **Immediate-fix class (Step 1d): S5 · L2 · C3 = 30,
  banner-listed.**

- **E1 GFCI absent in required wet locations.** `[gov/std]` The device that prevents
  electrocution where water meets electricity is simply not present/working. **Life-safety
  device (shock prevention): scored S5 × L2 → 24, no concealment discount, banner-listed**
  (see Step 1c). Ranked alongside smoke alarms — ease of detection is our advantage, not a
  reason to weight the risk down.

- **F1 Receptacle reverse-polarity / open-ground / scorched.** `[gov/std]` NEC 406.4(D).
  Reverse polarity & open grounds defeat appliance safety grounding; scorching signals an
  active arcing/heat fault. S4 · L2 · C2.

### Life-safety detection
- **H1 Smoke/CO alarms expired/missing/mis-placed.** `[gov/std]` NFPA: **working smoke
  alarms cut the risk of dying in a home fire ~60 %**; death rate **12.3 per 1,000 fires
  without vs 5.7 with** a working alarm; ~3 of 5 fire deaths occur in homes with no or
  non-working alarms. Expired sensors respond slower. **S4** · L3 · C2 (age hidden on the
  back; homeowners rarely check date-stamp). Rated S4, not S5, because the alarm *detects/
  notifies* rather than *causing* the hazard — but it still forces the critical banner as a
  named life-safety item (see Step 4). CO absence adds a separate poisoning path.

### Service / access / infrastructure
- **A1 Service drop/mast damage.** `[industry/gov]` Storm-torn weatherhead → utility
  won't restore power until a licensed contractor rebuilds it; low clearances = contact
  risk. S4 · L2 · C1.
- **A2 Service undersized.** `[gov/std]` NEC 230.79/Art.220 — overheating, nuisance
  trips, blocks EV/HVAC additions. S3 · L2 · C2.
- **A3 Main disconnect external condition (meter base not openable).** `[gov/std]` A licensed
  electrician's scope begins past the weatherhead; the **meter socket cannot be opened** to
  inspect its terminations without the utility present and confirming, so those are **not
  inspected and not scored** — noted "refer to utility." What we *do* assess is the **external
  condition** of the meter base and the **main disconnect after the meter** (corrosion, heat
  marks, secure mounting, weather sealing). Scored on external condition only. S4 · L1 · C1.
  *(This scope limit protects Red Cedar from asserting a condition on equipment it isn't
  permitted to access.)*
- **B1 Service disconnect inaccessible/unmarked/>6.** `[gov/std]` NEC 230.70/230.71 —
  first responders can't kill power fast. S4 · L1 · C1.
- **B2 Working/dedicated space obstructed.** `[gov/std]` NEC 110.26 — unsafe to service
  energized; extremely common in finished basements/remodels. S3 · L2 · C1.

### Surge / equipment disconnects / aging
- **E3 Surge protection.** `[gov/std]` 2023-req (230.67) / 2017-optional. **Life-safety
  class — it protects the other safety devices** (AFCI, GFCI, smoke alarms) plus electronics;
  scored S3 × L2 → 14 **where required (2023)**, and **OPTIONAL / zero deduction** in
  adopted-2017 jurisdictions since not mandated there (see Step 1c).
- **G1/G2 Water-heater / HVAC disconnect.** `[gov/std]` NEC 422.31(B)/440.14 — service
  tech can't safely de-energize; installer/servicer risk. S3 · L1 · C1.
- **H2 Panel age/condition.** `[industry]` ~30-yr rated life; aging panels overheat and
  can't meet modern load. Consequence rises with age; a *sound* aged panel is MONITOR,
  a corroded/heat-damaged one is ACTION. S3 (aging) → S4 (damaged) · L2 · C2.
- **C7 Intersystem bonding termination absent.** `[gov/std]` NEC 250.94 — surge/fault can
  create damaging voltage differences between power and cable/internet. S2 · L2 · C2.
- **F2 Egress/Security lighting missing (entries, stairs, exterior paths).** `[gov/std]`
  NEC 210.70 — required switched lighting at habitable rooms, halls, stairs, and outdoor
  entrances; its absence is a fall/egress hazard in the dark and a security gap at exterior
  doors. S3 · L1 · C1.
- **G3 Load imbalance (fixed loads).** `[gov/std]` Art. 220 — overloads neutral, sags
  voltage; ties to the flicker/impedance mechanism. S2 · L2 · C2.
- **A2/D4 directory & schedule.** `[gov/std]` NEC 408.4 — wrong labels delay emergency
  shutoff. S2 · L2 · C1 (we fix it as part of onboarding).

---

## 3. The scoring model (reproducible)

**Step 1 — item raw weight** `W = S × L × C` (computed once, fixed per item; table below).

**Step 1b — graded findings (score to worst-case potential).** Some checks aren't a single
finding but a *family* whose severity depends on observed condition. For these, the checklist
defines discrete states and the technician selects the one that matches the evidence (photo
required), scoring to worst-case potential — not an average. Graded items so far:
- **D1 loose connection:** severe (heat/char/burn-back) = 45 · moderate (loose under load,
  no burn) = 30 · minor (loose, no load/heat) = 12.
- **D5 aluminum wiring:** unmitigated with heat damage = banner-listed · unmitigated no heat
  = 16 · mitigated (CO/ALR or listed repair) = PASS-with-note.
- **H2 panel:** corroded/heat-damaged = S4 · merely aged-but-sound = S3 (MONITOR).
This is how field experience enters the model: the grading rubric is the electrician's
judgment, encoded once so every technician grades the same way.

**Step 1c — life-safety device class (no concealment discount).** Named protective devices
whose entire function is safety are scored on **Severity × Likelihood only** — concealment
is *not* applied, because ease of detection is Red Cedar's advantage, not a reduction in the
device's importance. To keep these comparable to concealment-scored items on the same 0–~45
scale, the S×L product is multiplied by a fixed class factor of ×2.4 (≈ the mid concealment
value it replaces), then treated normally. This class is:
- **GFCI** (E1) — shock prevention. S5 × L2 → 24. Banner-listed.
- **AFCI** (E2) — fire prevention. S5 × L2 → 24.
- **Smoke/CO alarms** (H1) — fire/CO detection. S4 × L3 → 24 (already 24; banner-listed).
- **Surge/SPD** (E3) — protects the other safety devices. S3 × L2 → 14 **where required
  (2023)**; remains **OPTIONAL / zero deduction** in adopted-2017 jurisdictions since not
  mandated there.
Grouping these makes the report's own logic legible: prevention (GFCI, AFCI), detection
(alarms), and protection-of-protection (surge) are the safety layer, and the score treats
them as a set.

**Step 1d — grounding & bonding = immediate-fix class.** The grounding and bonding system
(C2/C3 electrode & GEC, C4/C5 neutral-ground bond, C6 water/gas bonding) is **the mechanism
that makes every overcurrent device work** — a breaker only trips because a fault has a
low-impedance path back to source, and that path *is* the bonding system. If it's
compromised, two things happen at once: the fault current can't rise enough to trip the
breaker (so the fault persists), and touchable metal energizes. It is the safety net *under*
the safety devices. Therefore **any fault-path grounding/bonding deficiency is scored at the
ceiling (30) and banner-listed** — it is never a mid-tier finding, because its failure is a
simultaneous multi-hazard condition, not a single defect. (C7 intersystem bonding is the one
Article 250 item held lower — it governs surge/voltage-difference protection between power and
cable/phone, not the fault-clearing path, so it stays Med.)

**Step 2 — per-item result multiplier**
- PASS → 0 (no deduction)
- MONITOR → 0.35 × W (partial — aging/grandfathered/optional, informational)
- ACTION → 1.0 × W (full deduction — safety issue or code deficiency)
- N/A (logged) → item removed from both numerator and denominator (doesn't distort score)
- **BELOW-STANDARD (Red Cedar recommendation, not a code violation)** → 0.15 × W, and the
  report must state plainly that the item *meets code* but is below Red Cedar's enhanced
  standard. This state exists so we never flag a code-compliant install as a violation —
  e.g. a redundant bar-to-bar bonding jumper added on a *shared-bus* panel that is already
  complete, or an intersystem bonding termination retrofit on an older but compliant service.
  It does **not** apply to a separated-bus panel whose EGC bar reaches neutral only through
  the can — that is a genuine ACTION (see C4). Keeps the anti-overstatement posture honest.

**Step 3 — score**
`Score = 100 × (1 − Σ deductions / Σ max possible weight of applicable items)`
Rounded to nearest whole number. Because W is fixed and results are discrete, the same
inputs always yield the same score — no randomness, defensible line-by-line.

**Step 4 — floor flags (override the number).** Some findings are severe enough that the
*number* alone could mislead, so they force a **red "Critical finding" banner** regardless
of the computed score and cap the headline score at a maximum of **69 ("Needs attention")**
until resolved. This prevents a house with one lethal defect from showing a comfortable 80.

The banner triggers off an **explicit named list**, not off the severity integer — because
a life-safety *detection* failure (smoke/CO alarms) belongs here even though its device
severity is 4, not 5. A finding forces the banner if it is an ACTION on any of:
- **Hazard/delisted panel** (D3) — documented failure-to-trip / false-off.
- **Energized-metal bonding error** (C4/C5) — neutral-ground bond downstream / bootleg ground.
- **Compromised grounding/bonding fault path** (C2/C3 electrode & GEC, C6 water/gas bonding) —
  defeats breaker tripping and energizes metal simultaneously.
- **Loose/corroded connection with active heat damage** (D1-severe) — ignition in progress.
- **Oversized breaker / defeated overcurrent protection** (D2).
- **No working smoke/CO alarms** (H1) — life-safety device, listed here on function, not on
  its severity number.
- **GFCI absent in a required wet/occupied location** (E1) — life-safety device; live
  electrocution path where water and electricity meet.
- **Supply-side damage** (A3) — unfused conductors/meter between utility and main.
- **Unmitigated aluminum branch wiring with heat damage** (D5) — active overheating.

The list is maintained explicitly so a future weight change never silently drops a
life-safety item out of the banner. Multiple critical findings each appear in the banner;
the cap stays at ≤69 (it does not stack lower), and every critical finding requires a photo
and the measured value stored with the record.

### Item weight table (illustrative, from §2)

| Item | S | L | C | W = S·L·C | Tier |
|---|---|---|---|---|---|
| D1 loose connection — **severe** (active heat/char/burn-back) | 5 | 3 | 3 | 45 | Critical+ |
| C4/C5 neutral-ground bond error / MBJ or EGC-bar bond missing | 5 | 2 | 3 | 30 | Critical · banner |
| C2/C3 grounding electrode/GEC (fault path) | 5 | 2 | 3 | 30 | Critical · banner |
| C6 water/gas bonding | 5 | 2 | 3 | 30 | Critical · banner |
| D3 hazard/delisted panel (FPE, Zinsco, etc.) | 5 | 3 | 2 | 30 | Critical · banner |
| D1 loose connection — **moderate** (loose under load, no burn) | 5 | 2 | 3 | 30 | Critical |
| D2 breaker oversized (DIY-defeat pattern) | 5 | 2 | 3 | 30 | Critical · banner |
| H1 smoke/CO alarms (life-safety, S×L) | 4 | 3 | — | 24 | High · banner |
| E1 GFCI absent (life-safety, S×L) | 5 | 2 | — | 24 | High · banner |
| E2 AFCI absent (life-safety, S×L) | 5 | 2 | — | 24 | High |
| F3 box fill/cable/open splice | 4 | 2 | 2 | 16 | High |
| D5 aluminum branch wiring (unmitigated) | 4 | 2 | 2 | 16 | High |
| F1 receptacle polarity/ground | 4 | 2 | 2 | 16 | High |
| E3 surge — life-safety, **2023 required** (S×L) | 3 | 2 | — | 14 | Med |
| A2 service undersized | 3 | 2 | 2 | 12 | Med |
| H2 panel age/condition | 3 | 2 | 2 | 12 | Med |
| D1 loose connection — **minor** (loose, no load/heat) | 3 | 2 | 2 | 12 | Med |
| A1 service drop/mast | 4 | 2 | 1 | 8 | Med |
| C7 intersystem bonding | 2 | 2 | 2 | 8 | Med |
| G3 load imbalance | 2 | 2 | 2 | 8 | Med |
| B2 working/dedicated space | 3 | 2 | 1 | 6 | Med |
| B1 disconnect access/marking | 4 | 1 | 1 | 4 | Med |
| D4/A-dir directory & schedule | 2 | 2 | 1 | 4 | Low |
| G1/G2 WH/HVAC disconnect | 3 | 1 | 1 | 3 | Low |
| F2 egress/security lighting | 3 | 1 | 1 | 3 | Low |
| E3 surge (2017 — not required) | — | — | — | 0 | Optional |
| A3 main disconnect **external condition only** (meter socket = refer to utility, unscored) | 4 | 1 | 1 | 4 | Med · note |

*(S/L/C values are the researched starting point; the licensed contractor should review
and lock them before release. The model is the deliverable — the exact integers are
tunable, but every one traces to a documented consequence in §2.)*

### Score bands (headline verdict)
- **90–100 — Excellent:** no ACTION items; at most minor MONITORs.
- **75–89 — Good / Serviceable:** minor fixes; no critical findings.
- **60–74 — Needs attention:** one or more ACTION items; plan corrections.
- **Below 60 — Priority:** multiple ACTION items or a critical finding.
- **Any S5 ACTION → Critical banner + score capped ≤69** regardless of math.

---

## 4. How this shows up for the customer (ties to the report)

Each card already states *what/why/found/why-it-matters*. The score section adds one line
of honesty: **"This score reflects severity, likelihood, and how hidden each issue is —
weighted from national fire/shock data, not our opinion."** The customer can see that a
red item is red because the evidence says so, which is the whole anti-upsell posture:
the data recommends the work, not the salesman.

For year-over-year tracking, the same weights make two inspections directly comparable —
a rising score is real improvement, a falling one is real degradation.

---

## 5. Evidence base (organized by check-family)

Rather than a short reference list, each check-family below carries the specific,
quantified findings that justify its weight, with every source labeled by type. This is
what makes the score defensible line-by-line: a red item is red because the cited
evidence says the consequence is severe, likely, or hidden — not because we say so.

### 5.1 Aggregate fire burden (anchors S5 for all fire-ignition items)
- `[gov/std]` Electrical distribution & lighting equipment is the **3rd leading cause of
  home structure fires** (NFPA). Recent five-year NFPA averages: ~30,700–34,000 home fires
  per year involving this equipment, ~390–500 deaths, ~1,100+ injuries, and the **highest
  property damage of any home-fire cause** (~$1.3B/yr).
- `[gov/std]` ESFI: home electrical fires total ~51,000/yr, ~500 deaths, ~$1.3B damage.
- `[gov/std]` USFA/FEMA: ~28,300 residential building electrical fires/yr (2003–2005 base),
  concentrated in bedrooms (15%) and in December–January.
- `[gov/std]` CPSC: electrical **receptacles** alone are involved in ~5,300 fires/yr,
  ~40 deaths. (Backs F1 receptacle condition.)

### 5.2 Loose / corroded connections — D1 (S5·L2·C3)
- `[peer-reviewed]` Meese & Beausoliel, *Exploratory Study of Glowing Electrical
  Connections*, U.S. National Bureau of Standards (NBS/NIST) — documents self-sustaining
  glowing connections at loose terminations carrying **normal** current, with localized
  temperatures far above conductor limits.
- `[peer-reviewed]` IEEE Holm Conference on Electrical Contacts — Shea, "Glowing Contact
  Physics"; Sletbak et al., "Glowing Contact Areas in Loose Copper Wire Connections":
  junction temperatures exceeding **1000 °C** — above the melting point of copper — while
  the breaker sees only normal load and never trips.
- `[peer-reviewed]` Korinek, "Investigation and Analysis of Poor Electrical Connections,"
  *Journal of the National Academy of Forensic Engineers* (NAFE).
- `[gov/std]` NFPA 921, *Guide for Fire & Explosion Investigations* — I²R heating at
  high-resistance (oxidized/loose) connections as a recognized ignition mechanism.
- `[gov/std]` NEC 110.14(D) (torque to spec, calibrated tool), Annex I torque tables,
  110.12(B) (no overheated/corroded parts).

### 5.3 Arc-fault fire & AFCI — E2 (S5·L2·C2)
- `[gov/std]` ESFI/NEMA: arcing faults start **>28,000–30,000 home fires/yr**, hundreds of
  deaths/injuries, >$750M damage.
- `[gov/std]` CPSC estimate: AFCIs **could prevent more than 50%** of home electrical
  fires.
- `[industry/std]` IAEI: branch-circuit wiring (the zone AFCIs protect) is the origin of
  **~35% of residential distribution-system fires**; AFCI first required in NEC 1999
  (bedroom circuits), expanded 2008 onward.
- `[gov/std]` NEC 210.12(A)/(D); TN amendment makes AFCI optional in baths, laundry,
  garages, unfinished basements (drives the required-vs-optional label and lower L on
  grandfathered circuits).

### 5.4 Overcurrent / breaker sizing — D2 (S5·L2·C3)
- `[gov/std]` NEC 240.4 / 240.4(D): conductors must be protected at ampacity (15A/14AWG,
  20A/12AWG, 30A/10AWG). An oversized breaker lets the conductor overheat without tripping
  — a documented hidden ignition path tied to the aggregate fire burden in §5.1.

### 5.5 Hazard / delisted panels — D3 (S5·L3·C2)
The checklist's D3 table covers the full set, not just FPE. They split into two failure
classes, which the report should distinguish for the customer:

**Trip-failure / delisted-grade (replace):**
- `[gov/std]` **FPE Stab-Lok:** CPSC opened a formal investigation (1980); CPSC lab testing
  found **~51% of sampled breakers failed** UL trip criteria; case closed 1983 on budget,
  without declaring them safe. `[peer-reviewed/industry]` Aronstein (original CPSC test-team
  engineer) continued testing: fail-to-trip **25% at 135% overload rising to 65%+** on repeat
  surges; **85% double-pole / 39% single-pole** failed ≥1 UL criterion; est. **~2,800 fires,
  ~13 deaths, ~$40M/yr**; ~25M still installed. Never formally recalled.
- `[industry]` **Zinsco / GTE-Sylvania / Kearney:** aluminum breaker clip and bus overheat;
  breaker can **weld/fuse to the bus → cannot trip**, and exhibits a **"false-off"** (handle
  reads OFF while the circuit stays live — a distinct lethal shock trap). Field-failure
  collection (inspectapedia, shared with CPSC) indicates **~25% trip failure** vs <1% for
  competitive brands; **no longer UL-approved for sale**. Never formally recalled.

**Recall-history / obsolete (evaluate–replace):**
- `[industry]` **Challenger:** breakers detach/arc; **1994 CA-series breaker recall**; **2014
  Eaton recall** on certain models (shock hazard); many lack AFCI/GFCI provisions.
- `[industry]` **Pushmatic / Bulldog (ITE):** push-button mechanism stiffens and fails to
  trip with age; obsolete parts.
- `[industry]` **Wadsworth:** not defective as-built, but manufacturer gone (1990); parts
  obsolete, no longer meets current standards.
- `[gov/std/industry]` **Certain Siemens/Murray QP & QPF** and **certain Eaton/Cutler-Hammer
  BR & CH** breakers carry **model/date-code-specific recalls** (may not trip) — most units
  of these brands are fine; the app verifies model & date code against active recall notices
  rather than flagging the brand wholesale.

- `[industry]` Insurers routinely **deny, surcharge, or cancel coverage** on FPE/Zinsco/
  Challenger panels (typical replacement $3,500–$5,000) — the financial/insurability
  consequence behind L3.
- `[gov/std]` NEC 110.3(B) (equipment used per listing) is the code hook; the specific hazard
  determination is field judgment backed by the above, not a single NEC citation. Only some of
  these were formally *recalled* (Challenger, Eaton, Siemens/Murray items); FPE and Zinsco
  were **not** recalled but are delisted-grade — the report must not overstate "recalled."

### 5.5a Aluminum branch-circuit wiring — D5 (S4·L2·C2)
- `[gov/std]` CPSC found homes with pre-1972 **solid aluminum branch-circuit wiring** are far
  more likely to reach **fire-hazard conditions at connections** (overheating at outlets,
  switches, splices) than copper, due to aluminum's expansion, oxidation, and creep at
  terminations.
- `[gov/std]` NEC 110.14 (dissimilar-metal terminations must be identified/listed) and
  110.3(B) (CO/ALR-rated devices) — mitigation via CO/ALR devices or listed repairs
  (COPALUM crimp, AlumiConn) is the recognized remedy short of full rewire.
- `[industry]` Frequent insurance flag alongside the hazard panels; fixable without a full
  rewire, which is why it's ACTION-but-mitigable rather than replace-only.

### 5.6 Grounding, bonding & neutral-ground errors — C2–C6 (up to S5·L2·C3)
- `[peer-reviewed/industry]` Neutral-to-ground bonds downstream of the service (subpanel
  re-bonds, "bootleg grounds") place **normal return current on the equipment-grounding
  system**, energizing touchable metal (appliance cases, conduit, faucets). If the neutral
  opens upstream, **every grounded surface can rise to full line voltage** — a lethal shock
  path with no breaker trip. Critically, these errors **pass a casual visual inspection and
  a plug-in 3-light tester**, which is why concealment is rated maximum (C3). (Consensus of
  IEEE/Mike Holt technical references and NEC 250 commentary.)
- `[gov/std]` NEC 250.24(A)(5)/(B), 250.28, 408.41 (single service bond; neutral isolated
  at subpanels); 250.53(A)(2) 25-Ω rule; 250.66/250.70 (GEC sizing & listed connection);
  250.104(A)/(B) (water & gas/CSST piping bonding); 250.94 (intersystem bonding).
- `[gov/std]` Effective ground-fault current path (NEC 250.4) is what lets a breaker clear
  a fault at all — a defeated ground silently disables the entire protective scheme.

### 5.7 Shock protection / GFCI — E1 (S5·L2·C1)
- `[gov/std]` CPSC: consumer-product electrocution deaths fell from **~480 (1981) to ~250
  (1991), a 48% reduction** across the GFCI-adoption era; more recent CPSC reports track
  ~40–70 consumer-product electrocutions/yr.
- `[gov/std/peer-reviewed]` Underwriters Laboratories study cited by CPSC: GFCI protection
  is **81%–95% effective** at preventing electrocution deaths.
- `[gov/std]` CPSC: a GFCI **could prevent over two-thirds** of the ~300 remaining
  in-home electrocutions per year; CPSC statement that universal household GFCIs could
  **halve** home electrocution deaths.
- `[gov/std]` NEC 210.8(A)/(D) dwelling GFCI locations (broadened under 2023).

### 5.8 Smoke & CO alarms — H1 (S4·L3·C2, banner-listed)
- `[gov/std]` NFPA (2024 *Smoke Alarms in the U.S.*): working smoke alarms **cut the risk
  of dying in a home fire by ~60%**; death rate **12.3 per 1,000 fires with no working
  alarm vs 5.7 with** one; **~3 of 5 home-fire deaths** occur in homes with no alarms (40%)
  or no working alarm (17%); of present-but-failed alarms, **43% had missing/dead
  batteries**.
- `[gov/std]` CDC: accidental **non-fire CO poisoning kills 400+ people/yr** and drives
  **50,000+ ER visits**; CO is a leading cause of accidental poisoning death; symptoms
  mimic flu, so cases are under-reported. Only ~27% of homes have CO alarms (industry
  survey).
- `[gov/std]` NFPA 72 (10-yr sensor replacement life; CO detection requirements absorbed
  from NFPA 720); IRC R314/R315 (placement & interconnection).

### 5.9 Service, working space, disconnects, load — Sections A, B, G
- `[gov/std]` NEC 230.79(C) (100A minimum one-family), 230.24 (clearances), 230.70(A)/
  230.71 (disconnect location, ≤6 rule), 110.26(A)/(E) (36-in. working depth, dedicated
  space) — code-mandated safe-service-and-access basis; consequence is service-tech and
  first-responder safety plus overheating/nuisance-trip on undersized service.
- `[gov/std]` NEC 422.31(B), 440.14, 424.19 (appliance/HVAC disconnect within sight);
  Article 220 (load calculation & balance).

### 5.10 Box fill, cable protection, devices, surge — Sections F, E3
- `[gov/std]` NEC 314.16 (box-fill limits prevent insulation damage/overheating), 300.4
  (physical protection / nail plates), 314.25 (covers required — open splices are shock+
  fire risk), 334.30 (NM support); ties to §5.1 aggregate burden.
- `[gov/std]` NEC 210.52 / 210.70 / 406.4(D) / 406.12 (receptacle spacing, required
  lighting, safe replacement, tamper-resistant).
- `[gov/std]` NEC 230.67 (2023 SPD requirement; not required under adopted 2017 editions,
  hence OPTIONAL/zero-deduction in those jurisdictions).

> **Contractor note.** The consequences above are documented and source-labeled; the exact
> S/L/C integers in §3 remain a researched starting point for you to review and lock as the
> licensed professional. Where a claim rests on independent testing or industry practice
> rather than a peer-reviewed study or government standard (notably the FPE failure-rate and
> insurer-coverage figures in §5.5), it is labeled `[industry]` and not dressed up as
> peer-reviewed. Once the weights are locked, the model produces identical, explainable
> scores across every technician and property — which is the entire point.
