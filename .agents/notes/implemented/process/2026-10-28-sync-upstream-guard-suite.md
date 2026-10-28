# 守卫套件跟上上游：scripts/ 一起同步，CRLF 补丁保留

## Problem

根 `skills/` 已按上游 v0.9.0 / v0.9.1 更新，但根 `scripts/` 仍停在分支点 `87f2e7e` 的 0.8.x 版本。三条守卫因此长期是红的，且红的原因各不相同：

- `check-doc-budget.sh`：`doc-budget.json` 还登记着 0.9.0 已删掉的资料（`anti-ai-writing.md`、`format-and-structure.md` 等），并给已改写的文件留着过期预算，报「登记的文件不存在」。
- `check-shared-files.sh`：`shared-assets.json` 不认识 0.9.x 新登记的双份脚本 `outline_view.py`，报 UNMANAGED DUPLICATE。
- `skill-numbering.py check`：脚本本身没问题，是本机 `python3` 指向 Microsoft Store 占位程序，静默 `exit 49`；改用 `python` 即 PASS。这类「守卫红」其实是环境假象。

## Decision

`scripts/` 整体同步到 `upstream/main`（v0.9.1，`70d1cf4`）：25 个文件修改、3 个新增（`generate-zcode-agents.py`、`test-handoff-contracts.py`、`test-zcode-agents.py`），四份守卫配置（`doc-budget.json` / `shared-assets.json` / `shared-references.json` / `current-contract.json`）随之上新。

保留 fork 自己的 CRLF 补丁（`280e6b5`）：上游 `check-doc-budget.sh` 读文件时不归一化行尾，同步后把 `.replace(/\r\n?/g, "\n")` 加回读取处；`test-doc-budget.py` 的 `run_checker` 补 `write_newline` 参数并恢复 CRLF 回归用例。决策笔记 `2026-10-04-doc-budget-crlf-anchor-lookup.md` 记录的仍然是已落地事实。

验证口径固定在四条本地命令上：`static-check.sh`、`skill-numbering.py check`、`check-doc-budget.sh`、`check-shared-files.sh`；守卫的 Python 调用统一写 `python`（探测链见 AGENTS.md 的 python3 → python → py，本机只有 `python` 可用）。

## Alternatives considered

- **只同步四份配置 JSON，不动 `scripts/` 代码。** 最强理由：改动面最小，三处红都能修绿。为何不用：0.9.1 的守卫脚本本身也变了（新增 zcode agents 校验、handoff 契约夹具、扫榜聚合测试），只换配置会让守卫与它校验的流程脱节，下次上游再改脚本仍要手工追。
- **直接接受上游 `check-doc-budget.sh`，放弃 fork 的 CRLF 补丁。** 最强理由：与上游逐字节一致，以后同步零冲突、零维护。为何不用：本机 `core.autocrlf=true` 且仓库无 `.gitattributes`，丢掉归一化后所有 `文件#小节` 登记项都会误报「小节找不到」（`280e6b5` 实测 48/48 失败），按节计量在 Windows 上不可用；上游 CI 的 windows job 不跑这条守卫，所以上游不会替我们兜住。
- **让守卫保持红色，只在提交信息里说明这是既有欠账。** 最强理由：同步技能内容是本职，守卫属于仓库开发工具，不该顺手扩大范围。为何不用：AGENTS.md 要求提交前守卫为绿，长期红等于没人看，下一次真出问题也被淹没。

## Consequences

收益：三条守卫恢复可读信号，`static-check`、`skill-numbering`、`doc-budget`、`shared-files` 四条命令在本机（CRLF 检出 + 无 `python3`）全绿；上游新增的 `test-handoff-contracts.py`、`test-zcode-agents.py` 也在本仓通过，跨技能交接与 ZCode 角色有了本地回归。

代价：`scripts/` 变成「大部分镜像上游 + 一处有意偏离（CRLF 补丁）」，以后每次同步都要记得把那一行贴回去，否则本机守卫会红——这正是它容易被忽略的地方。CHANGELOG / README / CONTRIBUTING 与 `.github/workflows` 仍停在 0.8.x 时代，本次没碰，属下一笔欠账。
