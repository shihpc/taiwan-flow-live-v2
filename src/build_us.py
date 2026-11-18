# src/build_us.py — 台股開盤前「昨夜美股速覽」→ data/us.json
#
# 內容：與台股連動高的美股指數/個股 價量變動 + 台股 ADR 溢價
#   groups: 指數(4) / 台股ADR(3, 含溢價%) / AI·半導體(8) / 大型科技(6)
#   每列: s(代號) n(中文名) c(收盤) chg(漲跌%) vr(量比=當日量/前5日均量) amp(振幅%=(H-L)/前收)
#   ADR 溢價% = (ADR收盤×USDTWD) / (台股收盤×換股比) - 1
# 排程：美股收盤(台北凌晨4/5點)後、台股開盤前 05:40 台北跑（us.yml）
#
#
# 頂層 date 的語意（2026-11-18 起）＝各列資料日（列的 d）的**眾數，平手取較舊者**（pick_us_date）。
#   舊口徑是 max：FinMind 美股日線逐檔滾動入庫，2026-11-18 清晨 24 列只有 AAPL 先到 11-17、
#   其餘 23 列（含三大指數、費半、TSM）仍是 11-16，檔案卻被標成 date=2026-11-17、brief 寫
#   「11/17美股大跌，費半-5.3%…」（數字其實是 11-16 的），下游守門（Worker runUsCatchup／
#   productFresh usDate／晨卡 usFresh、postmkt 早場彙總）全被騙成「已是最新」。
#   鍵名與形狀不變；這是跨站語意變更（消費者清單見 CLAUDE.md「us.json 的 date」節）。
#
# 用法：FINMIND_TOKEN=... python src/build_us.py
#       python src/build_us.py --complete   # 只讀現有 data/us.json，印 yes/no（us.yml 齊全判斷用，免 token）

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
                  ("INTC", "英特爾"), ("AMAT", "應用材料"), ("ASML", "艾司摩爾")]),
    ("大型科技", [("AAPL", "蘋果"), ("MSFT", "微軟"), ("TSLA", "特斯拉"), ("META", "Meta"),
                ("GOOGL", "Google"), ("AMZN", "亞馬遜"), ("ORCL", "甲骨文"),
                ("MU", "美光"), ("SNDK", "SanDisk"), ("SPCX", "SpaceX")]),
]
# 註：SMCI/DRAM/COIN/USO 為前端「自選」預設（使用者可自行刪增）；MU 自 AI/半導體移入大型科技。


def fv(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def pick_us_date(dates) -> str | None:
    """頂層 date＝各列資料日的眾數，**平手取較舊者**；無有效日期回 None。

    與 build_aetf_diff.pick_primary（平手取大）刻意相反：us.json 的 date 是下游判斷
    「隔夜美股到了沒」的唯一依據（Worker 補跑班與晨卡守門都比 date ≥ 預期交易日），
    寧可晚推進、讓補跑與守門繼續等，也不要讓少數先入庫的列把整份檔標成新的一天。
    過半數的列到新日才推進。"""
    cnt: dict = {}
    for d in dates:
        if d:
            d = str(d)[:10]
            cnt[d] = cnt.get(d, 0) + 1
    if not cnt:
        return None
    top = max(cnt.values())
    return min(d for d, n in cnt.items() if n == top)


def all_rows(groups) -> list:
    return [r for g in (groups or []) for r in (g.get("rows") or [])]


def rows_complete(doc: dict) -> bool:
    """us.yml 的「資料已齊」判斷（純函式）：
    ①有列且頂層 date 有值 ②**沒有任何列的 d 超前 date**（有＝新一日資料正在入庫，還沒過半）
    ③落後 date 的列 ≤ 1/3（容許少數長期停更的檔，沿用舊門檻）。
    舊判斷只數「落後」；max 口徑下不會有超前列，眾數口徑下會有，漏數就會在混合日期時誤判已齊。"""
    rows = all_rows((doc or {}).get("groups"))
    date_ = (doc or {}).get("date") or ""
    if not rows or not date_:
        return False
    ahead = sum(1 for r in rows if (r.get("d") or "") > date_)
    behind = sum(1 for r in rows if (r.get("d") or "") < date_)
    return ahead == 0 and behind * 3 <= len(rows)


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


def _seg_word(r: float, amp: float) -> str:
    """段漲跌以「當日高低點振幅」為分母分級（相對強度，避免大振幅日把小反彈說成強拉）。
    x=段漲跌/振幅：|x|≥50% 強拉/急殺、25~50% 走高/走低、10~25% 小漲/小跌、<10% 震盪持平。"""
    if not amp or amp <= 0:
        return "震盪持平"
    x = r / amp
    if x >= 0.5:
        return "強拉"
    if x >= 0.25:
        return "走高"
    if x >= 0.10:
        return "小漲"
    if x <= -0.5:
        return "急殺"
    if x <= -0.25:
        return "走低"
    if x <= -0.10:
        return "小跌"
    return "震盪持平"


def session_brief(us_date: str) -> str:
    """由分鐘K描述當日美股盤中走勢：S&P/納指/費半 各三段（早盤=首60分、午盤=中段、尾盤=末60分）。"""
    def segs(tic):
        try:
            rows = [r for r in fin.api_get("USStockPriceMinute", data_id=tic, start_date=us_date)
                    if str(r.get("date", "")).startswith(us_date) and fv(r.get("close"))]
        except Exception:
            return None
        n = len(rows)
        if n < 60:
            return None
        o = fv(rows[0].get("open")) or fv(rows[0]["close"])
        e = min(60, n // 3)                 # 早盤=首60分
        ls = max(n - 60, (2 * n) // 3)      # 尾盤=末60分
        c1, c2, c3 = fv(rows[e - 1]["close"]), fv(rows[ls - 1]["close"]), fv(rows[n - 1]["close"])
        hi = max(fv(r.get("high")) or 0 for r in rows)
        lo = min(fv(r.get("low")) or 1e18 for r in rows)
        amp = (hi - lo) / o * 100 if (hi and lo < 1e18 and o) else 0   # 當日振幅%
        return ((c1 / o - 1) * 100, (c2 / c1 - 1) * 100, (c3 / c2 - 1) * 100, amp)

    parts = []
    for tics, name in ((("^GSPC",), "S&P"), (("^IXIC",), "納指"), (("^SOX", "SOXX"), "費半")):
        g = None
        for tic in tics:   # ^SOX 無分鐘資料時退用 SOXX ETF 代理
            g = segs(tic)
            if g:
                break
        if g:
            r1, r2, r3, amp = g
            parts.append(f"{name}早盤{_seg_word(r1, amp)}、午盤{_seg_word(r2, amp)}、尾盤{_seg_word(r3, amp)}")
    return ("盤中：" + "；".join(parts) + "。") if parts else ""


def brief(groups, us_date: str | None = None) -> str:
    """70 字內規則式盤勢分析：日期→大盤定調→費半→台積ADR→開盤含義→極端個股（空間夠才放）。

    不混日（2026-11-18）：給了 us_date 時，只引用資料日 d == us_date 的列——三大指數定調、
    費半、TSM ADR、極端個股逐項過濾，不得把別日的數字掛在 us_date 這個日期前綴下。
    某項被濾掉就略過該項（電子開盤含義需費半與 TSM 同時有效）；全部被濾掉回空字串
    （不輸出只剩句號的殘句；Worker 美股卡對空 brief 本來就只畫表格）。"""
    def same_day(r):
        return bool(r) and (us_date is None or r.get("d") == us_date)

    g = {x["g"]: [r for r in x["rows"] if same_day(r)] for x in groups}
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
        if us_date:
            y, mo, d = us_date.split("-")
            tone = f"{int(mo)}/{int(d)}{tone}"
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
    return (out + "。") if out else ""


def main():
    fx = usdtwd()
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
            row = {"s": tic, "n": name, "c": m["c"], "chg": m["chg"], "vr": m["vr"], "amp": m["amp"], "d": m["date"]}
            if len(it) == 4 and fx:  # ADR：算溢價
                twc = tw_close(it[2])
                if twc:
                    row["prem"] = round((m["c"] * fx / (twc * it[3]) - 1) * 10000) / 100
                    row["tw"] = it[2]
            rows.append(row)
            print(f"{tic} {m['date']} {m['chg']:+.2f}%", flush=True)
        groups.append({"g": gname, "rows": rows})
    # 頂層 date＝各列資料日的眾數（平手取舊）；brief／session 都用這同一個值，不混日
    us_date = pick_us_date(r["d"] for r in all_rows(groups))
    from datetime import datetime, timezone
    TPE = timezone(timedelta(hours=8))
    out = {"date": us_date, "fx": round(fx, 3) if fx else None,
           "generated_at": datetime.now(TPE).isoformat(),   # P4：統一台北 ISO(+08:00)
           "brief": brief(groups, us_date), "session": session_brief(us_date) if us_date else "",
           "groups": groups}
    # generated_at 語意＝「最後一次資料內容有變的時間」（2026-08-13）：與現有檔比對
    # （排除 generated_at），內容未變則保留原時戳——重試迴圈空轉時不再每輪污染
    # generated_at，Worker 端「今天有沒有新資料」的判準因此可信
    try:
        old = json.loads(OUT.read_text(encoding="utf-8"))
        def _strip(d):
            return {k: v for k, v in d.items() if k != "generated_at"}
        if _strip(old) == _strip(out) and old.get("generated_at"):
            out["generated_at"] = old["generated_at"]
    except (OSError, ValueError, AttributeError):
        pass   # 現有檔缺／壞 → 照常寫新時戳
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n = sum(len(g["rows"]) for g in groups)
    print(f"us.json: 美股日期 {us_date}, {n} 檔, USDTWD={out['fx']}")


if __name__ == "__main__":
    if "--complete" in sys.argv[1:]:
        try:
            print("yes" if rows_complete(json.loads(OUT.read_text(encoding="utf-8"))) else "no")
        except (OSError, ValueError, AttributeError):
            print("no")
    else:
        main()
