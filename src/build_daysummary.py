#!/usr/bin/env python3
"""第八期：收盤總結落檔（daysummary）。

收盤後拉 Worker /live（13:30 收盤定格快照）＋全日 series，重算「即時一覽收盤
總結卡」同口徑的全日總結，落到 data/daysummary/YYYY-MM-DD.json 與 latest.json，
供 taiwan-stock-news 晨報「昨日資金流向」段跨 repo raw 讀取。

口徑（與 index.html ovSummaryCard 第五期實作逐項對齊）：
- 個股貢獻排行：僅上市（classify t=="twse"），欄位 pts（貢獻點）；
  top5 取 pts>0 降序前 5、bot3 取 pts<0 升序前 3。
- 次產業聚合：classify.json map[code].p 多對多**去重**（{p[1] for p in p}，
  每個次產業各加一次全額、不切權重；同前端 ovComputeSubAgg 與 archive_intraday.py）；
  成分股數 n>=3 才納入（同前端 filter(s=>s.n>=3)）。
- 佔比最高：次產業 amt 降序第一；佔比 = (amt/1e8)/market.tse.amt_yi*100。
- 「升幅最大」：收盤後無盤中近30分基準（f30/flow 只在盤中有），依總結卡註解
  「以全日貢獻點最高口徑呈現」→ pts_top = 次產業 pts 降序第一（須 >0）。
- 定調句：同卡模板（去掉「今日」前綴以便晨報以「昨日」語境引用）：
  「大盤 ±X.X 點（±X.XX%）；廣度 漲U／跌D；全日成交佔比最高 A（P%），貢獻最強 B（±X.X 點）。」
- 全日高低：series 的 idx（加權指數）max/min。

非交易日防呆：/live 定格日期 != 目標日期 → 優雅退出（exit 0、不寫檔）。
保留近 30 個交易日檔（latest.json 不計）。
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
WORKER = "https://taiwan-flow-v2.shihpc.workers.dev"
OUT_DIR = ROOT / "data" / "daysummary"
TPE = timezone(timedelta(hours=8))
HEADERS = {"User-Agent": "build-daysummary/1.0"}
KEEP_DAYS = 30


def get_json(url: str, retries: int = 3) -> dict:
    """GET＋輕量重試（同 archive_intraday.py 慣例）。"""
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


def load_classify() -> dict:
    cl = json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))
    return cl["map"]


def sgn_txt(v: float) -> str:
    """同前端 sgnTxt：正數帶 +，固定 1 位小數。"""
    return ("+" if v > 0 else "") + f"{v:.1f}"


def pct_txt(v) -> str:
    """同前端 pctTxt：正數帶 +，固定 2 位小數＋%。"""
    if v is None:
        return "—"
    return ("+" if v > 0 else "") + f"{v:.2f}%"


def clean_sub(s: str) -> str:
    """同前端 cleanSub：去掉括號起的說明尾巴。"""
    import re

    return re.sub(r"\s*[（(].*$", "", s or "")


def build(date: str) -> int:
    live = get_json(f"{WORKER}/live?t={int(time.time()*1000)}")
    ts = (live.get("ts") or "")[:10]
    if ts != date:
        # 非交易日（/live 定格停在前一交易日）或 Worker 無當日資料 → 優雅退出
        print(f"{date}：/live 定格日期為 {ts or '（無）'}，非目標日期 → 不落檔，正常退出")
        return 0

    cl = load_classify()
    cols = live.get("stock_cols") or []
    idx = {c: i for i, c in enumerate(cols)}
    if "pts" not in idx or "amt" not in idx:
        print(f"stock_cols 缺 pts/amt：{cols}", file=sys.stderr)
        return 1
    i_pts, i_amt, i_chg = idx["pts"], idx["amt"], idx.get("chg")

    # ---- 個股貢獻排行（僅上市，同 ovSummaryCard）----
    rows = []
    for code, v in (live.get("stocks") or {}).items():
        info = cl.get(code)
        if not info or info.get("t") != "twse":
            continue
        if not isinstance(v, (list, tuple)) or len(v) <= i_pts:
            continue
        pts = v[i_pts] or 0
        if not pts:
            continue
        rows.append({"c": code, "n": info.get("n") or code, "pts": round(pts, 2)})
    stocks_top5 = [r for r in sorted(rows, key=lambda r: -r["pts"])[:5] if r["pts"] > 0]
    stocks_bot3 = [r for r in sorted(rows, key=lambda r: r["pts"])[:3] if r["pts"] < 0]

    # ---- 次產業聚合（多對多去重、每個次產業各加一次全額；同 ovComputeSubAgg）----
    agg: dict[str, dict] = {}
    for code, v in (live.get("stocks") or {}).items():
        info = cl.get(code)
        if not info or info.get("t") != "twse" or not info.get("p"):
            continue
        if not isinstance(v, (list, tuple)) or len(v) <= i_pts:
            continue
        amt = v[i_amt] or 0
        pts = v[i_pts] or 0
        chg = (v[i_chg] if i_chg is not None and len(v) > i_chg else None) or 0
        for name in {p[1] for p in info["p"]}:
            o = agg.setdefault(name, {"n": name, "amt": 0.0, "pts": 0.0, "up": 0, "down": 0, "n_stk": 0})
            o["amt"] += amt
            o["pts"] += pts
            o["n_stk"] += 1
            if chg > 0:
                o["up"] += 1
            elif chg < 0:
                o["down"] += 1
    subs = [s for s in agg.values() if s["n_stk"] >= 3]

    mkt = live.get("market") or {}
    mkt_amt_yi = ((mkt.get("tse") or {}).get("amt_yi")) or 0

    def sub_row(s: dict) -> dict:
        return {
            "n": clean_sub(s["n"]),
            "pts": round(s["pts"], 2),
            "amt_yi": round(s["amt"] / 1e8, 1),
            "share_pct": round((s["amt"] / 1e8) / mkt_amt_yi * 100, 1) if mkt_amt_yi else 0,
            "n_stk": s["n_stk"],
        }

    subs_top5 = [sub_row(s) for s in sorted(subs, key=lambda s: -s["pts"])[:5] if s["pts"] > 0]
    subs_bot3 = [sub_row(s) for s in sorted(subs, key=lambda s: s["pts"])[:3] if s["pts"] < 0]
    share_top = sub_row(max(subs, key=lambda s: s["amt"])) if subs else None
    pts_top_cand = max(subs, key=lambda s: s["pts"]) if subs else None
    pts_top = sub_row(pts_top_cand) if pts_top_cand and pts_top_cand["pts"] > 0 else None

    # ---- 大盤／廣度 ----
    ix_tse = (live.get("index") or {}).get("tse") or {}
    ix_otc = (live.get("index") or {}).get("otc") or {}
    m_tse, m_otc = mkt.get("tse") or {}, mkt.get("otc") or {}
    up = (m_tse.get("up") or 0) + (m_otc.get("up") or 0)
    down = (m_tse.get("down") or 0) + (m_otc.get("down") or 0)

    # ---- 全日 series（高低點）：/live 收盤後帶全日；不足則補拉 /replay ----
    series = live.get("series") or []
    if len(series) < 100:
        series = get_json(f"{WORKER}/replay?date={date}").get("series") or []
    idx_vals = [p.get("idx") for p in series if isinstance(p, dict) and p.get("idx") is not None]
    # 全日高低需要完整分鐘序列；series 不足（上游 KV 缺格，2026-07-18 實測常態性只剩
    # 尾筆）時給 null 誠實降級，不拿收盤價冒充高低點
    if len(idx_vals) >= 10:
        day_hi, day_lo = round(max(idx_vals), 2), round(min(idx_vals), 2)
    else:
        day_hi = day_lo = None
        print(f"警告：series 僅 {len(idx_vals)} 筆，全日高低以 null 落檔")

    # ---- 定調句（同 ovSummaryCard tone；去「今日」前綴供晨報以昨日語境引用）----
    if ix_tse.get("chgP") is None:
        print(f"{date}：/live 缺 index.tse.chgP → 不落檔，正常退出")
        return 0
    share_txt = f"{share_top['n']}（{share_top['share_pct']:.1f}%）" if share_top else "—"
    pts_txt = f"{pts_top['n']}（{sgn_txt(pts_top['pts'])} 點）" if pts_top else "—"
    tone = (
        f"大盤 {sgn_txt(ix_tse['chgP'])} 點（{pct_txt(ix_tse.get('chg'))}）；"
        f"廣度 漲{up}／跌{down}；"
        f"全日成交佔比最高 {share_txt}，貢獻最強 {pts_txt}。"
    )

    out = {
        "date": date,
        "generated_at": datetime.now(TPE).isoformat(timespec="seconds"),
        "source": "worker /live 收盤定格（口徑同即時一覽收盤總結卡）",
        "index": {
            "tse": {
                "val": ix_tse.get("val"), "chgP": ix_tse.get("chgP"), "chg": ix_tse.get("chg"),
                "amt_yi": m_tse.get("amt_yi"), "hi": day_hi, "lo": day_lo,
            },
            "otc": {
                "val": ix_otc.get("val"), "chgP": ix_otc.get("chgP"), "chg": ix_otc.get("chg"),
                "amt_yi": m_otc.get("amt_yi"),
            },
        },
        "breadth": {
            "up": up, "down": down,
            "tse": {k: m_tse.get(k) for k in ("up", "down", "flat")},
            "otc": {k: m_otc.get(k) for k in ("up", "down", "flat")},
        },
        "tone": tone,
        "stocks_top5": stocks_top5,
        "stocks_bot3": stocks_bot3,
        "subs_top5": subs_top5,
        "subs_bot3": subs_bot3,
        "share_top": share_top,
        "pts_top": pts_top,
        "series_n": len(series),
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    (OUT_DIR / f"{date}.json").write_text(body, encoding="utf-8")
    (OUT_DIR / "latest.json").write_text(body, encoding="utf-8")

    # ---- 保留近 30 個交易日檔（latest.json 不計）----
    days = sorted(p for p in OUT_DIR.glob("*.json") if p.name != "latest.json")
    for p in days[:-KEEP_DAYS]:
        p.unlink()
        print(f"清除過期檔：{p.name}")

    print(f"{date}：daysummary 落檔（series {len(series)} 筆、次產業 {len(subs)} 個、"
          f"個股 {len(rows)} 檔有貢獻值）")
    print(f"tone：{tone}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.now(TPE).strftime("%Y-%m-%d"),
                    help="目標日期（預設台北今日；/live 定格日期不符即優雅退出）")
    args = ap.parse_args()
    if len(args.date) != 10:
        print(f"date 格式需為 YYYY-MM-DD：{args.date}", file=sys.stderr)
        return 1
    return build(args.date)


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    raise SystemExit(main())
