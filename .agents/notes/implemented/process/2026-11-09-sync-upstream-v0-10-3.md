# Agent Note: 把仓库源头同步到上游 v0.10.3（沿用白名单做法 + 六类 Windows 平台修复）

Status: implemented

对应任务：2026-11-08/09，作者要求「仓库中的源头 oh-story-claudecode 有更新了，帮我同步到插件」。上一轮停在 0.10.0（插件 0.2.5）；本轮上游已发到 **v0.10.3**「精简重复指令与培训说教」（tag `v0.10.3` = `78011b2`，2026-11-08T09:11Z，`agents_version: 42` / `setup_skill_version: 1.3.10`），插件升到 0.2.6。

## Problem

三件事同时挡在路上：

1. **取不到上游**：`git fetch origin` 连续 5 次失败（`Failed to connect to github.com:443 after ~21s`，`Trying 20.205.243.166:443`），而同一时刻 bash 的 `curl` 访问 `api.github.com` / `raw.githubusercontent.com` 都正常。根因是 git 全局配置 `http.sslbackend=schannel`（来自随宿主解包的临时 git 目录 `winuxcmd/opt/niugit/etc/gitconfig`），不是网络断了。
2. **fork 落后**：`origin/main` 只到 **0.10.2**（`43c162b`），上游已发 0.10.3。只跟 fork 会漏掉最新一版。
3. **Windows 检出与 MSYS 运行时的两个系统性偏差**：`git checkout <tag> --` 写出的工作树文件带 CRLF（`git ls-files --eol` 显示 `i/lf w/crlf`），会让 shell 脚本的反斜杠续行断掉（`check-shared-files.sh` 直接报 `--runtime-manifest: command not found`）；而 MSYS 的 gawk 把 argv 按 ANSI 代码页（本机 cp936）重编码，中文正则与字面量永远匹配不上 UTF-8 文件（`awk -v lit='状态{已埋}'` 量到 10 字节而不是 14）。这两条让五处产品 hook 在本机「看起来是内容回归」，其实是平台缺陷。

上一轮已经确立过「不 merge、按路径白名单同步」的做法（见 `2026-11-05-sync-upstream-v0-10-0.md`），本轮直接沿用；但本轮的红项全部落在 **hook 的实际运行行为**上，只改守卫不修产品会在 Windows 用户那里留下真 bug。

## Decision

1. **git 通道用 `-c http.sslBackend=openssl` 绕过** schannel；随后 `fetch origin --tags` 与 `fetch https://github.com/zenstory-ai/oh-story-claudecode.git 'refs/tags/v0.10.2:refs/tags/v0.10.2' 'refs/tags/v0.10.3:refs/tags/v0.10.3'` 均成功（该 git 构建会警告 `Ignoring unavailable SSL backend 'openssl'; using 'schannel'`，但连接照样成功）。
2. **直接对齐上游 tag `v0.10.3`**，而不是等 fork：白名单 `skills scripts demo .claude-plugin .zcode-plugin .clawhub marketplace.json reasonix-plugin.json .github README.md README_EN.md CHANGELOG.md CONTRIBUTING.md` 用 `git checkout v0.10.3 -- $WL`；白名单内上游已删的文件用 `ls-tree` 与 `ls-files` 差集显式删除（本轮差集为空，唯一变更是新增 `skills/story-setup/references/agent-references/cross-book-recall.md`）。
3. **检出后把工作树文本归一化为 LF**：按 `git ls-files --eol` 找出 `i/lf + w/crlf` 的文件做 CRLF→LF，共 228 个；归一化后白名单内 index 与 worktree 都是 `i/lf w/lf`，工作树哈希、索引哈希与 tag blob 哈希三者逐一相等。
4. **五处产品 hook 修 Windows/MSYS 缺陷**（行为等价或纯健壮性改动，Linux 上无变化）：
   - `detect-story-gaps.sh`：伏笔 awk 程序改由 `-f <(cat <<'AWK_FORESHADOW' … AWK_FORESHADOW)` 传入，不再经过 argv——否则 argv 里的 UTF-8 中文被按 cp936 重编码，表头与 `已埋/已回收/放弃` 永不匹配，每次 SessionStart 都误报「过期或异常伏笔」。
   - `detect-story-gaps.sh`：拆文提示的相对路径加兜底 `${progress_file#*/拆文库/}`——`project_root` 用 `pwd -P` 得 `/c/...`，而 MSYS `find` 输出 `C:/...`，前缀剥离落空会把整条绝对路径打进提示。
   - `lib/common.sh` 的 `analysis_incomplete`：第一个 grep 后加 `</dev/null`——MSYS 下「grep 带文件参数 + 输出进管道」会吞掉调用方 `while read` 的 stdin，`discover_incomplete_analyses` 于是只检查第一个 `_progress.md`。
   - `guard-outline-before-prose.sh`：`[ -z "$TARGET" ] && TARGET="$(…)"` 改成显式 `if`——TARGET 非空时 AND 列表返回 1，`set -e` 直接把 hook 带走（exit 1，既不拦也不放行），缺细纲的写入被静默放过。
   - `session-start.sh`：`HOOK_SOURCE=$(cat | sed | head)` 改成 `HOOK_STDIN="$(cat)"` 加纯 bash `case` 匹配——MSYS 命令替换里那条三段管道取不到内容，`compact`/`clear` 被当成新会话，误报「agents 现已注册可用」并把 `.agents-pending-restart` 标记吃掉。
5. **守卫侧补丁**（都是 Windows 平台缺口，不改变 Linux 断言强度）：`check-reference-routing.py` 用 `relative_to(root).as_posix()`（反斜杠会毁掉 `endswith("/" + source)` 的模板文件比对）；`check-antigravity-adapter.sh` 的 `ln -s` fixture 建不出来时打 `SKIP`；`test-antigravity-hook-merge.py` 的 `st_mode & 0o777 == 0o640` 在 `os.name == "nt"` 下跳过；`test-antigravity-skills-deploy.py` 先探测 symlink 能力再跑 symlink 用例；`test-opencode-plugin.mjs` 的两处路径断言（compaction 与 session.context）在比较前把反斜杠归一成斜杠。
6. **插件升 0.2.6**：`package.json` / `lib/index.js` 的 `VERSION` / README 三处一致；重新 vendored 后 `check-parity` 报 **435 个文件逐字节相同**。README 补 v0.2.6 段（0.10.3、agents_version 42 / setup_skill_version 1.3.10、新增 cross-book-recall.md、白名单内 344 文件 +4810/−11100 行）。

## Alternatives considered

- **等 fork `origin/main` 追到 0.10.3 再同步。**
  最强理由：与历史一致——前几轮都是「fork 的 main 先更新，我再跟着对齐」，不必给仓库引入第二个内容来源。
  为何不用：fork 停在 0.10.2，而作者要的是「源头有更新就同步」；`git fetch <url> refs/tags/...` 不改 remote 配置就能拿到上游 tag，代价只是多记一条命令。

- **git 连不上就退到 curl 逐文件下载或拉 release tarball。**
  最强理由：`curl` 到 `api.github.com` 与 `raw.githubusercontent.com` 一直正常，7 MB 的 tarball 也能拉，看起来是绕开 git 的最短路径。
  为何不用：curl tarball 在这台机器上只有约 17 KB/s（40 秒才 704 KB），逐文件下载又要自己处理删除、重命名与模式位，而且拿不到 git 对象、后续 diff 与逐文件取证全失；根因只是一个 `http.sslBackend` 配置，改一行就恢复正规通道。

- **只在 `scripts/` 加平台跳过，不动 `skills/` 里的产品 hook。**
  最强理由：产品文件与上游保持逐字节一致，下次同步零冲突；守卫红只是本机环境问题，Linux CI 一直是绿的。
  为何不用：这五处不是「测试跑不起来」，而是 **hook 在 Windows 中文环境下行为就是错的**——误报伏笔异常、漏数拆文库、缺细纲放行、吃掉重启标记，都是本插件要交付给 DSH 用户的实际行为；原样保留等于把已知 bug 一起发出去。

- **加 `.gitattributes`（`* text=auto eol=lf`）从源头消灭 CRLF。**
  最强理由：一次性解决所有行尾敏感问题，之后每次检出都不必再手工归一化。
  为何不用：这会重写全仓工作区行尾、影响所有贡献者的 `git status`，属于独立的仓库级决策（`2026-10-04-doc-budget-crlf-anchor-lookup` 也因同一理由否掉过），不该夹在一次内容同步里。

- **把 awk 那处改成 `LC_ALL=C.UTF-8` 之类只调环境变量。**
  最强理由：只改一行环境变量，不必把 awk 程序搬进进程替换，改动面最小。
  为何不用：实测 `LC_ALL=C.UTF-8` 下 gawk 直接报 `Invalid multibyte data detected`、取值仍然错；本机 argv 编码由 ANSI 代码页决定，`chcp` 与 locale 都改不动。走 `-f` 才是真正绕开 argv 转换。

## Consequences

收益：

- 插件拿到上游 0.10.3 的全部内容（白名单内净删减 6290 行：清掉跨文件重复、文末复述与面向人类培训的心态说教，保留按需路由表、18 套短篇公式、10 套题材节奏骨架、正反例与修稿自检清单），并补上 0.10.1 的 `cross-book-recall.md`。
- 验收全绿：根目录 13 条守卫、七端适配器 8 条、`check-story-setup-deployment.sh`（含 TS11 / TS11b / TS12）、插件四项（manifest / 14 项变异回归 / parity 435 文件 / 35 项工具测试）。
- 五处 hook 修好之后，Windows 中文环境下的 SessionStart 不再误报伏笔异常、拆文库能数全、缺细纲真的会被拦、`compact` 与 `clear` 不再吃掉重启标记。

代价与风险：

- **产品侧与上游产生 5 处有意分叉**（`detect-story-gaps.sh` 两处、`lib/common.sh`、`guard-outline-before-prose.sh`、`session-start.sh`）。下次同步若上游动到这些文件，必须按语义重贴而不是整文件覆盖；本笔记是唯一清单，没有脚本强制它。
- 守卫侧同样多出 5 处补丁（`check-reference-routing.py`、`check-antigravity-adapter.sh`、两个 antigravity 测试、`test-opencode-plugin.mjs`），与已有的 doc-budget / codex / opencode 补丁一起构成「本地脚本与上游不逐字节一致」的长期状态。
- 「检出后归一化 LF」是每次同步都要手工重做的一步；没有 `.gitattributes` 兜底，忘掉就会看到 `command not found` 这类假红。
- 五处 hook 修法都是**绕过**而非修复 MSYS/CP936 本身：如果上游将来换成 UTF-8 干净的运行方式，部分补丁可以删掉，但现在没有回归能提示「可以删了」。
- 这些修法值得回报上游；本轮只落本地，未开 issue。
