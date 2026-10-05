# dsh-oh-story-claudecode

把 [oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode) 的网文写作能力搬进
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件。

> **当前状态：写作工具面落地（wayfinder #8）**
> 13 个 skill 随包交付（vendored + parity 校验，见 #7）；写作闭环核心的确定性脚本已封装为
> `oh_story_*` 工具（#8）。装机自检用 `oh_story_probe` / `oh_story_env`。

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
│   ├── index.js          # cordis 插件入口：apply(ctx) —— 注册工具 + 挂载随包 skills
│   ├── runtime/          # 运行时：解释器探测、子进程、审批闸门、信封、文件防护
│   └── tools/            # 每个工具一个模块（oh_story_* 系列）
├── scripts/
│   ├── check-parity.mjs  # skills 副本与根 skills 的逐字节校验（#7）
│   ├── sync-skills.mjs   # 同步 vendored skills（#7）
│   └── test-tools.mjs    # 工具面测试：真实业务结果 + 全部错误路径（#8）
├── skills/               # 13 个 skill 的 vendored 副本（与根 skills/ 逐字节一致）
└── README.md
```

## 工具面（#8）

| 工具 | 只读 / 破坏性 | 做什么 |
| --- | --- | --- |
| `oh_story_env` | 只读 | Python（python3→python→py -3，跳过 Store 占位）与 Node 探测链 + 随包脚本落点诊断 |
| `oh_story_wordcount` | 只读 | 字数口径 visible_chars_v1（measure / check / checkpoint） |
| `oh_story_chapter_check` | 默认只读；`fixPunctuation=true` 破坏性（审批） | storyctl chapter check 完整写后检查 |
| `oh_story_chapter_commit` | 破坏性（独立工具名 + 审批，不幂等） | storyctl chapter commit；事务过期给「重新 draft」的下一步 |
| `oh_story_ai_patterns_check` | 只读 | check-ai-patterns.js：AI 味句式扫描 |
| `oh_story_degeneration_check` | 只读 | check-degeneration.js：退化信号扫描 |
| `oh_story_punctuation_normalize` | 默认只读；`fix=true` 破坏性（审批） | normalize-punctuation.js：机械标点归一 |
| `oh_story_probe` | 只读 | 装机探针（#5 保留）：插件名/版本/skills 挂载状态/**工具面此刻在册几个**（#9 起在调用时回读注册表——`register()` 成功 ≠ 工具在册） |

安全语义（#12 裁决）：**默认只读**，破坏性动作必须显式开关并走**人工审批**
（`ctx.approval.request`）；审批通道不可用时回退显式 `confirm: true`（如实标注，非人工审批）。
`chapter commit` 不幂等：同份事务 JSON 重跑必失败，工具返回 `TRANSACTION_STALE` 并给出
「重新 `tracking_commit.py draft` 再提交」的下一步。

所有工具返回统一信封：`{ ok, tool, command, exitCode, status, env, result, stdout, stderr,
sideEffects, approval, error, notes }`；`result` 是原脚本 JSON 原样，`sideEffects` 如实记录
本次调用对用户文件的落盘影响（如超长章的 `over_length_baseline.json`）。

## 安装

在 DSH 所在机器上：

```bash
dsh plugin --profile desktop add <本目录的绝对路径>
```

> ⚠️ **必须传绝对路径**。DSH 明确拒绝相对路径。

安装后 DSH 会把本包加进 profile 的 `dependencies` 与 `dsh.profile.bundles`，并重新组合。
`desktop` profile 由 Desktop shell 持有，**替换同名包需要重启进程**才会加载新的 JS 模块
（改了 `lib/` 下任何文件都必须重启 DSH 才生效，HMR 不热换已加载模块）。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-oh-story-claudecode
```

## 验证

1. **工具**：新开会话，工具面应出现 `oh_story_*` 系列；先跑 `oh_story_env` 看解释器与脚本落点。
2. **skill**：13 个 `story-*` skill 应能被发现（rank 600，bundledSkillDir）。
3. **测试**：`pnpm test:tools`（本子包内）跑真实业务结果 + 全部错误路径的回归。

## 已知限制与假设

- **只在本 fork 推进**，不回提上游。
- 不发布 npm，只支持本地路径 / tgz 安装。
- 不做 client 侧 UI（不声明 `dsh.client`）。
- `engines.dsh` 这类字段不被 DSH 强制校验；真正被强制的是 `peerDependencies` 里
  `@deepseek-ai/dsh*` 的范围。
- 本包的 skills 副本**不纳入**仓库根的热路径文档守卫；漂移由 `test:parity` / CI 负责。
- 破坏性工具的并发保护是**进程内**的（原脚本无锁，跨进程并发不在本插件范围内解决）。
- `chapter accept-current-length` 未封装（#8 范围外，见 issue 备注）。

## 依据

规范结论来自本机实测，见仓库内 [`docs/research/dsh-plugin-spec.md`](../../docs/research/dsh-plugin-spec.md)
与 [`docs/research/story-script-contracts.md`](../../docs/research/story-script-contracts.md)。
结构决策见 [`.agents/notes/implemented/architecture/2026-10-03-dsh-plugin-package-layout.md`](../../.agents/notes/implemented/architecture/2026-10-03-dsh-plugin-package-layout.md)。
工具安全语义见 [`.agents/notes/implemented/architecture/2026-10-04-dsh-plugin-tool-safety-semantics.md`](../../.agents/notes/implemented/architecture/2026-10-04-dsh-plugin-tool-safety-semantics.md)。
