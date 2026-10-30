/**
 * The appointment confirmation email, and the optional prep-reminder block the website booking
 * chat's "Confirm booking" adds to it (plan 2026-10-30-website-booking-chat, U3).
 *
 * Every existing caller passes no prep reminder, so the email they render must be byte-for-byte
 * what it was before the block existed. The snapshot of that output was recorded BEFORE the
 * template was touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ calls: [] as Array<{ subject: string; html: string; text: string }> }));

vi.mock("../src/services/transactionalEmail", async (orig) => ({
  ...(await orig<typeof import("../src/services/transactionalEmail")>()),
  sendCustomerEmail: vi.fn(async (input: { subject: string; html: string; text: string }) => {
    sent.calls.push({ subject: input.subject, html: input.html, text: input.text });
    return { ok: true, provider: "mock" };
  }),
}));

import { sendConfirmationEmail } from "../src/services/confirmationEmail";

const BASE = {
  customerName: "Jane Homeowner",
  customerEmail: "jane@example.com",
  appointmentDate: "Tuesday, November 3, 2026",
  appointmentWindow: "8:00 AM – 10:00 AM",
  serviceAddress: "12 Test Lane, Franklin",
  jobType: "Outlet repair",
};

beforeEach(() => { sent.calls = []; });

describe("sendConfirmationEmail", () => {
  it("renders exactly as it always has when no prep reminder is passed", async () => {
    await sendConfirmationEmail(BASE);
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0].subject).toBe("Appointment Confirmed — Tuesday, November 3, 2026");
    expect(sent.calls[0].html).toMatchSnapshot("html");
    expect(sent.calls[0].text).toMatchSnapshot("text");
    expect(sent.calls[0].html).not.toMatch(/clear access/i);
  });

  it("an undefined prep reminder is the same as none", async () => {
    await sendConfirmationEmail(BASE);
    await sendConfirmationEmail({ ...BASE, prepReminder: undefined });
    expect(sent.calls[1].html).toBe(sent.calls[0].html);
  });

  it("with a prep reminder, the SAME email carries the clear-access list and escapes the customer's words", async () => {
    await sendConfirmationEmail({
      ...BASE,
      prepReminder: { dayName: "Tuesday", areas: ["Kitchen", "<b>Garage</b>", "  "] },
    });
    expect(sent.calls).toHaveLength(1);
    const { html, text } = sent.calls[0];
    expect(html).toContain("Before Tuesday's visit, please clear access to:");
    expect(html).toContain("<li>The electrical panel</li>");
    expect(html).toContain("<li>The attic hatch and crawlspace entry</li>");
    expect(html).toContain("<li>Kitchen</li>");
    expect(html).toContain("<li>&lt;b&gt;Garage&lt;/b&gt;</li>");
    expect(html).not.toContain("<b>Garage</b>");
    expect((html.match(/<li>/g) ?? []).length).toBe(3 + 4); // three standing "what to expect" + panel, attic, Kitchen, Garage
    expect(html).toContain("Moving furniture or items out of the way helps Kyle get started right away.");
    expect(text).toContain("Before Tuesday's visit, please clear access to:");
    expect(text).toContain("The attic hatch and crawlspace entry");
  });

  it("customer name, address and service arrive as TEXT, never as markup (security review M1)", async () => {
    await sendConfirmationEmail({
      ...BASE,
      customerName: 'Jane <a href="https://evil.example/pay">Pay now</a>',
      serviceAddress: '1 Main St <img src=x onerror=alert(1)>',
      jobType: "<b>Outlet</b> & more",
    });
    const { html } = sent.calls[0];
    expect(html).not.toContain("<a href=");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Outlet</b>");
    expect(html).toContain("Hi Jane &lt;a href=&quot;https://evil.example/pay&quot;&gt;Pay now&lt;/a&gt;,");
    expect(html).toContain("1 Main St &lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;Outlet&lt;/b&gt; &amp; more");
  });

  it("an ordinary name and address are untouched by the escaping", async () => {
    await sendConfirmationEmail({ ...BASE, customerName: "Mary O'Neil", serviceAddress: "7 Oak St, Franklin" });
    const { html } = sent.calls[0];
    expect(html).toContain("Hi Mary O'Neil,");
    expect(html).toContain("7 Oak St, Franklin");
  });
});
