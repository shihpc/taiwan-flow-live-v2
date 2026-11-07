# tests/test_aetf_capital.py — 群益 buyback 補位（00415A）與「只在 errors 的檔交給補位」離線測試
#
# 免 token 免網路。⚠ 群益回應樣本是**依遷移前舊碼（git show cdb00eb^:src/build_aetf.py 的
# grab_capital）欄位名合成的**，不是真實端點回應——2026-11-07 沙箱連不到 capitalfund.com.tw。
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import aetf_fallback as fb
import build_aetf
import twse_holidays

SAMPLE = {"data": {
    "pcf": {"date1": "2026-11-07T00:00:00", "totUnit": "123,456,000", "nav": "940000000"},
    "stocks": [
        {"stocNo": "2330", "stocName": "台積電 ", "share": "1,234,000", "weight": "9.87"},
        {"stocNo": "2317", "stocName": "鴻海", "share": 500000, "weight": 3.2},
        {"stocNo": "CASH", "stocName": "現金", "share": "1", "weight": "1"},      # 非台股代號 → 濾掉
        {"stocNo": "TX202611", "stocName": "台指期", "share": "-10", "weight": "0"},
        {"stocNo": "2454", "stocName": "聯發科", "share": "0", "weight": "0"},     # 0 股 → 濾掉
        "garbage",
    ]}}


def test_parse_capital_ok():
    d = fb.parse_capital(SAMPLE)
    assert d["src_date"] == "2026/11/07"
    assert d["pcf_offset"] == -1
    assert d["stocks"] == {"2330": [1234000, "台積電", 9.87], "2317": [500000, "鴻海", 3.2]}


def test_parse_capital_slash_date():
    p = json.loads(json.dumps(SAMPLE))
    p["data"]["pcf"]["date1"] = "2026/11/07"
    assert fb.parse_capital(p)["src_date"] == "2026/11/07"


def test_capital_date_t_plus_1_resolves_to_prev_trading_day():
    # pcf.date1 標「次一營業日」：週一 11-09 → 上週五 11-06；未來日（不在日曆內）也要成立
    cal = ["2026/11/04", "2026/11/05", "2026/11/06"]
    assert fb.resolve_date("2026/11/09", -1, cal) == "2026/11/06"
    assert fb.resolve_date("2026/11/06", -1, cal) == "2026/11/05"


@pytest.mark.parametrize("payload", [
    {}, {"data": None}, {"data": {"stocks": []}}, {"data": {"pcf": {}, "stocks": None}},
])
def test_parse_capital_empty_raises(payload):
    with pytest.raises(RuntimeError, match="stocks 為空"):
        fb.parse_capital(payload)


@pytest.mark.parametrize("payload", [[], "x", None, {"data": [1, 2]}])
def test_parse_capital_bad_shape_raises(payload):
    with pytest.raises((RuntimeError, TypeError)):
        fb.parse_capital(payload)


@pytest.mark.parametrize("date1", [None, "", "20261107", "N/A"])
def test_parse_capital_bad_date_raises(date1):
    p = json.loads(json.dumps(SAMPLE))
    p["data"]["pcf"]["date1"] = date1
    with pytest.raises(RuntimeError, match="date1"):
        fb.parse_capital(p)


def test_fetch_fallback_capital_end_to_end(monkeypatch):
    """登記的 00415A 走 grab_capital → T+1 回推 → 補收盤價；網路全部 stub。"""
    calls = []

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return SAMPLE

    class Sess:
        def __init__(self):
            self.headers = {}

        def post(self, url, json=None, timeout=None):
            calls.append((url, json))
            return Resp()
    monkeypatch.setattr(fb.requests, "Session", Sess)
    monkeypatch.setattr(fb, "trading_days", lambda: ["2026/11/05", "2026/11/06"])
    monkeypatch.setattr(fb, "close_prices", lambda d: {"2330": 1000.0} if d == "2026/11/06" else {})
    out = fb.fetch_fallback(["00415A", "XXXX"])
    assert calls == [(fb.CAPITAL_BUYBACK_URL, {"fundId": "504", "date": None})]
    assert set(out) == {"00415A"}
    e = out["00415A"]
    assert e["src_date"] == "2026-11-06"
    assert e["fallback_src"] == "群益"
    assert e["stocks"]["2330"] == [1234000, "台積電", 9.87, 1234000000]
    assert e["stocks"]["2317"][3] is None   # 無收盤價 → 市值留空
    assert e["aum"] == 1234000000


def test_fetch_fallback_capital_failure_is_skipped(monkeypatch):
    def boom(*a, **k):
        raise fb.requests.ConnectionError("proxy 403")
    monkeypatch.setitem(fb.FETCHERS, "00415A", ("群益", boom))
    monkeypatch.setattr(fb, "trading_days", lambda: ["2026/11/06"])
    monkeypatch.setattr(fb, "close_prices", lambda d: {})
    assert fb.fetch_fallback(["00415A"]) == {}


# ---------- build_aetf.main()：只在 errors 的檔交給補位 ----------
CAL = twse_holidays.parse({"schema": 1, "years": [2026], "closed": []})


def _setup(tmp_path, monkeypatch, fetch_fallback, aum=lambda c: 11):
    prev = {"run_date": "2026-11-05", "etfs": {
        "OK1": {"name": "ok1", "src_date": "2026-11-05", "stocks": {"2330": [1, "x", 1.0]}}},
        "errors": {"NEW1": "Holding 近 14 日無資料"}}
    (tmp_path / "latest.json").write_text(json.dumps(prev), encoding="utf-8")
    monkeypatch.setattr(build_aetf, "OUTDIR", tmp_path)
    monkeypatch.setattr(build_aetf, "list_active_etfs",
                        lambda: [("OK1", "ok1"), ("NEW1", "主動新檔"), ("NEW2", "")])

    def grab(code):
        if code == "OK1":
            return {"stocks": {"2330": [1, "x", 1.0]}, "src_date": "2026-11-06", "units": None, "aum": 1}
        raise RuntimeError("Holding 近 14 日無資料")
    monkeypatch.setattr(build_aetf, "grab_holding", grab)
    monkeypatch.setattr(build_aetf, "grab_twse_aum", aum)
    monkeypatch.setattr(build_aetf.time, "sleep", lambda s: None)
    monkeypatch.setattr(build_aetf.twse_holidays, "load", lambda *a, **k: CAL)

    class FixedDT(build_aetf.datetime):
        @classmethod
        def now(cls, tz=None):
            return build_aetf.datetime(2026, 11, 7, 2, 30, tzinfo=tz)
    monkeypatch.setattr(build_aetf, "datetime", FixedDT)
    stub = type(sys)("aetf_fallback_stub")
    stub.fetch_fallback = fetch_fallback
    monkeypatch.setitem(sys.modules, "aetf_fallback", stub)
    build_aetf.main()
    return json.loads((tmp_path / "latest.json").read_text(encoding="utf-8"))


def test_errors_only_code_offered_and_written(tmp_path, monkeypatch):
    seen = []

    def ff(codes):
        seen.extend(codes)
        return {"NEW1": {"stocks": {"2317": [2, "y", 2.0, None]}, "src_date": "2026-11-06",
                         "aum": None, "fallback_src": "群益"}}
    out = _setup(tmp_path, monkeypatch, ff)
    assert set(seen) == {"OK1", "NEW1", "NEW2"}
    e = out["etfs"]["NEW1"]
    assert e["name"] == "主動新檔"            # 名稱取 ETF 清單
    assert e["src_date"] == "2026-11-06"
    assert e["source"] == "issuer:群益"
    assert e["units"] is None
    assert e["twse_aum_yi"] == 11             # 首次寫入照一般路徑現抓集保規模
    assert out["fallback_used"]["NEW1"] == {"issuer": "群益", "from": None, "to": "2026-11-06"}
    assert "NEW2" not in out["etfs"]          # 補位沒拿到 → 維持只在 errors
    assert set(out["errors"]) == {"NEW1", "NEW2"}
    assert out["etfs"]["OK1"]["src_date"] == "2026-11-06"


def test_errors_only_name_falls_back_to_code(tmp_path, monkeypatch):
    def ff(codes):
        return {"NEW2": {"stocks": {"2317": [2, "y", 2.0, None]}, "src_date": "2026-11-06",
                         "aum": None, "fallback_src": "群益"}}
    out = _setup(tmp_path, monkeypatch, ff, aum=lambda c: None)
    assert out["etfs"]["NEW2"]["name"] == "NEW2"
    assert out["etfs"]["NEW2"]["twse_aum_yi"] is None


def test_fallback_crash_does_not_affect_trunk(tmp_path, monkeypatch):
    def ff(codes):
        raise RuntimeError("補位炸掉")
    out = _setup(tmp_path, monkeypatch, ff)
    assert set(out["etfs"]) == {"OK1"}
    assert set(out["errors"]) == {"NEW1", "NEW2"}
    assert "fallback_used" not in out
