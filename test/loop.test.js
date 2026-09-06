import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce } from "../src/plugin/loop.js";
import { loadConfig } from "../src/core/config.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const orJson = JSON.parse(readFileSync(join(FIX, "openrouter.json"), "utf8"));
const nousJson = JSON.parse(readFileSync(join(FIX, "nous.json"), "utf8"));
const recJson = JSON.parse(readFileSync(join(FIX, "nous-recommended.json"), "utf8"));

function fakeFetcher(url) {
  if (url.includes("openrouter.ai")) return Promise.resolve(orJson);
  if (url.includes("inference-api")) return Promise.resolve(nousJson);
  if (url.includes("recommended-models")) return Promise.resolve(recJson);
  throw new Error(`unexpected ${url}`);
}

const INITIAL = {
  "llm-pi-ai": {
    providers: {
      openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", models: [{ id: "deepseek/deepseek-v4-flash", name: "Old", maxTokens: 4096 }] },
      "nous-api": {
        apiKeyEnv: "NOUS_API_KEY", api: "openai-completions",
        baseURL: "https://inference-api.nousresearch.com/v1",
        models: [{ id: "qwen/qwen3.8-flash", name: "Qwen: Qwen3.8 Flash" }],
      },
    },
  },
};

function makeSeam({ revision = 7, conflictOnce = false, rejectAll = false } = {}) {
  const state = { revision, providers: structuredClone(INITIAL["llm-pi-ai"].providers) };
  return {
    _state: state,
    get(ns) {
      if (ns === "llm-pi-ai") return { providers: state.providers };
      if (ns === "agent-default-model") return { provider: "nous-api", model: "qwen/qwen3.8-flash" };
      return undefined;
    },
    describe() { return [{ ns: "llm-pi-ai", revision: state.revision }]; },
    async mutate(ns, ops, rev) {
      assert.equal(ns, "llm-pi-ai");
      if (rejectAll) { const e = new Error("validator rejected"); e.code = "SETTINGS_REJECTED"; throw e; }
      if (conflictOnce) { conflictOnce = false; state.revision++; const e = new Error("namespace moved"); e.code = "SETTINGS_CONFLICT"; throw e; }
      if (rev !== state.revision) { const e = new Error("stale"); e.code = "SETTINGS_CONFLICT"; throw e; }
      for (const op of ops) {
        assert.equal(op.op, "set");
        // path is relative to the namespace section: ["providers", <route>, "models"]
        const [top, route, field] = op.path;
        assert.equal(top, "providers");
        state.providers[route][field] = structuredClone(op.value);
      }
      state.revision++;
    },
  };
}

function cfgWithState(tmp) {
  const cfg = loadConfig({ configPath: "none.yaml" });
  cfg.stateDir = join(tmp, "model-refresh-state");
  return cfg;
}

test("loop run 1: writes both routes through the seam with pins in place", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mr-loop-"));
  const seam = makeSeam();
  const { applied, writes, plan } = await runOnce({ cfg: cfgWithState(tmp), settings: seam, nowMs: Date.UTC(2026, 8, 5), fetcherImpl: fakeFetcher });
  assert.equal(applied, true);
  assert.equal(writes, 2);
  const orIds = seam._state.providers.openrouter.models.map((m) => m.id);
  for (const pin of ["~deepseek/deepseek-v4-flash-latest", "deepseek/deepseek-v4-flash-vision-exp", "z-ai/glm-5.3-flash", "qwen/qwen3.7-flash", "qwen/qwen3.8-flash"]) {
    assert.ok(orIds.includes(pin), `pin ${pin} written to openrouter`);
  }
  assert.ok(orIds.includes("deepseek/deepseek-v4-flash"), "pre-existing user entry adopted, not deleted");
  // route other fields untouched by the path-mutation
  assert.equal(seam._state.providers.openrouter.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.equal(seam._state.providers["nous-api"].baseURL, "https://inference-api.nousresearch.com/v1");
  assert.ok(plan.generatedAt);
});

test("loop run 2 (same inputs): zero writes — idempotent through the seam", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mr-loop2-"));
  const seam = makeSeam();
  const base = Date.UTC(2026, 8, 5);
  await runOnce({ cfg: cfgWithState(tmp), settings: seam, nowMs: base, fetcherImpl: fakeFetcher });
  const revAfterFirst = seam._state.revision;
  const { applied, writes } = await runOnce({ cfg: cfgWithState(tmp), settings: seam, nowMs: base + 3600_000, fetcherImpl: fakeFetcher });
  assert.equal(writes, 0, "steady state emits no mutate ops");
  assert.equal(applied, false);
  assert.equal(seam._state.revision, revAfterFirst, "settings revision untouched when nothing changed");
});

test("loop retries once on SETTINGS_CONFLICT", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mr-loop3-"));
  const seam = makeSeam({ conflictOnce: true });
  const { applied, writes } = await runOnce({ cfg: cfgWithState(tmp), settings: seam, nowMs: Date.UTC(2026, 8, 5), fetcherImpl: fakeFetcher });
  assert.equal(applied, true, "second attempt uses the fresh revision");
  assert.equal(writes, 2);
});

test("loop surfaces hard rejections without crashing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mr-loop4-"));
  const seam = makeSeam({ rejectAll: true });
  await assert.rejects(
    () => runOnce({ cfg: cfgWithState(tmp), settings: seam, nowMs: Date.UTC(2026, 8, 5), fetcherImpl: fakeFetcher }),
    /validator rejected/,
  );
});
