/**
 * Settings -> "Agent webhooks" (work order agent-team, TC4; work order C6b; Kyle only). Where the signed
 * agent events are sent and how: the receiving address and On/Off for each agent that listens (Admin and
 * Inventory), each agent's custom headers, its signing secret, a test button and its delivery log, plus a
 * table saying which agent gets which event type.
 *
 * Click path from the Dashboard: left nav "Settings" -> scroll to "Agent webhooks", under "Agent events"
 * (two clicks). Every control below sits on that agent's own block.
 *
 *   * Address: "Edit address", "Turn off" / "Turn on" and "Remove address" (the exit: the row stays, the
 *     address goes, and events are kept until a new one is set).
 *   * Signing secret: the line says which secret is in use ("Own secret ••••abcd" / "Using
 *     HUB_WEBHOOK_SECRET from Railway" / "No signing secret — events are kept, not sent"). "Generate
 *     signing secret" shows the new secret ONCE with "Copy"; "Regenerate" (after a confirm) replaces it at
 *     once; "Remove signing secret" is the exit.
 *   * Custom headers: "Add header" (name + value, e.g. Authorization: Bearer ...), then per header "Edit
 *     value" (re-enter it) and "Remove header". A value is shown only as •••• + its last four after the
 *     save; it is never sent back by the server.
 *   * "Send test event": one signed test.ping to that agent only; the card shows the HTTP status and the
 *     response time, or the error.
 *   * Recent events: that agent's newest events, the Agent events table filtered to it, with Show
 *     attempts and Resend.
 *   * The table at the bottom lists every event type with the agent it goes to; the dropdown re-points it.
 *
 * AGENT_KEY_PEPPER (Railway) encrypts the headers and secrets: with it unset the controls that store a
 * secret are greyed with "Set AGENT_KEY_PEPPER in Railway first.".
 *
 * Kyle only. Every other session (a login without his rights, the AI admin) sees the card with every
 * control GREYED and the reason printed, never hidden. All settings writes go through the one
 * owner-settings route (PUT /owner-settings/agentWebhooks).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useIsKyle, useSession, useSessionFailed } from "../lib/session";
import type { AgentWebhooksSave, AgentWebhooksValue, AgentWebhookTargetView } from "../lib/types";
import { AgentEventsTable, WEBHOOK_LOG_ROWS } from "./AgentEventsSection";
import {
  DEFAULT_EVENT_ROUTES, HUB_EVENT_LABELS, HUB_EVENT_TYPES, HUB_WEBHOOK_TARGET_IDS, HUB_WEBHOOK_TARGET_LABELS,
  type HubEventType, type HubWebhookTargetId,
} from "../../../shared/hub/events";
import {
  WEBHOOK_HEADERS_MAX, webhookHeaderNameProblem, webhookHeaderValueProblem,
} from "../../../shared/hub/webhookHeaders";

export const WEBHOOKS_LOCK_REASON = "Only Kyle can see or change where agent events go.";
export const NO_ADDRESS_TEXT = "No address — the agent will poll";
export const ENV_ADDRESS_TEXT = "Using HUB_AGENT_WEBHOOK_URL from Railway";
export const ENV_REFUSED_TEXT = "HUB_AGENT_WEBHOOK_URL in Railway is not an allowed https address, so it is ignored — the agent will poll";
export const ENV_REMOVE_REASON = "This address comes from HUB_AGENT_WEBHOOK_URL in Railway — remove it there, or press Turn off to stop sending.";
export const PEPPER_UNSET_REASON = "Set AGENT_KEY_PEPPER in Railway first.";
export const ENV_SECRET_TEXT = "Using HUB_WEBHOOK_SECRET from Railway";
export const NO_SECRET_TEXT = "No signing secret — events are kept, not sent";
export const REGENERATE_CONFIRM = "Regenerate the signing secret? The agents' receiver will reject events until it has the new one.";
export const HEADERS_FULL_REASON = `At most ${WEBHOOK_HEADERS_MAX} custom headers per agent — remove one first.`;

const EMPTY: AgentWebhooksValue = {
  targets: HUB_WEBHOOK_TARGET_IDS.map((id) => ({ id, url: null, enabled: true })),
  routes: {},
};

const QUERY_KEY = ["agentWebhooks"] as const;

type TestState = { ok: boolean; text: string } | "sending";

export function AgentWebhooksSection() {
  const queryClient = useQueryClient();
  const session = useSession();
  const sessionFailed = useSessionFailed();
  const isKyle = useIsKyle();
  const allowed = isKyle && session?.kind !== "ai-admin";
  const ready = allowed && (session !== null || sessionFailed);

  const { data, error: loadError } = useQuery({ queryKey: QUERY_KEY, queryFn: () => api.agentWebhooks(), enabled: ready });
  const { data: config } = useQuery({ queryKey: ["hubEventsConfig"], queryFn: () => api.hubEventsConfig(), enabled: ready });
  const value: AgentWebhooksValue = data?.value ?? EMPTY;
  const known = data !== undefined;
  const loadFailed = loadError !== null && loadError !== undefined;
  const pepperSet = data?.status?.pepperSet !== false;

  const [editing, setEditing] = useState<HubWebhookTargetId | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The signing secret just made: shown once, then gone. */
  const [shown, setShown] = useState<Partial<Record<HubWebhookTargetId, { secret: string; replaced: boolean }>>>({});
  const [copied, setCopied] = useState<Partial<Record<HubWebhookTargetId, boolean>>>({});
  /** Adding a header (name + value) on one agent, or re-entering the value of one. */
  const [headerForm, setHeaderForm] = useState<{ id: HubWebhookTargetId; kind: "add" | "edit"; name: string; value: string } | null>(null);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [tests, setTests] = useState<Partial<Record<HubWebhookTargetId, TestState>>>({});

  const targetOf = (id: HubWebhookTargetId): AgentWebhookTargetView => value.targets.find((t) => t.id === id) ?? { id, url: null, enabled: true };
  const headersOf = (id: HubWebhookTargetId) => targetOf(id).headers ?? [];
  const unknownReason: string | null = !allowed ? WEBHOOKS_LOCK_REASON : known ? null : loadFailed ? "Agent webhooks could not be loaded." : "Loading…";

  /** What the screen sends: each agent's address and On/Off, never a header unless this save changes the headers. */
  const toSave = (patch: Partial<Record<HubWebhookTargetId, { url?: string | null; enabled?: boolean; headers?: Array<{ name: string; value?: string }> }>> = {}, routes = value.routes): AgentWebhooksSave => ({
    targets: HUB_WEBHOOK_TARGET_IDS.map((id) => {
      const t = targetOf(id);
      const p = patch[id] ?? {};
      return { id, url: p.url !== undefined ? p.url : t.url, enabled: p.enabled !== undefined ? p.enabled : t.enabled, ...(p.headers ? { headers: p.headers } : {}) };
    }),
    routes,
  });

  async function save(next: AgentWebhooksSave, success: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveAgentWebhooks(next);
      queryClient.setQueryData(QUERY_KEY, saved);
      await queryClient.invalidateQueries({ queryKey: ["hubEventsConfig"] });
      setNotice(success);
      return true;
    } catch (e) {
      setNotice(null);
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveAddress(id: HubWebhookTargetId) {
    const url = draft.trim() === "" ? null : draft.trim();
    if (await save(toSave({ [id]: { url } }), url ? `${HUB_WEBHOOK_TARGET_LABELS[id]} address saved.` : `${HUB_WEBHOOK_TARGET_LABELS[id]} address removed.`)) setEditing(null);
  }

  async function setRoute(type: HubEventType, target: HubWebhookTargetId) {
    const routes = { ...value.routes };
    if (target === DEFAULT_EVENT_ROUTES[type]) delete routes[type];
    else routes[type] = target;
    await save(toSave({}, routes), `${type} now goes to ${HUB_WEBHOOK_TARGET_LABELS[target]}.`);
  }

  // ── custom headers ─────────────────────────────────────────────────────────────────────────────

  async function saveHeaders(id: HubWebhookTargetId, headers: Array<{ name: string; value?: string }>, success: string): Promise<boolean> {
    return save(toSave({ [id]: { headers } }), success);
  }

  async function submitHeader() {
    if (!headerForm) return;
    const { id, kind } = headerForm;
    const name = headerForm.name.trim();
    const val = headerForm.value.trim();
    const label = HUB_WEBHOOK_TARGET_LABELS[id];
    const problem = (kind === "add" ? webhookHeaderNameProblem(name) : null) ?? webhookHeaderValueProblem(val)
      ?? (kind === "add" && headersOf(id).some((h) => h.name.toLowerCase() === name.toLowerCase()) ? `${label} already has a "${name}" header — use Edit value.` : null);
    if (problem) {
      setHeaderError(problem);
      return;
    }
    const kept = headersOf(id).map((h) => ({ name: h.name }));
    const next = kind === "add"
      ? [...kept, { name, value: val }]
      : headersOf(id).map((h) => (h.name === name ? { name: h.name, value: val } : { name: h.name }));
    if (await saveHeaders(id, next, kind === "add" ? `${name} header saved on ${label}.` : `${name} header on ${label} updated.`)) {
      setHeaderForm(null);
      setHeaderError(null);
    }
  }

  // ── signing secret ─────────────────────────────────────────────────────────────────────────────

  async function generateSecret(id: HubWebhookTargetId) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const made = await api.generateWebhookSecret(id);
      setShown((s) => ({ ...s, [id]: { secret: made.secret, replaced: made.replaced } }));
      setCopied((c) => ({ ...c, [id]: false }));
      await Promise.all([queryClient.invalidateQueries({ queryKey: QUERY_KEY }), queryClient.invalidateQueries({ queryKey: ["hubEventsConfig"] })]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeSecret(id: HubWebhookTargetId) {
    setBusy(true);
    setError(null);
    try {
      await api.removeWebhookSecret(id);
      setShown(({ [id]: _gone, ...rest }) => rest);
      setNotice(`${HUB_WEBHOOK_TARGET_LABELS[id]} signing secret removed.`);
      await Promise.all([queryClient.invalidateQueries({ queryKey: QUERY_KEY }), queryClient.invalidateQueries({ queryKey: ["hubEventsConfig"] })]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ── test event ─────────────────────────────────────────────────────────────────────────────────

  async function sendTest(id: HubWebhookTargetId) {
    setTests((prev) => ({ ...prev, [id]: "sending" }));
    try {
      const r = await api.sendWebhookTest(id);
      const timing = r.ms !== null ? ` in ${r.ms} ms` : "";
      const text = r.event.status === "delivered"
        ? `Test delivered — HTTP ${r.statusCode ?? ""}${timing}.`
        : `Test failed — ${r.statusCode !== null ? `HTTP ${r.statusCode}` : "no answer"}${timing}.${r.error ? ` ${r.error}.` : ""}`;
      setTests((prev) => ({ ...prev, [id]: { ok: r.event.status === "delivered", text } }));
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["hubEvents"] }), queryClient.invalidateQueries({ queryKey: ["hubEventsConfig"] })]);
    } catch (e) {
      setTests((prev) => ({ ...prev, [id]: { ok: false, text: `Test not sent — ${(e as Error).message}` } }));
    }
  }

  return (
    <section className="card mt-5 p-6" aria-label="Agent webhooks">
      <h2 className="text-lg font-semibold">Agent webhooks</h2>
      <p className="mt-1 text-sm text-rce-muted">
        Where the signed agent events are sent. Each agent that listens has its own receiving address, its own signing secret and optional custom
        headers. Admin signs with HUB_WEBHOOK_SECRET from Railway until it has a secret of its own; Inventory has none until you generate one. With no
        address an event is kept in Agent events and the agent polls instead. Admin uses
        HUB_AGENT_WEBHOOK_URL from Railway when no address is saved here.
      </p>

      {!allowed && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="agent-webhooks-locked">
          {WEBHOOKS_LOCK_REASON}
        </p>
      )}
      {allowed && known && !pepperSet && (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="agent-webhooks-no-pepper">
          {PEPPER_UNSET_REASON} Custom headers and signing secrets are stored encrypted, so they cannot be added until it is set.
        </p>
      )}
      {notice && <p className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">{notice}</p>}
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}

      <div className="mt-4 grid gap-3">
        {HUB_WEBHOOK_TARGET_IDS.map((id) => {
          const t = targetOf(id);
          const label = HUB_WEBHOOK_TARGET_LABELS[id];
          const isEditing = editing === id;
          const adminEnv = id === "admin" && config?.adminEnvUrlSet === true;
          const adminEnvRefused = id === "admin" && config?.adminEnvUrlRefused === true;
          // Admin with no saved address is sending to the Railway variable when it is set: say so, and
          // keep "Remove address" greyed (there is nothing saved here to remove) with the reason.
          const fromRailway = t.url === null && adminEnv;
          const addressText = t.url ?? (adminEnv ? ENV_ADDRESS_TEXT : adminEnvRefused ? ENV_REFUSED_TEXT : NO_ADDRESS_TEXT);
          const hasAddress = t.url !== null || adminEnv;
          const headers = headersOf(id);
          const secretSource = t.secretSource ?? (id === "admin" && config?.secretSet === true ? "env" : "none");
          const secretText = secretSource === "own" ? `Own secret ${t.signingSecret?.masked ?? "••••"}` : secretSource === "env" ? ENV_SECRET_TEXT : NO_SECRET_TEXT;
          const secretReason = unknownReason ?? (!pepperSet ? PEPPER_UNSET_REASON : null);
          const test = tests[id];
          const testReason = unknownReason
            ?? (!hasAddress ? "Set a receiving address first."
              : !t.enabled ? `${label} is turned Off — turn it on first.`
              : secretSource === "none" ? "Generate a signing secret first."
              // The test decrypts the own secret and any custom header: that needs the pepper.
              : !pepperSet && (secretSource === "own" || headers.length > 0) ? PEPPER_UNSET_REASON
              : null);
          const once = shown[id];
          const form = headerForm?.id === id ? headerForm : null;
          return (
            <div key={id} className="rounded-md border border-rce-border p-3" data-testid={`webhook-target-${id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{label}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${t.enabled ? "bg-green-100 text-green-900" : "bg-gray-200 text-gray-800"}`}>
                  {t.enabled ? "On" : "Off"}
                </span>
                {!isEditing && (
                  <span className="mono break-all text-xs" data-testid={`webhook-address-${id}`}>
                    {!allowed || !known ? "" : addressText}
                  </span>
                )}
              </div>

              {isEditing ? (
                <form
                  className="mt-2 flex flex-wrap items-center gap-2"
                  onSubmit={(e) => { e.preventDefault(); if (!busy) void saveAddress(id); }}
                >
                  <input
                    className="field w-full max-w-lg"
                    type="url"
                    placeholder="https://…"
                    aria-label={`${label} receiving address`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    autoComplete="off"
                  />
                  <button className="btn btn-primary" type="submit" disabled={busy}>Save address</button>
                  <button className="btn btn-secondary" type="button" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button" className="btn btn-secondary" disabled={busy || unknownReason !== null} title={unknownReason ?? undefined}
                    onClick={() => { setEditing(id); setDraft(t.url ?? ""); setError(null); setNotice(null); }}
                  >
                    Edit address
                  </button>
                  <button
                    type="button" className="btn btn-secondary" disabled={busy || unknownReason !== null} title={unknownReason ?? undefined}
                    onClick={() => void save(toSave({ [id]: { enabled: !t.enabled } }), `${label} turned ${t.enabled ? "off" : "on"}.`)}
                  >
                    {t.enabled ? "Turn off" : "Turn on"}
                  </button>
                  <button
                    type="button" className="btn btn-secondary"
                    disabled={busy || unknownReason !== null || t.url === null}
                    title={unknownReason ?? (fromRailway ? ENV_REMOVE_REASON : t.url === null ? "There is no address to remove." : undefined)}
                    onClick={() => {
                      const after = adminEnv
                        ? "Admin's events will go to the Railway address (HUB_AGENT_WEBHOOK_URL) instead. Use Turn off to stop them."
                        : "Its events are kept until a new one is set.";
                      if (window.confirm(`Remove ${label}'s receiving address? ${after}`)) {
                        void save(toSave({ [id]: { url: null } }), `${label} address removed.`);
                      }
                    }}
                  >
                    Remove address
                  </button>
                </div>
              )}

              {/* ── signing secret ── */}
              <div className="mt-4 border-t border-rce-border pt-3" data-testid={`webhook-secret-${id}`}>
                <h3 className="text-sm font-semibold">Signing secret</h3>
                <p className="mt-1 text-xs" data-testid={`webhook-secret-status-${id}`}>{!allowed || !known ? "" : secretText}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {secretSource === "own" ? (
                    <>
                      <button
                        type="button" className="btn btn-secondary" disabled={busy || secretReason !== null} title={secretReason ?? undefined}
                        onClick={() => { if (window.confirm(REGENERATE_CONFIRM)) void generateSecret(id); }}
                      >
                        Regenerate
                      </button>
                      <button
                        type="button" className="btn btn-secondary" disabled={busy || unknownReason !== null} title={unknownReason ?? undefined}
                        onClick={() => {
                          const after = id === "admin" ? "Admin will sign with HUB_WEBHOOK_SECRET from Railway again." : "Its events will be kept, not sent, until it has one.";
                          if (window.confirm(`Remove ${label}'s own signing secret? ${after}`)) void removeSecret(id);
                        }}
                      >
                        Remove signing secret
                      </button>
                    </>
                  ) : (
                    <button
                      type="button" className="btn btn-secondary" disabled={busy || secretReason !== null} title={secretReason ?? undefined}
                      onClick={() => {
                        // Admin on HUB_WEBHOOK_SECRET: a new own secret replaces it at once, same effect as Regenerate.
                        if (secretSource !== "env" || window.confirm(REGENERATE_CONFIRM)) void generateSecret(id);
                      }}
                    >
                      Generate signing secret
                    </button>
                  )}
                </div>
                {once && (
                  <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3" data-testid={`webhook-secret-once-${id}`}>
                    <p className="text-xs font-semibold text-amber-900">{once.replaced ? `New ${label} signing secret` : `${label} signing secret`}</p>
                    <code className="mono mt-2 block break-all rounded-md border border-rce-border bg-white p-2 text-sm" data-testid={`webhook-secret-value-${id}`}>
                      {once.secret}
                    </code>
                    <p className="mt-2 text-xs text-amber-900">
                      This is the only time the secret is shown. Copy it into the agents' receiver now — it checks X-RCE-Signature with it. It cannot be shown
                      again; if it is lost, press Regenerate.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button" className="btn btn-secondary"
                        onClick={() => { void navigator.clipboard?.writeText(once.secret).then(() => setCopied((c) => ({ ...c, [id]: true })), () => setCopied((c) => ({ ...c, [id]: false }))); }}
                      >
                        {copied[id] ? "Copied" : "Copy"}
                      </button>
                      <button type="button" className="btn btn-primary" onClick={() => setShown(({ [id]: _gone, ...rest }) => rest)}>I've saved it</button>
                    </div>
                  </div>
                )}
              </div>

              {/* ── custom headers ── */}
              <div className="mt-4 border-t border-rce-border pt-3" data-testid={`webhook-headers-${id}`}>
                <h3 className="text-sm font-semibold">Custom headers</h3>
                <p className="mt-1 text-xs text-rce-muted">
                  Sent with every event to {label} (and every retry, Resend and test), beside X-RCE-Signature, X-RCE-Timestamp and X-RCE-Event-Id — for
                  example Authorization: Bearer … . A value is stored encrypted and shown only as its last four characters.
                </p>
                {headers.length === 0 && <p className="mt-2 text-xs text-rce-muted" data-testid={`webhook-headers-none-${id}`}>No custom headers.</p>}
                <ul className="mt-2 grid gap-2">
                  {headers.map((h) => (
                    <li key={h.name} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`webhook-header-${id}-${h.name}`}>
                      <span className="mono text-xs font-semibold">{h.name}</span>
                      <span className="mono text-xs" data-testid={`webhook-header-masked-${id}-${h.name}`}>{h.masked}</span>
                      <button
                        type="button" className="btn btn-secondary" disabled={busy || secretReason !== null} title={secretReason ?? undefined}
                        aria-label={`Edit value of ${h.name} on ${label}`}
                        onClick={() => { setHeaderForm({ id, kind: "edit", name: h.name, value: "" }); setHeaderError(null); setNotice(null); setError(null); }}
                      >
                        Edit value
                      </button>
                      <button
                        type="button" className="btn btn-secondary" disabled={busy || unknownReason !== null} title={unknownReason ?? undefined}
                        aria-label={`Remove header ${h.name} from ${label}`}
                        onClick={() => {
                          if (window.confirm(`Remove the ${h.name} header from ${label}? It will no longer be sent.`)) {
                            void saveHeaders(id, headers.filter((x) => x.name !== h.name).map((x) => ({ name: x.name })), `${h.name} header removed from ${label}.`);
                          }
                        }}
                      >
                        Remove header
                      </button>
                    </li>
                  ))}
                </ul>

                {form ? (
                  <form
                    className="mt-2 flex flex-wrap items-center gap-2"
                    onSubmit={(e) => { e.preventDefault(); if (!busy) void submitHeader(); }}
                  >
                    {form.kind === "add" ? (
                      <input
                        className="field w-48" placeholder="Header name" aria-label={`${label} header name`} autoComplete="off"
                        value={form.name} onChange={(e) => setHeaderForm({ ...form, name: e.target.value })}
                      />
                    ) : (
                      <span className="mono text-xs font-semibold">{form.name}</span>
                    )}
                    <input
                      className="field w-72" type="password" placeholder={form.kind === "add" ? "Header value" : "New value"}
                      aria-label={form.kind === "add" ? `${label} header value` : `New value for ${form.name} on ${label}`} autoComplete="new-password"
                      value={form.value} onChange={(e) => setHeaderForm({ ...form, value: e.target.value })}
                    />
                    <button className="btn btn-primary" type="submit" disabled={busy}>{form.kind === "add" ? "Save header" : "Save value"}</button>
                    <button className="btn btn-secondary" type="button" onClick={() => { setHeaderForm(null); setHeaderError(null); }}>Cancel</button>
                  </form>
                ) : (
                  <div className="mt-2">
                    <button
                      type="button" className="btn btn-secondary"
                      disabled={busy || secretReason !== null || headers.length >= WEBHOOK_HEADERS_MAX}
                      title={secretReason ?? (headers.length >= WEBHOOK_HEADERS_MAX ? HEADERS_FULL_REASON : undefined)}
                      aria-label={`Add header to ${label}`}
                      onClick={() => { setHeaderForm({ id, kind: "add", name: "", value: "" }); setHeaderError(null); setNotice(null); setError(null); }}
                    >
                      Add header
                    </button>
                    {allowed && known && headers.length >= WEBHOOK_HEADERS_MAX && <span className="ml-2 text-xs text-rce-muted">{HEADERS_FULL_REASON}</span>}
                  </div>
                )}
                {headerError && form && <p className="mt-2 text-xs text-red-800" data-testid={`webhook-header-error-${id}`}>{headerError}</p>}
              </div>

              {/* ── test event ── */}
              <div className="mt-4 border-t border-rce-border pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button" className="btn btn-secondary"
                    disabled={busy || test === "sending" || testReason !== null}
                    title={testReason ?? undefined}
                    aria-label={`Send test event to ${label}`}
                    onClick={() => void sendTest(id)}
                  >
                    {test === "sending" ? "Sending…" : "Send test event"}
                  </button>
                  {testReason && allowed && known && <span className="text-xs text-rce-muted" data-testid={`webhook-test-reason-${id}`}>{testReason}</span>}
                  {test && test !== "sending" && (
                    <span className={`text-xs ${test.ok ? "text-green-900" : "text-red-800"}`} data-testid={`webhook-test-result-${id}`}>{test.text}</span>
                  )}
                </div>
              </div>

              {/* ── this agent's delivery log: the Agent events table, filtered ── */}
              <div className="mt-4 border-t border-rce-border pt-3" data-testid={`webhook-log-${id}`}>
                <h3 className="text-sm font-semibold">Recent events to {label}</h3>
                <p className="mt-1 text-xs text-rce-muted">
                  The newest {WEBHOOK_LOG_ROWS}, from the Agent events log above. For the full list, pick {label} in its Agent filter.
                </p>
                <AgentEventsTable
                  target={id} limit={WEBHOOK_LOG_ROWS} allowed={allowed} lockReason={WEBHOOKS_LOCK_REASON} ready={ready}
                  emptyText={`No events sent to ${label} yet.`}
                />
              </div>
            </div>
          );
        })}
      </div>

      <h3 className="mt-5 text-sm font-semibold">Which agent gets which event</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-rce-border text-xs uppercase tracking-wide text-rce-muted">
              <th className="py-2 pr-3">Event</th><th className="pr-3">What it means</th><th>Goes to</th>
            </tr>
          </thead>
          <tbody>
            {HUB_EVENT_TYPES.map((type) => {
              const target = value.routes[type] ?? DEFAULT_EVENT_ROUTES[type];
              return (
                <tr key={type} className="border-b border-rce-border">
                  <td className="mono py-2 pr-3 text-xs">{type}</td>
                  <td className="pr-3 text-xs text-rce-muted">{HUB_EVENT_LABELS[type]}</td>
                  <td>
                    <select
                      className="field"
                      value={target}
                      disabled={busy || unknownReason !== null}
                      title={unknownReason ?? undefined}
                      aria-label={`Where ${type} goes`}
                      onChange={(e) => void setRoute(type, e.target.value as HubWebhookTargetId)}
                    >
                      {HUB_WEBHOOK_TARGET_IDS.map((id) => <option key={id} value={id}>{HUB_WEBHOOK_TARGET_LABELS[id]}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
