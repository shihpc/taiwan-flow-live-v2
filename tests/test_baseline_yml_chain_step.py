# tests/test_baseline_yml_chain_step.py — baseline.yml「build chain daily」步驟改比內容（2026-11-18，§1.6）
#
# 把該步驟的 run 區塊原樣抽出，在臨時 git repo 裡配假的 build_chain_daily.py 實跑：
# 只有 generated_at 變 → 還原；內容有變（即使 dates 最新一天沒變）→ 保留待 commit；builder 失敗 → 還原且 ok=0。
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import noop_guard as ng  # noqa: E402

WF = yaml.safe_load((ROOT / ".github" / "workflows" / "baseline.yml").read_text(encoding="utf-8"))
STEP = next(s for s in WF["jobs"]["build"]["steps"] if s.get("id") == "chain")
SERIES = {"generated_at": "t0", "dates": ["2026-11-17", "2026-11-18"], "market": {"amt": [1.0, 2.0]}}

BUILDER = '''
import json, sys
mode = open("mode.txt").read().strip()
if mode == "fail":
    open("data/chain_daily/series.json", "w").write("{half")     # 半寫入
    sys.exit(1)
p = "data/chain_daily/series.json"
j = json.load(open(p))
j["generated_at"] = "t1"
if mode == "value":
    j["market"]["amt"][-2] = 9.9          # 近日重抓改到「不是最新一天」的值；dates 不變
elif mode == "newday":
    j["dates"].append("2026-11-19"); j["market"]["amt"].append(3.0)
json.dump(j, open(p, "w"))
'''


def git(cwd, *a):
    return subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def repo(tmp_path):
    (tmp_path / "data" / "chain_daily").mkdir(parents=True)
    (tmp_path / "src").mkdir()
    (tmp_path / "tools").mkdir()
    (tmp_path / "data" / "chain_daily" / "series.json").write_text(json.dumps(SERIES))
    (tmp_path / "src" / "build_chain_daily.py").write_text(BUILDER)
    shutil.copy(ROOT / "tools" / "noop_guard.py", tmp_path / "tools" / "noop_guard.py")
    git(tmp_path, "init", "-q")
    git(tmp_path, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A")
    git(tmp_path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    return tmp_path


def run_step(repo, mode):
    (repo / "mode.txt").write_text(mode)
    out = repo / "gh_output.txt"
    out.write_text("")
    bindir = repo / "bin"
    bindir.mkdir(exist_ok=True)
    (bindir / "python").symlink_to(sys.executable) if not (bindir / "python").exists() else None
    import os
    env = dict(os.environ, GITHUB_OUTPUT=str(out), PATH=f"{bindir}:{os.environ['PATH']}")
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", STEP["run"]], cwd=repo, env=env,
                       capture_output=True, text=True)
    changed = "data/chain_daily/series.json" in git(repo, "status", "--porcelain")
    return r, out.read_text().strip(), changed


def test_step_no_longer_compares_latest_date_only():
    assert "before=" not in STEP["run"] and "noop_guard.py --worktree" in STEP["run"]


def test_timestamp_only_is_restored(repo):
    r, out, changed = run_step(repo, "ts")
    assert r.returncode == 0 and out == "ok=1" and not changed
    assert "內容無變化" in r.stdout


def test_value_change_without_new_date_is_kept(repo):
    """舊寫法（比 dates 最新一天）會把這種變更還原掉——近日重抓就白做了。"""
    r, out, changed = run_step(repo, "value")
    assert r.returncode == 0 and out == "ok=1" and changed


def test_new_date_is_kept(repo):
    r, out, changed = run_step(repo, "newday")
    assert r.returncode == 0 and out == "ok=1" and changed


def test_builder_failure_restores_and_flags(repo):
    r, out, changed = run_step(repo, "fail")
    assert r.returncode == 0 and out == "ok=0" and not changed
    assert "::warning::" in r.stdout


def test_worktree_mode_fail_open(repo, monkeypatch):
    monkeypatch.chdir(repo)
    assert ng.main(["--worktree", "data/chain_daily/series.json"]) == ng.EXIT_NOOP
    assert ng.main(["--worktree", "nope.json"]) == ng.EXIT_CHANGE          # HEAD 沒有 → 真變化
    (repo / "data" / "chain_daily" / "series.json").write_text("{bad")
    assert ng.main(["--worktree", "data/chain_daily/series.json"]) == ng.EXIT_CHANGE
    assert ng.main(["--worktree"]) == ng.EXIT_CHANGE


def test_reconcile_workflow_shape():
    wf = yaml.safe_load((ROOT / ".github" / "workflows" / "reconcile.yml").read_text(encoding="utf-8"))
    assert wf["permissions"] == {"contents": "read", "issues": "write"}
    steps = wf["jobs"]["reconcile"]["steps"]
    last = steps[-1]
    assert last["uses"] == "./.github/actions/notify-failure" and last["with"] == {"pipeline": "v2-reconcile"}
    assert last["if"] == "failure() || cancelled()"
    text = (ROOT / ".github" / "workflows" / "reconcile.yml").read_text(encoding="utf-8")
    assert "secrets." not in text and "git push" not in text and "git commit" not in text
    assert wf[True]["schedule"] == [{"cron": "37 23 * * 1-5"}]
