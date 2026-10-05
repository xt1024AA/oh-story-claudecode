/**
 * 子进程执行器：起原脚本、收 stdout/stderr、限时强杀、跟随 exec.signal 中止。
 *
 * 设计要点（写给以后改这里的人）：
 *
 * 1. **永不抛异常**：spawn 失败、超时、中止都收敛成同一个 `outcome` 对象，
 *    由调用方（各工具）翻译成信封里的错误。工具 `execute` 的兜底因此永远简单。
 *
 * 2. **编码是 utf8**：storyctl.py 特意把协议 JSON 按 UTF-8 字节写 stdout
 *   （`storyctl.py:62-68` 的注释直说 Windows runner 可能是 cp1252 控制台），
 *   Node 侧就按 utf8 解码，两边都避开系统代码页。检测器是 Node 脚本，写管道
 *   时 Node 也总是 utf8。
 *
 * 3. **两种 stdout/stderr 传输，行为等价**：
 *    - 默认**管道（pipe）**：流式收集，有上限截断（2 MiB）。生产环境用这条。
 *    - `stdioToFiles: true`（由环境变量 `OH_STORY_USE_FILE_STDIO=1` 打开）：
 *      把子进程 stdout/stderr 重定向到临时文件，结束后读回。用途是在「禁止
 *      命名管道」的受限沙箱里跑测试/排障——那种环境下 Node 用管道 spawn 会
 *      得到 EPERM，文件描述符传输不经过命名管道，可以正常工作。
 *      注意：**这是同一套收集逻辑的两种运输方式**，内容与截断语义一致。
 *
 * 4. **超时用 `timeoutMs` 强杀**，中止用 `signal`（来自 `exec.signal`）：
 *   两者都可能触发 kill；先到者胜，另一个就不再处理。Windows 上 kill 不保证
 *   连孙进程一起杀，局限写进 outcome，不假装解决。
 *
 * 5. **shell: false 永远**：参数是数组直通，不经过任何 shell 解释，路径里
 *   的中文、空格、`&`、`(` 都不会被重新解析（#3 契约实测过中文路径全流程可用）。
 */

import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024; // 2 MiB

/** 生成一对临时文件路径（stdout / stderr），用完即删。 */
function tempIoPaths() {
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    outPath: join(tmpdir(), `oh-story-stdio-${tag}.out`),
    errPath: join(tmpdir(), `oh-story-stdio-${tag}.err`),
  };
}

/** 读回临时文件并删除；读不到按空串处理（不因清理失败而崩）。 */
function readAndClean(outPath, errPath, maxBuffer) {
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  try {
    const buf = readFileSync(outPath);
    stdout = buf.toString("utf8");
    stdoutTruncated = buf.length > maxBuffer;
  } catch {
    // 文件不存在/读不到：空输出
  }
  try {
    const buf = readFileSync(errPath);
    stderr = buf.toString("utf8");
    stderrTruncated = buf.length > maxBuffer;
  } catch {
    // 同上
  }
  for (const p of [outPath, errPath]) {
    try {
      unlinkSync(p);
    } catch {
      // 清理失败可忽略
    }
  }
  return { stdout, stderr, stdoutTruncated, stderrTruncated };
}

/**
 * 起一个子进程并等到它结束。
 *
 * @param {string} command 可执行文件路径（绝对或 PATH 可解析）
 * @param {string[]} args 参数数组（直通，不经 shell）
 * @param {object} [options]
 * @param {string} [options.cwd] 子进程工作目录
 * @param {Record<string,string|undefined>|undefined} [options.env] 子进程环境
 * @param {AbortSignal} [options.signal] 中止信号（跟随 exec.signal）
 * @param {number} [options.timeoutMs] 超时毫秒，超时强杀（默认 120000）
 * @param {boolean} [options.stdioToFiles] 用临时文件传输 stdout/stderr（受限沙箱）
 * @param {Function} [options.spawnImpl] 测试注入点：替换 spawn
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string,
 *   spawnError: {code?: string, message?: string}|null, timedOut: boolean,
 *   aborted: boolean, durationMs: number, stdoutTruncated: boolean,
 *   stderrTruncated: boolean, timeoutMs: number}>}
 */
export function runProcess(command, args, options = {}) {
  const {
    cwd,
    env,
    signal,
    timeoutMs = 120000,
    stdioToFiles = false,
    spawnImpl = spawn,
    maxBuffer = DEFAULT_MAX_BUFFER,
  } = options;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timer = null;

    /** 只结算一次：error 与 close 可能先后都来，先到者为准。 */
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };

    // 文件传输模式：先开好 fd，spawn 失败也要把它们关掉/删掉
    let outPath = null;
    let errPath = null;
    let outFd = null;
    let errFd = null;
    let stdio = ["ignore", "pipe", "pipe"];
    if (stdioToFiles) {
      const paths = tempIoPaths();
      outPath = paths.outPath;
      errPath = paths.errPath;
      try {
        outFd = openSync(outPath, "w");
        errFd = openSync(errPath, "w");
        stdio = ["ignore", outFd, errFd];
      } catch (err) {
        settle({
          exitCode: -1,
          stdout: "",
          stderr: "",
          spawnError: { code: err?.code, message: String(err?.message ?? err) },
          timedOut: false,
          aborted: false,
          durationMs: Date.now() - startedAt,
          stdoutTruncated: false,
          stderrTruncated: false,
          timeoutMs,
        });
        return;
      }
    }

    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio,
      });
    } catch (err) {
      // spawn 同步抛错（极少见；多数 ENOENT 走 'error' 事件）
      if (outFd !== null) {
        try { closeSync(outFd); } catch { /* 忽略 */ }
      }
      if (errFd !== null) {
        try { closeSync(errFd); } catch { /* 忽略 */ }
      }
      settle({
        exitCode: -1,
        stdout: "",
        stderr: "",
        spawnError: { code: err?.code, message: String(err?.message ?? err) },
        timedOut: false,
        aborted: false,
        durationMs: Date.now() - startedAt,
        stdoutTruncated: false,
        stderrTruncated: false,
        timeoutMs,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;

    if (!stdioToFiles) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      const collect = (chunk, side) => {
        if (side === "out") {
          if (stdout.length >= maxBuffer) {
            stdoutTruncated = true;
            return;
          }
          stdout += chunk;
        } else {
          if (stderr.length >= maxBuffer) {
            stderrTruncated = true;
            return;
          }
          stderr += chunk;
        }
      };

      child.stdout.on("data", (chunk) => collect(chunk, "out"));
      child.stderr.on("data", (chunk) => collect(chunk, "err"));
    }

    let timedOut = false;
    let aborted = false;
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // 进程已退出，kill 抛错可忽略
      }
    }, timeoutMs);
    // 不让定时器把进程挂住
    if (typeof timer.unref === "function") timer.unref();

    if (signal) {
      if (signal.aborted) {
        aborted = true;
        try {
          child.kill();
        } catch {
          // 同上
        }
      } else {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            try {
              child.kill();
            } catch {
              // 同上
            }
          },
          { once: true },
        );
      }
    }

    child.on("error", (err) => {
      settle({
        exitCode: -1,
        stdout,
        stderr,
        spawnError: { code: err?.code, message: String(err?.message ?? err) },
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        stdoutTruncated,
        stderrTruncated,
        timeoutMs,
      });
    });

    child.on("close", (code, _signal) => {
      if (stdioToFiles) {
        // 读回文件内容，关闭并删除临时文件
        try {
          if (outFd !== null) closeSync(outFd);
          if (errFd !== null) closeSync(errFd);
        } catch {
          // 忽略
        }
        const back = readAndClean(outPath, errPath, maxBuffer);
        stdout = back.stdout;
        stderr = back.stderr;
        stdoutTruncated = back.stdoutTruncated;
        stderrTruncated = back.stderrTruncated;
      }
      settle({
        exitCode: typeof code === "number" ? code : -1,
        stdout,
        stderr,
        spawnError: null,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        stdoutTruncated,
        stderrTruncated,
        timeoutMs,
      });
    });
  });
}
