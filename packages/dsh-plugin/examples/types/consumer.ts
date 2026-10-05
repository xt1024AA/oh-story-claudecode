/**
 * 类型声明的**编译期**冒烟（wayfinder #11）：本文件不运行，只用来让 `tsc` 校验
 * `lib/index.d.ts` 是不是「能被人用」的声明——名字对不对、必填字段齐不齐、降级路径通不通。
 *
 * 跑法（本机无 TS 工具链，用 npx 现拉一个；实测 tsc 5.9.3 通过）：
 *
 *   cd packages/dsh-plugin
 *   npx --yes -p typescript@5 tsc --noEmit --strict --target es2022 \
 *     --module nodenext --moduleResolution nodenext examples/types/consumer.ts
 *
 * 它同时是一条**契约检查**：下面 import 的名字必须与 `lib/index.js` 的真实导出一致。
 */

import { apply, inject, name } from "../../lib/index.js";
import type { ContentBlock, Envelope, HostContext, ToolDefinition, ToolDisposer } from "../../lib/index.js";

/** 1) 插件导出存在且名字正确。 */
export const pluginName: "dsh-oh-story-claudecode" = name;
export const requiredServices: readonly ["tools"] = inject;

/** 2) 最小宿主 ctx：只给 `tools` 也能装配（其余能力全部可选＝降级路径）。 */
const registered: ToolDefinition[] = [];
const minimalCtx: HostContext = {
  tools: {
    register(definition: ToolDefinition): ToolDisposer {
      registered.push(definition);
      return () => {
        registered.pop();
      };
    },
    get: (toolName) => registered.find((d) => d.name === toolName),
  },
};

/** 3) `effect` 的约定：回调**返回**清理函数（不是在回调里执行清理）。 */
const cleanupCtx: HostContext = {
  ...minimalCtx,
  effect: (callback) => callback(), // 立刻调用，返回值就是清理函数
};

/** 4) `apply` 两种签名都接受（config 可省）。 */
apply(minimalCtx);
apply(cleanupCtx, {});

/** 5) 信封：必填字段齐、可选字段可省、业务判定与调用成败分离。 */
export const blockedButOk: Envelope<{ status: string }> = {
  ok: true, // 拿到了有效业务结果
  tool: "oh_story_chapter_check",
  command: "python storyctl.py chapter check --project <书目录> --chapter 21",
  exitCode: 1,
  status: "blocked", // 业务判定（被 quality 拦截）
  env: { python: { ok: true } },
  counts: { blocking: 2, advisory: 1 },
  result: { status: "blocked" },
  stdout: "",
  stderr: "",
  sideEffects: [{ kind: "write", target: ".story/work/第021章/over_length_baseline.json", detail: "指纹留档" }],
  approval: { via: "approval", outcome: "allowed-once", detail: "作者在宿主里确认" },
  notes: ["status=blocked 是业务拦截，不是工具故障。"],
};

export const failedEnvelope: Envelope = {
  ok: false,
  tool: "oh_story_wordcount",
  command: "",
  exitCode: -1,
  status: "",
  env: {},
  stdout: "",
  stderr: "",
  sideEffects: [],
  error: { code: "PATH_NOT_FOUND", message: "书目录不存在。", nextStep: "确认路径后重试。" },
  notes: [],
};

/** 6) `render` 的返回形状。 */
export const blocks: ContentBlock[] = [
  { type: "text", text: `插件 ${pluginName} 已装载` },
];
