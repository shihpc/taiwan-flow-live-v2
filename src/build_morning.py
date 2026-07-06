# src/build_morning.py — 台股晨報 → data/morning.json（06:20 台北，開盤前）
#
# 區塊（②隔夜美股由前端直讀 us.json，不在此檔）：
#   gap     ①開盤參考：台指期夜盤(次一交易日標記, after_market, 近月=最大量) vs 現貨收盤
#   exdiv   ③今日焦點：除權息名單（TaiwanStockDividendResult date=今日；以5日均額排序取前10）
#   recap   ④昨日備忘：加權收盤/漲跌、昨湧/昨退次產業(subs_y)、昨湧/昨退個股數(y1)
#   chips   ⑤籌碼速覽：三大法人整體買賣超、投信3日連買 top、主動ETF摘要(讀 aetf/diff.json)
#   signals ⑥驗證訊號：連湧次產業(y1&y2, 回測:今日平均續強)、昨湧單日、雙確認候選(∩AETF加碼)
#   news    ⑦相關新聞：訊號股+AETF同買股+權值前5 的隔夜新聞（去重/排論壇/每股≤2/共≤10）
#           視窗=上一個有效交易日(TAIEX最近收盤日)14:00 → 現在；週一/連假後自動涵蓋整段空窗
#
# 用法：FINMIND_TOKEN=... python src/build_morning.py

from __future__ import annotations
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fin  # noqa: E402

ROOT = fin.ROOT
OUT = ROOT / "data" / "morning.json"
TPE = timezone(timedelta(hours=8))


def jload(p, default=None):
    try:
        return json.loads((ROOT / p).read_text(encoding="utf-8"))
    except Exception:
        return default


def fv(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def taiex_last2():
    rows = fin.api_get("TaiwanStockPrice", data_id="TAIEX",
                       start_date=(date.today() - timedelta(days=10)).isoformat())
    rows = [r for r in rows if fv(r.get("close"))]
    return rows[-2:] if len(rows) >= 2 else rows


def night_gap(spot_close: float):
    """夜盤(標記次一交易日)近月收盤 vs 現貨收盤。"""
    rows = fin.api_get("TaiwanFuturesDaily", data_id="TX",
                       start_date=(date.today() - timedelta(days=5)).isoformat())
    am = [r for r in rows if r.get("trading_session") == "after_market"
          and "/" not in str(r.get("contract_date", "")) and fv(r.get("close"))]
    if not am:
        return None
    last_date = max(r["date"] for r in am)
    cand = [r for r in am if r["date"] == last_date]
    front = max(cand, key=lambda r: r.get("volume") or 0)
    close = fv(front["close"])
    return {"date": last_date, "close": close, "chg_pct": fv(front.get("spread_per")),
            "spot": spot_close, "gap": round(close - spot_close, 1) if spot_close else None}


def exdiv_today(cl: dict, a5map: dict):
    today = date.today().isoformat()
    try:
        rows = fin.api_get("TaiwanStockDividendResult", start_date=today, end_date=today)
    except Exception:
        rows = []
    out = []
    for r in rows:
        c = str(r.get("stock_id") or "")
        if c not in cl:
            continue
        out.append({"c": c, "n": cl[c].get("n", ""),
                    "div": fv(r.get("stock_and_cache_dividend")),
                    "a5": a5map.get(c, 0)})
    out.sort(key=lambda x: -x["a5"])
    return [{k: v for k, v in x.items() if k != "a5"} for x in out[:10]]


def inst_total():
    rows = fin.api_get("TaiwanStockTotalInstitutionalInvestors",
                       start_date=(date.today() - timedelta(days=7)).isoformat())
    if not rows:
        return None
    last = max(r["date"] for r in rows)
    m = {}
    for r in rows:
        if r["date"] != last:
            continue
        net = (fv(r.get("buy")) or 0) - (fv(r.get("sell")) or 0)
        m[r.get("name")] = round(net / 1e8, 1)
    return {"date": last,
            "foreign": m.get("Foreign_Investor"),
            "trust": m.get("Investment_Trust"),
            "dealer": round((m.get("Dealer_self") or 0) + (m.get("Dealer_Hedging") or 0), 1)}


def overnight_news(targets: list, cl: dict, since_dt: datetime):
    """targets=[(code, 理由)]；抓 since_dt（上一交易日收盤後）→ 現在的新聞，
    去重/排論壇/每股≤2/共≤10。
    TaiwanStockNews 一次 request 只回單日，故逐日迴圈抓再合併；
    週一視窗涵蓋五六日一、連假比照延伸（上限8天防呆）。"""
    seen_t, seen_u, out = set(), set(), []
    days, d = [], since_dt.date()
    while d <= date.today() and len(days) < 8:
        days.append(d.isoformat())
        d += timedelta(days=1)
    cutoff = since_dt.strftime("%Y-%m-%d %H:%M:%S")
    for c, why in targets:
        rows = []
        for ds in days:
            try:
                rows += fin.api_get("TaiwanStockNews", data_id=c,
                                    start_date=ds, end_date=ds)
            except Exception:
                continue
        rows = [r for r in rows
                if str(r.get("date", "")).replace("T", " ") >= cutoff]
        rows.sort(key=lambda r: r.get("date", ""), reverse=True)
        n = 0
        for r in rows:
            t = (r.get("title") or "").split(" - ")[0].strip()
            u = r.get("link") or ""
            if not t or "/forum/" in u or "爆料同學會" in t:
                continue
            key = t[:18]
            if key in seen_t or u in seen_u:
                continue
            ts = str(r.get("date", ""))[5:16]
            out.append({"c": c, "n": cl.get(c, {}).get("n", c), "why": why,
                        "t": t[:60], "u": u, "s": r.get("source", ""), "tm": ts})
            seen_t.add(key); seen_u.add(u)
            n += 1
            if n >= 2:
                break
        if len(out) >= 10:
            break
    return out[:10]


def main():
    cl = (jload("data/classify.json") or {}).get("map") or {}
    bl = jload("data/baseline.json") or {}
    blst = bl.get("stocks") or {}
    a5map = {c: (v[0] or 0) for c, v in blst.items()}
    diff = jload("data/aetf/diff.json")

    # ① 開盤參考
    t2 = taiex_last2()
    spot = fv(t2[-1]["close"]) if t2 else None
    spot_chg = None
    if len(t2) == 2 and fv(t2[0]["close"]):
        spot_chg = round((spot / fv(t2[0]["close"]) - 1) * 100, 2)
    gap = night_gap(spot) if spot else None

    # ④ 昨日備忘（subs_y: [y1,y2]；y1=最近一日）
    subs_y = bl.get("subs_y") or {}
    up_subs = sorted([k for k, v in subs_y.items() if v[0] == 1])
    dn_subs = sorted([k for k, v in subs_y.items() if v[0] == -1])
    y1n = sum(1 for v in blst.values() if len(v) > 3 and v[3] == 1)
    y1d = sum(1 for v in blst.values() if len(v) > 3 and v[3] == -1)

    # ⑤ 籌碼
    inst = None
    try:
        inst = inst_total()
    except Exception as e:
        print("inst_total 失敗:", e, flush=True)
    it3 = sorted([c for c, v in blst.items() if v[1] == 3], key=lambda c: -a5map.get(c, 0))[:8]
    it3 = [{"c": c, "n": cl.get(c, {}).get("n", "")} for c in it3]
    aetf_lines = []
    co_buy = []
    if diff:
        st = diff.get("stocks") or []
        co_buy = [s for s in st if sum(1 for v in (s.get("by") or {}).values() if v > 0) >= 2][:3]
        if co_buy:
            aetf_lines.append("多檔同買：" + "、".join(s.get("n") or s["c"] for s in co_buy))
        sb = diff.get("subs") or []
        if sb and sb[0].get("val"):
            s0 = sb[0]
            aetf_lines.append(f"次產業最大{'加碼' if s0['val'] > 0 else '減碼'}："
                              f"{s0['name'].split('（')[0]} {abs(s0['val']) / 1e8:.1f}億")

    # ⑥ 驗證訊號
    cont = sorted([k for k, v in subs_y.items() if v[0] == 1 and v[1] == 1])   # 連湧
    aetf_up_subs = {s["name"] for s in (diff.get("subs") or []) if s.get("val", 0) > 0} if diff else set()
    dual = sorted(set(up_subs) & aetf_up_subs)

    # ⑦ 新聞對象：AETF同買 + 投信3連買前3 + 權值前5(以a5)
    tg, used = [], set()
    for s in co_buy:
        if s["c"] not in used:
            tg.append((s["c"], "ETF同買")); used.add(s["c"])
    for x in it3[:3]:
        if x["c"] not in used:
            tg.append((x["c"], "投信連買")); used.add(x["c"])
    for c in sorted(a5map, key=lambda c: -a5map[c])[:5]:
        if c not in used:
            tg.append((c, "權值")); used.add(c)
    # 視窗起點：上一個有效交易日 14:00（收盤後）。TAIEX 最近收盤日即上一交易日，
    # 週末/連假自動跳過非交易日；TAIEX 取不到時退回 3 天前保底。
    prev_trade = t2[-1]["date"] if t2 else (date.today() - timedelta(days=3)).isoformat()
    since_dt = datetime.strptime(str(prev_trade)[:10], "%Y-%m-%d").replace(hour=14)
    news = overnight_news(tg[:12], cl, since_dt)

    out = {"date": date.today().isoformat(),
           "generated_at": datetime.now(TPE).isoformat(),
           "gap": gap,
           "spot": {"close": spot, "chg_pct": spot_chg, "date": t2[-1]["date"] if t2 else None},
           "exdiv": exdiv_today(cl, a5map),
           "recap": {"up_subs": up_subs[:8], "down_subs": dn_subs[:8], "y1_up": y1n, "y1_dn": y1d,
                     "baseline_date": bl.get("date")},
           "chips": {"inst": inst, "it3": it3, "aetf": aetf_lines},
           "signals": {"cont_subs": cont, "new_subs": [s for s in up_subs if s not in cont][:6],
                       "dual": dual},
           "news": news}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"morning.json: gap={gap and gap['gap']} exdiv={len(out['exdiv'])} "
          f"連湧={len(cont)} 雙確認={len(dual)} news={len(news)}")


if __name__ == "__main__":
    main()
