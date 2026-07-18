# src/archive_intraday.py — 盤中資料歸檔（第七期 7a）
#
# 動機：Worker KV frame TTL 僅 2 天、series 也非永久；不歸檔，盤中訊號回測（7b）就沒有原料。
# 排程：.github/workflows/intraday.yml 平日台北 14:10（收盤後、frame 尚在 TTL 內）＋ workflow_dispatch。
#
# 做法：
#   1. GET {WORKER}/replay?date=D（不帶 t）→ 全日市場分鐘序列 [{t,amt,idx,chg},...] 原樣保存。
#   2. 對 09:05–13:30 每 5 分鐘時點 GET /replay?date=D&t=HH:MM 取 frame
#      （{t,src_ts,stale,stocks:{code:[累計成交額(元),現價]}}；Worker 缺格自動往前回退 ≤5 分）。
#   3. 用 data/classify.json 的 p（[[產業鏈,次產業],...]）聚合出「次產業 × 時點」累積成交額矩陣。
#      口徑與 Worker computeFlow 一致：每檔對其 p 去重後的每個次產業各加一次（多對多）。
#      個股層級太大不存——回測主角本來就是次產業。
#   4. 輸出 data/intraday/YYYY-MM-DD.json（欄名精簡，實測 <300KB，遠低於 2MB 上限）。
#   5. 非交易日/frame 全缺 → 印訊息 exit 0 不寫檔（優雅退出）；個別時點缺格 → 該時點記 null。
#
# KV 讀量估算（寫給未來自己）：54 時點 × ≤6 get（缺格回退上限）＋ series 1 get ≈ ≤325 讀/日，
#   遠低於 Cloudflare KV 免費額度 10 萬讀/日；Worker 端另有 max-age=60 快取吸收重試。
#
# 用法：python src/archive_intraday.py [--date YYYY-MM-DD]（預設台北今日）

from __future__ import annotations
import argparse
import json
import sys
import time
import io
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
WORKER = "https://taiwan-flow-v2.shihpc.workers.dev"
OUT_DIR = ROOT / "data" / "intraday"
TPE = timezone(timedelta(hours=8))
HEADERS = {"User-Agent": "archive-intraday/1.0"}


def get_json(url: str, retries: int = 3) -> dict:
    """GET＋輕量重試（Worker 錯誤一律 200＋{error}，這裡只擋網路層瞬斷）。"""
    last = None
    for i in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"GET {url} 失敗：{last}")


def timepoints() -> list[str]:
    """09:05–13:30 每 5 分鐘，共 54 個時點。"""
    return [f"{m // 60:02d}:{m % 60:02d}" for m in range(9 * 60 + 5, 13 * 60 + 31, 5)]


def load_classify() -> dict:
    cl = json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))
    return cl["map"]


def build(date: str) -> int:
    cl = load_classify()
    series = get_json(f"{WORKER}/replay?date={date}").get("series") or []

    times = timepoints()
    frames_meta: list[dict | None] = []   # 各時點實際命中 frame 的 {t, stale}；缺格 = None
    total: list[int | None] = []          # 各時點全市場累積成交額合計（元）
    nstk: list[int | None] = []           # 各時點 frame 內個股數（sanity 用）
    groups: dict[str, list[int | None]] = {}   # 次產業 → 各時點累積成交額（元）
    n_hit = 0

    for i, t in enumerate(times):
        f = get_json(f"{WORKER}/replay?date={date}&t={t}")
        stocks = f.get("stocks")
        if f.get("error") or not stocks:
            frames_meta.append(None)
            total.append(None)
            nstk.append(None)
            for arr in groups.values():
                arr.append(None)
            continue
        n_hit += 1
        frames_meta.append({"t": f.get("t"), "stale": 1 if f.get("stale") else 0})
        tot = 0
        cnt = 0
        agg: dict[str, int] = {}
        for code, v in stocks.items():
            if not isinstance(v, (list, tuple)) or not v or v[0] is None:
                continue
            amt = v[0]
            tot += amt
            cnt += 1
            info = cl.get(code)
            if not info or not info.get("p"):
                continue
            for sname in {p[1] for p in info["p"]}:   # 口徑同 Worker computeFlow（去重多對多）
                agg[sname] = agg.get(sname, 0) + amt
        total.append(round(tot))
        nstk.append(cnt)
        for sname, a in agg.items():
            if sname not in groups:
                groups[sname] = [None] * i + [None]   # 補齊前面缺的時點
            groups[sname][i] = round(a)
        for sname, arr in groups.items():
            if len(arr) <= i:
                arr.append(None)

    if n_hit == 0:
        # 非交易日 / frame 全缺（TTL 已過或當日停班）→ 優雅退出，不寫檔
        print(f"{date}：全部 {len(times)} 個時點皆無 frame（series {len(series)} 筆）→ 不歸檔，正常退出")
        return 0

    out = {
        "date": date,
        "generated_at": datetime.now(TPE).isoformat(timespec="seconds"),
        "unit": "元",
        "series": series,          # 全日市場分鐘序列原樣（{t,amt,idx,chg}）
        "times": times,            # 54 個 5 分鐘時點
        "frames": frames_meta,     # 各時點實際命中的 frame 分鐘與 stale 旗標
        "total": total,            # 全市場累積成交額（含未分類個股）
        "nstk": nstk,              # frame 個股數
        "g": groups,               # 次產業 × 時點 累積成交額矩陣（回測主原料）
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{date}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    kb = path.stat().st_size / 1024
    print(f"{date}：命中 {n_hit}/{len(times)} 時點、{len(groups)} 個次產業、series {len(series)} 筆 → {path.name}（{kb:.0f} KB）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.now(TPE).strftime("%Y-%m-%d"),
                    help="歸檔日期（預設台北今日；KV TTL 2 天，只有近兩日有 frame）")
    args = ap.parse_args()
    if not len(args.date) == 10:
        print(f"date 格式需為 YYYY-MM-DD：{args.date}", file=sys.stderr)
        return 1
    return build(args.date)


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    raise SystemExit(main())
