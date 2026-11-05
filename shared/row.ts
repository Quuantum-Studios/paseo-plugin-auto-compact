import { z } from "zod";

export const COMPACT_ROW_KIND = "compact-ready";
export const compactRowSchema = z.object({
  state: z.enum(["asked", "saving", "ready", "canceled"]),
  tokens: z.number(),
  note: z.string(),
});
