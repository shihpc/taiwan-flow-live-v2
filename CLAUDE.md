# CLAUDE.md — taiwan-flow-live-v2 接手速覽

<!-- CANON:BEGIN v1 -->
<!-- 唯一事實來源＝shihpc/claude-harness 的 CANON.md。以下區塊在五個 repo 的 CLAUDE.md 頂端
     有 byte-identical 逐字副本，由各 repo 的 .github/workflows/canon.yml 守門（比對 sha256）。
     改動流程：先改 claude-harness/CANON.md → 跑 tools/sync_canon.py 同步五份 → 更新守門 hash。
     不要只改單一 repo，CI 會擋下來。 -->

## 通用工作鐵律（五個 repo 逐字相同，勿單獨修改）

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
8. **新指標／訊號若會影響投資方向、候選排序、進出場或風險判定，先問有沒有回測依據**，沒有就
   先驗證再上線；純描述性顯示（欄位、日期、圖示）只需驗算式正確。市場內容可做情境判讀與多空
   因素分析，可研判市場與大眾情緒對該數值或新聞的可能反應，並可提供具體個股／標的的買賣建議
   與進出點位；以上均須附依據、區分事實與推論，並標明屬 AI 研判而非保證。
9. **語言**：對話與文件用繁體中文；程式碼註解可中文，identifier 用英文；外部原文、API 名稱、
   指令與錯誤訊息保留原樣。

> 判準細則、派工模板、教訓簿見 `shihpc/claude-harness`（private）。雲端 session 需 add_repo 才讀得到。
<!-- CANON:END v1 -->

台股盤中即時資金流向監控站，同時是「股市雷達」四站家族的**資料中樞**
（見 `PROJECT_SUMMARY.md`「一句話說明」段）。線上 https://shihpc.github.io/taiwan-flow-live-v2/ 。
前端是單檔 `index.html`（184KB，2026-09-06 實測 188,281 bytes），7 個 tab：即時一覽／產業別／產業鏈／成交佔比／
資金湧入／資金退出＋摘要分析（`index.html` 的 `<div class="tabs" id="tabs">` 區塊，
一個 tab 一個 `data-tab` 值）。
**`PROJECT_SUMMARY.md`（143KB，2026-09-06 實測 146,133 bytes）是本專案主記憶，接手先讀它**（「快速接手」段有未解問題）。
前端有兩組跨站同步碼：**三站逐字同步**的 `callClaude`／`mdToHtml`／`linkifyStocks`／
`ghSaveAnalysis`／`sumCtx*` 與費用估算 `insightCostText`／`INSIGHT_PRICES`／`USD_TWD`
（`index.html:727-749`）；**四站同步但非逐字**的 `loadSiteVer()`＋footer `#siteVer`
（`index.html:172`、`:2539`，本站 sessionStorage key `tf2_site_ver`，打
`api.github.com/repos/shihpc/taiwan-flow-live-v2/commits/main`，免金鑰、限 60 req/hr/IP，
失敗靜默隱藏）。清單正本在 `postmkt/CLAUDE.md`「不可破壞的約定」第 2 條。

## 佈局

- `src/` Python 夜間 builder（morning/aetf/baseline/daysummary/us/intraday…）；
  `worker/` Cloudflare Worker（`src/index.js` 單檔＋`wrangler.toml`＋`test/` 21 支 `.mjs`）；
  `data/` 產出 JSON（姊妹站上游）；`backtest/`；`.github/workflows/`
  （**14 支**＝帶 cron 10 支：9 支排程 builder（aetf／baseline／cards／daysummary／intraday／
  lastweek／meta／morning／us，多為 Worker 主觸發的兜底備援）＋`backtest-regen.yml`
  （每月 1 日重生比對班）；無 cron 4 支：`backtest.yml`（離線煙霧＋規格守門）、
  `canon.yml`（守 CLAUDE.md 頂端 CANON 區塊）、`pages.yml`（部署）、
  `worker-deploy.yml`（動到 `worker/**` 即跑全部測試後 `wrangler deploy`））
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
- `evening` 晚場協調班：台北 21:00–23:55 每 5 分，串 pm summary → diag → mktbal → aetf2
- `health` 健檢班：台北 23:50（`eve`）、09:30（`morn`），只盤點產物落地與否、不 dispatch。
  低頻班 `lastweek`／`meta` 於 2026-08-30 納入 `eve`（`mode:"lowfreq"`，判準 `export function lowFreqDue`）：
  **只在台北週一檢查**（meta 另要求已過本月第一個週六＋2 天），非檢查日整項濾掉不抓也不告警；
  **刻意不納 `backupPipelines`、不新增 CF cron**（使用者裁定，理由見 `PROJECT_SUMMARY.md` 同段）
- `summary-am` 窗（06:50–08:50）另掛晨場協調班 `export async function runMorning`（見下節）
  ＋us 晨間補跑 `export async function runUsCatchup`（2026-08-13：台北 07:00–08:05 檢查
  us.json 資料日是否達最近預期美股交易日（`export function lastExpectedUsTradingDate`，
  台北二~六＝昨日、日/一＝上週五、美國假日不處理），未達即 dispatch `us.yml`
  inputs.rounds=2；KV 20 分時段桶 dedup、週日/週一晨不跑、08:05 後不觸發。
  動機：FinMind 美股常態 07:30–08:30 才入庫，05:05 主班 12 輪×10 分在 06:59 耗盡
  搆不到入庫窗。us 的 recheck／晨間健檢判準同步由 genToday 改資料日（mode `usDate`））

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

## /status 全系統資料健康端點（2026-08-11，新資料規範 schema:1 首例）

`GET /status` 回五站（live／flows／news／brief／postmkt）的 `data_date`／`updated_at`／
紅黃綠 `level`（`export async function buildStatus`，cf 快取 5 分）。來源：live 讀本站 KV
`fi:<date>` frame 索引；flows 抓 `taiwan-flows/data/status.json`（小檔）；news／brief 抓
`taiwan-stock-news` 的 `news.json`／`daily-brief-card.json`；postmkt 因 `postmkt.json` 逾
1.6MB，以 **Range 只取檔頭** regex 撈 date/generated_at。判級為純函式（`gradeMarket`／
`gradeNews`／`gradeBrief`，台北時區、**國定假日不處理**）；單站失敗只染紅該站不垮端點。
測試 `node test/status.mjs`。

## 資料是姊妹站上游（跨站變更）

`taiwan-stock-news` 讀 `data/morning.json`；`postmkt` 讀 `data/aetf/latest.json`（含
`stocks[code][3]` 市值欄）。**改輸出格式屬跨站變更**
（見 `PROJECT_SUMMARY.md`「五、目前待辦與已知限制」）。

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

**日期／時戳欄位語意一律查 `postmkt/docs/date-semantics.md`**（跨五站的唯一對照表）。
其中 Worker `/live` 的 **`ts` 不是「資料時間」也不是產出時刻**，而是「全體有分類個股中最後一筆
成交的時戳」——FinMind 原字串、**無時區標記**、收盤後會被盤後定盤/零股推進到 14:30–15:00、
非交易日可能是當日盤前殘留值（日期與內容資料日不符），**不可拿它的日期部分當資料日**；
同 payload 的 `generated_at` 才是我方產出時刻（`toISOString()`＝**UTC `Z`**，非台北）。
改 `ts` 語意＝改 `/live` 回傳值，屬待裁決的 C 案（見 `PROJECT_SUMMARY.md` 該條目），勿逕自動手。

## 驗證方式

```bash
cd worker && npm run dev            # 本機 Worker
cd worker && npm run deploy         # 手動部署（正常情況不需要，見下）
cd worker && npm test               # 注意：只跑 test/parity.mjs
node test/sentinel.mjs              # 其餘 20 支要個別跑（離線、免 token；2026-09-06 實查 worker/test/ 共 21 支）
npx wrangler tail                   # 線上即時觀測 scheduled 事件成敗
```

**Worker 已自動部署**（2026-08-11 起，`worker-deploy.yml`）：push 到 main 且動到 `worker/**`
就跑 `worker/test/*.mjs` 全部（glob，新增測試自動納入、不寫死支數），全綠才 `wrangler deploy`。
所以改 Worker 不再需要手動部署，push 即完成交付。
需 repo secrets `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`（缺任一會在第一步就明確報錯）。
測試是離線 mock，擋得住語法與邏輯回歸，擋不住「mock 對但 workerd 實際行為不同」的問題。

密鑰全走 `wrangler secret put`、不寫檔：`FINMIND_TOKEN`、`GH_DISPATCH_TOKEN`
（fine-grained PAT，對 **taiwan-flows／postmkt／taiwan-stock-news ＋本 repo taiwan-flow-live-v2
四個 repo** Actions 讀寫）、`ALERT_WEBHOOK`、`LINE_TOKEN`、`LINE_USER_ID`。

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
3. 2026-07-24 盤中 frame 班整天沒落格：`series:<date>` 是 TW 班的交易日守門，
   缺它會讓**所有 TW 主觸發被靜默跳過**（見 `PROJECT_SUMMARY.md`「快速接手」的
   「2026-07-24（週五）盤中 frame 班整天沒落格」段）。根因是 CF cron dow 為 Quartz 慣例
   （`1-5`＝週日~週四）導致週五整天不觸發，**已於 2026-07-31 定案部署（version `f13ab220`）、
   08-02 與 08-07 兩次驗收通過**（見同段上方的「✅ 已結案：CF cron dow 慣例錯誤」段）。
4. 版控曾發生 force-push 誤刪 98 commit 事故並救回
   （見 `PROJECT_SUMMARY.md`「三、關鍵技術決策與踩過的雷」表「版控」列）。
5. **`/live` 的 `ts` 日期不可當資料日**（2026-08-30 實打再證）：週日 08-30 打線上 `/live` 得
   `ts="2026-08-29 08:30:00.000000"`（**週六**），內容卻是**週五 08-28** 收盤——日期部分
   既非內容資料日也非當日；收盤後 `ts` 又會被盤後定盤/零股推進到 14:30–15:00。
   使用者已裁定要改（C 案），2026-09-05 已鋪好前置條件、**但 `ts` 語意本身仍未改**：
   - **量測管道**：`GET /livediag`（唯讀診斷，`worker/src/index.js` 的 `export function tsDiag`）
     吐逐列時戳 `HH:MM` 分桶直方圖＋現行 `max(date)`＋正規盤時窗（09:00–13:30）max
     ＋指數列 `001`/`101` 的 date。**刻意不列進根路徑 `endpoints` 清單**；
     節流 30 秒/次、每 isolate 每台北日 60 次、**不寫 KV、不碰 `/live` 的 cf 快取**。
   - **前端閘門已放寬**：`state.live` 賦值改看 `j.stocks`（不再看 `j.ts`），`ts` 為 null
     只讓「顯示時間」降級，全站不再停在「載入中」——原本的硬阻斷已解除。
   **動 `aggregate` 的 `ts` 前先讀** `PROJECT_SUMMARY.md`「/live 資料時間改取 max(date)」段的
   「量測管道已建好：`/livediag`」條——那裡有**要觀察什麼／觀察到什麼才能決定 (甲)(乙) 改法**的表格。
6. **`/live` 的 stale-while-revalidate 重建無 in-flight 去重（2026-09-06 分析發現，尚未修）**：
   `worker/src/index.js` 內 `const FRESH_MS` 附近的 `const rebuild` 每次被呼叫都各自跑一次
   `buildLive`，多個落在 stale 區（`FRESH_MS` < age < `STALE_MS`）的並發請求會**各自觸發一次重建**、
   互不合併；且前端 `index.html` 的 `CFG.autoSec:20` 大於 `worker/wrangler.toml` 的
   `LIVE_TTL = "15"`，**單一客戶端每次輪詢都必落 stale 區、每次都觸發背景重建**——快取實際上
   只擋得住 15 秒內的第二個客戶端。修法（先量測 rebuild 次數／上游成敗／快照年齡／併發 →
   加 in-flight 去重 → 再以資料選 TTL 25／30）列於 claude-harness
   `docs/site-optimization-plan-20260906.md` 批次二 #9，動手前先讀。
7. **哨兵 dispatch 失敗只 log、不告警（2026-09-06 分析發現，尚未修）**：
   `function runSentinel` 內 `ghDispatch` 的 catch 分支只 `console.log`、**未接 `alertJob`**
   （對照同檔 `backupPipelines`／summary／cards 各班的 catch 都有接 `bk-err-*`／`sum-err-*`
   等告警）；另 `runSentinel` 開頭 `!env.GH_DISPATCH_TOKEN || !env.FINMIND_TOKEN` 時為**安靜
   return**，secret 缺失整晚不觸發也無任何訊號，只能靠下游 GH cron 兜底。修法列於同上文件
   批次二 #11（哨兵 catch 接 `alertJob`＋獨立於 Worker 的低頻 GH cron 看門狗）。
