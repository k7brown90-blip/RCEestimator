import { describe, expect, it } from "vitest";
import { depositDueOf, depositKeptOnCancel, DEPOSIT_NONREFUNDABLE_CAP } from "../src/services/stripePayments";

/**
 * Kyle's deposit rulings, 2026-08-25, verbatim where it matters:
 * "We need to implement a 1/3 deposit on every job." / "I want to be exact and
 * round to the cent" / "no refunds on the deposit, up to $300. (a $1200
 * deposit will refund $900, the $300 is kept for labor and processing)"
 */
describe("deposit math", () => {
  it("is an exact third, rounded to the cent", () => {
    expect(depositDueOf(300)).toBe(100);
    expect(depositDueOf(1000)).toBe(333.33);
    expect(depositDueOf(225)).toBe(75);
    expect(depositDueOf(2500)).toBe(833.33);
    expect(depositDueOf(0.01)).toBe(0);
  });

  it("keeps the deposit up to $300 on cancellation — his $1200 example exactly", () => {
    expect(depositKeptOnCancel(1200)).toBe(300); // refund $900
    expect(depositKeptOnCancel(300)).toBe(300);
    expect(depositKeptOnCancel(100)).toBe(100); // smaller deposit: all of it kept
    expect(DEPOSIT_NONREFUNDABLE_CAP).toBe(300);
  });
});
