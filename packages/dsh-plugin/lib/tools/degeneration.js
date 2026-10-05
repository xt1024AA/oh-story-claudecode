/**
 * oh_story_degeneration_check —— check-degeneration.js 的只读封装。
 *
 * 「退化信号扫描」：复读（verbatim-repeat）、截断（truncated）、占位拒绝语
 * （placeholder-leak）、工程词泄漏（meta-leak，细纲/字数等写作流水线术语）。
 * 只报告不改写；exit 1 = 有发现（业务结果，不是故障）。
 */

import { createDetectorTool } from "./_detector.js";

const TOOL_NAME = "oh_story_degeneration_check";

/**
 * @param {object} runtime
 * @returns {object} 工具定义
 */
export function createDegenerationTool(runtime) {
  return createDetectorTool(runtime, {
    name: TOOL_NAME,
    description:
      "退化信号扫描（check-degeneration.js --check --json）：检出模型打转（逐句/逐行复读）、正文被截断、" +
      "生成拒绝语/占位符泄漏、写作流水线工程词（细纲、字数等）泄漏进正文。只报告不改写。" +
      "result.findings 每项含 file/line/column/type/severity/message/excerpt。" +
      "status=clean 表示无发现；status=findings 表示有发现（exit 1，属业务结果）。" +
      "退化信号通常改不掉，应回去重新生成那一段再 deslop，而不是就地修补。",
    scriptKey: "degeneration",
    defaultFailOn: "all",
    extraNotes: [
      "blocking 级退化（复读/截断/占位拒绝语/tier1 工程词）是强信号：先去重写那一段，再复扫。",
      "tier2 章节词与引号内的 tier1 是 advisory 级，结合上下文判断。",
    ],
  });
}
