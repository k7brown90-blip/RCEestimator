/**
 * VisitWorkspacePage render smoke test — the "Job drawer" link back (plan item D,
 * 2026-10-01, ".claude/plans/2026-10-01-manual-sends-archiving-and-one-calendar.md").
 *
 * Kyle's 2026-09-29 ruling moved everything that reaches the customer — payment, the
 * invoice, raising a change order, emailing the assessment report — off this internal
 * workspace and into `JobDrawer`. `JobDrawer.tsx:116` already links OUT to the workspace
 * ("Workspace →"); this pins the way back: a button on the workspace that puts
 * `?job=<visitId>` on the URL so `DrawerHost` (mounted once in AppShell) opens the drawer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { VisitWorkspacePage } from "./VisitWorkspacePage";
import { api } from "../lib/api";
import type { Visit } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function LocationProbe() {
  const { search } = useLocation();
  return <p data-testid="location">{search}</p>;
}

function PathProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="path">{pathname}{search}</p>;
}

const visit: Visit = {
  id: "visit-1",
  propertyId: "prop-1",
  customerId: "cust-1",
  mode: "service_diagnostic",
  status: "estimate",
  jobType: "Panel upgrade",
  visitDate: "2026-09-10T12:00:00.000Z",
  property: { id: "prop-1", customerId: "cust-1", name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } as Visit["property"],
  customer: { id: "cust-1", name: "Jane Homeowner" } as Visit["customer"],
  estimates: [],
};

function mockWorkspaceReads() {
  // Direct reads the page itself fires (no estimateId on this visit, so api.estimate is
  // never called).
  vi.spyOn(api, "visit").mockResolvedValue(visit);
  // PaymentPanel (jobId path).
  vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(null);
  // PhotoGalleryPanel.
  vi.spyOn(api, "visitPhotos").mockResolvedValue([]);
  vi.spyOn(api, "propertyPhotos").mockResolvedValue({ jobPhotos: [], assessmentPhotos: [] });
  // HealthRecordPanel.
  vi.spyOn(api, "visitAssignments").mockResolvedValue([]);
  vi.spyOn(api, "visitInspections").mockResolvedValue([]);
  // FindingLedgerPanel.
  vi.spyOn(api, "ledgerFindings").mockResolvedValue([]);
}

describe("VisitWorkspacePage", () => {
  it("opens the job drawer from the 'Job drawer' button, putting ?job=<visitId> on the URL", async () => {
    mockWorkspaceReads();

    // VisitWorkspacePage reads :visitId off the route match (useParams), not a prop — so unlike
    // JobDrawer.test.tsx's LocationProbe pattern, this needs an actual <Route> under the
    // MemoryRouter renderWithProviders already supplies, or useParams() resolves to {} and the
    // page's `enabled: Boolean(visitId)` guard leaves api.visit() never called (stuck "Loading").
    renderWithProviders(
      <Routes>
        <Route path="/visits/:visitId" element={<><VisitWorkspacePage /><LocationProbe /></>} />
      </Routes>,
      { route: "/visits/visit-1" },
    );

    const drawerButton = await screen.findByRole("button", { name: "Job drawer →" });
    expect(screen.getByTestId("location")).toHaveTextContent("");

    fireEvent.click(drawerButton);

    expect(screen.getByTestId("location")).toHaveTextContent("?job=visit-1");
  });

  /*
    ONE SCHEDULER (2026-10-01, plan item E3). This page is where Kyle filed the report from:
    "This brings me to the calendar and does not let me schedule the consultation. There are two
    points to schedule and this one links to the wrong scheduling mechanism." It rendered a
    second `JobScheduler` for the same visit, in idle mode — a button, no picker — while the
    Calendar opened straight into one. Now the page shows the booking state and ONE door that
    lands on the Calendar with the visit already selected.
  */
  it("shows no inline scheduler — one 'Book on the Calendar' door that lands on /calendar?schedule=<visitId>", async () => {
    mockWorkspaceReads();

    renderWithProviders(
      <>
        <Routes>
          <Route path="/visits/:visitId" element={<VisitWorkspacePage />} />
          <Route path="/calendar" element={<p>calendar page</p>} />
        </Routes>
        {/* Outside the Routes, inside the same router, so it survives the navigation. */}
        <PathProbe />
      </>,
      { route: "/visits/visit-1" },
    );

    const door = await screen.findByRole("link", { name: "Book on the Calendar" });
    expect(door).toHaveAttribute("href", "/calendar?schedule=visit-1");
    expect(screen.getByText("Estimate Appointment")).toBeInTheDocument();
    expect(screen.getByText("Not booked yet.")).toBeInTheDocument();
    // The duplicate scheduler is gone: no booking button, no second month grid, no picker.
    expect(screen.queryByRole("button", { name: "Book Estimate Visit" })).not.toBeInTheDocument();
    expect(screen.queryByText("Su")).not.toBeInTheDocument();
    expect(screen.queryByText(/Pick a start date/)).not.toBeInTheDocument();

    fireEvent.click(door);
    expect(await screen.findByText("calendar page")).toBeInTheDocument();
    expect(screen.getByTestId("path")).toHaveTextContent("/calendar?schedule=visit-1");
  });
});
