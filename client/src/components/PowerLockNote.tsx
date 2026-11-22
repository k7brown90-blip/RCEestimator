/**
 * The visible reason beside a control that is greyed because this session lacks a Kyle-only power
 * (work order agent-team, HA5). A greyed control with no explanation teaches the user the feature
 * does not exist, so the sentence from shared/crmPowers.ts is always printed on the screen, not just
 * in a tooltip. Renders nothing when the session may use the power.
 */
import { useCan } from "../lib/session";
import type { CrmPower } from "../../../shared/crmPowers";

export function PowerLockNote({ power, className = "" }: { power: CrmPower; className?: string }) {
  const { allowed, reason } = useCan(power);
  if (allowed || !reason) return null;
  return (
    <p
      className={`rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 ${className}`}
      data-testid={`power-lock-${power}`}
    >
      {reason}
    </p>
  );
}
