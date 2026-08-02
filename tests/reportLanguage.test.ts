/**
 * Report language — the sentences are load-bearing (§3.3, §6, §8.7, §11.3,
 * Step 13). These tests pin the phrases an opposing reader would attack:
 * voltage drop must never say "violation", the grounding claim must match the
 * instrument, and the energized-lug scope boundary must be affirmative.
 */

import { describe, expect, it } from "vitest";
import {
  groundingMethodLanguage,
  energizedTerminationLanguage,
  voltageDropLanguage,
  methodConditionsLanguage,
  samplingDisclosure,
  reportDisclaimer,
  COMPANY_GROUNDING_METHOD,
} from "../src/services/reportLanguage";

describe("grounding instrument language (§3.3)", () => {
  it("company default is the EXTECH 3-point fall-of-potential kit", () => {
    expect(COMPANY_GROUNDING_METHOD).toBe("fall_of_potential_3point");
    const text = groundingMethodLanguage("fall_of_potential_3point");
    expect(text).toContain("fall-of-potential");
    expect(text).toContain("true electrode resistance");
    expect(text).toContain("EXTECH");
  });

  it("a clamp-on record claims loop resistance, never electrode resistance", () => {
    const text = groundingMethodLanguage("clamp_on_loop");
    expect(text).toContain("loop resistance");
    expect(text).toContain("not the");
  });

  it("a bonding-tester record disclaims the electrode claim outright", () => {
    const text = groundingMethodLanguage("bonding_continuity");
    expect(text).toContain("bonding and continuity path resistance only");
    expect(text).toContain("not represented as one");
  });

  it("an unknown method degrades to comparative-indication wording", () => {
    expect(groundingMethodLanguage(null)).toContain("comparative indications only");
    expect(groundingMethodLanguage("something_else")).toContain("comparative indications only");
  });
});

describe("voltage drop language (Step 13)", () => {
  it("never says 'code violation' — even far over the benchmark", () => {
    const over = voltageDropLanguage(8.5);
    expect(over).toContain("exceeds the efficiency benchmark");
    expect(over).toContain("Informational Note");
    expect(over).toContain("not enforceable");
    expect(over.toLowerCase()).not.toContain("code violation is present");
    expect(over).toContain("not a code violation");
  });

  it("within-benchmark readings say so", () => {
    expect(voltageDropLanguage(2.1)).toContain("within the 3% efficiency benchmark");
  });
});

describe("§3.3 energized terminations", () => {
  it("states the boundary affirmatively and names the terminations", () => {
    const text = energizedTerminationLanguage(["lug main A", "lug main B"]);
    expect(text).toContain("lug main A; lug main B");
    expect(text).toContain("Torque verification was not performed");
    expect(text).toContain("remain energized with the service main open");
    expect(text).toContain("deliberate, disclosed scope boundary");
  });
});

describe("sampling and disclaimer", () => {
  it("disclosure carries tested/total, basis, expansion and untested locations", () => {
    const text = samplingDisclosure({
      category: "receptacle",
      totalCount: 40,
      testedCount: 40,
      basis: "one per branch circuit, 25% minimum",
      expandedDueToFail: true,
      untestedLocations: null,
    });
    expect(text).toContain("40 of 40 tested");
    expect(text).toContain("expanded testing to 100%");
  });

  it("rule-4 disclosure counts out-of-condition readings", () => {
    expect(methodConditionsLanguage(2)).toContain("2 readings");
    expect(methodConditionsLanguage(1)).toContain("1 reading");
  });

  it("the §11.3 disclaimer refuses the claims the record cannot make", () => {
    const text = reportDisclaimer("8/2/2026");
    expect(text).toContain("only at the specific date (8/2/2026)");
    expect(text).toContain("not a prediction of remaining service life");
    expect(text).toContain("sample scope stated");
  });
});
