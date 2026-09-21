/**
 * Bank statements on Financials (Kyle, 2026-09-20) — the three cards render against the real
 * payload shapes, and the queue's classify form sends the ruling the server expects.
 *
 *  - CashPanel: each account's balance is labelled AS OF its statement; an account with no
 *    statement says so instead of showing a number.
 *  - BankStatementsCard: the registry with its edit/remove, an import control per account, and
 *    every statement with its remove (the undo of a wrong import).
 *  - BankQueueCard: an unclassified line shows its hint and the rules' candidates; saving an
 *    expense with a category calls classifyBankLine with exactly that; an ignore needs a reason.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { BankQueueCard, BankStatementsCard, CashPanel } from "./BankCards";
import { api } from "../lib/api";
import type { BankAccountView, BankLineView, BankStatementView } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function account(overrides: Partial<BankAccountView>): BankAccountView {
  return {
    id: "acct-chk", name: "Chase Checking", institution: "Chase", last4: "1111", kind: "checking", purpose: "operating", isActive: true,
    createdAt: "2026-09-01T12:00:00.000Z",
    balance: { amount: 9558.26, asOf: "2026-09-30T12:00:00.000Z", statementId: "st-1", fileName: "Chase1111_Sep.CSV", importedAt: "2026-10-01T12:00:00.000Z" },
    statementCount: 1, lineCount: 9, unclassified: 1,
    ...overrides,
  };
}

const taxAccount = account({ id: "acct-tax", name: "Chase Tax", last4: "4444", kind: "savings", purpose: "tax", balance: null, statementCount: 0, lineCount: 0, unclassified: 0 });

function line(overrides: Partial<BankLineView>): BankLineView {
  return {
    id: "line-1", accountId: "acct-chk", accountName: "Chase Checking", accountPurpose: "operating", statementId: "st-1",
    postedAt: "2026-09-08T12:00:00.000Z", amount: -250, description: "ORIG CO NAME:ACME INSURANCE ORIG ID:1234567890", bankRef: null, bankType: "ACH_DEBIT",
    runningBalance: 6158.26, payeeKey: "ACME INSURANCE", classification: "unclassified", category: null, transferKind: null,
    counterpartyAccountId: null, counterpartyName: null, matchedKind: null, matchedId: null, matchedMonth: null, matchedLabel: null,
    reason: null, hint: null, classifiedBy: null, classifiedAt: null,
    candidates: { bills: [], purchaseOrders: [], payments: [] },
    ...overrides,
  };
}

const statement: BankStatementView = {
  id: "st-1", accountId: "acct-chk", accountName: "Chase Checking", fileName: "Chase1111_Sep.CSV", format: "chase_csv",
  periodStart: "2026-09-01T12:00:00.000Z", periodEnd: "2026-09-30T12:00:00.000Z", closingBalance: 9558.26, balanceAsOf: "2026-09-30T12:00:00.000Z",
  lineCount: 9, unclassified: 1, importedAt: "2026-10-01T12:00:00.000Z",
};

describe("CashPanel", () => {
  it("shows each account's balance AS OF its statement, and says when there is no statement yet", async () => {
    vi.spyOn(api, "bankAccounts").mockResolvedValue([account({}), taxAccount]);

    renderWithProviders(<CashPanel />);

    expect(await screen.findByText("Chase Checking")).toBeInTheDocument();
    expect(screen.getByText("$9,558.26")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`as of ${new Date("2026-09-30T12:00:00.000Z").toLocaleDateString()} — from the statement, not live`))).toBeInTheDocument();
    expect(screen.getByText("1 line to classify")).toBeInTheDocument();
    // The tax account: registered, never imported — no number invented.
    expect(screen.getByText("Chase Tax")).toBeInTheDocument();
    expect(screen.getByText("tax savings")).toBeInTheDocument();
    expect(screen.getByText("No statement imported yet")).toBeInTheDocument();
  });

  it("points at the registry when nothing is registered", async () => {
    vi.spyOn(api, "bankAccounts").mockResolvedValue([]);
    renderWithProviders(<CashPanel />);
    expect(await screen.findByText(/No bank accounts registered yet/)).toBeInTheDocument();
  });
});

describe("BankStatementsCard", () => {
  it("lists the registry with an import control per account, the imported statements with remove, and removes a statement on click", async () => {
    vi.spyOn(api, "bankAccounts").mockResolvedValue([account({}), taxAccount]);
    vi.spyOn(api, "bankStatements").mockResolvedValue([statement]);
    vi.spyOn(api, "deleteBankStatement").mockResolvedValue(undefined);

    renderWithProviders(<BankStatementsCard />);

    // Folded by default once accounts exist (the header still says what is inside); open it.
    expect(await screen.findByText(/2 accounts · 1 statement imported/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /bank statements/i }));
    expect(await screen.findByLabelText("Import statement for Chase Checking")).toBeInTheDocument();
    expect(screen.getByLabelText("Import statement for Chase Tax")).toBeInTheDocument();
    expect(screen.getByText("checking — operating", { exact: false })).toBeInTheDocument();

    const row = screen.getByText("Chase1111_Sep.CSV", { exact: false }).closest("li")!;
    expect(within(row).getByText(/9 lines/)).toBeInTheDocument();
    expect(within(row).getByText(/1 to classify/)).toBeInTheDocument();
    expect(within(row).getByText(/balance \$9,558\.26/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "remove" }));
    await waitFor(() => expect(api.deleteBankStatement).toHaveBeenCalledWith("st-1"));
    expect(await screen.findByText(/Statement removed — its lines and everything they confirmed are gone/)).toBeInTheDocument();
  });

  it("adds an account with its purpose", async () => {
    vi.spyOn(api, "bankAccounts").mockResolvedValue([]);
    vi.spyOn(api, "bankStatements").mockResolvedValue([]);
    vi.spyOn(api, "createBankAccount").mockResolvedValue(taxAccount);

    renderWithProviders(<BankStatementsCard />);

    // Open by default when the registry is empty.
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Chase Tax" } });
    fireEvent.change(screen.getByLabelText("Last four"), { target: { value: "4444" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "savings" } });
    fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "tax" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.createBankAccount).toHaveBeenCalledWith({ name: "Chase Tax", institution: "Chase", last4: "4444", kind: "savings", purpose: "tax" }));
  });
});

describe("BankQueueCard", () => {
  it("shows the unclassified line with its hint and saves Kyle's ruling as an expense with a category", async () => {
    vi.spyOn(api, "bankLines").mockImplementation(async (params = {}) =>
      params.classification === "unclassified"
        ? [line({ hint: "New money out — pick a category, or match it." })]
        : [line({ id: "line-2", description: "STRIPE DES:TRANSFER", amount: -1500, classification: "transfer", transferKind: "stripe", classifiedBy: "rule", reason: "Money to Stripe — our own money moving." })]);
    vi.spyOn(api, "bankAccounts").mockResolvedValue([account({}), taxAccount]);
    vi.spyOn(api, "companyBills").mockResolvedValue([]);
    vi.spyOn(api, "classifyBankLine").mockResolvedValue(line({ classification: "expense", category: "insurance", classifiedBy: "owner" }));

    renderWithProviders(<BankQueueCard year={2026} />);

    // Open by default while something waits.
    expect(await screen.findByText("ORIG CO NAME:ACME INSURANCE ORIG ID:1234567890")).toBeInTheDocument();
    expect(screen.getByText("New money out — pick a category, or match it.")).toBeInTheDocument();
    expect(screen.getByText("− $250.00")).toBeInTheDocument();
    // The classified list for the year, with the rule's reason and a change button.
    expect(screen.getByText("STRIPE DES:TRANSFER")).toBeInTheDocument();
    expect(screen.getByText(/transfer — to \/ from Stripe/)).toBeInTheDocument();
    expect(screen.getByText(/— Money to Stripe — our own money moving\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "change" })).toBeInTheDocument();

    const form = screen.getByText("ORIG CO NAME:ACME INSURANCE ORIG ID:1234567890").closest("li")!;
    fireEvent.change(within(form).getByLabelText("Classification"), { target: { value: "expense" } });
    fireEvent.change(within(form).getByLabelText("Category"), { target: { value: "insurance" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.classifyBankLine).toHaveBeenCalledWith("line-1", { classification: "expense", category: "insurance", note: null }));
  });

  it("an ignore needs a reason, and a bill match sends the bill and the month", async () => {
    const withCandidate = line({
      id: "line-3", amount: -85, description: "ORIG CO NAME:VERIZON WIRELESS",
      hint: "The amount matches the Verizon Wireless bill — confirm it, or classify as something else.",
      candidates: { bills: [{ id: "bill-vz", name: "Verizon Wireless", amount: 85, month: "2026-09" }], purchaseOrders: [], payments: [] },
    });
    vi.spyOn(api, "bankLines").mockImplementation(async (params = {}) => (params.classification === "unclassified" ? [withCandidate] : []));
    vi.spyOn(api, "bankAccounts").mockResolvedValue([account({})]);
    vi.spyOn(api, "companyBills").mockResolvedValue([]);
    vi.spyOn(api, "classifyBankLine").mockResolvedValue(withCandidate);

    renderWithProviders(<BankQueueCard year={2026} />);

    const form = (await screen.findByText("ORIG CO NAME:VERIZON WIRELESS")).closest("li")!;
    fireEvent.change(within(form).getByLabelText("Classification"), { target: { value: "ignored" } });
    expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Note"), { target: { value: "personal line" } });
    expect(within(form).getByRole("button", { name: "Save" })).toBeEnabled();

    fireEvent.change(within(form).getByLabelText("Classification"), { target: { value: "already_counted" } });
    fireEvent.change(within(form).getByLabelText("Counted as"), { target: { value: "company_bill" } });
    fireEvent.change(within(form).getByLabelText("Bill"), { target: { value: "bill-vz" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.classifyBankLine).toHaveBeenCalledWith("line-3", {
      classification: "already_counted", matchedKind: "company_bill", matchedId: "bill-vz", matchedMonth: "2026-09", note: "personal line",
    }));
  });
});
