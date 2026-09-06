import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeItem, fetchAll, portalModelNames } from "../src/core/catalog.js";
import { loadConfig } from "../src/core/config.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const orFixture = JSON.parse(readFileSync(join(FIX, "openrouter.json"), "utf8"));
const nousFixture = JSON.parse(readFileSync(join(FIX, "nous.json"), "utf8"));
const recFixture = JSON.parse(readFileSync(join(FIX, "nous-recommended.json"), "utf8"));

test("normalizeItem maps pricing/modality/variant/free", () => {
  const raw = {
    id: "z-ai/glm-5.3-flash", name: "Z.ai: GLM 5.3 Flash",
    pricing: { prompt: "0.000000075", completion: "0.00000025" },
    context_length: 1048576,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    top_provider: { context_length: 1048576, max_completion_tokens: 131072 },
    supported_parameters: ["tools", "reasoning"],
    benchmarks: { artificial_analysis: { intelligence_index: 46.2, coding_index: 71.5, agentic_index: 51.5 } },
    canonical_slug: "z-ai/glm-5.3-flash", description: "x", created: 1,
  };
  const e = normalizeItem(raw, "openrouter", new Set());
  assert.equal(e.inPerM, 75_000);
  assert.equal(e.outPerM, 250_000);
  assert.equal(e.variant, "base");
  assert.equal(e.supportsTools, true);
  assert.equal(e.contextWindow, 1048576);
  assert.equal(e.maxTokens, 131072);
  assert.equal(e.benchmarks.intelligence, 46.2);
  assert.equal(e.free, false);

  const freeRaw = { ...raw, id: "z-ai/glm-5.3-flash:free", pricing: { prompt: "0", completion: "0" } };
  const f = normalizeItem(freeRaw, "nous", new Set(["z-ai/glm-5.3-flash:free"]));
  assert.equal(f.variant, "free");
  assert.equal(f.free, true);
  assert.equal(f.portalRecommendedFree, true);

  const router = normalizeItem({ ...raw, id: "~deepseek/deepseek-v4-flash-latest" }, "nous", new Set());
  assert.equal(router.variant, "router");
});

test("portalModelNames extracts recommendation ids", () => {
  const names = portalModelNames(recFixture);
  assert.ok([...names].some((n) => n.endsWith(":free")), "expect :free ids present");
  assert.ok(names.has("stepfun/step-3.7-flash:free"));
});

test("fetchAll with injected fetcher yields both pools; pins resolvable", async () => {
  const cfg = loadConfig({ configPath: join(FIX, "nonexistent.yaml") });
  const fake = async (url) => {
    if (url === cfg.sources.openrouter.url) return orFixture;
    if (url === cfg.sources.nous.catalogUrl) return nousFixture;
    if (url === cfg.sources.nous.recommendedUrl) return recFixture;
    throw new Error(`unexpected url ${url}`);
  };
  const { pools, errors } = await fetchAll(cfg, { fetcherImpl: fake });
  assert.deepEqual(errors, []);
  assert.ok(pools.openrouter.length > 100, "OR pool large");
  assert.ok(pools.nous.length > 100, "Nous pool large");
  const orIds = new Set(pools.openrouter.map((e) => e.id));
  for (const id of ["~deepseek/deepseek-v4-flash-latest", "deepseek/deepseek-v4-flash-vision-exp", "z-ai/glm-5.3-flash", "qwen/qwen3.7-flash", "qwen/qwen3.8-flash"]) {
    assert.ok(orIds.has(id), `pins must all resolve on openrouter pool, missing ${id}`);
  }
});

test("fetchAll falls back to lastGood on failure", async () => {
  const cfg = loadConfig({ configPath: "nope.yaml" });
  const boom = async () => { throw new Error("network down"); };
  const lastGood = { openrouter: [{ id: "a/b" }], nous: [{ id: "c/d" }] };
  const { pools, errors } = await fetchAll(cfg, { fetcherImpl: boom, lastGood });
  assert.equal(errors.length, 2);
  assert.deepEqual(pools.openrouter, lastGood.openrouter);
  assert.deepEqual(pools.nous, lastGood.nous);
});
