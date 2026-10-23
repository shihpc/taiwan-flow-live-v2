# src/build_aetf.py — 主動式ETF 每日投組快照 → data/aetf/YYYY-MM-DD.json + latest.json
#
# 資料源：FinMind（2026-07-20 遷移，取代原 6 套逐家投信 PCF 逆向工程）
#   TaiwanStockActiveETFInfo   — 主動ETF清單（category/type），動態取「持台股的主動股票型」
#   TaiwanStockActiveETFHolding— 每日逐持股（component_stock_id/name/shares/weight/market_value）
#   （申贖含總變動 TaiwanStockActiveETFHoldingChange 由 build_aetf_diff.py 另抓，見該檔）
#
# 納入條件（2026-08-29 放寬，原限 category=='domestic' 且 type=='twse'）：代號 A 結尾（股票型）
#   且 category != 'foreign'（排除美股型；D 結尾債券型／bfIncome 平衡入息型非 A 結尾自然排除——
#   它們不持台股、不適用主動加減碼）。不限上市/上櫃：tpex 台股型（如 00411A/00998A）在 Info 的
#   category 為空字串，故不能以 category=='domestic' 篩。規則式動態取檔，新上市台股型自動入池。
#   安全網：若未來有未標 category 的非台股型混入，grab_holding 因無台股持股會落 errors 自動排除。
#   原追蹤 8 檔（00400A/00403A/00405A/00980A/00981A/00982A/00991A/00992A）全數涵蓋於此規則內。
#
# 快照格式（每檔）：{date, aum, units, stocks:{code:[股數, 名稱, 權重%]}, src_date, name, twse_aum_yi}
#   units=null（FinMind 無總單位數；主動加減碼改用「逐持股股數比中位數」估申贖比，見 diff.py）
#   aum=當日成分股 market_value 加總（元，僅供估算，前端規模欄仍用 twse_aum_yi 集保口徑）
#
# 起始日 2025-05-05（FinMind ActiveETFHolding 最早）。用法：python src/build_aetf.py（需 FINMIND_TOKEN）

from __future__ import annotations
import json
import re
import sys
import time
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fin
import twse_holidays

ROOT = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "data" / "aetf"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36"}
TPE = timezone(timedelta(hours=8))
STOCK_RE = re.compile(r"^\d{4,6}$")   # 台股普通股/ETF 代號（排除現金/期貨/外幣部位）

# 若 Info 抓取失敗時的備援清單（2026-08-29 當日符合納入條件的 24 檔快照；平時走動態）
FALLBACK_ETFS = ["00400A", "00401A", "00403A", "00404A", "00405A", "00406A", "00407A",
                 "00408A", "00410A", "00411A", "00980A", "00981A", "00982A", "00984A",
                 "00985A", "00987A", "00991A", "00992A", "00993A", "00994A", "00995A",
                 "00996A", "00998A", "00999A"]


def fnum(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def list_active_etfs() -> list[tuple[str, str]]:
    """回 [(code, name)]：FinMind Info 中主動台股股票型（A 結尾、非 foreign，不限上市/上櫃）。
    失敗時退回 FALLBACK_ETFS（名稱留空，後續由 Holding 補）。"""
    try:
        rows = fin.api_get("TaiwanStockActiveETFInfo", start_date=date.today().isoformat())
        if not rows:   # 當日可能無列，往回抓一週
            rows = fin.api_get("TaiwanStockActiveETFInfo",
                               start_date=(date.today() - timedelta(days=7)).isoformat())
        latest = {}
        for r in rows:
            latest[str(r.get("stock_id"))] = r   # 同代號後者覆蓋（取最新一列）
        out = []
        for code, r in sorted(latest.items()):
            if code.endswith("A") and r.get("category") != "foreign":
                out.append((code, str(r.get("stock_name") or "")))
        if out:
            return out
    except Exception as e:
        print(f"list_active_etfs 失敗（{e}）→ 用備援清單", flush=True)
    return [(c, "") for c in FALLBACK_ETFS]


def grab_holding(code: str) -> dict:
    """FinMind TaiwanStockActiveETFHolding：取最近有資料日的逐持股。
    回 {stocks:{code:[股數,名稱,權重%,市值元]}, src_date, units:None, aum(市值加總,元)}。"""
    start = (date.today() - timedelta(days=14)).isoformat()
    rows = fin.api_get("TaiwanStockActiveETFHolding", data_id=code, start_date=start)
    if not rows:
        raise RuntimeError("Holding 近 14 日無資料")
    latest = max(str(r["date"]) for r in rows if r.get("date"))
    stocks, aum = {}, 0.0
    for r in rows:
        if str(r.get("date")) != latest:
            continue
        if str(r.get("asset_type") or "") not in ("stock", ""):
            continue
        c = str(r.get("component_stock_id") or "").strip()
        if not STOCK_RE.match(c):
            continue
        sh = fnum(r.get("shares"))
        if sh is None or sh == 0:
            continue
        mv = fnum(r.get("market_value"))
        stocks[c] = [round(sh), r.get("component_stock_name") or "", fnum(r.get("weight")), mv]
        if mv:
            aum += mv
    if not stocks:
        raise RuntimeError(f"{latest} 無台股持股（asset_type/代號過濾後為空）")
    return {"stocks": stocks, "src_date": latest, "units": None,
            "aum": round(aum) if aum else None}


# ---------- 抓取失敗時沿用舊快照的天數上限（2026-10-23，使用者裁定 A3″-a）----------
# 起因：00996A 自 10-06 起 FinMind 連續抓不到，main() 的「全數重試失敗 → 沿用上次快照＋stale」
#   沒有上限，每班把同一份 src_date=2026-09-21 的持股原封不動寫回 latest.json，近一個月。
#   沿用本意是「偶發一班失敗時不讓該檔缺席」，不是無限期頂替。
# 規則：舊快照 src_date 之後、到今天（台北）為止（含今天）經過的**交易日數** > STALE_MAX_TRADING_DAYS
#   就不沿用，該檔只留在 out["errors"]。交易日＝非週末且非行事曆休市日（src/twse_holidays.py，
#   fail-open：行事曆讀不到或年度未涵蓋時只排週末——此時國定假日會被多算一天，偏向「較早停止沿用」）。
# src_date 缺或解析不了 → **不沿用**：無法證明它夠新，而本規則要擋的正是「不知道多舊的資料被無限期頂替」；
#   不沿用的代價只是該檔當班缺席（errors 照列，下游本來就要處理缺席），沿用的代價可能是無上限的舊持股。
STALE_MAX_TRADING_DAYS = 5


def parse_src_date(v) -> date | None:
    """src_date 可能是 YYYY/MM/DD 或 YYYY-MM-DD；其他形狀回 None。"""
    s = str(v or "").strip().replace("/", "-")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def trading_days_since(src: date, today: date, cal) -> int:
    """(src, today] 區間內的交易日數；src >= today 回 0。cal＝twse_holidays.load() 結果（可為 None）。"""
    n, d = 0, src + timedelta(days=1)
    while d <= today:
        if not twse_holidays.is_closed(d.isoformat(), cal):
            n += 1
        d += timedelta(days=1)
    return n


def carry_decision(prev_entry: dict, today: date, cal,
                   max_days: int = STALE_MAX_TRADING_DAYS) -> tuple[bool, int | None, str]:
    """回 (是否沿用, 交易日落後數或 None, 說明)。純函式，供 main() 與離線測試共用。"""
    src = parse_src_date((prev_entry or {}).get("src_date"))
    if src is None:
        return False, None, f"舊快照 src_date 無法解析（{(prev_entry or {}).get('src_date')!r}），不沿用"
    lag = trading_days_since(src, today, cal)
    if lag > max_days:
        return False, lag, (f"舊快照 src={src.isoformat()} 已落後 {lag} 個交易日"
                            f"（> 上限 {max_days}），不沿用")
    return True, lag, f"舊快照 src={src.isoformat()} 落後 {lag} 個交易日（≤ {max_days}），沿用"


# ---------- TWSE ETFortune AUM（集保口徑，全 ETF 通用；前端規模欄顯示用） ----------
def grab_twse_aum(code: str):
    try:
        r = requests.get(f"https://www.twse.com.tw/zh/ETFortune/etfInfo/{code}", headers=UA, timeout=60)
        m = re.search(r"資產規模[^<]*</p>\s*<span>([\d,.]+)</span>", r.text)
        return fnum(m.group(1)) if m else None
    except Exception:
        return None


def main():
    OUTDIR.mkdir(parents=True, exist_ok=True)
    etfs = list_active_etfs()
    out = {"run_date": date.today().isoformat(),
           "generated_at": datetime.now(TPE).isoformat(),
           "source": "finmind", "etfs": {}, "errors": {}}
    # 前一份快照（供某檔重試仍失敗時沿用上次持股，避免 diff 因該檔缺席而錯亂）
    try:
        prev = (json.loads((OUTDIR / "latest.json").read_text(encoding="utf-8"))).get("etfs", {})
    except Exception:
        prev = {}
    today_tpe = datetime.now(TPE).date()   # 沿用上限以台北日計（runner 是 UTC，不可用 date.today()）
    cal_box = [None]                        # 延遲載入的行事曆（tuple 包一層，區分「未載入」與「載入結果為 None」）
    dropped = {}                            # 超過沿用上限而未寫回 etfs 的舊快照（仍交給投信補位一次機會）
    for code, name in etfs:
        last = None
        for attempt in range(3):
            try:
                d = grab_holding(code)
                d["name"] = name or (prev.get(code) or {}).get("name") or code
                d["twse_aum_yi"] = grab_twse_aum(code)
                # 未更新偵測：抓取成功但 src_date 未較上一份快照前進 → 標 not_advanced
                pe = prev.get(code) or {}
                ps = str(pe.get("src_date") or "").replace("-", "/")
                cs = str(d.get("src_date") or "").replace("-", "/")
                if ps and cs and cs <= ps:
                    d["not_advanced"] = True
                out["etfs"][code] = d
                print(f"{code} {d['name']}: {len(d['stocks'])}檔 src={d.get('src_date')} "
                      f"aum={d.get('aum')} twse_aum={d.get('twse_aum_yi')}億"
                      f"{' [未更新]' if d.get('not_advanced') else ''}", flush=True)
                last = None
                break
            except Exception as e:
                last = e
                print(f"{code} {name}: 第{attempt + 1}次失敗 {e}", flush=True)
                if attempt < 2:
                    time.sleep(3 * (attempt + 1))
        if last is not None:
            out["errors"][code] = str(last)
            if code in prev:   # 沿用上次快照，並標記 stale 供前端/診斷辨識——但有交易日數上限
                if cal_box[0] is None:   # 行事曆只在真的需要時讀一次（load 不拋、失敗回 None＝只排週末）
                    cal_box[0] = (twse_holidays.load(),)
                ok, lag, why = carry_decision(prev[code], today_tpe, cal_box[0][0])
                if ok:
                    carried = dict(prev[code])
                    carried["stale"] = True
                    out["etfs"][code] = carried
                    print(f"{code} {name}: 全數重試失敗，{why}", flush=True)
                else:
                    dropped[code] = prev[code]   # 仍交給下方投信補位一次機會（補位成功才寫回 etfs）
                    print(f"{code} {name}: 全數重試失敗，{why}；只列 errors", flush=True)
        time.sleep(0.3)   # FinMind 請求間節流（擴充後檔數上升）

    # ---- 投信端點補位（2026-07-31）----
    # FinMind 對統一／野村等投信慢一個交易日，該批檔每天被 diff.py 列為 laggards、
    # 不併入共識聚合。對已登記的檔改向投信端點補抓，只有拿到「比 FinMind 更新的基準日」
    # 才覆蓋；抓不到／日期無法折算一律略過，退回補位前行為。整段包 try——補位壞掉
    # 不得影響主幹 FinMind 的產出。
    try:
        import aetf_fallback
        fb = aetf_fallback.fetch_fallback(list(out["etfs"]) + [c for c in dropped if c not in out["etfs"]])
        for code, d in fb.items():
            cur = out["etfs"].get(code) or dict(dropped.get(code) or {})
            if str(d["src_date"]).replace("-", "/") <= str(cur.get("src_date") or "").replace("-", "/"):
                continue   # 沒有比較新，不覆蓋
            before = cur.get("src_date")
            cur.update({"stocks": d["stocks"], "src_date": d["src_date"],
                        "aum": d["aum"], "source": f"issuer:{d['fallback_src']}"})
            cur.pop("not_advanced", None)
            cur.pop("stale", None)
            if code not in out["etfs"]:   # 由超過沿用上限的舊快照救回：舊快照的集保規模已過期，不沿用
                cur["twse_aum_yi"] = None
            out["etfs"][code] = cur
            out.setdefault("fallback_used", {})[code] = {
                "issuer": d["fallback_src"], "from": before, "to": d["src_date"]}
            print(f"{code} 補位：{before} → {d['src_date']}（{d['fallback_src']}）", flush=True)
    except Exception as e:
        print(f"補位整段失敗（不影響主幹）：{type(e).__name__}: {e}", flush=True)

    if not out["etfs"]:
        raise RuntimeError("全部失敗，不寫檔")
    body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    (OUTDIR / f"{out['run_date']}.json").write_text(body, encoding="utf-8")
    (OUTDIR / "latest.json").write_text(body, encoding="utf-8")
    print(f"寫入 data/aetf/{out['run_date']}.json（{len(out['etfs'])}/{len(etfs)} 檔成功）")


if __name__ == "__main__":
    main()
