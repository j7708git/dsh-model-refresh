import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/core/config.js";
import { buildPlan } from "../src/core/planner.js";
import { entry } from "./helpers.js";

const cfg = loadConfig({ configPath: "none.yaml" });
const NOW = Date.UTC(2026, 8, 5);

function fakePool(provider) {
  return [
    entry({ provider, id: "~deepseek/deepseek-v4-flash-latest", benchmarks: { intelligence: 40.8, coding: 69.1, agentic: 41.9 } }),
    entry({ provider, id: "deepseek/deepseek-v4-flash-vision-exp", inputModalities: ["text", "image"] }),
    entry({ provider, id: "z-ai/glm-5.3-flash", benchmarks: { intelligence: 46.2, coding: 71.5, agentic: 51.5 } }),
    entry({ provider, id: "qwen/qwen3.7-flash", inputModalities: ["text", "image", "video"] }),
    entry({ provider, id: "qwen/qwen3.8-flash" }),
    entry({ provider, id: "poolside/laguna-s-2.1", inPerM: 90_000, outPerM: 180_000, benchmarks: { coding: 72 } }),
    entry({ provider, id: "nvidia/nemotron-3.5-lightning:free", free: true, inPerM: 0, outPerM: 0, variant: "free" }),
  ];
}
const pools = { openrouter: fakePool("openrouter"), nous: fakePool("nous") };
const emptyCurrent = { openrouter: { models: [], exists: false }, "nous-api": { models: [], exists: false } };

function asSettings(planRoutes) {
  const out = {};
  for (const [k, r] of Object.entries(planRoutes)) out[k] = { exists: true, models: r.entries.map((e) => ({ ...e })) };
  return out;
}

test("drift: user-added entry is adopted as imported and survives", () => {
  const r1 = buildPlan({ cfg, pools, current: emptyCurrent, state: null, agentDefault: null, nowMs: NOW });
  const cur2 = asSettings(r1.plan.routes);
  cur2.openrouter.models.push({ id: "user/extra", name: "User Pick", contextWindow: 300000 });
  const r2 = buildPlan({ cfg, pools, current: cur2, state: r1.statePatch, agentDefault: null, nowMs: NOW + 1000 });
  assert.deepEqual(r2.report.removed, [], "the adopted entry is never removed");
  const rules = r2.plan.routes.openrouter;
  assert.equal(rules.rules[r2.plan.routes.openrouter.entries.findIndex((e) => e.id === "user/extra")], "imported");
  // run 3: it is now a known imported — still there, un-duplicated
  const r3 = buildPlan({ cfg, pools, current: asSettings(r2.plan.routes), state: r2.statePatch, agentDefault: null, nowMs: NOW + 2000 });
  const count = r3.plan.routes.openrouter.entries.filter((e) => e.id === "user/extra").length;
  assert.equal(count, 1, "no duplication across runs");
});

test("drift: user-edited imported fields are kept (settings is source of truth)", () => {
  const r1 = buildPlan({ cfg, pools, current: emptyCurrent, state: null, agentDefault: null, nowMs: NOW });
  const cur2 = asSettings(r1.plan.routes);
  const imp = cur2.openrouter.models.find((m) => m.id === "poolside/laguna-s-2.1");
  imp.name = "我改的名";
  imp.maxTokens = 4096;
  const r2 = buildPlan({ cfg, pools, current: cur2, state: r1.statePatch, agentDefault: null, nowMs: NOW + 1000 });
  const row = r2.plan.routes.openrouter.entries.find((e) => e.id === "poolside/laguna-s-2.1");
  // laguna is a tool candidate (regenerated), but the user pick in `nous` route stays imported?
  // Both providers carry the same pool, so it is a candidate on both routes → tool-owned.
  // Use an entry the rules do NOT claim: user/extra from the previous test style.
  cur2.openrouter.models.push({ id: "user/keep", name: "原始", maxTokens: 123 });
  const r3 = buildPlan({ cfg, pools, current: cur2, state: r2.statePatch, agentDefault: null, nowMs: NOW + 2000 });
  cur2.openrouter.models.find((m) => m.id === "user/keep").name = "改過的";
  const r4 = buildPlan({ cfg, pools, current: cur2, state: r3.statePatch, agentDefault: null, nowMs: NOW + 3000 });
  const keep = r4.plan.routes.openrouter.entries.find((e) => e.id === "user/keep");
  assert.equal(keep.name, "改過的", "imported entries track user edits");
  assert.equal(keep.maxTokens, 123);
  void row;
});

test("drift: manual deletion of a managed free entry suppresses it; pins are restored", () => {
  const r1 = buildPlan({ cfg, pools, current: emptyCurrent, state: null, agentDefault: null, nowMs: NOW });
  const cur2 = asSettings(r1.plan.routes);
  const freeId = r1.plan.routes.openrouter.entries.find((e) => e.rule === undefined && e.id.endsWith(":free"))?.id ?? "nvidia/nemotron-3.5-lightning:free";
  cur2.openrouter.models = cur2.openrouter.models.filter((m) => m.id !== freeId && m.id !== "z-ai/glm-5.3-flash");
  const r2 = buildPlan({ cfg, pools, current: cur2, state: r1.statePatch, agentDefault: null, nowMs: NOW + 1000 });
  const ids = r2.plan.routes.openrouter.entries.map((e) => e.id);
  assert.ok(!ids.includes(freeId), `deleted free ${freeId} not re-added`);
  assert.ok(r2.statePatch.suppressedIds.openrouter.includes(freeId));
  assert.ok(ids.includes("z-ai/glm-5.3-flash"), "deleted pin is restored");
  assert.ok(r2.report.warnings.some((w) => w.includes("自動恢復")));
  // and it stays out on a third run even though the pool still offers it
  const r3 = buildPlan({ cfg, pools, current: asSettings(r2.plan.routes), state: r2.statePatch, agentDefault: null, nowMs: NOW + 2000 });
  assert.ok(!r3.plan.routes.openrouter.entries.map((e) => e.id).includes(freeId));
});
