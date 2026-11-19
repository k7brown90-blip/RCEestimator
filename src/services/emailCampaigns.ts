/**
 * Email campaigns (Kyle, 2026-09-02): lists, the block composer's renderer,
 * and the paced sender.
 *
 * Kyle's rulings: leads are added by hand from the lead card; the default
 * "Storm Preparedness Campaign" list ALSO includes every customer account with
 * an email, resolved at send time (includeAllAccounts) so it is always
 * current; new blog posts auto-DRAFT a campaign (never auto-send); pressing
 * Send is a manual, attended act — no automation gate on it.
 *
 * CAN-SPAM: every marketing email carries the physical mailing address from
 * the company profile and a one-click unsubscribe (per-recipient token +
 * List-Unsubscribe header). Unsubscribes land in the GLOBAL suppression table
 * and every future send checks it. The test account never receives campaigns.
 */

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { sendBrandedEmail, escapeHtml, htmlToPlainText, brandedFooterHtml } from "./confirmationEmail";
import { getCompanyProfile, type CompanyProfile } from "./companyProfile";
import { publicBaseUrl } from "./issuedEstimateSend";
import { logSystemEvent } from "./systemEvents";

export const DEFAULT_LIST_NAME = "Storm Preparedness Campaign";

/*
  TWO PIPES (Kyle, 2026-09-02: "I already have resend set up").

  Campaigns prefer RESEND — a purpose-built bulk sender on the website's
  verified domain, so list traffic never spends the Gmail mailbox's budget or
  its reputation. Gmail remains the fallback (and the only pipe for
  transactional mail). Pacing per pipe:
    Resend: ~2 requests/sec, generous daily cap (RESEND_DAILY_CAP, default 1500)
            — 4,000 addresses ≈ 35 minutes of sending per capped day.
    Gmail:  15 per 45s, 300/day — the old safe numbers.
  A 429 from Resend (plan limit) stops the run cleanly: rows stay pending, the
  campaign stays "sending", and the next Send press resumes.
*/
const GMAIL_BATCH_SIZE = 15;
const GMAIL_BATCH_PAUSE_MS = 45_000;
const GMAIL_DAILY_CAP = 300;
const RESEND_PAUSE_MS = 600;
const RESEND_DAILY_CAP = Number(process.env.RESEND_DAILY_CAP ?? 1500);
const RESEND_FROM = process.env.RESEND_FROM ?? "Red Cedar Electric <news@redcedarelectricllc.com>"; // root domain is the VERIFIED one (Kyle, 2026-09-02)
const RESEND_REPLY_TO = process.env.RESEND_REPLY_TO ?? "service@redcedarelectricllc.com";

export function campaignTransport(): "resend" | "gmail" {
  return process.env.RESEND_API_KEY ? "resend" : "gmail";
}

/** One campaign email through Resend's HTTP API. Throws on 429 so the run can stop cleanly. */
async function sendViaResend(input: { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [input.to],
      reply_to: RESEND_REPLY_TO,
      subject: input.subject,
      html: input.html,
      // The plain-text twin (Kyle, 2026-09-09 deliverability; 2026-11-18 "add plain text" for campaigns):
      // campaigns used to be the one Resend send that went out HTML-only.
      text: input.text,
      headers: input.headers,
    }),
  });
  if (res.status === 429) {
    const err = new Error("Resend rate/plan limit reached (429)");
    (err as Error & { rateLimited?: boolean }).rateLimited = true;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend refused (${res.status}): ${body.slice(0, 300)}`);
  }
}

/**
 * The branded shell campaigns wear on the Resend pipe — same look as Gmail's (sendBrandedEmail): the
 * company name under the headline and the footer both come from Settings → Company profile, the same
 * builder, so one campaign reads the same on either pipe (Kyle, 2026-11-18, "Yes, company everywhere").
 * `headline` is PLAIN text (the subject) and is escaped here: once {first_name} is merged into the
 * subject it carries customer data (Kyle, 2026-11-18, "Yes, build it").
 */
export function wrapCampaignHtml(headline: string, bodyHtml: string, profile: CompanyProfile): string {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#333;">
      <div style="background:#1a5c2e;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:20px;">${escapeHtml(headline)}</h1>
        <p style="margin:4px 0 0;font-size:14px;opacity:0.9;">${escapeHtml(profile.legalName)}</p>
      </div>
      <div style="padding:20px 24px;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
        ${bodyHtml}
        ${brandedFooterHtml(profile)}
      </div>
    </div>`;
}

export type CampaignBlock =
  | { kind: "text"; text: string }
  | { kind: "article"; articleId: string; title: string; excerpt: string; url: string; imageUrl?: string | null }
  | { kind: "promo"; headline: string; text: string; ctaLabel: string; ctaUrl: string };

/** The default list exists from first touch — lazily, never as a migration side effect. */
export async function ensureDefaultList(prisma: PrismaClient) {
  return prisma.emailList.upsert({
    where: { name: DEFAULT_LIST_NAME },
    create: { name: DEFAULT_LIST_NAME, includeAllAccounts: true },
    update: {},
  });
}

/** Every address a campaign on this list would reach, suppression not yet applied. */
export async function resolveListRecipients(
  prisma: PrismaClient,
  listId: string,
): Promise<Array<{ email: string; name: string | null }>> {
  const list = await prisma.emailList.findUnique({
    where: { id: listId },
    include: { members: true },
  });
  if (!list) return [];
  const byEmail = new Map<string, { email: string; name: string | null }>();
  for (const m of list.members) {
    byEmail.set(m.email.toLowerCase(), { email: m.email, name: m.name });
  }
  if (list.includeAllAccounts) {
    const accounts = await prisma.customer.findMany({
      where: { email: { not: null }, isTestAccount: false },
      select: { email: true, name: true },
    });
    for (const a of accounts) {
      if (a.email) byEmail.set(a.email.toLowerCase(), { email: a.email, name: a.name });
    }
  }
  return [...byEmail.values()];
}

/**
 * {first_name} in a campaign (Kyle, 2026-11-18: "Yes, build it"). The first word of the recipient's
 * name — "John and Sandy Lewis" becomes "John" — and "there" when we have no name, so it only reads
 * right after a greeting ("Hi {first_name},"). No first-name column exists; names are one string.
 */
export function campaignFirstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || "there";
}

/** Swap the token on RAW text. Callers escape AFTER, so an apostrophe or a "<" in a name is never double-escaped or trusted. */
export function mergeFirstName(text: string, recipientName: string | null | undefined): string {
  return text.replaceAll("{first_name}", () => campaignFirstName(recipientName));
}

/**
 * Render the block stack to email HTML — the SAME function preview and send use (Kyle, 2026-09-02:
 * "what you approve is what goes out"). `recipientName` is the one thing that differs: the send passes
 * each row's stored name; preview and test send pass none and so show "there".
 */
export function renderCampaignHtml(
  blocks: CampaignBlock[],
  unsubscribeUrl: string,
  mailingAddress: string,
  recipientName?: string | null,
): string {
  const merge = (t: string) => mergeFirstName(t, recipientName);
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      parts.push(`<p style="font-size:15px;line-height:1.6;">${escapeHtml(merge(b.text)).replaceAll("\n", "<br>")}</p>`);
    } else if (b.kind === "article") {
      parts.push(`
        <div style="border:1px solid #ddd;border-radius:8px;overflow:hidden;margin:16px 0;">
          ${b.imageUrl ? `<img src="${escapeHtml(b.imageUrl)}" alt="" style="width:100%;display:block;">` : ""}
          <div style="padding:14px 16px;">
            <p style="margin:0;font-size:17px;font-weight:700;">${escapeHtml(b.title)}</p>
            <p style="margin:6px 0 10px;font-size:14px;color:#555;">${escapeHtml(b.excerpt)}</p>
            <a href="${escapeHtml(b.url)}" style="color:#1a5c2e;font-weight:600;font-size:14px;">Read the article →</a>
          </div>
        </div>`);
    } else if (b.kind === "promo") {
      // Headline and offer are optional (Kyle, 2026-11-18, "Tell admin + add plain text"): a Promotion with
      // only a Button label and link is the stand-alone button, so a blank line prints no empty <p>.
      // The button sits 14px under whichever line is last: the offer carries that gap, or the headline does when there is no offer.
      const promoHeadline = b.headline.trim()
        ? `<p style="margin:0 0 ${b.text.trim() ? "0" : "14px"};font-size:18px;font-weight:700;">${escapeHtml(merge(b.headline))}</p>`
        : "";
      const promoText = b.text.trim()
        ? `<p style="margin:${promoHeadline ? "8px" : "0"} 0 14px;font-size:14px;">${escapeHtml(merge(b.text))}</p>`
        : "";
      parts.push(`
        <div style="background:#f4f8f4;border-radius:8px;padding:18px 20px;margin:16px 0;text-align:center;">
          ${promoHeadline}
          ${promoText}
          <a href="${escapeHtml(b.ctaUrl)}"
             style="background:#1a5c2e;color:#fff;text-decoration:none;padding:12px 26px;border-radius:6px;font-size:15px;font-weight:600;display:inline-block;">
            ${escapeHtml(b.ctaLabel)}</a>
        </div>`);
    }
  }
  parts.push(`
    <p style="margin-top:28px;font-size:11px;color:#888;border-top:1px solid #eee;padding-top:10px;">
      Red Cedar Electric LLC · ${escapeHtml(mailingAddress)}<br>
      You're receiving this because you spoke with us or are a customer.
      <a href="${escapeHtml(unsubscribeUrl)}" style="color:#888;">Unsubscribe</a> — one click, effective immediately.
    </p>`);
  return parts.join("\n");
}

export async function isSuppressed(prisma: PrismaClient, email: string): Promise<boolean> {
  return Boolean(await prisma.emailSuppression.findUnique({ where: { email: email.toLowerCase() } }));
}

export async function suppressEmail(prisma: PrismaClient, email: string, reason = "unsubscribed"): Promise<void> {
  await prisma.emailSuppression.upsert({
    where: { email: email.toLowerCase() },
    create: { email: email.toLowerCase(), reason },
    update: { reason },
  });
}

/**
 * Send a campaign: snapshot recipients, then paced batches with per-recipient
 * results. Idempotent/resumable — pending rows send, sent rows never repeat,
 * so a crash mid-campaign resumes instead of double-sending.
 */
export async function sendCampaign(prisma: PrismaClient, campaignId: string): Promise<{ sent: number; failed: number; suppressed: number }> {
  const campaign = await prisma.emailCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error("Campaign not found.");
  if (campaign.status === "sent") throw new Error("This campaign has already been sent.");
  if (campaignTransport() === "resend") {
    // Refuse a run that would fail on every row: the sending domain must be
    // verified at Resend (DNS records added and propagated) first.
    const check = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    });
    /*
      Kyle's key is send-only ("restricted_api_key") and CANNOT list domains —
      a 401 here says nothing about verification (his root domain IS verified,
      confirmed by a live send on 2026-09-02). Only an affirmative 200 listing
      that EXCLUDES the from-domain refuses; anything else proceeds, and an
      actually-unverified domain still fails per-row with Resend's own message.
    */
    if (check.status === 401) {
      // send-only key: skip the check, the live send is the proof
    } else {
    const domains = check.ok ? ((await check.json()) as { data?: Array<{ name: string; status: string }> }).data ?? [] : [];
    const fromDomain = RESEND_FROM.match(/@([^>\s]+)/)?.[1] ?? "";
    const verified = domains.some((d) => d.name === fromDomain && d.status === "verified");
    if (!verified) {
      throw new Error(
        `The Resend sending domain (${fromDomain}) is not verified yet — add the DNS records at your domain host, wait for Resend to show "verified", then Send again. Nothing was sent.`,
      );
    }
    }
  }
  const blocks = JSON.parse(campaign.blocksJson) as CampaignBlock[];
  if (blocks.length === 0) throw new Error("The campaign has no content blocks.");
  const profile = await getCompanyProfile();

  // Snapshot the audience once (first send); a resume reuses the snapshot.
  const existing = await prisma.emailCampaignSend.count({ where: { campaignId } });
  if (existing === 0) {
    const recipients = await resolveListRecipients(prisma, campaign.listId);
    if (recipients.length === 0) throw new Error("The list resolves to zero recipients.");
    await prisma.emailCampaignSend.createMany({
      data: recipients.map((r) => ({
        campaignId,
        email: r.email,
        name: r.name,
        unsubscribeToken: randomBytes(24).toString("hex"),
      })),
      skipDuplicates: true,
    });
  }
  await prisma.emailCampaign.update({ where: { id: campaignId }, data: { status: "sending" } });

  const base = publicBaseUrl();
  const transport = campaignTransport();
  const dailyCap = transport === "resend" ? RESEND_DAILY_CAP : GMAIL_DAILY_CAP;
  let sent = 0, failed = 0, suppressed = 0, inBatch = 0;
  let rateLimited = false;
  const pending = await prisma.emailCampaignSend.findMany({
    where: { campaignId, status: "pending" },
    take: dailyCap,
  });
  for (const row of pending) {
    if (rateLimited) break;
    if (await isSuppressed(prisma, row.email)) {
      await prisma.emailCampaignSend.update({ where: { id: row.id }, data: { status: "suppressed" } });
      suppressed += 1;
      continue;
    }
    const unsubscribeUrl = `${base}/unsubscribe/${row.unsubscribeToken}`;
    const html = renderCampaignHtml(blocks, unsubscribeUrl, profile.mailingAddress, row.name);
    // The subject greets this recipient too. It is the Subject header (plain text) and the email's
    // headline — wrapCampaignHtml / the branded shell print the headline, so it is escaped there.
    const subject = mergeFirstName(campaign.subject, row.name);
    try {
      if (transport === "resend") {
        const fullHtml = wrapCampaignHtml(subject, html, profile);
        await sendViaResend({
          to: row.email,
          subject,
          html: fullHtml,
          text: htmlToPlainText(fullHtml),
          headers: { "List-Unsubscribe": `<${unsubscribeUrl}>` },
        });
        await prisma.emailCampaignSend.update({ where: { id: row.id }, data: { status: "sent", sentAt: new Date() } });
        sent += 1;
        await new Promise((r) => setTimeout(r, RESEND_PAUSE_MS));
      } else {
        const ok = await sendBrandedEmail({
          kind: "campaign",
          to: row.email,
          subject,
          headline: escapeHtml(subject),
          bodyHtml: html,
          headers: { "List-Unsubscribe": `<${unsubscribeUrl}>` },
        });
        if (ok) {
          await prisma.emailCampaignSend.update({ where: { id: row.id }, data: { status: "sent", sentAt: new Date() } });
          sent += 1;
        } else {
          await prisma.emailCampaignSend.update({ where: { id: row.id }, data: { status: "failed", error: "transport returned false" } });
          failed += 1;
        }
        inBatch += 1;
        if (inBatch >= GMAIL_BATCH_SIZE) {
          inBatch = 0;
          await new Promise((r) => setTimeout(r, GMAIL_BATCH_PAUSE_MS));
        }
      }
    } catch (err) {
      if ((err as Error & { rateLimited?: boolean }).rateLimited) {
        // The plan's ceiling — stop cleanly; pending rows resume on the next Send.
        rateLimited = true;
        logSystemEvent("warn", "campaigns", `Resend rate limit hit mid-campaign — run paused with pending rows (press Send to resume later)`, { campaignId });
        break;
      }
      await prisma.emailCampaignSend.update({
        where: { id: row.id },
        data: { status: "failed", error: err instanceof Error ? err.message.slice(0, 400) : String(err) },
      });
      failed += 1;
    }
  }

  const remaining = await prisma.emailCampaignSend.count({ where: { campaignId, status: "pending" } });
  const totals = await prisma.emailCampaignSend.groupBy({
    by: ["status"], where: { campaignId }, _count: { _all: true },
  });
  const count = (st: string) => totals.find((t) => t.status === st)?._count._all ?? 0;
  await prisma.emailCampaign.update({
    where: { id: campaignId },
    data: {
      status: remaining === 0 ? "sent" : "sending",
      sentAt: remaining === 0 ? new Date() : null,
      sentCount: count("sent"),
      failedCount: count("failed"),
      suppressedCount: count("suppressed"),
    },
  });
  logSystemEvent("info", "campaigns", `Campaign "${campaign.name}" run via ${transport}: ${sent} sent, ${failed} failed, ${suppressed} suppressed${remaining > 0 ? `, ${remaining} pending` : ""}`, { campaignId });
  return { sent, failed, suppressed };
}

/**
 * Blog watcher (Kyle's ruling: AUTO-DRAFT, never auto-send). Each published
 * article that has no campaign yet becomes a DRAFT on the default list — an
 * article card plus an empty intro for Kyle's own words — and Kyle gets a
 * heads-up email. He reviews, adds a promo if he wants, and presses Send.
 */
export async function autoDraftFromNewArticles(prisma: PrismaClient): Promise<{ drafted: number }> {
  const { fetchPublishedArticles } = await import("./sanityArticles");
  const { sendKyleNotificationEmail } = await import("./confirmationEmail");
  const articles = await fetchPublishedArticles(10);
  const list = await ensureDefaultList(prisma);
  let drafted = 0;
  for (const a of articles) {
    const existing = await prisma.emailCampaign.findUnique({ where: { sourceArticleId: a.id }, select: { id: true } });
    if (existing) continue;
    const blocks: CampaignBlock[] = [
      { kind: "text", text: "" },
      { kind: "article", articleId: a.id, title: a.title, excerpt: a.excerpt, url: a.url },
    ];
    await prisma.emailCampaign.create({
      data: {
        listId: list.id,
        name: `Blog: ${a.title}`.slice(0, 120),
        subject: a.title.slice(0, 200),
        blocksJson: JSON.stringify(blocks),
        sourceArticleId: a.id,
      },
    });
    drafted += 1;
    logSystemEvent("info", "campaigns", `Blog post auto-drafted as campaign: ${a.title}`, { articleId: a.id });
    sendKyleNotificationEmail(
      `New blog post drafted as email campaign`,
      `"${a.title}" is waiting as a DRAFT on the Campaigns tab.
Add your intro (and a promotion if you want one), preview, and press Send — nothing goes out on its own.`,
    ).catch(() => {});
  }
  return { drafted };
}

