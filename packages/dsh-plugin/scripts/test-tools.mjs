#!/usr/bin/env node
/**
 * 工具面回归测试（wayfinder #8 验收：真实业务结果 + 每条错误路径的可读报错）。
 *
 * 覆盖两条通路：
 *
 *  A. **装配通路**：`apply(fakeCtx)` 注册全部工具，再从注册表里取出定义直接 execute——
 *     验证「注册出来的东西真的能用」，同时校验返回值形状与 `ENVELOPE_SCHEMA` 一致。
 *  B. **错误路径**：注入环境变量/假审批服务构造故障（Python 不可用、Node 不可用、
 *     脚本缺失、审批被拒/不可用、PATH 里没有 node 导致 storyctl exit 3 等），
 *     断言错误码稳定、报错可读、有下一步。
 *
 * 真实业务结果全部来自仓库真实内容：
 *   - `demo/长篇/…` 书目录（第 021 章，2068 字 / 目标 2300，status ready）——章节链路；
 *   - `demo/去AI味对照/改前.md`（8 处命中 / 7 blocking）与改后.md（零命中）——检测器链路；
 *   - 临时目录里的书副本 / 正文副本 —— 破坏性实验（fix、commit）绝不动仓库原件。
 *
 * 退出码：0 = 全绿；非 0 = 有失败（每个失败都打印名字 + 首个断言错误）。
 * 运行：`node scripts/test-tools.mjs`（或子包内 `pnpm test:tools`）。
 *
 * 注意：本测试需要真实 Python 3 与 Node 在 PATH 上（探测链会跳过 Store 占位）。
 * 测试会短暂修改临时目录里的文件副本，仓库本身零改动。
 */

import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import assert from "node:assert/strict";

import { apply } from "../lib/index.js";
import { createRuntime } from "../lib/runtime/index.js";
import { ENVELOPE_SCHEMA } from "../lib/runtime/envelope.js";
import { createEnvTool } from "../lib/tools/env.js";
import { createWordcountTool } from "../lib/tools/wordcount.js";
import { createChapterCheckTool } from "../lib/tools/chapter-check.js";
import { createChapterCommitTool } from "../lib/tools/chapter-commit.js";
import { createAiPatternsTool } from "../lib/tools/ai-patterns.js";
import { createDegenerationTool } from "../lib/tools/degeneration.js";
import { createPunctuationTool } from "../lib/tools/punctuation.js";

// ────────────────────────── 路径与夹具 ──────────────────────────
//
// 子进程 stdout/stderr 的传输方式由环境变量 OH_STORY_USE_FILE_STDIO 决定：
//   - 不设（默认）：管道（生产路径，DSH 宿主与正常终端都是这条）；
//   - "1"：临时文件传输（受限沙箱禁止命名管道时用，见 lib/runtime/proc.js）。
// 本文件不自己设这个变量，让调用方（CI / 沙箱 / 普通终端）自己选。

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PACKAGE_DIR = resolve(import.meta.dirname, "..");
const DEMO_BOOK = join(REPO_ROOT, "demo", "长篇", "让你管账号，你高燃混剪炸全网");
const DEMO_AI_PRE = join(REPO_ROOT, "demo", "去AI味对照", "改前.md");
const DEMO_AI_POST = join(REPO_ROOT, "demo", "去AI味对照", "改后.md");
const TRACKING_SCRIPT = join(PACKAGE_DIR, "skills", "story-long-write", "scripts", "tracking_commit.py");

// 测试前先确认真实夹具在（避免「测试全绿但什么都没测」）
for (const [label, p] of [
  ["demo 书目录", DEMO_BOOK],
  ["改前.md", DEMO_AI_PRE],
  ["改后.md", DEMO_AI_POST],
  ["tracking_commit.py", TRACKING_SCRIPT],
]) {
  if (!existsSync(p)) {
    console.error(`夹具缺失（${label}）：${p}`);
    process.exit(2);
  }
}

const TMP_ROOT = mkdtempSync(join(tmpdir(), "oh-story-dsh-tools-"));
let seq = 0;
function freshDir(label) {
  const d = join(TMP_ROOT, `${String(seq++).padStart(3, "0")}-${label}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function freshBook(label) {
  const dest = join(freshDir(label), "book");
  cpSync(DEMO_BOOK, dest, { recursive: true });
  return dest;
}
function copyBodyFile(label) {
  const dest = join(freshDir(label), "x.md");
  cpSync(DEMO_AI_PRE, dest);
  return dest;
}
function degenerateFile(label) {
  const dest = join(freshDir(label), "degenerate.md");
  writeFileSync(
    dest,
    "他知道现在不是犹豫的时候，因为时间已经不允许他再犹豫了。\n" +
      "他知道现在不是犹豫的时候，因为时间已经不允许他再犹豫了。\n" +
      "他知道现在不是犹豫的时候，因为时间已经不允许他再犹豫了。\n" +
      "江晨翻开细纲看了本章的条目。\n" +
      "我无法继续写下去了。\n" +
      "他还没说完",
    "utf8",
  );
  return dest;
}
function injectDivider(bodyPath) {
  const text = readFileSync(bodyPath, "utf8");
  writeFileSync(bodyPath, text.replace(/\s+$/, "") + "\n---\n", "utf8");
}
function chapterWorkDirPath(book, chapter) {
  const width = Math.max(3, String(chapter).length);
  return join(book, ".story", "work", `第${String(chapter).padStart(width, "0")}章`);
}

// ────────────────────────── 小测试框架 ──────────────────────────

const results = [];
const pending = [];
function test(name, fn) {
  const p = (async () => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`PASS  ${name} (${Date.now() - t0}ms)`);
    } catch (err) {
      results.push({ name, ok: false, err });
      console.error(`FAIL  ${name} (${Date.now() - t0}ms)`);
      const msg = err && err.stack ? err.stack.split("\n").slice(0, 5).join("\n      ") : String(err);
      console.error(`      ${msg}`);
    }
  })();
  pending.push(p);
  return p;
}

// ────────────────────────── 工具执行辅助 ──────────────────────────

/** 浅校验信封形状（与 ENVELOPE_SCHEMA 一致：required 都在、无额外键、类型对）。 */
function envelopeViolations(value, schema = ENVELOPE_SCHEMA, path = "$") {
  const violations = [];
  const props = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in props)) violations.push(`${path}.${key} 不在 schema 里`);
    }
  }
  for (const req of schema.required ?? []) {
    if (!(req in value)) violations.push(`${path}.${req} 缺失（required）`);
  }
  for (const [key, val] of Object.entries(value)) {
    const ps = props[key];
    if (!ps || val === null || val === undefined) continue;
    if (ps.type === "string" && typeof val !== "string") violations.push(`${path}.${key} 应为 string`);
    if (ps.type === "boolean" && typeof val !== "boolean") violations.push(`${path}.${key} 应为 boolean`);
    if (ps.type === "integer" && !Number.isInteger(val)) violations.push(`${path}.${key} 应为 integer`);
    if (ps.type === "object" && typeof val !== "object") violations.push(`${path}.${key} 应为 object`);
    if (ps.type === "array" && !Array.isArray(val)) violations.push(`${path}.${key} 应为 array`);
  }
  return violations;
}

function assertEnvelope(value) {
  const violations = envelopeViolations(value);
  assert.deepEqual(violations, [], `信封形状违规：${violations.join("；")}`);
}

function fakeExec(cwd) {
  return {
    agent: { session: { header: { cwd: cwd ?? process.cwd() } } },
    callId: `call-${++seq}`,
    signal: new AbortController().signal,
  };
}

/** 通过 apply 注册表执行工具（A 组通路）；probe 走自己的 schema。 */
async function execRegistered(def, args, cwd) {
  const value = await def.execute(args, fakeExec(cwd));
  if (def.name !== "oh_story_probe") assertEnvelope(value);
  return value;
}

/** 直接工厂 + 注入环境/审批（B 组通路）。 */
function makeDefs({ env = {}, allowHostNodeFallback = true, approval } = {}) {
  const ctxShim = {
    get(name) {
      if (name === "approval") return approval ?? undefined;
      return undefined;
    },
  };
  const runtime = createRuntime({
    env: { ...process.env, ...env },
    ctx: ctxShim,
    allowHostNodeFallback,
  });
  return {
    runtime,
    defs: {
      env: createEnvTool(runtime),
      wordcount: createWordcountTool(runtime),
      chapterCheck: createChapterCheckTool(runtime),
      chapterCommit: createChapterCommitTool(runtime),
      aiPatterns: createAiPatternsTool(runtime),
      degeneration: createDegenerationTool(runtime),
      punctuation: createPunctuationTool(runtime),
    },
  };
}

const approvalAllow = { request: async () => "allowed-once" };
const approvalReject = { request: async () => "rejected" };

/** 用 tracking_commit.py 生成第 N 章的事务 JSON（提交链路的前置）。 */
async function runDraft(book, chapter = 21) {
  const rt = createRuntime({ env: process.env });
  const ran = await rt.runPython(TRACKING_SCRIPT, ["draft", "--project", book, "--chapter", String(chapter)], {});
  assert.ok(ran.ok, `tracking_commit.py draft 失败：${ran.error?.message ?? ""} ${ran.error?.nextStep ?? ""}`);
  if (ran.outcome.exitCode !== 0) {
    assert.fail(`draft exit=${ran.outcome.exitCode}\nstdout=${ran.outcome.stdout}\nstderr=${ran.outcome.stderr}`);
  }
  const tx = join(chapterWorkDirPath(book, chapter), "tracking.json");
  assert.ok(existsSync(tx), `draft 没生成 tracking.json：${tx}`);
  return tx;
}

/** PATH 里去掉「当前 node 可执行文件所在目录」（复现 storyctl exit 3：缺 node）。
 *  只摘 node 自己的目录，不误伤 python / 系统目录；PATH 摘空（沙箱极端情况）时由测试跳过。 */
function envWithoutNode() {
  const nodeDir = dirname(process.execPath).replace(/[\\/]+$/, "").toLowerCase();
  const env = { ...process.env };
  env.PATH = (env.PATH ?? "")
    .split(";")
    .filter((p) => p && p.replace(/[\\/]+$/, "").toLowerCase() !== nodeDir)
    .join(";");
  return env;
}

// ────────────────────────── A 组：装配通路 ──────────────────────────

const EXPECTED_TOOLS = [
  "oh_story_env",
  "oh_story_wordcount",
  "oh_story_chapter_check",
  "oh_story_chapter_commit",
  "oh_story_ai_patterns_check",
  "oh_story_degeneration_check",
  "oh_story_punctuation_normalize",
  "oh_story_probe",
];

test("A1: apply() 注册 8 个工具，每个都有 output.schema/render 与像样的 description", async () => {
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(def) { registered.push(def); return () => {}; } },
    get: () => undefined,
    effect() {},
    inject() {},
    plugin() {},
    on() {},
  };
  apply(ctx, {});
  const names = registered.map((d) => d.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort(), `注册名不符：${names.join(",")}`);
  for (const def of registered) {
    assert.ok(def.output && def.output.schema, `${def.name} 缺 output.schema`);
    assert.equal(typeof def.output.render, "function", `${def.name} 缺 output.render`);
    assert.ok(def.description && def.description.length > 40, `${def.name} description 太短（${def.description?.length ?? 0} 字符）`);
    assert.ok(def.parameters && def.parameters.type === "object", `${def.name} parameters 应为 object schema`);
  }
});

test("A2: oh_story_probe 返回插件事实（#5 探针保留）", async () => {
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(def) { registered.push(def); return () => {}; } },
    get: () => undefined,
    effect() {},
    inject() {},
    plugin() {},
    on() {},
  };
  apply(ctx, {});
  const probe = registered.find((d) => d.name === "oh_story_probe");
  const value = await probe.execute({ echo: "hello" }, fakeExec(process.cwd()));
  assert.equal(value.ok, true);
  assert.equal(value.plugin, "dsh-oh-story-claudecode");
  assert.equal(value.version, "0.2.0");
  assert.equal(value.echo, "hello");
  assert.equal(value.bundledSkillDirExists, true);
});

test("A3: oh_story_env 报出可用解释器与脚本落点", async () => {
  const { defs } = makeDefs();
  const value = await execRegistered(defs.env, {}, process.cwd());
  assert.equal(value.ok, true);
  assert.equal(value.result.python.ok, true, "Python 探测应成功");
  assert.equal(value.result.node.ok, true, "Node 探测应成功");
  for (const s of value.result.scripts) assert.equal(s.exists, true, `脚本缺失：${s.key}`);
  assert.ok(value.result.python.tried.length >= 1, "python 探测链至少记录 1 个候选");
  assert.ok(value.result.node.tried.length >= 1, "node 探测链至少记录 1 个候选");
});

test("A4: wordcount measure 在真实章节上数出 2068 字（visible_chars_v1）", async () => {
  const { defs } = makeDefs();
  const chapter = join(DEMO_BOOK, "正文", "第021章_离别怎么会开花.md");
  assert.ok(existsSync(chapter), "demo 第021章不存在");
  const value = await execRegistered(defs.wordcount, { action: "measure", file: chapter }, process.cwd());
  assert.equal(value.ok, true);
  assert.equal(value.result.actual, 2068, "可见字数应为 2068（#3 实测值）");
  assert.equal(value.result.status, "measured");
  assert.equal(value.result.metric, "visible_chars_v1");
  assert.match(value.command, /storyctl\.py wordcount measure/);
});

test("A5: wordcount check 对 target 2300 判 internal_pass", async () => {
  const { defs } = makeDefs();
  const chapter = join(DEMO_BOOK, "正文", "第021章_离别怎么会开花.md");
  const value = await execRegistered(defs.wordcount, { action: "check", file: chapter, target: 2300 }, process.cwd());
  assert.equal(value.ok, true);
  assert.equal(value.result.status, "internal_pass");
  assert.equal(value.status, "internal_pass");
});

test("A6: wordcount checkpoint 用 project+chapter 给出剩余区间", async () => {
  const { defs } = makeDefs();
  const chapter = join(DEMO_BOOK, "正文", "第021章_离别怎么会开花.md");
  const value = await execRegistered(
    defs.wordcount,
    { action: "checkpoint", file: chapter, project: DEMO_BOOK, chapter: 21 },
    process.cwd(),
  );
  assert.equal(value.ok, true);
  assert.ok(
    value.result.remaining_user_range && typeof value.result.remaining_user_range === "object",
    "应有 remaining_user_range 对象",
  );
  assert.equal(typeof value.result.remaining_user_range.min, "number");
  assert.equal(typeof value.result.remaining_user_range.max, "number");
  assert.equal(typeof value.result.target, "number");
});

test("A7: ai-patterns 在改前.md 上命中 8 处（7 blocking），exit 1 是业务结果", async () => {
  const { defs } = makeDefs();
  const value = await execRegistered(defs.aiPatterns, { files: [DEMO_AI_PRE], failOn: "blocking" }, process.cwd());
  assert.equal(value.ok, true, "有发现是业务结果，不是故障");
  assert.equal(value.status, "findings");
  assert.equal(value.exitCode, 1);
  assert.equal(value.counts.total, 8, "demo 期望 8 处命中（README）");
  assert.equal(value.counts.blocking, 7, "demo 期望 7 处 blocking");
  assert.equal(value.result.findings.length, 8);
  assert.ok(value.result.findings[0].file && value.result.findings[0].type, "finding 应有 file/type");
});

test("A8: ai-patterns 在改后.md 上零命中，exit 0", async () => {
  const { defs } = makeDefs();
  const value = await execRegistered(defs.aiPatterns, { files: [DEMO_AI_POST] }, process.cwd());
  assert.equal(value.ok, true);
  assert.equal(value.status, "clean");
  assert.equal(value.exitCode, 0);
  assert.equal(value.counts.total, 0);
});

test("A9: degeneration 在构造退化文件上命中 blocking（复读/泄漏/截断）", async () => {
  const { defs } = makeDefs();
  const bad = degenerateFile("degen");
  const value = await execRegistered(defs.degeneration, { files: [bad] }, process.cwd());
  assert.equal(value.ok, true);
  assert.equal(value.status, "findings");
  assert.equal(value.exitCode, 1);
  assert.ok(value.counts.blocking >= 1, "应有 blocking 退化信号");
  const types = value.result.findings.map((f) => f.type);
  assert.ok(types.includes("verbatim-repeat"), `应有 verbatim-repeat：${types.join(",")}`);
  assert.ok(types.includes("meta-leak") || types.includes("placeholder-leak"), "应有泄漏类信号");
});

test("A10: punctuation --check 只读检出问题，不落盘", async () => {
  const { defs } = makeDefs();
  const copy = copyBodyFile("punct-check");
  const before = readFileSync(copy, "utf8");
  const value = await execRegistered(defs.punctuation, { files: [copy] }, process.cwd());
  assert.equal(value.ok, true);
  assert.equal(value.status, "findings");
  assert.ok(value.result.findings.length >= 1, "改前.md 应有标点问题");
  assert.equal(readFileSync(copy, "utf8"), before, "--check 不得改动文件");
});

test("A11: punctuation fix 审批放行后改写 1 个文件、再跑幂等 noop", async () => {
  const { defs } = makeDefs({ approval: approvalAllow });
  const copy = copyBodyFile("punct-fix");
  const sha1 = createHash("sha256").update(readFileSync(copy)).digest("hex");

  const v1 = await execRegistered(defs.punctuation, { files: [copy], fix: true }, process.cwd());
  assert.equal(v1.ok, true);
  assert.equal(v1.status, "done");
  assert.equal(v1.result.changedCount, 1, "第一次 fix 应改动 1 个文件");
  assert.ok(v1.sideEffects.some((s) => s.kind === "file-modified"), "应有 file-modified 副作用");
  assert.equal(v1.approval.via, "approval", "应走人工审批通道");
  const sha2 = createHash("sha256").update(readFileSync(copy)).digest("hex");
  assert.notEqual(sha1, sha2, "文件应被改写");

  const v2 = await execRegistered(defs.punctuation, { files: [copy], fix: true }, process.cwd());
  assert.equal(v2.ok, true);
  assert.equal(v2.status, "noop", "第二次 fix 应幂等 noop");
  assert.equal(v2.result.changedCount, 0);
  const sha3 = createHash("sha256").update(readFileSync(copy)).digest("hex");
  assert.equal(sha2, sha3, "幂等：第二次不得再改文件");
});

test("A12: chapter check 在真实书目录上返回 ready", async () => {
  const { defs } = makeDefs();
  const book = freshBook("check-ready");
  const value = await execRegistered(defs.chapterCheck, { project: book, chapter: 21 }, process.cwd());
  assert.equal(value.ok, true);
  assert.equal(value.status, "ready");
  assert.equal(value.exitCode, 0);
  assert.ok(value.result.available_actions.includes("commit"));
  assert.equal(value.result.length.actual, 2068);
});

test("A13: chapter check 超长（作者范围 500-1000）时 status=needs_decision 且副作用如实报出 baseline", async () => {
  const { defs } = makeDefs();
  const book = freshBook("check-over");
  const value = await execRegistered(
    defs.chapterCheck,
    { project: book, chapter: 21, minChars: 500, maxChars: 1000 },
    process.cwd(),
  );
  assert.equal(value.ok, true);
  assert.equal(value.status, "needs_decision");
  assert.equal(value.result.compression.mode, "single_pass_remove_only");
  const baseline = value.sideEffects.find(
    (s) => s.kind === "file-added" && s.target.includes("over_length_baseline.json"),
  );
  assert.ok(baseline, `应有 over_length_baseline.json 副作用：${JSON.stringify(value.sideEffects)}`);
});

test("A14: 正文带分隔线时 chapter check 返回 blocked（exit 1 是业务判定）", async () => {
  const { defs } = makeDefs();
  const book = freshBook("check-blocked");
  injectDivider(join(book, "正文", "第021章_离别怎么会开花.md"));
  const value = await execRegistered(defs.chapterCheck, { project: book, chapter: 21 }, process.cwd());
  assert.equal(value.ok, true);
  assert.equal(value.status, "blocked");
  assert.equal(value.exitCode, 1);
  assert.ok(value.result.quality.blocking_findings.length >= 1, "应有 blocking findings");
});

test("A15: chapter check --fix-punctuation 审批放行后把 blocked 修回 ready，正文被改写", async () => {
  const { defs } = makeDefs({ approval: approvalAllow });
  const book = freshBook("check-fix");
  const body = join(book, "正文", "第021章_离别怎么会开花.md");
  injectDivider(body);
  const before = readFileSync(body, "utf8");

  const v1 = await execRegistered(defs.chapterCheck, { project: book, chapter: 21 }, process.cwd());
  assert.equal(v1.status, "blocked");

  const v2 = await execRegistered(defs.chapterCheck, { project: book, chapter: 21, fixPunctuation: true }, process.cwd());
  assert.equal(v2.ok, true);
  assert.equal(v2.status, "ready", "fix 后应回到 ready");
  assert.equal(v2.result.punctuation_fixed, true);
  assert.notEqual(readFileSync(body, "utf8"), before, "正文应被改写");
  assert.ok(v2.sideEffects.some((s) => s.kind === "file-modified" && s.target === body), "应有正文改写的副作用");
});

test("A16: chapter commit 完整链路（draft → check → commit）在真实书副本上成功", async () => {
  const { defs } = makeDefs({ approval: approvalAllow });
  const book = freshBook("commit-ok");
  const tx = await runDraft(book, 21);

  const check = await execRegistered(defs.chapterCheck, { project: book, chapter: 21 }, process.cwd());
  assert.equal(check.status, "ready");

  const stateBefore = readFileSync(join(book, "追踪", "_tracking-state.json"), "utf8");
  const value = await execRegistered(
    defs.chapterCommit,
    { project: book, chapter: 21, input: tx },
    process.cwd(),
  );
  assert.equal(value.ok, true);
  assert.equal(value.status, "committed");
  assert.equal(value.approval.via, "approval");
  assert.ok(
    value.sideEffects.some((s) => s.kind === "file-modified" && s.target.includes("_tracking-state.json")),
    "追踪状态应有修改副作用",
  );
  assert.ok(
    value.sideEffects.some((s) => s.kind === "dir-removed" && s.target.includes("第021章")),
    "工作目录应有删除副作用",
  );
  assert.notEqual(
    readFileSync(join(book, "追踪", "_tracking-state.json"), "utf8"),
    stateBefore,
    "追踪状态应真的变了",
  );
});

test("A17: chapter commit 不幂等：状态在 draft 之后被推进 → TRANSACTION_STALE + 重新 draft 的下一步", async () => {
  const { defs } = makeDefs({ approval: approvalAllow });
  const book = freshBook("commit-stale");
  const tx = await runDraft(book, 21);

  // 复现「事务按旧状态构造」：draft 记录 expected_state_revision=1，提交前把
  // 追踪状态的 state_revision 推进一步（等价于期间有人提交了别的章）。
  const statePath = join(book, "追踪", "_tracking-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.state_revision = (state.state_revision ?? 1) + 1;
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  const value = await execRegistered(
    defs.chapterCommit,
    { project: book, chapter: 21, input: tx },
    process.cwd(),
  );
  assert.equal(value.ok, false, `应失败：${value.error?.message ?? ""}`);
  assert.equal(value.error.code, "TRANSACTION_STALE");
  assert.match(value.error.message, /tracking state changed|状态/);
  assert.match(value.error.nextStep, /draft/);
  assert.match(value.error.nextStep, /21/);
  assert.ok(
    existsSync(tx),
    "失败时事务文件应保留（work dir 不删），供重新 draft 前参考",
  );
});

test("A18: commit 被审批拒绝：APPROVAL_REJECTED，追踪状态一字未动", async () => {
  const { defs } = makeDefs({ approval: approvalReject });
  const book = freshBook("commit-rejected");
  const tx = await runDraft(book, 21);
  const stateBefore = readFileSync(join(book, "追踪", "_tracking-state.json"), "utf8");

  const value = await execRegistered(
    defs.chapterCommit,
    { project: book, chapter: 21, input: tx, confirm: true }, // confirm 不得绕过 rejected
    process.cwd(),
  );
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "APPROVAL_REJECTED");
  assert.match(value.error.nextStep, /不要重试/);
  assert.equal(readFileSync(join(book, "追踪", "_tracking-state.json"), "utf8"), stateBefore, "被拒不得写状态");
});

test("A19: commit 审批通道不可用 + confirm=true 走显式确认回退并如实标注", async () => {
  const { defs } = makeDefs(); // 无审批服务
  const book = freshBook("commit-confirm");
  const tx = await runDraft(book, 21);
  const value = await execRegistered(
    defs.chapterCommit,
    { project: book, chapter: 21, input: tx, confirm: true },
    process.cwd(),
  );
  assert.equal(value.ok, true);
  assert.equal(value.approval.via, "explicit-confirm");
  assert.match(value.approval.detail, /回退通道/);
});

// ────────────────────────── B 组：错误路径 ──────────────────────────

test("B1: Python 不可用（OH_STORY_PYTHON 指向不存在的解释器）→ PYTHON_UNAVAILABLE 可读报错", async () => {
  const { defs } = makeDefs({ env: { OH_STORY_PYTHON: "definitely-not-a-real-python-xyz" } });
  const chapter = join(DEMO_BOOK, "正文", "第021章_离别怎么会开花.md");
  const value = await execRegistered(defs.wordcount, { action: "measure", file: chapter }, process.cwd());
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "PYTHON_UNAVAILABLE");
  assert.ok(value.error.message.length > 10, "报错应是人话");
  assert.ok(value.error.nextStep, "应有下一步");
});

test("B2: Node 不可用（OH_STORY_NODE 指向不存在 + 关宿主回退）→ NODE_UNAVAILABLE", async () => {
  const { defs } = makeDefs({
    env: { OH_STORY_NODE: "definitely-not-a-real-node-xyz" },
    allowHostNodeFallback: false,
  });
  const value = await execRegistered(defs.aiPatterns, { files: [DEMO_AI_POST] }, process.cwd());
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "NODE_UNAVAILABLE");
  assert.ok(value.error.nextStep, "应有下一步");
});

test("B3: 随包脚本缺失（OH_STORY_SKILLS_DIR 指向空目录）→ SCRIPT_MISSING + env 里脚本全红", async () => {
  const empty = freshDir("empty-skills");
  const { defs } = makeDefs({ env: { OH_STORY_SKILLS_DIR: empty } });
  const envValue = await execRegistered(defs.env, {}, process.cwd());
  assert.equal(envValue.result.scripts.every((s) => s.exists === false), true, "脚本应全部缺失");

  const chapter = join(DEMO_BOOK, "正文", "第021章_离别怎么会开花.md");
  const value = await execRegistered(defs.wordcount, { action: "measure", file: chapter }, process.cwd());
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "SCRIPT_MISSING");
  assert.match(value.error.message, /storyctl\.py/);
  assert.ok(value.error.nextStep, "应有下一步");
});

test("B4: wordcount check 缺 target → INVALID_ARGUMENT（起子进程前拦住）", async () => {
  const { defs } = makeDefs();
  const chapter = join(DEMO_BOOK, "正文", "第021章_离别怎么会开花.md");
  const value = await execRegistered(defs.wordcount, { action: "check", file: chapter }, process.cwd());
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "INVALID_ARGUMENT");
});

test("B5: wordcount 文件不存在 → PATH_NOT_FOUND", async () => {
  const { defs } = makeDefs();
  const value = await execRegistered(
    defs.wordcount,
    { action: "measure", file: join(TMP_ROOT, "no-such-file.md") },
    process.cwd(),
  );
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "PATH_NOT_FOUND");
});

test("B6: chapter check 项目目录不存在 → PATH_NOT_FOUND", async () => {
  const { defs } = makeDefs();
  const value = await execRegistered(defs.chapterCheck, { project: join(TMP_ROOT, "no-such-book"), chapter: 21 }, process.cwd());
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "PATH_NOT_FOUND");
});

test("B7: chapter check 章节 99（无细纲）→ 脚本 exit 2，error_code 透出且可读", async () => {
  const { defs } = makeDefs();
  const book = freshBook("check-99");
  const value = await execRegistered(defs.chapterCheck, { project: book, chapter: 99 }, process.cwd());
  assert.equal(value.ok, false);
  assert.equal(value.exitCode, 2);
  assert.equal(value.error.code, "CHECK_FAILED");
  assert.match(value.error.message, /99/);
  assert.ok(value.error.nextStep, "应有下一步");
});

test("B8: punctuation quoteMode 非法 → INVALID_ARGUMENT", async () => {
  const { defs } = makeDefs();
  const copy = copyBodyFile("punct-quote");
  const value = await execRegistered(defs.punctuation, { files: [copy], quoteMode: "bogus" }, process.cwd());
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "INVALID_ARGUMENT");
  assert.match(value.error.message, /quoteMode/);
});

test("B9: 破坏性动作审批通道不可用且未 confirm → APPROVAL_REQUIRED（fail closed，不落盘）", async () => {
  const { defs } = makeDefs(); // 无审批
  const book = freshBook("commit-noapproval");
  const tx = await runDraft(book, 21);
  const stateBefore = readFileSync(join(book, "追踪", "_tracking-state.json"), "utf8");
  const value = await execRegistered(
    defs.chapterCommit,
    { project: book, chapter: 21, input: tx },
    process.cwd(),
  );
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "APPROVAL_REQUIRED");
  assert.equal(readFileSync(join(book, "追踪", "_tracking-state.json"), "utf8"), stateBefore, "fail closed：不得写");
});

test("B10: PATH 里没有 node → storyctl exit 3 → TOOL_UNAVAILABLE 且下一步指向装 Node", async () => {
  const stripped = envWithoutNode();
  if (!stripped.PATH) {
    console.log("      SKIP：沙箱 PATH 不可用，无法复现「PATH 里缺 node」场景");
    return;
  }
  const { defs } = makeDefs({ env: stripped, allowHostNodeFallback: false });
  const book = freshBook("exit3");
  const value = await execRegistered(defs.chapterCheck, { project: book, chapter: 21 }, process.cwd());
  assert.equal(value.ok, false);
  assert.equal(value.status, "tool_unavailable");
  assert.equal(value.exitCode, 3);
  assert.equal(value.error.code, "TOOL_UNAVAILABLE");
  assert.match(value.error.nextStep, /Node/i);
});

test("B11: 并发 fix 同一文件被进程内互斥串行化，两次都成功、文件最终干净", async () => {
  const { defs } = makeDefs({ approval: approvalAllow });
  const copy = copyBodyFile("punct-race");
  const [v1, v2] = await Promise.all([
    defs.punctuation.execute({ files: [copy], fix: true }, fakeExec(process.cwd())),
    defs.punctuation.execute({ files: [copy], fix: true }, fakeExec(process.cwd())),
  ]);
  assert.equal(v1.ok, true, `第一次 fix 失败：${v1.error?.message ?? ""}`);
  assert.equal(v2.ok, true, `第二次 fix 失败：${v2.error?.message ?? ""}`);
  const v3 = await execRegistered(defs.punctuation, { files: [copy] }, process.cwd());
  assert.equal(v3.status, "clean", "并发写后文件应处于干净状态（幂等）");
});

test("B12: wordcount checkpoint 既无 target 也无 project → INVALID_ARGUMENT", async () => {
  const { defs } = makeDefs();
  const chapter = join(DEMO_BOOK, "正文", "第021章_离别怎么会开花.md");
  const value = await execRegistered(defs.wordcount, { action: "checkpoint", file: chapter }, process.cwd());
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "INVALID_ARGUMENT");
});

test("B13: 检测器 files 为空 → INVALID_ARGUMENT", async () => {
  const { defs } = makeDefs();
  const value = await execRegistered(defs.aiPatterns, { files: [] }, process.cwd());
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "INVALID_ARGUMENT");
});

test("B14: chapter check 只给 minChars → INVALID_ARGUMENT（范围必须同给）", async () => {
  const { defs } = makeDefs();
  const book = freshBook("range-pair");
  const value = await execRegistered(defs.chapterCheck, { project: book, chapter: 21, minChars: 500 }, process.cwd());
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "INVALID_ARGUMENT");
});

test("B15: commit input 事务文件不存在 → PATH_NOT_FOUND", async () => {
  const { defs } = makeDefs({ approval: approvalAllow });
  const book = freshBook("commit-noinput");
  const value = await execRegistered(
    defs.chapterCommit,
    { project: book, chapter: 21, input: join(book, ".story", "work", "第021章", "missing.json") },
    process.cwd(),
  );
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "PATH_NOT_FOUND");
});

// ────────────────────────── 收尾 ──────────────────────────

Promise.allSettled(pending).then(() => {
  const failed = results.filter((r) => !r.ok);
  console.log("\n────────────────────────────────────────────");
  console.log(`工具面测试：${results.length} 项，${failed.length} 项失败。`);
  if (failed.length > 0) {
    console.error("失败清单：");
    for (const f of failed) console.error(`  - ${f.name}`);
    process.exitCode = 1;
  }
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // 清理失败不掩盖测试结果
  }
});
