/**
 * PropertyDetailPage render smoke test — the duplicate "start a new visit" door
 * (plan item I, 2026-10-01, ".claude/plans/2026-10-01-manual-sends-archiving-and-one-calendar.md").
 *
 * Kyle, filed from the debug console on `/properties/:propertyId`: "This is repetitive
 * and should be removed there is already a place to start a new visit."
 *
 * This page carried its own "Start New Visit" card (mode select + purpose field + a
 * "+ Start New Visit" button) that called the same `api.createVisit` and landed on the
 * same `/visits/:id` workspace as `AccountDetailPage`'s `StartWorkCard` ("Open a visit" /
 * "Book consultation" buttons) — a second door to the identical action. Mode and purpose
 * stay editable on the visit workspace after creation either way, so nothing is lost by
 * removing the property page's copy.
 *
 * The surviving door lives one screen over: this page's own "Back to Account" link takes
 * the operator to `/accounts/:customerId`, where `StartWorkCard` is the one remaining
 * place to start a visit for this property's account.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PropertyDetailPage } from "./PropertyDetailPage";
import { api } from "../lib/api";
import type { Property } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const property: Property = {
  id: "prop-1",
  customerId: "cust-1",
  name: "Home",
  addressLine1: "12 Main St",
  city: "Smyrna",
  state: "TN",
  postalCode: "37167",
  visits: [],
  estimates: [],
};

function renderPage() {
  vi.spyOn(api, "property").mockResolvedValue(property);
  return renderWithProviders(
    <Routes>
      <Route path="/properties/:propertyId" element={<PropertyDetailPage />} />
    </Routes>,
    { route: "/properties/prop-1" },
  );
}

describe("PropertyDetailPage", () => {
  it("does not offer its own 'Start New Visit' door — that was a duplicate of AccountDetailPage's StartWorkCard", async () => {
    renderPage();

    // Wait for the page to finish loading before asserting absence.
    await screen.findByText("Estimates for this address");

    expect(screen.queryByText("Start New Visit")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Start New Visit" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mode")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Customer stated reason")).not.toBeInTheDocument();
  });

  it("still carries the click path to the surviving door — 'Back to Account' lands on the account that holds StartWorkCard", async () => {
    renderPage();

    const backLink = await screen.findByRole("link", { name: "Back to Account" });
    expect(backLink).toHaveAttribute("href", "/accounts/cust-1");
  });
});
