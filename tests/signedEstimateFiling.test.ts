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
    const fileAt = body.indexOf("fileAndNotifySignature");
    expect(updateAt).toBeGreaterThan(-1);
    expect(fileAt, "the filing call was not found").toBeGreaterThan(-1);
    expect(updateAt, "the signature must be written BEFORE the filing").toBeLessThan(fileAt);

    // `void` and not `await`: the caller's result must not wait on an email.
    expect(body).toMatch(/void fileAndNotifySignature\(/);
    expect(body).not.toMatch(/await fileAndNotifySignature\(/);
  });

  it("returns success on the line after the filing is fired", () => {
    const signAt = service.indexOf("async function applySignature");
    const body = service.slice(signAt, service.indexOf("\n}", signAt));
    expect(body.indexOf("fileAndNotifySignature")).toBeLessThan(body.indexOf("return { ok: true"));
  });

  it("guards the filing and the notification separately", () => {
    // A failure to notify must not prevent the filing, and vice versa. One try around both would
    // mean a dead Gmail token also losing the copy on the account.
    const fnAt = service.indexOf("async function fileAndNotifySignature");
    expect(fnAt).toBeGreaterThan(-1);
    const body = service.slice(fnAt, fnAt + 2600);
    expect(body).toMatch(/document[\s\S]{0,400}\.catch\(/);
    expect(body).toMatch(/sendBrandedEmail\([\s\S]{0,900}\}\)\.catch\(/);
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
    const handler = app.slice(at, at + 2400);
    const branchAt = handler.indexOf("doc.issuedEstimateId");
    const fsAt = handler.indexOf('await import("node:fs")');
    expect(branchAt, "the estimate branch was not found").toBeGreaterThan(-1);
    expect(branchAt, "the estimate branch must come BEFORE the filesystem read").toBeLessThan(fsAt);
    expect(handler).toContain("renderEstimatePdf");
  });

  it("files the COMPANY copy — the one with the material and the hours", () => {
    // Kyle's copy on the account is the one he orders and schedules from. Filing the customer
    // view would give him a document he cannot work off.
    const fnAt = service.indexOf("async function fileAndNotifySignature");
    const body = service.slice(fnAt, fnAt + 2600);
    expect(body).toContain("audience=company");
    expect(body).toContain('type: "signed_estimate"');
  });
});

describe("the notification", () => {
  it("goes to the operator, never to the customer", () => {
    const fnAt = service.indexOf("async function fileAndNotifySignature");
    const body = service.slice(fnAt, fnAt + 2600);
    expect(body).toContain("SUMMARY_EMAIL");
    expect(body).not.toContain("est.customerEmail");
  });

  it("says who signed, for how much, and which estimate", () => {
    const fnAt = service.indexOf("async function fileAndNotifySignature");
    const body = service.slice(fnAt, fnAt + 2600);
    expect(body).toContain("SIGNED — estimate");
    expect(body).toContain("signerName");
    expect(body).toContain("est.total.toFixed(2)");
  });
});
