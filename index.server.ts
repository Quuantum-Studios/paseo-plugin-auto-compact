import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerCompactAssist } from "./server/compact";
import { migrateLegacyConfig, useSettingsReader } from "./server/config";
import { installHelpers, installHook, removeHook } from "./server/install";
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
  useSettingsReader(server.registerSettings(autoCompactSettings));
  return registerCompactAssist(server);
}
