# DSH 插件接口规范（本机实测）

> 调研票：#2「钉死 DSH 插件接口规范：清单、生命周期、工具与 skills 装载」
> 取数日期：2026-10-03　取数环境：DeepSeek Harness Desktop 本机（DSH 0.2.0-rc.2，profile `desktop`）
>
> **路径简写**（下文一律使用，全文同义）：
> - `$ASAR` = `C:\Users\49178\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai`
> - `$DSH` = `C:\Users\49178\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh`
> - `$PROFILE` = `C:\Users\49178\.dsh\profiles\desktop`
> - `$SAMPLE` = `$PROFILE\node_modules\@linfengqaqtat\dsh-scriptor`
> - `$DECK` = `$PROFILE\node_modules\dsh-mattpocock-skills-deck`
>
> **取证方法补充**：任务书提示 `app.asar` 是打包文件、普通文件 API 读不进去。实测**可以读**——用 Electron 自己的 Node 模式即可（Electron 给 `fs` 打了 asar 补丁）：
> ```powershell
> $env:ELECTRON_RUN_AS_NODE='1'
> & 'C:\Users\49178\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' --expose-internals <script.js>
> ```
> 这与官方自身的说法一致（`$ASAR\dsh-agent-preset\skills\cordis-plugin-development\SKILL.md:38`：「In Desktop the directory sits inside `app.asar`, which only the Host process's own file reads can open; shell commands (`ls`, `cat`, `cp`, `cmp`), the glob and search tools (they run a native ripgrep process), `node`, and pnpm all fail on it.」——即**宿主进程自己的文件读取**能开，外部 `node`/ripgrep 不能）。本文档中所有 `$ASAR`、`$DSH` 证据均由该方式读出，其余路径用常规文件读取。

---

## 结论速览

1. **`dsh.bundle.patch` 是「这个包算不算 bundle」的唯一判据**，对纯插件而言可选；写它才会被当作 profile 组合层。它可以是**一个路径，也可以是一个有序路径列表**，按列表顺序拼成同一层。
2. **`dsh.client` 整块可选**；一旦声明，块内 `platform` 是**硬要求**（必须是字符串，且实际只有 `'web'` 会被装配），并且包**必须导出 `./client`**。`inject` / `external` / `immediately` 全部可选，`immediately` 缺省为 `false`。
3. **`engines.dsh` 是纯声明，不被强制**——官方明说「当前安装器和加载器不强制检查 `dsh.manifestVersion` 或 `engines.dsh`」。真正被强制的是 **`peerDependencies` 中匹配 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的范围**；`@deepseek-ai/cordis`、`react` 这类不匹配该模式的 peer 不受版本校验。
4. **profile 的 `cordis.yml` 是空数组 `[]`，不是编辑点**。装配顺序是：`dsh.profile.bundles` 顺序叠加各 bundle 的 patch → profile 的 `cordis.patch.yml` → home 的 `$DSH_HOME/cordis.patch.yml`。官方注释直接写「Edit cordis.patch.yml, not this file」。
5. **`insert` 是纯追加语义**：无 `id` 追加到根条目列表；有 `id` 时目标必须已存在**且是 `group: true`**，追加进该 group 的 `config` 子列表。非 insert 的 patch 必须有非空 `id`，`config` 是**整体替换、不深合并**；truthy 的 `name` 是**断言**既有插件名而非改名；匹配不到就告警跳过。
6. **插件模块导出两种形态之一，禁止混用**：`export function apply(ctx, config) {}`（可另带 `export const inject` / `export const Config`），或 **default 导出 service class**。
7. **工具注册 API**：`ctx.tools.register(definition): () => void`。`parameters` 的静态类型是 `Record<string, unknown>`——**既接受 `defineTool` 的 DSL，也接受原始 JSON Schema 对象**；`output` 是必填的 `{ schema, render }`；返回的 disposer 是「精确撤销器」，必须自己收集并在 dispose 时调用。
8. **`restrict` 只约束「继承来的全局工具」**：空过滤器、未知名字、**作用域内局部名字**都会直接失败；多个 restrict 取交集，**scoped 注册的工具始终可见**。子 Agent 场景拿 scoped registry 靠 `agent.ctx.get("tools")`。
9. **skills**：插件自带目录靠 `@deepseek-ai/dsh-skill-filesystem` 提供方 + `bundledSkillDir` 配置装载，落到 **rank 600**，且 `includeDefaultRoots: false` 可以只留自带根。SKILL.md frontmatter **必填 `name`（kebab-case）与 `description`**，发现深度**只有一层**（`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`），嵌套 `**/SKILL.md` 刻意不支持。
10. **`dsh plugin --profile <p> <args>` 就是「在 profile 目录里转发给 pnpm」**——本机实测 `dsh plugin --profile desktop --help` 打印的是 pnpm 11.7.0 自己的帮助。安装成功后由 plugin-manager 的 `reconcile` 把带 `dsh.bundle` 的新依赖追加进 `dsh.profile.bundles` 并写回 profile `package.json`；**它不碰 `cordis.yml`，也不碰 `cordis.patch.yml`**。

---

## 1 插件清单字段

### 1.1 `dsh.bundle.patch`

**结论：可选（对纯插件）；存在即是 bundle 的判据。值可以是单个路径或有序路径列表（相对包根）。**

- 判据代码：`$ASAR\dsh-plugin-manager\lib\types\operations.js:31-35`
  ```js
  export function bundleManifest(name, dir, anchor) {
      const packageDir = resolveBundleDir('dsh', name, anchor, dir);
      const manifest = readProfileManifest('dsh', packageDir);
      return manifest.dsh?.bundle?.patch === undefined ? undefined : manifest;
  }
  ```
- 没有它时的行为（安装后只当普通依赖，并打警告）：`$ASAR\dsh-plugin-manager\lib\types\operations.js:57-60`
  ```js
  const metadata = bundleManifest(name, dir, anchor);
  if (metadata?.dsh?.bundle === undefined) {
      options.onOutput?.(`dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`, 'stderr');
      continue;
  }
  ```
- 有序列表语义：`$ASAR\dsh-app-boot\README.zh.md:50`
  > 组合包的 `dsh.bundle.patch` 指定一个 patch 文件或一个有序的文件列表；`bundlePatchFiles` 校验该声明，`bundlePatchPaths` 把它解析为绝对路径；该层按此顺序拼接各文件的 patch 列表。
- 官方作者文档的定义：`$ASAR\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md:3`
  > A bundle is a package whose `package.json` declares `dsh.bundle.patch`; the YAML patch inserts plugin entries.

### 1.2 `dsh.client`（`platform` / `inject` / `external` / `immediately`）

**结论：`dsh.client` 整块可选；块内 `platform` 必需（字符串）；`inject` / `external` / `immediately` 可选；`immediately` 缺省 `false`；声明了就必须导出 `./client`。**

判据全部在 `$ASAR\dsh-client-modules\lib\index.js`（`lib\client.js` 为同一份浏览器侧副本）：

| 行 | 代码 | 含义 |
|---|---|---|
| 63 | `if (typeof value !== "object" \|\| value === null) throw new Error(\`client-modules: ${pkgName} has a non-object dsh.client declaration\`)` | 必须是对象 |
| 65 | `if (typeof decl.platform !== "string") throw new Error(\`client-modules: ${pkgName} dsh.client.platform must be a string\`)` | **`platform` 必需且必须为 string** |
| 66 | `const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);` | `inject` 可选字符串数组 |
| 67 | `const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);` | `external` 可选字符串数组 |
| 68 | `if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw ...` | `immediately` 可选，必须是 boolean |
| 714 | `if (decl === void 0 \|\| decl.platform !== "web") {` | **只有 `platform === 'web'` 才会进入装配**（其余走跳过分支） |
| 719 | `if (clientRel === void 0) throw new Error(\`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle\`);` | **必须有 `./client` 导出** |
| 726 | `immediately: decl.immediately === true` | **缺省即 false** |
| 428 | `if (dependency === entry) throw new Error(\`client-modules: "${entry.id}" requests module "${name}" that it answers itself — a row must not declare its own package in dsh.client.external\`);` | `external` 不得自指 |

两处 `dsh.client.inject` 的用途说明（说明它不是模块解析，而是**激活顺序声明**）：
- `$ASAR\dsh-agent-preset\skills\cordis-plugin-development\references\practices.md:35`
  > `dsh.client.inject` entries only order activation and stay allowed.
- `$ASAR\dsh-client-ui-workspace\lib\client.js:4103`
  > ... to this one is NOT constrained: dsh.client.inject edges are informational

官方模板给出的双字段范例：`$ASAR\dsh-agent-preset\skills\cordis-plugin-development\templates\decoration\package.json:6-14`
```json
"exports": { ".": "./index.js", "./client": "./client.js" },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
  }
}
```

**本机两个真实样本正好覆盖两种组合**：
- `$DECK\package.json:49-58`：`dsh.bundle.patch` + `dsh.client = { platform: "web", immediately: true, inject: [] }`
- `$SAMPLE\package.json:11-26`：`dsh.client = { platform: "web", inject: [6 个 UI 包] }`，**未写 `immediately`**（即取缺省 false）+ `dsh.bundle.patch`

### 1.3 `engines.dsh`、`engines.node`、`dsh.manifestVersion`

**结论：全部可选，且 `engines.dsh` / `dsh.manifestVersion` 只作声明、不被强制。**

- `$ASAR\dsh-package-manifest\README.zh.md:48`
  > 以下元数据字段均可选。省略时，格式版本或兼容的宿主版本保持未声明状态；读取方不推断默认值。
- `$ASAR\dsh-package-manifest\README.zh.md:53`
  > `engines.dsh` — 作者声明的兼容 DSH 版本，使用 SemVer 范围，也可填写精确的预发布版本。此字段与 `engines.node`、`engines.npm` 并列；engines 对象可省略 `dsh`。
- `$ASAR\dsh-package-manifest\README.zh.md:93`（**关键否定证据**）
  > **兼容性仅作声明。** 当前安装器和加载器不强制检查 `dsh.manifestVersion` 或 `engines.dsh`；声明范围不会拒绝不兼容的宿主，也不会校验 SemVer 语法。
- `$ASAR\dsh-package-manifest\README.zh.md:52`：`dsh.manifestVersion` 声明的格式为 `1`，独立于 npm 包版本与 Session 格式版本。
- 版式参考：`$DECK\package.json:9-11` 用了 `"engines": { "dsh": ">=0.2.0-rc.2" }`；`$SAMPLE\package.json:116-118` **只写了 `engines.node`**，没写 `engines.dsh`。
- 该包只发类型、不发运行时（`$ASAR\dsh-package-manifest\package.json:3` `"description": "Shared type declarations for package.json.dsh configuration fields"`；`lib/index.js` 仅 11 字节）。

### 1.4 `peerDependencies` —— 这才是被强制的兼容性闸门

- `$ASAR\dsh-app-boot\README.zh.md:52`
  > profile 导入插件前，DSH 会检查其 `peerDependencies` 中对 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 的依赖，与 `getDshRuntimeVersion()` 返回的唯一运行时版本比较。每个声明的版本范围都必须匹配；预发布版本参与范围匹配。源码工作区的 `workspace:^`、`workspace:~` 和 `workspace:*` 指向同一个运行时。**未声明 DSH peer 时不施加版本约束；无效范围视为不兼容。这些检查使用 peer 声明，而不是 `engines.dsh`，也不是防范恶意包代码的沙箱。**
- 代码：`$ASAR\dsh-app-boot\lib\index.js:289-293`
  ```js
  if (!Object.hasOwn(fields, "peerDependencies")) return void 0;
  const dependencies = objectOf$1(fields.peerDependencies, "Plugin manifest peerDependencies");
  ...
  if (typeof range !== "string") throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`);
  ```
- 拒绝后的处置：`$ASAR\dsh-app-boot\README.zh.md:54`——被拒绝的普通行变成游离的 `disabled: true` 行；组合包层面不兼容则像读不到的组合包一样被跳过并列入 `skippedBundles`；**profile 的 patch 层、依赖清单与组合包列表都不会被改写**。
- 豁免文件是 profile 自己的 `compatibility.json`（`package-name@version` → 精确 DSH 运行时版本列表），**不是** `package.json`（`$ASAR\dsh-app-boot\README.zh.md:56`）。

**逐个字段的实际强制情况（以本机样本为准）**：

| 声明 | 位置 | 是否被强制 |
|---|---|---|
| `@deepseek-ai/dsh-tools: 0.2.0-rc.2` | `$SAMPLE\package.json:121` | 是（匹配 `@deepseek-ai/dsh-*`） |
| `@deepseek-ai/dsh-llm: 0.2.0-rc.2` | `$SAMPLE\package.json:122` | 是 |
| `@deepseek-ai/dsh-skill-filesystem: 0.2.0-rc.2` | `$SAMPLE\package.json:123` | 是 |
| `@deepseek-ai/cordis: 4.0.4` | `$SAMPLE\package.json:120` | **否**（不匹配 `@deepseek-ai/dsh*`，不做版本校验） |
| `react: 18.3.1` | `$SAMPLE\package.json:124` | **否**（同上） |

**peer 不会被自动装进 profile**：`$PROFILE\pnpm-workspace.yaml` 里 `autoInstallPeers: false`，且 `$PROFILE\node_modules\@deepseek-ai\` 下**只有 `cosmokit` 与 `schemastery` 两个包**（实测枚举），没有 `cordis` / `dsh-tools` / `dsh-skill-filesystem`。原因是随 dsh 发布的包从 **dsh 安装目录**解析，而不是从 profile：
- `$ASAR\dsh-agent-preset\skills\cordis-plugin-development\SKILL.md:31`
  > Bundled packages resolve from the dsh installation and profile-installed bundles from the profile, so never guess the path from `$DSH_PROFILE_DIR`.
- `$ASAR\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md:18`
  > Packages shipped with dsh resolve from the dsh installation, so the bundle declares no dependencies on them.
- `$DSH\README.zh.md:46`
  > `dsh.profile.bundles` 中列出的组合包先从 dsh 安装目录解析（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-sdk-app`、`@deepseek-ai/dsh-sdk-minimal`、`@deepseek-ai/dsh-acp-app`），再从 profile 自身的 `node_modules` 解析；pnpm 会将树外插件安装到该目录。

### 1.5 profile 侧清单：`dsh.profile.bundles`

- 定义与观察：`$PROFILE\package.json:17-38` — `dsh.profile.bundles` 是 16 个名字的**有序**数组。
- `$DSH\README.zh.md:37`
  > profile 目录包含一个 `package.json`，其中记录树外插件依赖，以及 profile manifest `dsh.profile`、其中按顺序排列的 `bundles` 列表；还包含一个 `cordis.patch.yml`，其中保存用户自己的 patch 层。
- 读取代码：`$ASAR\dsh-plugin-manager\lib\index.js:285` `const selected = manifest.dsh?.profile?.bundles ?? [];`
- 写入代码：`$ASAR\dsh-plugin-manager\lib\index.js:755-776`（`selectBundle`），`enabled` 时 append、关闭时 filter 掉；只在真的变化时才写。
- 关掉**保留依赖**、重开**追加到列表末尾（可能改变配置优先级）**：`$ASAR\dsh-plugin-manager\README.zh.md:40`
  > 插件开关只更新 profile 的 `cordis.patch.yml` 中最后一条匹配覆盖项的 `disabled`；没有匹配项时追加。匹配依据是条目 id，以及覆盖项声明的模块名称。组合包开关修改 `package.json` 的有序 `dsh.profile.bundles` 列表。关闭保留依赖；开启追加到列表末尾，可能改变配置优先级。安装新组合包默认启用。

---

## 2 cordis 装配

### 2.1 `cordis.yml` 不是编辑点

`$PROFILE\cordis.yml` 全文（4 行）：
```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

### 2.2 层顺序（权威）

- `$DSH\README.zh.md:42-43`
  > - `dsh.profile.bundles` 中各组合包的 patch
  > - profile 自身的 `cordis.patch.yml`，然后是 home 级的 `$DSH_HOME/cordis.patch.yml`
- `$ASAR\dsh-app-boot\README.zh.md:61`
  > **`cordis.patch.yml`**——你的 tweak 层，应用在所有组合包层之后（先应用逐 profile 的文件，再应用 home 级文件，因此后者优先级更高）：替换某个条目的整个配置（重述你要保留的字段）、插入新条目，或在启动时插值 `!!js` 表达式。patch 指定的条目不存在时输出 stderr 警告；**空文件或仅含注释的文件会导致启动失败**——如需禁用该层，请改用 `[]`。
- 生成的 JSON Schema 里的同一句话：`$ASAR\dsh-app-boot\lib\index.js:2923`
  > `$comment`: "Bundle, profile, home, and CLI layers apply in that order. A patch config replaces the whole config. ..."
- profile 的 patch 模板常量（与 `$PROFILE\cordis.patch.yml:1-3` 逐字一致）：`$ASAR\dsh-app-boot\lib\index.js:558-562`
  ```js
  const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
  # a top-level YAML array of loader patch entries (id-targeted config
  # overrides, disables, and insert lists; \`!!js\` expressions allowed).
  []
  `;
  ```

### 2.3 `insert` 条目的 `id` / `name` / `config` 语义

**条目字段定义**（`$ASAR\cordis-plugin-loader\src\config\entry.ts:9-23`，该包把 TypeScript 源码一起发布了）：
```ts
/** Serialized plugin entry options stored in loader config files. */
export interface EntryOptions {
  /** Stable id inside the containing entry tree. */
  id: string
  /** Module specifier imported by the entry tree. */
  name: string
  /** Config passed to the plugin. */
  config?: any
  /** Marks this entry as a nested group. */
  group?: boolean | null
  /** Prevents this entry and descendants from running. */
  disabled?: boolean | null
  /** Required services or service intercept config for this entry. */
  inject?: Inject | null
}
```
由 app-boot 的 JSON Schema 补齐另外两个字段（`$ASAR\dsh-app-boot\lib\index.js:2721-2753`）：`intercept: { type: ["object","null"] }`、`isolate: { type: ["object","null"], additionalProperties: { anyOf: [{const:true},{type:"string"}] } }`。`id` 的描述原文：`"Entry id. Loader generates an id when an entry omits it; patches use the configured id."`（**条目可省 `id`，patch 不行**）。

**patch 结构**（`$ASAR\dsh-app-boot\lib\index.js:2755-2762`）：
```js
function patchStructure() {
	return {
		type: "object",
		allOf: [ref("entryMetadata")],
		properties: { insert: ref("entryList") },
		description: "An insert appends entries, optionally inside the group identified by id. Other patches replace supplied fields; config is replaced wholesale, not deep-merged. A truthy name asserts the existing plugin name rather than renaming it. Unknown targets and non-insert patches without a nonempty id are warned and skipped."
	};
}
```

**执行语义**（`$ASAR\dsh-app-boot\lib\index.js:47-104`，注释自称 "THE patch semantics of this include"）：
```js
function applyEntryPatches(data, patches, warn) {
	if (!patches?.length) return [...data];
	data = structuredClone(data);
	const entryMap = new Map();
	const buildMap = (entries) => {
		for (const entry of entries) {
			if (entry.id) entryMap.set(entry.id, entry);
			if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
		}
	};
	buildMap(data);
	for (const patch of patches) {
		const { id, insert, name, ...overrides } = patch;
		if (insert) {
			if (id) {
				const target = entryMap.get(id);
				if (!target) { warn("patch insert: entry %C not found", id); continue; }
				if (!target.group) { warn("patch insert: entry %C is not a group", id); continue; }
				if (!Array.isArray(target.config)) target.config = [];
				target.config.push(...insert);
			} else data.push(...insert);
			buildMap(insert);
			continue;
		}
		if (!id) { warn("patch: id is required for non-insert patches"); continue; }
		const target = entryMap.get(id);
		if (!target) { warn("patch: entry %C not found", id); continue; }
		if (name && name !== target.name) { warn("patch: name mismatch for %C ...", id, target.name); continue; }
		for (const [key, value] of Object.entries(overrides)) { ... }
```
要点归纳：
- `insert` **无 `id`** → 追加到根条目列表（`data.push(...insert)`）。
- `insert` **有 `id`** → 目标必须存在且 `group` 为真，否则告警跳过；追加到 `target.config`。
- **插入的条目立即进索引**（`buildMap(insert)`），所以同一 patch 列表里靠后的 patch 可以指向靠前插入的行。
- 非 insert patch：必须有非空 `id`；`name` 是**断言**（不匹配就跳过，不改名）；`config` **整体替换**。
- 该方法在挂载（`applyPatches`）与离线工具（`dsh --dump-config`）间共用，注释称「so a dump can never drift from what boots」。

**官方 skill 的同义表述**（`$ASAR\dsh-agent-preset\skills\cordis-composition-reference\SKILL.md:12-23`）：
> - `insert: [rows]` appends rows; with an `id` naming an existing `group: true` row, the rows are appended inside that group's `config` list.
> - A patch with an `id` and no `insert` targets the existing row with that id. Supplied fields replace the row's fields; `config` is replaced wholesale, never deep-merged, so restate every field the row needs. A truthy `name` asserts the existing plugin name rather than renaming it.
> - Non-insert patches without a nonempty `id`, and targets that match no row, are warned about and skipped.
> - A row has `id`, `name` (the plugin package specifier; inserted relative paths are anchored beside their patch file), optional `config`, and optional `disabled`, `inject`, `intercept`, and `isolate`.
> - `group: true` with `name: cordis:group` makes `config` a nested entry list and allows patches to insert into it by id. `cordis:include` loads a literal YAML or JSON entry list from `config.path`.
> - `disabled` accepts a boolean, null, or a `!!js` expression evaluated against the Loader context at every mount decision.
> - `!!js` scalars are Loader expressions, never `!js`.

**`insert` 里的 `name` 可以是路径**（`$ASAR\dsh-app-boot\README.zh.md:65`）：
> 插入条目的插件名可以是绝对文件系统路径、文件 URL 或包标识符。patch 加载会把 `insert` 条目及其嵌套分组中的绝对路径以及相对于 patch 文件的 `./` 或 `../` 路径转换为文件 URL；对已有条目名称的断言及替换用的 `config` 值保持原样。

**本机真实 bundle patch 范例**（`$DECK\cordis.patch.yml`，14 行，带完整中文注释）：
```yaml
- insert:
    - id: dsh-mattpocock-skills-deck
      name: 'dsh-mattpocock-skills-deck'
      config: {}
    - id: dsh-mattpocock-skills-deck-tools
      name: 'dsh-mattpocock-skills-deck/tools'
      config: {}
```
其中 `name` 用到了 `exports` 子路径（对应 `$DECK\package.json:21` `"./tools": "./lib/platform/deckToolsRow.js"`），说明**一个包可以插多个行，行名可以是包的 exports 子路径**。同文件 `id` 与 `name` **故意不同**（`-tools` 后缀），即 id 是自由标识符、不必等于包名。
对比 `$SAMPLE\cordis.patch.yml`（3 行，`id` 与 `name` 也不同）：
```yaml
- insert:
    - id: webnovel
      name: '@linfengqaqtat/dsh-scriptor'
```

### 2.4 插件模块导出形态

**权威**：`$ASAR\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md:47-54`
> `index.js` exports one of these forms; **do not mix them**:
> - `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
> - A service class as the default export.
>
> Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup. A plugin that declares `Config` validates the row's `config` at activation; query `Config.listConfigs` for an installed plugin's schema before writing its `config`, and follow `$defs` references in the returned document.

**加载器侧实现**：`$ASAR\cordis-plugin-loader\src\config\entry.ts:221-235`
```ts
private async _init() {
    let exports: any
    try {
      exports = await this.parent.tree.import(this.options.name, this.getOuterStack)
    } catch (error) { this.ctx.logger.error(error); return }
    finally { this._initTask = undefined }
    const plugin = this.loader.unwrapExports(exports)
    this._patchContext([])
    this.loader.showLog(this, 'apply')
    this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack).ctx.fiber
}
```
即：按 `name` import 模块 → `unwrapExports` 归一化导出（这一步就是「函数 / default class」两种形态的收口）→ `registry.plugin(plugin, config)` 挂载。

**本机实证（cordis 插件函数 + `apply` + 具名导出）**：`$SAMPLE\lib\index.js`
- `21932: function apply(ctx) {`
- `21933: ctx.logger.info("\u5DE5\u4F5C\u53F0\u63D2\u4EF6\u5DF2\u52A0\u8F7D\uFF08webnovel bundle\uFF09");`（即 `[webnovel-bundle] 工作台插件已加载`）
- 末尾 `22226-22241`：
  ```js
  export {
    agentWorkspaceRoot,
    analyzeImpactCli,
    apply,
    ...
    name,
    ...
  };
  ```
  即**具名导出 `apply`（不是 default）**，与 `host-plugin.md` 的第一种形态一致；`name` 具名导出也在列（`22235`）。

**UI 插件的极简形态**：`$ASAR\dsh-agent-preset\skills\cordis-plugin-development\references\ui-plugin.md:5`
> `index.js` exports `export function apply() {}`; the patch inserts one row named after the package.

### 2.5 装配发生在启动期还是运行期

**两者都有**：启动期组合并挂载；运行期增量对账（HMR 或插件开关触发重新组合）。

- 启动期：`$DSH\README.zh.md:5`
  > `dsh` 是唯一受支持的 Node 应用启动器；profile 由多个插件组合包 patch 层按顺序叠加而成，其上再应用用户自己的覆盖配置。
- 随附模板的重载策略（`$ASAR\dsh-app-boot\README.zh.md:50`）：
  > YAML 组合决定是否启用 HMR。**随产品交付的 `web` 模板实时重载，其他随附模板只在启动时应用 patch。**
- HMR 触发重新组合（`$ASAR\dsh-app-boot\README.zh.md:63`）：
  > 启用的 `dsh-hmr` 插件会监视 profile manifest 与两份用户 patch 文件，重新读取按顺序排列的组合包层，并应用重载失败策略。DSH HMR 将这些重载与插件管理器的配置写入串行化；包操作在其队列之外执行。**启动器不安装 HMR 或监视器；HMR 被禁用或不存在时，更改需要重启。**
- 插件管理的总述（`$ASAR\dsh-plugin-manager\README.zh.md:14`）：
  > 在 YAML 中启用 HMR 时，配置变化立即生效；**未启用 HMR 时，运行中的组合保留到重启**。改动影响使用该 profile 的全部会话。
- 浏览器半侧是**惰性**的（`$ASAR\dsh-client-modules\README.zh.md:12`）：
  > 插件 bundle 惰性执行——运行 bundle 只注册 factory，模块副作用在物化时运行——因此插件首次被使用之前什么都不会运行。

**「live profile」与「需重启」的分界**（散见多处，汇总如下）：

| 操作 | 生效方式 | 证据 |
|---|---|---|
| 启用/停用插件条目、选择组合包 | HMR 开着即生效，否则重启 | `$ASAR\dsh-plugin-manager\README.zh.md:14` |
| 新装 bundle | 可通过 HMR 激活 | `host-plugin.md:60` |
| 授权版本豁免 | 在线 profile 重新组合并报告 `applied`；仅启动型 profile 报告 `restart-required` | `$ASAR\dsh-plugin-manager\README.zh.md:67` |
| **替换已装包（升级同一包名）** | **必须重启进程**才能加载新的 JS 模块版本 | `$ASAR\dsh-plugin-manager\README.zh.md:130`；`host-plugin.md:60` |
| 仅启动时加载的 profile | 不能删当前进程启动时使用的包，须停进程后用 `dsh plugin` | `$ASAR\dsh-plugin-manager\README.zh.md:131` |

（本机 `desktop` profile 属于 Electron 持有的 profile：`$DSH\README.zh.md:20`「`desktop` 名称保留给 Electron 持有的 profile」；`$ASAR\dsh-plugin-manager\README.zh.md:135`「Desktop 包管理操作仍由 Desktop shell 负责。」）

### 2.6 `dsh plugin --profile <p> add` 写到哪里

**结论：写 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`）与 `pnpm-lock.yaml`、`node_modules`；不动 `cordis.yml`，也不动 `cordis.patch.yml`。**

1. CLI 就是转发 pnpm（`$DSH\README.zh.md:18`）：
   > `dsh plugin --profile <name> <pnpm args>` | 通过在 profile 目录中转发给 pnpm 来管理该 profile 的插件。
   本机实测确认（`dsh plugin --profile desktop --help` 原样打印 pnpm 11.7.0 帮助，说明 `--help` 被透传）。
2. Desktop 侧入口是 Electron 自带的 Node + 自带 pnpm（`$ASAR\dsh-desktop-host\lib\cli.js:91-105`）：
   ```js
   async function runDesktopCli(runtimeDir, supportDir) {
     installOfficeEngineResolution(runtimeDir);
     await runCli({
       manageDesktopProfile: true,
       packageManager: {
         command: process.execPath,
         args: ["--expose-internals", join(supportDir, "pnpm", "bin", "pnpm.mjs")],
         env: { ELECTRON_RUN_AS_NODE: "1", DSH_DESKTOP_NODE_EXECUTABLE: process.execPath, PATH: `${join(supportDir, "bin")}${delimiter}${process.env.PATH ?? ""}` }
       }
     });
   }
   ```
   （`dsh.cmd` 实体：`"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*`，见 `...\resources\runtime\cli\bin\dsh.cmd`。）
3. DSH 自有子命令在转发前被截走（`$DSH\lib\plugin-BGnVfe_D.js:14-16`）：只有 `allow-version` / `revoke-version` / `version-exemptions` 是 DSH 自己解析，**其余参数全部归 pnpm**。
4. 其余参数走 `runProfilePnpm`，`cwd` = profile 目录（`$DSH\lib\plugin-BGnVfe_D.js:72-93`）：
   ```js
   const dir = resolveProfileDir(profile);
   ...
   const context = { profile, dir, installAnchor: INSTALL_ANCHOR, cwd: process.cwd() };
   const options = { ...packageManager, execution: "cli", outputBytes: 16384, lockWaitMs: 12e4, lookupTimeoutMs: 12e4, onOutput: ... };
   ```
5. **pnpm 跑完后由 `reconcile` 补写 `dsh.profile.bundles`**（`$ASAR\dsh-plugin-manager\lib\types\operations.js:43-72`，函数注释「Reconcile package removals and newly installed bundles without re-enabling retained dependencies.」）——新依赖若声明了 `dsh.bundle` 就 `bundles.push(name)` 并校验其 patch 文件，否则只打「plain dependency」警告；确有变化才写回。
6. 写回是**原子写**（`$ASAR\dsh-plugin-manager\lib\types\operations.js:36-42`）：
   ```js
   export async function saveManifest(dir, manifest) {
       await writeFileAtomic(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n', { mode: 0o600 });
   }
   ```
7. profile 初始化（无随附模板时）：`$ASAR\dsh-plugin-manager\lib\types\operations.js:526-537` → `initProfile(dir, template?.bundles ?? DEFAULT_PROFILE_BUNDLES)`，其中 `DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]`（`$ASAR\dsh-app-boot\lib\index.js:543`）。初始化同时写 `cordis.patch.yml` 模板与 `pnpm-workspace.yaml`（`$ASAR\dsh-app-boot\lib\index.js:558-568`，后者内容为 `packages: ['.']` + `nodeLinker: hoisted` + `autoInstallPeers: false`，与 `$PROFILE\pnpm-workspace.yaml` 前几行逐字一致——本机文件在其后追加了 `allowBuilds` 与 `minimumReleaseAgeExclude`）。
8. 全程持 profile 写锁（`withFileLock(join(dir, 'package.json'), ...)`，`$ASAR\dsh-plugin-manager\lib\types\operations.js:529`）。

---

## 3 工具注册契约

### 3.1 宿主注册 API 的完整签名

来源：**运行中的 Inspect `Service` 契约**（`cordis_inspect_query(platform=host, provider=Service, service="tools")`），这是活体真源，比任何静态文件都权威。

`ctx.tools` 服务描述原文：
> Tool registry and execution pipeline. **Scoped registrations shadow globals**; one visibility resolver feeds presentation, lookup, and dispatch.

| 方法 | 说明（摘原文） |
|---|---|
| `register(definition: ToolDefinition): () => void` | "Register globally or in the calling agent scope. Scoped tools shadow globals; duplicates within one layer and **the reserved `run_code` name fail**." 返回 "the exact disposer that unregisters the tool." |
| `restrict(filter: ToolRestriction): () => void` | "Restrict **global** tools for the calling agent scope. Empty filters, unknown names, **scope-local names**, and reserved transport names fail. Restrictions intersect; **scoped registrations remain visible**." |
| `guard(guard: ToolGuard): () => void` | "Register a **monotonic** guard after the extensible `tools/pre-execute` waterfall. A plain-context guard applies globally; one registered through `agent.ctx` applies only to that agent. Any matching guard may deny by returning a reason, while **no guard can force-allow a call another guard denied**." |
| `get(name: string, scope?: ScopeKey): ToolDefinition \| undefined` | "Look up a tool as one scope sees it (scoped shadows global; a restricted-away global reads as absent)." |
| `schemas(scope?: ScopeKey): ToolSchema[]` | "Project visible definitions onto the allowlisted model-facing schema fields, **excluding execution and presentation callbacks**." |
| `executionMode(exec: ToolExecutionInput): ToolExecutionMode` | "Only an exact `true` is parallel; unknown, hidden, undeclared, invalid, or throwing classifiers are exclusive."（fail-closed） |
| `execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>` | 走 pre-policy → guards → around-dispatch → post-policy → 定义自有的 content finalization → 最终通知。不可见工具报 `UNKNOWN_TOOL`。 |
| `presentAs(mode: ToolPresentationMode): () => void` | "Present the calling scope's tools in `mode` instead of the deployment default. Nearest scope on the chain wins... **Scoped only, and one declaration per scope**" |

访问形态：可选 `ctx.get("tools")`（需 undefined 检查）／硬依赖 `inject: ["tools"]` + `ctx.tools`。
另有配置项（`$ASAR\dsh-tools\README.zh.md:72-76`）：`mode` 默认 `native`（可选 `native`/`ptc`/`both`）、`maxParallelSubCalls` 默认 `10`。

### 3.2 `ToolDefinition` 与相关类型的精确定义

同一 Inspect 契约返回的 `referencedTypes` 原文（逐字）：

```ts
export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}

export interface ToolSchema {
    deferLoading?: true;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode;
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}

export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    readonly schema?: ToolSchema;
    readonly arguments: unknown;
    readonly agent?: Agent;
    readonly parent?: ToolExecutionToken;
    readonly signal: AbortSignal;
}

export interface ToolExecution extends ToolExecutionInput {
    readonly rootCallId: ToolCallId;
    readonly token: ToolExecutionToken;
}

export interface ToolRunContext extends ToolExecution {
    deferContext(context: UserMessage): void;
    concludeTurn(): void;
}

export interface ToolRestriction {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
}

export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
export type ToolPresentationMode = 'native' | 'ptc' | 'both';
export type ScopeKey = object;
```

### 3.3 `parameters` / `output` 的 schema 形态 —— **JSON Schema，不是 zod，也不是 schemastery**

**结论：`parameters` 的静态类型是 `Record<string, unknown>`，即一个原始 JSON Schema 对象。`defineTool` 的 DSL 只是作者侧的糖，会被编译成同一份 JSON Schema；直接 `register` 时传原始 schema 也是合法且被本机大插件实际采用的写法。**

- `ToolSchema.parameters: Record<string, unknown>`（上表，逐字）。**没有** zod / schemastery 类型出现在这里。
- `output.schema: JsonSchemaNode`，而 `JsonSchemaNode` 的定义（同一契约）明确是 JSON Schema 子集：
  ```ts
  export interface JsonSchemaNode {
      type?: JsonSchemaType;
      oneOf?: JsonSchemaNode[];
      properties?: Record<string, JsonSchemaNode>;
      required?: string[];
      additionalProperties?: boolean;
      items?: JsonSchemaNode;
      enum?: JsonSchemaScalar[];
      const?: JsonSchemaScalar;
      description?: string;
      title?: string;
      default?: JsonValue;
      examples?: JsonValue;
  }
  export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  ```
- 两个 DSL 并存且等价，官方原话（`$ASAR\dsh-tools\README.zh.md:60`）：
  > 统一 schema DSL 支持 `string`、`number`、`integer`、`boolean`、`null`、`array`、`object`、仅供作者使用的 `json` 与恰好匹配一个分支的 `oneOf`；`InferValue` 在 16 层容器内保留精确类型，之后加宽为 `JsonValue`。**原始 JSON Schema（`JsonSchemaNode`）是与 subagent、工作流和 MCP 共享的协议级对应类型。**
- DSL 形态的官方范例（`$ASAR\dsh-tools\README.zh.md:41-57`，注意 `required` 是**属性级布尔**而非数组级列表）：
  ```ts
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute file path' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // args is typed: { path: string; offset?: number; limit?: number }
      return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
    },
  }))
  ```
- 内置工具的真实 DSL 用法：`$ASAR\dsh-tool-todo\lib\index.js:95-142`（`ctx.tools.register(defineTool({ name: "todo_write", description: describe(allowParallel), parameters: { todos: { type: "array", required: true, description: "...", items: { type: "object", additionalProperties: false, properties: { content: { type: "string", required: true, ... }, status: { type: "string", required: true, enum: [...STATUSES], ... } } } } }, output: { schema: { type: "object", additionalProperties: false, properties: { todos: { type: "array", required: true, items: { ... } } } } ...`）——与 README 范例同形。
- **schemastery 属于 Cordis 的「插件 Config」而非工具 `parameters`**：profile 的 `node_modules\@deepseek-ai\` 下确实只有 `cosmokit` 与 `schemastery`（实测枚举），且 `$ASAR\cordis-plugin-loader\README.md:52` 谈 Config 比较时用的是「Schemastery metadata」「a non-Schemastery schema compares raw」。**不要**把工具参数写成 schemastery。
- **本机大插件走的是「直接传原始 JSON Schema」这条路**（不经 `defineTool`）：`$SAMPLE\lib\index.js:22016-22022`
  ```js
  const off = registry2.register({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: tool.output,
    execute: async (args, exec) => tool.execute(args, toExecContext(exec))
  });
  ```
  且它在更早处对参数做了防御性深拷贝：`$SAMPLE\lib\index.js:17654` `parameters: structuredClone(parameters),`。

### 3.4 `exec` 上下文的字段

以 `ToolRunContext` 的声明为准，并由 `$SAMPLE` 的适配函数逐字印证（`$SAMPLE\lib\index.js:21918-21931`）：
```js
function toExecContext(exec) {
  return {
    agent: exec.agent,
    name: exec.name,
    arguments: exec.arguments,
    callId: exec.callId,
    rootCallId: exec.rootCallId,
    token: exec.token,
    parent: exec.parent,
    signal: exec.signal,
    deferContext: exec.deferContext?.bind(exec),
    concludeTurn: exec.concludeTurn?.bind(exec)
  };
}
```
要点：
- **模型参数在 `exec.arguments`，不是 `exec.args`**；`execute` 的第一个形参才是已校验的类型化参数值（README：`async execute(args, exec)`）。
- `exec.signal` 是协作式取消信号；`$ASAR\dsh-tools\README.zh.md:123`：「每个工具主体都收到调用方拥有的 `exec.signal` 且必须观测它；调用主体前的取消为 `ABORTED_BEFORE_DISPATCH`，调用主体后的取消只能把成功结果替换为 `ABORTED`。」
- `exec.deferContext(context: UserMessage)` / `exec.concludeTurn()` 是仅在 `ToolRunContext`（工具主体）上提供的两个动作。
- 契约里 `agent?: Agent` 是 `{ readonly id: SessionId }`（`export interface Agent { readonly id: SessionId; }`）——**这是精简投影，真实运行时的 agent 对象有 `ctx`、`session` 等更多字段**（`$SAMPLE` 直接用了 `agent.ctx`、`agent.session?.header?.id`、`agent.id`，见 `$SAMPLE\lib\index.js:22115`、`22004`、`22116`）。

### 3.5 返回的 `off` 语义

**结论：`off` 是「精确撤销器」（exact disposer）——调用它即注销这一个注册，且与注册一一对应。**

- 契约原文（`register`）：`returns: "the exact disposer that unregisters the tool."`
- 同理 `restrict` → "the exact disposer that lifts this restriction."；`guard` → "the exact disposer that unregisters the guard."；`presentAs` → "the exact disposer that restores the deployment default."
- **`register` 的 `off` 可能不是函数**，健壮写法必须判类型——`$SAMPLE\lib\index.js:22023`：
  ```js
  if (typeof off === "function") offs.push(off);
  ```
- 卸载时要**逆序**调用并逐个 try/catch——`$SAMPLE\lib\index.js:22029-22046`：
  ```js
  function disposeAllAgentTools() {
    for (const offs of agentToolOffs.values()) {
      for (const off of offs.reverse()) { try { off(); } catch { } }
    }
    agentToolOffs.clear();
    for (const off of agentRestrictOffs.values()) { try { off(); } catch { } }
    agentRestrictOffs.clear();
  }
  ```
- 更一般的 Cordis 约定（`host-plugin.md:54`）：「Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup.」

### 3.6 子 Agent 场景下的 scoped 注册与 `restrict`

**取 scoped registry 的方式**：`agent.ctx.get("tools")`（不是全局 `ctx.tools`）。`$SAMPLE\lib\index.js:21897-21910`：
```js
function agentCtxGet(agent, name2) {
  const agentCtx = agent.ctx;
  if (agentCtx === void 0) return void 0;
  const get = agentCtx["get"];
  if (typeof get === "function") {
    try { return get.call(agentCtx, name2); } catch { return void 0; }
  }
  const direct = agentCtx[name2];
  return direct === void 0 ? void 0 : direct;
}
```
`registerToolsInto` 里用同一个 helper 拿 registry 并做能力探测（`$SAMPLE\lib\index.js:22009-22028`）：
```js
function registerToolsInto(agent) {
  if (toolKit === void 0) return false;
  if (agentToolOffs.has(agent.id)) return true;
  const registry2 = agentCtxGet(agent, "tools");
  if (registry2 === void 0 || typeof registry2.register !== "function") return false;
  ...
}
```

**主 Agent / 子 Agent 的分工**（`$SAMPLE\lib\index.js:22123`、`22140-22143`、`22190-22193`）：
```js
const isSubagent = !isMainAgent(agent);
...
if (!isSubagent) {
  ...
  registerToolsInto(agent);          // 主 Agent：scoped 注册写作工具
} else {
  restrictNovelToolsInto(agent);     // 子 Agent：只做 restrict
  enforceChildApproval(agent);
}
```
主 Agent 判定（`$SAMPLE\lib\index.js:21911-21917`）：
```js
function isMainAgent(agent) {
  const registry2 = agentCtxGet(agent, "agents");
  if (typeof registry2?.get === "function" && typeof registry2.roots === "function") {
    return registry2.get(agent.id) === agent && registry2.roots().includes(agent);
  }
  return agent.session?.header?.origin !== "subagent";
}
```

**`restrict({ deny })` 的确切行为**（`$SAMPLE\lib\index.js:22057-22070`）：
```js
function restrictNovelToolsInto(agent) {
  if (toolKit === void 0) return false;
  if (agentRestrictOffs.has(agent.id)) return true;
  const tools = agentCtxGet(agent, "tools");
  if (typeof tools?.restrict !== "function") return false;
  try {
    const offRestrict = tools.restrict({ deny: toolKit.defs.map((tool) => tool.name) });
    if (typeof offRestrict === "function") agentRestrictOffs.set(agent.id, offRestrict);
    return true;
  } catch (err) {
    ctx.logger.warn(`[webnovel-bundle] 子 Agent 工具 restrict 暂不可挂（${agent.id}）：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
```
**必须注意三个坑**（都能在契约描述里对上）：
1. `restrict` 只能约束**继承来的全局工具**；「scope-local names fail」——若同名工具是作用域内注册的，`restrict` 会**抛错**。上面整段包在 try/catch 里正是为此。
2. 「Restrictions intersect」——多次 `restrict` 是**交集**，不是覆盖。
3. 「scoped registrations remain visible」——scoped 注册的工具**不受 restrict 影响**，所以「给子 Agent 屏蔽某工具」只能靠「不给它的 scope 注册」而不能靠 restrict 屏蔽同名 scoped 工具。

**作用域层级如何生效**（契约原文）：`register` 在「calling agent scope」注册，scoped 工具**遮蔽**全局同名工具（shadow globals），同一层内重复注册会失败。

### 3.7 执行流水线（策略挂钩点）

`$ASAR\dsh-tools\README.zh.md:105`：
> 每次调用都运行一条固定流水线：`tools/pre-execute`（可扩展的允许／拒绝／询问）→ 已注册单调守卫 → `tools/execute`（环绕分发包装层）→ `tools/post-execute`（检查／替换、附加上下文）→ 由定义持有的 `finalizeContent` → 仅观测的 `tools/result` 事件。只有 `tools/execute` 视图可以替换必填信号，注册表会在调用主体前重新融合调用方信号。

`$ASAR\dsh-tools\README.zh.md:87`：
> 工具的 `projectContent` 在执行后策略之前安装执行期间准备的图文内容。策略仍可替换或阻止这些内容；`finalizeContent` 保留为策略之后的最终内容处理。

`off` 的定位（`$ASAR\dsh-tools\README.zh.md:81`）：「限制在 dispose（资源释放）时解除。」——即 `restrict` 的 disposer 与 Cordis fiber 的生命周期绑定。

---

## 4 skills 装载

### 4.1 插件自带 skills 目录如何被 DSH 发现

**结论：插件不自造发现逻辑，而是挂载官方 `@deepseek-ai/dsh-skill-filesystem` 提供方，并把自带目录作为 `bundledSkillDir` 传进去（rank 600）；`includeDefaultRoots: false` 可让它只看到自带根。**

本机实证（`$SAMPLE\lib\index.js:21932-21947`）：
```js
function apply(ctx) {
  ctx.logger.info("工作台插件已加载（webnovel bundle）");
  const bundledSkillDir = fileURLToPath(new URL("../skills/", import.meta.url));
  if (typeof ctx.inject !== "function" || typeof ctx.plugin !== "function") {
    ctx.logger.warn("[webnovel-bundle] 随包技能未挂载：宿主缺少 inject/plugin 能力，请核对 DSH 版本。");
  } else if (!existsSync25(bundledSkillDir)) {
    ctx.logger.warn(`[webnovel-bundle] 随包技能未挂载：安装包缺少技能目录 ${bundledSkillDir}`);
  } else {
    ctx.inject(["skills"], (scope) => {
      scope.plugin(skillFilesystem, {
        providerName: "webnovel-bundled",
        includeDefaultRoots: false,
        bundledSkillDir
      });
    });
  }
  ...
```
配套证据：
- import 位置：`$SAMPLE\lib\index.js:7367` `import * as skillFilesystem from "@deepseek-ai/dsh-skill-filesystem";`（**命名空间导入整个模块直接当插件用**）。
- 依赖声明：`$SAMPLE\package.json:91` devDependency、`:123` peerDependency 均为 `@deepseek-ai/dsh-skill-filesystem: 0.2.0-rc.2`。
- 打包包含：`$SAMPLE\package.json:107` `"skills/**/*"`。
- 提供方需要 `ctx.skills`（`$ASAR\dsh-skill-filesystem\README.zh.md:60`）：
  > 与 skill 注册表一起加载该插件；它需要 `ctx.skills`。
- 推荐挂载写法（`$ASAR\dsh-skill-filesystem\README.zh.md:62-65`）：
  ```yaml
  - name: '@deepseek-ai/dsh-skill'
  - name: '@deepseek-ai/dsh-skill-filesystem'
  ```

### 4.2 完整配置字段（`$ASAR\dsh-skill-filesystem\README.zh.md:67-76`）

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `filesystem` | 注册到 `ctx.skills` 的唯一提供方名称 |
| `includeDefaultRoots` | `true` | 在 `customSkillDirs` 周围包含项目根与用户根 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | Harness 配置根目录；扫描其 `skills` 子目录 |
| `agentsHome` | `$DSH_AGENTS_HOME` 或 `~/.agents` | 为兼容 skill 扫描的共享 agent 配置根目录 |
| `customSkillDirs` | `[]` | 其他本地 skill 根目录，位于项目根之后、用户根之前 |
| `watch` | `true` | 监视本地根，并在目录可能变化时使提供方失效 |
| `bundledSkillDir` | — | 配置后按 **rank 600** 扫描的随包提供的 skill 根目录 |

「其余 `watch*` 字段用于调节 Chokidar 行为——轮询、稳定窗口、间隔、项目上限与符号链接跟随。」（同页 `:77`）

### 4.3 根目录与优先级（rank 表，`$ASAR\dsh-skill-filesystem\README.zh.md:48-54`）

| Rank | 来源 | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | （`bundledSkillDir`） | 插件自带目录（**本仓库自建插件应占这一档**） |

- `$ASAR\dsh-skill-filesystem\README.zh.md:56`：「项目根目录是**包含 `.git` 的最近祖先目录**；如果不存在，则使用当前 cwd。用户 DSH 根目录会跳过其 `.system` 子目录。`includeDefaultRoots: false` 会省略项目根、用户根以及 `$DSH_BUNDLED_SKILL_DIR` 默认值，使隔离提供方只看到自身配置的根；`bundledSkillDir` 会按 rank 600 添加一个随包提供的根目录。」
- 同名冲突规则（`$ASAR\dsh-skill-filesystem\README.zh.md:12` 与 `skills` 服务契约）：读取时把全局层与查看作用域的链合并，**最近的层直接赢下同名**，rank 只决定同一层内的重复。

### 4.4 发现规则与 SKILL.md frontmatter 要求

`$ASAR\dsh-skill-filesystem\README.zh.md:36`（**最权威的一段**）：
> skill 可以是被扫描根目录顶层的目录 bundle `<name>/SKILL.md`，也可以是平铺文件 `<name>.md`；**刻意不支持发现嵌套的 `**/SKILL.md`**。文件以 YAML frontmatter 开头：**必填 `name` 与 `description`**，另有可选 `whenToUse`、`metadata`、`disable-model-invocation` 与 `user-invocable`。

补充约束：
- `$ASAR\dsh-skill-filesystem\README.zh.md:110`：「`name` 必须为 kebab-case，`description` 必填，调用键按严格布尔语法解析」。
- `$ASAR\dsh-skill-filesystem\README.zh.md:38`：
  > `disable-model-invocation: true` 会把 skill 从面向模型的目录和 loader 中排除；`user-invocable: false` 会把它从面向用户的命令中排除，省略的字段默认允许对应接口调用。这两个键接受 YAML 布尔值，以及不区分大小写的 `true`/`false`、`yes`/`no`、`on`/`off` 和 `1`/`0` 形式；**被拒绝的拼写或非布尔值会让整个 skill 随警告一起被丢弃**，而不会静默允许某个接口。
- 格式错误的条目**不会**产生逐 skill 诊断（`:85`、`:150`）：「模型目录不会收到逐 skill 诊断，无法区分缺失的 skill 与无效的 skill」。
- 发现深度限制（`:148`）：「**发现深度为一层**——只识别 `<root>/<name>/SKILL.md` 与 `<root>/<name>.md`；忽略嵌套 skill 树与包 manifest（元数据清单）。」
- 失效范围（`:81`）：「`references`、`scripts`、`assets` 等 bundle 资源下的编辑**不会触发**」目录刷新。

**本机 frontmatter 实例**：
- DSH 自带 skill 只用两个键（`$ASAR\dsh-agent-preset\skills\cordis-plugin-development\SKILL.md:1-4`）：
  ```yaml
  ---
  name: cordis-plugin-development
  description: Use when designing, reviewing, adding, enabling, disabling, installing, configuring, or debugging a plugin, bundle, feature, page, panel, tool, or MCP connection in the current Harness profile, including a shipped plugin that is disabled by default, and for any visual object, decoration, or widget request that names no other destination, which means an installed UI plugin rendered in the Harness Web UI.
  ---
  ```
  （这是**很长的一句话 description**，是给模型看的触发条件集合。）
- 运行时随附 skill 同形（`...\resources\runtime\office-skills\office-docx\SKILL.md:1-4`）：
  ```yaml
  ---
  name: office-docx
  description: Create, read, edit, and check Word documents (.docx), including reports, letters, and formatted tables. Use when a DOCX file is an input or requested deliverable. Load this skill before running Office commands. Use only bundled LibreOffice unless the user explicitly opts out; without that opt-out, do not search for another LibreOffice executable.
  ---
  ```
  ——`office-skills/` 正是**运行时侧自带 skill 根**的现成布局范例（三个 skill 目录各含一个 SKILL.md）。
- 第三方自带 skills 目录的布局（`$DECK\bundled-skills\`，实测 25 个 skill 目录）：每个目录一个 `SKILL.md`，可选 `references`/脚本类附件，并普遍带一个 `agents/openai.yaml`（**这是给其它宿主用的适配文件，不影响 DSH 发现**，例如 `bundled-skills\wayfinder\SKILL.md` + `bundled-skills\wayfinder\agents\openai.yaml`）。另有非 skill 的同级文件 `LICENSE`、`README.md`、`VERSION`——因为发现是「目录 bundle 或平铺 `<name>.md`」，这些非目录/非 md 条目被自然忽略。

### 4.5 skill 与 slash command 的关系

**结论：两者是两套独立注册表；skill 通过 `tools`（`skill` 工具）暴露给模型，通过 `commands`（人用命令）暴露给用户，`model-invocable` / `user-invocable` 两个开关分别控制这两条出口。**

- `skills` 服务（Inspect 契约原文）：
  > Layered registry of skill providers, the host+per-scope shape the tools registry established. A registration files into the layer of its calling context's scope (scopeOf): host rows and repository plugins land in the global layer, while a plugin mounted by an agent preset's standing composition lands in that preset's layer. ... It exposes **sorted invocation-neutral summaries** and loads full skill bodies on demand.
  方法：`registerProvider(create): () => void`、`register(skill: SkillRegistration): () => void`、`list(options): Promise<SkillSummary[]>`、`snapshot(options): Promise<SkillCatalogSnapshot>`、`get(name, options): Promise<SkillDefinition | undefined>`。
- 「invocation-neutral」正是分界线所在（`list` 的描述）：
  > List invocation-neutral skill summaries for a workspace. **Consumers apply model or user invocation policy at their operational boundary.**
- 两个策略字段的类型（Inspect 契约逐字）：
  ```ts
  export interface SkillInvocationPolicy {
      readonly modelInvocable: boolean;
      readonly userInvocable: boolean;
  }
  ```
  与 frontmatter 的 `disable-model-invocation` / `user-invocable` 一一对应。
- 模型的出口是 `skill` 工具（本会话可用工具列表里的 `skill` 工具即 `$ASAR\dsh-tool-skill`）：`$ASAR\dsh-skill-filesystem\README.zh.md:135`
  > 通过 `dsh-tool-skill` 间接影响模型；它把该提供方的可调用名称和有长度上限的描述渲染到初始目录或替换目录中，并把所选的当前指令正文与资源基底指引渲染到已保留工具历史中；路径、提供方 rank 与已禁用 skill 仍被隐藏。
- 用户的出口是 `commands` 服务（Inspect 契约）：`register(definition: CommandDefinition): () => void`，描述为 "Human-command registry."；另有 `@Remote list(agent)`、`find(agent, name)`、`@Remote async execute(agent, line, submittedAttachments, signal)`。
- 因此：**一个 skill 默认两条出口都开**（省略字段即允许）；`disable-model-invocation: true` 只关模型侧，仍可被人当命令调用；`user-invocable: false` 只关用户侧，模型仍可自行调用。

### 4.6 插件侧注册 skill 的另一种途径（不落盘）

若 skill 不来自磁盘，可直接向注册表注册运行时条目（Inspect 契约）：
```ts
register(skill: SkillRegistration): () => void
// SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {
//   readonly invocation?: SkillInvocationPolicy;
//   readonly provider?: string;
// };
```
优先级（契约原文）：「Project entries outrank runtime entries, which outrank user entries, within one layer. **Same-name runtime entries in one layer are first-wins**; a duplicate logs a warning and receives a no-op disposer so it cannot remove the winner.」
`SkillSource` 联合类型（契约逐字）：`'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})`。

---

## 5 安装与卸载行为

### 5.1 `dsh plugin --profile <p> add <spec>` 接受哪些 spec

**权威：`$ASAR\dsh-plugin-manager\lib\types\install-spec.js` 的 `parseInstallSpec()`（全文 87 行，模块头注释即「Reading an install spec before pnpm sees it」）。**

四种形态（函数返回的 `kind`）：

| kind | 触发条件 | 判定正则/逻辑（行号） |
|---|---|---|
| `path` | 绝对本地路径，或带 `file:` / `link:` 前缀的绝对路径，且**不以 `.tgz`/`.tar.gz` 结尾** | `:61-65` `const path = spec.replace(/^(?:file\|link):/, ''); if (path !== spec \|\| isAbsolute(path)) { ... return TARBALL_SPEC.test(path) ? {kind:'tarball',...} : {kind:'path', spec, path} }` |
| `tarball` | 绝对路径以 `.tgz`/`.tar.gz` 结尾；或 `http(s)://` URL 以 `.tgz`/`.tar.gz` 结尾 | `:16` `const TARBALL_SPEC = /\.(?:tgz\|tar\.gz)(?:#.*)?$/i;`；`:72-74` |
| `git` | host 简写 `github:`/`gitlab:`/`bitbucket:`/`gist:`；`git://`、`git+<scheme>://`、`git@host:`；或托管仓库 URL `https://host/owner/repo[.git][#ref]` | `:8-10` `GIT_SHORTHAND` / `GIT_URL` / `HOSTED_REPOSITORY_URL`；`:69-71` |
| `registry` | npm 包名，可带 `@range` | `:17-19` `PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/`，上限 214 字符；`:77-85` |

**被拒的形式**（抛 `InvalidInstallSpecError`，`reason` 是给人读的一句话）：

| 输入 | reason（原文） | 行号 |
|---|---|---|
| 空串 | `the package spec must not be empty` | `:59-60` |
| `./x`、`../x`、`file:./x` 等**相对路径** | `a local path must be absolute` | `:62-64`、`:67-68` |
| `https://…` 但既不是 git 仓库也不是 tarball | `a URL must point at a git repository or a tarball` | `:75` |
| 非法的包名（超长/非法字符/前导点或下划线等） | `not a package name the registry accepts` | `:80-82` |
| `foo@`（`@` 后为空） | `a version after @ must not be empty` | `:83-84` |

设计意图（`:48-56` 的 JSDoc 原文）：
> Read a spec into its form. **A path must be absolute**: the Host's working directory means nothing to the person typing into a browser, and a relative path resolved against the profile would point inside it.

`inspect(spec, options)` 会在安装前读出 spec 指向什么，失败码为 `invalid-spec`、`already-installed`、`not-found`、`not-a-package`、`not-a-bundle`、`network` 或 `unknown`（`$ASAR\dsh-plugin-manager\README.zh.md:46`）。

### 5.2 本地路径安装时 profile 侧发生什么

按时间顺序：

1. **兼容性检查在 pnpm 之前**（`$ASAR\dsh-plugin-manager\README.zh.md:63`）：
   > 点名软件包的安装命令（`add`，或带 spec 的 `install`）会在 pnpm 运行前完成检查：**本地路径直接读取其 `package.json`**，registry spec 通过 pnpm 的 registry 查询得到该范围选中的版本及其声明的 peer。**不兼容的 DSH peer 会在 pnpm 运行前使操作失败**，因此不会下载任何内容、不会运行构建脚本……git 或 tarball spec 必须先抓取，因此在安装后才判定：此时操作会恢复 profile 清单与锁文件，并按恢复后的锁文件重新安装……
2. **pnpm add 在 profile 目录执行**，`cwd` = `$PROFILE`（`$DSH\lib\plugin-BGnVfe_D.js:72`、`$ASAR\dsh-plugin-manager\lib\types\operations.js:526-537`）。结果是 profile `package.json` 的 `dependencies` 多一条 + `pnpm-lock.yaml` 更新 + `node_modules` 落地。
   **本机实证**（`$PROFILE\package.json.bak-1791011147386-gtp6a3` 与 `...-1791011106924-1o7w7f` 中的 15 条本地路径依赖，形态为 `link:`）：
   ```json
   "@dsh-external/dsh-attack-atlas": "link:D:/DS/dsh-redteam-model/plugins/dsh-attack-atlas",
   "@dsh-external/dsh-auto-advance": "link:D:\\DS\\dsh-redteam-model\\plugins\\dsh-auto-advance",
   ```
   （同一批备份里正斜杠与反斜杠两种写法并存，说明 spec 字符串被 pnpm 原样/规范化写入。）
3. **pnpm 成功后 `reconcile` 补写 `dsh.profile.bundles`**（`$ASAR\dsh-plugin-manager\lib\types\operations.js:43-72`）：
   - 新依赖声明了 `dsh.bundle` → `loadOverlayPatches` 校验它的每个 patch 文件，再把包名 append 进 `dsh.profile.bundles`；
   - 没声明 → 只打 `dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**不进 bundles**；
   - 已有条目中依赖已被移除的会被 filter 掉；名字没变就不写文件。
4. **原子写回 profile `package.json`**（`operations.js:40-42`，`writeFileAtomic(..., { mode: 0o600 })`），全程持 profile 写锁（`operations.js:529`）。
5. **不碰 `cordis.yml`、不碰 `cordis.patch.yml`**：bundle 的 patch 是组合期由 `loadProfileDirectory` 按 `dsh.profile.bundles` 顺序读入的层，不需要预先写进任何 profile 文件。这与 `$PROFILE\cordis.patch.yml:1-2` 的自述一致（它只列 `ui-settings-general`、`llm-pi-ai` 等**用户级覆盖**，16 个 bundle 的 insert 都不在其中）。

失败回滚（`$ASAR\dsh-plugin-manager\README.zh.md:54`、`:144`、`:150`）：
> 失败、被取消或装入了没有组合包 patch 的包的运行，会把 `package.json` 与 `pnpm-lock.yaml` 恢复原样
> 恢复只重写这两份快照文件；用户编写的 patch 配置、应用数据、诊断日志以及 pnpm 已下载的文件保持原样

### 5.3 live profile 与需重启的差别

见 §2.5 的表。核心分界：
- **组合层变化**（启用/停用行、选组合包、授权豁免）：HMR 开着 → `applied`，否则 → `restart-required`。本机 `desktop` 是 Electron 持有的 profile；随附 `web` 模板实时重载，其它模板仅启动期应用（`$ASAR\dsh-app-boot\README.zh.md:50`）。
- **同一包名的代码替换**：**必须重启进程**（`$ASAR\dsh-plugin-manager\README.zh.md:130`「替换已有包后需要重启进程，以加载新的 JavaScript 模块版本。」）。
- **只启动时加载的 profile**：不能删当前进程启动时用的包，须先停进程再用 `dsh plugin`（`:131`）。
- 授权豁免的两种答复（`:67`）：「在线 profile 会重新组合，被授权的插件会在当前会话中挂载，结果报告 `applied`；仅启动型 profile 在重启前保留当前条目并报告 `restart-required`。」
- 管理结果与浏览器同步失败是两件事（`:134`）：「管理结果描述 Host 激活状态。浏览器同步失败会在设置的插件列表中单独显示。」

### 5.4 卸载路径与残留

**卸载顺序（`$ASAR\dsh-plugin-manager\README.zh.md:148`）**：
> 卸载依次执行：**从 `dsh.profile.bundles` 移除组合包、卸载运行时贡献、执行 `pnpm remove`**。任一步失败都不继续执行后续步骤。

失败行为表（`:142-146`）：

| 失败操作 | 处理方式 |
|---|---|
| 安装：pnpm 执行或组合包校验失败 | 恢复 pnpm 运行前快照的 `package.json` 与 `pnpm-lock.yaml`；pnpm 已下载的文件可能保留。报告安装失败。 |
| 启用：保存选择项或加载失败 | 保留已安装的依赖和已保存的选择项。报告启用失败，允许修正、停用或卸载。 |
| 卸载：任一步失败 | 停在失败步骤，保留已完成的改动和待重试删除的依赖，报告卸载失败。**不重新启用组合包**。 |

**已知残留（`:133`）**：
> 失败的删除可能留下部分依赖改动，失败或被取消的安装可能在 `node_modules` 或 pnpm 缓存中留下已下载文件。文件缺失的未启用依赖仍可删除。**诊断日志保留在 profile 的 `.plugin-manager/logs` 目录中。**

**本机 `.plugin-manager` 实测**（`$PROFILE\.plugin-manager\`）：`logs\` 下有约 45 个 `github-connection-*\git.log` 与约 95 个 `operation-*\pnpm.log`，即每次 `installBundle` 的 `git ls-remote` 预检与每次 pnpm 运行各留一份日志，**从不清除**。

其它残留面：
- 构建脚本挂起时，`pnpm-workspace.yaml` 的 `allowBuilds` 记录**有意不恢复**（`$ASAR\dsh-plugin-manager\README.zh.md:58`）：
  > 失败的运行会恢复 `package.json` 与 `pnpm-lock.yaml`，但**有意不恢复 pnpm 记录这些名字的 `pnpm-workspace.yaml`**。
  本机 `$PROFILE\pnpm-workspace.yaml` 里的 `allowBuilds`（`@google/genai`、`cloudflared`、`cpu-features`、`protobufjs`、`ssh2`）正是这一机制的产物。
- 运行记录 `.plugin-manager/run.json` 在运行结束时删除；锁持有者已死时下一个写入方会接管，但会**最多等 5 秒**让记录中的进程树停下，否则不跑 pnpm 并报错（`:92`）。
- pnpm 11 拦下的依赖脚本会记录在 `pendingBuilds`，且**包括先前尝试留下的**（`:58`）。
- 完成的操作发 `plugin-manager/changed`；**在管理器之外**（CLI 或手改）应用的 patch 不发通知，页面要到下一次读取才知道（`:54`）。
- `OPTIONAL_BUNDLES`（随安装提供、默认关闭、由用户开启、**永不可卸载**）：`@deepseek-ai/dsh-experimental-agent-team-profile`、`@deepseek-ai/dsh-experimental-voice-input-bundle`、`@deepseek-ai/dsh-experimental-auto-review`、`@deepseek-ai/dsh-experimental-schedule-bundle`（`$ASAR\dsh-app-boot\lib\index.js:544-557`）。本机 `$PROFILE\package.json` 里这 4 个中已启用了 3 个。

### 5.5 `dsh plugin` 的三条 DSH 自有子命令（不走 pnpm）

`$DSH\lib\plugin-BGnVfe_D.js:14-16`：只有 `allow-version`、`revoke-version`、`version-exemptions` 被 DSH 自己解析，其余全部归 pnpm。
用法串（`:30`）：`dsh plugin <allow-version|revoke-version> <package@version> --dsh-version <exact> [--accept-risk]`。
`allow-version` 会先向 stderr 打风险警告（`:36`）：
> `dsh: warning: allowing incompatible plugin versions can break the application or corrupt data. Approval applies only to the exact package and DSH versions.`
豁免写在 profile 自己的 `compatibility.json`（与 `package.json`、`cordis.patch.yml` 并列），把精确 `package-name@version` 映射到精确 DSH 运行时版本列表（`$ASAR\dsh-plugin-manager\README.zh.md:65`）。
不兼容时的提示（`:95`）会打印可直接复制的补救命令：`dsh plugin --profile <p> allow-version <name>@<version> --dsh-version <runtimeVersion> --accept-risk`。

---

## 不确定项

1. **`$PROFILE\package.json.bak-<epochms>-<rand>` 的写入者未定位。** 本机存在 15 个此类备份（如 `package.json.bak-1791011106924-1o7w7f`，时间戳集中在 1791011106xxx–1791011147xxx 的数秒内），其内容与正式 `package.json` 有差异，显然来自某次安装动作。但对 `$ASAR\dsh-atomic-write` 全包 grep `.bak|backup` **命中 0**，因此**不能断言这是 DSH 自身的原子写行为**。可能是第三方插件（如 `dshmarket` 或 `@linxin666/*` 系）所为。**需外部检索或抓一次安装过程复现观察。**（不影响主结论：`saveManifest` 走的是 `writeFileAtomic`，我未找到它产生 `.bak` 的证据。）
2. **`mode: 0o600` 在 Windows 上的实际效果未验证。** `operations.js:41` 传了 `{ mode: 0o600 }`，但 NTFS ACL 与 POSIX mode 的映射关系我没在本地取证。
3. **`dsh.client.inject` 的具体消费点未逐行确认。** 已确认它被解析（`dsh-client-modules\lib\index.js:66` 的 `optionalStringArray`）并被携带进启动图；官方文档称其 "only order activation"、"informational"（`references\practices.md:35`、`dsh-client-ui-workspace\lib\client.js:4103`）。但「按 inject 边排序激活」的那段调度代码我没有逐行读，**只知语义、未见实现**。
4. **`dsh.client.platform` 除 `'web'` 之外是否存在其它受支持取值。** 代码里只见 `if (decl === void 0 || decl.platform !== "web") { /* skip */ }` 这一条分支，未发现其它平台的装配路径。**不能断言只有 web**，只能说本机安装里只有 web 分支可观察。
5. **asar 内 `.d.ts` 未随包发布。** `$ASAR\dsh-package-manifest\package.json` 的 `files` 声明含 `lib/types/**/*.d.ts`，但实际 `lib\` 下**只有 11 字节的 `index.js`**，无 `types` 目录。因此 `DshPackageManifest` / `DshClientManifest` / `DshManifest` 的**字段级类型定义拿不到**——本文档中清单字段的结论改由「解析代码 + README + 运行中的 Inspect 契约」三方交叉得出，未直接读类型声明。若要字段级权威定义，**需外部检索 `deepseek-ai/deepseek-harness` 源码包 `packages/util/package-manifest/src/types.ts`**。
6. **`@deepseek-ai/cordis` 与 `react` 这两个 peer 在运行时的实际解析路径未逐行确认。** 已确认它们**不做版本强制**（不匹配 `@deepseek-ai/dsh*` 模式）且**不被 pnpm 自动安装**（`autoInstallPeers: false`，profile `node_modules\@deepseek-ai\` 下无 cordis）。合理推断是「从 dsh 安装目录解析」，并有文档支持（`SKILL.md:31`、`host-plugin.md:18`），但解析器的具体代码未读。
7. **未找到 DSH 插件规范的公开网络文档。** 本机 asar 内的各包 `README.zh.md`、`dsh-agent-preset` 自带的 `cordis-plugin-development` / `cordis-composition-reference` skill，是本次调研能拿到的唯一权威来源。若需要跨版本（非 0.2.0-rc.2）的规范，**需外部检索官方仓库 `deepseek-ai/deepseek-harness`**。
8. **`isolate` / `intercept` 的运行时语义只读到定义与一句描述**（`cordis-composition-reference\SKILL.md:23`：「`isolate` maps service names to `true` or a realm label; a preset plugin that provides a service isolates the provider and all consumers together. Scope controls contributions and event visibility; `isolate` controls service instances.」），未见实现，也未在本机任何 profile 中使用。

---

## 证据索引

### A. 运行中活体（最高权威，随版本变动）

| 来源 | 提供了什么 |
|---|---|
| `cordis_inspect_list` | 9 个 Inspect Provider：host `Service`/`Event`/`Config`/`Tool`，client `Service`/`Event`/`Builtin`/`Slots`/`Theme` |
| `cordis_inspect_query(host, Service, listService)` | 全量 Service 目录（含 `tools`、`skills`、`commands`、`agents`、`agentPresets`、`clientModules`、`webServer`、`workspaceRegistry` …） |
| `cordis_inspect_query(host, Service, listService, {service:"tools"})` | `tools` 服务 8 个方法的签名+描述、访问形态，以及 47 个被引用类型的**逐字 TS 声明**（`ToolDefinition`、`ToolSchema`、`ToolOutputDefinition`、`ToolRunContext`、`ToolRestriction`、`ToolGuard`、`JsonSchemaNode`、`Agent`、`ToolCallId`、`ContentBlock` 视图族…） |
| `cordis_inspect_query(host, Service, listService, {service:"skills"})` | `skills` 服务 5 个方法、分层/优先级语义，及 `SkillProvider`/`SkillProviderControl`/`SkillRegistration`/`SkillSummary`/`SkillInvocationPolicy`/`SkillSource`/`SkillViewOptions` 的逐字声明 |
| `cordis_inspect_query(host, Config, listConfigs, {name:"dsh-mattpocock-skills-deck"})` | 活体条目 `include:dsh-mattpocock-skills-deck`，`patchId` = `dsh-mattpocock-skills-deck` |

### B. DSH 安装内（`$ASAR` / `$DSH`，需 Electron-as-node 读取）

**清单与规范**
- `$ASAR\dsh-package-manifest\README.zh.md` — `dsh` 键各字段语义；`:48/:52/:53` 可选性；`:93` **明说不强制 `manifestVersion`/`engines.dsh`**
- `$ASAR\dsh-package-manifest\package.json` — 包自述「Shared type declarations for package.json.dsh configuration fields」；`:29-34` peer `@deepseek-ai/cordis`
- `$ASAR\dsh-agent-preset\skills\cordis-plugin-development\SKILL.md` — 插件开发主流程；`:31` 包解析位置；`:34` `DSH_PROFILE`/`DSH_PROFILE_DIR`；`:38` **asar 只能被宿主进程自身读取**
- `$ASAR\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md` — **`:9-18` 最小 manifest + patch 范例**；`:31-45` 展示元数据/`icon`；**`:47-54` 两种导出形态与 `ctx.effect`/`ctx.on` 约定**
- `$ASAR\dsh-agent-preset\skills\cordis-plugin-development\references\ui-plugin.md` — `:3` `dsh.client` 三字段；`:9` `external`；`:11` slots
- `$ASAR\dsh-agent-preset\skills\cordis-plugin-development\references\practices.md` — `:35` **`dsh.client.inject` 只排序激活**
- `$ASAR\dsh-agent-preset\skills\cordis-plugin-development\templates\decoration\{package.json,cordis.patch.yml,index.js,client.js}` — 四文件可安装范例
- `$ASAR\dsh-agent-preset\skills\cordis-plugin-development\templates\mcp\{package.json,cordis.patch.yml}` — 纯配置型 bundle 范例
- `$ASAR\dsh-agent-preset\skills\cordis-composition-reference\SKILL.md` — **`:12-23` Loader patch 方言**（insert/覆盖/group/disabled/isolate/`!!js`）
- `$ASAR\dsh-agent-preset\skills\cordis-composition-reference\references\packages.md`（38 KB）— 每个可安装插件包及其行是否吃 `config`

**client 半侧**
- `$ASAR\dsh-client-modules\lib\index.js` — `:63-73` `parseDshClient` 校验；`:401-402` 行字段投影；`:426-428` external 自指拒绝；`:713-726` **扫描与 `platform !== 'web'` 跳过、缺 `./client` 抛错、`immediately === true`**
- `$ASAR\dsh-client-modules\lib\client.js` — 同逻辑的浏览器侧副本（行号一致）
- `$ASAR\dsh-client-modules\README.zh.md` — `:12` 惰性 CJS 模型；`:34` 声明规则；`:46` `PLATFORM_MODULES` 与 `external`；`:50` 构建要求；`:64-95` 实现与源码地图

**装配与 patch**
- `$ASAR\dsh-app-boot\lib\index.js`（4138 行）— **`:47-104` `applyEntryPatches` = 唯一 patch 语义**；`:540-557` `DEFAULT_PROFILE_BUNDLES` / `OPTIONAL_BUNDLES`；`:558-568` profile 初始化模板（patch + pnpm-workspace）；`:2721-2762` entry/patch JSON Schema 与描述；`:2894-2938` 生成的 schema 文档与 `$comment` 层顺序
- `$ASAR\dsh-app-boot\README.zh.md` — `:43` required entry 语义；`:50` **profile 组成、bundlePatchFiles 校验、HMR 策略**；`:52` **peer 强制规则**；`:54` 拒绝处置；`:56` `compatibility.json`；`:61` 用户 patch 层；`:65` insert 路径转 file URL
- `$ASAR\cordis-plugin-loader\src\config\entry.ts` — **`:9-23` `EntryOptions` 逐字定义**；`:65-71` id 拼接；`:74-93` disabled 与 `!!js`；`:116-155` update 与 volatile；`:221-235` **import → unwrapExports → registry.plugin**
- `$ASAR\cordis-plugin-loader\README.md` — `:25-34` Entry Options 表；`:40-46` loader API；`:52` Schemastery 与 volatile
- `$DSH\README.zh.md` — `:5` 启动器定位；`:11-18` **命令表（含 `dsh plugin` 转发 pnpm）**；`:20` `desktop` 保留名；`:37` profile 目录内容；`:39` peer 强制；`:42-43` **层顺序**；`:46` bundle 解析位置

**插件管理 / 安装卸载**
- `$ASAR\dsh-plugin-manager\lib\types\install-spec.js` — **`:8-19` 四类 spec 正则**；`:57-86` `parseInstallSpec` 全文与五种拒绝理由
- `$ASAR\dsh-plugin-manager\lib\types\operations.js` — `:31-35` `bundleManifest`；`:36-42` `saveManifest` 原子写 `0o600`；**`:43-72` `reconcile`**；`:520-537` `runPluginCommand` 与 profile 初始化；`:545-579` registry 读取与 `viewProfilePackage`
- `$ASAR\dsh-plugin-manager\lib\types\tools.js` — `:14-16` `plugin_manager` 工具的 action 枚举与权限要求
- `$ASAR\dsh-plugin-manager\lib\index.js` — `:198` 保护性只读；`:277-323` `listBundles`；`:285` 读 `dsh.profile.bundles`；`:755-776` `selectBundle` 写回
- `$ASAR\dsh-plugin-manager\README.zh.md` — `:14` HMR 与重启；`:31` 权限要求；`:40` **开关只改 patch 的 disabled、组合包开关改 bundles**；`:46-58` inspect/install/注册表/构建批准；`:63-69` **兼容性检查与豁免**；`:71-82` 配置表；`:92-94` 实现（锁、`run.json`、idle 超时）；`:130-135` 已知限制；`:142-150` **失败行为与卸载顺序**
- `$DSH\lib\plugin-BGnVfe_D.js` — **`:14-56` 三条 DSH 自有子命令**；`:63-99` `runPlugin` 与 desktop 特判；`:95` 补救命令提示；`:97` git 插件 prepare 脚本提示
- `$ASAR\dsh-desktop-host\lib\cli.js` — `:91-105` **Desktop 用 Electron 自带 Node + 自带 pnpm 跑 CLI**；`:112` runtimeDir 解析
- `...\resources\runtime\cli\bin\dsh.cmd` — 启动器实体命令行

**工具**
- `$ASAR\dsh-tools\README.zh.md` — `:32` `defineTool` 定位；`:34-58` **完整范例**；`:60` **DSL 与原始 JSON Schema 的关系**；`:64-77` `mode`/`maxParallelSubCalls`；`:81` `restrict`/`get`/`schemas` 按 agent 限制；`:85-87` guard 与流水线、projectContent/finalizeContent；`:105` 固定流水线；`:113` 源码地图
- `$ASAR\dsh-tools\lib\index.js` — `:838` `defineTool` 实现；`:847` `timeoutMs` 校验；`:3714` 导出面（`ToolArgsError`/`ToolOutputError`/`RUN_CODE_NAME` …）
- `$ASAR\dsh-tool-todo\lib\index.js` — `:95-142` 内置工具真实注册写法（DSL 形态）

**skills**
- `$ASAR\dsh-skill-filesystem\README.zh.md` — `:12` 概览；`:28` 挂载；`:36-42` **skill 格式与 frontmatter 字段**；`:38` 严格布尔；`:48-56` **rank 表与 includeDefaultRoots/bundledSkillDir**；`:60-77` 挂载与配置表；`:81` 变更检测范围；`:110` 发现流程；`:135` 模型出口；`:148-152` 已知限制（一层深、`.git` 祖先、格式错误静默、无正文修订协议）
- `$ASAR\dsh-skill-filesystem\package.json` / `lib\index.js`（29 KB）— 提供方实现
- `$ASAR\dsh-agent-preset\skills\*` — 4 个自带 skill（`agent-experience`、`cordis-composition-reference`、`cordis-plugin-development`、`editing-cordis-compositions`），既作 frontmatter 实例又作规范来源
- `...\resources\runtime\office-skills\{office-docx,office-pptx,office-xlsx}\SKILL.md` — **运行时侧自带 skill 根的现成布局范例**（各含一个 SKILL.md）

### C. profile 与本机第三方插件

- `$PROFILE\package.json` — `dependencies`（11 条）与 `dsh.profile.bundles`（16 条，有序）
- `$PROFILE\cordis.yml` — 空数组 + 「Edit cordis.patch.yml, not this file」
- `$PROFILE\cordis.patch.yml`（168 行）— 用户级覆盖层实例：`ui-settings-general`、`llm-pi-ai`（大量 provider 配置）、`agent-default-model`、`ui-theme`、`ui-chat`、`ui-settings*`、`web-ui-pet`
- `$PROFILE\pnpm-workspace.yaml` — `packages: ['.']`、`nodeLinker: hoisted`、**`autoInstallPeers: false`**、`allowBuilds`（构建批准残留）、`minimumReleaseAgeExclude`
- `$PROFILE\.npmrc` — `fetch-timeout=600000`、`fetch-retries=3`
- `$PROFILE\package.json.bak-*`（15 个）— **本地路径 `link:` 依赖的真实写法与 pnpm 写回证据**；写入者未定位（见不确定项 1）
- `$PROFILE\.plugin-manager\logs\{operation-*,github-connection-*}\{pnpm.log,git.log}` — 安装诊断残留实证
- `$PROFILE\node_modules\@deepseek-ai\` — 实测**只有 `cosmokit` 与 `schemastery`**，是「peer 不装进 profile、bundled 包从 dsh 安装目录解析」的关键反证
- `$DECK\package.json` — `dsh.bundle.patch` + `dsh.client{platform,immediately,inject}` 双范例；`exports` 暴露 `./tools` 与 `./cordis.patch.yml`
- `$DECK\cordis.patch.yml` — 一个包插两行、`id != name`、行名为 exports 子路径
- `$DECK\bundled-skills\` — 25 个自带 skill 目录布局（`<name>/SKILL.md` + 可选附件 + `agents/openai.yaml`）
- `$SAMPLE\package.json`（157 行）— `dsh.client.inject` 用法、完整 `devDependencies`/`peerDependencies`、`files` 含 `skills/**/*`
- `$SAMPLE\cordis.patch.yml` — 最简 bundle patch（3 行）
- `$SAMPLE\lib\index.js`（22242 行）— `:7367` skill-filesystem 导入；`:17654` `parameters: structuredClone(...)`；`:21897-21931` `agentCtxGet`/`isMainAgent`/`toExecContext`；`:21932-21947` **`apply(ctx)` 与 bundledSkillDir 挂载**；`:22009-22070` **`registerToolsInto` / `restrictNovelToolsInto`**；`:22123`/`:22140-22143`/`:22190-22193` 主子 Agent 分流；`:22226-22241` 具名导出 `apply`/`name`
