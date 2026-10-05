/**
 * Python / Node 解释器探测。
 *
 * 为什么必须探测而不是直接用：仓库规矩（AGENTS.md「skill 文档禁止裸调 python3」）与
 * #3 契约实测都指向同一个坑——Windows 上 `python3` 常落到 Microsoft Store 的
 * 占位程序，跑 `-c ""` 无输出、exit 9009，误当「有 Python」。只有真的把
 * `-c ""` 跑一遍、退出码为 0，才算「这个解释器能用」。
 *
 * 探测链（顺序即优先级，与仓库既有规矩一致）：
 *   Python：`python3` → `python` → `py -3`
 *   Node：`node`（PATH）→ 宿主内置 Node（Electron-as-node，桌面宿主必然可用）
 *
 * 每个候选都跑真实命令验证，不是 `which`/`where` 看存在性（存在 ≠ 能执行）。
 *
 * 可观测性：每次探测的 `tried` 数组把每个候选的成败逐条带回来，模型能直接看到
 * 「python3 是 Store 占位、python 落到了 C:\Python314」这类事实。
 *
 * 环境变量覆盖（给测试与排障用，作者一般不需要碰）：
 *   - `OH_STORY_PYTHON`：强制指定解释器路径（跳过探测链；配错就报错，不静默回退）
 *   - `OH_STORY_NODE`：强制指定 node 可执行文件（同上）
 *   - `OH_STORY_DISABLE_HOST_NODE=1`：关掉「宿主内置 Node 回退」，只认 PATH 里的 node
 */

const PYTHON_CANDIDATES = [
  { bin: "python3", prefixArgs: [], label: "python3" },
  { bin: "python", prefixArgs: [], label: "python" },
  { bin: "py", prefixArgs: ["-3"], label: "py -3" },
];

const NODE_CANDIDATES = [
  { bin: "node", prefixArgs: [], label: "node" },
];

const PROBE_TIMEOUT_MS = 15000;

/**
 * 创建一个解释器探测器（每个 runtime 一个，带缓存）。
 *
 * @param {object} deps
 * @param {Record<string,string|undefined>} deps.env
 * @param {Function} deps.run  runProcess 的同构函数
 * @returns {{
 *   probePython: (opts?: {force?: boolean}) => Promise<object>,
 *   probeNode: (opts?: {force?: boolean}) => Promise<object>,
 *   pythonOk: () => boolean,
 *   nodeOk: () => boolean,
 * }}
 */
export function createInterpreterProbe(deps) {
  const { env, run } = deps;
  const cache = { python: null, node: null };

  /** 探测单个候选解释器是否真的能跑。 */
  async function tryCandidate(candidate, extraEnv) {
    const args = [...candidate.prefixArgs, "-c", ""];
    const outcome = await run(candidate.bin, args, {
      env: { ...env, ...(extraEnv ?? {}) },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (outcome.spawnError) {
      return {
        candidate: candidate.label,
        ok: false,
        detail: `无法启动（${outcome.spawnError.code ?? "?"}：${outcome.spawnError.message}）`,
      };
    }
    if (outcome.exitCode !== 0) {
      const hint = outcome.stderr.trim() || outcome.stdout.trim();
      return {
        candidate: candidate.label,
        ok: false,
        detail: `验证命令退出码 ${outcome.exitCode}${hint ? `（${hint.slice(0, 120)}）` : ""}`,
      };
    }
    return { candidate: candidate.label, ok: true, detail: "验证命令 `-c \"\"` 退出码 0" };
  }

  /** 给已通过的候选补一个版本号（失败不致命，写进 detail）。 */
  async function readVersion(bin, prefixArgs, extraEnv) {
    const outcome = await run(bin, [...prefixArgs, "--version"], {
      env: { ...env, ...(extraEnv ?? {}) },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (outcome.exitCode === 0) {
      return (outcome.stdout.trim() || outcome.stderr.trim()).split("\n")[0] || "";
    }
    return "";
  }

  async function probePython({ force = false } = {}) {
    if (!force && cache.python) return cache.python;
    const result = await probePythonUncached();
    cache.python = result;
    return result;
  }

  async function probePythonUncached() {
    const override = String(env.OH_STORY_PYTHON ?? "").trim();
    if (override) {
      // 作者显式指定：不探测链、不静默回退。配错了就明确报错，别让作者误以为在用别的解释器。
      const tried = [await tryCandidate({ bin: override, prefixArgs: [], label: `OH_STORY_PYTHON=${override}` }, undefined)];
      const ok = tried[0].ok;
      const version = ok ? await readVersion(override, [], undefined) : "";
      return {
        ok,
        bin: ok ? override : null,
        prefixArgs: [],
        version,
        label: ok ? tried[0].candidate : "",
        source: "env-override",
        tried,
        note: ok ? "解释器由环境变量 OH_STORY_PYTHON 指定（跳过探测链）" : "环境变量 OH_STORY_PYTHON 指定的解释器不可用；不会静默回退到探测链。",
      };
    }

    const tried = [];
    for (const candidate of PYTHON_CANDIDATES) {
      const attempt = await tryCandidate(candidate, undefined);
      tried.push(attempt);
      if (attempt.ok) {
        const version = await readVersion(candidate.bin, candidate.prefixArgs, undefined);
        return {
          ok: true,
          bin: candidate.bin,
          prefixArgs: candidate.prefixArgs,
          version,
          label: candidate.label,
          source: "probe",
          tried,
          note: "",
        };
      }
    }
    const storeHints = tried
      .filter((t) => /9009|49/.test(t.detail))
      .map((t) => `${t.candidate} 是命令占位程序`);
    return {
      ok: false,
      bin: null,
      prefixArgs: [],
      version: "",
      label: "",
      source: "probe",
      tried,
      note:
        "Python 探测链（python3 → python → py -3）全部失败。" +
        (storeHints.length > 0 ? `本机 ${storeHints.join("；")}，需要安装真正的 Python 3。` : "需要安装 Python 3。"),
    };
  }

  async function probeNode({ force = false } = {}) {
    if (!force && cache.node) return cache.node;
    const result = await probeNodeUncached();
    cache.node = result;
    return result;
  }

  async function probeNodeUncached() {
    const override = String(env.OH_STORY_NODE ?? "").trim();
    if (override) {
      const tried = [await tryCandidate({ bin: override, prefixArgs: [], label: `OH_STORY_NODE=${override}` }, undefined)];
      const ok = tried[0].ok;
      const version = ok ? await readVersion(override, [], undefined) : "";
      return {
        ok,
        bin: ok ? override : null,
        prefixArgs: [],
        version,
        label: ok ? tried[0].candidate : "",
        source: "env-override",
        tried,
        note: ok ? "node 由环境变量 OH_STORY_NODE 指定（跳过探测链）" : "环境变量 OH_STORY_NODE 指定的 node 不可用；不会静默回退。",
      };
    }

    const tried = [];
    for (const candidate of NODE_CANDIDATES) {
      const attempt = await tryCandidate(candidate, undefined);
      tried.push(attempt);
      if (attempt.ok) {
        const version = await readVersion(candidate.bin, candidate.prefixArgs, undefined);
        return {
          ok: true,
          bin: candidate.bin,
          prefixArgs: candidate.prefixArgs,
          version,
          label: candidate.label,
          source: "probe",
          tried,
          note: "",
        };
      }
    }

    // 宿主内置 Node 回退：桌面宿主（Electron）自己就是 Node，用它跑纯 Node 脚本
    // 与 PATH 里的 node 行为一致，且不依赖作者装没装 node。加了 ELECTRON_RUN_AS_NODE
    // 环境变量后 Electron 就是标准 Node（官方做法，仓库取证也这么用）。
    const disableHost = String(env.OH_STORY_DISABLE_HOST_NODE ?? "").trim() === "1";
    if (!disableHost && deps.hostNode && typeof deps.hostNode === "object") {
      const host = deps.hostNode; // { bin, extraEnv }
      const attempt = await tryCandidate({ bin: host.bin, prefixArgs: [], label: "宿主内置 Node" }, host.extraEnv);
      tried.push(attempt);
      if (attempt.ok) {
        const version = await readVersion(host.bin, [], host.extraEnv);
        return {
          ok: true,
          bin: host.bin,
          prefixArgs: [],
          version,
          label: "宿主内置 Node",
          source: "host-fallback",
          tried,
          note: "PATH 里没有可用 node，回退到宿主内置 Node（Electron-as-node）；与 storyctl.py 内部找 node 的口径不完全一致，仅本插件的检测器工具用它。",
        };
      }
    }

    return {
      ok: false,
      bin: null,
      prefixArgs: [],
      version: "",
      label: "",
      source: "probe",
      tried,
      note: "Node 探测失败：PATH 里没有可用的 node" + (disableHost ? "，且宿主内置 Node 回退被 OH_STORY_DISABLE_HOST_NODE 关闭" : ""),
    };
  }

  return {
    probePython,
    probeNode,
    pythonOk: () => cache.python?.ok === true,
    nodeOk: () => cache.node?.ok === true,
  };
}

/**
 * 从宿主进程取「内置 Node」信息（若本进程本身就是 Node/Electron）。
 *
 * 在 Electron 桌面宿主里，`process.execPath` 指向宿主 exe，配 `ELECTRON_RUN_AS_NODE=1`
 * 就是标准 Node；在纯 Node 进程里，`process.execPath` 就是 node 本身，无需额外环境。
 *
 * @returns {{bin: string, extraEnv: Record<string,string>}|null}
 */
export function detectHostNode() {
  if (typeof process?.execPath !== "string" || !process.execPath) return null;
  if (typeof process.versions?.electron === "string") {
    return { bin: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  // 纯 Node：execPath 就是解释器，但「node 不在 PATH」时 execPath 可能是别的名字
  // （如 pnpm 里的 node）。它仍是合法解释器，直接当候选用。
  return { bin: process.execPath, extraEnv: {} };
}
