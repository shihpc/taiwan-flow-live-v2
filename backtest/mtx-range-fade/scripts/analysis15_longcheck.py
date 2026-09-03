#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v14: Playbook 方向規則 x 2005-2022 TAIEX 十八年獨立驗證
  近似: 進場 09:00 (TAIEX 開盤, 期貨為 08:45)、收盤 13:30 (期貨 13:44)
  規則 (方向=前晚費半, 無量能過濾, 未扣成本 — 純方向驗證):
    大跌<-2% : 多 09:00->10:00 | 跌-2~-1%: 空 全日 | 小跌-1~0: 多 全日
    小漲0~1% : 空手            | 漲1~2%  : 多 全日 | 大漲>2% : 空 10:00->13:30
"""
import numpy as np
import pandas as pd

T = pd.read_csv("data/taiex_daily_agg.csv").sort_values("date").reset_index(drop=True)
T["m_drift"] = T.p10 - T.o0900
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
print(f"樣本 {len(T)} 天 ({T.date.min()} ~ {T.date.max()})")

pnl = pd.Series(np.nan, index=T.index)
m = T.sox < -0.02;                    pnl[m] = T.m_drift[m]
m = (T.sox >= -0.02) & (T.sox < -0.01); pnl[m] = -T.full[m]
m = (T.sox >= -0.01) & (T.sox < 0);     pnl[m] = T.full[m]
m = (T.sox >= 0.01) & (T.sox < 0.02);   pnl[m] = T.full[m]
m = T.sox >= 0.02;                    pnl[m] = -T.pm_drift[m]
T["pnl"] = pnl
res = T.dropna(subset=["pnl"])

print(f"\n===== Playbook 合併 (出勤 {len(res)}/{len(T)} 天, 未扣成本, 指數點) =====")
ytab = res.groupby("yr").pnl.agg(n="count", avg="mean", total="sum",
                                 win=lambda p: (p > 0).mean())
ytab["avg"] = ytab.avg.round(1); ytab["total"] = ytab.total.round(0)
ytab["win"] = (ytab.win * 100).round(0).astype(int).astype(str) + "%"
print(ytab.to_string())
pos = (res.groupby("yr").pnl.sum() > 0).sum()
p = res.pnl; t = p.mean() / (p.std() / np.sqrt(len(p)))
print(f"\n正年數 {pos}/{ytab.shape[0]}  全期 avg={p.mean():+.2f} t={t:.2f}")

print("\n===== 各桶 18 年統計 =====")
BUCK = [("大跌<-2% 早盤多", T.sox < -0.02, T.m_drift),
        ("跌-2~-1% 全日空", (T.sox >= -0.02) & (T.sox < -0.01), -T.full),
        ("小跌-1~0 全日多", (T.sox >= -0.01) & (T.sox < 0), T.full),
        ("小漲0~1% (空手,參考全日多)", (T.sox >= 0) & (T.sox < 0.01), T.full),
        ("漲1~2% 全日多", (T.sox >= 0.01) & (T.sox < 0.02), T.full),
        ("大漲>2% 盤中空", T.sox >= 0.02, -T.pm_drift)]
for name, m, v in BUCK:
    x = v[m].dropna()
    ys = v[m].groupby(T.yr[m]).sum()
    ys = ys[v[m].groupby(T.yr[m]).count() >= 5]
    t = x.mean() / (x.std() / np.sqrt(len(x))) if len(x) > 1 else np.nan
    print(f"  {name:<24s} n={len(x):4d} avg={x.mean():+7.2f} t={t:+5.2f} "
          f"正年={int((ys>0).sum())}/{len(ys)}")
res.to_csv("output/v14_longcheck_trades.csv", index=False)
