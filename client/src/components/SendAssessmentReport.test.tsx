/**
 * "Email the assessment report" on the record (2026-09-29, Unit 3a).
 *
 * Kyle's ruling: the drawer carries what reaches the client; internal operations stay on their
 * page. Emailing a homeowner their assessment was buried three levels down `/visits/:id` — inside
 * `HealthRecordPanel`, inside an inspection row you had to expand first.
 *
 * Pinned here: the send is reachable, it refuses OUT LOUD when a critical finding has not been
 * reviewed (and says where the review is done), and it renders away entirely on a job with no
 * assessment rather than showing an empty panel.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { SendAssessmentReport, reportSendBlock } from "./SendAssessmentReport";
import { api } from "../lib/api";
import type { HealthInspectionSummary } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

function inspection(overrides: Partial<HealthInspectionSummary> = {}): HealthInspectionSummary {
  return {
    id: "insp-1", visitId: "visit-1", propertyId: "prop-1", customerId: "acct-1",
    jurisdictionId: "jur-1", inspectionDate: "2026-09-20T12:00:00.000Z", score: null,
    schemaVersion: "v2", scope: "full", itemsAssessed: 40,
    failCount: 2, monitorCount: 3, passCount: 35, belowStandardCount: 0, naCount: 0,
    criticalFindingsJson: "[]", contractorReviewed: false, syncedAt: "2026-09-20T13:00:00.000Z",
    technician: { id: "tech-1", name: "Eric Ward" },
    ...overrides,
  };
}

describe("reportSendBlock", () => {
  it("passes an ordinary record, and refuses an unreviewed critical one", () => {
    expect(reportSendBlock(inspection())).toBeNull();
    expect(reportSendBlock(inspection({ criticalFindingsJson: '["Double-tapped breaker"]' }))).toMatch(/contractor review/i);
    // Reviewed clears it.
    expect(reportSendBlock(inspection({ criticalFindingsJson: '["Double-tapped breaker"]', contractorReviewed: true }))).toBeNull();
  });

  it("treats a malformed criticals column as no criticals rather than throwing", () => {
    expect(reportSendBlock(inspection({ criticalFindingsJson: "not json" }))).toBeNull();
    expect(reportSendBlock(inspection({ criticalFindingsJson: null as unknown as string }))).toBeNull();
  });
});

describe("SendAssessmentReport", () => {
  it("emails the report from the record, and says where it went", async () => {
    vi.spyOn(api, "visitInspections").mockResolvedValue([inspection()]);
    const send = vi.spyOn(api, "emailHealthReport").mockResolvedValue({
      sent: true, sentTo: "jane@example.com", documentId: "doc-1",
    });

    renderWithProviders(<SendAssessmentReport visitId="visit-1" />, { route: "/jobs" });

    fireEvent.click(await screen.findByRole("button", { name: "Email the assessment report" }));
    // includeGenerator false — no load calc on this record.
    await waitFor(() => expect(send).toHaveBeenCalledWith("insp-1", undefined, false));
    expect(await screen.findByText("Report emailed to jane@example.com.")).toBeInTheDocument();
  });

  it("offers the generator sizing alongside it when a load calc is on the record", async () => {
    vi.spyOn(api, "visitInspections").mockResolvedValue([inspection({ hasLoadCalc: true })]);
    const send = vi.spyOn(api, "emailHealthReport").mockResolvedValue({
      sent: true, sentTo: "jane@example.com", documentId: "doc-1",
    });

    renderWithProviders(<SendAssessmentReport visitId="visit-1" />, { route: "/jobs" });

    fireEvent.click(await screen.findByRole("button", { name: "Email the assessment report + generator sizing" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("insp-1", undefined, true));
  });

  it("greys the send on an unreviewed critical finding and links to where the review is done", async () => {
    vi.spyOn(api, "visitInspections").mockResolvedValue([
      inspection({ criticalFindingsJson: '["Double-tapped breaker"]' }),
    ]);
    const send = vi.spyOn(api, "emailHealthReport");

    renderWithProviders(<SendAssessmentReport visitId="visit-1" />, { route: "/jobs" });

    const button = await screen.findByRole("button", { name: "Email the assessment report" });
    expect(button).toBeDisabled();
    expect(screen.getByText(/needs a contractor review before it can go to the customer/)).toBeInTheDocument();
    // A refusal that does not say where to go is a dead end.
    expect(screen.getByRole("link", { name: /Review it on the workspace/ })).toHaveAttribute("href", "/visits/visit-1");
    fireEvent.click(button);
    expect(send).not.toHaveBeenCalled();
  });

  it("shows when it was last sent, so a second send is a decision and not a guess", async () => {
    vi.spyOn(api, "visitInspections").mockResolvedValue([
      inspection({ deliveries: [{ id: "d-1", sentTo: "jane@example.com", sentBy: "human:crm-session", sentAt: "2026-09-21T15:00:00.000Z" }] }),
    ]);

    renderWithProviders(<SendAssessmentReport visitId="visit-1" />, { route: "/jobs" });

    expect(await screen.findByText(/Last sent to jane@example.com on 9\/21\/2026/)).toBeInTheDocument();
  });

  it("renders nothing on a job with no assessment", async () => {
    vi.spyOn(api, "visitInspections").mockResolvedValue([]);

    const { container } = renderWithProviders(<SendAssessmentReport visitId="visit-1" />, { route: "/jobs" });

    await waitFor(() => expect(api.visitInspections).toHaveBeenCalledWith("visit-1"));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Electrical assessment")).not.toBeInTheDocument();
  });
});
