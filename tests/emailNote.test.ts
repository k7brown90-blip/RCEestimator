import { describe, expect, it } from "vitest";
import { htmlToPlainText, noteHtml } from "../src/services/confirmationEmail";

// The office's note keeps its paragraphs (AI admin report 11/18; Kyle, 2026-11-19: "Yes, fix it").
describe("noteHtml", () => {
  it("keeps line breaks and blank lines", () => {
    expect(noteHtml("Hi Sandy,\n\nTwo options below.\nCall us.")).toBe("Hi Sandy,<br><br>Two options below.<br>Call us.");
  });

  it("treats Windows line endings the same", () => {
    expect(noteHtml("One\r\n\r\nTwo")).toBe("One<br><br>Two");
  });

  it("escapes before adding breaks, so typed markup stays text", () => {
    expect(noteHtml("<b>bold</b>\n& more")).toBe("&lt;b&gt;bold&lt;/b&gt;<br>&amp; more");
  });

  it("round-trips to a plain-text twin with the paragraphs intact", () => {
    const html = `<p style="font-size:15px;">${noteHtml("First paragraph.\n\nSecond paragraph.\nRed Cedar Electric LLC")}</p>`;
    expect(htmlToPlainText(html)).toBe("First paragraph.\n\nSecond paragraph.\nRed Cedar Electric LLC");
  });
});
