/**
 * 工具定义的公共构造与校验小工具。
 *
 * `makeTool` 是每个工具的唯一出口：它把 name/description/parameters/output/execute
 * 拼成宿主 `ctx.tools.register` 要的形状，并统一套上两件事：
 *  - 信封 schema + render（所有工具返回值同一副骨架，见 runtime/envelope.js）；
 *  - execute 兜底 catch：任何内部异常都收敛成 INTERNAL_ERROR 信封，绝不裸抛。
 *
 * 校验小工具的目标：**在起子进程之前**把参数错误拦下来（验收标准要求的
 * 「每条错误路径都有可读报错」的一半——另一半是脚本侧的错误，由各工具自己映射）。
 */

import { ENVELOPE_SCHEMA, renderEnvelope, failEnvelope } from "../runtime/envelope.js";
import { ERROR_CODES, toolError, describeThrown } from "../runtime/errors.js";

/**
 * 构造一个工具定义。
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.description
 * @param {object} spec.parameters 原始 JSON Schema（props 里写 description 给模型）
 * @param {(args: object, exec: object, runtime: object) => Promise<object>} spec.execute
 *   业务实现；返回信封对象（ok/fail 都可）。
 * @returns {object} 可直接交给 ctx.tools.register 的定义
 */
export function makeTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: ENVELOPE_SCHEMA,
      render: renderEnvelope,
    },
    async execute(args, exec) {
      const input = args && typeof args === "object" ? args : {};
      try {
        return await spec.execute(input, exec);
      } catch (err) {
        return failEnvelope({
          tool: spec.name,
          command: "",
          exitCode: -1,
          status: "",
          env: {},
          stdout: "",
          stderr: "",
          sideEffects: [],
          notes: [],
          error: toolError(
            ERROR_CODES.INTERNAL_ERROR,
            `工具内部异常：${describeThrown(err)}`,
            "把这条报错原文与调用参数报告给插件维护者。",
          ),
        });
      }
    },
  };
}

/** 从 args 取必填字符串参数；缺了就返回 INVALID_ARGUMENT 错误信封（字段失败时用）。 */
export function requiredString(args, name, tool) {
  const value = args[name];
  if (typeof value === "string" && value.trim() !== "") return { ok: true, value: value.trim() };
  return {
    ok: false,
    error: toolError(
      ERROR_CODES.INVALID_ARGUMENT,
      `参数 ${name} 必填且必须是非空字符串。`,
      `补上 ${name} 后重试。`,
    ),
  };
}

/** 校验文件参数存在。 */
export function existingFile(runtime, exec, args, name, label) {
  const cwd = runtime.resolveCwd(exec).cwd;
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    return {
      ok: false,
      error: toolError(
        ERROR_CODES.INVALID_ARGUMENT,
        `参数 ${name} 必填且必须是非空字符串。`,
        `补上 ${name} 后重试。`,
      ),
    };
  }
  const check = runtime.assertPath(value, cwd, { kind: "file", label: label ?? name });
  if (!check.ok) {
    return {
      ok: false,
      error: toolError(check.code, check.error, `确认 ${name} 指向存在的 ${label ?? "文件"}后重试。`),
    };
  }
  return { ok: true, path: check.path };
}

/** 校验目录参数存在。 */
export function existingDir(runtime, exec, args, name, label) {
  const cwd = runtime.resolveCwd(exec).cwd;
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    return {
      ok: false,
      error: toolError(
        ERROR_CODES.INVALID_ARGUMENT,
        `参数 ${name} 必填且必须是非空字符串。`,
        `补上 ${name} 后重试。`,
      ),
    };
  }
  const check = runtime.assertPath(value, cwd, { kind: "dir", label: label ?? name });
  if (!check.ok) {
    return {
      ok: false,
      error: toolError(check.code, check.error, `确认 ${name} 指向存在的 ${label ?? "目录"}后重试。`),
    };
  }
  return { ok: true, path: check.path };
}

/** 校验正整数参数（number 或数字字符串），可空。 */
export function optionalInt(args, name, { min = 1 } = {}) {
  if (args[name] === undefined || args[name] === null || args[name] === "") return { ok: true, value: null };
  const num = runtimeToInt(args[name]);
  if (num === null || num < min) {
    return {
      ok: false,
      error: toolError(
        ERROR_CODES.INVALID_ARGUMENT,
        `参数 ${name} 必须是 ≥${min} 的整数（收到：${JSON.stringify(args[name])}）。`,
        `把 ${name} 改成整数后重试。`,
      ),
    };
  }
  return { ok: true, value: num };
}

/** 把任意值安全转成整数；转不动返回 null。 */
function runtimeToInt(value) {
  const num = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(num) ? num : null;
}

/** 两个整数参数必须同给（min-chars / max-chars 的规矩）。 */
export function rangePair(args, { minName = "minChars", maxName = "maxChars" } = {}) {
  const hasMin = args[minName] !== undefined && args[minName] !== null && args[minName] !== "";
  const hasMax = args[maxName] !== undefined && args[maxName] !== null && args[maxName] !== "";
  if (!hasMin && !hasMax) return { ok: true, minChars: null, maxChars: null };
  if (hasMin !== hasMax) {
    return {
      ok: false,
      error: toolError(
        ERROR_CODES.INVALID_ARGUMENT,
        `参数 ${minName} 与 ${maxName} 必须同给同缺（不能只给一个）。`,
        `两个都补上或两个都去掉后重试。`,
      ),
    };
  }
  const lo = optionalInt(args, minName);
  if (!lo.ok) return { ok: false, error: lo.error };
  const hi = optionalInt(args, maxName);
  if (!hi.ok) return { ok: false, error: hi.error };
  if (lo.value !== null && hi.value !== null && lo.value > hi.value) {
    return {
      ok: false,
      error: toolError(
        ERROR_CODES.INVALID_ARGUMENT,
        `参数 ${minName} 不能大于 ${maxName}（收到 ${lo.value} > ${hi.value}）。`,
        `修正范围后重试。`,
      ),
    };
  }
  return { ok: true, minChars: lo.value, maxChars: hi.value };
}

/** 组装一条人类可读的等价命令（用于信封 command 字段）。 */
export function buildCommand(interpreterLabel, scriptPath, args) {
  const pieces = [interpreterLabel, scriptPath, ...args];
  // 把路径里的空格用引号包住，方便人工复制执行
  const quoted = pieces.map((p) => (/\s/.test(String(p)) ? `"${p}"` : String(p)));
  return quoted.join(" ");
}
