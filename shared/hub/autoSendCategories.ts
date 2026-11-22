/**
 * The categories Kyle's "AI auto-send rules" card can switch on (work order agent-team, BA8). This is
 * NOT a second list: it is a filtered VIEW of the one send-type registry (shared/hub/messageCategories.ts,
 * ruling L) - every entry there marked autoSendEligible - so the card, the server's evaluation and the
 * registry cannot drift. A category that is not eligible there can never be turned on here.
 *
 * The saved state is the owner setting `hubAutoSend` (services/ownerSettings.ts): which of these keys
 * are ON. A missing key means every category OFF, so there is no seed row.
 */
import { MESSAGE_CATEGORY_LIST, type MessageCategory } from "./messageCategories";

export interface AutoSendCategory {
  key: string;
  label: string;
  lengthCap: number;
  allowsPrices: boolean;
  customerFacing: boolean;
}

const viewOf = (c: MessageCategory): AutoSendCategory => ({
  key: c.key, label: c.label, lengthCap: c.lengthCap, allowsPrices: c.allowsPrices, customerFacing: c.customerFacing,
});

/** Every category that may be switched on, in registry order. */
export const AUTO_SEND_CATEGORIES: readonly AutoSendCategory[] = MESSAGE_CATEGORY_LIST.filter((c) => c.autoSendEligible).map(viewOf);

export function autoSendCategoryFor(key: string | null | undefined): AutoSendCategory | null {
  return AUTO_SEND_CATEGORIES.find((c) => c.key === key) ?? null;
}

export function isAutoSendCategory(key: string): boolean {
  return autoSendCategoryFor(key) !== null;
}

/** The saved value of the `hubAutoSend` owner setting. */
export interface HubAutoSendValue {
  /** category key -> true when Kyle turned it ON. A key that is absent or false is OFF. */
  categories: Record<string, boolean>;
  changedAt: string | null;
  changedBy: string | null;
}

export const DEFAULT_HUB_AUTO_SEND: HubAutoSendValue = { categories: {}, changedAt: null, changedBy: null };

/** What GET /owner-settings/hubAutoSend adds to the value: whether the server-side gate lets anything go. */
export interface HubAutoSendStatus {
  gateOn: boolean;
  gateEnv: string;
}
