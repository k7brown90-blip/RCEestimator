/**
 * Kyle, 2026-11-15: both trucks' cards draw on ONE Field Expenses financial account, so a truck's
 * "balance" is the account's. GET /trucks, GET /trucks/:id and the Financials balances strip tell the
 * client how many active trucks share the account (`sharedByTrucks` / `truckCount`) so the screen can
 * say "Field Expenses account balance — shared by 2 trucks". This pins the count itself: active trucks
 * only, per account, and a truck with no account counts nowhere.
 */

import { describe, expect, it } from "vitest";
import { activeTruckCountByAccount } from "../src/services/cardSpend";

describe("activeTruckCountByAccount", () => {
  it("counts the active trucks that share one financial account", () => {
    const counts = activeTruckCountByAccount([
      { isActive: true, stripeFinancialAccountId: "fa_field" },
      { isActive: true, stripeFinancialAccountId: "fa_field" },
      { isActive: true, stripeFinancialAccountId: "fa_other" },
    ]);
    expect(counts.get("fa_field")).toBe(2);
    expect(counts.get("fa_other")).toBe(1);
  });

  it("does not count a retired truck, or a truck with no account", () => {
    const counts = activeTruckCountByAccount([
      { isActive: true, stripeFinancialAccountId: "fa_field" },
      { isActive: false, stripeFinancialAccountId: "fa_field" },
      { isActive: true, stripeFinancialAccountId: null },
    ]);
    expect(counts.get("fa_field")).toBe(1);
    expect(counts.size).toBe(1);
  });
});
