#!/usr/bin/env python3
"""noop_guard.py — 單體 builder 班的「只有時間戳變動就不 commit」守門（2026-09-06）。

背景（PROJECT_SUMMARY.md「快速接手」待改進 ②）：daysummary／aetf／intraday 等單體班由 Worker
準點主發、GH cron 延遲後再冪等重跑一次，第二次跑內容完全相同、只有頂層 `generated_at` 被
覆寫成較晚時點 → 必有 diff → 必 commit，產生多餘 commit＋產物時間戳失真。

做法：比對 **staged**（index）與 **HEAD** 的每個 `data/**/*.json`，只忽略**頂層**的時間戳鍵
（IGNORE_KEYS；實查各產出檔頂層時間戳鍵只有 `generated_at`，`built_at` 為前瞻保留），
其餘任何差異（含巢狀物件裡同名鍵）都算真變化。非 JSON 檔（PNG 等）、新增檔、刪除檔、
JSON 解析失敗 → 一律算真變化（寧可多 commit，不可漏 commit）。

用法（workflow 的 commit 步驟，放在 `git diff --cached --quiet` 之後）：
    rc=0; python tools/noop_guard.py || rc=$?
    if [ "$rc" = "3" ]; then echo "只有時間戳變動 → 略過 commit"; git reset -q; exit 0
    elif [ "$rc" != "0" ]; then exit "$rc"; fi
exit code：0＝有實質變動（照常 commit）；3＝全部 staged 檔都只有時間戳變動（noop）；
守門自身出錯（git 不可用等）→ 印 ::warning 後回 0（fail-open：守門壞了不該擋資料落地）。
無第三方依賴（只用標準函式庫＋git CLI）。
"""
from __future__ import annotations

import json
import subprocess
import sys

IGNORE_KEYS = frozenset({"generated_at", "built_at"})
EXIT_CHANGE = 0
EXIT_NOOP = 3


def strip_top(obj, ignore=IGNORE_KEYS):
    """只剝**頂層** dict 的時間戳鍵；非 dict（list／純量）原樣回傳。"""
    if isinstance(obj, dict):
        return {k: v for k, v in obj.items() if k not in ignore}
    return obj


def json_same_except_ts(old_text: str, new_text: str, ignore=IGNORE_KEYS) -> bool:
    """兩段 JSON 文字在忽略頂層時間戳鍵後是否相等；任一段解析失敗 → False（算真變化）。"""
    try:
        a = json.loads(old_text)
        b = json.loads(new_text)
    except (ValueError, TypeError):
        return False
    return strip_top(a, ignore) == strip_top(b, ignore)


def classify(entries, read_head, read_staged, ignore=IGNORE_KEYS):
    """純函式：entries＝[(status, path)]（git name-status：A/M/D/R…），
    read_head(path)／read_staged(path) 回文字或 None。
    回 (has_real_change: bool, report: list[str])。"""
    real = False
    report = []
    if not entries:
        return False, ["staged 無檔案"]
    for status, path in entries:
        st = (status or "")[:1]
        if st != "M":
            real = True
            report.append(f"{path}: 狀態 {status} → 真變化")
            continue
        if not path.endswith(".json"):
            real = True
            report.append(f"{path}: 非 JSON → 真變化")
            continue
        old = read_head(path)
        new = read_staged(path)
        if old is None or new is None:
            real = True
            report.append(f"{path}: HEAD 或 index 讀不到 → 真變化")
            continue
        if json_same_except_ts(old, new, ignore):
            report.append(f"{path}: 只有頂層時間戳變動（{'/'.join(sorted(ignore))}）")
        else:
            real = True
            report.append(f"{path}: 內容有異 → 真變化")
    return real, report


def _git(*args) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True,
                          encoding="utf-8").stdout


def _read_head(path):
    try:
        return _git("show", f"HEAD:{path}")
    except subprocess.CalledProcessError:
        return None


def _read_staged(path):
    try:
        return _git("show", f":{path}")
    except subprocess.CalledProcessError:
        return None


def staged_entries():
    out = _git("diff", "--cached", "--name-status")
    entries = []
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0]
        path = parts[-1]           # rename（R100\told\tnew）取新路徑
        entries.append((status, path))
    return entries


def main(argv=None) -> int:
    try:
        entries = staged_entries()
        real, report = classify(entries, _read_head, _read_staged)
    except Exception as e:  # noqa: BLE001 — fail-open：守門壞了不擋資料
        print(f"::warning::noop_guard 自身失敗（{e!r}），視為有實質變動、照常 commit")
        return EXIT_CHANGE
    for line in report:
        print(f"noop_guard: {line}")
    if real:
        print("noop_guard: 有實質變動 → 照常 commit")
        return EXIT_CHANGE
    print("noop_guard: 全部 staged 檔只有頂層時間戳變動 → noop（略過 commit）")
    return EXIT_NOOP


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
