# src/build_baseline.py — 產 data/baseline.json（資金湧入偵測的常態基準，每交易日收盤後跑）
#
# 內容（給 Worker /live 當靜態依賴，快取到隔日）：
#   stocks: {code: [a5, it, fi]}
#     a5 = 前 5 個交易日平均成交額（元）→ 集中度分母（個股常態佔比 = a5/tot5）
#     it = 投信近 3 交易日買超日數 0~3（回測實證的個股續勢旗標）
#     fi = 外資近 3 交易日買超日數 0~3
#   tot5 = 全市場（上市+上櫃，排除指數/權證/興櫃）5 日均總額（元）
#   days = 取用的 5 個交易日（新→舊）
#
# 用法：FINMIND_TOKEN=... python src/build_baseline.py
# 回測依據見 backtest/report*.md：次產業集中度有延續性；個股層以投信連買為有效旗標。

from __future__ import annotations
import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fin  # noqa: E402

OUT = fin.ROOT / "data" / "baseline.json"


def classify_keep() -> set:
    cl = json.loads((fin.ROOT / "data" / "classify.json").read_text(encoding="utf-8"))["map"]
    return {c for c, v in cl.items() if v.get("t") in ("twse", "tpex") and c[:1].isdigit()}


def main():
    keep = classify_keep()
    # 從今天往回走，收集最近 5 個有資料的交易日（含今天：收盤後跑，今天就是最新完成日）
    days, amts = [], {}     # amts: {code: [各日成交額]}
    d = date.today()
    probe = 0
    while len(days) < 5 and probe < 15:
        ds = d.isoformat()
        d -= timedelta(days=1)
        probe += 1
        if date.fromisoformat(ds).weekday() >= 5:
            continue
        rows = fin.api_get("TaiwanStockPrice", start_date=ds, end_date=ds)
        if not rows:
            continue
        days.append(ds)
        for r in rows:
            c = str(r.get("stock_id") or "")
            if c in keep and r.get("Trading_money"):
                amts.setdefault(c, []).append(float(r["Trading_money"]))
        print(f"price {ds} ok", flush=True)
    if len(days) < 5:
        raise RuntimeError(f"僅找到 {len(days)} 個交易日")

    # 投信/外資近 3 交易日買超日數
    it, fi = {}, {}
    for ds in days[:3]:
        for r in fin.api_get("TaiwanStockInstitutionalInvestorsBuySell", start_date=ds, end_date=ds):
            c = str(r.get("stock_id") or "")
            if c not in keep:
                continue
            net = (r.get("buy") or 0) - (r.get("sell") or 0)
            if net > 0:
                if r.get("name") == "Investment_Trust":
                    it[c] = it.get(c, 0) + 1
                elif r.get("name") == "Foreign_Investor":
                    fi[c] = fi.get(c, 0) + 1
        print(f"inst {ds} ok", flush=True)

    stocks = {}
    tot5 = 0.0
    for c, arr in amts.items():
        a5 = sum(arr) / 5  # 除以 5（缺日視為 0，與回測一致）
        stocks[c] = [round(a5), it.get(c, 0), fi.get(c, 0)]
        tot5 += a5
    out = {"date": days[0], "days": days, "tot5": round(tot5), "stocks": stocks}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"baseline {days[0]}: {len(stocks)} 檔, tot5={tot5/1e8:.0f}億, "
          f"投信連買3日 {sum(1 for v in stocks.values() if v[1] == 3)} 檔")


if __name__ == "__main__":
    main()
