# backtest/run_down.py — 回測「退出方向」：爆量+下跌+收低 之後 2–3 日是否續跌
#
# 鏡像 run.py 的上漲版：surge ≥ S、ret ≤ -R、收盤位置 pos ≤ P(低檔)
# 判定（方向反轉）：續跌率 = P(T+3 < T)、輸大盤率 = P(超額<0)、超額報酬（負=持續弱勢）
# 對照組同 run.py。跌停鎖死另列（實務上想跑也跑不掉）。
#
# 用法：python backtest/run_down.py  → 印表 + 寫 backtest/report_down.md

from __future__ import annotations
import statistics as st
from pathlib import Path

from run import load, build, LIQ

ROOT = Path(__file__).resolve().parent.parent
GRID_S = [1.5, 2.0, 3.0]
GRID_R = [0.02, 0.04]
GRID_P = [0.4, 0.3, 0.2]      # 收盤位置 ≤（越低越弱勢）
MAIN = (2.0, 0.02, 0.3)


def stat(rows):
    if len(rows) < 20:
        return None
    n = len(rows)
    lose = lambda k: sum(1 for r in rows if r[k] < 0) / n * 100
    return dict(n=n, l1=lose("r1"), l3=lose("r3"), le3=lose("e3"),
                e3_avg=st.mean(r["e3"] for r in rows) * 100,
                e3_med=st.median(r["e3"] for r in rows) * 100)


def fmt(name, s):
    if not s:
        return f"{name:26s}  (樣本<20)"
    return (f"{name:26s} N={s['n']:6d}  T+1跌{s['l1']:5.1f}%  T+3跌{s['l3']:5.1f}%  "
            f"T+3輸大盤{s['le3']:5.1f}%  超額T+3 avg{s['e3_avg']:+6.2f}% med{s['e3_med']:+6.2f}%")


def main():
    days, price, inst = load()
    samples = build(days, price, inst)
    print(f"交易日 {len(days)} 天（{days[0]} ~ {days[-1]}），樣本 {len(samples):,}\n")
    lines = [f"# 回測報告：退出方向（爆量+下跌+收低）T+1~T+3 是否續跌",
             f"期間 {days[0]} ~ {days[-1]} · 流動性 ≥ {LIQ/1e8:.0f} 億 · 排除 ETF/興櫃 · 樣本 {len(samples):,}", ""]

    ctrl = [r for r in samples if r["surge"] < 1.2 or abs(r["ret"]) < 0.01]
    for l in ["## 基準（對照組 = 同流動性、無爆量訊號）", fmt("對照組", stat(ctrl)), "", "## 門檻網格（退出向）"]:
        print(l); lines.append(l)

    for S in GRID_S:
        for R in GRID_R:
            for P in GRID_P:
                sig = [r for r in samples if r["surge"] >= S and r["ret"] <= -R and r["pos"] <= P and not r["limd"]]
                l = fmt(f"S≥{S} R≤-{R:.0%} P≤{P}", stat(sig))
                print(l); lines.append(l)

    S, R, P = MAIN
    m_all = [r for r in samples if r["surge"] >= S and r["ret"] <= -R and r["pos"] <= P]
    no_l = [r for r in m_all if not r["limd"]]
    only_l = [r for r in m_all if r["limd"]]
    its2 = [r for r in no_l if r["its"] >= 2]
    its0 = [r for r in no_l if r["its"] == 0]
    for l in ["", f"## 主組合深掘（S≥{S} R≤-{R:.0%} P≤{P}）",
              fmt("全部", stat(m_all)), fmt("排除跌停鎖死", stat(no_l)), fmt("僅跌停鎖死", stat(only_l)),
              fmt("＋投信近3日≥2日賣超", stat(its2)), fmt("　投信近3日0賣超", stat(its0)), "",
              "## 主組合逐月（排除跌停）"]:
        print(l); lines.append(l)
    by = {}
    for r in no_l:
        by.setdefault(r["d"][:7], []).append(r)
    for m in sorted(by):
        l = fmt(f"  {m}", stat(by[m]))
        print(l); lines.append(l)

    for l in ["", "## 注意事項",
              "- 「T+3跌/輸大盤」越高於對照組 → 越有續跌延續性；超額為負 → 持續弱於大盤。",
              "- 未除權息調整；除息造成的假性下跌會輕微高估續跌（7–8月偏多）。",
              "- 收盤對收盤，未含放空成本/券源限制；跌停鎖死另列。"]:
        print(l); lines.append(l)
    (ROOT / "backtest" / "report_down.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n已寫 backtest/report_down.md")


if __name__ == "__main__":
    main()
