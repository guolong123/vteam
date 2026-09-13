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
 * CONF-01（修正）：worker（w_compose_worker）节点 `opencode models` 实测仅 8 个可执行
 * opencode/* 模型（big-pickle / deepseek-v4-flash-free / laguna-s-2.1-free /
 * ling-3.0-tiny-free / longcat-2.0-free / mimo-v2.5-free / nemotron-3-ultra-free /
 * north-mini-code-free）。DB worker_model_availabilities 曾关联 26 个（含 18 个假模型，
 * 2026-08-08 同秒入库），此处仅保留实测 8 个，seed 编号 md_9~md_16。模板默认模型必须
 * 落在 worker 实际可执行清单内（TEMPLATE_DEFAULT_MODELS 的 spec 断言锁定），否则模板
 * Agent 用默认模型创建任务 → dispatch 模型不匹配 → 无回复/insufficient_quota。
 */
export const STATIC_AVAILABLE_MODELS: readonly { id: string; name: string }[] =
  [];

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
 * 模板默认模型已清空（动态获取）：不再预置静态模型，按 worker 上报动态目录选择。
 */
export const TEMPLATE_DEFAULT_MODELS: Record<string, string> = {} as const;

/* -------------------------------------------------------------------------- */
/* 角色边界映射（Role Boundaries）—— 单一口径来源（vteam-role-behavior-enforcement Todo 2）   */
/* -------------------------------------------------------------------------- */

/**
 * opencode agent 名 == 统一角色命名空间（计划 Decision highlights L19）。
 * key 一律用 opencode agent 名（`vteam-<role>` / `vteam-plan`），不含裸角色名。
 */
export type VteamAgentName =
  | 'vteam-product'
  | 'vteam-architect'
  | 'vteam-developer'
  | 'vteam-tester'
  | 'vteam-project_manager'
  | 'vteam-plan';

/** 五类协作角色（不含 `vteam-plan`）：`handoffTo` 的合法目标集。 */
export type VteamRoleAgentName = Exclude<VteamAgentName, 'vteam-plan'>;

/** vteam 注册的 MCP server 名（seed `mcpServer.upsert name:'vteam'`）。 */
export const VTEAM_MCP_SERVER_NAME = 'vteam' as const;

/**
 * vteam MCP 工具真实暴露名（`vteam_<action>`，与 seed.ts 注册的 tools 表 name 一致）。
 * guard allowlist / 层① `permission.<真实名>` 均引用此清单，禁止裸 MCP 名。
 */
export const VTEAM_MCP_TOOL_NAMES: readonly string[] = [
  'vteam_chat_history',
  'vteam_doclib',
  'vteam_task_context',
  'vteam_group_post',
  'vteam_read_file',
  'vteam_notify_agent',
  'vteam_submit_artifact',
  'vteam_issue_create',
  'vteam_issue_list',
  'vteam_issue_get',
  'vteam_issue_update',
  'vteam_issue_transition',
  'vteam_task_transition',
  'vteam_question_confirm',
  'vteam_memory_save',
  'vteam_memory_search',
  'vteam_team_view',
  'vteam_my_profile',
  'vteam_team_add_member',
  'vteam_plan_mode',
  'vteam_channel_send',
  'vteam_wecom_reply',
] as const;

/**
 * worker 注入的自定义 git 工具真实 action 名（`worker/src/git/git-tools.ts` GIT_TOOLS）。
 * 属自定义命名空间，**不带** `vteam_` 前缀（与 MCP 命名空间独立）。
 */
export const VTEAM_GIT_TOOL_NAMES: readonly string[] = [
  'git_clone',
  'git_pull',
  'git_fetch',
  'git_status',
  'git_diff',
  'git_log',
  'git_push',
] as const;

// 角色边界（canonical，驱动提示词/策略/guard/测试）。
// - writeGlobs：通用根无关形式 `**tasks/*` + `/<subdir>/` + `**`，可解析到任意 worktree 基址
//   （非 git 时 Instance.worktree='/'，git 时 Instance.worktree=仓库根，相对路径均命中）；
//   层① 由 buildEditPermission(writeGlobs) 生成 {"*":"deny", ...glob:"allow"}。
// - readGlobs：统一 ['*']（= {"*":"allow"}）。
// - bashEffect：层① permission.bash。
// - mcpDenies：层① 显式 deny 的 MCP 工具真实名（= 全部 MCP 工具中未列入 toolAllows 者）。
// - toolAllows：层② guard 分支 allowlist（真实暴露名：MCP vteam_<action> / 自定义 git_<action>），
//   未列出即 deny；execute/task 永不列入。
export interface RoleBoundary {
  scopeSummary: string;
  deliverables: string[];
  handoffTo: Record<string, string>;
  writeGlobs: string[];
  readGlobs: string[];
  bashEffect: 'allow' | 'ask' | 'deny';
  mcpDenies: string[];
  toolAllows: Record<string, 'allow' | 'ask'>;
}

/**
 * 由 toolAllows 补集推导 `mcpDenies`（MCP 命名空间收窄），保证与 allowlist 恒一致。
 * 纯函数、模块加载期求值，无运行时副作用。
 */
function defineBoundary(
  base: Omit<RoleBoundary, 'mcpDenies'>,
): RoleBoundary {
  const allowed = new Set(Object.keys(base.toolAllows));
  return {
    ...base,
    mcpDenies: VTEAM_MCP_TOOL_NAMES.filter((name) => !allowed.has(name)),
  };
}

// 根无关通用写 glob 前缀：命中省略基址（tasks/t_1/<subdir>/x）与带 worktree 相对前缀
// （data/vteam-worker/tasks/t_1/<subdir>/x）两种形式；由 taskSubdirGlob/taskAllGlob 拼装。
export const ROLE_TASK_GLOB_BASE = '**tasks/*' as const;

/** 派生某子目录下的通用写 glob（禁止绝对路径）。 */
export function taskSubdirGlob(subdir: string): string {
  return `${ROLE_TASK_GLOB_BASE}/${subdir}/**`;
}

// 派生任务目录整棵子树的通用写 glob（**tasks/*/ + **）。
export function taskAllGlob(): string {
  return `${ROLE_TASK_GLOB_BASE}/**`;
}

/**
 * 由 writeGlobs 派生层① edit permission map：`{"*":"deny","<glob>":"allow",...}`。
 * 与 opencode `agent.<name>.permission.edit` 结构一致（**无 `write` 键**）。
 */
export function buildEditPermission(
  writeGlobs: readonly string[],
): Record<string, 'allow' | 'deny'> {
  return {
    '*': 'deny',
    ...Object.fromEntries(writeGlobs.map((glob) => [glob, 'allow' as const])),
  };
}

/** 层① read permission map（全角色一致）：`{"*":"allow"}`。 */
export function buildReadPermission(): Record<string, 'allow'> {
  return { '*': 'allow' };
}

/** 角色边界映射（key = opencode agent 名，值与 Permission matrix 严格一致）。 */
export const ROLE_BOUNDARIES: Record<VteamAgentName, RoleBoundary> = {
  'vteam-product': defineBoundary({
    scopeSummary:
      '需求分析与原型设计：澄清并定义需求，产出需求文档与原型；不编写实现代码、不做技术方案、不替代测试判定。',
    deliverables: ['需求文档', '原型设计'],
    handoffTo: {
      design: 'vteam-architect',
      code: 'vteam-developer',
      test: 'vteam-tester',
      process: 'vteam-project_manager',
    },
    writeGlobs: [taskSubdirGlob('prototypes'), taskSubdirGlob('docs')],
    readGlobs: ['*'],
    bashEffect: 'deny',
    toolAllows: {
      vteam_submit_artifact: 'allow',
      vteam_doclib: 'allow',
      vteam_issue_create: 'allow',
      vteam_issue_list: 'allow',
      vteam_issue_get: 'allow',
      vteam_issue_update: 'allow',
      vteam_issue_transition: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_memory_save: 'allow',
      vteam_memory_search: 'allow',
      vteam_read_file: 'allow',
      vteam_task_context: 'allow',
      vteam_chat_history: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
    },
  }),

  'vteam-architect': defineBoundary({
    scopeSummary:
      '技术方案与设计文档：基于需求产出架构/技术方案与设计文档，只读核对仓库；不编写实现代码、不写仓库。',
    deliverables: ['技术方案', '设计文档'],
    handoffTo: {
      requirements: 'vteam-product',
      code: 'vteam-developer',
      test: 'vteam-tester',
      process: 'vteam-project_manager',
    },
    writeGlobs: [taskSubdirGlob('docs')],
    readGlobs: ['*'],
    bashEffect: 'ask',
    toolAllows: {
      vteam_submit_artifact: 'allow',
      vteam_doclib: 'allow',
      vteam_read_file: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_memory_save: 'allow',
      vteam_memory_search: 'allow',
      vteam_task_context: 'allow',
      vteam_chat_history: 'allow',
      vteam_issue_list: 'allow',
      vteam_issue_get: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      git_clone: 'allow',
      git_pull: 'allow',
      git_status: 'allow',
      git_diff: 'allow',
      git_log: 'allow',
    },
  }),

  'vteam-developer': defineBoundary({
    scopeSummary:
      '编码与实现说明：按需求/方案实现代码并给出实现说明与验证方式；不定义需求、不替代测试判定、不越权验收。',
    deliverables: ['实现代码', '实现说明'],
    handoffTo: {
      requirements: 'vteam-product',
      design: 'vteam-architect',
      test: 'vteam-tester',
      process: 'vteam-project_manager',
    },
    writeGlobs: [taskAllGlob()],
    readGlobs: ['*'],
    bashEffect: 'ask',
    toolAllows: {
      vteam_submit_artifact: 'allow',
      vteam_read_file: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_memory_save: 'allow',
      vteam_memory_search: 'allow',
      vteam_task_context: 'allow',
      vteam_chat_history: 'allow',
      vteam_issue_list: 'allow',
      vteam_issue_get: 'allow',
      vteam_issue_update: 'allow',
      vteam_issue_transition: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      git_clone: 'allow',
      git_pull: 'allow',
      git_status: 'allow',
      git_diff: 'allow',
      git_log: 'allow',
    },
  }),

  'vteam-tester': defineBoundary({
    scopeSummary:
      '测试用例/计划/执行/报告：设计并执行测试、输出报告；不修改实现代码、不越权验收。',
    deliverables: ['测试用例', '测试计划', '测试执行', '测试报告'],
    handoffTo: {
      requirements: 'vteam-product',
      design: 'vteam-architect',
      code: 'vteam-developer',
      process: 'vteam-project_manager',
    },
    writeGlobs: [taskSubdirGlob('tests'), taskSubdirGlob('docs')],
    readGlobs: ['*'],
    bashEffect: 'ask',
    toolAllows: {
      vteam_submit_artifact: 'allow',
      vteam_issue_create: 'allow',
      vteam_issue_list: 'allow',
      vteam_issue_get: 'allow',
      vteam_issue_transition: 'allow',
      vteam_read_file: 'allow',
      vteam_doclib: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_memory_save: 'allow',
      vteam_memory_search: 'allow',
      vteam_task_context: 'allow',
      vteam_chat_history: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      git_clone: 'allow',
      git_pull: 'allow',
      git_status: 'allow',
      git_diff: 'allow',
      git_log: 'allow',
    },
  }),

  'vteam-project_manager': defineBoundary({
    scopeSummary:
      '流程控制：负责任务拆解编排、进度跟踪、风险与阻塞协调；不产出需求/方案/代码/用例、不越权验收。',
    deliverables: ['任务拆解', '进度与风险', '协调记录'],
    handoffTo: {
      requirements: 'vteam-product',
      design: 'vteam-architect',
      code: 'vteam-developer',
      test: 'vteam-tester',
    },
    writeGlobs: [],
    readGlobs: ['*'],
    bashEffect: 'deny',
    toolAllows: {
      vteam_task_context: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_issue_create: 'allow',
      vteam_issue_list: 'allow',
      vteam_issue_get: 'allow',
      vteam_issue_update: 'allow',
      vteam_issue_transition: 'allow',
      vteam_memory_save: 'allow',
      vteam_memory_search: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      vteam_read_file: 'allow',
      vteam_doclib: 'allow',
    },
  }),

  'vteam-plan': defineBoundary({
    scopeSummary:
      '计划职责：只读分析并产出实施计划；不写文件、不执行变更。',
    deliverables: ['实施计划'],
    handoffTo: {
      requirements: 'vteam-product',
      design: 'vteam-architect',
      code: 'vteam-developer',
      test: 'vteam-tester',
      process: 'vteam-project_manager',
    },
    writeGlobs: [],
    readGlobs: ['*'],
    bashEffect: 'deny',
    toolAllows: {
      vteam_task_context: 'allow',
      vteam_read_file: 'allow',
      vteam_doclib: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
    },
  }),
};
