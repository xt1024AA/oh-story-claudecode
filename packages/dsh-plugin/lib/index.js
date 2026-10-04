/**
 * dsh-oh-story-claudecode —— DSH 插件骨架原型
 *
 * 这是 wayfinder 票 #5 的**一次性探针**，不是最终实现。它只回答两个问题：
 * （1）一个本地子包，能不能被 `dsh plugin --profile desktop add <路径>` 装上，
 *      并把工具注册进 agent 工具面、可被真实调用？
 * （2）插件自带的 `skills/` 目录，能不能挂进 DSH 的 skill 表？
 *
 * 刻意压到最小：一个探针工具（固定返回，不碰用户文件）+ 一个占位 skill。
 * #5 通过后，真正的清单与工具封装在 #6 / #7 / #8 里做。
 *
 * 规范依据（本机实测结论，见 docs/research/dsh-plugin-spec.md）：
 * - 导出形态二选一、禁止混用：`export function apply(ctx, config)` 或 default 导出 service class（§2.4）。
 * - 工具注册：`ctx.tools.register(definition): () => void`，返回的是「精确撤销器」（§3.1）。
 * - 工具的 `parameters` 是**原始 JSON Schema**（不是 zod、不是 schemastery），
 *   `output` 是必填的 `{ schema, render }`（§3.3）。
 * - 随包 skills 不自造发现逻辑：挂官方 `@deepseek-ai/dsh-skill-filesystem` 提供方，
 *   把自带目录作为 `bundledSkillDir` 传进去（rank 600）（§4.1 / §4.2）。
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 插件行名。必须与 cordis.patch.yml 里的 id / name 以及包名一致。 */
export const name = "dsh-oh-story-claudecode";

/** 工具注册是硬依赖：装配时若缺少 tools 服务，本插件不激活（§3.1 的「硬依赖」写法）。 */
export const inject = ["tools"];

const TAG = "[dsh-oh-story-claudecode]";
const VERSION = "0.0.2";

/** 随包 skills 根目录：与 lib/ 同级。用 import.meta.url 解析，保证插件被装到别处也能读。 */
const BUNDLED_SKILL_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

/**
 * skills 挂载的**可观测状态**。
 *
 * 为什么要把它挂到模块级、并由探针工具回报：本机实测发现宿主日志没有落盘，
 * 于是「skill 没被发现」这一现象分不清是「提供方没挂上」还是「会话快照早于安装」。
 * 把挂载结果做成工具输出的一部分，任何人调一次探针就能拿到确定答案，不必去翻日志。
 */
const skillsMount = {
  attempted: false,
  ok: false,
  provider: "oh-story-bundled",
  detail: "尚未尝试挂载",
};

/** 探针工具定义。只报告事实，不读写任何用户文件。 */
const PROBE_TOOL = {
  name: "oh_story_probe",
  description:
    "骨架探针：返回 DSH 插件 dsh-oh-story-claudecode 的装载事实（插件名、版本、随包 skills 目录是否就位、" +
    "随包 skills 是否挂载成功、以及调用方传入的回显字符串）。仅用于验证插件通路，不读写用户任何文件。",
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
  /**
   * @param {{ echo?: string }} args
   */
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
      note: "这是 wayfinder #5 的骨架探针；真正的写作工具在 #8 落地。",
    };
  },
};

/**
 * 注册探针工具。
 *
 * `structuredClone` 深拷贝参数表 —— 与官方大插件（dsh-scriptor）的做法一致，
 * 避免工具注册表反过来改到本模块的常量。
 *
 * @returns {boolean} 是否注册成功
 */
function registerProbeTool(ctx) {
  if (typeof ctx.tools?.register !== "function") {
    ctx.logger?.warn?.(`${TAG} 工具未注册：ctx.tools.register 不可用（宿主版本不符？）`);
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
 * 挂载随包 skills。
 *
 * 这里用**动态** import 而不是官方样本那种静态 import，是刻意的：
 * 静态 import 解析失败会让整个插件加载失败、连探针工具一起丢掉 —— 那样就分不清
 * 「装配没生效」和「skills 提供方解析不到」两种病因了。动态 import + try/catch
 * 把失败隔离在 skills 这一半，并把**确切错误原文**记进 skillsMount.detail，
 * 由探针工具回报出来。
 *
 * 为什么这不影响结论有效性：ESM 的动态 import 与静态 import 走同一套模块解析，
 * 所以「动态 import 解析不到」蕴含「静态 import 同样解析不到」。
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
        // 提供方名要唯一，避免与其它插件（如宿主自带的 filesystem 提供方）撞名。
        providerName: skillsMount.provider,
        // 只留自带根：本次探针只关心「插件的 skills 有没有被发现」，
        // 不想把项目根 / 用户根一并拉进来干扰判断。
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
 * cordis 插件入口（§2.4 的第一种形态）。
 *
 * @param {any} ctx cordis 上下文
 * @param {any} config 来自 cordis.patch.yml 中该条目的 config（本探针未声明 Config，故不使用）
 */
export function apply(ctx, config) {
  ctx.logger?.info?.(`${TAG} 骨架插件已加载（v${VERSION}）`);

  registerProbeTool(ctx);

  // 刻意不 await：装配不应该因为 skills 这一半慢或失败而卡住。
  mountBundledSkills(ctx).catch((err) => {
    skillsMount.detail = `随包技能挂载异常 —— ${err?.message ?? err}`;
    ctx.logger?.warn?.(`${TAG} ${skillsMount.detail}`);
  });
}