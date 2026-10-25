/**
 * PropertyDetailPage render smoke test.
 *
 * Part 1 (kept) — the duplicate "start a new visit" door (plan item I, 2026-10-01,
 * ".claude/plans/2026-10-01-manual-sends-archiving-and-one-calendar.md").
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
 *
 * Part 2 (added) — plan item C, 2026-10-02,
 * ".claude/plans/2026-10-02-account-property-and-the-estimate-that-knows-the-job.md":
 * "The property page is about the WORK at that address." The top card loses its title and
 * the "Estimates for this address" heading, and carries exactly two doors — "Schedule
 * Consultation" (creates the consultation visit and lands on the Calendar with it selected,
 * the ONE scheduler) and "Create New Estimate" (bound to this account AND address). The old
 * "System Snapshot" section is replaced by this property's read-only Health Record: the
 * findings ledger, electrical assessments, diagnostic reports, and photos — each labelled
 * with the job it came from.
 *
 * Part 3 (added) - Kyle, 2026-10-24: "I would like the invoices, and estimates to be organized on
 * the property page not on the account page. The finding ledger should be on the property page,
 * one ledger per property. Photos should be organized per property too." The Estimates, Invoices
 * and upload-capable Photos sections live here now (the photo upload cases moved here from
 * AccountDetailPage.test.tsx), and the dead "Previous Estimates" button is gone.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PropertyDetailPage } from "./PropertyDetailPage";
import { api, openProtectedPdf } from "../lib/api";
import type { AccountSummary, Property, Visit } from "../lib/types";
import type { PropertyPhotos } from "../lib/api";

// The gallery's "+ Add photos" downscales the file in-browser before upload (lib/images.ts).
// createImageBitmap/canvas don't exist in jsdom - a fixed data URL in, the real upload call out.
vi.mock("../lib/images", () => ({
  downscale: vi.fn(async () => "data:image/jpeg;base64,ZmFrZQ=="),
}));

// "View report" hands the rendered document to openProtectedPdf (a real window.open + fetch) —
// stubbed here so the test can see WHAT it was asked to open.
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  openProtectedPdf: vi.fn().mockResolvedValue(undefined),
}));

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

/** Shows the path+search the router landed on — how the tests confirm a `navigate()` fired. */
function PathProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="path">{pathname}{search}</p>;
}

/** Default, mostly-empty reads for every query PropertyDetailPage fires beyond `api.property`. */
function mockEmptyHealthRecordReads() {
  vi.spyOn(api, "ledgerFindings").mockResolvedValue([]);
  vi.spyOn(api, "propertyInspections").mockResolvedValue([]);
  vi.spyOn(api, "propertyDiagnosticReports").mockResolvedValue({ reports: [] });
  vi.spyOn(api, "propertyPhotos").mockResolvedValue({ jobPhotos: [], assessmentPhotos: [] });
}

function zeroCosts() {
  return { estimatedCost: null, materialCost: 0, laborHours: 0, laborRate: 0, laborCost: 0, overhead: 0, totalCost: 0, revenue: 0, grossProfit: 0, margin: null };
}

/** An account summary for cust-1 with whatever jobs/documents a test needs. */
function summaryWith(overrides: { jobs?: unknown[]; documents?: unknown[] } = {}): AccountSummary {
  return {
    account: { id: "cust-1", name: "Jane Homeowner", email: "jane@example.com", phone: null, createdAt: "2026-09-01T12:00:00.000Z", isTestAccount: false },
    properties: [],
    jobs: overrides.jobs ?? [],
    totals: {},
    documents: overrides.documents ?? [],
    inspections: [],
    findings: [],
  } as unknown as AccountSummary;
}

function job(overrides: Record<string, unknown>) {
  return {
    visitId: "visit-1", propertyId: "prop-1", propertyLabel: "Home — 12 Main St", status: "completed", archived: true,
    jobType: "Panel upgrade", purpose: null, mode: "remodel", visitDate: "2026-09-01T12:00:00.000Z",
    scheduledStart: null, scheduledEnd: null, costs: zeroCosts(), purchaseOrders: [], receipts: [], documents: [], latestEstimate: null,
    ...overrides,
  };
}

function signedDoc(overrides: Record<string, unknown>) {
  return {
    id: "doc-1", type: "estimate_customer", audience: "customer", estimateNumber: "E-100", isChangeOrder: false, invoiceNumber: null,
    estimateId: "est-1", draftId: null, customerEmail: "jane@example.com", signedByName: "Jane", signedAt: "2026-09-02T12:00:00.000Z",
    createdAt: "2026-09-02T12:00:00.000Z", propertyId: "prop-1",
    ...overrides,
  };
}

function renderPage(summary: AccountSummary = summaryWith()) {
  vi.spyOn(api, "property").mockResolvedValue(property);
  // Beyond the property read: this property's issued estimates, and the account summary the
  // Invoices list and the photo gallery's jobs are filtered from. Tests that care pass their own.
  if (!vi.isMockFunction(api.accountEstimates)) vi.spyOn(api, "accountEstimates").mockResolvedValue({ estimates: [] } as never);
  vi.spyOn(api, "accountSummary").mockResolvedValue(summary);
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/properties/:propertyId" element={<PropertyDetailPage />} />
        <Route path="/calendar" element={<p>calendar page</p>} />
      </Routes>
      <PathProbe />
    </>,
    { route: "/properties/prop-1" },
  );
}

describe("PropertyDetailPage", () => {
  it("does not offer its own 'Start New Visit' door — that was a duplicate of AccountDetailPage's StartWorkCard", async () => {
    mockEmptyHealthRecordReads();
    renderPage();

    // Wait for the page to finish loading before asserting absence.
    await screen.findByRole("button", { name: "Schedule Consultation" });

    expect(screen.queryByText("Start New Visit")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Start New Visit" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mode")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Customer stated reason")).not.toBeInTheDocument();
  });

  it("still carries the click path to the surviving door — 'Back to Account' lands on the account that holds StartWorkCard", async () => {
    mockEmptyHealthRecordReads();
    renderPage();

    const backLink = await screen.findByRole("link", { name: "Back to Account" });
    expect(backLink).toHaveAttribute("href", "/accounts/cust-1");
  });

  describe("the top card — no title, two doors (plan item C, 2026-10-02)", () => {
    it("has no 'Estimates for this address' heading and carries both buttons", async () => {
      mockEmptyHealthRecordReads();
      renderPage();

      await screen.findByRole("button", { name: "Schedule Consultation" });

      expect(screen.queryByText("Estimates for this address")).not.toBeInTheDocument();
      expect(screen.queryByText("System Snapshot")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Schedule Consultation" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Create New Estimate" })).toBeInTheDocument();
    });

    it("Create New Estimate links to the builder bound to this account AND this address", async () => {
      mockEmptyHealthRecordReads();
      renderPage();

      const link = await screen.findByRole("link", { name: "Create New Estimate" });
      expect(link).toHaveAttribute("href", "/estimate-intake?account=cust-1&address=prop-1");
    });

    it("keeps 'Sold Work' as the sole route to the open work orders at this address, and has no 'Previous Estimates' button (Kyle, 2026-10-24)", async () => {
      mockEmptyHealthRecordReads();
      renderPage();

      const sold = await screen.findByRole("link", { name: "Sold Work" });
      expect(sold).toHaveAttribute("href", "/jobs?address=prop-1&open=1");
      // The button linked to /accounts/:id?address=, which the account page never read; the
      // estimates are listed on this page now.
      expect(screen.queryByRole("link", { name: "Previous Estimates" })).not.toBeInTheDocument();
    });

    it("Schedule Consultation creates the consultation visit for this customer/property and lands on /calendar?schedule=<id> — the ONE scheduler", async () => {
      mockEmptyHealthRecordReads();
      const newVisit: Visit = {
        id: "visit-new-1",
        propertyId: "prop-1",
        customerId: "cust-1",
        mode: "service_diagnostic",
        visitDate: new Date().toISOString(),
      };
      const createVisit = vi.spyOn(api, "createVisit").mockResolvedValue(newVisit);
      renderPage();

      const button = await screen.findByRole("button", { name: "Schedule Consultation" });
      fireEvent.click(button);

      await waitFor(() => {
        expect(createVisit).toHaveBeenCalledWith({
          customerId: "cust-1",
          propertyId: "prop-1",
          mode: "service_diagnostic",
          purpose: "Consultation — estimate visit",
        });
      });
      await waitFor(() => {
        expect(screen.getByTestId("path").textContent).toBe("/calendar?schedule=visit-new-1");
      });
    });

    // JobScheduler.oneHome.test.ts fails if any file other than CalendarPage.tsx imports or
    // renders JobScheduler — Schedule Consultation must stay a navigate/link, never a picker.
    it("never renders a date picker of its own", async () => {
      mockEmptyHealthRecordReads();
      renderPage();
      await screen.findByRole("button", { name: "Schedule Consultation" });
      expect(screen.queryByRole("grid")).not.toBeInTheDocument();
      expect(document.querySelector('input[type="date"]')).not.toBeInTheDocument();
    });
  });

  describe("the health record (plan item C, 2026-10-02)", () => {
    it("renders the findings ledger, electrical assessments, diagnostic reports and photos sections", async () => {
      mockEmptyHealthRecordReads();
      renderPage();

      await screen.findByText("Health Record");
      // FindingLedgerPanel fetches its own query, independent of the page's own loading state —
      // wait for it to settle past "Loading…" before asserting its content.
      await screen.findByText("Findings at this address");
      expect(screen.getByText("Electrical assessments")).toBeInTheDocument();
      expect(screen.getByText("No electrical assessment on file for this address yet.")).toBeInTheDocument();
      expect(screen.getByText("Diagnostic reports")).toBeInTheDocument();
      expect(screen.getByText("No circuit diagnostic on file for this address yet.")).toBeInTheDocument();
      expect(screen.getByText("Photos")).toBeInTheDocument();
    });

    it("lists an electrical assessment with a link back to its visit", async () => {
      vi.spyOn(api, "ledgerFindings").mockResolvedValue([]);
      vi.spyOn(api, "propertyDiagnosticReports").mockResolvedValue({ reports: [] });
      vi.spyOn(api, "propertyPhotos").mockResolvedValue({ jobPhotos: [], assessmentPhotos: [] });
      vi.spyOn(api, "propertyInspections").mockResolvedValue([
        {
          id: "insp-1",
          visitId: "visit-7",
          propertyId: "prop-1",
          customerId: "cust-1",
          jurisdictionId: "tn-2017",
          inspectionDate: "2026-09-01T00:00:00.000Z",
          score: null,
          schemaVersion: "v2",
          scope: "full",
          itemsAssessed: 42,
          failCount: 1,
          monitorCount: 2,
          passCount: 39,
          belowStandardCount: 0,
          naCount: 0,
          criticalFindingsJson: "[]",
          contractorReviewed: false,
          syncedAt: "2026-09-01T00:00:00.000Z",
          hasLoadCalc: true,
        },
      ]);
      renderPage();

      await screen.findByText(/42 items/);
      expect(screen.getByText(/load calc \+ generator sizing on file/)).toBeInTheDocument();
      const openVisit = screen.getByRole("link", { name: "open visit →" });
      expect(openVisit).toHaveAttribute("href", "/visits/visit-7");
    });

    it("lists a diagnostic report with a link back to its visit", async () => {
      vi.spyOn(api, "ledgerFindings").mockResolvedValue([]);
      vi.spyOn(api, "propertyInspections").mockResolvedValue([]);
      vi.spyOn(api, "propertyPhotos").mockResolvedValue({ jobPhotos: [], assessmentPhotos: [] });
      vi.spyOn(api, "propertyDiagnosticReports").mockResolvedValue({
        reports: [
          {
            id: "diag-1",
            visitId: "visit-8",
            propertyId: "prop-1",
            customerId: "cust-1",
            technicianName: "Jamie",
            reportDate: "2026-09-15T00:00:00.000Z",
            complaint: "Kitchen outlets dead",
            circuitLabel: "Kitchen small appliance",
            circuitNumber: "12",
            panelLocation: "Garage",
            breakerRating: "20A",
            breakerInspected: true,
            coverage: "whole_circuit",
            coverageNote: null,
            coverageStatement: "The whole circuit was opened and tested.",
            summary: null,
            diagnosticItemId: null,
            status: "complete",
            completedAt: "2026-09-15T01:00:00.000Z",
            voidedAt: null,
            voidReason: null,
            changeOrderDraftId: null,
            money: {
              quoted: { NORMAL: 0, DIFFICULT: 0, VERY_DIFFICULT: 0 },
              examined: { NORMAL: 0, DIFFICULT: 0, VERY_DIFFICULT: 0 },
              overage: { NORMAL: 0, DIFFICULT: 0, VERY_DIFFICULT: 0 },
              quotedTotal: 0,
              examinedTotal: 0,
              overageTotal: 0,
            },
            defectCount: 0,
            fixedCount: 1,
            deliveryCount: 0,
            outlets: [],
            updatedAt: "2026-09-15T01:00:00.000Z",
          },
        ],
      });
      renderPage();

      await screen.findByText(/Kitchen outlets dead/);
      expect(screen.getByText("The whole circuit was opened and tested.")).toBeInTheDocument();
      const links = screen.getAllByRole("link", { name: "open visit →" });
      expect(links.some((l) => l.getAttribute("href") === "/visits/visit-8")).toBe(true);
    });

    it("shows which job a photo came from", async () => {
      vi.spyOn(api, "ledgerFindings").mockResolvedValue([]);
      vi.spyOn(api, "propertyInspections").mockResolvedValue([]);
      vi.spyOn(api, "propertyDiagnosticReports").mockResolvedValue({ reports: [] });
      vi.spyOn(api, "propertyPhotos").mockResolvedValue({
        jobPhotos: [
          {
            id: "photo-1",
            mimeType: "image/jpeg",
            sizeBytes: 1000,
            caption: null,
            tag: "before",
            uploadedAt: "2026-09-15T00:00:00.000Z",
            visitId: "visit-8",
            visitDate: "2026-09-15T00:00:00.000Z",
            purpose: "Consultation — estimate visit",
            jobType: null,
          },
        ],
        assessmentPhotos: [],
      });
      renderPage();

      // The gallery labels each photo with the job it came from (purpose, here).
      await waitFor(() => {
        expect(screen.getByText(/Consultation — estimate visit/)).toBeInTheDocument();
      });
    });
  });

  describe("Estimates at this address (Kyle, 2026-10-24)", () => {
    it("lists this property's issued estimates via the property-filtered read, each opening its drawer", async () => {
      mockEmptyHealthRecordReads();
      const estimates = vi.spyOn(api, "accountEstimates").mockResolvedValue({
        estimates: [{
          id: "est-9", number: "E-209", revision: 1, title: "Panel upgrade", status: "sent", total: 4200, billedTotal: null,
          customerId: "cust-1", serviceAddressId: "prop-1", serviceAddress: "12 Main St, Smyrna", draftId: "draft-9",
          sentAt: "2026-10-01T12:00:00.000Z", firstViewedAt: null, signedAt: null,
        }],
      } as never);
      renderPage();

      await screen.findByText("Panel upgrade");
      expect(estimates).toHaveBeenCalledWith("cust-1", "prop-1");
      expect(screen.getByRole("heading", { name: /^Estimates/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
      // No address select: the property IS the address.
      expect(screen.queryByText("All addresses")).not.toBeInTheDocument();
    });

    it("says so when nothing has been quoted here", async () => {
      mockEmptyHealthRecordReads();
      renderPage();
      expect(await screen.findByText("Nothing quoted at this address yet.")).toBeInTheDocument();
    });
  });

  describe("Invoices at this address (Kyle, 2026-10-24)", () => {
    it("shows only this property's signed documents, each with its send and payment controls", async () => {
      mockEmptyHealthRecordReads();
      renderPage(summaryWith({
        documents: [
          signedDoc({ id: "doc-here", estimateNumber: "E-100", propertyId: "prop-1" }),
          signedDoc({ id: "doc-elsewhere", estimateNumber: "E-777", estimateId: "est-7", propertyId: "prop-other" }),
        ],
      }));

      expect(await screen.findByText(/Invoice E-100/)).toBeInTheDocument();
      expect(screen.queryByText(/E-777/)).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /^Invoices/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Email the signed copy" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Take payment…" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open PDF" })).toBeInTheDocument();
    });

    it("says so when there are no signed invoices at this address", async () => {
      mockEmptyHealthRecordReads();
      renderPage(summaryWith({ documents: [signedDoc({ propertyId: "prop-other" })] }));
      expect(await screen.findByText("No signed invoices at this address yet.")).toBeInTheDocument();
    });
  });

  // Moved from AccountDetailPage.test.tsx (2026-10-24): the gallery is per property now, given only
  // this address and only this address's jobs. Kyle's 2026-10-01 ruling - upload asks which job,
  // and every photo added has its way out - survives the move.
  describe("Photos at this address - upload and remove (Kyle, 2026-10-01 ruling, moved 2026-10-24)", () => {
    const job1 = job({ visitId: "visit-1", propertyId: "prop-1", jobType: "Panel upgrade", visitDate: "2026-09-01T12:00:00.000Z" });
    const job2 = job({ visitId: "visit-2", propertyId: "prop-1", jobType: null, purpose: "Consultation", visitDate: "2026-09-25T12:00:00.000Z" });
    const jobElsewhere = job({ visitId: "visit-x", propertyId: "prop-other", propertyLabel: "Rental — 456 Oak Ave", jobType: "Rewire", visitDate: "2026-09-30T12:00:00.000Z" });

    function photosOf(...photos: Array<Record<string, unknown>>): PropertyPhotos {
      return { jobPhotos: photos, assessmentPhotos: [] } as unknown as PropertyPhotos;
    }
    async function photoCard() {
      await screen.findByRole("button", { name: "Schedule Consultation" }); // the page itself has loaded
      // The gallery waits for the account summary (its jobs); skip past the loading placeholder.
      await waitFor(() => expect(screen.queryByText(/Loading this address.s photos/)).not.toBeInTheDocument());
      const heading = await screen.findByRole("heading", { name: "Photos" });
      return heading.closest("section")!;
    }

    it("with no jobs at this address, the upload control is greyed with the reason on screen, not hidden", async () => {
      mockEmptyHealthRecordReads();
      // A job at ANOTHER address must not count as a job here.
      renderPage(summaryWith({ jobs: [jobElsewhere] }));

      const card = await photoCard();
      expect(await within(card).findByText(/No jobs at this address yet/)).toBeInTheDocument();
      expect(within(card).getByLabelText("+ Add photos")).toBeDisabled();
    });

    it("with exactly one job here, upload doesn't make him choose - it says which job it is", async () => {
      mockEmptyHealthRecordReads();
      renderPage(summaryWith({ jobs: [job1, jobElsewhere] }));

      const card = await photoCard();
      expect(await within(card).findByText(/Adding to: Panel upgrade — Home — 12 Main St/)).toBeInTheDocument();
      expect(within(card).queryByLabelText("Which job are these photos for?")).not.toBeInTheDocument();
      expect(within(card).getByLabelText("+ Add photos")).not.toBeDisabled();
    });

    it("with more than one job here, prompts a job selection listing only THIS property's jobs, newest first", async () => {
      mockEmptyHealthRecordReads();
      vi.spyOn(api, "propertyPhotos").mockResolvedValue(photosOf(
        { id: "photo-1", mimeType: "image/jpeg", sizeBytes: 100, caption: "Old panel", tag: null, uploadedAt: "2026-09-01T12:05:00.000Z", visitId: "visit-1", visitDate: "2026-09-01T12:00:00.000Z", purpose: null, jobType: "Panel upgrade" },
        { id: "photo-2", mimeType: "image/jpeg", sizeBytes: 100, caption: null, tag: null, uploadedAt: "2026-09-25T09:05:00.000Z", visitId: "visit-2", visitDate: "2026-09-25T09:00:00.000Z", purpose: "Consultation", jobType: null },
      ));
      renderPage(summaryWith({ jobs: [job1, job2, jobElsewhere] }));

      const card = await photoCard();
      const select = (await within(card).findByLabelText("Which job are these photos for?")) as HTMLSelectElement;
      const optionLabels = Array.from(select.options).map((o) => o.textContent);
      expect(optionLabels).toHaveLength(3); // the prompt + this property's two jobs, not the other address's
      expect(optionLabels[0]).toBe("Which job are these photos for?");
      expect(optionLabels[1]).toMatch(/^Consultation — /); // visit-2 is newer
      expect(optionLabels[2]).toMatch(/^Panel upgrade — /);
      expect(within(card).getByLabelText("+ Add photos")).toBeDisabled(); // until a job is chosen

      await waitFor(() => expect(within(card).getByText(/Old panel/)).toBeInTheDocument());
      const captions = card.querySelectorAll("figcaption");
      expect(captions.length).toBe(2);
      expect(captions[0]).toHaveTextContent(/Consultation — /); // newest first
      expect(captions[1]).toHaveTextContent(/Panel upgrade — /);
    });

    it("uploads through the existing visit-photo endpoint once a job is chosen", async () => {
      mockEmptyHealthRecordReads();
      const upload = vi.spyOn(api, "uploadVisitPhoto").mockResolvedValue({
        id: "photo-new", mimeType: "image/jpeg", sizeBytes: 100, caption: null, tag: null, uploadedAt: "2026-10-01T00:00:00.000Z",
      } as never);
      renderPage(summaryWith({ jobs: [job1, job2] }));

      const card = await photoCard();
      const select = await within(card).findByLabelText("Which job are these photos for?");
      fireEvent.change(select, { target: { value: "visit-2" } });

      const fileInput = within(card).getByLabelText("+ Add photos");
      fireEvent.change(fileInput, { target: { files: [new File(["fake"], "panel.jpg", { type: "image/jpeg" })] } });

      await waitFor(() =>
        expect(upload).toHaveBeenCalledWith("visit-2", { dataUrl: "data:image/jpeg;base64,ZmFrZQ==", tag: null }),
      );
    });

    it("every job photo has a delete control that removes it after a confirm", async () => {
      mockEmptyHealthRecordReads();
      vi.spyOn(api, "propertyPhotos").mockResolvedValue(photosOf(
        { id: "photo-1", mimeType: "image/jpeg", sizeBytes: 100, caption: "Old panel", tag: null, uploadedAt: "2026-09-01T12:05:00.000Z", visitId: "visit-1", visitDate: "2026-09-01T12:00:00.000Z", purpose: null, jobType: "Panel upgrade" },
      ));
      const del = vi.spyOn(api, "deleteVisitPhoto").mockResolvedValue(undefined as never);
      vi.spyOn(window, "confirm").mockReturnValue(true);
      renderPage(summaryWith({ jobs: [job1] }));

      const card = await photoCard();
      fireEvent.click(await within(card).findByRole("button", { name: "Delete photo" }));
      await waitFor(() => expect(del).toHaveBeenCalledWith("photo-1"));
    });
  });

  describe("View report on a diagnostic row (Kyle, 2026-10-11)", () => {
    const baseReport = {
      visitId: "visit-8",
      propertyId: "prop-1",
      customerId: "cust-1",
      technicianName: "Jamie",
      reportDate: "2026-09-15T00:00:00.000Z",
      complaint: "Kitchen outlets dead",
      circuitNumber: "12",
      panelLocation: "Garage",
      breakerRating: "20A",
      breakerInspected: true,
      coverage: "whole_circuit" as const,
      coverageNote: null,
      coverageStatement: "The whole circuit was opened and tested.",
      summary: null,
      diagnosticItemId: null,
      completedAt: null,
      voidedAt: null,
      voidReason: null,
      changeOrderDraftId: null,
      money: {
        quoted: { NORMAL: 0, DIFFICULT: 0, VERY_DIFFICULT: 0 },
        examined: { NORMAL: 0, DIFFICULT: 0, VERY_DIFFICULT: 0 },
        overage: { NORMAL: 0, DIFFICULT: 0, VERY_DIFFICULT: 0 },
        quotedTotal: 0,
        examinedTotal: 0,
        overageTotal: 0,
      },
      defectCount: 0,
      fixedCount: 0,
      deliveryCount: 0,
      outlets: [],
      updatedAt: "2026-09-15T01:00:00.000Z",
    };

    function mockThreeReports() {
      vi.spyOn(api, "ledgerFindings").mockResolvedValue([]);
      vi.spyOn(api, "propertyInspections").mockResolvedValue([]);
      vi.spyOn(api, "propertyPhotos").mockResolvedValue({ jobPhotos: [], assessmentPhotos: [] });
      vi.spyOn(api, "propertyDiagnosticReports").mockResolvedValue({
        reports: [
          { ...baseReport, id: "diag-done", circuitLabel: "Done circuit", status: "complete" },
          { ...baseReport, id: "diag-open", circuitLabel: "Open circuit", status: "in_progress" },
          { ...baseReport, id: "diag-void", circuitLabel: "Void circuit", status: "void" },
        ],
      });
    }

    function rowFor(label: string) {
      return screen.getByText(new RegExp(`circuit ${label}`)).closest("li") as HTMLElement;
    }

    it("is enabled on a complete report and generates then opens that report's PDF", async () => {
      mockThreeReports();
      const pdf = vi.spyOn(api, "diagnosticReportPdf").mockResolvedValue({ documentId: "doc-9" });
      renderPage();

      await screen.findByText(/Done circuit/);
      const button = within(rowFor("Done circuit")).getByRole("button", { name: "View report" });
      expect(button).toBeEnabled();
      fireEvent.click(button);

      await waitFor(() => expect(pdf).toHaveBeenCalledWith("diag-done"));
      await waitFor(() => expect(openProtectedPdf).toHaveBeenCalledWith("/documents/doc-9/pdf"));
    });

    it("is disabled on an in-progress report, with the reason on screen", async () => {
      mockThreeReports();
      renderPage();

      await screen.findByText(/Open circuit/);
      const row = rowFor("Open circuit");
      expect(within(row).getByRole("button", { name: "View report" })).toBeDisabled();
      expect(within(row).getByText("Not finished yet — the report exists once the tech completes it.")).toBeInTheDocument();
    });

    it("is disabled on a voided report, with the reason on screen", async () => {
      mockThreeReports();
      renderPage();

      await screen.findByText(/Void circuit/);
      const row = rowFor("Void circuit");
      expect(within(row).getByRole("button", { name: "View report" })).toBeDisabled();
      expect(within(row).getByText("Voided — never sent to a customer.")).toBeInTheDocument();
    });

    it("shows the server's reason on the row when the report cannot be rendered", async () => {
      mockThreeReports();
      vi.spyOn(api, "diagnosticReportPdf").mockRejectedValue(new Error("No outlets were recorded, so there is no diagnostic report to show."));
      renderPage();

      await screen.findByText(/Done circuit/);
      fireEvent.click(within(rowFor("Done circuit")).getByRole("button", { name: "View report" }));

      expect(await screen.findByText("No outlets were recorded, so there is no diagnostic report to show.")).toBeInTheDocument();
    });
  });

  it("keeps the 'Visits and Estimates' list, the only way to reach a visit's own page from here", async () => {
    mockEmptyHealthRecordReads();
    renderPage();
    await screen.findByText("Visits and Estimates");
  });
});
