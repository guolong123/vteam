/**
 * opencode agent 定义纯构造器（vteam-role-behavior-enforcement Todo 16）。
 *
 * 取代已死亡的 `buildOpencodeConfig`（消费已废弃的 `ExecutionConfig`，无 import 者）：
 * 输入 `GET /agent-policies` 的 `{ agents, guard }`，输出可直接并入
 * `<workDir>/opencode.json` `agent` 节的定义表（key = opencode agent 名）。
 *
 * 约束（worker 独立进程铁律）：
 * - 纯函数：无 IO、无 fetch、无角色 `if` 分支（不 hardcode 任何 `vteam-<role>` 语义，
 *   角色知识只活在 server `ROLE_BOUNDARIES` + 控制面下发数据里）；
 * - 类型本地双写：对齐 `server/src/execution-policies/execution-policy.service.ts`
 *   的 `AgentPolicyDefinition` / `AgentGuardRole`，绝不 import server 代码；
 * - 未知字段显式拒绝：agent / guard role 出现约定外键即抛错（防控制面漂移静默透传）。
 */

export interface AgentPolicyDefinition {
  name: string;
  description: string;
  mode: 'primary' | 'all';
  permission: Record<string, unknown>;
}

export interface AgentGuardRole {
  permission: Record<string, unknown>;
  tools: Record<string, 'allow' | 'ask'>;
  bashDeny: string[];
  correction: Record<string, unknown>;
}

export interface AgentPoliciesGuard {
  enabled: boolean;
  roles: Record<string, AgentGuardRole>;
}

export interface AgentPoliciesResponse {
  agents: AgentPolicyDefinition[];
  guard: AgentPoliciesGuard;
}

/** opencode.json `agent` 节单个条目（`{ <name>: { description, mode, permission } }`，mode 为 'primary' | 'all'）。 */
export interface AgentSectionEntry {
  description: string;
  mode: 'primary' | 'all';
  permission: Record<string, unknown>;
}

/** opencode.json `agent` 节整体（key = opencode agent 名）。 */
export type AgentSection = Record<string, AgentSectionEntry>;

/** agent 定义约定字段：出现此外的键即未知字段（显式拒绝）。 */
const AGENT_ALLOWED_FIELDS = ['name', 'description', 'mode', 'permission'] as const;
/** guard role 约定字段：出现此外的键即未知字段（显式拒绝）。 */
const ROLE_ALLOWED_FIELDS = ['permission', 'tools', 'bashDeny', 'correction'] as const;

/**
 * 由控制面 agent 策略构造 opencode `agent` 节。
 *
 * - 每个 agent 必须恰为 `{ name, description, mode:'primary'|'all', permission }`；
 *   `permission` 必须为普通对象且**不得含 `write` 键**（层①唯一写闸门是 `edit`，
 *   计划 Success criteria；`write` 键出现即视为控制面漂移，显式拒绝）。
 * - `guard.enabled === true` 时，每个 agent 名必须在 `guard.roles` 中存在且条目
 *   形状完整（缺失/残缺即抛错——调用方 `injector` 捕获后走失败中性化，绝不写半吊子配置）；
 *   `guard` 缺失/`enabled !== true` 时跳过交叉校验（中性化/停用路径不被校验阻断）。
 * - 全程无角色名 `if` 分支：所有角色一视同仁走同一条校验与构造路径。
 */
export function buildAgentDefinitions(
  agents: AgentPolicyDefinition[],
  guard?: AgentPoliciesGuard | null,
): AgentSection {
  if (!Array.isArray(agents)) {
    throw new Error('[agent-definitions] agents 非法：必须为数组');
  }
  const section: AgentSection = {};
  for (const agent of agents) {
    assertAgentShape(agent);
    if (Object.prototype.hasOwnProperty.call(section, agent.name)) {
      throw new Error(`[agent-definitions] agent 名重复: ${agent.name}`);
    }
    if (guard && guard.enabled === true) {
      assertGuardRole(agent.name, guard.roles);
    }
    section[agent.name] = {
      description: agent.description,
      mode: agent.mode,
      permission: agent.permission,
    };
  }
  return section;
}

/** 单个 agent 定义形状校验（未知字段 / 非法值一律抛错）。 */
function assertAgentShape(agent: AgentPolicyDefinition): void {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
    throw new Error('[agent-definitions] agent 非法：必须为对象');
  }
  assertNoUnknownFields(agent, AGENT_ALLOWED_FIELDS, 'agent');
  if (typeof agent.name !== 'string' || agent.name.length === 0) {
    throw new Error('[agent-definitions] agent.name 非法：必须为非空字符串');
  }
  if (typeof agent.description !== 'string') {
    throw new Error(`[agent-definitions] agent ${agent.name} description 非法：必须为字符串`);
  }
  if (agent.mode !== 'primary' && agent.mode !== 'all') {
    throw new Error(
      `[agent-definitions] agent ${agent.name} mode 非法：仅支持 'primary' | 'all'（实收 ${JSON.stringify(agent.mode)}）`,
    );
  }
  if (!isPlainObject(agent.permission)) {
    throw new Error(`[agent-definitions] agent ${agent.name} permission 非法：必须为对象`);
  }
  if (Object.prototype.hasOwnProperty.call(agent.permission, 'write')) {
    throw new Error(
      `[agent-definitions] agent ${agent.name} permission 非法：不得含 'write' 键（层①唯一写闸门是 'edit'）`,
    );
  }
}

/** guard 角色条目存在性 + 形状校验（无角色名分支，纯形状检查）。 */
function assertGuardRole(agentName: string, roles: Record<string, AgentGuardRole>): void {
  if (!isPlainObject(roles)) {
    throw new Error('[agent-definitions] guard.roles 非法：必须为对象');
  }
  const role = roles[agentName];
  if (!role || typeof role !== 'object' || Array.isArray(role)) {
    throw new Error(`[agent-definitions] agent ${agentName} 缺少 guard 角色条目`);
  }
  assertNoUnknownFields(role, ROLE_ALLOWED_FIELDS, `guard role ${agentName}`);
  if (!isPlainObject(role.permission)) {
    throw new Error(`[agent-definitions] guard role ${agentName} permission 非法：必须为对象`);
  }
  if (!isPlainObject(role.tools)) {
    throw new Error(`[agent-definitions] guard role ${agentName} tools 非法：必须为对象`);
  }
  if (!Array.isArray(role.bashDeny) || !role.bashDeny.every((p) => typeof p === 'string')) {
    throw new Error(`[agent-definitions] guard role ${agentName} bashDeny 非法：必须为字符串数组`);
  }
  if (!isPlainObject(role.correction)) {
    throw new Error(`[agent-definitions] guard role ${agentName} correction 非法：必须为对象`);
  }
}

/** 未知字段显式拒绝（约定外键即抛错，防控制面漂移静默透传）。 */
function assertNoUnknownFields(
  value: object,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`[agent-definitions] ${where} 含未知字段: ${key}`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
