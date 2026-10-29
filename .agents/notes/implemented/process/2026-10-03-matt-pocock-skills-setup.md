# Agent Note: matt-pocock skills repo setup

Status: implemented

## Problem

仓库装了 setup-matt-pocock-skills 这一套工程技能，但仓库里没有它们约定读取的配置：没有 `docs/agents/issue-tracker.md` / `triage-labels.md` / `domain.md`，`AGENTS.md` 也没有 `## Agent skills` 块。`triage`、`wayfinder` 这些技能按约定找不到配置时会直接要求用户重跑 setup，且 GitHub 上缺 triage 五角色与 wayfinder 五个标签。

## Decision

配置落 `docs/agents/` 三件套，`## Agent skills` 块加在根 `AGENTS.md` 末尾（`CLAUDE.md` 只有 `@AGENTS.md` 一行，是引用文件，不重复写块）。issue tracker 选 GitHub Issues，用 `gh` CLI，`PRs as a request surface` 保持 `no`。triage 标签保留默认五角色，label 字符串与角色名 1:1：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。域文档布局定为 multi-context：根 `CONTEXT-MAP.md` 作唯一索引，指向各子项目自己的 `CONTEXT.md`，`docs/adr/` 收系统级决策，子项目决策落各自的 `<subproject>/docs/adr/`。GitHub 侧补齐 9 个缺失标签（`wontfix` 已存在）：triage 四个加 wayfinder 的 `wayfinder:map` / `research` / `prototype` / `grilling` / `task`。`CONTEXT-MAP.md` 与各子项目 `CONTEXT.md` 本次不建，沿用 `docs/agents/domain.md` 的懒创建规则，第一次真正写下词条时才建。

## Alternatives considered

- 把 `## Agent skills` 块写进 `CLAUDE.md`：技能选择规则是「`CLAUDE.md` 存在就改它」，但本仓库的 `CLAUDE.md` 只有 `@AGENTS.md` 一行，块写进去会把引用文件变成双份真源，后续任何一边改动都会静默漂移；`AGENTS.md` 才是被导入的那份。
- 域文档用 single-context（仓库根一份 `CONTEXT.md`）：改动最少，也和技能默认一致；但本仓库是 13 个 skill 加 `scripts/`、`demo/` 的多块结构，各块词汇独立演化，一份根 glossary 会混在一起，反而让「用词以 glossary 为准」这条规则失去意义。
- 域文档布局随初始化就建 `CONTEXT-MAP.md` 与各子项目 `CONTEXT.md`：文件齐了看起来更完整；但没有词条的 glossary 是空壳，技能约定就是词与决策真正落定时才建，空文件只会诱导往里面填臆造的词。

## Consequences

`triage` / `wayfinder` / `to-tickets` / `to-spec` / `code-review` 现在能自行解析出 tracker、标签词汇与域文档布局，不再提示用户重跑 setup。代价是新增一份需要与 GitHub 远端标签同步的仓库外事实：本地删标签不会反映到这里，反之亦然，所以 `issue-tracker.md` 末尾加了一句要求运行 `/triage` 或 `/wayfinder` 前先核对标签齐全。`docs/agents/` 是机器契约，不写英文对照版。域文档布局一旦定了，后续任何 glossary 都要顺着 multi-context 走，改回 single-context 得删 `CONTEXT-MAP.md` 并把词并回根。
