/**
 * The owner-guarded settings family (work order agent-team, step 0): GET and PUT
 * `/owner-settings/:key`. Behind the session gate like every other CRM route (NOT on the public
 * allowlist). Reading AND writing both require Kyle (the PIN session, gate-disabled in dev/test, or
 * his principal CRM login) - another person's login, whatever its role, and the AI admin get a 403
 * with the reason. Keys are an explicit allowlist (services/ownerSettings.ts), each with its own
 * schema; an unknown key is a 400.
 *
 * This is NOT the open `PUT /crm/settings/:key` (app.ts). A key that belongs here is never added there.
 */
import express from "express";
import { z } from "zod";
import { asyncHandler, readParam } from "../lib/routeHelpers";
import { requireBotKeys, requireKyle as requireKyleWith } from "../middleware/kylePowers";
import { actorNameOf } from "../lib/actorName";
import {
  OWNER_SETTINGS, getOwnerSetting, isOwnerSettingKey, saveOwnerSetting, type OwnerSettingKey,
} from "../services/ownerSettings";

export const ownerSettingsRouter = express.Router();

const kyleOnly = requireKyleWith("Only Kyle can see or change this setting.");
const botKeysOnly = requireBotKeys();

/**
 * Each key declares its own guard (services/ownerSettings.ts). quietHours is Kyle himself;
 * agentAccess, the agent kill switch, is the `bot_keys` power (Kyle always passes it, the AI admin
 * never does). An unknown key falls to Kyle-only, so it is a 403 for anyone else and a 400 for Kyle.
 */
const guard: express.RequestHandler = (req, res, next) => {
  const key = readParam(req, "key");
  if (isOwnerSettingKey(key) && OWNER_SETTINGS[key].guard === "bot_keys") {
    botKeysOnly(req, res, next);
    return;
  }
  kyleOnly(req, res, next);
};

function knownKey(req: express.Request, res: express.Response): OwnerSettingKey | null {
  const key = readParam(req, "key");
  if (isOwnerSettingKey(key)) return key;
  res.status(400).json({ error: `Unknown setting. Valid settings: ${Object.keys(OWNER_SETTINGS).join(", ")}` });
  return null;
}

ownerSettingsRouter.get("/owner-settings/:key", guard, asyncHandler(async (req, res) => {
  const key = knownKey(req, res);
  if (key === null) return;
  const def = OWNER_SETTINGS[key];
  res.json({ key, value: await getOwnerSetting(key), ...(def.status ? { status: def.status() } : {}) });
}));

ownerSettingsRouter.put("/owner-settings/:key", guard, asyncHandler(async (req, res) => {
  const key = knownKey(req, res);
  if (key === null) return;
  try {
    const def = OWNER_SETTINGS[key];
    const actor = await actorNameOf(req);
    const previous = def.onSaved ? await getOwnerSetting(key) : null;
    const input = def.stamp ? def.stamp(req.body, actor, new Date()) : req.body;
    const value = await saveOwnerSetting(key, input);
    def.onSaved?.(previous, value, actor);
    res.json({ key, value, ...(def.status ? { status: def.status() } : {}) });
  } catch (err) {
    // The schema's own sentence is the answer ("Quiet hours can't go earlier than ..."), not the
    // app-wide "Validation failed".
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.issues.map((i) => i.message).join(" ") });
      return;
    }
    throw err;
  }
}));
