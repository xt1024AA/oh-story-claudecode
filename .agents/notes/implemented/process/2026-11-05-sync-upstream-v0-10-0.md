# Agent Note: 把仓库源头同步到上游 v0.10.0（按路径白名单，不用 merge）

Status: implemented

对应任务：2026-11-05，作者要求「仓库中的源头 oh-story-claudecode 有更新了，帮我同步到插件」。上游 v0.10.0「长篇与短篇写作清理」于 2026-11-04 发布（tag `v0.10.0`，target `95c698a`），本仓 `origin/main` 已含该提交与随后的 `#517`（`0b5cf2a`）。插件从 0.2.4 升到 0.2.5。

## Problem

本仓有两条长期并存的历史线：`origin/main` 是上游镜像线（只有 skills / scripts / demo / 七端适配层，**没有** `packages/` 与本地那批 `.agents/notes/`），`dsh-plugin` 分支是插件开发线（在上游内容之上加了 `packages/dsh-plugin/`、DSH 专属决策笔记、`docs/agents/` 与 `docs/bug-reports/`）。两条线自 `87f2e7e` 起分叉。

于是「同步上游」不能直接 `git merge origin/main`：`git merge-tree --write-tree` 预演产生 **537 个冲突文件**，其中最大一块是 `packages/dsh-plugin/` 整包与本地决策笔记、调研文档被当成「origin/main 已删除」。真合并会用一次 merge 把插件子包、装机验收留档与决策笔记一起抹掉。

同时 `scripts/` 里带着若干**本地平台补丁**（见 `process/2026-10-29-windows-runnable-guards.md` 与 `bug-fix/2026-10-04-doc-budget-crlf-anchor-lookup.md`）：Windows 文本桩 SKIP、符号链接无特权跳过、CRLF 锚点归一化。它们的共同形态是「上游文件 + 本地小改」，任何整文件回滚或整文件覆盖都会丢掉其中一半。

## Decision

1. **按路径白名单同步，不做 merge。** 白名单 = `skills scripts demo .claude-plugin .zcode-plugin .clawhub marketplace.json reasonix-plugin.json .github README.md README_EN.md CHANGELOG.md CONTRIBUTING.md`；对这些路径 `git checkout origin/main --`，再用 `ls-tree` / `ls-files` 求差集**显式删除**上游已删的文件（`git checkout` 不会替我们删）。`packages/`、`.agents/`、`docs/`、`AGENTS.md` 不进白名单。
2. **删除动作只作用于白名单。** 本次白名单内共 19 个文件在上游已不存在，按差集逐个删除；`packages/` 与 `docs/research/` 下的同名文件不参与，插件子包与 DSH 调研文档零损失（`.agents/` 改动数为 0）。
3. **平台补丁按「上游是否改过该文件」分流回补。** 先用 `git diff --quiet <merge-base> origin/main -- <file>` 判定：上游没动过的（`test-doc-budget.py`、`check-opencode-adapter.sh`、`test-shared-assets.py`）直接 `git checkout HEAD --` 原样取回；上游改过的（`check-codex-adapter.sh`、`test-opencode-plugin.mjs`、`test-codex-cli-e2e.sh`、`test-opencode-cli-e2e.sh`）只做**语义级重贴**，不整文件回滚。
4. **`check-doc-budget.sh` 的仓库根剔除改为三种写法都剔。** 生成的任务包里写的是原生反斜杠绝对路径，而脚本原先只按 `repoRoot + path.sep` 剔除，MSYS 形式对不上，同一份内容在 Windows 上多算 56–84 字，正好压过 18/20 字的余量。改后锚点与计量都正确，**没有调高任何预算数字**。
5. **`check-codex-adapter.sh` 的生成件比对忽略行尾。** Windows 检出（`core.autocrlf=true`）下提交的 TOML 是 CRLF、生成器写 LF，`diff -qr` 把行尾差异当成「过期」；归一化后实测 **0 处内容差异**，改为按忽略行尾的内容比对，LF 检出上行为不变。
6. **`test-opencode-plugin.mjs` 的 compact 断言归一化分隔符。** 产品输出在 Windows 上是反斜杠（本地惯例），断言里写死 `book/...`；只在断言前归一，不改产品输出。
7. **插件升 0.2.5**：重新 vendored（434 个文件与根 `skills/` 逐字节一致），`package.json` / `lib/index.js` 的 `VERSION` / README 三处一致。

## Alternatives considered

- **直接 `git merge origin/main`。**
  最强理由：一条命令带走上游全部改动，历史清楚，冲突可以逐个解，是最正统的同步方式。
  为何不用：预演 537 个冲突文件，其中「删除」侧包含整个 `packages/dsh-plugin/` 与本地决策笔记——默认解会把它们删掉；要保住它们得手写几十条 `--ours` 决策，比白名单更容易漏，而且一次 merge 就把「插件子包不在上游线」这件事写进历史。

- **`git checkout origin/main -- .` 全量覆盖，再手工恢复 `packages/` 与 `.agents/`。**
  最强理由：最短路径，覆盖面最大，不可能漏掉任何上游文件。
  为何不用：`ls-files` 与 `ls-tree` 的差集会一次性删掉 `docs/research/`（插件 README 的规范依据）、`docs/agents/`、`docs/bug-reports/`，恢复靠人记得有哪些。白名单是「默认不删」，漏的是新增而不是既有资产。

- **把本地平台补丁全部回滚成上游版本，让 Windows 清单继续红。**
  最强理由：与上游逐字节一致，`scripts/` 不再有分叉，将来同步零成本。
  为何不用：`process/2026-10-29-windows-runnable-guards.md` 记的正是「44 条清单在 Windows 上恒红等于没有清单」；回滚等于把已付的代价再付一次，而本次没有一条红是真回归——四条 `exit=49` 全是本机 `python3` 占位程序，用 `exec python` 的 shim 后即绿。

- **调高 `doc-budget.json` 里两条 story-architect 分支的预算（各 +20 字）。**
  最强理由：一处 JSON 改动立刻变绿，不碰脚本，风险最低。
  为何不用：超预算的根因是计量把机器路径算进了字数，不是内容变长；调预算会把一个可修的计量缺陷固化成长期豁免，而 AGENTS.md 明确要求调预算必须说明「这段值得每个用户每次会话都付」。

## Consequences

收益：

- 一次同步同时拿到 v0.10.0 的正文与 `#517` 的发布资料收尾，`packages/dsh-plugin/`、`.agents/notes/`、`docs/research/`、`docs/agents/`、`docs/bug-reports/` 零损失。
- 「按上游是否改过该文件分流回补」成为可复用的同步动作，不再靠记忆决定哪几处该留。
- 热路径预算守卫在 Windows 上给出与 Linux 一致的读数，且没有牺牲任何一条预算约束。
- 插件侧全绿：`check-manifest`、14 项变异回归、`check-parity`（434 文件逐字节一致）、35 项工具面测试。

代价与风险：

- `scripts/` 与上游继续存在有意的分叉（现在是 4 个文件），下次同步仍要人判断哪几处该留；本笔记记录了判断方法，但没有脚本强制它。
- 白名单是手工清单：上游将来新增顶层目录不会自动跟进来，需要人补进白名单。
- `AGENTS.md` 刻意不跟上游：它是本仓的工作区说明（含 DSH 决策笔记约定与 matt-pocock 的 tracker/triage/domain 配置），上游那份是给纯 skill 仓库写的，直接覆盖会丢掉本仓的本地约定。
