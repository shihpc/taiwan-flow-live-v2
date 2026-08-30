# src/build_baseline.py — 產 data/baseline.json（資金湧入偵測的常態基準，每交易日收盤後跑）
#
# 內容（給 Worker /live 當靜態依賴，快取到隔日）：
#   stocks: {code: [a5, it, fi, y1, y2, ints, nl, its, nh, a20]}
#     a5 = 前 5 個交易日平均成交額（元）→ 集中度分母（個股常態佔比 = a5/tot5）
#     it/fi = 投信/外資近 3 交易日買超日數 0~3（回測實證的個股續勢旗標）
#     its = 投信近 3 交易日賣超日數 0~3（連買的反向：連賣旗標）
#     y1/y2 = 最近一日/前一日的日線訊號：1=湧入(爆量2x+漲2%+收高0.7) / -1=退出(爆量+跌+收低0.3) / 0=無
#       回測（report_lag.md）：個股昨湧→今日平均偏弱(追高警示)、昨退→續弱；連續兩日效果加倍
#     ints = 法人買賣強度%（最近一日 (投信+外資淨買股數×close)/成交額×100，1位小數）
#       回測（report_indicators.md）：>5% 疊湧入 -0.51→-0.10；<-5% 疊退出 -0.64→-0.97
#     nl = 1 若最近一日收盤跌破前20日收盤最低（破底；退出訊號最強技術確認 -0.64→-1.08）
#     nh = 1 若最近一日收盤突破前20日收盤最高（創高；與 nl 對稱，LINE 卡3 排序母體用）
#     a20 = 前 20 個交易日（含最近一日）平均成交額（元）；分母＝窗內有效日數，口徑同
#       backtest/run_sorting.py 的 volt 分母（aw=amt[t-19:t+1] 濾空、除以 len(aw)）。
#       LINE 卡4「量能趨勢」= a5/a20
#   subs_y: {次產業: [y1, y2, C, R]}（僅列旗標非零者）
#       次產業訊號＝集中度(佔比/前5日均佔比)≥1.5 且 等權漲跌 ≥1%(湧)/≤-1%(退)
#       C = 最近一日集中度（湧入判定用的同一值，日線口徑）、R = 成員等權平均漲跌（小數）；
#       僅旗標由 y2 成立而當日未過金額/基期門檻者為 null。LINE 卡1 排序用。
#       回測：次產業昨湧→今日平均續強(+0.3pp)、連湧更強；昨退→今日偏弱
#   tot5 = 全市場（上市+上櫃）5 日均總額（元）；days = 取用的交易日（新→舊，共 7）
#
# 用法：FINMIND_TOKEN=... python src/build_baseline.py

from __future__ import annotations
import json
import sys
import time
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fin  # noqa: E402

OUT = fin.ROOT / "data" / "baseline.json"
NDAYS = 21          # 破20日新低需要 D-1..D-20；y2 的爆量分母需要 D-2..D-6
SUB_MIN_MEM = 5
SUB_AMT_MIN = 10e8


def classify() -> dict:
    return json.loads((fin.ROOT / "data" / "classify.json").read_text(encoding="utf-8"))["map"]


def fv(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def day_signal(pd, i):
    """pd=每日 {c:(amt,close,high,low)} 新→舊；回 {code: 1/-1}（第 i 日的日線湧入/退出訊號）。"""
    out = {}
    cur, prev = pd[i], pd[i + 1]
    for c, (amt, close, hi, lo) in cur.items():
        if not amt or amt < 1e8 or close is None:   # 流動性≥1億（與回測一致）
            continue
        base = sum((pd[k].get(c) or (0,))[0] or 0 for k in range(i + 1, i + 6)) / 5
        pc = (prev.get(c) or (None, None))[1]
        if not base or not pc:
            continue
        surge = amt / base
        ret = close / pc - 1
        pos = (close - lo) / (hi - lo) if (hi is not None and lo is not None and hi > lo) else 1.0
        if surge >= 2 and ret >= 0.02 and pos >= 0.7:
            out[c] = 1
        elif surge >= 2 and ret <= -0.02 and pos <= 0.3:
            out[c] = -1
    return out


def sub_signal(pd, i, members):
    """第 i 日的次產業訊號。集中度=佔比/前5日均佔比。

    回 (flags, stats)：flags={sub: 1/-1}（語意同舊版回傳值）；
    stats={sub: (conc, ret)}——conc=當日集中度、ret=成員等權平均漲跌（小數），
    凡通過金額/基期門檻者皆記錄（不限旗標成立者），供 subs_y 附掛 C/R。
    ret 在有效成員數 < SUB_MIN_MEM 時為 None（樣本不足，不據以判旗標，同原邏輯）。"""
    tots = []
    for k in range(i, i + 6):
        tots.append(sum(v[0] or 0 for c, v in pd[k].items() if not c.startswith("00")))
    out, stats = {}, {}
    for sub, mem in members.items():
        amt_now = sum((pd[i].get(c) or (0,))[0] or 0 for c in mem)
        if amt_now < SUB_AMT_MIN or not tots[0]:
            continue
        shares = []
        for k in range(1, 6):
            shares.append((sum((pd[i + k].get(c) or (0,))[0] or 0 for c in mem) / tots[k]) if tots[k] else 0.0)
        base = sum(shares) / 5
        if base <= 0:
            continue
        conc = (amt_now / tots[0]) / base
        rets = []
        for c in mem:
            c0 = (pd[i].get(c) or (None, None))[1]
            c1 = (pd[i + 1].get(c) or (None, None))[1]
            if c0 and c1:
                rets.append(c0 / c1 - 1)
        ret = sum(rets) / len(rets) if len(rets) >= SUB_MIN_MEM else None
        stats[sub] = (conc, ret)
        if ret is None or conc < 1.5:
            continue
        if ret >= 0.01:
            out[sub] = 1
        elif ret <= -0.01:
            out[sub] = -1
    return out, stats


def nh_nl(cur_close, prev_closes):
    """對稱新高/破底旗標：收盤 > 前20日收盤最高 → nh=1；收盤 < 前20日收盤最低 → nl=1。"""
    if not prev_closes:
        return 0, 0
    return (1 if cur_close > max(prev_closes) else 0,
            1 if cur_close < min(prev_closes) else 0)


def a20_of(pd, c):
    """前 20 個交易日（含最近一日）平均成交額（元，取整）。
    分母＝窗內有效日數（濾掉無資料/零額日），口徑同 backtest/run_sorting.py:151-152
    的 volt 分母：aw = amt[t-19:t+1] 濾空後 sum/len。"""
    aw = [v[0] for v in (pd[k].get(c) for k in range(20)) if v and v[0]]
    return round(sum(aw) / len(aw)) if aw else 0


def inst_streaks(day_rows, keep):
    """近 3 交易日的法人連買/連賣日數與最近一日淨買股數。

    day_rows＝[最近日, 次近日, 再前一日] 各自的 TaiwanStockInstitutionalInvestorsBuySell
    原始列（新→舊，最多 3 天）。回 (it, fi, its, net0)：
      it/fi  = 投信/外資近 3 日「買超」日數（0~3）
      its    = 投信近 3 日「賣超」日數（0~3）
      net0   = 最近一日 (投信+外資) 淨買股數，法人強度 ints 的分子

    外資口徑＝Foreign_Investor + Foreign_Dealer_Self（＝證交所 T86 口徑；
    taiwan-flows CLAUDE.md「逐檔法人」口徑段已驗證與 T86 完全一致，
    backtest/fetch.py 亦於 2026-07-29 同步）。本函式原本只收 Foreign_Investor，
    與回測快取、與生產其餘管線不同口徑，2026-08-30 補齊。

    **外資兩列必須先按（檔, 日）加總再判正負**：沿用逐列判斷的話，同一天會把 fi
    記兩次，0~3 的旗標會爆成 0~6。這是補口徑時一併要處理的隱性耦合。
    """
    it, fi, its, net0 = {}, {}, {}, {}
    for i, rows in enumerate(day_rows[:3]):
        day_it, day_fi = {}, {}       # 當日逐檔淨買股數，投信／外資各一份
        for r in rows or []:
            c = str(r.get("stock_id") or "")
            if c not in keep:
                continue
            name = r.get("name")
            if name == "Investment_Trust":
                tgt = day_it
            elif name in ("Foreign_Investor", "Foreign_Dealer_Self"):
                tgt = day_fi
            else:
                continue
            tgt[c] = tgt.get(c, 0) + (r.get("buy") or 0) - (r.get("sell") or 0)
        for c, net in day_it.items():
            if i == 0:
                net0[c] = net0.get(c, 0) + net
            if net > 0:
                it[c] = it.get(c, 0) + 1
            elif net < 0:
                its[c] = its.get(c, 0) + 1
        for c, net in day_fi.items():
            if i == 0:
                net0[c] = net0.get(c, 0) + net
            if net > 0:
                fi[c] = fi.get(c, 0) + 1
    return it, fi, its, net0


def build_subs_y(s1, s2, stats):
    """subs_y 組裝：{sub: [y1, y2, C, R]}（僅旗標非零者）。
    C=當日集中度（2位小數）、R=成員等權漲跌（小數4位）；當日未過門檻者為 None。"""
    out = {}
    for k in set(s1) | set(s2):
        conc, ret = stats.get(k, (None, None))
        out[k] = [s1.get(k, 0), s2.get(k, 0),
                  round(conc, 2) if conc is not None else None,
                  round(ret, 4) if ret is not None else None]
    return out


def main():
    cl = classify()
    keep = {c for c, v in cl.items() if v.get("t") in ("twse", "tpex") and c[:1].isdigit()}
    members = {}
    for c, info in cl.items():
        if c.startswith("00") or info.get("t") not in ("twse", "tpex"):
            continue
        for p in info.get("p", []):
            members.setdefault(p[1], set()).add(c)
    members = {k: v for k, v in members.items() if len(v) >= SUB_MIN_MEM}

    # 收集最近 NDAYS 個交易日（新→舊），每日 {c:(amt,close,high,low)}
    def day_prices(ds: str) -> dict:
        m = {}
        for r in fin.api_get("TaiwanStockPrice", start_date=ds, end_date=ds):
            c = str(r.get("stock_id") or "")
            if c in keep:
                m[c] = (fv(r.get("Trading_money")) or 0, fv(r.get("close")), fv(r.get("max")), fv(r.get("min")))
        return m

    days, pd = [], []
    d = date.today()
    probe = 0
    while len(days) < NDAYS and probe < 45:
        ds = d.isoformat()
        d -= timedelta(days=1)
        probe += 1
        if date.fromisoformat(ds).weekday() >= 5:
            continue
        m = day_prices(ds)
        if not m:
            continue
        days.append(ds)
        pd.append(m)
        print(f"price {ds} ok ({len(m)})", flush=True)
    if len(days) < NDAYS:
        raise RuntimeError(f"僅找到 {len(days)} 個交易日（需 {NDAYS}）")

    # freshness 重試（2026-07-14 依審計新增）：三大法人買賣超官方 20:00 台北更新、
    # FinMind 入庫時間不定，排程 20:41 起跑仍可能撲空（法人最新資料日 < 今日），
    # 導致連買日數整組往前錯一天。若今天是週一~五且最新資料不含今日 → 每 10 分
    # 重試、最多 40 分；逾時照原邏輯繼續（連買日數少算今日一天，但不中斷產出）。
    # 假日考量：今天可能是「平日的休市日」（國定假日），資料日永遠不會推進——
    # 重試僅在週一~五啟用且逾時必定放行，最多多等 40 分、不會無限空等；
    # 週末不啟用（抓回最近日=上一交易日屬正常，不空等）。
    today_iso = date.today().isoformat()
    if date.today().weekday() < 5:
        deadline = time.time() + 40 * 60   # 價格＋法人兩項共用同一個 40 分預算
        while True:
            # 檢查呼叫是新增的額外查詢，任何暫時性失敗只視為「未就緒」續等，
            # 不讓 freshness 機制反而引入新的崩潰路徑
            price_ok = days[0] == today_iso
            try:
                inst_ok = price_ok and bool(fin.api_get("TaiwanStockInstitutionalInvestorsBuySell",
                                                        start_date=today_iso, end_date=today_iso))
            except Exception as e:
                print(f"freshness 檢查失敗（視為未就緒）：{e}", flush=True)
                inst_ok = False
            if inst_ok:
                break
            if time.time() >= deadline:
                print(f"freshness 重試逾時（40 分），照原邏輯繼續：最新價格日 {days[0]}"
                      f"{'、法人買賣超未入庫（連買日數少算今日）' if price_ok else ''}", flush=True)
                break
            miss = "價格" if not price_ok else "法人買賣超"
            print(f"今日 {today_iso} 的{miss}資料尚未入庫，10 分鐘後重試…", flush=True)
            time.sleep(600)
            if not price_ok:
                try:
                    m = day_prices(today_iso)
                except Exception as e:
                    print(f"今日價格重查失敗（下一輪再試）：{e}", flush=True)
                    m = {}
                if m:
                    # 今日價格已入庫 → 插到最前（days/pd 均為新→舊；後續各指標都以
                    # 索引取相對日，前面多一天不影響既有窗口計算）
                    days.insert(0, today_iso)
                    pd.insert(0, m)
                    print(f"price {today_iso} ok ({len(m)})", flush=True)

    # 投信/外資近 3 交易日買超日數 + 最近一日淨買股數（法人強度用）
    day_rows = []
    for ds in days[:3]:
        day_rows.append(fin.api_get("TaiwanStockInstitutionalInvestorsBuySell",
                                    start_date=ds, end_date=ds))
        print(f"inst {ds} ok", flush=True)
    it, fi, its, net0 = inst_streaks(day_rows, keep)

    y1, y2 = day_signal(pd, 0), day_signal(pd, 1)
    s1, sub_stats = sub_signal(pd, 0, members)   # 當日 stats 供 subs_y 的 C/R
    s2, _ = sub_signal(pd, 1, members)           # y2 只需旗標，不需昨日 C/R

    stocks = {}
    tot5 = 0.0
    for c in keep:
        arr = [pd[k].get(c) for k in range(5)]
        amts = [a[0] for a in arr if a]
        if not amts:
            continue
        a5 = sum(amts) / 5
        # 法人強度%（最近一日）與 破20日新低/突破20日新高（對稱）
        cur = pd[0].get(c)
        ints = 0.0
        nh = nl = 0
        if cur and cur[0] and cur[1] is not None:
            ints = round(net0.get(c, 0) * cur[1] / cur[0] * 1000) / 10
            prevs = [v[1] for v in (pd[k].get(c) for k in range(1, NDAYS)) if v and v[1] is not None]
            nh, nl = nh_nl(cur[1], prevs)
        stocks[c] = [round(a5), it.get(c, 0), fi.get(c, 0), y1.get(c, 0), y2.get(c, 0), ints, nl, its.get(c, 0),
                     nh, a20_of(pd, c)]
        tot5 += a5
    subs_y = build_subs_y(s1, s2, sub_stats)

    out = {"date": days[0], "days": days, "tot5": round(tot5), "stocks": stocks, "subs_y": subs_y}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_y1 = sum(1 for v in stocks.values() if v[3] == 1)
    n_y1d = sum(1 for v in stocks.values() if v[3] == -1)
    print(f"baseline {days[0]}: {len(stocks)} 檔, tot5={tot5/1e8:.0f}億, "
          f"昨湧{n_y1}/昨退{n_y1d} 檔, 次產業旗標 {len(subs_y)} 個, "
          f"投信3連買 {sum(1 for v in stocks.values() if v[1] == 3)} 檔, "
          f"法人強度>5% {sum(1 for v in stocks.values() if v[5] > 5)} 檔, "
          f"破底 {sum(1 for v in stocks.values() if v[6])} 檔, "
          f"創高 {sum(1 for v in stocks.values() if v[8])} 檔")


if __name__ == "__main__":
    main()
