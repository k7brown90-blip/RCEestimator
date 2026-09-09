/**
 * Supplier material order emails — runs at 6pm CT via cron.
 * Queries OPEN, unsent PurchaseOrder records (Kyle, 2026-09-09: the PO is the
 * document), groups by supplier, sends one email per supplier, stamps sentAt.
 *
 * Uses Gmail OAuth2 via nodemailer (same setup as dailySummary.ts).
 */

import { prisma } from "../lib/prisma";
import nodemailer from "nodemailer";

function getTransporter() {
  const gmailUser = process.env.GMAIL_USER;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!gmailUser || !clientId || !clientSecret || !refreshToken) {
    return null;
  }

  return {
    transporter: nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2" as const,
        user: gmailUser,
        clientId,
        clientSecret,
        refreshToken,
      },
    }),
    from: `"Red Cedar Electric" <${gmailUser}>`,
  };
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const PURPOSE_LABEL: Record<string, string> = { truck_stock: "Truck stock", warehouse: "Warehouse", tool: "Tool" };

export async function sendPendingSupplierEmails(): Promise<number> {
  const mail = getTransporter();
  if (!mail) {
    console.warn("[SupplierEmail] Gmail not configured — skipping.");
    return 0;
  }

  // Every open PO not yet sent to its supplier.
  const orders = await prisma.purchaseOrder.findMany({
    where: { sentAt: null, status: "open" },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      job: { include: { property: true } },
    },
    orderBy: { openedAt: "asc" },
  });

  if (orders.length === 0) {
    console.log("[SupplierEmail] No pending purchase orders.");
    return 0;
  }

  // Group by supplier
  const grouped = new Map<string, typeof orders>();
  for (const order of orders) {
    const key = order.supplier;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(order);
  }

  let sent = 0;

  for (const [supplier, supplierOrders] of grouped) {
    const rows = supplierOrders.map((o) => {
      const addr = o.job?.property
        ? [o.job.property.addressLine1, o.job.property.city, o.job.property.state].filter(Boolean).join(", ")
        : "—";
      const jobName = o.job?.purpose ?? PURPOSE_LABEL[o.purpose] ?? "Stock";
      const items = o.lines.length
        ? o.lines.map((l) => `${l.qty}${l.unit ? ` ${esc(l.unit)}` : ""} × ${esc(l.name)}${l.partNumber ? ` (#${esc(l.partNumber)})` : ""}`).join("<br>")
        : "(no lines listed)";
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;white-space:nowrap;">${esc(o.number)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">${esc(jobName)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">${esc(addr)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">${items}</td>
        </tr>`;
    });

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:#333;">
        <div style="background:#1a5c2e;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
          <h1 style="margin:0;font-size:20px;">Purchase Order — Red Cedar Electric</h1>
        </div>
        <div style="padding:16px 24px;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
          <p style="font-size:15px;">Hi ${esc(supplier)} team,</p>
          <p style="font-size:14px;">Please have the following materials ready for pickup or delivery. Reference the PO number on the ticket:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr style="background:#f5f5f5;">
              <th style="padding:8px 12px;text-align:left;font-size:13px;">PO</th>
              <th style="padding:8px 12px;text-align:left;font-size:13px;">Job</th>
              <th style="padding:8px 12px;text-align:left;font-size:13px;">Address</th>
              <th style="padding:8px 12px;text-align:left;font-size:13px;">Items</th>
            </tr>
            ${rows.join("")}
          </table>
          <p style="font-size:13px;color:#888;">— Red Cedar Electric LLC</p>
        </div>
      </div>`;

    // Send to Kyle for now (supplier emails get forwarded manually until supplier contacts are in CRM)
    const toEmail = process.env.SUMMARY_EMAIL ?? process.env.GMAIL_USER;
    if (!toEmail) continue;

    try {
      await mail.transporter.sendMail({
        from: mail.from,
        to: toEmail,
        subject: `Purchase Order — ${supplier} (${supplierOrders.map((o) => o.number).join(", ")})`,
        html,
      });

      // Mark as sent
      await prisma.purchaseOrder.updateMany({
        where: { id: { in: supplierOrders.map((o) => o.id) } },
        data: { sentAt: new Date() },
      });

      sent += supplierOrders.length;
      console.log(`[SupplierEmail] Sent ${supplierOrders.length} PO(s) to ${supplier}`);
    } catch (err) {
      console.error(`[SupplierEmail] Failed for ${supplier}:`, err);
    }
  }

  return sent;
}
