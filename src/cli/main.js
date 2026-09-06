#!/usr/bin/env node
// dsh-model-refresh CLI (M1): plan / apply / status / rollback
import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { fetchAll } from "../core/catalog.js";
import { buildPlan } from "../core/planner.js";
import { readSettings, applySettings, renderSettings } from "../core/writer.js";
import { loadState, saveState, loadPools, savePools, paths as statePaths, renderReport } from "../core/state.js";
import { atomicWriteText, backupFile, listBackups } from "../core/support.js";

const HELP = `dsh-model-refresh — DSH 模型清單智慧更新（M1）

用法： model-refresh <command> [flags]

命令：
  plan       抓取兩家目錄，產出更新計畫與 CHANGES 報告（不寫入 settings）
  apply      plan + 驗證 + 備份 + 原子寫入 settings.yaml
  status     顯示目前受管清單與狀態
  rollback   還原最近一次 apply 前的 settings.yaml 備份

flags：
  --config <path>    設定檔（預設 <project>/config/model-refresh.yaml）
  --settings <path>  settings.yaml 路徑（預設 ~/.dsh/settings.yaml）
  --state-dir <path> 狀態目錄（預設 ~/.dsh/model-refresh/）
  --offline          不抓網路，使用 state-dir/last-good.json
  -h, --help         說明
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    settings: { type: "string" },
    "state-dir": { type: "string" },
    offline: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];
if (!command || flags.help) {
  console.log(HELP);
  process.exit(command ? 0 : 2);
}

const cfg = loadConfig({ configPath: flags.config });
if (flags.settings) cfg.settingsPath = flags.settings;
if (flags["state-dir"]) cfg.stateDir = flags["state-dir"];

try {
  if (command === "plan") await runPlan({ write: false });
  else if (command === "apply") await runPlan({ write: true });
  else if (command === "status") runStatus();
  else if (command === "rollback") runRollback();
  else { console.error(`未知命令：${command}\n\n${HELP}`); process.exit(2); }
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

async function runPlan({ write }) {
  const settings = readSettings(cfg.settingsPath);
  const state = loadState(cfg.stateDir);
  let pools;
  let fetchErrors = [];
  if (flags.offline) {
    pools = loadPools(cfg.stateDir);
    if (!pools) throw new Error("--offline 但無 last-good.json，請先線上執行一次");
    console.log(`（離線模式）使用快取目錄 pools`);
  } else {
    const res = await fetchAll(cfg, { lastGood: loadPools(cfg.stateDir) });
    pools = res.pools;
    fetchErrors = res.errors;
    if (Object.values(pools).some((p) => p?.length)) savePools(cfg.stateDir, pools, res.fetchedAt);
    for (const e of fetchErrors) console.warn(`⚠️ 抓取失敗（改用快取/保留現狀）：${e}`);
  }
  for (const [name, list] of Object.entries(pools)) {
    console.log(`目錄 ${name}: ${list?.length ?? 0} 條`);
  }

  const { plan, report, statePatch } = buildPlan({
    cfg,
    pools,
    current: settings.routes,
    state,
    agentDefault: settings.agentDefault,
    nowMs: Date.now(),
  });

  for (const [routeKey, route] of Object.entries(plan.routes)) {
    console.log(`\nroute ${routeKey} → ${route.entries.length} 條`);
    route.entries.forEach((e, i) => {
      console.log(`  [${(route.rules[i] ?? "-").padEnd(10)}] ${e.id}${e.contextWindow ? `  ctx=${e.contextWindow}` : ""}`);
    });
  }
  if (report.added.length) console.log(`\n新增 ${report.added.length}、移除 ${report.removed.length}、保留 ${report.kept.length}`);
  for (const w of report.warnings) console.log(`⚠️ ${w}`);

  const p = statePaths(cfg.stateDir);
  atomicWriteText(p.report, renderReport(plan, report));
  atomicWriteText(p.lastPlan, JSON.stringify(plan, null, 2) + "\n");
  try {
    atomicWriteText(join(cfg.stateDir, "preview-settings.yaml"), renderSettings(settings.text, plan, cfg));
  } catch (err) {
    console.warn(`⚠️ 預覽檔產生失敗（不影響計畫）：${err.message}`);
  }
  console.log(`\n報告：${p.report}`);
  console.log(`預覽完整 settings.yaml：${join(cfg.stateDir, "preview-settings.yaml")}`);

  if (write) {
    const { backupPath } = applySettings({
      settingsPath: cfg.settingsPath,
      currentText: existsSync(cfg.settingsPath) ? readFileSync(cfg.settingsPath, "utf8") : "",
      plan,
      cfg,
      stateDir: cfg.stateDir,
    });
    saveState(cfg.stateDir, statePatch, { plan, report });
    console.log(`✅ 已寫入 ${cfg.settingsPath}（備份：${backupPath ?? "無（新檔）"}）`);
    console.log(`   DSH 會在下一次模型請求熱重載，不需重啟。`);
  }
}

function runStatus() {
  const settings = readSettings(cfg.settingsPath);
  const state = loadState(cfg.stateDir);
  console.log(`settings: ${cfg.settingsPath}`);
  console.log(`state:    ${cfg.stateDir}${state ? `（上次執行 ${state.lastRunAt}）` : "（尚無狀態 — 尚未 apply 過）"}`);
  for (const [routeKey, r] of Object.entries(settings.routes)) {
    console.log(`\nroute ${routeKey}: ${r.exists ? `${r.models.length} 條` : "（settings 中不存在）"}`);
    for (const m of r.models) console.log(`  - ${m.id}`);
  }
}

function runRollback() {
  const p = statePaths(cfg.stateDir);
  const backups = listBackups(cfg.settingsPath, p.backups);
  if (!backups.length) throw new Error(`無備份可還原（${p.backups}）`);
  const target = backups[0];
  const content = readFileSync(target, "utf8");
  // safety: back up the *current* file first so the rollback itself is undoable
  backupFile(cfg.settingsPath, p.backups, cfg.keepBackups);
  atomicWriteText(cfg.settingsPath, content);
  console.log(`✅ 已從 ${target} 還原 ${cfg.settingsPath}`);
  console.warn(`⚠️ 注意：rollback 不回滾 ${p.state}\\state.json — 常駐 plugin 下一輪會依舊 state 重新套用計畫，rollback 可能被覆蓋。`);
  console.warn(`   想讓還原站得住：先把 settings.yaml 的 dsh-model-refresh.enabled 設 false，或刪除 ~/.dsh/model-refresh/state.json（下次視為首次接管，僅新增不刪除）。`);
}
