# tests/test_intraday_holidays.py — 休市日不歸檔／不定格／不入基準（2026-09-29）
#
# 起因：2026-09-25（中秋）／09-28（教師節）intraday.yml 把 KV 裡休市日殘留的 frame
#   （54 格全 stale、累計額全天同值）當成當日歸檔，污染 rrg_base.json／rrg_frozen.json。
# 免 token、免網路：行事曆以暫存檔＋假 fetch 注入，/replay、/live 以假的 get_json 注入。
# 可 `python tests/test_intraday_holidays.py` 直跑，也可 pytest。
#
# 涵蓋：
#   1. closed_reason：09-25／09-28 休市、09-29 交易日、09-26 週末（用 repo 真實行事曆）
#   2. archive_intraday.build：休市日 exit 0、不寫檔、**一次網路都不打**；09-29 照常寫檔
#   3. build_rrg_frozen.build：休市日 exit 0、不覆寫前一版、不打網路；09-29 照常寫檔
#   4. build_rrg_base.load_days：休市日檔被剔除（防既有殘檔回流）
#   5. fail-open：本地缺檔＋遠端 404／本地壞檔＋遠端壞檔／年度未涵蓋／schema 為 True 或 1.0
#      → 不拋、退回只排週末（09-25 被當交易日照常歸檔）；本地壞＋遠端好 → 用遠端
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(SRC))
import twse_holidays as th  # noqa: E402
import archive_intraday as ai  # noqa: E402
import build_rrg_frozen as bf  # noqa: E402
import build_rrg_base as bb  # noqa: E402

REAL_CAL = SRC.parent / "data" / "twse_holidays.json"
FAILED = []
_ORIG = {"th": (th.DEFAULT_PATH, th._default_fetch),
         "ai": (ai.ROOT, ai.OUT_DIR, ai.get_json),
         "bf": (bf.CLASSIFY, bf.BASE, bf.get_json),
         "bb": (bb.INTRADAY,)}


def _restore():
    """本檔會改模組常數；還原，避免同一 pytest 行程裡污染其他測試檔。"""
    th.DEFAULT_PATH, th._default_fetch = _ORIG["th"]
    ai.ROOT, ai.OUT_DIR, ai.get_json = _ORIG["ai"]
    bf.CLASSIFY, bf.BASE, bf.get_json = _ORIG["bf"]
    (bb.INTRADAY,) = _ORIG["bb"]


try:
    import pytest

    @pytest.fixture(autouse=True)
    def _auto_restore():
        yield
        _restore()
except ImportError:  # 直跑時不需要 pytest
    pass


def check(label, cond):
    ok = bool(cond)
    print(f"{'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        FAILED.append(label)


def done():
    assert not FAILED, "、".join(FAILED)


GOOD_CAL = {"schema": 1, "years": [2026], "closed": ["2026-09-25", "2026-09-28"],
            "names": {"2026-09-25": "中秋節", "2026-09-28": "教師節"}}


def _no_net(url, timeout):
    raise AssertionError(f"不該打遠端：{url}")


def _set_cal(tmp: Path, doc, fetch=_no_net):
    """把行事曆指到暫存檔（doc=None＝不存在；str＝原樣寫入壞內容）。"""
    p = tmp / "cal.json"
    if doc is not None:
        p.write_text(doc if isinstance(doc, str) else json.dumps(doc, ensure_ascii=False),
                     encoding="utf-8")
    th.DEFAULT_PATH = p
    th._default_fetch = fetch


# ---- archive 素材 -------------------------------------------------------
CLASSIFY = {"map": {
    "2330": {"t": "twse", "c": ["半導體"], "p": [["半導體", "晶圓代工"]]},
    "1101": {"t": "twse", "c": ["水泥"], "p": [["水泥", "水泥製造"]]},
}}


def _fake_get(calls):
    def g(url, retries=3):
        calls.append(url)
        if url.endswith("/live"):
            return {"stocks": {"2330": [1, 2], "1101": [1, 2]}}
        if "t=" in url:
            t = url.split("t=")[1]
            k = int(t[:2]) * 60 + int(t[3:])
            # 模擬休市日殘留：全 stale、全天同值——正是舊守門擋不住的形狀
            return {"t": t, "stale": 1, "stocks": {"2330": [1000 * k, 1.0], "1101": [30 * k, 1.0]}}
        return {"series": []}
    return g


def _archive(tmp: Path, date: str):
    (tmp / "data").mkdir(parents=True, exist_ok=True)
    (tmp / "data" / "classify.json").write_text(json.dumps(CLASSIFY, ensure_ascii=False),
                                                encoding="utf-8")
    calls: list[str] = []
    ai.ROOT = tmp
    ai.OUT_DIR = tmp / "data" / "intraday"
    ai.get_json = _fake_get(calls)
    rc = ai.build(date)
    return rc, (tmp / "data" / "intraday" / f"{date}.json").exists(), calls


# ---- frozen 素材 --------------------------------------------------------
BTIMES = [f"{m // 60:02d}:{m % 60:02d}" for m in range(545, 811, 5)]


def _frozen(tmp: Path, date: str):
    (tmp / "data").mkdir(parents=True, exist_ok=True)
    (tmp / "data" / "classify.json").write_text(json.dumps(CLASSIFY, ensure_ascii=False),
                                                encoding="utf-8")
    (tmp / "data" / "rrg_base.json").write_text(json.dumps({
        "days": ["2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"],
        "times": BTIMES, "chains": {"半導體": [0.4] * len(BTIMES), "水泥": [0.01] * len(BTIMES)},
    }), encoding="utf-8")
    bf.CLASSIFY = tmp / "data" / "classify.json"
    bf.BASE = tmp / "data" / "rrg_base.json"
    out = tmp / "data" / "rrg_frozen.json"
    out.write_text('{"date":"2026-09-24","keep":"me"}', encoding="utf-8")
    calls: list[str] = []
    bf.get_json = _fake_get(calls)
    rc = bf.build(date, out)
    kept = json.loads(out.read_text(encoding="utf-8")).get("keep") == "me"
    return rc, kept, calls


# ---- 測試 ---------------------------------------------------------------
def test_closed_reason_real_calendar():
    th.DEFAULT_PATH = REAL_CAL
    th._default_fetch = _no_net
    cal = th.load()
    check("repo 真實行事曆可讀（本地，不打網路）", cal is not None and cal.src == "local")
    check("09-25 休市（國定假日）", (th.closed_reason("2026-09-25", cal) or "").startswith("國定假日"))
    check("09-28 休市（國定假日）", (th.closed_reason("2026-09-28", cal) or "").startswith("國定假日"))
    check("09-29 交易日", th.closed_reason("2026-09-29", cal) is None)
    check("09-26 週末", th.closed_reason("2026-09-26", cal) == "週末")
    check("09-24 交易日", th.closed_reason("2026-09-24", cal) is None)
    check("格式錯誤日期不擋（回 None）", th.closed_reason("2026/09/25", cal) is None)
    done()


def test_archive_skips_holidays():
    for d in ("2026-09-25", "2026-09-28"):
        with tempfile.TemporaryDirectory() as td:
            _set_cal(Path(td), GOOD_CAL)
            rc, wrote, calls = _archive(Path(td), d)
            check(f"archive {d} 休市 → exit 0", rc == 0)
            check(f"archive {d} 休市 → 不寫檔", not wrote)
            check(f"archive {d} 休市 → 不打任何網路", calls == [])
    with tempfile.TemporaryDirectory() as td:
        _set_cal(Path(td), GOOD_CAL)
        rc, wrote, calls = _archive(Path(td), "2026-09-29")
        check("archive 09-29 平日 → 照常寫檔", rc == 0 and wrote and len(calls) > 50)
    with tempfile.TemporaryDirectory() as td:
        _set_cal(Path(td), GOOD_CAL)
        rc, wrote, calls = _archive(Path(td), "2026-09-26")
        check("archive 09-26 週六 → 不寫檔、不打網路", rc == 0 and not wrote and calls == [])
    done()


def test_frozen_skips_holidays():
    for d in ("2026-09-25", "2026-09-28"):
        with tempfile.TemporaryDirectory() as td:
            _set_cal(Path(td), GOOD_CAL)
            rc, kept, calls = _frozen(Path(td), d)
            check(f"frozen {d} 休市 → exit 0、保留前一版、不打網路",
                  rc == 0 and kept and calls == [])
    with tempfile.TemporaryDirectory() as td:
        _set_cal(Path(td), GOOD_CAL)
        rc, kept, calls = _frozen(Path(td), "2026-09-29")
        check("frozen 09-29 平日 → 照常寫檔（覆寫前一版）", rc == 0 and not kept and calls)
    done()


def test_base_drops_holiday_files():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        _set_cal(tmp, GOOD_CAL)
        idir = tmp / "intraday"
        idir.mkdir()
        for d in ("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29"):
            (idir / f"{d}.json").write_text(json.dumps({"date": d, "total": [1] * 54}),
                                            encoding="utf-8")
        bb.INTRADAY = idir
        days, dropped = bb.load_days(5, th.load())
        check("rrg_base 選日剔除休市日檔",
              [d["date"] for d in days] == ["2026-09-23", "2026-09-24", "2026-09-29"])
        check("剔除清單記為休市（cover=-1）",
              dropped == [("2026-09-25", -1.0), ("2026-09-28", -1.0)])
        days, _ = bb.load_days(5, None)
        check("rrg_base 行事曆不可用 → fail-open 只排週末（假日檔不剔除）", len(days) == 5)
    done()


def test_fail_open():
    def http404(url, timeout):
        raise RuntimeError("HTTP 404")

    cases = [
        ("本地缺檔＋遠端 404", None, http404),
        ("本地壞 JSON＋遠端壞 JSON", "{not json", lambda u, t: b"<html>"),
        ("年度未涵蓋（years=[2025]）", {**GOOD_CAL, "years": [2025]}, http404),
        ("schema 為 True（bool 須排除）", {**GOOD_CAL, "schema": True}, http404),
        ("schema 為 1.0（須恰為整數）", {**GOOD_CAL, "schema": 1.0}, http404),
        ("closed 形狀不合", {**GOOD_CAL, "closed": "2026-09-25"}, http404),
    ]
    for label, doc, fetch in cases:
        with tempfile.TemporaryDirectory() as td:
            _set_cal(Path(td), doc, fetch)
            try:
                cal = th.load()
                raised = False
            except Exception:  # noqa: BLE001
                cal, raised = None, True
            check(f"fail-open［{label}］load 不拋", not raised)
            check(f"fail-open［{label}］09-25 不判休市（只排週末）",
                  th.closed_reason("2026-09-25", cal) is None)
            check(f"fail-open［{label}］週六仍判休市",
                  th.closed_reason("2026-09-26", cal) == "週末")
            rc, wrote, _ = _archive(Path(td), "2026-09-25")
            check(f"fail-open［{label}］archive 照舊歸檔、exit 0", rc == 0 and wrote)
    with tempfile.TemporaryDirectory() as td:
        _set_cal(Path(td), "{bad", lambda u, t: json.dumps(GOOD_CAL).encode())
        cal = th.load()
        check("本地壞檔＋遠端好 → 用遠端", cal is not None and cal.src == "remote"
              and th.is_closed("2026-09-25", cal))
    done()


if __name__ == "__main__":
    test_closed_reason_real_calendar()
    test_archive_skips_holidays()
    test_frozen_skips_holidays()
    test_base_drops_holiday_files()
    test_fail_open()
    if FAILED:
        print(f"\nFAIL {len(FAILED)}：" + "、".join(FAILED))
        sys.exit(1)
    print("\nALL PASS")
