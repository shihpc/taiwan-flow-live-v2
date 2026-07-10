# taiwan-flow-live-v2

台股盤中資金流向監控網頁 — V1（`taiwan-flow-live`）的即時性升級版，**與 V1 完全獨立、不覆蓋**。

線上網址：https://shihpc.github.io/taiwan-flow-live-v2/

## 與 V1 的差異

| | V1 (taiwan-flow-live) | V2 (本專案) |
|---|---|---|
| 即時資料 | GitHub Actions 抓快照 → commit `live.json` → Pages | **Cloudflare Worker** 即時抓 `tick_snapshot` 聚合後回傳 |
| 更新方式 | 「🔄更新」觸發 workflow_dispatch（需 PAT）+ 輪詢 raw，延遲 1–2 分 | 前端直接讀 Worker `/live`，**秒級**；含 ⏱ 自動刷新 |
| token 安全 | repo secret（Actions 內） | Worker secret，前端不碰、**免 PAT** |

## 架構

```
【夜間 / 開盤前】GitHub Actions（Python，src/*.py）
  ├─ baseline.yml   (20:30 台北) → 個股5日均額/投信外資買賣超/前日訊號/法人強度/破底
  ├─ lastweek.yml   (週一09:00) → 上週各日成交值（次產業佔比分母）
  ├─ us.yml         (06:00 台北) → 昨夜美股指數/ADR/個股價量 + 規則式盤勢分析
  ├─ morning.yml    (06:20 台北) → 晨報：開盤參考/籌碼/驗證訊號/策展新聞
  ├─ aetf.yml       (18:30 台北) → 5檔主動ETF每日持股快照 + 跨日主動加減碼diff
  └─ pages.yml      (每次push)  → 部署到 GitHub Pages

【盤中】Cloudflare Worker（JS，worker/src/index.js）
  └─ 每分鐘 cron 抓 FinMind tick_snapshot → 存入 KV（分鐘級序列）
  └─ /live 端點：即時聚合 + 資金湧入/退出指標，stale-while-revalidate 快取15s

【前端】純 HTML/JS 單檔（index.html）
```

聚合邏輯（成交值／佔比／貢獻點／漲跌家數，依加權/櫃買分市場）與部分前端 UI 沿用 V1，見 `src/snapshot.py`。

## 目前功能（7 個頁籤）

1. **產業別 / 產業鏈 / 成交佔比**（V1 沿用）：交易所產業分類即時成交值、漲跌、貢獻點數；產業鏈多對多分類；個股成交佔比排行。
2. **資金湧入 / 資金退出**：短窗資金集中度（近N分鐘佔全市場成交比 ÷ 該股/次產業5日常態佔比）排行，含前日訊號標註（連湧/昨湧/連退/昨退）、法人強度、破底標記。次產業排行與個股排行的解讀方式不同（詳見 `PROJECT_SUMMARY.md` 的回測發現）。
3. **晨報**：開盤參考（台指期夜盤 vs 現貨收盤）、隔夜美股三大指數+費半、台股ADR溢價、昨日備忘（湧入/退出/籌碼）、驗證訊號、策展新聞、美股自選清單（跨裝置同步）。
4. **主動ETF**：追蹤 5 檔大型主動式ETF 的每日規模、主動加減碼（排除申購贖回等比縮放效應）、進出個股表（合計+各ETF明細）、次產業流向。

所有資金流訊號都先經過歷史回測驗證（`backtest/` 目錄）才上線，不做未經驗證的預測性宣稱。專案背景與技術決策細節見 `PROJECT_SUMMARY.md`。

## 設定

前端 `index.html` 最上方 `CFG`：
- `worker`：Cloudflare Worker 網址（結尾不要斜線）。**留空時**讀靜態 `data/live.json`（無即時）。
- `autoSec`：自動刷新間隔秒數（預設 20）。

## 本機開發

```
set FINMIND_TOKEN=...
python src/server.py     # http://127.0.0.1:8899，/api/refresh 即時重算
```

Python 依賴見 `requirements.txt`；Cloudflare Worker 開發見 `worker/`（`wrangler.toml`、`npm test` 對應 `worker/test/`）。

## 部署

GitHub Pages（Actions 部署，`.github/workflows/pages.yml`；**不用** legacy Jekyll builder）。push 到 main 自動重部署。各排程 workflow 見 `.github/workflows/`。
