/**
 * The Job Completion Report card (Kyle, 2026-10-29) - the office's door onto the per-line write-up.
 * Pins the click-through: a row per line (named, change orders marked), "Not written up yet", the NEC
 * pre-fill, Save sending the edited entry, Clear behind a confirm and greyed with a reason when there is
 * nothing to clear, Preview greyed with "No lines are written up yet", and the empty-job reason shown.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { renderWithProviders } from "../test/renderWithProviders";
import { JobCompletionReportPanel } from "./JobCompletionReportPanel";
import { api } from "../lib/api";
import type { CompletionLineView, CompletionLinesResponse } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

const panelLine = (over: Partial<CompletionLineView> = {}): CompletionLineView => ({
  lineId: "line-1",
  documentId: "root-1",
  documentNumber: "2026-1122",
  documentKind: "invoice",
  option: "A",
  name: "Replace 200A panel",
  quantity: 1,
  defaultNecRefs: ["408.36"],
  entry: null,
  ...over,
});

const response = (lines: CompletionLineView[], over: Partial<CompletionLinesResponse> = {}): CompletionLinesResponse => ({
  visitId: "visit-1",
  invoiceNumber: "2026-1122",
  lines,
  writtenUp: lines.filter((l) => l.entry).length,
  reason: null,
  ...over,
});

const savedEntry = {
  explanation: "Old panel was double-tapped.",
  necRefs: ["408.41"],
  readings: [{ label: "Voltage L1-L2", value: "240", unit: "V" }],
  photoIds: ["photo-1"],
  updatedBy: "Kyle",
  updatedAt: "2026-10-29T15:00:00.000Z",
};

/** Stands in for the payment card: it holds a ["paymentInfo", ...] query, which the receipt's report list rides on. */
function PaymentInfoProbe({ onFetch }: { onFetch: () => void }) {
  useQuery({ queryKey: ["paymentInfo", "visit-1"], queryFn: async () => { onFetch(); return null; } });
  return null;
}

describe("JobCompletionReportPanel", () => {
  it("lists one row per line in the order given, marks a change order, and says 'Not written up yet' on a row with no entry", async () => {
    vi.spyOn(api, "jobCompletionLines").mockResolvedValue(response([
      panelLine(),
      panelLine({ lineId: "line-2", documentId: "co-1", documentNumber: "2026-1130", documentKind: "change_order", name: "Add GFCI outlet", defaultNecRefs: [] }),
    ]));

    renderWithProviders(<JobCompletionReportPanel jobId="visit-1" />);

    expect(await screen.findByRole("heading", { name: "Job Completion Report" })).toBeInTheDocument();
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Replace 200A panel")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Add GFCI outlet — change order 2026-1130")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Not written up yet")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("button", { name: "Write up this line" })).toBeInTheDocument();
  });

  it("with nothing written up, Preview report is greyed WITH the reason", async () => {
    vi.spyOn(api, "jobCompletionLines").mockResolvedValue(response([panelLine()]));
    renderWithProviders(<JobCompletionReportPanel jobId="visit-1" />);

    const preview = await screen.findByRole("button", { name: "Preview report" });
    expect(preview).toBeDisabled();
    expect(preview).toHaveAttribute("title", "No lines are written up yet");
    expect(screen.getAllByText("No lines are written up yet").length).toBeGreaterThan(0);
  });

  it("Preview report is enabled once a line is written up", async () => {
    vi.spyOn(api, "jobCompletionLines").mockResolvedValue(response([panelLine({ entry: savedEntry })]));
    renderWithProviders(<JobCompletionReportPanel jobId="visit-1" />);

    const preview = await screen.findByRole("button", { name: "Preview report" });
    await waitFor(() => expect(preview).toBeEnabled());
    expect(preview).not.toHaveAttribute("title");
    expect(screen.queryByText("No lines are written up yet")).not.toBeInTheDocument();
  });

  it("an empty job shows the server's reason, not nothing", async () => {
    vi.spyOn(api, "jobCompletionLines").mockResolvedValue(response([], { invoiceNumber: null, reason: "This job has no signed invoice yet." }));
    renderWithProviders(<JobCompletionReportPanel jobId="visit-1" />);
    expect(await screen.findByText("This job has no signed invoice yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview report" })).toBeDisabled();
  });

  it("pre-fills the NEC article from the price book; Save is greyed until something is written, then sends the edited entry", async () => {
    vi.spyOn(api, "jobCompletionLines").mockResolvedValue(response([panelLine()]));
    vi.spyOn(api, "visitPhotos").mockResolvedValue([]);
    const save = vi.spyOn(api, "saveJobCompletionLine").mockResolvedValue(panelLine({ entry: savedEntry }));
    renderWithProviders(<JobCompletionReportPanel jobId="visit-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Write up this line" }));
    expect(screen.getByText("NEC 408.36")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toHaveAttribute("title", "Nothing is written up on this line yet.");

    fireEvent.change(screen.getByLabelText("What was done and why"), { target: { value: "  Old panel was double-tapped.  " } });
    fireEvent.change(screen.getByLabelText("NEC article"), { target: { value: "408.41" } });
    fireEvent.click(screen.getByRole("button", { name: "Add article" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove NEC article 408.36" }));
    fireEvent.click(screen.getByRole("button", { name: "Add reading" }));
    fireEvent.change(screen.getByLabelText("Reading 1 label"), { target: { value: "Voltage L1-L2" } });
    fireEvent.change(screen.getByLabelText("Reading 1 value"), { target: { value: "240" } });
    fireEvent.change(screen.getByLabelText("Reading 1 unit"), { target: { value: "V" } });
    // a second, left-blank reading row is dropped on save
    fireEvent.click(screen.getByRole("button", { name: "Add reading" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("visit-1", "line-1", {
      explanation: "Old panel was double-tapped.",
      necRefs: ["408.41"],
      readings: [{ label: "Voltage L1-L2", value: "240", unit: "V" }],
      photoIds: [],
    }));
  });

  it("puts a picked job photo on the line and removes it again with its own ×", async () => {
    vi.spyOn(api, "jobCompletionLines").mockResolvedValue(response([panelLine()]));
    vi.spyOn(api, "visitPhotos").mockResolvedValue([
      { id: "photo-9", mimeType: "image/jpeg", sizeBytes: 10, caption: "New panel", tag: null, uploadedAt: "2026-10-29T12:00:00.000Z" } as never,
    ]);
    const save = vi.spyOn(api, "saveJobCompletionLine").mockResolvedValue(panelLine());
    renderWithProviders(<JobCompletionReportPanel jobId="visit-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Write up this line" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick photos from this job" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add photo New panel to this line" }));
    expect(screen.getByText("Photos (1 of 8) — from this job")).toBeInTheDocument();

    // its own exit: the × takes it back off the line (the photo stays on the job)
    fireEvent.click(screen.getByRole("button", { name: "Remove photo from this line" }));
    expect(screen.getByText("Photos (0 of 8) — from this job")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Add photo New panel to this line" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("visit-1", "line-1", expect.objectContaining({ photoIds: ["photo-9"] })));
  });

  it("shows the server's sentence when a save is refused", async () => {
    vi.spyOn(api, "jobCompletionLines").mockResolvedValue(response([panelLine()]));
    vi.spyOn(api, "visitPhotos").mockResolvedValue([]);
    vi.spyOn(api, "saveJobCompletionLine").mockRejectedValue(new Error("A reading needs a value"));
    renderWithProviders(<JobCompletionReportPanel jobId="visit-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Write up this line" }));
    fireEvent.change(screen.getByLabelText("What was done and why"), { target: { value: "Did it." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("A reading needs a value")).toBeInTheDocument();
  });

  it("Clear asks first, then deletes the entry; declining the confirm deletes nothing", async () => {
    vi.spyOn(api, "jobCompletionLines").mockResolvedValue(response([panelLine({ entry: savedEntry })]));
    vi.spyOn(api, "visitPhotos").mockResolvedValue([]);
    const clear = vi.spyOn(api, "clearJobCompletionLine").mockResolvedValue({ cleared: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderWithProviders(<JobCompletionReportPanel jobId="visit-1" />);

    expect(await screen.findByText(/Written up by Kyle on/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit write-up" }));
    // an existing entry loads into the form as saved
    expect((screen.getByLabelText("What was done and why") as HTMLTextAreaElement).value).toBe("Old panel was double-tapped.");
    expect(screen.getByText("NEC 408.41")).toBeInTheDocument();
    expect((screen.getByLabelText("Reading 1 value") as HTMLInputElement).value).toBe("240");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith("visit-1", "line-1"));
  });

  it("a save and a clear both refresh the lines AND the payment card (the receipt's report list depends on it)", async () => {
    const lines = vi.spyOn(api, "jobCompletionLines").mockResolvedValue(response([panelLine({ entry: savedEntry })]));
    vi.spyOn(api, "visitPhotos").mockResolvedValue([]);
    vi.spyOn(api, "saveJobCompletionLine").mockResolvedValue(panelLine({ entry: savedEntry }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(api, "clearJobCompletionLine").mockResolvedValue({ cleared: true });
    const paymentFetch = vi.fn();
    renderWithProviders(<><PaymentInfoProbe onFetch={paymentFetch} /><JobCompletionReportPanel jobId="visit-1" /></>);

    fireEvent.click(await screen.findByRole("button", { name: "Edit write-up" }));
    await waitFor(() => expect(paymentFetch).toHaveBeenCalledTimes(1));
    const linesBefore = lines.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(paymentFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(lines.mock.calls.length).toBeGreaterThan(linesBefore));

    fireEvent.click(await screen.findByRole("button", { name: "Edit write-up" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(paymentFetch).toHaveBeenCalledTimes(3));
  });
});
