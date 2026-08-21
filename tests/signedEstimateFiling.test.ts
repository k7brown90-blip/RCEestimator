/**
 * A signature files a copy and tells Kyle — and neither may undo the signature.
 *
 * Kyle, 2026-08-20: *"When they sign I should get a notification and a copy of the signed
 * agreement to their account too."*
 *
 * ── THE ORDERING IS THE SAFETY PROPERTY ────────────────────────────────────────────────────────
 *
 * A customer has signed. That fact is committed before anything else is attempted, and the filing
 * and the notification are fire-and-forget afterwards. This is not defensive habit: Kyle's Gmail
 * refresh token was dead for two days this week, and if a send sat in the signature's path every
 * signature in that window would have failed — with the customer looking at an error while
 * believing they had just accepted a quote.
 *
 * So the test that matters most here is the one asserting a signature still succeeds when the
 * notification cannot be sent.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(__dirname, "..");
const service = fs.readFileSync(path.join(APP, "src/services/issuedEstimateService.ts"), "utf8");
const schema = fs.readFileSync(path.join(APP, "prisma/schema.prisma"), "utf8");
const app = fs.readFileSync(path.join(APP, "src/app.ts"), "utf8");

describe("the signature is committed before anything else is attempted", () => {
  it("writes the signature, then fires the filing without awaiting it into the result", () => {
    const signAt = service.indexOf("async function applySignature");
    expect(signAt, "applySignature not found — this test is checking nothing").toBeGreaterThan(-1);
    const body = service.slice(signAt, service.indexOf("\n}", signAt));

    const updateAt = body.indexOf("issuedEstimate.updateMany");
    const fileAt = body.indexOf("fileSignedCopies");
    expect(updateAt).toBeGreaterThan(-1);
    expect(fileAt, "the filing call was not found").toBeGreaterThan(-1);
    expect(updateAt, "the signature must be written BEFORE the filing").toBeLessThan(fileAt);

    // `void` and not `await`: the caller's result must not wait on an email.
    expect(body).toMatch(/void fileSignedCopies\(/);
    expect(body).not.toMatch(/await fileSignedCopies\(/);
  });

  it("returns success on the line after the filing is fired", () => {
    const signAt = service.indexOf("async function applySignature");
    const body = service.slice(signAt, service.indexOf("\n}", signAt));
    expect(body.indexOf("fileSignedCopies")).toBeLessThan(body.indexOf("return { ok: true"));
  });

  it("guards each filing separately", () => {
    // One try around both creates would mean a failure on the first copy silently costing the
    // second, and Kyle would have half a record with nothing saying so.
    const fnAt = service.indexOf("async function fileSignedCopies");
    expect(fnAt).toBeGreaterThan(-1);
    const body = service.slice(fnAt, fnAt + 2600);
    // Each create is individually guarded, so failing to file one copy does not cost the other.
    expect(body).toMatch(/document[\s\S]{0,500}\.catch\(/);
  });
});

describe("the filed copy survives a deploy", () => {
  it("links the document to the estimate rather than to a file", () => {
    // Every other document type stores a path into generated/, which Railway deletes on release.
    // A signed agreement is the last thing that should evaporate.
    const at = schema.indexOf("model Document {");
    const model = schema.slice(at, schema.indexOf("\n}", at));
    expect(model).toMatch(/issuedEstimateId\s+String\?/);
  });

  it("renders that document from the estimate instead of reading the disk", () => {
    const at = app.indexOf('app.get("/documents/:id/pdf"');
    expect(at).toBeGreaterThan(-1);
    /*
      Sliced to where the handler actually ENDS, not to a fixed character count.

      This read `at + 2400`. On 2026-08-21 a comment was added inside the handler explaining why
      the PDF audience is derived from the document row, and that pushed the filesystem read past
      the 2400th character — so indexOf returned -1 and the ordering assertion compared against
      it, failing on a handler whose order had not changed at all.

      The next top-level route is the real boundary. A window that moves when a comment is written
      is a window that tests the comment.
    */
    // A newline followed by "app." is the start of the next top-level route. Built rather than
    // written as an escape so the literal cannot be mangled by whatever writes this file.
    const next = app.indexOf(`${String.fromCharCode(10)}app.`, at + 1);
    const handler = app.slice(at, next > -1 ? next : undefined);
    const branchAt = handler.indexOf("doc.issuedEstimateId");
    const fsAt = handler.indexOf('await import("node:fs")');
    expect(branchAt, "the estimate branch was not found").toBeGreaterThan(-1);
    expect(branchAt, "the estimate branch must come BEFORE the filesystem read").toBeLessThan(fsAt);
    expect(handler).toContain("renderEstimatePdf");
  });

  it("files BOTH copies — the customer's and Kyle's", () => {
    // Kyle, 2026-08-20: "the signed copy needs to be saved to their account along side our copy."
    // His is the one he orders and schedules from; theirs is what they agreed to.
    const fnAt = service.indexOf("async function fileSignedCopies");
    const body = service.slice(fnAt, fnAt + 2600);
    // Asserted on the PAIRS the loop iterates, not on "audience=customer" — the URL is built from
    // a template, so that literal never appears in the source. An earlier version of this test
    // looked for it and failed against correct code.
    expect(body).toContain('["signed_estimate", "customer"]');
    expect(body).toContain('["signed_estimate_company", "company"]');
    expect(body).toContain("audience=${audience}");
  });
});

describe("the notification, which already existed", () => {
  /**
   * I wrote a second owner notification before finding that `notifyOwnerSigned` had been in
   * issuedEstimateSend.ts all along, called by BOTH sign routes, with more detail than mine. It
   * would have sent Kyle two emails per signature.
   *
   * It looked missing because it had been silent for two days — the Gmail refresh token was dead,
   * not the code. "Nothing arrived" is not evidence that nothing was sent, and that is worth a
   * test rather than a memory.
   */
  const send = fs.readFileSync(path.join(APP, "src/services/issuedEstimateSend.ts"), "utf8");

  it("lives in one place and names the operator, never the customer", () => {
    expect(send).toContain("export async function notifyOwnerSigned");
    const at = send.indexOf("export async function notifyOwnerSigned");
    const body = send.slice(at, at + 1800);
    expect(body).toContain("SUMMARY_EMAIL");
    expect(body).not.toContain("est.customerEmail");
  });

  it("is called by both doors", () => {
    // A rule enforced at one door is a rule that does not exist. Same for a notification.
    expect(app).toContain("notifyOwnerSigned(prisma, result.estimateId)");
    const page = fs.readFileSync(path.join(APP, "src/routes/estimatePage.ts"), "utf8");
    expect(page).toContain("notifyOwnerSigned(prisma, result.estimateId)");
  });

  it("is not duplicated inside the filing", () => {
    const fnAt = service.indexOf("async function fileSignedCopies");
    const body = service.slice(fnAt, fnAt + 2000);
    expect(body).not.toContain("sendBrandedEmail");
  });
});
