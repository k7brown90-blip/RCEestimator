import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";

/**
 * Team roster — technicians and staff. Each member carries an employee number
 * used across the system: voice-agent verification, health report attribution,
 * assignment tracking, and (eventually) payroll.
 */
export function TeamPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [role, setRole] = useState("technician");
  const [revealedTokenId, setRevealedTokenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editEmployeeNumber, setEditEmployeeNumber] = useState("");

  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });

  const createMutation = useMutation({
    mutationFn: () =>
      api.createTechnician({
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        employeeNumber: employeeNumber.trim() || undefined,
        role,
      }),
    onSuccess: (tech) => {
      setName("");
      setEmail("");
      setPhone("");
      setEmployeeNumber("");
      setRole("technician");
      setRevealedTokenId(tech.id);
      void queryClient.invalidateQueries({ queryKey: ["technicians"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { technicianId: string; isActive?: boolean; rotateToken?: boolean; employeeNumber?: string | null }) =>
      api.updateTechnician(input.technicianId, {
        isActive: input.isActive,
        rotateToken: input.rotateToken,
        employeeNumber: input.employeeNumber,
      }),
    onSuccess: () => {
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: ["technicians"] });
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim()) createMutation.mutate();
  };

  return (
    <div>
      <PageHeader
        title="Team"
        subtitle="Technicians and staff — employee numbers drive agent verification, report attribution, and job tracking"
      />

      <section className="card p-6">
        <h2 className="text-lg font-semibold">Add team member</h2>
        <p className="mt-1 text-sm text-rce-muted">
          The employee number is what field staff give Savannah over the phone to verify
          themselves. Keep it short and memorable (e.g. RCE-01). Technicians sign in to the
          Health Record field app with the access token generated on creation.
        </p>

        <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={submit}>
          <label className="text-sm font-medium">
            Name
            <input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="text-sm font-medium">
            Employee #
            <input
              className="field mt-1"
              value={employeeNumber}
              onChange={(e) => setEmployeeNumber(e.target.value)}
              placeholder="RCE-01"
            />
          </label>
          <label className="text-sm font-medium">
            Role
            <select className="field mt-1" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="technician">Technician</option>
              <option value="supervisor">Supervisor</option>
              <option value="admin">Admin</option>
            </select>
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
            Add member
          </button>
        </form>
      </section>

      <section className="card mt-5 p-6">
        <h2 className="text-lg font-semibold">Roster</h2>
        <ul className="mt-4 space-y-2">
          {(technicians ?? []).map((tech) => (
            <li key={tech.id} className="rounded-lg border border-rce-border bg-white p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{tech.name}</span>
                  {tech.employeeNumber ? (
                    <span className="ml-2 rounded bg-rce-accentBg px-1.5 py-0.5 font-mono text-xs text-rce-accentDark">
                      {tech.employeeNumber}
                    </span>
                  ) : (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                      no employee #
                    </span>
                  )}
                  <span className="ml-2 text-xs text-rce-muted">
                    {tech.role} · {tech.isActive ? "active" : "deactivated"}
                    {tech._count ? ` · ${tech._count.healthInspections} inspections` : ""}
                  </span>
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    className="text-xs font-medium text-rce-accent"
                    onClick={() => {
                      setEditingId(editingId === tech.id ? null : tech.id);
                      setEditEmployeeNumber(tech.employeeNumber ?? "");
                    }}
                  >
                    {editingId === tech.id ? "Cancel" : "Edit emp #"}
                  </button>
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
              {editingId === tech.id && (
                <form
                  className="mt-2 flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    updateMutation.mutate({
                      technicianId: tech.id,
                      employeeNumber: editEmployeeNumber.trim() || null,
                    });
                  }}
                >
                  <label className="text-xs font-medium">
                    Employee #
                    <input
                      className="field mt-1"
                      value={editEmployeeNumber}
                      onChange={(e) => setEditEmployeeNumber(e.target.value)}
                      placeholder="RCE-01"
                    />
                  </label>
                  <button className="btn btn-primary text-xs" type="submit" disabled={updateMutation.isPending}>
                    Save
                  </button>
                </form>
              )}
              {revealedTokenId === tech.id && (
                <p className="mt-2 break-all rounded bg-rce-accentBg/40 p-2 font-mono text-xs">
                  {tech.accessToken}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
