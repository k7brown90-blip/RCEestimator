/**
 * The customer has to be able to pick and choose between the options.
 *
 * Kyle, 2026-08-20, on estimate 2026-1021:
 *
 *   *"We still have some work to do on the estimate options... the options are not persisting into
 *    the pdf or allowing to pick and choose between them. Only adding them all together."*
 *
 * and, from the element picker on the same estimate:
 *
 *   *"I don't see anywhere for the client to pick and choose the options they want. It combines
 *    them all automatically."*
 *
 * ── WHAT WAS ACTUALLY BROKEN ───────────────────────────────────────────────────────────────────
 *
 * Nothing was losing data. Every frozen line already carried its option letter and always had. But
 * a letter on a line is not an option: there was nowhere to record what an option is called, what
 * it covers, or what it costs on its own, so the customer page could only render one flat table
 * under one ESTIMATE TOTAL. Three separate pieces of work arrived as a single take-it-or-leave-it
 * number, and the estimate he printed was that same flat page.
 *
 * ── WHY THE ABSENCE ASSERTIONS ARE ALL PAIRED ──────────────────────────────────────────────────
 *
 * The same trap this codebase keeps falling into: a test that only proves the customer sees no
 * prices passes on an EMPTY page. Every "must not contain" below sits next to a "must contain" on
 * the same render, so a builder that silently returned nothing fails instead of going green.
 */

import { describe, expect, it } from "vitest";
import { renderEstimatePage } from "../src/services/issuedEstimateRender";
import type { IssuedEstimateWithLines } from "../src/services/issuedEstimateService";

type Opt = "A" | "B" | "C";

function line(option: Opt, description: string, lineTotal: number, quantity = 1) {
  return {
    id: `${option}-${description}`,
    estimateId: "e1",
    itemId: description,
    description,
    quantity,
    unitPrice: lineTotal / quantity,
    lineTotal,
    sortOrder: 0,
    option,
    laborHours: 2,
    materialSell: lineTotal / 2,
    materialCost: lineTotal / 4,
  };
}

function option(o: Opt, subtotal: number, lineCount: number, label: string | null, note: string | null) {
  return { id: `o-${o}`, estimateId: "e1", option: o, label, note, subtotal, lineCount };
}

/** Estimate 2026-1021's shape: three options, a real spread of prices. */
function estimate(over: Partial<Record<string, unknown>> = {}): IssuedEstimateWithLines {
  return {
    id: "e1",
    number: "2026-1021",
    revision: 1,
    status: "draft",
    token: "t".repeat(64),
    customerName: "Adnan Mehmedovic",
    customerEmail: null,
    customerPhone: null,
    serviceAddress: "2 Ingram Blvd, La Vergne, TN, 37086",
    title: "ACAR Diagnostics, OC Sensors, Exterior Pathway lights",
    scopeText: null,
    includedText: null,
    validDays: 30,
    workSubtotal: 1610.69,
    tripCharge: 0,
    tripWaived: true,
    total: 1610.69,
    createdAt: new Date("2026-08-20T21:47:00Z"),
    signedAt: null,
    signerName: null,
    signatureImage: null,
    selectedOptions: [],
    supersededBy: null,
    lines: [
      line("A", "ACAR diagnostic", 467.83),
      line("B", "Exterior pathway light", 792.14, 6),
      line("C", "Flood light removal", 350.72),
    ],
    options: [
      option("A", 467.83, 1, "What the client called for", "The diagnostic and the OC sensors."),
      option("B", 792.14, 1, "Exterior pathway lights", null),
      option("C", 350.72, 1, null, null),
    ],
    ...over,
  } as unknown as IssuedEstimateWithLines;
}

describe("the customer can choose", () => {
  const html = renderEstimatePage(estimate());

  it("renders each option separately, with its own price", () => {
    // The presence half. Without these three, every absence assertion below is vacuous.
    expect(html).toContain("What the client called for");
    expect(html).toContain("Exterior pathway lights");
    expect(html).toContain("$467.83");
    expect(html).toContain("$792.14");
    expect(html).toContain("$350.72");
  });

  it("gives every option a tick box, which is the whole complaint", () => {
    const boxes = html.match(/class="optpick"/g) ?? [];
    expect(boxes).toHaveLength(3);
    expect(html).toContain('data-option="A"');
    expect(html).toContain('data-option="B"');
    expect(html).toContain('data-option="C"');
  });

  it("falls back to the bare letter for an option that was never renamed", () => {
    // C has no label. It must still be identifiable rather than rendering as a nameless block.
    expect(html).toContain("Option C");
  });

  it("shows the short description under the name when there is one", () => {
    expect(html).toContain("The diagnostic and the OC sensors.");
  });

  it("still shows no line price, no hours and no unit words", () => {
    // The rule that predates options and survives them: the customer gets the price of an option,
    // never the anatomy of it. Paired with the presence assertions above.
    expect(html).not.toContain("laborHours");
    expect(html).not.toMatch(/\bper foot\b/i);
    expect(html).not.toMatch(/\bhours?\b/i);
    // The individual line's money must not appear — only the option subtotals, which are asserted
    // present above. 467.83 is an option subtotal AND its only line's total here, so the check
    // uses B, whose line total and option subtotal differ from the others.
    expect(html).not.toContain("396.07"); // B's materialSell, half of 792.14
  });

  it("carries the selection into the signature, defaulting to everything offered", () => {
    // The estimate quotes the full scope, so it opens at the full price. Unticking is the choice.
    expect(html).toContain('name="selectedOptions"');
    expect(html).toContain('value="A,B,C"');
  });
});

describe("what a single-option estimate does", () => {
  const html = renderEstimatePage(
    estimate({
      lines: [line("A", "ACAR diagnostic", 467.83)],
      options: [option("A", 467.83, 1, "What the client called for", null)],
      total: 467.83,
    }),
  );

  it("offers no tick boxes, because a choice of one is not a choice", () => {
    // Paired: the option is still rendered, it simply cannot be unticked into an empty sale.
    expect(html).toContain("What the client called for");
    expect(html).not.toContain('class="optpick"');
  });
});

describe("an estimate issued before options existed", () => {
  const html = renderEstimatePage(estimate({ options: [], selectedOptions: [] }));

  it("still renders its work as the flat list it was issued as", () => {
    // The regression that would matter most: old documents in customers' hands must not render
    // as an empty page just because they have no option rows.
    expect(html).toContain("ACAR diagnostic");
    expect(html).toContain("Exterior pathway light");
    expect(html).toContain("$1610.69");
    expect(html).not.toContain('class="optpick"');
  });
});

describe("once it is signed", () => {
  const signed = estimate({
    signedAt: new Date("2026-08-20T22:10:00Z"),
    signerName: "Adnan Mehmedovic",
    selectedOptions: ["A", "C"],
  });
  const html = renderEstimatePage(signed);

  it("shows what was bought and drops what was declined", () => {
    expect(html).toContain("What the client called for"); // A, taken
    expect(html).toContain("Option C"); // C, taken
    // B was declined. It has no business on their agreement.
    expect(html).not.toContain("Exterior pathway lights");
    expect(html).not.toContain("$792.14");
  });

  it("totals what was bought, not what was offered", () => {
    // 467.83 + 350.72, trip waived at 0. NOT the 1610.69 that was quoted.
    expect(html).toContain("$818.55");
    expect(html).not.toContain("$1610.69");
  });

  it("offers no tick boxes after the fact", () => {
    expect(html).not.toContain('class="optpick"');
  });
});

describe("the word Kyle will not advertise", () => {
  /*
    Kyle, 2026-08-20: *"The pdf should not say the word 'contractor'. Contactor should not appear
    in any advertisement anywhere."*

    The letterhead read "... · Licensed Electrical Contractor". In Tennessee "contractor" is a
    licence classification rather than a synonym for tradesman, so this is a compliance line and
    not a wording preference — which is why it is a test and not just an edit.

    Asserted on the WHOLE rendered page, including markup and script, because an HTML comment or a
    hidden attribute is still shipped to the customer and still one "view source" from being read.
    The first version of this fix put the word back in an HTML comment explaining its removal.
  */
  it("never appears on the customer's page, in any casing, anywhere in the source", () => {
    for (const html of [
      renderEstimatePage(estimate()),
      renderEstimatePage(estimate({ signedAt: new Date(), selectedOptions: ["A"] })),
      renderEstimatePage(estimate({ options: [] })),
    ]) {
      // Paired, so this cannot pass on an empty render — and the pairing is the licence line
      // itself, which is what replaced the offending words. Kyle, 2026-08-20: "Licensed
      // Electrician #61828 can take it's place."
      expect(html).toContain("RED CEDAR ELECTRIC LLC");
      expect(html).toContain("Licensed Electrician #61828");
      expect(html).not.toMatch(/contractor/i);
    }
  });
});

describe("the multi-option discount, on the customer's page", () => {
  /*
    Kyle, 2026-08-22: *"the savings add up and help push the sale of more work simply by lowing
    the cost of material."* The page must SHOW the saving — an invisible incentive sells nothing —
    while never carrying the cost figures that produce it.
  */

  // Two options, each at its own band ceiling; together they cross into 1.5x territory.
  const discountable = () =>
    estimate({
      tripCharge: 0,
      tripWaived: false,
      total: 3400,
      lines: [
        { ...line("A", "Wire the addition", 1700), materialCost: 600, materialSell: 1500 },
        { ...line("B", "Panel work", 1700), materialCost: 600, materialSell: 1500 },
      ],
      options: [
        option("A", 1700, 1, "Wiring", null),
        option("B", 1700, 1, "Panel", null),
      ],
    });

  it("ships finished combination prices, never a cost figure", () => {
    const html = renderEstimatePage(discountable());
    // The combo table is in the page for the live total…
    expect(html).toContain('"A+B"');
    expect(html).toContain("2200"); // 3400 − 1200 in combination
    // …and the number that must never appear is the company's cost.
    expect(html).not.toContain("600.0");
    expect(html).not.toMatch(/materialCost/);
  });

  it("opens at the discounted all-options price with the saving named", () => {
    const html = renderEstimatePage(discountable());
    expect(html).toContain("Multi-option material discount");
    expect(html).toContain("$2200.00");
    expect(html).toContain("$1200.00");
  });

  it("shows no saving row when combining earns nothing", () => {
    // The original fixture blends at 2x, under every ceiling it can reach — the row would be a
    // false promise, and it is hidden server-side, not just zeroed.
    const html = renderEstimatePage(estimate());
    expect(html).toContain('id="comboSaving"');
    expect(html).toContain('style="display:none;"');
  });

  it("uses the STORED discount once signed — never a live recompute", () => {
    const signed = renderEstimatePage(
      discountable() && {
        ...discountable(),
        signedAt: new Date("2026-08-22T10:00:00Z"),
        signerName: "A Customer",
        selectedOptions: ["A", "B"],
        // Frozen at signature with a figure deliberately DIFFERENT from what a live recompute
        // would give (1200). If the page shows 1100, it read the stored record; 1200 means it
        // recomputed, and a band edit could restate a signed price.
        comboCapJson: JSON.stringify({ reduction: 1100, ceiling: 1.5, bandLabel: "$1,000–2,999", applied: true }),
      },
    );
    expect(signed).toContain("$1100.00");
    expect(signed).toContain("$2300.00"); // 3400 − 1100
    expect(signed).not.toContain("$2200.00");
  });
});

describe("the band schedule frozen at issue", () => {
  /*
    Kyle, 2026-08-22: the bands live in Rate Config now, so he can retune them. This is what stops
    a retune from restating a price already quoted — the customer page prices combinations with
    the schedule stored on the estimate, not with whatever the workbook says today.
  */
  const twoOptions = () =>
    estimate({
      tripCharge: 0,
      total: 3400,
      lines: [
        { ...line("A", "Wire the addition", 1700), materialCost: 600, materialSell: 1500 },
        { ...line("B", "Panel work", 1700), materialCost: 600, materialSell: 1500 },
      ],
      options: [option("A", 1700, 1, "Wiring", null), option("B", 1700, 1, "Panel", null)],
    });

  it("prices combinations with the STORED schedule, not the current one", () => {
    // Stored schedule is deliberately generous: 2.5x at every size. $1,200 cost x 2.5 = $3,000,
    // which is exactly what the lines already charge — so the discount is nothing.
    const generous = [
      { upTo: 1000, ceiling: 2.5, label: "under $1,000" },
      { upTo: 5000, ceiling: 2.5, label: "$1,000–4,999" },
      { upTo: 20000, ceiling: 2.5, label: "$5,000–19,999" },
      { upTo: null, ceiling: 2.5, label: "$20,000+" },
    ];
    const html = renderEstimatePage(
      estimate({ ...twoOptions(), jobBandsJson: JSON.stringify(generous) }) as never,
    );
    // Under today's code schedule this combination saves $1,200. Under the stored one it saves
    // nothing — so a visible saving here would prove the page ignored the freeze.
    expect(html).toContain('id="comboSaving"');
    expect(html).toContain('style="display:none;"');
    expect(html).not.toContain("$2200.00");
  });

  it("falls back to the code schedule when the estimate predates the freeze", () => {
    // Paired with the above: null must still price, and must give the code's answer.
    const html = renderEstimatePage(estimate({ ...twoOptions(), jobBandsJson: null }) as never);
    expect(html).toContain("Multi-option material discount");
    expect(html).toContain("$2200.00");
  });
});
