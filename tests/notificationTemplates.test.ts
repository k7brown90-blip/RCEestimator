/**
 * Locked SMS templates in services/notifications.ts (job scheduled, reschedule blocked).
 */
import { describe, expect, it } from "vitest";

describe("Notification templates", () => {
  it("generates correct customer work scheduled SMS", async () => {
    const { customerWorkScheduled } = await import("../src/services/notifications");
    const msg = customerWorkScheduled({
      customerName: "Jane Smith",
      phone: "+16155551234",
      address: "123 Oak St, La Vergne",
      jobType: "Panel Upgrade",
      scheduledStart: new Date("2026-05-05T12:00:00Z"),
      scheduledEnd: new Date("2026-05-06T22:00:00Z"),
      durationDays: 2,
      startTime: "7:00 AM",
    });

    expect(msg).toContain("Hi Jane");
    expect(msg).toContain("Panel Upgrade");
    expect(msg).toContain("7:00 AM");
    expect(msg).toContain("2 day(s)");
    // U9: the words only. The company name is the header and "Reply STOP to opt out." is the footer, both added by
    // the one composer inside sendSms, so a template that wrote either would be refused as a double.
    expect(msg).not.toMatch(/reply\s+stop/i);
    expect(msg).not.toMatch(/red\s+cedar/i);
  });

  it("generates correct Kyle work scheduled SMS", async () => {
    const { kyleWorkScheduled } = await import("../src/services/notifications");
    const msg = kyleWorkScheduled({
      customerName: "Jane Smith",
      phone: "+16155551234",
      address: "123 Oak St, La Vergne",
      jobType: "Panel Upgrade",
      scheduledStart: new Date("2026-05-05T12:00:00Z"),
      scheduledEnd: new Date("2026-05-06T22:00:00Z"),
      durationDays: 2,
      startTime: "7:00 AM",
    });

    expect(msg).toContain("JOB SCHEDULED");
    expect(msg).toContain("Jane Smith");
    expect(msg).toContain("Panel Upgrade");
    expect(msg).toContain("2 day(s)");
  });

  it("generates correct reschedule conflict SMS for Kyle", async () => {
    const { kyleRescheduleConflict } = await import("../src/services/notifications");
    const msg = kyleRescheduleConflict(
      {
        customerName: "Jane Smith",
        phone: "+16155551234",
        address: "123 Oak St",
        jobType: "Panel Upgrade",
        scheduledStart: new Date("2026-05-05T12:00:00Z"),
        scheduledEnd: new Date("2026-05-06T22:00:00Z"),
        durationDays: 2,
        startTime: "7:00 AM",
      },
      new Date("2026-05-12T12:00:00Z"),
      "Existing event blocks 8am-12pm",
    );

    expect(msg).toContain("RESCHEDULE ATTEMPTED");
    expect(msg).toContain("BLOCKED");
  });
});
