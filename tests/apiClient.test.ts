import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../client/src/lib/api";

describe("api request error parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses parsed JSON error message when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: vi.fn().mockResolvedValue('{"error":"Missing required parameters: run_length"}'),
      }),
    );

    await expect(api.jobs()).rejects.toThrow("Missing required parameters: run_length");
  });

  it("uses plain text for non-JSON error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("Backend unavailable"),
      }),
    );

    await expect(api.jobs()).rejects.toThrow("Backend unavailable");
  });

  it("falls back to status-based message for empty error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue(""),
      }),
    );

    await expect(api.jobs()).rejects.toThrow("Request failed: 503");
  });
});
