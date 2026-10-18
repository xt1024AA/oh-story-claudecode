#!/usr/bin/env node
/**
 * check-manifest.mjs 的回归测试（变异测试）。
 *
 * 为什么要有：这个守卫的存在理由是「0.2.1 在 DSH 升级后整包被跳过，而当时所有测试全绿」。
 * 一个只会打印 ok 的守卫和没有守卫没区别，所以这里逐个制造**真实事故的复现形态**，
 * 断言它确实变红；再还原，断言复绿。
 *
 * 做法：把 `packages/dsh-plugin/` 复制到临时目录（只复制守卫读到的那些路径），
 * 在副本上改坏，直接 `import { checkManifest }` 跑守卫。**仓库原件全程只读。**
 *
 * 为什么不用子进程：受限沙箱禁止 `child_process` 走管道 stdio（EPERM），
 * 子进程式测试在本机跑不起来——那样的回归等于没有。守卫因此被写成可 import 的纯函数
 * （见 check-manifest.mjs 头注「CLI 入口」一节）。
 *
 * 用法：node scripts/test-manifest-guard.mjs
 * 退出码：0 全绿 / 1 有失败。
 */

import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkManifest, BASELINE_RUNTIMES } from "./check-manifest.mjs";

const PACKAGE_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 守卫真正会读的路径（只复制这些，避免把 400+ 个 skill 文件搬来搬去）。 */
const COPY = ["package.json", "cordis.patch.yml", "locale", "icon.svg", "lib/index.js", "skills"];

const TMP_ROOT = mkdtempSync(join(tmpdir(), "oh-story-manifest-guard-"));

let seq = 0;
function freshCopy() {
  const dir = join(TMP_ROOT, `case-${String(seq++).padStart(2, "0")}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of COPY) {
    const src = join(PACKAGE_DIR, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(dir, entry), { recursive: true });
  }
  return dir;
}

/** 在副本上跑守卫（静默），返回失败清单。 */
function runGuard(dir, extra = []) {
  return checkManifest({ packageRoot: dir, runtimes: extra.length > 0 ? extra : BASELINE_RUNTIMES, quiet: true });
}

function patchJson(dir, mutate) {
  const file = join(dir, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  mutate(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/** 断言「变红了，而且报错文本点到了要害」。 */
function expectRed(dir, needle, extraRuntimes = []) {
  const problems = runGuard(dir, extraRuntimes);
  if (problems.length === 0) throw new Error("期望判红，实际通过");
  if (needle !== undefined && !problems.some((p) => p.includes(needle))) {
    throw new Error(`报错没点明 ${JSON.stringify(needle)}；实际：\n      ${problems.join("\n      ")}`);
  }
  return problems;
}

// ── 基线：原件副本必须通过 ──
test("基线副本通过", () => {
  const dir = freshCopy();
  const problems = runGuard(dir);
  if (problems.length > 0) throw new Error(`期望通过，实际：\n      ${problems.join("\n      ")}`);
});

// ── 事故 1：peer 写成精确预发布版本（0.2.1 的真实事故形态）──
test("peer 是精确版本 → 红", () => {
  const dir = freshCopy();
  patchJson(dir, (m) => {
    m.peerDependencies = { "@deepseek-ai/dsh-skill-filesystem": "0.2.0-rc.2" };
  });
  expectRed(dir, "精确版本");
});

// ── 事故 2：用 engines.dsh 代替 peer（会短路 peer 保护）──
test("声明 engines.dsh → 红", () => {
  const dir = freshCopy();
  patchJson(dir, (m) => {
    m.engines = { ...(m.engines ?? {}), dsh: ">=0.2.0-rc.2" };
  });
  expectRed(dir, "engines.dsh");
});

// ── 事故 3：范围漏掉当前运行时（`^0.2.1` 恰好不匹配 0.2.1-rc.2）──
test("范围漏掉当前运行时 → 红", () => {
  const dir = freshCopy();
  patchJson(dir, (m) => {
    m.peerDependencies = { "@deepseek-ai/dsh-skill-filesystem": "^0.2.1" };
  });
  expectRed(dir, "不匹配", ["0.2.1-rc.2"]);
});

// ── 事故 4：干脆不声明任何 dsh peer（宿主会放行任意版本）──
test("没有 dsh peer → 红", () => {
  const dir = freshCopy();
  patchJson(dir, (m) => {
    delete m.peerDependencies;
  });
  expectRed(dir, "没有任何 @deepseek-ai/dsh*");
});

// ── 事故 5：VERSION 与 package.json 脱节（探针会报错版本）──
test("lib VERSION 与 package.json 不一致 → 红", () => {
  const dir = freshCopy();
  patchJson(dir, (m) => {
    m.version = "9.9.9";
  });
  expectRed(dir, "不一致");
});

// ── 事故 6：files 漏了 locale（tgz 安装后显示元数据丢失）──
test("files 缺 locale → 红", () => {
  const dir = freshCopy();
  patchJson(dir, (m) => {
    m.files = m.files.filter((f) => f !== "locale");
  });
  expectRed(dir, 'files 缺 "locale"');
});

// ── 事故 7：skill 的 name 不是 kebab-case（宿主静默丢弃）──
test("skill name 非 kebab-case → 红", () => {
  const dir = freshCopy();
  const skillFile = join(dir, "skills", "story", "SKILL.md");
  const text = readFileSync(skillFile, "utf8");
  writeFileSync(skillFile, text.replace(/^name: story$/m, "name: Story_Web"), "utf8");
  expectRed(dir, "kebab-case");
});

// ── 事故 8：skill 目录缺 SKILL.md ──
test("skill 目录缺 SKILL.md → 红", () => {
  const dir = freshCopy();
  rmSync(join(dir, "skills", "story", "SKILL.md"), { force: true });
  expectRed(dir, "SKILL.md 不存在");
});

// ── 事故 9：icon 超 256 KiB ──
test("icon 超过 256 KiB → 红", () => {
  const dir = freshCopy();
  const padding = `<!--${"x".repeat(256 * 1024)}-->`;
  writeFileSync(join(dir, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg">${padding}</svg>`, "utf8");
  expectRed(dir, "256 KiB");
});

// ── 事故 10：装配行 id 与包名不一致（开关关不掉）──
test("cordis.patch.yml 行 id 与包名不一致 → 红", () => {
  const dir = freshCopy();
  const patchFile = join(dir, "cordis.patch.yml");
  const text = readFileSync(patchFile, "utf8").replaceAll("dsh-oh-story-claudecode", "some-other-id");
  writeFileSync(patchFile, text, "utf8");
  expectRed(dir, "必须与包名");
});

// ── 事故 11：范围语法超出守卫子集（fail-closed，不许当通过）──
test("不支持的 range 语法 → 红（fail-closed）", () => {
  const dir = freshCopy();
  patchJson(dir, (m) => {
    m.peerDependencies = { "@deepseek-ai/dsh-skill-filesystem": ">= 0.2.0-rc.2" };
  });
  expectRed(dir, "超出本守卫支持的语法子集");
});

// ── 事故 12：还原后必须复绿（防「只会红」的守卫）──
test("改回正确写法 → 复绿", () => {
  const dir = freshCopy();
  patchJson(dir, (m) => {
    m.peerDependencies = { "@deepseek-ai/dsh-skill-filesystem": "0.2.0-rc.2" };
  });
  if (runGuard(dir).length === 0) throw new Error("改坏后仍通过，变异无效");
  patchJson(dir, (m) => {
    m.peerDependencies = { "@deepseek-ai/dsh-skill-filesystem": "^0.2.0-rc.2" };
  });
  const problems = runGuard(dir);
  if (problems.length > 0) throw new Error(`还原后仍失败：\n      ${problems.join("\n      ")}`);
});

// ── 事故 13：`--package` 指向不存在的目录时必须判红，不许静默通过 ──
test("包目录不存在 → 红", () => {
  const problems = runGuard(join(TMP_ROOT, "does-not-exist"));
  if (problems.length === 0) throw new Error("期望判红，实际通过");
});

// ─────────────────────────── 跑 ───────────────────────────

let failed = 0;
try {
  for (const { name, fn } of cases) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${name}`);
      console.log(`      ${String(err.message ?? err).split("\n").join("\n      ")}`);
    }
  }
} finally {
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

console.log(`\n清单守卫回归：${cases.length} 项，${failed} 项失败。`);
process.exit(failed === 0 ? 0 : 1);
