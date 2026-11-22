/**
 * Settings -> "Message reminders" (work order agent-team, U8, Kyle only): the sentence, the two times, "Save
 * hours" and "Use 8:00 AM – 8:00 PM". Mon-Fri is fixed text, not a field. GREYED with the reason for anyone who
 * is not Kyle - never hidden.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { MessageRemindersSection, REMINDERS_LOCK_REASON, clockLabel } from "./MessageRemindersSection";
import { api } from "../lib/api";
import { AI_ADMIN_SESSION, OWNER_NO_GRANT, PIN_SESSION } from "../test/sessions";

afterEach(() => vi.restoreAllMocks());

const value = (start = "08:00", end = "20:00") => ({ key: "hubNotify" as const, value: { start, end } });

describe("clockLabel", () => {
  it("reads a 24-hour time as the card shows it", () => {
    expect([clockLabel("08:00"), clockLabel("20:00"), clockLabel("00:30"), clockLabel("12:05")]).toEqual(["8:00 AM", "8:00 PM", "12:30 AM", "12:05 PM"]);
  });
});

describe("Message reminders", () => {
  it("says what it does, with Mon–Fri as plain text and no days control", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "hubNotify").mockResolvedValue(value());
    renderWithProviders(<MessageRemindersSection />);
    expect(await screen.findByText(/Remind me about a waiting approval once after 15 minutes, then once an hour, Mon–Fri 8:00 AM – 8:00 PM\./)).toBeInTheDocument();
    expect(screen.getByText(/Turn on notifications on this device/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("From")).toBeEnabled());
  });

  it("saves new hours through the one owner-settings route, and puts the default back", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "hubNotify").mockResolvedValue(value());
    const save = vi.spyOn(api, "saveHubNotify").mockImplementation(async (v) => ({ key: "hubNotify", value: v }));
    renderWithProviders(<MessageRemindersSection />);
    await waitFor(() => expect(screen.getByLabelText("From")).toBeEnabled());
    const saveButton = screen.getByRole("button", { name: "Save hours" });
    expect(saveButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "17:30" } });
    fireEvent.click(saveButton);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ start: "09:00", end: "17:30" }));
    expect(await screen.findByText("Reminders will go out 9:00 AM – 5:30 PM, Mon–Fri.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use 8:00 AM – 8:00 PM" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ start: "08:00", end: "20:00" }));
  });

  it("greys Save hours when the start is not before the end, and says why", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "hubNotify").mockResolvedValue(value());
    renderWithProviders(<MessageRemindersSection />);
    await waitFor(() => expect(screen.getByLabelText("From")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "21:00" } });
    expect(screen.getByRole("button", { name: "Save hours" })).toBeDisabled();
    expect(screen.getByText("The start time must be earlier than the end time.")).toBeInTheDocument();
  });

  it.each([["another person's login", OWNER_NO_GRANT], ["the AI admin", AI_ADMIN_SESSION]])("is greyed with the reason for %s, and asks the server for nothing", async (_who, session) => {
    vi.spyOn(api, "session").mockResolvedValue(session);
    const read = vi.spyOn(api, "hubNotify").mockResolvedValue(value());
    renderWithProviders(<MessageRemindersSection />);
    expect(await screen.findByTestId("reminders-locked")).toHaveTextContent(REMINDERS_LOCK_REASON);
    expect(screen.getByLabelText("From")).toBeDisabled();
    expect(screen.getByLabelText("To")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save hours" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use 8:00 AM – 8:00 PM" })).toBeDisabled();
    expect(read).not.toHaveBeenCalled();
  });
});
