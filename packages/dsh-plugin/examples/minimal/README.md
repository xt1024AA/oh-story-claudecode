# 最小示例：从零到一条真实业务结果

目标：在一个**干净起点**（全新 profile，没有任何既有安装）上把插件装好，并拿到一条**真实业务结果**。

> **本文件的每条命令都在本机实跑过，输出是复制来的，不是推演。**
> 实跑环境：DSH `0.2.0-rc.2`（Windows）· Node `v24.20.0` · Python `3.14.7` · 插件 `dsh-oh-story-claudecode@0.2.1`（commit `5ee90e3`）。
> 下文 `<repo>` 指本仓库根目录（示例里是 `D:\DS\插件\oh-story-claudecode`）。

## 0. 前提

- 已装 DSH 桌面版（自带 `dsh` 命令）。
- Node ≥ 24（本包 `engines.node`）；Python 3 —— 探测链是 `python3 → python → py -3`，会**自动跳过 Microsoft Store 的 `python3` 占位程序**（本机就是这样：`python3` 退出码 9009，落到 `python`）。
- 仓库已克隆；示例用仓库自带的样书 `demo/长篇/让你管账号，你高燃混剪炸全网`（第 21 章）。

## 1. 建一个干净 profile（不碰你日常用的 desktop profile）

```powershell
dsh smoke-mini --from-default-profile headless --dump-config
```

输出（组合树开头，`--dump-config` 打印完整树后即退出，不启动会话）：

```
# == @deepseek-ai/dsh-base
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: true
...
```

`headless` 是「一问一答就退出」的 app（`dsh <profile> "任务"`），最适合做这种验证；装配机制与 desktop profile 完全相同。

## 2. 装插件（本地路径 spec）

```powershell
dsh plugin --profile smoke-mini add "<repo>\packages\dsh-plugin"
```

输出：

```
dependencies:
+ dsh-oh-story-claudecode link:D:/DS/插件/oh-story-claudecode/packages/dsh-plugin

Already up to date
Done in 365ms using pnpm v11.7.0
```

> ⚠️ 路径必须**绝对**（DSH 拒绝相对路径）。装完 DSH 会把本包写进 profile 的 `dependencies` 与 `dsh.profile.bundles`。
> 若你的目标 profile 里**已经装过**本插件的旧版本，改了 `lib/` 之后必须**重启 DSH** 才会加载新 JS 模块（HMR 只热加新条目、不热换已有模块）。

## 3. 问一句，拿真实业务结果

```powershell
dsh smoke-mini '调两个工具，把返回的原文各原样打印一遍：1) oh_story_probe，参数 echo="minimal-example"；2) oh_story_chapter_check，参数 project="<repo>\demo\长篇\让你管账号，你高燃混剪炸全网"、chapter=21。最后单独一行输出 EXAMPLE-DONE。'
```

**期望输出**（实测原文）：

```
插件 dsh-oh-story-claudecode v0.2.1 已装载。
随包 skills 目录：D:\DS\插件\oh-story-claudecode\packages\dsh-plugin\skills\（就位）
随包 skills 挂载：成功（提供方 oh-story-bundled）
细节：已登记提供方 oh-story-bundled，根目录 D:\DS\插件\oh-story-claudecode\packages\dsh-plugin\skills\（rank 600）
工具面：装配 8 个 / register 成功 8 个 / 此刻在册 8 个
回显：minimal-example
写作工具（oh_story_* 系列）已随 #8 落地；先跑 oh_story_env 看环境。
```

```
OK oh_story_chapter_check（status: ready）
等价命令：python D:\DS\插件\oh-story-claudecode\packages\dsh-plugin\skills\story-long-write\scripts\storyctl.py chapter check --project D:\DS\插件\oh-story-claudecode\demo\长篇\让你管账号，你高燃混剪炸全网 --chapter 21
退出码：0
提示：
  - 本章可提交（available_actions 里有 commit）。
  - ok=true 只表示拿到了有效判定；status=blocked 是业务拦截，按 result.quality.blocking_findings 处理。
落盘副作用：无
业务结果（JSON）：
{
  "schema": "story-chapter-check/v1",
  "status": "ready",
  "chapter": 21,
  "length": { "metric": "visible_chars_v1", "target": 2300, "actual": 2068, "status": "internal_pass", ... },
  "quality": { "status": "pass", "blocking_findings": [], "advisories": [], "tool_errors": [] },
  "available_actions": ["commit"]
}
EXAMPLE-DONE
```

三个关键点读这张输出：

1. `此刻在册 8 个` 是**调用时回读宿主注册表**的结果（不是注册返回值）——插件装没装好，看这一个数字就够。
2. `status: ready` 是**业务判定**（脚本给的），`ok/退出码` 是**调用是否拿到有效结果**；两者是两回事（`blocked`/`findings` 同样是正常业务结果）。
3. `落盘副作用：无` —— 只读工具如实申报自己没写盘。

> 提示：prompt 请**压成单行**。`dsh` 的 task 参数按行截断，多行 prompt 只会送到第一个换行（wayfinder #9 实测踩过）。

## 4. 不进 DSH 的等价路径（原脚本仍可独立运行）

底层脚本不依赖 DSH，可以直接跑 —— 这也是排障时确认「是脚本问题还是插件问题」的最快手段：

```powershell
python "<repo>\packages\dsh-plugin\skills\story-long-write\scripts\storyctl.py" chapter check --project "<repo>\demo\长篇\让你管账号，你高燃混剪炸全网" --chapter 21
```

输出（**一行 JSON**，`storyctl.py` 的 stdout 契约）：

```json
{"schema":"story-chapter-check/v1","status":"ready","chapter":21,"length":{"metric":"visible_chars_v1","target":2300,"actual":2068,"status":"internal_pass",...},"quality":{"status":"pass","blocking_findings":[],...},"available_actions":["commit"]}
```

退出码 `0`。与第 3 步的 `result` 是同一份判定 —— 插件只是把脚本包了一层结构化的壳（解释器探测、路径校验、参数校验、信封、审批闸门）。

## 5. 干净目录里复现

不需要动仓库里的样书，复制到临时目录跑，结论一模一样：

```powershell
$tmp = Join-Path $env:TEMP "oh-story-mini-example"
Copy-Item -Recurse "<repo>\demo\长篇\让你管账号，你高燃混剪炸全网" $tmp
python "<repo>\packages\dsh-plugin\skills\story-long-write\scripts\storyctl.py" chapter check --project $tmp --chapter 21
```

输出与第 4 步**逐字相同**（`status: ready`、`actual: 2068`、退出码 0），说明判定只取决于书目录本身，不依赖仓库里的隐藏状态。

## 6. 另一种安装形态：tgz

```powershell
cd <repo>\packages\dsh-plugin
npm pack --pack-destination <repo>\dist
```

输出（本次实测）：

```
npm notice filename: dsh-oh-story-claudecode-0.2.1.tgz
npm notice package size: 1.8 MB
npm notice unpacked size: 5.9 MB
npm notice shasum: b5659b43b9d9bb8beaa2724b466c5f682b15e3aa
npm notice total files: 493
```

（tgz 里是 `lib/`（含 `lib/index.d.ts`）+ `skills/` + `cordis.patch.yml` + `README.md`；`docs/` 与
`examples/` 不进 tgz，理由见 README「已知限制与假设」。）

装进另一个干净 profile 并自检：

```powershell
dsh smoke-mini-tgz --from-default-profile headless --dump-config
dsh plugin --profile smoke-mini-tgz add "<repo>\dist\dsh-oh-story-claudecode-0.2.1.tgz"
dsh smoke-mini-tgz '只做一件事：调 oh_story_probe，参数 echo="tgz-example"，把返回的原文整段原样打印，最后单独一行输出 TGZ-EXAMPLE-DONE。'
```

期望输出：

```
dependencies:
+ dsh-oh-story-claudecode file:D:/DS/插件/oh-story-claudecode/dist/dsh-oh-story-claudecode-0.2.1.tgz

Packages: +1
Progress: resolved 1, reused 0, downloaded 1, added 1, done
Done in 705ms using pnpm v11.7.0
```

```
插件 dsh-oh-story-claudecode v0.2.1 已装载。
随包 skills 目录：C:\Users\49178\.dsh\profiles\smoke-mini-tgz\node_modules\dsh-oh-story-claudecode\skills\（就位）
随包 skills 挂载：成功（提供方 oh-story-bundled）
细节：已登记提供方 oh-story-bundled，根目录 C:\Users\49178\.dsh\profiles\smoke-mini-tgz\node_modules\dsh-oh-story-claudecode\skills\（rank 600）
工具面：装配 8 个 / register 成功 8 个 / 此刻在册 8 个
回显：tgz-example
写作工具（oh_story_* 系列）已随 #8 落地；先跑 oh_story_env 看环境。
TGZ-EXAMPLE-DONE
```

注意 skills 目录落在**安装副本**里（`profiles\<profile>\node_modules\dsh-oh-story-claudecode\skills\`）—— tgz 形态自带 13 个 skill，不依赖仓库。

## 7. 卸载

```powershell
dsh plugin --profile smoke-mini remove dsh-oh-story-claudecode
```

输出：

```
dependencies:
- dsh-oh-story-claudecode link:D:/DS/插件/oh-story-claudecode/packages/dsh-plugin
```

清单与组合树会复原（`--dump-config` 里插件行零残留），但**物理残留两种形态行为不同**（都实测过）：

| 安装形态 | `remove` 之后 | 需要手工清吗 |
| --- | --- | --- |
| 本地路径（`link:`） | `node_modules\dsh-oh-story-claudecode` 仍是 **Junction** 指向仓库 | 需要：`cmd /c rmdir "<profile>\node_modules\dsh-oh-story-claudecode"` |
| tgz（`file:`） | 安装副本被一并删除，**无残留** | 不需要 |

## 8. 自动化等价物（不想手点就跑这个）

```powershell
cd <repo>\packages\dsh-plugin
node scripts/test-tools.mjs     # 35 项：真实业务结果（happy path）+ 全部错误路径
node scripts/check-parity.mjs   # skills 副本与仓库根 skills/ 的逐字节一致性
```

类型声明也能单独验（编译期检查，不运行；需要 TS，本机无工具链所以用 npx 现拉）：

```powershell
npx --yes -p typescript@5 tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext examples/types/consumer.ts
```

> `pnpm test:tools` / `pnpm test:parity` / `pnpm test:types`（见 `package.json` 的 `scripts`）是等价别名 ——
> 前提是你的 PATH 里有 `pnpm`；没有就直接用上面的 `node` / `npx` 形式。

## 已知假设（显式标注）

- 示例用 `headless` profile 是为了不打扰你日常的 `desktop` profile；两者装配机制相同（同一份 `cordis.patch.yml` + `dsh.profile.bundles`）。
- 示例的书来自**本仓库**的 `demo/`（`demo/` 不在 tgz 里，也不属于插件包）。
- `dsh` 的 task 参数**按行截断**，所以 prompt 一律单行。
- 示例里的绝对路径是本机（Windows）实测路径；换机器请替换 `C:\Users\49178\.dsh` 与仓库路径。
- 版本号、文件数、shasum 是**本次实测值**：换代码后重新 `npm pack` 会变。
