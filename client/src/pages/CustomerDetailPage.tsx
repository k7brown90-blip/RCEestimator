import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import { money, shortDate } from "../lib/utils";

export function CustomerDetailPage() {
  const { customerId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: customer, isLoading } = useQuery({
    queryKey: ["customer", customerId],
    queryFn: () => api.customer(customerId),
    enabled: Boolean(customerId),
  });

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");

  const [propertyName, setPropertyName] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("CO");
  const [postalCode, setPostalCode] = useState("");

  const updateCustomer = useMutation({
    mutationFn: (input: { name: string; email?: string | null; phone?: string | null }) =>
      api.updateCustomer(customerId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setEditing(false);
    },
  });

  const deleteCustomer = useMutation({
    mutationFn: () => api.deleteCustomer(customerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      navigate("/customers");
    },
  });

  const createProperty = useMutation({
    mutationFn: api.createProperty,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      setPropertyName("");
      setAddressLine1("");
      setCity("");
      setPostalCode("");
    },
  });

  function startEdit() {
    setEditName(customer?.name ?? "");
    setEditEmail(customer?.email ?? "");
    setEditPhone(customer?.phone ?? "");
    setEditing(true);
  }

  function submitEdit(e: FormEvent) {
    e.preventDefault();
    updateCustomer.mutate({ name: editName, email: editEmail || null, phone: editPhone || null });
  }

  function submitProperty(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    createProperty.mutate({ customerId, name: propertyName, addressLine1, city, state, postalCode });
  }

  function confirmDelete() {
    if (window.confirm(`Delete ${customer?.name}? This cannot be undone.`)) {
      deleteCustomer.mutate();
    }
  }

  if (isLoading || !customer) {
    return <p className="text-sm text-rce-muted">Loading customer...</p>;
  }

  return (
    <div>
      <PageHeader title={customer.name} subtitle="Customer record" />

      {/* Contact info */}
      <div className="card mb-5 p-4">
        {editing ? (
          <form onSubmit={submitEdit} className="grid gap-3 md:grid-cols-3">
            <label className="text-sm font-medium">
              Name
              <input className="field mt-1" value={editName} onChange={(e) => setEditName(e.target.value)} required />
            </label>
            <label className="text-sm font-medium">
              Email
              <input className="field mt-1" type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
            </label>
            <label className="text-sm font-medium">
              Phone
              <input className="field mt-1" type="tel" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} />
            </label>
            <div className="flex gap-2 md:col-span-3">
              <button className="btn btn-primary" type="submit" disabled={updateCustomer.isPending}>Save</button>
              <button className="btn btn-secondary" type="button" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm text-rce-muted">{customer.email || <span className="italic text-rce-soft">No email</span>}</p>
              <p className="text-sm text-rce-muted">{customer.phone || <span className="italic text-rce-soft">No phone</span>}</p>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-secondary" onClick={startEdit}>Edit Contact</button>
              <button
                className="btn btn-secondary text-red-600 hover:border-red-400"
                onClick={confirmDelete}
                disabled={deleteCustomer.isPending}
              >
                Delete
              </button>
            </div>
          </div>
        )}
        {deleteCustomer.error && (
          <p className="mt-2 text-sm text-red-600">{(deleteCustomer.error as Error).message}</p>
        )}
      </div>

      {/* Add property form */}
      <form className="card mb-5 grid gap-3 p-4 md:grid-cols-5" onSubmit={submitProperty}>
        <label className="text-sm font-medium">
          Property Name
          <input className="field mt-1" value={propertyName} onChange={(e) => setPropertyName(e.target.value)} required />
        </label>
        <label className="text-sm font-medium md:col-span-2">
          Address
          <input className="field mt-1" value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} required />
        </label>
        <label className="text-sm font-medium">
          City
          <input className="field mt-1" value={city} onChange={(e) => setCity(e.target.value)} required />
        </label>
        <label className="text-sm font-medium">
          State / ZIP
          <div className="mt-1 grid grid-cols-2 gap-2">
            <input className="field" value={state} onChange={(e) => setState(e.target.value)} required />
            <input className="field" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} required />
          </div>
        </label>
        <div className="md:col-span-5">
          <button className="btn btn-primary" type="submit" disabled={createProperty.isPending}>+ Add Property</button>
        </div>
      </form>

      {/* Properties list */}
      <section className="space-y-4">
        {customer.properties?.map((property) => (
          <article key={property.id} className="card p-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{property.name}</h2>
                <p className="text-sm text-rce-muted">{property.addressLine1}, {property.city}, {property.state} {property.postalCode}</p>
              </div>
              <Link to={`/properties/${property.id}`} className="btn btn-secondary">Open Property</Link>
            </div>
            <div className="mt-3 space-y-2">
              {property.visits?.map((visit) => {
                const estimate = visit.estimates?.[0];
                return (
                  <Link key={visit.id} to={`/visits/${visit.id}`} className="block rounded-lg border border-rce-border p-3 hover:border-rce-accent">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">{visit.mode.replaceAll("_", " ")} | {shortDate(visit.visitDate)}</p>
                      {estimate ? <StatusBadge status={estimate.status} /> : <span className="text-xs text-rce-soft">NO ESTIMATE</span>}
                    </div>
                    <p className="text-xs text-rce-muted">{estimate ? `${estimate.title} | Rev ${estimate.revision} | ${money(estimate.options?.[0]?.totalCost)}` : "No estimate yet"}</p>
                  </Link>
                );
              })}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
