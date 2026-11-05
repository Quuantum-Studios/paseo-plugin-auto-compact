import { test } from "node:test";
import assert from "node:assert/strict";
import { compactOutcome, compactionAfterCommand } from "../server/text.ts";

const cmd = { type: "user_message", text: "/compact" };
const done = { type: "compaction", status: "completed" };
const loading = { type: "compaction", status: "loading" };
const note = { type: "user_message", text: "<paseo-system kind=\"agent-notification\">Agent finished</paseo-system>" };
const base = { tokens: 202_000, tokensAtCompact: 202_000, idle: true, sinceSendMs: 70_000, graceMs: 20_000 };

test("completed compaction after the latest /compact counts", () => {
  assert.equal(compactionAfterCommand([cmd, done]), true);
  assert.equal(compactOutcome({ ...base, items: [cmd, done], tokens: 0 }), "done");
});

test("an older /compact's compaction does not confirm a newer cancelled one", () => {
  assert.equal(compactionAfterCommand([cmd, done, { type: "assistant_message", text: "x" }, cmd, note]), false);
});

test("a loading marker alone is not a compaction", () => {
  assert.equal(compactionAfterCommand([cmd, loading]), false);
});

test("incident 2026-11-05: /compact replaced by a worker notification is cancelled, not done", () => {
  assert.equal(compactOutcome({ ...base, items: [cmd, loading, note] }), "canceled");
});

test("context shrinking confirms even when the timeline orders the item before /compact", () => {
  assert.equal(compactOutcome({ ...base, items: [done, cmd], tokens: 30_000 }), "done");
});

test("running, or idle within the grace period, is pending", () => {
  assert.equal(compactOutcome({ ...base, items: [cmd], idle: false }), "pending");
  assert.equal(compactOutcome({ ...base, items: [cmd], sinceSendMs: 5_000 }), "pending");
});
