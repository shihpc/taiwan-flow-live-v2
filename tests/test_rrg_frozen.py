# tests/test_rrg_frozen.py — src/build_rrg_frozen.py（RRG 盤外定格檔）的離線測試
#
# 免 token、免網路：/replay 與 /live 全部以假的 get_json 注入，classify／rrg_base 寫進
# 暫存目錄後把模組常數指過去。可 `python tests/test_rrg_frozen.py` 直跑，
# 也可 `python -m pytest tests/test_rrg_frozen.py -q`。
#
# 涵蓋（對應 g1 驗收 E1）：
#   1. 時點：與 index.html 的 ovRrgTimes(錨點 13:30) 同一組（12 個時點／9 個取樣點）
#   2. base 切片取對時點（每個時點各取 rrg_base.json 對應索引的值，且為原值搬運）
#   3. 鏈名集合：frames／amt 一律等於 base 的鏈集合——classify 有而 base 沒有的鏈不輸出，
#      base 有而當日無成交的鏈補 0.0（前端 ovRrgCompute 只走訪 base 的鏈）
#   4. share 口徑：只算 twse、依 c 去重、分母只看 frame（不與 /live 取交集）、
#      分子多一層 /live 交集——不對稱是前端 ovAggBy／ovReplayBuild 的既有行為
#   5. times 不足（frame 缺格使可用取樣點 <3）→ 不寫檔、exit 0（保留前一版定格檔）
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import build_rrg_frozen as bf  # noqa: E402

FAILED = []


def check(label, cond):
    ok = bool(cond)
    print(f"{'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        FAILED.append(label)


def done():
    """每支測試收尾都要呼叫：check() 只記錄不拋，少了這一行 pytest 會永遠綠燈。"""
    assert not FAILED, "、".join(FAILED)


# ---- 測試素材 ------------------------------------------------------------
# classify：2330/2317 屬 twse；2330 同時掛兩條鏈、且其中一條在 p 裡重複（測去重）；
# 6488 是 tpex（只進分母的 tpex 桶、不進 tseYi，也不進任何鏈）；9999 無分類。
CMAP = {
    "2330": {"t": "twse", "c": ["半導體", "人工智慧", "半導體"]},
    "2317": {"t": "twse", "c": ["人工智慧"]},
    "1101": {"t": "twse", "c": ["水泥"]},          # base 沒有這條鏈 → 不應出現在 frames
    "6488": {"t": "tpex", "c": ["半導體"]},
    "9999": {},
    # frame 有、/live 沒有：進分母（ovReplayBuild 只看 frame）、不進分子（ovAggBy 走訪 /live 代號）
    "8888": {"t": "twse", "c": ["半導體"]},
}
# base：涵蓋 09:05–13:30 全部 54 個 5 分鐘時點，值＝索引的函數，方便驗「切片取對時點」
BTIMES = [f"{m // 60:02d}:{m % 60:02d}" for m in range(545, 811, 5)]
BCHAINS = {
    "半導體": [round(0.4 + i / 10000, 6) for i in range(len(BTIMES))],
    "人工智慧": [round(0.1 + i / 10000, 6) for i in range(len(BTIMES))],
    "無盤中成交鏈": [0.05] * len(BTIMES),          # 當日完全沒成交 → frames 應補 0.0
}
LIVE_CODES = ["2330", "2317", "1101", "6488", "9999"]


def _frame(mult: float):
    """一格 frame：{code:[累計成交額(元), 價]}。mult 讓各時點值不同。"""
    return {
        "2330": [int(100_000_000 * mult), 1000],
        "2317": [int(50_000_000 * mult), 100],
        "1101": [int(10_000_000 * mult), 20],
        "6488": [int(7_000_000 * mult), 50],       # tpex：不進 tseYi 也不進鏈
        "9999": [int(3_000_000 * mult), 10],       # 無分類：不進 tseYi
        "8888": [int(1_000_000 * mult), 10],       # twse 但 /live 沒有 → 只進分母、不進分子
    }


def _setup(tmp: Path, base_chains=None, live_codes=None):
    (tmp / "data").mkdir(parents=True, exist_ok=True)
    (tmp / "data" / "classify.json").write_text(json.dumps({"map": CMAP}), encoding="utf-8")
    (tmp / "data" / "rrg_base.json").write_text(json.dumps({
        "generated_at": "2026-09-10T14:20:00+08:00",
        "days": ["2026-09-04", "2026-09-05", "2026-09-08", "2026-09-09", "2026-09-10"],
        "times": BTIMES,
        "chains": base_chains if base_chains is not None else BCHAINS,
    }), encoding="utf-8")
    bf.CLASSIFY = tmp / "data" / "classify.json"
    bf.BASE = tmp / "data" / "rrg_base.json"
    codes = LIVE_CODES if live_codes is None else live_codes
    bf.get_json = _fake_get(codes, set())
    return tmp / "data" / "rrg_frozen.json"


def _fake_get(live_codes, missing_times):
    def g(url: str):
        if "/live" in url:
            return {"stocks": {c: [] for c in live_codes}}
        t = url.split("t=")[1]
        if t in missing_times:
            return {"error": "該時段無盤中資料", "t": t}
        return {"t": t, "date": "2026-09-10", "stocks": _frame(1 + bf.rrg_times()[1].index(t) / 10)}
    return g


# ---- 測試 ---------------------------------------------------------------
def test_times():
    samples, times = bf.rrg_times()
    check("時點數＝12（NPT6＋ZEXT3 個座標點，各再往前 LAG30 分）", len(times) == 12)
    check("取樣點數＝9", len(samples) == 9)
    check("時點內容＝11:40~13:30 每 10 分",
          sorted(times) == ["11:40", "11:50", "12:00", "12:10", "12:20", "12:30",
                            "12:40", "12:50", "13:00", "13:10", "13:20", "13:30"])
    check("最後一個取樣點＝(810,'13:30','13:00')", samples[-1] == (810, "13:30", "13:00"))
    check("取樣點由舊到新", [s[0] for s in samples] == sorted(s[0] for s in samples))
    done()


def test_build_ok():
    with tempfile.TemporaryDirectory() as td:
        out = _setup(Path(td))
        rc = bf.build("2026-09-10", out)
        check("正常情境 exit 0", rc == 0)
        j = json.loads(out.read_text(encoding="utf-8"))
        check("date 正確", j["date"] == "2026-09-10")
        check("times 12 個且已排序", len(j["times"]) == 12 and j["times"] == sorted(j["times"]))
        check("frames 12 格", len(j["frames"]) == 12)

        # 2：base 切片取對時點（原值搬運，不做任何運算）
        ok = all(j["base"][t][c] == BCHAINS[c][BTIMES.index(t)]
                 for t in j["times"] for c in ("半導體", "人工智慧"))
        check("base 切片逐時點取自 rrg_base 對應索引的原值", ok)
        check("base 切片值確實隨時點不同（沒有整欄搬同一格）",
              len({j["base"][t]["半導體"] for t in j["times"]}) == 12)

        # 3：鏈名集合＝base 的鏈；classify 有而 base 沒有的（水泥）不得出現
        fset = set().union(*[set(v) for v in j["frames"].values()])
        aset = set().union(*[set(v) for v in j["amt"].values()])
        bset = set().union(*[set(v) for v in j["base"].values()])
        check("frames 與 amt 的鏈集合一致", fset == aset)
        check("frames 的鏈集合＝base 的鏈集合", fset == bset == set(BCHAINS))
        check("classify 有、base 沒有的鏈（水泥）不輸出", "水泥" not in fset)
        check("base 有、當日無成交的鏈補 0.0",
              all(j["frames"][t]["無盤中成交鏈"] == 0.0 and j["amt"][t]["無盤中成交鏈"] == 0.0
                  for t in j["times"]))

        # 4：share 口徑。tseYi＝2330+2317+1101+8888（frame 內 twse），tpex／未分類不計；
        #    分子只算 /live 有的代號（8888 被排除），2330 的兩條鏈各記一次（去重後兩條）
        t0 = j["times"][0]
        mult = 1 + bf.rrg_times()[1].index(t0) / 10
        a2330, a2317, a1101 = (int(x * mult) for x in (100_000_000, 50_000_000, 10_000_000))
        tse = (a2330 + a2317 + a1101 + int(1_000_000 * mult)) / 1e8
        check("mkt＝frame 內 twse 全體（含 /live 沒有的 8888），不含 tpex／未分類",
              abs(j["mkt"][t0] - tse) < 1e-12)
        check("半導體 share＝2330÷tseYi（分子排除 /live 沒有的 8888）",
              abs(j["frames"][t0]["半導體"] - (a2330 / 1e8) / tse) < 1e-12)
        check("人工智慧 share＝(2330+2317)÷tseYi（多對多各記一次）",
              abs(j["frames"][t0]["人工智慧"] - ((a2330 + a2317) / 1e8) / tse) < 1e-12)
        check("amt 為億元（半導體）", abs(j["amt"][t0]["半導體"] - a2330 / 1e8) < 1e-12)
        check("檔案 <100KB", out.stat().st_size < 100 * 1024)
    done()


def test_chain_mismatch():
    """base 的鏈名與當日盤中完全對不上 → 仍寫檔，但每條鏈都是 0.0（不靜默改用別的口徑）。"""
    with tempfile.TemporaryDirectory() as td:
        out = _setup(Path(td), base_chains={"完全不存在的鏈": [0.3] * len(BTIMES)})
        rc = bf.build("2026-09-10", out)
        j = json.loads(out.read_text(encoding="utf-8"))
        check("鏈名全不一致：exit 0 且只輸出 base 的鏈", rc == 0 and set(j["frames"][j["times"][0]]) == {"完全不存在的鏈"})
        check("鏈名全不一致：share 一律 0.0（不回頭猜別的鏈）",
              all(v["完全不存在的鏈"] == 0.0 for v in j["frames"].values()))
    done()


def test_base_missing_timepoint():
    """base 某鏈在某時點是 null／0 → 該時點該鏈不進切片（前端 ovRrgBaseAt 同樣視為無值）。"""
    with tempfile.TemporaryDirectory() as td:
        ch = {k: list(v) for k, v in BCHAINS.items()}
        i = BTIMES.index("12:30")
        ch["半導體"][i] = None
        ch["人工智慧"][i] = 0
        out = _setup(Path(td), base_chains=ch)
        bf.build("2026-09-10", out)
        j = json.loads(out.read_text(encoding="utf-8"))
        check("base 為 null 的時點不進切片", "半導體" not in j["base"]["12:30"])
        check("base 為 0 的時點不進切片（同 ovRrgBaseAt 的 v>0 條件）", "人工智慧" not in j["base"]["12:30"])
        check("其他時點不受影響", "半導體" in j["base"]["12:20"] and "半導體" in j["base"]["12:40"])
    done()


def test_not_enough_times():
    """frame 缺格使可用取樣點 <3 → 不寫檔、exit 0（保留前一版定格檔）。"""
    with tempfile.TemporaryDirectory() as td:
        out = _setup(Path(td))
        out.write_text('{"date":"2026-09-09","keep":"me"}', encoding="utf-8")   # 前一版定格檔
        # 只留 13:30／13:20／13:10 與其 30 分前的一格 → 可用取樣點 <3
        bf.get_json = _fake_get(LIVE_CODES, {"11:40", "11:50", "12:00", "12:10",
                                             "12:20", "12:30", "12:40", "12:50", "13:00"})
        rc = bf.build("2026-09-10", out)
        check("取樣點不足：exit 0（優雅退出）", rc == 0)
        check("取樣點不足：不覆寫前一版定格檔",
              json.loads(out.read_text(encoding="utf-8")).get("keep") == "me")

    with tempfile.TemporaryDirectory() as td:
        out = _setup(Path(td))
        bf.get_json = _fake_get(LIVE_CODES, set(bf.rrg_times()[1]))   # 全缺＝非交易日
        rc = bf.build("2026-09-10", out)
        check("整日無 frame（非交易日）：exit 0 且不寫檔", rc == 0 and not out.exists())
    done()


def test_base_file_problems():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        out = _setup(tmp)
        bf.BASE = tmp / "data" / "nope.json"
        check("缺 rrg_base.json → exit 1（真故障）", bf.build("2026-09-10", out) == 1)
        bad = tmp / "data" / "bad.json"
        bad.write_text(json.dumps({"times": ["09:05"], "chains": {"半導體": [0.4]}}), encoding="utf-8")
        bf.BASE = bad
        check("rrg_base 缺本檔要的時點 → exit 1（不靜默補值）", bf.build("2026-09-10", out) == 1)
    done()


if __name__ == "__main__":
    test_times()
    test_build_ok()
    test_chain_mismatch()
    test_base_missing_timepoint()
    test_not_enough_times()
    test_base_file_problems()
    if FAILED:
        print(f"\nFAIL {len(FAILED)}：" + "、".join(FAILED))
        sys.exit(1)
    print("\nALL PASS")
