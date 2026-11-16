/**
 * The ballpark on a lead, as the office clicks it (Kyle, 2026-11-15, plan lead-intake-fixes F4).
 *
 * Screen: the lead drawer (Leads -> click the lead) and the lead page (Full page). Buttons:
 * "Start a ballpark estimate" -> once the lead has one, the SAME button reads "Open ballpark
 * estimate"; "Delete ballpark" (confirms). Deleting the lead says its ballpark goes too.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { DrawerHost } from "./drawers/DrawerHost";
import { LeadFormPage } from "../pages/LeadFormPage";
import { api } from "../lib/api";
import type { Lead } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function PathProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="path">{pathname}{search}</p>;
}

const BALLPARK = {
  id: "draft-9", title: "Ballpark — Steve U.", status: "draft", updatedAt: "2026-11-15T18:00:00.000Z",
  visitId: null, total: 1234.5, lineCount: 3,
};

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1", name: "Steve U.", email: "steve@example.com", phone: "+16155551234", source: "web", status: "new",
    leadStatus: "new", addressLine1: null, city: "Murfreesboro", state: "TN", postalCode: "37128", jobType: null,
    createdAt: "2026-11-15T12:00:00.000Z", receivedAt: "2026-11-15T12:00:00.000Z", updatedAt: "2026-11-15T12:00:00.000Z",
    ballparks: [],
    ...overrides,
  };
}

function mockCommon(row: Lead) {
  vi.spyOn(api, "lead").mockResolvedValue(row);
  vi.spyOn(api, "campaignLeadMembership").mockResolvedValue({ leadIds: [] });
  vi.spyOn(api, "customerMatches").mockResolvedValue({ matches: [] });
  vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
}

describe("LeadDrawer — ballpark estimate", () => {
  it("a lead with none offers 'Start a ballpark estimate', which opens the builder tied to the lead", async () => {
    mockCommon(lead());
    renderWithProviders(<><DrawerHost /><PathProbe /></>, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Steve U." });
    expect(within(dialog).queryByRole("button", { name: "Open ballpark estimate" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete ballpark" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Start a ballpark estimate" }));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/estimate-intake?lead=lead-1"));
  });

  it("a lead that has one reads 'Open ballpark estimate' (never a second Start), with title, total and updated", async () => {
    mockCommon(lead({ ballparks: [BALLPARK] }));
    renderWithProviders(<><DrawerHost /><PathProbe /></>, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Steve U." });

    expect(within(dialog).queryByRole("button", { name: "Start a ballpark estimate" })).not.toBeInTheDocument();
    const summary = within(dialog).getByTestId("lead-ballpark");
    expect(summary).toHaveTextContent("Ballpark — Steve U.");
    expect(summary).toHaveTextContent("$1,234.50");
    expect(summary).toHaveTextContent("3 lines");
    expect(summary).toHaveTextContent("updated 11/15/2026");
    expect(summary).toHaveTextContent("can't be sent — convert the lead first");

    fireEvent.click(within(dialog).getByRole("button", { name: "Open ballpark estimate" }));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/estimate-intake?lead=lead-1&draft=draft-9&tab=review"));
  });

  it("Delete ballpark confirms, then deletes only the ballpark", async () => {
    mockCommon(lead({ ballparks: [BALLPARK] }));
    const del = vi.spyOn(api, "pbDeleteDraft").mockResolvedValue({ deleted: true, title: BALLPARK.title });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Steve U." });

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete ballpark" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Ballpark — Steve U."));
    expect(del).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete ballpark" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("draft-9"));
  });

  it("deleting the lead says its ballpark is deleted too", async () => {
    mockCommon(lead({ ballparks: [BALLPARK] }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Steve U." });

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/saved ballpark estimate "Ballpark — Steve U\." will be deleted too/));
  });

  it("deleting a lead with no ballpark keeps the plain confirm", async () => {
    mockCommon(lead());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Steve U." });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith('Delete lead "Steve U."? This cannot be undone.');
  });

  it("a converted lead's ballpark opens with its account and address, and says it is the consultation's quote", async () => {
    mockCommon(lead({
      status: "converted", customerId: "acct-1", propertyId: "prop-1", visitId: "visit-1",
      ballparks: [{ ...BALLPARK, visitId: "visit-1" }],
    }));
    renderWithProviders(<><DrawerHost /><PathProbe /></>, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Steve U." });
    expect(within(dialog).getByTestId("lead-ballpark")).toHaveTextContent("technician's Quote screen opens this same estimate");

    fireEvent.click(within(dialog).getByRole("button", { name: "Open ballpark estimate" }));
    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent("/estimate-intake?lead=lead-1&draft=draft-9&tab=review&account=acct-1&address=prop-1"),
    );
  });

  it("a converted lead with no ballpark can't start one: the button is greyed and says why", async () => {
    mockCommon(lead({ status: "converted", customerId: "acct-1", propertyId: "prop-1", visitId: "visit-1" }));
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Steve U." });
    expect(within(dialog).getByRole("button", { name: "Start a ballpark estimate" })).toBeDisabled();
    expect(within(dialog).getByText(/already converted, so a ballpark can't be started/)).toBeInTheDocument();
  });
});

describe("Lead page — ballpark estimate", () => {
  it("carries the same section on /leads/:id/edit", async () => {
    mockCommon(lead({ ballparks: [] }));
    renderWithProviders(
      <Routes><Route path="/leads/:leadId/edit" element={<LeadFormPage />} /></Routes>,
      { route: "/leads/lead-1/edit" },
    );
    expect(await screen.findByRole("button", { name: "Start a ballpark estimate" })).toBeEnabled();
  });

  it("reads 'Open ballpark estimate' once the lead has one", async () => {
    mockCommon(lead({ ballparks: [BALLPARK] }));
    renderWithProviders(
      <Routes><Route path="/leads/:leadId/edit" element={<LeadFormPage />} /></Routes>,
      { route: "/leads/lead-1/edit" },
    );
    expect(await screen.findByRole("button", { name: "Open ballpark estimate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start a ballpark estimate" })).not.toBeInTheDocument();
  });
});
