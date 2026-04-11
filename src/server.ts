import { app } from "./app";
import { ensureAssemblyCatalogReady } from "./bootstrap/ensureAssemblyCatalog";

const port = Number(process.env.PORT ?? 4000);

async function startServer(): Promise<void> {
  await ensureAssemblyCatalogReady();

  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Red Cedar Estimating API listening on ${port}`);
  });
}

startServer().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start Red Cedar Estimating API", error);
  process.exit(1);
});
