import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";

export function CustomersPage() {
  const queryClient = useQueryClient();
  const { data: customers = [], isLoading } = useQuery({ queryKey: ["customers"], queryFn: api.customers });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const createCustomer = useMutation({
    mutationFn: api.createCustomer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setName("");
      setEmail("");
      setPhone("");
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createCustomer.mutate({ name, email: email || undefined, phone: phone || undefined });
  }

  return (
    <div>
      <PageHeader title="Customers" subtitle="Customer and property management" />

      <form className="card mb-5 grid gap-3 p-4 md:grid-cols-4" onSubmit={submit}>
        <label className="text-sm font-medium">
          Name
          <input className="field mt-1" value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label className="text-sm font-medium">
          Email
          <input className="field mt-1" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="text-sm font-medium">
          Phone
          <input className="field mt-1" value={phone} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <div className="flex items-end">
          <button className="btn btn-primary w-full" type="submit" disabled={createCustomer.isPending}>Create Customer</button>
        </div>
      </form>

      {isLoading ? <p className="text-sm text-rce-muted">Loading customers...</p> : null}

      <div className="space-y-3">
        {customers.map((customer) => (
          <Link key={customer.id} to={`/customers/${customer.id}`} className="card block p-4 transition hover:border-rce-accent">
            <h2 className="text-lg font-semibold">{customer.name}</h2>
            <p className="text-sm text-rce-muted">{customer.email || "No email"} | {customer.phone || "No phone"}</p>
            <p className="mt-2 text-xs text-rce-soft">Properties: {customer.properties?.length ?? 0}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
