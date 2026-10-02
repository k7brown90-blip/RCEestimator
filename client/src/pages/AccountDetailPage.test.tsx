/**
 * AccountDetailPage render test — the conversation log's home (plan item F, 2026-10-01).
 *
 * Kyle: "Notes should be account based for an admin that is answering calls and dispatching."
 * Pins that the account page carries the "Conversation notes" card with the account's notes,
 * newest first as the server returns them, and that "Add note" files a note on this account
 * WITHOUT a job tag (the job drawer is the surface that tags).
 *
 * This page reads `:accountId` off the route (useParams), so like VisitWorkspacePage.test.tsx it
 * needs a real <Route> under the MemoryRouter that renderWithProviders supplies — without one,
 * useParams() is {} and the page sits on "Loading account…" forever.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { AccountDetailPage } from "./AccountDetailPage";
import { api } from "../lib/api";
import type { CustomerContact, CustomerNote, PropertyPhotos } from "../lib/api";
import type { AccountSummary } from "../lib/types";

// The gallery's "+ Add photos" downscales the file in-browser before upload (lib/images.ts,
// shared with every other photo-upload path). createImageBitmap/canvas don't exist in jsdom —
// mock it the same way the component's own contract is tested elsewhere: a fixed data URL in,
// the real upload call out.
vi.mock("../lib/images", () => ({
  downscale: vi.fn(async () => "data:image/jpeg;base64,ZmFrZQ=="),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const summary = {
  account: { id: "cust-1", name: "Jane Homeowner", email: "jane@example.com", phone: "615-555-0100", createdAt: "2026-09-01T12:00:00.000Z", isTestAccount: false },
  properties: [],
  jobs: [],
  totals: {
    lifetimeRevenue: 0, lifetimeCost: 0, lifetimeProfit: 0, lifetimeMargin: null, activeJobCount: 0, completedJobCount: 0,
    propertyCount: 0, lifetimeCollected: 0, lifetimeCustomerPaid: 0, lifetimeWarrantyPaid: 0, lifetimePaymentCount: 0, lastPaidAt: null,
  },
  documents: [],
} as unknown as AccountSummary;

function note(overrides: Partial<CustomerNote> = {}): CustomerNote {
  return {
    id: "note-1", customerId: "cust-1", visitId: null, body: "Called about flickering in the kitchen.", takenBy: "Kyle",
    createdAt: "2026-09-30T14:05:00.000Z", updatedAt: "2026-09-30T14:05:00.000Z", visit: null, ...overrides,
  };
}

function mockAccountReads(notes: CustomerNote[]) {
  vi.spyOn(api, "accountSummary").mockResolvedValue(summary);
  vi.spyOn(api, "accountNotes").mockResolvedValue(notes);
  vi.spyOn(api, "accountContacts").mockResolvedValue([]);
  vi.spyOn(api, "accountEstimates").mockResolvedValue({ estimates: [] } as never);
  vi.spyOn(api, "customerInspections").mockResolvedValue([]);
  vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
    </Routes>,
    { route: "/accounts/cust-1" },
  );
}

describe("AccountDetailPage — conversation notes", () => {
  it("shows the account's conversation log, newest first, with who took each call", async () => {
    mockAccountReads([
      note({ id: "n-2", body: "Second call: wants Tuesday.", takenBy: "Eric", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T09:00:00.000Z" }),
      note({ id: "n-1", body: "First call." }),
    ]);

    renderPage();

    const card = await screen.findByRole("region", { name: "Conversation notes" });
    expect(within(card).getByRole("heading", { name: "Conversation notes" })).toBeInTheDocument();
    // The card renders before its notes arrive — wait for the rows, not the frame.
    const items = await within(card).findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Second call: wants Tuesday.");
    expect(items[0]).toHaveTextContent("Taken by Eric");
    expect(items[1]).toHaveTextContent("First call.");
    expect(items[1]).toHaveTextContent("Taken by Kyle");
    // Every note has its way out, on the row.
    expect(within(items[0]).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(items[0]).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(api.accountNotes).toHaveBeenCalledWith("cust-1");
  });

  it("'Add note' files a note on this account with no job tag", async () => {
    mockAccountReads([]);
    const add = vi.spyOn(api, "addAccountNote").mockResolvedValue(note());

    renderPage();

    const card = await screen.findByRole("region", { name: "Conversation notes" });
    expect(await within(card).findByText("No conversation notes yet.")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Add note" }));
    fireEvent.change(within(card).getByLabelText("What was said"), { target: { value: "Asked for the invoice again." } });
    fireEvent.change(within(card).getByLabelText("Taken by"), { target: { value: "Kyle" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(add).toHaveBeenCalledWith("cust-1", { body: "Asked for the invoice again.", takenBy: "Kyle", visitId: null }));
  });
});

/**
 * AccountPhotoGallery — item H, 2026-10-01. Five change requests, all one theme:
 *
 *   "I should be able to upload photos on this screen here." (/accounts/:id)
 *   "This is not allowing me to attach job photos here. ... the attached photos should prompt a
 *   job selection but can all be viewed from a single place. I dont want to click through
 *   different jobs to find a photo I am looking for." (/accounts/:id)
 *
 * The account page used to show photos read-only, one collapsed accordion per property
 * (PropertyPhotoSection). This replaces that with one upload-capable gallery spanning every
 * property/job on the account. Upload reuses `api.uploadVisitPhoto` (the exact same call the
 * visit-page gallery makes) — a photo still belongs to a visit, so the control asks which job.
 *
 * Jobs in these fixtures are `archived: true` so they land in the collapsed "Past jobs &
 * consultations" section and JobCard never renders — this file is about the photo gallery, not
 * about satisfying JobCard's full cost-breakdown shape.
 */
function zeroCosts() {
  return { estimatedCost: null, materialCost: 0, laborHours: 0, laborRate: 0, laborCost: 0, overhead: 0, totalCost: 0, revenue: 0, grossProfit: 0, margin: null };
}

function accountSummaryWithJobs(overrides: { properties: unknown[]; jobs: unknown[] }): AccountSummary {
  return {
    account: { id: "cust-1", name: "Jane Homeowner", email: "jane@example.com", phone: "615-555-0100", createdAt: "2026-09-01T12:00:00.000Z", isTestAccount: false },
    properties: overrides.properties,
    jobs: overrides.jobs,
    totals: {
      lifetimeRevenue: 0, lifetimeCost: 0, lifetimeProfit: 0, lifetimeMargin: null, activeJobCount: 0, completedJobCount: 0,
      propertyCount: overrides.properties.length, lifetimeCollected: 0, lifetimeCustomerPaid: 0, lifetimeWarrantyPaid: 0, lifetimePaymentCount: 0, lastPaidAt: null,
    },
    documents: [],
  } as unknown as AccountSummary;
}

function mockAccountReadsFor(summary: AccountSummary, photosByProperty: Record<string, PropertyPhotos>) {
  vi.spyOn(api, "accountSummary").mockResolvedValue(summary);
  vi.spyOn(api, "accountNotes").mockResolvedValue([]);
  vi.spyOn(api, "accountContacts").mockResolvedValue([]);
  vi.spyOn(api, "accountEstimates").mockResolvedValue({ estimates: [] } as never);
  vi.spyOn(api, "customerInspections").mockResolvedValue([]);
  vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
  vi.spyOn(api, "propertyPhotos").mockImplementation(async (propertyId: string) => photosByProperty[propertyId] ?? { jobPhotos: [], assessmentPhotos: [] });
}

function renderAccountPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
    </Routes>,
    { route: "/accounts/cust-1" },
  );
}

describe("AccountDetailPage — account-wide photo gallery", () => {
  const prop1 = { id: "prop-1", name: "Main House", addressLine1: "123 Main St", addressLine2: null, city: "Murfreesboro", state: "TN", postalCode: "37130", occupancyType: "residential", jurisdictionId: "murfreesboro", notes: null, activeJobCount: 0, completedJobCount: 1, lastInspectionDate: null, openFindingCount: 0, openDefectCount: 0 };
  const prop2 = { id: "prop-2", name: "Rental", addressLine1: "456 Oak Ave", addressLine2: null, city: "Smyrna", state: "TN", postalCode: "37167", occupancyType: "residential", jurisdictionId: "rutherford", notes: null, activeJobCount: 0, completedJobCount: 1, lastInspectionDate: null, openFindingCount: 0, openDefectCount: 0 };

  const job1 = {
    visitId: "visit-1", propertyId: "prop-1", propertyLabel: "Main House — 123 Main St", status: "completed", archived: true,
    jobType: "Panel upgrade", purpose: null, mode: "remodel", visitDate: "2026-09-01T12:00:00.000Z",
    scheduledStart: null, scheduledEnd: null, costs: zeroCosts(), purchaseOrders: [], receipts: [], documents: [], latestEstimate: null,
  };
  const job2 = {
    visitId: "visit-2", propertyId: "prop-2", propertyLabel: "Rental — 456 Oak Ave", status: "completed", archived: true,
    jobType: null, purpose: "Consultation", mode: "service_diagnostic", visitDate: "2026-09-25T12:00:00.000Z",
    scheduledStart: null, scheduledEnd: null, costs: zeroCosts(), purchaseOrders: [], receipts: [], documents: [], latestEstimate: null,
  };

  it("with no jobs on the account, the upload control is greyed with the reason shown on screen, not hidden", async () => {
    mockAccountReadsFor(
      accountSummaryWithJobs({ properties: [prop1], jobs: [] }),
      {},
    );

    renderAccountPage();

    const section = await screen.findByRole("heading", { name: "Photos" });
    const card = section.closest("section")!;
    expect(within(card).getByText("No jobs on this account yet — create a job before adding photos.")).toBeInTheDocument();
    // The control is disabled, not removed — a person can see why, right next to it.
    expect(within(card).getByLabelText("+ Add photos")).toBeDisabled();
  });

  it("with exactly one job, upload doesn't make him choose — it says which job it is", async () => {
    mockAccountReadsFor(
      accountSummaryWithJobs({ properties: [prop1], jobs: [job1] }),
      { "prop-1": { jobPhotos: [], assessmentPhotos: [] } },
    );

    renderAccountPage();

    const section = await screen.findByRole("heading", { name: "Photos" });
    const card = section.closest("section")!;
    expect(within(card).getByText(/Adding to: Panel upgrade — Main House — 123 Main St/)).toBeInTheDocument();
    expect(within(card).queryByLabelText("Which job are these photos for?")).not.toBeInTheDocument();
    expect(within(card).getByLabelText("+ Add photos")).not.toBeDisabled();
  });

  it("with more than one job, prompts a job selection, and shows one gallery spanning both jobs/properties", async () => {
    mockAccountReadsFor(
      accountSummaryWithJobs({ properties: [prop1, prop2], jobs: [job1, job2] }),
      {
        "prop-1": { jobPhotos: [{ id: "photo-1", mimeType: "image/jpeg", sizeBytes: 100, caption: "Old panel", tag: null, uploadedAt: "2026-09-01T12:05:00.000Z", visitId: "visit-1", visitDate: "2026-09-01T12:00:00.000Z", purpose: null, jobType: "Panel upgrade" }], assessmentPhotos: [] },
        "prop-2": { jobPhotos: [{ id: "photo-2", mimeType: "image/jpeg", sizeBytes: 100, caption: null, tag: null, uploadedAt: "2026-09-25T09:05:00.000Z", visitId: "visit-2", visitDate: "2026-09-25T09:00:00.000Z", purpose: "Consultation", jobType: null }], assessmentPhotos: [] },
      } as unknown as Record<string, PropertyPhotos>,
    );

    renderAccountPage();

    const section = await screen.findByRole("heading", { name: "Photos" });
    const card = section.closest("section")!;

    // Prompts a job selection — a select listing both jobs, newest first.
    const select = within(card).getByLabelText("Which job are these photos for?") as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels[0]).toBe("Which job are these photos for?");
    expect(optionLabels[1]).toMatch(/^Consultation — Rental — 456 Oak Ave/); // visit-2 is newer
    expect(optionLabels[2]).toMatch(/^Panel upgrade — Main House — 123 Main St/);

    // Upload is disabled until a job is chosen.
    expect(within(card).getByLabelText("+ Add photos")).toBeDisabled();

    // One gallery, both jobs' photos, each labelled with its own job/address — no per-job
    // accordion to click through. Scoped to the figure captions, not the job-picker <option>s,
    // which share the same job label text.
    await waitFor(() => expect(within(card).getByText(/Old panel/)).toBeInTheDocument());
    const captions = card.querySelectorAll("figcaption");
    expect(captions.length).toBe(2);
    expect(captions[0]).toHaveTextContent(/Consultation — Rental — 456 Oak Ave/); // newest first
    expect(captions[1]).toHaveTextContent(/Panel upgrade — Main House — 123 Main St/);
  });

  it("uploads through the existing visit-photo endpoint once a job is chosen", async () => {
    mockAccountReadsFor(
      accountSummaryWithJobs({ properties: [prop1, prop2], jobs: [job1, job2] }),
      { "prop-1": { jobPhotos: [], assessmentPhotos: [] }, "prop-2": { jobPhotos: [], assessmentPhotos: [] } },
    );
    const upload = vi.spyOn(api, "uploadVisitPhoto").mockResolvedValue({
      id: "photo-new", mimeType: "image/jpeg", sizeBytes: 100, caption: null, tag: null, uploadedAt: "2026-10-01T00:00:00.000Z",
    });

    renderAccountPage();

    const section = await screen.findByRole("heading", { name: "Photos" });
    const card = section.closest("section")!;
    const select = within(card).getByLabelText("Which job are these photos for?");
    fireEvent.change(select, { target: { value: "visit-2" } });

    const fileInput = within(card).getByLabelText("+ Add photos");
    const file = new File(["fake"], "panel.jpg", { type: "image/jpeg" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith("visit-2", { dataUrl: "data:image/jpeg;base64,ZmFrZQ==", tag: null }),
    );
  });
});

/**
 * Plan item B, 2026-10-02 — "The account page is about the CUSTOMER."
 *
 * The "Start work" card (Book consultation / Open a visit / Start an estimate) is removed from
 * this page: those doors moved to the property page (Schedule Consultation / Create New Estimate
 * on PropertyDetailPage.tsx, plan item C). This file only proves the card and its three buttons
 * are gone from the ACCOUNT page — PropertyDetailPage has its own test file for the replacements.
 *
 * Additional contacts move INTO the contact card (Kyle, 2026-10-02): "When an additional contact
 * is added it should be shown along side the main contact in the contact card." They used to sit
 * in their own "Additional contacts" section below Addresses.
 */
describe("AccountDetailPage — Start work removed, additional contacts in the contact card", () => {
  const prop1 = { id: "prop-1", name: "Main House", addressLine1: "123 Main St", addressLine2: null, city: "Murfreesboro", state: "TN", postalCode: "37130", occupancyType: "residential", jurisdictionId: "murfreesboro", notes: null, activeJobCount: 0, completedJobCount: 0, lastInspectionDate: null, openFindingCount: 0, openDefectCount: 0 };

  function accountSummaryWithOneProperty(): AccountSummary {
    return {
      account: { id: "cust-1", name: "Jane Homeowner", email: "jane@example.com", phone: "615-555-0100", createdAt: "2026-09-01T12:00:00.000Z", isTestAccount: false },
      properties: [prop1],
      jobs: [],
      totals: {
        lifetimeRevenue: 0, lifetimeCost: 0, lifetimeProfit: 0, lifetimeMargin: null, activeJobCount: 0, completedJobCount: 0,
        propertyCount: 1, lifetimeCollected: 0, lifetimeCustomerPaid: 0, lifetimeWarrantyPaid: 0, lifetimePaymentCount: 0, lastPaidAt: null,
      },
      documents: [],
    } as unknown as AccountSummary;
  }

  /** `api.accountContacts` backed by a mutable array, so add/edit/remove visibly round-trip. */
  function mockAccountReadsWithContacts(initialContacts: CustomerContact[]) {
    let contacts = [...initialContacts];
    vi.spyOn(api, "accountSummary").mockResolvedValue(accountSummaryWithOneProperty());
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);
    vi.spyOn(api, "accountContacts").mockImplementation(async () => contacts);
    vi.spyOn(api, "accountEstimates").mockResolvedValue({ estimates: [] } as never);
    vi.spyOn(api, "customerInspections").mockResolvedValue([]);
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    const add = vi.spyOn(api, "addAccountContact").mockImplementation(async (_accountId, input) => {
      const created: CustomerContact = {
        id: `contact-${contacts.length + 1}`,
        customerId: "cust-1",
        label: input.label,
        email: input.email ?? null,
        phone: input.phone ?? null,
        createdAt: "2026-10-02T00:00:00.000Z",
      };
      contacts = [...contacts, created];
      return created;
    });
    const del = vi.spyOn(api, "deleteAccountContact").mockImplementation(async (_accountId, contactId) => {
      contacts = contacts.filter((c) => c.id !== contactId);
    });
    // Edits IN PLACE — same id, same position in the list. The old add-then-delete could do
    // neither, which is the whole point of the route this replaces.
    const patch = vi.spyOn(api, "patchAccountContact").mockImplementation(async (_accountId, contactId, input) => {
      let updated: CustomerContact | undefined;
      contacts = contacts.map((c) => {
        if (c.id !== contactId) return c;
        updated = {
          ...c,
          label: input.label ?? c.label,
          email: input.email === undefined ? c.email : input.email,
          phone: input.phone === undefined ? c.phone : input.phone,
        };
        return updated;
      });
      if (!updated) throw new Error("Contact not found on this account.");
      return updated;
    });
    return { add, del, patch };
  }

  function renderPage() {
    return renderWithProviders(
      <Routes>
        <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
      </Routes>,
      { route: "/accounts/cust-1" },
    );
  }

  it("has no 'Start work' card and none of its three buttons", async () => {
    mockAccountReadsWithContacts([]);

    renderPage();

    // Wait for the page to finish loading before asserting absence.
    await screen.findByText("Jane Homeowner");
    expect(screen.queryByRole("heading", { name: "Start work" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Book consultation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open a visit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start an estimate" })).not.toBeInTheDocument();
  });

  it("shows an additional contact beside the main contact, in the same contact card", async () => {
    mockAccountReadsWithContacts([
      { id: "contact-1", customerId: "cust-1", label: "Spouse — cell", email: null, phone: "615-555-0199", createdAt: "2026-09-01T00:00:00.000Z" },
    ]);

    renderPage();

    const heading = await screen.findByRole("heading", { name: "Additional contacts" });
    const card = heading.closest(".card") as HTMLElement;
    // The main contact's email/phone and the additional contact's row are in the SAME card.
    // The additional-contacts list loads via its own query, after the heading — wait for its row.
    await within(card).findByText("Spouse — cell");
    expect(within(card).getByText("jane@example.com")).toBeInTheDocument();
    expect(within(card).getByText("615-555-0100")).toBeInTheDocument();
    expect(within(card).getByText("615-555-0199")).toBeInTheDocument();
  });

  it("adds, edits and removes an additional contact from the contact card", async () => {
    const { add, del, patch } = mockAccountReadsWithContacts([]);

    renderPage();

    const heading = await screen.findByRole("heading", { name: "Additional contacts" });
    const card = heading.closest(".card") as HTMLElement;

    expect(within(card).getByText("No additional contacts yet.")).toBeInTheDocument();

    // Add.
    fireEvent.change(within(card).getByPlaceholderText("Label (Spouse — cell)"), { target: { value: "Spouse — cell" } });
    fireEvent.change(within(card).getByPlaceholderText("Phone (optional)"), { target: { value: "615-555-0199" } });
    fireEvent.click(within(card).getByRole("button", { name: "Add contact" }));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith("cust-1", { label: "Spouse — cell", email: null, phone: "615-555-0199" }),
    );
    await within(card).findByText("615-555-0199");

    // Edit — populate from the row, change the phone, save.
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    const phoneField = within(card).getByDisplayValue("615-555-0199");
    fireEvent.change(phoneField, { target: { value: "615-555-0222" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("cust-1", "contact-1", {
        label: "Spouse — cell",
        email: null,
        phone: "615-555-0222",
      }),
    );
    await within(card).findByText("615-555-0222");
    expect(within(card).queryByText("615-555-0199")).not.toBeInTheDocument();

    // THE REGRESSION THIS REPLACES (2026-10-01): saving an edit used to POST a new contact and
    // then DELETE the old one, so a failure between the two left a DUPLICATE on this card. One
    // call now — `add` stays at the single call from the Add step above, and nothing was deleted.
    expect(add).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();

    // Remove. The id is still contact-1, not contact-2 — the edit kept the row rather than
    // recreating it, which is also what keeps it in place in a list ordered by createdAt.
    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("cust-1", "contact-1"));
    await within(card).findByText("No additional contacts yet.");
  });
});
