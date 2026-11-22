import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { DEFAULT_AGENT_ACCESS, getAgentAccess, getOwnerSetting, isOwnerSettingKey } from "../src/services/ownerSettings";

/**
 * Work order agent-team, K-U1: the agent kill switch is ONE key in the owner-settings family
 * (CompanySetting "agentAccess"), not a second settings store. Its Settings card and its own write
 * route come with K-U2; the family's Kyle-only PUT already guards it.
 */

const PIN = "1234";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const clear = () => prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });

let savedPin: string | undefined;
beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  process.env.PIN_HASH = await hashPin(PIN);
});
afterAll(async () => {
  if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  await clear();
});
beforeEach(clear);

describe("the agentAccess owner setting", () => {
  it("is an owner-settings key whose default is on", async () => {
    expect(isOwnerSettingKey("agentAccess")).toBe(true);
    expect(await getOwnerSetting("agentAccess")).toEqual(DEFAULT_AGENT_ACCESS);
    expect(DEFAULT_AGENT_ACCESS.mode).toBe("on");
    expect((await getAgentAccess()).mode).toBe("on");
  });

  it("Kyle can set it through the one owner-settings route, and the gate's reader sees it at once", async () => {
    const token = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    const put = await request(app).put("/owner-settings/agentAccess").set(bearer(token))
      .send({ mode: "off", changedAt: "2026-11-21T12:00:00-06:00", changedBy: "Kyle" });
    expect(put.status).toBe(200);
    expect((await getAgentAccess()).mode).toBe("off");
    expect((await request(app).put("/owner-settings/agentAccess").set(bearer(token)).send({ mode: "sideways" })).status).toBe(400);
    expect((await getAgentAccess()).mode).toBe("off");
  });

  it("is never served by the open GET /crm/settings", async () => {
    const token = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    await prisma.companySetting.create({ data: { key: "agentAccess", valueJson: JSON.stringify({ mode: "read_only", changedAt: null, changedBy: null }) } });
    const res = await request(app).get("/crm/settings").set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("agentAccess");
    expect((await request(app).put("/crm/settings/agentAccess").set(bearer(token)).send({ mode: "on" })).status).toBeGreaterThanOrEqual(400);
    expect((await getAgentAccess()).mode).toBe("read_only");
  });

  it("GET /owner-settings/agentAccess agrees with the gate's reader on a corrupt row: off, never on", async () => {
    const token = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    for (const valueJson of ["not json", '{"mode":"maybe"}', "{}"]) {
      await prisma.companySetting.upsert({ where: { key: "agentAccess" }, create: { key: "agentAccess", valueJson }, update: { valueJson } });
      const res = await request(app).get("/owner-settings/agentAccess").set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body.value.mode, valueJson).toBe("off");
      expect((await getOwnerSetting("agentAccess")) as { mode: string }).toMatchObject({ mode: "off" });
      expect((await getAgentAccess()).mode).toBe("off");
    }
    await clear();
    expect((await request(app).get("/owner-settings/agentAccess").set(bearer(token))).body.value.mode).toBe("on");
  });

  it("an unreadable stored value reads as off, never on", async () => {
    await prisma.companySetting.create({ data: { key: "agentAccess", valueJson: "not json" } });
    expect((await getAgentAccess()).mode).toBe("off");
  });
});
