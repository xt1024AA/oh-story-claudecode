/**
 * 破坏性动作的人工审批闸门（决策 #12 的落地）。
 *
 * 语义（作者裁决，禁止私自放宽）：
 *
 * 1. **默认只读**：破坏性动作必须显式请求（`fixPunctuation: true` / `fix: true` /
 *    独立的 `commit` 工具名），模型不可能「顺手」触发。
 * 2. **人工审批**：破坏性动作走宿主审批服务（`ctx.approval`，服务名 `approval`）。
 *    `request()` 的结果只有 `allowed-once` 是放行；`rejected` 是**终局**，
 *    **任何参数（包括 confirm）都不许绕过**——人说了不算就是不算。
 * 3. **审批通道不可用时的回退**（#12 笔记原话：「若宿主侧该服务不可用，回退
 *    『显式参数 + 结果确认』并如实记录」）：`unavailable` / 服务缺失 / 调用抛错时，
 *    允许调用方显式带 `confirm: true` 放行，并在返回里如实标明走了回退通道
 *    （`via: "explicit-confirm"`），模型与作者都能看到这次不是人工审批。
 * 4. **fail closed**：没有审批通道、又没有 confirm，一律拒绝（APPROVAL_REQUIRED），
 *    绝不静默执行破坏性动作。
 */

/**
 * 执行审批闸门。
 *
 * @param {object} deps
 * @param {object|null} deps.approvalService  宿主审批服务（ctx.get("approval") 的结果，可能为 null）
 * @param {object} deps.exec                  工具 execute 的 exec（ToolRunContext）
 * @param {object} spec
 * @param {string} spec.toolName              工具名（写进审计日志）
 * @param {string} spec.reason                审批理由（作者能看到的人话，写进审计日志）
 * @param {boolean} spec.confirm              调用方是否带显式确认（回退通道用）
 * @returns {Promise<{granted: boolean, via: string, outcome: string, detail: string}>}
 */
export async function requestApproval(deps, spec) {
  const { approvalService, exec } = deps;
  const { toolName, reason, confirm } = spec;
  const agent = exec?.agent;

  const usable = approvalService && typeof approvalService.request === "function" && agent;
  if (usable) {
    let outcome;
    try {
      outcome = await approvalService.request({
        agent,
        toolName,
        callId: exec.callId,
        reason,
        signal: exec.signal,
      });
    } catch (err) {
      // 审批服务存在但调用失败（例如轮次边界之外）：按 unavailable 处理并回退。
      const detail = `宿主审批服务调用失败（${String(err?.message ?? err)}），按「通道不可用」回退处理。`;
      return fallbackToConfirm(confirm, detail);
    }

    if (outcome === "allowed-once") {
      return { granted: true, via: "approval", outcome: "allowed-once", detail: "人工审批已放行（本次一次性授权）。" };
    }
    if (outcome === "rejected") {
      // 终局：人拒绝就是拒绝，confirm 不许绕过（见文件头第 2 条）。
      return { granted: false, via: "approval", outcome: "rejected", detail: "审批被拒绝（rejected）：不要重试，也不要带 confirm 绕过；确实要做的话请作者在会话里明确指示后由作者自行发起。" };
    }
    if (outcome === "cancelled") {
      return { granted: false, via: "approval", outcome: "cancelled", detail: "审批被中止（cancelled，调用信号中止）。确认没有其它操作打断后重试。" };
    }
    // unavailable：没有应答者，fail closed，但允许显式确认回退。
    return fallbackToConfirm(confirm, "宿主审批通道不可用（unavailable，无应答者）；若作者已明确要求执行，可带 confirm: true 重试。");
  }

  // 没有审批服务 / 拿不到 agent：走显式确认回退。
  return fallbackToConfirm(confirm, "宿主审批服务不可用或无法定位当前 agent；破坏性动作必须由作者显式确认（confirm: true）才会执行。");
}

/** 回退通道：confirm 是真才放行，且 detail 说清这不是人工审批。 */
function fallbackToConfirm(confirm, reasonDetail) {
  if (confirm === true) {
    return { granted: true, via: "explicit-confirm", outcome: "explicit-confirm", detail: `${reasonDetail} 调用方已带 confirm: true，按显式确认放行（这是回退通道，不是人工审批）。` };
  }
  return {
    granted: false,
    via: "none",
    outcome: "unavailable",
    detail: `${reasonDetail} 且未带 confirm: true，拒绝执行（fail closed）。`,
  };
}
