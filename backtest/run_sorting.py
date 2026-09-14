#!/usr/bin/env python3
# backtest/run_sorting.py — 圖卡體系多空排序驗證（7 項）
#
# R1 大盤 Regime 調節 / M1-M3 多方排序 / S1-S3 空方排序
# 沿用 fetch.py 快取，所有欄位定義源自 run.py + run_indicators.py + run_sector.py
#
# 用法：python backtest/run_sorting.py → 印表 + 寫 backtest/report_sorting.md

from __future__ import annotations
import gzip, json, statistics as st
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "backtest" / "cache"
LIQ = 1e8
SEC_AMT_MIN = 10e8
MIN_MEMBERS = 5
# 排序欄的最大平手率上限：超過此值視為「無有效變異」，不得作為排序欄。
MAX_TIE_RATE = 0.50


def rgz(p):
    return json.loads(gzip.decompress(p.read_bytes()))


def fv(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ── 資料載入 ──────────────────────────────────────────────
def load():
    days, price, inst = [], {}, {}
    for pf in sorted(CACHE.glob("price_*.json.gz")):
        d = rgz(pf)
        if not d:
            continue
        ds = pf.stem.replace("price_", "").replace(".json", "")
        days.append(ds)
        price[ds] = d
        f2 = CACHE / f"inst_{ds}.json.gz"
        inst[ds] = rgz(f2) if f2.exists() else {}
    cl = json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))["map"]
    return days, price, inst, cl


# ── 個股樣本建構（全部指標，擴充版 run_indicators.py）──────
def build_stock_samples(days, price, inst):
    n = len(days)
    tx = [fv((price[d].get("_TAIEX") or [None] * 5)[4]) for d in days]

    tx_ma20 = [None] * n
    for t in range(19, n):
        vals = [x for x in tx[t - 19:t + 1] if x]
        tx_ma20[t] = sum(vals) / len(vals) if len(vals) >= 15 else None

    codes = set()
    for d in days:
        codes.update(c for c in price[d] if c != "_TAIEX" and not c.startswith("00"))
    # 固定迭代順序：set 的走訪順序依 PYTHONHASHSEED 每個 process 隨機，會透過
    # stock_samples 的順序傳遞到 quintile() 的穩定排序，讓平手樣本的分組隨機化。
    # 詳見 docs/line-cards-spec.md 第 8 節。
    codes = sorted(codes)

    stock_ts = {}
    for c in codes:
        amt, hi, lo, cl = [], [], [], []
        for d in days:
            r = price[d].get(c)
            amt.append(fv(r[0]) if r else None)
            hi.append(fv(r[2]) if r else None)
            lo.append(fv(r[3]) if r else None)
            cl.append(fv(r[4]) if r else None)
        stock_ts[c] = (amt, hi, lo, cl)

    # 退出訊號旗標（用於連續退出日數）
    exit_flag = {}
    for c in codes:
        amt, hi, lo, cl = stock_ts[c]
        for t in range(5, n):
            a, c0, pc = amt[t], cl[t], cl[t - 1] if t > 0 else None
            if not a or a < LIQ or not c0 or not pc:
                continue
            h, l_ = hi[t], lo[t]
            if h is None or l_ is None:
                continue
            w = [x for x in amt[t - 5:t] if x]
            if len(w) < 5:
                continue
            a5 = sum(w) / 5
            if not a5:
                continue
            ret = c0 / pc - 1
            pos = (c0 - l_) / (h - l_) if h > l_ else 1.0
            limd = ret <= -0.095 and l_ == c0
            exit_flag[(c, t)] = (a / a5 >= 2 and ret <= -0.02 and pos <= 0.3 and not limd)

    consec_exit = {}
    for c in codes:
        streak = 0
        for t in range(5, n):
            if exit_flag.get((c, t), False):
                streak += 1
                consec_exit[(c, t)] = streak
            else:
                streak = 0

    samples = []
    for c in codes:
        amt, hi, lo, cl = stock_ts[c]
        for t in range(25, n - 3):
            a, c0, pc = amt[t], cl[t], cl[t - 1]
            if not a or a < LIQ or not c0 or not pc:
                continue
            if not cl[t + 1] or not cl[t + 2] or not cl[t + 3]:
                continue
            if not tx[t] or not tx[t + 1] or not tx[t + 2] or not tx[t + 3]:
                continue
            w = [x for x in amt[t - 5:t] if x]
            if len(w) < 5:
                continue
            a5 = sum(w) / 5
            if not a5:
                continue
            h, l_ = hi[t], lo[t]
            if h is None or l_ is None:
                continue
            cw = [x for x in cl[t - 19:t + 1] if x]
            aw = [x for x in amt[t - 19:t + 1] if x]
            if len(cw) < 15 or len(aw) < 15:
                continue
            ma20 = sum(cw) / len(cw)
            prev_high = max((x for x in cl[t - 19:t] if x), default=None)
            prev_low = min((x for x in cl[t - 19:t] if x), default=None)
            ret = c0 / pc - 1
            pos = (c0 - l_) / (h - l_) if h > l_ else 1.0
            surge = a / a5
            iv = inst[days[t]].get(c) or [0, 0]
            it3 = fi3 = 0
            for k in (0, 1, 2):
                vv = inst[days[t - k]].get(c) or [0, 0]
                if vv[0] > 0:
                    it3 += 1
                if vv[1] > 0:
                    fi3 += 1
            ints_val = ((iv[0] + iv[1]) * c0) / a if a else 0.0
            bias = c0 / ma20 - 1
            volt_denom = sum(aw) / len(aw) if aw else 0
            volt = (sum(aw[-5:]) / 5) / volt_denom if volt_denom else 0
            mkt = [tx[t + k] / tx[t] - 1 for k in (1, 2, 3)]
            fwd = [cl[t + k] / c0 - 1 for k in (1, 2, 3)]
            regime = "bull" if tx_ma20[t] and tx[t] > tx_ma20[t] else "bear"
            lim = ret >= 0.095 and h == c0
            limd = ret <= -0.095 and l_ == c0

            samples.append(dict(
                d=days[t], c=c,
                surge=surge, ret=ret, pos=pos, amt=a,
                r1=fwd[0], r2=fwd[1], r3=fwd[2],
                e1=fwd[0] - mkt[0], e2=fwd[1] - mkt[1], e3=fwd[2] - mkt[2],
                lim=lim, limd=limd,
                it3=it3, fi3=fi3, ints=ints_val,
                ma=c0 > ma20, bias=bias,
                brk=(prev_high is not None and c0 > prev_high),
                brkd=(prev_low is not None and c0 < prev_low),
                volt=volt, regime=regime,
                break_depth=((prev_low - c0) / prev_low if prev_low and c0 < prev_low else None),
                trust_buy_amt=iv[0] * c0 / 1000,
                foreign_buy_amt=iv[1] * c0 / 1000,
                consec_exit=consec_exit.get((c, t), 0),
            ))
    return samples, tx, tx_ma20


# ── 次產業樣本建構（擴充版 run_sector.py，含連續湧入日數）──
def build_sector_samples(days, price, cl_map):
    n = len(days)
    tx = [fv((price[d].get("_TAIEX") or [None] * 5)[4]) for d in days]
    tx_ma20 = [None] * n
    for t in range(19, n):
        vals = [x for x in tx[t - 19:t + 1] if x]
        tx_ma20[t] = sum(vals) / len(vals) if len(vals) >= 15 else None

    members = {}
    for c, info in cl_map.items():
        if c.startswith("00") or info.get("t") not in ("twse", "tpex"):
            continue
        for p in info.get("p", []):
            if len(p) >= 2:
                members.setdefault(p[1], set()).add(c)
    members = {k: v for k, v in members.items() if len(v) >= MIN_MEMBERS}

    codes_all = set().union(*members.values())
    cls_ = {c: [fv(price[d].get(c, [None] * 5)[4]) if price[d].get(c) else None for d in days]
            for c in codes_all}
    amt_ = {c: [fv(price[d].get(c, [None] * 5)[0]) if price[d].get(c) else None for d in days]
            for c in codes_all}

    mkt_tot = []
    for d in days:
        mkt_tot.append(sum(fv(r[0]) or 0 for c, r in price[d].items()
                           if c != "_TAIEX" and not c.startswith("00")))

    sec_share = {}
    for sec, mem in members.items():
        share = [0.0] * n
        for t in range(n):
            share[t] = (sum(amt_[c][t] or 0 for c in mem) / mkt_tot[t]) if mkt_tot[t] else 0.0
        sec_share[sec] = share

    # 連續湧入日數（C≥1.5 R≥1%）
    consec_surge = {}
    for sec, mem in members.items():
        share = sec_share[sec]
        streak = 0
        for t in range(5, n):
            a_now = share[t] * mkt_tot[t] if mkt_tot[t] else 0
            if a_now < SEC_AMT_MIN:
                streak = 0
                continue
            base = sum(share[t - 5:t]) / 5
            if base <= 0:
                streak = 0
                continue
            conc = share[t] / base
            rets = [cls_[c][t] / cls_[c][t - 1] - 1
                    for c in mem if cls_[c][t] and cls_[c][t - 1]]
            if len(rets) < MIN_MEMBERS:
                streak = 0
                continue
            if conc >= 1.5 and st.mean(rets) >= 0.01:
                streak += 1
                consec_surge.setdefault(sec, {})[t] = streak
            else:
                streak = 0

    samples = []
    for sec, mem in members.items():
        share = sec_share[sec]
        for t in range(5, n - 3):
            a_now = share[t] * mkt_tot[t] if mkt_tot[t] else 0
            if a_now < SEC_AMT_MIN:
                continue
            base = sum(share[t - 5:t]) / 5
            if base <= 0:
                continue
            conc = share[t] / base
            rets, fwd1, fwd3 = [], [], []
            for c in mem:
                s = cls_[c]
                if s[t - 1] and s[t] and s[t + 1] and s[t + 3]:
                    rets.append(s[t] / s[t - 1] - 1)
                    fwd1.append(s[t + 1] / s[t] - 1)
                    fwd3.append(s[t + 3] / s[t] - 1)
            if len(rets) < MIN_MEMBERS:
                continue
            if not (tx[t] and tx[t + 1] and tx[t + 3]):
                continue
            m1, m3 = tx[t + 1] / tx[t] - 1, tx[t + 3] / tx[t] - 1
            regime = "bull" if tx_ma20[t] and tx[t] > tx_ma20[t] else "bear"
            samples.append(dict(
                d=days[t], sec=sec, conc=conc, ret=st.mean(rets),
                r1=st.mean(fwd1), r3=st.mean(fwd3),
                e1=st.mean(fwd1) - m1, e3=st.mean(fwd3) - m3,
                sticky=(share[t + 1] / base >= 1.2) if base > 0 else False,
                regime=regime,
                consec=consec_surge.get(sec, {}).get(t, 0),
            ))
    return samples


# ── 統計與格式化 ──────────────────────────────────────────
def stat(rows):
    if not rows:
        return None
    n = len(rows)
    return dict(
        n=n,
        w1=sum(1 for r in rows if r.get("r1", 0) > 0) / n * 100,
        w3=sum(1 for r in rows if r.get("r3", 0) > 0) / n * 100,
        we3=sum(1 for r in rows if r["e3"] > 0) / n * 100,
        e3_avg=st.mean(r["e3"] for r in rows) * 100,
        e3_med=st.median(r["e3"] for r in rows) * 100,
    )


def fmt(name, s):
    if not s:
        return f"{name:30s} (無樣本)"
    return (f"{name:30s} N={s['n']:6d}  T+1漲{s['w1']:5.1f}%  T+3漲{s['w3']:5.1f}%  "
            f"T+3勝大盤{s['we3']:5.1f}%  超額T+3 avg{s['e3_avg']:+6.2f}% med{s['e3_med']:+6.2f}%")


def fmt_dn(name, s):
    if not s:
        return f"{name:30s} (無樣本)"
    return (f"{name:30s} N={s['n']:6d}  T+3跌{100 - s['w3']:5.1f}%  "
            f"T+3輸大盤{100 - s['we3']:5.1f}%  超額T+3 avg{s['e3_avg']:+6.2f}% med{s['e3_med']:+6.2f}%")


def monthly(rows, fmt_fn, lines):
    by_m = {}
    for r in rows:
        by_m.setdefault(r["d"][:7], []).append(r)
    for m in sorted(by_m):
        lines.append(fmt_fn(f"  {m}", stat(by_m[m])))


# ── 五分位分析 ──────────────────────────────────────────
def max_tie_rate(rows, key):
    """該欄最大重複值的占比。1.0 = 全部同值，無任何排序資訊。"""
    vals = [r[key] for r in rows if r.get(key) is not None]
    if not vals:
        return None
    return Counter(vals).most_common(1)[0][1] / len(vals)


def quintile(rows, key, reverse=False, min_q=50):
    valid = [r for r in rows if r.get(key) is not None]
    valid.sort(key=lambda r: r[key], reverse=reverse)
    n = len(valid)
    if n < min_q * 3:
        return None
    # 平手率守門：分位切點若落在一大堆同值樣本裡，分組等於按輸入順序亂切，
    # 算出來的分離度是排序假象而非訊號。S2 的 consec_exit 有 98.2% 樣本值為 1（N=1378，分布 {1:1353, 2:23, 3:2}），
    # 曾產出 0.07~1.44% 的浮動「分離度」。回 None＝該欄不進候選（失效安全方向）。
    if max_tie_rate(valid, key) > MAX_TIE_RATE:
        return None
    if n < min_q * 5:
        k = n // 3
        groups = [valid[:k], valid[k:2 * k], valid[2 * k:]]
        labels = ["T1(前)", "T2", "T3(末)"]
        mode = "三分位"
    else:
        k = n // 5
        groups = [valid[:k], valid[k:2 * k], valid[2 * k:3 * k], valid[3 * k:4 * k], valid[4 * k:]]
        labels = ["Q1(前)", "Q2", "Q3", "Q4", "Q5(末)"]
        mode = "五分位"
    result = []
    for label, g in zip(labels, groups):
        if not g:
            continue
        gn = len(g)
        result.append(dict(
            label=label, n=gn,
            beat=sum(1 for r in g if r["e3"] > 0) / gn * 100,
            e3_avg=st.mean(r["e3"] for r in g) * 100,
            e3_med=st.median(r["e3"] for r in g) * 100,
            lo=g[0][key], hi=g[-1][key],
        ))
    avgs = [r["e3_avg"] for r in result]
    mono_up = all(avgs[i] <= avgs[i + 1] for i in range(len(avgs) - 1))
    mono_dn = all(avgs[i] >= avgs[i + 1] for i in range(len(avgs) - 1))
    return dict(
        groups=result, mode=mode, n=n,
        monotone=mono_up or mono_dn,
        direction="↑單調" if mono_up else ("↓單調" if mono_dn else "非單調"),
        spread=avgs[0] - avgs[-1] if avgs else 0,
    )


def _fval(v):
    if isinstance(v, int) or (isinstance(v, float) and v == int(v)):
        return str(int(v))
    return f"{v:.4f}"


def fmt_quintile(q, key_name, lines, rows=None, key=None):
    if not q:
        # 「樣本不足」與「無有效變異」是兩件事，理由不可共用同一條文案。
        tie = max_tie_rate(rows, key) if rows is not None and key else None
        if tie is not None and tie > MAX_TIE_RATE:
            lines.append(f"  排序：{key_name} — 無有效變異（最大平手率 {tie * 100:.1f}%"
                         f" > 上限 {MAX_TIE_RATE * 100:.0f}%），不列入候選")
        else:
            lines.append(f"  排序：{key_name} — 樣本不足，無法切分位")
        return
    lines.append(f"  排序：{key_name}（{q['mode']}，N={q['n']}）")
    for g in q["groups"]:
        lines.append(
            f"    {g['label']:8s} N={g['n']:5d}  勝大盤{g['beat']:5.1f}%  "
            f"超額avg{g['e3_avg']:+6.2f}% med{g['e3_med']:+6.2f}%  "
            f"[{_fval(g['lo'])}~{_fval(g['hi'])}]")
    lines.append(f"  → {q['direction']}  Q1−Q末超額差={q['spread']:+.2f}%")


# ── R1. 大盤 Regime 調節 ─────────────────────────────────
def run_r1(stock_samples, sector_samples, lines):
    lines.append("\n# R1. 大盤 Regime 調節（TAIEX 收盤 vs 自身 20MA）")
    bull_d = set(r["d"] for r in stock_samples if r["regime"] == "bull")
    bear_d = set(r["d"] for r in stock_samples if r["regime"] == "bear")
    all_d = bull_d | bear_d
    lines.append(f"多頭交易日 {len(bull_d)} 天（{len(bull_d) / len(all_d) * 100:.0f}%），"
                 f"空頭交易日 {len(bear_d)} 天（{len(bear_d) / len(all_d) * 100:.0f}%）\n")

    combos = [
        ("次產業湧入 C≥1.5 R≥1%", sector_samples,
         lambda r: r["conc"] >= 1.5 and r["ret"] >= 0.01),
        ("突破20日新高（個股）", stock_samples,
         lambda r: r["brk"] and not r["lim"]),
        ("乖離>+10% 過熱組", stock_samples,
         lambda r: r["bias"] > 0.10),
        ("跌破20日新低（個股）", stock_samples,
         lambda r: r["brkd"] and not r["limd"]),
        ("退出＋法人賣<-5%", stock_samples,
         lambda r: r["surge"] >= 2 and r["ret"] <= -0.02 and r["pos"] <= 0.3
                   and not r["limd"] and r["ints"] < -0.05),
        ("爆量大漲 S≥2 R≥2% P≥0.7", stock_samples,
         lambda r: r["surge"] >= 2 and r["ret"] >= 0.02 and r["pos"] >= 0.7 and not r["lim"]),
    ]

    tbl = []
    for name, pool, pred in combos:
        sb = stat([r for r in pool if r["regime"] == "bull" and pred(r)])
        se = stat([r for r in pool if r["regime"] == "bear" and pred(r)])
        lines.append(f"## {name}")
        lines.append(fmt("  多頭 regime", sb))
        lines.append(fmt("  空頭 regime", se))
        b_avg = sb["e3_avg"] if sb else None
        e_avg = se["e3_avg"] if se else None
        flipped = (b_avg is not None and e_avg is not None
                   and (b_avg > 0) != (e_avg > 0))
        lines.append(f"  超額翻向：{'是 ⚠' if flipped else '否'}\n")
        tbl.append((name, sb, se, flipped))

    lines.append("## Regime 翻向總表")
    lines.append(f"{'組合':<28s} {'多頭N':>6s} {'多頭avg':>8s} {'多頭med':>8s}"
                 f" {'空頭N':>6s} {'空頭avg':>8s} {'空頭med':>8s} {'翻向':>4s}")
    for name, sb, se, flp in tbl:
        def _c(s, k):
            return f"{s[k]:+.2f}%" if s else "N/A"
        def _n(s):
            return f"{s['n']}" if s else "N/A"
        lines.append(f"{name:<28s} {_n(sb):>6s} {_c(sb, 'e3_avg'):>8s} {_c(sb, 'e3_med'):>8s}"
                     f" {_n(se):>6s} {_c(se, 'e3_avg'):>8s} {_c(se, 'e3_med'):>8s}"
                     f" {'⚠' if flp else '':>4s}")
    lines.append("")


# ── R2. 土洋同買的 Regime 切分（補測，對應圖卡規格卡2）──────
# R1 的 6 組訊號不含土洋同買（M3 段沒做多空切分），規格因此把卡2 列為
# 「未驗證、不得外推不翻向」。這段就是補上那一格。
def run_r2(stock_samples, lines):
    lines.append("\n# R2. 土洋同買 Regime 切分（補測）")
    lines.append("R1 未涵蓋此組合（M3 段無多空切分），"
                 "依 docs/line-cards-spec.md 卡2 待驗證項補測。")
    lines.append("篩選：湧入訊號(S≥2 R≥2% P≥0.7)＋土洋同買(投信近3日≥2買 且 外資近3日≥2買)"
                 "——與 M3 同一母體")
    sig = [r for r in stock_samples
           if r["surge"] >= 2 and r["ret"] >= 0.02 and r["pos"] >= 0.7
           and not r["lim"] and r["it3"] >= 2 and r["fi3"] >= 2]
    bull = [r for r in sig if r["regime"] == "bull"]
    bear = [r for r in sig if r["regime"] == "bear"]
    sa, sb, se = stat(sig), stat(bull), stat(bear)
    lines.append(fmt("全環境（對照 M3 基準）", sa))
    lines.append(fmt("  多頭 regime", sb))
    lines.append(fmt("  空頭 regime", se))
    b_avg = sb["e3_avg"] if sb else None
    e_avg = se["e3_avg"] if se else None
    flipped = (b_avg is not None and e_avg is not None
               and (b_avg > 0) != (e_avg > 0))
    lines.append(f"  超額翻向：{'是 ⚠' if flipped else '否'}\n")

    if sb is None or se is None:
        lines.append("**結論**：多頭或空頭樣本不足，無法判定，卡2 維持「未驗證」")
    elif flipped:
        lines.append(f"**結論**：翻向 ⚠ 卡2 需掛 regime 閘門"
                     f"（多頭 avg{b_avg:+.2f}%、空頭 avg{e_avg:+.2f}%）")
    else:
        lines.append(f"**結論**：不翻向，卡2 不需 regime 閘門"
                     f"（多頭 avg{b_avg:+.2f}%、空頭 avg{e_avg:+.2f}%）")

    lines.append("\n### 多頭逐月")
    monthly(bull, fmt, lines)
    lines.append("\n### 空頭逐月")
    monthly(bear, fmt, lines)
    lines.append("")


# ── M1. 次產業湧入排序 ──────────────────────────────────
def run_m1(sector_samples, lines):
    lines.append("\n# M1. 次產業湧入排序")
    sig = [r for r in sector_samples if r["conc"] >= 1.5 and r["ret"] >= 0.01]
    lines.append(fmt("主組合 C≥1.5 R≥1%", stat(sig)))
    lines.append("")

    candidates = []
    for key, name, rev in [("conc", "C 值（集中度）", True),
                            ("ret", "R 值（當日等權漲幅）", True),
                            ("consec", "連續湧入日數", True)]:
        q = quintile(sig, key, reverse=rev)
        fmt_quintile(q, name, lines, sig, key)
        lines.append("")
        if q:
            candidates.append((name, abs(q["spread"]), q["monotone"], q["direction"]))

    if candidates:
        best = max(candidates, key=lambda x: x[1])
        lines.append(f"**結論**：排序欄位採用 **{best[0]}**"
                     f"（分離度 {best[1]:.2f}%，{best[3]}）")
    else:
        lines.append("**結論**：樣本不足，無法判定排序欄位")

    lines.append("\n### 主組合逐月")
    monthly(sig, fmt, lines)
    lines.append("")


# ── M2. 突破20日新高 ∩ 法人買強度>5% ────────────────────
def run_m2(stock_samples, lines):
    lines.append("\n# M2. 突破20日新高 ∩ 法人買強度>5%")
    brk_only = [r for r in stock_samples if r["brk"] and not r["lim"]]
    ints_only = [r for r in stock_samples if r["ints"] > 0.05]
    both = [r for r in stock_samples if r["brk"] and not r["lim"] and r["ints"] > 0.05]
    lines.append(fmt("僅突破20日新高", stat(brk_only)))
    lines.append(fmt("僅法人買強度>5%", stat(ints_only)))
    lines.append(fmt("交集（新高∩買強度>5%）", stat(both)))
    lines.append("")

    sb, si, sx = stat(brk_only), stat(ints_only), stat(both)
    if sx and sb and si:
        if sx["e3_avg"] <= sb["e3_avg"] or sx["e3_avg"] <= si["e3_avg"]:
            lines.append("⚠ 交集超額不優於單條件")
            lines.append("**結論**：陣亡，退回單條件版（僅突破20日新高）")
            target = brk_only
        else:
            q = quintile(both, "ints", reverse=True)
            fmt_quintile(q, "法人買強度", lines, both, "ints")
            # 這行原本無條件印出：即使 q 為 None（樣本不足或無有效變異）也宣告
            # 「排序依法人買強度」，與上一行剛印的降級說明自相矛盾。七個 quintile
            # 呼叫點中唯一不是失效安全的一處。
            if q:
                lines.append("**結論**：交集採用，排序依法人買強度")
            else:
                lines.append("**結論**：交集採用，但排序欄無法切分位，交集版不排序")
            target = both
    else:
        target = brk_only
        lines.append("(樣本不足以比較)")

    lines.append("\n### 逐月")
    monthly(target, fmt, lines)
    lines.append("")


# ── M4. 突破20日新高單條件版排序（補測，對應圖卡規格卡3）─────
# M2 交集版陣亡後規格退回單條件，但「單條件版該依什麼排序」從未驗證。
# 採用門檻 0.30% 是**動手前先訂**的判準（訂於 commit cd3ba22，早於 M4 數字產出），
# 避免事後挑一個好看的數字硬說有效。原始理由是「介於已採用的卡4 0.45% 與已否決的
# 卡5 0.17% 之間」，但卡5 那個 0.17% 事後查明不可重現（平手值分組，見 spec 第 8 節），
# 故該錨點作廢——門檻值本身不動，改以 commit 次序證明先訂後驗。
M4_MIN_SPREAD = 0.30


def run_m4(stock_samples, lines):
    lines.append("\n# M4. 突破20日新高單條件版排序（補測）")
    lines.append("M2 交集版陣亡後退回單條件，但單條件版排序欄未經驗證，"
                 "依 docs/line-cards-spec.md 卡3 待驗證項補測。")
    lines.append(f"候選排序欄為本次設計選擇（非 M2 結論）；"
                 f"採用門檻＝分離度 ≥{M4_MIN_SPREAD:.2f}%（先訂後驗）。")
    sig = [r for r in stock_samples if r["brk"] and not r["lim"]]
    lines.append(fmt("突破20日新高（排除漲停鎖死）", stat(sig)))
    lines.append("")

    # 「分位切不出來」與「切得出來但分離度為 0」是兩件事，不可共用同一條文案
    # （沿用 run_m1 的 candidates 寫法：只有 q 為真才進候選，空候選才叫樣本不足）
    candidates = []
    for key, name, rev in [("ints", "法人買強度", True),
                           ("volt", "量能趨勢", True),
                           ("bias", "乖離率", True)]:
        q = quintile(sig, key, reverse=rev)
        fmt_quintile(q, name, lines, sig, key)
        if q:
            candidates.append((abs(q["spread"]), name, q["monotone"]))
        lines.append("")

    if not candidates:
        lines.append("**結論**：三個候選的分位皆切不出來（樣本不足），卡3 不排序")
    else:
        best_spread, best_name, best_mono = max(candidates, key=lambda t: t[0])
        if best_spread < M4_MIN_SPREAD:
            lines.append(f"**結論**：最佳候選 **{best_name}** 分離度僅 "
                         f"{best_spread:.2f}%，未達先訂門檻 {M4_MIN_SPREAD:.2f}%"
                         f"，卡3 不排序")
        else:
            lines.append(f"**結論**：排序欄位採用 **{best_name}**（分離度 "
                         f"{best_spread:.2f}%，{'單調' if best_mono else '非單調'}）")

    lines.append("\n### 逐月")
    monthly(sig, fmt, lines)
    lines.append("")


# ── M3. 土洋同買排序（偏態診斷）─────────────────────────
def run_m3(stock_samples, lines):
    lines.append("\n# M3. 土洋同買排序（偏態診斷）")
    lines.append("篩選：湧入訊號(S≥2 R≥2% P≥0.7)＋土洋同買(投信近3日≥2買 且 外資近3日≥2買)")
    sig = [r for r in stock_samples
           if r["surge"] >= 2 and r["ret"] >= 0.02 and r["pos"] >= 0.7
           and not r["lim"] and r["it3"] >= 2 and r["fi3"] >= 2]
    lines.append(fmt("湧入＋土洋同買", stat(sig)))
    lines.append("")

    any_q1_pos = False
    best_key, best_name, best_med = None, None, -999
    for key, name, rev in [("trust_buy_amt", "投信當日買超金額", True),
                            ("foreign_buy_amt", "外資當日買超金額", True),
                            ("surge", "個股集中度分數 S", True)]:
        q = quintile(sig, key, reverse=rev)
        fmt_quintile(q, name, lines, sig, key)
        if q and q["groups"][0]["e3_med"] > 0:
            any_q1_pos = True
            lines.append(f"  → Q1 med 為正")
        if q and q["groups"][0]["e3_med"] > best_med:
            best_med = q["groups"][0]["e3_med"]
            best_key, best_name = key, name
        lines.append("")

    if any_q1_pos:
        lines.append(f"**結論**：排序採用 **{best_name}**（Q1 med={best_med:+.2f}%）")
    else:
        lines.append("**結論**：排序無效，此卡降級為不排序清單")

    lines.append("\n### 逐月")
    monthly(sig, fmt, lines)
    lines.append("")


# ── S1. 跌破20日新低分層排序 ─────────────────────────────
def run_s1(stock_samples, lines):
    lines.append("\n# S1. 跌破20日新低分層排序")
    yellow = [r for r in stock_samples if r["brkd"] and not r["limd"]]
    red = [r for r in stock_samples
           if r["brkd"] and not r["limd"]
           and r["surge"] >= 2 and r["ret"] <= -0.02 and r["pos"] <= 0.3]

    lines.append("## 黃色層（跌破20日新低，排除跌停鎖死）")
    lines.append(fmt_dn("跌破新低", stat(yellow)))
    lines.append("\n## 紅色層（跌破新低 且 爆量退出訊號）")
    lines.append(fmt_dn("紅色層", stat(red)))
    lines.append("")

    lines.append("## 黃色層排序五分位")
    candidates = []
    for key, name, rev in [("break_depth", "破底深度（越深越前）", True),
                            ("ints", "法人賣強度（越負越前）", False),
                            ("volt", "量能趨勢（越大越前）", True)]:
        q = quintile(yellow, key, reverse=rev)
        fmt_quintile(q, name, lines, yellow, key)
        lines.append("")
        if q:
            candidates.append((name, abs(q["spread"]), q["monotone"], q["direction"]))

    if candidates:
        best = max(candidates, key=lambda x: x[1])
        lines.append(f"**結論**：弱勢榜排序欄位採用 **{best[0]}**"
                     f"（分離度 {best[1]:.2f}%，{best[3]}）")
    else:
        # 平手率守門上線後這條路徑變得可達（三個候選可能全被擋）。
        # 沒有 else 的話整段不會有結論行，會同時打破煙霧測試與 CI 行號守門。
        lines.append("**結論**：三個候選皆無法切分位（樣本不足或無有效變異），弱勢榜不排序")

    lines.append("\n### 黃色層逐月")
    monthly(yellow, fmt_dn, lines)
    lines.append("")


# ── S2. 退出 ∩ 法人賣強度<-5% 排序 ──────────────────────
def run_s2(stock_samples, lines):
    lines.append("\n# S2. 退出 ∩ 法人賣強度<-5% 排序")
    lines.append("篩選：退出訊號(S≥2 R≤-2% P≤0.3)＋法人賣強度<-5%")
    lines.append(f"採用門檻＝分離度 ≥{M4_MIN_SPREAD:.2f}%，"
                 f"**沿用 M4 的先訂門檻、非為本段新訂**（見 M4_MIN_SPREAD 註解）。")
    sig = [r for r in stock_samples
           if r["surge"] >= 2 and r["ret"] <= -0.02 and r["pos"] <= 0.3
           and not r["limd"] and r["ints"] < -0.05]
    lines.append(fmt_dn("退出＋法人賣<-5%", stat(sig)))
    lines.append("")

    candidates = []
    for key, name, rev in [("ints", "法人賣強度（越負越前）", False),
                            ("consec_exit", "連續退出日數（越多越前）", True)]:
        q = quintile(sig, key, reverse=rev)
        fmt_quintile(q, name, lines, sig, key)
        lines.append("")
        if q:
            candidates.append((name, abs(q["spread"]), q["monotone"], q["direction"]))

    if candidates:
        best = max(candidates, key=lambda x: x[1])
        # 2026-09-14（使用者裁示 B1-1）：本段原本無採用門檻，對分離度 0.01% 的候選照樣
        # 宣告「採用」。生產端卡5 早就不排序（worker `fxCardExitSell` 註解「不排序
        # （回測：候選欄無效）」），所以補門檻只修報告文案、不動任何卡片的出現或排序。
        # 門檻**沿用** M4 既有的 M4_MIN_SPREAD（訂於 commit cd3ba22，早於 S2 這次檢視），
        # 不是看著 0.01% 回頭訂的——docs/line-cards-spec.md 第 8 節明文禁止事後挑選。
        if best[1] < M4_MIN_SPREAD:
            lines.append(f"**結論**：最佳候選 **{best[0]}** 分離度僅 {best[1]:.2f}%"
                         f"（{best[3]}），未達先訂門檻 {M4_MIN_SPREAD:.2f}%，卡5 不排序")
        else:
            lines.append(f"**結論**：排序欄位採用 **{best[0]}**"
                         f"（分離度 {best[1]:.2f}%，{best[3]}）")
    else:
        # 同 run_s1：守門上線後這條路徑可達，缺 else 會整段沒有結論行。
        lines.append("**結論**：兩個候選皆無法切分位（樣本不足或無有效變異），卡5 不排序")

    lines.append("\n### 逐月")
    monthly(sig, fmt_dn, lines)
    lines.append("")


# ── S3. 追高警示排序 ────────────────────────────────────
def run_s3(stock_samples, lines):
    lines.append("\n# S3. 追高警示排序（爆量大漲 S≥2.0 R≥2% P≥0.7，排除漲停鎖死）")
    sig = [r for r in stock_samples
           if r["surge"] >= 2 and r["ret"] >= 0.02 and r["pos"] >= 0.7 and not r["lim"]]
    lines.append(fmt("爆量大漲（排除漲停）", stat(sig)))
    lines.append("")

    q = quintile(sig, "surge", reverse=True)
    fmt_quintile(q, "S 值（越大越前＝越危險）", lines, sig, "surge")

    # 結論行必須由腳本產出：commit f46aaf8 當初是手改 report.md 補這行，
    # 重跑就會被洗掉（本次重跑即重現該回歸）。
    lines.append("")
    if not q:
        lines.append("**結論**：分位切不出來（樣本不足），追高警示卡不另設排序欄")
    elif q["direction"] == "↓單調":
        lines.append("**結論**：S 越高超額越負，驗證通過；S 值即為「危險度」排行依據")
    elif q["monotone"]:
        lines.append(f"**結論**：S 值排序為 {q['direction']}，方向與「S 越高 T+3 越負」"
                     "假設相反；追高警示卡不另設排序欄，統一以 S 值降序呈現。")
    else:
        lines.append("**結論**：S 值排序非單調，「S 越高 T+3 越負」假設不成立；"
                     "追高警示卡不另設排序欄，統一以 S 值降序呈現。")

    lines.append("\n### 逐月")
    monthly(sig, fmt, lines)
    lines.append("")


# ── 主程式 ──────────────────────────────────────────────
def main():
    print("載入快取資料...", flush=True)
    days, price, inst, cl = load()
    print(f"交易日 {len(days)} 天（{days[0]} ~ {days[-1]}）")

    print("建構個股樣本...", flush=True)
    stock_samples, tx, tx_ma20 = build_stock_samples(days, price, inst)
    print(f"個股 stock-day 樣本：{len(stock_samples):,}")

    print("建構次產業樣本...", flush=True)
    sector_samples = build_sector_samples(days, price, cl)
    print(f"次產業 sector-day 樣本：{len(sector_samples):,}")

    lines = [
        f"# 回測報告：圖卡體系多空排序驗證（9 項＝原 7 項 ＋ R2/M4 補測）",
        f"期間 {days[0]} ~ {days[-1]}（{len(days)} 交易日）"
        f"· 流動性 ≥ {LIQ / 1e8:.0f} 億 · 排除 ETF/興櫃",
        f"個股 stock-day 樣本：{len(stock_samples):,}",
        f"次產業 sector-day 樣本：{len(sector_samples):,}",
        "",
    ]

    print("\n--- R1 Regime ---", flush=True)
    run_r1(stock_samples, sector_samples, lines)
    print("--- R2 土洋同買 Regime（補測）---", flush=True)
    run_r2(stock_samples, lines)
    print("--- S1 跌破新低 ---", flush=True)
    run_s1(stock_samples, lines)
    print("--- M1 次產業排序 ---", flush=True)
    run_m1(sector_samples, lines)
    print("--- M2 新高∩法人買 ---", flush=True)
    run_m2(stock_samples, lines)
    print("--- M4 新高單條件排序（補測）---", flush=True)
    run_m4(stock_samples, lines)
    print("--- M3 土洋同買 ---", flush=True)
    run_m3(stock_samples, lines)
    print("--- S2 退出＋法人賣 ---", flush=True)
    run_s2(stock_samples, lines)
    print("--- S3 追高警示 ---", flush=True)
    run_s3(stock_samples, lines)

    lines.extend([
        "\n# 注意事項",
        "- 收盤對收盤報酬，未含交易成本/滑價；漲停/跌停鎖死另列。",
        "- 股價未除權息調整（7-8月除息季偏多），對超額報酬影響小但存在。",
        "- 個股名單以目前 classify 為準，期間內下市股不在樣本（輕微存活偏差）。",
        "- 五分位切分：N<250 改三分位並標註；切分依等分 index。",
        "- 連續日數計算：中間缺資料日（停牌/不過流動性門檻）視為中斷。",
        "- Regime 定義：TAIEX 收盤在自身 20 日均線之上＝多頭，之下＝空頭。",
        f"- M4 的採用門檻 {M4_MIN_SPREAD:.2f}% 是動手前先訂的判準（訂於 commit cd3ba22，"
        f"早於 M4 分位數字產出），非事後挑選；候選欄位亦為設計選擇非回測結論。"
        f"原始理由寫「介於卡4 0.45% 與卡5 0.17% 之間」，但卡5 的 0.17% 事後查明"
        f"不可重現（見 docs/line-cards-spec.md 第 8 節），故此處改以 commit 次序為憑；"
        f"門檻值本身未動。",
        "- R2/M4 為 2026-07-26 補測項：R2 補 R1 未涵蓋的土洋同買多空切分（規格卡2），"
        "M4 補 M2 陣亡後單條件版的排序欄（規格卡3）。",
    ])

    out = ROOT / "backtest" / "report_sorting.md"
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n已寫 {out}")


if __name__ == "__main__":
    main()
