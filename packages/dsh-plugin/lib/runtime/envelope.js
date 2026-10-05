/**
 * 工具返回值的统一信封（envelope）。
 *
 * 为什么要有这一层：本插件的每个工具都是「在 Node 侧薄薄包一层原脚本」——
 * 参数校验、路径解析、结果整形都在这里做，业务判定始终由原脚本给出。
 * 于是所有工具天然共享同一副骨架：
 *
 *   { ok, tool, command, exitCode, status, env, result, stdout, stderr,
 *     sideEffects, approval, error, notes }
 *
 * 四点约定（写给以后改这里的人）：
 *
 * 1. **`ok` 的语义是「这次调用有没有拿到有效的业务结果」，不是「业务判定通过」**。
 *    例如 `chapter check` 返回 `status: blocked`（章节有 blocking 问题）时 `ok` 仍为
 *    true —— 脚本正常跑完并给出了判定，判定本身写在 `result.status` / `status` 里。
 *    `ok: false` 只留给工具故障：脚本缺失、解释器不可用、退出码落在语义之外、
 *    stdout 不是约定的 JSON、审批被拒、参数不合法。
 *
 * 2. **`result` 原样透传脚本的 JSON**，不在 Node 侧改写业务字段。Node 只做两件事：
 *    校验（该有的字段在不在）与整形（把 status/计数提到信封顶层方便模型先看）。
 *
 * 3. **`additionalProperties: false` + `required` 是硬约束**：宿主会用 `output.schema`
 *    校验返回值。改字段时三处必须一起改：本文件的 schema、下面两个构造函数、
 *    以及 `renderEnvelope`（否则模型看到的东西与 schema 脱节）。
 *
 * 4. **绝不抛裸异常**：工具 `execute` 的兜底永远是 `failEnvelope(内部错误)`，
 *    让模型看到一句人话而不是 stack trace（验收标准之一）。
 */

/** 业务结果 JSON 在 render 里的最大字符数：超过就截断，并明说截断了。 */
const RENDER_RESULT_CAP = 8000;

/** stdout / stderr 在信封里的最大字符数（原脚本偶尔会打很长的一行）。 */
const RENDER_STREAM_CAP = 4000;

/**
 * 信封的 JSON Schema（宿主 `ctx.tools.register({ output: { schema } })` 用它校验返回值）。
 *
 * 可选字段（result / error / approval）不进 `required`：没有就不出现，
 * 这样两种失败形态（工具故障 vs 业务判定）在 schema 上就是可区分的。
 */
export const ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: {
      type: "boolean",
      description: "本次调用是否拿到了有效的业务结果（不是业务判定是否通过）",
    },
    tool: { type: "string", description: "工具名" },
    command: { type: "string", description: "与本次调用等价的命令行（便于人工复核/复现）" },
    exitCode: { type: "integer", description: "原脚本退出码；进程没起来是 -1" },
    status: { type: "string", description: "业务状态词；没有就为空串" },
    env: { type: "object", description: "本次用到的解释器探测结果（python / node）" },
    counts: { type: "object", description: "Node 侧从业务结果里派生的计数（检测器的 blocking/advisory 等），不影响 result 原样透传" },
    result: { type: "object", description: "原脚本 stdout 里那行 JSON，原样透传" },
    stdout: { type: "string", description: "stdout 原文（已按上限截断）" },
    stderr: { type: "string", description: "stderr 原文（已按上限截断）" },
    sideEffects: {
      type: "array",
      description: "本次调用对用户文件的实际落盘影响（逐条如实记录，没有就是空数组）",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          target: { type: "string" },
          detail: { type: "string" },
        },
        required: ["kind", "target", "detail"],
      },
    },
    approval: {
      type: "object",
      description: "破坏性动作的审批结果",
      additionalProperties: false,
      properties: {
        via: { type: "string", description: "approval（宿主人工审批）/ explicit-confirm（审批通道不可用时的显式确认回退）" },
        outcome: { type: "string", description: "allowed-once / rejected / cancelled / unavailable / explicit-confirm" },
        detail: { type: "string" },
      },
      required: ["via", "outcome", "detail"],
    },
    error: {
      type: "object",
      description: "工具故障（ok=false 时才有）",
      additionalProperties: false,
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        nextStep: { type: "string" },
      },
      required: ["code", "message", "nextStep"],
    },
    notes: {
      type: "array",
      description: "给模型的补充说明（业务含义、注意事项）",
      items: { type: "string" },
    },
  },
  required: ["ok", "tool", "command", "exitCode", "status", "env", "stdout", "stderr", "sideEffects", "notes"],
};

/** 截断一段文本并留下痕迹（截了就说截了，不静默丢）。 */
function cap(text, limit) {
  const value = typeof text === "string" ? text : "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断，原文 ${value.length} 字符）`;
}

/**
 * 构造一个成功/业务结果信封。
 *
 * @param {object} fields 见 ENVELOPE_SCHEMA 的字段；未给的用中性默认值补齐
 * @returns {object} 通过 ENVELOPE_SCHEMA 校验的对象
 */
export function envelope(fields) {
  const value = {
    ok: fields.ok === true,
    tool: String(fields.tool ?? ""),
    command: String(fields.command ?? ""),
    exitCode: Number.isInteger(fields.exitCode) ? fields.exitCode : -1,
    status: String(fields.status ?? ""),
    env: fields.env && typeof fields.env === "object" ? fields.env : {},
    stdout: cap(fields.stdout, RENDER_STREAM_CAP),
    stderr: cap(fields.stderr, RENDER_STREAM_CAP),
    sideEffects: Array.isArray(fields.sideEffects) ? fields.sideEffects : [],
    notes: Array.isArray(fields.notes) ? fields.notes.map(String) : [],
  };
  if (fields.result && typeof fields.result === "object") value.result = fields.result;
  if (fields.counts && typeof fields.counts === "object") value.counts = fields.counts;
  if (fields.approval && typeof fields.approval === "object") value.approval = fields.approval;
  if (fields.error && typeof fields.error === "object") value.error = fields.error;
  return value;
}

/**
 * 构造一个工具故障信封。`error` 三件套必填：模型据此决定下一步，缺一不可。
 *
 * @param {object} fields 至少给 tool / command / error
 */
export function failEnvelope(fields) {
  return envelope({ ...fields, ok: false });
}

/** 把 sideEffects 数组渲染成一行行的文本。 */
function renderSideEffects(sideEffects) {
  const lines = [];
  for (const item of sideEffects) {
    const kind = item?.kind ?? "change";
    lines.push(`  - [${kind}] ${item?.target ?? ""}：${item?.detail ?? ""}`);
  }
  return lines;
}

/**
 * 信封的 render：把结构化结果摊成模型可读的文本。
 *
 * 为什么 render 不能省：宿主交给模型的是 render 的产物，不是 `result` 对象本身。
 * 所以「模型要能照着做下一步」的信息（错误码、下一步、审批结果、副作用）必须在这里出现。
 *
 * @param {unknown} _args 调用参数（未使用，保留宿主签名）
 * @param {object} value  execute 返回的信封
 * @returns {Array<{type: string, text: string}>} 内容块
 */
export function renderEnvelope(_args, value) {
  const v = value ?? {};
  const lines = [];
  lines.push(`${v.ok ? "OK" : "FAILED"} ${v.tool ?? ""}${v.status ? `（status: ${v.status}）` : ""}`);
  if (v.command) lines.push(`等价命令：${v.command}`);
  lines.push(`退出码：${v.exitCode ?? -1}`);

  if (v.approval) {
    const via = v.approval.via === "approval" ? "宿主人工审批" : "显式确认（审批通道不可用时的回退）";
    lines.push(`审批：${via} / ${v.approval.outcome}${v.approval.detail ? ` —— ${v.approval.detail}` : ""}`);
  }

  if (v.error) {
    lines.push(`错误码：${v.error.code}`);
    lines.push(`说明：${v.error.message}`);
    if (v.error.nextStep) lines.push(`下一步：${v.error.nextStep}`);
  }

  if (v.counts && typeof v.counts === "object") {
    const counts = Object.entries(v.counts)
      .filter(([, n]) => Number(n) > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join("，");
    if (counts) lines.push(`计数：${counts}`);
  }

  if (Array.isArray(v.notes) && v.notes.length > 0) {
    lines.push("提示：");
    for (const note of v.notes) lines.push(`  - ${note}`);
  }

  if (Array.isArray(v.sideEffects) && v.sideEffects.length > 0) {
    lines.push("落盘副作用：");
    lines.push(...renderSideEffects(v.sideEffects));
  } else if (v.ok) {
    lines.push("落盘副作用：无");
  }

  if (v.result && typeof v.result === "object") {
    lines.push("业务结果（JSON）：");
    lines.push(cap(JSON.stringify(v.result, null, 2), RENDER_RESULT_CAP));
  }

  if (v.stderr) lines.push(`stderr：\n${v.stderr}`);
  if (v.stdout && !v.result) lines.push(`stdout：\n${v.stdout}`);

  return [{ type: "text", text: lines.join("\n") }];
}

/** 立刻可用的 render 片段：给不套信封的内部诊断用的纯文本 render。 */
export function textRender(text) {
  return [{ type: "text", text }];
}
