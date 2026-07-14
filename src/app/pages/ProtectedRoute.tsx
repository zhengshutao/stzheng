import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAuth } from "@/app/lib/AuthContext";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "#060a14", color: "#8a99b8", fontFamily: "'JetBrains Mono', monospace" }}
      >
        LOADING...
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
