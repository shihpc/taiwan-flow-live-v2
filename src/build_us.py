# src/build_us.py — 台股開盤前「昨夜美股速覽」→ data/us.json
#
# 內容：與台股連動高的美股指數/個股 價量變動 + 台股 ADR 溢價
#   groups: 指數(4) / 台股ADR(3, 含溢價%) / AI·半導體(8) / 大型科技(6)
#   每列: s(代號) n(中文名) c(收盤) chg(漲跌%) vr(量比=當日量/前5日均量) amp(振幅%=(H-L)/前收)
#   ADR 溢價% = (ADR收盤×USDTWD) / (台股收盤×換股比) - 1
# 排程：美股收盤(台北凌晨4/5點)後、台股開盤前 07:30 台北跑（us.yml）
#
# 用法：FINMIND_TOKEN=... python src/build_us.py

from __future__ import annotations
import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fin  # noqa: E402

OUT = fin.ROOT / "data" / "us.json"

# (代號, 中文名)；ADR: (代號, 中文名, 台股代號, 換股比=1ADR折合台股股數)
GROUPS = [
    ("指數", [("^GSPC", "S&P 500"), ("^IXIC", "那斯達克"), ("^DJI", "道瓊"), ("^SOX", "費城半導體")]),
    ("台股ADR", [("TSM", "台積電ADR", "2330", 5), ("UMC", "聯電ADR", "2303", 5), ("ASX", "日月光ADR", "3711", 2)]),
    ("AI／半導體", [("NVDA", "輝達"), ("AMD", "超微"), ("AVGO", "博通"), ("QCOM", "高通"),
                  ("INTC", "英特爾"), ("MU", "美光"), ("AMAT", "應用材料"), ("ASML", "艾司摩爾")]),
    ("大型科技", [("AAPL", "蘋果"), ("MSFT", "微軟"), ("TSLA", "特斯拉"), ("META", "Meta"),
                ("GOOGL", "Google"), ("AMZN", "亞馬遜"), ("ORCL", "甲骨文")]),
]
# 註：SMCI/SNDK/SPCX/DRAM/COIN/USO 移為前端「自選」預設（使用者可自行刪增）。


def fv(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def us_rows(tic: str) -> list:
    start = (date.today() - timedelta(days=25)).isoformat()
    return fin.api_get("USStockPrice", data_id=tic, start_date=start)


def latest_metrics(rows: list) -> dict | None:
    """由日線列算 收盤/漲跌%/量比/振幅%。"""
    rows = [r for r in rows if fv(r.get("Close"))]
    if len(rows) < 2:
        return None
    cur, prev = rows[-1], rows[-2]
    c, pc = fv(cur["Close"]), fv(prev["Close"])
    hi, lo = fv(cur.get("High")), fv(cur.get("Low"))
    vols = [fv(r.get("Volume")) or 0 for r in rows[-6:-1]]
    v5 = sum(vols) / len(vols) if vols else 0
    vol = fv(cur.get("Volume")) or 0
    return dict(date=cur["date"], c=c, chg=round((c / pc - 1) * 10000) / 100,
                vr=round(vol / v5 * 100) / 100 if (v5 and vol) else None,
                amp=round((hi - lo) / pc * 10000) / 100 if (hi is not None and lo is not None) else None)


def tw_close(code: str) -> float | None:
    start = (date.today() - timedelta(days=10)).isoformat()
    rows = fin.api_get("TaiwanStockPrice", data_id=code, start_date=start)
    return fv(rows[-1]["close"]) if rows else None


def usdtwd() -> float | None:
    start = (date.today() - timedelta(days=10)).isoformat()
    rows = fin.api_get("TaiwanExchangeRate", data_id="USD", start_date=start)
    for r in reversed(rows):
        b, s = fv(r.get("spot_buy")), fv(r.get("spot_sell"))
        if b and s and b > 0 and s > 0:
            return (b + s) / 2
    return None


def brief(groups) -> str:
    """70 字內規則式盤勢分析：大盤定調→費半→台積ADR→開盤含義→極端個股（空間夠才放）。"""
    g = {x["g"]: x["rows"] for x in groups}
    idx = {r["s"]: r for r in g.get("指數", [])}
    sp, nq, dj, sox = idx.get("^GSPC"), idx.get("^IXIC"), idx.get("^DJI"), idx.get("^SOX")
    adr = {r["s"]: r for r in g.get("台股ADR", [])}
    t = adr.get("TSM")
    parts = []
    chgs = [r["chg"] for r in (sp, nq, dj) if r]
    if chgs:
        up = sum(1 for c in chgs if c > 0.15)
        dn = sum(1 for c in chgs if c < -0.15)
        tone = "美股收漲" if up == len(chgs) else "美股收跌" if dn == len(chgs) else "美股漲跌互見"
        if max(abs(c) for c in chgs) >= 2:
            tone = tone.replace("收", "大")
        parts.append(tone)
    if sox:
        s = f"費半{sox['chg']:+.1f}%"
        if sox["chg"] <= -3:
            s += "重挫"
        elif sox["chg"] >= 3:
            s += "大漲"
        parts.append(s)
    if t:
        s = f"台積ADR{t['chg']:+.1f}%"
        if t.get("prem") is not None:
            s += f"(溢價{t['prem']:+.0f}%)"
        parts.append(s)
    if sox and t:
        bias = sox["chg"] * 0.6 + t["chg"] * 0.4
        parts.append("電子開盤偏空" if bias <= -1 else "電子開盤偏多" if bias >= 1 else "電子開盤中性")
    stocks = g.get("AI／半導體", []) + g.get("大型科技", [])
    if stocks:
        w = max(stocks, key=lambda r: abs(r["chg"]))
        if abs(w["chg"]) >= 5:
            parts.append(f"{w['n']}{w['chg']:+.1f}%{'領跌' if w['chg'] < 0 else '領漲'}")
    out = ""
    for p in parts:  # 依優先序湊滿 70 字
        cand = (out + "，" + p) if out else p
        if len(cand) + 1 > 70:
            break
        out = cand
    return out + "。"


def main():
    fx = usdtwd()
    us_date = None
    groups = []
    for gname, items in GROUPS:
        rows = []
        for it in items:
            tic, name = it[0], it[1]
            try:
                m = latest_metrics(us_rows(tic))
            except Exception as e:
                print(f"{tic} 失敗: {e}", flush=True)
                m = None
            if not m:
                continue
            us_date = max(us_date or m["date"], m["date"])
            row = {"s": tic, "n": name, "c": m["c"], "chg": m["chg"], "vr": m["vr"], "amp": m["amp"], "d": m["date"]}
            if len(it) == 4 and fx:  # ADR：算溢價
                twc = tw_close(it[2])
                if twc:
                    row["prem"] = round((m["c"] * fx / (twc * it[3]) - 1) * 10000) / 100
                    row["tw"] = it[2]
            rows.append(row)
            print(f"{tic} {m['date']} {m['chg']:+.2f}%", flush=True)
        groups.append({"g": gname, "rows": rows})
    from datetime import datetime, timezone
    out = {"date": us_date, "fx": round(fx, 3) if fx else None,
           "generated_at": datetime.now(timezone.utc).isoformat(),
           "brief": brief(groups), "groups": groups}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n = sum(len(g["rows"]) for g in groups)
    print(f"us.json: 美股日期 {us_date}, {n} 檔, USDTWD={out['fx']}")


if __name__ == "__main__":
    main()
