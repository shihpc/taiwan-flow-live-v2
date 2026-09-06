# tests/test_noop_guard.py — tools/noop_guard.py 守門的離線測試（免 token、免網路）
#
# 兩層：①純函式 classify／json_same_except_ts（不碰 git）②臨時 git repo 端到端跑 main()
# 驗 exit code（0＝有實質變動、3＝只有時間戳）。可 `python tests/test_noop_guard.py` 直跑，
# 也可 `python -m pytest tests/test_noop_guard.py -q`。
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import noop_guard as ng  # noqa: E402

FAILED = []


def check(label, cond):
    ok = bool(cond)
    print(f"{'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        FAILED.append(label)


def _j(**kw):
    return json.dumps(kw, ensure_ascii=False)


def test_json_same_except_ts():
    a = _j(date="2026-09-04", generated_at="2026-09-04T17:00:00+08:00", x=[1, 2], n={"generated_at": "a", "v": 1})
    b = _j(date="2026-09-04", generated_at="2026-09-04T19:41:29+08:00", x=[1, 2], n={"generated_at": "a", "v": 1})
    check("只有頂層 generated_at 不同 → 相同", ng.json_same_except_ts(a, b))
    c = _j(date="2026-09-04", generated_at="t", x=[1, 2], n={"generated_at": "b", "v": 1})
    check("巢狀 generated_at 不同 → 真變化（只忽略頂層）", not ng.json_same_except_ts(a, c))
    d = _j(date="2026-09-05", generated_at="t", x=[1, 2], n={"generated_at": "a", "v": 1})
    check("date 不同 → 真變化", not ng.json_same_except_ts(a, d))
    e = _j(date="2026-09-04", built_at="1", x=[1, 2], n={"generated_at": "a", "v": 1})
    f = _j(date="2026-09-04", built_at="2", x=[1, 2], n={"generated_at": "a", "v": 1})
    check("built_at 亦忽略", ng.json_same_except_ts(e, f))
    check("鍵順序不同視為相同", ng.json_same_except_ts('{"a":1,"b":2}', '{"b":2,"a":1}'))
    check("頂層是 list：逐元素比對", ng.json_same_except_ts("[1,2]", "[1,2]") and not ng.json_same_except_ts("[1,2]", "[1,3]"))
    check("解析失敗 → 真變化", not ng.json_same_except_ts("{bad", "{}"))
    check("多出一個鍵 → 真變化", not ng.json_same_except_ts('{"a":1}', '{"a":1,"b":2}'))


def test_classify_pure():
    head = {"data/a.json": _j(v=1, generated_at="1"), "data/b.json": _j(v=2, generated_at="1"),
            "data/c.json": _j(v=3, generated_at="1")}
    staged_noop = {"data/a.json": _j(v=1, generated_at="2"), "data/b.json": _j(v=2, generated_at="9")}
    rh, rs = head.get, staged_noop.get
    real, rep = ng.classify([("M", "data/a.json"), ("M", "data/b.json")], rh, rs)
    check("兩檔都只有時間戳 → noop", real is False and len(rep) == 2)
    staged_mix = dict(staged_noop, **{"data/c.json": _j(v=4, generated_at="2")})
    real, _ = ng.classify([("M", "data/a.json"), ("M", "data/c.json")], rh, staged_mix.get)
    check("其中一檔內容變 → 真變化", real is True)
    real, _ = ng.classify([("A", "data/new.json")], rh, lambda p: "{}")
    check("新增檔 → 真變化", real is True)
    real, _ = ng.classify([("D", "data/a.json")], rh, lambda p: None)
    check("刪除檔 → 真變化", real is True)
    real, _ = ng.classify([("M", "data/cards/x.png")], lambda p: "x", lambda p: "y")
    check("非 JSON（PNG）→ 真變化", real is True)
    real, _ = ng.classify([("M", "data/a.json")], lambda p: None, rs)
    check("HEAD 讀不到 → 真變化", real is True)
    real, rep = ng.classify([], rh, rs)
    check("staged 空 → 非真變化（交給前一步 git diff --cached --quiet）", real is False)
    real, _ = ng.classify([("R100", "data/a.json")], rh, rs)
    check("rename → 真變化", real is True)


def _run(cwd, *args, **kw):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True, **kw)


def test_end_to_end_git():
    with tempfile.TemporaryDirectory() as td:
        _run(td, "git", "init", "-q")
        _run(td, "git", "config", "user.email", "t@t")
        _run(td, "git", "config", "user.name", "t")
        d = Path(td) / "data" / "daysummary"
        d.mkdir(parents=True)
        f = d / "latest.json"
        f.write_text(_j(date="2026-09-04", generated_at="2026-09-04T17:12:00+08:00", tone="x", stocks=[1, 2]), encoding="utf-8")
        _run(td, "git", "add", "data")
        _run(td, "git", "commit", "-qm", "init")
        env = dict(os.environ)
        guard = str(Path(__file__).resolve().parent.parent / "tools" / "noop_guard.py")

        # 情境 1：只改 generated_at → exit 3
        f.write_text(_j(date="2026-09-04", generated_at="2026-09-04T19:41:29+08:00", tone="x", stocks=[1, 2]), encoding="utf-8")
        _run(td, "git", "add", "data")
        r = subprocess.run([sys.executable, guard], cwd=td, capture_output=True, text=True, env=env)
        check("e2e：只有 generated_at → exit 3", r.returncode == 3)
        check("e2e：報告指出只有時間戳", "只有頂層時間戳" in r.stdout)
        _run(td, "git", "reset", "-q")
        _run(td, "git", "checkout", "-q", "--", "data")

        # 情境 2：內容也變 → exit 0
        f.write_text(_j(date="2026-09-05", generated_at="2026-09-05T17:00:00+08:00", tone="y", stocks=[1, 2]), encoding="utf-8")
        _run(td, "git", "add", "data")
        r = subprocess.run([sys.executable, guard], cwd=td, capture_output=True, text=True, env=env)
        check("e2e：內容變 → exit 0", r.returncode == 0)
        _run(td, "git", "commit", "-qm", "day2")

        # 情境 3：新增一檔（日檔）＋ latest 只改時間戳 → exit 0（新增檔是真變化）
        (d / "2026-09-05.json").write_text(_j(date="2026-09-05", generated_at="z"), encoding="utf-8")
        f.write_text(_j(date="2026-09-05", generated_at="2026-09-05T19:00:00+08:00", tone="y", stocks=[1, 2]), encoding="utf-8")
        _run(td, "git", "add", "data")
        r = subprocess.run([sys.executable, guard], cwd=td, capture_output=True, text=True, env=env)
        check("e2e：新增檔＋時間戳 → exit 0", r.returncode == 0)
        _run(td, "git", "commit", "-qm", "day2b")

        # 情境 4：PNG 二進位改動 → exit 0
        p = Path(td) / "data" / "x.png"
        p.write_bytes(b"\x89PNG1")
        _run(td, "git", "add", "data")
        _run(td, "git", "commit", "-qm", "png")
        p.write_bytes(b"\x89PNG2")
        _run(td, "git", "add", "data")
        r = subprocess.run([sys.executable, guard], cwd=td, capture_output=True, text=True, env=env)
        check("e2e：PNG 改動 → exit 0", r.returncode == 0)
        _run(td, "git", "reset", "-q")

        # 情境 5：守門在非 git 目錄跑 → fail-open exit 0 並印 ::warning
        with tempfile.TemporaryDirectory() as td2:
            r = subprocess.run([sys.executable, guard], cwd=td2, capture_output=True, text=True,
                               env=dict(env, GIT_CEILING_DIRECTORIES=td2))
            check("e2e：git 不可用 → fail-open exit 0", r.returncode == 0 and "::warning::" in r.stdout)


if __name__ == "__main__":
    test_json_same_except_ts()
    test_classify_pure()
    test_end_to_end_git()
    if FAILED:
        print(f"\nFAIL {len(FAILED)}：" + "、".join(FAILED))
        sys.exit(1)
    print("\nALL PASS")
