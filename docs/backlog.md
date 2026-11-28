# 待辦與已知事項（backlog）

依鐵律第 5 條：範圍外問題記在這裡，不只寫在 PR 說明。每筆寫明來源與登錄日；處理完就刪掉該筆（歷史看 git）。
「現況未查證」表示該筆抄自既有文件，登錄時沒有重新確認。

## 待使用者決定
- **baseline 法人欄位首班暫定值**（2026-11-18 調查）：台北 20:06 首班的法人欄位常為暫定值（87 對早晚版有 58 對不同），晚班會自行更正。選項：維持現狀／畫面標示暫定／延後首班。

## 上線後尚未回查
- us.json `date` 改眾數後，清晨美股班在混合日期期間的實跑（PR #20，2026-11-18）。
- chain_daily 每班重抓最近 3 日：baseline 班 log 是否出現「近日重抓 3 天」、`series.json` 有無因此變動（PR #21）。
- `reconcile.yml` 第一次排程結果（PR #21）。
- aetf 群益補位三項未驗證（fundId 504、端點欄位、T+1 語意），細節見 `docs/handoff-archive.md`。現況未查證。

## 待處理
- `worker/src/index.js` 有三處註解寫細節「見 CLAUDE.md」（約 :1241 撞點比對、:4548 管理端點路由表、:4663 休市角色表），那些內容已移到 `docs/handoff-archive.md`。改註解會觸發 Worker 部署，下次動 Worker 時順手改。
- `claude-harness/docs/schedule-map.md` 尚未補 `reconcile.yml` 與 chain_daily 重抓。現況未查證。
- `GH_DISPATCH_TOKEN` 實際涵蓋哪些 repo 未直接驗證（文件記五個）。
- revenue 主觸發：整個月都沒產出時沒有專門告警（已知限制 8）。
- `/line/webhook` 未驗 `x-line-signature`。
- `src/meta.py` 寫入 `classify.json` 前未消毒 FinMind 字串（前端已有 `escI()`；改上游屬跨站變更）。
- `CLAUDE.md` 跨站消費者清單只列本檔原記載者，postmkt 市場總覽讀的幾支檔未列全。
