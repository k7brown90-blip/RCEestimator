/**
 * Tests for the manual-first customer-send gate.
 *
 * The bar these hold is narrow and deliberate: a misread flag must fail CLOSED. The
 * expensive failure here is not "a reminder didn't go out" — Kyle is calling people anyway
 * while the company runs manual-first — it is "a text went to a customer because an env var
 * was spelled wrong."
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MASTER_ENV_VAR,
  TWILIO_MASTER_ENV_VAR,
  customerSendsEnabled,
  logAutomationGateState,
  logCustomerSendSkipped,
  logTwilioSendSkipped,
  twilioLegEnvVar,
  twilioSendEnabled,
  workflowEnvVar,
  type CustomerSendWorkflow,
  type TwilioSendLeg,
} from "../src/services/automationGate";

const WORKFLOWS: CustomerSendWorkflow[] = [
  "visitReminders",
  "bookingConfirmations",
  "webLeadAutoReply",
  "inboundAutoReply",
];

const TWILIO_LEGS: TwilioSendLeg[] = [
  "operatorAlerts",
  "operatorNotifications",
  "technicianSends",
  "inboundAcks",
  "agentSends",
  "customerLifecycleSms",
];

const ALL_VARS = [
  MASTER_ENV_VAR,
  ...WORKFLOWS.map(workflowEnvVar),
  TWILIO_MASTER_ENV_VAR,
  ...TWILIO_LEGS.map(twilioLegEnvVar),
];

function clearAll() {
  for (const v of ALL_VARS) delete process.env[v];
}

afterEach(() => {
  clearAll();
  vi.restoreAllMocks();
});

describe("default-deny", () => {
  it("every customer-send workflow is OFF when nothing is configured", () => {
    clearAll();
    for (const w of WORKFLOWS) {
      expect(customerSendsEnabled(w), `${w} must default to disabled`).toBe(false);
    }
  });

  it("stays OFF for empty, misspelled, or nonsense flag values", () => {
    clearAll();
    for (const bad of ["", " ", "off", "no", "false", "0", "ON!", "enable", "yess", "truthy"]) {
      process.env[MASTER_ENV_VAR] = bad;
      expect(customerSendsEnabled("visitReminders"), `master=${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("master switch", () => {
  it("turns every workflow on", () => {
    clearAll();
    process.env[MASTER_ENV_VAR] = "on";
    for (const w of WORKFLOWS) expect(customerSendsEnabled(w)).toBe(true);
  });

  it("accepts the documented affirmative spellings, case-insensitively", () => {
    for (const good of ["on", "ON", "true", "True", "1", "yes", "enabled", "  on  "]) {
      clearAll();
      process.env[MASTER_ENV_VAR] = good;
      expect(customerSendsEnabled("visitReminders"), `master=${JSON.stringify(good)}`).toBe(true);
    }
  });
});

describe("per-workflow override", () => {
  it("enables exactly one workflow and leaves the rest off", () => {
    clearAll();
    process.env[workflowEnvVar("visitReminders")] = "on";
    expect(customerSendsEnabled("visitReminders")).toBe(true);
    for (const w of WORKFLOWS.filter((x) => x !== "visitReminders")) {
      expect(customerSendsEnabled(w), `${w} must remain disabled`).toBe(false);
    }
  });

  it("each workflow has its own distinct env var", () => {
    const vars = WORKFLOWS.map(workflowEnvVar);
    expect(new Set(vars).size).toBe(WORKFLOWS.length);
    for (const v of vars) expect(v.startsWith(MASTER_ENV_VAR)).toBe(true);
  });
});

describe("logging proves the gate fired", () => {
  it("logCustomerSendSkipped names the workflow and how to re-enable it", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logCustomerSendSkipped("visitReminders", "Sweep did not run.");
    const line = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain("SKIPPED visitReminders");
    expect(line).toContain("DISABLED");
    expect(line).toContain(workflowEnvVar("visitReminders"));
    expect(line).toContain("Sweep did not run.");
  });

  it("boot report states the state of every workflow", () => {
    clearAll();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logAutomationGateState();
    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain(`MASTER ${MASTER_ENV_VAR}=(unset)`);
    expect(out).toContain("DISABLED (default)");
    for (const w of WORKFLOWS) expect(out).toContain(w);
    // the non-gated paths must be named too, so the log is a complete picture
    expect(out).toContain("NOT gated");
    expect(out).toContain("supplier order emails");
    // and the boot report covers BOTH classes in one place
    expect(out).toContain(`MASTER ${TWILIO_MASTER_ENV_VAR}=(unset)`);
    for (const leg of TWILIO_LEGS) expect(out).toContain(leg);
  });

  it("boot report reflects a per-workflow override", () => {
    clearAll();
    process.env[workflowEnvVar("bookingConfirmations")] = "on";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logAutomationGateState();
    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("ENABLED  bookingConfirmations");
    expect(out).toContain("DISABLED visitReminders");
  });
});

/* ── CLASS 2 — the Twilio gate (P013, ruling 2026-08-13) ─────────────────────────────────
 *
 * Same bar as class 1, one notch stricter: the expensive failure is not "Kyle missed a
 * heads-up" — the CRM holds every one of those, and he reads email — it is "a Twilio text
 * went out after he said, in as many words, that he is not using Twilio for texts."
 */

describe("Twilio gate — default-deny", () => {
  it("every leg is OFF when nothing is configured", () => {
    clearAll();
    for (const leg of TWILIO_LEGS) {
      expect(twilioSendEnabled(leg), `${leg} must default to disabled`).toBe(false);
    }
  });

  it("stays OFF for empty, misspelled, or nonsense flag values — on the master and on a leg", () => {
    for (const bad of ["", " ", "off", "no", "false", "0", "ON!", "enable", "yess", "truthy", "disabled"]) {
      clearAll();
      process.env[TWILIO_MASTER_ENV_VAR] = bad;
      expect(twilioSendEnabled("operatorAlerts"), `master=${JSON.stringify(bad)}`).toBe(false);

      clearAll();
      process.env[twilioLegEnvVar("operatorAlerts")] = bad;
      expect(twilioSendEnabled("operatorAlerts"), `leg=${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("accepts the documented affirmative spellings, case-insensitively", () => {
    for (const good of ["on", "ON", "true", "True", "1", "yes", "enabled", "  on  "]) {
      clearAll();
      process.env[TWILIO_MASTER_ENV_VAR] = good;
      expect(twilioSendEnabled("operatorAlerts"), `master=${JSON.stringify(good)}`).toBe(true);
    }
  });
});

describe("Twilio gate — per-leg isolation", () => {
  it("enabling one leg leaves every other leg off", () => {
    for (const target of TWILIO_LEGS) {
      clearAll();
      process.env[twilioLegEnvVar(target)] = "on";
      expect(twilioSendEnabled(target), `${target} should be on`).toBe(true);
      for (const other of TWILIO_LEGS.filter((l) => l !== target)) {
        expect(twilioSendEnabled(other), `${other} must stay off while ${target} is on`).toBe(false);
      }
    }
  });

  it("each leg has its own distinct env var under the master's prefix", () => {
    const vars = TWILIO_LEGS.map(twilioLegEnvVar);
    expect(new Set(vars).size).toBe(TWILIO_LEGS.length);
    for (const v of vars) expect(v.startsWith(TWILIO_MASTER_ENV_VAR)).toBe(true);
  });

  it("the master turns on every leg", () => {
    clearAll();
    process.env[TWILIO_MASTER_ENV_VAR] = "on";
    for (const leg of TWILIO_LEGS) expect(twilioSendEnabled(leg)).toBe(true);
  });
});

describe("the two classes are independent", () => {
  it("re-enabling customer automation does NOT re-enable Twilio texts", () => {
    clearAll();
    process.env[MASTER_ENV_VAR] = "on";
    for (const w of WORKFLOWS) expect(customerSendsEnabled(w)).toBe(true);
    for (const leg of TWILIO_LEGS) {
      expect(twilioSendEnabled(leg), `${leg} must not ride in on the class-1 master`).toBe(false);
    }
  });

  it("re-enabling Twilio does NOT re-enable the gated customer automations", () => {
    clearAll();
    process.env[TWILIO_MASTER_ENV_VAR] = "on";
    for (const leg of TWILIO_LEGS) expect(twilioSendEnabled(leg)).toBe(true);
    for (const w of WORKFLOWS) {
      expect(customerSendsEnabled(w), `${w} must not ride in on the class-2 master`).toBe(false);
    }
  });
});

describe("Twilio gate — logging proves the gate fired", () => {
  it("logTwilioSendSkipped names the leg, the ruling, and how to re-enable it", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logTwilioSendSkipped("operatorAlerts", "Recorded as a SystemEvent instead.");
    const line = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain("SKIPPED operatorAlerts");
    expect(line).toContain("DISABLED");
    expect(line).toContain("2026-08-13");
    expect(line).toContain(twilioLegEnvVar("operatorAlerts"));
    expect(line).toContain(TWILIO_MASTER_ENV_VAR);
    expect(line).toContain("Recorded as a SystemEvent instead.");
  });

  it("boot report states DISABLED for every leg and names what still reaches Kyle", () => {
    clearAll();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logAutomationGateState();
    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    for (const leg of TWILIO_LEGS) expect(out).toContain(`DISABLED ${leg}`);
    expect(out).toContain("INBOUND Twilio");
    expect(out).toContain("email notifications");
  });

  it("boot report reflects a per-leg override", () => {
    clearAll();
    process.env[twilioLegEnvVar("operatorAlerts")] = "on";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logAutomationGateState();
    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("ENABLED  operatorAlerts");
    expect(out).toContain("DISABLED technicianSends");
  });
});
