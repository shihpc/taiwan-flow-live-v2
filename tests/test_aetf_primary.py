# tests/test_aetf_primary.py — build_aetf_diff.pick_primary 的純函式測試（免 token 免網路）
#
# 守的是 2026-09-14 使用者裁示 A1-2：主基準日由 max() 改眾數（平手取大），
# laggards 分超前／落後。max 的前提「沒有任何檔會超前多數」已不成立
# （FinMind 對 4 檔的日期標記系統性快一天，14 個交易日有 9 天 16/4 分裂）。
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from build_aetf_diff import pick_primary  # noqa: E402


def test_mode_beats_max():
    """16/4 分裂時取多數那一日——這正是改口徑要解的那個情境。"""
    dates = ["2026-09-10"] * 16 + ["2026-09-11"] * 4
    assert pick_primary(dates) == "2026-09-10"
    assert max(dates) == "2026-09-11"      # 舊行為，留作對照


def test_tie_takes_later():
    """平手取大：與原 max 同向，聚合不會因為改口徑而倒退。"""
    assert pick_primary(["2026-09-10"] * 10 + ["2026-09-11"] * 10) == "2026-09-11"


def test_unanimous_unchanged():
    """全體同日時眾數＝max，輸出逐字不變（14 天中的 5 個同日場次）。"""
    dates = ["2026-09-11"] * 20
    assert pick_primary(dates) == max(dates) == "2026-09-11"


def test_empty_and_falsy():
    assert pick_primary([]) is None
    assert pick_primary([None, "", None]) is None
    assert pick_primary([None, "2026-09-11"]) == "2026-09-11"


def test_direction_split():
    """dir 的判準就是與 primary 的字典序比較（ISO 日期，字典序＝時序）。"""
    d1 = {"A": "2026-09-10", "B": "2026-09-10", "C": "2026-09-11", "D": "2026-09-09"}
    primary = pick_primary(list(d1.values()))
    assert primary == "2026-09-10"
    dirs = {c: ("ahead" if d > primary else "behind") for c, d in d1.items() if d != primary}
    assert dirs == {"C": "ahead", "D": "behind"}
