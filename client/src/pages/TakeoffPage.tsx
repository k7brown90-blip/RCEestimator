import { PageHeader } from "../components/PageHeader";

export function TakeoffPage() {
  return (
    <div>
      <PageHeader title="Takeoff" subtitle="Phase 2 placeholder" />
      <section className="card p-6">
        <h2 className="text-lg font-semibold">Plan Upload and Takeoff</h2>
        <p className="mt-2 text-sm text-rce-muted">
          Blueprint upload, calibration, and takeoff workflows are intentionally stubbed in Phase 1. This route is visible to preserve information architecture.
        </p>
      </section>
    </div>
  );
}
