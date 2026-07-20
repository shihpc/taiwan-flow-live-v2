# src/build_aetf.py — 主動式ETF 每日投組快照 → data/aetf/YYYY-MM-DD.json + latest.json
#
# 資料源：FinMind（2026-07-20 遷移，取代原 6 套逐家投信 PCF 逆向工程）
#   TaiwanStockActiveETFInfo   — 主動ETF清單（category/type），動態取「持台股的主動股票型」
#   TaiwanStockActiveETFHolding— 每日逐持股（component_stock_id/name/shares/weight/market_value）
#   （申贖含總變動 TaiwanStockActiveETFHoldingChange 由 build_aetf_diff.py 另抓，見該檔）
#
# 納入條件：Info 中 category=='domestic' 且 type=='twse' 且代號 A 結尾（主動台股股票型，
#   排除 foreign 美股型／D 結尾債券型／bfIncome 平衡入息型——它們不持台股、不適用主動加減碼）。
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

ROOT = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "data" / "aetf"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36"}
TPE = timezone(timedelta(hours=8))
STOCK_RE = re.compile(r"^\d{4,6}$")   # 台股普通股/ETF 代號（排除現金/期貨/外幣部位）

# 若 Info 抓取失敗時的備援清單（原 8 檔＋已知擴充；平時走動態）
FALLBACK_ETFS = ["00400A", "00401A", "00403A", "00404A", "00405A", "00406A", "00407A",
                 "00408A", "00980A", "00981A", "00982A", "00984A", "00985A", "00987A",
                 "00991A", "00992A", "00993A", "00994A", "00995A", "00996A", "00999A"]


def fnum(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def list_active_etfs() -> list[tuple[str, str]]:
    """回 [(code, name)]：FinMind Info 中 domestic 主動台股股票型（type=twse、A 結尾）。
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
            if (r.get("category") == "domestic" and r.get("type") == "twse"
                    and code.endswith("A")):
                out.append((code, str(r.get("stock_name") or "")))
        if out:
            return out
    except Exception as e:
        print(f"list_active_etfs 失敗（{e}）→ 用備援清單", flush=True)
    return [(c, "") for c in FALLBACK_ETFS]


def grab_holding(code: str) -> dict:
    """FinMind TaiwanStockActiveETFHolding：取最近有資料日的逐持股。
    回 {stocks:{code:[股數,名稱,權重%]}, src_date, units:None, aum(市值加總,元)}。"""
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
        stocks[c] = [round(sh), r.get("component_stock_name") or "", fnum(r.get("weight"))]
        mv = fnum(r.get("market_value"))
        if mv:
            aum += mv
    if not stocks:
        raise RuntimeError(f"{latest} 無台股持股（asset_type/代號過濾後為空）")
    return {"stocks": stocks, "src_date": latest, "units": None,
            "aum": round(aum) if aum else None}


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
            if code in prev:   # 沿用上次快照，並標記 stale 供前端/診斷辨識
                carried = dict(prev[code]); carried["stale"] = True
                out["etfs"][code] = carried
                print(f"{code} {name}: 全數重試失敗，沿用上次快照（src={carried.get('src_date')}）", flush=True)
        time.sleep(0.3)   # FinMind 請求間節流（擴充後檔數上升）
    if not out["etfs"]:
        raise RuntimeError("全部失敗，不寫檔")
    body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    (OUTDIR / f"{out['run_date']}.json").write_text(body, encoding="utf-8")
    (OUTDIR / "latest.json").write_text(body, encoding="utf-8")
    print(f"寫入 data/aetf/{out['run_date']}.json（{len(out['etfs'])}/{len(etfs)} 檔成功）")


if __name__ == "__main__":
    main()
