/**
 * Email campaigns (Kyle, 2026-09-02): "set up an email campaigns tab...
 * attach the articles written and design and send out promotions."
 *
 * Two halves: the AUDIENCE (lists — the Storm Preparedness list carries every
 * account automatically plus hand-added leads) and the CAMPAIGNS (a block
 * composer: your words, article cards pulled live off the blog, promotion
 * blocks with a button). Preview and send render through the same server
 * function, so what you approve is what goes out. Sending runs paced in the
 * background — the page shows progress; unsubscribes are global and permanent.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import type { CampaignArticle, CampaignBlock, CampaignOverview } from "../lib/types";

type Campaign = CampaignOverview["campaigns"][number];

const STATUS_META: Record<Campaign["status"], { label: string; tone: string }> = {
  draft: { label: "draft", tone: "bg-zinc-200 text-zinc-700" },
  sending: { label: "sending…", tone: "bg-amber-100 text-amber-800" },
  sent: { label: "sent", tone: "bg-green-100 text-green-800" },
};

export function CampaignsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["campaignOverview"],
    queryFn: api.campaignOverview,
    // A sending campaign updates its counts as batches land.
    refetchInterval: (q) => (q.state.data?.campaigns.some((c) => c.status === "sending") ? 10_000 : false),
  });
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [creating, setCreating] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["campaignOverview"] });

  return (
    <div className="space-y-5 pb-24">
      <PageHeader
        title="Email Campaigns"
        subtitle="The audience, the composer, and what every send actually did"
        actions={
          <button className="btn btn-primary" type="button" onClick={() => { setEditing(null); setCreating(true); }}>
            + New campaign
          </button>
        }
      />

      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {error ? <p className="text-sm text-red-500">{(error as Error).message}</p> : null}

      {data && (
        <section className="card p-4">
          <h2 className="text-lg font-semibold">Audience</h2>
          {data.lists.map((l) => (
            <p key={l.id} className="mt-1 text-sm">
              <span className="font-medium">{l.name}</span>
              {" — reaches "}<b>{l.reach}</b>{" address(es)"}
              <span className="text-xs text-rce-muted">
                {" · "}{l.includeAllAccounts ? `every account with an email + ${l.manualMembers} added lead(s)` : `${l.manualMembers} member(s)`}
              </span>
            </p>
          ))}
          <p className="mt-1 text-xs text-rce-muted">
            Leads join from the Leads tab ("+ Email campaign"). Unsubscribed: {data.suppressedCount} — global and permanent, never re-added.
          </p>
        </section>
      )}

      {(creating || editing) && (
        <Composer
          campaign={editing}
          onDone={() => { setCreating(false); setEditing(null); refresh(); }}
        />
      )}

      <section className="space-y-2">
        {(data?.campaigns ?? []).map((c) => {
          const s = STATUS_META[c.status];
          return (
            <div key={c.id} className="card p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{c.name}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${s.tone}`}>{s.label}</span>
                    {c.fromArticle && <span className="rounded bg-rce-accentBg px-1.5 py-0.5 text-[11px] text-rce-accentDark">from the blog</span>}
                  </div>
                  <p className="text-sm text-rce-muted">"{c.subject}" · to {c.listName} · {c.blocks.length} block(s)</p>
                  {c.status !== "draft" && (
                    <p className="text-xs text-rce-muted">
                      {c.sentCount} sent · {c.failedCount} failed · {c.suppressedCount} suppressed
                      {c.sentAt ? ` · finished ${new Date(c.sentAt).toLocaleString()}` : ""}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {c.status === "draft" && (
                    <button className="btn btn-secondary text-xs" type="button" onClick={() => { setCreating(false); setEditing(c); }}>
                      Edit
                    </button>
                  )}
                  <SendControls campaign={c} onChanged={refresh} />
                </div>
              </div>
            </div>
          );
        })}
        {data && data.campaigns.length === 0 && !creating && (
          <p className="rounded-lg border border-dashed border-rce-border/60 p-6 text-center text-sm text-rce-soft">
            No campaigns yet — new blog posts draft themselves here, or start one with "+ New campaign".
          </p>
        )}
      </section>
    </div>
  );
}

function SendControls({ campaign, onChanged }: { campaign: Campaign; onChanged: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const test = useMutation({
    mutationFn: () => api.campaignTestSend(campaign.id),
    onSuccess: (r) => setNote(`Test sent to ${r.to}.`),
    onError: (err) => setNote((err as Error).message),
  });
  const send = useMutation({
    mutationFn: () => api.campaignSend(campaign.id),
    onSuccess: () => { setNote("Sending started — counts update as batches go out."); onChanged(); },
    onError: (err) => setNote((err as Error).message),
  });
  if (campaign.status === "sent") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button className="btn btn-secondary text-xs" type="button" disabled={test.isPending} onClick={() => test.mutate()}>
        {test.isPending ? "Sending…" : "Send test to me"}
      </button>
      <button
        className="btn btn-primary text-xs"
        type="button"
        disabled={send.isPending || campaign.status === "sending"}
        onClick={() => {
          if (window.confirm(`Send "${campaign.subject}" to the ${campaign.listName} audience? This emails real customers.`)) send.mutate();
        }}
      >
        {campaign.status === "sending" ? "Sending…" : "Send campaign"}
      </button>
      {note && <span className="text-xs text-rce-muted">{note}</span>}
    </div>
  );
}

function Composer({ campaign, onDone }: { campaign: Campaign | null; onDone: () => void }) {
  const [name, setName] = useState(campaign?.name ?? "");
  const [subject, setSubject] = useState(campaign?.subject ?? "");
  const [blocks, setBlocks] = useState<CampaignBlock[]>(campaign?.blocks ?? []);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(campaign?.id ?? null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const { data: articleData, error: articleError } = useQuery({
    queryKey: ["campaignArticles"],
    queryFn: api.campaignArticles,
    staleTime: 5 * 60_000,
  });

  const patch = (i: number, b: CampaignBlock) => setBlocks((bs) => bs.map((x, idx) => (idx === i ? b : x)));
  const remove = (i: number) => setBlocks((bs) => bs.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) =>
    setBlocks((bs) => {
      const j = i + dir;
      if (j < 0 || j >= bs.length) return bs;
      const next = [...bs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = useMutation({
    mutationFn: async () => {
      if (savedId) {
        await api.updateCampaign(savedId, { name, subject, blocks });
        return savedId;
      }
      const r = await api.createCampaign({ name, subject, blocks });
      return r.id;
    },
    onSuccess: (id) => { setSavedId(id); setError(null); },
    onError: (err) => setError((err as Error).message),
  });

  // Preview always saves first — the preview is the server's render of what's stored.
  const preview = useMutation({
    mutationFn: async () => {
      const id = await save.mutateAsync();
      return api.campaignPreview(id);
    },
    onSuccess: (r) => setPreviewHtml(r.html),
    onError: (err) => setError((err as Error).message),
  });

  useEffect(() => { setPreviewHtml(null); }, [blocks, subject]);

  return (
    <section className="card space-y-3 p-4">
      <h2 className="text-lg font-semibold">{campaign ? `Edit — ${campaign.name}` : "New campaign"}</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm font-medium">Campaign name
          <input className="field mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="September storm newsletter" />
        </label>
        <label className="text-sm font-medium">Email subject
          <input className="field mt-1 w-full" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Is your home ready for storm season?" />
        </label>
      </div>

      <div className="space-y-3">
        {blocks.map((b, i) => (
          <div key={i} className="rounded-lg border border-rce-border p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-rce-soft">
                {b.kind === "text" ? "Your words" : b.kind === "article" ? "Article card" : "Promotion"}
              </span>
              <span className="flex gap-2 text-xs">
                <button type="button" className="underline" onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="underline" onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="text-red-600 underline" onClick={() => remove(i)}>remove</button>
              </span>
            </div>
            {b.kind === "text" && (
              <textarea className="field w-full" rows={3} value={b.text} onChange={(e) => patch(i, { ...b, text: e.target.value })} placeholder="A few sentences in your voice…" />
            )}
            {b.kind === "article" && (
              <p className="text-sm"><b>{b.title}</b><br /><span className="text-rce-muted">{b.excerpt}</span></p>
            )}
            {b.kind === "promo" && (
              <div className="grid gap-2 md:grid-cols-2">
                <input className="field" value={b.headline} onChange={(e) => patch(i, { ...b, headline: e.target.value })} placeholder="Headline — $149 Storm-Season Assessment" />
                <input className="field" value={b.ctaLabel} onChange={(e) => patch(i, { ...b, ctaLabel: e.target.value })} placeholder="Button label — Book my assessment" />
                <input className="field md:col-span-2" value={b.text} onChange={(e) => patch(i, { ...b, text: e.target.value })} placeholder="The offer, in one or two sentences" />
                <input className="field md:col-span-2" value={b.ctaUrl} onChange={(e) => patch(i, { ...b, ctaUrl: e.target.value })} placeholder="Button link — https://… or tel:615-625-2163" />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-secondary text-xs" type="button" onClick={() => setBlocks((bs) => [...bs, { kind: "text", text: "" }])}>
          + Your words
        </button>
        <ArticlePicker
          articles={articleData?.articles ?? []}
          error={articleError ? (articleError as Error).message : null}
          onPick={(a) => setBlocks((bs) => [...bs, { kind: "article", articleId: a.id, title: a.title, excerpt: a.excerpt, url: a.url }])}
        />
        <button
          className="btn btn-secondary text-xs"
          type="button"
          onClick={() => setBlocks((bs) => [...bs, { kind: "promo", headline: "", text: "", ctaLabel: "Book my assessment", ctaUrl: "tel:615-625-2163" }])}
        >
          + Promotion
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-rce-border pt-3">
        <button className="btn btn-secondary text-sm" type="button" disabled={!name.trim() || !subject.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : savedId ? "Save draft" : "Create draft"}
        </button>
        <button className="btn btn-secondary text-sm" type="button" disabled={!name.trim() || !subject.trim() || blocks.length === 0 || preview.isPending} onClick={() => preview.mutate()}>
          {preview.isPending ? "Rendering…" : "Preview"}
        </button>
        <button className="btn text-sm" type="button" onClick={onDone}>Close</button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>

      {previewHtml && (
        <div className="rounded-lg border border-rce-border bg-white p-3">
          <p className="mb-2 text-xs text-rce-muted">Exactly what recipients see (the unsubscribe link is live in the real send):</p>
          <iframe title="Campaign preview" srcDoc={previewHtml} className="h-96 w-full rounded border border-rce-border/60 bg-white" />
        </div>
      )}
    </section>
  );
}

function ArticlePicker({ articles, error, onPick }: {
  articles: CampaignArticle[];
  error: string | null;
  onPick: (a: CampaignArticle) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button className="btn btn-secondary text-xs" type="button" onClick={() => setOpen((o) => !o)}>
        + Article from the blog
      </button>
      {open && (
        <div className="absolute z-20 mt-1 max-h-72 w-80 overflow-y-auto rounded-lg border border-rce-border bg-rce-surface p-2 shadow-card">
          {error && <p className="p-2 text-xs text-red-600">{error}</p>}
          {!error && articles.length === 0 && <p className="p-2 text-xs text-rce-muted">No published articles found.</p>}
          {articles.map((a) => (
            <button
              key={a.id}
              type="button"
              className="block w-full rounded p-2 text-left text-sm hover:bg-rce-accentBg/30"
              onClick={() => { onPick(a); setOpen(false); }}
            >
              <b>{a.title}</b>
              <span className="block text-xs text-rce-muted">
                {a.tag ? `${a.tag} · ` : ""}{a.publishedAt ? new Date(a.publishedAt).toLocaleDateString() : "unpublished date"}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
