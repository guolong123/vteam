/**
 * Agent 域错误码常量（对齐 14 篇 §2.2 模板只读边界 / §3.5 模型接口、09 篇 §3.7）。
 *
 * 错误码命名沿用现有约定（大写 SNAKE，随异常响应的 code 字段返回）：
 * - 目标 Agent 不存在 → 404（AGENT_NOT_FOUND 与 task/chat 域同值，跨域兼容）
 * - 模板只读（PATCH/DELETE type=template）→ 403 PERMISSION_AGENT_READONLY（14 篇 §2.2 第 4 条）
 * - clone 源非法（预留：当前仅 404 AGENT_NOT_FOUND 覆盖）→ AGENT_CLONE_INVALID
 */
export const AGENT_ERRORS = {
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  /** 模板只读：PATCH/DELETE type=template → 403（14 篇 §2.2 / §7，09 篇 §3.7）。 */
  AGENT_READONLY: 'PERMISSION_AGENT_READONLY',
  /** clone 源非法（预留扩展，当前不存在源由 AGENT_NOT_FOUND 兜底）。 */
  AGENT_CLONE_INVALID: 'AGENT_CLONE_INVALID',
} as const;

export type AgentErrorCode = (typeof AGENT_ERRORS)[keyof typeof AGENT_ERRORS];

/**
 * 静态模型列表（T11 起仅作 available-models 的 fallback，D7：id 存 opencode 模型 id
 * `provider/model` 格式，T10 拼 `-m <defaultModelId>` 直接用）。
 * 值来自本机 `opencode models` 实测可用模型（见 learnings），随 opencode 版本演进。
 * 正常路径经 WorkerClient.listModels 动态获取（worker 注册后返回真实模型列表）。
 */
export const STATIC_AVAILABLE_MODELS = [
  { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'glm-5.1', name: 'GLM 5.1' },
  { id: 'glm-5.2', name: 'GLM 5.2' },
  { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna' },
  { id: 'grok-4.5', name: 'Grok 4.5' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6' },
  { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus' },
] as const;
