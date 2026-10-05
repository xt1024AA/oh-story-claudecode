/**
 * dsh-oh-story-claudecode —— 宿主装配面的类型声明（wayfinder #11）。
 *
 * 本包是纯 JS（`lib/*.js`，无构建步骤）。这份 `.d.ts` 只声明**对外契约**：
 *
 *  1. 插件模块的三个导出（`name` / `inject` / `apply`）——宿主 `cordis` 按这三样装配；
 *  2. 宿主 `ctx` 的最小结构——只列本插件真正用到的成员，且**全部可选**：
 *     宿主不提供某个能力时插件按注释降级，而不是整个激活失败；
 *  3. 工具定义（`ctx.tools.register` 的入参）与统一信封（`oh_story_*` 工具的返回值）。
 *
 * 有意**不**声明 `lib/runtime/*`、`lib/tools/*` 的内部形状：那些是包内私有实现，
 * 不属于对外契约（内部改动不该逼着调用方改类型）。
 */

/** 宿主 `ctx.tools.register` 的返回值：精确撤销器（可能不是函数，健壮写法要判类型）。 */
export type ToolDisposer = (() => void) | undefined;

/** 工具返回值渲染出的内容块（宿主交给模型的就是 render 的产物）。 */
export interface ContentBlock {
  type: string;
  text: string;
}

/** 工具的输出声明。`render` 必填——宿主会拒绝缺 render 的定义。 */
export interface ToolOutput<Value = unknown> {
  /** 原始 JSON Schema（宿主的受支持子集：type/oneOf/properties/required/additionalProperties/items/enum/const + description/title）。 */
  schema: Record<string, unknown>;
  render: (args: Record<string, unknown>, value: Value) => ContentBlock[];
  /** 可选的表现层元数据；本包不声明。 */
  presentationMeta?: (...args: never[]) => unknown;
}

/** 一个工具定义（与官方 `defineTool` 的产物同形）。 */
export interface ToolDefinition<Value = unknown> {
  name: string;
  description: string;
  /** 参数表的原始 JSON Schema（不是 zod/schemastery）。 */
  parameters: Record<string, unknown>;
  output: ToolOutput<Value>;
  execute: (
    args: Record<string, unknown>,
    exec?: Record<string, unknown>,
  ) => Value | Promise<Value>;
  /** 宿主用它决定同批调用能否并行；本包不声明（默认独占）。 */
  isConcurrencySafe?: (args: Record<string, unknown>) => boolean;
  /** 单次调用超时（毫秒）；本包不声明。 */
  timeoutMs?: number;
}

/**
 * 统一信封：所有 `oh_story_*` 工具（探针除外）的返回值形状。
 * `ok` 的语义是「这次调用有没有拿到有效的业务结果」，**不是**「业务判定是否通过」——
 * `chapter check` 返回 `status: "blocked"` 时 `ok` 仍为 `true`，判定写在 `status` / `result` 里。
 */
export interface Envelope<Result = Record<string, unknown>> {
  ok: boolean;
  tool: string;
  /** 与本次调用等价的命令行（便于人工复核/复现）。 */
  command: string;
  /** 原脚本退出码；进程没起来是 -1。 */
  exitCode: number;
  /** 业务状态词（ready / needs_decision / blocked / findings / clean / measured …），没有就是空串。 */
  status: string;
  /** 本次用到的解释器探测结果。 */
  env: Record<string, unknown>;
  /** Node 侧从业务结果派生的计数（检测器的 blocking/advisory 等）。 */
  counts?: Record<string, number>;
  /** 原脚本 stdout 里那行 JSON，原样透传。 */
  result?: Result;
  stdout: string;
  stderr: string;
  /** 本次调用对用户文件的实际落盘影响（没有就是空数组）。 */
  sideEffects: Array<{ kind: string; target: string; detail: string }>;
  /** 破坏性动作的审批结果。 */
  approval?: { via: string; outcome: string; detail: string };
  /** 工具故障（`ok: false` 时才有）：错误码 + 人话 + 下一步。 */
  error?: { code: string; message: string; nextStep: string };
  notes: string[];
}

/**
 * 宿主上下文的最小结构。**每个成员都可选**：`apply` 里对宿主能力一律探测后使用，
 * 缺失时降级（例如没有 `tools.register` 就不注册工具并在探针里如实报告）。
 */
export interface HostContext {
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  /** 工具注册服务（本插件的硬依赖，见 `inject`）。 */
  tools?: {
    register?: (definition: ToolDefinition) => ToolDisposer;
    /** 回读注册表（`oh_story_probe` 用它报「此刻在册几个」）；宿主不提供时为 undefined。 */
    get?: (name: string, scope?: unknown) => ToolDefinition | undefined;
  };
  /**
   * 副作用登记：Cordis 会**立刻调用** callback，并把它的**返回值**当作清理函数
   * （官方约定 "return its cleanup"）。写成「在 callback 里直接清理」＝ 注册当刻就把
   * 刚注册的资源全部注销——wayfinder #9 的真机事故就是这个写法。
   */
  effect?: (callback: () => (() => void) | void) => unknown;
  /** 服务注入（随包 skills 挂载用）。 */
  inject?: (
    names: string[],
    callback: (scope: { plugin: (plugin: unknown, config?: Record<string, unknown>) => void }) => void,
  ) => unknown;
  /** 在 scope 里挂子插件。 */
  plugin?: (plugin: unknown, config?: Record<string, unknown>) => unknown;
  /** 取宿主服务（可选查找：不存在返回 undefined）。 */
  get?: (name: string) => unknown;
}

/** 插件行名。与 `cordis.patch.yml` 的 `id` / `name` 以及包名一致。 */
export declare const name: "dsh-oh-story-claudecode";

/** 工具注册是硬依赖：装配时缺 `tools` 服务则本插件不激活。 */
export declare const inject: readonly ["tools"];

/**
 * cordis 插件入口：建 runtime → 注册探针 → 注册 7 个写作工具 → 挂随包 skills（不 await）。
 *
 * 幂等性：同一进程内多次调用（HMR 重新 apply）只保留最后一次的装配记账；
 * 工具 disposer 走 `ctx.effect` 在卸载时逆序释放。
 *
 * @param ctx 宿主上下文
 * @param config 来自 `cordis.patch.yml` 该条目的 `config`（本包未声明 Config，不使用）
 */
export declare function apply(ctx: HostContext, config?: Record<string, unknown>): void;
