#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v15 (最終定版): Playbook v3 — 僅保留通過「2005-2022 十八年 + 2023-2026 四年」
雙時代驗證的規則
  規則 (方向=前晚費半 ^SOX 報酬):
    大跌<-2%  : 空手 (早盤搶反彈 18 年 0/18 正年, avg -90 -> 翻車刪除)
    跌-2~-1%  : 開盤空 -> 收盤平   (17/18 + 4/4)
    小跌-1~0  : 空手 (8/18, 噪音)
    小漲0~1%  : 開盤多 -> 收盤平   (15/18 + 3/4)
    漲1~2%    : 開盤多 -> 收盤平   (18/18 + 4/4, 最強)
    大漲>2%   : 10:00空 -> 收盤平  (13/18 + 4/4)
  歷史段: TAIEX 分K 近似 (09:00 開盤/13:30 收盤, 未扣成本, 純方向驗證)
  現代段: 小台 1 分 K (08:45/13:44, 扣成本 2 點)
"""
import numpy as np
import pandas as pd

COST = 2.0

# ---- 歷史段 2005-2022 (TAIEX) ----
T = pd.read_csv("data/taiex_daily_agg.csv").sort_values("date").reset_index(drop=True)
T["pm_drift"] = T.c1330 - T.p10
T["full"] = T.c1330 - T.o0900
sox = pd.read_parquet("data/us_sox_long.parquet").sort_values("date")
sox["ret"] = sox.Close.pct_change()
sox = sox.dropna()
sd = sox.date.to_numpy(); sr = sox.ret.to_numpy()
ix = np.searchsorted(sd, T.date.to_numpy()) - 1
T["sox"] = np.where(ix >= 0, sr[np.clip(ix, 0, None)], np.nan)
T = T.dropna(subset=["sox"]).copy()
T["yr"] = T.date.str[:4]

def apply_rules(df, o_col, c_col, o10_col, cost):
    pnl = pd.Series(np.nan, index=df.index)
    m = (df.sox >= -0.02) & (df.sox < -0.01)
    pnl[m] = (df[c_col] - df[o_col]) * -1 - cost
    m = (df.sox >= 0) & (df.sox < 0.01)
    pnl[m] = (df[c_col] - df[o_col]) * 1 - cost
    m = (df.sox >= 0.01) & (df.sox < 0.02)
    pnl[m] = (df[c_col] - df[o_col]) * 1 - cost
    m = df.sox >= 0.02
    pnl[m] = (df[c_col] - df[o10_col]) * -1 - cost
    return df.assign(pnl=pnl).dropna(subset=["pnl"])

def report(res, label):
    ys = res.groupby("yr").pnl.sum()
    p = res.pnl
    t = p.mean() / (p.std() / np.sqrt(len(p)))
    print(f"\n===== {label} =====")
    print(f"出勤 {len(res)} 天, avg={p.mean():+.2f}, t={t:.2f}, "
          f"正年={int((ys>0).sum())}/{len(ys)}, 最差年={ys.min():+.0f}({ys.idxmin()}), "
          f"年均={ys.mean():+.0f} 點")
    print("逐年:", {k: int(v) for k, v in ys.items()})

hist = apply_rules(T, "o0900", "c1330", "p10", 0.0)
report(hist, "歷史段 2005-2022 (TAIEX 近似, 未扣成本)")
hist.to_csv("output/v14_longcheck_trades.csv", index=False)

# ---- 現代段 2023-2026 (小台) ----
E = pd.read_csv("output/v12_entry_obs.csv", dtype={"yr": str})
mod = apply_rules(E, "o0845", "c1344", "o10", COST)
report(mod, "現代段 2023-2026 (小台實價, 扣成本 2 點)")
mod[["date", "yr", "sox", "pnl"]].to_csv("output/v15_v3b_modern.csv", index=False)

mw = mod.copy()
mw["w"] = pd.to_datetime(mw.date).dt.strftime("%G-W%V")
wk = mw.groupby("w").pnl.sum().reindex(
    pd.to_datetime(E.date).dt.strftime("%G-W%V").unique(), fill_value=0)
eq = mod.pnl.cumsum(); mdd = (eq - eq.cummax()).min()
print(f"\n現代段週平均 {wk.mean():+.1f} 點 ({wk.mean()*50:+,.0f} 元/口), "
      f"週勝率 {(wk>0).mean():.0%}, MDD {mdd:.0f} 點")
