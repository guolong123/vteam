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
 *
 * D5：seed 模型 id 全部携带 provider 前缀（provider 前缀规范化）。原 7 个无前缀模型
 * （deepseek-v4-pro/glm-5.1/glm-5.2/gpt-5.6-luna/grok-4.5/kimi-k2.6/qwen3.6-plus）按
 * opencode models.dev 标准 providerID 补齐（本机 `opencode models` 无凭据时仅返回内置
 * 免费模型，seed 中这些模型不在实测列表，采用 models.dev 标准 id 保证拆解与目录聚合正确）：
 *   - deepseek-v4-pro → deepseek/deepseek-v4-pro
 *   - glm-5.1 / glm-5.2 → zhipu/glm-5.1 / zhipu/glm-5.2
 *   - gpt-5.6-luna → openai/gpt-5.6-luna
 *   - grok-4.5 → xai/grok-4.5
 *   - kimi-k2.6 → moonshot/kimi-k2.6
 *   - qwen3.6-plus → qwen/qwen3.6-plus
 */
export const STATIC_AVAILABLE_MODELS = [
  { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'zhipu/glm-5.1', name: 'GLM 5.1' },
  { id: 'zhipu/glm-5.2', name: 'GLM 5.2' },
  { id: 'openai/gpt-5.6-luna', name: 'GPT 5.6 Luna' },
  { id: 'xai/grok-4.5', name: 'Grok 4.5' },
  { id: 'moonshot/kimi-k2.6', name: 'Kimi K2.6' },
  { id: 'qwen/qwen3.6-plus', name: 'Qwen 3.6 Plus' },
] as const;

/**
 * 模型目录 seed 行（C1：STATIC_AVAILABLE_MODELS → models 表预置，防空目录回归——Metis P1-2）。
 * 域主键 `md_` 零填充序号（15 篇 §2.2，宽度对齐 IdGenerator.ID_PAD_WIDTH=10）。
 * id 拆解：含 `/` → 按首个 `/` 拆 providerID/modelID；不含 → providerID 视为 opencode 默认 provider。
 */
export interface ModelSeedRow {
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  enabled: boolean;
}

export function buildModelSeedRows(): ModelSeedRow[] {
  return STATIC_AVAILABLE_MODELS.map((m, idx) => {
    const slash = m.id.indexOf('/');
    const providerID = slash > 0 ? m.id.slice(0, slash) : 'opencode';
    const modelID = slash > 0 ? m.id.slice(slash + 1) : m.id;
    return {
      id: `md_${String(idx + 1).padStart(10, '0')}`,
      providerID,
      modelID,
      name: m.name,
      enabled: true,
    };
  });
}

/**
 * 四类模板默认模型（C1 seed 预置——模板只读 PATCH 403 堵死配置通道，只能 seed 预设，Metis R3）。
 * 推荐映射：产品=通用对话、架构=推理、开发=代码、测试=推理（14 篇 §4.1 模型侧重；
 * 值取 STATIC_AVAILABLE_MODELS 中的对应模型，`providerID/modelID` 格式与 D7 一致）。
 */
export const TEMPLATE_DEFAULT_MODELS: Record<string, string> = {
  a_product: 'zhipu/glm-5.1',
  a_architect: 'deepseek/deepseek-v4-pro',
  a_developer: 'opencode-go/deepseek-v4-flash',
  a_tester: 'zhipu/glm-5.2',
} as const;
