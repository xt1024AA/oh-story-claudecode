/**
 * oh_story_env —— 环境与脚本落点诊断。
 *
 * 为什么要有这个工具：破坏性/业务工具只在调用时做解释器探测，模型在动手前
 * 需要一处能一次看清「本机 Python / Node 能不能跑、随包脚本在不在、探测链
 * 各候选到底什么状态」的只读入口（#12 要求「工具启动做 Python 探测并把结果
 * 报给模型」——本工具就是那个「报给模型」的集中位置）。
 *
 * 只读，不碰任何用户文件，永远 ok: true（它的「业务结果」就是诊断事实本身）。
 */

import { existsSync } from "node:fs";
import { makeTool } from "./_shared.js";

const TOOL_NAME = "oh_story_env";

/** 判断一个脚本是否存在（随包落点被覆盖/裁剪时这里直接可见）。 */
function scriptOk(runtime, key) {
  return existsSync(runtime.scripts[key]);
}

/**
 * @param {object} runtime
 * @returns {object} 工具定义
 */
export function createEnvTool(runtime) {
  return makeTool({
    name: TOOL_NAME,
    description:
      "检查 DSH 插件 dsh-oh-story-claudecode 的写作工具运行环境：Python 探测链（python3 → python → py -3，" +
      "会跳过 Microsoft Store 占位程序）与 Node（PATH 里的 node，必要时回退宿主内置 Node）各自是否可用、" +
      "版本号、每个候选的实测结果，以及随包脚本（storyctl / 三个检测器 / wordcount_core）是否就位。" +
      "只读，不读写任何用户文件。在其它写作工具报「Python/Node 不可用」或「脚本缺失」时，先用本工具定位。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        recheck: {
          type: "boolean",
          description: "默认 false：用缓存的上一次探测结果（快）。true：强制重新探测（环境可能刚装好解释器）。",
        },
      },
    },
    execute: async (args, exec) => {
      const force = args.recheck === true;
      const [python, node] = await Promise.all([
        runtime.probePython({ force }),
        runtime.probeNode({ force }),
      ]);

      const scriptChecks = Object.entries(runtime.scripts).map(([key, path]) => ({
        key,
        path,
        exists: existsSync(path),
      }));

      const result = {
        skillsRoot: runtime.skillsRoot,
        python,
        node,
        scripts: scriptChecks,
      };

      const notes = [];
      if (!python.ok) notes.push("Python 不可用：storyctl 与字数工具都无法运行。");
      if (!node.ok) notes.push("Node 不可用：三个检测器工具无法运行；storyctl 的 chapter 检查也会报 tool_unavailable。");
      const missing = scriptChecks.filter((s) => !s.exists).map((s) => s.key);
      if (missing.length > 0) notes.push(`随包脚本缺失：${missing.join("、")}（安装包可能被裁剪）。`);

      return runtime.envelope({
        ok: true,
        tool: TOOL_NAME,
        command: "",
        exitCode: 0,
        status: "",
        env: { python, node },
        result,
        stdout: "",
        stderr: "",
        sideEffects: [],
        notes,
      });
    },
  });
}
