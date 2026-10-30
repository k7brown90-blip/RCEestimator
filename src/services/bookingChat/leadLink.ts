/**
 * Links the website-chat emails to Kyle carry. The CRM's drawers are addressed by the URL
 * (client/src/lib/drawers.ts): `?lead=<id>` on any route opens that lead's drawer, `?job=<id>` the
 * job's — so these land on the record, not on a list to hunt through.
 */

import { publicBaseUrl } from "../issuedEstimateSend";

export function leadLink(leadId: string): string {
  return `${publicBaseUrl()}/leads?lead=${encodeURIComponent(leadId)}`;
}

export function jobLink(visitId: string): string {
  return `${publicBaseUrl()}/jobs?job=${encodeURIComponent(visitId)}`;
}
