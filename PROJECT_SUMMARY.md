# Taiwan Flow Live V2 — 專案總結（供 Claude Project 使用）

最後更新：2026-07-18（「即時一覽」tab 五期全數完工）

## 快速接手

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
- 未解問題：各投信 PCF 解析器是脆弱依賴（改版要手動修）；復華端點 `diff` 欄位含義未完全確認。
- 改 `data/morning.json` 或 `data/aetf/*` 輸出格式前，**必讀**工作區
  `Harness/site-architecture-20260710.md`（下游讀取點清單），否則會弄壞姊妹站。

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
  ├─ aetf.yml       (18:30 台北) → 8檔主動ETF持股快照 + 主動加減碼diff（前端在盤後分析站）
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

### 外供管線 B. 主動ETF（前端已移至「盤後分析」站）
`src/build_aetf.py`＋`build_aetf_diff.py`（aetf.yml 18:30）追蹤 **8 檔**主動式ETF
（00400A/00403A/00405A/00980A/00981A/00982A/00991A/00992A，含國泰用權重反推股數）：
- 每日 AUM 規模與持股快照（`data/aetf/YYYY-MM-DD.json`）
- **主動加減碼**（排除申購贖回造成的等比縮放效應——技術核心）→ `diff.json`
- 排程自動化已驗證運作（07-05 起每日快照正常累積）

---

## 三、關鍵技術決策與踩過的雷

| 主題 | 決策/教訓 |
|---|---|
| 即時架構選型 | 否決「前端直連FinMind」（會曝付費token）、否決「Render跑Python」（冷啟動10-30s傷即時）；選 Cloudflare Worker |
| Worker 快取 | 從固定TTL改成 **stale-while-revalidate**（過期先回舊資料+背景重建），解決「每20秒卡2-5秒」的使用者體感問題 |
| KV 額度 | **list 操作**免費版僅1000次/日、曾爆額度導致集中度失效數小時；改用「時間索引key」讓 pickFrames 只用 get（10萬次/日額度）|
| GitHub Pages 部署 | 曾連續故障（GitHub服務端事故），已把 `pages.yml` 改成 `cancel-in-progress:false`(排隊)+ artifact名帶run_id，雙保險 |
| 各投信PCF端點 | 四家以上格式全不同，各自逆向工程找到端點；此為長期維護風險點——任何一家改版就要修解析器 |
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

- [ ] 各投信PCF解析器是脆弱依賴，改版需手動修
- [ ] 復華端點的 `diff` 欄位含義未完全確認（可能是官方持股異動，待驗證）
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
