/**
 * The Google review ask and its manual confirmation, on the account (item E / ruling E2,
 * 2026-10-02). Pins:
 *   1. Both controls are present under one heading.
 *   2. The send is greyed with its reason when the account has no completed job — never hidden.
 *   3. A successful send shows who it went to, and "Send it again" afterwards.
 *   4. The server's refusal (dedupe / 90-day rule / no email) surfaces as readable text.
 *   5. Marking review confirmed requires a name (no prefilled "Kyle" — CustomerNote precedent),
 *      then reads "Review confirmed ... — marked by ..." with a way back out ("Unconfirm").
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { ReviewRequestPanel } from "./ReviewRequestPanel";
import { TAKEN_BY_STORAGE_KEY } from "./ConversationNotes";
import { api } from "../lib/api";
import type { AccountJob } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function job(overrides: Partial<AccountJob> = {}): AccountJob {
  return {
    visitId: "visit-1",
    propertyId: "prop-1",
    propertyLabel: "Main House — 123 Main St",
    status: "completed",
    archived: true,
    jobType: "Panel upgrade",
    purpose: null,
    mode: "remodel",
    visitDate: "2026-09-01T12:00:00.000Z",
    scheduledStart: null,
    scheduledEnd: null,
    completedAt: "2026-09-01T16:00:00.000Z",
    costs: {
      estimatedCost: null, materialCost: 0, laborHours: 0, laborRate: 0, laborCost: 0,
      overhead: 0, totalCost: 0, revenue: 0, grossProfit: 0, margin: null,
    },
    purchaseOrders: [],
    receipts: [],
    documents: [],
    latestEstimate: null,
    ...overrides,
  } as unknown as AccountJob;
}

describe("ReviewRequestPanel — both controls, on the account", () => {
  it("shows one heading with both the send and the confirm controls", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    renderWithProviders(<ReviewRequestPanel accountId="cust-1" jobs={[job()]} reviewConfirmedAt={null} reviewConfirmedBy={null} />);

    expect(await screen.findByRole("heading", { name: "Google review" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send a Google review request" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark review confirmed" })).toBeInTheDocument();
  });

  it("greys the send with the reason, not hidden, when the account has no completed job", async () => {
    const send = vi.spyOn(api, "emailAccountReviewRequest");
    renderWithProviders(<ReviewRequestPanel accountId="cust-1" jobs={[]} reviewConfirmedAt={null} reviewConfirmedBy={null} />);

    const button = await screen.findByRole("button", { name: "Send a Google review request" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "This account has no completed job yet — a review request needs one to send.");
    expect(screen.getByText("This account has no completed job yet — a review request needs one to send.")).toBeInTheDocument();
    fireEvent.click(button);
    expect(send).not.toHaveBeenCalled();
  });

  it("also greys the send when every job is still open — none has a completedAt", async () => {
    renderWithProviders(
      <ReviewRequestPanel
        accountId="cust-1"
        jobs={[job({ status: "scheduled", completedAt: null, archived: false })]}
        reviewConfirmedAt={null}
        reviewConfirmedBy={null}
      />,
    );
    expect(await screen.findByRole("button", { name: "Send a Google review request" })).toBeDisabled();
  });

  it("resolves the MOST RECENTLY completed job when the account has several, and sends", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    const send = vi.spyOn(api, "emailAccountReviewRequest").mockResolvedValue({ ok: true, to: "jane@example.com", visitId: "visit-2" });

    renderWithProviders(
      <ReviewRequestPanel
        accountId="cust-1"
        jobs={[
          job({ visitId: "visit-1", completedAt: "2026-08-01T12:00:00.000Z" }),
          job({ visitId: "visit-2", completedAt: "2026-09-20T12:00:00.000Z" }),
        ]}
        reviewConfirmedAt={null}
        reviewConfirmedBy={null}
      />,
    );

    const button = await screen.findByRole("button", { name: "Send a Google review request" });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    // The send is ACCOUNT-keyed (the server resolves the job itself) — this proves the button
    // called the account route, not a job-id guess made in the browser.
    await waitFor(() => expect(send).toHaveBeenCalledWith("cust-1"));
    expect(await screen.findByText("Review request emailed to jane@example.com.")).toBeInTheDocument();
  });

  it("surfaces the server's refusal instead of swallowing it", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "emailAccountReviewRequest").mockRejectedValue(
      new Error("Jane Homeowner was already asked for a review within the last 90 days."),
    );

    renderWithProviders(<ReviewRequestPanel accountId="cust-1" jobs={[job()]} reviewConfirmedAt={null} reviewConfirmedBy={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Send a Google review request" }));
    expect(await screen.findByText("Jane Homeowner was already asked for a review within the last 90 days.")).toBeInTheDocument();
  });

  it("shows the last-sent line the same way SendAssessmentReport/the financing button do, from the server", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([
      {
        id: "d-1", provider: "resend", status: "delivered", statusAt: "2026-09-02T12:00:00.000Z",
        to: "jane@example.com", error: null, createdAt: "2026-09-02T11:00:00.000Z",
        providerMessageId: "m-1", subject: "Thank you from Red Cedar Electric — how did we do?",
        kind: "review_request", estimateNumber: null, issuedEstimateId: null, visitId: "visit-1",
        leadId: null, customerId: null, estimate: null,
      },
    ]);

    renderWithProviders(<ReviewRequestPanel accountId="cust-1" jobs={[job()]} reviewConfirmedAt={null} reviewConfirmedBy={null} />);

    expect(await screen.findByText(/Last sent to jane@example\.com on/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send it again" })).toBeInTheDocument();
  });
});

describe("ReviewRequestPanel — the manual confirmed mark", () => {
  it("requires a name — no prefilled \"Kyle\" (CustomerNote precedent) — then records it, reversibly", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    const confirm = vi.spyOn(api, "setReviewConfirmed").mockResolvedValue({
      reviewConfirmedAt: "2026-10-02T18:00:00.000Z", reviewConfirmedBy: "Eric",
    });

    renderWithProviders(<ReviewRequestPanel accountId="cust-1" jobs={[job()]} reviewConfirmedAt={null} reviewConfirmedBy={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Mark review confirmed" }));
    const nameBox = await screen.findByLabelText("Confirmed by");
    expect(nameBox).toHaveValue(""); // not prefilled with any name, including Kyle's
    const submit = screen.getByRole("button", { name: "Mark review confirmed" });
    expect(submit).toBeDisabled();

    fireEvent.change(nameBox, { target: { value: "Eric" } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(confirm).toHaveBeenCalledWith("cust-1", { confirmedBy: "Eric" }));
    expect(localStorage.getItem(TAKEN_BY_STORAGE_KEY)).toBe("Eric");
  });

  it("once confirmed, the control reads \"Review confirmed\" with the date and who, and offers the way out", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    const uncommit = vi.spyOn(api, "clearReviewConfirmed").mockResolvedValue({ reviewConfirmedAt: null, reviewConfirmedBy: null });

    renderWithProviders(
      <ReviewRequestPanel accountId="cust-1" jobs={[job()]} reviewConfirmedAt="2026-10-02T18:00:00.000Z" reviewConfirmedBy="Eric" />,
    );

    expect(await screen.findByText(/Review confirmed/)).toBeInTheDocument();
    expect(screen.getByText(/marked by Eric/)).toBeInTheDocument();
    // Standing rule: nothing the app creates is one-way.
    const undo = screen.getByRole("button", { name: "Unconfirm" });
    fireEvent.click(undo);
    await waitFor(() => expect(uncommit).toHaveBeenCalledWith("cust-1"));
  });

  it("prefills \"Confirmed by\" from the last name remembered in THIS browser, same key as conversation notes", async () => {
    localStorage.setItem(TAKEN_BY_STORAGE_KEY, "Kyle");
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

    renderWithProviders(<ReviewRequestPanel accountId="cust-1" jobs={[job()]} reviewConfirmedAt={null} reviewConfirmedBy={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Mark review confirmed" }));
    expect(await screen.findByLabelText("Confirmed by")).toHaveValue("Kyle");
  });
});
