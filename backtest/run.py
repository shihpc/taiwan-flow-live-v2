# backtest/run.py — 回測「爆量強勢股是否維持趨勢 2–3 日」
#
# 訊號日 T（收盤篩出）：
#   surge = 當日成交額 / 前5日均額 ≥ S
#   ret   = 當日漲幅 ≥ R
#   pos   = (close-low)/(high-low) ≥ P（收盤位置）
#   流動性 = 當日成交額 ≥ 1 億；排除 ETF(00開頭)
# 判定：T+1/T+2/T+3 報酬（收盤對收盤）、對大盤(TAIEX)超額
# 對照組：同日、過流動性、但 surge<1.2 或 |ret|<1%（明確無訊號）
#
# 用法：python backtest/run.py  → 印表 + 寫 backtest/report.md

from __future__ import annotations
import gzip
import json
import statistics as st
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "backtest" / "cache"
LIQ = 1e8          # 流動性門檻（元）
GRID_S = [1.5, 2.0, 3.0]
GRID_R = [0.02, 0.04]
GRID_P = [0.6, 0.7, 0.8]
MAIN = (2.0, 0.02, 0.7)   # 主組合（逐月/漲停/投信 深掘用）


def rgz(p: Path):
    return json.loads(gzip.decompress(p.read_bytes()))


def load():
    days, price, inst = [], {}, {}
    for pf in sorted(CACHE.glob("price_*.json.gz")):
        ds = pf.stem.replace("price_", "").replace(".json", "")
        d = rgz(pf)
        if not d:
            continue
        days.append(ds)
        price[ds] = d
        ifp = CACHE / f"inst_{ds}.json.gz"
        inst[ds] = rgz(ifp) if ifp.exists() else {}
    return days, price, inst


def f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def build(days, price, inst):
    """整理成 stock-day 訊號樣本。"""
    # TAIEX 收盤序列
    tx = [f((price[d].get("_TAIEX") or [None]*5)[4]) for d in days]
    codes = set()
    for d in days:
        codes.update(price[d].keys())
    codes.discard("_TAIEX")
    codes = {c for c in codes if not c.startswith("00")}  # 排除 ETF

    samples = []  # dict per stock-day
    for c in codes:
        amt, hi, lo, cl = [], [], [], []
        for d in days:
            row = price[d].get(c)
            amt.append(f(row[0]) if row else None)
            hi.append(f(row[2]) if row else None)
            lo.append(f(row[3]) if row else None)
            cl.append(f(row[4]) if row else None)
        n = len(days)
        for t in range(5, n - 3):
            a = amt[t]
            if not a or a < LIQ:
                continue
            w = [x for x in amt[t-5:t] if x]
            if len(w) < 5:
                continue
            a5 = sum(w) / 5
            if not a5:
                continue
            pc, c0 = cl[t-1], cl[t]
            if not pc or not c0 or not cl[t+1] or not cl[t+2] or not cl[t+3]:
                continue
            h, l = hi[t], lo[t]
            if h is None or l is None:
                continue
            ret = c0 / pc - 1
            pos = (c0 - l) / (h - l) if h > l else 1.0
            if tx[t] and tx[t+1] and tx[t+2] and tx[t+3]:
                mkt = [tx[t+k] / tx[t] - 1 for k in (1, 2, 3)]
            else:
                continue
            fwd = [cl[t+k] / c0 - 1 for k in (1, 2, 3)]
            # 投信近3日買超日數（含當日）
            it_days = 0
            for k in (0, 1, 2):
                v = (inst[days[t-k]].get(c) or [0, 0])[0]
                if v > 0:
                    it_days += 1
            samples.append(dict(
                d=days[t], c=c, surge=a / a5, ret=ret, pos=pos, amt=a,
                r1=fwd[0], r2=fwd[1], r3=fwd[2],
                e1=fwd[0]-mkt[0], e2=fwd[1]-mkt[1], e3=fwd[2]-mkt[2],
                lim=(ret >= 0.095 and h == c0), it=it_days,
            ))
    return samples


def stat(rows):
    if not rows:
        return None
    n = len(rows)
    win = lambda k: sum(1 for r in rows if r[k] > 0) / n * 100
    return dict(
        n=n,
        w1=win("r1"), w3=win("r3"), we3=win("e3"),
        e3_avg=st.mean(r["e3"] for r in rows) * 100,
        e3_med=st.median(r["e3"] for r in rows) * 100,
        e1_avg=st.mean(r["e1"] for r in rows) * 100,
    )


def fmt(name, s):
    if not s:
        return f"{name:26s}  (無樣本)"
    return (f"{name:26s} N={s['n']:6d}  T+1漲{s['w1']:5.1f}%  T+3漲{s['w3']:5.1f}%  "
            f"T+3勝大盤{s['we3']:5.1f}%  超額T+3 avg{s['e3_avg']:+6.2f}% med{s['e3_med']:+6.2f}%")


def main():
    days, price, inst = load()
    print(f"交易日 {len(days)} 天（{days[0]} ~ {days[-1]}）")
    samples = build(days, price, inst)
    print(f"stock-day 樣本（過流動性）: {len(samples):,}\n")
    out = [f"# 回測報告：爆量強勢股 T+1~T+3 趨勢延續\n",
           f"期間 {days[0]} ~ {days[-1]}（{len(days)} 交易日）· 流動性 ≥ {LIQ/1e8:.0f} 億 · 排除 ETF/興櫃\n",
           f"樣本 stock-day：{len(samples):,}\n"]

    # 對照組：明確無訊號
    ctrl = [r for r in samples if r["surge"] < 1.2 or abs(r["ret"]) < 0.01]
    lines = ["## 基準（對照組 = 同流動性、無爆量訊號）", fmt("對照組", stat(ctrl)), "", "## 門檻網格"]
    print(lines[0]); print(lines[1]); print(); print(lines[3])

    for S in GRID_S:
        for R in GRID_R:
            for P in GRID_P:
                sig = [r for r in samples if r["surge"] >= S and r["ret"] >= R and r["pos"] >= P and not r["lim"]]
                line = fmt(f"S≥{S} R≥{R:.0%} P≥{P}", stat(sig))
                print(line); lines.append(line)

    S, R, P = MAIN
    main_sig = [r for r in samples if r["surge"] >= S and r["ret"] >= R and r["pos"] >= P]
    no_lim = [r for r in main_sig if not r["lim"]]
    lim = [r for r in main_sig if r["lim"]]
    it_yes = [r for r in no_lim if r["it"] >= 2]
    it_no = [r for r in no_lim if r["it"] == 0]
    sec = ["", f"## 主組合深掘（S≥{S} R≥{R:.0%} P≥{P}）",
           fmt("全部", stat(main_sig)), fmt("排除漲停鎖死", stat(no_lim)), fmt("僅漲停鎖死", stat(lim)),
           fmt("＋投信近3日≥2日買超", stat(it_yes)), fmt("　投信近3日0買超", stat(it_no)), "",
           "## 主組合逐月（排除漲停）"]
    for l in sec:
        print(l); lines.append(l)
    by_m = {}
    for r in no_lim:
        by_m.setdefault(r["d"][:7], []).append(r)
    for m in sorted(by_m):
        l = fmt(f"  {m}", stat(by_m[m]))
        print(l); lines.append(l)

    caveats = ["", "## 注意事項",
               "- 收盤對收盤報酬，未含交易成本/滑價；漲停鎖死另列（實務難買進）。",
               "- 股價未除權息調整，除息日會造成 T+k 假性下跌（7–8 月除息季偏多），對超額報酬影響小但存在。",
               "- 個股名單以目前 classify 為準，期間內下市股不在樣本（輕微存活偏差）。",
               "- 這是趨勢延續統計，非交易績效保證。"]
    for l in caveats:
        print(l); lines.append(l)
    (ROOT / "backtest" / "report.md").write_text("\n".join(out + lines), encoding="utf-8")
    print("\n已寫 backtest/report.md")


if __name__ == "__main__":
    main()
