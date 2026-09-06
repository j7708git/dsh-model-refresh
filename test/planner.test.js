import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/core/config.js";
import { buildPlan } from "../src/core/planner.js";
import { entry } from "./helpers.js";

const cfg = loadConfig({ configPath: "none.yaml" });
const NOW = Date.UTC(2026, 8, 5);

function fakePool(provider) {
  return [
    // five pins (as present in real catalogs)
    entry({ provider, id: "~deepseek/deepseek-v4-flash-latest", benchmarks: { intelligence: 40.8, coding: 69.1, agentic: 41.9 } }),
    entry({ provider, id: "deepseek/deepseek-v4-flash-vision-exp", inputModalities: ["text", "image"] }),
    entry({ provider, id: "z-ai/glm-5.3-flash", benchmarks: { intelligence: 46.2, coding: 71.5, agentic: 51.5 } }),
    entry({ provider, id: "qwen/qwen3.7-flash", inputModalities: ["text", "image", "video"] }),
    entry({ provider, id: "qwen/qwen3.8-flash" }),
    // a candidate (AA above line) and a free model
    entry({ provider, id: "poolside/laguna-s-2.1", inPerM: 90_000, outPerM: 180_000, benchmarks: { coding: 72 }, description: "coding agent model, Terminal-Bench 2.1 70.2%" }),
    entry({ provider, id: "nvidia/nemotron-3.5-lightning:free", free: true, inPerM: 0, outPerM: 0, variant: "free" }),
    entry({ provider, id: "nvidia/nemotron-3.5-lightning", inPerM: 80_000, outPerM: 200_000, benchmarks: { coding: 26.8 } }),
  ];
}

const emptyCurrent = { openrouter: { models: [], exists: false }, "nous-api": { models: [], exists: false } };

test("first run on empty settings: pins + candidate + free assembled", () => {
  const pools = { openrouter: fakePool("openrouter"), nous: fakePool("nous") };
  const { plan, report, statePatch } = buildPlan({ cfg, pools, current: emptyCurrent, state: null, agentDefault: null, nowMs: NOW });
  const or = plan.routes.openrouter;
  assert.ok(or, "openrouter route planned");
  assert.deepEqual(or.rules.slice(0, 5), ["pin", "pin", "pin", "pin", "pin"], "pins first");
  assert.ok(or.rules.includes("candidate"));
  assert.ok(or.rules.includes("free"));
  const ids = or.entries.map((e) => e.id);
  assert.ok(ids.includes("~deepseek/deepseek-v4-flash-latest"));
  assert.ok(!report.removed.length, "nothing removed on a clean start");
  // vision pin gets input, text-only pin doesn't
  const vision = or.entries.find((e) => e.id === "deepseek/deepseek-v4-flash-vision-exp");
  assert.deepEqual(vision.input, ["text", "image"]);
  const glm = or.entries.find((e) => e.id === "z-ai/glm-5.3-flash");
  assert.equal(glm.input, undefined);
  // free entry renamed with [Free]
  assert.ok(or.entries.find((e) => e.id === "nvidia/nemotron-3.5-lightning:free").name.startsWith("[Free] "));
  // state patch has ledger + managed ids for a second run
  assert.ok(statePatch.candidateLedgers.openrouter.incumbents["poolside/laguna-s-2.1"]);
});

test("first-run takeover is additions-only (imported preserved)", () => {
  const pools = { openrouter: fakePool("openrouter"), nous: fakePool("nous") };
  const current = {
    openrouter: {
      exists: true,
      models: [
        { id: "openrouter/free", name: "Free Models Router", contextWindow: 200000, maxTokens: 4096 },
        { id: "qwen/qwen3.8-flash", name: "Kept Custom", maxTokens: 4096 }, // pin overlap: keep user's fields
      ],
    },
    "nous-api": { exists: true, models: [{ id: "moonshotai/kimi-k3", name: "Kimi K3", contextWindow: 1048576 }] },
  };
  const { plan, report } = buildPlan({ cfg, pools, current, state: null, agentDefault: null, nowMs: NOW });
  assert.deepEqual(report.removed, [], "acceptance §12-5: no removals on first takeover");
  const orIds = plan.routes.openrouter.entries.map((e) => e.id);
  const nousIds = plan.routes["nous-api"].entries.map((e) => e.id);
  assert.ok(orIds.includes("openrouter/free"), "imported kept");
  assert.ok(nousIds.includes("moonshotai/kimi-k3"), "imported kept on nous route too");
  // the user's custom fields on an id that is also a pin survive takeover
  const pinRow = plan.routes.openrouter.entries.find((e) => e.id === "qwen/qwen3.8-flash");
  assert.equal(pinRow.maxTokens, 4096);
  assert.equal(pinRow.name, "Kept Custom");
});

test("second run replays imported entries and keeps ordering pins→candidates→imported→free", () => {
  const pools = { openrouter: fakePool("openrouter"), nous: fakePool("nous") };
  const current1 = {
    openrouter: { exists: true, models: [{ id: "openrouter/free", name: "Free Models Router", contextWindow: 200000, maxTokens: 4096 }] },
    "nous-api": { exists: false, models: [] },
  };
  const r1 = buildPlan({ cfg, pools, current: current1, state: null, agentDefault: null, nowMs: NOW });
  assert.ok(r1.plan.routes.openrouter.rules.includes("imported"), "seed imported exists on first run");
  const asSettings = { openrouter: { exists: true, models: r1.plan.routes.openrouter.entries }, "nous-api": { exists: true, models: r1.plan.routes["nous-api"].entries } };
  const r2 = buildPlan({ cfg, pools, current: asSettings, state: r1.statePatch, agentDefault: null, nowMs: NOW + 3600_000 });
  const rules = r2.plan.routes.openrouter.rules;
  assert.ok(rules.indexOf("candidate") < rules.indexOf("imported"), "candidates before imported");
  assert.ok(rules.indexOf("imported") < rules.lastIndexOf("free"), "free last");
  assert.deepEqual(r2.report.removed, [], "steady state: nothing removed");
});

test("agent-default protection: the live default model is never dropped", () => {
  const pools = { openrouter: fakePool("openrouter"), nous: fakePool("nous") };
  const current = {
    openrouter: { exists: true, models: [{ id: "custom/not-in-catalog", name: "Legacy Pick" }], },
    "nous-api": { exists: false, models: [] },
  };
  const { plan, report } = buildPlan({ cfg, pools, current, state: null, agentDefault: { provider: "openrouter", model: "custom/not-in-catalog" }, nowMs: NOW });
  assert.ok(plan.routes.openrouter.entries.some((e) => e.id === "custom/not-in-catalog"));
  // firstRun guard already keeps it as imported; force a scenario where it would leave:
  const r1 = buildPlan({ cfg, pools, current, state: null, agentDefault: null, nowMs: NOW });
  const stale = { ...r1.statePatch, importedEntries: { ...r1.statePatch.importedEntries, openrouter: [{ id: "custom/not-in-catalog", name: "Legacy Pick" }] } };
  const r2 = buildPlan({ cfg, pools, current, state: stale, agentDefault: { provider: "openrouter", model: "custom/not-in-catalog" }, nowMs: NOW + 1 });
  assert.ok(r2.plan.routes.openrouter.entries.some((e) => e.id === "custom/not-in-catalog"));
});

test("pool failure → route retained untouched", () => {
  const pools = { openrouter: fakePool("openrouter"), nous: [] };
  const { plan, report } = buildPlan({ cfg, pools, current: emptyCurrent, state: null, agentDefault: null, nowMs: NOW });
  assert.ok(!("nous-api" in plan.routes), "no plan entry written for the failed provider");
  assert.ok(report.warnings.some((w) => w.includes("抓取失敗")));
});

test("entries carry reasoningEfforts from catalog supported_efforts (fix: nous thinking strength)", () => {
  // Entry with declared thinking levels → dict lands in the planned row.
  const pools = { openrouter: fakePool("openrouter"), nous: fakePool("nous") };
  const { plan } = buildPlan({ cfg, pools, current: emptyCurrent, state: null, agentDefault: null, nowMs: NOW });
  // helpers.entry defaults to ["high","medium","low"] — maps to the same dict.
  const glm = plan.routes.openrouter.entries.find((e) => e.id === "z-ai/glm-5.3-flash");
  assert.deepEqual(glm.reasoningEfforts, { low: "low", medium: "medium", high: "high" });
  const deepseek = plan.routes.openrouter.entries.find((e) => e.id === "~deepseek/deepseek-v4-flash-latest");
  assert.deepEqual(deepseek.reasoningEfforts, { low: "low", medium: "medium", high: "high" });
});

test("reasoningEfforts omitted when catalog declares none (no false capability claim)", () => {
  const pools = {
    openrouter: [
      entry({ id: "deepseek/deepseek-v4-flash", reasoningEfforts: ["xhigh", "high"] }),
      entry({ id: "no-thinking/model", reasoningEfforts: [] }),
      entry({ id: "none-only/model", reasoningEfforts: ["none"] }),
    ],
    nous: [],
  };
  const current = { openrouter: { models: [], exists: false }, "nous-api": { models: [], exists: false } };
  const { plan } = buildPlan({ cfg, pools, current, state: null, agentDefault: null, nowMs: NOW });
  const rows = plan.routes.openrouter.entries;
  const has = (id) => rows.find((e) => e.id === id);
  const flash = has("deepseek/deepseek-v4-flash");
  assert.deepEqual(flash.reasoningEfforts, { xhigh: "xhigh", high: "high" }, "declared levels written");
  assert.equal(has("no-thinking/model").reasoningEfforts, undefined, "no declared efforts → field omitted");
  assert.equal(has("none-only/model").reasoningEfforts, undefined, "'none' alone is not a strength level → omitted");
});
