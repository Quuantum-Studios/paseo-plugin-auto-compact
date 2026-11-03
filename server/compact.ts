import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { COMPACT_ROW_KIND } from "../shared/row";
import { ASK_DEFAULT, FORMAT, SAVE_DEFAULT, levelFor, limitsFor, readConfig } from "./config";
import { loadStates, saveStates, type AgentState } from "./state";
import { capturePreflow, compactionAfterCommand, hasReadyToCompact, latestOutputText, parseCheck, userMessageAfterCompaction } from "./text";

const WATCH_MS = 5_000; // poll cadence while a compaction is in flight
const GIVE_UP_MS = 15 * 60_000; // stop waiting for a compaction that never lands
const RESUME_ATTEMPTS = 3;

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
const RESUME_PREFIX = "Compaction done.";
const SAVE_FORCED =
  "Context limit reached ({k}k tokens): compaction is mandatory now. Run the pre-compact-save skill now (working state to files, durable learnings, skill updates), then reply with a line exactly: ready to compact";
const RESUME = (pre?: { task: string; last: string }, tpl?: string | null) =>
  tpl ? fill(tpl, { task: pre?.task ?? "", last: pre?.last ?? "" }) :
  RESUME_PREFIX +
  (pre?.task ? ` Before the flow you were working on: ${pre.task}` : "") +
  (pre?.last ? ` Last step: ${pre.last}` : "") +
  " Reread your saved notes (TODO/NOTES/memory, task files). This message is the prompt to continue: do the next unfinished step of that same work now, even if the task said to wait for a prompt. " +
  "Reply 'idle' and stop only if that work was already fully finished. Do not invent new work.";

interface Snap {
  labels?: Record<string, string>;
  archivedAt?: string | null;
  status?: string | null;
  activeTurn?: unknown;
  lastUsage?: { contextWindowUsedTokens?: number } | null;
}

export function registerCompactAssist(server: PluginServerContext) {
  const states = loadStates();
  const save = () => saveStates(states);
  const busy = new Set<string>(); // agents with a resume attempt in flight
  let paseo: PluginHandlerContext["paseo"] | null = null; // captured from the latest event; used by the watcher
  let timer: ReturnType<typeof setInterval> | null = null;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const compacting = () => [...states].filter(([, st]) => st.phase === "compacting");
  const watch = () => {
    if (timer || !compacting().length) return;
    timer = setInterval(() => {
      if (!compacting().length) { clearInterval(timer!); timer = null; return; }
      for (const [id] of compacting()) void tryResume(id);
    }, WATCH_MS);
  };

  // Resume after /compact has really finished: wait for the compaction item and an idle agent, send once, confirm delivery, retry.
  async function tryResume(id: string): Promise<void> {
    const st = states.get(id);
    if (!paseo || st?.phase !== "compacting" || busy.has(id)) return;
    busy.add(id);
    const log = (decision: string, extra: Record<string, unknown> = {}) =>
      console.log("[auto-compact] " + JSON.stringify({ agent: id.slice(0, 8), decision, ...extra }));
    try {
      const ref = paseo.agents.ref(id);
      await ref.refresh();
      const snap = ref.current() as Snap | null;
      if (!snap || snap.archivedAt) { st.phase = undefined; st.preflow = undefined; save(); log("resume-dropped", { why: "archived" }); return; }
      const page = await ref.timeline.refetch({ direction: "tail", limit: 40 });
      const items = page.entries.map(({ item }: { item: unknown }) => item);
      if (!compactionAfterCommand(items)) {
        if (Date.now() - st.compactedAt > GIVE_UP_MS) { st.phase = undefined; st.preflow = undefined; save(); log("compact-not-confirmed"); }
        return;
      }
      if (snap.activeTurn || snap.status === "running") return; // compaction turn still closing; the watcher comes back
      const cfg = await readConfig();
      if (!cfg.resume) { st.phase = undefined; st.preflow = undefined; st.forced = false; st.nextAskAt = 0; save(); log("resume-off"); return; }
      const msg = RESUME(st.preflow, cfg.resumePrompt);
      const prefix = msg.slice(0, 24);
      for (let attempt = 1; attempt <= RESUME_ATTEMPTS; attempt++) {
        await ref.send(msg);
        for (let i = 0; i < 10; i++) {
          await sleep(2_000);
          await ref.refresh();
          const cur = ref.current() as Snap | null;
          let delivered = !!cur && (!!cur.activeTurn || cur.status === "running");
          if (!delivered) {
            const tail = await ref.timeline.refetch({ direction: "tail", limit: 20 });
            delivered = userMessageAfterCompaction(tail.entries.map(({ item }: { item: unknown }) => item), prefix);
          }
          if (delivered) {
            log("resume", { attempt, task: !!st.preflow?.task });
            st.phase = undefined; st.preflow = undefined; st.forced = false; st.askPending = false; st.nextAskAt = 0;
            save();
            return;
          }
        }
        log("resume-retry", { attempt });
      }
      st.phase = undefined; save();
      log("resume-failed", { attempts: RESUME_ATTEMPTS });
    } catch (err) {
      log("resume-error", { error: String(err).slice(0, 120) });
    } finally {
      busy.delete(id);
    }
  }

  watch(); // a flow interrupted by a reload or restart is picked up once the first event supplies an API handle

  server.on("agent.turn_ended", async (event, context) => {
    const t0 = performance.now();
    const cfg = await readConfig();
    if (!cfg.enabled || event.outcome.kind !== "completed") return;
    if (!cfg.providers.includes(event.agent.provider)) return;

    paseo = context.paseo;
    watch();
    const id = event.agent.id;
    const ref = context.paseo.agents.ref(id);
    await ref.refresh();
    const snap = ref.current() as Snap | null;
    if (!snap || snap.archivedAt) return;
    if (snap.labels?.[cfg.optOutLabel] === "off") return;
    if (cfg.onlyLabel) {
      const [k, v] = cfg.onlyLabel.split("=");
      if (snap.labels?.[k] !== v) return;
    }

    const tokens = snap.lastUsage?.contextWindowUsedTokens ?? 0;
    const lim = limitsFor(cfg, event.agent.provider, snap.labels);
    const level = levelFor(tokens, lim, cfg.forceAboveMax);
    const st = states.get(id) ?? { askPending: false, askedAt: 0, compactedAt: 0, nextAskAt: lim.normal };
    states.set(id, st);

    const log = (decision: string, extra: Record<string, unknown> = {}) =>
      console.log("[auto-compact] " + JSON.stringify({ agent: id.slice(0, 8), tokens, decision, ...extra }));
    const row = (state: "asked" | "saving" | "ready", note: string) =>
      ref.timeline.append({ type: "plugin", id: "auto-compact", kind: COMPACT_ROW_KIND, version: 1, data: { state, tokens, note } });
    // Never act while a turn is running (a queued message may have started one already).
    const idle = () => !snap.activeTurn && snap.status !== "running";

    // Cheap path: below half the agent-initiated floor and nothing in flight, the transcript is never read.
    if (!st.phase && !st.askPending && tokens < Math.min(cfg.agentInitiatedMinTokens, lim.normal)) {
      if (tokens < lim.normal / 2 && st.nextAskAt !== lim.normal) st.nextAskAt = lim.normal;
      if (cfg.logLevel === "debug") log("fast-skip", { ms: Math.round(performance.now() - t0) });
      return;
    }

    const page = await ref.timeline.refetch({ direction: "tail", limit: 40 });
    const items = page.entries.map(({ item }: { item: unknown }) => item);
    const text = latestOutputText(items);
    if (cfg.logLevel === "debug") log("full-check", { ms: Math.round(performance.now() - t0) });

    // Phase: compaction in flight. The watcher also polls, so this is only a faster path.
    if (st.phase === "compacting") { await tryResume(id); return; }

    // Phase: agent was told to save; wait for "ready to compact", then /compact.
    if (st.phase === "saving") {
      if (!hasReadyToCompact(text) && st.forced) {
        log("forced-unconfirmed", { note: "above max: compacting without confirmation" });
      } else if (!hasReadyToCompact(text)) {
        st.phase = undefined; st.preflow = undefined; save();
        log("save-unconfirmed", { note: "agent did not say 'ready to compact'; not compacting" });
        await row("saving", "Agent did not confirm 'ready to compact'. Not compacting.");
        return;
      }
      if (!idle()) { log("busy-skip"); return; }
      if (!cfg.autoCompact || cfg.dryRun) {
        st.phase = undefined; st.preflow = undefined; st.forced = false; save();
        log(cfg.dryRun ? "dry-run-compact" : "ready-manual");
        await row("ready", "State saved. Type /compact in the composer.");
        return;
      }
      st.phase = "compacting"; st.compactedAt = Date.now(); st.forced = false;
      save();
      log("compact", { cmd: "/compact" });
      await row("ready", "State saved. Sending /compact now.");
      // Plugin sends reach the agent as plain user messages, so Claude runs the built-in command.
      await ref.send("/compact");
      watch();
      return;
    }

    // What the agent was doing before the flow starts; the task prompt may be far back, so widen the window once if needed.
    const snapshotPreflow = async () => {
      let pre = capturePreflow(items);
      if (!pre.task) {
        const wide = await ref.timeline.refetch({ direction: "tail", limit: 500 });
        pre = capturePreflow(wide.entries.map(({ item }: { item: unknown }) => item));
      }
      st.preflow = { task: pre.task || st.preflow?.task || "", last: pre.last };
    };

    // Re-arm after a big drop (compacted by anyone).
    if (tokens < lim.normal / 2 && st.nextAskAt !== lim.normal) st.nextAskAt = lim.normal;

    // 0. Above the max limit the agent cannot opt out: one mandatory save turn, then compact (even if the agent does not confirm).
    if (level === "force") {
      st.askPending = false;
      if (Date.now() - st.compactedAt < cfg.compactCooldownMinutes * 60_000) { log("compact-cooldown", { who: "force" }); return; }
      if (!idle()) { log("busy-skip", { who: "force" }); return; }
      if (cfg.dryRun) {
        if (Date.now() - st.askedAt < cfg.askCooldownMinutes * 60_000) return;
        st.askedAt = Date.now(); save();
        log("dry-run-force", { max: lim.max });
        return;
      }
      await snapshotPreflow();
      st.phase = "saving"; st.forced = true; save();
      log("force", { max: lim.max });
      await row("saving", `Context passed the ${Math.round(lim.max / 1000)}k limit. Saving state, then compacting.`);
      await ref.send(fill(cfg.savePrompt ?? SAVE_FORCED, { k: String(Math.round(tokens / 1000)), tokens: String(tokens) }));
      return;
    }

    // 1. A [compact-check] line: our ask's reply, or the agent's own initiative.
    const parsed = parseCheck(text);
    if (parsed.kind !== "none") {
      const own = st.askPending;
      st.askPending = false;
      if (parsed.kind === "malformed") {
        log("check-malformed", { line: parsed.line });
        st.nextAskAt = tokens + cfg.retryAfterTokens;
        return;
      }
      const c = parsed.check;
      const who = own ? "plugin-asked" : "agent-initiated";
      if (!own && tokens < Math.min(cfg.agentInitiatedMinTokens, lim.normal)) { log("ignored-too-small", { who, ...c }); return; }
      if (Date.now() - st.compactedAt < cfg.compactCooldownMinutes * 60_000) { log("compact-cooldown", { who, ...c }); return; }
      const ok = c.ready && c.risk <= cfg.maxRisk && c.confidence >= cfg.minConfidence;
      if (!ok) {
        st.nextAskAt = tokens + cfg.retryAfterTokens;
        log("declined", { who, ...c, rule: `ready=yes risk<=${cfg.maxRisk} confidence>=${cfg.minConfidence}` });
        return;
      }
      if (!idle()) { log("busy-skip", { who }); return; }
      if (cfg.dryRun) { st.nextAskAt = tokens + cfg.retryAfterTokens; log("dry-run-approved", { who, ...c }); return; }
      if (!own) await snapshotPreflow(); // plugin asks captured it before asking
      st.phase = "saving"; save();
      log("approved", { who, ...c });
      await row("saving", `Agent ready (risk ${c.risk}, confidence ${c.confidence}). Saving state first.`);
      await ref.send(fill(cfg.savePrompt ?? SAVE_DEFAULT, { k: String(Math.round(tokens / 1000)), tokens: String(tokens) }));
      return;
    }

    // 2. No check line. If we had asked, the agent ignored the format: back off.
    if (st.askPending) {
      st.askPending = false;
      st.nextAskAt = tokens + cfg.retryAfterTokens;
      log("ask-ignored");
      return;
    }

    // 3. Plugin-initiated ask at the threshold.
    if (tokens < st.nextAskAt || tokens < lim.normal) return;
    if (Date.now() - st.askedAt < cfg.askCooldownMinutes * 60_000) return;
    if (Date.now() - st.compactedAt < cfg.compactCooldownMinutes * 60_000) return;
    if (!idle()) { log("busy-skip", { who: "plugin" }); return; }
    if (cfg.dryRun) { st.askedAt = Date.now(); save(); log("dry-run-ask"); return; }
    await snapshotPreflow();
    st.askedAt = Date.now();
    st.askPending = true; save();
    log("ask");
    await row("asked", "Asking the agent whether now is a good point.");
    await ref.send(fill(cfg.askPrompt ?? ASK_DEFAULT, { k: String(Math.round(tokens / 1000)), tokens: String(tokens), format: FORMAT }));
  });

  return () => { if (timer) clearInterval(timer); timer = null; paseo = null; };
}
