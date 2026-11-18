# tests/test_reconcile_daily.py — tools/reconcile_daily.py 延後對帳（2026-11-18，docs/chain-daily-recheck.md §2.7／§3.3）
#
# 免 token、免網路：對照檔（taiwan-flows 逐日檔）與 series／baseline 都由同一組合成原料產生。
# 末段另有兩支拿真實資料的測試，需要同層有 taiwan-flows checkout，沒有就 skip。
from __future__ import annotations

import copy
import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tools"))
import build_baseline as bl  # noqa: E402
import build_chain_daily as bc  # noqa: E402
import reconcile_daily as rd  # noqa: E402
import twse_holidays as th  # noqa: E402

CHAINS = ["半導體", "金融", "水泥"]
N = 120
CODES = [str(1101 + i) for i in range(N)]
PREF = ["2881A", "2882A", "2891B"]          # 特別股：FinMind 有、對照檔沒有（已知口徑差）
ETF = "0050"
CLASSIFY_AT = "2026-11-07T12:00:00+08:00"
# 21 個交易日（新→舊），避開週末與 2026 行事曆休市日
DAYS = ["2026-11-18", "2026-11-17", "2026-11-16", "2026-11-13", "2026-11-12", "2026-11-11",
        "2026-11-10", "2026-11-09", "2026-11-06", "2026-11-05", "2026-11-04", "2026-11-03",
        "2026-11-02", "2026-10-30", "2026-10-29", "2026-10-28", "2026-10-27", "2026-10-22",
        "2026-10-21", "2026-10-20", "2026-10-19"]
CAL = th.parse({"schema": 1, "years": [2026], "closed": ["2026-10-23", "2026-10-26"],
                "names": {"2026-10-23": "颱風停市"}})


def classify() -> dict:
    m = {}
    for i, c in enumerate(CODES):
        m[c] = {"t": "twse" if i % 5 else "tpex", "c": [CHAINS[i % 3]], "sh": 1000 + i,
                "p": [[CHAINS[i % 3], "次" + CHAINS[i % 3]]]}
    for c in PREF:
        m[c] = {"t": "twse", "c": ["金融"], "sh": 0, "p": []}
    m[ETF] = {"t": "twse", "c": [], "sh": 100, "p": []}
    return {"generated_at": CLASSIFY_AT, "map": m}


def raw(k: int) -> dict:
    """第 k 天（0＝最新）的 FinMind 口徑原料：{code: [amt 元, close, spread]}。金額取千元整數倍。"""
    p = {}
    for i, c in enumerate(CODES + [ETF]):
        close = round(30 + i * 0.9 + ((k * 3 + i * 7) % 13) * 0.4, 2)
        spread = round((((k + i) % 9) - 4) * 0.1, 2)
        p[c] = [1000.0 * (200_000 + ((i * 37 + k * 101) % 97) * 9_000), close, spread]
    for j, c in enumerate(PREF):            # 特別股合計約佔金融鏈 1%、市場 0.4%
        p[c] = [1000.0 * (80_000 + 500 * j + 100 * k), 50.0 + j, 0.0]
    p[bc.TAIEX] = [0, 40000.0 - 100 * k, 1.0]
    return p


def flows_doc(ds: str, prices: dict) -> dict:
    """FinMind 口徑原料 → taiwan-flows 逐日檔（千元、chg_pct；不含特別股與指數列）。"""
    rows = []
    for c, (amt, close, spread) in prices.items():
        if c.startswith("_") or c in PREF:
            continue
        chg = spread / (close - spread) * 100
        rows.append([c, close, chg, 0, amt / 1000.0])
    return {"date": ds, "cols": ["code", "close", "chg_pct", "vol", "amt"], "rows": rows}


def status(date_="2026-11-18", sev="ok") -> dict:
    return {"date": date_, "status": "ok", "healthcheck": {"date": date_, "severity": sev}}


class World:
    def __init__(self):
        self.cj = classify()
        self.cmap = self.cj["map"]
        self.raw = {d: raw(k) for k, d in enumerate(DAYS)}
        self.docs = {f"daily/{d.replace('-', '')}.json": flows_doc(d, p) for d, p in self.raw.items()}
        self.docs["status.json"] = status()
        days = {d: bc.aggregate_day(p, self.cmap) for d, p in self.raw.items()}
        dates, market, chains, _, _ = bc.columnar(days, CHAINS)
        self.series = {"classify_at": CLASSIFY_AT, "dates": dates, "market": market, "chains": chains}
        keep = bc.keep_codes(self.cmap)
        pd = [{c: (v[0], v[1], v[1] * 1.01, v[1] * 0.99) for c, v in self.raw[d].items() if c in keep}
              for d in DAYS]
        stocks, tot5 = bl.stock_rows(pd, keep, {}, {}, {}, {}, {}, {})
        self.baseline = {"date": DAYS[0], "days": list(DAYS), "tot5": round(tot5), "stocks": stocks,
                         "subs_y": {}}

    def flows(self) -> rd.Flows:
        def fetch(url):
            rel = url.split("/data/", 1)[1]
            if rel not in self.docs:
                raise FileNotFoundError(rel)          # 相當於 404
            return json.dumps(self.docs[rel]).encode()
        return rd.Flows(fetch=fetch)

    def run(self, dates, baseline=True, cal=CAL):
        return rd.run(self.series, self.baseline if baseline else None, self.cj, self.flows(),
                      dates, cal)

    def i(self, ds):
        return self.series["dates"].index(ds)


@pytest.fixture
def w():
    return World()


def tags(lines):
    return [ln.split("]")[0].lstrip("[") + "|" + ln.split("] ", 1)[1].split("：")[0]
            for ln in lines if ln.startswith("[")]


# ---------------------------------------------------------------- 相符／已知口徑差

def test_match_with_known_gap(w):
    """序列含 3 檔特別股、對照檔沒有：金融鏈與市場總額有小差，仍在門檻內 → 相符。"""
    rc, lines = w.run(sorted(DAYS[:3]))
    assert rc == 0
    assert tags(lines) == [f"相符|chain_daily {d}" for d in sorted(DAYS[:3])] + [f"相符|baseline {DAYS[0]}"]
    r = rd.recon_chain_day(w.series, DAYS[1], rd.flows_prices(w.docs["daily/20261117.json"]), w.cmap)
    s = r["stats"]
    assert 0.001 < s["market_rel"] < rd.MARKET_AMT_TOL          # 真的有口徑差，不是 0
    assert s["chain_max_name"] == "金融" and 0.003 < s["chain_max_rel"] < rd.CHAIN_AMT_TOL
    assert s["n_series"] - s["n_ref"] == len(PREF)
    assert abs(s["ret_diff"]) < rd.MARKET_RET_TOL


def test_flows_prices_roundtrip_ret():
    doc = {"date": "x", "cols": ["code", "close", "chg_pct", "vol", "amt"],
           "rows": [["1101", 50.0, 2.5, 1, 1234], ["1102", None, None, 0, None], ["1103", 10, -100, 0, 5]]}
    p = rd.flows_prices(doc)
    assert p["1101"][0] == 1_234_000.0
    assert abs(bc.ret_of(p["1101"][1], p["1101"][2]) - 0.025) < 1e-12
    assert p["1102"] == [0.0, None, None] and p["1103"][2] is None


# ---------------------------------------------------------------- 不符

def test_market_total_over_threshold(w):
    d = DAYS[1]
    w.series["market"]["amt"][w.i(d)] *= 1.02
    rc, lines = w.run([d], baseline=False)
    assert rc == 1
    errs = [x for x in lines if x.startswith("::error::")]
    assert len(errs) == 1 and d in errs[0] and "市場總額" in errs[0] and "+2." in errs[0]


def test_market_ret_over_threshold(w):
    d = DAYS[1]
    w.series["market"]["ret_ew"][w.i(d)] += 0.004
    rc, lines = w.run([d], baseline=False)
    errs = [x for x in lines if x.startswith("::error::")]
    assert rc == 1 and len(errs) == 1 and "等權報酬" in errs[0]


def test_single_chain_tampered_is_named(w):
    d = DAYS[2]
    i = w.i(d)
    orig = w.series["chains"]["水泥"]["amt"][i]
    w.series["chains"]["水泥"]["amt"][i] = orig * 1.05
    rc, lines = w.run(DAYS[:3], baseline=False)
    assert rc == 1
    errs = [x for x in lines if x.startswith("::error::")]
    assert len(errs) == 1                                        # 只報那一天那一條
    assert d in errs[0] and "「水泥」" in errs[0] and "+5.00%" in errs[0]
    assert f"{orig * 1.05:.3f}" in errs[0] and f"{orig:.3f}" in errs[0]   # 兩邊數值都列出
    assert "不符|chain_daily " + d in tags(lines)
    # 其餘兩天不受連坐
    assert sum(1 for t in tags(lines) if t.startswith("相符|chain_daily")) == 2


def test_stale_rows_incident_shape(w):
    """06-26 型：序列那天有 1/3 的個股是前一交易日的列（列數正常）→ 不符。"""
    d, prev = DAYS[1], DAYS[2]
    bad = dict(w.raw[d])
    for c in CODES[::3]:
        bad[c] = w.raw[prev][c]
    _, market, chains, _, _ = bc.columnar({d: bc.aggregate_day(bad, w.cmap)}, CHAINS)
    i = w.i(d)
    assert market["n"][0] == w.series["market"]["n"][i]          # 列數看不出來
    for k in ("amt", "ret_ew"):
        w.series["market"][k][i] = market[k][0]
    for c in CHAINS:
        w.series["chains"][c]["amt"][i] = chains[c]["amt"][0]
    rc, lines = w.run([d], baseline=False)
    assert rc == 1


# ---------------------------------------------------------------- 無法對帳（不得判不符）

def test_missing_reference_file_is_not_mismatch(w):
    d = DAYS[1]
    del w.docs[f"daily/{d.replace('-', '')}.json"]
    w.series["market"]["amt"][w.i(d)] *= 3                       # 就算序列是錯的，也無從判
    rc, lines = w.run([d], baseline=False)
    assert rc == 0 and tags(lines) == [f"無法對帳|chain_daily {d}"]
    assert not [x for x in lines if x.startswith("::error::")]


def test_wrong_date_inside_reference_file(w):
    d = DAYS[1]
    w.docs[f"daily/{d.replace('-', '')}.json"]["date"] = DAYS[2]
    rc, lines = w.run([d], baseline=False)
    assert rc == 0 and tags(lines) == [f"無法對帳|chain_daily {d}"]


@pytest.mark.parametrize("st", [status(DAYS[0], "pending"), status(DAYS[0], "critical"),
                                status(DAYS[1], "ok"), None, {"date": DAYS[0]}])
def test_unverified_reference_is_not_mismatch(w, st):
    if st is None:
        del w.docs["status.json"]
    else:
        w.docs["status.json"] = st
    d = DAYS[0]
    w.series["market"]["amt"][w.i(d)] *= 3
    rc, lines = w.run([d])
    assert rc == 0
    assert tags(lines) == [f"無法對帳|chain_daily {d}", f"無法對帳|baseline {d}"]


def test_pending_today_does_not_block_earlier_days(w):
    w.docs["status.json"] = status(DAYS[0], "pending")
    rc, lines = w.run(sorted(DAYS[:3]))
    assert rc == 0
    assert tags(lines) == [f"相符|chain_daily {DAYS[2]}", f"相符|chain_daily {DAYS[1]}",
                           f"無法對帳|chain_daily {DAYS[0]}", f"無法對帳|baseline {DAYS[0]}"]


def test_flows_verified_rules():
    assert rd.flows_verified(status("2026-11-18", "ok"), "2026-11-18") is None
    assert rd.flows_verified(status("2026-11-18", "warn"), "2026-11-18") is None
    assert rd.flows_verified(status("2026-11-18", "pending"), "2026-11-17") is None
    assert "pending" in rd.flows_verified(status("2026-11-18", "pending"), "2026-11-18")
    assert rd.flows_verified(status("2026-11-17", "ok"), "2026-11-18")
    assert rd.flows_verified(None, "2026-11-18") and rd.flows_verified({}, "2026-11-18")


def test_classify_changed_is_unable(w):
    w.cj["generated_at"] = "2026-12-05T08:00:00+08:00"
    w.series["chains"]["水泥"]["amt"][w.i(DAYS[1])] *= 2
    rc, lines = w.run([DAYS[1]], baseline=False)
    assert rc == 0 and tags(lines) == [f"無法對帳|chain_daily {DAYS[1]}"]
    assert "classify 已換版" in lines[0]


def test_date_not_in_series(w):
    rc, lines = w.run(["2026-10-16"], baseline=False)
    assert rc == 0 and tags(lines) == ["無法對帳|chain_daily 2026-10-16"]


# ---------------------------------------------------------------- 休市日

def test_closed_days_skipped(w):
    w.series["market"]["amt"][w.i(DAYS[1])] *= 3                 # 若沒略過就會報不符
    w.docs["daily/20261023.json"] = flows_doc("2026-10-23", w.raw[DAYS[1]])
    w.series["dates"].append("2026-10-23")
    cal = th.parse({"schema": 1, "years": [2026], "closed": ["2026-10-23", DAYS[1]]})
    rc, lines = w.run(["2026-10-23", "2026-10-24", DAYS[1]], baseline=False, cal=cal)
    assert rc == 0
    assert tags(lines) == ["略過|chain_daily 2026-10-23", "略過|chain_daily 2026-10-24",
                           f"略過|chain_daily {DAYS[1]}"]
    assert "休市日" in lines[0] and "週末" in lines[1]


def test_main_skips_when_target_day_closed(w, tmp_path, monkeypatch, capsys):
    """排程路徑：目標日休市 → 不讀任何對照檔、exit 0。"""
    paths = write_files(w, tmp_path)

    class Boom(rd.Flows):
        def _get(self, relpath):
            raise AssertionError("休市日不該讀對照檔")
    monkeypatch.setattr(rd, "Flows", Boom)
    monkeypatch.setattr(rd.twse_holidays, "load", lambda *a, **k: CAL)
    freeze(monkeypatch, "2026-10-24T07:30:00+08:00")             # 回推 12h＝10-23（颱風停市）
    assert rd.main(paths) == 0
    assert "目標日 2026-10-23 休市" in capsys.readouterr().out
    freeze(monkeypatch, "2026-11-15T07:30:00+08:00")             # 回推 12h＝11-14（週六）
    assert rd.main(paths) == 0
    assert "週末" in capsys.readouterr().out


# ---------------------------------------------------------------- 目標日

def test_target_day_and_pick_dates():
    f = lambda s: datetime.fromisoformat(s)                      # noqa: E731
    assert rd.target_day(f("2026-11-19T07:30:00+08:00")) == "2026-11-18"    # 準點
    assert rd.target_day(f("2026-11-19T11:59:00+08:00")) == "2026-11-18"    # 延遲 4.5 小時
    assert rd.target_day(f("2026-11-19T19:00:00+08:00")) == "2026-11-19"    # 延遲逾 4.5 小時 → 當日
    dates = sorted(DAYS)
    assert rd.pick_dates(dates, "2026-11-18") == ["2026-11-16", "2026-11-17", "2026-11-18"]
    assert rd.pick_dates(dates, "2026-11-15") == ["2026-11-11", "2026-11-12", "2026-11-13"]
    assert rd.pick_dates(dates, "2026-11-18", 0) == [] and rd.pick_dates([], "2026-11-18") == []


# ---------------------------------------------------------------- baseline

def test_baseline_match_stats(w):
    by = {d: rd.flows_prices(w.docs[f"daily/{d.replace('-', '')}.json"]) for d in DAYS}
    r = rd.recon_baseline(w.baseline, by, w.cmap)
    assert r["status"] == rd.OK
    s = r["stats"]
    assert s["compared"] == N + 1 and s["not_in_ref"] == len(PREF)   # 120 檔個股＋1 檔 ETF
    assert s["bad_a5"] == s["bad_a20"] == s["bad_flag"] == 0 and abs(s["tot_rel"]) < 1e-9


def test_baseline_a5_tampered(w):
    for c in CODES[:10]:                                         # 10/121 檔 > 1%
        w.baseline["stocks"][c][0] = round(w.baseline["stocks"][c][0] * 1.3)
    rc, lines = w.run([DAYS[0]])
    errs = [x for x in lines if x.startswith("::error::")]
    hit = [e for e in errs if "a5（5 日均額）不符 10/121 檔" in e]
    assert rc == 1 and len(hit) == 1 and any(c + " " in hit[0] for c in CODES[:10])
    assert any("a5 加總" in e for e in errs)


def test_baseline_single_stock_noise_tolerated(w):
    w.baseline["stocks"][CODES[0]][0] = round(w.baseline["stocks"][CODES[0]][0] * 1.05)
    w.baseline["stocks"][CODES[1]][8] ^= 1
    rc, _ = w.run([DAYS[0]])
    assert rc == 0                                               # 各 1/121 檔，在 1% 檔數門檻內


def test_baseline_flags_tampered(w):
    for c in CODES[:5]:
        w.baseline["stocks"][c][6] ^= 1
    rc, lines = w.run([DAYS[0]])
    assert rc == 1 and any("創高／破底旗標不符 5/" in x for x in lines)


def test_baseline_missing_day_is_unable(w):
    del w.docs[f"daily/{DAYS[7].replace('-', '')}.json"]
    for c in CODES[:30]:
        w.baseline["stocks"][c][0] *= 2
    rc, lines = w.run([DAYS[0]])
    assert rc == 0 and f"無法對帳|baseline {DAYS[0]}" in tags(lines)


def test_baseline_only_when_its_date_is_in_scope(w):
    for c in CODES[:30]:
        w.baseline["stocks"][c][0] *= 2
    rc, lines = w.run([DAYS[1]])
    assert rc == 0 and f"略過|baseline {DAYS[0]}" in tags(lines)


# ---------------------------------------------------------------- main／Flows

def write_files(w, tmp_path) -> list[str]:
    (tmp_path / "flows" / "daily").mkdir(parents=True, exist_ok=True)
    for rel, doc in w.docs.items():
        (tmp_path / "flows" / rel).write_text(json.dumps(doc), encoding="utf-8")
    for name, obj in (("series.json", w.series), ("baseline.json", w.baseline), ("classify.json", w.cj)):
        (tmp_path / name).write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    return ["--flows-dir", str(tmp_path / "flows"), "--series", str(tmp_path / "series.json"),
            "--baseline", str(tmp_path / "baseline.json"), "--classify", str(tmp_path / "classify.json")]


def freeze(monkeypatch, iso: str):
    class _DT(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromisoformat(iso).astimezone(tz)
    monkeypatch.setattr(rd, "datetime", _DT)


def test_main_end_to_end(w, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(rd.twse_holidays, "load", lambda *a, **k: CAL)
    freeze(monkeypatch, "2026-11-19T07:30:00+08:00")
    summ = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summ))
    before = {p: p.read_bytes() for p in (ROOT / "data").glob("*.json")}
    assert rd.main(write_files(w, tmp_path)) == 0
    out = capsys.readouterr().out
    assert "對帳日期：2026-11-16、2026-11-17、2026-11-18" in out and "無不符" in out
    w.series["chains"]["金融"]["amt"][w.i(DAYS[0])] *= 0.9
    assert rd.main(write_files(w, tmp_path)) == 1
    out = capsys.readouterr().out
    assert "::error::2026-11-18 產業鏈「金融」" in out
    assert "**不符** 2026-11-18 產業鏈「金融」" in summ.read_text(encoding="utf-8")
    # 指定日期；對照檔缺 → warning、exit 0
    (tmp_path / "flows" / "daily" / "20261118.json").unlink()
    assert rd.main(["--dates", "2026-11-18"] + _args(tmp_path)) == 0
    assert "::warning::[無法對帳] chain_daily 2026-11-18" in capsys.readouterr().out
    assert before == {p: p.read_bytes() for p in (ROOT / "data").glob("*.json")}   # 不寫任何資料檔


def _args(tmp_path):
    return ["--flows-dir", str(tmp_path / "flows"), "--series", str(tmp_path / "series.json"),
            "--baseline", str(tmp_path / "baseline.json"), "--classify", str(tmp_path / "classify.json")]


def test_flows_http_404_returns_none():
    import urllib.error

    def fetch(url):
        raise urllib.error.HTTPError(url, 404, "Not Found", None, None)
    f = rd.Flows(fetch=fetch)
    assert f.day("2026-11-18") is None and f.status() is None


def test_reuses_builders_not_a_second_implementation():
    """對帳的重算必須走產物本身那幾支函式（規格 §2.6）。"""
    src = (ROOT / "tools" / "reconcile_daily.py").read_text(encoding="utf-8")
    assert "bc.aggregate_day(prices, cmap)" in src and "bl.stock_rows(" in src
    assert "bc.keep_codes(cmap)" in src


# ---------------------------------------------------------------- 真實資料（需同層 taiwan-flows checkout）

FLOWS_LOCAL = ROOT.parent / "taiwan-flows" / "data"


def _real():
    series = json.loads((ROOT / "data" / "chain_daily" / "series.json").read_text(encoding="utf-8"))
    cj = json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))
    fl = rd.Flows(str(FLOWS_LOCAL))
    dates = [d for d in series["dates"][-30:] if fl.day(d)]
    return series, cj, fl, dates


@pytest.mark.skipif(not (FLOWS_LOCAL / "daily").is_dir(), reason="無同層 taiwan-flows checkout")
def test_real_recent_days_match_and_tamper_detected():
    series, cj, fl, dates = _real()
    if len(dates) < 5 or series.get("classify_at") != cj.get("generated_at"):
        pytest.skip("本機對照檔不足或 classify 已換版")
    for d in dates:
        r = rd.recon_chain_day(series, d, fl.day(d), cj["map"])
        assert r["status"] == rd.OK, (d, r["issues"])
    d = dates[-2]
    bad = copy.deepcopy(series)
    i = bad["dates"].index(d)
    bad["chains"]["半導體"]["amt"][i] *= 1.03
    r = rd.recon_chain_day(bad, d, fl.day(d), cj["map"])
    assert r["status"] == rd.MISMATCH and len(r["issues"]) == 1
    assert d in r["issues"][0] and "「半導體」" in r["issues"][0]
