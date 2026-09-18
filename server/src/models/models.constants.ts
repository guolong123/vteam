/**
 * 模型目录域错误码常量（C3 目录 CRUD + C4 凭据；对齐 mcp-server.constants 命名约定：
 * 大写 SNAKE，随异常响应的 code 字段返回）。
 *
 * - 目标模型不存在（GET/PATCH/DELETE :id 路由先查 model）→ 404 MODEL_NOT_FOUND
 * - providerID+modelID 撞 @@unique（POST/PATCH 目录冲突）→ 409 MODEL_EXISTS
 * - 目标凭据不存在（DELETE 吊销但未配置）→ 404 MODEL_CREDENTIAL_NOT_FOUND
 * - body.providerID 与 model.providerID 不一致（POST 校验一致策略）→ 400 MODEL_PROVIDER_MISMATCH
 */
export const MODEL_ERRORS = {
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_EXISTS: 'MODEL_EXISTS',
  MODEL_CREDENTIAL_NOT_FOUND: 'MODEL_CREDENTIAL_NOT_FOUND',
  MODEL_PROVIDER_MISMATCH: 'MODEL_PROVIDER_MISMATCH',
  MODEL_BASEURL_CONFLICT: 'MODEL_BASEURL_CONFLICT',
  MODEL_BASEURL_REQUIRED: 'MODEL_BASEURL_REQUIRED',
} as const;

export const MODEL_PROVIDER_TYPES = ['cloud', 'local', 'custom'] as const;
export type ModelProviderType = (typeof MODEL_PROVIDER_TYPES)[number];

export type ModelErrorCode = (typeof MODEL_ERRORS)[keyof typeof MODEL_ERRORS];

/** opencode 支持的输入/输出模态（对齐 v1.18.31 modalities 枚举）。 */
export const MODEL_MODALITIES = [
  'text',
  'audio',
  'image',
  'video',
  'pdf',
] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

/**
 * C8：per-model 能力声明（存 `Model.capabilities` Json，零迁移复用既有列）。
 * 内部统一 camelCase，由 worker 翻译为 opencode 配置的 snake_case 输出形状。
 *
 * 为何这些字段（对照 v1.18.31 实测与官方 schema）：
 * - `limit.context` 不配 = 0 → opencode `session/overflow.ts` 的 `isOverflow` 直接
 *   返回 false，**该模型自动压缩永久失效**；`limit.output` 不配 = 0 → maxOutputTokens
 *   回落全局 32000，保留预算计算失真。故 limit 是核心字段。
 * - `reasoning`/`attachment`/`temperature`/`toolCall` 为扁平布尔（运行时 capabilities
 *   由其派生；配置层写 `capabilities:{}` 是无效键，会被静默忽略）。
 * - `modalities.input` 含 `image` 是声明视觉能力的唯一方式。
 * - `options` 原样透传 SDK——opencode 无"思考强度"一等字段，只能经此下发
 *   （如 `reasoningEffort`）。
 */
export interface ModelCapabilities {
  limit?: { context?: number; output?: number };
  reasoning?: boolean;
  toolCall?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  modalities?: { input?: ModelModality[]; output?: ModelModality[] };
  options?: Record<string, unknown>;
}

/** provider 配置条目内的单模型项（models 为 modelID → 本结构）。 */
export interface ProviderModelEntry {
  /** 显示名（缺省时 opencode 回落 modelID） */
  name?: string;
  capabilities?: ModelCapabilities;
}

/**
 * C6/C8：baseUrl provider 的 opencode 配置条目（对齐 worker ModelProviderConfigEntry 双写）。
 * 经 model-credentials 命令 payload.providerConfigs 下发；server 是事实源——
 * 每次下发/回放都携带当前全量（非增量）。覆盖 local/custom 及带自定义 baseUrl
 * 的 cloud provider（opencode 对 custom 端点只认配置里的 options.baseURL）。
 *
 * `models` 为 modelID → ProviderModelEntry 映射（C8 起带 per-model 能力；值为 `{}` =
 * 仅声明模型存在、无额外配置，与 C6 行为一致）。旧 worker 只认 string[]，
 * 故下发顺序为 worker 先升级（双形状兼容）、server 后升级。
 */
export interface ModelProviderConfigEntry {
  /** OpenAI 兼容根（SDK 自行追加 /models 与 /chat/completions 路径） */
  baseUrl: string;
  /** 该 provider 在 server 目录中的模型集合（opencode 1.18.31 实测：
   * custom provider 不自动发现 `{baseURL}/models`，必须显式 models map） */
  models: Record<string, ProviderModelEntry>;
}
