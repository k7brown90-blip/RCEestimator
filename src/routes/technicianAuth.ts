/**
 * Shared middleware for the technician-facing (PWA) routers.
 *
 * Extracted from health-record.ts once a second tech-facing router needed the
 * same bearer check. Both mount BEFORE pinAuthMiddleware in app.ts — the field
 * app has no PIN session, and putting these behind one would lock every
 * technician out of their own work.
 */

import type express from "express";
import { ZodError } from "zod";
import { prisma } from "../lib/prisma";

export interface TechRequest extends express.Request {
  technician?: { id: string; name: string; role: string; employeeNumber: string | null; licenseHolder: boolean };
}

export const technicianAuth: express.RequestHandler = (req: TechRequest, res, next) => {
  void (async () => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      res.status(401).json({ success: false, error: { code: "unauthorized", message: "Technician token required" } });
      return;
    }
    const technician = await prisma.technician.findUnique({ where: { accessToken: token } });
    if (!technician || !technician.isActive) {
      res.status(401).json({ success: false, error: { code: "unauthorized", message: "Invalid or inactive technician token" } });
      return;
    }
    req.technician = {
      id: technician.id,
      name: technician.name,
      role: technician.role,
      employeeNumber: technician.employeeNumber,
      licenseHolder: technician.licenseHolder,
    };
    next();
  })().catch(next);
};

export const zodErrorHandler: express.ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof ZodError) {
    res.status(422).json({
      success: false,
      error: {
        code: "validation",
        message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      },
    });
    return;
  }
  next(err);
};
