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
 * Fixtures for the account summary with jobs. (The photo-gallery cases that used to live in this
 * file moved to PropertyDetailPage.test.tsx on 2026-10-24: photos are organized per property.)
 *
 * Jobs in these fixtures are `archived: true` so they land in the collapsed "Past jobs &
 * consultations" section and JobCard never renders — this file is about the account page's own
 * cards, not about satisfying JobCard's full cost-breakdown shape.
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

describe("AccountDetailPage — estimates, invoices, findings and photos moved to the property (Kyle, 2026-10-24)", () => {
  const prop1 = { id: "prop-1", name: "Main House", addressLine1: "123 Main St", addressLine2: null, city: "Murfreesboro", state: "TN", postalCode: "37130", occupancyType: "residential", jurisdictionId: "murfreesboro", notes: null, activeJobCount: 0, completedJobCount: 1, lastInspectionDate: null, openFindingCount: 0, openDefectCount: 0 };
  const job1 = {
    visitId: "visit-1", propertyId: "prop-1", propertyLabel: "Main House — 123 Main St", status: "completed", archived: true,
    jobType: "Panel upgrade", purpose: null, mode: "remodel", visitDate: "2026-09-01T12:00:00.000Z",
    scheduledStart: null, scheduledEnd: null, costs: zeroCosts(), purchaseOrders: [], receipts: [], documents: [], latestEstimate: null,
  };

  it("carries none of the four sections, and says on the Addresses card where they went", async () => {
    const base = accountSummaryWithJobs({ properties: [prop1], jobs: [job1] });
    mockAccountReadsFor(
      {
        ...base,
        // Signed documents and findings are still in the payload — the page just no longer lists them.
        documents: [{ id: "doc-1", type: "estimate_customer", audience: "customer", estimateNumber: "E-1", isChangeOrder: false, invoiceNumber: null, estimateId: "est-1", draftId: null, customerEmail: "jane@example.com", signedByName: "Jane", signedAt: "2026-09-02T12:00:00.000Z", createdAt: "2026-09-02T12:00:00.000Z", propertyId: "prop-1" }],
        findings: [],
      } as unknown as AccountSummary,
      {},
    );

    renderAccountPage();

    // Wait for the page (the Addresses card), then assert absence.
    await screen.findByText("Estimates, invoices, findings and photos are on each property — Open Property");
    expect(screen.getByRole("link", { name: "Open Property" })).toHaveAttribute("href", "/properties/prop-1");
    expect(screen.queryByRole("heading", { name: "Photos" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Estimates/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Invoices" })).not.toBeInTheDocument();
    expect(screen.queryByText("Finding ledger")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Email the signed copy/ })).not.toBeInTheDocument();
    // The estimates list is not even fetched here any more.
    expect(api.accountEstimates).not.toHaveBeenCalled();
    expect(api.propertyPhotos).not.toHaveBeenCalled();
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

describe("AccountDetailPage — pending card fees are said on the first figures shown (ruling 6; review finding, 2026-10-09)", () => {
  const prop = { id: "prop-1", name: "Main House", addressLine1: "123 Main St", addressLine2: null, city: "Murfreesboro", state: "TN", postalCode: "37130", occupancyType: "residential", jurisdictionId: "murfreesboro", notes: null, activeJobCount: 1, completedJobCount: 0, lastInspectionDate: null, openFindingCount: 0, openDefectCount: 0 };
  const pendingReason = "Stripe has not settled this payment yet — its processing fee is not known.";
  // A card-paid job with NO P.O., receipt or document: it has no "Cost detail" toggle at all, so
  // the card's own headline is the only place the pending state can be seen.
  const cardPaidJob = {
    visitId: "visit-1", propertyId: "prop-1", propertyLabel: "Main House — 123 Main St", status: "contracted", archived: false,
    jobType: "Panel upgrade", purpose: null, mode: "remodel", visitDate: "2026-09-01T12:00:00.000Z",
    scheduledStart: null, scheduledEnd: null,
    costs: { ...zeroCosts(), revenue: 3000, totalCost: 400, grossProfit: 2600, margin: 87, synchronyCut: 0, cardFees: 0, cardFeesPending: [{ paymentId: "pay-1", amount: 1000, reason: pendingReason }] },
    purchaseOrders: [], receipts: [], documents: [], latestEstimate: null,
  };

  it("the job card's Cost and Profit are labelled 'before pending card fees' with the reason on the card, and the lifetime tiles say the same", async () => {
    const base = accountSummaryWithJobs({ properties: [prop], jobs: [cardPaidJob] });
    mockAccountReadsFor(
      { ...base, totals: { ...base.totals, lifetimeRevenue: 3000, lifetimeCost: 400, lifetimeProfit: 2600, lifetimeMargin: 87, cardFeesPendingCount: 1 } },
      { "prop-1": { jobPhotos: [], assessmentPhotos: [] } },
    );

    renderAccountPage();

    // The lifetime tiles — the first figures on the page.
    expect(await screen.findByText("Lifetime cost (before pending card fees)")).toBeInTheDocument();
    expect(screen.getByText("Lifetime profit (before pending card fees)")).toBeInTheDocument();
    expect(screen.getAllByText("1 card payment pending with Stripe — see the job's cost detail").length).toBeGreaterThan(0);

    // The job card's headline, with no toggle to open.
    expect(screen.getByText("Cost (before pending card fees)")).toBeInTheDocument();
    expect(screen.getByText("Profit (before pending card fees)")).toBeInTheDocument();
    expect(screen.getByText(`Card processing fees: 1 card payment pending — ${pendingReason}. Cost and profit above are before those fees.`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cost detail/ })).not.toBeInTheDocument();
  });

  it("with every fee in, the plain labels stand", async () => {
    const settled = { ...cardPaidJob, costs: { ...cardPaidJob.costs, cardFees: 29.3, cardFeesPending: [] } };
    const base = accountSummaryWithJobs({ properties: [prop], jobs: [settled] });
    mockAccountReadsFor({ ...base, totals: { ...base.totals, cardFeesPendingCount: 0 } }, { "prop-1": { jobPhotos: [], assessmentPhotos: [] } });

    renderAccountPage();

    expect(await screen.findByText("Lifetime cost")).toBeInTheDocument();
    expect(screen.getByText("Lifetime profit")).toBeInTheDocument();
    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getByText("Profit")).toBeInTheDocument();
    expect(screen.queryByText(/before pending card fees/)).not.toBeInTheDocument();
  });
});
