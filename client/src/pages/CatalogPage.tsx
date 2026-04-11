import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { categoryLabels } from "../lib/utils";

export function CatalogPage() {
  const [query, setQuery] = useState("");
  const { data = [], isLoading } = useQuery({ queryKey: ["catalog", query], queryFn: () => api.assemblies({ query }) });

  const grouped = useMemo(() => {
    const map: Record<string, typeof data> = {};
    for (const item of data) {
      const key = item.category ?? "support";
      if (!map[key]) map[key] = [];
      map[key].push(item);
    }
    return map;
  }, [data]);

  return (
    <div>
      <PageHeader title="Assembly Catalog" subtitle="Read-only in Phase 1">
        <input className="field max-w-md" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assemblies..." />
      </PageHeader>

      {isLoading ? <p className="text-sm text-rce-muted">Loading catalog...</p> : null}

      <div className="space-y-5">
        {Object.entries(grouped).map(([category, items]) => (
          <section key={category} className="card p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-rce-soft">{categoryLabels[category] ?? category}</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {items.map((item) => (
                <article key={item.id} className="rounded-lg border border-rce-border p-3">
                  <p className="mono text-xs text-rce-soft">#{item.assemblyNumber} | {item.tier}</p>
                  <h3 className="font-semibold text-rce-text">{item.name}</h3>
                  <p className="mt-1 text-sm text-rce-muted">{item.description ?? "No description"}</p>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
