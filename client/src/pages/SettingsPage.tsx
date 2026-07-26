import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";

function TechniciansSection() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [revealedTokenId, setRevealedTokenId] = useState<string | null>(null);

  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });

  const createMutation = useMutation({
    mutationFn: () =>
      api.createTechnician({ name: name.trim(), email: email.trim() || undefined, phone: phone.trim() || undefined }),
    onSuccess: (tech) => {
      setName("");
      setEmail("");
      setPhone("");
      setRevealedTokenId(tech.id);
      void queryClient.invalidateQueries({ queryKey: ["technicians"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { technicianId: string; isActive?: boolean; rotateToken?: boolean }) =>
      api.updateTechnician(input.technicianId, { isActive: input.isActive, rotateToken: input.rotateToken }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["technicians"] }),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim()) createMutation.mutate();
  };

  return (
    <section className="card mt-5 p-6">
      <h2 className="text-lg font-semibold">Field technicians</h2>
      <p className="mt-1 text-sm text-rce-muted">
        Technicians sign in to the Health Record field app with their access token. Assign
        inspections from a job's workspace; completed inspections save to the customer's
        account automatically.
      </p>

      <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={submit}>
        <label className="text-sm font-medium">
          Name
          <input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="text-sm font-medium">
          Email
          <input className="field mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          Phone
          <input className="field mt-1" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <button className="btn btn-primary" type="submit" disabled={createMutation.isPending}>
          Add technician
        </button>
      </form>

      <ul className="mt-4 space-y-2">
        {(technicians ?? []).map((tech) => (
          <li key={tech.id} className="rounded-lg border border-rce-border bg-white p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-medium">{tech.name}</span>
                <span className="ml-2 text-xs text-rce-muted">
                  {tech.role} · {tech.isActive ? "active" : "deactivated"}
                  {tech._count ? ` · ${tech._count.healthInspections} inspections` : ""}
                </span>
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className="text-xs font-medium text-rce-accent"
                  onClick={() => setRevealedTokenId(revealedTokenId === tech.id ? null : tech.id)}
                >
                  {revealedTokenId === tech.id ? "Hide token" : "Show token"}
                </button>
                <button
                  type="button"
                  className="text-xs font-medium text-rce-accent"
                  onClick={() => updateMutation.mutate({ technicianId: tech.id, rotateToken: true })}
                >
                  Rotate token
                </button>
                <button
                  type="button"
                  className={`text-xs font-medium ${tech.isActive ? "text-red-600" : "text-emerald-600"}`}
                  onClick={() => updateMutation.mutate({ technicianId: tech.id, isActive: !tech.isActive })}
                >
                  {tech.isActive ? "Deactivate" : "Reactivate"}
                </button>
              </span>
            </div>
            {revealedTokenId === tech.id && (
              <p className="mt-2 break-all rounded bg-rce-accentBg/40 p-2 font-mono text-xs">
                {tech.accessToken}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SettingsPage() {
  return (
    <div>
      <PageHeader title="Settings" subtitle="Company and account configuration shell" />
      <section className="card p-6">
        <p className="text-sm text-rce-muted">Phase 1 keeps settings intentionally minimal. Add company branding, email configuration, and account controls in later phases.</p>
      </section>
      <TechniciansSection />
    </div>
  );
}
