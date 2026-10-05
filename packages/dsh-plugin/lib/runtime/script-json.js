/**
 * 解析原脚本 stdout 里的 JSON 协议。
 *
 * 契约（#3）：`storyctl.py` 的 stdout 恒为一行 UTF-8 JSON（`ensure_ascii=False` 直写
 * `sys.stdout.buffer`），末尾换行。检测器（check-ai-patterns / check-degeneration）
 * 的 `--json` 输出则是**多行缩进版** JSON（#3 实测：`{"findings": [...]}` 缩进式）。
 *
 * 所以解析策略分三档，从严格到宽容：
 *   1. 整段 stdout trim 后直接能解析成 JSON 对象 → 用它（覆盖单行与多行两种）；
 *   2. 从第一个 `{` 到最后一个 `}` 截取再解析 → 覆盖「JSON 前后有杂音行」；
 *   3. 逐行从后往前找能解析成对象的行 → 覆盖极端情况（多行输出、stderr 混入等）。
 *
 * 形状把关：解析出来的必须是对象（脚本的协议全是对象），否则算 OUTPUT_UNEXPECTED，
 * 由调用方把 stdout 原文一并带回，便于人工复现。
 */

/**
 * @param {string} stdout 原脚本 stdout 原文
 * @returns {{ok: true, value: object, line: string} | {ok: false, reason: string}}
 */
export function parseSingleLineJson(stdout) {
  const text = String(stdout ?? "");

  // 档 1：整段直接解析
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const value = JSON.parse(trimmed);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return { ok: true, value, line: trimmed };
      }
    } catch {
      // 继续下一档
    }
  }

  // 档 2：取第一个 { 到最后一个 } 的区间
  const firstOpen = text.indexOf("{");
  const lastClose = text.lastIndexOf("}");
  if (firstOpen >= 0 && lastClose > firstOpen) {
    const slice = text.slice(firstOpen, lastClose + 1);
    try {
      const value = JSON.parse(slice);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return { ok: true, value, line: slice };
      }
    } catch {
      // 继续下一档
    }
  }

  // 档 3：逐行从后往前找
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return { ok: true, value, line };
      }
    } catch {
      // 这一行不是合法 JSON，继续往前找
    }
  }

  return {
    ok: false,
    reason: `stdout 里没有找到可解析为 JSON 对象的片段（前 200 字符：${text.slice(0, 200)})`,
  };
}
