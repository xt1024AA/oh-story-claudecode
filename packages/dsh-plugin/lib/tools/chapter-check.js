/**
 * oh_story_chapter_check —— storyctl.py chapter check 的封装。
 *
 * 契约（#3）与安全语义（#12）在这里交汇：
 *
 *  - **默认只读**：不加 `fixPunctuation` 就不改正文。
 *  - **`fixPunctuation: true` 是破坏性开关**（原地整理正文标点），必须先过审批闸门。
 *  - **纯检查也有一个容易漏的副作用**（#3 契约第 3 条）：章节超长且 quality pass 时，
 *    storyctl 会写 `.story/work/第{NNN}章/over_length_baseline.json`（后续接受超长
 *    前证明「真做过净删压缩」的指纹）。本工具对 `.story/work/第{NNN}章` 做跑前/跑后
 *    快照，差异如实写进 sideEffects——「纯看一眼也会落盘」这件事在模型面前是可见的。
 *
 * 退出码语义（本工具 `ok` 只表示「拿到了有效业务判定」，不是「判定通过」）：
 *   exit 0（ready / needs_decision）→ ok true
 *   exit 1（blocked / invalid）→ ok true（业务判定就是「被拦截」，见 result.status）
 *   exit 2（story-chapter-error/v1）→ ok false，按 error_code 给下一步
 *   exit 3（tool_unavailable）→ ok false，下一步：装 Node.js 18+
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { makeTool, existingDir, optionalInt, rangePair, buildCommand } from "./_shared.js";
import { ERROR_CODES, toolError } from "../runtime/errors.js";

const TOOL_NAME = "oh_story_chapter_check";

/** storyctl 的章工作目录：第{N:0width}章，width = max(3, 位数)（storyctl.py:80-82）。 */
export function chapterWorkDir(project, chapter) {
  const width = Math.max(3, String(chapter).length);
  return join(project, ".story", "work", `第${String(chapter).padStart(width, "0")}章`);
}

/** 在 正文/ 下定位本章正文文件：basename 以 `第0*{chapter}章` 开头（#3 契约 `正文/第N章*.md`）。 */
export function findChapterBody(project, chapter) {
  const bodyDir = join(project, "正文");
  let entries = [];
  try {
    entries = readdirSync(bodyDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const re = new RegExp(`^第0*${chapter}章`);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (re.test(entry.name)) return join(bodyDir, entry.name);
  }
  return null;
}

/** exit 2 的 story-chapter-error/v1 → 可读错误（错误码稳定可断言）。 */
function chapterError(errorCode, message) {
  switch (errorCode) {
    case "CHECK_FAILED":
      return toolError(
        errorCode,
        message || "章节数据不满足检查前置（文件缺失 / 形状不对）。",
        "按 message 修正项目结构后重跑；必要时先手工跑等价命令复现。",
      );
    case "INVALID_ARGUMENT":
      return toolError(
        errorCode,
        message || "参数不合法。",
        "按 message 修正参数后重跑。",
      );
    case "TOOL_UNAVAILABLE":
      return toolError(
        errorCode,
        message || "质量检查所需的 Node.js 不可用。",
        "安装 Node.js 18+ 并确认 `node --version` 可用后重跑本章检查。",
      );
    default:
      return toolError(
        errorCode,
        message || "章节检查失败（未知错误码）。",
        "读 message 与 stdout/stderr 定位原因；必要时手工跑等价命令复现。",
      );
  }
}

/**
 * @param {object} runtime
 * @returns {object} 工具定义
 */
export function createChapterCheckTool(runtime) {
  return makeTool({
    name: TOOL_NAME,
    description:
      "storyctl.py chapter check 的封装：对一章跑完整写后检查（AI 句式、退化、标点、细纲照搬、字数），" +
      "返回 result.status = ready / needs_decision / blocked / invalid / tool_unavailable 与 available_actions。" +
      "默认只读；status=blocked 是业务判定（本章被 quality 拦截），不是工具故障。想先整理标点再检查时" +
      "显式给 fixPunctuation=true（破坏性，需人工审批）。纯检查在章节超长时仍会写" +
      ".story/work/第{NNN}章/over_length_baseline.json（指纹留档），sideEffects 会如实报告。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string", description: "书项目根目录（含 大纲/ 正文/ 追踪/）" },
        chapter: { type: "integer", description: "章节号（≥1）" },
        minChars: { type: "integer", description: "作者字数下限（须与 maxChars 同给）" },
        maxChars: { type: "integer", description: "作者字数上限（须与 minChars 同给）" },
        fixPunctuation: {
          type: "boolean",
          description:
            "默认 false（只读）。true = 破坏性：先原地整理正文标点再做检查，需人工审批。" +
            "不要在没看过只读结果前给 true。",
        },
        confirm: {
          type: "boolean",
          description:
            "仅供审批通道不可用时的人工回退（见 #12 语义）：作者明确要求执行破坏性动作、但宿主审批服务不可用时，" +
            "带 confirm=true 会按显式确认放行。审批通道正常时请勿使用。",
        },
      },
      required: ["project", "chapter"],
    },
    execute: async (args, exec) => {
      const cwd = runtime.resolveCwd(exec).cwd;
      const proj = existingDir(runtime, exec, args, "project", "书项目目录");
      if (!proj.ok) {
        return runtime.failEnvelope({
          tool: TOOL_NAME,
          command: "",
          exitCode: -1,
          status: "",
          env: {},
          stdout: "",
          stderr: "",
          sideEffects: [],
          notes: [],
          error: proj.error,
        });
      }
      const chapter = optionalInt(args, "chapter", { min: 1 });
      if (!chapter.ok) {
        return runtime.failEnvelope({
          tool: TOOL_NAME,
          command: "",
          exitCode: -1,
          status: "",
          env: {},
          stdout: "",
          stderr: "",
          sideEffects: [],
          notes: [],
          error: chapter.error,
        });
      }
      const range = rangePair(args);
      if (!range.ok) {
        return runtime.failEnvelope({
          tool: TOOL_NAME,
          command: "",
          exitCode: -1,
          status: "",
          env: {},
          stdout: "",
          stderr: "",
          sideEffects: [],
          notes: [],
          error: range.error,
        });
      }

      const fixPunctuation = args.fixPunctuation === true;
      let approval = null;
      if (fixPunctuation) {
        approval = await runtime.approve(exec, {
          toolName: TOOL_NAME,
          reason: `整理第 ${chapter.value} 章正文标点（storyctl chapter check --fix-punctuation）后重新检查；会原地改写正文文件。`,
          confirm: args.confirm === true,
        });
        if (!approval.granted) {
          return runtime.failEnvelope({
            tool: TOOL_NAME,
            command: "",
            exitCode: -1,
            status: "",
            env: {},
            stdout: "",
            stderr: "",
            sideEffects: [],
            notes: [],
            approval: { via: approval.via, outcome: approval.outcome, detail: approval.detail },
            error: toolError(
              approval.outcome === "rejected" ? ERROR_CODES.APPROVAL_REJECTED : ERROR_CODES.APPROVAL_REQUIRED,
              approval.detail,
              approval.outcome === "rejected"
                ? "不要重试，也不要带 confirm 绕过；由作者在会话里明确指示后发起。"
                : "作者确认后带 confirm: true 重试（回退通道）。",
            ),
          });
        }
      }

      // 跑前取证：章工作目录快照 + 正文指纹（fixPunctuation 时才有正文改动可比对）
      const workDir = chapterWorkDir(proj.path, chapter.value);
      const beforeWork = runtime.snapshotDir(workDir);
      const bodyPath = findChapterBody(proj.path, chapter.value);
      const beforeBodySha = bodyPath ? runtime.sha256File(bodyPath) : null;

      const argv = ["chapter", "check", "--project", proj.path, "--chapter", String(chapter.value)];
      if (range.minChars !== null) argv.push("--min-chars", String(range.minChars));
      if (range.maxChars !== null) argv.push("--max-chars", String(range.maxChars));
      if (fixPunctuation) argv.push("--fix-punctuation");
      const command = buildCommand("{python}", runtime.scripts.storyctl, argv);

      const ran = await runtime.runPython(runtime.scripts.storyctl, argv, { signal: exec?.signal });
      if (!ran.ok) {
        return runtime.failEnvelope({
          tool: TOOL_NAME,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: -1,
          status: "",
          env: { python: ran.probe, node: null },
          stdout: "",
          stderr: "",
          sideEffects: [],
          notes: [],
          error: ran.error,
        });
      }
      const outcome = ran.outcome;
      if (outcome.spawnError || outcome.timedOut || outcome.aborted) {
        return runtime.failEnvelope({
          tool: TOOL_NAME,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: outcome.exitCode,
          status: "",
          env: { python: ran.probe, node: null },
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects: [],
          notes: [],
          error: runtime.errorFromProcess(outcome),
        });
      }

      const parsed = runtime.parseSingleLineJson(outcome.stdout);
      if (!parsed.ok) {
        return runtime.failEnvelope({
          tool: TOOL_NAME,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: outcome.exitCode,
          status: "",
          env: { python: ran.probe, node: null },
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects: [],
          notes: [],
          error: toolError(
            ERROR_CODES.OUTPUT_UNEXPECTED,
            `storyctl 的输出不是预期的一行 JSON：${parsed.reason}`,
            "读 stdout 原文定位；必要时手工跑等价命令复现。",
          ),
        });
      }
      const result = parsed.value;

      // 跑后取证：工作目录差异 + 正文是否被 fix 改动
      const afterWork = runtime.snapshotDir(workDir);
      const workDiff = runtime.diffSnapshots(beforeWork, afterWork);
      const sideEffects = runtime.diffToSideEffects(workDiff, workDir);
      const afterBodySha = bodyPath ? runtime.sha256File(bodyPath) : null;
      if (fixPunctuation && bodyPath && beforeBodySha !== afterBodySha) {
        sideEffects.push({
          kind: "file-modified",
          target: bodyPath,
          detail: `fixPunctuation 原地改写正文（sha256 ${(beforeBodySha ?? "").slice(0, 12)} → ${(afterBodySha ?? "").slice(0, 12)}）`,
        });
      }

      if (outcome.exitCode === 3) {
        // tool_unavailable（多半缺 node）
        const message = typeof result?.message === "string" ? result.message : "";
        return runtime.failEnvelope({
          ok: false,
          tool: TOOL_NAME,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: 3,
          status: "tool_unavailable",
          env: { python: ran.probe, node: null },
          result,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects,
          notes: ["本章不能提交，没有绕过；先解决环境再重跑。"],
          error: toolError(
            ERROR_CODES.TOOL_UNAVAILABLE,
            message || "质量检查工具不可用（多半是缺 Node.js）。",
            "安装 Node.js 18+ 并确认 `node --version` 可用后重跑本章检查。",
          ),
        });
      }

      if (outcome.exitCode === 2) {
        // story-chapter-error/v1
        return runtime.failEnvelope({
          ok: false,
          tool: TOOL_NAME,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: 2,
          status: String(result?.status ?? "error"),
          env: { python: ran.probe, node: null },
          result,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects,
          notes: ["exit 2 是脚本的错误协议（story-chapter-error/v1），按 error_code 处理。"],
          error: chapterError(String(result?.error_code ?? "CHECK_FAILED"), typeof result?.message === "string" ? result.message : ""),
        });
      }

      // exit 0 / 1：有效业务判定
      const status = String(result?.status ?? "unknown");
      const statusNotes = {
        ready: "本章可提交（available_actions 里有 commit）。",
        needs_decision: "字数出带，需要作者决策；看 available_actions（compress-once / accept-current-length / revise-outline-or-target / discard）。",
        blocked: "本章被 quality 拦截：先修净 blocking findings 再重跑。",
        invalid: "字数判定无效（EMPTY_BODY 等），先看 length.invalid_reason。",
        tool_unavailable: "质量工具不可用（上一步已按故障处理）。",
      };
      const notes = [];
      notes.push(statusNotes[status] ?? `业务状态：${status}。`);
      if (workDiff.added.length > 0 || workDiff.modified.length > 0) {
        notes.push("纯检查也会落盘：章节超长且 quality pass 时 storyctl 写了 over_length_baseline.json（见 sideEffects）。");
      }
      if (fixPunctuation) {
        notes.push(
          result?.punctuation_fixed === true
            ? "本次 fixPunctuation 实际改写了正文（punctuation_fixed=true）。"
            : "本次 fixPunctuation 未改动正文（已是最干净状态）。",
        );
      }
      notes.push("ok=true 只表示拿到了有效判定；status=blocked 是业务拦截，按 result.quality.blocking_findings 处理。");

      return runtime.envelope({
        ok: true,
        tool: TOOL_NAME,
        command: runtime.fmtCommand(command, ran.probe),
        exitCode: outcome.exitCode,
        status,
        env: { python: ran.probe, node: null },
        result,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        sideEffects,
        notes,
        approval: approval ? { via: approval.via, outcome: approval.outcome, detail: approval.detail } : undefined,
      });
    },
  });
}
