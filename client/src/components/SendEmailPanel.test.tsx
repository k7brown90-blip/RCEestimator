/** CC on the follow-up email panel (Kyle, 2026-10-24: "The email will be the same as doing a CC email."). */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { SendEmailPanel } from "./SendEmailPanel";
import { api } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SendEmailPanel CC on a lead", () => {
  it("sends the CC list with the email, and explains why a typed address cannot be saved as a contact", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    const send = vi.spyOn(api, "sendRecordEmail").mockResolvedValue({
      sent: true, to: "jane@example.com", cc: ["pm@example.com"], suppressed: false,
    });
    renderWithProviders(<SendEmailPanel target="lead" id="lead-1" primaryEmail="jane@example.com" />);

    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    fireEvent.change(screen.getByLabelText("CC address"), { target: { value: "pm@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add CC" }));
    expect(screen.getByText(/CC pm@example.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as contact" })).toBeDisabled();
    expect(screen.getAllByText("Leads have no account to save contacts to").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Checking in" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Following up." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith({
      target: "lead", id: "lead-1", to: "jane@example.com", cc: ["pm@example.com"], subject: "Checking in", body: "Following up.",
    }));
    expect(await screen.findByText("Sent to jane@example.com, cc pm@example.com.")).toBeInTheDocument();
  });
});
