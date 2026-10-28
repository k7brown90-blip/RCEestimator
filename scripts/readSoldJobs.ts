/**
 * The numbers behind the hourly-rate decision (Kyle, 2026-10-27: "I want your opinion on what our
 * hourly rate should be to make a profit and keep us employed. Use previous sold jobs to make your
 * calculations"). Read-only: this script performs no writes.
 *
 * It prints what the CRM's Financials screen computes - the P&L and job profitability come from the
 * same functions its routes call (routes/financials.ts financialSummary / jobProfitability) - plus
 * what that screen does not put side by side: the labour hours each job was SOLD with (the frozen
 * IssuedEstimateLine.laborHours of its selected options, root and change orders) against the hours
 * the time clock RECORDED on it, and the shift hours clocked per month. No customer names.
 *
 * Usage (against production):
 *   railway ssh -s RCEestimator "node dist/scripts/readSoldJobs.js [--year 2026]"
 *
 *   --year N   one year only (default: last year and this year)
 */

import { prisma } from "../src/lib/prisma";
import { financialSummary, jobProfitability } from "../src/routes/financials";
import { getLaborRate } from "../src/services/jobCosting";
import { loadBilledLaborRate } from "../src/services/laborRate";
import { LIVE_SIGNED, LIVE_SIGNED_CHANGE_ORDER } from "../src/services/invoiceGroup";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
const hrs = (n: number) => `${n.toFixed(1)}h`;

const yearArg = process.argv.indexOf("--year");
const thisYear = new Date().getFullYear();
const YEARS = yearArg > 0 ? [Number(process.argv[yearArg + 1])] : [thisYear - 1, thisYear];

/** Labour hours each job was sold with: the selected options' frozen line hours, root + change orders. */
async function soldHoursByJob(): Promise<Map<string, number>> {
  const select = {
    id: true, jobVisitId: true, visitId: true, changeOrderForId: true, selectedOptions: true,
    lines: { select: { option: true, laborHours: true } },
  } as const;
  const [roots, changeOrders] = await Promise.all([
    prisma.issuedEstimate.findMany({ where: { ...LIVE_SIGNED, changeOrderForId: null }, select }),
    prisma.issuedEstimate.findMany({ where: { ...LIVE_SIGNED_CHANGE_ORDER, changeOrderForId: { not: null } }, select }),
  ]);
  const hoursOf = (row: (typeof roots)[number]) =>
    row.lines
      .filter((l) => row.selectedOptions.length === 0 || row.selectedOptions.includes(l.option))
      .reduce((s, l) => s + (l.laborHours ?? 0), 0);
  const jobOfRoot = new Map<string, string>();
  const out = new Map<string, number>();
  for (const r of roots) {
    const job = r.jobVisitId ?? r.visitId;
    if (!job) continue;
    jobOfRoot.set(r.id, job);
    out.set(job, (out.get(job) ?? 0) + hoursOf(r));
  }
  for (const co of changeOrders) {
    const job = jobOfRoot.get(co.changeOrderForId!);
    if (job) out.set(job, (out.get(job) ?? 0) + hoursOf(co));
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`Billed labour rate (Rate Config, what estimates charge): ${money(await loadBilledLaborRate(prisma))}/hr`);
  console.log(`Job-costing labour rate (company profile, what job profitability charges a job hour): ${money(await getLaborRate())}/hr`);
  const techs = await prisma.technician.findMany({
    select: { role: true, isActive: true, hourlyRate: true, commissionPercent: true, licenseHolder: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nTechnicians (${techs.length}):`);
  techs.forEach((t, i) =>
    console.log(`  T${i + 1}  ${t.role}${t.licenseHolder ? " (license holder)" : ""}  ${t.isActive ? "active" : "inactive"}  pay ${t.hourlyRate == null ? "not set" : money(t.hourlyRate) + "/hr"}  commission ${t.commissionPercent ?? 0}%`),
  );

  const sold = await soldHoursByJob();

  for (const year of YEARS) {
    const from = new Date(`${year}-01-01`);
    const to = new Date(`${year + 1}-01-01`);
    const summary = await financialSummary(year);
    console.log(`\n================ ${year} ================`);
    console.log(`P&L by month (invoiced = signed full bills; expenses include payroll, fees, cards, bills, bank):`);
    console.log(`  month   invoiced    collected   payroll     expenses    net`);
    for (const m of summary.months) {
      if (!m.invoiced && !m.collected && !m.expenses) continue;
      console.log(`  ${MONTHS[m.month]}     ${money(m.invoiced).padEnd(11)} ${money(m.collected).padEnd(11)} ${money(m.payroll).padEnd(11)} ${money(m.expenses).padEnd(11)} ${money(m.net)}`);
    }
    const t = summary.totals;
    console.log(`  TOTAL   ${money(t.invoiced).padEnd(11)} ${money(t.collected).padEnd(11)} ${money(t.payroll).padEnd(11)} ${money(t.expenses).padEnd(11)} ${money(t.net)}`);
    console.log(`Expenses by category:`);
    for (const c of summary.expensesByCategory) console.log(`  ${c.category.padEnd(28)} ${money(c.total)}`);
    console.log(`Caveats: unrated payroll hours ${summary.payrollUnratedHours}; unclassified bank lines ${summary.bank.unclassified} (${money(summary.bank.unclassifiedOut)} out, NOT in expenses); Stripe fees ${summary.feesAvailable ? "read" : "unavailable: " + summary.feesReason}`);

    // Shift hours (paid time) vs job hours (time on a job), by month and technician.
    const [shifts, entries] = await Promise.all([
      prisma.shiftEntry.findMany({
        where: { startedAt: { gte: from, lt: to }, endedAt: { not: null }, OR: [{ flaggedAt: null }, { confirmedAt: { not: null } }] },
        select: { technicianId: true, startedAt: true, minutes: true },
      }),
      prisma.timeEntry.findMany({
        where: { startedAt: { gte: from, lt: to }, endedAt: { not: null }, OR: [{ flaggedAt: null }, { confirmedAt: { not: null } }] },
        select: { startedAt: true, minutes: true },
      }),
    ]);
    const shiftByMonth = Array(12).fill(0) as number[];
    const jobByMonth = Array(12).fill(0) as number[];
    for (const s of shifts) shiftByMonth[s.startedAt.getMonth()] += (s.minutes ?? 0) / 60;
    for (const e of entries) jobByMonth[e.startedAt.getMonth()] += (e.minutes ?? 0) / 60;
    console.log(`Clocked hours by month (shift = paid time, job = time on a job):`);
    for (let m = 0; m < 12; m++) {
      if (!shiftByMonth[m] && !jobByMonth[m]) continue;
      console.log(`  ${MONTHS[m]}  shift ${hrs(shiftByMonth[m]).padEnd(8)} job ${hrs(jobByMonth[m])}`);
    }

    const jobs = await jobProfitability(year);
    console.log(`Sold jobs (${jobs.length}; completed ${jobs.filter((j) => j.status === "completed").length}):`);
    console.log(`  completed    type                 status       billed      material    processing  hrs sold  hrs rec   (billed-mat-proc)/hr rec`);
    let billed = 0, mat = 0, proc = 0, soldH = 0, recH = 0, n = 0;
    let firstDone: Date | null = null, lastDone: Date | null = null;
    for (const j of jobs) {
      const soldHours = sold.get(j.visitId) ?? 0;
      const processing = j.synchronyCut + j.cardFees;
      const perHour = j.quoted !== null && j.laborHours > 0 ? (j.quoted - j.materialSpend - processing) / j.laborHours : null;
      console.log(
        `  ${(j.completedAt ? j.completedAt.toISOString().slice(0, 10) : "open").padEnd(12)} ${String(j.jobType ?? "").padEnd(20)} ${j.status.padEnd(12)} ` +
        `${money(j.quoted).padEnd(11)} ${money(j.materialSpend).padEnd(11)} ${money(processing).padEnd(11)} ${hrs(soldHours).padEnd(9)} ${hrs(j.laborHours).padEnd(8)} ${money(perHour)}`,
      );
      if (j.status !== "completed" || j.quoted === null) continue;
      n += 1; billed += j.quoted; mat += j.materialSpend; proc += processing; soldH += soldHours; recH += j.laborHours;
      if (j.completedAt) {
        if (!firstDone || j.completedAt < firstDone) firstDone = j.completedAt;
        if (!lastDone || j.completedAt > lastDone) lastDone = j.completedAt;
      }
    }
    const weeks = firstDone && lastDone ? Math.max(1, (lastDone.getTime() - firstDone.getTime()) / (7 * 86400_000)) : 0;
    console.log(`COMPLETED, priced: ${n} jobs  billed ${money(billed)}  material ${money(mat)}  processing ${money(proc)}  hours sold ${hrs(soldH)}  hours recorded ${hrs(recH)}`);
    console.log(`  (billed - material - processing) per recorded hour: ${recH > 0 ? money((billed - mat - proc) / recH) : "—"}; per sold hour: ${soldH > 0 ? money((billed - mat - proc) / soldH) : "—"}`);
    console.log(`  span ${firstDone?.toISOString().slice(0, 10) ?? "—"} to ${lastDone?.toISOString().slice(0, 10) ?? "—"} (${weeks.toFixed(1)} weeks): ${weeks ? (n / weeks).toFixed(2) : "—"} jobs/week, ${weeks ? hrs(soldH / weeks) : "—"} sold/week, ${weeks ? money(billed / weeks) : "—"} billed/week`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
