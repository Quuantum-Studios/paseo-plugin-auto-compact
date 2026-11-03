// Generated from the tested helper script and skill. Installed only by the opt-in Command Center actions.
export const MY_CONTEXT_SCRIPT = `#!/usr/bin/env python3
"""Print this agent's current context size: ctx=<tokens> threshold=<t> <ok|consider|compact>.
Uses $PASEO_AGENT_ID -> ~/.paseo/agents/*/<id>.json (persistence.sessionId) -> <sessionId>.jsonl last usage.
Without PASEO_AGENT_ID: newest transcript for the current directory. Reads only the file tail."""
import glob, json, os, sys

HOME = os.path.expanduser("~")
DEFAULT_THRESHOLD = 150000

def threshold():
    try:
        return int(json.load(open(f"{HOME}/.paseo/plugin-data/auto-compact-assist/config.json")).get("thresholdTokens", DEFAULT_THRESHOLD))
    except Exception:
        return DEFAULT_THRESHOLD

def roots():
    return [f"{HOME}/.claude/projects"] + glob.glob(f"{HOME}/.paseo/zerosub/homes/*/projects")

def transcript():
    aid = os.environ.get("PASEO_AGENT_ID", "")
    if aid:
        for rec in glob.glob(f"{HOME}/.paseo/agents/*/{aid}.json"):
            try:
                sid = (json.load(open(rec)).get("persistence") or {}).get("sessionId")
            except Exception:
                continue
            files = [f for r in roots() for f in glob.glob(f"{r}/*/{sid}.jsonl")] if sid else []
            if files:
                return max(files, key=os.path.getmtime)
    # fallback: newest transcript for this directory
    enc = os.getcwd().replace("/", "-").replace(".", "-").replace("_", "-")
    files = [f for r in roots() for f in glob.glob(f"{r}/{enc}/*.jsonl")]
    return max(files, key=os.path.getmtime) if files else None

def tail_lines(path, nbytes=400_000):
    with open(path, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - nbytes))
        return f.read().decode("utf-8", "ignore").splitlines()

def context_tokens(path):
    for line in reversed(tail_lines(path)):
        if "compact_boundary" in line:  # compaction after the last usage: use its post size
            try:
                return json.loads(line)["compactMetadata"]["postTokens"]
            except Exception:
                continue
        if '"usage"' not in line:
            continue
        try:
            u = json.loads(line).get("message", {}).get("usage")
        except Exception:
            continue
        if u:
            return u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
    return None

def hook_mode():
    """PostToolUse hook: silent unless the plugin is enabled, this is a Paseo agent, ctx >= threshold, and not reminded in the last 10 min."""
    import time
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    try:
        cfg = json.load(open(f"{HOME}/.paseo/plugin-data/auto-compact-assist/config.json"))
    except Exception:
        cfg = {}
    if not cfg.get("enabled") or not os.environ.get("PASEO_AGENT_ID"):
        return
    path = data.get("transcript_path")
    n = context_tokens(path) if path and os.path.exists(path) else None
    t = int(cfg.get("thresholdTokens", DEFAULT_THRESHOLD))
    if n is None or n < t:
        return
    stamp = f"/tmp/my-context-remind-{data.get('session_id', 'x')}"
    try:
        if time.time() - os.path.getmtime(stamp) < 600:
            return
    except OSError:
        pass
    open(stamp, "w").close()
    msg = (f"Context is ~{n // 1000}k tokens (threshold {t // 1000}k). At your next safe point (nothing mid-edit, no unsaved reasoning) "
           "end your reply with: [compact-check] ctx=<n> ready=<yes|no> quality_risk=<0-100> confidence=<0-100> reason=<few words>. See the pre-compact-save skill.")
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg}}))

if "--hook" in sys.argv:
    hook_mode()
    sys.exit(0)

t = threshold()
path = transcript()
n = context_tokens(path) if path else None
if n is None:
    print(f"ctx=unknown threshold={t} ok")
    sys.exit(0)
hint = "compact" if n >= t else "consider" if n >= t * 0.5 else "ok"
print(f"ctx={n} threshold={t} {hint}")
`;

export const PRE_COMPACT_SKILL = `---
name: pre-compact-save
description: Run before ANY context compaction (/compact, auto-compact, new session handoff), and use its [compact-check] protocol to ask for a compaction yourself. Saves working state to project files, durable learnings, and skill improvements, then says "ready to compact". Use when told to compact, when \`my-context\` says \`compact\` at a natural stopping point, or when asked "save before compacting".
---

# Pre-compact save

Compaction keeps a lossy summary; anything not on disk may be lost. Never write secrets anywhere.

## When to check your context (all agents, on your own initiative)
Agents cannot see their token count, so run \`my-context\` (in \`~/.local/bin\`, instant). It prints \`ctx=<tokens> threshold=<t> <ok|consider|compact>\`.
- Run it at natural stopping points: after finishing a sub-task, before starting a big new one, before a long read/search. Not every turn.
- \`ok\`: carry on. \`consider\`: fine to wait for the next stopping point. \`compact\`: emit the \`[compact-check]\` line (below) at the end of this turn, if safe.
- Safe means nothing mid-edit, no unsaved reasoning, no open thread you would lose. If unsafe, emit \`ready=no\` or just carry on and re-check at the next stopping point.
- Put the real number from \`my-context\` in \`ctx=\`. If it prints \`ctx=unknown\`, skip the check.

## Protocol with the auto-compact plugin (all agents)
One line, anywhere in your reply (it need not be last; a status line may follow):

    [compact-check] ctx=<estimate> ready=<yes|no> quality_risk=<0-100> confidence=<0-100> reason=<few words, max 80 chars>

- \`ctx\` is the number from \`my-context\`; the plugin uses its own measurement anyway.
- \`ready=yes\` only if compacting now would not hurt your work: nothing mid-edit, no unsaved reasoning, no open thread you would forget.
- \`quality_risk\`: your estimate that compaction degrades the task (0 safe, 100 certain). \`confidence\`: how sure you are of that estimate.
- The plugin compacts only when \`ready=yes\`, risk <= 30 and confidence >= 70 (defaults). Otherwise it re-asks later. \`ready=no\` is always fine.
- Plugin ask: when context is large the plugin asks you; answer with exactly one such line.
- Your own initiative: at a natural stopping point, run \`my-context\`; if it says \`compact\`, end your turn with the line. The plugin honours it from 75k tokens up.
- If the plugin then says "Compaction approved", do steps 1-3 below and reply with the exact line \`ready to compact\`. The plugin then sends \`/compact\` and afterwards "resume from your saved notes": reread your notes and continue.
- Opt out: an agent labelled \`autocompact=off\` is never touched. Do not emit the line while a user is actively mid-conversation with you about live work.

## 1. Working state -> files
Write to the project's own notes: \`TODO.md\`, \`NOTES.md\`, or \`memory/\` (else create \`TODO.md\` at the repo/worktree root, or the task's data dir if given). Include: goal, done, next, branch/PR/worktree paths, commands to re-run, failing tests or open questions, decisions and why. A cold reader must resume from it alone.

## 2. Durable learnings
Facts true beyond this task (tool quirks, paths, recipes, failure modes + fixes): append one dated line each to the project's learnings/memory file. Skip what the repo or an existing note already records.

## 3. Skills
For each skill used or missed this session: if a step was wrong, missing, or needed a workaround, fix it (minimal edit, back up first: \`cp SKILL.md SKILL.md.bak-<date>\`). If a repeatable procedure was done by hand, add or draft a skill. Global skills (\`~/.claude/skills\`): edit only if the user already allowed it; otherwise list the proposed change in the notes file.

## 4. Confirm
Reply with: files written (paths), skills changed, then the line \`ready to compact\`. If a step has nothing to save, say "nothing" and move on.
`;
