# DSH 插件破坏性工具的安全语义与确认策略

对应 wayfinder 地图 #1「DSH 插件化：把 oh-story-claudecode 装进 DeepSeek Harness」下的决策票 #12「定破坏性工具的安全语义与确认策略」。决策由作者 2026-10-04 裁决（Q1/Q2/Q3 均选 A）；实现随 #8「封装确定性工具」落地（commit `cadcee5`，见 `.agents/notes/implemented/architecture/2026-10-05-dsh-plugin-tool-surface.md`）。

## Problem

写作闭环核心集里「看起来只读」的工具其实会写盘（调研票 #3 实跑证实，契约见 `docs/research/story-script-contracts.md`）：

| 脚本/子命令 | 破坏性行为 |
| --- | --- |
| `normalize-punctuation.js` | **默认（不带 `--check`）原地改写文件**；`--check` 才只读 |
| `storyctl.py chapter check`（**不带** `--fix-punctuation`） | 章节超长且 quality pass 时，**仍会写** `{书}/.story/work/第{NNN}章/over_length_baseline.json` |
| `storyctl.py chapter check --fix-punctuation` | 原地改写正文 |
| `storyctl.py chapter commit` / `accept-current-length` | 原子写 `追踪/_tracking-state.json` 与全部派生视图，删本章工作目录；且**不幂等**（同事务重跑必失败，`tracking state changed`，exit 2） |

不定义安全语义就直接封装成 DSH 工具，模型可能**静默篡改作者书稿** —— 这是写作工具不可接受的失败模式。

## Decision

1. **默认只读**：每个破坏性动作要求**显式开关**（`fixPunctuation: true` / `fix: true`、独立的 `oh_story_chapter_commit` 工具名）。模型必须先跑只读检查（`chapter check` 默认形态 / 检测器 `--check`），再在结果里显式要求破坏性动作。
2. **人工审批**：破坏性动作（`oh_story_chapter_commit`、`fixPunctuation`、`punctuation fix`）走宿主审批服务（`ctx.get("approval")` 的 `request()`，服务名 `approval`），作者确认后才执行；`rejected` 是终局，`confirm: true` 也不许绕过。底线：**作者书稿不可静默篡改**。
3. **审批通道不可用的回退**（本笔记原「代价与风险」里的兜底，已落地）：`unavailable` / 服务缺失 / 调用抛错时，显式 `confirm: true` 放行，并在信封的 `approval` 里如实标注 `via: "explicit-confirm"`（回退通道，非人工审批）。
4. **幂等与环境一并定死**（已落地）：
   - 不幂等失败（`chapter commit` 重跑必失败）→ 工具返回 `TRANSACTION_STALE` + 可读报错 + 正确下一步（重新 `tracking_commit.py draft --project … --chapter N` 再提交）。
   - 工具启动做 **Python 探测**（`python3 → python → py -3`，`-c ""` 实跑判定，跳过 Microsoft Store 占位 exit 9009），探测结果随信封 `env` 字段报给模型；Node 同型探测（PATH 里的 node，桌面宿主可回退宿主内置 Node）。
   - 并发写保护：破坏性标点归一整体持**进程内互斥**（`punctuation-fix-global`）；跨进程并发原脚本无锁，局限写进 notes，不硬造。

实现位置：`packages/dsh-plugin/lib/runtime/approval.js`（审批闸门）、`lib/runtime/interpreter.js`（探测链）、`lib/runtime/proc.js`（子进程执行器）、`lib/runtime/file-guard.js`（sha256 / 互斥 / 工作目录快照）、`lib/tools/*`（各工具）。

## Alternatives considered

- **Q1 选 B（默认允许、靠工具描述约束模型）**。
  最强理由：实现最省事，模型不需要多一步显式请求。
  为何不用：模型可能绕过描述里的警告直接调用破坏性动作，作者书稿面临静默篡改风险，与「作者书稿不可静默篡改」底线直接冲突。

- **Q1 选 C（破坏性流程不进工具，只留只读检查）**。
  最强理由：最彻底的安全隔离——工具面永远不出现破坏性能力。
  为何不用：#3 契约表明这些脚本本身就是写作闭环流程的一部分（`chapter commit` 是日更提交的必经步骤）；只留只读会让 DSH 工具失去写作闭环里最关键的确定性操作，退化成纯检查器。用「显式开关 + 审批」同时拿到安全与功能，不必二选一。

- **Q2 选 B（不审批、靠显式参数 + 结果确认）**。
  最强理由：交互更轻，模型一次调用就能完成破坏性动作。
  为何不用：`chapter commit` 是不可逆操作（写状态、删工作目录），没有人工闸门时一次误调就要靠 git 恢复；而 DSH 原生提供审批通道，接入成本低。

- **Q2 选 C（审批设计留到 #8 实测后再定）**。
  最强理由：避免为一个「可能不可用」的通道预先承诺语义。
  为何不用：审批通道可用性是**实现细节**，语义应先定死（默认只读 + 显式请求 + 审批）；若 #8 实测发现宿主侧审批不可用，回退为「显式参数 + 结果确认」并在 #8 的 resolution 里如实记录即可，不改变本票的语义决策。

- **Q3 选 B（幂等与环境留到 #8 实现时再处理）**。
  最强理由：让实现票自己决定错误处理细节。
  为何不用：这两个坑直接影响**工具描述怎么写**（模型需要知道失败长什么样、下一步做什么）与**错误处理设计**；先在语义层定死，实现票才能照抄，避免 #8 中途回头补设计。

## Consequences

收益（#8 实测均成立）：

- 守住「作者书稿不可静默篡改」底线 —— 破坏性动作全部显式化 + 人工审批（测试 A18/B9 覆盖：被拒时追踪状态一字未动）。
- 模型获得确定性护栏：只读检查先行、破坏性显式化、commit 有审批闸门、失败有正确下一步（`TRANSACTION_STALE` 引导重新 draft，测试 A17）。
- 每个破坏性能力的三件套（默认行为 / 触发条件 / 用户可见提示）已在实现中固化，工具描述直接写明。

代价与风险：

- 破坏性动作多一步人工确认，交互略重（换取书稿安全，可接受）。
- 审批通道不可用时的 `confirm: true` 回退在返回里如实标注，模型与作者都能看到这次不是人工审批；仍存在「作者显式确认被模型拿来擅自执行」的残余风险，靠工具描述与回退标注缓解。
- 跨进程并发写没有锁（原脚本无锁，不重写逻辑），文档与 notes 已写明局限。
