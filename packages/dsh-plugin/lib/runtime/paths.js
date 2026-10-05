/**
 * 路径解析与脚本落点。
 *
 * 两件事：
 *
 * 1. **随包脚本落点**：一律从 `import.meta.url` 解析（插件被装到别的 profile 也能读），
 *    并允许 `OH_STORY_SKILLS_DIR` 覆盖（测试与排障用：指向一个没有脚本的目录就能
 *    测「脚本缺失」错误路径）。scripts 表是单点真源，工具的 command 描述从它生成。
 *
 * 2. **用户输入路径归一**：工具收到的相对路径以**会话工作目录**为基准解析
 *    （取 `exec.agent.session.header.cwd`，与 dsh-mattpocock-skills-deck 的
 *    `resolveSessionCwd` 同一取法）；解析结果一律转绝对路径再交给原脚本，
 *    这样「脚本不依赖 cwd」（#3 契约）这一性质不会因为我们把路径当相对传而破坏。
 */

import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve, normalize } from "node:path";
import { homedir } from "node:os";

/**
 * 随包 skills 根目录（含 /skills/ 前缀的文件在包里的落点）。
 * 用 import.meta.url 而不是 __dirname：本包是 ESM，装到别处 import.meta.url 永远对。
 */
export function defaultSkillsRoot() {
  return fileURLToPath(new URL("../../skills/", import.meta.url));
}

/** 关键脚本相对 skills 根的路径（storyctl 只存在 story-long-write）。 */
export const SCRIPT_REL_PATHS = {
  storyctl: "story-long-write/scripts/storyctl.py",
  wordcountCore: "story-long-write/scripts/wordcount_core.py",
  aiPatterns: "story-deslop/scripts/check-ai-patterns.js",
  degeneration: "story-deslop/scripts/check-degeneration.js",
  punctuation: "story-deslop/scripts/normalize-punctuation.js",
  styleWhitelist: "story-deslop/scripts/style-whitelist.js",
};

/**
 * 计算全部脚本绝对路径。
 *
 * @param {object} [options]
 * @param {string} [options.skillsRoot] 覆盖 skills 根（默认随包目录）
 * @param {Record<string,string|undefined>} [options.env] 环境变量（OH_STORY_SKILLS_DIR 覆盖）
 * @returns {{ root: string, scripts: Record<string,string> }}
 */
export function resolveScripts(options = {}) {
  const env = options.env ?? {};
  const override = String(env.OH_STORY_SKILLS_DIR ?? "").trim();
  const root = override ? override : (options.skillsRoot ?? defaultSkillsRoot());
  const scripts = {};
  for (const [key, rel] of Object.entries(SCRIPT_REL_PATHS)) {
    scripts[key] = resolve(root, rel);
  }
  return { root, scripts };
}

/**
 * 取调用所在的工作区目录：优先会话头 cwd，回退 process.cwd()。
 * 返回值和来源都给出，来源写进信封（cwdSource），路径猜错时肉眼可见。
 *
 * @param {object} [exec] 工具 execute 的第二参（ToolRunContext）
 * @returns {{cwd: string, source: string}}
 */
export function resolveSessionCwd(exec) {
  const agent = exec?.agent;
  const header = agent?.session?.header;
  if (typeof header?.cwd === "string" && header.cwd) {
    return { cwd: header.cwd, source: "session.header.cwd" };
  }
  const session = agent?.session;
  if (typeof session?.cwd === "string" && session.cwd) {
    return { cwd: session.cwd, source: "session.cwd" };
  }
  return { cwd: process.cwd(), source: "process.cwd" };
}

/** 展开 `~` / `~\` 前缀（Windows 家目录）。 */
function expandHome(input) {
  const value = String(input ?? "");
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

/**
 * 把用户给的路径归一成绝对路径。
 *
 * @param {string|null|undefined} input 用户输入（绝对、相对或 `~` 开头）
 * @param {string} cwd 基准目录（会话工作区）
 * @returns {string} 绝对路径（不检查存在性；存在性由 assert 类函数负责）
 */
export function toAbsolute(input, cwd) {
  if (input == null || input === "") return "";
  const expanded = expandHome(String(input));
  if (isAbsolute(expanded)) return normalize(expanded);
  return resolve(cwd || process.cwd(), expanded);
}

/**
 * 校验路径存在且是期望类型；失败返回 {ok:false,error}，成功返回 {ok:true,path}。
 * 把「存在性检查」放在起子进程之前：缺文件让脚本报 2，远不如我们先把话说清楚。
 */
export function assertPath(input, cwd, { kind = "any", label = "路径" } = {}) {
  const path = toAbsolute(input, cwd);
  if (!path) {
    return { ok: false, code: "INVALID_ARGUMENT", path, error: "路径为空：请给出有效的路径参数。" };
  }
  if (!existsSync(path)) {
    return { ok: false, code: "PATH_NOT_FOUND", path, error: `${label}不存在：${path}` };
  }
  if (kind === "dir" && !statSync(path).isDirectory()) {
    return { ok: false, code: "PATH_NOT_FOUND", path, error: `${label}不是目录：${path}` };
  }
  if (kind === "file" && !statSync(path).isFile()) {
    return { ok: false, code: "PATH_NOT_FOUND", path, error: `${label}不是文件：${path}` };
  }
  return { ok: true, path };
}

/** 正整数小工具：接受 number 或数字字符串，返回 number 或 null。 */
export function toPositiveInt(value, { min = 1 } = {}) {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(num) || num < min) return null;
  return num;
}
