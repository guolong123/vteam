/**
 * opencode agent 定义纯构造器（vteam-role-behavior-enforcement Todo 16）。
 *
 * 取代已死亡的 `buildOpencodeConfig`（消费已废弃的 `ExecutionConfig`，无 import 者）：
 * 输入 `GET /agent-policies` 的 `agents`，输出可直接并入
 * `<workDir>/opencode.json` `agent` 节的定义表（key = opencode agent 名）。
 *
 * 约束（worker 独立进程铁律）：
 * - 纯函数：无 IO、无 fetch、无角色 `if` 分支（不 hardcode 任何 `vteam-<role>` 语义，
 *   角色知识只活在 server `ROLE_BOUNDARIES` + 控制面下发数据里）；
 * - 类型本地双写：对齐 `server/src/execution-policies/execution-policy.service.ts`
 *   的 `AgentPolicyDefinition`，绝不 import server 代码；
 * - 未知字段显式拒绝：agent 出现约定外键即抛错（防控制面漂移静默透传）。
 */

export interface AgentPolicyDefinition {
  name: string;
  description: string;
  mode: 'primary' | 'all';
  permission: Record<string, unknown>;
}

export interface AgentPoliciesResponse {
  agents: AgentPolicyDefinition[];
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

/**
 * 由控制面 agent 策略构造 opencode `agent` 节。
 *
 * - 每个 agent 必须恰为 `{ name, description, mode:'primary'|'all', permission }`；
 *   `permission` 必须为普通对象且**不得含 `write` 键**（层①唯一写闸门是 `edit`，
 *   计划 Success criteria；`write` 键出现即视为控制面漂移，显式拒绝）。
 * - 全程无角色名 `if` 分支：所有角色一视同仁走同一条校验与构造路径。
 */
export function buildAgentDefinitions(agents: AgentPolicyDefinition[]): AgentSection {
  if (!Array.isArray(agents)) {
    throw new Error('[agent-definitions] agents 非法：必须为数组');
  }
  const section: AgentSection = {};
  for (const agent of agents) {
    assertAgentShape(agent);
    if (Object.prototype.hasOwnProperty.call(section, agent.name)) {
      throw new Error(`[agent-definitions] agent 名重复: ${agent.name}`);
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
