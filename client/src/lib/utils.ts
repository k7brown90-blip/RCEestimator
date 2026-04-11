import type { EstimateStatus } from "./types";

export const statusLabel: Record<EstimateStatus, string> = {
  draft: "DRAFT",
  review: "IN REVIEW",
  sent: "SENT",
  accepted: "ACCEPTED",
  declined: "DECLINED",
  expired: "EXPIRED",
  revised: "REVISED",
};

export const statusBadgeClass: Record<EstimateStatus, string> = {
  draft: "bg-rce-accentBg text-rce-warning",
  review: "bg-rce-accentBg text-rce-warning",
  sent: "bg-blue-100 text-blue-700",
  accepted: "bg-green-100 text-rce-success",
  declined: "bg-zinc-200 text-zinc-700",
  expired: "bg-zinc-200 text-zinc-700",
  revised: "bg-rce-accentBg text-rce-warning",
};

export const categoryLabels: Record<string, string> = {
  diagnostic: "Diagnostic",
  devices: "Devices / Receptacles",
  lighting_controls: "Lighting / Controls",
  circuits: "Circuits / Feeders",
  panels: "Panels / Breakers",
  service_entrance: "Service Entrance",
  grounding_bonding: "Grounding / Bonding / Surge",
  detached_exterior: "Detached / Exterior",
  appliance_equipment: "Appliance / Equipment",
  shop_garage: "Shop / Garage",
  generator_backup: "Generator / Backup",
  specialty: "Specialty",
  support: "Support",
  package: "Packages",
};

export function money(value: number | null | undefined): string {
  if (typeof value !== "number") {
    return "-";
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

export function shortDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

export function parseJsonArray(value?: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}
