#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓 TAIEX 分K (2005-2022), 每日只存聚合值到 data/taiex_daily_agg.csv (可續跑)
   另存費半日線 2004-2022 -> data/us_sox_long.parquet"""
import csv
import os
import sys
import time
from pathlib import Path

import pandas as pd
import requests

API = "https://api.finmindtrade.com/api/v4/data"
TOKEN = os.environ.get("FINMIND_TOKEN", "")
if not TOKEN:
    sys.exit("需要 FINMIND_TOKEN")

OUT = Path("data/taiex_daily_agg.csv")

def api_get(params, retries=6):
    p = dict(params, token=TOKEN)
    for i in range(retries):
        try:
            j = requests.get(API, params=p, timeout=90).json()
        except Exception as e:
            print(f"  [warn] {e}"); time.sleep(min(60, 3 * 2 ** i)); continue
        if j.get("status") == 200:
            return j.get("data", [])
        print(f"  [warn] msg={j.get('msg')}"); time.sleep(min(120, 5 * 2 ** i))
    raise RuntimeError(f"API 失敗: {params}")

# 費半長歷史 (一次)
if not Path("data/us_sox_long.parquet").exists():
    rows = api_get(dict(dataset="USStockPrice", data_id="^SOX",
                        start_date="2004-01-01", end_date="2022-12-31"))
    pd.DataFrame(rows).to_parquet("data/us_sox_long.parquet")
    print(f"SOX 長歷史 {len(rows)} 天 已存")

# 交易日曆
cal = api_get(dict(dataset="TaiwanStockPrice", data_id="0050",
                   start_date="2005-01-01", end_date="2022-12-31"))
dates = sorted({r["date"] for r in cal})
done = set()
if OUT.exists():
    done = set(pd.read_csv(OUT).date)
todo = [d for d in dates if d not in done]
print(f"交易日 {len(dates)}, 已完成 {len(done)}, 待抓 {len(todo)}")

new_file = not OUT.exists()
f = open(OUT, "a", newline="")
w = csv.writer(f)
if new_file:
    w.writerow(["date", "o0900", "p10", "c1330", "hi_am", "lo_am"])
for i, d in enumerate(todo, 1):
    rows = api_get(dict(dataset="TaiwanStockKBar", data_id="TAIEX",
                        start_date=d))
    if rows:
        df = pd.DataFrame(rows).sort_values("minute")
        am = df[df.minute < "10:00:00"]
        p10r = df[df.minute >= "10:00:00"]
        if len(am) >= 30 and len(p10r):
            w.writerow([d, am.iloc[0]["open"], p10r.iloc[0]["open"],
                        df.iloc[-1]["close"],
                        am["high"].max(), am["low"].min()])
    if i % 100 == 0:
        f.flush()
        print(f"  進度 {i}/{len(todo)}")
    time.sleep(0.25)
f.close()
print("完成")
