import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AGENT_KEY_PATTERN,
  buildEditPermission,
  buildReadPermission,
  POLICY_ID_PREFIX,
  ROLE_BASH_DENY_PATTERNS,
  ROLE_BOUNDARIES,
  ROLE_POLICY_DENY_TEMPLATE,
  ROLE_SERVER_GATED_TOOLS,
  VTEAM_MCP_TOOL_NAMES,
  type RoleBoundary,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExecutionPolicyDto } from './dto/create-execution-policy.dto';
import { QueryExecutionPoliciesDto } from './dto/query-execution-policies.dto';
import { UpdateExecutionPolicyDto } from './dto/update-execution-policy.dto';

/**
 * resolveByAgent 返回（Todo 11/12 契约 + agent 详情双层展示）：
 * - `agentName`：opencode agent 名（`vteam-<role>`，无 role 回退 `vteam-plan`）；
 * - `permission`：config 嵌套 `permission`（层① opencode 原生权限）；
 * - `tools`：层② guard allowlist（`config.tools` 合法项胜出，否则按 `agentName` 回退
 *   `ROLE_BOUNDARIES.toolAllows` 常量，与 `/agent-policies` 同源；未知角色 → `{}`）；
 * - `bashDeny`：层② bash 硬化清单（`config.bashDeny` 为数组则用之，否则
 *   `ROLE_BASH_DENY_PATTERNS` 拷贝；未知角色 → `[]`）；
 * - `correction`：config 嵌套 `correction`（层② guard 越界纠正）。
 * - `serverGated`：主实例专属工具（`ROLE_SERVER_GATED_TOOLS` 拷贝，API/UI 展示用，不进 worker wire 格式）；
 */
/** 层② guard 单个工具三态（可编辑矩阵：allow/ask/deny；内置 allowlist 仅用前两者）。 */
export type AgentToolState = 'allow' | 'ask' | 'deny';

export interface ResolvedExecutionPolicy {
  policyId: string;
  policyName: string;
  agentName: string;
  permission: Record<string, unknown>;
  tools: Record<string, AgentToolState>;
  bashDeny: string[];
  correction: Record<string, unknown>;
  /** 主实例专属工具（API/UI 展示用；不进 worker wire 格式的 guard.roles）。 */
  serverGated: string[];
}

/** GET /agent-policies 单个 opencode agent 定义（Todo 12 worker injector 数据源）。 */
export interface AgentPolicyDefinition {
  name: string;
  description: string;
  mode: 'primary' | 'all';
  permission: Record<string, unknown>;
}

/** GET /agent-policies guard 单个角色条目（key = opencode agent 名）。 */
export interface AgentGuardRole {
  permission: Record<string, unknown>;
  tools: Record<string, AgentToolState>;
  bashDeny: string[];
  correction: Record<string, unknown>;
}

/** GET /agent-policies 响应体（opencode agent 定义 + guard 角色集）。 */
export interface AgentPoliciesResponse {
  agents: AgentPolicyDefinition[];
  guard: { enabled: true; roles: Record<string, AgentGuardRole> };
}

/**
 * `resolveBuiltinPolicy` 返回：内置角色行为由 DB `config` 逐字段解析（DB 值合法则胜出，
 * 否则回退 `ROLE_BOUNDARIES` 常量），字段与 `/agent-policies` 的 agent + guard role 并集一致。
 */
export interface ResolvedBuiltinPolicy {
  description: string;
  mode: 'primary' | 'all';
  permission: Record<string, unknown>;
  tools: Record<string, AgentToolState>;
  bashDeny: string[];
  correction: Record<string, unknown>;
  serverGated: string[];
}

/* -------------------------------------------------------------------------- */
/* 规范化发射器（canonical emission）+ 每字段 DB 解析（vteam-role-behavior-abstraction Todo 2） */
/* -------------------------------------------------------------------------- */

/**
 * MySQL 原生 `JSON` 列按「键长度升序 + 字节序」重排对象键（schema.prisma `config Json`），
 * 而 `/agent-policies` 的字节一致性（before-agent-policies.json）要求固定的键序。
 * 因此所有从 DB 解析出的对象在发射前必须经本模块的 canonical 函数重排，输出与
 * 常量构造的插入顺序逐字节一致——与 DB 返回的键序无关。
 */

/** layer① 原生 permission 固定前缀（其后接 `VTEAM_MCP_TOOL_NAMES` 注册表序）。 */
const PERMISSION_KEY_ORDER: readonly string[] = [
  'edit',
  'read',
  'bash',
  'task',
  ...VTEAM_MCP_TOOL_NAMES,
];

/** guard correction 固定键序。 */
const CORRECTION_KEY_ORDER: readonly string[] = [
  'scopeSummary',
  'handoff',
  'denyTemplate',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取内置角色边界；非内置名（自定义 agent）→ undefined。 */
function boundaryOf(agentName: string): RoleBoundary | undefined {
  return (ROLE_BOUNDARIES as Record<string, RoleBoundary | undefined>)[
    agentName
  ];
}

/**
 * 按 `preferred` 声明序重排对象键：先输出 preferred 中存在的键（保持 preferred 顺序），
 * 再把剩余键按字典序追加——对任意输入键序产生同一输出键序。
 */
function orderKeys(
  value: Record<string, unknown>,
  preferred: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const emitted = new Set<string>();
  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      out[key] = value[key];
      emitted.add(key);
    }
  }
  for (const key of Object.keys(value)
    .filter((k) => !emitted.has(k))
    .sort()) {
    out[key] = value[key];
  }
  return out;
}

/**
 * layer② guard 三态矩阵：仅保留值为 `allow`/`ask`/`deny` 的条目（非法值防御式丢弃），
 * 键序先按 `ROLE_BOUNDARIES[name].toolAllows` 声明序，用户新增键按字典序追加。
 */
export function filterToolsMatrix(
  tools: unknown,
): Record<string, AgentToolState> {
  if (!isPlainObject(tools)) {
    return {};
  }
  const states: ReadonlySet<string> = new Set(['allow', 'ask', 'deny']);
  const entries = Object.entries(tools).filter(
    (entry): entry is [string, AgentToolState] =>
      typeof entry[1] === 'string' && states.has(entry[1]),
  );
  return Object.fromEntries(entries);
}

/** canonical 化 tools 矩阵：过滤非法值 + 常量声明序重排（用户新增键字典序追加）。 */
export function canonicalizeTools(
  tools: unknown,
  agentName: string,
): Record<string, AgentToolState> {
  const boundary = boundaryOf(agentName);
  const preferred = boundary ? Object.keys(boundary.toolAllows) : [];
  return orderKeys(filterToolsMatrix(tools), preferred) as Record<
    string,
    AgentToolState
  >;
}

/** canonical 化 edit 映射：`*` 先，随后该角色 `writeGlobs` 声明序，用户新增 glob 字典序追加。 */
export function canonicalizeEditMap(
  edit: Record<string, unknown>,
  agentName: string,
): Record<string, unknown> {
  const boundary = boundaryOf(agentName);
  return orderKeys(edit, ['*', ...(boundary?.writeGlobs ?? [])]);
}

/**
 * canonical 化 layer① permission：先删 `write`（opencode 原生写闸门已由 `edit` 承担），
 * 再按 `edit, read, bash, task, ...VTEAM_MCP_TOOL_NAMES` 重排顶层键，最后规范化嵌套 edit/read。
 */
export function canonicalizePermission(
  permission: Record<string, unknown>,
  agentName: string,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...permission };
  delete copy.write;
  if (isPlainObject(copy.edit)) {
    copy.edit = canonicalizeEditMap(copy.edit, agentName);
  }
  if (isPlainObject(copy.read)) {
    copy.read = orderKeys(copy.read, ['*']);
  }
  return orderKeys(copy, PERMISSION_KEY_ORDER);
}

/**
 * canonical 化 guard correction：`scopeSummary, handoff, denyTemplate` 顶层定序；
 * 嵌套 `handoff` 按该角色 `handoffTo` 声明序（非内置角色字典序）。
 */
export function canonicalizeCorrection(
  correction: Record<string, unknown>,
  agentName: string,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...correction };
  if (isPlainObject(copy.handoff)) {
    const boundary = boundaryOf(agentName);
    copy.handoff = orderKeys(
      copy.handoff,
      boundary ? Object.keys(boundary.handoffTo) : [],
    );
  }
  return orderKeys(copy, CORRECTION_KEY_ORDER);
}

/**
 * 层① `permission.task` 的**派生权威**（唯一规则）：仅 `vteam-plan` 放行 task
 * （可扇出只读评审 subagent），其余角色 deny。
 *
 * 解析优先级（Todo 6）：DB `config.permission.task` 为合法三态值时胜出，否则用本规则
 * 兜底——保证线上绝不出现 `task === undefined`；未来若新增 DB `mode`/`task` 字段，
 * 只需改这里，调用点不动。
 */
export function resolveTaskEffect(
  name: string,
  storedTask?: unknown,
): 'allow' | 'ask' | 'deny' {
  if (
    storedTask === 'allow' ||
    storedTask === 'ask' ||
    storedTask === 'deny'
  ) {
    return storedTask;
  }
  return name === 'vteam-plan' ? 'allow' : 'deny';
}

/**
 * opencode agent `mode` 的**派生权威**（唯一规则）：`vteam-plan` 为 `all`（可被调度），
 * 其余（含自定义）为 `primary`。Todo 6 把它集中为命名函数，便于未来 DB `mode` 字段替换。
 */
export function deriveAgentMode(name: string): 'primary' | 'all' {
  return name === 'vteam-plan' ? 'all' : 'primary';
}

/**
 * 层② guard `tools` 的统一解析（唯一回退实现，`resolveBuiltinPolicy` 与 `guardForAgent` 共用）：
 * `config.tools` 过滤 + canonical 后至少 1 条合法项 → 胜出；否则回退该角色的常量 allowlist
 * （非内置名无常量 → `{}`）。常量非空时绝不返回 `{}`。
 */
export function resolveGuardTools(
  agentName: string,
  tools: unknown,
): Record<string, AgentToolState> {
  const canonicalTools = canonicalizeTools(tools, agentName);
  if (Object.keys(canonicalTools).length > 0) {
    return canonicalTools;
  }
  const boundary = boundaryOf(agentName);
  return boundary ? { ...boundary.toolAllows } : {};
}

/** 层② guard `bashDeny` 的统一解析：`config.bashDeny` 为数组 → 过滤为 `string[]`；否则常量清单。 */
export function resolveBashDeny(bashDeny: unknown): string[] {
  return Array.isArray(bashDeny)
    ? bashDeny.filter((p): p is string => typeof p === 'string')
    : [...ROLE_BASH_DENY_PATTERNS];
}

/** 常量派生的 layer① permission（无 `write` 键；仅 `vteam-plan` task allow）。 */
export function buildRolePermission(
  name: VteamAgentName,
): Record<string, unknown> {
  const boundary = ROLE_BOUNDARIES[name];
  return {
    edit: buildEditPermission(boundary.writeGlobs),
    read: buildReadPermission(),
    bash: boundary.bashEffect,
    // opencode 原生 ctx.ask({permission:'task'}) 先于 guard 生效，两道门须同时打开：
    // 仅 vteam-plan 放行 task（可扇出只读评审 subagent），其余角色保持 deny。
    task: resolveTaskEffect(name),
    ...Object.fromEntries(
      boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
    ),
  };
}

/** 常量派生的 guard correction（canonical 序）。 */
export function buildRoleCorrection(
  name: VteamAgentName,
): Record<string, unknown> {
  const boundary = ROLE_BOUNDARIES[name];
  return canonicalizeCorrection(
    {
      scopeSummary: boundary.scopeSummary,
      handoff: { ...boundary.handoffTo },
      denyTemplate: ROLE_POLICY_DENY_TEMPLATE,
    },
    name,
  );
}

/**
 * 内置角色每字段解析：DB `config` 合法值胜出，缺失/非法回退常量——永不抛错、永不发射
 * 残缺 `tools`（常量非空时绝不返回 `{}`）。
 *
 * 字段来源（Todo 2 决策，见 plan MUST DO #4）：
 * - `permission`：`config.permission`（plain object）→ 规范化 + canonical；否则常量派生；
 * - `tools`：`config.tools` 过滤后至少 1 条合法项 → canonical；否则常量 allowlist；
 * - `bashDeny`：`config.bashDeny` 为数组 → 强制转 `string[]`；否则常量清单；
 * - `correction` / `description`：`config` 值存在则用，否则常量；
 * - `mode`：不在 config 内，按既有规则派生（仅 `vteam-plan` 为 `all`）。
 */
export function resolveBuiltinPolicy(
  name: VteamAgentName,
  config?: unknown,
): ResolvedBuiltinPolicy {
  const boundary = ROLE_BOUNDARIES[name];
  const cfg: Record<string, unknown> = isPlainObject(config) ? config : {};

  const permission = isPlainObject(cfg.permission)
    ? canonicalizePermission(
        {
          ...cfg.permission,
          task: resolveTaskEffect(name, cfg.permission.task),
        },
        name,
      )
    : buildRolePermission(name);

  const tools = resolveGuardTools(name, cfg.tools);
  const bashDeny = resolveBashDeny(cfg.bashDeny);

  const correction = isPlainObject(cfg.correction)
    ? canonicalizeCorrection(cfg.correction, name)
    : buildRoleCorrection(name);

  const description =
    typeof cfg.description === 'string' && cfg.description.length > 0
      ? cfg.description
      : boundary.scopeSummary;

  return {
    description,
    mode: deriveAgentMode(name),
    permission,
    tools,
    bashDeny,
    correction,
    serverGated: [...ROLE_SERVER_GATED_TOOLS],
  };
}

/** /agent-policies 输出顺序（`vteam-plan` 首位 + 5 协作角色 + 只读 `vteam-librarian` 末位）。 */
const AGENT_POLICIES_ORDER: readonly VteamAgentName[] = [
  'vteam-plan',
  'vteam-product',
  'vteam-architect',
  'vteam-developer',
  'vteam-tester',
  'vteam-project_manager',
  'vteam-librarian',
] as const;

/**
 * 内置 agent 名 → 绑定策略 id 约定（seed.ts `ROLE_POLICY_BINDINGS`：`vteam-<role>` ↔ `ep_<role>`）。
 * 例：`vteam-plan` → `ep_plan`、`vteam-project_manager` → `ep_project_manager`。
 */
export function builtinPolicyIdOf(name: VteamAgentName): string {
  return `${POLICY_ID_PREFIX}_${name.replace(/^vteam-/, '')}`;
}

/**
 * 内置 agent 名 → 常量派生策略来源（`config` 与 seed 出厂配置同形：permission/correction/tools，
 * canonical 键序）；非内置名 → null。
 *
 * 唯一常量推导入口：`resolveByAgent`/`resolveManyByAgents` 的行缺失回退与
 * `agents.service.resolveTemplateSource` 的模板来源共用本函数，避免两处派生漂移
 * （vteam-role-behavior-abstraction Todo 5）。
 */
export interface ConstantPolicySource {
  config: {
    permission: Record<string, unknown>;
    correction: Record<string, unknown>;
    tools: Record<string, AgentToolState>;
  };
  description: string;
  bashDeny: string[];
}

export function resolveConstantPolicySource(
  name: string,
): ConstantPolicySource | null {
  if (!boundaryOf(name)) {
    return null;
  }
  const resolved = resolveBuiltinPolicy(name as VteamAgentName, null);
  return {
    config: {
      permission: resolved.permission,
      correction: resolved.correction,
      tools: resolved.tools,
    },
    description: resolved.description,
    bashDeny: resolved.bashDeny,
  };
}

/**
 * 单一 ExecutionPolicy 服务（vteam-role-behavior-enforcement Todo 11 唯一来源）。
 * - CRUD：列表（type 过滤 + 分页）/详情/创建/更新/删除；
 *   `type='template'` 为 seed 维护的平台内置角色策略——仅 POST/DELETE → 403
 *   （禁止伪造内置行、禁止删除使 dispatch 丢失角色边界）；PATCH 允许直接编辑
 *   内置策略的 config/name/description（vteam-role-behavior-abstraction Todo 8）；
 * - `resolveByAgent`：按 `policyId`（优先）或 `role`（`ep_<role>`）解析策略，
 *   供 ChatModule dispatcher 注入【职责边界】（Todo 4 已预留 boundarySection）与
 *   `/agent-policies`（Todo 12）消费；未绑定/策略缺失/配置残缺 → null（调用方回退现状）。
 *
 * 禁止形状：旧 `{ permissions, writePaths }` 已废弃——config 必须为
 * `{ permission: object, correction: object }`（seed.ts:328-341 唯一事实来源），
 * 非法 → 400 `POLICY_CONFIG_INVALID`。
 */
@Injectable()
export class ExecutionPolicyService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /** 进程启动对齐 ep_ 数字序号（命名 id ep_<role> 忽略，只统计 ep_<数字>）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(
      this.prisma.executionPolicy,
      POLICY_ID_PREFIX,
      this.idGen,
    );
  }

  /**
   * GET /execution-policies：type 过滤 + 分页（对齐 agents.findAll 的 {items, total, page, pageSize}）。
   * type 缺省返回全部（含 template 只读策略）；分页 page 从 1 起、pageSize 默认 20 上限 100。
   */
  async findAll(query: QueryExecutionPoliciesDto = {}) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where = { type: query.type ? { equals: query.type } : undefined };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.executionPolicy.count({ where }),
      this.prisma.executionPolicy.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { items: rows, total, page, pageSize };
  }

  /** GET /execution-policies/:id：详情。不存在 → 404 `POLICY_NOT_FOUND`。 */
  async findOne(id: string) {
    const policy = await this.prisma.executionPolicy.findUnique({
      where: { id },
    });
    if (!policy) {
      this.throwNotFound(id);
    }
    return policy;
  }

  /**
   * POST /execution-policies：仅 `type='custom'`（DTO 层 IsIn 收敛；service 再兜底——
   * 显式传 `type='template'` → 403，seed 外禁止伪造内置策略）。
   * 非法 `config`（permission/correction 缺失或非对象，含旧 `{permissions,writePaths}`）→ 400。
   */
  async create(dto: CreateExecutionPolicyDto) {
    if ((dto as { type?: string }).type === 'template') {
      throw new ForbiddenException({
        code: 'POLICY_TEMPLATE_READONLY',
        message: '模板策略只读（seed 维护），请创建 type=custom 策略',
      });
    }
    this.assertValidConfig(dto.config);
    return this.prisma.executionPolicy.create({
      data: {
        id: await this.idGen.nextId(POLICY_ID_PREFIX),
        name: dto.name.trim(),
        description: dto.description ?? null,
        type: dto.type,
        config: dto.config as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * PATCH /execution-policies/:id：`type` 不可改（不在 DTO）。
   * 内置策略（`type='template'`）可直接编辑 config/name/description——
   * vteam-role-behavior-abstraction Todo 8 起页面可改内置角色行为；
   * `config` 显式传入时仍须完整合法（不接受半更新残缺）→ 否则 400。
   */
  async update(id: string, dto: UpdateExecutionPolicyDto) {
    const existing = await this.prisma.executionPolicy.findUnique({
      where: { id },
    });
    if (!existing) {
      this.throwNotFound(id);
    }
    if (dto.config !== undefined) {
      this.assertValidConfig(dto.config);
    }
    return this.prisma.executionPolicy.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description ?? null }
          : {}),
        ...(dto.config !== undefined
          ? { config: dto.config as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  /**
   * DELETE /execution-policies/:id：`type='template'` → 403；不存在 → 404。
   */
  async remove(id: string) {
    const existing = await this.prisma.executionPolicy.findUnique({
      where: { id },
    });
    if (!existing) {
      this.throwNotFound(id);
    }
    this.assertWritable(existing.type);
    await this.prisma.executionPolicy.delete({ where: { id } });
  }

  /**
   * 按 agent 解析其绑定策略（dispatcher boundary 注入 + Todo 12 `/agent-policies` 共用）。
   * 统一回退策略（vteam-role-behavior-abstraction Todo 5）：DB 行胜出；行缺失时内置名
   * 回退 `ROLE_BOUNDARIES` 常量派生（非内置名 → null），与 `buildAgentPolicies()` 同源。
   */
  async resolveByAgent(agent: {
    policyId?: string | null;
    role?: string | null;
    agentKey?: string | null;
  }): Promise<ResolvedExecutionPolicy | null> {
    const policyId = this.policyKeyOf(agent);
    const policy = policyId
      ? await this.prisma.executionPolicy.findUnique({ where: { id: policyId } })
      : null;
    return this.resolveAgentWithFallback(agent, policy, policyId);
  }

  /**
   * 批量按 agent 解析其绑定策略（GET /agents 列表用，避免 N+1）。
   * 语义与 `resolveByAgent` 完全一致（DB 行胜出、行缺失内置名回退常量），
   * 单次 `findMany` 拉取去重后的策略全集后内存映射。
   * 返回与入参同序同长的 `(ResolvedExecutionPolicy | null)[]`。
   */
  async resolveManyByAgents(
    agents: {
      policyId?: string | null;
      role?: string | null;
      agentKey?: string | null;
    }[],
  ): Promise<(ResolvedExecutionPolicy | null)[]> {
    const keys = agents.map((a) => this.policyKeyOf(a));
    const ids = [...new Set(keys.filter((k): k is string => k !== null))];
    const policies =
      ids.length === 0
        ? []
        : await this.prisma.executionPolicy.findMany({
            where: { id: { in: ids } },
          });
    const byId = new Map(policies.map((p) => [p.id, p]));
    return agents.map((agent, i) =>
      this.resolveAgentWithFallback(agent, byId.get(keys[i]) ?? null, keys[i]),
    );
  }

  /**
   * 统一解析（vteam-role-behavior-abstraction Todo 5）：
   * - DB 行存在 → 沿用既有解析（`config.permission`/`correction` + `guardForAgent`）；
   * - DB 行缺失且 `role` 命中内置角色 → 回退 `resolveBuiltinPolicy` 常量派生（非 null、
   *   与 `/agents` 视图同源）；
   * - 其余（自定义 agent 行缺失）→ null。
   */
  private resolveAgentWithFallback(
    agent: {
      policyId?: string | null;
      role?: string | null;
      agentKey?: string | null;
    },
    policy: {
      id: string;
      name: string;
      config: unknown;
    } | null,
    key: string | null,
  ): ResolvedExecutionPolicy | null {
    const agentName = this.agentNameOf(agent);
    if (!policy) {
      const constantName = this.constantRoleNameOf(agent.role);
      if (!constantName) {
        return null;
      }
      const resolved = resolveBuiltinPolicy(constantName, null);
      return {
        policyId: key ?? builtinPolicyIdOf(constantName),
        policyName: agentName,
        agentName,
        permission: resolved.permission,
        tools: resolved.tools,
        bashDeny: resolved.bashDeny,
        correction: resolved.correction,
        serverGated: resolved.serverGated,
      };
    }
    const config = policy.config as {
      permission?: unknown;
      correction?: unknown;
      tools?: unknown;
    } | null;
    if (
      !isPlainObject(config?.permission) ||
      !isPlainObject(config?.correction)
    ) {
      return null;
    }
    const guard = this.guardForAgent(agentName, config);
    return {
      policyId: policy.id,
      policyName: policy.name,
      agentName,
      permission: config.permission as Record<string, unknown>,
      tools: guard.tools,
      bashDeny: guard.bashDeny,
      correction: config.correction as Record<string, unknown>,
      serverGated: [...ROLE_SERVER_GATED_TOOLS],
    };
  }

  /** `role` → `vteam-<role>`（命中 `ROLE_BOUNDARIES` 才返回，否则 null）。 */
  private constantRoleNameOf(role?: string | null): VteamAgentName | null {
    if (!role) {
      return null;
    }
    const name = `vteam-${role}`;
    return boundaryOf(name) ? (name as VteamAgentName) : null;
  }

  /**
   * 构建 opencode agent 定义 + guard 角色集（Todo 12，worker injector 数据源）。
   * - 内置 7 项（`AGENT_POLICIES_ORDER` 顺序）行为由绑定策略行 `ep_<role>` 的 `config`
   *   经 `resolveBuiltinPolicy` 逐字段解析（DB 值合法则胜出，缺失/非法回退 `ROLE_BOUNDARIES`
   *   常量）——单次 `findMany` 批量拉取 7 行，无 N+1；行缺失/字段缺失永不抛错、永不发射残缺；
   *   输出顺序恒取 `AGENT_POLICIES_ORDER`（seed 插入序不同，不得按查询结果排序）；
   *   `guard.roles` key 与 `agents[].name` 完全一致；
   * - 自定义块：`agentKey != null AND policyId != null` 的 Agent 行（按 `agentKey`
   *   升序稳定输出），其绑定策略存在且 `config.permission` 为对象时追加一项
   *   `vteam-<agentKey>`（permission 取策略 config，其余经 `guardForAgent` 解析）。
   */
  async buildAgentPolicies(): Promise<AgentPoliciesResponse> {
    const boundPolicyIds = AGENT_POLICIES_ORDER.map((name) =>
      builtinPolicyIdOf(name),
    );
    const boundPolicies = await this.prisma.executionPolicy.findMany({
      where: { id: { in: boundPolicyIds } },
    });
    const boundById = new Map(boundPolicies.map((p) => [p.id, p]));
    const builtins = AGENT_POLICIES_ORDER.map((name) => ({
      name,
      policy: resolveBuiltinPolicy(
        name,
        boundById.get(builtinPolicyIdOf(name))?.config ?? null,
      ),
    }));
    const agents: AgentPolicyDefinition[] = builtins.map(
      ({ name, policy }) => ({
        name,
        description: policy.description,
        mode: policy.mode,
        permission: policy.permission,
      }),
    );
    const roles: Record<string, AgentGuardRole> = Object.fromEntries(
      builtins.map(({ name, policy }) => {
        const role: AgentGuardRole = {
          permission: policy.permission,
          tools: policy.tools,
          bashDeny: policy.bashDeny,
          correction: policy.correction,
        };
        return [name, role];
      }),
    );
    const builtInNames = new Set<string>(AGENT_POLICIES_ORDER);
    const customAgents = (
      await this.prisma.agent.findMany({
        where: { agentKey: { not: null }, policyId: { not: null } },
        orderBy: { agentKey: 'asc' },
      })
    ).sort((a, b) => String(a.agentKey).localeCompare(String(b.agentKey)));
    if (customAgents.length > 0) {
      const policyIds = [
        ...new Set(
          customAgents
            .map((a) => a.policyId)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ];
      const policies = await this.prisma.executionPolicy.findMany({
        where: { id: { in: policyIds } },
      });
      const byId = new Map(policies.map((p) => [p.id, p]));
      const agentKeyPattern = new RegExp(AGENT_KEY_PATTERN);
      for (const custom of customAgents) {
        const agentKey = custom.agentKey;
        if (typeof agentKey !== 'string' || !agentKeyPattern.test(agentKey)) {
          continue;
        }
        const name = `vteam-${agentKey}`;
        if (builtInNames.has(name)) {
          continue;
        }
        const policy =
          typeof custom.policyId === 'string'
            ? byId.get(custom.policyId)
            : undefined;
        if (!policy) {
          continue;
        }
        const config = policy.config as unknown as {
          permission?: unknown;
          correction?: unknown;
          tools?: unknown;
        } | null;
        if (!isPlainObject(config?.permission)) {
          continue;
        }
        const guard = this.guardForAgent(name, config);
        const correction = isPlainObject(config?.correction)
          ? (config.correction as Record<string, unknown>)
          : {};
        agents.push({
          name,
          description:
            typeof policy.description === 'string' &&
            policy.description.length > 0
              ? policy.description
              : custom.name,
          mode: deriveAgentMode(name),
          permission: config.permission as Record<string, unknown>,
        });
        roles[name] = {
          permission: config.permission as Record<string, unknown>,
          tools: guard.tools,
          bashDeny: guard.bashDeny,
          correction,
        };
        builtInNames.add(name);
      }
    }
    return { agents, guard: { enabled: true as const, roles } };
  }

  /**
   * config 合法性：必须为 `{ permission: object, correction: object }`
   *（两者均为非数组对象；旧 `{ permissions, writePaths }` 在此被拒绝）。
   * `tools` 可选：缺失合法；显式传入时须为非数组对象（三态矩阵由
   * `guardForAgent` 防御式过滤，非法条目丢弃）。
   */
  private assertValidConfig(config: unknown): void {
    const cfg = config as {
      permission?: unknown;
      correction?: unknown;
      tools?: unknown;
    } | null;
    if (
      !isPlainObject(cfg) ||
      !isPlainObject(cfg.permission) ||
      !isPlainObject(cfg.correction) ||
      (cfg.tools !== undefined && !isPlainObject(cfg.tools))
    ) {
      throw new BadRequestException({
        code: 'POLICY_CONFIG_INVALID',
        message: 'config 非法：permission/correction 均须为对象',
      });
    }
  }

  private policyKeyOf(agent: {
    policyId?: string | null;
    role?: string | null;
    agentKey?: string | null;
  }): string | null {
    return agent.policyId ?? (agent.role ? `ep_${agent.role}` : null);
  }

  private agentNameOf(agent: {
    role?: string | null;
    agentKey?: string | null;
  }): string {
    return agent.agentKey
      ? `vteam-${agent.agentKey}`
      : agent.role
        ? `vteam-${agent.role}`
        : 'vteam-plan';
  }

  /**
   * 层② guard 数据（与 `buildAgentPolicies()` 同源）：
   * - 内置名与自定义 agent **同一路径**——`config.tools` 过滤 + canonical 后至少 1 条合法项
   *   则胜出（DB 可编辑），否则回退该内置角色的 `ROLE_BOUNDARIES.toolAllows` 常量 allowlist；
   * - `bashDeny`：`config.bashDeny` 为数组则过滤为 `string[]`，否则 `ROLE_BASH_DENY_PATTERNS`；
   * - 无 config 的未知名（非内置）保持旧语义 `{ tools: {}, bashDeny: [] }`（纯展示路径默认 deny）。
   *
   * 内置名不再短路返回常量：Todo 4 移除后，DB 对内置策略 `tools`/`bashDeny` 的编辑
   * 才真正流经 `resolveByAgent`/`resolveManyByAgents` 与页面/my_profile。
   */
  private guardForAgent(
    agentName: string,
    config?: { tools?: unknown; bashDeny?: unknown } | null,
  ): {
    tools: Record<string, AgentToolState>;
    bashDeny: string[];
  } {
    if (config === undefined || config === null) {
      const boundary = boundaryOf(agentName);
      if (!boundary) {
        return { tools: {}, bashDeny: [] };
      }
      return {
        tools: { ...boundary.toolAllows },
        bashDeny: [...ROLE_BASH_DENY_PATTERNS],
      };
    }
    return {
      tools: resolveGuardTools(agentName, config.tools),
      bashDeny: resolveBashDeny(config.bashDeny),
    };
  }

  /**
   * 模板策略写保护（仅 POST/DELETE 调用；PATCH 已放开内置策略编辑）：
   * seed 维护的平台内置角色策略不可伪造/删除。
   */
  private assertWritable(type: string): void {
    if (type === 'template') {
      throw new ForbiddenException({
        code: 'POLICY_TEMPLATE_READONLY',
        message: '模板策略只读（seed 维护），请克隆为 custom 策略再修改',
      });
    }
  }

  /** 404：POLICY_NOT_FOUND。 */
  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: 'POLICY_NOT_FOUND',
      message: `ExecutionPolicy ${id} 不存在`,
    });
  }

  private normalizePage(page?: number): number {
    const p = Number(page ?? 1);
    return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
  }

  private normalizePageSize(pageSize?: number): number {
    const ps = Number(pageSize ?? 20);
    if (!Number.isFinite(ps)) return 20;
    return Math.min(Math.max(Math.floor(ps), 1), 100);
  }
}
