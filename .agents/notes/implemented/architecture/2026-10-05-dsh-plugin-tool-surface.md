# Agent Note: DSH 插件写作工具面（#8 落地记录）

Status: implemented

对应 wayfinder 地图 #1 下的实现票 #8「封装确定性工具：storyctl + 去AI味 + 字数」。本文记录工具面契约与实现中的三个「动手前没预见的」工程事实（模块类型标记、pyc 排除、受限沙箱的 stdio 回退），供后续票（#9 冒烟、#11 文档）照抄。

## Problem

按 #3 契约把写作闭环核心脚本封装成 DSH 工具：storyctl chapter check/commit、check-ai-patterns、check-degeneration、normalize-punctuation、wordcount 口径。验收标准：真实业务结果、每条错误路径可读报错 + 测试证据、关键逻辑有注释。

## Decision

1. **工具面**：`oh_story_*` 前缀 8 个工具（命名对齐 DSH 生态习惯，`novel_*` / `deck_*` 同族）：
   | 工具 | 只读/破坏性 | 底层脚本 |
   | --- | --- | --- |
   | `oh_story_env` | 只读 | 无（探测链 + 脚本落点诊断） |
   | `oh_story_wordcount` | 只读 | `storyctl.py wordcount {measure,check,checkpoint}` |
   | `oh_story_chapter_check` | 默认只读；`fixPunctuation` 破坏性（审批） | `storyctl.py chapter check` |
   | `oh_story_chapter_commit` | 破坏性（独立工具名 + 审批） | `storyctl.py chapter commit` |
   | `oh_story_ai_patterns_check` | 只读 | `check-ai-patterns.js --check --json` |
   | `oh_story_degeneration_check` | 只读 | `check-degeneration.js --check --json` |
   | `oh_story_punctuation_normalize` | 默认只读；`fix` 破坏性（审批） | `normalize-punctuation.js --check / 写模式` |
   | `oh_story_probe` | 只读 | #5 探针保留；#9 起输出带 `toolSurface`（装配/在册回读，见下） |
   代码：`packages/dsh-plugin/lib/tools/*.js`（每工具一个模块，工厂函数 `createXTool(runtime)`），装配在 `lib/index.js` 的 `apply()`。
2. **统一信封**（`lib/runtime/envelope.js`）：`{ ok, tool, command, exitCode, status, env, counts?, result, stdout, stderr, sideEffects, approval?, error?, notes }`；`ok` = 「拿到有效业务判定」而非「判定通过」（blocked/findings 是业务结果不是故障）；`result` = 脚本 JSON 原样；`sideEffects` 如实记录落盘影响（含超长章的 `over_length_baseline.json`）。`output.schema` 与 `render` 单点定义，宿主校验不脱节。
3. **错误词汇表**（`lib/runtime/errors.js`）：`INVALID_ARGUMENT / PATH_NOT_FOUND / SCRIPT_MISSING / PYTHON_UNAVAILABLE / NODE_UNAVAILABLE / SPAWN_FAILED / TIMEOUT / ABORTED / EXIT_UNEXPECTED / OUTPUT_UNEXPECTED / APPROVAL_REJECTED / APPROVAL_REQUIRED / INTERNAL_ERROR / TRANSACTION_STALE / TOOL_UNAVAILABLE`，每个错误三件套 `{code, message, nextStep}`。
4. **解释器探测**（`lib/runtime/interpreter.js`）：python 链 `python3 → python → py -3`（`-c ""` 实跑判定，跳过 Store 占位）；node 链 PATH 里 `node`，桌面宿主回退宿主内置 Node（Electron-as-node，`ELECTRON_RUN_AS_NODE=1`），可被 `OH_STORY_DISABLE_HOST_NODE=1` 关掉；`OH_STORY_PYTHON` / `OH_STORY_NODE` 可强制指定（配错即报错，不静默回退）。
5. **路径归一**（`lib/runtime/paths.js`）：相对路径以会话工作区 cwd（`agent.session.header.cwd`，与 dsh-mattpocock-skills-deck 的 `resolveSessionCwd` 同取法）为基准解析，转绝对路径再交给原脚本；`~` 展开；存在性校验在起子进程之前。
6. **模块类型标记**（本次踩坑的修复）：本子包根 `package.json` 声明 `"type": "module"`，会让 Node 把 vendored 的 **CommonJS** 脚本（`require('fs')`）误当 ESM 解析而崩溃。修复：在脚本所在 skill 目录放 `{"type":"commonjs"}` 标记（`skills/story-deslop/package.json`、`skills/story-long-write/package.json`），Node 就近解析为 CJS；两份标记列入 check-parity / sync-skills 的 `EXEMPT_DST_FILES`（源侧没有，同步不得删除）。
7. **pyc 不参与 parity**：vendored 脚本被真实执行后会在 `scripts/__pycache__/` 再生 .pyc，逐字节比对它们只会制造假漂移；check-parity / sync-skills 的 `collectFiles` 统一跳过 `__pycache__`（#8 实测：465 个源文件逐字节一致）。
8. **受限沙箱的 stdio 回退**：受限环境禁止 Node 子进程创建命名管道（`spawn` 带 pipe 得 EPERM）。`runProcess` 支持 `stdioToFiles`（stdout/stderr 走临时文件，内容与截断语义同管道），由环境变量 `OH_STORY_USE_FILE_STDIO=1` 打开（`lib/runtime/proc.js`、`lib/runtime/index.js` 的 run 包装）。测试可在任意沙箱下跑；生产（DSH 宿主）默认管道。
9. **测试**：`packages/dsh-plugin/scripts/test-tools.mjs`（`pnpm test:tools`）**35 项**（#9 增 A1b，并把 mock ctx 换成忠实模型 `fakeHostCtx()`：`effect` 立刻调用 callback 并登记返回值）—— A 组走 `apply(fakeCtx)` 注册通路 + 真实 demo 书/正文返回真实业务结果；B 组注入环境/假审批覆盖全部错误路径；信封形状对 `ENVELOPE_SCHEMA` 逐项校验。`OH_STORY_SKILLS_DIR` 覆盖用于「脚本缺失」用例。
10. **装配期两条硬规矩（#9 真机事故补记）**：① `ctx.effect(callback)` 会**立刻调用** callback 并把**返回值**当清理函数（写成「在 callback 里直接清理」会让工具注册当刻即被注销）；② `register()` 返回成功 **≠** 工具在册，只能用 `oh_story_probe` 的 `toolSurface`（调用时回读注册表）核实。详见 `.agents/notes/implemented/bug-fix/2026-10-05-dsh-plugin-tool-registration-effect.md`，装机验收证据见 `packages/dsh-plugin/docs/verification/2026-10-05-machine-smoke.md`。

## Alternatives considered

- **模块类型修复：给每个 node 调用加 `--experimental-default-type=commonjs`**。
  最强理由：不动文件系统，一次性解决所有 CJS 脚本（含 storyctl 内部 node 调用）。
  为何不用：实测 Node v24.20.0 **没有该 flag**（`bad option`），`NODE_OPTIONS` 也禁止它；且它修不了 storyctl 内部的 node 子进程（我们控制不了它的 argv）。
- **模块类型修复：把 lib/ 全部改成 .mjs、去掉根 `type: module`**。
  最强理由：从根上让 scripts 恢复 CJS 默认。
  为何不用：19 个 lib 文件改名 + 全部 import 加扩展名 + 包 exports 变化，churn 大且动摇 #5 已验证的装载形态；嵌套 package.json 两行就能解决。
- **错误传输：测试只用管道（不去适配受限沙箱）**。
  最强理由：生产就是管道，测试也该一样。
  为何不用：本机受限沙箱跑测试会全红（EPERM），无法在开发环境做持续回归；文件传输与管道同语义，二者都由同一套收集逻辑驱动。
- **错误路径覆盖：不为「Python 探测链」单独设计 env 覆盖**。
  最强理由：探测链真失败时自然覆盖。
  为何不用：真失败难以确定性构造（取决于机器），`OH_STORY_PYTHON` 指向假路径让测试在任何机器上都稳定复现。

## Consequences

收益：

- 8 个工具全部在真实写作项目上返回真实业务结果（34 项测试全绿，demo 第021章 2068 字、改前.md 8/7 命中、commit 全链路、`TRANSACTION_STALE` 引导，逐项有断言）。
- 每条错误路径都有稳定错误码 + 人话 + 下一步（B 组 11 项错误用例）。
- 信封/探测/错误词汇成为后续票（#9 冒烟、#11 文档）可直接引用的契约。

代价与风险：

- 工具面是「薄封装」，业务判定仍完全由原脚本给出：原脚本的行为变化会直接透进工具结果（这是设计，不是缺陷）。
- `chapter accept-current-length` 未封装（#8 范围外，地图 Notes 与 README 已注明）。
- 进程内并发写保护不覆盖跨进程（原脚本无锁）。
- 检测器的 `--json` 是缩进版多行 JSON —— 解析器已按「整段/区间/逐行」三档兼容，但契约文档曾写「一行 JSON」，已在 `script-json.js` 头注纠正。
