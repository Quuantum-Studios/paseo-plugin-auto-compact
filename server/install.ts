import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MY_CONTEXT_SCRIPT, PRE_COMPACT_SKILL } from "./assets";

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const scriptPath = () => join(homedir(), ".local", "bin", "my-context");
const skillPath = () => join(claudeDir(), "skills", "pre-compact-save", "SKILL.md");
const settingsPath = () => join(claudeDir(), "settings.json");
const HOOK_SUFFIX = "my-context --hook";
const ALLOW = "Bash(my-context)";

function backup(path: string) {
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${new Date().toISOString().slice(0, 10)}`);
}

function write(path: string, content: string, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  backup(path);
  writeFileSync(path, content);
  if (mode) chmodSync(path, mode);
}

export function installHelpers(): string {
  write(scriptPath(), MY_CONTEXT_SCRIPT, 0o755);
  write(skillPath(), PRE_COMPACT_SKILL);
  return `Installed ${scriptPath()} and the pre-compact-save skill at ${skillPath()}. Make sure ~/.local/bin is on PATH.`;
}

type Settings = { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>; permissions?: { allow?: string[] } };

function readSettings(): Settings {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Settings; // throws on invalid JSON: never overwrite a file we cannot parse
}

const isOurs = (e: { hooks?: Array<{ command?: string }> }) => e.hooks?.some((h) => h.command?.endsWith(HOOK_SUFFIX));

export function installHook(): string {
  if (!existsSync(scriptPath())) installHelpers();
  const s = readSettings();
  s.hooks ??= {};
  const list = (s.hooks.PostToolUse ??= []);
  if (!list.some(isOurs)) list.push({ hooks: [{ type: "command", command: `${scriptPath()} --hook`, timeout: 5 } as { command: string }] });
  s.permissions ??= {};
  const allow = (s.permissions.allow ??= []);
  if (!allow.includes(ALLOW)) allow.push(ALLOW);
  write(settingsPath(), JSON.stringify(s, null, 2) + "\n");
  return `Hook installed in ${settingsPath()} (backup alongside). It reminds agents only when the plugin is enabled and context is over the threshold.`;
}

export function removeHook(): string {
  if (!existsSync(settingsPath())) return "No settings file; nothing to remove.";
  const s = readSettings();
  if (s.hooks?.PostToolUse) s.hooks.PostToolUse = s.hooks.PostToolUse.filter((e) => !isOurs(e));
  if (s.permissions?.allow) s.permissions.allow = s.permissions.allow.filter((a) => a !== ALLOW);
  write(settingsPath(), JSON.stringify(s, null, 2) + "\n");
  return "Hook removed.";
}

// Install the skill only when missing (never overwrite a user's copy). Returns a log message or null.
export function ensureSkill(): string | null {
  if (existsSync(skillPath())) return null;
  write(skillPath(), PRE_COMPACT_SKILL);
  return `skill installed at ${skillPath()}`;
}

// Remove the skill. An unchanged copy is deleted; an edited one is renamed to a dated backup.
export function removeSkill(): string | null {
  const path = skillPath();
  if (!existsSync(path)) return null;
  let msg: string;
  if (readFileSync(path, "utf8") === PRE_COMPACT_SKILL) {
    rmSync(path);
    msg = "skill removed";
  } else {
    let backupPath = `${path}.bak-${new Date().toISOString().slice(0, 10)}`;
    for (let n = 2; existsSync(backupPath); n++) backupPath = `${path}.bak${n}-${new Date().toISOString().slice(0, 10)}`; // never overwrite an earlier backup
    renameSync(path, backupPath);
    msg = `edited skill moved to ${backupPath}`;
  }
  try { rmdirSync(dirname(path)); } catch { /* backups or other files remain */ }
  return msg;
}
