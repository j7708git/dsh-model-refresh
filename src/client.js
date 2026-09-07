/**
 * dsh-model-refresh — Web 設定頁卡片（M4-B，瀏覽器半部）。
 *
 * 這是「lazy-CJS factory」格式的 client bundle（DSH client-modules 線格式，
 * 與官方 @deepseek-ai/dsh-client-ui-* 及 dsh-better-sidebar 相同的信封）：
 * 執行僅註冊 factory，materialize 時才跑模組體。刻意手寫此格式而不用打包器：
 * 零構建鏈、零外部依賴宣告風險（react 在平台凍結模組表內）。
 *
 * 掛載點：`settings.plugin.item` keyed slot，key = settings namespace
 * `dsh-model-refresh` —— Web 設定頁 → Plugins → Plugin configuration 分頁會
 * 對每個 served namespace dispatch 此 slot，key 對上即渲染本卡（M4 規劃 §2.2）。
 *
 * 資料面：prefs 讀寫走 ctx.settingsScope（revision fence 樂觀鎖，官方通道）；
 * 狀態與手動刷新走 M4-A 的宿主 route（信任圍欄保護）。
 */
window.__ModuleLoader__.load({
  id: "dsh-model-refresh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    var NS = "dsh-model-refresh";
    var API_BASE = "/model-refresh/api";
    var DEFAULTS = { enabled: true, intervalHours: 12, initialDelaySeconds: 90 };
    var FIELDS = [
      { key: "enabled", label: "啟用自動刷新", type: "checkbox", hint: "關閉即完全休眠（手動刷新仍可用）" },
      { key: "intervalHours", label: "刷新間隔（小時）", type: "number", min: 0.25, step: 0.25, hint: "實際下限 15 分鐘（host 端夾取）" },
      { key: "initialDelaySeconds", label: "啟動延遲（秒）", type: "number", min: 0, step: 10, hint: "開機後第一輪的等待，讓 DSH 開機風暴先過" },
    ];

    function injectCss() {
      var tagId = "dsh-model-refresh/card.css";
      if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="' + tagId + '"]')) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = tagId;
      tag.textContent = [
        ".mrc-card{display:flex;flex-direction:column;gap:10px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
        ".mrc-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
        ".mrc-title{font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary)}",
        ".mrc-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
        ".mrc-field{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l2)}",
        ".mrc-row{display:flex;align-items:center;gap:8px}",
        ".mrc-label{flex:1;font-size:13px;color:var(--dsw-alias-label-primary)}",
        ".mrc-input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);height:30px;border-radius:8px;padding:0 10px;font:inherit;font-size:13px;width:120px}",
        ".mrc-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
        ".mrc-badge{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px}",
        ".mrc-reset{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;cursor:pointer;padding:0}",
        ".mrc-reset:hover{color:var(--dsw-alias-label-primary)}",
        ".mrc-actions{display:flex;gap:8px;align-items:center}",
        ".mrc-btn{font:inherit;font-size:13px;border-radius:8px;padding:5px 14px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}",
        ".mrc-btnPrimary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
        ".mrc-btn:disabled{cursor:default;opacity:.5}",
        ".mrc-msg{font-size:12px;min-height:16px}",
        ".mrc-msgErr{color:var(--dsw-alias-label-error)}",
        ".mrc-msgOk{color:var(--dsw-alias-label-primary)}",
        ".mrc-status{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--dsw-alias-label-tertiary);padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l2)}",
        ".mrc-status code{font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ].join("\n");
      document.head.appendChild(tag);
    }

    /** Read-only status snapshot from the M4-A host route (null on failure). */
    async function fetchStatus() {
      try {
        const res = await fetch(API_BASE + "/status");
        const json = await res.json();
        return json && json.ok ? json.status : null;
      } catch {
        return null;
      }
    }

    /** Manual refresh through the shared single-flight tick. */
    async function fetchRefresh() {
      try {
        const res = await fetch(API_BASE + "/refresh", { method: "POST" });
        return await res.json();
      } catch (err) {
        return { ok: false, error: { code: "network", message: String(err && err.message || err) } };
      }
    }

    function fmtTime(iso) {
      if (!iso) return "—";
      try { return new Date(iso).toLocaleString(); } catch { return iso; }
    }

    function apply(ctx) {
      injectCss();
      const scope = ctx.settingsScope.bind({ namespace: NS });

      const ctrl = {
        scope,
        /** Field is user-overridden when present in the raw user layer. */
        overridden(snap, field) {
          return Boolean(snap.user && Object.prototype.hasOwnProperty.call(snap.user, field));
        },
        async resetField(field) {
          try { await scope.unset(field); return null; }
          catch (err) { return err && err.message || String(err); }
        },
        /** One revision-fenced mutate over the dirty fields. */
        async save(staged, current) {
          const ops = [];
          for (const f of FIELDS) {
            if (!(f.key in staged)) continue;
            const value = staged[f.key];
            if (f.type === "number") {
              const n = Number(value);
              if (!Number.isFinite(n) || n < f.min) return { error: f.label + "：需為 ≥ " + f.min + " 的數值" };
              if (current && current[f.key] === n && !this.overridden(scope.getSnapshot(), f.key)) continue;
              ops.push({ op: "set", path: [f.key], value: n });
            } else {
              if (current && current[f.key] === value && !this.overridden(scope.getSnapshot(), f.key)) continue;
              ops.push({ op: "set", path: [f.key], value });
            }
          }
          if (!ops.length) return { saved: 0 };
          try {
            await scope.mutate(ops);
            return { saved: ops.length };
          } catch (err) {
            return { error: "儲存被拒（可能是設定已被其他視窗改動）：" + (err && err.message || err) };
          }
        },
        status: fetchStatus,
        refresh: fetchRefresh,
      };

      ctx.slots.inject("settings.plugin.item", function* () {
        yield ctx.slots.register({
          name: "settings.plugin.item",
          key: NS,
          inject: () => ({ ctrl }),
        }, Card);
      });
    }

    // ------------------------------------------------------------------
    // Card component — staging form like the official plugin cards:
    // edits stay local until 儲存; a revision-fenced mutate carries them.
    // ------------------------------------------------------------------
    function Card(props) {
      const ctrl = props.ctrl;
      const [snap, setSnap] = React.useState(() => ctrl.scope.getSnapshot());
      const [staged, setStaged] = React.useState({});
      const [message, setMessage] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [status, setStatus] = React.useState(null);
      const [refreshing, setRefreshing] = React.useState(false);

      React.useEffect(() => {
        const off = ctrl.scope.subscribe(() => setSnap(ctrl.scope.getSnapshot()));
        let alive = true;
        ctrl.status().then((s) => { if (alive) setStatus(s); });
        return () => { alive = false; off(); };
      }, [ctrl]);

      const value = snap.value;
      const ready = snap.status === "ready" && value;
      const dirty = Object.keys(staged).length > 0;

      const stage = (key, v) => setStaged((prev) => ({ ...prev, [key]: v }));
      const doDiscard = () => { setStaged({}); setMessage(null); };
      const doReset = async (key) => {
        const err = await ctrl.resetField(key);
        if (err) setMessage({ text: "重設失敗：" + err, kind: "err" });
        else {
          setStaged((prev) => { const n = { ...prev }; delete n[key]; return n; });
          setMessage({ text: "已重設為部署預設值", kind: "ok" });
        }
      };
      const doSave = async () => {
        setSaving(true);
        setMessage(null);
        const result = await ctrl.save(staged, value);
        setSaving(false);
        if (result.error) setMessage({ text: result.error, kind: "err" });
        else {
          setStaged({});
          setMessage({ text: "已儲存 " + (result.saved ?? 0) + " 個欄位（熱生效，不需重啟）", kind: "ok" });
        }
      };
      const doRefresh = async () => {
        setRefreshing(true);
        setMessage({ text: "刷新中…（抓取兩家目錄並比對受管清單）", kind: "ok" });
        const [result, st] = await Promise.all([ctrl.refresh(), ctrl.status()]);
        setRefreshing(false);
        setStatus(st);
        if (result && result.ok) {
          const r = result.result || {};
          setMessage({
            text: r.applied
              ? "已套用 " + r.writes + " 個 route 更新（新增 " + r.added + "、移除 " + r.removed + "）" + ((r.warnings || []).length ? "；警示：" + r.warnings.join("；") : "")
              : "無需更新 — 受管清單已與目錄一致",
            kind: "ok",
          });
        } else {
          const code = result && result.error && result.error.code;
          setMessage({
            text: code === "busy" ? "上一輪仍在執行，請稍後再試" : code === "disabled" ? "插件已停用（可在上方開關啟用）" : "刷新失敗：" + (result && result.error && result.error.message || "未知錯誤"),
            kind: "err",
          });
        }
      };

      if (!ready) {
        return h("div", { className: "mrc-card" },
          h("div", { className: "mrc-title" }, "模型清單自動刷新"),
          h("div", { className: "mrc-sub" },
            snap.status === "unavailable"
              ? "此連線不支援持久設定（非 loopback 或 memory mode），卡片在此環境為唯讀顯示。"
              : "載入中…"),
        );
      }

      return h("div", { className: "mrc-card" },
        h("div", { className: "mrc-head" },
          h("span", { className: "mrc-title" }, "模型清單自動刷新"),
          h("span", { className: "mrc-sub" }, "定期抓取 OpenRouter 與 Nous 目錄，維護 llm-pi-ai 的 openrouter / nous-api 受管清單"),
        ),
        FIELDS.map((f) => {
          const current = value[f.key];
          const shown = f.key in staged ? staged[f.key] : current;
          const overridden = ctrl.overridden(snap, f.key);
          return h("div", { className: "mrc-field", key: f.key },
            h("div", { className: "mrc-row" },
              h("span", { className: "mrc-label" }, f.label),
              overridden ? h("span", { className: "mrc-badge" }, "已覆寫") : null,
              overridden ? h("button", { className: "mrc-reset", onClick: () => doReset(f.key) }, "重設") : null,
              f.type === "checkbox"
                ? h("input", { type: "checkbox", checked: Boolean(shown), onChange: (e) => stage(f.key, e.target.checked) })
                : h("input", {
                    className: "mrc-input", type: "number", min: f.min, step: f.step,
                    value: shown === undefined || shown === null ? "" : String(shown),
                    onChange: (e) => stage(f.key, e.target.value),
                  }),
            ),
            f.key in staged
              ? h("span", { className: "mrc-hint" }, "未儲存的修改（預設：" + (f.type === "checkbox" ? (DEFAULTS[f.key] ? "開" : "關") : DEFAULTS[f.key]) + "）")
              : h("span", { className: "mrc-hint" }, f.hint),
          );
        }),
        h("div", { className: "mrc-actions" },
          h("button", { className: "mrc-btn mrc-btnPrimary", disabled: !dirty || saving, onClick: doSave }, saving ? "儲存中…" : "儲存"),
          h("button", { className: "mrc-btn", disabled: !dirty || saving, onClick: doDiscard }, "放棄修改"),
          h("button", { className: "mrc-btn", disabled: refreshing, onClick: doRefresh, style: { marginLeft: "auto" } }, refreshing ? "刷新中…" : "立即刷新一次"),
        ),
        message ? h("div", { className: "mrc-msg " + (message.kind === "err" ? "mrc-msgErr" : "mrc-msgOk") }, message.text) : null,
        h("div", { className: "mrc-status" },
          h("span", null, "上次執行：", h("code", null, fmtTime(status && status.lastRunAt))),
          h("span", null, "上次套用：", h("code", null, fmtTime(status && status.lastAppliedAt))),
          h("span", null,
            "受管清單：",
            status && status.routes
              ? Object.entries(status.routes).map(([route, n]) => h("code", { key: route }, " " + route + " " + n + " 條"))
              : " 尚無資料"),
        ),
      );
    }

    exports.apply = apply;
    // Hard service deps: the card binds the settings namespace and registers
    // the settings.plugin.item slot. Undeclared ctx access is rejected by the
    // cordis Guard ("cannot get property ... without inject") — see official
    // dsh-client-ui-settings-plugins, which declares the same pair.
    exports.inject = ["slots", "settingsScope"];
    return module.exports;
  },
});
