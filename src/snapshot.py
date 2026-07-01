# src/snapshot.py — 取即時全市場快照 + 分類聚合 + 指數貢獻點數 → data/live.json
#
# 即時資金流（綜合，皆由 tick_snapshot 盤中欄位算，非盤後三大法人）。
# 所有類股統計**依市場別(加權 tse / 櫃買 otc)分別統計**：成交值、淨流入(漲家額−跌家額)、
# 均漲跌(成交額加權)、漲跌家數、檔數、指數貢獻點。前端 加權/櫃買 切換＝整個視圖的市場過濾。
#
# 指數貢獻點數：pts_i = ΔIndex × (Δ價_i×發行股數_i) / Σ同市場(Δ價×股數)，
#   構成股＝該市場普通股(排除 ETF/00 開頭)，類股加總＝指數漲跌點(自洽)。
#   TSE=001 加權指數、OTC=101 櫃買指數。
#
# 用法：python src/snapshot.py  → 寫 data/live.json

from __future__ import annotations
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fin  # noqa: E402

OUT = fin.ROOT / "data" / "live.json"
CLASSIFY = fin.ROOT / "data" / "classify.json"
TPE = timezone(timedelta(hours=8))
MKT = {"twse": "tse", "tpex": "otc"}  # type → 市場 key


def _classify() -> dict:
    return json.loads(CLASSIFY.read_text(encoding="utf-8"))["map"]


def _z() -> dict:
    return {"amt": 0.0, "lw": 0.0, "wchg": 0.0, "up": 0, "down": 0, "flat": 0, "n": 0, "pts": 0.0}


def _acc(d: dict, key: str, m: str, amt, lw, chg, pts):
    o = d.get(key)
    if not o:
        o = d[key] = {"sector": key, "tse": _z(), "otc": _z()}
    b = o[m]
    b["amt"] += amt
    b["lw"] += lw
    b["wchg"] += chg * amt
    b["n"] += 1
    b["pts"] += pts
    if chg > 0:
        b["up"] += 1
    elif chg < 0:
        b["down"] += 1
    else:
        b["flat"] += 1


def _one(b: dict) -> dict:
    amt = b["amt"]
    return {"amt_yi": round(amt / 1e8, 2), "lw_amt_yi": round(b["lw"] / 1e8, 2),
            "avg_chg": round(b["wchg"] / amt, 2) if amt else 0.0,
            "up": b["up"], "down": b["down"], "flat": b["flat"], "n": b["n"], "pts": round(b["pts"], 2)}


def _finalize(d: dict) -> list:
    # 前端依選定市場 amt 排序，這裡不排
    return [{"sector": o["sector"], "tse": _one(o["tse"]), "otc": _one(o["otc"])} for o in d.values()]


def _idx(rowmap: dict, code: str) -> dict:
    r = rowmap.get(code) or {}
    return {"val": r.get("close"), "chgP": r.get("change_price"), "chg": r.get("change_rate"),
            "vol": r.get("total_volume"), "amt_yi": round(float(r.get("total_amount") or 0) / 1e8, 1)}


def _lastweek() -> dict:
    """上週(前一日曆週 週一~週五)各工作天成交值(Trading_money)加總；週快取 data/lastweek.json，一週只抓一次。
    回 {week, stocks:{code:元}, tot:{twse,tpex 元}}。"""
    today = datetime.now(TPE).date()
    lw_mon = today - timedelta(days=today.weekday() + 7)
    dates = [(lw_mon + timedelta(days=i)).isoformat() for i in range(5)]
    p = fin.ROOT / "data" / "lastweek.json"
    if p.exists():
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
            if j.get("week") == dates[0]:
                return j
        except Exception:
            pass
    cl = _classify()
    stk: dict[str, float] = {}
    for d in dates:
        try:
            rows = fin.api_get("TaiwanStockPrice", start_date=d, end_date=d)
        except Exception:
            rows = []
        for r in rows:
            c = str(r.get("stock_id") or "")
            # 只計真實個股/ETF：在 classify 內(排除權證) 且代號數字開頭(排除 TAIEX/類股指數 等 pseudo)
            if c not in cl or not c[:1].isdigit():
                continue
            tm = r.get("Trading_money")
            if tm:
                stk[c] = stk.get(c, 0.0) + float(tm)
    tot = {"twse": 0.0, "tpex": 0.0}
    for c, a in stk.items():
        t = cl[c].get("t")
        if t in tot:
            tot[t] += a
    j = {"week": dates[0], "stocks": {c: round(a) for c, a in stk.items()}, "tot": tot}
    p.write_text(json.dumps(j, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return j


def build_live() -> dict:
    cl = _classify()
    rows = fin.snapshot_all()
    ts = None
    idxrow = {}
    items = []
    sum_mc = {"twse": 0.0, "tpex": 0.0}
    for r in rows:
        code = str(r.get("stock_id") or "")
        if not code:
            continue
        if code in ("001", "101"):
            idxrow[code] = r
            continue
        info = cl.get(code)
        if not info:
            continue
        amt = float(r.get("total_amount") or 0)
        c = r.get("change_rate")
        chg = float(c) if c is not None else 0.0
        dv = r.get("change_price")
        dp = float(dv) if dv is not None else 0.0
        bv = float(r.get("buy_volume") or 0)
        sv = float(r.get("sell_volume") or 0)
        ts = ts or r.get("date")
        sh = float(info.get("sh") or 0)
        mkt = info.get("t") or ""
        etf = code.startswith("00")
        items.append((code, info, amt, chg, bv, sv, dp, sh, etf, mkt, r.get("close"), r.get("total_volume")))
        if sh and not etf and mkt in sum_mc:
            sum_mc[mkt] += dp * sh

    dI = {"twse": float((idxrow.get("001") or {}).get("change_price") or 0),
          "tpex": float((idxrow.get("101") or {}).get("change_price") or 0)}

    # 當日漲跌停價（判斷漲跌停；limit_up/down=0 代表無漲跌幅限制）
    date = (ts or "")[:10]
    limits = {}
    try:
        for r in fin.api_get("TaiwanStockPriceLimit", start_date=date, end_date=date):
            limits[str(r["stock_id"])] = (float(r.get("limit_up") or 0), float(r.get("limit_down") or 0))
    except Exception:
        pass

    lw = _lastweek()               # 上週各工作天成交值（週快取）
    lwmap, lwtot = lw["stocks"], lw["tot"]

    stocks, ex, ch = {}, {}, {}
    mk = {"tse": {"amt": 0.0, "up": 0, "down": 0, "flat": 0, "n": 0, "ul": 0, "dl": 0},
          "otc": {"amt": 0.0, "up": 0, "down": 0, "flat": 0, "n": 0, "ul": 0, "dl": 0}}
    for code, info, amt, chg, bv, sv, dp, sh, etf, mkt, close, vol in items:
        pts = 0.0
        if sh and not etf and mkt in sum_mc and sum_mc[mkt]:
            pts = dI[mkt] * (dp * sh) / sum_mc[mkt]
        lwa = float(lwmap.get(code, 0))
        lu, ld = limits.get(code, (0, 0))
        lim = 1 if (close is not None and lu and close >= lu - 1e-6) else \
            (-1 if (close is not None and ld and close <= ld + 1e-6) else 0)
        stocks[code] = [round(chg, 2), round(amt), close, vol, round(bv), round(sv),
                        round(pts, 3), round(dp, 2), lim, round(lwa)]
        m = MKT.get(mkt)
        if not m:
            continue  # 無市場別（極少）→ 不計入分市場統計
        b = mk[m]
        b["amt"] += amt
        b["n"] += 1
        if chg > 0:
            b["up"] += 1
        elif chg < 0:
            b["down"] += 1
        else:
            b["flat"] += 1
        if lim == 1:
            b["ul"] += 1
        elif lim == -1:
            b["dl"] += 1
        _acc(ex, info["e"], m, amt, lwa, chg, pts)
        for nd in info["c"]:
            _acc(ch, nd, m, amt, lwa, chg, pts)

    cov = sum(1 for code in stocks if cl.get(code) and cl[code]["c"])
    _lwk = {"tse": "twse", "otc": "tpex"}
    market = {k: {"amt_yi": round(v["amt"] / 1e8, 1), "lw_amt_yi": round(lwtot.get(_lwk[k], 0) / 1e8, 1),
                  "up": v["up"], "down": v["down"], "flat": v["flat"], "n": v["n"],
                  "up_lim": v["ul"], "down_lim": v["dl"]}
              for k, v in mk.items()}
    live = {"ts": ts, "generated_at": datetime.now(TPE).isoformat(),
            "stock_cols": ["chg", "amt", "close", "vol", "bv", "sv", "pts", "dp", "lim", "lw"],
            "index": {"tse": _idx(idxrow, "001"), "otc": _idx(idxrow, "101")},
            "market": market, "exchange": _finalize(ex), "chain": _finalize(ch),
            "chain_coverage": {"with_chain": cov, "total": len(stocks)},
            "stocks": stocks}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(live, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return live


if __name__ == "__main__":
    L = build_live()
    ix = L["index"]
    for mk_, ixk, nm in (("tse", "tse", "加權"), ("otc", "otc", "櫃買")):
        m = L["market"][mk_]
        x = ix[ixk]
        print(f"{nm} {x['val']} ({x['chgP']:+}, {x['chg']}%) 量{x['amt_yi']:.0f}億 | "
              f"成交{m['amt_yi']:.0f}億 漲{m['up']}/跌{m['down']} {m['n']}檔")
    st = sum(s["tse"]["pts"] for s in L["exchange"])
    print(f"Sigma 產業別貢獻點 TSE={st:.1f} (idx {ix['tse']['chgP']})")
