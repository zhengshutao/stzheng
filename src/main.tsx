
  import { createRoot } from "react-dom/client";
  import { BrowserRouter, Routes, Route } from "react-router";
  import App from "./app/App.tsx";
  import LoginPage from "./app/pages/LoginPage.tsx";
  import DashboardPage from "./app/pages/DashboardPage.tsx";
  import StockRecordsPage from "./app/pages/StockRecordsPage.tsx";
  import DailyRecordsPage from "./app/pages/DailyRecordsPage.tsx";
  import PortfolioPage from "./app/pages/PortfolioPage.tsx";
  import ChartPage from "./app/pages/ChartPage.tsx";
  import { ProtectedRoute } from "./app/pages/ProtectedRoute.tsx";
  import { AuthProvider } from "./app/lib/AuthContext.tsx";
  import { CurrencyProvider } from "./app/lib/CurrencyContext.tsx";
  import "./styles/index.css";

  createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
      <AuthProvider>
        <CurrencyProvider>
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
          <Route
            path="/dashboard/daily"
            element={
              <ProtectedRoute>
                <DailyRecordsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/dashboard/portfolio"
            element={
              <ProtectedRoute>
                <PortfolioPage />
              </ProtectedRoute>
            }
          />
          {["/dashboard/chart", "/dashboard/chart/:symbol"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <ProtectedRoute>
                  <ChartPage />
                </ProtectedRoute>
              }
            />
          ))}
        </Routes>
        </CurrencyProvider>
      </AuthProvider>
    </BrowserRouter>
  );
