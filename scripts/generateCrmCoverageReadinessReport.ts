import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

const OUTPUT_DIR = path.join(process.cwd(), "generated", "reports");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "CRM-Coverage-and-Professional-Readiness-Report-2026-07-19.pdf");
const LOGO_PATH = path.join(process.cwd(), "public", "logo.png");

const BRAND = {
  cedar: "#1e2d12",
  copper: "#c49818",
  text: "#1a1a0e",
  muted: "#5a5838",
  soft: "#7a7756",
};

const crmCoverageSections: Array<{ title: string; bullets: string[] }> = [
  {
    title: "1) Lead Intake and Capture",
    bullets: [
      "Public lead intake is implemented from web forms and webhook channels.",
      "Core lead records include contact details, source, job type, notes, and follow-up metadata.",
      "Lead conversion path exists to create customer, property, and visit records from qualified leads.",
    ],
  },
  {
    title: "2) Lead Pipeline and Follow-up Operations",
    bullets: [
      "Lead pipeline uses explicit statuses (new, booked, unresolved, planning, no_answer, won, lost).",
      "Follow-up analytics are available, including overdue, due today, due next 7 days, and no-follow-up counts.",
      "Dashboard supports direct overdue-lead actions (mark contacted, snooze, mark won, mark lost).",
    ],
  },
  {
    title: "3) CRM Analytics Dashboard",
    bullets: [
      "Overview endpoint aggregates funnel, follow-up, win/loss, and cycle-time metrics.",
      "Date-range analytics are implemented for funnel, win/loss, and cycle-time performance.",
      "Dashboard refresh and mutation invalidation are in place to keep KPI views current after user actions.",
    ],
  },
  {
    title: "4) Customer, Property, and Visit Records",
    bullets: [
      "Customer and property entities are first-class with nested visit history and context.",
      "Visit workspace supports observations, findings, recommendations, and structured estimating workflows.",
      "System snapshot and visit artifacts support field-to-office continuity.",
    ],
  },
  {
    title: "5) Estimating and Proposal Workflow",
    bullets: [
      "Estimate lifecycle states are implemented from draft through sent/accepted/declined/expired/revised.",
      "Atomic-unit estimate model supports options, modifiers, support-item generation, and validation checks.",
      "Proposal PDF generation and delivery records are implemented.",
    ],
  },
  {
    title: "6) Scheduling and Calendar Coordination",
    bullets: [
      "CRM schedule endpoints expose week and month views plus availability checks.",
      "Job scheduling services include schedule, reschedule, and cancel logic with conflict handling.",
      "Google Calendar integration is active for availability and event lifecycle operations.",
    ],
  },
  {
    title: "7) Documents, Signature, and Job Packets",
    bullets: [
      "Server-side PDF generation is implemented for contracts, change orders, work orders, and material lists.",
      "Proposal signature and acceptance workflows are present in the estimate lifecycle.",
      "Document persistence and retrieval patterns are built into the backend stack.",
    ],
  },
  {
    title: "8) Notifications and Communications",
    bullets: [
      "Email and SMS integration points exist for confirmations, updates, and operational notifications.",
      "Customer communication preferences and best-time-to-reach fields are supported in lead data.",
      "Inbound/outbound communication hooks are wired for operational automation paths.",
    ],
  },
  {
    title: "9) Access Control and Runtime Security",
    bullets: [
      "PIN login with JWT sessions protects CRM operations.",
      "MCP endpoint uses dedicated bearer token authorization.",
      "Public endpoint exemptions are explicitly handled in middleware for expected external workflows.",
    ],
  },
];

const readinessTodo: Array<{ priority: string; item: string; outcome: string }> = [
  {
    priority: "Critical",
    item: "Harden production auth mode to prevent accidental dev bypass.",
    outcome: "Ensure startup fails when PIN_HASH or JWT_SECRET is missing in production and rotate secrets on schedule.",
  },
  {
    priority: "Critical",
    item: "Apply least-privilege CORS and endpoint exposure policy.",
    outcome: "Restrict origins and methods for sensitive routes; verify all public routes are intentionally public.",
  },
  {
    priority: "Critical",
    item: "Introduce role-based access and user attribution.",
    outcome: "Support owner/admin/estimator permissions and record who changed lead statuses, estimates, and schedule events.",
  },
  {
    priority: "Critical",
    item: "Set up automated backups and restore drills for SQLite volume.",
    outcome: "Meet recovery point and recovery time targets with documented restore procedure and monthly drill evidence.",
  },
  {
    priority: "High",
    item: "Build CRM acceptance test suite for core revenue workflows.",
    outcome: "Automated tests for lead intake, conversion, estimate lifecycle, proposal send/sign, and scheduling conflict behavior.",
  },
  {
    priority: "High",
    item: "Add operational observability.",
    outcome: "Centralized logs, request tracing, error alerts, and uptime monitoring with on-call notification thresholds.",
  },
  {
    priority: "High",
    item: "Define data governance and retention standards.",
    outcome: "PII policy, retention windows, export/delete process, and audit-ready handling for customer communication records.",
  },
  {
    priority: "High",
    item: "Formalize migration and release safety process.",
    outcome: "Staging validation checklist, migration rollback strategy, and release gates for schema and API changes.",
  },
  {
    priority: "High",
    item: "Complete end-to-end website-to-CRM reliability checks.",
    outcome: "Verify web contact submissions, fallback handling, deduplication, and SLA for lead assignment/follow-up creation.",
  },
  {
    priority: "Medium",
    item: "Create a frontline operating playbook.",
    outcome: "Standard operating procedures for lead triage, follow-up cadence, quote turnaround, and lost-reason coding consistency.",
  },
  {
    priority: "Medium",
    item: "Define KPI scorecard and monthly review cadence.",
    outcome: "Targets for win rate, aging pipeline, follow-up compliance, close cycle time, and conversion throughput.",
  },
  {
    priority: "Medium",
    item: "Add data quality controls for lead and job records.",
    outcome: "Validation for required fields, normalization for phone/address, and duplicate lead detection workflows.",
  },
  {
    priority: "Medium",
    item: "Create training and sign-off flow before production rollout.",
    outcome: "Role-specific onboarding plus competency check for dashboard actions and estimate/proposal workflow.",
  },
  {
    priority: "Medium",
    item: "Document third-party dependency continuity plans.",
    outcome: "Operational fallback plans for Google Calendar, email provider, SMS provider, and AI workflow outages.",
  },
];

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function addHeader(doc: PDFKit.PDFDocument) {
  const pageWidth = doc.page.width;
  const margin = 42;

  if (fs.existsSync(LOGO_PATH)) {
    const logoSize = 66;
    doc.image(LOGO_PATH, (pageWidth - logoSize) / 2, margin, { width: logoSize, height: logoSize });
    doc.y = margin + logoSize + 8;
  }

  doc.fillColor(BRAND.cedar).fontSize(18).text("Red Cedar Electric LLC", { align: "center" });
  doc.fillColor(BRAND.muted).fontSize(9).text("CRM Coverage and Professional Readiness Report", { align: "center" });
  doc.text("Assessment Date: 2026-07-19", { align: "center" });
  doc.moveDown(0.5);

  const y = doc.y;
  doc.moveTo(margin, y).lineTo(pageWidth - margin, y).lineWidth(1.3).stroke(BRAND.copper);
  doc.moveDown(0.8);
}

function addFooter(doc: PDFKit.PDFDocument) {
  const footerText = "Generated for internal planning. Validate final operational controls before go-live.";
  const x = 42;
  const y = doc.page.height - 34;

  doc.save();
  doc.fontSize(8).fillColor(BRAND.soft).text(footerText, x, y, {
    width: doc.page.width - x * 2,
    align: "center",
  });
  doc.restore();
}

function addSectionTitle(doc: PDFKit.PDFDocument, title: string) {
  doc.moveDown(0.25);
  doc.fillColor(BRAND.cedar).fontSize(12).text(title);
  doc.moveDown(0.2);
}

function addBullets(doc: PDFKit.PDFDocument, bullets: string[]) {
  doc.fillColor(BRAND.text).fontSize(10);
  for (const bullet of bullets) {
    doc.text("- " + bullet, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: "left",
    });
    doc.moveDown(0.1);
  }
}

function addReadinessTable(doc: PDFKit.PDFDocument) {
  addSectionTitle(doc, "Professional Readiness To-Do List");
  doc.fillColor(BRAND.text).fontSize(10);

  for (const row of readinessTodo) {
    doc.font("Helvetica-Bold").text("Priority: " + row.priority);
    doc.font("Helvetica").text("Action: " + row.item);
    doc.fillColor(BRAND.muted).text("Outcome: " + row.outcome);
    doc.fillColor(BRAND.text);
    doc.moveDown(0.5);

    if (doc.y > doc.page.height - 90) {
      addFooter(doc);
      doc.addPage();
      addHeader(doc);
      addSectionTitle(doc, "Professional Readiness To-Do List (continued)");
    }
  }
}

function addExecutiveSummary(doc: PDFKit.PDFDocument) {
  addSectionTitle(doc, "Executive Summary");
  doc.fillColor(BRAND.text).fontSize(10).text(
    "The CRM foundation is strong and already supports lead intake, pipeline analytics, estimating, proposal generation, scheduling, and document workflows. The immediate path to professional readiness is operational hardening: production-grade security controls, backup and recovery discipline, end-to-end testing, and clear SOPs for daily use.",
    { align: "left" },
  );
  doc.moveDown(0.6);
}

function createReport() {
  ensureOutputDir();

  const doc = new PDFDocument({
    size: "LETTER",
    margin: 42,
    info: {
      Title: "CRM Coverage and Professional Readiness Report",
      Author: "Red Cedar Electric LLC",
      Subject: "CRM coverage assessment and production readiness plan",
    },
  });

  const stream = fs.createWriteStream(OUTPUT_FILE);
  doc.pipe(stream);

  addHeader(doc);
  addExecutiveSummary(doc);

  addSectionTitle(doc, "Current CRM Coverage");
  crmCoverageSections.forEach((section) => {
    if (doc.y > doc.page.height - 120) {
      addFooter(doc);
      doc.addPage();
      addHeader(doc);
      addSectionTitle(doc, "Current CRM Coverage (continued)");
    }
    addSectionTitle(doc, section.title);
    addBullets(doc, section.bullets);
    doc.moveDown(0.2);
  });

  if (doc.y > doc.page.height - 180) {
    addFooter(doc);
    doc.addPage();
    addHeader(doc);
  }

  addReadinessTable(doc);

  addSectionTitle(doc, "Recommended Launch Gate");
  addBullets(doc, [
    "Do not call the CRM professionally ready until all Critical items and at least 80% of High items are completed and verified.",
    "Run a 14-day pilot with real lead flow and track incidents, follow-up compliance, and quote-to-win behavior.",
    "After pilot completion, hold a go-live review and publish final SOP and rollback plan.",
  ]);

  addFooter(doc);
  doc.end();

  return new Promise<string>((resolve, reject) => {
    stream.on("finish", () => resolve(OUTPUT_FILE));
    stream.on("error", reject);
  });
}

createReport()
  .then((filePath) => {
    process.stdout.write(filePath + "\n");
  })
  .catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exit(1);
  });
