# 安装/使用文档与最小示例的实测留档（wayfinder #11）

票：[安装与使用文档 + 最小示例](https://github.com/xt1024AA/oh-story-claudecode/issues/11)。
交付物：[子包 `README.md`](../../README.md) · [最小示例 `examples/minimal/README.md`](../../examples/minimal/README.md) ·
[类型声明 `lib/index.d.ts`](../../lib/index.d.ts) · [类型检查消费者 `examples/types/consumer.ts`](../../examples/types/consumer.ts)。

本文件是**验收标准的取证**：「文档里的每条命令都是实际跑过的」。下面每条命令都是本轮实跑，输出逐字复制
（仅去掉 ANSI 颜色码）；省略处一律用 `…` 标出。

实跑环境：DSH `0.2.0-rc.2`（Windows NT 10.0.26300）· Node `v24.20.0` · Python `3.14.7` · 插件 0.2.1。

## 1. 建干净 profile（示例第 1 步）

```
$ dsh smoke-mini --from-default-profile headless --dump-config
# == @deepseek-ai/dsh-base
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: true
…
```

## 2. 本地路径 spec 安装（示例第 2 步）

```
$ dsh plugin --profile smoke-mini add "D:\DS\插件\oh-story-claudecode\packages\dsh-plugin"

dependencies:
+ dsh-oh-story-claudecode link:D:/DS/插件/oh-story-claudecode/packages/dsh-plugin

Already up to date
Done in 365ms using pnpm v11.7.0
```

## 3. 最小示例会话（示例第 3 步，逐字全文）

prompt（单行）：`调两个工具，把返回的原文各原样打印一遍，不要改写任何数字：1) oh_story_probe，参数 echo="minimal-example"；2) oh_story_chapter_check，参数 project="<书目录>"、chapter=21。除了这两次调用与打印，不要做任何别的事。最后单独一行输出 EXAMPLE-DONE。`

```
1) oh_story_probe（echo=minimal-example）原文：

插件 dsh-oh-story-claudecode v0.2.1 已装载。
随包 skills 目录：D:\DS\插件\oh-story-claudecode\packages\dsh-plugin\skills\（就位）
随包 skills 挂载：成功（提供方 oh-story-bundled）
细节：已登记提供方 oh-story-bundled，根目录 D:\DS\插件\oh-story-claudecode\packages\dsh-plugin\skills\（rank 600）
工具面：装配 8 个 / register 成功 8 个 / 此刻在册 8 个
回显：minimal-example
写作工具（oh_story_* 系列）已随 #8 落地；先跑 oh_story_env 看环境。

2) oh_story_chapter_check（project=D:\DS\插件\oh-story-claudecode\demo\长篇\让你管账号，你高燃混剪炸全网、chapter=21）原文：

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
  "length": { … "metric": "visible_chars_v1", "target": 2300, "actual": 2068, "status": "internal_pass" … },
  "quality": { "status": "pass", "blocking_findings": [], "advisories": [], "tool_errors": [] },
  "compression": null,
  "state_revision": 1,
  "tracking_committed": true,
  "next_chapter_started": false,
  "available_actions": ["commit"]
}

EXAMPLE-DONE
```

（`length` 一节在留档里用 `…` 省略了 band 明细与百分比；示例 README 里保留同样省略，并在正文标明长 JSON 有省略。）

## 4. 不进 DSH 的等价路径（示例第 4 步）

```
$ python "<repo>\packages\dsh-plugin\skills\story-long-write\scripts\storyctl.py" chapter check --project "<repo>\demo\长篇\让你管账号，你高燃混剪炸全网" --chapter 21
{"schema":"story-chapter-check/v1","status":"ready","chapter":21,"length":{"schema":"story-wordcount-result/v1","metric":"visible_chars_v1","chapter":21,"case_id":null,"target":2300,"actual":2068,"internal_band":{"min":2024,"max":2576,"status":"pass"},"user_band":{"min":1955,"max":2645,"status":"pass"},"signed_error_pct":-0.10086956521739131,"absolute_error_pct":0.10086956521739131,"band_source":"default","status":"internal_pass","invalid_reason":null},"quality":{"status":"pass","blocking_findings":[],"advisories":[],"semantic_advisories":0,"tool_errors":[]},"compression":null,"state_revision":1,"tracking_committed":true,"next_chapter_started":false,"available_actions":["commit"]}
退出码 0
```

## 5. 干净目录复现（示例第 5 步）

```
$ tmp = Join-Path $env:TEMP "oh-story-mini-example"; Copy-Item -Recurse "<repo>\demo\长篇\…" $tmp
$ python "<repo>\packages\dsh-plugin\skills\story-long-write\scripts\storyctl.py" chapter check --project $tmp --chapter 21
```

输出与第 4 步**逐字相同**（`"status":"ready"`、`"actual":2068`、退出码 0），说明判定只取决于书目录本身，
不依赖仓库里的隐藏状态。

## 6. tgz spec（示例第 6 步）

```
$ cd <repo>\packages\dsh-plugin; npm pack --pack-destination <repo>\dist
npm notice filename: dsh-oh-story-claudecode-0.2.1.tgz
npm notice package size: 1.8 MB
npm notice unpacked size: 5.9 MB
npm notice shasum: afd8e898e944c9c9776f4ba57ed69106edccc18d
npm notice total files: 493
```

> 注：**本轮的最终 shasum 见文末「包」一节**（上面这次 pack 之后，`package.json` 又加了 `test:types`
> 脚本，内容变了 → shasum 会变；示例 README 里引用的以最终值为准）。

tgz 关键条目（`tar -tzf`）：`package/lib/index.js`、`package/lib/index.d.ts`、`package/cordis.patch.yml`、
`package/README.md`、`package/skills/**`（13 个 skill）。`docs/` 与 `examples/` **不在** tgz 里。

```
$ dsh smoke-mini-tgz --from-default-profile headless --dump-config
$ dsh plugin --profile smoke-mini-tgz add "<repo>\dist\dsh-oh-story-claudecode-0.2.1.tgz"

dependencies:
+ dsh-oh-story-claudecode file:D:/DS/插件/oh-story-claudecode/dist/dsh-oh-story-claudecode-0.2.1.tgz

Packages: +1
Progress: resolved 1, reused 0, downloaded 1, added 1, done
Done in 705ms using pnpm v11.7.0
```

（全新 profile 上 pnpm 会额外打一句 peer dependency 警告，见 README 的说明：不阻塞。）

```
$ dsh smoke-mini-tgz '只做一件事：调 oh_story_probe，参数 echo="tgz-example"，把返回的原文整段原样打印，最后单独一行输出 TGZ-EXAMPLE-DONE。'

插件 dsh-oh-story-claudecode v0.2.1 已装载。
随包 skills 目录：C:\Users\49178\.dsh\profiles\smoke-mini-tgz\node_modules\dsh-oh-story-claudecode\skills\（就位）
随包 skills 挂载：成功（提供方 oh-story-bundled）
细节：已登记提供方 oh-story-bundled，根目录 …（rank 600）
工具面：装配 8 个 / register 成功 8 个 / 此刻在册 8 个
回显：tgz-example
写作工具（oh_story_* 系列）已随 #8 落地；先跑 oh_story_env 看环境。

TGZ-EXAMPLE-DONE
```

skills 目录落在**安装副本**里（`profiles\<profile>\node_modules\dsh-oh-story-claudecode\skills\`）——
tgz 形态自带 13 个 skill，不依赖仓库。

## 7. 卸载两形态（示例第 7 步）

### 本地路径（`link:`）——会有物理残留

```
$ dsh plugin --profile smoke-mini remove dsh-oh-story-claudecode

dependencies:
- dsh-oh-story-claudecode link:D:/DS/插件/oh-story-claudecode/packages/dsh-plugin

Already up to date
Done in 351ms using pnpm v11.7.0

物理残留：LinkType=Junction  Target=D:\DS\插件\oh-story-claudecode\packages\dsh-plugin
$ cmd /c rmdir "<profile>\node_modules\dsh-oh-story-claudecode"
清理后 Test-Path = False
```

### tgz（`file:`）——无残留

```
$ dsh plugin --profile smoke-mini-tgz remove dsh-oh-story-claudecode

dependencies:
- dsh-oh-story-claudecode file:D:/DS/插件/oh-story-claudecode/.smoke-docs/dsh-oh-story-claudecode-0.2.1.tgz

Already up to date
Done in 387ms using pnpm v11.7.0

物理残留：无（node_modules 下已无该目录；此时对我方 rmdir 报 “cannot find the file”，符合预期）
组合树里插件行数：0
```

两种形态的差异已写进 README 的卸载表（`link:` 要手工 `rmdir`，`file:` 不用）。

## 8. 测试、守卫与类型检查

```
$ node scripts/check-parity.mjs
[check-parity] 一致：465 个文件逐字节相同。         退出码 0

$ node scripts/test-tools.mjs
工具面测试：35 项，0 项失败。                       退出码 0
```

```
$ npx --yes -p typescript@5 tsc --version
Version 5.9.3

$ npx --yes -p typescript@5 tsc --noEmit --strict --target es2022 \
    --module nodenext --moduleResolution nodenext lib/index.d.ts
（无输出）退出码 0

$ … 同上，目标是 examples/types/consumer.ts
（无输出）退出码 0
```

反向验证（证明这套检查不是空转）：故意写错的消费者分别得到

```
.bad-consumer.tmp.ts(2,14): error TS2740: Type '{ ok: true; tool: string; }' is missing the following
  properties from type 'Envelope<Record<string, unknown>>': command, exitCode, status, env, and 4 more.
.bad-consumer.tmp.ts(3,188): error TS2322: Type 'number' is not assignable to type 'string'.
退出码 2
```

仓库级守卫（本轮收尾时跑，全绿）：`static-check.sh`（13/13）· `check-doc-budget.sh` ·
`check-shared-files.sh` · `check-current-skill-contracts.sh` · `check-python-invocation.sh` ·
`check-agent-notes.py`（67 notes）· `check-plugin-packaging.py` · `check-reference-gates.js`。

## 9. 本轮改动与假设（不修饰）

**改动**

- `README.md`：补齐 #11 要求的全部小节（环境要求与依赖、两种安装 spec、卸载两形态、调用示例、
  测试与守卫映射、类型声明、已知限制与假设），并把#9 的验收留档与最小示例挂上首页。
- `examples/minimal/README.md`（新）：从零到一条真实业务结果的九步走，输出为本机实跑复制。
- `lib/index.d.ts`（新）：宿主装配面的类型声明；`package.json` 加 `types` 字段与 `test:types` 脚本。
- `examples/types/consumer.ts`（新）：只做编译期检查的消费者，让类型声明可被 `tsc` 验证。

**假设（显式标注）**

1. 示例用 **headless profile** 而不是 desktop profile：装配机制相同（同一份 `cordis.patch.yml` +
   `dsh.profile.bundles`），但不会打扰作者日常的 desktop profile。
2. `docs/` 与 `examples/` **不进 tgz**（`package.json` 的 `files` 不含它们）：它们依赖仓库里的
   `demo/` 样书与仓库内相对链接，进了 tgz 也用不上。README 已写明这一点。
3. 本机**没有 TypeScript 工具链**（`tsc` / `typescript` 均不在 PATH，DSH 与 profile 的 `node_modules`
   里也没有），所以类型检查用 `npx --yes -p typescript@5`（实测 5.9.3）。CI 里**没有**这项检查——
   它需要网络与 TS，属「尽力交付」，已在 README 里如实说明。
4. 文档里的绝对路径是**本机实测路径**（Windows）；换机器需替换 `C:\Users\49178\.dsh` 与仓库路径。
5. 长 JSON 在文档与留档里用 `…` 省略了中间字段（省略处不改变结论）；完整原文见第 4 步的一行 JSON
   与 `docs/verification/2026-10-05-machine-smoke.md` 的 #9 留档。

## 10. 包（本轮最终值）

最终 `npm pack`（`package.json` 冻结后重跑）：

```
npm notice filename: dsh-oh-story-claudecode-0.2.1.tgz
npm notice package size: 1.8 MB
npm notice unpacked size: 5.9 MB
npm notice shasum: b5659b43b9d9bb8beaa2724b466c5f682b15e3aa
npm notice total files: 493
```

（这一次是 `package.json` 与 `README.md` 都冻结之后的**最终** pack。注意 `README.md` 自己也在包里，
所以**任何一次文档改动都会改变 shasum**——README 里因此写的是占位符加说明，具体值只在本文件与
`examples/minimal/README.md`（两者都不在包里）留档。）

复跑命令（会打印当次的 shasum）：

```powershell
cd packages/dsh-plugin
npm pack --pack-destination ..\dist
```
