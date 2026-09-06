// Configuration: defaults + model-refresh.yaml overrides + path resolution.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** providers are the two catalog sources; `route` is the llm-pi-ai providers key they manage. */
export const PROVIDERS = {
  openrouter: { route: "openrouter" },
  nous: { route: "nous-api" },
};

export function defaultConfig() {
  return {
    // env overrides keep the plugin-mount smoke test off the real ~/.dsh
    settingsPath: process.env.DSH_MODEL_REFRESH_SETTINGS || join(dshHome(), "settings.yaml"),
    stateDir: process.env.DSH_MODEL_REFRESH_STATE_DIR || join(dshHome(), "model-refresh"),
    sources: {
      openrouter: { url: "https://openrouter.ai/api/v1/models" },
      nous: {
        catalogUrl: "https://inference-api.nousresearch.com/v1/models",
        recommendedUrl: "https://portal.nousresearch.com/api/nous/recommended-models",
      },
    },
    fetch: { timeoutMs: 25_000, attempts: 3, backoffMs: 800 },
    free: { maxPerProvider: 10, minContext: 262_144 },
    candidates: {
      min: 3,
      target: 4,
      max: 5,
      // 規則甲：第一檔 ≤ $1.00/M（單位：每 M tokens 美元 × 1e6 的整數）
      maxPricePerM: 1_000_000,
      minContext: 262_144,
      excludeIdPattern: "(preview|deprecated|retired)",
      weights: { intelligence: 0.4, coding: 0.4, agentic: 0.2 },
      // 入選門檻：score ≥ 基準 × factor；無 AA 指數者以代理分入選時標 unverified，
      // 並依此開關決定「合格池不足 min 時是否放寬收錄代理分模型」
      qualifyFactor: 0.95,
      fallbackToUnverified: true,
      hysteresis: { swapFactor: 1.1, behindNeeded: 2, cooldownDays: 7 },
    },
    routeCap: 24,
    protectAgentDefault: true,
    keepBackups: 5,
    /** R2 pins：邏輯名 → 各 provider 的候選 id（依序解析，先命中先用）。 */
    pins: [
      { key: "deepseek-v4-flash-latest", byProvider: {
        openrouter: ["~deepseek/deepseek-v4-flash-latest", "deepseek/deepseek-v4-flash"],
        nous: ["~deepseek/deepseek-v4-flash-latest", "deepseek/deepseek-v4-flash"],
      } },
      { key: "deepseek-v4-vision", byProvider: {
        openrouter: ["deepseek/deepseek-v4-flash-vision-exp"],
        nous: ["deepseek/deepseek-v4-flash-vision-exp"],
      } },
      { key: "glm-5.3-flash", byProvider: {
        openrouter: ["z-ai/glm-5.3-flash"], nous: ["z-ai/glm-5.3-flash"],
      } },
      { key: "qwen-3.7-flash", byProvider: {
        openrouter: ["qwen/qwen3.7-flash"], nous: ["qwen/qwen3.7-flash"],
      } },
      { key: "qwen-3.8-flash", byProvider: {
        openrouter: ["qwen/qwen3.8-flash"], nous: ["qwen/qwen3.8-flash"],
      } },
    ],
    /** 當 DSH 安裝裡找不到某 route 的範板時，工具建立 route 用的欄位。 */
    routeTemplates: {
      openrouter: { apiKeyEnv: "OPENROUTER_API_KEY" },
      "nous-api": {
        apiKeyEnv: "NOUS_API_KEY",
        api: "openai-completions",
        baseURL: "https://inference-api.nousresearch.com/v1",
        displayName: "Nous Portal (API key)",
      },
    },
  };
}

/** DSH home: $DSH_HOME else ~/.dsh (mirrors dsh-home-paths). */
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (env && env.trim() !== "") return env.trim();
  return join(homedir(), ".dsh");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * Load config: defaults ← optional YAML file (--config or config/model-refresh.yaml).
 * pins/routeTemplates/sources are merged object-wise; arrays replace.
 */
export function loadConfig({ configPath } = {}) {
  const cfg = defaultConfig();
  const p = configPath ?? join(PROJECT_ROOT, "config", "model-refresh.yaml");
  if (existsSync(p)) {
    const user = YAML.parse(readFileSync(p, "utf8"));
    if (user && typeof user === "object") return deepMerge(cfg, user);
  }
  return cfg;
}
