# chain_daily 近日重抓＋延後對帳——規格與驗收條件（2026-11-18）

目標專案：`/home/user/taiwan-flow-live-v2`（shihpc/taiwan-flow-live-v2）。不動 `worker/**`、不改任何產物的鍵名與形狀。

## 0. 起因（調查結論，2026-11-18）

- `src/build_chain_daily.py` 對全市場單日 `TaiwanStockPrice` 採「非空即採用」，且已在 `data/chain_daily/series.json` 的日期
  **不重抓、不重算**（`if ds in days: continue`）。`baseline.yml` 晚班又有「最新日不變→還原」的步驟。
  → 首班若抓到未更新完的資料（taiwan-flows 2026-06-26 事故同一資料集：2687 檔中 922 檔為暫定值），錯值會**永久留在序列裡**，
  影響 postmkt 輪動雷達（12 日窗）與市場總覽來源 E 十餘日，且沒有任何機制會發現。
- 歷史檢查（67 版 series.json、349 個日期、以 taiwan-flows 已驗證的 `data/daily` 重算 169 日）：**未觀察到**此類錯值，
  市場總額差異最大 0.74%。所以本批是預防性修正，不需要重建既有資料。
- `data/baseline.json` 每班 21 天全部重抓、整檔覆寫，晚班會自癒，不在本批修改範圍；但它同樣沒有對帳機制，納入第 2 項的對帳對象。

## 1. 第 1 項：chain_daily 每班重抓重算最近 N 個交易日

1. `build_chain_daily.py` 一般（增量）模式下，序列中**最近 `RECHECK_DAYS`（預設 3）個交易日**即使已存在也重新抓取並重算，
   以新值覆寫；更早的日期維持不動（不重抓）。常數集中宣告、有註解說明理由。
2. 重抓失敗（API 失敗／回空）時**保留既有值、不得刪除或清空該日**，並印 `::warning::`；不得因此讓整班失敗。
3. 重抓得到的資料若明顯不如既有值完整（列數顯著少於既有值所依據的列數，或實作者能取得的等價健全性指標），不得覆寫——
   避免「晚班抓到更差的資料把好資料蓋掉」。判準與門檻由實作者依實際可得資訊訂定並寫回本節；做不到就明說限制。
4. 依賴前一日的衍生欄（報酬、RS、任何滾動窗口量）在被重算日之後的日期必須保持一致：重算某日後，凡輸入包含該日的後續欄位都要跟著更新，
   不得出現「當日 amt 已更新但次日的報酬仍用舊收盤」的不一致。
5. 序列形狀、鍵名、日期集合、排序不變；輸入資料沒變時輸出**逐位不變**（冪等）。
6. `baseline.yml` 中與 chain_daily 相關的「最新日不變→還原」步驟改為比**內容**：內容有變才 commit，內容沒變不產生 commit 噪音。
   notify-failure、commit/push 重試、其餘步驟一行不動。若因此需要 Pages dispatch 判斷同步調整，一併處理並說明。
7. 既有的 `--rebuild`／`--refetch-stale` 等參數行為不變。另加一個「指定日期重算」的參數（例如 `--recheck-dates 2026-11-17,2026-11-18`），
   供日後發現單日錯值時手動修復，不必重抓全部歷史。
8. FinMind 請求量：每班多抓 N 天的全市場單日資料，說明新增的請求數與是否在既有節流／額度內。

## 2. 第 2 項：免 token 的延後對帳 workflow

1. 新增腳本（例如 `tools/reconcile_daily.py`）＋ workflow（例如 `.github/workflows/reconcile.yml`）：
   以 taiwan-flows raw main 的 `data/daily/<YYYYMMDD>.json`（該站有延後驗證班）為對照，重算並比對：
   - `data/chain_daily/series.json` 最近 K 個交易日各鏈的日成交額與市場總額；
   - `data/baseline.json` 可比的量（調查時用的是 5 日成交額合計與新高新低；以實際可逐檔還原者為準）。
2. **只讀、免 token、不 commit、不寫任何資料檔**；`permissions` 僅 `contents: read`＋`issues: write`。
3. 判準：市場總額相對差 > 1%，或單一鏈相對差超過門檻（實作者依調查的實測分布訂定，需容忍已知的口徑差：對照檔缺約 280 檔特別股等，
   金融、水泥兩鏈平時就有約 0.1–0.5% 的差）→ 視為不符。門檻與理由寫回本節。
4. 不符時 workflow 失敗並走既有 `./.github/actions/notify-failure`（`pipeline: v2-reconcile`）開 issue，訊息列出不符的日期、鏈名、兩邊數值與相對差；
   對照檔讀不到（404、該日尚未產出、taiwan-flows 當日 healthcheck 尚為 pending）屬「無法對帳」，**不得判不符**，印 warning 後正常結束。
5. 排程：排在 taiwan-flows 延後驗證班（台北 23:40）與本 repo baseline 晚班之後、且避開台北午夜跨日造成目標日滾動的時段；
   只在台北交易日的隔日清晨對前一交易日對帳亦可。cron 與理由寫回本節。另提供 `workflow_dispatch`（可指定日期）。
   休市日（`src/twse_holidays.py`）不對帳。
6. 腳本的重算邏輯必須**重用** `build_chain_daily.py`／`build_baseline.py` 的既有函式（import），不得另寫一份口徑。
7. `tests/` 新增離線測試：相符、市場總額超標、單鏈超標、已知口徑差在容忍內、對照檔缺漏不誤判、休市日略過。
8. 文件：CLAUDE.md（workflow 支數、notify-failure 清單、新節）、PROJECT_SUMMARY.md 相關段同步；`claude-harness/docs/schedule-map.md` 不在本 repo，列為後續。

## 3. 驗收條件

1. Python 測試全過（含新測試）；`worker/` 無任何變動（合併不觸發 Worker 部署）；`data/` 除非第 1 項實跑產生合法差異否則不變。
2. 第 1 項：以真實歷史資料離線重放——取 git 歷史中某一版 series.json 與當時的原料，模擬「最近 3 日被重抓為相同資料」→ 輸出逐位不變；
   模擬「最近某日原料被換成不同值」→ 該日與其後受影響欄位更新、更早日期逐位不變；模擬重抓失敗／回空／列數驟減 → 既有值保留。
   突變測試：把 RECHECK_DAYS 設 0、拿掉失敗保留、拿掉列數防護、後續衍生欄不更新，各自有測試會紅。
3. 第 2 項：對近 30 個交易日的真實資料跑對帳腳本，結果應全數相符或「無法對帳」（調查已知歷史無錯值）；
   人為竄改一日一鏈的數值 → 腳本報不符並列出該日該鏈。workflow YAML 可解析、`bash -n` 通過、權限最小。
4. fresh-context 驗收綁定 commit；文件同步；CANON 區塊不動。
5. 上線後待驗（合併後）：baseline 班 log 出現近 3 日重抓的訊息、series.json 有無因此產生差異；對帳 workflow 第一次排程結果。
