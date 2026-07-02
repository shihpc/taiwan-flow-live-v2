# backtest/run_sector.py — 次產業/產業鏈 資金流入延續性回測
#
# 訊號日 T（sector-day）：
#   集中度 = 當日該 sector 成交額佔全市場比 ÷ 前5日均佔比 ≥ C
#   方向   = 當日 sector 等權平均漲跌 ≥ R
#   有意義門檻：sector 當日成交額 ≥ 10億、成分股 ≥ 5 檔（排除 ETF/單一股 sector）
# 判定：
#   報酬延續：T+1 / T+1~T+3 sector 等權報酬、對大盤(TAIEX)超額
#   資金黏性：T+1 佔比仍 ≥ 1.2×常態佔比 的比率（錢有沒有留下）
# 層級：次產業（classify.p 的第二層）與 產業鏈（classify.c 第一層）各跑一次
#
# 用法：python backtest/run_sector.py  → 印表 + 寫 backtest/report_sector.md

from __future__ import annotations
import gzip
import json
import statistics as st
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "backtest" / "cache"
SEC_AMT_MIN = 10e8   # sector 當日額門檻（元）
MIN_MEMBERS = 5
GRID_C = [1.3, 1.5, 2.0]
GRID_R = [0.005, 0.01, 0.02]


def rgz(p: Path):
    return json.loads(gzip.decompress(p.read_bytes()))


def f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load():
    days, price = [], {}
    for pf in sorted(CACHE.glob("price_*.json.gz")):
        d = rgz(pf)
        if not d:
            continue
        ds = pf.stem.replace("price_", "").replace(".json", "")
        days.append(ds)
        price[ds] = d
    cl = json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))["map"]
    return days, price, cl


def sector_members(cl, level: str) -> dict:
    """level='sub' → 次產業(p第二層)；level='chain' → 產業鏈(c)。排除 ETF。"""
    m = {}
    for c, info in cl.items():
        if c.startswith("00") or info.get("t") not in ("twse", "tpex"):
            continue
        keys = ({p[1] for p in info.get("p", [])} if level == "sub"
                else set(info.get("c", [])))
        for k in keys:
            m.setdefault(k, set()).add(c)
    return {k: v for k, v in m.items() if len(v) >= MIN_MEMBERS}


def run_level(days, price, cl, level: str, lines: list):
    members = sector_members(cl, level)
    tx = [f((price[d].get("_TAIEX") or [None]*5)[4]) for d in days]
    n = len(days)

    # 每日：全市場總額、各 sector 額/等權日報酬
    mkt_tot = []
    for d in days:
        tot = sum(f(r[0]) or 0 for c, r in price[d].items() if c != "_TAIEX" and not c.startswith("00"))
        mkt_tot.append(tot)

    # 預先鋪每檔 close 序列（等權報酬用）
    codes = set().union(*members.values())
    cls_ = {c: [f(price[d].get(c, [None]*5)[4]) if price[d].get(c) else None for d in days] for c in codes}
    amt_ = {c: [f(price[d].get(c, [None]*5)[0]) if price[d].get(c) else None for d in days] for c in codes}

    samples = []
    for sec, mem in members.items():
        share = [0.0] * n
        for t in range(n):
            a = sum(amt_[c][t] or 0 for c in mem)
            share[t] = a / mkt_tot[t] if mkt_tot[t] else 0.0
        for t in range(5, n - 3):
            a_now = share[t] * mkt_tot[t]
            if a_now < SEC_AMT_MIN:
                continue
            base = sum(share[t-5:t]) / 5
            if base <= 0:
                continue
            conc = share[t] / base
            # 等權當日/前瞻報酬（成員需 T-1..T+3 都有 close）
            rets, fwd1, fwd3 = [], [], []
            for c in mem:
                s = cls_[c]
                if s[t-1] and s[t] and s[t+1] and s[t+3]:
                    rets.append(s[t] / s[t-1] - 1)
                    fwd1.append(s[t+1] / s[t] - 1)
                    fwd3.append(s[t+3] / s[t] - 1)
            if len(rets) < MIN_MEMBERS:
                continue
            if not (tx[t] and tx[t+1] and tx[t+3]):
                continue
            m1, m3 = tx[t+1]/tx[t]-1, tx[t+3]/tx[t]-1
            samples.append(dict(
                d=days[t][:7], sec=sec, conc=conc, ret=st.mean(rets),
                r1=st.mean(fwd1), r3=st.mean(fwd3),
                e1=st.mean(fwd1)-m1, e3=st.mean(fwd3)-m3,
                sticky=(share[t+1] / base >= 1.2),
            ))

    def stat(rows):
        if len(rows) < 20:
            return None
        k = len(rows)
        return dict(n=k,
                    w1=sum(1 for r in rows if r["r1"] > 0)/k*100,
                    w3=sum(1 for r in rows if r["r3"] > 0)/k*100,
                    we3=sum(1 for r in rows if r["e3"] > 0)/k*100,
                    e3=st.mean(r["e3"] for r in rows)*100,
                    e3m=st.median(r["e3"] for r in rows)*100,
                    stick=sum(1 for r in rows if r["sticky"])/k*100)

    def fmt(name, s):
        if not s:
            return f"{name:24s}  (樣本<20)"
        return (f"{name:24s} N={s['n']:6d}  T+3漲{s['w3']:5.1f}%  勝大盤{s['we3']:5.1f}%  "
                f"超額avg{s['e3']:+6.2f}% med{s['e3m']:+6.2f}%  隔日資金黏{s['stick']:5.1f}%")

    lv = "次產業" if level == "sub" else "產業鏈"
    hdr = f"\n## {lv}層（{len(members)} 個分類，sector-day 樣本 {len(samples):,}）"
    print(hdr); lines.append(hdr)
    ctrl = [r for r in samples if r["conc"] < 1.1 and abs(r["ret"]) < 0.005]
    l = fmt("對照組(無訊號)", stat(ctrl)); print(l); lines.append(l)
    for C in GRID_C:
        for R in GRID_R:
            sig = [r for r in samples if r["conc"] >= C and r["ret"] >= R]
            l = fmt(f"C≥{C} R≥{R:.1%}", stat(sig)); print(l); lines.append(l)
    # 主組合逐月
    C, R = 1.5, 0.01
    main = [r for r in samples if r["conc"] >= C and r["ret"] >= R]
    sub = [f"### 主組合 C≥{C} R≥{R:.0%} 逐月"]
    by = {}
    for r in main:
        by.setdefault(r["d"], []).append(r)
    for m in sorted(by):
        sub.append(fmt(f"  {m}", stat(by[m])))
    for l in sub:
        print(l); lines.append(l)

    # 退出方向（集中度高 + 下跌）：續跌率/輸大盤率（方向反轉判讀）
    def stat_dn(rows):
        if len(rows) < 20:
            return None
        k = len(rows)
        return dict(n=k,
                    w1=sum(1 for r in rows if r["r1"] < 0)/k*100,
                    w3=sum(1 for r in rows if r["r3"] < 0)/k*100,
                    we3=sum(1 for r in rows if r["e3"] < 0)/k*100,
                    e3=st.mean(r["e3"] for r in rows)*100,
                    e3m=st.median(r["e3"] for r in rows)*100,
                    stick=sum(1 for r in rows if r["sticky"])/k*100)

    def fmt_dn(name, s):
        if not s:
            return f"{name:24s}  (樣本<20)"
        return (f"{name:24s} N={s['n']:6d}  T+3跌{s['w3']:5.1f}%  輸大盤{s['we3']:5.1f}%  "
                f"超額avg{s['e3']:+6.2f}% med{s['e3m']:+6.2f}%  隔日資金黏{s['stick']:5.1f}%")

    dn_hdr = f"### 退出方向（C≥門檻 且 當日等權下跌，續跌判讀）"
    print(dn_hdr); lines.append(dn_hdr)
    ctrl_dn = [r for r in samples if r["conc"] < 1.1 and abs(r["ret"]) < 0.005]
    l = fmt_dn("對照組(無訊號)", stat_dn(ctrl_dn)); print(l); lines.append(l)
    for C2 in GRID_C:
        for R2 in GRID_R:
            sig = [r for r in samples if r["conc"] >= C2 and r["ret"] <= -R2]
            l = fmt_dn(f"C≥{C2} R≤-{R2:.1%}", stat_dn(sig)); print(l); lines.append(l)
    dmain = [r for r in samples if r["conc"] >= 1.5 and r["ret"] <= -0.01]
    sub2 = ["### 退出主組合 C≥1.5 R≤-1% 逐月"]
    by2 = {}
    for r in dmain:
        by2.setdefault(r["d"], []).append(r)
    for m in sorted(by2):
        sub2.append(fmt_dn(f"  {m}", stat_dn(by2[m])))
    for l in sub2:
        print(l); lines.append(l)


def main():
    days, price, cl = load()
    head = (f"# 次產業/產業鏈 資金流入延續性回測\n"
            f"期間 {days[0]} ~ {days[-1]}（{len(days)} 交易日）· sector額≥{SEC_AMT_MIN/1e8:.0f}億 · 成員≥{MIN_MEMBERS} · 排除ETF\n"
            f"報酬=成分股等權、收盤對收盤；黏性=隔日佔比仍≥1.2×常態")
    print(head)
    lines = [head]
    run_level(days, price, cl, "sub", lines)
    run_level(days, price, cl, "chain", lines)
    (ROOT / "backtest" / "report_sector.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n已寫 backtest/report_sector.md")


if __name__ == "__main__":
    main()
