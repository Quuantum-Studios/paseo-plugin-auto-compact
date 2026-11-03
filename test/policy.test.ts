import { test } from "node:test";
import assert from "node:assert/strict";
import { levelFor, limitsFor, normalizeConfig, parseTokens } from "../shared/options.ts";

const base = normalizeConfig({}).cfg;
const lim = { normal: 150_000, max: 250_000 };

test("levels: below normal, advise between, force above max", () => {
  assert.equal(levelFor(149_999, lim, true), "below");
  assert.equal(levelFor(150_000, lim, true), "advise");
  assert.equal(levelFor(249_999, lim, true), "advise"); // decline tolerated
  assert.equal(levelFor(250_000, lim, true), "force");
  assert.equal(levelFor(900_000, lim, false), "advise"); // forcing off
});
test("legacy thresholdTokens maps to normalThreshold", () => {
  const { cfg, warnings } = normalizeConfig({ thresholdTokens: 120000 });
  assert.equal(cfg.normalThreshold, 120_000);
  assert.equal(cfg.maxThreshold, 250_000);
  assert.deepEqual(warnings, []);
});
test("max below normal is raised to normal; bad values fall back with warnings", () => {
  const { cfg, warnings } = normalizeConfig({ normalThreshold: "300k", maxThreshold: 100, maxRisk: 500, bogus: 1, dryRun: "yes" });
  assert.equal(cfg.normalThreshold, 300_000);
  assert.equal(cfg.maxThreshold, 300_000);
  assert.equal(cfg.maxRisk, 30);
  assert.equal(cfg.dryRun, false);
  assert.ok(warnings.length >= 4);
});
test("k/m token strings", () => {
  assert.equal(parseTokens("150k"), 150_000);
  assert.equal(parseTokens("1.5M"), 1_500_000);
  assert.equal(parseTokens("abc"), null);
  assert.equal(parseTokens(0), null);
});
test("limits: provider override, then label override, max never below normal", () => {
  const cfg = normalizeConfig({ providerLimits: { codex: { normal: "100k", max: "180k" } } }).cfg;
  assert.deepEqual(limitsFor(cfg, "claude"), lim);
  assert.deepEqual(limitsFor(cfg, "codex"), { normal: 100_000, max: 180_000 });
  assert.deepEqual(limitsFor(cfg, "claude", { "autocompact.threshold": "200k" }), { normal: 200_000, max: 250_000 });
  assert.deepEqual(limitsFor(cfg, "claude", { "autocompact.threshold": "400k" }), { normal: 400_000, max: 400_000 });
  assert.deepEqual(limitsFor(base, "claude", { "autocompact.max": "300k" }), { normal: 150_000, max: 300_000 });
});
