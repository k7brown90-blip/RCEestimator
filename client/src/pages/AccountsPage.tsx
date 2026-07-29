import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { isArchivedJob } from "../lib/types";
import { money } from "../lib/utils";

export function AccountsPage() {
  const queryClient = useQueryClient();
  const { data: accounts = [], isLoading, error } = useQuery({
    queryKey: ["accounts"],
    queryFn: api.accounts,
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [search, setSearch] = useState("");

  const createAccount = useMutation({
    mutationFn: api.createAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setName("");
      setEmail("");
      setPhone("");
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createAccount.mutate({ name, email: email || undefined, phone: phone || undefined });
  }

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
      />

      <form className="card mb-5 grid gap-3 p-4 md:grid-cols-4" onSubmit={submit}>
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
        <div className="flex items-end">
          <button className="btn btn-primary w-full" type="submit" disabled={createAccount.isPending}>
            Create Account
          </button>
        </div>
        <p className="text-xs text-rce-muted md:col-span-4">
          An account holds the client's contact details. Addresses are added inside the
          account — one account can carry as many properties as they own.
        </p>
      </form>

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
          const activeCount = visits.filter((visit) => !isArchivedJob(visit.status ?? "")).length;
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
