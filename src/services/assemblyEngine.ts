/**
 * Assembly engine stubs — the assembly system has been removed.
 * These stubs exist only to prevent compilation errors in EstimateService
 * methods that have not yet been cleaned up. All assembly routes have been
 * removed from app.ts, so these functions are never called at runtime.
 *
 * TODO: Remove these stubs when assembly methods are removed from EstimateService
 * and assembly models are dropped from the Prisma schema.
 */

import type { PrismaClient } from "@prisma/client";

export interface ExpandedComponent {
  componentType: string;
  code: string;
  description: string;
  quantity: number;
  unit: string | null;
  unitCost: number;
  laborHours: number;
  laborRate: number;
  extendedCost: number;
}

export function serializeParams(_params: Record<string, unknown>): string {
  return "{}";
}

export function deserializeParams(_json: string | null): Record<string, unknown> {
  return {};
}

export async function expandTemplate(
  _prisma: PrismaClient,
  _templateId: string,
  _params: Record<string, unknown>,
  _quantity: number,
): Promise<ExpandedComponent[]> {
  return [];
}

export function summarizeComponents(_expanded: ExpandedComponent[]): { labor: number; material: number; other: number } {
  return { labor: 0, material: 0, other: 0 };
}
