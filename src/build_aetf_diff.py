# src/build_aetf_diff.py — 主動式ETF「主動加減碼」跨日比對 → data/aetf/diff.json
#
# 方法論（見 memory aetf-tab-plan）：
#   股數法（統一四家一致）：預期股數 = 前日股數 × 申贖比 ratio，主動Δ = 實際 − 預期。
#     申贖造成的等比縮放被排除，新進場=全額買、清倉=賣出預期股數。
#   ratio 來源：
#     有 units（群益/野村/復華）：ratio = 今單位數 / 前單位數。
#     無 units（統一 00981A/00403A）：ratio = 各持股「今股數/前股數」的中位數。
#       多數持股未主動交易 → 其股數僅隨申贖等比縮放，中位數即申贖比；主動交易為偏離中位數者。
#       （原權重差法會把純股價漲跌的權重變化誤判為主動加減碼——07-07 實測 17~19 訊號僅 4~5 筆為真。）
#   噪音門檻：|Δ股| < max(1000股, 前日股數0.5%) → 視為 0。
# 產出 diff.json：
#   etfs[code]  = {name, d0, d1, aum, units, est_flow(申贖估算金額), n_buy, n_sell}
#   stocks[]    = [{c, n(名), zh(合計張), val(合計金額), by:{etf:張}}]  ← 進出個股表（含各ETF張數明細）
#   subs[]      = [{name(次產業), val(淨金額), detail:[{etf, c, n, zh, val}]}]  ← 次產業流向（可展開明細）
#
# 收盤價：FinMind TaiwanStockPrice（單日全市場，需 FINMIND_TOKEN；無 token 時金額=null 僅張數）。
# 用法：python src/build_aetf_diff.py

from __future__ import annotations
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
ADIR = ROOT / "data" / "aetf"
NOISE_SH = 1000          # 股
NO_UNITS_ETFS = {"00981A", "00403A"}   # 統一無 units → 申贖比由持股股數比中位數推估


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


def _units_ratio(code: str, cur: dict, prv: dict) -> float:
    """申贖比 = 今單位數/前單位數；統一無 units 時以各持股股數比的中位數估之。"""
    u1, u0 = cur.get("units"), prv.get("units")
    if u1 and u0:
        return u1 / u0
    if code in NO_UNITS_ETFS:
        s1, s0 = cur["stocks"], prv["stocks"]
        # 只取兩日都在、且前日股數夠大（排除 1000 股佔位/雜訊）的持股算比值中位數
        ratios = [(s1[c][0] / s0[c][0]) for c in (set(s1) & set(s0))
                  if s0.get(c) and s0[c][0] >= 10000 and s1.get(c) and s1[c][0] > 0]
        if ratios:
            return statistics.median(ratios)
    return 1.0


def diff_one(code: str, cur: dict, prv: dict, closes: dict) -> tuple[list, dict]:
    """回 (rows[{c,n,dsh,val}], summary)。dsh=主動Δ股數(可為估算)。"""
    s1, s0 = cur["stocks"], prv["stocks"]
    rows = []
    ratio = _units_ratio(code, cur, prv)
    for c in set(s1) | set(s0):
        sh1 = (s1.get(c) or [0])[0]
        sh0 = (s0.get(c) or [0])[0]
        expected = sh0 * ratio
        d = sh1 - expected
        if abs(d) < max(NOISE_SH, sh0 * 0.005):
            continue
        px = closes.get(c)
        name = (s1.get(c) or s0.get(c))[1]
        rows.append({"c": c, "n": name, "dsh": d, "val": (d * px) if px else None})
    # 申贖金額估算（有 units 且有淨值）
    est_flow = None
    u1, u0, aum1 = cur.get("units"), prv.get("units"), cur.get("aum")
    if u1 and u0 and aum1:
        est_flow = (u1 - u0) * (aum1 / u1)
    summary = {"name": cur.get("name"), "d0": prv_date_of(prv), "d1": prv_date_of(cur),
               "aum": cur.get("aum"), "aum_prev": prv.get("aum"),
               "twse_aum_yi": cur.get("twse_aum_yi"), "units": u1, "units_prev": u0,
               "est_flow": est_flow,
               "n_buy": sum(1 for r in rows if (r["dsh"] or 0) > 0 or (r["val"] or 0) > 0),
               "n_sell": sum(1 for r in rows if (r["dsh"] or 0) < 0 or (r["val"] or 0) < 0)}
    return rows, summary


def prv_date_of(e):
    return (e.get("src_date") or "").replace("-", "/")


def main():
    by = load_snapshots()
    cl = json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))["map"]
    out = {"etfs": {}, "stocks": {}, "subs": {}}
    latest_dates = []
    closes = {}
    # 先決定要用哪天的收盤價（最新 src_date）
    # 收盤價：從最新往回找有交易資料的一天（野村/群益 PCF 日=次一營業日，可能還沒開盤）
    all_dates = sorted({d for m in by.values() for d in m})
    for d in reversed(all_dates[-4:]):
        closes = close_map(d)
        if closes:
            break

    for code, snaps in by.items():
        dates = sorted(snaps)
        if len(dates) < 2:
            print(f"{code}: 僅 {len(dates)} 個揭露日，跳過", flush=True)
            continue
        d0, d1 = dates[-2], dates[-1]
        rows, summary = diff_one(code, snaps[d1], snaps[d0], closes)
        summary["d0"], summary["d1"] = d0, d1
        out["etfs"][code] = summary
        latest_dates.append(d1)
        for r in rows:
            zh = round(r["dsh"] / 1000) if r["dsh"] is not None else None
            if zh == 0:
                zh = 1 if (r["dsh"] or 0) > 0 else -1
            o = out["stocks"].setdefault(r["c"], {"c": r["c"], "n": r["n"], "zh": 0, "val": 0.0, "by": {}})
            if zh is not None:
                o["zh"] += zh
                o["by"][code] = o["by"].get(code, 0) + zh
            if r["val"] is not None:
                o["val"] += r["val"]
            # 次產業聚合（classify.p 第二層，多對多）
            info = cl.get(r["c"])
            if info and r["val"] is not None:
                for sub in {p[1] for p in info.get("p", [])}:
                    so = out["subs"].setdefault(sub, {"name": sub, "val": 0.0, "detail": []})
                    so["val"] += r["val"]
                    so["detail"].append({"etf": code, "c": r["c"], "n": r["n"],
                                         "zh": zh, "val": round(r["val"])})

    # 整理輸出
    stocks = sorted(out["stocks"].values(), key=lambda x: -abs(x["val"] or 0))
    for s in stocks:
        s["val"] = round(s["val"]) if s["val"] else None
    subs = sorted(out["subs"].values(), key=lambda x: -abs(x["val"]))
    for s in subs:
        s["val"] = round(s["val"])
        s["detail"].sort(key=lambda x: -abs(x["val"] or 0))
    final = {"generated_dates": sorted(set(latest_dates)), "etfs": out["etfs"],
             "stocks": stocks, "subs": subs}
    (ADIR / "diff.json").write_text(json.dumps(final, ensure_ascii=False, separators=(",", ":")),
                                    encoding="utf-8")
    print(f"diff.json：{len(out['etfs'])} 檔ETF、個股異動 {len(stocks)}、次產業 {len(subs)}")


if __name__ == "__main__":
    main()
