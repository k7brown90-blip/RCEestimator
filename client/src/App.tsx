import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { CustomerDetailPage } from "./pages/CustomerDetailPage";
import { CustomersPage } from "./pages/CustomersPage";
import { JobsPage } from "./pages/JobsPage";
import { LeadsPage } from "./pages/LeadsPage";
import { PinLoginPage } from "./pages/PinLoginPage";
import { PropertyDetailPage } from "./pages/PropertyDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { VisitWorkspacePage } from "./pages/VisitWorkspacePage";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const token = localStorage.getItem("rce_token");
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
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
                <Route path="/" element={<Navigate to="/jobs" replace />} />
                <Route path="/jobs" element={<JobsPage />} />
                <Route path="/leads" element={<LeadsPage />} />
                <Route path="/customers" element={<CustomersPage />} />
                <Route path="/customers/:customerId" element={<CustomerDetailPage />} />
                <Route path="/properties/:propertyId" element={<PropertyDetailPage />} />
                <Route path="/visits/:visitId" element={<VisitWorkspacePage />} />
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
