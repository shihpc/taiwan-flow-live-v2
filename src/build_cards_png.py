# src/build_cards_png.py — LINE 圖卡 PNG 渲染（spec 3C 呈現層改向，2026-07-30）
#
# 架構定位：卡片邏輯唯一來源＝Worker /cards/data（buildDailyCards 經 FX_ACTIVE_CARDS
# 過濾後的 JSON），本腳本**只渲染不算數**。Actions 晚班（cards.yml，台北 22:12）跑本腳本
# → commit data/cards/latest/*.png ＋ manifest.json → pushDailyCards（台北 22:30）抓
# manifest（date==今日才用），有圖的卡改 Flex hero 圖 bubble；缺圖退現行文字 bubble。
#
# 版型（使用者提供參考風格：深藍底＋金色漸層條＋獎牌排行）：
#   排行卡：深藍漸層底、白色粗體標題＋右上資料日、每列＝名次（前三名金/銀/銅圓章）＋
#           代號（小字藍）＋名稱（白粗）＋金色漸層橫條（比例化於該卡最大絕對值）＋
#           右側數值（正紅負綠、千分位）；底部灰字 note＋免責句。
#   看板卡（DASH_IDS：dash-1 三合一看板；舊 ov-1／hdr-1／hdr-2）：同色系 2 欄大數字格。
#   paras 卡（如 v2-ov-5 定調句）：置中大字逐段。
#   以 1040px 寬設計、高依內容動態（排行每列 96px）；**輸出前一律縮到 LINE Flex image
#   的 1024×1024 上限內**（fit_line_limit，兩軸都限，官方三處一致），PNG <1MB。
#
# 字型：Noto Sans TC。找 <repo>/fonts/NotoSansTC-Bold.otf 與 -Regular.otf（不進 git，
# cards.yml 下載＋actions/cache）；缺檔印明確錯誤退出非 0。--font-fallback 僅供無字型
# 環境驗版型（中文會是豆腐字，正式管線不得使用）。
#
# 用法：
#   python src/build_cards_png.py                        # 打 WORKER_BASE /cards/data
#   python src/build_cards_png.py --slot am              # 晨間場：/cards/data?slot=am → data/cards/am
#   python src/build_cards_png.py --offline fixture.json # 本地 JSON（測試用，免網路）
#   WORKER_BASE=https://... 覆蓋 Worker base（預設 taiwan-flow-v2.shihpc.workers.dev）
#   --worker URL 覆蓋 Worker base（優先於 WORKER_BASE，本機驗證用）
#   --out DIR 覆蓋輸出目錄（預設依 slot：pm=data/cards/latest、am=data/cards/am）
#
# AM slot（2026-08-10 晨間管線）：--slot am 時輸出目錄與 RAW_BASE 都改指 data/cards/am/
# ——與晚間 data/cards/latest/ 分目錄，開場清 *.png 時互不誤刪；manifest 語意不變
# （date＝資料日，AM 由 Worker 以晨間源的新鮮度守門後給出）。

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WORKER = "https://taiwan-flow-v2.shihpc.workers.dev"
# slot → 輸出子目錄（pm 沿用 latest 不改名；am 用自己的目錄，清 *.png 時互不誤刪）
SLOT_DIRS = {"pm": "latest", "am": "am"}
RAW_BASE_ROOT = "https://raw.githubusercontent.com/shihpc/taiwan-flow-live-v2/main/data/cards"
RAW_BASE = f"{RAW_BASE_ROOT}/latest"          # pm 預設（向後相容）
OUT_DIR = ROOT / "data" / "cards" / "latest"  # pm 預設（向後相容）
FONT_DIR = ROOT / "fonts"


def raw_base_for(slot: str) -> str:
    return f"{RAW_BASE_ROOT}/{SLOT_DIRS[slot]}"


def out_dir_for(slot: str) -> Path:
    return ROOT / "data" / "cards" / SLOT_DIRS[slot]

W = 1040                      # 固定寬
ROW_H = 96                    # 排行卡每列高
MAX_PNG_BYTES = 1_000_000     # LINE Flex hero 圖保守上限（官方建議 ≤1MB；硬上限 10MB）
# 長文卡走**獨立 Image message**（官方 2020-05 起像素無上限、檔案 10MB；
# https://developers.line.biz/en/news/2020/05/12/messaging-api-update-may-2020/），
# 不受 Flex 的 1024×1024 與 3:1 aspectRatio 限制，故不過 fit_line_limit。
MAX_LONGFORM_BYTES = 9_000_000    # 保守留 1MB 餘裕給 LINE 端
MAX_PREVIEW_BYTES = 1_000_000     # previewImageUrl 官方硬上限 1MB
LONGFORM_COLORS = 64              # palette 量化（實測 1.2MB→0.29MB，PSNR 37dB 近無損）
LINE_IMG_MAX = 1024           # LINE Flex image 官方上限 1024×1024 px（兩軸都限）
DISCLAIMER = "數據僅供參考，不代表投資建議"

# 看板卡（非排行型）：大數字格版型。v2-dash-1＝三合一看板（2026-08-16 取代
# ov-1/hdr-1/hdr-2 三張，舊三張 id 留著無害——builder 保留、隨白名單復活即用）
DASH_IDS = {"v2-ov-1", "flows-hdr-1", "flows-hdr-2", "v2-dash-1"}

# 色票（深藍＋金；正紅負綠沿用全站慣例、亮度調高配深底）
C_BG_TOP = (26, 58, 107)      # #1A3A6B
C_BG_BOT = (15, 35, 71)       # #0F2347
C_TITLE = (255, 255, 255)
C_DATE = (143, 167, 206)      # 右上資料日
C_DIVIDER = (46, 74, 122)
C_CODE = (127, 168, 224)      # 代號小字藍
C_NAME = (255, 255, 255)
C_BAR_L = (247, 217, 126)     # 金色漸層條 左
C_BAR_R = (201, 147, 43)     # 金色漸層條 右
C_BAR_UP_L = (255, 150, 138)  # 買超條 左（紅）
C_BAR_UP_R = (198, 74, 62)    # 買超條 右
C_BAR_DN_L = (114, 226, 168)  # 賣超條 左（綠）
C_BAR_DN_R = (36, 156, 100)   # 賣超條 右
C_UP = (255, 123, 110)        # 正＝紅（台股慣例）
C_DOWN = (61, 214, 140)       # 負＝綠
C_NEUTRAL = (195, 204, 218)
C_NOTE = (133, 147, 168)
C_DISC = (110, 124, 147)
C_CELL = (30, 58, 105)        # 看板格底
C_LABEL = (143, 167, 206)
MEDALS = [(240, 194, 75), (200, 207, 218), (201, 138, 90)]   # 金/銀/銅
C_MEDAL_TXT = (20, 34, 62)
C_RANK = (143, 167, 206)      # 第 4 名起的名次數字

_NUM_RE = re.compile(r"[-+−]?\d[\d,]*\.?\d*")


def parse_value(r: str) -> float | None:
    """從資料列右欄字串抽第一個數值（帶正負），供橫條比例化。抽不到回 None（條長 0）。"""
    m = _NUM_RE.search(str(r or ""))
    if not m:
        return None
    t = m.group(0).replace(",", "").replace("−", "-")   # U+2212 負號正規化
    try:
        return float(t)
    except ValueError:
        return None


def bar_width(value: float | None, max_abs: float, max_w: int) -> int:
    """橫條長度＝max_w × |value|/max_abs；非零值下限 4px（可見）、上限 max_w。"""
    if value is None or max_abs <= 0:
        return 0
    w = abs(value) / max_abs * max_w
    if w <= 0:
        return 0
    return max(4, min(int(round(w)), max_w))


def fmt_thousands(r: str) -> str:
    """右欄數值加千分位（僅整數部位 ≥4 位數時；小數位保留原樣）。"""
    def repl(m: re.Match) -> str:
        t = m.group(0)
        if "," in t:
            return t
        sign = ""
        if t[0] in "+-−":
            sign, t = t[0], t[1:]
        intpart, dot, frac = t.partition(".")
        if len(intpart) < 4:
            return m.group(0)
        return f"{sign}{int(intpart):,}{dot}{frac}"
    return _NUM_RE.sub(repl, str(r or ""))


# ---------------- 字型 ----------------

def load_fonts(font_dir: Path, fallback: bool):
    from PIL import ImageFont
    bold_p = font_dir / "NotoSansTC-Bold.otf"
    reg_p = font_dir / "NotoSansTC-Regular.otf"
    if bold_p.exists() and reg_p.exists():
        mk_b = lambda s: ImageFont.truetype(str(bold_p), s)   # noqa: E731
        mk_r = lambda s: ImageFont.truetype(str(reg_p), s)    # noqa: E731
        return mk_b, mk_r
    if not fallback:
        print(
            "ERROR: 找不到字型檔：\n"
            f"  {bold_p}\n  {reg_p}\n"
            "請下載 Noto Sans TC（cards.yml 會自動下載；本機可從\n"
            "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/TraditionalChinese/\n"
            "取 NotoSansCJKtc-Bold.otf / NotoSansCJKtc-Regular.otf 存為上述檔名），\n"
            "或以 --font-fallback 用預設字型驗版型（中文會變豆腐字，正式管線不得使用）。",
            file=sys.stderr,
        )
        sys.exit(1)
    print("WARN: 使用 Pillow 預設字型（--font-fallback）——中文將顯示為豆腐字", file=sys.stderr)
    mk = lambda s: ImageFont.load_default(size=s)   # noqa: E731
    return mk, mk


# ---------------- 繪圖基元 ----------------

def gradient_bg(h: int):
    from PIL import Image
    col = Image.new("RGB", (1, h))
    px = col.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(int(a + (b - a) * t) for a, b in zip(C_BG_TOP, C_BG_BOT))
    return col.resize((W, h))


def bar_palette(c: str):
    """條色依方向（2026-07-30 使用者定案）：買賣混排時金色單一色會讓
    「賣超最長條卻排在後段」視覺打架，改用漲紅跌綠、中性維持金色。"""
    if c == "up":
        return C_BAR_UP_L, C_BAR_UP_R
    if c == "down":
        return C_BAR_DN_L, C_BAR_DN_R
    return C_BAR_L, C_BAR_R


def gold_bar(draw, x: int, y: int, w: int, h: int, c: str = "neutral"):
    """左→右漸層圓角橫條（逐欄畫線＋圓角遮尾）；配色依 row.c 方向。"""
    if w <= 0:
        return
    cl, cr = bar_palette(c)
    r = h // 2
    for i in range(w):
        t = i / max(1, w - 1)
        c_ = tuple(int(a + (b - a) * t) for a, b in zip(cl, cr))
        # 圓角：頭尾 r 範圍內縮短豎線
        dy = 0
        if i < r:
            dy = r - int((r * r - (r - i) ** 2) ** 0.5)
        elif i >= w - r:
            j = i - (w - r - 1)
            dy = r - int(max(0.0, r * r - j * j) ** 0.5)
        draw.line([(x + i, y + dy), (x + i, y + h - dy)], fill=c_)


def text_w(draw, s: str, font) -> int:
    return int(draw.textlength(str(s), font=font))


def fit_font(draw, s: str, mk, size: int, max_w: int, min_size: int = 18):
    """字太長自動縮小到塞得下（看板大數字用）。"""
    while size > min_size and text_w(draw, s, mk(size)) > max_w:
        size -= 2
    return mk(size)


def wrap_text(draw, s: str, font, max_w: int) -> list[str]:
    """逐字換行（中文為主，無詞界）。"""
    lines, cur = [], ""
    for ch in str(s):
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        if text_w(draw, cur + ch, font) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines or [""]


def value_color(c: str):
    return {"up": C_UP, "down": C_DOWN}.get(c, C_NEUTRAL)


# ---------------- 三種版型 ----------------
PAD = 48
HEADER_H = 148


def draw_header(draw, card, F_B, F_R):
    draw.text((PAD, 44), str(card.get("title", "")), font=F_B(48), fill=C_TITLE)
    sub = str(card.get("sub", "") or "")
    if sub:
        f = F_R(26)
        draw.text((W - PAD - text_w(draw, sub, f), 62), sub, font=f, fill=C_DATE)
    draw.line([(PAD, HEADER_H - 20), (W - PAD, HEADER_H - 20)], fill=C_DIVIDER, width=2)


def footer_lines(draw, card, F_R):
    f = F_R(24)
    lines = []
    for t in [card.get("note"), card.get("foot")]:
        if t:
            lines += wrap_text(draw, str(t), f, W - 2 * PAD)
    return lines


def draw_footer(draw, y: int, lines, F_R, disc: str | None = None) -> int:
    """disc＝該卡專屬免責句（長文卡用）；None 走全站通用 DISCLAIMER。"""
    f = F_R(24)
    draw.line([(PAD, y), (W - PAD, y)], fill=C_DIVIDER, width=2)
    y += 18
    for ln in lines:
        draw.text((PAD, y), ln, font=f, fill=C_NOTE)
        y += 34
    for ln in wrap_text(draw, f"※ {disc or DISCLAIMER}", f, W - 2 * PAD):
        draw.text((PAD, y + 4), ln, font=f, fill=C_DISC)
        y += 34
    return y + 18


def render_ranking(card, F_B, F_R):
    """排行卡：名次圓章＋代號＋名稱＋金色比例橫條＋右側數值。

    rows 之後若有 paras 一併排出（左對齊小字）：晨間三卡（news-morning-2/3/4）是
    rows＋paras 並用的卡，掛 hero 圖後 Flex body 精簡、paras 只能靠圖呈現——不畫等於
    內容變薄（2026-08-10 AM slot 補上）。晚間 11 張活躍卡皆無 rows＋paras 並用
    （paras 卡走 render_paras），此段對既有晚間輸出零影響。"""
    from PIL import Image, ImageDraw
    rows = card.get("rows") or []
    probe = ImageDraw.Draw(Image.new("RGB", (W, 8)))
    flines = footer_lines(probe, card, F_R)
    pf = F_R(30)
    pblocks = [wrap_text(probe, str(p), pf, W - 2 * PAD) for p in (card.get("paras") or [])]
    p_h = (16 + sum(len(b) for b in pblocks) * 44 + len(pblocks) * 12) if pblocks else 0
    h = HEADER_H + len(rows) * ROW_H + p_h + 24 + (18 + len(flines) * 34 + 34 + 18)
    img = gradient_bg(h)
    draw = ImageDraw.Draw(img)
    draw_header(draw, card, F_B, F_R)

    vals = [parse_value(r.get("r")) for r in rows]
    max_abs = max((abs(v) for v in vals if v is not None), default=0.0)
    X_BADGE, X_TEXT = PAD + 26, PAD + 76
    X_BAR, BAR_MAX_W = 420, 380
    X_VAL = W - PAD
    y = HEADER_H + 4
    for i, row in enumerate(rows):
        cy = y + ROW_H // 2
        # 名次：前三名金/銀/銅圓章、其後數字
        if i < 3:
            r_ = 26
            draw.ellipse([X_BADGE - r_, cy - r_, X_BADGE + r_, cy + r_], fill=MEDALS[i])
            f = F_B(30)
            s = str(i + 1)
            draw.text((X_BADGE - text_w(draw, s, f) / 2, cy - 21), s, font=f, fill=C_MEDAL_TXT)
        else:
            f = F_B(30)
            s = str(i + 1)
            draw.text((X_BADGE - text_w(draw, s, f) / 2, cy - 21), s, font=f, fill=C_RANK)
        # 代號（小字藍）＋名稱（白粗）；無代號時名稱置中列高
        code, name = row.get("l"), str(row.get("m", ""))
        name_max_w = X_BAR - X_TEXT - 16
        if code is not None:
            draw.text((X_TEXT, cy - 34), str(code), font=F_R(22), fill=C_CODE)
            nf = fit_font(draw, name, F_B, 32, name_max_w)
            draw.text((X_TEXT, cy - 8), name, font=nf, fill=C_NAME)
        else:
            nf = fit_font(draw, name, F_B, 32, name_max_w)
            draw.text((X_TEXT, cy - 20), name, font=nf, fill=C_NAME)
        # 金色漸層橫條：長度比例化於該卡最大絕對值
        gold_bar(draw, X_BAR, cy - 9, bar_width(vals[i], max_abs, BAR_MAX_W), 18,
                 row.get("c") or "neutral")
        # 右側數值：正紅負綠、千分位
        vs = fmt_thousands(row.get("r", ""))
        vf = fit_font(draw, vs, F_B, 32, 190)
        r2s = row.get("r2")
        draw.text((X_VAL - text_w(draw, vs, vf), cy - (30 if r2s else 20)), vs,
                  font=vf, fill=value_color(row.get("c")))
        if r2s:   # 張數次要值：數值下方小字灰（金額為主、張數佐證量體）
            f2 = F_R(22)
            draw.text((X_VAL - text_w(draw, str(r2s), f2), cy + 8), str(r2s), font=f2, fill=C_NOTE)
        if i < len(rows) - 1:
            draw.line([(PAD, y + ROW_H), (W - PAD, y + ROW_H)], fill=C_DIVIDER, width=1)
        y += ROW_H
    if pblocks:   # rows 後的文字段（晨間卡 rows＋paras 並用；晚間活躍卡無此情形）
        y += 16
        for b in pblocks:
            for ln in b:
                draw.text((PAD, y), ln, font=pf, fill=C_NEUTRAL)
                y += 44
            y += 12
    draw_footer(draw, y + 20, flines, F_R)
    return img


def render_dashboard(card, F_B, F_R):
    """看板卡（DASH_IDS：dash-1 三合一看板；舊 ov-1／hdr-1／hdr-2）：2 欄大數字格。"""
    from PIL import Image, ImageDraw
    rows = card.get("rows") or []
    probe = ImageDraw.Draw(Image.new("RGB", (W, 8)))
    flines = footer_lines(probe, card, F_R)
    CELL_H, GAP = 190, 20
    ncols = 1 if len(rows) == 1 else 2
    nrows = (len(rows) + ncols - 1) // ncols
    h = HEADER_H + nrows * (CELL_H + GAP) + 16 + (18 + len(flines) * 34 + 34 + 18)
    img = gradient_bg(h)
    draw = ImageDraw.Draw(img)
    draw_header(draw, card, F_B, F_R)
    cell_w = (W - 2 * PAD - (ncols - 1) * GAP) // ncols
    for i, row in enumerate(rows):
        cx = PAD + (i % ncols) * (cell_w + GAP)
        cyt = HEADER_H + 8 + (i // ncols) * (CELL_H + GAP)
        draw.rounded_rectangle([cx, cyt, cx + cell_w, cyt + CELL_H], radius=18,
                               fill=C_CELL, outline=C_DIVIDER, width=2)
        label = str(row.get("m", ""))
        lf = fit_font(draw, label, F_R, 28, cell_w - 48)
        draw.text((cx + 28, cyt + 26), label, font=lf, fill=C_LABEL)
        vs = fmt_thousands(row.get("r", ""))
        vf = fit_font(draw, vs, F_B, 52, cell_w - 48)
        draw.text((cx + 28, cyt + CELL_H - 92), vs, font=vf, fill=value_color(row.get("c")))
    draw_footer(draw, HEADER_H + 8 + nrows * (CELL_H + GAP) + 8, flines, F_R)
    return img


def render_paras(card, F_B, F_R):
    """paras 卡（如 v2-ov-5 定調句；pm-aetf-5 2026-08-16 改 rows 後不再走此型）：置中大字逐段。"""
    from PIL import Image, ImageDraw
    paras = [str(p) for p in (card.get("paras") or [])]
    probe = ImageDraw.Draw(Image.new("RGB", (W, 8)))
    f = F_B(34)
    blocks = [wrap_text(probe, p, f, W - 2 * PAD) for p in paras]
    nlines = sum(len(b) for b in blocks)
    flines = footer_lines(probe, card, F_R)
    h = HEADER_H + 24 + nlines * 52 + len(blocks) * 20 + 24 + (18 + len(flines) * 34 + 34 + 18)
    img = gradient_bg(h)
    draw = ImageDraw.Draw(img)
    draw_header(draw, card, F_B, F_R)
    y = HEADER_H + 24
    for b in blocks:
        for ln in b:
            draw.text(((W - text_w(draw, ln, f)) / 2, y), ln, font=f, fill=C_NAME)
            y += 52
        y += 20
    draw_footer(draw, y + 4, flines, F_R)
    return img


# 長文版型：內文左對齊 Regular（render_paras 是 34px 粗體置中，為一兩段短句設計，
# 2000 字那樣排不可讀）；`##` 段標粗體拉層次。畫布高度隨內容長，不縮放。
LF_BODY, LF_HEAD, LF_LH, LF_GAP = 34, 40, 52, 22
# markdown 標記清理（圖上不該出現 ** 、* 、--- 這些原始標記）
_MD_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
# 斜體只吃**成對**的單星號：台股代號後綴會用單一 `*`（如「2327 國巨*」＝其他交易條件註記），
# 貪吃會把真實內容吃掉。實測 2026-08-06 摘要，該行正確保留。
_MD_ITALIC_RE = re.compile(r"(?<!\*)\*([^*]+?)\*(?!\*)")
_MD_RULE_RE = re.compile(r"^\s*([-*_])\s*(\1\s*){2,}$")


def render_longform(card, F_B, F_R):
    """長文卡（盤後分析摘要）：整篇 markdown 逐行排版，供 LINE Image message 用。"""
    from PIL import Image, ImageDraw
    probe = ImageDraw.Draw(Image.new("RGB", (W, 8)))
    f_body, f_head = F_R(LF_BODY), F_B(LF_HEAD)
    maxw = W - 2 * PAD

    laid = []                                   # (font|None, line, is_head)；None＝段距
    for raw in [str(x) for x in (card.get("paras") or [])]:
        line = raw.strip()
        if not line or _MD_RULE_RE.match(line):     # 空行與 --- 分隔線不入版
            continue
        is_head = line.startswith("#")
        if is_head:
            line = line.lstrip("#").strip()
        # 標記一律去除（不分標題/內文）：標題行原本漏掉，導致 `**4/6**`、`*斜體*`
        # 直接印在圖上（2026-08-07 驗收發現，真實資料 78 行中 11 行受影響）
        line = _MD_BOLD_RE.sub(r"\1", line)
        line = _MD_ITALIC_RE.sub(r"\1", line)
        if not line:
            continue
        f = f_head if is_head else f_body
        for ln in wrap_text(probe, line, f, maxw):
            laid.append((f, ln, is_head))
        laid.append((None, "", False))

    flines = footer_lines(probe, card, F_R)
    disc = card.get("disclaimer") or DISCLAIMER
    dlines = wrap_text(probe, f"※ {disc}", F_R(24), W - 2 * PAD)
    h = (HEADER_H + 24 + sum(LF_LH if f is not None else LF_GAP for f, _, _ in laid)
         + 24 + (18 + (len(flines) + len(dlines)) * 34 + 18))
    img = gradient_bg(h)
    draw = ImageDraw.Draw(img)
    draw_header(draw, card, F_B, F_R)
    y = HEADER_H + 24
    for f, ln, is_head in laid:
        if f is None:
            y += LF_GAP
            continue
        draw.text((PAD, y), ln, font=f, fill=C_TITLE if is_head else C_NAME)
        y += LF_LH
    draw_footer(draw, y + 4, flines, F_R, disc)
    return img


def render_card(card, F_B, F_R):
    if card.get("kind") == "longform":
        return render_longform(card, F_B, F_R)
    rows, paras = card.get("rows") or [], card.get("paras") or []
    if rows and card.get("id") in DASH_IDS:
        return render_dashboard(card, F_B, F_R)
    if rows:
        return render_ranking(card, F_B, F_R)
    if paras:
        return render_paras(card, F_B, F_R)
    return None


# ---------------- 主流程 ----------------

# Cloudflare 的 bot protection 會依 User-Agent 簽章擋掉 urllib 預設的 `Python-urllib/3.x`
# ——回 HTTP 403 ＋ body `error code: 1010`（2026-07-31 定案：cards.yml #1/#2 兩次排程
# 全掛在此，curl 與空 UA 都放行，只有 Python-urllib 被擋）。務必帶明確 UA。
_UA = "taiwan-flow-live-v2-cards/1.0 (+https://github.com/shihpc/taiwan-flow-live-v2)"


def fetch_cards(worker_base: str, slot: str = "pm") -> dict:
    url = f"{worker_base.rstrip('/')}/cards/data"
    if slot != "pm":
        url += f"?slot={slot}"   # Worker 端 am/pm 各有 cache key（slot 併進 cacheKey path）
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=60) as r:   # noqa: S310（固定 https base）
        return json.loads(r.read().decode("utf-8"))


_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def fit_line_limit(img):
    """縮到 LINE Flex image 的 1024×1024 上限內（等比、LANCZOS）。

    官方三處一致（reference #f-image、OpenAPI FlexImage.url、Flex Simulator 教學）：
    `Max image size: 1024 x 1024 pixels`——**兩軸都限**，非只限寬。
    超標後果官方未載明（縮放／裁切／不顯示皆有可能），故一律縮到合規再送。

    設計採「輸出前統一縮放」而非調小版型常數：卡的列數隨當日訊號數變動，
    改常數只能保證某個列數合規，縮放守門則任何內容都擋得住。
    以 1040 寬設計、縮到 ≤1024 後在手機上仍遠高於 bubble 實際顯示寬。
    """
    w, h = img.width, img.height
    if w <= LINE_IMG_MAX and h <= LINE_IMG_MAX:
        return img
    from PIL import Image
    s = min(LINE_IMG_MAX / w, LINE_IMG_MAX / h)
    return img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)


def warn_gate_skip(date_repr: str) -> None:
    """守門攔截（資料不新鮮）＝預期內跳過，非故障。

    印 ::warning::（Actions 顯示黃色 annotation）＋寫 step summary（環境變數
    GITHUB_STEP_SUMMARY 存在時），呼叫端以 exit 0 收場——run 綠燈帶警告。
    真故障（例外、網路錯、渲染錯）維持非零 exit：兩者在 run 顏色上必須可區分
    （2026-08-11 實例：守門攔截也亮紅，與真故障混在一起無法分辨）。
    """
    msg = f"/cards/data 未回可信資料日（date={date_repr}）——守門攔截，拒渲染，該場退純文字"
    print(f"::warning::{msg}")
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write(f"### cards 渲染守門攔截\n\n{msg}\n")


def build_all(data: dict, out_dir: Path, F_B, F_R, raw_base: str = RAW_BASE) -> dict | None:
    from PIL import Image
    # date ＝ Worker /cards/data 回的**資料日**（baseline.date），非渲染當日。
    # 缺或格式不對就拒渲染：manifest 沒有可信日期時，寧可當晚退文字版，
    # 也不能產出「日期不明」的圖讓 attachCardImages 有機會誤放行。
    # 回 None（守門攔截）而非 SystemExit：這是預期內的資料不新鮮，main 以 exit 0 收場；
    # return 在 mkdir／清場之前——攔截時既有 PNG 與 manifest 一律不動，commit step 自然 no-op。
    date = str(data.get("date") or "")
    if not _DATE_RE.match(date):
        warn_gate_skip(repr(date))
        return None
    out_dir.mkdir(parents=True, exist_ok=True)
    for p in out_dir.glob("*.png"):   # 清掉上一日殘圖（manifest 是唯一權威，殘檔只會誤導）
        p.unlink()
    images, ratios, previews = {}, {}, {}
    for card in data.get("cards") or []:
        cid = str(card.get("id", ""))
        if not _ID_RE.match(cid):
            print(f"WARN: 卡 id 不合法（跳過）：{cid!r}", file=sys.stderr)
            continue
        img = render_card(card, F_B, F_R)
        if img is None:
            print(f"WARN: 卡 {cid} 無 rows/paras 可渲染（跳過）", file=sys.stderr)
            continue
        longform = card.get("kind") == "longform"
        path = out_dir / f"{cid}.png"
        if longform:
            # Image message：不縮尺寸（那正是走這條路的理由），改用 palette 量化壓檔案
            img.convert("P", palette=Image.ADAPTIVE, colors=LONGFORM_COLORS).save(
                path, format="PNG", optimize=True)
        else:
            img = fit_line_limit(img)
            img.save(path, format="PNG", optimize=True)
        size = path.stat().st_size
        # 超標「跳過本卡」而非中止整批：2026-08-07 前是 raise SystemExit，單卡超標會讓
        # render step 失敗 → commit step 不執行 → manifest 停在昨日 → 當晚**全部**卡退純文字。
        limit = MAX_LONGFORM_BYTES if longform else MAX_PNG_BYTES
        if size >= limit:
            print(f"WARN: 卡 {cid} {size}B ≥ 上限 {limit}B（跳過本卡，不影響其他卡）",
                  file=sys.stderr)
            path.unlink(missing_ok=True)
            continue
        if longform:
            # 聊天室先顯示的預覽：上緣 crop 成正方（開頭清晰可讀），點開才看全圖。
            # 整張縮小反而糊；官方對超長直圖在 bubble 內如何裁切無明文，故自己控。
            pv = out_dir / f"{cid}-preview.png"
            img.crop((0, 0, W, min(W, img.height))).convert(
                "P", palette=Image.ADAPTIVE, colors=LONGFORM_COLORS).save(
                pv, format="PNG", optimize=True)
            pv_size = pv.stat().st_size
            if pv_size >= MAX_PREVIEW_BYTES:
                print(f"WARN: 卡 {cid} 預覽 {pv_size}B ≥ 1MB（跳過長文卡）", file=sys.stderr)
                path.unlink(missing_ok=True)
                pv.unlink(missing_ok=True)
                continue
            previews[cid] = f"{raw_base}/{cid}-preview.png?d={date}"
            print(f"  {cid}-preview.png  {min(W, img.height)}x{min(W, img.height)}  {pv_size}B")
        # URL 帶日期 query 破 LINE 端快取（同一路徑隔日換圖，LINE CDN 會沿用舊圖）
        images[cid] = f"{raw_base}/{cid}.png?d={date}"
        ratios[cid] = f"{img.width}:{img.height}"
        print(f"  {cid}.png  {img.width}x{img.height}  {size}B")
    tz8 = timezone(timedelta(hours=8))
    manifest = {"date": date,
                "generated_at": datetime.now(tz8).isoformat(timespec="seconds"),
                "images": images, "ratios": ratios, "previews": previews}
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description="LINE 圖卡 PNG 渲染（/cards/data → data/cards/<slot>）")
    ap.add_argument("--slot", choices=sorted(SLOT_DIRS), default="pm",
                    help="場次：pm=盤後（data/cards/latest）、am=晨間（data/cards/am）")
    ap.add_argument("--offline", metavar="FIXTURE", help="本地 JSON 取代 /cards/data（測試用）")
    ap.add_argument("--worker", help="Worker base URL（優先於 WORKER_BASE 環境變數；本機驗證用）")
    ap.add_argument("--out", help="輸出目錄（預設依 slot：pm=data/cards/latest、am=data/cards/am）")
    ap.add_argument("--font-dir", default=str(FONT_DIR), help="字型目錄（預設 <repo>/fonts）")
    ap.add_argument("--font-fallback", action="store_true",
                    help="缺字型時用預設字型驗版型（中文豆腐字；正式管線不得使用）")
    args = ap.parse_args(argv)

    F_B, F_R = load_fonts(Path(args.font_dir), args.font_fallback)
    if args.offline:
        data = json.loads(Path(args.offline).read_text(encoding="utf-8"))
    else:
        base = args.worker or os.environ.get("WORKER_BASE", DEFAULT_WORKER)
        data = fetch_cards(base, args.slot)
    if not isinstance(data, dict) or "cards" not in data:
        raise SystemExit(f"ERROR: /cards/data 回應非預期：{str(data)[:200]}")
    out_dir = Path(args.out) if args.out else out_dir_for(args.slot)
    manifest = build_all(data, out_dir, F_B, F_R, raw_base=raw_base_for(args.slot))
    if manifest is None:
        # 守門攔截（build_all 已印 ::warning:: ＋ step summary）→ exit 0：
        # run 綠燈帶警告，與真故障（非零 exit）區分；am/pm 兩 slot 行為一致
        print(f"守門攔截：本場（slot={args.slot}）不渲染，既有產物不動")
        return
    print(f"完成：{len(manifest['images'])} 張 → {out_dir}（slot={args.slot} date={manifest['date']}）")


if __name__ == "__main__":
    main()
