# tests/test_baseline_holidays.py — build_baseline.py 休市日不空等（2026-09-29 批次二，§5a）
#
# 免 token、免網路：只測純函式 fresh_wait_skip（main 本體要打 FinMind，不在離線測試範圍）。
# 行事曆用 repo 真實 data/twse_holidays.json（parse 路徑），fail-open 用 None。
from __future__ import annotations

import json
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(SRC))
import twse_holidays as th  # noqa: E402
import build_baseline as bl  # noqa: E402

REAL = th.parse(json.loads((SRC.parent / "data" / "twse_holidays.json").read_text(encoding="utf-8")), "local")


def test_real_calendar_loaded():
    assert REAL is not None and 2026 in REAL.years


def test_holidays_skip_wait():
    # 09-25（週五，中秋）／09-28（週一，教師節）：比照週末不空等
    assert bl.fresh_wait_skip("2026-09-25", REAL).startswith("國定假日")
    assert bl.fresh_wait_skip("2026-09-28", REAL).startswith("國定假日")


def test_weekend_and_trading_day_unchanged():
    assert bl.fresh_wait_skip("2026-09-26", REAL) == "週末"
    assert bl.fresh_wait_skip("2026-09-27", None) == "週末"
    assert bl.fresh_wait_skip("2026-09-29", REAL) is None   # 假日後首個交易日照常空等


def test_fail_open_equals_old_behavior():
    # 行事曆讀不到（None）→ 只排週末＝改動前 `date.today().weekday() < 5` 才等
    from datetime import date, timedelta
    d = date(2026, 1, 1)
    for _ in range(400):
        iso = d.isoformat()
        old_wait = d.weekday() < 5
        assert (bl.fresh_wait_skip(iso, None) is None) == old_wait, iso
        d += timedelta(days=1)
    # 年度未涵蓋（2027 不在 years）→ 同樣只排週末
    cal = th.parse({"schema": 1, "years": [2026], "closed": ["2027-01-01"]})
    assert bl.fresh_wait_skip("2027-01-01", cal) is None   # 2027-01-01 週五，年度未知→照等


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_") and callable(f):
            f()
            print("ok", n)
