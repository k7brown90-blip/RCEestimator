/**
 * Settings -> "AI admin login" (Kyle, 2026-11-15: "Lets do a username and password so it can save
 * it and login on its own"). Behind the session gate like every other CRM route: NOT on the public
 * allowlist. Reading is open to any signed-in session; CHANGING the login is owner-only, so the AI
 * admin can never change, re-enable or remove its own login (that would let it undo Kyle turning
 * it off). The hash is never returned.
 */
import express from "express";
import { z } from "zod";
import type { RequestAuthState } from "../middleware/accessLog";
import {
  ADMIN_PASSWORD_MAX_BYTES, ADMIN_PASSWORD_MIN, getAdminLogin, removeAdminLogin, saveAdminLogin,
  setAdminLoginEnabled, toAdminLoginView,
} from "../services/adminLogin";
import { asyncHandler } from "../lib/routeHelpers";

export const adminLoginRouter = express.Router();

const saveSchema = z.object({
  username: z.string().trim().min(3, "Username must be at least 3 characters").max(100, "Username is too long"),
  password: z.string()
    .min(ADMIN_PASSWORD_MIN, `Password must be at least ${ADMIN_PASSWORD_MIN} characters`)
    .refine((p) => Buffer.byteLength(p, "utf8") <= ADMIN_PASSWORD_MAX_BYTES, `Password is too long (max ${ADMIN_PASSWORD_MAX_BYTES} bytes)`),
});

/**
 * Only Kyle's own (owner) session may change the login. `gate-disabled` is the dev/test
 * convenience where the whole gate is off and everything is open anyway.
 */
const requireOwner: express.RequestHandler = (req, res, next) => {
  const state = req as express.Request & RequestAuthState;
  if (state._authActor === "owner" || state._authOutcome === "gate-disabled") {
    next();
    return;
  }
  res.status(403).json({ error: "Only the owner can change the AI admin login." });
};

adminLoginRouter.get("/settings/admin-login", asyncHandler(async (_req, res) => {
  res.json(toAdminLoginView(await getAdminLogin()));
}));

adminLoginRouter.put("/settings/admin-login", requireOwner, asyncHandler(async (req, res) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(" ") });
    return;
  }
  const row = await saveAdminLogin(parsed.data.username, parsed.data.password);
  res.json(toAdminLoginView(row));
}));

adminLoginRouter.post("/settings/admin-login/disable", requireOwner, asyncHandler(async (_req, res) => {
  const row = await setAdminLoginEnabled(false);
  if (!row) {
    res.status(404).json({ error: "There is no AI admin login to turn off." });
    return;
  }
  res.json(toAdminLoginView(row));
}));

adminLoginRouter.post("/settings/admin-login/enable", requireOwner, asyncHandler(async (_req, res) => {
  const row = await setAdminLoginEnabled(true);
  if (!row) {
    res.status(404).json({ error: "There is no AI admin login to turn on." });
    return;
  }
  res.json(toAdminLoginView(row));
}));

adminLoginRouter.delete("/settings/admin-login", requireOwner, asyncHandler(async (_req, res) => {
  const removed = await removeAdminLogin();
  if (!removed) {
    res.status(404).json({ error: "There is no AI admin login to remove." });
    return;
  }
  res.json(toAdminLoginView(null));
}));
