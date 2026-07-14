import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { supabase, isSupabaseConfigured } from "@/app/lib/supabase";
import { useAuth } from "@/app/lib/AuthContext";

const mono = { fontFamily: "'JetBrains Mono', monospace" };
const display = { fontFamily: "'Exo 2', sans-serif" };

export default function LoginPage() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && session) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    setSubmitting(false);

    if (error) {
      setError(error.message);
      return;
    }

    navigate("/dashboard");
  };

  const inputStyle = {
    background: "rgba(139,92,246,0.06)",
    border: "1px solid rgba(139,92,246,0.2)",
    borderRadius: 6,
    padding: "10px 14px",
    color: "#e2e8f4",
    fontSize: 13,
    fontFamily: "'Inter',sans-serif",
    width: "100%",
    outline: "none",
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: "#060a14", fontFamily: "'Inter', sans-serif" }}
    >
      <div
        className="w-full max-w-sm rounded-xl p-8"
        style={{
          background: "rgba(10,14,28,0.82)",
          backdropFilter: "blur(32px)",
          border: "1px solid rgba(139,92,246,0.3)",
          boxShadow: "0 0 60px rgba(139,92,246,0.12)",
        }}
      >
        <div className="text-[10px] tracking-widest mb-2" style={{ ...mono, color: "#4a5568" }}>
          SYS/ACCESS · SIGN IN
        </div>
        <h1 className="text-2xl font-black text-white mb-6" style={display}>
          LOGIN
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-[10px] tracking-widest block mb-1.5" style={{ ...mono, color: "#4a5568" }}>
              EMAIL
            </label>
            <input
              type="email"
              required
              style={inputStyle}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <div>
            <label className="text-[10px] tracking-widest block mb-1.5" style={{ ...mono, color: "#4a5568" }}>
              PASSWORD
            </label>
            <input
              type="password"
              required
              style={inputStyle}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>

          {!isSupabaseConfigured && (
            <div className="text-xs" style={{ ...mono, color: "#fb923c" }}>
              Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.
            </div>
          )}

          {error && (
            <div className="text-xs" style={{ ...mono, color: "#f87171" }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !isSupabaseConfigured}
            className="w-full flex items-center justify-center gap-2.5 py-3 text-sm font-semibold tracking-widest rounded-lg transition-all duration-300 hover:opacity-90 disabled:opacity-50"
            style={{
              ...mono,
              color: "#fff",
              background: "linear-gradient(135deg,#8b5cf6,#7c3aed)",
              boxShadow: "0 0 28px rgba(139,92,246,0.4)",
            }}
          >
            {submitting ? "SIGNING IN..." : "SIGN IN"}
          </button>
        </form>
      </div>
    </div>
  );
}
