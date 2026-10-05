# dsh-oh-story-claudecode

把 [oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode) 的网文写作能力搬进
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件。

> **当前状态：v0.2.1** —— 13 个 skill 随包交付（vendored + parity 校验，#7）；写作闭环核心的确定性
> 脚本封装为 8 个 `oh_story_*` 工具（#8）；本机装机的两种 spec、真实业务结果与边界补测见
> [`docs/verification/2026-10-05-machine-smoke.md`](docs/verification/2026-10-05-machine-smoke.md)。
>
> **想直接跑一遍**：[`examples/minimal/README.md`](examples/minimal/README.md)（从零到一条真实业务结果，
> 每条命令都在本机实跑过）。

## 它是什么

- 一个**本地可安装的 DSH 插件子包**，独立于本仓库的其它部分（不进 workspace，根 `package.json` 零改动）。
- 装配方式：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` 往 profile 组合树里插一行。
- 依赖由 DSH 宿主提供（`@deepseek-ai/dsh-skill-filesystem`），本包不安装它们。
- 策略是**薄封装**：业务判定全部由原脚本给出，插件只负责解释器探测、路径/参数校验、结构化信封与审批闸门。

## 装了什么

```
packages/dsh-plugin/
├── package.json          # 清单：dsh.bundle.patch、peerDependencies、engines、types、files
├── cordis.patch.yml      # 装配层：往 profile 组合树里 insert 本插件一行
├── lib/
│   ├── index.js          # cordis 插件入口：apply(ctx) —— 注册工具 + 挂载随包 skills
│   ├── index.d.ts        # 宿主装配面的类型声明（name / inject / apply / HostContext / Envelope）
│   ├── runtime/          # 内部实现：解释器探测、子进程、审批闸门、信封、文件防护
│   └── tools/            # 每个工具一个模块（oh_story_* 系列）
├── scripts/
│   ├── check-parity.mjs  # skills 副本与根 skills 的逐字节校验（#7）
│   ├── sync-skills.mjs   # 同步 vendored skills（#7）
│   └── test-tools.mjs    # 工具面测试：真实业务结果 + 全部错误路径（#8 / #9）
├── skills/               # 13 个 skill 的 vendored 副本（与根 skills/ 逐字节一致）
├── examples/minimal/     # 最小示例（#11，不进 tgz）
├── docs/verification/    # 装机验收留档与逐字原始输出（#9，不进 tgz）
└── README.md
```

## 环境要求与依赖

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DSH | `0.2.0-rc.2` 系列（实测版本） | 唯一被强制的依赖是 `peerDependencies` 里的 `@deepseek-ai/dsh-skill-filesystem`（宿主提供，本包不装） |
| Node | ≥ 24（`engines.node`） | 三个检测器是 Node 脚本；PATH 里没有 `node` 时回退**宿主内置 Node**（Electron-as-node） |
| Python | 3.x | 探测链 `python3 → python → py -3`，每个候选**实跑** `-c ""` 验证；**自动跳过 Microsoft Store 占位程序**（本机 `python3` exit 9009，落到 `python`） |
| OS | 实测 Windows；脚本本身跨平台 | `dsh plugin` 是 pnpm 转发（随 DSH 自带） |

要点：

- 解释器只在**工具调用时**探测，结果随信封的 `env` 字段返回；`oh_story_env` 是集中查看入口。
- 缺 Python → 字数/chapter 工具返回 `PYTHON_UNAVAILABLE`（错误码 + 人话 + 下一步）；缺 Node → 三个检测器返回 `NODE_UNAVAILABLE`。
- 想强制指定解释器：`OH_STORY_PYTHON` / `OH_STORY_NODE`（配错即报错，不静默回退）；`OH_STORY_DISABLE_HOST_NODE=1` 关掉宿主 Node 回退。

## 工具面

| 工具 | 只读 / 破坏性 | 做什么 |
| --- | --- | --- |
| `oh_story_env` | 只读 | Python（python3→python→py -3，跳过 Store 占位）与 Node 探测链 + 随包脚本落点诊断 |
| `oh_story_wordcount` | 只读 | 字数口径 visible_chars_v1（measure / check / checkpoint） |
| `oh_story_chapter_check` | 默认只读；`fixPunctuation=true` 破坏性（审批） | storyctl chapter check 完整写后检查 |
| `oh_story_chapter_commit` | 破坏性（独立工具名 + 审批，不幂等） | storyctl chapter commit；事务过期给「重新 draft」的下一步 |
| `oh_story_ai_patterns_check` | 只读 | check-ai-patterns.js：AI 味句式扫描 |
| `oh_story_degeneration_check` | 只读 | check-degeneration.js：退化信号扫描 |
| `oh_story_punctuation_normalize` | 默认只读；`fix=true` 破坏性（审批） | normalize-punctuation.js：机械标点归一 |
| `oh_story_probe` | 只读 | 装机探针：插件名/版本/skills 挂载状态/**工具面此刻在册几个**（#9 起在调用时回读注册表 —— `register()` 成功 ≠ 工具在册） |

安全语义（#12 裁决）：**默认只读**，破坏性动作必须显式开关并走**人工审批**（`ctx.approval.request`）；
审批通道不可用时回退显式 `confirm: true`（如实标注，非人工审批）。`chapter commit` 不幂等：同份事务
JSON 重跑必失败，工具返回 `TRANSACTION_STALE` 并给出「重新 `tracking_commit.py draft` 再提交」的下一步。

所有工具返回统一信封：`{ ok, tool, command, exitCode, status, env, counts?, result, stdout, stderr,
sideEffects, approval?, error?, notes }`。**`ok` = 这次调用有没有拿到有效业务结果，不是业务判定通过**：
`chapter check` 返回 `status: "blocked"` 或检测器返回 `findings` 时 `ok` 仍为 `true`，判定写在
`status` / `result` 里。`sideEffects` 如实记录本次调用对用户文件的落盘影响（如超长章的
`over_length_baseline.json`）。

## 安装

### A. 本地路径 spec（开发/迭代用）

```powershell
dsh plugin --profile <profile> add "<本目录的绝对路径>"
```

实测输出：

```
dependencies:
+ dsh-oh-story-claudecode link:D:/DS/插件/oh-story-claudecode/packages/dsh-plugin

Already up to date
Done in 365ms using pnpm v11.7.0
```

### B. tgz spec（把包交给别人 / 归档用）

```powershell
cd <本目录>
npm pack --pack-destination <输出目录>
dsh plugin --profile <profile> add "<输出目录>\dsh-oh-story-claudecode-0.2.1.tgz"
```

实测输出（`npm pack`）：

```
npm notice filename: dsh-oh-story-claudecode-0.2.1.tgz
npm notice package size: 1.8 MB
npm notice unpacked size: 5.9 MB
npm notice shasum: <每次 pack 都不同：README.md 自己也在包里>
npm notice total files: 493
```

> `shasum` 没法写死在文档里——`README.md` 本身就在包里，任何一次文档改动都会改变它。要校验完整性，
> 就用**同一次** `npm pack` 打印的那个值。（`examples/minimal/README.md` 不在包里，所以那里带具体值示例。）

> ⚠️ 路径必须**绝对**，DSH 拒绝相对路径。装完 DSH 会把本包写进 profile 的 `dependencies` 与
> `dsh.profile.bundles`，并重新组合（`dsh <profile> --dump-config` 里能看到 `# == dsh-oh-story-claudecode` 那一行）。
> 在全新 profile 上装 tgz 时 pnpm 会报一句 peer dependency 警告（`@deepseek-ai/dsh-skill-filesystem`
> 不在该 profile 的 `node_modules` 里）——**不阻塞**：宿主侧解析成功，skills 挂载与 8 个工具实测正常（#9）。

### 安装后怎么确认

新开会话（或直接 `dsh <profile> "任务"`），先调 `oh_story_probe`，期望：

```
工具面：装配 8 个 / register 成功 8 个 / 此刻在册 8 个
```

「此刻在册 8 个」是**调用时回读宿主注册表**的结果——这一个数字就能判定装没装好。若少于 8，
`toolSurface.missing` / `toolSurface.failures` 会点名是哪些、为什么。

### 重启铁律

**改了 `lib/` 下任何文件，必须重启 DSH 才生效**——运行中的进程缓存已加载的 JS 模块，
HMR 只热加新条目、不热换已有模块（wayfinder #5/#9 两次实测）。

## 卸载

```powershell
dsh plugin --profile <profile> remove dsh-oh-story-claudecode
```

清单与组合树会复原（`--dump-config` 里插件行零残留），但**物理残留两种形态行为不同**（均实测）：

| 安装形态 | `remove` 之后 | 需要手工清吗 |
| --- | --- | --- |
| 本地路径（`link:`） | `node_modules\dsh-oh-story-claudecode` 仍是 **Junction** 指向仓库 | 需要：`cmd /c rmdir "<profile>\node_modules\dsh-oh-story-claudecode"` |
| tgz（`file:`） | 安装副本被一并删除，无残留 | 不需要 |

## 调用示例

最小可复制的一步（详见 [`examples/minimal/README.md`](examples/minimal/README.md)）：

```powershell
dsh <profile> '调 oh_story_chapter_check，参数 project="<书目录>"、chapter=21，把返回原文打印出来。'
```

期望输出（实测片段）：`OK oh_story_chapter_check（status: ready）` / `退出码：0` / `落盘副作用：无` /
`actual: 2068`（示例书第 21 章）。**注意 prompt 压成单行**：`dsh` 的 task 参数按行截断。

## 测试与守卫

在子包目录下：

| 命令 | 覆盖 | 最近一次实测 |
| --- | --- | --- |
| `node scripts/test-tools.mjs` | 35 项：A 组装配通路 + 真实业务结果（demo 书/正文）；B 组全部错误路径（Python/Node 不可用、脚本缺失、审批拒绝/不可用、事务过期…）；信封形状逐项校验 | `工具面测试：35 项，0 项失败。` |
| `node scripts/check-parity.mjs` | `skills/` 副本与仓库根 `skills/` 逐字节一致（绿 / 人为注入即红 / 还原复绿） | `[check-parity] 一致：465 个文件逐字节相同。` |
| `npx --yes -p typescript@5 tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext examples/types/consumer.ts` | `lib/index.d.ts` 的类型声明可用（编译期契约检查，不运行） | 退出码 0（反例见「类型声明」一节） |
| `node scripts/sync-skills.mjs` | 从根 `skills/` 同步 vendored 副本（`--check` 只读） | — |

（`package.json` 里有 `test:tools` / `test:parity` / `test:types` 三个 npm script 别名，前提是 PATH 里有 `pnpm` 或 `npm`。）

仓库级守卫（根目录，`bash` + `python` 环境见仓库 `AGENTS.md`）：`scripts/static-check.sh`、
`scripts/check-doc-budget.sh`、`scripts/check-shared-files.sh`、`scripts/check-current-skill-contracts.sh`、
`scripts/check-python-invocation.sh`、`scripts/check-agent-notes.py`、`scripts/check-plugin-packaging.py`
——本子包对它们零影响（#10 逐个扫描面取证），上述七条在 #11 收尾时全绿。

## 类型声明

[`lib/index.d.ts`](lib/index.d.ts)（`package.json` 的 `types` 字段）只声明**对外契约**：

- 插件导出：`name` / `inject` / `apply(ctx, config?)`；
- `HostContext`：宿主 `ctx` 的最小结构（成员全部可选——宿主不提供能力时插件降级而非激活失败）；
- `ToolDefinition` / `ToolOutput`：`ctx.tools.register` 的入参形状；
- `Envelope<Result>`：`oh_story_*` 工具的统一返回值。

`lib/runtime/*`、`lib/tools/*` 是包内私有实现，**有意不声明**（内部重构不该逼调用方改类型）。
本包是纯 JS，无构建步骤；`.d.ts` 手写并与 `lib/index.js` 同步维护。

**怎么验**（本机无 TS 工具链，用 `npx` 现拉一个；实测 tsc 5.9.3 通过）：

```powershell
cd packages/dsh-plugin
npx --yes -p typescript@5 tsc --noEmit --strict --target es2022 `
  --module nodenext --moduleResolution nodenext examples/types/consumer.ts
```

[`examples/types/consumer.ts`](examples/types/consumer.ts) 只做编译期检查、不运行：它按真实用法 import
`name` / `inject` / `apply` 与 `Envelope` / `HostContext` 等类型，等于一条**契约检查**（名字对不上、
必填字段少了、类型错了都会红）。反向验证过：故意漏必填字段与把 `approval.outcome` 写成数字，
分别得到 `TS2740`（缺 8 个必填属性）与 `TS2322`（number 不能赋给 string），退出码 2。

## 已知限制与假设

**限制**

- 只在本 fork 推进，不回提上游；不发布 npm，只支持本地路径 / tgz 安装。
- 不做 client 侧 UI（不声明 `dsh.client`）。
- `engines.dsh` 这类字段不被 DSH 强制校验；真正被强制的是 `peerDependencies` 里 `@deepseek-ai/dsh*` 的范围。
- skills 副本**不纳入**仓库根的热路径文档守卫；漂移由 `test:parity` / CI 负责。
- 破坏性工具的并发保护是**进程内**的（原脚本无锁，跨进程并发不在本插件范围内解决）。
- `chapter accept-current-length` 未封装（#8 范围外）。

**假设（显式标注）**

- **进 tgz 的只有** `lib/`（含 `index.d.ts`）、`skills/`、`cordis.patch.yml`、`README.md`；
  `examples/` 与 `docs/` 只在本仓提供（它们依赖仓库里的 `demo/` 样书与相对链接，进了 tgz 也用不上）。
- 本 README 里指向 `../../docs/...`、`../../.agents/notes/...` 的链接**只在仓库内有效**。
- 文档里的版本号、文件数、shasum 都是**实测值**，随代码变化；换代码后请重新 `npm pack` 并更新。
- 安装/卸载、工具调用、边界行为的实测环境：DSH `0.2.0-rc.2` · Node `v24.20.0` · Python `3.14.7`（Windows）。

## 依据

规范结论来自本机实测，见仓库内 [`docs/research/dsh-plugin-spec.md`](../../docs/research/dsh-plugin-spec.md)
与 [`docs/research/story-script-contracts.md`](../../docs/research/story-script-contracts.md)。
结构决策见 [`.agents/notes/implemented/architecture/2026-10-03-dsh-plugin-package-layout.md`](../../.agents/notes/implemented/architecture/2026-10-03-dsh-plugin-package-layout.md)；
工具安全语义见 [`.agents/notes/implemented/architecture/2026-10-04-dsh-plugin-tool-safety-semantics.md`](../../.agents/notes/implemented/architecture/2026-10-04-dsh-plugin-tool-safety-semantics.md)；
工具面契约见 [`.agents/notes/implemented/architecture/2026-10-05-dsh-plugin-tool-surface.md`](../../.agents/notes/implemented/architecture/2026-10-05-dsh-plugin-tool-surface.md)；
装机事故与修法见 [`.agents/notes/implemented/bug-fix/2026-10-05-dsh-plugin-tool-registration-effect.md`](../../.agents/notes/implemented/bug-fix/2026-10-05-dsh-plugin-tool-registration-effect.md)。
