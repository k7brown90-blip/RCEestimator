/**
 * Settings: every card folds (Kyle, 2026-11-26: "All cards should have be collapsable in the settings"; "All folded"; a card with a
 * live warning opens by itself; "After that, each card keeps the way it was left").
 *
 * For each converted card: it starts folded, a click on its row opens it, what was typed in it survives a fold and an unfold (the
 * hooks and the typed state live ABOVE the fold, in the card's own component), and where the card can carry a live warning it opens
 * by itself. These tests do NOT pre-open the cards (openCards): the fold is the thing under test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { SettingsPage, PurchasingSection, TreasurySection } from "./SettingsPage";
import { BilledRateSection } from "./BilledRateSection";
import { FinancingPlansSection } from "./FinancingPlansSection";
import { AdminLoginSection } from "./AdminLoginSection";
import { AgentKeysSection } from "./AgentKeysSection";
import { AgentEventsSection } from "./AgentEventsSection";
import { AgentWebhooksSection } from "./AgentWebhooksSection";
import { MessageRemindersSection, REMINDERS_LOCK_REASON } from "./MessageRemindersSection";
import { MessageAuditLogSection } from "./MessageAuditLogSection";
import { api } from "../lib/api";
import { AI_ADMIN_SESSION, OWNER_NO_GRANT, PIN_SESSION } from "../test/sessions";
import type { AgentAccessMode, AgentKeyView, AgentKeysData, HubEventView } from "../lib/types";
import type { AuditResponse } from "../../../shared/hub/views";

afterEach(() => vi.restoreAllMocks());

/** The row that opens and folds a card: its title is the row's name. */
const row = (title: string | RegExp) => screen.getByRole("button", { name: title });
const expanded = (title: string | RegExp) => row(title).getAttribute("aria-expanded") === "true";
const toggle = (title: string | RegExp) => fireEvent.click(row(title));
/** The "Unsaved changes" tag on a card's own row (it sits inside the row button, so it shows while the card is folded). */
const unsavedOn = (title: string | RegExp) => within(row(title)).queryByText("Unsaved changes");

const OK_CONFIG = { urlSet: true, secretSet: true, adminEnvUrlSet: false, adminEnvUrlRefused: false };
const NO_URL_CONFIG = { urlSet: false, secretSet: true, adminEnvUrlSet: false, adminEnvUrlRefused: false };
const access = (mode: AgentAccessMode) => ({ mode, changedAt: null, changedBy: null });

const TITLES = [
  "Company profile", "Operating hours", "Service territories", "Legal & warranty", "Purchasing", "Billed labor rate", "Payroll",
  "Financing plans (Synchrony)", "Treasury", "AI admin login", "Agent keys", "Agent events", "Agent webhooks", "Message reminders", "Message audit log",
];

function mockEverything() {
  vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
  vi.spyOn(api, "companySettings").mockResolvedValue({ companyProfile: { companyName: "Example Electric", licenseNumber: "L-123" }, purchasing: { salesTaxRate: 0.0975 }, payroll: { employerCostPercent: 9.5 }, territories: [] } as never);
  vi.spyOn(api, "treasurySettings").mockResolvedValue({ mainFinancialAccountId: null, mainFloat: 0, truckFloats: {}, chaseAccountLabel: null, chaseExternalAccountId: null } as never);
  vi.spyOn(api, "financialsBalances").mockResolvedValue({ available: false, reason: "not connected" } as never);
  vi.spyOn(api, "trucks").mockResolvedValue({ trucks: [] } as never);
  vi.spyOn(api, "billedRate").mockResolvedValue({ rate: 100 });
  vi.spyOn(api, "financingPlans").mockResolvedValue({ plans: [] });
  vi.spyOn(api, "adminLogin").mockResolvedValue({ configured: false, enabled: false, username: null } as never);
  vi.spyOn(api, "agentKeys").mockResolvedValue({ pepperConfigured: true, environment: "live", agentAccess: access("on"), keys: [] });
  vi.spyOn(api, "hubEventsConfig").mockResolvedValue(OK_CONFIG);
  vi.spyOn(api, "hubEvents").mockResolvedValue({ events: [], nextBefore: null });
  vi.spyOn(api, "agentWebhooks").mockResolvedValue({ key: "agentWebhooks", value: { targets: [], routes: {} }, status: { pepperSet: true } } as never);
  vi.spyOn(api, "hubNotify").mockResolvedValue({ key: "hubNotify", value: { start: "08:00", end: "20:00" } } as never);
  vi.spyOn(api, "hubAudit").mockResolvedValue({ entries: [], actors: [], more: false });
}

describe("Settings page: all fifteen cards, folded", () => {
  it("opens as a list of the fifteen card titles, every one folded, with the new one-line header", async () => {
    mockEverything();
    renderWithProviders(<SettingsPage />);
    expect(screen.getByText("Click a card to open it: company details, pricing and money, AI agents, and messages.")).toBeInTheDocument();
    for (const title of TITLES) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
      expect(expanded(title), `${title} starts folded`).toBe(false);
    }
    expect(TITLES).toHaveLength(15);
    // A folded row carries its one-line status.
    await waitFor(() => expect(screen.getByText("9.5% employer cost")).toBeInTheDocument());
    expect(screen.getByText("9.75% sales tax")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("$100.00 / hr")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Agents: Running · 0 keys")).toBeInTheDocument());
    // Once the saved values have loaded into the forms, no card has opened itself (loading is not "unsaved changes").
    for (const title of TITLES) expect(expanded(title), `${title} is still folded after load`).toBe(false);
    expect(document.querySelectorAll("[data-testid='unsaved-note']")).toHaveLength(0);
  });

  it("a click on a card's row opens it and shows its one plain sentence; a second click folds it", async () => {
    mockEverything();
    renderWithProviders(<SettingsPage />);
    expect(screen.queryByText("The hours customers are shown.")).toBeNull();
    toggle("Operating hours");
    expect(screen.getByText("The hours customers are shown.")).toBeInTheDocument();
    expect(screen.getByLabelText("Weekdays")).toBeInTheDocument();
    toggle("Operating hours");
    expect(screen.queryByLabelText("Weekdays")).toBeNull();
  });

  it("Company profile, Operating hours, Service territories, Legal & warranty and Payroll keep what was typed across a fold and an unfold", async () => {
    mockEverything();
    renderWithProviders(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("9.5% employer cost")).toBeInTheDocument());
    toggle("Company profile");
    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Typed Name LLC" } });
    toggle("Company profile");
    expect(screen.queryByLabelText("Company name")).toBeNull();
    toggle("Company profile");
    expect((screen.getByLabelText("Company name") as HTMLInputElement).value).toBe("Typed Name LLC");

    toggle("Payroll");
    fireEvent.change(screen.getByLabelText("Employer cost on top of wages (%)"), { target: { value: "11" } });
    toggle("Payroll");
    toggle("Payroll");
    expect((screen.getByLabelText("Employer cost on top of wages (%)") as HTMLInputElement).value).toBe("11");

    toggle("Operating hours");
    fireEvent.change(screen.getByLabelText("Weekdays"), { target: { value: "7:00 AM – 3:00 PM" } });
    toggle("Operating hours");
    toggle("Operating hours");
    expect((screen.getByLabelText("Weekdays") as HTMLInputElement).value).toBe("7:00 AM – 3:00 PM");

    toggle("Service territories");
    fireEvent.click(screen.getByRole("button", { name: "Add territory" }));
    fireEvent.change(screen.getByLabelText("ZIP code"), { target: { value: "37064" } });
    toggle("Service territories");
    toggle("Service territories");
    expect((screen.getByLabelText("ZIP code") as HTMLInputElement).value).toBe("37064");

    toggle("Legal & warranty");
    fireEvent.change(screen.getByLabelText("Warranty terms"), { target: { value: "Twelve months on workmanship." } });
    toggle("Legal & warranty");
    toggle("Legal & warranty");
    expect((screen.getByLabelText("Warranty terms") as HTMLTextAreaElement).value).toBe("Twelve months on workmanship.");
  });

  // Kyle, 2026-11-26: "A card with a live warning (agents off, events not being sent, unsaved changes) opens by itself", and a folded
  // card must never hide typing that is not saved. The tag shows on the folded row, and the typing is not wiped when ANOTHER card is
  // saved (every save refetches the company settings; before, that reset all five forms and the Sales tax box).
  it("a typed, unsaved edit shows 'Unsaved changes' on the folded row of each page card, and it clears once saved", async () => {
    let employerCost: number | null = 9.5;
    mockEverything();
    vi.spyOn(api, "companySettings").mockImplementation(async () => ({ companyProfile: { companyName: "Example Electric", licenseNumber: "L-123" }, purchasing: { salesTaxRate: 0.0975 }, payroll: { employerCostPercent: employerCost }, territories: [] }) as never);
    vi.spyOn(api, "saveCompanySetting").mockImplementation(async (k: string, v: unknown) => { if (k === "payroll") employerCost = (v as { employerCostPercent: number | null }).employerCostPercent; return {} as never; });
    renderWithProviders(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("9.5% employer cost")).toBeInTheDocument());
    const edits: Array<[string, string, string]> = [
      ["Company profile", "Business phone", "615-555-0100"],
      ["Operating hours", "Saturday", "9:00 AM – 1:00 PM"],
      ["Legal & warranty", "Insurance documentation notes", "COI is in the truck binder."],
      ["Payroll", "Employer cost on top of wages (%)", "11"],
    ];
    for (const [title, label, text] of edits) {
      expect(unsavedOn(title), `${title} starts clean`).toBeNull();
      toggle(title);
      fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
      toggle(title); // fold it with the typing still in it
      expect(unsavedOn(title), `${title} says so while folded`).not.toBeNull();
    }
    toggle("Service territories");
    fireEvent.click(screen.getByRole("button", { name: "Add territory" }));
    toggle("Service territories");
    expect(unsavedOn("Service territories")).not.toBeNull();

    // Saving Payroll lands: its own tag clears, and the other folded cards still hold their typing.
    toggle("Payroll");
    fireEvent.click(screen.getByRole("button", { name: "Save payroll" }));
    await waitFor(() => expect(screen.getByText("11% employer cost")).toBeInTheDocument());
    await waitFor(() => expect(unsavedOn("Payroll")).toBeNull());
    expect((screen.getByLabelText("Employer cost on top of wages (%)") as HTMLInputElement).value).toBe("11");
    for (const title of ["Company profile", "Operating hours", "Legal & warranty", "Service territories"]) {
      expect(unsavedOn(title), `${title} keeps its tag after another card was saved`).not.toBeNull();
    }
    toggle("Company profile");
    expect((screen.getByLabelText("Business phone") as HTMLInputElement).value).toBe("615-555-0100");
    toggle("Operating hours");
    expect((screen.getByLabelText("Saturday") as HTMLInputElement).value).toBe("9:00 AM – 1:00 PM");
    toggle("Legal & warranty");
    expect((screen.getByLabelText("Insurance documentation notes") as HTMLTextAreaElement).value).toBe("COI is in the truck binder.");
  });

  it("saving Payroll does not wipe a Sales tax rate typed in Purchasing and then folded", async () => {
    let employerCost: number | null = 9.5;
    mockEverything();
    vi.spyOn(api, "companySettings").mockImplementation(async () => ({ purchasing: { salesTaxRate: 0.0975 }, payroll: { employerCostPercent: employerCost }, territories: [] }) as never);
    vi.spyOn(api, "saveCompanySetting").mockImplementation(async (k: string, v: unknown) => { if (k === "payroll") employerCost = (v as { employerCostPercent: number | null }).employerCostPercent; return {} as never; });
    renderWithProviders(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("9.75% sales tax")).toBeInTheDocument());
    toggle("Purchasing");
    fireEvent.change(screen.getByLabelText("Sales tax rate (%)"), { target: { value: "8.5" } });
    toggle("Purchasing");
    expect(unsavedOn("Purchasing")).not.toBeNull();
    expect(screen.getByText("9.75% sales tax")).toBeInTheDocument(); // the saved rate is still what the row reads

    toggle("Payroll");
    fireEvent.change(screen.getByLabelText("Employer cost on top of wages (%)"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payroll" }));
    await waitFor(() => expect(screen.getByText("11% employer cost")).toBeInTheDocument());

    expect(unsavedOn("Purchasing")).not.toBeNull();
    toggle("Purchasing");
    expect((screen.getByLabelText("Sales tax rate (%)") as HTMLInputElement).value).toBe("8.5");
  });

  it("no card still says 'voice agent', and no card quotes a dated ruling on screen", async () => {
    mockEverything();
    renderWithProviders(<SettingsPage />);
    for (const title of ["Company profile", "Operating hours", "Purchasing", "Payroll", "AI admin login"]) toggle(title);
    expect(document.body.textContent).not.toMatch(/voice agent/i);
    expect(document.body.textContent).not.toMatch(/Kyle, 20\d\d-\d\d-\d\d/);
  });
});

describe("Settings: Purchasing and Treasury keep typed edits across a fold", () => {
  it("Purchasing: the typed sales tax rate survives", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "companySettings").mockResolvedValue({ purchasing: { salesTaxRate: 0.0975 } } as never);
    renderWithProviders(<PurchasingSection />);
    expect(expanded("Purchasing")).toBe(false);
    toggle("Purchasing");
    fireEvent.change(screen.getByLabelText("Sales tax rate (%)"), { target: { value: "8.5" } });
    toggle("Purchasing");
    toggle("Purchasing");
    expect((screen.getByLabelText("Sales tax rate (%)") as HTMLInputElement).value).toBe("8.5");
  });

  it("Treasury: the typed main float survives", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "treasurySettings").mockResolvedValue({ mainFinancialAccountId: null, mainFloat: 0, truckFloats: {}, chaseAccountLabel: null, chaseExternalAccountId: null } as never);
    vi.spyOn(api, "financialsBalances").mockResolvedValue({ available: false, reason: "x" } as never);
    vi.spyOn(api, "trucks").mockResolvedValue({ trucks: [] } as never);
    renderWithProviders(<TreasurySection />);
    expect(expanded("Treasury")).toBe(false);
    toggle("Treasury");
    fireEvent.change(screen.getByLabelText(/Main float/), { target: { value: "2500" } });
    toggle("Treasury");
    toggle("Treasury");
    expect((screen.getByLabelText(/Main float/) as HTMLInputElement).value).toBe("2500");
  });

  it("Treasury and Purchasing say 'Unsaved changes' on the folded row while a typed value is not saved, and not before", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "companySettings").mockResolvedValue({ purchasing: { salesTaxRate: 0.0975 } } as never);
    vi.spyOn(api, "treasurySettings").mockResolvedValue({ mainFinancialAccountId: null, mainFloat: 0, truckFloats: {}, chaseAccountLabel: null, chaseExternalAccountId: null } as never);
    vi.spyOn(api, "financialsBalances").mockResolvedValue({ available: false, reason: "x" } as never);
    vi.spyOn(api, "trucks").mockResolvedValue({ trucks: [] } as never);
    renderWithProviders(<><PurchasingSection /><TreasurySection /></>);
    await waitFor(() => expect(screen.getByText("9.75% sales tax")).toBeInTheDocument());
    expect(unsavedOn("Treasury")).toBeNull();
    expect(unsavedOn("Purchasing")).toBeNull();
    toggle("Treasury");
    fireEvent.change(screen.getByLabelText(/Main float/), { target: { value: "2500" } });
    toggle("Treasury");
    expect(unsavedOn("Treasury")).not.toBeNull();
    // Typing the number back to what is saved (0 and 0.00 are the same float) clears the tag again.
    toggle("Treasury");
    fireEvent.change(screen.getByLabelText(/Main float/), { target: { value: "0.00" } });
    expect(unsavedOn("Treasury")).toBeNull();
  });
});

describe("Settings: Billed labor rate", () => {
  it("starts folded with the rate on its row, opens on a click, and keeps the typed rate across a fold", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "billedRate").mockResolvedValue({ rate: 100 });
    renderWithProviders(<BilledRateSection />);
    expect(expanded("Billed labor rate")).toBe(false);
    await waitFor(() => expect(screen.getByText("$100.00 / hr")).toBeInTheDocument());
    toggle("Billed labor rate");
    fireEvent.change(screen.getByLabelText("New hourly rate ($)"), { target: { value: "112.5" } });
    toggle("Billed labor rate");
    toggle("Billed labor rate");
    expect((screen.getByLabelText("New hourly rate ($)") as HTMLInputElement).value).toBe("112.5");
    // A rate typed and not applied shows on the folded row.
    toggle("Billed labor rate");
    expect(unsavedOn("Billed labor rate")).not.toBeNull();
  });
});

describe("Settings: Financing plans", () => {
  const plan = { planNumber: "965", type: "reduced_apr" as const, description: "11.99% APR until paid in full", months: 86, apr: 11.99, paymentFactorPct: 1.75, discountRatePct: 6.1, active: true, sortOrder: 1, disclosure: { explanation: "e", important: "i", terms: "t" } };

  it("starts folded with the plan count, and unsaved edits survive folding the card and show on its folded row", async () => {
    vi.spyOn(api, "financingPlans").mockResolvedValue({ plans: [plan] });
    renderWithProviders(<FinancingPlansSection />);
    expect(expanded("Financing plans (Synchrony)")).toBe(false);
    await waitFor(() => expect(screen.getByText("1 plan, 1 offered")).toBeInTheDocument());
    toggle("Financing plans (Synchrony)");
    fireEvent.click(within(screen.getByTestId("financing-plan-0")).getAllByRole("button")[0]);
    fireEvent.change(screen.getByDisplayValue("6.1"), { target: { value: "6.4" } });
    // Unsaved: the card's own row says so.
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0);
    toggle("Financing plans (Synchrony)");
    expect(screen.queryByDisplayValue("6.4")).toBeNull();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument(); // still on the folded row
    toggle("Financing plans (Synchrony)");
    // The plan was left open inside the card, so it is still open, with the unsaved value in it.
    expect(screen.getByDisplayValue("6.4")).toBeInTheDocument();
  });

  it("an edit marks the card 'Unsaved changes', and a plan just added opens at once", async () => {
    localStorage.setItem("rce.card.settings-financing-plans", "0");
    vi.spyOn(api, "financingPlans").mockResolvedValue({ plans: [plan] });
    renderWithProviders(<FinancingPlansSection />);
    expect(expanded("Financing plans (Synchrony)")).toBe(false);
    await waitFor(() => expect(screen.getByText("1 plan, 1 offered")).toBeInTheDocument());
    toggle("Financing plans (Synchrony)"); // open it by hand to make an edit
    fireEvent.click(screen.getByRole("button", { name: "Add a plan" }));
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0);
    // A freshly added plan opens at once.
    expect(screen.getByLabelText("Plan number")).toBeInTheDocument();
  });
});

describe("Settings: Financing plans keep their fold through Save and Discard", () => {
  const plan = (n: string) => ({ planNumber: n, type: "reduced_apr" as const, description: `Plan text ${n}`, months: 86, apr: 11.99, paymentFactorPct: 1.75, discountRatePct: 6.1, active: true, sortOrder: 1, disclosure: { explanation: "e", important: "i", terms: "t" } });

  it("a plan that was open is still open after 'Save financing plans', and after 'Discard changes'", async () => {
    vi.spyOn(api, "financingPlans").mockResolvedValue({ plans: [plan("965"), plan("966")] });
    vi.spyOn(api, "saveCompanySetting").mockResolvedValue({} as never);
    renderWithProviders(<FinancingPlansSection />);
    await waitFor(() => expect(screen.getByText("2 plans, 2 offered")).toBeInTheDocument());
    toggle("Financing plans (Synchrony)");
    // Open plan 966 only, then edit it.
    fireEvent.click(screen.getByRole("button", { name: /Plan 966/ }));
    expect(screen.getByRole("button", { name: /Plan 966/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Plan 965/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.change(screen.getByDisplayValue("Plan text 966"), { target: { value: "Plan text 966, new wording" } });
    fireEvent.click(screen.getByRole("button", { name: "Save financing plans" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Saved ✓" })).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    // Still open (the reload gave each plan its fold back), and the other plan is still folded.
    expect(screen.getByRole("button", { name: /Plan 966/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Plan 965/ })).toHaveAttribute("aria-expanded", "false");

    // Discard: edit again, discard, the plan is still open and shows the saved text.
    fireEvent.change(screen.getByDisplayValue("Plan text 966"), { target: { value: "scratch" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("button", { name: /Plan 966/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByDisplayValue("Plan text 966")).toBeInTheDocument();
  });

  it("a plan added with 'Add a plan' and then saved stays open", async () => {
    // The server keeps what was saved, so the reload after Save returns the new list.
    let stored = [plan("965")];
    vi.spyOn(api, "financingPlans").mockImplementation(async () => ({ plans: stored }));
    vi.spyOn(api, "saveCompanySetting").mockImplementation(async (_k: string, v: unknown) => { stored = v as typeof stored; return {} as never; });
    renderWithProviders(<FinancingPlansSection />);
    await waitFor(() => expect(screen.getByText("1 plan, 1 offered")).toBeInTheDocument());
    toggle("Financing plans (Synchrony)");
    fireEvent.click(screen.getByRole("button", { name: "Add a plan" }));
    expect(screen.getByLabelText("Plan number")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save financing plans" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Saved ✓" })).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    // The new (second) plan kept its place and its fold through the reload.
    expect(screen.getByLabelText("Plan number")).toBeInTheDocument();
  });
});

describe("Settings: AI admin login", () => {
  it("starts folded with its status, and the typed username survives a fold", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "adminLogin").mockResolvedValue({ configured: false, enabled: false, username: null } as never);
    renderWithProviders(<AdminLoginSection />);
    expect(expanded("AI admin login")).toBe(false);
    await waitFor(() => expect(screen.getByText("Not set up")).toBeInTheDocument());
    toggle("AI admin login");
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "grok-admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "half-typed" } });
    toggle("AI admin login");
    toggle("AI admin login");
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("grok-admin");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("half-typed");
    // Typed, not saved: the folded row says so.
    toggle("AI admin login");
    expect(unsavedOn("AI admin login")).not.toBeNull();
  });

  it("a saved username loading into its box is not 'unsaved' and does not open the card; typing a new name or a password is", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "adminLogin").mockResolvedValue({ configured: true, enabled: true, username: "grok-admin" } as never);
    renderWithProviders(<AdminLoginSection />);
    await waitFor(() => expect(screen.getByText("On — signs in as grok-admin")).toBeInTheDocument());
    expect(expanded("AI admin login")).toBe(false);
    expect(unsavedOn("AI admin login")).toBeNull();
    toggle("AI admin login");
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("grok-admin");
    expect(unsavedOn("AI admin login")).toBeNull();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
    expect(unsavedOn("AI admin login")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "" } });
    expect(unsavedOn("AI admin login")).toBeNull();
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "other-name" } });
    expect(unsavedOn("AI admin login")).not.toBeNull();
  });
});

const key = (over: Partial<AgentKeyView> = {}): AgentKeyView => ({
  id: "k1", name: "Admin Agent", agentRole: "admin", environment: "live", displayPrefix: "rce_live_AbC1",
  scopes: ["crm:read"], hubThreadKinds: [], writesEnabled: false, teamPostsPublish: true, expiresAt: null, retiresAt: null,
  revokedAt: null, revokedReason: null, lastUsedAt: null, lastUsedTool: null, createdAt: "2026-11-21T10:00:00-06:00",
  createdBy: "owner", rotatedFromId: null, status: "active", ...over,
});

describe("Settings: Agent keys", () => {
  const load = (d: Partial<AgentKeysData>) => vi.spyOn(api, "agentKeys").mockResolvedValue({ pepperConfigured: true, environment: "live", agentAccess: access("on"), keys: [key()], ...d });

  it("starts folded saying Agents: Running, and a typed new-key name survives a fold", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    load({});
    renderWithProviders(<AgentKeysSection />);
    expect(expanded("Agent keys")).toBe(false);
    await waitFor(() => expect(screen.getByText("Agents: Running · 1 key")).toBeInTheDocument());
    toggle("Agent keys");
    await waitFor(() => expect((screen.getByRole("button", { name: "+ New agent key" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "+ New agent key" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Half typed" } });
    toggle("Agent keys");
    expect(screen.queryByLabelText("Name")).toBeNull();
    toggle("Agent keys");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Half typed");
  });

  it("opens by itself while writes are paused or the agents are off, saying so on the row", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    load({ agentAccess: access("read_only") });
    renderWithProviders(<AgentKeysSection />);
    await waitFor(() => expect(expanded("Agent keys")).toBe(true));
    expect(screen.getByText("Writes paused · 1 key")).toBeInTheDocument();
    expect(screen.getByTestId("agent-access-banner")).toBeInTheDocument();
  });

  it("refuses to fold while a new key is on screen, and folds again after 'I've saved it'", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    load({});
    vi.spyOn(api, "createAgentKey").mockResolvedValue({ key: key({ id: "k9", name: "Fresh" }), secret: "rce_live_ONLYSHOWNONCE" });
    renderWithProviders(<AgentKeysSection />);
    toggle("Agent keys");
    await waitFor(() => expect((screen.getByRole("button", { name: "+ New agent key" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "+ New agent key" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByTestId("agent-key-secret")).toHaveTextContent("rce_live_ONLYSHOWNONCE");
    toggle("Agent keys");
    expect(screen.getByTestId("agent-key-secret")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "I've saved it" }));
    expect(screen.queryByTestId("agent-key-secret")).toBeNull();
    toggle("Agent keys");
    expect(screen.queryByRole("button", { name: "+ New agent key" })).toBeNull();
  });

  it("a replaced key leaves the main table for the folded Revoked list, so the table holds only working keys", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    load({ keys: [key({ id: "w", name: "Working one" }), key({ id: "r", name: "Replaced one", status: "retired", retiresAt: "2026-11-20T10:00:00-06:00" }), key({ id: "x", name: "Revoked one", status: "revoked", revokedAt: "2026-11-20T10:00:00-06:00", revokedReason: "lost" })] });
    renderWithProviders(<AgentKeysSection />);
    toggle("Agent keys");
    await screen.findByText("Working one");
    expect(screen.getByTestId("agent-key-w")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-key-r")).toBeNull();
    const tucked = screen.getByTestId("agent-revoked-keys");
    expect(within(tucked).getByText("Revoked and replaced keys (2)")).toBeInTheDocument();
    expect(within(tucked).getByText("Replaced one")).toBeInTheDocument();
    expect(within(tucked).getByText(/Replaced — stopped/)).toBeInTheDocument();
    expect(within(tucked).getByText("Revoked one")).toBeInTheDocument();
    // The replaced key keeps its Activity button (rows are never deleted: the log points at them).
    expect(within(tucked).getAllByRole("button", { name: "Activity" })).toHaveLength(2);
  });
});

const ev = (n: number): HubEventView => ({
  id: `e${n}`, type: "estimate.signed", createdAt: "2026-11-21T15:02:00-06:00", summary: `Event number ${n}`,
  status: "delivered", target: "admin", attempts: 1, lastError: null, lastStatusCode: 200, nextAttemptAt: null,
  deliveredAt: "2026-11-21T15:02:01-06:00", attemptLog: [],
});

describe("Settings: Agent events", () => {
  it("starts folded saying events are being sent, and shows 20 rows first, then the rest loaded, then fetches more", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "hubEventsConfig").mockResolvedValue(OK_CONFIG);
    const first = Array.from({ length: 30 }, (_, i) => ev(i + 1));
    const list = vi.spyOn(api, "hubEvents").mockImplementation(async (f) => (f?.before ? { events: [ev(31)], nextBefore: null } : { events: first, nextBefore: "cursor-1" }));
    renderWithProviders(<AgentEventsSection />);
    expect(expanded("Agent events")).toBe(false);
    await waitFor(() => expect(screen.getByText("Events are being sent")).toBeInTheDocument());
    toggle("Agent events");
    await screen.findByText("Event number 1");
    expect(screen.getByText("Event number 20")).toBeInTheDocument();
    expect(screen.queryByText("Event number 21")).toBeNull();
    // 1st press: the rows already loaded (21-30), no server call for older ones yet.
    const callsBefore = list.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
    expect(screen.getByText("Event number 30")).toBeInTheDocument();
    expect(list.mock.calls.length).toBe(callsBefore);
    // 2nd press: the next page from the server.
    fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
    expect(await screen.findByText("Event number 31")).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ before: "cursor-1" }));
  });

  it("opens by itself while events are not being sent (no receiving address), and the chosen Agent filter survives a fold", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "hubEventsConfig").mockResolvedValue(NO_URL_CONFIG);
    vi.spyOn(api, "hubEvents").mockResolvedValue({ events: [], nextBefore: null });
    renderWithProviders(<AgentEventsSection />);
    await waitFor(() => expect(expanded("Agent events")).toBe(true));
    expect(screen.getByText("Not sent: no receiving address — events are being kept")).toBeInTheDocument();
    expect(screen.getByTestId("agent-events-no-url")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "cfo" } });
    toggle("Agent events");
    expect(screen.queryByLabelText("Agent")).toBeNull();
    toggle("Agent events");
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("cfo");
  });
});

describe("Settings: Agent webhooks", () => {
  const configured = { targets: [{ id: "admin", url: "https://agents.example.com/hook", enabled: true, headers: [], signingSecret: null, secretSource: "env" }], routes: {} };
  const mockHooks = (config = OK_CONFIG, value: unknown = configured) => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "hubEventsConfig").mockResolvedValue(config);
    vi.spyOn(api, "hubEvents").mockResolvedValue({ events: [], nextBefore: null });
    vi.spyOn(api, "agentWebhooks").mockResolvedValue({ key: "agentWebhooks", value, status: { pepperSet: true } } as never);
  };

  it("starts folded with how many agents are sending; each agent block folds the same way, and a typed address survives folding the card", async () => {
    mockHooks();
    renderWithProviders(<AgentWebhooksSection />);
    expect(expanded("Agent webhooks")).toBe(false);
    await waitFor(() => expect(screen.getByText("1 of 8 agents sending")).toBeInTheDocument());
    toggle("Agent webhooks");
    // Kyle, 2026-11-26 ("Fold each webhook agent" / "All folded"): Admin is set up and CFO is not, and BOTH start folded.
    expect(within(screen.getByTestId("webhook-target-admin")).queryByRole("button", { name: "Edit address" })).toBeNull();
    expect(within(screen.getByTestId("webhook-target-cfo")).queryByRole("button", { name: "Edit address" })).toBeNull();
    fireEvent.click(within(screen.getByTestId("webhook-target-admin")).getAllByRole("button")[0]);
    expect(within(screen.getByTestId("webhook-target-admin")).getByRole("button", { name: "Edit address" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("webhook-target-cfo")).getAllByRole("button")[0]);
    fireEvent.click(within(screen.getByTestId("webhook-target-cfo")).getByRole("button", { name: "Edit address" }));
    fireEvent.change(screen.getByLabelText("CFO receiving address"), { target: { value: "https://half.example.com/typ" } });
    toggle("Agent webhooks");
    expect(screen.queryByLabelText("CFO receiving address")).toBeNull();
    toggle("Agent webhooks");
    expect((screen.getByLabelText("CFO receiving address") as HTMLInputElement).value).toBe("https://half.example.com/typ");
  });

  it("a typed receiving address that is not saved shows 'Unsaved changes' on the folded card's row", async () => {
    mockHooks();
    renderWithProviders(<AgentWebhooksSection />);
    await waitFor(() => expect(screen.getByText("1 of 8 agents sending")).toBeInTheDocument());
    expect(unsavedOn("Agent webhooks")).toBeNull();
    toggle("Agent webhooks");
    // Every agent block starts folded, set up or not (Kyle, 2026-11-26: "All folded").
    for (const id of ["admin", "cfo"]) expect(within(screen.getByTestId(`webhook-target-${id}`)).getByRole("button", { expanded: false })).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("webhook-target-cfo")).getAllByRole("button")[0]);
    fireEvent.click(within(screen.getByTestId("webhook-target-cfo")).getByRole("button", { name: "Edit address" }));
    expect(unsavedOn("Agent webhooks")).toBeNull(); // opening the editor changes nothing yet
    fireEvent.change(screen.getByLabelText("CFO receiving address"), { target: { value: "https://half.example.com/typ" } });
    toggle("Agent webhooks");
    expect(unsavedOn("Agent webhooks")).not.toBeNull();
  });

  it("opens by itself while events are not being sent", async () => {
    mockHooks(NO_URL_CONFIG);
    renderWithProviders(<AgentWebhooksSection />);
    await waitFor(() => expect(expanded("Agent webhooks")).toBe(true));
    expect(screen.getByText(/Admin's events are not being sent/)).toBeInTheDocument();
  });

  it("refuses to fold while a signing secret is on screen, then folds after 'I've saved it'", async () => {
    mockHooks();
    vi.spyOn(api, "generateWebhookSecret").mockResolvedValue({ secret: "whsec_ONLYSHOWNONCE", replaced: false } as never);
    renderWithProviders(<AgentWebhooksSection />);
    toggle("Agent webhooks");
    fireEvent.click(within(screen.getByTestId("webhook-target-admin")).getAllByRole("button")[0]); // the block starts folded
    await waitFor(() => expect((within(screen.getByTestId("webhook-target-admin")).getByRole("button", { name: "Edit address" }) as HTMLButtonElement).disabled).toBe(false));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(within(screen.getByTestId("webhook-target-admin")).getByRole("button", { name: "Generate signing secret" }));
    expect(await screen.findByTestId("webhook-secret-value-admin")).toHaveTextContent("whsec_ONLYSHOWNONCE");
    toggle("Agent webhooks");
    expect(screen.getByTestId("webhook-secret-value-admin")).toBeInTheDocument();
    // The agent's own block cannot fold either while its secret is showing, and says why on its row (greyed, with the reason in words).
    const adminRow = within(screen.getByTestId("webhook-target-admin")).getAllByRole("button")[0];
    fireEvent.click(adminRow);
    expect(screen.getByTestId("webhook-secret-value-admin")).toBeInTheDocument();
    expect(adminRow.className).toContain("opacity-60");
    expect(screen.getByTestId("collapsible-settings-webhook-admin-lock-reason")).toHaveTextContent("I've saved it");
    expect(screen.getByTestId("collapsible-settings-agent-webhooks-lock-reason")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "I've saved it" }));
    toggle("Agent webhooks");
    expect(screen.queryByTestId("webhook-secret-value-admin")).toBeNull();
  });
});

describe("Settings: Message reminders", () => {
  it("starts folded with the hours on its row, and a typed time survives a fold; the lock reason is printed once for another login", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "hubNotify").mockResolvedValue({ key: "hubNotify", value: { start: "08:00", end: "20:00" } } as never);
    renderWithProviders(<MessageRemindersSection />);
    expect(expanded("Message reminders")).toBe(false);
    await waitFor(() => expect(screen.getByText("8:00 AM – 8:00 PM, Mon–Fri")).toBeInTheDocument());
    toggle("Message reminders");
    await waitFor(() => expect(screen.getByLabelText("From")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "09:15" } });
    toggle("Message reminders");
    toggle("Message reminders");
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("09:15");
  });
});

describe("Settings: Message reminders for a login that cannot change them", () => {
  it.each([["another person's login", OWNER_NO_GRANT], ["the AI admin", AI_ADMIN_SESSION]])("prints the lock reason exactly once, on the card's row, for %s", async (_who, session) => {
    vi.spyOn(api, "session").mockResolvedValue(session);
    const read = vi.spyOn(api, "hubNotify").mockResolvedValue({ key: "hubNotify", value: { start: "08:00", end: "20:00" } } as never);
    renderWithProviders(<MessageRemindersSection />);
    // Folded: the row carries it.
    await waitFor(() => expect(screen.getAllByText(REMINDERS_LOCK_REASON)).toHaveLength(1));
    expect(expanded("Message reminders")).toBe(false);
    // Opened: still once (the body does not repeat it), and the boxes are greyed.
    toggle("Message reminders");
    expect(screen.getAllByText(REMINDERS_LOCK_REASON)).toHaveLength(1);
    expect(screen.getByLabelText("From")).toBeDisabled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("Settings: Message audit log", () => {
  const entry = (n: number): AuditResponse["entries"][number] => ({
    id: `a-${n}`, at: `2026-11-21T18:${String(59 - n).padStart(2, "0")}:00.000Z`, actorKey: "owner", actorDisplay: "Kyle", action: "message_approved", actionLabel: "Approved",
    threadId: null, threadTitle: null, messageId: null, reason: null, messageClass: null, category: null, summary: `Audit row ${n}`,
  });

  it("starts folded, shows 20 rows first, then the rest loaded, then fetches more", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    const audit = vi.spyOn(api, "hubAudit").mockImplementation(async (f) => (f?.before
      ? { entries: [entry(31)], actors: [], more: false }
      : { entries: Array.from({ length: 30 }, (_, i) => entry(i + 1)), actors: [], more: true }));
    renderWithProviders(<MessageAuditLogSection />);
    expect(expanded("Message audit log")).toBe(false);
    toggle("Message audit log");
    await screen.findByText("Audit row 1");
    expect(screen.getByText("Audit row 20")).toBeInTheDocument();
    expect(screen.queryByText("Audit row 21")).toBeNull();
    const callsBefore = audit.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    expect(screen.getByText("Audit row 30")).toBeInTheDocument();
    expect(audit.mock.calls.length).toBe(callsBefore);
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    expect(await screen.findByText("Audit row 31")).toBeInTheDocument();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ before: expect.any(String) }));
  });
});
