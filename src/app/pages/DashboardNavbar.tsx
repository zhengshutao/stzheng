import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { LogOut } from "lucide-react";
import { supabase } from "@/app/lib/supabase";
import { useAuth } from "@/app/lib/AuthContext";
import { useCurrency } from "@/app/lib/CurrencyContext";
import type { Currency } from "@/app/lib/dashboardData";

const mono = { fontFamily: "'JetBrains Mono', monospace" };
const display = { fontFamily: "'Exo 2', sans-serif" };

const CCYS: Currency[] = ["USD", "CAD"];

function CurrencyToggle() {
  const { currency, setCurrency } = useCurrency();
  return (
    <div
      className="flex items-center rounded-full p-0.5 text-[10px] font-semibold"
      style={{ ...mono, background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.2)" }}
    >
      {CCYS.map((c) => (
        <button
          key={c}
          onClick={() => setCurrency(c)}
          className="px-2.5 py-1 rounded-full transition-all"
          style={{
            color: currency === c ? "#fff" : "#6b7fa8",
            background: currency === c ? "linear-gradient(135deg,#8b5cf6,#7c3aed)" : "transparent",
          }}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

export default function DashboardNavbar({ sub, showCurrency = true }: { sub?: string; showCurrency?: boolean }) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const email = session?.user.email ?? "";
  const initial = email.charAt(0).toUpperCase() || "?";

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/");
  };

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 lg:px-10 h-16"
      style={{
        background: "rgba(6,10,20,0.85)",
        backdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(139,92,246,0.18)",
      }}
    >
      <div className="flex items-center gap-3">
        <Link to="/dashboard" className="text-white font-bold text-sm tracking-wide" style={display}>
          资产 DASHBOARD
        </Link>
        <span className="text-[10px] tracking-widest hidden sm:block" style={{ ...mono, color: "#4a5568" }}>
          {sub ?? "SYS/ASSETS"}
        </span>
        <Link
          to="/dashboard/portfolio"
          className="text-[10px] tracking-widest transition-colors hover:text-violet-300"
          style={{ ...mono, color: "#a78bfa" }}
        >
          投资组合
        </Link>
        <Link
          to="/dashboard/chart"
          className="text-[10px] tracking-widest transition-colors hover:text-violet-300"
          style={{ ...mono, color: "#a78bfa" }}
        >
          K线
        </Link>
      </div>

      <div className="flex items-center gap-3">
        {showCurrency && <CurrencyToggle />}
        <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all"
          style={{
            background: "rgba(139,92,246,0.2)",
            border: "1px solid rgba(139,92,246,0.5)",
            color: "#a78bfa",
            ...mono,
          }}
          title={email}
        >
          {initial}
        </button>

        {menuOpen && (
          <div
            className="absolute right-0 mt-2 w-48 rounded-lg overflow-hidden"
            style={{
              background: "rgba(10,14,28,0.95)",
              backdropFilter: "blur(24px)",
              border: "1px solid rgba(139,92,246,0.25)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            }}
          >
            <div
              className="px-4 py-3 text-xs truncate"
              style={{ ...mono, color: "#6b7fa8", borderBottom: "1px solid rgba(139,92,246,0.12)" }}
            >
              {email}
            </div>
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-4 py-3 text-sm transition-colors hover:bg-violet-600/10"
              style={{ ...mono, color: "#e2e8f4" }}
            >
              <LogOut size={14} />
              Logout
            </button>
          </div>
        )}
        </div>
      </div>
    </nav>
  );
}
