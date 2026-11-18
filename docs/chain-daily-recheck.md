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

### 1.9 實作定案（2026-11-18 寫回）

**序列的實際結構（決定了下面幾條怎麼做）**：`series.json` 是 columnar——`dates`＋`market{amt,n,ret_ew,ret_mw,taiex,taiex_ret}`＋
`chains{鏈:{amt,n,share,ret_ew,ret_mw}}`＋`coverage{dup,split,union,topn}`＋`quality{mw_cov,sp0_up,sp0_n,tx_spread0}`＋`meta`，
只存各日**四捨五入後的聚合值**，逐檔原始價不在 git 裡（`backtest/cache/` 被 `.gitignore`，CI 上每次都是空的）。
個股報酬用當日 `spread ÷ (close − spread)`，所以**除兩處外全是單日自足**：`market.taiex_ret`（指數收盤比值，`columnar()` 每次由整條收盤序列現算）
與 `quality.sp0_up／sp0_n`（要前一交易日原始價的診斷欄；2026-08-11 之後 CI 產的日子全是 `null`，實查現行檔 349 日中 67 日為 `null`）。
RS、滾動窗口量都在讀取端（postmkt `rrgd`、`build_overview.py` 來源 E）算，序列不存。

- **§1.1 重抓範圍**：`RECHECK_DAYS = 3`（`src/build_chain_daily.py` 常數段，附理由註解）；一般模式取既有序列最末 3 日（`def recheck_targets`），
  **永遠打 API、不讀 cache**。`--rebuild`（本來就全部重算）與 `--offline`（不打 API）不適用。
- **§1.2 失敗保留**：抓取拋例外／回空／聚合後市場總額為 0 → `days[ds]` 不動、印 `::warning::<日期> …保留既有值`、繼續下一天，`build()` 照常回 0。
  **重抓路徑的聚合／比對／sp0 計算也在同一層保護內**（2026-11-18 驗收後補）：原料形狀異常（字串型數值、缺欄、指數收盤非數值…）造成的任何例外
  → 該日保留既有值、印 `::warning::<日期> 重抓資料無法計算（<例外型別>）`（不印例外內容）、不落 cache、繼續下一日。「新的一天」（序列原本沒有的日期）的既有行為未改：聚合例外照舊往外拋。
- **§1.3 較差資料**（`def recheck_reject_reason`）：序列裡可比的完整性指標只有 `market.n`（當日有列的 twse 個股數）與 `market.amt`，**沒有新增欄位**。
  判準：`n` < 既有 × 0.98，或市場總額 < 既有 × 0.90，或既有有指數收盤而重抓沒有 → 不覆寫＋`::warning::`。
  門檻依據是推論（classify 月更的成員增減遠小於 2%；更正通常讓金額持平或增加），**沒有實測樣本**。
  **限制**：「列數正常但數值是舊值」（06-26 型）這兩個指標看不出來，由第 2 項對帳負責；若真的需要用較差的資料蓋掉（例如首班金額灌水 10% 以上），
  用 `--recheck-dates <日> --recheck-force`。
- **§1.4 後續衍生欄**：`taiex_ret` 由 `columnar()` 現算，重算日與其次日自動一致。`sp0`：既有值 `null` 的日子維持 `null`（否則「資料沒變」也會把
  `null` 填成數字，違反 §1.5）；既有有值的重抓日用新原始價重算（前一日原始價取自本輪剛載入的→cache→內容有變時才現抓一次）；
  `--recheck-dates` 指定較舊日期且內容有變時，緊接其後那天（不在重抓之列者）的 `sp0` 也重算。其餘欄位單日自足，不需連動。
  副作用：重抓日之後才**新抓**的日子，前一日原始價剛好在記憶體 → `sp0` 開始有值（原本 CI 一律 `null`），`meta.spread_zero_up` 的彙總會跟著累計；形狀不變。
- **§1.5 冪等**：輸入沒變時除頂層 `generated_at` 外逐位不變（測試以字串比對）。classify 換版後的第一班，最近 3 日會以新 classify 重算——那是輸入變了。
- **§1.6 `baseline.yml`**：只動「build chain daily」步驟——刪掉 `before=`／`after=` 兩行取 dates 最新一天的 python 一行式，改為
  `same=0; python tools/noop_guard.py --worktree data/chain_daily/series.json || same=$?`，`same=3`（與 HEAD 只差頂層 `generated_at`）才還原；
  該步驟上方的說明註解同步改寫。`tools/noop_guard.py` 新增 `--worktree <path>` 模式（`def worktree_same`，fail-open：讀不到／壞 JSON 一律算有變）。
  Pages dispatch 判斷不必改（commit 步驟有 commit 就 dispatch）。commit／push 重試、紅燈延後、notify-failure 一行未動。
- **§1.7 參數**：`--recheck-dates A,B`（只重抓指定日，取代自動的最近 N 日；不在序列內的日期印 warning）、`--recheck-days N`（0＝關閉）、`--recheck-force`。
  既有參數行為不變（`tests/` 與 `backtest/test_rrg_daily_smoke.py` 全過）。
- **§1.8 請求量**：每班 +3 個全市場單日 `TaiwanStockPrice` 請求（`sp0` 補抓在既有有值且內容有變時才 +1）。同班 `build_baseline.py` 本來就打 21＋3 個同型請求，
  每日 2~3 班 → 每日約多 6~9 個；沿用 `SLEEP = 0.5` 秒間隔。「在額度內」是依量級的推論，未查 FinMind Sponsor 的額度數字。
- **查過的消費者（確認形狀沒變就不受影響）**：本 repo `backtest/run_rrg_daily.py`／`run_rrg_daily_axes.py`／`run_chain_overlap.py`／`test_rrg_daily_smoke.py`；
  本 repo `index.html` 與 `worker/` grep `chain_daily` 零命中（不讀這個檔）；postmkt `index.html` 的 `rrgd` 與 `src/build_overview.py` 來源 E（規格所列，未改形狀故未逐行重讀）。

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

### 2.9 實作定案（2026-11-18 寫回）

- **§2.1 檔名與對照量**：`tools/reconcile_daily.py`＋`.github/workflows/reconcile.yml`。chain_daily 對最近 `RECON_DAYS`（3）個交易日的
  市場總額、市場等權報酬、各鏈日成交額；baseline 在其 `date` 落在對帳日期內時，對 a5（逐檔與已比對個股加總）、a20、創高／破底旗標。
  baseline 的 `y1`／`y2`（要最高最低價）、`it`／`fi`／`its`／`ints`（法人）、`subs_y` 對照檔還原不了，不對帳；`tot5` 本身因對照檔缺約 111~118 檔而不直接比，改比「兩邊都有的個股」的 a5 加總。
- **§2.3 門檻與依據**（2026-10-05～11-18 共 30 個交易日，`series.json` 現行版對 taiwan-flows `origin/main` `bbf7e69` 的逐日檔）：
  | 量 | 門檻 | 實測分布 |
  |---|---|---|
  | 市場總額相對差 | 1% | +0.166%～+0.316%（恆正：對照檔少 64~70 檔 twse 個股） |
  | 市場等權報酬絕對差 | 0.003 | 最大 0.00102 |
  | 單鏈日成交額相對差（兩邊至少一邊 ≥1 億） | 2% | 最大 0.803%（金融，2026-10-30）；每日超過 0.1% 的鏈 1~2 條（金融天天，另偶見水泥） |
  | baseline a5 加總相對差 | 1% | 30 版（2026-10-05～11-18 各日最後一版）皆 <0.001% |
  | baseline a5／a20／旗標不符檔數佔比 | 1%（約 21 檔） | a5 ≤1 檔、a20 3~6 檔、旗標 0~4 檔（已比對約 2,160 檔） |
  單檔 a5／a20「不符」＝相對差 >1% 且絕對差 >10 萬元（濾掉千元捨入與冷門股）。
- **06-26 型事故的估算（模擬，非實際事故資料）**：對 29 個交易日各自把「收盤價最高的 922 檔 twse 個股」換成前一交易日的列。
  (a) 金額與價格都是舊值：市場總額偏 3.85%～47.7%，29/29 天超過 1%，每天至少 42 項不符；
  (b) 只有價格是舊值、金額正確：金額類檢查看不到，市場等權報酬差 0.0014～0.0534，**26/29 天**超過 0.003；
  baseline 最新一日同樣情境：(a) a5 不符 753 檔、a20 398 檔、旗標 245 檔；(b) 旗標 245 檔（門檻約 21 檔）→ 都抓得到。
  所以 (b) 型在「非 baseline 當日」的日子有約一成機會漏掉——序列不存逐檔收盤，這是已知漏洞。06-26 當時 FinMind 的成交金額欄是否也是舊值，**不確定**（taiwan-flows 文件只記載價格）。
- **§2.4 無法對帳**：對照檔 404／壞 JSON／檔內 `date` 不符；taiwan-flows `status.json` 讀不到、`healthcheck.date` < 該日、或等於該日但 `severity` 不是 `ok`／`warn`；
  `series.classify_at` ≠ 現行 `classify.generated_at`；序列沒有該日；baseline 的 21 天對照檔缺任何一天。全部只印 `::warning::`、exit 0。
  **限制**：`status.json` 只描述最新一天，`healthcheck.date` 已超過的日子只能假設當時驗過；issue 本文只有 run 連結（共用 notify-failure action 未改），明細在 run log 與 job summary。
- **§2.5 排程**：`37 23 * * 1-5`（UTC）＝台北週二~六 07:37。taiwan-flows 驗證班 cron 是 `40 15 * * 1-5`（台北 23:40），本 repo baseline 是 Worker 20:05＋cron 21:15；
  家族 cron 延遲實測中位數 2h01m／p90 4h44m／最大 12h23m，07:37 距驗證班約 8 小時。目標日＝台北現在回推 12 小時的日曆日：準點是前一日，
  本班延遲 4 小時 23 分內不變；更久會變成當日，但對帳的是「序列中 ≤ 目標日的最近 3 個交易日」，前一日仍在其中，且對照檔晚到的日子隔天那班會補對。
  目標日休市（週末或行事曆）→ 整班不對帳。`workflow_dispatch` 可帶 `dates`（此時不看目標日，逐日判休市）。
- **§2.6 重用**：`build_chain_daily.aggregate_day`／`keep_codes` 原樣可用（本來就是純函式）。`build_baseline.py` 的逐檔列原本內嵌在 `main()`，
  抽成 `def stock_rows(pd, keep, it, fi, its, net0, y1, y2)`（迴圈本體一字未動）。等價證明：把 `fin.api_get` 換成以 taiwan-flows 21 天逐日檔合成的固定回應，
  同一 process 內分別執行抽出前（`git show 24cd350:src/build_baseline.py`）與抽出後的 `main()`，兩份 `baseline.json` 各 99,116 bytes、sha256 相同（一次性對跑，腳本未進 repo）；
  常駐測試 `tests/test_baseline_stock_rows.py` 以手算小例釘住輸出。
- **§2.8 後續**：`claude-harness/docs/schedule-map.md` 未同步（不在本 repo）；目前沒有帶 `--recheck-dates` 的 workflow 輸入，對帳不符後的修復要在有 token 的環境手動跑。

## 3. 驗收條件

1. Python 測試全過（含新測試）；`worker/` 無任何變動（合併不觸發 Worker 部署）；`data/` 除非第 1 項實跑產生合法差異否則不變。
2. 第 1 項：以真實歷史資料離線重放——取 git 歷史中某一版 series.json 與當時的原料，模擬「最近 3 日被重抓為相同資料」→ 輸出逐位不變；
   模擬「最近某日原料被換成不同值」→ 該日與其後受影響欄位更新、更早日期逐位不變；模擬重抓失敗／回空／列數驟減 → 既有值保留。
   突變測試：把 RECHECK_DAYS 設 0、拿掉失敗保留、拿掉列數防護、後續衍生欄不更新，各自有測試會紅。
3. 第 2 項：對近 30 個交易日的真實資料跑對帳腳本，結果應全數相符或「無法對帳」（調查已知歷史無錯值）；
   人為竄改一日一鏈的數值 → 腳本報不符並列出該日該鏈。workflow YAML 可解析、`bash -n` 通過、權限最小。
4. fresh-context 驗收綁定 commit；文件同步；CANON 區塊不動。
5. 上線後待驗（合併後）：baseline 班 log 出現近 3 日重抓的訊息、series.json 有無因此產生差異；對帳 workflow 第一次排程結果。

### 3.6 實作時的驗收紀錄與限制（2026-11-18 寫回）

- §3.2「取 git 歷史中某一版 series.json 與當時的原料」**做不到原樣**：FinMind 原始列從未進 git。改為 (a) 合成原料（130 個交易日 × 42 檔 × 3 鏈）由 `build()` 自己建出序列再重放；
  (b) 真實 `data/chain_daily/series.json` 配「重抓失敗／回空」的 stub，驗寫回的檔與原檔逐位相同。
- 突變（各自還原後全綠）：`RECHECK_DAYS=0` → 14 項紅；失敗時刪該日 → 3；回空照覆寫 → 1；拿掉較差資料防護 → 3；後續日 `sp0` 不更新 → 1；`taiex_ret` 沿用舊值 → 9；
  對帳：鏈門檻失效 → 3、市場門檻失效 → 1、永遠相符 → 7、對照檔缺漏判不符 → 11、休市日未略過（逐日／目標日）各 1、pending 照對 → 4、baseline 檔數門檻失效 → 2、報酬門檻失效 → 1；
  yml 步驟永遠還原 → 3。
- §3.3 實跑：2026-10-05～11-17 共 29 個交易日全數相符，11-18 因對照檔 `healthcheck.severity=pending` 為無法對帳；baseline 30 個歷史版本全數相符。

