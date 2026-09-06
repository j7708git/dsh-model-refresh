/**
 * dsh-model-refresh 常駐 plugin 殼（cordis / DSH web profile）。
 *
 * 掛載方式：`dsh plugin --profile web add <此套件>` — package.json 的
 * `dsh.bundle.patch` 會讓官方 CLI 把本插件插入 profile 的 bundle 堆疊。
 * 啟動後：`ctx.inject(["settings"])` 拿到設定服務 → 註冊自己的 prefs 命名空間
 * → 初始延遲後執行第一輪、之後每 intervalHours 一輪； prefs 熱更新立即重排程。
 * 所有抓取/規則/寫入邏輯在 ../core 與 ./loop.js（本檔只接線，維持可單測）。
 */
import z from "schemastery";
import { loadConfig } from "../core/config.js";
import { loadState } from "../core/state.js";
import { runOnce } from "./loop.js";
import { registerModelRefreshRoutes, readLastPlan } from "./http.js";

export const name = "dsh-model-refresh";

/** 本殼不需要任何必選服務：設定服務經可選 seam 注入（無則整體休眠）。 */
export const inject = [];

/** cordis mount config（刻意留空；行為全部由 prefs 命名空間驅動）。 */
export const Config = z.object({});

export const PREFS_NS = "dsh-model-refresh";

/** 使用者可在 settings.yaml 調整的常駐偏好。 */
export const Prefs = z.object({
  enabled: z.boolean().default(true),
  /** 刷新間隔（小時）。 */
  intervalHours: z.number().min(0.25).default(12),
  /** 啟動後第一輪的延遲（秒），讓 DSH 開機風暴先過。 */
  initialDelaySeconds: z.number().min(0).default(90),
});

/**
 * @param ctx    cordis Context
 * @param config cordis mount config. `config.fetcherImpl` is a test seam that
 *               overrides the catalog fetcher (never settable from YAML mounts);
 *               it is read defensively because cordis hands plugins a config
 *               proxy whose unknown keys can throw on access.
 */
export function apply(ctx, config) {
  let fetcherImpl;
  try { fetcherImpl = config?.fetcherImpl; } catch { /* proxy without the key */ }

  // Log through the host logger, with a console fallback so a swallowed plugin
  // error can never become invisible again (that silence cost a debug cycle).
  const out = (level, m) => {
    try { ctx.logger?.[level]?.(m); } catch { /* fall through */ }
    if (level === "error") console.error(`model-refresh: ${m}`);
    else console.log(`model-refresh: ${m}`);
  };
  const say = (m) => out("info", m);
  const warn = (m) => out("warn", m);
  const fail = (m) => out("error", m);

  // Shared controls box for the HTTP surface: the settings inject callback fills
  // it once the loop exists; the webServer routes read it per-request (so route
  // registration order never matters, and a dormant loop answers 503).
  const controls = { current: null };

  // The settings seam is optional: a deployment without dsh-settings-file simply
  // never activates the refresh loop (mirror of the adapter's dormant posture).
  ctx.inject(["settings"], (sctx) => {
    // CRITICAL: the context passed to an inject callback is active only for the
    // callback's own execution — touching `sctx.settings` later throws
    // "cannot get required service in inactive context". Capture the service
    // INSTANCE now; every seam call below goes through it directly.
    const settings = sctx.settings;
    let scope;
    try {
      scope = settings.register(PREFS_NS, Prefs);
    } catch (err) {
      fail(`prefs 命名空間註冊失敗，plugin 休眠：${err?.stack ?? err}`);
      return;
    }
    const cfgBase = loadConfig();
    let initialTimer = null;
    let interval = null;
    let running = false;

    const seam = {
      get: (ns) => settings.get(ns),
      describe: (opts) => settings.describe(opts),
      mutate: (ns, ops, expectedRevision) => settings.mutate(ns, ops, expectedRevision),
    };

    async function tick({ force = false } = {}) {
      if (running) return { ok: false, busy: true };
      let prefs;
      try { prefs = scope.get(); } catch (err) {
        fail(`prefs 讀取失敗：${err?.stack ?? err}`);
        return { ok: false, error: `prefs 讀取失敗：${err?.message ?? err}` };
      }
      if (!prefs.enabled && !force) return { ok: false, disabled: true };
      running = true;
      try {
        const { applied, writes, report } = await runOnce({
          cfg: cfgBase,
          settings: seam,
          fetcherImpl,
          log: say,
        });
        if (applied) say(`已套用 ${writes} 個 route 更新（新增 ${report.added.length}、移除 ${report.removed.length}）`);
        else if (report.warnings.length) warn(`本輪未套用 — ${report.warnings.join("; ")}`);
        else say("無需更新");
        return {
          ok: true,
          applied,
          writes,
          added: report.added.length,
          removed: report.removed.length,
          warnings: report.warnings,
        };
      } catch (err) {
        fail(`刷新週期失敗：${err?.stack ?? err}`);
        return { ok: false, error: err?.message ?? String(err) };
      } finally {
        running = false;
      }
    }

    /** Snapshot for the Web card: prefs + last persisted run facts. */
    function getStatus() {
      let prefs = null;
      try { prefs = scope.get(); } catch { /* namespace gone — card shows unavailable */ }
      const st = loadState(cfgBase.stateDir);
      const plan = readLastPlan(cfgBase.stateDir);
      return {
        prefs: prefs ? { enabled: prefs.enabled, intervalHours: prefs.intervalHours, initialDelaySeconds: prefs.initialDelaySeconds } : null,
        lastRunAt: st?.lastRunAt ?? null,
        lastAppliedAt: st?.lastAppliedAt ?? null,
        planGeneratedAt: plan?.generatedAt ?? null,
        routes: plan?.routes
          ? Object.fromEntries(Object.entries(plan.routes).map(([k, r]) => [k, r.entries.length]))
          : null,
      };
    }

    controls.current = { triggerTick: tick, getStatus };

    function reschedule() {
      let prefs;
      try {
        prefs = scope.get();
      } catch (err) {
        // This also runs as a settings watch callback: never throw from here.
        fail(`reschedule 讀取 prefs 失敗（保留現有計時器）：${err?.stack ?? err}`);
        return;
      }
      if (initialTimer) clearTimeout(initialTimer);
      if (interval) clearInterval(interval);
      if (!prefs.enabled) return;
      const ms = Math.max(15 * 60_000, prefs.intervalHours * 3_600_000);
      initialTimer = setTimeout(() => { void tick(); }, prefs.initialDelaySeconds * 1000);
      interval = setInterval(() => { void tick(); }, ms);
      if (typeof interval?.unref === "function") interval.unref();
    }

    reschedule();
    // Keep the watcher disposer: without it the callback survives plugin unload
    // and could still fire reschedule() after stop/update.
    const unwatch = scope.watch(() => reschedule());
    const prefsNow = scope.get();
    say(`已載入（第一輪 ${prefsNow.initialDelaySeconds}s 後，其後每 ${prefsNow.intervalHours}h）`);
    // cordis 4 effect teardown: return the disposer (there is NO ctx.dispose API —
    // an earlier revision called it and killed the mount tail with a TypeError).
    return () => {
      if (unwatch) unwatch();
      if (initialTimer) clearTimeout(initialTimer);
      if (interval) clearInterval(interval);
      controls.current = null; // HTTP surface now answers 503 until re-mount
    };
  });

  // Web settings card surface (M4-A): dormant when no webServer service exists.
  registerModelRefreshRoutes(ctx, controls, say);
}
