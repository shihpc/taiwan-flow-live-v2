# src/build_lastweek.py — 只重建 data/lastweek.json（上週各工作天成交值加總）
#
# V2：即時 live.json 由 Cloudflare Worker 產，GitHub Actions 只負責這份「重但一週一次」的靜態檔。
# 重用 snapshot._lastweek()（含週快取：同一週已建則不重抓）。Worker 從 repo raw 抓 lastweek.json。
#
# 用法：FINMIND_TOKEN=... python src/build_lastweek.py

from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import snapshot  # noqa: E402

if __name__ == "__main__":
    lw = snapshot._lastweek()
    n = len(lw.get("stocks", {}))
    tot = lw.get("tot", {})
    print(f"lastweek week={lw.get('week')} stocks={n} "
          f"twse={tot.get('twse', 0)/1e8:.0f}億 tpex={tot.get('tpex', 0)/1e8:.0f}億")
