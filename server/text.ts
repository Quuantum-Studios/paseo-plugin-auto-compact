// Joins the text of the latest assistant output (everything after the last user message).
export function latestOutputText(items: readonly unknown[]): string {
  let out = "";
  for (const raw of items) {
    const item = raw as { type?: string; text?: unknown };
    if (item.type === "user_message") out = "";
    else if (typeof item.text === "string") out += item.text;
  }
  return out;
}

export function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

// Protocol line, one per turn, anywhere in the reply (crewmates must end with a status line, so it need not be last):
//   [compact-check] ctx=<estimate, e.g. 120000 or ~120k> ready=<yes|no> quality_risk=<0-100> confidence=<0-100> reason=<free text, <=80 chars>
const CHECK = /^\[compact-check\] ctx=(\S{1,12}) ready=(yes|no) quality_risk=(\d{1,3}) confidence=(\d{1,3}) reason=(.{0,80})$/;

export interface CompactCheck {
  ctx: string; // the agent's own estimate, informational only; the plugin trusts its measured token count
  ready: boolean;
  risk: number;
  confidence: number;
  reason: string;
}

export type ParsedCheck = { kind: "none" } | { kind: "malformed"; line: string } | { kind: "ok"; check: CompactCheck };

export function parseCheck(text: string): ParsedCheck {
  const candidates = lines(text).filter((l) => l.startsWith("[compact-check]"));
  const line = candidates[candidates.length - 1]; // the last one wins
  if (!line) return { kind: "none" };
  const m = CHECK.exec(line);
  if (!m) return { kind: "malformed", line: line.slice(0, 120) };
  const risk = Number(m[3]);
  const confidence = Number(m[4]);
  if (risk > 100 || confidence > 100) return { kind: "malformed", line: line.slice(0, 120) };
  return { kind: "ok", check: { ctx: m[1], ready: m[2] === "yes", risk, confidence, reason: m[5] } };
}

export function hasReadyToCompact(text: string): boolean {
  return lines(text).some((l) => l.toLowerCase() === "ready to compact");
}

// True when a completed compaction item follows the latest "/compact" user message.
// A cancelled /compact leaves no completed item (at most a "loading" marker), so an older
// /compact's compaction must not count: each /compact resets the search.
export function compactionAfterCommand(items: readonly unknown[]): boolean {
  let seen = false;
  let done = false;
  for (const raw of items) {
    const item = raw as { type?: string; text?: unknown; status?: string };
    if (item.type === "user_message" && typeof item.text === "string" && item.text.trim().startsWith("/compact")) { seen = true; done = false; }
    else if (seen && item.type === "compaction" && item.status === "completed") done = true;
  }
  return done;
}

// Did the /compact we sent really compact? "done": a completed compaction follows our /compact, or the
// context shrank to under half of what it was when we sent it. "pending": still running, or too early to
// tell. "canceled": the agent is idle again, nothing compacted and the context did not shrink (Paseo
// replaces a running /compact turn when another agent's message arrives, which cancels the compaction).
export type CompactOutcome = "done" | "pending" | "canceled";
export function compactOutcome(input: {
  items: readonly unknown[];
  tokens: number; // context now
  tokensAtCompact: number; // context when /compact was sent (0 = unknown)
  idle: boolean;
  sinceSendMs: number;
  graceMs: number; // an idle agent right after the send may simply not have started the command yet
}): CompactOutcome {
  if (compactionAfterCommand(input.items)) return "done";
  if (input.tokensAtCompact > 0 && input.tokens > 0 && input.tokens < input.tokensAtCompact / 2) return "done";
  if (!input.idle || input.sinceSendMs < input.graceMs) return "pending";
  return "canceled";
}

const OUR_PREFIXES = ["Context is about", "Compaction approved.", "Compaction done.", "Context was compacted.", "/compact"];

// Plain text of a user message with any <paseo-system ...> envelope tags removed.
function plain(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Drops anything that looks like a credential, then truncates (stored excerpts are written to disk and re-sent).
export function scrub(text: string, max: number): string {
  const s = text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b(sk|pk|ghp|gho|xox[abp]|AKIA|AIza|npm)[-_A-Za-z0-9]{12,}/g, "[redacted]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+\/_-]{40,}\b/g, "[redacted]");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export interface Preflow {
  task: string; // last real user/task prompt, scrubbed and truncated
  last: string; // tail of the last assistant output, scrubbed and truncated
}

// The agent's last real task prompt (not one of ours) and the tail of the output after it.
export function capturePreflow(items: readonly unknown[]): Preflow {
  let task = "";
  let last = "";
  for (const raw of items) {
    const item = raw as { type?: string; text?: unknown; name?: string; agentMessage?: { event?: string; text?: unknown } };
    // A message from another agent (e.g. the first mate) arrives as a tool_call item named agent_message.
    const fromAgent = item.type === "tool_call" && item.name === "agent_message" && item.agentMessage?.event === "message";
    const text = fromAgent ? item.agentMessage?.text : item.text;
    if (typeof text !== "string") continue;
    if (item.type === "user_message" || fromAgent) {
      const t = plain(text);
      if (OUR_PREFIXES.some((p) => t.startsWith(p))) continue;
      task = t;
      last = "";
    } else if (item.type !== "tool_call") {
      last += text;
    }
  }
  const cleaned = last.split("\n").filter((l) => !l.trim().startsWith("[compact-check]")).join("\n").trim();
  return { task: scrub(task, 500), last: scrub(cleaned.slice(-700), 600) };
}

export function userMessageAfterCompaction(items: readonly unknown[], prefix: string): boolean {
  let seen = false;
  for (const raw of items) {
    const item = raw as { type?: string; text?: unknown };
    if (item.type === "compaction") seen = true;
    else if (seen && item.type === "user_message" && typeof item.text === "string" && plain(item.text).startsWith(prefix)) return true;
  }
  return false;
}
