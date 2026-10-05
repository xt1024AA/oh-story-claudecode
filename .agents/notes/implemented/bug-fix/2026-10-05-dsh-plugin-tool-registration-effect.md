# Agent Note: 装配期 ctx.effect 用法错误：7 个写作工具注册即注销（#9 真机事故）

Status: implemented

对应 wayfinder 地图 #1 下的 #9「本机安装冒烟与验收链路」。本文记录真机装机时暴露的装配缺陷、根因判定链、修法与回归护栏；验收链路的原始证据另见 `packages/dsh-plugin/docs/verification/2026-10-05-machine-smoke.md`。

## Problem

#8 落地（工具面 8 个 `oh_story_*`、包升 0.2.0）之后，桌面 profile 的**活体工具面只有 `oh_story_probe`**：7 个写作工具全部缺失，`oh_story_env` 调用返回 unknown tool。同时磁盘侧全绿——包在、profile 依赖 `link:` 指向工作区、组合树有行、probe 返回的描述已经是 0.2.0 才有的新措辞（说明宿主确实加载了新代码），本地 mock 测试 8/8 全绿。

判定链（每一步都排除了一个假设，留下唯一自洽的解释）：

1. **不是「模块没换」**：probe 描述里的「环境与脚本健康度请用 oh_story_env」是 0.2.0 才引入的字符串（`git log -S` 可证），活体输出有它 → 运行中的就是新代码。
2. **不是「宿主拒收 schema」**：用宿主自己的校验器 `assertSupportedJsonSchema`（`@deepseek-ai/dsh-tools` 的 `register()` 会调它）验 7 个工具的 `output.schema` 与 `parameters` → 全部通过。
3. **不是「某个工厂抛错拖垮整组」的单一形态**：`registerTools` 的注册循环本来就有 per-tool try/catch，逐个失败只会少那一个；7 个一起消失必须有一个「循环之前」或「全组共同」的原因。
4. 指向 `ctx.effect`：探针写成 `ctx.effect(() => off)`（回调**返回**清理函数），7 个工具写成 `ctx.effect(() => { disposers.forEach(off => off()) })`（回调**当刻执行**清理）。cordis 的约定是前者——`ctx.effect(callback)` 会**立刻调用** callback，并把**返回值**当作清理函数登记（官方 `cordis-plugin-development/references/host-plugin.md:54`：「Register every resource inside apply with ctx.effect or ctx.on and **return** its cleanup」）。于是后者在注册当刻就把 7 个工具全部注销：`register()` 全程返回成功、日志照写「8/8」、`count` 也确实是 7，只有工具面是空的。

**上游为什么没测出来**：`scripts/test-tools.mjs` 的 mock ctx 把 `effect` 写成 `effect() {}`——根本不调用 callback，等于把这条语义从测试里整段挖掉了。真机与 mock 的差别就这么一处，却正好是唯一会炸的一处。

**复现（不需要宿主，2 分钟内）**：把 `cadcee5` 的 `lib/index.js` 与修复后的版本放进同一个忠实 mock（`effect` 立刻调用 callback 并登记返回值），实测输出「修前 1 个在册（只剩 probe）/ 修后 8 个在册」——与真机现象逐字吻合。

## Decision

1. **清理必须写成「返回清理函数」**：`ctx.effect(() => () => { ...逆序 dispose... })`。
2. **两层独立护栏**：工厂构造逐个 try/catch（原先 7 个 `createXxxTool(runtime)` 挤在数组字面量里，任一抛错整组丢失），注册调用同样逐个 try/catch，失败记进 `toolRegistration.failures`，一个工具失败不再拖垮其余。
3. **三条硬规矩写进 `lib/index.js` 头注**（effect 语义、`register` 成功 ≠ 在册、工厂不许拖垮整组），下一个改装配的人先读到。
4. **`register()` 成功 ≠ 工具在册**：`oh_story_probe` 新增 `toolSurface` 字段（`attempted` / `registered` / `visibleAtCall` / `registryReadable` / `missing` / `failures`），在**调用时**用 `ctx.tools.get(name)` 回读注册表。宿主日志不落盘，探针输出是唯一可靠的取证面（沿用 #5 探针的设计原则）。
5. **探针第一个注册**：改成 `createProbeTool(ctx)`（闭包持有 ctx 才能回读），并挪到 `createRuntime` 之前；`createRuntime` 自身也加护栏并记 failure。此后任一步抛错，自检入口都还在，且能把原因带出来。
6. **装配记账每次 `apply` 重置**：宿主 HMR 重新 apply（或测试多次 apply）时旧记账不累加到新一次上。
7. **mock 忠实化**：新增 `fakeHostCtx()`——`effect` 立刻调用 callback 并登记返回值、注册表支持 `get`、重名报错、可逆序卸载；A1/A2 改用它，新增 A1b「apply 后 8 个在册 → 卸载后清空」，A2 断言 `toolSurface`。测试 34 → 35 项。
8. 版本 0.2.0 → 0.2.1（`package.json` 与 `lib/index.js` 的 VERSION 同步，A2 有断言）。

## Alternatives considered

- **只补 mock 的 `effect` 语义，不动产品代码**。最强理由：本地即可复现真机现象，改测试就能长期防回归（且不动已验证过的装配形态）。为何不用：那是把测试改对、把产品留错——真机上工具依然全丢。
- **不用 `ctx.effect`，改用 `ctx.on("dispose", ...)` 挂清理**。最强理由：绕开「返回值即清理函数」这条容易记错的语义，事件驱动更直白。为何不用：官方文档把两者并列，effect 一行就够；`on("dispose")` 要先确认宿主事件名与触发时机，等于把不确定性引进装配期。
- **把 8 个工具改成一次批量 `register`**。最强理由：少 7 次调用，天然只有一个 disposer。为何不用：宿主契约只有单个 `register(definition)`，没有批量入口；自造批量只是包一层同样要处理 disposer 的壳。
- **沿用「信 register 的返回值」，不回读注册表**。最强理由：少依赖一个未在 #2 契约文档里点名的 `ctx.tools.get`。为何不用：这次事故的形态恰恰是「返回值成功、工具不在册」；回读是唯一真值来源，`get` 不可用时按 `registryReadable:false` 如实报「无法核实」，不假装知道。
- **加一条 CI 守卫专门盯「工具面是否 8 个」**。最强理由：CI 层拦截，比人肉看探针可靠。为何不用：`test-tools.mjs` 的 A 组已经覆盖装配通路（现在是忠实的），再加一层守卫是同一事实的第二次断言；真机语义无法在 CI 里模拟得比忠实 mock 更真。

## Consequences

收益：

- 桌面 profile 重启后 8 个工具全部在册；一条 `oh_story_probe` 就能验证（「此刻在册 8 个」），不必再靠「让模型自己报工具列表」这种不可靠取证。
- 单点故障不再拖垮整组：工厂/注册失败逐个记录并随探针带回，宿主日志不落盘也拿得到证据。
- 测试模型忠实化后，「注册期语义错误」这一类问题在本地可复现（见 Problem 里的复现步骤）。
- 装机验收（本地路径 / tgz 两种 spec、新会话发现并加载 skill、真实业务结果、边界补测）留档在 `packages/dsh-plugin/docs/verification/2026-10-05-machine-smoke.md`。

代价与风险：

- `oh_story_probe` 的输出 schema 扩了 `toolSurface`——探针输出契约发生变化。旧输出字段仍在（多一段渲染），但逐字匹配旧输出的消费方需要更新。
- 回读注册表依赖 `ctx.tools.get`：该 API 未在 #2 的契约文档中点名。宿主不提供时只能降级报 `registryReadable:false`，这是诚实降级，不是等价替代。
- 装配记账是模块级状态：同一进程内多次 apply 只保留最后一次的事实（对 HMR 是有意选择）。
- 版本升到 0.2.1 后，`package.json` 与 `lib/index.js` 的 `VERSION` 必须同步维护（沿用既有约定，测试有断言）。
