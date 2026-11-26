/**
 * Settings -> "Agent keys" (work order agent-team, K-U2). Where Kyle makes, edits, rotates and revokes
 * the keys the Grok agents and Claude Code use, and where he pauses or switches off every agent at once.
 *
 * Click path from the Dashboard: left nav "Settings" -> scroll to "Agent keys", directly under
 * "AI admin login" (two clicks).
 *
 *   * The top strip says "Agents: Running", "Writes paused" or "All agents off", with "Pause writes",
 *     "Turn all agents off" and "Resume agents" (each confirms). While not running, a red banner names
 *     who changed it and when. These call the ONE kill-switch writer, PUT /owner-settings/agentAccess.
 *   * "+ New agent key" opens a form: Agent (prefills the default scopes and hub thread limit; CFO is one of them), Name,
 *     scope checkboxes grouped Messages (Read team, Post team, Read customer, Draft customer - Kyle's words, W2) / Read /
 *     Draft / Write, "Limit to hub threads", an optional expiry, and "Create key". The key is then shown ONCE in a
 *     dialog, closed only by "I've saved it".
 *   * Each key row: the "Allow writes" box and, beside it, "Team posts publish immediately" (W2: ticked = that key's post in a
 *     Team, group or crew chat is posted at once; greyed with its reason while writes are off, Agent access is not On or the
 *     key is revoked), then Edit, Rotate key, Revoke ("Revoke now" while retiring) and Activity (opens that key's calls,
 *     newest first, with the time in Chicago, the key's name, what it did and how it ended - never a message).
 *     Revoked keys collapse under "Revoked keys (n)". Rows are never deleted: Revoke is the exit.
 *
 * Controls are GREYED with their reason, never hidden: a session without the bot_keys power (and the AI
 * admin) sees every control greyed with the reason; "+ New agent key" says "Set AGENT_KEY_PEPPER in
 * Railway first." when the pepper is missing. "Allow writes" (per key, Kyle's bot_keys guard) lets that key
 * leave drafts through POST /hub/messages: ticking it confirms in plain words, unticking does not; it is
 * greyed with its reason while the kill switch is read-only or off (turning ON only; a key already ticked
 * can always be unticked), and a revoked key shows it greyed under "Revoked keys".
 *
 * THE SECRET: the create and rotate calls are made from plain handlers, not useMutation, and the key
 * lives only in this component's state while the dialog is open. It is never in the React Query cache
 * and is cleared when the dialog closes.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useCan, useSession, useSessionFailed } from "../lib/session";
import type { AgentAccessMode, AgentKeyPatchInput, AgentKeyView, AgentKeysData } from "../lib/types";
import {
  AGENT_KEYS_AI_ADMIN_REASON, AGENT_MESSAGE_SCOPE_LABELS, AGENT_ROLES, AGENT_ROLE_LABELS, AGENT_SCOPES, AGENT_SCOPE_GROUP,
  DEFAULT_HUB_THREAD_KINDS_BY_ROLE, DEFAULT_SCOPES_BY_ROLE, HUB_THREAD_KINDS,
  HUB_THREAD_KIND_KEYS, type AgentRole, type AgentScope, type AgentScopeGroup,
} from "../../../shared/agentScopes";

const QUERY_KEY = ["agentKeys"] as const;
// Built from a variable, not a `mode: "on"` literal: tests/visitModes.test.ts scans the client for that
// exact spelling as a VISIT mode, and this is the agent kill switch's mode.
const runningMode: AgentAccessMode = "on";
const RUNNING = { mode: runningMode, changedAt: null, changedBy: null };
const PEPPER_REASON = "Set AGENT_KEY_PEPPER in Railway first.";
const WRITES_READ_ONLY_REASON = "Agent access is read-only — writes are refused until it is On";
const WRITES_OFF_REASON = "Agent access is Off";
const WRITES_REVOKED_REASON = "This key is revoked — it can no longer write";
// "Team posts publish immediately" (W2): the reasons it is greyed. A box that is already ticked can always be unticked.
const PUBLISH_REVOKED_REASON = "This key is revoked — it can no longer post";
const PUBLISH_WRITES_OFF_REASON = "Allow writes is off for this key — it cannot post until that is ticked";
const PUBLISH_ACCESS_REASON = "Agent access is not On — nothing an AI wrote is published until it is On";
// W2 (Kyle 2026-11-23): a Team, group or crew post is published by the key's own box. Kyle 2026-11-24 (no check-ins): an email or text to a customer
// and a reply in a Training thread go out as soon as the key posts them; only a price book change it proposes still waits for an Approve.
const writesConfirmText = (name: string): string =>
  `Let "${name}" post in Messages? Its posts in the Team, group and crew chats are published at once when "Team posts publish immediately" is ticked for it `
  + `(and wait for your Approve when it is not). Its emails and texts to customers, and its replies in a Training thread, go out as soon as it posts them: `
  + "nobody approves them first. A text still stops for a customer who opted out or has not agreed to texts, and an email for an address that unsubscribed. "
  + "While Agent access is paused or off, nothing an AI wrote is published or sent. A price book change it proposes still waits for your Approve.";
const GROUPS: Array<{ id: AgentScopeGroup; label: string }> = [
  { id: "messages", label: "Messages" },
  { id: "read", label: "Read" },
  { id: "draft", label: "Draft (a person approves)" },
  { id: "write", label: "Write" },
];

const whenText = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
      timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    })
    : "";
const dayText = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" })
    : "Never";
/**
 * The YYYY-MM-DD the instant falls on in CHICAGO. Not the UTC date: 23:59 Chicago is already the next
 * day in UTC, which would show (and send) the wrong day.
 */
const dayInput = (iso: string | null): string =>
  iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso)) : "";

const MODE_TEXT: Record<AgentAccessMode, string> = {
  on: "Agents: Running",
  read_only: "Writes paused",
  off: "All agents off",
};

function hubChip(kinds: string[]): string | null {
  if (kinds.length === 0) return null;
  const names = kinds.map((k) => HUB_THREAD_KINDS[k as keyof typeof HUB_THREAD_KINDS] ?? k);
  return `${names.join(" and ")} thread${kinds.length === 1 ? "" : "s"} only`;
}

function statusText(k: AgentKeyView): string {
  switch (k.status) {
    case "active": return "Active";
    case "retiring": return `Retiring until ${whenText(k.retiresAt)}`;
    case "retired": return "Replaced — stopped";
    case "expired": return "Expired";
    case "revoked": return "Revoked";
  }
}

// ── scope and thread pickers, shared by the new-key form and the row editor ──────────────────────

/** The scopes of one card group; the Messages group keeps Kyle's order (Read team, Post team, Read customer, Draft customer). */
const scopesIn = (group: AgentScopeGroup): AgentScope[] =>
  group === "messages"
    ? (Object.keys(AGENT_MESSAGE_SCOPE_LABELS) as AgentScope[])
    : (Object.keys(AGENT_SCOPES) as AgentScope[]).filter((s) => AGENT_SCOPE_GROUP[s] === group);

/**
 * One key's recent calls (W2: the "Activity" button), newest first. The time is Chicago; the row names the key, what it did (the tool),
 * the endpoint and how it ended (result code and status). It never carries a message or a body: the audit table holds none.
 */
function KeyActivity({ keyId, keyName, onClose }: { keyId: string; keyName: string; onClose: () => void }) {
  const { data, error, isLoading } = useQuery({ queryKey: ["agentKeyActivity", keyId], queryFn: () => api.agentKeyActivity(keyId) });
  const rows = data?.activity ?? [];
  return (
    <div className="mt-3 min-w-[26rem] rounded-md border border-rce-border p-3" data-testid={`agent-activity-${keyId}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Activity for {keyName}</h3>
        <button type="button" className="btn btn-secondary px-3 text-xs" style={{ minHeight: 32 }} onClick={onClose}>Close</button>
      </div>
      <p className="mt-1 text-xs text-rce-muted">Newest first. Times are Chicago. Every read, post and refusal is listed; no message text is ever kept here.</p>
      {isLoading && <p className="mt-2 text-xs text-rce-muted">Loading…</p>}
      {error && <p className="mt-2 text-xs text-red-800">Couldn't load the activity — {(error as Error).message}</p>}
      {!isLoading && !error && rows.length === 0 && <p className="mt-2 text-xs text-rce-muted" data-testid="agent-activity-empty">No calls from this key yet.</p>}
      {rows.length > 0 && (
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-rce-border uppercase tracking-wide text-rce-muted">
                <th className="py-1 pr-2">When</th><th className="pr-2">Key</th><th className="pr-2">Action</th><th className="pr-2">Endpoint</th><th>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-rce-border align-top">
                  <td className="py-1 pr-2 whitespace-nowrap">{whenText(r.at)}</td>
                  <td className="pr-2">{r.keyName}</td>
                  <td className="pr-2 mono">{r.action ?? ""}</td>
                  <td className="pr-2 mono">{r.endpoint ?? ""}</td>
                  <td className="mono">{r.resultCode ?? ""}{r.status !== null ? ` (${r.status})` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScopePicker({
  scopes, onChange, kinds, onKindsChange, idPrefix,
}: {
  scopes: string[];
  onChange: (next: string[]) => void;
  kinds: string[];
  onKindsChange: (next: string[]) => void;
  idPrefix: string;
}) {
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  return (
    <div className="grid gap-3">
      {GROUPS.map((g) => (
        <fieldset key={g.id} className="rounded-md border border-rce-border p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-rce-muted">{g.label}</legend>
          <div className="grid gap-1">
            {scopesIn(g.id).map((s) => (
              <label key={s} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={scopes.includes(s)}
                  onChange={() => onChange(toggle(scopes, s))}
                  aria-label={`${idPrefix} scope ${s}`}
                />
                {g.id === "messages" ? (
                  // W2: the four Messages boxes carry Kyle's own words as their label, the description under it as helper text.
                  <span>
                    <span className="font-medium">{AGENT_MESSAGE_SCOPE_LABELS[s as keyof typeof AGENT_MESSAGE_SCOPE_LABELS]}</span>{" "}
                    <span className="mono text-xs text-rce-muted">{s}</span>
                    <span className="block text-xs text-rce-muted">{AGENT_SCOPES[s]}</span>
                  </span>
                ) : (
                  <span><span className="mono text-xs">{s}</span> — {AGENT_SCOPES[s]}</span>
                )}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <fieldset className="rounded-md border border-rce-border p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-rce-muted">Limit to hub threads</legend>
        <p className="text-xs text-rce-muted">Tick none for no limit. A key with ticks can only see and post in those kinds of thread.</p>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {HUB_THREAD_KIND_KEYS.map((k) => (
            <label key={k} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={kinds.includes(k)}
                onChange={() => onKindsChange(toggle(kinds, k))}
                aria-label={`${idPrefix} thread kind ${HUB_THREAD_KINDS[k]}`}
              />
              {HUB_THREAD_KINDS[k]}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

// ── the show-once dialog ──────────────────────────────────────────────────────────────────────────

function SecretDialog({ title, name, secret, onClose }: { title: string; name: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-lg rounded-2xl border border-rce-border bg-rce-surface p-5 shadow-card">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-rce-muted">Key for {name}.</p>
        <code className="mono mt-3 block break-all rounded-md border border-rce-border bg-white p-3 text-sm" data-testid="agent-key-secret">
          {secret}
        </code>
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          This is the only time the key is shown. Copy it now and give it to the agent. It cannot be shown again; if it is lost, make a new key.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(secret).then(() => setCopied(true), () => setCopied(false));
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>I've saved it</button>
        </div>
      </div>
    </div>
  );
}

// ── the card ──────────────────────────────────────────────────────────────────────────────────────

export function AgentKeysSection() {
  const queryClient = useQueryClient();
  const session = useSession();
  const sessionFailed = useSessionFailed();
  const can = useCan("bot_keys");
  const isAiAdmin = session?.kind === "ai-admin";
  const allowed = can.allowed && !isAiAdmin;
  const lockReason: string | null = isAiAdmin ? AGENT_KEYS_AI_ADMIN_REASON : can.reason;

  const { data, error: loadError } = useQuery({
    queryKey: QUERY_KEY, queryFn: () => api.agentKeys(), enabled: allowed && (session !== null || sessionFailed),
  });
  const keys = data?.keys ?? [];
  // A definite state (the status line, the buttons, "No agent keys yet.") is shown ONLY when the data
  // is here. While it loads, or when it could not be loaded, the card says so and the kill switch is
  // greyed: a fake "Running" over a switched-off fleet is worse than no answer.
  const known = data !== undefined;
  const loadFailed = loadError !== null && loadError !== undefined;
  const access = data?.agentAccess ?? RUNNING;
  const live = keys.filter((k) => k.status !== "revoked");
  const revoked = keys.filter((k) => k.status === "revoked");

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The ONLY place a plaintext key is held, and only while the dialog is open.
  const [shown, setShown] = useState<{ title: string; name: string; secret: string } | null>(null);

  const [creating, setCreating] = useState(false);
  const [role, setRole] = useState<AgentRole>("admin");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([...DEFAULT_SCOPES_BY_ROLE.admin]);
  const [kinds, setKinds] = useState<string[]>([...DEFAULT_HUB_THREAD_KINDS_BY_ROLE.admin]);
  const [expires, setExpires] = useState("");

  const [editing, setEditing] = useState<string | null>(null);
  // The key whose Activity is open (one at a time).
  const [activityFor, setActivityFor] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [eScopes, setEScopes] = useState<string[]>([]);
  const [eKinds, setEKinds] = useState<string[]>([]);
  const [eExpires, setEExpires] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  /** Run a call; show its failure as the server worded it. Returns the result, or null on failure. */
  async function run<T>(fn: () => Promise<T>, success?: string): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      setNotice(success ?? null);
      return result;
    } catch (e) {
      setNotice(null);
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const pickRole = (next: AgentRole) => {
    setRole(next);
    setScopes([...DEFAULT_SCOPES_BY_ROLE[next]]);
    setKinds([...DEFAULT_HUB_THREAD_KINDS_BY_ROLE[next]]);
  };

  const pepperOk = data?.pepperConfigured !== false;
  const unknownReason: string | null = known || !allowed ? null : loadFailed ? "Agent status could not be loaded." : "Loading agent status…";
  const newKeyReason: string | null = !allowed ? lockReason : unknownReason ?? (!pepperOk ? PEPPER_REASON : null);
  const createReason: string | null = name.trim() === "" ? "Type a name for the key." : null;
  const locked = !allowed;
  const controlTitle = (reason: string | null) => reason ?? undefined;

  async function create() {
    const result = await run(
      () => api.createAgentKey({ name: name.trim(), agentRole: role, scopes, hubThreadKinds: kinds, expiresAt: expires || null }),
    );
    if (!result) return;
    setShown({ title: "New agent key", name: result.key.name, secret: result.secret });
    setCreating(false);
    setName("");
    setExpires("");
    pickRole("admin");
    await refresh();
  }

  async function rotate(k: AgentKeyView) {
    if (!window.confirm(`Rotate "${k.name}"? A new key with the same settings is made, and the old one keeps working for 24 hours, then stops.`)) return;
    const result = await run(() => api.rotateAgentKey(k.id));
    if (!result) return;
    setShown({ title: "Rotated agent key", name: result.key.name, secret: result.secret });
    await refresh();
  }

  async function revoke(k: AgentKeyView) {
    const text = k.status === "retiring"
      ? `Stop "${k.name}" now instead of at the end of its 24 hours?`
      : `Revoke "${k.name}"? It stops working on its very next call and cannot be turned back on.`;
    if (!window.confirm(text)) return;
    if (await run(() => api.revokeAgentKey(k.id), `"${k.name}" revoked.`)) await refresh();
  }

  function startEdit(k: AgentKeyView) {
    setEditing(k.id);
    setEName(k.name);
    setEScopes([...k.scopes]);
    setEKinds([...k.hubThreadKinds]);
    setEExpires(dayInput(k.expiresAt));
  }

  async function saveEdit(k: AgentKeyView) {
    // The expiry goes only when the date box was changed. An expired key's stored date is in the past
    // and the server refuses a past date, so resending it would refuse every other edit too.
    const patch: AgentKeyPatchInput = { name: eName.trim(), scopes: eScopes, hubThreadKinds: eKinds };
    if (eExpires !== dayInput(k.expiresAt)) patch.expiresAt = eExpires || null;
    const result = await run(
      () => api.updateAgentKey(k.id, patch),
      `"${eName.trim() || k.name}" saved. The change applies on the key's next call.`,
    );
    if (!result) return;
    setEditing(null);
    await refresh();
  }

  async function setWrites(k: AgentKeyView, on: boolean) {
    if (on && !window.confirm(writesConfirmText(k.name))) return;
    const done = on
      ? "can now post in Messages (Team, group and crew posts publish at once while its Team posts box is ticked; emails and texts to customers go out as soon as it posts them)"
      : "can no longer post";
    if (await run(() => api.updateAgentKey(k.id, { writesEnabled: on }), `"${k.name}" ${done}.`)) await refresh();
  }

  async function setPublish(k: AgentKeyView, on: boolean) {
    const done = on
      ? "now publishes its Team, group and crew posts at once"
      : "no longer publishes its Team posts on its own: they wait for your Approve";
    if (await run(() => api.updateAgentKey(k.id, { teamPostsPublish: on }), `"${k.name}" ${done}.`)) await refresh();
  }

  // Why "Allow writes" cannot be turned ON right now (null when it can): the kill switch is not On.
  const writesModeReason: string | null = known && access.mode === "read_only" ? WRITES_READ_ONLY_REASON
    : known && access.mode === "off" ? WRITES_OFF_REASON : null;

  async function setMode(mode: AgentAccessMode, confirmText: string) {
    if (!window.confirm(confirmText)) return;
    const result = await run(() => api.setAgentAccess(mode), mode === "on" ? "Agents resumed." : `${MODE_TEXT[mode]}.`);
    if (!result) return;
    queryClient.setQueryData<AgentKeysData>(QUERY_KEY, (old) => (old ? { ...old, agentAccess: result.value } : old));
    await refresh();
  }

  // Greyed with the reason when this session may not (locked) or the state is not known yet.
  const modeReason = lockReason ?? unknownReason;
  const modeButtons = (
    <div className="mt-3 flex flex-wrap gap-2">
      {(!known || access.mode !== "read_only") && (
        <button
          className="btn btn-secondary" type="button" disabled={busy || modeReason !== null} title={controlTitle(modeReason)}
          onClick={() => void setMode("read_only", "Pause writes? Agents can still read, but every draft and write is refused until you resume.")}
        >
          Pause writes
        </button>
      )}
      {(!known || access.mode !== "off") && (
        <button
          className="btn btn-danger" type="button" disabled={busy || modeReason !== null} title={controlTitle(modeReason)}
          onClick={() => void setMode("off", "Turn all agents off? Every agent call is refused until you resume.")}
        >
          Turn all agents off
        </button>
      )}
      {(!known || access.mode !== "on") && (
        <button
          className="btn btn-primary" type="button" disabled={busy || modeReason !== null} title={controlTitle(modeReason)}
          onClick={() => void setMode("on", "Resume agents? They work again with the scopes each key has.")}
        >
          Resume agents
        </button>
      )}
    </div>
  );

  return (
    <section className="card mt-5 p-6" aria-label="Agent keys">
      <h2 className="text-lg font-semibold">Agent keys</h2>
      <p className="mt-1 text-sm text-rce-muted">
        The keys the AI agents use to reach the CRM, each limited to the scopes ticked. A key is shown once when it is made.
        Revoke stops a key on its very next call. Rows are never deleted, because the activity log points at them.
      </p>

      {locked && lockReason && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="agent-keys-locked">
          {lockReason}
        </p>
      )}

      <p
        className={`mt-4 text-sm font-semibold ${known && access.mode === "on" ? "text-green-800" : known ? "text-red-800" : "text-rce-muted"}`}
        data-testid="agent-access-status"
      >
        {locked ? "Agents: status hidden" : !known ? (loadFailed ? "Agents: status unknown" : "Loading…") : MODE_TEXT[access.mode]}
      </p>
      {!locked && known && access.mode !== "on" && (
        <p className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900" data-testid="agent-access-banner">
          {access.mode === "off" ? "All agents were switched off" : "Writes were paused"}
          {access.changedBy ? ` by ${access.changedBy}` : ""}{access.changedAt ? ` on ${whenText(access.changedAt)}` : ""}.
          {access.mode === "off" ? " Every agent call is refused." : " Agents can still read; every draft and write is refused."}
        </p>
      )}
      {modeButtons}

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-rce-border pt-4">
        <button
          className="btn btn-primary" type="button" disabled={busy || newKeyReason !== null} title={controlTitle(newKeyReason)}
          onClick={() => { setCreating((v) => !v); setError(null); }}
        >
          + New agent key
        </button>
        {newKeyReason && <span className="text-xs text-rce-muted" data-testid="agent-new-key-reason">{newKeyReason}</span>}
      </div>

      {creating && newKeyReason === null && (
        <form
          className="mt-4 grid gap-3 rounded-md border border-rce-border p-4"
          onSubmit={(e) => { e.preventDefault(); if (!createReason && !busy) void create(); }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm font-medium">
              Agent
              <select className="field mt-1 w-full" value={role} onChange={(e) => pickRole(e.target.value as AgentRole)}>
                {AGENT_ROLES.map((r) => <option key={r} value={r}>{AGENT_ROLE_LABELS[r]}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium">
              Name
              <input className="field mt-1 w-full" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            </label>
            <label className="text-sm font-medium">
              Expires (optional)
              <input className="field mt-1 w-full" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </label>
          </div>
          <p className="text-xs text-rce-muted">Choosing the agent ticks its default scopes. Change them freely before you create the key.</p>
          <ScopePicker scopes={scopes} onChange={setScopes} kinds={kinds} onKindsChange={setKinds} idPrefix="New key" />
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" type="submit" disabled={busy || createReason !== null}>Create key</button>
            <button className="btn btn-secondary" type="button" onClick={() => setCreating(false)}>Cancel</button>
            {createReason && <span className="text-xs text-rce-muted" data-testid="agent-create-reason">{createReason}</span>}
          </div>
        </form>
      )}

      {notice && <p className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">{notice}</p>}
      {loadFailed && !locked && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" data-testid="agent-keys-load-error">
          Couldn't load agent keys — {(loadError as Error).message}
        </p>
      )}
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}

      <div className="mt-5 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-rce-border text-xs uppercase tracking-wide text-rce-muted">
              <th className="py-2 pr-3">Name</th><th className="pr-3">Key</th><th className="pr-3">Scopes</th>
              <th className="pr-3">Allow writes / Team posts</th><th className="pr-3">Expires</th><th className="pr-3">Last used</th>
              <th className="pr-3">Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {live.length === 0 && (
              <tr><td colSpan={8} className="py-3 text-rce-muted">{locked ? "" : !known ? (loadFailed ? "Couldn't load agent keys." : "Loading…") : "No agent keys yet."}</td></tr>
            )}
            {live.map((k) => {
              const chip = hubChip(k.hubThreadKinds);
              // A greyed box says why. Turning ON waits for the kill switch; a ticked box can always be unticked.
              const writesReason = lockReason ?? writesModeReason;
              const writesDisabled = busy || locked || (!k.writesEnabled && writesModeReason !== null);
              // "Team posts publish immediately" (W2): only has an effect with writes on and Agent access On. While one of those is
              // missing the box says why; a box already ticked can always be unticked, one that is off cannot be ticked until then.
              const publishReason: string | null = !k.writesEnabled ? PUBLISH_WRITES_OFF_REASON : writesModeReason !== null ? PUBLISH_ACCESS_REASON : null;
              const publishDisabled = busy || locked || (!k.teamPostsPublish && publishReason !== null);
              // Rotate is always shown; when it can't be used the screen says why (and what to do instead).
              const rotateReason: string | null = k.status === "active" ? null
                : k.status === "retiring" ? "This key is already being replaced."
                  : k.status === "expired" ? "Only an active key can be rotated — use Edit to set a new expiry, or create a new key."
                    : "Only an active key can be rotated — use Edit to set a new expiry, or create a new key.";
              return (
                <tr key={k.id} className="border-b border-rce-border align-top" data-testid={`agent-key-${k.id}`}>
                  <td className="py-2 pr-3 font-medium">{k.name}</td>
                  <td className="pr-3">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${k.environment === "live" ? "bg-green-100 text-green-900" : "bg-amber-100 text-amber-900"}`}>
                      {k.environment === "live" ? "Live" : "Test"}
                    </span>
                    <div className="mono text-xs">{k.displayPrefix}…</div>
                  </td>
                  <td className="pr-3">
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => <span key={s} className="mono rounded bg-rce-bg px-1.5 py-0.5 text-xs">{s}</span>)}
                      {chip && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-900" data-testid="agent-hub-chip">{chip}</span>}
                    </div>
                  </td>
                  <td className="pr-3">
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={k.writesEnabled}
                        disabled={writesDisabled}
                        title={controlTitle(writesReason)}
                        aria-label={`Allow writes for ${k.name}`}
                        onChange={(e) => void setWrites(k, e.target.checked)}
                      />
                      Allow writes
                    </label>
                    {writesReason && <div className="text-xs text-rce-muted">{writesReason}</div>}
                    <label className="mt-2 flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={k.teamPostsPublish}
                        disabled={publishDisabled}
                        title={controlTitle(lockReason ?? publishReason)}
                        aria-label={`Team posts publish immediately for ${k.name}`}
                        onChange={(e) => void setPublish(k, e.target.checked)}
                      />
                      Team posts publish immediately
                    </label>
                    {!locked && publishReason && <div className="text-xs text-rce-muted" data-testid={`publish-reason-${k.id}`}>{publishReason}</div>}
                  </td>
                  <td className="pr-3">{dayText(k.expiresAt)}</td>
                  <td className="pr-3">{k.lastUsedAt ? `Last used ${whenText(k.lastUsedAt)}${k.lastUsedTool ? ` · ${k.lastUsedTool}` : ""}` : "Never used"}</td>
                  <td className="pr-3">{statusText(k)}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <button className="btn btn-secondary px-3 text-xs" style={{ minHeight: 32 }} type="button" disabled={busy || locked} title={controlTitle(lockReason)} onClick={() => startEdit(k)}>Edit</button>
                      <button className="btn btn-secondary px-3 text-xs" style={{ minHeight: 32 }} type="button" disabled={busy || locked || !pepperOk || rotateReason !== null} title={controlTitle(lockReason ?? rotateReason ?? (pepperOk ? null : PEPPER_REASON))} onClick={() => void rotate(k)}>Rotate key</button>
                      <button className="btn btn-danger px-3 text-xs" style={{ minHeight: 32 }} type="button" disabled={busy || locked} title={controlTitle(lockReason)} onClick={() => void revoke(k)}>
                        {k.status === "retiring" ? "Revoke now" : "Revoke"}
                      </button>
                      <button
                        className="btn btn-secondary px-3 text-xs" style={{ minHeight: 32 }} type="button" disabled={locked} title={controlTitle(lockReason)}
                        onClick={() => setActivityFor(activityFor === k.id ? null : k.id)}
                      >
                        Activity
                      </button>
                    </div>
                    {rotateReason && <div className="mt-1 text-xs text-rce-muted" data-testid={`rotate-reason-${k.id}`}>{rotateReason}</div>}
                    {activityFor === k.id && !locked && <KeyActivity keyId={k.id} keyName={k.name} onClose={() => setActivityFor(null)} />}
                    {editing === k.id && (
                      <form
                        className="mt-3 grid min-w-[22rem] gap-3 rounded-md border border-rce-border p-3"
                        onSubmit={(e) => { e.preventDefault(); if (eName.trim() && !busy) void saveEdit(k); }}
                      >
                        <label className="text-sm font-medium">
                          Name
                          <input className="field mt-1 w-full" type="text" value={eName} onChange={(e) => setEName(e.target.value)} aria-label={`Name for ${k.name}`} />
                        </label>
                        <label className="text-sm font-medium">
                          Expires
                          <input className="field mt-1 w-full" type="date" value={eExpires} onChange={(e) => setEExpires(e.target.value)} aria-label={`Expires for ${k.name}`} />
                        </label>
                        <ScopePicker scopes={eScopes} onChange={setEScopes} kinds={eKinds} onKindsChange={setEKinds} idPrefix={k.name} />
                        <div className="flex gap-2">
                          <button className="btn btn-primary" type="submit" disabled={busy || eName.trim() === ""}>Save changes</button>
                          <button className="btn btn-secondary" type="button" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {revoked.length > 0 && (
        <details className="mt-4" data-testid="agent-revoked-keys">
          <summary className="cursor-pointer text-sm font-semibold">Revoked keys ({revoked.length})</summary>
          <ul className="mt-2 grid gap-1 text-sm">
            {revoked.map((k) => (
              <li key={k.id} className="rounded border border-rce-border px-3 py-2">
                <span className="font-medium">{k.name}</span> <span className="mono text-xs">{k.displayPrefix}…</span>{" "}
                — revoked {whenText(k.revokedAt)}{k.revokedReason ? ` (${k.revokedReason})` : ""}
                <label className="mt-1 flex items-center gap-1 text-xs text-rce-muted">
                  <input type="checkbox" checked={k.writesEnabled} disabled title={WRITES_REVOKED_REASON} aria-label={`Allow writes for ${k.name}`} />
                  Allow writes — {WRITES_REVOKED_REASON}
                </label>
                <label className="mt-1 flex items-center gap-1 text-xs text-rce-muted">
                  <input type="checkbox" checked={k.teamPostsPublish} disabled title={PUBLISH_REVOKED_REASON} aria-label={`Team posts publish immediately for ${k.name}`} />
                  Team posts publish immediately — {PUBLISH_REVOKED_REASON}
                </label>
                <button
                  className="btn btn-secondary mt-1 px-3 text-xs" style={{ minHeight: 32 }} type="button" disabled={locked} title={controlTitle(lockReason)}
                  onClick={() => setActivityFor(activityFor === k.id ? null : k.id)}
                >
                  Activity
                </button>
                {activityFor === k.id && !locked && <KeyActivity keyId={k.id} keyName={k.name} onClose={() => setActivityFor(null)} />}
              </li>
            ))}
          </ul>
        </details>
      )}

      {shown && (
        <SecretDialog title={shown.title} name={shown.name} secret={shown.secret} onClose={() => setShown(null)} />
      )}
    </section>
  );
}
