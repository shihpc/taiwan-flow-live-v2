# backtest/run_indicators.py — 技術/籌碼候選指標回測（決定湧入/退出頁要不要加、加哪些）
#
# 候選（技術4+籌碼3，全部由既有快取可算）：
#   ma    站上20日均線        close > MA20
#   brk   突破20日新高        close > max(close[t-19..t-1])
#   bias  乖離率(20日)        close/MA20-1（分桶）
#   volt  量能趨勢            mean(amt,5) / mean(amt,20)
#   fi3   外資近3日≥2日買超
#   both  土洋同買            投信≥2日 且 外資≥2日
#   ints  法人買超強度        (投信+外資淨買股數×close)/當日成交額
# 檢定：
#   A 獨立：全樣本（過流動性）有 vs 無 → T+3 對大盤超額
#   B 疊加：湧入訊號(爆量2x+漲2%+收高)、退出訊號(爆量+跌+收低) 內部 有 vs 無
#
# 用法：python backtest/run_indicators.py → 印表 + 寫 backtest/report_indicators.md

from __future__ import annotations
import gzip
import json
import statistics as st
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "backtest" / "cache"
LIQ = 1e8


def rgz(p):
    return json.loads(gzip.decompress(p.read_bytes()))


def fv(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
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
    n = len(days)
    tx = [fv((price[d].get("_TAIEX") or [None]*5)[4]) for d in days]

    codes = set()
    for d in days:
        codes.update(c for c in price[d] if c != "_TAIEX" and not c.startswith("00"))

    samples = []
    for c in codes:
        amt, hi, lo, cl = [], [], [], []
        for d in days:
            r = price[d].get(c)
            amt.append(fv(r[0]) if r else None)
            hi.append(fv(r[2]) if r else None)
            lo.append(fv(r[3]) if r else None)
            cl.append(fv(r[4]) if r else None)
        for t in range(25, n - 3):
            a, c0, pc = amt[t], cl[t], cl[t-1]
            if not a or a < LIQ or not c0 or not pc or not cl[t+3] or not tx[t] or not tx[t+3]:
                continue
            win5 = [x for x in amt[t-5:t] if x]
            if len(win5) < 5:
                continue
            a5 = sum(win5) / 5
            cw = [x for x in cl[t-19:t+1] if x]
            aw = [x for x in amt[t-19:t+1] if x]
            if len(cw) < 15 or len(aw) < 15:
                continue
            ma20 = sum(cw) / len(cw)
            prev_high = max((x for x in cl[t-19:t] if x), default=None)
            prev_low = min((x for x in cl[t-19:t] if x), default=None)
            h, l = hi[t], lo[t]
            if h is None or l is None:
                continue
            ret = c0 / pc - 1
            pos = (c0 - l) / (h - l) if h > l else 1.0
            iv = inst[days[t]].get(c) or [0, 0]
            it3 = fi3 = 0
            for k in (0, 1, 2):
                vv = inst[days[t-k]].get(c) or [0, 0]
                if vv[0] > 0:
                    it3 += 1
                if vv[1] > 0:
                    fi3 += 1
            e3 = (cl[t+3] / c0 - 1) - (tx[t+3] / tx[t] - 1)
            samples.append(dict(
                surge=a / a5 if a5 else 0, ret=ret, pos=pos,
                lim=(ret >= 0.095 and h == c0), limd=(ret <= -0.095 and l == c0),
                ma=c0 > ma20, bias=c0 / ma20 - 1,
                brk=(prev_high is not None and c0 > prev_high),
                brkd=(prev_low is not None and c0 < prev_low),
                volt=(sum(aw[-5:]) / 5) / (sum(aw) / len(aw)),
                it3=it3, fi3=fi3,
                ints=((iv[0] + iv[1]) * c0) / a if a else 0.0,
                e3=e3,
            ))

    def stat(rows):
        if len(rows) < 50:
            return None
        return dict(n=len(rows),
                    beat=sum(1 for r in rows if r["e3"] > 0) / len(rows) * 100,
                    avg=st.mean(r["e3"] for r in rows) * 100,
                    med=st.median(r["e3"] for r in rows) * 100)

    def fmt(name, s):
        if not s:
            return f"{name:30s} (樣本<50)"
        return f"{name:30s} N={s['n']:6d}  T+3勝大盤{s['beat']:5.1f}%  超額avg{s['avg']:+6.2f}% med{s['med']:+6.2f}%"

    lines = [f"# 候選技術/籌碼指標回測（{days[0]} ~ {days[-1]}，樣本 {len(samples):,}）", ""]

    def block(title, pairs):
        lines.append(f"## {title}")
        print(f"## {title}")
        for name, rows in pairs:
            l = fmt(name, stat(rows))
            print(l); lines.append(l)
        print(); lines.append("")

    S = samples
    block("A. 獨立效果（全樣本，T+3 對大盤超額）", [
        ("全樣本", S),
        ("站上20MA", [r for r in S if r["ma"]]),
        ("　20MA之下", [r for r in S if not r["ma"]]),
        ("突破20日新高", [r for r in S if r["brk"]]),
        ("跌破20日新低", [r for r in S if r["brkd"]]),
        ("乖離>+10%（過熱）", [r for r in S if r["bias"] > 0.10]),
        ("乖離 0~+10%", [r for r in S if 0 <= r["bias"] <= 0.10]),
        ("乖離<-10%（超跌）", [r for r in S if r["bias"] < -0.10]),
        ("量能趨勢>1.5", [r for r in S if r["volt"] > 1.5]),
        ("　量能趨勢<0.7", [r for r in S if r["volt"] < 0.7]),
        ("外資近3日≥2買", [r for r in S if r["fi3"] >= 2]),
        ("　外資0買", [r for r in S if r["fi3"] == 0]),
        ("土洋同買(投信≥2&外資≥2)", [r for r in S if r["it3"] >= 2 and r["fi3"] >= 2]),
        ("法人買強度>5%", [r for r in S if r["ints"] > 0.05]),
        ("法人賣強度<-5%", [r for r in S if r["ints"] < -0.05]),
    ])

    sig_in = [r for r in S if r["surge"] >= 2 and r["ret"] >= 0.02 and r["pos"] >= 0.7 and not r["lim"]]
    block("B1. 疊加在【湧入訊號】上（基準超額約-0.5%，看誰能翻正）", [
        ("湧入訊號(基準)", sig_in),
        ("＋站上20MA", [r for r in sig_in if r["ma"]]),
        ("＋突破20日新高", [r for r in sig_in if r["brk"]]),
        ("＋乖離<+10%(未過熱)", [r for r in sig_in if r["bias"] < 0.10]),
        ("＋乖離>+10%(已過熱)", [r for r in sig_in if r["bias"] >= 0.10]),
        ("＋量能趨勢>1.5", [r for r in sig_in if r["volt"] > 1.5]),
        ("＋外資≥2買", [r for r in sig_in if r["fi3"] >= 2]),
        ("＋土洋同買", [r for r in sig_in if r["it3"] >= 2 and r["fi3"] >= 2]),
        ("＋法人買強度>5%", [r for r in sig_in if r["ints"] > 0.05]),
        ("＋投信≥2買(既有旗標)", [r for r in sig_in if r["it3"] >= 2]),
    ])

    sig_out = [r for r in S if r["surge"] >= 2 and r["ret"] <= -0.02 and r["pos"] <= 0.3 and not r["limd"]]
    block("B2. 疊加在【退出訊號】上（基準超額約-0.6%，看誰讓續弱更確定）", [
        ("退出訊號(基準)", sig_out),
        ("＋20MA之下", [r for r in sig_out if not r["ma"]]),
        ("＋跌破20日新低", [r for r in sig_out if r["brkd"]]),
        ("＋法人賣強度<-5%", [r for r in sig_out if r["ints"] < -0.05]),
        ("＋外資≥2賣(fi3==0且淨賣)", [r for r in sig_out if r["ints"] < 0 and r["fi3"] == 0]),
        ("＋量能趨勢>1.5", [r for r in sig_out if r["volt"] > 1.5]),
    ])

    (ROOT / "backtest" / "report_indicators.md").write_text("\n".join(lines), encoding="utf-8")
    print("已寫 backtest/report_indicators.md")


if __name__ == "__main__":
    main()
