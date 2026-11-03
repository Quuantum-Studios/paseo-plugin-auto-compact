import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { z } from "zod";
import type { compactRowSchema } from "../shared/row";

export function CompactRow({ item, theme, layout }: PluginTimelineItemProps<z.infer<typeof compactRowSchema>>) {
  const data = item.data;
  return (
    <View
      style={{
        padding: layout.compact ? 10 : 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Text style={{ color: theme.colors.foreground }}>
        {data.state === "ready" ? "Saved, ready to compact" : "Auto-compact: " + data.state}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        {Math.round(data.tokens / 1000)}k tokens. {data.note}
      </Text>
    </View>
  );
}
