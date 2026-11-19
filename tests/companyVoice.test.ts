/**
 * The company speaks, not Kyle (Kyle, 2026-11-18, "Yes, company everywhere" — extending his 2026-10-30
 * booking-chat ruling to every customer email, text and voice line).
 *
 *   - the branded footer and header come from Settings → Company profile, and the Settings "Company name"
 *     field (`companyName`) is actually read;
 *   - no customer email is signed with a person's name.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { getCompanyProfile } from "../src/services/companyProfile";
import { brandedFooterHtml } from "../src/services/confirmationEmail";

beforeEach(async () => {
  await prisma.companySetting.deleteMany();
});

afterAll(async () => {
  await prisma.companySetting.deleteMany();
});

describe("the company profile feeds the branded footer", () => {
  it("reads the Settings 'Company name' field, phone and email", async () => {
    await prisma.companySetting.create({
      data: {
        key: "companyProfile",
        valueJson: JSON.stringify({ companyName: "Cedar Test Electric LLC", phone: "615-555-0100", email: "office@example.com" }),
      },
    });
    const profile = await getCompanyProfile();
    expect(profile.legalName).toBe("Cedar Test Electric LLC");
    const footer = brandedFooterHtml(profile);
    expect(footer).toContain("Cedar Test Electric LLC");
    expect(footer).toContain("615-555-0100");
    expect(footer).toContain("office@example.com");
    expect(footer).not.toMatch(/Kyle/);
  });

  it("falls back to the company's own defaults when Settings is empty or the name is blank", async () => {
    expect((await getCompanyProfile()).legalName).toBe("Red Cedar Electric LLC");
    await prisma.companySetting.create({ data: { key: "companyProfile", valueJson: JSON.stringify({ companyName: "  " }) } });
    expect((await getCompanyProfile()).legalName).toBe("Red Cedar Electric LLC");
  });

  it("escapes what was typed into Settings", () => {
    const footer = brandedFooterHtml({
      legalName: "A <b>&</b> Co", phone: "1", email: "x@example.com", tagline: "", mailingAddress: "", licenseNumber: null, licenseState: "TN", financingUrl: "https://example.com",
    });
    expect(footer).not.toContain("<b>");
    expect(footer).toContain("A &lt;b&gt;&amp;&lt;/b&gt; Co");
  });
});

describe("customer emails are signed by the company", () => {
  const files = ["issuedEstimateSend", "paymentReceipts", "financingEmail", "reviewRequest"];
  for (const f of files) {
    it(`${f}.ts has no personal sign-off`, () => {
      const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", `${f}.ts`), "utf8");
      expect(src).not.toMatch(/Thank you,<br>\s*Kyle/);
      expect(src).toContain("Thank you,<br>Red Cedar Electric LLC");
    });
  }
});
