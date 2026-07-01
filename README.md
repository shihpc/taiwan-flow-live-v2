# taiwan-flow-live-v2

台股盤中**即時資金流向**手機網頁 — V1（`taiwan-flow-live`）的即時性升級版，**與 V1 完全獨立、不覆蓋**。

## 與 V1 的差異

| | V1 (taiwan-flow-live) | V2 (本專案) |
|---|---|---|
| 即時資料 | GitHub Actions 抓快照 → commit `live.json` → Pages | **Cloudflare Worker** 即時抓 `tick_snapshot` 聚合後回傳 |
| 更新方式 | 「🔄更新」觸發 workflow_dispatch（需 PAT）+ 輪詢 raw，延遲 1–2 分 | 前端直接讀 Worker `/live`，**秒級**；含 ⏱ 自動刷新 |
| token 安全 | repo secret（Actions 內） | Worker secret，前端不碰、**免 PAT** |

## 架構

```
瀏覽器(Pages 靜態) ──每 CFG.autoSec 秒──▶ Cloudflare Worker /live
                                            │  (FINMIND_TOKEN 藏在 Worker)
                                            ├─ 快取 < N 秒 → 直接回傳
                                            └─ 否 → 抓 tick_snapshot + 聚合 → 快取 → 回
Worker 依賴的兩份靜態檔（從 Pages 抓、快取整天）：
   data/classify.json  分類表（meta.py 本機偶爾重建）
   data/lastweek.json  上週欄位（每週一 GitHub Action 重建）
```

聚合邏輯（成交值／佔比／貢獻點／漲跌家數，依加權/櫃買分市場）與前端 UI 沿用 V1，見 `src/snapshot.py`。

## 進度

- [x] **① repo + 前端骨架**：複製 V1 前端，更新機制改為讀 Worker `/live` + ⏱ 自動刷新開關（`CFG.worker` 填 Worker 網址後生效；留空則退化讀靜態 `data/live.json`）。
- [ ] ② Cloudflare Worker：移植 `snapshot.py` 聚合迴圈、`/live` 端點、快取、token secret。
- [ ] ③ lastweek 自動化：每週一 cron 的 Action 產 `data/lastweek.json`。
- [ ] ④ 接線驗證：FinMind 是否接受 Worker 出口、盤中即時性、多開不爆量。
- [ ] ⑤ 上 hub 首頁加 V2 卡片。

## 設定

前端 `index.html` 最上方 `CFG`：
- `worker`：Cloudflare Worker 網址（結尾不要斜線）。**留空時**讀靜態 `data/live.json`（無即時）。
- `autoSec`：自動刷新間隔秒數（預設 20）。

## 本機開發

```
set FINMIND_TOKEN=...
python src/server.py     # http://127.0.0.1:8899，/api/refresh 即時重算
```

## 部署

GitHub Pages（Actions 部署，`.github/workflows/pages.yml`；**不用** legacy Jekyll builder）。push 到 main 自動重部署。
