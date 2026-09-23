/**
 * 岗位业务能力点目录（web 端与服务端目录**逐字对照的副本**）
 * =============================================
 * 唯一来源：`server/src/common/constants/platform-capability.constants.ts`
 * （`PLATFORM_CAPABILITIES`：27 项覆盖 28 个 `vteam_*` 工具，键/中文名/工具/出厂拒绝
 * 全部逐字抄录，含顺序）。服务端目前**未**暴露目录接口（`GET /agent-roles` 只回矩阵，
 * 不回目录），故这里是副本；服务端目录接口就绪后应改为「接口优先、本清单离线回退」。
 *
 * 语义（与 SLICE 6a 契约一致，勿改）：
 * - 岗位 `capabilities: Record<string, boolean> | null`；`false` = 拒绝（二进制，无 ask）；
 * - **缺失键 = 允许**（default-allow）；工具映射不到能力点 → 服务端 fail-closed 拒绝；
 * - `null` = 从未保存：UI 按**出厂矩阵**展示并明示（brief 6b 口径）；
 * - 保存时提交**完整 map**（目录内每个键都在），存储值自描述。
 *
 * 分组（`ROLE_CAPABILITY_GROUPS`）仅用于 UI 展示归拢，不改变目录内容。
 * 容错：存储 map 里出现目录外的键（服务端目录更新/历史键）一律**保留**并单独成组渲染，
 * 保存时原样带回——绝不静默丢弃。
 */

/** 能力点分组（展示顺序 = 数组顺序）。 */
export interface RoleCapabilityGroup {
  key: string;
  label: string;
}

export const ROLE_CAPABILITY_GROUPS: readonly RoleCapabilityGroup[] = [
  { key: "task", label: "任务" },
  { key: "team", label: "团队" },
  { key: "collab", label: "协作" },
  { key: "artifact", label: "产出" },
  { key: "issue", label: "Issue" },
  { key: "memory", label: "记忆" },
  { key: "capability", label: "能力" },
  { key: "automation", label: "自动化" },
] as const;

/** 单个能力点（镜像服务端 `PlatformCapability`；`factoryDefault` = !defaultDeny）。 */
export interface RoleCapability {
  key: string;
  label: string;
  /** UI 分组键（∈ ROLE_CAPABILITY_GROUPS）。 */
  group: string;
  /** 覆盖的 MCP 工具真实暴露名（`vteam_<action>`）。 */
  tools: readonly string[];
  /** 出厂是否放行（服务端 `defaultDeny` 取反；false = 出厂预置拒绝的敏感点）。 */
  factoryDefault: boolean;
}

/**
 * 27 个能力点 —— 逐字对照 `server/src/common/constants/platform-capability.constants.ts`
 * `PLATFORM_CAPABILITIES`（顺序一致；仅新增 UI 分组 `group` 字段）。
 * 出厂拒绝 14 项：task.create / task.transition / task.complete / team.add_member /
 * chat.channel_send / wecom.reply / question.confirm / issue.create / issue.get /
 * issue.list / issue.update / issue.transition / skill.create / hook.manage。
 */
export const ROLE_CAPABILITIES: readonly RoleCapability[] = [
  { key: "task.create", label: "创建任务", group: "task", tools: ["vteam_task_create"], factoryDefault: false },
  { key: "task.transition", label: "流转任务状态", group: "task", tools: ["vteam_task_transition"], factoryDefault: false },
  { key: "task.complete", label: "完成/确认计划", group: "task", tools: ["vteam_plan_complete", "vteam_plan_finalize", "vteam_plan_confirm"], factoryDefault: false },
  { key: "task.context", label: "读取任务上下文", group: "task", tools: ["vteam_task_context"], factoryDefault: true },
  { key: "team.view", label: "查看团队", group: "team", tools: ["vteam_team_view"], factoryDefault: true },
  { key: "team.add_member", label: "添加团队成员", group: "team", tools: ["vteam_team_add_member"], factoryDefault: false },
  { key: "chat.post", label: "群聊发言", group: "collab", tools: ["vteam_group_post"], factoryDefault: true },
  { key: "chat.read", label: "读取会话", group: "collab", tools: ["vteam_chat_history"], factoryDefault: true },
  { key: "chat.notify", label: "通知成员", group: "collab", tools: ["vteam_notify_agent"], factoryDefault: true },
  { key: "chat.channel_send", label: "渠道推送", group: "collab", tools: ["vteam_channel_send"], factoryDefault: false },
  { key: "wecom.reply", label: "回复企业微信", group: "collab", tools: ["vteam_wecom_reply"], factoryDefault: false },
  { key: "question.confirm", label: "确认问答", group: "collab", tools: ["vteam_question_confirm"], factoryDefault: false },
  { key: "doc.read", label: "读取产出物", group: "artifact", tools: ["vteam_doclib"], factoryDefault: true },
  { key: "doc.submit", label: "提交产出物", group: "artifact", tools: ["vteam_submit_artifact"], factoryDefault: true },
  { key: "file.read", label: "读取文件", group: "artifact", tools: ["vteam_read_file"], factoryDefault: true },
  { key: "issue.create", label: "创建需求/缺陷", group: "issue", tools: ["vteam_issue_create"], factoryDefault: false },
  { key: "issue.get", label: "查看需求缺陷", group: "issue", tools: ["vteam_issue_get"], factoryDefault: false },
  { key: "issue.list", label: "需求缺陷列表", group: "issue", tools: ["vteam_issue_list"], factoryDefault: false },
  { key: "issue.update", label: "更新需求缺陷", group: "issue", tools: ["vteam_issue_update"], factoryDefault: false },
  { key: "issue.transition", label: "流转需求缺陷", group: "issue", tools: ["vteam_issue_transition"], factoryDefault: false },
  { key: "memory.save", label: "写入团队记忆", group: "memory", tools: ["vteam_memory_save"], factoryDefault: true },
  { key: "memory.search", label: "检索团队记忆", group: "memory", tools: ["vteam_memory_search"], factoryDefault: true },
  { key: "memory.update", label: "更新团队记忆", group: "memory", tools: ["vteam_memory_update"], factoryDefault: true },
  { key: "skill.create", label: "沉淀技能", group: "capability", tools: ["vteam_skill_create"], factoryDefault: false },
  { key: "my_profile", label: "查询自身", group: "capability", tools: ["vteam_my_profile"], factoryDefault: true },
  { key: "git.repos", label: "查看授权仓库", group: "capability", tools: ["vteam_git_repos_list"], factoryDefault: true },
  { key: "hook.manage", label: "注册/取消唤醒", group: "automation", tools: ["vteam_hook_register", "vteam_hook_cancel"], factoryDefault: false },
] as const;

const CAPABILITY_BY_KEY: ReadonlyMap<string, RoleCapability> = new Map(
  ROLE_CAPABILITIES.map((cap) => [cap.key, cap]),
);

export function capabilityOf(key: string): RoleCapability | undefined {
  return CAPABILITY_BY_KEY.get(key);
}

/** 出厂矩阵：目录内全部键（敏感点 `false`，其余 `true`）。 */
export function factoryCapabilityMap(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const cap of ROLE_CAPABILITIES) map[cap.key] = cap.factoryDefault;
  return map;
}

export interface NormalizedCapabilities {
  /** 完整展示 map：目录键恒在 + 目录外键原样保留（值按「显式 false 才拒绝」归一）。 */
  map: Record<string, boolean>;
  /** true = 存储值为 null（从未保存），map 为出厂矩阵；UI 需明示。 */
  fromFactory: boolean;
  /** 目录外的键（服务端目录更新/历史键），渲染时单独成组。 */
  extraKeys: string[];
}

/**
 * 存储值 → 完整展示 map。
 * - `null`/`undefined` → 出厂矩阵（`fromFactory=true`）；契约以 null 表示「未保存」；
 * - 已保存 map → 目录键缺省**允许**（契约：缺失键 = 允许，绝不回落出厂拒绝），
 *   显式 `false`（含目录外键）→ 拒绝；`true`/异常值 → 允许。
 */
export function normalizeCapabilities(raw: Record<string, boolean> | null | undefined): NormalizedCapabilities {
  if (raw == null) {
    return { map: factoryCapabilityMap(), fromFactory: true, extraKeys: [] };
  }
  const map: Record<string, boolean> = {};
  for (const cap of ROLE_CAPABILITIES) map[cap.key] = true;
  const extraKeys: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    map[key] = value !== false;
    if (!CAPABILITY_BY_KEY.has(key)) extraKeys.push(key);
  }
  return { map, fromFactory: false, extraKeys };
}

/** 列表项/编辑器摘要：「N 允许 / M 拒绝」（对完整 map 计数）。 */
export function summarizeCapabilities(map: Record<string, boolean>): { allowed: number; denied: number } {
  let allowed = 0;
  let denied = 0;
  for (const value of Object.values(map)) {
    if (value === false) denied += 1;
    else allowed += 1;
  }
  return { allowed, denied };
}
