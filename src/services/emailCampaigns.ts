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
import { sendBrandedEmail, escapeHtml } from "./confirmationEmail";
import { getCompanyProfile } from "./companyProfile";
import { publicBaseUrl } from "./issuedEstimateSend";
import { logSystemEvent } from "./systemEvents";

export const DEFAULT_LIST_NAME = "Storm Preparedness Campaign";
/** Gmail-friendly pacing: a batch, a breath, repeat. */
const BATCH_SIZE = 15;
const BATCH_PAUSE_MS = 45_000;
/** Stay far under the mailbox's daily ceiling. */
const DAILY_SEND_CAP = 300;

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

/** Render the block stack to email HTML — the SAME function preview and send use. */
export function renderCampaignHtml(blocks: CampaignBlock[], unsubscribeUrl: string, mailingAddress: string): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      parts.push(`<p style="font-size:15px;line-height:1.6;">${escapeHtml(b.text).replaceAll("\n", "<br>")}</p>`);
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
      parts.push(`
        <div style="background:#f4f8f4;border-radius:8px;padding:18px 20px;margin:16px 0;text-align:center;">
          <p style="margin:0;font-size:18px;font-weight:700;">${escapeHtml(b.headline)}</p>
          <p style="margin:8px 0 14px;font-size:14px;">${escapeHtml(b.text)}</p>
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
  let sent = 0, failed = 0, suppressed = 0, inBatch = 0;
  const pending = await prisma.emailCampaignSend.findMany({
    where: { campaignId, status: "pending" },
    take: DAILY_SEND_CAP,
  });
  for (const row of pending) {
    if (await isSuppressed(prisma, row.email)) {
      await prisma.emailCampaignSend.update({ where: { id: row.id }, data: { status: "suppressed" } });
      suppressed += 1;
      continue;
    }
    const unsubscribeUrl = `${base}/unsubscribe/${row.unsubscribeToken}`;
    const html = renderCampaignHtml(blocks, unsubscribeUrl, profile.mailingAddress);
    try {
      const ok = await sendBrandedEmail({
        to: row.email,
        subject: campaign.subject,
        headline: campaign.subject,
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
    } catch (err) {
      await prisma.emailCampaignSend.update({
        where: { id: row.id },
        data: { status: "failed", error: err instanceof Error ? err.message.slice(0, 400) : String(err) },
      });
      failed += 1;
    }
    inBatch += 1;
    if (inBatch >= BATCH_SIZE) {
      inBatch = 0;
      await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
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
  logSystemEvent("info", "campaigns", `Campaign "${campaign.name}" run: ${sent} sent, ${failed} failed, ${suppressed} suppressed${remaining > 0 ? `, ${remaining} pending (daily cap)` : ""}`, { campaignId });
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

