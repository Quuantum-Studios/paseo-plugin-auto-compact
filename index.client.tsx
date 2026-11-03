import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SettingsScreen } from "./client/SettingsScreen";
import { CompactRow } from "./client/CompactRow";
import { installRpc } from "./shared/install";
import { COMPACT_ROW_KIND, compactRowSchema } from "./shared/row";

function SettingsItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Minimize2" active={currentScreen?.screenId === "settings"} onPress={() => openScreen({ screenId: "settings" })} />;
}

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({ kind: COMPACT_ROW_KIND, version: 1, schema: compactRowSchema, Component: CompactRow });
  const items = [
    { id: "install-helpers", title: "Auto-compact: install my-context script and pre-compact-save skill", action: "helpers" as const },
    { id: "install-hook", title: "Auto-compact: install the Claude reminder hook (opt-in)", action: "hook" as const },
    { id: "remove-hook", title: "Auto-compact: remove the Claude reminder hook", action: "remove-hook" as const },
  ];
  const removers = items.map((item) =>
    client.addCommandCenterItem({
      id: item.id,
      title: item.title,
      icon: "Minimize2",
      context: "global",
      onSelect: ({ rpc }) => void rpc(installRpc, { action: item.action }),
    }),
  );
  const removeSettings = client.addSettingsScreen({ id: "options", title: "Auto-compact", icon: "Minimize2", Component: SettingsScreen });
  const removeScreen = client.addScreen({ id: "settings", title: "Auto-compact settings", Component: SettingsScreen });
  const removeSidebar = client.addSidebarHeaderItem({ id: "settings", title: "Auto-compact", Component: SettingsItem });
  const removeOpen = client.addCommandCenterItem({
    id: "open-settings",
    title: "Auto-compact: open settings",
    icon: "Settings",
    context: "global",
    onSelect: ({ openSettings }) => openSettings("options"),
  });
  return () => [...removers, removeSettings, removeScreen, removeSidebar, removeOpen].forEach((remove) => remove());
}
