#!/usr/bin/env node
/**
 * dsh-oh-story-claudecode —— vendored skills parity 校验（wayfinder #7）
 *
 * 校验子包 `skills/` 副本与仓库根 `skills/` 是否逐字节一致。
 * 「漂了就红」：源侧或副本侧多了文件、少了文件、或内容不一致都算漂移。
 *
 * 用法：
 *   node scripts/check-parity.mjs    # 只校验，不写盘
 * 退出码：0 一致 / 1 漂移或出错。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "skills");
const DST_DIR = path.join(PACKAGE_ROOT, "skills");

/**
 * 副本侧豁免清单（相对 skills/ 根的路径）。
 *
 * 这两个 package.json 是「模块类型标记」（wayfinder #8 加的）：本子包根
 * package.json 声明了 `"type": "module"`，会让 Node 把 vendored 的 CJS 脚本
 * （check-ai-patterns.js 等用 `require`）误当 ESM 解析而崩溃；在脚本所在
 * skill 目录放一份 `{"type":"commonjs"}` 标记，Node 就近解析为 CommonJS。
 * 源侧（仓库根 skills/）没有这份文件，因此列入豁免，不参与逐字节 parity。
 */
const EXEMPT_DST_FILES = new Set([
  "story-deslop/package.json",
  "story-long-write/package.json",
]);

/**
 * 递归收集目录下所有文件（相对路径清单，字典序）。
 *
 * 刻意跳过 `__pycache__/`：.pyc 是 Python 运行时生成的构建产物（本子包的
 * vendored 脚本被真实执行后会在 scripts/ 下再生），既不是源、也不该参与
 * 逐字节 parity —— 否则每次跑过工具都会制造假漂移（#8 实测）。
 */
function collectFiles(dir, base = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "__pycache__") continue;
    const rel = base ? `${base}/${entry}` : entry;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

/** 逐字节比较两个文件。 */
function filesEqual(a, b) {
  return readFileSync(a).equals(readFileSync(b));
}

if (!existsSync(SRC_DIR)) {
  console.error(`[check-parity] 源目录不存在: ${SRC_DIR}`);
  process.exit(1);
}
if (!existsSync(DST_DIR)) {
  console.error(`[check-parity] 副本目录不存在: ${DST_DIR} —— 请先运行 sync-skills.mjs`);
  process.exit(1);
}

const srcFiles = collectFiles(SRC_DIR);
const dstFiles = collectFiles(DST_DIR);

const srcSet = new Set(srcFiles);
const dstSet = new Set(dstFiles);
const onlySrc = srcFiles.filter((f) => !dstSet.has(f));
const onlyDst = dstFiles.filter((f) => !srcSet.has(f) && !EXEMPT_DST_FILES.has(f));
const changed = srcFiles.filter(
  (f) => dstSet.has(f) && !filesEqual(path.join(SRC_DIR, f), path.join(DST_DIR, f)),
);

const diffCount = onlySrc.length + onlyDst.length + changed.length;

if (diffCount === 0) {
  console.log(`[check-parity] 一致：${srcFiles.length} 个文件逐字节相同。`);
  process.exit(0);
}

if (onlySrc.length) {
  console.log(`仅在源侧（${onlySrc.length}）:`);
  for (const f of onlySrc) console.log(`  ${f}`);
}
if (onlyDst.length) {
  console.log(`仅在副本侧（${onlyDst.length}）:`);
  for (const f of onlyDst) console.log(`  ${f}`);
}
if (changed.length) {
  console.log(`内容不一致（${changed.length}）:`);
  for (const f of changed) console.log(`  ${f}`);
}
console.error(`[check-parity] 漂移 ${diffCount} 项 —— 请重跑 sync-skills.mjs 并提交同步结果。`);
process.exit(1);
