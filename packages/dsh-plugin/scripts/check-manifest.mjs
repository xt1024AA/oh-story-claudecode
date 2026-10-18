#!/usr/bin/env node
/**
 * dsh-oh-story-claudecode —— 清单与 DSH 兼容性自检（0.2.2 起）。
 *
 * 为什么要有这个脚本：0.2.1 在 DSH `0.2.1-rc.2` 上**整包被跳过**，而安装、`npm pack`、
 * 34 项工具测试、parity 校验、类型检查**全绿**——因为没有任何一步读过「宿主怎么判兼容」。
 * 现象只有一句 stderr：`dsh: skipping profile bundle "dsh-oh-story-claudecode": Error:
 * Plugin dsh-oh-story-claudecode@0.2.1 is incompatible with dsh 0.2.1-rc.2: requirements
 * {"@deepseek-ai/dsh-skill-filesystem":"0.2.0-rc.2"} ...`，然后插件静静地不存在。
 *
 * 宿主的判定规则（`$ASAR/dsh-app-boot/lib/index.js` 的 `unmetRequirements`，本机实测）：
 *
 *   1. `package.json` 里**有 `engines.dsh` 就只看它**，`peerDependencies` 全部被忽略；
 *   2. 否则逐个校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer 范围；
 *   3. 匹配用 `semver.satisfies(runtime, range, { includePrerelease: true })`；
 *   4. **精确的预发布版本号（如 `0.2.0-rc.2`）只匹配它自己**——宿主升到 `0.2.1-rc.2`
 *      就判不兼容，整包被跳过，profile 其余部分照常启动（不会报错退出，只打一行 stderr）。
 *
 * 于是本脚本守三件事：
 *
 *   A. **兼容性**：peer 必须是「范围」而不是精确版本，并且必须同时满足我们声明支持的全部
 *      基线运行时（默认 `0.2.0-rc.2` 与 `0.2.1-rc.2`）。想加新基线就加进 `SUPPORTED_RUNTIMES`。
 *   B. **一致性**：`lib/index.js` 的 `VERSION`、`cordis.patch.yml` 的 id/name、包名三处必须相同；
 *      版本号必须是精确 SemVer（宿主用 `name@version` 做豁免键，范围会直接不可用）。
 *   C. **可装载的形状**：`dsh.bundle.patch` 指向存在的文件；`exports` / `files` 覆盖 locale 与 icon；
 *      随包 skills 的 frontmatter 满足 `dsh-skill` 的硬要求（kebab-case 的 `name` + 非空 `description`），
 *      否则那个 skill 会被宿主静默丢弃。
 *
 * **刻意 fail-closed**：范围语法只认本文件支持的那一小撮；出现别的写法直接报错，
 * 而不是「看不懂就当通过」——那样这个守卫会变成安慰剂。
 *
 * 用法：
 *   node scripts/check-manifest.mjs                      # 用默认基线运行时
 *   node scripts/check-manifest.mjs --runtime 0.2.1-rc.2 # 额外追加一个运行时（可重复）
 *   node scripts/check-manifest.mjs --package <目录>      # 换一个包目录（变异测试用）
 * 退出码：0 通过 / 1 有失败。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 声明支持并必须通过判定的 DSH 运行时版本。
 *
 * 加一个新版本 = 承诺「本插件在该版本上仍然装载」。宿主每次升小版本都会重新跑这道闸门，
 * 所以升级 DSH 后请先跑本脚本；不兼容就改 `peerDependencies` 的范围，别加版本豁免
 * （豁免只对精确 `name@version` 生效，且插件升级/DSH 升级都不继承）。
 */
const SUPPORTED_RUNTIMES = ["0.2.0-rc.2", "0.2.1-rc.2"];

/** icon 的硬限制（`$ASAR/dsh-app-boot/lib/index.js` 的 `iconOf`）：≤256 KiB，且只认这四种格式。 */
const ICON_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp"]);
const MAX_ICON_BYTES = 256 * 1024;

/** skill 名的硬限制（`$ASAR/dsh-skill/lib/index.js` 的 `SKILL_NAME`）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const failures = [];
/**
 * 被检查的包目录。默认是本脚本的上一级（即 `packages/dsh-plugin/`），
 * `--package <目录>` 可指向别处——变异测试把包复制到临时目录再改坏，不必动仓库原件。
 */
let PACKAGE_ROOT = DEFAULT_PACKAGE_ROOT;
/** 被测试直接调用时静默（测试只关心失败清单，不关心过程日志）。 */
let quiet = false;
function fail(message) {
  failures.push(message);
}
function ok(message) {
  if (!quiet) console.log(`  ok  ${message}`);
}
function section(title) {
  if (!quiet) console.log(`\n[${title}]`);
}

/**
 * 跑全部检查并返回失败清单（**不打印、不退出**）。
 *
 * 这个函数是守卫的可测内核：`scripts/test-manifest-guard.mjs` 直接 import 它，
 * 对临时目录里的变异副本断言「确实变红」。守卫自己只在文件末尾的 CLI 入口里打印与退出。
 *
 * 为什么不做成「子进程 + 读 stdout」：受限沙箱禁止 `child_process` 用管道 stdio
 * （EPERM），子进程式测试在开发机上跑不起来——那样这个回归就形同虚设。
 *
 * @param {object} [options]
 * @param {string} [options.packageRoot] 被检查的包目录（默认本脚本的上一级）
 * @param {string[]} [options.runtimes] 必须全部通过的运行时版本
 * @returns {string[]} 失败项（空数组 = 通过）
 */
export function checkManifest(options = {}) {
  PACKAGE_ROOT = options.packageRoot ? path.resolve(options.packageRoot) : DEFAULT_PACKAGE_ROOT;
  quiet = options.quiet === true;
  failures.length = 0;

  const runtimes = options.runtimes ?? SUPPORTED_RUNTIMES;
  for (const runtime of runtimes) {
    if (parseVersion(runtime) === null) {
      throw new Error(`运行时版本 "${runtime}" 不是精确 SemVer`);
    }
  }

  const manifest = readJson("package.json");
  if (manifest === undefined) return [...failures];

  checkCompatibility(manifest, runtimes);
  checkIdentity(manifest);
  checkPackageShape(manifest);
  checkSkills();
  return [...failures];
}

/** 供测试直接复用的运行时基线（改基线时测试跟着走，不用抄一份）。 */
export const BASELINE_RUNTIMES = SUPPORTED_RUNTIMES;

/** 供测试直接调用的 semver 判定（与宿主 `includePrerelease: true` 语义对齐）。 */
export { satisfies, parseVersion };

// ─────────────────────────── 极简 semver（fail-closed 子集） ───────────────────────────
//
// 只实现宿主实际会用到的形状。**不支持的一律抛错**，不做「猜一个大概」的兼容。

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 解析成 {major,minor,patch,pre: string[]}；失败返回 null。 */
function parseVersion(text) {
  const m = VERSION.exec(String(text).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split("."),
  };
}

/** semver 优先级比较：负数 = a<b，0 = 相等，正数 = a>b。 */
function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // 无预发布标识的版本 > 有预发布标识的版本
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1; // 前缀短的小
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
      continue;
    }
    // 数字标识符恒小于字母数字标识符
    if (xNum) return -1;
    if (yNum) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 上界「下一个不兼容版本」：`<X.Y.Z-0` 这种写法把该版本的预发布也排除在外。 */
function upperBound(major, minor, patch) {
  return parseVersion(`${major}.${minor}.${patch}-0`);
}

/**
 * 把一个比较式展开成 [版本, 关系] 列表。
 * 支持：`^`、`~`、`>=`、`>`、`<=`、`<`、`=`、裸版本、`X.Y.x` / `X.x` / `*`。
 */
function expandComparator(token) {
  const raw = token.trim();
  if (raw === "" ) throw new Error("empty comparator");
  if (raw === "*" || raw === "x" || raw === "X") return [];

  const wildcard = /^v?(\d+)\.(\d+)\.[xX*]$/.exec(raw) ?? /^v?(\d+)\.[xX*]$/.exec(raw);
  if (wildcard) {
    const major = Number(wildcard[1]);
    const minor = wildcard.length === 3 ? Number(wildcard[2]) : 0;
    const base = parseVersion(`${major}.${minor}.0`);
    if (minor === 0 && wildcard.length === 2) return [[base, ">="], [upperBound(major + 1, 0, 0), "<"]];
    return [[base, ">="], [upperBound(major, minor + 1, 0), "<"]];
  }

  const caret = /^\^(.+)$/.exec(raw);
  if (caret) {
    const base = parseVersion(caret[1]);
    if (!base) throw new Error(`unsupported caret target ${caret[1]}`);
    // 0.x：锁 minor；其余：锁 major（与 npm 的 caret 规则一致）
    const top =
      base.major === 0
        ? upperBound(0, base.minor + 1, 0)
        : upperBound(base.major + 1, 0, 0);
    return [[base, ">="], [top, "<"]];
  }

  const tilde = /^~(.+)$/.exec(raw);
  if (tilde) {
    const base = parseVersion(tilde[1]);
    if (!base) throw new Error(`unsupported tilde target ${tilde[1]}`);
    return [[base, ">="], [upperBound(base.major, base.minor + 1, 0), "<"]];
  }

  const op = /^(>=|<=|>|<|=)(.+)$/.exec(raw);
  if (op) {
    const base = parseVersion(op[2]);
    if (!base) throw new Error(`unsupported comparator target ${op[2]}`);
    return [[base, op[1]]];
  }

  const exact = parseVersion(raw);
  if (exact) return [[exact, "="]];

  throw new Error(`unsupported range syntax "${raw}"`);
}

/** 解析整个范围（`||` 并联、空格串联）。 */
function parseRange(range) {
  const text = String(range ?? "").trim();
  if (text === "") throw new Error("empty range");
  return text.split("||").map((group) => {
    const tokens = group.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) throw new Error(`empty group in range "${text}"`);
    return tokens.flatMap(expandComparator);
  });
}

/** 判断版本是否落在范围内（语义等价于宿主的 `includePrerelease: true`）。 */
function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`invalid version "${version}"`);
  const groups = parseRange(range);
  return groups.some((comparators) =>
    comparators.every(([target, op]) => {
      const cmp = compareVersions(parsed, target);
      switch (op) {
        case ">=":
          return cmp >= 0;
        case ">":
          return cmp > 0;
        case "<=":
          return cmp <= 0;
        case "<":
          return cmp < 0;
        case "=":
          return cmp === 0;
        default:
          throw new Error(`unknown operator ${op}`);
      }
    }),
  );
}

// ─────────────────────────── 读取包内文件 ───────────────────────────

function readJson(rel) {
  const file = path.join(PACKAGE_ROOT, rel);
  if (!existsSync(file)) {
    fail(`${rel} 不存在`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`${rel} 不是合法 JSON：${err.message}`);
    return undefined;
  }
}

/** 只取 SKILL.md 顶部 YAML frontmatter 里的 name / description（不引第三方 YAML 解析器）。 */
function readSkillFrontmatter(file) {
  const text = readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return undefined;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }
  return fields;
}

// ─────────────────────────── A. 兼容性 ───────────────────────────

function checkCompatibility(manifest, runtimes) {
  section("兼容性");

  if (manifest.engines !== undefined && Object.hasOwn(manifest.engines, "dsh")) {
    fail(
      "package.json 声明了 engines.dsh —— 宿主只要看到它，就**完全忽略** peerDependencies " +
        "（$ASAR/dsh-app-boot 的 unmetRequirements 第一条分支）。本包刻意用 peer 声明来保护 " +
        "「宿主必须提供兼容的 @deepseek-ai/dsh-skill-filesystem」，加 engines.dsh 会让这层保护失效。" +
        "要扩大兼容范围请改 peerDependencies 的范围。",
    );
    return;
  }

  const peers = manifest.peerDependencies ?? {};
  const dshPeers = Object.keys(peers).filter(
    (name) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"),
  );
  if (dshPeers.length === 0) {
    fail(
      "package.json 没有任何 @deepseek-ai/dsh* 的 peerDependencies —— 宿主将不施加任何版本约束，" +
        "本插件在任意 DSH 版本上都会被放行（含 API 已变的版本）。至少要声明 dsh-skill-filesystem。",
    );
    return;
  }

  for (const name of dshPeers) {
    const range = peers[name];
    if (typeof range !== "string" || range.trim() === "") {
      fail(`peerDependencies["${name}"] 必须是非空字符串范围（宿主对空范围判不兼容）`);
      continue;
    }
    // 精确版本 = 只匹配它自己；这是 0.2.1 被整包跳过的直接原因
    if (parseVersion(range) !== null) {
      fail(
        `peerDependencies["${name}"] 写成了精确版本 "${range}"。宿主用 name@version 做兼容判定，` +
          `精确版本只匹配该版本本身，DSH 一升级整包就会被跳过（0.2.1 的事故就是这个）。` +
          `请写成范围，例如 "^${range}"。`,
      );
      continue;
    }
    let parsed;
    try {
      parsed = parseRange(range);
    } catch (err) {
      fail(
        `peerDependencies["${name}"] 的范围 "${range}" 超出本守卫支持的语法子集（${err.message}）。` +
          "请改用 ^ / ~ / >= / < / || / X.Y.x 这些写法，或扩展 check-manifest.mjs 的解析器。",
      );
      continue;
    }
    if (parsed.length === 0) {
      fail(`peerDependencies["${name}"] 的范围 "${range}" 解析为空`);
      continue;
    }
    for (const runtime of runtimes) {
      let hit;
      try {
        hit = satisfies(runtime, range);
      } catch (err) {
        fail(`无法用范围 "${range}" 判定运行时 ${runtime}：${err.message}`);
        continue;
      }
      if (!hit) {
        fail(
          `peerDependencies["${name}"]: "${range}" **不匹配** DSH ${runtime}。` +
            "在该运行时上宿主会把整个组合包跳过（只打一行 stderr，profile 其余部分照常启动）。",
        );
      }
    }
    if (failures.length === 0) ok(`peer ${name}: "${range}" 覆盖 ${runtimes.join(" / ")}`);
  }
}

// ─────────────────────────── B. 一致性 ───────────────────────────

function checkIdentity(manifest) {
  section("一致性");

  const name = manifest.name;
  const version = manifest.version;
  if (typeof name !== "string" || name.trim() === "") {
    fail("package.json 缺 name");
  }
  if (typeof version !== "string" || parseVersion(version) === null) {
    fail(
      `package.json 的 version 必须是精确 SemVer（收到 ${JSON.stringify(version)}）：` +
        "宿主用 name@version 作版本豁免键，范围或缺失都会让豁免无从谈起。",
    );
  }

  const indexPath = path.join(PACKAGE_ROOT, "lib", "index.js");
  if (!existsSync(indexPath)) {
    fail("lib/index.js 不存在");
  } else {
    const source = readFileSync(indexPath, "utf8");
    const m = /^const VERSION = "([^"]+)";$/m.exec(source);
    if (!m) {
      fail("lib/index.js 里找不到 `const VERSION = \"...\";` —— 探针会报不出真实版本");
    } else if (m[1] !== version) {
      fail(`lib/index.js 的 VERSION="${m[1]}" 与 package.json 的 version="${version}" 不一致`);
    } else {
      ok(`版本一致：${version}`);
    }
  }

  const patchPath = path.join(PACKAGE_ROOT, "cordis.patch.yml");
  const bundlePatch = manifest.dsh?.bundle?.patch;
  if (typeof bundlePatch !== "string" && !Array.isArray(bundlePatch)) {
    fail('package.json 缺 dsh.bundle.patch（宿主据此判定「这是不是一个组合包」）');
  } else {
    const declared = typeof bundlePatch === "string" ? [bundlePatch] : bundlePatch;
    for (const rel of declared) {
      if (typeof rel !== "string") {
        fail("dsh.bundle.patch 只能是路径字符串或路径字符串数组");
      } else if (!existsSync(path.resolve(PACKAGE_ROOT, rel))) {
        fail(`dsh.bundle.patch 指向的 ${rel} 不存在`);
      }
    }
  }

  if (!existsSync(patchPath)) {
    fail("cordis.patch.yml 不存在");
  } else {
    const patch = readFileSync(patchPath, "utf8");
    const ids = [...patch.matchAll(/^\s*- id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    const names = [...patch.matchAll(/^\s*name:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1]);
    if (ids.length === 0) {
      fail("cordis.patch.yml 没有 insert 任何 - id: 行");
    } else if (!ids.includes(name) || !names.includes(name)) {
      fail(
        `cordis.patch.yml 的行 id/name 必须与包名 "${name}" 相同（当前 id=${JSON.stringify(ids)}、` +
          `name=${JSON.stringify(names)}）：插件管理器的开关按行 id 匹配，名字对不上就关不掉也开不回来。`,
      );
    } else {
      ok(`装配行 ${name} 与包名一致`);
    }
  }
}

// ─────────────────────────── C. 可装载的形状 ───────────────────────────

function checkPackageShape(manifest) {
  section("清单形状");

  const exportsMap = manifest.exports ?? {};
  for (const key of ["./locale/*.json", "./icon", "./package.json"]) {
    if (exportsMap[key] === undefined) {
      fail(
        `package.json 的 exports 缺 "${key}"：宿主的 readPluginMeta 通过 <包名>${key} 解析显示元数据，` +
          "缺了就只能回退到包名/默认图（不阻止装载，但设置页会很难认）。",
      );
    }
  }
  if (exportsMap["."] === undefined) fail('package.json 的 exports 缺 "."');

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const entry of ["lib", "skills", "locale", "icon.svg", "cordis.patch.yml", "README.md"]) {
    if (!files.includes(entry)) {
      fail(`package.json 的 files 缺 "${entry}" —— npm pack / tgz 安装会把它丢掉`);
    }
  }

  const localeDir = path.join(PACKAGE_ROOT, "locale");
  if (!existsSync(localeDir)) {
    fail("locale/ 目录不存在");
  } else {
    const files2 = readdirSync(localeDir).filter((n) => n.endsWith(".json"));
    if (!files2.includes("en.json")) {
      fail("locale/en.json 缺失：宿主的元数据解析以它为锚，缺了整个 locale 目录都不会被读");
    }
    for (const file of files2) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(path.join(localeDir, file), "utf8"));
      } catch (err) {
        fail(`locale/${file} 不是合法 JSON：${err.message}`);
        continue;
      }
      const meta = parsed.meta;
      if (meta === undefined || typeof meta !== "object" || Array.isArray(meta)) {
        fail(`locale/${file} 缺 meta 对象`);
        continue;
      }
      for (const field of ["title", "description"]) {
        if (typeof meta[field] !== "string" || meta[field].trim() === "") {
          fail(`locale/${file} 的 meta.${field} 必须是非空字符串`);
        }
      }
    }
    if (files2.length > 0) ok(`locale：${files2.join(", ")}`);
  }

  const iconPath = path.join(PACKAGE_ROOT, "icon.svg");
  if (!existsSync(iconPath)) {
    fail("icon.svg 不存在");
  } else {
    const ext = path.extname(iconPath).toLowerCase();
    if (!ICON_EXTENSIONS.has(ext)) fail(`icon 扩展名 ${ext} 不被宿主接受（只认 SVG/PNG/JPEG/WebP）`);
    const size = statSync(iconPath).size;
    if (size > MAX_ICON_BYTES) fail(`icon.svg 有 ${size} 字节，超过宿主的 256 KiB 上限`);
    else ok(`icon.svg：${size} 字节`);
  }
}

function checkSkills() {
  section("随包 skills");

  const root = path.join(PACKAGE_ROOT, "skills");
  if (!existsSync(root)) {
    fail("skills/ 目录不存在");
    return;
  }
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (dirs.length === 0) {
    fail("skills/ 下没有任何 skill 目录");
    return;
  }
  for (const dir of dirs) {
    const skillFile = path.join(root, dir, "SKILL.md");
    if (!existsSync(skillFile)) {
      fail(`skills/${dir}/SKILL.md 不存在 —— 宿主只认 <root>/<name>/SKILL.md 或 <root>/<name>.md，缺了该目录整条被忽略`);
      continue;
    }
    const fields = readSkillFrontmatter(skillFile);
    if (fields === undefined) {
      fail(`skills/${dir}/SKILL.md 缺 YAML frontmatter（宿主会静默丢弃该 skill）`);
      continue;
    }
    if (!SKILL_NAME.test(fields.name ?? "")) {
      fail(
        `skills/${dir}/SKILL.md 的 frontmatter name=${JSON.stringify(fields.name)} 不是合法 kebab-case` +
          "（宿主正则 ^[a-z0-9]+(?:-[a-z0-9]+)*$，不匹配就静默丢弃）",
      );
    }
    if (fields.name !== dir) {
      fail(`skills/${dir}/SKILL.md 的 name="${fields.name}" 与目录名不一致 —— 会话目录里看到的名字会与目录脱节`);
    }
    if (typeof fields.description !== "string" || fields.description.trim() === "") {
      fail(`skills/${dir}/SKILL.md 缺 description（宿主要求 name + description 都在）`);
    }
  }
  if (failures.length === 0) ok(`${dirs.length} 个 skill 的 frontmatter 都满足宿主硬要求`);
}

// ─────────────────────────── 主流程 ───────────────────────────

// ─────────────────────────── CLI 入口 ───────────────────────────
//
// 只有作为主模块执行时才打印/退出；被 `test-manifest-guard.mjs` import 时
// 只导出 `checkManifest()`，不产生任何副作用。

const IS_MAIN =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  const argv = process.argv.slice(2);
  const runtimes = [...SUPPORTED_RUNTIMES];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runtime") {
      const value = argv[++i];
      if (!value) {
        console.error("[check-manifest] --runtime 需要一个版本号");
        process.exit(1);
      }
      runtimes.push(value);
      continue;
    }
    if (argv[i] === "--package") {
      const value = argv[++i];
      if (!value) {
        console.error("[check-manifest] --package 需要一个目录");
        process.exit(1);
      }
      continue;
    }
    console.error(`[check-manifest] 未知参数 ${JSON.stringify(argv[i])}`);
    process.exit(1);
  }

  const uniqueRuntimes = [...new Set(runtimes)];
  const target =
    argv.includes("--package") && argv[argv.indexOf("--package") + 1]
      ? path.resolve(argv[argv.indexOf("--package") + 1])
      : DEFAULT_PACKAGE_ROOT;

  console.log(`[check-manifest] ${target}`);
  console.log(`[check-manifest] 基线运行时：${uniqueRuntimes.join(", ")}`);

  let problems;
  try {
    problems = checkManifest({ packageRoot: target, runtimes: uniqueRuntimes });
  } catch (err) {
    console.error(`[check-manifest] 检查本身抛错：${err.message}`);
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error(`\n[check-manifest] ${problems.length} 项失败：`);
    for (const message of problems) console.error(`  ✗ ${message}`);
    process.exit(1);
  }
  console.log("\n[check-manifest] 全部通过。");
}
