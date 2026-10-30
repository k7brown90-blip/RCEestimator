/**
 * The lead drawer: the Leads card's actions plus the edit form in place — and the E1 guard:
 * `smsConsent` is tri-state, shown as words, never a control, and never in a PATCH payload.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import { DrawerHost } from "./DrawerHost";
import { LeadsPage } from "../../pages/LeadsPage";
import { ApiError, api } from "../../lib/api";
import type { Lead, LeadBookingChat, LeadPhotoMeta, Visit } from "../../lib/types";

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

/*
  WEBSITE CHAT (plan 2026-10-30-website-booking-chat, U3). A homeowner who used the chat on the
  website leaves a lead with a held time on the calendar. The drawer's "Website chat" section shows
  what they said and showed and is the ONE place to confirm or release the hold.
*/
function chatFixture(overrides: Partial<LeadBookingChat> = {}): LeadBookingChat {
  return {
    id: "chat-1", status: "held", srcParam: "gbp", platform: "google",
    priority: true, priorityQuote: "there is a burning smell from the outlet",
    originalRequest: "Kitchen outlet stopped working",
    squareFootage: "2400", yearBuilt: "1998",
    concerns: [{ room: "Kitchen", description: "Outlet by the sink is dead", photoId: "ph-concern" }],
    questionsForKyle: ["Can you come on Saturday instead?"],
    prepAreas: ["Kitchen", "Garage"],
    transcript: [
      { role: "assistant", content: "Hi, this is Red Cedar Electric's scheduling assistant (AI).", at: "2026-11-02T15:00:00.000Z" },
      { role: "user", content: "My kitchen outlet is dead", at: "2026-11-02T15:00:30.000Z" },
    ],
    heldStart: "2026-11-10T14:00:00.000Z", heldEnd: "2026-11-10T16:00:00.000Z",
    heldLabel: "Tuesday, November 10, 8:00 AM – 10:00 AM",
    messageCount: 6, lastActivityAt: "2026-11-02T15:05:00.000Z", kyleNotifiedAt: null,
    confirmedAt: null, releasedAt: null, createdAt: "2026-11-02T15:00:00.000Z",
    ...overrides,
  };
}

const concernPhoto: LeadPhotoMeta = { id: "ph-concern", kind: "concern", room: "Kitchen", caption: null, mimeType: "image/jpeg", sizeBytes: 100, uploadedAt: "2026-11-02T15:01:00.000Z" };
const panelPhoto: LeadPhotoMeta = { id: "ph-panel", kind: "panel", room: "Garage", caption: null, mimeType: "image/jpeg", sizeBytes: 100, uploadedAt: "2026-11-02T15:02:00.000Z" };

function chatLead(chat: Partial<LeadBookingChat> = {}, photos: LeadPhotoMeta[] = [concernPhoto, panelPhoto], overrides: Partial<Lead> = {}): Lead {
  return lead({ source: "web", urgentFlag: true, bookingChat: chatFixture(chat), photos, ...overrides });
}

function mockPhotos() {
  vi.spyOn(api, "leadPhotoUrl").mockImplementation((_leadId, photoId) => Promise.resolve(`blob:photo-${photoId}`));
}

const HELD_LABEL = "Tuesday, November 10, 8:00 AM – 10:00 AM";

describe("LeadDrawer — Website chat", () => {
  it("shows everything the homeowner said and showed, in the order Kyle reads it", async () => {
    mockCommon(chatLead());
    mockPhotos();
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    const section = await within(dialog).findByRole("region", { name: "Website chat" });

    // Status + the held slot, prominently.
    expect(within(section).getByText("Time held — waiting for you to confirm")).toBeInTheDocument();
    expect(within(section).getByText(`Held: ${HELD_LABEL}`)).toBeInTheDocument();
    // PRIORITY, in the customer's exact words.
    const alert = within(section).getByRole("alert");
    expect(alert).toHaveTextContent("Priority");
    expect(alert).toHaveTextContent("“there is a burning smell from the outlet”");
    // Everything else.
    expect(within(section).getByText("Kitchen outlet stopped working")).toBeInTheDocument();
    expect(within(section).getByText("Outlet by the sink is dead")).toBeInTheDocument();
    expect(await within(section).findByAltText("Photo — Kitchen")).toHaveAttribute("src", "blob:photo-ph-concern");
    expect(within(section).getByText("2400")).toBeInTheDocument();
    expect(within(section).getByText("1998")).toBeInTheDocument();
    expect(await within(section).findByAltText("Electrical panel photo")).toHaveAttribute("src", "blob:photo-ph-panel");
    expect(within(section).getByText("Can you come on Saturday instead?")).toBeInTheDocument();
    expect(within(section).getByText("Kitchen · Garage")).toBeInTheDocument();
    // Photos are fetched with the session, never as a bare protected URL.
    expect(api.leadPhotoUrl).toHaveBeenCalledWith("lead-1", "ph-concern");
    expect(dialog.querySelector("img[src*='/leads/']")).toBeNull();

    // Priority first, request after; the transcript is collapsed until asked for.
    const text = section.textContent ?? "";
    expect(text.indexOf("Priority")).toBeLessThan(text.indexOf("Original request"));
    expect(text.indexOf("Original request")).toBeLessThan(text.indexOf("Concerns"));
    expect(text.indexOf("Panel photo")).toBeLessThan(text.indexOf("Questions for Kyle"));
    expect(text.indexOf("Questions for Kyle")).toBeLessThan(text.indexOf("Prep areas"));
    expect(text.indexOf("Prep areas")).toBeLessThan(text.indexOf("Transcript"));
    const details = section.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
  });

  it("says 'not provided' when there is no panel photo, and shows no priority banner for a normal lead", async () => {
    mockCommon(chatLead({ priority: false, priorityQuote: null }, [concernPhoto]));
    mockPhotos();
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    const section = await within(dialog).findByRole("region", { name: "Website chat" });
    expect(within(section).getByText("not provided")).toBeInTheDocument();
    expect(within(section).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers Confirm booking and Release hold only while a time is held", async () => {
    for (const status of ["unbooked", "confirmed", "released", "out_of_scope", "open"] as const) {
      vi.restoreAllMocks();
      mockCommon(chatLead({ status, heldLabel: status === "confirmed" ? HELD_LABEL : null }));
      mockPhotos();
      const { unmount } = renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
      const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
      await within(dialog).findByRole("region", { name: "Website chat" });
      expect(within(dialog).queryByRole("button", { name: "Confirm booking" }), status).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Release hold" }), status).not.toBeInTheDocument();
      unmount();
    }
    vi.restoreAllMocks();
    mockCommon(chatLead());
    mockPhotos();
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    expect(await within(dialog).findByRole("button", { name: "Confirm booking" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Release hold" })).toBeInTheDocument();
  });

  it("a confirmed booking still shows what was booked", async () => {
    mockCommon(chatLead({ status: "confirmed" }));
    mockPhotos();
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    expect(await within(dialog).findByText(`Booked: ${HELD_LABEL}`)).toBeInTheDocument();
    expect(within(dialog).getByText("Booking confirmed")).toBeInTheDocument();
  });

  it("replaces 'Book on the Calendar' while a chat holds a slot, and says why", async () => {
    mockCommon(chatLead());
    mockPhotos();
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    await within(dialog).findByRole("button", { name: "Confirm booking" });
    expect(within(dialog).queryByRole("button", { name: "Book on the Calendar" })).not.toBeInTheDocument();
    const why = within(dialog).getByTestId("book-door-replaced");
    expect(why).toHaveTextContent(/replaced by Confirm booking/);
    expect(why).toHaveTextContent(HELD_LABEL);
  });

  it("a chat lead whose hold is gone (released) books the ordinary way again", async () => {
    mockCommon(chatLead({ status: "released", heldLabel: null }));
    mockPhotos();
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    await within(dialog).findByRole("region", { name: "Website chat" });
    expect(within(dialog).getByRole("button", { name: "Book on the Calendar" })).toBeInTheDocument();
    expect(within(dialog).queryByTestId("book-door-replaced")).not.toBeInTheDocument();
  });

  it("Confirm booking asks first, then makes ONE server call and reports what happened", async () => {
    mockCommon(chatLead());
    mockPhotos();
    vi.spyOn(api, "confirmBooking").mockResolvedValue({
      visitId: "visit-new", customerId: "cust-1", scheduledStart: "2026-11-10T14:00:00.000Z", scheduledEnd: "2026-11-10T16:00:00.000Z",
      label: HELD_LABEL, photosCopied: 2, customerEmail: "jane@example.com", kyleEmailed: true, warnings: [],
    });
    vi.spyOn(api, "convertLead");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    const button = await within(dialog).findByRole("button", { name: "Confirm booking" });

    fireEvent.click(button); // says no
    expect(api.confirmBooking).not.toHaveBeenCalled();
    fireEvent.click(button); // says yes
    await waitFor(() => expect(api.confirmBooking).toHaveBeenCalledWith("lead-1", undefined));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(api.convertLead).not.toHaveBeenCalled(); // one operation, not convert-then-book
    expect(await within(dialog).findByText(/Booking confirmed — Tuesday, November 10, 8:00 AM – 10:00 AM\. Confirmation emailed to jane@example\.com\. 2 photos put on the job\./)).toBeInTheDocument();
  });

  it("a possible duplicate account opens the same picker, and its answer goes back to Confirm booking", async () => {
    mockCommon(chatLead());
    mockPhotos();
    const match = {
      customerId: "cust-7", name: "Jane Homeowner", email: "jane@example.com", phone: "+16155551234", score: 90, matchedOn: ["phone" as const],
      properties: [{ id: "prop-7", name: "Home", addressLine1: "12 Main St", addressLine2: null, city: "Smyrna", state: "TN", postalCode: "37167" }],
      visitCount: 2, lastVisitAt: null,
    };
    vi.spyOn(api, "confirmBooking")
      .mockRejectedValueOnce(Object.assign(new ApiError("Possible duplicate account"), { status: 409, body: { error: "Possible duplicate account", matches: [match] } }))
      .mockResolvedValueOnce({
        visitId: "visit-new", customerId: "cust-7", scheduledStart: "", scheduledEnd: "", label: HELD_LABEL,
        photosCopied: 0, customerEmail: "jane@example.com", kyleEmailed: true, warnings: [],
      });
    vi.spyOn(api, "convertLead");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });

    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm booking" }));
    const picker = await screen.findByRole("dialog", { name: /might already be a customer/ });
    fireEvent.click(within(picker).getByRole("button", { name: /Use Home — 12 Main St, Smyrna/ }));

    await waitFor(() => expect(api.confirmBooking).toHaveBeenLastCalledWith("lead-1", { customerId: "cust-7", propertyId: "prop-7" }));
    expect(api.convertLead).not.toHaveBeenCalled();
  });

  it("a failure to schedule is shown in words, and the hold buttons stay for another try", async () => {
    mockCommon(chatLead());
    mockPhotos();
    vi.spyOn(api, "confirmBooking").mockRejectedValue(
      Object.assign(new ApiError("The lead was converted, but the job could not be scheduled: Google is down. The hold is still in place — press Confirm booking again to retry."), { status: 502 }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm booking" }));
    expect(await within(dialog).findByText(/could not be scheduled: Google is down/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Confirm booking" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Release hold" })).toBeEnabled();
  });

  it("Release hold asks first and then frees the time", async () => {
    mockCommon(chatLead());
    mockPhotos();
    vi.spyOn(api, "releaseHold").mockResolvedValue({ released: true });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    const button = await within(dialog).findByRole("button", { name: "Release hold" });

    fireEvent.click(button);
    expect(api.releaseHold).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(api.releaseHold).toHaveBeenCalledWith("lead-1"));
    expect(String(confirmSpy.mock.calls[0][0])).toMatch(/Nothing is sent to the customer/);
    expect(await within(dialog).findByText(/Hold released/)).toBeInTheDocument();
  });

  it("each photo has its own Delete photo", async () => {
    mockCommon(chatLead());
    mockPhotos();
    vi.spyOn(api, "deleteLeadPhoto").mockResolvedValue({ deleted: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });

    fireEvent.click(await within(dialog).findByRole("button", { name: "Delete photo: Photo — Kitchen" }));
    await waitFor(() => expect(api.deleteLeadPhoto).toHaveBeenCalledWith("lead-1", "ph-concern"));
    expect(within(dialog).getByRole("button", { name: "Delete photo: Electrical panel photo" })).toBeInTheDocument();
  });

  it("a lead that never used the chat has no Website chat section and keeps its Book door", async () => {
    mockCommon(lead({ bookingChat: null, photos: [] }));
    renderWithProviders(<DrawerHost />, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    expect(within(dialog).queryByRole("region", { name: "Website chat" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Book on the Calendar" })).toBeInTheDocument();
  });

  it("Kyle's email link /leads?lead=<id> opens that lead's drawer over the Leads page", async () => {
    mockCommon(chatLead());
    mockPhotos();
    vi.spyOn(api, "leads").mockResolvedValue([chatLead()]);
    vi.spyOn(api, "crmFollowUps").mockResolvedValue({
      asOf: "2026-11-02T12:00:00.000Z", openLeadCount: 1, overdueCount: 0, dueTodayCount: 0, dueNext7DaysCount: 0, noFollowUpCount: 0, overdueLeads: [],
    });
    renderWithProviders(<><LeadsPage /><DrawerHost /></>, { route: "/leads?lead=lead-1" });
    const dialog = await screen.findByRole("dialog", { name: "Jane Homeowner" });
    expect(await within(dialog).findByRole("region", { name: "Website chat" })).toBeInTheDocument();
  });
});
