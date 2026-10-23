# CLAUDE.md — taiwan-flow-live-v2 接手速覽

<!-- CANON:BEGIN v1 -->
<!-- 唯一事實來源＝shihpc/claude-harness 的 CANON.md。以下區塊在家族各 repo 的 CLAUDE.md 頂端
     有 byte-identical 逐字副本，由各 repo 的 .github/workflows/canon.yml 守門（比對 sha256）。
     改動流程：先改 claude-harness/CANON.md → 跑 tools/sync_canon.py 同步全部副本 → 更新守門 hash。
     **repo 名單以 tools/sync_canon.py 的 TARGET_REPOS 為準，此處刻意不寫死數量**——
     數量已改過兩次（五→六→七），每改一次就得動全部 repo 的 CLAUDE.md 與守門 hash。
     不要只改單一 repo，CI 會擋下來。 -->

## 通用工作鐵律（家族各 repo 逐字相同，勿單獨修改）

1. **機密**：token／金鑰只存在不受版控的本機設定或受控 secrets（`.env`／Actions secret／
   `wrangler secret`），絕不寫進會 commit 的檔案、log 或對話輸出。commit 前掃 staged 內容，
   **只回報檔名／行號／類型、不把可疑字串原文印出來**；`sk-ant-`／`ghp_`／`eyJ` 是線索不是全集。
2. **指揮官不下場**：掃 repo、通讀 >300 行的檔、一次讀 >3 個檔、查網頁研究、批次改檔、
   驗收改過的東西——這六類一律派 subagent，主對話只收結論＋`檔案:行號`；但 subagent 回報
   **不等於事實**，主對話為核對結論可直接查原始證據。雲端 session 的 subagent 派工（含第 3 條
   驗收）已獲常備授權，需要時直接派，不需逐次詢問。
3. **先寫驗收條件再動手**：動手前先寫下目標專案完整路徑＋怎樣算完成＋怎麼驗。修改者先自測，
   再派 fresh-context subagent 驗收——**改東西的 agent（含主對話自己）不得擔任驗收者**。
   驗收要綁**確切 commit／產物版本**；驗收後又改動，受影響部分要重驗。
4. **不確定不亂說**：陳述事實（尤其技術細節、數字、外部服務的限制與行為）要嘛附佐證（官方
   文件、實測、`檔案:行號`），要嘛明說「這點我不確定，需要查證」，不可憑印象當確定講。區分
   「已驗證事實」與「推測」，推測要標明；**`檔案:行號` 只證明程式這樣寫，不證明線上這樣跑**。
5. **一次只做一件事**：聚焦一個明確目標，完成該目標必要的修改、測試與整合；不擅自加入無關
   重構或延伸功能。範圍外問題簡短記錄、不自行擴張任務。
6. **完成的定義**：驗收條件逐條打勾＋fresh-context subagent 驗過＋產物在使用者拿得到的位置，
   並明示已完成與未完成；**可執行的東西沒實跑過不算完成**（純文件交付以內容與結構檢查為準）。
   涉及部署者另需 push＋部署 workflow 成功＋在**實際服務的位置**驗證本次變更（線上頁面／API／
   資料時戳）——**raw URL 只證明原始碼進了 repo，不證明線上跑的是該版本**，200 也不等於功能正確。
7. **push 前**：先確認目前分支與推送目標，`git fetch` 後檢查遠端是否領先，非空必須先看內容
   （訊息／時間戳／diff）。一般 push → rebase 整合（本專案既定政策），嚴禁直接覆蓋；force push
   前若遠端領先的 commit 是真實新工作 → 停下來問，且一律用 `--force-with-lease=<ref>:<預期 SHA>`；
   授權「這次 force push」不等於授權蓋掉遠端所有領先 commit。
8. **新指標／訊號若會影響投資方向、候選排序、進出場或風險判定，先問有沒有回測依據**；沒有
   回測依據時，經使用者明確裁定可先上線，但畫面須標明「AI 研判，未經回測，非保證」、裁定須
   登錄於該 repo 文件，並列入事後驗證；純描述性顯示（欄位、日期、圖示）只需驗算式正確。市場
   內容可做情境判讀與多空因素分析，可研判市場與大眾情緒對該數值或新聞的可能反應，並可提供
   具體個股／標的的買賣建議與進出點位；以上均須附依據、區分事實與推論，並標明屬 AI 研判而
   非保證。
9. **語言**：對話與文件用繁體中文；程式碼註解可中文，identifier 用英文；外部原文、API 名稱、
   指令與錯誤訊息保留原樣。

> 判準細則、派工模板、教訓簿見 `shihpc/claude-harness`（private）。雲端 session 需 add_repo 才讀得到。
<!-- CANON:END v1 -->

台股盤中即時資金流向監控站，同時是「股市雷達」四站家族的**資料中樞**
（見 `PROJECT_SUMMARY.md`「一句話說明」段）。線上 https://shihpc.github.io/taiwan-flow-live-v2/ 。
前端是單檔 `index.html`（191KB，2026-09-07 實測 195,343 bytes），7 個 tab：即時一覽／產業別／產業鏈／成交佔比／
資金湧入／資金退出＋摘要分析（`index.html` 的 `<div class="tabs" id="tabs">` 區塊，
一個 tab 一個 `data-tab` 值）。
**`PROJECT_SUMMARY.md`（143KB，2026-09-06 實測 146,133 bytes）是本專案主記憶，接手先讀它**（「快速接手」段有未解問題）。
前端有兩組跨站同步碼：**三站逐字同步**的 `callClaude`／`mdToHtml`／`linkifyStocks`／
`ghSaveAnalysis`／`sumCtx*` 與費用估算 `insightCostText`／`INSIGHT_PRICES`／`USD_TWD`
（`index.html:793-812`）；**四站同步但非逐字**的 `loadSiteVer()`＋footer `#siteVer`
（`index.html:181`、`:2606`，本站 sessionStorage key `tf2_site_ver`，打
`api.github.com/repos/shihpc/taiwan-flow-live-v2/commits/main`，免金鑰、限 60 req/hr/IP，
失敗靜默隱藏）。清單正本在 `postmkt/CLAUDE.md`「不可破壞的約定」第 2 條。

## 佈局

- `src/` Python 夜間 builder（morning/aetf/baseline/daysummary/us/intraday…）；
  `worker/` Cloudflare Worker（`src/index.js` 單檔＋`wrangler.toml`＋`test/` **31 支** `.mjs`（2026-10-23 `ls worker/test/*.mjs | wc -l` 實查：拆 tick 量測班刪 `tickdiag.mjs`、
  其中與 tick 無關的 cron／靜態守門搬到新增的 `routing.mjs`，另加管理端點認證的 `adminkey.mjs`；前一版 30 支含 10-19 的 `pick2track.mjs`）；
  `data/` 產出 JSON（姊妹站上游）；`backtest/`；`.github/workflows/`
  （**15 支**＝帶 cron 11 支：9 支排程 builder（aetf／baseline／cards／daysummary／intraday／
  lastweek／meta／morning／us，多為 Worker 主觸發的兜底備援）＋`backtest-regen.yml`
  （每月 1 日重生比對班）＋`holidays.yml`（2026-09-28，每週日台北 10:17 抓 TWSE 休市行事曆 →
  `data/twse_holidays.json`，家族共用，規格 `docs/holiday-calendar.md`；**無 Worker 主觸發、只有 GH cron**）；無 cron 4 支：`backtest.yml`（離線煙霧＋規格守門）、
  `canon.yml`（守 CLAUDE.md 頂端 CANON 區塊）、`pages.yml`（部署）、
  `worker-deploy.yml`（動到 `worker/**` 即跑全部測試後 `wrangler deploy`））。
  **15 支全裝 notify-failure（2026-09-06 覆驗 14 支；2026-09-28 新增的 `holidays.yml` 同樣掛 `pipeline: v2-holidays`）**：`.github/actions/notify-failure/action.yml`
  與 `claude-harness/templates/notify-failure/action.yml` 逐字相同（`diff` 空），每支 workflow
  每個 job 的末步都是 `uses: ./.github/actions/notify-failure`＋`if: failure() || cancelled()`
  ＋`with: pipeline: v2-<name>`，workflow 頂層 `permissions` 皆含 `issues: write`
  （以 `yaml.safe_load` 逐支掃過確認，非目測）。同日同管線只開一張 issue、重複失敗改留言。
- **`backtest.yml` 有一個隱含依賴**：它的「規格引用的報告節仍存在且有結論行」步驟會解析
  `docs/line-cards-spec.md` §3.1 表格，**要求恰 6 列 5 欄、末欄為 `backtest/report_sorting.md`
  的一級節代號**（M1/M3/M4/S1/S2/S3）。改該表的欄位順序、欄數或列數會讓 workflow 長紅
  （前例：run #17 與 run #28）。規格前言已同步補記（commit `eb693d7`）。

## Worker 哨兵（跨 repo 觸發中樞，改動前必讀）

程式在 `worker/src/index.js` 的 `function runSentinel`，設計說明見其上方的區塊註解
`// ---- FinMind 哨兵`。
（本檔引用 `worker/src/index.js` 一律用「可 grep 唯一命中的宣告字串」而非行號，例如
`function runSentinel`、`const SENTINEL_SIGNALS`；行號會漂移，宣告字串不會。）

- **cron**：`"*/5 9-14 * * 2-6"`（`worker/wrangler.toml` 內 grep 此字面量即得；
  **dow 為 Quartz 慣例，2-6＝週一~五**）＝ UTC 09:00–14:55
  ＝ **台北 17:00–22:55、週一至五、每 5 分**。程式端二次守門 `function scheduledRole`：
  `weekday && hour>=17 && hour<23 && minute%5===0` 才回 `sentinel`。
- **探測法**（`async function probeSignal`）：對每個未完成訊號打 FinMind
  `dataset=<X>&data_id=2330&start_date=end_date=今日`（最便宜的請求，不掛 cf 快取）。
- **落地判定** `function signalLanded`：今日資料非空即算落地；`daytrade` 另要求
  某列 `Volume>0`——FinMind 會先出空殼列、量值晚到。
- **四訊號 → 觸發對象**（`const SENTINEL_SIGNALS`）：
  | 訊號 | dataset | dispatch 目標 |
  |------|---------|---------------|
  | `inst` 法人買賣超 | TaiwanStockInstitutionalInvestorsBuySell | `taiwan-flows` / `daily.yml` |
  | `holding` 集保持股（約 21:00 後） | TaiwanStockShareholding | `taiwan-flows` / `daily.yml`（冪等重跑補持股欄）|
  | `margin` 融資券 | TaiwanStockMarginPurchaseShortSale | `postmkt` / `build.yml` |
  | `daytrade` 當沖（約 21:30 後才非零） | TaiwanStockDayTrading | `postmkt` / `build.yml` |
- **dispatch**（`export function ghDispatchRequest` 建 URL／`async function ghDispatch(env`
  送出）：`POST api.github.com/repos/shihpc/<repo>/actions/workflows/
  <wf>/dispatches`，body `{ref:"main"}`，回應非 204 即拋錯。
- **冪等**：KV 鍵 `sentinel:<YYYYMMDD>:<signal>`（`export const sentinelKey`），值 `"dispatched"`，
  TTL 172800（2 天）；四訊號全寫入則當晚短路，只讀 KV 不打 FinMind
  （`function runSentinel` 開頭的 `done.every(Boolean)`）。
- **dispatch 失敗不寫 KV**（`function runSentinel` 內 `ghDispatch` 的 catch 分支，
  只 log 不寫 KV）→ 下一輪（5 分後）自動重試。
- **不變式：下游 GitHub cron 全數保留為兜底，一條不刪**
  （見 `PROJECT_SUMMARY.md`「快速接手」的「Worker 升格全系統主排程」段）——
  `taiwan-flows/daily.yml` 台北 21:19、`postmkt/build.yml` 21:53，兩管線冪等，重跑無害。

## 其他 scheduled 角色（分流入口 `export function dispatchRoleForCron` → `export function scheduledRole`）

- `frame`：台北 09:00–13:59 每分鐘存 KV frame ＋ `runAlerts`
- `news`：每日（含週末）06:07–22:07 每小時 :07 → `taiwan-stock-news/build-news.yml`
- `morning`：平日 06:47 → 本 repo `morning.yml`
- `iching`（2026-09-14）：台北 22:30 與 23:30 週一～五各一次 → `taiwan-stock-iching/daily.yml`（股市易經每日班主觸發；
  該 repo 無 GH cron 兜底，dispatch 兩次都失敗走 `alertJob` tag `iching-dispatch-err`；cron `ICHING_CRON` 由 `dispatchRoleForCron`
  精確攔截，因 22:30 撞哨兵窗、23:30 撞晚場班窗。`GH_DISPATCH_TOKEN` 須涵蓋 `taiwan-stock-iching`。測試 `node test/iching.mjs`）
  - **早晨補叫班（2026-09-30 使用者裁定）**：`export const ICHING_AM_CRON = "10 23 * * 2-6"`＝UTC 23:10 週一～五＝**台北 07:10
    週二～六**（dow 為 Quartz 慣例 2-6＝週一~五，UTC 週五 23:10 已是台北週六 07:10；當時為 `wrangler.toml` 第 22 條、**crons 由 21 增為 22 條**；
    2026-10-23 拆 tick 量測班後遞補為**第 21 條、全體 21 條**，toml 條數斷言現在在 `test/routing.mjs`）。`dispatchRoleForCron` 表加 `[ICHING_AM_CRON]: "iching"`，沿用 `dispatchIching`
    零新 dispatch 路徑；`export function ichingSlot(tp)` 以 `tp.hour < 12` 判 am／pm。動機：FinMind 借券餘額 09-29 在 23:30 只落地一半、
    該 repo 寫 waiting，沒有這班要等隔天 22:30 才續算（約 23 小時）；管線冪等、無 pending 即 no-op（Actions 約 40 秒）。
    07:10 當日 TAIEX 尚未落地，`daily_run` 的 `trading_days_since`（TAIEX 有列才算交易日）只會列出前一交易日，**不會替當日寫 waiting**
    （依 taiwan-stock-iching `src/iching/daily_fetch.py` 的 `trading_days_since` 讀碼，未線上實跑）。
    **同分撞點**（逐分鐘展開一週 10,080 分鐘，與當時 toml 全部 21 條既有 cron 比對，腳本另存 scratchpad 不進 repo；當時曾以同法對
    已拆除的 tick 量測班 cron 重算、與其記載相符，作為腳本的自我檢驗）：**只有 `*/5 23 * * *`（am summary 主窗）
    每週 5 撞點**＝這 5 個 07:10；兩條各帶自己的 `event.cron`，`dispatchRoleForCron` 精確比對後分別得 `iching`／`summary-am`，互不干擾。
    **必須被攔截**：`scheduledRole(07:10)` 不是 news／morning／sentinel／idle，而是 fallthrough 的 **`frame`**（會多寫一格
    `f:<date>:07:10` 並多打一次 FinMind），`test/iching.mjs` 7c 把這個事實釘住。
    **`dispatchIching` 的去重／時窗（C2 實查）**：dispatch 本身**沒有** KV 去重（22:30／23:30 本來就各叫一次），早晨班同樣不看前一晚結果。
    原本的週末守門 `dow<1||dow>5` 會把**週六 07:10**（補週五那班）整個 skip，故改成 am 收 dow 2-6、pm 仍 dow 1-5。告警去重鍵
    `alerted:<date>:<tag>` 以台北日為 date，早晨與當晚同 date，所以 am 改用獨立 tag `iching-am-dispatch-err`／`secret-missing-iching-am`
    （pm 仍 `iching-dispatch-err`／`secret-missing-iching`）——同日早晨失敗與當晚失敗各發一則、互不吃額度（7e／7f／7g 測試）。
    **已知限制**：`alertJob` 本體對週末 dow 一律 skip（休市表「不改」），**週六 07:10 dispatch 失敗不會告警**（只 console.error；
    7h 釘住現況），影響＝週五 waiting 要等週一 22:30 才續算。**`/status` iching 的 `dueHour 23.75` 不動**：正常日仍是晚上落地、
    早晨班只縮短「23:30 仍 waiting」那種日子的續算延遲，預期資料日口徑不變。早晨班**不查國定假日**（與 pm 同：該 repo 自判休市、
    無 pending 即 no-op）。`claude-harness/docs/schedule-map.md` 另案（PR-D）同步。
- `evening` 晚場協調班：台北 21:00–23:55 每 5 分，串 pm summary → diag → mktbal → aetf2
  - **選股二追蹤名單 LINE 通知（2026-10-19 使用者裁定，`export async function pushPick2Track`）**：`runEvening` 的**最後一步**
    （排在 `pushDailyCards` 之後、獨立 try/catch，既有步驟順序與行為不變），所以沿用 `runEvening` 的守門（`GH_DISPATCH_TOKEN`、
    `series:<date>` 交易日、`scheduled` handler 的國定假日 `holidaySkip`）；本身再守台北 **22:00–23:55**（`PICK2_PUSH_AFTER_MIN`／`PICK2_PUSH_UNTIL_MIN`）。
    資料＝postmkt raw main `data/pick2/track.json`（`export const PICK2_TRACK_URL`，帶 `?d=` 破快取）；**契約正本在 postmkt**
    （`docs/pick2-score.md`「追蹤名單」節），本站只讀 `schema`（須為 1）／`date`／`tracking`（只數筆數）／`new_today[].{code,name,src,score}`，
    頂層形狀不合＝無資料不推，單筆不合（代號白名單 `^\d{4}[0-9A-Z]{0,2}$`、`score` 為有限數**或 `null`**、`src` 為 auto/manual）丟棄；
    `score` 為 `null`（手動加入的池外股）保留、顯示「總分 —」。
    **推播條件**：`track.date` 在台北今日往前 **4 個日曆日內**（含今日，`PICK2_CATCHUP_DAYS`、`export function pick2DateLag`；未來日期／格式不合不推）、
    該 `track.date` 未推過、`new_today` 有效筆數 >0——**補推**（2026-10-19 驗收要求）：track.json 晚於 23:55 才落地時當晚漏推，隔晚照推，第一行寫 `track.date`；文字由純函式 `export function pick2TrackText` 組（標題「【選股二追蹤】<date> 新選入 N 檔」、
    每檔「代號 名稱 總分 x.x（自動/手動）」、「目前追蹤 M 檔」、「AI 研判，未經回測，非保證」；名稱去控制字元截 20 字、最多列 60 檔、總長 ≤4900）。
    **通道只走 LINE（`LINE_TOKEN`＋`LINE_USER_ID`）、不走 `sendAlert`**——後者會同時送 `ALERT_WEBHOOK` 並加「【排程】」前綴，那是告警通道；
    本則是產品通知，比照 `pushMorningCards`。通道未設＝不抓、不推、**不寫去重鍵**（已知限制 7 同一教訓）。
    **去重鍵 `alerted:<track.date 的 YYYYMMDD>:pick2`**（以 **track.date** 為準、不是台北今日＝同一個 track.date 只推一次；TTL `PICK2_ALERTED_TTL`＝5 天，
    刻意長於補推窗——用既有 `ALERTED_TTL` 2 天的話，上游停產數日時鍵會先過期而重推同一 track.date），**推送成功才寫**；抓取失敗／壞 JSON／LINE 非 2xx 都不寫
    （5 分後重試，窗內至多 24 輪）；超出補推窗或 `new_today` 空也不寫。因鍵要看 track.date，每輪都會先抓一次 track.json（已推過也抓，窗內至多 24 次小請求）。本步失敗**不告警**（避免每輪重試的噪音），結局看 `/evening` 回傳的 `pick2`
    與 jobstat（只記 `pushed`）。測試 `node test/pick2track.mjs`；`test/holidays2.mjs` 的對跑（基準 `94c5773`）以 `LATER_ADDED` 濾掉本步新增的
    track.json fetch 與去重鍵 get，其餘仍逐項比對。
- `health` 健檢班：台北 23:50（`eve`）、09:30（`morn`），只盤點產物落地與否、不 dispatch。
  低頻班 `lastweek`／`meta` 於 2026-08-30 納入 `eve`（`mode:"lowfreq"`，判準 `export function lowFreqDue`）：
  **只在台北週一檢查**（meta 另要求已過本月第一個週六＋2 天），非檢查日整項濾掉不抓也不告警；
  **刻意不納 `backupPipelines`、不新增 CF cron**（使用者裁定，理由見 `PROJECT_SUMMARY.md` 同段）
- （`ticksample` 台指期 tick 量測班 2026-09-09～2026-10-23，**已拆除**，見「台指期 tick 量測班（…已拆除）」節）
- `summary-am` 窗（06:50–08:50）另掛晨場協調班 `export async function runMorning`（見下節）
  ＋us 晨間補跑 `export async function runUsCatchup`（2026-08-13：台北 07:00–08:05 檢查
  us.json 資料日是否達最近預期美股交易日（`export function lastExpectedUsTradingDate`，
  台北二~六＝昨日、日/一＝上週五、美國假日不處理），未達即 dispatch `us.yml`
  inputs.rounds=2；KV 20 分時段桶 dedup、週日/週一晨不跑、08:05 後不觸發。
  動機：FinMind 美股常態 07:30–08:30 才入庫，05:05 主班 12 輪×10 分在 06:59 耗盡
  搆不到入庫窗。us 的 recheck／晨間健檢判準同步由 genToday 改資料日（mode `usDate`））

## 休市日（國定假日）各排程角色（2026-09-29 批次二，規格 `docs/holiday-calendar.md` §5a）

**總原則＝休市日比照週末**：平日才有意義的角色，遇行事曆所列的**平日國定假日**時，行為＝它在週六／週日的既有行為
（多數是「cron dow 2-6 根本不醒」＝零副作用）。**不新增判級／門檻／訊號、不改任何資料欄位與 schema**。
- **判定只有一處**：`worker/src/index.js` 的 `export async function holidayToday`（台北日期；**週末一律回 false、連行事曆都不讀**，
  週末仍交給各角色既有的 dow 守門，週末路徑逐字不變）→ `export async function holidayCalCached`（isolate 記憶化）→
  既有 `loadHolidayCal`（cf `cacheTtl: 3600`）＋`holidayClosed`。**守門放在 `scheduled` handler 本體**（`await` 後 `return`），
  各 `run*` 函式一行未改——被守門的呼叫式因此逐字保留（`test/frames.mjs` 以原始碼字串釘住它們；原本另有已隨 tick 班刪除的 `test/tickdiag.mjs`）。
- **每分鐘 frame 的成本**：兩層快取各管各的——①`cf.cacheTtl` 是 Cloudflare 邊緣對 raw 子請求的快取（命中時不回源，
  但**仍是一次子請求**；workers.dev 上對第三方 origin 的實際命中行為**未實測**）；②`holidayCalCached` 的 isolate 記憶化：
  成功後 `HOLIDAY_MEMO_OK_MS`（30 分）內**連子請求都不發**，失敗記 `HOLIDAY_MEMO_FAIL_MS`（5 分，期間 fail-open 照寫 frame、
  不會每分鐘去撞掛掉的 raw）；同分鐘多個事件並發共用 in-flight。逾時 `HOLIDAY_SCHED_TIMEOUT_MS`（5 秒，/status 仍是 20 秒）。
  **另有硬上限 `HOLIDAY_HARD_TIMEOUT_MS`（6 秒，2026-09-29 驗收退回 M1 後補）**：`holidayCalCached` 內以 `Promise.race`
  包住 `loadHolidayCal`——signal 只能中止 fetch 本身，擋不住「標頭回了但 `r.json()` 永不 resolve」或不理 signal 的 fetch；
  而 in-flight 是整個 isolate 共用、memo 只在 resolve 後寫，一旦卡住，同 isolate 之後**每一次** scheduled 都 await 同一個
  永不結束的 promise＝frame／哨兵等全停擺。逾時回 `{cal:null, err:"timeout"}`、**照寫失敗記憶**（5 分內不再撞）並清
  in-flight → fail-open 照平日跑。選 race 而非 `AbortSignal.timeout()` 的理由（原與已拆除的 tick 量測班 `tickWithTimeout` 同一套論證）：
  Cloudflare 官方文件未列該靜態方法、signal 管不到 body；代價也相同：race 不取消底層操作、卡住的 fetch 只是被放生，timer 在 finally 清。
  **timer 確實被清由 `test/holidays_timer.mjs` 守住**（2026-09-30 補 S1 漏洞）：stub 全域 `setTimeout`／`clearTimeout`，
  對快速成功／fetch 拋錯／body 永不回（觸發硬上限）三條路徑逐一斷言 race timer 全數被 `clearTimeout`；拿掉 finally 那行 `clearTimeout` 實測三條皆紅。
  所以是「每個 isolate 每 30 分至多 1 次」，不是每分鐘一次（`test/holidays2.mjs` 以連續 4 分鐘 frame 斷言只讀 1 次）。
- **fail-open**：行事曆 404／壞檔／拋錯／年度未涵蓋 → `holiday:false` → 照改動前跑（照寫 frame、照探測），log 一行
  `holiday-cal 未載入`。颱風臨時停市（行事曆事後才補）當天照舊會跑。

| 角色（入口） | 休市日行為 | 改／不改與理由 |
|---|---|---|
| `frame`（每分鐘，`storeFrame`＋`runAlerts`＋13:25–13:40 `storeFlowLast`） | **不跑**：不打 FinMind 快照、不寫 `f:`／`fi:`／`series:`／`flow:last`／`err:`、不偵測提醒 | **改**。09-25／09-28 假歸檔的上游（休市日快照＝前一交易日收盤，照寫會留整天 stale frame）；比照週末 cron 不醒 |
| `sentinel`（17:00–22:55 每 5 分，`runSentinel`） | 不探測、不 dispatch、不寫 `sentinel:<date>:*`、不告警 | **改**（比照週末：`scheduledRole` 週末本來就不回 sentinel） |
| 單體班 TW 四條＋recheck（daysummary／intraday／aetf／baseline，`runBackup`） | 不讀 KV、不抓產物、不 dispatch、不告警 | **改**（多一道；原本 `series:<date>` 守門在 frame 不寫後本來也會擋，現在連那次 KV get 都省） |
| 單體班 us＋recheck（`runBackup` us） | **照跑** | **不改**：美股日曆，台股休市與它無關 |
| `evening`（21:00–23:55，`runEvening`：pm summary→diag→mktbal→aetf2→圖卡渲染→`pushDailyCards`） | 整條不跑 | **改**（原 series 守門本來也會擋；`pushDailyCards` 另有 baseline.date 閘門，同樣不必動） |
| `health` eve（23:50，`runHealthCheck`） | 帶 `opts.marketClosed`：只留 `HEALTH_NON_TW`（us／lastweek／meta／**news**／morning）；eve 實際剩 **news**（＋週一的 lastweek／meta）；**濾完一項不剩才零副作用 return** | **改**。**news 假日照檢（使用者裁決 2026-09-29）**：news 由 Worker 每日 :07 dispatch、不看休市，假日沒落地是真故障。低頻班是週頻／月頻 GH cron、不看台股休市，丟掉會讓週一假日那週漏檢；台股日產物（flows／postmkt／summary-pm…）不告警。休市日不讀 `series` |
| `health` morn（09:30） | 同上，剩 **morning＋us**（summary-am 不檢） | **改**；morning 因 06:47 照跑而照檢（下列）；summary-am 不檢——summary.yml 進場查到休市會自己 skip，當日檔本來就不會有。假日隔天（09-29）不需特別處理——eve／morn 每一項都是「今日」產物，沒有一項以「前一交易日」為基準 |
| `summary-am` 窗的 **am summary 協調班**（`runSummaryDispatch` am） | 不 dispatch summary.yml、不讀 sumfired | **改**（週末有 dow 守門）。postmkt `build_summary.py` 進場 `is_twse_holiday` 會秒退，擋與不擋**產出相同**，擋掉只省一台空跑 runner——屬「台股盤後類本來就由自身閘門 skip」 |
| `summary-am` 窗的**晨間圖卡**（`runMorning`＝08:05–08:15 渲染 dispatch、08:20–08:50 推播） | **照跑、照推 LINE** | **不改，維持改動前**（使用者裁決 2026-09-29：**晨間產品每天出、照推**）。改動前只守週末（`runMorning` 自己的 dow 守門，週末路徑不變）；卡片各自的新鮮度守門（brief.date／morning generated_at／us 資料日）照舊決定出哪幾張 |
| `summary-am` 窗的 `runUsCatchup` | **照跑** | **不改**：美股日曆（它自己的週日／週一守門不動） |
| `morning`（06:47，`dispatchMorning`） | **照 dispatch** | **不改，維持改動前**（同一裁決：晨間產品每天出）。它是晨卡 news-morning-2/3 的上游（卡的守門要 morning.json generated_at＝今日），擋掉會讓假日晨卡缺席 |
| `news`（每日 :07） | 照跑 | **不改**：本來就含週末（新聞是日曆日） |
| `iching`（22:30／23:30） | 照跑 | **不在本批**（另一 session 負責；該 repo `daily_run` 自己判休市） |
| `alertJob` 本體 | 不變 | **不改**：它只看週末 dow；休市日會呼叫它的只剩 us／低頻班／news／iching，都不屬台股交易日類 |

測試 `node test/holidays2.mjs`（直接打 `export default` 的 `scheduled`，stub 全域 fetch＋KV＋ctx）：21 個角色×09-25／09-28（2026-10-23 拆 tick 班前為 22 個，少掉的是 `ticksample` 一列）
逐一斷言——台股角色零 FinMind／零 dispatch／零告警／零 KV；summary-am 窗只少 am summary 協調班（08:10 照 dispatch cards.yml、
08:20 照讀 manifest，且與改動前相比「差額只有 am summary」）；06:47 morning 與 us／news／iching 與改動前相同；09-29 與行事曆
404／壞檔／拋錯（fail-open）時，fetch 集合與 KV 操作集合**與改動前（`git show 94c5773:worker/src/index.js`）對跑逐項相同**；
09-26 週六 dow `*` 的角色與改動前相同且不讀行事曆；記憶化／in-flight／年度未涵蓋；**F 段硬上限**（body 永不回／fetch 永不回：
上限內 fail-open、並發一起結束、後續走失敗記憶不再卡、過 5 分重試成功；生產預設 6 秒下 scheduled frame 照寫）；
**G 段 fail-open 正向斷言**（404／拋錯／壞檔時哨兵照探測、frame 照寫（拋錯那型原由 tick 班代表，拆除後改由 frame 照抓照寫守住）、eve 健檢照舊讀 series 與台股項、am summary 照讀 sumfired）。
**⚠ CI 不跑對跑**：`worker-deploy.yml` 的 `actions/checkout` 預設 `fetch-depth: 1`，取不到 `94c5773`，對跑段落（A 段的
「與改動前相同」與整個 B 段、C 段的比對）印 WARN 略過；CI 上守住行為的是**不依賴舊版的斷言**（A 段逐角色零副作用、F、G）。
對跑只在完整 clone 的本機跑得到；本機模擬淺 clone：`HOLIDAYS2_BASE=deadbeef node test/holidays2.mjs`。

## 台指期 tick 量測班（2026-09-09～2026-10-23，已拆除）

**結案紀錄。** 建班動機：日後若要把台指期 tick 接進哨兵，需要「日盤真的收完了」的判準，而直覺判準
（`rows.length>0`、`max(time)>=13:44`）因 FinMind 檔內含夜盤段而可疑，故先以暫時班量原始分布、不下判準。
**2026-10-23 依使用者裁定拆除**（依據：已取得 4 個交易日樣本、檔案形狀在各日一致，拆除條件中的三個未知都已有答案；
2026-10-09 起本班每個平日發「拆除到期」告警）。拆除範圍：`wrangler.toml` 原第 20 條 cron `*/5 1-11 * * 2-6`
（crons 22→21 條，後兩條 iching 遞補為 20／21）、`dispatchRoleForCron` 的 `ticksample` 分流與 `scheduled` handler 的
休市日守門分支、`runTickSample`／`summarizeTickRows`／`maskTickErr`／`tickWithTimeout`／`tickSampleSlots`／
`tickAgeDays`／`tickTeardownDue`／全部 `TICK_*` 常數、`tick-teardown-due` 告警、`GET /tickdiag`、`worker/test/tickdiag.mjs`
（其中與 tick 無關的 toml 條數／cron 歸屬／全檔零 `.list(`／endpoints 不列診斷路徑等守門搬到 `worker/test/routing.mjs`）。
KV 中殘留的 `tick:<YYYYMMDD>:<HHMM>` 樣本 TTL 7 天，自然過期、不需手動清。`/livediag` 的節流（`diagThrottle`）原與
`/tickdiag` 共用，現在只剩 `/livediag` 一個使用者，行為不變。`/live` 的 `finFuturesVix` 仍照舊打 `TaiwanFuturesTick`
（那是 VIX／正逆價差卡，與本班無關）。

**實測結論（日後接哨兵要用；樣本 2026-09-14、10-16（只剩午後）、10-20、10-21，共 N=4）**：
- FinMind `TaiwanFuturesTick`(TX) **日曆日 D 的檔＝D 的 00:00–04:59（前一晚夜盤的延續；前一天沒有夜盤時就沒有，
  例如週一 09-14）＋D 的日盤 08:45–13:44:59**。D 當晚的夜盤到台北 19:55 都**沒有**被追加進 D 的檔（`seg.c` 恆 0）。
  建班時「同一個檔含三段（含當晚 15:00–24:00 夜盤）」的前提因此不成立。
- 10-20：09:00–14:55 只有 4,430 列（00:00–04:59 段，0.45MB）；15:00 起日盤整段出現（全檔 83,169 列、最晚 13:44:59、
  `d13`（13:44–14:00 列數）＝1,417、8,492,219 bytes），之後到 19:55 不再變。
  10-21：09:00–14:55 為 3,767 列（0.38MB）；15:00 起 51,340 列、最晚 13:44:59、`d13`＝1,040、5,194,096 bytes，之後不變。
  09-14（週一、無前晚夜盤）：15:05 首次出現、64,712 列、6,634,907 bytes。
- 耗時：有資料的格多為 0.5–1.5 秒，最慢 7.3 秒（09-14）；上游**從未**提供 `content-length`；20MB 尺寸閘門從未觸發。
- **判準（推論，N=4，未定案）**：`rows>0` **不可用**（09:00 起就為真，夜盤延續段造成假陽性）；
  「檔內最晚時間 ≥ 13:44」或「13:44–14:00 列數 > 0」可判日盤收完，首次為真落在 15:00–15:05；建議另加
  「15:30 前不判定」的保險。**接哨兵是另一批工作、尚未排**（本次拆除對 `SENTINEL_SIGNALS`／`signalLanded`／
  `runSentinel` 一個字都沒動）。
- 工程面留下的教訓（細節見 git 歷史 `41f6da1` 以前的本節全文）：①時間欄位名不可憑印象（首日 `TICK_TIME_KEYS`
  漏了 `date`，整天零資訊）②含 token 的 URL 會跟著 fetch 例外訊息外洩，寫進可對外讀取的地方前要遮罩
  ③`Promise.race` 逾時不取消底層操作，KV put 逾時的語意是「未知」不是「沒寫入」④暫時班要有自己會來敲門的拆除提醒。

## 晚間 LINE 圖卡：主動ETF 動作總覽（`pm-aetf-2`，2026-09-10 改版）

`FX_ACTIVE_CARDS` 由 5 張加到 **6 張**（新卡沿用 `pm-aetf-2` 的 id 與 `FX_CARD_BUILDERS` 表位
**就地改寫 `function fxCardAetf2`**，builder 庫仍 **35 張**——`worker/test/dailycards.mjs` 六處
硬編 35 全部不動）。carousel 順序落在 `pm-aetf-5` 之前（表序決定）。規格見
`docs/line-cards-spec.md` §0／§3B.2／§3C。

- **卡別＝B 類**（排行榜，spec §3B.2）：卡底標排序欄位、零形容詞。**不得掛 A 類標籤**
  ——`src/build_cards_png.py` 的 `render_ranking` 對任何 rows 卡都畫金銀銅圓章＋比例條，
  圖面天生就是排行榜。
- **維度＝ETF（一列一檔），與個股維度的 `pm-aetf-5` 零欄位重疊、並存不取代**。只列當日有加減碼的
  ETF（14 天實測 9–20/20 檔有異動），取前 `FX_ROWS_MAX`（8）。
- **排序鍵＝Σ|val|（當日加減碼金額絕對值合計），主值＝Σval（主動淨額）——兩者刻意分家**
  （使用者裁示）：用淨額排序會讓「大買 A、大賣 B」的 ETF 正負相抵而排到後面，與「今天誰動作
  最大」相反。**副作用：金色比例條比例化於主值，長度與名次不單調**（`render_ranking` 只認
  `row.r`），這是刻意接受的代價，note 已同時寫明兩者口徑。
- **`r2`＝`新/加/減/清` 四類檔數（上游 `k` 欄 `new|add|cut|exit`）＋集保口徑規模**
  （`twse_aum_yi`，缺則退 `aum`，兩者皆缺顯「—」但**該列保留**——規模不是排序鍵）。
- **卡底 `foot` 揭露涵蓋率**（誠實原則，須消費 `aetfLatest`，它早在 `cardSourceUrls` pm 分支、
  原本無人消費）：「納入 N 檔主動ETF，另 M 檔當日無揭露資料；其中 X 檔有加減碼，列出前 Y；
  Z 筆個股金額缺值，已以 0 計」。`aetfLatest` 缺時只少「無揭露」那句、卡照發。
  **`val` 為 null 一律以 0 計並在卡底報筆數，不得靜默**（今日實測 97 筆中 7 筆為 null）。
- **兩個口徑差異已揭露在 note（2026-09-11 覆驗退回補上，鐵律 4）**：
  ①**`r2` 四類計數與 `r` 主值不同口徑**——`k` 由上游**依原始股數 `sh1` vs `sh0`** 分類
  （`src/build_aetf_diff.py` 的 `# 持股型態分類` 段，註解明寫「與主動純額無關」），`r` 是主動
  口徑，申贖日兩者系統性打架（15 天 273 個 ETF-day 中 13 個 `ratio`≠1；實例 `2026/08/04
  00991A` `ratio=1.0618` → 卡面會是「−8.9 億」配「新0/加19/減8/清0」，**看起來像 bug**）。
  上游只有 `n_buy`／`n_sell` 是主動口徑、**四分類只有 `k` 有**，故用 `k` 是必要取捨。
  ②**「排除申贖」是估算**——`ratio` 走 `_units_ratio`，FinMind 無總單位數（實查
  `data/aetf/latest.json` 各檔 `units` 皆 `null`），一律落到「各持股今/昨股數比中位數」。
  note 因此寫「以**估算**申贖比扣除等比效應」，不寫「已排除」。
- **比例條與名次不同軸，note 必須點明**：`render_ranking` 的金色條長度比例化於 `row.r`
  （主值＝淨額），名次卻來自 Σ|val|，所以條長與名次不單調（2026-09-10 實資料：第 3 名
  `00405A −3.5億` 的條明顯短於第 4 名 `00406A +6.8億`，而第 3 名還戴銅牌）。
  **全卡唯一沒被文字說明的視覺元素恰好就是會誤導的那個**，故 note 加「長條長度比例化於
  右側數值、與名次不同軸」。**`build_cards_png.py` 仍是零改動的硬約束，排序鍵亦不變。**
- **規模欄兩種來源要分開標**：`twse_aum_yi` 是集保口徑；缺值時退的 `aum` 是「當日成分股
  market_value 加總（元，**僅供估算**）」（`src/build_aetf.py` 檔頭），**不是集保口徑**。
  15 天樣本 4/209 個 ETF-day（1.9%）會走回退，note 已寫「缺值時退成分股市值加總（估算）」。
- **刻意不放**（鐵律 8）：跨 ETF 共識（「N 檔同買/同賣」，與已封鎖的 `flows-sync-1` 同型且零回測，
  屬 C 類）、`est_flow` 申贖估算（推估值，14 天實測每天僅 0–4 檔非零）、含申贖背離 judgement、
  任何形容詞（「最積極」「動作強度」——`FX_FORBIDDEN` 的 **19 個字串**（2026-09-11 實查，原寫 15 是錯的）**擋不住**這類，要自己守）。
- **aetf 三張卡（`pm-aetf-2/4/5`）同批補 per-card 新鮮度守門 `fxAetfStale`**（grep 該宣告字串）：
  比對 `aetfDiff.primary_date`（上游寫 `YYYY/MM/DD`，正規化成 `YYYY-MM-DD`）與資料日
  `baseline.date`，不符或**無可信資料日**一律 skip。原本三張卡只靠 `pushDailyCards` 的全域
  `baseline.date` 閘門，aetf 管線單獨失敗時卡會帶舊 `primary_date` 照出（無聲降級）。
  **代價**：缺 `baseline` 時三張卡也 skip（同 `fxCardSummaryLongform` 的保守立場），
  `dailycards.mjs` 的 DEP `baseline` 條目已同步。資料正常時 `pm-aetf-4/5` 輸出**逐字不變**
  （以 `03841a1` 的 `data/aetf/diff.json`＋`latest.json`＋`baseline.date=2026-09-10`，
  即 pm 窗當下的真實快照，對跑改動前後實測 IDENTICAL）。
- **`primary_date` 口徑 2026-09-14 由 `max()` 改眾數（平手取大），使用者裁示 A1-2**
  （`src/build_aetf_diff.py` grep `def pick_primary`，測試 `tests/test_aetf_primary.py`）：
  `max` 的前提是「沒有任何檔會超前多數」，該前提**已不成立**——FinMind 對
  `00400A`／`00407A`／`00987A`／`00996A` 四檔的日期標記系統性快一天：**以 2026-08-26
  ~09-11 這 14 個交易日實查 `data/aetf/2*.json` 的 `etfs[].src_date`，9 天呈 16/4 分裂、
  5 天全檔同日**。**成因不是補位**——`docs/handoff-aetf-20260816.md:55` 記的「投信端補位
  造成超前」已過期：這 14 個檔**連 `fallback_used` 這個鍵都不存在**（該鍵只在補位成功時
  由 `src/build_aetf.py` 寫入，最後一次出現是 `data/aetf/2026-08-17.json`），超前四檔
  **沒有被補位覆蓋過**（無 per-ETF `source: "issuer:*"`；檔案頂層那個 `source: "finmind"`
  是全檔欄位、不是逐檔欄位，**別把它讀成四檔各自的來源**）。
  眾數之下那 9 天的 `laggards` 由 **16 筆降為 4 筆**、`primary_date` 退回多數那一日，
  5 個全檔同日的場次輸出**逐字不變**（14 天對跑實測）。
  **視窗要寫明，而且「當日」那一格會在當天之內變**：上面的「5 天全檔同日」依的是
  **不含當日**的視窗。2026-09-14 當天實測——**同一個 `data/aetf/2026-09-14.json`
  在 10:37Z 那班是 18/2 分裂**（`00984A`／`00993A` 停在 09-11，方向為 `behind`），
  **到 13:47Z 那班已補齊成 20/20**（`git show efb1d41:` 與 `1b4cf13:` 對照）。
  所以「某日是幾比幾」不是該日的固定屬性，而是**你在哪一班看它**；分裂日數、方向
  （`ahead`／`behind` 都可能）與全檔同日的天數都會隨視窗與時點變動，
  **不要把任何一組計數當成常數引用**。
  **`laggards` 每筆新增 `dir`（`ahead`／`behind`）**——眾數之下兩種都可能，把超前的檔
  叫「落後」是語意錯誤；`etf`／`src_date` 不動，下游無人消費 `laggards`（grep 只命中
  本檔與文件）。`fxAetfStale` **一字未改**，仍是嚴格相等。
  **行為變化有兩處（2026-09-14 覆驗退回後更正——原本只寫一處、並宣稱「LINE 推播內容
  零變動」，那是把 pm 窗的結論當成全域結論，錯的）**：
  ①**晚間 `/cards/data`**：台北午夜後那段 `primary_date` 不再跑到隔日，故該時段三張
  aetf 卡由「缺席」變成「照出」。**晚間 LINE 推播確實零變動**——渲染（22:12）與推播
  （22:30）窗內 max 與眾數本來就相等（實算 `1541992`／`03841a1`／`bc6e808`／`f3a1fa3`
  等 pm 窗快照皆 20 檔同 `src_date`；分岔只出現在約台北 01:45 那一班）。
  ②**晨間 LINE 推播內容會變（這條原本漏了）**：`diff.json` 的 `stocks`／`subs` 只由
  `d1 == primary` 的 ETF 組成，改口徑後那 9 個分裂日的聚合成員**由 4 檔變 16 檔**，
  於是 `src/build_morning.py:192-205` 產出的「多檔同買／多檔同賣／次產業最大加碼／
  次產業最大減碼」四行內容整組改變（`:209-210` 的 `dual` 亦然），寫進
  `data/morning.json` 的 `chips.aetf`／`chips.aetf_date`，再由 worker
  `fxCardMorning2`（grep 該宣告字串）當 `paras` 印上「籌碼備忘」卡、經
  `pushMorningCards` 推播。時序上必然踩中：`morning.yml` 是台北 06:00（實際約 07:10），
  在 01:45 那班之後。實據：`e97eacd` 的 `data/morning.json` 為
  `["多檔同賣：台達電", "次產業最大加碼：加油站 1.4億", "次產業最大減碼：伺服器 4.8億"]`、
  `aetf_date="2026/09/11"`，那是**只用 4 檔**算出來的。
  **方向上這是改善**（16 檔共識比 4 檔有代表性，`co_buy` 的「≥2 檔同買」在 4 檔池裡本來
  就近乎不可能成立），但它是**使用者每天看得到的推播文字變更**，不是零變動。
- **（改口徑前的原始紀錄，保留供對照）`primary_date` 會在台北午夜後跑到隔日（實測，
  這條會影響非 pm 窗的 `/cards/data`）**：
  它取各 ETF 揭露日的領先值，主動 ETF 一旦有人先公告隔日持股就會前進。2026-09-11 01:42
  的 aetf 班實測 `primary_date=2026/09/11`、`laggards=16`——前進的是 **4 檔**
  （`00400A`／`00407A`／`00987A`／`00996A`，`latest.json` 的 `src_date` 皆 `2026-09-11`；
  20−16＝4，**2026-09-11 覆驗更正原本誤寫的「只有 `00400A`」**），而
  `baseline.date` 仍是 `2026-09-10`（當日 baseline 要到當晚才寫）。**此時 gate 判不符 → 三張
  aetf 卡從 `/cards/data` 缺席**，直到當晚 baseline 追上。
  **生產不受影響**：`baseline.date` 每日在 **12:07 UTC＝台北 20:07** 翻成當日（`data/baseline.json`
  近 8 次 commit 實查：09-07/08/09/10 皆為 12:07Z 首次寫入當日、17:xxZ 為冪等重跑），而
  `primary_date` 約在台北午夜後翻——**實測 9 次「翻成隔日」的 commit 落在 17:44Z–20:57Z
  ＝台北 01:44–04:57**（`git log` 逐版解 `primary_date`；另有一族 10:37–10:38Z＝台北 18:37
  的翻動，那是主班翻成**當日**、非隔日，週一等隔了非交易日的日子才出現），
  故**兩者相等的窗約為台北 20:07 至隔日 01:44–04:57**，
  渲染（`cards.yml` 台北 22:12）與推播（22:30）都落在窗內；提案 14 天逐日快照＋
  2026-09-10 22:56 實測亦皆相等。**非該窗時段打 `/cards/data` 看不到這三張卡是預期行為。**
  gate 刻意用**嚴格相等**而非 `>=`（`usFresh` 那條用 `>=` 是因為 us 的 date 不可能超前）：
  超前時 `laggards` 通常很大（今日 16/20），放行等於把「只剩 1 檔 ETF 的聚合」當成當日全貌，
  且會讓 aetf 卡的資料日與同一組 carousel 其餘卡不同天。
- 測試：`node test/dailycards.mjs`（3b／3c 兩節）。**`src/build_cards_png.py` 零改動**。
- **pm 窗線上覆驗（2026-09-11 台北 22:3x，實作當時唯一驗不到的一項）**：`GET /cards/data` 回
  7 張（`FX_ACTIVE_CARDS` 6 張＋長文卡 `pm-summary-1`），`pm-aetf-2` 在列、資料日 `2026/09/11`。
  fresh-context 驗收者依 `function fxCardAetf2` 的實際路徑用 raw `diff.json`／`latest.json` 重算，
  **8 列的 `l`／`m`／`r`／`r2` 與 `foot` 四個數字逐格復現**；主對話另行獨立重算 `r` 與排序鍵，結果相同。
  排序鍵實證：**00991A 主動淨額 −2.1 億排第 1、00406A +23.8 億排第 2**，因 Σ|val| 為 38.36 vs 23.84
  ——**負淨額排在正淨額之前**正是 Σ|val| 生效的直接證據。`foot` 的「9 筆金額缺值」實測為
  00404A 6 筆（`zh` 為 null）＋00406A 3 筆（臺指選擇權無收盤價）。規模欄 8 列**全走 `twse_aum_yi`**、
  零回退。gate 證據：`primary_date`＝`baseline.date`＝`2026-09-11`、`laggards` 空。
- **算 ETF 維度聚合時不可走 `subs[].detail[]`（2026-09-11 踩到）**：`subs` 是**次產業多對多**聚合，
  `src/build_aetf_diff.py` 的 `for sub in {p[1] for p in info.get("p", [])}` 會把同一檔股票依其所屬
  次產業數**重複 append**，依 `etf` 直接彙總會重複計算（實測 00991A Σval 由 −2.07 億膨脹成 −95 億，
  名次也全亂）。**ETF 維度的唯一正確路徑是 `etfs[<code>].buy` ＋ `.sell`**——`k` 四類分類也只在那裡，
  `subs[].detail[]` 沒有 `k`，且它 `if r["val"] is not None` 把 null 濾掉了（所以在 subs 上數 null 會得 0）。
- **`foot` 的「另 M 檔當日無揭露資料」措辭偏寬（已知、未修）**：M 取
  `Object.keys(aetfLatest.errors).length`，但 `errors` 的成因不只「當日無揭露」——2026-09-11 的 4 檔中
  3 檔是「Holding **近 14 日**無資料」、`00998A` 是「過濾後無台股持股」。**數字與方向（未納入）誠實**，
  只是歸因用語不夠精確；要修需動 Worker 並重新部署，未併入本批。

## 晨間 LINE 圖卡（AM slot，2026-08-10）

晚間圖卡管線（cards.yml → `src/build_cards_png.py` → pushDailyCards）的晨間平行場，
**晚間路徑零改動**（FX_ACTIVE_CARDS／pushDailyCards 的 gate/時窗/dedup 全不動）：

- **卡片**（白名單 `export const FX_AM_CARDS`，共 4 張）：晨報長文卡 `am-brief-1`
  （`export function fxCardMorningBrief`，資料源＝taiwan-stock-news 的
  `daily-brief-card.json`，台北 07:30 前後產出；**刻意不進 FX_CARD_BUILDERS**，
  避免污染晚間 skipped 觀測）＋昨日市場三卡 `news-morning-2/3/4`
  （休眠 builder 重新啟用，源＝morning.json／daysummary／us）。
- **時窗**（掛在 summary-am 三條 cron 的同一處喚醒）：台北 08:05–08:15 dispatch
  `cards.yml`（inputs.slot=am，冪等 KV `bkfired:<date>:cardsrender-am`；此窗實際只有
  08:10 一輪，失敗由 GH 兜底 cron UTC 00:40 接手）→ 08:20–08:50
  `export async function pushMorningCards`（dedup `alerted:<date>:cards-am`、
  manifest.date=台北今日且 ≥1 圖才推；晨間**無**純文字退路）。
- **輸出目錄**：`data/cards/am/`（`build_cards_png.py --slot am`；與晚間 `latest/`
  分目錄，開場清 *.png 互不誤刪）。渲染取卡走 `/cards/data?slot=am`
  （cf cache key 已把 slot 併進 path，am/pm 不互染）。
- **新鮮度守門**在 `export async function buildCardsData`（slot=am）：晨報卡＝
  brief.date 為台北今日；morning2/3＝morning.json 的 generated_at 台北日為今日
  （**不是**晚間的 baseline gate——早上 baseline 必為昨日）；美股速覽卡 news-morning-4
  （2026-08-13 起 per-card gate）＝us.json 的 date 達最近預期美股交易日，不再被
  morning generated_at 連坐（美國國定假日該卡當天缺席，屬可接受行為）。
  全不新鮮 → 空卡＋date=null → Python 拒渲染。
- **晨報卡的分句／截斷層**（2026-08-29 後補，起因：當日 `quote` 實際 673 字糊成一整塊）：
  `export function fxSplitQuote` 依全形句讀（。；！？）切句成段（前後兩句皆 ≤ `FX_QUOTE_SHORT`
  才併同段避免過碎）；總長超過 `export const FX_QUOTE_MAX`（360 字）即**截到最近句尾**並在
  末段補「（全文見網頁版晨報）」，連第一句就超標則硬截加「…」。非字串／空值回空陣列＝該段
  缺席、不整卡失敗。`export function fxCardMorningBrief` 以它渲染 `j.quote`。
- **跨 repo 契約（`daily-brief-card.json` 的 `quote`）**：上游 taiwan-stock-news 的產製規範
  2026-08-30 起收緊為 **≤120 字、至多 3 句、單行純文字**（見該 repo CLAUDE.md「每日晨報產製
  規範」第 4 條）。**上游守門現況（2026-09-06 更新，隨同批 PR 合併後生效）**：該 repo 已加 `tests/test_daily_brief.py`
  （驗 quote ≤120 字／≤3 句／單行、正文 ≤5,000 漢字、存檔 7 期、postMessage 契約），且 `test.yml`
  paths 已納入 `daily-brief-card.json`，產製 session push 後 CI 會跑——但那是**事後告警**
  （紅了才知道，檔案已在 main 上），不是寫入前的閘門。因此**本站的 `FX_QUOTE_MAX`=360
  仍是渲染端實際生效的防線，不可因「上游已有測試」而拿掉**。
- 測試：`node test/morningcards.mjs`（含 `fxSplitQuote` 的分句與截斷案例）。

## /status 全系統資料健康端點（2026-08-11；2026-09-07 改六站＋時間感知判級；2026-09-26 加第七站 iching）

`GET /status` 回**七站**（live／flows／news／brief／postmkt／backtest／iching）的 `data_date`／
`updated_at`／紅黃綠 `level`（`export async function buildStatus`，cf 快取 5 分）。
**schema 形狀與欄位名不動**（`schema:1`，入口站 shihpc.github.io 與 claude-harness
`tools/freshness_watchdog.py` 共用這個資料面）；新站一律**附加在既有六站之後**，不改順序
（2026-09-26 iching 即附加在 backtest 之後，`test/status.mjs` 以改動前的六站 JSON 逐位釘住前六站輸出）。
判級全是可測純函式、台北時區；單站失敗只染紅該站、不垮端點
（`Promise.allSettled`）。測試 `node test/status.mjs`＋`node test/holidays.mjs`。

**國定假日（2026-09-28 起處理，批次一，規格 `docs/holiday-calendar.md`）**：取代舊的「國定假日不處理」。
`buildStatus` 與七站**併發**讀本 repo `data/twse_holidays.json`（`export const HOLIDAYS_URL`，raw main，
`export async function loadHolidayCal`，cf 快取 1 小時），`export function parseHolidayCal` 轉成
`{closed:Set, years:Set}`，再當**選填最末參數** `cal` 傳給 `lastExpectedTradingDate`／`prevExpectedTradingDate`／
`gradeMarket`／`gradeBacktest`／`statusSiteLive`。休市日＝週末 ∪ `closed`；**某年不在 `years`＝該年未知 → 只排週末**
（`export function holidayClosed` 先查年度再查日期）。平日假日比照週末：預期資料日直接退到前一交易日（不看 dueHour）；
週末退到的週五若是假日再往前跳；backtest 參考日為假日時比照週末分支。**live 站也接 cal**——否則 09-28 這種假日
會去查 `fi:09-28`／`fi:09-25` 兩個必然空的鍵而判 red。news（時數口徑）與 brief（日曆日、每日出刊）不受影響。
- **fail-open**：讀不到／非 2xx／壞 JSON／形狀不合（`schema≠1`、缺陣列、無合法年度）→ `cal=null`＝與改動前逐字相同的
  「只排週末」，**不拋例外、不染紅任何站**（`holidays.mjs` 以 404／拋錯／壞檔三種對跑）。`data/twse_holidays.json`
  由 `holidays.yml` 上線後產生，**在它第一次 commit 到 main 之前本端點一律走 fail-open**。
- **預設參數＝舊行為**：`cal` 省略／`null`／空集合時，`holidays.mjs` 以改動前原始碼的逐字副本對跑 21 天×48 時點×
  7 個資料日偏移×5 個 dueHour 的網格，差異 0；`status.mjs` 一字未改全過。
- **回應形狀一個鍵都不加**：`status.mjs` 釘住頂層鍵恰為 `schema/generated_at/status/sites`，所以載入狀態不進 JSON，
  改由 `buildStatus` 的選填第五參數 `meta`（出參）帶出，`/status` 路由寫成回應標頭
  **`x-holidays`**（`loaded; years=2026` 或 `unloaded; HTTP 404`），未載入時另 `console.log` 一行（`wrangler tail` 看得到）。
- **仍會誤報的情形**：颱風臨時停市（TWSE 事後才補進行事曆）；跨年後到第一個週日 `holidays.yml` 跑完前，新年度不在
  `years` 內（依契約退回只排週末，元旦前後可能誤報一次）。
- **批次一只改 `/status` 路徑**；排程角色與前端的休市處理是**批次二（2026-09-29）**，見「休市日（國定假日）各排程角色」節
  與「頂列」節。排程角色走 `holidayToday`（isolate 記憶化），**不**傳 `cal` 給上述判級函式，`/status` 的行為不受批次二影響。

**來源**：live 讀本站 KV `fi:<date>` frame 索引；flows 抓 `taiwan-flows/data/status.json`
（小檔；**`data_date` 取 `actual_date`＝實際落地的最新交易日，缺才退回 `date`**——`date` 是「預期交易日」，
缺料日會是一個沒有資料的日子，2026-09-25 國定假日入口站因此顯示成 09/25，2026-09-28 改；非 ok 且 `expected_date`≠`data_date` 時 note 附「（預期 <expected_date>）」。**燈號因此會變**：缺料日由
「假綠」（舊版拿預期日比 `>=`）轉為落後一格的 yellow，刻意的修正；**行事曆載入後**，假日本身不再算一格（09-25 假日 → 09-26 看 09-24 為 green），行事曆 fail-open 時仍是舊的落後一格 yellow）；news／brief 抓 `taiwan-stock-news` 的 `news.json`／`daily-brief-card.json`；
postmkt 因 `postmkt.json` 逾 1.6MB，以 **Range 只取檔頭**（`bytes=0-N`）regex 撈
date/generated_at；backtest 抓 `taiwan-backtest/walkforward/ledger.csv`，**是 CSV 不是 JSON
且逐日追加會一直長**，以 **Range 只取檔尾**（後綴範圍 `bytes=-4096`，`async function
fetchStatusTail`；2026-09-07 curl 實測 raw.githubusercontent.com 回 206＋
`content-range: bytes 55-174/175`，確認支援後綴範圍）再由 `export function extractTailDate`
由後往前取第一列 `YYYY-MM-DD,`。CDN 若忽略 Range 回 200 全檔，兩支都有串流回退、不整包載入。
iching 抓 `taiwan-stock-iching/data/web/latest.json`（`ICHING_STATUS_URL`，約 1.36MB，2026-09-26 實查
1,357,182 bytes），同 postmkt 手法 **Range 只取檔頭**再 `extractHeadFields` 撈 `date`（sort_keys 後在前 70 bytes）；
**該檔沒有 `generated_at`**（檔頭實查：`calibrated`／`data_version`／`date`／`generated_from`／`market`…），
故 `updated_at` 固定 `null`——不拿 `generated_from` 之類的欄位臆造（同 backtest 立場）。

**時間感知判級（2026-09-07）**：舊 `gradeMarket` 不看時間、平日一律期待「今日」資料，但各站
盤後管線是晚上才跑——**postmkt 每個平日從 00:00 到當晚產出為止都是 yellow（約 21/24 小時）**，
那顆燈沒有資訊量（2026-09-07 18:12 線上實測：`/status` 報 postmkt `data_date=2026-09-04`
`level=yellow`，postmkt 站自己的頂列同時顯示「正常」；同日 22:03 自然轉綠）。修法＝
`export const STATUS_DUE_HOUR` 給每站一個「預期發布時點」，
`export function lastExpectedTradingDate(tp, dueHour)` 在平日未到該時點時把預期資料日退成
前一個交易日，`export function gradeMarket(dataDate, tp, dueHour)` 據此判級。
**只有 `level` 會從假黃轉綠，`data_date`／`updated_at` 語意一律不動**；階梯只是整段前移一格，
落後 1 格仍 yellow、2 格仍 red（`dueHour` 省略＝舊行為，保留給回歸比對）。四個時點
**取各站現行判準的同一個值，不另創口徑**：

| 站 | dueHour | 出處（實查） |
|----|---------|------|
| live | 9 | 本站 `index.html` 的 `function liveStatus`：`if(hm<"09:00")` 的**牆鐘**分水嶺（**不是** `liveDataDate` 的 `ts>="09:00"`，那個比的是成交時戳；2026-09-07 驗收更正） |
| flows | 20 | `taiwan-flows/index.html` 的 `function lastDueTradingDay`（平日 `hour>=20` 才期待今日），同後端 `src/run_daily.py` 的 `PUBLISH_DEADLINE_HOUR = 20` |
| postmkt | 22.5 | `postmkt/index.html` 的 `function pmStatus`：資料日為上一交易日且 `hm < "22:30"` 仍判「正常」 |
| brief | 8 | `claude-harness/tools/freshness_watchdog.py` 的 `DAILY_CUTOFF = time(8, 0)`＋`daily_target()`／`judge_brief()`（「08:00 後 date 應＝今日；08:00 前應＝昨日」）。**2026-09-08 補上**，見下段 |
| iching | 23.75 | **2026-09-26 使用者裁定 23:45**。該站前端**沒有**新鮮度判級可對齊，依據改取**實際 commit 時刻**：主班由本 Worker 台北 22:30 dispatch（`ICHING_CRON`），實測 commit 落在台北 22:32～22:59；補叫班 23:30 → 實測 23:34 落地；再加 raw CDN `max-age=300` ＋本端點 cf 快取 5 分，最壞約 23:44 才看得到 → 取 23.75 使「補叫班才成功」的日子也無假黃。**不得 ≥24**（`dueReached` 永不成立、那站永遠期待前一交易日、真缺料判不出來；`test/status.mjs` 有 `< 24` 斷言）。走 `gradeMarket` 的**交易日**階梯（每日班 cron 只排週一～五）；國定假日自 2026-09-28 起由行事曆排除（fail-open 時退回只排週末、隔晚誤報一次 yellow）。**2026-09-30 加早晨補叫班（`ICHING_AM_CRON`，台北 07:10 週二～六）後此值不動**：正常日仍晚上落地，早晨班只縮短「23:30 仍 waiting」那種日子的續算延遲（隔日 22:30 → 隔晨 07:10），預期資料日口徑不變 |

`gradeNews` 不受影響（本來就看 `generated_at` 距今時數）。

**brief 也有假黃，2026-09-08 已修（更正 09-07 那批寫的「news／brief 不受影響」——那句對 brief
是錯的）**：晨報由雲端排程 session 台北 **07:30** 產製，但舊 `gradeBrief` 平日一律期待「今日」，
於是每天 **00:00~07:30 必然 yellow**（線上實打：台北 2026-09-09 00:29 打 `/status` 得 brief
`data_date=2026-09-08`、`level=yellow`），與 postmkt 那顆同型、同樣沒有資訊量。修法沿用同一套
機制：`STATUS_DUE_HOUR.brief = 8`，`export function gradeBrief(dataDate, tp, dueHour)` 與
`gradeMarket` 共用 `dueReached()`（時點判斷）與同一個階梯（達預期日 green／落後 1 格 yellow／
更舊 red），**只有「往前一格」不同**——brief 走日曆日 `export function lastExpectedDailyDate`，
市場類走交易日 `lastExpectedTradingDate`。`data_date`／`updated_at` 語意與 `schema` 形狀不動。

**brief 是「每日」不是「交易日」（實證，連帶更正舊的週末分支）**：舊 `gradeBrief` 的週末分支讓
週末最多只能 yellow，預設週末不出刊——**與實證不符**。實查 `shihpc/taiwan-stock-news` 的
`daily-brief-card.json` commit 歷史（2026-08-11 第 5 期 ~ 2026-09-08 第 33 期，**29 期期號連號
無缺，含每一個週六與週日**，commit 時間多落在台北隔日 07:00~08:10 之間、**不是固定的
07:5x~08:0x**——29 期中 **10 期在台北 08:00 之後才落地**（兩端＝第 12 期 06:47、第 18 期 08:10），
意味 `dueHour=8` 之下那些日子在 08:00 到實際落地之間會有數分鐘的**真黃**（非假黃，屬正確判級）），
晨報每個日曆日都出刊。
`claude-harness/tools/freshness_watchdog.py` 的 `judge_brief` 早就是不分平日週末的日曆日口徑
（`tests/test_freshness_watchdog.py` 有「週日 09:00 拿到週六版＝OK、拿到週五版＝STALE」的案例）。
故本次把週末分支拿掉、週末與平日同一把尺。**這一項會讓「週日 08:00 後還停在週五版」由 yellow
變 red（新舊對跑：週末 288 組 yellow→red）——那是原本過度寬待的修正，不是本次階梯前移造成的**；
平日側則零新增 red（下段）。**那 288 組全部是「週六與週日兩期皆缺」**（2026-09-08 對跑逐組核對：
`tp.dow` 全為週日、資料日全為週五＝偏移 −2、時鐘全在 08:00 之後）——**只缺一期不會變紅**
（只缺一期＝落後 1 個日曆日，08:00 前 green／08:00 後 yellow，不會到 red）。

**新舊對跑（2026-09-08，臨時腳本、不進 repo）**：網格＝61 天 × 24 小時 × {00,30} 分 × 資料日
偏移 −4..+1 共 17,568 組。**平日（假黃修正的正題）**：`yellow→green` 688 組（00:00~07:30 停在
昨日，正是要修的假黃）、`red→yellow` 688 組（階梯整段前移一格的必然結果，同 09-07 那批）、
**零新增 red**。**週末**：`yellow→green` **2,016**（＝`h<8` 的 864 ＋ `h≥8` 的 1,152；
**2026-09-08 更正**，原寫的 1,152 只算到 `h≥8` 那個子集）、`red→yellow` 144、`yellow→red` 288
（上段的週末口徑更正，全部是週六週日兩期皆缺）。另有 `red→green` 2,064 組全部落在「資料日在未來」
（off=+1，逐組核對確認偏移只有 +1）——舊版用 `===` 比對、新版比照 `gradeMarket` 用 `>=`，
該情境現實不會發生。網格的平日／週末組成＝43 個平日＋18 個週末日（上列各分類的絕對值依此組成）。

**同一判準有兩份實作**（本檔 `gradeBrief`、`claude-harness/tools/freshness_watchdog.py` 的
`judge_brief`＋`DAILY_CUTOFF`），**改一處要改兩處**；`taiwan-stock-news` 前端**沒有**晨報新鮮度
判級（2026-09-08 grep 實查：`index.html` 無頂列狀態／紅黃綠，「每日晨報」tab 只是 iframe 載
`daily-brief.html`），入口站 `shihpc.github.io` 只消費 `/status` 的 `level`、不自行判級。

**backtest 判級**（`export function gradeBacktest`＋`export function backtestRefClock`）：該站
每交易日兩班（台北 21:07 主班／23:07 兜底，見 `taiwan-backtest/.github/workflows/walkforward.yml`，
GitHub cron 延遲實測 2026-09-08 重算後為中位數 2h01m／p90 4h44m／最大 12h23m，四支 workflow
187 筆——**取代 09-07 那組「120 筆／中位數 3h02m／最大 9h45m」，那組整組是錯的**，樣本漏抽本 repo
的 `daysummary.yml`），所以不能用 dueHour 那套。**逐項對齊該站前端
`taiwan-backtest/index.html` 的 `function ledgerStatus`**：先把台北時鐘回推 12 小時得參考班次日
（同 `walkforward_daily.py` 的 `target=(now-12h)`），再看參考時鐘 —— `<09:07`（台北 21:07 前）
班次尚未排定＝green、`09:07~19:07`（台北 21:07~隔日 07:07）等待窗＝yellow、`>=19:07` 兩班加
緩衝均過＝red；落後一個交易日以上一律 red，週末看參考日的上一個平日。帳冊無產出時刻欄位，
`updated_at` 固定 `null`（不臆造）。
**紅線 19:07＝主班 +10 小時（2026-09-07 使用者裁定，原 13:07＝主班+4h）**：**門檻值不變，但依據的
統計數字已於 2026-09-08 重算更正**——09-07 寫的「120 筆／中位數 3h02m／p90 6h09m／最大 9h45m／
>4h 佔 26.7%／>10h 為 0 筆」**整組是錯的**（樣本漏抽本 repo 的 `daysummary.yml`，那是家族內最早的
slot）。更正後：四支 workflow（`taiwan-flows/daily.yml`／`postmkt/build.yml`／本 repo `daysummary.yml`／
`taiwan-stock-news/build-news.yml`）2026-06-16~09-07 共 **187 筆** `event:schedule` run，中位數 2h01m／
p90 4h44m／最大 **12h23m**；>4h 12.8%、>10h **2 筆(1.1%)**、>14h 0 筆。**結構性事實**：GitHub 的延遲是
**絕對排空時刻**、不是相對 slot 的固定倍數（08-27／28 塞車時四支的 `created_at` 黏在同一段絕對時刻），
同一次事故下 slot 愈早量到的「延遲」愈大，**「>10h 幾筆」取決於抽了哪些 workflow**——這正是上一輪
出錯的機制。`taiwan-backtest/walkforward.yml` 自身只有 **4 筆**（09-03 才建檔），**N=4 無法自證尾端**。
因此紅線的理由**不是**「>10h 從沒發生過」（該宣稱已被推翻），而是：三支 13:xx 班對 13:07Z 計延遲的
**代理推估**（N=151，**推測、非直接觀測**）誤報率約 2%（3 筆全落在 08-27／28 單一次事故——該事故
>+8h 共 6 筆、區間 9h51m~10h07m，其中超過 10h 的就是這 3 筆＝10h00m~10h07m，只超線幾分鐘、
正好騎在線上），換取距硬期限 **4h53m** 的補救餘裕；對照 +4h 代理誤報 16.6%、+8h 4.0%、
+12h 0% 但餘裕只剩 2h53m。上限受 `walkforward_daily.py` 硬期限 `target=(now−12h)`（主班 +14h53m）約束。
**取樣限制**：GitHub 只保留 90 天 run 紀錄，尾端只看得到 08-27／28 這一次事故，「最大＝X」是這次事故
的函數而非平台上界；家族內尚有約 10 支帶 cron 的 workflow 未抽，「>10h 2 筆」是下界不是全集。
**同一門檻有三份實作**（本檔 `gradeBacktest`、該站 `ledgerStatus`、
`claude-harness/tools/freshness_watchdog.py` 的 `BACKTEST_MISSING_FROM`），**改一處要改三處**。

**入口站已接上（2026-09-07，commit `be4877a`）**：shihpc.github.io 的「策略回測」卡已在 `PROJECTS`
那筆補上 `statusId:"backtest"`（見該 repo CLAUDE.md「五張卡」表），Hub 上會顯示這顆點。
本站 `/status` 的 backtest 站即為它的資料來源。

**第七站 iching（2026-09-26，入口站接入第一步）**：`buildStatus` 的 `defs` 末尾附加
`{ id:"iching", name:"股市易經", grade:"market", due:STATUS_DUE_HOUR.iching }`，來源與 dueHour 見上文。
**iching 刻意不納入 claude-harness `freshness_watchdog.py`**（使用者 2026-09-26 裁定），所以與 postmkt／
brief 不同，這個 dueHour **只有本檔一份實作**、沒有「改一處要改兩處」的對應項；看門狗那邊也不會為 iching
補位（本 Worker 掛掉時 iching 的燈沒有第二雙眼睛）。入口站 `shihpc.github.io` 的卡片 `statusId:"iching"`
屬下一步、另案處理；本站 `/status` 已先回 7 站（2026-09-26 現況：`data_date=2026-09-24`，週六看週五 09-25
→ 落後 1 格 yellow 是真實狀態，不是假黃）。

## 資料是姊妹站上游（跨站變更）

`taiwan-stock-news` 讀 `data/morning.json`；`postmkt` 讀 `data/aetf/latest.json`（含
`stocks[code][3]` 市值欄）。**改輸出格式屬跨站變更**
（見 `PROJECT_SUMMARY.md`「五、目前待辦與已知限制」）。
**`data/twse_holidays.json`（2026-09-28）是家族共用休市行事曆的唯一來源**（契約見 `docs/holiday-calendar.md` §1）：
本 repo Worker `/status`、taiwan-flows、claude-harness 看門狗以 raw URL 讀它；`schema`／`years`／`closed` 改形狀＝跨站變更。

**aetf 入池口徑 2026-08-29 放寬**（`src/build_aetf.py:54` `list_active_etfs`，commit `5d046c0`）：
由「`category=='domestic'` 且 `type=='twse'` 且 A 結尾」改為「**A 結尾且 `category != 'foreign'`**」
——上櫃台股型（00411A／00998A）在 FinMind Info 的 `category` 是空字串，舊條件會漏。規則式動態
取檔、不寫死檔數（`FALLBACK_ETFS` 是當日符合條件的 24 檔快照，僅 Info 失敗時備援）。
**副作用（未直接觀測，依 commit `5d046c0` 記載）**：上櫃檔在 TWSE ETFortune 無頁面 →
`grab_twse_aum`（`:107`）回 `None` → `twse_aum_yi` 為 `null`，postmkt 前端規模欄顯「—」
（既有降級路徑，**無替代 AUM 來源**）。**2026-09-06 覆驗時無樣本可驗**——當時快照
（`generated_at` 2026-09-05T01:36）20 檔落地的 `twse_aum_yi` 全非 null，兩檔上櫃
`00411A`／`00998A` 都卡在更前面的 `grab_holding`、落在 `errors`，根本沒走到 AUM 那一步。
非台股型若混入，`grab_holding` 因無台股持股會落 `errors` 自動排除。**這是 postmkt 的上游，改口徑＝跨站變更。**

**aetf 抓取失敗沿用舊快照的上限（2026-10-23，使用者裁定 A3″-a，觀察兩週）**：`src/build_aetf.py` 某檔三次重試皆失敗時，原本無條件沿用上一份 `latest.json` 的該檔並標 `stale`，00996A 因此自 10-06 起一直頂著 `src_date=2026-09-21` 的持股。現改為由 `carry_decision` 判定：舊快照 `src_date` 之後到今天（台北，含今天）的**交易日數**超過 `STALE_MAX_TRADING_DAYS`（5）就不沿用，只留在 `errors`；交易日判定走 `src/twse_holidays.py`（fail-open 只排週末，此時國定假日會多算一天、偏向較早停止）；`src_date` 缺或解析不了一律不沿用。下游影響（讀碼推論，尚未在真實班次觀測）：`diff.json` 讀的是全部日檔歷史，不受影響（該檔照列 `laggards`）；Worker `fxCardAetf2` 的 `foot` 用 `errors` 計數，不變；postmkt aetf tab 的比較候選、ETF 總覽與個股側欄「主動ETF 持有」不再出現該檔。被上限移出的檔**仍交給投信補位一次**（`dropped` 併入 `fetch_fallback` 的輸入；補位拿到比舊快照新的資料才寫回 `etfs`，名稱等欄位沿用舊快照，否則維持缺席）——2026-10-23 驗收指出若不這樣做，`FETCHERS` 已登記的檔（00403A／00981A／00980A／00985A／00999A）一旦 FinMind 長期抓不到就連補位機會一起失去；00996A 不在登記名單，實際不受影響。「抓取成功但 `src_date` 沒前進」（`not_advanced`）不在此上限內，由 `grab_holding` 的 14 日查詢窗口自然截斷。測試 `tests/test_aetf_stale_carry.py`。**觀察到 2026-11-06**：看 aetf 班 log 的「不沿用」行與 00996A／00415A 是否恢復。

**日期／時戳欄位語意一律查 `postmkt/docs/date-semantics.md`**（跨五站的唯一對照表）。
其中 Worker `/live` 的 **`ts` ＝指數列時戳**（2026-09-08 C 案落地後的新語意，取代舊的
「全體有分類個股 max(date)」）：取指數列 `001`（加權指數）的 `date`，`001` 取不到退 `101`
（櫃買指數），兩者皆取不到回 `null`，**`001` 與 `101` 不一致時取 `001`**。FinMind 原字串、
**無時區標記**（`YYYY-MM-DD HH:MM:SS.ffffff`）。**它的日期部分現在可以當資料日**——非交易日
給出正確的前一交易日（實測兩次）、收盤後鎖在當日 13:33 不漂（實測五次）、盤中隨盤跳動
（僅落後個股 max 4–5 秒，實測兩次）。同 payload 的 `generated_at` 才是我方產出時刻
（`toISOString()`＝**UTC `Z`**，非台北）。
**內部另有 `snap_ts`＝舊口徑 max(date)**，語意固定為「這份快照本身走到哪一刻」，供
`pickFrames`／`computeFlow` 的 `nowTs`／`series:<date>` 使用，**刻意不進 `/live` 對外 JSON**
（`buildLive` 回傳前 delete）。改 `ts` 或 `snap_ts` 任一者＝改 `/live` 語意，屬跨站變更，
先讀 `PROJECT_SUMMARY.md`「/live 資料時間改取 max(date)」段。

## 盤中 RRG 盤外定格（`data/rrg_frozen.json`，2026-09-11）

**⚠ 假日假歸檔事故與休市日守門（2026-09-29）**：2026-09-25（中秋）與 09-28（教師節）兩個**平日國定假日**，
intraday.yml 照 cron `10 6 * * 1-5` 觸發（實際 commit 落在台北 19:43／21:43，GitHub cron 延遲），而 Worker KV 裡有
**休市日殘留的 frame**——`data/intraday/2026-09-25.json` 與 `2026-09-28.json` 實查：54 格 `frames` 全 `stale:1`、
`total` 54 格**全天同一值 2540006019891**、`series` 0 筆，兩檔的 `total`／`cg` **逐位相同**。既有守門
（「一格 frame 都沒有／覆蓋率 <90% → 不歸檔」、「可用取樣點 <3 → 不定格」）對這個形狀**全部失效**（覆蓋率 100%），
於是寫出兩份假歸檔，並連帶污染 `data/rrg_base.json`（`days` 變成 09-22~09-25＋09-28）與 `data/rrg_frozen.json`
（`date=2026-09-28`、`base_days` 含 09-25）。
- **修法**：新增 `src/twse_holidays.py`（本 repo 行事曆消費端，判定邏輯**只有這一份**），`closed_reason(day, cal)`
  ＝週末或行事曆休市日。三支腳本共用：`archive_intraday.build()`／`build_rrg_frozen.build()` 在**任何網路請求之前**
  遇休市日印訊息 `return 0`（不寫檔、定格檔保留前一版）；`build_rrg_base.load_days()` 選基準日時剔除休市日檔
  （防既有殘檔或手動補跑回流，剔除清單標「休市」）。**`intraday.yml` 步驟與步驟序一字未改**——休市日 archive
  不產檔 → `build rrg base` 因 `data/intraday/` 無新檔照舊跳過 → commit 無 diff 照舊 exit 0；不紅燈、
  不引入 `continue-on-error`。
- **讀哪份行事曆**：**先讀本地 `data/twse_holidays.json`**（本 repo 即產出端，checkout 後就在磁碟上，免網路），
  本地缺檔／壞檔才退 raw URL（逾時 10 秒）。**fail-open**：兩者都不可用、schema 不等於 1 或為 bool（`True` 拒收、`1.0` 照收，與家族其他四端一致）、
  `years`／`closed` 形狀不合、或目標年度不在 `years` → 退回**只排週末**＝改動前行為，**不拋例外、不失敗**。
  此時平日國定假日若 KV 又有殘留 frame，仍會寫出假歸檔（同事故當時），`closed` 未收的颱風臨時停市亦同。
- **資料清理（同批）**：刪兩份假檔；`rrg_base.json` 以 `build_rrg_base.py` 正規路徑重算，`days`＝
  09-18／09-21／09-22／09-23／09-24（與 `97f688f` 那版同一組日子；各格數值不同，因 level 取自重算當下的
  `baseline.json`（`date=2026-09-24`），`97f688f` 當時用的是前一日那版）；`rrg_frozen.json` 從 `97f688f`
  **逐字還原**（`date=2026-09-24`、`base_days`＝09-17~09-23，不含當日、不含假日）。
- **批次一當時未動、2026-09-29 批次二已補**：Worker frame 班休市日不再寫 KV（殘留 frame 的**上游**已斷）、
  `runBackup` TW 班與 `runHealthCheck` 休市日比照週末（見「休市日（國定假日）各排程角色」節）、前端 `ovRrgTaipeiToday`
  休市日直接走定格。本節三支腳本的守門**保留**（行事曆 fail-open、或 KV 仍有更早殘留時的第二道）。
  測試 `tests/test_intraday_holidays.py`。

**守門的次生效應（可接受的降級，2026-09-12 覆驗補記）**：若某日首班的 `build rrg frozen`
因網路等原因失敗、但同班 `build rrg base` 成功並 commit，則**該日任何補跑都會被守門擋下**
（磁碟上的 base 已含當日）→ 該日永遠不會有定格檔，停在前一日。**行為安全**——畫面自帶資料日、
會照實標示停在哪一天，且首次失敗已由紅燈＋issue 報出；要硬補只能手動 `--base` 指定當時那版。

**✅ 排程首次寫檔已確認（2026-09-14，commit `217b0f8`，台北 14:40）**：`intraday.yml` 的
週一那班正常寫出 `date=2026-09-14` 的定格檔，**`base_days` 為 `09-07`~`09-11`、不含 09-14**
——而同一個 commit 的 `data/rrg_base.json` 已推進到 `09-08`~`09-14`（含今日）。
**這就是步驟序不變式在生產環境生效的直接證據**：定格排在 `build rrg base` 之前，
釘到的是使用者當日盤中看到的那版 base，不是重算後的。線上 Pages 同步（49,979 bytes、
`date=2026-09-14`）。在此之前唯一一次真實 run（`34623333645`）走的是守門路徑，
線上那份是 `--base` 手動產的 bootstrap。

> **線上驗證已通過（2026-09-12 台北週六上午，使用者實機確認）**：在
> https://shihpc.github.io/taiwan-flow-live-v2/ 的「即時一覽 → 輪動雷達」視角看到定格圖與
> 明標文案。綁定版本＝**`dc5382c`**（線上 `index.html` 與 `git show dc5382c:index.html` 的
> sha256 相同，`52f82231…`）。**這是真瀏覽器開真線上站的確認**——本沙箱 headless Chromium
> 連不到外網（`ERR_CONNECTION_RESET`，走 proxy 亦同），agent 端做得到的只有「curl 抓線上資產
> 回本機 http.server 重放」，**那不算線上驗證**，故此項由使用者親自完成。

週末／國定假日／frame 過了 KV 2 天 TTL 時，`/replay` 一格也拿不到 → 前端輪動雷達原本整張圖消失
（`index.html` 的 `function ovRrgHtml` 降級③「取不到盤中快照」）。**交易日收盤後不受影響**
（錨點夾到 13:30）。現改為讀 `data/rrg_frozen.json` 畫「定格圖」並明標，規格見
`docs/rrg-spec-20260809.md` §4 完成定義 5 ＋ §7.6。

- **產物**：`src/build_rrg_frozen.py` → `data/rrg_frozen.json`（約 49KB）。只存**輸入**、**不存座標**：
  12 個時點（＝前端 `ovRrgTimes(錨點 13:30)` 的 `all`）的鏈層 `frames`(share)／`amt`(億)／`mkt`(tseYi)
  ＋ `base`（`rrg_base.json` 的同時點切片）。座標仍由前端**同一支** `ovRrgCompute` 算
  （`function ovRrgFrozenView` 把定格資料暫換進 `OV_RRG`／`OV_RRG_BASE` 再呼叫它，try/finally 還原）
  ——**刻意不在 Python 重算座標**，那會變成同一口徑兩份實作（taiwan-flows `parity.py`、
  postmkt `augmentLending` 的漂移教訓）。
- **share 口徑＝前端 `ovRrgAggFrame`，不是 `data/intraday` 的次產業層**（兩者差異見
  `src/build_rrg_base.py` 檔頭「口徑」段）：個股層、依 classify 的 `c` 去重、只算 twse、
  分母 `market.tse.amt_yi`。**分子與分母的代號集合不對稱**（分母只看 frame；分子還要與 `/live`
  的代號取交集，因為 `ovAggBy` 走訪的是 `state.live.stocks`）——照抄前端既有行為，不要「修正」它。
  2026-09-11 以 node 抽出 `index.html` 真正的 `ovReplayBuild`／`ovAggBy`／`ovRrgAggFrame` 對跑，
  12 時點 × 47 鏈的 share／amt 與 Python 端**逐位相同**。
- **`date in base["days"]` 就拒絕寫檔（`build()` 的 fail-safe，2026-09-11 覆驗退回後補）**：
  base 的 days 含定格日＝這份 `rrg_base.json` 已把當日算進基準，切片會釘到使用者當日盤中沒看過
  的那版 → 不寫檔、保留前一版定格檔、**優雅退出不紅燈**（舊檔自帶 date，畫面照實標示）。
  **為什麼不能只靠下面那條步驟序**：步驟序只在**單次執行內**成立。同一天第二次跑時
  （Worker 對 intraday 另有台北 14:40／15:10 備援 dispatch，家族 cron 延遲中位數約 2h，
  主班延後就會與備援重疊；`workflow_dispatch` 補跑同理），`build rrg base` 會因
  `data/intraday/` 無新檔而跳過、定格步驟卻照跑，磁碟上的 base 已是重算版 → 定格檔被靜默寫錯
  （實測 564/564 格全不同），而 `tools/noop_guard.py` 只忽略 `generated_at`、照常 commit，
  **全程零訊號**。**這是「靠步驟序保證正確性」的通病**：凡是「A 的正確性依賴 B 還沒跑」的設計，
  A 自己身上都要有一道守門。補跑用 `--base` 指定當日那一版。
- **`.github/workflows/intraday.yml` 的步驟序是硬約束**：`archive intraday` → **`build rrg frozen`
  （id: `frz`）** → `build rrg base`（id: `rrg`）→ `commit` → 失敗才轉紅燈 → notify。
  ①**定格必須排在 `build rrg base` 之前**：後者會把「今天」也算進基準，重算後的 base 反推今天的
  座標就與使用者當日盤中看到的不同了，定格的意義正是「同一張圖」。②**定格步驟失敗絕不得讓
  commit 被 skip**（`data/intraday/` 是 KV TTL 2 天內唯一能留下的回測原料）：沿用既有的
  `ok=0` ＋ 延後紅燈模式，**禁止 `continue-on-error`**（會被靜默吞掉，理由寫在該檔最後一步註解）。
  ③commit 步驟的 pages dispatch 判斷已改成 `grep -qE '^data/rrg_(base|frozen)\.json$'`——
  定格檔是前端以同源相對路徑載入的產物，不 dispatch 就只進 repo、不上 Pages。
- **輪動雷達候補清單第二頁按鈕 2026-10-23 由「動能領先」改為「領先象限（依位移）」**（使用者裁定 A2′-b）：該頁與「資金剛輪入」頁同依 `move30`（30 分淨位移）遞減排序，原名與排序鍵不符；只改顯示文字，`data-ovrrg-tab="lead"` 與排序未動。postmkt 盤後版同型清單依 RS-Ratio 排序、名為「相對強度領先（領先象限）」，兩站排序鍵不同、名稱刻意不同。
- **前端降級順序**（`function ovRrgHtml`）：**台北週末**（`function ovRrgTaipeiToday` 取星期，
  沿用 `liveStatus` 既有做法）直接走定格、連 `/replay` 都不打——降級②那兩句（「盤前時段」
  「盤中資料累積中」）依的是**牆鐘**，週末說出口是**假的斷言**（覆驗實測週六 00:15/03:00/09:10
  顯示「盤前時段」、09:30/09:56 顯示「盤中資料累積中」，定格檔請求 0 次）。**平日行為逐字不變**
  （措辭精確化，2026-09-12 覆驗實查：**不是「原始碼一行不動」**——平日分支內有 2 行變數提升
  （`const T=`→`T=`、`const {rows,valid}=`→`({rows,valid}=)`）；逐字未動的是兩句早退文案與
  `ovRrgEnsure`／`ovRrgAnchorMin`。**行為**不變的證據＝四情境 `#main` innerHTML 與 G1 之前逐字相同）
  （那兩句在平日是真的）：rows 為空 → 先試定格檔 → 定格檔讀不到／內容湊不出
  3 個可用取樣點才退回原降級③文案。**國定假日（2026-09-29 批次二起）比照週末**：`ovRrgTaipeiToday` 多回 `hol`
  （同源 `data/twse_holidays.json`，見「頂列」節的行事曆說明），休市日直接走定格、不打 `/replay?t=`，文案寫
  「國定假日休市」、定格種類＝**休市定格**；行事曆未載入（載入前的首次渲染或 fail-open）仍是舊行為——平日假日
  10:01 前會看到「盤前時段」、之後由降級③接手並標**收盤定格**。`ovRrgBaseDays` 的基準新鮮度同批改扣國定假日
  （示警文案依行事曆是否載入二選一）。
  **盤中與交易日收盤後走不到定格路徑**（那時 rows 非空），
  即時路徑逐字不變（2026-09-11 Playwright 以同一組 mock ＋ 固定時鐘，對跑改動前後的 `#main`
  innerHTML **逐字相同**）。CSP 不需改（同源 `data/*.json` 已被 `connect-src 'self'` 涵蓋）。
- **補跑**：`--base` 可指定當時那一版 base（事後補跑時 `data/rrg_base.json` 已被重算，要用
  `git show <該日之前的 sha>:data/rrg_base.json` 取出舊版）。離線測試 `tests/test_rrg_frozen.py`。

## 歸檔的真口徑鏈層欄位 `cg`／`cmkt`（`data/intraday/*.json`，2026-09-13）

`src/archive_intraday.py` 在既有的 54 格 frame 迴圈裡**多算一份前端 RRG 口徑的鏈層矩陣**，
附加成三個新欄位（既有 `date`／`generated_at`／`unit`／`series`／`times`／`frames`／`total`／
`nstk`／`g` **一字未動**，`src/build_rrg_base.py` 吃的 `g`／`total`／`times` 不受影響——
已對跑驗證：把新欄位塞進全部 38 份歸檔檔的副本後重跑 `build_rrg_base.build(5)`，輸出與
現行 `data/rrg_base.json` 逐位相同）：

| 欄位 | 內容 |
|------|------|
| `cg` | 鏈名 → 各時點累積成交額（**億**），鏈名集合＝`classify.json` 的 `c` 全集（47 條，**刻意不綁 `rrg_base.json` 那份會變的 chains**，歸檔檔要自我完備）；缺格／分母不成立記 `null`，當日零成交的鏈記 `0.0` |
| `cmkt` | 各時點 TSE 分母（億，＝`ovReplayBuild` 的 `mkt.tseYi`） |
| `cmeta` | `unit`／`chains`／`universe`／`hit`／`share`／`src`／`note`（口徑說明） |

- **share 刻意不另存**：`share = cg[鏈][i] / cmkt[i]`，那與 `agg_frame` 內部的 `a / mkt_yi` 是
  **同一個運算**（同兩個 double、同一次除法），故逐位相同；另存一份 share 會讓檔案再大一倍
  （實測 share 的 JSON 字面量平均 19.7 字元 vs amt 的 9.8）。
- **口徑實作只有一份**：`from build_rrg_frozen import agg_frame`，本檔**不自己算**。`agg_frame`
  已與 `index.html` 的 `ovReplayBuild`／`ovAggBy`／`ovRrgAggFrame` 逐位 parity（G1 實測 12 時點 ×
  47 鏈）。離線測試 `tests/test_archive_intraday.py` 以合成 frame 斷言 `cg` 逐位＝`agg_frame`
  的 `amt_yi`、`cg/cmkt` 還原的 share 逐位＝其 `shares`（260 格），這是「真的重用而非重寫」的證據。
- **與 `g` 完全不同口徑，不可混用**：`g` 是**次產業層且含上櫃／興櫃／彙總碼**，2026-09-11 實測
  `total` 23,824 億 vs 真分母 7,038 億＝**3.39 倍**；拿它回聚合重建鏈層，端到端實測 `oddRaw`
  逐鏈判定 45% 翻面、象限 49% 不同（Kendall 0.42，0.5＝亂數）。**這正是要多存一份的理由**。
- **降級**：`/live` 取不到代號集合（`ovAggBy` 的走訪來源）時**只是不寫這三個欄位**，既有歸檔
  照常完成並印 `::warning::`——KV frame TTL 只有 2 天，當天沒 commit 就永久遺失，不能讓加值
  欄位的失敗賠掉當日唯一一次歸檔機會（同檔頭「務必維持 return 0」那段論證）。
- **成本**：不多打任何一格 frame（只用迴圈裡已抓到的 54 格），只多一次 `GET /live`。
  **體積＝實測 +24,186 bytes＝+8.2%**（2026-09-14 首次排程產出 318,756 bytes vs 前一日
  294,570 bytes）。**上線時的估算 +33,080／+11.2% 偏高約 37%**——當時量法是「真實歸檔檔＋
  按當日 `total` 比例重建的矩陣」（見 `src/archive_intraday.py` 檔頭做法 4），重建值的
  JSON 字面量比真實鏈層金額長，故高估；覆驗者以 `agg_frame` 真實算式重核得 +32,778 也同樣偏高。
  **教訓：按比例重建的合成值可以估「量級」，估不準「位元組」**。
- **✅ 首次端到端實跑已確認（2026-09-14，同 `217b0f8`）**：三個欄位皆落地，`cg` **47 鏈**、
  `cmkt` **54 格**對齊 `times`、**零 null 格**，未走 `/live` 降級路徑。
  **口徑檢定通過**——`cmkt` 是 TSE 分類股分母，全日 `total`(元)/1e8 ÷ `cmkt` 落在
  **3.39~3.61**（收盤格 21,275.5 億 ÷ 6,056.6 億＝**3.51**），與 09-11 實測的 3.39 同一帶，
  **證實抓的不是全市場**。這是離線測試擋不住的失效模式（測試只證明「與 `agg_frame` 逐位相同」，
  證明不了它在真實排程環境拿到的 `universe`／`cmap` 是對的），故列為該班的首要檢查項。
  ⚠ **「與真值逐位相同」仍未驗到**——那要有同日的 `rrg_frozen.json` 對帳，而定格檔只存
  12 個時點、歸檔存 54 個，兩者時點集合不同；且 09-11 的 frame 早已過期無法回頭對。
- **⚠ 過去的日子無法回補**：KV frame TTL 2 天，新欄位只從 2026-09-14 那一班起算，
  要累積 **5~10 個交易日**才夠重跑 `OV_RRG_ODDMAX`／`OV_RRG_CLOSE` 的鏈層依據（見
  `docs/rrg-spec-20260809.md` §7 第 4 條 (d)）。
- **休市日不歸檔（2026-09-29）**：`2026-09-25`／`09-28` 兩份假日假歸檔已刪（事故與守門見上一節開頭）。
  回測腳本（`backtest/run_rrg*.py` 以 glob 讀本目錄）的樣本因此少兩個「假交易日」——那兩天本來就不該在樣本裡。

## CSP 與注入面（2026-09-06）

`index.html:13` 的 `<meta http-equiv="Content-Security-Policy">`（比照 `postmkt/index.html:10`，另加 `form-action 'none'`）。
同批把 `:6-8` 原三行 `<meta http-equiv="Cache-Control|Pragma|Expires">` 移除（現代瀏覽器以 HTTP 標頭為準、忽略此類
meta；理由寫在原位 HTML 註解），快取策略改由 `const FETCH_CACHE`（grep 唯一命中）決定：`/live` 仍 `no-store` 但**不再帶
`?t=` buster**（Worker cf cache 以 URL 為 key，帶 buster 每次都新 key、cf 快取永遠不命中）；`data/*.json`（classify／rrg_base）
改 `no-cache` 條件請求（本機 http.server 實測 reload 後 304）；`/replay?t=HH:MM` 的 `?t=` 是回放時點參數不是 buster，維持 `no-store`。
回退＝把 `FETCH_CACHE` 兩值改回 `"no-store"`。**新增資料源時 `connect-src` 要同步加**，否則 fetch 被靜默擋下
（console 出現 `Refused to connect`）。盤點（2026-09-06 grep 實查，行號為當時）：

| 面向 | 現況 | CSP 對應 |
|------|------|---------|
| 內嵌 script | 只有 1 個 `<script>` 區塊（`index.html:183` 起） | `script-src 'self' 'unsafe-inline'`（不為 CSP 重構、不搬外部檔） |
| 內嵌事件屬性 | **零**（`on*=` 屬性 grep 無命中；事件全走 `addEventListener`／`el.onclick=` 指派） | — |
| 外連 script／`<link>`／`<img>`／`<iframe>`／`<object>`／`<form>`／`<base>`／`@import`／`url()`／`javascript:`／`eval`／`document.write` | 皆無 | `img-src 'self' data:`（預留）、`object-src 'none'`、`base-uri 'none'`、`form-action 'none'`、不需 `'unsafe-eval'` |
| `style=` 屬性 | 52 處（表格內距、連結色等） | `style-src 'self' 'unsafe-inline'` |
| fetch 目標 origin | 同源 `data/classify.json`／`data/rrg_base.json`／`data/live.json`（無 Worker 時）；`taiwan-flow-v2.shihpc.workers.dev`（`/live`、`/replay`）；`api.anthropic.com`（`callClaude`）；`raw.githubusercontent.com`（postmkt analyses 雲端歷史 `CLOUD_RAW`）；`api.github.com`（`ghSaveAnalysis` 寫 postmkt＋`loadSiteVer`） | `connect-src` 白名單恰為此 4 個外部 origin＋`'self'` |
| 純導覽外連 | Yahoo（`yahoo()`／摘要 `link`）、`shihpc.github.io/postmkt/`；皆 `target="_blank" rel="noopener"` | 不受 CSP 限制（無 `navigate-to`） |
| localStorage | `insight_model`／`tflive2_auto`。**金鑰 2026-10-01 起不再存 localStorage**：Anthropic key／GitHub PAT 改由瀏覽器密碼管理器保管，摘要分析 tab 的 `<form data-cred>` 載入後只在記憶體 `CRED`（勾「只在本分頁記住」才寫 sessionStorage `cred_tab_<kind>`），只送 header、不進 DOM／URL；舊 key `anthropic_key`／`gh_token`（連同 `fm_token`／`tf_gh_token`）不讀作金鑰，載入即無條件刪除（搬移提示卡已於 2026-10-18 移除）。四站寫法與家族 username 正本見 `postmkt/CLAUDE.md` 約定 6；載入時打的驗證請求（`api.anthropic.com/v1/models`、`api.github.com/repos/shihpc/postmkt`；後者只證明 PAT 有效、不證明有寫入權限）都在既有 `connect-src` 內，CSP 未改。`form-action 'none'` 不影響：表單 submit 一律 `preventDefault()`、不導覽 | — |

### `innerHTML` 逐處稽核（2026-09-07 完成，取代 09-06 的「未做逐處稽核」）

**盤點數字（2026-09-07 重新 grep）**：`innerHTML` 15 行（與 09-06 同）、`insertAdjacentHTML`／`outerHTML`／
`document.write` **零**、`style="` 屬性 52 處、`escI(` 呼叫 **49 → 84 處**。

**信任邊界更正（這是本次稽核最重要的發現）**：09-06 那段寫「股名／產業名／次產業名來自自家 `classify.json`
與 Worker `/live`（信任邊界＝自家管線產出）」——**這句話會誤導**。`classify.json` 的 `n`／`e`／`c`／`p`
是 `src/meta.py` 從 FinMind **原字串直寫**（`:37` `stock_name`、`:38-39` `industry_category`、
`:52-56` `TaiwanStockIndustryChain` 的 `industry`／`sub_industry`），管線端**沒有任何消毒**；Worker `/live` 的
`exchange[].sector`／`chain[].sector`／`flow.subs[].name` 也全部由同一份 `classify.json` 的鍵長出來
（`worker/src/index.js` 的 `function acc` 以分類名當 key、`const cl = classifyJson.map`）。所以真正的信任邊界是
**FinMind**，不是自家字面量；`script-src 'unsafe-inline'` 之下 CSP 對 `<img onerror>` 完全無效。
姊妹站 taiwan-flows 同型問題已於 2026-09-06 實證會執行（見該 repo CLAUDE.md 注入面表 `innerHTML` 列）。

**修正：改動 30 行、新增 35 個 `escI()` 呼叫**（下表 13 個區塊；2026-09-07 驗收實測 `grep -o 'escI(' | wc -l` 由 49 → 84。注意用 `grep -c` 會得到 40 → 69，那是**行數**不是出現次數），行號為 2026-09-07 當時：

| 區塊 | 位置 | 被逃逸的值 | 來源 |
|------|------|-----------|------|
| `yahoo()` | `:215` | 代號（href 走 `encodeURIComponent`、文字走 `escI`） | FinMind `stock_id` → classify key |
| `futuresVixLine()` | `:259` | 期貨合約月份 | FinMind 期貨 `contract_date` |
| `sumRow()` | `:375` | 合計列的類股／次產業名 | classify |
| `mkStockRow`／`flowStockRow`／`ovRadarStocks`／`renderOvTable` 成分股 | `:377`／`:426`／`:2218`／`:2116` | 股名 `info.n` | FinMind `stock_name` |
| `renderFlow()` | `:507`／`:517`／`:533` | `flow.frames["10"/"30"]`、`baseline_date`、次產業名、下鑽標題 | Worker `/live` |
| `ovHeadline()` | `:2011`／`:2025`／`:2031`／`:2036` | 次產業名 ×4、領頭股名 | classify |
| `ovDivergingBar()` | `:2077` | 三視角（次產業／產業鏈／個股）共用出口的 `r.name` | classify |
| `renderOvTable()` | `:2103`／`:2109`／`:2118` | 次產業名、領頭股欄、下鑽標題 | classify |
| `ovRadarHtml()` | `:2261` | 佔比升溫次產業名 | classify |
| `ovSummaryCard()` | `:2447`／`:2448`／`:2450`／`:2458` | 次產業名 ×3、代號 | classify |
| `render()` | `:2501`／`:2513` | `live.exchange/chain[].sector`、產業別下鑽標題 | Worker `/live` |
| `chainSub()` | `:2530`／`:2532`／`:2535` | 次產業名、產業名標題／合計列、次產業下鑽標題 | classify |
| `boot()` | `:2546` | `classify.json` 載入失敗的例外訊息 | fetch 例外 |

**逐一點名的豁免（稽核過、刻意不加 `escI`）**：
①**數值欄**——全部走 `toFixed`／`Math.round`／`toLocaleString`／算式，型別即保證（`yi`／`num`／`pct`／`pctCell`／
`sgnTxt`／`cxCell`／`intsCell`／`ovTreemapBadge` 等）；`chain_coverage.with_chain/total` 是 Worker 端
`Object.keys().length`，同類。②**`data-*` 屬性**——`data-sec`／`data-sub`／`data-fsub`／`data-ovtree-*`／
`data-ovquad-*`／`data-ovrrg-pick` 全走 `encodeURIComponent`，`data-pool`／`data-idx`／`data-ovmap`／`data-ovview`／
`data-tab`／`<option value>` 是程式內字面量。③**已在 09-06 就正確的路徑**——`escI` 早已覆蓋 `renderTopline`／
象限圖 `<title>`＋標籤／RRG 全區（含 `ovChainDisp`）／treemap 格（`escI(nm)`＋`escI(line)`）／`OV_REPLAY_ERR`／
`OV_RRG.err`／`OV_RRG_BASE_ERR`／雲端歷史 meta／`insightErr`；**實測確認這兩類本來就安全**（見下）。
④**LLM 輸出**走三站同步的 `mdToHtml`（`esc2` 逃 `&<>`，只進元素內容不進屬性）＋`linkifyStocks`
（href 只由 regex 命中的純數字代號組成）——**判定為安全但屬三站逐字同步碼，本次一律不動**。
⑤`insightGatherContext()`（`:704-772`）與 `OV_SUMMARY_TEXT`（`:2453`）雖有大量原字串插值，但**不是 innerHTML**——
前者是送給 Anthropic 的 prompt 純文字、後者是剪貼簿純文字。⑥`ovToast()` 走 `textContent`。

**注入實測（Playwright，2026-09-07；本沙箱瀏覽器連不到外網，全部走 `page.route` 餵凍結／污染檔）**：
把 `<img src=x onerror="window.__xss=[...window.__xss||[],'TAG']">` 餵進 `classify.json` 的
`n`／`e`／`c`／`p[][1]` 與代號鍵、Worker `/live` 的 `exchange/chain[].sector`／`flow.subs[].name`／
`flow.frames`／`baseline_date`、`/replay` 的 `error`、雲端歷史的 `at`／`model`／`date`／`text`，
走完 7 tab ＋各層下鑽 ＋ 回放滑桿共 24 個檢查點：
**修正前 6 類觸發**（`stockname`／`subindustry`／`chainsector`／`exchsector`／`code`／`frames`），
**修正後 0 類觸發、`#main` 內 `img` 元素 0 個、樣本以字面文字顯示**（每個檢查點另斷言注入字串確實出現在
`innerText`，證明是「跑到了但被逃掉」而非「沒渲染」）。`replayerr`／`cloudmeta` 兩類**修正前就不觸發＝本來就安全**。
**注意樣本不可含小括號**：`cleanSub()` 會砍掉「第一個 `(` 之後全部」，帶括號的樣本會被它意外截斷而假陰性。
**乾淨資料回歸**：以真實 `data/live.json`＋`data/classify.json` 傾印 4 個 tab＋2 層下鑽＋`#mkcard` 的
`innerHTML`，修正前後**逐字相同**（只差 `tbl()` 的流水號 `data-t="tN"`）——`&` 是全站唯一受影響的字元
（15 檔 `S&P` ETF 與次產業「MR Headset & SG」），`escI` 後 DOM 文字節點仍是 `&`，排序用的 `ctext()`
走 `innerHTML→textContent` 也自動還原，實測畫面顯示與排序皆不變。

**根因仍在上游、本次刻意未動**：真正的一勞永逸是在 `src/meta.py` 寫入前消毒 FinMind 字串
（比照 `taiwan-flows/src/sanitize.py` 的 `sanitize_label()`，**`&` 要保留**否則 `S&P` 會被改名）。
那會改變 `classify.json` 內容＝Worker `/live` 與姊妹站的上游，屬跨站變更，需另案裁決。
前端 `escI` 是**必要**的一道（第三方 JSON 隨時可能變），不因上游日後消毒而可以拿掉。

驗證（2026-09-06 實測，Playwright 本機 http.server＋`/live` route mock 凍結檔 `data/live.json`）：7 tab console 無 `Refused to`、
pageerror 零；反向 `fetch("https://example.com/")` 被擋（`Failed to fetch`＋1 則 `Refused to connect`）；**304 要在無 `page.route` 的
context 測**——Playwright 攔截模式會停用瀏覽器 HTTP cache，有 route 時 reload 永遠 200。

## 頂列「資料日｜本站更新｜狀態」（2026-09-06 建立；2026-09-08 隨 `ts` 新語意改寫）

`#tsline`（`index.html` 的 `function renderTopline`，判準在 `function liveStatus`／`function liveDataDate`，取值依據寫在其上方
區塊註解）取代原「最後成交 ts · ⚠快照 N 分前」列，與 postmkt／taiwan-flows 頂列同款式。**資料日就取 `ts` 的日期部分**
——C 案落地後 `ts` ＝指數列時戳（`001`，退 `101`），已可當資料日（見「已知限制」第 5 條與
`postmkt/docs/date-semantics.md`「Worker `/live`」段）；`/live` 仍沒有獨立資料日欄（`index` 由 `idxOut` 產生、不含 date；
`series` 只有 HH:MM），取值規則：

| 情況 | 資料日 | 依據 |
|------|--------|------|
| `ts` 時分 ≥ 09:00 | `ts` 的日期 | **`ts` 為合法時戳時實務上只走這條**——但這是「指數時戳只會是 09:00 後的盤中／收盤值」的**推論、非官方保證**。依據＝`PROJECT_SUMMARY.md`「觀測紀錄」表 **8 筆樣本（#1–#6 ＋ A、B）的 `ts_index` 全部 ≥09:00**（`13:33`、`10:30:45`、`11:31:15`…），無任何 <09:00 樣本；**不是**舊語意那兩筆 08:30 殘留觀測（那是 09:00 門檻位置的由來，不是這條推論的證據）。指數列不參與盤後定價／興櫃交易，非交易日給正確的前一交易日、收盤後鎖當日 13:33、盤中隨盤跳動（僅落後個股 max 4–5 秒，實測） |
| `ts` 時分 < 09:00 | `flow_last.date`（須早於 `ts` 日期），無則 `ts` 日期的前一平日 | **這個子情形在新語意下走不到——但那是推論、不是保證**（2026-09-08 覆驗更正：原寫「已成死碼」是**過強的斷言**）。舊語意（個股 max(date)）在非交易日會是 08:30 盤前殘留，才需要這條後備。留作 `ts` 形狀劣化（上游指數列缺漏／退回舊形狀）時的降級路徑 |
| `ts` 為 null（`001`／`101` 兩列指數皆缺） | `flow_last.date`，無則「—」 | **後備分支整體是活路徑**：`ts` 為 null 時就會走到它（覆驗情境④a 實測：`ts=null` ＋ `flow_last.date=今日` → 資料日由它推得），所以**不可把整條後備稱作死碼**。上游嚴重劣化才會發生。已知失效：定格班漏寫時 `flow_last.date` 偏舊；「前一平日」（`prevWeekday`）自 2026-09-29 起在行事曆載入後另跳國定假日，未載入時只排週末 |

**可見文案一律稱「指數時間」，不得再寫「最後成交」**（2026-09-08 改，四處：`renderTopline` 資料日 tooltip、
`liveStatus` 收盤定格／盤中兩個 tooltip、`insightHtml` 摘要分析 crumb）。`ts` 為 `null` 時經共用函式
`function idxTsText` 降級為「—」，**不得印出字面 `null`**。

資料日 tooltip 由 `function dataDateTitle` 產生，**三種狀態不可合併成一個三元**（2026-09-08 首版就是
`live&&live.ts ? A : B`，讓「沒拿到 payload」與「拿到了但 `ts` 為 null」共用否定分支，於是 `/live` 掛掉時
也顯示「上游未提供指數列」——**斷言了我方並不知道的成因**，且與同列右側狀態欄「`/live` 載入失敗，
無法判斷資料狀態」直接矛盾，覆驗退回）：

| 狀態 | tooltip |
|------|---------|
| `live` 為 null（含 boot 兩次失敗） | **空字串**＝不掛 tooltip、不臆測成因 |
| 有 payload 但 `ts` 為 null | `無指數時間（上游未提供加權／櫃買指數列）` |
| 有 `ts` | `指數時間 <ts> —— 加權指數（缺則櫃買指數）更新時刻，` ＋ 依 `function dataDateFromTs`（＝`ts` 時分 ≥09:00）接「資料日即取自此」或「但資料日未取自它」 |

否定側的措辭**只說「資料日未取自它」這個必然為真的事實，不得再多描述一個字**（兩次覆驗連續退回同一型）：
①**不提「早於 09:00」**——否定側同時涵蓋「`ts` 時分 <09:00」與「`ts` 為 truthy 但格式不合、`TS_RE` 沒解析成功」，
後者從未做過那個時間比較；②**不說「改由後備來源推得」**——後備也可能落空（無 `flow_last`，或日期部分不可
`Date.parse` 使 `prevWeekday` 回 `null`），此時 `liveDataDate` 回 `null`、資料日顯「—」，**根本沒推得任何東西**。
後備成不成功，畫面上的「資料日」欄自己會說，tooltip 不替它斷言結果。

兩點刻意的精確性：①措辭寫「加權指數（**缺則櫃買指數**）」——Worker 是 `001 || 101`，`ts` 可能來自櫃買指數；
②「資料日即取自此」是**有條件**的斷言，由 `dataDateFromTs` 與 `liveDataDate` 共用 `TS_RE`／`function tsParts`
保證判準一致，**改一邊要改另一邊**，否則又會回到「敘述與程式不符」。

本站更新＝`generated_at`（Worker 牆鐘 UTC Z）轉台北到分。狀態五值（台北時區；交易日排週末，行事曆載入後另排國定假日，未載入＝只排週末）：**查詢失敗（未知）**＝boot 兩次
都拿不到可用 payload（後續自動刷新失敗沿用上一份、不改狀態）；**延遲**＝`generated_at` 距今 >3 分（沿用舊門檻）；**休市定格**＝
週末、**行事曆所列的國定假日**（2026-09-29 起，tooltip 寫「國定假日休市（名稱）」），或平日 09:00 後資料日≠今日（行事曆未載入時的國定假日／開盤首分鐘尚無成交／上游未更新，三者無法區分）；**收盤定格**＝平日資料日＝今日且
≥13:35（同 `ovMarketPhase`），或平日 09:00 前握著上一交易日；**盤中**＝平日 09:00–13:35 且資料日＝今日。
**休市行事曆（2026-09-29 批次二）**：`boot()` 以 `twseCalLoad()` **非阻塞**讀同源 `data/twse_holidays.json`
（CSP `connect-src 'self'` 已涵蓋），`twseCalParse`／`twseHoliday` 與 Worker `parseHolidayCal`／`holidayClosed` 同一套規則。
**載入前先以只排週末渲染**；載入成功且**近 30 日（含今日）內有休市日**才重繪一次（其餘日子行事曆改變不了任何顯示，省一次重繪）。
讀不到／壞檔／形狀不合＝fail-open，**不重繪、畫面與改動前逐字相同**。消費點：`prevWeekday`（`liveDataDate` 後備）、`liveStatus`、
`ovRrgTaipeiToday`、`ovRrgBaseDays`。驗證（Playwright 固定台北時鐘 09-25 10:30／09-28 21:00／09-26 10:00／09-29 10:30，`/live` 與
`/replay` 以 route mock）：行事曆 404／壞檔時 `#tsline`、`#main`（即時一覽與輪動雷達）與改動前 `94c5773` 逐字相同；
行事曆正常時假日頂列「休市定格」＋國定假日 tooltip、輪動雷達 `/replay?t=` 請求 0 次並走休市定格；09-29 僅差「基準已過期」
誤報消失（09-23→09-29 扣兩個假日後由 4 降為 2 個交易日）。
驗證（2026-09-06，Playwright `page.clock`＋`/live` route 七情境：收盤後凍結檔／盤中／週日有無 `flow_last`／平日盤前殘留／延遲／500）
全數符合預期、pageerror 零。**若日後 `/livediag` 觀測到殘留時戳 ≥09:00 的形狀，要回來改 `liveDataDate` 的分水嶺。**

## 管理端點認證（2026-10-23，B3+B4 ①）

**只關門**：Worker fetch handler 有幾支無認證卻會產生副作用的路徑，現在一律要管理金鑰；「免密碼更新 endpoint」
（讓同事不帶金鑰也能觸發）**本批不做**（使用者選方案 ①）。實作在 `worker/src/index.js` grep
`// ---- 管理端點認證`（`export function adminCheck`／`export function adminKeyEqual`／`export const ADMIN_HEADER`），
測試 `node test/adminkey.mjs`。

**路由盤點（2026-10-23 逐支讀碼）**：

| 路由 | 副作用 | 本批 |
|------|--------|------|
| `/alerts/test` | 每打一次真送 LINE／webhook（無去重；LINE 免費月額度被洗光後真告警就發不出去）；另讀 KV `line:uid` 回顯 | **一律要 key** |
| `/snap`（含 `?force=1`） | 打 FinMind 快照、寫 KV `f:`／`fi:`／`series:`（force=1 連收盤後都寫，會污染當日序列） | **一律要 key**（無 dry 模式） |
| `/backup?name=…&dry=0` | `workflow_dispatch`＋寫 `bkfired:`／`jobstat:` | `dry=0` 要 key；`dry` 省略或 `=1` 不變 |
| `/sumcheck?slot=am\|pm&dry=0` | dispatch `summary.yml`＋寫 `sumfired:`／`jobstat:` | 同上 |
| `/evening?dry=0` | 晚場鏈 dispatch（pm summary／diag／mktbal／aetf2／圖卡渲染）、**推 LINE 圖卡** | 同上 |
| `/health?slot=…&dry=0` | 缺件告警（`alertJob` → LINE／webhook）＋寫 `alerted:`／`jobstat:` | 同上 |
| `/usersync?k=&set=` | 寫 KV 自選清單（以同步碼雜湊為鍵） | **不改**：taiwan-stock-news 前端的美股自選跨裝置同步直接用它（本站 `index.html` grep 零命中），加 key 功能就廢了；影響範圍限於知道同步碼的人 |
| `/line/webhook` | 寫 KV `line:uid`（只用於 `/alerts/test` 回顯，**不**用於發送——發送用 secret `LINE_USER_ID`） | **不改**：LINE 平台送不出自訂標頭；正解是驗 `x-line-signature`（需 channel secret），另案 |
| `/fundamentals`／`/chips`／`/technical` | 打 FinMind，結果寫 KV 快取（每 id×日一把，TTL 2 天） | 不改：公開唯讀功能，快取寫入是實作細節（殘餘風險：可被用來消耗 FinMind 額度，每次最多 30 檔） |
| `/live`／`/livediag`／`/status`／`/cards/data`／`/replay`／`/jobs`／`/alerts/log`／`/uswatch`／`/` | 唯讀（`/live`／`/status`／`/cards/data` 只寫 cf 快取） | 不變 |

**殘餘風險（既有行為、非本批引入，2026-10-23 驗收補記、未改程式）**：不帶 key 的 `dry=1` 仍有少量寫入——`runBackup`／`runSummaryDispatch`／`runChain` 在「產物已落地」時會寫 `bkfired`／`sumfired` 的 `produced` 狀態（反映真實狀態、危害低）；`/evening?dry=1` 的 `runEvening` 在 `pushDailyCards` 拋錯時的 catch 分支仍會 `alertJob`（每日每 tag 去重，至多一則）。

**規則**：①請求標頭 `x-admin-key` 必須與 secret `env.ADMIN_KEY` 相等（固定時間逐 byte 比較，長度不同直接拒絕）；
②**不從 query string 讀 key**（會進日誌、瀏覽器歷史、Referer）——放 query 等同沒帶；③`ADMIN_KEY` **未設定或為空字串
時一律拒絕（fail-closed）**，reason 寫「未設定 ADMIN_KEY」；④拒絕回 **403** `{ok:false, reason}`（`no-store`），
**不執行任何副作用**（測試斷言零對外請求、零 KV 操作）；⑤回應與 log 一律不含收到的 key；⑥參數不合法（例如
`/backup?name=nope&dry=0`）照舊先回參數錯誤——那條路本來就沒有副作用。
**CORS 刻意不動**：OPTIONS 回的標頭只有 `Access-Control-Allow-Origin: *`／`Allow-Methods: GET, OPTIONS`、**沒有
`Allow-Headers`**，所以帶 `x-admin-key` 的跨站瀏覽器請求預檢必然失敗、送不出去；不帶標頭的跨站簡單 GET（例如惡意頁的
`<img src=…/alerts/test>`）只拿到 403。我們不需要瀏覽器跨站呼叫管理端點，最小改動就是不加 Allow-Headers。
副作用：**瀏覽器網址列直接開 `/alerts/test` 不再有效**（網址列帶不了標頭），改用下列指令。

**使用者要做的事**（一次）：`cd worker && npx wrangler secret put ADMIN_KEY`，貼一串夠長的隨機字串（例如密碼管理器產生
的 32 字元以上）。**在設定之前，上表「要 key」的請求全部回 403**——排程（cron）不經 fetch handler，完全不受影響。

```powershell
$k = Read-Host -AsSecureString "ADMIN_KEY" | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }
Invoke-RestMethod -Uri "https://taiwan-flow-v2.shihpc.workers.dev/alerts/test" -Headers @{'x-admin-key'=$k}
Invoke-RestMethod -Uri "https://taiwan-flow-v2.shihpc.workers.dev/backup?name=daysummary&dry=0" -Headers @{'x-admin-key'=$k}
```
```bash
read -rs K   # 貼上 ADMIN_KEY，不回顯
curl -sS -H "x-admin-key: $K" "https://taiwan-flow-v2.shihpc.workers.dev/alerts/test"
curl -sS -H "x-admin-key: $K" "https://taiwan-flow-v2.shihpc.workers.dev/evening?dry=0"
```
（key 只放在變數裡、不要寫進腳本檔或貼進對話；`dry` 省略或 `=1` 的檢查用法照舊不需 key。）

## 驗證方式

```bash
cd worker && npm run dev            # 本機 Worker
cd worker && npm run deploy         # 手動部署（正常情況不需要，見下）
cd worker && npm test               # 注意：只跑 test/parity.mjs
node test/sentinel.mjs              # 其餘 30 支要個別跑（離線、免 token；2026-10-23 實查 worker/test/*.mjs 共 31 支，
                                    #   tickdiag.mjs 已隨 tick 班刪除，新增 routing.mjs／adminkey.mjs）
for f in test/*.mjs; do node "$f" || echo FAIL $f; done   # 一次跑完全部（同 worker-deploy.yml 的 glob）
npx wrangler tail                   # 線上即時觀測 scheduled 事件成敗
```

**Worker 已自動部署**（2026-08-11 起，`worker-deploy.yml`）：push 到 main 且動到 `worker/**`
就跑 `worker/test/*.mjs` 全部（glob，新增測試自動納入、不寫死支數），全綠才 `wrangler deploy`。
所以改 Worker 不再需要手動部署，push 即完成交付。
需 repo secrets `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`（缺任一會在第一步就明確報錯）。
測試是離線 mock，擋得住語法與邏輯回歸，擋不住「mock 對但 workerd 實際行為不同」的問題。

密鑰全走 `wrangler secret put`、不寫檔：`FINMIND_TOKEN`、`GH_DISPATCH_TOKEN`
（fine-grained PAT，對 **taiwan-flows／postmkt／taiwan-stock-news ＋本 repo taiwan-flow-live-v2
四個 repo** Actions 讀寫）、`ALERT_WEBHOOK`、`LINE_TOKEN`、`LINE_USER_ID`、`ADMIN_KEY`（2026-10-23，管理端點認證，見同名節）。

> **2026-08-09 更正**：本段原寫「對 taiwan-flows／postmkt／taiwan-stock-news **三** repo」，
> 漏了本 repo。**依據是程式碼與 2026-07-22 線上實測記載的「推論」，不是直接驗證**
> （直接證據是 GitHub run 歷史顯示 dispatch 回 204，本機無 `gh` CLI 也無憑證，查不到）：
> `worker/src/index.js` 有多處對本 repo 的 dispatch 前例——
> `const MORNING_REPO` 值即 `taiwan-flow-live-v2`（dispatch `morning.yml`）、
> `export function backupPipelines` 內 daysummary／aetf／baseline／us／intraday 五條的 `repo`
> 皆為 `taiwan-flow-live-v2`、`async function runAetf2` 與 `export async function runCardsRender`
> 直接以字面量 `"taiwan-flow-live-v2"` 呼叫 `async function ghDispatchWithRetry`，全部走同一支
> `env.GH_DISPATCH_TOKEN`。而 `PROJECT_SUMMARY.md`「Worker 升格全系統主排程」段記載 2026-07-22
> 首日實測「全班 workflow_dispatch 主觸發準點、conclusion 全 success」——token 若不含本 repo，
> 這些班會全數 HTTP 404/403 並走 `async function ghDispatch` 的 throw 分支。
> 結論方向不變：**「原本只有三個 repo」明確不成立，本 repo 權限早已具備，只是文件沒跟上**。
> **真正的直接驗證要等第一次 `cards.yml` dispatch 回 204**（`export async function runCardsRender`
> 上線後的第一個交易日晚上，`npx wrangler tail` 或 GitHub run 歷史看得到）。
> `worker/wrangler.toml` 的 Secrets 註解同批更正。

## 已知限制／坑

1. KV **list** 免費版僅 1000 次/日、曾爆額度；改用時間索引 key 讓 `pickFrames` 只用
   get（見 `PROJECT_SUMMARY.md`「三、關鍵技術決策與踩過的雷」表「KV 額度」列）。
2. 告警由 Worker 自己發，**Worker 整個掛掉時發不出**
   （見 `PROJECT_SUMMARY.md`「快速接手」的「排程可靠度補強」段）。
   **這條本身仍成立，但盲區已由外部補上（2026-09-06）**：`claude-harness/tools/freshness_watchdog.py`
   ＋`.github/workflows/freshness-watchdog.yml`（台北 23:45／09:00 兩班）**跑在 GitHub Actions、
   不依賴本 Worker**，只讀公開資料判各站資料新鮮度，連本站 `/status` 打不通也會單獨列
   UNREACHABLE，失敗走該 repo 的 `notify-failure` 開 issue。兩邊**互為盲區補位、並存不取代**
   ——Worker 掛了只有它看得到，GitHub Actions 故障時只有 Worker 的健檢班看得到。
3. 2026-07-24 盤中 frame 班整天沒落格：`series:<date>` 是 TW 班的交易日守門，
   缺它會讓**所有 TW 主觸發被靜默跳過**（見 `PROJECT_SUMMARY.md`「快速接手」的
   「2026-07-24（週五）盤中 frame 班整天沒落格」段）。根因是 CF cron dow 為 Quartz 慣例
   （`1-5`＝週日~週四）導致週五整天不觸發，**已於 2026-07-31 定案部署（version `f13ab220`）、
   08-02 與 08-07 兩次驗收通過**（見同段上方的「✅ 已結案：CF cron dow 慣例錯誤」段）。
4. 版控曾發生 force-push 誤刪 98 commit 事故並救回
   （見 `PROJECT_SUMMARY.md`「三、關鍵技術決策與踩過的雷」表「版控」列）。
5. **`/live` 的 `ts` ＝指數列時戳，日期部分可當資料日（✅ C 案已落地，2026-09-08）**——
   本條原為「`ts` 日期不可當資料日」的坑，語意改造後坑已填掉，保留為變更紀錄：
   - **舊語意（已作廢）**：`ts`＝有分類非指數個股 `max(date)`。三種雜訊會把它推離收盤——
     ETN/權證（`e` 為 `ETN`／`所有證券`）、興櫃（交易到 15:00）、上市櫃盤後定價交易
     （14:30 撮合）；非交易日更會是**盤前殘留**（2026-08-30 週日實打得
     `ts="2026-08-29 08:30:00.000000"`，**週六**，內容卻是週五 08-28 收盤——日期部分
     既非內容資料日也非當日）。
   - **新語意（現行）**：`ts` ＝指數列 `001` 的 `date`；`001` 取不到退 `101`；兩者皆缺回
     `null`；`001`≠`101` 時取 `001`（理由：前端頂列與 `/status` 的 live 都是加權指數口徑）。
     指數列不參與個股盤後交易，結構上免疫於「資料列被盤後成交覆寫」機制。
     落點＝`worker/src/index.js` 的 `export function aggregate`；測試 `worker/test/livets.mjs`。
   - **`snap_ts` 是拆分後的內部欄位**（前置 commit `24bd59a`／`af52687`）：值＝**舊口徑
     max(date)**、算法逐字未動，供 `pickFrames`／`computeFlow` 的 `nowTs`／`series:<date>`
     使用，**不進對外 JSON**。所以改 `ts` **不會**動到 frame 定位、收盤殘影判定
     （`framesDegenerate`，門檻 `CLOSE_MIN`=13:30）、上游停滯守門。
     隔離證明 `worker/test/snapts.mjs`（正反雙向突變，改 `ts` 那批不得修改該檔）。
   - **`ts` 可能為 `null`**（兩列指數皆缺）：前端閘門已於 2026-09-05 放寬——`state.live`
     賦值改看 `j.stocks` 非空（不再看 `j.ts`），`ts` 缺失只讓「顯示時間」降級，
     全站不會停在「載入中」。下游 `flowLastPayload` 有 `String(live.ts || "")` 守門不拋錯。
   - **量測管道仍在**：`GET /livediag`（`export function tsDiag`）的 `ts_current` 是
     **診斷對照組、語意固定為舊口徑 max(date)**，不隨 `/live` 改；另吐逐列時戳分桶直方圖、
     正規盤時窗 max、指數列 `001`/`101` 的 date。**刻意不列進根路徑 `endpoints` 清單**；
     節流 30 秒/次、每 isolate 每台北日 60 次、**不寫 KV、不碰 `/live` 的 cf 快取**。
   七筆觀測、三案並列評估與使用者裁示全文見 `PROJECT_SUMMARY.md`
   「/live 資料時間改取 max(date)」段。
6. **`/live` 的 stale-while-revalidate：去重已做（2026-09-06），TTL 待量測後定**：
   原問題——`rebuild` 每次被呼叫都各自跑一次 `buildLive`，stale 區（`FRESH_MS` ≤ age <
   `LIVE_STALE_MS`）的並發請求各自觸發一次重建、互不合併；且前端 `index.html` 的
   `CFG.autoSec:20` 大於 `worker/wrangler.toml` 的 `LIVE_TTL = "15"`，單一客戶端每輪都落
   stale 區。**已修**：`/live` 路由抽成 `export async function serveLive`（`worker/src/index.js`，
   grep `function serveLive`），isolate 內模組級 `liveRebuildInflight` 讓 stale 背景刷新與
   cache-miss 同步重建共用同一份 in-flight promise（成功／失敗都清空，失敗後下一請求可重試）。
   **量測（不寫 KV）**：`GET /livediag` 回應新增 `swr` 欄位＝`export function liveSwrStats`
   吐出的 **isolate 級**計數 `{rebuilds, rebuildFails, staleHits, freshHits, misses, coalesced,
   lastRebuildMs, lastGen, inflight}`（isolate 重啟歸零、多 isolate 各自一份，只能看趨勢）；
   `/live` 回應另帶 header `x-swr: fresh|stale|miss`（與既有 `x-gen` 並列）。
   **`LIVE_TTL` 刻意未動**：先看 `coalesced / rebuilds` 與 `staleHits / freshHits` 比例，再依
   優化計畫批次二 #9 決定 25／30。測試 `node test/swr.mjs`（mock buildLive／cache／時鐘）。
   **讀 `swr` 的實務陷阱（2026-09-07 線上實打）**：計數是 isolate 級，而 `/livediag` 的請求
   **經常落在與服務 `/live` 不同的 isolate**——實測連打 8 次 `/live`（header 明確回 1 次 `miss`
   ＋7 次 `fresh`，證明 Worker 每次都有跑）後立刻打 `/livediag`，`swr` 仍全 0；同樣手法重複三輪，
   只有第三輪抓到 `freshHits: 2`（另一輪撞上 30 秒節流、回應根本沒有 `swr` 欄位）。
   **所以單次讀到全 0 不代表 SWR 沒作用**，那只是抓到冷 isolate。要判 `LIVE_TTL` 必須在
   **交易時段**（有真實客戶端輪詢時）多次取樣看趨勢，非交易時段打出來的比例沒有代表性。

   **「先量不動」的可執行量法（2026-09-13 使用者裁定：`LIVE_TTL` 先量、這批不動）**——
   上面兩段只說了「要量」與「怎麼讀錯」，沒說**量到什麼才算夠、怎麼算**，補在這裡，
   免得下一個 session 又從頭討論一次：
   - **兩個比例**（都出自 `/livediag` 的 `swr`，`export function liveSwrStats`）：
     ① **stale 佔比**＝`staleHits / (staleHits + freshHits)`——回答「客戶端有多常落在 stale 區」。
     前端 `CFG.autoSec:20` > `LIVE_TTL`(15)，單一客戶端理論上每輪都落 stale；這個比例是**實證**，
     不是拿兩個常數相減推出來的。
     ② **合併率**＝`coalesced / rebuilds`——回答「in-flight 去重到底合併掉多少次重建」。
     比例高＝併發確實存在、`serveLive` 那層在做事；比例接近 0 有兩種可能（真的沒併發／
     取樣落在冷 isolate），**要靠下一條才分得開**。
   - **取樣時段：只有台北 09:00–13:30 的樣本算數**。非交易時段沒有真實客戶端輪詢，
     比例的分母幾乎全是自己打進去的請求，**沒有代表性**（不是「比較不準」，是問錯問題）。
   - **取樣次數：單次讀數一律不採信，至少要三輪以上、每輪間隔數分鐘**。理由就是上一段那個
     已實測的陷阱——連打 8 次 `/live` 後立刻打 `/livediag` 仍可能全 0，三輪只有一輪抓到。
     **判讀規則：多輪中取「有抓到非零計數」的那些輪來看比例，全 0 的輪是冷 isolate、丟棄不計**，
     不可把全 0 的輪當成「比例＝0」平均進去。另注意 `/livediag` 有 30 秒節流，被擋時回應
     **根本沒有 `swr` 欄位**（不是 `swr` 全 0），那種回應也要丟棄。
     **但「丟棄全 0 的輪」本身有選擇偏誤，用它的人要知道**：留下的是「診斷請求剛好落在忙碌
     isolate 時」的比例，不是全隊平均。忙 isolate 的併發本來就比冷的多，所以合併率會**偏高**、
     stale 佔比也未必代表全體客戶端。這兩個比例只能當**量級**看（有沒有在做事、大概幾成），
     不能當精確估計；沒有跨 isolate 的彙總就拿不到全隊比例，而為此加一個常駐彙總班不划算
     （同下一點「刻意不自動化」的立場）。
   - **量到之後才輪到決定 25／30**（優化計畫批次二 #9）。**在那之前任何調整都是猜**——
     `LIVE_TTL` 直接決定 `/live` 的 cf 快取行為，猜錯的代價是線上，而量它不用改任何程式。
   - **這件事目前沒有自動化**：沒有排程在收這兩個比例，也刻意不加（為了量一個一次性的決策
     而長出一個常駐班不划算，同 tick 量測班（已拆除）的教訓）。要量就是人去打，把數字記回這一節。
     **2026-09-30 補：已提供手動觸發的量測 workflow，仍刻意不排程**——`.github/workflows/measure-live-swr.yml`
     （workflow 名 `measure-live-swr`，**只有 `workflow_dispatch`**，`permissions: contents: read`、不 commit、
     不需 secret、不掛 notify-failure）跑 `tools/measure_live_swr.py`。
     **⚠ 機房偏差（同日驗收指出，依 Cloudflare 架構推論、未實測 cf-ray）**：isolate 與 `caches.default` 各機房
     各自一份，GitHub runner 出口在美國、打到的是美國機房的 isolate，幾乎碰不到台灣客戶端——**從 Actions 跑只能當
     連通性檢查，比例不代表線上**。**真實量測請在台灣本機、台北平日 09:00–13:30 執行 `python tools/measure_live_swr.py`**
     （免 secret、只讀）。窗外預設只量一輪並標「無代表性」（`--force` 才照設定輪數跑，仍標無代表性）。
     每輪預設**只打 1 次 `/livediag`**（`--live-per-round` 預設 0）：若先打 `/live` 且落在同一 isolate，冷 isolate
     會因自己的請求被誤採計、3 秒間隔的請求多為 fresh 又會把 stale 佔比往下拉（**自我污染**），所以要 >0 得明確指定，
     摘要會另印警語。輸出怎麼讀：job summary 與 log 的「`/live` SWR 量測摘要」列
     採計／丟棄（全 0／節流／錯誤）輪數、逐輪 ①stale 佔比 ②合併率與其中位數／範圍（`swr` 是 isolate 累計快照，
     **各輪不相加**）、另列 runner 自己看到的 `x-swr` 標頭 fresh/stale/miss 分布（與 isolate 計數分開）；末行
     `JSON {...}` 供機器讀。上面那條選擇偏誤照樣成立，摘要會印警語。離線測試 `tests/test_measure_live_swr.py`。
   - **✅ 已量、已裁定（2026-10-05，使用者裁定 `LIVE_TTL` 維持 15，本項結案）**：
     ①**10-02 只打 `/livediag` 的量法失敗**——台灣本機（PowerShell）盤中 8 輪全 0、採計 0 輪：診斷請求一直落在沒服務過
     `/live` 的 isolate；以目前流量（推論：盤中使用者極少）這種「抽查 isolate 計數」**量不到東西**，再跑也一樣。
     ②**10-05 改模擬單一客戶端**（手機 Termux 本機，`cf-ray` 實測 `-TPE`；13:08:36 開始，
     `--rounds 1 --live-per-round 20 --live-gap-sec 20`）：客戶端自己看到的 `x-swr` 為 **stale 17／fresh 3（85%）**；
     同輪 `/livediag` 剛好落在服務它的 isolate，累計 rebuilds 41／staleHits 40／freshHits 8／misses 2／coalesced 1
     ＝**stale 佔比 0.83、合併率 0.024**（含本工具自己的 20 次請求，只當量級）；`/live` 耗時中位數 329 ms。
     **讀法**：前端 20 秒輪詢 > TTL 15 秒 → 幾乎每次輪詢都走 stale 並觸發一次背景重建（每個開著頁面的客戶端
     盤中約 3 次／分），畫面資料約落後 20 秒；併發重建幾乎不存在，`liveRebuildInflight` 去重在目前流量下派不上用場。
     **TTL 只有 15 與 25 兩個實質選項**（依程式邏輯推算、未實測）：20 秒輪詢下 25 與 30 都是「隔一次重建一次」
     （重建約減半、資料平均落後約 30 秒、最多約 40 秒），要再少得 ≥40。**維持 15 的理由**：使用者極少、總重建量小，
     未見 FinMind 額度或延遲壓力；改 25 只換到重建減半、代價是資料平均再晚約 10 秒。**日後若 FinMind 額度吃緊或使用者
     變多再改 25**（不考慮 30）。`measure-live-swr.yml`／`tools/measure_live_swr.py` 保留（手動、不排程）。
7. **哨兵 dispatch 失敗與 secret 缺失：已接告警（2026-09-06）；獨立看門狗仍未做**：
   `export async function runSentinel` 內 `ghDispatch` 的 catch 現已接 `alertJob`（tag
   `sentinel-err-<signal>`，沿用每日每 tag 一則的 KV 去重；KV 仍不記、5 分後照舊重試）。
   `runSentinel`／`dispatchNews` 開頭 secret 缺失原為安靜 return，現走
   `export async function alertSecretMissing`（tag `secret-missing-sentinel`／`secret-missing-news`，
   每日一則）——但 `alertJob` → `sendAlert` 本身也靠 secret，**告警通道（`ALERT_WEBHOOK`，或
   `LINE_TOKEN`＋`LINE_USER_ID`）也缺時只 `console.error` 並 return、不呼叫 `alertJob`**
   （避免白寫去重鍵把當日唯一一則用掉；`export function alertChannelReady` 判定）。
   `runSentinel` 加了第三參數 `fetchFn`（探測／dispatch／告警共用，供測試注入），生產呼叫不變。
   測試 `node test/sentinel.mjs` 有 dispatch 401／204、secret 缺失有／無通道四組案例。
   **~~仍未做~~ 已做（2026-09-11 實查更正）**：「獨立於 Worker 的低頻 GH cron 看門狗」
   （原列優化計畫批次二 #11）**早在 2026-09-06 就上線**——`claude-harness/tools/freshness_watchdog.py`
   ＋`freshness-watchdog.yml`，見已知限制第 2 條的補述。**本段原文「仍未做」是過期敘述**：
   該 repo 的 `CLAUDE.md` 同時期就寫了「與本站 Worker 健檢班互為盲區補位」，只有本檔沒跟上。
   （**它補的是「Worker 掛掉時沒人告警」這個盲區**，不等於本節 `runSentinel` 的 dispatch 失敗
   告警可以拿掉——後者是分鐘級、前者是每日兩班，粒度不同。）
