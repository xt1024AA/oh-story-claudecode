/**
 * 检测器工具共核：check-ai-patterns.js / check-degeneration.js 同构封装。
 *
 * 契约（#3）：
 *   - 两者都「只报告不改写」；`--check` 是接受但无行为的对称参数，`--json` 给
 *     `{"findings":[{file,line,column,type,severity,message,excerpt,review?}]}`。
 *   - 退出码三档一致：0 = 无 finding（或未达 --fail-on 门槛）、1 = 有 finding 且达到
 *     门槛、2 = 工具故障（文件读不到 / 未知参数 / 无文件 / finding 类型缺 review 类）。
 *   - `--fail-on=blocking|all` 控制退出码门槛；本工具始终传 `--json` 取结构化结果。
 *
 * 本工具把「exit 1 = 有发现」当作**有效业务结果**（ok: true，status=findings），
 * 而不是故障——这正是检测器的本职。exit 2 才是故障（ok: false）。
 */

import { makeTool, buildCommand } from "./_shared.js";
import { ERROR_CODES, toolError } from "../runtime/errors.js";

/** 把检测器的 findings 数组做成计数。 */
export function countFindings(findings) {
  const total = Array.isArray(findings) ? findings.length : 0;
  let blocking = 0;
  let advisory = 0;
  for (const f of Array.isArray(findings) ? findings : []) {
    if (f?.severity === "blocking") blocking += 1;
    else advisory += 1;
  }
  return { total, blocking, advisory };
}

/** exit 2 的检测器故障 → 可读错误（这类脚本 exit 2 只往 stderr 打 die 文案，没有 JSON）。 */
function detectorFailure(stderr) {
  const detail = (stderr || "").trim().slice(0, 300);
  return toolError(
    ERROR_CODES.EXIT_UNEXPECTED,
    `检测器以退出码 2 结束（工具故障）${detail ? `：${detail}` : "。"}`,
    "确认 files 都是存在的 UTF-8 正文文件、参数合法后重试；仍失败则手工跑等价命令复现。",
  );
}

/**
 * @param {object} runtime
 * @param {object} spec { name, description, scriptKey, defaultFailOn, extraNotes }
 * @returns {object} 工具定义
 */
export function createDetectorTool(runtime, spec) {
  const { name, description, scriptKey, defaultFailOn, extraNotes = [] } = spec;
  return makeTool({
    name,
    description,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "要扫描的正文文件路径（至少一个；多个会一起扫）",
        },
        failOn: {
          type: "string",
          enum: ["blocking", "all"],
          description: "触发「有发现」判定（exit 1）的门槛：blocking=只看 blocking 级；all=任何 finding 都算。默认：" + defaultFailOn + "。",
        },
      },
      required: ["files"],
    },
    execute: async (args, exec) => {
      const rawFiles = args.files;
      if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
        return runtime.failEnvelope({
          tool: name,
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
            "参数 files 必填，至少一个正文文件路径。",
            "补上 files（数组）后重试。",
          ),
        });
      }
      const cwd = runtime.resolveCwd(exec).cwd;
      const paths = [];
      for (const f of rawFiles) {
        if (typeof f !== "string" || f.trim() === "") {
          return runtime.failEnvelope({
            tool: name,
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
              "files 里的每一项都必须是文件路径字符串。",
              "把 files 改成路径字符串数组后重试。",
            ),
          });
        }
        const check = runtime.assertPath(f, cwd, { kind: "file", label: "正文文件" });
        if (!check.ok) {
          return runtime.failEnvelope({
            tool: name,
            command: "",
            exitCode: -1,
            status: "",
            env: {},
            stdout: "",
            stderr: "",
            sideEffects: [],
            notes: [],
            error: toolError(check.code, check.error, "确认文件存在后重试。"),
          });
        }
        paths.push(check.path);
      }

      const failOn = args.failOn === "all" || args.failOn === "blocking" ? args.failOn : defaultFailOn;

      const argv = ["--check", "--json", `--fail-on=${failOn}`, ...paths];
      const command = buildCommand("{node}", runtime.scripts[scriptKey], argv);

      const ran = await runtime.runNode(runtime.scripts[scriptKey], argv, { signal: exec?.signal });
      if (!ran.ok) {
        return runtime.failEnvelope({
          tool: name,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: -1,
          status: "",
          env: { python: null, node: ran.probe },
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
          tool: name,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: outcome.exitCode,
          status: "",
          env: { python: null, node: ran.probe },
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects: [],
          notes: [],
          error: runtime.errorFromProcess(outcome),
        });
      }

      if (outcome.exitCode === 2) {
        return runtime.failEnvelope({
          tool: name,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: 2,
          status: "",
          env: { python: null, node: ran.probe },
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects: [],
          notes: [],
          error: detectorFailure(outcome.stderr),
        });
      }

      const parsed = runtime.parseSingleLineJson(outcome.stdout);
      if (!parsed.ok) {
        return runtime.failEnvelope({
          tool: name,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: outcome.exitCode,
          status: "",
          env: { python: null, node: ran.probe },
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects: [],
          notes: [],
          error: toolError(
            ERROR_CODES.OUTPUT_UNEXPECTED,
            `检测器输出不是预期的 JSON（${parsed.reason}）`,
            "读 stdout 原文定位；必要时手工跑等价命令复现。",
          ),
        });
      }
      const result = parsed.value;
      if (!Array.isArray(result?.findings)) {
        return runtime.failEnvelope({
          tool: name,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: outcome.exitCode,
          status: "",
          env: { python: null, node: ran.probe },
          result,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects: [],
          notes: [],
          error: toolError(
            ERROR_CODES.OUTPUT_UNEXPECTED,
            "检测器 JSON 里 findings 不是数组（协议不符）。",
            "把这条报错与 stdout 原文报告给插件维护者。",
          ),
        });
      }

      const counts = countFindings(result.findings);
      const hasFindings = result.findings.length > 0;
      const status = hasFindings ? "findings" : "clean";

      const notes = [
        hasFindings
          ? `发现 ${counts.total} 处（blocking ${counts.blocking} / advisory ${counts.advisory}），failOn=${failOn} 门槛${outcome.exitCode === 1 ? "已触发（exit 1）" : "未触发（exit 0）"}。`
          : `未发现 finding（exit 0）。`,
        "检测器只报告不改写，本工具绝不改动文件。",
        ...extraNotes,
      ];

      return runtime.envelope({
        ok: true,
        tool: name,
        command: runtime.fmtCommand(command, ran.probe),
        exitCode: outcome.exitCode,
        status,
        env: { python: null, node: ran.probe },
        result,
        counts,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        sideEffects: [],
        notes,
      });
    },
  });
}
