# tests/test_measure_live_swr.py — tools/measure_live_swr.py 的離線測試（免網路、免 secret）
#
# 驗彙總規則（CLAUDE.md「已知限制／坑」第 6 條）：節流輪與全 0 輪丟棄、比例算法、分母 0 回 None、
# runner x-swr 分布與 isolate 計數分開列；另以假 get 跑一次 run() 端到端（含盤外只量一輪）。
# 可 `python tests/test_measure_live_swr.py` 直跑，也可 `python -m pytest tests/test_measure_live_swr.py -q`。
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import measure_live_swr as m  # noqa: E402

FAILED = []


def check(label, cond):
    ok = bool(cond)
    print(f"{'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        FAILED.append(label)
    assert ok, label


def _swr(**kw):
    base = {k: 0 for k in m.SWR_KEYS}
    base.update(kw)
    return json.dumps({"ts_current": "x", "swr": {**base, "inflight": False, "note": "n"}})


def test_ratio():
    check("ratio 正常", m.ratio(1, 4) == 0.25)
    check("ratio 分母 0 → None", m.ratio(0, 0) is None and m.ratio(3, 0) is None)
    check("ratio 非數字 → None", m.ratio(None, 3) is None)


def test_classify_diag():
    check("無 swr 欄位 → throttled",
          m.classify_diag(200, json.dumps({"error": "診斷路徑節流中", "reason": "too_frequent"}))["kind"] == "throttled")
    check("swr 全 0 → zero", m.classify_diag(200, _swr())["kind"] == "zero")
    check("swr 非零 → ok", m.classify_diag(200, _swr(freshHits=2))["kind"] == "ok")
    check("HTTP 500 → error", m.classify_diag(500, _swr(freshHits=2))["kind"] == "error")
    check("非 JSON → error", m.classify_diag(200, b"<html>")["kind"] == "error")
    check("JSON 陣列 → error", m.classify_diag(200, "[1]")["kind"] == "error")
    check("error 分支但帶 swr 仍算數", m.classify_diag(200, json.dumps(
        {"error": "boom", "swr": {"staleHits": 1}}))["kind"] == "ok")
    check("bool 計數不當數字", m.classify_diag(200, json.dumps({"swr": {"staleHits": True}}))["kind"] == "zero")


def _round(diag_body, xs=("fresh",), status=200):
    return {"live": [{"status": 200, "x_swr": x, "x_gen": "1", "ms": 10.0} for x in xs],
            "diag": m.classify_diag(status, diag_body)}


def test_summarize_discards_and_ratios():
    rounds = [
        _round(json.dumps({"error": "診斷路徑節流中"}), xs=("stale", "fresh")),          # 節流 → 丟棄
        _round(_swr(), xs=("miss",)),                                                   # 全 0 → 丟棄
        _round(_swr(staleHits=3, freshHits=1, rebuilds=4, coalesced=1), xs=("fresh", "stale")),
        _round(_swr(staleHits=1, freshHits=1, rebuilds=0, coalesced=0), xs=("fresh",)),  # 合併率分母 0
        _round(_swr(freshHits=5), status=503),                                         # HTTP 錯 → 丟棄
    ]
    s = m.summarize(rounds)
    check("總輪數 5", s["rounds_total"] == 5)
    check("採計 2 輪", s["rounds_kept"] == 2)
    check("丟棄計數", s["rounds_discarded"] == {"zero": 1, "throttled": 1, "error": 1})
    pr = s["isolate"]["per_round"]
    check("採計的是第 3、4 輪", [k["round"] for k in pr] == [3, 4])
    check("第 3 輪 stale 佔比 0.75", pr[0]["stale_share"] == 0.75)
    check("第 3 輪合併率 0.25", pr[0]["coalesce_rate"] == 0.25)
    check("第 4 輪合併率分母 0 → None", pr[1]["coalesce_rate"] is None)
    check("stale 佔比中位數 0.625", s["isolate"]["stale_share"]["median"] == 0.625)
    check("合併率統計跳過 None", s["isolate"]["coalesce_rate"]["n"] == 1
          and s["isolate"]["coalesce_rate"]["median"] == 0.25)
    rx = s["runner_x_swr"]
    check("runner x-swr 含被丟棄輪的 /live（與 isolate 分開）",
          (rx["fresh"], rx["stale"], rx["miss"]) == (4, 2, 1))
    check("runner stale/(stale+fresh)", rx["stale_share_of_hits"] == round(2 / 6, 4))


def test_summarize_all_discarded():
    s = m.summarize([_round(_swr()), _round(json.dumps({"reason": "daily_cap"}))])
    check("全丟棄 → 採計 0", s["rounds_kept"] == 0)
    check("全丟棄 → 中位數 None", s["isolate"]["stale_share"]["median"] is None)
    txt = m.render_text(s, {"base": "b", "started_tpe": "t", "in_window": True, "representative": True})
    check("摘要含選擇偏誤警語", "選擇偏誤" in txt)
    check("全丟棄明說不是比例＝0", "不是比例＝0" in txt)


def test_live_errors_counted():
    r = {"live": [{"status": None, "x_swr": None, "ms": 1.0}, {"status": 500, "x_swr": "miss", "ms": 1.0}],
         "diag": {"kind": "error"}}
    rx = m.summarize([r])["runner_x_swr"]
    check("/live 失敗計入 error、不計入 miss", rx["error"] == 2 and rx["miss"] == 0 and rx["n_ok"] == 0)
    check("分母 0 → None", rx["stale_share_of_hits"] is None)


def test_window():
    check("週三 10:00 窗內", m.in_market_window(datetime(2026, 9, 30, 10, 0, tzinfo=m.TPE)))
    check("週三 13:30 窗外", not m.in_market_window(datetime(2026, 9, 30, 13, 30, tzinfo=m.TPE)))
    check("週三 08:59 窗外", not m.in_market_window(datetime(2026, 9, 30, 8, 59, tzinfo=m.TPE)))
    check("週六 10:00 窗外", not m.in_market_window(datetime(2026, 10, 3, 10, 0, tzinfo=m.TPE)))


def _fake_get(calls):
    def get(url):
        calls.append(url)
        if url.endswith("/livediag"):
            return 200, {}, _swr(staleHits=2, freshHits=2, rebuilds=2, coalesced=1).encode(), 5.0
        return 200, {"x-swr": "stale", "x-gen": "123"}, b"{}", 5.0
    return get


def test_run_end_to_end():
    calls, sleeps, logs = [], [], []
    args = m.build_parser().parse_args(["--rounds", "3", "--interval-sec", "60", "--live-per-round", "5"])
    summary, meta, _ = m.run(args, get=_fake_get(calls), sleep=sleeps.append,
                             now=lambda: datetime(2026, 9, 30, 10, 0, tzinfo=m.TPE), log=logs.append)
    check("窗內跑滿 3 輪", meta["rounds_run"] == 3 and meta["representative"])
    check("每輪 5 次 /live＋1 次 /livediag", len(calls) == 18 and sum(c.endswith("/livediag") for c in calls) == 3)
    check("輪間 sleep interval", sleeps.count(60) == 2)
    check("彙總 stale 佔比 0.5", summary["isolate"]["stale_share"]["median"] == 0.5)

    calls2, logs2 = [], []
    summary2, meta2, _ = m.run(args, get=_fake_get(calls2), sleep=lambda s: None,
                               now=lambda: datetime(2026, 10, 3, 10, 0, tzinfo=m.TPE), log=logs2.append)
    check("盤外未帶 --force 只量一輪", meta2["rounds_run"] == 1 and not meta2["representative"])
    check("盤外印 warning", any(x.startswith("::warning::") for x in logs2))

    args3 = m.build_parser().parse_args(["--rounds", "2", "--interval-sec", "60", "--force"])
    _, meta3, _ = m.run(args3, get=_fake_get([]), sleep=lambda s: None,
                        now=lambda: datetime(2026, 10, 3, 10, 0, tzinfo=m.TPE), log=lambda s: None)
    check("盤外 --force 照跑但仍標無代表性", meta3["rounds_run"] == 2 and not meta3["representative"])


def test_default_diag_only():
    calls = []
    args = m.build_parser().parse_args(["--rounds", "2", "--interval-sec", "60"])
    check("預設 --live-per-round 0", args.live_per_round == 0)
    summary, meta, _ = m.run(args, get=_fake_get(calls), sleep=lambda s: None,
                             now=lambda: datetime(2026, 9, 30, 10, 0, tzinfo=m.TPE), log=lambda s: None)
    check("預設只打 /livediag", len(calls) == 2 and all(c.endswith("/livediag") for c in calls))
    txt = m.render_text(summary, meta)
    check("摘要含機房偏差警語", m.GEO_WARNING in txt)
    check("未打 /live 時不印自我污染警語", m.SELF_POLLUTION_WARNING not in txt and "未打 /live" in txt)
    txt5 = m.render_text(summary, {**meta, "live_per_round": 5})
    check("有打 /live 時印自我污染警語", m.SELF_POLLUTION_WARNING in txt5)


def test_main_exit_codes():
    import contextlib, io
    kw = dict(sleep=lambda s: None, now=lambda: datetime(2026, 9, 30, 10, 0, tzinfo=m.TPE), log=lambda s: None)
    with contextlib.redirect_stdout(io.StringIO()):
        rc0 = m.main(["--rounds", "2", "--interval-sec", "60"], get=_fake_get([]), **kw)

        def bad_live(url):
            if url.endswith("/livediag"):
                return 200, {}, _swr(staleHits=1, freshHits=1).encode(), 1.0
            return None, {"_error": "x"}, b"", 1.0
        rc1 = m.main(["--rounds", "1", "--interval-sec", "60", "--live-per-round", "2"], get=bad_live, **kw)
        rc2 = m.main(["--rounds", "1", "--interval-sec", "60"], get=bad_live, **kw)
    check("預設（不打 /live）main 回 0", rc0 == 0)
    check("有打 /live 且全失敗 main 回 1", rc1 == 1)
    check("不打 /live 時不因 /live 全失敗回 1", rc2 == 0)


def test_validate():
    p = m.build_parser()
    check("預設參數合法", m.validate(p.parse_args([])) is None)
    check("interval < 30 拒絕", m.validate(p.parse_args(["--interval-sec", "10"])) is not None)
    check("rounds 0 拒絕", m.validate(p.parse_args(["--rounds", "0"])) is not None)
    check("超過 55 分拒絕", m.validate(p.parse_args(["--rounds", "14", "--interval-sec", "600"])) is not None)
    check("非 https base 拒絕", m.validate(p.parse_args(["--base", "http://x"])) is not None)
    check("rounds 14 × interval 240 含 /livediag 逾時被拒",
          m.validate(p.parse_args(["--rounds", "14", "--interval-sec", "240"])) is not None)
    check("rounds 13 × interval 240 合法", m.validate(p.parse_args(["--rounds", "13", "--interval-sec", "240"])) is None)
    check("live-per-round 0 合法", m.validate(p.parse_args(["--live-per-round", "0"])) is None)
    check("live-per-round -1 拒絕", m.validate(p.parse_args(["--live-per-round", "-1"])) is not None)


if __name__ == "__main__":
    for fn in [test_ratio, test_classify_diag, test_summarize_discards_and_ratios, test_summarize_all_discarded,
               test_live_errors_counted, test_window, test_run_end_to_end, test_default_diag_only, test_main_exit_codes, test_validate]:
        try:
            fn()
        except AssertionError:
            pass
    if FAILED:
        print(f"\nFAIL {len(FAILED)}：" + "、".join(FAILED))
        sys.exit(1)
    print("\nALL PASS")
