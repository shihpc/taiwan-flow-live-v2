# src/aetf_fallback.py — 投信端點補位抓取器（只補 FinMind 落後的檔）
#
# 問題：FinMind 的 TaiwanStockActiveETFHolding 對部分投信慢一個交易日。實測 2026-07-31 00:19，
#   統一／野村／中信／群益／第一金 共 10 檔在 FinMind 只到 D-1，但投信端點與第三方站（MoneyDJ）
#   都已有 D 日持股。於是這 10 檔每天被 build_aetf_diff.py 列為 laggards、不併入共識聚合。
#
# 對策：主幹仍是 FinMind（涵蓋 20+ 檔，不動），僅對本檔登記的 ETF 在「FinMind 落後」時補位。
#   補位失敗一律靜默略過 → 退回補位前的行為（該檔續列 laggards），不讓爬蟲拖垮整條管線。
#
# 涵蓋統一 2 檔＋野村 3 檔（2026-07-31 起）＋群益 1 檔（2026-11-07 起）。端點沿用 2026-07-20 遷移 FinMind 前的實作
#   （commit cdb00eb^ src/build_aetf.py），當時已在生產跑過，非重新逆向。
#
# ⚠ 日期語意逐家不同，弄錯會整批錯一天（實測 2026-07-31 00:19 確認）：
#   統一 ezmoney `TranDate`  = 實際持股基準日        → 直接用
#   野村 `CPcfdate`          = PCF 生效日（T+1 標記） → 必須回推一個交易日才是持股基準日
#   驗證：野村 00980A 標 2026/07/31、台積電 634,000 股，與 MoneyDJ 標 2026/07/30 的數字相同。
#   這正是 build_aetf_diff.py 檔頭註解所稱「原 PCF 的 T+1 標記問題」。
#   群益 buyback `pcf.date1`  = 次一營業日（T+1 標記） → 同野村回推一個交易日
#   （依據：遷移前 `git show cdb00eb^:src/build_aetf_diff.py` 的 TPLUS1_ETFS 註解「群益 buyback
#    pcf.date1、野村 CPcfdate 皆為次一交易日」；**2026-11-07 未對真實端點重新驗證**。）
#
# 群益（2026-11-07 恢復，使用者裁定）：端點與欄位取自遷移前的 `grab_capital`
#   （`git show cdb00eb^:src/build_aetf.py`；2026-07-20 隨整批 PCF 爬蟲改走 FinMind 而移除，
#   不是因為群益端點本身出問題）。登記 00415A（群益台灣核心50，2026-10-20 掛牌，FinMind 無持股）。
#   fundId=504 取自群益官網產品頁網址 /etf/product/detail/504（搜尋結果標題「00415A 主動群益核心50」）；
#   舊碼的 00982A=399／00992A=500 同為產品頁編號，故推定 buyback 的 fundId 與產品頁編號同一套——
#   **此為推論，未以真實回應驗證**（沙箱連不到 capitalfund.com.tw）。
#
# 用法：python src/aetf_fallback.py          # 單獨實跑，印各檔結果不寫檔（診斷用）
#       由 build_aetf.py 匯入 fetch_fallback() 於主迴圈後補位。

from __future__ import annotations

import html as html_
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fin

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36"}
STOCK_RE = re.compile(r"^\d{4,6}$")


def fnum(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _norm(d) -> str:
    """日期一律正規化成 YYYY/MM/DD（統一回連字號、野村回斜線）。"""
    return str(d or "").replace("-", "/")[:10]


# ---------- 統一（ezmoney 頁面內嵌 JSON；TranDate 已是實際基準日） ----------
def grab_uni(fund_code: str) -> dict:
    s = requests.Session()
    s.headers.update(UA)
    r = s.get(f"https://www.ezmoney.com.tw/ETF/Fund/Info?FundCode={fund_code}", timeout=60)
    r.raise_for_status()
    h = html_.unescape(r.text)
    stocks, src_date = {}, None
    for o in re.findall(r'\{[^{}]*"DetailCode"[^{}]*\}', h):
        try:
            d = json.loads(o)
        except json.JSONDecodeError:
            continue
        if d.get("AssetCode") != "ST" or d.get("FundCode") != fund_code:
            continue
        src_date = src_date or _norm(d.get("TranDate"))
        c = str(d.get("DetailCode") or "").strip()
        sh = fnum(d.get("Share"))
        if STOCK_RE.match(c) and sh:
            stocks[c] = [round(sh), d.get("DetailName") or "", fnum(d.get("NavRate"))]
    if not stocks:
        raise RuntimeError("ezmoney 內嵌 JSON 無 ST 持股（頁面改版?）")
    return {"stocks": stocks, "src_date": src_date, "pcf_offset": 0}


# ---------- 野村（正式 API；CPcfdate 是 T+1 標記，需回推一個交易日） ----------
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
    e = (s.post(base + "GetFundTradeInfo", json=body, timeout=60).json().get("Entries") or {})
    stocks = {}
    for r in e.get("Stocks") or []:
        c = str(r.get("CStockCode") or "").strip()
        q = fnum(r.get("CQuantity"))
        if STOCK_RE.match(c) and q:
            stocks[c] = [round(q), r.get("CStockName") or "", fnum(r.get("CWeightsPct"))]
    if not stocks:
        raise RuntimeError("GetFundTradeInfo Stocks 為空")
    return {"stocks": stocks, "src_date": _norm(e.get("CPcfdate")), "pcf_offset": -1}


# ---------- 群益（buyback API；pcf.date1 是 T+1 標記，需回推一個交易日） ----------
CAPITAL_BUYBACK_URL = "https://www.capitalfund.com.tw/CFWeb/api/etf/buyback"


def parse_capital(payload) -> dict:
    """群益 buyback 回應 → {stocks, src_date, pcf_offset}。純函式，供離線測試。
    形狀（舊碼依據）：{"data": {"pcf": {"date1", "totUnit", "nav"}, "stocks": [{"stocNo","stocName","share","weight"}]}}"""
    if not isinstance(payload, dict):
        raise TypeError("buyback 回應不是 JSON 物件")
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        raise TypeError("buyback data 形狀不符")
    pcf = data.get("pcf") or {}
    stocks = {}
    for row in data.get("stocks") or []:
        if not isinstance(row, dict):
            continue
        c = str(row.get("stocNo") or "").strip()
        sh = fnum(row.get("share"))
        if STOCK_RE.match(c) and sh:
            stocks[c] = [round(sh), str(row.get("stocName") or "").strip(), fnum(row.get("weight"))]
    if not stocks:
        raise RuntimeError("buyback stocks 為空（無台股持股或頁面改版?）")
    src = _norm(pcf.get("date1") if isinstance(pcf, dict) else None)
    if not re.fullmatch(r"\d{4}/\d{2}/\d{2}", src):
        raise RuntimeError(f"buyback pcf.date1 無法解析（{src!r}）")
    return {"stocks": stocks, "src_date": src, "pcf_offset": -1}


def grab_capital(fund_id: str) -> dict:
    s = requests.Session()
    s.headers.update(UA)
    r = s.post(CAPITAL_BUYBACK_URL, json={"fundId": fund_id, "date": None}, timeout=60)
    r.raise_for_status()
    return parse_capital(r.json())


# 登記表：code → (投信, 抓取函式)。加新投信只動這裡＋新增對應 grab_*。
FETCHERS = {
    "00403A": ("統一", lambda: grab_uni("63YTW")),
    "00981A": ("統一", lambda: grab_uni("49YTW")),
    "00980A": ("野村", lambda: grab_nomura("00980A")),
    "00985A": ("野村", lambda: grab_nomura("00985A")),
    "00999A": ("野村", lambda: grab_nomura("00999A")),
    "00415A": ("群益", lambda: grab_capital("504")),   # fundId 推定，見檔頭
}


def trading_days(days_back: int = 30) -> list:
    """FinMind TAIEX 交易日曆（升冪 YYYY/MM/DD）；失敗回 []（→ 不做 T+1 折算，見 resolve_date）。"""
    try:
        rows = fin.api_get("TaiwanStockPrice", data_id="TAIEX",
                           start_date=(date.today() - timedelta(days=days_back)).isoformat())
        return sorted({_norm(r["date"]) for r in rows if r.get("date")})
    except Exception as e:
        print(f"[fallback] 交易日曆不可用（{e}）", flush=True)
        return []


def resolve_date(raw: str, offset: int, cal: list) -> str | None:
    """把來源標示的日期折算成實際持股基準日。offset=0 直接用；offset=-1 回推一個交易日。

    ⚠ offset=-1 不能用「在日曆裡找 raw 再往前一格」：野村的 PCF 日期是**下一個**交易日，
    執行當下那天還沒開盤、必然不在日曆內，那樣寫會永遠折算失敗（2026-07-31 00:23 實測）。
    正確作法是取「嚴格早於 raw 的最後一個交易日」，raw 在未來或在日曆內都成立。
    日曆抓不到時回 None——寧可不補位，也不寫入日期存疑的資料。"""
    if not raw:
        return None
    if offset == 0:
        return raw
    if not cal:
        return None
    earlier = [d for d in cal if d < raw]
    return earlier[-1] if earlier else None


def close_prices(day: str) -> dict:
    """該日全市場收盤價 {code: close}；失敗回 {}（市值欄留 None）。"""
    try:
        iso = day.replace("/", "-")
        rows = fin.api_get("TaiwanStockPrice", start_date=iso, end_date=iso)
        return {str(r["stock_id"]): fnum(r.get("close"))
                for r in rows if r.get("stock_id") and r.get("close") is not None}
    except Exception as e:
        print(f"[fallback] 收盤價不可用（{e}）", flush=True)
        return {}


def fetch_fallback(codes) -> dict:
    """對 codes 中有登記的 ETF 補位抓取。
    回 {code: {stocks, src_date, units, aum, fallback_src}}；抓不到／日期無法折算的檔不列入。
    stocks 形狀與 build_aetf.grab_holding 一致：{代號: [股數, 名稱, 權重%, 市值元]}。"""
    want = [c for c in codes if c in FETCHERS]
    if not want:
        return {}
    cal = trading_days()
    raw = {}
    for code in want:
        issuer, fn = FETCHERS[code]
        try:
            d = fn()
        except Exception as e:
            print(f"[fallback] {code} {issuer} 抓取失敗：{type(e).__name__}: {str(e)[:120]}", flush=True)
            continue
        sd = resolve_date(d["src_date"], d["pcf_offset"], cal)
        if not sd:
            print(f"[fallback] {code} {issuer} 日期無法折算（來源標 {d['src_date']}），略過", flush=True)
            continue
        raw[code] = (issuer, sd, d["stocks"])

    # 收盤價依基準日分組取，同一天只打一次 API
    px = {d: close_prices(d) for d in {v[1] for v in raw.values()}}
    out = {}
    for code, (issuer, sd, stocks) in raw.items():
        p, aum, filled = px.get(sd) or {}, 0.0, {}
        for c, v in stocks.items():
            mv = (v[0] * p[c]) if p.get(c) else None
            filled[c] = [v[0], v[1], v[2], round(mv) if mv else None]
            if mv:
                aum += mv
        # src_date 對外一律連字號，與 FinMind 主幹寫入的格式一致——同一個 latest.json
        # 內混用連字號與斜線會讓下游比對出錯（見 docs/date-semantics.md）。
        out[code] = {"stocks": filled, "src_date": sd.replace("/", "-"), "units": None,
                     "aum": round(aum) if aum else None,
                     "fallback_src": issuer}
        print(f"[fallback] {code} {issuer}: {len(filled)}檔 基準日 {sd}"
              f"{'' if p else '（無收盤價，市值留空）'}", flush=True)
    return out


if __name__ == "__main__":
    res = fetch_fallback(list(FETCHERS))
    print()
    for code, d in sorted(res.items()):
        t = d["stocks"].get("2330")
        print(f"{code} {d['fallback_src']}  基準日 {d['src_date']}  {len(d['stocks'])}檔  "
              f"台積電 {t[0] if t else '-'} 股  aum={d['aum']}")
    print(f"\n補位成功 {len(res)}/{len(FETCHERS)} 檔")
