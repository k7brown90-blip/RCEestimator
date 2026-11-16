/**
 * The lead form (plan lead-intake-fixes): B1 blank / partial address, B2 the follow-up day and the
 * stale Search panel, B4 Status vs "Call outcome".
 */

import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { LeadForm } from "./LeadForm";
import { api } from "../lib/api";
import type { Lead } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1", name: "Jane Homeowner", email: null, phone: "+16155551234", source: "manual", status: "new",
    leadStatus: "new", notes: null, address: null, addressLine1: null, city: null, state: null,
    postalCode: null, jobType: null, createdAt: "2026-11-14T12:00:00.000Z", receivedAt: "2026-11-14T12:00:00.000Z", updatedAt: "2026-11-14T12:00:00.000Z",
    ...overrides,
  };
}

/** Renders with a query client the test can spy on. */
function renderForm(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return { invalidate };
}

type Payload = Record<string, unknown>;
const lastPayload = (spy: unknown): Payload => {
  const calls = (spy as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[calls.length - 1].find((arg) => typeof arg === "object" && arg !== null) as Payload;
};

function mockWrites() {
  vi.spyOn(api, "customerMatches").mockResolvedValue({ matches: [] });
  vi.spyOn(api, "createLead").mockImplementation((input) =>
    Promise.resolve({ lead: lead({ ...(input as Partial<Lead>) }), matches: [] }));
  vi.spyOn(api, "updateLead").mockImplementation((_id, input) =>
    Promise.resolve(lead({ ...(input as Partial<Lead>) })));
}

describe("LeadForm — address (B1, Kyle: \"Allow part\")", () => {
  it("saves a new lead with the WHERE section untouched: State \"TN\" alone is blank, all four go as null", async () => {
    mockWrites();
    const onSaved = vi.fn();
    renderForm(<LeadForm onSaved={onSaved} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Karmen McKenna" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Lead" }));

    await waitFor(() => expect(api.createLead).toHaveBeenCalled());
    const payload = lastPayload(api.createLead);
    expect(payload.addressLine1).toBeNull();
    expect(payload.addressLine2).toBeNull();
    expect(payload.city).toBeNull();
    expect(payload.state).toBeNull();
    expect(payload.postalCode).toBeNull();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.queryByText(/street, city, state and ZIP together/)).not.toBeInTheDocument();
  });

  it("saves with only part of an address, and keeps State when something else is typed", async () => {
    mockWrites();
    renderForm(<LeadForm onSaved={() => {}} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Yelp Lead" } });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Smyrna" } });
    fireEvent.change(screen.getByLabelText("ZIP"), { target: { value: "37167" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Lead" }));

    await waitFor(() => expect(api.createLead).toHaveBeenCalled());
    const payload = lastPayload(api.createLead);
    expect(payload.addressLine1).toBeNull();
    expect(payload.city).toBe("Smyrna");
    expect(payload.postalCode).toBe("37167");
    expect(payload.state).toBe("TN");
  });

  it("an edit of a lead with no address saves with all four null (the drawer's Save Lead)", async () => {
    mockWrites();
    renderForm(<LeadForm existing={lead()} onSaved={() => {}} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Jane H. Homeowner" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Lead" }));

    await waitFor(() => expect(api.updateLead).toHaveBeenCalled());
    const payload = lastPayload(api.updateLead);
    expect(payload.state).toBeNull();
    expect(payload.city).toBeNull();
  });

  it("tells the office a partial address is fine but converting needs all four", () => {
    mockWrites();
    renderForm(<LeadForm onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/A partial address is fine/)).toBeInTheDocument();
    expect(screen.getByText(/Converting it needs the full street address, city, state and ZIP/)).toBeInTheDocument();
  });
});

describe("LeadForm — follow-up day and the Search panel (B2)", () => {
  it("shows a stored midnight-UTC follow-up as the day that was typed", () => {
    mockWrites();
    renderForm(<LeadForm existing={lead({ status: "contacted", followUpDate: "2026-11-15T00:00:00.000Z" })} onSaved={() => {}} onCancel={() => {}} />);
    expect((screen.getByLabelText("Follow up on") as HTMLInputElement).value).toBe("2026-11-15");
  });

  it("sends the bare day, and invalidates the Search panel after the save", async () => {
    mockWrites();
    const { invalidate } = renderForm(
      <LeadForm existing={lead({ status: "contacted", followUpDate: "2026-11-15T12:00:00.000Z" })} onSaved={() => {}} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Lead" }));

    await waitFor(() => expect(api.updateLead).toHaveBeenCalled());
    expect(lastPayload(api.updateLead).followUpDate).toBe("2026-11-15");
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["search"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["leads"] });
  });
});

describe("LeadForm — Status and Call outcome (B4, Kyle: \"Rename to Call outcome\")", () => {
  const open = () => screen.getByRole("button", { name: /Pipeline & follow-up/ });

  it("labels the second field Call outcome and offers no lost or won to pick", () => {
    mockWrites();
    renderForm(<LeadForm existing={lead({ status: "contacted" })} onSaved={() => {}} onCancel={() => {}} />);
    const outcome = screen.getByLabelText(/Call outcome/) as HTMLSelectElement;
    expect(screen.queryByText("Funnel state")).not.toBeInTheDocument();
    expect([...outcome.options].map((o) => o.value)).toEqual(["new", "booked", "unresolved", "planning", "no_answer"]);
  });

  it("Status lost makes the outcome lost and greys it with the reason; reopening frees it", async () => {
    mockWrites();
    renderForm(<LeadForm existing={lead({ status: "contacted", leadStatus: "planning" })} onSaved={() => {}} onCancel={() => {}} />);
    const status = screen.getByLabelText(/^Status/) as HTMLSelectElement;
    const outcome = () => screen.getByLabelText(/Call outcome/) as HTMLSelectElement;

    fireEvent.change(status, { target: { value: "lost" } });
    expect(outcome().value).toBe("lost");
    expect(outcome()).toBeDisabled();
    expect(screen.getByText(/Lost — set by Status/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Lost because"), { target: { value: "price" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Lead" }));
    await waitFor(() => expect(api.updateLead).toHaveBeenCalled());
    expect(lastPayload(api.updateLead)).toMatchObject({ status: "lost", leadStatus: "lost" });

    fireEvent.change(status, { target: { value: "contacted" } });
    expect(outcome()).not.toBeDisabled();
    expect(outcome().value).toBe("new");
  });

  it("a lost lead opens with the outcome lost and Status as the control that reopens it", () => {
    mockWrites();
    renderForm(<LeadForm existing={lead({ status: "lost", leadStatus: "new", lostReason: "price" })} onSaved={() => {}} onCancel={() => {}} />);
    expect((screen.getByLabelText(/Call outcome/) as HTMLSelectElement).value).toBe("lost");
  });

  it("keeps a stored value the list does not offer (won) so an unrelated edit never changes it", async () => {
    mockWrites();
    renderForm(<LeadForm existing={lead({ status: "new", leadStatus: "won", notes: "x" })} onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.click(open());
    const outcome = screen.getByLabelText(/Call outcome/) as HTMLSelectElement;
    expect(outcome.value).toBe("won");
    expect(outcome.selectedOptions[0].textContent).toBe("won — set by Convert");

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "called back" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Lead" }));
    await waitFor(() => expect(api.updateLead).toHaveBeenCalled());
    expect(lastPayload(api.updateLead)).toMatchObject({ status: "new", leadStatus: "won", notes: "called back" });
  });

  it("a converted lead shows Status as converted, greyed, and still saves", async () => {
    mockWrites();
    renderForm(<LeadForm existing={lead({ status: "converted", leadStatus: "won" })} onSaved={() => {}} onCancel={() => {}} />);
    const status = screen.getByLabelText(/^Status/) as HTMLSelectElement;
    expect(status.value).toBe("converted");
    expect(status).toBeDisabled();
    expect(screen.getByText(/set by the Convert button/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save Lead" }));
    await waitFor(() => expect(api.updateLead).toHaveBeenCalled());
    expect(lastPayload(api.updateLead)).toMatchObject({ status: "converted", leadStatus: "won" });
  });
});

describe("LeadForm — Original received date and Marketplace link (F3)", () => {
  const received = () => screen.getByLabelText(/Original received date/) as HTMLInputElement;
  const link = () => screen.getByLabelText(/Marketplace link/) as HTMLInputElement;

  it("both boxes sit under Where it came from, labelled in plain words", () => {
    mockWrites();
    renderForm(<LeadForm onSaved={() => {}} onCancel={() => {}} />);
    expect(received()).toHaveAttribute("type", "date");
    expect(received().max).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(link()).toHaveAttribute("type", "url");
    expect(screen.getByText(/Leave blank if it came in today/)).toBeInTheDocument();
  });

  it("a new lead with both boxes blank leaves the date OUT (so the server stamps now, not 1970) and sends no link", async () => {
    mockWrites();
    renderForm(<LeadForm onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Plain Lead" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Lead" }));
    await waitFor(() => expect(api.createLead).toHaveBeenCalled());
    const payload = lastPayload(api.createLead);
    expect("receivedAt" in payload).toBe(false);
    expect(payload.sourceUrl).toBeNull();
  });

  it("sends the typed day as a bare YYYY-MM-DD and the link as typed", async () => {
    mockWrites();
    renderForm(<LeadForm onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Jim Robinson" } });
    fireEvent.change(received(), { target: { value: "2026-10-20" } });
    fireEvent.change(link(), { target: { value: " https://www.angi.com/leads/1 " } });
    fireEvent.click(screen.getByRole("button", { name: "Create Lead" }));
    await waitFor(() => expect(api.createLead).toHaveBeenCalled());
    expect(lastPayload(api.createLead)).toMatchObject({ receivedAt: "2026-10-20", sourceUrl: "https://www.angi.com/leads/1" });
  });

  it("refuses a link that is not http or https, and a day in the future, before anything is sent", async () => {
    mockWrites();
    renderForm(<LeadForm onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bad Link" } });
    fireEvent.change(link(), { target: { value: "ftp://example.com/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Lead" }));
    expect(await screen.findByText(/must start with http:\/\/ or https:\/\//)).toBeInTheDocument();

    fireEvent.change(link(), { target: { value: "" } });
    fireEvent.change(received(), { target: { value: "2099-01-01" } });
    // The date box's own max already stops a click on Create Lead in a browser; submit the form
    // directly to prove the form's own check holds when that native one is bypassed.
    fireEvent.submit(received().closest("form") as HTMLFormElement);
    expect(await screen.findByText("Original received date cannot be in the future")).toBeInTheDocument();
    expect(api.createLead).not.toHaveBeenCalled();
  });

  it("an edit that leaves the date alone never sends it — a lead that came in at 9:57 PM stays on its day", async () => {
    mockWrites();
    // 9:57 PM Chicago on 11/14 is 03:57Z on 11/15. Seeding with the UTC date would show 11/15 and a
    // save of any other field would then move the lead a day.
    renderForm(<LeadForm existing={lead({ receivedAt: "2026-11-15T03:57:00.000Z" })} onSaved={() => {}} onCancel={() => {}} />);
    expect(received().value).toBe("2026-11-14");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Jane H. Homeowner" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Lead" }));
    await waitFor(() => expect(api.updateLead).toHaveBeenCalled());
    expect("receivedAt" in lastPayload(api.updateLead)).toBe(false);
  });

  it("an edit that changes the date sends it; clearing it sends blank (back to the day it was entered)", async () => {
    mockWrites();
    renderForm(<LeadForm existing={lead({ receivedAt: "2026-11-14T12:00:00.000Z", sourceUrl: "https://yelp.com/x" })} onSaved={() => {}} onCancel={() => {}} />);
    expect(link().value).toBe("https://yelp.com/x");
    fireEvent.change(received(), { target: { value: "2026-10-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Lead" }));
    await waitFor(() => expect(api.updateLead).toHaveBeenCalledTimes(1));
    expect(lastPayload(api.updateLead).receivedAt).toBe("2026-10-20");

    fireEvent.change(received(), { target: { value: "" } });
    fireEvent.change(link(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Lead" }));
    await waitFor(() => expect(api.updateLead).toHaveBeenCalledTimes(2));
    expect(lastPayload(api.updateLead)).toMatchObject({ receivedAt: "", sourceUrl: null });
  });
});

describe("LeadForm — duplicate warning (F2)", () => {
  it("asks the matcher for same-name accounts and existing leads, and a lead being edited excludes itself", async () => {
    mockWrites();
    renderForm(<LeadForm existing={lead({ name: "Eric Ward" })} onSaved={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(api.customerMatches).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.customerMatches).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "Eric Ward", includeNameOnly: true, includeLeads: true, excludeLeadId: "lead-1" }),
    );
  });

  it("a new lead sends the same two flags and no excludeLeadId", async () => {
    mockWrites();
    renderForm(<LeadForm onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Eric Ward" } });
    await waitFor(() => expect(api.customerMatches).toHaveBeenCalled(), { timeout: 3000 });
    const arg = (api.customerMatches as unknown as { mock: { calls: Record<string, unknown>[][] } }).mock.calls.at(-1)![0];
    expect(arg).toMatchObject({ name: "Eric Ward", includeNameOnly: true, includeLeads: true });
    expect("excludeLeadId" in arg).toBe(false);
  });
});
