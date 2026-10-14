/**
 * The customer-price sheet for the phone's Preview with no signal (2026-10-09, one-estimating-system
 * plan, Phase 7 unit U3; Kyle, 2026-10-13: ALL THREE difficulties — "bite the bullet and make it
 * work with all difficulties so there is no question that it will transfer smoothly").
 *
 * Four things are proved, the ones that would cost real money or engine time if wrong:
 *
 *  1. PARITY. The sheet is the engine's own figure, one item at a time at each difficulty, and the
 *     phone's `round2(quantity × price[difficulty])` equals the office's `lineTotal` for EVERY line
 *     the sheet prices — flat rows and NECA rows alike, at Normal, Difficult and Very difficult —
 *     and the option subtotal equals the office's for every option with no continuous-length line.
 *     A row that would not scale is sent with NO price at that difficulty, never a figure that
 *     could be a cent wrong; a difficulty the book does not publish is null with words, never a
 *     Normal figure standing in.
 *  2. NOTHING LEAVES THAT MUST NOT. A row is exactly PHONE_SHEET_ROW_KEYS, its `price` and `gap` are
 *     exactly the three difficulties, no gap sentence carries a number, and the body never names a
 *     labour, cost, tier, band or rate field.
 *  4. BUILT ONCE (D3, 2026-10-13). Two requests with nothing changed in the book build the sheet
 *     once; a price or Rate Config change builds it again.
 *  3. THE PHONE'S BUNDLE CANNOT CONTAIN THE MARGINS. No field source, and no shared file the field
 *     value-imports (transitively), names the engine's markup or band machinery, a company cost, the
 *     labour unit divisor or Synchrony's rate.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: vi.fn().mockResolvedValue(true), sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, createDraft, loadRateContext } from "../src/services/atomicEstimateService";
import type { EngineAtomic, RateConfig } from "../src/services/atomicEstimateEngine";
import { buildPhonePriceSheet, phoneSheetRow, priceSheetBuildCount, resetPriceSheetMemo, PHONE_GAP_WORDS, NO_RATE_WORDS, DOES_NOT_SCALE_WORDS } from "../src/services/fieldPriceSheet";
import { PHONE_SHEET_ROW_KEYS, SHEET_DIFFICULTIES, isCurrentSheetRow, type PhonePriceSheet, type PhoneSheetRow } from "../shared/fieldPriceSheet";
import { previewFigures, previewLineTotal, previewMoney, previewTotal, MAY_COME_DOWN, NOT_ON_SHEET_REASON } from "../shared/quotePreview";
import { programmeFor } from "../shared/discountProgramme";
import { programmeFor as programmeForViaServices, DISCOUNT_CAP, discountLabel } from "../src/services/discounts";
import { deleteAtomics, ensurePriceBookGates, noLabourAtomic, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "FIELDSHEET";
const SECTION = "FPS TEST SECTION";
const EA = "FPS-EA"; // flat $70 count item — the shape of Kyle's whole catalog today
const FT = "FPS-FT"; // flat, sold by the foot — continuous length: "may come down once issued"
const NECA = "FPS-NECA"; // NECA labour-only row (LABOR PRODUCT): 0.37 h × $100 — built, not read
const NOHRS = "FPS-NOHRS"; // no labour published: null with words
const NORMONLY = "FPS-NORMONLY"; // flat, Normal column only: Difficult and Very difficult null with words, never Normal standing in
const NECA1 = "FPS-NECA1"; // NECA row with a Normal labour value only: Difficult null with words
const RETIRED = "FPS-OLD"; // retired: not on the sheet at all, still priced by the office
const ALL_IDS = [EA, FT, NECA, NOHRS, NORMONLY, NECA1, RETIRED];

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
const draftIds: string[] = [];

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([
    quotableAtomic(EA, { category: SECTION, description: "FPS plain device", unit: "ea" }),
    quotableAtomic(FT, { category: SECTION, description: "FPS cable by the foot", unit: "ft", sellNormal: 2.5, sellDifficult: 3, sellVeryDifficult: 3.5, laborNormal: 0.01, laborDifficult: 0.012, laborVeryDifficult: 0.015 }),
    noLabourAtomic(NECA, { category: SECTION, description: "FPS labour product", unit: "ea", rowType: "LABOR PRODUCT", laborNormal: 0.37, laborDifficult: 0.5, laborVeryDifficult: 0.7, laborUnitBasis: "E", laborUnitDivisor: 1 }),
    noLabourAtomic(NOHRS, { category: SECTION, description: "FPS no hours item", unit: "ea" }),
    quotableAtomic(NORMONLY, { category: SECTION, description: "FPS normal-only device", unit: "ea", sellDifficult: null, sellVeryDifficult: null, laborDifficult: null, laborVeryDifficult: null }),
    noLabourAtomic(NECA1, { category: SECTION, description: "FPS labour product normal only", unit: "ea", rowType: "LABOR PRODUCT", laborNormal: 0.25, laborUnitBasis: "E", laborUnitDivisor: 1 }),
    quotableAtomic(RETIRED, { category: SECTION, description: "FPS retired item", unit: "ea" }),
  ]);
  await prisma.priceBookAtomic.update({ where: { itemId: RETIRED }, data: { retiredAt: new Date() } });

  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "fieldsheet@example.com", phone: "615-555-0177" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "1 Sheet Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" } });
  visitId = visit.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `fieldsheet-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });
});

afterAll(async () => {
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics(ALL_IDS);
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);

async function sheet(): Promise<PhonePriceSheet> {
  const res = await auth(request(app).get("/health-record/quote-price-sheet"));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect("unchanged" in res.body.data).toBe(false);
  return res.body.data as PhonePriceSheet;
}

const rowOf = (s: PhonePriceSheet, itemId: string) => s.rows.find((r) => r.itemId === itemId);
const at = (n: number, d: number, v: number) => ({ NORMAL: n, DIFFICULT: d, VERY_DIFFICULT: v });
const none = { NORMAL: null, DIFFICULT: null, VERY_DIFFICULT: null };

interface PhoneLine { id: string; itemId: string; quantity: number; difficulty: string; option: string; lineTotal: number | null; gaps: unknown[] }
interface PhonePayload { supplierId: string; lines: PhoneLine[]; options: Array<{ option: string; subtotal: number | null }>; total: number | null; money: { discount: { rows: Array<{ base: number; amount: number; after: number }> } | null } }

describe("GET /health-record/quote-price-sheet — the engine's own one-unit figure per live item at every difficulty", () => {
  it("needs a technician's token", async () => {
    expect((await request(app).get("/health-record/quote-price-sheet")).status).toBe(401);
  });

  it("carries every live item once, in itemId order, at the active supplier, with the office's trip and rate state; the retired item is absent", async () => {
    const s = await sheet();
    const ids = s.rows.map((r) => r.itemId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [EA, FT, NECA, NOHRS, NORMONLY, NECA1]) expect(ids, id).toContain(id);
    expect(ids).not.toContain(RETIRED);
    const rate = await loadRateContext(prisma);
    expect(s.supplierId).toBe(rate.rc.activeSupplier ?? "HD");
    // Whatever Rate Config says the trip is — the fixture's $200; production carries $0 (Kyle, 2026-10-09).
    expect(s.tripCharge).toBe(rate.rc.jobFixedCost ?? 0);
    expect(s.rateProvisional).toBe(rate.provisional);
    expect(s.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s.version).toMatch(/^[0-9a-f]{32}$/);
  });

  it("prices the rows as the engine does at each difficulty: flat rows read, the NECA row built, a wire row 'may come down', no-labour null with words", async () => {
    const s = await sheet();
    expect(rowOf(s, EA)).toEqual({ itemId: EA, price: at(70, 80, 95), gap: none, exactOffline: true });
    expect(rowOf(s, FT)).toEqual({ itemId: FT, price: at(2.5, 3, 3.5), gap: none, exactOffline: false });
    expect(rowOf(s, NECA)).toEqual({ itemId: NECA, price: at(37, 50, 70), gap: none, exactOffline: false });
    const noLabour = { NORMAL: PHONE_GAP_WORDS.NO_LABOUR_VALUE, DIFFICULT: PHONE_GAP_WORDS.NO_LABOUR_VALUE, VERY_DIFFICULT: PHONE_GAP_WORDS.NO_LABOUR_VALUE };
    expect(rowOf(s, NOHRS)).toEqual({ itemId: NOHRS, price: none, gap: noLabour, exactOffline: false });
  });

  it("a difficulty the book does not publish is null WITH words at that difficulty — never the Normal figure, a ceiling or a discount standing in (Kyle, 2026-10-13)", async () => {
    const s = await sheet();
    // Kyle's flat row with only the Normal column filled: the engine reads a price per difficulty and never scales Normal.
    expect(rowOf(s, NORMONLY)).toEqual({
      itemId: NORMONLY,
      price: { NORMAL: 70, DIFFICULT: null, VERY_DIFFICULT: null },
      gap: { NORMAL: null, DIFFICULT: PHONE_GAP_WORDS.NO_SELL_PRICE_AT_DIFFICULTY, VERY_DIFFICULT: PHONE_GAP_WORDS.NO_SELL_PRICE_AT_DIFFICULTY },
      exactOffline: true,
    });
    // A NECA row with only a Normal labour value: NECA's Difficult column is not a multiple of Normal, so nothing is made up.
    expect(rowOf(s, NECA1)).toEqual({
      itemId: NECA1,
      price: { NORMAL: 25, DIFFICULT: null, VERY_DIFFICULT: null },
      gap: { NORMAL: null, DIFFICULT: PHONE_GAP_WORDS.NO_LABOUR_VALUE, VERY_DIFFICULT: PHONE_GAP_WORDS.NO_LABOUR_VALUE },
      exactOffline: false,
    });
    expect(PHONE_GAP_WORDS.NO_SELL_PRICE_AT_DIFFICULTY).not.toMatch(/Normal/);
    expect(PHONE_GAP_WORDS.NO_LABOUR_VALUE).not.toMatch(/Normal/);
  });

  it("is built once and served from memory until the book, a price or Rate Config moves (D3)", async () => {
    resetPriceSheetMemo();
    const before = priceSheetBuildCount();
    const first = await sheet();
    expect(priceSheetBuildCount()).toBe(before + 1);
    const again = await sheet();
    const unchanged = await auth(request(app).get("/health-record/quote-price-sheet").query({ version: first.version }));
    expect(unchanged.body.data).toEqual({ unchanged: true, version: first.version });
    expect(again.version).toBe(first.version);
    expect(again.generatedAt).toBe(first.generatedAt);
    expect(priceSheetBuildCount(), "nothing changed: no second build").toBe(before + 1);

    // A price edit in the book: rebuilt, and the new figure is what the phone gets.
    await prisma.priceBookAtomic.update({ where: { itemId: EA }, data: { sellNormal: 71 } });
    const repriced = await sheet();
    expect(priceSheetBuildCount()).toBe(before + 2);
    expect(rowOf(repriced, EA)!.price.NORMAL).toBe(71);
    expect(repriced.version).not.toBe(first.version);
    await prisma.priceBookAtomic.update({ where: { itemId: EA }, data: { sellNormal: 70 } });
    expect(rowOf(await sheet(), EA)!.price.NORMAL).toBe(70);
    expect(priceSheetBuildCount()).toBe(before + 3);

    // A Rate Config edit (the trip): rebuilt too.
    const trip = await prisma.priceBookRateConfig.findUniqueOrThrow({ where: { key: "jobFixedCost" } });
    await prisma.priceBookRateConfig.update({ where: { key: "jobFixedCost" }, data: { numberValue: (trip.numberValue ?? 0) + 1 } });
    try {
      expect((await sheet()).tripCharge).toBe((trip.numberValue ?? 0) + 1);
      expect(priceSheetBuildCount()).toBe(before + 4);
    } finally {
      await prisma.priceBookRateConfig.update({ where: { key: "jobFixedCost" }, data: { numberValue: trip.numberValue } });
    }
    expect((await sheet()).tripCharge).toBe(trip.numberValue ?? 0);
  });

  it("answers { unchanged: true } for the version the phone already holds, and a fresh sheet for any other", async () => {
    const s = await sheet();
    const same = await auth(request(app).get("/health-record/quote-price-sheet").query({ version: s.version }));
    expect(same.status).toBe(200);
    expect(same.body.data).toEqual({ unchanged: true, version: s.version });
    const other = await auth(request(app).get("/health-record/quote-price-sheet").query({ version: "stale" }));
    expect(other.body.data.version).toBe(s.version);
    expect(other.body.data.rows.length).toBe(s.rows.length);
  });
});

describe("parity: the phone's preview over the sheet equals the office's figures for the same draft", () => {
  it("every line the sheet prices — flat, NECA and wire, at Normal, Difficult and Very difficult — matches lineTotal to the cent; options with no wire match the subtotal; a wire option is never previewed below the office's figure", async () => {
    const draft = await createDraft(prisma, { title: `${MARK} parity`, supplierId: "HD", visitId });
    draftIds.push(draft.id);
    // A: unit items at several quantities and EVERY difficulty, the NECA row among them at each.
    // B: wire by the foot at each difficulty, plus a unit item.
    // C: a Normal-only item at Difficult, a NECA row at Very difficult with no such column, a no-labour line, a retired item.
    await addLine(prisma, draft.id, { itemId: EA, quantity: 3, option: "A" });
    await addLine(prisma, draft.id, { itemId: NECA, quantity: 7, option: "A" });
    await addLine(prisma, draft.id, { itemId: EA, quantity: 1, option: "A" });
    await addLine(prisma, draft.id, { itemId: EA, quantity: 2, option: "A", difficulty: "DIFFICULT" });
    await addLine(prisma, draft.id, { itemId: EA, quantity: 5, option: "A", difficulty: "VERY_DIFFICULT" });
    await addLine(prisma, draft.id, { itemId: NECA, quantity: 4, option: "A", difficulty: "DIFFICULT" });
    await addLine(prisma, draft.id, { itemId: NECA, quantity: 3, option: "A", difficulty: "VERY_DIFFICULT" });
    await addLine(prisma, draft.id, { itemId: NECA1, quantity: 6, option: "A" });
    await addLine(prisma, draft.id, { itemId: FT, quantity: 250, option: "B" });
    await addLine(prisma, draft.id, { itemId: FT, quantity: 100, option: "B", difficulty: "DIFFICULT" });
    await addLine(prisma, draft.id, { itemId: FT, quantity: 40, option: "B", difficulty: "VERY_DIFFICULT" });
    await addLine(prisma, draft.id, { itemId: EA, quantity: 2, option: "B" });
    await addLine(prisma, draft.id, { itemId: NORMONLY, quantity: 2, option: "C", difficulty: "DIFFICULT" });
    await addLine(prisma, draft.id, { itemId: NECA1, quantity: 1, option: "C", difficulty: "VERY_DIFFICULT" });
    await addLine(prisma, draft.id, { itemId: NOHRS, quantity: 1, option: "C" });
    await addLine(prisma, draft.id, { itemId: RETIRED, quantity: 1, option: "C" });

    const s = await sheet();
    const office = (await auth(request(app).get(`/health-record/quotes/${draft.id}`))).body.data as PhonePayload;
    expect(office.supplierId).toBe(s.supplierId);
    const preview = previewFigures(office.lines, s, null, { draftSupplierId: office.supplierId });
    const byId = new Map(preview.lines.map((l) => [l.id, l]));

    const matched = new Set<string>();
    for (const line of office.lines) {
      const p = byId.get(line.id)!;
      const row = rowOf(s, line.itemId);
      const d = line.difficulty as (typeof SHEET_DIFFICULTIES)[number];
      if (!row || row.price[d] === null) {
        expect(p.total, `${line.itemId} @ ${d}`).toBeNull();
        expect(p.status).toBe("unpriced");
        // The reason is the sheet's own words for THAT difficulty, or "not on the sheet" for a retired item.
        expect(p.reason, `${line.itemId} @ ${d}`).toBe(row ? row.gap[d] : NOT_ON_SHEET_REASON);
        continue;
      }
      expect(p.total, `${line.itemId} × ${line.quantity} @ ${d}`).toBe(line.lineTotal);
      expect(line.lineTotal, `${line.itemId} @ ${d} is priced by the office`).not.toBeNull();
      expect(p.status).toBe(row.exactOffline ? "preview" : "mayComeDown");
      matched.add(`${line.itemId}:${d}`);
    }
    // Every row type matched at EVERY difficulty: flat, NECA (built), wire.
    for (const item of [EA, NECA, FT]) for (const d of SHEET_DIFFICULTIES) expect(matched.has(`${item}:${d}`), `${item} @ ${d}`).toBe(true);
    // Spot figures: the engine's own at each difficulty, not Normal scaled or capped.
    expect(byId.get(office.lines[0].id)).toMatchObject({ total: 210, status: "preview" }); // EA 3 × 70
    expect(byId.get(office.lines[1].id)).toMatchObject({ total: 259, status: "mayComeDown" }); // NECA 7 × 37 — built, so not exactOffline
    expect(byId.get(office.lines[3].id)).toMatchObject({ total: 160, status: "preview" }); // EA 2 × 80 at Difficult
    expect(byId.get(office.lines[4].id)).toMatchObject({ total: 475, status: "preview" }); // EA 5 × 95 at Very difficult
    expect(byId.get(office.lines[5].id)).toMatchObject({ total: 200, status: "mayComeDown" }); // NECA 4 × 0.5 h × $100 at Difficult
    expect(byId.get(office.lines[6].id)).toMatchObject({ total: 210, status: "mayComeDown" }); // NECA 3 × 0.7 h × $100 at Very difficult
    expect(byId.get(office.lines[8].id)).toMatchObject({ total: 625, status: "mayComeDown", reason: MAY_COME_DOWN }); // FT 250 × 2.5
    expect(byId.get(office.lines[9].id)).toMatchObject({ total: 300, status: "mayComeDown" }); // FT 100 × 3 at Difficult
    expect(byId.get(office.lines[10].id)).toMatchObject({ total: 140, status: "mayComeDown" }); // FT 40 × 3.5 at Very difficult
    // A difficulty the book does not publish: unpriced with its words — not 2 × 70, not anything.
    expect(byId.get(office.lines[12].id)).toMatchObject({ total: null, status: "unpriced", reason: PHONE_GAP_WORDS.NO_SELL_PRICE_AT_DIFFICULTY });
    expect(byId.get(office.lines[13].id)).toMatchObject({ total: null, status: "unpriced", reason: PHONE_GAP_WORDS.NO_LABOUR_VALUE });
    // The office prices neither of those either: the payload carries the engine's gap on the line (and a $0
    // placeholder, as online), so the two agree that there is no real figure at that difficulty.
    expect(office.lines[12].gaps.length).toBeGreaterThan(0);
    expect(office.lines[13].gaps.length).toBeGreaterThan(0);

    const officeSub = new Map(office.options.map((o) => [o.option, o.subtotal]));
    const a = preview.options.find((o) => o.option === "A")!;
    expect(a.subtotal).toBe(officeSub.get("A"));
    expect(a.subtotal).not.toBeNull();
    expect(a.mayComeDown).toBe(true); // the NECA row is built, so its figure is not exactOffline
    const b = preview.options.find((o) => o.option === "B")!;
    expect(b.mayComeDown).toBe(true);
    // Gate 2 can only LOWER a wire option: the preview is at or above the office's figure.
    expect(b.subtotal!).toBeGreaterThanOrEqual(officeSub.get("B")!);
    const c = preview.options.find((o) => o.option === "C")!;
    expect(c).toMatchObject({ subtotal: null, unpriced: true });
  });

  it("the preview's selection table and discount rows come from the SAME shared builder as the office's, over the same figures", async () => {
    const draft = await createDraft(prisma, { title: `${MARK} money`, supplierId: "HD", visitId });
    draftIds.push(draft.id);
    await addLine(prisma, draft.id, { itemId: EA, quantity: 4, option: "A" });
    await addLine(prisma, draft.id, { itemId: NECA, quantity: 2, option: "B" });
    await prisma.priceBookDraftEstimate.update({ where: { id: draft.id }, data: { discountType: "military" } });

    const s = await sheet();
    const office = (await auth(request(app).get(`/health-record/quotes/${draft.id}`))).body.data as PhonePayload & { money: { selections: Record<string, unknown>; discountedTotal: number | null } };
    const programme = programmeFor("military");
    const preview = previewFigures(office.lines, s, programme, { draftSupplierId: office.supplierId });
    const money = previewMoney(preview, false, programme);
    // Unit items only, no combination saving applies, so the office's table IS the preview's table.
    expect(money.selections).toEqual(office.money.selections);
    expect(money.discount!.rows).toEqual(office.money.discount!.rows);
    expect(money.discountedTotal).toBe(office.money.discountedTotal);
    expect(money.financing).toBeNull();
    expect(previewTotal(preview)).toBe(office.total);
  });

  it("previewLineTotal is the engine's flat-row rule, rounded once", () => {
    expect(previewLineTotal(3, 60.25)).toBe(180.75);
    expect(previewLineTotal(7, 0.1)).toBe(0.7);
    expect(previewLineTotal(250, 2.5)).toBe(625);
  });
});

describe("phoneSheetRow: a row the engine builds must scale from one unit, or it is sent with no price", () => {
  const rc: RateConfig = {
    billedLaborRate: 100, inspectionCoordination: null, inspectionFolded: null, utilityStandby: null, permitFee: null,
    jobFixedCost: 0, activeSupplier: "HD", markupTiers: { tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 0 }, jobBands: null,
  };
  const neca = (itemId: string, laborNormal: number): EngineAtomic => ({
    itemId, description: `test ${itemId}`, unit: "ea", rowType: "LABOR PRODUCT",
    laborNormal, laborDifficult: null, laborVeryDifficult: null, laborUnitBasis: "E", laborUnitDivisor: 1, laborUnitBasisRaw: "E",
    costBasisUsed: null, sellPricePerUnit: null, necaUnitBasis: null,
  });

  it("a row whose one-unit figure rounds but whose line does not scale is unpriced with words at that difficulty, never a cent off; a difficulty with no labour value is null with words", () => {
    const scales = neca("T-SCALES", 0.37);
    const rounds = neca("T-ROUNDS", 0.00005); // one unit = $0.005 → $0.01; two units = $0.01, not $0.02
    const atomics = new Map([[scales.itemId, scales], [rounds.itemId, rounds]]);
    expect(phoneSheetRow(scales, atomics, rc, "HD")).toEqual({
      itemId: "T-SCALES",
      price: { NORMAL: 37, DIFFICULT: null, VERY_DIFFICULT: null },
      gap: { NORMAL: null, DIFFICULT: PHONE_GAP_WORDS.NO_LABOUR_VALUE, VERY_DIFFICULT: PHONE_GAP_WORDS.NO_LABOUR_VALUE },
      exactOffline: false,
    });
    const r = phoneSheetRow(rounds, atomics, rc, "HD");
    expect(r.price.NORMAL).toBeNull();
    expect(r.gap.NORMAL).toBe(DOES_NOT_SCALE_WORDS);
    expect(r.gap.NORMAL).not.toMatch(/\d/);
    // The scale check runs per difficulty: a Difficult column that scales is priced even when Normal does not.
    const mixed: EngineAtomic = { ...rounds, itemId: "T-MIXED", laborDifficult: 0.5 };
    const m = phoneSheetRow(mixed, new Map([[mixed.itemId, mixed]]), rc, "HD");
    expect(m.price).toEqual({ NORMAL: null, DIFFICULT: 50, VERY_DIFFICULT: null });
    expect(m.gap).toEqual({ NORMAL: DOES_NOT_SCALE_WORDS, DIFFICULT: null, VERY_DIFFICULT: PHONE_GAP_WORDS.NO_LABOUR_VALUE });
  });

  it("with no billed rate at the office, no row is priced at any difficulty", () => {
    const row = neca("T-NORATE", 0.37);
    const r = phoneSheetRow(row, new Map([[row.itemId, row]]), { ...rc, billedLaborRate: null }, "HD");
    expect(r).toMatchObject({ price: none, gap: { NORMAL: NO_RATE_WORDS, DIFFICULT: NO_RATE_WORDS, VERY_DIFFICULT: NO_RATE_WORDS } });
  });

  it("isCurrentSheetRow tells this shape from the Normal-only one an earlier build saved on a phone", () => {
    expect(isCurrentSheetRow({ itemId: "X", price: at(1, 2, 3), gap: none, exactOffline: true })).toBe(true);
    expect(isCurrentSheetRow({ itemId: "X", price: { NORMAL: null, DIFFICULT: 2, VERY_DIFFICULT: null }, gap: { NORMAL: "words", DIFFICULT: null, VERY_DIFFICULT: "words" }, exactOffline: false })).toBe(true);
    expect(isCurrentSheetRow({ itemId: "X", price: { NORMAL: 70 }, gap: null, exactOffline: true })).toBe(false);
    expect(isCurrentSheetRow({ itemId: "X", price: { NORMAL: 70, DIFFICULT: 80 }, gap: none, exactOffline: true })).toBe(false);
    expect(isCurrentSheetRow(null)).toBe(false);
  });

  it("a built sheet with a blank rate says so on the header", async () => {
    // buildPhonePriceSheet reads the live Rate Config; the fixture's rate is set, so this is the pure path only.
    const built = await buildPhonePriceSheet(prisma);
    expect("unchanged" in built).toBe(false);
  });
});

describe("what a sheet row carries — pinned", () => {
  it("every row is exactly PHONE_SHEET_ROW_KEYS, price and gap are exactly the three difficulties, and no gap sentence carries a number", async () => {
    const s = await sheet();
    expect(s.rows.length).toBeGreaterThan(0);
    for (const row of s.rows as Array<PhoneSheetRow & Record<string, unknown>>) {
      expect(Object.keys(row).sort(), row.itemId).toEqual([...PHONE_SHEET_ROW_KEYS]);
      expect(Object.keys(row.price), row.itemId).toEqual([...SHEET_DIFFICULTIES]);
      expect(Object.keys(row.gap), row.itemId).toEqual([...SHEET_DIFFICULTIES]);
      expect(typeof row.exactOffline).toBe("boolean");
      expect(isCurrentSheetRow(row)).toBe(true);
      for (const d of SHEET_DIFFICULTIES) {
        if (row.gap[d] !== null) expect(row.gap[d], `${row.itemId} @ ${d}`).not.toMatch(/\d/);
        // Priced XOR words: never both, never neither.
        expect(row.price[d] === null, `${row.itemId} @ ${d}`).toBe(row.gap[d] !== null);
      }
    }
    expect(Object.keys(s).sort()).toEqual(["generatedAt", "rateProvisional", "rows", "supplierId", "tripCharge", "version"]);
    for (const words of Object.values(PHONE_GAP_WORDS)) expect(words).not.toMatch(/\d/);
    expect(NO_RATE_WORDS).not.toMatch(/\d/);
  });

  it("the raw body never names a labour, cost, tier, band, per-unit sell or rate field — only the three difficulty keys and customer prices", async () => {
    const res = await auth(request(app).get("/health-record/quote-price-sheet"));
    const text = res.text;
    for (const banned of [
      "laborNormal", "laborDifficult", "laborVeryDifficult", "laborHours", "laborDollars", "laborUnitBasis", "laborUnitDivisor",
      "billedLaborRate", "companyCost", "companyPrice", "costBasisUsed", "costBasis", "sellPricePerUnit", "sellPerUnit", "materialSell", "materialCost",
      "markupTier", "JOB_MATERIAL_BANDS", "jobBands", "discountRatePct", "sellNormal", "sellDifficult", "sellVeryDifficult", "unitCost",
    ]) {
      expect(text, banned).not.toContain(banned);
    }
    // The fixture's own labour hours (0.3/0.4/0.55 on the flat row, 0.37/0.5/0.7 on the NECA row) are not in the body as figures either.
    expect(text).not.toMatch(/"laborNormal"|0\.37\b|0\.55\b|"hours"/i);
  });

  it("the discount programme table is one file: the service re-exports shared/discountProgramme", () => {
    expect(programmeForViaServices).toBe(programmeFor);
    expect(programmeFor("military")).toEqual({ type: "military", rate: 0.05, cap: DISCOUNT_CAP, percent: 5 });
    expect(programmeFor("custom", 7.5)).toEqual({ type: "custom", rate: 0.075, cap: null, percent: 7.5 });
    expect(programmeFor("custom", 99)).toBeNull();
    expect(discountLabel("senior")).toBe("Senior discount (5%)");
  });
});

// ─── The phone's bundle cannot contain the margins ───────────────────────────────────────────

describe("no field source, and no shared file the field value-imports, names the margin machinery", () => {
  const ROOT = join(__dirname, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  const BANNED = ["JOB_MATERIAL_BANDS", "markupMultiplierFor", "companyCost", "laborUnitDivisor", "discountRatePct"];

  /** The shared/ files a source file VALUE-imports (an `import type` bundles nothing). */
  const valueImportsOfShared = (file: string, src: string): string[] => {
    const out: string[] = [];
    for (const m of src.matchAll(/^import\s+(?!type\b)(?:(?!^import\b)[^])*?from\s+["']([^"']*shared\/[^"']*)["']/gm)) {
      const target = resolve(dirname(file), m[1]);
      for (const candidate of [target + ".ts", join(target, "index.ts")]) if (existsSync(candidate)) out.push(candidate);
    }
    return out;
  };

  it("field/src (non-test) and every shared file it value-imports, transitively, are free of the five names", () => {
    const seen = new Set<string>();
    const queue: string[] = walk(join(ROOT, "field/src")).filter((f) => !/\.test\.tsx?$/.test(f));
    const offenders: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      for (const name of BANNED) if (src.includes(name)) offenders.push(`${rel}: ${name}`);
      for (const next of valueImportsOfShared(file, src)) queue.push(next);
    }
    // The walk really reached the shared files the preview depends on (shared/fieldPriceSheet.ts
    // bundles its difficulty list and shape check, nothing of the engine's).
    const reached = [...seen].map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    for (const expected of ["shared/quotePreview.ts", "shared/quoteMoney.ts", "shared/discountProgramme.ts", "shared/fieldPriceSheet.ts"]) {
      expect(reached).toContain(expected);
    }
    expect(reached).not.toContain("shared/financing.ts");
    expect(offenders).toEqual([]);
  });

  it("no shared file value-imports shared/financing (the rate arithmetic stays off the phone)", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "shared"))) {
      if (/\.test\.tsx?$/.test(file) || /[\\/]financing\.ts$/.test(file)) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/^import\s+(?!type\b)(?:(?!^import\b)[^])*?from\s+["'][^"']*\/financing["']/gm)) offenders.push(`${relative(ROOT, file)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
