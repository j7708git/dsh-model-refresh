// The resident refresh loop — pure logic over an injected settings seam, so it
// is unit-testable without a live DSH. The plugin shell (./index.js) wires it
// to `ctx.settings`; the seam shape mirrors the SettingsProvider service.
import { mkdirSync } from "node:fs";
import { PROVIDERS } from "../core/config.js";
import { fetchAll } from "../core/catalog.js";
import { buildPlan } from "../core/planner.js";
import { loadState, saveState, loadPools, savePools } from "../core/state.js";

export const LLM_NS = "llm-pi-ai";
const MANAGED_FIELDS = ["id", "name", "contextWindow", "maxTokens", "input", "reasoningEfforts"];

/** Derive the planner's `current` view from the resolved llm-pi-ai namespace. */
export function currentFromProviders(providers) {
  const current = {};
  for (const { route } of Object.values(PROVIDERS)) {
    const routeCfg = providers?.[route];
    current[route] = {
      exists: Object.prototype.hasOwnProperty.call(providers ?? {}, route),
      models: Array.isArray(routeCfg?.models) ? routeCfg.models : [],
    };
  }
  return current;
}

/** Shallow field-compare of one planned entry against its current counterpart. */
function sameEntry(cur, planned) {
  if (!cur || !planned) return false;
  for (const k of MANAGED_FIELDS) {
    const b = planned[k];
    if (b === undefined) continue; // planned asserts nothing on this field
    if (Array.isArray(b) || (b && typeof b === "object")) {
      if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(b)) return false;
    } else if (cur[k] !== b) return false;
  }
  return true;
}

/** mutate with one optimistic-revision retry on SETTINGS_CONFLICT. */
async function mutateWithRetry(settings, ops, log) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const rev = settings.describe({ redactSecrets: true }).find((d) => d.ns === LLM_NS)?.revision;
    try {
      await settings.mutate(LLM_NS, ops, rev);
      return true;
    } catch (err) {
      const code = err?.code ?? (err?.constructor?.name === "SettingsConflictError" ? "SETTINGS_CONFLICT" : undefined);
      if (code === "SETTINGS_CONFLICT") { log?.(`衝突重試（第 ${attempt + 1} 次）：${err.message ?? err}`); continue; }
      throw err;
    }
  }
  return false;
}

/**
 * One refresh cycle against the live settings seam.
 * @param deps {{ cfg, settings: {get,describe,mutate}, nowMs?, fetcherImpl?, log? }}
 * @returns {Promise<{plan, report, applied: boolean, writes: number}>}
 */
export async function runOnce({ cfg, settings, nowMs = Date.now(), fetcherImpl, log }) {
  const providers = settings.get(LLM_NS)?.providers ?? {};
  const current = currentFromProviders(providers);
  const ad = settings.get("agent-default-model");
  const agentDefault = ad?.provider && ad?.model ? { provider: String(ad.provider), model: String(ad.model) } : null;

  mkdirSync(cfg.stateDir, { recursive: true });
  const state = loadState(cfg.stateDir);
  const { pools, errors, fetchedAt } = await fetchAll(cfg, { lastGood: loadPools(cfg.stateDir), fetcherImpl });
  if (Object.values(pools ?? {}).some((p) => p?.length)) savePools(cfg.stateDir, pools, fetchedAt);

  const { plan, report, statePatch } = buildPlan({ cfg, pools: pools ?? {}, current, state, agentDefault, nowMs });
  for (const e of errors) report.warnings.push(`抓取失敗：${e}`);

  const ops = [];
  for (const [routeKey, route] of Object.entries(plan.routes)) {
    const cur = current[routeKey]?.models ?? [];
    const changed = cur.length !== route.entries.length
      || !route.entries.every((e, i) => sameEntry(cur[i], e));
    if (changed) ops.push({ op: "set", path: ["providers", routeKey, "models"], value: route.entries });
  }

  let applied = false;
  if (ops.length) {
    applied = await mutateWithRetry(settings, ops, log);
    if (applied) report.notes.unshift(`已透過 settings 服務原子寫入 ${ops.length} 個受管 route`);
    else report.warnings.push("settings 寫入衝突重試後仍失敗 — 本輪未套用（state 已記錄，下輪再試）");
  }
  statePatch.lastAppliedAt = applied ? new Date(nowMs).toISOString() : state?.lastAppliedAt ?? null;
  saveState(cfg.stateDir, statePatch, { plan, report });
  return { plan, report, applied, writes: ops.length };
}
