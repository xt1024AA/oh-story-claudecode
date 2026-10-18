# Agent Note: DSH 升级后插件被兼容性闸门整包跳过（peer 精确版本 → 范围 + 清单守卫）

Status: implemented

对应事故：2026-10-18，本机 DSH 从 `0.2.0-rc.2` 升到 `0.2.1-rc.2` 之后，`dsh-oh-story-claudecode@0.2.1` **整包不再装载**，而 `npm pack`、35 项工具测试、parity、类型检查全部照旧全绿。修在 0.2.2。

## Problem

`packages/dsh-plugin/package.json` 声明了：

```json
"peerDependencies": { "@deepseek-ai/dsh-skill-filesystem": "0.2.0-rc.2" }
```

这是一个**精确的预发布版本号**。宿主 `dsh-app-boot` 的兼容判定是：

```js
function satisfies(runtimeVersion, range) {
  return range.trim() !== "" && semver.satisfies(runtimeVersion, range, { includePrerelease: true });
}
```

`includePrerelease` 让 `^0.2.0-rc.2` 这类范围能覆盖 `0.2.1-rc.2`，**但精确版本只匹配它自己**。于是运行时一旦变成 `0.2.1-rc.2`，该 peer 判为不满足：

```
dsh: skipping profile bundle "dsh-oh-story-claudecode": Error: Plugin dsh-oh-story-claudecode@0.2.1
is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-skill-filesystem":"0.2.0-rc.2"}.
... Exact-version exemption: not active.
```

**这个失败方式的杀伤力在于它不报错、不退出**：`loadProfileDirectory` 把抛错 catch 掉、该组合包不进 layers、其余组合包照常加载，profile 正常启动，只在 stderr 留一行。插件于是「像没装过一样」——8 个 `oh_story_*` 工具不存在，13 个 skill 不出现，而所有既有测试仍然绿，因为它们**没有一步读过宿主怎么判兼容**。

这不是本仓库独有的坑：本机同一时刻还有 `dsh-a-stock-data@0.1.1`、`@linfengqaqtat/dsh-scriptor@8.2.2` 犯了同一个错。

## Decision

1. **peer 改成范围 `^0.2.0-rc.2`**。实测该范围在 `0.2.0-rc.2` 与 `0.2.1-rc.2` 上均判兼容，且语义上等价于「0.2.x 线，含预发布」。同时覆盖两条历史基线，不需要为旧运行时保留第二个包。
2. **刻意不写 `engines.dsh`**。宿主 `unmetRequirements` 的第一条分支是「有 `engines.dsh` 就直接 return，peerDependencies 全被忽略」。加 `engines.dsh` 虽然也能让包通过，但会把「宿主必须提供兼容的 `@deepseek-ai/dsh-skill-filesystem`」这层保护整个短路掉。**用 peer 承载兼容声明，不用 `engines.dsh`。**
3. **新增 `scripts/check-manifest.mjs`（`pnpm test:manifest`）作为兼容性守卫**，把「宿主会怎么判」搬进仓库里跑。守四件事：
   - 兼容性：拒绝精确版本 peer；peer 必须是范围且覆盖 `SUPPORTED_RUNTIMES` 里每个基线；**拒绝 `engines.dsh`**；没有 dsh peer 也判红（零声明 = 零约束）。
   - 一致性：`lib/index.js` 的 `VERSION` / `cordis.patch.yml` 的行 id+name / 包名三处相同；版本必须精确 SemVer（宿主拿 `name@version` 当豁免键）。
   - 可装载的形状：`dsh.bundle.patch` 指向存在文件；`exports` 与 `files` 覆盖 `locale`/`icon`；icon ≤256 KiB 且格式被接受。
   - 随包 skills：每个 `skills/<name>/SKILL.md` 的 frontmatter 满足 `dsh-skill` 的硬要求（`^[a-z0-9]+(?:-[a-z0-9]+)*$` 的 `name` + 非空 `description`，且 `name` 与目录名一致），否则宿主静默丢弃该 skill。
4. **守卫的 semver 解析器刻意 fail-closed**：只认 `^` / `~` / `>=` / `>` / `<=` / `<` / `=` / `||` / `X.Y.x` / `*`，语法超出子集**直接报错**，不做「看不懂就放行」——否则守卫会退化成安慰剂。
5. **新增 `scripts/test-manifest-guard.mjs`（`pnpm test:manifest-guard`，14 项）做变异回归**：把 0.2.1 事故与其余复现形态逐个造出来，断言守卫**确实变红**并点到要害，再还原复绿。这是「守卫真的在守」的唯一证据。
6. **补显示元数据**：`locale/en.json` + `locale/zh.json`（`meta.title` / `meta.description`）+ `icon.svg`（1 KB 内联 SVG），并写进 `exports` 与 `files`。宿主对此的要求是「缺了回退到包名/默认图」，**不是装载条件**；补它只为设置页可读，顺带让「元数据形状」也有守卫。`icon` 的 256 KiB 上限与格式白名单进守卫，因为越界会多出一条 metadata 诊断。
7. **版本升 0.2.2**，`lib/index.js` 的 `VERSION` 与之一致（守卫会查这条）。
8. **验收路径补一步**：安装后先 `dsh <profile> --dump-config | Select-String "skipping profile bundle"`，**必须无输出**，再看 `oh_story_probe` 的「此刻在册 8 个」。0.2.1 就是在「无输出」这一步静默失败的。

## Alternatives considered

- **给 0.2.1 加版本豁免（`dsh plugin allow-version` / profile 的 `compatibility.json`）。**
  最强理由：零代码改动，一条命令当场可用，对已经装好的用户最快。
  为何不用：豁免键是**精确** `name@version`，插件升级与 DSH 升级**都不继承**——0.2.2 要重新授一次，DSH 再升一次还要再授。它把一个「声明本来就错了」的问题变成每次升级都要人工确认的运维负担，而且豁免文档明确写着「可能导致崩溃或数据丢失」，实际上等于承认兼容性未验证。修声明才是根治。

- **改用 `engines.dsh: ">=0.2.0-rc.2"`（本机 `dsh-mattpocock-skills-deck`、`oss-prompt-optimizer` 的做法）。**
  最强理由：生态里最常见的写法，一行搞定，不依赖 peer 语义；而且 `engines.dsh` 优先级最高，绝不会被别的声明盖掉。
  为何不用：它会让 `peerDependencies` **完全失效**（`unmetRequirements` 直接 return）。本包真正依赖的宿主能力是 `@deepseek-ai/dsh-skill-filesystem` 的 `bundledSkillDir` 语义，失去这条保护后，将来该包改名或改选项，我们会静默装载失败而不是被拦在门外。范围写在 peer 上同样能被强制，还保留了逐包精度。

- **干脆不声明任何 dsh peer（`dsh-hdc-bridge`、`@liustack/modlens` 的做法）。**
  最强理由：零约束 = 零误判，永远不会因为版本号写错而被跳过，装了就能用。
  为何不用：我们把「宿主必须提供足够新的 skill-filesystem」当成真实前提，零声明等于放弃这个前提的检查。守卫里也专门把「没有 dsh peer」判红，防止有人日后图省事删掉。

- **兼容性守卫做成「调起 `dsh --dump-config` 看有没有 skipping」。**
  最强理由：直接验证宿主真实行为，不重复实现一遍 semver，理论上不会与宿主判定脱节。
  为何不用：CI 里没有 DSH 安装，本机也未必总有；而且这个命令在 desktop profile 上被拒绝（`profile "desktop" is managed exclusively by the Electron application`），要造临时 profile 才能跑。它适合做**安装后验收**（已写进 README），不适合做提交前守卫。守卫用「按宿主代码复刻的判定规则 + 变异回归」来保证不失真。

- **守卫直接用 `semver` 包。**
  最强理由：不重复造轮子，语义天然与宿主一致（宿主用的就是 `semver`）。
  为何不用：子包刻意零运行时依赖（`packages/dsh-plugin` 不装任何 dsh 包，依赖全部由宿主提供）。为一个守卫引入依赖会打破这条边界，且 CI 还要多装一次。改为实现 `includePrerelease` 语义所需的最小闭包（约 100 行），并用 14 项变异测试锁住行为。

- **把守卫挂在仓库根 `scripts/` 与 CI。**
  最强理由：和其余 60+ 条守卫同构，一处运行全部检查。
  为何不用：子包对根 `package.json`、根 `scripts/` 与 CI 是**零改动**关系（见 `2026-10-03-dsh-plugin-package-layout.md` 决策 3）。把守卫放进子包、通过 `pnpm test:manifest` 运行，保持了这条边界；将来若要接 CI，加一个 job 调子包脚本即可，反向不成立。

## Consequences

收益：

- 本机 `0.2.1-rc.2` 上插件恢复装载：隔离 profile 的 `--dump-config` 里 skipping 行消失、出现 `- id: dsh-oh-story-claudecode`；`locale/en.json`、`locale/zh.json`、`icon`、`package.json`、包入口五条解析路径全部命中（证据见 `packages/dsh-plugin/docs/verification/2026-10-18-dsh-0.2.1-compat.md`）。
- 这类事故从此有一个 14 项的确定性回归，而不是靠人记得「升 DSH 要手查」。
- 兼容性声明从「一个写死的版本号」变成「一条带基线清单的范围」，`SUPPORTED_RUNTIMES` 就是本插件承诺支持的运行时列表，可审阅、可增长。
- 设置页/插件管理器能显示「Oh Story 网文写作」与图标，不再是一行包名。

代价与风险：

- **`SUPPORTED_RUNTIMES` 是手工维护的**：加基线要人改常量。忘了加不会立刻出事（守卫仍会检查 peer 是否覆盖**已列出**的运行时），但「新运行时是否真的可用」仍然只能靠真机验收。
- **守卫复刻了宿主的 semver 判定**：宿主将来若改判定规则（例如去掉 `includePrerelease`），守卫不会自动跟着变。这是「CI 里没有宿主」的必然代价；缓解手段是安装后验收那一步（看 skipping 行），它验证的是宿主真实行为。
- **`engines.dsh` 被守卫明确禁掉**：如果将来 DSH 生态统一改用 `engines.dsh` 且 peer 校验被移除，这条规则需要重新评估——届时它是过时约束而不是保护。
- **显示元数据要跟着能力走**：`locale/*.json` 里的文案是人工维护的第二处描述，改了插件能力忘了改它，设置页会出现过时描述（不影响装载）。
- 本笔记不改变一个既有事实：兼容闸门只能证明「宿主愿意装载」，证明不了「API 仍然匹配」。升级 DSH 后仍应跑 `test:tools` 并在真机确认「此刻在册 8 个」。
