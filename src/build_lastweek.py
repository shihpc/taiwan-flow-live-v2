# src/build_lastweek.py — 只重建 data/lastweek.json（上週各工作天成交值加總）
#
# V2：即時 live.json 由 Cloudflare Worker 產，GitHub Actions 只負責這份「重但一週一次」的靜態檔。
# 重用 snapshot._lastweek()（含週快取：同一週已建則不重抓）。Worker 從 repo raw 抓 lastweek.json。
#
# 用法：FINMIND_TOKEN=... python src/build_lastweek.py

from __future__ import annotations
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import snapshot  # noqa: E402

if __name__ == "__main__":
    lw = snapshot._lastweek()
    # 補寫 generated_at（前端顯示資料更新時間用）；快取命中時也刷新，代表「本次確認過」
    lw["generated_at"] = datetime.now(timezone(timedelta(hours=8))).isoformat()
    out = Path(__file__).resolve().parent.parent / "data" / "lastweek.json"
    out.write_text(json.dumps(lw, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n = len(lw.get("stocks", {}))
    tot = lw.get("tot", {})
    print(f"lastweek week={lw.get('week')} stocks={n} "
          f"twse={tot.get('twse', 0)/1e8:.0f}億 tpex={tot.get('tpex', 0)/1e8:.0f}億")
