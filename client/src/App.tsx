import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { AccountDetailPage } from "./pages/AccountDetailPage";
import { AccountsPage } from "./pages/AccountsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { LeadsPage } from "./pages/LeadsPage";
import { LeadFormPage } from "./pages/LeadFormPage";
import { PinLoginPage } from "./pages/PinLoginPage";
import { PropertyDetailPage } from "./pages/PropertyDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TeamPage } from "./pages/TeamPage";
import { PriceBookIntakePage } from "./pages/PriceBookIntakePage";
import { EstimatesPage } from "./pages/EstimatesPage";
import { VisitWorkspacePage } from "./pages/VisitWorkspacePage";
import { SigningModePage } from "./pages/SigningModePage";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const token = localStorage.getItem("rce_token");
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}

/** Customers were renamed to Accounts; keep old links and bookmarks working. */
function RedirectCustomerToAccount() {
  const { customerId } = useParams();
  return <Navigate to={`/accounts/${customerId}`} replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<PinLoginPage />} />
      <Route
        path="*"
        element={
          <RequireAuth>
            <AppShell>
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/jobs" element={<JobsPage />} />
                <Route path="/calendar" element={<CalendarPage />} />
                <Route path="/leads" element={<LeadsPage />} />
                <Route path="/leads/new" element={<LeadFormPage />} />
                <Route path="/leads/:leadId/edit" element={<LeadFormPage />} />
                <Route path="/accounts" element={<AccountsPage />} />
                <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
                <Route path="/customers" element={<Navigate to="/accounts" replace />} />
                <Route path="/customers/:customerId" element={<RedirectCustomerToAccount />} />
                <Route path="/properties/:propertyId" element={<PropertyDetailPage />} />
                <Route path="/visits/:visitId" element={<VisitWorkspacePage />} />
                <Route path="/estimates" element={<EstimatesPage />} />
                {/* Still routable — reached from an account or a visit, never from the nav.
                    The full-move ruling removed the standalone ENTRY POINT, not the screen. */}
                <Route path="/estimate-intake" element={<PriceBookIntakePage />} />
                {/* In-person signing: a full-screen view inside the operator session.
                    No device lock — Kyle vetoed it 2026-08-18. */}
                <Route path="/sign-in-person/:estimateId" element={<SigningModePage />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </AppShell>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export default App;
