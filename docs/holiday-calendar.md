# 家族共用國定假日行事曆（2026-09-28，批次一）

**起因**：2026-09-25（中秋，使用者確認放假）與 09-28（教師節；**是否休市尚未查證**，以行事曆實際內容為準）平日國定假日，各站只排除週末 →
taiwan-flows 判 `missing`、重試後亮紅開 issue；Worker `/status` 與 claude-harness 看門狗把假日
當交易日，燈號與告警全是假的。家族原本「國定假日不處理」的立場，在一年約 10 個平日假日下誤報太多。

## 1. 資料契約（唯一來源＝本 repo `data/twse_holidays.json`）

- 來源：TWSE OpenAPI `https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule`（免金鑰，只回**當年度**）。
  解析規則沿用 postmkt `build_summary.py` 的 `is_twse_holiday`（2026 全年 27 筆逐筆驗過）：
  `Date` 為民國年 7 碼（`1150925`＝2026-09-25）；**只有 `Name` 含「無交易」或 `Description` 含「放假」／「補假」才算休市**
  （行事曆混有「開始交易日／最後交易日」等交易日標記，必須濾掉）。
- 產出 `src/build_holidays.py` → `data/twse_holidays.json`：
  ```json
  {"schema": 1, "source": "<上列 URL>", "fetched_at": "<台北 ISO +08:00>",
   "years": [2026], "closed": ["2026-01-01", "..."], "names": {"2026-01-01": "元旦"}, "raw_n": 27}
  ```
  `closed` 升冪、去重、只含 `YYYY-MM-DD`；**週末日期照收**（消費端自己判週末，兩者取聯集）。
  `years`＝此檔**有涵蓋**的年度；**某年不在 `years` 裡＝該年未知，一律退回「只排週末」**（不得當成「該年沒假日」）。
- 合併：新抓到的年度整年覆寫，舊檔其他年度保留（跨年時上一年的資料不丟）。
- **失敗不覆寫**：抓取失敗、形狀不對、解析後休市筆數為 0 → 不寫檔、exit 1（workflow 紅燈＋issue）；舊檔照舊可用。
- 排程：`.github/workflows/holidays.yml`，每週一次＋`workflow_dispatch`，比照其他 workflow 掛 `notify-failure`；
  內容無變化（忽略 `fetched_at`）不 commit。

## 2. 消費端共同規則

- 讀不到／壞檔／年度未涵蓋 → **fail-open 退回現行行為（只排週末）**，不得因行事曆掛掉而擋掉真交易日或拋例外。
- 休市日＝週末 ∪ `closed`。「前一交易日」往回跳過兩者。
- 只影響「預期資料日／是否缺料」的判定；**不改任何資料欄位語意與 schema**。
  **唯一例外：taiwan-backtest walkforward（2026-09-29 使用者裁決）**——兩支記帳腳本以行事曆決定「當天記不記帳」（假日跳過，
  範圍比判級寬），見下表與該 repo `walkforward/twse_holidays.py`。
- 颱風臨時停市：TWSE 事後才會補進行事曆，當天仍可能誤報一次（已知、接受）。

## 3. 批次一範圍（會亮紅燈／開 issue／對外顯示錯的路徑）

| repo | 改哪裡 | 完成定義 |
|------|--------|----------|
| taiwan-flow-live-v2 | `src/build_holidays.py`＋`holidays.yml`＋`data/twse_holidays.json`（由 workflow 產出） | §1 全部；離線測試用 fixture（含交易日標記、民國年、失敗不覆寫、跨年合併） |
| taiwan-flow-live-v2 Worker | `/status` 判級：`lastExpectedTradingDate`／`prevExpectedTradingDate`／`gradeMarket`／`gradeBacktest` 接受選填的休市集合；`buildStatus` 讀行事曆（raw URL，cf 快取），失敗 fail-open | 預設參數＝空集合時輸出與現行逐字相同（既有測試不改）；新增 09-25／09-28 案例 |
| taiwan-flows | `run_daily.classify_no_data`（假日→`no_data` 而非 `missing`）、`verify_daily` 對應路徑、前一交易日計算 | 假日不再 exit 1、不開 issue；既有測試不改語意 |
| claude-harness | `freshness_watchdog.py` 的 `judge_market`／`judge_backtest` 前一交易日跳過假日；flows 改讀 `actual_date`（同 Worker 已做的修正） | 09-25／09-28 重演不再 STALE；三份 backtest 門檻數值不動（`check_backtest_thresholds.py` 仍 PASS） |
| taiwan-backtest（2026-09-29 追加） | `walkforward/walkforward_daily.py`／`shadow_daily.py` 經 `walkforward/twse_holidays.py` 讀行事曆，休市日在任何 API 呼叫前跳過、不記帳；讀不到 fail-open 只排週末。三份帳冊既有 2026-09-25 列已刪 | 假日不再記「空手、0 損益」列；前端 `ledgerStatus` 屬批次二未改 |
| taiwan-flow-live-v2 intraday（2026-09-29 追加） | `src/twse_holidays.py`（本地 `data/twse_holidays.json` 優先、壞/缺才退 raw URL）供 `archive_intraday.py`／`build_rrg_frozen.py`／`build_rrg_base.py` 共用；`intraday.yml` 步驟未改 | 休市日不歸檔、不定格（exit 0、無 commit）、基準選日剔除休市日檔；fail-open 只排週末。起因：09-25／09-28 KV 殘留 frame 被當成當日歸檔（見 CLAUDE.md「盤中 RRG 盤外定格」）。Worker 端 frame 寫 KV／`runBackup`／`runHealthCheck` 屬批次二 |

**批次二**：見 §5（2026-09-29 開工）。

## 5. 批次二（2026-09-29，使用者核可開工）

**總原則：休市日「比照週末」**——每個消費點在國定假日的行為，與它在週六／週日的既有行為相同；各點自己沒有週末分支的，
就比照「非交易日」的既有處理。**不新增任何判級、門檻或訊號**（鐵律 8：純描述性／排程性修正），**不改資料欄位與 schema**。
讀不到行事曆一律 fail-open（＝改動前行為），不拋例外、不紅燈、不告警。

### 5a. taiwan-flow-live-v2（Worker＋後端＋本站前端）
| 消費點 | 完成定義 |
|---|---|
| Worker frame 存 KV（`frame` 角色，`storeFrame` 一帶） | 休市日不寫 frame／`series:<date>`／`fi:<date>`——**假歸檔的上游**（09-25／09-28 KV 殘留快照）。行事曆沿用 `loadHolidayCal`（cf 快取），每分鐘一次 frame 不得因此多打 raw（確認快取命中路徑） |
| `runSentinel` | 休市日不探測 FinMind、不 dispatch（比照週末：`scheduledRole` 本來就不排週末） |
| `runHealthCheck`（eve／morn） | 休市日不對「當日應有產物」告警（比照週末的既有處理）；假日隔天的晨間健檢以「前一交易日」為準 |
| `runTickSample`、`runMorning`、`runBackup`／`backupPipelines`、`runAlerts`、其餘平日才跑的班 | 逐一盤點：凡是以「平日」為前提、會在休市日空打 API／dispatch／告警者，比照週末跳過；盤點結果（哪些改、哪些刻意不改與理由）寫進 CLAUDE.md。**iching dispatch 不在本批**（另一 session 負責） |
| `src/build_baseline.py` 假日空等 | 休市日不空等（比照週末），沿用 `src/twse_holidays.py` |
| 前端 `index.html`：`prevWeekday`／`liveStatus`／`liveDataDate` 後備／`ovRrgTaipeiToday`（週末走定格）／`ovRrgBaseDays` | 同源讀 `data/twse_holidays.json`（非阻塞、失敗 fail-open）；休市日頂列顯示「休市定格」、輪動雷達直接走定格（比照週末），前一交易日跳過休市日 |

**5a 實作註記（2026-09-29，分支 `claude/investment-site-optimization-nac77h`；驗收條件本身未改）**：
| 消費點 | 狀態 | 落點 |
|---|---|---|
| Worker frame 存 KV | 已實作 | `worker/src/index.js` `scheduled` handler 的 frame 分支（`holidaySkip`）；行事曆走 `holidayCalCached`（isolate 記憶化 30 分／失敗 5 分＋in-flight 共用，其下仍是 `loadHolidayCal` 的 cf 快取）——連續每分鐘 frame 同一 isolate 只讀 1 次（`test/holidays2.mjs` 實測） |
| `runSentinel` | 已實作 | handler 的 sentinel 分支 |
| `runHealthCheck` | 已實作 | `opts.marketClosed` → 只留 `HEALTH_NON_TW`（us／lastweek／meta）；全濾光即零副作用 return。假日隔天：eve／morn 每項都是「今日」產物，無需改基準 |
| `runTickSample`、`runMorning`、`runBackup`（TW 班）、`runAlerts`、晚場班、am summary、`dispatchMorning` | 已實作（跳過） | handler 各分支；盤點表與「刻意不改」（us 班／`runUsCatchup`／news／iching／`alertJob`）理由見 CLAUDE.md「休市日（國定假日）各排程角色」節 |
| `src/build_baseline.py` | 已實作 | `fresh_wait_skip`＋收集交易日迴圈跳過休市日（`src/twse_holidays.py`）；測試 `tests/test_baseline_holidays.py` |
| 前端 `index.html` | 已實作 | `twseCalLoad`／`twseCalParse`／`twseHoliday`；`prevWeekday`／`liveStatus`／`ovRrgTaipeiToday`（`hol`）／`ovRrgBaseDays`。載入前只排週末、近 30 日有休市日才重繪一次 |
| 上線後驗證（5c 末條，2026-10-09） | **未做**（需部署後當日實測） | — |

### 5b. 其他站前端
| 站 | 消費點 | 完成定義 |
|---|---|---|
| postmkt | `pmStatus`、`dayDiff`／`dateStatus`、`myChgDateInfo`（第五軸落後交易日數）、`rrgdLagDays` 等以「平日」算交易日差者 | 同源讀 `../taiwan-flow-live-v2/data/twse_holidays.json`（CSP `connect-src 'self'` 已涵蓋、不改 CSP）；交易日差與「最近應有資料日」跳過休市日；讀不到 fail-open |
| taiwan-flows | `lastDueTradingDay`、`siteStatus` | 同上；休市日頂列比照週末顯示「休市定格」而非「等待資料發布」 |
| taiwan-backtest | `ledgerStatus` | 參考日為休市日比照週末（與看門狗 `judge_backtest`、Worker `gradeBacktest` 同一語意）；三個門檻數值不動（`check_backtest_thresholds.py` 仍 PASS） |

### 5c. 驗收
- 各 repo 離線測試全綠；新測試以 09-25（週五假日）／09-28（週一假日）／09-26 週六／09-29 平日重演，且含 fail-open 案例。
- 行事曆讀不到時，所有消費點的輸出與改動前**逐字相同**（前端以 Playwright 固定時鐘＋同一組 mock 對跑 innerHTML；後端／Worker 以既有測試不改為證）。
- 前端改動後 postmkt 16 tab／flows 8 tab／v2 7 tab／backtest 各頁 console 零 error、375／390／1280 無頁面級水平捲軸。
- 上線後驗證：下一個國定假日（2026-10-09 國慶）當天，Worker 不寫 frame、哨兵不探測、各站頂列顯示休市而非缺漏。

## 4. 驗證

- 各 repo 離線測試全綠；以 09-25（週五假日）／09-28（週一假日）／09-29（假日後首個交易日）重演判級。
- 上線後：`holidays.yml` 手動 dispatch 一次，`data/twse_holidays.json` 的 `closed` 含 `2026-09-25`（09-28 視行事曆實際內容）；
  線上 `/status` 的 flows／postmkt 燈號不再因這兩天變黃／紅。
