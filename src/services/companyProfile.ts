/**
 * The company's own details, in one place.
 *
 * Two of these lived as literals in two files and had drifted: the PDF footer
 * printed one phone number and the email that delivered the PDF printed another.
 * On a contract that's embarrassing; on a code-cited cure certificate, where the
 * whole point is that Red Cedar's details are verifiable, it's worse.
 *
 * Backed by CompanySetting.companyProfile, which the Settings UI owns. The
 * constants below are the fallback for a fresh database, never a second source
 * of truth — anything that ships to a customer should read through here.
 */

import { prisma } from "../lib/prisma";
import { parseJsonObject } from "../lib/json";

export interface CompanyProfile {
  legalName: string;
  phone: string;
  email: string;
  tagline: string;
  /** TN contractor licence number — printed on every attestation. */
  licenseNumber: string | null;
  licenseState: string;
}

export const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  legalName: "Red Cedar Electric LLC",
  phone: "(615) 857-6389",
  email: "service@redcedarelectricllc.com",
  tagline: "Licensed & Insured · Serving Middle Tennessee",
  licenseNumber: null,
  licenseState: "TN",
};

const str = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;

/**
 * Tolerant by design — a malformed settings row must not stop a document being
 * produced. It falls back to the defaults, which are correct if stale.
 */
export async function getCompanyProfile(): Promise<CompanyProfile> {
  const row = await prisma.companySetting.findUnique({ where: { key: "companyProfile" } }).catch(() => null);
  const raw = parseJsonObject<Record<string, unknown>>(row?.valueJson);
  if (!raw) return DEFAULT_COMPANY_PROFILE;

  const licenseNumber = str(raw.licenseNumber ?? raw.license, "");
  return {
    legalName: str(raw.legalName ?? raw.name, DEFAULT_COMPANY_PROFILE.legalName),
    phone: str(raw.phone, DEFAULT_COMPANY_PROFILE.phone),
    email: str(raw.email, DEFAULT_COMPANY_PROFILE.email),
    tagline: str(raw.tagline, DEFAULT_COMPANY_PROFILE.tagline),
    licenseNumber: licenseNumber.length > 0 ? licenseNumber : null,
    licenseState: str(raw.licenseState, DEFAULT_COMPANY_PROFILE.licenseState),
  };
}

/**
 * How the licence reads on an attestation.
 *
 * When no number is on file this says so out loud. A certificate that silently
 * omits the licence looks like one issued by someone who doesn't hold one, and
 * the person signing it should notice before the customer does.
 */
export function licenseLine(profile: CompanyProfile): string {
  return profile.licenseNumber
    ? `${profile.licenseState} contractor licence ${profile.licenseNumber}`
    : "Licence number not on file — set it in CRM Settings before issuing this document";
}
