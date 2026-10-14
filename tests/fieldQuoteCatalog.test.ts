/**
 * The field Quote screen's price-book picker and line details — ONE browse, ONE addLine, two doors
 * (Kyle, 2026-10-08; one-estimating-system plan, Phase 2 unit C).
 *
 *   - Browse by section: the phone's section cards are the CRM's (browseSections), the phone's rows
 *     are the CRM's (browseAtomics) with the office-only columns taken off (browseFieldCatalog).
 *   - NO labour hours, labour unit basis, Red Cedar cost or per-unit sell figure rides to the phone:
 *     the technician hands the phone to the customer (constants.md "Field app"). Pinned two ways —
 *     the exact key set, and "no number anywhere in a row".
 *   - Assemblies are rows of the same book: listed (badged) by both doors and added by the same
 *     addLine, so a CRM add and a field add of the same assembly leave the same line.
 *   - The unit badge uses the engine's isContinuousLength (ft OR lf), not a private `=== "ft"`.
 *   - Location and a typed note round-trip through the field's add and edit routes and show on the
 *     CRM's review of the same draft; an emptied box clears the field.
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
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: vi.fn().mockResolvedValue(true), sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { browseSections, createDraft, fieldCatalogSnapshot, literalContains } from "../src/services/atomicEstimateService";
import { inSection, matchesCatalogSearch, type FieldCatalogRow, type FieldCatalogSnapshot } from "../shared/quoteCatalog";
import { deleteAtomics, ensurePriceBookGates, noLabourAtomic, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "FIELDCAT";
const SECTION = "FQC TEST SECTION"; // a section nothing else in the book uses
const OTHER_SECTION = "FQC OTHER SECTION";
const EA = "FQC-EA"; // a plain count item, flat $70
const FT = "FQC-FT"; // sold by the foot
const LF = "FQC-LF"; // sold by the "lf" — the unit the old badge missed
const ASM = "FQC-ASM"; // an assembly
const NOHRS = "FQC-NOHRS"; // no labour published at all
const RETIRED = "FQC-OLD";
const OTHER = "FQC-OTHER";
const ALL_IDS = [EA, FT, LF, ASM, NOHRS, RETIRED, OTHER];

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
const draftIds: string[] = [];

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([
    quotableAtomic(EA, { category: SECTION, description: "FQC plain device", unit: "ea" }),
    quotableAtomic(FT, { category: SECTION, description: "FQC cable by the foot", unit: "ft" }),
    quotableAtomic(LF, { category: SECTION, description: "FQC conduit by the lf", unit: "lf" }),
    quotableAtomic(ASM, { category: SECTION, description: "FQC hardwired charger assembly", unit: "ea", rowType: "ASSEMBLY" }),
    noLabourAtomic(NOHRS, { category: SECTION, description: "FQC no hours item", unit: "ea" }),
    quotableAtomic(RETIRED, { category: SECTION, description: "FQC retired item", unit: "ea" }),
    quotableAtomic(OTHER, { category: OTHER_SECTION, description: "FQC other section item", unit: "ea" }),
  ]);
  await prisma.priceBookAtomic.update({ where: { itemId: RETIRED }, data: { retiredAt: new Date() } });

  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "fieldcat@example.com", phone: "615-555-0166" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "1 Catalog Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" } });
  visitId = visit.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `fieldcat-test-${customer.id}` } });
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

async function newDraft(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  return d;
}

type Row = Record<string, unknown> & { itemId: string };
const byId = (rows: Row[]) => new Map(rows.map((r) => [r.itemId, r]));

// What a field row may carry: words and yes/no badges, nothing else.
const FIELD_ROW_KEYS = [
  "category", "description", "hasLabourUnitBasis", "hasPriceAtActiveSupplier", "hasPublishedLabour",
  "isAssembly", "isContinuousLength", "isFlatPriced", "isHourlyProduct", "itemId", "sellsMaterial", "unit",
];

describe("GET /health-record/quote-catalog — the CRM's browse, minus the office-only columns", () => {
  it("needs a technician's token", async () => {
    const res = await request(app).get("/health-record/quote-catalog?category=" + encodeURIComponent(SECTION));
    expect(res.status).toBe(401);
  });

  it("a section browse lists its live items, assembly included, retired left out", async () => {
    const res = await auth(request(app).get("/health-record/quote-catalog").query({ category: SECTION }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = res.body.data.atomics.map((a: Row) => a.itemId).sort();
    expect(ids).toEqual([ASM, EA, FT, LF, NOHRS].sort());
    expect(res.body.data).toMatchObject({ count: 5, total: 5, truncated: false });
  });

  it("search finds the same items by description, and an assembly says so", async () => {
    const res = await auth(request(app).get("/health-record/quote-catalog").query({ search: "hardwired charger" }));
    expect(res.status).toBe(200);
    const rows = res.body.data.atomics as Row[];
    expect(rows.map((r) => r.itemId)).toEqual([ASM]);
    expect(rows[0]!.isAssembly).toBe(true);
  });

  it("a typed % or _ is the literal character, online and in the phone's saved-copy matcher alike (Phase 7 U5)", async () => {
    // Prisma's `contains` hands the text to LIKE untouched: before this, "FQC%device" matched
    // "FQC plain device" online while the phone's substring test did not. Both doors now agree.
    const online = async (search: string) =>
      ((await auth(request(app).get("/health-record/quote-catalog").query({ search }))).body.data.atomics as Row[]).map((r) => r.itemId);
    const snapshot = (await fieldCatalogSnapshot(prisma)) as FieldCatalogSnapshot;
    const rows = snapshot.rows.filter((r: FieldCatalogRow) => r.itemId.startsWith("FQC-"));
    const offline = (search: string) => rows.filter((r: FieldCatalogRow) => matchesCatalogSearch(r, search)).map((r: FieldCatalogRow) => r.itemId);
    for (const search of ["FQC%device", "FQC_plain", "FQC plain", "by the_foot", "100%"]) {
      expect(await online(search), search).toEqual(offline(search));
    }
    expect(await online("FQC%device")).toEqual([]);
    expect(await online("FQC plain")).toEqual([EA]);
    expect(literalContains("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
  });

  it("a row carries ONLY words and yes/no badges — no hours, no unit basis, no cost, no figure of any kind", async () => {
    const res = await auth(request(app).get("/health-record/quote-catalog").query({ category: SECTION }));
    for (const row of res.body.data.atomics as Row[]) {
      expect(Object.keys(row).sort()).toEqual(FIELD_ROW_KEYS);
      for (const [k, v] of Object.entries(row)) {
        // Not one number anywhere in a row: hours, cost and price are all numbers.
        expect(typeof v === "number", `${row.itemId}.${k} is a number`).toBe(false);
      }
    }
    // The raw body, searched as text for the office-only column names and the fixture's actual hours.
    const text = JSON.stringify(res.body);
    for (const banned of ["laborNormal", "laborDifficult", "laborVeryDifficult", "laborUnitBasis", "costBasisUsed", "sellPricePerUnit", "necArticle"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("the badges match the CRM's browse of the same section, row for row, in the same order", async () => {
    const field = await auth(request(app).get("/health-record/quote-catalog").query({ category: SECTION }));
    const crm = await request(app).get("/price-book/atomics").query({ category: SECTION, limit: 60 });
    expect(crm.status).toBe(200);
    const crmRows = crm.body.atomics as Row[];
    const fieldRows = field.body.data.atomics as Row[];
    expect(fieldRows.map((r) => r.itemId)).toEqual(crmRows.map((r) => r.itemId));
    for (const f of fieldRows) {
      const c = byId(crmRows).get(f.itemId)!;
      for (const key of FIELD_ROW_KEYS) expect(f[key], `${f.itemId}.${key}`).toEqual(c[key]);
    }
    // The CRM keeps its hours (the office sees them) — the field's omission is deliberate.
    expect(crmRows[0]).toHaveProperty("laborNormal");
  });

  it("the gap badges are right: no labour hours, by the foot, by the lf, assembly", async () => {
    const res = await auth(request(app).get("/health-record/quote-catalog").query({ category: SECTION }));
    const rows = byId(res.body.data.atomics);
    expect(rows.get(NOHRS)).toMatchObject({ hasPublishedLabour: false });
    expect(rows.get(EA)).toMatchObject({ hasPublishedLabour: true, isAssembly: false, isContinuousLength: false });
    expect(rows.get(FT)).toMatchObject({ isContinuousLength: true });
    // The decorator fix: the engine counts "lf" as a measured length, so the badge must too.
    expect(rows.get(LF)).toMatchObject({ isContinuousLength: true });
    expect(rows.get(ASM)).toMatchObject({ isAssembly: true });
  });
});

describe("GET /health-record/quote-catalog/sections — the CRM's section cards", () => {
  it("is the same list with the same counts as GET /price-book/sections, and omits a section with only retired items", async () => {
    const field = await auth(request(app).get("/health-record/quote-catalog/sections"));
    expect(field.status, JSON.stringify(field.body)).toBe(200);
    const crm = await request(app).get("/price-book/sections");
    expect(field.body.data.sections).toEqual(crm.body.sections);
    const mine = (field.body.data.sections as Array<{ section: string; itemCount: number }>).filter((s) => s.section.startsWith("FQC "));
    expect(mine).toEqual([
      { section: OTHER_SECTION, itemCount: 1 },
      { section: SECTION, itemCount: 5 }, // six rows, one retired
    ]);
  });

  it("needs a technician's token", async () => {
    expect((await request(app).get("/health-record/quote-catalog/sections")).status).toBe(401);
  });
});

describe("adding an assembly — the same line from either door", () => {
  it("a CRM add and a field add of the same assembly leave the same line and the same price", async () => {
    const crmDraft = await newDraft("asm-crm");
    const fieldDraft = await newDraft("asm-field");

    const crmAdd = await request(app).post(`/price-book/drafts/${crmDraft.id}/lines`).send({ itemId: ASM, quantity: 2, option: "B" });
    expect(crmAdd.status, JSON.stringify(crmAdd.body)).toBe(201);
    const fieldAdd = await auth(request(app).post(`/health-record/quotes/${fieldDraft.id}/lines`).send({ itemId: ASM, quantity: 2, option: "B" }));
    expect(fieldAdd.status, JSON.stringify(fieldAdd.body)).toBe(201);

    const shape = (draftId: string) =>
      prisma.priceBookDraftLine.findMany({
        where: { draftId },
        select: { itemId: true, quantity: true, quantitySource: true, difficulty: true, option: true, state: true, sortOrder: true },
      });
    const crmLines = await shape(crmDraft.id);
    const fieldLines = await shape(fieldDraft.id);
    expect(fieldLines).toEqual(crmLines);
    expect(fieldLines).toHaveLength(1);
    expect(fieldLines[0]).toMatchObject({ itemId: ASM, quantity: 2, option: "B", state: "CONFIRMED" });

    // Same price on the phone's quote as on the office's compute: $70 x 2.
    const phone = (await auth(request(app).get(`/health-record/quotes/${fieldDraft.id}`))).body.data;
    const office = (await request(app).get(`/price-book/drafts/${crmDraft.id}/compute`)).body;
    expect(phone.lines[0].lineTotal).toBe(140);
    expect(phone.total).toBe(office.computed.total);
  });
});

describe("a line's location and note — set from the field, seen in the office", () => {
  it("add with both: the phone's quote and the CRM's review both show them", async () => {
    const d = await newDraft("loc-add");
    const add = await auth(request(app).post(`/health-record/quotes/${d.id}/lines`).send({ itemId: EA, quantity: 1, location: "Garage", note: "Panel is on the left wall" }));
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    const phone = (await auth(request(app).get(`/health-record/quotes/${d.id}`))).body.data;
    expect(phone.lines[0]).toMatchObject({ location: "Garage", note: "Panel is on the left wall" });

    const review = (await request(app).get(`/price-book/drafts/${d.id}/review`)).body;
    expect(review.confirmedLines[0]).toMatchObject({ location: "Garage", note: "Panel is on the left wall" });
  });

  it("edit from the field changes them; an emptied box (null) clears them; the CRM sees each step", async () => {
    const d = await newDraft("loc-edit");
    const add = await auth(request(app).post(`/health-record/quotes/${d.id}/lines`).send({ itemId: EA, quantity: 1 }));
    const lineId = add.body.data.lineId as string;

    const set = await auth(request(app).patch(`/health-record/quote-lines/${lineId}`).send({ location: "Kitchen", note: "Island circuit" }));
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await request(app).get(`/price-book/drafts/${d.id}/review`)).body.confirmedLines[0]).toMatchObject({ location: "Kitchen", note: "Island circuit" });

    // Only the location changes — the note is left alone (a partial patch never wipes the other box).
    await auth(request(app).patch(`/health-record/quote-lines/${lineId}`).send({ location: "Pantry" }));
    expect((await auth(request(app).get(`/health-record/quotes/${d.id}`))).body.data.lines[0]).toMatchObject({ location: "Pantry", note: "Island circuit" });

    const cleared = await auth(request(app).patch(`/health-record/quote-lines/${lineId}`).send({ location: null, note: null }));
    expect(cleared.status).toBe(200);
    const row = await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(row.location).toBeNull();
    expect(row.note).toBeNull();
  });

  it("a CRM edit shows on the phone too (same draft, both doors)", async () => {
    const d = await newDraft("loc-crm");
    const add = await request(app).post(`/price-book/drafts/${d.id}/lines`).send({ itemId: EA, quantity: 1 });
    const lineId = add.body.id as string;
    await request(app).patch(`/price-book/lines/${lineId}`).send({ location: "Attic", note: "Low clearance" });
    expect((await auth(request(app).get(`/health-record/quotes/${d.id}`))).body.data.lines[0]).toMatchObject({ location: "Attic", note: "Low clearance" });
  });
});

// ─── The whole price book, for the phone to keep (Phase 7 unit U2, 2026-10-09) ────────────────────
//
// GET /health-record/quote-catalog/snapshot hands the phone EVERY live item as the same words-and-
// badges rows the online picker shows, so the picker can search with no signal. Three things must
// hold: a row carries exactly FIELD_ROW_KEYS (never a figure), nothing is capped or dropped, and the
// pure matchers the phone runs over its copy give the same answer the server's search gives online.

const SNAP_SECTION = "SNAP TEST SECTION"; // does not start with "FQC ", so the section-card test above ignores it
const SNAP_OTHER = "Snap Test Other";
const SNAP_CAP_SECTION = "SNAP CAP SECTION";
const SNAP_CAP_IDS = Array.from({ length: 215 }, (_, i) => `SNAPCAP-${String(i).padStart(3, "0")}`);
const SNAP_IDS = ["SNAPA-001", "SNAPA-002", "snapb-lower", "SNAPC-NODESC", "SNAPD-PCT", "SNAPE-OTHER", "SNAPF-OLD", "SNAPG-NEW"];

const snapshotGet = async (version?: string) =>
  auth(request(app).get("/health-record/quote-catalog/snapshot").query(version === undefined ? {} : { version }));

describe("GET /health-record/quote-catalog/snapshot — the whole live price book, in words", () => {
  beforeAll(async () => {
    await seedAtomics([
      quotableAtomic("SNAPA-001", { category: SNAP_SECTION, description: "Snap Duplex RECEPTACLE 15A", unit: "ea" }),
      quotableAtomic("SNAPA-002", { category: SNAP_SECTION, description: "snap gfci receptacle, weather resistant", unit: "ea" }),
      quotableAtomic("snapb-lower", { category: SNAP_SECTION, description: "Lower-case code item", unit: "ft" }),
      quotableAtomic("SNAPC-NODESC", { category: SNAP_SECTION, description: null, unit: "ea" }),
      quotableAtomic("SNAPD-PCT", { category: SNAP_OTHER, description: "50% off_deal 'quoted' item", unit: "ea" }),
      quotableAtomic("SNAPE-OTHER", { category: null, description: "Item with no section", unit: "ea" }),
      quotableAtomic("SNAPF-OLD", { category: SNAP_SECTION, description: "Snap retired item", unit: "ea" }),
      ...SNAP_CAP_IDS.map((id) => quotableAtomic(id, { category: SNAP_CAP_SECTION, description: `Snap cap filler ${id}`, unit: "ea" })),
    ]);
    await prisma.priceBookAtomic.update({ where: { itemId: "SNAPF-OLD" }, data: { retiredAt: new Date() } });
  });

  afterAll(async () => {
    await deleteAtomics([...SNAP_IDS, ...SNAP_CAP_IDS]);
  });

  async function fullSnapshot(): Promise<FieldCatalogSnapshot> {
    const res = await snapshotGet();
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    expect(res.body.data.unchanged).toBeUndefined();
    return res.body.data as FieldCatalogSnapshot;
  }

  it("needs a technician's token", async () => {
    expect((await request(app).get("/health-record/quote-catalog/snapshot")).status).toBe(401);
  });

  it("every row carries exactly the field keys — words and yes/no badges, not one number, no office-only column", async () => {
    const snap = await fullSnapshot();
    expect(snap.rows.length).toBeGreaterThan(SNAP_CAP_IDS.length);
    for (const row of snap.rows as unknown as Row[]) {
      expect(Object.keys(row).sort(), row.itemId).toEqual(FIELD_ROW_KEYS);
      for (const [k, v] of Object.entries(row)) expect(typeof v === "number", `${row.itemId}.${k} is a number`).toBe(false);
    }
    const text = JSON.stringify(snap);
    for (const banned of ["laborNormal", "laborDifficult", "laborVeryDifficult", "laborUnitBasis", "costBasisUsed", "sellPricePerUnit", "sellNormal", "necArticle", "companyCost", "companyPrice", "lastSeenAt", "retiredAt"]) {
      expect(text, banned).not.toContain(banned);
    }
    expect(Object.keys(snap).sort()).toEqual(["generatedAt", "rows", "sections", "version"]);
  });

  it("the service builds the same rows (the route adds nothing and drops nothing)", async () => {
    const viaService = (await fieldCatalogSnapshot(prisma)) as FieldCatalogSnapshot;
    const viaRoute = await fullSnapshot();
    expect(viaRoute.rows).toEqual(viaService.rows);
    expect(viaRoute.sections).toEqual(viaService.sections);
    expect(viaRoute.version).toBe(viaService.version);
  });

  it("lists every live item with no cap — 215 filler rows all arrive — and leaves the retired one out", async () => {
    const snap = await fullSnapshot();
    const live = await prisma.priceBookAtomic.findMany({ where: { retiredAt: null }, orderBy: { itemId: "asc" }, select: { itemId: true } });
    expect(snap.rows.map((r) => r.itemId)).toEqual(live.map((r) => r.itemId));
    expect(snap.rows.length).toBeGreaterThan(200); // browseAtomics would have stopped at 200
    const ids = new Set(snap.rows.map((r) => r.itemId));
    for (const id of SNAP_CAP_IDS) expect(ids.has(id), id).toBe(true);
    expect(ids.has("SNAPF-OLD")).toBe(false);
  });

  it("each row's badges equal the CRM browse's, item for item", async () => {
    const snap = await fullSnapshot();
    const crm = await request(app).get("/price-book/atomics").query({ category: SNAP_SECTION, limit: 60 });
    const bySnap = byId(snap.rows as unknown as Row[]);
    expect((crm.body.atomics as Row[]).length).toBe(4); // SNAPA-001, SNAPA-002, snapb-lower, SNAPC-NODESC — the retired one is not browsable
    for (const c of crm.body.atomics as Row[]) {
      const f = bySnap.get(c.itemId)!;
      expect(f, c.itemId).toBeDefined();
      for (const key of FIELD_ROW_KEYS) expect(f[key], `${c.itemId}.${key}`).toEqual(c[key]);
    }
  });

  it("the sections are the section cards' list and counts, exactly", async () => {
    const snap = await fullSnapshot();
    expect(snap.sections).toEqual(await browseSections(prisma));
    const cards = await auth(request(app).get("/health-record/quote-catalog/sections"));
    expect(snap.sections).toEqual(cards.body.data.sections);
    expect(snap.sections.find((s) => s.section === SNAP_SECTION)).toEqual({ section: SNAP_SECTION, itemCount: 4 }); // five rows, one retired
    expect(snap.sections.find((s) => s.section === SNAP_CAP_SECTION)).toEqual({ section: SNAP_CAP_SECTION, itemCount: SNAP_CAP_IDS.length });
  });

  it("the version: a matching one gets {unchanged:true} and no rows; a stale or junk one gets the whole book", async () => {
    const snap = await fullSnapshot();
    const same = await snapshotGet(snap.version);
    expect(same.status).toBe(200);
    expect(same.body.data).toEqual({ unchanged: true, version: snap.version });

    for (const stale of ["0:none", "not-a-version", snap.version + "x"]) {
      const res = await snapshotGet(stale);
      expect(res.status, stale).toBe(200);
      expect(res.body.data.unchanged, stale).toBeUndefined();
      expect(res.body.data.rows.length, stale).toBe(snap.rows.length);
      expect(res.body.data.version, stale).toBe(snap.version);
    }
    // A version sent twice (?version=a&version=b) is not a string — it is ignored, never a 500.
    const twice = await auth(request(app).get("/health-record/quote-catalog/snapshot?version=a&version=b"));
    expect(twice.status).toBe(200);
    expect(twice.body.data.rows.length).toBe(snap.rows.length);
  });

  it("the version moves when the book moves: a retire, an un-retire, a reworded item, a new item, a removed item", async () => {
    const v0 = (await fullSnapshot()).version;
    const changed = async (label: string, prev: string) => {
      const res = await snapshotGet(prev);
      expect(res.status, label).toBe(200);
      expect(res.body.data.unchanged, `${label}: the phone must be told to refresh`).toBeUndefined();
      expect(res.body.data.version, label).not.toBe(prev);
      return res.body.data as FieldCatalogSnapshot;
    };

    await prisma.priceBookAtomic.update({ where: { itemId: "SNAPA-002" }, data: { retiredAt: new Date() } });
    const retired = await changed("retire", v0);
    expect(retired.rows.map((r) => r.itemId)).not.toContain("SNAPA-002");
    expect(retired.sections.find((s) => s.section === SNAP_SECTION)!.itemCount).toBe(3);

    await prisma.priceBookAtomic.update({ where: { itemId: "SNAPA-002" }, data: { retiredAt: null } });
    const back = await changed("un-retire", retired.version);
    expect(back.rows.map((r) => r.itemId)).toContain("SNAPA-002");

    await prisma.priceBookAtomic.update({ where: { itemId: "SNAPA-001" }, data: { description: "Snap Duplex RECEPTACLE 20A" } });
    const reworded = await changed("reword", back.version);
    expect(reworded.rows.find((r) => r.itemId === "SNAPA-001")!.description).toBe("Snap Duplex RECEPTACLE 20A");

    await seedAtomics([quotableAtomic("SNAPG-NEW", { category: SNAP_SECTION, description: "Snap brand new item", unit: "ea" })]);
    const added = await changed("new item", reworded.version);
    expect(added.rows.map((r) => r.itemId)).toContain("SNAPG-NEW");

    await deleteAtomics(["SNAPG-NEW"]);
    const removed = await changed("removed item", added.version);
    expect(removed.rows.map((r) => r.itemId)).not.toContain("SNAPG-NEW");

    // And with nothing touched since, the latest version is current again.
    expect((await snapshotGet(removed.version)).body.data).toEqual({ unchanged: true, version: removed.version });
    await prisma.priceBookAtomic.update({ where: { itemId: "SNAPA-001" }, data: { description: "Snap Duplex RECEPTACLE 15A" } });
  });

  // The phone filters its saved copy with these two functions; the online picker filters with the
  // server's browseAtomics. They must agree on what matches, for every kind of text a tech types.
  describe("search on the saved copy answers like the online picker", () => {
    const SEARCHES = [
      "receptacle", "RECEPTACLE", "Receptacle", "  receptacle  ", "gfci", "snapa", "SNAPA-00", "snapa-001",
      "lower-case", "LOWER", "nodesc", "SNAPC", "weather resistant", "snap", "zzzqqq-no-such-thing",
      "50", "off", "'quoted'", "quoted' item", "snapcap-1", "filler SNAPCAP-2", "",
    ];

    async function offlineIds(q: string, section: string | null = null): Promise<string[]> {
      const snap = await fullSnapshot();
      return snap.rows.filter((r) => matchesCatalogSearch(r, q) && inSection(r, section)).map((r) => r.itemId);
    }

    for (const q of SEARCHES) {
      it(`search ${JSON.stringify(q)}`, async () => {
        const online = await auth(request(app).get("/health-record/quote-catalog").query({ search: q }));
        expect(online.status).toBe(200);
        const onlineIds = (online.body.data.atomics as Row[]).map((r) => r.itemId);
        const offline = await offlineIds(q);
        // Same number of matches, and the picker's page is the head of the saved copy's list.
        expect(online.body.data.total, "total matches").toBe(offline.length);
        expect(onlineIds, "the rows the picker shows").toEqual(offline.slice(0, onlineIds.length));
      });
    }

    // KNOWN DIFFERENCE, deliberately NOT mirrored (2026-10-09): the server's search is Prisma `contains`,
    // which does not escape "%" and "_", so ONLINE typing "%" lists every item and "5_%" matches anything
    // with a 5 in it. The saved copy reads them as the plain characters they are. browseAtomics is shared
    // with the CRM and the MCP tools, so the escape belongs there, not in a phone-only workaround.
    it("a % or _ typed into the saved copy is plain text — it finds only items that really contain it", async () => {
      const snap = await fullSnapshot();
      for (const q of ["%", "_", "50%", "off_deal", "5_%"]) {
        const hits = snap.rows.filter((r) => matchesCatalogSearch(r, q));
        for (const h of hits) expect(`${h.itemId} ${h.description ?? ""}`.toLowerCase(), q).toContain(q.toLowerCase());
      }
      expect(snap.rows.filter((r) => matchesCatalogSearch(r, "50%")).map((r) => r.itemId)).toContain("SNAPD-PCT");
      expect(snap.rows.filter((r) => matchesCatalogSearch(r, "5_%")).map((r) => r.itemId)).toEqual([]);
    });

    it("a section browse (the section card's own name) lists the same items", async () => {
      for (const section of [SNAP_SECTION, SNAP_OTHER, SNAP_CAP_SECTION, SECTION]) {
        const online = await auth(request(app).get("/health-record/quote-catalog").query({ category: section }));
        const offline = await offlineIds("", section);
        expect(online.body.data.total, section).toBe(offline.length);
        expect((online.body.data.atomics as Row[]).map((r) => r.itemId), section).toEqual(offline.slice(0, online.body.data.count));
      }
    });

    it("a section name typed in another case or in part matches the same way (the server's category filter is 'contains')", async () => {
      for (const section of ["snap test section", "SNAP TEST", "test other", "  SNAP CAP  "]) {
        const online = await auth(request(app).get("/health-record/quote-catalog").query({ category: section }));
        const offline = await offlineIds("", section);
        expect(online.body.data.total, section).toBe(offline.length);
        expect((online.body.data.atomics as Row[]).map((r) => r.itemId), section).toEqual(offline.slice(0, online.body.data.count));
      }
    });

    it("a search inside a section needs both, as it does online", async () => {
      const online = await auth(request(app).get("/health-record/quote-catalog").query({ search: "receptacle", category: SNAP_SECTION }));
      const offline = await offlineIds("receptacle", SNAP_SECTION);
      expect(offline).toEqual(["SNAPA-001", "SNAPA-002"]);
      expect((online.body.data.atomics as Row[]).map((r) => r.itemId)).toEqual(offline);
    });
  });
});

describe("matchesCatalogSearch and inSection — the pure rules", () => {
  const row = (itemId: string, description: string | null, category: string | null): FieldCatalogRow =>
    ({ itemId, description, category, unit: "ea", isAssembly: false, hasLabourUnitBasis: true, hasPriceAtActiveSupplier: true, isFlatPriced: true, isContinuousLength: false, hasPublishedLabour: true, sellsMaterial: true, isHourlyProduct: false });

  it("matches the code or the description, anywhere in the text, ignoring case, after trimming", () => {
    const r = row("A016", "Duplex Receptacle 15A", "DEVICES");
    expect(matchesCatalogSearch(r, "a016")).toBe(true);
    expect(matchesCatalogSearch(r, "A01")).toBe(true);
    expect(matchesCatalogSearch(r, "016")).toBe(true);
    expect(matchesCatalogSearch(r, "  duplex  ")).toBe(true);
    expect(matchesCatalogSearch(r, "plex rece")).toBe(true);
    expect(matchesCatalogSearch(r, "15a")).toBe(true);
    expect(matchesCatalogSearch(r, "devices")).toBe(false); // the category is not searched, only code and description
    expect(matchesCatalogSearch(r, "gfci")).toBe(false);
  });

  it("a blank search matches everything; a missing description still matches on its code", () => {
    const r = row("X1", null, null);
    for (const q of ["", "   ", null, undefined]) expect(matchesCatalogSearch(r, q)).toBe(true);
    expect(matchesCatalogSearch(r, "x1")).toBe(true);
    expect(matchesCatalogSearch(r, "null")).toBe(false);
    expect(matchesCatalogSearch(r, "undefined")).toBe(false);
  });

  it("characters that mean something to LIKE or a regex are plain text", () => {
    const r = row("P1", "50% off_deal (a+b)", null);
    expect(matchesCatalogSearch(r, "50%")).toBe(true);
    expect(matchesCatalogSearch(r, "off_deal")).toBe(true);
    expect(matchesCatalogSearch(r, "(a+b)")).toBe(true);
    expect(matchesCatalogSearch(r, "%")).toBe(true);
    expect(matchesCatalogSearch(r, "5_%")).toBe(false);
    expect(matchesCatalogSearch(r, ".*")).toBe(false);
  });

  it("inSection is 'contains, ignoring case' on the category, like the server's category filter", () => {
    expect(inSection(row("a", null, "Wire and Cable"), "wire")).toBe(true);
    expect(inSection(row("a", null, "Wire and Cable"), "Wire and Cable")).toBe(true);
    expect(inSection(row("a", null, "Wire and Cable"), " cable ")).toBe(true);
    expect(inSection(row("a", null, "Devices"), "wire")).toBe(false);
    expect(inSection(row("a", null, null), "wire")).toBe(false);
    for (const s of ["", "  ", null, undefined]) expect(inSection(row("a", null, null), s)).toBe(true);
  });
});
