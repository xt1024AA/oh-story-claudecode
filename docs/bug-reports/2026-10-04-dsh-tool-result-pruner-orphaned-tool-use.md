# [Bug] 会话卡死：`compaction/prune` 修剪超大 tool result 后，派生请求中 `tool_use` 缺少配对的 `tool_result`（HTTP 400 INVALID_REQUEST；仅 DeepSeek 官方端点 / DeepSeek-V4.1-Flash 复现，换提供商可绕过）

> 报告日期：2026-10-04 ｜ 报告人：oh-story-claudecode 工作区维护者 ｜ 面向 DeepSeek Harness（DSH）维护者
>
> 本报告所有证据均直接摘自发生问题的会话日志（`session.v4.jsonl.zstd`），关键事件给出 seq 号与时间戳，可复算。
>
> **更新（用户实测确认）：该 400 仅在 DeepSeek 官方模型 DeepSeek-V4.1-Flash 上复现；切换模型提供商即可绕过**（详见 §2、§4、§8）。但历史中「未配对的 `tool_use`」是 DSH 侧的请求派生缺陷，任何符合 Anthropic 协议的服务端都会拒绝它。

---

## TL;DR（Summary）

**EN:** After the tool-result pruner (`@deepseek-ai/dsh-compaction-tool-result-pruner`) shadowed an oversized `tool/result` (12,492 tokens) and appended a replacement event (`sourceEventSeqs: [1245]`, `surfaceOp: {op:"replace",…}`), the requests DSH derived for the session were structurally invalid: an assistant message carried a `tool_use` (id `call_e16650e5d27e4821a696f273`) with no matching `tool_result` in the immediately following message. On DeepSeek's own endpoint (route `deepseek-official`/`deepseek-flash`, i.e. the user-confirmed DeepSeek-V4.1-Flash model), every subsequent turn (34–37) was rejected with HTTP 400 `INVALID_REQUEST`:

> `messages.189.2: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: call_e16650e5d27e4821a696f273. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`

DSH documents that failed-step recovery does **not** rewrite unanswered calls in **already-closed** turns, so the session never self-heals: each new request re-derives the same broken history and fails again on that endpoint.

**Provider dependence (user-confirmed):** the 400 is raised only by DeepSeek's official endpoint, which strictly enforces the Anthropic `tool_use`↔`tool_result` pairing rule. The same (already-pruned) history was still tolerated by the other gateways used earlier in the session (`nvidia1`, `a666`) — turns 28–31 kept producing model replies after the prune. Switching model provider therefore works around the failure, but the underlying malformed history (an unpaired `tool_use`) remains a DSH-side request-derivation defect that any spec-compliant endpoint would reject.

**ZH：** 工具结果修剪器把一条超大 `tool/result`（约 12,492 token）「影子化」并追加一条替换事件之后，DSH 为会话派生的请求就违反了 Anthropic Messages 协议的配对规则：`tool_use` 之后紧邻的那条消息里没有同 id 的 `tool_result`。在 **DeepSeek 官方端点（路由 `deepseek-official`/`deepseek-flash`，即用户确认的 DeepSeek-V4.1-Flash）** 上，第 34–37 共 4 个 turn 全部被服务端以 HTTP 400 `INVALID_REQUEST` 拒绝。DSH 对「已关闭的历史」不补 `TOOL_OUTCOME_UNKNOWN`，因此会话在该端点上不会自愈，重试只会继续计费并继续失败。

**与提供商相关（用户实测确认）：** 同一份（已修剪的）历史在本会话早期使用的其它网关（`nvidia1`、`a666`）上仍被容忍——turn 28–31 在修剪之后照常产出模型回复；因此**切换模型提供商即可绕过该 400**。但「未配对的 `tool_use`」仍是 DSH 侧的请求派生缺陷，任何符合规范的服务端都会拒绝它。

---

## 1. 环境（Environment）

| 项 | 值 |
|---|---|
| DSH | 0.2.0-rc.2（`resources/app.asar` 内各 `@deepseek-ai/dsh-*` 包版本均为 0.2.0-rc.2） |
| 会话日志格式 | `session.v4.jsonl.zstd`（每行一个独立 zstd frame，逐行压缩） |
| 受影响会话 | `session-367598b5-6b7a-4d81-b450-eeab0df04165`（本工作区 `D:\DS\插件\oh-story-claudecode`） |
| 会话生命周期 | 2026-10-03 18:23 → 2026-10-04 18:30（约 2,392 个事件、37 个 turn、124 条 user message） |
| 复现模型 | DeepSeek 官方端点 `deepseek-official`/`deepseek-flash`（用户确认 = DeepSeek-V4.1-Flash） |
| 其它涉及路由 | 早期 `amd` / `deepseek-account` / `a666` / `nvidia1`（同一份历史未报错，见 §2/§4） |
| 修剪器默认阈值 | 文本 > 8,192 字符 → 修剪为 前 4,096 + 后 1,024 字符 + 标记 |

日志位置：

```
%USERPROFILE%\.dsh\sessions\--D-DS-~63D2~4EF6-oh-story-claudecode--\session-367598b5-6b7a-4d81-b450-eeab0df04165\session.v4.jsonl.zstd
```

---

## 2. 症状（Symptoms）

1. 2026-10-04 **18:27:33 / 18:27:45 / 18:29:53 / 18:30:11**（UTC+8），turn 34 / 35 / 36 / 37 连续四次请求被拒绝，均为 HTTP **400**、code **`INVALID_REQUEST`**，错误完全一致，仅 request_id 不同：

   | turn | seq（`assistant/attempt`→`turn/end`） | request_id |
   |---|---|---|
   | 34 | 2364 / 2366 | `80b3ba6a-bdd2-4ebb-873c-bc22c0ef5d5e` |
   | 35 | 2372 / 2374 | `2038c637-56a7-49bf-a8d2-455cfb993057` |
   | 36 | 2380 / 2382 | `72494609-70b8-45d1-9823-2860b0173c81` |
   | 37 | 2388 / 2390 | `ebdff89d-06f2-4d13-b4e7-64515ddc564f` |

2. 四个 turn 之间没有再更换 provider（最后一次 `request/header` 为 seq 2362：`deepseek-official`/`deepseek-flash`），说明这不是偶发网络/限流问题，而是**请求内容本身结构非法**。
3. **与提供商相关（用户实测确认）**：该 400 仅在 DeepSeek 官方端点（模型 DeepSeek-V4.1-Flash）上出现；**切换到其它模型提供商即不再报错**。日志佐证：同一份（已修剪的）历史在 turn 28–31（`nvidia1`/`a666` 路由，17:00–18:12）仍能产生模型回复；turn 32（`nvidia1`，18:14:57）曾出现一次**空流响应（`assistant/attempt` 0 chunks）**后被用户中止——疑似该网关对非法历史返回空完成而非 400，进一步说明症状的呈现取决于路由/端点。
4. 会话无法继续：用户之后新开了一个会话（即当前工作区会话）才得以继续工作。

---

## 3. 证据链（Evidence）

### 3.1 悬空的那次调用

`messages.189.2` 点名的 `tool_use` 是 turn 17 / step 5 的一次真实调用：

```jsonc
// seq 1244  tool/call  2026-10-04 08:51:24 UTC+8
{
  "type": "tool/call",
  "seq": 1244,
  "time": 1791075084966,
  "data": {
    "turn": 17,
    "step": 5,
    "callId": "call_e16650e5d27e4821a696f273",
    "name": "cordis_inspect_query",
    "arguments": "{\"method\":\"listTools\",\"platform\":\"host\",\"provider\":\"Tool\"}"
  }
}
```

它的结果（seq 1245）**非常巨大**：

```jsonc
// seq 1245  tool/result  2026-10-04 08:52:51 UTC+8  （text 块共 54,480 字符）
{
  "type": "tool/result",
  "seq": 1245,
  "time": 1791075171236,
  "data": {
    "turn": 17,
    "step": 5,
    "message": {
      "role": "tool",
      "source": { "kind": "tool", "callId": "call_e16650e5d27e4821a696f273" },
      "toolCallId": "call_e16650e5d27e4821a696f273",
      "content": [ { "type": "text", "text": "<54,480 chars, 截断展示>" } ]
    }
  },
  "surfaceOp": "append",
  "sourceEventSeqs": [1244]
}
```

### 3.2 修剪器对这条结果的处理（触发点）

2026-10-04 **16:54:14**（UTC+8），压缩触发后工具结果修剪器执行了一轮修剪，一次性替换了 23 条超大结果；**seq 1245 是这一批中最大的一条**（12,492 token，次大 12,491 token）：

```jsonc
// seq 2203  compaction/prune（影子价格事件，紧邻其替换事件）
{
  "type": "compaction/prune",
  "seq": 2203,
  "time": 1791104087945,
  "data": {
    "shadowedRange": { "start": 1245, "end": 1245 },
    "shadowedSeqs": [1245],
    "shadowedTokenCount": 12492
  }
}
```

```jsonc
// seq 2204  tool/result（替换事件，按修剪器文档“replaces the original event”）
{
  "type": "tool/result",
  "seq": 2204,
  "time": 1791104087945,
  "data": {
    "turn": 17, "step": 5,
    "message": {
      "role": "tool",
      "source": { "kind": "tool", "callId": "call_e16650e5d27e4821a696f273" },
      "toolCallId": "call_e16650e5d27e4821a696f273",
      "content": [ { "type": "text", "text": "<5,159 chars>" } ],
      "isError": false,
      "id": "035961f8-5b4e-45f8-91ad-bed937ed7fbc"
    }
  },
  "sourceEventSeqs": [1245],
  "surfaceOp": { "op": "replace", "startSeq": 1245, "endSeq": 1245 }
}
```

注意：替换事件与原始事件 **`message.id` 相同**（`035961f8-…`），`data.turn/step` 仍为 17/5（原始调用的归属），但事件本身落在日志末尾（seq 2204，距原槽位 1245 相隔约 960 个事件）。

### 3.3 请求重建：位置与报错完全对得上

按日志重建 turn 34 的请求消息序列（surface = 事件序，影子节点移除、替换事件按 `surfaceOp {op:replace}` 站回原槽位、system/developer 节点提升为 provider 的 `system` 参数后不计入 `messages`，连续同角色消息合并，tool_result 块置顶）：

- `messages[189]` = **`assistant/message` @ seq 1243**（turn 17/step 5 紧随 `tool/call` 之前的 assistant 消息）
- 其 content 块为 `[reasoning, tool-call, text]`，适配器归一化为 `[thinking/或省略, text, tool_use]` 后，`tool_use` 恰好位于 **`content[2]`** —— 与报错 `messages.189.2` 完全一致。
- 该 assistant 消息的 `tool_use.id` 正是 `call_e16650e5d27e4821a696f273`。

### 3.4 错误现场的日志记录（原样）

```jsonc
// seq 2364  assistant/attempt  turn 34  （turn/end 2366 同内容）
{
  "type": "assistant/attempt",
  "seq": 2364,
  "time": 1791109653720,
  "data": {
    "turn": 34, "step": 1,
    "stream": [ {
      "type": "chunk",
      "time": 1791109653720,
      "chunk": { "type": "finish", "reason": { "kind": "error", "failure": {
        "message": "messages.189.2: `tool_use` ids were found without `tool_result` blocks immediately after: call_e16650e5d27e4821a696f273. Each `tool_use` block must have a corresponding `tool_result` block in the next message. (request_id: 80b3ba6a-bdd2-4ebb-873c-bc22c0ef5d5e)",
        "code": "INVALID_REQUEST",
        "status": 400
      } } }
    ] }
  }
}
```

### 3.5 上下文压力背景（为什么会触发修剪）

修剪发生前，会话已长期处于上下文/配额压力下（与本 bug 直接相关的是「压缩被反复触发」，导致修剪器开跑）：

| 时间（UTC+8） | 事件 |
|---|---|
| 10-04 16:20 / 16:37 | turn 25/26：429 rate-limit（tpm/rpm 超限） |
| 10-04 16:54:44 | turn 27：`max-tokens`（此后立即触发 23 条修剪，16:54:14） |
| 10-04 17:33:41 | turn 28：`max-tokens` |
| 10-04 17:44–18:22 | turn 29–33：interrupted / aborted / 压缩摘要反复失败（"summarization truncated at the token cap"、"pi-ai stream idle timeout"、"pi-ai detected context overflow"、"Request aborted"） |
| 10-04 18:14:57 | turn 32（`nvidia1`）：`assistant/attempt` 返回**空流（0 chunks）**后用户中止——疑似该网关对非法历史返回空完成而非 400（旁证，见 §2-3） |
| 10-04 18:27:31 | turn 34 请求头（seq 2362）→ `deepseek-official`/`deepseek-flash`，`request/context`（seq 2363）记录 `systemPromptUpdate: "in-history"`；`system/message`（seq 2358）以 **append**（而非 replace）方式写入历史 |

---

## 4. 原因分析（Root-cause analysis）

1. **协议规则（Anthropic Messages API 硬性要求）**：assistant 消息中的每个 `tool_use`，必须在**紧随其后的下一条消息**里有一个 `tool_use_id` 相同的 `tool_result` 块，且 `tool_result` 块必须放在该消息开头。任何新请求若历史里存在未配对的 `tool_use`，**严格执行该规则的服务端**（本案例为 DeepSeek 官方端点）会直接 400。
2. **DSH 的设计意图 vs 实际表现**：修剪器文档说明替换事件通过 `sourceEventSeqs` 引用原事件、`surfaceOp {op:"replace"}` 声明「站回原槽位」。但**派生的请求里这条结果没有出现在 `tool_use` 之后紧邻的位置**——替换事件按自身 seq（2204）落在日志尾部，实际请求中该 `tool_use` 后面没有配对的 `tool_result`。
3. **会话不会自愈**：DSH 文档明确「failed-step recovery 不会改写已关闭历史 turn 中未配对的调用」（*Previously closed inconsistent history — failed-step recovery does not rewrite unanswered calls in already-closed historical turns*）。这条调用所在的 turn 17 早已关闭，因此后续没有任何机制能补回配对。
4. **症状呈提供商相关（用户实测确认）**：修剪发生在 16:54，而 turn 28–31（17:00–18:12，`nvidia1`/`a666` 路由）在同一份（已修剪的）历史之上**仍能产生模型回复**；turn 32（`nvidia1`）返回空流而非 400；直到 turn 34 换到 **DeepSeek 官方端点（`deepseek-official`/`deepseek-flash`，即 DeepSeek-V4.1-Flash）** 才稳定复现 400。据此与用户实测：**只有 DeepSeek 官方端点严格执行 Anthropic 协议的 `tool_use`↔`tool_result` 配对校验**，其它网关对该非法历史采取容忍（忽略或空响应），所以换提供商即可绕过。请求组装侧（surface fold / 路由适配器）究竟在哪一步丢掉了配对，仍需维护者结合 `dsh-session` 的 `foldSurface` 与 `dsh-llm-pi-ai` 的请求拼装进一步定位。

---

## 5. 期望行为 vs 实际行为（Expected vs Actual）

| | 内容 |
|---|---|
| **Expected** | ① 修剪后的替换结果在派生请求中站回原槽位，`tool_use` 后紧邻有配对 `tool_result`；② 即便某次替换丢失，请求发出前应有配对校验并给出内部错误（而不是把非法历史发给服务端）；③ 已卡死会话应有可恢复手段（fork/修复/自动补 `TOOL_OUTCOME_UNKNOWN`）。 |
| **Actual** | ① 请求中该 `tool_use` 无配对 `tool_result` → 在严格端点上 400 `INVALID_REQUEST`（宽容网关被静默容忍/空响应）；② 连续 4 个 turn 反复失败，只有换 provider/模型才能继续；③ 会话在该端点上永久卡死，只能弃用、fork 到修剪之前的已完成 turn，或换提供商继续。 |

---

## 6. 影响（Impact）

- 受影响会话在 **DeepSeek 官方端点上永久无法继续**，任何新输入都触发同一 400；
- 每次重试都会产生一次计费请求并失败；
- 该机制（修剪超大工具结果）是 DSH 内置压缩流程的一部分，任何**长会话 + 超大工具输出**都可能踩中同一问题，风险面不是单条会话；
- 换提供商虽可绕过，但历史中的未配对 `tool_use` 依然存在，模型可能读到残缺的工具上下文。

---

## 7. 建议修复方向（Suggested fix areas）

1. **请求派生侧**：surface 折叠时，`surfaceOp {op:"replace"}` 的替换事件必须以被替换节点的位置进入派生请求（而不是按其自身 seq 落在尾部）；或在派生完成后增加一次「`tool_use` ↔ `tool_result` 相邻配对」断言，非法则给出可定位的内部错误（带 callId/seq）。
2. **恢复侧**：对「已关闭 turn 中残留的未配对 `tool_use`」，在恢复/resume 时同样允许补一条 `TOOL_OUTCOME_UNKNOWN` 类合成结果（目前只对 open step 生效）。
3. **容错侧**：对已经卡死的会话，提供显式的修复命令（例如 `/repair`）或让 fork 自动补齐。

---

## 8. 临时规避（Workarounds）

1. **切换模型提供商/模型（最快，用户已验证）**：换用非 DeepSeek 官方端点（如 `a666`、`nvidia1`、`amd` 网关或其它模型）后不再报 400，原会话可继续使用。注意历史中的未配对 `tool_use` 依然存在，模型可能读到残缺的工具上下文。
2. **新开会话**（最稳妥）——原会话日志仍在磁盘上，随时可查。
3. **Fork 到修剪之前的已完成 turn**——本会话中为 turn 24（10-04 15:03 完成，`turn/end` seq 2130），其前缀包含原始调用（seq 1244）与完整结果（seq 1245），不含修剪事件（seq ≥ 2187），因此子会话干净可用。GUI 路径：会话菜单 → Fork session（快捷键 Ctrl+Alt+F / Ctrl+Shift+F）。
4. **减少超大工具输出**：默认阈值 8,192 字符；本案例中 54,480 字符的 `cordis_inspect_query listTools` 输出是直接诱因。长会话中避免把整页 JSON/全文 dump 进上下文。
5. **不要在同一会话里反复重试**：在严格端点上每次重试都是计费 400。

---

## 9. 复现步骤（Reproduction steps，近似）

1. 开一个长会话（数十个 turn 以上），执行一次返回 >8,192 字符结果的工具调用（本案例为 `cordis_inspect_query {method:"listTools",platform:"host",provider:"Tool"}`，54,480 字符）。
2. 持续对话把上下文推到压力区间（观察到 max-tokens / context overflow / 429），触发压缩流程；确认日志中出现成批 `compaction/prune` + 紧随其后的替换 `tool/result`。
3. 之后发送任意新消息 → 在 **DeepSeek 官方端点（DeepSeek-V4.1-Flash）** 上请求被服务端以 `messages.N.M: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: <callId>` 拒绝。
4. 在同一端点上重试无效；**切换到其它模型提供商即不再报错**（用户实测）。

> 说明：步骤 2 是必要条件；步骤 3/4 的稳定复现点在本案例中为 DeepSeek 官方路由（turn 34 起，模型 DeepSeek-V4.1-Flash），更早的路由（`nvidia1`/`a666`）在同一份历史上仍能出回复（turn 32 曾返回空流），路由相关细节见 §4-4。

---

## 附录 A：关键事件速查（seq 索引）

| seq | 类型 | 时间（UTC+8） | 说明 |
|---|---|---|---|
| 1243 | `assistant/message` | 10-04 08:51 | 包含该 `tool_use` 的 assistant 消息（派生后位于 `messages[189]`，`content[2]`） |
| 1244 | `tool/call` | 10-04 08:51:24 | `cordis_inspect_query`，`call_e16650e5d27e4821a696f273` |
| 1245 | `tool/result` | 10-04 08:52:51 | 54,480 字符 / 12,492 token |
| 2203 | `compaction/prune` | 10-04 16:54:14 | 影子化 seq 1245 |
| 2204 | `tool/result` | 10-04 16:54:14 | 替换事件（5,159 字符，同 message.id） |
| 2340 | `assistant/attempt` | 10-04 18:14:57 | turn 32（`nvidia1`）空流响应（0 chunks），随后被中止 |
| 2358 | `system/message` | 10-04 18:27:31 | turn 34，`systemPromptUpdate: in-history`，以 append 写入 |
| 2362 | `request/header` | 10-04 18:27:31 | `deepseek-official`/`deepseek-flash` |
| 2363 | `request/context` | — | `contextWindow: 1000000, systemPromptUpdate: "in-history"` |
| 2364/2366、2372/2374、2380/2382、2388/2390 | `assistant/attempt`/`turn/end` | 18:27:33 / :45 / 18:29:53 / 18:30:11 | 四次 400 `INVALID_REQUEST`（request_id 见 §2） |

## 附录 B：如何自行从日志验证

会话日志是**每行一个独立 zstd frame** 的 JSONL（v4 格式）。可用 Node（≥22.15，自带 `node:zlib` zstd）逐 frame 解压：

```js
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
const buf = readFileSync('<session.v4.jsonl.zstd>');
// 用 zstd frame 头解析出每个 frame 的 [start,end)，再逐帧 zstdDecompressSync
```

帧间没有分隔符，`zstdDecompressSync` 整文件解压只返回第一个 frame，必须按 frame header/block header 自行切帧（可参考 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `src/zstd.ts` 与 `lib/types/zstd-*-decoder.js`）。

## 附录 C：相关文档/源码线索（供维护者对照）

- `@deepseek-ai/dsh-compaction-tool-result-pruner` README：「…swaps each over-budget tool result for one newly appended `tool/result` that replaces the original event and cites it through `sourceEventSeqs`, immediately preceded by a `compaction/prune` shadow-price event.」
- `@deepseek-ai/dsh-compaction` 文档：`toolPairingBalancedBefore/After` 保证压缩切边不跨未配对调用；「missing seqs or an orphan `tool/result` reject as corrupt surface state」。
- `@deepseek-ai/dsh-agent-loop` 文档：「**Previously closed inconsistent history** — failed-step recovery does not rewrite unanswered calls in already-closed historical turns.」；未配对调用只在 open step 上补 `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`。
- 本报告对应的会话日志路径见 §1。
