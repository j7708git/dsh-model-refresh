// State store (JSON, atomic): managed ids, imported entries, candidate ledger,
// pin snapshot, last-known-good catalog pools, reports.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, atomicWriteText } from "./support.js";

const STATE_VERSION = 1;

export function paths(stateDir) {
  return {
    state: join(stateDir, "state.json"),
    lastPlan: join(stateDir, "last-plan.json"),
    report: join(stateDir, "CHANGES.md"),
    backups: join(stateDir, "backups"),
  };
}

export function loadState(stateDir) {
  const p = paths(stateDir).state;
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return s?.version === STATE_VERSION ? s : null;
  } catch {
    return null;
  }
}

export function saveState(stateDir, statePatch, { plan, report } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const p = paths(stateDir);
  atomicWriteJson(p.state, { version: STATE_VERSION, ...statePatch });
  if (plan) atomicWriteJson(p.lastPlan, plan);
  if (report) atomicWriteText(p.report, renderReport(plan, report));
}

/** last-known-good catalog pools (kept separate from state.json — they are big). */
export function loadPools(stateDir) {
  const p = join(stateDir, "last-good.json");
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j?.pools;
  } catch {
    return undefined;
  }
}

export function savePools(stateDir, pools, fetchedAt) {
  mkdirSync(stateDir, { recursive: true });
  const slim = {};
  for (const [k, list] of Object.entries(pools)) {
    if (Array.isArray(list) && list.length) slim[k] = list;
  }
  atomicWriteJson(join(stateDir, "last-good.json"), { fetchedAt, pools: slim });
}

/** CHANGES.md — the human-facing Chinese diff report. */
export function renderReport(plan, report) {
  const lines = [];
  lines.push(`# 模型清單更新報告`, "", `- 產生時間：${plan.generatedAt}`, "");

  for (const [routeKey, route] of Object.entries(plan.routes)) {
    lines.push(`## route \`${routeKey}\`（${route.entries.length} 條）`, "");
    lines.push("| 規則 | id | name | ctx | maxOut |", "|---|---|---|---|---|");
    route.entries.forEach((e, i) => {
      lines.push(`| ${route.rules?.[i] ?? "-"} | \`${e.id}\` | ${e.name ?? ""} | ${e.contextWindow ?? "-"} | ${e.maxTokens ?? "-"} |`);
    });
    lines.push("");
  }

  if (report.added.length) {
    lines.push(`## 新增（${report.added.length}）`, "");
    for (const a of report.added) lines.push(`- **${a.provider}** \`${a.id}\` ← ${a.rule}`);
    lines.push("");
  }
  if (report.removed.length) {
    lines.push(`## 移除（${report.removed.length}）`, "");
    for (const r of report.removed) lines.push(`- **${r.provider}** \`${r.id}\``);
    lines.push("");
  }
  const scoreKeys = Object.keys(report.candidateScores ?? {});
  if (scoreKeys.length) {
    lines.push(`## 候補評分（基準 = pins 中位數 = 100）`, "");
    lines.push("| provider/id | score | unverified | 依據 |", "|---|---|---|---|");
    for (const k of scoreKeys) {
      const s = report.candidateScores[k];
      lines.push(`| ${k} | ${s.score} | ${s.unverified ? "⚠️" : ""} | ${(s.basis ?? []).join("; ")} |`);
    }
    lines.push("");
  }
  if (report.notes?.length) { lines.push(`## 規則備註`, ""); for (const n of report.notes) lines.push(`- ${n}`); lines.push(""); }
  if (report.warnings?.length) { lines.push(`## ⚠️ 警示`, ""); for (const w of report.warnings) lines.push(`- ${w}`); lines.push(""); }
  if (!report.removed.length && !report.warnings.length) lines.push(`（本輪無移除、無警示）`, "");
  return lines.join("\n") + "\n";
}
