# tests/test_aetf_stale_carry.py — build_aetf 抓取失敗時「沿用舊快照」的交易日數上限（免 token 免網路）
#
# 守的是 2026-10-23 使用者裁定 A3″-a：00996A 自 10-06 抓不到、系統一直沿用 src_date=09-21 的舊持股，
# 改為舊快照落後今天（台北）超過 STALE_MAX_TRADING_DAYS（5）個交易日就不沿用、只留 errors。
# 行事曆一律由測試自給（twse_holidays.parse），不讀磁碟、不打網路。
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import build_aetf  # noqa: E402
import twse_holidays  # noqa: E402
from build_aetf import (STALE_MAX_TRADING_DAYS, carry_decision,  # noqa: E402
                        parse_src_date, trading_days_since)

# 2026 年實際的 10 月休市日（10-09 補假、10-10 國慶），10-25／10-26 為週日／週一（光復節補假）
CAL = twse_holidays.parse({"schema": 1, "years": [2026],
                           "closed": ["2026-09-25", "2026-09-28", "2026-10-09", "2026-10-10",
                                      "2026-10-26"],
                           "names": {"2026-10-09": "國慶日補假", "2026-10-10": "國慶日"}})


def test_threshold_is_five():
    assert STALE_MAX_TRADING_DAYS == 5


def test_within_limit_carries():
    """週四 src → 下週四：中間 5 個交易日（五一二三四），剛好等於上限 → 照沿用。"""
    ok, lag, why = carry_decision({"src_date": "2026-10-15"}, date(2026, 10, 22), CAL)
    assert (ok, lag) == (True, 5)
    assert "沿用" in why


def test_over_limit_drops():
    """多一個交易日（6）就不沿用，說明字串帶天數。"""
    ok, lag, why = carry_decision({"src_date": "2026-10-15"}, date(2026, 10, 23), CAL)
    assert (ok, lag) == (False, 6)
    assert "6 個交易日" in why and "不沿用" in why


def test_00996a_real_case():
    """現況：src 2026-09-21、今天 2026-10-23 → 遠超上限。"""
    ok, lag, _ = carry_decision({"src_date": "2026-09-21"}, date(2026, 10, 23), CAL)
    assert ok is False
    # 09-22（二）..10-23（五）共 24 個平日，扣 09-25／09-28／10-09 三個休市日（10-10 是週六本來就不算）＝21
    assert lag == 21


def test_weekend_not_counted():
    """週五 src → 下週一：只算週一 1 天。"""
    assert trading_days_since(date(2026, 10, 16), date(2026, 10, 19), CAL) == 1
    # 週五 src → 週日（今天非交易日）：0
    assert trading_days_since(date(2026, 10, 16), date(2026, 10, 18), CAL) == 0


def test_holiday_not_counted():
    """10-08（週四）→ 10-16（週五）：10-09 補假、10-10／11 週末，交易日＝12..16 共 5 → 照沿用。"""
    assert trading_days_since(date(2026, 10, 8), date(2026, 10, 16), CAL) == 5
    assert carry_decision({"src_date": "2026/10/08"}, date(2026, 10, 16), CAL)[0] is True
    # 行事曆不可用（fail-open 只排週末）：10-09 被當成交易日 → 6 天 → 不沿用（偏向較早停止）
    assert trading_days_since(date(2026, 10, 8), date(2026, 10, 16), None) == 6
    assert carry_decision({"src_date": "2026/10/08"}, date(2026, 10, 16), None)[0] is False


def test_year_not_covered_fail_open():
    """年度不在 years＝該年未知、只排週末（twse_holidays 的既有契約）。"""
    assert trading_days_since(date(2027, 1, 1), date(2027, 1, 8), CAL) == 5   # 1/4..1/8


def test_both_formats_equal():
    a = carry_decision({"src_date": "2026/10/15"}, date(2026, 10, 22), CAL)
    b = carry_decision({"src_date": "2026-10-15"}, date(2026, 10, 22), CAL)
    assert a[:2] == b[:2] == (True, 5)
    assert parse_src_date("2026/10/15") == parse_src_date("2026-10-15") == date(2026, 10, 15)


def test_unparseable_does_not_carry():
    for bad in (None, "", "2026/13/01", "20261015", "2026-10-15T00:00", "abc", 20261015):
        ok, lag, why = carry_decision({"src_date": bad}, date(2026, 10, 22), CAL)
        assert ok is False and lag is None and "無法解析" in why, bad
    assert carry_decision({}, date(2026, 10, 22), CAL)[0] is False
    assert carry_decision(None, date(2026, 10, 22), CAL)[0] is False


def test_future_or_same_day_is_zero():
    """src 超前或等於今天（FinMind 對部分檔日期標記快一天）→ 0、照沿用。"""
    assert carry_decision({"src_date": "2026-10-23"}, date(2026, 10, 23), CAL)[:2] == (True, 0)
    assert carry_decision({"src_date": "2026-10-24"}, date(2026, 10, 23), CAL)[:2] == (True, 0)


def test_main_integration(tmp_path, monkeypatch):
    """main() 端到端（全部 stub）：落後 >5 的檔只留 errors、≤5 的檔沿用並標 stale。"""
    import json
    prev = {"run_date": "2026-10-22", "etfs": {
        "OLD": {"name": "old", "src_date": "2026-09-21", "stocks": {"2330": [1, "x", 1.0]}},
        "NEW": {"name": "new", "src_date": "2026/10/21", "stocks": {"2330": [1, "x", 1.0]}},
    }, "errors": {}}
    (tmp_path / "latest.json").write_text(json.dumps(prev), encoding="utf-8")
    monkeypatch.setattr(build_aetf, "OUTDIR", tmp_path)
    monkeypatch.setattr(build_aetf, "list_active_etfs",
                        lambda: [("OLD", "old"), ("NEW", "new"), ("OK", "ok")])

    def grab(code):
        if code == "OK":
            return {"stocks": {"2330": [1, "x", 1.0]}, "src_date": "2026-10-22", "units": None, "aum": 1}
        raise RuntimeError("Holding 近 14 日無資料")
    monkeypatch.setattr(build_aetf, "grab_holding", grab)
    monkeypatch.setattr(build_aetf, "grab_twse_aum", lambda c: None)
    monkeypatch.setattr(build_aetf.time, "sleep", lambda s: None)
    monkeypatch.setattr(build_aetf.twse_holidays, "load", lambda *a, **k: CAL)

    class FixedDT(build_aetf.datetime):
        @classmethod
        def now(cls, tz=None):
            return build_aetf.datetime(2026, 10, 23, 2, 30, tzinfo=tz)
    monkeypatch.setattr(build_aetf, "datetime", FixedDT)
    monkeypatch.setitem(sys.modules, "aetf_fallback",
                        type(sys)("aetf_fallback_stub"))   # 無 fetch_fallback → 補位整段 except、不影響主幹
    build_aetf.main()
    out = json.loads((tmp_path / "latest.json").read_text(encoding="utf-8"))
    assert set(out["errors"]) == {"OLD", "NEW"}
    assert "OLD" not in out["etfs"]
    assert out["etfs"]["NEW"]["stale"] is True and out["etfs"]["NEW"]["src_date"] == "2026/10/21"
    assert "OK" in out["etfs"] and "stale" not in out["etfs"]["OK"]


def test_dropped_still_offered_to_fallback(tmp_path, monkeypatch):
    """超過上限被移出 etfs 的檔仍交給投信補位；補位拿到較新資料就寫回（名稱沿用舊快照）、
    沒拿到就維持缺席。驗收 2026-10-23 指出的疑慮：否則已登記補位的檔會連補位機會一起失去。"""
    import json
    prev = {"run_date": "2026-10-22", "etfs": {
        "OLDA": {"name": "olda", "src_date": "2026-09-21", "stocks": {"2330": [1, "x", 1.0]}},
        "OLDB": {"name": "oldb", "src_date": "2026-09-21", "stocks": {"2330": [1, "x", 1.0]}},
    }, "errors": {}}
    (tmp_path / "latest.json").write_text(json.dumps(prev), encoding="utf-8")
    monkeypatch.setattr(build_aetf, "OUTDIR", tmp_path)
    monkeypatch.setattr(build_aetf, "list_active_etfs", lambda: [("OLDA", "olda"), ("OLDB", "oldb")])

    def grab(code):
        raise RuntimeError("Holding 近 14 日無資料")
    monkeypatch.setattr(build_aetf, "grab_holding", grab)
    monkeypatch.setattr(build_aetf, "grab_twse_aum", lambda c: None)
    monkeypatch.setattr(build_aetf.time, "sleep", lambda s: None)
    monkeypatch.setattr(build_aetf.twse_holidays, "load", lambda *a, **k: CAL)

    class FixedDT(build_aetf.datetime):
        @classmethod
        def now(cls, tz=None):
            return build_aetf.datetime(2026, 10, 23, 2, 30, tzinfo=tz)
    monkeypatch.setattr(build_aetf, "datetime", FixedDT)
    seen = []
    stub = type(sys)("aetf_fallback_stub")

    def fetch_fallback(codes):
        seen.extend(codes)
        return {"OLDA": {"stocks": {"2317": [2, "y", 2.0]}, "src_date": "2026-10-22",
                         "aum": 9, "fallback_src": "stub"}}
    stub.fetch_fallback = fetch_fallback
    monkeypatch.setitem(sys.modules, "aetf_fallback", stub)
    build_aetf.main()
    out = json.loads((tmp_path / "latest.json").read_text(encoding="utf-8"))
    assert set(seen) == {"OLDA", "OLDB"}
    assert out["etfs"]["OLDA"]["src_date"] == "2026-10-22"
    assert out["etfs"]["OLDA"]["name"] == "olda"
    assert out["etfs"]["OLDA"]["source"] == "issuer:stub"
    assert "stale" not in out["etfs"]["OLDA"]
    assert "OLDB" not in out["etfs"]
    assert set(out["errors"]) == {"OLDA", "OLDB"}
