import { prisma } from "../lib/prisma";
import { seedAssemblyTemplates } from "../../scripts/seedAssemblyTemplates";

let bootstrapPromise: Promise<void> | null = null;

export async function ensureAssemblyCatalogReady(): Promise<void> {
  const templateCount = await prisma.assemblyTemplate.count();
  if (templateCount > 0) {
    return;
  }

  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      // eslint-disable-next-line no-console
      console.log("Assembly catalog is empty. Seeding default templates...");
      await seedAssemblyTemplates(prisma);

      const seededCount = await prisma.assemblyTemplate.count();
      if (seededCount <= 0) {
        throw new Error("Assembly catalog seeding completed but no templates were created.");
      }

      // eslint-disable-next-line no-console
      console.log(`Assembly catalog ready with ${seededCount} templates.`);
    })()
      .finally(() => {
        bootstrapPromise = null;
      });
  }

  await bootstrapPromise;
}
