# src/build_chain_daily.py — 產 data/chain_daily/series.json（盤後日頻 RRG 的鏈層日序列）
#
# 動機：盤後日頻 RRG 的跨日穩定度不足，根因是樣本太短（daysummary 只有 18 天、
#   intraday 15 天，實務 RRG 要 10~14 期移動平均＋判定穩定度的樣本，至少 40 個交易日）。
#   本檔用 FinMind 日線 × data/classify.json 回補鏈層日頻序列，一次拿回數百個交易日。
#   規格見 docs/rrg-daily-spec-20260811.md §2。
#
# ── 口徑（與盤中版一致，改前務必讀完）──────────────────────────────────────
# 盤中版 share_i(t) 的口徑（docs/rrg-spec-20260809.md §4、worker/src/index.js 的
# `export function aggregate` 內 `for (const nd of info.c) acc(ch, ...)`）是：
#   (a) **個股層**聚合，依 classify 的 `c`（產業鏈陣列）歸戶，同一檔在同一條鏈只算一次；
#   (b) 只計 `info.t === "twse"`；
#   (c) 佔比分母＝市場總額 `market.tse.amt_yi`（＝全部 twse 個股成交額加總，**含 ETF**），
#       **不可**用鏈加總——多對多歸屬會重複計數（47 條鏈的 share 加總遠大於 1）。
# 本檔資料源是個股日線，直接在個股層歸戶即可，**不需要** build_rrg_base.py 那種
# 「跨多鏈的次產業金額均分」——那是因為 intraday 的 `g` 只有次產業層、無法回到個股層
# 才做的近似（見 src/build_rrg_base.py 檔頭「口徑」段）。本檔沒有這個限制。
#
# classify 的 twse 個股中 `c` 與 `{p[0]}` 兩個集合**完全相同**（2026-08-11 實測 1537 檔
# 全數相等），故本檔用 `c` 歸戶與 daysummary 的 chain_top5（用 `p[0]`，見
# src/build_daysummary.py 的 `def agg_multi` level=0）在歸戶面等價；唯一差別是
# daysummary 另有 `n_stk >= 3` 的顯示層過濾，本檔不濾（門檻只作用於顯示層，規格 §5）。
# ────────────────────────────────────────────────────────────────────
#
# ── 個股報酬用「spread ÷ 前收」而非「close ÷ 前日 close − 1」────────────────
# FinMind TaiwanStockPrice 的 `spread`（漲跌價差）是交易所口徑，**除權息日以除息
# 參考價為基準**，天生已還原股利；而 close/prev_close−1 會把除息當成暴跌。
# 實測 2026-08-11：合庫金 close/prev−1 = −8.05%、第一金 −6.44%、群益證 −11.24%，
# 三檔 spread 皆為 0（當日平盤）——若用 close 比值，「金融」鏈當日報酬會被除息假跌
# 汙染數個百分點。故個股一律用：
#   prev_close = close − spread；ret = spread ÷ prev_close
# 副作用（好處）：**單日計算完全自足**，不需要前一交易日的資料，增量更新可逐日獨立。
#
# 但 `spread` 本身有偶發缺陷：`spread == 0` 同時是合法的「平盤」與「這一格沒資料」
# 的表現，兩者在單日資料裡無法分辨。實測（2026-08-11，283 個交易日 297,358 個
# stock-day）有 163 個 stock-day（0.055%）`spread == 0` 但 close 高於前一交易日
# 收盤——上漲不可能來自除權息，這些是資料缺陷。量級可忽略（最嚴重單日
# 2026-06-22 讓市場等權報酬低估 0.046pp），故**不改動報酬值**（見下），但逐日
# 記錄偵測筆數到 quality.sp0_up／sp0_n，讓下游看得到。
#   為何只記錄不修正：(a) 量級 0.05pp；(b) 反方向（close 低於前收且 spread==0）
#   絕大多數是除權息的正常表現（實測 2,623 筆），無法與缺陷區分，任何「補值」
#   規則都會是不對稱的、反而引入偏誤；(c) 修正需要前一交易日資料，會毀掉
#   「單日自足」這個讓增量更新健壯的性質。
# ────────────────────────────────────────────────────────────────────
#
# ── 指數（TAIEX）報酬**不能**用 spread，一律用 close 比值 ───────────────────
# 2026-08-11 發現：FinMind 的 TAIEX 列在 2026-02-02~02-11、02-23~02-26 共 12 個
# 交易日是壞資料（`Trading_money == 0` 且 `spread == 0`），但指數當日實際移動最大
# 達 +2.75%。照 spread 收下會讓這 12 天的 taiex_ret 全為 0，**且完全靜默**。
# 後果實測（2026-08-11，283 個交易日）：全期日報酬算術加總從 65.3%（錯，精確
# 65.33%）變成 75.4%（對，精確 75.41%），與市值加權報酬的差距從 13.2pp 縮到 3.1pp，
# 相關係數 0.9781 → 0.9983。
# 為什麼指數用 close 比值是對的（不是權宜）：
#   1. TAIEX 是**價格指數、本來就不還原股利**，close 比值就是它的定義；
#      「用 spread 以避開除權息假跌」這個理由只適用於個股，不適用於指數。
#   2. 可自我對帳：22,049.90 → 45,120.72 ＝ +104.63%，close 比值逐日連乘剛好
#      是 +104.63%（誤差 <1e-5）；spread 版連乘只有 +85.27%，缺口正是這 12 天。
# 代價是指數報酬不再單日自足（要前一交易日收盤）。實作把它放在 columnar()、
# 從已落檔的 taiex 收盤序列現算，所以：(a) 舊檔重跑即自動修正，不必 --rebuild；
# (b) 只有序列相鄰的兩天才算，若 dates[i-1] 不是 dates[i] 的前一個交易日
# （prev_trading_day 判定，用已知非交易日名單），寧可標成 None 也不給橫跨缺口的
# 假報酬——序列第一天因此必為 None。
# ────────────────────────────────────────────────────────────────────
#
# 輸出（單一檔，理由見下）data/chain_daily/series.json：
#   {generated_at, source, classify_at, units, note,
#    dates: [YYYY-MM-DD...]（舊→新）,
#    market: {amt, n, ret_ew, ret_mw, taiex, taiex_ret},
#    chains: {鏈名: {amt, n, share, ret_ew, ret_mw}},
#    coverage: {topn, dup, split, union}   ← Top-N 覆蓋率的三種定義，逐日
#    quality: {mw_cov, sp0_up, sp0_n, tx_spread0}  ← 逐日資料品質診斷
#    meta: {...統計與已知限制...}}
#   所有 value 都是與 dates 等長的陣列（columnar）；缺值為 null。
#   單位：amt = 億元、share = 小數（0.434 ＝ 43.4%）、ret = 小數（0.0123 ＝ +1.23%）。
#
#   coverage / quality 為什麼要逐日存而不是只存一個總數：**只存總數的欄位在增量
#   更新時會被「當天那一格」蓋掉**。2026-08-11 實測 meta.mw_amt_coverage 就踩到：
#   隔日增量只新算 1 天，該欄位便從全期平均 0.9992 變成當天的 1.0，而報告是逐字
#   讀這個欄位的。凡是「要對全期取平均／彙總」的量，一律逐日落檔、彙總值由
#   全序列現算（meta 內所有彙總欄位都是這樣來的）。
#
# 為什麼是單一檔而不是分日檔：
#   1. 用途決定讀法。RRG 要的是「一次讀進整段時間序列」（10~14 期移動平均＋穩定度
#      統計），不是「讀某一天」。分日檔會讓前端／回測為了畫一張圖打數十~數百次請求，
#      與 data/rrg_base.json、data/baseline.json 的既有慣例也不一致。
#   2. 體積。columnar 版把鏈名當 key 只寫一次；分日檔每檔都要重寫 47 個中文鏈名＋
#      欄位名，光 key 就是純冗餘。同規模合成對照（286 天 × 47 鏈 × 5 欄）實測：
#      單檔 521 KB vs 分日檔合計 1,136 KB（2.2 倍）。實際產出 283 天為 568 KB。
#   3. git 增量。columnar 陣列是 append-only，相鄰兩版共用極長的前綴，packfile 的
#      delta 壓縮吃得下；分日檔則是每天新增一個獨立 blob（不會 delta）。
#      同一組合成對照實測 `git gc --aggressive` 後：單檔連續兩版 219 KiB、
#      分日檔 286 個檔 382 KiB。
#   代價：每次更新整檔重寫。以本檔規模（數百 KB）與每日一次的頻率可接受。
#
# 增量更新：
#   - 已在 series.json 的日期不重算、不重抓（單日自足，見上）——**但最近 RECHECK_DAYS 個
#     交易日例外**（2026-11-18，docs/chain-daily-recheck.md）：每班重抓重算並覆寫，
#     見下方「近日重抓」常數段與 `def recheck_reject_reason`。
#   - 原始日線落地在 backtest/cache/chainday_YYYY-MM-DD.json.gz（已被 .gitignore 擋住），
#     重跑／--rebuild 時免再打 API。
#   - **cache 格式 v2 起與 classify 脫鉤**：落檔的是「代號開頭為數字」的全部個股
#     （不再先用 classify 的 t 濾一輪）＋ _TAIEX，並記下當時的 classify_at。
#     v1（2026-08-11 之前）落的是**已用當時 classify 過濾**的結果——classify 換版
#     新增個股（新上市）或新增鏈時，從 v1 cache 重算會靜默漏掉那些檔，而且無從偵測。
#     故 --rebuild 遇到 v1 或 classify_at 不符的 cache 會**明確警告並列出天數**；
#     要真的重抓請加 --refetch-stale（會打 API，一天一次請求）。
#   - 非交易日記進 meta.nontrading，之後不再探測；但**近 FRESH_GUARD 日內不寫入**
#     這個名單（當日資料可能只是還沒入庫，不能永久標成休市）。
#     API 錯誤會由 fin.api_get 拋例外、被逐日 catch 住並「略過不快取」，
#     只有「HTTP 200 但 data 為空」才會落成休市標記；萬一仍誤標，
#     刪掉 backtest/cache/chainday_<date>.json.gz 並從 meta.nontrading 移除該日即可重抓。
#
# 局限（會寫進輸出的 meta 與 backtest/report_rrg_daily.md）：
#   - classify.json 是**當前版本**（本次 2026-08-01 產生），不是各交易日當時的版本。
#     產業鏈分類月更、上市／下市／改分類都會讓歷史日被今天的分類回頭套用。
#   - 市值加權用 classify 的 `sh`（發行張數）＝**當前**發行股數，非各日當時股數；
#     增減資／股票分割會讓歷史權重失真。`sh` 缺漏者（特別股如 2891A 等）不計入
#     市值加權，但仍計入等權與成員檔數。
#   - 資料源與盤中版不同：本檔用 FinMind 日線 Trading_money（含盤中零股、盤後定價），
#     盤中版用 tick snapshot 的 total_amount（僅整股盤中）。金額水準系統性偏高
#     （2026-08-11 全市場 +3.75%），但**佔比**差異被分母吸收掉大半（見報告的交叉驗證段）。
#
# 用法：
#   python src/build_chain_daily.py                    # 增量（缺哪天抓哪天）
#   python src/build_chain_daily.py --start 2025-06-16 --end 2026-08-11
#   python src/build_chain_daily.py --rebuild          # 用 cache 重算全部（不重抓）
#   python src/build_chain_daily.py --rebuild --refetch-stale   # classify 換版後
#   python src/build_chain_daily.py --recheck-dates 2026-11-17,2026-11-18   # 只重抓指定日
#   token 走 src/fin.py 的既有機制（環境變數 FINMIND_TOKEN 或 repo 根 .env），
#   不寫進任何會 commit 的檔案。

from __future__ import annotations

import argparse
import gzip
import io
import json
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fin  # noqa: E402

ROOT = fin.ROOT
CLASSIFY = ROOT / "data" / "classify.json"
OUT = ROOT / "data" / "chain_daily" / "series.json"
CACHE = ROOT / "backtest" / "cache"          # 已在 .gitignore（backtest/cache/）
TPE = timezone(timedelta(hours=8))

START_DEFAULT = "2025-06-16"   # 與 backtest/fetch.py 的 START 對齊（≈285 個交易日）
MIN_DAYS = 120                 # 規格 §2 完成定義 1：至少 120 個交易日
FRESH_GUARD = 5                # 近 N 個日曆日的空回應不標記為非交易日（可能只是還沒入庫）
SLEEP = 0.5                    # 每次 API 之間的客氣間隔（同 backtest/fetch.py 的作法）
SIGDIG = 6
MWCOV_DIG = 6                  # mw_amt_coverage 的有效位數（4 位會讓下游印出假精度，見 mw_amt_coverage_of）
TAIEX = "_TAIEX"
TOPN = 10                      # 覆蓋率診斷的 N（規格 §5：畫布錨點＝成交額 Top 10）
CACHE_V = 2                    # cache 格式版本（v2 起與 classify 脫鉤，見檔頭）

# ── 近日重抓（2026-11-18，規格 docs/chain-daily-recheck.md §1）────────────────
# 起因：全市場單日 TaiwanStockPrice 是「非空即採用」，而已在序列裡的日期原本永不重抓。
# FinMind 當日資料若在首班時尚未更新完（taiwan-flows 2026-06-26 事故同一資料集：
# 2,687 檔中 922 檔是暫定值、列數完全正常），錯值會永久留在序列裡。
# 修法：一般（增量）模式每班把序列**最近 RECHECK_DAYS 個交易日**重抓重算並覆寫。
#   3 天的理由：baseline 班每個交易日至少跑兩次（Worker 20:05 主觸發＋21:15 備援 cron），
#   一個交易日因此會在當日晚班、次一、次二、次三個交易日的班次各被重抓一輪（合計 ≥6 次），
#   足以跨過「當晚未更新完」與連假前後的延遲入庫；再多只是多打 API。
# 防護（寧可不改也不改壞；被拒絕的一律保留既有值並印 ::warning::、不讓整班失敗）：
#   - 抓取失敗／回空／聚合後市場總額為 0 → 保留既有值；
#   - 重抓資料「明顯較差」→ 不覆寫（`def recheck_reject_reason`）：
#       成員檔數 n < 既有 × RECHECK_MIN_N_RATIO、或市場總額 < 既有 × RECHECK_MIN_AMT_RATIO、
#       或既有有指數收盤而重抓沒有。
#     序列裡可比的完整性指標只有 market.n（當日有列的 twse 個股數）與 market.amt，
#     **不另加欄位**（不改形狀）。限制：「列數正常但數值是舊值」（06-26 型）這兩個指標
#     看不出來——那由 tools/reconcile_daily.py 的延後對帳負責。
#   - 手動修復確定要蓋掉時用 --recheck-force 繞過「明顯較差」防護（失敗／回空仍保留）。
RECHECK_DAYS = 3
RECHECK_MIN_N_RATIO = 0.98     # classify 月更的成員增減遠小於 2%；少 2% 以上＝資料不完整
RECHECK_MIN_AMT_RATIO = 0.90   # 更正通常讓金額持平或增加；驟降 10% 以上視為抓到殘缺資料


# ------------------------------------------------------------------ 小工具

def sig(x: float | None, n: int = SIGDIG) -> float | None:
    """保留 n 位有效位數（壓體積）；None 原樣回傳。"""
    if x is None:
        return None
    return float(f"{x:.{n}g}")


def ret_of(close, spread):
    """交易所口徑日報酬：spread ÷ (close − spread)。除權息日已由 spread 還原。

    close/spread 任一為 None、或推得的前收 ≤ 0（新上市無前收、資料異常）→ None。"""
    if close is None or spread is None:
        return None
    prev = close - spread
    if prev <= 0:
        return None
    return spread / prev


def prev_close_of(close, spread):
    """前一交易日收盤（市值加權的權重基準；避免用當日收盤造成當日報酬自我加權）。"""
    if close is None or spread is None:
        return None
    prev = close - spread
    return prev if prev > 0 else None


def wmean(pairs):
    """加權平均；pairs=[(值, 權重)]。權重總和 ≤0 → None。"""
    tw = sum(w for _, w in pairs)
    if tw <= 0:
        return None
    return sum(v * w for v, w in pairs) / tw


def mean(xs):
    return (sum(xs) / len(xs)) if xs else None


def mw_amt_coverage_of(qual: dict) -> float | None:
    """市值加權成交額覆蓋率的**全期平均**（不是最後一天）。

    抽成獨立純函式的理由（2026-08-11 複驗抓到）：這段邏輯原本內嵌在 build() 裡，
    build() 要 cache／API 才跑得動，測試只能對「已落檔的 series.json」斷言——
    把邏輯改回舊版的 bug（只取最後一天）測試仍會全綠，要等產物重建才變紅。
    抽出來後 backtest/test_rrg_daily_smoke.py 的 test_mw_amt_coverage_is_full_period_mean
    可以直接對邏輯下斷言。

    精度用 MWCOV_DIG（6）而非預設 SIGDIG：實值 0.9991686 用 4 位有效位數存成 0.9992，
    下游印 3 位小數會得到「99.920%」，第 3 位小數純粹是四捨五入產物（假精度）。"""
    return sig(mean([v for v in (qual.get("mw_cov") or []) if v is not None]), MWCOV_DIG)


def is_etf(code: str) -> bool:
    """與 worker/src/index.js `aggregate` 的 `const etf = code.startsWith("00")` 同義。"""
    return code.startswith("00")


def prev_trading_day(ds: str, nontrading) -> str | None:
    """ds 之前最近的一個「應為交易日」的日期（跳過週末與已知非交易日）。

    用途：確認 close 比值的兩端真的相鄰。序列若有未解釋缺口，close[i]/close[i-1]
    會橫跨多個交易日，寧可標成缺值也不要給一個看起來正常的假報酬。"""
    d = date.fromisoformat(ds) - timedelta(days=1)
    nt = set(nontrading)
    for _ in range(40):                      # 40 個日曆日足以跨過最長的農曆年連假
        if d.weekday() < 5 and d.isoformat() not in nt:
            return d.isoformat()
        d -= timedelta(days=1)
    return None


def spread_zero_up(prices: dict[str, list], prev_prices: dict[str, list],
                   cmap: dict) -> tuple[int, int]:
    """`spread == 0` 但收盤高於前一交易日收盤的 stock-day 筆數（見檔頭「spread 缺陷」）。

    回 (命中數, 檢查數)。只算 twse 非 ETF、且兩天都有價的個股。
    **只看上漲方向**：下跌方向的 spread==0 絕大多數是除權息的正常表現
    （除息參考價下修 → close < 前收但當日平盤），無法與資料缺陷區分。"""
    hit = chk = 0
    for code, row in prices.items():
        if code.startswith("_") or is_etf(code):
            continue
        info = cmap.get(code)
        if not info or info.get("t") != "twse":
            continue
        pr = prev_prices.get(code)
        if not pr:
            continue
        close, spread, pclose = row[1], row[2], pr[1]
        if close is None or spread is None or not pclose:
            continue
        chk += 1
        if spread == 0 and close > pclose:
            hit += 1
    return hit, chk


# ------------------------------------------------------------------ 純計算核心

def keep_codes(cmap: dict) -> set[str]:
    """上市櫃且代號開頭為數字的個股（同 backtest/fetch.py 的 keep）。

    開頭非數字者是 FinMind 混在 TaiwanStockPrice 裡的指數列（TAIEX／Semiconductor／
    FinancialInsurance…，classify 也給了 t=twse），**必須排除**，否則市場總額會被
    指數列的成交金額灌爆。

    v2 起 **不再拿它當 cache 的過濾器**（那會把 cache 綁死在當時的 classify，
    見檔頭「cache 格式 v2」）；保留是為了 aggregate 前的口徑說明與測試。"""
    return {c for c, v in cmap.items() if v.get("t") in ("twse", "tpex") and c[:1].isdigit()}


def rows_to_prices(rows: list, keep: set[str] | None = None) -> dict[str, list]:
    """FinMind TaiwanStockPrice 原始列 → {code: [amt, close, spread]}（另存 _TAIEX）。

    keep=None（cache v2 的作法）：留下**全部代號開頭為數字**的列，不看 classify。
    指數列（TAIEX/Semiconductor/…）開頭非數字，一樣被擋掉；新上市的個股即使還沒
    進 classify 也會落檔，classify 換版後從 cache 重算才不會靜默漏掉。
    keep=集合：舊行為，只留集合內的代號。"""
    out: dict[str, list] = {}
    for r in rows:
        c = str(r.get("stock_id") or "")
        if c == "TAIEX":
            out[TAIEX] = [r.get("Trading_money"), r.get("close"), r.get("spread")]
        elif (c in keep) if keep is not None else c[:1].isdigit():
            out[c] = [r.get("Trading_money"), r.get("close"), r.get("spread")]
    return out


def topn_coverage(prices: dict[str, list], cmap: dict, ch_amt: dict[str, float],
                  ch_amt_sp: dict[str, float], m_amt: float) -> dict:
    """Top-N 覆蓋率的**三種定義**（同一天可以差 17pp，不可混用，見報告同名段）。

    - `dup`   分子分母都用「重複計數」的鏈金額：TopN 鏈加總 ÷ 全部鏈加總。
              多對多歸屬讓分母遠大於市場總額（47 條鏈加總 ≈ 市場的 1.6 倍），
              **這個定義與盤中版的 70.7% 不可比**。
    - `split` 跨鏈成員金額均分後：TopN ÷ 成員總額（分母 ≈ 市場總額）。
              **這才是 backtest/run_rrg_topn.py 算 70.7% 用的口徑**（那支從
              次產業層均分上來，見其 `def subs_to_chains`），是唯一可比的一個。
    - `union` TopN 鏈的**成員聯集**成交額 ÷ 市場總額。回答「畫布上這 10 條
              涵蓋了幾成市場成交」這個直覺問題，成員重疊只算一次。
    """
    if not ch_amt or not m_amt:
        return {"dup": None, "split": None, "union": None}
    dup_v = sorted(ch_amt.values(), reverse=True)
    sp_v = sorted(ch_amt_sp.values(), reverse=True)
    tot_dup, tot_sp = sum(dup_v), sum(sp_v)
    top = {c for c, _ in sorted(ch_amt.items(), key=lambda kv: -kv[1])[:TOPN]}
    u = 0.0
    for code, row in prices.items():
        if code.startswith("_"):
            continue
        info = cmap.get(code)
        if not info or info.get("t") != "twse":
            continue
        if top & set(info.get("c") or []):
            u += row[0] or 0.0
    return {"dup": (sum(dup_v[:TOPN]) / tot_dup) if tot_dup else None,
            "split": (sum(sp_v[:TOPN]) / tot_sp) if tot_sp else None,
            "union": u / m_amt}


def aggregate_day(prices: dict[str, list], cmap: dict) -> dict:
    """單日聚合（純函式，離線可測）。

    prices: {code: [amt, close, spread]}（含 _TAIEX）。cmap: classify.json 的 map。
    回 {"market": {...}, "chains": {鏈名: {...}}, "cov": {...}}，
    金額單位為元（寫檔時才換算成億）。
    **market 不含 taiex_ret**——指數報酬由 columnar() 用 close 比值算（見檔頭）。

    口徑（見檔頭）：只計 t=="twse"；個股層依 `c` 去重（set 天然去重）；
    市場總額含 ETF（與 worker 的 market.tse.amt_yi 一致）；
    報酬與市值加權**排除 ETF**（ETF 不是指數成分、且會與成分股重複計價；
    與 worker `aggregate` 內 pts 的 `!etf` 條件同義）。"""
    m_amt = 0.0
    m_n = 0
    m_rets: list[float] = []
    m_wpairs: list[tuple[float, float]] = []

    ch_amt: dict[str, float] = defaultdict(float)
    ch_amt_sp: dict[str, float] = defaultdict(float)   # 跨鏈金額均分版（覆蓋率診斷用）
    ch_n: dict[str, int] = defaultdict(int)
    ch_rets: dict[str, list[float]] = defaultdict(list)
    ch_wpairs: dict[str, list[tuple[float, float]]] = defaultdict(list)
    mw_amt_cov = 0.0     # 有 sh 可算市值權重的成員成交額（覆蓋率診斷用）
    mem_amt = 0.0        # 全部鏈成員成交額（去重後的個股層，非鏈加總）

    for code, row in prices.items():
        if code.startswith("_"):
            continue
        info = cmap.get(code)
        if not info or info.get("t") != "twse":
            continue
        amt, close, spread = (row + [None, None, None])[:3]
        amt = amt or 0.0
        m_amt += amt
        m_n += 1

        etf = is_etf(code)
        r = None if etf else ret_of(close, spread)
        pc = None if etf else prev_close_of(close, spread)
        sh = info.get("sh") or 0
        w = (sh * pc) if (sh and pc) else None

        if r is not None:
            m_rets.append(r)
            if w:
                m_wpairs.append((r, w))

        cs = set(info.get("c") or [])       # set：同一檔在同一條鏈只算一次
        if not cs:
            continue
        mem_amt += amt
        if w:
            mw_amt_cov += amt
        per = amt / len(cs)
        for name in cs:
            ch_amt[name] += amt
            ch_amt_sp[name] += per
            ch_n[name] += 1
            if r is not None:
                ch_rets[name].append(r)
                if w:
                    ch_wpairs[name].append((r, w))

    tx = prices.get(TAIEX) or [None, None, None]
    market = {
        "amt": m_amt,
        "n": m_n,
        "ret_ew": mean(m_rets),
        "ret_mw": wmean(m_wpairs),
        "taiex": tx[1],
        # 指數的 spread 只留著當「這一列是不是壞資料」的旗標，不拿來算報酬（見檔頭）
        "_tx_spread0": None if tx[2] is None else int(tx[2] == 0),
        "_mw_cov": (mw_amt_cov / mem_amt) if mem_amt else None,
    }
    chains = {}
    for name in ch_amt:
        chains[name] = {
            "amt": ch_amt[name],
            "n": ch_n[name],
            "share": (ch_amt[name] / m_amt) if m_amt else None,
            "ret_ew": mean(ch_rets[name]),
            "ret_mw": wmean(ch_wpairs[name]),
        }
    return {"market": market, "chains": chains,
            "cov": topn_coverage(prices, cmap, ch_amt, ch_amt_sp, m_amt)}


def weekdays(start: date, end: date) -> list[str]:
    out, d = [], start
    while d <= end:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def columnar(days: dict[str, dict], chain_names: list[str],
             nontrading=()) -> tuple[list, dict, dict, dict, dict]:
    """{date: 單日聚合} → (dates, market, chains, coverage, quality)；缺值補 None。

    `market["taiex_ret"]` 在這裡由 taiex 收盤序列現算（close 比值，見檔頭），
    **不是**從 days 帶進來的——這讓舊檔重跑就自動修正，不必 --rebuild。
    `nontrading` 用來確認相鄰兩筆真的是相鄰交易日（prev_trading_day）。"""
    dates = sorted(days)
    market = {k: [] for k in ("amt", "n", "ret_ew", "ret_mw", "taiex", "taiex_ret")}
    chains = {c: {k: [] for k in ("amt", "n", "share", "ret_ew", "ret_mw")} for c in chain_names}
    cov = {k: [] for k in ("dup", "split", "union")}
    qual = {k: [] for k in ("mw_cov", "sp0_up", "sp0_n", "tx_spread0")}
    for d in dates:
        row = days[d]
        m = row["market"]
        market["amt"].append(sig(m["amt"] / 1e8, 7) if m.get("amt") is not None else None)
        market["n"].append(m.get("n"))
        market["ret_ew"].append(sig(m.get("ret_ew"), 5))
        market["ret_mw"].append(sig(m.get("ret_mw"), 5))
        market["taiex"].append(m.get("taiex"))
        cv = row.get("cov") or {}
        for k in cov:
            cov[k].append(sig(cv.get(k), 5))
        q = row.get("qual") or {}
        qual["mw_cov"].append(sig(m.get("_mw_cov") if m.get("_mw_cov") is not None
                                  else q.get("mw_cov"), 6))
        qual["sp0_up"].append(q.get("sp0_up"))
        qual["sp0_n"].append(q.get("sp0_n"))
        qual["tx_spread0"].append(m.get("_tx_spread0") if m.get("_tx_spread0") is not None
                                  else q.get("tx_spread0"))
        for c in chain_names:
            v = (row["chains"] or {}).get(c)
            t = chains[c]
            if not v:
                for k in t:
                    t[k].append(None)
                continue
            t["amt"].append(sig(v["amt"] / 1e8, 7))
            t["n"].append(v["n"])
            t["share"].append(sig(v["share"]))
            t["ret_ew"].append(sig(v["ret_ew"], 5))
            t["ret_mw"].append(sig(v["ret_mw"], 5))

    tx = market["taiex"]
    for i, d in enumerate(dates):
        r = None
        if i and prev_trading_day(d, nontrading) == dates[i - 1]:
            a, b = tx[i], tx[i - 1]
            if a is not None and b:
                r = a / b - 1
        market["taiex_ret"].append(sig(r, 5))
    return dates, market, chains, cov, qual


# ------------------------------------------------------------------ 近日重抓（純函式）

def recheck_targets(existing_dates, n: int = RECHECK_DAYS) -> list[str]:
    """一般模式要重抓的日期：既有序列最近 n 個交易日（舊→新）。n ≤ 0 → 不重抓。"""
    ds = sorted(existing_dates)
    return ds[-n:] if n and n > 0 else []


def recheck_reject_reason(old: dict, new: dict) -> str | None:
    """重抓得到的單日聚合是否「明顯不如既有值」。回原因字串＝不得覆寫；None＝可覆寫。

    old/new 都是單日聚合（aggregate_day 的形狀；old 來自 load_existing，金額已還原成元）。
    判準與門檻見檔頭常數段「近日重抓」。"""
    om, nm = old.get("market") or {}, new.get("market") or {}
    o_n, n_n = om.get("n") or 0, nm.get("n") or 0
    o_a, n_a = om.get("amt") or 0.0, nm.get("amt") or 0.0
    if o_n and n_n < o_n * RECHECK_MIN_N_RATIO:
        return (f"成員檔數 {n_n} < 既有 {o_n} × {RECHECK_MIN_N_RATIO}")
    if o_a and n_a < o_a * RECHECK_MIN_AMT_RATIO:
        return (f"市場總額 {n_a / 1e8:.1f} 億 < 既有 {o_a / 1e8:.1f} 億 × {RECHECK_MIN_AMT_RATIO}")
    if om.get("taiex") is not None and nm.get("taiex") is None:
        return "重抓資料缺加權指數列（既有值有）"
    return None


def day_changed(old: dict, new: dict, chain_names: list[str]) -> bool:
    """兩份單日聚合寫進 series.json 後是否不同（用與落檔相同的四捨五入比；不看 sp0 診斷欄）。"""
    def f(day):
        d = dict(day, qual={})
        _, m, ch, cov, q = columnar({"x": d}, chain_names)
        return m, ch, cov, q["mw_cov"], q["tx_spread0"]
    o = dict(old)
    # load_existing 還原的既有日把 _mw_cov／_tx_spread0 放在 qual，搬回 market 才可比
    oq = old.get("qual") or {}
    o["market"] = dict(old["market"], _mw_cov=oq.get("mw_cov"), _tx_spread0=oq.get("tx_spread0"))
    return f(o) != f(new)


# ------------------------------------------------------------------ I/O

def load_classify() -> dict:
    return json.loads(CLASSIFY.read_text(encoding="utf-8"))


def cache_path(ds: str) -> Path:
    return CACHE / f"chainday_{ds}.json.gz"


def cache_read(ds: str) -> tuple[dict | None, dict]:
    """回 (prices, cache 詮釋資料)。prices 為 None ＝ 沒有 cache。

    v1（2026-08-11 之前）落的是 dict[code] = [...]，沒有版本欄；
    v2 落的是 {"v":2, "classify_at":..., "p": {...}}。兩種都讀得回來。"""
    p = cache_path(ds)
    if not p.exists():
        return None, {}
    obj = json.loads(gzip.decompress(p.read_bytes()).decode("utf-8"))
    if isinstance(obj, dict) and isinstance(obj.get("p"), dict) and "v" in obj:
        return obj["p"], {"v": obj.get("v"), "classify_at": obj.get("classify_at")}
    return obj, {"v": 1, "classify_at": None}


def cache_write(ds: str, prices: dict, classify_at: str | None) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    obj = {"v": CACHE_V, "classify_at": classify_at, "p": prices}
    cache_path(ds).write_bytes(gzip.compress(json.dumps(obj, separators=(",", ":")).encode()))


def cache_stale(cmeta: dict, classify_at: str | None) -> bool:
    """這份 cache 是否可能因 classify 換版而不完整（見檔頭「cache 格式 v2」）。"""
    return (cmeta.get("v") or 1) < CACHE_V or cmeta.get("classify_at") != classify_at


def fetch_day(ds: str) -> dict[str, list]:
    """抓單日 TaiwanStockPrice（休市日回空 dict）。

    v2 起**不傳 classify 過濾器**：留下全部數字開頭代號，讓 cache 與 classify 脫鉤。"""
    rows = fin.api_get("TaiwanStockPrice", start_date=ds, end_date=ds)
    return rows_to_prices(rows)


def load_existing(path: Path) -> tuple[dict[str, dict], set[str], dict]:
    """回 ({date: {'market':..,'chains':..}}, 非交易日集合, 原 meta)。

    讀回 columnar 檔並還原成逐日 dict，讓已算過的日期可原樣沿用（不重抓、不重算）。
    金額還原成「元」以與 aggregate_day 的內部單位一致。"""
    if not path.exists():
        return {}, set(), {}
    obj = json.loads(path.read_text(encoding="utf-8"))
    dates = obj.get("dates") or []
    mk = obj.get("market") or {}
    chs = obj.get("chains") or {}
    cvt = obj.get("coverage") or {}
    qlt = obj.get("quality") or {}
    days: dict[str, dict] = {}
    for i, d in enumerate(dates):
        def g(tbl, key):
            arr = tbl.get(key) or []
            return arr[i] if i < len(arr) else None
        cr = {}
        for name, tbl in chs.items():
            if g(tbl, "amt") is None and g(tbl, "n") is None:
                continue
            cr[name] = {
                "amt": (g(tbl, "amt") or 0) * 1e8,
                "n": g(tbl, "n"),
                "share": g(tbl, "share"),
                "ret_ew": g(tbl, "ret_ew"),
                "ret_mw": g(tbl, "ret_mw"),
            }
        days[d] = {
            "market": {
                "amt": (g(mk, "amt") or 0) * 1e8, "n": g(mk, "n"),
                "ret_ew": g(mk, "ret_ew"), "ret_mw": g(mk, "ret_mw"),
                "taiex": g(mk, "taiex"),
                # taiex_ret 不還原：columnar 會用 taiex 收盤序列重算（見檔頭）
                "_mw_cov": None, "_tx_spread0": None,
            },
            "chains": cr,
            "cov": {k: g(cvt, k) for k in ("dup", "split", "union")},
            # 逐日診斷欄位一定要還原，否則增量更新會把全期彙總抹成「當天那一格」
            "qual": {k: g(qlt, k) for k in ("mw_cov", "sp0_up", "sp0_n", "tx_spread0")},
        }
    meta = obj.get("meta") or {}
    return days, set(meta.get("nontrading") or []), meta


# ------------------------------------------------------------------ 主流程

def build(start: str, end: str, out_path: Path, rebuild: bool, offline: bool,
          refetch_stale: bool = False, recheck_days: int | None = None,
          recheck_dates: list[str] | None = None, recheck_force: bool = False) -> int:
    if not CLASSIFY.exists():
        print(f"::error::找不到 {CLASSIFY}", file=sys.stderr)
        return 1
    cj = load_classify()
    cmap = cj["map"]
    classify_at = cj.get("generated_at")
    chain_names = sorted({c for v in cmap.values() if v.get("t") == "twse"
                          for c in (v.get("c") or [])})
    if not chain_names:
        print("::error::classify.json 沒有任何 twse 產業鏈", file=sys.stderr)
        return 1

    old_days, nontrading, old_meta = load_existing(out_path)
    if rebuild:
        old_days = {}          # 只丟掉算好的序列，非交易日名單仍沿用（省掉重探測休市日）

    targets = weekdays(date.fromisoformat(start), date.fromisoformat(end))
    today = datetime.now(TPE).date()
    days: dict[str, dict] = dict(old_days)
    fetched = cached = reused = last_note = 0
    new_nontrading: list[str] = []
    stale_days: list[str] = []
    prev_seen: tuple[str, dict] | None = None       # 上一個實際載入 prices 的日子

    # ── 近日重抓（見檔頭常數段）：--rebuild（全部重算）與 --offline（不打 API）不適用 ──
    if rebuild or offline:
        recheck: set[str] = set()
    elif recheck_dates:
        miss = [d for d in recheck_dates if d not in old_days]
        if miss:
            print(f"::warning::--recheck-dates 指定的 {'、'.join(miss)} 不在既有序列內"
                  "（不重抓；若在 --start/--end 範圍內會照一般缺日流程回補）", file=sys.stderr)
        recheck = {d for d in recheck_dates if d in old_days}
    else:
        recheck = set(recheck_targets(old_days, RECHECK_DAYS if recheck_days is None
                                      else recheck_days))
    rechecked = changed = kept = 0
    changed_days: list[str] = []

    def prev_prices(ds: str, allow_fetch: bool) -> dict | None:
        """ds 前一交易日的原始價（sp0 診斷用）：本輪剛載入的 → cache →（允許時）現抓。"""
        pd_ = prev_trading_day(ds, nontrading | set(new_nontrading))
        if not pd_:
            return None
        if prev_seen and prev_seen[0] == pd_:
            return prev_seen[1]
        pp_ = cache_read(pd_)[0]
        if pp_ or not allow_fetch:
            return pp_ or None
        try:
            pp_ = fetch_day(pd_)
            time.sleep(SLEEP)
        except Exception as e:                      # noqa: BLE001
            print(f"::warning::{pd_} 前一日原始價抓取失敗（{ds} 的 sp0 診斷欄沿用舊值）：{e}",
                  file=sys.stderr, flush=True)
            return None
        return pp_ or None

    for ds in sorted(set(targets) | recheck):
        if ds in recheck:
            # 重抓：永遠打 API（不讀 cache——cache 就是可能有問題的那一份），
            # 任何不如意都保留既有值（days[ds] 不動），整班照常往下走。
            rechecked += 1
            old = old_days[ds]
            try:
                prices = fetch_day(ds)
                fetched += 1
                time.sleep(SLEEP)
            except Exception as e:                  # noqa: BLE001
                print(f"::warning::{ds} 重抓失敗，保留既有值：{e}", file=sys.stderr, flush=True)
                kept += 1
                prev_seen = None
                continue
            agg = aggregate_day(prices, cmap) if prices else None
            if not agg or not agg["market"]["amt"]:
                print(f"::warning::{ds} 重抓回空（或市場總額為 0），保留既有值",
                      file=sys.stderr, flush=True)
                kept += 1
                prev_seen = None
                continue
            why = None if recheck_force else recheck_reject_reason(old, agg)
            if why:
                print(f"::warning::{ds} 重抓資料明顯不如既有值（{why}），不覆寫",
                      file=sys.stderr, flush=True)
                kept += 1
                prev_seen = None
                continue
            cache_write(ds, prices, classify_at)
            diff = day_changed(old, agg, chain_names)
            # sp0 診斷欄：既有值是 None（CI 無 cache 的日子）就維持 None——重抓不改變
            # 診斷欄的涵蓋範圍，資料沒變時輸出才逐位不變；既有有值則用新原始價重算，
            # 拿不到前一日原始價時，內容有變才多抓一次前一日，否則沿用舊值。
            oq = old.get("qual") or {}
            q = {"sp0_up": oq.get("sp0_up"), "sp0_n": oq.get("sp0_n")}
            if oq.get("sp0_n") is not None:
                pp = prev_prices(ds, allow_fetch=diff)
                if pp:
                    hit, chk = spread_zero_up(prices, pp, cmap)
                    q = {"sp0_up": hit, "sp0_n": chk}
            agg["qual"] = q
            days[ds] = agg
            prev_seen = (ds, prices)
            if diff:
                changed += 1
                changed_days.append(ds)
            continue
        if ds in days:
            reused += 1
            continue
        if ds in nontrading:
            continue
        prices, cmeta = cache_read(ds)
        if prices is not None and cache_stale(cmeta, classify_at):
            stale_days.append(ds)
            if refetch_stale and not offline:
                prices = None                       # 丟掉舊格式，下面重抓
        if prices is None:
            if offline:
                continue
            try:
                prices = fetch_day(ds)
            except Exception as e:                  # noqa: BLE001
                print(f"  {ds} 抓取失敗（略過，下次重試）：{e}", file=sys.stderr, flush=True)
                continue
            stale = (today - date.fromisoformat(ds)).days > FRESH_GUARD
            if prices or stale:
                cache_write(ds, prices, classify_at)   # 空 dict ＝ 已確認的休市日
            fetched += 1
            time.sleep(SLEEP)
        else:
            cached += 1
        if not prices:
            if (today - date.fromisoformat(ds)).days > FRESH_GUARD:
                new_nontrading.append(ds)
            prev_seen = None
            continue
        agg = aggregate_day(prices, cmap)
        if not agg["market"]["amt"]:
            new_nontrading.append(ds)
            prev_seen = None
            continue
        # spread 缺陷偵測（見檔頭）：要前一交易日的原始價，回補時就是上一輪的 prices，
        # 增量時上一輪沒載入 → 多讀一份 cache（一天一次，可忽略）。
        pd = prev_trading_day(ds, nontrading | set(new_nontrading))
        pp = None
        if prev_seen and pd and prev_seen[0] == pd:
            pp = prev_seen[1]
        elif pd:
            pp = cache_read(pd)[0]
        if pp:
            hit, chk = spread_zero_up(prices, pp, cmap)
            agg["qual"] = {"sp0_up": hit, "sp0_n": chk}
        prev_seen = (ds, prices)
        days[ds] = agg
        # 進度只在「剛好抓滿 20 的倍數」印一次；用 last_note 擋掉之後每個 cache 命中都重印
        if fetched and fetched % 20 == 0 and fetched != last_note:
            last_note = fetched
            print(f"  … 已抓 {fetched} 天（最新 {ds}）", flush=True)

    # 重抓日有變動時，緊接其後的交易日若不在本輪重抓／新抓之列，它的 sp0 診斷欄
    # （拿自己的 spread 對照「前一日收盤」）輸入已變 → 跟著重算（只發生在 --recheck-dates
    # 指定較舊日期時；一般模式重抓的是最末幾天，後面只有本輪新抓的日子）。
    # 其餘欄位全是單日自足；taiex_ret 由 columnar() 用整條收盤序列現算，自動一致。
    all_dates = sorted(days)
    for ds in changed_days:
        i = all_dates.index(ds)
        nxt = all_dates[i + 1] if i + 1 < len(all_dates) else None
        if not nxt or nxt in recheck or nxt not in old_days:
            continue
        if prev_trading_day(nxt, set(nontrading) | set(new_nontrading)) != ds:
            continue
        nq = days[nxt].get("qual") or {}
        if nq.get("sp0_n") is None:
            continue
        np_ = cache_read(nxt)[0]
        if not np_:
            try:
                np_ = fetch_day(nxt)
                fetched += 1
                time.sleep(SLEEP)
            except Exception as e:                  # noqa: BLE001
                print(f"::warning::{nxt} 原始價抓取失敗，sp0 診斷欄沿用舊值：{e}",
                      file=sys.stderr, flush=True)
                continue
        cur = cache_read(ds)[0]
        if not np_ or not cur:
            continue
        hit, chk = spread_zero_up(np_, cur, cmap)
        days[nxt] = dict(days[nxt], qual=dict(nq, sp0_up=hit, sp0_n=chk))

    if rechecked:
        print(f"近日重抓 {rechecked} 天（{'、'.join(sorted(recheck))}）："
              f"內容有變 {changed} 天"
              + (f"（{'、'.join(changed_days)}）" if changed_days else "")
              + f"、保留既有值 {kept} 天", flush=True)

    if stale_days:
        head = "、".join(stale_days[:6]) + ("…" if len(stale_days) > 6 else "")
        if refetch_stale and not offline:
            print(f"⚠ {len(stale_days)} 天的 cache 是舊格式／舊 classify，已重抓（{head}）")
        else:
            print(f"⚠ {len(stale_days)} 天的 cache 是舊格式（v1）或 classify_at 不符（{head}）。"
                  "\n  這些 cache 在落檔時已被**當時的 classify** 過濾過，classify 若新增個股"
                  "（新上市）或新增鏈，從它們重算會靜默漏掉。"
                  "\n  classify 換版後請跑 --rebuild --refetch-stale 重抓（會打 API）；"
                  "只是重跑統計則可忽略此訊息。", file=sys.stderr)

    if len(days) < MIN_DAYS:
        print(f"::error::只湊到 {len(days)} 個交易日（規格要求 ≥{MIN_DAYS}），不寫檔",
              file=sys.stderr)
        return 1

    nontrading = sorted(nontrading | set(new_nontrading))
    dates, market, chains, cov, qual = columnar(days, chain_names, nontrading)

    covered = [c for c in chain_names if any(v is not None for v in chains[c]["amt"])]
    # 指數壞列：FinMind 回了 spread=0 但收盤確實有動（見檔頭）。用 close 比值算報酬
    # 已經自動繞過，這裡只是把「哪幾天是壞的」記下來，讓報告與下游看得見。
    tx_bad = [d for i, d in enumerate(dates)
              if qual["tx_spread0"][i] and (market["taiex_ret"][i] or 0) != 0]
    tx_gap = [d for i, d in enumerate(dates)
              if i and market["taiex_ret"][i] is None and market["taiex"][i] is not None]
    sp_hit = sum(v for v in qual["sp0_up"] if v)
    sp_chk = sum(v for v in qual["sp0_n"] if v)
    sp_days = sum(1 for v in qual["sp0_n"] if v)
    obj = {
        "generated_at": datetime.now(TPE).isoformat(timespec="seconds"),
        "source": "FinMind TaiwanStockPrice（日線）× data/classify.json",
        "classify_at": cj.get("generated_at"),
        "units": {"amt": "億元", "share": "小數（0.434 ＝ 43.4%）",
                  "ret": "小數（0.0123 ＝ +1.23%）", "taiex": "加權指數收盤點數"},
        "note": ("鏈層日頻序列：個股層依 classify.c 去重、只計 t==twse、"
                 "share 分母為市場總額（含 ETF，同 worker market.tse.amt_yi）；"
                 "個股報酬 = spread ÷ (close − spread)（交易所口徑，除權息已還原）；"
                 "ret_mw 權重 = classify.sh × 前一交易日收盤；"
                 "taiex_ret = 指數收盤比值（價格指數不還原股利，且 FinMind 的指數 spread "
                 "有整段壞資料，見 meta.taiex_spread_zero_days）。"),
        "dates": dates,
        "market": market,
        "chains": {c: chains[c] for c in covered},
        "coverage": dict(cov, topn=TOPN),
        "quality": qual,
        "meta": {
            "days": len(dates),
            "range": [dates[0], dates[-1]] if dates else [],
            "chains": len(covered),
            "chains_no_data": [c for c in chain_names if c not in covered],
            "nontrading": nontrading,
            # 彙總值一律由**全序列**現算（quality.mw_cov 是逐日陣列）。
            # 舊版是「只把本次新算的日子平均起來」，增量更新隔天就會被單日值蓋掉。
            # 邏輯本體在 mw_amt_coverage_of（純函式，可單測），這裡只呼叫。
            "mw_amt_coverage": mw_amt_coverage_of(qual),
            "taiex_ret_method": "close_ratio",
            "taiex_spread_zero_days": tx_bad,
            "taiex_ret_gap_days": tx_gap,
            "spread_zero_up": {"stock_days": sp_hit, "checked": sp_chk,
                               "days_checked": sp_days},
            "topn_coverage": {"topn": TOPN, **{
                k: sig(mean([v for v in cov[k] if v is not None]), 4)
                for k in ("dup", "split", "union")}},
            "limits": [
                "classify.json 為當前版本（%s），非各交易日當時版本；分類月更、"
                "上市／下市／改分類都會讓歷史日被今天的分類回頭套用。" % (cj.get("generated_at") or "?"),
                "市值加權權重用 classify.sh（當前發行張數），非各日當時股數；"
                "增減資／分割會讓歷史權重失真。sh 缺漏者（特別股等）不計市值加權，"
                "仍計等權與成員檔數。",
                "資料源為 FinMind 日線 Trading_money（含盤中零股與盤後定價），"
                "與盤中版的 tick snapshot total_amount（僅整股盤中）不同口徑；"
                "金額水準系統性偏高，佔比差異見 backtest/report_rrg_daily.md。",
                "ETF（代號 00 開頭）計入市場總額分母（與 worker 一致），"
                "但不計入任何報酬與市值加權；ETF 在 classify 中亦無產業鏈歸屬。",
                "FinMind 的 TAIEX 列有整段壞資料（%d 天：Trading_money 與 spread 皆為 0 "
                "但收盤確實有動）。taiex_ret 改用收盤比值繞開，壞日名單見 "
                "meta.taiex_spread_zero_days；序列第一天與跨缺口的日子無前一交易日、"
                "taiex_ret 為 null。" % len(tx_bad),
                "個股 spread 也有同源的偶發缺陷：%d 個 stock-day（%s）spread=0 但收盤高於"
                "前一交易日。量級可忽略（最嚴重單日約 0.05pp），**不改動報酬值**，"
                "只逐日記錄於 quality.sp0_up / sp0_n。"
                % (sp_hit, f"{sp_hit / sp_chk * 100:.3f}%" if sp_chk else "—"),
            ],
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")

    kb = out_path.stat().st_size / 1024
    print(f"交易日 {len(dates)} 天（{dates[0]} ~ {dates[-1]}）；"
          f"沿用 {reused}、讀 cache {cached}、新抓 {fetched}、非交易日 {len(nontrading)}")
    print(f"產業鏈 {len(covered)} 條"
          + (f"（classify 有但全期無資料：{'、'.join(obj['meta']['chains_no_data'])}）"
             if obj["meta"]["chains_no_data"] else "（與 classify 的 twse 鏈集合一致）"))
    mwc = obj["meta"]["mw_amt_coverage"]
    if mwc is not None:
        # 印 2 位小數：存的是 6 位有效位數，2 位小數之內每一位都是實值（見 mw_amt_coverage_of）
        print(f"市值加權成交額覆蓋率（全期平均，有 sh 的成員佔鏈成員成交額）：{mwc*100:.2f}%")
    print(f"Top{TOPN} 覆蓋率（全期平均）：均分口徑 "
          f"{(obj['meta']['topn_coverage']['split'] or 0)*100:.1f}%、"
          f"成員聯集 {(obj['meta']['topn_coverage']['union'] or 0)*100:.1f}%、"
          f"重複計數 {(obj['meta']['topn_coverage']['dup'] or 0)*100:.1f}%")
    if tx_bad:
        print(f"⚠ 指數 spread 壞列 {len(tx_bad)} 天（已用收盤比值繞開）："
              f"{tx_bad[0]} ~ {tx_bad[-1]}")
    if sp_chk:
        print(f"個股 spread=0 但收盤上漲：{sp_hit}/{sp_chk} stock-day "
              f"（{sp_hit/sp_chk*100:.3f}%，{sp_days} 天可檢查；僅記錄不修正）")
    last = {c: chains[c]["share"][-1] for c in covered if chains[c]["share"][-1] is not None}
    top = sorted(last.items(), key=lambda x: -x[1])[:5]
    print(f"{dates[-1]} 佔比 Top5：" + "、".join(f"{c} {v*100:.2f}%" for c, v in top))
    try:
        shown = out_path.relative_to(ROOT)
    except ValueError:
        shown = out_path.resolve()
    print(f"→ {shown}（{kb:.0f} KB）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="產 data/chain_daily/series.json（鏈層日頻序列）")
    ap.add_argument("--start", default=START_DEFAULT, help=f"起日（預設 {START_DEFAULT}）")
    ap.add_argument("--end", default=None, help="訖日（預設今天，台北時區）")
    ap.add_argument("--out", default=str(OUT), help="輸出路徑")
    ap.add_argument("--rebuild", action="store_true",
                    help="不沿用既有序列，用 cache／API 重算全部。"
                         "**classify 換版後單用它並不安全**——舊 cache 是用當時的 classify "
                         "過濾後才落檔的，新上市個股／新鏈會靜默漏掉；換版時請併用 "
                         "--refetch-stale")
    ap.add_argument("--refetch-stale", action="store_true",
                    help="重抓 classify_at 不符或舊格式（v1）的 cache（會打 API）。"
                         "**必須併用 --rebuild**——build() 對已在 series.json 的日期會直接沿用"
                         "（`if ds in days: continue`），根本走不到讀 cache 那一步，"
                         "單獨下這個旗標對存量日期完全無效，只會影響尚未回補的新日期")
    ap.add_argument("--offline", action="store_true",
                    help="只用 backtest/cache 現有檔，完全不打 API（免 token）")
    ap.add_argument("--recheck-days", type=int, default=None,
                    help=f"一般模式每班重抓重算序列最近 N 個交易日（預設 {RECHECK_DAYS}；0＝不重抓）。"
                         "--rebuild／--offline 時不適用")
    ap.add_argument("--recheck-dates", default=None,
                    help="只重抓重算指定日期（逗號分隔 YYYY-MM-DD，須已在序列內），取代自動的"
                         "最近 N 日；發現單日錯值時手動修復用，例：--recheck-dates 2026-11-17,2026-11-18")
    ap.add_argument("--recheck-force", action="store_true",
                    help="重抓資料即使「明顯不如既有值」（檔數／總額驟降）也覆寫；"
                         "抓取失敗或回空仍保留既有值")
    a = ap.parse_args()
    end = a.end or datetime.now(TPE).date().isoformat()
    rd = None
    if a.recheck_dates:
        rd = [x.strip() for x in a.recheck_dates.split(",") if x.strip()]
        for x in rd:
            try:
                date.fromisoformat(x)
            except ValueError:
                ap.error(f"--recheck-dates 日期格式不合：{x!r}（需 YYYY-MM-DD）")
    return build(a.start, end, Path(a.out), a.rebuild, a.offline, a.refetch_stale,
                 recheck_days=a.recheck_days, recheck_dates=rd, recheck_force=a.recheck_force)


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    raise SystemExit(main())
