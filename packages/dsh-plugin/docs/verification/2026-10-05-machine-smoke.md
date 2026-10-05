# 本机安装冒烟与验收链路（wayfinder #9 留档）

票：[本机安装冒烟与验收链路](https://github.com/xt1024AA/oh-story-claudecode/issues/9)（地图：DSH 插件化）。
根因与修法见 `.agents/notes/implemented/bug-fix/2026-10-05-dsh-plugin-tool-registration-effect.md`。

**原始输出（逐字，未删改，仅去掉 ANSI 颜色码）**在 `raw/` 下：`2026-10-05-smoke9-localpath-session.txt`（本地路径 spec 四步全链）、`2026-10-05-smoke9tgz-session.txt`（tgz spec：probe + skill 加载 + 工具面清单）、`2026-10-05-smoke9-reinstall-session.txt`（卸载后重装复测）、`2026-10-05-install-boundary-outputs.txt`（安装/卸载/重装的命令输出与 desktop 只读清单）。

## 环境（实测）

| 项 | 值 |
| --- | --- |
| DSH | `0.2.0-rc.2`（`dsh --version`） |
| Node | `v24.20.0` |
| Python | `Python 3.14.7`（`python3` 是 Microsoft Store 占位程序，探测链正确跳过，见下） |
| OS | Windows NT 10.0.26300 |
| 插件 | `dsh-oh-story-claudecode` **0.2.1**（本次修复后的版本） |

## 结论（一句话）

**装（本地路径 / tgz 两种 spec）→ 全新 DSH 进程的新会话发现并加载随包 skill → 8 个 `oh_story_*` 工具在工具面 → 调工具拿到真实业务结果**，全链可复现；边界（重复安装 / 卸载后重装 / 其它插件不受影响）逐项补测。

## 为什么验收跑在全新 profile 而不是桌面 profile 的活体会话

#9 的起点是桌面 profile 活体工具面只有 `oh_story_probe`（7 个写作工具缺失）。根因是装配期 `ctx.effect` 用法错误（见笔记），修在 0.2.1。**运行中的 DSH 进程缓存已加载的 JS 模块**（地图 Notes 铁律：改 `lib/` 必须重启才生效），所以桌面 profile 的活体验证必须等一次重启；本留档用「同一台机器 + 同一 DSH 版本 + 全新 profile + 全新进程」把装机与链路跑通，并在桌面 profile 上完成了不重启即可成立的部分（安装接线、随包 skills 挂载、其它插件不受影响）。

桌面 profile 侧不重启就能拿到的既有事实（本会话实测 `oh_story_probe`）：

```
插件 dsh-oh-story-claudecode v0.2.0 已装载。
随包 skills 目录：D:\DS\插件\oh-story-claudecode\packages\dsh-plugin\skills\（就位）
随包 skills 挂载：成功（提供方 oh-story-bundled）
细节：已登记提供方 oh-story-bundled，根目录 …（rank 600）
```

即：安装形态与 skills 通路在桌面 profile 上早已成立，缺的只是「重启后加载 0.2.1」。

## 验收 1：安装（两种 spec 各一次）

### A. 本地路径 spec → profile `smoke9`

```
$ dsh smoke9 --from-default-profile headless --dump-config          # 从 shipped headless 模板建全新 profile
$ dsh plugin --profile smoke9 add "D:\DS\插件\oh-story-claudecode\packages\dsh-plugin"
dependencies:
+ dsh-oh-story-claudecode link:D:/DS/插件/oh-story-claudecode/packages/dsh-plugin

Already up to date
Done in 1.1s using pnpm v11.7.0
```

安装后 profile 清单（`~/.dsh/profiles/smoke9/package.json`）：

```json
"dependencies": { "dsh-oh-story-claudecode": "link:D:/DS/插件/oh-story-claudecode/packages/dsh-plugin" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-oh-story-claudecode"] } }
```

组合树里出现插件行（`dsh smoke9 --dump-config`）：

```
# == dsh-oh-story-claudecode
- id: dsh-oh-story-claudecode
  name: dsh-oh-story-claudecode
  config: {}
```

### B. tgz spec → profile `smoke9tgz`

```
$ cd packages/dsh-plugin
$ npm pack --pack-destination ..\..\.smoke
npm notice unpacked size: 5.9 MB
npm notice shasum: 634a8b9b6e90d8fd0c2509cc95e48c6f2976186e
npm notice total files: 493
→ .smoke/dsh-oh-story-claudecode-0.2.1.tgz（1 782 468 字节）

$ dsh smoke9tgz --from-default-profile headless --dump-config
$ dsh plugin --profile smoke9tgz add "<abs>\.smoke\dsh-oh-story-claudecode-0.2.1.tgz"
[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.

dependencies:
+ dsh-oh-story-claudecode file:D:/DS/插件/oh-story-claudecode/.smoke/dsh-oh-story-claudecode-0.2.1.tgz

Packages: +1
Progress: resolved 1, reused 0, downloaded 1, added 1, done
Done in 1.5s using pnpm v11.7.0
```

tgz 内容抽查（`tar -tzf`，493 条目）：`package/lib/tools/*.js`、`package/cordis.patch.yml`、`package/skills/**`（13 个 skill 连同其脚本）齐备。peer dep 警告不阻塞装配——skills 挂载与工具注册在下面第 2 组里实测成功。

## 验收 2：新会话发现 skill + 触发工具

验收会话一律用单行 prompt 走 headless：

```
$ dsh smoke9 "<单行 prompt：调 oh_story_probe → oh_story_env → oh_story_chapter_check → oh_story_ai_patterns_check>"
```

### probe（本地路径 spec，全新进程）

```
插件 dsh-oh-story-claudecode v0.2.1 已装载。
随包 skills 目录：D:\DS\插件\oh-story-claudecode\packages\dsh-plugin\skills\（就位）
随包 skills 挂载：成功（提供方 oh-story-bundled）
细节：已登记提供方 oh-story-bundled，根目录 D:\DS\插件\oh-story-claudecode\packages\dsh-plugin\skills\（rank 600）
工具面：装配 8 个 / register 成功 8 个 / 此刻在册 8 个
回显：smoke9
写作工具（oh_story_* 系列）已随 #8 落地；先跑 oh_story_env 看环境。
```

`此刻在册 8 个` 是**调用时回读宿主注册表**的结果（`ctx.tools.get`），不是注册返回值——这正是修前真机会显示成 1 个的那个数字。

### probe（tgz spec）

```
随包 skills 目录：C:\Users\49178\.dsh\profiles\smoke9tgz\node_modules\dsh-oh-story-claudecode\skills\（就位）
随包 skills 挂载：成功（提供方 oh-story-bundled）
工具面：装配 8 个 / register 成功 8 个 / 此刻在册 8 个
回显：smoke9tgz
```

### skill 被发现并可加载（tgz spec 会话内实测）

```
<skill_content name="story-deslop">
<skill_resources>
Base directory for this skill: C:\Users\49178\.dsh\profiles\smoke9tgz\node_modules\dsh-oh-story-claudecode\skills\story-deslop
Resolve relative paths mentioned by this skill against the base directory before using it. Load referenced resources only as needed.
</skill_resources>
```

返回的是完整 `skill_instructions` 块，无失败信息——随包 skill 的**发现 + 加载**在 tgz 安装形态下成立，且 base directory 落在安装副本里（不是工作区）。

### 工具面清单（会话内列名，与 probe 的「在册 8 个」互证）

`oh_story_ai_patterns_check`、`oh_story_chapter_check`、`oh_story_chapter_commit`、`oh_story_degeneration_check`、`oh_story_env`、`oh_story_probe`、`oh_story_punctuation_normalize`、`oh_story_wordcount`。

## 验收 3：真实写作闭环链路（真实业务结果）

### oh_story_env（摘录）

```
python.ok = true   bin=python   version=Python 3.14.7   source=probe
  tried: python3 → ok:false, detail:"验证命令退出码 9009"（Store 占位，被正确跳过）
         python  → ok:true,  detail:"验证命令 `-c \"\"` 退出码 0"
node.ok   = true   bin=node     version=v24.20.0        source=probe
scripts: storyctl / wordcountCore / aiPatterns / degeneration / punctuation / styleWhitelist —— exists 全部 true
```

### oh_story_chapter_check（demo 长篇 第 21 章）

```
OK oh_story_chapter_check（status: ready）
等价命令：python …\skills\story-long-write\scripts\storyctl.py chapter check --project …\demo\长篇\让你管账号，你高燃混剪炸全网 --chapter 21
退出码：0
落盘副作用：无
result.status = "ready"；length.actual = 2068 / target = 2300（internal_band pass）；
quality.status = "pass"，blocking_findings = []；available_actions = ["commit"]
```

### oh_story_ai_patterns_check（demo 去AI味对照 改前.md）

```
OK oh_story_ai_patterns_check（status: findings）
等价命令：node …\check-ai-patterns.js --check --json --fail-on=blocking …\demo\去AI味对照\改前.md
退出码：1
计数：total=8，blocking=7，advisory=1
```

（`exit 1` 是业务判定「有发现」，工具 `ok` 仍为真——#8 定的信封语义。）

### oh_story_wordcount（卸载重装后复测）

```
OK oh_story_wordcount（status: measured）
退出码：0    actual = 2068    metric = visible_chars_v1
```

## 验收 4：边界补测

| 边界 | 命令 | 结果 |
| --- | --- | --- |
| 重复安装 | `dsh plugin --profile smoke9 add <同一路径>`（第二次） | `Already up to date`；依赖行与 bundles 列表无重复、无变化 |
| 卸载 | `dsh plugin --profile smoke9 remove dsh-oh-story-claudecode` | 依赖与 bundles **全部复原**；`--dump-config` 里插件行 **零残留** |
| 卸载残留 | 同上后看 `node_modules` | **物理 Junction 残留**（`dsh-oh-story-claudecode → 工作区`），需 `cmd /c rmdir "<链接>"` 手动清——与 #5 实测一致 |
| 卸载后重装 | 残留在位时直接 `add` | `exit 0`，清单复原；随后新会话 probe「在册 8 个」+ wordcount 2068 |
| profile 里其它插件 | `dsh plugin --profile desktop list --depth 0`（只读） | 12 个依赖全部在位（dshmarket / modlens / hdc-bridge / mattpocock-skills-deck / harmony-next / scriptor 等），我们的插件是其中一条 |
| base bundles 不受影响 | smoke9 反复 add/remove 后仍能引导会话 | 会话正常起来（上面所有 headless 验收都是它跑的） |

## 失败点与绕行（不修饰）

1. **7 个写作工具注册即注销**（本次真机事故）。根因：`ctx.effect(() => { 清理() })` 写法错误，cordis 会在注册当刻调用该回调并把它当清理函数登记，于是刚注册的工具当场被注销。修法与回归护栏见 bug-fix 笔记。
2. **旧 mock 不忠实**：`scripts/test-tools.mjs` 原先把 `effect` 写成 `effect() {}`（不调用回调），导致本地 8/8 全绿、真机全丢。已改为 `fakeHostCtx()` 忠实模型并新增 A1b 回归项（35 项）。
3. **`dsh headless` 的 task 参数按行截断**：多行 prompt 只到第一个换行就被截断（第一次冒烟时 agent 反馈「清单没跟过来」）。绕行：prompt 压成单行传入；本留档所有验收会话均单行。
4. **新 profile 装 tgz 报 peer dependency 警告**（`@deepseek-ai/dsh-skill-filesystem` 不在 profile 的 node_modules 里）。实测**不阻塞**：宿主侧解析成功，skills 挂载与 8 个工具都正常。
5. **headless stdout 带 ANSI 颜色码**，直接存档会出现不可读字符。绕行：`-replace "\x1b\[[0-9;?]*[a-zA-Z]", ""` 后再落盘。
6. **PowerShell 把原生程序的 stderr 当 NativeCommandError**：`dsh` 的 reasoning 诊断走 stderr，`$LASTEXITCODE` 才是真退出码（本留档的会话退出码一律为 0）。
7. **Junction 残留在卸载后不自动清**（见上表），重装能盖过它，但目录会一直留着。

## 复现命令（照抄即可）

```powershell
$dsh = "C:\Users\49178\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 1) 本地路径 spec
& $dsh smoke9 --from-default-profile headless --dump-config
& $dsh plugin --profile smoke9 add "D:\DS\插件\oh-story-claudecode\packages\dsh-plugin"

# 2) tgz spec
cd packages\dsh-plugin; npm pack --pack-destination ..\..\.smoke; cd ..\..
& $dsh smoke9tgz --from-default-profile headless --dump-config
& $dsh plugin --profile smoke9tgz add "D:\DS\插件\oh-story-claudecode\.smoke\dsh-oh-story-claudecode-0.2.1.tgz"

# 3) 验收会话（prompt 必须单行）
& $dsh smoke9 "只做下面四步……1) 调 oh_story_probe，参数 echo=`"smoke9`"；2) 调 oh_story_env；3) 调 oh_story_chapter_check（project=…第 21 章）…"

# 4) 边界
& $dsh plugin --profile smoke9 add "D:\DS\插件\oh-story-claudecode\packages\dsh-plugin"     # 重复安装
& $dsh plugin --profile smoke9 remove dsh-oh-story-claudecode                              # 卸载
cmd /c rmdir "C:\Users\49178\.dsh\profiles\smoke9\node_modules\dsh-oh-story-claudecode"     # 清残留链接
& $dsh plugin --profile smoke9 add "D:\DS\插件\oh-story-claudecode\packages\dsh-plugin"     # 重装
& $dsh plugin --profile desktop list --depth 0                                             # 其它插件（只读）
```

## 未完成 / 下一步

- **桌面 profile 的活体确认**：DSH 不热换已加载模块，重启后在新会话调一次 `oh_story_probe`，预期看到「装配 8 个 / register 成功 8 个 / 此刻在册 8 个」（修前只有 1 个）。
- 本留档的验收 profile `smoke9` / `smoke9tgz` 是临时产物，确认完可删（`dsh plugin --profile <名> remove dsh-oh-story-claudecode` + 删 profile 目录）。
- `chapter accept-current-length` 仍未封装（#8 范围外，此处未测）。
