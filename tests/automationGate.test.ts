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
  customerSendsEnabled,
  logAutomationGateState,
  logCustomerSendSkipped,
  workflowEnvVar,
  type CustomerSendWorkflow,
} from "../src/services/automationGate";

const WORKFLOWS: CustomerSendWorkflow[] = [
  "visitReminders",
  "bookingConfirmations",
  "webLeadAutoReply",
  "inboundAutoReply",
];

const ALL_VARS = [MASTER_ENV_VAR, ...WORKFLOWS.map(workflowEnvVar)];

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
    expect(out).toContain("technician notifications");
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
