/**
 * Prints which calendars in the availability union are currently unreachable
 * (Google's freebusy silently omits calendars it can't read) - reads via the
 * exact function Savannah's check-availability endpoint calls.
 *
 * Usage: railway ssh -- npx tsx scripts/checkUnreachableCalendars.ts
 */
import { getAvailability } from "../src/services/googleCalendar";
import { companyCalendarIds } from "../src/services/techCalendars";
import { prisma } from "../src/lib/prisma";

async function main() {
  const allIds = await companyCalendarIds();
  console.log(`Company calendar set (${allIds.length}):`, allIds.join(", "));

  const availability = await getAvailability();
  if (availability.unreachable_calendars.length === 0) {
    console.log("\nAll calendars currently reachable.");
    return;
  }

  console.log(`\n${availability.unreachable_calendars.length} unreachable calendar(s):`);
  for (const id of availability.unreachable_calendars) {
    const tech = await prisma.technician.findFirst({ where: { email: id }, select: { name: true, calendarShared: true, isActive: true } });
    console.log(`  ${id}${tech ? ` -- technician "${tech.name}" (calendarShared=${tech.calendarShared}, isActive=${tech.isActive})` : " -- not a technician row (EXTRA_CALENDAR_IDS or primary)"}`);
  }
}

main().finally(() => prisma.$disconnect());
