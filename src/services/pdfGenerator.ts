/**
 * PDF generation service — contracts, change orders, work orders, material lists.
 * Uses pdfkit (already a dependency). Stores files locally in generated/ directory.
 */

import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../lib/prisma";
import { parseJsonArray, parseJsonStringArray } from "../lib/json";
import { v4 as uuidv4 } from "uuid";
import {
  DEFAULT_COMPANY_PROFILE,
  getCompanyProfile,
  licenseLine,
  type CompanyProfile,
} from "./companyProfile";
import { findingCitations } from "./findingLedger";
import {
  groundingMethodLanguage,
  energizedTerminationLanguage,
  TORQUE_METHOD_LIMIT,
  voltageDropLanguage,
  methodConditionsLanguage,
  samplingDisclosure,
  BUS_CORROSION_HONEST_LIMIT,
  reportDisclaimer,
} from "./reportLanguage";

const GENERATED_DIR = path.join(process.cwd(), "generated", "documents");
const LOGO_PATH = path.join(process.cwd(), "public", "logo.png");

// Brand colors from website
const BRAND = {
  cedar: "#1e2d12",
  copper: "#c49818",
  gold: "#dab830",
  cream: "#fffbee",
  mahogany: "#3d1408",
  text: "#1a1a0e",
  muted: "#5a5838",
  divider: "#c49818",
  footerText: "#8a8668",
};

function ensureDir() {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

interface ContractInput {
  jobId: string;
  customerName: string;
  serviceAddress: string;
  scopeOfWork: string;
  totalPrice: number;
  estimatedHours?: number;
  paymentTerms?: string;
}

interface ChangeOrderInput {
  jobId: string;
  customerName: string;
  serviceAddress: string;
  originalScope: string;
  changes: string;
  priceAdjustment: number;
  newTotal: number;
}

interface WorkOrderInput {
  jobId: string;
  customerName: string;
  serviceAddress: string;
  scheduledDate: string;
  scopeOfWork: string;
  materialsNeeded: string;
}

interface MaterialListInput {
  jobId: string;
  serviceAddress: string;
  items: Array<{ name: string; quantity: number; unit?: string; supplier?: string }>;
}

/**
 * @param profile the company's details. Passed in rather than read here so
 * `addHeader` stays synchronous — every caller already awaits something.
 * Omitting it falls back to the defaults, which keeps the older generators
 * working unchanged.
 */
function addHeader(doc: PDFKit.PDFDocument, title: string, profile: CompanyProfile = DEFAULT_COMPANY_PROFILE) {
  const pageWidth = doc.page.width;
  const margin = 36;

  // Logo — centered at top
  if (fs.existsSync(LOGO_PATH)) {
    const logoSize = 72;
    doc.image(LOGO_PATH, (pageWidth - logoSize) / 2, margin, { width: logoSize, height: logoSize });
    doc.y = margin + logoSize + 8;
  }

  doc.fillColor(BRAND.cedar).fontSize(18).text(profile.legalName, { align: "center" });
  doc.fillColor(BRAND.muted).fontSize(9).text(profile.tagline, { align: "center" });
  doc.text(`${profile.phone} · ${profile.email}`, { align: "center" });
  doc.moveDown(0.5);

  // Gold divider line
  const y = doc.y;
  doc.moveTo(margin, y).lineTo(pageWidth - margin, y).lineWidth(1.5).stroke(BRAND.copper);
  doc.moveDown(0.5);

  doc.fillColor(BRAND.cedar).fontSize(14).text(title, { underline: true });
  doc.moveDown(0.5);
  doc.fillColor(BRAND.text);
}

function addFooter(doc: PDFKit.PDFDocument) {
  doc.moveDown(1);
  // Thin divider
  const y = doc.y;
  doc.moveTo(36, y).lineTo(doc.page.width - 36, y).lineWidth(0.5).stroke(BRAND.copper);
  doc.moveDown(0.3);
  doc.fillColor(BRAND.footerText).fontSize(8).text(
    `Generated ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} CT — Red Cedar Electric LLC`,
    { align: "center" },
  );
  doc.fillColor(BRAND.text);
}

/**
 * Scope and limitations, on every delivered Record.
 *
 * A code-cited defect report with no limitations block reads as a clean bill of
 * health for everything it doesn't mention. Duplicated from
 * field/src/data/reportLimitations.ts rather than imported: the PWA renders its
 * own preview from a bundle that may be weeks old, and this is the copy that
 * ships to the customer. If one changes, change both.
 *
 * // VERIFY: reviewed by counsel before the first customer-facing delivery.
 */
const REPORT_LIMITATIONS: { heading: string; body: string[] }[] = [
  {
    heading: "What this record is",
    body: [
      "An Electrical Health Record is a documented condition assessment of the electrical system at this address, on the date stated, performed by a licensed electrician. It records what was observed and measured, cites the code provision each finding is assessed against, and states what it would take to correct anything found.",
      "It is not a municipal inspection and does not substitute for one. A permit inspection is performed by the authority having jurisdiction and results in an approval; this record results in information.",
    ],
  },
  {
    heading: "What was not assessed",
    body: [
      "Only the items listed in this record were assessed. Anything not listed was not examined, and no statement is made about it either way.",
      "The assessment is non-destructive. Conditions concealed behind finished walls, ceilings and floors, inside sealed equipment, underground, or otherwise inaccessible on the day were not evaluated.",
      "Equipment on the utility's side of the meter is the utility's. Where something there warranted attention this record says so and refers it to them; we do not open sealed equipment.",
    ],
  },
  {
    heading: "What it means about the future",
    body: [
      "This record describes the system as it was on the date of the assessment. Electrical systems change with use, alteration, weather and age. It is not a warranty, a guarantee against future failure, or a prediction of remaining service life beyond the manufacturer figures cited.",
      "An item recorded as meeting requirements met the cited requirement at the time it was observed. It is not certified for any period afterward.",
    ],
  },
  {
    heading: "Codes and jurisdiction",
    body: [
      "Findings are assessed against the code edition adopted in this jurisdiction as of the assessment date, stated above. The National Electrical Code is not retroactive: work that was compliant when installed is not a violation because a later edition changed the requirement. Where that distinction applies, this record says so.",
      "Items recorded as below Red Cedar's enhanced standard are not violations of anything. They are installations that meet code and that we would nonetheless do differently.",
    ],
  },
  {
    heading: "Limitation of liability",
    body: [
      "Red Cedar Electric's liability arising from this record is limited to the fee paid for it. This record is provided to the party who commissioned it, for their use.",
      "Every version of this record is retained permanently and can be reproduced on request, including by a future owner of this property.",
    ],
  },
];

function addLimitations(doc: PDFKit.PDFDocument) {
  doc.moveDown(0.8);
  doc.fillColor(BRAND.cedar).fontSize(11).text("Scope & limitations");
  doc.moveDown(0.2);
  for (const section of REPORT_LIMITATIONS) {
    doc.fillColor(BRAND.text).fontSize(9).text(section.heading);
    doc.fillColor(BRAND.muted).fontSize(8);
    for (const paragraph of section.body) {
      doc.text(paragraph, { align: "left" });
    }
    doc.moveDown(0.35);
  }
  doc.fillColor(BRAND.text);
}

async function savePdf(doc: PDFKit.PDFDocument, filename: string): Promise<string> {
  ensureDir();
  const filePath = path.join(GENERATED_DIR, filename);

  return new Promise<string>((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    doc.end();
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

export async function generateContract(input: ContractInput): Promise<{ documentId: string; pdfPath: string }> {  const docId = uuidv4();
  const doc = new PDFDocument({ margin: 36 });

  addHeader(doc, "Service Contract");

  doc.fontSize(11).fillColor(BRAND.text);
  doc.text(`Date: ${new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago" })}`);
  doc.text(`Customer: ${input.customerName}`);
  doc.text(`Service Address: ${input.serviceAddress}`);
  doc.moveDown();

  doc.fillColor(BRAND.cedar).fontSize(12).text("Scope of Work", { underline: true });
  doc.fillColor(BRAND.text).fontSize(10).text(input.scopeOfWork);
  doc.moveDown();

  doc.fillColor(BRAND.cedar).fontSize(12).text("Pricing", { underline: true });
  doc.fillColor(BRAND.text).fontSize(10).text(`Total Price: $${input.totalPrice.toFixed(2)}`);
  if (input.estimatedHours) doc.text(`Estimated Duration: ${input.estimatedHours} hours`);
  doc.text(`Payment Terms: ${input.paymentTerms ?? "Due upon completion"}`);
  doc.moveDown();

  doc.fillColor(BRAND.cedar).fontSize(12).text("Terms & Conditions", { underline: true });
  doc.fillColor(BRAND.text).fontSize(9);
  doc.text("1. All work performed in accordance with NEC 2017 and local AHJ requirements.");
  doc.text("2. Warranty: 12 months parts and labor from date of completion.");
  doc.text("3. Customer provides access to electrical panel and all work areas.");
  doc.text("4. Additional work beyond stated scope requires a signed change order.");
  doc.text("5. Red Cedar Electric LLC is not responsible for pre-existing conditions not specified in this contract.");
  doc.moveDown(2);

  doc.fillColor(BRAND.text).fontSize(11).text("Customer Signature: ____________________________     Date: __________");
  doc.moveDown(0.5);
  doc.text("Contractor Signature: ____________________________     Date: __________");

  addFooter(doc);

  const pdfPath = await savePdf(doc, `contract-${docId}.pdf`);

  await prisma.document.create({
    data: {
      id: docId,
      jobId: input.jobId,
      type: "contract",
      pdfUrl: pdfPath,
    },
  });

  return { documentId: docId, pdfPath };
}

export async function generateChangeOrder(input: ChangeOrderInput): Promise<{ documentId: string; pdfPath: string }> {
  const docId = uuidv4();
  const doc = new PDFDocument({ margin: 36 });

  addHeader(doc, "Change Order");

  doc.fontSize(11).fillColor(BRAND.text);
  doc.text(`Date: ${new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago" })}`);
  doc.text(`Customer: ${input.customerName}`);
  doc.text(`Service Address: ${input.serviceAddress}`);
  doc.moveDown();

  doc.fillColor(BRAND.cedar).fontSize(12).text("Original Scope", { underline: true });
  doc.fillColor(BRAND.text).fontSize(10).text(input.originalScope);
  doc.moveDown();

  doc.fillColor(BRAND.cedar).fontSize(12).text("Changes Requested", { underline: true });
  doc.fillColor(BRAND.text).fontSize(10).text(input.changes);
  doc.moveDown();

  doc.fillColor(BRAND.cedar).fontSize(12).text("Price Adjustment", { underline: true });
  doc.fillColor(BRAND.text).fontSize(10);
  const sign = input.priceAdjustment >= 0 ? "+" : "";
  doc.text(`Adjustment: ${sign}$${input.priceAdjustment.toFixed(2)}`);
  doc.text(`New Total: $${input.newTotal.toFixed(2)}`);
  doc.moveDown(2);

  doc.fontSize(11).text("Customer Signature: ____________________________     Date: __________");

  addFooter(doc);

  const pdfPath = await savePdf(doc, `change-order-${docId}.pdf`);

  await prisma.document.create({
    data: {
      id: docId,
      jobId: input.jobId,
      type: "change_order",
      pdfUrl: pdfPath,
    },
  });

  return { documentId: docId, pdfPath };
}

export async function generateWorkOrder(input: WorkOrderInput): Promise<{ documentId: string; pdfPath: string }> {
  const docId = uuidv4();
  const doc = new PDFDocument({ margin: 36 });

  addHeader(doc, "Work Order");

  doc.fontSize(11).fillColor(BRAND.text);
  doc.text(`Scheduled Date: ${input.scheduledDate}`);
  doc.text(`Customer: ${input.customerName}`);
  doc.text(`Service Address: ${input.serviceAddress}`);
  doc.moveDown();

  doc.fillColor(BRAND.cedar).fontSize(12).text("Scope of Work", { underline: true });
  doc.fillColor(BRAND.text).fontSize(10).text(input.scopeOfWork);
  doc.moveDown();

  doc.fillColor(BRAND.cedar).fontSize(12).text("Materials Needed", { underline: true });
  doc.fillColor(BRAND.text).fontSize(10).text(input.materialsNeeded);
  doc.moveDown();

  doc.fillColor(BRAND.cedar).fontSize(12).text("Field Notes", { underline: true });
  doc.fillColor(BRAND.text).fontSize(10).text("_______________________________________________");
  doc.text("_______________________________________________");
  doc.text("_______________________________________________");

  addFooter(doc);

  const pdfPath = await savePdf(doc, `work-order-${docId}.pdf`);

  await prisma.document.create({
    data: {
      id: docId,
      jobId: input.jobId,
      type: "work_order",
      pdfUrl: pdfPath,
    },
  });

  return { documentId: docId, pdfPath };
}

export async function generateMaterialList(input: MaterialListInput): Promise<{ documentId: string; pdfPath: string }> {
  const docId = uuidv4();
  const doc = new PDFDocument({ margin: 36 });

  addHeader(doc, "Material List");

  doc.fontSize(11).fillColor(BRAND.text);
  doc.text(`Service Address: ${input.serviceAddress}`);
  doc.text(`Date: ${new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago" })}`);
  doc.moveDown();

  // Table header
  doc.fontSize(10).fillColor(BRAND.cedar);
  const colX = [36, 280, 380, 440];
  doc.text("Item", colX[0], doc.y, { continued: false });
  const headerY = doc.y - 12;
  doc.text("Qty", colX[1], headerY);
  doc.text("Unit", colX[2], headerY);
  doc.text("Supplier", colX[3], headerY);
  doc.moveTo(36, doc.y + 2).lineTo(576, doc.y + 2).lineWidth(0.5).stroke(BRAND.copper);
  doc.moveDown(0.3);

  doc.fillColor(BRAND.text);
  for (const item of input.items) {
    const y = doc.y;
    doc.text(item.name, colX[0], y);
    doc.text(String(item.quantity), colX[1], y);
    doc.text(item.unit ?? "ea", colX[2], y);
    doc.text(item.supplier ?? "—", colX[3], y);
  }

  addFooter(doc);

  const pdfPath = await savePdf(doc, `material-list-${docId}.pdf`);

  await prisma.document.create({
    data: {
      id: docId,
      jobId: input.jobId,
      type: "material_list",
      pdfUrl: pdfPath,
    },
  });

  return { documentId: docId, pdfPath };
}

// ─── HEALTH RECORD REPORT ───────────────────────────────────────────────────────

/**
 * v1 banding. The 0-100 score was retired in favour of leading with the items
 * that need correcting, but reports already delivered to customers carry a
 * score and re-rendering one has to reproduce what was sent.
 */
function scoreBand(score: number, hasCritical: boolean): string {
  if (hasCritical) return score < 60 ? "Priority" : "Needs attention";
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good / Serviceable";
  if (score >= 60) return "Needs attention";
  return "Priority";
}

/** `ACTION` is retained for v1 records written before the rename to FAIL. */
const RESULT_LABEL: Record<string, string> = {
  PASS: "Pass",
  MONITOR: "Monitor",
  FAIL: "Needs correction",
  ACTION: "Needs correction",
  BELOW_STANDARD: "Meets code — below Red Cedar standard",
  NA: "Not applicable (logged)",
};

import { V3_ROW_ORDER, baseItemId, itemName, itemPlain } from "../../shared/checklistText";
import { checklist } from "../../shared/checklist/checklist";
import type { ChecklistItemDef } from "../../shared/checklist/types";
import sharp from "sharp";
import { recommendGenerator } from "../../shared/loadcalc/generator";
import type { GeneratorFuel, GeneratorRecommendation } from "../../shared/loadcalc/generator";
import { LIQUID_COOLED_TEXT } from "../../shared/loadcalc/generatorData";
import type {
  LoadCalcInput as GenLoadCalcInput,
  LoadCalcResult as GenLoadCalcResult,
} from "../../shared/loadcalc/loadcalc";

/** Checklist defs by id — the same narratives the field app shows on site. */
const CHECKLIST_DEFS = new Map<string, ChecklistItemDef>(checklist.map((def) => [def.id, def]));

type MeasuredValue = string | number | boolean | string[] | Array<Record<string, string | number | boolean>>;

/**
 * One measured value as the sentence fragment the report speaks in — the
 * field's `reportLabel` where one exists, the raw reading otherwise.
 */
function measuredPhrase(def: ChecklistItemDef | undefined, fieldId: string, value: MeasuredValue): string {
  const field = def?.inputFields.find((f) => f.id === fieldId);
  const labelFor = (v: string | number | boolean): string => {
    const opt = field?.options?.find((o) => o.value === v);
    if (opt) return opt.reportLabel ?? opt.label.toLowerCase();
    if (typeof v === "boolean") return v ? "yes" : "no";
    // NO unit suffix — the whatWeFound templates already carry their units
    // ("{service_amps} A service"), and appending one printed "200 A A".
    return `${v}`;
  };
  if (Array.isArray(value)) {
    const scalars = value.filter((v): v is string => typeof v === "string");
    return scalars.length > 0 ? scalars.map(labelFor).join(", ") : String(value.length);
  }
  return labelFor(value);
}

/**
 * The item's whatWeFound narrative with the technician's readings substituted
 * in — the same sentence the assessment shows on site. Null when nothing was
 * measured, so an unmeasured item doesn't print a sentence of "not recorded".
 */
function filledNarrative(
  itemId: string,
  measured: Record<string, MeasuredValue> | undefined,
  computed: Record<string, number> | undefined,
): string | null {
  const def = CHECKLIST_DEFS.get(baseItemId(itemId));
  if (!def) return null;
  const template = def.reasoning.whatWeFound;
  let anyFilled = false;
  const text = template.replace(/\{([a-z0-9_]+)\}/gi, (_m, fieldId: string) => {
    const value = measured?.[fieldId] ?? computed?.[fieldId];
    if (value === undefined || value === null || value === "") return "not recorded";
    anyFilled = true;
    return measuredPhrase(def, fieldId, value as MeasuredValue);
  });
  return anyFilled ? text : null;
}

/** Downscaled JPEG ready for embedding, with its pixel dimensions. */
interface PreparedPhoto {
  buf: Buffer;
  width: number;
  height: number;
  /** Gallery photos carry their caption under the image. */
  caption?: string | null;
}

async function preparePhoto(data: Buffer | Uint8Array): Promise<PreparedPhoto | null> {
  try {
    const { data: buf, info } = await sharp(Buffer.from(data))
      .rotate() // respect EXIF orientation — phone photos lie on their side without it
      .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer({ resolveWithObject: true });
    return { buf, width: info.width, height: info.height };
  } catch {
    return null; // a corrupt upload must not sink the report
  }
}

/**
 * Draw photos two-up, breaking pages so an image never straddles the footer.
 * A photo with a caption gets it printed under its own cell.
 */
function drawPhotos(doc: PDFKit.PDFDocument, photos: PreparedPhoto[]): void {
  const margin = 36;
  const gutter = 12;
  const cellW = (doc.page.width - margin * 2 - gutter) / 2;
  const maxH = 200;
  for (let i = 0; i < photos.length; i += 2) {
    const row = photos.slice(i, i + 2);
    const dims = row.map((p) => {
      const scale = Math.min(cellW / p.width, maxH / p.height, 1);
      return { w: p.width * scale, h: p.height * scale };
    });
    const rowH = Math.max(...dims.map((d) => d.h));
    const anyCaption = row.some((p) => (p.caption ?? "").trim().length > 0);
    const captionH = anyCaption ? 14 : 0;
    if (doc.y + rowH + captionH > doc.page.height - 72) doc.addPage();
    const y = doc.y;
    row.forEach((p, j) => {
      const x = margin + j * (cellW + gutter);
      doc.image(p.buf, x, y, { width: dims[j].w, height: dims[j].h });
      const caption = (p.caption ?? "").trim();
      if (caption) {
        doc.fillColor(BRAND.muted).fontSize(7)
          .text(caption, x, y + rowH + 2, { width: cellW, height: 10, ellipsis: true });
        doc.fillColor(BRAND.text);
      }
    });
    doc.y = y + rowH + captionH + 6;
    doc.x = margin;
  }
}

/** Group labels for section notes, mirroring field/src/ui/screens/ChecklistScreen.tsx. */
const SECTION_GROUP_LABEL: Record<string, string> = {
  "service-entrance": "Service entrance & supply",
  "main-disconnect": "Main disconnect & working space",
  "bonding-grounding": "Bonding & grounding",
  "panel-condition": "Panel condition & overcurrent",
  "panel-measurements": "Panel measurements",
  surge: "Surge protection",
  "equipment-disconnects": "Equipment disconnects",
  "subpanel-bonding": "Subpanel bonding",
  "branch-protection": "Branch-circuit protection",
  devices: "Devices, receptacles & lighting",
  "life-safety": "Life safety",
  "metro-amendments": "Metro amendments",
};

/** Section roll-ups, mirroring field/src/domain/report.ts. */
const ROLLUP_GROUPS: { label: string; itemIds: string[] }[] = [
  { label: "Service Entrance", itemIds: ["A1", "A2", "A3", "B1", "B2"] },
  { label: "Grounding & Bonding", itemIds: ["C1", "C2", "C3", "C4", "C5", "C6", "C7"] },
  { label: "Panel & Overcurrent", itemIds: ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "H2"] },
  { label: "Branch Protection", itemIds: ["E1", "E2", "E3", "F1", "F2", "F3"] },
  { label: "Disconnects & Safety", itemIds: ["G1", "G2", "G3", "H1", "I1"] },
];

const SEVERITY_ORDER = ["NA", "PASS", "BELOW_STANDARD", "MONITOR", "FAIL"];

// Homeowner verbs (Kyle, 2026-08-25: "easily understood by people that have
// zero experience or knowledge of electrical").
const ROLLUP_LABEL: Record<string, string> = {
  PASS: "Good",
  MONITOR: "Worth watching",
  FAIL: "Needs attention",
  BELOW_STANDARD: "Meets code — below our standard",
  NA: "Not applicable",
  NOT_ASSESSED: "Not assessed this visit",
};

const normalizeResult = (raw: string): string => (raw === "ACTION" ? "FAIL" : raw);

interface ReportItemRow {
  itemId: string;
  result: string;
  gradedState?: string;
  note?: string;
  resolutionNote?: string;
  photoIds: string[];
  /** Sub-panel instance rows carry their location label ("Garage"). */
  locationId?: string;
  /** Structured readings from the field walk — the narrative substitutes these. */
  measured?: Record<string, MeasuredValue>;
  computed?: Record<string, number>;
}

/**
 * The customer-facing name for one assessed row. A sub-panel instance
 * ("SUB:garage") names itself by where it is; everything else comes from the
 * homeowner dictionary.
 */
function rowName(row: ReportItemRow): string {
  return row.locationId
    ? `${itemName(baseItemId(row.itemId))} — ${row.locationId}`
    : itemName(row.itemId);
}

function rollupStatus(items: ReportItemRow[], itemIds: string[]): string {
  const inGroup = items.filter((item) => itemIds.includes(item.itemId));
  if (inGroup.length === 0) return "NOT_ASSESSED";
  let worst = "NA";
  for (const item of inGroup) {
    const result = normalizeResult(item.result);
    if (SEVERITY_ORDER.indexOf(result) > SEVERITY_ORDER.indexOf(worst)) worst = result;
  }
  return worst;
}

/**
 * Render a synced field inspection into the customer's document chain, so the
 * health report lives alongside contracts and proposals with one delivery path.
 */
/**
 * Protocol v2 report section — the structured capture plus the disclosures
 * the protocol requires in EVERY report where they apply: the §3.3 energized-
 * termination scope boundary, the grounding instrument's honest claim, rule-4
 * out-of-condition readings, the §6 sampling basis, the §8.7 bus-corrosion
 * honest limit, and the §11.3 disclaimer. Silent gaps are what get a record
 * picked apart; volunteered boundaries are what make it defensible.
 */
async function addProtocolV2Section(
  doc: PDFKit.PDFDocument,
  inspectionId: string,
  groundingTestMethod: string | null,
  dateStr: string,
): Promise<void> {
  const [items, samplingRecords] = await Promise.all([
    prisma.inspectionItem.findMany({
      where: { inspectionId },
      include: { measurements: true, busVisual: true, enclosure: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.samplingRecord.findMany({ where: { inspectionId } }),
  ]);

  const hasV2 = items.length > 0 || samplingRecords.length > 0;

  if (hasV2) {
    doc.fillColor(BRAND.cedar).fontSize(12).text("Component Assessment (measured)", { underline: true });
    doc.fontSize(9);

    // Group by enclosure for the walk-order the tech actually took.
    const byEnclosure = new Map<string, typeof items>();
    for (const item of items) {
      const key = item.enclosure
        ? `${item.enclosure.enclosureType.replace(/_/g, " ")}${item.enclosure.locationDescription ? ` — ${item.enclosure.locationDescription}` : ""}`
        : "Unassigned";
      byEnclosure.set(key, [...(byEnclosure.get(key) ?? []), item]);
    }

    const CLASS_COLOR: Record<string, string> = { fail: "#b91c1c", monitor: "#b45309", upgrade: "#0369a1", pass: BRAND.text };
    for (const [enclosureLabel, rows] of byEnclosure) {
      doc.fillColor(BRAND.text).fontSize(10).text(enclosureLabel);
      doc.fontSize(9);
      for (const item of rows.filter((r) => r.customerVisible)) {
        const label = [item.componentType.replace(/_/g, " "), item.locationLabel, item.circuitNumber ? `ckt ${item.circuitNumber}` : null]
          .filter(Boolean).join(" · ");
        doc.fillColor(CLASS_COLOR[item.classification] ?? BRAND.text)
          .text(`  ${label}: ${item.classification.toUpperCase()}${item.serviceSideEnergized ? " †" : ""}`);
        doc.fillColor(BRAND.muted);
        for (const m of item.measurements) {
          const parts = [
            `${m.measurementType.replace(/_/g, " ")} = ${m.measuredValue} ${m.unit}`,
            m.loadAmperageAtReading != null ? `at ${m.loadAmperageAtReading} A load` : null,
            m.comparativeReferenceItemId ? `vs ${m.comparativeReferenceItemId}` : null,
            m.methodConditionsMet === false ? "[outside method conditions — indicative]" : null,
          ].filter(Boolean).join(", ");
          doc.text(`      ${parts}`);
          if (m.measurementType === "voltage_drop_pct") {
            doc.text(`      ${voltageDropLanguage(m.measuredValue)}`);
          }
        }
        doc.fillColor(BRAND.text);
      }
      doc.moveDown(0.25);
    }
    doc.moveDown(0.5);
  }

  // ── Method limits & disclosures. Emitted whenever they apply; the §11.3
  // disclaimer is unconditional on every report.
  doc.fillColor(BRAND.cedar).fontSize(12).text("Methods, Limits & Sampling", { underline: true });
  doc.fillColor(BRAND.muted).fontSize(8);

  const energized = items.filter((i) => i.serviceSideEnergized);
  if (energized.length > 0) {
    const labels = energized.map((i) =>
      [i.componentType.replace(/_/g, " "), i.locationLabel].filter(Boolean).join(" "));
    doc.text(`† ${energizedTerminationLanguage(labels)}`);
    doc.moveDown(0.25);
  }

  const anyTorque = items.some((i) => i.measurements.some((m) => m.measurementType === "torque"));
  if (anyTorque) {
    doc.text(TORQUE_METHOD_LIMIT);
    doc.moveDown(0.25);
  }

  const anyGrounding = items.some((i) => i.measurements.some((m) => m.measurementType === "grounding_resistance"));
  if (anyGrounding || hasV2) {
    doc.text(groundingMethodLanguage(groundingTestMethod));
    doc.moveDown(0.25);
  }

  const outOfCondition = items.flatMap((i) => i.measurements).filter((m) => m.methodConditionsMet === false).length;
  if (outOfCondition > 0) {
    doc.text(methodConditionsLanguage(outOfCondition));
    doc.moveDown(0.25);
  }

  if (items.some((i) => i.busVisual)) {
    doc.text(BUS_CORROSION_HONEST_LIMIT);
    doc.moveDown(0.25);
  }

  if (samplingRecords.length > 0) {
    doc.fillColor(BRAND.text).fontSize(9).text("Sampling basis (disclosed):");
    doc.fillColor(BRAND.muted).fontSize(8);
    for (const s of samplingRecords) {
      doc.text(samplingDisclosure({
        category: s.category,
        totalCount: s.totalCount,
        testedCount: s.testedCount,
        basis: s.basis,
        expandedDueToFail: s.expandedDueToFail,
        untestedLocations: s.untestedLocations,
      }));
    }
    doc.moveDown(0.25);
  }

  doc.text(reportDisclaimer(dateStr));
  doc.fillColor(BRAND.text);
  doc.moveDown(0.5);
}

export async function generateHealthReport(
  inspectionId: string,
): Promise<{ documentId: string; pdfPath: string }> {  const inspection = await prisma.healthInspection.findUnique({
    where: { id: inspectionId },
    include: {
      customer: { select: { name: true } },
      property: { select: { addressLine1: true, city: true, state: true, postalCode: true } },
      technician: { select: { name: true, employeeNumber: true } },
      photos: { select: { id: true, mimeType: true, data: true } },
    },
  });
  if (!inspection) throw new Error(`Inspection ${inspectionId} not found`);

  const items = parseJsonArray<ReportItemRow>(inspection.itemsJson);

  // Photo evidence, downscaled once and embedded where each photo was taken.
  // "This report is bland and contains no photos from the sections check"
  // (Kyle, 2026-08-28) — the images ARE the record; a count line wasn't one.
  const photoById = new Map<string, PreparedPhoto>();
  for (const photo of inspection.photos) {
    const prepared = await preparePhoto(photo.data);
    if (prepared) photoById.set(photo.id, prepared);
  }
  const photosFor = (row: ReportItemRow): PreparedPhoto[] =>
    row.photoIds.map((id) => photoById.get(id)).filter((p): p is PreparedPhoto => Boolean(p));

  // Job-gallery photos tagged "Assessment" ride the Health Record with their
  // captions (Kyle, 2026-08-29: "I can't add photos to the health report from
  // my gallery"). Tagging is the control: Before/After/Reference photos stay
  // off this document.
  const galleryRows = await prisma.visitPhoto.findMany({
    where: { visitId: inspection.visitId, tag: "assessment" },
    select: { data: true, caption: true },
    orderBy: { uploadedAt: "asc" },
  });
  const galleryPhotos: PreparedPhoto[] = [];
  for (const row of galleryRows) {
    const prepared = await preparePhoto(row.data);
    if (prepared) galleryPhotos.push({ ...prepared, caption: row.caption });
  }
  const criticals = parseJsonStringArray(inspection.criticalFindingsJson);
  const loadCalc = inspection.loadCalcJson
    ? (JSON.parse(inspection.loadCalcJson) as {
        result?: {
          governingAmps?: number;
          serviceAmps?: number;
          loadPct?: number;
          spareAmps?: number;
          methodUsed?: string;
          breakdown?: { label: string; rawVA: number; appliedVA: number; rule: string }[];
        };
      }).result ?? null
    : null;

  // The LOAD row's {calc_load} placeholder lives on the stored calculation,
  // not in the item's own readings — substitute the real number so the
  // narrative doesn't print "not recorded" beside a filled capacity section.
  if (loadCalc?.governingAmps !== undefined) {
    const loadRow = items.find((row) => baseItemId(row.itemId) === "LOAD");
    if (loadRow) {
      loadRow.measured = { calc_load: loadCalc.governingAmps, ...(loadRow.measured ?? {}) };
    }
  }

  const docId = uuidv4();
  const doc = new PDFDocument({ margin: 36 });

  addHeader(doc, "Electrical Health Record");

  const dateStr = inspection.inspectionDate.toLocaleDateString("en-US", { timeZone: "America/Chicago" });
  doc.fontSize(11).fillColor(BRAND.text);
  doc.text(`Customer: ${inspection.customer.name}`);
  doc.text(`Property: ${inspection.property.addressLine1}, ${inspection.property.city}, ${inspection.property.state} ${inspection.property.postalCode}`);
  const techLabel = inspection.technician
    ? ` by ${inspection.technician.name}${inspection.technician.employeeNumber ? ` (Emp #${inspection.technician.employeeNumber})` : ""}`
    : "";
  doc.text(`Inspected: ${dateStr}${techLabel} · Jurisdiction: ${inspection.jurisdictionId}`);
  doc.moveDown();

  const isV1 = inspection.schemaVersion === "v1" && inspection.score !== null;

  if (isV1) {
    // Reproduce the delivered report exactly, score and all.
    doc.fillColor(BRAND.cedar).fontSize(22).text(
      `Health Score: ${inspection.score}  —  ${scoreBand(inspection.score!, criticals.length > 0)}`,
    );
    doc.fillColor(BRAND.muted).fontSize(9).text(`${inspection.itemsAssessed} items assessed`);
    doc.moveDown(0.5);
  } else {
    if (inspection.scope === "phase1") {
      doc.fillColor(BRAND.muted).fontSize(10).text(
        "Phase 1 — service entrance & exterior assessment. Interior items are covered separately.",
      );
      doc.moveDown(0.25);
    }
    doc.fillColor(BRAND.cedar).fontSize(14).text(
      `${inspection.failCount} need${inspection.failCount === 1 ? "s" : ""} attention · ` +
      `${inspection.monitorCount} worth watching · ${inspection.passCount} checked out fine`,
    );
    doc.moveDown(0.5);

    // Section status, the way the report opens.
    doc.fillColor(BRAND.cedar).fontSize(12).text("At a glance", { underline: true });
    doc.fontSize(10);
    if (inspection.schemaVersion === "v3") {
      // v3: the glance IS the walk (Kyle, 2026-08-26: "same rows everywhere").
      // One line per row in his order, sub-panel instances right after SUB;
      // N/A rows are omitted like everywhere else on the customer document.
      const rowsById = new Map(items.map((row) => [row.itemId, row]));
      const glanceIds: string[] = [];
      for (const id of V3_ROW_ORDER) {
        glanceIds.push(id);
        if (id === "SUB") {
          glanceIds.push(...items
            .filter((row) => row.itemId.startsWith("SUB:"))
            .map((row) => row.itemId)
            .sort());
        }
      }
      for (const id of glanceIds) {
        const row = rowsById.get(id);
        const status = row ? normalizeResult(row.result) : "NOT_ASSESSED";
        if (status === "NA") continue;
        const name = row ? rowName(row) : itemName(id);
        doc.fillColor(status === "FAIL" ? "#b91c1c" : BRAND.text)
          .text(`${name}: ${ROLLUP_LABEL[status] ?? status}`);
      }
    } else {
      for (const group of ROLLUP_GROUPS) {
        const status = rollupStatus(items, group.itemIds);
        doc.fillColor(status === "FAIL" ? "#b91c1c" : BRAND.text)
          .text(`${group.label}: ${ROLLUP_LABEL[status] ?? status}`);
      }
    }
    doc.fillColor(BRAND.text);
    doc.moveDown(0.5);
  }

  if (criticals.length > 0) {
    // Names, never codes (Kyle, 2026-08-25: "The D3 and A3 identifiers won't
    // be understood by the customer"). "Urgent safety item" is his word choice.
    doc.fillColor("#b91c1c").fontSize(12).text(
      isV1
        ? `CRITICAL FINDINGS: ${criticals.join(", ")} — headline score capped at 69 until resolved.`
        // No ⚠ glyph: PDFKit's standard fonts are WinAnsi-only and print it
        // as "&". The red type carries the urgency on its own.
        : `${criticals.length} urgent safety item${criticals.length > 1 ? "s" : ""} found — review ${criticals.length > 1 ? "these" : "this"} first: ${criticals.map((id) => {
            const row = items.find((r) => r.itemId === id);
            return row ? rowName(row) : itemName(id);
          }).join("; ")}.`,
    );
    doc.fillColor(BRAND.text);
    doc.moveDown(0.5);
  }

  if (loadCalc?.governingAmps !== undefined) {
    doc.fillColor(BRAND.cedar).fontSize(12).text("Does your service have enough capacity?", { underline: true });
    // This section IS the capacity check — it must never tell the reader to go
    // get one (Kyle, 2026-08-28: "This is a literal capacity check. Why would
    // we say to do another."). Each tier states what THIS calculation supports.
    const pct = loadCalc.loadPct ?? 0;
    const spare = loadCalc.spareAmps !== undefined ? `${loadCalc.spareAmps} amps of spare capacity` : "spare capacity";
    const headroom = pct <= 60
      ? `${spare} — comfortable room for future additions like an EV charger or a hot tub`
      : pct <= 80
        ? `${spare} for future additions`
        : `only ${spare} — a major new load would call for a service upgrade`;
    doc.fillColor(BRAND.text).fontSize(10).text(
      `Your home's calculated demand is ${loadCalc.governingAmps} amps on a ${loadCalc.serviceAmps}-amp service — ` +
      `about ${loadCalc.loadPct}% of capacity, leaving ${headroom}.`,
    );
    doc.fillColor(BRAND.muted).fontSize(8).text(
      `Calculated per NEC Article 220 (${loadCalc.methodUsed ?? "optional"} method); capacity basis NEC 230.42.`,
    );
    // The math itself (Kyle, 2026-08-31: "We need to have the math show for
    // the calculations.") — every line of the governing method, raw → applied.
    if (loadCalc.breakdown && loadCalc.breakdown.length > 0) {
      doc.moveDown(0.2);
      doc.fillColor(BRAND.text).fontSize(9).text("The calculation, line by line:");
      for (const line of loadCalc.breakdown) {
        doc.fillColor(BRAND.muted).fontSize(8).text(
          `•  ${line.label}: ${Math.round(line.rawVA).toLocaleString()} VA → ${Math.round(line.appliedVA).toLocaleString()} VA applied (${line.rule})`,
          { indent: 12 },
        );
      }
    }
    doc.fillColor(BRAND.text);
    doc.moveDown();
  }

  if (isV1) {
    doc.fillColor(BRAND.cedar).fontSize(12).text("Findings by Item", { underline: true });
    doc.fillColor(BRAND.text).fontSize(9);
    for (const item of items) {
      const grade = item.gradedState ? ` (${item.gradedState})` : "";
      const critical = criticals.includes(item.itemId) ? "  CRITICAL" : "";
      doc.text(`${item.itemId}: ${RESULT_LABEL[item.result] ?? item.result}${grade}${critical}${item.note ? ` — ${item.note}` : ""}`);
    }
    doc.moveDown();
  } else {
    // Findings in the homeowner's language (Kyle, 2026-08-25). Every item
    // speaks by NAME with its what-this-is sentence; the checklist code
    // survives only as small print so the record still cross-references.
    const byResult = (state: string) =>
      items.filter((item) => normalizeResult(item.result) === state);

    // Each row reads like the assessment did on site: what we checked, what we
    // found (the field's own narrative with the readings substituted in), the
    // technician's notes, why it matters, the code basis — and the photos taken
    // at that item, embedded, not counted (Kyle, 2026-08-28: "We need the
    // report to be detailed to resemble the assessment and it is an official
    // document where the notes and observations are noted.").
    const renderItem = (item: ReportItemRow, color: string, withResolution: boolean, withWhyItMatters: boolean) => {
      const def = CHECKLIST_DEFS.get(baseItemId(item.itemId));
      const critical = criticals.includes(item.itemId);
      doc.fontSize(10).fillColor(color).text(
        `${rowName(item)}${critical ? "  —  URGENT SAFETY ITEM" : ""}`,
      );
      doc.fontSize(9).fillColor(BRAND.text);
      const plain = itemPlain(item.itemId);
      if (plain) {
        doc.fillColor(BRAND.muted).text(`    What this is: ${plain}`);
        doc.fillColor(BRAND.text);
      }
      if (def) {
        doc.fillColor(BRAND.muted).text(`    What we checked: ${def.reasoning.whatWeCheck}`);
        doc.fillColor(BRAND.text);
      }
      const narrative = filledNarrative(item.itemId, item.measured, item.computed);
      if (narrative) doc.text(`    What we found: ${narrative}`);
      // The field checklist has separate "note" and "resolution" boxes, but
      // a tech often writes finding + fix as one sentence in whichever box
      // is handy. Split labels are only honest when BOTH boxes were used;
      // a lone entry gets a label that covers either reading.
      if (item.note && withResolution && item.resolutionNote) {
        doc.text(`    Technician's observation: ${item.note}`);
        doc.text(`    What fixes it: ${item.resolutionNote}`);
      } else if (item.note) {
        doc.text(`    Technician's observation: ${item.note}`);
      } else if (withResolution && item.resolutionNote) {
        doc.text(`    What we found & what fixes it: ${item.resolutionNote}`);
      }
      if (withWhyItMatters && def) {
        doc.fillColor(BRAND.muted).text(`    Why it matters: ${def.reasoning.whyItMatters}`);
        doc.fillColor(BRAND.text);
      }
      doc.fillColor(BRAND.muted).fontSize(7).text(
        `    (checklist item ${baseItemId(item.itemId)}${def?.citations.length ? ` · ${def.citations.join(", ")}` : ""})`,
      );
      doc.fillColor(BRAND.text).fontSize(9);
      const itemPhotos = photosFor(item);
      if (itemPhotos.length > 0) {
        doc.moveDown(0.2);
        drawPhotos(doc, itemPhotos);
      }
      doc.moveDown(0.3);
    };

    const renderGroup = (title: string, rows: ReportItemRow[], color: string, withResolution = false) => {
      if (rows.length === 0) return;
      doc.fillColor(BRAND.cedar).fontSize(12).text(`${title} (${rows.length})`, { underline: true });
      for (const item of rows) renderItem(item, color, withResolution, true);
      doc.moveDown(0.3);
    };

    renderGroup("Needs attention", byResult("FAIL"), "#b91c1c", true);
    renderGroup("Worth watching", byResult("MONITOR"), "#b45309", true);
    renderGroup("Meets code — below our standard", byResult("BELOW_STANDARD"), BRAND.text, true);

    const passed = byResult("PASS");
    if (passed.length > 0) {
      doc.fillColor(BRAND.cedar).fontSize(12).text(`What checked out fine (${passed.length})`, { underline: true });
      // A passed item that carries readings, notes, or photos still gets its
      // full entry — "checked out fine" is a finding too, and the evidence
      // belongs with it. Only bare passes collapse to the compact line.
      const detailed = passed.filter(
        (item) => photosFor(item).length > 0 || item.note ||
          filledNarrative(item.itemId, item.measured, item.computed),
      );
      const bare = passed.filter((item) => !detailed.includes(item));
      for (const item of detailed) renderItem(item, BRAND.text, false, false);
      if (bare.length > 0) {
        doc.fillColor(BRAND.text).fontSize(9).text(
          bare.map((item) => rowName(item)).join("  ·  "),
        );
      }
      doc.moveDown(0.5);
    }

    // Items marked not-applicable are OMITTED from the customer's document
    // (Kyle's ruling, 2026-08-25). The internal record keeps them; the
    // Scope & Limitations page already states that only listed items were
    // assessed.
  }

  // ── Promoted section notes (Kyle, 2026-08-24) ──
  // Internal notes stay internal; only rows the technician toggled
  // "includeOnReport" reach this document.
  const sectionNotes = (() => {
    try {
      const rows = inspection.sectionNotesJson
        ? (JSON.parse(inspection.sectionNotesJson) as Array<{ group: string; note: string; includeOnReport?: boolean }>)
        : [];
      return rows.filter((row) => row.includeOnReport && row.note?.trim());
    } catch {
      return [];
    }
  })();
  if (sectionNotes.length > 0) {
    doc.fillColor(BRAND.cedar).fontSize(12).text("Technician Notes by Section", { underline: true });
    doc.fontSize(9);
    for (const row of sectionNotes) {
      doc.fillColor(BRAND.text).text(`${SECTION_GROUP_LABEL[row.group] ?? row.group}: ${row.note.trim()}`);
    }
    doc.moveDown(0.5);
  }

  // Photos taken during the walk that weren't attached to a specific item —
  // plus assessment-tagged photos from the job gallery — still belong on the
  // record; an official document doesn't hold evidence back.
  const referencedPhotoIds = new Set(items.flatMap((item) => item.photoIds ?? []));
  const unattached = inspection.photos
    .filter((photo) => !referencedPhotoIds.has(photo.id))
    .map((photo) => photoById.get(photo.id))
    .filter((p): p is PreparedPhoto => Boolean(p));
  const additional = [...unattached, ...galleryPhotos];
  if (additional.length > 0) {
    doc.fillColor(BRAND.cedar).fontSize(12).text("Additional Photo Documentation", { underline: true });
    doc.moveDown(0.2);
    drawPhotos(doc, additional);
    doc.moveDown(0.5);
  }

  // Credentials, not workflow (Kyle, 2026-08-25: "The contractor review
  // notation is false. This has been reviewed and a whole inspection was
  // done, that was the review."). The customer reads WHO stands behind the
  // document; the review gate stays internal machinery.
  const techName = inspection.technician?.name ?? "Red Cedar Electric";
  const reviewerLine =
    inspection.contractorReviewed && inspection.reviewedBy && inspection.reviewedBy !== techName
      ? `Assessed on site by ${techName}; reviewed by ${inspection.reviewedBy}, licensed electrical contractor.`
      : `Assessed and reviewed on site by ${techName}, licensed electrical contractor.`;
  doc.fillColor(BRAND.muted).fontSize(8).text(
    `${reviewerLine} Red Cedar Electric LLC — License #61828. ` +
    `Photo evidence on file: ${inspection.photos.length + galleryPhotos.length} image(s).`,
  );
  doc.moveDown(0.5);

  // ── Customer acknowledgment (Kyle, 2026-08-24) ──
  // The digital counterpart of the paper form's signature box. Declined items
  // are their own documents (finding declinations); this block proves the
  // findings were reviewed with the customer on site.
  if (inspection.acknowledgedAt && inspection.customerSignerName) {
    const ackDate = inspection.acknowledgedAt.toLocaleDateString("en-US", { timeZone: "America/Chicago" });
    doc.fillColor(BRAND.cedar).fontSize(12).text("Customer Acknowledgment", { underline: true });
    doc.fillColor(BRAND.text).fontSize(9).text(
      `The findings above — including any item needing correction or monitoring — were reviewed ` +
      `with ${inspection.customerSignerName} on site on ${ackDate}.`,
    );
    if (inspection.customerSignatureImage?.startsWith("data:image/png;base64,")) {
      try {
        const png = Buffer.from(inspection.customerSignatureImage.split(",")[1], "base64");
        doc.image(png, { fit: [180, 60] });
      } catch {
        doc.fillColor(BRAND.muted).text("(signature image could not be rendered)");
      }
    }
    doc.fillColor(BRAND.muted).fontSize(8).text(`Signed: ${inspection.customerSignerName} · ${ackDate}`);
    doc.fillColor(BRAND.text);
    doc.moveDown(0.5);
  } else if (inspection.ackSkippedReason) {
    doc.fillColor(BRAND.muted).fontSize(8).text(
      `On-site acknowledgment not signed — ${inspection.ackSkippedReason}.`,
    );
    doc.fillColor(BRAND.text);
    doc.moveDown(0.5);
  }

  // ── Protocol v2 structured capture — enclosures, measurements, disclosures ──
  await addProtocolV2Section(doc, inspection.id, inspection.groundingTestMethod, dateStr);

  if (isV1) {
    doc.fillColor(BRAND.muted).fontSize(8).text(
      "This score reflects severity, likelihood, and how hidden each issue is — weighted from national fire/shock data, not our opinion.",
    );
  }

  addLimitations(doc);
  addFooter(doc);

  const pdfPath = await savePdf(doc, `health-report-${docId}.pdf`);

  await prisma.document.create({
    data: {
      id: docId,
      jobId: inspection.visitId,
      type: "health_report",
      pdfUrl: pdfPath,
    },
  });

  return { documentId: docId, pdfPath };
}

// ─── GENERATOR SIZING REPORT (P031, Kyle 2026-08-28) ────────────────────────

/**
 * Standalone generator sizing document off an inspection's load calculation.
 *
 * Uses the recommendation the technician stored with the A2 calc when one
 * exists — that is the frozen fact. When the tech never opened the generator
 * panel, the shared engine computes one here with stated defaults (natural
 * gas, Middle-TN altitude derate, no soft-start) — same engine, same data
 * module, and the document says which path produced it.
 */
export async function generateGeneratorReport(
  inspectionId: string,
): Promise<{ documentId: string; pdfPath: string }> {
  const inspection = await prisma.healthInspection.findUnique({
    where: { id: inspectionId },
    include: {
      customer: { select: { name: true } },
      property: { select: { addressLine1: true, city: true, state: true, postalCode: true } },
      technician: { select: { name: true } },
    },
  });
  if (!inspection) throw new Error(`Inspection ${inspectionId} not found`);
  if (!inspection.loadCalcJson) {
    throw new Error("This inspection has no load calculation — run the A2 load calc first.");
  }

  const stored = JSON.parse(inspection.loadCalcJson) as {
    input: GenLoadCalcInput;
    result: GenLoadCalcResult;
    generator?: {
      recommendation: GeneratorRecommendation;
      fuel: GeneratorFuel;
      softStart: boolean;
      altitudeSteps?: number;
    };
  };
  const fromField = stored.generator !== undefined;
  const rec: GeneratorRecommendation = fromField
    ? stored.generator!.recommendation
    : recommendGenerator({
        calcInput: stored.input,
        calcResult: stored.result,
        fuel: "NG",
        softStart: false,
      });

  // Generating the sheet IS documenting the sizing (Kyle, 2026-08-29: "It is
  // linking to the field app rather than the documented information") —
  // persist the recommendation so the estimate flow's attach finds it, instead
  // of demanding a field-app pass that already happened here.
  if (!fromField) {
    const generatorPayload = JSON.stringify({
      recommendation: rec,
      fuel: rec.fuel,
      softStart: false,
      altitudeSteps: 1,
      includeInEstimate: true,
    });
    await prisma.healthInspection.update({
      where: { id: inspectionId },
      data: { loadCalcJson: JSON.stringify({ ...stored, generator: JSON.parse(generatorPayload) }) },
    });
    await prisma.capacityCheck.updateMany({
      where: { sourceInspectionId: inspectionId },
      data: { generatorJson: generatorPayload },
    });
  }

  const docId = uuidv4();
  const doc = new PDFDocument({ margin: 36 });
  addHeader(doc, "Generator Sizing Data Sheet");

  const dateStr = inspection.inspectionDate.toLocaleDateString("en-US", { timeZone: "America/Chicago" });
  doc.fontSize(11).fillColor(BRAND.text);
  doc.text(`Customer: ${inspection.customer.name}`);
  doc.text(`Property: ${inspection.property.addressLine1}, ${inspection.property.city}, ${inspection.property.state} ${inspection.property.postalCode}`);
  doc.text(
    `Based on the NEC Article 220 load calculation of ${dateStr}` +
    `${inspection.technician ? ` by ${inspection.technician.name}` : ""}: ` +
    `${stored.result.governingAmps} A calculated on a ${stored.input.serviceAmps} A service.`,
  );
  doc.fillColor(BRAND.text);
  doc.moveDown();

  /*
    ── DATA SHEET, NOT EDITORIAL (Kyle, 2026-08-29) ─────────────────────────
    "There should be no sanity checks or assumption checks on any
    documentation. These are data sheets and informational sheets. No
    opinionated rhetoric."

    The engine's flags and advisory notes stay on the TECH panel where Kyle
    reads them. This document composes from the structured data only: each
    option is its own section with a factual explanation of how the sizing is
    derived, then the numbers as bullets. Nothing recommends, warns, or
    editorializes; a tier with no result is simply not printed.
  */
  const bullet = (text: string, color: string = BRAND.text) => {
    doc.fillColor(color).fontSize(10).text(`•  ${text}`, { indent: 12 });
  };
  const sectionHead = (title: string) => {
    doc.moveDown(0.6);
    doc.fillColor(BRAND.cedar).fontSize(13).text(title, { underline: true });
    doc.moveDown(0.25);
  };
  const explain = (text: string) => {
    doc.fillColor(BRAND.text).fontSize(10).text(text);
    doc.moveDown(0.3);
  };
  /*
    ── ELECTRICAL SCOPE ONLY (Kyle, 2026-08-29) ─────────────────────────────
    "Since we do not deal with the plumbing or gas lines I would not want to
    put any fuel recommendations or specific generator model types on the
    report. The customer will take this info to make an informed decision. We
    stay only in the electrical scope."

    No fuel, no brands, no model numbers, no product-specific timings. The
    sheet states the home's electrical requirements per connection option; the
    customer shops any generator with these numbers. Brand/model/fuel/BOM
    detail stays on the internal tech panel and in the stored recommendation.
  */
  // A shed heat pump's mechanism names Generac hardware internally — the
  // customer sheet describes it generically.
  const genericMechanism = (mechanism: string): string =>
    mechanism.includes("SACM")
      ? "managed through the transfer switch's thermostat interrupt"
      : "managed by a dedicated load-management module on its circuit";

  const [full, managed, interlock] = rec.wholeHome;

  // ── The empirical basis every option is sized from ──
  sectionHead("The Home's Electrical Load — the Basis for Every Option");
  explain(
    "All sizing below derives from the NEC Article 220 load calculation performed at this home. " +
    "A generator's continuous output rating must meet the stated requirement of the chosen option.",
  );
  bullet(`Calculated demand: ${stored.result.governingAmps} A × 240 V = ${full.requiredKW} kW (Article 220, ${stored.result.methodUsed} method)`);
  bullet(`Electrical service: ${stored.input.serviceAmps} A`);
  // The air-cooled ceiling (Kyle, 2026-08-31): Red Cedar does not install
  // liquid-cooled units, so every option is read against this line.
  const ceilingKW: number | null = typeof rec.airCooledCeilingKW === "number" ? rec.airCooledCeilingKW : null;
  if (ceilingKW !== null) {
    bullet(`Air-cooled standby equipment at this site carries up to about ${ceilingKW} kW continuous; every option below is read against that line`);
  }
  // The math itself (Kyle, 2026-08-31: "We need to have the math show for the
  // calculations. It needs to show for the generator too.") — every line of the
  // governing Article 220 method, raw entry → applied demand, with its rule.
  if (stored.result.breakdown?.length) {
    doc.moveDown(0.3);
    doc.fillColor(BRAND.text).fontSize(10).text("The calculation, line by line:");
    for (const line of stored.result.breakdown) {
      bullet(
        `${line.label}: ${Math.round(line.rawVA).toLocaleString()} VA → ${Math.round(line.appliedVA).toLocaleString()} VA applied (${line.rule})`,
        BRAND.muted,
      );
    }
    bullet(`Applied total ÷ 240 V = ${stored.result.governingAmps} A calculated demand`, BRAND.muted);
  }
  if (rec.surge.status === "ok" && rec.surge.startKVA !== null) {
    bullet(`Largest motor start: ${rec.surge.largestMotorLabel} — ${rec.surge.startKVA} kVA locked-rotor (the generator's surge rating must cover this)`);
  }

  // ── Option 1 — full load ──
  sectionHead("Option 1 — Automatic Transfer, Sized for the Full Load");
  explain(
    "The generator carries the entire calculated load; every circuit stays powered with no load " +
    "management. Continuous output must meet or exceed the full calculated demand. " +
    `Code basis: ${full.necBasis}.`,
  );
  bullet(`Required continuous output: ${full.requiredKW} kW (${full.requiredAmps} A)`);
  if (full.liquidCooled && ceilingKW !== null) {
    bullet(`Exceeds air-cooled equipment at this site (${ceilingKW} kW) — see Option 2, load management`);
  }

  // ── Option 2 — load management ──
  sectionHead("Option 2 — Automatic Transfer with Load Management");
  explain(
    "Managed loads are disconnected automatically when demand would exceed generator capacity and " +
    "restored in priority order as capacity allows. The generator is sized to the unmanaged base " +
    `load; each managed circuit carries load-management hardware. Code basis: ${managed.necBasis}.`,
  );
  bullet(`Required continuous output (base load with managed loads removed): ${managed.requiredKW} kW (${managed.requiredAmps} A)`);
  if (managed.autoShed && managed.autoShed.added.length > 0) {
    bullet(
      `Management extended beyond the selected loads to stay within air-cooled equipment ` +
      `(${managed.autoShed.ceilingKW} kW at this site): ${managed.autoShed.added.join(", ")} added`,
    );
  }
  if (managed.autoShed && !managed.autoShed.fits) {
    bullet(
      `Even with every manageable load managed, the base load exceeds air-cooled equipment at this site ` +
      `(${managed.autoShed.ceilingKW} kW); a reduced backup scope is required`,
    );
  } else if (ceilingKW !== null && managed.requiredKW !== null) {
    bullet(`Within air-cooled equipment: ${managed.requiredKW} kW required against a ${ceilingKW} kW ceiling`);
  }
  // The managed-base math, line by line. Article 220's demand factors apply in
  // both calculations, so the two printed totals carry the true difference —
  // shedding a 12 kW range does not subtract 12 kW.
  if (managed.baseBreakdown?.length) {
    doc.moveDown(0.3);
    doc.fillColor(BRAND.text).fontSize(10).text("Base-load calculation with the managed loads removed, line by line:");
    for (const line of managed.baseBreakdown) {
      bullet(
        `${line.label}: ${Math.round(line.rawVA).toLocaleString()} VA → ${Math.round(line.appliedVA).toLocaleString()} VA applied (${line.rule})`,
        BRAND.muted,
      );
    }
    if (full.requiredKW !== null && managed.requiredKW !== null) {
      bullet(
        `Full calculated load ${full.requiredKW} kW − managed base ${managed.requiredKW} kW = ` +
        `${Math.round((full.requiredKW - managed.requiredKW) * 100) / 100} kW carried by load management. ` +
        "Article 220 demand factors apply to both calculations; a managed load's nameplate is not subtracted one-for-one.",
        BRAND.muted,
      );
    }
  }
  const planRows = managed.managementPlan?.managed ?? [];
  if (planRows.length > 0) {
    doc.moveDown(0.3);
    doc.fillColor(BRAND.text).fontSize(10).text("Managed loads and priority order:");
    // A heat pump's two stages — compressor and supplemental heat — are named
    // once and cross-referenced, never printed as two whole appliances (Kyle,
    // 2026-08-31: the Himrick sheet read as a duplicate).
    const compressorPriority = new Map<string, number>();
    for (const row of planRows) {
      if (row.stage === "compressor" && row.itemId) compressorPriority.set(row.itemId, row.priority);
    }
    for (const row of planRows) {
      let label = row.label;
      if (row.stage === "supplemental" && row.itemId !== undefined) {
        const compAt = compressorPriority.get(row.itemId);
        label = compAt !== undefined
          ? `Supplemental heat stage of the Priority ${compAt} unit`
          : label;
      } else if (
        row.stage === "compressor" &&
        row.itemId !== undefined &&
        planRows.some((r) => r.itemId === row.itemId && r.stage === "supplemental")
      ) {
        label = `${label}, compressor stage`;
      }
      bullet(`Priority ${row.priority}: ${label} — ${row.kw} kW, ${genericMechanism(row.mechanism)}`, BRAND.muted);
    }
    bullet("Managed loads operate as generator capacity allows", BRAND.muted);
  }

  // ── The load-management menu (Kyle, 2026-08-31): a variety of shed options,
  // each its own Article 220 calculation — the customer picks the installation.
  const scenarios = rec.shedScenarios ?? [];
  if (scenarios.length > 0) {
    doc.moveDown(0.3);
    doc.fillColor(BRAND.text).fontSize(10).text("Sizing by what is managed — the menu of alternatives:");
    doc.fillColor(BRAND.muted).fontSize(9).text(
      "Option 2 above is sized to the selected design. Each row below is an independent Article 220 " +
      "calculation managing one load on its own, plus the everything-managed floor.",
    );
    for (const s of scenarios) {
      const what = s.label === "Every manageable load" ? "every manageable load" : s.managedLabels.join(" + ");
      const fit = typeof s.fitsAirCooled === "boolean"
        ? (s.fitsAirCooled ? "; within air-cooled equipment" : "; exceeds air-cooled equipment")
        : "";
      bullet(
        `Manage ${what}: generator carries ${s.requiredKW} kW (${s.requiredAmps} A) — ` +
        `${s.reductionKW} kW less than the full calculated load${fit}`,
        BRAND.muted,
      );
    }
    bullet(
      "A load not listed reduces nothing on its own — another load governs its Article 220 category " +
      "(for example, an air conditioner smaller than the heat pump in the heating-vs-cooling selection)",
      BRAND.muted,
    );
  }

  // ── Option 3 — interlock ──
  sectionHead("Option 3 — Interlock / Manual Transfer");
  explain(
    "A mechanical interlock connects the generator through the existing panel; the operator selects " +
    "which circuits run at any time. Code assigns no minimum generator size for this arrangement. " +
    `Code basis: ${interlock.necBasis}.`,
  );
  bullet("Generator size and connected loads are selected manually");
  if (rec.partial !== null) {
    bullet(`Reference: the essential-loads selection below totals ${rec.partial.requiredKW} kW`);
  }

  // ── Essential loads — printed only when the tier produced a result ──
  if (rec.partial !== null) {
    sectionHead("Essential-Loads Selection");
    explain(
      "The loads below, summed at their calculated demand, define a reduced backup scope. " +
      "Loads not listed are not carried by this selection.",
    );
    bullet(`Required continuous output: ${rec.partial.requiredKW} kW (${rec.partial.requiredAmps} A)`);
    doc.moveDown(0.3);
    doc.fillColor(BRAND.text).fontSize(10).text("Included loads:");
    for (const line of rec.partial.covered) {
      bullet(`${line.label} — ${(line.va / 1000).toFixed(2)} kW (${line.rule})`, BRAND.muted);
    }
    doc.moveDown(0.3);
    doc.fillColor(BRAND.text).fontSize(10).text("Not included:");
    for (const line of rec.partial.notCovered) bullet(line, BRAND.muted);
    for (const line of rec.partial.excludedWithReason) bullet(line, BRAND.muted);
  }

  // ── Data notes — electrical scope statement, nothing else ──
  sectionHead("Data Notes");
  bullet("Generator selection, fuel type, and fuel supply are outside Red Cedar Electric's scope; this sheet provides the electrical requirements for that selection", BRAND.muted);
  bullet("Load figures per NEC 2017 Article 220; standby connection arrangements per NEC 2017 Article 702", BRAND.muted);
  doc.fillColor(BRAND.text);

  const pdfPath = await savePdf(doc, `generator-sizing-${docId}.pdf`);
  await prisma.document.create({
    data: {
      id: docId,
      jobId: inspection.visitId,
      propertyId: inspection.propertyId,
      type: "generator_sizing",
      pdfUrl: pdfPath,
    },
  });
  return { documentId: docId, pdfPath };
}

// ─── FINDING LEDGER DOCUMENTS ───────────────────────────────────────────────
//
// A Health Record documents what is wrong. These three document what happened
// next — corrected, upgraded, or refused. Without them the Record is a one-sided
// paper trail: it can prove the owner was told and never that they acted.

type LedgerFindingRow = {
  id: string;
  itemId: string;
  title: string;
  section: string | null;
  citationsJson: string;
  jurisdictionId: string;
  severity: string;
  findingText: string;
  openedAt: Date;
  openedInspectionId: string;
  cycle: number;
  resolutionMethod: string | null;
  resolvedAt: Date | null;
  resolvedByParty: string | null;
  resolvedByPartyName: string | null;
  resolutionDetail: string | null;
  verifiedPassAt: Date | null;
  verifiedPassInspectionId: string | null;
  declinedByName: string | null;
  declinedByRelation: string | null;
  declinedVerbatim: string | null;
  declinedAt: Date | null;
};

const PARTY_LABEL: Record<string, string> = {
  red_cedar: "Red Cedar Electric LLC",
  owner_self: "the property owner",
  third_party: "a third-party contractor",
};

const METHOD_LABEL: Record<string, string> = {
  corrected: "corrected",
  replaced: "replaced",
  upgraded: "upgraded",
  equipment_removed: "removed from service",
  verified_prior_repair: "verified as previously repaired",
};

const dateOnly = (value: Date | null) =>
  value ? value.toLocaleDateString("en-US", { timeZone: "America/Chicago" }) : "—";

/**
 * How we know the work was done — stated plainly, because a certificate is only
 * worth what its weakest verification is.
 *
 * "Verified by re-assessment" and "attested by the technician who did the work"
 * are different claims, and a document that presents them identically is lying
 * by omission the first time one of them is challenged.
 */
function verificationBasis(finding: LedgerFindingRow, photoCount: number): string {
  if (finding.verifiedPassAt) {
    return `Verified by re-assessment on ${dateOnly(finding.verifiedPassAt)}: this item was recorded as passing.`;
  }
  if (finding.resolvedByParty === "red_cedar") {
    return photoCount > 0
      ? `Verified by the correcting technician; ${photoCount} photograph(s) of the completed work are on file.`
      : "Verified by the correcting technician. No photographic record is on file for this item.";
  }
  return `Reported as complete by ${finding.resolvedByPartyName ?? PARTY_LABEL[finding.resolvedByParty ?? ""] ?? "others"} and accepted on that basis. Red Cedar Electric did not perform or re-assess this work.`;
}

interface CertificateInput {
  propertyId: string;
  findingIds: string[];
  attestedBy: string;
  /** Present when Red Cedar did the work — links the certificate to the job. */
  visitId?: string | null;
}

/**
 * A cure certificate — the defect track's close-out.
 *
 * Covers many findings at once because that's how remediation actually happens:
 * one visit, several items. Only findings that reached `corrected` are eligible;
 * anything still open, declined or superseded is refused rather than quietly
 * dropped, because a certificate that silently omits an item is exactly the
 * document a plaintiff wants.
 */
export async function generateCureCertificate(
  input: CertificateInput,
): Promise<{ documentId: string; pdfPath: string; findingIds: string[] }> {
  return generateLedgerCertificate(input, {
    track: "defect",
    eligibleStatus: "corrected",
    docType: "cure_certificate",
    title: "Certificate of Correction",
    filePrefix: "cure-certificate",
    intro:
      "This certifies that the electrical conditions listed below, documented in an Electrical Health Record for this property, have been corrected. Each item is reproduced with the citation under which it was documented.",
    itemHeading: "Correction",
  });
}

/**
 * The upgrade track's equivalent.
 *
 * Deliberately different language: nothing here was a violation. It records that
 * better equipment was installed, which is a sales record and a service history
 * — not a remediation, and it must never read like one.
 */
export async function generateUpgradeRecord(
  input: CertificateInput,
): Promise<{ documentId: string; pdfPath: string; findingIds: string[] }> {
  return generateLedgerCertificate(input, {
    track: "upgrade",
    eligibleStatus: "upgraded",
    docType: "upgrade_record",
    title: "Record of Upgrade",
    filePrefix: "upgrade-record",
    intro:
      "This records the equipment upgrades and planned replacements completed at this property. The items below were documented as wear, end-of-service-life, or installations below Red Cedar's enhanced standard — none was a code violation.",
    itemHeading: "Work performed",
  });
}

async function generateLedgerCertificate(
  input: CertificateInput,
  spec: {
    track: "defect" | "upgrade";
    eligibleStatus: string;
    docType: string;
    title: string;
    filePrefix: string;
    intro: string;
    itemHeading: string;
  },
): Promise<{ documentId: string; pdfPath: string; findingIds: string[] }> {
  const [profile, property, findings] = await Promise.all([
    getCompanyProfile(),
    prisma.property.findUnique({
      where: { id: input.propertyId },
      include: { customer: { select: { name: true } } },
    }),
    prisma.propertyFinding.findMany({
      where: { id: { in: input.findingIds }, propertyId: input.propertyId },
      orderBy: { openedAt: "asc" },
    }),
  ]);

  if (!property) throw new Error(`Property ${input.propertyId} not found`);
  if (findings.length === 0) throw new Error("No findings supplied for this certificate");

  const ineligible = findings.filter((f) => f.status !== spec.eligibleStatus || f.track !== spec.track);
  if (ineligible.length > 0) {
    throw new Error(
      `Cannot certify ${ineligible.map((f) => `${f.itemId} (${f.track}/${f.status})`).join(", ")} — ` +
      `only ${spec.track}-track findings at status "${spec.eligibleStatus}" may appear on this document`,
    );
  }
  const missing = input.findingIds.filter((id) => !findings.some((f) => f.id === id));
  if (missing.length > 0) {
    throw new Error(`Findings not found at this property: ${missing.join(", ")}`);
  }

  // Photo counts back the "verified by the correcting technician" claim.
  const photoCounts = new Map<string, number>();
  for (const finding of findings) {
    const count = await prisma.inspectionPhoto.count({
      where: { inspectionId: finding.openedInspectionId },
    });
    photoCounts.set(finding.id, count);
  }

  const docId = uuidv4();
  const certificateNo = `RCE-${spec.track === "defect" ? "CC" : "UR"}-${docId.slice(0, 8).toUpperCase()}`;
  const doc = new PDFDocument({ margin: 36 });
  addHeader(doc, spec.title, profile);

  const address = [property.addressLine1, property.addressLine2, property.city, property.state, property.postalCode]
    .filter(Boolean)
    .join(", ");

  doc.fontSize(10).fillColor(BRAND.text);
  doc.text(`Certificate no. ${certificateNo}`);
  doc.text(`Issued ${dateOnly(new Date())}`);
  doc.text(`Property: ${address}`);
  doc.text(`Account: ${property.customer.name}`);
  doc.moveDown(0.7);

  doc.fontSize(10).fillColor(BRAND.muted).text(spec.intro, { align: "left" });
  doc.moveDown(0.8);

  findings.forEach((finding, index) => {
    const citations = findingCitations(finding);
    doc.fillColor(BRAND.cedar).fontSize(11).text(`${index + 1}. ${finding.itemId} — ${finding.title}`);
    doc.fillColor(BRAND.text).fontSize(9);
    if (citations.length > 0) {
      doc.fillColor(BRAND.muted).text(citations.join(" · "));
    } else {
      doc.fillColor(BRAND.muted).text(
        "Citations unavailable — this finding predates the citation record.",
      );
    }
    doc.fillColor(BRAND.text);
    doc.moveDown(0.2);
    doc.text(`Documented ${dateOnly(finding.openedAt)} under the ${finding.jurisdictionId} code edition then in effect${finding.cycle > 1 ? ` (occurrence ${finding.cycle} at this location)` : ""}.`);
    doc.text(`As found: ${finding.findingText}`);
    doc.moveDown(0.2);
    doc.fillColor(BRAND.cedar).text(
      `${spec.itemHeading}: ${METHOD_LABEL[finding.resolutionMethod ?? ""] ?? finding.resolutionMethod ?? "completed"} ` +
      `on ${dateOnly(finding.resolvedAt)} by ${finding.resolvedByPartyName ?? PARTY_LABEL[finding.resolvedByParty ?? ""] ?? "others"}.`,
    );
    doc.fillColor(BRAND.text);
    if (finding.resolutionDetail) doc.text(finding.resolutionDetail);
    doc.fillColor(BRAND.muted).text(verificationBasis(finding, photoCounts.get(finding.id) ?? 0));
    doc.fillColor(BRAND.text);
    doc.moveDown(0.6);
  });

  // ── Scope limitation ──
  // Without this the certificate reads as a whole-house warranty, which converts
  // a defence into a new liability. It is not boilerplate; it is the point.
  doc.moveDown(0.3);
  doc.fillColor(BRAND.cedar).fontSize(10).text("Scope and limitations");
  doc.fillColor(BRAND.muted).fontSize(8.5).text(
    `This document certifies only the specific items listed above, as observed on the dates stated. ` +
    `It is not a warranty, a guarantee of future condition, or a statement that any other part of this ` +
    `electrical system is free of defects. Conditions concealed by finishes, equipment not accessible ` +
    `on the day of assessment, and anything outside the scope of the originating Electrical Health Record ` +
    `were not evaluated. Electrical systems change with use, alteration, and age; this certificate ` +
    `speaks only to the date it was issued.`,
    { align: "left" },
  );
  doc.moveDown(0.7);

  doc.fillColor(BRAND.cedar).fontSize(10).text("Contractor attestation");
  doc.fillColor(BRAND.text).fontSize(9).text(
    `I attest that the work described above was completed or verified as described, and that this record ` +
    `is accurate to the best of my knowledge.`,
  );
  doc.moveDown(0.4);
  doc.text(input.attestedBy);
  doc.fillColor(BRAND.muted).text(`${profile.legalName} — ${licenseLine(profile)}`);
  doc.fillColor(BRAND.text);

  addFooter(doc);
  const pdfPath = await savePdf(doc, `${spec.filePrefix}-${docId}.pdf`);

  await prisma.document.create({
    data: {
      id: docId,
      // Property-scoped, not job-scoped: a third-party repair has no Red Cedar
      // visit, and this document belongs to the address either way.
      jobId: input.visitId ?? null,
      propertyId: input.propertyId,
      type: spec.docType,
      pdfUrl: pdfPath,
    },
  });

  await prisma.propertyFinding.updateMany({
    where: { id: { in: findings.map((f) => f.id) } },
    data: { certificateDocId: docId },
  });

  return { documentId: docId, pdfPath, findingIds: findings.map((f) => f.id) };
}

/**
 * A declination letter — the customer's refusal, in their own words, for them
 * to sign.
 *
 * This is the one ledger document the customer signs. The certificates are the
 * contractor's own statement; a declination is the owner's, and it is only worth
 * anything with their name on it. Signing rides the existing public
 * /sign/:documentId page, so it uses Document.signedAt/signedByName/signedByIp —
 * SignatureRecord is keyed to an estimate and cannot hold this.
 */
export async function generateFindingDeclination(input: {
  propertyId: string;
  findingIds: string[];
  preparedBy: string;
}): Promise<{ documentId: string; pdfPath: string }> {
  const [profile, property, findings] = await Promise.all([
    getCompanyProfile(),
    prisma.property.findUnique({
      where: { id: input.propertyId },
      include: { customer: { select: { name: true } } },
    }),
    prisma.propertyFinding.findMany({
      where: { id: { in: input.findingIds }, propertyId: input.propertyId, status: "declined" },
      orderBy: { openedAt: "asc" },
    }),
  ]);

  if (!property) throw new Error(`Property ${input.propertyId} not found`);
  if (findings.length === 0) throw new Error("No declined findings supplied");

  const docId = uuidv4();
  const doc = new PDFDocument({ margin: 36 });
  addHeader(doc, "Acknowledgment of Declined Work", profile);

  const address = [property.addressLine1, property.addressLine2, property.city, property.state, property.postalCode]
    .filter(Boolean)
    .join(", ");

  doc.fontSize(10).fillColor(BRAND.text);
  doc.text(`Property: ${address}`);
  doc.text(`Account: ${property.customer.name}`);
  doc.text(`Prepared ${dateOnly(new Date())} by ${input.preparedBy}`);
  doc.moveDown(0.7);

  doc.fillColor(BRAND.muted).fontSize(10).text(
    "The conditions below were identified and explained at this property, and the recommended work was " +
    "declined. This document records that decision. It is not a criticism — it is a record that the " +
    "information was provided, so that everyone involved knows where things stand.",
  );
  doc.moveDown(0.8);

  findings.forEach((finding, index) => {
    const citations = findingCitations(finding);
    doc.fillColor(BRAND.cedar).fontSize(11).text(`${index + 1}. ${finding.itemId} — ${finding.title}`);
    doc.fillColor(BRAND.muted).fontSize(9).text(
      citations.length > 0 ? citations.join(" · ") : "Citations unavailable — this finding predates the citation record.",
    );
    doc.fillColor(BRAND.text).fontSize(9);
    doc.text(`Documented ${dateOnly(finding.openedAt)}. As found: ${finding.findingText}`);
    if (finding.declinedVerbatim) {
      doc.moveDown(0.2);
      doc.text(
        `Declined ${dateOnly(finding.declinedAt)} by ${finding.declinedByName ?? "the customer"}` +
        `${finding.declinedByRelation ? ` (${finding.declinedByRelation.replace(/_/g, " ")})` : ""}: ` +
        `"${finding.declinedVerbatim}"`,
      );
    }
    doc.moveDown(0.6);
  });

  doc.moveDown(0.3);
  doc.fillColor(BRAND.cedar).fontSize(10).text("Acknowledgment");
  doc.fillColor(BRAND.text).fontSize(9).text(
    "By signing, I confirm that the conditions above were explained to me and that I have chosen not to " +
    "have the recommended work performed at this time. I understand these conditions remain present and " +
    "may worsen. This acknowledgment can be withdrawn at any time by asking Red Cedar Electric to proceed.",
  );
  doc.moveDown(1.2);
  doc.text("Signature: ______________________________     Date: ______________");
  doc.moveDown(0.4);
  doc.text("Print name: ____________________________     Capacity (owner / tenant / manager): ____________");
  doc.moveDown(0.8);
  doc.fillColor(BRAND.muted).fontSize(8).text(`${profile.legalName} — ${licenseLine(profile)}`);
  doc.fillColor(BRAND.text);

  addFooter(doc);
  const pdfPath = await savePdf(doc, `finding-declination-${docId}.pdf`);

  await prisma.document.create({
    data: { id: docId, jobId: null, propertyId: input.propertyId, type: "finding_declination", pdfUrl: pdfPath },
  });
  await prisma.propertyFinding.updateMany({
    where: { id: { in: findings.map((f) => f.id) } },
    data: { declinationDocId: docId },
  });

  return { documentId: docId, pdfPath };
}

/** Append a signed audit trail to an existing document */
export async function markDocumentSigned(
  documentId: string,
  signerName: string,
  signerIp: string,
): Promise<void> {
  await prisma.document.update({
    where: { id: documentId },
    data: {
      signedAt: new Date(),
      signedByName: signerName,
      signedByIp: signerIp,
    },
  });
}
