# src/build_baseline.py — 產 data/baseline.json（資金湧入偵測的常態基準，每交易日收盤後跑）
#
# 內容（給 Worker /live 當靜態依賴，快取到隔日）：
#   stocks: {code: [a5, it, fi, y1, y2, ints, nl, its]}
#     a5 = 前 5 個交易日平均成交額（元）→ 集中度分母（個股常態佔比 = a5/tot5）
#     it/fi = 投信/外資近 3 交易日買超日數 0~3（回測實證的個股續勢旗標）
#     its = 投信近 3 交易日賣超日數 0~3（連買的反向：連賣旗標）
#     y1/y2 = 最近一日/前一日的日線訊號：1=湧入(爆量2x+漲2%+收高0.7) / -1=退出(爆量+跌+收低0.3) / 0=無
#       回測（report_lag.md）：個股昨湧→今日平均偏弱(追高警示)、昨退→續弱；連續兩日效果加倍
#     ints = 法人買賣強度%（最近一日 (投信+外資淨買股數×close)/成交額×100，1位小數）
#       回測（report_indicators.md）：>5% 疊湧入 -0.51→-0.10；<-5% 疊退出 -0.64→-0.97
#     nl = 1 若最近一日收盤跌破前20日收盤最低（破底；退出訊號最強技術確認 -0.64→-1.08）
#   subs_y: {次產業: [y1, y2]}（僅列非零者）
#       次產業訊號＝集中度(佔比/前5日均佔比)≥1.5 且 等權漲跌 ≥1%(湧)/≤-1%(退)
#       回測：次產業昨湧→今日平均續強(+0.3pp)、連湧更強；昨退→今日偏弱
#   tot5 = 全市場（上市+上櫃）5 日均總額（元）；days = 取用的交易日（新→舊，共 7）
#
# 用法：FINMIND_TOKEN=... python src/build_baseline.py

from __future__ import annotations
import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fin  # noqa: E402

OUT = fin.ROOT / "data" / "baseline.json"
NDAYS = 21          # 破20日新低需要 D-1..D-20；y2 的爆量分母需要 D-2..D-6
SUB_MIN_MEM = 5
SUB_AMT_MIN = 10e8


def classify() -> dict:
    return json.loads((fin.ROOT / "data" / "classify.json").read_text(encoding="utf-8"))["map"]


def fv(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def day_signal(pd, i):
    """pd=每日 {c:(amt,close,high,low)} 新→舊；回 {code: 1/-1}（第 i 日的日線湧入/退出訊號）。"""
    out = {}
    cur, prev = pd[i], pd[i + 1]
    for c, (amt, close, hi, lo) in cur.items():
        if not amt or amt < 1e8 or close is None:   # 流動性≥1億（與回測一致）
            continue
        base = sum((pd[k].get(c) or (0,))[0] or 0 for k in range(i + 1, i + 6)) / 5
        pc = (prev.get(c) or (None, None))[1]
        if not base or not pc:
            continue
        surge = amt / base
        ret = close / pc - 1
        pos = (close - lo) / (hi - lo) if (hi is not None and lo is not None and hi > lo) else 1.0
        if surge >= 2 and ret >= 0.02 and pos >= 0.7:
            out[c] = 1
        elif surge >= 2 and ret <= -0.02 and pos <= 0.3:
            out[c] = -1
    return out


def sub_signal(pd, i, members):
    """第 i 日的次產業訊號 {sub: 1/-1}。集中度=佔比/前5日均佔比。"""
    tots = []
    for k in range(i, i + 6):
        tots.append(sum(v[0] or 0 for c, v in pd[k].items() if not c.startswith("00")))
    out = {}
    for sub, mem in members.items():
        amt_now = sum((pd[i].get(c) or (0,))[0] or 0 for c in mem)
        if amt_now < SUB_AMT_MIN or not tots[0]:
            continue
        shares = []
        for k in range(1, 6):
            shares.append((sum((pd[i + k].get(c) or (0,))[0] or 0 for c in mem) / tots[k]) if tots[k] else 0.0)
        base = sum(shares) / 5
        if base <= 0:
            continue
        conc = (amt_now / tots[0]) / base
        rets = []
        for c in mem:
            c0 = (pd[i].get(c) or (None, None))[1]
            c1 = (pd[i + 1].get(c) or (None, None))[1]
            if c0 and c1:
                rets.append(c0 / c1 - 1)
        if len(rets) < SUB_MIN_MEM or conc < 1.5:
            continue
        ret = sum(rets) / len(rets)
        if ret >= 0.01:
            out[sub] = 1
        elif ret <= -0.01:
            out[sub] = -1
    return out


def main():
    cl = classify()
    keep = {c for c, v in cl.items() if v.get("t") in ("twse", "tpex") and c[:1].isdigit()}
    members = {}
    for c, info in cl.items():
        if c.startswith("00") or info.get("t") not in ("twse", "tpex"):
            continue
        for p in info.get("p", []):
            members.setdefault(p[1], set()).add(c)
    members = {k: v for k, v in members.items() if len(v) >= SUB_MIN_MEM}

    # 收集最近 NDAYS 個交易日（新→舊），每日 {c:(amt,close,high,low)}
    days, pd = [], []
    d = date.today()
    probe = 0
    while len(days) < NDAYS and probe < 45:
        ds = d.isoformat()
        d -= timedelta(days=1)
        probe += 1
        if date.fromisoformat(ds).weekday() >= 5:
            continue
        rows = fin.api_get("TaiwanStockPrice", start_date=ds, end_date=ds)
        if not rows:
            continue
        m = {}
        for r in rows:
            c = str(r.get("stock_id") or "")
            if c in keep:
                m[c] = (fv(r.get("Trading_money")) or 0, fv(r.get("close")), fv(r.get("max")), fv(r.get("min")))
        days.append(ds)
        pd.append(m)
        print(f"price {ds} ok ({len(m)})", flush=True)
    if len(days) < NDAYS:
        raise RuntimeError(f"僅找到 {len(days)} 個交易日（需 {NDAYS}）")

    # 投信/外資近 3 交易日買超日數 + 最近一日淨買股數（法人強度用）
    it, fi, its, net0 = {}, {}, {}, {}
    for ds in days[:3]:
        for r in fin.api_get("TaiwanStockInstitutionalInvestorsBuySell", start_date=ds, end_date=ds):
            c = str(r.get("stock_id") or "")
            if c not in keep:
                continue
            name = r.get("name")
            if name not in ("Investment_Trust", "Foreign_Investor"):
                continue
            net = (r.get("buy") or 0) - (r.get("sell") or 0)
            if ds == days[0]:
                net0[c] = net0.get(c, 0) + net
            if net > 0:
                if name == "Investment_Trust":
                    it[c] = it.get(c, 0) + 1
                else:
                    fi[c] = fi.get(c, 0) + 1
            elif net < 0 and name == "Investment_Trust":
                its[c] = its.get(c, 0) + 1
        print(f"inst {ds} ok", flush=True)

    y1, y2 = day_signal(pd, 0), day_signal(pd, 1)
    s1, s2 = sub_signal(pd, 0, members), sub_signal(pd, 1, members)

    stocks = {}
    tot5 = 0.0
    for c in keep:
        arr = [pd[k].get(c) for k in range(5)]
        amts = [a[0] for a in arr if a]
        if not amts:
            continue
        a5 = sum(amts) / 5
        # 法人強度%（最近一日）與 破20日新低
        cur = pd[0].get(c)
        ints = 0.0
        nl = 0
        if cur and cur[0] and cur[1] is not None:
            ints = round(net0.get(c, 0) * cur[1] / cur[0] * 1000) / 10
            lows = [v[1] for v in (pd[k].get(c) for k in range(1, NDAYS)) if v and v[1] is not None]
            if lows and cur[1] < min(lows):
                nl = 1
        stocks[c] = [round(a5), it.get(c, 0), fi.get(c, 0), y1.get(c, 0), y2.get(c, 0), ints, nl, its.get(c, 0)]
        tot5 += a5
    subs_y = {}
    for k in set(s1) | set(s2):
        subs_y[k] = [s1.get(k, 0), s2.get(k, 0)]

    out = {"date": days[0], "days": days, "tot5": round(tot5), "stocks": stocks, "subs_y": subs_y}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_y1 = sum(1 for v in stocks.values() if v[3] == 1)
    n_y1d = sum(1 for v in stocks.values() if v[3] == -1)
    print(f"baseline {days[0]}: {len(stocks)} 檔, tot5={tot5/1e8:.0f}億, "
          f"昨湧{n_y1}/昨退{n_y1d} 檔, 次產業旗標 {len(subs_y)} 個, "
          f"投信3連買 {sum(1 for v in stocks.values() if v[1] == 3)} 檔, "
          f"法人強度>5% {sum(1 for v in stocks.values() if v[5] > 5)} 檔, "
          f"破底 {sum(1 for v in stocks.values() if v[6])} 檔")


if __name__ == "__main__":
    main()
