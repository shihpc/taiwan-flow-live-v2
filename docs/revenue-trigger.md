# 月營收管線改由 Worker 主觸發（規格與驗收條件）

建立：2026-11-13。使用者指示：「靠 taiwan-flow-live-v2 的 Worker 主動觸發、排程只當備援」。

## 1. 背景

postmkt `.github/workflows/revenue.yml`（月營收 Beat／Miss，規格 `postmkt/docs/revenue-beatmiss.md`）原本只有 GitHub cron
`30 23 10-15 * *`（台北每月 11–16 日 07:30）。2026-11-13 第一次排程**未準時觸發**（台北 08:44 查仍無 run）；同 repo 其他排程
11/12 晚間實測延遲約 7 小時（例：`build.yml` cron UTC 13:53 → 實際 21:08）。GitHub 排程整次跳過時連 `notify-failure` 都不會觸發，
沒有人會知道某個月沒產出。家族其他每日管線早已改成 Worker 主觸發、GH cron 兜底（本檔 `worker/src/index.js` 的
`// ---- 排程備援` 區塊）。本批把月營收納入同一套機制。

## 2. 設計

- **納入 `export function backupPipelines`**，新增一條：
  `{ name: "revenue", repo: "postmkt", wf: "revenue.yml", url: \`${POSTMKT_BASE}/data/revenue/index.json\`, field: "latest", mode: "revMonth", tw: false, ... }`。
  沿用既有的 token 守門、`bkfired:<date>:revenue` 冪等、產物新鮮度檢查、`ghDispatchWithRetry`、dispatch 失敗告警（`bk-err-revenue`）、
  `/backup?name=revenue` 手動檢查端點（`dry` 預設 1，不需管理金鑰）。
- **新的新鮮度模式 `revMonth`**（加在 `export function productFresh`）：產物 `latest`（`YYYY-MM`）≥ 台北今日的**上一個月**即新鮮
  （1 月的上一個月是前一年 12 月）。`latest` 缺值、型別不對、格式不合 `^\d{4}-\d{2}$` 一律不新鮮（→ 補發）。
  既有模式（`date`／`genToday`／`usDate`）行為逐字不變。
- **日期守門**：只在台北日期的「日」為 **11–16** 時動作，其他日子回 `{skipped: "out-of-window"}`、不抓產物、不讀寫 KV、不 dispatch。
  理由：申報期限每月 10 日、遇假日順延；與 postmkt GH cron 的 11–16 日同一個窗。
- **不看交易日、不看週末、不看國定假日**：月營收是每月申報的公開資料，週末與國定假日照樣可抓。實作上：
  ①`runBackup` 的 `tw:false` 分支目前有「台北週末不跑」的守門（給 us 班），**revenue 必須不受它影響**（新增一個明確的旗標，例如 `anyDay: true`，
  只有 revenue 帶；us 班行為逐字不變）；②`scheduled` handler 的國定假日守門本來就只套 `bpipe.tw` 為真的班，revenue 為 `tw:false` 自然不受影響。
- **cron**：新增一條 `"13 23 10-15 * *"`＝UTC 每月 10–15 日 23:13＝**台北每月 11–16 日 07:13**（比 GH cron 的 07:30 早 17 分；分鐘選 13 是為了避開
  既有 cron 的同分撞點——`*/5 23 * * *` 只有 5 的倍數、`7,47 0-14,22-23` 只有 :07／:47、`10 23 * * 2-6` 是 :10）。加進 `wrangler.toml` 的 `crons`
  與 `export const BACKUP_CRONS`（值 `"revenue"`）。由 `dispatchRoleForCron` 精確攔截，**不可落到 `scheduledRole`**（台北 07:13 若 fallthrough 會被當成
  frame 或其他角色）。**不加 recheck cron**：每天只檢查一次、窗內 6 天＝最多 6 次 dispatch；同日 GH cron 仍會再跑一次。
- **冪等與並存**：Worker 判定新鮮就不 dispatch；GH cron 照舊每天跑一次（postmkt builder 內容相同就不寫檔、不 commit；workflow 有 concurrency group
  序列化），兩邊交錯不會產生重複 commit 或衝突。
- **postmkt 端**：`revenue.yml` 的 cron **原樣保留**（兜底），只改註解說明 Worker 為主觸發；README／CLAUDE.md（佈局段非 CANON 部分）同步。

## 3. 已知限制（寫進 CLAUDE.md）

- 新鮮度只看「`latest` 是否已到上個月」：上個月一旦產出，之後幾天的 Worker 檢查都會判新鮮、不 dispatch；**晚報公司與數字更正的重算只靠
  GH cron**（延遲數小時無妨，只要不是整次被跳過）。
- 首日（11 日）若上市櫃公司多數尚未申報（期限順延的月份），postmkt builder 會因「可分析家數未達五成」不寫檔 → 產物仍舊 → 隔天 Worker 再發一次；
  這是預期行為，不告警。
- `alertJob` 本體對台北週末一律 skip，**週末那天 dispatch 失敗不會告警**（既有限制，同 iching 週六班）。
- 6 天窗內每天都 dispatch 失敗或 workflow 每次都沒產出，目前沒有專門的「整個月沒產出」告警（`runHealthCheck` 不納入本班，避免本批擴張；另案）。

## 4. 驗收條件

目標專案：`/home/claude/taiwan-flow-live-v2`（Worker）與 `/home/claude/postmkt`（文件與 workflow 註解）。

1. `worker/test/*.mjs` 全部通過（同 `worker-deploy.yml` 的 glob 跑法）；新增測試至少涵蓋：
   - `productFresh` 的 `revMonth`：當月上一月＝新鮮、更早＝不新鮮、1 月跨年、缺值／非字串／格式不合＝不新鮮；既有三種模式的輸出不變。
   - `runBackup(revenue)`：台北 10 日與 17 日 → `out-of-window`（零 fetch、零 KV）；11 日與 16 日 → 進入判定；**週六、週日照樣進入判定**；
     產物不新鮮 → 恰 dispatch 一次 `postmkt/revenue.yml`、寫 `bkfired`；產物新鮮 → 不 dispatch；同日第二次呼叫 → `already-fired` 短路；`dry` 只回決策。
   - us 班的週末守門行為不變（既有測試不得放寬）。
   - `dispatchRoleForCron("13 23 10-15 * *")` 回 `{kind:"backup", name:"revenue"}`；`scheduled` handler 對該 cron 在國定假日照樣呼叫 `runBackup`。
2. `wrangler.toml` 的 crons 由 22 條變 23 條，`test/routing.mjs` 的條數與 cron→角色對照表同步；以腳本逐分鐘展開一個月（含 10–16 日）比對，
   新 cron 與既有 22 條**沒有同分撞點**（腳本不進 repo，結果寫進 CLAUDE.md）。
3. 既有角色行為不變：除新增那條 cron 外，`dispatchRoleForCron`／`scheduledRole` 對既有 22 條 cron 的輸出逐字相同；既有測試只允許因條數或對照表新增而改，
   不得放寬任何既有斷言。
4. 文件：本 repo CLAUDE.md（排程備援相關段落、cron 條數、測試支數若有變）、`worker/wrangler.toml` 該 cron 的行內註解；postmkt 的 `revenue.yml` 註解、
   README 與 CLAUDE.md 對 revenue workflow「只有 GitHub cron」的敘述改為「Worker 主觸發＋GH cron 兜底」。兩邊 CANON 區塊不動。
5. 部署：push 後 `worker-deploy` workflow 成功；**線上驗證**：`GET https://taiwan-flow-v2.shihpc.workers.dev/backup?name=revenue`（dry）在台北 11–16 日
   回 `fresh: true`、`productDate: "2026-10"`（或當時最新月份）——證明線上跑的是新版且讀得到產物；窗外日期回 `out-of-window`。
6. 首次 cron 實際觸發（台北 2026-11-14 07:13）後，以 `/jobs` 或 `wrangler tail` 可見該班的決策紀錄（預期 `fresh`，因 10 月已產出）。
