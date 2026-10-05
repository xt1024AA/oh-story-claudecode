/**
 * dsh-oh-story-claudecode —— DSH 插件装配入口（wayfinder #8 落地）。
 *
 * 这份文件只做装配：建 runtime、注册全部工具、挂随包 skills。
 * 业务逻辑全部在 lib/tools/*.js 与 lib/runtime/*.js 里，这里不写判定。
 *
 * 工具面（#8 验收，命名对齐 DSH 生态习惯，`oh_story_*` 前缀）：
 *
 *   | 工具 | 只读/破坏性 | 说明 |
 *   | --- | --- | --- |
 *   | oh_story_env | 只读 | Python/Node 探测链 + 随包脚本落点诊断 |
 *   | oh_story_wordcount | 只读 | 字数口径 visible_chars_v1（measure/check/checkpoint） |
 *   | oh_story_chapter_check | 默认只读；fixPunctuation=true 破坏性（审批） | storyctl chapter check |
 *   | oh_story_chapter_commit | 破坏性（独立工具名 + 审批） | storyctl chapter commit，含不幂等失败引导 |
 *   | oh_story_ai_patterns_check | 只读 | check-ai-patterns.js |
 *   | oh_story_degeneration_check | 只读 | check-degeneration.js |
 *   | oh_story_punctuation_normalize | 默认只读；fix=true 破坏性（审批） | normalize-punctuation.js |
 *   | oh_story_probe | 只读 | #5 探针（保留：装机自检用） |
 *
 * 规范依据（docs/research/dsh-plugin-spec.md）与安全语义（#12，笔记
 * .agents/notes/proposed/architecture/2026-10-04-dsh-plugin-tool-safety-semantics.md）：
 * - 工具注册：`ctx.tools.register(definition): () => void`，`output` 必填（§3.1/§3.3）；
 * - `parameters` 是原始 JSON Schema（不是 zod/schemastery）；
 * - 破坏性动作：默认只读 + 显式开关 + 人工审批（`ctx.approval.request`），
 *   审批通道不可用时回退显式 confirm（见 lib/runtime/approval.js）；
 * - 随包 skills：`bundledSkillDir` + `@deepseek-ai/dsh-skill-filesystem`，rank 600（§4.1）。
 *
 * 开发循环铁律（地图 Notes 实测）：改动本文件 / 任何 lib 模块后**必须重启 DSH**
 * 才生效——运行中进程缓存已加载的 JS 模块，HMR 只热加新条目、不热换已有模块。
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./runtime/index.js";
import { createEnvTool } from "./tools/env.js";
import { createWordcountTool } from "./tools/wordcount.js";
import { createChapterCheckTool } from "./tools/chapter-check.js";
import { createChapterCommitTool } from "./tools/chapter-commit.js";
import { createAiPatternsTool } from "./tools/ai-patterns.js";
import { createDegenerationTool } from "./tools/degeneration.js";
import { createPunctuationTool } from "./tools/punctuation.js";

/** 插件行名。必须与 cordis.patch.yml 里的 id / name 以及包名一致。 */
export const name = "dsh-oh-story-claudecode";

/** 工具注册是硬依赖：装配时若缺少 tools 服务，本插件不激活（§3.1 的「硬依赖」写法）。 */
export const inject = ["tools"];

const TAG = "[dsh-oh-story-claudecode]";
/** 与 package.json 的 version 保持一致（#8 起 0.2.0，工具面落地）。 */
const VERSION = "0.2.0";

/** 随包 skills 根目录：与 lib/ 同级。用 import.meta.url 解析，保证插件被装到别处也能读。 */
const BUNDLED_SKILL_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

/**
 * skills 挂载的**可观测状态**（#5 的探针设计保留）：
 * 宿主日志不落盘，于是「skill 没被发现」分不清是「提供方没挂上」还是「会话快照早于安装」。
 * 把挂载结果做成工具输出的一部分，调一次就能拿到确定答案。
 */
const skillsMount = {
  attempted: false,
  ok: false,
  provider: "oh-story-bundled",
  detail: "尚未尝试挂载",
};

/** #5 探针工具定义：只报告事实，不读写任何用户文件。保留它让装机自检有稳定入口。 */
const PROBE_TOOL = {
  name: "oh_story_probe",
  description:
    "装机探针：返回 DSH 插件 dsh-oh-story-claudecode 的装载事实（插件名、版本、随包 skills 目录是否就位、" +
    "随包 skills 是否挂载成功、以及调用方传入的回显字符串）。仅用于验证插件通路，不读写用户任何文件。" +
    "环境与脚本健康度请用 oh_story_env。",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      echo: {
        type: "string",
        description: "可选回显字符串。传什么就原样返回什么，用来确认参数真的透传到了 execute。",
      },
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        plugin: { type: "string" },
        version: { type: "string" },
        bundledSkillDir: { type: "string" },
        bundledSkillDirExists: { type: "boolean" },
        skillsMountAttempted: { type: "boolean" },
        skillsMounted: { type: "boolean" },
        skillsProvider: { type: "string" },
        skillsMountDetail: { type: "string" },
        echo: { type: "string" },
        note: { type: "string" },
      },
      required: [
        "ok",
        "plugin",
        "version",
        "bundledSkillDir",
        "bundledSkillDirExists",
        "skillsMountAttempted",
        "skillsMounted",
        "skillsProvider",
        "skillsMountDetail",
      ],
    },
    render: (_args, value) => [
      {
        type: "text",
        text:
          `插件 ${value.plugin} v${value.version} 已装载。\n` +
          `随包 skills 目录：${value.bundledSkillDir}（${value.bundledSkillDirExists ? "就位" : "缺失"}）\n` +
          `随包 skills 挂载：${value.skillsMounted ? "成功" : "未成功"}（提供方 ${value.skillsProvider}）\n` +
          `细节：${value.skillsMountDetail}\n` +
          (value.echo === undefined ? "" : `回显：${value.echo}\n`) +
          (value.note ?? ""),
      },
    ],
  },
  async execute(args) {
    return {
      ok: true,
      plugin: name,
      version: VERSION,
      bundledSkillDir: BUNDLED_SKILL_DIR,
      bundledSkillDirExists: existsSync(BUNDLED_SKILL_DIR),
      skillsMountAttempted: skillsMount.attempted,
      skillsMounted: skillsMount.ok,
      skillsProvider: skillsMount.provider,
      skillsMountDetail: skillsMount.detail,
      echo: args?.echo,
      note: "写作工具（oh_story_* 系列）已随 #8 落地；先跑 oh_story_env 看环境。",
    };
  },
};

/** 注册探针工具（#5 原样，保留）。 */
function registerProbeTool(ctx) {
  if (typeof ctx.tools?.register !== "function") {
    ctx.logger?.warn?.(`${TAG} 探针工具未注册：ctx.tools.register 不可用（宿主版本不符？）`);
    return false;
  }
  const off = ctx.tools.register({
    name: PROBE_TOOL.name,
    description: PROBE_TOOL.description,
    parameters: structuredClone(PROBE_TOOL.parameters),
    output: PROBE_TOOL.output,
    execute: (args) => PROBE_TOOL.execute(args ?? {}),
  });
  if (typeof ctx.effect === "function" && typeof off === "function") {
    ctx.effect(() => off);
  }
  ctx.logger?.info?.(`${TAG} 已注册探针工具 ${PROBE_TOOL.name}`);
  return true;
}

/**
 * 注册全部写作工具。
 *
 * 每个工具都用 `structuredClone` 深拷贝参数表（与官方大插件 dsh-scriptor 的做法一致），
 * 避免工具注册表反过来改到模块常量。disposer 逐个收集，走 `ctx.effect` 在卸载时逆序释放。
 *
 * @param {object} ctx
 * @param {object} runtime createRuntime 的产物
 * @returns {number} 注册成功的工具数
 */
function registerTools(ctx, runtime) {
  if (typeof ctx.tools?.register !== "function") {
    ctx.logger?.warn?.(`${TAG} 写作工具未注册：ctx.tools.register 不可用（宿主版本不符？）`);
    return 0;
  }

  const factories = [
    createEnvTool(runtime),
    createWordcountTool(runtime),
    createChapterCheckTool(runtime),
    createChapterCommitTool(runtime),
    createAiPatternsTool(runtime),
    createDegenerationTool(runtime),
    createPunctuationTool(runtime),
  ];

  const disposers = [];
  let count = 0;
  for (const def of factories) {
    try {
      const off = ctx.tools.register({
        name: def.name,
        description: def.description,
        parameters: structuredClone(def.parameters),
        output: def.output,
        execute: (args, exec) => def.execute(args, exec),
      });
      if (typeof off === "function") disposers.push(off);
      count += 1;
      ctx.logger?.info?.(`${TAG} 已注册工具 ${def.name}`);
    } catch (err) {
      ctx.logger?.warn?.(`${TAG} 工具 ${def.name} 注册失败：${err?.message ?? err}`);
    }
  }

  if (disposers.length > 0 && typeof ctx.effect === "function") {
    ctx.effect(() => {
      for (const off of disposers.reverse()) {
        try {
          off();
        } catch {
          // 单个 disposer 失败不影响其它清理
        }
      }
    });
  }

  ctx.logger?.info?.(`${TAG} 写作工具注册完成：${count}/${factories.length}`);
  return count;
}

/**
 * 挂载随包 skills（#5 的设计保留，见头注）。
 * 动态 import 隔离失败：skills 这一半出问题不影响工具注册。
 */
async function mountBundledSkills(ctx) {
  skillsMount.attempted = true;

  if (!existsSync(BUNDLED_SKILL_DIR)) {
    skillsMount.detail = `安装包里缺少 skills 目录 ${BUNDLED_SKILL_DIR}`;
    ctx.logger?.warn?.(`${TAG} 随包技能未挂载：${skillsMount.detail}`);
    return;
  }

  let skillFilesystem;
  try {
    skillFilesystem = await import("@deepseek-ai/dsh-skill-filesystem");
  } catch (err) {
    skillsMount.detail = `无法解析 @deepseek-ai/dsh-skill-filesystem —— ${err?.message ?? err}`;
    ctx.logger?.warn?.(`${TAG} 随包技能未挂载：${skillsMount.detail}`);
    return;
  }

  if (typeof ctx.inject !== "function" || typeof ctx.plugin !== "function") {
    skillsMount.detail = "宿主缺少 inject/plugin 能力，请核对 DSH 版本";
    ctx.logger?.warn?.(`${TAG} 随包技能未挂载：${skillsMount.detail}`);
    return;
  }

  try {
    ctx.inject(["skills"], (scope) => {
      scope.plugin(skillFilesystem, {
        providerName: skillsMount.provider,
        includeDefaultRoots: false,
        bundledSkillDir: BUNDLED_SKILL_DIR,
      });
      skillsMount.ok = true;
      skillsMount.detail = `已登记提供方 ${skillsMount.provider}，根目录 ${BUNDLED_SKILL_DIR}（rank 600）`;
      ctx.logger?.info?.(`${TAG} 随包技能已挂载：${BUNDLED_SKILL_DIR}`);
    });
  } catch (err) {
    skillsMount.detail = `inject/plugin 挂载抛错 —— ${err?.message ?? err}`;
    ctx.logger?.warn?.(`${TAG} 随包技能未挂载：${skillsMount.detail}`);
  }
}

/**
 * cordis 插件入口（§2.4 第一种形态：`export function apply`）。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} _config 来自 cordis.patch.yml 中该条目的 config（未声明 Config，不使用）
 */
export function apply(ctx, _config) {
  ctx.logger?.info?.(`${TAG} 插件已加载（v${VERSION}）`);

  const runtime = createRuntime({ ctx, logger: ctx.logger });

  registerProbeTool(ctx);
  registerTools(ctx, runtime);

  // 刻意不 await：装配不应该因为 skills 这一半慢或失败而卡住。
  mountBundledSkills(ctx).catch((err) => {
    skillsMount.detail = `随包技能挂载异常 —— ${err?.message ?? err}`;
    ctx.logger?.warn?.(`${TAG} ${skillsMount.detail}`);
  });
}
