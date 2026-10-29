#!/usr/bin/env python3
"""Behavior tests for sync-shared-assets.py."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
TOOL = REPO_ROOT / "scripts" / "sync-shared-assets.py"


def run(root: Path, manifest: Path, command: str) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            command,
            "--root",
            str(root),
            "--manifest",
            str(manifest),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if os.sep != "/":
        # 检查器用 OS 原生分隔符打印路径（Windows 上是反斜杠），下面断言里的期望值是 / 分隔；
        # 统一归一化，断言内容不变，只是不因分隔符跨平台失败。
        completed = subprocess.CompletedProcess(
            completed.args,
            completed.returncode,
            completed.stdout.replace("\\", "/"),
            completed.stderr.replace("\\", "/"),
        )
    return completed


def write_manifest(path: Path, groups: list[dict[str, object]]) -> None:
    path.write_text(json.dumps({"version": 1, "groups": groups}), encoding="utf-8")


def assert_manifest_error(
    root: Path,
    manifest: Path,
    groups: list[dict[str, object]],
    expected: str,
) -> None:
    write_manifest(manifest, groups)
    result = run(root, manifest, "check")
    assert result.returncode == 2, result.stderr + result.stdout
    assert expected in result.stderr, result.stderr + result.stdout


with tempfile.TemporaryDirectory(prefix="shared-assets-") as tmp:
    root = Path(tmp)
    manifest = root / "manifest.json"
    source = root / "src" / "tool.js"
    target = root / "skills" / "one" / "scripts" / "tool.js"
    source.parent.mkdir(parents=True)
    target.parent.mkdir(parents=True)
    source.write_text("canonical\n", encoding="utf-8")
    target.write_text("canonical\n", encoding="utf-8")
    source.chmod(0o755)
    target.chmod(0o755)
    write_manifest(
        manifest,
        [
            {
                "name": "tool",
                "source": "src/tool.js",
                "targets": ["skills/one/scripts/tool.js"],
            }
        ],
    )

    clean = run(root, manifest, "check")
    assert clean.returncode == 0, clean.stderr + clean.stdout

    # Windows 不区分 POSIX 可执行位：os.chmod 只切只读属性，st_mode & 0o111 恒为 0，
    # 「mode 漂移」在本机不可表示。这组断言只在 POSIX 文件系统上有意义（CI 跑 Linux）。
    posix_exec_bits = bool(target.stat().st_mode & 0o111)
    if posix_exec_bits:
        target.chmod(0o644)
        mode_drift = run(root, manifest, "check")
        assert mode_drift.returncode == 1, mode_drift.stderr + mode_drift.stdout
        assert "mode" in mode_drift.stdout
        assert run(root, manifest, "sync").returncode == 0
        assert target.stat().st_mode & 0o111, "sync must repair executable mode drift"
    else:
        print("SKIP: 本机文件系统不区分 POSIX 可执行位，mode 漂移用例不可表示（Windows）")

    target.write_text("drift\n", encoding="utf-8")
    drift = run(root, manifest, "check")
    assert drift.returncode == 1, drift.stderr + drift.stdout
    assert "DRIFT" in drift.stdout and "tool" in drift.stdout
    assert source.read_text(encoding="utf-8") == "canonical\n"

    synced = run(root, manifest, "sync")
    assert synced.returncode == 0, synced.stderr + synced.stdout
    assert target.read_bytes() == source.read_bytes()
    if posix_exec_bits:
        assert target.stat().st_mode & 0o111, "sync must preserve executable mode"
    assert run(root, manifest, "check").returncode == 0

    target.unlink()
    missing = run(root, manifest, "check")
    assert missing.returncode == 1 and "MISSING" in missing.stdout
    assert run(root, manifest, "sync").returncode == 0
    assert target.read_bytes() == source.read_bytes()

    assert_manifest_error(
        root,
        manifest,
        [
            {"name": "one", "source": "src/tool.js", "targets": ["skills/one/scripts/tool.js"]},
            {"name": "two", "source": "src/tool.js", "targets": ["skills/one/scripts/tool.js"]},
        ],
        "ambiguous managed source",
    )

    assert_manifest_error(
        root,
        manifest,
        [{"name": "escape", "source": "../outside", "targets": ["skills/one/scripts/tool.js"]}],
        "escapes repository root",
    )

    duplicate_target_groups: list[dict[str, object]] = [
        {"name": "one", "source": "src/tool.js", "targets": ["skills/one/scripts/tool.js"]},
        {"name": "two", "source": "src/other.js", "targets": ["skills/one/scripts/tool.js"]},
    ]
    assert_manifest_error(
        root,
        manifest,
        duplicate_target_groups,
        "duplicate managed target",
    )

    assert_manifest_error(
        root,
        manifest,
        [
            {
                "name": "repeated",
                "source": "src/tool.js",
                "targets": [
                    "skills/one/scripts/tool.js",
                    "skills/one/scripts/tool.js",
                ],
            }
        ],
        "duplicate managed target skills/one/scripts/tool.js repeated in repeated",
    )

    copy_chain: list[dict[str, object]] = [
        {
            "name": "canonical",
            "source": "src/a/tool.js",
            "targets": ["src/b/tool.js"],
        },
        {
            "name": "derived",
            "source": "src/b/tool.js",
            "targets": ["skills/one/scripts/tool.js"],
        },
    ]
    for groups in (copy_chain, list(reversed(copy_chain))):
        assert_manifest_error(
            root,
            manifest,
            groups,
            "is both source for derived and target for canonical",
        )

    assert_manifest_error(
        root,
        manifest,
        [
            {
                "name": "cycle-a",
                "source": "src/a/tool.js",
                "targets": ["src/b/tool.js"],
            },
            {
                "name": "cycle-b",
                "source": "src/b/tool.js",
                "targets": ["src/a/tool.js"],
            },
        ],
        "is both source",
    )

    assert_manifest_error(
        root,
        manifest,
        [
            {
                "name": "foo-owner",
                "source": "src/foo.js",
                "targets": ["skills/one/scripts/foo.js"],
            },
            {
                "name": "renamed-owner",
                "source": "src/bar.js",
                "targets": ["skills/two/scripts/foo.js"],
            },
        ],
        "must keep canonical basename bar.js",
    )

    assert_manifest_error(
        root,
        manifest,
        [
            {"name": "one", "source": "src/tool.js", "targets": ["skills/one/scripts/tool.js"]},
            {"name": "two", "source": "other/tool.js", "targets": ["skills/two/scripts/tool.js"]},
        ],
        "duplicate canonical basename tool.js",
    )

    write_manifest(
        manifest,
        [
            {
                "name": "tool",
                "source": "src/tool.js",
                "targets": ["skills/one/scripts/tool.js"],
            }
        ],
    )
    source.unlink()
    missing_source_sync = run(root, manifest, "sync")
    assert missing_source_sync.returncode == 1, (
        missing_source_sync.stderr + missing_source_sync.stdout
    )
    assert "MISSING SOURCE [tool] src/tool.js" in missing_source_sync.stdout
    assert "FAIL: synchronization incomplete" in missing_source_sync.stdout
    assert "OK:" not in missing_source_sync.stdout


for markdown_suffix in (".md", ".MDX", ".mDx"):
    with tempfile.TemporaryDirectory(prefix="shared-assets-domain-") as tmp:
        root = Path(tmp)
        manifest = root / "manifest.json"
        source = root / "skills" / "one" / "references" / f"guide{markdown_suffix}"
        target = root / "skills" / "one" / "references" / "runtime-shadow" / source.name
        source.parent.mkdir(parents=True)
        source.write_text("reference document\n", encoding="utf-8")
        write_manifest(
            manifest,
            [
                {
                    "name": "reference-misregistered-as-runtime",
                    "source": source.relative_to(root).as_posix(),
                    "targets": [target.relative_to(root).as_posix()],
                }
            ],
        )

        rejected = run(root, manifest, "sync")
        assert rejected.returncode == 2, rejected.stderr + rejected.stdout
        assert "runtime manifest cannot manage Markdown" in rejected.stderr
        assert not target.exists(), "invalid runtime manifests must fail before copying"


with tempfile.TemporaryDirectory(prefix="shared-assets-reference-runtime-") as tmp:
    root = Path(tmp)
    manifest = root / "manifest.json"
    runtime_groups: list[dict[str, object]] = []
    for filename in ("story_hook_core.js", "reference_helper.PY"):
        source = root / "skills" / "one" / "references" / filename
        target = root / "skills" / "one" / "references" / "runtime-shadow" / filename
        source.parent.mkdir(parents=True, exist_ok=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(f"runtime {filename}\n", encoding="utf-8")
        target.write_bytes(source.read_bytes())
        runtime_groups.append(
            {
                "name": filename,
                "source": source.relative_to(root).as_posix(),
                "targets": [target.relative_to(root).as_posix()],
            }
        )
    write_manifest(manifest, runtime_groups)

    allowed = run(root, manifest, "check")
    assert allowed.returncode == 0, allowed.stderr + allowed.stdout


with tempfile.TemporaryDirectory(prefix="python-store-stub-") as tmp:
    stub_dir = Path(tmp)
    python3_stub = stub_dir / "python3"
    python3_stub.write_text("#!/bin/sh\nexit 49\n", encoding="utf-8")
    python3_stub.chmod(0o755)
    python_fallback = stub_dir / "python"
    python_fallback.write_text(
        "#!/bin/sh\nexec {} \"$@\"\n".format(shlex.quote(sys.executable)),
        encoding="utf-8",
    )
    python_fallback.chmod(0o755)
    environment = os.environ.copy()
    environment["PATH"] = str(stub_dir) + os.pathsep + environment.get("PATH", "")
    wrapper = subprocess.run(
        ["bash", str(REPO_ROOT / "scripts" / "check-shared-files.sh")],
        cwd=REPO_ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    assert wrapper.returncode == 0, wrapper.stderr + wrapper.stdout
    assert "Shared File Governance Check" in wrapper.stdout

print("OK: shared asset manifest detects drift and syncs atomically")
