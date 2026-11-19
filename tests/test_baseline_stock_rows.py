# tests/test_baseline_stock_rows.py — build_baseline.stock_rows（2026-11-18 由 main() 原樣抽出）
#
# 抽出的目的是讓 tools/reconcile_daily.py 重用同一份口徑（docs/chain-daily-recheck.md §2.6）。
# 這裡以手算的小例子釘住它的輸出；「抽出前後 main() 產出逐位相同」是一次性對跑（見規格 §2.6 的紀錄）。
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import build_baseline as bl  # noqa: E402


def _pd():
    """21 天（新→舊）。A：每天都有；B：只有最近 3 天；C：完全沒有；D：最新一天沒成交額。"""
    pd = []
    for k in range(bl.NDAYS):
        day = {"A": (100.0 + k, 50.0 - k, None, None)}
        if k < 3:
            day["B"] = (300.0, 10.0 + k, None, None)
        day["D"] = (0 if k == 0 else 40.0, 5.0, None, None)
        pd.append(day)
    return pd


def test_stock_rows_values():
    stocks, tot5 = bl.stock_rows(_pd(), ["A", "B", "C", "D"], {"A": 2}, {"A": 1}, {"B": 3},
                                 {"A": 10, "B": -20}, {"A": 1}, {"B": -1})
    assert "C" not in stocks
    # A：a5=(100+101+102+103+104)/5=102；收盤 50 高於前 20 日最高 49 → nh=1；ints=round(10*50/100*1000)/10＝500.0
    assert stocks["A"] == [102, 2, 1, 1, 0, 500.0, 0, 0, 1, round(sum(100.0 + k for k in range(20)) / 20)]
    # B：只有 3 天 → a5 仍除以 5（＝180）；收盤 10 低於前兩日 11、12 → nl=1；a20 分母＝有效 3 天
    assert stocks["B"] == [180, 0, 0, 0, -1, round(-20 * 10.0 / 300.0 * 1000) / 10, 1, 3, 0, 300]
    # D：最新一天成交額 0 → ints／nh／nl 不算；a5=(0+40*4)/5；a20 濾掉零額日
    assert stocks["D"] == [32, 0, 0, 0, 0, 0.0, 0, 0, 0, 40]
    assert tot5 == 102.0 + 180.0 + 32.0


def test_stock_rows_order_follows_keep():
    stocks, _ = bl.stock_rows(_pd(), ["D", "A", "B"], {}, {}, {}, {}, {}, {})
    assert list(stocks) == ["D", "A", "B"]
