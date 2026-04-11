import { PageHeader } from "../components/PageHeader";

export function SettingsPage() {
  return (
    <div>
      <PageHeader title="Settings" subtitle="Company and account configuration shell" />
      <section className="card p-6">
        <p className="text-sm text-rce-muted">Phase 1 keeps settings intentionally minimal. Add company branding, email configuration, and account controls in later phases.</p>
      </section>
    </div>
  );
}
