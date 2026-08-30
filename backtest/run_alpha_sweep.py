#!/usr/bin/env python3
# backtest/run_alpha_sweep.py — 全站 Alpha 盤點掃描（第一階段 14 候選 / K=16）
#
# 規格：docs/alpha-sweep-preregistration.md（已 commit、已凍結）。
#   §1 方法（主要結果變數 e3、不報 p 值、切半驗證、採用門檻、三層報告、多重比較揭露）
#   §2.1 候選清單 14 列（AS-03/AS-04 為雙邊檢定各計 2 → K=16）
#   §6   第二階段 3 列（AS-15/16/17，走 SIGNALS_P2／K_TESTS_P2=5，與第一階段分開計 K）
#   §2.2 已知偏差 4 項＋第 5 項實作揭露（AS-05/06 滾動基準，2026-07-28 驗收要求）
# **本檔不得自行增刪候選、不得改判準門檻**——那會讓「先註冊後測」失去意義。
#
# 沿用既有程式（不重造）：
#   run_sorting.load()               快取載入（price_*.json.gz / inst_*.json.gz / classify.json）
#   run_sorting.build_stock_samples()樣本結構（27 個 key，含 e1/e3、流動性過濾、排除 ETF）
#   run_sorting.stat()/fmt()/monthly() 統計與輸出格式
#   run_sorting.max_tie_rate()       排序欄平手率診斷（本檔只印診斷，不當判準）
#
# 技術指標：Worker 生產實作 worker/src/index.js 的 sma/ema/kd/macd/rsi/boll
# 與其狀態描述 kdState/macdState/bollState 的 Python 逐行移植（行號會隨該檔演進，
# 以函式名為準；撰寫時位於 :1879-1955 與 :1990-2023）。
# 兩份實作的漂移由 backtest/test_alpha_parity.mjs 守門（node 端跑同一組合成序列，零差異）。
#
# 用法：
#   python backtest/run_alpha_sweep.py        # 需 backtest/cache/ 有快取 → 寫 report_alpha_sweep.md
#   node   backtest/test_alpha_parity.mjs     # JS↔Python 指標一致性（免快取）
#   python backtest/test_alpha_sweep_smoke.py # 合成樣本煙霧測試（免快取）

from __future__ import annotations

import math
import statistics as st
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_sorting as rs  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs" / "alpha-sweep-preregistration.md"
OUT = ROOT / "backtest" / "report_alpha_sweep.md"

# ── 判準門檻（預註冊書 §1.5，先訂，不得於本次執行後調整）──────────
MIN_N_FULL = 500      # 全期樣本數
MIN_N_HALF = 200      # 前後半各自樣本數
MIN_ABS_E3 = 0.50     # 全期 |e3 平均|（%）
# ── 訊號建構參數（預註冊書 §2.1 字面）────────────────────────────
TOP_N = 30            # AS-01~04：當日強度前 30 名
DECILE = 0.10         # AS-05/06：當日前/後 10%


# ── 候選清單（預註冊書 §2.1，14 列；順序與編號逐項對應，不得增刪）──
SIGNALS = [
    dict(id="AS-01", src="flows 同步", weight=1, dir="long",
         desc="外資淨買>0 且 投信淨買>0，強度=min(|外資額|,|投信額|) 當日前 30 名"),
    dict(id="AS-02", src="flows 同步", weight=1, dir="short",
         desc="外資淨買<0 且 投信淨買<0，強度同義前 30 名"),
    dict(id="AS-03", src="flows 對作", weight=2, dir="both",
         desc="外資買 ∩ 投信賣，強度前 30 名"),
    dict(id="AS-04", src="flows 對作", weight=2, dir="both",
         desc="投信買 ∩ 外資賣，強度前 30 名"),
    dict(id="AS-05", src="v2 成交佔比", weight=1, dir="long",
         desc="佔週變（本週佔比−上週佔比，pp）當日前 10%［基準採滾動前5交易日，見已知偏差5］"),
    dict(id="AS-06", src="v2 成交佔比", weight=1, dir="short",
         desc="佔週變當日後 10%［基準採滾動前5交易日，見已知偏差5］"),
    dict(id="AS-07", src="news 個股追蹤", weight=1, dir="long",
         desc="KD(9,3,3) 黃金交叉且 K<50"),
    dict(id="AS-08", src="news 個股追蹤", weight=1, dir="short",
         desc="KD 死亡交叉且 K>50"),
    dict(id="AS-09", src="news 個股追蹤", weight=1, dir="long",
         desc="MACD(12,26,9) 柱由負翻正"),
    dict(id="AS-10", src="news 個股追蹤", weight=1, dir="short",
         desc="MACD 柱由正翻負"),
    dict(id="AS-11", src="news 個股追蹤", weight=1, dir="long",
         desc="RSI(5) < 20（均值回歸）"),
    dict(id="AS-12", src="news 個股追蹤", weight=1, dir="short",
         desc="RSI(5) > 80（均值回歸）"),
    dict(id="AS-13", src="news 個股追蹤", weight=1, dir="long",
         desc="收盤突破布林上軌（20, 2σ, 母體標準差）"),
    dict(id="AS-14", src="news 個股追蹤", weight=1, dir="short",
         desc="收盤跌破布林下軌"),
]
# K＝檢定次數：雙邊檢定各計 2（預註冊書 §2 前言 + §2.1 註）。由清單自動帶入，不手填。
K_TESTS = sum(s["weight"] for s in SIGNALS)

# ── 第二階段候選（預註冊書 §6，於第二階段執行前寫定）─────────────────
# 2026-08-30 解鎖：fetch.py 的 price 陣列已補 Trading_Volume（索引 5）。
# 定義／方向／權重／K 的正本在 `docs/alpha-sweep-preregistration.md` §6
# （原 §2.3 只寫了訊號名稱與解鎖條件、沒有方向欄，已在該節加註指向 §6）。
#
# **與第一階段嚴格分離**：§2.5 明文「以上 14 列（K=16）即為第一階段全部候選。掃描程式
# 寫完後不得增刪」——所以這兩列不進 SIGNALS、不進 K_TESTS、不進第一階段的三層總表，
# 走自己的清單與自己的 K，報告另闢一節。混進去等於事後加碼、汙染多重比較揭露。
#
# 訊號定義逐字取自原始出處，不是本檔自訂：
#   AS-15 爆量長黑 ← postmkt `src/build_diag.py` 的 vs／vb 兩行：
#       vs＝當日量 > 2 × 前 20 個交易日（**不含當日**、容缺 min 15）均量；
#       vb＝vs 且 當日漲跌% ≤ −3（漲跌% 先經 r2 再比較，與來源同語意）。
#       方向＝做空，但**這不是預註冊書原訂的**：§2.3 沒有方向欄，`short` 是從 postmkt
#       `index.html` 的 DIAG_RULES 推出來的（grep `id:"P2"`，該條目帶 col:"red"＝風險側，
#       且自標 ver:false）。§6.2 已如實記載此來源。2026-08-30 使用者裁定**維持
#       short／weight 1**——方向依據仍是那份風險側歸類（**這點不變**），使用者裁定的是
#       「就採用這個方向」，兩者證據等級不同，不可把裁定講成實證。
#   AS-16 量能爆量 ← `worker/src/index.js` 的 volumeRatio：
#       SMA(V,5)/SMA(V,20) ≥ 2（兩窗**皆含當日**）且 收盤 > 前一日收盤。
#       方向＝**雙邊**：兩處來源都只把「爆量」寫成中性量能描述、未宣稱多空
#       （前端文案「為量能數學描述」、worker 狀態詞不含方向），預註冊書 §2.3 也沒訂方向。
#       方向不明者依 §2 前言明列為雙邊並計 2 次，沿用 AS-03/04 的既有處理——
#       **不由本檔臆測方向**。
#   AS-17 當沖比率 ← 三個生產消費端同一個算式（分子分母都不是本檔自訂）：
#       postmkt `build_postmkt.py build_daytrading` 的 `vol / total * 100`、
#       本 repo `worker/src/index.js` 的 `buildDayTrade`（`num(last.Volume) / tv`）、
#       postmkt `src/build_diag.py` 的 `o["dt"]`。三處一致：
#         分子＝`TaiwanStockDayTrading.Volume`（TWSE「當日沖銷交易成交股數」，單位**股**、
#               **單邊**——實測 BuyAmount/Volume≈當日均價可證，見下方查證）
#         分母＝同日 `TaiwanStockPrice.Trading_Volume`（單位**股**）
#       兩者同單位相除 → 無因次比率，與 TWSE 官方定義字面相同（TWTB4U 表尾註記：
#       「當日沖銷交易總成交股數占市場比重% ＝ 當日沖銷交易總成交股數／整體市場成交股數×100」，
#       **不乘 2**）。門檻 0.60＝使用者 2026-08-30 裁定。
#       方向＝**雙邊**：使用者只裁定門檻與資料源、未指定方向，依 §2 前言「方向不明者
#       明列雙邊並計 2 次」的既有預設規則處理（同 AS-03/04/16）——**非使用者指定方向**。
SIGNALS_P2 = [
    dict(id="AS-15", src="postmkt diag P2", weight=1, dir="short",
         desc="爆量長黑（量 > 前20日均量×2 且 當日跌幅 ≥ 3%）"),
    dict(id="AS-16", src="news 個股追蹤", weight=2, dir="both",
         desc="量能爆量（SMA(V,5)/SMA(V,20) ≥ 2 且 價漲）"),
    dict(id="AS-17", src="postmkt 當沖", weight=2, dir="both",
         desc="當沖比率（當沖成交股數 ÷ 當日成交股數 > 60%）"),
]
# 第二階段自己的 K，**不與 K_TESTS 相加**（兩階段的多重比較分開折算）。
# 2026-08-30：AS-17 加入後由 3 → 5（AS-15 計 1 ＋ AS-16 計 2 ＋ AS-17 計 2）。
K_TESTS_P2 = sum(s["weight"] for s in SIGNALS_P2)

# 某訊號沒跑時報告要寫的原因（兩組解鎖條件不同：量能只要 volume 欄，當沖另要 dt 快取，
# 所以「AS-15/16 跑了但 AS-17 沒跑」是真實會發生的組合，報告必須說得出是哪一種）。
P2_SKIP_REASON = {
    "AS-15": "price 快取的 `Trading_Volume` 欄不完整（見涵蓋揭露行）。",
    "AS-16": "price 快取的 `Trading_Volume` 欄不完整（見涵蓋揭露行）。",
    "AS-17": "當沖快取（`backtest/cache/dt_*.json.gz`）不完整——並非每個非空交易日都有；"
             "或 price 快取的 `Trading_Volume` 欄（分母）不完整。解鎖方式：整批刪快取後"
             "重跑 `backtest/fetch.py`（該檔 2026-08-30 起會一併抓 `TaiwanStockDayTrading`）。",
}

# price 陣列的成交量索引（fetch.py schema：[amt,open,high,low,close,vol]，vol 單位「股」）。
# 舊快取只有 5 欄，讀到 None → 量能訊號整批跳過。
VOL_IDX = 5

# AS-17 當沖比率門檻（使用者 2026-08-30 裁定「當沖比率 > 60%」，**嚴格大於**）。
# 寫成小數是因為分子分母同為「股」、相除後無因次；生產端習慣乘 100 印成 %，
# 這裡不乘，避免多一次浮點運算改變邊界比較的語意。
DT_RATIO_MIN = 0.60

DIR_LABEL = {"long": "做多", "short": "做空", "both": "雙邊（計 2）"}

# 前 4 項＝預註冊書 §2.2 原文摘要；第 5 項＝實作層偏離揭露（fresh-context 驗收
# 1cc5466 的必修項：只寫在程式註解、報告不印，讀者會誤以為測的是生產自然週口徑）
KNOWN_BIASES = [
    "**外資口徑（2026-07-29 起已對齊生產）**：fetch.py 現收 `Foreign_Investor + "
    "Foreign_Dealer_Self`（＝生產口徑，`taiwan-flows/src/pipeline.py:12`）。"
    "第一版報告（commit 04ba1ad）的快取只含 `Foreign_Investor`，本版為口徑覆核重跑"
    "（預註冊 §5）；若本快取為舊版抓取，AS-01~04 結論僅適用不含外資自營口徑。",
    "**快取無自營**：所以完全沒有涉及自營的候選。",
    "**`Trading_Volume`（原「未存」，2026-08-30 起 fetch.py 已補存）**："
    "舊快取只有 `Trading_money`；用金額當成交量的代理會失真（金額＝量×均價），"
    "所以量能類指標**不列入第一階段**——此點不變，§2.5 已凍結第一階段清單。"
    "補欄後的量能訊號另列**第二階段**（AS-15/16，見報告末節），獨立計 K。",
    "**52 週高低暖身不足**：需 ~250 交易日暖身，快取全長僅 255 日，扣掉後只剩約 1 個月可算。排除。",
    "**AS-05/06 的「上週」基準與生產不同**：生產的佔週變＝當日佔比 − 上一**自然週**"
    "（週一~五聚合）佔比（`index.html` 佔週變欄，資料鏈 `src/build_lastweek.py`），"
    "回測快取無自然週聚合，改用**滾動前 5 交易日**佔比為基準；分母亦沿用回測市場總額"
    "（排除 ETF，不分上市/上櫃）。本報告的 AS-05/06 結論適用於滾動 5 日口徑，"
    "**不可直接外推到生產的自然週定義**。",
]


# ════════════════════════════════════════════════════════════════
# 一、技術指標：worker/src/index.js 純函式的 Python 移植
#     對照行號寫在各函式；語意差一點都會讓兩站口徑漂移，改動必須同步改 JS 並跑 parity。
# ════════════════════════════════════════════════════════════════

def jround(x: float) -> int:
    """JS `Math.round` 語意（half-up 朝 +∞），非 Python `round` 的 banker's rounding。

    不寫成 floor(x+0.5)：x+0.5 在浮點下可能進位（如 0.49999999999999994），
    ES 規範與 V8 對該值回 0，floor(x+0.5) 會回 1。
    """
    f = math.floor(x)
    return f + 1 if x - f >= 0.5 else f


def r2(v: float) -> float:
    """index.js:21 `const r2 = (v) => Math.round(v * 100) / 100;`"""
    return jround(v * 100) / 100


def sma(arr, period):
    """index.js:1787-1793。不足 period 回 None。"""
    a = arr or []
    if len(a) < period or period <= 0:
        return None
    s = 0.0
    for i in range(len(a) - period, len(a)):
        s += a[i]
    return s / period


def ema(arr, period):
    """index.js:1796-1805。回整條序列；種子＝前 period 個的 SMA；不足 period 回 []。"""
    a = arr or []
    if len(a) < period or period <= 0:
        return []
    k = 2 / (period + 1)
    out = [None] * len(a)
    seed = 0.0
    for i in range(period):
        seed += a[i]
    out[period - 1] = seed / period
    for i in range(period, len(a)):
        out[i] = a[i] * k + out[i - 1] * (1 - k)
    return out


def kd_path(highs, lows, closes, n=9, smooth=3):
    """index.js:1808-1821 的「逐日路徑」版。

    out[i] ＝ JS `kd(H[:i+1], L[:i+1], C[:i+1], n, smooth)`。
    成立理由：JS 的 K/D 是自序列起點（初值 K=D=50）往前遞迴、與序列結尾無關，
    因此整條路徑一次算完等於逐個前綴各算一次（parity 測試逐 index 驗證此等價）。
    """
    H, L, C = highs or [], lows or [], closes or []
    out = [None] * len(C)
    if len(C) < n:
        return out
    a = 1 / smooth
    k = d = 50
    for i in range(n - 1, len(C)):
        hh, ll = -math.inf, math.inf
        for j in range(i - n + 1, i + 1):
            if H[j] > hh:
                hh = H[j]
            if L[j] < ll:
                ll = L[j]
        rng = hh - ll
        rsv = 50 if rng == 0 else ((C[i] - ll) / rng) * 100
        k = k * (1 - a) + rsv * a
        d = d * (1 - a) + k * a
        out[i] = dict(k=r2(k), d=r2(d))
    return out


def macd_path(closes, fast=12, slow=26, signal=9):
    """index.js:1824-1836 的逐日路徑版。out[i] ＝ JS `macd(C[:i+1], ...)`。

    EMA 種子在序列前段、之後純遞迴 → 前綴穩定，故整條算完可對應每個前綴。
    JS 端的長度守門 `C.length < slow + signal` 對應 i < slow+signal-1。
    """
    C = closes or []
    out = [None] * len(C)
    if len(C) < slow + signal:
        return out
    ef, es = ema(C, fast), ema(C, slow)
    dif = [(ef[i] - es[i]) if (ef[i] is not None and es[i] is not None) else None
           for i in range(len(C))]
    difvals = [x for x in dif if x is not None]      # 連續段，起點 index = slow-1
    sig = ema(difvals, signal)
    if not sig:
        return out
    for i in range(slow + signal - 1, len(C)):
        m = i - (slow - 1)                            # difvals 內的位置
        if m >= len(sig) or sig[m] is None:
            continue
        macd_line = sig[m]
        macd_prev = sig[m - 1] if m >= 1 else None
        dif_last = difvals[m]
        dif_prev = difvals[m - 1] if m >= 1 else None
        hist = dif_last - macd_line
        hist_prev = (dif_prev - macd_prev) if (dif_prev is not None and macd_prev is not None) else None
        out[i] = dict(dif=r2(dif_last), macd=r2(macd_line), hist=r2(hist),
                      histPrev=None if hist_prev is None else r2(hist_prev))
    return out


def _rsi_val(avg_g, avg_l):
    """index.js:1850-1852：全漲 100、全跌 0、無波動 50（這三個回傳值不過 r2）。"""
    if avg_l == 0:
        return 50 if avg_g == 0 else 100
    if avg_g == 0:
        return 0
    return r2(100 - 100 / (1 + avg_g / avg_l))


def rsi_path(closes, period=14):
    """index.js:1839-1853 的逐日路徑版。out[i] ＝ JS `rsi(C[:i+1], period)`。

    Wilder 平滑同樣是自序列起點遞迴（種子＝前 period 個變動的簡單平均）→ 前綴穩定。
    注意生產用 period 5 與 10，非教科書的 14（index.js:1956）。
    """
    C = closes or []
    out = [None] * len(C)
    if len(C) < period + 1:
        return out
    gain = loss = 0.0
    for i in range(1, period + 1):
        ch = C[i] - C[i - 1]
        if ch >= 0:          # 注意：JS 種子段是 ch >= 0 進 gain（與平滑段的 ch > 0 不同）
            gain += ch
        else:
            loss -= ch
    avg_g, avg_l = gain / period, loss / period
    out[period] = _rsi_val(avg_g, avg_l)
    for i in range(period + 1, len(C)):
        ch = C[i] - C[i - 1]
        avg_g = (avg_g * (period - 1) + (ch if ch > 0 else 0)) / period
        avg_l = (avg_l * (period - 1) + (-ch if ch < 0 else 0)) / period
        out[i] = _rsi_val(avg_g, avg_l)
    return out


def boll_path(closes, period=20, mult=2):
    """index.js:1855-1865 的逐日路徑版。母體標準差（除以 period，非 period-1）。"""
    C = closes or []
    out = [None] * len(C)
    for i in range(period - 1, len(C)):
        w = C[i - period + 1:i + 1]
        mid = sma(w, period)
        v = 0.0
        for x in w:
            v += (x - mid) ** 2
        sd = math.sqrt(v / period)
        upper, lower, close = mid + mult * sd, mid - mult * sd, C[i]
        rng = upper - lower
        pb = 0.5 if rng == 0 else (close - lower) / rng
        out[i] = dict(mid=r2(mid), upper=r2(upper), lower=r2(lower), pb=r2(pb))
    return out


def kd_state(cur, prev_k, prev_d):
    """index.js:1898-1906。交叉優先於高/低檔區。"""
    if prev_k is not None and prev_d is not None:
        if prev_k <= prev_d and cur["k"] > cur["d"]:
            return "黃金交叉（K 上穿 D）"
        if prev_k >= prev_d and cur["k"] < cur["d"]:
            return "死亡交叉（K 下穿 D）"
    if cur["k"] > 80 and cur["d"] > 80:
        return "高檔區（>80）"
    if cur["k"] < 20 and cur["d"] < 20:
        return "低檔區（<20）"
    return "中性"


def macd_state(m):
    """index.js:1908-1917。"""
    bar = "柱狀持平"
    if m["histPrev"] is not None:
        if m["histPrev"] <= 0 and m["hist"] > 0:
            bar = "柱狀翻正（跨零軸）"
        elif m["histPrev"] >= 0 and m["hist"] < 0:
            bar = "柱狀翻負（跨零軸）"
        elif abs(m["hist"]) < 0.05:
            bar = "黏合（近零）"
        else:
            bar = "柱狀為正" if m["hist"] > 0 else "柱狀為負"
    return f"{bar}；DIF {'零軸之上' if m['dif'] > 0 else '零軸之下'}"


def boll_state(pb):
    """index.js:1926-1931。"""
    if pb is None:
        return "資料不足"
    if pb >= 1:
        return "觸/破上軌"
    if pb <= 0:
        return "觸/破下軌"
    return "中軌之上" if pb >= 0.5 else "中軌之下"


def dump_indicators(series):
    """供 test_alpha_parity.mjs 比對：逐 index 輸出全部指標與狀態描述。

    series = {"h": [...], "l": [...], "c": [...]}（等長）。
    """
    H, L, C = series["h"], series["l"], series["c"]
    kdp, mp = kd_path(H, L, C), macd_path(C)
    r5, r10 = rsi_path(C, 5), rsi_path(C, 10)
    bp = boll_path(C)
    out = []
    for i in range(len(C)):
        cur, prev = kdp[i], (kdp[i - 1] if i > 0 else None)
        m = mp[i]
        out.append(dict(
            i=i,
            sma5=sma(C[:i + 1], 5), sma20=sma(C[:i + 1], 20),
            kd=cur,
            kd_state=(kd_state(cur, prev["k"] if prev else None,
                               prev["d"] if prev else None) if cur else None),
            macd=m,
            macd_state=(macd_state(m) if m else None),
            rsi5=r5[i], rsi10=r10[i],
            boll=bp[i],
            boll_state=(boll_state(bp[i]["pb"]) if bp[i] else None),
        ))
    return out


# ════════════════════════════════════════════════════════════════
# 二、訊號旗標建構（把 14 個訊號掛到 build_stock_samples 產出的樣本上）
# ════════════════════════════════════════════════════════════════

def attach_inst_signals(samples, diag):
    """AS-01~04：法人同步／對作，當日強度前 TOP_N 名。

    金額直接沿用樣本既有的 trust_buy_amt / foreign_buy_amt
    （run_sorting.py:171-172，＝法人淨買股數×收盤/1000，千元；符號＝淨買方向）。
    強度＝min(|外資額|,|投信額|)——與 taiwan-flows 對作頁「強度=min(雙方金額)」同義。
    排序帶次鍵 code，避免同值時分組依輸入順序漂移（taiwan-flows 踩過的 tie-break 教訓）。
    """
    defs = [
        ("AS-01", lambda t, f: t > 0 and f > 0),
        ("AS-02", lambda t, f: t < 0 and f < 0),
        ("AS-03", lambda t, f: f > 0 and t < 0),
        ("AS-04", lambda t, f: t > 0 and f < 0),
    ]
    by_day = {}
    for r in samples:
        by_day.setdefault(r["d"], []).append(r)
    for sid, pred in defs:
        pool = []
        for d in sorted(by_day):
            cand = []
            for r in by_day[d]:
                t, f = r["trust_buy_amt"], r["foreign_buy_amt"]
                if pred(t, f):
                    cand.append((min(abs(t), abs(f)), r))
            cand.sort(key=lambda x: (-x[0], x[1]["c"]))
            for strength, r in cand[:TOP_N]:
                r["sig"].add(sid)
                pool.append(dict(v=strength))
        diag[sid] = dict(cand=len(pool), tie=rs.max_tie_rate(pool, "v"))


def attach_share_signals(samples, days, price, diag):
    """AS-05/06：成交佔比的「佔週變」（pp）當日前/後 10%。

    生產定義（index.html:261-268）：佔比＝個股當日成交額 ÷ 該市場當日全個股成交額；
    上週佔＝個股上週成交額 ÷ 市場上週成交額；佔週變＝兩者相減（pp）。
    回測沒有 lastweek.json 那種「自然週」聚合，改用**滾動前 5 交易日**當「上週」基準
    ——與本 repo 既有回測的 5 日基準一致（run_sorting.py:122-123 的 a5）。
    分母沿用 run_sorting.build_sector_samples:202-205 的市場總額（排除 ETF 與 _TAIEX），
    不分上市/上櫃（回測母體本來就跨市場排序）。
    """
    idx = {d: t for t, d in enumerate(days)}
    mkt_tot = []
    for d in days:
        mkt_tot.append(sum(rs.fv(r[0]) or 0 for c, r in price[d].items()
                           if c != "_TAIEX" and not c.startswith("00")))
    by_day = {}
    for r in samples:
        t = idx[r["d"]]
        if t < 5 or not mkt_tot[t]:
            continue
        num = den = 0.0
        ok = True
        for k in range(1, 6):
            row = price[days[t - k]].get(r["c"])
            a = rs.fv(row[0]) if row else None
            if a is None or not mkt_tot[t - k]:
                ok = False
                break
            num += a
            den += mkt_tot[t - k]
        if not ok or den <= 0:
            continue
        chg = (r["amt"] / mkt_tot[t] - num / den) * 100    # pp
        r["share_chg"] = chg
        by_day.setdefault(r["d"], []).append(r)

    pool_hi, pool_lo = [], []
    for d in sorted(by_day):
        rows = sorted(by_day[d], key=lambda r: (-r["share_chg"], r["c"]))
        k = int(len(rows) * DECILE)                        # 不足 10 檔 → 當日不取樣
        for r in rows[:k]:
            r["sig"].add("AS-05")
            pool_hi.append(dict(v=r["share_chg"]))
        for r in rows[len(rows) - k:] if k else []:
            r["sig"].add("AS-06")
            pool_lo.append(dict(v=r["share_chg"]))
    diag["AS-05"] = dict(cand=len(pool_hi), tie=rs.max_tie_rate(pool_hi, "v"))
    diag["AS-06"] = dict(cand=len(pool_lo), tie=rs.max_tie_rate(pool_lo, "v"))


def attach_technical_signals(samples, days, price, diag):
    """AS-07~14：KD／MACD／RSI／布林，指標與狀態描述全部走 Worker 移植函式。

    每檔股票的指標序列只用「該檔實際有價格列的交易日」，與生產的 buildSeries
    （index.js:1940-1945，過濾 close==null 後升冪）同語意。
    """
    by_cd = {(r["c"], r["d"]): r for r in samples}
    codes = sorted({r["c"] for r in samples})
    cnt = {s: 0 for s in ("AS-07", "AS-08", "AS-09", "AS-10",
                          "AS-11", "AS-12", "AS-13", "AS-14")}
    for c in codes:
        sd, H, L, C = [], [], [], []
        for d in days:
            row = price[d].get(c)
            if not row:
                continue
            h, lo, cl = rs.fv(row[2]), rs.fv(row[3]), rs.fv(row[4])
            if h is None or lo is None or cl is None:
                continue
            sd.append(d)
            H.append(h)
            L.append(lo)
            C.append(cl)
        if not C:
            continue
        kdp, mp, r5, bp = kd_path(H, L, C), macd_path(C), rsi_path(C, 5), boll_path(C)
        for i, d in enumerate(sd):
            r = by_cd.get((c, d))
            if r is None:
                continue
            cur = kdp[i]
            if cur:
                prev = kdp[i - 1] if i > 0 else None
                stt = kd_state(cur, prev["k"] if prev else None, prev["d"] if prev else None)
                if stt.startswith("黃金交叉") and cur["k"] < 50:
                    r["sig"].add("AS-07")
                if stt.startswith("死亡交叉") and cur["k"] > 50:
                    r["sig"].add("AS-08")
            m = mp[i]
            if m:
                stt = macd_state(m)
                if stt.startswith("柱狀翻正"):
                    r["sig"].add("AS-09")
                if stt.startswith("柱狀翻負"):
                    r["sig"].add("AS-10")
            v5 = r5[i]
            if v5 is not None:
                if v5 < 20:
                    r["sig"].add("AS-11")
                if v5 > 80:
                    r["sig"].add("AS-12")
            b = bp[i]
            if b:
                stt = boll_state(b["pb"])
                if stt == "觸/破上軌":
                    r["sig"].add("AS-13")
                if stt == "觸/破下軌":
                    r["sig"].add("AS-14")
    for r in samples:
        for s in cnt:
            if s in r["sig"]:
                cnt[s] += 1
    for s, n in cnt.items():
        diag[s] = dict(cand=n, tie=None)


def vol_of(row):
    """從 price 列取成交量（股）。舊快取只有 5 欄 → 回 None。"""
    if not row or len(row) <= VOL_IDX:
        return None
    return rs.fv(row[VOL_IDX])


def volume_days(days, price):
    """回 (帶 volume 的交易日, 非空交易日)。判定單位是「日」不是「列」：
    fetch.py 整日寫一個 price_<d>.json.gz，schema 缺欄必然整日缺；
    單列的 volume 為 None 是資料問題（FinMind 回 null），由各訊號自己跳過。
    """
    have, nonempty = [], []
    for d in days:
        rows = price.get(d) or {}
        if not rows:
            continue
        nonempty.append(d)
        if any(vol_of(r) is not None for r in rows.values()):
            have.append(d)
    return have, nonempty


def cache_has_volume(days, price):
    """快取是否**完整**帶 Trading_Volume：所有非空交易日都要有，缺一天就回 False。

    2026-08-30 改嚴（原判準是「任一列有值即 True」）。原判準的破口：
    fetch.py 的續傳是逐檔跳過（`if pf.exists() and inf.exists(): continue`），
    所以**只刪掉部分 price_*.json.gz 重跑就會產生混合快取**——一部分日有 volume、
    一部分沒有。舊判準放行後 attach_volume_signals 回 True、報告照印 N 與分層，
    但缺欄那幾天的量能訊號整批靜默漏掉，讀者無從察覺報告是半盲的
    （實測：混合快取下植入的 AS-15/16 事件全部沒觸發，報告零提示）。
    改嚴後這種快取一律整批不跑，並在報告印出實際涵蓋日數（見 build_report）。
    """
    have, nonempty = volume_days(days, price)
    return bool(nonempty) and len(have) == len(nonempty)


def attach_volume_signals(samples, days, price, diag):
    """AS-15/16：第二階段量能訊號。快取無 Trading_Volume 時整批不掛並回 False。

    序列口徑與 attach_technical_signals 一致：每檔只取「該檔實際有價格列的交易日」，
    與生產的 buildSeries（過濾 close==null 後升冪）同語意。
    """
    if not cache_has_volume(days, price):
        for sig in SIGNALS_P2:
            diag[sig["id"]] = dict(cand=0, tie=None)
        return False

    by_cd = {(r["c"], r["d"]): r for r in samples}
    codes = sorted({r["c"] for r in samples})
    cnt = {sig["id"]: 0 for sig in SIGNALS_P2}
    for c in codes:
        sd, V, C = [], [], []
        for d in days:
            row = price[d].get(c)
            if not row:
                continue
            cl = rs.fv(row[4])
            if cl is None:
                continue
            sd.append(d)
            V.append(vol_of(row))
            C.append(cl)
        for i, d in enumerate(sd):
            r = by_cd.get((c, d))
            if r is None or i == 0:
                continue
            v, pc = V[i], C[i - 1]
            if v is None or not pc:
                continue
            # 漲跌%：先 r2 再比較，與 postmkt build_diag 的 o["d1"] 同語意
            d1 = r2((C[i] / pc - 1) * 100)

            # AS-15：前 20 個交易日（不含當日）均量，容缺 min 15（postmkt _win_loose 同參數）
            w = [x for x in V[max(0, i - 20):i] if x is not None]
            if len(w) >= 15:
                avg_v = sum(w) / len(w)
                if avg_v and v > 2 * avg_v and d1 <= -3:
                    r["sig"].add("AS-15")
                    cnt["AS-15"] += 1

            # AS-16：SMA(V,5)/SMA(V,20)，兩窗皆含當日；窗內有缺就不算（不補值）
            if i >= 19:
                w20 = V[i - 19:i + 1]
                if all(x is not None for x in w20):
                    a5, a20 = sma(w20[-5:], 5), sma(w20, 20)
                    if a5 is not None and a20 and a5 / a20 >= 2 and C[i] > pc:
                        r["sig"].add("AS-16")
                        cnt["AS-16"] += 1

    for sid, n in cnt.items():
        diag[sid] = dict(cand=n, tie=None)
    return True


def load_daytrade(days):
    """讀 dt_*.json.gz（fetch.py 產出，{code: 當沖成交股數}）→ {date: {code: vol}}。

    **不改 run_sorting.load() 的回傳簽章**：那支被 run_sorting/run_down 等多支腳本共用，
    加欄等於改公用介面。當沖只有本檔（AS-17）要用，讀檔就留在本檔。
    缺檔＝該日沒有當沖快取（假日以外就是還沒抓／整日空殼未寫檔），一律回不存在，
    由 cache_has_daytrade 判是否放行。
    """
    out = {}
    for d in days:
        f = rs.CACHE / f"dt_{d}.json.gz"
        if f.exists():
            out[d] = rs.rgz(f) or {}
    return out


def daytrade_days(days, price, daytrade):
    """回 (帶當沖快取的交易日, 非空交易日)。判定單位同 volume_days：以「日」為準。

    非空日的定義沿用 price 快取（有價格列＝有開市）；當沖快取為空 dict 的日子
    **不算帶**——那正是 fetch.py 遇到整日空殼時不寫檔、或假日寫空檔的情形。
    """
    have, nonempty = [], []
    for d in days:
        rows = price.get(d) or {}
        if not rows:
            continue
        nonempty.append(d)
        if daytrade.get(d):
            have.append(d)
    return have, nonempty


def cache_has_daytrade(days, price, daytrade):
    """當沖快取是否**完整**：所有非空交易日都要有非空的 dt 快取，缺一天就回 False。

    判準逐字比照 cache_has_volume（2026-08-30 改嚴的那條）：fetch.py 的續傳是逐檔
    跳過，只補一部分日就會做出「一半有當沖一半沒有」的混合快取。放行混合快取的話，
    缺檔那幾天的當沖訊號會整批靜默漏掉，報告照印 N 與分層而讀者無從察覺。
    """
    have, nonempty = daytrade_days(days, price, daytrade)
    return bool(nonempty) and len(have) == len(nonempty)


def attach_daytrade_signals(samples, days, price, daytrade, diag):
    """AS-17：當沖比率 > DT_RATIO_MIN。快取不完整時整批不掛並回 False。

    分子＝當沖快取的當沖成交股數；分母＝同日同檔 price 陣列的 Trading_Volume（索引 5）。
    **兩者都是「股」**（見檔頭 SIGNALS_P2 的查證段），所以直接相除、不做任何單位換算；
    分母若缺（舊快取無 volume 欄）或 ≤0 則該筆跳過——用金額當分母會算出無意義的數。
    """
    if not cache_has_volume(days, price) or not cache_has_daytrade(days, price, daytrade):
        diag["AS-17"] = dict(cand=0, tie=None)
        return False

    cnt = 0
    for r in samples:
        dt_vol = (daytrade.get(r["d"]) or {}).get(r["c"])
        if not dt_vol:
            continue
        total = vol_of((price.get(r["d"]) or {}).get(r["c"]))
        if not total or total <= 0:
            continue
        if dt_vol / total > DT_RATIO_MIN:
            r["sig"].add("AS-17")
            cnt += 1
    diag["AS-17"] = dict(cand=cnt, tie=None)
    return True


def attach_all(samples, days, price):
    """把 14 個訊號旗標掛上樣本，回排序欄診斷 dict。"""
    for r in samples:
        r["sig"] = set()
    diag = {}
    attach_inst_signals(samples, diag)
    attach_share_signals(samples, days, price, diag)
    attach_technical_signals(samples, days, price, diag)
    return diag


# ════════════════════════════════════════════════════════════════
# 三、評估（預註冊書 §1.2~§1.6）
# ════════════════════════════════════════════════════════════════

def daily_series(rows):
    """§1.3 第二層：每個訊號日先取當日訊號股 e3 平均 → 逐日平均超額序列。"""
    by_d = {}
    for r in rows:
        by_d.setdefault(r["d"], []).append(r["e3"])
    return [(d, st.mean(by_d[d])) for d in sorted(by_d)]


def split_index(days):
    """§1.4：交易日清單依索引對半切（不指定日期，由程式執行時算）。"""
    return len(days) // 2


def evaluate_signal(rows, days):
    """回一個訊號的全部統計與判準結果（不含分層，見 classify_tier）。"""
    cut = split_index(days)
    first = set(days[:cut])
    s = rs.stat(rows)
    ser = daily_series(rows)
    h1 = rs.stat([r for r in rows if r["d"] in first])
    h2 = rs.stat([r for r in rows if r["d"] not in first])
    day_avg = st.mean(v for _, v in ser) * 100 if ser else None
    res = dict(
        n=s["n"] if s else 0,
        stat=s,
        e1_avg=(st.mean(r["e1"] for r in rows) * 100) if rows else None,
        e3_avg=s["e3_avg"] if s else None,
        day_n=len(ser),
        day_avg=day_avg,
        day_pos=(sum(1 for _, v in ser if v > 0) / len(ser) * 100) if ser else None,
        h1=h1, h2=h2,
        cut_day=(days[cut - 1] if cut else None),
        next_day=(days[cut] if cut < len(days) else None),
    )
    e3 = res["e3_avg"]
    res["c_n"] = res["n"] >= MIN_N_FULL
    res["c_eff"] = e3 is not None and abs(e3) >= MIN_ABS_E3
    res["c_half_n"] = bool(h1 and h2 and h1["n"] >= MIN_N_HALF and h2["n"] >= MIN_N_HALF)
    res["c_half_sign"] = bool(h1 and h2 and (h1["e3_avg"] > 0) == (h2["e3_avg"] > 0))
    res["c_day_sign"] = bool(day_avg is not None and e3 is not None
                             and (day_avg > 0) == (e3 > 0))
    # §1.4 存活＝前後兩段同號 且 各段 N≥200
    res["survive_half"] = res["c_half_n"] and res["c_half_sign"]
    return res


def classify_tier(res):
    """§1.6 三層。

    判準逐條照 §1.5，不加不減。§1.6 的 B 層字面是「效果量夠但切半不同號」——
    表格未窮舉「效果量夠但全期 N 不足／日層級不同號」這兩種組合，本檔一律歸 B
    並在報告逐條標出實際未過的判準（歸 A 太寬、歸 C 會與「未達效果量門檻」的
    C 層定義矛盾）。這是實作判斷，不是判準變更。
    """
    if not res["c_eff"]:
        return "C"
    if (res["c_n"] and res["survive_half"] and res["c_day_sign"]):
        return "A"
    return "B"


def dir_match(sig, res):
    """預期方向是否相符。雙邊訊號回 None（§2 前言：方向不明者明列為雙邊並計 2 次）。"""
    if sig["dir"] == "both" or res["e3_avg"] is None:
        return None
    return res["e3_avg"] > 0 if sig["dir"] == "long" else res["e3_avg"] < 0


# ════════════════════════════════════════════════════════════════
# 四、報告
# ════════════════════════════════════════════════════════════════

def doc_commit():
    """預註冊書的 commit hash 與時間（§4.4：報告開頭標明，供人核對先註冊後測）。"""
    try:
        p = subprocess.run(["git", "log", "-1", "--format=%H %cI", "--", str(DOC)],
                           cwd=str(ROOT), capture_output=True, text=True, timeout=15)
        info = p.stdout.strip() or "（查無 commit 紀錄）"
        d = subprocess.run(["git", "status", "--porcelain", "--", str(DOC)],
                           cwd=str(ROOT), capture_output=True, text=True, timeout=15)
        return info, bool(d.stdout.strip())
    except Exception as e:                                   # noqa: BLE001
        return f"（無法取得：{e}）", False


def _p(v, unit="%"):
    return "N/A" if v is None else f"{v:+.2f}{unit}"


def render_signal(sig, res, diag, lines):
    lines.append(f"\n## {sig['id']}　{sig['desc']}")
    lines.append(f"來源：{sig['src']}　預期方向：{DIR_LABEL[sig['dir']]}"
                 f"　檢定次數：{sig['weight']}")
    if not res["n"]:
        lines.append("**無樣本**（此訊號在本期快取內從未觸發）")
        lines.append("**分層**：C（陰性；無樣本，未達效果量門檻）")
        lines.append("")
        return
    lines.append(rs.fmt("  pooled 全期", res["stat"]))
    lines.append(f"  （描述用，不列判準）T+1 超額 e1 平均 {_p(res['e1_avg'])}")
    lines.append(f"  日層級：訊號日 {res['day_n']} 天　逐日平均超額 {_p(res['day_avg'])}"
                 f"　正報酬日佔比 {res['day_pos']:.1f}%")
    lines.append(rs.fmt("  前半段", res["h1"]))
    lines.append(rs.fmt("  後半段", res["h2"]))
    d = diag.get(sig["id"]) or {}
    if d.get("tie") is not None:
        flag = "（> 上限，排序欄無有效變異）" if d["tie"] > rs.MAX_TIE_RATE else ""
        lines.append(f"  排序欄診斷：候選 {d['cand']} 筆　最大平手率 {d['tie'] * 100:.1f}%{flag}")
    dm = dir_match(sig, res)
    lines.append("  判準逐條（§1.5）：")
    lines.append(f"    [{'✓' if res['c_n'] else '✗'}] 全期 N ≥ {MIN_N_FULL}（實際 {res['n']}）")
    lines.append(f"    [{'✓' if res['c_eff'] else '✗'}] 全期 |e3 平均| ≥ {MIN_ABS_E3:.2f}%"
                 f"（實際 {abs(res['e3_avg']):.2f}%）")
    lines.append(f"    [{'✓' if res['c_half_n'] else '✗'}] 前後半各自 N ≥ {MIN_N_HALF}"
                 f"（{res['h1']['n'] if res['h1'] else 0} / {res['h2']['n'] if res['h2'] else 0}）")
    lines.append(f"    [{'✓' if res['c_half_sign'] else '✗'}] 切半同號"
                 f"（{_p(res['h1']['e3_avg']) if res['h1'] else 'N/A'} /"
                 f" {_p(res['h2']['e3_avg']) if res['h2'] else 'N/A'}）")
    lines.append(f"    [{'✓' if res['c_day_sign'] else '✗'}] 逐日平均超額與 pooled 同號"
                 f"（{_p(res['day_avg'])} / {_p(res['e3_avg'])}）")
    tier = classify_tier(res)
    note = {"A": "存活", "B": "半段活／穩健性未過（疑似過擬合，不做卡）", "C": "陰性"}[tier]
    lines.append(f"**分層**：{tier}（{note}）")
    if dm is None:
        lines.append("  方向：雙邊檢定，兩種符號皆在預註冊範圍內。")
    elif dm:
        lines.append("  方向：與預註冊方向相符。")
    else:
        lines.append("  方向：**與預註冊方向相反**——依 §2 前言不得改稱反向訊號，"
                     "此結果只能記為該方向的證據不足。")
    lines.append("\n### 逐月")
    rows_fmt = rs.fmt if sig["dir"] != "short" else rs.fmt_dn
    monthly_rows = res.get("_rows")
    if monthly_rows:
        rs.monthly(monthly_rows, rows_fmt, lines)
    lines.append("")


def _vol_cov_line(vol_cov):
    """第二階段的快取涵蓋揭露行。vol_cov=(帶 volume 的日, 非空日)，None 代表沒帶進來。

    為什麼要印：閘門改嚴後「跑或不跑」是二元的，但讀者看不到快取到底涵蓋哪一段。
    比照 KNOWN_BIASES 的揭露文化，把實際範圍寫進報告，混合快取一眼看得出來。
    """
    if not vol_cov:
        return None
    have, nonempty = vol_cov
    if not nonempty:
        return "快取 volume 涵蓋：無非空交易日。"
    span = f"（{have[0]} ~ {have[-1]}）" if have else ""
    return (f"快取 volume 涵蓋：{len(have)}/{len(nonempty)} 個非空交易日{span}。"
            "閘門要求**全部非空日皆帶 volume**——只重抓部分日造成的混合快取會被擋下、"
            "本節整批不跑，而不是靜默漏算那幾天。")


def _dt_cov_line(dt_cov):
    """AS-17 的當沖快取涵蓋揭露行（比照 _vol_cov_line，同一套揭露文化）。"""
    if not dt_cov:
        return None
    have, nonempty = dt_cov
    if not nonempty:
        return "快取當沖涵蓋：無非空交易日。"
    span = f"（{have[0]} ~ {have[-1]}）" if have else ""
    return (f"快取當沖涵蓋：{len(have)}/{len(nonempty)} 個非空交易日{span}。"
            "閘門要求**全部非空日皆有當沖快取**——缺幾天就整批不跑 AS-17，"
            "不靜默漏算那幾天。")


def render_signal_skipped(sig, lines, reason):
    """某個第二階段訊號沒跑時的段落：明說沒跑與原因，**不印分層**（沒跑就沒有結果）。"""
    lines.append(f"\n## {sig['id']}　{sig['desc']}")
    lines.append(f"來源：{sig['src']}　預期方向：{DIR_LABEL[sig['dir']]}"
                 f"　檢定次數：{sig['weight']}")
    lines.append(f"**本次未跑**：{reason}")
    lines.append("")


def build_report(days, samples, results, diag, doc_info, dirty, results_p2=None,
                 vol_cov=None, dt_cov=None):
    """results_p2 空（None 或 {}）代表第二階段一個都沒跑，報告改印未跑說明。

    results_p2 也可能**只含部分訊號**（例：price 快取有 volume 但當沖快取不完整 →
    AS-15/16 跑、AS-17 不跑）。缺的那些走 render_signal_skipped，明說沒跑，
    不會混進總表假裝有結果。

    vol_cov／dt_cov＝volume_days()／daytrade_days() 的回傳，
    只用來在第二階段那節揭露兩種快取的實際涵蓋範圍。
    """
    cut = split_index(days)
    ctrl = [r for r in samples if r["surge"] < 1.2 or abs(r["ret"]) < 0.01]
    lines = [
        "# 全站 Alpha 盤點掃描報告（第一階段）",
        "",
        f"依 `docs/alpha-sweep-preregistration.md` 執行；該文件 commit：`{doc_info}`"
        + ("　**⚠ 工作區中該文件有未 commit 的修改，先註冊後測的憑據不完整**" if dirty else ""),
        "",
        f"> 本次共檢定 {K_TESTS} 個訊號。若全部為無效訊號，在名目 5% 水準下預期仍有約 "
        f"{0.05 * K_TESTS:.1f} 個會偶然「看起來有效」。請據此對 A 層結果打折。",
        "",
        f"（K＝{K_TESTS} 由候選清單自動帶入：{len(SIGNALS)} 列，其中 "
        f"{sum(1 for s in SIGNALS if s['dir'] == 'both')} 列為雙邊檢定各計 2。）",
        "",
        f"期間 {days[0]} ~ {days[-1]}（{len(days)} 交易日）"
        f"· 流動性 ≥ {rs.LIQ / 1e8:.0f} 億 · 排除 ETF/興櫃 · 收盤對收盤、未除權息調整",
        f"個股 stock-day 樣本：{len(samples):,}",
        f"切半：依交易日索引對半切（非人工指定日期）——前段 {days[0]} ~ {days[cut - 1]}"
        f"（{cut} 日）、後段 {days[cut]} ~ {days[-1]}（{len(days) - cut} 日）",
        "",
        "## 主要結果變數",
        "T+3 對 TAIEX 超額（`e3`）為唯一主要指標；T+1（`e1`）只作描述用途、不列入採用判準（§1.2）。",
        "不報 p 值：stock-day 樣本同一天內高度相關，當獨立樣本算 p 值會把顯著性灌到離譜（§1.3）。",
        "改用兩層：pooled 效果量 ＋ 日層級序列（每個訊號日先取當日訊號股 e3 平均）。",
        "",
        "## 採用門檻（§1.5，先訂）",
        "| 判準 | 門檻 |",
        "|---|---|",
        f"| 全期 N | ≥ {MIN_N_FULL} |",
        f"| 前後半各自 N | ≥ {MIN_N_HALF} |",
        f"| 全期 \\|e3 平均\\| | ≥ {MIN_ABS_E3:.2f}% |",
        "| 切半同號 | 必須 |",
        "| 逐日平均超額與 pooled 同號 | 必須 |",
        "",
        "## 對照組基準（§1.1：同流動性、明確無訊號）",
        rs.fmt("對照組 surge<1.2 或 |ret|<1%", rs.stat(ctrl)),
        "",
        "## 已知偏差（1–4＝預註冊 §2.2；5＝實作揭露。必須隨結果一起讀）",
    ]
    for i, b in enumerate(KNOWN_BIASES, 1):
        lines.append(f"{i}. {b}")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("# 訊號逐項結果（14 列，與預註冊書 §2.1 逐項對應）")

    for sig in SIGNALS:
        render_signal(sig, results[sig["id"]], diag, lines)

    lines.append("---")
    lines.append("")
    lines.append("# 三層總表（§1.6）")
    tiers = {"A": [], "B": [], "C": []}
    for sig in SIGNALS:
        tiers[classify_tier(results[sig["id"]])].append(sig)
    head = ("| 訊號 | 定義 | 方向 | N | e3 平均 | 日層級平均 | 正報酬日 | 前半 e3 | 後半 e3 |"
            "\n|---|---|---|---:|---:|---:|---:|---:|---:|")
    titles = {
        "A": "## A. 存活（全部門檻通過）— 候選做卡，但仍需單獨複驗",
        "B": "## B. 半段活（效果量夠，但穩健性門檻未全過）— 疑似過擬合，**不做卡**",
        "C": "## C. 陰性（未達效果量門檻）— 照實列出，一項不漏",
    }
    for t in ("A", "B", "C"):
        lines.append("")
        lines.append(titles[t])
        if not tiers[t]:
            lines.append("（本層無訊號）")
            continue
        lines.append(head)
        for sig in tiers[t]:
            r = results[sig["id"]]
            desc = sig["desc"].replace("|", "\\|")     # AS-01 的 min(|…|,|…|) 會拆掉表格欄
            pos = "N/A" if r["day_pos"] is None else f"{r['day_pos']:.1f}%"
            h1 = _p(r["h1"]["e3_avg"]) if r["h1"] else "N/A"
            h2 = _p(r["h2"]["e3_avg"]) if r["h2"] else "N/A"
            lines.append(
                f"| {sig['id']} | {desc} | {DIR_LABEL[sig['dir']]} | {r['n']} |"
                f" {_p(r['e3_avg'])} | {_p(r['day_avg'])} | {pos} | {h1} | {h2} |")

    # ── 第二階段（量能）：與第一階段分開列、分開計 K（§2.5 凍結第一階段清單）──
    lines.append("")
    lines.append("---")
    lines.append("")
    if not results_p2:
        lines.extend([
            "# 第二階段：量能與當沖訊號（**本次未跑**）",
            "",
            "快取的 `Trading_Volume` 欄不完整（舊格式的 price 陣列只有 5 欄），"
            "AS-15/16/17 整批跳過（AS-17 的分母也是這一欄）。",
            "解鎖方式：刪掉**全部** `backtest/cache/price_*.json.gz` 後重跑 `backtest/fetch.py`"
            "（fetch.py 2026-08-30 起已把該欄存在陣列索引 5）。"
            "**只刪一部分沒有用**：fetch.py 的續傳是逐檔跳過，會留下一半有一半沒有的混合快取，"
            "閘門一樣不放行。",
        ])
        cov = _vol_cov_line(vol_cov)
        if cov:
            lines.append(cov)
        dcov = _dt_cov_line(dt_cov)
        if dcov:
            lines.append(dcov)
    else:
        ran = [s2["id"] for s2 in SIGNALS_P2 if s2["id"] in results_p2]
        missing = [s2["id"] for s2 in SIGNALS_P2 if s2["id"] not in results_p2]
        lines.extend([
            "# 第二階段：量能與當沖訊號（預註冊書 §6）",
            "",
            f"> 本節另外檢定 {K_TESTS_P2} 個訊號。K 與第一階段的 {K_TESTS} **不合併**"
            "（§2.5 已凍結第一階段清單，事後併算等於加碼），多重比較請分兩段各自折算："
            f"本節若全為無效訊號，名目 5% 水準下預期約 {0.05 * K_TESTS_P2:.2f} 個會偶然看起來有效。",
            "",
            f"（K_TESTS_P2＝{K_TESTS_P2} 由 §6.1 的清單自動帶入：{len(SIGNALS_P2)} 列，其中 "
            f"{sum(1 for s2 in SIGNALS_P2 if s2['dir'] == 'both')} 列為雙邊檢定各計 2。"
            "**K 是預註冊的檢定次數，不因某個訊號本次沒跑而下修**——下修等於事後挑數字。）",
            "",
            "解鎖條件：AS-15/16＝快取的**每一個**非空交易日都帶 `Trading_Volume`"
            "（fetch.py 的 price 陣列索引 5）；AS-17 另需**每一個**非空交易日都有當沖快取"
            "（fetch.py 的 `dt_*.json.gz`，FinMind `TaiwanStockDayTrading`）。",
            "訊號定義取自原始出處，非本報告自訂：AS-15＝postmkt `src/build_diag.py` 的 "
            "`vs`／`vb`；AS-16＝`worker/src/index.js` 的 `volumeRatio`；"
            "AS-17＝postmkt `build_postmkt.py build_daytrading`／`src/build_diag.py` 的 `dt`"
            "／本 repo `worker/src/index.js` 的 `buildDayTrade` 三處同一個算式"
            "（當沖成交股數 ÷ 同日 `Trading_Volume`，兩者皆為「股」）。",
            "**AS-16 列為雙邊**：兩處來源都只把「爆量」寫成中性的量能描述、未宣稱多空，"
            "預註冊書 §2.3 也沒訂方向——依 §2 前言，方向不明者明列雙邊並計 2 次。",
            "**AS-17 的門檻與方向**：門檻「當沖比率 > 60%」與資料源為使用者 2026-08-30 裁定；"
            "**方向不是使用者指定的**——使用者未指定方向，`both` 是套用 §2 前言"
            "「方向不明者明列雙邊並計 2 次」的既有預設規則（同 AS-03/04/16）。",
            "**AS-15 的方向來源**：`short` **非預註冊書原訂**——§2.3 只寫了訊號名稱與解鎖"
            "條件、沒有方向欄。方向依據＝postmkt `DIAG_RULES` 把該規則（`id:\"P2\"`）歸為"
            "`col:\"red\"` 的**風險側**，屬卡面風險提示的分類，強度不等於「已聲明為做空訊號」"
            "（同一條還自標 `ver:false`＝來源自承未驗證）；此方向已於 2026-08-30 經使用者"
            "裁定確認採用（維持 short／weight 1）。**兩者證據等級不同**：來源仍是風險側歸類，"
            "使用者裁定的是「就採用這個方向」，不是替它補上實證。詳見 §6.2。",
        ])
        if missing:
            lines.append(f"**本次實跑 {len(ran)} 個訊號**（{'、'.join(ran)}）；"
                         f"{'、'.join(missing)} 未跑，原因見各自段落與下方涵蓋揭露。")
        for line in (_vol_cov_line(vol_cov), _dt_cov_line(dt_cov)):
            if line:
                lines.append(line)
        for sig in SIGNALS_P2:
            if sig["id"] in results_p2:
                render_signal(sig, results_p2[sig["id"]], diag, lines)
            else:
                render_signal_skipped(sig, lines, P2_SKIP_REASON[sig["id"]])
        lines.append("")
        lines.append("## 第二階段三層總表")
        lines.append(head)
        for sig in SIGNALS_P2:
            desc = sig["desc"].replace("|", "\\|")
            if sig["id"] not in results_p2:
                lines.append(
                    f"| {sig['id']} | {desc} | {DIR_LABEL[sig['dir']]} | — | — | — | — | — | — |"
                    " ← **本次未跑**（不分層）")
                continue
            r = results_p2[sig["id"]]
            pos = "N/A" if r["day_pos"] is None else f"{r['day_pos']:.1f}%"
            h1 = _p(r["h1"]["e3_avg"]) if r["h1"] else "N/A"
            h2 = _p(r["h2"]["e3_avg"]) if r["h2"] else "N/A"
            lines.append(
                f"| {sig['id']} | {desc} | {DIR_LABEL[sig['dir']]} | {r['n']} |"
                f" {_p(r['e3_avg'])} | {_p(r['day_avg'])} | {pos} | {h1} | {h2} |"
                f" ← 分層 {classify_tier(r)}")

    opposite = [s["id"] for s in SIGNALS
                if classify_tier(results[s["id"]]) == "A" and dir_match(s, results[s["id"]]) is False]
    lines.extend([
        "",
        "---",
        "",
        "# 注意事項",
        "- 收盤對收盤報酬，未含交易成本/滑價；股價未除權息調整（7-8 月除息季偏多）。",
        "- 個股名單以目前 classify 為準，期間內下市股不在樣本（輕微存活偏差）。",
        "- A 層結果不直接進圖卡規格；每一個要單獨複驗（獨立 subagent、fresh context）後才進（§4.3）。",
        "- 本報告未做分位（quintile）分析：預註冊書未列，臨時加會增加實際檢定次數，"
        "與 §1.7 的多重比較揭露互相矛盾。排序欄只印平手率診斷。",
        "- 指標定義沿用 Worker 生產純函式（`worker/src/index.js` 的 sma/kd/macd/rsi/boll "
        "與狀態描述函式，以函式名為準）的 Python 移植；"
        "兩份實作的一致性由 `backtest/test_alpha_parity.mjs` 逐 index 比對守門。",
    ])
    if opposite:
        lines.append(f"- ⚠ A 層中 {'、'.join(opposite)} 的超額符號與預註冊方向相反。"
                     "依 §2 前言，不得事後改稱反向訊號。")
    return lines


# ════════════════════════════════════════════════════════════════
# 五、主程式
# ════════════════════════════════════════════════════════════════

def main():
    print("載入快取資料...", flush=True)
    days, price, inst, _cl = rs.load()
    if not days:
        print("backtest/cache/ 沒有快取（需先跑 backtest/fetch.py）", file=sys.stderr)
        return 1
    print(f"交易日 {len(days)} 天（{days[0]} ~ {days[-1]}）")

    print("建構個股樣本...", flush=True)
    samples, _tx, _ma = rs.build_stock_samples(days, price, inst)
    print(f"個股 stock-day 樣本：{len(samples):,}")

    print("掛訊號旗標（14 個候選）...", flush=True)
    diag = attach_all(samples, days, price)

    results = {}
    for sig in SIGNALS:
        rows = [r for r in samples if sig["id"] in r["sig"]]
        res = evaluate_signal(rows, days)
        res["_rows"] = rows
        results[sig["id"]] = res
        print(f"  {sig['id']} N={res['n']:6d} e3={_p(res['e3_avg'])} "
              f"→ {classify_tier(res)}", flush=True)

    print("掛第二階段旗標（AS-15/16 量能、AS-17 當沖）...", flush=True)
    vol_cov = volume_days(days, price)
    print(f"  快取 volume 涵蓋 {len(vol_cov[0])}/{len(vol_cov[1])} 個非空交易日", flush=True)
    daytrade = load_daytrade(days)
    dt_cov = daytrade_days(days, price, daytrade)
    print(f"  快取當沖涵蓋 {len(dt_cov[0])}/{len(dt_cov[1])} 個非空交易日", flush=True)

    # 兩組解鎖條件不同（量能只要 volume 欄、當沖另要 dt 快取），所以分開掛、分開回報。
    ran_ids = []
    if attach_volume_signals(samples, days, price, diag):
        ran_ids += ["AS-15", "AS-16"]
    else:
        print("  快取 volume 不完整 → AS-15/16 整批跳過"
              "（刪**全部** price_*.json.gz 重跑 fetch.py 才解鎖；"
              "只刪一部分會留下混合快取，閘門一樣不放行）", flush=True)
    if attach_daytrade_signals(samples, days, price, daytrade, diag):
        ran_ids.append("AS-17")
    else:
        print("  快取當沖（dt_*.json.gz）不完整或分母缺 volume → AS-17 跳過"
              "（整批刪快取重跑 fetch.py 才解鎖）", flush=True)

    results_p2 = {}
    for sig in SIGNALS_P2:
        if sig["id"] not in ran_ids:
            continue
        rows = [r for r in samples if sig["id"] in r["sig"]]
        res = evaluate_signal(rows, days)
        res["_rows"] = rows
        results_p2[sig["id"]] = res
        print(f"  {sig['id']} N={res['n']:6d} e3={_p(res['e3_avg'])} "
              f"→ {classify_tier(res)}", flush=True)

    doc_info, dirty = doc_commit()
    lines = build_report(days, samples, results, diag, doc_info, dirty, results_p2,
                         vol_cov, dt_cov)
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n已寫 {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
