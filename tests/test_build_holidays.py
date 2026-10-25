# tests/test_build_holidays.py — src/build_holidays.py 離線測試（免網路、fetch 全注入）
#
# fixture 是**合成的形狀樣本**（欄位名 Name／Date／Weekday／Description 與 TWSE OpenAPI 相同），
# 日期與名稱只為測解析規則，不是真實行事曆，不得拿來當資料用。
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import build_holidays as bh  # noqa: E402

TPE = timezone(timedelta(hours=8))
NOW1 = datetime(2026, 9, 28, 10, 0, tzinfo=TPE)
NOW2 = datetime(2026, 10, 4, 10, 0, tzinfo=TPE)

ROWS_2026 = [
    {"Name": "中華民國開國紀念日", "Date": "1150101", "Weekday": "四", "Description": "依規定放假1日。"},
    {"Name": "市場無交易，僅辦理結算交割作業", "Date": "1150102", "Weekday": "五", "Description": ""},
    {"Name": "國曆新年開始交易日", "Date": "1150105", "Weekday": "一", "Description": "國曆新年開始交易。"},
    {"Name": "農曆春節前最後交易日", "Date": "1150211", "Weekday": "三", "Description": "農曆春節前最後交易日。"},
    {"Name": "和平紀念日", "Date": "1150227", "Weekday": "五", "Description": "補假1日。"},
    {"Name": "中秋節", "Date": "1150925", "Weekday": "五", "Description": "依規定放假1日。"},
    {"Name": "中秋節", "Date": "1150925", "Weekday": "五", "Description": "重複列"},
]


def fx(rows):
    return lambda: rows


def read(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def test_roc_date_and_rule(tmp_path):
    out = tmp_path / "h.json"
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW1) == 0
    d = read(out)
    assert d["schema"] == 1 and d["source"] == bh.SOURCE_URL
    assert d["fetched_at"] == "2026-09-28T10:00:00+08:00"
    # 民國年 1150925 → 2026-09-25；交易日標記（開始交易日／最後交易日）被濾掉
    assert d["closed"] == ["2026-01-01", "2026-01-02", "2026-02-27", "2026-09-25"]
    assert "2026-01-05" not in d["closed"] and "2026-02-11" not in d["closed"]
    assert d["years"] == [2026]
    assert d["names"]["2026-09-25"] == "中秋節"
    assert d["raw_n"] == len(ROWS_2026)


def test_roc_to_iso_edges():
    assert bh.roc_to_iso("1150925") == "2026-09-25"
    assert bh.roc_to_iso(" 1150101 ") == "2026-01-01"
    assert bh.roc_to_iso("1150230") is None      # 不存在的日期
    assert bh.roc_to_iso("20260925") is None     # 西元 8 碼不是本格式
    assert bh.roc_to_iso(None) is None


@pytest.mark.parametrize("fetch", [
    lambda: (_ for _ in ()).throw(OSError("network down")),   # 抓取失敗
    lambda: {"error": "not a list"},                            # 形狀不對
    lambda: ["x", "y"],                                         # 列不是物件
])
def test_failure_does_not_overwrite(tmp_path, fetch):
    out = tmp_path / "h.json"
    bh.run(out, fetch=fx(ROWS_2026), now=NOW1)
    before = out.read_bytes()
    assert bh.run(out, fetch=fetch, now=NOW2) == 1
    assert out.read_bytes() == before


def test_failure_without_old_file_writes_nothing(tmp_path):
    out = tmp_path / "h.json"
    assert bh.run(out, fetch=lambda: (_ for _ in ()).throw(OSError("x")), now=NOW1) == 1
    assert not out.exists()


def test_zero_closed_is_failure(tmp_path):
    out = tmp_path / "h.json"
    bh.run(out, fetch=fx(ROWS_2026), now=NOW1)
    before = out.read_bytes()
    only_markers = [r for r in ROWS_2026 if not bh.is_closed_row(r)]
    assert only_markers  # fixture 自檢：確實有交易日標記列
    assert bh.run(out, fetch=fx(only_markers), now=NOW2) == 1
    assert bh.run(out, fetch=fx([]), now=NOW2) == 1
    assert out.read_bytes() == before


def test_cross_year_merge(tmp_path):
    out = tmp_path / "h.json"
    bh.run(out, fetch=fx(ROWS_2026), now=NOW1)
    rows_2027 = [
        {"Name": "中華民國開國紀念日", "Date": "1160101", "Weekday": "五", "Description": "依規定放假1日。"},
        {"Name": "國曆新年開始交易日", "Date": "1160104", "Weekday": "一", "Description": "開始交易。"},
    ]
    assert bh.run(out, fetch=fx(rows_2027), now=NOW2) == 0
    d = read(out)
    assert d["years"] == [2026, 2027]
    assert d["closed"] == ["2026-01-01", "2026-01-02", "2026-02-27", "2026-09-25", "2027-01-01"]
    assert d["names"]["2026-09-25"] == "中秋節"   # 舊年度名稱保留


def test_same_year_is_overwritten_whole(tmp_path):
    out = tmp_path / "h.json"
    bh.run(out, fetch=fx(ROWS_2026), now=NOW1)
    fewer = [ROWS_2026[0], ROWS_2026[5]]
    assert bh.run(out, fetch=fx(fewer), now=NOW2) == 0
    d = read(out)
    assert d["closed"] == ["2026-01-01", "2026-09-25"]   # 2026 整年覆寫，不殘留舊的 01-02／02-27
    assert d["years"] == [2026]


def test_years_only_lists_fetched_with_data_and_kept(tmp_path):
    # 新抓的資料混入另一年的交易日標記（無休市列）→ 那一年不得列入 years
    out = tmp_path / "h.json"
    rows = ROWS_2026 + [{"Name": "開始交易日", "Date": "1160104", "Weekday": "一", "Description": "開始交易。"}]
    bh.run(out, fetch=fx(rows), now=NOW1)
    assert read(out)["years"] == [2026]


def test_unchanged_content_keeps_file_identical(tmp_path):
    out = tmp_path / "h.json"
    bh.run(out, fetch=fx(ROWS_2026), now=NOW1)
    before = out.read_bytes()
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW2) == 0
    assert out.read_bytes() == before                      # 位元組不變 → git diff 空、不 commit
    assert read(out)["fetched_at"] == "2026-09-28T10:00:00+08:00"


def test_changed_content_updates_fetched_at(tmp_path):
    out = tmp_path / "h.json"
    bh.run(out, fetch=fx(ROWS_2026), now=NOW1)
    bh.run(out, fetch=fx(ROWS_2026[:6]), now=NOW2)        # raw_n 變了＝內容變了
    assert read(out)["fetched_at"] == "2026-10-04T10:00:00+08:00"


def test_corrupt_old_file_treated_as_absent(tmp_path):
    out = tmp_path / "h.json"
    out.write_text("{not json", encoding="utf-8")
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW1) == 0
    assert read(out)["years"] == [2026]


# ---- 手動補登清單（2026-10-25 使用者裁定 A）----

def write_extra(tmp_path: Path, obj) -> Path:
    p = tmp_path / "extra.json"
    p.write_text(obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    return p


def test_extra_added_to_closed_and_names(tmp_path):
    out = tmp_path / "h.json"
    ex = write_extra(tmp_path, {"schema": 1, "closed": {"2026-10-23": "颱風停市"}})
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW1, extra_path=ex) == 0
    d = read(out)
    assert "2026-10-23" in d["closed"] and d["names"]["2026-10-23"] == "颱風停市"
    assert d["closed"] == sorted(d["closed"]) and list(d["names"]) == d["closed"]
    assert d["years"] == [2026]
    assert set(d) == {"schema", "source", "fetched_at", "years", "closed", "names", "raw_n"}


def test_no_extra_file_is_identical_to_before(tmp_path):
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    assert bh.run(a, fetch=fx(ROWS_2026), now=NOW1) == 0
    assert bh.run(b, fetch=fx(ROWS_2026), now=NOW1, extra_path=tmp_path / "missing.json") == 0
    assert a.read_bytes() == b.read_bytes()


def test_extra_survives_twse_rebuild(tmp_path):
    out = tmp_path / "h.json"
    ex = write_extra(tmp_path, {"schema": 1, "closed": {"2026-10-23": "颱風停市"}})
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW1, extra_path=ex) == 0
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW2, extra_path=ex) == 0
    assert "2026-10-23" in read(out)["closed"]
    # 從清單刪掉（同年度仍由 TWSE 整年覆寫）→ 下一班就消失
    ex2 = write_extra(tmp_path, {"schema": 1, "closed": {}})
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW2, extra_path=ex2) == 0
    assert "2026-10-23" not in read(out)["closed"]


def test_extra_year_not_covered_is_skipped(tmp_path, capsys):
    out = tmp_path / "h.json"
    ex = write_extra(tmp_path, {"schema": 1, "closed": {"2027-07-01": "颱風停市"}})
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW1, extra_path=ex) == 0
    d = read(out)
    assert "2027-07-01" not in d["closed"] and d["years"] == [2026]
    assert "略過" in capsys.readouterr().out


def test_extra_does_not_rename_twse_day(tmp_path):
    out = tmp_path / "h.json"
    ex = write_extra(tmp_path, {"schema": 1, "closed": {"2026-09-25": "別名"}})
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW1, extra_path=ex) == 0
    assert read(out)["names"]["2026-09-25"] == "中秋節"


def test_extra_kept_for_old_year_after_rollover(tmp_path):
    out = tmp_path / "h.json"
    ex = write_extra(tmp_path, {"schema": 1, "closed": {"2026-10-23": "颱風停市"}})
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW1, extra_path=ex) == 0
    rows_2027 = [{"Name": "中華民國開國紀念日", "Date": "1160101", "Weekday": "五", "Description": "依規定放假1日。"}]
    assert bh.run(out, fetch=fx(rows_2027), now=NOW2, extra_path=ex) == 0
    d = read(out)
    assert d["years"] == [2026, 2027] and "2026-10-23" in d["closed"]


@pytest.mark.parametrize("bad", [
    "{not json",
    {"schema": 2, "closed": {}},
    {"schema": True, "closed": {}},
    {"schema": 1, "closed": ["2026-10-23"]},
    {"schema": 1, "closed": {"2026/10/23": "x"}},
    {"schema": 1, "closed": {"2026-02-30": "x"}},
    {"schema": 1, "closed": {"2026-10-23": ""}},
    {"schema": 1, "closed": {"2026-10-23": 1}},
])
def test_bad_extra_fails_without_writing(tmp_path, bad):
    out = tmp_path / "h.json"
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW1) == 0
    before = out.read_bytes()
    ex = write_extra(tmp_path, bad)
    assert bh.run(out, fetch=fx(ROWS_2026), now=NOW2, extra_path=ex) == 1
    assert out.read_bytes() == before


def test_repo_extra_file_is_valid():
    d = bh.load_extra(bh.DEFAULT_EXTRA)
    assert d.get("2026-10-23") == "颱風停市"
