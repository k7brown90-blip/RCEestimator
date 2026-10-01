/**
 * The lead drawer: the Leads card's actions plus the edit form in place — and the E1 guard:
 * `smsConsent` is tri-state, shown as words, never a control, and never in a PATCH payload.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import { DrawerHost } from "./DrawerHost";
import { api } from "../../lib/api";
import type { Lead, Visit } from "../../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function PathProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="path">{pathname}{search}</p>;
}

function lead(overrides: Partial<Lead>): Lead {
  return {
    id: "lead-1", name: "Jane Homeowner", email: "jane@example.com", phone: "+16155551234", source: "phone", status: "new",
    leadStatus: "new", notes: "Wants a panel upgrade", address: null, addressLine1: "12 Main St", city: "Smyrna", state: "TN",
    postalCode: "37167", jobType: "Panel upgrade", createdAt: "2026-09-15T12:00:00.000Z", updatedAt: "2026-09-15T12:00:00.000Z",
    ...overrides,
  };
}

function mockCommon(row: Lead) {
  vi.spyOn(api, "lead").mockResolvedValue(row);
  vi.spyOn(api, "campaignLeadMembership").mockResolvedValue({ leadIds: [] });
  vi.spyOn(api, "customerMatches").mockResolvedValue({ matches: [] });
  vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
}

describe("LeadDrawer", () => {
  it("renders the lead with its actions and shows a never-asked SMS consent as words, not a checkbox", async () => {
    mockCommon(lead({ smsConsent: null }));

    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });

    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    expect(within(dialog).getByText(/never asked/)).toBeInTheDocument();
    expect(dialog.querySelector("[data-sms-consent]")).toHaveAttribute("data-sms-consent", "null");
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Mark Contacted" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Book on the Calendar" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Convert only" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Mark Lost" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "+ Email campaign" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("distinguishes declined from never asked", async () => {
    mockCommon(lead({ smsConsent: false, source: "web" }));
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    expect(within(dialog).getByText(/declined/)).toBeInTheDocument();
    expect(dialog.querySelector("[data-sms-consent]")).toHaveAttribute("data-sms-consent", "false");
  });

  it("edits the lead in place and the PATCH never carries smsConsent", async () => {
    mockCommon(lead({ smsConsent: null }));
    vi.spyOn(api, "updateLead").mockImplementation((_id, input) => Promise.resolve(lead({ ...input as Partial<Lead>, smsConsent: null })));

    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });

    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    const nameInput = within(dialog).getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.value).toBe("Jane Homeowner");
    fireEvent.change(nameInput, { target: { value: "Jane H. Homeowner" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Lead" }));

    await waitFor(() => expect(api.updateLead).toHaveBeenCalled());
    const [id, payload] = (api.updateLead as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[0];
    expect(id).toBe("lead-1");
    expect(payload.name).toBe("Jane H. Homeowner");
    expect("smsConsent" in payload).toBe(false);
    // Back to the summary once saved; the drawer stays open.
    expect(await within(dialog).findByText("Saved.")).toBeInTheDocument();
  });

  it("marks a lead lost with a required reason", async () => {
    mockCommon(lead({}));
    vi.spyOn(api, "updateLead").mockResolvedValue(lead({ status: "lost", lostReason: "price" }));

    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark Lost" }));
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "price" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save as lost" }));

    await waitFor(() => expect(api.updateLead).toHaveBeenCalledWith("lead-1", expect.objectContaining({ status: "lost", lostReason: "price" })));
  });

  it("sends a free-form follow-up email and shows the unsubscribed notice when the address is suppressed", async () => {
    mockCommon(lead({}));
    vi.spyOn(api, "sendRecordEmail").mockResolvedValue({ sent: true, to: "jane@example.com", suppressed: true });

    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Send email" }));
    fireEvent.change(within(dialog).getByLabelText("Subject"), { target: { value: "Checking in" } });
    fireEvent.change(within(dialog).getByLabelText("Message"), { target: { value: "Just following up on your quote." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(api.sendRecordEmail).toHaveBeenCalledWith({
      target: "lead", id: "lead-1", to: "jane@example.com", subject: "Checking in", body: "Just following up on your quote.",
    }));
    expect(await within(dialog).findByText(/unsubscribed from marketing/)).toBeInTheDocument();
  });

  /*
    ONE SCHEDULER (2026-10-01, plan item E3). This drawer used to open its own `JobScheduler`
    inline — a second month grid against a second endpoint — the moment "Schedule" was pressed.
    Kyle: "It all needs consolidated into a single scheduling system in one place." Booking a
    lead is now the same door "Book consultation" uses: land on the Calendar with the visit
    selected. Three cases: a lead that already has a visit, a lead that must convert first, and
    a lead whose visit is already booked.
  */
  it("a converted lead's 'Book on the Calendar' leaves for /calendar?schedule=<visitId> and opens no picker here", async () => {
    mockCommon(lead({
      status: "converted", leadStatus: "won", customerId: "cust-1", propertyId: "prop-1",
      linkedVisit: { id: "visit-9", status: "estimate", scheduledStart: null, scheduledEnd: null, estimatedDurationDays: null, jobType: "Panel upgrade", purpose: null },
    }));

    renderWithProviders(<><DrawerHost /><PathProbe /></>, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Book on the Calendar" }));

    // No inline scheduler — straight to the Calendar; the drawer closes with the route change.
    expect(screen.queryByText(/Pick a start date/)).not.toBeInTheDocument();
    expect(screen.queryByText("Su")).not.toBeInTheDocument();
    expect(screen.getByTestId("path")).toHaveTextContent("/calendar?schedule=visit-9");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("a new lead converts first, then lands on the Calendar with the new visit selected", async () => {
    mockCommon(lead({}));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(api, "convertLead").mockResolvedValue({
      customer: { id: "cust-1", name: "Jane Homeowner" } as never,
      property: { id: "prop-1" } as never,
      visit: { id: "visit-new", propertyId: "prop-1", customerId: "cust-1", mode: "service_diagnostic", status: "estimate", visitDate: "2026-10-01T12:00:00.000Z" } as Visit,
      lead: lead({ status: "converted" }),
    });

    renderWithProviders(<><DrawerHost /><PathProbe /></>, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Book on the Calendar" }));

    await waitFor(() => expect(api.convertLead).toHaveBeenCalledWith("lead-1", undefined));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/calendar?schedule=visit-new"));
    expect(screen.queryByText(/Pick a start date/)).not.toBeInTheDocument();
  });

  it("a lead whose visit is booked offers 'Reschedule or cancel on the Calendar'", async () => {
    mockCommon(lead({
      status: "converted", leadStatus: "won", customerId: "cust-1", propertyId: "prop-1",
      linkedVisit: { id: "visit-9", status: "estimate", scheduledStart: "2026-10-15T13:00:00.000Z", scheduledEnd: "2026-10-15T15:00:00.000Z", estimatedDurationDays: null, jobType: "Panel upgrade", purpose: null },
    }));

    renderWithProviders(<><DrawerHost /><PathProbe /></>, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Reschedule or cancel on the Calendar" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/calendar?schedule=visit-9");
  });

  it("removes a lead from the campaign list from the same badge that added it", async () => {
    mockCommon(lead({}));
    vi.spyOn(api, "campaignLeadMembership").mockResolvedValue({ leadIds: ["lead-1"] });
    vi.spyOn(api, "removeLeadFromCampaign").mockResolvedValue({ removed: 1 });

    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });

    const removeButton = await within(dialog).findByRole("button", { name: /On email campaign — remove/ });
    fireEvent.click(removeButton);

    await waitFor(() => expect(api.removeLeadFromCampaign).toHaveBeenCalledWith("lead-1"));
  });
});
