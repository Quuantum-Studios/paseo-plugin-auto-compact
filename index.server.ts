import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerCompactAssist } from "./server/compact";
import { migrateLegacyConfig, useSettingsReader } from "./server/config";
import { ensureSkill, installHelpers, removeSkill, installHook, removeHook } from "./server/install";
import { installRpc } from "./shared/install";
import { autoCompactSettings } from "./shared/options";

export default function contribute(server: PluginServerContext) {
  server.handle(installRpc, ({ action }) => {
    const message = action === "helpers" ? installHelpers() : action === "hook" ? installHook() : removeHook();
    console.log("[auto-compact] install: " + message);
    return { message };
  });
  const migrated = migrateLegacyConfig();
  if (migrated) console.log("[auto-compact] settings " + migrated);
  const handle = server.registerSettings(autoCompactSettings);
  // Keep the skill in step with the installSkill setting: at startup and on every change.
  const syncSkill = (state: { status: string; values?: { installSkill?: boolean } }) => {
    if (state.status !== "ready") return;
    try {
      const msg = state.values?.installSkill === false ? removeSkill() : ensureSkill();
      if (msg) console.log("[auto-compact] " + msg);
    } catch (e) { console.log("[auto-compact] skill sync failed: " + String(e)); }
  };
  // Also sync on every config read (each turn end), so edits that bypass the subscription still apply.
  useSettingsReader({ read: async () => { const state = await handle.read(); syncSkill(state); return state; } });
  void handle.read().then(syncSkill);
  const unsubscribe = handle.subscribe(syncSkill);
  const stop = registerCompactAssist(server);
  return () => { unsubscribe(); return stop(); };
}
