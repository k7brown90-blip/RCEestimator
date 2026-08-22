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
import { asDiscountType, discountFor, DISCOUNT_CAP } from "../src/services/discounts";

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
