/**
 * PDF generation service — contracts, change orders, work orders, material lists.
 * Uses pdfkit (already a dependency). Stores files locally in generated/ directory.
 */

import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../lib/prisma";
import { v4 as uuidv4 } from "uuid";

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

function addHeader(doc: PDFKit.PDFDocument, title: string) {
  const pageWidth = doc.page.width;
  const margin = 36;

  // Logo — centered at top
  if (fs.existsSync(LOGO_PATH)) {
    const logoSize = 72;
    doc.image(LOGO_PATH, (pageWidth - logoSize) / 2, margin, { width: logoSize, height: logoSize });
    doc.y = margin + logoSize + 8;
  }

  doc.fillColor(BRAND.cedar).fontSize(18).text("Red Cedar Electric LLC", { align: "center" });
  doc.fillColor(BRAND.muted).fontSize(9).text("Licensed & Insured · Serving Middle Tennessee", { align: "center" });
  doc.text("(615) 857-6389 · service@redcedarelectricllc.com", { align: "center" });
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

function scoreBand(score: number, hasCritical: boolean): string {
  if (hasCritical) return score < 60 ? "Priority" : "Needs attention";
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good / Serviceable";
  if (score >= 60) return "Needs attention";
  return "Priority";
}

const RESULT_LABEL: Record<string, string> = {
  PASS: "Pass",
  MONITOR: "Monitor",
  ACTION: "Action required",
  BELOW_STANDARD: "Meets code — below Red Cedar standard",
  NA: "Not applicable (logged)",
};

/**
 * Render a synced field inspection into the customer's document chain, so the
 * health report lives alongside contracts and proposals with one delivery path.
 */
export async function generateHealthReport(
  inspectionId: string,
): Promise<{ documentId: string; pdfPath: string }> {
  const inspection = await prisma.healthInspection.findUnique({
    where: { id: inspectionId },
    include: {
      customer: { select: { name: true } },
      property: { select: { addressLine1: true, city: true, state: true, postalCode: true } },
      technician: { select: { name: true } },
      photos: { select: { id: true } },
    },
  });
  if (!inspection) throw new Error(`Inspection ${inspectionId} not found`);

  const items = JSON.parse(inspection.itemsJson) as Array<{
    itemId: string;
    result: string;
    gradedState?: string;
    note?: string;
    photoIds: string[];
  }>;
  const criticals = JSON.parse(inspection.criticalFindingsJson) as string[];
  const loadCalc = inspection.loadCalcJson
    ? (JSON.parse(inspection.loadCalcJson) as {
        result?: { governingAmps?: number; serviceAmps?: number; loadPct?: number; spareAmps?: number; methodUsed?: string };
      }).result ?? null
    : null;

  const docId = uuidv4();
  const doc = new PDFDocument({ margin: 36 });

  addHeader(doc, "Electrical Health Record");

  const dateStr = inspection.inspectionDate.toLocaleDateString("en-US", { timeZone: "America/Chicago" });
  doc.fontSize(11).fillColor(BRAND.text);
  doc.text(`Customer: ${inspection.customer.name}`);
  doc.text(`Property: ${inspection.property.addressLine1}, ${inspection.property.city}, ${inspection.property.state} ${inspection.property.postalCode}`);
  doc.text(`Inspected: ${dateStr}${inspection.technician ? ` by ${inspection.technician.name}` : ""} · Jurisdiction: ${inspection.jurisdictionId}`);
  doc.moveDown();

  // Headline score + band
  doc.fillColor(BRAND.cedar).fontSize(22).text(
    `Health Score: ${inspection.score}  —  ${scoreBand(inspection.score, criticals.length > 0)}`,
  );
  doc.fillColor(BRAND.muted).fontSize(9).text(`${inspection.itemsAssessed} items assessed`);
  doc.moveDown(0.5);

  if (criticals.length > 0) {
    doc.fillColor("#b91c1c").fontSize(12).text(
      `CRITICAL FINDING${criticals.length > 1 ? "S" : ""}: ${criticals.join(", ")} — headline score capped at 69 until resolved.`,
    );
    doc.fillColor(BRAND.text);
    doc.moveDown(0.5);
  }

  if (loadCalc?.governingAmps !== undefined) {
    doc.fillColor(BRAND.cedar).fontSize(12).text("Electrical Capacity (NEC Article 220)", { underline: true });
    doc.fillColor(BRAND.text).fontSize(10).text(
      `Calculated load ${loadCalc.governingAmps} A on a ${loadCalc.serviceAmps} A service — ` +
      `${loadCalc.loadPct}% used, ${loadCalc.spareAmps} A spare (code basis 230.42; method: ${loadCalc.methodUsed ?? "optional"}).`,
    );
    doc.moveDown();
  }

  doc.fillColor(BRAND.cedar).fontSize(12).text("Findings by Item", { underline: true });
  doc.fillColor(BRAND.text).fontSize(9);
  for (const item of items) {
    const grade = item.gradedState ? ` (${item.gradedState})` : "";
    const critical = criticals.includes(item.itemId) ? "  ⚠ CRITICAL" : "";
    doc.text(`${item.itemId}: ${RESULT_LABEL[item.result] ?? item.result}${grade}${critical}${item.note ? ` — ${item.note}` : ""}`);
  }
  doc.moveDown();

  doc.fillColor(BRAND.muted).fontSize(8).text(
    `Photo evidence on file: ${inspection.photos.length} image(s). ` +
    `Contractor review: ${inspection.contractorReviewed ? `completed${inspection.reviewedBy ? ` by ${inspection.reviewedBy}` : ""}` : "pending"}.`,
  );
  doc.moveDown(0.5);
  doc.fillColor(BRAND.muted).fontSize(8).text(
    "This score reflects severity, likelihood, and how hidden each issue is — weighted from national fire/shock data, not our opinion.",
  );

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
