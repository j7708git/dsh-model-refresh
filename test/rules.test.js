import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/core/config.js";
import { resolvePins, makeScorer, selectFree, selectCandidates, structurallyEligible, familyOf } from "../src/core/rules.js";
import { entry, DAY } from "./helpers.js";

const cfg = loadConfig({ configPath: "none.yaml" });
const NOW = Date.UTC(2026, 8, 5);

function pinPool() {
  return [
    entry({ id: "~deepseek/deepseek-v4-flash-latest", benchmarks: { intelligence: 40.8, coding: 69.1, agentic: 41.9 } }),
    entry({ id: "deepseek/deepseek-v4-flash-vision-exp", inputModalities: ["text", "image"] }),
    entry({ id: "z-ai/glm-5.3-flash", benchmarks: { intelligence: 46.2, coding: 71.5, agentic: 51.5 } }),
    entry({ id: "qwen/qwen3.7-flash", inputModalities: ["text", "image", "video"] }),
    entry({ id: "qwen/qwen3.8-flash" }),
  ];
}

test("R2 resolvePins: hits, fallback candidate order, missing", () => {
  const pool = pinPool();
  const { resolved, missing } = resolvePins(cfg, pool, "openrouter");
  assert.deepEqual(missing, []);
  assert.equal(resolved.length, 5);
  assert.equal(resolved[0].entry.id, "~deepseek/deepseek-v4-flash-latest");
  // pool without glm → missing key reported
  const { resolved: r2, missing: m2 } = resolvePins(cfg, pool.filter((e) => !e.id.includes("glm")), "openrouter");
  assert.deepEqual(m2, ["glm-5.3-flash"]);
  assert.equal(r2.length, 4);
  // candidate fallback: first listed id absent, second found
  const cfg2 = structuredClone(cfg);
  cfg2.pins[2].byProvider.openrouter = ["z-ai/glm-5.3-flash-latest", "z-ai/glm-5.3-flash"];
  const { resolved: r3 } = resolvePins(cfg2, pool, "openrouter");
  assert.equal(r3.find((r) => r.pinKey === "glm-5.3-flash").entry.id, "z-ai/glm-5.3-flash");
});

test("makeScorer: AA scoring vs pin baseline; proxy for missing AA", () => {
  const pool = pinPool();
  const { resolved } = resolvePins(cfg, pool, "openrouter");
  const score = makeScorer(cfg, pool, resolved);
  // identical to baseline medians → ~100
  const same = score(entry({ id: "m/same", benchmarks: { intelligence: 43.5, coding: 70.3, agentic: 46.7 } }));
  assert.ok(Math.abs(same.score - 100) < 2, `expected ~100, got ${same.score}`);
  assert.equal(same.unverified, false);
  // stronger → >100
  assert.ok(score(entry({ id: "m/strong", benchmarks: { intelligence: 60, coding: 90, agentic: 70 } })).score > 100);
  // no AA → unverified proxy below qualify line by itself
  const prox = score(entry({ id: "m/proxy", description: "plain model" }));
  assert.equal(prox.unverified, true);
  assert.ok(prox.score < 95, `proxy should stay < qualify line, got ${prox.score}`);
});

test("R1 selectFree: zero-price + tools + ctx, prefers :free twin, cap, boosted first", () => {
  const pool = [
    entry({ id: "a/free-base", free: true, inPerM: 0, outPerM: 0 }),
    entry({ id: "a/free-base:free", free: true, inPerM: 0, outPerM: 0, variant: "free" }),
    entry({ id: "b/boost", free: true, inPerM: 0, outPerM: 0, variant: "free", portalRecommendedFree: true }),
    entry({ id: "c/no-tools", free: true, inPerM: 0, outPerM: 0, variant: "free", supportsTools: false }),
    entry({ id: "d/small-ctx", free: true, inPerM: 0, outPerM: 0, variant: "free", contextWindow: 131072 }),
    entry({ id: "e/embed", free: true, inPerM: 0, outPerM: 0, variant: "free", outputsText: false }),
    entry({ id: "~f/router", free: true, inPerM: 0, outPerM: 0, variant: "router" }),
  ];
  const score = makeScorer(cfg, [], []);
  const picked = selectFree(cfg, pool, score, new Set());
  const ids = picked.map((p) => p.entry.id);
  assert.ok(ids.includes("a/free-base:free"), "the :free twin should win over base");
  assert.ok(!ids.includes("a/free-base"), "base twin excluded");
  assert.ok(!ids.includes("c/no-tools") && !ids.includes("d/small-ctx") && !ids.includes("e/embed") && !ids.includes("~f/router"));
  assert.equal(picked[0].entry.id, "b/boost", "portal-recommended boosted to front");
});

test("R1 cap respected", () => {
  const pool = Array.from({ length: cfg.free.maxPerProvider + 5 }, (_, i) =>
    entry({ id: `f/x${i}`, free: true, inPerM: 0, outPerM: 0, variant: "free" }));
  const score = makeScorer(cfg, [], []);
  assert.equal(selectFree(cfg, pool, score, new Set()).length, cfg.free.maxPerProvider);
});

test("R3 hard filters: price boundary, batch, pins excluded", () => {
  const pool = [...pinPool(),
    entry({ id: "p/at-1-usd", inPerM: 1_000_000, outPerM: 1_000_000, benchmarks: { intelligence: 50, coding: 80, agentic: 55 } }),
    entry({ id: "p/over-1-usd", inPerM: 900_000, outPerM: 1_000_001 }),
    entry({ id: "p/batch:batch", inPerM: 10, outPerM: 10 }),
    entry({ id: "p/preview", inPerM: 10, outPerM: 10, benchmarks: { intelligence: 99 } }),
    entry({ id: "p/no-tools", supportsTools: false }),
  ];
  const { resolved } = resolvePins(cfg, pool, "openrouter");
  const score = makeScorer(cfg, pool, resolved);
  const taken = new Set(resolved.map((r) => r.entry.id));
  const { entries } = selectCandidates(cfg, pool, score, taken, { nowMs: NOW, provider: "openrouter", excludePinIds: taken });
  const ids = entries.map((e) => e.entry.id);
  assert.ok(ids.includes("p/at-1-usd"), "exactly $1.00 passes (<=)");
  assert.ok(!ids.includes("p/over-1-usd"));
  assert.ok(!ids.includes("p/batch:batch"));
  assert.ok(!ids.includes("p/preview"), "preview pattern excluded");
  assert.ok(!ids.includes("p/no-tools"));
  assert.ok(!ids.some((id) => taken.has(id)), "pins never candidates");
});

test("R3 tiered-price note only, not exclusion", () => {
  const pool = [entry({ id: "t/tiered", inPerM: 30_000, outPerM: 130_000, priceTiers: [{ minTokens: 256000, inPerM: 200_000, outPerM: 800_000 }] })];
  const { entries, notes } = selectCandidates(cfg, pool, makeScorer(cfg, pool, []), new Set(), { nowMs: NOW, provider: "openrouter", excludePinIds: new Set() });
  assert.equal(entries.map((e) => e.entry.id).includes("t/tiered"), true);
  assert.ok(!notes.some((n) => n.startsWith("tiered price above")));
  const pool2 = [entry({ id: "t/steep", inPerM: 30_000, outPerM: 130_000, priceTiers: [{ minTokens: 256000, inPerM: 2_000_000, outPerM: 2_000_000 }] })];
  const r2 = selectCandidates(cfg, pool2, makeScorer(cfg, pool2, []), new Set(), { nowMs: NOW, provider: "openrouter", excludePinIds: new Set() });
  assert.ok(r2.notes.some((n) => n.includes("t/steep")), "higher-tier above $1 noted");
});

test("R3 hysteresis: challenger must accumulate behindNeeded pressure cycles before a swap", () => {
  const cfg2 = structuredClone(cfg);
  cfg2.candidates.target = 1; cfg2.candidates.max = 1; cfg2.candidates.min = 1;
  cfg2.candidates.fallbackToUnverified = false;
  // baseline from one synthetic pin (45/70/50) → incumbent scores ~100, challenger ~121
  const pins = [{ pinKey: "b", entry: entry({ id: "pin/b", benchmarks: { intelligence: 45, coding: 70, agentic: 50 } }) }];
  const incumbent = entry({ id: "h/incumbent", inPerM: 500_000, outPerM: 500_000, benchmarks: { intelligence: 45, coding: 70, agentic: 50 } });
  const challenger = entry({ id: "h/challenger", inPerM: 400_000, outPerM: 400_000, benchmarks: { intelligence: 55, coding: 85, agentic: 60 } });
  const pool = [incumbent, challenger];
  const score = makeScorer(cfg2, pool, pins);
  const led0 = { incumbents: { "h/incumbent": { score: 100, enteredAt: new Date(NOW - 30 * DAY).toISOString(), behind: 0 } } };

  // cycle 1: pressure 1 of 2 → incumbent stays
  const r1 = selectCandidates(cfg2, pool, score, new Set(), { nowMs: NOW, ledger: led0, provider: "openrouter", excludePinIds: new Set() });
  assert.deepEqual(r1.entries.map((e) => e.entry.id), ["h/incumbent"], "no swap on first pressure cycle");
  assert.equal(r1.ledger.incumbents["h/incumbent"].behind, 1);
  assert.ok(r1.notes.some((n) => n.includes("replacement pressure")));

  // cycle 2 (ledger carried over): behind hits 2 → swap executes
  const r2 = selectCandidates(cfg2, pool, score, new Set(), { nowMs: NOW + DAY, ledger: r1.ledger, provider: "openrouter", excludePinIds: new Set() });
  assert.deepEqual(r2.entries.map((e) => e.entry.id), ["h/challenger"], "swap after behindNeeded cycles");
  assert.ok(r2.notes.some((n) => n.includes("incumbent out: h/incumbent")));

  // cooldown: a just-entered incumbent resists swap even at full pressure
  const superModel = entry({ id: "h/super", inPerM: 300_000, outPerM: 300_000, benchmarks: { intelligence: 70, coding: 99, agentic: 90 } });
  const led3 = { incumbents: { "h/challenger": { score: 121, enteredAt: new Date(NOW + DAY).toISOString(), behind: 5 } } };
  const r3 = selectCandidates(cfg2, [challenger, superModel], score, new Set(), { nowMs: NOW + DAY, ledger: led3, provider: "openrouter", excludePinIds: new Set() });
  assert.deepEqual(r3.entries.map((e) => e.entry.id), ["h/challenger"], "cooldown protects a fresh incumbent");
  assert.ok(r3.notes.some((n) => n.includes("cooldown")));
});

test("familyOf: pin-family candidates excluded; same-family twins dedup to newest", () => {
  assert.equal(familyOf("~deepseek/deepseek-v4-flash-latest"), familyOf("deepseek/deepseek-v4-flash-0731"));
  assert.equal(familyOf("meta/muse-spark-1.3-contributor"), familyOf("meta/muse-spark-1.2-contributor"));
  assert.notEqual(familyOf("deepseek/deepseek-v4-flash"), familyOf("deepseek/deepseek-v4-pro"));
  const pins = [entry({ id: "~deepseek/deepseek-v4-flash-latest", benchmarks: { intelligence: 45, coding: 70, agentic: 50 } })];
  const pool = [...pins,
    entry({ id: "deepseek/deepseek-v4-flash-0731", benchmarks: { intelligence: 45, coding: 70, agentic: 50 } }),
    entry({ id: "meta/muse-spark-1.3-contributor", inPerM: 100_000, outPerM: 200_000, created: 3 }),
    entry({ id: "meta/muse-spark-1.2-contributor", inPerM: 100_000, outPerM: 200_000, created: 2 }),
  ];
  const { resolved } = resolvePins(cfg, pool, "openrouter");
  const score = makeScorer(cfg, pool, resolved);
  const taken = new Set(resolved.map((r) => r.entry.id));
  const { entries, notes } = selectCandidates(cfg, pool, score, taken, { nowMs: NOW, provider: "openrouter", excludePinIds: taken });
  const ids = entries.map((e) => e.entry.id);
  assert.ok(!ids.includes("deepseek/deepseek-v4-flash-0731"), "pin-family candidate excluded");
  assert.ok(!ids.includes("meta/muse-spark-1.2-contributor"), "older family twin deduped out");
  assert.ok(ids.includes("meta/muse-spark-1.3-contributor"));
  assert.ok(notes.some((n) => n.includes("same family as a pin")));
});

test("R3 price violation ejects incumbent immediately", () => {
  const expensive = entry({ id: "h/gone", inPerM: 1_500_000, outPerM: 2_000_000, benchmarks: { intelligence: 99, coding: 99, agentic: 99 } });
  const ledger = { incumbents: { "h/gone": { score: 120, enteredAt: new Date(NOW - 90 * DAY).toISOString(), behind: 0 } } };
  const { entries, notes } = selectCandidates(cfg, [expensive], makeScorer(cfg, [], []), new Set(), { nowMs: NOW, ledger, provider: "openrouter", excludePinIds: new Set() });
  assert.equal(entries.length, 0);
  assert.ok(notes.some((n) => n.includes("dropped by hard filter")));
});
