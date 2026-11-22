/**
 * Team -> "CRM login" (work order agent-team, HA4): Kyle creates, edits, turns off or on, removes and
 * grants powers to each person's CRM sign-in. Behind the session gate like every other CRM route
 * (NOT on the public allowlist). EVERY route requires Kyle himself - the PIN session, his principal
 * CRM login, or gate-disabled in dev/test - and that is not a grantable power: no person, whatever
 * role or powers, and not the AI admin, can manage logins. The one route that moves the "this is
 * Kyle" mark (`/principal`) is stricter still: the PIN session only, so a principal login cannot
 * hand the mark to someone else or take it from itself.
 *
 * All the work is services/crmLogin.ts; nothing here re-implements it. The password hash is never in
 * any response: every answer is a CrmLoginView.
 */
import express from "express";
import { z } from "zod";
import { asyncHandler, readParam, requireOwner } from "../lib/routeHelpers";
import { requireKyle } from "../middleware/kylePowers";
import { CRM_ROLES } from "../../shared/crmPowers";
import { ADMIN_PASSWORD_MAX_BYTES, ADMIN_PASSWORD_MIN } from "../services/adminLogin";
import {
  CrmLoginError, clearPrincipal, getCrmLoginForPerson, listCrmLogins, removeCrmLogin, saveCrmLogin,
  setCrmLoginEnabled, setPowers, setPrincipal, toCrmLoginView, type CrmLoginWithPerson,
} from "../services/crmLogin";

export const crmLoginsRouter = express.Router();

const KYLE_ONLY = "Only Kyle manages CRM logins.";
const gate = requireKyle(KYLE_ONLY);

/** Like adminLogin's saveSchema, but the password is optional (blank keeps the current one) and there is a role. */
const saveSchema = z.object({
  username: z.string().trim().min(3, "Username must be at least 3 characters").max(100, "Username is too long"),
  password: z.string()
    .min(ADMIN_PASSWORD_MIN, `Password must be at least ${ADMIN_PASSWORD_MIN} characters`)
    .refine((p) => Buffer.byteLength(p, "utf8") <= ADMIN_PASSWORD_MAX_BYTES, `Password is too long (max ${ADMIN_PASSWORD_MAX_BYTES} bytes)`)
    .optional(),
  role: z.enum(CRM_ROLES, { message: "Role must be owner, admin, office or tech" }),
});

const powersSchema = z.object({ powers: z.array(z.string()).max(64) });
const principalSchema = z.object({ principal: z.boolean() });

const NO_LOGIN = "That person has no CRM login.";

/** Run a service call; a CrmLoginError is answered with its own status and sentence. */
async function answer(res: express.Response, run: () => Promise<CrmLoginWithPerson | null>, notFound = NO_LOGIN): Promise<void> {
  try {
    const row = await run();
    if (!row) {
      res.status(404).json({ error: notFound });
      return;
    }
    res.json(toCrmLoginView(row));
  } catch (err) {
    if (err instanceof CrmLoginError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  }
}

/** The login of the person in the URL, or a 404 already sent. */
async function loginOf(req: express.Request, res: express.Response): Promise<CrmLoginWithPerson | null> {
  const login = await getCrmLoginForPerson(readParam(req, "technicianId"));
  if (!login) res.status(404).json({ error: NO_LOGIN });
  return login;
}

crmLoginsRouter.get("/crm-logins", gate, asyncHandler(async (_req, res) => {
  res.json({ logins: (await listCrmLogins()).map(toCrmLoginView) });
}));

crmLoginsRouter.put("/crm-logins/:technicianId", gate, asyncHandler(async (req, res) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(" ") });
    return;
  }
  await answer(res, () => saveCrmLogin(readParam(req, "technicianId"), parsed.data));
}));

crmLoginsRouter.post("/crm-logins/:technicianId/disable", gate, asyncHandler(async (req, res) => {
  const login = await loginOf(req, res);
  if (login) await answer(res, () => setCrmLoginEnabled(login.id, false));
}));

crmLoginsRouter.post("/crm-logins/:technicianId/enable", gate, asyncHandler(async (req, res) => {
  const login = await loginOf(req, res);
  if (login) await answer(res, () => setCrmLoginEnabled(login.id, true));
}));

crmLoginsRouter.delete("/crm-logins/:technicianId", gate, asyncHandler(async (req, res) => {
  const login = await loginOf(req, res);
  if (!login) return;
  await removeCrmLogin(login.id);
  res.json({ removed: true, technicianId: login.technicianId });
}));

crmLoginsRouter.put("/crm-logins/:technicianId/powers", gate, asyncHandler(async (req, res) => {
  const parsed = powersSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Send the powers as a list, for example { \"powers\": [\"treasury\"] }." });
    return;
  }
  const login = await loginOf(req, res);
  // An unknown key is refused by setPowers (400) and nothing is changed.
  if (login) await answer(res, () => setPowers(login.id, parsed.data.powers));
}));

/** The PIN session only (or gate-disabled): never a principal login, never a granted power. */
const pinOnly = requireOwner("Only the owner PIN can choose which login is Kyle's.");

crmLoginsRouter.post("/crm-logins/:technicianId/principal", gate, pinOnly, asyncHandler(async (req, res) => {
  const parsed = principalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Send { \"principal\": true } or { \"principal\": false }." });
    return;
  }
  const login = await loginOf(req, res);
  if (login) await answer(res, () => (parsed.data.principal ? setPrincipal(login.id) : clearPrincipal(login.id)));
}));
