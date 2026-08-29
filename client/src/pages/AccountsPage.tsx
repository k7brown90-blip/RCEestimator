import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { CustomerMatchPicker } from "../components/CustomerMatchPicker";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { ADDRESS_QUERY_KEYS } from "../lib/queryKeys";
import { isActiveJob } from "../lib/types";
import { money } from "../lib/utils";

/** One row of the addresses repeater. */
interface AddressDraft {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
}

const blankAddress = (): AddressDraft => ({
  name: "", addressLine1: "", addressLine2: "", city: "", state: "TN", postalCode: "",
});

export function AccountsPage() {
  const queryClient = useQueryClient();
  const { data: accounts = [], isLoading, error } = useQuery({
    queryKey: ["accounts"],
    queryFn: api.accounts,
  });
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [addresses, setAddresses] = useState<AddressDraft[]>([blankAddress()]);
  const [search, setSearch] = useState("");

  /**
   * Account, then each address in turn.
   *
   * Sequential rather than parallel: `POST /properties` also creates a
   * SystemSnapshot, there's no bulk endpoint, and on a partial failure the owner
   * needs to know WHICH address failed while the account survives to retry
   * against. A Promise.all would leave that ambiguous.
   */
  const createAccountWithAddresses = useMutation({
    mutationFn: async () => {
      const account = await api.createAccount({
        name, email: email || undefined, phone: phone || undefined,
      });
      for (const [index, draft] of addresses.entries()) {
        if (!draft.addressLine1.trim()) continue;
        try {
          await api.createProperty({
            customerId: account.id,
            name: draft.name.trim() || draft.addressLine1.trim(),
            addressLine1: draft.addressLine1.trim(),
            addressLine2: draft.addressLine2.trim() || null,
            city: draft.city.trim(),
            state: draft.state.trim().toUpperCase(),
            postalCode: draft.postalCode.trim(),
          });
        } catch (err) {
          // The account exists — say so, and say which row stopped, rather than
          // failing in a way that reads as "nothing was saved".
          throw new Error(
            `Account created, but address ${index + 1} (${draft.addressLine1}) failed: ` +
            `${(err as Error).message}. Add it from the account page.`,
          );
        }
      }
      return account;
    },
    onSuccess: (account) => {
      for (const key of ADDRESS_QUERY_KEYS) queryClient.invalidateQueries({ queryKey: [...key] });
      navigate(`/accounts/${account.id}`);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createAccountWithAddresses.mutate();
  }

  const setAddress = (index: number, patch: Partial<AddressDraft>) =>
    setAddresses((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return accounts;
    return accounts.filter((account) =>
      [account.name, account.email, account.phone]
        .some((field) => field?.toLowerCase().includes(needle)),
    );
  }, [accounts, search]);

  return (
    <div>
      <PageHeader
        title="Accounts"
        subtitle="Client database — properties, job history, and job-level revenue"
        actions={
          <button className="btn btn-primary" onClick={() => setShowCreate((open) => !open)}>
            {showCreate ? "Cancel" : "+ New Account"}
          </button>
        }
      />

      {showCreate && (
        <form className="card mb-5 p-4" onSubmit={submit}>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm font-medium">
              Name
              <input className="field mt-1" value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label className="text-sm font-medium">
              Email
              <input className="field mt-1" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label className="text-sm font-medium">
              Phone
              <input className="field mt-1" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
            </label>
          </div>

          <div className="mt-3">
            {/* An existing account can't be "linked" to a new one — the honest
                affordance is to open it instead of creating a second. */}
            <CustomerMatchPicker
              mode="navigate"
              phone={phone}
              email={email}
              name={name}
              linkedCustomerId={null}
              linkedPropertyId={null}
              onLink={() => {}}
              onUnlink={() => {}}
            />
          </div>

          <div className="mt-4">
            <p className="text-sm font-medium">Addresses</p>
            <p className="text-xs text-rce-muted">
              One account, as many properties as they own. Add them all now or add more later.
            </p>

            <div className="mt-2 space-y-3">
              {addresses.map((draft, index) => (
                <div key={index} className="grid gap-3 rounded-lg border border-rce-border p-3 md:grid-cols-5">
                  <label className="text-sm font-medium">
                    Property Name
                    <input className="field mt-1" placeholder="Main house, Rental…" value={draft.name} onChange={(e) => setAddress(index, { name: e.target.value })} />
                  </label>
                  <label className="text-sm font-medium md:col-span-2">
                    Address
                    <input className="field mt-1" value={draft.addressLine1} onChange={(e) => setAddress(index, { addressLine1: e.target.value })} required={index === 0} />
                  </label>
                  <label className="text-sm font-medium">
                    Unit / Apt
                    <input className="field mt-1" value={draft.addressLine2} onChange={(e) => setAddress(index, { addressLine2: e.target.value })} />
                  </label>
                  <label className="text-sm font-medium">
                    City
                    <input className="field mt-1" value={draft.city} onChange={(e) => setAddress(index, { city: e.target.value })} required={index === 0} />
                  </label>
                  <label className="text-sm font-medium">
                    State / ZIP
                    <div className="mt-1 grid grid-cols-2 gap-2">
                      <input className="field" maxLength={2} value={draft.state} onChange={(e) => setAddress(index, { state: e.target.value.toUpperCase() })} required={index === 0} />
                      <input className="field" value={draft.postalCode} onChange={(e) => setAddress(index, { postalCode: e.target.value })} required={index === 0} />
                    </div>
                  </label>
                  {addresses.length > 1 && (
                    <div className="flex items-end md:col-span-4">
                      <button
                        type="button"
                        className="btn btn-secondary text-xs"
                        onClick={() => setAddresses((rows) => rows.filter((_, i) => i !== index))}
                      >
                        Remove this address
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button
              type="button"
              className="btn btn-secondary mt-2 text-xs"
              onClick={() => setAddresses((rows) => [...rows, blankAddress()])}
            >
              + Add another address
            </button>
          </div>

          {createAccountWithAddresses.error && (
            <p className="mt-3 text-sm text-red-600">{(createAccountWithAddresses.error as Error).message}</p>
          )}

          <button className="btn btn-primary mt-4" type="submit" disabled={createAccountWithAddresses.isPending}>
            {createAccountWithAddresses.isPending ? "Creating…" : "Create Account"}
          </button>
        </form>
      )}

      {accounts.length > 0 && (
        <input
          className="field mb-4 w-full md:max-w-sm"
          placeholder="Search accounts…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      )}

      {isLoading ? <p className="text-sm text-rce-muted">Loading accounts…</p> : null}
      {error ? <p className="text-sm text-red-500">Error loading accounts: {error.message}</p> : null}

      <div className="space-y-3">
        {filtered.map((account) => {
          const properties = account.properties ?? [];
          const visits = properties.flatMap((property) => property.visits ?? []);
          // Signed work only — a booked consultation is not an "active job"
          // (Kyle, 2026-08-29).
          const activeCount = visits.filter((visit) => isActiveJob(visit.status ?? "")).length;
          const lifetimeRevenue = visits.reduce((sum, visit) => sum + (visit.revenue ?? 0), 0);

          return (
            <Link
              key={account.id}
              to={`/accounts/${account.id}`}
              className="card block p-4 transition hover:border-rce-accent"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">{account.name}</h2>
                {lifetimeRevenue > 0 && (
                  <span className="text-sm font-medium text-rce-muted">
                    {money(lifetimeRevenue)} lifetime
                  </span>
                )}
              </div>
              <p className="text-sm text-rce-muted">
                {account.email || "No email"} · {account.phone || "No phone"}
              </p>
              <p className="mt-2 text-xs text-rce-soft">
                {properties.length} {properties.length === 1 ? "property" : "properties"}
                {activeCount > 0 && ` · ${activeCount} active ${activeCount === 1 ? "job" : "jobs"}`}
              </p>
            </Link>
          );
        })}
        {!isLoading && filtered.length === 0 && (
          <p className="text-sm text-rce-muted">
            {accounts.length === 0 ? "No accounts yet." : "No accounts match that search."}
          </p>
        )}
      </div>
    </div>
  );
}
