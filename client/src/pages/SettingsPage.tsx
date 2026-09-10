import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import type { CompanyProfile, LegalInfo, OperatingHours, Territory } from "../lib/api";
import type { TreasurySettings } from "../lib/types";

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

function TreasurySection() {
  const queryClient = useQueryClient();
  const { data: treasury } = useQuery({ queryKey: ["treasury-settings"], queryFn: api.treasurySettings });
  const { data: balances } = useQuery({ queryKey: ["financials-balances"], queryFn: api.financialsBalances });
  const { data: trucksData } = useQuery({ queryKey: ["trucks"], queryFn: api.trucks });
  const [form, setForm] = useState<TreasuryForm>(EMPTY_TREASURY);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!treasury) return;
    setForm({
      mainFinancialAccountId: treasury.mainFinancialAccountId ?? "",
      mainFloat: String(treasury.mainFloat ?? 0),
      truckFloats: Object.fromEntries(Object.entries(treasury.truckFloats ?? {}).map(([k, v]) => [k, String(v)])),
      chaseAccountLabel: treasury.chaseAccountLabel ?? "",
      chaseExternalAccountId: treasury.chaseExternalAccountId ?? "",
    });
  }, [treasury]);

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
      title="Treasury"
      subtitle="Working balances (floats) for the main financial account and each truck, and the Chase account the month-end sweep goes to. The sweep itself is a click on Financials — nothing here runs on its own."
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
      <button className="btn btn-primary mt-4" type="button" disabled={save.isPending} onClick={onSave}>
        {saved ? "Saved ✓" : "Save treasury"}
      </button>
    </SectionCard>
  );
}

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="card mt-5 p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle ? <p className="mt-1 text-sm text-rce-muted">{subtitle}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({ label, value, onChange, placeholder, type = "text" }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="text-sm font-medium">
      {label}
      <input
        className="field mt-1 w-full"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["companySettings"], queryFn: api.companySettings });

  const [profile, setProfile] = useState<CompanyProfile>(EMPTY_PROFILE);
  const [hours, setHours] = useState<OperatingHours>(EMPTY_HOURS);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [legal, setLegal] = useState<LegalInfo>(EMPTY_LEGAL);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    if (settings.companyProfile) setProfile({ ...EMPTY_PROFILE, ...settings.companyProfile });
    if (settings.operatingHours) setHours({ ...EMPTY_HOURS, ...settings.operatingHours });
    if (settings.territories) setTerritories(settings.territories);
    if (settings.legal) setLegal({ ...EMPTY_LEGAL, ...settings.legal });
  }, [settings]);

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

  const updateTerritory = (index: number, patch: Partial<Territory>) =>
    setTerritories((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const addTerritory = () =>
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

  const removeTerritory = (index: number) => setTerritories((rows) => rows.filter((_, i) => i !== index));

  return (
    <div>
      <PageHeader title="Settings" subtitle="Company configuration — licensing, hours, territories, legal" />

      <SectionCard
        title="Company profile"
        subtitle="Business identity, license, and insurance. This feeds documents, reports, and the voice agent."
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

      <SectionCard title="Operating hours" subtitle="Displayed to customers and used by the voice agent.">
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
        title="Service territories"
        subtitle="Per-ZIP operating data: adopted code cycle, utility provider with contact info for scheduling power cuts, and the AHJ inspector."
      >
        <div className="space-y-4">
          {territories.map((territory, index) => (
            <div key={index} className="rounded-lg border border-rce-border bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">
                  {territory.zip || "New territory"}
                  {territory.area ? ` — ${territory.area}` : ""}
                </span>
                <button type="button" className="text-xs font-medium text-red-600" onClick={() => removeTerritory(index)}>
                  Remove
                </button>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <Field label="ZIP code" value={territory.zip} onChange={(v) => updateTerritory(index, { zip: v })} placeholder="37064" />
                <Field label="Area name" value={territory.area} onChange={(v) => updateTerritory(index, { area: v })} placeholder="Franklin" />
                <Field label="Code cycle" value={territory.codeCycle} onChange={(v) => updateTerritory(index, { codeCycle: v })} placeholder="NEC 2017" />
              </div>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-rce-muted">Utility provider</p>
              <div className="mt-1 grid gap-3 md:grid-cols-2">
                <Field label="Provider" value={territory.utilityProvider} onChange={(v) => updateTerritory(index, { utilityProvider: v })} placeholder="Middle Tennessee Electric" />
                <Field label="Phone (power cuts / disconnects)" value={territory.utilityPhone} onChange={(v) => updateTerritory(index, { utilityPhone: v })} />
                <Field label="Email" value={territory.utilityEmail} onChange={(v) => updateTerritory(index, { utilityEmail: v })} />
                <Field label="Notes" value={territory.utilityNotes} onChange={(v) => updateTerritory(index, { utilityNotes: v })} placeholder="48h notice required for planned cuts" />
              </div>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-rce-muted">AHJ inspector</p>
              <div className="mt-1 grid gap-3 md:grid-cols-2">
                <Field label="Inspector name" value={territory.inspectorName} onChange={(v) => updateTerritory(index, { inspectorName: v })} />
                <Field label="Inspector phone" value={territory.inspectorPhone} onChange={(v) => updateTerritory(index, { inspectorPhone: v })} />
                <Field label="Inspector email" value={territory.inspectorEmail} onChange={(v) => updateTerritory(index, { inspectorEmail: v })} />
                <Field label="Notes" value={territory.inspectorNotes} onChange={(v) => updateTerritory(index, { inspectorNotes: v })} placeholder="Prefers morning inspections; books 2 days out" />
              </div>
            </div>
          ))}
        </div>
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
        title="Legal & warranty"
        subtitle="Warranty terms, company policies, and insurance documentation notes."
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

      {/* ── Treasury (Kyle, 2026-09-09): floats + the Chase destination for the month-end sweep ── */}
      <TreasurySection />
    </div>
  );
}
