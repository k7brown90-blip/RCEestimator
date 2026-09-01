/**
 * The military and senior discount programmes (Kyle, 2026-08-22).
 *
 * "military discount at 5%, senior citizen discount at 5%" — "Off of the whole job but gets
 * capped at $250."
 *
 * One function feeds every surface, so this file is small and absolute. The renders and freezes
 * are covered where those surfaces are tested.
 */

import { describe, expect, it } from "vitest";
import { asCustomPercent, asDiscountType, discountFor, discountLabel, DISCOUNT_CAP, programmeFor } from "../src/services/discounts";

describe("the 5% with a $250 ceiling", () => {
  it("takes 5% of a modest job", () => {
    const d = discountFor("military", 1000)!;
    expect(d.amount).toBe(50);
    expect(d.capped).toBe(false);
  });

  it("caps at $250 — a big remodel gives away $250, not $500", () => {
    // 5% of $10,000 is $500. The programme is a courtesy, not a margin structure.
    const d = discountFor("senior", 10000)!;
    expect(d.amount).toBe(DISCOUNT_CAP);
    expect(d.capped).toBe(true);
  });

  it("finds the exact crossover at $5,000", () => {
    expect(discountFor("military", 5000)!.amount).toBe(250);
    expect(discountFor("military", 5000)!.capped).toBe(false);
    expect(discountFor("military", 5000.2)!.capped).toBe(true);
  });

  it("gives nothing without a programme, and never goes negative", () => {
    expect(discountFor(null, 1000)).toBeNull();
    expect(discountFor(undefined, 1000)).toBeNull();
    // A discount on a zero or negative job would be a negative invoice.
    expect(discountFor("military", 0)).toBeNull();
    expect(discountFor("military", -50)).toBeNull();
  });

  it("refuses to stack by construction", () => {
    // The type is a single value — "both" cannot be expressed, so 10% cannot happen.
    expect(asDiscountType("military")).toBe("military");
    expect(asDiscountType("senior")).toBe("senior");
    expect(asDiscountType("military,senior")).toBeNull();
    expect(asDiscountType("veteran")).toBeNull();
    expect(asDiscountType("")).toBeNull();
  });

  it("rounds to the cent before capping", () => {
    const d = discountFor("military", 333.33)!; // 16.6665
    expect(d.amount).toBe(16.67);
  });
});

/*
  The custom percentage (Kyle, 2026-09-01): "I want to be able to add a custom discount here. This
  will allow me to stay competitive and I can follow through with a price match system."
*/
describe("the custom percentage — Kyle's number, uncapped", () => {
  it("takes exactly the typed percentage of the whole job, with no ceiling", () => {
    const d = discountFor(programmeFor("custom", 7.5), 10000)!;
    expect(d.type).toBe("custom");
    expect(d.percent).toBe(7.5);
    expect(d.rate).toBe(0.075);
    expect(d.cap).toBeNull();
    expect(d.amount).toBe(750); // a 5% programme would have stopped at $250
    expect(d.capped).toBe(false);
  });

  it("is nothing without a valid percentage — never a guessed one", () => {
    expect(programmeFor("custom")).toBeNull();
    expect(programmeFor("custom", null)).toBeNull();
    expect(programmeFor("custom", 0)).toBeNull();
    expect(programmeFor("custom", -5)).toBeNull();
    expect(programmeFor("custom", 50.01)).toBeNull(); // more than half off is a typo
    expect(programmeFor("custom", "abc")).toBeNull();
    expect(discountFor(programmeFor("custom", null), 1000)).toBeNull();
  });

  it("normalises the percentage to two decimals and accepts the string a form sends", () => {
    expect(asCustomPercent("7")).toBe(7);
    expect(asCustomPercent(7.126)).toBe(7.13);
    expect(asCustomPercent(50)).toBe(50);
    expect(programmeFor("custom", "12.5")!.rate).toBe(0.125);
  });

  it("does not stack: the programmes keep their 5%/$250 and ignore any stray percent", () => {
    const m = programmeFor("military", 40)!;
    expect(m.rate).toBe(0.05);
    expect(m.cap).toBe(DISCOUNT_CAP);
    expect(discountFor(m, 10000)!.amount).toBe(250);
    expect(asDiscountType("custom")).toBe("custom");
  });

  it("labels itself with the percentage the customer is getting", () => {
    expect(discountLabel(programmeFor("custom", 7)!)).toBe("Discount (7%)");
    expect(discountLabel(programmeFor("custom", 7.5)!)).toBe("Discount (7.5%)");
    expect(discountLabel("military")).toBe("Military discount (5%)");
    expect(discountLabel("senior")).toBe("Senior discount (5%)");
  });
});
