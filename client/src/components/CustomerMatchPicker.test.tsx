/**
 * The one match panel (plan lead-intake-fixes F2): accounts first, a same-name-only account marked
 * "check before linking", and the leads that already exist with an "Open lead" door to each.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import { CustomerMatchPicker } from "./CustomerMatchPicker";
import { api } from "../lib/api";
import type { CustomerMatch, LeadMatch } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function PathProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="path">{pathname}{search}</p>;
}

const account = (overrides: Partial<CustomerMatch> = {}): CustomerMatch => ({
  customerId: "cust-1", name: "Eric Ward", email: null, phone: null, score: 17, matchedOn: ["name"],
  properties: [], visitCount: 0, lastVisitAt: null, ...overrides,
});

const leadMatch = (overrides: Partial<LeadMatch> = {}): LeadMatch => ({
  leadId: "lead-77", name: "Eric Ward", phone: "+16155550101", email: null, status: "lost", platform: "yelp",
  receivedAt: "2026-10-20T12:00:00.000Z", matchedOn: ["phone"], ...overrides,
});

function renderPicker(props: Partial<React.ComponentProps<typeof CustomerMatchPicker>> = {}) {
  return renderWithProviders(
    <>
      <CustomerMatchPicker
        name="Eric Ward"
        linkedCustomerId={null}
        linkedPropertyId={null}
        onLink={() => {}}
        onUnlink={() => {}}
        {...props}
      />
      <PathProbe />
    </>,
    { route: "/leads/new" },
  );
}

describe("CustomerMatchPicker — same name only (F2)", () => {
  it("words a name-only account as 'same name only — check before linking'", async () => {
    vi.spyOn(api, "customerMatches").mockResolvedValue({ matches: [account()], leadMatches: [] });
    renderPicker({ includeNameOnly: true });
    expect(await screen.findByText("An account has the same name")).toBeInTheDocument();
    expect(screen.getByText(/same name only — check before linking/)).toBeInTheDocument();
    // The existing link buttons are still the way to link it.
    expect(screen.getByRole("button", { name: "Use this account — new address" })).toBeInTheDocument();
  });

  it("a real phone or email hit keeps the original wording and is not called name-only", async () => {
    vi.spyOn(api, "customerMatches").mockResolvedValue({
      matches: [account({ customerId: "cust-2", phone: "6155550101", matchedOn: ["phone", "name"], score: 75 }), account()],
      leadMatches: [],
    });
    renderPicker({ includeNameOnly: true });
    expect(await screen.findByText("2 existing accounts look like this")).toBeInTheDocument();
    expect(screen.getByText(/matched on phone and name/)).toBeInTheDocument();
    expect(screen.getAllByText(/same name only/)).toHaveLength(1);
  });

  it("asks the server for nothing extra when the flags are off (the new-account screen)", async () => {
    const spy = vi.spyOn(api, "customerMatches").mockResolvedValue({ matches: [] });
    renderPicker();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const arg = spy.mock.calls[0][0];
    expect(arg).toEqual({ name: "Eric Ward" });
  });
});

describe("CustomerMatchPicker — Already a lead (F2)", () => {
  it("lists each lead with its status, received day and an Open lead button that raises that lead's drawer", async () => {
    vi.spyOn(api, "customerMatches").mockResolvedValue({ matches: [], leadMatches: [leadMatch()] });
    renderPicker({ includeLeads: true });

    expect(await screen.findByText("Already a lead (1)")).toBeInTheDocument();
    const panel = document.querySelector("[data-lead-matches]") as HTMLElement;
    expect(within(panel).getByText(/lost/)).toBeInTheDocument();
    expect(within(panel).getByText(/received 10\/20\/2026/)).toBeInTheDocument();
    expect(within(panel).getByText(/matched on phone/)).toBeInTheDocument();
    // Nothing about accounts when there are none.
    expect(screen.queryByText(/account/i)).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Open lead" }));
    // Same opener every list uses: the drawer rides on ?lead=, the page under it stays put.
    expect(screen.getByTestId("path")).toHaveTextContent("/leads/new?lead=lead-77");
  });

  it("shows leads in the same panel under the accounts, and still shows them once an account is linked", async () => {
    vi.spyOn(api, "customerMatches").mockResolvedValue({
      matches: [account({ customerId: "cust-9", phone: "6155550101", matchedOn: ["phone"], score: 60 })],
      leadMatches: [leadMatch(), leadMatch({ leadId: "lead-78", name: "Eric Ward Jr", status: "new", matchedOn: ["email"] })],
    });
    const first = renderPicker({ includeLeads: true });
    expect(await screen.findByText("This looks like an account you already have")).toBeInTheDocument();
    expect(screen.getByText("Already a lead (2)")).toBeInTheDocument();
    first.unmount();

    renderPicker({ includeLeads: true, linkedCustomerId: "cust-9" });
    expect(await screen.findByText("Already a lead (2)")).toBeInTheDocument();
    expect(screen.getByText(/Linked to/)).toBeInTheDocument();
  });

  it("an edit says that opening another lead replaces this one, and sends excludeLeadId", async () => {
    const spy = vi.spyOn(api, "customerMatches").mockResolvedValue({ matches: [], leadMatches: [leadMatch()] });
    renderPicker({ includeLeads: true, excludeLeadId: "lead-1" });
    expect(await screen.findByText(/Opening another lead replaces this one on screen/)).toBeInTheDocument();
    expect(spy.mock.calls[0][0]).toMatchObject({ includeLeads: true, excludeLeadId: "lead-1" });
  });

  it("copes with a response that has no leadMatches at all, and renders nothing for an empty answer", async () => {
    const spy = vi.spyOn(api, "customerMatches").mockResolvedValue({ matches: [] });
    const { container } = renderPicker({ includeLeads: true });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.querySelector("[data-lead-matches]")).toBeNull();
    expect(screen.queryByText(/Already a lead/)).not.toBeInTheDocument();
  });
});
