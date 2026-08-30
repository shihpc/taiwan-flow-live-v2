# backtest/fetch.py — 抓回測用歷史資料（日線 + 法人買賣超），逐日快取、可中斷續傳
#
# 範圍：START ~ END 每個工作日
#   price_YYYY-MM-DD.json.gz : {code:[amt,open,high,low,close,vol]}（僅 classify 內上市/上櫃，另存 TAIEX）
#     vol＝FinMind Trading_Volume，單位「股」（÷1000＝張，taiwan-flows CLAUDE.md 口徑段）。
#     2026-08-30 追加於**陣列末端**，既有讀取端全部走索引 0~4，舊快取仍可讀；
#     但舊快取沒有這一欄，量能訊號（AS-15/16）會整批跳過，需重抓才解鎖。
#     **要重抓就整批刪**：下面的續傳是逐檔跳過（`if pf.exists() and inf.exists() and dtf.exists()`），
#     只刪一部分 price_*.json.gz／dt_*.json.gz 會留下「一半有欄一半沒有」的混合快取；
#     run_alpha_sweep 的 cache_has_volume／cache_has_daytrade 對此一律不放行
#     （整批不跑，不半盲印報告）。**price 與 dt 兩種快取都適用這條**。
#   inst_YYYY-MM-DD.json.gz  : {code:[投信淨買股數, 外資淨買股數]}
#   dt_YYYY-MM-DD.json.gz    : {code: 當沖成交股數}（FinMind TaiwanStockDayTrading 的 Volume）
#     2026-08-30 新增，解鎖第二階段第三候選 AS-17 當沖比率（預註冊書 §6）。
#     單位「股」，與 price 的 Trading_Volume 同單位 → 相除即當沖比率（無因次）。
#     語意＝TWSE「當日沖銷交易成交股數」**單邊**（買進股數＝賣出股數＝Volume；
#     實測 BuyAmount/Volume≈當日均價可證），FinMind 為 TWSE TWTB4U 的原樣轉載。
#     **空殼列**：TWSE 盤前就公布當沖標的清單、Volume 要當晚（約 21:30）才填，且 T~T+2
#     可修正、以 T+2 為準（TWSE TWTB4U 表尾說明）。所以只收 Volume>0 的列；整日都是
#     空殼（沒有任何 Volume>0）就**不寫檔**，留待下次重跑，不把「當天沒當沖」這種
#     假事實寫死進快取（同 postmkt `build_postmkt.py fetch_daytrading` 的判準）。
#     **要重抓就整批刪**（承上兩段）：續傳條件是三個檔都在，只補一部分同樣會做出混合快取。
#
# 用法：python backtest/fetch.py   （token 取 FINMIND_TOKEN 環境變數，沒有才讀 repo 根 .env）

from __future__ import annotations
import gzip
import json
import os
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
    # 先環境變數再 .env：CI（.github/workflows/backtest-regen.yml）用 Actions secret
    # 注入環境變數即可，不必把金鑰落成檔案；本機沿用既有的 repo 根 .env，行為不變。
    env = os.environ.get("FINMIND_TOKEN", "").strip()
    if env:
        return env
    dotenv = ROOT / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8-sig").splitlines():
            if line.strip().startswith("FINMIND_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("找不到 FINMIND_TOKEN（環境變數與 repo 根 .env 都沒有）")


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
        dtf = CACHE / f"dt_{ds}.json.gz"
        if pf.exists() and inf.exists() and dtf.exists():
            continue
        rows = api("TaiwanStockPrice", ds)
        if not rows:  # 假日/颱風停市
            for f in (pf, inf, dtf):
                wgz(f, {})
            print(f"[{i+1}/{len(days)}] {ds} 無交易", flush=True)
            continue
        price, taiex = {}, None
        for r in rows:
            c = str(r.get("stock_id") or "")
            if c == "TAIEX":
                taiex = [r.get("Trading_money"), r.get("open"), r.get("max"),
                         r.get("min"), r.get("close"), r.get("Trading_Volume")]
            if c in keep:
                price[c] = [r.get("Trading_money"), r.get("open"), r.get("max"),
                            r.get("min"), r.get("close"), r.get("Trading_Volume")]
        if taiex:
            price["_TAIEX"] = taiex
        wgz(pf, price)

        inst = {}
        for r in api("TaiwanStockInstitutionalInvestorsBuySell", ds):
            c = str(r.get("stock_id") or "")
            if c not in keep:
                continue
            n = r.get("name")
            # 外資＝Foreign_Investor + Foreign_Dealer_Self，對齊生產口徑
            # （taiwan-flows/src/pipeline.py:12）。2026-07-29 口徑覆核前只收
            # Foreign_Investor，見 docs/alpha-sweep-preregistration.md §5。
            if n not in ("Investment_Trust", "Foreign_Investor", "Foreign_Dealer_Self"):
                continue
            o = inst.setdefault(c, [0, 0])
            net = (r.get("buy") or 0) - (r.get("sell") or 0)
            o[0 if n == "Investment_Trust" else 1] += net
        wgz(inf, inst)

        # 當沖（AS-17 的分子）：只收 Volume>0 的列，空殼列不進快取。
        # 整日皆空殼＝該日 TWSE 尚未結算完（或 FinMind 尚未同步）→ 不寫檔，
        # 下次重跑會再抓一次；寫成空 dict 會被續傳當作「已抓且當天沒當沖」永久沿用。
        dt, shell = {}, 0
        for r in api("TaiwanStockDayTrading", ds):
            c = str(r.get("stock_id") or "")
            if c not in keep:
                continue
            v = r.get("Volume") or 0
            if v <= 0:
                shell += 1
                continue
            dt[c] = v
        if dt:
            wgz(dtf, dt)
        else:
            print(f"[{i+1}/{len(days)}] {ds} ⚠ 當沖整日皆空殼（{shell} 列 Volume 為空）"
                  "→ 不寫 dt 快取，下次重跑再抓", flush=True)

        print(f"[{i+1}/{len(days)}] {ds} price={len(price)} inst={len(inst)} dt={len(dt)}",
              flush=True)
        time.sleep(0.8)  # 客氣一點，避免限速
    print("完成", flush=True)


if __name__ == "__main__":
    main()
