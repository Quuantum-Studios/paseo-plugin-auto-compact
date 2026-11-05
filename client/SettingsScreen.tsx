import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { ASK_DEFAULT, RESUME_DEFAULT, SAVE_DEFAULT, autoCompactSettings, normalizeConfig, parseTokens } from "../shared/options";

type Ready = Extract<SettingsState<typeof autoCompactSettings.schema>, { status: "ready" }>;
type Values = Ready["values"];
type Switch = "enabled" | "forceAboveMax" | "autoCompact" | "resume" | "installSkill" | "dryRun";

const SWITCHES: { key: Switch; label: string; hint: string }[] = [
  { key: "enabled", label: "Enabled", hint: "Master switch. Off = the plugin does nothing." },
  { key: "forceAboveMax", label: "Force above maximum", hint: "Above the maximum, run save then compact even if the agent declines." },
  { key: "autoCompact", label: "Send /compact automatically", hint: "Off = stop after the save step and leave a timeline row." },
  { key: "resume", label: "Resume after compaction", hint: "Send the resume prompt once compaction is done." },
  { key: "installSkill", label: "Install pre-compact-save skill", hint: "Keeps the skill in ~/.claude/skills/pre-compact-save. Off removes it (an edited copy is backed up first)." },
  { key: "dryRun", label: "Dry run", hint: "Decide and log, but send nothing and compact nothing." },
];
const LOG_LEVELS = [{ label: "Info", value: "info" }, { label: "Debug (per-turn timing)", value: "debug" }] as const;

// Text fields edited as a draft and saved together. Tokens accept "150k" / "1.5m".
const TOKEN_FIELDS = [
  { key: "normalThreshold", label: "Normal threshold (tokens)", hint: "Compaction is advised from here; the agent may decline. Per agent: label autocompact.threshold=200k." },
  { key: "maxThreshold", label: "Maximum threshold (tokens)", hint: "From here compaction is forced. Per agent: label autocompact.max=300k." },
  { key: "agentInitiatedMinTokens", label: "Agent-initiated minimum (tokens)", hint: "An agent's own [compact-check] is honoured at or above this." },
  { key: "retryAfterTokens", label: "Re-ask after (tokens)", hint: "After a decline, ask again only after this many more tokens." },
] as const;
const NUMBER_FIELDS = [
  { key: "maxRisk", label: "Max quality risk (0-100)", hint: "Between the limits, compact only if the agent's risk is at or below this." },
  { key: "minConfidence", label: "Min confidence (0-100)", hint: "... and its confidence is at or above this." },
  { key: "askCooldownMinutes", label: "Ask cooldown (minutes)", hint: "Minimum gap between plugin asks per agent." },
  { key: "compactCooldownMinutes", label: "Compact cooldown (minutes)", hint: "At most one compaction per agent in this time." },
] as const;

function toDraft(v: Values): Record<string, string> {
  return {
    normalThreshold: String(v.normalThreshold), maxThreshold: String(v.maxThreshold),
    agentInitiatedMinTokens: String(v.agentInitiatedMinTokens), retryAfterTokens: String(v.retryAfterTokens),
    maxRisk: String(v.maxRisk), minConfidence: String(v.minConfidence),
    askCooldownMinutes: String(v.askCooldownMinutes), compactCooldownMinutes: String(v.compactCooldownMinutes),
    providers: v.providers.join(", "), optOutLabel: v.optOutLabel, onlyLabel: v.onlyLabel ?? "",
    providerLimits: JSON.stringify(v.providerLimits), askPrompt: v.askPrompt ?? ASK_DEFAULT, savePrompt: v.savePrompt ?? SAVE_DEFAULT, resumePrompt: v.resumePrompt ?? RESUME_DEFAULT,
  };
}

// Draft strings -> a settings document, or the first problem.
function fromDraft(base: Values, d: Record<string, string>): { values: Values } | { error: string } {
  let providerLimits: unknown;
  try { providerLimits = JSON.parse(d.providerLimits || "{}"); } catch { return { error: 'Provider limits: not valid JSON, e.g. {"codex":{"normal":"100k"}}' }; }
  const values: Record<string, unknown> = { ...base };
  for (const f of TOKEN_FIELDS) {
    const n = parseTokens(d[f.key]);
    if (n === null) return { error: `${f.label}: not a number (use 150000 or 150k)` };
    values[f.key] = n;
  }
  for (const f of NUMBER_FIELDS) values[f.key] = Number(d[f.key]);
  values.providers = d.providers.split(",").map((s) => s.trim()).filter(Boolean);
  values.optOutLabel = d.optOutLabel.trim();
  values.onlyLabel = d.onlyLabel.trim() || null;
  values.providerLimits = providerLimits;
  const prompt = (text: string, builtIn: string) => (text.trim() === builtIn.trim() ? null : text.trim() || null);
  values.askPrompt = prompt(d.askPrompt, ASK_DEFAULT);
  values.savePrompt = prompt(d.savePrompt, SAVE_DEFAULT);
  values.resumePrompt = prompt(d.resumePrompt, RESUME_DEFAULT);
  const { cfg, warnings } = normalizeConfig(values);
  if (warnings.length) return { error: warnings[0] };
  return { values: { ...base, ...cfg, providerLimits: cfg.providerLimits } as Values };
}

const DEBOUNCE_MS = 500;

// Multi-line text field (SettingsInput is single-line). Height follows the text so nothing scrolls sideways.
function TextArea({ label, hint, value, onChangeText, theme, minLines = 3 }: { label: string; hint?: string; value: string; onChangeText(t: string): void; theme: PluginSurfaceProps["theme"]; minLines?: number }) {
  const lines = Math.max(minLines, value.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 70)), 0));
  return (
    <SettingsRow label={label} hint={hint}>
      <TextInput
        multiline
        scrollEnabled={false}
        defaultValue={value}
        onChangeText={onChangeText}
        accessibilityLabel={label}
        style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 10, minHeight: lines * 20 + 20, textAlignVertical: "top", width: "100%" }}
      />
    </SettingsRow>
  );
}
type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

function Form({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const [draft, setDraft] = useState(() => toDraft(settings.values));
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [formKey, setFormKey] = useState(0); // remounts the inputs after a reset
  const latest = useRef(settings);
  latest.current = settings;
  const edited = useRef(false); // true once the user changed a text field; skips the first render
  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  const errorStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const setField = useCallback((key: string, value: string) => {
    edited.current = true;
    setStatus("pending");
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  const saveNow = useCallback(async (patch: Partial<Values>) => {
    setStatus("saving");
    const s = latest.current;
    const ok = await s.save({ ...s.values, ...patch }, s.revision);
    setStatus(ok ? "saved" : "error");
  }, []);
  const toggle = (key: Switch) => (value: boolean) => void saveNow({ [key]: value });
  const changeLog = useCallback((logLevel: Values["logLevel"]) => void saveNow({ logLevel }), [saveNow]);

  // Text fields: validate and save 500ms after the last keystroke. An invalid draft is not saved.
  useEffect(() => {
    if (!edited.current || settings.saving) return;
    const timer = setTimeout(() => {
      const s = latest.current;
      const r = fromDraft(s.values, draft);
      if ("error" in r) { setError(r.error); setStatus("error"); return; }
      setError(null);
      // Only text-field values come from the draft; switches always keep their newest saved value.
      const { enabled, forceAboveMax, autoCompact, resume, installSkill, dryRun, logLevel } = s.values;
      void saveNow({ ...r.values, enabled, forceAboveMax, autoCompact, resume, installSkill, dryRun, logLevel });
      edited.current = false;
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, settings.saving, saveNow]);

  const reset = useCallback(async () => {
    edited.current = false;
    const ok = await latest.current.reset();
    setDraft(toDraft(autoCompactSettings.schema.parse({})));
    setError(null);
    setStatus(ok ? "saved" : "error");
    setFormKey((k) => k + 1);
  }, []);

  const problem = error ?? settings.saveError;
  const indicator =
    problem ? problem
    : status === "pending" || status === "saving" ? "Saving…"
    : status === "saved" ? "Saved"
    : "Changes save automatically and apply on the agent's next turn.";

  return (
    <View key={formKey} style={{ gap: 16 }}>
      <Text accessibilityRole={problem ? "alert" : undefined} style={problem ? errorStyle : muted}>{indicator}</Text>
      <SettingsSection title="General">
        <SettingsCard>
          {SWITCHES.map((f) => (
            <SettingsSwitch key={f.key} label={f.label} hint={f.hint} value={settings.values[f.key]} disabled={settings.saving} onValueChange={toggle(f.key)} />
          ))}
          <SettingsSelect label="Log level" value={settings.values.logLevel} options={LOG_LEVELS} disabled={settings.saving} onValueChange={changeLog} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Limits">
        <SettingsCard>
          {[...TOKEN_FIELDS, ...NUMBER_FIELDS].map((f) => (
            <SettingsInput key={f.key} label={f.label} hint={f.hint} initialValue={draft[f.key]} onChangeText={(t) => setField(f.key, t)} />
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Scope and overrides">
        <SettingsCard>
          <SettingsInput label="Providers" hint="Comma separated, e.g. claude, codex." initialValue={draft.providers} onChangeText={(t) => setField("providers", t)} />
          <SettingsInput label="Opt-out label" hint="Agents labelled <label>=off are skipped; <label>.threshold and <label>.max override the limits." initialValue={draft.optOutLabel} onChangeText={(t) => setField("optOutLabel", t)} />
          <SettingsInput label="Only agents with label" hint="key=value, empty = all agents. For testing." placeholder="none (all agents)" initialValue={draft.onlyLabel} onChangeText={(t) => setField("onlyLabel", t)} />
          <TextArea label="Provider limits (JSON)" hint='Per-provider limits, e.g. {"codex":{"normal":"100k","max":"200k"}}.' value={draft.providerLimits} onChangeText={(t) => setField("providerLimits", t)} theme={theme} minLines={2} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Prompts (built-in text shown; edit to override)">
        <SettingsCard>
          <TextArea label="Ask prompt" hint="Placeholders: {k} {tokens} {format}" value={draft.askPrompt} onChangeText={(t) => setField("askPrompt", t)} theme={theme} />
          <TextArea label="Save prompt" hint="Placeholders: {k} {tokens}" value={draft.savePrompt} onChangeText={(t) => setField("savePrompt", t)} theme={theme} />
          <TextArea label="Resume prompt" hint="Placeholders: {task} {last}" value={draft.resumePrompt} onChangeText={(t) => setField("resumePrompt", t)} theme={theme} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Reset">
        <SettingsCard>
          <SettingsAction label="Reset everything to defaults" actionLabel="Reset" disabled={settings.saving} onPress={reset} />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

const MAX_WIDTH = 720;

export function SettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(autoCompactSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const body =
    settings.status === "ready" ? <Form settings={settings} theme={theme} />
    : settings.status === "loading" ? <Text style={style}>Loading settings…</Text>
    : (
      <View style={{ gap: 12 }}>
        <Text style={style}>Settings could not be used: {settings.error}</Text>
        <SettingsAction label="Stored data is kept until you reset it" actionLabel="Reset to defaults" onPress={() => void settings.reset()} />
      </View>
    );
  // Boxed panel: centred, capped width, bordered card on larger screens; full width on compact.
  const panel = layout.compact
    ? { gap: 16 }
    : { gap: 16, width: "100%" as const, maxWidth: MAX_WIDTH, padding: 24, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 };
  return (
    <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, alignItems: "center" }}>
      <View style={panel}>{body}</View>
    </ScrollView>
  );
}
