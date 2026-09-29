# src/build_rrg_base.py — 產 data/rrg_base.json（盤中輪動雷達 RRG 的「同時點基準表」）
#
# 動機：RRG 的 X 軸 RS_Ratio_i(t) = 100 × share_i(t) / base_i(t)，base 是該產業鏈
#   「前 K 個交易日**同一時點**的資金佔比平均」（docs/rrg-spec-20260809.md §4）。
#   分母不能在前端現算——那要打 K×54 次 /replay，KV 讀取額度撐不住；
#   故離線預算成一張小表隨站部署，前端只載入一個檔。
#
# 排程：.github/workflows/intraday.yml，接在 archive_intraday 產出當日檔之後跑
#   （平日台北 14:10），與 data/intraday/ 同一次 commit，收尾 dispatch pages.yml
#   才會真正部署到 GitHub Pages（GITHUB_TOKEN 的 push 不觸發 workflow，見 baseline.yml:46）。
#
# ── 口徑（這段是本檔最容易踩雷的地方，改前務必讀完）─────────────────────────
# 前端 share_i(t) 的口徑是：**個股層、依 classify 的 `c` 去重、只算 twse、
# 分母 market.tse.amt_yi**（規格 §4 的 ovAggBy(null, info=>info.c||[])）。
# 而 data/intraday 的 `g` 只有**次產業層**且含上櫃：
#   (a) 同一檔股票在同一條鏈底下橫跨多個次產業時會被重複計數
#       （classify 的 3873 組 (股票,鏈) 有 1179 組是同鏈多 sub）；
#   (b) `total` 是全市場（含 tpex/emerging），不是 TSE。
# 直接拿 g/total 當 base，實測與前端口徑的比值在 **0.15~3.08 倍**之間（對照
# data/daysummary/*.json 的 chain_top5/chain_bot3，那是前端口徑的權威值）——
# 那會讓每條鏈的 RS_Ratio 永久偏離 100（例：軟體服務恆在 ~308、體驗科技恆在 ~15），
# 象限判讀整個失真。因此本檔採**水準 × 形狀**分解：
#
#   base_i(t) = level_i × mean_d[ shape_i(d,t) ]
#     level_i  = 前端口徑的鏈佔比水準，來自 data/baseline.json 的 `a5`
#                （個股前 5 交易日平均成交額）：Σ_{twse 且 i∈c(s)} a5(s) ÷ Σ_{twse} a5(s)
#                實測 vs daysummary：半導體 41.8% vs 41.4%、通信網路 17.3% vs 17.9%、
#                軟體服務 4.34% vs 4.4% —— 對得上，可當水準基準。
#     shape_i(d,t) = 該日該鏈的 share(t) ÷ 同日終盤 share，來自 intraday 的 g/total
#                （次產業均分到鏈，口徑同 backtest/run_rrg_topn.py:65）。
#                重複計數與分母口徑在這個「同日比值」裡會約掉，只留下日內時間形狀。
#   → 依定義 base_i(終盤) = level_i，與前端口徑一致；日內各時點由 intraday 的形狀推回。
# ──────────────────────────────────────────────────────────────────────
#
# 做法：
#   1. 掃 data/intraday/YYYY-MM-DD.json，只收「時點覆蓋率 ≥90%」的有效交易日，取最近 K 天。
#      （守門口徑同 backtest/run_rrg.py 的 MIN_COVER；例：2026-07-18 的 total 僅 1/54 格
#       有值，屬殘檔，必須剔除，否則形狀會被單格資料汙染。）
#   2. classify 的 p（[[產業鏈,次產業],...]）→ 次產業 → 產業鏈對照；跨多鏈的次產業
#      （484 個中 19 個，如「其他」「原材料」）金額均分到各鏈。
#   3. 算各日各時點的鏈 share，再除以同日終盤 share 得 shape，對 K 天取平均。
#   4. 乘上 baseline.json 推出的 level，輸出
#      {generated_at, days, times, chains:{鏈名:[各時點 base share...]}}。
#      share 是小數（0.418 ＝ 41.8%），保留 6 位有效位數壓體積（實測數十 KB）。
#
# 局限：
#   - level 用 a5（前 5 交易日**日線**平均額）當代理，與 intraday 的 5 天不完全同窗
#     （baseline.json 在盤後才更新，14:10 跑時它是前一日的版本）；level 是慢變量，可接受。
#   - shape 沿用 intraday 的近似（stale 格未剔除、鏈層多對多均分），見 report_rrg.md「局限」。
#   - 這張表只是「相對自身近期基準」的分母，不含任何價格方向的預測意涵。
#
# 用法：python src/build_rrg_base.py [--k 5] [--out data/rrg_base.json]
#   離線、免 FinMind token，只讀專案內檔案。有效交易日不足 MIN_DAYS 天、或 baseline.json
#   缺失時報錯並以非零 exit code 結束（寧可不更新，也不產出半殘／口徑錯的基準表）。

from __future__ import annotations
import argparse
import io
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import twse_holidays  # noqa: E402  休市日判定唯一一份（行事曆消費端，fail-open）

ROOT = Path(__file__).resolve().parent.parent
INTRADAY = ROOT / "data" / "intraday"
CLASSIFY = ROOT / "data" / "classify.json"
BASELINE = ROOT / "data" / "baseline.json"
OUT = ROOT / "data" / "rrg_base.json"
TPE = timezone(timedelta(hours=8))

K_DEFAULT = 5      # 基準交易日數（report_rrg.md：K=3 分母趨零會爆值，K=5 為建議值）
MIN_COVER = 0.9    # 日檔至少要有 90% 時點有市場總額才算有效交易日（同 run_rrg.py）
MIN_DAYS = 3       # 有效日少於此 → 報錯不寫檔
MIN_SHAPE_DAYS = 2  # 某鏈某時點至少要幾天有 shape 才給值
SIGDIG = 6         # share 保留位數（有效位數）


def load_classify() -> dict:
    return json.loads(CLASSIFY.read_text(encoding="utf-8"))["map"]


def sub2chains_of(cmap: dict) -> dict[str, list[str]]:
    """{次產業: [產業鏈,...]}（來源 classify.json 的 p）。"""
    m: dict[str, set[str]] = defaultdict(set)
    for v in cmap.values():
        for chain, sub in (v.get("p") or []):
            m[sub].add(chain)
    return {k: sorted(v) for k, v in m.items()}


def chain_levels(cmap: dict) -> dict[str, float]:
    """前端口徑的鏈佔比水準：個股層、依 c 去重、只算 twse、a5 加權。"""
    stocks = json.loads(BASELINE.read_text(encoding="utf-8"))["stocks"]
    lv: dict[str, float] = defaultdict(float)
    tot = 0.0
    for code, row in stocks.items():
        a5 = (row[0] if row else 0) or 0
        info = cmap.get(code)
        if not a5 or not info or info.get("t") != "twse":
            continue
        tot += a5
        for ch in (info.get("c") or []):
            lv[ch] += a5
    if tot <= 0:
        return {}
    return {c: v / tot for c, v in lv.items()}


def load_days(k: int, cal=None) -> tuple[list[dict], list[tuple[str, float]]]:
    """回傳 (最近 k 個有效日檔（舊→新）, 被剔除的殘檔 [(date, cover)])。

    cal＝twse_holidays.load() 的結果（None＝fail-open 只排週末）。休市日的檔一律剔除
    （2026-09-29 補：09-25／09-28 假歸檔覆蓋率 100%，MIN_COVER 擋不住；歸檔端已不再寫，
    這裡再擋一次防既有殘檔或手動補跑回流），在 dropped 裡記 cover=-1 以示區別。
    """
    valid, dropped = [], []
    for f in sorted(INTRADAY.glob("????-??-??.json")):
        if twse_holidays.is_closed(f.stem, cal):
            dropped.append((f.stem, -1.0))
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        tot = d.get("total") or []
        cover = (sum(1 for v in tot if v) / len(tot)) if tot else 0.0
        if cover < MIN_COVER:
            dropped.append((d.get("date") or f.stem, cover))
            continue
        valid.append(d)
    return valid[-k:], dropped


def day_shapes(day: dict, sub2chains: dict[str, list[str]], T: int) -> dict[str, list[float | None]]:
    """單日 {產業鏈: [各時點 share ÷ 同日終盤 share]}；缺格 / 終盤無值 → None。"""
    tot = day.get("total") or []
    g = day.get("g") or {}
    amt: dict[str, list[float]] = defaultdict(lambda: [0.0] * T)
    for sub, arr in g.items():
        chains = sub2chains.get(sub)
        if not chains or not arr:
            continue
        n = len(chains)
        for t in range(min(T, len(arr))):
            v = arr[t]
            if v:
                part = v / n          # 跨多鏈的次產業金額均分
                for c in chains:
                    amt[c][t] += part
    out: dict[str, list[float | None]] = {}
    for c, row in amt.items():
        sh = [(row[t] / tot[t]) if (t < len(tot) and tot[t]) else None for t in range(T)]
        ref = next((v for v in reversed(sh) if v), None)   # 終盤（最後一個有值的時點）
        if not ref:
            continue
        out[c] = [(v / ref) if v is not None else None for v in sh]
    return out


def sig(x: float, n: int = SIGDIG) -> float:
    return float(f"{x:.{n}g}")


def build(k: int, out_path: Path) -> int:
    for p in (CLASSIFY, BASELINE):
        if not p.exists():
            print(f"::error::找不到 {p}，無法建基準表", file=sys.stderr)
            return 1
    cmap = load_classify()
    sub2chains = sub2chains_of(cmap)
    levels = chain_levels(cmap)
    if not levels:
        print("::error::baseline.json 算不出任何 twse 鏈水準（a5 全空？）", file=sys.stderr)
        return 1

    days, dropped = load_days(k, twse_holidays.load())
    if len(days) < MIN_DAYS:
        print(f"::error::有效交易日僅 {len(days)} 天（<{MIN_DAYS}），資料不足以建基準表，不寫檔"
              f"（掃描 {INTRADAY}，剔除殘檔 {len(dropped)} 檔）", file=sys.stderr)
        return 1

    times = days[-1]["times"]
    T = len(times)
    for d in days:
        if d.get("times") != times:
            print(f"::error::{d.get('date')} 的 times 與最新日檔不一致，無法對齊同時點基準",
                  file=sys.stderr)
            return 1

    shapes = [day_shapes(d, sub2chains, T) for d in days]

    chains: dict[str, list[float | None]] = {}
    no_shape = []
    for c, lv in sorted(levels.items()):
        col: list[float | None] = []
        got = False
        for t in range(T):
            vals = [s[c][t] for s in shapes if c in s and s[c][t] is not None]
            if len(vals) >= MIN_SHAPE_DAYS:
                col.append(sig(lv * sum(vals) / len(vals)))
                got = True
            else:
                col.append(None)
        if got:
            chains[c] = col
        else:
            no_shape.append(c)

    obj = {
        "generated_at": datetime.now(TPE).isoformat(timespec="seconds"),
        "days": [d["date"] for d in days],
        "times": times,
        # 口徑備註寫進檔案，避免前端／未來的自己誤用（見檔頭「口徑」段）
        "note": ("base share＝前端口徑（個股層依 c 去重、只算 twse、分母 market.tse.amt_yi）"
                 "的鏈佔比水準 × intraday 推得的日內形狀；小數非百分比"),
        "chains": chains,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    kb = out_path.stat().st_size / 1024
    if dropped:
        print("剔除殘檔（時點覆蓋率 <%.0f%%，或休市日）：%s"
              % (MIN_COVER * 100, "、".join(f"{d}({'休市' if c < 0 else f'{c*100:.0f}%'})"
                                            for d, c in dropped)))
    if no_shape:
        print(f"無盤中形狀而略過 {len(no_shape)} 條鏈：{'、'.join(no_shape)}")
    top = sorted(((c, v[-1]) for c, v in chains.items() if v[-1] is not None),
                 key=lambda x: -x[1])[:5]
    print(f"採用 {len(days)} 個交易日：{', '.join(obj['days'])}")
    print(f"產業鏈 {len(chains)} 條 × 時點 {T} 個（{times[0]}~{times[-1]}）")
    print("終盤 base share Top5：" + "、".join(f"{c} {v*100:.2f}%" for c, v in top))
    # --out 指到 repo 外（驗證流程常用 /tmp/xxx.json）時 relative_to 會拋 ValueError，
    # 檔案其實早就寫成功了，卻讓收尾的 print 把整支腳本變成非零 exit code（誤判為失敗）。
    try:
        shown = out_path.relative_to(ROOT)
    except ValueError:
        shown = out_path.resolve()
    print(f"→ {shown}（{kb:.0f} KB）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="產 data/rrg_base.json（RRG 同時點基準表）")
    ap.add_argument("--k", type=int, default=K_DEFAULT, help=f"基準交易日數（預設 {K_DEFAULT}）")
    ap.add_argument("--out", default=str(OUT), help="輸出路徑（預設 data/rrg_base.json）")
    args = ap.parse_args()
    if args.k < MIN_DAYS:
        print(f"--k 需 ≥{MIN_DAYS}", file=sys.stderr)
        return 1
    return build(args.k, Path(args.out))


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    raise SystemExit(main())
