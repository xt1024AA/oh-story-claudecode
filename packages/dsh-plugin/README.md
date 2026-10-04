# dsh-oh-story-claudecode

把 [oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode) 的网文写作能力搬进
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件。

> **当前状态：骨架原型（wayfinder #5）**
> 这一版只有一个假工具和一个占位 skill，用途是把「装得上、装配生效、工具可调用、自带 skill 被发现」
> 这条通路先跑通。真正的 13 个写作 skill 与确定性工具在后续票（#6 / #7 / #8）里落地。

## 它是什么

- 一个**本地可安装的 DSH 插件子包**，独立于本仓库的其它部分（不进 workspace，根 `package.json` 零改动）。
- 装配方式：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` 往 profile 组合树里插一行。
- 依赖由 DSH 宿主提供（`@deepseek-ai/dsh-skill-filesystem`），本包不安装它们。

## 目录结构

```
packages/dsh-plugin/
├── package.json          # 清单：dsh.bundle.patch、peerDependencies、engines
├── cordis.patch.yml      # 装配层：往 profile 组合树里 insert 本插件一行
├── lib/
│   └── index.js          # cordis 插件入口：apply(ctx) —— 注册工具 + 挂载随包 skills
├── skills/
│   └── dsh-probe/
│       └── SKILL.md      # 占位 skill，只验证「自带 skills 能被发现」
└── README.md
```

## 安装

在 DSH 所在机器上：

```bash
dsh plugin --profile desktop add <本目录的绝对路径>
```

> ⚠️ **必须传绝对路径**。DSH 明确拒绝相对路径。

安装后 DSH 会把本包加进 profile 的 `dependencies` 与 `dsh.profile.bundles`，并重新组合。
`desktop` profile 由 Desktop shell 持有，**替换同名包需要重启进程**才会加载新的 JS 模块。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-oh-story-claudecode
```

## 验证

装好后新开一个会话，看两件事：

1. **工具**：工具面里应出现 `oh_story_probe`，调用它（可传 `echo`）应返回插件名、版本、
   随包 skills 目录路径与存在性。
2. **skill**：`dsh-probe` 应能被发现并触发。

## 已知限制与假设

- **只在本 fork 推进**，不回提上游。
- 不发布 npm，只支持本地路径 / tgz 安装。
- 不做 client 侧 UI（不声明 `dsh.client`）。
- `engines.dsh` 这类字段不被 DSH 强制校验；真正被强制的是 `peerDependencies` 里
  `@deepseek-ai/dsh*` 的范围。
- 本包的 skills 副本**不纳入**仓库根的热路径文档守卫；副本与源的漂移由后续的 parity 校验负责（#7）。
  在该 parity 校验落地前，这里存在一个「守卫空白窗口期」。

## 依据

规范结论来自本机实测，见仓库内 [`docs/research/dsh-plugin-spec.md`](../../docs/research/dsh-plugin-spec.md)。
结构决策见 [`.agents/notes/proposed/architecture/2026-10-03-dsh-plugin-package-layout.md`](../../.agents/notes/proposed/architecture/2026-10-03-dsh-plugin-package-layout.md)。