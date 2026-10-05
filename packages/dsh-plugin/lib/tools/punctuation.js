/**
 * oh_story_punctuation_normalize —— normalize-punctuation.js 的封装。
 *
 * 这是三个 JS 检测器里**唯一会写文件**的（#3 契约第 5 条），安全语义按 #12 落地：
 *
 *   - **默认只读**：不带 `fix: true` 就等价于 `--check`，只报发现、不落盘。
 *   - **`fix: true` 是破坏性开关**：必须过审批闸门；审批不可用时回退 confirm（如实标注）。
 *   - **并发写保护**：fix 运行整体包进进程内互斥（key=punctuation-fix-global），
 *     同一 DSH 进程内两个 fix 调用不会同时写。跨进程并发原脚本自己也没有锁，
 *     局限写进 notes，不硬造（见 runtime/file-guard.js 头注）。
 *   - **改动证据**：fix 前后逐个文件算 sha256，变了才记 sideEffects，before/after 都给出。
 *   - **幂等**：同一文件第二次 fix 输出 `Done. Changed files: 0`（#3 实测），
 *     本工具照实报告，不把 noop 说成「又改了」。
 *
 * 解析：
 *   --check 输出行 `<path>:<line>:<col>: <type>: <message>`（Windows 盘符路径里也带冒号，
 *   用贪婪匹配的尾部模式解析，先试最后一段）；
 *   fix 输出行 `<file>: normalized (N issues)` + `Done. Changed files: N`。
 */

import { makeTool, buildCommand } from "./_shared.js";
import { ERROR_CODES, toolError } from "../runtime/errors.js";
import { withPathLock } from "../runtime/file-guard.js";

const TOOL_NAME = "oh_story_punctuation_normalize";
const FIX_GLOBAL_LOCK = "punctuation-fix-global";
const QUOTE_MODES = ["keep", "ascii", "yan"];

/** 解析 --check 输出行：`<path>:<line>:<col>: <type>: <message>`。 */
function parseFindingLine(line) {
  const m = /^(.+):(\d+):(\d+): ([^:]+): (.*)$/.exec(line);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), column: Number(m[3]), type: m[4], message: m[5] };
}

/** 解析 fix 输出行：`<file>: normalized (N issues)`。 */
function parseNormalizedLine(line) {
  const m = /^(.+): normalized \((\d+) issues?\)$/.exec(line);
  if (!m) return null;
  return { file: m[1], issues: Number(m[2]) };
}

/**
 * @param {object} runtime
 * @returns {object} 工具定义
 */
export function createPunctuationTool(runtime) {
  return makeTool({
    name: TOOL_NAME,
    description:
      "机械标点归一（normalize-punctuation.js）：发现 ellipsis（省略号）、em-dash（破折号）、double-hyphen、" +
      "markdown-divider、quote-style（引号风格）、html-comment-unclosed 等。" +
      "默认只读（fix=false 等价 --check，只报发现不改写）；fix=true 是破坏性开关（原地改写文件），" +
      "需人工审批，并做进程内并发保护与 sha256 前后取证。" +
      "写后幂等：同一文件第二次 fix 报 Changed files: 0。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "要处理的正文文件路径（至少一个）",
        },
        fix: {
          type: "boolean",
          description:
            "默认 false（只读 --check）。true = 破坏性：原地归一标点，需人工审批。不要在没看过只读结果前给 true。",
        },
        quoteMode: {
          type: "string",
          enum: QUOTE_MODES,
          description:
            "引号风格：keep=不改引号（默认）；ascii=把「」『』与全角双引号全转半角 \"；yan=把半角/全角双引号转「」。只在作者或项目明确要求时给。",
        },
        confirm: {
          type: "boolean",
          description:
            "仅供审批通道不可用时的回退（#12）：作者明确要求 fix、但宿主审批服务不可用时，带 confirm=true 按显式确认放行。审批通道正常时请勿使用。",
        },
      },
      required: ["files"],
    },
    execute: async (args, exec) => {
      const rawFiles = args.files;
      if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
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
              "files 里的每一项都必须是文件路径字符串。",
              "把 files 改成路径字符串数组后重试。",
            ),
          });
        }
        const check = runtime.assertPath(f, cwd, { kind: "file", label: "正文文件" });
        if (!check.ok) {
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
            error: toolError(check.code, check.error, "确认文件存在后重试。"),
          });
        }
        paths.push(check.path);
      }

      const quoteMode = args.quoteMode;
      if (quoteMode !== undefined && quoteMode !== null && quoteMode !== "" && !QUOTE_MODES.includes(quoteMode)) {
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
            `quoteMode 必须是 ${QUOTE_MODES.join(" / ")} 之一（收到：${JSON.stringify(quoteMode)}）。`,
            `把 quoteMode 改成 ${QUOTE_MODES.join(" / ")} 之一后重试。`,
          ),
        });
      }

      const fix = args.fix === true;
      const argv = [];
      if (!fix) argv.push("--check");
      if (quoteMode) argv.push("--quote-mode", quoteMode);
      argv.push(...paths);
      const command = buildCommand("{node}", runtime.scripts.punctuation, argv);

      // fix 模式的破坏性闸门（放在取锁之前：审批没过不碰锁、不跑脚本）
      let approval = null;
      if (fix) {
        approval = await runtime.approve(exec, {
          toolName: TOOL_NAME,
          reason: `原地归一 ${paths.length} 个正文文件的机械标点（normalize-punctuation.js 不带 --check）。`,
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

      // 执行（fix 模式整体持进程内互斥，见文件头注）
      const runBody = async () => {
        const beforeShas = new Map(paths.map((p) => [p, runtime.sha256File(p)]));
        const ran = await runtime.runNode(runtime.scripts.punctuation, argv, { signal: exec?.signal });
        if (!ran.ok) return { ran, beforeShas };
        const outcome = ran.outcome;
        if (outcome.spawnError || outcome.timedOut || outcome.aborted) {
          return { ran, beforeShas };
        }
        // fix 模式再取 after 指纹
        const afterShas = new Map(paths.map((p) => [p, runtime.sha256File(p)]));
        return { ran, beforeShas, afterShas };
      };

      const resultWrapper = fix
        ? await withPathLock(FIX_GLOBAL_LOCK, runBody)
        : await runBody();

      const { ran, beforeShas } = resultWrapper;
      const afterShas = resultWrapper.afterShas;
      if (!ran.ok) {
        return runtime.failEnvelope({
          tool: TOOL_NAME,
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
          tool: TOOL_NAME,
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

      // exit 2：工具故障（读不到文件 / 参数错 / 未知 quote-mode）
      if (outcome.exitCode === 2) {
        const detail = (outcome.stderr || "").trim().slice(0, 300);
        return runtime.failEnvelope({
          tool: TOOL_NAME,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: 2,
          status: "",
          env: { python: null, node: ran.probe },
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects: [],
          notes: [],
          error: toolError(
            ERROR_CODES.EXIT_UNEXPECTED,
            `normalize-punctuation.js 以退出码 2 结束${detail ? `：${detail}` : "。"}`,
            "确认文件存在且参数合法后重试；仍失败则手工跑等价命令复现。",
          ),
        });
      }

      // fix 模式：解析 Changed files + 前后指纹
      if (fix) {
        const changedFiles = [];
        for (const line of (outcome.stdout || "").split(/\r?\n/)) {
          const parsed = parseNormalizedLine(line.trim());
          if (parsed) changedFiles.push(parsed);
        }
        const doneMatch = /Done\. Changed files: (\d+)/.exec(outcome.stdout || "");
        const changedCount = doneMatch ? Number(doneMatch[1]) : changedFiles.length;

        const sideEffects = [];
        for (const p of paths) {
          const before = beforeShas.get(p);
          const after = afterShas.get(p);
          if (before !== after) {
            sideEffects.push({
              kind: "file-modified",
              target: p,
              detail: `标点被归一（sha256 ${(before ?? "").slice(0, 12)} → ${(after ?? "").slice(0, 12)}）`,
            });
          }
        }

        return runtime.envelope({
          ok: true,
          tool: TOOL_NAME,
          command: runtime.fmtCommand(command, ran.probe),
          exitCode: 0,
          status: changedCount > 0 ? "done" : "noop",
          env: { python: null, node: ran.probe },
          result: { changedFiles, changedCount },
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          sideEffects,
          notes: [
            changedCount > 0
              ? `改写了 ${changedCount} 个文件（幂等：再跑一次会报 Changed files: 0）。`
              : "没有需要改写的标点（幂等 noop）。",
            fix
              ? "已按 #12 走审批/确认闸门；并发写受进程内互斥保护（跨进程并发原脚本无锁）。"
              : "本工具默认只读。",
          ],
          approval: approval ? { via: approval.via, outcome: approval.outcome, detail: approval.detail } : undefined,
        });
      }

      // --check 模式：解析 findings
      const findings = [];
      for (const line of (outcome.stdout || "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const finding = parseFindingLine(trimmed);
        if (finding) findings.push(finding);
      }
      const counts = { total: findings.length, blocking: 0, advisory: findings.length };
      const status = findings.length > 0 ? "findings" : "clean";

      return runtime.envelope({
        ok: true,
        tool: TOOL_NAME,
        command: runtime.fmtCommand(command, ran.probe),
        exitCode: outcome.exitCode,
        status,
        env: { python: null, node: ran.probe },
        result: { findings },
        counts,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        sideEffects: [],
        notes: [
          findings.length > 0 ? `发现 ${findings.length} 处机械标点问题。` : "没有发现机械标点问题。",
          "本工具默认只读，不会改动文件；要落地修改请显式 fix=true（需审批）。",
          "em-dash 之类的破折号改写建议先按 check-ai-patterns 的语义建议手动处理，再用本工具兜底。",
        ],
      });
    },
  });
}
