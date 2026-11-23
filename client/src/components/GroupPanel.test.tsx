/**
 * A group chat's Members panel (work order agent-team, C7): the members (an agent reads "AI" and its role), Remove on each,
 * Add members (the picker minus who is already in), and Delete group - live only while the group holds no message, greyed
 * with the reason otherwise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { groupChoices, groupView } from "../test/hubFixtures";
import { GroupPanel } from "./GroupPanel";
import { api } from "../lib/api";
import { GROUP_AGENT_CANNOT_REASON, GROUP_HAS_HISTORY_REASON } from "../../../shared/hub/groups";

afterEach(() => vi.restoreAllMocks());

const show = (group = groupView(), notMemberReason: string | null = null) => {
  const onDeleted = vi.fn();
  renderWithProviders(<GroupPanel threadId="group-1" group={group} onDeleted={onDeleted} notMemberReason={notMemberReason} />);
  return { onDeleted, panel: screen.getByTestId("group-panel") };
};

describe("GroupPanel", () => {
  it("lists the members, an agent with its AI chip and role, a switched-off agent flagged", () => {
    const { panel } = show(groupView({
      members: [
        { kind: "person", id: "tech-eric", name: "Eric", roleLabel: null, addedAt: "2026-11-22T12:00:00.000Z", you: true, active: true, reason: null },
        { kind: "agent", id: "key-admin", name: "RCE Admin", roleLabel: "Admin", addedAt: "2026-11-22T12:00:00.000Z", you: false, active: false, reason: "switched off" },
      ],
    }));
    expect(within(panel).getByText("Members (2)")).toBeInTheDocument();
    expect(within(panel).getByText("(you)")).toBeInTheDocument();
    expect(within(panel).getByText("AI")).toBeInTheDocument();
    expect(within(panel).getByText("Admin")).toBeInTheDocument();
    expect(within(panel).getByText("switched off")).toBeInTheDocument();
  });

  it("Remove takes a person or an agent out, by the right id", async () => {
    const remove = vi.spyOn(api, "removeHubGroupMember").mockResolvedValue({} as never);
    const { panel } = show();
    fireEvent.click(within(panel).getByRole("button", { name: "Remove Eric" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("group-1", { technicianId: "tech-eric" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Remove RCE Admin" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("group-1", { agentKeyId: "key-admin" }));
  });

  it("Add members offers only who is not in yet, greys Add selected until something is ticked, then adds them", async () => {
    vi.spyOn(api, "hubGroupChoices").mockResolvedValue(groupChoices());
    const add = vi.spyOn(api, "addHubGroupMembers").mockResolvedValue({} as never);
    const { panel } = show();
    fireEvent.click(within(panel).getByRole("button", { name: "Add members" }));
    expect(await within(panel).findByLabelText("Sam")).toBeInTheDocument();
    expect(within(panel).queryByLabelText("Eric")).toBeNull(); // already in
    expect(within(panel).queryByLabelText(/^RCE Admin/)).toBeNull();
    const submit = within(panel).getByRole("button", { name: "Add selected" });
    expect(submit).toBeDisabled();
    fireEvent.click(within(panel).getByLabelText("Sam"));
    fireEvent.click(within(panel).getByLabelText(/Stock Bot/));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(add).toHaveBeenCalledWith("group-1", { technicianIds: ["tech-sam"], agentKeyIds: ["key-inv"] }));
  });

  it("Delete group is live for an empty group and asks first; the group closes its drawer when it is gone", async () => {
    const del = vi.spyOn(api, "deleteHubGroup").mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { panel, onDeleted } = show();
    const button = within(panel).getByRole("button", { name: "Delete group" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(del).toHaveBeenCalledWith("group-1"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it("Delete group is greyed on a used group, with the reason beside it and on the button; Close is the exit", () => {
    const { panel } = show(groupView({ messageCount: 3, canDelete: false, deleteReason: GROUP_HAS_HISTORY_REASON }));
    const button = within(panel).getByRole("button", { name: "Delete group" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", GROUP_HAS_HISTORY_REASON);
    expect(within(panel).getByTestId("group-delete-reason")).toHaveTextContent("Use Close to take it off the Messages list");
  });

  it("marks an agent member whose key can no longer reach a group with the reason, so it does not look like a working member", () => {
    const { panel } = show(groupView({
      members: [
        { kind: "agent", id: "key-inv", name: "Stock Bot", roleLabel: "Inventory Manager", addedAt: "2026-11-22T12:00:00.000Z", you: false, active: false, reason: GROUP_AGENT_CANNOT_REASON },
      ],
    }));
    expect(within(panel).getByTestId("group-member-reason")).toHaveTextContent("no Team replies scope");
    expect(within(panel).queryByText("switched off")).toBeNull();
  });

  it("shows the server's own reason for a reader who is not a member, so the panel and the composer say the same thing", () => {
    const reason = "You are not a member of this group, so you can read and manage it but not post. Add yourself under Members to post.";
    const { panel } = show(groupView({ youAreMember: false }), reason);
    expect(within(panel).getByTestId("group-not-member")).toHaveTextContent(reason);
  });

  it("for a sign-in tied to no person it shows the 'not tied to a person' reason and never tells them to add themselves", () => {
    const reason = "This sign-in is not tied to a person on the team, so it cannot post in a group. Sign in with your own login.";
    const { panel } = show(groupView({ youAreMember: false }), reason);
    expect(within(panel).getByTestId("group-not-member")).toHaveTextContent("not tied to a person");
    expect(within(panel).getByTestId("group-not-member")).not.toHaveTextContent("Add yourself");
  });

  it("shows no not-member note to a member", () => {
    const { panel } = show(groupView({ youAreMember: true }), null);
    expect(within(panel).queryByTestId("group-not-member")).toBeNull();
  });
});
