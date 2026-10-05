/**
 * oh_story_ai_patterns_check —— check-ai-patterns.js 的只读封装。
 *
 * 「AI 味句式扫描」：blocking 级是确定性句式（em-dash、not-is-comparison、
 * negation-parade、trailer-ending 等），advisory 级是套词密度等。
 * 只报告不改写；exit 1 = 有发现（业务结果，不是故障）。
 */

import { createDetectorTool } from "./_detector.js";

const TOOL_NAME = "oh_story_ai_patterns_check";

/**
 * @param {object} runtime
 * @returns {object} 工具定义
 */
export function createAiPatternsTool(runtime) {
  return createDetectorTool(runtime, {
    name: TOOL_NAME,
    description:
      "AI 味句式扫描（check-ai-patterns.js --check --json）：对正文文件检出确定性 AI 句式" +
      "（em-dash 破折号、not-is-comparison、negation-parade、trailer-ending 等，blocking 级）与套词密度" +
      "（advisory 级）。只报告不改写。result.findings 每项含 file/line/column/type/severity/message/excerpt。" +
      "status=clean 表示无发现；status=findings 表示有发现（exit 1，属业务结果）。用于写作后的 AI 味预检与收尾复扫。",
    scriptKey: "aiPatterns",
    defaultFailOn: "blocking",
    extraNotes: [
      "blocking 级句式应先改正文再复扫；advisory 级（套词密度）先通读全文判断。",
      "扫描会读书内白名单 .deslop-whitelist（正文/ 下时取父目录的父目录，否则取文件所在目录）。",
    ],
  });
}
