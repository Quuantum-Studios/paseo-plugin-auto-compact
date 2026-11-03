import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const installAction = z.enum(["helpers", "hook", "remove-hook"]);

// "helpers": my-context script + pre-compact-save skill. "hook": PostToolUse reminder in Claude settings. "remove-hook": undo it.
export const installRpc = defineRpc({
  name: "auto-compact.install",
  input: z.object({ action: installAction }),
  output: z.object({ message: z.string() }),
});
