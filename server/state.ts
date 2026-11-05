import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Preflow } from "./text";

export type Phase = "saving" | "compacting";
export interface AgentState {
  phase?: Phase;
  askPending: boolean; // our ask is awaiting its reply
  askedAt: number; // ms of last plugin ask
  compactedAt: number; // ms of last /compact we sent
  compactTokens?: number; // context size when that /compact was sent; a real compaction shrinks it
  compactAttempts?: number; // /compact sends in this flow (a cancelled one is retried, capped)
  nextAskAt: number; // tokens: do not ask again below this
  forced?: boolean; // flow started because tokens passed maxThreshold: compact even if the agent does not confirm the save
  preflow?: Preflow; // what the agent was doing before the flow started; sent back in the resume prompt
}

// Flow state survives plugin reloads and daemon restarts: a lost "compacting" phase means the agent is never resumed.
export const STATE_PATH = join(homedir(), ".paseo", "plugin-data", "auto-compact-assist", "state.json");

export function loadStates(): Map<string, AgentState> {
  try {
    if (existsSync(STATE_PATH)) return new Map(Object.entries(JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<string, AgentState>));
  } catch {
    // unreadable state: start clean
  }
  return new Map();
}

export function saveStates(states: Map<string, AgentState>): void {
  const live: Record<string, AgentState> = {};
  for (const [id, st] of states) if (st.phase || st.preflow || st.compactedAt || st.askedAt) live[id] = st;
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(live), { mode: 0o600 });
  renameSync(tmp, STATE_PATH);
}
