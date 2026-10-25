/**
 * CC on a send (Kyle, 2026-10-24: "The email will be the same as doing a CC email.") and
 * "If I type a new address I should have the option to save it as an additional contact."
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { SendToPicker } from "./SendToPicker";
import { api } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

const contact = (id: string, label: string, email: string | null) => ({
  id, label, email, phone: null, customerId: "acct-1", createdAt: "2026-10-01T00:00:00.000Z",
}) as never;

function mockContacts() {
  vi.spyOn(api, "accountContacts").mockResolvedValue([contact("c1", "Bookkeeper", "books@example.com")]);
}

describe("SendToPicker CC", () => {
  it("adds a saved contact as a CC chip, reports the list, and removes it with the x", async () => {
    mockContacts();
    const onCcChange = vi.fn();
    renderWithProviders(
      <SendToPicker accountId="acct-1" primaryEmail="owner@example.com" onChange={vi.fn()} onCcChange={onCcChange} />,
    );
    await screen.findAllByRole("option", { name: "Bookkeeper — books@example.com" });

    fireEvent.change(screen.getByLabelText("Add CC"), { target: { value: "books@example.com" } });
    expect(onCcChange).toHaveBeenLastCalledWith(["books@example.com"]);
    expect(screen.getByText(/CC books@example.com/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove CC books@example.com" }));
    expect(onCcChange).toHaveBeenLastCalledWith([]);
    expect(screen.queryByText(/CC books@example.com/)).not.toBeInTheDocument();
  });

  it("adds a typed CC address with Other address, and ignores one that is not an address", async () => {
    mockContacts();
    const onCcChange = vi.fn();
    renderWithProviders(
      <SendToPicker accountId="acct-1" primaryEmail="owner@example.com" onChange={vi.fn()} onCcChange={onCcChange} />,
    );
    await screen.findAllByRole("option", { name: "Bookkeeper — books@example.com" });

    fireEvent.change(screen.getByLabelText("Add CC"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("CC address"), { target: { value: "not-an-address" } });
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("CC address"), { target: { value: "pm@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCcChange).toHaveBeenLastCalledWith(["pm@example.com"]);
  });

  it("saves a typed CC address as a contact with a required label, then refreshes the contact list", async () => {
    mockContacts();
    const add = vi.spyOn(api, "addAccountContact").mockResolvedValue(contact("c2", "Property manager", "pm@example.com"));
    renderWithProviders(
      <SendToPicker accountId="acct-1" primaryEmail="owner@example.com" onChange={vi.fn()} onCcChange={vi.fn()} />,
    );
    await screen.findAllByRole("option", { name: "Bookkeeper — books@example.com" });

    fireEvent.change(screen.getByLabelText("Add CC"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("CC address"), { target: { value: "pm@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as contact" }));
    const saveButton = screen.getByRole("button", { name: "Save contact" });
    expect(saveButton).toBeDisabled(); // the label is required
    fireEvent.change(screen.getByLabelText("Contact label"), { target: { value: "Property manager" } });
    fireEvent.click(saveButton);

    await waitFor(() => expect(add).toHaveBeenCalledWith("acct-1", { label: "Property manager", email: "pm@example.com" }));
    expect(await screen.findByText(/Saved pm@example.com as "Property manager"/)).toBeInTheDocument();
  });

  it("saves a typed To address as a contact, and says so when the save fails", async () => {
    mockContacts();
    vi.spyOn(api, "addAccountContact").mockRejectedValue(new Error("Validation failed"));
    renderWithProviders(
      <SendToPicker accountId="acct-1" primaryEmail="owner@example.com" onChange={vi.fn()} onCcChange={vi.fn()} />,
    );
    await screen.findAllByRole("option", { name: "Bookkeeper — books@example.com" });

    fireEvent.change(screen.getByLabelText("Send to"), { target: { value: "custom" } });
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as contact" }));
    fireEvent.change(screen.getByLabelText("Contact label"), { target: { value: "Tenant" } });
    fireEvent.click(screen.getByRole("button", { name: "Save contact" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the contact: Validation failed");
  });

  it("does not offer Save as contact for the primary address or an existing contact", async () => {
    mockContacts();
    renderWithProviders(
      <SendToPicker accountId="acct-1" primaryEmail="owner@example.com" onChange={vi.fn()} onCcChange={vi.fn()} />,
    );
    await screen.findAllByRole("option", { name: "Bookkeeper — books@example.com" });

    fireEvent.change(screen.getByLabelText("Add CC"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("CC address"), { target: { value: "OWNER@example.com" } });
    expect(screen.queryByRole("button", { name: "Save as contact" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("CC address"), { target: { value: "books@example.com" } });
    expect(screen.queryByRole("button", { name: "Save as contact" })).not.toBeInTheDocument();
  });

  it("offers no CC control when the caller does not ask for one", async () => {
    mockContacts();
    renderWithProviders(<SendToPicker accountId="acct-1" primaryEmail="owner@example.com" onChange={vi.fn()} />);
    await screen.findAllByRole("option", { name: "Bookkeeper — books@example.com" });
    expect(screen.queryByLabelText("Add CC")).not.toBeInTheDocument();
  });
});
