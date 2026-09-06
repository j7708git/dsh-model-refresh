// settings.yaml reader/writer: surgical editing of the managed `models:` sections
// via the `yaml` document model — comments and untouched nodes survive.
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { PROVIDERS } from "./config.js";
import { atomicWriteText, backupFile } from "./support.js";

const NS = "llm-pi-ai";

/**
 * Read the current managed sections + agent-default-model from settings.yaml.
 * @returns {{routes: Record<string, {models: object[], exists: boolean}>, agentDefault: {provider:string, model:string}|null, text: string}}
 */
export function readSettings(settingsPath) {
  const text = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
  const plain = text.trim() ? YAML.parse(text) : null;
  const providers = plain?.[NS]?.providers ?? {};
  const routes = {};
  for (const { route } of Object.values(PROVIDERS)) {
    const models = providers?.[route]?.models;
    routes[route] = {
      exists: Object.prototype.hasOwnProperty.call(providers, route),
      models: Array.isArray(models) ? models : [],
    };
  }
  const ad = plain?.["agent-default-model"];
  const agentDefault = ad?.provider && ad?.model
    ? { provider: String(ad.provider), model: String(ad.model) }
    : null;
  return { routes, agentDefault, text };
}

/**
 * Render new settings text: replace the `models` seq of each managed route
 * (creating routes from cfg.routeTemplates when absent). Everything else —
 * other namespaces, comments, key order — is preserved by the yaml doc model.
 */
export function renderSettings(currentText, plan, cfg) {
  const doc = currentText.trim()
    ? YAML.parseDocument(currentText, { keepSourceTokens: true })
    : new YAML.Document();

  for (const [routeKey, route] of Object.entries(plan.routes)) {
    const path = [NS, "providers", routeKey, "models"];
    if (!doc.hasIn([NS, "providers", routeKey])) {
      const template = cfg.routeTemplates?.[routeKey];
      if (!template) throw new Error(`route ${routeKey} 不存在且無 routeTemplates 範板，無法建立`);
      doc.setIn([NS, "providers", routeKey], doc.createNode({ ...template, models: [] }));
    }
    const seq = doc.createNode([]);
    route.entries.forEach((entry, i) => {
      const node = doc.createNode(normalizeEntryForYaml(entry));
      const rule = route.rules?.[i] ?? "managed";
      node.commentBefore = ` ${rule}`;
      seq.items.push(node);
    });
    doc.setIn(path, seq);
  }
  const out = doc.toString({ lineWidth: 0 });
  assertRenderable(out, plan);
  return out;
}

/** Entry key order for output; drop internal keys. */
function normalizeEntryForYaml(entry) {
  const out = {};
  for (const k of ["id", "name", "contextWindow", "maxTokens", "input", "reasoningEfforts", "compat"]) {
    if (entry[k] !== undefined) out[k] = entry[k];
  }
  return out;
}

/**
 * Structural self-validation before writing (mirrors the docs §6.3 checklist;
 * dsh-llm-pi-ai's own validator still has the final say at load time).
 */
export function validatePlan(plan, cfg) {
  const errors = [];
  for (const [routeKey, route] of Object.entries(plan.routes)) {
    const seen = new Set();
    if (route.entries.length === 0) {
      errors.push(`${routeKey}: 產生空清單 — 拒絕寫入`);
      continue;
    }
    for (const e of route.entries) {
      if (!e || typeof e.id !== "string" || e.id.trim() === "") errors.push(`${routeKey}: 條目缺少 id`);
      else if (seen.has(e.id)) errors.push(`${routeKey}: id 重複 ${e.id}`);
      seen.add(e?.id);
      for (const k of ["contextWindow", "maxTokens"]) {
        if (e?.[k] !== undefined && !(Number.isInteger(e[k]) && e[k] > 0)) {
          errors.push(`${routeKey}/${e.id}: ${k} 非正整數 (${e[k]})`);
        }
      }
      if (e?.name !== undefined && typeof e.name !== "string") errors.push(`${routeKey}/${e.id}: name 必須為字串`);
    }
    if (route.entries.length > cfg.routeCap + 8) {
      errors.push(`${routeKey}: 清單 ${route.entries.length} 條異常膨脹（cap ${cfg.routeCap}）`);
    }
  }
  return errors;
}

/** Final round-trip sanity: the rendered text must re-parse with every planned id present. */
function assertRenderable(text, plan) {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`渲染結果 YAML 無效：${doc.errors[0].message}`);
  const plain = YAML.parse(text); // plain JS view for assertions
  for (const [routeKey, route] of Object.entries(plan.routes)) {
    const models = plain?.[NS]?.providers?.[routeKey]?.models;
    const ids = new Set((Array.isArray(models) ? models : []).map((m) => m?.id));
    for (const e of route.entries) {
      if (!ids.has(e.id)) throw new Error(`渲染後 ${routeKey} 遺失條目 ${e.id}`);
    }
  }
}

/**
 * Apply a validated plan: backup current file, atomic-write the new one.
 * @returns {{backupPath: string|null, written: boolean}}
 */
export function applySettings({ settingsPath, currentText, plan, cfg, stateDir }) {
  const errors = validatePlan(plan, cfg);
  if (errors.length) throw new Error(`self-validation 失敗：\n  ${errors.join("\n  ")}`);
  const text = renderSettings(currentText, plan, cfg);
  const backupPath = backupFile(settingsPath, `${stateDir}/backups`, cfg.keepBackups);
  atomicWriteText(settingsPath, text);
  return { backupPath, written: true };
}
