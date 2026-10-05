/**
 * oh_story_wordcount —— 字数口径（storyctl.py wordcount 组）。
 *
 * 契约（#3，story-script-contracts.md）：
 *   - `measure`：数一个正文文件的 visible_chars_v1 字数（纯只读）。
 *   - `check`：对 target 判定 internal/user 带（只读；`--target` 必填）。
 *   - `checkpoint`：给章节写手分段时算「后面还能写多少字」的剩余区间
 *     （`--target` 与 `--project` 二选一；给 project 时从细纲读目标与作者范围）。
 *
 * 注意（#3 速览 10）：wordcount 组把 `--chapter` 当字符串透传，不做整数解析——
 * 但本工具仍会在 Node 侧先校验它是 ≥1 的整数，避免把脏数据丢给脚本。
 *
 * 只读工具，无审批。退出码 0 = 有业务结果；2 = 判定 invalid（业务上的「非法输入」，
 * 对工具来说也是有效结果：status=invalid + invalid_reason 由模型据此纠正参数）。
 */

import { makeTool, requiredString, existingFile, optionalInt, rangePair, buildCommand } from "./_shared.js";
import { ERROR_CODES, toolError } from "../runtime/errors.js";

const TOOL_NAME = "oh_story_wordcount";
const ACTIONS = ["measure", "check", "checkpoint"];

/** 把 wordcount 的 invalid_reason 翻译成人话 + 下一步。 */
function wordcountInvalidError(result) {
  const reason = typeof result?.invalid_reason === "string" ? result.invalid_reason : "INVALID";
  const caseId = typeof result?.case_id === "string" && result.case_id ? result.case_id : "";
  const base = caseId ? `（细节：${caseId}）` : "";
  switch (reason) {
    case "INVALID_FILE":
      return toolError(
        reason,
        `正文文件读不到或不是 UTF-8${base}。`,
        "确认 file 指向存在的 UTF-8 正文文件后重试。",
      );
    case "INVALID_OUTLINE":
      return toolError(
        reason,
        `读细纲失败：project/chapter 组合拿不到字数目标${base}。`,
        "确认 project 是书目录、chapter 存在对应细纲（大纲/细纲_第N章.md）后重试。",
      );
    case "INVALID_TARGET":
      return toolError(
        reason,
        `字数目标 target 不合法${base}。`,
        "给一个 ≥1 的整数 target 后重试。",
      );
    case "EMPTY_BODY":
      return toolError(
        reason,
        `正文为空（visible_chars_v1 计 0 字）${base}。`,
        "先补上正文再测字数。",
      );
    case "INVALID_ARGUMENT":
      return toolError(
        reason,
        `参数不合法${base}。`,
        "按报错里的细节修正参数后重试。",
      );
    default:
      return toolError(
        reason,
        `字数判定为 invalid${base}。`,
        "读 result 的 invalid_reason 字段定位原因后重试。",
      );
  }
}

/**
 * @param {object} runtime
 * @returns {object} 工具定义
 */
export function createWordcountTool(runtime) {
  return makeTool({
    name: TOOL_NAME,
    description:
      "字数口径 visible_chars_v1（storyctl.py wordcount 组）的只读封装。" +
      "action=measure 数单个正文文件的字数；action=check 按 target 判定 internal/user 字数带（target 必填）；" +
      "action=checkpoint 按 target 或 project（从细纲读目标）算本章剩余可写区间。返回 result 为脚本 JSON 原样。" +
      "绝不改写任何文件。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description: "measure=数字数；check=对目标判带；checkpoint=算剩余区间。",
        },
        file: { type: "string", description: "正文文件路径（绝对或相对当前工作区）" },
        target: { type: "integer", description: "字数目标（check 必填；checkpoint 与 project 二选一）" },
        project: { type: "string", description: "书项目根目录（checkpoint 用；与 target 二选一）" },
        chapter: { type: "integer", description: "章节号（透传给脚本；checkpoint 配 project 时必填）" },
        caseId: { type: "string", description: "可选的场景标识，脚本会原样带回 result" },
        minChars: { type: "integer", description: "作者字数下限（须与 maxChars 同给）" },
        maxChars: { type: "integer", description: "作者字数上限（须与 minChars 同给）" },
      },
      required: ["action", "file"],
    },
    execute: async (args, exec) => {
      const action = args.action;
      if (!ACTIONS.includes(action)) {
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
          error: toolError(
            ERROR_CODES.INVALID_ARGUMENT,
            `action 必须是 ${ACTIONS.join(" / ")} 之一（收到：${JSON.stringify(action)}）。`,
            `把 action 改成 ${ACTIONS.join(" / ")} 之一后重试。`,
          ),
        });
      }

      const file = existingFile(runtime, exec, args, "file", "正文文件");
      if (!file.ok) {
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
          error: file.error,
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

      // action 专属参数校验
      if (action === "check") {
        const target = optionalInt(args, "target", { min: 1 });
        if (!target.ok || target.value === null) {
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
            error: toolError(
              ERROR_CODES.INVALID_ARGUMENT,
              "action=check 时 target 必填且必须 ≥1 的整数。",
              "补上 target 后重试。",
            ),
          });
        }
      } else if (action === "checkpoint") {
        const hasTarget = args.target !== undefined && args.target !== null && args.target !== "";
        const hasProject = typeof args.project === "string" && args.project.trim() !== "";
        if (!hasTarget && !hasProject) {
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
            error: toolError(
              ERROR_CODES.INVALID_ARGUMENT,
              "action=checkpoint 时 target 与 project 必须二选一。",
              "补上 target 或 project 后重试。",
            ),
          });
        }
        if (hasProject) {
          if (chapter.value === null) {
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
              error: toolError(
                ERROR_CODES.INVALID_ARGUMENT,
                "action=checkpoint 配 project 时 chapter 必填（脚本要从 大纲/细纲_第N章.md 读目标）。",
                "补上 chapter 后重试。",
              ),
            });
          }
          const proj = runtime.assertPath(args.project, runtime.resolveCwd(exec).cwd, { kind: "dir", label: "书项目目录" });
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
              error: toolError(proj.code, proj.error, "确认 project 指向存在的书目录后重试。"),
            });
          }
        }
      }

      const argv = ["wordcount", action, "--file", file.path];
      if (chapter.value !== null) argv.push("--chapter", String(chapter.value));
      if (typeof args.caseId === "string" && args.caseId.trim()) argv.push("--case-id", args.caseId.trim());
      if (action !== "measure") {
        if (args.target !== undefined && args.target !== null && args.target !== "") {
          argv.push("--target", String(args.target));
        }
        if (range.minChars !== null) argv.push("--min-chars", String(range.minChars));
        if (range.maxChars !== null) argv.push("--max-chars", String(range.maxChars));
        if (action === "checkpoint" && typeof args.project === "string" && args.project.trim()) {
          const projAbs = runtime.toAbsolute(args.project, runtime.resolveCwd(exec).cwd);
          argv.push("--project", projAbs);
        }
      }

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

      if (outcome.exitCode !== 0) {
        // wordcount 组：exit 2 = 判定 invalid（业务失败但对工具是有效结果）
        return runtime.envelope({
          ok: false,
          tool: TOOL_NAME,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: outcome.exitCode,
          status: String(result?.status ?? "invalid"),
          env: { python: ran.probe, node: null },
          result,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects: [],
          notes: ["exit 2 是脚本的业务判定（status=invalid + invalid_reason），不是工具故障。"],
          error: wordcountInvalidError(result),
        });
      }

      const statusMeanings = {
        measured: "已测出字数",
        internal_pass: "在内部带（达标）",
        borderline: "边缘带",
        under: "欠字（低于 user 带）",
        over: "超字（高于 user 带）",
      };
      return runtime.envelope({
        ok: true,
        tool: TOOL_NAME,
        command: runtime.fmtCommand(command, ran.probe),
        exitCode: 0,
        status: String(result?.status ?? ""),
        env: { python: ran.probe, node: null },
        result,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        sideEffects: [],
        notes: [
          `字数判定：${statusMeanings[result?.status] ?? result?.status ?? "未知"}。`,
          "本工具只读，不会改动正文或任何项目文件。",
        ],
      });
    },
  });
}
