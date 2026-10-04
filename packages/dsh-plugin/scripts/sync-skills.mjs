#!/usr/bin/env node
/**
 * dsh-oh-story-claudecode —— vendored skills 同步脚本（wayfinder #7）
 *
 * 把仓库根 `skills/*`（13 个写作 skill）整目录复制到本子包 `skills/`，
 * 保持逐字节一致。配套校验脚本：check-parity.mjs。
 *
 * 设计说明：
 * - 整目录复制（不只 SKILL.md + references + scripts）：各 skill 还带 assets/
 *   （如 story/assets/app.js 供 dashboard 用），副本必须与源逐字节一致，才能
 *   在插件被装到别处时仍然自洽。
 * - 只复制、绝不改写正文：副本与源一致，源被仓库守卫管着，副本就不会违规
 *   （hot-path 字数预算、frontmatter 单行键值、不跨 skill 引用 均由源侧守卫保证）。
 *
 * 用法：
 *   node scripts/sync-skills.mjs          # 复制（覆盖；删除副本中源已不存在的文件）
 *   node scripts/sync-skills.mjs --check  # 只校验差异，不写盘
 * 退出码：0 一致 / 1 有差异或出错。
 */

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "skills");
const DST_DIR = path.join(PACKAGE_ROOT, "skills");

const checkOnly = process.argv.includes("--check");

/** 递归收集目录下所有文件（相对路径清单，字典序，跨平台稳定）。 */
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

function printList(title, items) {
  if (items.length === 0) return;
  console.log(`  ${title}（${items.length}）`);
  for (const f of items) console.log(`    ${f}`);
}

if (!existsSync(SRC_DIR)) {
  console.error(`[sync-skills] 源目录不存在: ${SRC_DIR}`);
  process.exit(1);
}

console.log(`[sync-skills] ${checkOnly ? "校验" : "同步"} ${SRC_DIR} -> ${DST_DIR}`);

if (checkOnly) {
  if (diffCount > 0) {
    printList("仅在源侧", onlySrc);
    printList("仅在副本侧", onlyDst);
    printList("内容不一致", changed);
    console.error(`[sync-skills] 差异 ${diffCount} 项 —— 副本已漂移，请重跑 sync-skills.mjs`);
    process.exit(1);
  }
  console.log(`[sync-skills] 一致：${srcFiles.length} 个文件逐字节相同。`);
  process.exit(0);
}

// 同步：先清掉副本中「源已不存在」的文件（含占位 dsh-probe），再整体复制。
for (const f of onlyDst) {
  console.log(`[sync-skills] 移除副本多余: ${f}`);
  rmSync(path.join(DST_DIR, f), { recursive: true, force: true });
}
for (const f of changed) {
  console.log(`[sync-skills] 覆盖不一致: ${f}`);
  rmSync(path.join(DST_DIR, f), { recursive: true, force: true });
}
cpSync(SRC_DIR, DST_DIR, { recursive: true, force: true });
console.log(`[sync-skills] 同步完成：${srcFiles.length} 个文件已就位。`);
