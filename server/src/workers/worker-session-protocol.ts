/**
 * worker 会话/模型端点的协议类型（**server 侧副本**；双写自
 * `worker/src/protocol/worker-protocol.ts` 的「T10 worker exec 端点契约」段）。
 *
 * 为什么要有这一份（决策 D3：控制面彻底不直连 opencode）：
 * - 控制面此前的 5 处 opencode 直连（建会话 / 下发提示 / 读消息 / 中断 / 取模型）
 *   全部收进 worker 的执行端点；控制面从此只认 **vteam 自有的 wire 形状**，
 *   不再知道被驱动端的任何细节（`{location,data}` 包装、`parts[]` vs `content[]`…）。
 * - worker 为独立进程（不得 import server 代码），故两侧**双写**；
 *   一致性由 worker 侧 `src/protocol/contract.spec.ts`（worker 半边）与
 *   server 侧 `worker.client.spec.ts`（本副本的用法与映射）共同钉住。
 *
 * ⚠️ **改任一端必须同步另一端**：字段名/可选性漂移 = 控制面静默丢字段
 * （例如 `sessionId` 拼成 `sessionID`，worker 回执读不到 → 会话 id 丢失）。
 */

/** 模型引用（vteam 口径：`providerID/modelID`）。 */
export interface WorkerModelRef {
  providerID: string;
  modelID: string;
}

/**
 * 模型目录项（`GET /models` 的返回项）。
 *
 * ⚠️ 刻意**不是**被驱动端的原始包装（v2 是 `{location, data}`，v1 是 `{data}`）——
 * 那是被驱动端的 wire 形状，控制面不该知道它（决策 D3）。
 */
export interface WorkerModelInfo {
  /** 模型 id（`providerID/modelID`）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** provider 段。 */
  providerID: string;
  /** model 段。 */
  modelID: string;
  /** 可用状态（缺失视为可用）。 */
  status?: string;
}

/**
 * GET /models 响应体（模型目录**信封**）。
 *
 * ⚠️ 信封**只有一个键** `models`（刻意**不**返回被驱动端的 `{location,data}` 包装——
 * 那是被驱动端的 wire 形状，控制面不该知道它，见 `WorkerModelInfo` 的说明）。
 *
 * 此前这个信封**只在运行时断言**、不在双写类型里 ⇒ 形状漂移（例如控制面读 `model`）
 * 不会被任何静态检查发现。现在它是**双写契约**的一部分（worker 侧同形状副本见
 * `worker/src/protocol/worker-protocol.ts`）。
 */
export interface WorkerModelsResponsePayload {
  /** 模型目录（vteam 口径的条目数组）。 */
  models: WorkerModelInfo[];
}

/**
 * 投递策略（vteam 侧语义）。
 *
 * - `steer`：插队（打断当前轮，按新指令重跑）；
 * - `queue`：排队（当前轮结束后再消化）。
 *
 * ⚠️ 被驱动端若无此概念则**忽略**该字段——调用方不得依赖它一定生效。
 */
export type WorkerDeliveryMode = 'steer' | 'queue';

/** POST /sessions 请求体（创建会话；body 可为空）。 */
export interface CreateSessionRequestPayload {
  /** 模型选择（可选；缺省用被驱动端默认模型）。 */
  model?: WorkerModelRef | null;
}

/** POST /sessions 响应体（创建会话）。 */
export interface CreateSessionResponsePayload {
  /** 新建的会话 id（被驱动端会话 id）。 */
  sessionId: string;
}

/** POST /sessions/:id/prompt 请求体（下发提示）。 */
export interface SessionPromptRequestPayload {
  /** 提示内容：字符串（归一为单条文本内容单元）或内容单元数组。 */
  prompt: string | unknown[];
  /** 模型选择（可选；缺省用被驱动端默认模型）。 */
  model?: WorkerModelRef | null;
  /** agent 选择（可选；缺省用被驱动端默认 agent）。 */
  agent?: string;
  /** 会话工作目录（可选）。 */
  directory?: string;
  /** 顶层系统提示（产出物协议/@机制等；可选）。 */
  system?: string;
  /** 投递策略（可选；缺省 = 被驱动端默认）。 */
  delivery?: WorkerDeliveryMode;
}

/**
 * POST /sessions/:id/prompt 响应体。
 *
 * ⚠️ **语义边界**：本端点是「**持久化入队**」，**不是**「同步执行」——响应里
 * **没有任何**「agent 已答复」的含义。终态只能看事件（`session.execution.*`）
 * 或再读 `GET /sessions/:id/messages`。
 */
export interface SessionPromptResponsePayload {
  /** 目标会话 id。 */
  sessionId: string;
  /**
   * 被驱动端回执的**收件条目 id**（被驱动端的 inbox item id）。
   * 被驱动端无回执概念时**缺席**（不编造）。
   */
  messageId?: string;
  /**
   * **实际生效**的投递策略（以驱动回执为准——被驱动端可能调整过；驱动不回报时
   * 退回本次请求的值；两者都无 → 缺席 = 被驱动端默认）。
   */
  delivery?: WorkerDeliveryMode;
  /**
   * true = 已被**持久化入队**（admitted）。
   * ⚠️ 它**不代表** agent 已答复，更不代表本轮已完成。
   */
  admitted: boolean;
}

/**
 * POST /sessions/:id/abort 响应体。
 *
 * `interrupted`：true = 确实打断了一轮正在执行的 run；false = 没有（会话空闲/未知）。
 *
 * ⚠️ 幂等语义**不依赖**它（对未知/已结束的会话调用一律 200 成功）。
 */
export interface SessionAbortResponsePayload {
  sessionId: string;
  interrupted: boolean;
}

/** token 用量（vteam 上报口径）。 */
export interface SessionTokenUsage {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/**
 * 会话消息内容单元（vteam 侧渲染模型）。
 *
 * 字段口径 = vteam 渲染层/事件信封的 part 形状（`messageID`/`type`/`text`/
 * `summary`/`thoughts`/`detail`/`state`/`tool`/`synthetic`/`time`）——**不是**某一版
 * 被驱动端 wire 字段名的照搬。
 */
export interface SessionMessageContent {
  /** 内容单元 id（增量去重键）。 */
  id?: string;
  /** 所属会话 id。 */
  sessionID?: string;
  /** 所属消息 id（控制面按此关联消息，勿改名）。 */
  messageID?: string;
  /** 内容类别（text/reasoning/tool/error/…）。 */
  type: string;
  /** 文本正文。 */
  text?: string;
  /** 思考摘要。 */
  summary?: string;
  /** 思考明细。 */
  thoughts?: string;
  /** 明细。 */
  detail?: string;
  /** 结算/结束原因（stop / tool-calls / error）。 */
  reason?: string;
  /** 成本。 */
  cost?: number;
  /** token 用量。 */
  tokens?: SessionTokenUsage;
  /** 时间戳（部分内容为 null）。 */
  time?: { start?: number; end?: number; created?: number } | null;
  /** true = 合成文本（工具调用占位，非模型真实输出），聚合时排除。 */
  synthetic?: boolean;
  /** 工具名（tool 类内容）。 */
  tool?: string;
  /** 工具执行状态（tool 类内容），原样透传。 */
  state?: unknown;
  /** 错误详情（error 类内容），原样透传。 */
  error?: unknown;
  /** 其余原始字段原样透传（渲染兜底/诊断用；vteam 不解释其语义）。 */
  [key: string]: unknown;
}

/** 会话消息元信息（vteam 侧）。 */
export interface SessionMessageInfo {
  id: string;
  role: 'user' | 'assistant';
  /** 消息时间戳。 */
  time?: { created?: number; completed?: number };
  /** 消息级错误（模型调用失败等）。 */
  error?: unknown;
  /** 实际使用模型的 provider 段（缺失 = 未回报）。 */
  providerID?: string;
  /** 实际使用模型的 model 段（缺失 = 未回报）。 */
  modelID?: string;
  [key: string]: unknown;
}

/** 一条会话消息（vteam 侧）。 */
export interface SessionMessage {
  info: SessionMessageInfo;
  parts: SessionMessageContent[];
}

/**
 * GET /sessions/:id/messages 的分页 query（vteam 口径）。
 *
 * 与被驱动端上游的 `limit` / `order` / `cursor` 三个参数同名同义——但**形状是
 * vteam 自己的**：控制面只需要能翻页，不需要知道上游的分页返回体长什么样。
 */
export interface SessionMessagesQuery {
  /** 单页条数上限（缺省 = 被驱动端默认）。 */
  limit?: number;
  /** 排序方向（缺省 = 被驱动端默认）。 */
  order?: 'asc' | 'desc';
  /** 游标（缺省 = 从头翻）。 */
  cursor?: string;
}

/** GET /sessions/:id/messages 响应体（读会话消息）。 */
export interface SessionMessagesResponsePayload {
  /** 目标会话 id。 */
  sessionId: string;
  /** 消息列表（vteam 渲染模型形状）。 */
  messages: SessionMessage[];
}
