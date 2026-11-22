import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Request } from "express";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import type { RequestAuthState } from "../src/middleware/accessLog";
import { canApprove, hasKylePower, isKyle, requireKylePower } from "../src/middleware/kylePowers";
import { removeCrmLogin, saveCrmLogin, setPowers, setPrincipal } from "../src/services/crmLogin";
import { saveAdminLogin } from "../src/services/adminLogin";
import { CRM_POWERS, type CrmPower } from "../shared/crmPowers";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

/**
 * Work order agent-team, HA3: the Kyle-only power gate on the routes that exist today. The PIN
 * session is Kyle; the principal CRM login is Kyle; another person (whatever their role) holds a
 * power only when Kyle grants it; the AI admin never does. Runs with PIN_HASH set; the gate-disabled
 * path is tested separately at the bottom.
 */

const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const ITEM = "KPTEST001";
const PRICE_REASON = CRM_POWERS.price_book_edit.reason;
const TREASURY_REASON = CRM_POWERS.treasury.reason;

const MY_ITEMS = [ITEM, "KPNEW001", "KPNEW002", "KPASM001"];
/** Assemblies the granted calls create hold a component row on ITEM (onDelete Restrict), so those go first. */
async function cleanItems(): Promise<void> {
  await prisma.priceBookItemComponent.deleteMany({
    where: { OR: [{ parentItemId: { in: MY_ITEMS } }, { childItemId: { in: MY_ITEMS } }] },
  });
  await prisma.priceBookEdit.deleteMany({ where: { itemId: { in: MY_ITEMS } } });
  await deleteAtomics(MY_ITEMS);
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  process.env.PIN_HASH = await hashPin(PIN);
  await ensurePriceBookGates();
});
afterAll(async () => {
  delete process.env.PIN_HASH;
  await cleanItems();
  await prisma.companySetting.deleteMany({ where: { key: { in: ["treasury", "quietHours"] } } });
  await cleanupCrmLoginFixtures();
});
beforeEach(async () => {
  await cleanupCrmLoginFixtures();
  await cleanItems();
  await seedAtomics([quotableAtomic(ITEM)]);
});

async function pinToken(): Promise<string> {
  const res = await request(app).post("/auth/pin").send({ pin: PIN });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

async function login(username: string): Promise<string> {
  const res = await request(app).post("/auth/login").send({ username, password: PASS });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

/** An owner-ROLE login with no grant: the role must not matter. */
async function michael() {
  const person = await makePerson("Michael");
  const row = await saveCrmLogin(person.id, { username: "michael", role: "owner", password: PASS });
  return { row, token: await login("michael") };
}

async function aiAdminToken(): Promise<string> {
  await saveAdminLogin("grok-admin", AI_PASS);
  const res = await request(app).post("/auth/login").send({ username: "grok-admin", password: AI_PASS });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

function fakeReq(state: RequestAuthState): Request {
  return state as unknown as Request;
}

describe("hasKylePower / isKyle / canApprove", () => {
  const login = (over: Partial<NonNullable<RequestAuthState["_crmLogin"]>> = {}): NonNullable<RequestAuthState["_crmLogin"]> => ({
    id: "l1", technicianId: "t1", name: "N", username: "n", role: "owner", isPrincipal: false, powers: [], ...over,
  });

  it("passes the PIN session and the gate-disabled convenience for every power", () => {
    for (const power of Object.keys(CRM_POWERS) as CrmPower[]) {
      expect(hasKylePower(fakeReq({ _authActor: "owner", _authOutcome: "ok" }), power)).toBe(true);
      expect(hasKylePower(fakeReq({ _authOutcome: "gate-disabled" }), power)).toBe(true);
    }
    expect(isKyle(fakeReq({ _authActor: "owner" }))).toBe(true);
    expect(isKyle(fakeReq({ _authOutcome: "gate-disabled" }))).toBe(true);
  });

  it("passes the principal login for every power, and a person for exactly their grants", () => {
    const principal = fakeReq({ _authActor: "user:l1", _crmLogin: login({ isPrincipal: true }) });
    expect(isKyle(principal)).toBe(true);
    expect(hasKylePower(principal, "bot_keys")).toBe(true);
    const granted = fakeReq({ _authActor: "user:l1", _crmLogin: login({ powers: ["treasury"] }) });
    expect(hasKylePower(granted, "treasury")).toBe(true);
    expect(hasKylePower(granted, "price_book_edit")).toBe(false);
    expect(isKyle(granted)).toBe(false);
  });

  it("never consults the role", () => {
    const owner = fakeReq({ _authActor: "user:l1", _crmLogin: login({ role: "owner" }) });
    expect(hasKylePower(owner, "treasury")).toBe(false);
    expect(hasKylePower(owner, "approve_drafts")).toBe(false);
  });

  it("never passes the AI admin, a bare session or an unauthenticated request", () => {
    expect(isKyle(fakeReq({ _authActor: "ai-admin", _authOutcome: "ok" }))).toBe(false);
    expect(hasKylePower(fakeReq({ _authActor: "ai-admin", _authOutcome: "ok" }), "treasury")).toBe(false);
    expect(hasKylePower(fakeReq({}), "treasury")).toBe(false);
    expect(hasKylePower(fakeReq({ _authOutcome: "unauthenticated" }), "treasury")).toBe(false);
  });

  it("canApprove is the approve_drafts power: Kyle, or a login Kyle granted it to", () => {
    expect(canApprove(fakeReq({ _authActor: "owner" }))).toBe(true);
    expect(canApprove(fakeReq({ _authActor: "user:l1", _crmLogin: login() }))).toBe(false);
    expect(canApprove(fakeReq({ _authActor: "user:l1", _crmLogin: login({ powers: ["approve_drafts"] }) }))).toBe(true);
    expect(canApprove(fakeReq({ _authActor: "user:l1", _crmLogin: login({ powers: ["treasury"] }) }))).toBe(false);
    expect(canApprove(fakeReq({ _authActor: "ai-admin" }))).toBe(false);
  });

  it("requireKylePower with a `when` lets an unaffected request straight through", () => {
    let nexted = false;
    let status = 0;
    const res = { status: (s: number) => { status = s; return { json: () => undefined }; } };
    requireKylePower("treasury", () => false)(fakeReq({}), res as never, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(status).toBe(0);
    nexted = false;
    requireKylePower("treasury", () => true)(fakeReq({}), res as never, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(status).toBe(403);
  });
});

describe("PATCH /price-book/catalog/items/:itemId is gated field by field", () => {
  const patch = (token: string, body: Record<string, unknown>) =>
    request(app).patch(`/price-book/catalog/items/${ITEM}`).set(bearer(token)).send(body);
  const stored = () => prisma.priceBookAtomic.findUniqueOrThrow({ where: { itemId: ITEM } });

  it("the PIN may rename; the row changes", async () => {
    const res = await patch(await pinToken(), { description: "Renamed by Kyle" });
    expect(res.status).toBe(200);
    expect((await stored()).description).toBe("Renamed by Kyle");
  });

  it("an owner-role login without the grant gets 403 with the reason, and the row is unchanged", async () => {
    const before = await stored();
    const { token } = await michael();
    for (const body of [
      { description: "Renamed" }, { companyCost: 99 }, { companyCost: null }, { laborNormal: 9 }, { laborDifficult: 9 }, { laborVeryDifficult: 9 },
    ]) {
      const res = await patch(token, body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body).toEqual({ error: PRICE_REASON });
    }
    expect(await stored()).toEqual(before);
  });

  it("a rowType-only PATCH is Kyle-only: it rewrites companyPrice and every sell column, so it is refused and the row is unchanged", async () => {
    const before = await stored();
    const { token } = await michael();
    for (const rowType of ["LABOR ONLY", "MATERIAL ONLY"]) {
      const res = await patch(token, { rowType });
      expect(res.status, rowType).toBe(403);
      expect(res.body).toEqual({ error: PRICE_REASON });
    }
    expect(await stored()).toEqual(before);
    // The same patch from Kyle goes through and moves the price.
    const kyle = await patch(await pinToken(), { rowType: "MATERIAL ONLY" });
    expect(kyle.status).toBe(200);
    expect((await stored()).rowType).toBe("MATERIAL ONLY");
  });

  it("a unitLabel-only PATCH is Kyle-only too: it is the unit fallback the engine reads to band a row as a continuous length", async () => {
    const before = await stored();
    const { token } = await michael();
    const res = await patch(token, { unitLabel: "per foot" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: PRICE_REASON });
    expect(await stored()).toEqual(before);
  });

  it("the open fields stay open to that same login: notes, category, subCategory, sector", async () => {
    const { token } = await michael();
    const res = await patch(token, { notes: "Only a note", category: "DEVICES", subCategory: "x", sector: "Residential" });
    expect(res.status).toBe(200);
    const row = await stored();
    expect(row.notes).toBe("Only a note");
    expect(row.subCategory).toBe("x");
  });

  it("a body that mixes an open field and a price is refused whole", async () => {
    const before = await stored();
    const { token } = await michael();
    const res = await patch(token, { notes: "sneaky", companyCost: 1 });
    expect(res.status).toBe(403);
    expect(await stored()).toEqual(before);
  });

  it("after Kyle grants price_book_edit it is 200, after revoke 403 again", async () => {
    const { row, token } = await michael();
    await setPowers(row.id, ["price_book_edit"]);
    expect((await patch(token, { description: "Granted rename" })).status).toBe(200);
    await setPowers(row.id, ["treasury"]); // a different power does not help
    expect((await patch(token, { description: "Wrong power" })).status).toBe(403);
    await setPowers(row.id, []);
    const res = await patch(token, { description: "Revoked rename" });
    expect(res.status).toBe(403);
    expect((await stored()).description).toBe("Granted rename");
  });

  it("the principal login is 200 with no grant at all", async () => {
    const person = await makePerson("Kyle");
    const row = await saveCrmLogin(person.id, { username: "kyle", role: "owner", password: PASS });
    await setPrincipal(row.id);
    expect((await patch(await login("kyle"), { description: "Principal rename" })).status).toBe(200);
  });

  it("the AI admin gets 403, even for a field that is open to people", async () => {
    const token = await aiAdminToken();
    expect((await patch(token, { description: "AI rename" })).status).toBe(403);
    expect((await patch(token, { notes: "AI note" })).status).toBe(200); // open fields stay open to it
  });
});

describe("the other price-book routes", () => {
  const newItem = { itemId: "KPNEW001", description: "A new item", category: "DEVICES", rowType: "MATERIAL ONLY" };
  const create = (token: string, body: Record<string, unknown>) =>
    request(app).post("/price-book/catalog/items").set(bearer(token)).send(body);

  it("creating an item with a cost or hours is Kyle-only; without them it stays open", async () => {
    const { token } = await michael();
    for (const extra of [{ companyCost: 5 }, { laborNormal: 1 }, { laborDifficult: 0 }, { laborVeryDifficult: 2 }]) {
      const res = await create(token, { ...newItem, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(403);
      expect(res.body).toEqual({ error: PRICE_REASON });
    }
    expect(await prisma.priceBookAtomic.count({ where: { itemId: "KPNEW001" } })).toBe(0);
    // null is "not given", like leaving it out.
    const open = await create(token, { ...newItem, companyCost: null, laborNormal: null });
    expect(open.status).toBe(201);
  });

  it("creating an item with a cost passes the gate for Kyle and a granted login", async () => {
    const pin = await pinToken();
    const kyle = await create(pin, { ...newItem, companyCost: 5 });
    expect(kyle.status).not.toBe(403);
    expect(kyle.status).not.toBe(401);
    const { row, token } = await michael();
    await setPowers(row.id, ["price_book_edit"]);
    const granted = await create(token, { ...newItem, itemId: "KPNEW002", companyCost: 5 });
    expect(granted.status).not.toBe(403);
  });

  /** Each is gated unconditionally: refused with the reason for a non-Kyle, past the gate for Kyle. */
  const routes: Array<{ label: string; send: (t: string) => request.Test }> = [
    {
      label: "POST /price-book/catalog/assemblies with a component",
      send: (t) => request(app).post("/price-book/catalog/assemblies").set(bearer(t))
        .send({ itemId: "KPASM001", description: "Asm", category: "DEVICES", components: [{ childItemId: ITEM, quantity: 1 }] }),
    },
    {
      label: "POST /price-book/catalog/assemblies with a labor override",
      send: (t) => request(app).post("/price-book/catalog/assemblies").set(bearer(t))
        .send({ itemId: "KPASM001", description: "Asm", category: "DEVICES", laborOverrides: { laborNormal: 1 } }),
    },
    {
      label: "PUT /price-book/catalog/assemblies/:itemId/components",
      send: (t) => request(app).put("/price-book/catalog/assemblies/NOPE/components").set(bearer(t)).send({ components: [] }),
    },
    {
      label: "PUT /price-book/catalog/assemblies/:itemId/labor-override",
      send: (t) => request(app).put("/price-book/catalog/assemblies/NOPE/labor-override").set(bearer(t)).send({ tier: "laborNormal", value: 1 }),
    },
    {
      label: "POST /price-book/refresh/accept",
      send: (t) => request(app).post("/price-book/refresh/accept").set(bearer(t)).send({ itemId: "NOPE", supplierName: "x" }),
    },
    {
      label: "POST /price-book/billed-rate",
      // 1,000,000 an hour is refused by the rate's own validation (400) AFTER the gate, so nothing is repriced.
      send: (t) => request(app).post("/price-book/billed-rate").set(bearer(t)).send({ rate: 99999999 }),
    },
  ];

  for (const route of routes) {
    it(`${route.label}: refused for a login without the grant and for the AI admin; past the gate for the PIN, a grant and the principal`, async () => {
      const { row, token } = await michael();
      const denied = await route.send(token);
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: PRICE_REASON });
      expect((await route.send(await aiAdminToken())).status).toBe(403);

      expect((await route.send(await pinToken())).status).not.toBe(403);

      await setPowers(row.id, ["price_book_edit"]);
      expect((await route.send(token)).status).not.toBe(403);
      await setPowers(row.id, []);
      expect((await route.send(token)).status).toBe(403);

      await setPrincipal(row.id);
      expect((await route.send(token)).status).not.toBe(403);
    });
  }

  it("creating an assembly with no components and no hours stays open to a person", async () => {
    const { token } = await michael();
    const res = await request(app).post("/price-book/catalog/assemblies").set(bearer(token))
      .send({ itemId: "KPASM001", description: "Empty shell", category: "DEVICES" });
    expect(res.status).not.toBe(403);
  });

  it("price-book changes that are NOT prices, hours or names stay open: retire and restore", async () => {
    const { token } = await michael();
    const retire = await request(app).post(`/price-book/catalog/items/${ITEM}/retire`).set(bearer(token));
    expect(retire.status).toBe(200);
    const restore = await request(app).post(`/price-book/catalog/items/${ITEM}/restore`).set(bearer(token));
    expect(restore.status).toBe(200);
  });

  it("a non-Kyle promote derives NO cost from a lastCost the user typed; a Kyle promote still derives it", async () => {
    const { row, token } = await michael();
    const pin = await pinToken();
    const made: string[] = [];
    const cleanup = async () => {
      await prisma.material.deleteMany({ where: { id: { in: made } } });
      await prisma.priceBookEdit.deleteMany({ where: { itemId: { startsWith: "KPPR" } } });
      await prisma.priceBookAtomic.deleteMany({ where: { itemId: { startsWith: "KPPR" } } });
    };
    try {
      const mk = async (t: string) => {
        const res = await request(app).post("/materials").set(bearer(t)).send({ description: "Ten pack", lastCost: 50, packQty: 10 });
        expect(res.status).toBe(201); // POST /materials is not gated: that is the premise of the fix
        made.push(res.body.id as string);
        return res.body.id as string;
      };
      const body = { description: "Promoted ten pack", category: "DEVICES", rowType: "MATERIAL ONLY", idPrefix: "KPPR" };

      const mine = await request(app).post("/materials/" + (await mk(token)) + "/promote").set(bearer(token)).send(body);
      expect(mine.status).toBe(201);
      expect(mine.body.atomic.companyCost).toBeNull();

      const kyle = await request(app).post("/materials/" + (await mk(pin)) + "/promote").set(bearer(pin)).send(body);
      expect(kyle.status).toBe(201);
      expect(kyle.body.atomic.companyCost).toBe(5); // 50 / 10

      // A login Kyle has granted the power derives it too.
      await setPowers(row.id, ["price_book_edit"]);
      const granted = await request(app).post("/materials/" + (await mk(token)) + "/promote").set(bearer(token)).send(body);
      expect(granted.status).toBe(201);
      expect(granted.body.atomic.companyCost).toBe(5);
    } finally {
      await cleanup();
    }
  });

  it("promoting a material with a typed cost is gated like creating an item; with none it is not", async () => {
    const { token } = await michael();
    const body = { description: "Promoted", category: "DEVICES", rowType: "MATERIAL ONLY" };
    const typed = await request(app).post("/materials/no-such-material/promote").set(bearer(token)).send({ ...body, companyCost: 3 });
    expect(typed.status).toBe(403);
    const plain = await request(app).post("/materials/no-such-material/promote").set(bearer(token)).send(body);
    expect(plain.status).toBe(409); // past the gate: "Material not found"
  });
});

describe("Treasury and the Sweep", () => {
  const save = (t: string) => request(app).put("/settings/treasury").set(bearer(t)).send({ mainFloat: 1234.5 });
  const sweep = (t: string) => request(app).post("/financials/sweep").set(bearer(t)).send({ amount: 1, confirm: "" });
  const stored = async () => (await prisma.companySetting.findUnique({ where: { key: "treasury" } }))?.valueJson ?? null;

  it("PUT /settings/treasury: PIN 200; no grant 403 with the reason and nothing stored; AI admin 403; grant 200; revoke 403", async () => {
    const { row, token } = await michael();
    const denied = await save(token);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: TREASURY_REASON });
    expect(await stored()).toBeNull();
    expect((await save(await aiAdminToken())).status).toBe(403);
    expect(await stored()).toBeNull();

    expect((await save(await pinToken())).status).toBe(200);
    expect(JSON.parse((await stored())!).mainFloat).toBe(1234.5);

    await prisma.companySetting.deleteMany({ where: { key: "treasury" } });
    await setPowers(row.id, ["treasury"]);
    expect((await save(token)).status).toBe(200);
    await setPowers(row.id, ["price_book_edit"]); // the price power is not the treasury power
    expect((await save(token)).status).toBe(403);
    await setPowers(row.id, []);
    expect((await save(token)).status).toBe(403);
    await setPrincipal(row.id);
    expect((await save(token)).status).toBe(200);
  });

  it("POST /financials/sweep is refused for a non-Kyle session before anything runs, and reaches the sweep for Kyle", async () => {
    const { row, token } = await michael();
    const denied = await sweep(token);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: TREASURY_REASON });
    expect((await sweep(await aiAdminToken())).status).toBe(403);

    // Past the gate the sweep refuses the missing confirmation word itself (400): not a 403.
    const kyle = await sweep(await pinToken());
    expect(kyle.status).toBe(400);
    await setPowers(row.id, ["treasury"]);
    expect((await sweep(token)).status).toBe(400);
    await removeCrmLogin(row.id);
  });
});

describe("with the gate off (dev/test) the gated routes are open, exactly like requireOwner", () => {
  it("passes every gated route without any session", async () => {
    const saved = process.env.PIN_HASH;
    delete process.env.PIN_HASH;
    try {
      const patch = await request(app).patch(`/price-book/catalog/items/${ITEM}`).send({ description: "Gate off rename" });
      expect(patch.status).toBe(200);
      expect((await request(app).put("/settings/treasury").send({ mainFloat: 1 })).status).toBe(200);
      expect((await request(app).post("/financials/sweep").send({ amount: 1 })).status).toBe(400);
      expect((await request(app).post("/price-book/billed-rate").send({ rate: 99999999 })).status).toBe(400);
    } finally {
      process.env.PIN_HASH = saved;
    }
  });
});
