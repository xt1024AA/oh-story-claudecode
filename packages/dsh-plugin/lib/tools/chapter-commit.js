/**
 * oh_story_chapter_commit —— storyctl.py chapter commit 的封装。
 *
 * 这是全套件里**最重的破坏性工具**（#12 的原话场景）：
 *   - 原子写 `追踪/_tracking-state.json` 与全部派生视图；
 *   - 成功后删掉本章工作目录（`.story/work/第{NNN}章`）；
 *   - **不幂等**：同一份事务 JSON 重跑必失败（`tracking state changed since this
 *     transaction was prepared`，exit 2）——这是设计好的，不是 bug。
 *
 * 安全语义（#12 裁决）：
 *   - 独立工具名 = 显式开关（模型不可能顺手提交）；
 *   - **每次执行都必须过人工审批**（`approval.request`），拒绝即终局；
 *   - 审批通道不可用时回退 `confirm: true`（显式确认），并在返回里如实标注；
 *   - 不幂等失败返回**可读报错 + 正确下一步**（重跑 `tracking_commit.py draft`
 *     生成新事务 JSON 再提交）。
 *
 * 提交前建议链路（写入 description 让模型照着走）：先 `oh_story_chapter_check`
 * 拿到 ready，再 `tracking_commit.py draft`（本工具不封装 draft——它是纯生成，
 * 作者/模型用 shell 或现有宿主工具跑），拿到事务 JSON 后提交。
 */

import { join } from "node:path";
import { makeTool, existingDir, optionalInt, existingFile, rangePair, buildCommand } from "./_shared.js";
import { ERROR_CODES, toolError } from "../runtime/errors.js";
import { chapterWorkDir } from "./chapter-check.js";

const TOOL_NAME = "oh_story_chapter_commit";

/** commit 的 exit 2 错误码 → 可读错误（重点是不幂等那一支）。 */
function commitError(errorCode, message, project, chapter) {
  switch (errorCode) {
    case "CHECK_FAILED": {
      const stale = typeof message === "string" && /tracking state changed/i.test(message);
      if (stale) {
        return toolError(
          ERROR_CODES.TRANSACTION_STALE,
          "事务已过期：追踪状态在生成这份事务 JSON 之后被改动过（`tracking state changed since this transaction was prepared`）。storyctl 的 chapter commit 不幂等，同份事务重跑必然失败。",
          `重新生成事务：运行 tracking_commit.py draft --project "${project}" --chapter ${chapter}，得到新的事务 JSON 后把它的路径传给 --input 再提交。`,
        );
      }
      return toolError(
        errorCode,
        message || "章节数据不满足提交前置。",
        "按 message 修正项目结构后重跑；必要时先手工跑等价命令复现。",
      );
    }
    case "QUALITY_BLOCKED":
      return toolError(
        errorCode,
        "blocking quality findings 未清干净，本章不能提交。",
        "先跑 oh_story_chapter_check 定位 blocking findings，修净后再走提交链路。",
      );
    case "LENGTH_OUT_OF_BAND":
      return toolError(
        errorCode,
        "章节字数在 user 带之外，普通 commit 不接受。",
        "要么先压缩/补写回到带内，要么走 accept-current-length 流程（本轮工具未封装，见 issue 备注）；不要用 --force 硬来。",
      );
    case "COMPRESSION_REQUIRED":
      return toolError(
        errorCode,
        message || "超长章节必须先做一次净删压缩再考虑接受当前长度。",
        "按 compress-once 做一次净删（零新语义）并重跑 chapter check；仍超长且作者明确接受时再走 accept-current-length。",
      );
    case "BELOW_ACCEPT_FLOOR":
      return toolError(
        errorCode,
        message || "章节欠长到不足目标一半，不能直接接受当前长度。",
        "先补字数或改字数目标；作者明确要这个长度时在 accept-current-length 流程里带 --force（本轮工具未封装）。",
      );
    case "TOOL_UNAVAILABLE":
      return toolError(
        errorCode,
        message || "质量检查所需的 Node.js 不可用。",
        "安装 Node.js 18+ 并确认 `node --version` 可用后重跑提交。",
      );
    case "INVALID_ARGUMENT":
      return toolError(
        errorCode,
        message || "参数不合法。",
        "按 message 修正参数后重跑。",
      );
    default:
      return toolError(
        errorCode,
        message || "提交失败（未知错误码）。",
        "读 message 与 stdout/stderr 定位原因；必要时手工跑等价命令复现。",
      );
  }
}

/**
 * @param {object} runtime
 * @returns {object} 工具定义
 */
export function createChapterCommitTool(runtime) {
  return makeTool({
    name: TOOL_NAME,
    description:
      "storyctl.py chapter commit 的封装：把一章正式提交进追踪（写 追踪/_tracking-state.json 与派生视图，" +
      "删本章工作目录）。**破坏性 + 不幂等**：每次调用都需要人工审批；同一份 --input 事务 JSON 重跑必失败。" +
      "提交前先用 oh_story_chapter_check 拿到 ready，再用 tracking_commit.py draft 生成事务 JSON，最后提交。" +
      "失败时按 error_code 处理：事务过期（TRANSACTION_STALE）的正确下一步是重新 draft 再提交。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string", description: "书项目根目录（含 大纲/ 正文/ 追踪/）" },
        chapter: { type: "integer", description: "章节号（≥1）" },
        input: {
          type: "string",
          description: "逐章事务 JSON 的路径（tracking_commit.py draft 生成，通常在 .story/work/第{NNN}章/tracking.json）",
        },
        minChars: { type: "integer", description: "作者字数下限（须与 maxChars 同给）" },
        maxChars: { type: "integer", description: "作者字数上限（须与 minChars 同给）" },
        confirm: {
          type: "boolean",
          description:
            "仅供审批通道不可用时的回退（#12）：作者明确要求提交、但宿主审批服务不可用时，带 confirm=true 按显式确认放行。审批通道正常时请勿使用。",
        },
      },
      required: ["project", "chapter", "input"],
    },
    execute: async (args, exec) => {
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
      const input = existingFile(runtime, exec, args, "input", "事务 JSON 文件");
      if (!input.ok) {
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
          error: input.error,
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

      // 破坏性闸门：独立工具名即显式开关，审批必须放行。
      const approval = await runtime.approve(exec, {
        toolName: TOOL_NAME,
        reason: `提交第 ${chapter.value} 章（storyctl chapter commit）：会写追踪状态与派生视图、删除本章工作目录 ${chapterWorkDir(proj.path, chapter.value)}。`,
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

      // 跑前取证：章工作目录 + 追踪状态指纹
      const workDir = chapterWorkDir(proj.path, chapter.value);
      const beforeWork = runtime.snapshotDir(workDir);
      const trackingState = join(proj.path, "追踪", "_tracking-state.json");
      const beforeStateSha = runtime.sha256File(trackingState);

      const argv = ["chapter", "commit", "--project", proj.path, "--chapter", String(chapter.value), "--input", input.path];
      if (range.minChars !== null) argv.push("--min-chars", String(range.minChars));
      if (range.maxChars !== null) argv.push("--max-chars", String(range.maxChars));
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

      // 跑后取证
      const afterWork = runtime.snapshotDir(workDir);
      const workDiff = runtime.diffSnapshots(beforeWork, afterWork);
      const sideEffects = runtime.diffToSideEffects(workDiff, workDir);
      const afterStateSha = runtime.sha256File(trackingState);
      if (beforeStateSha !== afterStateSha) {
        sideEffects.push({
          kind: "file-modified",
          target: trackingState,
          detail: `追踪状态被改写（sha256 ${(beforeStateSha ?? "").slice(0, 12)} → ${(afterStateSha ?? "").slice(0, 12)}）`,
        });
      }
      if (typeof result?.work_dir_removed === "string") {
        sideEffects.push({ kind: "dir-removed", target: result.work_dir_removed, detail: "提交成功后本章工作目录被清理" });
      }

      if (outcome.exitCode === 3) {
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
            "安装 Node.js 18+ 并确认 `node --version` 可用后重跑提交。",
          ),
        });
      }

      if (outcome.exitCode !== 0) {
        // exit 2：story-chapter-error/v1
        return runtime.failEnvelope({
          ok: false,
          tool: TOOL_NAME,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: outcome.exitCode,
          status: String(result?.status ?? "error"),
          env: { python: ran.probe, node: null },
          result,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects,
          notes: ["exit 2 是脚本的错误协议（story-chapter-error/v1），按 error_code 处理；提交未发生。"],
          error: commitError(
            String(result?.error_code ?? "CHECK_FAILED"),
            typeof result?.message === "string" ? result.message : "",
            proj.path,
            chapter.value,
          ),
        });
      }

      return runtime.envelope({
        ok: true,
        tool: TOOL_NAME,
        command: runtime.fmtCommand(command, ran.probe),
        exitCode: 0,
        status: "committed",
        env: { python: ran.probe, node: null },
        result,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        sideEffects,
        notes: [
          "提交已落盘（状态与派生视图已写，工作目录已删）。",
          "stderr 里的 WARNING（如 chapter delta 超限）不影响提交，属于提示。",
        ],
        approval: { via: approval.via, outcome: approval.outcome, detail: approval.detail },
      });
    },
  });
}
