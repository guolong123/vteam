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
 *
 * CONF-01：追加 worker（w_compose_worker）实测上报的 26 个 opencode/* 免费模型（C3 上报
 * 入库后 seed 编号 md_9~md_34 与上报顺序一一对应，此处按同序追加保证 seed 幂等）。模板
 * 默认模型必须落在 worker 实际可执行清单内（TEMPLATE_DEFAULT_MODELS 的 spec 断言锁定），
 * 否则模板 Agent 用默认模型创建任务 → dispatch 模型不匹配 → 无回复/insufficient_quota。
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
  // worker（w_compose_worker）实测上报 opencode/* 免费模型（CONF-01：与 worker 能力对齐）
  { id: 'opencode/ling-3.0-tiny-free', name: 'Ling 3.0 Tiny (Free)' },
  { id: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (Free)' },
  { id: 'opencode/ling-3.0-flash-free', name: 'Ling 3.0 Flash (Free)' },
  { id: 'opencode/laguna-s-2.1-free', name: 'Laguna S 2.1 (Free)' },
  { id: 'opencode/longcat-2.0-free', name: 'Longcat 2.0 (Free)' },
  { id: 'opencode/hy3-free', name: 'Hy3 (Free)' },
  { id: 'opencode/north-mini-code-free', name: 'North Mini Code (Free)' },
  { id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (Free)' },
  { id: 'opencode/minimax-m3-free', name: 'MiniMax M3 (Free)' },
  { id: 'opencode/ring-2.6-1t-free', name: 'Ring 2.6 1T (Free)' },
  { id: 'opencode/mimo-v2.5-free', name: 'Mimo V2.5 (Free)' },
  { id: 'opencode/ling-2.6-flash-free', name: 'Ling 2.6 Flash (Free)' },
  { id: 'opencode/hy3-preview-free', name: 'Hy3 Preview (Free)' },
  { id: 'opencode/qwen3.6-plus-free', name: 'Qwen 3.6 Plus (Free)' },
  { id: 'opencode/mimo-v2-omni-free', name: 'Mimo V2 Omni (Free)' },
  { id: 'opencode/mimo-v2-pro-free', name: 'Mimo V2 Pro (Free)' },
  { id: 'opencode/nemotron-3-super-free', name: 'Nemotron 3 Super (Free)' },
  { id: 'opencode/minimax-m2.5-free', name: 'MiniMax M2.5 (Free)' },
  { id: 'opencode/glm-5-free', name: 'GLM 5 (Free)' },
  { id: 'opencode/trinity-large-preview-free', name: 'Trinity Large Preview (Free)' },
  { id: 'opencode/kimi-k2.5-free', name: 'Kimi K2.5 (Free)' },
  { id: 'opencode/minimax-m2.1-free', name: 'MiniMax M2.1 (Free)' },
  { id: 'opencode/glm-4.7-free', name: 'GLM 4.7 (Free)' },
  { id: 'opencode/mimo-v2-flash-free', name: 'Mimo V2 Flash (Free)' },
  { id: 'opencode/big-pickle', name: 'Big Pickle' },
  { id: 'opencode/grok-code', name: 'Grok Code' },
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
 *
 * CONF-01：worker（w_compose_worker）实测仅可执行 opencode/* 免费模型，旧默认值
 * （zhipu/glm-5.1、deepseek/deepseek-v4-pro、zhipu/glm-5.2、opencode-go/deepseek-v4-flash）
 * 与 worker 能力交集为空 → dispatch 模型不匹配 → 无回复。已改为 worker 实际可执行模型：
 *   - 产品=通用对话 → opencode/glm-5-free（GLM 5 免费）
 *   - 架构=推理 → opencode/nemotron-3-ultra-free（Nemotron Ultra 推理侧重）
 *   - 开发=代码 → opencode/deepseek-v4-flash-free（DeepSeek 代码侧重 + 快速）
 *   - 测试=推理 → opencode/qwen3.6-plus-free（Qwen 3.6 Plus 通用强，适合穷举边界）
 */
export const TEMPLATE_DEFAULT_MODELS: Record<string, string> = {
  a_product: 'opencode/glm-5-free',
  a_architect: 'opencode/nemotron-3-ultra-free',
  a_developer: 'opencode/deepseek-v4-flash-free',
  a_tester: 'opencode/qwen3.6-plus-free',
} as const;
