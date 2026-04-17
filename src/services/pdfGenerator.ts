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

export async function generateContract(input: ContractInput): Promise<{ documentId: string; pdfPath: string }> {
  const docId = uuidv4();
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
