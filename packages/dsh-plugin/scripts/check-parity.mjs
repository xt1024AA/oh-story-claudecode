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

/** 递归收集目录下所有文件（相对路径清单，字典序）。 */
function collectFiles(dir, base = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
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
const onlyDst = dstFiles.filter((f) => !srcSet.has(f));
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
