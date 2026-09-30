/**
 * The office records an acceptance it was told about (Kyle, 2026-09-24; closing-out-an-estimate
 * plan, Unit 1).
 *
 * "The customer accepted button would be good on the estimate drawer, no need to do sign in
 *  person on the CRM because that is being developed for an admin/dispatcher."
 *
 * Pinned here, in the order the plan's traps listed them:
 *   1. it lands on status "signed" — the allow-list every money surface reads — with NO
 *      signature image and signedChannel "office";
 *   2. it never goes through applySignature, and applySignature still refuses a missing drawing;
 *   3. the six refusals, each naming its door, expiry with the Copy-to-new sentence by the same
 *      date arithmetic the signature refusal uses;
 *   4. the PDF and the customer page print the acceptance line, never "Signed by", never a blank
 *      or a made-up mark;
 *   5. the job exists the moment the acceptance is recorded;
 *   6. the event trail; and the undo, refused once money has moved.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
      }),
    },
  };
});
// Customer emails are counted, never sent.
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { acceptEstimateFromOffice, expiredRefusal, undoOfficeAcceptance } from "../src/services/officeAcceptance";
import { LIVE_SIGNED, signedRootForJob } from "../src/services/invoiceGroup";
import { ACCEPTED_VIA, acceptanceWording } from "../shared/acceptance";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "OFFACCEPT";
const ATOMIC = "OA001";
const DAY = 86_400_000;

let customerId: string;
let propertyId: string;
const draftIds: string[] = [];

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ATOMIC)]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "office-accept@example.com", phone: "615-555-0177" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "7 Handshake Ct", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyId = property.id;
});

afterAll(async () => {
  const ests = await prisma.issuedEstimate.findMany({ where: { customerId }, select: { id: true } });
  const ids = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.document.deleteMany({ where: { issuedEstimateId: { in: ids } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateOption.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: ids } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: ids } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { job: { customerId } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ATOMIC]);
});

/** Issue a one-line estimate (or a two-option one); it starts as "draft" (issued, not yet emailed). */
async function issue(title: string, opts: { options?: boolean; exclusive?: boolean } = {}) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId: null });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ATOMIC, quantity: 1, quantitySource: "COUNT" });
  if (opts.options) await addLine(prisma, d.id, { itemId: ATOMIC, quantity: 2, quantitySource: "COUNT", option: "B" });
  if (opts.exclusive) await prisma.priceBookDraftEstimate.update({ where: { id: d.id }, data: { exclusiveOptions: true } });
  const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
  if (!g.ok) throw new Error(`graduation failed: ${JSON.stringify(g)}`);
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId } });
}

/** Put an issued row where a test needs it, the way the real paths would have. */
async function put(id: string, status: "sent" | "viewed" | "expired", extra: { ageDays?: number } = {}) {
  const sentAt = new Date(Date.now() - (extra.ageDays ?? 1) * DAY);
  return prisma.issuedEstimate.update({
    where: { id },
    data: {
      status,
      sentAt,
      sentTo: "office-accept@example.com",
      firstViewedAt: status === "viewed" ? new Date(sentAt.getTime() + 3600_000) : null,
      ...(extra.ageDays ? { createdAt: new Date(Date.now() - extra.ageDays * DAY) } : {}),
    },
  });
}

const accept = (id: string, body: Record<string, unknown> = { acceptedVia: "phone", acceptedBy: "Bryan Crawford", note: "called back after lunch" }) =>
  request(app).post(`/issued-estimates/${id}/accept`).send(body);
const unaccept = (id: string) => request(app).post(`/issued-estimates/${id}/unaccept`).send({});
const row = (id: string) => prisma.issuedEstimate.findUniqueOrThrow({ where: { id } });

describe("the vocabulary is one list", () => {
  it("five ways the customer can tell the office, and none of the wording says 'signed'", () => {
    expect([...ACCEPTED_VIA]).toEqual(["phone", "email", "text", "writing", "in_person"]);
    for (const via of ACCEPTED_VIA) {
      const w = acceptanceWording("office", via);
      expect(w.verb).toBe("accepted");
      expect(w.how).toContain("recorded by the office");
      expect(`${w.verb} ${w.how}`).not.toMatch(/signed/i);
    }
    expect(acceptanceWording("office", "phone")).toEqual({ verb: "accepted", how: "by phone, recorded by the office" });
    // The two signature channels are unchanged.
    expect(acceptanceWording("in_person")).toEqual({ verb: "signed", how: "in person" });
    expect(acceptanceWording("email")).toEqual({ verb: "signed", how: "from the emailed link" });
  });
});

describe("the happy path — trap 1: status 'signed', no signature image", () => {
  it("a SENT estimate accepted by phone lands on status 'signed' with signedChannel 'office' and signatureImage null, and gets its job", async () => {
    const est = await issue("phone-yes");
    await put(est.id, "sent");
    const res = await accept(est.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.jobVisitId).toBeTruthy();

    const r = await row(est.id);
    expect(r.status).toBe("signed");
    expect(r.signedAt).not.toBeNull();
    expect(r.signatureImage).toBeNull();
    expect(r.signerIp).toBeNull();
    expect(r.signedChannel).toBe("office");
    expect(r.acceptedVia).toBe("phone");
    expect(r.acceptedNote).toBe("called back after lunch");
    expect(r.signerName).toBe("Bryan Crawford");
    // The consent text is the office's record, never the e-signature consent.
    expect(r.consentText).toContain("No signature was collected");
    expect(r.consentText).not.toContain("electronic signature with the same effect");
    // The frozen selection arithmetic ran, exactly as at a signature.
    expect(r.comboCapJson).not.toBeNull();
    // Not lost, not void.
    expect(r.voidedAt).toBeNull();
    expect(r.lostAt).toBeNull();

    // readDataChecks check #1: a signed row's status is "signed" or "void".
    expect(["signed", "void"]).toContain(r.status);
    // The money allow-list sees it — this is the whole reason it is not a new status.
    expect(await prisma.issuedEstimate.count({ where: { id: est.id, ...LIVE_SIGNED } })).toBe(1);

    // Trap 5: the job exists now, contracted at the accepted address.
    expect(r.jobVisitId).toBe(res.body.jobVisitId);
    const job = await prisma.visit.findUniqueOrThrow({ where: { id: r.jobVisitId! } });
    expect(job.status).toBe("contracted");
    expect(job.propertyId).toBe(propertyId);
    expect(await signedRootForJob(prisma, job.id)).toMatchObject({ id: est.id });

    // Trap 6: the trail.
    const events = await prisma.issuedEstimateEvent.findMany({ where: { estimateId: est.id, type: "accepted" } });
    expect(events).toHaveLength(1);
    expect(events[0].detail).toContain("by phone");
    expect(events[0].detail).toContain("recorded by the office");
    expect(events[0].detail).toContain("(rev 1, was sent)");
    expect(events[0].actor).toBe("human:crm-session");
  });

  it("a VIEWED estimate can be accepted; the invoice email goes out and says nothing about a signature", async () => {
    emailMock.sendBrandedEmail.mockClear();
    const est = await issue("viewed-yes");
    await put(est.id, "viewed");
    expect((await accept(est.id, { acceptedVia: "text", acceptedBy: "Bryan Crawford" })).status).toBe(200);
    const r = await row(est.id);
    expect(r.status).toBe("signed");
    expect(r.acceptedVia).toBe("text");
    expect(r.acceptedNote).toBeNull();
    // The invoice email is fire-and-forget after the response; give it a moment.
    const deadline = Date.now() + 5000;
    let invoice: { kind?: string; html?: string; bodyHtml?: string } | undefined;
    while (Date.now() < deadline && !invoice) {
      invoice = emailMock.sendBrandedEmail.mock.calls.map((c) => c[0] as { kind?: string }).find((c) => c.kind === "invoice");
      if (!invoice) await new Promise((r) => setTimeout(r, 100));
    }
    expect(invoice, "the invoice email was sent").toBeTruthy();
    const body = JSON.stringify(invoice);
    expect(body).toContain("Your invoice is attached");
    expect(body).not.toContain("Your signed invoice");
  });

  it("a second acceptance, and the in-person signature door, are both refused once accepted (sign-once)", async () => {
    const est = await issue("twice");
    await put(est.id, "sent");
    expect((await accept(est.id)).status).toBe(200);
    const again = await accept(est.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("Already accepted / signed.");
    const signed = await request(app).post(`/issued-estimates/${est.id}/sign-in-person`).send({ signerName: "Bryan Crawford", signatureImage: TEST_SIGNATURE });
    expect(signed.status).toBe(400);
    expect(signed.body.error).toMatch(/already been signed/);
    expect((await row(est.id)).signatureImage).toBeNull();
  });

  it("trap 2: the signature path still refuses a missing drawing — the office path never weakened it", async () => {
    const est = await issue("no-drawing");
    await put(est.id, "sent");
    const res = await request(app).post(`/issued-estimates/${est.id}/sign-in-person`).send({ signerName: "Bryan Crawford" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/draw your signature/i);
    expect((await row(est.id)).status).toBe("sent");
  });
});

describe("the six refusals, each naming the door", () => {
  it("already signed (a real signature) → 'Already accepted / signed.'", async () => {
    const est = await issue("signed-first");
    await put(est.id, "sent");
    const signed = await request(app).post(`/issued-estimates/${est.id}/sign-in-person`).send({ signerName: "Bryan Crawford", signatureImage: TEST_SIGNATURE });
    expect(signed.status).toBe(200);
    const res = await accept(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Already accepted / signed.");
    // And the real signature is untouched.
    expect((await row(est.id)).signedChannel).toBe("in_person");
  });

  it("void → 'This estimate is void.'", async () => {
    const est = await issue("void");
    await put(est.id, "sent");
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { status: "void", voidedAt: new Date(), voidReason: "wrong price" } });
    const res = await accept(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("This estimate is void.");
  });

  it("lost → 'Marked lost — reopen it first.'", async () => {
    const est = await issue("lost");
    await put(est.id, "sent");
    expect((await request(app).post(`/issued-estimates/${est.id}/lost`).send({ reason: "price" })).status).toBe(200);
    const res = await accept(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Marked lost — reopen it first.");
    // Reopen is the door, and then it accepts.
    expect((await request(app).post(`/issued-estimates/${est.id}/reopen`).send({})).status).toBe(200);
    expect((await accept(est.id)).status).toBe(200);
  });

  it("draft (never sent) → 'Never sent to the customer.'", async () => {
    const est = await issue("draft");
    const res = await accept(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/^Never sent to the customer\./);
    expect((await row(est.id)).status).toBe("draft");
  });

  it("superseded → 'Replaced by rev 2 — accept that one.'", async () => {
    const est = await issue("superseded");
    await put(est.id, "sent");
    const revised = await request(app).post(`/issued-estimates/${est.id}/revise`).send({});
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    const res = await accept(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Replaced by rev 2 — accept that one.");
  });

  it("past validity → the Copy-to-new sentence, by date arithmetic, whether or not the sweep relabelled it", async () => {
    // Relabelled by the sweep.
    const labelled = await issue("expired-labelled");
    await put(labelled.id, "expired", { ageDays: 45 });
    const a = await accept(labelled.id);
    expect(a.status).toBe(409);
    expect(a.body.error).toMatch(/^This quote expired on \d{1,2}\/\d{1,2}\/\d{4}\. Use Copy to new to reissue at today's pricing\.$/);
    expect(a.body.error).toBe(expiredRefusal(await row(labelled.id)));

    // NOT yet relabelled: still reads "sent" but its 30 days are up. The arithmetic decides.
    const stale = await issue("expired-unlabelled");
    await put(stale.id, "sent", { ageDays: 31 });
    const b = await accept(stale.id);
    expect(b.status).toBe(409);
    expect(b.body.error).toMatch(/Use Copy to new to reissue at today's pricing/);
    expect((await row(stale.id)).status).toBe("sent");

    // Day 29 is fine.
    const fresh = await issue("still-valid");
    await put(fresh.id, "sent", { ageDays: 29 });
    expect((await accept(fresh.id)).status).toBe(200);
  });

  it("the body is checked: a made-up channel or a blank name is a 400, and nothing is written", async () => {
    const est = await issue("bad-body");
    await put(est.id, "sent");
    expect((await accept(est.id, { acceptedVia: "carrier pigeon", acceptedBy: "Bryan" })).status).toBe(400);
    expect((await accept(est.id, { acceptedVia: "phone", acceptedBy: "" })).status).toBe(400);
    expect((await accept(est.id, {})).status).toBe(400);
    const r = await row(est.id);
    expect(r.status).toBe("sent");
    expect(r.signedAt).toBeNull();
  });
});

describe("options — what they actually bought, by the signature path's own rules", () => {
  it("silence means all of them; a named choice is recorded; an empty choice is refused", async () => {
    const all = await issue("options-all", { options: true });
    await put(all.id, "sent");
    expect((await accept(all.id)).status).toBe(200);
    expect((await row(all.id)).selectedOptions).toEqual(["A", "B"]);

    const one = await issue("options-one", { options: true });
    await put(one.id, "sent");
    expect((await accept(one.id, { acceptedVia: "email", acceptedBy: "Bryan Crawford", selectedOptions: ["b"] })).status).toBe(200);
    expect((await row(one.id)).selectedOptions).toEqual(["B"]);

    const none = await issue("options-none", { options: true });
    await put(none.id, "sent");
    const res = await accept(none.id, { acceptedVia: "email", acceptedBy: "Bryan Crawford", selectedOptions: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one/i);
    expect((await row(none.id)).status).toBe("sent");
  });

  it("one-or-the-other options accept exactly one", async () => {
    const est = await issue("options-exclusive", { options: true, exclusive: true });
    await put(est.id, "sent");
    const both = await accept(est.id, { acceptedVia: "phone", acceptedBy: "Bryan Crawford", selectedOptions: ["A", "B"] });
    expect(both.status).toBe(400);
    expect(both.body.error).toMatch(/exactly one/);
    const silent = await accept(est.id, { acceptedVia: "phone", acceptedBy: "Bryan Crawford" });
    expect(silent.status).toBe(400);
    expect((await accept(est.id, { acceptedVia: "phone", acceptedBy: "Bryan Crawford", selectedOptions: ["A"] })).status).toBe(200);
    expect((await row(est.id)).selectedOptions).toEqual(["A"]);
  });
});

describe("trap 4: the documents say 'accepted by phone', never 'signed', and print no mark", () => {
  it("the customer's page and both PDFs carry the acceptance line", async () => {
    const est = await issue("documents");
    await put(est.id, "viewed");
    expect((await accept(est.id, { acceptedVia: "writing", acceptedBy: "Bryan Crawford" })).status).toBe(200);

    const page = await request(app).get(`/e/${est.token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Accepted in writing by <strong>Bryan Crawford</strong>");
    expect(page.text).toContain("No signature was collected");
    expect(page.text).not.toContain("Signed by");
    expect(page.text).not.toContain("Accepted &amp; signed");
    expect(page.text).not.toContain('alt="Signature"');

    for (const audience of ["customer", "company"]) {
      const pdf = await request(app).get(`/issued-estimates/${est.id}/pdf?audience=${audience}`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(pdf.status).toBe(200);
      expect(pdf.headers["content-type"]).toContain("application/pdf");
      const text = extractText(pdf.body as Buffer);
      expect(text).toContain("Accepted in writing by Bryan Crawford");
      expect(text).toContain("No signature was");
      expect(text).toContain("Recorded by the Red Cedar Electric office");
    }
  });
});

/** pdfkit writes text as hex runs; the same reader tests/issuedEstimatePdf.test.ts uses. */
function extractText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const parts: string[] = [];
  for (const m of raw.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    if (m[1].length % 2 !== 0) continue;
    parts.push(Buffer.from(m[1], "hex").toString("latin1"));
  }
  return parts.join("");
}

describe("undo — the way back (Kyle's standing rule), refused once anything has moved", () => {
  it("takes the acceptance back: unsigned again, every acceptance column cleared, the unscheduled job cancelled — and a re-acceptance mints a fresh job", async () => {
    const est = await issue("undo");
    await put(est.id, "viewed");
    const accepted = await accept(est.id);
    expect(accepted.status).toBe(200);
    const firstJob = accepted.body.jobVisitId as string;

    const res = await unaccept(est.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ unaccepted: true, status: "viewed", jobAction: "cancelled_unscheduled" });

    const r = await row(est.id);
    expect(r.status).toBe("viewed");
    expect(r.signedAt).toBeNull();
    expect(r.signerName).toBeNull();
    expect(r.consentText).toBeNull();
    expect(r.signedChannel).toBeNull();
    expect(r.acceptedVia).toBeNull();
    expect(r.acceptedNote).toBeNull();
    expect(r.comboCapJson).toBeNull();
    expect(r.selectedOptions).toEqual([]);
    expect(r.jobVisitId).toBeNull();
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: firstJob } })).status).toBe("cancelled");
    expect(await prisma.issuedEstimateEvent.count({ where: { estimateId: est.id, type: "unaccepted" } })).toBe(1);
    // Out of the money allow-list again.
    expect(await prisma.issuedEstimate.count({ where: { id: est.id, ...LIVE_SIGNED } })).toBe(0);

    // Accept again: a NEW job, never the cancelled one handed back.
    const again = await accept(est.id, { acceptedVia: "phone", acceptedBy: "Bryan Crawford" });
    expect(again.status).toBe(200);
    expect(again.body.jobVisitId).toBeTruthy();
    expect(again.body.jobVisitId).not.toBe(firstJob);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: again.body.jobVisitId } })).status).toBe("contracted");
  });

  it("returns to SENT when never opened, and to EXPIRED when the window closed meanwhile", async () => {
    const sent = await issue("undo-sent");
    await put(sent.id, "sent");
    await accept(sent.id);
    expect((await unaccept(sent.id)).body.status).toBe("sent");

    const late = await issue("undo-expired");
    await put(late.id, "sent", { ageDays: 29 });
    expect((await accept(late.id)).status).toBe(200);
    await prisma.issuedEstimate.update({ where: { id: late.id }, data: { createdAt: new Date(Date.now() - 40 * DAY) } });
    expect((await unaccept(late.id)).body.status).toBe("expired");
  });

  it("refuses once a payment has been recorded — Void is the door", async () => {
    const est = await issue("undo-paid");
    await put(est.id, "sent");
    await accept(est.id);
    await prisma.payment.create({ data: { customerId, estimateId: est.id, amount: 100, method: "cash", kind: "deposit", status: "paid", paidAt: new Date() } });
    const res = await unaccept(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/payment.*Void the estimate/i);
    expect((await row(est.id)).status).toBe("signed");
  });

  it("refuses once a signed change order belongs to it", async () => {
    const root = await issue("undo-root");
    await put(root.id, "sent");
    await accept(root.id);
    const co = await issue("undo-change-order");
    await put(co.id, "sent");
    await accept(co.id);
    await prisma.issuedEstimate.update({ where: { id: co.id }, data: { changeOrderForId: root.id } });
    const res = await unaccept(root.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/change order.*Void/i);
  });

  it("refuses once the job is on the schedule or past contracted", async () => {
    const est = await issue("undo-scheduled");
    await put(est.id, "sent");
    const accepted = await accept(est.id);
    const jobId = accepted.body.jobVisitId as string;
    await prisma.visit.update({ where: { id: jobId }, data: { scheduledStart: new Date(Date.now() + DAY), scheduledEnd: new Date(Date.now() + DAY + 3600_000) } });
    const res = await unaccept(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/on the schedule.*Void/i);
    await prisma.visit.update({ where: { id: jobId }, data: { status: "in_progress" } });
    const res2 = await unaccept(est.id);
    expect(res2.status).toBe(409);
    expect(res2.body.error).toMatch(/already in progress.*Void/i);
  });

  it("refuses a customer's real signature — that is voided with a reason, never erased", async () => {
    const est = await issue("undo-signature");
    await put(est.id, "sent");
    expect((await request(app).post(`/issued-estimates/${est.id}/sign-in-person`).send({ signerName: "Bryan Crawford", signatureImage: TEST_SIGNATURE })).status).toBe(200);
    const res = await unaccept(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/customer's own signature.*void it/i);
    expect((await row(est.id)).signedChannel).toBe("in_person");
  });

  it("refuses an estimate that was never accepted, and a void one", async () => {
    const est = await issue("undo-nothing");
    await put(est.id, "sent");
    expect((await unaccept(est.id)).status).toBe(409);
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { status: "void", voidedAt: new Date(), voidReason: "x" } });
    expect((await unaccept(est.id)).body.error).toBe("This estimate is void.");
  });

  it("the service functions answer the same way the routes do (for the record)", async () => {
    const est = await issue("service-direct");
    expect(await acceptEstimateFromOffice(prisma, est.id, { acceptedVia: "phone", acceptedBy: "B" })).toEqual({ ok: false, status: 400, reason: "Who accepted? Type their name." });
    expect(await acceptEstimateFromOffice(prisma, "nope", { acceptedVia: "phone", acceptedBy: "Bryan" })).toEqual({ ok: false, status: 404, reason: "Estimate not found." });
    expect(await undoOfficeAcceptance(prisma, "nope")).toEqual({ ok: false, status: 404, reason: "Estimate not found." });
  });
});
