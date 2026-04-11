import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import { money, parseJsonArray, shortDate } from "../lib/utils";

const MODES = [
  { value: "service_diagnostic", label: "Service / Diagnostic" },
  { value: "remodel", label: "Remodel / Addition" },
  { value: "new_construction", label: "New Construction" },
  { value: "maintenance", label: "Maintenance" },
];

export function PropertyDetailPage() {
  const { propertyId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: property, isLoading } = useQuery({ queryKey: ["property", propertyId], queryFn: () => api.property(propertyId), enabled: Boolean(propertyId) });

  const [mode, setMode] = useState("service_diagnostic");
  const [purpose, setPurpose] = useState("");

  const deficiencyList = useMemo(() => parseJsonArray(property?.systemSnapshot?.deficienciesJson), [property?.systemSnapshot?.deficienciesJson]);
  const [serviceSummary, setServiceSummary] = useState(property?.systemSnapshot?.serviceSummary ?? "");
  const [panelSummary, setPanelSummary] = useState(property?.systemSnapshot?.panelSummary ?? "");
  const [groundingSummary, setGroundingSummary] = useState(property?.systemSnapshot?.groundingSummary ?? "");
  const [wiringMethodSummary, setWiringMethodSummary] = useState(property?.systemSnapshot?.wiringMethodSummary ?? "");
  const [deficienciesText, setDeficienciesText] = useState(deficiencyList.join("\n"));

  useEffect(() => {
    setServiceSummary(property?.systemSnapshot?.serviceSummary ?? "");
    setPanelSummary(property?.systemSnapshot?.panelSummary ?? "");
    setGroundingSummary(property?.systemSnapshot?.groundingSummary ?? "");
    setWiringMethodSummary(property?.systemSnapshot?.wiringMethodSummary ?? "");
    setDeficienciesText(parseJsonArray(property?.systemSnapshot?.deficienciesJson).join("\n"));
  }, [
    property?.systemSnapshot?.serviceSummary,
    property?.systemSnapshot?.panelSummary,
    property?.systemSnapshot?.groundingSummary,
    property?.systemSnapshot?.wiringMethodSummary,
    property?.systemSnapshot?.deficienciesJson,
  ]);

  const startVisit = useMutation({
    mutationFn: api.createVisit,
    onSuccess: (visit) => {
      queryClient.invalidateQueries({ queryKey: ["property", propertyId] });
      navigate(`/visits/${visit.id}`);
    },
  });

  const updateSnapshot = useMutation({
    mutationFn: (input: { serviceSummary?: string; panelSummary?: string; groundingSummary?: string; wiringMethodSummary?: string; deficiencies?: string[] }) =>
      api.updateSnapshot(propertyId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["property", propertyId] });
    },
  });

  function submitVisit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!property) return;
    startVisit.mutate({ propertyId: property.id, customerId: property.customerId, mode, purpose });
  }

  function submitSnapshot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateSnapshot.mutate({
      serviceSummary,
      panelSummary,
      groundingSummary,
      wiringMethodSummary,
      deficiencies: deficienciesText.split("\n").map((entry) => entry.trim()).filter(Boolean),
    });
  }

  if (isLoading || !property) {
    return <p className="text-sm text-rce-muted">Loading property...</p>;
  }

  return (
    <div>
      <PageHeader title={property.addressLine1} subtitle={`${property.city}, ${property.state} ${property.postalCode}`} actions={<Link className="btn btn-secondary" to={`/customers/${property.customerId}`}>Back to Customer</Link>} />

      <section className="card mb-5 p-4">
        <h2 className="mb-3 text-lg font-semibold">Start New Visit</h2>
        <form className="grid gap-3 md:grid-cols-3" onSubmit={submitVisit}>
          <label className="text-sm font-medium">
            Mode
            <select className="field mt-1" value={mode} onChange={(event) => setMode(event.target.value)}>
              {MODES.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium md:col-span-2">
            Purpose
            <input className="field mt-1" value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Customer stated reason" />
          </label>
          <div className="md:col-span-3">
            <button className="btn btn-primary" type="submit" disabled={startVisit.isPending}>+ Start New Visit</button>
          </div>
        </form>
      </section>

      <section className="card mb-5 p-4">
        <h2 className="mb-3 text-lg font-semibold">System Snapshot</h2>
        <form className="grid gap-3 md:grid-cols-2" onSubmit={submitSnapshot}>
          <label className="text-sm font-medium">
            Service
            <textarea className="field mt-1 min-h-24" value={serviceSummary} onChange={(event) => setServiceSummary(event.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Main Panel
            <textarea className="field mt-1 min-h-24" value={panelSummary} onChange={(event) => setPanelSummary(event.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Grounding
            <textarea className="field mt-1 min-h-24" value={groundingSummary} onChange={(event) => setGroundingSummary(event.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Wiring Method
            <textarea className="field mt-1 min-h-24" value={wiringMethodSummary} onChange={(event) => setWiringMethodSummary(event.target.value)} />
          </label>
          <label className="text-sm font-medium md:col-span-2">
            Deficiencies (one per line)
            <textarea className="field mt-1 min-h-28" value={deficienciesText} onChange={(event) => setDeficienciesText(event.target.value)} />
          </label>
          <div className="md:col-span-2">
            <button className="btn btn-primary" type="submit" disabled={updateSnapshot.isPending}>Save Snapshot</button>
          </div>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Visits and Estimates</h2>
        {property.visits?.map((visit) => {
          const estimate = visit.estimates?.[0];
          return (
            <Link key={visit.id} to={`/visits/${visit.id}`} className="card block p-4 hover:border-rce-accent">
              <div className="flex items-center justify-between">
                <p className="font-medium">{visit.mode.replaceAll("_", " ")} | {shortDate(visit.visitDate)}</p>
                {estimate ? <StatusBadge status={estimate.status} /> : <span className="text-xs text-rce-soft">NO ESTIMATE</span>}
              </div>
              <p className="text-sm text-rce-muted">{estimate ? `${estimate.title} | Rev ${estimate.revision} | ${money(estimate.options?.[0]?.totalCost)}` : "No estimate yet"}</p>
            </Link>
          );
        })}
      </section>
    </div>
  );
}
