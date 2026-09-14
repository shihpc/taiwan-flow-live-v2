# 交接：主動ETF 補位抓取器與後續四項待辦

> 寫於 2026-08-16（台北）。給接手的下一個 session——**你沒有前一段對話的脈絡，這份要能單獨讀懂**。
> 範圍全部在 `taiwan-flow-live-v2`。動任何制度檔前先讀 `claude-harness/Harness/04-maintenance.md`。
> 文中行號為 2026-08-16 當下（repo HEAD `c0b3581`）；檔案會長，對不上時以函式／關鍵字 grep 為準。

## 0. 一句話現況

FinMind 對 5 家投信的主動ETF 持股慢一個交易日，已對其中 2 家（統一／野村，共 5 檔）做投信端點補位並上線兩週穩定運作；**剩 3 家 5 檔未做**，另有一個補位引發的聚合口徑副作用待修。

## 1. 背景：問題是什麼

`data/aetf/diff.json` 的 `laggards` 每天列出「基準日落後主基準日」的 ETF，它們不併入 `stocks`／`subs` 共識聚合（`src/build_aetf_diff.py:209` 的「誠實分組」）。

2026-07-31 查明根因：**不是投信沒公告，是 FinMind 收得慢**。實測當時 FinMind 對這 10 檔只到 D-1，但投信官網與 MoneyDJ 都已有 D 日持股（00403A 台積電 12,000,000 股逐檔對得上）。落後與否完全由投信決定，固定就是這 5 家：

| 投信 | ETF | 補位狀態 |
|---|---|---|
| 統一 | 00403A、00981A | ✅ 已補（2026-07-31） |
| 野村 | 00980A、00985A、00999A | ✅ 已補（2026-07-31） |
| 中信 | 00406A、00995A | ❌ 待辦 2 |
| 群益 | 00982A、00992A | ❌ 待辦 2 |
| 第一金 | 00994A | ❌ 待辦 2 |

## 2. 已完成：補位抓取器（commit `7c080d5`）

- `src/aetf_fallback.py` — 統一（ezmoney 頁面內嵌 JSON）＋野村（正式 POST API）
- `src/build_aetf.py` — FinMind 主迴圈後接補位，**整段包 try**，補位壞掉不影響主幹
- `tests/test_aetf_fallback.py` — 日期折算離線回歸測試（免 token／網路）

設計原則：FinMind 是主幹（涵蓋 20+ 檔不變），補位只對登記的檔、且**只有拿到比 FinMind 更新的基準日才覆蓋**；抓不到或日期無法折算一律略過，退回補位前行為。每次覆蓋寫進 `latest.json` 的 `fallback_used`（`{code: {issuer, from, to}}`）可稽核。

**實測成效（2026-08-03 ～ 08-14 共 10 個交易日場次）**：5 檔全補位成功 **10／10 場，無一失敗**；落後檔由 10 檔降為 5 檔。

### ⚠ 三個踩過的坑（改這塊之前必讀）

1. **野村的日期是 T+1 標記**。`CPcfdate` 是 PCF 生效日，不是持股基準日——標 `2026/07/31` 的資料內容其實是 07/30 收盤持股（台積電 634,000 股，與 MoneyDJ 標 07/30 的數字相同）。統一的 `TranDate` 則已是實際基準日。弄錯就整批錯一天，而且沒有任何東西會擋。這正是 `src/build_aetf_diff.py:21` 註解說的「原 PCF 的 T+1 標記問題」。

2. **T+1 折算不能寫成「在交易日曆裡找到該日期再往前一格」**。野村標的是**下一個**交易日，執行當下尚未開盤、必然不在日曆內，這樣寫三檔野村會全部折算失敗（2026-07-31 00:23 實測）。正確作法是取「嚴格早於它的最後一個交易日」，見 `resolve_date()`；`tests/test_aetf_fallback.py` 已把這情境釘住。

3. **`src_date` 對外一律連字號**。FinMind 主幹寫 `2026-08-14`，補位內部用斜線比對但輸出前轉回連字號；同一個 `latest.json` 混用兩種格式會讓下游比對出錯（見 `docs/date-semantics.md`）。

### 端點從哪來的

沿用 2026-07-20 遷移 FinMind 前的實作，取自 `git show cdb00eb^:src/build_aetf.py`。當年在生產跑過，不是重新逆向。**待辦 2 的群益端點也在同一份檔案裡**（見下）。

## 3. 待辦 1：`primary` 口徑副作用（我引入的，建議優先修）

`src/build_aetf_diff.py:201`（在 `main()` 內）—

```python
primary = max((d1 for (_, d1, _) in prepared.values()), default=None)
```

主基準日取「各檔最新基準日的**最大值**」。補位之前這是安全的，因為沒有任何檔會超前 FinMind 全站。**補位打破了這個前提**：當 FinMind 全站慢一天時，被補位的 5 檔到達 D 日、其餘 15 檔還在 D-1，於是 `primary = D`，**15 檔全部被判為 laggards、排除在共識聚合外**。

實際發生過一次：

```
2026-08-03.json   補位 5/5   主基準日 2026-08-03   落後 15 檔
其餘 9 場          補位 5/5   主基準日 = 當日        落後  5 檔
```

那天的「進出個股／次產業流向」共識只用 5 檔算出來，而非平常的 15 檔。10 場出現 1 次。

**建議修法**：`primary` 改成「最多檔共用的基準日」（眾數，平手取較大）。它的用途本來就是「同基準日聚合」，用眾數才符合原意；正常日（15 檔 D vs 5 檔 D-1）眾數仍是 D，結果不變。

**✅ 2026-09-14 使用者裁示 A1-2、已實作**：改眾數（平手取大）＋`laggards` 加 `dir` 方向欄，見 `src/build_aetf_diff.py` 的 `pick_primary` 與 CLAUDE.md「晚間 LINE 圖卡」節。

**⚠ 上面第 55 行的成因敘述已過期**：本文寫的是「補位打破了前提」，但 2026-09-14 實查 2026-08-26~09-11 這 14 個交易日的 `data/aetf/2*.json`，**這些檔連 `fallback_used` 這個鍵都不存在**（該鍵只在補位成功時寫入，最後一次出現是 `2026-08-17.json`），超前四檔（`00400A`／`00407A`／`00987A`／`00996A`）**沒有被補位覆蓋過**（無 per-ETF `source: "issuer:*"`；檔案頂層的 `source: "finmind"` 是全檔欄位、不是逐檔欄位）——補位早已不是分岔來源，成因變成 FinMind 對這四家的日期標記系統性快一天（該視窗 9/14 天呈 16/4 分裂）。改口徑的結論不變，理由的內容變了。

**（原文，保留供對照）** 這動到共識聚合口徑，依鐵律 8 必須先問使用者，不得自行改。使用者於 2026-08-16 已知悉此問題但尚未裁示。附帶考量：改後那 5 檔會被標成 laggards，但它們其實是「超前」不是「落後」，欄位語意需一併處理（或加方向欄）。

## 4. 待辦 2：補完剩下 3 家 5 檔

| 投信 | ETF | 端點線索 |
|---|---|---|
| 群益 | 00982A、00992A | **舊碼現成**：`POST https://www.capitalfund.com.tw/CFWeb/api/etf/buyback`，body `{"fundId":"399"/"500","date":null}`（00982A=399、00992A=500）。回傳含 `pcf.date1`／`totUnit`／`nav`。取自 `git show cdb00eb^:src/build_aetf.py` 的 `grab_capital()` |
| 中信 | 00406A、00995A | 無現成碼，要新找 |
| 第一金 | 00994A | 無現成碼，要新找。注意 `fhtrust.com.tw` 是**復華**不是第一金，別搞混 |

**做法**：在 `src/aetf_fallback.py` 的 `FETCHERS` 登記表加 code → (投信, 抓取函式)，並新增對應 `grab_*()`。每家都要確認 `pcf_offset`（0 或 -1）——**不要假設**，用「抓到的日期 vs MoneyDJ 對同一檔顯示的資料日期＋台積電股數」交叉驗證，方法見第 2 節。加完記得補 `tests/test_aetf_fallback.py` 的登記表斷言。

驗證指令：

```bash
python3 src/aetf_fallback.py          # 單獨實跑，印各檔基準日與台積電股數，不寫檔
python3 tests/test_aetf_fallback.py   # 離線回歸測試
```

## 5. 待辦 3：兩檔完全無資料

`latest.json` 的 `errors`：

```json
{"00408A": "Holding 近 14 日無資料", "00410A": "Holding 近 14 日無資料"}
```

`00408A` 至少從 2026-07-24 起就沒資料（連續 6 個日檔皆缺），`00410A` 是 2026-08 新出現的。兩檔等於從比較表裡消失。**尚未查原因**——可能是 FinMind 未涵蓋、代號變更、或新上市尚未揭露。查法：先打 FinMind `TaiwanStockActiveETFInfo` 看它們在不在清單、再對 MoneyDJ／投信官網確認是否真的有公告。

## 6. 待辦 4：LINE 圖卡「主動ETF 比較卡」（使用者要求，尚未提方案）

使用者要把 **postmkt 盤後分析站「主動ETF」tab 的「主動ETF 比較」做成送到 LINE bot 的圖卡**。

現況調查結果：

- 來源 UI 在 `postmkt/index.html:714` 的 `aetfCmpBlockHtml()`：最多 4 檔並排，每欄有代號／名稱／資料日，底下分新增／加碼／減碼／出清四類迷你表（個股、漲跌%、張數、市值億），選擇存 localStorage `pm_aetf_cmp`
- 圖卡體系在本 repo：`worker/src/index.js` 的 `FX_CARD_BUILDERS` ＋ `FX_ACTIVE_CARDS`（`worker/src/index.js:2232`，目前 11 張白名單），規格在 `docs/line-cards-spec.md`
- **白名單裡已經有一張 `pm-aetf-5` 主動ETF進出個股**，新卡要跟它區隔清楚
- **額度不是問題**：實測本帳號 `GET /v2/bot/message/quota` 回 `{"type":"limited","value":200}`，每月 200 則，目前用 22 則（11%），見 spec 第 1 節
- **門檻是規格流程**：`docs/line-cards-spec.md` §3B 卡別分類（A 純描述／B 排行榜／C 訊號）與 §3C 內容裁剪（2026-07-30 才剛從 39 張裁到 11 張，使用者授權全權評選）。新增卡要走這個流程，且 §3B.3 的 C 類「回測前不得上線」

尚未決定：這張卡屬 A 類（純描述持股異動事實）還是 B/C 類；要放進 carousel 哪一組；是否要取代既有某張。

## 7. 環境備忘

- Hetzner `claude-server`（62.238.17.73），repo 在 `/root/projects/`，`ssh claude-server` 直接進。三地作業與跨機同步見 `claude-harness/Harness/server-hetzner.md`
- 從 Windows 操作伺服器**只用 Windows OpenSSH（PowerShell），不要用 Git Bash 的 ssh**（家目錄含中文會讓它讀不到 `~/.ssh/`）；遠端執行一律「本機寫 .sh → 去 BOM/CRLF → `scp` → `ssh host bash /tmp/x.sh`」，直接把指令字串塞進 ssh 會被 PowerShell 先展開一輪（教訓見 `claude-harness/Harness/lessons.md` 2026-07-27 那則）
- `src/build_aetf.py` 實跑會覆寫 `data/aetf/<run_date>.json` 與 `latest.json`；本機測完記得 `git checkout -- data/aetf/` 還原
- Worker 部署：`cd worker && . ~/.claude-env && npm run deploy`（`~/.claude-env` 存 `CLOUDFLARE_API_TOKEN`，chmod 600，不自動載入）

## 8. 相關檔案索引

| 檔案 | 用途 |
|---|---|
| `src/aetf_fallback.py` | 補位抓取器（本次新增） |
| `src/build_aetf.py` | 每日快照；補位接在主迴圈後 |
| `src/build_aetf_diff.py` | 跨日比對；`:201` primary、`:209` 誠實分組 |
| `tests/test_aetf_fallback.py` | 日期折算回歸測試 |
| `data/aetf/latest.json` | 含 `fallback_used`、`errors` |
| `data/aetf/diff.json` | 含 `primary_date`、`laggards` |
| `docs/line-cards-spec.md` | LINE 圖卡規格（待辦 4） |
| `postmkt/index.html:714` `aetfCmpBlockHtml()` | 比較 UI 原型（待辦 4 的內容來源） |
