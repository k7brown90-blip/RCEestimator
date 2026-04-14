import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET ?? "rce-dev-secret-change-me";
const SESSION_HOURS = 8;

export function pinAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth entirely when PIN_HASH is not configured (dev/test mode)
  if (!process.env.PIN_HASH) {
    next();
    return;
  }

  // Skip non-API requests (static files, SPA routes) so login page loads
  if (!(req as Request & { _isApi?: boolean })._isApi) {
    next();
    return;
  }

  // Skip auth for health, PIN login, MCP, and public Vapi/webhook endpoints
  if (
    req.path === "/health" ||
    req.path === "/auth/pin" ||
    req.path.startsWith("/mcp") ||
    req.path.startsWith("/vapi/") ||
    req.path === "/leads" ||
    req.path === "/customer/lookup" ||
    req.path === "/calendar/availability" ||
    req.path === "/calls/daily-summary"
  ) {
    next();
    return;
  }

  const token =
    req.headers.authorization?.replace("Bearer ", "") ??
    (req.query["token"] as string | undefined);

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

export async function handlePinLogin(req: Request, res: Response): Promise<void> {
  const pinHash = process.env.PIN_HASH;
  if (!pinHash) {
    res.status(500).json({ error: "PIN not configured" });
    return;
  }

  const { pin } = req.body as { pin?: string };
  if (!pin || typeof pin !== "string") {
    res.status(400).json({ error: "PIN required" });
    return;
  }

  const valid = await bcrypt.compare(pin, pinHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid PIN" });
    return;
  }

  const token = jwt.sign({ sub: "owner" }, JWT_SECRET, {
    expiresIn: `${SESSION_HOURS}h`,
  });

  res.json({ token, expiresIn: SESSION_HOURS * 60 * 60 });
}

/** Utility: generate a PIN hash for use in env vars */
export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}
