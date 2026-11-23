/**
 * Messages -> "New group chat" (work order agent-team, C7): a name and the first members, people and AI agents only; "Create
 * group chat" is greyed with the reason until the group has a name, and sends the picked ids.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { groupChoices } from "../test/hubFixtures";
import { NewGroupChatDialog } from "./NewGroupChatDialog";
import { api } from "../lib/api";
import { GROUP_AGENT_CANNOT_REASON } from "../../../shared/hub/groups";

afterEach(() => vi.restoreAllMocks());

function show() {
  vi.spyOn(api, "hubGroupChoices").mockResolvedValue(groupChoices());
  const onCreated = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(<NewGroupChatDialog onClose={onClose} onCreated={onCreated} />);
  return { onCreated, onClose };
}

describe("NewGroupChatDialog", () => {
  it("offers people and AI agents by name and role, nothing else, and greys Create group chat with the reason until it has a name", async () => {
    show();
    const dialog = await screen.findByRole("dialog", { name: "New group chat" });
    expect(await within(dialog).findByLabelText("Eric")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Sam")).toBeInTheDocument();
    expect(within(dialog).getByText("People")).toBeInTheDocument();
    expect(within(dialog).getByText("AI agents")).toBeInTheDocument();
    expect(within(dialog).getByText("Inventory Manager")).toBeInTheDocument();
    expect(within(dialog).queryByText(/customer/i)).toBeNull();
    const create = within(dialog).getByRole("button", { name: "Create group chat" });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute("title", "Give the group a name first.");
    fireEvent.change(within(dialog).getByLabelText("Group name"), { target: { value: "Install crew" } });
    expect(create).toBeEnabled();
  });

  it("sends the name and the ticked people and agents, then hands the new group's id on", async () => {
    const { onCreated } = show();
    const create = vi.spyOn(api, "createHubGroup").mockResolvedValue({ id: "group-1" });
    const dialog = await screen.findByRole("dialog", { name: "New group chat" });
    fireEvent.change(within(dialog).getByLabelText("Group name"), { target: { value: "  Install crew " } });
    fireEvent.click(await within(dialog).findByLabelText("Eric"));
    fireEvent.click(within(dialog).getByLabelText(/RCE Admin/));
    expect(within(dialog).getByText("2 members picked")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create group chat" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "Install crew", technicianIds: ["tech-eric"], agentKeyIds: ["key-admin"] }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("group-1"));
  });

  it("says why when the server refuses, and the dialog stays open; Cancel closes it", async () => {
    const { onClose } = show();
    vi.spyOn(api, "createHubGroup").mockRejectedValue(new Error("One of those agents is switched off, so it cannot be added."));
    const dialog = await screen.findByRole("dialog", { name: "New group chat" });
    fireEvent.change(within(dialog).getByLabelText("Group name"), { target: { value: "Crew" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create group chat" }));
    expect(await within(dialog).findByText("One of those agents is switched off, so it cannot be added.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("greys an agent whose key could never see or post in a group, with the reason beside it, and never picks it", async () => {
    vi.spyOn(api, "hubGroupChoices").mockResolvedValue({
      people: [],
      agents: [
        { id: "key-admin", name: "RCE Admin", roleLabel: "Admin", canJoin: true, reason: null },
        { id: "key-inv", name: "Stock Bot", roleLabel: "Inventory Manager", canJoin: false, reason: GROUP_AGENT_CANNOT_REASON },
      ],
    });
    renderWithProviders(<NewGroupChatDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: "New group chat" });
    const stock = await within(dialog).findByLabelText(/Stock Bot/);
    expect(stock).toBeDisabled();
    expect(within(dialog).getByTestId("agent-cannot-join")).toHaveTextContent("no Team replies scope");
    expect(within(dialog).getByLabelText(/RCE Admin/)).toBeEnabled();
    fireEvent.change(within(dialog).getByLabelText("Group name"), { target: { value: "Crew" } });
    fireEvent.click(stock);
    expect(within(dialog).getByText("0 members picked")).toBeInTheDocument();
  });

  it("tells the office where agents come from when none is switched on", async () => {
    vi.spyOn(api, "hubGroupChoices").mockResolvedValue({ people: [{ id: "tech-eric", name: "Eric" }], agents: [] });
    renderWithProviders(<NewGroupChatDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(await screen.findByText(/No agent is switched on/)).toBeInTheDocument();
  });
});
