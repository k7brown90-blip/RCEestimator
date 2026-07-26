# Red Cedar Electric — Pressure Test & Gap Analysis
## Reviewing the checklist + scoring for what's missing or exposed

This document stress-tests the current 30-item checklist and the scoring model against
(a) what a genuinely complete residential inspection covers, and (b) where the *business*
is exposed — liability, verification, and edge cases. It's organized as: **coverage gaps
(what we don't yet check)**, **evidence/verification gaps (what we assert but haven't
fully backed)**, and **system/logic gaps (where the model itself can mislead)**.

---

## Part 1 — Coverage gaps (checks a complete inspection should have)

### High priority (safety, and consistent with our "we measure" positioning)

1. **AFCI/GFCI functional test vs. mere presence.** E1/E2 currently check that devices
   are present and (for GFCI) trip. But AFCI/GFCI devices *fail in place* — a device can
   be installed and dead. We should explicitly require pressing test/using a tester on
   every accessible AFCI/GFCI, and record pass/fail per device, not just "present."
   *Fix: tighten E1/E2 input to "test each, record trip result."*

2. **Bootleg-ground / false-ground detection at receptacles.** F1 checks polarity and
   open ground, but the most dangerous receptacle wiring error — a bootleg ground (ground
   jumpered to neutral to fool a 3-light tester) — is specifically *invisible* to the
   basic tester we'd use. Detecting it needs a plug tester with a bootleg indication or a
   deliberate check. This is the receptacle-level twin of C5 and deserves its own line.
   *Fix: add F1b "bootleg/false ground check" with the right instrument.*

3. **Overheating scan of receptacles/switches (not just the panel).** D1 thermal-scans
   the panel. But receptacle and switch terminations are where aluminum wiring (D5) and
   loose backstabs actually overheat. A complete inspection thermal-scans device
   terminations in-use, especially on high-draw circuits (kitchen, laundry, HVAC).
   *Fix: extend the thermal step beyond the panel, or add F1c.*

4. **Bathroom/kitchen/laundry dedicated-circuit requirements.** 210.11(C) requires
   specific dedicated circuits (two small-appliance, laundry, bathroom). We check GFCI
   but not whether these required dedicated circuits exist. Absent, they overload.
   *Fix: add an item under E or F for required dedicated branch circuits (210.11).*

5. **GEC/bonding continuity actually measured.** C3/C4 confirm presence and connection,
   but the differentiator is *measurement*. We should ohm the bond continuity
   (main bonding jumper path near 0 Ω; EGC continuity on tested circuits). This turns C3/
   C4/C5 from visual into measured, matching the brand.
   *Fix: add a measured continuity value to C3–C5 inputs.*

### Medium priority

6. **Exterior / wet-location integrity:** in-use ("bubble") covers on outdoor receptacles
   (406.9(B)), condition of outdoor fixtures/conduit. Currently only GFCI is checked
   outdoors.
7. **Subpanel feeder & 4-wire check.** C5 checks neutral-ground separation, but not
   whether a subpanel (esp. a detached-structure or older 3-wire subpanel) has a proper
   4-wire feeder + isolated neutral + grounding electrode where required (250.32). Older
   3-wire subpanels are common and a real hazard.
8. **Bonding of other systems:** pool/spa equipotential bonding (680) where present; solar
   PV interconnection & labeling (690/705) where present — both increasingly common and
   high-liability if missed. Conditional cards like the Nashville one.
9. **GFCI/appliance specifics:** dishwasher (210.8(D)), and — under 2023 — ranges, dryers,
   and more. Our GFCI item should enumerate per edition, not just "wet locations."
10. **Working-space illumination & receptacle at equipment** (110.26(D), 210.63) — a
    servicing-safety item, minor but part of a complete 110.26 review.
11. **Grounding/bonding at the meter and around impaired knockouts** (250.92 bonding
    jumpers, bonding bushings) — the service-raceway bonding detail behind C-section.
12. **Kitchen countertop receptacle spacing** (210.52(C): no point >24" from a receptacle)
    — F1 covers general spacing; kitchen has its own stricter rule and is high-use.

### Lower priority / conditional

13. Smoke/CO **interconnection & power source** (hardwired + battery vs. battery-only) —
    H1 notes placement/age; add whether alarms are interconnected and their power type.
14. **Generator/transfer-switch & backfeed** check where a generator is present (702/
    backfeed hazard) — conditional card.
15. **EVSE / EV charger** load and circuit (625) — increasingly relevant to the landlord
    market and to A2 service-capacity conversations.
16. **Disconnect/breaker for the panel itself in older split-bus panels** (no single main)
    — ties to B1 and D3; the "six-throw" rule and no-main panels.

---

## Part 2 — Evidence & verification gaps (things we assert)

1. **2023-only citations still need a 2023 book.** 230.67 (SPD), expanded 210.8/210.12
   scope, and any 2023 GFCI-for-appliances language are cited from secondary sources. The
   project has only the 2017 NEC. *Before Franklin/Nashville reports go out, verify these
   against an actual 2023 NEC.*

2. **Nashville Metro Ch. 16.20 not read in full.** Item I1 lists three amendments from
   secondary references. The full chapter may contain more (or may have changed). *Read
   the current adopted Metro code chapter directly.*

3. **Local amendments beyond base adoption.** Murfreesboro (18-O-71) and Franklin
   (2025-33) are confirmed as *editions adopted*, but each may carry local amendments we
   haven't enumerated (like TN's state AFCI carve-outs). *Confirm each jurisdiction's
   amendment list, not just the edition.*

4. **TN state amendment currency.** The AFCI-optional and 110.24-optional amendments come
   from the TN SFMO rules; confirm the current effective version (these get updated).

5. **Panel service-life "~30 years."** H2 uses a ~30-yr figure that is industry rule-of-
   thumb, not a manufacturer-published standard. Either source it to specific manufacturer
   documentation or label it explicitly as a general industry estimate. (Currently at risk
   of looking more precise than it is.)

6. **Ground-resistance method.** C2's 25-Ω rule is code-correct, but *how* we measure
   (fall-of-potential vs. clamp-on vs. 2-point) affects the number and what's defensible.
   The blueprint should specify the method and its limits so the reading is reproducible.

7. **S/L/C integers not yet locked.** The whole score rests on these; they're researched
   starting points, not yet ratified by the licensed contractor. This is the single
   biggest open item before the number goes on a customer document.

---

## Part 3 — System & logic gaps (where the model can mislead)

1. **N/A gaming the denominator.** Because N/A items leave the denominator, a property
   with many N/A items (e.g. all-copper, no subpanel, no gas) is scored on fewer checks,
   so each remaining ACTION swings the score harder. Verify this is the intended behavior
   and that two very different homes still produce *comparable* scores. Consider reporting
   "score + # of items assessed" so a 90/12-items isn't read like a 90/30-items.

2. **MONITOR pile-up.** Many small MONITORs (0.35×W each) can quietly sink a score without
   any single real problem. Decide whether that's honest (lots of minor aging = real) or
   whether MONITORs should be capped in their aggregate effect.

3. **Floor-flag interaction.** The S5-ACTION cap at 69 is good, but define what happens
   with *multiple* critical findings (does the banner list all? does the cap drop
   further?), and make sure a single S5 ACTION doesn't hide behind an otherwise 95.

4. **Weight collisions / face validity.** Several items sit at W=30 (C4/C5, D1, D2, D3,
   H1). Confirm on review that a loose connection (D1) and no smoke alarms (H1) *should*
   deduct identically — they may not feel equivalent to a customer, and the contractor
   may want to spread them.

5. **Repair-state vs. binary.** Some items aren't PASS/ACTION but "present-and-mitigated"
   (D5 aluminum with CO/ALR devices; a 3-wire subpanel that's code-legal as grandfathered).
   The three-state model needs a clear rule for "hazard exists but is properly mitigated" —
   probably PASS-with-note, not MONITOR.

6. **Photo/evidence capture.** For liability and for the year-over-year record, each
   ACTION should require a photo + the measured value stored with it. The PWA spec should
   make evidence capture mandatory on any ACTION, not optional.

7. **Technician override & sign-off.** Define who can override a flag (e.g. downgrade an
   ACTION), that it's logged with a reason, and that the licensed contractor's review is
   recorded on any report containing a critical finding. This is both quality control and
   legal protection.

---

## Recommended next actions (in order)

1. **Lock the S/L/C table** with the licensed contractor — unblocks everything downstream.
2. **Add the high-priority coverage items** (functional AFCI/GFCI test, bootleg-ground
   check, device thermal scan, 210.11 dedicated circuits, measured bond continuity) — these
   are safety-relevant and on-brand for "we measure."
3. **Verify 2023 + Metro + local amendments** against primary sources before any
   Franklin/Nashville report is issued.
4. **Resolve the model-logic decisions** (N/A denominator, MONITOR cap, mitigated-hazard
   state, evidence capture, override/sign-off) so the PWA is built once, correctly.
5. Then hand the blueprint + scoring design + this resolved punch-list to Claude Code.

> None of these block the *concept* — the system is sound. They're the difference between a
> strong prototype and something that survives a contested inspection or an insurance
> dispute. The most urgent are the ones that touch a live customer document: locked weights,
> verified 2023/local code, and mandatory evidence capture on ACTION findings.
