#!/usr/bin/env python3
"""reconcile_daily.py — 免 token 的延後對帳（2026-11-18，規格 docs/chain-daily-recheck.md §2）。

對照來源：taiwan-flows 的 `data/daily/<YYYYMMDD>.json`（該站有 23:40 台北的延後驗證班
`verify_daily.py`，會拿權威源逐檔比對收盤價、必要時重抓）。用它重算本 repo 兩份產物裡
「可逐檔還原」的量，與已落檔的值比對：

  data/chain_daily/series.json  最近 RECON_DAYS 個交易日：市場總額、市場等權報酬、各鏈日成交額
  data/baseline.json            a5（前 5 日均額）、其加總、nh／nl（20 日創高／破底）、a20

**只讀、免 token、不寫任何資料檔**；不符 exit 1（workflow 轉紅 → notify-failure 開 issue），
「無法對帳」（對照檔 404、taiwan-flows 該日尚未經延後驗證、休市日…）只印 ::warning::、exit 0。

口徑只有一份：重算一律呼叫 `src/build_chain_daily.py` 的 `aggregate_day`／`keep_codes` 與
`src/build_baseline.py` 的 `stock_rows`（＝產物本身用的那幾支），本檔只做「把對照檔轉成
它們吃的輸入形狀」與「比對」，**不另寫聚合邏輯**。

── 已知口徑差（門檻要容忍的部分；2026-11-18 以 2026-10-05～11-18 共 30 個交易日實測）──
  - 對照檔少約 64–70 檔 twse 個股（特別股等；series 的 market.n 比對照檔重算值多這麼多），
    市場總額因此系統性偏高 0.17%～0.32%；47 鏈裡只有「金融」（18 檔特別股）天天偏高
    0.17%～0.80%，其餘鏈每日至多 1 條超過 0.1%。
  - 市場等權報酬差 ≤ 0.00102（0.10 個百分點）。
  - 對照檔金額單位是千元（本 repo 是元）→ 單檔 a5 有 <1,000 元的捨入差。
  - baseline：對照檔沒有的代號不比（列入「未比對」計數）；y1／y2（要最高／最低價）、
    it／fi／its／ints（法人）、subs_y 對照檔無法還原，**不對帳**。

── 門檻（寫死在下方常數；依據同上實測＋06-26 型事故模擬，細節見規格 §2）──
  市場總額相對差 > 1%（實測最大 0.32%）／市場等權報酬絕對差 > 0.003（實測最大 0.00102）／
  單鏈日成交額相對差 > 2%（實測最大 0.80%；兩邊至少一邊 ≥ 1 億才比）→ 不符。
  06-26 型模擬（每日把收盤價最高的 922 檔 twse 個股換成前一交易日的列，29 個交易日）：
  金額也是舊值時市場總額偏 3.9%～47.7%（29/29 天超過 1%）、每天 ≥40 條鏈超過 2%；
  baseline 那一天另有創高／破底旗標 245 檔不符（門檻約 21 檔）；
  只有價格是舊值、金額正確時靠市場等權報酬，26/29 天超過 0.003（漏掉的 3 天是相鄰兩日
  漲跌幅剛好接近）。**後者是本對帳的已知漏洞**：序列不存逐檔收盤，無法逐檔比價。

用法：
  python tools/reconcile_daily.py                          # 目標日＝台北現在回推 12 小時
  python tools/reconcile_daily.py --dates 2026-11-17,2026-11-18
  python tools/reconcile_daily.py --flows-dir ../taiwan-flows/data   # 讀本機 checkout（離線）
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import build_baseline as bl  # noqa: E402
import build_chain_daily as bc  # noqa: E402
import twse_holidays  # noqa: E402

TPE = timezone(timedelta(hours=8))
FLOWS_RAW = "https://raw.githubusercontent.com/shihpc/taiwan-flows/main/data"
FETCH_TIMEOUT_SEC = 30

RECON_DAYS = 3             # 每班對帳序列最近幾個交易日（延後驗證晚到時，隔天那班會補對）
TARGET_LAG_HOURS = 12      # 目標日＝台北現在回推 12 小時的日曆日（家族同一套，跨午夜延遲不滾日）
MARKET_AMT_TOL = 0.01      # 市場總額相對差
MARKET_RET_TOL = 0.003     # 市場等權報酬絕對差（小數；0.003＝0.3 個百分點）
CHAIN_AMT_TOL = 0.02       # 單鏈日成交額相對差
CHAIN_MIN_YI = 1.0         # 兩邊至少一邊 ≥ 這麼多億才比單鏈（兩邊都太小的鏈相對差沒有意義）
BASE_TOT_TOL = 0.01        # baseline：已比對個股的 a5 加總相對差
BASE_A5_TOL = 0.01         # baseline：單檔 a5 相對差超過這個算「這一檔不符」
BASE_A5_ABS = 100_000      # 　…且絕對差 > 10 萬元（濾掉千元捨入與冷門股）
BASE_BAD_MAX = 0.01        # baseline：a5 不符／nh‧nl 不符的檔數佔已比對檔數超過這個 → 不符

OK, MISMATCH, UNABLE, SKIP = "相符", "不符", "無法對帳", "略過"


# ------------------------------------------------------------------ 對照檔 → 輸入形狀

def flows_prices(doc: dict) -> dict[str, list]:
    """taiwan-flows 逐日檔 → build_chain_daily.aggregate_day 吃的 {code: [amt 元, close, spread]}。

    對照檔的 amt 是千元、chg_pct 是 %。chg_pct 與本 repo 的個股報酬同一定義
    （spread ÷ (close − spread) × 100），故反推 spread = close × chg ÷ (100 + chg)，
    `ret_of(close, spread)` 會還原成 chg ÷ 100。"""
    ix = {n: i for i, n in enumerate(doc["cols"])}
    out: dict[str, list] = {}
    for r in doc["rows"]:
        code = str(r[ix["code"]])
        close, chg, amt = r[ix["close"]], r[ix["chg_pct"]], r[ix["amt"]]
        spread = None
        if close is not None and chg is not None and (100 + chg) != 0:
            spread = close * chg / (100 + chg)
        out[code] = [(amt or 0) * 1000.0, close, spread]
    return out


def flows_verified(status: dict | None, ds: str) -> str | None:
    """對照檔的 ds 這一天能不能當對照。可以回 None；不行回原因（→ 無法對帳）。

    taiwan-flows 的 status.json 只描述「最新一天」：`healthcheck.date`＝該次健檢的資料日，
    `severity`＝pending（當天尚未經延後驗證）／ok／warn／critical。
    限制：健檢日已超過 ds 時，無從得知 ds 當時有沒有驗過（只能假設有）。"""
    if not isinstance(status, dict):
        return "taiwan-flows status.json 讀不到"
    hc = status.get("healthcheck")
    if not isinstance(hc, dict) or not isinstance(hc.get("date"), str):
        return "taiwan-flows status.json 無 healthcheck 資訊"
    hd, sev = hc["date"], hc.get("severity")
    if hd < ds:
        return f"taiwan-flows 尚未驗到這一天（healthcheck.date={hd}）"
    if hd == ds and sev not in ("ok", "warn"):
        return f"taiwan-flows 該日 healthcheck.severity={sev}（尚未通過延後驗證）"
    return None


def rel(a: float, b: float) -> float:
    """a 相對 b 的差（b 為 0 時：a 也 0 → 0，否則無限大）。"""
    if not b:
        return 0.0 if not a else float("inf")
    return a / b - 1


# ------------------------------------------------------------------ 比對（純函式）

def recon_chain_day(series: dict, ds: str, prices: dict, cmap: dict) -> dict:
    """series.json 的 ds 這一天 vs 用對照檔重算。回 {status, issues[], stats{}}。"""
    dates = series.get("dates") or []
    if ds not in dates:
        return {"status": UNABLE, "issues": [], "why": "序列沒有這一天", "stats": {}}
    i = dates.index(ds)
    agg = bc.aggregate_day(prices, cmap)
    m = agg["market"]
    if not m["amt"]:
        return {"status": UNABLE, "issues": [], "why": "對照檔重算的市場總額為 0", "stats": {}}
    issues: list[str] = []
    got = series["market"]["amt"][i]
    exp = m["amt"] / 1e8
    mrel = rel(got or 0.0, exp)
    if abs(mrel) > MARKET_AMT_TOL:
        issues.append(f"{ds} 市場總額：序列 {got} 億 vs 對照 {exp:.3f} 億，"
                      f"相對差 {mrel * 100:+.2f}%（門檻 {MARKET_AMT_TOL * 100:g}%）")
    g_ret, e_ret = series["market"]["ret_ew"][i], m["ret_ew"]
    rdiff = None
    if g_ret is not None and e_ret is not None:
        rdiff = g_ret - e_ret
        if abs(rdiff) > MARKET_RET_TOL:
            issues.append(f"{ds} 市場等權報酬：序列 {g_ret * 100:+.3f}% vs 對照 {e_ret * 100:+.3f}%，"
                          f"差 {rdiff * 100:+.3f} 個百分點（門檻 {MARKET_RET_TOL * 100:g}）")
    cmax, cmax_name, ncmp = 0.0, None, 0
    names = set(series.get("chains") or {}) | set(agg["chains"])
    for name in sorted(names):
        arr = ((series.get("chains") or {}).get(name) or {}).get("amt") or []
        g = arr[i] if i < len(arr) else None
        e = (agg["chains"].get(name) or {}).get("amt", 0.0) / 1e8
        g0 = g or 0.0
        if max(g0, e) < CHAIN_MIN_YI:
            continue
        ncmp += 1
        r = rel(g0, e)
        if abs(r) > abs(cmax):
            cmax, cmax_name = r, name
        if abs(r) > CHAIN_AMT_TOL:
            issues.append(f"{ds} 產業鏈「{name}」日成交額：序列 {g0:.3f} 億 vs 對照 {e:.3f} 億，"
                          f"相對差 {r * 100:+.2f}%（門檻 {CHAIN_AMT_TOL * 100:g}%）")
    stats = {"market_rel": mrel, "ret_diff": rdiff, "chain_max_rel": cmax,
             "chain_max_name": cmax_name, "chains_compared": ncmp,
             "n_series": series["market"]["n"][i], "n_ref": m["n"]}
    return {"status": MISMATCH if issues else OK, "issues": issues, "stats": stats}


def recon_baseline(baseline: dict, flows_by_day: dict[str, dict], cmap: dict) -> dict:
    """baseline.json vs 用對照檔重算的 a5／nh／nl／a20。

    flows_by_day＝{日期: flows_prices() 的結果}，必須涵蓋 baseline["days"] 全部日期
    （缺任何一天就回無法對帳——少一天 a5／a20／nh／nl 都會算錯，不能硬比）。"""
    days = baseline.get("days") or []
    stocks = baseline.get("stocks") or {}
    if len(days) < bl.NDAYS or not stocks:
        return {"status": UNABLE, "issues": [], "why": "baseline.json 的 days／stocks 不完整",
                "stats": {}}
    miss = [d for d in days[:bl.NDAYS] if not flows_by_day.get(d)]
    if miss:
        return {"status": UNABLE, "issues": [],
                "why": f"對照檔缺 {len(miss)} 天（{'、'.join(miss[:4])}{'…' if len(miss) > 4 else ''}）",
                "stats": {}}
    # 對照檔 → build_baseline 的 pd 形狀：每日 {c: (amt 元, close, high, low)}，新→舊。
    # 沒有最高／最低價（只影響 y1／y2，本來就不對帳）。
    pd = [{c: (v[0], v[1], None, None) for c, v in flows_by_day[d].items()}
          for d in days[:bl.NDAYS]]
    ref_codes = set().union(*[set(x) for x in pd[:5]])
    keep = bc.keep_codes(cmap) & ref_codes
    ref, _ = bl.stock_rows(pd, keep, {}, {}, {}, {}, {}, {})
    cmp_codes = sorted(set(ref) & set(stocks))
    if not cmp_codes:
        return {"status": UNABLE, "issues": [], "why": "沒有可比對的個股", "stats": {}}
    bad_a5, bad_flag, bad_a20 = [], [], []
    sum_g = sum_e = 0.0
    for c in cmp_codes:
        g, e = stocks[c], ref[c]
        sum_g += g[0]
        sum_e += e[0]
        if abs(g[0] - e[0]) > BASE_A5_ABS and abs(rel(g[0], e[0])) > BASE_A5_TOL:
            bad_a5.append((abs(g[0] - e[0]), c, g[0], e[0]))
        if len(g) > 8 and (g[6], g[8]) != (e[6], e[8]):
            bad_flag.append((c, (g[8], g[6]), (e[8], e[6])))
        if len(g) > 9 and abs(g[9] - e[9]) > BASE_A5_ABS and abs(rel(g[9], e[9])) > BASE_A5_TOL:
            bad_a20.append((abs(g[9] - e[9]), c, g[9], e[9]))
    n = len(cmp_codes)
    trel = rel(sum_g, sum_e)
    issues: list[str] = []
    d0 = baseline.get("date")
    if abs(trel) > BASE_TOT_TOL:
        issues.append(f"baseline {d0} 已比對 {n} 檔的 a5 加總：產物 {sum_g / 1e8:.2f} 億 vs "
                      f"對照 {sum_e / 1e8:.2f} 億，相對差 {trel * 100:+.2f}%（門檻 {BASE_TOT_TOL * 100:g}%）")
    for label, bad in (("a5（5 日均額）", bad_a5), ("a20（20 日均額）", bad_a20)):
        if len(bad) > n * BASE_BAD_MAX:
            top = "、".join(f"{c} {g / 1e8:.2f} 億 vs {e / 1e8:.2f} 億"
                           for _, c, g, e in sorted(bad, reverse=True)[:5])
            issues.append(f"baseline {d0} {label}不符 {len(bad)}/{n} 檔"
                          f"（門檻 {BASE_BAD_MAX * 100:g}%）；差最大：{top}")
    if len(bad_flag) > n * BASE_BAD_MAX:
        top = "、".join(f"{c} 產物(nh,nl)={g} 對照={e}" for c, g, e in bad_flag[:5])
        issues.append(f"baseline {d0} 創高／破底旗標不符 {len(bad_flag)}/{n} 檔"
                      f"（門檻 {BASE_BAD_MAX * 100:g}%）；例：{top}")
    stats = {"compared": n, "not_in_ref": len(set(stocks) - set(ref)), "tot_rel": trel,
             "bad_a5": len(bad_a5), "bad_a20": len(bad_a20), "bad_flag": len(bad_flag)}
    return {"status": MISMATCH if issues else OK, "issues": issues, "stats": stats}


def target_day(now_tpe: datetime) -> str:
    """目標交易日＝台北現在回推 TARGET_LAG_HOURS 小時的日曆日。"""
    return (now_tpe - timedelta(hours=TARGET_LAG_HOURS)).date().isoformat()


def pick_dates(series_dates: list[str], target: str, k: int = RECON_DAYS) -> list[str]:
    """序列中 ≤ 目標日的最近 k 個交易日（舊→新）。"""
    return [d for d in series_dates if d <= target][-k:] if k > 0 else []


# ------------------------------------------------------------------ 讀檔

class Flows:
    """對照檔讀取：給了本機目錄就讀目錄，否則走 raw URL。讀不到一律回 None（→ 無法對帳）。"""

    def __init__(self, local_dir: str | None = None, base_url: str = FLOWS_RAW, fetch=None):
        self.local = Path(local_dir) if local_dir else None
        self.base = base_url.rstrip("/")
        self._fetch = fetch or self._http
        self._cache: dict[str, dict | None] = {}

    @staticmethod
    def _http(url: str) -> bytes:
        req = urllib.request.Request(url, headers={"User-Agent": "reconcile-daily"})
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_SEC) as r:   # noqa: S310
            return r.read()

    def _get(self, relpath: str) -> dict | None:
        if relpath in self._cache:
            return self._cache[relpath]
        doc = None
        try:
            if self.local is not None:
                p = self.local / relpath
                doc = json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
            else:
                doc = json.loads(self._fetch(f"{self.base}/{relpath}").decode("utf-8"))
        except Exception as e:  # noqa: BLE001 — 404／逾時／壞 JSON 都是「讀不到」
            print(f"  （對照檔 {relpath} 讀不到：{type(e).__name__}）", flush=True)
            doc = None
        self._cache[relpath] = doc if isinstance(doc, dict) else None
        return self._cache[relpath]

    def status(self) -> dict | None:
        return self._get("status.json")

    def day(self, ds: str) -> dict | None:
        """回 flows_prices() 的結果；檔案不存在／形狀不合／檔內日期不是 ds → None。"""
        doc = self._get(f"daily/{ds.replace('-', '')}.json")
        try:
            if not doc or doc.get("date") != ds or not doc.get("rows"):
                return None
            return flows_prices(doc)
        except Exception:  # noqa: BLE001
            return None


# ------------------------------------------------------------------ 主流程

def run(series: dict, baseline: dict | None, classify: dict, flows: Flows, dates: list[str],
        cal=None) -> tuple[int, list[str]]:
    """回 (exit code, 報告行)。exit 1＝至少一項不符；其餘 0。"""
    cmap = classify["map"]
    lines: list[str] = []
    issues: list[str] = []
    status = flows.status()
    chain_block = None
    if series.get("classify_at") != classify.get("generated_at"):
        # 序列最後一次寫檔用的 classify 與現在的不同版 → 鏈的成員已變，現在重算必然對不上
        chain_block = (f"classify 已換版（序列 {series.get('classify_at')} ≠ 現行 "
                       f"{classify.get('generated_at')}），待下一班 baseline 重算後再對")
    verified: dict[str, str | None] = {}
    for ds in dates:
        why = twse_holidays.closed_reason(ds, cal)
        if why:
            lines.append(f"[{SKIP}] chain_daily {ds}：休市日（{why}）")
            continue
        why = chain_block or flows_verified(status, ds)
        verified[ds] = why
        prices = None if why else flows.day(ds)
        if why is None and prices is None:
            why = "對照檔不存在或讀不到"
        if why:
            lines.append(f"[{UNABLE}] chain_daily {ds}：{why}")
            continue
        r = recon_chain_day(series, ds, prices, cmap)
        if r["status"] == UNABLE:
            lines.append(f"[{UNABLE}] chain_daily {ds}：{r['why']}")
            continue
        s = r["stats"]
        lines.append(f"[{r['status']}] chain_daily {ds}：市場總額差 {s['market_rel'] * 100:+.3f}%、"
                     f"等權報酬差 {(s['ret_diff'] or 0) * 100:+.3f}pp、"
                     f"單鏈最大差 {s['chain_max_rel'] * 100:+.3f}%（{s['chain_max_name']}）、"
                     f"檔數 序列 {s['n_series']}／對照 {s['n_ref']}")
        issues += r["issues"]

    if baseline is not None:
        bd = baseline.get("date")
        if not isinstance(bd, str) or bd not in dates:
            lines.append(f"[{SKIP}] baseline {bd}：不在本次對帳日期內")
        elif twse_holidays.closed_reason(bd, cal):
            lines.append(f"[{SKIP}] baseline {bd}：休市日（{twse_holidays.closed_reason(bd, cal)}）")
        else:
            why = flows_verified(status, bd)
            if why:
                lines.append(f"[{UNABLE}] baseline {bd}：{why}")
            else:
                by_day = {d: flows.day(d) for d in (baseline.get("days") or [])[:bl.NDAYS]}
                r = recon_baseline(baseline, by_day, cmap)
                if r["status"] == UNABLE:
                    lines.append(f"[{UNABLE}] baseline {bd}：{r['why']}")
                else:
                    s = r["stats"]
                    lines.append(f"[{r['status']}] baseline {bd}：比對 {s['compared']} 檔"
                                 f"（對照檔沒有 {s['not_in_ref']} 檔）、a5 加總差 {s['tot_rel'] * 100:+.3f}%、"
                                 f"a5 不符 {s['bad_a5']} 檔、a20 不符 {s['bad_a20']} 檔、"
                                 f"創高／破底不符 {s['bad_flag']} 檔")
                    issues += r["issues"]
    return (1 if issues else 0), lines + [f"::error::{x}" for x in issues]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="以 taiwan-flows 已驗證的逐日檔對帳 chain_daily／baseline")
    ap.add_argument("--dates", default="", help="逗號分隔 YYYY-MM-DD；省略＝目標日往前 RECON_DAYS 個交易日")
    ap.add_argument("--days", type=int, default=RECON_DAYS, help=f"對帳幾個交易日（預設 {RECON_DAYS}）")
    ap.add_argument("--flows-dir", default=None, help="taiwan-flows 的 data/ 目錄（本機 checkout）；省略走 raw URL")
    ap.add_argument("--series", default=str(ROOT / "data" / "chain_daily" / "series.json"))
    ap.add_argument("--baseline", default=str(ROOT / "data" / "baseline.json"))
    ap.add_argument("--classify", default=str(ROOT / "data" / "classify.json"))
    ap.add_argument("--no-baseline", action="store_true", help="只對 chain_daily")
    a = ap.parse_args(argv)

    series = json.loads(Path(a.series).read_text(encoding="utf-8"))
    classify = json.loads(Path(a.classify).read_text(encoding="utf-8"))
    baseline = None
    if not a.no_baseline and Path(a.baseline).exists():
        baseline = json.loads(Path(a.baseline).read_text(encoding="utf-8"))
    cal = twse_holidays.load()
    now = datetime.now(TPE)
    explicit = bool(a.dates.strip())
    if explicit:
        dates = []
        for x in a.dates.split(","):
            x = x.strip()
            if not x:
                continue
            try:
                date.fromisoformat(x)
            except ValueError:
                ap.error(f"--dates 日期格式不合：{x!r}")
            dates.append(x)
        print(f"對帳日期（指定）：{'、'.join(dates)}")
    else:
        tgt = target_day(now)
        why = twse_holidays.closed_reason(tgt, cal)
        if why:
            print(f"目標日 {tgt} 休市（{why}），不對帳")
            return 0
        dates = pick_dates(series.get("dates") or [], tgt, a.days)
        print(f"台北現在 {now:%Y-%m-%d %H:%M}，目標日 {tgt}；對帳日期：{'、'.join(dates) or '（無）'}")

    rc, lines = run(series, baseline, classify, Flows(a.flows_dir), dates, cal)
    for ln in lines:
        if ln.startswith(f"[{UNABLE}]"):
            print(f"::warning::{ln}")
        else:
            print(ln)
    summ = os.environ.get("GITHUB_STEP_SUMMARY")
    if summ:
        with open(summ, "a", encoding="utf-8") as f:
            f.write("### 延後對帳（taiwan-flows 逐日檔 vs chain_daily／baseline）\n\n")
            for ln in lines:
                f.write(f"- {ln.replace('::error::', '**不符** ')}\n")
    print("結果：" + ("有不符項目（見上方 ::error::）" if rc else "無不符（相符或無法對帳）"))
    return rc


if __name__ == "__main__":
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
