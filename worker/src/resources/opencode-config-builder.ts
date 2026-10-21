/**
 * opencode agent 定义纯构造器（vteam-role-behavior-enforcement Todo 16；**T15 改写为 v2 形态**）。
 *
 * 取代已死亡的 `buildOpencodeConfig`（消费已废弃的 `ExecutionConfig`，无 import 者）：
 * 输入 `GET /agent-policies` 的 `agents`，输出可直接并入
 * `<workDir>/opencode.json` **`agents` 节**（**v2 原生段名**）的定义表（key = opencode agent 名）。
 *
 * ⚠️⚠️ **T15 的核心：节名与键名必须**同时**改（v2 实测 opencode v2.0.28）
 * - 段名：v1 `agent` → **v2 `agents`**；
 * - 角色提示键：v1 `prompt` → **v2 `system`**（v2 原生 `AgentConfig` 的系统提示键）。
 *
 *   **为什么必须同时改**：v2 接受 v1 形配置并**静默归一化**，而 `prompt` 键的处置
 *   **取决于它所在的节**（实测，同一份配置里两节并存时）：
 *   - 在 **v1 形 `agent:` 节**内 → `prompt` 被**迁移**为 `system`（值不丢）；
 *   - 在 **v2 原生 `agents:` 节**内 → `prompt` 是**未知键，被静默丢弃、没有任何告警**。
 *
 *   ⇒ 只把节名改成 `agents` 而沿用 `prompt` 键 = **所有角色提示静默丢失**（代码评审看不出、
 *   线上无任何错误信号）——这是本计划最危险的静默降级陷阱。
 *   故本模块**只**产出 `system`，**绝不**产出 `prompt`（结构性禁止见 `AGENT_V2_OUTPUT_FIELDS`
 *   与 `assertV2EntryShape`；回归断言见 `opencode-config-builder.spec.ts`）。
 *
 * 权限也从 v1 的**对象**改成 v2 的**有序数组**（v2 `Permission.Rule` = `{action,resource,effect}`）：
 * - `bash` → **`shell`**、`task` → **`subagent`**（v2 原生 action 名）；
 * - `write` / `patch` 在 v2 已**并入 `edit`**（v2 无这两个 action）→ 出现即**显式拒绝**
 *   （层①唯一写闸门是 `edit`；且 v2 认不出这两个 action，透传等于规则不命中＝默认放行）；
 * - **规则顺序有意义**：v2 用 `findLast` 选**最后一条命中**的规则（实测二进制），
 *   故 v1 权限 map 的**键序必须原样保留**（`{"*":"deny","<glob>":"allow"}` → deny 在前、
 *   allow 在后 = 与 v1 的 `.at(-1)` 语义一致）。
 *
 * ⚠️ **未声明 action 在 v2 走引擎自带的 catch-all allow —— 平台已采纳，勿"顺手"收紧**：
 * opencode v2 每个 agent 的**内置**规则集首条是 `{action:"*",resource:"*",effect:"allow"}`，
 * 配置 `permissions[]` **追加在其后**，规则集按 `findLast` 求值 ⇒ 本模块**只**翻译控制面
 * 声明的动作（四个原生 action + 已注册的 vteam MCP 工具名），于是**未被声明**的 action
 * （`webfetch` / `glob` / `grep` / `todowrite` / `skill` / `websearch` 及全部 MCP 工具）
 * 在**引擎层是放行**的（v1 下它们落到引擎的逐 action ask/deny 默认）。
 * 平台已**明确接受**该放宽（**不**补 catch-all ask、**不**加逐 action 默认表），
 * 决策记录见 `docs/agent-platform/07-opencode-v2-调研与架构决策.md` §3.2。
 * ⇒ **不要**在这里补 `{action:"*",resource:"*",effect:"ask"}` 兜底规则或逐 action 默认表：
 * 那会**静默改变**平台已采纳的行为（把 v2 的放行收回成 v1 的逐 action 询问）。
 * 工具类权限的真正权威仍是服务端闸门（`ROLE_BOUNDARIES[*].toolAllows`）。
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
  /**
   * 控制面下发的 **v1 形**权限对象（`{edit:{"*":"deny"}, bash:"ask"}` …）。
   *
   * ⚠️ **控制面契约不变**：worker 侧负责把它翻成 v2 的 `permissions[]`
   * （见 `buildPermissionRules`），server 侧无需改形状。
   */
  permission: Record<string, unknown>;
  /**
   * **可选**的静态角色提示（v2 原生落点 = `agents.<n>.system`）。
   *
   * ⚠️ 这是**逐 agent 静态**的提示，与「逐消息的 system blob」是两回事：
   * vteam 真正下发的 system 是**每次派发、每个成员现拼**的（身份段 + `【岗位职责】` +
   * `【职责】` 段…），**装不进**静态配置 ⇒ 逐消息那部分仍走驱动的文本前缀兜底
   * （见 `v2-driver.ts` 的"防重复注入"闸门：agent 已有配置化 `system` 时不再重复拼前缀）。
   *
   * ⚠️ **键名纪律**：本字段是**控制面契约**里的 `prompt`，但写进 opencode 配置时
   * **必须**是 `system`——v2 原生 `agents:` 节里的 `prompt` 会被**静默丢弃**。
   */
  prompt?: string;
}

export interface AgentPoliciesResponse {
  agents: AgentPolicyDefinition[];
}

/** v2 权限效果三态（`Permission.Effect`：allow | ask | deny）。 */
export type PermissionEffect = 'allow' | 'ask' | 'deny';

/**
 * v2 权限规则（`Permission.Rule`）：`action` 是**自由字符串**（开放命名空间，非枚举），
 * `resource` 是资源/路径模式（`"*"` = 全部），`effect` 是三态。
 */
export interface AgentPermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

/**
 * opencode.json **`agents` 节**单个条目（v2 原生 `Config.AgentEncoded` 的子集）。
 *
 * ⚠️ 只有 v2 合法键：`description` / `mode` / `permissions` / `system`。
 * 刻意**没有** v1 的 `permission`（对象）与 `prompt`（键名）。
 */
export interface AgentSectionEntry {
  description: string;
  mode: 'primary' | 'all';
  /** v2 原生权限形态：**有序数组**（顺序 = 优先级，最后一条命中者生效）。 */
  permissions: AgentPermissionRule[];
  /** v2 原生角色提示落点（= 控制面下发的可选 `prompt`；**绝不会是 `prompt` 键**）。 */
  system?: string;
}

/** opencode.json `agents` 节整体（key = opencode agent 名）。 */
export type AgentSection = Record<string, AgentSectionEntry>;

/**
 * agent 定义约定字段：出现此外的键即未知字段（显式拒绝）。
 *
 * ⚠️ 刻意**最小**：每一个被放行的键都必须**被真正写出**（否则控制面多发一个键就会
 * "看着有、实际被丢"）。v2 `AgentConfig` 的其余合法键（`model` / `variant` / `steps` /
 * `hidden` / `disabled` / `color` / `request`）**暂不放行**——放行它们等于改控制面契约
 * （本任务不改契约），且必须同步决定"写出还是丢弃"。
 */
const AGENT_ALLOWED_FIELDS: readonly string[] = [
  'name',
  'description',
  'mode',
  'permission',
  'prompt',
];

/**
 * v2 `agents.<n>` 条目的合法键（输出闸门白名单）。
 *
 * ⚠️ 刻意**不含** `prompt`：v2 原生 `agents:` 节里的 `prompt` 是**未知键 → 静默丢弃**
 * （角色提示全丢且无任何告警）⇒ 结构性禁止，不靠注释提醒。
 */
const AGENT_V2_OUTPUT_FIELDS: readonly string[] = [
  'description',
  'mode',
  'permissions',
  'system',
];

/**
 * v1 权限 action → **v2 权限 action**（v2 原生 action 名）。
 *
 * 实测 v2 归一化行为：`bash` → `shell`、`task` → `subagent`；其余同名（`read` / `edit` /
 * `webfetch` / `glob` / `grep` / `list` / `todowrite` / `question` / `websearch` / `lsp` /
 * `skill` / `external_directory` …）在 v2 里**沿用同名**（v2 的 action 是自由字符串）。
 */
const PERMISSION_ACTION_V2: Readonly<Record<string, string>> = {
  bash: 'shell',
  task: 'subagent',
};

/**
 * v2 已把 `write` / `patch` **并入 `edit`**（v2 的 action 命名空间里没有这两个）⇒ 出现即拒。
 *
 * 双重理由：① vteam 层①唯一写闸门是 `edit`（出现第二个写闸门 = 控制面漂移）；
 * ② v2 **认不出**这两个 action → 规则永不命中 → 落到默认放行 = 写闸门**静默失效**。
 */
const REJECTED_WRITE_ACTIONS: readonly string[] = ['write', 'patch'];

/**
 * v1 的默认语义「访问项目目录之外的路径需询问」在 v2 里**默认放行**
 * （实测 v2.0.28：agent 的默认规则集含 `{action:"*",resource:"*",effect:"allow"}`，
 * `external_directory` 没有任何专门规则 → 命中默认放行）。
 *
 * ⇒ vteam 必须**显式**补一条 ask 规则，才能保持 v1 的安全语义。
 */
const EXTERNAL_DIRECTORY_RULE: AgentPermissionRule = {
  action: 'external_directory',
  resource: '*',
  effect: 'ask',
};

/**
 * 由控制面 agent 策略构造 opencode **`agents` 节**（v2 原生形状）。
 *
 * - 每个 agent 必须恰为 `{ name, description, mode:'primary'|'all', permission, prompt? }`；
 *   `permission` 必须为普通对象且**不得含 `write` / `patch` 键**（层①唯一写闸门是 `edit`；
 *   `write` 键出现即视为控制面漂移，显式拒绝）；
 * - 产出条目只含 v2 合法键：权限是**数组** `permissions[]`，角色提示落在 **`system`**；
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
    const entry = buildAgentEntry(agent);
    assertV2EntryShape(agent.name, entry);
    section[agent.name] = entry;
  }
  return section;
}

/**
 * 单个 agent → v2 `agents.<n>` 条目。
 *
 * 角色提示：`prompt`（控制面契约键）→ **`system`**（v2 配置键）。
 * 空/纯空白提示**不写** `system` 键（写空串会让"有没有角色提示"这件事失去判别力）。
 */
function buildAgentEntry(agent: AgentPolicyDefinition): AgentSectionEntry {
  const rules = buildPermissionRules(agent.permission, `agent ${agent.name} permission`);
  const entry: AgentSectionEntry = {
    description: agent.description,
    mode: agent.mode,
    permissions: withExternalDirectoryRule(rules),
  };
  const prompt = typeof agent.prompt === 'string' ? agent.prompt.trim() : '';
  if (prompt !== '') {
    // ⚠️ 键名必须是 `system`：`prompt` 在 v2 原生 `agents:` 节内会被静默丢弃。
    entry.system = prompt;
  }
  return entry;
}

/**
 * v1 权限对象 → v2 权限规则数组（**有序**）。
 *
 * 形态映射：
 * - v1 三态字符串（`bash:"ask"`）→ v2 `{action:"shell",resource:"*",effect:"ask"}`；
 * - v1 glob 映射（`edit:{"*":"deny","<glob>":"allow"}`）→ v2 **每 glob 一条规则**，
 *   **键序原样保留**（v2 用 `findLast` 选最后一条命中者 ⇒ 后面的更具体规则获胜，
 *   与 v1 的 `.at(-1)` 语义一致）。
 *
 * 校验（非法即抛错，绝不静默透传）：
 * - `write` / `patch` 键 → 拒绝（唯一写闸门是 `edit`；v2 也认不出这两个 action）；
 * - 效果值必须是 `allow` / `ask` / `deny`；
 * - 值形态必须是三态字符串或 `{glob: 三态}` 映射。
 *
 * @param permission 控制面下发的 v1 形权限对象
 * @param where 错误上下文（`agent <name> permission` / `permission`）
 */
export function buildPermissionRules(
  permission: Record<string, unknown>,
  where = 'permission',
): AgentPermissionRule[] {
  if (!isPlainObject(permission)) {
    throw new Error(`[agent-definitions] ${where} 非法：必须为对象`);
  }
  const rules: AgentPermissionRule[] = [];
  for (const [rawAction, rawValue] of Object.entries(permission)) {
    const action = rawAction.trim();
    if (action === '') {
      throw new Error(`[agent-definitions] ${where} 非法：含空 action 键`);
    }
    if (REJECTED_WRITE_ACTIONS.includes(action)) {
      throw new Error(
        `[agent-definitions] ${where} 非法：不得含 '${action}' 键` +
          "（层①唯一写闸门是 'edit'；opencode v2 已把 write/patch 并入 edit，" +
          '且认不出这两个 action —— 透传等于写闸门静默失效）',
      );
    }
    const v2Action = PERMISSION_ACTION_V2[action] ?? action;
    if (typeof rawValue === 'string') {
      rules.push({ action: v2Action, resource: '*', effect: assertEffect(action, rawValue, where) });
      continue;
    }
    if (isPlainObject(rawValue)) {
      for (const [resource, effect] of Object.entries(rawValue)) {
        if (resource.trim() === '') {
          throw new Error(`[agent-definitions] ${where}.${action} 非法：含空 resource（glob）键`);
        }
        rules.push({
          action: v2Action,
          resource,
          effect: assertEffect(action, effect, where),
        });
      }
      continue;
    }
    throw new Error(
      `[agent-definitions] ${where}.${action} 非法：值必须是三态字符串或 {glob:三态} 映射` +
        `（实收 ${JSON.stringify(rawValue)}）`,
    );
  }
  return rules;
}

/**
 * 补齐 v1 语义所需的 `external_directory` 询问规则。
 *
 * - 控制面**已显式声明** `external_directory` → 以它为准（不重复补）；
 * - 否则补 `{action:"external_directory",resource:"*",effect:"ask"}`（保持 v1 语义）。
 */
function withExternalDirectoryRule(rules: AgentPermissionRule[]): AgentPermissionRule[] {
  if (rules.some((rule) => rule.action === 'external_directory')) {
    return rules;
  }
  return [...rules, { ...EXTERNAL_DIRECTORY_RULE }];
}

/** 权限效果值校验（v2 `Permission.Effect` = allow | ask | deny）。 */
function assertEffect(action: string, raw: unknown, where: string): PermissionEffect {
  if (raw === 'allow' || raw === 'ask' || raw === 'deny') {
    return raw;
  }
  throw new Error(
    `[agent-definitions] ${where}.${action} 非法：效果必须是 'allow' | 'ask' | 'deny'` +
      `（实收 ${JSON.stringify(raw)}）`,
  );
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
  if (agent.prompt !== undefined && typeof agent.prompt !== 'string') {
    throw new Error(
      `[agent-definitions] agent ${agent.name} prompt 非法：必须为字符串（缺省 = 无静态角色提示）`,
    );
  }
  // 写闸门唯一性：`write` / `patch` 出现即视为控制面漂移，显式拒绝。
  for (const key of Object.keys(agent.permission)) {
    if (REJECTED_WRITE_ACTIONS.includes(key.trim())) {
      throw new Error(
        `[agent-definitions] agent ${agent.name} permission 非法：不得含 '${key.trim()}' 键` +
          "（层①唯一写闸门是 'edit'）",
      );
    }
  }
}

/**
 * 产出条目的 **v2 形状闸门**：只允许 v2 `AgentConfig` 的合法键。
 *
 * ⚠️ 特别地**禁止 `prompt`**：v2 原生 `agents:` 节里的 `prompt` 是未知键 → **静默丢弃**
 * （角色提示全丢且无任何告警）。这里把它变成**响亮的构造期错误**，而不是上线后的静默降级。
 */
function assertV2EntryShape(name: string, entry: AgentSectionEntry): void {
  for (const key of Object.keys(entry)) {
    if (key === 'prompt') {
      throw new Error(
        `[agent-definitions] agent ${name} 产出的 v2 条目不得含 'prompt' 键：` +
          'v2 原生 `agents:` 节内 prompt 是未知键（被静默丢弃），角色提示只能写进 `system`',
      );
    }
    if (!AGENT_V2_OUTPUT_FIELDS.includes(key)) {
      throw new Error(
        `[agent-definitions] agent ${name} 产出的 v2 条目含非法键: ${key}` +
          `（v2 agents 条目的合法键：${AGENT_V2_OUTPUT_FIELDS.join(' / ')}）`,
      );
    }
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
