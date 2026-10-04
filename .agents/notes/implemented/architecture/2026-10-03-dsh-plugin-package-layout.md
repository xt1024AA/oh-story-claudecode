# Agent Note: DSH 插件子包的落点与身份

Status: implemented

对应 wayfinder 地图 #1「DSH 插件化：把 oh-story-claudecode 装进 DeepSeek Harness」下的决策票 #4「定子包落点、包名与工作区形态」。决策由作者 2026-10-03 裁决；#5/#6/#7 落地后（`packages/dsh-plugin/`，commit `517f922`、`8fb9c28`、`a0ccced`），本笔记随同代码转入 `implemented/`。

## Problem

本仓库是 13 个 skill + 7 个宿主适配层的 Markdown 套件，产品形态是「装进别人家 Agent 的文本契约」，不是运行时程序。现在要新增一条 DSH（DeepSeek Harness）适配路径，而 DSH 插件与现有 7 个宿主**形态不同**：

- DSH 插件是一个**真正的 npm 包**，要带 `package.json` 的 `dsh` 键、`cordis.patch.yml`、JS 入口、自带的 `skills/` 副本与测试。
- 现有 7 个宿主适配层都很轻：`.claude-plugin/plugin.json`、`.zcode-plugin/plugin.json`、`reasonix-plugin.json`、`.clawhub/publish.json` 都是几行 JSON，加一个 `skills/` 指针就完事。

于是落点、包名、是否引入工作区、以及新子包与既有守卫的关系，都必须先定，否则 #5（骨架原型）、#6（清单装配）、#7（vendored skills）无法动工。

## Decision

1. **落点**：`packages/dsh-plugin/`。
2. **包名**：`dsh-oh-story-claudecode`（不带 npm scope）。
3. **工作区形态**：**子包完全独立，根 `package.json` 零改动**。子包自带 `package.json` 与自己的安装入口，不进任何 workspace。
4. **守卫可见性**：子包里的 vendored skills **不纳入**热路径守卫（`check-doc-budget.sh` 等）；副本与源的漂移由 #7 另立的 **parity 校验脚本** 负责。

## Alternatives considered

- **落点选 `.dsh-plugin/`**（贴合本仓适配层命名习惯，与 `.claude-plugin/`、`.zcode-plugin/`、`.clawhub/` 同构）。
  最强理由：一致性——读仓库的人看到 dotted 目录就知道那是宿主适配层，不用额外学一套约定。
  为何不用：DSH 插件不是「几行 JSON 的适配层」而是完整 npm 包（`lib/` + `skills/` + tests + lock）。npm 的 `files` 白名单对 dot 目录有历史坑，把它们塞进包体要多绕一圈；且日后若想引入 workspace，`packages/*` 是通行约定，不必二次搬家。

- **落点选根级 `dsh/`**。
  最强理由：路径最短，意图最直白，`dsh plugin add ./dsh` 读起来顺。
  为何不用：与现有根目录结构（`skills/` `scripts/` `docs/` `demo/` `tests/`）并列时语义含糊——`dsh/` 看不出是「一个可安装的包」还是「DSH 相关零散文件」。

- **包名带 scope（`@xt1024aa/oh-story-dsh`）**。
  最强理由：scoped 天然不抢公共名，与上游官方包 `@oh-story/dsh` 一眼区分，日后真发 npm 不用改名。
  为何不用：作者选择 `dsh-oh-story-claudecode`。本项目只做本地路径 / tgz 安装，不发布 npm，scope 的唯一价值（命名空间）此刻用不上；而 `dsh-` 前缀能让人一眼看出这是 DSH 的插件。

- **引入 npm workspaces（根加 `workspaces: ["packages/*"]`）**。
  最强理由：依赖统一装、统一 lock，`npm install` 一次到位，是 monorepo 的正统做法。
  为何不用：会改动根 `package.json` 与 `package-lock.json`，导致根 `npm install` 抢装子包的 devDependencies（typescript / vitest 等），把纯 skill 仓库的安装面撑大；更要紧的是直接违背作者定下的硬标准②——「现有守卫与 CI 全绿」。子包独立时根 CI 与 lock 完全不受影响，代价只是子包要单独 `npm install`。

- **引入 pnpm workspace（对齐上游 `oh-story-dsh`）。**
  最强理由：与上游同构，迁移与对照最省力，pnpm 对 monorepo 的处理也更严。
  为何不用：本仓已存在 `package-lock.json`，引入 pnpm 会形成双 lockfile，还要重排 CI，为一个子包付这个代价不值。

- **把子包副本纳入现有热路径守卫。**
  最强理由：一套规则管到底，将来不会出现「源被管、副本没人管」的缝隙。
  为何不用：副本与源逐字相同，同一份文本在 CI 里被计费两次没有信息增量；且 `check-doc-budget.sh` 走 `doc-budget.json` 白名单、`check-plugin-packaging.py` 只认根目录 `skills/`，副本**天然就在扫描面之外**（已实测；#10 复验：全部守卫的扫描根是 `skills/`、`demo/`、`.agents/notes/` 与显式清单，`packages/` 不在其中）。真正要防的是「副本漂了」，那是 parity 校验的职责（#7），不是预算守卫的职责。

## Consequences

收益：

- 根 `package.json`、`package-lock.json`、现有 7 个适配层与全部 `scripts/` 守卫**零改动**，硬标准②（CI 全绿、7 宿主不破）在结构上就有了保障，而不是靠事后修补。
- 子包自带 lock 与依赖，可以按 DSH 插件自己的需要引入 devDependencies，不受根目录「只有 playwright」的限制。
- `packages/dsh-plugin/` 为日后引入 workspace 或增加第二个子包留好了位置。

代价与风险：

- **多一次安装动作**：子包依赖要单独 `npm install`，根目录一次装全的便利没有了。
- **副本无人守**：在 #7 的 parity 校验落地之前，子包里的 skills 副本会处于「既不进热路径守卫、也还没有 parity 守卫」的窗口期；实施时 #7 必须与 #6 同批完成（已完成）。
- 包名 `dsh-oh-story-claudecode` 不带 scope，日后若要发公共 npm 需先确认不撞名。
