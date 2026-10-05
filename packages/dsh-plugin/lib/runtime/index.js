/**
 * runtime 装配：解释器探测、进程执行、脚本落点、审批、锁、路径归一，
 * 以及宿主服务访问（ctx.get）的**可选**封装。
 *
 * 为什么要有这一个文件：工具模块（lib/tools/*.js）不直接碰 `process` / `ctx`，
 * 只依赖 runtime 提供的窄接口。这样：
 *  - 生产（lib/index.js 的 apply）传真实依赖；
 *  - 测试（scripts/test-tools.mjs）传注入的 env / 假 ctx / 假审批，
 *    就能覆盖「Python 不可用」「审批被拒」等真实路径，而不用动宿主。
 *
 * 所有宿主服务访问都是可选的（optional lookup）：服务不存在时返回 null，
 * 由消费方（审批闸门等）决定怎么降级，而不是让整个插件激活失败。
 */

import { runProcess } from "./proc.js";
import { existsSync } from "node:fs";
import { createInterpreterProbe, detectHostNode } from "./interpreter.js";
import { resolveScripts, resolveSessionCwd, toAbsolute, assertPath, toPositiveInt } from "./paths.js";
import { requestApproval } from "./approval.js";
import { withPathLock, sha256File, snapshotDir, diffSnapshots, diffToSideEffects } from "./file-guard.js";
import { parseSingleLineJson } from "./script-json.js";
import { envelope, failEnvelope, renderEnvelope, ENVELOPE_SCHEMA } from "./envelope.js";
import { ERROR_CODES, toolError, describeThrown, errorFromProcess } from "./errors.js";

/** 脚本落点存在性预检：缺了就报 SCRIPT_MISSING（比让 spawn 报 ENOENT 更可读）。 */
function checkScript(scriptPath) {
  if (typeof scriptPath === "string" && scriptPath && !existsSync(scriptPath)) {
    return toolError(
      ERROR_CODES.SCRIPT_MISSING,
      `随包脚本缺失：${scriptPath}`,
      "安装包可能被裁剪；重新安装本插件，或确认 OH_STORY_SKILLS_DIR 覆盖（测试/排障用）指向包含完整 skills 的目录。",
    );
  }
  return null;
}

/**
 * 把命令里的 `{python}` / `{node}` 占位符替换成实际探测到的解释器标签，
 * 让信封的 command 字段真的是「可复现的等价命令」。
 */
export function fmtCommand(command, probe) {
  if (!command || !probe) return command ?? "";
  const label = probe.label || probe.bin || "";
  return String(command).replace(/\{python\}/g, label).replace(/\{node\}/g, label);
}

/**
 * 创建 runtime。
 *
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env] 环境变量（默认 process.env）
 * @param {object} [options.ctx] cordis ctx（宿主注入；测试可给假 ctx）
 * @param {object} [options.logger] ctx.logger 的等价物
 * @param {Function} [options.run] 进程执行器注入点（默认 runProcess）
 * @param {string} [options.skillsRoot] 覆盖随包 skills 根
 * @param {boolean} [options.allowHostNodeFallback] 是否允许宿主内置 Node 回退（默认 true）
 * @param {number} [options.timeoutMs] 子进程默认超时（默认 120000）
 * @returns {object} runtime
 */
export function createRuntime(options = {}) {
  const env = options.env ?? process.env;
  const ctx = options.ctx ?? null;
  const logger = options.logger ?? null;
  const timeoutMs = options.timeoutMs ?? 120000;
  const allowHostNodeFallback = options.allowHostNodeFallback ?? true;

  // 受限沙箱（禁止命名管道）下用临时文件传输子进程 stdout/stderr，
  // 与管道模式同语义，见 runtime/proc.js 头注。
  const fileStdio = String(env.OH_STORY_USE_FILE_STDIO ?? "").trim() === "1";
  const baseRun = options.run ?? runProcess;
  const run = (command, args, opts) => baseRun(command, args, fileStdio ? { ...(opts ?? {}), stdioToFiles: true } : opts);

  const { root: skillsRoot, scripts } = resolveScripts({
    env,
    skillsRoot: options.skillsRoot,
  });

  const interpreter = createInterpreterProbe({
    env,
    run,
    hostNode: allowHostNodeFallback ? detectHostNode() : null,
  });

  /** 日志三件套：有 logger 就转发，没有就静默。 */
  function log(level, ...args) {
    try {
      const fn = logger?.[level];
      if (typeof fn === "function") fn.call(logger, ...args);
    } catch {
      // 日志失败不影响工具结果
    }
  }

  /**
   * 取宿主服务（可选）。
   * @param {string} name 服务名（如 "approval"）
   * @returns {unknown|null}
   */
  function getService(name) {
    try {
      if (ctx && typeof ctx.get === "function") return ctx.get(name) ?? null;
      return null;
    } catch {
      return null;
    }
  }

  return {
    env,
    ctx,
    logger,
    run,
    timeoutMs,
    skillsRoot,
    scripts,

    log,
    getService,

    // ---- 解释器 ----
    probePython: (opts) => interpreter.probePython(opts),
    probeNode: (opts) => interpreter.probeNode(opts),
    pythonOk: () => interpreter.pythonOk(),
    nodeOk: () => interpreter.nodeOk(),

    // ---- 路径 ----
    resolveCwd: (exec) => resolveSessionCwd(exec),
    toAbsolute,
    assertPath,
    toPositiveInt,

    // ---- 子进程辅助 ----
    /** 用探测到的 Python 跑脚本；解释器不可用返回 {ok:false, probe, error}。 */
    async runPython(scriptPath, scriptArgs, opts = {}) {
      const probe = await interpreter.probePython();
      if (!probe.ok) {
        return {
          ok: false,
          probe,
          outcome: null,
          error: toolError(
            ERROR_CODES.PYTHON_UNAVAILABLE,
            probe.note || "Python 探测链失败，无法运行 Python 脚本。",
            "安装 Python 3 并确认 `python --version` 可用后重试；本机注意绕过 Microsoft Store 的 python3 占位程序。",
          ),
        };
      }
      const missing = checkScript(scriptPath);
      if (missing) return { ok: false, probe, outcome: null, error: missing };
      const outcome = await run(probe.bin, [...probe.prefixArgs, scriptPath, ...scriptArgs], {
        env: opts.env ?? env,
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? timeoutMs,
      });
      return { ok: true, probe, outcome, error: null };
    },

    /** 用探测到的 Node 跑脚本；解释器不可用返回 {ok:false, probe, error}。 */
    async runNode(scriptPath, scriptArgs, opts = {}) {
      const probe = await interpreter.probeNode();
      if (!probe.ok) {
        return {
          ok: false,
          probe,
          outcome: null,
          error: toolError(
            ERROR_CODES.NODE_UNAVAILABLE,
            probe.note || "Node 探测失败，无法运行 JS 检测脚本。",
            "安装 Node.js 18+ 并确认 `node --version` 可用后重试。",
          ),
        };
      }
      const missing = checkScript(scriptPath);
      if (missing) return { ok: false, probe, outcome: null, error: missing };
      const outcome = await run(probe.bin, [...probe.prefixArgs, scriptPath, ...scriptArgs], {
        env: { ...env, ...(probe.source === "host-fallback" ? probe.extraEnv ?? {} : {}) },
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? timeoutMs,
      });
      return { ok: true, probe, outcome, error: null };
    },

    // ---- 审批 ----
    /** 审批闸门：内部自己取 ctx.get("approval")（可空）。 */
    async approve(exec, spec) {
      const service = getService("approval");
      return requestApproval({ approvalService: service, exec }, spec);
    },

    // ---- 文件防护 ----
    withPathLock,
    sha256File,
    snapshotDir,
    diffSnapshots,
    diffToSideEffects,

    // ---- 协议解析 ----
    parseSingleLineJson,

    // ---- 信封 ----
    envelope,
    failEnvelope,
    renderEnvelope,
    ENVELOPE_SCHEMA,
    fmtCommand,
    ERROR_CODES,
    toolError,
    describeThrown,
    errorFromProcess,
  };
}
