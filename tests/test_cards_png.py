# tests/test_cards_png.py — LINE 圖卡 PNG 渲染（src/build_cards_png.py）離線測試
#
# 免 token、免網路：吃 tests/fixtures/cards_fixture.json（--offline 同款資料）渲染到
# 暫存目錄，驗——
#   1. 純函式：parse_value（抽數值供橫條比例化）／bar_width（最大值滿條、比例化、
#      非零下限）／fmt_thousands（千分位）
#   2. 端對端：每張卡產出 PNG、兩軸 ≤1024（LINE 上限）、檔案 <1MB；manifest 的 date／raw URL（帶 ?d=
#      破快取 query）／ratios 與實際圖檔一致
#   3. 版型分派：看板卡（DASH_IDS）／排行卡／paras 卡都走得通（fixture 三型都有）
#
# 字型：優先用 <repo>/fonts/NotoSansTC-*.otf（cards.yml 同款）；缺檔時退 --font-fallback
# （版型邏輯照驗，中文為豆腐字）。
#
# 用法：python tests/test_cards_png.py

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import build_cards_png as bc   # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "cards_fixture.json"
FAILED = []


def check(label, cond):
    ok = bool(cond)
    print(f"{'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        FAILED.append(label)


# ---------- 1. 純函式 ----------

def test_parse_value():
    check("parse_value 正值含單位", bc.parse_value("+58.1億") == 58.1)
    check("parse_value 負值", bc.parse_value("-152.6億") == -152.6)
    check("parse_value U+2212 負號", bc.parse_value("−2.1億") == -2.1)
    check("parse_value 千分位", bc.parse_value("-65,039口") == -65039.0)
    check("parse_value 前綴字（R +3.4%）", bc.parse_value("R +3.4%") == 3.4)
    check("parse_value 抽不到 → None", bc.parse_value("R —") is None)
    check("parse_value 空值 → None", bc.parse_value("") is None)


def test_bar_width():
    check("最大值滿條", bc.bar_width(-152.6, 152.6, 380) == 380)
    check("半值半條", bc.bar_width(76.3, 152.6, 380) == 190)
    check("比例化用絕對值（負值同長）",
          bc.bar_width(-76.3, 152.6, 380) == bc.bar_width(76.3, 152.6, 380))
    check("None → 0", bc.bar_width(None, 152.6, 380) == 0)
    check("max_abs=0 → 0", bc.bar_width(5.0, 0.0, 380) == 0)
    check("非零小值 → 下限 4px", bc.bar_width(0.01, 1000.0, 380) == 4)
    check("零值 → 0（無條）", bc.bar_width(0.0, 100.0, 380) == 0)


def test_fmt_thousands():
    check("千分位：-65039口 → -65,039口", bc.fmt_thousands("-65039口") == "-65,039口")
    check("千分位：<4 位不動", bc.fmt_thousands("+58.1億") == "+58.1億")
    check("千分位：小數位不分組", bc.fmt_thousands("12345.6789") == "12,345.6789")
    check("千分位：已有逗號不重複處理", bc.fmt_thousands("-65,039口") == "-65,039口")


# ---------- 2. 端對端渲染（fixture → PNG + manifest）----------

def test_render_end_to_end():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    ids = [c["id"] for c in data["cards"]]
    have_fonts = (ROOT / "fonts" / "NotoSansTC-Bold.otf").exists() \
        and (ROOT / "fonts" / "NotoSansTC-Regular.otf").exists()
    if not have_fonts:
        print("WARN: 無 fonts/NotoSansTC-*.otf，改用 --font-fallback（中文豆腐字，版型照驗）")
    F_B, F_R = bc.load_fonts(ROOT / "fonts", fallback=not have_fonts)

    with tempfile.TemporaryDirectory() as td:
        out = Path(td)
        # 先放一張假殘圖驗清場（昨日殘檔不得留存誤導）
        (out.mkdir(exist_ok=True), (out / "stale-old.png").write_bytes(b"x"))
        manifest = bc.build_all(data, out, F_B, F_R)

        check("殘圖已清（stale-old.png 不在）", not (out / "stale-old.png").exists())
        check("每張卡都有 PNG", all((out / f"{i}.png").exists() for i in ids))
        check("manifest.date = fixture date", manifest["date"] == data["date"])
        check("manifest.images 覆蓋全部卡", sorted(manifest["images"]) == sorted(ids))

        from PIL import Image
        for cid in ids:
            p = out / f"{cid}.png"
            img = Image.open(p)
            # LINE Flex image 官方上限 1024×1024（兩軸都限）——縮放守門後必須合規
            check(f"{cid}: 寬 ≤1024（實 {img.width}）", img.width <= bc.LINE_IMG_MAX)
            check(f"{cid}: 高 ≤1024（實 {img.height}）", img.height <= bc.LINE_IMG_MAX)
            check(f"{cid}: 尺寸合理（{img.width}x{img.height}）",
                  img.width == bc.LINE_IMG_MAX or img.height == bc.LINE_IMG_MAX
                  or img.width == bc.W)
            check(f"{cid}: 高為正且動態（>300）", img.height > 300)
            check(f"{cid}: bytes < 1MB", p.stat().st_size < bc.MAX_PNG_BYTES)
            check(f"{cid}: manifest ratio 與圖檔一致",
                  manifest["ratios"][cid] == f"{img.width}:{img.height}")
            check(f"{cid}: URL 帶 ?d= 破快取且指向 raw latest",
                  manifest["images"][cid]
                  == f"{bc.RAW_BASE}/{cid}.png?d={data['date']}")
        # 版型分派：排行卡高度隨列數走。落檔會經 fit_line_limit 等比縮放，
        # 逐列高度的算術只在**縮放前**精確成立，故拆成兩條分開驗。
        # （2026-08-16 白名單裁剪後 sig-dual-buy 不在 fixture，改用同為排行型且
        # 仍在白名單的 flows-trust-1（5 列）對照 flows-foreign-1（10 列））
        card_f = next(c for c in data["cards"] if c["id"] == "flows-foreign-1")
        card_t = next(c for c in data["cards"] if c["id"] == "flows-trust-1")
        raw_f = bc.render_card(card_f, F_B, F_R).height
        raw_t = bc.render_card(card_t, F_B, F_R).height
        check("（縮放前）排行卡高度隨列數動態：10 列較 5 列高 ≥4 個列高",
              raw_f - raw_t >= 4 * bc.ROW_H)
        h_foreign = Image.open(out / "flows-foreign-1.png").height
        h_trust = Image.open(out / "flows-trust-1.png").height
        check(f"（落檔後）列多者仍較高（{h_foreign} > {h_trust}）", h_foreign > h_trust)
        mf = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        check("manifest.json 落地且含 generated_at（+08:00）",
              mf["images"] == manifest["images"] and "+08:00" in mf["generated_at"])


def test_id_guard():
    """id 不合法（路徑穿越等）不落檔。"""
    F_B, F_R = bc.load_fonts(ROOT / "fonts",
                             fallback=not (ROOT / "fonts" / "NotoSansTC-Bold.otf").exists())
    bad = {"date": "2026-07-28", "cards": [
        {"id": "../evil", "title": "x", "rows": [{"m": "a", "r": "+1.0億", "c": "up"}]}]}
    with tempfile.TemporaryDirectory() as td:
        manifest = bc.build_all(bad, Path(td), F_B, F_R)
        check("不合法 id 不渲染不進 manifest", manifest["images"] == {}
              and not list(Path(td).glob("*.png")))


def test_freshness_gate():
    """守門攔截（date 缺/不新鮮）＝成功＋警告：回 None、不動既有產物、exit 0；
    真故障（回應非預期）仍為非零 exit。"""
    import os

    F_B, F_R = bc.load_fonts(ROOT / "fonts",
                             fallback=not (ROOT / "fonts" / "NotoSansTC-Bold.otf").exists())
    stale = {"date": None, "cards": [
        {"id": "x1", "title": "x", "rows": [{"m": "a", "r": "+1.0億", "c": "up"}]}]}
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "cards"
        out.mkdir()
        keep = out / "keep-old.png"
        keep.write_bytes(b"x")
        summary = Path(td) / "step_summary.md"
        os.environ["GITHUB_STEP_SUMMARY"] = str(summary)
        try:
            manifest = bc.build_all(stale, out, F_B, F_R)
        finally:
            del os.environ["GITHUB_STEP_SUMMARY"]
        check("守門攔截：build_all 回 None（不 raise）", manifest is None)
        check("守門攔截：既有產物不動（舊 PNG 仍在、無 manifest）",
              keep.exists() and not (out / "manifest.json").exists())
        check("守門攔截：step summary 有寫入攔截說明",
              summary.exists() and "守門攔截" in summary.read_text(encoding="utf-8"))

        # main 端對端：--offline 餵 date 空 payload → 正常 return（exit 0），兩 slot 一致
        fx = Path(td) / "stale_fixture.json"
        fx.write_text(json.dumps(stale), encoding="utf-8")
        for slot in ("pm", "am"):
            code = None
            try:
                bc.main(["--offline", str(fx), "--slot", slot,
                         "--out", str(out), "--font-fallback"])
                code = 0
            except SystemExit as e:
                code = e.code
            check(f"守門攔截：main（slot={slot}）以 exit 0 收場", code in (0, None))

        # 真故障對照組：回應非預期（無 cards 鍵）→ 仍是 SystemExit 非零
        # （SystemExit 帶訊息字串時實際 exit code 為 1）
        bad = Path(td) / "bad_fixture.json"
        bad.write_text(json.dumps({"whatever": 1}), encoding="utf-8")
        nonzero = False
        try:
            bc.main(["--offline", str(bad), "--slot", "pm",
                     "--out", str(out), "--font-fallback"])
        except SystemExit as e:
            nonzero = e.code not in (0, None)
        check("真故障：回應非預期仍以非零 exit 收場", nonzero)


if __name__ == "__main__":
    test_parse_value()
    test_bar_width()
    test_fmt_thousands()
    test_render_end_to_end()
    test_id_guard()
    test_freshness_gate()
    print()
    if FAILED:
        print(f"FAIL：{len(FAILED)} 項未過")
        sys.exit(1)
    print("PASS：全部通過")
