/**
 * Zero-dependency `.env` file loader for Node.js (`server.js`).
 * Loads key=value pairs from `.env` into `process.env` without overwriting
 * variables already set in the environment (e.g., by Cloud Run).
 */

import fs from "node:fs";
import path from "node:path";

export function parseEnvContent(content) {
  const loaded = {};
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.replace(/^export\s+/, "");
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx < 1) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    let val = cleaned.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    loaded[key] = val;
  }
  return loaded;
}

export function loadDotEnv(envPath = path.resolve(process.cwd(), ".env")) {
  try {
    if (!fs.existsSync(envPath)) return {};
    const content = fs.readFileSync(envPath, "utf8");
    const loaded = parseEnvContent(content);
    for (const [key, val] of Object.entries(loaded)) {
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
    return loaded;
  } catch {
    return {};
  }
}
