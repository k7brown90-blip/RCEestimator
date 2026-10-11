/**
 * The two PDFs, asserted against the actual bytes.
 *
 * Kyle, 2026-08-19: *"the labor units and line item pricing will have to show for the company
 * copy… The customer only needs the final price of each option or combination of options."*
 *
 * These read the rendered PDF, not the code that renders it. A test that inspected the input data
 * would pass while the generator printed the wrong thing, and the whole risk here is a document
 * that gets handed to a customer with Kyle's labour hours on it.
 *
 * Every absence is paired with a presence. Asserting only that the customer's copy has no hours
 * would pass on a blank page.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { renderEstimatePdf, type PdfEstimate } from "../src/services/issuedEstimatePdf";
import type { PdfFinancing } from "../src/services/issuedEstimatePdfFinancing";
import type { CompanyProfile } from "../src/services/companyProfile";
import { buildQuoteFinancing, type FinancingPlan } from "../shared/financing";
import { DEFAULT_FINANCING_PLANS } from "../src/services/financingPlanDefaults";
import { getActiveFinancingPlans } from "../src/services/financingSettings";
import { getCompanyProfile } from "../src/services/companyProfile";

// The route / filed-copy / invoice-email tests at the bottom load the real app. Customer email is
// captured, never sent; nothing reaches Twilio or Google.
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
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { sendInvoiceEmail } from "../src/services/issuedEstimateSend";

const PROFILE: CompanyProfile = {
  legalName: "Red Cedar Electric LLC",
  phone: "615-625-2163",
  email: "service@redcedarelectricllc.com",
  tagline: "Licensed & Insured",
  licenseNumber: null,
  mailingAddress: "La Vergne, TN",
  licenseState: "TN",
  financingUrl: "https://www.mysynchrony.com/mmc/S6246031300",
};

/*
  The numbers are chosen so that no LINE total coincides with an option subtotal or the estimate
  total. The first version had Option A holding a single $750 line, which made its subtotal $750
  as well — so "the customer's copy shows no line price" failed against a subtotal it is supposed
  to show. The assertion was right and the fixture was lying to it.

    Option A   750 + 100  =  850
    Option B         350  =  350
    trip                     150
    total                  1350
*/
const ESTIMATE: PdfEstimate = {
  number: "2026-1099",
  revision: 1,
  title: "Fan and panel work",
  customerName: "A Customer",
  serviceAddress: "1 Test St, La Vergne, TN",
  scopeText: "Install fans and bond the water line.",
  total: 1350,
  tripCharge: 150,
  signedAt: null,
  signedByName: null,
  createdAt: new Date("2026-08-19T12:00:00Z"),
  lines: [
    {
      option: "A",
      description: "Ceiling Fan, Install and Balance, 48-inch",
      quantity: 2,
      lineTotal: 750,
      laborHours: 5,
      materialSell: 0,
      materialCost: 0,
    },
    {
      option: "A",
      description: "Fan Box, Fan-Rated",
      quantity: 2,
      lineTotal: 100,
      laborHours: 1,
      // Column E and column F: what it costs us, and what we charge.
      materialSell: 30,
      materialCost: 8,
    },
    {
      option: "B",
      description: "Ground Rod, driven",
      quantity: 1,
      lineTotal: 350,
      laborHours: 1.5,
      materialSell: 42.5,
      materialCost: 12.14,
    },
  ],
};

/**
 * Pull the drawn text back out of the finished PDF.
 *
 * pdfkit writes text as hex strings — `[<524345> 0] TJ` is "RCE" — so a plain substring search of
 * the bytes finds nothing. The FIRST version of this file did exactly that, and the result is
 * worth recording: every `not.toContain` assertion passed, because the text it was looking for
 * was unreadable rather than absent. Only the paired presence assertions failed and exposed it.
 *
 * That is the entire argument for pairing them. A test that had only checked "the customer's copy
 * contains no hours" would have been green, permanently, against a document it could not read.
 */
function extractText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const parts: string[] = [];
  for (const m of raw.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    if (m[1].length % 2 !== 0) continue;
    parts.push(Buffer.from(m[1], "hex").toString("latin1"));
  }
  // Joined with NOTHING. pdfkit splits a single word across runs for kerning — "Ceiling F" then
  // "an", "ESTIMA" then "TE " then "T" then "O" then "T" then "AL" — so any separator inserted
  // here would break the very substrings these tests look for.
  return parts.join("");
}

async function textOf(audience: "customer" | "company"): Promise<string> {
  return extractText(await renderEstimatePdf(ESTIMATE, audience, PROFILE));
}

describe("the customer's PDF", () => {
  it("renders the work, the options and the total", async () => {
    const text = await textOf("customer");
    // Presence first. Without this every absence below passes on an empty document.
    expect(text).toContain("2026-1099");
    expect(text).toContain("Ceiling Fan");
    expect(text).toContain("Option A");
    expect(text).toContain("Option B");
    expect(text).toContain("ESTIMATE TOTAL");
    expect(text).toContain("1350.00");
  });

  it("shows no labour hours anywhere", async () => {
    const text = await textOf("customer");
    expect(text).not.toContain("5.00 hr");
    expect(text).not.toContain("1.50 hr");
    expect(text).not.toContain("Labour to schedule");
  });

  it("shows no per-line price", async () => {
    const text = await textOf("customer");
    // The line totals. The estimate total and the option subtotals are allowed and asserted above.
    expect(text).not.toContain("750.00");
    expect(text).not.toContain("100.00");
    expect(text).not.toContain("42.50");
  });

  it("does not carry the material list", async () => {
    const text = await textOf("customer");
    expect(text).not.toContain("Material to order");
    expect(text).not.toContain("customer-supplied");
  });

  it("is not labelled as the company copy", async () => {
    expect(await textOf("customer")).not.toContain("COMPANY COPY");
  });
});

describe("the company's PDF", () => {
  it("carries the hours, the line prices and the material", async () => {
    const text = await textOf("company");
    expect(text).toContain("5.00 hr");
    expect(text).toContain("1.50 hr");
    expect(text).toContain("750.00");
    expect(text).toContain("42.50");
    expect(text).toContain("100.00");
  });

  it("lists the material to order, and the job summary Kyle asked for", async () => {
    /*
      Kyle, 2026-08-20:

        "Column E = company cost. Column F = what we charge... In the estimate column E is what we
         see to track spending... This is how it needs to be calculated and shown on the company
         copy with the total labor hours calculated into total job length."

      So four things have to be on it: what the material COSTS us, what it is CHARGED at, the
      labour, and the hours turned into days — not left as a number to convert in his head.
    */
    const text = await textOf("company");
    expect(text).toContain("Material to order");
    expect(text).toContain("Ground Rod");

    expect(text).toContain("Material cost (what we spend)");
    expect(text).toContain("20.14"); // 0 + 8.00 + 12.14, column E
    expect(text).toContain("Material charged");
    expect(text).toContain("72.50"); // 0 + 30.00 + 42.50, column F
    expect(text).toContain("7.50 hr"); // 5 + 1 + 1.5
    expect(text).toContain("Job length");
    expect(text).toContain("0.94 day(s)"); // 7.5 / 8
  });

  it("breaks each line into cost, charge, labour and total", async () => {
    // Cost and charge are different numbers doing different jobs. Collapsing them into one
    // "material" figure is what made the old company copy unreadable.
    const text = await textOf("company");
    expect(text).toContain("cost $8.00");
    expect(text).toContain("charge $30.00");
    expect(text).toContain("labour 1.00 hr = $70.00");
    expect(text).toContain("TOTAL $100.00");
  });

  it("never shows the COST on the customer's copy", async () => {
    // What a job costs Red Cedar is the one figure that must never cross over.
    const text = await textOf("customer");
    expect(text).not.toContain("12.14");
    expect(text).not.toContain("8.00");
    expect(text).not.toContain("Material cost");
    expect(text).not.toContain("Job length");
  });

  it("marks a zero-material line as customer-supplied rather than as free", async () => {
    // The ceiling fan is customer-supplied. Printing "$0.00 material" would read as a mistake;
    // saying nothing would leave Kyle wondering whether a part was forgotten.
    const text = await textOf("company");
    expect(text).toContain("customer-supplied");
    expect(text).not.toContain("Ceiling Fan, Install and Balance, 48-inch  × 2\n    $0.00 material");
  });

  it("says so when hours were never recorded, rather than printing 0.00", async () => {
    // Estimates issued before the company fields existed have null hours. Rendering those as
    // 0.00 would claim the work takes no time — on a document used for scheduling.
    const legacy: PdfEstimate = {
      ...ESTIMATE,
      lines: [{ ...ESTIMATE.lines[0], laborHours: null, materialSell: null, materialCost: null }],
    };
    const text = extractText(await renderEstimatePdf(legacy, "company", PROFILE));
    expect(text).toContain("hours not recorded");
    expect(text).toContain("material not recorded");
  });

  it("is labelled so it cannot be mistaken for the customer's", async () => {
    expect(await textOf("company")).toContain("COMPANY COPY");
  });
});

describe("both audiences agree about the work", () => {
  it("describe the same lines and the same total", async () => {
    const customer = await textOf("customer");
    const company = await textOf("company");
    for (const shared of ["2026-1099", "Ceiling Fan", "Ground Rod", "Option A", "Option B", "1350.00"]) {
      expect(customer, `customer copy missing ${shared}`).toContain(shared);
      expect(company, `company copy missing ${shared}`).toContain(shared);
    }
  });
});

describe("the option names on the PDF", () => {
  /*
    Kyle, 2026-08-20: *"Show the option names on the pdf, that's necessary."*

    It printed "Option A" / "Option B" / "Option C", which tells whoever is holding the paper
    nothing about what is in them. The name IS the scope — "Exterior pathway lights" is what makes
    the document usable for ordering and for talking the customer through what they bought.
  */
  const named = {
    ...ESTIMATE,
    options: [
      { option: "A" as const, label: "What the client called for", note: "The diagnostic and the OC sensors.", subtotal: 467.83 },
      { option: "B" as const, label: "Exterior pathway lights", note: null, subtotal: 842.86 },
    ],
  };

  it("prints the name beside the letter, and the description under it", async () => {
    const text = extractText(await renderEstimatePdf(named, "company", PROFILE));
    expect(text).toContain("Option A");                          // the letter is still there
    expect(text).toContain("What the client called for");        // and now so is the scope
    expect(text).toContain("Exterior pathway lights");
    expect(text).toContain("The diagnostic and the OC sensors.");
  });

  it("falls back to the bare letter for an estimate issued before names existed", async () => {
    // Paired: the document must still print its work, not just avoid crashing.
    const text = extractText(await renderEstimatePdf({ ...ESTIMATE, options: undefined }, "company", PROFILE));
    expect(text).toContain("Option A");
    expect(text).toContain("Ceiling Fan");
  });

  it("drops an option the customer declined once the estimate is signed", async () => {
    const signed = {
      ...named,
      signedAt: new Date("2026-08-20T22:10:00Z"),
      signedByName: "Adnan Mehmedovic",
      selectedOptions: ["A" as const],
    };
    const text = extractText(await renderEstimatePdf(signed, "company", PROFILE));
    // Took A, declined B. Their agreement is what they bought.
    expect(text).toContain("What the client called for");
    expect(text).not.toContain("Exterior pathway lights");
  });

  it("still shows every option while the estimate is unsigned", async () => {
    // The mirror of the above: before signing, nothing has been declined, so nothing is hidden.
    const text = extractText(await renderEstimatePdf(named, "company", PROFILE));
    expect(text).toContain("What the client called for");
    expect(text).toContain("Exterior pathway lights");
  });
});

describe("a signed document is an invoice, for what they actually bought", () => {
  /*
    Kyle, 2026-08-21: *"The signed estimates need to be labeled invoices"* and *"if someone checks
    specific options rather than all that the final invoice produced represents their actual
    selection and doesn't treat it as if they signed off on all of the options."*

    The second one was the dangerous half. The line list already dropped declined options, but the
    total still printed `estimate.total` — the whole quoted amount. A customer who took one option
    out of three would have been handed a document showing one option and billing for three.
  */
  const OPTIONS = [
    { option: "A" as const, label: "Fans", note: null, subtotal: 850 },
    { option: "B" as const, label: "Bonding", note: null, subtotal: 350 },
  ];

  it("says Estimate, and quotes everything, before it is signed", async () => {
    const text = extractText(await renderEstimatePdf({ ...ESTIMATE, options: OPTIONS }, "customer", PROFILE));
    expect(text).toContain("Estimate 2026-1099");
    expect(text).toContain("ESTIMATE TOTAL");
    expect(text).toContain("$1350.00");
    expect(text).not.toContain("INVOICE");
  });

  it("says Invoice once it is signed", async () => {
    const signed = {
      ...ESTIMATE, options: OPTIONS,
      signedAt: new Date("2026-08-21T10:00:00Z"), signedByName: "A Customer",
      selectedOptions: ["A" as const, "B" as const],
    };
    const text = extractText(await renderEstimatePdf(signed, "customer", PROFILE));
    expect(text).toContain("Invoice 2026-1099");
    expect(text).toContain("INVOICE TOTAL");
    // Took everything, so the number is unchanged.
    expect(text).toContain("$1350.00");
  });

  it("bills ONLY the option they took, not the whole quote", async () => {
    const signed = {
      ...ESTIMATE, options: OPTIONS,
      signedAt: new Date("2026-08-21T10:00:00Z"), signedByName: "A Customer",
      selectedOptions: ["A" as const],   // declined B ($350)
    };
    const text = extractText(await renderEstimatePdf(signed, "customer", PROFILE));

    // A ($850) + the trip charge ($150), charged once.
    expect(text).toContain("$1000.00");
    // The bug this pins: the full quote must not appear anywhere on the document.
    expect(text).not.toContain("$1350.00");
    // Paired — the work they DID buy is still on it, so this cannot pass on an empty render.
    expect(text).toContain("Ceiling Fan, Install and Balance, 48-inch");
    expect(text).not.toContain("Ground Rod, driven");
  });

  it("does not send Kyle shopping for a declined option's material", async () => {
    const signed = {
      ...ESTIMATE, options: OPTIONS,
      signedAt: new Date("2026-08-21T10:00:00Z"), signedByName: "A Customer",
      selectedOptions: ["A" as const],
    };
    const text = extractText(await renderEstimatePdf(signed, "company", PROFILE));
    // Paired: the ordering list is present and holds option A's material...
    expect(text).toContain("Material to order");
    expect(text).toContain("Fan Box, Fan-Rated");
    // ...and not the ground rod, which the customer declined.
    expect(text).not.toContain("Ground Rod, driven");
  });

  it("still prints an estimate that predates options at its frozen total", async () => {
    // No option rows at all. The fallback has to keep working — every estimate already in a
    // customer's hands looks like this.
    const legacy = { ...ESTIMATE, options: undefined, signedAt: new Date(), selectedOptions: [] };
    const text = extractText(await renderEstimatePdf(legacy, "customer", PROFILE));
    expect(text).toContain("$1350.00");
    expect(text).toContain("Ceiling Fan, Install and Balance, 48-inch");
  });
});

describe("the job summary describes the job he is actually doing", () => {
  /*
    Kyle's signed 2026-1021 reported "Labour: 9.73 hr" and "Job length: 1.22 day(s)" on a job the
    customer had cut down to one option. This block is what he schedules and buys against, so a
    figure covering declined work books days he does not need and budgets money he will not spend.
  */
  const OPTIONS = [
    { option: "A" as const, label: "Fans", note: null, subtotal: 850 },
    { option: "B" as const, label: "Bonding", note: null, subtotal: 350 },
  ];
  const signedA = {
    ...ESTIMATE, options: OPTIONS,
    signedAt: new Date("2026-08-21T10:00:00Z"), signedByName: "A Customer",
    selectedOptions: ["A" as const],
  };

  it("counts only the hours of the options taken", async () => {
    const text = extractText(await renderEstimatePdf(signedA, "company", PROFILE));
    // Option A is 5 hr + 1 hr. Option B's 1.5 hr was declined and must not be scheduled.
    expect(text).toContain("6.00 hr");
    expect(text).not.toContain("7.50 hr");
  });

  it("counts only the money of the options taken", async () => {
    const text = extractText(await renderEstimatePdf(signedA, "company", PROFILE));
    // Material cost: A is 0 + 8. B's 12.14 was declined.
    expect(text).toContain("$8.00");
    expect(text).not.toContain("$20.14");
  });

  it("still summarises the whole job when nothing was declined", async () => {
    // Paired against the above: the scoping must not fire on an unsigned or fully-taken estimate.
    const text = extractText(await renderEstimatePdf({ ...ESTIMATE, options: OPTIONS }, "company", PROFILE));
    expect(text).toContain("7.50 hr");
  });
});

describe("the material check's working, on the company copy", () => {
  /*
    Kyle, 2026-08-21: the job-level check reduces what a customer is charged, silently by design.
    The company copy is where the silence ends — it prints what the tiers wanted, the ceiling that
    governed, and what it cost. The customer's copy shows the resulting price and none of the
    machinery.
  */
  const CAPPED = {
    ...ESTIMATE,
    materialCaps: {
      A: { uncappedSell: 1656.05, cappedSell: 1355.55, ceiling: 2.5, bandLabel: "$250–999", reduction: 300.5, applied: true },
      B: { uncappedSell: 100, cappedSell: 100, ceiling: 3.5, bandLabel: "under $250", reduction: 0, applied: false },
    },
  };

  it("prints the cap on the company copy — only where it actually bit", async () => {
    const text = extractText(await renderEstimatePdf(CAPPED, "company", PROFILE));
    expect(text).toContain("material capped at 2.5x");
    expect(text).toContain("$300.50 off the per-item tiers");
    // Option B sat under its ceiling; a "capped" line for it would be a false confession.
    expect(text).not.toContain("3.5x");
  });

  it("never shows the machinery to the customer", async () => {
    const text = extractText(await renderEstimatePdf(CAPPED, "customer", PROFILE));
    // Paired presence: the document rendered.
    expect(text).toContain("2026-1099");
    // Not /ceiling/i — this estimate installs a Ceiling Fan, and the first version of this
    // assertion failed on the fan. The cap's own words are what must not appear.
    expect(text).not.toMatch(/capped|per-item tiers|\$300\.50 off/i);
  });

  it("renders an estimate frozen before the check existed", async () => {
    // materialCapsJson is null on every pre-cap estimate; the parse hands the PDF null.
    const text = extractText(await renderEstimatePdf({ ...ESTIMATE, materialCaps: null }, "company", PROFILE));
    expect(text).toContain("Job summary");
    expect(text).not.toMatch(/capped/i);
  });
});

describe("the multi-option discount, on the invoice", () => {
  /*
    Kyle, 2026-08-22: the third gate. The frozen comboCap is the only figure the PDF may use — it
    was written at signing, and the invoice, the signed page and the emailed copy all read it.
  */
  const OPTIONS = [
    { option: "A" as const, label: "Fans", note: null, subtotal: 850 },
    { option: "B" as const, label: "Bonding", note: null, subtotal: 350 },
  ];
  const signedBoth = {
    ...ESTIMATE,
    options: OPTIONS,
    signedAt: new Date("2026-08-22T10:00:00Z"),
    signedByName: "A Customer",
    selectedOptions: ["A" as const, "B" as const],
    comboCap: { reduction: 150, ceiling: 1.5, bandLabel: "$1,000–2,999", applied: true },
  };

  it("takes the frozen discount off the billed figure and says so", async () => {
    const text = extractText(await renderEstimatePdf(signedBoth, "customer", PROFILE));
    // 850 + 350 + 150 trip − 150 discount.
    expect(text).toContain("Multi-option material discount");
    expect(text).toContain("-$150.00");
    expect(text).toContain("$1200.00");
    expect(text).not.toContain("$1350.00");
  });

  it("prints the working on the company copy only", async () => {
    const company = extractText(await renderEstimatePdf(signedBoth, "company", PROFILE));
    expect(company).toContain("Combined selection priced as one job");
    expect(company).toContain("Labour untouched");
    const customer = extractText(await renderEstimatePdf(signedBoth, "customer", PROFILE));
    expect(customer).not.toContain("priced as one job");
  });

  it("bills the plain figure when the gate did not apply", async () => {
    const noDiscount = { ...signedBoth, comboCap: { reduction: 0, ceiling: 2.5, bandLabel: "$250–999", applied: false } };
    const text = extractText(await renderEstimatePdf(noDiscount, "customer", PROFILE));
    expect(text).toContain("$1350.00");
    expect(text).not.toContain("Multi-option material discount");
  });

  it("renders an invoice signed before the gate existed", async () => {
    // comboCapJson is null on every pre-gate signature; the parse hands the PDF null.
    const legacy = { ...signedBoth, comboCap: null };
    const text = extractText(await renderEstimatePdf(legacy, "customer", PROFILE));
    expect(text).toContain("$1350.00");
    expect(text).not.toContain("Multi-option material discount");
  });
});

describe("the programme discount, on the document", () => {
  /*
    Kyle, 2026-08-22: military/senior 5%, whole job, capped $250. Signed documents read the
    FROZEN amount only; unsigned quote the live 5% so paper and screen agree.
  */
  const OPTIONS = [
    { option: "A" as const, label: "Fans", note: null, subtotal: 850 },
    { option: "B" as const, label: "Bonding", note: null, subtotal: 350 },
  ];

  it("quotes the live 5% on an unsigned estimate", async () => {
    const text = extractText(await renderEstimatePdf(
      { ...ESTIMATE, options: OPTIONS, discountType: "military" }, "customer", PROFILE));
    // 5% of $1,350 = $67.50.
    expect(text).toContain("Military discount (5%)");
    expect(text).toContain("-$67.50");
    expect(text).toContain("$1282.50");
  });

  it("bills the FROZEN amount once signed, not a recompute", async () => {
    const signed = {
      ...ESTIMATE, options: OPTIONS,
      signedAt: new Date("2026-08-22T10:00:00Z"), signedByName: "A Customer",
      selectedOptions: ["A" as const, "B" as const],
      discountType: "senior",
      // Deliberately different from what a live 5% would give (67.50): if the document shows
      // 67.50 it recomputed, and a rate change could restate a signed price.
      discount: { amount: 60, base: 1350 },
    };
    const text = extractText(await renderEstimatePdf(signed, "customer", PROFILE));
    expect(text).toContain("Senior discount (5%)");
    expect(text).toContain("-$60.00");
    expect(text).toContain("$1290.00");
    expect(text).not.toContain("$67.50");
  });

  it("prints a custom percentage with its figure, uncapped (Kyle, 2026-09-01)", async () => {
    const text = extractText(await renderEstimatePdf(
      { ...ESTIMATE, options: OPTIONS, discountType: "custom", discountPercent: 12.5 }, "customer", PROFILE));
    expect(text).toContain("Discount (12.5%)");
    expect(text).not.toMatch(/Military discount|Senior discount/);
  });

  it("stacks after the combination discount, not before", async () => {
    const signed = {
      ...ESTIMATE, options: OPTIONS,
      signedAt: new Date("2026-08-22T10:00:00Z"), signedByName: "A Customer",
      selectedOptions: ["A" as const, "B" as const],
      comboCap: { reduction: 150, ceiling: 1.5, bandLabel: "$1,000–2,999", applied: true },
      discountType: "military",
      discount: { amount: 60, base: 1200 },
    };
    const text = extractText(await renderEstimatePdf(signed, "customer", PROFILE));
    // 1350 − 150 combo − 60 programme.
    expect(text).toContain("$1140.00");
  });

  it("shows nothing when no programme applies", async () => {
    const text = extractText(await renderEstimatePdf({ ...ESTIMATE, options: OPTIONS }, "customer", PROFILE));
    expect(text).not.toMatch(/Military discount|Senior discount/);
    expect(text).toContain("$1350.00");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Financing options (Synchrony) on the CUSTOMER copy - Kyle, 2026-10-09, final layout 2026-10-10
// ═══════════════════════════════════════════════════════════════════════════════════════════════
/*
  Kyle, 2026-10-09: *"I don't see the financing plan on the client pdf that they get emailed. They
  should at very least get an overview of what the 4 plans monthly cost would be while looking at
  the pdf they sign."*
  Kyle, 2026-10-10: *"synchrony provides all the legal details we just need them to know what the
  APR is, the total months, and the monthly payment amount and the link."* ... *"With plan id."* ...
  *"do not forget the apr %."*

  The final layout: a heading, one line per active plan in Settings order, and the Synchrony link.
  No per-option table, no deposit/fee note, no "Financing terms" page. The figures are the shared
  calculator's (shared/financing.ts) - these tests compare the PDF to `buildQuoteFinancing`, and pin
  one $1,350 total by hand so a bug shared by both would still show. Synchrony's discount rates
  (Red Cedar's cost) never appear.

  Presence is paired with every absence below: text that can't be read would pass any "not".
*/

/** Flatten extracted text: win-ansi dash/apostrophe back to Unicode, and ALL whitespace gone (PDF line wraps drop spaces). */
const flat = (s: string) => s.replace(/\x97/g, "—").replace(/\x92/g, "’").replace(/\s+/g, "");
const pdfFlat = (buf: Buffer) => flat(extractText(buf));

const PLANS: FinancingPlan[] = DEFAULT_FINANCING_PLANS.map((p) => ({ ...p, disclosure: { ...p.disclosure } }));
const perMonth = (n: number) => `$${n.toLocaleString("en-US")}/mo`;
const HEADING = "Financing options (Synchrony)";
const SYNCHRONY_URL = "https://www.mysynchrony.com/mmc/S6246031300";

/**
 * The lines the PDF must print for `total`: the shared calculator's whole-dollar monthly figure per
 * plan, in Settings order, in Kyle's exact format.
 */
function expectedLines(plans: FinancingPlan[], total: number, covered = 0): string[] {
  const fin = buildQuoteFinancing(plans, { row: total }, covered)!;
  return fin.plans.map((p) => {
    const offer = fin.bySelection.row.offers.find((o) => o.planNumber === p.planNumber)!;
    const terms = p.type === "reduced_apr" ? `${p.apr}% APR` : "No interest if paid in full";
    return `Plan ${p.planNumber} · ${terms} · ${p.months} months · ${perMonth(offer.monthly)}`;
  });
}

/** The section exactly as drawn: heading, then each line, with nothing between them. */
const sectionFlat = (lines: string[]) => flat(HEADING) + lines.map(flat).join("");

/** supertest: collect the response body as a Buffer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const binary = (r: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on("data", (c: Buffer) => chunks.push(c));
  r.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("the customer's PDF carries the Synchrony financing options", () => {
  const OPTIONS = [
    { option: "A" as const, label: "Fans", note: null, subtotal: 850 },
    { option: "B" as const, label: "Bonding", note: null, subtotal: 350 },
  ];
  const FIN: PdfFinancing = { plans: PLANS };
  const withFin = (over: Partial<PdfEstimate> = {}): PdfEstimate => ({ ...ESTIMATE, options: OPTIONS, financing: FIN, ...over });

  it("prints the heading, one exact line per plan in Settings order, then the link - on the printed total", async () => {
    const text = pdfFlat(await renderEstimatePdf(withFin(), "customer", PROFILE));
    expect(text).toContain("ESTIMATETOTAL"); // rendered
    expect(text).toContain("$1350.00");
    // $1,350 worked by hand: deposit 450, balance 900, + half of each plan's cost -> financed;
    // 965 -> 17, 964 -> 17, 920 -> 156, 924 -> 53. APR for reduced-APR plans, Synchrony's wording for deferred.
    const pinned = [
      "Plan 965 · 11.99% APR · 86 months · $17/mo",
      "Plan 964 · 10.99% APR · 82 months · $17/mo",
      "Plan 920 · No interest if paid in full · 6 months · $156/mo",
      "Plan 924 · No interest if paid in full · 18 months · $53/mo",
    ];
    expect(text).toContain(sectionFlat(pinned));
    // ... and those are what the shared calculator says (no second formula in the PDF).
    expect(expectedLines(PLANS, 1350)).toEqual(pinned);
    // The link follows the last plan line.
    expect(text).toContain(sectionFlat(pinned) + flat(`Finance this project: ${SYNCHRONY_URL}`));
    // The section sits under the printed total.
    expect(text.indexOf(flat(HEADING))).toBeGreaterThan(text.indexOf("ESTIMATETOTAL"));
  });

  it("an estimate with no option rows gets the same lines on the document's own total", async () => {
    const text = pdfFlat(await renderEstimatePdf({ ...ESTIMATE, financing: FIN }, "customer", PROFILE));
    expect(text).toContain(sectionFlat(expectedLines(PLANS, 1350)));
  });

  it("figures come from the shared calculator on a bigger total, thousands comma included", async () => {
    const text = pdfFlat(await renderEstimatePdf(withFin({ total: 9000 }), "customer", PROFILE));
    expect(text).toContain("$9000.00");
    const lines = expectedLines(PLANS, 9000);
    expect(lines.some((l) => /\$\d,\d{3}\/mo$/.test(l))).toBe(true); // the fixture exercises a comma
    expect(text).toContain(sectionFlat(lines));
  });

  it("the link is the Settings financing URL, printed in full and clickable", async () => {
    const url = "https://financing.example.test/apply?ref=rce&plan=1";
    const buf = await renderEstimatePdf(withFin(), "customer", { ...PROFILE, financingUrl: url });
    const text = pdfFlat(buf);
    expect(text).toContain(flat(`Finance this project: ${url}`)); // legible on paper
    expect(text).not.toContain(SYNCHRONY_URL); // it is the Settings value, not a literal
    // Clickable: a link annotation pointing at the same URL.
    expect(buf.toString("latin1")).toContain(`/URI (${url})`);
  });

  it("is lines and a link only: no table, no deposit/fee note, no Financing terms page, no plan descriptions", async () => {
    const buf = await renderEstimatePdf(withFin(), "customer", PROFILE);
    const text = pdfFlat(buf);
    expect(text).toContain(flat(HEADING)); // paired presence
    expect(text).not.toContain(flat("Financing terms"));
    expect(text).not.toContain(flat("Selection")); // the old table's header
    expect(text).not.toContain(flat("All options")); // the old table's row
    expect(text).not.toContain(flat("1/3 deposit"));
    expect(text).not.toContain(flat("financing fee"));
    expect(text).not.toContain(flat("Estimated monthly payments"));
    expect(text).not.toContain(flat("until paid in full")); // the stored plan description
    for (const p of PLANS) {
      expect(p.disclosure.explanation.length).toBeGreaterThan(100); // the fixture is the real text, not a stub
      expect(text).not.toContain(flat(p.disclosure.explanation.slice(0, 80)));
      expect(text).not.toContain(flat(p.disclosure.important));
      expect(text).not.toContain(flat(p.disclosure.terms.slice(0, 60)));
    }
    // No terms page: the financing adds no page of its own (the same estimate prints as many pages without it).
    const pages = (b: Buffer) => (b.toString("latin1").match(/\/Type \/Page\b(?!s)/g) ?? []).length;
    const plain = await renderEstimatePdf({ ...ESTIMATE, options: OPTIONS }, "customer", PROFILE);
    expect(pages(buf)).toBe(pages(plain));
  });

  it("never prints Synchrony's discount rates (Red Cedar's cost)", async () => {
    const text = pdfFlat(await renderEstimatePdf(withFin(), "customer", PROFILE));
    // Paired presence: the customer's own APR IS there, so this is not a blank document.
    expect(text).toContain("10.99%APR");
    for (const rate of ["6.1%", "7.25%", "7.1%", "10.6%", "7.25", "discountRate", "discountRatePct"]) {
      expect(text.toLowerCase()).not.toContain(rate.toLowerCase());
    }
    expect(text).not.toMatch(/discount\s*rate/i);
  });

  it("leaves the company copy without any financing section", async () => {
    const text = pdfFlat(await renderEstimatePdf(withFin(), "company", PROFILE));
    expect(text).toContain("COMPANYCOPY"); // it rendered, and it is the company copy
    expect(text).not.toContain(flat(HEADING));
    expect(text).not.toContain(flat("Financing options"));
    expect(text).not.toContain(flat("Finance this project"));
    expect(text).not.toContain(SYNCHRONY_URL);
    expect(text).not.toContain("/mo");
  });

  it("prints nothing when no financing is passed", async () => {
    const text = pdfFlat(await renderEstimatePdf({ ...ESTIMATE, options: OPTIONS }, "customer", PROFILE));
    expect(text).toContain("ESTIMATETOTAL");
    expect(text).not.toContain(flat("Financing options"));
    expect(text).not.toContain(flat("Finance this project"));
    expect(text).not.toContain("/mo");
  });

  it("a signed invoice is worked on what they bought, the INVOICE TOTAL printed above", async () => {
    const signed = withFin({
      signedAt: new Date("2026-10-09T10:00:00Z"), signedByName: "A Customer",
      selectedOptions: ["A" as const],
    });
    const text = pdfFlat(await renderEstimatePdf(signed, "customer", PROFILE));
    expect(text).toContain("INVOICETOTAL");
    expect(text).toContain("$1000.00");
    expect(text).toContain(flat("Accepted by A Customer"));
    expect(text).toContain(sectionFlat(expectedLines(PLANS, 1000)));
    expect(text).not.toContain(flat("Financing terms"));
  });

  it("a signed invoice with change orders joined is worked on the whole invoice's total", async () => {
    const signed = withFin({
      signedAt: new Date("2026-10-09T10:00:00Z"), signedByName: "A Customer",
      selectedOptions: ["A" as const, "B" as const],
      invoice: {
        number: "2026-1099",
        documents: [
          { number: "2026-1099", title: "Fans and bonding", kind: "invoice", billedTotal: 1350, signedAt: new Date("2026-10-09T10:00:00Z") },
          { number: "2026-1099-CO1", title: "Extra outlet", kind: "change_order", billedTotal: 650, signedAt: new Date("2026-10-10T10:00:00Z") },
        ],
        billedTotal: 2000,
        totalPaid: 0,
        balance: 2000,
        financingFee: null,
      },
    });
    const text = pdfFlat(await renderEstimatePdf(signed, "customer", PROFILE));
    expect(text).toContain("INVOICETOTAL");
    expect(text).toContain(sectionFlat(expectedLines(PLANS, 2000)));
    expect(text).not.toContain(sectionFlat(expectedLines(PLANS, 1350)));
  });

  it("a home-warranty claim: the lines are worked on the homeowner's share, as the YOUR TOTAL beside them", async () => {
    const warranty = { company: "RELY Home", claimNumber: "C-1", authNumber: null, coveredAmount: 500, note: null, setAt: "2026-10-01T00:00:00.000Z" } as unknown as PdfEstimate["warranty"];
    const text = pdfFlat(await renderEstimatePdf(withFin({ warranty }), "customer", PROFILE));
    expect(text).toContain("YOURTOTAL");
    expect(text).toContain(sectionFlat(expectedLines(PLANS, 1350, 500)));
    expect(text).not.toContain(sectionFlat(expectedLines(PLANS, 1350)));
  });

  it("only the plans passed are printed (a two-plan snapshot)", async () => {
    const two = PLANS.filter((p) => p.planNumber === "965" || p.planNumber === "920");
    const text = pdfFlat(await renderEstimatePdf(withFin({ financing: { plans: two } }), "customer", PROFILE));
    expect(text).toContain(sectionFlat(expectedLines(two, 1350)));
    expect(text).not.toContain("Plan964");
    expect(text).not.toContain("Plan924");
  });

  it("an inactive plan is not printed, and a list with nothing active prints no section", async () => {
    const off = PLANS.map((p) => (p.planNumber === "964" ? { ...p, active: false } : p));
    const text = pdfFlat(await renderEstimatePdf(withFin({ financing: { plans: off } }), "customer", PROFILE));
    expect(text).toContain(flat(HEADING));
    expect(text).not.toContain("Plan964");
    const none = pdfFlat(await renderEstimatePdf(withFin({ financing: { plans: PLANS.map((p) => ({ ...p, active: false })) } }), "customer", PROFILE));
    expect(none).toContain("ESTIMATETOTAL");
    expect(none).not.toContain(flat(HEADING));
    expect(none).not.toContain(flat("Finance this project"));
  });
});

// ─── The real doors: the route, the filed copy, and the emailed invoice ────────────────────────

describe("financing reaches the PDF through the route, the filed copy and the invoice email", () => {
  const MARK = "PDFFIN";
  const SUP = "PDFFIN-SUP";
  let customerId: string;
  let propertyId: string;
  let draftId: string;

  const cleanup = async () => {
    const ests = await prisma.issuedEstimate.findMany({ where: { number: { startsWith: `0000-${MARK}` } }, select: { id: true } });
    const ids = ests.map((e) => e.id);
    await prisma.document.deleteMany({ where: { issuedEstimateId: { in: ids } } });
    await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: ids } } });
    await prisma.payment.deleteMany({ where: { estimateId: { in: ids } } });
    await prisma.financingFee.deleteMany({ where: { estimateId: { in: ids } } });
    await prisma.issuedEstimate.updateMany({ where: { id: { in: ids } }, data: { changeOrderForId: null } });
    await prisma.issuedEstimate.deleteMany({ where: { id: { in: ids } } });
    await prisma.priceBookDraftEstimate.deleteMany({ where: { title: `${MARK} draft` } });
    await prisma.priceBookSupplier.deleteMany({ where: { id: SUP } });
    await prisma.property.deleteMany({ where: { name: `${MARK} property` } });
    await prisma.customer.deleteMany({ where: { name: { startsWith: MARK } } });
  };

  beforeAll(async () => {
    await cleanup();
    const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "pdffin@example.com" } });
    customerId = customer.id;
    const property = await prisma.property.create({
      data: { customerId, name: `${MARK} property`, addressLine1: "1 Financing Way", city: "La Vergne", state: "TN", postalCode: "37086" },
    });
    propertyId = property.id;
    await prisma.priceBookSupplier.create({ data: { id: SUP, name: `${MARK} Supply`, quotable: "YES" } });
    const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: SUP } });
    draftId = draft.id;
  });

  afterAll(cleanup);

  /** Option A 350 + trip 75 = 425; Option B 200 + trip 75 = 275; both 625. */
  async function issue(suffix: string, opts: { signed?: boolean; snapshotPlans?: FinancingPlan[]; rawSnapshot?: string; changeOrderForId?: string } = {}) {
    return prisma.issuedEstimate.create({
      data: {
        number: `0000-${MARK}${suffix}`,
        token: `${"f".repeat(40)}${suffix.padStart(24, "0")}`.slice(0, 64),
        status: opts.signed ? "signed" : "sent",
        draftId,
        customerId,
        serviceAddressId: propertyId,
        customerName: `${MARK} Customer`,
        customerEmail: "pdffin@example.com",
        serviceAddress: "1 Financing Way, La Vergne, TN",
        title: "Fans and bonding",
        workSubtotal: 550,
        tripCharge: 75,
        total: 625,
        sentAt: new Date(),
        sentTo: "pdffin@example.com",
        financingPlansJson: opts.rawSnapshot
          ?? (opts.snapshotPlans
            ? JSON.stringify({ version: 1, takenAt: new Date().toISOString(), plans: opts.snapshotPlans })
            : null),
        changeOrderForId: opts.changeOrderForId ?? null,
        ...(opts.signed
          ? {
              signedAt: new Date(),
              signerName: "Pdf Customer",
              signedChannel: "email",
              selectedOptions: ["A", "B"],
              comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
            }
          : {}),
        options: {
          create: [
            { option: "A", label: "Fans", subtotal: 350, lineCount: 1 },
            { option: "B", label: "Bonding", subtotal: 200, lineCount: 1 },
          ],
        },
      },
    });
  }

  const TOTALS = { A: 425, B: 275, "A+B": 625 };

  it("GET /issued-estimates/:id/pdf: the customer copy has the plan lines from Settings' plans (no snapshot), the company copy none", async () => {
    const est = await issue("1");
    const active = await getActiveFinancingPlans();
    const { financingUrl } = await getCompanyProfile();

    const res = await request(app).get(`/issued-estimates/${est.id}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const text = pdfFlat(res.body as Buffer);
    // The estimate's own printed total (625), a line per plan, then the Settings link.
    expect(text).toContain(sectionFlat(expectedLines(active, TOTALS["A+B"])));
    expect(text).toContain(flat(`Finance this project: ${financingUrl}`));
    expect(text).not.toContain(flat("Financing terms"));
    expect(text).not.toContain(flat(active[0].disclosure.terms.slice(0, 60)));

    const co = await request(app).get(`/issued-estimates/${est.id}/pdf?audience=company`).buffer(true).parse(binary);
    expect(co.status).toBe(200);
    const coText = pdfFlat(co.body as Buffer);
    expect(coText).toContain("COMPANYCOPY");
    expect(coText).not.toContain(flat("Financing options"));
    expect(coText).not.toContain("/mo");
  });

  it("uses the plans FROZEN on the estimate, not today's Settings", async () => {
    const two = PLANS.filter((p) => p.planNumber === "964" || p.planNumber === "924");
    const est = await issue("2", { snapshotPlans: two });
    const res = await request(app).get(`/issued-estimates/${est.id}/pdf`).buffer(true).parse(binary);
    const text = pdfFlat(res.body as Buffer);
    expect(text).toContain(sectionFlat(expectedLines(two, TOTALS["A+B"])));
    expect(text).toContain("Plan964");
    expect(text).not.toContain("Plan965");
    expect(text).not.toContain("Plan920");
  });

  it("a change order gets no financing overview (financing is worked on the whole invoice)", async () => {
    const root = await issue("3", { signed: true });
    const co = await issue("4", { signed: true, changeOrderForId: root.id });
    const res = await request(app).get(`/issued-estimates/${co.id}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const text = pdfFlat(res.body as Buffer);
    expect(text).toContain("INVOICETOTAL"); // rendered
    expect(text).not.toContain(flat("Financing options"));
    expect(text).not.toContain(flat("Financing terms"));
  });

  it("the filed customer copy (/documents/:id/pdf) carries it; the filed company copy does not", async () => {
    const est = await issue("5", { signed: true });
    const customerDoc = await prisma.document.create({
      data: { type: "signed_estimate", pdfUrl: "x", issuedEstimateId: est.id, propertyId },
    });
    const companyDoc = await prisma.document.create({
      data: { type: "signed_estimate_company", pdfUrl: "x", issuedEstimateId: est.id, propertyId },
    });
    const active = await getActiveFinancingPlans();
    const get = (id: string) => request(app).get(`/documents/${id}/pdf`).buffer(true).parse(binary);
    const cust = await get(customerDoc.id);
    expect(cust.status).toBe(200);
    const custText = pdfFlat(cust.body as Buffer);
    expect(custText).toContain("INVOICETOTAL");
    expect(custText).toContain(sectionFlat(expectedLines(active, 625)));
    const comp = await get(companyDoc.id);
    expect(comp.status).toBe(200);
    const compText = pdfFlat(comp.body as Buffer);
    expect(compText).toContain("COMPANYCOPY");
    expect(compText).not.toContain(flat("Financing options"));
  });

  it("a frozen snapshot that is garbled offers no financing - it does not quietly fall back to today's Settings", async () => {
    const est = await issue("7", { rawSnapshot: "{not json" });
    const res = await request(app).get(`/issued-estimates/${est.id}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const text = pdfFlat(res.body as Buffer);
    expect(text).toContain("ESTIMATETOTAL"); // rendered
    expect(text).not.toContain(flat("Financing options"));
    expect(text).not.toContain(flat("Financing terms"));
    expect(text).not.toContain("/mo");
  });

  it("a signed invoice with a financing fee already applied does not offer the four plans again", async () => {
    const est = await issue("8", { signed: true });
    await prisma.financingFee.create({
      data: {
        estimateId: est.id, planNumber: "964", planDescription: "10.99% APR until paid in full",
        discountRatePct: 7.25, feeBaseCents: 41667, feeCents: 1510, appliedBy: "test",
      },
    });
    const res = await request(app).get(`/issued-estimates/${est.id}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const text = pdfFlat(res.body as Buffer);
    expect(text).toContain("INVOICETOTAL");
    expect(text).toContain(flat("Financing fee")); // the appendix names the plan chosen
    expect(text).not.toContain(flat("Financing options"));
    expect(text).not.toContain(flat("Financing terms"));
    // The emailed invoice is the same document.
    emailMock.sendBrandedEmail.mockClear();
    expect((await sendInvoiceEmail(prisma, est.id, { sentBy: "test" })).ok).toBe(true);
    const args = emailMock.sendBrandedEmail.mock.calls[0][0] as { attachments: Array<{ filename: string; content: Buffer }> };
    const emailed = pdfFlat(args.attachments.find((a) => a.filename.endsWith(".pdf"))!.content);
    expect(emailed).toContain(flat("Financing fee"));
    expect(emailed).not.toContain(flat("Financing options"));
  });

  it("a signed invoice paid in full does not offer financing for money no longer owed", async () => {
    const est = await issue("9", { signed: true });
    await prisma.payment.create({
      data: { estimateId: est.id, customerId, amount: 625, method: "cash", kind: "final", status: "paid", paidAt: new Date() },
    });
    const res = await request(app).get(`/issued-estimates/${est.id}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const text = pdfFlat(res.body as Buffer);
    expect(text).toContain("INVOICETOTAL");
    expect(text).not.toContain(flat("Financing options"));
    expect(text).not.toContain("/mo");
  });

  it("the invoice email attaches the PDF with the plan lines, and the email BODY still states no credit terms", async () => {
    const est = await issue("6", { signed: true });
    emailMock.sendBrandedEmail.mockClear();
    const sent = await sendInvoiceEmail(prisma, est.id, { sentBy: "test" });
    expect(sent.ok).toBe(true);
    expect(emailMock.sendBrandedEmail).toHaveBeenCalledTimes(1);
    const args = emailMock.sendBrandedEmail.mock.calls[0][0] as {
      bodyHtml: string;
      attachments: Array<{ filename: string; content: Buffer }>;
    };
    const pdf = args.attachments.find((a) => a.filename.endsWith(".pdf"))!;
    const text = pdfFlat(pdf.content);
    const active = await getActiveFinancingPlans();
    expect(text).toContain(sectionFlat(expectedLines(active, 625)));
    expect(text).not.toContain(flat("Financing terms"));
    // The body: no payment, APR or promo language (tests/issuedEstimate.test.ts and
    // tests/financingEmail.test.ts pin the estimate and financing emails the same way).
    expect(args.bodyHtml).not.toMatch(/\/mo\b|APR|no interest|0%|promo|monthly payment/i);
  });
});
