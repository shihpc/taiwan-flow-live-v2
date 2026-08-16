# tests/test_phase_a_smoke.py — LINE 圖卡 Phase A 上游資料缺口的離線煙霧測試
#
# 為什麼需要這支：build_baseline.py / build_daysummary.py 要 FINMIND_TOKEN／Worker 才
# 真跑得動，離線環境改壞了不會有東西擋。這支比照 backtest/test_sorting_smoke.py 的做法，
# 用合成資料直接呼叫抽出的純函式，驗——
#   1. nh/nl 對稱性（nh_nl）
#   2. subs_y 的 C/R 值傳遞（sub_signal 回傳 stats → build_subs_y 組裝 [y1,y2,C,R]）
#   3. a20 分母口徑（a20_of：含當日 20 日窗、濾空、除以有效日數＝run_sorting.py volt 分母）
#   4. daysummary chain 聚合的產業層去重（agg_multi：一檔多次產業不重複計入同產業）
#
# 用法：python tests/test_phase_a_smoke.py（免 token、免網路）

from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import build_baseline as bb   # noqa: E402
import build_daysummary as bd  # noqa: E402

FAILED = []


def check(label, cond):
    ok = bool(cond)
    print(f"{'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        FAILED.append(label)


# ---------- 1. nh/nl 對稱性 ----------

def test_nh_nl_symmetry():
    prevs = [100.0, 105.0, 98.0]     # 前20日收盤（此處3筆即可）：max=105、min=98
    check("收盤 > 前高 → nh=1, nl=0", bb.nh_nl(106.0, prevs) == (1, 0))
    check("收盤 < 前低 → nh=0, nl=1", bb.nh_nl(97.0, prevs) == (0, 1))
    check("介於其間 → (0,0)", bb.nh_nl(100.0, prevs) == (0, 0))
    check("等於前高（非嚴格大於）→ (0,0)", bb.nh_nl(105.0, prevs) == (0, 0))
    check("等於前低（非嚴格小於）→ (0,0)", bb.nh_nl(98.0, prevs) == (0, 0))
    check("無前值 → (0,0)", bb.nh_nl(100.0, []) == (0, 0))


# ---------- 2. sub_signal 的 C/R 傳遞 → subs_y ----------

def _mk_pd(sub_amt_today, ret_today):
    """造 7 天（新→舊）pd：次產業 SUBA 5 檔成員、另有市場填充股。
    基期 5 日每檔成員 2 億/日、市場總額固定 → conc 可手算。"""
    mem = [f"11{i:02d}" for i in range(5)]        # SUBA 成員
    others = [f"22{i:02d}" for i in range(5)]     # 市場填充
    pdays = []
    for d in range(7):
        m = {}
        for c in mem:
            if d == 0:
                close = 100.0 * (1 + ret_today)
                m[c] = (sub_amt_today / 5, close, close * 1.01, close * 0.99)
            else:
                m[c] = (2e8, 100.0, 101.0, 99.0)
        for c in others:
            m[c] = (18e8, 50.0, 50.5, 49.5)       # 市場其餘 90 億/日
        pdays.append(m)
    return pdays, {"SUBA": set(mem)}


def test_sub_signal_stats():
    # 今日 SUBA 40 億（基期 10 億/日）、成員齊漲 +2%
    pdays, members = _mk_pd(sub_amt_today=40e8, ret_today=0.02)
    flags, stats = bb.sub_signal(pdays, 0, members)
    # 手算 conc：今日佔比 = 40/(40+90)；基期佔比 = 10/100 → conc = (40/130)/(0.1) ≈ 3.0769
    check("湧入旗標成立", flags.get("SUBA") == 1)
    check("stats 帶 conc（≈3.08）", "SUBA" in stats and abs(stats["SUBA"][0] - (40 / 130) / 0.1) < 1e-9)
    check("stats 帶 ret（=0.02）", abs(stats["SUBA"][1] - 0.02) < 1e-9)

    # 組裝：y1 成立 → [1, y2, C, R]，C/R 有值且已 round
    subs_y = bb.build_subs_y(flags, {}, stats)
    v = subs_y["SUBA"]
    check("subs_y 為 4 元素 [y1,y2,C,R]", len(v) == 4 and v[0] == 1 and v[1] == 0)
    check("C = round(conc,2)", v[2] == round((40 / 130) / 0.1, 2))
    check("R = round(ret,4) = 0.02", v[3] == 0.02)

    # 既有前 2 元素語意不變（等同舊版 [y1,y2]）
    check("前 2 元素 == 舊版 [y1,y2]", v[:2] == [flags.get("SUBA", 0), 0])

    # 只有 y2 成立、當日無 stats → C/R 為 None（y2 不需要昨日 C/R）
    subs_y2 = bb.build_subs_y({}, {"SUBB": -1}, stats)
    check("僅 y2 旗標者 → [0,-1,None,None]", subs_y2["SUBB"] == [0, -1, None, None])

    # 退出方向：今日 -2%
    pdn, mn = _mk_pd(sub_amt_today=40e8, ret_today=-0.02)
    fn, sn = bb.sub_signal(pdn, 0, mn)
    check("退出旗標對稱成立（-1）", fn.get("SUBA") == -1)
    check("退出方向 ret 為負", sn["SUBA"][1] < 0)

    # 門檻不過（conc<1.5）→ 無旗標但 stats 仍記錄（供 subs_y 的 C）
    pdw, mw = _mk_pd(sub_amt_today=11e8, ret_today=0.02)   # conc ≈ (11/101)/0.1 ≈ 1.09
    fw, sw = bb.sub_signal(pdw, 0, mw)
    check("conc<1.5 → 無旗標", "SUBA" not in fw)
    check("conc<1.5 → stats 仍有值", "SUBA" in sw and sw["SUBA"][0] < 1.5)


# ---------- 3. a20 分母口徑 ----------

def test_a20_denominator():
    # 21 天 pd（新→舊）：day0..day20；day5 缺該股、day7 額為 0 → 不進分母
    amts = [float((k + 1) * 1e8) for k in range(21)]
    pdays = []
    for k in range(21):
        m = {"9999": (1e8, 1.0, 1.0, 1.0)}
        if k == 5:
            pass                                    # 缺資料日
        elif k == 7:
            m["2330"] = (0.0, 500.0, 505.0, 495.0)  # 零額日
        else:
            m["2330"] = (amts[k], 500.0, 505.0, 495.0)
        pdays.append(m)
    # 口徑＝run_sorting.py:151：aw = 前 20 日（含當日）濾空，mean = sum/len
    aw = [amts[k] for k in range(20) if k not in (5, 7)]
    expect = round(sum(aw) / len(aw))
    got = bb.a20_of(pdays, "2330")
    check(f"a20 = 有效 18 日均值（{got} vs {expect}）", got == expect)
    # 分母是有效日數（18）而非固定 20 —— 若誤除 20 會得到不同值
    check("分母≠固定20（口徑守門）", got != round(sum(aw) / 20))
    # 窗含當日、不含第 21 天（pd[20]）：把 pd[20] 改成天文數字不得影響結果
    pdays[20]["2330"] = (9e18, 500.0, 505.0, 495.0)
    check("第 21 天不進窗", bb.a20_of(pdays, "2330") == expect)
    # 當日在窗內：改 pd[0] 必須改變結果
    pdays[0]["2330"] = (9e12, 500.0, 505.0, 495.0)
    check("當日在窗內（含當日口徑）", bb.a20_of(pdays, "2330") != expect)
    check("全缺 → 0", bb.a20_of(pdays, "8888") == 0)


# ---------- 4. daysummary chain 聚合：產業層去重 ----------

def _cl_chain():
    # 3 檔上市股都掛「半導體」產業，其中 3101 在半導體底下有兩個次產業（去重測點）、
    # 另掛「電子」產業；3103 僅一對。再加一檔上櫃股（must skip）。
    return {
        "3101": {"n": "甲", "t": "twse", "p": [["半導體", "IC設計"], ["半導體", "IC封測"], ["電子", "組裝"]]},
        "3102": {"n": "乙", "t": "twse", "p": [["半導體", "IC設計"], ["電子", "組裝"]]},
        "3103": {"n": "丙", "t": "twse", "p": [["半導體", "晶圓代工"], ["電子", "組裝"]]},
        "3104": {"n": "丁", "t": "tpex", "p": [["半導體", "IC設計"]]},   # 上櫃 → 不進聚合
    }


def test_chain_dedup():
    cl = _cl_chain()
    # stocks 陣列格式 [amt, pts, chg]（i_amt=0, i_pts=1, i_chg=2）
    stocks = {
        "3101": [10e8, 5.0, 1.0],
        "3102": [20e8, -2.0, -1.0],
        "3103": [30e8, 1.0, 0.0],
        "3104": [99e8, 9.0, 9.0],
    }
    chains = bd.agg_multi(stocks, cl, 0, 1, 2, level=0)
    semi = next((s for s in chains if s["n"] == "半導體"), None)
    check("半導體聚合存在（n_stk=3）", semi is not None and semi["n_stk"] == 3)
    # 產業層去重：3101 兩個次產業同屬半導體，只計一次 → amt = 10+20+30 = 60 億（非 70）
    check(f"產業層去重：amt=60億非70億（{semi and semi['amt']/1e8}）",
          semi is not None and abs(semi["amt"] - 60e8) < 1)
    check("pts 同樣去重（5-2+1=4）", semi is not None and abs(semi["pts"] - 4.0) < 1e-9)
    check("up/down 各計一次（1漲1跌）", semi is not None and semi["up"] == 1 and semi["down"] == 1)
    ele = next((s for s in chains if s["n"] == "電子"), None)
    check("跨產業仍各自計入（電子 n_stk=3）", ele is not None and ele["n_stk"] == 3)
    check("上櫃股不進聚合", semi is not None and semi["amt"] < 90e8)

    # 次產業層（level=1）語意：同名次產業去重、不同次產業各計
    subs = bd.agg_multi(stocks, cl, 0, 1, 2, level=1)
    icd = next((s for s in subs if s["n"] == "IC設計"), None)
    check("次產業層 IC設計 只含 3101/3102（amt=30億）", icd is None or abs(icd["amt"] - 30e8) < 1)
    # n_stk<3 的次產業被門檻濾掉（IC設計只有 2 檔上市）
    check("n_stk>=3 門檻生效（IC設計被濾）", icd is None)
    zu = next((s for s in subs if s["n"] == "組裝"), None)
    check("組裝（3 檔）通過門檻", zu is not None and zu["n_stk"] == 3)


# ---------- 5. daysummary subs_stocks：次產業內貢獻絕對值前 3 檔（2026-08-16，ov-6 改版）----------

def test_sub_stocks_top():
    cl = {
        "3101": {"n": "甲", "t": "twse", "p": [["半導體", "IC設計"], ["半導體", "IC封測"]]},
        "3102": {"n": "乙", "t": "twse", "p": [["半導體", "IC設計"]]},
        "3103": {"n": "丙", "t": "twse", "p": [["半導體", "IC設計（含IP）"]]},   # clean_sub 測點
        "3104": {"n": "丁", "t": "tpex", "p": [["半導體", "IC設計"]]},           # 上櫃 → 不進
        "3105": {"n": "戊", "t": "twse", "p": [["半導體", "IC設計"]]},
        "3106": {"n": "己", "t": "twse", "p": [["半導體", "IC設計"]]},
        "3107": {"n": "庚", "t": "twse", "p": [["電子", "組裝"]]},               # 非目標次產業
    }
    stocks = {   # [amt, pts]（i_pts=1）
        "3101": [1e8, 5.0], "3102": [1e8, -8.0], "3103": [1e8, 2.0],
        "3104": [1e8, 99.0], "3105": [1e8, 0], "3106": [1e8, 1.0], "3107": [1e8, 7.0],
    }
    got = bd.sub_stocks_top(stocks, cl, 1, {"IC設計"})
    check("只含目標次產業", set(got) == {"IC設計"})
    lst = got.get("IC設計") or []
    check("依貢獻絕對值降序取前 3（-8.0 居首）", [r["c"] for r in lst] == ["3102", "3101", "3103"])
    check("pts 保留正負且 round 2 位", lst and lst[0]["pts"] == -8.0 and lst[1]["pts"] == 5.0)
    check("clean_sub 對齊（3103 的「IC設計（含IP）」歸入 IC設計）", any(r["c"] == "3103" for r in lst))
    check("上櫃股不進（3104 排除）", all(r["c"] != "3104" for r in lst))
    check("pts=0 不進（3105 排除）", all(r["c"] != "3105" for r in lst))
    check("帶股名 n", lst and lst[0]["n"] == "乙")
    check("目標次產業無成員 → 不出現該鍵", bd.sub_stocks_top(stocks, cl, 1, {"不存在"}) == {})


def main():
    for fn in [test_nh_nl_symmetry, test_sub_signal_stats,
               test_a20_denominator, test_chain_dedup, test_sub_stocks_top]:
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
