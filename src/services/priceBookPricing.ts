/**
 * Price-book pricing engine — the app's side of workbook parity.
 *
 * Every function here reproduces one formula from price-book.xlsx. The workbook is the
 * source of truth; this file is a transcription, and each function names the cell it was
 * transcribed from so a reader can re-verify it against the source rather than trusting
 * this comment. The authoritative record of those formulas is
 * scripts/price-book/workbook-mapping.json (`pricingRules`).
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE:
 *
 *  1. NEVER MAKE UP A NUMBER. A blank price is `null`, not 0. A blank labour unit is
 *     `null`, not 0. Nothing here substitutes, interpolates, or defaults a missing
 *     figure — CLAUDE.md: "a confident invented figure is the most dangerous thing you
 *     can hand me".
 *
 *  2. NO SILENT SUBSTITUTION. Cost resolves at the ACTIVE SUPPLIER only. If that
 *     supplier does not carry the item there is no fallback to another supplier's
 *     price; the component is unpriced and the assembly reads incomplete. That is
 *     Kyle's 2026-08-08 ruling and it is the defect the supplier migration existed to
 *     remove.
 *
 *  3. THE APP IS NEVER MORE OPTIMISTIC THAN THE BOOK. Where the workbook says
 *     INCOMPLETE, the app refuses to produce a customer price and says why. It does
 *     not print a $0 line. The workbook's own testing phase exists because a QUOTABLE
 *     flag proved false (F-82: a row reading "MATERIAL COMPLETE" beside a $0.00
 *     material total), so the refusal is the point, not a nicety.
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export type Quotable = "YES" | "NO" | "NEVER";

export interface MarkupTiers {
  /** Rate Config B10 — cost under $1.00 */ tier1: number;
  /** Rate Config B11 — $1.00–$9.99 */ tier2: number;
  /** Rate Config B12 — $10.00–$49.99 */ tier3: number;
  /** Rate Config B13 — $50.00–$199.99 */ tier4: number;
  /** Rate Config B14 — $200.00 and up */ tier5: number;
}

export interface RateConfig {
  /** B2. Kyle's standing ruling is 150; the cell is applied by the 02:00 task. */
  billedLaborRate: number | null;
  /** B4 */ inspectionCoordination: number | null;
  /** B5 — folded into B4, retained because the workbook still adds it */
  inspectionFolded: number | null;
  /** B6 */ utilityStandby: number | null;
  /** B7 — currently blank; a blank permit fee contributes nothing */
  permitFee: number | null;
  /** B67 */ jobFixedCost: number | null;
  /** B161 */ activeSupplier: string | null;
  markupTiers: MarkupTiers;
}

export interface SupplierPriceRow {
  itemId: string;
  supplierId: string;
  unitCost: number | null;
  quotable: Quotable;
  /** Blank/null when not quotable — the structural quarantine. */
  quotableKey: string | null;
}

export interface AtomicRow {
  itemId: string;
  unit?: string | null;
  rowType?: string | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
}

export interface AssemblyComponentRow {
  itemId: string;
  quantity: number;
}

export interface AssemblyRow {
  assemblyId: string;
  status?: string | null;
  superseded: boolean;
  /** Frozen literal from the workbook — see PriceBookAssembly.totalLaborNormal. */
  totalLaborNormal: number | null;
  permitRequiredRaw?: string | null;
  utilityStandbyRaw?: string | null;
  heightAccessAdderHours?: number | null;
}

// ─── Atomic-level resolution ────────────────────────────────────────────────────

/**
 * Atomics!K — Cost Basis Used.
 *
 *   =IFERROR(INDEX('Supplier Prices'!$F:$F,
 *             MATCH($A2&"|"&'Rate Config'!$B$161, 'Supplier Prices'!$L:$L, 0)), "")
 *
 * The MATCH is against the Quotable Key column, which the workbook computes as
 * `=IF(K="YES", A&"|"&B, "")`. A non-quotable row therefore has a BLANK key and can
 * never be matched — that blank is the quarantine, and it is reproduced here rather
 * than re-implemented as a filter, so the two behave identically.
 *
 * Returns null when the active supplier does not carry the item. Null is the answer,
 * not an error and not zero.
 */
export function resolveCostBasis(
  itemId: string,
  activeSupplierId: string | null,
  supplierPrices: SupplierPriceRow[]
): { costBasis: number | null; supplierId: string | null } {
  if (!activeSupplierId) return { costBasis: null, supplierId: null };

  const wanted = `${itemId}|${activeSupplierId}`;
  const match = supplierPrices.find((p) => p.quotableKey === wanted);
  if (!match) return { costBasis: null, supplierId: null };

  // Defence in depth. The blank-key rule above already makes this unreachable; if it
  // ever fires, the quarantine has been broken upstream and that must be loud.
  if (match.quotable !== "YES") {
    throw new Error(
      `QUARANTINE BREACH: ${itemId} resolved a cost basis against supplier ` +
        `${match.supplierId} whose quotable status is ${match.quotable}. A non-quotable ` +
        `price must be structurally incapable of reaching a quote.`
    );
  }
  if (match.unitCost === null || match.unitCost === undefined) {
    return { costBasis: null, supplierId: null };
  }
  return { costBasis: match.unitCost, supplierId: match.supplierId };
}

/**
 * Supplier Prices!F — Unit Cost $ (calc).
 *   =IF(D="/c", C/100, IF(D="/m", C/1000, IF(E>0, C/E, C)))
 */
export function computeUnitCost(
  priceAsPrinted: number | null,
  pricedUom: string | null,
  packQty: number | null
): number | null {
  if (priceAsPrinted === null || priceAsPrinted === undefined) return null;
  const uom = (pricedUom ?? "").trim();
  if (uom === "/c") return priceAsPrinted / 100;
  if (uom === "/m") return priceAsPrinted / 1000;
  if (packQty !== null && packQty !== undefined && packQty > 0) return priceAsPrinted / packQty;
  return priceAsPrinted;
}

/**
 * Supplier Prices!L — Quotable Key.  =IF(K="YES", A&"|"&B, "")
 */
export function computeQuotableKey(
  itemId: string,
  supplierId: string,
  quotable: Quotable
): string | null {
  return quotable === "YES" ? `${itemId}|${supplierId}` : null;
}

/**
 * Atomics!W — Markup Tier (auto).
 *   =IF(N(K)=0,"awaiting cost",IF(K<1,"T1",IF(K<10,"T2",IF(K<50,"T3",IF(K<200,"T4","T5")))))
 *
 * N(K)=0 is true for a blank K *and* for a real 0.00 cost. The workbook makes no
 * distinction, so neither does this — matching it is the requirement.
 */
export function markupTierFor(costBasis: number | null): string {
  const k = costBasis ?? 0;
  if (k === 0) return "awaiting cost";
  if (k < 1) return "T1";
  if (k < 10) return "T2";
  if (k < 50) return "T3";
  if (k < 200) return "T4";
  return "T5";
}

/** The multiplier the tier maps to — Rate Config B10:B14. */
export function markupMultiplierFor(costBasis: number | null, tiers: MarkupTiers): number | null {
  const k = costBasis ?? 0;
  if (k === 0) return null;
  if (k < 1) return tiers.tier1;
  if (k < 10) return tiers.tier2;
  if (k < 50) return tiers.tier3;
  if (k < 200) return tiers.tier4;
  return tiers.tier5;
}

/**
 * Atomics!X — Sell Price per Unit.
 *   =IF(N(K)=0,"",K*IF(K<1,B10,IF(K<10,B11,IF(K<50,B12,IF(K<200,B13,B14)))))
 * Blank cost basis produces a blank sell price — never zero.
 */
export function sellPriceFor(costBasis: number | null, tiers: MarkupTiers): number | null {
  const mult = markupMultiplierFor(costBasis, tiers);
  if (mult === null || costBasis === null) return null;
  return costBasis * mult;
}

// ─── Assembly-level computation ─────────────────────────────────────────────────

export interface ComputedComponent {
  itemId: string;
  quantity: number;
  costBasis: number | null;
  sellPerUnit: number | null;
  extendedCost: number;
  extendedSell: number;
  unpriced: boolean;
}

export interface ComputedAssembly {
  assemblyId: string;
  laborHoursAdjusted: number | null;
  laborDollars: number | null;
  materialCost: number;
  materialSell: number;
  jobAdderHours: number;
  jobAdderDollars: number | null;
  permitFee: number | null;
  totalFlatRate: number | null;
  componentsUnpriced: number;
  componentsTotal: number;
  materialComplete: string;
  totalJobHours: number | null;
  jobFixedCost: number | null;
  totalWithFixedCost: number | null;
  components: ComputedComponent[];
}

/**
 * Assemblies!P — Job Adder Hours.
 *   =IF(LEFT(AI,2)="NO",0,B4+B5)+IF(LEFT(AJ,2)="NO",0,B6)+N(AL)
 *
 * The two-character LEFT() test is reproduced verbatim. The cells read
 * "NO - MANUALLY ADDED BY USER WHEN REQUIRED (Kyle 2026-08-06)", so anything not
 * starting "NO" turns the adder ON. Re-interpreting this as a boolean would change
 * which rows carry two hours of adder — the block Rate Config B135 names as the single
 * largest source of overpricing.
 */
export function computeJobAdderHours(assembly: AssemblyRow, rc: RateConfig): number {
  const startsNo = (v: string | null | undefined) =>
    (v ?? "").trim().slice(0, 2).toUpperCase() === "NO";

  const inspection = startsNo(assembly.permitRequiredRaw)
    ? 0
    : (rc.inspectionCoordination ?? 0) + (rc.inspectionFolded ?? 0);
  const standby = startsNo(assembly.utilityStandbyRaw) ? 0 : rc.utilityStandby ?? 0;
  const height = assembly.heightAccessAdderHours ?? 0; // N(AL) coerces blank to 0
  return inspection + standby + height;
}

/**
 * Reproduces the assembly row: N, O, U, W, L, M, P, Q, R, S, X, AF, AG.
 *
 * Material cost/sell use N() semantics — an unpriced component contributes ZERO to the
 * money columns while incrementing the unpriced counter. That is deliberate in the
 * workbook and is exactly why the COUNTER, not the total, is what says a number is
 * incomplete. Anything reading the total alone will read an underpriced job as a cheap
 * one (F-87: AS-006's $424.41 presenting as a complete outlet price while buying zero
 * conductors).
 */
export function computeAssembly(
  assembly: AssemblyRow,
  components: AssemblyComponentRow[],
  atomicCost: Map<string, { costBasis: number | null; sellPerUnit: number | null }>,
  rc: RateConfig
): ComputedAssembly {
  const computed: ComputedComponent[] = components.map((c) => {
    const resolved = atomicCost.get(c.itemId) ?? { costBasis: null, sellPerUnit: null };
    const cost = resolved.costBasis ?? 0; // N() coercion
    const sell = resolved.sellPerUnit ?? 0; // N() coercion
    return {
      itemId: c.itemId,
      quantity: c.quantity,
      costBasis: resolved.costBasis,
      sellPerUnit: resolved.sellPerUnit,
      extendedCost: c.quantity * cost,
      extendedSell: c.quantity * sell,
      // Assemblies!U — =IF(N(Atomics!K)=0,1,0). Matches the workbook: a genuine 0.00
      // cost counts as unpriced too.
      unpriced: cost === 0,
    };
  });

  const materialCost = computed.reduce((s, c) => s + c.extendedCost, 0);
  const materialSell = computed.reduce((s, c) => s + c.extendedSell, 0);
  const componentsUnpriced = computed.filter((c) => c.unpriced).length;
  const componentsTotal = computed.length;

  // Assemblies!L — =F. Kyle 2026-08-11: difficulty is a field observation, so adjusted
  // hours equal Total Labor Normal. The pre-2026-08-11 graded formula is preserved in
  // column AP and is NOT applied.
  const laborHoursAdjusted = assembly.totalLaborNormal;

  const rate = rc.billedLaborRate;
  const laborDollars =
    laborHoursAdjusted === null || rate === null ? null : laborHoursAdjusted * rate;

  const jobAdderHours = computeJobAdderHours(assembly, rc);
  const jobAdderDollars = rate === null ? null : jobAdderHours * rate;

  const permitFee = rc.permitFee; // Assemblies!R — ='Rate Config'!$B$7, currently blank

  // Assemblies!S — =M+O+Q+IF(ISNUMBER(R),R,0)
  const totalFlatRate =
    laborDollars === null || jobAdderDollars === null
      ? null
      : laborDollars + materialSell + jobAdderDollars + (typeof permitFee === "number" ? permitFee : 0);

  const totalJobHours = laborHoursAdjusted === null ? null : laborHoursAdjusted + jobAdderHours;
  const jobFixedCost = rc.jobFixedCost;
  const totalWithFixedCost =
    totalFlatRate === null || jobFixedCost === null ? null : totalFlatRate + jobFixedCost;

  // Assemblies!W — =IF(U=0,"COMPLETE","INCOMPLETE - "&U&" of "&V&" unpriced")
  const materialComplete =
    componentsUnpriced === 0
      ? "COMPLETE"
      : `INCOMPLETE - ${componentsUnpriced} of ${componentsTotal} unpriced`;

  return {
    assemblyId: assembly.assemblyId,
    laborHoursAdjusted,
    laborDollars,
    materialCost,
    materialSell,
    jobAdderHours,
    jobAdderDollars,
    permitFee,
    totalFlatRate,
    componentsUnpriced,
    componentsTotal,
    materialComplete,
    totalJobHours,
    jobFixedCost,
    totalWithFixedCost,
    components: computed,
  };
}

// ─── Quote gate ─────────────────────────────────────────────────────────────────

export interface QuoteRefusal {
  quotable: false;
  assemblyId: string;
  reasons: string[];
  /** The arithmetic is still returned so the office can see WHAT is missing and price
   *  the gap. It is explicitly not a customer number. */
  computed: ComputedAssembly;
}

export interface QuoteAccepted {
  quotable: true;
  assemblyId: string;
  warnings: string[];
  computed: ComputedAssembly;
}

export type QuoteResult = QuoteRefusal | QuoteAccepted;

export interface QuoteOptions {
  /**
   * "customer" is the gate that guards a number a customer will see. "internal" lets
   * the office and the parity harness compute the same arithmetic without the gate.
   */
  context: "customer" | "internal";
  /** True when Rate Config B2 did not read Kyle's ruled $150 at import time. */
  rateProvisional?: boolean;
  provisionalReason?: string | null;
}

/**
 * The refusal gate. Returns a REASON, never a $0 line.
 *
 * Kyle's estimator requirement, verbatim: if a component has no price under the
 * selected supplier, the quote reads incomplete. The workbook already computes that
 * verdict; this function is what stops the app being more optimistic than the book.
 */
export function quoteAssembly(
  assembly: AssemblyRow,
  computed: ComputedAssembly,
  opts: QuoteOptions
): QuoteResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (assembly.superseded) {
    reasons.push(
      `Assembly ${assembly.assemblyId} is marked "${assembly.status}" in the workbook. ` +
        `A superseded row is not a product; it is retained as history.`
    );
  }

  if (computed.componentsUnpriced > 0) {
    const missing = computed.components.filter((c) => c.unpriced).map((c) => c.itemId);
    reasons.push(
      `${computed.materialComplete}. No price at the active supplier for: ${missing.join(", ")}. ` +
        `There is no fallback to another supplier's price — that substitution is forbidden ` +
        `(Kyle 2026-08-08). Price the item, change the active supplier, or quote this line by hand.`
    );
  }

  if (computed.componentsTotal === 0) {
    reasons.push(
      `Assembly ${assembly.assemblyId} resolves no material components at all. Its total is ` +
        `labour only, which may be correct (AS-003 after the cable sweep) but cannot be issued ` +
        `as a material-complete price without a ruling.`
    );
  }

  if (computed.laborHoursAdjusted === null) {
    reasons.push(`No labour hours on the row — the workbook's Total Labor Normal is blank.`);
  }

  if (computed.totalFlatRate === null) {
    reasons.push(
      `Total could not be computed. Billed labour rate (Rate Config B2) is missing, so no ` +
        `labour dollars exist. A rate is Kyle's number to set, not this pipeline's to assume.`
    );
  }

  // ── Pipeline-added guard, flagged as an addition rather than slipped in ──
  // The prompt requires that 201.34 must not be imported "silently" into live pricing
  // while Kyle's ruled rate is $150. Blocking the CUSTOMER context (and only that) is
  // this pipeline's interpretation of "not silently", not a Kyle instruction. If he
  // wants provisional numbers quotable, this is the single line to change.
  if (opts.rateProvisional && opts.context === "customer") {
    reasons.push(
      `PROVISIONAL RATE — refusing to issue a customer price. ` +
        (opts.provisionalReason ??
          `Rate Config B2 does not match Kyle's ruled $150/hr ` +
            `(decisions/2026-08-11-billed-rate-and-no-memberships.md).`) +
        ` The cell is the 02:00 task's lane; this pipeline will not override it.`
    );
  } else if (opts.rateProvisional) {
    warnings.push(
      `Computed at a PROVISIONAL labour rate. ` + (opts.provisionalReason ?? "Rate Config B2 is not $150/hr.")
    );
  }

  // The assembly totals are a SHELL. Every row swept on 2026-08-09 carries walkthrough
  // and field-measured lines that are deliberately not in the template.
  warnings.push(
    `Assembly totals are the SHELL only. Cable and other continuous-length product is a ` +
      `required field-measured line, and breakers are walkthrough-counted — neither is in ` +
      `this total. Issuing the shell as an all-in price turns a removal into a discount.`
  );

  if (reasons.length > 0) {
    return { quotable: false, assemblyId: assembly.assemblyId, reasons, computed };
  }
  return { quotable: true, assemblyId: assembly.assemblyId, warnings, computed };
}

// ─── Independent evaluation of the frozen labour formula ────────────────────────

/**
 * Evaluate an assembly's Total Labor Normal formula (Assemblies!F) from its TEXT.
 *
 * WHY THIS EXISTS. Every assembly's labour formula is literal arithmetic —
 * "=4*0.25+4*0.05+(4/100)*30+(4/100)*10" — and references no cell. If the parity
 * harness simply read Excel's answer and multiplied it by the rate, the labour half of
 * parity would be checking the workbook against itself. Evaluating the expression here
 * makes it a real second opinion: two independent evaluators of the same source text
 * must agree.
 *
 * Deliberately NOT a general expression engine. It accepts digits, + - * / ( ) . and
 * whitespace and nothing else, and it is fed only strings that came out of the
 * workbook's own formula cells. Anything containing a cell reference, a function call,
 * or any other character is REFUSED rather than coerced — an unparseable formula
 * returns null and the harness reports it as unverifiable instead of guessing a number.
 */
export function evaluateLiteralArithmetic(formula: string | null | undefined): number | null {
  if (!formula) return null;
  let src = String(formula).trim();
  if (src.startsWith("=")) src = src.slice(1);
  if (src === "") return null;

  // Reject anything that is not pure arithmetic. A cell reference (Atomics!K176), a
  // function name, or a stray character means this is not a frozen literal and must
  // not be evaluated as one.
  if (!/^[0-9+\-*/().\s]+$/.test(src)) return null;

  // Recursive-descent parser. No eval(), no Function() — this string is data.
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    for (;;) {
      ws();
      const op = src[i];
      if (op !== "+" && op !== "-") return left;
      i++;
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;
    for (;;) {
      ws();
      const op = src[i];
      if (op !== "*" && op !== "/") return left;
      i++;
      const right = parseFactor();
      if (right === null) return null;
      if (op === "/" && right === 0) return null; // never invent a value for /0
      left = op === "*" ? left * right : left / right;
    }
  }

  function parseFactor(): number | null {
    ws();
    if (i >= src.length) return null;
    if (src[i] === "+") { i++; return parseFactor(); }
    if (src[i] === "-") { i++; const v = parseFactor(); return v === null ? null : -v; }
    if (src[i] === "(") {
      i++;
      const v = parseExpr();
      ws();
      if (src[i] !== ")") return null;
      i++;
      return v;
    }
    const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  }

  const value = parseExpr();
  ws();
  if (i !== src.length) return null; // trailing junk — refuse
  return value === null || !Number.isFinite(value) ? null : value;
}

// ─── Parity helpers ─────────────────────────────────────────────────────────────

/** Cents comparison used by the parity harness. */
export function toCents(v: number | null | undefined): number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.round(v * 100);
}

/** True when two money figures agree to the cent. Null must match null. */
export function agreesToTheCent(a: number | null | undefined, b: number | null | undefined): boolean {
  const ca = toCents(a);
  const cb = toCents(b);
  if (ca === null || cb === null) return ca === cb;
  return ca === cb;
}

/** Hours agree at 4dp — the workbook stores labour units to 4 decimals (0.1333, 0.0525). */
export function agreesToHours(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return Math.abs(a - b) < 5e-5;
}
