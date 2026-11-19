/**
 * Campaign rendering and sending (Kyle, 2026-11-18, plan admin-reports-1117 R2 + R3).
 *
 * Pins:
 *   1. {first_name} is the first word of the recipient's name, "there" when there is none, merged
 *      into text blocks and promo headline/offer on the RAW text, before escapeHtml — so an apostrophe
 *      is not double-escaped and a "<script>" in a name is escaped, never trusted.
 *   2. The subject greets each recipient too; the HTML headline (printed unescaped by the shells)
 *      is escaped on BOTH pipes, while the Subject header stays plain text.
 *   3. A Promotion with a blank Headline / offer prints no empty <p> — a stand-alone button.
 *   4. The Resend payload carries the plain-text twin (`text`), and the CAN-SPAM footer and
 *      List-Unsubscribe header are still on every send.
 *
 * Nothing touches the network: fetch is stubbed and sendBrandedEmail (the Gmail pipe) is a spy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const branded = vi.hoisted(() => ({ send: vi.fn<(input: Record<string, unknown>) => Promise<boolean>>() }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/confirmationEmail")>()),
  sendBrandedEmail: branded.send,
}));

import { DEFAULT_COMPANY_PROFILE } from "../src/services/companyProfile";
import {
  campaignFirstName,
  mergeFirstName,
  renderCampaignHtml,
  sendCampaign,
  wrapCampaignHtml,
  type CampaignBlock,
} from "../src/services/emailCampaigns";

const UNSUB = "https://example.test/unsubscribe/tok123";
const ADDRESS = "123 Main St, La Vergne, TN";

const textBlock = (text: string): CampaignBlock => ({ kind: "text", text });
const promo = (over: Partial<Extract<CampaignBlock, { kind: "promo" }>> = {}): CampaignBlock => ({
  kind: "promo", headline: "", text: "", ctaLabel: "Book my assessment", ctaUrl: "tel:615-625-2163", ...over,
});

describe("{first_name}", () => {
  it("takes the first word of the name, and falls back to 'there'", () => {
    expect(campaignFirstName("John and Sandy Lewis")).toBe("John");
    expect(campaignFirstName("  Maria  ")).toBe("Maria");
    expect(campaignFirstName(null)).toBe("there");
    expect(campaignFirstName(undefined)).toBe("there");
    expect(campaignFirstName("   ")).toBe("there");
    expect(mergeFirstName("Hi {first_name}, {first_name}!", "Ann Lee")).toBe("Hi Ann, Ann!");
  });

  it("renders 'Hi John,' with a name and 'Hi there,' without one", () => {
    const blocks = [textBlock("Hi {first_name},\nstorm season is here.")];
    const withName = renderCampaignHtml(blocks, UNSUB, ADDRESS, "John Lewis");
    expect(withName).toContain("Hi John,<br>storm season is here.");
    expect(renderCampaignHtml(blocks, UNSUB, ADDRESS, null)).toContain("Hi there,<br>");
    expect(renderCampaignHtml(blocks, UNSUB, ADDRESS)).toContain("Hi there,<br>");
  });

  it("does not double-escape an apostrophe in a name", () => {
    const html = renderCampaignHtml([textBlock("Hi {first_name},")], UNSUB, ADDRESS, "O'Brien Family");
    expect(html).toContain("Hi O'Brien,");
    expect(html).not.toContain("&amp;#39;");
    expect(html).not.toContain("&amp;");
  });

  it("escapes a name containing <script> in the body (text and promo)", () => {
    const html = renderCampaignHtml(
      [textBlock("Hi {first_name},"), promo({ headline: "{first_name}, save $149", text: "For {first_name} only" })],
      UNSUB, ADDRESS, "<script>alert(1)</script> Smith",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("Hi &lt;script&gt;alert(1)&lt;/script&gt;,");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;, save $149");
    expect(html).toContain("For &lt;script&gt;alert(1)&lt;/script&gt; only");
  });

  it("merges the token in a promo headline and offer", () => {
    const html = renderCampaignHtml([promo({ headline: "{first_name}, your tune-up", text: "Ready, {first_name}?" })], UNSUB, ADDRESS, "Dee Roe");
    expect(html).toContain("Dee, your tune-up");
    expect(html).toContain("Ready, Dee?");
  });
});

describe("Promotion with blank headline / offer (button only)", () => {
  it("prints no empty <p> and keeps the button", () => {
    const html = renderCampaignHtml([promo()], UNSUB, ADDRESS);
    expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/);
    expect(html).not.toContain("font-size:18px"); // headline <p>
    expect(html).not.toContain("font-size:14px"); // offer <p>
    expect(html).toContain('href="tel:615-625-2163"');
    expect(html).toContain("Book my assessment");
  });

  it("whitespace-only fields count as blank; filled ones still print", () => {
    const blank = renderCampaignHtml([promo({ headline: "   ", text: " " })], UNSUB, ADDRESS);
    expect(blank).not.toContain("font-size:18px");
    const full = renderCampaignHtml([promo({ headline: "Storm tune-up", text: "$149 this month" })], UNSUB, ADDRESS);
    expect(full).toContain("Storm tune-up");
    expect(full).toContain("$149 this month");
  });

  it("a headline with no offer keeps the 14px gap above the button", () => {
    const html = renderCampaignHtml([promo({ headline: "Storm tune-up" })], UNSUB, ADDRESS);
    expect(html).toContain("margin:0 0 14px;font-size:18px");
    // With an offer the headline carries no bottom margin: the offer does.
    const both = renderCampaignHtml([promo({ headline: "Storm tune-up", text: "$149" })], UNSUB, ADDRESS);
    expect(both).toContain("margin:0 0 0;font-size:18px");
    expect(both).toContain("margin:8px 0 14px;font-size:14px");
  });

  it("keeps the CAN-SPAM footer and unsubscribe link", () => {
    const html = renderCampaignHtml([promo()], UNSUB, ADDRESS);
    expect(html).toContain(`Red Cedar Electric LLC · ${ADDRESS}`);
    expect(html).toContain(`href="${UNSUB}"`);
    expect(html).toContain("Unsubscribe");
  });
});

describe("headline escaping", () => {
  it("wrapCampaignHtml escapes the headline it prints", () => {
    const html = wrapCampaignHtml('Hi <b>x</b> & "y"', "<p>body</p>", DEFAULT_COMPANY_PROFILE);
    expect(html).toContain("<h1");
    expect(html).toContain("Hi &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("the Resend shell wears the profile's company name and footer, like the Gmail shell", () => {
    const profile = { ...DEFAULT_COMPANY_PROFILE, legalName: "Cedar & Co <Electric>", phone: "615-555-0100" };
    const html = wrapCampaignHtml("Subject", "<p>body</p>", profile);
    expect(html).toContain("Cedar &amp; Co &lt;Electric&gt;");
    expect(html).toContain("615-555-0100");
    expect(html).toContain(profile.email);
    expect(html).not.toContain("<Electric>");
  });
});

describe("sendCampaign", () => {
  const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  const subject = "Hi {first_name}, is your home ready?";
  const blocks: CampaignBlock[] = [textBlock("Hi {first_name},"), promo()];

  function fakePrisma(name: string | null) {
    return {
      emailCampaign: {
        findUnique: vi.fn(async () => ({ id: "c1", name: "Test", status: "draft", listId: "l1", subject, blocksJson: JSON.stringify(blocks) })),
        update: vi.fn(async () => ({})),
      },
      emailCampaignSend: {
        count: vi.fn(async (args?: { where?: { status?: string } }) => (args?.where?.status === "pending" ? 0 : 1)),
        createMany: vi.fn(async () => ({})),
        findMany: vi.fn(async () => [{ id: "s1", email: "john@example.test", name, unsubscribeToken: "tok123", status: "pending" }]),
        update: vi.fn(async () => ({})),
        groupBy: vi.fn(async () => []),
      },
      emailSuppression: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
  }

  beforeEach(() => {
    fetchMock.mockReset();
    branded.send.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    vi.unstubAllGlobals();
  });

  it("Resend: the payload carries text, a per-recipient subject, an escaped headline and the unsubscribe header", async () => {
    process.env.RESEND_API_KEY = "re_test_key_never_used";
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/domains") ? new Response("{}", { status: 401 }) : new Response(JSON.stringify({ id: "e1" }), { status: 200 }));

    const result = await sendCampaign(fakePrisma("<i>Jo</i> Park"), "c1");
    expect(result.sent).toBe(1);

    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/emails"));
    expect(call).toBeTruthy();
    const payload = JSON.parse(String(call![1]!.body)) as Record<string, unknown>;
    // Subject header: plain text, merged per row, NOT html-escaped.
    expect(payload.subject).toBe("Hi <i>Jo</i>, is your home ready?");
    // Headline in the html: escaped.
    expect(payload.html).toContain("Hi &lt;i&gt;Jo&lt;/i&gt;, is your home ready?");
    expect(payload.html).not.toContain("<i>Jo</i>");
    // Plain-text twin.
    expect(typeof payload.text).toBe("string");
    expect(payload.text).toContain("Hi <i>Jo</i>,");
    expect(payload.text).toContain("Book my assessment [tel:615-625-2163]");
    expect(payload.text).not.toMatch(/<(div|p|h1|a)\b/);
    // CAN-SPAM kept.
    expect((payload.headers as Record<string, string>)["List-Unsubscribe"]).toContain("/unsubscribe/tok123");
    expect(payload.text).toContain("Unsubscribe");
  });

  it("Resend: a recipient with no name is greeted 'there'", async () => {
    process.env.RESEND_API_KEY = "re_test_key_never_used";
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/domains") ? new Response("{}", { status: 401 }) : new Response("{}", { status: 200 }));
    await sendCampaign(fakePrisma(null), "c1");
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/emails"))!;
    const payload = JSON.parse(String(call[1]!.body)) as { subject: string; html: string; text: string };
    expect(payload.subject).toBe("Hi there, is your home ready?");
    expect(payload.html).toContain("Hi there,");
    expect(payload.text).toContain("Hi there,");
  });

  it("Gmail: subject merged per row, headline escaped, body greets the recipient, unsubscribe header kept", async () => {
    delete process.env.RESEND_API_KEY;
    branded.send.mockResolvedValue(true);
    await sendCampaign(fakePrisma("<b>Bo</b> Hill"), "c1");
    expect(branded.send).toHaveBeenCalledTimes(1);
    const input = branded.send.mock.calls[0][0] as { subject: string; headline: string; bodyHtml: string; headers: Record<string, string> };
    expect(input.subject).toBe("Hi <b>Bo</b>, is your home ready?");
    expect(input.headline).toBe("Hi &lt;b&gt;Bo&lt;/b&gt;, is your home ready?");
    expect(input.bodyHtml).toContain("Hi &lt;b&gt;Bo&lt;/b&gt;,");
    expect(input.headers["List-Unsubscribe"]).toContain("/unsubscribe/tok123");
  });
});
