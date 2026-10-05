/**
 * 文件层面的防护与证据收集。
 *
 * 三件事，全部服务于「作者书稿不可静默篡改」（#12 底线）：
 *
 * 1. **sha256**：破坏性动作前后都算，报告 before/after，让模型和作者看到这次
 *    到底改了哪个文件、改没改。
 * 2. **按路径的进程内互斥**：同一进程里两个破坏性工具并发写同一个文件时串行化。
 *    局限要写明白——这是进程内锁，跨 DSH 进程的并发写管不了（仓库原脚本自己也
 *    没有锁；要做跨进程锁得动原脚本，违背「不重写逻辑」纪律，所以不在这里硬造）。
 * 3. **工作目录快照/差异**：`chapter check` 有个容易漏的副作用——超长章会写
 *    `.story/work/第{NNN}章/over_length_baseline.json`（#3 契约第 3 条）。
 *    我们对 `.story/work/第{NNN}章` 做跑前/跑后快照，差异如实写进信封的
 *    sideEffects，让「纯看一眼的检查也会落盘」这件事在模型面前是可见的。
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** 计算文件 sha256；读不到返回 null（调用方按「无指纹」处理）。 */
export function sha256File(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** 进程内互斥表：key → 当前在跑的 promise 链尾。 */
const pathLocks = new Map();

/**
 * 按 key 串行化一段异步操作（进程内）。
 *
 * @template T
 * @param {string} key 互斥键（一般用解析后的绝对路径）
 * @param {() => Promise<T>} task
 * @returns {Promise<T>} task 的结果（与前一个任务串行）
 */
export function withPathLock(key, task) {
  const prev = pathLocks.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  // 链尾清理：等 next 落地后从表里摘掉，避免 Map 无限膨胀
  pathLocks.set(
    key,
    next.catch(() => {}).then(() => {
      if (pathLocks.get(key) === next) pathLocks.delete(key);
    }),
  );
  return next;
}

/**
 * 快照一个目录：相对路径 → { size, mtimeMs, sha256 }。
 * 文件才记；目录本身跳过（差异只关心文件增删改）。读不到的单项跳过，
 * 快照不因单文件被占而整体失败。
 *
 * @param {string} dir
 * @returns {Map<string, {size: number, mtimeMs: number, sha256: string|null}>}
 */
export function snapshotDir(dir) {
  const snap = new Map();
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const walk = (base) => {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        const full = join(base, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue; // 链接等不记
        try {
          const st = statSync(full);
          snap.set(relative(dir, full).replace(/\\/g, "/"), {
            size: st.size,
            mtimeMs: st.mtimeMs,
            sha256: sha256File(full),
          });
        } catch {
          // 单文件读不到，跳过
        }
      }
    };
    walk(dir);
  } catch {
    // 目录不存在 → 空快照
  }
  return snap;
}

/**
 * 对比两个快照。
 *
 * @param {Map} before
 * @param {Map} after
 * @returns {{added: string[], modified: string[], removed: string[]}}
 */
export function diffSnapshots(before, after) {
  const added = [];
  const modified = [];
  const removed = [];
  for (const [rel, info] of after) {
    if (!before.has(rel)) {
      added.push(rel);
    } else if (info.sha256 !== before.get(rel).sha256) {
      modified.push(rel);
    }
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) removed.push(rel);
  }
  return { added, modified, removed };
}

/**
 * 把一份差异翻译成信封用的 sideEffects 项。
 *
 * @param {{added: string[], modified: string[], removed: string[]}} diff
 * @param {string} dirLabel 目录的人类可读标签（如 `.story/work/第021章`）
 * @returns {Array<{kind: string, target: string, detail: string}>}
 */
export function diffToSideEffects(diff, dirLabel) {
  const out = [];
  for (const rel of diff.added) out.push({ kind: "file-added", target: `${dirLabel}/${rel}`, detail: "本次调用新增的文件" });
  for (const rel of diff.modified) out.push({ kind: "file-modified", target: `${dirLabel}/${rel}`, detail: "本次调用改写过的文件" });
  for (const rel of diff.removed) out.push({ kind: "file-removed", target: `${dirLabel}/${rel}`, detail: "本次调用删除的文件" });
  return out;
}
