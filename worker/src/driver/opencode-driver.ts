/**
 * OpenCodeDriver：worker 侧「被驱动端」（opencode serve）的**唯一接缝**（计划 T8 / 决策 D1）。
 *
 * 为什么要有这道缝（不是过度设计，是三次血泪换来的）：
 * - 现状：`worker/src/driver/v1-driver.ts` 把上游 HTTP 契约（路径、body、返回包装、鉴权）
 *   写死在 ~15 个方法里，且**没有接口**。上游契约一变（v2 的 `/api` 前缀、`content[]`
 *   取代 `parts[]`、`abort`→`interrupt`、全局通道改会话内通道），只能原地改这一个类：
 *   改一处漏一处，业务层（exec-server / index / prompt-await）没有任何隔离可依。
 * - 有缝之后：上游再来 v3 只需**新增一个实现**（`v3-driver.ts`），业务层一行不改。
 *   本文件就是那根缝——所以它必须是**稳定契约**，而不是某一版契约的别名。
 *
 * 铁律（本文件存在的全部意义）：
 * 1. **任何上游类型都不得越过这条边界**：本文件的入参/出参一律是 vteam 自有类型
 *    （DriverMessage / DriverContent / DriverQuestionRequest / DriverPermissionRequest /
 *    DriverTokenUsage / DriverModelInfo …）。上游的类型名、模块路径、SDK 依赖都不许出现在
 *    这里（回归守卫见 `opencode-driver.spec.ts` 的边界断言）。
 * 2. **领域词用 vteam 的**：vteam 自己的领域词是「question」（已有 `session.question` 事件与
 *    `question_confirm` MCP 工具），不是上游新版的「form」——故本接口统一叫 question，
 *    各实现自行把上游通道归一到该语义。
 * 3. **只表达业务层真正消费的信息**：字段按「调用点真的读什么」定，不做上游形状的镜像；
 *    上游形状（路径、body、返回包装）由各实现内部承担。
 *
 * 实现约定：
 * - 每个实现自带**一致性测试**（见 `opencode-driver.conformance.ts` 的共享契约套件）：
 *   新增实现必须跑通同一套断言，否则不算落地。
 * - 失败一律抛 `DriverRequestError`（带 `status`），上层据此区分「会话失效（404）」
 *   「未鉴权（401）」「限流（429）」等（见 exec-server 的会话重建路径）。
 */

import { SessionQuestionInfo } from '../protocol/worker-protocol';

/** 最小日志接口（duck typing，避免跨模块强耦合）。 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * 模型引用（vteam 口径：`providerID/modelID`）。
 *
 * 说明：`providerID/modelID` 是 **vteam 自己的模型键格式**（上报字段 `model`、
 * `WorkerCapabilities.models` 的 id、注册探测的 **serve `GET /api/model`** 输出都用它），
 * 不是上游类型名——故此处保留该拼写。
 *
 * ⚠️ **v2 下 `opencode models` CLI 不是 serve 的探针**（真栈实测）：CLI 子命令绑的是
 * **共享托管后台服务**（默认端口 49374），读的是**它自己那套配置作用域**——不是 worker
 * 自己 spawn 的那个 serve ⇒ 可能报出**不含 vteam 自配模型**的清单（或直接失败）。
 * ⇒ 模型清单的真值源是 **worker 的 serve**。
 *
 * 注：MCP 状态同理——探针直接读 serve 的 `GET /api/mcp`（Basic 鉴权），**不需要**在本接口
 * 上加 `listMcp` 之类的方法。
 */
export interface DriverModelRef {
  providerID: string;
  modelID: string;
}

/**
 * 模型目录项（id = `providerID/modelID`）。
 *
 * status：模型可用状态（active/deprecated 等）。主路径（凭据认证）统一上报 'active'；
 * 回退路径沿用上游返回值（缺失视为可用）。
 */
export interface DriverModelInfo {
  id: string;
  name: string;
  providerID: string;
  modelID: string;
  /** 模型状态；缺失视为可用 */
  status?: string;
}

/**
 * 集成注册表项（serve `GET /api/integration` 的归一化结果）。
 *
 * 与 `GET /api/provider`（**只含已注册/已配置** provider）不同，这里给出的是
 * 「可配置全集」：像 `opencode-go` 这类**没有模型行的内置集成**只有在此处可被发现，
 * 管理页据此展示 + 落 apikey。**绝不携带任何 secret**（`methods` 只描述怎么配，
 * 不含已配的值）。
 */
export interface DriverIntegrationInfo {
  /** 集成 id（= providerID，如 `opencode-go`） */
  id: string;
  /** 展示名（如 `OpenCode Go`）；缺失回退为 id */
  name: string;
  /** 支持直接填 apikey（`methods` 含 `{type:"key"}`） */
  apiKey: boolean;
  /** 该集成识别的环境变量名（`methods` 含 `{type:"env"}` 时的 names；仅作提示展示） */
  envNames?: string[];
}

/**
 * agent 目录项（vteam 的「角色 agent」视角）。
 *
 * mode：primary=可作为会话主 agent；subagent=仅由主 agent 派生；all=两者皆可。
 */
export interface DriverAgentInfo {
  /** agent 名（下发提示时的 agent 选择值） */
  name: string;
  description?: string;
  mode: 'primary' | 'subagent' | 'all';
  /** 是否内置 agent */
  native?: boolean;
  /** 隐藏的系统 agent（compaction/summary/title 等），不应出现在用户可选列表 */
  hidden?: boolean;
  /** agent 覆盖的模型（缺省 = 继承全局/主 agent 模型） */
  model?: DriverModelRef;
  /** 权限声明（原样透传供上层展示/诊断，不在驱动层归一） */
  permission?: unknown;
  /**
   * 系统提示词全文。
   * ⚠️ 体积大（全部 agent 合计可达百 KB），**不要随列表下发**，按需单独取。
   */
  prompt?: string;
}

/** 会话待办步骤（计划 Tab 步骤区数据源）。 */
export interface DriverTodo {
  id?: string;
  content: string;
  status: string;
  priority?: string;
}

/** token 用量（vteam 上报口径：`task.completed` 的 `tokens` 字段）。 */
export interface DriverTokenUsage {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/**
 * 内容类别（vteam 口径）。
 *
 * 说明：类型集合**开放**（`(string & {})` 允许任意字符串同时保留字面量补全）——驱动实现
 * 可以给出实现侧特有的类别，vteam 侧不必为每一版上游契约改一次类型。
 *
 * ⚠️ `step-finish` 目前仍是 vteam 业务语义的一部分：控制面用它做「本轮完成」的幂等键
 * （`server/src/chat/worker-dispatcher.ts` 的 `findStepFinishPartKey` 读 `part.type`），
 * 语义层重写前不要删。
 */
export type DriverContentType =
  | 'text'
  | 'reasoning'
  | 'tool'
  | 'error'
  | 'aborted'
  | 'step-start'
  | 'step-finish'
  | (string & {});

/**
 * 一条消息内容单元（vteam 侧的「part」）。
 *
 * 字段口径 = **vteam 渲染层/事件信封的 part 形状**（`server/src/chat/message-parts.ts`、
 * `web/src/components/chat/msg-parts.tsx` 读的就是这一套字段：`id`/`type`/`text`/
 * `summary`/`thoughts`/`detail`/`state`/`tool`/`synthetic`/`time`），因此**不是**某一版
 * 上游 wire 字段名的照搬，而是 vteam 自己的渲染模型。
 *
 * ⚠️ 两条硬约束（改动前先确认下游）：
 * - `messageID` 必须保留原名：控制面按 `part.messageID` 关联消息（丢了会静默丢引用）。
 * - `type` 的取值集合被控制面读（`step-finish` = 本轮完成），不要随手改名。
 */
export interface DriverContent {
  /** 内容单元 id（增量去重键；缺失时由上层按「消息 id + 序号」兜底） */
  id?: string;
  /** 所属会话 id */
  sessionID?: string;
  /** 所属消息 id（控制面按此关联消息，勿改名） */
  messageID?: string;
  /** 内容类别 */
  type: DriverContentType;
  /** 文本正文 */
  text?: string;
  /** 思考摘要（渲染层与 vteam 文本增长指纹的候选字段之一） */
  summary?: string;
  /** 思考明细（候选字段之一） */
  thoughts?: string;
  /** 明细（候选字段之一） */
  detail?: string;
  /** 结算/结束原因（如 stop / tool-calls / error） */
  reason?: string;
  /** 成本 */
  cost?: number;
  /** token 用量 */
  tokens?: DriverTokenUsage;
  /** 时间戳（多段拼接排序依据）；部分内容为 null */
  time?: { start?: number; end?: number; created?: number } | null;
  /** true = 合成文本（工具调用占位，非模型真实输出），聚合时排除 */
  synthetic?: boolean;
  /** 工具名（tool 类内容） */
  tool?: string;
  /** 工具执行状态（tool 类内容）：{status, input, output, time} 等，原样透传 */
  state?: unknown;
  /** 错误详情（error 类内容）：{name, data:{message, statusCode}} 等，原样透传 */
  error?: unknown;
  /** 其余原始字段原样透传（渲染兜底/诊断用；vteam 不解释其语义） */
  [key: string]: unknown;
}

/** 消息元信息（vteam 侧）。 */
export interface DriverMessageInfo {
  id: string;
  role: 'user' | 'assistant';
  /** 消息时间戳 */
  time?: { created?: number; completed?: number };
  /** 消息级错误（模型调用失败等；vteam 从这里抽取可读错误） */
  error?: unknown;
  /** 实际使用模型的 provider 段（缺失 = 上游未回报） */
  providerID?: string;
  /** 实际使用模型的 model 段（缺失 = 上游未回报） */
  modelID?: string;
  [key: string]: unknown;
}

/** 一条会话消息（vteam 侧）。 */
export interface DriverMessage {
  info: DriverMessageInfo;
  parts: DriverContent[];
}

/**
 * 一条待答复的「问题」（vteam 领域词 question）。
 *
 * `questions` 直接复用 vteam 协议层的 `SessionQuestionInfo`（worker↔控制面事件载荷的
 * 既有形状），故驱动层产出即可直接上送 `session.question` 事件，无需二次翻译。
 */
export interface DriverQuestionRequest {
  /** 请求 id（答复时回传；会话内唯一） */
  id: string;
  /** 所属会话 id */
  sessionId: string;
  /** 问题条目 */
  questions: SessionQuestionInfo[];
}

/** 权限请求（vteam 侧）。 */
export interface DriverPermissionRequest {
  /** 请求 id（答复时回传；会话内唯一） */
  id: string;
  /** 所属会话 id */
  sessionId: string;
  /** 权限动作（如 bash / edit / external_directory） */
  action: string;
  /** 资源模式数组（如 `/data/*`） */
  resources: string[];
  /** 允许写回的资源（上游可选字段） */
  save?: string[];
  /** 附加元信息 */
  metadata?: Record<string, unknown>;
  /** 请求来源（上游可选字段） */
  source?: unknown;
}

/** 权限答复口径（vteam 侧）：once=本次允许 / always=始终允许 / reject=拒绝。 */
export type DriverPermissionResponse = 'once' | 'always' | 'reject';

/**
 * 下发提示的入参（vteam 侧）。
 *
 * `parts` 是**内容单元的不透明数组**：vteam 只负责把提示文本/附件装配好交给驱动，
 * 由驱动决定怎么编码成上游契约（各版本 body 形状不同，但业务层调用点不变）。
 */
export interface DriverPromptInput {
  /** 模型选择（可选，缺省用被驱动端默认模型） */
  model?: DriverModelRef | null;
  /** agent 选择（可选，缺省用被驱动端默认 agent） */
  agent?: string;
  /** 提示内容单元（必填；文本与附件混装） */
  parts: unknown[];
  /** 工作目录（会话工作区；各版本承载方式不同，由驱动翻译） */
  directory?: string;
  /**
   * 顶层系统提示（产出物协议/@机制等）。
   * ⚠️ 各版本承载方式不同（有的版本无此字段），由驱动自行落到上游支持的载体上。
   */
  system?: string;
  /**
   * 投递策略（vteam 侧语义）：steer = 插队（打断当前轮，按新指令重跑）、
   * queue = 排队（当前轮结束后再消化）。
   *
   * ⚠️ v1 无此概念（v1 的在飞注入靠追加 user 消息实现）→ v1 实现**忽略**本字段；
   * 新版被驱动端原生支持该语义 → 由实现翻译到上游的投递参数。
   */
  delivery?: DriverDeliveryMode;
}

/** 投递策略（vteam 侧语义）。 */
export type DriverDeliveryMode = 'steer' | 'queue';

/**
 * 下发提示的结果（vteam 侧）。
 *
 * `messageId`：被驱动端回执的**收件条目 id**（新版被驱动端的入队式投递会回执一个
 * 收件条目 id；worker 的 prompt 端点要把它回传给控制面，见计划 T10）。
 * v1 无此概念 → undefined。
 *
 * `delivery`：**实际生效**的投递策略（回执值，非请求值——被驱动端可能调整）。
 * v1 无此概念 → undefined。
 */
export interface DriverPromptResult {
  messageId?: string;
  delivery?: DriverDeliveryMode;
}

/**
 * 消息拉取选项（vteam 侧）。
 *
 * 为什么需要：被驱动端的消息列表在部分实现里是**游标分页**的（一次只回一页），
 * 而「拉取整个会话的消息列表」是业务层（轮询完成判定）真正需要的语义。
 * 故接口允许实现方接受分页参数，**同时**保证「不传参数 = 拿到全部消息」的等价行为——
 * 调用方（`prompt-await`）传不传参数都必须得到同一份完整列表。
 */
export interface DriverMessageQuery {
  /** 最多返回多少条消息（缺省 = 全部）。 */
  limit?: number;
  /** 排序方向（缺省 `asc` = 由旧到新，与 v1 的整会话列表语义一致）。 */
  order?: 'asc' | 'desc';
  /** 起始游标（缺省 = 从头开始）。 */
  cursor?: string;
}

/**
 * 驱动错误分类（vteam 口径）。
 *
 * 分类的用处：上层要区分「会话失效 → 重建会话」「未鉴权 → 配置错误」「限流 → 退避」
 * 「上游 5xx → 可重试」这几类处置，而不是各版本各写一套状态码判断。
 */
export type DriverErrorKind =
  | 'not-found'
  | 'unauthorized'
  | 'rate-limited'
  | 'server'
  | 'timeout'
  | 'network'
  | 'unknown';

/**
 * 请求失败（网络错/超时/HTTP 非 2xx），带 `status` 便于上层区分处置。
 *
 * `status` 必须透传：exec-server 依赖 `err.status === 404` 判定「会话失效」并自动重建
 * （被驱动端重启后旧会话不存在），也依赖 401 区分配置错误。
 */
export class DriverRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DriverRequestError';
    this.status = status;
  }
}

/**
 * 按 HTTP 状态码归一错误分类（vteam 口径）。
 *
 * - 404 → not-found（会话/请求已失效 → 上层可重建会话）
 * - 401/403 → unauthorized（配置错误：口令/权限）
 * - 429 → rate-limited（退避重试）
 * - 5xx → server（上游故障，可重试）
 * - 其余/无状态码 → unknown
 */
export function classifyDriverErrorStatus(status: number | undefined): DriverErrorKind {
  if (status === undefined) {
    return 'unknown';
  }
  if (status === 404) {
    return 'not-found';
  }
  if (status === 401 || status === 403) {
    return 'unauthorized';
  }
  if (status === 429) {
    return 'rate-limited';
  }
  if (status >= 500) {
    return 'server';
  }
  return 'unknown';
}

/**
 * 被驱动端驱动接口（vteam 侧契约）。
 *
 * 方法名沿用业务层既有调用点（`createSession`/`sendMessage`/`getMessages`/…），
 * 使业务层从「依赖具体实现」变成「依赖本接口」时**调用点一行不改**。
 *
 * 每个实现都必须：
 * - 失败一律抛 `DriverRequestError`（带 `status`；网络错/超时无状态码）。
 * - 通过共享契约套件 `opencode-driver.conformance.ts`。
 */
export interface OpenCodeDriver {
  /**
   * 被驱动端基址（如 `http://127.0.0.1:4199`）。
   *
   * 可写：被驱动端启动成功后注入实际地址（随机端口场景）——注入新地址意味着换了实例，
   * 实现应自行作废与旧实例相关的缓存。
   */
  baseUrl: string;

  /** 被驱动端鉴权口令（空 = 不鉴权；订阅事件流时用）。 */
  readonly authPassword: string;

  /** 创建会话，返回会话 id（非空字符串）。 */
  createSession(model?: DriverModelRef | null): Promise<string>;

  /** 下发提示（异步投递即可；失败抛 `DriverRequestError`）。 */
  sendMessage(sessionID: string, input: DriverPromptInput): Promise<DriverPromptResult>;

  /**
   * 拉取会话消息列表（累积列表，非增量）。
   *
   * `options` 缺省 = 取**全部**消息（与 v1 的整会话列表等价）；实现方若内部是游标分页的
   * （如 v2），必须自行翻页补齐——调用方永远拿到完整列表。
   */
  getMessages(sessionID: string, options?: DriverMessageQuery): Promise<DriverMessage[]>;

  /** 列出该会话待答复的问题（无则空数组，非错误）。 */
  listQuestions(sessionID: string): Promise<DriverQuestionRequest[]>;

  /**
   * 答复问题。
   *
   * `answers` 的形状 = **vteam 自己的 worker 端点载荷**（`QuestionReplyRequestPayload`
   * 的 `answers: string[][]`：与问题条目一一对应，每项为选中项数组）——不是上游 wire 形状，
   * 各实现自行翻译成上游的答复体。
   */
  replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<void>;

  /** 拒绝问题（用户点「拒绝」）。 */
  rejectQuestion(sessionID: string, requestID: string): Promise<void>;

  /** 列出该会话待答复的权限请求（无则空数组，非错误）。 */
  listPermissions(sessionID: string): Promise<DriverPermissionRequest[]>;

  /** 答复权限请求。 */
  replyPermission(
    sessionID: string,
    permissionID: string,
    response: DriverPermissionResponse,
  ): Promise<void>;

  /** 中止会话（已结束/不存在时应**不抛错**，按幂等空操作处理）。 */
  abort(sessionID: string): Promise<void>;

  /** 列出被驱动端可用的 agent（按工作目录发现；工作目录缺省 = 被驱动端默认）。 */
  listAgents(directory?: string): Promise<DriverAgentInfo[]>;

  /** 列出该会话的待办步骤（无则空数组，非错误）。 */
  listTodos(sessionID: string, directory?: string): Promise<DriverTodo[]>;

  /** 列出可用模型目录。 */
  listModels(): Promise<DriverModelInfo[]>;

  /** 列出被驱动端的集成注册表（可配置 provider 全集；失败**抛错**，由上层降级）。 */
  listIntegrations(): Promise<DriverIntegrationInfo[]>;

  /** 健康检查（在线 = true；**不抛异常**，网络错/非 2xx 一律 false）。 */
  isHealthy(): Promise<boolean>;
}
