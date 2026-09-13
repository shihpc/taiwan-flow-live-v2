# src/archive_intraday.py — 盤中資料歸檔（第七期 7a）
#
# 動機：Worker KV frame TTL 僅 2 天、series 也非永久；不歸檔，盤中訊號回測（7b）就沒有原料。
# 排程：.github/workflows/intraday.yml 平日台北 14:10（收盤後、frame 尚在 TTL 內）＋ workflow_dispatch。
#
# 做法：
#   1. GET {WORKER}/replay?date=D（不帶 t）→ 全日市場分鐘序列 [{t,amt,idx,chg},...] 原樣保存。
#   2. 對 09:05–13:30 每 5 分鐘時點 GET /replay?date=D&t=HH:MM 取 frame
#      （{t,src_ts,stale,stocks:{code:[累計成交額(元),現價]}}；Worker 缺格自動往前回退 ≤5 分）。
#   3. 用 data/classify.json 的 p（[[產業鏈,次產業],...]）聚合出「次產業 × 時點」累積成交額矩陣。
#      口徑與 Worker computeFlow 一致：每檔對其 p 去重後的每個次產業各加一次（多對多）。
#      個股層級太大不存——回測主角本來就是次產業。
#   3b.（2026-09-13，D7②）同一批 frame 再算一份**前端 RRG 口徑的鏈層矩陣**＝欄位 cg／cmkt：
#      個股層、依 classify 的 c 去重、**只算 twse**、分子多一層 /live 代號交集、分母只看 frame。
#      ★ 實作**一律重用 src/build_rrg_frozen.py 的 agg_frame()**（該函式已與 index.html 的
#        ovReplayBuild／ovAggBy／ovRrgAggFrame 逐位 parity，見 G1 12 時點×47 鏈實測），
#        **嚴禁在本檔另寫一份口徑**——家族已在 taiwan-flows parity.py、postmkt augmentLending
#        上踩過三次「同一口徑兩份實作」的漂移。
#      為什麼要多存這一份：上面第 3 條的次產業層**含上櫃／興櫃／彙總碼**，與前端 RRG 的分母
#      差 3.4 倍（2026-09-11 實測 23,824 億 vs 7,038 億），回聚合重建鏈層後端到端實測
#      oddRaw 逐鏈判定 45% 翻面、象限 49% 不同（Kendall 一致率 0.42，0.5＝亂數）——
#      也就是 OV_RRG_ODDMAX／OV_RRG_CLOSE 的鏈層依據**用既有欄位複跑不出來**。
#      **過去的日子無法回補**（KV frame TTL 2 天），新欄位只從本次上線後的班次起算。
#   4. 輸出 data/intraday/YYYY-MM-DD.json（欄名精簡，既有欄位實測 <300KB；新增 cg／cmkt／cmeta
#      實測 +33,080 bytes＝**+11.2%**（294,570→327,650；量法＝真實的 2026-09-11 歸檔檔
#      ＋以 rrg_frozen.json 的真實鏈層金額按當日 total 比例重建的 47 鏈 × 54 時點矩陣——
#      **不是端到端真跑**，該日 frame 已過 KV 2 天 TTL，2026-09-13 實打 /replay 回「無盤中資料」），
#      仍遠低於 2MB 上限）。
#   5. 非交易日/frame 全缺，或命中率 <MIN_COVER → 印訊息 exit 0 不寫檔（優雅退出）；
#      個別時點缺格（但整體達標）→ 該時點記 null。
#      MIN_COVER 與下游 src/build_rrg_base.py、backtest/run_rrg.py 同口徑同命名（0.9）：
#      下游本來就會把低覆蓋率日檔剔除，這裡先擋住就不會產生「寫進 git 卻沒人用」的殘檔。
#      殘檔的來源實例：2026-07-18（週六手動首跑，KV 剛好殘留 1 格 frame → 命中 1/54 仍寫檔）。
#      務必維持 return 0（優雅退出）而非硬錯誤。理由不是「怕弄丟當日歸檔」——走到守門這條
#      分支，依定義就是「這天沒有可寫的有效歸檔」，改成非 0 一格資料也不會多丟；真正的理由是：
#      (a) 契約一致：同一函式對「沒東西可寫」的兩種情境（上面的 n_hit == 0 與這裡的低覆蓋率）
#          必須給同一個退出碼，否則 .github/workflows/intraday.yml 得對同一件事分兩種語意處理；
#      (b) 訊號不稀釋：非交易日（平日的國定假日照樣觸發 cron '10 6 * * 1-5'）與低覆蓋率都是
#          預期內結果，用紅燈表達會讓 intraday.yml 的失敗訊號失去鑑別力，真故障被淹沒。
#      附帶事實（不是理由）：非 0 會讓 archive 步驟紅燈（該步驟是裸 python、GH Actions 的
#      bash 帶 -e），後面 build rrg base 與 commit 兩步都被跳過；但這兩步在本分支本來就是
#      空轉（沒新檔 → 跳過 / no change），所以非 0 沒有任何實質收益，只有上述兩項代價。
#
# KV 讀量估算（寫給未來自己）：54 時點 × ≤6 get（缺格回退上限）＋ series 1 get ≈ ≤325 讀/日，
#   遠低於 Cloudflare KV 免費額度 10 萬讀/日；Worker 端另有 max-age=60 快取吸收重試。
#   3b 的鏈層欄位**不多打任何一格 frame**（只用迴圈裡已經抓到的那 54 格），只多一次
#   `GET /live` 取 ovAggBy 的走訪代號集合——與 src/build_rrg_frozen.py 同一支請求、同一用途。
#
# 用法：python src/archive_intraday.py [--date YYYY-MM-DD]（預設台北今日）

from __future__ import annotations
import argparse
import json
import sys
import time
import io
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_rrg_frozen import agg_frame  # noqa: E402  同口徑唯一事實來源，見檔頭做法 3b

ROOT = Path(__file__).resolve().parent.parent
WORKER = "https://taiwan-flow-v2.shihpc.workers.dev"
OUT_DIR = ROOT / "data" / "intraday"
TPE = timezone(timedelta(hours=8))
HEADERS = {"User-Agent": "archive-intraday/1.0"}
MIN_COVER = 0.9   # 時點命中率低於此就不歸檔（同 src/build_rrg_base.py、backtest/run_rrg.py）


def get_json(url: str, retries: int = 3) -> dict:
    """GET＋輕量重試（Worker 錯誤一律 200＋{error}，這裡只擋網路層瞬斷）。"""
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


def timepoints() -> list[str]:
    """09:05–13:30 每 5 分鐘，共 54 個時點。"""
    return [f"{m // 60:02d}:{m % 60:02d}" for m in range(9 * 60 + 5, 13 * 60 + 31, 5)]


def load_classify() -> dict:
    cl = json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))
    return cl["map"]


def chain_names(cmap: dict) -> list[str]:
    """鏈名全集＝classify 的 c 聯集（排序後）。

    刻意**不**綁 data/rrg_base.json 的 chains——那份會隨基準重算而變，歸檔檔要自我完備。
    """
    names: set[str] = set()
    for info in cmap.values():
        for n in (info.get("c") or []):
            names.add(n)
    return sorted(names)


def live_universe() -> list[str] | None:
    """ovAggBy 的走訪代號集合＝/live 的 stocks 鍵（同 build_rrg_frozen）。

    取不到就回 None → 呼叫端**優雅降級**：不寫 cg/cmkt，但既有歸檔照常完成。
    理由同檔頭「務必維持 return 0」：KV frame TTL 只有 2 天，當天沒 commit 就永久遺失，
    不能讓一個「加值欄位」的失敗把當日唯一一次歸檔機會賠掉。降級一律印 ::warning:: 留訊號。
    """
    try:
        live = get_json(f"{WORKER}/live")
    except Exception as e:  # noqa: BLE001
        print(f"::warning::/live 取不到（{e}）→ 本次不寫鏈層欄位 cg／cmkt，既有歸檔照常完成")
        return None
    codes = list((live.get("stocks") or {}).keys())
    if not codes:
        print("::warning::/live 回應無 stocks → 本次不寫鏈層欄位 cg／cmkt，既有歸檔照常完成")
        return None
    return codes


def build(date: str) -> int:
    cl = load_classify()
    series = get_json(f"{WORKER}/replay?date={date}").get("series") or []

    times = timepoints()
    frames_meta: list[dict | None] = []   # 各時點實際命中 frame 的 {t, stale}；缺格 = None
    total: list[int | None] = []          # 各時點全市場累積成交額合計（元）
    nstk: list[int | None] = []           # 各時點 frame 內個股數（sanity 用）
    groups: dict[str, list[int | None]] = {}   # 次產業 → 各時點累積成交額（元）
    n_hit = 0
    # ---- 前端 RRG 口徑的鏈層矩陣（做法 3b）：與上面的次產業層並存，口徑完全不同 ----
    chains = chain_names(cl)
    universe = live_universe()                     # None＝降級，不寫 cg/cmkt
    cg: dict[str, list[float | None]] = {n: [] for n in chains} if universe else {}
    cmkt: list[float | None] = []                  # 各時點 TSE 分母（億，＝ovReplayBuild 的 mkt.tseYi）
    n_chain = 0

    for i, t in enumerate(times):
        f = get_json(f"{WORKER}/replay?date={date}&t={t}")
        stocks = f.get("stocks")
        if f.get("error") or not stocks:
            frames_meta.append(None)
            total.append(None)
            nstk.append(None)
            for arr in groups.values():
                arr.append(None)
            if universe:
                for arr in cg.values():
                    arr.append(None)
                cmkt.append(None)
            continue
        n_hit += 1
        frames_meta.append({"t": f.get("t"), "stale": 1 if f.get("stale") else 0})
        tot = 0
        cnt = 0
        agg: dict[str, int] = {}
        for code, v in stocks.items():
            if not isinstance(v, (list, tuple)) or not v or v[0] is None:
                continue
            amt = v[0]
            tot += amt
            cnt += 1
            info = cl.get(code)
            if not info or not info.get("p"):
                continue
            for sname in {p[1] for p in info["p"]}:   # 口徑同 Worker computeFlow（去重多對多）
                agg[sname] = agg.get(sname, 0) + amt
        total.append(round(tot))
        nstk.append(cnt)
        for sname, a in agg.items():
            # 既有次產業的陣列此刻長度是 i（前輪補到 i-1 為止），新出現的是空/更短——
            # 一律先補 None 到長度 i+1 再賦值。舊寫法只在 sname 不存在時建陣列，
            # 既有 sname 直接 groups[sname][i] 賦值必炸 IndexError（第二個命中時點起），
            # 導致 7a 上線後 07-20/07-21 排程 run 全 failure、07-18 僅因命中 1 格倖存。
            arr = groups.setdefault(sname, [])
            arr.extend([None] * (i + 1 - len(arr)))
            arr[i] = round(a)
        for sname, arr in groups.items():
            if len(arr) <= i:
                arr.append(None)
        if universe:
            # ★ 同一格 frame，交給 build_rrg_frozen.agg_frame() 算鏈層（本檔不自己算口徑）。
            #   mkt_yi<=0 時它回空 dict（分母不成立）→ 該時點一律記 None，不假裝 0。
            _sh, amt_yi, mkt_yi = agg_frame(stocks, cl, universe, chains)
            has = bool(amt_yi)
            for name, arr in cg.items():
                arr.append(amt_yi[name] if has else None)
            cmkt.append(mkt_yi if has else None)
            n_chain += 1 if has else 0

    if n_hit == 0:
        # 非交易日 / frame 全缺（TTL 已過或當日停班）→ 優雅退出，不寫檔
        print(f"{date}：全部 {len(times)} 個時點皆無 frame（series {len(series)} 筆）→ 不歸檔，正常退出")
        return 0

    need = -(-int(MIN_COVER * len(times) * 1000) // 1000)   # ceil(MIN_COVER × 時點數)，避開浮點誤差
    cover = n_hit / len(times)
    if cover < MIN_COVER:
        # 覆蓋率不足（非交易日手動 dispatch 但 KV 殘留零星 frame／frame 班或 KV 中途出事）
        # → 優雅退出不寫檔。寫了下游 build_rrg_base.py / run_rrg.py 也會以同一門檻剔除。
        print(f"{date}：命中 {n_hit}/{len(times)} 時點（覆蓋率 {cover * 100:.1f}%），"
              f"低於門檻 MIN_COVER={MIN_COVER * 100:.0f}%（至少需 {need} 格）"
              f"→ 不歸檔（避免低覆蓋率殘檔，例：2026-07-18），正常退出")
        return 0

    out = {
        "date": date,
        "generated_at": datetime.now(TPE).isoformat(timespec="seconds"),
        "unit": "元",
        "series": series,          # 全日市場分鐘序列原樣（{t,amt,idx,chg}）
        "times": times,            # 54 個 5 分鐘時點
        "frames": frames_meta,     # 各時點實際命中的 frame 分鐘與 stale 旗標
        "total": total,            # 全市場累積成交額（含未分類個股）
        "nstk": nstk,              # frame 個股數
        "g": groups,               # 次產業 × 時點 累積成交額矩陣（回測主原料）
    }
    # ---- 鏈層欄位（做法 3b）：既有欄位一字不動，新欄位一律附加在最後 ----
    # 降級（/live 取不到）或整日無可用分母時整組不寫——**寧可缺欄位，也不寫半殘的**，
    # 下游看 "cg" in obj 就知道這天有沒有真口徑鏈層資料。
    if universe and n_chain:
        out["cg"] = cg                 # 鏈 → 各時點累積成交額（億，前端 RRG 口徑）
        out["cmkt"] = cmkt             # 各時點 TSE 分母（億，＝ovReplayBuild 的 mkt.tseYi）
        out["cmeta"] = {
            "unit": "億（1e8 元）",
            "chains": len(chains),
            "universe": len(universe),
            "hit": n_chain,
            "share": "cg[鏈][i] / cmkt[i]",
            "src": "src/build_rrg_frozen.py agg_frame()",
            "note": ("前端 RRG 口徑的鏈層成交額（**與 g 的次產業層口徑完全不同，不可混用**）："
                     "個股層、依 classify 的 c 去重（多對多）、只算 twse；分子多一層 /live "
                     "代號交集（ovAggBy），分母只看 frame（ovReplayBuild）——不對稱是前端既有行為。"
                     "share 由 cg[鏈][i]/cmkt[i] 還原，那與 agg_frame 內部的 a/mkt_yi 是同一個運算"
                     "（同兩個 double、同一次除法），故逐位相同；刻意不另存一份 share 省體積。"
                     "值為 null＝該時點無 frame 或分母不成立（不是 0）。"),
        }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{date}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    kb = path.stat().st_size / 1024
    ctxt = (f"、鏈層 {n_chain}/{n_hit} 格（{len(chains)} 條鏈）" if ("cg" in out)
            else "、鏈層未寫入（/live 取不到代號集合或分母全不成立）")
    print(f"{date}：命中 {n_hit}/{len(times)} 時點、{len(groups)} 個次產業{ctxt}、"
          f"series {len(series)} 筆 → {path.name}（{kb:.0f} KB）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.now(TPE).strftime("%Y-%m-%d"),
                    help="歸檔日期（預設台北今日；KV TTL 2 天，只有近兩日有 frame）")
    args = ap.parse_args()
    if not len(args.date) == 10:
        print(f"date 格式需為 YYYY-MM-DD：{args.date}", file=sys.stderr)
        return 1
    return build(args.date)


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    raise SystemExit(main())
