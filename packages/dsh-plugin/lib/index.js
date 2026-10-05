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
 *
 * 装配三条硬规矩（#9 真机事故换来的，改这里之前先读）：
 *
 * 1. **`ctx.effect(callback)` 会立刻调用 callback，并把它的返回值当清理函数**（Cordis 约定：
 *    "Register every resource inside apply with ctx.effect or ctx.on and **return** its cleanup"）。
 *    所以写法必须是 `ctx.effect(() => () => 清理())`；写成 `ctx.effect(() => { 清理() })`
 *    会在**注册当刻**就把刚注册的工具全部注销——而 `register()` 全程返回成功、日志照样写
 *    「8/8」，真机上只剩下不在 effect 里的那个探针。见 registerTools() 里的注释。
 * 2. **`register()` 成功 ≠ 工具留在工具面上**。判断只能回读注册表（`oh_story_probe` 的
 *    `toolSurface` 字段就是干这个的：调一次就知道此刻在册几个）。
 * 3. **任一工具工厂抛错不许拖垮其余**：工厂构造与注册各自独立 try/catch，失败的记进
 *    `toolSurface.failures`（宿主日志不落盘，只靠日志排查等于没有证据）。
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
/** 与 package.json 的 version 保持一致（0.2.1 起：修 #9 真机「7 个写作工具注册即注销」）。 */
const VERSION = "0.2.1";

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

/**
 * 工具面装配的**可观测状态**（#9 的教训）：
 * `ctx.tools.register()` 返回成功，并不意味着工具真的留在了工具面上——真机实测过
 * 「7 个写作工具注册后立刻被自己的 disposer 注销，日志却写 8/8」这一种失败。
 * 于是这里只记装配期事实（注册了几个、谁抛错了），**此刻在册几个要在调用时回读注册表**
 * 才作数（见 toolSurfaceSnapshot）。
 */
const toolRegistration = {
  /** 尝试装配的工具名（按装配顺序）。 */
  names: [],
  /** 注册调用返回成功、且拿到 disposer 的名字。 */
  registered: [],
  /** 装配期失败：{ tool, stage: "factory" | "register", message }。 */
  failures: [],
};

/** 记一条装配失败（探针会原样带回给模型，避免「日志没落盘 = 没证据」）。 */
function recordToolFailure(tool, stage, err) {
  toolRegistration.failures.push({
    tool,
    stage,
    message: err?.message ? String(err.message) : String(err),
  });
}

/**
 * 清空装配记账——每次 `apply` 只记「这一次装配」的事实。
 * 宿主 HMR 重新 apply 同一个插件（或测试里多次 apply）时，旧记账不能累加到新一次上。
 */
function resetToolRegistration() {
  toolRegistration.names = [];
  toolRegistration.registered = [];
  toolRegistration.failures = [];
}

/**
 * 回读宿主注册表：**此刻**这些工具还有几个在册。
 *
 * 为什么必须回读而不是信 `register()` 的返回值：注册与注销是两件事，中间可能隔着
 * 自己的 disposer（#9 踩的就是这个）。`ctx.tools.get` 不在宿主契约里时返回
 * `apiAvailable: false`，此时只能报告「无法核实」，不假装知道。
 *
 * @param {object} ctx cordis 上下文（探针在 execute 时闭包持有）
 * @returns {{apiAvailable: boolean, visible: number, missing: string[]}}
 */
function toolSurfaceSnapshot(ctx) {
  const names = toolRegistration.names;
  const get = ctx?.tools?.get;
  if (typeof get !== "function") {
    return { apiAvailable: false, visible: -1, missing: [] };
  }
  const missing = [];
  for (const name of names) {
    let found;
    try {
      found = get.call(ctx.tools, name);
    } catch {
      return { apiAvailable: false, visible: -1, missing: [] };
    }
    if (found === undefined || found === null) missing.push(name);
  }
  return { apiAvailable: true, visible: names.length - missing.length, missing };
}

/** 探针输出 schema：与下面的 execute 返回值一一对应（宿主按这个 schema 校验）。 */
const PROBE_OUTPUT_SCHEMA = {
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
    toolSurface: {
      type: "object",
      description: "本次装配的工具面事实：注册了几个、此刻回读还在册几个、谁装配失败了",
      additionalProperties: false,
      properties: {
        attempted: { type: "integer", description: "尝试装配的工具数" },
        registered: { type: "integer", description: "register() 返回成功的工具数" },
        visibleAtCall: { type: "integer", description: "此刻回读注册表仍在册的工具数；宿主不提供 get 时为 -1" },
        registryReadable: { type: "boolean", description: "宿主 ctx.tools.get 是否可用于回读（false 时 visibleAtCall 恒为 -1）" },
        missing: { type: "array", description: "已注册但此刻不在册的工具名（注册即注销会出现在这里）", items: { type: "string" } },
        failures: {
          type: "array",
          description: "装配期失败（工厂构造或注册）",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              tool: { type: "string" },
              stage: { type: "string" },
              message: { type: "string" },
            },
            required: ["tool", "stage", "message"],
          },
        },
      },
      required: ["attempted", "registered", "visibleAtCall", "registryReadable", "missing", "failures"],
    },
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
    "toolSurface",
  ],
};

/**
 * #5 探针工具定义：只报告事实，不读写任何用户文件。保留它让装机自检有稳定入口。
 *
 * 为什么是个工厂（#9 起）：`toolSurface` 要在**调用时**回读宿主注册表，
 * 所以 execute 必须闭包持有 ctx——模块级常量拿不到。原则没有变：只报事实。
 *
 * @param {object} ctx cordis 上下文
 * @returns {object} 工具定义
 */
function createProbeTool(ctx) {
  return {
    name: "oh_story_probe",
    description:
      "装机探针：返回 DSH 插件 dsh-oh-story-claudecode 的装载事实（插件名、版本、随包 skills 目录是否就位、" +
      "随包 skills 是否挂载成功、工具面此刻在册几个、以及调用方传入的回显字符串）。仅用于验证插件通路，不读写用户任何文件。" +
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
      schema: PROBE_OUTPUT_SCHEMA,
      render: (_args, value) => [
        {
          type: "text",
          text:
            `插件 ${value.plugin} v${value.version} 已装载。\n` +
            `随包 skills 目录：${value.bundledSkillDir}（${value.bundledSkillDirExists ? "就位" : "缺失"}）\n` +
            `随包 skills 挂载：${value.skillsMounted ? "成功" : "未成功"}（提供方 ${value.skillsProvider}）\n` +
            `细节：${value.skillsMountDetail}\n` +
            `工具面：装配 ${value.toolSurface.attempted} 个 / register 成功 ${value.toolSurface.registered} 个 / ` +
            `此刻在册 ${value.toolSurface.registryReadable ? `${value.toolSurface.visibleAtCall} 个` : "（宿主不支持回读）"}\n` +
            renderToolFailures(value.toolSurface) +
            (value.echo === undefined ? "" : `回显：${value.echo}\n`) +
            (value.note ?? ""),
        },
      ],
    },
    async execute(args) {
      const snapshot = toolSurfaceSnapshot(ctx);
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
        toolSurface: {
          attempted: toolRegistration.names.length,
          registered: toolRegistration.registered.length,
          visibleAtCall: snapshot.visible,
          registryReadable: snapshot.apiAvailable,
          missing: snapshot.missing,
          failures: toolRegistration.failures,
        },
        echo: args?.echo,
        note: "写作工具（oh_story_* 系列）已随 #8 落地；先跑 oh_story_env 看环境。",
      };
    },
  };
}

/** 把装配失败渲染成模型可读的一行行（没有失败就不出现）。 */
function renderToolFailures(toolSurface) {
  const lines = [];
  if (toolSurface.missing.length > 0) {
    lines.push(`⚠️ 已注册但此刻不在册：${toolSurface.missing.join("、")}（注册后又被注销，查 ctx.effect 用法）\n`);
  }
  if (toolSurface.failures.length > 0) {
    lines.push(`⚠️ 装配失败 ${toolSurface.failures.length} 项：\n`);
    for (const f of toolSurface.failures) {
      lines.push(`  - [${f.stage}] ${f.tool}：${f.message}\n`);
    }
  }
  return lines.join("");
}

/** 注册探针工具（#5 的探针，返回事实）。 */
function registerProbeTool(ctx) {
  const tool = createProbeTool(ctx);
  toolRegistration.names.push(tool.name);
  if (typeof ctx.tools?.register !== "function") {
    recordToolFailure(tool.name, "register", new Error("ctx.tools.register 不可用（宿主版本不符？）"));
    ctx.logger?.warn?.(`${TAG} 探针工具未注册：ctx.tools.register 不可用（宿主版本不符？）`);
    return false;
  }
  let off;
  try {
    off = ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.parameters),
      output: tool.output,
      execute: (args) => tool.execute(args ?? {}),
    });
  } catch (err) {
    recordToolFailure(tool.name, "register", err);
    ctx.logger?.warn?.(`${TAG} 探针工具注册失败：${err?.message ?? err}`);
    return false;
  }
  toolRegistration.registered.push(tool.name);
  // 注意：effect 的回调会被**立刻调用**，这里返回 off 本身作为清理函数（正确写法）。
  if (typeof ctx.effect === "function" && typeof off === "function") {
    ctx.effect(() => off);
  }
  ctx.logger?.info?.(`${TAG} 已注册探针工具 ${tool.name}`);
  return true;
}

/**
 * 注册全部写作工具。
 *
 * 每个工具都用 `structuredClone` 深拷贝参数表（与官方大插件 dsh-scriptor 的做法一致），
 * 避免工具注册表反过来改到模块常量。
 *
 * 两层独立护栏（#9 真机事故的修复）：
 *  - **工厂构造**：逐个 try/catch。旧写法把 7 个 `createXxxTool(runtime)` 放进数组字面量，
 *    任一工厂抛错就整个数组构造崩 → 7 个工具全丢（探针在别处，幸存），而现象看起来像「工具没注册」。
 *  - **注册调用**：逐个 try/catch，失败记进 toolRegistration.failures，随探针带回给模型。
 *
 * 清理函数走 `ctx.effect`，且**必须写成「返回清理函数」**的形式：
 * cordis 会在调用 `ctx.effect(callback)` 时立刻执行 callback，并把**返回值**当清理函数登记。
 * 写成 `ctx.effect(() => { disposers.forEach(off => off()) })` —— 即「在 callback 里直接清理」——
 * 会在注册当刻就把刚注册的 7 个工具全部注销，而 register() 全程成功、日志还写 8/8。
 *
 * @param {object} ctx
 * @param {object} runtime createRuntime 的产物
 * @returns {number} 注册成功的工具数
 */
function registerTools(ctx, runtime) {
  const factories = [
    ["oh_story_env", createEnvTool],
    ["oh_story_wordcount", createWordcountTool],
    ["oh_story_chapter_check", createChapterCheckTool],
    ["oh_story_chapter_commit", createChapterCommitTool],
    ["oh_story_ai_patterns_check", createAiPatternsTool],
    ["oh_story_degeneration_check", createDegenerationTool],
    ["oh_story_punctuation_normalize", createPunctuationTool],
  ];

  const disposers = [];
  let count = 0;
  for (const [label, factory] of factories) {
    toolRegistration.names.push(label);

    if (!runtime) {
      recordToolFailure(label, "runtime", new Error("createRuntime 失败，写作工具未装配"));
      continue;
    }

    let def;
    try {
      def = factory(runtime);
    } catch (err) {
      recordToolFailure(label, "factory", err);
      ctx.logger?.warn?.(`${TAG} 工具 ${label} 构造失败：${err?.message ?? err}`);
      continue;
    }

    if (typeof ctx.tools?.register !== "function") {
      recordToolFailure(label, "register", new Error("ctx.tools.register 不可用（宿主版本不符？）"));
      continue;
    }

    try {
      const off = ctx.tools.register({
        name: def.name,
        description: def.description,
        parameters: structuredClone(def.parameters),
        output: def.output,
        execute: (args, exec) => def.execute(args, exec),
      });
      if (typeof off === "function") disposers.push(off);
      toolRegistration.registered.push(def.name);
      count += 1;
      ctx.logger?.info?.(`${TAG} 已注册工具 ${def.name}`);
    } catch (err) {
      recordToolFailure(def.name, "register", err);
      ctx.logger?.warn?.(`${TAG} 工具 ${def.name} 注册失败：${err?.message ?? err}`);
    }
  }

  if (disposers.length > 0 && typeof ctx.effect === "function") {
    // 正确形态：callback 立刻执行并**返回**清理函数（不是自己执行清理）。
    ctx.effect(() => () => {
      for (const off of [...disposers].reverse()) {
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

  resetToolRegistration();

  // 探针**第一个**注册：后面无论哪一步抛错，装机自检入口都还在，并且能把失败原因带出来
  // （宿主日志不落盘，探针输出是唯一可靠的取证面）。
  registerProbeTool(ctx);

  let runtime = null;
  try {
    runtime = createRuntime({ ctx, logger: ctx.logger });
  } catch (err) {
    recordToolFailure("runtime", "runtime", err);
    ctx.logger?.warn?.(`${TAG} createRuntime 失败：${err?.message ?? err}`);
  }

  registerTools(ctx, runtime);

  // 刻意不 await：装配不应该因为 skills 这一半慢或失败而卡住。
  mountBundledSkills(ctx).catch((err) => {
    skillsMount.detail = `随包技能挂载异常 —— ${err?.message ?? err}`;
    ctx.logger?.warn?.(`${TAG} ${skillsMount.detail}`);
  });
}
