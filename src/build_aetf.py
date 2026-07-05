# src/build_aetf.py — 主動式ETF 每日投組快照 → data/aetf/YYYY-MM-DD.json + latest.json
#
# 追蹤 5 檔（4 家投信，端點驗證見 memory aetf-tab-plan）：
#   統一 00981A(49YTW)/00403A(63YTW)：ezmoney 頁面內嵌 JSON（需 cookie session；無單位數→P3 用權重差法）
#   群益 00982A：POST /CFWeb/api/etf/buyback {"fundId":"399","date":null}（全量+nav+totUnit）
#   野村 00980A：正式 POST API（GetFundTradeInfoDate → GetFundTradeInfo）
#   復華 00991A：GET /api/assets?fundID=ETF23&qDate=...
# 另抓 TWSE ETFortune 資產規模（集保，全 ETF 統一口徑的 AUM）。
#
# 快照格式（每檔）：{date, aum, units, stocks:{code:[股數, 名稱]}, src_date}
#   units=流通/發行單位數（主動加減碼公式的分母；統一/群益暫缺 → null，P3 以 TWSE AUM 與淨值近似）
#
# 用法：python src/build_aetf.py   （無需 FinMind token）

from __future__ import annotations
import html as html_
import json
import re
import sys
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "data" / "aetf"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36"}
TPE = timezone(timedelta(hours=8))


def fnum(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


# ---------- 統一（ezmoney，頁面內嵌 JSON） ----------
def grab_uni(code: str, fund_code: str) -> dict:
    s = requests.Session()
    s.headers.update(UA)
    r = s.get(f"https://www.ezmoney.com.tw/ETF/Fund/Info?FundCode={fund_code}", timeout=60)
    r.raise_for_status()
    h = html_.unescape(r.text)
    objs = re.findall(r'\{[^{}]*"DetailCode"[^{}]*\}', h)
    stocks, src_date = {}, None
    for o in objs:
        try:
            d = json.loads(o)
        except json.JSONDecodeError:
            continue
        if d.get("AssetCode") != "ST" or d.get("FundCode") != fund_code:
            continue
        src_date = src_date or str(d.get("TranDate", ""))[:10]
        c = str(d.get("DetailCode") or "")
        sh = fnum(d.get("Share"))
        if c and sh:
            stocks[c] = [round(sh), d.get("DetailName") or "", fnum(d.get("NavRate"))]
    if not stocks:
        raise RuntimeError("內嵌 JSON 無 ST 持股（頁面改版?）")
    return {"stocks": stocks, "src_date": src_date, "units": None, "aum": None}


# ---------- 群益（正式 API：POST /CFWeb/api/etf/buyback） ----------
def grab_capital(fund_id: str) -> dict:
    s = requests.Session()
    s.headers.update(UA)
    r = s.post("https://www.capitalfund.com.tw/CFWeb/api/etf/buyback",
               json={"fundId": fund_id, "date": None}, timeout=60)
    r.raise_for_status()
    data = r.json().get("data") or {}
    pcf = data.get("pcf") or {}
    stocks = {}
    for row in data.get("stocks") or []:
        c = str(row.get("stocNo") or "")
        sh = fnum(row.get("share"))
        if c and sh:
            stocks[c] = [round(sh), row.get("stocName") or "", fnum(row.get("weight"))]
    if not stocks:
        raise RuntimeError("buyback stocks 為空")
    return {"stocks": stocks, "src_date": str(pcf.get("date1") or "").replace("-", "/")[:10],
            "units": fnum(pcf.get("totUnit")), "aum": fnum(pcf.get("nav"))}


# ---------- 野村（正式 API） ----------
def grab_nomura(code: str) -> dict:
    s = requests.Session()
    s.headers.update(UA)
    # 野村憑證鏈缺 SKI 導致部分環境 verify 失敗（curl 可過）→ 先試正常驗證，失敗退 verify=False
    try:
        s.get("https://www.nomurafunds.com.tw/ETFWEB/", timeout=30)
    except requests.exceptions.SSLError:
        s.verify = False
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    base = "https://www.nomurafunds.com.tw/API/ETFAPI/api/Fund/"
    body = {"FundNo": code, "Type": 2}
    d1 = s.post(base + "GetFundTradeInfoDate", json=body, timeout=60).json()
    latest = (d1.get("Entries") or {}).get("LatestDate")
    if not latest:
        raise RuntimeError("GetFundTradeInfoDate 無 LatestDate")
    body["Date"] = latest
    d2 = s.post(base + "GetFundTradeInfo", json=body, timeout=60).json()
    e = d2.get("Entries") or {}
    stocks = {}
    for r in e.get("Stocks") or []:
        c = str(r.get("CStockCode") or "")
        q = fnum(r.get("CQuantity"))
        if c and q:
            stocks[c] = [round(q), r.get("CStockName") or "", fnum(r.get("CWeightsPct"))]
    if not stocks:
        raise RuntimeError("GetFundTradeInfo Stocks 為空")
    return {"stocks": stocks, "src_date": str(e.get("CPcfdate", ""))[:10].replace("-", "/"),
            "units": fnum(e.get("CAnceTotalIssues")), "aum": fnum(e.get("CAnceTotalAv")),
            "futures": [{"c": r.get("CFuturesCode"), "q": r.get("CQuantity"), "w": r.get("CWeightsPct")}
                        for r in (e.get("Futures") or [])]}


# ---------- 復華（/api/assets） ----------
def grab_fh(fund_id: str) -> dict:
    s = requests.Session()
    s.headers.update(UA)
    res = None
    for back in range(0, 8):   # 週末/假日往回找最近有資料的一天
        q = (date.today() - timedelta(days=back)).strftime("%Y/%m/%d")
        r = s.get(f"https://www.fhtrust.com.tw/api/assets?fundID={fund_id}&qDate={q}", timeout=60)
        r.raise_for_status()
        cand = (r.json().get("result") or [None])[0]
        if cand and any(x.get("ftype") == "股票" for x in (cand.get("detail") or [])):
            res = cand
            break
    if not res:
        raise RuntimeError("近 8 日皆無持股資料")
    stocks = {}
    for row in res.get("detail") or []:
        if row.get("ftype") != "股票":
            continue
        c = str(row.get("stockid") or "")
        sh = fnum(row.get("qshare"))
        if c and sh:
            mv, nv = fnum(row.get("mvalue")), fnum(res.get("pcf_FundNav"))
            w = round(mv / nv * 10000) / 100 if (mv and nv) else None
            stocks[c] = [round(sh), row.get("stockname") or "", w]
    if not stocks:
        raise RuntimeError("detail 無股票")
    return {"stocks": stocks, "src_date": res.get("dDate"),
            "units": fnum(res.get("pcf_FundQissue")), "aum": fnum(res.get("pcf_FundNav")),
            "diff_raw": res.get("diff")}


# ---------- TWSE ETFortune AUM（集保口徑，全 ETF 通用） ----------
def grab_twse_aum(code: str):
    try:
        r = requests.get(f"https://www.twse.com.tw/zh/ETFortune/etfInfo/{code}", headers=UA, timeout=60)
        m = re.search(r"資產規模[^<]*</p>\s*<span>([\d,.]+)</span>", r.text)
        return fnum(m.group(1)) if m else None
    except Exception:
        return None


ETFS = [
    ("00981A", "統一台股增長", lambda: grab_uni("00981A", "49YTW")),
    ("00403A", "統一台股升級50", lambda: grab_uni("00403A", "63YTW")),
    ("00982A", "群益台灣強棒", lambda: grab_capital("399")),
    ("00980A", "野村臺灣優選", lambda: grab_nomura("00980A")),
    ("00991A", "復華未來50", lambda: grab_fh("ETF23")),
]


def main():
    OUTDIR.mkdir(parents=True, exist_ok=True)
    out = {"run_date": date.today().isoformat(),
           "generated_at": datetime.now(TPE).isoformat(), "etfs": {}, "errors": {}}
    for code, name, fn in ETFS:
        try:
            d = fn()
            d["name"] = name
            d["twse_aum_yi"] = grab_twse_aum(code)
            out["etfs"][code] = d
            print(f"{code} {name}: {len(d['stocks'])}檔 src={d.get('src_date')} "
                  f"units={d.get('units')} aum={d.get('aum')} twse_aum={d.get('twse_aum_yi')}億", flush=True)
        except Exception as e:
            out["errors"][code] = str(e)
            print(f"{code} {name}: 失敗 {e}", flush=True)
    if not out["etfs"]:
        raise RuntimeError("全部失敗，不寫檔")
    body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    (OUTDIR / f"{out['run_date']}.json").write_text(body, encoding="utf-8")
    (OUTDIR / "latest.json").write_text(body, encoding="utf-8")
    print(f"寫入 data/aetf/{out['run_date']}.json（{len(out['etfs'])}/5 檔成功）")


if __name__ == "__main__":
    main()
