# backtest/test_alpha_sweep_smoke.py — run_alpha_sweep.py 的離線煙霧/回歸測試
#
# 為什麼需要這支：run_alpha_sweep.py 要有 backtest/cache/ 的真實快取才跑得動，
# 但快取不進 git，改壞了不會有任何東西擋。這支用合成市場＋合成樣本直接呼叫各函式，
# 驗「14 個訊號都產得出結果、切半/分層/K/日層級算對、樣本不足不崩、報告三層全列」
# ——**不驗數字的財務意義**（那要真實快取）。
#
# 指標數值本身的正確性不在這裡驗，由 backtest/test_alpha_parity.mjs（JS↔Python 零差異）守。
#
# 用法：python backtest/test_alpha_sweep_smoke.py（免 token、免網路、免快取）

from __future__ import annotations

import random
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_alpha_sweep as a   # noqa: E402
import run_sorting as rs      # noqa: E402

FAILED = []


def check(label, cond):
    ok = bool(cond)
    print(f"{'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        FAILED.append(label)


# ── 合成資料 ────────────────────────────────────────────────────
def _days(n, start=date(2025, 6, 16)):
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def synthetic_market(ncodes=40, ndays=140, seed=7):
    """造 price/inst 快取結構（隨機走勢，會踩到 KD 交叉/MACD 翻正/RSI 極值/布林觸軌）。"""
    rnd = random.Random(seed)
    days = _days(ndays)
    codes = [f"{1101 + i * 7}" for i in range(ncodes)]
    px = {c: 50 + rnd.random() * 500 for c in codes}
    tx = 20000.0
    price, inst = {}, {}
    for t, d in enumerate(days):
        tx *= 1 + (rnd.random() - 0.5) * 0.02
        row = {"_TAIEX": [9e12, tx, tx * 1.01, tx * 0.99, round(tx, 2)]}
        iv = {}
        for c in codes:
            px[c] = max(5.0, px[c] * (1 + (rnd.random() - 0.5) * 0.09))
            cl = round(px[c], 2)
            hi = round(cl * (1 + rnd.random() * 0.03), 2)
            lo = round(cl * (1 - rnd.random() * 0.03), 2)
            amt = 2e8 * (0.6 + rnd.random() * 6)          # 全部過 LIQ=1 億
            row[c] = [amt, cl, hi, lo, cl]
            iv[c] = [int((rnd.random() - 0.5) * 4e6), int((rnd.random() - 0.5) * 8e6)]
        price[d] = row
        inst[d] = iv
    return days, price, inst


def mk(n, days, *, e3, e1=0.0, first_ratio=0.5, seed=3):
    """造 n 筆合成樣本；欄位須與 build_stock_samples 的 27 個 key 一致。

    前 first_ratio 比例落在交易日前半段，其餘落在後半段（供切半測試）。
    """
    rnd = random.Random(seed)
    cut = a.split_index(days)
    rows = []
    for i in range(n):
        first = i < int(n * first_ratio)
        d = days[i % max(1, cut)] if first else days[cut + i % max(1, len(days) - cut)]
        val = e3(i) if callable(e3) else e3
        rows.append(dict(
            d=d, c=f"{1000 + i % 97}",
            surge=1.0, ret=0.0, pos=0.5, amt=3e8,
            r1=val, r2=val, r3=val, e1=e1, e2=val, e3=val,
            lim=False, limd=False, it3=0, fi3=0, ints=0.0,
            ma=True, bias=0.0, brk=False, brkd=False,
            volt=1.0, regime="bull", break_depth=None,
            trust_buy_amt=rnd.uniform(-500, 500), foreign_buy_amt=rnd.uniform(-500, 500),
            consec_exit=0,
        ))
    return rows


# 量能事件日一覽（`volume_market` 的植入點；彼此間隔 ≥21 個交易日，
# 讓每一天的 20 日窗只看得到平靜日，互不污染）。
VOL_D40, VOL_D50 = 40, 50          # 既有兩個事件
VOL_D_RATIO_DN = 72                # 量比過門檻但價跌
VOL_D_RATIO_UP = 94                # 量比過門檻且價漲（72 的正對照）
VOL_D_WINDOW = 116                 # AS-15「含不含當日」會翻轉的臨界量
VOL_EVENT_DAYS = (VOL_D40, *range(46, 51), VOL_D_RATIO_DN, VOL_D_RATIO_UP, VOL_D_WINDOW)


def volume_market(ndays=125, code="2330", base_v=1_000_000):
    """量能訊號用的**受控**市場：事件日寫死，不靠隨機碰運氣。

    day 40      量 5×base、收盤 −5%   → AS-15 觸發；AS-16 量比僅 1.5，量能門檻就擋掉
    day 46~50   量 5×base、收盤走高    → day50 量比 ≈2.27 → AS-16 觸發
    day 72      量 12×base、收盤 −1%  → 量比 ≈2.07（**過**量能門檻）但價跌
                                         → AS-16 只能靠價格條件擋住（**判別日**）
                                         → AS-15 量也過門檻，只能靠 −3% 跌幅條件擋住
    day 94      量 12×base、收盤 +1%  → 量比同 day72 但價漲 → AS-16 觸發（day72 的正對照，
                                         證明 day72 不觸發是價格條件擋的、不是量不夠）
    day 116     量 2.05×base、收盤 −5% → AS-15 窗定義**判別日**：
                                         不含當日均量＝base，門檻 2×base → 2.05 過 → 觸發；
                                         若改成含當日，均量＝(19+2.05)/20＝1.0525×base，
                                         門檻 2.105×base → 2.05 不過 → 不觸發
    其餘日      量 base、收盤微幅走高   → 兩者皆不觸發

    ⚠ 為什麼需要 day72／94／116（2026-08-30 覆驗必修）：突變測試證明只有 day40/50 時，
    「拿掉 AS-16 的價漲條件」與「把 AS-15 的 20 日窗改成含當日」兩種突變都**測不到**——
    day40 的量比只有 1.5，量能門檻就先擋掉，那條負向斷言是因為錯的理由而通過。
    """
    days = _days(ndays)
    price, inst = {}, {}
    cl = 100.0
    for t, d in enumerate(days):
        if t == VOL_D40:
            cl = round(cl * 0.95, 2)          # −5% → d1 = −5.0 ≤ −3
            v = base_v * 5
        elif 46 <= t <= VOL_D50:
            cl = round(cl * 1.01, 2)
            v = base_v * 5
        elif t == VOL_D_RATIO_DN:
            cl = round(cl * 0.99, 2)          # −1% → 過不了 AS-15 的 −3%
            v = base_v * 12                   # 單日 12× → SMA5/SMA20 ≈ 2.07 ≥ 2
        elif t == VOL_D_RATIO_UP:
            cl = round(cl * 1.01, 2)
            v = base_v * 12
        elif t == VOL_D_WINDOW:
            cl = round(cl * 0.95, 2)          # −5% ≤ −3，AS-15 的價格條件過
            v = int(base_v * 2.05)            # 落在「不含當日過、含當日不過」的窄帶
        else:
            cl = round(cl * 1.001, 2)
            v = base_v
        tx = 20000.0 + t
        price[d] = {
            "_TAIEX": [9e12, tx, tx * 1.01, tx * 0.99, round(tx, 2), 0],
            code: [3e8, cl, round(cl * 1.02, 2), round(cl * 0.98, 2), cl, v],
        }
        inst[d] = {}
    return days, price, inst


def strip_volume(price):
    """把受控市場降級成舊格式快取（每列砍成 5 欄）。"""
    return {d: {c: row[:5] for c, row in rows.items()} for d, rows in price.items()}


def mix_volume(price, keep_first=30):
    """混合快取：前 keep_first 天保留 volume，其餘退回舊格式 5 欄。

    重現「只刪掉部分 price_*.json.gz 重跑 fetch.py」——fetch.py 的續傳是逐檔跳過
    （`if pf.exists() and inf.exists(): continue`），所以這種半有半無的快取真的做得出來。
    """
    return {d: (rows if i < keep_first else {c: r[:5] for c, r in rows.items()})
            for i, (d, rows) in enumerate(price.items())}


def _vol_series(days, price):
    """取受控市場那一檔的成交量序列（跳過 _TAIEX）。"""
    code = next(c for c in price[days[0]] if c != "_TAIEX")
    return [price[d][code][a.VOL_IDX] for d in days]


# ── 0. 第二階段（量能）候選 ─────────────────────────────────────
def test_phase2_list_separate_from_phase1():
    ids1 = {s["id"] for s in a.SIGNALS}
    ids2 = {s["id"] for s in a.SIGNALS_P2}
    check("第二階段 2 列", len(a.SIGNALS_P2) == 2)
    check("第二階段編號 AS-15/16", ids2 == {"AS-15", "AS-16"})
    check("兩階段清單不重疊", not (ids1 & ids2))
    check("第一階段仍是 14 列 K=16（§2.5 凍結）", len(a.SIGNALS) == 14 and a.K_TESTS == 16)
    check("第二階段自己的 K=3（AS-16 雙邊計 2）", a.K_TESTS_P2 == 3)
    check("AS-15 方向＝做空（postmkt DIAG_RULES P2 col:red）",
          next(s for s in a.SIGNALS_P2 if s["id"] == "AS-15")["dir"] == "short")
    check("AS-16 方向＝雙邊（來源未宣稱方向，不臆測）",
          next(s for s in a.SIGNALS_P2 if s["id"] == "AS-16")["dir"] == "both")


def test_volume_gate_blocks_old_cache():
    days, price, inst = volume_market()
    old = strip_volume(price)
    check("舊格式快取判為無 volume", a.cache_has_volume(days, old) is False)
    check("新格式快取判為有 volume", a.cache_has_volume(days, price) is True)
    samples, _, _ = rs.build_stock_samples(days, old, inst)
    a.attach_all(samples, days, old)
    diag = {}
    fired = a.attach_volume_signals(samples, days, old, diag)
    check("舊快取時 attach_volume_signals 回 False", fired is False)
    check("舊快取時完全不掛量能旗標",
          not any(("AS-15" in r["sig"]) or ("AS-16" in r["sig"]) for r in samples))
    check("舊快取時診斷仍列出兩個訊號（候選 0）",
          diag.get("AS-15", {}).get("cand") == 0 and diag.get("AS-16", {}).get("cand") == 0)


def test_volume_gate_blocks_mixed_cache():
    """混合快取必須被擋下（2026-08-30 覆驗必修）。

    舊判準是「任一列有 volume 即 True」，混合快取下閘門放行、attach 回 True、
    報告照印 N 與分層，但缺欄那幾天的事件整批靜默漏掉——實測植入的 AS-15/16
    全部沒觸發而報告零提示。改嚴為「所有非空日皆帶 volume」。
    """
    days, price, inst = volume_market()
    mixed = mix_volume(price, keep_first=30)
    have, nonempty = a.volume_days(days, mixed)
    check(f"混合快取確實是半有半無（{len(have)}/{len(nonempty)} 日帶 volume）",
          0 < len(have) < len(nonempty))
    check("混合快取判為不完整（舊判準會回 True）",
          a.cache_has_volume(days, mixed) is False)

    samples, _, _ = rs.build_stock_samples(days, mixed, inst)
    a.attach_all(samples, days, mixed)
    diag = {}
    check("混合快取時 attach_volume_signals 回 False（整批不跑，不半盲）",
          a.attach_volume_signals(samples, days, mixed, diag) is False)
    check("混合快取時完全不掛量能旗標",
          not any(("AS-15" in r["sig"]) or ("AS-16" in r["sig"]) for r in samples))

    # 完整／全空兩端仍要判對，否則「改嚴」可能是把閘門寫死成 False
    check("完整快取仍判為完整", a.cache_has_volume(days, price) is True)
    full_have, full_nonempty = a.volume_days(days, price)
    check("完整快取涵蓋 = 全部非空日", len(full_have) == len(full_nonempty) > 0)
    check("全舊格式快取涵蓋 0 日", a.volume_days(days, strip_volume(price))[0] == [])

    # 揭露行：報告要看得出實際涵蓋範圍（比照 KNOWN_BIASES 的揭露文化）
    cov = a._vol_cov_line((have, nonempty))
    check("揭露行印出涵蓋日數", f"{len(have)}/{len(nonempty)}" in cov)
    check("揭露行印出涵蓋起訖日", have[0] in cov and have[-1] in cov)


def test_volume_signals_fire_on_planted_events():
    days, price, inst = volume_market()
    samples, _, _ = rs.build_stock_samples(days, price, inst)
    a.attach_all(samples, days, price)
    diag = {}
    check("新快取時 attach_volume_signals 回 True",
          a.attach_volume_signals(samples, days, price, diag) is True)
    by_d = {r["d"]: r for r in samples}
    idx = {d: i for i, d in enumerate(days)}
    for i in VOL_EVENT_DAYS:
        if days[i] not in by_d:
            check(f"day{i} 有樣本（否則其斷言全部落空）", False)
    d40, d50 = days[40], days[50]
    check("day40 觸發 AS-15（爆量長黑）", d40 in by_d and "AS-15" in by_d[d40]["sig"])
    check("day40 不觸發 AS-16（量比僅 1.5，量能門檻就擋掉）",
          d40 in by_d and "AS-16" not in by_d[d40]["sig"])
    check("day50 觸發 AS-16（量能爆量）", d50 in by_d and "AS-16" in by_d[d50]["sig"])
    check("day50 不觸發 AS-15（價漲）", d50 in by_d and "AS-15" not in by_d[d50]["sig"])

    # ── AS-16 的價格條件（判別日 day72 / 正對照 day94）────────────────
    # 突變測試：拿掉 attach_volume_signals 裡 AS-16 的 `and C[i] > pc`，
    # 只有 day40/50 時全部測試照樣通過（day40 量比 1.5，是量能門檻擋掉的，
    # 那條負向斷言因為錯的理由而通過）。day72 的量比 ≥2，價格條件是唯一能擋的。
    V = _vol_series(days, price)

    def vratio(i):
        w20 = V[i - 19:i + 1]
        return (sum(w20[-5:]) / 5) / (sum(w20) / 20)

    r_dn, r_up = vratio(VOL_D_RATIO_DN), vratio(VOL_D_RATIO_UP)
    check(f"day{VOL_D_RATIO_DN} 的量比確實 ≥2（{r_dn:.3f}）"
          "——否則下面的『不觸發』又是量能門檻擋的，測不到價格條件", r_dn >= 2)
    check(f"day{VOL_D_RATIO_UP} 的量比確實 ≥2（{r_up:.3f}）", r_up >= 2)
    dn, up = by_d[days[VOL_D_RATIO_DN]], by_d[days[VOL_D_RATIO_UP]]
    check(f"day{VOL_D_RATIO_DN}（量比 ≥2 但價跌）不觸發 AS-16"
          "——AS-16 的價漲條件唯一擋得住的日子", "AS-16" not in dn["sig"])
    check(f"day{VOL_D_RATIO_UP}（量比 ≥2 且價漲）觸發 AS-16"
          "——正對照，證明上一條不是量不夠", "AS-16" in up["sig"])
    # 同兩天也把 AS-15 的價格條件夾住：量都遠過門檻，只剩 −3% 跌幅條件能擋
    check(f"day{VOL_D_RATIO_DN}（量過門檻但只跌 1%）不觸發 AS-15", "AS-15" not in dn["sig"])
    check(f"day{VOL_D_RATIO_UP}（量過門檻但價漲）不觸發 AS-15", "AS-15" not in up["sig"])

    # ── AS-15 的窗定義：前 20 日**不含當日**（判別日 day116）──────────
    # 突變測試：把 `V[max(0, i - 20):i]` 改成含當日的 `V[max(0, i - 19):i + 1]`，
    # 只有 day40 時測不到（5× 量在兩種窗下都過門檻）。day116 的量刻意落在
    # 「不含當日過、含當日不過」的窄帶（2m < v ≤ 2.111m）。
    w_ex = V[VOL_D_WINDOW - 20:VOL_D_WINDOW]
    w_in = V[VOL_D_WINDOW - 19:VOL_D_WINDOW + 1]
    ex_ok = V[VOL_D_WINDOW] > 2 * (sum(w_ex) / len(w_ex))
    in_ok = V[VOL_D_WINDOW] > 2 * (sum(w_in) / len(w_in))
    check(f"day{VOL_D_WINDOW} 落在窄帶：不含當日過門檻({ex_ok})、含當日不過({in_ok})"
          "——這是本條能區分窗定義的前提", ex_ok and not in_ok)
    win = by_d[days[VOL_D_WINDOW]]
    check(f"day{VOL_D_WINDOW} 觸發 AS-15（窗＝前 20 日不含當日）", "AS-15" in win["sig"])
    check(f"day{VOL_D_WINDOW} 不觸發 AS-16（量比 {vratio(VOL_D_WINDOW):.3f} < 2）",
          "AS-16" not in win["sig"])

    # 平靜日＝20 日窗（含當日）內完全沒有事件日：兩個訊號的窗都只看得到 base 量，
    # 定義上不可能觸發。**不能只排除事件日本身**——尖峰後 4 天 SMA5 仍含該尖峰，
    # AS-16 會延續觸發，那是定義內行為不是誤觸。
    quiet = [r for r in samples
             if not any(e in range(idx[r["d"]] - 19, idx[r["d"]] + 1) for e in VOL_EVENT_DAYS)]
    check(f"平靜日樣本數 > 0（實際 {len(quiet)}）", len(quiet) > 0)
    check("平靜日不觸發任何量能訊號（20 日窗內無事件）",
          all("AS-15" not in r["sig"] and "AS-16" not in r["sig"] for r in quiet))
    check("診斷回報候選數 > 0", diag["AS-15"]["cand"] >= 1 and diag["AS-16"]["cand"] >= 1)


def test_phase2_report_section():
    days = _days(120)
    _, price, inst = synthetic_market(ncodes=12, ndays=120, seed=9)
    samples, _, _ = rs.build_stock_samples(days[:120], price, inst)
    results = _fake_results(days)

    skipped = "\n".join(a.build_report(days, samples, results, {}, "deadbeef", False))
    check("未跑時報告明說第二階段沒跑", "第二階段：量能訊號（**本次未跑**）" in skipped)
    check("未跑時報告給解鎖方式", "重跑 `backtest/fetch.py`" in skipped)
    check("未跑時第一階段分層數不受影響", skipped.count("**分層**") == 14)

    rp2 = {s["id"]: a.evaluate_signal(mk(600, days, e3=0.02), days) for s in a.SIGNALS_P2}
    ran = "\n".join(a.build_report(days, samples, results, {}, "deadbeef", False, rp2))
    for sig in a.SIGNALS_P2:
        check(f"報告含 {sig['id']} 段", f"## {sig['id']}" in ran)
        check(f"報告含 {sig['id']} 定義原文", sig["desc"] in ran)
        check(f"{sig['id']} 出現在第二階段總表", f"| {sig['id']} |" in ran)
    check("第二階段 K 分開揭露且不與第一階段合併",
          "另外檢定 3 個訊號" in ran and "不合併" in ran)
    check("第一階段 K 仍是 16", "共檢定 16 個訊號" in ran)
    check("AS-16 雙邊理由寫進報告", "方向不明者明列雙邊並計 2 次" in ran)
    # 預註冊書 §6.2 的誠實標註要同步出現在報告裡，否則讀者會以為 short 是原訂方向
    check("AS-15 方向來源誠實標註寫進報告",
          "非預註冊書原訂" in ran and "DIAG_RULES" in ran)
    check("兩階段分層合計 16 段", ran.count("**分層**") == 16)


# ── 1. 候選清單與 K ─────────────────────────────────────────────
def test_candidate_list_frozen():
    ids = [s["id"] for s in a.SIGNALS]
    check(f"候選 14 列（實際 {len(a.SIGNALS)}）", len(a.SIGNALS) == 14)
    check("編號為 AS-01~AS-14 且不重複",
          ids == [f"AS-{i:02d}" for i in range(1, 15)])
    both = [s["id"] for s in a.SIGNALS if s["dir"] == "both"]
    check(f"雙邊檢定恰為 AS-03/AS-04（實際 {both}）", both == ["AS-03", "AS-04"])
    check("雙邊各計 2 次", all(s["weight"] == 2 for s in a.SIGNALS if s["dir"] == "both"))
    check("單邊各計 1 次", all(s["weight"] == 1 for s in a.SIGNALS if s["dir"] != "both"))
    check(f"K = 16（實際 {a.K_TESTS}）", a.K_TESTS == 16)
    check("K 由清單自動帶入（非硬編）",
          a.K_TESTS == sum(s["weight"] for s in a.SIGNALS))


def test_thresholds_match_preregistration():
    check("全期 N 門檻 500", a.MIN_N_FULL == 500)
    check("半段 N 門檻 200", a.MIN_N_HALF == 200)
    check("效果量門檻 0.50%", a.MIN_ABS_E3 == 0.50)
    check("AS-01~04 取當日前 30 名", a.TOP_N == 30)
    check("AS-05/06 取當日前後 10%", a.DECILE == 0.10)


def test_sample_keys_match_builder():
    """合成樣本欄位必須與真實 builder 一致，否則這支測試在驗假的東西。"""
    import inspect
    src = inspect.getsource(rs.build_stock_samples)
    synth = set(mk(1, _days(30), e3=0.0)[0])
    missing = [k for k in synth if f"{k}=" not in src]
    check(f"合成樣本欄位都存在於 build_stock_samples（缺 {missing}）", not missing)


# ── 2. 14 個訊號都產得出結果 ────────────────────────────────────
def test_all_14_signals_fire():
    days, price, inst = synthetic_market()
    samples, _, _ = rs.build_stock_samples(days, price, inst)
    check(f"合成市場有樣本（{len(samples)}）", len(samples) > 0)
    diag = a.attach_all(samples, days, price)
    fired = {}
    for sig in a.SIGNALS:
        rows = [r for r in samples if sig["id"] in r["sig"]]
        res = a.evaluate_signal(rows, days)
        fired[sig["id"]] = res["n"]
        check(f"{sig['id']} 產得出結果且 N>0（N={res['n']}）",
              isinstance(res, dict) and res["n"] > 0)
        check(f"{sig['id']} 有分層", a.classify_tier(res) in ("A", "B", "C"))
    check(f"排序欄診斷涵蓋 14 訊號（{len(diag)}）", len(diag) == 14)
    print(f"      觸發數：{fired}")

    # 名額上限：AS-01~04 每日至多 TOP_N 筆
    for sid in ("AS-01", "AS-02", "AS-03", "AS-04"):
        by_day = {}
        for r in samples:
            if sid in r["sig"]:
                by_day[r["d"]] = by_day.get(r["d"], 0) + 1
        worst = max(by_day.values()) if by_day else 0
        check(f"{sid} 單日不超過 {a.TOP_N} 名（實際最多 {worst}）", worst <= a.TOP_N)

    # AS-05/06 為互斥的頭尾十分位（同日同檔不可能同時是前 10% 與後 10%）
    both = [r for r in samples if "AS-05" in r["sig"] and "AS-06" in r["sig"]]
    check(f"AS-05 與 AS-06 不重疊（重疊 {len(both)} 筆）", not both)

    # 同步/對作四組互斥（同一 (股,日) 的法人符號組合只會落在一組）
    pairs = [("AS-01", "AS-02"), ("AS-01", "AS-03"), ("AS-03", "AS-04")]
    bad = [(x, y) for x, y in pairs
           if any(x in r["sig"] and y in r["sig"] for r in samples)]
    check(f"法人四組彼此互斥（重疊組 {bad}）", not bad)


def test_technical_signals_use_worker_semantics():
    """AS-07/08 必須帶 K<50 / K>50 條件，AS-13/14 走生產的 pb 判定。"""
    days, price, inst = synthetic_market(ncodes=25, ndays=120, seed=11)
    samples, _, _ = rs.build_stock_samples(days, price, inst)
    a.attach_all(samples, days, price)
    by_cd = {(r["c"], r["d"]): r for r in samples}
    bad_kd = bad_boll = 0
    for c in sorted({r["c"] for r in samples}):
        sd, H, L, C = [], [], [], []
        for d in days:
            row = price[d].get(c)
            if row:
                sd.append(d); H.append(row[2]); L.append(row[3]); C.append(row[4])
        kdp, bp = a.kd_path(H, L, C), a.boll_path(C)
        for i, d in enumerate(sd):
            r = by_cd.get((c, d))
            if not r:
                continue
            if kdp[i] and "AS-07" in r["sig"] and not kdp[i]["k"] < 50:
                bad_kd += 1
            if kdp[i] and "AS-08" in r["sig"] and not kdp[i]["k"] > 50:
                bad_kd += 1
            if bp[i] and "AS-13" in r["sig"] and not bp[i]["pb"] >= 1:
                bad_boll += 1
            if bp[i] and "AS-14" in r["sig"] and not bp[i]["pb"] <= 0:
                bad_boll += 1
    check(f"AS-07/08 皆滿足 K<50 / K>50（違反 {bad_kd}）", bad_kd == 0)
    check(f"AS-13/14 皆滿足 pb≥1 / pb≤0（違反 {bad_boll}）", bad_boll == 0)


# ── 3. 切半邏輯 ─────────────────────────────────────────────────
def test_split_half():
    days = _days(101)
    check("切點＝交易日數整除 2（奇數天）", a.split_index(days) == 50)
    check("切點＝交易日數整除 2（偶數天）", a.split_index(_days(100)) == 50)

    same = a.evaluate_signal(mk(600, days, e3=0.02), days)
    check(f"前後段各半（{same['h1']['n']}/{same['h2']['n']}）",
          same["h1"]["n"] == 300 and same["h2"]["n"] == 300)
    check("同號 → 切半同號為真", same["c_half_sign"])
    check("兩段各 N≥200 → 半段 N 判準過", same["c_half_n"])
    check("同號且 N 足 → 存活", same["survive_half"])

    cut = a.split_index(days)
    flip = mk(600, days, e3=lambda i: 0.02 if i < 300 else -0.02)
    resf = a.evaluate_signal(flip, days)
    check(f"前後段異號 → 切半同號為假（{resf['h1']['e3_avg']:+.2f}/"
          f"{resf['h2']['e3_avg']:+.2f}）", not resf["c_half_sign"])
    check("異號 → 不存活", not resf["survive_half"])

    thin = a.evaluate_signal(mk(300, days, e3=0.02), days)
    check(f"半段 N=150 <200 → 半段 N 判準不過（{thin['h1']['n']}）",
          not thin["c_half_n"] and thin["c_half_sign"])
    check("半段同號但 N 不足 → 不存活", not thin["survive_half"])

    # 切半必須依索引、不看日期字串內容
    rows = mk(400, days, e3=0.01)
    r_all = a.evaluate_signal(rows, days)
    check(f"切點日期由 days 帶出（{r_all['cut_day']} | {r_all['next_day']}）",
          r_all["cut_day"] == days[cut - 1] and r_all["next_day"] == days[cut])


# ── 4. 日層級序列 ───────────────────────────────────────────────
def test_daily_series():
    rows = [dict(d="2026-01-05", e3=0.02), dict(d="2026-01-05", e3=0.04),
            dict(d="2026-01-06", e3=-0.03),
            dict(d="2026-01-07", e3=0.01), dict(d="2026-01-07", e3=0.05)]
    ser = a.daily_series(rows)
    check(f"逐日序列長度＝訊號日數（{len(ser)}）", len(ser) == 3)
    check("日期升冪", [d for d, _ in ser] == ["2026-01-05", "2026-01-06", "2026-01-07"])
    check(f"當日先取平均（{ser[0][1]:.4f}）", abs(ser[0][1] - 0.03) < 1e-12)
    check("負值日照算", abs(ser[1][1] + 0.03) < 1e-12)

    days = _days(60)
    rows2 = ([dict(**r, e1=0.0, r1=0.0, r3=0.0, c="1") for r in
              [dict(d=days[0], e3=0.10), dict(d=days[1], e3=-0.01),
               dict(d=days[2], e3=-0.01), dict(d=days[3], e3=-0.01)]])
    res = a.evaluate_signal(rows2, days)
    check(f"日層級平均＝逐日平均的平均（{res['day_avg']:+.3f}%）",
          abs(res["day_avg"] - 1.75) < 1e-9)
    check(f"正報酬日佔比（{res['day_pos']:.1f}%）", abs(res["day_pos"] - 25.0) < 1e-9)
    check(f"pooled 平均同樣是 +1.75%（本例每日 1 筆）",
          abs(res["e3_avg"] - 1.75) < 1e-9)
    check("日層級與 pooled 同號 → 判準過", res["c_day_sign"])

    # 單日暴衝：pooled 被拉正，但逐日平均為負 → 第二層要擋得下來（§1.3 的用意）
    spike = ([dict(d=days[0], e3=1.0, e1=0.0, r1=0.0, r3=0.0, c="1")] * 50
             + [dict(d=days[i], e3=-0.03, e1=0.0, r1=0.0, r3=0.0, c="1")
                for i in range(1, 40)])
    rspike = a.evaluate_signal(spike, days)
    check(f"單日暴衝：pooled 正（{rspike['e3_avg']:+.2f}%）"
          f"但日層級負（{rspike['day_avg']:+.2f}%）",
          rspike["e3_avg"] > 0 and rspike["day_avg"] < 0)
    check("→ 日層級同號判準擋下", not rspike["c_day_sign"])


# ── 5. 三層分類 ─────────────────────────────────────────────────
def test_tier_classification():
    days = _days(120)
    a_res = a.evaluate_signal(mk(600, days, e3=0.02), days)
    check(f"A：全部門檻過（N={a_res['n']} e3={a_res['e3_avg']:+.2f}%）",
          a.classify_tier(a_res) == "A")

    # 前半 +3%、後半 −1% → pooled +1.0%（效果量過關）但切半不同號
    b_flip = a.evaluate_signal(mk(600, days, e3=lambda i: 0.03 if i < 300 else -0.01), days)
    check(f"B：效果量夠（{b_flip['e3_avg']:+.2f}%）但切半不同號",
          a.classify_tier(b_flip) == "B" and b_flip["c_eff"] and not b_flip["c_half_sign"])

    b_n = a.evaluate_signal(mk(400, days, e3=0.02), days)
    check("B：效果量夠但全期 N<500", a.classify_tier(b_n) == "B" and not b_n["c_n"])

    c_eff = a.evaluate_signal(mk(600, days, e3=0.001), days)
    check(f"C：未達效果量門檻（{c_eff['e3_avg']:+.2f}%）",
          a.classify_tier(c_eff) == "C")

    edge_lo = a.evaluate_signal(mk(600, days, e3=0.00499), days)
    edge_hi = a.evaluate_signal(mk(600, days, e3=0.005), days)
    check(f"門檻邊界：0.499% 未過（{edge_lo['e3_avg']:.3f}%）", not edge_lo["c_eff"])
    check(f"門檻邊界：0.500% 恰過（{edge_hi['e3_avg']:.3f}%）", edge_hi["c_eff"])

    # 做空訊號：e3 為負但絕對值夠 → 一樣可進 A（判準用 |e3|）
    short_res = a.evaluate_signal(mk(600, days, e3=-0.02), days)
    check("做空方向（e3 負）不因符號被判 C", a.classify_tier(short_res) == "A")
    short_sig = next(s for s in a.SIGNALS if s["dir"] == "short")
    long_sig = next(s for s in a.SIGNALS if s["dir"] == "long")
    both_sig = next(s for s in a.SIGNALS if s["dir"] == "both")
    check("方向標註：做空訊號 e3 負＝相符", a.dir_match(short_sig, short_res) is True)
    check("方向標註：做多訊號 e3 負＝相反", a.dir_match(long_sig, short_res) is False)
    check("方向標註：雙邊訊號不判方向", a.dir_match(both_sig, short_res) is None)


# ── 6. 樣本不足／邊界不崩 ───────────────────────────────────────
def test_no_crash_on_thin_data():
    days = _days(60)
    empty = a.evaluate_signal([], days)
    check("零樣本不崩，N=0", empty["n"] == 0)
    check("零樣本歸 C", a.classify_tier(empty) == "C")
    check("零樣本各判準皆 False",
          not (empty["c_n"] or empty["c_eff"] or empty["c_half_n"]
               or empty["c_half_sign"] or empty["c_day_sign"]))

    lines = []
    a.render_signal(a.SIGNALS[0], empty, {}, lines)
    check("零樣本的報告區塊印得出來", any("無樣本" in x for x in lines))

    one = a.evaluate_signal(mk(1, days, e3=0.02), days)
    check("單筆樣本不崩", one["n"] == 1 and one["day_n"] == 1)

    # 只有一段有樣本
    only_first = a.evaluate_signal(
        [dict(d=days[0], e3=0.02, e1=0.0, r1=0.0, r3=0.0, c="1")], days)
    check("只有前半段有樣本時 h2 為 None、不崩",
          only_first["h2"] is None and not only_first["c_half_sign"])

    # 極短快取：不足暖身期，attach_all 不得崩
    days2, price2, inst2 = synthetic_market(ncodes=12, ndays=30, seed=5)
    s2, _, _ = rs.build_stock_samples(days2, price2, inst2)
    diag2 = a.attach_all(s2, days2, price2)
    check(f"30 日快取仍跑得完（樣本 {len(s2)}）", isinstance(diag2, dict))
    check("30 日快取下 MACD 類訊號無誤觸發（暖身不足）",
          all("AS-09" not in r["sig"] and "AS-10" not in r["sig"] for r in s2))

    # 指標函式對過短序列一律回 None，不炸
    check("kd_path 短序列全 None", a.kd_path([1, 2], [1, 2], [1, 2]) == [None, None])
    check("macd_path 短序列全 None", set(a.macd_path([1.0] * 10)) == {None})
    check("rsi_path 短序列全 None", set(a.rsi_path([1.0] * 3, 5)) == {None})
    check("boll_path 短序列全 None", set(a.boll_path([1.0] * 5)) == {None})
    check("sma 不足回 None", a.sma([1, 2], 3) is None)


def test_jround_is_js_semantics():
    """JS Math.round 是 half-up 朝 +∞；Python 內建 round 是 banker's——不可混用。"""
    check("jround(0.5)=1", a.jround(0.5) == 1)
    check("jround(1.5)=2", a.jround(1.5) == 2)
    check("jround(2.5)=3（banker's 會給 2）", a.jround(2.5) == 3)
    check("jround(-0.5)=0（朝 +∞）", a.jround(-0.5) == 0)
    check("jround(-2.5)=-2", a.jround(-2.5) == -2)
    check("jround(0.49999999999999994)=0（不寫成 floor(x+0.5)）",
          a.jround(0.49999999999999994) == 0)
    check("r2 取兩位小數", a.r2(1.117) == 1.12 and a.r2(-1.117) == -1.12)
    check("r2(0.125)=0.13 / r2(-0.125)=-0.12（半數朝 +∞，非對稱）",
          a.r2(0.125) == 0.13 and a.r2(-0.125) == -0.12)


# ── 7. 報告：三層全列、14 項對得上、揭露段落齊全 ──────────────────
def _fake_results(days):
    res = {}
    for i, sig in enumerate(a.SIGNALS):
        if i % 3 == 0:
            rows = mk(600, days, e3=0.02, seed=i)                       # A
        elif i % 3 == 1:
            rows = mk(600, days, e3=lambda j: 0.02 if j < 300 else -0.02, seed=i)  # B
        else:
            rows = mk(600, days, e3=0.001, seed=i)                      # C
        r = a.evaluate_signal(rows, days)
        r["_rows"] = rows
        res[sig["id"]] = r
    return res


def test_report_structure():
    days = _days(120)
    _, price, inst = synthetic_market(ncodes=12, ndays=120, seed=9)
    samples, _, _ = rs.build_stock_samples(days[:120], price, inst)
    results = _fake_results(days)
    lines = a.build_report(days, samples, results, {}, "deadbeef 2026-07-27T16:57:01+00:00", False)
    txt = "\n".join(lines)

    for sig in a.SIGNALS:
        check(f"報告含 {sig['id']} 段", f"## {sig['id']}" in txt)
        check(f"報告含 {sig['id']} 的預註冊定義原文", sig["desc"] in txt)
    check("開頭印多重比較揭露（K=16、0.8 個）",
          "共檢定 16 個訊號" in txt and "約 0.8 個" in txt)
    check("開頭標明預註冊書 commit", "deadbeef" in txt)
    check("A 層標題", "## A. 存活" in txt)
    check("B 層標題", "## B. 半段活" in txt)
    check("C 層標題（必須完整列出）", "## C. 陰性" in txt)
    for sig in a.SIGNALS:
        check(f"{sig['id']} 出現在三層總表", f"| {sig['id']} |" in txt)
    check("印出全部已知偏差", all(b.split("：")[0][2:6] in txt for b in a.KNOWN_BIASES))
    # 4 項來自預註冊 §2.2，第 5 項是 AS-05/06 滾動基準的實作揭露（驗收 1cc5466 必修）
    check("已知偏差為 4+1 項", len(a.KNOWN_BIASES) == 5)
    check("第 5 項揭露滾動基準且警告不可外推",
          "滾動前 5 交易日" in a.KNOWN_BIASES[4] and "不可直接外推" in a.KNOWN_BIASES[4])
    check("AS-05/06 定義行標注基準口徑",
          all("滾動前5交易日" in s["desc"] for s in a.SIGNALS if s["id"] in ("AS-05", "AS-06")))
    check("印出對照組基準", "對照組" in txt)
    check("印出切半方式（依索引）", "依交易日索引對半切" in txt)
    check("印出 e1 只作描述用途", "不列入採用判準" in txt)
    check("印出不報 p 值的理由", "不報 p 值" in txt)
    check("印出判準門檻表", "≥ 500" in txt and "0.50%" in txt and "≥ 200" in txt)
    check("每個訊號都印分層", txt.count("**分層**") == 14)
    check("工作區乾淨時不印憑據警告", "未 commit 的修改" not in txt)

    dirty = "\n".join(a.build_report(days, samples, results, {}, "deadbeef", True))
    check("預註冊書有未 commit 修改時報告會警示", "未 commit 的修改" in dirty)


def main():
    for fn in [test_candidate_list_frozen, test_thresholds_match_preregistration,
               test_sample_keys_match_builder,
               test_all_14_signals_fire, test_technical_signals_use_worker_semantics,
               test_split_half, test_daily_series, test_tier_classification,
               test_no_crash_on_thin_data, test_jround_is_js_semantics,
               test_report_structure,
               # 第二階段（量能）：解鎖 AS-15/16 的守門
               test_phase2_list_separate_from_phase1, test_volume_gate_blocks_old_cache,
               test_volume_gate_blocks_mixed_cache,
               test_volume_signals_fire_on_planted_events, test_phase2_report_section]:
        print(f"\n--- {fn.__name__} ---")
        fn()
    print(f"\n{'=' * 50}")
    if FAILED:
        print(f"{len(FAILED)} 項失敗：")
        for f in FAILED:
            print(f"  - {f}")
        return 1
    print("全部通過")
    return 0


if __name__ == "__main__":
    sys.exit(main())
