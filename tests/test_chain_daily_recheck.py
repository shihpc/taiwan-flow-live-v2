# tests/test_chain_daily_recheck.py — build_chain_daily.py 近日重抓（2026-11-18，docs/chain-daily-recheck.md §1／§3.2）
#
# 免 token、免網路：把 fetch_day 換成回放固定原料的 stub、CLASSIFY／CACHE 指到 tmp。
# 原料是合成的（真實 FinMind 原始列不在 git 裡，無從取得「當時的原料」）；另有一組測試
# 直接拿 repo 真實的 data/chain_daily/series.json 驗「重抓失敗／回空時逐位不變」。
from __future__ import annotations

import copy
import json
import shutil
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import build_chain_daily as bc  # noqa: E402

START = "2025-01-01"
NDAYS = 130                      # ≥ MIN_DAYS（120）
CODES = [f"{1101 + i}" for i in range(40)] + ["0050", "2891A"]
CHAINS = ["甲鏈", "乙鏈", "丙鏈"]


def make_classify() -> dict:
    m = {}
    for i, c in enumerate(CODES):
        if c == "0050":
            m[c] = {"t": "twse", "c": [], "sh": 1000}
        else:
            cs = [CHAINS[i % 3]] + ([CHAINS[(i + 1) % 3]] if i % 4 == 0 else [])
            m[c] = {"t": "twse", "c": cs, "sh": 0 if c == "2891A" else 1000 + 37 * i}
    m["9999"] = {"t": "tpex", "c": ["甲鏈"], "sh": 500}      # 上櫃：不計
    return {"generated_at": "2025-01-01T00:00:00+08:00", "map": m}


def trading_dates() -> list[str]:
    out, d = [], date.fromisoformat(START)
    while len(out) < NDAYS:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


DATES = trading_dates()


def raw_day(k: int) -> dict:
    """第 k 個交易日的原料：{code: [amt, close, spread]}＋_TAIEX；決定性、每天不同。"""
    p = {}
    for i, c in enumerate(CODES + ["9999"]):
        close = round(20 + i * 1.7 + ((k * (i + 3)) % 11) * 0.35, 2)
        spread = round((((k + i) % 7) - 3) * 0.15, 2)
        amt = float(1_000_000 * (5 + (i * 13 + k * 7) % 23) + 12345 * i)
        p[c] = [amt, close, spread]
    p[bc.TAIEX] = [0, round(20000 + 37.5 * k + (k % 5) * 11.25, 2), 1.0]
    return p


class Env:
    def __init__(self, tmp: Path, monkeypatch):
        self.tmp = tmp
        self.out = tmp / "series.json"
        self.raw = {d: raw_day(k) for k, d in enumerate(DATES)}
        self.calls: list[str] = []
        self.fail: set[str] = set()
        cp = tmp / "classify.json"
        cp.write_text(json.dumps(make_classify(), ensure_ascii=False), encoding="utf-8")
        monkeypatch.setattr(bc, "CLASSIFY", cp)
        monkeypatch.setattr(bc, "CACHE", tmp / "cache")
        monkeypatch.setattr(bc, "SLEEP", 0)
        monkeypatch.setattr(bc, "fetch_day", self.fetch)

    def fetch(self, ds: str) -> dict:
        self.calls.append(ds)
        if ds in self.fail:
            raise RuntimeError("stub: API 掛了")
        return copy.deepcopy(self.raw.get(ds, {}))

    def build(self, **kw) -> int:
        self.calls = []
        return bc.build(START, DATES[-1], self.out, kw.pop("rebuild", False),
                        kw.pop("offline", False), **kw)

    def load(self) -> dict:
        return json.loads(self.out.read_text(encoding="utf-8"))

    def body(self) -> dict:
        j = self.load()
        j.pop("generated_at")
        return j

    def drop_cache(self):
        """模擬 CI：backtest/cache 被 .gitignore，runner 上每次都是空的。"""
        shutil.rmtree(self.tmp / "cache", ignore_errors=True)


@pytest.fixture
def env(tmp_path, monkeypatch):
    e = Env(tmp_path, monkeypatch)
    assert e.build() == 0
    assert e.load()["dates"] == DATES
    return e


def col(j: dict, i: int) -> dict:
    """第 i 天的全部欄位（跨日衍生的 taiex_ret 也在內）。"""
    out = {f"m.{k}": v[i] for k, v in j["market"].items()}
    for c, t in j["chains"].items():
        out.update({f"{c}.{k}": v[i] for k, v in t.items()})
    out.update({f"cov.{k}": v[i] for k, v in j["coverage"].items() if isinstance(v, list)})
    out.update({f"q.{k}": v[i] for k, v in j["quality"].items()})
    return out


# ---------------------------------------------------------------- 純函式

def test_recheck_targets():
    assert bc.RECHECK_DAYS == 3
    assert bc.recheck_targets(DATES) == DATES[-3:]
    assert bc.recheck_targets(set(DATES), 1) == DATES[-1:]
    assert bc.recheck_targets(DATES, 0) == []
    assert bc.recheck_targets([], 3) == []


def test_recheck_reject_reason():
    old = {"market": {"n": 1000, "amt": 100e8, "taiex": 20000.0}}
    ok = {"market": {"n": 990, "amt": 95e8, "taiex": 20001.0}}
    assert bc.recheck_reject_reason(old, ok) is None
    assert bc.recheck_reject_reason(old, {"market": {"n": 1300, "amt": 180e8, "taiex": 1.0}}) is None
    assert "檔數" in bc.recheck_reject_reason(old, {"market": {"n": 979, "amt": 100e8, "taiex": 1.0}})
    assert "總額" in bc.recheck_reject_reason(old, {"market": {"n": 1000, "amt": 89e8, "taiex": 1.0}})
    assert "指數" in bc.recheck_reject_reason(old, {"market": {"n": 1000, "amt": 100e8, "taiex": None}})


# ---------------------------------------------------------------- 冪等

@pytest.mark.parametrize("ci", [True, False])
def test_same_data_is_byte_identical(env, ci, capsys):
    if ci:
        env.drop_cache()
    before_text = env.out.read_text(encoding="utf-8")
    before = env.body()
    assert env.build() == 0
    assert env.calls == DATES[-3:]                      # 只重抓最近 3 個交易日
    after_text = env.out.read_text(encoding="utf-8")
    assert env.body() == before
    # 序列化後除 generated_at 那一段外逐位相同
    ga, gb = json.loads(before_text)["generated_at"], json.loads(after_text)["generated_at"]
    assert after_text.replace(gb, ga) == before_text
    assert "近日重抓 3 天" in capsys.readouterr().out
    assert env.build() == 0 and env.body() == before    # 再跑一輪仍不變


def test_new_day_appended_and_recent_rechecked(env):
    """一般班次的樣子：序列少最後一天 → 補那天＋重抓它前面 3 天。"""
    full = env.body()
    j = env.load()
    env.drop_cache()
    # 造一份「還沒有最後一天」的序列：用 end 提前一天重建
    assert bc.build(START, DATES[-2], env.out, True, False) == 0
    env.drop_cache()
    assert env.build() == 0
    assert env.calls == DATES[-4:]
    got = env.body()
    assert got["dates"] == j["dates"]
    for i in range(NDAYS - 1):
        assert col(got, i) == col(full, i)
    # 最後一天是新抓的，前一天（重抓）有載入原始價 → sp0 診斷欄有值；其餘欄位與全量建置相同
    last = {k: v for k, v in col(got, NDAYS - 1).items() if not k.startswith("q.sp0")}
    assert last == {k: v for k, v in col(full, NDAYS - 1).items() if not k.startswith("q.sp0")}


# ---------------------------------------------------------------- 原料有變

def test_changed_raw_updates_day_and_dependents_only(env):
    env.drop_cache()
    before = env.load()
    k = NDAYS - 2                                        # 倒數第 2 天（在重抓窗內）
    d = DATES[k]
    for c in CODES[:15]:
        env.raw[d][c][0] *= 1.5                          # 成交額
        env.raw[d][c][2] += 0.3                          # 漲跌
    env.raw[d][bc.TAIEX][1] += 123.0                     # 指數收盤
    assert env.build() == 0
    after = env.load()
    assert after["dates"] == before["dates"]
    for i in range(NDAYS):
        if i < k:
            assert col(after, i) == col(before, i), DATES[i]      # 更早的日期逐位不變
    a, b = col(after, k), col(before, k)
    assert a["m.amt"] != b["m.amt"] and a["m.ret_ew"] != b["m.ret_ew"]
    assert a["m.taiex"] == b["m.taiex"] + 123.0
    assert a["甲鏈.amt"] != b["甲鏈.amt"] and a["甲鏈.share"] != b["甲鏈.share"]
    # 依賴前一日的衍生欄：當日與「次日」的 taiex_ret 都要跟著新收盤走
    tx = after["market"]["taiex"]
    assert a["m.taiex_ret"] == bc.sig(tx[k] / tx[k - 1] - 1, 5) != b["m.taiex_ret"]
    n1 = col(after, k + 1)
    assert n1["m.taiex_ret"] == bc.sig(tx[k + 1] / tx[k] - 1, 5) != col(before, k + 1)["m.taiex_ret"]
    # 次日其餘欄位（單日自足）不變
    assert {x: v for x, v in n1.items() if x != "m.taiex_ret"} == \
           {x: v for x, v in col(before, k + 1).items() if x != "m.taiex_ret"}
    # 與「拿新原料從頭全量建置」一致（sp0 診斷欄除外：全量建置時有前一日原始價可比）
    env.drop_cache()
    assert bc.build(START, DATES[-1], env.tmp / "full.json", True, False) == 0
    full = json.loads((env.tmp / "full.json").read_text(encoding="utf-8"))
    for key in ("dates", "market", "chains", "coverage"):
        assert after[key] == full[key], key


def test_older_day_not_rechecked(env):
    env.drop_cache()
    before = env.body()
    d = DATES[-4]                                        # 重抓窗外
    env.raw[d][CODES[0]][0] *= 3
    assert env.build() == 0
    assert d not in env.calls
    assert env.body() == before


def test_recheck_days_zero_disables(env):
    env.drop_cache()
    before = env.body()
    env.raw[DATES[-1]][CODES[0]][0] *= 3
    assert env.build(recheck_days=0) == 0
    assert env.calls == [] and env.body() == before
    assert env.build(offline=True) == 0 and env.calls == [] and env.body() == before


# ---------------------------------------------------------------- 失敗／回空／較差資料：保留既有值

def _worsen(env, d, how):
    if how == "fail":
        env.fail.add(d)
    elif how == "empty":
        env.raw[d] = {}
    elif how == "zero_amt":
        for c in env.raw[d]:
            env.raw[d][c][0] = 0
    elif how == "fewer_rows":                            # 少 10% 的列（門檻 2%）
        for c in CODES[:5]:
            del env.raw[d][c]
    elif how == "amt_drop":                              # 總額掉 30%（門檻 10%），列數不變
        for c in env.raw[d]:
            env.raw[d][c][0] *= 0.7
    elif how == "no_taiex":
        del env.raw[d][bc.TAIEX]


@pytest.mark.parametrize("how", ["fail", "empty", "zero_amt", "fewer_rows", "amt_drop", "no_taiex"])
def test_bad_refetch_keeps_existing(env, how, capsys):
    env.drop_cache()
    before = env.body()
    d = DATES[-2]
    _worsen(env, d, how)
    capsys.readouterr()
    assert env.build() == 0                              # 整班不得失敗
    err = capsys.readouterr().err
    assert env.calls == DATES[-3:]                       # 其餘兩天照常重抓
    assert env.body() == before                          # 該日保留既有值、沒被刪也沒被清空
    assert f"::warning::{d}" in err


def test_bad_refetch_does_not_block_other_days(env, capsys):
    env.drop_cache()
    before = env.load()
    env.fail.add(DATES[-2])
    env.raw[DATES[-1]][CODES[1]][0] *= 2
    assert env.build() == 0
    after = env.load()
    assert col(after, NDAYS - 2) == col(before, NDAYS - 2)
    assert col(after, NDAYS - 1)["m.amt"] != col(before, NDAYS - 1)["m.amt"]


def test_recheck_force_overrides_worse_guard_but_not_empty(env):
    env.drop_cache()
    before = env.load()
    d = DATES[-2]
    _worsen(env, d, "fewer_rows")
    assert env.build(recheck_dates=[d], recheck_force=True) == 0
    after = env.load()
    assert after["market"]["n"][NDAYS - 2] == before["market"]["n"][NDAYS - 2] - 5
    env.raw[d] = {}
    body = env.body()
    assert env.build(recheck_dates=[d], recheck_force=True) == 0
    assert env.body() == body


# ---------------------------------------------------------------- 指定日期重算

def test_recheck_dates_only_those(env, capsys):
    env.drop_cache()
    before = env.load()
    k = 60
    d = DATES[k]
    env.raw[d][CODES[2]][0] *= 4
    env.raw[DATES[-1]][CODES[2]][0] *= 4                 # 最近一天也變了，但沒被指定 → 不動
    assert env.build(recheck_dates=[d]) == 0
    assert d in env.calls and not (set(env.calls) & set(DATES[-3:]))
    after = env.load()
    for i in range(NDAYS):
        if i == k:
            assert col(after, i)["m.amt"] != col(before, i)["m.amt"]
        else:
            ign = {"q.sp0_up", "q.sp0_n"} if i == k + 1 else set()
            assert {x: v for x, v in col(after, i).items() if x not in ign} == \
                   {x: v for x, v in col(before, i).items() if x not in ign}, DATES[i]


def test_recheck_dates_unknown_date_warns(env, capsys):
    before = env.body()
    capsys.readouterr()
    assert env.build(recheck_dates=["2024-01-02"]) == 0
    assert "不在既有序列內" in capsys.readouterr().err
    assert env.calls == [] and env.body() == before


def test_next_day_sp0_follows_rechecked_close(env):
    """sp0 診斷欄＝「spread==0 但收盤高於前一日收盤」；重算日的收盤變了，次日的 sp0 要跟著變。"""
    k = 60
    d, nxt = DATES[k], DATES[k + 1]
    before = env.load()
    assert before["quality"]["sp0_n"][k + 1] is not None          # 全量建置時有值
    base_hit = before["quality"]["sp0_up"][k + 1]
    # 次日 spread==0 的個股，把重算日的收盤壓到比次日收盤低 → 次日命中數增加
    flat = [c for c in CODES if c != "0050" and env.raw[nxt][c][2] == 0]
    assert flat
    for c in flat:
        env.raw[d][c][1] = env.raw[nxt][c][1] - 1.0
    assert env.build(recheck_dates=[d]) == 0
    after = env.load()
    assert len(flat) > base_hit                                   # 前提：竄改確實會改變答案
    assert after["quality"]["sp0_up"][k + 1] == len(flat)
    assert after["meta"]["spread_zero_up"]["stock_days"] == sum(
        v for v in after["quality"]["sp0_up"] if v)


# ---------------------------------------------------------------- 真實序列

REAL = ROOT / "data" / "chain_daily" / "series.json"


@pytest.mark.parametrize("mode", ["fail", "empty"])
def test_real_series_untouched_when_refetch_fails(tmp_path, monkeypatch, mode, capsys):
    """拿 repo 真實的 series.json：最近 3 日重抓失敗／回空 → 寫回的檔與原檔逐位相同
    （只差 generated_at；classify 若已換版則另差 classify_at 與 meta.limits 第一句）。"""
    if not REAL.exists():
        pytest.skip("無 data/chain_daily/series.json")
    out = tmp_path / "series.json"
    shutil.copy(REAL, out)
    monkeypatch.setattr(bc, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(bc, "SLEEP", 0)
    calls = []

    def fetch(ds):
        calls.append(ds)
        if mode == "fail":
            raise RuntimeError("stub")
        return {}
    monkeypatch.setattr(bc, "fetch_day", fetch)
    src = json.loads(REAL.read_text(encoding="utf-8"))
    assert bc.build(bc.START_DEFAULT, src["dates"][-1], out, False, False) == 0
    got = json.loads(out.read_text(encoding="utf-8"))
    assert calls == src["dates"][-3:]
    cj = json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))
    same_classify = cj.get("generated_at") == src.get("classify_at")
    for k in src:
        if k == "generated_at" or (not same_classify and k in ("classify_at", "meta")):
            continue
        assert got[k] == src[k], k
    if same_classify:
        text = out.read_text(encoding="utf-8").replace(got["generated_at"], src["generated_at"])
        assert text == REAL.read_text(encoding="utf-8")
    assert capsys.readouterr().err.count("::warning::") == 3


# ---------------------------------------------------------------- 重抓原料形狀異常（2026-11-18 驗收後補）

def _malform(env, d, how):
    if how == "str":                                     # 字串型數值
        for c in CODES[:10]:
            env.raw[d][c] = [str(env.raw[d][c][0]), str(env.raw[d][c][1]), str(env.raw[d][c][2])]
    elif how == "str_close":
        env.raw[d][CODES[3]][1] = "abc"
    elif how == "none":                                  # 整列是 None
        env.raw[d][CODES[0]] = None
    elif how == "short":                                 # 缺欄且型別不對
        env.raw[d][CODES[0]] = "x"
    elif how == "taiex":
        env.raw[d][bc.TAIEX] = ["0", "abc", "z"]


@pytest.mark.parametrize("how", ["str", "str_close", "none", "short", "taiex"])
def test_malformed_refetch_keeps_existing(env, how, capsys):
    env.drop_cache()
    before_text = env.out.read_text(encoding="utf-8")
    d = DATES[-2]
    _malform(env, d, how)
    capsys.readouterr()
    assert env.build() == 0
    err = capsys.readouterr().err
    assert env.calls == DATES[-3:]                       # 壞的那天不擋後面的日子
    after = env.load()
    assert env.out.read_text(encoding="utf-8").replace(
        after["generated_at"], json.loads(before_text)["generated_at"]) == before_text
    assert f"::warning::{d} 重抓資料無法計算（" in err and "Error）" in err
    assert not (env.tmp / "cache" / f"chainday_{d}.json.gz").exists()    # 壞原料不落 cache


def test_malformed_new_day_behaviour_unchanged(env):
    """同一份壞原料出現在「新的一天」：既有設計是讓例外往外拋（baffaa5 與之前皆然），本批不改。"""
    env.drop_cache()
    assert bc.build(START, DATES[-2], env.out, True, False) == 0     # 序列還沒有最後一天
    env.drop_cache()
    _malform(env, DATES[-1], "str")
    with pytest.raises(TypeError):
        env.build()


def test_null_sp0_stays_null_after_recheck(env):
    """CI 產的日子 sp0 是 null；重抓（即使前一日原始價就在記憶體、內容也變了）不得把它填成數字。"""
    j = env.load()
    for k in ("sp0_up", "sp0_n"):
        for i in range(NDAYS - 3, NDAYS):
            j["quality"][k][i] = None
    env.out.write_text(json.dumps(j, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    env.raw[DATES[-1]][CODES[1]][0] *= 2                 # cache 保留：前一日原始價拿得到
    assert env.build() == 0
    after = env.load()
    assert after["market"]["amt"][-1] != j["market"]["amt"][-1]
    for k in ("sp0_up", "sp0_n"):
        assert after["quality"][k][-3:] == [None, None, None]
        assert after["quality"][k][:-3] == j["quality"][k][:-3]


def test_real_series_untouched_when_every_refetch_raises_typeerror(tmp_path, monkeypatch, capsys):
    if not REAL.exists():
        pytest.skip("無 data/chain_daily/series.json")
    cj = json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))
    src = json.loads(REAL.read_text(encoding="utf-8"))
    if cj.get("generated_at") != src.get("classify_at"):
        pytest.skip("classify 已換版")
    out = tmp_path / "series.json"
    shutil.copy(REAL, out)
    monkeypatch.setattr(bc, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(bc, "SLEEP", 0)
    monkeypatch.setattr(bc, "fetch_day", lambda ds: {"2330": ["1", "2", "3"], bc.TAIEX: [0, 1.0, 0]})
    assert bc.build(bc.START_DEFAULT, src["dates"][-1], out, False, False) == 0
    got = json.loads(out.read_text(encoding="utf-8"))
    assert out.read_text(encoding="utf-8").replace(got["generated_at"], src["generated_at"]) == \
        REAL.read_text(encoding="utf-8")
    assert capsys.readouterr().err.count("（TypeError），保留既有值") == 3


# ---------------------------------------------------------------- 不印例外內容／擋 NaN‧inf（2026-11-18 重驗後補）

FAKE = "FAKE_TOKEN_abc123"


def _strict(text: str) -> dict:
    def boom(x):
        raise AssertionError(f"非法 JSON 常數 {x}")
    return json.loads(text, parse_constant=boom)


def test_warnings_never_print_exception_text(env, capsys, monkeypatch):
    env.drop_cache()
    before = env.body()

    def fetch(ds):
        env.calls.append(ds)
        raise RuntimeError(f"401 Client Error for url: https://x/api/v4/data?dataset=T&token={FAKE}")
    monkeypatch.setattr(bc, "fetch_day", fetch)
    capsys.readouterr()
    assert env.build() == 0
    cap = capsys.readouterr()
    assert FAKE not in cap.out + cap.err and "token=" not in cap.out + cap.err
    for d in DATES[-3:]:
        assert f"::warning::{d} 重抓失敗（RuntimeError），保留既有值" in cap.err
    assert env.body() == before


def test_sp0_prev_fetch_warning_has_no_exception_text(env, capsys, monkeypatch):
    """既有 sp0 有值、當日內容有變、前一日不在 cache → 會現抓前一日；那次失敗的 warning 也不得帶例外內容。"""
    d = DATES[-3]
    (env.tmp / "cache" / f"chainday_{DATES[-4]}.json.gz").unlink()
    env.raw[d][CODES[0]][0] *= 2
    env.fail.add(DATES[-4])
    orig = env.fetch

    def fetch(ds):
        if ds in env.fail:
            env.calls.append(ds)
            raise RuntimeError(f"boom token={FAKE}")
        return orig(ds)
    monkeypatch.setattr(bc, "fetch_day", fetch)
    capsys.readouterr()
    assert env.build() == 0
    cap = capsys.readouterr()
    assert DATES[-4] in env.calls and FAKE not in cap.out + cap.err
    assert f"::warning::{DATES[-4]} 前一日原始價抓取失敗" in cap.err and "RuntimeError" in cap.err


@pytest.mark.parametrize("how", ["taiex_nan", "taiex_inf", "amt_nan", "close_inf", "spread_nan"])
def test_non_finite_refetch_keeps_existing(env, how, capsys):
    env.drop_cache()
    before_text = env.out.read_text(encoding="utf-8")
    d = DATES[-2]
    r = env.raw[d]
    if how == "taiex_nan":
        r[bc.TAIEX][1] = float("nan")
    elif how == "taiex_inf":
        r[bc.TAIEX][1] = float("inf")
    elif how == "amt_nan":
        r[CODES[4]][0] = float("nan")
    elif how == "close_inf":
        r[CODES[4]][1] = float("inf")
    elif how == "spread_nan":
        r[CODES[4]][2] = float("nan")
    capsys.readouterr()
    assert env.build() == 0
    err = capsys.readouterr().err
    text = env.out.read_text(encoding="utf-8")
    after = _strict(text)                                # 沒有 NaN／Infinity
    assert text.replace(after["generated_at"], json.loads(before_text)["generated_at"]) == before_text
    assert f"::warning::{d} 重抓資料無法計算（" in err


def test_agg_finite():
    ok = {"market": {"amt": 1.0, "n": 3, "ret_ew": None, "taiex": 2.5}, "chains": {"a": {"amt": 0.0, "share": None}},
          "cov": {"dup": 0.5}}
    assert bc.agg_finite(ok)
    for path in (("market", "amt"), ("market", "taiex"), ("cov", "dup")):
        for bad in (float("nan"), float("inf"), float("-inf")):
            x = copy.deepcopy(ok)
            x[path[0]][path[1]] = bad
            assert not bc.agg_finite(x)
    x = copy.deepcopy(ok)
    x["chains"]["a"]["share"] = float("nan")
    assert not bc.agg_finite(x)


def test_real_series_untouched_when_refetch_raises_with_token(tmp_path, monkeypatch, capsys):
    if not REAL.exists():
        pytest.skip("無 data/chain_daily/series.json")
    cj = json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))
    src = json.loads(REAL.read_text(encoding="utf-8"))
    if cj.get("generated_at") != src.get("classify_at"):
        pytest.skip("classify 已換版")
    out = tmp_path / "series.json"
    shutil.copy(REAL, out)
    monkeypatch.setattr(bc, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(bc, "SLEEP", 0)

    def fetch(ds):
        raise RuntimeError(f"403 for url: https://api/x?token={FAKE}")
    monkeypatch.setattr(bc, "fetch_day", fetch)
    capsys.readouterr()
    assert bc.build(bc.START_DEFAULT, src["dates"][-1], out, False, False) == 0
    cap = capsys.readouterr()
    got = json.loads(out.read_text(encoding="utf-8"))
    assert out.read_text(encoding="utf-8").replace(got["generated_at"], src["generated_at"]) == \
        REAL.read_text(encoding="utf-8")
    assert FAKE not in cap.out + cap.err and cap.err.count("重抓失敗（RuntimeError）") == 3
