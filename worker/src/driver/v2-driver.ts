/**
 * T9 V2Driver：opencode serve **v2**（2.0.x）REST 契约的实现（接缝 `OpenCodeDriver` 的 v2 分支）。
 *
 * 与 v1 实现的分工：业务层（exec-server / index / prompt-await）只认接缝；本类把 v2 的
 * wire 契约翻译成 vteam 自有类型。**v2 契约与 v1 的差异是"同名不同形"级别的**（路径前缀、
 * body 键名、返回包装、消息模型全变），故本类不共享 v1 的任何请求代码——共享的只有
 * `DriverXxx` 类型。
 *
 * 契约基线（实测 opencode v2.0.28，证据见 `docs/agent-platform/opencode-v2-contract-baseline/`）：
 * 1. **路径全带 `/api` 前缀**；v1 的 legacy 路由在 v2 上**不 404，而是 200 + web SPA 的 HTML**
 *    （`GET /session` 实测 `Content-Type: text/html`，7202 字节）——对着 v2 用 v1 驱动会
 *    "解析 HTML 当 JSON"，无任何错误信号。v1 驱动已就此加装 Content-Type 闸门（见 v1-driver）。
 * 2. **鉴权**：HTTP Basic，username `opencode`，密码 = `OPENCODE_SERVER_PASSWORD`；
 *    口令错/缺失 → 401（v2 恒开鉴权）。
 * 3. **消息模型**：`Session.Message.Info` 是按 `type` 判别的**联合体**（无 `role` 字段）：
 *    - `user`：`{id, type:'user', time, text}`——**纯文本，没有 parts 数组**；
 *    - `assistant`：`{id, type:'assistant', time, agent, model, content[], finish?, rawFinish?, cost?, tokens?, error?}`
 *      ——`content[]` 取代 v1 的 `parts[]`；`content[]` 项 ∈ text / reasoning / tool；
 *    - 其余类型（`idle` / `synthetic` / `system` / `skill` / `shell` / `compaction` /
 *      `agent-switched` / `model-switched` / `location-switched`）**不落在 vteam 的 role
 *      二值模型里**，本驱动只映射 user/assistant（其余丢弃，理由见 mapMessage）。
 * 4. **`step-start` / `step-finish` 在 v2 不存在**（升级为 `session.step.*` 事件），但控制面
 *    仍用 `step-finish` part 做"本轮完成"的幂等键（`server/src/chat/worker-dispatcher.ts`
 *    的 `findStepFinishPartKey`）→ 本驱动**从 assistant 消息的 `finish`/`tokens`/`cost`
 *    合成一个 `step-finish` part**（语义层 T14 重写前必须保留）。
 * 5. **part id 由本驱动产出（单源）**：v2 的 `content[]` 项没有 v1 那种稳定 part id，
 *    故 id 由驱动合成——口径见 `v2-part-id.ts`（**唯一**实现，事件路也从那里取）：
 *    文本 `${M}:text` / 思考 `${M}:reasoning` / 工具 `${M}:tool:${callID}` /
 *    同类第 k 段加 `:${k}` / 合成 step-finish `${M}:step-finish`。
 *    ⚠️ 旧口径是「内容下标形态」`${M}:${index}`（计划 D5），**已废弃**：它与事件路的
 *    形态不一致 → 同一内容在两条路径上 id 不同 → server 按 id 合并时会存成两个 part。
 *    现在两条路径形态一致，**边界不再需要 reconcile**。
 * 6. **工具输出**：v1 的 `state.output`（字符串）在 v2 变成 `state.content`（**数组**），
 *    且 v2 的 `state.error` 是 `{type,message}` 对象——渲染层（web `msg-parts.tsx`）读的是
 *    `state.output`（字符串）与 `state.error`（字符串），故本驱动做归一（见 normalizeToolState）。
 * 7. **prompt body 无 `system` / 无 `parts` / 无 `directory` query / 无 `model`**：
 *    - 正文 → `text`（字符串）；附件 → `files[]`（`{uri,name?}`）；
 *    - 模型 → `POST /api/session/{id}/model`（**会话级**，非逐消息）；
 *    - agent → `POST /api/session/{id}/agent`（**会话级**，角色提示靠它激活）；
 *    - 目录 → `POST /api/session/{id}/move`（**会话属性**，v2 的 prompt 无 directory 参数）。
 *    - **逐消息 system blob** → **插件交接**（`ctx.session.hook("context")` →
 *      `event.system.push`）进模型请求的 system 段；插件不可用时退回**文本前缀**
 *      （落 user 段）。载体选择见 `v2-system-handoff.ts` 与 `sendMessage` 的说明。
 * 8. **回执不是完成**：`POST /api/session/{id}/prompt` 返回 `Session.Inbox.User`（**收件条目**），
 *    不是模型答复；完成判定归语义层（prompt-await）。
 *
 * 分页：`GET /api/session/{id}/message` 返回 `{data:[], cursor:{previous,next}}`，**默认 desc**
 * （新→旧）。本驱动统一按 **asc**（旧→新，与 v1 的整会话列表等价）返回并**自动翻页**
 * （游标已编码方向，故翻页请求**不得**再带 `order`——带了就 400 `InvalidCursorError`）。
 */

import {
  DriverAgentInfo,
  DriverContent,
  DriverMessage,
  DriverMessageQuery,
  DriverModelInfo,
  DriverModelRef,
  DriverPermissionRequest,
  DriverPermissionResponse,
  DriverPromptInput,
  DriverPromptResult,
  DriverQuestionRequest,
  DriverTokenUsage,
  DriverRequestError,
  Logger,
  OpenCodeDriver,
} from './opencode-driver';
import { V2PartIdDeriver, v2StepFinishPartId, v2TextPartId } from './v2-part-id';
import { SystemHandoffPort } from './v2-system-handoff';

/** 默认请求超时 ms（与 v1 实现同口径：宽松，避免长轮询被误杀）。 */
export const V2_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** 单页拉取的消息条数（翻页直到取完；保证长会话不丢消息）。 */
const MESSAGE_PAGE_SIZE = 200;

/** 翻页轮数上限（防御：游标异常导致死循环）。 */
const MAX_MESSAGE_PAGES = 200;

/**
 * v2 内置 agent id 集合（实测 2.0.28：`build`/`plan`/`general`/`explore` +
 * 隐藏的 `compaction`/`title`/`summary`）。
 *
 * 为什么需要：v2 的 `Agent.Info` **没有** `native` 字段（v1 有），而 vteam 的
 * `DriverAgentInfo.native` 用于区分「内置 agent / 自定义 agent」。只能按 id 判定——
 * 这是**启发式**（自定义 agent 若与内置同名会被误判为内置），已在报告里标注为有损点。
 */
const V2_BUILTIN_AGENT_IDS = new Set([
  'build',
  'plan',
  'general',
  'explore',
  'compaction',
  'title',
  'summary',
]);

/** v2 wire：会话信息（`POST /api/session` → `{data: Session.Info}`）。 */
interface V2SessionInfo {
  id?: string;
  location?: { directory?: string };
}

/** v2 wire：消息（按 `type` 判别的联合体；只声明本驱动读取的字段）。 */
interface V2Message {
  id?: string;
  type?: string;
  time?: { created?: number; streamed?: number; completed?: number };
  text?: string;
  agent?: string;
  model?: { id?: string; providerID?: string };
  content?: V2ContentItem[];
  finish?: string;
  rawFinish?: string;
  cost?: number;
  tokens?: V2Tokens;
  error?: unknown;
}

/** v2 wire：assistant 消息的 `content[]` 项。 */
interface V2ContentItem {
  type?: string;
  /** tool 项的 provider 侧 call id（text/reasoning 无 id）。 */
  id?: string;
  /** tool 名。 */
  name?: string;
  text?: string;
  state?: unknown;
  executed?: boolean;
  time?: { created?: number; ran?: number; completed?: number };
}

/** v2 wire：token 用量（无 `total` 字段——v1 的 step-finish tokens 同样没有，故不造数）。 */
interface V2Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** v2 wire：agent 目录项。 */
interface V2Agent {
  id?: string;
  name?: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
  system?: string;
  model?: { id?: string; providerID?: string };
  permissions?: unknown;
}

/** v2 wire：模型目录项。 */
interface V2Model {
  id?: string;
  modelID?: string;
  providerID?: string;
  name?: string;
  status?: string;
  enabled?: boolean;
}

/** v2 wire：表单（v2 的「问题」通道；对应 vteam 的 question 语义域）。 */
interface V2Form {
  id?: string;
  sessionID?: string;
  title?: string;
  metadata?: unknown;
  fields?: V2FormField[];
}

/** v2 wire：表单字段（带类型的字段描述符）。 */
interface V2FormField {
  key?: string;
  title?: string;
  description?: string;
  type?: string;
  options?: Array<{ value?: string; label?: string; description?: string }>;
  custom?: boolean;
  required?: boolean;
}

/** v2 wire：权限请求。 */
interface V2PermissionRequest {
  id?: string;
  sessionID?: string;
  action?: string;
  resources?: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: unknown;
}

/** v2 wire：prompt 的文件附件。 */
interface V2FileAttachment {
  uri: string;
  name?: string;
  description?: string;
}

/**
 * 解包 v2 的列表响应：接受 `{location, data:[...]}`。
 *
 * **2.0.28 与 2.0.32 的 `GET /api/model` 形态一致**（都是 `{location, data}`）——
 * 已对**发布的 `@opencode/client@2.0.32` 类型定义**核实：`ModelListOutput = { location, data }`
 * （`dist/promise/generated/types.d.ts`），**与 2.0.28 实测没有差异**。
 *
 * ⇒ 这里的**裸数组分支是防御性容忍**（万一将来出现新形态，不至于静默解包失败），
 * **不是**已知的版本漂移——⚠️ **不要据此把代码改成只认一种形态**，也不要把这段注释
 * 当成"2.0.32 与 2.0.28 契约不同"的依据。
 */
export function unwrapV2List<T>(body: unknown): T[] {
  if (Array.isArray(body)) {
    return body as T[];
  }
  if (body !== null && typeof body === 'object') {
    const data = (body as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return data as T[];
    }
  }
  return [];
}

/** 解包 v2 的单对象响应（`{data: {...}}`；容忍裸对象）。 */
export function unwrapV2Object<T>(body: unknown): T | undefined {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const data = (body as { data?: unknown }).data;
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      return data as T;
    }
    return body as T;
  }
  return undefined;
}

/**
 * 工具 state 归一：v2 的 `state.content[]`（数组）→ vteam 渲染层读的 `state.output`（字符串）；
 * v2 的 `state.error`（`{type,message}` 对象）→ 渲染层读的 `state.error`（字符串）。
 *
 * 归一是**必需**的：web（`msg-parts.tsx`）只认 `state.output` / `state.error` 两个字符串字段，
 * 不归一则工具卡片永远空白、失败原因不显示。
 */
export function normalizeV2ToolState(
  state: unknown,
  time?: { created?: number; completed?: number },
): unknown {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return state;
  }
  const source = state as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  if (Array.isArray(source.content)) {
    out.output = v2ToolContentToText(source.content);
  }
  if (source.error !== null && typeof source.error === 'object' && !Array.isArray(source.error)) {
    const message = (source.error as { message?: unknown }).message;
    if (typeof message === 'string') {
      out.error = message;
      out.errorDetail = source.error;
    }
  }
  if (time) {
    out.time = { start: time.created, end: time.completed };
  }
  return out;
}

/**
 * v2 的 agent 目录查询路径（**位置作用域**）。
 *
 * ⚠️ **为什么必须带 location**（实测 opencode v2.0.28，证据见
 * `docs/agent-platform/opencode-v2-contract-baseline/`）：
 * - `GET /api/agent`（**不带** location）解析的是 serve 的**默认 location**（serve 的 cwd），
 *   **不跟随会话的目录**；而且**冷启动时它返回空数组**（项目配置是异步加载的）。
 * - `GET /api/agent?location[directory]=<dir>` 才返回**该 location 的 agent 集合**
 *   （项目配置按目录**向上**查找 ⇒ 子目录也能看到项目级 agent 与它的 `system`）。
 *
 * ⇒ 「不带 location 就查不到本会话的 agent」是**上游既有事实**，不是我们的实现选择。
 *
 * 扁平写法 `?location=<path>` 会被 400 拒绝（`InvalidRequestError`）——必须是
 * **deepObject 风格**的 `location[directory]`。
 *
 * location 为空串 ⇒ 不带任何参数 = 查询 serve 的默认 location（会话就停在那里时的正确问法）。
 */
export function buildV2AgentListPath(location: string): string {
  if (location === '') {
    return '/api/agent';
  }
  const query = new URLSearchParams();
  query.set('location[directory]', location);
  return `/api/agent?${query.toString()}`;
}

/** v2 的 `Tool.Content[]` → 文本（文本项取 text，文件项取占位描述）。 */
function v2ToolContentToText(content: unknown[]): string {
  const chunks: string[] = [];
  for (const item of content) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const record = item as { type?: string; text?: string; uri?: string; name?: string | null };
    if (record.type === 'file') {
      chunks.push(`[文件] ${record.name ?? record.uri ?? ''}`);
      continue;
    }
    if (typeof record.text === 'string') {
      chunks.push(record.text);
    }
  }
  return chunks.join('\n');
}

/**
 * vteam 的内容单元（parts）→ v2 的 prompt 正文与附件。
 *
 * vteam 的 `parts` 是**不透明数组**（业务层只保证"文本与附件混装"），故这里按形识别：
 * - `{type:'text', text}` → 进正文；
 * - `{type:'file', mime, filename, url:'file://…'}` → 进 `files[]`（`url` → `uri`）。
 *
 * 多个文本块用换行拼接（保住块间结构；直接相连会把上一块末行与下一块首行粘成一行）。
 */
export function translateV2PromptParts(parts: unknown[]): {
  text: string;
  files: V2FileAttachment[];
} {
  const texts: string[] = [];
  const files: V2FileAttachment[] = [];
  for (const raw of parts) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const part = raw as {
      type?: string;
      text?: unknown;
      url?: unknown;
      filename?: unknown;
      description?: unknown;
    };
    if (part.type === 'file') {
      const uri = typeof part.url === 'string' ? part.url.trim() : '';
      if (uri === '') {
        continue;
      }
      const file: V2FileAttachment = { uri };
      if (typeof part.filename === 'string' && part.filename !== '') {
        file.name = part.filename;
      }
      if (typeof part.description === 'string' && part.description !== '') {
        file.description = part.description;
      }
      files.push(file);
      continue;
    }
    if (typeof part.text === 'string') {
      texts.push(part.text);
    }
  }
  return { text: texts.join('\n'), files };
}

/** v2 的 form 字段 → vteam 的问题条目（一个字段 = 一个问题）。 */
export function mapV2FormField(form: V2Form, field: V2FormField): {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
} {
  const options = (field.options ?? []).map((option) => ({
    label: option.label ?? option.value ?? '',
    description: option.description ?? '',
  }));
  const mapped: {
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  } = {
    question: field.title ?? field.key ?? '',
    header: form.title ?? '',
    options,
  };
  if (field.type === 'multiselect') {
    mapped.multiple = true;
  }
  if (field.custom === true) {
    mapped.custom = true;
  }
  return mapped;
}

/**
 * vteam 的答复（每题一个"选中项数组"）→ v2 的 `answer`（field key → 值）。
 *
 * vteam 存的是**选项 label**（`options[].label`），v2 要的是**选项 value**——故按字段的
 * `options[]` 做 label→value 映射；无选项的字段（boolean/number/自由文本）直接取用户输入。
 *
 * `fields` 未知时（拿不到表单详情）退化为**按序号的 key**（`"0"`/`"1"`…）：宁可让上游
 * 报「答案非法」，也不把答复静默丢掉——调用方拿到的是明确的 4xx，而不是"以为答复成功了"。
 */
export function buildV2FormAnswer(
  fields: V2FormField[] | undefined,
  answers: string[][],
): Record<string, unknown> {
  const answer: Record<string, unknown> = {};
  const count = fields ? fields.length : answers.length;
  for (let index = 0; index < count; index++) {
    const field = fields?.[index];
    const key = field?.key ?? String(index);
    if (key === '') {
      continue;
    }
    const selected = Array.isArray(answers[index]) ? answers[index] : [];
    const options = field?.options ?? [];
    const values = selected.map((label) => {
      const hit = options.find((option) => option.label === label);
      return hit?.value ?? label;
    });
    if (field?.type === 'multiselect') {
      answer[key] = values;
      continue;
    }
    answer[key] = values.length > 0 ? values[0] : '';
  }
  return answer;
}

/** v2 驱动构造选项。 */
export interface V2DriverOptions {
  /** serve baseUrl（http://127.0.0.1:<port>）；serve 启动前可留空，start 后 setBaseUrl 注入 */
  baseUrl?: string;
  /** serve 认证密码（OPENCODE_SERVER_PASSWORD，Basic Auth username=opencode）；空=不鉴权 */
  serverPassword?: string;
  /**
   * 鉴权口令的**动态来源**（优先于 `serverPassword`；**每次请求时求值**）。
   *
   * 为什么需要：v2 **恒开鉴权**，未配置 OPENCODE_SERVER_PASSWORD 时 opencode 会
   * **自动生成**随机密码并打到 stdout——worker 要等 serve 起来、捕获到它之后才知道
   * 真实口令 ⇒ 口令**不能**在建驱动那一刻固化（固化 = 空口令 ⇒ 驱动每个请求都 401，
   * 而 worker 仍注册成功、看起来健康——最坏的静默失败形态）。
   *
   * 契约：返回 null/undefined/空串 = 此刻没有口令 ⇒ 回落到静态 `serverPassword`。
   */
  serverPasswordProvider?: () => string | null | undefined;
  /** 单次 HTTP 请求超时 ms；默认 60000 */
  timeoutMs?: number;
  /** 日志输出；默认 console */
  logger?: Logger;
  /**
   * 默认工作目录（建会话时的 `location.directory`）。
   * 缺省 = 被驱动端默认目录（serve 的 cwd）。⚠️ v2 的会话目录是**会话属性**，
   * 不是逐次请求参数——见 `applyDirectory`。
   */
  directory?: string;
  /**
   * 逐消息 system blob 的**插件交接**通道（D6 候选 (f)；见 `v2-system-handoff.ts`）。
   *
   * 缺省 = **不启用** ⇒ 顶层 system 一律走**文本前缀兜底**（与插件方案落地前逐字节一致）。
   * 启用且「插件已注入 + 已被 serve 加载」时 ⇒ blob 走**模型请求的 system 段**，
   * **不再**拼进正文（两条路互斥 ⇒ 绝不重复注入）。
   */
  systemHandoff?: SystemHandoffPort;
}

export class V2Driver implements OpenCodeDriver {
  private baseUrlValue: string;
  private readonly serverPassword: string;
  /** 鉴权口令的动态来源（每次请求时求值；见 `V2DriverOptions.serverPasswordProvider`）。 */
  private readonly serverPasswordProvider?: () => string | null | undefined;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly defaultDirectory: string;
  /**
   * 逐消息 system blob 的**插件交接**通道（D6 候选 (f)）。
   *
   * 缺省 = undefined ⇒ 顶层 system 一律走文本前缀兜底（**永远可用的下限**）。
   */
  private readonly systemHandoff?: SystemHandoffPort;
  /**
   * 会话当前所在目录（sessionID → directory）。
   *
   * 为什么要记：v2 的目录是**会话属性**（prompt 没有 directory 参数），改目录只能走
   * `POST /api/session/{id}/move`。记下当前目录才能避免每次下发都发一次 move。
   */
  private readonly sessionDirectories = new Map<string, string>();
  /**
   * 已下发过提示的会话（sessionID 集合）。
   *
   * 用途：目录切换（`move`）只在**首次**下发前做——在飞注入（同一会话的第二次下发）
   * 时会话正在跑，绝不能改它的目录。
   */
  private readonly promptedSessions = new Set<string>();
  /**
   * 表单字段缓存（`sessionID:formID` → fields[]）。
   *
   * 为什么需要：vteam 的答复接口只给「答案数组」，没有字段 key；而 v2 的 `answer` 是
   * `{fieldKey: value}` 映射——必须知道字段 key 与选项 value 才能翻译。缓存命中不了时
   * 回落到 `GET /api/session/{id}/form/{formID}`（Form.Detail 带 fields[]）。
   */
  private readonly formFields = new Map<string, V2FormField[]>();
  /**
   * agent 的**配置化 system 提示**缓存（`<location>\0<agentId>` → system 文本；空串 = 该 agent 没有配置化 system）。
   *
   * 为什么需要它：T15 起，角色提示的**静态**部分写在 `agents.<name>.system`（v2 原生键），
   * 由 v2 自己在模型请求的 system 段里使用；而 vteam 的**逐消息** system blob（产出物协议 /
   * @ 机制）只能走文本前缀兜底（v2 的 prompt body 无 `system` 字段）。两者**同时**生效时，
   * 同一段角色提示会出现两次（一次在 system 段、一次在 user 段）⇒ 必须有闸门。
   *
   * 缓存的理由：`GET /api/agent` 不能逐 prompt 调；agent 的配置化 system 在一次 serve
   * 生命周期内是稳定的（配置变更会重启 serve）⇒ 每个 (location, agent) 最多查一次，结论
   * （含"没有 system"）一并缓存。
   *
   * ⚠️ **键里带 location**：agent 集合是**按目录**发现的（不同项目里同名 agent 可能是不同的
   * agent，system 也可能不同）⇒ 只按 agent id 缓存会把别的项目的结论带过来。
   */
  private readonly agentSystemPrompts = new Map<string, string>();
  /** 「v2 无 todo 端点」告警的节流时间戳（避免每次轮询刷屏）。 */
  private todoWarnedAt = 0;

  constructor(options: V2DriverOptions = {}) {
    this.baseUrlValue = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.serverPassword = options.serverPassword ?? '';
    this.serverPasswordProvider = options.serverPasswordProvider;
    this.timeoutMs = options.timeoutMs ?? V2_DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger ?? console;
    this.defaultDirectory = options.directory ?? '';
    this.systemHandoff = options.systemHandoff;
  }

  /** 当前 serve baseUrl（空=尚未注入，serve 启动成功后由 index.ts 注入）。 */
  get baseUrl(): string {
    return this.baseUrlValue;
  }

  /** serve 启动成功后注入实际 baseUrl（随机端口场景）。 */
  set baseUrl(url: string) {
    const next = url.replace(/\/+$/, '');
    if (next !== this.baseUrlValue) {
      // serve 换了实例（重启/换端口）→ 会话与表单缓存全部作废
      this.sessionDirectories.clear();
      this.promptedSessions.clear();
      this.formFields.clear();
      // agent 的配置化 system 也要重新取（新实例 = 新的配置）
      this.agentSystemPrompts.clear();
    }
    this.baseUrlValue = next;
    this.logger.info(`[v2-driver] baseUrl 更新: ${this.baseUrlValue}`);
  }

  /** serve Basic Auth 密码（订阅事件流时用；空=不鉴权）。 */
  get authPassword(): string {
    return this.resolveServerPassword();
  }

  /**
   * 实际用于鉴权的口令：动态来源优先（serve 的**实际**口令），空则回落静态值。
   *
   * 动态来源优先的原因：v2 自动生成的密码只有 serve 起来之后才知道（见
   * `V2DriverOptions.serverPasswordProvider`）。
   */
  private resolveServerPassword(): string {
    const dynamic = this.serverPasswordProvider?.();
    if (typeof dynamic === 'string' && dynamic !== '') {
      return dynamic;
    }
    return this.serverPassword;
  }

  /**
   * POST /api/session：创建会话。
   *
   * body：`{location?:{directory}, model?:{id,providerID}}`（v2 的 model 形是 `Model.Ref`
   * ——**字段名是 `id` 不是 `modelID`**，写错会被 400 `Missing key at ["model"]["id"]`）。
   * 响应 `{data: Session.Info}` → 取 `data.id`。
   */
  async createSession(model?: DriverModelRef | null): Promise<string> {
    const path = '/api/session';
    const body: Record<string, unknown> = {};
    if (this.defaultDirectory !== '') {
      body.location = { directory: this.defaultDirectory };
    }
    if (model) {
      body.model = { id: model.modelID, providerID: model.providerID };
    }
    const res = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await this.readJson<{ data?: V2SessionInfo }>(res, path);
    const sessionID = payload.data?.id;
    if (typeof sessionID !== 'string' || sessionID === '') {
      throw new DriverRequestError(`[v2-driver] createSession 响应缺少会话 id: ${JSON.stringify(payload)}`);
    }
    if (this.defaultDirectory !== '') {
      this.sessionDirectories.set(sessionID, this.defaultDirectory);
    }
    this.logger.info(`[v2-driver] createSession -> ${sessionID}`);
    return sessionID;
  }

  /**
   * POST /api/session/{id}/prompt：下发提示（**入队**，不是同步执行）。
   *
   * v2 的 prompt body 没有 `system` / `parts` / `model` / `directory`，故：
   * - 模型 → `POST /api/session/{id}/model`（会话级切换，**逐消息带模型在 v2 不存在**）；
   * - agent → `POST /api/session/{id}/agent`（会话级激活；**这才是角色提示真正生效的开关**——
   *   进入模型请求的是配置里 `agents.<name>.system` 的内容，不是本方法传的任何字符串）；
   * - 目录 → `POST /api/session/{id}/move`（会话属性）；
   * - 正文 → `text`（字符串）；附件 → `files[]`。
   *
   * ⚠️ **顶层 system 提示的承载（两条路，互斥）**：
   * v2 的 prompt body 无 `system` 字段（带上去虽不报错但**完全无效**——实测 200 且被忽略）。
   * ⇒ 顶层 system 文本（产出物协议 / @ 机制那串 blob）有两条落点：
   * - **插件交接（D6 候选 (f)）**：worker 在下发前把 blob 写进**按会话的交接文件**，
   *   serve 内的 v2 插件用 `ctx.session.hook("context", cb)` → `event.system.push(...)`
   *   把它推进**模型请求的 system 段**（= v1 逐消息 `system` 的等价落点，T4 已实测该
   *   hook 生效）。**生效条件**：插件产物在位 **且** 插件已被当前 serve 加载
   *   （就绪标记）——两者都由**文件系统事实**判定（**不**依赖 `GET /api/plugin`，
   *   那个端点实测不可靠）。
   * - **文本前缀兜底（计划 D6 兜底 (d)）**：拼在正文之前 ⇒ 落在模型的 **user 段**。
   *   插件不在位 / 未加载 / 写盘失败时**恒可用**（与 opencode 版本无关，永远是下限）。
   *
   * ⚠️ **残余语义缺口（兜底路径）**：文本前缀落在 **user 段** ⇒ 模型可能把它当成
   * "用户说的话"而不是系统指令（**优先级更低**）。插件路径上线后这条缺口对
   * 「插件已加载」的会话**关闭**；老镜像 / 插件未注入的部署仍然是 user 段（显式告警，
   * 不谎称已进 system 段）。
   *
   * ⚠️ **不重复注入闸门（T15）**：若已激活的 agent **自带配置化 system**
   * （`agents.<name>.system`），那一段提示**已经在模型的 system 段里**；此时再把逐消息 blob
   * 也推进 system 段 = 同一段提示出现两次（一次在 agent 的 system 段、一次在 blob 里）
   * ⇒ **逐消息 blob 整体不注入**（两条路都不走）。
   * 「该 agent 有没有配置化 system」按**会话目录作用域**查（`resolveAgentSystem`）——
   * 不带 location 的 agent 查询拿不到本会话的 agent（见该方法的说明）。
   *
   * ⚠️ **缓存稳定性**：交接文件**写一次、读多次**（同一会话的 blob 内容不变 ⇒ 不重写）
   * ⇒ 插件在 agent 循环的每一次模型请求推进的 system 段**逐字节相同**
   * ⇒ provider 侧的 prompt 前缀缓存**不受影响**（详见 `v2-system-handoff.ts`）。
   */
  async sendMessage(sessionID: string, input: DriverPromptInput): Promise<DriverPromptResult> {
    await this.applyDirectory(sessionID, input.directory);
    if (input.model) {
      await this.switchModel(sessionID, input.model);
    }
    if (input.agent) {
      await this.switchAgent(sessionID, input.agent);
    }
    const { text, files } = translateV2PromptParts(input.parts ?? []);
    const system = typeof input.system === 'string' ? input.system.trim() : '';
    // 防重复注入：已激活 agent 若带配置化 system，逐消息 blob 就不再拼进正文
    // （只在**确实有 blob** 时才查 agent 列表——没有 blob 就不需要这个判据）
    const configuredSystem =
      system !== '' && input.agent ? await this.resolveAgentSystem(sessionID, input.agent) : '';
    const hasConfiguredSystem = configuredSystem.trim() !== '';
    const carrier = await this.routeSystemBlob(sessionID, system, hasConfiguredSystem);
    const prefix = carrier === 'prefix' ? system : '';
    const body: Record<string, unknown> = {
      text: prefix === '' ? text : `${prefix}\n\n${text}`,
      delivery: input.delivery ?? 'steer',
    };
    if (files.length > 0) {
      body.files = files;
    }
    if (system !== '' && hasConfiguredSystem) {
      this.logger.info(
        `[v2-driver] session ${sessionID}: agent ${input.agent} 已有配置化 system（agents.${input.agent}.system），` +
          '顶层 system 提示不再拼入正文（避免同一段提示在 system 段与 user 段各出现一次）',
      );
    } else if (carrier === 'plugin') {
      this.logger.info(
        `[v2-driver] session ${sessionID}: 顶层 system 提示已交插件推进模型请求的 system 段` +
          '（D6 候选 (f) 插件交接路径；正文不再拼前缀 ⇒ 绝不重复注入）',
      );
    } else if (system !== '') {
      this.logger.warn(
        `[v2-driver] session ${sessionID}: v2 的 prompt body 无 system 字段（带上去会被忽略），` +
          '顶层 system 提示已作为文本前缀并入正文（计划 D6 兜底 (d)）；' +
          '若需真正进 system 段，须由插件交接（D6 (f)）或配置 agents.<name>.system + POST /api/session/{id}/agent 承载',
      );
    }
    const path = `/api/session/${encodeURIComponent(sessionID)}/prompt`;
    const res = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    this.promptedSessions.add(sessionID);
    const payload = await this.readJson<{ data?: { id?: string; delivery?: string } }>(res, path);
    const modelLabel = input.model
      ? `${input.model.providerID}/${input.model.modelID}`
      : '(default)';
    this.logger.info(
      `[v2-driver] sendMessage -> ${sessionID} model=${modelLabel} agent=${input.agent ?? '(default)'} ` +
        `delivery=${body.delivery} inbox=${payload.data?.id ?? '-'} (HTTP ${res.status})`,
    );
    const delivery = payload.data?.delivery;
    return {
      ...(typeof payload.data?.id === 'string' ? { messageId: payload.data.id } : {}),
      ...(delivery === 'steer' || delivery === 'queue' ? { delivery } : {}),
    };
  }

  /**
   * GET /api/session/{id}/message：拉取会话消息列表（**升序**，与 v1 的整会话列表等价）。
   *
   * v2 的默认顺序是 **desc**（新→旧）且带游标分页；本驱动：
   * 1. 显式请求 `order=asc`（首屏带 order；**后续翻页不得再带 order**——游标已编码方向，
   *    两者同传会被 400 `InvalidCursorError`）；
   * 2. 按 `cursor.next` 一直翻到取完（长会话不丢消息）；
   * 3. 映射成 vteam 的 `DriverMessage`（user/assistant，其余类型丢弃）。
   *
   * `options.limit` 缺省 = 全部（业务层轮询完成判定需要完整列表）。
   */
  async getMessages(
    sessionID: string,
    options: DriverMessageQuery = {},
  ): Promise<DriverMessage[]> {
    const order = options.order ?? 'asc';
    const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : undefined;
    const pageSize = limit === undefined ? MESSAGE_PAGE_SIZE : Math.min(limit, MESSAGE_PAGE_SIZE);
    const collected: V2Message[] = [];
    let cursor: string | undefined = options.cursor;
    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      const query = new URLSearchParams();
      if (cursor === undefined) {
        query.set('order', order);
      }
      query.set('limit', String(pageSize));
      if (cursor !== undefined) {
        query.set('cursor', cursor);
      }
      const path = `/api/session/${encodeURIComponent(sessionID)}/message${query.toString() ? `?${query}` : ''}`;
      const res = await this.request(path);
      const payload = await this.readJson<{ data?: unknown; cursor?: { next?: string } }>(res, path);
      const pageMessages = unwrapV2List<V2Message>(payload);
      collected.push(...pageMessages);
      if (limit !== undefined && collected.length >= limit) {
        break;
      }
      if (pageMessages.length === 0) {
        break;
      }
      const next = payload.cursor?.next;
      if (typeof next !== 'string' || next === '' || next === cursor) {
        break;
      }
      cursor = next;
    }
    const mapped: DriverMessage[] = [];
    for (const raw of collected) {
      const message = this.mapMessage(sessionID, raw);
      if (message) {
        mapped.push(message);
      }
    }
    return mapped;
  }

  /**
   * GET /api/session/{id}/form：列出该会话待答复的问题（v2 的「表单」通道 = vteam 的 question）。
   *
   * 形状差异（**有损**）：v2 的 form 是 `{id,title,fields[]}`（字段带类型：string/number/
   * integer/boolean/multiselect/external）；vteam 的 question 是 `{question,header,options[],
   * multiple?,custom?}`（选项式）。本驱动**一个字段映射成一个 vteam 问题**（顺序即下标，
   * 答复时按同序对齐），无选项的字段落 `options: []`（自由作答）。
   */
  async listQuestions(sessionID: string): Promise<DriverQuestionRequest[]> {
    const path = `/api/session/${encodeURIComponent(sessionID)}/form`;
    const res = await this.request(path);
    const payload = await this.readJson<{ data?: unknown }>(res, path);
    const forms = unwrapV2List<V2Form>(payload);
    const out: DriverQuestionRequest[] = [];
    for (const form of forms) {
      const formID = typeof form.id === 'string' ? form.id : '';
      if (formID === '') {
        continue;
      }
      const fields = Array.isArray(form.fields) ? form.fields : [];
      this.formFields.set(`${sessionID}:${formID}`, fields);
      out.push({
        id: formID,
        sessionId: sessionID,
        questions: fields.map((field) => mapV2FormField(form, field)),
      });
    }
    return out;
  }

  /**
   * POST /api/session/{id}/form/{formID}/reply：答复问题。
   *
   * ⚠️ **body 键名/形状与 v1 完全不同**：v1 是 `{answers: string[][]}`，v2 是
   * `{answer: {fieldKey: value}}`（`Form.Reply.answer` 必填）。vteam 的答复载荷是
   * 「每题一个选中项数组」，故本驱动按字段顺序把 label 翻成 v2 的 value。
   */
  async replyQuestion(
    sessionID: string,
    requestID: string,
    answers: string[][],
  ): Promise<void> {
    const fields = await this.resolveFormFields(sessionID, requestID);
    const answer = buildV2FormAnswer(fields, answers ?? []);
    const path = `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(requestID)}/reply`;
    await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
    this.logger.info(`[v2-driver] replyQuestion -> ${sessionID}/${requestID} (HTTP 204)`);
  }

  /** DELETE /api/session/{id}/form/{formID}：拒绝问题（v2 的取消路径）。 */
  async rejectQuestion(sessionID: string, requestID: string): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(requestID)}`;
    await this.request(path, { method: 'DELETE' });
    this.logger.info(`[v2-driver] rejectQuestion -> ${sessionID}/${requestID}`);
  }

  /**
   * GET /api/session/{id}/permission：列出该会话待答复的权限请求。
   *
   * v2 的 `Permission.Request` 字段名与 vteam 的 `DriverPermissionRequest` **已经同名**
   * （`action` / `resources` / `save` / `metadata` / `source`）——v1 那套
   * `permission`/`patterns` 归一在 v2 不需要。
   */
  async listPermissions(sessionID: string): Promise<DriverPermissionRequest[]> {
    const path = `/api/session/${encodeURIComponent(sessionID)}/permission`;
    const res = await this.request(path);
    const payload = await this.readJson<{ data?: unknown }>(res, path);
    const requests = unwrapV2List<V2PermissionRequest>(payload);
    return requests
      .filter((item) => typeof item.id === 'string' && item.id !== '')
      .map((item) => ({
        id: item.id as string,
        sessionId: sessionID,
        action: item.action ?? '',
        resources: item.resources ?? [],
        ...(item.save !== undefined ? { save: item.save } : {}),
        ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
        ...(item.source !== undefined ? { source: item.source } : {}),
      }));
  }

  /**
   * POST /api/session/{id}/permission/{requestID}/reply：答复权限请求。
   *
   * ⚠️ **body 键名变了**：v1 是 `{reply:"once"|"always"|"reject"}`，v2 是
   * `{decision:"once"|"always"|"reject", message?}`——用错键名不会报错，但**权限答复不生效**
   * （静默失败点，故在此显式标注）。
   *
   * ⚠️⚠️ **`reject` 必须带 `message`**（v1→v2 迁移回归的根因，实测 2.0.28 / 2.0.32）：
   * v2 对「拒绝」的两种回复形状**语义完全不同**——
   *
   * | reply body | v2 的工具结果 | 本轮执行 |
   * |---|---|---|
   * | `{decision:"reject"}`（无 message） | 工具报错 `{type:"aborted", message:"The user declined this tool call"}` | **整轮被中断**（`session.execution.interrupted`）——模型拿不到任何后续输出 |
   * | `{decision:"reject", message:"<原因>"}` | 工具报错 `{type:"permission.rejected", message:"<原因>"}` | **继续**（`session.execution.succeeded`）——模型读到原因后可降级执行 |
   *
   * ⇒ 无 message 的 reject 会让「被拒绝的那一步」升级成「整轮失败」：worker 侧
   * 终态闸门判 `interrupted` → 不发 `task.completed` → 平台**收不到回执**（空回执）、
   * 会话被判 failed——**正是缺陷 2 的现象**。v1 的拒绝只是一个工具错误（循环能吸收），
   * v2 不是 ⇒ **迁移回归**，必须由本层补齐 message。
   */
  async replyPermission(
    sessionID: string,
    permissionID: string,
    response: DriverPermissionResponse,
  ): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(permissionID)}/reply`;
    const body: { decision: DriverPermissionResponse; message?: string } = {
      decision: response,
    };
    if (response === 'reject') {
      // reject 必须带可读原因：见上方「v2 对拒绝的两种形状」实测表。
      body.message = await this.buildRejectionReason(sessionID, permissionID);
    }
    await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    this.logger.info(
      `[v2-driver] replyPermission -> ${sessionID}/${permissionID}=${response}` +
        (body.message !== undefined ? '（reject 带可读原因：模型可降级继续）' : '') +
        ' (HTTP 204)',
    );
  }

  /**
   * 拒绝原因文案（v2 `message` 字段的内容）。
   *
   * - **带上动作与资源**（从 serve 的 pending 权限请求里取）：被拒的是
   *   `external_directory / /tmp/*` 还是 `shell / rm -rf`，对模型接下来的降级动作
   *   影响很大——只说「被拒绝」等于让模型瞎猜。
   * - **取不到 pending 也不放弃原因**（会话已消失/列表接口失败）：退回通用文案，
   *   绝不因为查不到细节就退回「无 message 的 reject」（那会中断整轮）。
   */
  private async buildRejectionReason(
    sessionID: string,
    permissionID: string,
  ): Promise<string> {
    let detail = '';
    try {
      const pending = await this.listPermissions(sessionID);
      const hit = pending.find((p) => p.id === permissionID);
      if (hit) {
        const resources = (hit.resources ?? []).filter((r) => r !== '').join('、');
        const action = hit.action && hit.action !== '' ? hit.action : '未知动作';
        detail = `（动作：${action}${resources ? `，资源：${resources}` : ''}）`;
      }
    } catch (err) {
      this.logger.warn(
        `[v2-driver] 取 pending 权限失败（退回通用拒绝原因）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return (
      `权限请求被拒绝${detail}：本次操作未获授权，请勿重试同一操作；` +
      '请改用其它方案继续推进，并在回复中说明该操作已被拒绝。'
    );
  }

  /**
   * POST /api/session/{id}/interrupt：中止会话。
   *
   * 两种"什么都没发生"都是**成功**、不是错误：
   * - `{interrupted:false}` = 会话空闲，本就是空操作；
   * - HTTP 404 = 会话已不存在（serve 重启/会话被删）→ 中止无对象可中止，幂等空操作。
   */
  async abort(sessionID: string): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionID)}/interrupt`;
    try {
      const res = await this.request(path, { method: 'POST' });
      const payload = await this.readJson<{ interrupted?: boolean }>(res, path);
      this.logger.warn(
        `[v2-driver] abort -> ${sessionID} (interrupted=${payload.interrupted === true})`,
      );
    } catch (err) {
      if (err instanceof DriverRequestError && err.status === 404) {
        this.logger.warn(`[v2-driver] abort -> ${sessionID} 会话已不存在（HTTP 404），按幂等空操作处理`);
        return;
      }
      throw err;
    } finally {
      // 会话生命周期终点 ⇒ 清掉该会话的交接文件（blob 交接目录保持有界）
      this.systemHandoff?.clear(sessionID);
    }
  }

  /**
   * GET /api/agent：列出该目录可见的 agent。
   *
   * v2 的目录参数是 **deepObject 风格**的 query（`location[directory]=<path>`）；扁平写法
   * （`?location=<path>`）会被 400 拒绝（实测 `InvalidRequestError`）。
   *
   * 映射：`name` ← v2 的 **`id`**（agent 键——下发提示与 `agents.<name>.system` 都用它；
   * v1 的 `GET /agent` 同样以键为 name）；`prompt` ← v2 的 `system`（agent 的系统提示全文）；
   * `permission` ← v2 的 `permissions[]`（`{action,resource,effect}` 数组，原样透传）。
   */
  async listAgents(directory?: string): Promise<DriverAgentInfo[]> {
    const path = buildV2AgentListPath(directory ?? '');
    const res = await this.request(path);
    const payload = await this.readJson<{ data?: unknown }>(res, path);
    const agents = unwrapV2List<V2Agent>(payload);
    const mapped = agents.map((agent) => {
      const id = typeof agent.id === 'string' ? agent.id : '';
      const info: DriverAgentInfo = {
        name: id || (agent.name ?? ''),
        mode: (agent.mode === 'primary' || agent.mode === 'subagent' || agent.mode === 'all'
          ? agent.mode
          : 'all'),
        native: V2_BUILTIN_AGENT_IDS.has(id),
      };
      if (agent.description !== undefined) {
        info.description = agent.description;
      }
      if (agent.hidden !== undefined) {
        info.hidden = agent.hidden;
      }
      if (agent.model?.providerID && agent.model?.id) {
        info.model = { providerID: agent.model.providerID, modelID: agent.model.id };
      }
      if (agent.permissions !== undefined) {
        info.permission = agent.permissions;
      }
      if (agent.system !== undefined) {
        info.prompt = agent.system;
      }
      return info;
    });
    this.logger.info(
      `[v2-driver] listAgents -> ${mapped.length} 个${directory ? ` (directory=${directory})` : ''}`,
    );
    return mapped;
  }

  /**
   * listTodos：**v2 没有 todo 端点**（计划 Q8 未决）→ 优雅降级为空数组。
   *
   * 告警按时间节流（每分钟最多一条）——该方法被控制面的计划 Tab 轮询调用，不节流会刷屏。
   */
  async listTodos(sessionID: string, directory?: string): Promise<[]> {
    const now = Date.now();
    if (now - this.todoWarnedAt > 60_000) {
      this.todoWarnedAt = now;
      this.logger.warn(
        `[v2-driver] listTodos -> v2 无 todo 端点（计划 Q8 未决），返回空数组` +
          `${directory ? ` (directory=${directory})` : ''} session=${sessionID}`,
      );
    }
    return [];
  }

  /**
   * GET /api/model：列出模型目录。
   *
   * **2.0.28 与 2.0.32 的响应形态一致**：都是 `{location, data:[...]}`（2.0.28 实测；
   * 2.0.32 见**发布的 `@opencode/client@2.0.32`** `ModelListOutput = { location, data }`）
   * ——**不存在已知的版本差异**。`unwrapV2List` 里的**裸数组分支是无害的防御性容忍**
   * （针对假想的未来形态），**不是**版本漂移的证据。
   *
   * 映射：`id` = `providerID/modelID`（vteam 口径）；`status` 透传 v2 的
   * `status`（active/beta/alpha/deprecated，缺失视为 active）；v2 独有的 `enabled:false`
   * 表示该模型**不可用** → 直接不列出（等价 v1「只列有凭据的 provider」的口径）。
   */
  async listModels(): Promise<DriverModelInfo[]> {
    const path = '/api/model';
    const res = await this.request(path);
    const payload = await this.readJson<{ data?: unknown }>(res, path);
    const models = unwrapV2List<V2Model>(payload);
    return models
      .filter((model) => model.enabled !== false)
      .map((model) => {
        const providerID = model.providerID ?? '';
        const modelID = model.modelID ?? model.id ?? '';
        return {
          id: `${providerID}/${modelID}`,
          name: model.name ?? modelID,
          providerID,
          modelID,
          status: model.status ?? 'active',
        };
      });
  }

  /**
   * GET /api/info：健康检查。
   *
   * ⚠️ **不能用 `GET /`**：v2 的 `GET /` 是 web SPA（未鉴权也 200）——只查状态码会**因错误的
   * 原因判"服务正常"**。`/api/info` 未鉴权 401 / 已鉴权 200，且 body 是 JSON。
   * 本实现额外断言 body 里确有 `version` 字段（防"200 但是 HTML"）。
   */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.request('/api/info');
      if (!res.ok) {
        return false;
      }
      const payload = await this.readJson<{ version?: string }>(res, '/api/info');
      return typeof payload.version === 'string' && payload.version !== '';
    } catch {
      return false;
    }
  }

  // ---- 内部实现 ----

  /**
   * 会话目录对齐：v2 的目录是**会话属性**（prompt 无 directory 参数），改目录只能走
   * `POST /api/session/{id}/move`（实测 204，且会新增一条 `location-switched` 消息）。
   *
   * **只在"本会话的第一次下发提示"之前 move**：那一刻会话必然是空闲的——在飞的会话
   * （在飞注入路径）绝不 move（那会把正在跑的这一轮的工作目录改掉，文件写到别处）。
   * 同一会话同目录也不重复 move（避免每次下发都产生一条切换消息）。
   */
  private async applyDirectory(sessionID: string, directory?: string): Promise<void> {
    const target = directory?.trim();
    if (!target) {
      return;
    }
    if (this.promptedSessions.has(sessionID)) {
      return;
    }
    if (this.sessionDirectories.get(sessionID) === target) {
      return;
    }
    const path = `/api/session/${encodeURIComponent(sessionID)}/move`;
    await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: target }),
    });
    this.sessionDirectories.set(sessionID, target);
    this.logger.info(`[v2-driver] session ${sessionID} 目录切换 -> ${target}`);
  }

  /** POST /api/session/{id}/model：切换后续 turn 使用的模型（v2 的 prompt body 无 model 字段）。 */
  private async switchModel(sessionID: string, model: DriverModelRef): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionID)}/model`;
    await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: { id: model.modelID, providerID: model.providerID } }),
    });
  }

  /**
   * POST /api/session/{id}/agent：激活 agent（v2 唯一被文档背书的激活机制）。
   *
   * ⚠️ 进入模型请求的是**配置里 `agents.<name>.system` 的内容**（T15 写入），不是本方法
   * 传的任何字符串；prompt body 的 `agents:[{name}]` attachment 是 **no-op**（T4 实测），
   * 故此处**不**使用它。
   */
  private async switchAgent(sessionID: string, agent: string): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionID)}/agent`;
    await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent }),
    });
  }

  /**
   * 顶层 system 提示的**载体选择**（D6 候选 (f) 插件交接 vs 文本前缀兜底）。
   *
   * 三种结果：
   * - `'none'`：**不注入**（没有 blob；或 agent 自带配置化 system ⇒ 整段 blob 不注入，
   *   避免同一段提示在 system 段与 user 段各出现一次）；
   * - `'plugin'`：blob 已交插件 ⇒ 走**模型请求的 system 段**；
   * - `'prefix'`：兜底 ⇒ blob 拼进正文（**user 段**）。
   *
   * ⚠️ **互斥（不重复注入的硬保证）**：
   * - 走插件路 ⇒ 正文**不**拼前缀；
   * - 走前缀兜底 ⇒ **清掉**该会话的交接文件（否则插件会把同一段 blob 也推进 system 段
   *   ⇒ 同一段提示出现两次）。
   * ⇒ 同一段 blob **要么**在 system 段、**要么**在 user 段，**绝不**两者都有。
   */
  private async routeSystemBlob(
    sessionID: string,
    system: string,
    hasConfiguredSystem: boolean,
  ): Promise<'none' | 'prefix' | 'plugin'> {
    if (system === '') {
      return 'none';
    }
    const handoff = this.systemHandoff;
    if (hasConfiguredSystem) {
      handoff?.clear(sessionID);
      return 'none';
    }
    if (handoff && handoff.pluginInstalled()) {
      // 判据 = 「插件已为**本会话所在 location** 加载」（v2 的插件按 location 加载 ⇒
      // 别的 location 加载过**不能**推出本 location 加载了 ⇒ 标记按 location 分桶）。
      // location 由会话目录推导（会话目录 = location；会话停在默认 location 时为空串）。
      const location = this.resolveSessionDirectory(sessionID);
      const ready = handoff.locationReady(location)
        ? true
        : await handoff.awaitLocationReady(location);
      if (ready && handoff.deliver(sessionID, system)) {
        return 'plugin';
      }
    }
    handoff?.clear(sessionID);
    return 'prefix';
  }

  /**
   * 取某 agent 的**配置化 system 提示**（v2 的 `Agent.Info.system`）。
   *
   * ⚠️ **必须按 location 作用域查**（实测 opencode v2.0.28）：
   * `GET /api/agent`（**不带** location）解析的是 serve 的**默认 location**，**不跟随会话的
   * 目录**，冷启动时还会返回**空数组** ⇒ 拿它判"该 agent 有没有配置化 system"会**恒判"没有"**
   * ⇒ 逐消息 blob 被重复注入（角色提示在 system 段与 user 段各出现一次）。
   * 正确问法是 `GET /api/agent?location[directory]=<会话目录>`（见 `buildV2AgentListPath`）。
   *
   * location 的来源：会话的当前目录——建会话时记下驱动默认目录（`POST /api/session` 的
   * `location.directory`），`POST /api/session/{id}/move` 之后更新（`applyDirectory`）。
   * 两者都没有 ⇒ 会话就停在 serve 的**默认 location** ⇒ 不带 location 的查询**恰好**是对的
   * （保留为回落，不丢任何现有行为）。
   *
   * 缓存：`<location>\0<agentId>` → system 文本（含"该 agent 没有配置化 system"这一结论）
   * ⇒ **不产生逐 prompt 的网络往返**。取列表失败时**不缓存**（下次重试），并按"无配置化
   * system"处理（调用方保留文本前缀兜底）——这条链路是提示降级，不是主链路，不该抛错中断下发。
   *
   * ⚠️ **上游冷启动会先给一个空数组**（实测 v2.0.28：serve 起来后第一次 agent 查询返回
   * `data: []`，项目配置是异步加载的，要到第二、三次查询才出现）⇒ 那一轮闸门**不会**触发
   * （仍走文本前缀）。因为该 agent 不在列表里，**这个结论不会被缓存** ⇒ 下一轮提示会重查
   * ⇒ 上游预热后闸门即生效（不会把"空列表"当成永久结论钉死）。
   */
  private async resolveAgentSystem(sessionID: string, agent: string): Promise<string> {
    const location = this.resolveSessionDirectory(sessionID);
    const cacheKey = `${location}\u0000${agent}`;
    const cached = this.agentSystemPrompts.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const path = buildV2AgentListPath(location);
    try {
      const res = await this.request(path);
      const payload = await this.readJson<{ data?: unknown }>(res, path);
      for (const raw of unwrapV2List<V2Agent>(payload)) {
        const id = typeof raw.id === 'string' ? raw.id : '';
        if (id === '') {
          continue;
        }
        this.agentSystemPrompts.set(
          `${location}\u0000${id}`,
          typeof raw.system === 'string' ? raw.system : '',
        );
      }
    } catch (err) {
      this.logger.warn(
        `[v2-driver] 取 agent 列表失败（${err instanceof Error ? err.message : String(err)}）：` +
          `无法确认 agent ${agent} 是否已配置 system，按"无配置化 system"处理（保留文本前缀兜底）`,
      );
      return '';
    }
    return this.agentSystemPrompts.get(cacheKey) ?? '';
  }

  /**
   * 会话的当前目录（= v2 的会话 location）。
   *
   * - 建会话时记下驱动默认目录（`POST /api/session` 的 `location.directory`）；
   * - `POST /api/session/{id}/move` 之后由 `applyDirectory` 更新。
   *
   * 两者都没有 ⇒ 会话停在 serve 的**默认 location**（serve 的 cwd）⇒ 返回空串
   * （调用方据此改问「默认 location 的 agent 集合」）。
   */
  private resolveSessionDirectory(sessionID: string): string {
    const tracked = this.sessionDirectories.get(sessionID);
    if (typeof tracked === 'string' && tracked !== '') {
      return tracked;
    }
    return this.defaultDirectory;
  }

  /**
   * 取表单字段（答复翻译需要字段 key 与选项 value）。
   *
   * 先查缓存（`listQuestions` 时已存）；缓存未命中 → `GET /api/session/{id}/form/{formID}`
   * （`Form.Detail` 带 `fields[]`）。两条路都拿不到 → 返回 undefined（答复退化为按序号的
   * key），**不抛错**：答复是"尽力而为"的通道，抛错会让用户点了选项却收不到任何回执。
   */
  private async resolveFormFields(
    sessionID: string,
    formID: string,
  ): Promise<V2FormField[] | undefined> {
    const cacheKey = `${sessionID}:${formID}`;
    const cached = this.formFields.get(cacheKey);
    if (cached) {
      return cached;
    }
    const path = `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`;
    try {
      const res = await this.request(path);
      const payload = await this.readJson<{ data?: { fields?: V2FormField[] } }>(res, path);
      const fields = Array.isArray(payload.data?.fields) ? payload.data!.fields! : [];
      this.formFields.set(cacheKey, fields);
      return fields;
    } catch (err) {
      this.logger.warn(
        `[v2-driver] replyQuestion -> ${sessionID}/${formID} 取不到表单字段` +
          `（${err instanceof Error ? err.message : String(err)}），按序号的 key 兜底`,
      );
      return undefined;
    }
  }

  /**
   * v2 消息 → vteam 消息。
   *
   * 只映射 `user` 与 `assistant`：
   * - `user`：**没有 parts 数组**（纯 `text`）→ 合成一个文本 part；
   * - `assistant`：`content[]` 逐项映射（text / reasoning / tool），并**合成 `step-finish`**
   *   （v2 无该 part，但控制面拿它做"本轮完成"的幂等键）；
   * - 其余类型（`idle` / `synthetic` / `system` / `skill` / `shell` / `compaction` /
   *   `*-switched`）**丢弃**：它们没有内容，且 vteam 的 role 只有 user/assistant 二值——
   *   若塞进 assistant 会污染 `findAssistantModel` 的"最后一条 assistant"兜底
   *   （idle 消息会让真实模型信息丢失）。idle 的 outcome 信号留给语义层（T14）从事件流取。
   *
   * **part id**：统一口径见 `v2-part-id.ts`（单源；事件路共用）。要点：
   * - id 由**内容类别 + 同类序号**派生，**不用内容下标**——下标形态与事件路不一致；
   * - 序号**只按同类别计** → 重复轮询同一消息时 id 恒定（server 按 id 合并 parts）；
   * - 工具用 provider 侧 call id（`content[].id`）→ 与事件路的 `session.tool.*` 对齐。
   */
  private mapMessage(sessionID: string, raw: V2Message): DriverMessage | undefined {
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (id === '') {
      return undefined;
    }
    const type = raw.type ?? '';
    if (type === 'user') {
      const text = typeof raw.text === 'string' ? raw.text : '';
      const created = raw.time?.created;
      return {
        info: {
          id,
          role: 'user',
          time: { created },
        },
        parts: [
          {
            id: v2TextPartId(id),
            sessionID,
            messageID: id,
            type: 'text',
            text,
            time: { start: created, end: created },
          },
        ],
      };
    }
    if (type !== 'assistant') {
      return undefined;
    }
    const created = raw.time?.created;
    const completed = raw.time?.completed;
    const parts: DriverContent[] = [];
    const content = Array.isArray(raw.content) ? raw.content : [];
    // id 派生器：按内容类别分别计序号（同类第 k 段 → `:k`；第 0 段无序号）
    const deriver = new V2PartIdDeriver(id);
    content.forEach((item) => {
      const itemTime = item.time;
      if (item.type === 'text') {
        parts.push({
          id: deriver.next('text'),
          sessionID,
          messageID: id,
          type: 'text',
          text: typeof item.text === 'string' ? item.text : '',
          ...(item.state !== undefined ? { state: item.state } : {}),
          time: { start: created, end: completed },
        });
        return;
      }
      if (item.type === 'reasoning') {
        parts.push({
          id: deriver.next('reasoning'),
          sessionID,
          messageID: id,
          type: 'reasoning',
          text: typeof item.text === 'string' ? item.text : '',
          ...(item.state !== undefined ? { state: item.state } : {}),
          time: { start: itemTime?.created ?? created, end: itemTime?.completed ?? completed },
        });
        return;
      }
      if (item.type === 'tool') {
        parts.push({
          id: deriver.next('tool', item.id),
          sessionID,
          messageID: id,
          type: 'tool',
          tool: item.name ?? '',
          // provider 侧 call id：v2 的 content 项没有 v1 那种稳定 part id（口径见
          // `v2-part-id.ts`），原 id 落在 callID 里透传（**同时**是工具 part id 的
          // 区分段——事件路的 `session.tool.*` 用的是同一个值）。
          ...(item.id !== undefined ? { callID: item.id } : {}),
          state: normalizeV2ToolState(item.state, itemTime),
          time: { start: itemTime?.created ?? created, end: itemTime?.completed ?? completed },
        });
      }
    });
    const finish = typeof raw.finish === 'string' ? raw.finish : '';
    if (finish !== '') {
      parts.push({
        id: v2StepFinishPartId(id),
        sessionID,
        messageID: id,
        type: 'step-finish',
        reason: finish,
        ...(typeof raw.cost === 'number' ? { cost: raw.cost } : {}),
        ...(raw.tokens !== undefined ? { tokens: mapV2Tokens(raw.tokens) } : {}),
        time: { start: created, end: completed },
      });
    }
    const info: DriverMessage['info'] = {
      id,
      role: 'assistant',
      time: { created, completed },
    };
    if (raw.error !== undefined) {
      info.error = raw.error;
    }
    if (raw.model?.providerID) {
      info.providerID = raw.model.providerID;
    }
    if (raw.model?.id) {
      info.modelID = raw.model.id;
    }
    if (raw.agent !== undefined) {
      info.agent = raw.agent;
    }
    return { info, parts };
  }

  /** 统一请求入口：拼 baseUrl、注入 Basic Auth、AbortController 超时、2xx 校验。 */
  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs: number = this.timeoutMs,
  ): Promise<Response> {
    if (!this.baseUrlValue) {
      throw new DriverRequestError(
        '[v2-driver] baseUrl 未设置：serve 尚未就绪（OpencodeServer.start() 完成后注入）',
      );
    }
    const headers = new Headers(init.headers);
    const auth = this.buildAuthHeader();
    if (auth) {
      headers.set('Authorization', auth);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrlValue}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      // status 必须透传：exec-server 的 isSessionNotFound 依赖 err.status === 404
      // 判定会话失效（serve 重启后旧 ses_ 会话不存在）并自动重建会话。
      if (!res.ok) {
        throw new DriverRequestError(`[v2-driver] ${path} HTTP ${res.status}`, res.status);
      }
      return res;
    } catch (err) {
      throw err instanceof DriverRequestError
        ? err
        : new DriverRequestError(this.describeError(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 读 JSON 响应：先判 `Content-Type`，再判能否解析。
   *
   * 为什么必须判：v2 对 v1 的 legacy 路由返回 **200 + web SPA 的 HTML**（不 404），
   * 若直接把 HTML 当 JSON 解析，得到的是"解析失败"这种含糊错误；这里把陷阱写进错误文案，
   * 让"驱动与被驱动端版本不匹配"一眼可见。
   */
  private async readJson<T>(res: Response, path: string): Promise<T> {
    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    if (!contentType.toLowerCase().includes('json')) {
      throw new DriverRequestError(
        `[v2-driver] ${path} 响应不是 JSON（Content-Type=${contentType || '未设置'}）：` +
          '被驱动端可能不是 opencode v2（v2 的 legacy 路由返回 200 + web SPA 的 HTML）',
      );
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new DriverRequestError(
        `[v2-driver] ${path} 响应不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Basic Auth 头：password 为空 → 不鉴权；否则 `Basic base64(opencode:<password>)`。 */
  private buildAuthHeader(): string | undefined {
    const password = this.resolveServerPassword();
    if (!password) {
      return undefined;
    }
    return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
  }

  /** 错误信息归一（超时/网络/HTTP 消息，Node 18+ fetch abort 抛 DOMException 非 Error 实例）。 */
  private describeError(err: unknown): string {
    const name =
      typeof err === 'object' && err !== null && 'name' in err
        ? (err as { name?: string }).name
        : undefined;
    if (name === 'AbortError') {
      return `[v2-driver] 请求超时（>${this.timeoutMs}ms）`;
    }
    if (err instanceof Error) {
      return `[v2-driver] ${err.message}`;
    }
    return `[v2-driver] ${String(err)}`;
  }
}

/** v2 的 token 用量 → vteam 的用量口径（字段名与 v1 的 step-finish 一致；v2 无 total，不造数）。 */
function mapV2Tokens(tokens: V2Tokens): DriverTokenUsage {
  const usage: DriverTokenUsage = {};
  if (typeof tokens.input === 'number') {
    usage.input = tokens.input;
  }
  if (typeof tokens.output === 'number') {
    usage.output = tokens.output;
  }
  if (typeof tokens.reasoning === 'number') {
    usage.reasoning = tokens.reasoning;
  }
  if (tokens.cache) {
    usage.cache = {};
    if (typeof tokens.cache.read === 'number') {
      usage.cache.read = tokens.cache.read;
    }
    if (typeof tokens.cache.write === 'number') {
      usage.cache.write = tokens.cache.write;
    }
  }
  return usage;
}
