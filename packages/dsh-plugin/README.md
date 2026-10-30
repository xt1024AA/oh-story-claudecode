# dsh-oh-story-claudecode

把 [oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode) 的网文写作能力搬进
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件。

> **当前状态：v0.2.4** —— 14 个 skill 随包交付（vendored + parity 校验，#7）；写作闭环核心的确定性
> 脚本封装为 8 个 `oh_story_*` 工具（#8）；本机装机的两种 spec、真实业务结果与边界补测见
> [`docs/verification/2026-10-05-machine-smoke.md`](docs/verification/2026-10-05-machine-smoke.md)。
>
> **v0.2.4 跟上 DSH `0.2.1-rc.5`**：兼容基线 `SUPPORTED_RUNTIMES` 增加 `0.2.1-rc.5`（本机在用的运行时），
> 在该版本上复验 `oh_story_probe`「此刻在册 8 个」与 35 项工具面测试全绿；`peerDependencies` 的
> `^0.2.0-rc.2` 一个字没改就已覆盖它。
>
> **v0.2.3 跟上上游 v0.9.2**：随包 skill 由 13 个变 14 个，新增 `story-publish`（书名 / 简介 / 主角名 / 分类 / 标签的番茄建书资料，长篇与短故事两套）；skills 全量重新 vendored，`npm test` 的 manifest / manifest-guard / parity / 35 项工具测试全绿。
>
> **v0.2.2 修的是「DSH 升到 0.2.1-rc.2 后整包被跳过」**：`peerDependencies` 原先是精确的预发布版本
> `0.2.0-rc.2`，而宿主用 `semver.satisfies(runtime, range, { includePrerelease: true })` 判兼容 ——
> 精确版本只匹配它自己，于是新运行时下**整个组合包被静默跳过**（只打一行 stderr，profile 其余部分照常启动，
> 插件就像没装过一样）。现改成范围 `^0.2.0-rc.2`，并新增 `scripts/check-manifest.mjs` 把这类事故挡在提交前。
> 取证与机制见 [`docs/verification/2026-10-18-dsh-0.2.1-compat.md`](docs/verification/2026-10-18-dsh-0.2.1-compat.md)。
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
├── icon.svg              # 设置页/插件管理器的图标（宿主 readPluginMeta 读 ./icon）
├── locale/               # 显示元数据：en.json（宿主解析锚点）+ zh.json，各含 meta.title/description
├── lib/
│   ├── index.js          # cordis 插件入口：apply(ctx) —— 注册工具 + 挂载随包 skills
│   ├── index.d.ts        # 宿主装配面的类型声明（name / inject / apply / HostContext / Envelope）
│   ├── runtime/          # 内部实现：解释器探测、子进程、审批闸门、信封、文件防护
│   └── tools/            # 每个工具一个模块（oh_story_* 系列）
├── scripts/
│   ├── check-manifest.mjs       # 清单与 DSH 兼容性自检（0.2.2 新增，见「为什么要有清单自检」）
│   ├── test-manifest-guard.mjs  # 上面那个守卫的变异回归（14 项）
│   ├── check-parity.mjs  # skills 副本与根 skills 的逐字节校验（#7）
│   ├── sync-skills.mjs   # 同步 vendored skills（#7）
│   └── test-tools.mjs    # 工具面测试：真实业务结果 + 全部错误路径（#8 / #9）
├── skills/               # 14 个 skill 的 vendored 副本（与根 skills/ 逐字节一致）
├── examples/minimal/     # 最小示例（#11，不进 tgz）
├── docs/verification/    # 装机验收留档与逐字原始输出（#9，不进 tgz）
└── README.md
```

## 为什么要有清单自检（`scripts/check-manifest.mjs`）

**0.2.1 在 DSH `0.2.1-rc.2` 上根本没装载，而当时的 34 项工具测试、parity、类型检查、`npm pack` 全绿** ——
因为没有任何一步读过「宿主怎么判兼容」。宿主 `dsh-app-boot` 的判定规则是：

1. `package.json` 里**有 `engines.dsh` 就只看它**，`peerDependencies` 全部被忽略；
2. 否则逐个校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer 范围；
3. 匹配用 `semver.satisfies(runtime, range, { includePrerelease: true })`；
4. 判不兼容时：组合包**被跳过**（进 `skippedBundles`，stderr 一行 `dsh: skipping profile bundle "..."`），
   profile 其余部分组成；普通行则变成游离的 `disabled: true` 行。

于是「精确预发布版本」（如 `0.2.0-rc.2`）是一颗定时炸弹：它只匹配它自己，DSH 一升小版本整包就消失。
`scripts/check-manifest.mjs` 因此守四件事（`pnpm test:manifest`）：

| 守什么 | 具体规则 |
| --- | --- |
| 兼容性 | 拒绝精确版本号的 peer；peer 必须是范围，且必须覆盖 `SUPPORTED_RUNTIMES` 里的每个基线运行时；**拒绝 `engines.dsh`**（它会让 peer 保护失效） |
| 一致性 | `lib/index.js` 的 `VERSION`、`cordis.patch.yml` 的行 id/name、包名三处相同；版本号必须是精确 SemVer |
| 可装载的形状 | `dsh.bundle.patch` 指向存在文件；`exports`/`files` 覆盖 `locale` 与 `icon`；icon ≤256 KiB 且格式被接受 |
| 随包 skills | 每个 `skills/<name>/SKILL.md` 的 frontmatter 满足宿主硬要求（kebab-case `name` + 非空 `description`，且 `name` 与目录名一致） |

守卫的解析器**刻意 fail-closed**：语法超出它支持的子集（`^` / `~` / `>=` / `<` / `||` / `X.Y.x`）就直接报错，
不做「看不懂就放行」。`scripts/test-manifest-guard.mjs`（`pnpm test:manifest-guard`，14 项）把 0.2.1 事故
与其它的复现形态逐个造出来，断言守卫**确实变红**，再还原复绿——一个只会打印 ok 的守卫等于没有守卫。

**升级 DSH 后请先跑 `pnpm test:manifest`**：它会告诉你当前 peer 范围是否覆盖新运行时。不覆盖就改范围
（别加版本豁免：豁免只对精确 `name@version` 生效，插件升级与 DSH 升级都不继承）。

## 环境要求与依赖

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DSH | `^0.2.0-rc.2`（`0.2.0-rc.2`、`0.2.1-rc.2` 与 `0.2.1-rc.5` 实测） | 唯一被强制的依赖是 `peerDependencies` 里的 `@deepseek-ai/dsh-skill-filesystem`（宿主提供，本包不装）；范围必须覆盖你实际在用的运行时，详见上一节 |
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
dsh plugin --profile <profile> add "<输出目录>\dsh-oh-story-claudecode-0.2.4.tgz"
```

实测输出（`npm pack`，2026-10-18 v0.2.2）：

```
npm notice filename: dsh-oh-story-claudecode-0.2.2.tgz
npm notice package size: 1.8 MB
npm notice unpacked size: 6.0 MB
npm notice shasum: <每次 pack 都不同：README.md 自己也在包里>
npm notice total files: 498
```

> `shasum` 没法写死在文档里——`README.md` 本身就在包里，任何一次文档改动都会改变它。要校验完整性，
> 就用**同一次** `npm pack` 打印的那个值。（`examples/minimal/README.md` 不在包里，所以那里带具体值示例。）
> 包内已确认含 `locale/en.json`、`locale/zh.json`、`icon.svg`（`tar -tzf` 实测）。

> ⚠️ 路径必须**绝对**，DSH 拒绝相对路径。装完 DSH 会把本包写进 profile 的 `dependencies` 与
> `dsh.profile.bundles`，并重新组合（`dsh <profile> --dump-config` 里能看到 `# == dsh-oh-story-claudecode` 那一行）。
> 在全新 profile 上装 tgz 时 pnpm 会报一句 peer dependency 警告（`@deepseek-ai/dsh-skill-filesystem`
> 不在该 profile 的 `node_modules` 里）——**不阻塞**：宿主侧解析成功，skills 挂载与 8 个工具实测正常（#9）。

### 安装后怎么确认

**先看组合包有没有被兼容性闸门跳过**（v0.2.2 新增的第一步，0.2.1 就是在这一步静默失败的）：

```powershell
dsh <profile> --dump-config | Select-String "skipping profile bundle"
```

**必须没有任何输出**。一旦出现 `skipping profile bundle "dsh-oh-story-claudecode"`，说明 peer 范围没覆盖
当前 DSH 运行时——插件**根本没装载**，此时后面所有「工具面 8 个」的检查都会返回「工具不存在」。
修法：跑 `pnpm test:manifest` 看它点名哪个运行时，然后改 `peerDependencies` 的范围（别加版本豁免）。

确认没被跳过后，新开会话（或直接 `dsh <profile> "任务"`），调 `oh_story_probe`，期望：

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
| `node scripts/check-manifest.mjs` | **清单与 DSH 兼容性**（v0.2.2 新增）：peer 是范围且覆盖 `SUPPORTED_RUNTIMES` 每个基线、拒绝 `engines.dsh`、`VERSION`/包名/patch 行 id 三处一致、`exports`+`files` 覆盖 locale 与 icon、icon ≤256 KiB、14 个 skill 的 frontmatter 满足宿主硬要求 | `[check-manifest] 全部通过。` |
| `node scripts/test-manifest-guard.mjs` | 上面那个守卫的**变异回归**：把 0.2.1 事故等 13 种复现形态逐个造出来断言变红，再还原复绿（fail-closed 语法、包目录不存在也判红） | `清单守卫回归：14 项，0 项失败。` |
| `node scripts/test-tools.mjs` | 35 项：A 组装配通路 + 真实业务结果（demo 书/正文）；B 组全部错误路径（Python/Node 不可用、脚本缺失、审批拒绝/不可用、事务过期…）；信封形状逐项校验 | `工具面测试：35 项，0 项失败。` |
| `node scripts/check-parity.mjs` | `skills/` 副本与仓库根 `skills/` 逐字节一致（绿 / 人为注入即红 / 还原复绿） | `[check-parity] 一致：447 个文件逐字节相同。` |
| `npx --yes -p typescript@5 tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext examples/types/consumer.ts` | `lib/index.d.ts` 的类型声明可用（编译期契约检查，不运行） | 退出码 0（反例见「类型声明」一节） |
| `node scripts/sync-skills.mjs` | 从根 `skills/` 同步 vendored 副本（`--check` 只读） | — |

（`package.json` 里有 `test:manifest` / `test:manifest-guard` / `test:tools` / `test:parity` / `test:types` 的
npm script 别名，`npm test` 一次跑前四项；前提是 PATH 里有 `pnpm` 或 `npm`。）

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
- **兼容性只由 `peerDependencies` 里 `@deepseek-ai/dsh*` 的范围决定**；刻意**不写 `engines.dsh`**——
  宿主一旦看到 `engines.dsh` 就完全忽略 peer，这层保护会失效。`engines.node` 纯粹是声明，不被校验。
- 兼容闸门只判「能不能装」，**判不出 API 层面还对不对**：宿主升版后即使范围覆盖了，
  `ctx.tools.register` / `ctx.approval.request` / `skill-filesystem` 的选项仍可能变。升级后请跑
  `test:manifest` + `test:tools`，并在真机上用 `oh_story_probe` 确认「此刻在册 8 个」。
- 显示元数据（`locale/*.json` + `icon.svg`）**不是装载条件**：缺了宿主会回退到包名/默认图。
  本包补它只是为了设置页可读；`test:manifest` 会检查它的形状与 256 KiB 上限，因为越界会多出一条 metadata 诊断。
- skills 副本**不纳入**仓库根的热路径文档守卫；漂移由 `test:parity` / CI 负责。
- 破坏性工具的并发保护是**进程内**的（原脚本无锁，跨进程并发不在本插件范围内解决）。
- `chapter accept-current-length` 未封装（#8 范围外）。

**假设（显式标注）**

- **进 tgz 的只有** `lib/`（含 `index.d.ts`）、`skills/`、`locale/`、`icon.svg`、`cordis.patch.yml`、`README.md`；
  `examples/` 与 `docs/` 只在本仓提供（它们依赖仓库里的 `demo/` 样书与相对链接，进了 tgz 也用不上）。
- 本 README 里指向 `../../docs/...`、`../../.agents/notes/...` 的链接**只在仓库内有效**。
- 文档里的版本号、文件数、shasum 都是**实测值**，随代码变化；换代码后请重新 `npm pack` 并更新。
- 安装/卸载、工具调用、边界行为的实测环境：DSH `0.2.0-rc.2`（#9/#11 装机）、`0.2.1-rc.2`（v0.2.2 兼容性取证）与 `0.2.1-rc.5`（v0.2.3 同步复验）·
  Node `v24.20.0` / `v24.21.0` · Python `3.14.7`（Windows）。

## 依据

规范结论来自本机实测，见仓库内 [`docs/research/dsh-plugin-spec.md`](../../docs/research/dsh-plugin-spec.md)
（0.2.0-rc.2 基线）、[`docs/research/dsh-0.2.1-plugin-contract-delta.md`](../../docs/research/dsh-0.2.1-plugin-contract-delta.md)
（0.2.1-rc.2 变更）与 [`docs/research/story-script-contracts.md`](../../docs/research/story-script-contracts.md)。

> ⚠️ `dsh-plugin-spec.md` 里「`engines.dsh` 不被强制、peer 才是闸门」这半句在 0.2.1 已反转：
> 现在是「有 `engines.dsh` 就只看它，peer 全被忽略」。两份文档冲突时以 **delta 那份 + 宿主代码**为准。

结构决策见 [`.agents/notes/implemented/architecture/2026-10-03-dsh-plugin-package-layout.md`](../../.agents/notes/implemented/architecture/2026-10-03-dsh-plugin-package-layout.md)；
工具安全语义见 [`.agents/notes/implemented/architecture/2026-10-04-dsh-plugin-tool-safety-semantics.md`](../../.agents/notes/implemented/architecture/2026-10-04-dsh-plugin-tool-safety-semantics.md)；
工具面契约见 [`.agents/notes/implemented/architecture/2026-10-05-dsh-plugin-tool-surface.md`](../../.agents/notes/implemented/architecture/2026-10-05-dsh-plugin-tool-surface.md)；
装机事故与修法见 [`.agents/notes/implemented/bug-fix/2026-10-05-dsh-plugin-tool-registration-effect.md`](../../.agents/notes/implemented/bug-fix/2026-10-05-dsh-plugin-tool-registration-effect.md)；
**兼容性闸门事故与修法**见 [`.agents/notes/implemented/bug-fix/2026-10-18-dsh-plugin-peer-range-compat.md`](../../.agents/notes/implemented/bug-fix/2026-10-18-dsh-plugin-peer-range-compat.md)。
