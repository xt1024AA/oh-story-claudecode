# Agent Note: 热路径预算守卫在 CRLF 检出下的锚点查找

Status: implemented

## Problem

`check-doc-budget.sh` 支持 `文件#小节` 形式的按节计量：只把某个小节计入该路径的预算。实测在 Windows 检出（本仓无 `.gitattributes`，`core.autocrlf=true`）下，**48 个带锚点的登记项 100% 报「小节找不到」**，守卫恒红；把同一份文本归一化成 LF 后 48 项全部解析成功。

根因在守卫内嵌的 `sectionOf()`：它按 `\n` 切行后，用 `/^(#{1,6})\s+(.*)$/` 匹配标题行。JavaScript 的 `.` 不匹配 `\r`，而 `$`（无 `m` 标志）只在串尾或末尾 `\n` 之前成立——CRLF 行的标题永远匹配失败，于是所有锚点都解析不到。`CONTRIBUTING.md` 要本地提交前跑这条守卫，Windows 上等于跑不了；CI 的 windows job 又恰好不跑它，所以这个洞在 CI 侧一直看不见。

## Decision

在 `weigh()` 读文件处统一归一化行尾：`fs.readFileSync(abs, "utf8").replace(/\r\n?/g, "\n")`。

去空白计量（`strip()` 剔 `\s`，含 `\r`）因此完全不受影响：LF 检出读数逐字不变，CRLF 检出读数与 LF 检出一致，只有按节解析从「必然失败」变成正常。回归测试在 `scripts/test-doc-budget.py` 里加了 `test_section_anchor_survives_crlf_checkout`：测试辅助 `run_checker` 新增 `write_newline` 参数，用 `newline="\r\n"` 写出真正的 CRLF 夹具（而不是依赖宿主平台的换行翻译），钉住「行尾不参与计量、锚点照常解析」。

## Alternatives considered

- **只放宽标题正则**（如 `/^(#{1,6})[ \t]+(.*?)[ \t\r]*$/`）。
  最强理由：改动面最小，只碰出问题的那一行正则，不引入任何前置步骤。
  为何不用：`sectionOf` 之外还有围栏检测（`/^\s*(```|~~~)/`，靠 `\s` 已能容忍）、`lines.slice(...).join("\n")` 的读数路径；行尾问题在「切行」这一步就存在，就地归一化一次比在每个消费者里各补一次更不容易漏，也让读到的文本与落盘格式解耦。

- **加 `.gitattributes`（`* text=auto eol=lf`）让检出恒为 LF。**
  最强理由：从源头消灭 CRLF，所有现有的行尾敏感代码一并受益，且是最正统的仓库级修法。
  为何不用：`*.sh` 若在 Windows 上被强制成 LF 仍能跑，但这一改动会一次性重写全仓工作区行尾、影响所有贡献者的 `git status` 与 diff 噪音，属于独立的仓库级决策；本票（#10 回归守卫）只该让守卫本身不再依赖宿主行尾。

- **不改守卫，改在文档里写「Windows 请用 WSL 或 `git config core.autocrlf false` 后重跑」。**
  最强理由：零代码风险，且 CI 权威（Linux）本来就不受此影响。
  为何不用：`core.autocrlf=true` 是 Windows 上的通行配置，作者机器就是；把「守卫在本平台恒红」当成使用者的环境问题，等于这条守卫对 Windows 贡献者永久失效。

## Consequences

收益：

- `check-doc-budget.sh` 首次在 CRLF 检出下给出真实读数（本机 48 个锚点全部解析成功），Windows 贡献者能按 `CONTRIBUTING.md` 本地自检。
- LF 检出的行为逐字不变，CI（Linux/macOS）零影响。
- 回归测试不依赖宿主平台：夹具用显式 `newline="\r\n"` 写出，Linux 上同样会抓到这类回归。

代价与风险：

- 守卫每次读文件多一次全串正则替换，成本可忽略（清单只有几十个文件）。
- 只修了按节计量这条链；脚本里其他行尾敏感逻辑（如 `preloads()` 解析 agent frontmatter）本就显式处理 `\r?\n`，不在本次范围内。
