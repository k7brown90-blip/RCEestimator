/**
 * Read-only production check of the Stripe payment path (Kyle, 2026-09-01:
 * "Do a check on the stripe payment system to ensure we are good to take
 * payments in production.").
 *
 * Runs inside the container (`railway ssh "node dist/scripts/checkStripe.js"`)
 * so it sees the real STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and database.
 * It creates nothing and charges nothing: account + capabilities, webhook
 * endpoints (URL, status, events), balance, recent Checkout Sessions and
 * webhook events, and the Payment rows the webhook wrote — reconciled against
 * Stripe's own view of the same sessions.
 *
 * The key is Kyle's RESTRICTED live key (rk_live_…). Sections it is not
 * permitted to read report "not permitted" rather than failing the run.
 */

import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const money = (cents: number | null | undefined, cur = "usd") =>
  cents === null || cents === undefined ? "—" : `$${(cents / 100).toFixed(2)} ${cur.toUpperCase()}`;
const when = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16) : "—");
const EXPECTED_WEBHOOK_URL = `https://${process.env.RAILWAY_PUBLIC_DOMAIN ?? "rceestimator-production.up.railway.app"}/stripe/webhook`;
const HANDLED_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"];

let problems = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const warn = (msg: string) => console.log(`  ! ${msg}`);
const bad = (msg: string) => { problems += 1; console.log(`  ✗ ${msg}`); };

async function section<T>(title: string, fn: () => Promise<T>): Promise<T | null> {
  console.log(`\n── ${title}`);
  try {
    return await fn();
  } catch (err) {
    const e = err as { type?: string; code?: string; message?: string; statusCode?: number };
    if (e.statusCode === 403 || /permission|not have access|restricted/i.test(e.message ?? "")) {
      warn(`not permitted for this restricted key (${e.code ?? e.type ?? "403"}) — check in the Dashboard instead`);
    } else {
      bad(`${e.type ?? "error"}: ${e.message ?? String(err)}`);
    }
    return null;
  }
}

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const whsec = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  console.log("Stripe production check —", new Date().toISOString());

  console.log("\n── Configuration (container env)");
  if (!key) bad("STRIPE_SECRET_KEY is not set — every pay surface is hidden.");
  else if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) ok(`STRIPE_SECRET_KEY is a LIVE ${key.startsWith("rk_") ? "restricted" : "secret"} key (${key.slice(0, 8)}…, ${key.length} chars)`);
  else bad(`STRIPE_SECRET_KEY is not a live key (${key.slice(0, 8)}…) — payments would be test-mode.`);
  if (!whsec) bad("STRIPE_WEBHOOK_SECRET is not set — the webhook rejects every event, nothing gets recorded.");
  else if (whsec.startsWith("whsec_")) ok(`STRIPE_WEBHOOK_SECRET present (whsec_…, ${whsec.length} chars)`);
  else bad("STRIPE_WEBHOOK_SECRET does not look like a signing secret (whsec_…).");
  ok(`Expected webhook URL: ${EXPECTED_WEBHOOK_URL}`);
  if (!key) return;

  const stripe = new Stripe(key);

  await section("Account", async () => {
    // No id = the key's own account (/v1/account); the v22 typings only model the by-id form.
    const acct = await (stripe.accounts as unknown as { retrieve: () => Promise<Stripe.Account> }).retrieve();
    console.log(`  id ${acct.id} · ${acct.business_profile?.name ?? acct.settings?.dashboard?.display_name ?? "(no name)"} · country ${acct.country} · currency ${acct.default_currency}`);
    acct.charges_enabled ? ok("charges_enabled") : bad("charges_enabled is FALSE — the account cannot take payments");
    acct.payouts_enabled ? ok("payouts_enabled") : bad("payouts_enabled is FALSE — money cannot reach the bank");
    const caps = (acct.capabilities ?? {}) as Record<string, string>;
    for (const c of ["card_payments", "us_bank_account_ach_payments", "link_payments", "transfers"]) {
      if (c in caps) (caps[c] === "active" ? ok : warn)(`capability ${c}: ${caps[c]}`);
    }
    const due = acct.requirements?.currently_due ?? [];
    const past = acct.requirements?.past_due ?? [];
    if (past.length) bad(`requirements PAST DUE: ${past.join(", ")}`);
    else if (due.length) warn(`requirements currently due: ${due.join(", ")}`);
    else ok("no outstanding account requirements");
    if (acct.requirements?.disabled_reason) bad(`disabled_reason: ${acct.requirements.disabled_reason}`);
    const payout = acct.settings?.payouts?.schedule;
    if (payout) ok(`payout schedule: ${payout.interval}${payout.delay_days !== undefined ? ` (delay ${payout.delay_days}d)` : ""}`);
    const ext = await stripe.accounts.listExternalAccounts(acct.id, { limit: 3 }).catch(() => null);
    if (ext) {
      if (ext.data.length === 0) bad("no external bank account on file — payouts have nowhere to go");
      for (const b of ext.data) {
        const bank = b as { object: string; bank_name?: string; last4?: string; status?: string; default_for_currency?: boolean };
        ok(`payout ${bank.object}: ${bank.bank_name ?? ""} ••••${bank.last4 ?? "?"} status=${bank.status ?? "?"}${bank.default_for_currency ? " (default)" : ""}`);
      }
    }
  });

  await section("Webhook endpoints (Stripe's side)", async () => {
    const eps = await stripe.webhookEndpoints.list({ limit: 20 });
    if (eps.data.length === 0) bad("no webhook endpoints registered — payments would never be recorded in the app");
    let matched = false;
    for (const ep of eps.data) {
      const isOurs = ep.url === EXPECTED_WEBHOOK_URL;
      const line = `${ep.id} → ${ep.url} · status ${ep.status} · api ${ep.api_version ?? "account default"} · events ${ep.enabled_events.length === 1 && ep.enabled_events[0] === "*" ? "ALL" : ep.enabled_events.length}`;
      if (isOurs) {
        matched = true;
        (ep.status === "enabled" ? ok : bad)(line + (ep.status === "enabled" ? "" : " — DISABLED"));
        const all = ep.enabled_events.includes("*");
        const missing = HANDLED_EVENTS.filter((e) => !all && !ep.enabled_events.includes(e));
        if (missing.length) bad(`endpoint does not send: ${missing.join(", ")}`);
        else ok(`sends every event the app handles (${HANDLED_EVENTS.join(", ")})`);
      } else {
        warn(`other endpoint: ${line}`);
      }
    }
    if (!matched) bad(`no endpoint points at ${EXPECTED_WEBHOOK_URL}`);
  });

  await section("Balance", async () => {
    const bal = await stripe.balance.retrieve();
    for (const a of bal.available) ok(`available ${money(a.amount, a.currency)}`);
    for (const p of bal.pending) ok(`pending ${money(p.amount, p.currency)}`);
    if (bal.available.length === 0 && bal.pending.length === 0) ok("balance is zero (nothing collected yet)");
  });

  const sessions = await section("Recent Checkout Sessions (last 10)", async () => {
    const list = await stripe.checkout.sessions.list({ limit: 10 });
    if (list.data.length === 0) warn("no Checkout Sessions have ever been created on this key");
    for (const s of list.data) {
      console.log(`  ${when(s.created)}  ${s.id}  ${s.status}/${s.payment_status}  ${money(s.amount_total, s.currency ?? "usd")}  inv ${s.metadata?.estimateNumber ?? "—"} ${s.metadata?.kind ?? ""}  ${s.customer_details?.email ?? s.customer_email ?? ""}`);
    }
    return list.data;
  });

  await section("Recent webhook deliveries (Stripe events, last 15)", async () => {
    const ev = await stripe.events.list({ limit: 15, types: ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "payment_intent.succeeded", "payment_intent.payment_failed", "charge.succeeded"] });
    if (ev.data.length === 0) warn("no payment events yet on this account");
    for (const e of ev.data) {
      const obj = e.data.object as { id?: string; amount_total?: number; amount?: number; currency?: string };
      const pend = e.pending_webhooks;
      (pend > 0 ? warn : ok)(`${when(e.created)}  ${e.type}  ${obj.id ?? ""}  ${money(obj.amount_total ?? obj.amount ?? null, obj.currency ?? "usd")}  pending_webhooks=${pend}${pend > 0 ? " (a delivery has not been acknowledged yet)" : ""}`);
    }
  });

  await section("App-side Payment rows (webhook fulfilment) — reconciliation", async () => {
    const rows = await prisma.payment.findMany({ where: { method: "stripe" }, orderBy: { createdAt: "desc" }, take: 20 });
    if (rows.length === 0) warn("no Stripe Payment rows in the database yet — no live payment has been recorded by the webhook");
    for (const r of rows) {
      console.log(`  ${r.createdAt.toISOString().slice(0, 16).replace("T", " ")}  ${r.stripeSessionId ?? "—"}  ${r.kind}/${r.status}  $${r.amount.toFixed(2)}  est ${r.estimateId ?? "—"}`);
    }
    if (sessions) {
      const paidSessions = sessions.filter((s) => s.payment_status === "paid");
      const byId = new Map(rows.map((r) => [r.stripeSessionId, r]));
      let missing = 0;
      for (const s of paidSessions) {
        const row = byId.get(s.id);
        if (!row) { missing += 1; bad(`PAID session ${s.id} (${money(s.amount_total, s.currency ?? "usd")}, inv ${s.metadata?.estimateNumber ?? "?"}) has NO Payment row — the webhook did not record it`); }
        else if (row.status !== "paid") bad(`session ${s.id} is paid at Stripe but the Payment row says ${row.status}`);
      }
      if (paidSessions.length > 0 && missing === 0) ok(`every paid session in the last 10 has a matching paid Payment row (${paidSessions.length})`);
    }
    const events = await prisma.systemEvent.findMany({
      where: { source: "stripe" }, orderBy: { createdAt: "desc" }, take: 10,
    }).catch(() => [] as Array<{ createdAt: Date; level: string; message: string }>);
    if (events.length) {
      console.log("  recent app-side stripe events:");
      for (const e of events) console.log(`    ${e.createdAt.toISOString().slice(0, 16).replace("T", " ")}  ${e.level}  ${e.message}`);
    }
  });

  await section("Signed, unpaid invoices that could be paid right now", async () => {
    const ests = await prisma.issuedEstimate.findMany({
      where: { signedAt: { not: null }, status: { not: "void" } },
      select: { id: true, number: true, token: true, total: true, customerEmail: true, signedAt: true },
      orderBy: { signedAt: "desc" }, take: 8,
    });
    if (ests.length === 0) warn("no signed estimates on file");
    for (const e of ests) {
      const paid = await prisma.payment.aggregate({ where: { estimateId: e.id, status: "paid" }, _sum: { amount: true } });
      const { paymentSummary } = await import("../src/services/stripePayments");
      const summary = await paymentSummary(prisma, e.id, "https://unused.invalid");
      const billed = summary?.billedTotal ?? e.total;
      console.log(`  ${e.number}  signed ${e.signedAt?.toISOString().slice(0, 10)}  BILLED $${billed.toFixed(2)}${Math.abs(billed - e.total) > 0.005 ? ` (full scope $${e.total.toFixed(2)} — customer took fewer options)` : ""}  paid $${(paid._sum.amount ?? 0).toFixed(2)}  pay link https://${process.env.RAILWAY_PUBLIC_DOMAIN}/pay/${e.token}`);
    }
  });

  console.log(`\n${problems === 0 ? "RESULT: no blocking problems found." : `RESULT: ${problems} blocking problem(s) — see ✗ lines.`}`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
