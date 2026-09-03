/**
 * Export job photos out of production (Kyle, 2026-09-03: the marketing prompt
 * for claude.ai desktop "needs info on that job and access to the photos").
 *
 * Photos are Bytes in Postgres (Railway wipes the filesystem on deploy), so
 * the only road out is stdout. Listing is human-readable; export prints one
 * photo as base64 for the operator's terminal to decode into a local file.
 * Attach-only remains the rule — this hands bytes to KYLE's machine, never to
 * a model from inside the app (the P012 seam is untouched).
 *
 * Usage (against production):
 *   railway ssh "node dist/scripts/exportVisitPhotos.js --customer corcoran"
 *   railway ssh "node dist/scripts/exportVisitPhotos.js --visit <visitId>"
 *   railway ssh "node dist/scripts/exportVisitPhotos.js --photo <photoId>" > photo.b64
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const photoId = arg("photo");
  if (photoId) {
    const photo = await prisma.visitPhoto.findUnique({ where: { id: photoId } });
    if (!photo) {
      console.error(`Photo ${photoId} not found.`);
      process.exitCode = 1;
      return;
    }
    // Base64 to stdout, nothing else — the caller redirects to a file.
    process.stdout.write(Buffer.from(photo.data).toString("base64"));
    return;
  }

  const customer = arg("customer");
  const visitId = arg("visit");
  if (!customer && !visitId) {
    console.log("Pass --customer <name fragment>, --visit <visitId>, or --photo <photoId>.");
    return;
  }

  const visits = visitId
    ? await prisma.visit.findMany({
        where: { id: visitId },
        include: { customer: { select: { name: true } } },
      })
    : await prisma.visit.findMany({
        where: { customer: { name: { contains: customer!, mode: "insensitive" } } },
        include: { customer: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
      });

  for (const v of visits) {
    const photos = await prisma.visitPhoto.findMany({
      where: { visitId: v.id },
      orderBy: { uploadedAt: "asc" },
      select: { id: true, mimeType: true, sizeBytes: true, tag: true, caption: true, uploadedAt: true },
    });
    console.log(`Visit ${v.id} — ${v.customer.name} · "${v.purpose ?? ""}" · ${photos.length} photo(s)`);
    for (const p of photos) {
      console.log(
        `  ${p.id}  ${p.mimeType.padEnd(11)} ${(p.sizeBytes / 1024).toFixed(0).padStart(5)} KB  tag=${p.tag ?? "—"}  "${p.caption ?? ""}"`,
      );
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
