import { createClient } from "@supabase/supabase-js";
import { supabaseSecretKey, supabaseUrl } from "./env.mjs";

export { fetchAllRows, isMissingTableError } from "../../supabase/functions/_shared/stockDb.mjs";

export function createServiceClient() {
  const url = supabaseUrl();
  const key = supabaseSecretKey();
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY).");
  return createClient(url, key, { auth: { persistSession: false } });
}
