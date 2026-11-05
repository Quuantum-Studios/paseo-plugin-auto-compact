import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export interface Limits {
  normal: number; // plugin advises compaction from here; the agent may decline
  max: number; // above this the agent can no longer decline
}

export interface Config {
  enabled: boolean;
  normalThreshold: number; // tokens. Legacy key: thresholdTokens
  maxThreshold: number; // tokens. Above it: forced save, then compact
  forceAboveMax: boolean; // false = max is only logged, agents may always decline
  providerLimits: Record<string, Partial<Limits>>; // per provider overrides, e.g. { "codex": { "normal": 100000 } }
  agentInitiatedMinTokens: number; // an agent's own [compact-check] is honoured at or above this
  maxRisk: number; // between normal and max: compact only if quality_risk <= this
  minConfidence: number; // ... and confidence >= this
  askCooldownMinutes: number; // min gap between plugin asks per agent
  compactCooldownMinutes: number; // at most one compaction per agent per this many minutes
  retryAfterTokens: number; // after ready=no / low confidence, re-ask only after this many more tokens
  autoCompact: boolean; // send /compact after the save step; false = stop at a timeline row
  resume: boolean; // send the resume prompt after compaction
  installSkill: boolean; // keep the pre-compact-save skill installed in ~/.claude/skills
  dryRun: boolean; // decide and log, but send nothing and compact nothing
  askPrompt: string | null; // templates; null = built-in. Placeholders: {k} {tokens} {format}
  savePrompt: string | null; // {k} {tokens}
  resumePrompt: string | null; // {task} {last}
  providers: string[];
  optOutLabel: string; // agents labelled <optOutLabel>=off are never touched; <optOutLabel>.threshold / .max override limits
  onlyLabel: string | null; // "key=value": act only on agents with this label (test scope)
  logLevel: "info" | "debug"; // debug adds per-turn timing and skip reasons
}

export const DEFAULTS: Config = {
  enabled: false,
  normalThreshold: 150_000,
  maxThreshold: 250_000,
  forceAboveMax: true,
  providerLimits: {},
  agentInitiatedMinTokens: 75_000,
  maxRisk: 30,
  minConfidence: 70,
  askCooldownMinutes: 30,
  compactCooldownMinutes: 30,
  retryAfterTokens: 30_000,
  autoCompact: true,
  resume: true,
  installSkill: true,
  dryRun: false,
  askPrompt: null,
  savePrompt: null,
  resumePrompt: null,
  providers: ["claude"],
  optOutLabel: "autocompact",
  onlyLabel: null,
  logLevel: "info",
};

// "150000", 150000, "150k", "1.5m" -> tokens, or null.
export function parseTokens(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  if (typeof v !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]) * (m[2].toLowerCase() === "k" ? 1_000 : m[2].toLowerCase() === "m" ? 1_000_000 : 1);
  return n > 0 ? Math.round(n) : null;
}

// Merge a raw config object over the defaults. Bad values fall back to the default and are reported; nothing throws.
export function normalizeConfig(raw: unknown): { cfg: Config; warnings: string[] } {
  const warnings: string[] = [];
  const cfg: Config = { ...DEFAULTS, providers: [...DEFAULTS.providers], providerLimits: {} };
  const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if ("thresholdTokens" in src) {
    if (!("normalThreshold" in src)) src.normalThreshold = src.thresholdTokens; // back-compat
    delete src.thresholdTokens;
  }
  const num = (key: keyof Config, min: number, max: number, tokens = false) => {
    if (!(key in src)) return;
    const v = tokens ? parseTokens(src[key]) : typeof src[key] === "number" ? (src[key] as number) : null;
    if (v === null || !Number.isFinite(v) || v < min || v > max) warnings.push(`${key}: invalid (${JSON.stringify(src[key])}), using ${cfg[key]}`);
    else (cfg[key] as number) = v;
  };
  const bool = (key: keyof Config) => {
    if (!(key in src)) return;
    if (typeof src[key] !== "boolean") warnings.push(`${key}: must be true/false, using ${cfg[key]}`);
    else (cfg[key] as boolean) = src[key] as boolean;
  };
  const text = (key: keyof Config) => {
    if (!(key in src) || src[key] === null) return;
    if (typeof src[key] !== "string" || !(src[key] as string).trim()) warnings.push(`${key}: must be a non-empty string or null`);
    else (cfg[key] as string | null) = src[key] as string;
  };
  bool("enabled"); bool("forceAboveMax"); bool("autoCompact"); bool("resume"); bool("dryRun"); bool("installSkill");
  num("normalThreshold", 1_000, 10_000_000, true);
  num("maxThreshold", 1_000, 10_000_000, true);
  num("agentInitiatedMinTokens", 0, 10_000_000, true);
  num("retryAfterTokens", 0, 10_000_000, true);
  num("maxRisk", 0, 100); num("minConfidence", 0, 100);
  num("askCooldownMinutes", 0, 100_000); num("compactCooldownMinutes", 0, 100_000);
  text("askPrompt"); text("savePrompt"); text("resumePrompt");
  if ("optOutLabel" in src) {
    if (typeof src.optOutLabel === "string" && src.optOutLabel) cfg.optOutLabel = src.optOutLabel;
    else warnings.push("optOutLabel: must be a non-empty string");
  }
  if ("onlyLabel" in src && src.onlyLabel !== null) {
    if (typeof src.onlyLabel === "string" && /^[^=]+=.+$/.test(src.onlyLabel)) cfg.onlyLabel = src.onlyLabel;
    else warnings.push('onlyLabel: must be "key=value" or null');
  }
  if ("providers" in src) {
    if (Array.isArray(src.providers) && src.providers.every((p) => typeof p === "string")) cfg.providers = src.providers as string[];
    else warnings.push("providers: must be a list of strings");
  }
  if ("logLevel" in src) {
    if (src.logLevel === "info" || src.logLevel === "debug") cfg.logLevel = src.logLevel;
    else warnings.push('logLevel: must be "info" or "debug"');
  }
  if ("debugTiming" in src && src.debugTiming === true) cfg.logLevel = "debug"; // legacy
  if ("providerLimits" in src) {
    const pl = src.providerLimits;
    if (pl && typeof pl === "object" && !Array.isArray(pl)) {
      for (const [prov, lim] of Object.entries(pl as Record<string, Record<string, unknown>>)) {
        const normal = parseTokens(lim?.normal), max = parseTokens(lim?.max);
        if (normal || max) cfg.providerLimits[prov] = { ...(normal ? { normal } : {}), ...(max ? { max } : {}) };
        else warnings.push(`providerLimits.${prov}: needs normal and/or max tokens`);
      }
    } else warnings.push("providerLimits: must be an object");
  }
  const known = new Set(Object.keys(DEFAULTS).concat(["debugTiming"]));
  for (const k of Object.keys(src)) if (!known.has(k)) warnings.push(`${k}: unknown option, ignored`);
  if (cfg.maxThreshold < cfg.normalThreshold) {
    warnings.push(`maxThreshold ${cfg.maxThreshold} is below normalThreshold ${cfg.normalThreshold}; using ${cfg.normalThreshold}`);
    cfg.maxThreshold = cfg.normalThreshold;
  }
  return { cfg, warnings };
}


// Effective limits for one agent: global -> provider override -> per-agent labels (<optOutLabel>.threshold, <optOutLabel>.max).
export function limitsFor(cfg: Config, provider: string, labels?: Record<string, string>): Limits {
  const p = cfg.providerLimits[provider] ?? {};
  let normal = p.normal ?? cfg.normalThreshold;
  let max = p.max ?? cfg.maxThreshold;
  const ln = parseTokens(labels?.[`${cfg.optOutLabel}.threshold`]);
  const lm = parseTokens(labels?.[`${cfg.optOutLabel}.max`]);
  if (ln) normal = ln;
  if (lm) max = lm;
  if (max < normal) max = normal;
  return { normal, max };
}


export type Level = "below" | "advise" | "force";
export function levelFor(tokens: number, lim: Limits, forceAboveMax: boolean): Level {
  if (forceAboveMax && tokens >= lim.max) return "force";
  return tokens >= lim.normal ? "advise" : "below";
}

const D = DEFAULTS;
const tokens = (d: number) => z.number().int().min(0).max(10_000_000).default(d);
// The native settings document. Runtime always goes through normalizeConfig too (clamps, legacy keys, warnings).
export const autoCompactSettings = defineSettings({
  id: "options",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(D.enabled),
    normalThreshold: tokens(D.normalThreshold),
    maxThreshold: tokens(D.maxThreshold),
    forceAboveMax: z.boolean().default(D.forceAboveMax),
    providerLimits: z.record(z.string(), z.object({ normal: z.number().optional(), max: z.number().optional() })).default({}),
    agentInitiatedMinTokens: tokens(D.agentInitiatedMinTokens),
    maxRisk: z.number().min(0).max(100).default(D.maxRisk),
    minConfidence: z.number().min(0).max(100).default(D.minConfidence),
    askCooldownMinutes: z.number().min(0).default(D.askCooldownMinutes),
    compactCooldownMinutes: z.number().min(0).default(D.compactCooldownMinutes),
    retryAfterTokens: tokens(D.retryAfterTokens),
    autoCompact: z.boolean().default(D.autoCompact),
    resume: z.boolean().default(D.resume),
    installSkill: z.boolean().default(D.installSkill),
    dryRun: z.boolean().default(D.dryRun),
    askPrompt: z.string().nullable().default(null),
    savePrompt: z.string().nullable().default(null),
    resumePrompt: z.string().nullable().default(null),
    providers: z.array(z.string()).default([...D.providers]),
    optOutLabel: z.string().min(1).default(D.optOutLabel),
    onlyLabel: z.string().nullable().default(null),
    logLevel: z.enum(["info", "debug"]).default(D.logLevel),
  }),
});

// Built-in prompt texts. The settings screen pre-fills empty prompt fields with these; saving a text equal to its default stores null.
export const FORMAT = "[compact-check] ctx=<estimate> ready=<yes|no> quality_risk=<0-100> confidence=<0-100> reason=<few words>";
export const ASK_DEFAULT =
  `Context is about {k}k tokens. Decide whether compacting now would hurt your work (mid-edit, unsaved reasoning, open threads). ` +
  `End your reply with exactly one line in this format (ready=no is fine and costs nothing):\n{format}`;
export const SAVE_DEFAULT =
  "Compaction approved. Run the pre-compact-save skill now (working state to files, durable learnings, skill updates), then reply with a line exactly: ready to compact";
// Display form of the built-in resume prompt; {task} and {last} are dropped when unknown.
export const RESUME_DEFAULT =
  "Compaction done. Before the flow you were working on: {task} Last step: {last} Reread your saved notes (TODO/NOTES/memory, task files). This message is the prompt to continue: do the next unfinished step of that same work now, even if the task said to wait for a prompt. Reply 'idle' and stop only if that work was already fully finished. Do not invent new work.";
