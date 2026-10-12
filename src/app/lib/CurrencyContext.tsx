import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Currency } from "@/app/lib/dashboardData";

const STORAGE_KEY = "dashboard.displayCurrency";

type CurrencyContextValue = {
  currency: Currency;
  setCurrency: (c: Currency) => void;
};

const CurrencyContext = createContext<CurrencyContextValue>({
  currency: "USD",
  setCurrency: () => {},
});

function readStored(): Currency {
  if (typeof window === "undefined") return "USD";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "CAD" ? "CAD" : "USD";
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<Currency>(readStored);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, currency);
  }, [currency]);

  const setCurrency = (c: Currency) => setCurrencyState(c);

  return <CurrencyContext.Provider value={{ currency, setCurrency }}>{children}</CurrencyContext.Provider>;
}

export function useCurrency() {
  return useContext(CurrencyContext);
}
