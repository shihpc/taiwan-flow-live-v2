#!/usr/bin/env python3
# tools/measure_live_swr.py — `/live` stale-while-revalidate 比例的手動量測（2026-09-30）
#
# 目的：替「`LIVE_TTL` 15 → 25／30」這個一次性決策收集數字（CLAUDE.md「已知限制／坑」第 6 條）。
# 只讀、不寫任何檔案、不需要任何 secret；由 `.github/workflows/measure-live-swr.yml`
# （只有 workflow_dispatch）或本機直接跑。
#
# 每輪：GET `/live` N 次（預設 5 次、間隔 3 秒），記錄 `x-swr`／`x-gen`／狀態碼／耗時；
# 再 GET 一次 `/livediag` 取 `swr` 欄位（worker `liveSwrStats()`）。
#
# 判讀規則（照 CLAUDE.md 第 6 條，不另創口徑）：
#   ① stale 佔比＝staleHits / (staleHits + freshHits)
#   ② 合併率　 ＝coalesced / rebuilds
#   - `/livediag` 回應**沒有 `swr` 欄位**＝被節流（30 秒/次、每 isolate 每台北日 60 次），丟棄。
#   - 計數全 0 的輪＝落在冷 isolate，丟棄、**不可當成比例＝0 平均進去**。
#   - 分母為 0 時比例回 None（不是 0）。
#   - ⚠ 選擇偏誤：留下的只是「診斷請求剛好落在忙碌 isolate」的輪，比例只能當量級看。
#   - `swr` 是 **isolate 級累計快照**（isolate 重啟歸零、多 isolate 各自一份），同一 isolate
#     被連續抓到時前後輪會重複計入，所以**不把各輪計數相加**，只列逐輪比例與其中位數。
#   - `/live` 回應的 `x-swr` 標頭分布是 runner 自己看到的，與 isolate 計數**分開列**、不混算。
#   - 只有台北平日 09:00–13:30 的樣本有代表性；窗外預設只量一輪並標註無代表性（`--force` 照設定跑）。
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

DEFAULT_BASE = "https://taiwan-flow-v2.shihpc.workers.dev"
TPE = timezone(timedelta(hours=8))
SWR_KEYS = ("rebuilds", "rebuildFails", "staleHits", "freshHits", "misses", "coalesced")
MIN_INTERVAL_SEC = 30          # `/livediag` 節流 30 秒/次（worker DIAG_MIN_GAP_MS）
MAX_ROUNDS = 14
MAX_TOTAL_SEC = 55 * 60        # workflow timeout 60 分，留 5 分餘裕
SELECTION_BIAS_WARNING = (
    "⚠ 選擇偏誤：isolate 計數比例只含「有抓到非零計數」的輪（全 0 與被節流的輪已丟棄），"
    "代表的是診斷請求剛好落在忙碌 isolate 時的比例、不是全隊平均；只能當量級看。"
)


# ---------------------------------------------------------------- 純函式（離線可測）
def ratio(num, den):
    """num/den；分母為 0 或任一值非數字時回 None（不是 0）。"""
    try:
        num = float(num)
        den = float(den)
    except (TypeError, ValueError):
        return None
    if den == 0:
        return None
    return round(num / den, 4)


def classify_diag(status, body):
    """把一次 `/livediag` 回應分類。

    回 dict：kind ∈ {"ok","zero","throttled","error"}，ok／zero 另帶 swr（只取計數鍵）。
    - 非 2xx 或 body 不是 JSON 物件 → error
    - JSON 沒有 `swr` 欄位（或不是物件）→ throttled（worker 節流時回應不含 swr）
    - swr 各計數全 0 → zero（冷 isolate）
    """
    if status is None or not (200 <= int(status) < 300):
        return {"kind": "error", "reason": f"HTTP {status}"}
    try:
        j = json.loads(body) if isinstance(body, (str, bytes, bytearray)) else body
    except (ValueError, TypeError):
        return {"kind": "error", "reason": "body 不是 JSON"}
    if not isinstance(j, dict):
        return {"kind": "error", "reason": "body 不是 JSON 物件"}
    swr = j.get("swr")
    if not isinstance(swr, dict):
        reason = j.get("reason") or j.get("error") or "無 swr 欄位"
        return {"kind": "throttled", "reason": str(reason)[:120]}
    counts = {}
    for k in SWR_KEYS:
        v = swr.get(k, 0)
        counts[k] = v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0
    kind = "zero" if all(counts[k] == 0 for k in SWR_KEYS) else "ok"
    return {"kind": kind, "swr": counts}


def round_ratios(swr):
    return {
        "stale_share": ratio(swr.get("staleHits", 0), swr.get("staleHits", 0) + swr.get("freshHits", 0)),
        "coalesce_rate": ratio(swr.get("coalesced", 0), swr.get("rebuilds", 0)),
    }


def _stats(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return {"n": 0, "median": None, "min": None, "max": None}
    return {"n": len(vals), "median": round(statistics.median(vals), 4),
            "min": min(vals), "max": max(vals)}


def summarize(rounds):
    """rounds：[{ "live": [{"status","x_swr","x_gen","ms"}...], "diag": classify_diag(...) }, ...]

    回彙總 dict（詳見檔頭判讀規則）。
    """
    kinds = {"ok": 0, "zero": 0, "throttled": 0, "error": 0}
    kept = []
    for i, r in enumerate(rounds):
        d = r.get("diag") or {"kind": "error"}
        kinds[d.get("kind", "error")] = kinds.get(d.get("kind", "error"), 0) + 1
        if d.get("kind") == "ok":
            kept.append({"round": i + 1, "swr": d["swr"], **round_ratios(d["swr"])})
    hdr = {"fresh": 0, "stale": 0, "miss": 0, "other": 0, "error": 0}
    live_ms = []
    for r in rounds:
        for x in r.get("live") or []:
            st = x.get("status")
            if st is None or not (200 <= int(st) < 300):
                hdr["error"] += 1
                continue
            v = (x.get("x_swr") or "").strip().lower()
            hdr[v if v in ("fresh", "stale", "miss") else "other"] += 1
            if x.get("ms") is not None:
                live_ms.append(x["ms"])
    hdr_ok = hdr["fresh"] + hdr["stale"] + hdr["miss"]
    return {
        "rounds_total": len(rounds),
        "rounds_kept": len(kept),
        "rounds_discarded": {"zero": kinds["zero"], "throttled": kinds["throttled"], "error": kinds["error"]},
        "isolate": {
            "per_round": kept,
            "stale_share": _stats([k["stale_share"] for k in kept]),
            "coalesce_rate": _stats([k["coalesce_rate"] for k in kept]),
        },
        "runner_x_swr": {**hdr, "stale_share_of_hits": ratio(hdr["stale"], hdr["stale"] + hdr["fresh"]),
                         "n_ok": hdr_ok,
                         "live_ms_median": round(statistics.median(live_ms), 1) if live_ms else None},
    }


def in_market_window(now_tpe):
    """台北平日 09:00 ≤ t < 13:30。"""
    if now_tpe.weekday() >= 5:
        return False
    hm = now_tpe.hour * 60 + now_tpe.minute
    return 9 * 60 <= hm < 13 * 60 + 30


def render_text(summary, meta):
    L = []
    L.append("=== /live SWR 量測摘要 ===")
    L.append(f"base={meta['base']}  開始(台北)={meta['started_tpe']}  窗內={meta['in_window']}"
             f"  代表性={'有' if meta['representative'] else '無（非台北平日 09:00–13:30 或輪數被縮減）'}")
    L.append(f"輪數：共 {summary['rounds_total']}，採計 {summary['rounds_kept']}，丟棄 "
             f"全0={summary['rounds_discarded']['zero']} 節流={summary['rounds_discarded']['throttled']} "
             f"錯誤={summary['rounds_discarded']['error']}")
    iso = summary["isolate"]
    L.append("[isolate 計數，/livediag swr；各輪為累計快照、不相加]")
    for k in iso["per_round"]:
        s = k["swr"]
        L.append(f"  第{k['round']}輪 stale佔比={k['stale_share']} 合併率={k['coalesce_rate']}"
                 f"  (stale={s['staleHits']} fresh={s['freshHits']} miss={s['misses']}"
                 f" rebuilds={s['rebuilds']} coalesced={s['coalesced']} fails={s['rebuildFails']})")
    for name, key in (("stale 佔比", "stale_share"), ("合併率", "coalesce_rate")):
        st = iso[key]
        L.append(f"  {name}：n={st['n']} 中位數={st['median']} 範圍=[{st['min']}, {st['max']}]")
    rx = summary["runner_x_swr"]
    L.append("[runner 自己看到的 /live x-swr 標頭分布（與 isolate 計數分開）]")
    L.append(f"  fresh={rx['fresh']} stale={rx['stale']} miss={rx['miss']} other={rx['other']}"
             f" error={rx['error']}  stale/(stale+fresh)={rx['stale_share_of_hits']}"
             f"  耗時中位數={rx['live_ms_median']}ms")
    L.append(SELECTION_BIAS_WARNING)
    if summary["rounds_kept"] == 0:
        L.append("⚠ 沒有任何一輪抓到非零計數：本次沒有可用的 isolate 比例（不是比例＝0）。")
    return "\n".join(L)


# ---------------------------------------------------------------- 網路（可注入）
def http_get(url, timeout=20):
    """回 (status, headers_lower_dict, body_bytes, elapsed_ms)；連線失敗 status=None。"""
    req = urllib.request.Request(url, headers={"User-Agent": "measure-live-swr/1.0",
                                               "Cache-Control": "no-cache"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return r.status, {k.lower(): v for k, v in r.headers.items()}, body, (time.monotonic() - t0) * 1000
    except urllib.error.HTTPError as e:
        body = e.read() if hasattr(e, "read") else b""
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, body, (time.monotonic() - t0) * 1000
    except Exception as e:  # noqa: BLE001 — 量測工具：任何例外都記成一次失敗、不中斷
        return None, {"_error": f"{type(e).__name__}: {str(e)[:160]}"}, b"", (time.monotonic() - t0) * 1000


def run(args, get=http_get, sleep=time.sleep, now=lambda: datetime.now(TPE), log=print):
    base = args.base.rstrip("/")
    start = now()
    in_window = in_market_window(start)
    rounds_n = args.rounds
    if not in_window:
        msg = "台北時間不在平日 09:00–13:30，樣本無代表性"
        if not args.force:
            rounds_n = 1
            msg += "；未帶 --force，只量一輪"
        log(f"::warning::{msg}")
    representative = in_window and rounds_n == args.rounds
    rounds = []
    for i in range(rounds_n):
        if i > 0:
            sleep(args.interval_sec)
        live = []
        for j in range(args.live_per_round):
            if j > 0:
                sleep(args.live_gap_sec)
            st, h, _body, ms = get(f"{base}/live")
            live.append({"status": st, "x_swr": h.get("x-swr"), "x_gen": h.get("x-gen"),
                         "ms": round(ms, 1), **({"err": h["_error"]} if "_error" in h else {})})
        st, h, body, _ms = get(f"{base}/livediag")
        diag = classify_diag(st, body) if st is not None else {"kind": "error", "reason": h.get("_error")}
        rounds.append({"live": live, "diag": diag})
        log(f"第{i + 1}/{rounds_n}輪 {now().strftime('%H:%M:%S')} x-swr="
            f"{[x['x_swr'] for x in live]} livediag={diag['kind']}")
    summary = summarize(rounds)
    meta = {"base": base, "started_tpe": start.strftime("%Y-%m-%d %H:%M:%S"), "in_window": in_window,
            "representative": representative, "rounds_requested": args.rounds, "rounds_run": rounds_n}
    return summary, meta, rounds


def build_parser():
    p = argparse.ArgumentParser(description="量測 /live SWR 比例（只讀、不寫檔、免 secret）")
    p.add_argument("--rounds", type=int, default=8)
    p.add_argument("--interval-sec", type=int, default=240)
    p.add_argument("--base", default=DEFAULT_BASE)
    p.add_argument("--live-per-round", type=int, default=5)
    p.add_argument("--live-gap-sec", type=float, default=3.0)
    p.add_argument("--force", action="store_true", help="非台北盤中也照設定輪數跑（結果仍標無代表性）")
    return p


def validate(args):
    if not (1 <= args.rounds <= MAX_ROUNDS):
        return f"--rounds 須在 1..{MAX_ROUNDS}"
    if args.interval_sec < MIN_INTERVAL_SEC:
        return f"--interval-sec 須 ≥ {MIN_INTERVAL_SEC}（/livediag 節流 30 秒/次）"
    if not (1 <= args.live_per_round <= 20):
        return "--live-per-round 須在 1..20"
    total = (args.rounds - 1) * args.interval_sec + args.rounds * args.live_per_round * (args.live_gap_sec + 20)
    if total > MAX_TOTAL_SEC:
        return f"預估最長耗時 {int(total)} 秒超過 {MAX_TOTAL_SEC} 秒（workflow timeout 60 分）"
    if not args.base.startswith("https://"):
        return "--base 須為 https:// URL"
    return None


def main(argv=None):
    args = build_parser().parse_args(argv)
    err = validate(args)
    if err:
        print(f"::error::{err}")
        return 2
    summary, meta, _rounds = run(args)
    print()
    print(render_text(summary, meta))
    print("JSON " + json.dumps({"meta": meta, "summary": summary}, ensure_ascii=False, separators=(",", ":")))
    rx = summary["runner_x_swr"]
    if rx["n_ok"] == 0:
        print("::error::所有 /live 請求都失敗")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
