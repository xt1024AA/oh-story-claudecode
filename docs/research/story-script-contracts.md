# 写作闭环核心脚本调用契约（本机实测）

调研票：#3「钉死写作闭环核心脚本的调用契约」。全部结论来自本机实跑或仓库原文，实跑优先于读源码推断；查不到的写「未找到」。

**实测环境**（本节所有数字都是本机实测，不是文档抄写）：

| 项 | 实测值 | 取得方式 |
| --- | --- | --- |
| 平台 | Windows / pwsh（会话工作目录 `D:\DS\插件\oh-story-claudecode`） | 实跑 |
| `node --version` | `v24.20.0` | 实跑 |
| `python --version` / `py --version` | `Python 3.14.7`（`python` → `C:\Python314\python.exe`；`py` → `C:\WINDOWS\py.exe`） | 实跑 |
| `python3 --version` | **无输出，exit 9009**（`python3` → `C:\Users\49178\AppData\Local\Microsoft\WindowsApps\python3.exe`，Microsoft Store 占位程序） | 实跑 |
| 破坏性实验落点 | 系统临时目录 `%TEMP%\oh-story-research\`（`proj` / `proj2` / `bookA` / `bookB` / `normtest` 等，均为 `demo\` 的副本或临时构造） | 实跑 |
| 仓库自身 | 除本文档外未新增/修改任何文件（跑完 `git status --porcelain` 与跑前一致） | 实跑 |

## 结论速览

1. **`storyctl.py` 有 2 个命令组 6 个子命令**：`wordcount {measure,check,checkpoint}`、`chapter {check,commit,accept-current-length}`。`chapter commit` 与 `chapter accept-current-length` 是**两个并列子命令**，不是 `commit --accept` 开关（`storyctl.py:447`）。全部命令**不读 stdin**，只吃 argv；一致输出「一行 JSON 到 stdout」。
2. **`chapter check` 顶层 `status` → 退出码是固定映射**：`ready`/`needs_decision` → 0，`blocked`/`invalid` → 1，`tool_unavailable` → 3（`storyctl.py:236`）。参数错/文件缺 → `story-chapter-error/v1` + exit 2；`chapter` 组里只有 `TOOL_UNAVAILABLE` 用 3（`storyctl.py:237`）。`wordcount` 组是 0/2 两档。
3. **副作用只有三处，其余全部只读**：
   - `chapter check --fix-punctuation` **原地改写正文**（`storyctl.py:324-338` → `normalize-punctuation.js`）。实测把正文里多出的一行 `---` 删掉，`punctuation_fixed: true`，字数从 2071 回到 2068，`status` 由 `blocked` 变回 `ready`。
   - **不带 `--fix-punctuation` 的 `chapter check` 也会写盘**：章节超长且 quality pass 时，往 `{书}/.story/work/第{NNN}章/over_length_baseline.json` 记原稿指纹（`storyctl.py:262-273`、`:296-309`）。**这是最容易被忽略的副作用**——纯「看一眼」的检查会新建 `.story/work/`。
   - `chapter commit` / `chapter accept-current-length` 原子写 `追踪/_tracking-state.json` 与全部派生视图，成功后删掉该章 `.story/work/第{NNN}章`（`.story`、`.story/work` 空则一并 rmdir）。
4. **`chapter commit` 不幂等**：同一份事务 JSON 重跑必然失败，`error_code: CHECK_FAILED`，`message: tracking state changed since this transaction was prepared`，exit 2。要重跑先重新 `tracking_commit.py draft`。append 事务对已提交章会报 `append chapter must be 23, got 22`。
5. **`normalize-punctuation.js` 默认（不带 `--check`）原地改写文件**，这是三个 JS 检测器里**唯一会写文件**的；`--check` 才是只读。改写**幂等**：同一文件第二次跑输出 `Done. Changed files: 0`。三个检测器都是「只报告不改写」。
6. **`check-ai-patterns.js` / `check-degeneration.js` 的退出码三档语义一致**：0 = 无 finding（或 `--fail-on` 未触发），1 = 有 finding 且达到 `--fail-on` 门槛（默认 `all`），2 = 工具故障（文件读不到、未知参数、无文件、finding 类型没登记 review 类）。`--check` 对两者都是「接受但不改变行为」的对称参数。
7. **stdout 形态**：纯文本模式下两个检测器都是 `<路径>:<行>:<列>: [severity] <type>: <message> (<excerpt>)`；`--json` 给 `{"findings":[{file,line,column,type,severity,message,excerpt,review}]}`（`check-ai-patterns.js` 多一个 `review`）。`normalize-punctuation.js` 没有 `--json`，纯文本 `<路径>:<行>:<列>: <type>: <message>`；写入模式则是 `<file>: normalized (N issues)` + `Done. Changed files: N`。
8. **`wordcount_core.py` 是纯库，没有 CLI、没有 `__main__`、没有 argparse**（实测 `python wordcount_core.py --help` 无输出、exit 0）。它由 `storyctl.py:28` 和 `tracking_commit.py:28-30` 用 `importlib` 按同目录文件加载，`storyctl.py` 再把它的公开名逐个注入自己的模块全局（`storyctl.py:29-31`）。
9. **字数口径 `visible_chars_v1`**：先归一化换行、去 BOM、去「可识别的 YAML frontmatter」、去开头空行、去首个 ATX 标题行，然后数**不在空白码点集里的字符**。空白集含半角空格、`\t`、U+3000 全角空格等（`wordcount_core.py:18-24`）。实测：`#未加空格` 不算标题（`#` 后必须跟空白）、4 空格缩进的 `#` 行也不算标题、「`---`+`---` 中没有键值行」不被当 frontmatter。
10. **`wordcount` 组把 `--chapter` 当字符串透传**（`"chapter":"21"`），而 `chapter` 组用 `--chapter type=int`，所以 `chapter check` 结果里 `length.chapter` 是整数 `21`。合同上的类型不一致，写调用方时要注意。
11. **三个检测器都读「书内白名单」`.deslop-whitelist`**：文件在 `正文/` 下时取父目录的父目录，否则取文件所在目录（`style-whitelist.js:7-19`）。实测白名单里的 `……` 让同一正文从「1 finding / exit 1」变成「0 finding / exit 0」。
12. **Python 探测规矩有守卫、有规范片段、没有共享函数**：规矩写在 `AGENTS.md:16`，CI 守卫是 `scripts/check-python-invocation.sh`（`cross-platform.yml:121`），规范片段是 shell 一行 `for PYBIN in python3 python py; do "$PYBIN" -c "" 2>/dev/null && break; done`，可直接复用的实现有 3 份（Codex hook 的 `.sh`/`.cmd`、`scripts/static-check.sh`）。

## 契约表

### `skills\story-long-write\scripts\storyctl.py`

统一：`python skills\story-long-write\scripts\storyctl.py <组> <子命令> [flags]`；stdout 恒为**一行 UTF-8 字节** JSON（`ensure_ascii=False`，直接写 `sys.stdout.buffer`，见 `storyctl.py:62-68`），末尾换行；**不读 stdin**。

| 子命令 | 参数 | 输入 | 输出（schema） | 退出码 | 依赖 | 破坏性 |
| --- | --- | --- | --- | --- | --- | --- |
| `wordcount measure` | `--file`(必) `--chapter` `--case-id` | 正文文件 | `story-wordcount-measurement/v1`{actual,status} | 0；文件读不到 2 | 无（纯 Python） | 否（只读） |
| `wordcount check` | `--file`(必) `--target`(必) `--chapter` `--case-id` `[--min-chars --max-chars]` | 正文文件 | `story-wordcount-result/v1`{target,internal_band,user_band,status∈internal_pass\|borderline\|under\|over} | 0；invalid 2 | 无 | 否（只读） |
| `wordcount checkpoint` | `--file`(必) `--chapter` `--case-id` `[--target]` `[--project]` `[--min-chars --max-chars]` | 正文文件；`--project` 时另读 `大纲/细纲_第N章.md` | `story-wordcount-checkpoint/v1`{user_band,remaining_user_range} | 0；缺 target 且缺 project 2 | 无 | 否（只读） |
| `chapter check` | `--project`(必) `--chapter`(必) `[--min-chars --max-chars]` `[--fix-punctuation]` | `大纲/细纲_第N章.md` + `正文/第N章*.md` + `追踪/_tracking-state.json` | `story-chapter-check/v1`{status,length,quality,compression,state_revision,tracking_committed,next_chapter_started,available_actions}；带 `--fix-punctuation` 时多 `punctuation_fixed` | 0/1/3（见速览 2）；参数错/文件缺 2 | **node≥18** + 同目录 4 个 JS 检测器；`tracking_commit.py` | **是**：`--fix-punctuation` 改正文；超长时写 `.story/work/第{NNN}章/over_length_baseline.json` |
| `chapter commit` | `--project`(必) `--chapter`(必) `--input`(必) `[--min-chars --max-chars]` | 上一行 + 逐章事务 JSON | 同上 check 结果 + `wordcount` 记录 + `mode` + `work_dir_removed` | 0；`TOOL_UNAVAILABLE` 3；其余错误 2 | 同上 + 事务文件 | **是**：写 tracking state 与派生视图，删本章工作目录 |
| `chapter accept-current-length` | 同 `commit` + `--force` | 同上 | 同上 | 同上 | 同上 | **是**（同上） |

命令树与参数定义原文：`storyctl.py:429-460`；退出码表原文：`:236-237`。

补充实测：

- `python storyctl.py`（无参数）→ `{"schema":"story-wordcount-result/v1",...,"invalid_reason":"INVALID_ARGUMENT"}`，exit 2（被 `main` 拦成 JSON，而不是 argparse 直接打 usage 文本）。
- `chapter check --chapter 21`（缺 `--project`）→ `{"schema":"story-chapter-error/v1","status":"error","error_code":"INVALID_ARGUMENT","message":"the following arguments are required: --project"}`，exit 2。
- `chapter check --project <p> --chapter 99`（无该章细纲）→ `error_code: CHECK_FAILED`，`message: chapter 99 must have exactly one outline file`，exit 2。
- **cwd 无关**：同一 `--project` 从仓库根和从 `C:\` 跑，输出逐字相同（实测两次）。
- **stderr 会有告警**：提交时 `tracking_commit.py` 往 stderr 打 `WARNING: chapter delta is 2946 bytes; target is <= 1536`（`tracking_commit.py:1216`）。stdout 仍是干净 JSON。
- 缺 node 时：`status: tool_unavailable`，`quality.tool_errors[0].type = TOOL_UNAVAILABLE`，exit 3；`chapter commit` 同环境退化为 `error_code: TOOL_UNAVAILABLE`，exit 3（实测把 PATH 收成 `C:\Python314;C:\Windows\System32` 复现）。
- 超长时 `chapter check` 返回 `compression.mode = single_pass_remove_only` 与 `remove_to_internal_band`/`remove_to_user_band` 两个删除区间，并落 `over_length_baseline.json`（内容 `{"body_sha256": "...", "actual": 2068}`）。

### `skills\story-deslop\scripts\check-ai-patterns.js`

| 子命令/参数 | 输入 | 输出形态 | 退出码 | 依赖 | 破坏性 |
| --- | --- | --- | --- | --- | --- |
| `[--check] [--json] [--fail-on=blocking\|all] <file...>`（`--check` 是接受但无行为的对称参数，`:336-337`） | 一个到多个正文文件；读同书 `.deslop-whitelist` | 文本 `<file>:<line>:<col>: [severity] <type>: <message> (<excerpt>)`；`--json` 时 `{"findings":[{file,line,column,type,severity,message,excerpt,review}]}` | 0 = 无 finding；1 = 有 finding 且达到 `--fail-on`（默认 `all`）；2 = 读文件失败 / 未知参数 / 无文件 / finding 类型缺 review 类 | Node 内置 `fs`/`path` + 同目录 `style-whitelist.js`；node ≥ 18（文档口径） | **否**（`fs` 只出现 `readFileSync`，`:368`） |
| `--list-review-classes` | 无 | JSON 分类表，22 类 → `mechanical`/`semantic`（源码 `:303-326`） | 0 | 同上 | 否 |
| `-h` / `--help` | 无 | USAGE 全文（`:8-44`） | 0 | 同上 | 否 |

- `severity`：`blocking` 只给确定性句式（`not-is-comparison` / `em-dash` / `voice-contrast` / `negation-parade` / `reverse-not-is` / `trailer-ending` / `trailer-summary`），其余为 `advisory`（USAGE `:36-37`）。`review` 由 `REVIEW_CLASSES` 决定，blocking 一律 `mechanical`。
- 实测（`demo\去AI味对照\改前.md`）：`--check --fail-on=blocking` 输出 8 行、exit **1**；`--fail-on=all` 输出同样 8 行、exit 1；`--check --fail-on=blocking demo\去AI味对照\改后.md` **无输出、exit 0**。与 `demo\去AI味对照\README.md:22`、`:37` 记的「8 处命中（7 blocking / 1 advisory），exit 1」「零命中，exit 0」逐字吻合。
- 实测（demo 第021章正文）：`--check --fail-on=blocking` 与 `--fail-on=all` 都 exit 0，`--json` 输出 `{"findings": []}`（缩进版）。
- 实跑 `chapter check` 时它被这样调用：`node <script> --check --json --fail-on=blocking <body>`（`storyctl.py:175-178`），所以 `storyctl` **依赖 `--json` 形态**：`findings` 不是数组就按 `TOOL_ERROR` 处理（`storyctl.py:112-121`、`:180-183`）。

### `skills\story-deslop\scripts\check-degeneration.js`

| 子命令/参数 | 输入 | 输出形态 | 退出码 | 依赖 | 破坏性 |
| --- | --- | --- | --- | --- | --- |
| `[--check] [--json] [--fail-on=blocking\|all] <file...>`（`--check` 无行为，`:68-69`） | 正文文件 | 文本 `<file>:<line>:<col>: [severity] <type>: <message> (<excerpt>)`；`--json` 同 `{"findings":[…]}`，**无** `review` 字段 | 0 / 1 / 2，语义与上一节完全相同 | Node 内置 `fs`/`path`（**不读** `.deslop-whitelist`） | **否** |
| `-h` / `--help` | 无 | USAGE（`:7-22`） | 0 | 同上 | 否 |

- USAGE 自述是 report-only：`Report-only. The script never rewrites`（`:19-22`）。
- 四类信号与 severity：复读/截断/占位拒绝语/tier1 纯工程词 = `blocking`，tier2 章节词与「引号内的 tier1」= `advisory`（`:59-62`、`:310-319`、`:320-329`）。
- 实跑构造样例（`%TEMP%\oh-story-research\degenerate.md`：同一长句连写 3 遍 + `细纲` + `我无法继续写下去了。` + 结尾无标点）→ 6 条 blocking，exit 1：`:3:1 verbatim-repeat`（长句复读）、`:4:1`/`:5:1 verbatim-repeat`（逐行复读）、`:6:5 meta-leak`（细纲）、`:7:1 placeholder-leak`（拒绝语）、`:8:5 truncated`。
- `--fail-on=blocking` 与默认 `all` 在这里都给 exit 1（因为 6 条全是 blocking）。
- 实跑 `demo\去AI味对照\改前.md` 与 demo 第021章正文 → 均无输出、exit 0。

### `skills\story-deslop\scripts\normalize-punctuation.js`

| 子命令/参数 | 输入 | 输出形态 | 退出码 | 依赖 | 破坏性 |
| --- | --- | --- | --- | --- | --- |
| `--check <file...>` | 正文文件 | 文本 `<file>:<line>:<col>: <type>: <message>` | 0 = 无 finding；1 = 有 finding；2 = 文件读不到 / 参数错 / 无文件 | Node 内置 `fs`/`path` + `style-whitelist.js` | **否**（只读模式） |
| `<file...>`（**不带 `--check`**） | 同上 | `<file>: normalized (N issues)`（有改动才打）+ `Done. Changed files: N` | 0；2 = 读不到 / 参数错 | 同上 | **是：原地 `fs.writeFileSync` 覆盖原文件**（`:79-83`） |
| `--quote-mode keep\|ascii\|yan` | 默认 `keep`；`ascii` 把 `「」『』` 与全角双引号全转半角 `"`，`yan` 把半角/全角双引号转 `「」` | 与上面两种模式组合 | 同对应模式；非法值 → 2 + USAGE 到 stderr | 同上 | 写入模式下才算破坏性 |

- 发现的 `type` 有：`ellipsis`、`em-dash`、`double-hyphen`、`markdown-divider`、`quote-style`、`html-comment-unclosed`（`:126-131`、`:157-162`、`:278-283`、`:401`、`:408`）。
- **原地改写实测**：把 `demo\去AI味对照\改前.md` 复制到临时目录后跑 `node normalize-punctuation.js <tmp>\改前.md`：
  - run 1 → `…: normalized (1 issue)` + `Done. Changed files: 1`，exit 0，文件 SHA256 由 `1B23…26BF` 变 `97AE…7082`；
  - run 2 → `Done. Changed files: 0`，exit 0，SHA256 不变（**幂等**）；
  - run 3 `--check` → 无输出、exit 0。
  - 改写内容：`什么叫做命运的安排——不是巧合` → `什么叫做命运的安排，不是巧合`。
  - 仓库内原文件 SHA256 前后一致（未被动过）。
- `--quote-mode` 实测（临时文件内容 = `他喊了一句「走」，然后说<U+201C>好<U+201D>。`）：`ascii` → `他喊了一句"走"，然后说"好"。`（4 issues）；`yan` → `他喊了一句「走」，然后说「好」。`（2 issues）。`--quote-mode bogus` → stderr `Invalid --quote-mode: bogus` + USAGE，exit 2。
- 白名单实测：同一条含 `……` 的正文，放在没有 `.deslop-whitelist` 的 `bookA\正文\x.md` → `:1:6: ellipsis: 替换为「，」。`，exit 1；放在有 `.deslop-whitelist`（内容 `……`）的 `bookB\正文\x.md` → 无输出，exit 0。
- 行尾策略：逐行记住原始 `\r\n` / `\n`，不做全文件行尾翻转（`:200-222`）。

### `skills\story-long-write\scripts\wordcount_core.py`

| 项 | 契约 |
| --- | --- |
| 调用方式 | **只能被 import，不能当 CLI 用**：无 `if __name__ == "__main__"`、无 argparse、无 `sys.argv`（全文件搜索无命中）；`python wordcount_core.py --help` 与 `python wordcount_core.py` 均**无输出、exit 0** |
| 加载方 | `storyctl.py:18-31`（`importlib` 按同目录文件名加载，再把非下划线名字注入自身全局）；`tracking_commit.py:28-30`（`_WORDCOUNT_CORE_PATH = Path(__file__).with_name("wordcount_core.py")`） |
| 口径名 | `METRIC = "visible_chars_v1"`（`:15`） |
| 计入 | 归一化换行后的**所有非空白字符**：汉字、字母、数字、标点、全角标点都算 1 |
| 不计入 | 空白集 `_WHITE_SPACE_CODEPOINTS`：`0x09-0x0D`、`0x20`、`0x85`、`0xA0`、`0x1680`、`0x2000-0x200A`、`0x2028`、`0x2029`、`0x202F`、`0x205F`、`0x3000`（`:18-24`） |
| 预处理 | 去 BOM → 去「可识别 frontmatter」（首行必须是 `---`，后 200 行内找到 `---`/`...` 收尾，且中间至少一行像 `key:`，`:109-116`）→ 去开头空行 → 去首个 ATX 标题行（`^[ \t]{0,3}#{1,6}[ \t]+\S`，`:27`、`:126-130`） |
| 计数函数 | `count_visible_chars()`（`:133-134`）；`measure_wordcount()` / `evaluate_wordcount()` / `checkpoint_wordcount()` 是三种输出包装 |
| 判定带 | 默认 internal = ±12%（`(t*88+99)//100` … `t*112//100`），user = ±15%（`(t*85+99)//100` … `t*115//100`）；给了作者区间则**内部带=用户带=作者区间**，`band_source: "author"`（`:160-169`、`:226`） |
| 状态词 | `internal_pass` / `borderline` / `under` / `over`；`actual == 0` → `invalid`+`EMPTY_BODY`（`:213-220`） |

口径实测（构造文件，命令统一 `python storyctl.py wordcount measure --file <f>`）：

| 输入 | actual | 说明 |
| --- | --- | --- |
| `---\ntitle: 1234567890\n---\n# 1111111111\n正文\n` | 2 | frontmatter 与 ATX 标题都不计 |
| `---\ntitle: 1234567890\n---\n正文\n` | 2 | 只有 frontmatter |
| `# 1111111111\n正文\n` | 2 | 只有标题 |
| `#未加空格\n正文\n` | 7 | `#` 后无空白 → 不是标题，整行计入 |
| `### 1111111111\n正文\n` | 2 | `#{1,6}` 都认 |
| `    # 1111111111\n正文\n` | 13 | 缩进 ≥4 空格 → 不是标题 |
| `---\nnotakeyline\n---\n正文\n` | 19 | 没有 `key:` 行 → 不当 frontmatter |
| `---\n---\n正文\n` | 8 | 同上 |
| `\n\n\n正文\n` | 2 | 开头空行去掉 |
| `正文甲\r\n正文乙\n` | 6 | 混合行尾，空白不计 |
| `正文甲乙丙\n　全角空格前\nEnglish word 123\n` | 24 | 半角空格与 U+3000 都不计 |

### 依赖与平台差异

| 项 | 实测/原文 |
| --- | --- |
| Node 版本要求 | 文档口径 **Node.js 18+**：`storyctl.py:124-127`（缺 node 时的 `NODE_REQUIRED` 文案：「安装 Node.js 18 或更高版本」）、`CHANGELOG.md:101`、`skills\story-setup\UPGRADING.md:33`、`skills\story-long-write\references\workflow-chapter.md:28`、`…\workflow-revision.md:44`。**仓库没有 `engines` 字段**（`package.json` 只有 `name/private/scripts/devDependencies`），4 个 JS 脚本也**没有 `process.version` 判断**；本机只在 v24.20.0 上实测，18 上是否真能跑**未验证** |
| JS 依赖 | 只用 Node 内置 `fs` / `path`（`check-ai-patterns.js:4-6`、`check-degeneration.js:4-5`、`normalize-punctuation.js:4-6`），加同目录本地模块 `style-whitelist.js`。无 npm 包、无网络 |
| Python 依赖 | **纯标准库**：`storyctl.py` = argparse/hashlib/importlib.util/json/re/shutil/subprocess/sys/pathlib/typing；`wordcount_core.py` = hashlib/re/pathlib/typing；`tracking_commit.py` = argparse/copy/importlib.util/json/os/re/stat/sys/tempfile/time/unicodedata/contextlib/pathlib/typing。三份都没有 `sys.path` 操作、没有 pip 依赖 |
| Python 版本下限 | 这三个脚本**未找到**成文的下限；代码只用 `from __future__ import annotations` + 标准库。`CHANGELOG.md:305` 的「兼容 Python 3.9」说的是 Codex/OpenCode 生成器与 adapter 检查，**不覆盖**这三个运行时脚本。本机只在 3.14.7 上实测 |
| Windows：`python3` | 落到 Microsoft Store 占位程序。本机 pwsh 实测**无输出、exit 9009**；仓库按 Git Bash 场景记的是 `exit 49`（`scripts\check-python-invocation.sh:4-5`、`CHANGELOG.md:753`） |
| Windows：控制台编码 | `storyctl.py:62-68` 明确「Windows runner 可能是 cp1252 控制台」，所以协议 JSON 直接写 `sys.stdout.buffer` 的 UTF-8 字节。实测：**JSON 输出始终干净**，但 argparse 生成的 `--help` 中文说明在重定向捕获时是乱码（如 `--min-chars` 的说明行），属于 Python 自身走控制台编码 |
| Windows：路径 | 含中文与空格的 `demo\长篇\让你管账号，你高燃混剪炸全网` 全流程可用（实测 `--project` / `--file` 都是这个路径） |
| cwd 依赖 | 五个脚本全部**不依赖 cwd**：`storyctl.py` 的脚本目录取 `Path(__file__).parent`（`:162`、`:332`），项目根由 `--project` 给；`tracking_commit.py` 同理。实测从 `C:\` 跑 `--project <绝对路径>` 与在仓库根跑结果逐字相同 |
| 跨 skill 副本 | 五个脚本各有 2-4 份字节相同的副本，由 `scripts\shared-assets.json` 登记（`prose-ai-pattern-detector` / `prose-degeneration-detector` / `prose-punctuation-normalizer` / `story-wordcount-core`）并受 `scripts\check-shared-files.sh` 守卫。实测 SHA256：`check-ai-patterns.js`/`check-degeneration.js`/`normalize-punctuation.js`/`style-whitelist.js` 各 4 份，**distinct=1** |
| `wordcount_core.py` 副本 | `story-import`、`story-review` 各一份（`shared-assets.json` 的 `story-wordcount-core`）。注意：**只有 `story-long-write` 带 `storyctl.py`**（`tracking_commit.py:1020-1021`） |

### 实跑回放（原样命令 + 原样输出）

统一前置：`Set-Location 'D:\DS\插件\oh-story-claudecode'`；破坏性实验都在 `%TEMP%\oh-story-research\proj*` 副本里做。

```
$ python skills\story-long-write\scripts\storyctl.py chapter check --project C:\...\Temp\oh-story-research\proj --chapter 21
{"schema":"story-chapter-check/v1","status":"ready","chapter":21,"length":{"schema":"story-wordcount-result/v1","metric":"visible_chars_v1","chapter":21,"case_id":null,"target":2300,"actual":2068,"internal_band":{"min":2024,"max":2576,"status":"pass"},"user_band":{"min":1955,"max":2645,"status":"pass"},"signed_error_pct":-0.10086956521739131,"absolute_error_pct":0.10086956521739131,"band_source":"default","status":"internal_pass","invalid_reason":null},"quality":{"status":"pass","blocking_findings":[],"advisories":[],"semantic_advisories":0,"tool_errors":[]},"compression":null,"state_revision":1,"tracking_committed":true,"next_chapter_started":false,"available_actions":["commit"]}
exit=0
```

```
$ python skills\story-long-write\scripts\storyctl.py chapter commit --project <proj> --chapter 21 --input <proj>\.story\work\第021章\tracking.json
{"schema":"story-chapter-check/v1","status":"ready",...,"available_actions":["commit"],"wordcount":{"metric":"visible_chars_v1","target":2300,"actual":2068,"status":"internal_pass","resolution":"within_user_band","body_sha256":"e2df30bc8cc39f545454ab8cf2a73871a8b05ce427069c979649fabf1c3af68b"},"mode":"revision","work_dir_removed":".story/work/第021章"}
exit=0        # stderr: WARNING: chapter delta is 2946 bytes; target is <= 1536
$ python ... chapter commit --project <proj> --chapter 21 --input <同一份文件>
{"schema":"story-chapter-error/v1","status":"error","error_code":"CHECK_FAILED","message":"tracking state changed since this transaction was prepared"}
exit=2
```

```
$ python ... storyctl.py chapter check --project <proj> --chapter 21 --min-chars 500 --max-chars 1000
... "length":{...,"band_source":"author","status":"over"}, "compression":{"mode":"single_pass_remove_only","remove_to_internal_band":{"min":1068,"max":1568},"remove_to_user_band":{"min":1068,"max":1568}}, "available_actions":["compress-once","accept-current-length","revise-outline-or-target","discard"]
exit=0
$ python ... chapter accept-current-length --project <proj> --chapter 21 --min-chars 500 --max-chars 1000 --input <…>\tracking.json
{"schema":"story-chapter-error/v1","status":"error","error_code":"COMPRESSION_REQUIRED","message":"超长章节先按 compress-once 做一次净删压缩并重跑 chapter check（原稿 2068 字，压缩后要不超过 1534 字，现在 2068 字），仍超长再接受当前长度；作者明确不压缩时加 --force"}
exit=2
$ python ... chapter accept-current-length ... --force
{...,"wordcount":{...,"status":"over","resolution":"accepted_current_length",...,"author_range":{"min":500,"max":1000}},"mode":"revision","work_dir_removed":".story/work/第021章"}
exit=0
```

```
$ python ... storyctl.py chapter check --project <proj2> --chapter 21        # 正文尾部手工加了一行 ---
{...,"status":"blocked",...,"quality":{"status":"fail","blocking_findings":[{"type":"PUNCTUATION_NOT_NORMALIZED","message":"C:\\...\\proj2\\正文\\第021章_离别怎么会开花.md:95:1: markdown-divider: 正文中不要使用 markdown 分隔线；建议移除该行。"}],...}}
exit=1
$ python ... storyctl.py chapter check --project <proj2> --chapter 21 --fix-punctuation
status: ready / punctuation_fixed: True / quality: pass / actual: 2068
$ node skills\story-deslop\scripts\normalize-punctuation.js --check <proj2>\正文\第021章_离别怎么会开花.md
exit=0                       # 那行 --- 已被删掉
```

```
$ PATH 收成 C:\Python314;C:\Windows\System32 后：
$ python ... storyctl.py chapter check --project <proj> --chapter 21
{...,"status":"tool_unavailable","quality":{"status":"unavailable",...,"tool_errors":[{"type":"TOOL_UNAVAILABLE","tool":"node","message":"质量检查（AI 句式、退化、标点、细纲照搬）要用 Node.js 运行，本机找不到 node。安装 Node.js 18 或更高版本并确认 `node --version` 可用后重跑本命令；装好之前本章不能提交。"}]},"available_actions":[]}
exit=3
$ python ... storyctl.py chapter commit --project <proj> --chapter 21 --input <任意路径>
{"schema":"story-chapter-error/v1","status":"error","error_code":"TOOL_UNAVAILABLE","message":"…本机找不到 node…"}
exit=3
```

```
$ node skills\story-deslop\scripts\check-ai-patterns.js --check --fail-on=blocking demo\去AI味对照\改前.md
demo\去AI味对照\改前.md:3:1: [advisory] cliche-density-tic: 套词密度过高：高危 AI 套词 8 处（24.9/千字）；… (仿佛 一丝 深吸一口气 缓缓 微微)
demo\去AI味对照\改前.md:7:20: [blocking] em-dash: 破折号按功能改写：… (么叫做命运的安排——不是巧合，而是一)
demo\去AI味对照\改前.md:7:22: [blocking] not-is-comparison: 高频 AI 对比句式；… (不是巧合，而是一种冥冥之中的注定)
demo\去AI味对照\改前.md:11:1: [blocking] negation-parade: 否定排比：… (没有犹豫，没有生涩，)
demo\去AI味对照\改前.md:19:3: [blocking] voice-contrast: 音量反差腔：… (声音不大，却)
demo\去AI味对照\改前.md:21:2: [blocking] not-is-comparison: … (不是一次简单的弹奏，而是一场蓄谋已久的惊艳亮相)
demo\去AI味对照\改前.md:23:6: [blocking] trailer-ending: … (才刚刚开始)
demo\去AI味对照\改前.md:25:1: [blocking] trailer-ending: … (没人知道)
exit=1
```

```
$ node skills\story-deslop\scripts\check-degeneration.js --check <tmp>\degenerate.md
…\degenerate.md:3:1: [blocking] verbatim-repeat: 长句复读（同句出现 3 次）：疑似模型打转，重写、保留一处。 (他知道现在不是犹豫的时候，因为时间已经不允许他再犹豫了)
…\degenerate.md:4:1: [blocking] verbatim-repeat: 逐行复读（紧邻整行重复）：疑似模型打转，重写本段、删掉重复。 (…)
…\degenerate.md:5:1: [blocking] verbatim-repeat: 逐行复读（紧邻整行重复）：… (…)
…\degenerate.md:6:5: [blocking] meta-leak: 工程词泄漏：「细纲」是写作流水线术语，正文里不该出现；改成角色/场景内表达。 (江晨翻开细纲看了本章的条目。)
…\degenerate.md:7:1: [blocking] placeholder-leak: 元信息泄漏（生成拒绝语）：正文混入元信息/拒绝语/占位符，重写本段干净落地。 (我无法继续写下去了。)
…\degenerate.md:8:5: [blocking] truncated: 疑似截断：正文末尾未以句末/收尾标点结束，可能被模型中途切断；补完结尾或重写收尾。 (他还没说完)
exit=1
```

```
$ node skills\story-deslop\scripts\normalize-punctuation.js <tmp>\改前.md
<tmp>\改前.md: normalized (1 issue)
Done. Changed files: 1
exit=0
$ node skills\story-deslop\scripts\normalize-punctuation.js <tmp>\改前.md
Done. Changed files: 0
exit=0
```

```
$ python skills\story-long-write\scripts\storyctl.py wordcount measure --file <tmp>\a-frontmatter-heading.md --case-id a-frontmatter-heading
{"schema":"story-wordcount-measurement/v1","metric":"visible_chars_v1","chapter":null,"case_id":"a-frontmatter-heading","actual":2,"status":"measured","invalid_reason":null}
$ python ... wordcount checkpoint --file <demo 第021章> --project <demo 书> --chapter 21
{"schema":"story-wordcount-checkpoint/v1","metric":"visible_chars_v1","chapter":"21","case_id":null,"target":2300,"actual":2068,"user_band":{"min":1955,"max":2645},"band_source":"default","remaining_user_range":{"min":0,"max":577}}
```

## 调用点原文

各 SKILL.md / references 里怎么调这些脚本，逐条照抄（行号是当前仓库状态）。

### `story-deslop/SKILL.md`

- **Phase 1 确定性句式预检（文件模式）**（`:120-124`）：

  > **确定性句式预检（文件模式）**：当输入是本地正文文件路径时，「AI味扫描」必须先运行本 skill 自带脚本，只报告不修改：
  > ```bash
  > node scripts/check-ai-patterns.js --check --fail-on=blocking <正文文件...>
  > ```

- **Phase 4 确定性收尾（文件模式）**（`:180-186`）——三条命令的顺序本身是契约（先句式复扫、再机械标点）：

  > 当输入是正文文件路径，且「逐项清除」已落盘修改后，**先**做句式/段落复扫，**再**做机械标点兜底（破折号要按功能改写，故先于机械替换报出）：
  > ```bash
  > node scripts/check-ai-patterns.js --check --fail-on=blocking <正文文件...>
  > node scripts/check-degeneration.js --check <正文文件...>
  > node scripts/normalize-punctuation.js <正文文件...>
  > ```

- 作用边界（`:188-193`）：`check-ai-patterns.js` 只报告不改写、blocking 优先改正文并复扫、advisory 先通读；`check-degeneration.js` 的 blocking 是退化信号，「去AI味改不掉，应回去重新生成那一段再 deslop」；`normalize-punctuation.js` 是「机械兜底」，默认不改引号风格，`--quote-mode ascii|yan` 只在用户或项目明确要求时加（`:193`）。
- 脚本清单表（`:251-253`）把三者分别标为「文件模式落盘后做确定性标点收尾」「文件模式『AI味扫描』预检与『确定性收尾』复扫（只看引号外叙述），只报告不改写」「文件模式『确定性收尾』复扫，只报告不改写」。

### `story-long-write/references/workflow-chapter.md`

- 步骤 8（`:27-28`）：

  > 运行 `{PYTHON} {skill 根}/scripts/storyctl.py chapter check --project {项目根} --chapter {N} --fix-punctuation`：一次整理标点并跑 AI 句式、`check-degeneration.js` 退化、细纲照搬与字数检测（去味管线：检测器 → 选 Gate → 一次定点改写 → 复扫）；文件改动后重跑，不再分别调各检测脚本。
  > 按返回的 `status` 走：`ready` → 完成步骤 9-12 再提交。`blocked` / `invalid`（退出码 1）→ 就地修净再重跑。`needs_decision`（字数出带）→ 看 `available_actions`：欠字不补不重试，按字数问法请作者选；超字把删除区间随 `compress-once` 交 narrative-writer 一次净删、零新语义，复检仍带外也请作者选。`tool_unavailable`（退出码 3，见 `quality.tool_errors`）→ 不能提交、无绕过，用停下问法告诉作者要装 Node.js 18+ 才能做写后检查。退出码 2（`status: error`）按 `error_code` 修命令。

- 步骤 12（`:32`）——`draft` → `commit` / `accept-current-length` 的完整闭环，含「作者接受当前长度把 `commit` 换成 `accept-current-length`」与「报错按提示改完重跑同一命令」。
- 步骤 6（`:23`）——`storyctl.py wordcount checkpoint --file {前组} --project {项目根} --chapter {N}`，后组按 `remaining_user_range` 收。

### `story-long-write/references/tracking-transaction.md`

「运行工具」一节（`:18-26`）是全仓库对这三个 Python 入口最完整的一次性契约：

> 先按运行环境探测 Python 3 解释器（依次尝试 `python3`、`python`、`py -3`）。追踪事务脚本使用当前 skill 根目录；字数与章节闭环统一使用 `story-long-write` skill 根目录：
> ```text
> {PYTHON} {当前 skill 根}/scripts/tracking_commit.py init   --project {书项目根} --input {书项目根}/.story/work/init.json
> {PYTHON} {当前 skill 根}/scripts/tracking_commit.py check  --project {书项目根}
> {PYTHON} {当前 skill 根}/scripts/tracking_commit.py draft  --project {书项目根} --chapter {N}
> {PYTHON} {story-long-write skill 根}/scripts/storyctl.py chapter check   --project {书项目根} --chapter {N} [--min-chars {下限} --max-chars {上限}]
> {PYTHON} {story-long-write skill 根}/scripts/storyctl.py chapter commit  --project {书项目根} --chapter {N} --input {书项目根}/.story/work/第{NNN}章/tracking.json
> {PYTHON} {story-long-write skill 根}/scripts/storyctl.py chapter accept-current-length --project {书项目根} --chapter {N} --input {书项目根}/.story/work/第{NNN}章/tracking.json
> ```

同一节 `:33-35` 逐条钉死了本文实测到的退出码与 status（`ready` 0 / `needs_decision` 0 / `blocked` 1 / `invalid` 1 / `tool_unavailable` 3 / 参数或文件缺失 `story-chapter-error/v1` exit 2），`:38` 说明「`expected_state_revision` 再拒绝基于旧状态构造的 stale transaction」，`:40` 说明事务 JSON 的落点、成功即删、以及「append 重跑只接受内容完全相同的既有逐章记录」。

### 其他调用点（同一语义，不同 skill）

| 位置 | 原文/要点 |
| --- | --- |
| `skills\story-review\SKILL.md:157-159` | 三条 `node scripts/…` 命令与 story-deslop 同形（`normalize … --check`、`check-ai-patterns … --check --fail-on=blocking`、`check-degeneration … --check`），并在 `:161` 规定 `em-dash` 只采用 `check-ai-patterns.js` 的语义建议、与 normalize 的同一位置去重 |
| `skills\story-short-write\SKILL.md:107-108` | 收尾清单：`check-ai-patterns.js --check --fail-on=blocking 正文.md` 无 blocking；`check-degeneration.js --check 正文.md` 无 blocking |
| `skills\story-short-write\references\workflow-revision.md:7,77-78` | 依次跑 `check-ai-patterns --check --fail-on=blocking`、`check-outline-copy --outline`、`normalize-punctuation`、`check-degeneration --check`；`:78` 写明 normalize 默认 `--quote-mode keep` |
| `skills\story-long-write\references\workflow-revision.md:35,37,44,61` | 改稿流程：`wordcount measure` 记原字数 → `chapter check --fix-punctuation` → `chapter commit`；`:44` 的处置表把 `tool_unavailable`（退出码 3）写成「停下，不提交，告诉作者『要装 Node.js 18 或更新版本，才能做改后检查』」 |
| `skills\story-long-write\references\agent-calls.md:7` | 写手分组交付时「主会话只调用一次 `storyctl.py wordcount checkpoint --file {segment} --project {项目根} --chapter {N}`」 |
| `skills\story-long-write\references\reference-index.md:66` | Phase 5「AI句式脚本复扫」→ `scripts/check-ai-patterns.js` |
| `skills\story-long-write\SKILL.md:79` | 「`{PYTHON}` 依次试 `python3`、`python`、`py -3`，用第一个能跑的；`{skill 根}` 是本 skill 所在目录。」 |
| `demo\去AI味对照\README.md:19-22,37` | 复现命令 `node skills/story-deslop/scripts/check-ai-patterns.js --check --fail-on=blocking demo/去AI味对照/改前.md`；期望「8 处命中（7 blocking / 1 advisory），exit 1」与「改后.md 零命中，exit 0」——本机实测逐字复现 |
| `docs\how-to-remove-ai-flavor-from-web-fiction.md:45` | 「先跑 `node scripts/check-ai-patterns.js --check --fail-on=blocking <文件>`，只报告不修改」 |
| `skills\story-setup\references\generic\AGENTS.md.tmpl:41`、`…\openclaw\AGENTS.md.tmpl:47`、`…\reasonix\AGENTS.md.tmpl:49` | 无 hook 平台的「去AI味自锁」：每章落盘后同一轮内跑 `check-ai-patterns.js --check --fail-on=blocking` 清零；唯一豁免是标题行下的去味跳过标记（与 `storyctl.py:138` 的 `DESLOP_SKIP` 同一语法） |
| `skills\story-setup\references\templates\agents\narrative-writer.md:95`、`…\opencode\agents\narrative-writer.md:111`、`…\codex\agents\narrative-writer.toml:90` | 「确定性扫描归主会话」：长篇由主会话一次 `chapter check --fix-punctuation` 跑完，写手只在未安排时自跑两条命令 |

## python 探测规矩的原文位置

**规矩本身**

- `AGENTS.md:16`：「**skill 文档禁止裸调 `python3`**，须走 python3 → python → py 探测。」

**CI 守卫（可执行、带正则）**

- `scripts\check-python-invocation.sh`：
  - `:2-12` 注释给出原因（Windows 上 `python3` 落到 Store 占位程序、exit 49）与**规范写法**：
    ```
    for PYBIN in python3 python py; do "$PYBIN" -c "" 2>/dev/null && break; done
    "$PYBIN" -c "..."
    ```
  - `:24` 拦截模式 `PATTERN='python3([[:space:]]+[^[:space:]]|<)'`；`:26` 白名单 `ALLOW='python3 python py'`；`:32` 只扫 `$REPO_ROOT/skills`（CI scripts 自身不扫）。
- 接入点：`.github/workflows/cross-platform.yml:121` → `run: bash scripts/check-python-invocation.sh`。
- 索引：`scripts\README.md:30`「技能文档禁止裸调 `python3`（须 python3→python→py 探测） | CI」。

**文档侧原文（`{PYTHON}` 占位符的定义与使用）**

- `skills\story-long-write\SKILL.md:79`：`{PYTHON}` 依次试 `python3`、`python`、`py -3`。
- `skills\story-long-write\references\tracking-transaction.md:18`（同一句在 `story-review`、`story-import` 的同名文件 `:18` 也有一份）：「先按运行环境探测 Python 3 解释器（依次尝试 `python3`、`python`、`py -3`）」。
- `skills\story-setup\references\diagnostics.md:22`：「实际执行 `node --version`；Python 按跨平台约定依次探测 `python3`、`python`、`py`，运行版本检查，确认是 Python 3 后使用该解释器。命令存在但不能执行不算通过。」`:29` 给出用探测结果调用 `tracking_commit.py check` 的写法，`:32` 定义 `PYBIN`。
- `skills\story-short-write\references\short-format.md:110-111` 给**可复制片段**；`:136` 写原因：「Windows 上它会落到 Microsoft Store 占位程序并以 exit 49 静默失败，上面的探测按 `python3→python→py` 选出真正可用的解释器。」
- `skills\story-setup\references\deploy-codex.md:30`、`…\deploy-claude-code.md:68`：同一行探测片段 +「无可用解释器时停止，不手写或简化」。

**现有可复用实现（照抄即可，无需新写）**

| 实现 | 位置 | 形态 |
| --- | --- | --- |
| POSIX launcher | `skills\story-setup\references\codex\hooks\run-story-hook.sh:17-24` | `PYBIN=` + `for candidate in python3 python py; do if "$candidate" -c "" >/dev/null 2>&1; then PYBIN=$candidate; break; fi; done`，空则 `exit 0` |
| Windows launcher | `skills\story-setup\references\codex\hooks\run-story-hook.cmd:18-25` | `for %%P in (python3 python py) do ( %%P -c "" >nul 2>&1 / if not errorlevel 1 set "PYBIN=%%P" )`，空则 `exit /b 0` |
| 仓库自己的守卫 runner | `scripts\static-check.sh:14-27` | 同一探测后 `exec "$PYBIN" "$REPO_ROOT/scripts/static-check.py"` |
| 回归测试 | `scripts\test-charcount-portable.sh` | 从文档**抽取**命令执行、注入 exit-49 假 `python3` 断言回退（见该文件 `:23`、`:68-80`）；`scripts\test-shared-assets.py:283-285` 也造 `python3` stub |
| 历史 | `CHANGELOG.md:753`（#121 修复）、`:758`（新增守卫与回归） | 解释「真因是 Store App Execution Alias 占位程序，非交互子进程里静默 exit 49」 |

**结论**：规矩有守卫、有规范片段、有三份可直接复制的实现；**没有**「共享函数 / 公共脚本」这一层，每个消费方各写一遍探测（`check-python-invocation.sh:32` 只扫 `skills/`，所以 skill 文档里任何新写的 Python 调用都必须自带探测片段，否则 CI 红）。

## 不确定项

1. **Node 18 是否真能跑**：仓库只在文档里写「Node.js 18+」（`storyctl.py:126` 等），没有 `engines`、没有 `process.version` 守卫；本机只有 v24.20.0。三个检测器用到 lookbehind（`check-degeneration.js:52-54`、`check-ai-patterns.js` 同类写法），理论下限远低于 18，但「18 上行为一致」未实测。
2. **Python 最低版本**：三个运行时脚本**未找到**成文下限，也未在低版本解释器上实测；本机 3.14.7。`CHANGELOG.md:305` 的 3.9 只覆盖生成器与 adapter 检查。
3. **`python3` 的失败退出码因宿主而异**：本机 pwsh 是 **9009**（无输出），仓库按 Git Bash 记的是 **49**。两者都是「命令存在但不能执行」，探测片段用 `-c ""` 实跑判定的做法因此必要——但本机没复现 49。
4. **`BELOW_ACCEPT_FLOOR` 分支未复现**：它要求 `actual < 细纲字数目标 × 0.5`（`storyctl.py:341-354`）。demo 第021章 `actual=2068`、目标 2300，阈值 1150，构造不出来；该分支只有源码与 `tracking-transaction.md:35` 的文字证据。
5. **检测器崩溃/坏 JSON 的降级路径**未手工复现：`storyctl.py:112-121`、`:180-183` 把「非 JSON 输出」或「退出码不在 {0,1}」判为 `TOOL_ERROR` → 整章 `tool_unavailable`（exit 3）；`scripts\test-storyctl.py:482-508` 有单元回归（含 `(1, "Segmentation fault")`、`(0, "")`、`(1, '{"findings": "x"}')` 三个用例），本次没造真实崩溃脚本验证。
6. **事务 JSON 里带 `wordcount`** 会被拒（`storyctl.py:410`「tracking transaction must not provide wordcount」），未实跑该分支。
7. **`--fix-punctuation` 与 `--min-chars/--max-chars` 同给时的顺序**：源码是「先 fix 再 check」（`:540-543`），但没找到文档写明这一点；未单独实测该组合下 `length.actual` 是 fix 前还是 fix 后的值（单独测 `--fix-punctuation` 时它报的是 fix 后的 2068）。
8. **append 事务「重跑只接受内容完全相同」**（`tracking-transaction.md:40`）只对应「state 写入失败、修订号未推进」的场景。实测已提交后再跑同内容 append 会被 `append chapter must be 23, got 22` 拒绝；「写入失败后重跑被接受」这一支未复现（需要人为让原子写失败）。
9. **`.deslop-whitelist` 的解析细节**：只按行 trim、忽略 `#` 开头行、按长度降序（`style-whitelist.js:11-14`）；不做正则、不做祖先继承。其**文件格式**没有单独的 schema 文档，未找到对「同一文件里重复条目」等边界的说明。
10. **`check-ai-patterns.js` 22 类规则的具体判定阈值**没逐条实测（本次只验证了退出码/输出形态/JSON schema，以及 demo 里 8 条已知命中的逐字复现）。
11. **`chapter commit` 会顺手删掉 `.story/work/第{NNN}章`**，连带把空的 `.story` 也 rmdir（实测提交后 `Test-Path <proj>\.story` 为 false）。作者记忆若放在 `.story/` 下不受影响（`storyctl.py:85-103` 注释如此声明），但本次没有实际放一份作者记忆去验证。

## 证据索引

**被测脚本（源码行号）**

| 文件 | 关键行 |
| --- | --- |
| `skills\story-long-write\scripts\storyctl.py` | `:18-31` 加载 wordcount_core；`:37` `WORK_ROOT`；`:62-68` 写 UTF-8 字节 JSON；`:80-103` 章工作目录与清理；`:112-121` findings 解析；`:124-127` `NODE_REQUIRED`；`:138` `DESLOP_SKIP`；`:141-144` 去味豁免窗口（首 6 行）；`:147-232` `check_blocking_quality`（`:175-178` 调两个检测器、`:200-203` 调标点、`:217-220` 调细纲照搬）；`:236-237` 退出码表；`:262-273` 超长基线写入；`:276-321` `chapter_check`；`:324-338` `fix_punctuation`（原地改）；`:341-380` 接受长度两道底线；`:383-426` `chapter_commit`；`:429-460` 命令树；`:480-521` wordcount 分发；`:524-557` `main` |
| `skills\story-long-write\scripts\wordcount_core.py` | `:15` `METRIC`；`:18-24` 空白码点集；`:25-39` 细纲字段正则；`:109-116` frontmatter 剥离；`:119-130` `visible_body`；`:133-134` `count_visible_chars`；`:160-169` 判定带；`:213-220` 状态词；`:286-295` 章节文件定位；`:320-349` 字数记录 |
| `skills\story-deslop\scripts\check-ai-patterns.js` | `:4-6` 依赖；`:8-44` USAGE（`:36-39` severity/review/fail-on 语义）；`:288-302` 分类注释；`:303-326` `REVIEW_CLASSES`；`:334-355` 参数解析；`:364-388` 扫描与输出；`:390-393` 退出码；`:395-402` review 缺失即 exit 2；`:412-416` `die` |
| `skills\story-deslop\scripts\check-degeneration.js` | `:7-22` USAGE（`:19-22` report-only）；`:26-28` 复读阈值；`:32-44` 占位/拒绝语；`:46-55` 引号区间；`:59-62` 工程词 tier1/tier2；`:64-84` 参数解析；`:107-118` 输出与退出码；`:249-263` 截断判定（收尾标点集 `[。！？!?…"』」）)】]`）；`:290-333` 工程词泄漏 |
| `skills\story-deslop\scripts\normalize-punctuation.js` | `:8-15` USAGE；`:17-49` 参数解析；`:72-77` `--check` 只读输出；`:79-83` 原地写入；`:86-94` 退出码；`:96-100` `die`；`:200-222` 逐行行尾；`:245-289` 停顿标点归一化到不动点；`:265` 主正则；`:292-317` HTML 注释区间；`:340-357` 替换选择；`:389-414` 引号模式 |
| `skills\story-deslop\scripts\style-whitelist.js` | `:7-19` `loadStyleWhitelist`（`正文` 父目录规则）；`:21-29` `styleSpans`；`:31-37` `maskStyleText` |

**佐证文件**

- 共享副本登记：`scripts\shared-assets.json`（`prose-ai-pattern-detector` / `prose-degeneration-detector` / `prose-punctuation-normalizer` / `prose-style-whitelist` / `story-wordcount-core` / `story-tracking-transaction`）。
- 回归测试：`scripts\test-storyctl.py`（`:482-508` 工具故障→exit 3）、`scripts\test-normalize-punctuation.js`（只读检查、frontmatter/fence、CRLF、引号模式与幂等）、`scripts\test-ai-patterns.sh`、`scripts\test-degeneration.sh`（`:350-358` 还守卫「携带副本的 skill 必须真的调用它」）、`scripts\test-chapter-completion-lifecycle.py:320-335`、`scripts\test-style-precedence.py:36-69`。
- CI：`.github/workflows/cross-platform.yml:121`（python 探测守卫）；`CONTRIBUTING.md:99`（`test-storyctl.py`）、`:123`（`test-normalize-punctuation.js`）。
- 文档：`demo\去AI味对照\README.md`（两次真实扫描的期望输出）、`docs\how-to-remove-ai-flavor-from-web-fiction.md:45`、`skills\story-deslop\references\anti-ai-writing.md:44/277/303/327/331`、`banned-words.md:26/149`。
- 历史与本机差异：`CHANGELOG.md:101`（Node 18+）、`:305`（Python 3.9 兼容范围）、`:753`/`:758`（`python3` Store 占位程序与守卫）。
- 本机 Python 解析结果：`python` = `C:\Python314\python.exe`、`py` = `C:\WINDOWS\py.exe`、`python3` = `C:\Users\49178\AppData\Local\Microsoft\WindowsApps\python3.exe`（`Get-Command` 实测）。

**本次实跑产生的临时产物**（都在系统临时目录，仓库未落任何中间文件；跑完可删）

- `%TEMP%\oh-story-research\proj`、`proj2` —— demo 长篇小说目录的副本，用于 `chapter check` / `commit` / `accept-current-length` 与 `.story/work` 落盘实验。
- `%TEMP%\oh-story-research\bookA`、`bookB`、`normtest`、`quote-*.md`、`degenerate.md`、`a-*.md`…`j-*.md`、`count-probe*.md` —— 白名单、引号模式、退化信号、字数口径的构造样例。
- 仓库内只有本文档一个新增文件；`git status --porcelain` 在调研前后一致（当时已有的 ` M AGENTS.md` 与两个未跟踪目录不属于本次改动）。
