# Agent Note: 让 CONTRIBUTING 清单里的三条守卫在 Windows 上可跑

Status: implemented

## Problem

按 `CONTRIBUTING.md`「CI 检查」的 44 条强制命令在本机（Windows）实跑，稳定红 3 条，且都不是内容问题：`test-shared-assets.py` 靠 `os.chmod(0o644)` 造可执行位漂移，Windows 没有 POSIX 可执行位，`st_mode & 0o111` 恒为 0；`check-codex-adapter.sh` 要求 `.agents/skills` 是符号链接，`core.symlinks=false` 时 Git 把它检出成「内容即目标路径」的文本桩；`check-opencode-adapter.sh` 的用例自己 `os.symlink(...)`，无创建符号链接特权时 `WinError 1314`。红的代价不只是噪音——本地清单失去信号，真回归和平台缺口混在一起，最后没人看这 44 条。

## Decision

四处按「平台能力探测 + 缩小跳过范围」处理，只跳过本机不可表示的断言，其余照跑；跳过都打印 SKIP 行，不静默。

- `test-shared-assets.py`：先用 `target.stat().st_mode & 0o111` 探测本机是否保留 POSIX 可执行位，只有探测为真时才跑 mode 漂移四条断言（漂移检测、`mode` 字样、sync 修回、sync 保值）。`run()` 在非 `/` 分隔符平台上把子进程 `stdout/stderr` 的反斜杠归一化为 `/`，路径类期望值不再跨平台失败。
- `check-codex-adapter.sh`：符号链接分支原样保留；新增文本桩分支——`.agents/skills` 是普通文件且内容恰为 `../skills` 时打印 SKIP 并跳过 discovery 循环；形状不对（错目标、目录、别的文本）仍然 fail。
- `check-opencode-adapter.sh`：symlink 目录那个子用例用 `try/except (OSError, NotImplementedError)` 包住创建动作，失败时打印 SKIP 并提前退出该 python 块。回滚类断言在它之前，已经跑过，不受影响。
- `test-opencode-plugin.mjs`：`preCompactOutput` 用 `path.relative` 生成相对路径，Windows 上是反斜杠；断言前把 system 文本 `replaceAll("\\", "/")` 再比较。产品代码不动，Windows 用户看到的仍是本地分隔符。

## Alternatives considered

- 整条 `skipIf(sys.platform == "win32")`：改动最小，但本地直接失去这四条覆盖，Windows 上真回归不会再被发现；而且 codex / opencode 两条里绝大部分断言与平台无关，整条跳过太粗。
- 改产品代码让所有路径一律输出 `/`（`path.posix`）：能让断言天然通过，但改变了用户可见输出（Windows 上反斜杠才是本地惯例），收益不成立。
- 只在 Linux CI 跑、本地不管：这正是问题现状——44 条清单在 Windows 上永远红，等于没有本地清单。
- 让用户在本地手工传 `PYTHONUTF8`、装符号链接特权：前者已在跑法里垫片解决，后者要开发者模式或管理员权限，不该是跑测试的门槛。

## Consequences

本机清单从 41/44 变成 44/44，SKIP 行会明确打出来说明哪几条在本机不可验证。代价是这三个上游测试文件与本仓库不再逐字节一致——此前只有 `check-doc-budget.sh` 一处 CRLF 偏离，现在多三处平台兼容补丁，下次同步 `scripts/` 时要记得把它们保留，否则本地清单重新变红（和 CRLF 补丁同一个坑）。Linux/macOS CI 上的行为与断言强度不变。