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
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PropertyDetailPage } from "./PropertyDetailPage";
import { api } from "../lib/api";
import type { Property, Visit } from "../lib/types";

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

function renderPage() {
  vi.spyOn(api, "property").mockResolvedValue(property);
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

    it("keeps 'Previous Estimates' and 'Sold Work' as the sole route to their filtered views", async () => {
      mockEmptyHealthRecordReads();
      renderPage();

      const previous = await screen.findByRole("link", { name: "Previous Estimates" });
      expect(previous).toHaveAttribute("href", "/accounts/cust-1?address=prop-1");
      const sold = await screen.findByRole("link", { name: "Sold Work" });
      expect(sold).toHaveAttribute("href", "/jobs?address=prop-1&open=1");
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

      // PropertyPhotoSection defaults open on this page (defaultOpen) — no click needed.
      await waitFor(() => {
        expect(screen.getByText(/Consultation — estimate visit/)).toBeInTheDocument();
      });
    });
  });

  it("keeps the 'Visits and Estimates' list, the only way to reach a visit's own page from here", async () => {
    mockEmptyHealthRecordReads();
    renderPage();
    await screen.findByText("Visits and Estimates");
  });
});
