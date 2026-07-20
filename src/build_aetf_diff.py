# src/build_aetf_diff.py — 主動式ETF「主動加減碼」跨日比對 → data/aetf/diff.json
#
# 兩者並列（2026-07-20，FinMind 遷移後）：
#   ① net_active（主動純額，排除申贖）：預期股數 = 前日股數 × 申贖比 ratio，主動Δ = 實際 − 預期。
#      申贖造成的等比縮放被排除，新進場=全額買、清倉=賣出預期股數。
#      ratio 來源：FinMind 無總單位數 → 各持股「今股數/前股數」中位數（多數持股僅隨申贖等比縮放，
#      中位數即申贖比；主動交易為偏離中位數者）。噪音門檻 |Δ股| < max(1000股, 前日股數0.5%) → 視為 0。
#   ② raw_change（原始變動，含申贖）：直接抓 FinMind TaiwanStockActiveETFHoldingChange 的
#      (d0, d1] buy−sell 加總，即含申贖等比增減的總變動、非主動純額。
#   兩者語意差 = 申贖驅動的部位變化（前端「主動 vs 含申贖」解讀據此）。
# 產出 diff.json：
#   etfs[code]  = {name, d0, d1, aum, est_flow(申贖估算金額), n_buy, n_sell,
#                  buy:[{c,n,zh,val,rzh,rval}](加碼股), sell:[...](減碼股)}
#                  zh/val=主動純額 張/金額；rzh/rval=原始變動 張/金額
#   stocks[]    = [{c,n,zh,val,rzh,rval, by:{etf:張(主動)}, rby:{etf:張(原始)}}]  ← 進出個股表
#   subs[]      = [{name(次產業), val(主動淨金額), detail:[...]}]  ← 次產業流向（主動口徑）
#
# 收盤價：FinMind TaiwanStockPrice（單日全市場，需 FINMIND_TOKEN；無 token 時金額=null 僅張數）。
# 用法：python src/build_aetf_diff.py
#
# 註：FinMind 的 Holding date 為實際持股基準日（已無原 PCF 的 T+1 標記問題），故不再做 T+1 折算；
#     各檔揭露時點不同時，基準日落後主基準日的檔仍列 laggards、不併入聚合（誠實分組）。

from __future__ import annotations
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
ADIR = ROOT / "data" / "aetf"
NOISE_SH = 1000          # 股


def trading_calendar(days_back: int = 45) -> list:
    """FinMind TAIEX 交易日曆（升冪 YYYY/MM/DD）；無 token/失敗回 []。"""
    try:
        import fin
        from datetime import date, timedelta
        rows = fin.api_get("TaiwanStockPrice", data_id="TAIEX",
                           start_date=(date.today() - timedelta(days=days_back)).isoformat())
        return sorted({str(r["date"]).replace("-", "/") for r in rows if r.get("date")})
    except Exception as e:
        print(f"trading_calendar 不可用（{e}）", flush=True)
        return []


def load_snapshots() -> dict:
    """回 {etf: {src_date: entry}}（掃全部日檔，同 src_date 取最新 run）。"""
    by = {}
    for f in sorted(ADIR.glob("2*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        for code, e in (d.get("etfs") or {}).items():
            sd = (e.get("src_date") or "").replace("-", "/")
            if sd:
                by.setdefault(code, {})[sd] = e
    return by


def close_map(date_slash: str) -> dict:
    """FinMind 全市場收盤 {code: close}；無 token/失敗回 {}。"""
    try:
        import fin
        rows = fin.api_get("TaiwanStockPrice",
                           start_date=date_slash.replace("/", "-"),
                           end_date=date_slash.replace("/", "-"))
        return {str(r["stock_id"]): float(r["close"]) for r in rows if r.get("close")}
    except Exception as e:
        print(f"close_map 不可用（{e}）→ 金額以權重法/略過", flush=True)
        return {}


def raw_changes(code: str, d0: str, d1: str) -> tuple[dict, dict]:
    """FinMind TaiwanStockActiveETFHoldingChange 於 (d0, d1] 含申贖總變動。
    回 ({component: buy-sell 股數}, {component: 名稱})；無 token/失敗回 ({}, {})。"""
    try:
        import fin
        rows = fin.api_get("TaiwanStockActiveETFHoldingChange", data_id=code,
                           start_date=d0.replace("/", "-"), end_date=d1.replace("/", "-"))
    except Exception as e:
        print(f"{code} raw_changes 不可用（{e}）", flush=True)
        return {}, {}
    agg, names = {}, {}
    for r in rows:
        rd = str(r.get("date") or "").replace("-", "/")
        if not (d0 < rd <= d1):
            continue
        c = str(r.get("component_stock_id") or "").strip()
        if not c:
            continue
        agg[c] = agg.get(c, 0) + (r.get("buy") or 0) - (r.get("sell") or 0)
        names[c] = r.get("component_stock_name") or names.get(c, "")
    return agg, names


def _units_ratio(cur: dict, prv: dict) -> float:
    """申贖比：FinMind 無總單位數 → 以各持股「今股數/前股數」中位數估之。"""
    u1, u0 = cur.get("units"), prv.get("units")
    if u1 and u0:
        return u1 / u0
    s1, s0 = cur["stocks"], prv["stocks"]
    ratios = [(s1[c][0] / s0[c][0]) for c in (set(s1) & set(s0))
              if s0.get(c) and s0[c][0] >= 10000 and s1.get(c) and s1[c][0] > 0]
    if ratios:
        return statistics.median(ratios)
    return 1.0


def diff_one(code: str, cur: dict, prv: dict, closes: dict,
             raws: dict, rnames: dict) -> tuple[list, dict]:
    """回 (rows[{c,n,zh,val,rzh,rval}], summary)。
    zh/val=主動純額(排除申贖)；rzh/rval=原始變動(含申贖 FinMind buy-sell)。"""
    s1, s0 = cur["stocks"], prv["stocks"]
    ratio = _units_ratio(cur, prv)
    keys = set(s1) | set(s0) | {c for c, v in raws.items() if abs(v) >= NOISE_SH}
    rows = []
    for c in keys:
        sh1 = (s1.get(c) or [0])[0]
        sh0 = (s0.get(c) or [0])[0]
        d = sh1 - sh0 * ratio            # 主動純額（排除申贖）
        rsh = raws.get(c, 0)             # 原始變動（含申贖）
        net_sig = abs(d) >= max(NOISE_SH, sh0 * 0.005)
        raw_sig = abs(rsh) >= NOISE_SH
        if not net_sig and not raw_sig:
            continue
        px = closes.get(c)
        name = (s1.get(c) or s0.get(c) or [None, rnames.get(c, "")])[1]
        zh = val = rzh = rval = None
        if net_sig:
            zh = round(d / 1000) or (1 if d > 0 else -1)
            val = round(d * px) if px else None
        if raw_sig:
            rzh = round(rsh / 1000) or (1 if rsh > 0 else -1)
            rval = round(rsh * px) if px else None
        rows.append({"c": c, "n": name, "zh": zh, "val": val, "rzh": rzh, "rval": rval})
    # 申贖現金流估算：(申贖比-1) × 前日持股市值加總（FinMind 無 units，改由 ratio 推）
    est_flow = None
    aum0 = sum(s0[c][0] * closes[c] for c in s0 if closes.get(c))
    if aum0:
        est_flow = (ratio - 1) * aum0

    def prim(h):
        return h["zh"] if h["zh"] is not None else h["rzh"]

    def mag(h):
        return h["val"] if h["val"] is not None else (h["rval"] or 0)

    buy = sorted([h for h in rows if (prim(h) or 0) > 0], key=lambda x: -(mag(x) or 0))
    sell = sorted([h for h in rows if (prim(h) or 0) < 0], key=lambda x: (mag(x) or 0))
    summary = {"name": cur.get("name"),
               "d0": prv_date_of(prv), "d1": prv_date_of(cur),
               "aum": cur.get("aum"), "aum_prev": prv.get("aum"),
               "twse_aum_yi": cur.get("twse_aum_yi"), "ratio": round(ratio, 4),
               "est_flow": est_flow, "n_buy": len(buy), "n_sell": len(sell),
               "buy": buy, "sell": sell}
    return rows, summary


def prv_date_of(e):
    return (e.get("src_date") or "").replace("-", "/")


def main():
    by = load_snapshots()
    cal = trading_calendar()   # 供收盤價擇日（不再折算 T+1）
    cl = json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))["map"]
    out = {"etfs": {}, "stocks": {}, "subs": {}}
    latest_dates = []
    closes = {}
    all_dates = sorted({d for m in by.values() for d in m})
    for d in reversed(all_dates[-4:]):
        closes = close_map(d)
        if closes:
            break

    # 每檔取最後兩個揭露日 → d1=最新基準日；主基準日=各檔 d1 的最大值（最新交易日）
    prepared = {}
    for code, snaps in by.items():
        dates = sorted(snaps)
        if len(dates) < 2:
            print(f"{code}: 僅 {len(dates)} 個揭露日，跳過", flush=True)
            continue
        prepared[code] = (dates[-2], dates[-1], snaps)
    primary = max((d1 for (_, d1, _) in prepared.values()), default=None)

    laggards = []
    for code, (d0, d1, snaps) in prepared.items():
        raws, rnames = raw_changes(code, d0, d1)
        rows, summary = diff_one(code, snaps[d1], snaps[d0], closes, raws, rnames)
        summary["d0"], summary["d1"] = d0, d1
        out["etfs"][code] = summary          # 每檔明細照存（前端總覽逐檔顯示）
        # 誠實分組：基準日落後主基準日的檔不併入 stocks/subs 聚合，另列 laggards
        if d1 != primary:
            laggards.append({"etf": code, "src_date": d1})
            print(f"{code}: 基準日 {d1} 落後主基準日 {primary}，列 laggard 不併入聚合", flush=True)
            continue
        latest_dates.append(d1)
        for r in rows:
            o = out["stocks"].setdefault(r["c"], {"c": r["c"], "n": r["n"], "zh": 0, "val": 0.0,
                                                  "rzh": 0, "rval": 0.0, "by": {}, "rby": {}})
            if r["zh"] is not None:
                o["zh"] += r["zh"]
                o["by"][code] = o["by"].get(code, 0) + r["zh"]
            if r["val"] is not None:
                o["val"] += r["val"]
            if r["rzh"] is not None:
                o["rzh"] += r["rzh"]
                o["rby"][code] = o["rby"].get(code, 0) + r["rzh"]
            if r["rval"] is not None:
                o["rval"] += r["rval"]
            # 次產業聚合（主動口徑，classify.p 第二層，多對多）
            info = cl.get(r["c"])
            if info and r["val"] is not None:
                for sub in {p[1] for p in info.get("p", [])}:
                    so = out["subs"].setdefault(sub, {"name": sub, "val": 0.0, "detail": []})
                    so["val"] += r["val"]
                    so["detail"].append({"etf": code, "c": r["c"], "n": r["n"],
                                         "zh": r["zh"], "val": round(r["val"])})

    # 整理輸出
    stocks = sorted(out["stocks"].values(), key=lambda x: -abs(x["val"] or 0) - abs(x["rval"] or 0) * 1e-6)
    for s in stocks:
        s["val"] = round(s["val"]) if s["val"] else None
        s["rval"] = round(s["rval"]) if s["rval"] else None
        if not s["rzh"]:
            s["rzh"] = None
    subs = sorted(out["subs"].values(), key=lambda x: -abs(x["val"]))
    for s in subs:
        s["val"] = round(s["val"])
        s["detail"].sort(key=lambda x: -abs(x["val"] or 0))
    final = {"generated_dates": sorted(set(latest_dates)), "primary_date": primary,
             "laggards": sorted(laggards, key=lambda x: x["etf"]),
             "etfs": out["etfs"], "stocks": stocks, "subs": subs}
    (ADIR / "diff.json").write_text(json.dumps(final, ensure_ascii=False, separators=(",", ":")),
                                    encoding="utf-8")
    print(f"diff.json：主基準日 {primary}、聚合 {len(latest_dates)} 檔、落後 {len(laggards)} 檔、"
          f"個股異動 {len(stocks)}、次產業 {len(subs)}")


if __name__ == "__main__":
    main()
