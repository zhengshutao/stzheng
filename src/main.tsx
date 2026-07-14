
  import { createRoot } from "react-dom/client";
  import { BrowserRouter, Routes, Route } from "react-router";
  import App from "./app/App.tsx";
  import LoginPage from "./app/pages/LoginPage.tsx";
  import DashboardPage from "./app/pages/DashboardPage.tsx";
  import StockRecordsPage from "./app/pages/StockRecordsPage.tsx";
  import { ProtectedRoute } from "./app/pages/ProtectedRoute.tsx";
  import { AuthProvider } from "./app/lib/AuthContext.tsx";
  import "./styles/index.css";

  createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/dashboard/stock"
            element={
              <ProtectedRoute>
                <StockRecordsPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
