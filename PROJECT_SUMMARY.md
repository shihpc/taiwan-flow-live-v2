# Taiwan Flow Live V2 — 專案總結（供 Claude Project 使用）

最後更新：2026-07-20（Worker 排程備援上線：6 條每日班準點檢查產物新鮮度、GH 排程延遲/漏發時補發 dispatch）

## 快速接手

- **Worker 升格全系統主排程（2026-07-22，deploy version `485a7717`，commit `689f7ff`）**：
  治 GH cron 常態延遲 60-90 分。CF cron 9→12 條：summary am/pm 事件驅動（上游全齊即 dispatch
  postmkt/summary.yml 帶 inputs.slot；pm 三源＝flows+postmkt+news晚班、am＝morning.json）、
  四單體班（daysummary 13:35/aetf 18:35/baseline 20:05/us 05:05）挪至上游就緒時點主觸發、
  晚場協調班（21:00-23:55 每5分）串 pm summary→diag 鏈→mktbal 鏈→aetf2（21:45）、intraday
  納管備援 14:40。GH cron 全數保留挪後為兜底（不變式：一條不刪）。新端點 /sumcheck /evening。
  **全貌見 `Harness/site-architecture-20260722.md`**。測試 test/summary.mjs 64 綠、backup.mjs 58 綠。
  **未解/待觀察**：隔交易日驗證 summary pm 應 workflow_dispatch 觸發 ~22:0x 起跑、22:47 GH cron
  run 被已產出守門秒退；四單體班觸發來源與落地時間對齊預期表。
- **intraday 歸檔修復＋搶救（2026-07-22，commit `d85e49f`）**：archive_intraday.py 補格邏輯
  IndexError——既有次產業第二個命中時點必炸，**7a 上線後排程 run 全 failure**（07-18「成功」
  僅因命中 1/54 格倖存，該檔對回測近乎無用）。修復後本機補跑 07-20/07-21 各 54/54 全命中
  （frame TTL 2 天內搶救）。07-18 frame 已過期無法補，回測樣本自 07-20 起算。
- **/live 資料時間改取 max(date)（2026-07-21，deploy version `572399a2`）**：`aggregate()`
  原 `ts = ts || r.date`（`worker/src/index.js:188`）取「第一檔有分類個股」的 date 當全站資料時間，
  一旦第一檔是冷門股（如 6680，最後成交定格 13:12:51、量僅 1 張），整站「資料時間」就被拖成盤中舊值、
  收盤後也不前進。改為掃全體有分類個股取 `max(date)`（date 為定寬字串，字典序＝時序）。
  **驗證**：部署後線上 `/live` ts 從 `13:12:51` 修正為 `15:00:00`（當日最新成交＝盤後零股定盤）。
  **未解/待觀察**：max(date) 收盤後會是盤後定盤/零股的 14:30–15:00 而非 13:30 集合競價；若日後想讓
  「資料時間」語義＝正規盤收盤，需另限定只取正規盤（≤13:30）rows 或改用指數列 001/101 的 date。
  注意：本次 bug 與 07-16/17 FinMind 上游時戳停滯**是不同問題**（那次是上游真斷、本次是我方取第一檔）。
- **build_aetf.py 逐股加市值（2026-07-21，`grab_holding()`）**：`stocks[c]` 由 `[股數,名稱,權重%]`
  改 `[股數,名稱,權重%, mv]`（mv=`fnum(r.get("market_value"))`，同列 FinMind 回應本就有、原只拿去加總 aum
  現多存一個數字，零額外抓取）。缺 market_value 的 ETF（如 00400A，FinMind 回 0/None）mv 存 None，
  前端顯「—」不炸。postmkt renderAETF 持股表新增「市值(億)」欄消費 `stocks[code][3]/1e8`，資料源＝
  本 repo raw `data/aetf/latest.json`（postmkt V2_BASE），故 postmkt 該欄要等本 repo 排程重跑 build_aetf
  push 新 latest.json 後才有值。**驗證**：本機跑 build_aetf.py，00991A 2330 mv=97.44億、逐股 mv 加總≈aum。
- **即時一覽前端四項改進（2026-07-21，純前端 index.html）**：①今日總結（`ovSummaryCard`）貢獻/拖累前5
  每檔改「代號 名稱 漲跌%（紅漲綠跌）貢獻點」，`fmtStk`／`fmtP`（copy 文字同步）；漲跌%＝`sval(code).chg`。
  ②treemap 格內改兩行：`.ovtname`（名稱）＋`.ovtmeta`（佔比% 漲跌%）；`.ovtcell{min-height:32px}`、
  `OV_TREE_MIN_PX=16→32`（autosplit 盡量容兩行，不足者 min-height 墊高，極小格可小幅超出精確面積、大格面積仍＝佔比）。
  ③象限圖（`ovQuadrantHtml`）加大（H 420→456、字 10/11→12.5/13、泡半徑 k 34→40）＋pinch/pan 縮放：
  `.ovquadzoom#ovQuadZoom{touch-action:none}`＋`ovQuadZoomInit()`（pointer/wheel/dblclick，狀態 `OV_QUAD_TF` 跨重繪保留，
  renderOverview 末呼叫）；平移逾閾值以 stopPropagation 取消該次 click，泡泡下鑽不受影響。
  ④盤中異動雷達移除「提醒設定」整套（`ovAlert*`／`OV_ALERT_*`／`data-ovalert-*` handler／pull 內 `ovAlertCheck` 呼叫／
  state `alertOpen` 全刪；`ovToast` 保留給 copy）；三表加 `@media(max-width:560px){.ovradar{flex-direction:column}}` 手機全幅。
  **驗證**：本機 http.server + 瀏覽器 JS 實測四項＋7 tab 零 error（mobile/desktop）；**與 Worker LINE alert 無關**（純前端頁內提醒，移除不影響 Worker）。
- **Worker 排程備援（2026-07-20，升 Cloudflare Paid 後）**：治「GitHub Actions schedule 延遲/漏發」
  （07-20 aetf 延遲 2h 為觸發實例）。對 6 條純靠 GH cron 的每日班，Worker 於「排定＋緩衝」的準點
  fetch 該班線上產物 raw JSON、檢查日期欄是否今日，非今日就 workflow_dispatch 補發。
  - **覆蓋 6 條班（檢查點台北時間）**：daysummary 14:25、aetf 18:50、baseline 21:10（本 repo）；
    us 05:30（本 repo，美股班）；diag 22:35、mktbal 22:45（**跨 repo → postmkt**）。
  - **機制**：①產物新鮮度（不需 GH token，直接量資料有沒有更新；us 因 date 欄是美股交易日會落後，
    改判 `generated_at` 是否今天跑過）②冪等 KV `bkfired:<date>:<name>`（成功 dispatch 才寫、每日至多補一次；
    失敗不寫保留重試）③交易日守門（TW 班看當日 `series:<date>` frame 是否存在，假日/週末無→不補；us 靠 runBackup 內台北 dow 守週末——CF cron 拒收 dow 0-4 code 10100，us cron 改用 dow *）
    ④`GH_DISPATCH_TOKEN` 未設整段靜默。程式：`worker/src/index.js` `backupPipelines`/`BACKUP_CRONS`/
    `backupPipelineForCron`/`runBackup`（`dispatchMorning` 之後）；`scheduled` 入口最先判 `backupPipelineForCron`。
  - **cron**：`wrangler.toml` 新增 6 條專屬 cron（3→9 條；Paid 上限 250）。與哨兵 cron 同分觸發時各帶
    自己的 `event.cron`、互不干擾，**既有 frame/哨兵/news/morning 路由與 dispatch 零改動**。
  - **跨 repo token**：mktbal/diag 在 postmkt——沿用**既有** `GH_DISPATCH_TOKEN`（本來就含 taiwan-flows＋
    postmkt＋taiwan-stock-news 三 repo actions:write，見 wrangler.toml secret 註解、哨兵也 dispatch postmkt），
    無需額外授權。
  - **手動驗證端點**：`GET /backup?name=<daysummary|aetf|baseline|us|diag|mktbal>`（預設 dry=1 只回決策不真發；
    `&dry=0` 才真的補發）。測試 `worker/test/backup.mjs`（49 通過）。
  - **天花板誠實**：只解「GH 排程延遲/漏發」；FinMind 上游資料公布時點（法人 20:00…）與異常仍是天花板，
    備援不讓資料比來源更早，只保證「來源一有就最多晚幾分鐘被抓」。
  - **未解/續作可選**：低頻班（lastweek 週一、meta 月）與已有機制者（intraday 前端不讀、summary 內部閘門、
    morning/news/flows/postmkt 已有 Worker dispatch）本期未納入；如需再照同模式加 cron＋設定即可。
    另 postmkt 的 mktbal/diag 上游是 build.yml（21:53），若 build.yml 本身漏跑，補跑 mktbal/diag 可能拿到舊資料
    （本備援只保 mktbal/diag 自身排程，不含上游）。
- **Worker dispatch 失敗重試（2026-07-20，deploy version `750a81c9`）**：`dispatchNews`/
  `dispatchMorning` 原本 `ghDispatch` 非 204 就丟錯，呼叫端只 `.catch(log)` 不重試——曾有一班
  （07-20 08:07）無聲消失過一次。新增共用 `ghDispatchWithRetry()`：第一次失敗 log 後等 3 秒
  重試一次，兩次都失敗才往外丟（呼叫端既有 catch(log) 兜底，日後靠下一小時定點班/22:37 GitHub
  cron 備援自然重試）。additive、cron 維持 3 條、無新增 `.list(`、`/live` 舊回傳零改動。
  `worker/test/sentinel.mjs` 補上「第1次失敗第2次成功」「兩次都失敗」案例（dispatchNews/
  dispatchMorning 各一組，共 69 通過）。commit `bf8a9e3`。配套修正見
  taiwan-stock-news `README.md`「快速接手」時區修正（`build_news.py` 改台北日判定今天）。
- **個股追蹤技術面端點 `/technical`**（2026-07-20 完工部署 version 9567508f；供「新聞晨報」站個股追蹤第三批，三批＝基本/籌碼/技術至此完整）：
  - **Worker**（`worker/src/index.js`，`chipsBatch` 後、`FUND_RE`/美股同步前）：additive 新端點
    `/technical?id=2330`（單股回物件）或 `?ids=a,b,c`（批次回 `{stocks,date}`，上限 30 檔）。資料源
    FinMind `TaiwanStockPrice`（Free(w/id) OHLCV，回溯 ~400 曆日 ≈250 交易日）；7 項指標**全在 Worker 算**
    （不外送長序列）：`ma`(MA5/10/20/60＋現價距離%＋多空排列)、`kd`(9,3,3)、`macd`(12,26,9)、`rsi`(5,10)、
    `boll`(20,2 %b)、`volume`(5日/20日均量比＋爆量/量縮)、`range52`(距52週高/低%)。每指標帶中性 `state`
    描述詞（超買/超賣/黃金交叉/死亡交叉/黏合/排列…＝數學狀態，**非買賣訊號**）。
  - **KV 每股每日快取** `tech:<code>:<date>` TTL 2 天；FinMind 失敗重試一次後該股回 `{id,error}` 不整批倒；
    資料不足指標回 null＋前端優雅降級「—（資料不足）」。
  - **純函式全 export** 供 `worker/test/technical.mjs` 離線驗算（49 通過，無需 token）：`sma/ema/kd/macd/
    rsi/boll/volumeRatio/range52/maArrange/buildSeries/buildTechnical/technicalFor/technicalBatch`。固定序列
    對照教科書值：`ema([1..10],5)=8`、`kd`手算末 K≈67.59/D≈60.19、`rsi([10,11,10,11,10,11],5)=60`、
    `boll([2,4,6,8],4,2)` mid=5/%b≈0.84、`macd`常數序列全 0。線上 2330 抽核：MA20＝boll.mid（獨立碼路一致）、
    dist20=(price−MA20)/MA20 手算符合。
  - **零影響**：無新 cron（維持 3 條）、`/live`＋`/fundamentals`＋`/chips` 舊回傳/測試零改動、無 `.list(`、
    三站同步函式零改動。前端配合：`taiwan-stock-news/index.html` 個股追蹤詳情框加第三分頁「技術面」（沿用
    TRACK.view 機制、lazy 取、頂部固定免責）。**續作指針**：回測技術指標對波動的有效性（7b 一併，先驗證再宣稱）。
- **個股追蹤基本面 refine（4 點回饋）**（2026-07-20 完工部署 version ae22fd05）：`/fundamentals`
  additive 擴充—回傳新增 `name`（TaiwanStockInfo）、`dividend`（TaiwanStockDividend：現金/股票股利
  ＋除息日 exDate＋公告 announce＋年度季別 year，cash 回 FinMind 原值）、`news`（媒體新聞
  TaiwanStockNews 去重 by link＋業績事件墊底，保證 ≥3、消除「不在新聞池」死路）。純函式
  `buildNews/buildDividend/buildName/buildEvents/assembleNews` 全 export（`worker/test/fundamentals.mjs`
  67 通過）。**新聞窗只取近 5 日**（FinMind TaiwanStockNews 由 start_date 升冪、≤500 列截斷，長窗會
  把最新新聞截掉）；assembleNews 為業績事件**保留名額**（cap-events），故熱門股仍同時含媒體＋事件。
  **cache key 升版 `fund:4:<id>:<date>`**（schema 變動使舊快取自然失效）。`/live`、`/chips` 舊回傳
  零改動、無新 cron（維持 3 條）、三站同步函式零改動。前端配合：news 站每日新聞改讀此 news、月營收
  柱標金額、季財報加股利列、自選股顯示代號＋名稱。**未解/續作**：新聞窗 5 日為避 500 列截斷的權衡，
  極端爆量日（單股 >100 則/日 × 5 日 >500）仍可能截到，屬 FinMind Free 限制；殖利率欄（現金股利÷股價）
  暫未做（需股價來源）。
- **個股追蹤籌碼面端點 `/chips`**（2026-07-20 完工部署；供「新聞晨報」站個股追蹤第二批）：
  - **Worker**（`worker/src/index.js`，`fundamentalsBatch` 後、`FUND_RE` 後）：additive 新端點
    `/chips?id=2330`（單股回物件）或 `?ids=a,b,c`（批次回 `{stocks,date}`，上限 30 檔）。回傳每股
    `{id, inst:{foreign/trust/dealer:[{d,v}×≤20日 淨買賣張], streak:{±連續同號天數}, sum5:{近5日合計張}},
    margin:{bal,chg,short_bal,short_chg,credit_ratio 券資比%,series,date}, sbl:{bal,chg,date},
    daytrade:{ratio 當沖量÷成交量%,date}, foreign_hold:{ratio,chg,date}, big:{ratio,wchg,date}|null,
    big_note, updated}`。單位：三大法人/融資/借券一律「張」（=1000股），比率 %。
  - **資料集**（皆 finData 重試一次、各表獨立容錯，某表失敗該欄 null）：三大法人＝
    TaiwanStockInstitutionalInvestorsBuySell（外資含 Foreign_Dealer_Self、自營含 Dealer_Hedging）；
    融資券＝TaiwanStockMarginPurchaseShortSale（餘額原生張）；借券＝TaiwanDailyShortSaleBalances
    （SBL 原生股→÷1000 張）；當沖＝TaiwanStockDayTrading÷TaiwanStockPrice.Trading_Volume；外資持股＝
    TaiwanStockShareholding.ForeignInvestmentSharesRatio；**千張大戶＝TaiwanStockHoldingSharesPer
    （Backer 付費層，週資料）——實測 Worker FINMIND_TOKEN 可取到**（2330 big_note=null、84.91%），
    取不到則 big=null＋big_note 降級不整批倒。純函式 `chipStreak/buildInst/buildMargin/buildSBL/
    buildDayTrade/buildForeignHold/buildBigHolder/chipsFor/chipsBatch` 全 export，離線測試見
    `worker/test/chips.mjs`（41 通過，無需 token）。
  - **KV 每日快取** key `chips:<code>:<date>` TTL 2 天；全欄皆 null（含查無）拋出 → batch 降 `{id,error}`。
  - **零影響**：無新 cron（維持 3 條）、`/live` 與 `/fundamentals` 舊回傳/測試零改動（7 個 guard 測試全過；
    parity.mjs 的 31 失敗為既有線上資料漂移，clean tree 同樣失敗，與本次無關）。線上抽核 2330（2026-07-17）
    外資 −44,184 張、融資 +455 張、券資比 0.24%、借券 +375 張、當沖 11.77%、外資持股 69.34% 皆與
    FinMind 原值手算一致。
  - **後續批次指針**：技術面（第三批）採描述性統計傾向、留待回測驗證（比照第七期b／postmkt 持股診斷，
    不做預測宣稱）；前端 tab 地基已備（`taiwan-stock-news/index.html` 個股追蹤 `基本面/籌碼面` 分頁，
    再加第三個分頁即可）。

- **個股追蹤基本面端點 `/fundamentals`**（2026-07-19 完工部署；供「新聞晨報」站個股追蹤第一批）：
  - **Worker**（`worker/src/index.js`，`usWatch` 後、`/uswatch` 路由後）：additive 新端點
    `/fundamentals?id=2330`（單股回物件）或 `?ids=a,b,c`（批次回 `{stocks,date}`，上限 30 檔）。
    回傳每股 `{id, revenue:[{ym,rev,mom,yoy,announce}×24], financials:[{q,eps,rev,gross,op,net,
    gross_margin,op_margin,net_margin,qoq,yoy}×10], updated}`。月營收＝TaiwanStockMonthRevenue
    （以 revenue_year+revenue_month 對月，非 date；create_time=公布日）；季財報＝
    TaiwanStockFinancialStatements（**單季值**，三率＝各項÷Revenue）。**QoQ/YoY 由 Worker 算並附回**
    （EPS/營收/稅後淨利＝相對%；三率＝百分點pp差）。純函式 `pctChange/ppChange/buildRevenue/
    buildFinancials/fundamentalsFor/fundamentalsBatch` 全 export，離線單元測試見 `worker/test/
    fundamentals.mjs`（33 通過，無需 token；mock FinMind＋mock KV）。
  - **KV 每日快取** key `fund:<code>:<date>` TTL 2 天：同股同日只打一次 FinMind；另 FinMind 回應
    cf cacheTtl 3600 邊緣快取。預算：實務 <30 檔/人，每檔每日 ≤1 read+1 write « 免費額度。
  - **零影響**：無新 cron（維持 3 條）、`/live` 與既有端點/測試零改動（6 個 guard 測試全過）；
    某股 FinMind 失敗回 `{id,error}` 不整批倒、重試一次。線上抽核 2330 2026Q1 毛/營/淨率
    ＝66.25/58.1/50.51%、6月營收 YoY 67.87% 皆與 FinMind 原值手算一致。
  - **後續批次指針**：籌碼面（法人買賣超/融資券/借券，可續用哨兵落地資料或新 FinMind dataset）、
    技術面（採描述性統計傾向、留待回測驗證，比照第七期b；不做預測宣稱）。前端 tab 地基已備
    （`taiwan-stock-news/index.html` 個股追蹤 tab，兩組來源清單＋選股詳情框，加區塊即可）。

- **案四 湧入／退出 tab 收盤定格**（2026-07-19 完工部署；「資金湧入」「資金退出」原始 tab
  (`renderFlow`, index.html) 盤外/週末不再空等「盤中生效」，改用最後營業日收盤資料定格，
  比照案三的做法但擴充儲存內容）：
  - **Worker**（`worker/src/index.js` `flowLastPayload`，案三段落內「案四擴充」註解處）：
    additive 擴充 `flow:last` payload，加 `subs`（flow.subs 原樣）、`frames`（{10,30}）、
    `baseline_date`、`stocks`（{code:[f10,c10,c30,r10]}，只收 f10>0 個股，比照 f30 省空間）；
    既有 `mkt`/`f30` 欄位、寫入路徑/頻率/窗口（平日 13:25–13:40 frame cron 保底）完全不變。
    KV value 大小已用 1500 檔個股+500 次產業規模 mock 量測 <1MB（見
    `worker/test/flowlast.mjs` 「2c. KV value 大小量測」區塊，實測結果印在測試輸出）。
  - **前端**（index.html `flowLastUsable`/`flowStockRow`/`FLOW_STK_SRC`/`renderFlow`）：
    `fl=state.live.flow??flowLastUsable()`；`flowLastUsable()` 要求 flow_last 含 `subs`
    才視為可用（案三舊 payload 只有 mkt/f30、沒有 subs，會被正確擋掉、回落既有降級文案，
    不會炸）；回放模式（`OV_REPLAY` 非 null）不套用 fallback。個股列 f10/c10/c30/r10 改讀
    `flow_last.stocks[code]`（`FLOW_STK_SRC`），it/fi/y1/y2/ints/nl/漲跌%/最新價仍從
    `sval(c)` 取（baseline 直出，永遠即時，不需重複存）。用定格資料時頁面上方顯示徽章
    「資金動向：MM-DD 收盤定格」（沿用 `.ovlastbadge` 樣式）；`flow_err` 異常提示只在
    flow 與 flow_last 都不可用時才顯示，不被 fallback 蓋掉（已用瀏覽器 mock 驗證：mock
    flow_err + 可用 flow_last 同時存在時，優先走 fallback 正常渲染、不顯示錯誤字樣）。
  - **驗證方式**：今天週日、真實 KV `flow:last` 尚未落新欄位（甚至目前 KV 完全無值——
    weekday 首次覆寫要等下週一 13:25 後），本輪全靠瀏覽器 console 對 `state.live` 灌
    mock `flow_last`（新格式含 subs/stocks／舊格式只有 mkt/f30／`OV_REPLAY` 非 null 三種
    情境）呼叫 `render()` 驗證渲染與方向判定正確、7 tab 零 console error；worker 單元測試
    `worker/test/flowlast.mjs`（36 項，含新增的 payload 欄位/過濾/位元組數測試）全過。
  - **待觀察（週一 2026-07-20 13:25 後）**：確認 `flow:last` KV 真的落地新欄位
    （`npx wrangler kv key get --binding FLOW_KV flow:last --remote | 檢查有無 subs/stocks`），
    盤外重新整理「資金湧入」tab 應直接看到真實次產業/個股排行＋「07-20 收盤定格」徽章
    （非 mock）。若當天徽章沒出現，先查 `/live` 回應是否真的帶 `flow_last.subs`。
- **案三 盤外收盤定格**（2026-07-19 完工部署；盤外/週末即時一覽「象限圖＋treemap 角標」
  不再空等「盤中生效」，改用最後營業日收盤短窗資料定格＋徽章「資金動向：MM-DD 收盤定格」）：
  - **Worker**（`worker/src/index.js`「案三」段）：frame cron 於台北平日 13:25–13:40 每分鐘
    保底 `buildLive→storeFlowLast`，把非 null flow 定格成單一 key `flow:last`
    （{date,ts,mkt:{d10_yi,d30_yi},f30:{code:近30分Δ額>0}}，TTL 7 天，≤16 writes/日；
    /live 流量路徑不寫）。`/live` 在 flow=null 時 +1 get 附頂層 `flow_last`（additive，
    flow 非 null 不附）。KV write 預算：既有 ~825＋本功能 16 ≈860/日 <1000。
  - **前端**（index.html `ovFlowLast/ovF30/ovFlowLastBadge`）：僅象限圖與 treemap 角標退回
    `flow ?? flow_last`（個股 f30 → flow_last.f30[code]）；雷達/儀表列/定調句/總表近30分欄/
    湧入退出 tab 一律照舊降級「盤中生效」；回放模式不適用 fallback；兩者皆無（首次部署後
    KV 尚空）→ 既有「盤中生效」提示。單元測試 `worker/test/flowlast.mjs`（26 項）。
  - **待觀察（週一 2026-07-20）**：13:25 後 KV 首次落 `flow:last`（`npx wrangler kv key get
    --binding FLOW_KV flow:last --remote` 或收盤後看 /live flow_last）；當晚盤外象限圖應
    顯示定格資料＋「07-20 收盤定格」徽章。註：parity.mjs 在 HEAD 即 31 項失敗
    （data/live.json 與 lastweek.json fixture 漂移，與案三無關）。
- **資金地圖改造＋六點回饋**（2026-07-19，commit 7251379，fresh-context 總驗收全 PASS）：
  treemap 第一層改「佔比≥1%動態門檻」（原 top9＋37.9%黑箱→28具名格＋3.1%粉塵格）、
  N欄自動布局、「其餘N條」與「未入鏈」（拆一般/主動A/債券B/反向R/槓桿L/未入鏈六灰格）
  皆可下鑽、格內單行「名稱 佔比% 漲跌%」；新增「地圖｜象限」pill——純SVG象限泡泡圖
  （x=漲跌%、y=盤中資金動向pp、面積=佔比、四象限角標、大泡與離群泡標數值、點泡下鑽、
  盤外/回放降級）；回放儀表列優先用 series 實際分鐘值（命中標「回放實際值」）；
  貢獻長條與收盤總結卡改前5＋後5（build_daysummary bot 3→5、news 晨報 label 動態化
  114efe9）。已知小警：10px 極小格字形下緣微截、象限 2 對標籤 bbox 擦邊 <2px（可讀非阻斷）。
- **第九期 離線提醒基礎設施**（2026-07-18 完工部署；頁面關著也能收盤中重大事件通知）：
  - **機制**：事件偵測併入既有每分鐘 frame 班（cron 上限 3 條已滿，不新增），storeFrame
    成功後跑 `runAlerts()`（worker/src/index.js「第九期」段）；偵測失敗只 log 不影響 frame。
    保守事件集兩種（訊號擴充等 8 月 7b 回測）：①加權指數 5 分變動 ≥40 點（`detectIdxEvent`，
    用 series 判定，斷檔>8分不判）②晨報連湧次產業（morning.json `signals.cont_subs`，
    raw fetch＋cf 快取 1h，零 KV 額度）近30分佔比−全日佔比 ≥3pp（`detectSubEvents`，
    沿用 _ts 停滯/stale 降級防護）。同 id 事件 30 分去重（`dedupAlerts`）。
    門檻 KV 可調：`npx wrangler kv key put --binding FLOW_KV alerts:cfg '{"idx5":40,"subpp":3}' --remote`。
    KV 額度：讀 ≤6 get/分（盤中 ~1,600/日 vs 免費 10 萬）；**寫僅去重後有新事件時 put
    `alerts:log` 單 key 一次**（典型 0~10 次/日，不吃緊繃的 write 1000/日）。
  - **端點**：`/alerts/test` 手動驗通道（未設 secret 回 `{ok:false,reason:"未設定通道…"}`，
    不觸外部請求）；`/alerts/log` 回近 24h 事件（單 key 1 get；KV 內留 48h/200 筆）。
  - **通道可行性結論**：Cloudflare **Email Sending 不可行**——需先 onboard 自有網域 zone
    （SPF/DKIM DNS 驗證，`wrangler email sending enable <domain>`），本帳戶（fed2df6b…）
    無自有網域（全系統站點皆 GitHub Pages / workers.dev；`wrangler email sending list`
    回 Unauthorized），不為此動帳戶層設定。可用通道兩種、**可並存（都設就都發）**：
    ①通用 webhook（secret `ALERT_WEBHOOK`）：Discord 格式 `{content}`；URL host 為
    api.telegram.org 時自動改 `{chat_id,text}`（chat_id 取自 URL query）。
    ②LINE（LINE Notify 已於 2025-03 終止 → 走 Messaging API bot push）：secrets
    `LINE_TOKEN`＋`LINE_USER_ID` 兩者齊全才發；userId 靠 `/line/webhook` 一次性擷取
    （KV `line:uid` 變化才寫；**該端點不驗 x-line-signature**——簽章需 channel secret、
    為降低設定步驟省略，僅用於一次性取 userId，取得後可關閉 LINE 平台 webhook）。
    單通道失敗不擋另一通道（/alerts/test 回應 errors 可見）。
  - **使用者要做的動作（外送最後一哩，擇一即可；使用者 2026-07-18 裁定只用 LINE＋Telegram，
    Discord 格式僅為 webhook 預設 fallback 不使用）**：
    - Telegram（最快）：①手機找 @BotFather 建 bot 取 token ②傳一句話給新 bot，開
      `https://api.telegram.org/bot<token>/getUpdates` 從回應 message.chat.id 取 chat_id
      ③在 `worker/` 下 `npx wrangler secret put ALERT_WEBHOOK` 填
      `https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat_id>`
      ④開 `https://taiwan-flow-v2.shihpc.workers.dev/alerts/test` 應收到測試訊息。
    - LINE：①建 LINE 官方帳號並到 developers.line.biz console 對該帳號開 Messaging API
      channel ②Messaging API 分頁發 channel access token（long-lived）→
      `npx wrangler secret put LINE_TOKEN` ③LINE 平台 Webhook URL 填
      `https://taiwan-flow-v2.shihpc.workers.dev/line/webhook` 並開啟 Use webhook
      ④手機加該 bot 好友、傳任意一則訊息 ⑤開 `/alerts/test`，回應的 `line_uid` 就是你的
      userId（U 開頭）→ `npx wrangler secret put LINE_USER_ID` 貼上 ⑥再開 `/alerts/test`
      應收到 LINE 測試訊息 ⑦（可選）回 console 關閉 webhook。
      **額度**：Messaging API 免費 500 則/月；本事件集保守（30 分去重、兩事件型）
      典型 0~10 則/日 ≈ 月上限 ~220 則，在額度內；若日後 7b 擴充訊號需重估。
    未設定前偵測照跑、事件照記 `/alerts/log`（sent=0），只是不外送。
  - 單元測試 worker/test/alerts.mjs（43 項：兩事件情境/門檻可調/30分去重/無 secret 靜默/
    Discord・Telegram 格式/LINE 兩secret齊全才發・payload・並存雙發・單通道失敗不擋/
    /line/webhook uid 變化才寫/runAlerts 整合）。前端零改動、/live 舊欄位零改動（部署前後
    欄位集 diff 為空）。**待觀察**：盤中實際觸發尚未發生過（部署於收盤後），下一交易日看
    `/alerts/log`；事件②依賴 morning.json 晨報班正常產出。
- **第八期 收盤總結落檔**（2026-07-18 完工，commit 3ba8586）：`src/build_daysummary.py`＋
  `daysummary.yml`（平日 14:05 台北＋dispatch 帶 date）——收盤後拉 Worker /live 定格重算
  收盤總結卡（ovSummaryCard）同口徑全日總結 → `data/daysummary/YYYY-MM-DD.json`＋
  `latest.json`（保留近 30 交易日；非交易日 /live 日期不符優雅退出）。下游：taiwan-stock-news
  晨報「昨日資金流向」段跨 repo raw 讀 latest.json（讀不到整段隱藏）。已知限制：上游
  /replay 全日 series 常態只剩尾筆（2026-07-18 實測），全日高低 hi/lo 以 null 誠實降級，
  待 series 修復後自動恢復。
- **7a 盤中歸檔＋權重月更**（2026-07-18 完工，commit 9db1e96＋修補 1c188cd，fresh-context
  驗收 7/7 PASS）：①`src/archive_intraday.py`＋`intraday.yml`（平日 14:10 台北＋dispatch
  帶 date）——收盤後拉 Worker /replay 存全日 series＋「次產業×5分時點(09:05–13:30 共54點)」
  累積成交額矩陣到 `data/intraday/YYYY-MM-DD.json`（聚合口徑同 computeFlow p 去重多對多；
  缺格記 null；無 frame 優雅退出不寫檔；KV 讀 ≤325/日）；②`meta.yml`（每週六 00:00 UTC
  cron＋「日≤7」守門＝每月第一個週六 08:00 台北；dispatch 不受限）跑既有 src/meta.py 重建
  classify.json，commit 前有 schema 守門（map 值鍵恆為 n/e/c/p/t/sh，下游 v2 前端＋postmkt
  build_diag 依賴）。**續作指針（7b，8 月初）**：data/intraday/ 累積 ≥10 交易日後回測
  「盤中佔比躍升/動能加速」的 T+30分/收盤延續性；注意 2026-07-18.json 是週六 stale 資料
  （frames[i].stale=1、僅 12:20 一點），回測時應以 stale 與 n_hit 過濾；meta 與 intraday
  同日先後跑時 intraday 用 checkout 當下的 classify 快照（檔內自洽，屬預期）。
- 「即時一覽」tab（2026-07-18 夜間三期完工，現為**預設 tab**、第 7 個 tab）：綜合呈現
  「此刻誰在推動大盤」——儀表列（加權/櫃買、廣度條、成交值＋資金速率＋大盤 sparkline、
  盤前/收盤定格徽章）、規則式定調句（旁有「AI 深入解讀」鈕→切 insight tab，不自動呼叫）、
  貢獻點發散長條（次產業/產業鏈/個股三視角）、資金地圖 treemap（產業鏈→次產業→個股三層
  下鑽，面積=佔比，明確百分比配置＋<2% 尾項併「其他N項」，實測誤差 ≤2.1%）、次產業強弱
  總表（貢獻/佔比/近30分佔比/廣度/30分動能/領頭股）。**全即時原則**：此 tab 禁用前日衍生
  欄位（flow.subs 的 c1/c2/y、個股 it/fi/y1/y2/ints/nl/lw）；唯二非即時參數＝昨收基準與
  發行股數。Worker 為此 additive 新增：`flow.mkt{d10_yi,d30_yi}`、個股尾欄 `f30`、
  `series:<date>` rolling key（每分鐘 append 市場總額/指數，繞開 fi 索引漏筆缺陷）＋
  /live 頂層 `series`（近 60 筆）。前端新函式群 ov*（index.html ~1113-1500）。
  第四期（盤中異動雷達＋自訂提醒，純前端，commit 9debfe6）與第五期（當日回放＋收盤總結，
  2026-07-18 日間完工）皆已上線。**第五期要點**：Worker 新端點 `/replay?t=HH:MM`
  （直讀 `f:<date>:<HH:MM>` frame 不經 fi 索引、缺格往前回退 ≤5 分鐘 ≤6 次 get 無 list；
  `date` 參數僅驗證/總結卡用；不帶 `t` 回 `series:<date>` 全日序列）；前端回放模式
  （滑桿 09:00–13:30、debounce 500ms、`ovVal()` 資料入口讓整條 ov 渲染鏈自動吃回放重建值：
  昨收=close−dp、Δ指數≈昨收指數×Σ(dp×sh)/Σ(昨收×sh) 市值權重近似、pts 同 worker 鏈路、
  ETF 排除；短窗欄位一律「回放模式不適用」、回放中暫停 pull 重繪與提醒）；收盤總結卡
  （13:35 後全日口徑＋複製摘要鈕，「升幅最大」以全日貢獻點最高口徑呈現）。
  單元測試 worker/test/replay.mjs（14 項）。
  **frame 落格斷檔已修復**（2026-07-18，commit 6bf3342，已部署）：根因＝FinMind snapshot
  上游 07-16/17 異常（時戳停滯/整天失敗）＋設計放大器（frame key 用資料時戳命名→塌縮、
  錯誤靜默）。修法：key 改 event.scheduledTime 台北牆鐘＋value 存 _ts/_stale、失敗重試一次、
  err:<date> 錯誤可見化、Worker `/` 根路徑 health{frames_today,last_err} 可日常巡檢；
  computeFlow 對 stale 窗口降級、/replay 附 src_ts。單測 worker/test/frames.mjs 33 項。
  **未解/待觀察**：①盤中未實測——下一交易日開盤需觀察 series 累積、flow.mkt、每分鐘
  frame 不塌縮（看 `/` health 的 frames_today）、回放滑桿真實 frame 重建；
  ②小項：13:36+ 收盤守門在 FinMind 呼叫之後，盤後 cron 尾段每日多 ~24 次快照 API（非阻斷）；
  ③test/parity.mjs 在 HEAD 即有 3 項 lw fixture 漂移失敗（先於本輪五期，另案處理）。
- 現況：v2 已收斂為「純即時看盤站＋跨站資料中樞」。前端為 6 個即時 tab＋1 個摘要分析 tab；
  晨報、主動ETF 的**前端**已拆到「新聞晨報」「盤後分析」兩個姊妹站，
  但兩者的**資料管線仍在本 repo**，下游站跨 repo 讀 `data/`。
- 摘要分析 tab（2026-07-12 新增，第 6 個 tab）：前端直呼 Claude，框架與 postmkt 逐字同源
  （callClaude adaptive thinking/effort medium/max_tokens 8000、mdToHtml、token 用量與
  台灣時間顯示、Opus 4.8/Sonnet 5 模型切換）。insightGatherContext 彙整：大盤即時
  （指數點/%/漲跌家數）、產業別資金前8強＋跌勢前5、資金湧入 flow.subs 前12、
  個股資金集中 c10 前15（含投信/外資連買、法人強度）；盤前 flow=null 會註明略過。
  SYS 為盤中即時資金流語境（同向共振、背離不呈現、大型股≤一半、20秒快照時效性、免責）。
  特有防護：20秒自動刷新時若使用者正在輸入 token 則跳過重繪。驗收後已修一 bug：
  大盤段原誤把 chgP（漲跌點數）當 % 顯示，已改「±X點/±Y%」雙顯示。
  localStorage key `anthropic_key`/`insight_model` 與 postmkt、taiwan-stock-news
  同 origin 共用（設一次三站通用）。
- 個股外連＋雲端儲存（2026-07-12）：insight 渲染中個股代號自動變連結，外開 Yahoo 技術分析頁
  （`linkifyStocks(html, knownSet)`，三站逐字一致、改動需三站同步）。分析結果自動存
  **postmkt repo** `data/analyses/insight-live-YYYYMMDD.json`（當日陣列、單日上限10筆、
  保留近3日），寫入用 localStorage `gh_token`（GitHub Fine-grained PAT，三站同 origin 共用、
  未設靜默跳過）；tab 內「雲端歷史（近3日）」免 token 列本站檔、點擊展開（raw CDN 約 5 分快取）。
  PAT 建法與維護細節見 postmkt `README.md`。
- 日期修正批次（2026-07-14）：①主動ETF 三檔 T+1（群益00982A/00992A、野村00980A）的 src_date
  在 build_aetf_diff.py 折回持股基準日（`fold_tplus1`/`prev_trading_day`，用 FinMind TAIEX 日曆，
  正確處理連假；07/10 為非交易日已驗）→ 8 檔同基準、diff.json 加 `primary_date`/`laggards`。
  ②build_aetf.py 抓取成功但 src_date 未前進標 `not_advanced`。③aetf.yml 加補抓班 21:37 台北
  （同日重跑覆蓋同名日檔，冪等）。④build_morning.py chips 加 `aetf_date`（P1 也把 :68/:220 的
  date.today() 改台北日）。⑤build_us.py generated_at 改台北 ISO。**news 站晨報顯示端若要帶出
  aetf_date 需另在 taiwan-stock-news 改（本批未動該 repo）**。前端 renderAETF 聚合表已帶主基準日＋落後檔警示。
- **主動ETF 遷移 FinMind（2026-07-20）**：build_aetf.py 移除 6 套逐家投信 PCF 逆向工程
  （grab_uni/capital/nomura/fh/fubon/cathay），改用 FinMind `TaiwanStockActiveETFHolding`；
  ETF 清單由 `TaiwanStockActiveETFInfo` 動態取 domestic+twse+A 結尾（**20+ 檔**，含原 8 檔）。
  FinMind date 為實際持股基準日，**已移除 T+1 折算與 fold_tplus1/國泰權重反推**。
  diff.json 加減碼每項**兩者並列**：`net_active`（排除申贖中位數法，zh/val）＋`raw_change`
  （FinMind HoldingChange buy−sell，rzh/rval）；stocks 加 rzh/rval/rby，est_flow 改由申贖比推。
  舊 PCF 日檔已移入 `data/aetf/archive_pcf/`（不進 diff 掃描）。**aetf.yml 兩步驟皆需 FINMIND_TOKEN**。
- 改 `data/morning.json` 或 `data/aetf/*` 輸出格式前，**必讀**工作區
  `Harness/site-architecture-20260715.md`（下游讀取點清單），否則會弄壞姊妹站。

## 一句話說明

台股盤中即時資金流向監控網站（V1 的秒級升級版），現為「股市雷達」四站家族的即時站
＋資料中樞。所有訊號設計都先經過歷史回測驗證才上線，不做未經驗證的預測宣稱。

- **線上網址**：https://shihpc.github.io/taiwan-flow-live-v2/
- **本機路徑**：`C:\Users\施伯承\Desktop\Claude\taiwan-flow-live-v2`
- **GitHub**：`shihpc/taiwan-flow-live-v2`（public）
- **姊妹站**（入口 https://shihpc.github.io/ 四張卡）：盤後法人動態 `taiwan-flows`、
  新聞晨報 `taiwan-stock-news`（晨報 tab 跨 repo 讀本站 `data/morning.json`）、
  盤後分析 `postmkt`（主動ETF tab 跨 repo 讀本站 `data/aetf/`）
- V1 `taiwan-flow-live` 與 `taiwan-stock-radar` 已於 2026-07-10 整站刪除

---

## 一、整體架構

```
【夜間 / 開盤前】GitHub Actions（Python，src/*.py）
  ├─ baseline.yml   (20:41 台北；2026-07-14 由 20:30 延後，法人官方 20:00 更新留緩衝＋程式內 freshness 重試最多 40 分) → 個股5日均額/投信外資買賣超/前日訊號/法人強度/破底
  ├─ lastweek.yml   (週一09:00) → 上週各日成交值（次產業佔比分母）
  ├─ us.yml         (06:00 台北) → 昨夜美股指數/ADR/個股價量 + 規則式盤勢分析
  ├─ morning.yml    (06:20 台北) → 晨報資料 morning.json（前端在新聞晨報站）
  ├─ aetf.yml       (18:30 台北) → 20+檔主動ETF持股快照(FinMind) + 主動加減碼diff(net_active＋raw_change 並列，前端在盤後分析站)
  └─ pages.yml      (每次push)  → 部署到 GitHub Pages

【盤中】Cloudflare Worker（JS，worker/src/index.js）
  └─ 每分鐘 cron 抓 FinMind tick_snapshot → 存入 KV（分鐘級序列）
  └─ /live 端點：即時聚合 + 資金湧入/退出指標，stale-while-revalidate 快取15s
  └─ /uswatch、/usersync：美股自選清單同步（新聞晨報站沿用）

【前端】純 HTML/JS 單檔（index.html），5 個純即時 tab＋1 個摘要分析 AI tab（前端直呼 Claude）
```

**核心設計原則**：重且不常變的資料（分類表、歷史統計）留在 GitHub Python 夜間跑；
輕且要即時的（盤中集中度）交給 Cloudflare Worker。

---

## 二、五個即時頁籤＋兩條外供管線

### 頁籤 1-3. 產業別 / 產業鏈 / 成交佔比（V1 沿用）
交易所產業分類的即時成交值、漲跌、貢獻點數；產業鏈多對多分類；個股成交佔比排行。

### 頁籤 4-5. 資金湧入 / 資金退出
**核心指標**：短窗資金集中度 = 近N分鐘佔全市場成交比 ÷ 該股/次產業5日常態佔比（用比例相除，天然抵消開盤/中午的市場量能U型曲線）。

- **次產業排行是主角**：回測證實有真延續性（集中度≥1.5+上漲：T+3勝大盤50.5% vs 對照37%；隔日資金黏性78-96% vs對照14%）
- **個股排行是觀察用**：回測顯示單純追高平均**不利**（負超額），除非疊加「投信近3日連買」或「土洋同買」訊號
- **前日訊號標註**：連湧/昨湧/連退/昨退——次產業「昨湧」是加分（延續），個股「昨湧」反而是警示（追高風險），這是最重要的一個反直覺發現
- 法人強度、破底標記等技術/籌碼指標，都是先跑回測、只留有效的 3 個才上線

### 外供管線 A. 晨報（前端已移至「新聞晨報」站）
`src/build_morning.py`（morning.yml 06:20）產出 `data/morning.json`：開盤參考（台指期夜盤
vs 現貨收盤）、隔夜美股三大指數+費半、台股ADR溢價、昨日備忘（湧入/退出/籌碼）、
驗證訊號（連湧次產業清單）、策展新聞。2026-07-10 後由新聞晨報站呈現。

### 外供管線 B. 主動ETF（前端已移至「盤後分析」站；2026-07-20 遷移 FinMind）
`src/build_aetf.py`＋`build_aetf_diff.py`（aetf.yml 18:30）追蹤 **20+ 檔**主動式股票型ETF
（由 FinMind `TaiwanStockActiveETFInfo` 動態取 domestic+twse+A 結尾，含原 8 檔
00400A/00403A/00405A/00980A/00981A/00982A/00991A/00992A）：
- 每日持股快照（FinMind `TaiwanStockActiveETFHolding`）→ `data/aetf/YYYY-MM-DD.json`
- **主動加減碼兩者並列**：`net_active`（排除申贖等比縮放，median-ratio 法——技術核心）＋
  `raw_change`（FinMind `TaiwanStockActiveETFHoldingChange` 含申贖原始總變動）→ `diff.json`
- 前端 renderAETF 兩欄並列顯示、彙整含跨ETF共識與「主動 vs 含申贖」解讀

---

## 三、關鍵技術決策與踩過的雷

| 主題 | 決策/教訓 |
|---|---|
| 即時架構選型 | 否決「前端直連FinMind」（會曝付費token）、否決「Render跑Python」（冷啟動10-30s傷即時）；選 Cloudflare Worker |
| Worker 快取 | 從固定TTL改成 **stale-while-revalidate**（過期先回舊資料+背景重建），解決「每20秒卡2-5秒」的使用者體感問題 |
| KV 額度 | **list 操作**免費版僅1000次/日、曾爆額度導致集中度失效數小時；改用「時間索引key」讓 pickFrames 只用 get（10萬次/日額度）|
| GitHub Pages 部署 | 曾連續故障（GitHub服務端事故），已把 `pages.yml` 改成 `cancel-in-progress:false`(排隊)+ artifact名帶run_id，雙保險 |
| 各投信PCF端點（已退役） | 曾各自逆向工程 6 套投信 PCF，格式全不同、為長期維護風險點；2026-07-20 全數移除，改用 FinMind 主動ETF資料集（統一口徑、涵蓋 20+ 檔） |
| 前端測試 | `preview_click` 不會觸發 `.onclick` 直接賦值的handler（delegated listener 可以），驗證要用 `preview_eval` + `dispatchEvent` |
| 版控 | 2026-07-10 做過 filter-repo 歷史瘦身（hash 全變）＋行尾正規化（.gitattributes）；曾發生 force-push 誤刪 98 commit 事故並救回（教訓見工作區 `Harness/lessons.md`）|

---

## 四、回測方法論與核心發現（非常重要，是所有訊號設計的依據）

用 12 個月全市場日線資料（`backtest/fetch.py` 抓取，255交易日）驗證後才決定要不要做成產品功能：

1. **個股爆量追高 = 負報酬**（T+3對大盤負超額，門檻越嚴越差）——散戶看到的爆量常是波段宣洩點
2. **次產業集中度湧入 = 正報酬 + 高資金黏性**——主題輪動是真實存在的
3. **個股爆量下殺 = 續弱**（與上漲向不對稱，跌破新低是最強確認訊號）
4. **次產業退出 = 平均會被買回**（除非在修正月，regime依賴）
5. **有效的技術/籌碼加成**（僅3個通過驗證）：法人買賣強度、土洋同買、破20日新低
6. **「昨日訊號→今日表現」**：次產業昨湧續強、個股昨湧反而偏弱（連續湧入更明顯）

> 設計原則：**先回測、再決定要不要做成功能**；產品文案誠實標註「這是觀察工具/風險警示」而非「這會賺錢」。

---

## 五、目前待辦與已知限制

- [x] ~~各投信PCF解析器是脆弱依賴~~ → 2026-07-20 遷移 FinMind，逐家 PCF 全退役
- [ ] 主動加減碼 median-ratio 在成分股少或大幅換股日可能不穩（沿用噪音門檻，異常不強算）
- [ ] 晨報子功能（除權息名單、法人整體買賣超等）多日實測持續觀察中（前端在新聞晨報站）
- 已知限制：本 repo 的 `data/` 是姊妹站的上游——改輸出格式屬跨站變更，
  流程見工作區 `Harness/site-architecture-20260710.md`

---

## 六、如何繼續這個專案（給下一個對話/Claude Project 用）

1. 這份文件是**背景知識**，讓新對話快速理解專案全貌；內容有更新時，
   記得把新版重新上傳到 Claude Project knowledge 取代舊檔
2. 實際改程式碼、部署，仍需要在 **Claude Code** 或 **Cowork**（有本機檔案系統+Bash
   存取權限的環境）進行，不能在純聊天的 Claude Project 裡做
3. 建議的協作模式：
   - 在 Claude Project 討論「要不要做這個功能」「這個指標該怎麼設計」「幫我分析這段資料合不合理」
   - 決定方向後，回到 Claude Code / Cowork 執行「幫我實作/部署/驗證」
4. 程式碼本身也有記憶——本機 repo 內的 `backtest/report*.md` 記錄了完整回測數據；
   跨站架構與工作區制度見 `C:\Users\施伯承\Desktop\Claude\CLAUDE.md` 與 `Harness/`
