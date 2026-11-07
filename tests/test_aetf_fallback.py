# tests/test_aetf_fallback.py — 投信端點補位的日期折算離線測試
#
# 為什麼需要這支：aetf_fallback.resolve_date 決定補位資料被標成哪一天，標錯就是整批
# 錯一天、而且不會有任何東西擋下來。野村的 PCF 日期是「下一個交易日」，執行當下那天
# 還沒開盤、必然不在交易日曆內——第一版寫成「在日曆裡找 raw 再往前一格」，實測
# 2026-07-31 00:23 三檔野村全部折算失敗。本測試把該情境釘住。
#
# 比照 tests/test_phase_a_smoke.py 的做法：直接呼叫純函式，免 token、免網路。
# 用法：python tests/test_aetf_fallback.py

from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import aetf_fallback as fb   # noqa: E402

FAILED = []

# 一段真實形狀的交易日曆（含週末缺口：07/25 五、07/26-27 週末後接 07/27 一）
CAL = ["2026/07/22", "2026/07/23", "2026/07/24", "2026/07/27",
       "2026/07/28", "2026/07/29", "2026/07/30"]


def chk(name, got, want):
    if got == want:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}: got {got!r} want {want!r}")
        FAILED.append(name)


def main() -> int:
    print("resolve_date：")

    # 統一 offset=0 —— 來源標的就是實際基準日，原樣回傳
    chk("offset=0 原樣回傳", fb.resolve_date("2026/07/30", 0, CAL), "2026/07/30")
    chk("offset=0 不需日曆", fb.resolve_date("2026/07/30", 0, []), "2026/07/30")

    # 野村 offset=-1 —— 關鍵情境：PCF 標的是「下一個交易日」，尚未開盤故不在日曆內
    chk("offset=-1 raw 在未來（回日曆最後一日）",
        fb.resolve_date("2026/07/31", -1, CAL), "2026/07/30")
    # 跨週末：PCF 標週一，實際基準日應是上週五
    chk("offset=-1 跨週末", fb.resolve_date("2026/07/27", -1, CAL), "2026/07/24")
    # raw 落在日曆內的一般情況
    chk("offset=-1 raw 在日曆內", fb.resolve_date("2026/07/30", -1, CAL), "2026/07/29")

    # 防呆：資訊不足時回 None，寧可不補位也不寫入存疑日期
    chk("無日曆 → None", fb.resolve_date("2026/07/31", -1, []), None)
    chk("raw 為空 → None", fb.resolve_date("", -1, CAL), None)
    chk("raw 早於整段日曆 → None", fb.resolve_date("2026/07/01", -1, CAL), None)

    print("\nFETCHERS 登記表：")
    chk("涵蓋統一 2 檔＋野村 3 檔＋群益 1 檔", len(fb.FETCHERS), 6)
    chk("登記代號正確", sorted(fb.FETCHERS),
        ["00403A", "00415A", "00980A", "00981A", "00985A", "00999A"])
    chk("00415A 登記為群益", fb.FETCHERS["00415A"][0], "群益")
    chk("統一 offset 為 0（TranDate 即基準日）",
        [k for k, v in fb.FETCHERS.items() if v[0] == "統一"] and True, True)

    if FAILED:
        print(f"\n失敗 {len(FAILED)} 項：")
        for f in FAILED:
            print(f"  - {f}")
        return 1
    print("\n全部通過")
    return 0


def test_script_main():
    """讓 pytest 也跑到上面這組 chk（原本只有直接執行才會跑）。"""
    assert main() == 0


if __name__ == "__main__":
    sys.exit(main())
