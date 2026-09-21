/**
 * Bank statements on the Financials tab (Kyle, 2026-09-20): "I can manually upload the bank
 * statements each month from each account. Plaid can be used at a later date when its
 * established." And: "Having everything tracked in one place would make it easier."
 *
 * Three cards, all money, all on Financials (money-only since build #5 — a statement is cash
 * on hand and what left it; Purchasing owns buying, not paying):
 *
 *   CashPanel           — every registered account's balance AS OF the statement it came from,
 *                         beside the Stripe balances. Honest staleness over a fake live number.
 *   BankQueueCard       — THE PRODUCT: the lines the importer could not classify, each with the
 *                         question written out and the candidates it saw; Kyle rules on each.
 *                         Below it, what was classified this year, every ruling changeable.
 *   BankStatementsCard  — the registry (Chase has four: checking, capital, overhead savings,
 *                         tax), the upload per account, and every imported statement with its
 *                         delete — the undo of a wrong import.
 *
 * Every line is exactly one of: expense (new money out — the only one that reaches the P&L),
 * transfer (a set-aside, or anything to/from Stripe), already counted (payroll, a P.O.'s typed
 * amount, a scheduled bill, a recorded payment), ignored (with a reason), or unclassified.
 *
 * Kyle's standing rule: every account, statement, line and classification here can be edited
 * or deleted from this surface.
 */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  BANK_EXPENSE_CATEGORIES,
  type BankAccountPurpose,
  type BankAccountView,
  type BankClassifyInput,
  type BankConfirmations,
  type BankCountedKind,
  type BankLineClassification,
  type BankLineView,
  type BankTransferKind,
} from "../lib/types";
import type { CompanyBillRow } from "../lib/api";
import { money, shortDate } from "../lib/utils";
import { CollapsibleCard } from "./CollapsibleCard";

const PURPOSE_LABEL: Record<BankAccountPurpose, string> = {
  operating: "checking — operating",
  capital: "capital savings",
  overhead_savings: "overhead savings",
  tax: "tax savings",
};

const CLASSIFICATION_LABEL: Record<BankLineClassification, string> = {
  unclassified: "not classified",
  expense: "expense",
  transfer: "transfer",
  already_counted: "already counted",
  ignored: "ignored",
};

const TRANSFER_LABEL: Record<BankTransferKind, string> = {
  set_aside: "set-aside into savings",
  set_aside_return: "back out of savings",
  stripe: "to / from Stripe",
  own_accounts: "between our accounts",
};

const COUNTED_LABEL: Record<BankCountedKind, string> = {
  payroll: "payroll (hours ledger)",
  company_bill: "a company bill",
  po_off_card: "a P.O.'s typed amount",
  payment: "a recorded customer payment",
};

const CLASS_TONE: Record<BankLineClassification, string> = {
  unclassified: "bg-amber-100 text-amber-900",
  expense: "bg-red-100 text-red-900",
  transfer: "bg-sky-100 text-sky-900",
  already_counted: "bg-emerald-100 text-emerald-900",
  ignored: "bg-gray-100 text-gray-700",
};

/** "YYYY-MM" of a line's posted date, for a bill match. */
const monthOf = (iso: string) => iso.slice(0, 7);

/** Every query a bank change can move — the cards, the P&L, the bills' confirmation chips. */
function useBankRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [["bank-accounts"], ["bank-statements"], ["bank-lines"], ["bank-confirmations"], ["financials"]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

/** What a line means, in one line — the rule's reason or Kyle's note, and what it points at. */
function lineMeaning(l: BankLineView): string {
  if (l.classification === "expense") return `expense — ${l.category?.replace("_", " ") ?? "other"}`;
  if (l.classification === "transfer") return `transfer — ${l.transferKind ? TRANSFER_LABEL[l.transferKind] : ""}${l.counterpartyName ? ` (${l.counterpartyName})` : ""}`;
  if (l.classification === "already_counted") {
    return `already counted — ${l.matchedKind ? COUNTED_LABEL[l.matchedKind] : ""}${l.matchedLabel ? `: ${l.matchedLabel}` : ""}${l.matchedMonth ? ` for ${l.matchedMonth}` : ""}`;
  }
  if (l.classification === "ignored") return "ignored";
  return "not classified";
}

// ─── The cash panel ──────────────────────────────────────────────────────────

/** Every registered account, its balance labelled AS OF the statement it came from. Renders nothing until the registry loads. */
export function CashPanel() {
  const { data } = useQuery({ queryKey: ["bank-accounts"], queryFn: api.bankAccounts });
  if (!data) return null;
  const active = data.filter((a) => a.isActive);
  if (active.length === 0) {
    return (
      <p className="mt-2 text-xs text-rce-muted">
        No bank accounts registered yet — add Chase's four (checking, capital, overhead savings, tax) in the Bank statements card below, then import a statement for each.
      </p>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-cash-panel>
      {active.map((a) => (
        <div key={a.id} className="min-w-[10rem] rounded-lg border border-rce-border px-3 py-1.5 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium">{a.name}</span>
            {a.last4 && <span className="text-xs text-rce-muted">…{a.last4}</span>}
          </div>
          <div className="text-[11px] text-rce-muted">{PURPOSE_LABEL[a.purpose]}</div>
          {a.balance ? (
            <>
              <div className="text-lg font-semibold tabular-nums">{money(a.balance.amount)}</div>
              <div className="text-[11px] text-rce-muted">as of {shortDate(a.balance.asOf)} — from the statement, not live</div>
            </>
          ) : (
            <div className="text-xs text-amber-800">No statement imported yet</div>
          )}
          {a.unclassified > 0 && <div className="text-[11px] text-amber-800">{a.unclassified} line{a.unclassified === 1 ? "" : "s"} to classify</div>}
        </div>
      ))}
    </div>
  );
}

// ─── The queue ───────────────────────────────────────────────────────────────

/**
 * The lines the importer could not classify (every year — a queue is not year-scoped), then
 * this year's classified lines with a "change" on each. The rules re-run on a click; a line
 * Kyle has ruled on is never touched by them.
 */
export function BankQueueCard({ year }: { year: number }) {
  const refresh = useBankRefresh();
  const { data: queue = [] } = useQuery({ queryKey: ["bank-lines", "unclassified"], queryFn: () => api.bankLines({ classification: "unclassified" }) });
  const { data: yearLines = [] } = useQuery({ queryKey: ["bank-lines", "year", year], queryFn: () => api.bankLines({ year }) });
  const { data: accounts = [] } = useQuery({ queryKey: ["bank-accounts"], queryFn: api.bankAccounts });
  const { data: bills = [] } = useQuery({ queryKey: ["companyBills"], queryFn: () => api.companyBills() });
  const [shown, setShown] = useState(10);
  const [editing, setEditing] = useState<string | null>(null);
  const [rerun, setRerun] = useState<string | null>(null);

  const classified = useMemo(() => yearLines.filter((l) => l.classification !== "unclassified"), [yearLines]);
  const out = queue.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0);

  const auto = useMutation({
    mutationFn: api.autoClassifyBankLines,
    onSuccess: (r) => { setRerun(`${r.classified} classified by the rules, ${r.unclassified} still yours.`); refresh(); },
    onError: (e: Error) => setRerun(e.message),
  });

  return (
    <CollapsibleCard
      id="bank-queue"
      title="Bank lines to classify"
      defaultOpen={queue.length > 0}
      summary={queue.length > 0 ? `${queue.length} to classify · ${money(out)} out not yet on the P&L` : `nothing waiting · ${classified.length} classified in ${year}`}
      className={queue.length > 0 ? "border-amber-300" : ""}
    >
      <p className="mb-2 text-xs text-rce-muted">
        Every statement line is one of: an <b>expense</b> (new money out — the only kind that lands in Expenses), a <b>transfer</b> (a
        set-aside into savings, or anything to or from Stripe), <b>already counted</b> (payroll, a P.O.'s typed amount, a scheduled
        bill, a customer payment you recorded), or <b>ignored</b> with a reason. The rules decide what they can and say why; what
        they cannot decide is listed here with the question. A payment out of the tax account is always your call.
        A line you rule on teaches the rules — the same payee next month follows your ruling.
      </p>
      {queue.length === 0 ? (
        <p className="text-sm text-rce-muted">Nothing to classify.</p>
      ) : (
        <ul className="space-y-1">
          {queue.map((l) => (
            <li key={l.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
              <LineHeader line={l} />
              {l.hint && <p className="mt-0.5 text-xs text-amber-900">{l.hint}</p>}
              <ClassifyForm line={l} accounts={accounts} bills={bills} onDone={() => refresh()} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" disabled={auto.isPending} onClick={() => auto.mutate()}>
          {auto.isPending ? "Running the rules…" : "Run the rules again"}
        </button>
        {rerun && <span className="text-xs text-rce-muted">{rerun}</span>}
      </div>

      <h3 className="mt-4 text-sm font-semibold text-rce-soft">Classified in {year}</h3>
      {classified.length === 0 ? (
        <p className="text-sm text-rce-muted">No classified lines in {year} yet.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {classified.slice(0, shown).map((l) => (
            <li key={l.id} className="rounded-lg border border-rce-border px-3 py-1.5 text-sm">
              <LineHeader line={l} />
              <p className="text-xs text-rce-muted">
                {lineMeaning(l)}
                {l.reason && <span> — {l.reason}</span>}
                {l.classifiedBy === "rule" && <span className="text-rce-soft"> (by rule)</span>}
              </p>
              {editing === l.id ? (
                <ClassifyForm line={l} accounts={accounts} bills={bills} onDone={() => { setEditing(null); refresh(); }} onCancel={() => setEditing(null)} />
              ) : (
                <button type="button" className="btn btn-secondary mt-1 px-2 py-0.5 text-xs min-h-0" onClick={() => setEditing(l.id)}>change</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {classified.length > shown && (
        <button type="button" className="btn btn-secondary mt-1 px-2 py-0.5 text-xs min-h-0" onClick={() => setShown((n) => n + 10)}>
          Show more ({classified.length - shown})
        </button>
      )}
    </CollapsibleCard>
  );
}

function LineHeader({ line: l }: { line: BankLineView }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className="min-w-0 break-words">
        <span className="tabular-nums text-rce-muted">{shortDate(l.postedAt)}</span>{" "}
        <span className="font-medium">{l.description}</span>
        <span className="ml-2 text-xs text-rce-muted">{l.accountName}{l.bankType ? ` · ${l.bankType.toLowerCase().replace(/_/g, " ")}` : ""}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[11px] ${CLASS_TONE[l.classification]}`}>{CLASSIFICATION_LABEL[l.classification]}</span>
        <span className={`font-semibold tabular-nums ${l.amount < 0 ? "" : "text-emerald-700"}`}>{l.amount < 0 ? `− ${money(-l.amount)}` : `+ ${money(l.amount)}`}</span>
      </span>
    </div>
  );
}

/**
 * Kyle's ruling on one line. Starts from what the line already is (a change) or from the rules'
 * best guess at the shape (a fresh ruling). Bills offered: the candidates the rules saw first,
 * then every bill — the month defaults to the line's own.
 */
function ClassifyForm({ line, accounts, bills, onDone, onCancel }: {
  line: BankLineView;
  accounts: BankAccountView[];
  bills: CompanyBillRow[];
  onDone: () => void;
  onCancel?: () => void;
}) {
  const initial: BankLineClassification = line.classification === "unclassified"
    ? (line.amount > 0 ? "already_counted" : "expense")
    : line.classification;
  const [classification, setClassification] = useState<BankLineClassification>(initial);
  const [category, setCategory] = useState(line.category ?? (line.accountPurpose === "tax" ? "tax" : "overhead"));
  const [transferKind, setTransferKind] = useState<BankTransferKind>(line.transferKind ?? "set_aside");
  const [counterparty, setCounterparty] = useState(line.counterpartyAccountId ?? "");
  const [countedKind, setCountedKind] = useState<BankCountedKind>(line.matchedKind ?? (line.amount > 0 ? "payment" : "company_bill"));
  const [matchedId, setMatchedId] = useState(line.matchedId ?? "");
  const [matchedMonth, setMatchedMonth] = useState(line.matchedMonth ?? monthOf(line.postedAt));
  const [note, setNote] = useState(line.classifiedBy === "owner" ? line.reason ?? "" : "");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const candidates = line.candidates;
  const otherAccounts = accounts.filter((a) => a.id !== line.accountId && a.isActive);

  const save = useMutation({
    mutationFn: () => {
      const input: BankClassifyInput = { classification, note: note.trim() || null };
      if (classification === "expense") input.category = category;
      if (classification === "transfer") { input.transferKind = transferKind; input.counterpartyAccountId = counterparty || null; }
      if (classification === "already_counted") {
        input.matchedKind = countedKind;
        if (countedKind !== "payroll") input.matchedId = matchedId || null;
        if (countedKind === "company_bill") input.matchedMonth = matchedMonth;
      }
      return api.classifyBankLine(line.id, input);
    },
    onSuccess: () => { setError(null); onDone(); },
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteBankLine(line.id, note.trim() || undefined),
    onSuccess: () => onDone(),
    onError: (e: Error) => setError(e.message),
  });

  const ready = classification === "unclassified"
    || (classification === "expense" && !!category)
    || (classification === "transfer" && !!transferKind)
    || (classification === "already_counted" && (countedKind === "payroll" || !!matchedId))
    || (classification === "ignored" && note.trim().length > 0);

  const sel = "field px-1 py-0.5 text-xs";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-classify-form>
      <label className="text-xs">
        <span className="sr-only">Classification</span>
        <select className={sel} aria-label="Classification" value={classification} onChange={(e) => setClassification(e.target.value as BankLineClassification)}>
          <option value="expense">expense (new money out)</option>
          <option value="transfer">transfer (our own money)</option>
          <option value="already_counted">already counted</option>
          <option value="ignored">ignore (not the business's)</option>
          <option value="unclassified">not classified</option>
        </select>
      </label>

      {classification === "expense" && (
        <select className={sel} aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          {BANK_EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
        </select>
      )}

      {classification === "transfer" && (
        <>
          <select className={sel} aria-label="Transfer kind" value={transferKind} onChange={(e) => setTransferKind(e.target.value as BankTransferKind)}>
            {(Object.keys(TRANSFER_LABEL) as BankTransferKind[]).map((k) => <option key={k} value={k}>{TRANSFER_LABEL[k]}</option>)}
          </select>
          {transferKind !== "stripe" && (
            <select className={sel} aria-label="Other account" value={counterparty} onChange={(e) => setCounterparty(e.target.value)}>
              <option value="">other account (optional)</option>
              {otherAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` …${a.last4}` : ""}</option>)}
            </select>
          )}
        </>
      )}

      {classification === "already_counted" && (
        <>
          <select className={sel} aria-label="Counted as" value={countedKind} onChange={(e) => { setCountedKind(e.target.value as BankCountedKind); setMatchedId(""); }}>
            {(Object.keys(COUNTED_LABEL) as BankCountedKind[]).map((k) => <option key={k} value={k}>{COUNTED_LABEL[k]}</option>)}
          </select>
          {countedKind === "company_bill" && (
            <>
              <select className={sel} aria-label="Bill" value={matchedId} onChange={(e) => setMatchedId(e.target.value)}>
                <option value="">which bill?</option>
                {(candidates?.bills ?? []).map((b) => <option key={`c-${b.id}`} value={b.id}>{b.name} — {money(b.amount)} (fits {b.month})</option>)}
                {bills.filter((b) => !(candidates?.bills ?? []).some((c) => c.id === b.id)).map((b) => <option key={b.id} value={b.id}>{b.name} — {money(b.amount)}</option>)}
              </select>
              <input className={`${sel} w-24`} aria-label="Bill month" type="month" value={matchedMonth} onChange={(e) => setMatchedMonth(e.target.value)} />
            </>
          )}
          {countedKind === "po_off_card" && (
            <select className={sel} aria-label="Purchase order" value={matchedId} onChange={(e) => setMatchedId(e.target.value)}>
              <option value="">which P.O.?</option>
              {(candidates?.purchaseOrders ?? []).map((p) => <option key={p.id} value={p.id}>{p.number} — {p.supplier}, {money(p.amount)} typed {shortDate(p.date)}</option>)}
              {(candidates?.purchaseOrders ?? []).length === 0 && <option value="" disabled>no P.O. has this amount typed as not-on-card within three weeks — type it on the P.O. first</option>}
            </select>
          )}
          {countedKind === "payment" && (
            <select className={sel} aria-label="Recorded payment" value={matchedId} onChange={(e) => setMatchedId(e.target.value)}>
              <option value="">which payment?</option>
              {(candidates?.payments ?? []).map((p) => <option key={p.id} value={p.id}>{money(p.amount)} {p.method}{p.customerName ? ` from ${p.customerName}` : ""} on {shortDate(p.date)}</option>)}
              {(candidates?.payments ?? []).length === 0 && <option value="" disabled>no recorded payment of this amount within three weeks — record it first</option>}
            </select>
          )}
        </>
      )}

      <input
        className={`${sel} w-56 max-w-full`}
        aria-label="Note"
        placeholder={classification === "ignored" ? "Why (required)" : "Note (optional)"}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : "Save"}
      </button>
      {onCancel && <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={onCancel}>cancel</button>}
      {!confirmDelete ? (
        <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" onClick={() => setConfirmDelete(true)}>remove line</button>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs">
          <span className="text-rce-muted">Remove this line? A later overlapping import can bring it back — "ignore" with a reason is the durable exit.</span>
          <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" disabled={remove.isPending} onClick={() => remove.mutate()}>yes, remove</button>
          <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setConfirmDelete(false)}>keep</button>
        </span>
      )}
      {error && <span className="basis-full text-xs text-red-700">{error}</span>}
    </div>
  );
}

// ─── Statements and the registry ─────────────────────────────────────────────

/** The registry, the upload per account, and every imported statement with its delete. */
export function BankStatementsCard() {
  const refresh = useBankRefresh();
  const { data: accountRows, isSuccess: accountsLoaded } = useQuery({ queryKey: ["bank-accounts"], queryFn: api.bankAccounts });
  const accounts = accountRows ?? [];
  const { data: statements = [] } = useQuery({ queryKey: ["bank-statements"], queryFn: () => api.bankStatements() });
  const [message, setMessage] = useState<ReactNode>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const importFile = useMutation({
    mutationFn: ({ accountId, file }: { accountId: string; file: File }) => api.importBankStatement(accountId, file),
    onSuccess: (r) => {
      setMessage(r.duplicate
        ? <>{r.fileName} was already imported — nothing changed.</>
        : <>{r.fileName}: {r.imported} new line{r.imported === 1 ? "" : "s"}{r.skipped > 0 ? `, ${r.skipped} already held` : ""}, {r.autoClassified} classified by the rules, <b>{r.unclassified} to classify</b>.</>);
      refresh();
    },
    onError: (e: Error) => setMessage(<span className="text-red-700">{e.message}</span>),
  });
  const removeStatement = useMutation({
    mutationFn: (id: string) => api.deleteBankStatement(id),
    onSuccess: () => { setMessage("Statement removed — its lines and everything they confirmed are gone."); refresh(); },
    onError: (e: Error) => setMessage(<span className="text-red-700">{e.message}</span>),
  });
  const removeAccount = useMutation({
    mutationFn: (id: string) => api.deleteBankAccount(id),
    onSuccess: () => { setMessage("Account removed."); refresh(); },
    onError: (e: Error) => setMessage(<span className="text-red-700">{e.message}</span>),
  });

  const active = accounts.filter((a) => a.isActive);
  const summary = accounts.length === 0
    ? "no accounts yet"
    : `${active.length} account${active.length === 1 ? "" : "s"} · ${statements.length} statement${statements.length === 1 ? "" : "s"} imported`;

  return (
    // Opens on its own only once the registry has loaded EMPTY — the first thing to do is add the accounts.
    <CollapsibleCard id="bank-statements" title="Bank statements" summary={summary} defaultOpen={accountsLoaded && accounts.length === 0}>
      <p className="mb-2 text-xs text-rce-muted">
        Once a month, export each Chase account's activity (CSV, or OFX/QFX) and import it here. The same file twice imports
        nothing; an export that overlaps one you already imported adds only its new lines. Each account's balance on the
        Balances card is the running balance after its newest statement. A wrong import is undone by removing the statement.
        Plaid can replace the upload later without changing anything else.
      </p>

      <h3 className="text-sm font-semibold text-rce-soft">Accounts</h3>
      {accounts.length === 0 && <p className="text-sm text-rce-muted">Add the four Chase accounts — the purpose decides how transfers between them are read.</p>}
      <ul className="mt-1 space-y-1">
        {accounts.map((a) => (
          <li key={a.id} className="rounded-lg border border-rce-border px-3 py-2 text-sm">
            {editingId === a.id ? (
              <AccountForm account={a} onDone={() => { setEditingId(null); refresh(); }} onCancel={() => setEditingId(null)} />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{a.name}</span>
                  {a.last4 && <span className="ml-1 text-xs text-rce-muted">…{a.last4}</span>}
                  <span className="ml-2 text-xs text-rce-muted">{a.institution} · {PURPOSE_LABEL[a.purpose]}{!a.isActive ? " · inactive" : ""}</span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <label className="btn btn-primary cursor-pointer px-2 py-0.5 text-xs">
                    {importFile.isPending && importFile.variables?.accountId === a.id ? "Importing…" : "Import statement"}
                    <input
                      type="file"
                      accept=".csv,.ofx,.qfx,text/csv"
                      className="sr-only"
                      aria-label={`Import statement for ${a.name}`}
                      disabled={importFile.isPending}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) importFile.mutate({ accountId: a.id, file });
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setEditingId(a.id)}>edit</button>
                  <button
                    type="button"
                    className="btn btn-danger px-2 py-0.5 text-xs min-h-0"
                    disabled={removeAccount.isPending}
                    title={a.statementCount > 0 ? "Remove its statements first" : undefined}
                    onClick={() => removeAccount.mutate(a.id)}
                  >
                    remove
                  </button>
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <AccountForm onDone={() => { setAdding(false); refresh(); }} onCancel={() => setAdding(false)} />
      ) : (
        <button type="button" className="btn btn-secondary mt-2 px-2 py-0.5 text-xs min-h-0" onClick={() => setAdding(true)}>Add account</button>
      )}
      {message && <p className="mt-2 text-xs text-rce-muted">{message}</p>}

      <h3 className="mt-4 text-sm font-semibold text-rce-soft">Imported statements</h3>
      {statements.length === 0 ? (
        <p className="text-sm text-rce-muted">No statements imported yet.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {statements.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rce-border px-3 py-1.5 text-sm">
              <span className="min-w-0 break-words">
                <span className="font-medium">{s.accountName}</span>
                <span className="ml-2 text-xs text-rce-muted">
                  {s.periodStart && s.periodEnd ? `${shortDate(s.periodStart)} – ${shortDate(s.periodEnd)}` : "no period"} · {s.fileName} · {s.lineCount} line{s.lineCount === 1 ? "" : "s"}
                  {s.unclassified > 0 && <span className="text-amber-800"> · {s.unclassified} to classify</span>}
                  {s.closingBalance !== null && <> · balance {money(s.closingBalance)}{s.balanceAsOf ? ` as of ${shortDate(s.balanceAsOf)}` : ""}</>}
                  {" · imported "}{shortDate(s.importedAt)}
                </span>
              </span>
              <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" disabled={removeStatement.isPending} onClick={() => removeStatement.mutate(s.id)}>
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleCard>
  );
}

function AccountForm({ account, onDone, onCancel }: { account?: BankAccountView; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(account?.name ?? "");
  const [institution, setInstitution] = useState(account?.institution ?? "Chase");
  const [last4, setLast4] = useState(account?.last4 ?? "");
  const [kind, setKind] = useState<BankAccountView["kind"]>(account?.kind ?? "checking");
  const [purpose, setPurpose] = useState<BankAccountPurpose>(account?.purpose ?? "operating");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), institution: institution.trim() || "Chase", last4: last4.trim() || null, kind, purpose };
      return account ? api.updateBankAccount(account.id, input) : api.createBankAccount(input);
    },
    onSuccess: () => onDone(),
    onError: (e: Error) => setError(e.message),
  });
  const last4Ok = last4.trim() === "" || /^\d{4}$/.test(last4.trim());
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-account-form>
      <input className="field w-44 px-1 py-0.5 text-xs" aria-label="Account name" placeholder="Account name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="field w-24 px-1 py-0.5 text-xs" aria-label="Bank" placeholder="Bank" value={institution} onChange={(e) => setInstitution(e.target.value)} />
      <input className="field w-20 px-1 py-0.5 text-xs" aria-label="Last four" placeholder="last 4" inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value)} />
      <select className="field px-1 py-0.5 text-xs" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as BankAccountView["kind"])}>
        <option value="checking">checking</option>
        <option value="savings">savings</option>
      </select>
      <select className="field px-1 py-0.5 text-xs" aria-label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as BankAccountPurpose)}>
        {(Object.keys(PURPOSE_LABEL) as BankAccountPurpose[]).map((p) => <option key={p} value={p}>{PURPOSE_LABEL[p]}</option>)}
      </select>
      <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!name.trim() || !last4Ok || save.isPending} onClick={() => save.mutate()}>
        {account ? "Save" : "Add"}
      </button>
      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={onCancel}>cancel</button>
      {!last4Ok && <span className="basis-full text-xs text-red-700">Last four must be four digits.</span>}
      {error && <span className="basis-full text-xs text-red-700">{error}</span>}
    </div>
  );
}

// ─── Bill confirmation (for the Bills card) ──────────────────────────────────

/** What the statements say about one bill this year: confirmed through when, and which covered months never showed it. */
export function BillConfirmationNote({ billId, confirmations }: { billId: string; confirmations: BankConfirmations | undefined }) {
  if (!confirmations) return null;
  const rows = confirmations.bills.filter((b) => b.billId === billId);
  if (rows.length === 0) return null;
  // A month a CARD charge paid is off the P&L as a bill — the charge is the expense (Kyle,
  // 2026-09-21). Said here so the Bills card explains why that month's amount is not in Expenses.
  const onCard = rows.filter((r) => r.card);
  const confirmed = rows.filter((r) => r.status === "confirmed" && !r.card);
  const missing = rows.filter((r) => r.status === "unconfirmed");
  const variance = confirmed.filter((r) => r.line && Math.abs(r.line.variance) > 0.009);
  if (confirmed.length === 0 && missing.length === 0 && onCard.length === 0) return <span className="text-[11px] text-rce-muted">no statement covers it yet</span>;
  return (
    <span className="text-[11px]">
      {onCard.length > 0 && <span className="text-emerald-700">paid on the card {onCard.map((r) => r.month.slice(5)).join(", ")} — the charge is the expense, not this amount</span>}
      {confirmed.length > 0 && <span className="text-emerald-700">{onCard.length > 0 ? " · " : ""}confirmed {confirmed.map((r) => r.month.slice(5)).join(", ")}</span>}
      {variance.length > 0 && <span className="text-amber-800"> · bank paid {variance.map((r) => `${money(-r.line!.amount)} in ${r.month.slice(5)}`).join(", ")} — edit the amount if it stuck</span>}
      {missing.length > 0 && <span className="text-red-700"> · not on the statement: {missing.map((r) => r.month.slice(5)).join(", ")} — stopped paying it?</span>}
    </span>
  );
}
