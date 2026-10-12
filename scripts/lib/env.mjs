import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** 把 .env / .env.local 里的键值读进 process.env(已经设置的不覆盖)。 */
export function loadEnv(root = process.cwd()) {
  for (const file of [".env", ".env.local"]) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eq = trimmed.indexOf("=");
      const key = trimmed.slice(0, eq).trim();
      const raw = trimmed.slice(eq + 1).trim();
      if (!key || process.env[key]) continue;
      process.env[key] = raw.replace(/^['"]|['"]$/g, "");
    }
  }
}

export function supabaseUrl() {
  return process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
}

export function supabaseSecretKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
}
