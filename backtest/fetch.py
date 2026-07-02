# backtest/fetch.py — 抓回測用歷史資料（日線 + 法人買賣超），逐日快取、可中斷續傳
#
# 範圍：START ~ END 每個工作日
#   price_YYYY-MM-DD.json.gz : {code:[amt,open,high,low,close]}（僅 classify 內上市/上櫃，另存 TAIEX）
#   inst_YYYY-MM-DD.json.gz  : {code:[投信淨買股數, 外資淨買股數]}
#
# 用法：python backtest/fetch.py   （token 讀 repo 根 .env）

from __future__ import annotations
import gzip
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "backtest" / "cache"
START, END = date(2025, 6, 15), date(2026, 7, 1)  # 含訊號期前 5 日基準與 T+3 前瞻


def token() -> str:
    for line in (ROOT / ".env").read_text(encoding="utf-8-sig").splitlines():
        if line.strip().startswith("FINMIND_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("找不到 FINMIND_TOKEN")


TOK = token()


def api(dataset: str, d: str) -> list:
    p = urllib.parse.urlencode(dict(dataset=dataset, start_date=d, end_date=d, token=TOK))
    for attempt in range(4):
        try:
            with urllib.request.urlopen(f"https://api.finmindtrade.com/api/v4/data?{p}", timeout=90) as r:
                j = json.load(r)
            if j.get("status") == 200:
                return j.get("data") or []
            if "rate" in str(j.get("msg", "")).lower():  # 撞限速 → 等一分鐘
                time.sleep(65)
                continue
            raise RuntimeError(f"{dataset} {d}: {j.get('msg')}")
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(8 * (attempt + 1))
    return []


def classify() -> dict:
    return json.loads((ROOT / "data" / "classify.json").read_text(encoding="utf-8"))["map"]


def wgz(p: Path, obj):
    p.write_bytes(gzip.compress(json.dumps(obj, separators=(",", ":")).encode()))


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    cl = classify()
    keep = {c for c, v in cl.items() if v.get("t") in ("twse", "tpex") and c[:1].isdigit()}
    days = []
    d = START
    while d <= END:
        if d.weekday() < 5:
            days.append(d.isoformat())
        d += timedelta(days=1)
    print(f"工作日 {len(days)} 天，快取於 {CACHE}", flush=True)

    for i, ds in enumerate(days):
        pf, inf = CACHE / f"price_{ds}.json.gz", CACHE / f"inst_{ds}.json.gz"
        if pf.exists() and inf.exists():
            continue
        rows = api("TaiwanStockPrice", ds)
        if not rows:  # 假日/颱風停市
            wgz(pf, {}); wgz(inf, {})
            print(f"[{i+1}/{len(days)}] {ds} 無交易", flush=True)
            continue
        price, taiex = {}, None
        for r in rows:
            c = str(r.get("stock_id") or "")
            if c == "TAIEX":
                taiex = [r.get("Trading_money"), r.get("open"), r.get("max"), r.get("min"), r.get("close")]
            if c in keep:
                price[c] = [r.get("Trading_money"), r.get("open"), r.get("max"), r.get("min"), r.get("close")]
        if taiex:
            price["_TAIEX"] = taiex
        wgz(pf, price)

        inst = {}
        for r in api("TaiwanStockInstitutionalInvestorsBuySell", ds):
            c = str(r.get("stock_id") or "")
            if c not in keep:
                continue
            n = r.get("name")
            if n not in ("Investment_Trust", "Foreign_Investor"):
                continue
            o = inst.setdefault(c, [0, 0])
            net = (r.get("buy") or 0) - (r.get("sell") or 0)
            o[0 if n == "Investment_Trust" else 1] += net
        wgz(inf, inst)
        print(f"[{i+1}/{len(days)}] {ds} price={len(price)} inst={len(inst)}", flush=True)
        time.sleep(0.8)  # 客氣一點，避免限速
    print("完成", flush=True)


if __name__ == "__main__":
    main()
