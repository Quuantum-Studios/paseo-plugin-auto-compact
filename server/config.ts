import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ASK_DEFAULT, DEFAULTS, FORMAT, SAVE_DEFAULT, levelFor, limitsFor, normalizeConfig, parseTokens, type Config, type Level, type Limits } from "../shared/options";

export { ASK_DEFAULT, DEFAULTS, FORMAT, SAVE_DEFAULT, levelFor, limitsFor, normalizeConfig, parseTokens };
export type { Config, Level, Limits };

// Options live in Paseo's native plugin settings (~/.paseo/plugin-settings/auto-compact-assist/options.json).
export const SETTINGS_PATH = join(homedir(), ".paseo", "plugin-settings", "auto-compact-assist", "options.json");
// Pre-1.2.0 location; read once to migrate, never written again.
export const LEGACY_CONFIG_PATH = join(homedir(), ".paseo", "plugin-data", "auto-compact-assist", "config.json");

// First start on 1.2.0: copy the old config.json into the native settings file (normalized, legacy keys mapped).
// Done on disk before registerSettings because the server handle can only read. Never overwrites an existing document.
export function migrateLegacyConfig(): string | null {
  if (existsSync(SETTINGS_PATH) || !existsSync(LEGACY_CONFIG_PATH)) return null;
  try {
    const { cfg } = normalizeConfig(JSON.parse(readFileSync(LEGACY_CONFIG_PATH, "utf8")));
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ version: 1, values: cfg }, null, 2) + "\n");
    return "migrated " + LEGACY_CONFIG_PATH;
  } catch (e) {
    return "migration failed: " + String(e);
  }
}

type Reader = { read(): Promise<{ status: string; values?: unknown }> };
let reader: Reader | null = null;
export function useSettingsReader(r: Reader) { reader = r; }

let warned = "";
function warn(msg: string) {
  if (msg === warned) return;
  warned = msg;
  console.log("[auto-compact] " + JSON.stringify({ decision: "config-warning", warnings: msg }));
}
// Read on every turn so a change in the settings screen (including the off switch) applies without a reload.
// Unreadable or invalid settings mean defaults, which are disabled.
export async function readConfig(): Promise<Config> {
  let raw: unknown = {};
  try {
    const s = reader ? await reader.read() : null;
    if (s?.status === "ready") raw = s.values;
    else warn("settings unreadable (" + (s?.status ?? "no reader") + "); using defaults");
  } catch (e) { warn("settings read failed: " + String(e)); }
  const { cfg, warnings } = normalizeConfig(raw);
  if (warnings.length) warn(warnings.join("; "));
  return cfg;
}
