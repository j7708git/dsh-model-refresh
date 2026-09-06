# dsh-model-refresh M4 規劃：Web 設定頁「啟停 + 手動刷新 + 參數調整」入口

- 版本：v1.1（規劃稿 + 實施記錄）
- 日期：2026-09-06
- 前提：不破壞既有 cordis 注入鏈、不影響 M1/M2 已落地功能、變更最小化
- 證據基準：本機 DSH 安裝（`C:\Users\denny\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`）與 web profile 內兩個第三方插件（dsh-better-sidebar、dsh-smart-approval）實際代碼，路徑見附錄 A

> **實施狀態**：M4-A ✅ 已完成（見 §9 分期表與下方「與原規劃的差異」）；M4-B 進行中。

### 與原規劃的差異（M4-A 落地時確定）

| # | 原規劃 | 實際落地 | 原因 |
|---|---|---|---|
| 1 | fence 以 `ctx.webRuntime.trustedHosts` 在 route 包裝層檢查 | fence 改為 `createApiHandler` 的注入參數，handler 內**任何 dispatch 之前**執行 | handler 純函式化，fence 行為可脫離 socket 單測（http.test.js 直接驅動） |
| 2 | status 回傳 `fetchErrors[]` / `warnings[]` | status 只回 prefs＋lastRunAt/lastAppliedAt＋route 條目數；warnings/fetchErrors 僅存在於**當輪** refresh 回應 | warnings 未持久化在 state.json，M4-A 承諾不動 loop.js/state.js；補持久化屬 M4-C |
| 3 | — | 發現既有輕微抖動：連續兩輪對同一 route「同集合異順序」重寫（免費池 tie-break 受目錄 API 返回順序影響） | 非 M4 引入（M3 觀察期行為），記錄於開發文件，暫不修 |

---

## 0. 摘要（TL;DR）

**建議方案：宿主半部加兩條 HTTP route（status + refresh），瀏覽器半部新增一張 `settings.plugin.item` 卡片。**

| 面向 | 結論 |
|---|---|
| 為何現在看不到 | namespace 有註冊，但設定頁卡片是「served namespaces ∩ 已註冊卡片」的交集；本插件沒有瀏覽器半部（無 `dsh.client` 宣告），沒有任何卡認領這個 namespace → 什麼都不渲染 |
| 需要新增什麼 | ① `package.json` 加 `dsh.client` 宣告 + `exports["./client"]`；② 新增 `src/client.js`（React 卡片，掛進 `settings.plugin.item` slot，key = `dsh-model-refresh`）；③ 新增 `src/plugin/http.js`（`ctx.webServer.register` 兩條 route）；④ `src/plugin/index.js` 把 tick 觸發器與狀態接給 http.js |
| 手動刷新走哪條路 | **複用 plugin 內部 `tick()` → `runOnce()` → `settings.mutate` 路徑**，不走 CLI `apply`（CLI 是檔案直寫，繞過 settings 服務與 revision fence，與常駐 loop 併發不安全） |
| 併發安全 | `tick()` 已有 `running` 單飛旗標 + `mutateWithRetry` 樂觀鎖重試；手動觸發走同一個守衛，忙線時回 `{ ok: false, code: "busy" }` |
| 設定項 | 既有三個 prefs（enabled / intervalHours / initialDelaySeconds）+ 讀狀態區 + 立即刷新按鈕；更多規則參數列為 v2 候選（需先重構 cfg 載入時機） |
| 最大風險 | 瀏覽器 bundle 的構建鏈（lazy-CJS factory 格式 + externals 解析）；以 dsh-smart-approval 為最小先例複刻，且 bundle 缺失時 host 會「大聲」報錯，不會靜默 |

---

## 1. 現狀盤點

### 1.1 設定暴露面（現有）

`src/plugin/index.js` 在掛載時向 settings 服務註冊了自己的 prefs 命名空間：

```js
export const PREFS_NS = "dsh-model-refresh";
export const Prefs = z.object({
  enabled: z.boolean().default(true),
  intervalHours: z.number().min(0.25).default(12),
  initialDelaySeconds: z.number().min(0).default(90),
});
// apply() 內：scope = settings.register(PREFS_NS, Prefs)
```

- 這三個欄位**已經**是熱生效的：`scope.watch(() => reschedule())` 讓使用者在 `settings.yaml` 手改 `dsh-model-refresh:` 區段後立即重排程。
- 但暴露面只有「手改 YAML 檔」一途——沒有 UI、沒有指令、沒有事件。

### 1.2 為何 Web 設定頁上看不到、無法操作（逐項對證）

Web 端 Plugins 設定分區（`@deepseek-ai/dsh-client-ui-settings-plugins`，即「Plugin configuration」分頁）的渲染規則，其 README 與 client bundle 原碼（`lib/client.js` L403/L417/L1734）寫得很明白：

> what renders is **the intersection of two ledgers**: the namespaces a live Host plugin registered, and the cards registered under those keys. A served namespace no card claims **renders nothing**.

對照本插件的現狀：

| # | 條件 | 現狀 | 結果 |
|---|---|---|---|
| 1 | Host 端註冊 settings namespace（`settings.register`） | ✅ 已滿足 | `ctx.settingsScope.describe()` 會列出 `dsh-model-refresh`，namespace 出現在 served 清單 |
| 2 | 有插件提供 `settings.plugin.item` slot 卡片，`key` = 該 namespace | ❌ 全域只有四張官方卡：`bash` / `agent-loop` / `subagent-model-selection` / `web-search-deepseek`（client.js L1793-1818 逐一 `yield ctx.slots.register({ key: ... })`） | 交集為空 → **不渲染任何東西** |
| 3 | package.json 有 `dsh.client` 宣告（`platform: "web"` + `exports["./client"]`） | ❌ 完全沒有 | `dsh-client-modules` 掃描 boot graph 時根本不會收錄本插件，瀏覽器載入不到任何本插件的代碼 |
| 4 | 設定頁是否會按 schema 自動渲染表單？ | ❌ 不會。官方 README 明言卡片是 "hand-written controls"；四張內建卡全是手寫 React 元件 | 「註冊 schema 就會出現表單」的捷徑**不存在**，必須自己出瀏覽器半部 |

手動刷新同理：目前 `tick()` 只被 `initialTimer` / `setInterval` 觸發，沒有任何外部入口；CLI `apply` 是**另一套寫入路徑**（`writer.js` 直接原子寫 `settings.yaml`，繞過 settings 服務），README 已把它列為「與 plugin 定時輪可能互相覆蓋」的已知邊界——拿它當 Web 觸發入口會放大這個風險。

---

## 2. 對齊 DSH Web 設定機制（實測到的契約）

以下每一條都在本機安裝中核對過原碼/README（見附錄 A），不是推測。

### 2.1 資料面：settings 服務（已就緒，零改動）

- `dsh-settings`：插件 `register(ns, schema)` 後，`describe({ redactSecrets: true })` 對每個 namespace 回傳「序列化 schema + 解析值 + base/user 分層 + revision」。schemastery 的 `z.boolean()/z.number()` schema 會被序列化上線，瀏覽器端 `ctx.settingsSchema` 負責 rehydrate。
- 寫入走 `scope.set(field, value)` / `scope.mutate(ops, expectedRevision)`，每筆寫入以 namespace revision 作樂觀鎖——與宿主端 `settings.mutate` 同一套衝突語義（`SETTINGS_CONFLICT` / `settings-conflict`）。
- **結論：資料面本插件已經做完了一半（register + schema + watch），只欠「被人看見」的 UI 面。**

### 2.2 UI 面：卡片如何被渲染

- 設定頁骨架 `dsh-client-ui-settings` 宣告 slot 契約；Plugins 分區註冊 `settings.section`（id `plugins`）→ 內含 `settings.plugins.tab`（list）→ 官方 `configurable` 分頁再宣告 `settings.plugin.item`（**keyed** slot，key = namespace）。
- 第三方插件出卡片的方式（dsh-better-sidebar / dsh-smart-approval 先例 + 官方 client.js L1793 形態）：

```js
// 瀏覽器半部 apply(ctx) 內：
ctx.slots.inject("settings.plugin.item", function* () {
  yield ctx.slots.register({
    name: "settings.plugin.item",
    key: "dsh-model-refresh",        // ← 必須等於 settings namespace
    // 可選 locale 綁定
  }, ModelRefreshCard);               // React 元件
});
```

- 分頁會把「served namespaces」逐一 `renderSlot("settings.plugin.item", {}, { entryKey: ns })`——只要 key 對上，卡片就出現在「Plugin configuration」分頁。
- 卡片內編輯用 `ctx.settingsScope.bind({ namespace: "dsh-model-refresh" })`，跟隨內建卡模式：本地暫存 → 儲存時一次 `mutate`（revision fence）→ 成功收合 / 失敗保留草稿；欄位是否「被覆寫」以 user 層**欄位存在性**判定，reset = `unset(field)` 回退 composition/預設層。

### 2.3 傳輸面：瀏覽器 bundle 如何到達瀏覽器

- `dsh-client-modules`：宿主掃描每個 bundle 插件的 `dsh.client` 宣告（`platform: "web"`），把 `exports["./client"]` 的產物組進 boot graph、經 `/plugins` combo URL 下發；瀏覽器惰性 materialize。
- 產物格式：**lazy-CJS factory**——`window.__ModuleLoader__.load({ id: "dsh-model-refresh", factory: (require) => { ... exports.apply = apply; return module.exports; } })`（dsh-better-sidebar `lib/client.js` 開頭/結尾實測）。
- `require("react")`、`react/jsx-runtime` 走平台凍結模組表（baseline，免宣告）；非 baseline 依賴用 `dsh.client.inject`（兩個第三方先例都用這個鍵）宣告，本卡片預計只需要 `@deepseek-ai/dsh-client-ui-slots`（`ctx.slots` 所在層）。
- bundle 未建出來時 host 會**大聲報錯並附建置指令**（README 明文），不會靜默——這對我們的三層驗證鏈是好消息。

### 2.4 動作面：宿主 HTTP route（手動刷新的回程路）

- `dsh-host-webserver` 提供 `ctx.webServer.register({ kind: "prefix" | "exact", path, handler })`，回傳 disposer；匹配規則 exact → 最長 prefix → fallback。
- dsh-better-sidebar 的 `/sidebar/api` 先例（`lib/index.js` L4417-4455）給了完整範式：
  - 信任檢查：`const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)`，不過 fence 直接 403；
  - 只收 POST（列表動作可 GET），JSON envelope `writeOk / writeError`；
  - webserver 可能綁 `0.0.0.0`，**自建 route 必須照抄這道 fence**，不可開無鑑別寫入。
- **結論：Web 設定入口 = 資料面（現成）+ UI 面（新卡）+ 動作面（新 route），三者都落在官方已提供的掛載點上，不需要動 DSH 本體。**

---

## 3. 推薦方案

### 3.1 架構

```
瀏覽器（設定頁 → Plugins → Plugin configuration）
  └─ dsh-model-refresh 卡片（src/client.js，key = "dsh-model-refresh"）
       ├─ 讀/寫 prefs：ctx.settingsScope.bind("dsh-model-refresh")   ← 走官方 settings 通道（revision fence）
       ├─ 狀態列：GET  /model-refresh/api/status                     ← 宿主 route（fence 保護）
       └─ 立即刷新：POST /model-refresh/api/refresh                  ← 宿主 route（fence 保護）
                                                                  │
宿主（web profile 內常駐的 dsh-model-refresh cordis 插件）          ▼
  ├─ settings.register("dsh-model-refresh", Prefs)  ← 既有，不動
  ├─ tick()：running 單飛 → runOnce() → settings.mutate(樂觀鎖)     ← 既有，不動核心
  └─ ctx.webServer.register(/model-refresh/api/*)   ← 新增 src/plugin/http.js
```

### 3.2 掛載點與 schema 變更清單

| 掛載點 | 現狀 | 變更 |
|---|---|---|
| `settings.register(PREFS_NS, Prefs)` | 已註冊 | **不動**。schema 維持純 schemastery 平面物件（`z.boolean()`/`z.number()`），確保可序列化上線 |
| `package.json` `dsh` 欄位 | 只有 `bundle.patch` | 新增 `"client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots"] }`（依 dsh-smart-approval 最小先例；實作時以 loader 掃描行為複核 `inject`/`external` 鍵名） |
| `package.json` `exports` | 無 `./client` | 新增 `"./client": "./lib/client.js"`；`files` 加 `lib/client.js`；`scripts` 加 `build:client` |
| 宿主 route | 無 | 新增 `src/plugin/http.js`：`ctx.inject(["webServer"], ...)` 註冊 prefix route `/model-refresh/api`（帶 fence）；settings 服務缺席時整段休眠（沿用現有 dormant 姿態，與注入鏈教訓一致——回調期內先捕獲實例） |
| cordis.patch.yml / bundle 掛載 | 已掛載 | **不動**（宿主半部仍在同一個 bundle 內，無需重裝 profile bundles；只需重啟 `dsh web` 載入新版） |

### 3.3 瀏覽器卡片（`src/client.js`）

跟隨內建卡（Bash/Subagent 卡）的互動模式：

- **欄位**：三個既有 prefs 的控制項（布林開關、兩個數字輸入，附單位提示：`intervalHours ≥ 0.25`、實際下限 15 分鐘——`reschedule()` 有 `Math.max(15 * 60_000, ...)` 夾取，UI 應如實標註）。
- **覆寫標記 + reset**：以 snapshot 的 `user` 層欄位存在性顯示「已覆寫」，reset 送 `unset`。
- **儲存模型**：本地 staging，Save 時一次 `mutate([三筆 op], expectedRevision)`（Subagent 卡同款）；失敗保留草稿並顯示衝突訊息。
- **狀態列（唯讀）**：`lastRunAt` / `lastAppliedAt` / 上輪 added/removed 數 / 抓取錯誤警示，來自 `GET /model-refresh/api/status`；監聽 `settings/document-updated` 事件刷新（官方卡片同款信號）。
- **立即刷新按鈕**：見 §5。
- 文案 v1 直接內嵌中文字串（變更最小化）；locale 字典註冊列為後續 polish。

---

## 4. 可設定項規劃

### 4.1 v1 暴露項（本規劃範圍）

| 項目 | 類型 | 來源 | UI 呈現 | 依據 |
|---|---|---|---|---|
| `enabled` | boolean | 既有 prefs | 開關；關閉＝完全休眠（計時器全清） | §需求 3-1；已有 `reschedule()` 語義 |
| `intervalHours` | number ≥0.25 | 既有 prefs | 數字輸入 +「實際下限 15 分鐘」提示 | §需求 3-2 |
| `initialDelaySeconds` | number ≥0 | 既有 prefs | 數字輸入 | §需求 3-3 |
| **立即刷新一次** | 動作（非設定欄位） | 新增 route + tick | 按鈕 + 結果回饋行 | §需求 3-4、§5 |
| 執行狀態（唯讀） | — | state.json / CHANGES.md | 卡片頁腳狀態列 | 讓「我剛剛那次按了有沒有效」有憑據（掛載 ≠ 心跳的教訓） |

明確**不**做成 prefs 欄位的：「立即刷新」若塞一個 `refreshNow` 觸發欄位進 namespace，是對設定文檔的語義濫用（要處理寫後清值、revision 競爭、無回傳值三個坑），否決；走 HTTP route 乾淨且有回傳。

### 4.2 v2 候選（列出但不在本期）

| 項目 | 依據 | 為何緩做 |
|---|---|---|
| `freeMaxPerProvider`（免費池上限） | 開發文件 §13 Q2 已定 10；使用者可能想調 | 目前規則參數走 `config/model-refresh.yaml`，由 `loadConfig()` 在**掛載時一次性讀入**（`index.js` L70 `cfgBase`）；搬進 prefs 需重構為每輪重讀 + 驗證，動到 `runOnce` 簽名，違反「變更最小化」 |
| `candidates.target` / `qualifyFactor` / `routeCap` | R3 調參需求 | 同上；且這些值影響寫入計畫的形狀，錯值代價高於三個排程 prefs，宜先有觀察期數據再開放 |
| 變更通知（CHANGES.md 摘要 badge） | M4 原始構想 | 依賴事件面設計，獨立一小期 |

---

## 5. 手動刷新動作設計

### 5.1 走哪條路：plugin 內部路徑，不是 CLI

| 候選路徑 | 評估 |
|---|---|
| **A. POST route → 呼叫與定時輪同一個 `tick()`（→ `runOnce()` → `settings.mutate`）** | ✅ 採用。單一寫入路徑、天然帶 revision 樂觀鎖與衝突重試、結果與 state/CHANGES.md 完全一致 |
| B. Web 觸發 CLI `node src/cli/main.js apply` 子程序 | ❌ CLI 走 `writer.js` 檔案直寫，繞過 settings 服務：與常駐 loop 併發時整檔 last-writer-wins、無 revision fence；README 已知邊界明言兩路並存有互覆風險 |
| C. Web 只觸發 `plan`（乾跑）再由使用者另行 apply | ❌ 兩段式體驗差；且 plan 的差異判定與 mutate 路徑不同源，容易出現「預覽說要改、套用卻冪等跳過」的困惑 |

「plan → apply 分離」在本工具語義裡是**安全驗收手段**，不是 UI 互動模型；Web 手動刷新的預期是「按一下 → 我要看到現在的清單已是最新」。冪等性（無差異時 `ops` 為空、直接「無需更新」）已由 `loop.js` 保證，等價於 plan 的安全性。

### 5.2 併發安全（三道既有防線 + 一個新守衛）

1. **單飛旗標（既有）**：`tick()` 開頭 `if (running) return`。手動觸發與定時 tick 共用同一個閉包函式，天然互斥——**需要小幅強化**：現在忙線時是靜默 return，手動場景要回饋，改為 `tick()` 回傳結果物件（`{ ok, applied, writes, busy }`），定時路徑忽略回傳值，route 回傳給 UI。這是 `index.js` 內 ~10 行的改動，不動核心邏輯。
2. **settings 樂觀鎖（既有）**：`mutateWithRetry` 對 `SETTINGS_CONFLICT` 做一次重試；即使未來有任何第二寫入者（例如另一台機器改 YAML 觸發 provider 事件），寫入也是串行且 fenced 的。
3. **抓取容錯（既有）**：`fetchAll` 失敗回退 last-good，雙失敗且無快取則本輪不寫入——手動刷新在最壞情況下也只是「無操作 + 警示」，不會寫壞清單。
4. **HTTP 層新守衛**：route handler 內不自己跑刷新，只呼叫共用的 `triggerTick()`；回傳 `{ ok: false, code: "busy" }` 讓按鈕顯示「上一輪還在跑」。持續時長上界 = fetch 重試上限（25s × 3 attempts × 指數退避，實測兩家 171–302ms），UI 用 spinner + 完成後回填結果即可，不需要 202/輪詢機制。

### 5.3 API 草案（宿主 route）

```
GET  /model-refresh/api/status
  → { ok: true, status: { enabled, intervalHours, initialDelaySeconds,
        lastRunAt, lastAppliedAt, lastAdded, lastRemoved, fetchErrors[], warnings[] } }

POST /model-refresh/api/refresh
  → 立即: { ok: true, applied: false, note: "無需更新" }
  → 有變動: { ok: true, applied: true, writes: 2, added: 3, removed: 1, warnings: [] }
  → 忙線: { ok: false, code: "busy" }
```

- status 讀 `state.json`（已由 `loadState` 提供）+ 當前 `scope.get()`，無新狀態檔。
- 兩條 route 都過 `isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)` fence（better-sidebar 同款）；`refresh` 僅收 POST。

---

## 6. 涉及模組 / 檔案清單

| 檔案 | 動作 | 內容 |
|---|---|---|
| `package.json` | 修改 | `dsh.client` 宣告、`exports["./client"]`、`files` + `lib/client.js`、`scripts.build:client`（tsdown，複刻 dsh-smart-approval 的最小構建鏈；該插件客戶端僅一檔，是最佳抄寫對象）、版本 → v0.3.0 |
| `src/client.js` | **新增** | 瀏覽器卡片：`settings.plugin.item` slot 註冊（key=`dsh-model-refresh`）、prefs staging 表單、狀態列、刷新按鈕。構建產物輸出 `lib/client.js`（lazy-CJS factory 格式） |
| `src/plugin/http.js` | **新增** | `registerModelRefreshRoutes(ctx, { triggerTick, getStatus })` → `ctx.inject(["webServer"], ...)` + fence + 兩條 route；回傳 disposer 併入 teardown |
| `src/plugin/index.js` | 修改（小） | ① `tick()` 回傳結果物件（忙線時 `{ busy: true }`）；② 在既有 `inject(["settings"])` 回調**內**組好 `triggerTick/getStatus` 後掛 http.js；③ teardown disposer 串接 route disposer。遵守既有鐵律：回調有效期間捕獲服務實例、teardown 用回傳 disposer |
| `src/plugin/loop.js` | **不動** | `runOnce` 簽名與邏輯不變 |
| `src/core/*` | **不動** | M1 全部核心（planner/rules/writer/state/catalog）零改動 |
| `cordis.patch.yml` | **不動** | bundle 掛載不變 |
| `test/plugin-mount.test.js` | 擴充 | 假 ctx 鏡像新增 `webServer`（register 回 disposer、斷言 route 註冊）+ 手動觸發 busy/成功兩態 |
| `test/http.test.js` | **新增** | route handler 單測：fence 拒絕、GET/POST 方法檢查、busy 回包、status 欄位 |
| `scripts/verify-cordis-mount.mjs` | 擴充 | 真主機深檢加掛 webServer 假件 → 斷言 route 註冊 + POST refresh 全鏈跑通 |
| `README.md` / `開發文件.md` | 修改 | 三層驗證鏈升級為四層（+UI 層）；M4 進度日誌 |

---

## 7. 驗證方式（在既有三層驗證鏈上加第四層）

> 掛載 ≠ 心跳 ≠ UI 可見。每層有獨立的可觀察憑據，缺一角不算通過。

1. **解析層（既有，不退化）**：profile 目錄裸名 import 仍通過——
   `cd $env:USERPROFILE\.dsh\profiles\web; node --input-type=module -e "const m=await import('dsh-model-refresh'); console.log(m.name, typeof m.apply)"`
2. **掛載＋心跳層（既有 + 擴充）**：`node scripts/verify-cordis-mount.mjs` 依序出現 register → 已載入 → fetch 200×N → mutate → TICK RAN ✓，新增 `route registered ✓` 與程序內 `POST /model-refresh/api/refresh` 回包斷言。
3. **UI 層（新）**：重啟 `dsh web` 後——
   - 設定頁 → Plugins → **Plugin configuration** 分頁出現本插件卡片（namespace 被 served + 卡片 key 對上，交集非空）；
   - 改 `intervalHours` → 儲存 → host 日誌出現重排程跡象（`已載入（第一輪 …s 後，其後每 …h）` 的下次值變化）；
   - `enabled` 關閉 → `state.json` 不再按週期刷新；開啟 → 恢復；
   - 按下「立即刷新」→ host 日誌 `model-refresh:` 行 + `state/CHANGES.md` / `state.json` mtime 刷新 + 按鈕回填結果；快速連按兩下，第二次收到 busy；
   - 瀏覽器 DevTools Network：`/plugins` boot graph 內含本插件 bundle、無 404、無 activation 錯誤（bundle 缺失時 host 會大聲報錯，看 host log）。
4. **單測層（離線）**：`npm test` 全綠——既有 36 項不退化 + 新增 route/卡邏輯項。
   注意：客戶端 bundle 是建置產物，改 `src/client.js` 後需重跑 `build:client`；官方 shell 的 HMR 只在 `pnpm run dev:web` 進行中才對 client-plugin 熱載，第三方插件的 bundle 變更以「重建 + 頁面重新整理」為準。

---

## 8. 風險點與緩解

| # | 風險 | 等級 | 緩解 |
|---|---|---|---|
| 1 | **瀏覽器 bundle 構建鏈**：lazy-CJS factory 格式 + externals 解析是 DSH 特有契約，本插件目前無構建鏈 | 高 | 以 dsh-smart-approval（單檔客戶端、tsdown、inject 宣告）為最小先例複刻；bundle 缺失/格式錯時 host「大聲」報錯，第一輪驗證即可暴露；最壞退路＝v1 只交付宿主 route（§7-2 全部可測），卡片延後一期，設定仍可手改 YAML |
| 2 | **注入鏈回歸**：三流事故的教訓（exports 主入口、inactive context、`ctx.dispose()` 不存在） | 高 | 宿主改動全部落在既有 `inject(["settings"])` 回調**內部**；新增的 `inject(["webServer"])` 用可選休眠姿態；teardown 一律回傳 disposer；mount 單測鏡像真實介面（假 webServer 無 `dispose` 方法、斷言 route disposer） |
| 3 | route 未設 fence / 方法未檢查 → webserver 綁 `0.0.0.0` 時變成無鑑別寫入入口 | 中 | 照抄 better-sidebar 的 `isTrustedApiRequest` fence + POST-only + JSON envelope，並列入 http.test.js 斷言 |
| 4 | 手動刷新與定時 tick 併發 | 中 | 共用 `tick()` 單飛旗標（§5.2）；`mutateWithRetry` 兜底；最壞情況＝busy 回包，無資料風險 |
| 5 | schema 序列化不過（未來有人往 Prefs 加非 JSON 型別） | 低 | 規劃明文：Prefs 維持平麵 schemastery 純量欄位；新增欄位時跑 `settings.describe` 冒煙斷言 |
| 6 | 非 loopback / memory mode 下設定面不可用（ui-settings 已知限制：durable settings 僅 loopback） | 低 | 官方行為，卡片會呈現 inert/unavailable 態；文件標註即可 |
| 7 | M1 CLI `apply` 與本入口混淆 | 低 | README 明確：常駐期間手動操作走 Web 按鈕或 CLI `plan`（唯讀）；CLI `apply` 僅在 plugin `enabled: false` 時使用 |
| 8 | 官方介面變動（slot 契約 / boot graph 格式隨 dsh 升級漂移） | 中 | 卡片只依賴兩個最穩定的公開面（`settings.plugin.item` slot、`settingsScope`）；升級 DSH 後按 §7 四層重驗 |

---

## 9. 分期建議

| 期 | 內容 | 驗收 |
|---|---|---|
| **M4-A（宿主）✅ 2026-09-06** | `src/plugin/http.js` + `index.js` tick 回傳值 + status/refresh route + 單測 + verify 腳本擴充 | §7-1/2/4 綠（單測 48/48；真機深檢 HTTP STATUS/REFRESH/FENCE ✓）；重啟後線上可 `Invoke-RestMethod` 打通兩條 route |
| **M4-B（UI）** | `dsh.client` 宣告 + `src/client.js` 卡片 + `build:client`（若走免構建的手寫 factory 則免） | §7-3 全綠：卡片可見、三 prefs 可改可 reset、刷新按鈕全鏈回饋 |
| **M4-C（選配）** | §4.2 v2 prefs（需先做 cfg 每輪重讀重構）、locale 字典、變更通知 badge | 另立驗收 |

A、B 可同分支開發但**分兩次重啟驗證**——先讓宿主 route 上線（即使卡片未就緒，手動刷新已可用），再疊 UI，符合本專案「每一步都有獨立憑據」的事故教訓。

---

## 附錄 A：證據索引（本機實測，2026-09-06）

| 事實 | 來源 |
|---|---|
| `settings.plugin.item` keyed slot + 四張官方卡註冊 | `...\@deepseek-ai\dsh-client-ui-settings-plugins\lib\client.js` L403/L417/L1788-1818 |
| 「served namespaces ∩ cards，無卡認領不渲染」 | 同上 README.md（Use this package 節）＋ L1734 `ConfigurablePluginsTabController` |
| 卡片手寫、staging → revision-fenced mutate → 收合/保留草稿 | 同上 README.md（Editing and saving 節） |
| `dsh.client` 宣告 + `/plugins` 下發 + lazy-CJS factory 格式 + 大聲報錯 | `...\@deepseek-ai\dsh-client-modules\README.md`（Declaring a client plugin / Build requirements / Lazy-CJS model 節） |
| factory 格式實例 | `C:\Users\denny\.dsh\profiles\web\node_modules\dsh-better-sidebar\lib\client.js` 首尾 |
| 第三方最小先例（單檔 client + tsdown + inject 宣告） | `C:\Users\denny\.dsh\profiles\web\node_modules\dsh-smart-approval\package.json` |
| `ctx.webServer.register` 契約（exact/prefix、disposer、碰撞即擲錯） | `...\@deepseek-ai\dsh-host-webserver\README.md` |
| fence + prefix route + JSON envelope 完整範式 | `dsh-better-sidebar\lib\index.js` L4348/L4417-4455 |
| settings describe/update/mutate/revision 語義（宿主端） | `...\@deepseek-ai\dsh-settings\README.md` |
| settingsScope bind/set/unset/mutate 契約（瀏覽器端） | `...\@deepseek-ai\dsh-client-ui-settings\lib\types\client\settings-contract.d.ts` |
| 本插件現狀（prefs/tick/mutateWithRetry/單飛旗標） | `D:\Agent開發項目工作區\dsh-model-refresh\src\plugin\index.js`、`src\plugin\loop.js` |
| CLI 檔案直寫路徑（對照組） | `D:\Agent開發項目工作區\dsh-model-refresh\src\core\writer.js`、`src\cli\main.js` |
