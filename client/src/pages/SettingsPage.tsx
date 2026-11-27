import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { CollapsibleCard } from "../components/CollapsibleCard";
import { UnsavedNote } from "../components/UnsavedNote";
import { sameFields, sameNumberText, useSeededForm } from "../lib/useSeededForm";
import { api } from "../lib/api";
import type { TaxRepriceOutcome } from "../lib/api";
import { PowerLockNote } from "../components/PowerLockNote";
import { useCan } from "../lib/session";
import type { CompanyProfile, LegalInfo, OperatingHours, PayrollSettings, PurchasingSettings, Territory } from "../lib/api";
import type { TreasurySettings } from "../lib/types";
import { FinancingPlansSection } from "./FinancingPlansSection";
import { BilledRateSection } from "./BilledRateSection";
import { AdminLoginSection } from "./AdminLoginSection";
import { AgentKeysSection } from "./AgentKeysSection";
import { AgentEventsSection } from "./AgentEventsSection";
import { AgentWebhooksSection } from "./AgentWebhooksSection";
import { MessageRemindersSection } from "./MessageRemindersSection";
import { MessageAuditLogSection } from "./MessageAuditLogSection";

const EMPTY_PROFILE: CompanyProfile = {
  companyName: "Red Cedar Electric LLC",
  address: "",
  phone: "",
  email: "",
  licenseNumber: "",
  licenseState: "",
  licenseExpiration: "",
  insuranceCarrier: "",
  insurancePolicyNumber: "",
  insuranceExpiration: "",
  financingUrl: "",
};

const EMPTY_HOURS: OperatingHours = {
  weekdays: "8:00 AM – 5:00 PM",
  saturday: "Closed",
  sunday: "Closed",
  afterHoursPolicy: "",
};

const EMPTY_LEGAL: LegalInfo = {
  warrantyText: "",
  policiesText: "",
  insuranceNotes: "",
};

/** Kyle, 2026-09-23: "Get the direct cost and apply TN tax rate." 9.75% = TN state 7% +
 * the full 2.75% local option — the default until Settings says otherwise. Stored as the
 * DECIMAL FRACTION 0.0975; this field shows and edits it as a percent. */
const DEFAULT_SALES_TAX_RATE = 0.0975;
const EMPTY_PURCHASING: PurchasingSettings = { salesTaxRate: DEFAULT_SALES_TAX_RATE };

/**
 * Treasury (Kyle, 2026-09-09): "At the end of each month I will take whatever
 * money is over that value and deposit it into the Chase savings accounts for
 * taxes and owner distributions." The floats are set HERE when the accounts are
 * opened; the sweep itself is a click on Financials, never a schedule. Numbers
 * are kept as strings while typing and validated (≥ 0) on save.
 */
type TreasuryForm = {
  mainFinancialAccountId: string;
  mainFloat: string;
  truckFloats: Record<string, string>;
  chaseAccountLabel: string;
  chaseExternalAccountId: string;
};
const EMPTY_TREASURY: TreasuryForm = { mainFinancialAccountId: "", mainFloat: "0", truckFloats: {}, chaseAccountLabel: "", chaseExternalAccountId: "" };

/** Two treasury forms hold the same values: floats compare as numbers (a blank float is 0, as on save), text is trimmed (as on save). */
function sameTreasury(a: TreasuryForm, b: TreasuryForm): boolean {
  const float = (s: string) => (s.trim() === "" ? "0" : s);
  if (a.mainFinancialAccountId.trim() !== b.mainFinancialAccountId.trim()) return false;
  if (a.chaseAccountLabel.trim() !== b.chaseAccountLabel.trim()) return false;
  if (a.chaseExternalAccountId.trim() !== b.chaseExternalAccountId.trim()) return false;
  if (!sameNumberText(float(a.mainFloat), float(b.mainFloat))) return false;
  for (const id of new Set([...Object.keys(a.truckFloats), ...Object.keys(b.truckFloats)])) {
    if (!sameNumberText(float(a.truckFloats[id] ?? "0"), float(b.truckFloats[id] ?? "0"))) return false;
  }
  return true;
}

/** Exported for its test (the Kyle-only Save). */
export function TreasurySection() {
  const queryClient = useQueryClient();
  // Saving the floats and the Chase destination is Kyle-only (treasury): Save is greyed WITH the
  // reason for a session without the power.
  const { allowed: canTreasury, reason: treasuryReason } = useCan("treasury");
  const { data: treasury } = useQuery({ queryKey: ["treasury-settings"], queryFn: api.treasurySettings });
  const { data: balances } = useQuery({ queryKey: ["financials-balances"], queryFn: api.financialsBalances });
  const { data: trucksData } = useQuery({ queryKey: ["trucks"], queryFn: api.trucks });
  // The form follows the saved floats until the person types; typed, unsaved floats are never overwritten by a refetch, and the folded
  // row says "Unsaved changes" (Kyle, 2026-11-26).
  const treasurySeed: TreasuryForm = treasury
    ? {
      mainFinancialAccountId: treasury.mainFinancialAccountId ?? "",
      mainFloat: String(treasury.mainFloat ?? 0),
      truckFloats: Object.fromEntries(Object.entries(treasury.truckFloats ?? {}).map(([k, v]) => [k, String(v)])),
      chaseAccountLabel: treasury.chaseAccountLabel ?? "",
      chaseExternalAccountId: treasury.chaseExternalAccountId ?? "",
    }
    : EMPTY_TREASURY;
  const [form, setForm, treasuryDirty] = useSeededForm(treasurySeed, sameTreasury);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (value: TreasurySettings) => api.saveTreasurySettings(value),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 2500);
      void queryClient.invalidateQueries({ queryKey: ["treasury-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["financials-sweep"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const trucks = (trucksData?.trucks ?? []).filter((t) => t.isActive);
  const accounts = balances?.available ? balances.financialAccounts : [];
  const chosenMissing = form.mainFinancialAccountId && !accounts.some((a) => a.id === form.mainFinancialAccountId);

  // The folded row: what is set, or why it cannot be changed (greyed with a reason, never hidden).
  const treasuryState = treasury && (treasury.mainFinancialAccountId || treasury.chaseExternalAccountId)
    ? `Main float ${money(treasury.mainFloat ?? 0)}`
    : "Not set up yet";
  const treasurySummary = (
    <>
      {!canTreasury && treasuryReason ? `${treasuryState} — ${treasuryReason}` : treasuryState}
      <UnsavedNote show={treasuryDirty} />
    </>
  );

  const onSave = () => {
    const num = (s: string) => (s.trim() === "" ? 0 : Number(s));
    const mainFloat = num(form.mainFloat);
    const truckFloats: Record<string, number> = {};
    for (const [id, s] of Object.entries(form.truckFloats)) truckFloats[id] = num(s);
    const bad = [mainFloat, ...Object.values(truckFloats)].some((n) => !Number.isFinite(n) || n < 0);
    if (bad) { setError("Every float must be a number, zero or more."); return; }
    save.mutate({
      mainFinancialAccountId: form.mainFinancialAccountId.trim() || null,
      mainFloat,
      truckFloats,
      chaseAccountLabel: form.chaseAccountLabel.trim() || null,
      chaseExternalAccountId: form.chaseExternalAccountId.trim() || null,
    });
  };

  return (
    <SectionCard
      id="settings-treasury"
      title="Treasury"
      attention={treasuryDirty}
      // Kyle, 2026-09-09: the sweep itself is a click on Financials, never a schedule; the floats are set here.
      subtitle="The working balances kept in the main account and each truck, and the Chase account the month-end sweep goes to; nothing here runs on its own."
      summary={treasurySummary}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm font-medium">
          Main financial account
          {accounts.length > 0 ? (
            <select className="field mt-1 w-full" value={form.mainFinancialAccountId} onChange={(e) => setForm((f) => ({ ...f, mainFinancialAccountId: e.target.value }))}>
              <option value="">— choose —</option>
              {chosenMissing && <option value={form.mainFinancialAccountId}>{form.mainFinancialAccountId} (not returned by Stripe)</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.id}{a.truckName ? ` — ${a.truckName}'s truck account` : ""}</option>
              ))}
            </select>
          ) : (
            <input className="field mt-1 w-full" value={form.mainFinancialAccountId} placeholder="fa_…" onChange={(e) => setForm((f) => ({ ...f, mainFinancialAccountId: e.target.value }))} />
          )}
          {balances && !balances.available && (
            <span className="mt-1 block text-xs font-normal text-amber-800">Stripe's financial accounts are not readable yet ({balances.reason}) — paste the id for now.</span>
          )}
        </label>
        <Field label="Main float (kept in the account, $)" value={form.mainFloat} type="number" onChange={(v) => setForm((f) => ({ ...f, mainFloat: v }))} />
        <Field label="Chase account label" value={form.chaseAccountLabel} placeholder="Chase savings — taxes & distributions" onChange={(v) => setForm((f) => ({ ...f, chaseAccountLabel: v }))} />
        <Field label="Chase destination id (Stripe payout method)" value={form.chaseExternalAccountId} placeholder="the outbound-payment destination id from Stripe" onChange={(v) => setForm((f) => ({ ...f, chaseExternalAccountId: v }))} />
      </div>
      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-rce-muted">Truck floats</p>
      {trucks.length === 0 ? (
        <p className="mt-1 text-sm text-rce-muted">No trucks yet.</p>
      ) : (
        <div className="mt-1 grid gap-3 md:grid-cols-3">
          {trucks.map((t) => (
            <Field
              key={t.id}
              label={`${t.name} float ($)`}
              type="number"
              value={form.truckFloats[t.id] ?? "0"}
              onChange={(v) => setForm((f) => ({ ...f, truckFloats: { ...f.truckFloats, [t.id]: v } }))}
            />
          ))}
        </div>
      )}
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}
      <PowerLockNote power="treasury" className="mt-3" />
      <button
        className="btn btn-primary mt-4"
        type="button"
        disabled={save.isPending || !canTreasury}
        title={treasuryReason ?? undefined}
        onClick={onSave}
      >
        {saved ? "Saved ✓" : "Save treasury"}
      </button>
    </SectionCard>
  );
}

/**
 * One Settings card (Kyle, 2026-11-26: "All cards should have be collapsable in the settings"; "All folded"; "Yes, one line each").
 * It is the shared CollapsibleCard: folded it is the title plus a one-line `summary`, open it shows the one-sentence
 * `subtitle` and the controls. The caller keeps its hooks and typed edits ABOVE this card, so folding never loses them.
 * `id` is the stored open/closed key (rce.card.<id>); `attention` opens the card by itself while a warning is live.
 */
function SectionCard({ id, title, subtitle, summary, attention, children }: {
  id: string;
  title: string;
  subtitle?: string;
  summary?: React.ReactNode;
  attention?: boolean;
  children: React.ReactNode;
}) {
  return (
    <CollapsibleCard id={id} title={title} subtitle={subtitle} summary={summary} attention={attention}>
      {children}
    </CollapsibleCard>
  );
}

function Field({ label, value, onChange, placeholder, type = "text", disabled, title }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  /** Greyed, with the reason as a tooltip (CLAUDE.md: greyed with a reason, never hidden). */
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className="text-sm font-medium">
      {label}
      <input
        className="field mt-1 w-full"
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const pctText = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100_000) / 1000}%`);

/** What saving the sales tax rate did to the price book: how many items repriced and which hand-priced ones were left alone. */
function TaxRepriceResult({ outcome }: { outcome: TaxRepriceOutcome }) {
  if (outcome.status === "failed") {
    return <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{outcome.reason}</p>;
  }
  if (outcome.status === "skipped_no_saved_rate") {
    return <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">No usable sales tax rate is saved, so the price book was not repriced.</p>;
  }
  if (outcome.status === "current") {
    return (
      <p className="mt-3 rounded-md border border-rce-border bg-rce-accentBg/30 px-3 py-2 text-xs" data-testid="tax-reprice-result">
        The price book is already priced at {pctText(outcome.newRate)}. Nothing changed.
      </p>
    );
  }
  const shown = outcome.handPriced.slice(0, 10);
  return (
    <div className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900" data-testid="tax-reprice-result">
      <p>
        Price book repriced at {pctText(outcome.newRate)} (was {pctText(outcome.previousRate)}): {outcome.itemsRepriced} item{outcome.itemsRepriced === 1 ? "" : "s"} repriced
        {outcome.assembliesRepriced > 0 ? ` (${outcome.assembliesRepriced} of them assemblies)` : ""}, {outcome.handPricedCount} hand-priced item{outcome.handPricedCount === 1 ? "" : "s"} left alone.
        {outcome.openDrafts > 0 ? ` ${outcome.openDrafts} open draft estimate${outcome.openDrafts === 1 ? "" : "s"} now read the new prices.` : ""}
      </p>
      {shown.length > 0 ? (
        <ul className="mt-2 list-disc pl-5">
          {shown.map((h) => (
            <li key={h.itemId}><span className="font-mono">{h.itemId}</span> {h.description ?? ""} — {h.why}</li>
          ))}
          {outcome.handPricedCount > shown.length ? <li>…and {outcome.handPricedCount - shown.length} more (listed in the system log).</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

const NO_TERRITORIES: Territory[] = [];
const sameTerritories = (a: Territory[], b: Territory[]): boolean => a.length === b.length && a.every((t, i) => sameFields(t, b[i]));

/** Exported for its test: Settings -> Purchasing "Sales tax rate (%)". Saving a different rate reprices the price book (Kyle, 2026-11-25: "Automatically on deploy"). */
export function PurchasingSection() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["companySettings"], queryFn: api.companySettings });
  const [purchasing, setPurchasing] = useState<PurchasingSettings>(EMPTY_PURCHASING);
  // Edited as a percent string ("9.75"); converted to the stored decimal fraction (0.0975)
  // only on save (Kyle, 2026-09-23: "Store the DECIMAL FRACTION, display a percent.").
  // The box follows the saved rate until the person types; a typed, unsaved rate survives another card's save (Kyle, 2026-11-26).
  const [taxRatePercent, setTaxRatePercent, taxDirty] = useSeededForm(
    String(Math.round((settings?.purchasing?.salesTaxRate ?? DEFAULT_SALES_TAX_RATE) * 100_000) / 1000),
    sameNumberText,
  );
  const [purchasingError, setPurchasingError] = useState<string | null>(null);
  // What the save did to the price book (server: priceBookTaxReprice.ts).
  const [repriceOutcome, setRepriceOutcome] = useState<TaxRepriceOutcome | null>(null);
  const [saved, setSaved] = useState(false);
  // Repricing the book is a Kyle-only price edit (price_book_edit), exactly like the Billed labor rate: the box and Save are greyed WITH the reason.
  const { allowed: canPrice, reason: priceReason } = useCan("price_book_edit");

  useEffect(() => {
    if (!settings?.purchasing) return;
    setPurchasing({ ...EMPTY_PURCHASING, ...settings.purchasing });
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (value: PurchasingSettings) => api.saveCompanySetting("purchasing", value),
    onSuccess: (data) => {
      setRepriceOutcome(data.reprice ?? null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      void queryClient.invalidateQueries({ queryKey: ["companySettings"] });
      void queryClient.invalidateQueries({ queryKey: ["pbCatalogItems"] });
    },
    onError: (e: Error) => setPurchasingError(e.message),
  });

  const saveTaxRate = () => {
    const percent = Number(taxRatePercent);
    if (!Number.isFinite(percent) || percent < 0 || percent >= 100) {
      setPurchasingError("Enter a percent, 0 or more and under 100 (e.g. 9.75).");
      return;
    }
    setPurchasingError(null);
    setRepriceOutcome(null);
    const salesTaxRate = Number((percent / 100).toPrecision(12)); // 9.75 -> 0.0975, without float dust
    setPurchasing({ ...purchasing, salesTaxRate });
    saveMutation.mutate({ ...purchasing, salesTaxRate });
  };

  return (
      <SectionCard
        id="settings-purchasing"
        title="Purchasing"
        attention={taxDirty}
        // The rulings behind this line stay here, not on screen. Kyle, 2026-11-24: "Tax in sell, all items" (sell = hours × shop rate
        // + (cost × (1 + this rate)) × markup). Saving a different rate re-prices the price book at once: no preview, no Apply;
        // hand-priced items are left alone and listed; sent or signed estimates keep their prices, open drafts follow. A purchase order
        // or receipt lands at its pre-tax cost plus this tax (Kyle, 2026-09-23: "Get the direct cost and apply TN tax rate."); nothing
        // already landed is touched.
        subtitle="The sales tax rate that is built into every sell price; saving a different rate re-prices the price book right away."
        summary={<>{`${pctText(settings?.purchasing?.salesTaxRate ?? DEFAULT_SALES_TAX_RATE)} sales tax${!canPrice && priceReason ? ` — ${priceReason}` : ""}`}<UnsavedNote show={taxDirty} /></>}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label="Sales tax rate (%)"
            value={taxRatePercent}
            type="number"
            placeholder="9.75"
            onChange={(v) => setTaxRatePercent(v)}
            disabled={!canPrice}
            title={!canPrice ? priceReason ?? undefined : undefined}
          />
        </div>
        <PowerLockNote power="price_book_edit" className="mt-3" />
        {purchasingError && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{purchasingError}</p>}
        <button
          className="btn btn-primary mt-4"
          type="button"
          disabled={saveMutation.isPending || !canPrice}
          title={!canPrice ? priceReason ?? undefined : undefined}
          onClick={saveTaxRate}
        >
          {saved ? "Saved ✓" : "Save purchasing"}
        </button>
        {repriceOutcome ? <TaxRepriceResult outcome={repriceOutcome} /> : null}
      </SectionCard>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["companySettings"], queryFn: api.companySettings });

  // Each of the five forms follows the saved value until the person types in it. Typed, unsaved text is never overwritten when ANOTHER
  // card is saved (that refetches the company settings), and a folded card says "Unsaved changes" on its row and opens by itself
  // (Kyle, 2026-11-26). See lib/useSeededForm.ts.
  const [profile, setProfile, profileDirty] = useSeededForm<CompanyProfile>({ ...EMPTY_PROFILE, ...settings?.companyProfile }, sameFields);
  const [hours, setHours, hoursDirty] = useSeededForm<OperatingHours>({ ...EMPTY_HOURS, ...settings?.operatingHours }, sameFields);
  const [territories, setTerritories, territoriesDirty] = useSeededForm<Territory[]>(settings?.territories ?? NO_TERRITORIES, sameTerritories);
  const [selectedTerritory, setSelectedTerritory] = useState(0);
  const [legal, setLegal, legalDirty] = useSeededForm<LegalInfo>({ ...EMPTY_LEGAL, ...settings?.legal }, sameFields);
  // Employer cost on top of wages (Kyle, 2026-10-08, decision 10): a PERCENT string while typing
  // ("9.5"), saved as the number 9.5 — never a fraction. Empty clears it to "not set".
  const [employerCostPercent, setEmployerCostPercent, payrollDirty] = useSeededForm<string>(
    settings?.payroll?.employerCostPercent != null ? String(settings.payroll.employerCostPercent) : "",
    sameNumberText,
  );
  const [payrollError, setPayrollError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => api.saveCompanySetting(key, value),
    onSuccess: (_data, vars) => {
      setSavedKey(vars.key);
      setTimeout(() => setSavedKey(null), 2500);
      void queryClient.invalidateQueries({ queryKey: ["companySettings"] });
    },
  });

  const setP = (patch: Partial<CompanyProfile>) => setProfile((p) => ({ ...p, ...patch }));
  const setH = (patch: Partial<OperatingHours>) => setHours((h) => ({ ...h, ...patch }));
  const setL = (patch: Partial<LegalInfo>) => setLegal((l) => ({ ...l, ...patch }));

  const saveEmployerCost = () => {
    const raw = employerCostPercent.trim();
    const value: PayrollSettings = { employerCostPercent: raw === "" ? null : Number(raw) };
    if (value.employerCostPercent != null) {
      const n = value.employerCostPercent;
      if (!Number.isFinite(n) || n < 0 || n > 50) {
        setPayrollError("Enter a percent between 0 and 50 (e.g. 9.5).");
        return;
      }
      if (n > 0 && n < 1) {
        setPayrollError(`This is a percent — type 9.5 for 9.5%, not a fraction like ${n}.`);
        return;
      }
    }
    setPayrollError(null);
    saveMutation.mutate({ key: "payroll", value });
  };

  const updateTerritory = (index: number, patch: Partial<Territory>) =>
    setTerritories((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  // One territory on screen at a time, picked from a dropdown (Kyle, 2026-11-17: "it is taking up to much
  // space on the screen and takes way to long to scroll through to get to the other items in settings").
  const territoryIndex = territories.length ? Math.min(selectedTerritory, territories.length - 1) : -1;
  const territory = territoryIndex >= 0 ? territories[territoryIndex] : null;
  const territoryLabel = (t: Territory) => `${t.zip || "New territory"}${t.area ? ` — ${t.area}` : ""}`;

  const addTerritory = () => {
    setSelectedTerritory(territories.length);
    setTerritories((rows) => [
      ...rows,
      {
        zip: "",
        area: "",
        codeCycle: "",
        utilityProvider: "",
        utilityPhone: "",
        utilityEmail: "",
        utilityNotes: "",
        inspectorName: "",
        inspectorPhone: "",
        inspectorEmail: "",
        inspectorNotes: "",
      },
    ]);
  };

  const removeTerritory = (index: number) => {
    setTerritories((rows) => rows.filter((_, i) => i !== index));
    setSelectedTerritory(Math.max(0, index - 1));
  };

  return (
    <div>
      <PageHeader title="Settings" subtitle="Click a card to open it: company details, pricing and money, AI agents, and messages." />

      <div className="space-y-4">

      <SectionCard
        id="settings-company-profile"
        title="Company profile"
        attention={profileDirty}
        subtitle="Your business name, contact details, license and insurance, used on documents and reports."
        summary={<>{settings?.companyProfile?.licenseNumber ? `License ${settings.companyProfile.licenseNumber}` : "No license number yet"}<UnsavedNote show={profileDirty} /></>}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Company name" value={profile.companyName} onChange={(v) => setP({ companyName: v })} />
          <Field label="Business phone" value={profile.phone} onChange={(v) => setP({ phone: v })} placeholder="615-625-2163" />
          <Field label="Business address" value={profile.address} onChange={(v) => setP({ address: v })} />
          <Field label="Business email" value={profile.email} onChange={(v) => setP({ email: v })} placeholder="service@redcedarelectricllc.com" />
          <Field label="License number" value={profile.licenseNumber} onChange={(v) => setP({ licenseNumber: v })} />
          <Field label="License state" value={profile.licenseState} onChange={(v) => setP({ licenseState: v })} placeholder="TN" />
          <Field label="License expiration" value={profile.licenseExpiration} onChange={(v) => setP({ licenseExpiration: v })} type="date" />
          <Field label="Insurance carrier" value={profile.insuranceCarrier} onChange={(v) => setP({ insuranceCarrier: v })} />
          <Field label="Insurance policy #" value={profile.insurancePolicyNumber} onChange={(v) => setP({ insurancePolicyNumber: v })} />
          <Field label="Insurance expiration" value={profile.insuranceExpiration} onChange={(v) => setP({ insuranceExpiration: v })} type="date" />
          <Field label="Financing link" value={profile.financingUrl} onChange={(v) => setP({ financingUrl: v })} placeholder="https://www.mysynchrony.com/mmc/S6246031300" />
        </div>
        <button
          className="btn btn-primary mt-4"
          type="button"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate({ key: "companyProfile", value: profile })}
        >
          {savedKey === "companyProfile" ? "Saved ✓" : "Save profile"}
        </button>
      </SectionCard>

      <SectionCard
        id="settings-operating-hours"
        title="Operating hours"
        attention={hoursDirty}
        subtitle="The hours customers are shown."
        summary={<>{settings?.operatingHours?.weekdays ? `Weekdays ${settings.operatingHours.weekdays}` : null}<UnsavedNote show={hoursDirty} /></>}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Weekdays" value={hours.weekdays} onChange={(v) => setH({ weekdays: v })} />
          <Field label="Saturday" value={hours.saturday} onChange={(v) => setH({ saturday: v })} />
          <Field label="Sunday" value={hours.sunday} onChange={(v) => setH({ sunday: v })} />
          <Field label="After-hours policy" value={hours.afterHoursPolicy} onChange={(v) => setH({ afterHoursPolicy: v })} placeholder="Emergency calls escalated to on-call" />
        </div>
        <button
          className="btn btn-primary mt-4"
          type="button"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate({ key: "operatingHours", value: hours })}
        >
          {savedKey === "operatingHours" ? "Saved ✓" : "Save hours"}
        </button>
      </SectionCard>

      <SectionCard
        id="settings-service-territories"
        title="Service territories"
        attention={territoriesDirty}
        subtitle="For each ZIP code: the code cycle, the utility contact for power cuts and the inspector contact."
        summary={<>{`${territories.length} territor${territories.length === 1 ? "y" : "ies"}`}<UnsavedNote show={territoriesDirty} /></>}
      >
        {territory ? (
          <>
            <label className="block text-sm font-medium">
              Territory ({territories.length})
              <select
                className="field mt-1 w-full md:w-96"
                value={territoryIndex}
                onChange={(e) => setSelectedTerritory(Number(e.target.value))}
              >
                {territories.map((t, index) => (
                  <option key={index} value={index}>
                    {territoryLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-3 rounded-lg border border-rce-border bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{territoryLabel(territory)}</span>
                <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" onClick={() => removeTerritory(territoryIndex)}>
                  Remove
                </button>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <Field label="ZIP code" value={territory.zip} onChange={(v) => updateTerritory(territoryIndex, { zip: v })} placeholder="37064" />
                <Field label="Area name" value={territory.area} onChange={(v) => updateTerritory(territoryIndex, { area: v })} placeholder="Franklin" />
                <Field label="Code cycle" value={territory.codeCycle} onChange={(v) => updateTerritory(territoryIndex, { codeCycle: v })} placeholder="NEC 2017" />
              </div>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-rce-muted">Utility provider</p>
              <div className="mt-1 grid gap-3 md:grid-cols-2">
                <Field label="Provider" value={territory.utilityProvider} onChange={(v) => updateTerritory(territoryIndex, { utilityProvider: v })} placeholder="Middle Tennessee Electric" />
                <Field label="Phone (power cuts / disconnects)" value={territory.utilityPhone} onChange={(v) => updateTerritory(territoryIndex, { utilityPhone: v })} />
                <Field label="Email" value={territory.utilityEmail} onChange={(v) => updateTerritory(territoryIndex, { utilityEmail: v })} />
                <Field label="Notes" value={territory.utilityNotes} onChange={(v) => updateTerritory(territoryIndex, { utilityNotes: v })} placeholder="48h notice required for planned cuts" />
              </div>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-rce-muted">AHJ inspector</p>
              <div className="mt-1 grid gap-3 md:grid-cols-2">
                <Field label="Inspector name" value={territory.inspectorName} onChange={(v) => updateTerritory(territoryIndex, { inspectorName: v })} />
                <Field label="Inspector phone" value={territory.inspectorPhone} onChange={(v) => updateTerritory(territoryIndex, { inspectorPhone: v })} />
                <Field label="Inspector email" value={territory.inspectorEmail} onChange={(v) => updateTerritory(territoryIndex, { inspectorEmail: v })} />
                <Field label="Notes" value={territory.inspectorNotes} onChange={(v) => updateTerritory(territoryIndex, { inspectorNotes: v })} placeholder="Prefers morning inspections; books 2 days out" />
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-rce-muted">No territories yet — click Add territory.</p>
        )}
        <div className="mt-4 flex gap-3">
          <button className="btn" type="button" onClick={addTerritory}>
            Add territory
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate({ key: "territories", value: territories })}
          >
            {savedKey === "territories" ? "Saved ✓" : "Save territories"}
          </button>
        </div>
      </SectionCard>

      <SectionCard
        id="settings-legal-warranty"
        title="Legal & warranty"
        attention={legalDirty}
        subtitle="Warranty terms, company policies and insurance notes."
        summary={<>{settings?.legal?.warrantyText ? "Warranty terms written" : "Nothing written yet"}<UnsavedNote show={legalDirty} /></>}
      >
        <div className="grid gap-3">
          <label className="text-sm font-medium">
            Warranty terms
            <textarea
              className="field mt-1 w-full"
              rows={4}
              value={legal.warrantyText}
              placeholder="12-month workmanship warranty on all installed work…"
              onChange={(e) => setL({ warrantyText: e.target.value })}
            />
          </label>
          <label className="text-sm font-medium">
            Company policies & procedures
            <textarea
              className="field mt-1 w-full"
              rows={4}
              value={legal.policiesText}
              placeholder="Scheduling, cancellation, and payment policies…"
              onChange={(e) => setL({ policiesText: e.target.value })}
            />
          </label>
          <label className="text-sm font-medium">
            Insurance documentation notes
            <textarea
              className="field mt-1 w-full"
              rows={3}
              value={legal.insuranceNotes}
              placeholder="COI on file location, agent contact, renewal reminders…"
              onChange={(e) => setL({ insuranceNotes: e.target.value })}
            />
          </label>
        </div>
        <button
          className="btn btn-primary mt-4"
          type="button"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate({ key: "legal", value: legal })}
        >
          {savedKey === "legal" ? "Saved ✓" : "Save legal"}
        </button>
      </SectionCard>

      <PurchasingSection />

      {/* ── Billed labor rate (Kyle, 2026-10-27): the hourly rate the price book is built from ── */}
      <BilledRateSection />

      {/* ── Payroll (Kyle, 2026-10-08, decision 10): labor on a job is the TOTAL cost Red Cedar pays ── */}
      <SectionCard
        id="settings-payroll"
        title="Payroll"
        attention={payrollDirty}
        // Kyle, 2026-10-08: "It should be the total cost that we pay because that all comes out of the field work." Labor on a
        // job counts at hours × the technician's hourly rate × (1 + this percent) in the commission basis; until it is set, every
        // commission basis says "employer cost % not set", never 0%. The percent is everything paid on top of wages: employer
        // Social Security 6.2%, Medicare 1.45%, federal and Tennessee unemployment, workers' comp.
        subtitle="The employer cost, as a percent on top of wages, that counts toward a job's labor in the commission basis."
        summary={<>{settings?.payroll?.employerCostPercent != null ? `${settings.payroll.employerCostPercent}% employer cost` : "Employer cost not set"}<UnsavedNote show={payrollDirty} /></>}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label="Employer cost on top of wages (%)"
            value={employerCostPercent}
            type="number"
            placeholder="not set"
            onChange={(v) => setEmployerCostPercent(v)}
          />
        </div>
        <p className="mt-2 text-xs text-rce-muted">A percent: 9.5 means 9.5%. Leave it empty to clear it.</p>
        {payrollError && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{payrollError}</p>}
        {saveMutation.error && saveMutation.variables?.key === "payroll" && (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{(saveMutation.error as Error).message}</p>
        )}
        <button
          className="btn btn-primary mt-4"
          type="button"
          disabled={saveMutation.isPending}
          onClick={saveEmployerCost}
        >
          {savedKey === "payroll" ? "Saved ✓" : "Save payroll"}
        </button>
      </SectionCard>

      {/* ── Financing plans (Kyle, 2026-10-08): the Synchrony plan list, rates and disclosure text ── */}
      <FinancingPlansSection />

      {/* ── Treasury (Kyle, 2026-09-09): floats + the Chase destination for the month-end sweep ── */}
      <TreasurySection />

      {/* ── AI admin login (Kyle, 2026-11-15): the AI admin's own username + password ── */}
      <AdminLoginSection />

      {/* ── Agent keys (work order agent-team, K-U2): the keys the AI agents use, and the pause switch ── */}
      <AgentKeysSection />

      {/* ── Agent events (work order agent-team, BA5): the signed-event log and Resend ── */}
      <AgentEventsSection />

      {/* ── Agent webhooks (TC4, Kyle only): where each agent's events go ── */}
      <AgentWebhooksSection />

      {/* ── Message reminders (U8, Kyle only): the hours the waiting-approval reminder may go out ── */}
      <MessageRemindersSection />

      {/* ── Message audit log (U4, Kyle only): what the hub did, with the "Blocked texts" filter ── */}
      <MessageAuditLogSection />
      </div>
    </div>
  );
}
