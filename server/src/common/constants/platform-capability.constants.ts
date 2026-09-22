/**
 * 平台**业务能力点**目录（single source of truth，2026-09-21 role-owned capability model）。
 *
 * 背景（与「MCP 工具 allowlist」的区别）：
 * - `vteam` / `vteam-api` MCP server 与第三方 MCP 同层，**不做工具清单过滤**，所有 Agent
 *   默认可调用（`tools/list` 全量）。
 * - 服务端只做**调用时**授权：把一次 `tools/call` 的**裸工具名**映射到一个**业务能力点**，
 *   再看岗位（`AgentRole.capabilities`）是否显式拒绝该能力点。能力点是**业务语义**命名
 *   （如 `task.create`），不是 MCP 工具名；能力点可覆盖多个工具，但 2026-09-22 拆分组
 *   能力点后仅 `hook.manage` 覆盖 2 个工具，其余均为单工具点（权限粒度精确到动作）。
 *
 * 语义（pinned contract，slice 6b 依此编码）：
 * - `AgentRole.capabilities` 形状为 `Record<string, boolean>`，键即本目录的 `key`。
 * - **缺失键 ⇒ 允许**（default-allow）；显式 `false` ⇒ 拒绝。故岗位只需落「被拒绝的能力点」，
 *   但为可审计与出厂语义，seed/migration 写全量矩阵（含 `true`）。
 * - 工具映射不到任何能力点（未知/已下线工具）⇒ 拒绝（unknown 面 fail-closed）。
 *
 * 出厂默认（`buildFactoryCapabilityMatrix()`，Q1 = 默认放行 + 敏感点预置拒绝）：
 * `defaultDeny: true` 的能力点出厂为 `false`（敏感：创建/流转/加成员/外发/治理/技能/确认/唤醒），
 * 其余为 `true`。
 *
 * 目录与 `VTEAM_MCP_TOOL_NAMES`（`agent.constants.ts`，28 项）**一一覆盖**：
 * 每个工具恰好属于一个能力点（`platform-capability.coverage.spec.ts` 断言，防漂移）。
 */

/** 单个业务能力点。 */
export interface PlatformCapability {
  /** 能力点键（ASCII 点分，如 `task.create`；`my_profile` 为无点单段）。 */
  readonly key: string;
  /** 面向用户的中文标签（角色编排 UI 展示用）。 */
  readonly label: string;
  /** 该能力点覆盖的 MCP 工具**真实暴露名**（`vteam_<action>`）。 */
  readonly tools: readonly string[];
  /** 出厂是否预置为拒绝（`true` ⇒ 出厂矩阵 `false`）。 */
  readonly defaultDeny: boolean;
}

/** 有序能力点目录（顺序即 UI 展示序；27 项覆盖 28 个 `vteam_*` 工具——恰一项 `hook.manage` 覆盖 2 工具）。 */
export const PLATFORM_CAPABILITIES: readonly PlatformCapability[] = [
  { key: 'task.create', label: '创建任务', tools: ['vteam_task_create'], defaultDeny: true },
  { key: 'task.transition', label: '流转任务状态', tools: ['vteam_task_transition'], defaultDeny: true },
  { key: 'task.complete', label: '完成任务', tools: ['vteam_plan_complete'], defaultDeny: true },
  { key: 'task.context', label: '读取任务上下文', tools: ['vteam_task_context'], defaultDeny: false },
  { key: 'team.view', label: '查看团队', tools: ['vteam_team_view'], defaultDeny: false },
  { key: 'team.add_member', label: '添加团队成员', tools: ['vteam_team_add_member'], defaultDeny: true },
  { key: 'chat.post', label: '群聊发言', tools: ['vteam_group_post'], defaultDeny: false },
  { key: 'chat.read', label: '读取会话', tools: ['vteam_chat_history'], defaultDeny: false },
  { key: 'chat.notify', label: '通知成员', tools: ['vteam_notify_agent'], defaultDeny: false },
  { key: 'chat.channel_send', label: '渠道推送', tools: ['vteam_channel_send'], defaultDeny: true },
  { key: 'wecom.reply', label: '回复企业微信', tools: ['vteam_wecom_reply'], defaultDeny: true },
  { key: 'doc.read', label: '读取产出物', tools: ['vteam_doclib'], defaultDeny: false },
  { key: 'doc.submit', label: '提交产出物', tools: ['vteam_submit_artifact'], defaultDeny: false },
  { key: 'file.read', label: '读取文件', tools: ['vteam_read_file'], defaultDeny: false },
  // 需求缺陷 5 点（2026-09-22 拆分原组能力点 issue.manage，消除组塌缩：岗位只放行组内
  // 部分工具时不再丢失已放行的点）。
  { key: 'issue.create', label: '创建需求/缺陷', tools: ['vteam_issue_create'], defaultDeny: true },
  { key: 'issue.get', label: '查看需求缺陷', tools: ['vteam_issue_get'], defaultDeny: true },
  { key: 'issue.list', label: '需求缺陷列表', tools: ['vteam_issue_list'], defaultDeny: true },
  { key: 'issue.update', label: '更新需求缺陷', tools: ['vteam_issue_update'], defaultDeny: true },
  { key: 'issue.transition', label: '流转需求缺陷', tools: ['vteam_issue_transition'], defaultDeny: true },
  // 团队记忆 3 点（同批拆分原组能力点 memory.manage：plan/librarian 只放行检索，
  // 拆分后重获 memory.search，写入/更新点仍按各自 toolAllows 判定）。
  { key: 'memory.save', label: '写入团队记忆', tools: ['vteam_memory_save'], defaultDeny: false },
  { key: 'memory.search', label: '检索团队记忆', tools: ['vteam_memory_search'], defaultDeny: false },
  { key: 'memory.update', label: '更新团队记忆', tools: ['vteam_memory_update'], defaultDeny: false },
  { key: 'skill.create', label: '沉淀技能', tools: ['vteam_skill_create'], defaultDeny: true },
  { key: 'question.confirm', label: '确认问答', tools: ['vteam_question_confirm'], defaultDeny: true },
  { key: 'my_profile', label: '查询自身', tools: ['vteam_my_profile'], defaultDeny: false },
  {
    key: 'hook.manage',
    label: '注册/取消唤醒',
    tools: ['vteam_hook_register', 'vteam_hook_cancel'],
    defaultDeny: true,
  },
  { key: 'git.repos', label: '查看授权仓库', tools: ['vteam_git_repos_list'], defaultDeny: false },
];

/** 能力点键全集（有序；DTO 校验与 UI 消费方用）。 */
export const PLATFORM_CAPABILITY_KEYS: readonly string[] =
  PLATFORM_CAPABILITIES.map((c) => c.key);

const PLATFORM_CAPABILITY_KEY_SET: ReadonlySet<string> = new Set(
  PLATFORM_CAPABILITY_KEYS,
);

/** 工具真实名 → 能力点键（反查索引；每个工具恰属一个能力点）。 */
const CAPABILITY_BY_TOOL: ReadonlyMap<string, string> = new Map(
  PLATFORM_CAPABILITIES.flatMap((c) =>
    c.tools.map((tool) => [tool, c.key] as const),
  ),
);

/** 能力点键是否合法（∈ 目录）。 */
export function isPlatformCapabilityKey(key: string): boolean {
  return PLATFORM_CAPABILITY_KEY_SET.has(key);
}

/** 工具真实名（`vteam_<action>`）→ 能力点键；未知工具 → null。 */
export function capabilityKeyForTool(toolName: string): string | null {
  return CAPABILITY_BY_TOOL.get(toolName) ?? null;
}

/** 能力点是否被显式允许（缺失键 ⇒ 允许 = default-allow）。 */
export function isCapabilityGranted(
  matrix: Readonly<Record<string, boolean>> | null | undefined,
  key: string,
): boolean {
  return matrix?.[key] !== false;
}

/** 出厂矩阵：`defaultDeny` ⇒ `false`，其余 ⇒ `true`（Q1：默认放行 + 敏感点预置拒绝）。 */
export function buildFactoryCapabilityMatrix(): Record<string, boolean> {
  return Object.fromEntries(
    PLATFORM_CAPABILITIES.map((c) => [c.key, !c.defaultDeny]),
  );
}

/**
 * 由「工具生效集合」（`Record<vteam_* , 'allow'|'ask'|'deny'|...>`）推导能力点矩阵。
 *
 * 判据为**全部成员工具均放行**才授予该能力点（保守方向，只收窄不放大授权）：能力点是二元
 * 开关，一个能力点可覆盖多个工具；只有全组放行才能在不**放大**授权的前提下映射，成员工具
 * 部分放行时该能力点记 `false`（宁可少授也不越权——`AgentRole` 迁移/seed 的「不得因默认
 * 翻转而获得新权限」要求）。
 *
 * 2026-09-22 拆分组能力点后目录仅 `hook.manage` 覆盖 2 工具，issue/memory 各点均单工具
 * ⇒ 本规则对单工具点退化为「该工具放行即授予」，不再产生组塌缩（原 issue.manage 对
 * architect/tester、memory.manage 对 plan/librarian 的塌缩格由拆分消除）。
 */
export function buildCapabilityMatrixFromTools(
  tools: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, boolean> {
  const allowed = (name: string): boolean => {
    const effect = tools?.[name];
    return effect === 'allow' || effect === 'ask';
  };
  return Object.fromEntries(
    PLATFORM_CAPABILITIES.map((c) => [c.key, c.tools.every(allowed)]),
  );
}

/**
 * 能力点矩阵 → 工具三态表（`vteam_<action>` → `allow`/`deny`）。
 *
 * 供 dispatcher 复用既有 `toolAllowed()`（记忆/产出物段屏蔽判据）：缺失键 ⇒ 允许，
 * 故映射为 `allow`；显式 `false` ⇒ `deny`。未知/无矩阵能力的工具（目录外）不出现。
 */
export function capabilityMatrixToToolStates(
  matrix: Readonly<Record<string, boolean>>,
): Record<string, 'allow' | 'deny'> {
  return Object.fromEntries(
    PLATFORM_CAPABILITIES.flatMap((c) =>
      c.tools.map(
        (tool) =>
          [tool, matrix[c.key] === false ? 'deny' : 'allow'] as const,
      ),
    ),
  );
}
