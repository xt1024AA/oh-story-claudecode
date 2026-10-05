/**
 * 错误词汇表与错误对象构造。
 *
 * 验收标准要求「每条错误路径都有可读报错（不是裸 stack trace）」。可读 = 三件事都说到：
 * **错在哪（code）**、**为什么（message，人话）**、**下一步做什么（nextStep）**。
 * 所以错误对象固定三件套，任何一处新增错误都必须同时给出 nextStep —— 只报错不给下一步，
 * 模型只能瞎猜，等于把故障转嫁给作者。
 *
 * 码值一律 `UPPER_SNAKE`，与堆栈无关、可被测试断言、可被模型当作稳定标识。
 */

/** 错误码词汇表（新增码要连带写测试，见 scripts/test-tools.mjs）。 */
export const ERROR_CODES = {
  /** 参数不合法：必填缺失、类型不对、互相冲突。**在起子进程之前**就该拦住。 */
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  /** 路径不存在或不是期望的类型（应为目录的给了文件 / 反之）。 */
  PATH_NOT_FOUND: "PATH_NOT_FOUND",
  /** 随包脚本缺失：安装包被裁剪，或 skills 落点被覆盖。 */
  SCRIPT_MISSING: "SCRIPT_MISSING",
  /** python3 → python → py 探测链全失败（含 Microsoft Store 占位程序 exit 9009）。 */
  PYTHON_UNAVAILABLE: "PYTHON_UNAVAILABLE",
  /** Node 不可用（PATH 里没有 node，且宿主内置 Node 回退也被关掉/不可用）。 */
  NODE_UNAVAILABLE: "NODE_UNAVAILABLE",
  /** 子进程根本没起来（权限、路径怪字符、可执行位等）。 */
  SPAWN_FAILED: "SPAWN_FAILED",
  /** 超时被强杀：原脚本卡住（大项目 / 死循环 / 等 stdin）。 */
  TIMEOUT: "TIMEOUT",
  /** 调用方中止（exec.signal）。 */
  ABORTED: "ABORTED",
  /** 脚本跑了，但退出码不在本工具的语义集合里。 */
  EXIT_UNEXPECTED: "EXIT_UNEXPECTED",
  /** stdout 不是约定的「一行 JSON」，或 JSON 形状不对。 */
  OUTPUT_UNEXPECTED: "OUTPUT_UNEXPECTED",
  /** 破坏性动作被人工审批拒绝（终局：不许用 confirm 绕过）。 */
  APPROVAL_REJECTED: "APPROVAL_REJECTED",
  /** 破坏性动作需要审批，但既没有可用审批通道、调用方也没有显式确认。 */
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  /** 工具自身内部异常（本插件 bug），已兜住不抛裸栈。 */
  INTERNAL_ERROR: "INTERNAL_ERROR",
  /** `chapter commit` 不幂等：事务是按旧状态构造的。 */
  TRANSACTION_STALE: "TRANSACTION_STALE",
  /** 原脚本报告 node 缺失（storyctl 的 tool_unavailable）。 */
  TOOL_UNAVAILABLE: "TOOL_UNAVAILABLE",
};

/**
 * 构造错误对象。
 *
 * @param {string} code ERROR_CODES 里的码
 * @param {string} message 人话说明（说清「哪儿不对」，不带堆栈）
 * @param {string} nextStep 下一步动作（模型能照着执行的一句话）
 * @returns {{code: string, message: string, nextStep: string}}
 */
export function toolError(code, message, nextStep) {
  return {
    code: String(code),
    message: String(message),
    nextStep: String(nextStep),
  };
}

/** 从任意抛出物里取一句可读的话（绝不让 `[object Object]` 漏给模型）。 */
export function describeThrown(err) {
  if (err instanceof Error) return err.message || err.name || "未知错误";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * 把子进程的失败翻译成错误对象。
 *
 * 顺序要紧：spawn 失败 > 超时 > 中止 > 退出码。原因只有一个——先发生的先解释，
 * 否则「进程压根没起来」会被说成「退出码 -1 不合法」。
 *
 * @param {object} outcome runProcess 的返回
 * @returns {{code: string, message: string, nextStep: string}}
 */
export function errorFromProcess(outcome) {
  if (outcome?.spawnError) {
    const detail = outcome.spawnError.message || outcome.spawnError.code || "未知";
    return toolError(
      ERROR_CODES.SPAWN_FAILED,
      `子进程没能启动：${detail}`,
      "确认命令与参数里的路径存在、且当前用户有执行权限；把这条报错原文与 exec.command 一起报告给插件维护者。",
    );
  }
  if (outcome?.timedOut) {
    return toolError(
      ERROR_CODES.TIMEOUT,
      `原脚本在 ${outcome.timeoutMs} 毫秒内没有结束，已强制终止。`,
      "换更小的输入（单章 / 单文件）重试；若持续超时，用 oh_story_env 检查环境，并把这条报错报告给插件维护者。",
    );
  }
  if (outcome?.aborted) {
    return toolError(
      ERROR_CODES.ABORTED,
      "调用被中止（exec.signal），原脚本已被终止；本次的判定结果不可用。",
      "确认没有被其它操作打断后重跑同一条命令。",
    );
  }
  return toolError(
    ERROR_CODES.EXIT_UNEXPECTED,
    `原脚本以退出码 ${outcome?.exitCode} 结束，但本工具不认为该退出码属于预期语义。`,
    "读 stdout / stderr 原文定位原因；必要时直接手工跑信封里的等价命令。",
  );
}
