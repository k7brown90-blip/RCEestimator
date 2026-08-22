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

import { describe, expect, it } from "vitest";
import { renderEstimatePdf, type PdfEstimate } from "../src/services/issuedEstimatePdf";
import type { CompanyProfile } from "../src/services/companyProfile";

const PROFILE: CompanyProfile = {
  legalName: "Red Cedar Electric LLC",
  phone: "615-625-2163",
  email: "service@redcedarelectricllc.com",
  tagline: "Licensed & Insured",
  licenseNumber: null,
  licenseState: "TN",
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
