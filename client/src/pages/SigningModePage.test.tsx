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
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import { SigningModePage } from "./SigningModePage";
import { api } from "../lib/api";
import { CONSENT_TEXT } from "../../../shared/consentText";

// jsdom has no canvas; the drawing pad is not what this file is about. The stand-in is one button
// that "draws" a mark, so a test can get as far as pressing Accept & Sign.
vi.mock("../components/SignaturePad", () => ({
  SignaturePad: (props: { onChange: (dataUrl: string | null) => void }) => (
    <button type="button" onClick={() => props.onChange("data:image/png;base64,AAAA")}>draw a mark</button>
  ),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SigningModePage - the consent text", () => {
  it("is the full CONSENT_TEXT, word for word, next to the agree box", async () => {
    vi.spyOn(api, "pbCustomerView").mockResolvedValue({ html: "<p>estimate</p>", figuresKey: null });
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

describe("SigningModePage - the option chosen on Present", () => {
  it("is asked for when the customer's page is loaded (a one-or-the-other page paints that one option)", async () => {
    // Kyle, 2026-11-18, "Price range": the sandboxed iframe runs no script, so the server paint
    // is all the customer sees - the choice made on Present has to reach it.
    const view = vi.spyOn(api, "pbCustomerView").mockResolvedValue({ html: "<p>estimate</p>", figuresKey: null });
    renderWithProviders(
      <Routes><Route path="/sign-in-person/:estimateId" element={<SigningModePage />} /></Routes>,
      { route: { pathname: "/sign-in-person/est-1", state: { selectedOptions: ["B"] } } },
    );
    await screen.findByTestId("consent-text");
    expect(view).toHaveBeenCalledWith("est-1", ["B"]);
  });
});

describe("SigningModePage - the signature says which document the customer was shown", () => {
  // One estimate, one link (Kyle, 2026-11-27): an estimate nobody outside the office has seen is
  // now saved IN PLACE, same revision. The office saving it from another tab while the customer
  // reads this screen must not put their signature on the changed version, so the page sends back
  // the server's fingerprint of what it rendered and the server refuses a mismatch.
  const fillAndSign = async () => {
    fireEvent.change(await screen.findByPlaceholderText("Your full name"), { target: { value: "Test Signer" } });
    fireEvent.click(screen.getByRole("button", { name: "draw a mark" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Accept & Sign" }));
  };
  const open = () =>
    renderWithProviders(
      <Routes><Route path="/sign-in-person/:estimateId" element={<SigningModePage />} /></Routes>,
      { route: "/sign-in-person/est-1" },
    );

  it("sends the key that came with the page it loaded", async () => {
    vi.spyOn(api, "pbCustomerView").mockResolvedValue({ html: "<p>estimate</p>", figuresKey: "key-of-what-was-shown" });
    const sign = vi.spyOn(api, "pbSignInPerson").mockResolvedValue({ signed: true, estimateId: "est-1", jobVisitId: null });
    vi.spyOn(api, "estimatePaymentInfo").mockRejectedValue(new Error("not part of this test"));
    open();
    await fillAndSign();
    await waitFor(() => expect(sign).toHaveBeenCalledWith("est-1", "Test Signer", "data:image/png;base64,AAAA", undefined, "key-of-what-was-shown"));
  });

  it("when the office refuses the signature, says why and reloads the estimate so the customer reads the current one", async () => {
    const view = vi.spyOn(api, "pbCustomerView")
      .mockResolvedValueOnce({ html: "<p>the estimate as first shown</p>", figuresKey: "old-key" })
      .mockResolvedValue({ html: "<p>the estimate as it is now</p>", figuresKey: "new-key" });
    const refusal = "The figures the customer signed are not the figures estimate 2026-0001 shows now.";
    const sign = vi.spyOn(api, "pbSignInPerson").mockRejectedValueOnce(new Error(refusal)).mockResolvedValue({ signed: true, estimateId: "est-1", jobVisitId: null });
    vi.spyOn(api, "estimatePaymentInfo").mockRejectedValue(new Error("not part of this test"));
    open();
    await fillAndSign();

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    await waitFor(() => expect(view).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTitle("Your estimate").getAttribute("srcdoc")).toContain("the estimate as it is now"));
    // Still on the signing step, nothing recorded - and the next press carries the reloaded key.
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept & Sign" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Accept & Sign" }));
    await waitFor(() => expect(sign).toHaveBeenLastCalledWith("est-1", "Test Signer", "data:image/png;base64,AAAA", undefined, "new-key"));
  });
});
