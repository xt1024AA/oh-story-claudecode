# DSH 0.2.0-rc.2 → 0.2.1-rc.2：第三方 Host 插件契约变化（只读侦察）

> 调研日期：2026-10-18
> 运行时实测版本：**`0.2.1-rc.2`**（`$ASAR\dsh-app-boot\package.json` 的 `version`，即 `getDshRuntimeVersion()` 的返回值）
> 对照基线：本仓库上一轮结论 `docs/research/dsh-plugin-spec.md`（取数于 2026-10-03，DSH `0.2.0-rc.2`）
> 方法：所有 `$ASAR` / `$DSH` 证据均由宿主自己的 Electron-as-node 读出（`readFileSync`/`readdirSync`），活体契约由 `cordis_inspect_query` 取；`$PROFILE` 与工作区文件用普通文件读取。
>
> **路径简写**
> - `$ASAR` = `C:\Users\49178\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai`
> - `$DSH` = `C:\Users\49178\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh`
> - `$PROFILE` = `C:\Users\49178\.dsh\profiles\desktop`
> - `$PKG` = 本仓库插件包 `D:\DS\插件\oh-story-claudecode\packages\dsh-plugin`
>
> **取证限制**：本机只装了 `0.2.1-rc.2` 一份 DSH（`C:\Users\49178\AppData\Local\Programs` 下无旧版；updater 缓存里只有 0.2.1-rc.2 的安装器）。因此「0.2.0 → 0.2.1 的差异」只能通过**上一轮 0.2.0 的实测记录**做逐条对照，不能做两份 asar 的字节级 diff。凡是上一轮文档没写、本轮才有的事实，都在正文里点名。

---

## Runtime facts

1. **运行时版本从 app-boot 自己的 `package.json` 读**，不是从 CLI 或 Electron 版本读：
   `$ASAR\dsh-app-boot\lib\index.js:271-275`
   ```js
   function getDshRuntimeVersion() {
       const filename = fileURLToPath(new URL("../package.json", import.meta.url));
       const manifest = objectOf$1(JSON.parse(fs.readFileSync(filename, "utf8")), "app-boot package.json");
       return runtimeVersionOf(Object.hasOwn(manifest, "version") ? manifest.version : void 0);
   }
   ```
   实测返回 `0.2.1-rc.2`；`$DSH\package.json` 的 `name` 是 `@deepseek-ai/dsh-desktop-runtime`、`version` 同为 `0.2.1-rc.2`、`type: module`，**没有 `engines` 字段**。

2. **306 个包里有 296 个是 `0.2.1-rc.2`**，其余 10 个是外部/独立版本线（实测版本直方图：`0.2.1-rc.2`×296、`cordis` 4.0.5、`cordis-plugin-loader` 1.0.6、`schemastery` 3.18.5、`cosmokit` 1.8.6、`node-addon-system` 1.1.7、`libreoffice-kit` 1.0.x 等）。与本插件相关的 `dsh-tools` / `dsh-user-approval` / `dsh-skill-filesystem` / `dsh-skill` / `dsh-tool-skill` / `dsh-app-boot` / `dsh-plugin-manager` / `dsh-package-manifest` / `dsh-scope` **全部是 `0.2.1-rc.2`**。
   ⚠ 注意 `cordis-plugin-loader` 的包版本是 **`1.0.6`**，不是 `0.2.x`——**不要**把它当 dsh 家族版本去比对。

3. **本轮安装里 `lib/types/**` 只有 `.js`，没有 `.d.ts`**（实测 `findDts` 在 `dsh-tools` / `dsh-user-approval` / `dsh-skill-filesystem` / `dsh-package-manifest` 上命中 0 个）。`package.json` 的 `exports.types` 仍指向 `lib/types/index.d.ts`，但文件不存在：
   ```json
   "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" }, ... }
   ```
   （`$ASAR\dsh-tools\package.json`；`dsh-user-approval`、`dsh-skill-filesystem`、`dsh-package-manifest` 同形。）
   **这修正了上一轮「不确定项 5」的一半**：不是「只有 dsh-package-manifest 缺」，而是**所有包都缺 `.d.ts`**。字段级类型只能从两处拿：① `lib/types/*.js` 里的 JSDoc；② `cordis_inspect_query` 返回的 `referencedTypes[].declaration` 逐字 TS。

4. **`dsh-package-manifest` 仍是纯类型包**：`lib/index.js` 全文是 `export {};`（2 行）。

5. **profile 侧没有 `compatibility.json`**（实测 `$PROFILE\compatibility.json` 不存在），即本机**没有任何版本豁免**。

6. **本机 profile 现状（0.2.1-rc.2 下）**：用宿主自己的 `loadProfileDirectory` 加载 `$PROFILE` 后，`skippedBundles` 恰好 2 条——`dsh-oh-story-claudecode@0.2.1` 与 `dsh-a-stock-data@0.1.1`，理由都是 `requirements {"@deepseek-ai/dsh-skill-filesystem":"0.2.0-rc.2"}`。**这就是本插件当前在真机上根本不装载的直接证据。**

---

## Peer and engines enforcement

### 1.1 判定函数：`engines.dsh` 优先，否则看 dsh peer

`$ASAR\dsh-app-boot\lib\index.js:279-299`（原文）：
```js
function unmetRequirements(fields, runtimeVersion) {
	const engines = Object.hasOwn(fields, "engines") ? objectOf$1(fields.engines, "Plugin manifest engines") : {};
	if (Object.hasOwn(engines, "dsh")) {
		const range = engines.dsh;
		if (typeof range !== "string") throw new Error("Plugin manifest engines.dsh must be a string");
		return satisfies(runtimeVersion, range) ? {} : { "engines.dsh": range };
	}
	if (!Object.hasOwn(fields, "peerDependencies")) return {};
	const dependencies = objectOf$1(fields.peerDependencies, "Plugin manifest peerDependencies");
	const unmet = {};
	for (const [name, range] of Object.entries(dependencies)) {
		if (typeof range !== "string") throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`);
		if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
		if (!satisfies(runtimeVersion, ["workspace:^", "workspace:~", "workspace:*"].includes(range) ? runtimeVersion : range)) unmet[name] = range;
	}
	return unmet;
}
```

要点（**这里有一处真正的 0.2.0 → 0.2.1 行为变更，不是文档措辞**）：
- **只要 `engines.dsh` 存在，peerDependencies 就被完全忽略**（`:281-285` 直接 `return`）。
- **上一轮的原文否定了这条**：`dsh-plugin-spec.md:122` 逐字引 0.2.0 的 `$ASAR\dsh-app-boot\README.zh.md:52` 为「…**这些检查使用 peer 声明，而不是 `engines.dsh`**，也不是防范恶意包代码的沙箱」。而 0.2.1 的同一段（`$ASAR\dsh-app-boot\README.zh.md:52`）已改成「**清单声明了 `engines.dsh` 时，只由该范围决定，忽略 `peerDependencies`**」。**两版 README 同一段落文字相反，这是硬证据。**
- 【推测】上一轮记录的 `unmetRequirements` 摘录（`dsh-plugin-spec.md:123-129`）**开头就是 `if (!Object.hasOwn(fields, "peerDependencies")) return void 0;`，摘录里看不到任何 engines 分支**。据此推断 0.2.0 的代码里根本没有 engines 判断、`engines.dsh` 完全不被读取。**这是从上一轮的部分摘录推的，不是两份 asar 的字节级 diff**（本机无 0.2.0 安装）。
- `engines.dsh` 本身**只认 `engines.dsh`，不认 `dsh.engines.dsh`**。实测：`{ dsh: { engines: { dsh: '>=0.2.0-rc.2' } } }` → 无约束（判 COMPATIBLE）。`@linxin666/dsh-web-all@0.4.7` 的 `package.json` 里**同时**写了 `dsh.engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh"]`，真正生效的是后者。
- peer 过滤只对 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`；`@deepseek-ai/cordis`、`react`、`@deepseek-ai/schemastery` **不做版本校验**（与上一轮一致）。

### 1.2 范围匹配用 semver + `includePrerelease: true`

`$ASAR\dsh-app-boot\lib\index.js:276-278`：
```js
function satisfies(runtimeVersion, range) {
	return range.trim() !== "" && semver.satisfies(runtimeVersion, range, { includePrerelease: true });
}
```
`semver` 从 `$ASAR\dsh-app-boot\lib\index.js:15` 引入（`import semver, { parse } from "semver"`），实机版本 `SEMVER_SPEC_VERSION = "2.0.0"`。

**用宿主自己导出的 `evaluatePluginCompatibility` 实测的判定矩阵（runtime = `0.2.1-rc.2`）**：

| 声明 | 结果 |
|---|---|
| 无 `engines.dsh`、无 dsh peer | COMPATIBLE |
| `peerDependencies["@deepseek-ai/dsh-skill-filesystem"]: "0.2.0-rc.2"`（**精确预发布**） | **不兼容** `{"@deepseek-ai/dsh-skill-filesystem":"0.2.0-rc.2"}` |
| `^0.2.0-rc.2` | 兼容 |
| `^0.2.0` | 兼容 |
| `^0.2.1` | **不兼容**（`^0.2.1` = `>=0.2.1 <0.3.0-0`，而 `0.2.1-rc.2 < 0.2.1`） |
| `>=0.2.0-rc.2 <0.3.0` | 兼容 |
| `0.2.x` / `0.2.*` / `~0.2.0` | 兼容 |
| `*` / `>=0.2.0` / `>=0.2.0-rc.2` | 兼容 |
| `""`（空串）或 `"  "` | **不兼容**（`range.trim() !== ""` 直接 false） |
| `workspace:^` / `workspace:~` / `workspace:*` | 兼容（被替换成 `runtimeVersion` 自身） |
| `@deepseek-ai/cordis: 4.0.4`、`react: 18.3.1` | 兼容（名字不匹配，跳过） |
| `engines.dsh: "^0.2.0-rc.2"` + 一个不匹配的 dsh peer | **兼容**（engines.dsh 短路 peer） |
| `engines.dsh: "0.2.0-rc.2"` | **不兼容** `{"engines.dsh":"0.2.0-rc.2"}` |
| `engines.dsh: "workspace:^"` | **不兼容**（`workspace:` 只在 peer 侧被特殊处理） |
| `engines: { node: ">=24" }` | 兼容（`engines.node` 完全不校验） |

**结论（直接回答提问）**：
- **`0.2.0-rc.2` 精确预发布版本在 `0.2.1-rc.2` 下算不兼容。** 这正是本插件当前被判死的原因。
- **`^0.2.0-rc.2`、`>=0.2.0-rc.2 <0.3.0`、`0.2.x` 都算兼容**（`includePrerelease: true` 让 `0.2.1-rc.2` 落进 `>=0.2.0-rc.2 <0.3.0-0`）。
- 陷阱：**`^0.2.1` 反而不兼容**（预发布小于正式版）。要覆盖预发布，范围上界必须显式带 `-0` 或下界带 `-rc.N`。

### 1.3 不匹配时的行为：分三层，且**不会**让整个 profile 起不来

**(a) 组合包（bundle）层面——被跳过，进 `skippedBundles`。**
`$ASAR\dsh-app-boot\lib\index.js:1015-1040`：
```js
function loadProfileDirectory(binName, dir, installAnchor, options = {}) {
	const bundles = dropRetiredBundles(dir, readProfileManifest(binName, dir)).dsh?.profile?.bundles ?? [];
	const layers = [];
	const skippedBundles = [];
	const exemptions = bundles.length === 0 ? {} : readProfileVersionExemptions(dir);
	for (const packageName of bundles) try {
		const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);
		const bundleManifest = readProfileManifest(binName, packageDir);
		const bundle = bundleManifest.dsh?.bundle;
		if (bundle === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
		const issue = evaluatePluginCompatibility(bundleManifest, exemptions);
		if (issue !== void 0 && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue));
		...
	} catch (error) {
		skippedBundles.push({ packageName, reason: String(error) });
	}
```
即：**抛错 → 被 catch → 该 bundle 不进 layers，其余 bundle 照常按原顺序加载**。启动器每次启动通过 `reportSkippedBundles` 打一行 stderr（`:537-539`）：
```js
process.stderr.write(`${binName}: skipping profile bundle ${JSON.stringify(packageName)}: ${reason}\n`);
```

**(b) 普通行（profile patch / preset 里的行）——变成游离的 `disabled: true` 行。**
`$ASAR\dsh-app-boot\lib\index.js:2305-2331` 的 `prepareProfileEntries` / `preflight`，注释写明「Only a compatibility conflict denies a row; every other failure keeps the Loader's own diagnosis」。官方 README 同一句话：`$ASAR\dsh-app-boot\README.zh.md:54`
> 被拒绝的普通行会变成游离的 `disabled: true` 行；原生 group 保持挂载，其被拒绝的子行不会加载；若某个原生 Include 会到达被拒绝的插件，则整体省略该 Include。

**(c) 安装期——pnpm 之前就失败，什么都不下载。**
`$ASAR\dsh-plugin-manager\lib\index.js:599-603`（本地路径直接读 `package.json`，registry spec 走 `pnpm view ... engines peerDependencies --json`，见 `:415-416`）；`$ASAR\dsh-plugin-manager\README.zh.md:69`：
> 未满足的 DSH 版本要求会在 pnpm 运行前使操作失败，因此不会下载任何内容、不会运行构建脚本。

**报错/警告文案原文**（`$ASAR\dsh-app-boot\lib\index.js:333-336`，`pluginCompatibilityWarning`）：
```
Plugin <name>@<version> is incompatible with dsh <runtimeVersion>: requirements {"<key>":"<range>"}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime. To accept this risk explicitly, grant the exact-version exemption for <name>@<version> on dsh <runtimeVersion> with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh. Exact-version exemption: <active|not active>.
```
实测本插件的完整原文：
```
Plugin dsh-oh-story-claudecode@0.2.1 is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-skill-filesystem":"0.2.0-rc.2"}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime. To accept this risk explicitly, grant the exact-version exemption for dsh-oh-story-claudecode@0.2.1 on dsh 0.2.1-rc.2 with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh. Exact-version exemption: not active.
```

**(d) 豁免**：写在 profile 自己的 `compatibility.json`（`$ASAR\dsh-app-boot\lib\index.js:341` `const PROFILE_COMPATIBILITY_FILENAME = "compatibility.json"`），把精确 `name@version` 映射到精确 DSH 运行时版本数组；**插件升级与 DSH 升级都不继承**（`:324` 用 `exemptions[key]?.includes(runtimeVersion) === true` 判定）。本机没有这个文件。

### 1.4 `dsh-typert-*` 与 `cordis-plugin-loader` 不参与版本判定

- `dsh-typert-loader` / `dsh-typert-registry` / `dsh-typert-protocol` 三个包的 `lib/index.js` 里 **grep `peerDependencies` / `engines.dsh` / `compatib` 命中 0**。它们的职责是远程/typert 通道，与 peer 校验无关。
- `cordis-plugin-loader` 只负责 `import` + `unwrapExports` + `registry.plugin`（`$ASAR\cordis-plugin-loader\lib\index.js:450-465`、`:667-672`），**不做任何 manifest 校验**。
- 唯一实现兼容性判定的地方就是 `dsh-app-boot`（导出 `evaluatePluginCompatibility` / `pluginCompatibilityWarning` / `getDshRuntimeVersion` / `readProfileVersionExemptions` / `setProfileVersionExemption`），`dsh-plugin-manager` 只是**复用**它做安装前预检。

---

### 1.5 `engines.dsh` 的分工（提问 2 的答案）

| 问题 | 事实 | 证据 |
|---|---|---|
| 是否被校验？ | **是，且优先级高于 peerDependencies**；存在即短路 peer | `$ASAR\dsh-app-boot\lib\index.js:281-285` |
| 语义 | SemVer 范围，`includePrerelease: true`；空串/`workspace:` 都算不兼容 | `:276-278`、`:284` |
| 与 peer 的分工 | `engines.dsh` = 作者声明的「整包兼容区间」；peer = 逐包声明。**两者二选一，不是叠加** | `:279-299` |
| 类型错误 | `engines` 不是对象 / `engines.dsh` 不是字符串 → **抛错**（malformed manifest） | `:280`、`:283` |
| 上一轮的说法 | 上一轮引 `$ASAR\dsh-package-manifest\README.zh.md:93`「当前安装器和加载器不强制检查 `dsh.manifestVersion` 或 `engines.dsh`」 | —— |

**⚠ 本轮最重要的文档级变化**：`$ASAR\dsh-package-manifest\README.zh.md` 在 0.2.1 里**仍然保留着那句过期的话**（「兼容性仅作声明。当前安装器和加载器不强制检查 `dsh.manifestVersion` 或 `engines.dsh`」），而 `$ASAR\dsh-app-boot\README.zh.md:52` 已经是新语义：
> profile 导入插件前，DSH 会将其声明的 DSH 版本要求与 `getDshRuntimeVersion()` 返回的唯一运行时版本比较。**清单声明了 `engines.dsh` 时，只由该范围决定，忽略 `peerDependencies`。** 否则 `peerDependencies` 中对 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 的每个范围都必须匹配……

即：**`dsh-package-manifest` 的 README 是过期文档，`dsh-app-boot` 的 README 与代码是真源。** 上一轮若只读前者（`dsh-plugin-spec.md:113-114` 就把它当作「关键否定证据」），会得出「engines.dsh 不强制」的错误结论。

`dsh.manifestVersion` 则确实仍不校验：在 `$ASAR\dsh-app-boot\lib\index.js` 里 grep `manifestVersion` **命中 0**。

---

## Tools contract

### 3.1 `ctx.tools.register(definition): () => void` —— 签名未变，校验变严

活体契约（`cordis_inspect_query(host, Service, listService, {service:"tools"})`）原文：
> `register(definition: ToolDefinition): () => void` — "Register globally or in the calling agent scope. Scoped tools shadow globals; duplicates within one layer and the reserved `run_code` name fail." / returns: "the exact disposer that unregisters the tool."

实现（`$ASAR\dsh-tools\lib\index.js:2974-2983`）：
```js
register(definition) {
	const name = definition.name;
	const output = definition.output;
	if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
	assertSupportedJsonSchema(output.schema);
	const timeoutMs = definition.timeoutMs;
	if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
	if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
	return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
}
```

**逐条回答**：
- **`output` 仍必填**，且 `render` 必须是函数；`presentationMeta` 可选但给了就必须是函数。缺了报 `tool "<name>" must declare output { schema, render, presentationMeta? }`。
- **`parameters` 仍是原始 JSON Schema**，静态类型仍是 `Record<string, unknown>`：
  ```ts
  export interface ToolSchema {
      deferLoading?: true;
      name: string;
      description: string;
      parameters: Record<string, unknown>;
  }
  ```
  **但 `register()` 只校验 `output.schema`，不校验 `parameters`**——`assertSupportedJsonSchema` 的五个调用点是 `:794`/`:809`（`defineTool` 的编译路径）、`:1770`/`:2333`（PTC SDK 的 TS 类型渲染，且都在 `try{...}catch{ return "unknown" }` 里，不抛）、`:2978`（`register` 里**只对 `output.schema`**）。`assertObjectJsonSchema` 只在 `:334` 定义、**没有运行时调用点**（只有 `:18`/`:319` 的 JSDoc 交叉引用）。
  **后果**：直接 `register({ parameters: <raw> })` 的插件（本插件就是，见 `$PKG\lib\index.js:376-382`）**不会**在注册期因 schema 子集违规被拒；`parameters` 直到 `schemas()` 投影时才会被 `snapshotJsonValue` 检查「必须是无损 JSON」（`:3138`：`tool "<name>" parameters must be lossless JSON before schema projection`）。
- **`ctx.tools.get` 仍在**：`get(name: string, scope?: ScopeKey): ToolDefinition | undefined`（活体契约 + `:3083-3093` 的实现 `get(name, scope) { return this.view(scope).visible.get(name); }`）。本插件 `$PKG\lib\index.js:127-141` 用它回读注册表，**可继续使用**。
- **工具名没有新增长度/字符/前缀约束**。全包 grep 不到 `name.length` / kebab / 正则校验；唯一硬约束是 `run_code` 保留名（`:2981`），以及同层重名报错（`$ASAR\dsh-scope\lib\index.js:27-29` 的 `insert` 抛 `duplicateError(name)`，文案在 `$ASAR\dsh-tools\lib\index.js:2731`）：
  ```
  tool "<name>" is already registered (for a per-agent variant, register through that agent's `agent.ctx` instead)
  ```
- **没有新增必填字段**（`display` / `title` / `annotations` / `timeout` 都不存在）。`timeoutMs` 是可选的，且**只作声明、注册表从不强制执行**（`$ASAR\dsh-tools\README.zh.md:235`：「定义中的 `timeoutMs` 仅作声明之用：注册表绝不会强制执行截止时间；要强制执行，必须使用 `@deepseek-ai/dsh-tool-call-timeout-policy` 包装层」）。

### 3.2 `ToolDefinition` / `ToolOutputDefinition` 逐字定义（活体契约）

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

export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode;
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}

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

**⚠ 与上一轮的一处实质差异**：`ToolPresentationMode` 现在是
```ts
export type ToolPresentationMode = 'native' | 'ptc';
```
上一轮记录的是 `'native' | 'ptc' | 'both'`（`dsh-plugin-spec.md:488`），并称 README 允许 `native`/`ptc`/`both`（`:430`）。本轮两处都已收窄：
- 代码：`$ASAR\dsh-tools\lib\index.js:2763` → `mode: z.union(["native", "ptc"]).default("native")`；
- 文档：`$ASAR\dsh-tools\README.zh.md:78` → 「`mode` | `native` | 可见工具向模型呈现的方式：`native` 或 `ptc`」。

`presentAs(mode)` 本身**不校验取值**（`:2911-2927` 直接 `layer.mode = mode`），错值会在后续 `requirePtcRuntime(mode)`（`:2961`）才炸：
```
dsh-tools: mode "<mode>" requires a PTC runtime — load a ctx.ptcRuntime implementation (e.g. @deepseek-ai/dsh-ptc-runtime-node) or set tools mode to "native"
```
本插件不使用 `presentAs`，不受影响。

`ToolRunContext`（工具 execute 的第二参）未变：
```ts
export interface ToolRunContext extends ToolExecution {
    deferContext(context: UserMessage): void;
    concludeTurn(): void;
}
```

### 3.3 受支持的 JSON Schema 子集（写 `output.schema` 时必须遵守）

`$ASAR\dsh-tools\lib\index.js:34-58`、`:143-150`：
```js
const CONSTRAINT_KEYWORDS = new Set([...]);   // type/oneOf/properties/required/additionalProperties/items/enum/const
const ANNOTATION_KEYWORDS = new Set(["description", "title", "default", "examples"]);
const SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
const ONE_OF_SIBLING_KEYWORDS = ["properties", "required", "additionalProperties", "items", "enum", "const"];
```
违规文案（`:206`）：
```
<path>.<key> is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)
```
其它已知拒绝：`type` 数组不支持（`:237`）、`oneOf` 至少两个分支（`:227`）、`type` 与 `oneOf` 不能并存（`:213`）、`required` 里的名字必须在 `properties` 里（`:158`）、`oneOf` 旁不能有兄弟约束关键字（`:175`）。

### 3.4 `ctx.tools.restrict` 的一个**行为细节**

`$ASAR\dsh-tools\lib\index.js:2991-3005`：`restrict()` 现在**在无 scoped 上下文时直接抛错**：
```js
if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead");
```
并且未知名字会把**全部已知全局工具名列进错误消息**（`:3004`）。本插件当前没有用 `restrict`，不受影响，但值得记一笔。

---

## Approval contract

### 4.1 签名未变，但**语义收紧**：必须有开着的 turn

活体契约原文：
> `async request(req: ApprovalRequest): Promise<ApprovalOutcome>` — "Ask the composed answerers to decide one readonly same-process request. … **The request requires an open turn** because the audit pair must be enclosed by the durable log's commit/replay boundary; an idle ask rejects before appending anything. … returns: the closed outcome; `'allowed-once'` is the only grant." / throws: "when no turn is open or either audit event fails before the session append commit point."

实现（`$ASAR\dsh-user-approval\lib\index.js:128-144`）：
```js
async request(req) {
	const session = req.agent.session;
	if (!hasOpenTurn(session)) throw new Error("approval.request() outside an open turn: the approval/asked + approval/decided audit pair must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). Ask from inside the turn that needs the decision.");
	const id = ApprovalRequestId(randomUUID());
	session.append("approval/asked", { id, toolName: req.toolName, ...req.callId !== void 0 ? { callId: req.callId } : {}, ...req.reason !== void 0 ? { reason: req.reason } : {} });
	const outcome = await this.decide(req, session);
	session.append("approval/decided", { id, outcome });
	return outcome;
}
```

### 4.2 参数与返回（逐字类型）

```ts
export interface ApprovalRequest extends ApprovalRequestEvent {
    readonly agent: Agent;
    readonly toolName: string;
    readonly callId?: ToolCallId;
    readonly reason?: string;
    readonly signal?: AbortSignal;
}

export interface ApprovalRequestEvent {
    readonly agent: Agent;
    readonly toolName: string;
    readonly callId?: ToolCallId;
    readonly reason?: string;
    readonly displayReason?: { readonly en: string; readonly [locale: string]: string };
    readonly signal?: AbortSignal;
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
export type ApprovalPolicy = 'ask' | 'never';
```

**`{ title, detail }` 这类调用从来不是契约**——契约字段是 `agent` / `toolName` / `callId?` / `reason?` / `signal?` / `displayReason?`。本插件 `$PKG\lib\runtime\approval.js:40-46` 用的正是正确形状：
```js
outcome = await approvalService.request({ agent, toolName, callId: exec.callId, reason, signal: exec.signal });
```
**无需改**。

### 4.3 结果语义（`$ASAR\dsh-user-approval\lib\index.js:172-189`）

```js
async decide(req, session) {
	const signal = req.signal;
	if (signal?.aborted) return "cancelled";
	if (this.effectivePolicy(session) === "never") return "rejected";
	const answer = Promise.resolve().then(() => this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))).then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable", () => "unavailable");
	...
}
```
- 会话策略为 `never` 时**直接返回 `rejected`，根本不进 waterfall**——所以「审批提示被禁用」的会话里，插件的破坏性工具会拿到 `rejected` 而不是 `unavailable`。
- 没有应答者 → `unavailable`（fail closed）。
- 本插件的 `fallbackToConfirm` 把 `rejected` 当终局、把 `unavailable` 当可回退（`$PKG\lib\runtime\approval.js:53-68`），**与新语义一致**。
- 唯一新增风险点：**在 turn 之外调用会抛错**。本插件已 try/catch 并降级（`:47-51`），安全。

---

## Skills contract

### 5.1 插件选项：**未改名、未新增必填**

`$ASAR\dsh-skill-filesystem\lib\index.js:28-43`（原文）：
```js
const name = "skill-filesystem";
const inject = ["skills"];
const Config = z.object({
	providerName: z.string().min(1).default("filesystem"),
	includeDefaultRoots: z.boolean().default(true),
	dshHome: z.string(),
	agentsHome: z.string(),
	customSkillDirs: z.array(z.string()).default([]),
	watch: z.boolean().default(true),
	watchUsePolling: z.boolean().default(false),
	watchStabilityThresholdMs: z.number().default(DEFAULT_WATCH_STABILITY_THRESHOLD_MS),
	watchPollIntervalMs: z.number().default(DEFAULT_WATCH_POLL_INTERVAL_MS),
	watchMaxProjects: z.number().default(DEFAULT_WATCH_MAX_PROJECTS),
	watchFollowSymlinks: z.boolean().default(true),
	bundledSkillDir: z.string()
});
```
`bundledSkillDir` 仍是**可选**（`z.string()` 无 `.required()`/`.default()`），语义未变：配置后按 `BUNDLED_SKILL_RANK = 600` 加一个根（`:183`，常量定义在 `$ASAR\dsh-skill\lib\index.js:23`）。`includeDefaultRoots: false` 仍会连 `$DSH_BUNDLED_SKILL_DIR` 默认值一起省略（`:83`）。

**用这个 `Config` 实测过本插件的实际入参**（`{ providerName: "oh-story-bundled", includeDefaultRoots: false, bundledSkillDir: "<abs>" }`）：
```
with bundledSkillDir: OK -> {"providerName":"x","includeDefaultRoots":false,"customSkillDirs":[],"bundledSkillDir":"C:/tmp"}
bad bundledSkillDir (number): THROW -> $.bundledSkillDir expected string but got 5
```
即**本插件的三个字段全部合法，且没有未知字段报错**（schemastery 默认丢弃未知键，不抛）。**§5.1 的结论：这块零改动。**

**没有 `rank` 这个配置项**——rank 是内部常量（100/200/300/400/500/600），不是插件选项。上一轮文档也没说有，这里只是澄清。

### 5.2 `ctx.inject(["skills"], scope => scope.plugin(...))` **仍然成立**

- `cordis` 的 `RegistryService.inject(inject, callback)` 把 `{ inject, apply: callback }` 交给 `plugin()`（`$ASAR\cordis\lib\index.js:1533` 附近，`resolve(plugin)` 接受 function 或 `{ apply }` 对象）。
- 被挂载的对象可以是**模块命名空间**：`cordis-plugin-loader` 的 `unwrapExports` 会 `exports.default ?? exports` 再 `__esModule` 兜底（`$ASAR\cordis-plugin-loader\lib\index.js:667-672`），而 `dsh-skill-filesystem` 导出的是 `export { Config, FileSystemSkillProvider, apply, inject, name }`（`:891`）——**有具名 `apply`，所以命名空间直接可用**。
- 本插件 `$PKG\lib\index.js:439-444` 的写法与上一轮 `dsh-scriptor` 的实测写法一致，**无需改**。

### 5.3 发现规则：仍是一层，仍要求 `name` + `description`

`$ASAR\dsh-skill-filesystem\lib\index.js:584-617`（`discoverRoot`）：
```js
const locator = entry.type === "directory" ? { path: join(entry.path, "SKILL.md"), directory: entry.path }
	: entry.type === "file" && entry.name.endsWith(".md") ? { path: entry.path, directory: root.path } : void 0;
if (locator === void 0) continue;
const parsed = await parseSkillFile(locator.path, ctx, void 0, root.trustedHost === true);
```
即**只扫根目录的直接子项**：`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`；**嵌套 `**/SKILL.md` 不支持**（与上一轮一致）。

`parseSkillFile`（`:667-708`）的拒绝条件与文案：
```js
if (!parsed) { ctx.logger.warn(`skill file ${path} ignored: missing YAML frontmatter`); return; }
const name = stringField(parsed.data, "name");
const description = stringField(parsed.data, "description");
if (name === void 0 || description === void 0) { ctx.logger.warn(`skill file ${path} ignored: frontmatter requires name and description`); return; }
if (!isSkillName(name)) { ctx.logger.warn(`skill file ${path} ignored: invalid skill name "${name}"`); return; }
```
`isSkillName` 的正则（`$ASAR\dsh-skill\lib\index.js:17`）：
```js
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
```
**kebab-case、小写、无下划线、无点、无大写**。

### 5.4 本插件随包 skills 的实测状态

`$PKG\skills\` 下 13 个目录，**每个都有 `SKILL.md`，且 frontmatter 的 `name` 全部是合法 kebab-case**（`browser-cdp`、`story`、`story-cover`、`story-deslop`、`story-import`、`story-long-analyze`、`story-long-scan`、`story-long-write`、`story-review`、`story-setup`、`story-short-analyze`、`story-short-scan`、`story-short-write`），`description` 全部存在。

⚠ **一个真实风险（与版本无关，但会在 skills 终于挂上之后暴露）**：`skills\story-deslop\package.json` 与 `skills\story-long-write\package.json` 的内容是 `{"type":"commonjs"}`——**没有 `name` 字段**。这不影响 skill 发现（发现只看 `SKILL.md`），但如果将来有人按包元数据扫描，会被当成匿名包。**当前不影响装载，列为可选清理项。**

另：`skills\story-import\scripts\__pycache__\*.pyc` 与 `skills\story-long-write\scripts\__pycache__\*.pyc` 被打进了包（`files` 只列 `lib`/`skills`/`cordis.patch.yml`/`README.md`，`skills` 整目录进去），属于打包卫生问题，不影响契约。

---

## Manifest and display metadata

### 6.1 `dsh.bundle.patch` **仍然有效，且是唯一判据**

- 安装期判据（`$ASAR\dsh-plugin-manager\lib\types\operations.js:83-87`）：
  ```js
  export function bundleManifest(name, dir, anchor) {
      const packageDir = resolveBundleDir('dsh', name, anchor, dir);
      const manifest = readProfileManifest('dsh', packageDir);
      return manifest.dsh?.bundle?.patch === undefined ? undefined : manifest;
  }
  ```
- 启动期判据（`$ASAR\dsh-app-boot\lib\index.js:1023-1024`）：
  ```js
  const bundle = bundleManifest.dsh?.bundle;
  if (bundle === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
  ```
- `patch` 可以是**单个路径字符串**，也可以是**有序字符串数组**（`$ASAR\dsh-app-boot\lib\index.js:517-521`）：
  ```js
  function bundlePatchFiles(bundle) {
      const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
      if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string")) throw new Error("dsh.bundle.patch must be a file path or a list of file paths");
      return declared;
  }
  ```
  非字符串/非字符串数组 → 抛 `dsh.bundle.patch must be a file path or a list of file paths`。
- 本插件 `$PKG\package.json:37-41` 的 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` **完全有效**。

### 6.2 显示元数据：**新增了「应该有」，但没有「必须」**

- 官方作者文档（`$ASAR\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md:29-55`）现在有一整节 `## Display metadata and icon`，要求：
  > Plugin Manager and Settings read `meta.title` and `meta.description` from exported locale JSON and an icon from exported resources without activating plugins. Complete this checklist before installation: …
  > Missing fields of a package-root plugin fall back to `package.json` `name` and `description`, and missing images use the panel's default artwork; malformed metadata produces a diagnostic and keeps the valid text.

  **关键句是最后一句**：缺字段 → 回退到 `package.json` 的 `name`/`description`，缺图 → 用面板默认图。**不是装载门槛。**
- 代码侧佐证（`$ASAR\dsh-app-boot\lib\index.js:2216-2247`，`readPluginMeta`）：
  ```js
  const title = localizedText("title", dictionaries, fallbackText(manifest?.name), specifier);
  const description = localizedText("description", dictionaries, fallbackText(manifest?.description), "");
  ...
  if (title === void 0 && description === void 0 && icon === void 0) return void 0;
  ```
  以及 `iconOf` 的失败路径（`:2233-2238`）**只产出 `error` 字段，不抛给启动流程**：
  ```js
  } catch (error) {
      return { ...text, error: `Plugin metadata for ${specifier}: ${String(error)}` };
  }
  ```
- 消费方是 `dsh-host-plugin-inventory`（`$ASAR\dsh-host-plugin-inventory\lib\index.js:127`、`:147` 调 `packages.metaOf(...)`），即**设置页的插件清单**，与 `loadProfileDirectory` 的装载判定完全解耦。

**结论**：0.2.1 **没有**新增「不写 locale/icon 就拒绝装载」的规则。缺显示元数据的后果只是：插件行显示包名/`package.json` description、用默认图标、设置页可能给一条 metadata 诊断。**属于「UI 不友好」，不是「不装载」。**

**但要注意 `icon` 字段的硬校验**（若你决定加）：必须是包内相对路径（`:2090`）、必须留在 manifest 目录内（`:2095`）、扩展名必须是 SVG/PNG/JPEG/WebP（`:2103`）、必须是常规文件（`:2106`）、**≤ 256 KiB**（`:2107`、`:2109`）。违规不会阻止装载，但会在清单里变成一条 `error` 诊断。

### 6.3 `dsh.client` 未变（本插件不涉及，记录备查）

`$ASAR\dsh-client-modules\lib\index.js:62-72`：整块可选；有则 `platform` 必须是 string（`:66`）；`inject`/`external` 可选字符串数组；`immediately` 可选布尔。装配时 `platform !== "web"` 直接跳过（`:733`），且声明了就必须有 `./client` 导出（`:738`）。

---

## Other breaking changes

### 7.1 `ToolPresentationMode` 只剩 `'native' | 'ptc'`
见 §3.2。`mode: z.union(["native", "ptc"]).default("native")`（`$ASAR\dsh-tools\lib\index.js:2763`）。**只影响调用 `presentAs('both')` 的插件**，本插件不用。
【推测】上一轮记为 `'native' | 'ptc' | 'both'`（`dsh-plugin-spec.md:430`、`:488`）。本轮无法判断是 0.2.1 删掉了 `both`，还是上一轮那次 Inspect 读到的描述本身不准——**本机没有 0.2.0 可对照**。按「当前事实」用 `native`/`ptc` 即可。

### 7.2 `ctx.effect` 语义**未变**，但有一个更严格的行为
`$ASAR\cordis\lib\index.js` 的 `Fiber.effect(execute, label)`：
- callback **立刻执行**，返回值被当作清理函数收集（`runner.collect(effect)`）；
- 返回非函数、非 null、非对象 → `throw new TypeError("Invalid effect")`；
- 返回 thenable / iterator / async iterator 也支持。

本插件 `$PKG\lib\index.js:393-404` 的 `ctx.effect(() => () => {...})` 写法**正确**；`:313-315` 的 `ctx.effect(() => off)` 也正确。

### 7.3 `ctx.logger` 未变
`LoggerService` 仍是 `ctx.logger()` 可调用 + `ctx.logger.info/warn/error/debug` 直用（`$ASAR\cordis\lib\index.js`，`LoggerService` 的 static 块把四个方法挂到 prototype 上）。本插件的 `ctx.logger?.info?.(...)` 写法安全。

### 7.4 插件导出形态未变
`RegistryService.plugin()`（`$ASAR\cordis\lib\index.js:1619-1621`）：
```js
plugin(plugin, config, getOuterStack = buildOuterStack()) {
	const callback = this.resolve(plugin);
	if (!callback) throw new Error("invalid plugin, expect function or object with an \"apply\" method, received " + typeof plugin);
```
`resolve()` 接受 function 或 `{ apply }`。`cordis-plugin-loader` 在 `registry.plugin` 之前先 `unwrapExports`（`$ASAR\cordis-plugin-loader\lib\index.js:460`）。**「`export function apply` + 具名 `inject`/`Config`」与「default 导出 service class」两种形态都仍然成立**，且**不能混用**（官方 `host-plugin.md:57-62`）。

本插件 `$PKG\lib\index.js:56-59`（`export const name` / `export const inject = ["tools"]` / `export function apply`）——**形态正确**。

### 7.5 ESM / Node 版本
- DSH 运行时 `package.json` 是 `"type": "module"`；Electron-as-node 报 `Node.js v24.21.0`。
- **运行时自带一份 Node**：`resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（实测 `--version` → `v24.21.0`），`resources\runtime\versions.json` 记录 `{ "schemaVersion": 1, "node": "24.21.0", "pnpm": "11.28.5" }`；`resources\runtime\bin\` 下另有 `node` / `node.cmd` 垫片。Desktop 的 CLI 仍走 `dsh.cmd` → Electron 的 `ELECTRON_RUN_AS_NODE`。
- **没有任何地方校验插件的 `engines.node`**（`unmetRequirements` 只读 `engines.dsh`，§1.1）。本插件的 `"engines": { "node": ">=24.0.0" }` 是纯声明，即使写错也不会被拒。
- 本插件是 `"type": "module"` + 纯 ESM `import`，与宿主一致。

### 7.6 `restrict()` 的 scoped 前置条件（新增硬错误）
见 §3.4。`tools.restrict() requires a scoped context (agent.ctx)`。

### 7.7 `dsh.bundle` 的其它键
除了 `patch`，`dsh.bundle` 的其它键**没有任何校验代码**（grep `bundle\.(entries|components|requires)` 命中 0）。写多余字段不会报错，也不会生效。

---

## What the working plugins declare

以下全部是 `$PROFILE\node_modules\<pkg>\package.json` 的实测原文，并用宿主的 `evaluatePluginCompatibility` 逐个跑过（runtime = `0.2.1-rc.2`）：

| 插件 | 版本 | `engines.dsh` | dsh 相关 peer | 判定 |
|---|---|---|---|---|
| `dsh-mattpocock-skills-deck` | 1.8.0-rc.7 | `>=0.2.0-rc.2` | 无 | ✅ COMPATIBLE |
| `@linxin666/dsh-web-all` | 0.4.7 | 无（`dsh.engines.dsh` 有，但不生效） | `"@deepseek-ai/dsh": ">=0.2.1-rc.2"` | ✅ COMPATIBLE |
| `dsh-hdc-bridge` | 0.10.2 | 无 | **无任何 peer** | ✅ COMPATIBLE |
| `dsh-free-search` | 0.9.1 | `>=0.1.7-rc.1` | `@deepseek-ai/dsh-tools`: `^0.1.7-rc.1 \|\| ^0.2.0-rc.1` 等 6 个 | ✅ COMPATIBLE |
| `dsh-client-auto-continue` | 0.14.2 | 无 | `@deepseek-ai/dsh-settings`: `^0.1.0-rc.7 \|\| ^0.1.7-0 \|\| ^0.2.0-rc.1` | ✅ COMPATIBLE |
| `dshmarket` | 1.66.35 | 无 | `@deepseek-ai/dsh-settings`: `… \|\| ^0.2.1-rc.1` | ✅ COMPATIBLE |
| `dsh-workbuddy-connect` | 0.7.8 | 无 | **精确钉死 6 个 `0.2.1-rc.2`** | ✅ COMPATIBLE（恰好命中） |
| `oss-prompt-optimizer` | 1.13.1 | `^0.2.0-rc.2` | 无 dsh peer（只有 cordis/react） | ✅ COMPATIBLE |
| `@liustack/modlens` | 3.27.1 | 无 | 无 | ✅ COMPATIBLE |
| `harmonyos-dev-mcp-for-dsh` | 0.1.1 | 无 | 无 | ✅ COMPATIBLE |
| `dsh-harmony-next` | 1.3.37 | 无 | 无 | ✅ COMPATIBLE |
| `dsh-our-free-model` | 2.5.3 | 无 | `@deepseek-ai/dsh-llm` 等 4 个均 `^0.1.2-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.1` | ✅ COMPATIBLE |
| `@opencode2dsh/dsh-plugin` | 0.3.12 | 无 | 无 | ✅ COMPATIBLE |
| **`dsh-oh-story-claudecode`** | **0.2.1** | 无 | **`@deepseek-ai/dsh-skill-filesystem`: `0.2.0-rc.2`** | ❌ **INCOMPATIBLE** |
| `dsh-a-stock-data` | 0.1.1 | 无 | `@deepseek-ai/dsh-skill-filesystem`: `0.2.0-rc.2` | ❌ INCOMPATIBLE |
| `@linfengqaqtat/dsh-scriptor` | 8.2.2 | 无 | `dsh-llm`/`dsh-skill-filesystem`/`dsh-tools` 全 `0.2.0-rc.2` | ❌ INCOMPATIBLE（本机已 disabled） |

**实证归纳出三种「不会被 0.2.1 拒绝」的写法**：

1. **干脆不声明任何 dsh peer**（`dsh-hdc-bridge`、`@liustack/modlens`、`harmonyos-dev-mcp-for-dsh`、`@opencode2dsh/dsh-plugin`）。零声明 = 零约束。
2. **用 `engines.dsh` 声明一个含预发布下界的范围**（`dsh-mattpocock-skills-deck` 的 `>=0.2.0-rc.2`、`oss-prompt-optimizer` 的 `^0.2.0-rc.2`）。
3. **用 `^` 范围 + 显式预发布下界**，必要时 `||` 并联多个历史线（`dsh-free-search`、`dsh-client-auto-continue`、`dshmarket` 的 `^0.1.0-rc.7 || ^0.1.7-0 || ^0.2.0-rc.1`）。

反例（会死的写法）：**精确预发布版本**（`0.2.0-rc.2`）、**`^0.2.1`**、**空串**。

---

## Recommendations for dsh-oh-story-claudecode

### 必须改（3 条）

1. **`$PKG\package.json` 的 `peerDependencies["@deepseek-ai/dsh-skill-filesystem"]` 从 `"0.2.0-rc.2"` 改成范围**。
   最小改动、且与本机 13 个正常工作（判 COMPATIBLE）的第三方插件风格一致：
   ```json
   "peerDependencies": {
     "@deepseek-ai/dsh-skill-filesystem": "^0.2.0-rc.2"
   }
   ```
   实测 `^0.2.0-rc.2` 在 `0.2.1-rc.2` 下判 COMPATIBLE（§1.2），且同时覆盖 `0.2.0-rc.2`。若想更保守（只向上兼容到 0.3 之前）可写 `">=0.2.0-rc.2 <0.3.0"`，两者等价。
   **绝对不要写 `^0.2.1`**——预发布 `0.2.1-rc.2` 不满足它。
   > 证据：本机 `loadProfileDirectory` 现在把本插件放进 `skippedBundles`，`reason` 就是这一条 peer。

2. **不要改成 `engines.dsh`，除非你同时删掉 peer**。
   `engines.dsh` 存在即**短路全部 peer 校验**（§1.1），所以把 `"engines": { "dsh": "^0.2.0-rc.2" }` 加进去也能修好——但它会让「对 `dsh-skill-filesystem` 的依赖声明」彻底失去兼容性保护。若两处都写，实际生效的只有 `engines.dsh`。**推荐只改 peer，不加 `engines.dsh`**；若确实想要一条「整体兼容区间」的自我声明，加 `engines.dsh` 时必须意识到它会让 peer 检查失效。

3. **改完必须重启 DSH 进程验证，不能只看安装成功**。
   本插件是 `link:D:/DS/插件/oh-story-claudecode/packages/dsh-plugin`（`$PROFILE\package.json:16`），改 `package.json` 不会触发重装；`loadProfileDirectory` 在**每次启动与每次重新组合**时读 manifest（§1.3(a)）。验收方式：调一次 `oh_story_probe`，看 `toolSurface.visibleAtCall` 是否等于 `attempted`、`missing` 是否为空（探针就是为这个设计的，见 `$PKG\lib\index.js:38-41` 与 `:125-142` 的注释）。**注意**：本插件目前连 bundle 层都没进 `layers`，所以探针根本不可用——修完 `package.json` 后要**先重启 DSH**，探针才会出现。

### 可选（3 条）

1. **补 `locale/en.json` + `locale/zh.json` + `icon.svg` 并写进 `exports`/`files`**。
   不加也能装载（§6.2 明确有回退），加了只是让设置页显示「Oh Story 写作工具」而不是包名。若要加，注意 `icon` 必须留在包内、≤256 KiB、SVG/PNG/JPEG/WebP 之一，否则会多一条 metadata 诊断。
2. **清掉 `skills\story-deslop\package.json` 与 `skills\story-long-write\package.json`（内容只有 `{"type":"commonjs"}`）以及两处 `scripts\__pycache__\*.pyc`**。
   不影响契约，只是打包卫生；`.pyc` 会随 `files: ["skills"]` 一起发布出去。
3. **在 `$PKG\README.md` 或 `.agents/notes` 里记一条「peer 必须用含 `-rc.N` 下界的范围」的踩坑记录**。
   本机已有 `dsh-a-stock-data`、`@linfengqaqtat/dsh-scriptor` 两个插件犯了同一个错（§"What the working plugins declare"），说明这是生态级的坑，不是本仓库独有的。
