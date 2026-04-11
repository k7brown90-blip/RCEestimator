import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  getEnumOptions,
  getEstimatorParameterDefinitions,
  getInitialParameterFormValues,
  serializeParameterPayload,
  validateParameterForm,
  type ParameterFormValues,
} from "../lib/assemblyParameters";
import { categoryLabels, money } from "../lib/utils";

type Props = {
  open: boolean;
  mode: string;
  title?: string;
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (input: { assemblyTemplateId: string; location?: string; quantity: number; notes?: string; parameters?: Record<string, unknown> }) => Promise<void>;
};

export function AssemblyPicker({
  open,
  mode,
  title = "Add Assembly",
  submitLabel = "Add to Option",
  onClose,
  onSubmit,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [parameterValues, setParameterValues] = useState<ParameterFormValues>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    data = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["assemblies", query],
    queryFn: () => api.assemblies({ query }),
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      void refetch();
    }
  }, [open, refetch]);

  const categories = useMemo(() => {
    const grouped: Record<string, typeof data> = {};
    for (const item of data) {
      const key = item.category ?? "support";
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(item);
    }
    return grouped;
  }, [data]);

  const suggested = useMemo(() => {
    if (mode === "service_diagnostic") {
      return data.filter((item) => [1, 2, 3, 17, 18, 22].includes(item.assemblyNumber)).slice(0, 6);
    }
    if (mode === "remodel") {
      return data.filter((item) => [6, 7, 11, 13, 14, 75].includes(item.assemblyNumber)).slice(0, 6);
    }
    return data.slice(0, 6);
  }, [data, mode]);

  const selected = data.find((item) => item.id === selectedId) ?? null;
  const parameterDefinitions = useMemo(
    () => getEstimatorParameterDefinitions(selected?.parameterDefinitions),
    [selected?.parameterDefinitions],
  );

  const variantTags = useMemo(
    () => (selected?.variants ?? []).filter((variant) => Boolean(variant.variantValue)),
    [selected?.variants],
  );

  if (!open) {
    return null;
  }

  const resetSelection = () => {
    setSelectedId(null);
    setLocation("");
    setNotes("");
    setQuantity(1);
    setParameterValues({});
    setFieldErrors({});
    setSubmitError("");
    setIsSubmitting(false);
  };

  const handleSelect = (nextId: string) => {
    const template = data.find((item) => item.id === nextId);
    setSelectedId(nextId);
    setParameterValues(getInitialParameterFormValues(template?.parameterDefinitions));
    setFieldErrors({});
    setSubmitError("");
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/35 p-3 md:p-6" onClick={onClose}>
      <div className="mx-auto flex h-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-card" onClick={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between border-b border-rce-border px-4 py-3">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button className="btn btn-secondary" type="button" onClick={onClose}>Close</button>
        </div>

        {!selected ? (
          <div className="flex-1 space-y-4 overflow-auto p-4">
            <input className="field" placeholder="Search assemblies..." value={query} onChange={(event) => setQuery(event.target.value)} />
            {!isLoading && !isError ? (
              <p className="text-xs text-rce-soft">Showing {data.length} assemblies.</p>
            ) : null}

            <section>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-rce-soft">Suggested</p>
              <div className="grid gap-2">
                {suggested.map((item) => (
                  <button key={item.id} type="button" className="card flex items-center justify-between p-3 text-left" onClick={() => handleSelect(item.id)}>
                    <span>
                      <span className="mono text-xs text-rce-soft">#{item.assemblyNumber}</span> {item.name}
                    </span>
                    <span className="text-xs text-rce-muted">{item.tier}</span>
                  </button>
                ))}
              </div>
            </section>

            {isLoading ? <p className="text-sm text-rce-muted">Loading catalog...</p> : null}

            {isError ? (
              <p className="rounded-lg border border-rce-danger/30 bg-red-50 p-3 text-sm text-rce-danger">
                Failed to load assemblies. Check API connection and try again.
                {error instanceof Error ? ` (${error.message})` : ""}
              </p>
            ) : null}

            {!isLoading && !isError && data.length === 0 ? (
              <p className="rounded-lg border border-rce-border bg-rce-bg p-3 text-sm text-rce-muted">
                No assemblies are currently available. The catalog may still be initializing. Refresh in a few seconds and try again.
              </p>
            ) : null}

            {Object.entries(categories).map(([category, items]) => (
              <section key={category}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-rce-soft">{categoryLabels[category] ?? category}</p>
                <div className="grid gap-2">
                  {items.map((item) => (
                    <button key={item.id} type="button" className="card flex items-center justify-between p-3 text-left" onClick={() => handleSelect(item.id)}>
                      <span>
                        <span className="mono text-xs text-rce-soft">#{item.assemblyNumber}</span> {item.name}
                      </span>
                      <span className="text-xs text-rce-muted">{item.tier}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <form
            className="flex-1 space-y-4 overflow-auto p-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setSubmitError("");

              const formErrors = validateParameterForm(parameterDefinitions, parameterValues);
              setFieldErrors(formErrors);
              if (Object.keys(formErrors).length > 0) {
                return;
              }

              const parameterPayload = serializeParameterPayload(parameterDefinitions, parameterValues);
              if (parameterDefinitions.length === 0 && notes.trim()) {
                parameterPayload.notes = notes.trim();
              }

              setIsSubmitting(true);
              try {
                await onSubmit({
                  assemblyTemplateId: selected.id,
                  location: location.trim() || undefined,
                  quantity,
                  notes: notes.trim() || undefined,
                  parameters: Object.keys(parameterPayload).length > 0 ? parameterPayload : undefined,
                });
                resetSelection();
                onClose();
              } catch (error) {
                const message = error instanceof Error ? error.message : "Failed to add assembly";
                setSubmitError(message);
              } finally {
                setIsSubmitting(false);
              }
            }}
          >
            <button type="button" className="text-sm text-rce-muted" onClick={resetSelection}>
              Back
            </button>
            <div>
              <p className="mono text-xs text-rce-soft">#{selected.assemblyNumber}</p>
              <h4 className="text-xl font-semibold">{selected.name}</h4>
              <p className="text-sm text-rce-muted">{selected.description ?? "No description provided."}</p>
            </div>

            {variantTags.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-rce-soft">Context Tags</p>
                <div className="flex flex-wrap gap-2">
                  {variantTags.map((variant) => (
                    <span key={variant.id} className="rounded-full border border-rce-border bg-rce-bg px-3 py-1 text-xs text-rce-muted">
                      {variant.variantKey}: {variant.variantValue}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <label className="block text-sm font-medium">
              Location
              <input className="field mt-1" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Kitchen" />
            </label>
            <label className="block text-sm font-medium">
              Quantity
              <input
                type="number"
                min={1}
                className="field mt-1"
                value={quantity}
                onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))}
              />
            </label>

            {parameterDefinitions.length > 0 ? (
              <section className="space-y-3 rounded-lg border border-rce-border p-3">
                <p className="text-sm font-semibold">Assembly Parameters</p>
                {parameterDefinitions.map((definition) => {
                  const enumOptions = getEnumOptions(definition);
                  const error = fieldErrors[definition.key];
                  const currentValue = parameterValues[definition.key];
                  const helperParts: string[] = [];
                  if (definition.helpText) {
                    helperParts.push(definition.helpText);
                  }
                  if (definition.unit) {
                    helperParts.push(`Unit: ${definition.unit}`);
                  }
                  if (definition.minValue !== null && definition.minValue !== undefined) {
                    helperParts.push(`Min ${definition.minValue}`);
                  }
                  if (definition.maxValue !== null && definition.maxValue !== undefined) {
                    helperParts.push(`Max ${definition.maxValue}`);
                  }

                  return (
                    <label key={definition.id} className="block text-sm font-medium">
                      {definition.label}{definition.required ? " *" : ""}

                      {definition.valueType === "enum" ? (
                        <select
                          className="field mt-1"
                          value={typeof currentValue === "string" ? currentValue : ""}
                          onChange={(event) => {
                            setParameterValues((previous) => ({ ...previous, [definition.key]: event.target.value }));
                            setFieldErrors((previous) => ({ ...previous, [definition.key]: "" }));
                          }}
                        >
                          <option value="">Select...</option>
                          {enumOptions.map((option) => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                      ) : null}

                      {definition.valueType === "boolean" ? (
                        <div className="mt-2 flex min-h-11 items-center gap-2 rounded-lg border border-rce-border px-3">
                          <input
                            id={`param-${definition.key}`}
                            type="checkbox"
                            checked={Boolean(currentValue)}
                            onChange={(event) => {
                              setParameterValues((previous) => ({ ...previous, [definition.key]: event.target.checked }));
                            }}
                          />
                          <span>Enabled</span>
                        </div>
                      ) : null}

                      {(definition.valueType === "string" || definition.valueType === "number" || definition.valueType === "integer") ? (
                        <input
                          type={definition.valueType === "string" ? "text" : "number"}
                          className="field mt-1"
                          value={typeof currentValue === "string" ? currentValue : ""}
                          step={definition.valueType === "integer" ? 1 : "any"}
                          min={definition.minValue ?? undefined}
                          max={definition.maxValue ?? undefined}
                          onChange={(event) => {
                            setParameterValues((previous) => ({ ...previous, [definition.key]: event.target.value }));
                            setFieldErrors((previous) => ({ ...previous, [definition.key]: "" }));
                          }}
                        />
                      ) : null}

                      {helperParts.length > 0 ? (
                        <p className="mt-1 text-xs text-rce-soft">{helperParts.join(" | ")}</p>
                      ) : null}
                      {error ? <p className="mt-1 text-xs text-rce-danger">{error}</p> : null}
                    </label>
                  );
                })}
              </section>
            ) : (
              <p className="rounded-lg bg-rce-accentBg p-3 text-xs text-rce-warning">No parameter input required for this assembly.</p>
            )}

            <label className="block text-sm font-medium">
              Notes
              <textarea className="field mt-1 min-h-24" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional" />
            </label>
            {parameterDefinitions.length > 0 ? (
              <p className="text-xs text-rce-soft">Notes are saved to the assembly record and appear in estimate data.</p>
            ) : null}

            {submitError ? <p className="rounded-lg border border-rce-danger/30 bg-red-50 p-3 text-sm text-rce-danger">{submitError}</p> : null}
            <p className="rounded-lg bg-rce-accentBg p-3 text-sm text-rce-warning">Estimated total shown after adding to option.</p>
            <div className="flex gap-2">
              <button className="btn btn-primary" type="submit" disabled={isSubmitting}>{isSubmitting ? "Saving..." : submitLabel}</button>
              <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
            </div>
            <p className="text-xs text-rce-soft">Mode: {mode} | A4 parameter-aware flow</p>
            <p className="text-xs text-rce-soft">Component preview available in estimate details after save.</p>
            <p className="text-xs text-rce-soft">
              Est. (×{quantity}): {money(
                quantity * selected.components.reduce((sum, part) => {
                  if (part.componentType === "labor") return sum + part.laborHours * part.laborRate * part.quantity;
                  return sum + part.quantity * part.unitCost;
                }, 0)
              )}
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
