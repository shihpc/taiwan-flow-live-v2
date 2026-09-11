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
  `worker/` Cloudflare Worker（`src/index.js` 單檔＋`wrangler.toml`＋`test/` **25 支** `.mjs`；
  2026-09-09 `ls worker/test/*.mjs` 實查，取代舊記的 22 支）；
  `data/` 產出 JSON（姊妹站上游）；`backtest/`；`.github/workflows/`
  （**14 支**＝帶 cron 10 支：9 支排程 builder（aetf／baseline／cards／daysummary／intraday／
  lastweek／meta／morning／us，多為 Worker 主觸發的兜底備援）＋`backtest-regen.yml`
  （每月 1 日重生比對班）；無 cron 4 支：`backtest.yml`（離線煙霧＋規格守門）、
  `canon.yml`（守 CLAUDE.md 頂端 CANON 區塊）、`pages.yml`（部署）、
  `worker-deploy.yml`（動到 `worker/**` 即跑全部測試後 `wrangler deploy`））。
  **14 支全裝 notify-failure（2026-09-06 覆驗）**：`.github/actions/notify-failure/action.yml`
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
- `evening` 晚場協調班：台北 21:00–23:55 每 5 分，串 pm summary → diag → mktbal → aetf2
- `health` 健檢班：台北 23:50（`eve`）、09:30（`morn`），只盤點產物落地與否、不 dispatch。
  低頻班 `lastweek`／`meta` 於 2026-08-30 納入 `eve`（`mode:"lowfreq"`，判準 `export function lowFreqDue`）：
  **只在台北週一檢查**（meta 另要求已過本月第一個週六＋2 天），非檢查日整項濾掉不抓也不告警；
  **刻意不納 `backupPipelines`、不新增 CF cron**（使用者裁定，理由見 `PROJECT_SUMMARY.md` 同段）
- `ticksample` 台指期 tick 量測班（2026-09-09，**暫時班，見下節的拆除條件**）：台北平日
  09:00–19:55 每 5 分（CF cron `*/5 1-11 * * 2-6`，`export const TICK_CRON`），
  `export async function runTickSample` 抓一次 FinMind `TaiwanFuturesTick`(TX) 當日檔、
  摘要成一筆寫 KV `tick:<YYYYMMDD>:<HHMM>`（TTL 7 天），**不 dispatch、不接哨兵、不下任何判準**。
  ★ 這條**必須由 `dispatchRoleForCron` 最先攔截**，落到 `scheduledRole` 會變成 96 個 `frame`
  （台北 09:00–16:55，其中 09:00–13:59 的 60 個還與 frame cron 搶同一把 `f:<date>:<HH:MM>`）
  ＋36 個 `sentinel`（17:00–19:55 每 5 分多跑一次 `runSentinel`）。
- `summary-am` 窗（06:50–08:50）另掛晨場協調班 `export async function runMorning`（見下節）
  ＋us 晨間補跑 `export async function runUsCatchup`（2026-08-13：台北 07:00–08:05 檢查
  us.json 資料日是否達最近預期美股交易日（`export function lastExpectedUsTradingDate`，
  台北二~六＝昨日、日/一＝上週五、美國假日不處理），未達即 dispatch `us.yml`
  inputs.rounds=2；KV 20 分時段桶 dedup、週日/週一晨不跑、08:05 後不觸發。
  動機：FinMind 美股常態 07:30–08:30 才入庫，05:05 主班 12 輪×10 分在 06:59 耗盡
  搆不到入庫窗。us 的 recheck／晨間健檢判準同步由 genToday 改資料日（mode `usDate`））

## 台指期 tick 量測班與 `/tickdiag`（2026-09-09，**暫時班，拆除條件見下**）

**只量測、不下判準。** 動機：未來若要把台指期 tick 接進哨兵，需要一個「日盤真的收完了」的判準，
而現有的兩個直覺判準都**已知不成立**——FinMind 日曆日 D 的 TX tick 檔**同時含三段**
（D 的 00:00–05:00 夜盤延續／08:45–13:45 日盤／15:00–24:00 當日夜盤），所以
①`rows.length > 0` 早在台北 09:00 就為真（夜盤段先在檔裡）→ 假陽性；
②連 `max(time) >= "13:44"` 也不安全——15:00 之後的當日夜盤列同樣滿足它。
分辨只能看**分段**的列數與時間邊界，而那個分布**沒有人量過**（既有觀測只有台北 16:54 的一筆，N=1，
且那筆只存在於對話、不在版控裡）。故先蒐集原始分布，判準留待有資料再定。

- **CF cron 由 19 條增為 20 條**（`worker/wrangler.toml` 第 20 條 `*/5 1-11 * * 2-6`，
  需與 `export const TICK_CRON` 逐字一致）：台北平日 09:00–19:55 每 5 分＝**132 slot/交易日**。
  **窗必須含上午**，否則「夜盤段是否先落地」驗不到。程式端二次守門在
  `export async function runTickSample`（非平日／時窗外／缺 token 或 KV binding 一律不採樣）。
- **同分撞點 9 條**（逐分鐘展開比對）：`* 1-5`（frame）60、`*/5 9-14`（哨兵）36、
  `35 5`／`5 6`／`40 6`／`10 7`／`35 10`／`0 11` 各 1、`30 1`（晨間健檢）1。
  各帶自己的 `event.cron`，`dispatchRoleForCron` 精確比對先攔截（後果見上節 `ticksample` 條）。
- **樣本欄位**（`export function summarizeTickRows` 是純函式、可離線測）：
  `seg.a`/`b`/`c`＝三段列數（門檻 08:00／14:00）、`d13`＝`time∈[13:44,14:00)` 的列數
  （＝「日盤收盤段」的直接量測值）、`mn`/`mx`＝原始時間字串字典序極值、`tk`＝實際偵到的時間欄位名、
  `bytes`/`clen`/`ms`＝payload 大小與耗時、`st`＝HTTP status（`0`＝fetch 本身例外）。
  **讀樣本前先看 `tk`**：`tk` 為 `null` 時三段一律 0 但 `n` 仍是全部列數，那是「有列但量不到時間」、
  **不是**「當下真的沒有列」。**`n:0` 也不等於「真的沒有列」**——fetch 例外與 JSON 壞掉時
  `n` 同樣是 0，判讀順序是**先看 `err`／`skip`，都沒有時 `n:0` 才是真的沒列**；
  `skip` 非空時 `n` 為 `null`（未知）而非 0，`bytes` 在 `too-large:clen` 那關也是 `null`
  （body 從未讀取＝沒量到，**不是 0＝回應是空的**）。
  四種「`seg` 總和 < `n`」的成因逐條寫在 `summarizeTickRows` 上方註解。
- **鐵律 1 相關**：請求 URL 含 `token=<FINMIND_TOKEN>`，而 workerd 的 fetch 例外訊息**會帶 URL**
  （`TypeError: Fetch API cannot load: <url>` 是常見形狀——**這是推測、我方未實測**；
  原本引 cloudflare/workerd #1957 是**引錯了**，那張 issue 講的是前導空白 URL 的解析不一致），
  樣本又活 7 天且由**無認證**的 `/tickdiag` 對外吐出。
  故例外訊息一律過 `export function maskTickErr` 雙重遮罩（token 字面量替換＋`token=` 後綴遮罩；
  token 為空／過短時**跳過**字面量替換，否則 `split("")` 會把訊息炸成逐字元）後才寫 KV。
  **不可宣稱「兩道任一失效另一道必定有效」**——2026-09-09 覆驗構造出反例：token 同時含
  需百分比編碼的字元（使第一道失效）與 `'`／`)`（原本被當停止字元，使第二道提前停下）就會半遮。
  停止字元已收窄到只剩 `&` 與空白（寧可多遮）；對現行 JWT 形狀的 token 兩道都成立，
  但那是**目前的**事實不是結構保證，上游換發別種形狀要回來重看。
  **改這段前先跑 `node test/tickdiag.mjs`**，那裡有「注入含假 token 的例外、斷言 KV 值不含它」的測試。
- **尺寸閘門** `export const TICK_MAX_PARSE_BYTES`（20e6）**分兩關，順序是重點**：
  ①`skip:"too-large:clen"`——上游有給 `content-length` 且超標時，**在讀 body 之前**就短路
  （`bytes` 為 `null`＝從未讀取）。**這關才是真的擋 OOM 的那道**：真會打爆 isolate 的檔在
  `.text()` 當下就爆了，事後拿 `text.length` 判等於沒判（2026-09-09 覆驗退回的正是這點）。
  ②`skip:"too-large:text"`——上游沒給 `content-length`（chunked／被中介改寫）時的後備，
  body 已讀進來所以 `bytes` 有值，擋掉的是「字串與解析後物件同時常駐」那一半峰值。
  兩關**正常走完時**都不寫 `err`（**太大所以沒讀 ≠ 抓失敗**），`n` 一律 `null`。
  ——**不是無條件**（2026-09-10 覆驗構造出反例）：第一關短路的過程中若再拋例外
  （實測手法＝讓 `r.body` 的 getter 自己拋），樣本會同時帶 `skip` 與 `err`；那形狀反而更誠實，
  但敘述不能寫死。**判讀陷阱**：上游謊報一個很大的 `content-length` 時，第一關照樣短路，
  樣本與「檔案真的很大」**長得一模一樣**（`bytes:null`＋`clen` 很大＋`skip:"too-large:clen"`），
  **沒有欄位分辨得出來**——第一關觸發時 `clen` 只能當「上游宣告的值」，不能當實際大小。
  量測班不能把 Worker 打爆，而「大到不敢 parse」本身就是要量的答案之一。
- **`GET /tickdiag`**（唯讀樣本讀回）：`?date=YYYY-MM-DD`（非法值靜默退回台北今日）。
  三個性質與 `/livediag` 同一套——①**唯讀**，本路徑一個 put 都沒有；②**零 KV list**，
  key 由 `export function tickSampleSlots()` 依 cron 決定性重建（KV list 額度曾爆過，見已知限制 1；
  全檔 `.list(` 零命中有靜態測試守著，**連註解都不要寫出那個字面形式**）；
  ③**刻意不列進根路徑 `endpoints` 清單**。節流沿用 `/livediag` 那組 in-isolate 計數（兩者共用額度）。
  132 把 key 一次 get 完——額度歸屬是 **internal services 子請求上限（Free 1,000／Paid 預設 10,000）**，
  不是對外 fetch 那條（Free 50／**Paid 10,000，可調到 10M**）。KV get 另算進「同時 6 條等待回應」
  上限，132 把會**排隊**分批完成而非失敗，延遲未實測。
- **⚠ 這是暫時班，拆除條件（量到就回來動手）**：以下三個未知都拿到**跨多個交易日**的穩定分布後，
  這班就該收窄或整段移除，不要讓它長住——
  1. **日盤收盤段最早幾點拿得到**：`d13` 首次為正的時點在多日之間穩定下來；
  2. **夜盤段是否先落地**：`seg.a`／`seg.c` 相對 `seg.b` 的出現順序有定論（**這一項需要上午樣本**）；
  3. **單日 payload 量級與耗時**：`bytes`／`clen`／`ms` 的量級與尾端穩定。
  收窄＝把窗縮到真正有資訊量的那幾小時（改 `TICK_START_HOUR`／`TICK_END_HOUR` ＋ cron，兩邊同步）；
  移除＝拿掉第 20 條 cron、`ticksample` 分流、`runTickSample`／`/tickdiag`／`test/tickdiag.mjs`。
  **判準定案後才輪到「接哨兵」，那是另一批工作**（本批對 `SENTINEL_SIGNALS`／`signalLanded`／
  `runSentinel`／既有 19 條 cron 一個字都沒動）。

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
- **`primary_date` 會在台北午夜後跑到隔日（實測，這條會影響非 pm 窗的 `/cards/data`）**：
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

## /status 全系統資料健康端點（2026-08-11；2026-09-07 改六站＋時間感知判級）

`GET /status` 回**六站**（live／flows／news／brief／postmkt／backtest）的 `data_date`／
`updated_at`／紅黃綠 `level`（`export async function buildStatus`，cf 快取 5 分）。
**schema 形狀與欄位名不動**（`schema:1`，入口站 shihpc.github.io 與 claude-harness
`tools/freshness_watchdog.py` 共用這個資料面）；新站一律**附加在既有五站之後**，不改順序。
判級全是可測純函式、台北時區、**國定假日不處理**；單站失敗只染紅該站、不垮端點
（`Promise.allSettled`）。測試 `node test/status.mjs`。

**來源**：live 讀本站 KV `fi:<date>` frame 索引；flows 抓 `taiwan-flows/data/status.json`
（小檔）；news／brief 抓 `taiwan-stock-news` 的 `news.json`／`daily-brief-card.json`；
postmkt 因 `postmkt.json` 逾 1.6MB，以 **Range 只取檔頭**（`bytes=0-N`）regex 撈
date/generated_at；backtest 抓 `taiwan-backtest/walkforward/ledger.csv`，**是 CSV 不是 JSON
且逐日追加會一直長**，以 **Range 只取檔尾**（後綴範圍 `bytes=-4096`，`async function
fetchStatusTail`；2026-09-07 curl 實測 raw.githubusercontent.com 回 206＋
`content-range: bytes 55-174/175`，確認支援後綴範圍）再由 `export function extractTailDate`
由後往前取第一列 `YYYY-MM-DD,`。CDN 若忽略 Range 回 200 全檔，兩支都有串流回退、不整包載入。

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

**守門的次生效應（可接受的降級，2026-09-12 覆驗補記）**：若某日首班的 `build rrg frozen`
因網路等原因失敗、但同班 `build rrg base` 成功並 commit，則**該日任何補跑都會被守門擋下**
（磁碟上的 base 已含當日）→ 該日永遠不會有定格檔，停在前一日。**行為安全**——畫面自帶資料日、
會照實標示停在哪一天，且首次失敗已由紅燈＋issue 報出；要硬補只能手動 `--base` 指定當時那版。

**尚未發生過的事（下一個觀察點：2026-09-14 週一 14:10）**：`intraday.yml` **從未由排程正常
寫出過定格檔**——線上那份是以 `--base` 手動產的，唯一一次真實 run（`34623333645`）走的是
守門路徑。週一那班的磁碟 base 是週五版、不含 09-14，屆時應正常寫檔。

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
- **前端降級順序**（`function ovRrgHtml`）：**台北週末**（`function ovRrgTaipeiToday` 取星期，
  沿用 `liveStatus` 既有做法）直接走定格、連 `/replay` 都不打——降級②那兩句（「盤前時段」
  「盤中資料累積中」）依的是**牆鐘**，週末說出口是**假的斷言**（覆驗實測週六 00:15/03:00/09:10
  顯示「盤前時段」、09:30/09:56 顯示「盤中資料累積中」，定格檔請求 0 次）。**平日行為逐字不變**
  （措辭精確化，2026-09-12 覆驗實查：**不是「原始碼一行不動」**——平日分支內有 2 行變數提升
  （`const T=`→`T=`、`const {rows,valid}=`→`({rows,valid}=)`）；逐字未動的是兩句早退文案與
  `ovRrgEnsure`／`ovRrgAnchorMin`。**行為**不變的證據＝四情境 `#main` innerHTML 與 G1 之前逐字相同）
  （那兩句在平日是真的）：rows 為空 → 先試定格檔 → 定格檔讀不到／內容湊不出
  3 個可用取樣點才退回原降級③文案。**國定假日不處理**（同 `liveStatus` 立場），平日假日 10:01 前
  仍會看到「盤前時段」。用詞與 `liveStatus` 五值對齊：週末＝**休市定格**、其餘＝**收盤定格**。
  **盤中與交易日收盤後走不到定格路徑**（那時 rows 非空），
  即時路徑逐字不變（2026-09-11 Playwright 以同一組 mock ＋ 固定時鐘，對跑改動前後的 `#main`
  innerHTML **逐字相同**）。CSP 不需改（同源 `data/*.json` 已被 `connect-src 'self'` 涵蓋）。
- **補跑**：`--base` 可指定當時那一版 base（事後補跑時 `data/rrg_base.json` 已被重算，要用
  `git show <該日之前的 sha>:data/rrg_base.json` 取出舊版）。離線測試 `tests/test_rrg_frozen.py`。

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
| localStorage | `anthropic_key`／`gh_token`／`insight_model`／`tflive2_auto`（金鑰只送 Authorization header，不進 DOM） | — |

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
| `ts` 為 null（`001`／`101` 兩列指數皆缺） | `flow_last.date`，無則「—」 | **後備分支整體是活路徑**：`ts` 為 null 時就會走到它（覆驗情境④a 實測：`ts=null` ＋ `flow_last.date=今日` → 資料日由它推得），所以**不可把整條後備稱作死碼**。上游嚴重劣化才會發生。已知失效：定格班漏寫時 `flow_last.date` 偏舊；國定假日不處理（前一平日會誤報，與 taiwan-flows 同立場） |

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

本站更新＝`generated_at`（Worker 牆鐘 UTC Z）轉台北到分。狀態五值（台北時區、交易日只排週末）：**查詢失敗（未知）**＝boot 兩次
都拿不到可用 payload（後續自動刷新失敗沿用上一份、不改狀態）；**延遲**＝`generated_at` 距今 >3 分（沿用舊門檻）；**休市定格**＝
週末，或平日 09:00 後資料日≠今日（國定假日／開盤首分鐘尚無成交／上游未更新，三者無法區分）；**收盤定格**＝平日資料日＝今日且
≥13:35（同 `ovMarketPhase`），或平日 09:00 前握著上一交易日；**盤中**＝平日 09:00–13:35 且資料日＝今日。
驗證（2026-09-06，Playwright `page.clock`＋`/live` route 七情境：收盤後凍結檔／盤中／週日有無 `flow_last`／平日盤前殘留／延遲／500）
全數符合預期、pageerror 零。**若日後 `/livediag` 觀測到殘留時戳 ≥09:00 的形狀，要回來改 `liveDataDate` 的分水嶺。**

## 驗證方式

```bash
cd worker && npm run dev            # 本機 Worker
cd worker && npm run deploy         # 手動部署（正常情況不需要，見下）
cd worker && npm test               # 注意：只跑 test/parity.mjs
node test/sentinel.mjs              # 其餘 24 支要個別跑（離線、免 token；2026-09-09 實查 worker/test/*.mjs 共 25 支，
                                    #   含 swr.mjs 與新增的 tickdiag.mjs。舊記的「22 支」已過時）
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
