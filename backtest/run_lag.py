# backtest/run_lag.py — 昨日/前日的湧入/退出訊號，對「今日」表現的影響
#
# 目的：決定湧入/退出 table 是否值得加「昨湧/昨退/連湧/連退」標註欄。
# 分組（今日樣本，過流動性）依 T-1 / T-2 是否有訊號：
#   無  ｜ 僅前日(T-2)｜ 僅昨日(T-1) ｜ 連續兩日(T-2+T-1)
# 訊號定義（沿用主組合）：
#   個股湧入 = surge≥2 & ret≥2% & pos≥0.7（排除漲停鎖死）
#   個股退出 = surge≥2 & ret≤-2% & pos≤0.3（排除跌停鎖死）
#   次產業湧入 = conc≥1.5 & ret≥1%；退出 = conc≥1.5 & ret≤-1%
# 判定：今日報酬、今日對大盤超額（勝/輸大盤率、avg/median）
#
# 用法：python backtest/run_lag.py  → 印表 + 寫 backtest/report_lag.md

from __future__ import annotations
import statistics as st
from pathlib import Path

from run import load, build
from run_sector import build_samples

ROOT = Path(__file__).resolve().parent.parent


def mret_map(days, price):
    """TAIEX 當日報酬 {date: ret}。"""
    tx = {}
    prev = None
    out = {}
    for d in days:
        row = price[d].get("_TAIEX")
        c = float(row[4]) if row and row[4] else None
        if c and prev:
            out[d] = c / prev - 1
        if c:
            prev = c
    return out


def stat(rows, key="ex"):
    if len(rows) < 30:
        return None
    n = len(rows)
    return dict(n=n,
                up=sum(1 for r in rows if r["ret"] > 0) / n * 100,
                beat=sum(1 for r in rows if r[key] > 0) / n * 100,
                avg=st.mean(r[key] for r in rows) * 100,
                med=st.median(r[key] for r in rows) * 100)


def fmt(name, s):
    if not s:
        return f"{name:22s}  (樣本<30)"
    return (f"{name:22s} N={s['n']:6d}  今日漲{s['up']:5.1f}%  勝大盤{s['beat']:5.1f}%  "
            f"今日超額 avg{s['avg']:+6.2f}% med{s['med']:+6.2f}%")


def lag_groups(samples, sig_set, prev1, prev2, keyf):
    g = {"無訊號": [], "僅前日": [], "僅昨日": [], "連續兩日": []}
    for r in samples:
        d = r["d"]
        p1, p2 = prev1.get(d), prev2.get(d)
        if not p1 or not p2:
            continue
        y1 = (keyf(r), p1) in sig_set
        y2 = (keyf(r), p2) in sig_set
        k = "連續兩日" if (y1 and y2) else "僅昨日" if y1 else "僅前日" if y2 else "無訊號"
        g[k].append(r)
    return g


def main():
    days, price, inst = load()
    mret = mret_map(days, price)
    prev1 = {days[i]: days[i-1] for i in range(1, len(days))}
    prev2 = {days[i]: days[i-2] for i in range(2, len(days))}
    lines = [f"# 昨日/前日 湧入/退出訊號 對今日表現的影響",
             f"期間 {days[0]} ~ {days[-1]} · 今日超額 = 今日報酬 − TAIEX 當日", ""]

    # ===== 個股層 =====
    samples = build(days, price, inst)
    for r in samples:
        r["ex"] = r["ret"] - mret.get(r["d"], 0.0)
    sig_in = {(r["c"], r["d"]) for r in samples
              if r["surge"] >= 2 and r["ret"] >= 0.02 and r["pos"] >= 0.7 and not r["lim"]}
    sig_out = {(r["c"], r["d"]) for r in samples
               if r["surge"] >= 2 and r["ret"] <= -0.02 and r["pos"] <= 0.3 and not r["limd"]}
    for title, sig in (("個股：昨日/前日【湧入】→ 今日", sig_in), ("個股：昨日/前日【退出】→ 今日", sig_out)):
        print(f"## {title}"); lines.append(f"## {title}")
        g = lag_groups(samples, sig, prev1, prev2, lambda r: r["c"])
        for k in ("無訊號", "僅前日", "僅昨日", "連續兩日"):
            l = fmt(k, stat(g[k])); print(l); lines.append(l)
        print(); lines.append("")

    # ===== 次產業層 =====
    import run_sector
    _, _, cl = run_sector.load()
    sec_samples, _ = build_samples(days, price, cl, "sub")
    for r in sec_samples:
        r["ex"] = r["ret"] - mret.get(r["d"], 0.0)
    ssig_in = {(r["sec"], r["d"]) for r in sec_samples if r["conc"] >= 1.5 and r["ret"] >= 0.01}
    ssig_out = {(r["sec"], r["d"]) for r in sec_samples if r["conc"] >= 1.5 and r["ret"] <= -0.01}
    for title, sig in (("次產業：昨日/前日【湧入】→ 今日", ssig_in), ("次產業：昨日/前日【退出】→ 今日", ssig_out)):
        print(f"## {title}"); lines.append(f"## {title}")
        g = lag_groups(sec_samples, sig, prev1, prev2, lambda r: r["sec"])
        for k in ("無訊號", "僅前日", "僅昨日", "連續兩日"):
            l = fmt(k, stat(g[k])); print(l); lines.append(l)
        print(); lines.append("")

    lines += ["## 判讀",
              "- 「僅昨日」與「無訊號」的差 = 昨日訊號對今日的邊際影響；「連續兩日」看疊加效果。",
              "- 個股超額為負 → 昨日訊號股今日平均弱於大盤（追高警示）；次產業為正 → 延續。"]
    (ROOT / "backtest" / "report_lag.md").write_text("\n".join(lines), encoding="utf-8")
    print("已寫 backtest/report_lag.md")


if __name__ == "__main__":
    main()
