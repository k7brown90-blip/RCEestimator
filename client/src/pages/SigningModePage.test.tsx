/**
 * The CRM's in-person signing screen shows the customer the SAME sentence the server records.
 *
 * Carry item from Phase 3 (one-estimating-system plan, 2026-10-08): the agree box carried a
 * shortened paraphrase ("I agree to the scope and the price on this estimate ...") while the
 * server stores the full CONSENT_TEXT beside the signature ("By typing my full name and tapping
 * Accept & Sign, I agree ..." - reworded 2026-10-09, Kyle ruling 4). What the customer reads has to be what is recorded, so the screen
 * now prints the shared constant itself - the same file the server and the field app import.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import { SigningModePage } from "./SigningModePage";
import { api } from "../lib/api";
import { CONSENT_TEXT } from "../../../shared/consentText";

// jsdom has no canvas; the drawing pad is not what this file is about.
vi.mock("../components/SignaturePad", () => ({ SignaturePad: () => null }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SigningModePage - the consent text", () => {
  it("is the full CONSENT_TEXT, word for word, next to the agree box", async () => {
    vi.spyOn(api, "pbCustomerView").mockResolvedValue("<p>estimate</p>");
    renderWithProviders(
      <Routes><Route path="/sign-in-person/:estimateId" element={<SigningModePage />} /></Routes>,
      { route: "/sign-in-person/est-1" },
    );
    const text = await screen.findByTestId("consent-text");
    expect(text.textContent).toBe(CONSENT_TEXT);
    // Spelled out (ruling 4, Kyle 2026-10-09), so a drift in the shared constant is caught here too.
    expect(text.textContent).toBe(
      "By typing my full name and tapping Accept & Sign, I agree to the scope and the price on this estimate, and I authorize Red Cedar Electric LLC to perform the work described. I understand this is an electronic signature with the same effect as a written one.",
    );
    expect(text.textContent).toContain("with the same effect as a written one");
    // The Accept button still says what the sentence says it does.
    expect(screen.getByRole("button", { name: "Accept & Sign" })).toBeInTheDocument();
  });
});
