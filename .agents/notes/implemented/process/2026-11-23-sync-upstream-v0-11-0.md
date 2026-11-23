# Agent Note: 同步上游 v0.11.0「零依赖 Node.js 运行时」，插件执行链从 Python 切到 Node

Status: implemented

对应任务：2026-11-23，作者第三次要求「仓库中的源头 oh-story-claudecode 有更新了，帮我同步到插件」。上一轮停在 `v0.10.3` 之后的 4 个修补提交（插件 0.2.7）；本轮上游发布了 **v0.11.0**（`e5a8b98657c05ddb3d53b77d5afe696a63d79985`，2026-11-22T06:56:29Z），是自 v0.10.0 以来最大的一次结构性改动。

## Problem

四件事，前三件是上游强加给我们的，第四件是上游改完之后我们自己必须跟着改：

1. **skill 内的运行时语言整体换掉了。** 上游把 16 个 Python 脚本全部改写成 Node（`storyctl.py` → `storyctl.js`、`wordcount_core.py` → `wordcount_core.js`、`tracking_commit.py` → `tracking_commit.js`、`outline_view.py` → `outline_view.js`、`build_architect_brief.py`、`build_writer_prompt.py`、`author_memory_commit.py`、`build_chapter_index.py`、`inspect_existing_assets.py`、`manage_analysis_run.py`、`build_outline_brief.py`、`check-publish-format.py`、`copy-path-safety.py`、`deploy-antigravity-skills.py`、`merge-hooks.py`、`merge-project-instructions.py`），并删掉 `inspiration_index.py`、`convert_outline_format.py`、`template_fence.py`、`merge-antigravity-hooks.py`、`merge-claude-settings.py`、`merge-codex-hooks.py`。白名单内共删除 41 个 `.py`、25 个 `.sh`。插件的 `storyctl` 路径常量与三个工具（chapter check / chapter commit / wordcount）会直接 `ENOENT`。
2. **hook 体系从 10 个 `.sh` 收敛成 3 个 Node 文件。** `templates/hooks/` 只剩 `run-story-hook.sh` + `story_hook_cli.js` + `story_hook_core.js`，被删的是 `check-prose-after-write.sh`、`detect-story-gaps.sh`、`guard-outline-before-prose.sh`、`lib/common.sh`、`lib/sentinel.sh`、`post-compact.sh`、`pre-compact.sh`、`session-end.sh`、`session-start.sh`、`validate-story-commit.sh`——**这正是前三轮我逐个打的 5 处 Windows 产品补丁的全部宿主**（awk argv 按 cp936 重编码、`set -e` 吞掉 AND 列表、命令替换里 `cat|sed|head` 取不到管道、`while` 循环被内层 grep 吞 stdin、`pwd -P` 与 MSYS `find` 路径形式不一致）。上游用「换语言 + 合文件」把这些问题一并绕开了，但也意味着这些补丁**无处回贴**，只能验证上游新实现是否真的没有同样的病。
3. **守卫体系并入一个 `lint-repo.py`。** 新增 `scripts/lint-repo.py`（子检查 `static` / `contracts` / `shared` / `numbering` / `agent-refs`），删除 `check-agent-notes.py`、`check-agent-reference-consumers.py`、`check-author-reports.py`、`check-current-skill-contracts.{py,sh}`、`check-hook-locale-safety.sh`、`check-hook-regex-sync.sh`、`check-reference-gates.js`、`check-reference-routing.py`、`check-reference-similarity.py`、`check-shared-files.sh`、`check-short-analysis-scope.py`、`generate-codex-hooks.py`、`skill-numbering.py`、`static-check.{py,sh}` 及一批 `.sh` 测试；`check-doc-budget.sh` 被 R054 重命名为 `check-doc-budget.mjs`。其中 `check-reference-routing.py` 和 `check-doc-budget.sh` 是我此前打过平台补丁的文件，**补丁目标本身不存在了**。
4. **插件自己对 Python 的依赖只剩名义上的。** 0.2.7 的插件把「Python 不可用」当成硬错误（`chapter-check` 等直接返回 `PYTHON_UNAVAILABLE`），且 `ai_patterns` 的 `failOn` 只认 `blocking` / `all`；而 v0.11.0 的句式检测器把命中分成 hard blocking / review_required / advisory 三档，当前规则集里**没有一条** hard blocking——沿用 `defaultFailOn: "blocking"` 会让这个工具永远报 clean，等于静默失效。

## Decision

1. **仍然走路径白名单同步，不用 merge。** 白名单维持上一轮的 15 项（`skills scripts demo .claude-plugin .zcode-plugin .clawhub marketplace.json reasonix-plugin.json .github README.md README_EN.md CHANGELOG.md CONTRIBUTING.md docs tests`），`git checkout v0.11.0 -- $WL` 后用 `git ls-tree` 与 `git ls-files` 求差集删除上游已删文件。理由与前三轮相同且本轮更硬：`origin/main` 与 `v0.11.0` 是同一个 sha，但 fork 的 `packages/` 与 `.agents/` 在那边从来不存在，merge 会把它们判成「上游已删除」。
2. **差集删除要显式排除 fork 专属文档。** 本轮差集第一次跑把 7 份文档一并删了（`docs/agents/{domain,issue-tracker,triage-labels}.md`、`docs/research/{dsh-0.2.1-plugin-contract-delta,dsh-plugin-spec,story-script-contracts}.md`、`docs/bug-reports/2026-10-04-dsh-tool-result-pruner-orphaned-tool-use.md`），已 `git checkout HEAD --` 全部恢复；另有一份 `skills/story-short-write/scripts/author_memory_commit.py` 因为上游改名而漏删，已补删。最终 **33 A / 70 D / 331 M / 1 R**，`LEFTOVER=[]`、`MISSING=[]`。
3. **插件执行链跟着上游切到 Node，Python 降级为可选。** `packages/dsh-plugin/lib/runtime/paths.js` 的 `storyctl` / `wordcountCore` 指向 `.js`；`chapter-check.js`、`chapter-commit.js`、`wordcount.js` 改用 `runtime.runNode(...)`，信封统一写 `env: { python: null, node: ran.probe }`；`env.js` 的说明改成「Node 是必需，Python 只供旧项目排查」，缺 Python 不再产生任何警告；`test-tools.mjs` 的 B1 用例从「Python 不可用 → `PYTHON_UNAVAILABLE`」翻转为「Python 不可用不再挡路，`ok === true`」。这不是可选的「顺手现代化」——v0.11.0 的随包脚本已经是 `.js`，不切就是全工具 ENOENT。
4. **`ai_patterns` 的 `failOn` 加中间档 `review_required` 并设为默认。** `_detector.js` 的 `countFindings` 多返回一个 `review_required` 字段，`failOn` 枚举变成 `blocking` / `review_required` / `all` 三档。取 `review_required` 而非 `blocking` 的理由是取证过的：当前规则集里 hard blocking 计数恒为 0（`test-tools.mjs` 的 A7 断言 `counts.blocking === 0`、`counts.review_required === 3`、`total === 8`），选 `blocking` 这个工具就永远 clean。`blocking` 一档保留，等上游补上 hard blocking 规则再谈切换。
5. **平台补丁分流：能回贴的回贴，目标被删的就不再保留。** 10 处旧补丁里，8 处目标文件仍在（`check-doc-budget.mjs`、`test-shared-assets.py`、`check-codex-adapter.sh`、`check-antigravity-adapter.sh`、`test-antigravity-hook-merge.py`、`test-antigravity-skills-deploy.py`、`test-opencode-plugin.mjs`、`check-opencode-adapter.sh`）→ 语义级重贴；5 处目标被删（4 个 hook `.sh` + `check-reference-routing.py`）→ 不保留。**逐条核对过上游没有自行修掉这些问题**，所以重贴是必要开销，不是历史包袱。
6. **`check-doc-budget.mjs` 的两处补丁按新增代码重写而非整文件回滚**：`weigh()` 里加 `.replace(/\r\n?/g, "\n")`（CRLF 检出下 `#小节` 锚点匹配不到，实测误报从 24 条降到 0），`generatedWeight` 改 `rootNative` / `rootBack` / `rootPosix` 三写法剔除（任务包 brief 里写的是原生反斜杠绝对路径，只剔除 `repoRoot + path.sep` 会多算 56–84 字）。
7. **插件升 0.2.8，兼容基线加 DSH 0.2.2-rc.5。** `SUPPORTED_RUNTIMES` 从 `["0.2.0-rc.2","0.2.1-rc.2","0.2.1-rc.5"]` 扩到含 `"0.2.2-rc.5"`；peer 仍是 `^0.2.0-rc.2` 未动（该范围已覆盖 0.2.2-rc.5）。版本三处一致：`package.json`、`lib/index.js` 的 `VERSION`、`README.md` 的状态行与版本段。
8. **顺手清掉插件里残留的 `.py` 提法。** `examples/minimal/README.md`（3 处等价命令 + 1 处 stdout 契约说明）、`examples/types/consumer.ts`（1 处 `command`）、`lib/tools/chapter-commit.js`（5 处 `tracking_commit.py`）、`lib/runtime/proc.js`、`lib/runtime/script-json.js`、`lib/runtime/interpreter.js`、`README.md` 一处。这些是文档性错误，不改会让用户照着 README 敲 `python storyctl.py` 得到 `No such file`。**`docs/verification/` 下 3 份历史留档没改**——它们是「当时实跑的输出逐字复制」，改了就变成伪造取证。

## Alternatives considered

- **改用真正的 merge（`git merge v0.11.0`）。**
  最强理由：`origin/main` 与 `v0.11.0` 同一 sha，merge 是唯一能把「上游删了哪些文件」自动算准的机制；差集删除已经连续两轮误删 fork 专属文档，白名单的边界维护成本在上升。
  为何不用：merge 会把 `packages/`、`.agents/` 整个判成「上游已删除」（那两边从来没有这两个目录），冲突面在上一轮实测是 537 个文件，且默认解会抹掉插件本体与全部决策笔记。用 `git merge -s ours` 之类的手法保住它们，等于把「哪些路径属于 fork」这件事从显式白名单换成隐式策略参数——更不容易审。代价我认可：差集删除必须每次手工排除 fork 专属文档，这一条已写进 Consequences 当作已知风险。

- **保留 Python 执行路径，同时支持 `.py` 与 `.js` 两套脚本（运行期探测哪套存在）。**
  最强理由：0.2.7 的用户装了老版本 skill 仍能跑；双栈过渡对下游最温和。
  为何不用：插件与 vendored skills 是同版本绑定的（`check-parity` 强制 421 文件逐字节一致），根本不存在「插件新、skills 旧」的组合；双栈只会让 `paths.js` 与三个工具各多一条死分支，而那条分支永远不会被走到。要做兼容也是在 DSH 侧装旧版插件，不在一个包里双栈。

- **`ai_patterns` 的 `defaultFailOn` 直接取 `all`（最严格）。**
  最强理由：检测器报的每一条都值得看一眼，默认最严格意味着不会漏。
  为何不用：`all` 把 advisory 也算「有发现」，而 advisory 是套词密度这类风格提示；默认就报 findings 会让这个工具在日常使用里恒为红，最终结果是人人都加 `failOn: "blocking"` 绕过它。取中间档 `review_required` 是「默认有信号、但不至于噪音淹掉信号」。

- **把 `docs/verification/` 下的 `.py` 命令也一并改成 `.js`。**
  最强理由：全仓不再出现 `storyctl.py` 更整洁，也不会有读者照着抄。
  为何不用：那 3 份文件是「文档里的每条命令都实际跑过」的取证留档，正文明确写着「输出逐字复制」；把当时的 `python storyctl.py` 改成 `node storyctl.js` 就是伪造取证记录。历史留档允许过时，前提是它诚实地标着自己跑在哪个版本（文首就写着 DSH `0.2.0-rc.2` / 插件 0.2.1）。

- **本轮顺手给 `lint-repo.py` 补一个 `notes` 子检查**（上游删掉了 `check-agent-notes.py`，`.agents/notes/` 从此没有任何自动校验）。
  最强理由：笔记格式（文件名小写连字符、必含 Problem/Decision/Alternatives/Consequences）是 AGENTS.md 的硬规矩，守卫一删就退化成口头约定。
  为何不用：这与本次同步无关，且新增子检查要同步 CI、CONTRIBUTING 与 `scripts/README.md`。已记进 Consequences 作为后续项。

## Consequences

收益：

- 上游 v0.11.0 的全部内容落地：16 个 Python 脚本换 Node、10 个 hook 合并成 3 个 Node 文件、7 条守卫并入 `lint-repo.py`、`check-doc-budget` 转 `.mjs`、Dashboard 与运行时缺陷修复。
- 插件的运行时依赖从「Python + Node」降到「只要 Node」（缺 Node 才全工具 `NODE_UNAVAILABLE`），与上游「零依赖 Node.js 运行时」的口径一致；Python 探测链保留在 `oh_story_env` 里供旧项目排查。
- `ai_patterns` 从「恒 clean」变成「默认能报出 review_required」，工具重新有信号（A7：8 处命中，3 条 review_required，0 条 blocking）。
- 8 处平台补丁全部重贴并逐条验证，Windows 下 8 条适配器守卫、`lint-repo.py`、`check-doc-budget.mjs`、7 个新 Node 测试、15 个 Python 测试、2 个独立脚本测试全绿；插件四项（manifest / 14 项变异回归 / parity 421 文件 / 35 项工具面）0 失败。
- 白名单跑到第三轮，`docs` 与 `tests` 已在名单内，README 死链保持为 0。

代价与风险：

- **5 处产品侧补丁随文件删除而消失**，它们的 bug 只能靠「上游换实现后是否复现」来判断。本轮通过重跑全部 hook 测试确认未复现，但不是证明——下一次上游再改 hook 也要重新验。
- **差集删除的手工排除项变成隐性契约**：`docs/agents/`、`docs/research/`、`docs/bug-reports/` 三棵子树必须在 diff 之后 `git checkout HEAD --` 找回。本轮已经误删过一次，恢复靠的是我记住了这 7 份文件；下次换人同步很可能直接漏。
- `.clawhub/publish.json` 声称的是上游 digest，而 fork 带着自己的平台补丁，两者本来就不严格对应；本仓无 digest 计算脚本、无守卫交叉校验。
- `.agents/notes/` 失去自动校验（`check-agent-notes.py` 被上游删除且 `lint-repo.py` 没有对应子检查），笔记格式退化为口头约定。
- 插件 `docs/verification/` 下 3 份历史留档仍写 `python storyctl.py`，按上面的取舍是刻意保留的，但读者需要自己看出它们跑在 0.2.1 时代。
