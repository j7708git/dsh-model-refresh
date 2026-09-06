import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.js";
import { readSettings, renderSettings, validatePlan, applySettings } from "../src/core/writer.js";
import { entry } from "./helpers.js";
import { entryToYaml } from "../src/core/planner.js";

const cfg = loadConfig({ configPath: "none.yaml" });

const SAMPLE = `# 使用者註解：整體設定
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY  # 金鑰參考
      models:
        - id: deepseek/deepseek-v4-flash
          name: "DeepSeek: DeepSeek V4 Flash"
          contextWindow: 1048575
          maxTokens: 4096   # 使用者自己的上限
    nous-api:
      apiKeyEnv: NOUS_API_KEY
      api: openai-completions
      baseURL: https://inference-api.nousresearch.com/v1
      models:
        - id: qwen/qwen3.8-flash
          name: "Qwen: Qwen3.8 Flash"
agent-default-model:
  provider: nous-api
  model: qwen/qwen3.8-flash
ui-theme:
  fontSize: 15  # 註解保留測試
`;

test("readSettings extracts managed routes + agent default", () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-test-"));
  const p = join(dir, "settings.yaml");
  writeFileSync(p, SAMPLE);
  const s = readSettings(p);
  assert.equal(s.routes.openrouter.exists, true);
  assert.equal(s.routes.openrouter.models.length, 1);
  assert.equal(s.routes["nous-api"].models[0].id, "qwen/qwen3.8-flash");
  assert.deepEqual(s.agentDefault, { provider: "nous-api", model: "qwen/qwen3.8-flash" });
});

function samplePlan() {
  const mk = (id, rule) => ({ ...entryToYaml(entry({ id }), rule), _rule: rule });
  const rows = [mk("z-ai/glm-5.3-flash", "pin"), mk("poolside/laguna-s-2.1", "candidate"), mk("openrouter/free", "imported"), mk("a/b:free", "free")];
  return {
    generatedAt: "2026-09-05T00:00:00Z",
    routes: {
      openrouter: { provider: "openrouter", exists: true, entries: rows.map((r) => ({ id: r.id, name: r.name, contextWindow: r.contextWindow, maxTokens: r.maxTokens })), rules: rows.map((r) => r._rule) },
    },
  };
}

test("renderSettings replaces only managed section; comments survive", () => {
  const out = renderSettings(SAMPLE, samplePlan(), cfg);
  assert.ok(out.includes("# 使用者註解：整體設定"), "top comment kept");
  assert.ok(out.includes("# 金鑰參考"), "inline comment kept");
  assert.ok(out.includes("# 註解保留測試"), "unrelated comment kept");
  assert.ok(out.includes("fontSize: 15"), "unrelated namespace intact");
  assert.ok(out.includes("apiKeyEnv: OPENROUTER_API_KEY"), "route other fields intact");
  assert.ok(!out.includes("maxTokens: 4096"), "managed models list fully replaced");
  assert.ok(out.includes("# pin"), "rule comments emitted");
  assert.ok(out.includes("z-ai/glm-5.3-flash") && out.includes("a/b:free"));
  // nous route untouched
  assert.ok(out.includes("qwen/qwen3.8-flash"));
});

test("renderSettings creates a missing route from template", () => {
  const plan = { generatedAt: "x", routes: { "nous-api": { provider: "nous", exists: false, entries: [{ id: "a/b", name: "A B", contextWindow: 1000, maxTokens: 10 }], rules: ["pin"] } } };
  const out = renderSettings("llm-pi-ai:\n  providers: {}\n", plan, cfg);
  assert.ok(out.includes("baseURL: https://inference-api.nousresearch.com/v1"));
  assert.ok(out.includes("apiKeyEnv: NOUS_API_KEY"));
  assert.ok(out.includes("a/b"));
});

test("validatePlan catches structural problems", () => {
  const dup = { routes: { openrouter: { provider: "openrouter", exists: true, rules: [], entries: [{ id: "a/b" }, { id: "a/b" }] } } };
  assert.ok(validatePlan(dup, cfg).some((e) => e.includes("重複")));
  const badInt = { routes: { openrouter: { provider: "openrouter", exists: true, rules: [], entries: [{ id: "a/b", contextWindow: -5 }] } } };
  assert.ok(validatePlan(badInt, cfg).some((e) => e.includes("contextWindow")));
  const empty = { routes: { openrouter: { provider: "openrouter", exists: true, rules: [], entries: [] } } };
  assert.ok(validatePlan(empty, cfg).some((e) => e.includes("空清單")));
});

test("applySettings writes atomically and creates a pre-write backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-apply-"));
  const settingsPath = join(dir, "settings.yaml");
  writeFileSync(settingsPath, SAMPLE);
  const stateDir = join(dir, "state");
  const { backupPath } = applySettings({ settingsPath, currentText: SAMPLE, plan: samplePlan(), cfg, stateDir });
  assert.ok(backupPath && existsSync(backupPath), "backup written");
  const after = readFileSync(settingsPath, "utf8");
  assert.ok(after.includes("z-ai/glm-5.3-flash"));
  const restored = readFileSync(backupPath, "utf8");
  assert.equal(restored, SAMPLE, "backup is byte-identical to pre-apply state");
  assert.equal(readSettings(settingsPath).agentDefault.model, "qwen/qwen3.8-flash", "unmanaged sections intact after apply");
});
