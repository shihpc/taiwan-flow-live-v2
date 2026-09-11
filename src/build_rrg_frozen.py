# src/build_rrg_frozen.py — 產 data/rrg_frozen.json（盤中輪動雷達 RRG 的「盤外定格」輸入檔）
#
# 動機（G1，2026-09-11）：週末／國定假日／frame 過了 KV 2 天 TTL 時，前端 RRG 打
#   /replay 取不到任何 frame，整張圖消失（index.html 的降級③「取不到盤中快照」）。
#   收盤後把當日最後一組軌跡的**輸入**落成靜態檔，前端盤外改吃它 → 圖還在，並明標定格。
#
# ★ 存輸入、不存座標：本檔只輸出 share／amt／base 三份「餵給 ovRrgCompute 的原料」，
#   座標仍由前端**同一支** ovRrgCompute 算。若在 Python 重算座標＝同一口徑兩份實作，
#   本家族已在 taiwan-flows 的 parity.py、postmkt 的 augmentLending 上踩過（改一邊漏另一邊）。
#
# ── 口徑（本檔最容易踩雷之處，改前務必讀完）────────────────────────────────
# share 必須與前端 ovRrgAggFrame() 逐步一致（**不是** data/intraday 的次產業層口徑，
# 兩者差異見 src/build_rrg_base.py 檔頭「口徑」段）。前端實際做的事：
#   分母 = ovReplayBuild(frame).mkt.tseYi
#        = Σ amt（frame 內、classify 有分類且 t=="twse" 的個股）÷ 1e8
#          （ovReplayBuild 只看 frame，不與 /live 取交集）
#   分子 = ovAggBy(null, info=>info.c||[])：**走訪 state.live.stocks 的代號**，
#          取 OV_REPLAY.vals[code]（＝frame 內的 amt），只計 info.t=="twse"，
#          依 info.c（產業鏈）**去重後**每條鏈各加一次（多對多）
#   share_i = (Σ_i amt / 1e8) / tseYi ；amtYi_i = Σ_i amt / 1e8
# 故分子的代號集合＝frame ∩ /live ∩ twse，分母＝frame ∩ twse——**兩者不對稱**，
# 這是前端既有行為，本檔照抄（實測 2026-09-11：frame−live 的 41 個代號全是 002/003 等
# 彙總碼、classify 皆非 twse，兩者當日等價；但不可因此把 /live 那步省掉）。
# 加總用整數（frame 的 amt 是「元」整數，部分和一律 <2^53 → 加總順序不影響結果，
# 與 JS 的 double 加總逐位相同），再依 JS 同樣的順序做 /1e8 與相除。
# ──────────────────────────────────────────────────────────────────────
#
# 時點：與前端 ovRrgTimes(錨點=13:30) 完全同一組（NPT=6 + ZEXT=3 個座標點，每點再往前
#   LAG=30 分算動能 → 去重後 12 個）。錨點固定 13:30（＝OV_RRG_TMAX），與牆鐘無關，
#   所以產製端與前端定格路徑必然對得上。
#
# base：**取自當下那份 data/rrg_base.json 的同時點切片**，且 .github/workflows/intraday.yml
#   把本步驟排在「build rrg base」**之前** —— 那一步會把「今天」也算進基準，重算後的 base
#   反推今天的座標會與使用者盤中看到的不同。切片只是原值搬運，不做任何運算。
#
# 產物：data/rrg_frozen.json
#   {date, generated_at, times[12], frames{hm:{鏈:share}}, amt{hm:{鏈:億}},
#    mkt{hm:tseYi}, base{hm:{鏈:base}}, base_days[], base_generated_at, note}
#   鏈名一律取 rrg_base.json 的 chains（前端 ovRrgCompute 只走訪 base 的鏈），
#   frames/amt 對每條鏈都給值（無成交＝0.0），base 則略過 null（前端 ovRrgBaseAt 對
#   缺值與非正值同樣回 null，語意不變）。實測約 60KB。
#
# 退出碼：0＝已寫檔，或**優雅退出不寫檔**（非交易日／frame 全缺／可用取樣點 <3，
#   此時保留前一版定格檔——它自帶 date，前端會照實標示）；1＝真故障（缺 base/classify、
#   網路連不上、base 時點對不上）。呼叫端 intraday.yml 以 outputs.ok 記錄，紅燈延到 commit 之後。
#
# 用法：python src/build_rrg_frozen.py [--date YYYY-MM-DD] [--out data/rrg_frozen.json]

from __future__ import annotations
import argparse
import io
import json
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CLASSIFY = ROOT / "data" / "classify.json"
BASE = ROOT / "data" / "rrg_base.json"
OUT = ROOT / "data" / "rrg_frozen.json"
WORKER = "https://taiwan-flow-v2.shihpc.workers.dev"
TPE = timezone(timedelta(hours=8))
HEADERS = {"User-Agent": "build-rrg-frozen/1.0"}

# 以下五個常數＝index.html 的 OV_RRG_STEP／OV_RRG_NPT／OV_RRG_LAG／OV_RRG_ZEXT／OV_RRG_TMIN、
# OV_RRG_TMAX，**改一邊要改另一邊**（改了時點數就對不上，定格圖會少點或整張畫不出來）。
STEP, NPT, LAG, ZEXT = 10, 6, 30, 3
TMIN, TMAX = 545, 810          # 09:05 / 13:30
MIN_SAMPLES = 3                # 前端 ovRrgHtml 畫圖的下限（valid.length<3 就不畫）


def min2hm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def rrg_times(anchor: int = TMAX) -> tuple[list[tuple[int, str, str]], list[str]]:
    """完全比照 index.html 的 ovRrgTimes(anchor)：回 (samples, all)。
    samples＝[(分鐘, hm, lag_hm)]（由舊到新）；all＝去重後要抓 frame 的時點。"""
    samples: list[tuple[int, str, str]] = []
    seen: dict[str, None] = {}
    for i in range(NPT + ZEXT - 1, -1, -1):
        m = anchor - i * STEP
        if m - LAG < TMIN:
            continue
        hm, lag = min2hm(m), min2hm(m - LAG)
        samples.append((m, hm, lag))
        seen.setdefault(hm)
        seen.setdefault(lag)
    return samples, list(seen)


def get_json(url: str, retries: int = 3) -> dict:
    """GET＋輕量重試（Worker 錯誤一律 200＋{error}，這裡只擋網路層瞬斷）。同 archive_intraday。"""
    last = None
    for i in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"GET {url} 失敗：{last}")


def frame_amt(v) -> int | float:
    """frame 值 → 成交額（元）。比照 ovReplayBuild 的 `Array.isArray(f)?(f[0]||0):(+f||0)`。"""
    if isinstance(v, (list, tuple)):
        return v[0] or 0 if v else 0
    if isinstance(v, (int, float)):
        return v
    return 0


def agg_frame(stocks: dict, cmap: dict, universe, chains: list[str]) -> tuple[dict, dict, float]:
    """一格 frame → (shares, amtYi, mktYi)，口徑逐步比照 index.html 的 ovRrgAggFrame()。

    universe＝/live 的代號集合（ovAggBy 的走訪來源）；chains＝要輸出的鏈名（＝base 的鏈）。
    分母只看 frame（ovReplayBuild），分子多一層 universe 交集（ovAggBy）——不對稱是既有行為。
    """
    tot_twse = 0          # 整數加總：frame 的 amt 是元整數，部分和 <2^53，與 JS double 逐位相同
    for code, v in stocks.items():
        info = cmap.get(code)
        if info and info.get("t") == "twse":
            tot_twse += frame_amt(v)
    mkt_yi = tot_twse / 1e8
    agg: dict[str, int] = {}
    for code in universe:
        v = stocks.get(code)
        if v is None:
            continue                      # ovVal(c) 取不到 → ovAggBy 的 `if(!v)continue`
        info = cmap.get(code)
        if not info or info.get("t") != "twse":
            continue
        amt = frame_amt(v)
        for name in set(info.get("c") or []):     # 依鏈去重（多對多），同 `new Set(names)`
            agg[name] = agg.get(name, 0) + amt
    shares: dict[str, float] = {}
    amt_yi: dict[str, float] = {}
    if mkt_yi > 0:
        for name in chains:
            a = agg.get(name, 0) / 1e8            # 同 JS：先 /1e8 再除以 mktYi
            amt_yi[name] = a
            shares[name] = a / mkt_yi
    return shares, amt_yi, mkt_yi


def build(date: str, out_path: Path, base_path: Path | None = None) -> int:
    base_path = base_path or BASE
    for p in (CLASSIFY, base_path):
        if not p.exists():
            print(f"::error::找不到 {p}，無法產定格檔", file=sys.stderr)
            return 1
    cmap = json.loads(CLASSIFY.read_text(encoding="utf-8"))["map"]
    base = json.loads(base_path.read_text(encoding="utf-8"))
    btimes, bchains = base.get("times") or [], base.get("chains") or {}
    if not btimes or not bchains:
        print("::error::data/rrg_base.json 缺 times/chains，無法切片", file=sys.stderr)
        return 1
    bidx = {t: i for i, t in enumerate(btimes)}
    chains = sorted(bchains)

    samples, times = rrg_times()
    missing_t = [t for t in times if t not in bidx]
    if missing_t:
        print(f"::error::rrg_base.json 缺這些時點：{missing_t}（times 口徑改過？）", file=sys.stderr)
        return 1

    live = get_json(f"{WORKER}/live")
    universe = list((live.get("stocks") or {}).keys())
    if not universe:
        print("::error::/live 無 stocks，取不到 ovAggBy 的走訪代號集合", file=sys.stderr)
        return 1

    frames: dict[str, dict] = {}
    amts: dict[str, dict] = {}
    mkts: dict[str, float] = {}
    for t in sorted(times):
        f = get_json(f"{WORKER}/replay?date={date}&t={t}")
        stocks = f.get("stocks")
        if f.get("error") or not stocks:
            continue                                    # 該時點無 frame → 前端該取樣點自然失效
        sh, ay, mkt = agg_frame(stocks, cmap, universe, chains)
        if not sh:
            continue                                    # tseYi<=0（分母不成立）→ 視同無資料
        frames[t] = sh
        amts[t] = ay
        mkts[t] = mkt

    # 可用取樣點＝座標點與其 30 分前都有 frame（同前端 ovRrgCompute 的 valid 過濾）
    valid = [s for s in samples if s[1] in frames and s[2] in frames]
    if len(valid) < MIN_SAMPLES:
        print(f"{date}：可用取樣點 {len(valid)}/{len(samples)}（命中 {len(frames)}/{len(times)} 時點），"
              f"低於 {MIN_SAMPLES} → 不寫檔，保留前一版定格檔（正常退出）")
        return 0

    slice_base: dict[str, dict] = {}
    for t in sorted(times):
        i = bidx[t]
        col = {}
        for name in chains:
            arr = bchains.get(name) or []
            v = arr[i] if i < len(arr) else None
            if isinstance(v, (int, float)) and v > 0:    # 同 ovRrgBaseAt 的取值條件
                col[name] = v
        if col:
            slice_base[t] = col

    obj = {
        "date": date,
        "generated_at": datetime.now(TPE).isoformat(timespec="seconds"),
        "times": sorted(times),
        "frames": frames,
        "amt": amts,
        "mkt": mkts,
        "base": slice_base,
        "base_days": base.get("days") or [],
        "base_generated_at": base.get("generated_at"),
        "note": ("盤外定格：RRG 當日收盤（錨點 13:30）那組軌跡的**輸入**。"
                 "frames＝鏈層成交佔比（小數，口徑同前端 ovRrgAggFrame：個股層、依 classify 的 c "
                 "去重、只算 twse、分母 market.tse.amt_yi）；amt＝同口徑成交額（億）；"
                 "base＝產出當下 data/rrg_base.json 的同時點切片（**未含當日重算**）。"
                 "座標仍由前端 ovRrgCompute 計算，本檔不含任何座標。"),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    kb = out_path.stat().st_size / 1024
    print(f"{date}：命中 {len(frames)}/{len(times)} 時點、可用取樣點 {len(valid)}/{len(samples)}、"
          f"鏈 {len(chains)} 條（base days {','.join(obj['base_days'])}）")
    try:
        shown = out_path.relative_to(ROOT)
    except ValueError:
        shown = out_path.resolve()
    print(f"→ {shown}（{kb:.0f} KB）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="產 data/rrg_frozen.json（RRG 盤外定格輸入檔）")
    ap.add_argument("--date", default=datetime.now(TPE).strftime("%Y-%m-%d"),
                    help="定格日期（預設台北今日；KV TTL 2 天，只有近兩日有 frame）")
    ap.add_argument("--out", default=str(OUT), help="輸出路徑（預設 data/rrg_frozen.json）")
    # 補跑／bootstrap 用：切片必須取自「使用者當日盤中載到的那一版」base。排程走預設值即可
    # （intraday.yml 把本步排在 build rrg base 之前，當下的 data/rrg_base.json 本來就是那一版）；
    # 但事後補跑時它已被重算過，得用 git show <該日之前的 sha>:data/rrg_base.json 取出舊版再指過來。
    ap.add_argument("--base", default=None, help="指定 rrg_base.json（預設 data/rrg_base.json）")
    args = ap.parse_args()
    if len(args.date) != 10:
        print(f"date 格式需為 YYYY-MM-DD：{args.date}", file=sys.stderr)
        return 1
    return build(args.date, Path(args.out), Path(args.base) if args.base else None)


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    raise SystemExit(main())
