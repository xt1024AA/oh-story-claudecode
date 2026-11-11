# Agent Note: 同步 v0.10.3 之后的 4 个修补提交，并把白名单扩到 `docs/` 与 `tests/`

Status: implemented

对应任务：2026-11-11，作者再次要求「仓库中的源头 oh-story-claudecode 有更新了，帮我同步到插件」。上一轮停在 `v0.10.3`（插件 0.2.6）；本轮上游**没有发新 tag**，`origin/main` 从 `43c162b` 前进到 `41d28fc`，是发布后的 4 个修补提交。

## Problem

三件事：

1. **白名单挡掉了本轮一半的增量。** 白名单内（`skills scripts demo .claude-plugin .zcode-plugin .clawhub marketplace.json reasonix-plugin.json .github README.md README_EN.md CHANGELOG.md CONTRIBUTING.md`）对 `v0.10.3..origin/main` 只有 7 个文件、+95/−10；真正的内容变更集中在这 7 个：Dashboard 表格渲染修复（`skills/story/assets/app.js` +46/−1、`styles.css` +39，新增 `markdownTableCells`）、`story-short-analyze` 的「情节节点清单只存一份」（`output-contract.md`、`stage2-3-structure-emotion.md`）、`.clawhub/publish.json`、`demo/` 的拆文报告、`README.md` 一行。
2. **`docs/` 自 v0.10.0 起就没再同步，已经积累成硬伤。** 本地 `docs/` 里 6 个文件停在 v0.10.0 旧版；更有 6 个上游从 v0.10.1 起新增的文档本地完全没有（`novel-chapter-outline-template.md`、`novel-story-bible-template.md`、`open-source-ai-novel-writing-tools.md`、`web-novel-chapter-ending-hooks.md`、`web-novel-golden-three-chapters.md`、`web-novel-outline-template.md`），而 `README.md` 早就链接了它们——本仓 README 的 14 条 docs 链接里有 6 条是死链。仓内没有任何守卫校验 README 链接存在性，所以一直没红。
3. **`tests/` 也不在白名单**，#538 新增的两个 e2e 用例（`dashboard-edit-safety.spec.mjs`、`dashboard-tables.spec.mjs`）落不下来，Dashboard 修复在仓内没有对应回归。

## Decision

1. **白名单扩为 `… docs tests`**，`git checkout origin/main -- $WL docs tests`。
2. **`docs/` 取「并集」而非镜像**：`git checkout` 只写上游有的文件、不删本地文件，因此 `docs/agents/`、`docs/research/`、`docs/bug-reports/` 三个 fork 本地子树天然保留（这七份是 DSH 专属文档，上游没有）。上游侧文件一律取上游版本，包括 `hosts.md` 里那句「这 14 个目录」——本地那份写「13」，是 v0.10.0 时代的旧值，本仓实际就是 14 个 skill，上游正确。
3. **本地平台补丁整文件取回 HEAD**：14 个文件（`scripts/` 10 个 + `skills/story-setup/references/templates/hooks/` 4 个）。取证前提是 `git diff --name-status v0.10.3 origin/main` 对这些路径为空，即上游本轮一个字没动，整文件回滚安全。
4. **重新 vendored**：`sync-skills.mjs` 落 435 个文件，`check-parity` 报逐字节一致；副本侧实际变化 4 个文件（`story/assets/app.js`、`styles.css`、`story-short-analyze/references/output-contract.md`、`stage2-3-structure-emotion.md`）。
5. **插件升 0.2.7**（`package.json` / `lib/index.js` 的 `VERSION` / `README.md` 三处一致），README 补 v0.2.7 段；兼容基线不动（DSH 0.2.1-rc.5，peer `^0.2.0-rc.2`）。
6. **死链纳入验收**：本轮把「README/README_EN 的 docs 链接零死链 + 全仓 md 相对链接零死链」当成手工验收项跑了一遍（0 条），但**没有**加进守卫脚本。

## Alternatives considered

- **维持原白名单，只同步那 7 个文件。**
  最强理由：与前三轮完全一致，`docs/` 一直是刻意排除的——它含 fork 本地 DSH 文档，纳入白名单会让「哪些 docs 属于上游、哪些属于 fork」这件事从「目录级」退化成「文件级」，边界更容易出错。
  为何不用：排除的初衷其实是 `docs/agents`、`docs/research`、`docs/bug-reports` 这三个本地子树，不是要冻结整个 `docs/`；继续冻结的代价已经具体到「README 6 条死链 + 6 份文档落后一个版本」，而 `git checkout` 的不删除语义正好把「本地子树保留」这件事变成免费的。

- **把 `docs/` 做镜像同步（先清后取，或 `git read-tree` 覆盖）。**
  最强理由：镜像语义最干净——本地 docs 与上游 docs 逐字节一致，任何「上游删了但本地还留着」的陈旧文件都会被自动清掉。
  为何不用：会直接删掉 7 份 fork 专属文档（`docs/agents/` 3 份、`docs/research/` 3 份、`docs/bug-reports/` 1 份），而它们正是这个 fork 存在的理由；为了顺带清陈旧文件而丢本地资产，代价与收益不成比例。

- **本轮顺手把 Dashboard 的 e2e 也跑一遍再提交。**
  最强理由：改了产品代码（`app.js` 的表格渲染）却只跑静态守卫，等于把验证完全外包给上游 CI。
  为何不用：本机 `node_modules` 与 playwright 都没装，`npm run test:dashboard:e2e` 跑不起来；临时 `npm i` 会往工作树里塞几百 MB 依赖且与本轮改动无关。改为在笔记里显式记下「两个新 e2e 用例本地未验证，由 CI 的 `dashboard.yml` 覆盖」。

- **把「README 链接零死链」写进 `scripts/` 做成守卫。**
  最强理由：这 6 条死链存在了很久没人发现，正是缺守卫的典型。
  为何不用：新增守卫要同步 CI workflow、CONTRIBUTING 与 `scripts/README.md`，属于独立改动；夹在一次内容同步里会让提交主题变糊。已记进 Consequences 作为后续项。

## Consequences

收益：

- 上游 4 个修补提交的内容全部落地：Dashboard 表格预览修复（含 `markdownTableCells` 的 `\\` / `\|` 转义处理）、`story-short-analyze` 的清单单份化文案、`.clawhub/publish.json` 的版本与 digest、`demo/` 样例。
- `docs/` 一次性追平并补齐 6 份缺失文档，README / README_EN 的 **14 + 7 条 docs 链接零死链**，全仓 md 相对链接扫描 0 条死链。
- `tests/` 与上游对齐（新增 2 个 e2e 用例），Dashboard 修复在仓内有对应回归。
- 验收全绿：根目录 13 条守卫、七端适配器 8 条、`test-doc-budget` / `test-opencode-plugin`、插件四项（manifest / 14 项变异回归 / parity 435 文件 / 35 项工具测试）。

代价与风险：

- **白名单边界变细了**：「本地 docs 子树能保留」依赖 `git checkout <ref> -- <path>` 的不删除语义。若将来有人把它换成镜像式同步（`rsync --delete`、`git read-tree -u`、先 `rm -rf docs` 再取），会静默抹掉 fork 专属的 7 份文档——没有任何守卫会拦。
- `docs/hosts.md` 等文件从此按上游走；将来若确实需要为 fork 改一句（例如插件侧的目录数），这处改动会在下次同步时被覆盖，必须像 5 个 hook 补丁那样先登记、再在同步时回贴。
- `.clawhub/publish.json` 声称的是上游 digest，而 `skills/story-setup` 带着本 fork 的 5 处 hook 修复，两者本来就不严格对应；本轮沿用（本仓无 digest 计算脚本、无守卫交叉校验）。
- 两个新 e2e 用例本地未验证（无 node_modules / playwright），信任上游 CI。
- 「README 死链」这次是手工跑的，没有守卫；下次新增文档漏改链接仍然不会红。