# dsh-model-refresh

DSH（DeepSeek Harness）模型清單智慧更新工具 — 依 [`開發文件.md`](./開發文件.md) 實作的 **M1 核心函式庫 + CLI ＋ M2 常駐 plugin**。

定期抓取 Nous Portal 與 OpenRouter 的公開模型目錄，自動完成三件事並熱生效於 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.*.models`：

- **R1 免費池**：零價且有工具支援的模型自動進出（每家上限 10）。
- **R2 常駐 pins**：`~deepseek/deepseek-v4-flash-latest`、`deepseek/deepseek-v4-flash-vision-exp`、`z-ai/glm-5.3-flash`、`qwen/qwen3.7-flash`、`qwen/qwen3.8-flash` 永遠保留（目錄解析失敗時保留上次條目，絕不靜默刪除）。
- **R3 智慧候補**：輸入與輸出第一檔 ≤ $1/M、支援工具、≥256k context，能力以 Artificial Analysis 指數（缺漏時用代理訊號）對比 pins 中位數評分，取 3–5 個；滯回汰換防震盪。

## 用法

```sh
npm install
node src/cli/main.js plan            # 乾跑：產出計畫 + CHANGES.md，不寫任何東西到 settings
node src/cli/main.js apply           # 驗證 → 備份 settings.yaml → 原子寫入
node src/cli/main.js status          # 檢視目前受管清單
node src/cli/main.js rollback        # 還原最近一次 apply 前的備份
npm test                             # 離線單元測試（fixtures）
npm run fixtures                     # 更新離線快照（需網路）
npm run verify:real-host             # 真實 cordis 主機深檢（改動 plugin 殼後必跑，見下）
```

常用 flag：`--settings <path>`、`--state-dir <path>`（狀態/報告/備份目錄）、`--offline`（用快取目錄跑，不抓網路）、`--config <path>`。

## 與 DSH 的關係

- 只寫 `llm-pi-ai.providers.openrouter.models` 與 `llm-pi-ai.providers.nous-api.models` 兩個受管清單；其他命名空間、註解、格式由 `yaml` 文件模型保留。
- **思考能力（v0.2.4+）**：受管條目會把目錄宣告的 `reasoning.supported_efforts`（如 `max/high/low`）寫成 `reasoningEfforts: {低位: 低位, ...}`。DSH 的 `llm-pi-ai` adapter 依此解析 `reasoning: true`，Web UI 就能為該模型選擇思考強度——對 `nous-api` route 尤其重要，因為 pi-ai 沒有內建 nous 目錄，缺這個欄位時每個模型都被判成不支援思考（只能選 off）。目錄未宣告任何 effort 的模型不會寫入該欄位，避免虛報能力。
- 首次 `apply` 時，兩條 route 原有的使用者條目全部以 `imported` 保留（驗收 §12-5：僅新增、不刪除）。
- 寫入後 DSH 下一次模型請求即熱生效，無需重啟；DSH 自身的 `assertServiceable` 驗證器是第二道防線（壞區段會保留最後良好值）。
- API 金鑰不在本工具職責內（沿用 `apiKeyEnv` 參考）。

## 常駐模式（M2 plugin）

> **當前狀態（2026-09-06）**：v0.2.4 — 常駐 plugin 每輪寫入 `reasoningEfforts` 思考能力欄位（修復 nous-api 無法選思考強度）。**需重啟 `dsh web` 載入新版 plugin**，重啟後第一輪自動補寫既有條目。

`dsh web` 重啟後，本套件以 cordis plugin 形式常駐：

- ** prefs 命名空間 `dsh-model-refresh:`**（寫進 `settings.yaml` 即可熱調整，不需重啟）：
  ```yaml
  dsh-model-refresh:
    enabled: true          # 設 false 即完全休眠（CLI 仍可随时手動跑）
    intervalHours: 12      # 刷新間隔（下限 0.25h）
    initialDelaySeconds: 90  # 開機後第一輪延遲
  ```
- 週期行為與 CLI `apply` 同一套核心：抓目錄 → 規則 → 有差異才經 `ctx.settings.mutate`（樂觀鎖、衝突自動重試、DSH 驗證器把關）寫入，熱生效。
- **與手動編輯共存**：你在 Settings 頁/選單裡加進 `llm-pi-ai.providers.*.models` 的條目會被收編為 `imported` 保留；手動**刪除**的受管條目會被記住（抑制清單，不再自動加回）；pin 被刪除則自動恢復並警告。
- 狀態與報告同 CLI：`~/.dsh/model-refresh/`（`state.json`、`CHANGES.md`、`backups/`）。

解除安裝：`dsh plugin --profile web remove dsh-model-refresh` 並從 profile `package.json` 的 `bundles` 移除 `"dsh-model-refresh"`（官方 remove 已知不會自動清 bundles 條目）。

## 安裝後必驗（教訓規程）：三層驗證鏈

掛載成功 ≠ 插件會動。三次事故（開機崩潰／掛載了但無心跳×2）換來的規程，每次改動 plugin 殼或重新安裝後按序跑：

1. **解析層** — 在 profile 目錄重現 cordis 的裸套件名 import（`exports` 缺 `"."` 主入口曾令整棵 web tree 起不來）：
   ```powershell
   cd $env:USERPROFILE\.dsh\profiles\web
   node --input-type=module -e "const m = await import('dsh-model-refresh'); console.log(m.name, typeof m.apply)"
   # 期望：dsh-model-refresh function
   ```
2. **掛載＋心跳層（真實主機深檢）** — 程序內起真 cordis（Context＋官方 loader，baseUrl=profile 目錄）掛載本插件並等第一輪 tick 完整跑完：
   ```powershell
   node scripts/verify-cordis-mount.mjs
   # 期望依序出現：[probe] register → 「已載入」→ mounted ✓ → [fetch] 200×3 → mutate → 已套用/無需更新 → TICK RAN ✓
   ```
3. **線上心跳層** — 重啟 `dsh web` 後超過 `initialDelaySeconds`（預設 90s），`~/.dsh/model-refresh/state.json` 的 mtime 必須刷新、host 日誌出現 `model-refresh:` 行。**只驗 dump-config 有掛載不算通過。**

> 單測層防呆同步固化：`test/plugin-mount.test.js` 以「鏡像真實 cordis 介面」的假 ctx（沒有 `dispose` 方法、斷言 inject 回調回傳 disposer）跑完整掛載→tick。插件代碼兩條鐵律：inject 回調期間**捕獲服務實例**（回調返回後 `sctx` 即失效）、teardown 用**回傳 disposer**（cordis 4 無 `ctx.dispose()`）。

## M1/M2 已知邊界（對照開發文件）

- 交付形態：單套件（`src/core` 與 `src/cli` 已模組化，M2 抽包即可）。
- 每個受管條目一律寫入完整元資料（contextWindow/maxTokens/input），與使用者現有手工風格一致；未依賴 pi-ai 靜態目錄繼承。
- LLM judge（M3+ 選配）尚未實作；候補能力評分目前用 AA 指數＋代理訊號。
- 變動通知為檔案（`~/.dsh/model-refresh/CHANGES.md`）與 host 端 log（plugin 模式），Web UI 設定頁在 M4。
- 同時手動跑 CLI `apply` 與 plugin 定時輪理論上可能互相覆蓋（兩邊都有備份/驗證兜底）；plugin 常駐期間手動操作建議用 `plan`（唯讀）。
- `rollback` 只還原 `settings.yaml`，**不回滾** `state.json` — 常駐 plugin 下一輪會依舊 state 重新套用計畫。想讓 rollback 站得住：先把 `dsh-model-refresh.enabled` 設 `false`，或一併刪掉 `~/.dsh/model-refresh/state.json`（下次會視為首次接管，僅新增不刪除）。
