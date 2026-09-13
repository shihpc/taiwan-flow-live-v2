# tests/test_archive_intraday.py — src/archive_intraday.py 的離線測試（D7② 鏈層欄位 cg／cmkt）
#
# 免 token、免網路：/replay 與 /live 全部以假的 get_json 注入，classify 寫進暫存目錄後
# 把模組常數指過去。可 `python tests/test_archive_intraday.py` 直跑，
# 也可 `python -m pytest tests/test_archive_intraday.py -q`。
#
# 涵蓋（對應 d7-acceptance 的 B1~B6／C2／C3）：
#   1. **口徑重用的證據**：cg 的每一格逐位等於直接呼叫 build_rrg_frozen.agg_frame() 的
#      amt_yi，且 cg/cmkt 還原出的 share 逐位等於 agg_frame 的 shares
#      （＝「真的重用 agg_frame」而不是另寫一份口徑）
#   2. 既有欄位（date/generated_at 以外）一字不動：關掉 /live 走降級路徑，與正常路徑的
#      既有欄位逐位相同
#   3. 鏈名集合＝classify 的 c 全集（含當日完全沒成交的鏈，值為 0.0 而非缺席）
#   4. /live 取不到 → 不寫 cg/cmkt/cmeta、**檔案照樣寫出、exit 0**（B4 優雅降級）
#   5. 不多打 frame：/replay 的請求次數與沒有鏈層欄位時完全相同（B6）
#   6. 缺格時點：cg 各鏈與 cmkt 記 null（不是 0），長度＝54
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import archive_intraday as ai  # noqa: E402
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


# ---- 合成資料 ------------------------------------------------------------
# 刻意塞進四種必須被口徑分辨的個股：
#   2330 twse＋兩條鏈（去重後各加一次）／1101 twse 單鏈／6488 tpex（分子分母都不計）／
#   002 twse 但不在 /live（彙總碼型：分母算、分子不算——前端既有的不對稱行為）
CLASSIFY = {"map": {
    "2330": {"t": "twse", "c": ["半導體", "電子零組件"], "p": [["半導體", "晶圓代工"]]},
    "1101": {"t": "twse", "c": ["水泥"], "p": [["水泥", "水泥製造"]]},
    "6488": {"t": "tpex", "c": ["半導體"], "p": [["半導體", "IC 設計"]]},
    "002": {"t": "twse", "c": ["其他"], "p": []},
    "9999": {"t": "twse", "c": ["生技醫療"], "p": [["生技醫療", "新藥"]]},   # 當日完全沒成交
}}
LIVE_CODES = ["2330", "1101", "6488", "9999"]      # 002 刻意不在 /live
MISSING_T = {"09:05", "13:30"}                      # 兩格缺 frame，驗 null 與長度


def frame_for(t: str) -> dict:
    """每個時點給不同的量，確保矩陣不是常數（比對才有鑑別力）。"""
    k = int(t[:2]) * 60 + int(t[3:])
    return {"t": t, "stale": 0, "stocks": {
        "2330": [1000 * k, 100.0],
        "1101": [30 * k, 20.0],
        "6488": [50 * k, 10.0],
        "002": [7 * k, 0.0],
    }}


def make_get_json(calls: list, live_ok: bool = True):
    def fake(url: str, retries: int = 3):
        calls.append(url)
        if url.endswith("/live"):
            if not live_ok:
                raise RuntimeError("boom")
            return {"stocks": {c: [1, 2] for c in LIVE_CODES}}
        if "&t=" in url:
            t = url.split("&t=")[1]
            if t in MISSING_T:
                return {"error": "no frame"}
            return frame_for(t)
        return {"series": [{"t": "09:05", "amt": 1, "idx": 2, "chg": 0.1}]}
    return fake


def run(tmp: Path, live_ok: bool = True):
    (tmp / "data").mkdir(parents=True, exist_ok=True)
    (tmp / "data" / "classify.json").write_text(json.dumps(CLASSIFY, ensure_ascii=False), encoding="utf-8")
    calls: list[str] = []
    ai.ROOT = tmp
    ai.OUT_DIR = tmp / "data" / "intraday"
    ai.get_json = make_get_json(calls, live_ok)
    rc = ai.build("2026-09-14")
    path = tmp / "data" / "intraday" / "2026-09-14.json"
    obj = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    return rc, obj, calls


def main() -> int:
    with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
        rc, obj, calls = run(Path(d1), live_ok=True)
        rc2, obj2, calls2 = run(Path(d2), live_ok=False)

        check("正常路徑 exit 0 且有寫檔", rc == 0 and obj is not None)
        check("降級路徑 exit 0 且**照常寫檔**（B4）", rc2 == 0 and obj2 is not None)
        check("降級時不寫 cg/cmkt/cmeta（B4）",
              all(k not in obj2 for k in ("cg", "cmkt", "cmeta")))
        check("正常時三個新欄位都在", all(k in obj for k in ("cg", "cmkt", "cmeta")))

        # B2：既有欄位一字不動（generated_at 是牆鐘，排除）
        keys = ["date", "unit", "series", "times", "frames", "total", "nstk", "g"]
        check("既有欄位在兩條路徑下逐位相同（B2）",
              all(obj[k] == obj2[k] for k in keys))
        check("既有欄位順序未變、新欄位一律附加在最後（B2）",
              list(obj.keys())[:9] == ["date", "generated_at", "unit", "series",
                                       "times", "frames", "total", "nstk", "g"]
              and list(obj.keys())[9:] == ["cg", "cmkt", "cmeta"])

        # B6：不多打 frame——兩條路徑的 /replay 請求次數相同
        rep = [u for u in calls if "replay" in u]
        rep2 = [u for u in calls2 if "replay" in u]
        check("鏈層欄位不多打任何一格 frame（B6）",
              rep == rep2 and len(rep) == 1 + len(ai.timepoints()))
        check("只多一次 GET /live", len([u for u in calls if u.endswith("/live")]) == 1)

        # B3：鏈名＝classify 的 c 全集（含當日零成交的「生技醫療」與只在 002 出現的「其他」）
        want = sorted({"半導體", "電子零組件", "水泥", "其他", "生技醫療"})
        check("鏈名集合＝classify 的 c 全集（B3）", sorted(obj["cg"]) == want)

        times = obj["times"]
        check("cg 每條鏈長度＝時點數", all(len(v) == len(times) for v in obj["cg"].values()))
        check("cmkt 長度＝時點數", len(obj["cmkt"]) == len(times))

        # 缺格 → null（不是 0）
        i0 = times.index("09:05")
        check("缺格時點 cg 各鏈與 cmkt 皆為 null（不是 0）",
              all(v[i0] is None for v in obj["cg"].values()) and obj["cmkt"][i0] is None)

        # ★ C2：逐位比對 agg_frame ——「真的重用」的證據
        cmap = CLASSIFY["map"]
        chains = sorted(want)
        bad_amt = bad_share = 0
        n_cmp = 0
        for i, t in enumerate(times):
            if t in MISSING_T:
                continue
            sh, ay, mkt = bf.agg_frame(frame_for(t)["stocks"], cmap, LIVE_CODES, chains)
            if obj["cmkt"][i] != mkt:
                bad_amt += 1
            for name in chains:
                n_cmp += 1
                got = obj["cg"][name][i]
                if got != ay[name] or got.hex() != ay[name].hex():
                    bad_amt += 1
                if (got / obj["cmkt"][i]).hex() != sh[name].hex():
                    bad_share += 1
        check(f"cg 逐位＝agg_frame 的 amt_yi（比對 {n_cmp} 格，C2）", bad_amt == 0)
        check(f"cg/cmkt 還原的 share 逐位＝agg_frame 的 shares（C2）", bad_share == 0)

        # 口徑抽驗：2330 同時在兩條鏈、1101 只在水泥、6488(tpex) 不計、002 只進分母
        i = times.index("10:00")
        k = 10 * 60
        check("tpex 不進分子（半導體只有 2330 的量）",
              obj["cg"]["半導體"][i] == 1000 * k / 1e8)
        check("多鏈去重後各加一次（電子零組件＝半導體）",
              obj["cg"]["電子零組件"][i] == obj["cg"]["半導體"][i])
        check("不在 /live 的 twse 代號不進分子（其他＝0.0）", obj["cg"]["其他"][i] == 0.0)
        check("分母只看 frame：含 002、不含 tpex",
              obj["cmkt"][i] == (1000 * k + 30 * k + 7 * k) / 1e8)
        check("當日零成交的鏈補 0.0（不是缺席）", obj["cg"]["生技醫療"][i] == 0.0)

        # C3：既有下游吃的三個欄位形狀不變
        check("g 仍是次產業層（含 tpex 的 IC 設計）", "IC 設計" in obj["g"])
        check("total 含 tpex（與 cmkt 的 TSE 口徑不同）",
              obj["total"][i] == 1000 * k + 30 * k + 50 * k + 7 * k)
    done()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
