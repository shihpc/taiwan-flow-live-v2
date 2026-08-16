# LINE 圖卡體系規格（依現況修訂版）

目標專案：`/home/user/taiwan-flow-live-v2`（Cloudflare Worker `worker/src/index.js`）
狀態：**已上線運行**（2026-07-29 首晚實推；PNG 呈現層 2026-07-30 改向；AM 晨間場 2026-08-10；
白名單 2026-08-16 二次裁剪至 5 張）。
本版修訂日 **2026-08-16**，依據＝commit `69c7824`（五項改動：白名單裁至 5 張、新增三合一
看板卡、v2-ov-6 附個股、pm-aetf-5 改排行式、carousel 移除壓底免責卡）與
`worker/src/index.js` 程式現值（`FX_ACTIVE_CARDS`／`FX_AM_CARDS`／`FX_BLOCKED_CARDS`／
`FX_CARD_BUILDERS`）。引用一律用符號名／章節名，不用行號（行號會漂移）。

原始規格 2026-07-28 定稿時寫「規格待審，尚未實作」——那個狀態早已翻頁；歷史裁剪沿革
集中在第 3C 節追溯段。回測依據 `backtest/report_sorting.md`（鐵律 #8）不變。

---

## 0. 現況總覽（2026-08-16，程式現值）

### 晚間場（pm）：`FX_ACTIVE_CARDS` 白名單 5 張 ＋ 長文卡 1 張

| id | 內容 | builder（符號） |
|---|---|---|
| `v2-dash-1` | 三合一看板：大盤總結＋三大法人＋台指期＋成交值列（合併原 v2-ov-1／flows-hdr-1／flows-hdr-2；三源各自獨立降級、三源全缺才 skip） | `fxCardDash1` |
| `v2-ov-6` | 次產業貢獻發散，附每業貢獻絕對值前 3 檔個股（r2 小字；上游 `build_daysummary.py` 的 `subs_stocks` 欄，欄位缺時退回純次產業列） | `fxCardOv6` |
| `flows-foreign-1` | 外資買賣超排行（依金額） | `fxCardInstRank(s,"foreign",…)` |
| `flows-trust-1` | 投信買賣超排行（依金額） | `fxCardInstRank(s,"trust",…)` |
| `pm-aetf-5` | 主動ETF進出個股，排行 rows 形（加碼前 5＋減碼前 5，金額＋張數） | `fxCardAetf5` |
| `pm-summary-1` | 盤後分析摘要長文卡（獨立 Image message，**不進 carousel、不在白名單**，見 §3D） | `fxCardSummaryLongform`（＝`FX_LONGFORM_CARD`） |

**免責卡（2026-08-16 使用者指示，commit `69c7824` ⑤）**：`buildCardCarousels` 不再壓底
免責卡；`disclaimerBubble`／`FX_DISCLAIMER` 程式保留，**純文字降級版 `cardsFallbackText`
仍帶免責句**（`※ FX_DISCLAIMER` 收尾）。

### 晨間場（am）：`FX_AM_CARDS` 白名單 4 張

| id | 內容 | 資料源 |
|---|---|---|
| `am-brief-1` | 每日晨報長文卡（longform，＝`FX_AM_LONGFORM_CARD`） | taiwan-stock-news `daily-brief-card.json`（`DAILY_BRIEF_URL`） |
| `news-morning-2` | 籌碼備忘 | morning.json |
| `news-morning-3` | 昨日資金流向 | morning.json／daysummary |
| `news-morning-4` | 美股速覽（per-card gate：us.json date 達最近預期美股交易日） | us.json |

時窗：渲染 dispatch 台北 08:05–08:15（`runCardsRenderAm`）→ 推播 08:20–08:50
（`pushMorningCards`，dedup KV `alerted:<date>:cards-am`）。晨間**無**純文字退路。
`am-brief-1` **刻意不進 `FX_CARD_BUILDERS`**（避免污染晚間 skipped 觀測），由
`buildCardsData(slot=am)` 單獨組裝。

### C 類封鎖：`FX_BLOCKED_CARDS` 5 張（規範見 §3B.3，**回測前不得上線**）

`flows-sync-1`／`flows-sync-2`／`flows-oppose-1`／`flows-oppose-2`／`pm-aetf-1`——
`assertCardAllowed` 建構時即擋，Flex 與純文字兩通道皆過同一道守門。

### builder 庫：`FX_CARD_BUILDERS` 35 張全保留

白名單外的卡 builder 一律保留（含 sig 訊號卡六張、被合併的 v2-ov-1／flows-hdr-1/2 等），
**加回 `FX_ACTIVE_CARDS` 即復活**；重啟任何一張時，本文件對該卡的約束（§3／§3B／§4）照舊適用。

### 管線（spec 3C 呈現層，符號串）

`buildCardsData`（`/cards/data`，卡片邏輯唯一來源）→ `cards.yml`（Actions）→
`src/build_cards_png.py`（Pillow 渲染，Python 只渲染不算數）→ commit `data/cards/latest|am/`
→ **raw.githubusercontent 供 HTTPS URL**（`RAW_BASE_ROOT`，**非 GitHub Pages**——Pages 不吃
這批檔，原文誤記已更正）→ `pushDailyCards`／`pushMorningCards` 讀 manifest 掛 hero 圖；
manifest 非當日或缺圖＝退文字版（僅 pm；am 無文字退路）。

---

## 1. 核心約束：訊息額度決定架構

LINE 的計費單位是**收訊人數**，不是 message object 數、也不是 bubble 數：

> The number of messages is counted by the number of people you send a message to... The number of message objects in a request doesn't affect the number of messages sent.
> — https://developers.line.biz/en/docs/messaging-api/pricing/#how-to-count-the-number-of-messages-sent

> ✅ **本帳號實測額度已確認（2026-07-29）**：`GET /v2/bot/message/quota` 回
> `{"type":"limited","value":200}`——每月 200 則。

**現況成本（2026-08-16 起，推算）**：收訊人 1 位（`LINE_USER_ID`）；晚間 1 push
（1 carousel ≤12 bubble ＋ 長文 image message 同一 request、零計費增量）＋晨間 1 push
＝每交易日 2 則 → 每月約 44 則、佔 200 的 22%。一次 push 可帶 5 個 message object、
每 carousel 上限 12 bubble；現役 5 張 flex 卡遠低於上限，加卡不增加費用。
（歷史卡數表 38／40 張×4 carousel 屬 2026-07-28 定案版，已被 3C 裁剪取代，見 §3C。）

---

## 2. Flex 硬性限制（已查證，附出處）

| 項目 | 限制 | 出處 |
|------|------|------|
| carousel 內 bubble 數 | **最多 12** | https://developers.line.biz/en/reference/messaging-api/#f-carousel |
| carousel 內 bubble `size` | **必須全部相同** | 同上 |
| `altText` | **必填**，上限 **1500 字** | https://developers.line.biz/en/reference/messaging-api/#flex-message |
| 單一 bubble JSON | 30 KB | https://developers.line.biz/en/reference/messaging-api/#bubble |
| 單一 carousel JSON | 50 KB | https://developers.line.biz/en/reference/messaging-api/#f-carousel |
| 整個 HTTP request | 2 MB，超過回 `413` | https://developers.line.biz/en/reference/messaging-api/#status-codes |
| 一次 push 的 message object 數 | 1–5，超過回 400 | https://developers.line.biz/en/reference/messaging-api/#send-push-message |
| 超出免費額度 | 回 `429`，**訊息不會送出** | https://developers.line.biz/en/docs/messaging-api/pricing/ |

**注意：`altText` 上限是 1500，不是網路上流傳的 400。**
KB 上限一律量 **UTF-8 位元組**（`utf8len`）——`JSON.stringify().length` 是 UTF-16 字元數，
中文 1 字 3 bytes，用字元數守門會鬆 3 倍（2026-07-28 實 bug）。

### 排版能力（實作時的坑）

- **沒有 table 元件**：表格用 box 疊（外層 `vertical`、每列 `horizontal`、欄寬 `flex` 比例、
  數值欄 `align:"end"`）。
- **`wrap` 預設 `false`，溢出文字被省略號截斷**——所有多字文字元件必須顯式 `wrap:true`
  （最容易漏的一條，測試全樹斷言守著）。
- `flex:0` 元件超出 box 寬度的部分直接切掉；`baseline` box 子元件只能是 icon/text/filler。
- 顏色可自由 hex，紅漲綠跌做得到；LINE 貼圖式 emoji（`$` placeholder）在 Flex 內用不了。

---

## 3. 訊號卡（6 張，有回測依據；**現況全數停用**）

> 現況（2026-08-16）：卡 3（`sig-new-high`）／卡 4（`sig-new-low`）於 2026-07-30 裁剪
> 未再啟用；卡 1/2/5/6（`sig-sub-surge`／`sig-dual-buy`／`sig-exit-sell`／`sig-surge-warn`）
> 於 2026-08-16 移出白名單（commit `69c7824` ①）。builder 與 regime 閘門程式全保留，
> **重啟任何一張時本節結論與限制照舊適用**。

### 3.1 卡別清單（依回測結論，不得自行加碼）

排序欄位一律引用 `backtest/report_sorting.md` 的結論（2026-07-27 重跑版，任意
`PYTHONHASHSEED` 產出 byte-identical，見 §8；報告內段落＝M1/M3/M4/S1/S2 等節名）。

| # | 卡 | 篩選條件 | 排序 | 回測依據（報告節） |
|---|---|------|------|------|
| 1 | 次產業湧入 | C≥1.5 且 R≥1% | **R 值降序**（分離度 0.97%） | M1 |
| 2 | 土洋同買 | 湧入 ∩ 投信近3日≥2日買超 ∩ 外資近3日≥2日買超 | **外資當日買超金額降序**（Q1 med +1.74%） | M3 |
| 3 | 突破新高 | **僅**突破20日新高（單條件） | **法人買強度降序**（分離度 0.92%） | M4 |
| 4 | 弱勢榜 | 跌破20日新低（排除跌停鎖死） | **量能趨勢降序**（分離度 0.45%） | S1 |
| 5 | 退出＋法人賣 | 退出 ∩ 法人賣強度<−5% | **不排序**（候選欄一個無變異、一個分離度 0.01%） | S2 ⚠ |
| 6 | 追高警示 | 爆量大漲 S≥2 R≥2% P≥0.7（排除漲停鎖死） | **不排序**，S 值降序呈現 | 追高段 |

**卡 3 的重大限制：母體本身無正超額**（全體 N=15107、T+3 勝大盤僅 41.7%、超額 avg −0.31%；
Q1 也只有 −0.04%）。排序做到的是「把更差的往後排」，不是挑出會漲的——卡面文案不得暗示
Q1 為看多標的。五分位非單調，依 §4 只能當大致分層。

**卡 5 不排序的依據**：「連續退出日數」98.2% 樣本值相同、分離度不可重現（詳 §8）；
「法人賣強度」分離度 0.01% 等同無排序力。⚠ 報告 `run_s2()` 因無採用門檻仍宣告「採用」，
**以本規格「不排序」為準**（未結案，見 §8「仍待處理」）。

### 大盤 Regime 閘門（R1／R2）

- **閘門只掛卡 1 與卡 2**，判定＝TAIEX 收盤 vs 自身 20MA（`fxRegime`，源＝flows
  `totals.json` 的 taiex 序列，容 null；未判定＝視為 bull 不抑制＋note 標註）。
  卡 3–6 有「不翻向」實測依據，不掛。
- **⚠ 兩張的「翻向」都不可當已驗證事實**（鐵律 #4，卡面與文件不得聲稱「空頭時會轉負」）：
  - 卡 1：多頭 avg +0.00% vs 空頭 −0.02%，差僅 0.02pp；**中位數同為負、沒有翻向**
    （多 −0.24%／空 −0.34%）。掛閘門的理由是**保守**（空頭少發卡，錯的代價是少賺），
    不是有效性。
  - 卡 2（R2 補測 2026-07-26）：多頭 N=378 avg +0.68%、空頭 N=31 avg −0.76% 翻向，
    但**空頭樣本僅 31 筆**且均值由 5 筆主導。累積滿 3 個完整空頭月（約 100 筆）後應重跑覆核。
- R1 測的 6 組訊號 ≠ 6 張卡（「乖離>+10% 過熱組」不對應任何卡；卡 2 不在 R1 範圍、
  由 R2 另測）。

---

## 3B. 簡報卡三類誠實標準（2026-07-28 選定 34 張；多數已裁，分類標準仍有效）

34 張多數**沒有**回測依據，與 §3 的 6 張訊號卡適用不同誠實標準，依「是否隱含可操作性」分三類。
現役卡對照：`v2-dash-1`（A 類三卡合併）、`v2-ov-6`（A 類）、`flows-foreign-1`／`flows-trust-1`／
`pm-aetf-5`（B 類）。

### 3B.1 A 類·純描述事實 — 鐵律 #8 不適用

報導今天發生了什麼，不隱含該買該賣，不需回測依據。原 20 張（v2-global-1、v2-ov-1/5/6/7/8/14、
v2-chain-1、flows-hdr-1/2、flows-etf-1、flows-ff-1、pm-block-1、pm-mktbal-1/2、
news-morning-2/3/4、v2-ov-9/10）。貢獻點類特別乾淨：會計恆等式（權重×漲跌，加總＝指數漲跌點），
對已發生事實的分解、零預測成分。原第二期兩張圖表卡 v2-ov-9/10 已由 3C PNG 呈現層改向取代，未實作。

### 3B.2 B 類·排行榜 — 邊界地帶

排的是今日既成事實，但「排行榜」形式隱含「排前面的值得看」。原 9 張（v2-rank-1、
flows-foreign-1、flows-trust-1、pm-aetf-2/4/5、pm-lending-3/4/6）。
**處理原則**：卡面只陳述數值、不加強弱形容詞、不寫「值得關注」類引導語；排序欄位在卡底
標明（例：`依外資買超金額降序`），讓讀者知道順序依據，而非暗示推薦順序。

### 3B.3 C 類·明確是訊號（5 張）— 鐵律 #8 適用，**回測前不得上線**

| 編號 | 卡 | 回測狀態 |
|---|---|---|
| `flows-sync-1` | 外資投信同步買超 Top30 | ＝ **AS-01**：A 層存活，**有條件解鎖**（見下） |
| `flows-sync-2` | 外資投信同步賣超 Top30 | ＝ **AS-02**：C 層陰性（−0.22%），**維持封鎖** |
| `flows-oppose-1` | 外資買·投信賣 Top30 | ＝ **AS-03**：C 層陰性（+0.13%），**維持封鎖** |
| `flows-oppose-2` | 外資賣·投信買 Top30 | ＝ **AS-04**：C 層陰性（+0.12%，切半變號），**維持封鎖** |
| `pm-aetf-1` | 主動ETF 建議句 | 無回測，且**文案需重寫**（見下） |

**Alpha 掃描已於 2026-07-29 實跑**（`backtest/report_alpha_sweep.md`，commit `04ba1ad`；
K=16、A 層 3／B 層 0／C 層 11，A 層 AS-11 方向與預註冊相反不得採計，方向正確存活只有
AS-01 與 AS-14）。AS-01 經 fresh-context 複驗判「**有條件解鎖**」：

**解鎖前置（缺一不可）**：
1. **口徑對齊（阻斷級）**：回測外資＝僅 `Foreign_Investor`，生產＝
   `Foreign_Investor + Foreign_Dealer_Self`——篩選正負判定與 Top30 切點都會漂移。
   二擇一：(a) 卡面資料鏈改用不含外資自營口徑對齊回測；(b) `fetch.py` 補收該列重抓快取、
   重跑掃描確認 AS-01 仍存活。
2. 卡面篩選鏡像回測母體：成交額 ≥1 億、排除 ETF/興櫃、min(|外資額|,|投信額|) 排序帶次鍵 code。

**卡面必標（複驗指定）**：
3. 「歷史統計傾向、非預測；T+3 中位數 −0.31%、勝大盤 47.5%——平均超額來自少數大贏家，
   過半數入選股輸給大盤」。
4. 效果量寫「弱正向傾向」，**不得寫成穩定 +0.5% 期望**（恰壓門檻＋16 訊號多重比較，
   複驗信心：方向為正 ~70-75%、真效果 ≥0.5% 僅 ~35-45%）。
5. 命名明寫「**當日**外資投信同買・金額強度 Top30」——與卡 2（近 3 日連買∩爆量）是不同定義，
   不可共用「土洋同買」做標題。

AS-14（跌破布林下軌，−0.59%，方向正確存活）記為未來弱勢類卡片的現成候選。
AS-11 的反向資訊不得改稱空方訊號。

**`pm-aetf-1` 建議句是唯一直接踩到「不寫該買該賣」的**，上線前必須改寫成描述句：
✗「建議關注 X」→ ✓「本日主動ETF 淨加碼集中在 X」；✗「加碼訊號明確」→ ✓「N 檔 ETF 同向加碼」。

---

## 3C. 內容裁剪沿革（歷史決策追溯）

### 2026-07-30 一次裁剪：39 → 11 張（使用者授權全權評選）

首晚實推後使用者判定內容不夠實用，授權以投資人角度重選。判準三條：
**不開網站也想送到眼前／會影響明天的決定／更新頻率配得上每日推播**。
留 `v2-ov-1`、`v2-ov-6`、`flows-hdr-1/2`、`flows-foreign-1`、`flows-trust-1`、`pm-aetf-5`、
訊號卡 1/2/5/6。砍 22 張的理由分四類：重複（global-1/ov-5/ov-7/ov-8/ov-14/chain-1/rank-1/
morning-3）、晚間已過時（morning-2 是 D-1 晨報、morning-4 是昨晚美股而今晚美股已開盤）、
慢變數週看即可（mktbal-1/2、ff-1、etf-1、lending-3/4/6）、回測無正向依據或有更強子集
（卡 3 母體超額為負、卡 4 讓位給卡 5、aetf-2/4、block-1）。

**呈現層改向（同日決定）**：Pillow 產 PNG 嵌 Flex hero，取代原「第二期 treemap/象限圖」。
Worker `/cards/data` 為卡片邏輯唯一來源、Python 只渲染；PNG 缺席退文字版。
PNG 公開網址由 **raw.githubusercontent** 供應（`RAW_BASE_ROOT`；原文寫 Pages，誤記已更正——
`cards.yml` commit step 明注「PNG 由 raw.githubusercontent 供 LINE hero 引用，網站不吃這批檔」）。

### 2026-08-16 二次裁剪：11 → 5 張（使用者指示，commit `69c7824`）

sig 四張（sub-surge／dual-buy／exit-sell／surge-warn）移出；v2-ov-1＋flows-hdr-1＋flows-hdr-2
合併成 `v2-dash-1` 三合一看板（新增成交值列）；`v2-ov-6` 附每業前 3 檔個股；`pm-aetf-5`
改排行 rows 形；**免責卡自 carousel 移除**（純文字退路仍帶免責句）。現值清單見 §0。
`flows-sync-1` 解鎖路徑保留（§3B.3 口徑覆核通過後可 +1 張）。

---

## 3D. 盤後分析摘要長文卡（2026-08-07 新增，現役）

**卡 id `pm-summary-1`（`FX_LONGFORM_CARD`），走獨立 LINE Image message，不進 Flex carousel。**

- **為什麼不進 carousel**：synthesis 全文約 2000 字，Flex image 硬限 1024×1024 且高不得超過
  寬三倍；實測縮進後有效字級 7.5px 不可讀。Image message 官方明訂像素無上限、檔案 10MB
  （developers.line.biz/en/news/2020/05/12/messaging-api-update-may-2020/）。
- **計費**：按收訊人數計，同一 push 附加這則圖**零計費增量**；push 上限 5 message，超過就不附
  （Flex 優先）。
- **資料流**：postmkt `data/summary/<YYYYMMDD>-pm.json` 的 `synthesis.text` →
  `fxCardSummaryLongform`（摘要日必須等於資料日，否則 skip）→ `/cards/data` →
  `render_longform` → PNG＋preview → manifest → `pushDailyCards` 附加 image message。
- **禁用字**：`fxNeutralize` 先同義中性替換（LLM 長文踩黑名單機率高，整張丟等於常態消失），
  換完仍過 `assertCardAllowed` 最後防線。
- **誠實原則的例外處理（使用者 2026-08-07 定案）**：保留全文、內含方向判斷與假設性進出情境，
  與其餘卡「僅描述歷史統計傾向」不同——標題明標「AI 生成」、專屬免責句、footer 說明差異。
- **降級**：長文任一步失敗都只是「當晚沒有這則圖」，Flex carousel 不受影響。
- **am 場**：晨間平行版＝`am-brief-1` 晨報長文卡（見 §0 晨間場；date 閘門用
  `daily-brief-card.json` 的 date，不用晚間 baseline gate）。晚班 `pushDailyCards` 無 slot、
  硬編碼不動。

---

## 4. 誠實原則（專案鐵律，不可協商）

回測的關鍵限制：**12 個五分位表全部非單調**。排序只能當「大致分層」，名次不具統計意義。

1. **不標名次序號**（不出現「第1名」「Top 1」），僅依值降序排列。
2. **不用「最強／最弱／必漲／該買」等字眼**；狀態詞中性（`FX_FORBIDDEN` 黑名單＋
   `fxNeutralize` 中性化＋ `assertCardAllowed` 守門，Flex 與純文字同一道）。
3. **每張卡底部附口徑註記**（例：`依外資買超金額降序`）。
4. **免責句**：~~carousel 末尾固定一張免責 bubble~~——2026-08-16 起 carousel 不再壓底免責卡
   （使用者指示，commit `69c7824` ⑤）；`FX_DISCLAIMER` 文字與 `disclaimerBubble` 保留，
   **純文字降級版仍以 `※ FX_DISCLAIMER` 收尾**（與 taiwan-stock-news 分頁頂部免責卡同一組
   約定的載體，從 carousel 移到文字退路）。
5. 不做預測宣稱，只描述歷史統計傾向與局限（鐵律 #8）。

---

## 5. 實作接點（符號名，現值）

- `lineRequest(token, userId, textOrMessages)`——可帶任意 message 陣列，字串呼叫端自動包 text。
- `sendAlert(env, text)`——webhook 與 LINE 共用的純文字通道。
- `buildCardCarousels(cards, altText)`——卡陣列 → flex messages（每 carousel ≤12 bubble、
  <50KB；≤5 message；bubble <30KB，皆 UTF-8 位元組）。
- `cardsFallbackText(cards, dateStr)`——純文字降級版（Flex 建構丟例外時 LINE 也退這份），
  同過 `assertCardAllowed`，帶免責句。
- `buildDailyCards(src)`——純函式組卡（無 fetch／KV／Date.now），逐卡獨立失敗記 skipped。
- `buildCardsData(env, tp, …, {slot})`——`/cards/data` 端點主體，`FX_ACTIVE_CARDS`／
  `FX_AM_CARDS` 過濾＋`assertCardAllowed` 縱深過濾；date＝**資料日**（pm＝baseline.date、
  缺→null→Python 拒渲染；am 見新鮮度守門註解）。
- `pushDailyCards`（晚間，manifest date==今日才掛 hero 圖）／`pushMorningCards`（晨間）。
- `runCardsRender`／`runCardsRenderAm`——dispatch `cards.yml`（inputs.slot）。
- Python：`src/build_cards_png.py`（`--slot am|pm`；守門攔截＝成功＋警告 exit 0、
  真故障非零——2026-08-16 修）。
- 測試：`worker/test/` 全部 `.mjs` 離線免 token（cards／dailycards／cardsend／morningcards
  等），`tests/test_cards_png.py`。

---

## 6. 驗收條件（2026-08-16 盤點：已完成項打勾註日期）

- [x] `buildCardCarousels` 純函式、離線可跑（2026-07-29 上線；`test/cards.mjs`）
- [x] 每 carousel ≤12 bubble、size 全同（2026-07-29；`test/cards.mjs`／`test/dailycards.mjs`）
- [x] 一次 push message object ≤5（2026-07-29；超過拋錯，測試涵蓋 61 卡邊界）
- [x] carousel <50KB、bubble <30KB，UTF-8 位元組口徑（2026-07-29；2026-07-28 字元數 bug 已修）
- [x] 整個 request <2MB（結構推得：≤5 carousel×50KB＋image URL 引用，遠低於上限；無單獨測試）
- [x] `altText` 必存在且 ≤1500（2026-07-29；`test/cards.mjs`）
- [x] 所有多字 text 元件 `wrap:true`（2026-07-29；測試遍歷 JSON 樹斷言）
- [x] 每張卡口徑註記行（2026-07-29 線上驗證記錄「口徑註記正確」）；免責 bubble 條目已改制
      （2026-08-16 起 carousel 不附，文字退路帶免責句，見 §4.4）
- [x] 卡面無名次序號、無禁用字（2026-07-29；`FX_FORBIDDEN`＋`assertCardAllowed`，字串比對守門）
- [x] regime 閘門只作用卡 1/卡 2、卡 3–6 不變（2026-07-29；`test/dailycards.mjs` 閘門節）
- [x] R2 已實跑（2026-07-26），卡 2 翻向＋空頭 N=31 限制已記載
- [x] M4 已實跑（2026-07-26），卡 3 排序欄採法人買強度、母體無正超額限制已記載
- [ ] 卡 3 卡面文案不得暗示 Q1 為看多標的——**卡未啟用**（2026-07-30 裁剪），重啟時適用
- [ ] 卡 1/卡 2 卡面與文件不得聲稱「空頭時會轉負」為已驗證——**卡已停用**（2026-08-16 移出
      白名單），重啟時適用
- [x] **C 類 5 張回測結論產出前不得上線**——守門機制已落地（`FX_BLOCKED_CARDS`＋
      `assertCardAllowed`，2026-07-29 起生效）；**規範持續有效**：解鎖唯一路徑＝§3B.3 前置
      條件逐項完成
- [ ] `pm-aetf-1` 建議句文案改寫為描述句——未做（卡仍封鎖，改寫是解鎖前置）
- [x] B 類排行卡卡底標明排序欄位、無強弱形容詞（2026-07-29 線上驗證；現役排行卡沿用）
- [x] 第一期 38 張全部產得出 bubble（2026-07-29 上線達成；其後被 3C 裁剪取代，現役白名單
      5 張，builder 35 張仍全數可產出——`test/dailycards.mjs` 全量組裝節）
- [x] 純文字降級版在 Flex 建構丟例外時仍可產出（2026-07-29；`cardsFallbackText` 測試）
- [x] 既有測試零回歸（持續性條件；最近一次全綠紀錄＝2026-08-16 commit `69c7824`，
      worker/test 20 支）
- [x] 新增測試檔納入 `worker/test/`（cards／dailycards／cardsend／morningcards 等，離線可跑）
- [x] `GET /v2/bot/message/quota` 實測本帳號額度（2026-07-29：limited 200/月）
- [x] **線上驗證**（2026-07-29 首晚實推）：版型／紅漲配色／口徑註記／資料日標註／多 carousel
      皆正確；首晚兩缺陷（流動性過濾、行內標籤折行）已修
- [ ] fresh-context subagent 驗收（鐵律 #3）——無完成紀錄可佐證，保留未勾

---

## 7. 未查證事項（不得寫成定論）

以下沒有官方依據，遇到請實測或走 validate 端點
（`POST https://api.line.me/v2/bot/message/validate/push`）：

1. ~~台灣免費方案每月則數~~ **已解（2026-07-29）**：實測 quota 200/月。
2. carousel 超過 12 bubble 的確切行為（400／截斷／只渲染前 12）。
3. `altText` 超過 1500 字的確切行為（400／自動截斷）。
4. Flex text 元件字數上限——官方確實沒有規定，實務受 30KB/50KB 綁。
5. Flex text 內 Unicode emoji 是否官方支援（只有 `altText` 有明文）。
6. 單一 box 子元件數／巢狀深度上限（官方未規定，以 KB 為實際上限）。

> 事實來源：LINE 官方文件 Markdown 源 `line/line-developers-docs-source`（查證時 commit
> `c7dfdeaf`，2026-07-23），交叉核對官方 OpenAPI `line/line-openapi` 的 `messaging-api.yml`。

---

## 8. 回測腳本的平手值問題（2026-07-26 發現，2026-07-27 已修）

**現象**：同一份 `backtest/cache/`、同一份程式碼，S2「連續退出日數」分離度五次跑出
0.07%～1.36%。**根因**：`codes` 字串 set 走訪順序依 `PYTHONHASHSEED` 隨機，穩定排序讓平手
樣本沿用隨機順序，切點落在平手堆時分組隨機化。

**已實施修正**（`backtest/run_sorting.py`）：
1. 固定迭代順序 `sorted(codes)`——seed 0/7/42 報告 byte-identical，除 S2 外八項結論一字未變。
2. 平手率守門（`quintile()`，`MAX_TIE_RATE = 0.50`）——超限欄位回 `None` 失效安全排除；
   受影響欄位 `consec_exit`（98.2%）與 `consec`（82.0%）已自動排除。
3. 降級路徑補失效安全分支（`run_s1`／`run_s2` 候選全空、`run_m2` 不檢查 None 三處）。

前兩道缺一不可（已拆開實跑驗證）。離線回歸 `test_sorting_smoke.py` 六組＋突變測試確認
每組會因對應退化變紅。

### 仍待處理（兩條未結案，原樣保留）

- **`run_s2()` 沒有採用門檻。** `run_m4()` 有先訂的 `M4_MIN_SPREAD`，`run_s2()` 沒有，
  所以它對分離度 0.01% 的候選照樣宣告「採用」。規格已以「不排序」覆蓋，但報告文案
  仍會誤導讀者。建議補上與 M4 同規格的先訂門檻。**修改前必須先訂門檻值並記錄於 commit，
  不得看著 0.01% 這個已知數字回頭訂**（否則就成了事後挑選，違反鐵律 #8 的精神）。
- **完整重生比對無法進 CI**：`backtest/cache/` 不進 git，CI 無法重跑 `run_sorting.py`
  比對報告是否與腳本同步。目前靠離線結構檢查涵蓋「結論行消失」這類回歸。若要完整涵蓋，
  需在 Actions 排一支帶 `FINMIND_TOKEN` 的週期性 job（抓快取約 50 分鐘），**尚未建置**。

---

## 9. 資料組裝層（2026-07-28 定案；來源數依現值更正）

### 9.1 架構決策

1. **推播時點：台北 22:30–23:00 窗**，接在既有 evening 協調班之後（資料最晚就緒鏈＝
   postmkt daytrade 二段與 aetf2；2026-08-07 起另依賴 pm 摘要 summaryPm）。
2. **來源清單以 `cardSourceUrls` 現值為準**：pm slot 回 **15 個 key＝14 支資料 JSON
   （daysummary／baseline／morning／us／lastweek／aetfLatest／aetfDiff／flowsLatest／totals／
   foreignHistory／flowsDaily／postmkt／mktbal／summaryPm）＋ manifest（渲染產物回讀）**；
   am slot 4 支（daysummary／morning／us／dailyBrief）。原文寫 13 支已過時。
   postmkt.json（>2MB）佔大宗，`runEvening` 的 `getP` 快取同一次喚醒共用。
3. v2-ov-7／v2-ov-14／v2-chain-1 走 `build_daysummary` 補欄，不走推播時呼叫 buildLive
   （該三卡現已裁，欄位管線保留）。
4. VIX（原 v2-global-1 用）：`/cards/data` 走 noVix——活躍卡皆不用 vix，公開端點不打 FinMind。
5. 落後來源**帶資料日標註**（誠實原則的來源徽章慣例），不跳卡、不裝新。
6. Regime 閘門 TAIEX 20 日序列取 flows `totals.json → rows[date].taiex`（偶有 null，
   20MA 計算容 null 跳過）。

### 9.2 上游資料缺口（Phase A）

卡 1/3/4 排序欄的 baseline 補欄（`nh` 旗標、subs_y 的 C/R、a20）與 daysummary chain 聚合，
均為 additive schema 擴充（詳 `src/build_baseline.py`／`src/build_daysummary.py` schema 註解）。
注意：subs_y 的 C/R 是**日線口徑**（`backtest/run_sorting.py` 同款）；KV `flow:last` 的
`c1/c2/ret` 是盤中 10/30 分窗口徑，**不可混用**。

### 9.3 組裝層驗收條件（Phase B，2026-08-16 盤點）

- [x] `buildDailyCards(data)` 純函式：無 fetch、無 KV、無 Date.now（2026-07-29；
      `test/dailycards.mjs` 離線 fixture 全程驗）
- [x] 每張卡可獨立失敗：來源缺→該卡入 skipped 不擋其他卡（2026-07-29；單源缺失測試節）
- [x] 發送層：判空不推、逐卡 `assertCardAllowed` 預過濾、Flex 失敗退純文字（2026-07-29）
- [x] regime 閘門只作用卡 1/卡 2；TAIEX 20MA 容 null（2026-07-29；閘門測試節含 totals 壞檔）
- [x] 每張卡帶資料日標註；落後來源標日期不裝新（2026-07-29 線上驗證）
- [x] KV 去重 `alerted:<date>:cards`（pm）／`alerted:<date>:cards-am`（am），一場只推一次
- [x] 離線 fixture 測試：全卡產出斷言＋單源缺失降級（2026-07-29 起，隨白名單改版更新）
- [x] `worker/test/` 既有測試零回歸（持續性條件；最近全綠＝2026-08-16）
- [ ] fresh-context subagent 驗收（鐵律 #3）——無完成紀錄可佐證，保留未勾
