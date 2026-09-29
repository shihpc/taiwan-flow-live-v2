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

**批次二（本批不做，另案）**：各站前端（postmkt `pmStatus` 等、taiwan-flows `siteStatus`、v2 `prevWeekday`／`ovRrgTaipeiToday`、
taiwan-backtest `ledgerStatus`）、Worker 其他班（`runSentinel` 假日空打、`runHealthCheck` 假日告警、`runTickSample`、`runMorning`）、
v2 `build_baseline.py` 假日空等。

## 4. 驗證

- 各 repo 離線測試全綠；以 09-25（週五假日）／09-28（週一假日）／09-29（假日後首個交易日）重演判級。
- 上線後：`holidays.yml` 手動 dispatch 一次，`data/twse_holidays.json` 的 `closed` 含 `2026-09-25`（09-28 視行事曆實際內容）；
  線上 `/status` 的 flows／postmkt 燈號不再因這兩天變黃／紅。
