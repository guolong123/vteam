import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  buildEditPermission,
  buildReadPermission,
  ROLE_BASH_DENY_PATTERNS,
  ROLE_BOUNDARIES,
  ROLE_POLICY_DENY_TEMPLATE,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExecutionPolicyDto } from './dto/create-execution-policy.dto';
import { QueryExecutionPoliciesDto } from './dto/query-execution-policies.dto';
import { UpdateExecutionPolicyDto } from './dto/update-execution-policy.dto';

/** ExecutionPolicy 域主键前缀（`ep_<零填充序号>`，如 ep_0000000001；模板用命名 id ep_<role>）。 */
const POLICY_ID_PREFIX = 'ep';

/**
 * resolveByAgent 返回（Todo 11/12 契约）：
 * - `agentName`：opencode agent 名（`vteam-<role>`，无 role 回退 `vteam-plan`）；
 * - `permission`：config 嵌套 `permission`（层① opencode 原生权限）；
 * - `correction`：config 嵌套 `correction`（层② guard 越界纠正）。
 */
export interface ResolvedExecutionPolicy {
  policyId: string;
  policyName: string;
  agentName: string;
  permission: Record<string, unknown>;
  correction: Record<string, unknown>;
}

/** GET /agent-policies 单个 opencode agent 定义（Todo 12 worker injector 数据源）。 */
export interface AgentPolicyDefinition {
  name: VteamAgentName;
  description: string;
  mode: 'primary';
  permission: Record<string, unknown>;
}

/** GET /agent-policies guard 单个角色条目（key = opencode agent 名）。 */
export interface AgentGuardRole {
  permission: Record<string, unknown>;
  tools: Record<string, 'allow' | 'ask'>;
  bashDeny: string[];
  correction: Record<string, unknown>;
}

/** GET /agent-policies 响应体（opencode agent 定义 + guard 角色集）。 */
export interface AgentPoliciesResponse {
  agents: AgentPolicyDefinition[];
  guard: { enabled: true; roles: Record<VteamAgentName, AgentGuardRole> };
}

/** /agent-policies 输出顺序（`vteam-plan` 首位 + 5 协作角色）。 */
const AGENT_POLICIES_ORDER: readonly VteamAgentName[] = [
  'vteam-plan',
  'vteam-product',
  'vteam-architect',
  'vteam-developer',
  'vteam-tester',
  'vteam-project_manager',
] as const;

/**
 * 单一 ExecutionPolicy 服务（vteam-role-behavior-enforcement Todo 11 唯一来源）。
 * - CRUD：列表（type 过滤 + 分页）/详情/创建/更新/删除；
 *   `type='template'` 为 seed 维护的平台内置角色策略——写操作（更新/删除）→ 403；
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
   * 目标 `type='template'` → 403；`config` 显式传入时仍须完整合法（不接受半更新残缺）→ 否则 400。
   */
  async update(id: string, dto: UpdateExecutionPolicyDto) {
    const existing = await this.prisma.executionPolicy.findUnique({
      where: { id },
    });
    if (!existing) {
      this.throwNotFound(id);
    }
    this.assertWritable(existing.type);
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
   * - `policyId` 优先直查；无则按 `role` 查命名策略 `ep_<role>`；
   * - 策略缺失 / config 残缺（permission/correction 任一非对象）→ null（调用方回退现状，不抛错）。
   */
  async resolveByAgent(agent: {
    policyId?: string | null;
    role?: string | null;
  }): Promise<ResolvedExecutionPolicy | null> {
    const policyId = agent.policyId ?? (agent.role ? `ep_${agent.role}` : null);
    if (!policyId) {
      return null;
    }
    const policy = await this.prisma.executionPolicy.findUnique({
      where: { id: policyId },
    });
    if (!policy) {
      return null;
    }
    const config = policy.config as unknown as {
      permission?: unknown;
      correction?: unknown;
    } | null;
    if (!this.isPlainObject(config?.permission) || !this.isPlainObject(config?.correction)) {
      return null;
    }
    return {
      policyId: policy.id,
      policyName: policy.name,
      agentName: agent.role ? `vteam-${agent.role}` : 'vteam-plan',
      permission: config.permission as Record<string, unknown>,
      correction: config.correction as Record<string, unknown>,
    };
  }

  /**
   * 构建 opencode agent 定义 + guard 角色集（Todo 12，worker injector 数据源）。
   * 纯函数（无 DB 依赖）：全部值由 `ROLE_BOUNDARIES` 派生——
   * - `permission`：`{ edit: buildEditPermission(writeGlobs), read: buildReadPermission(), bash, task:'deny', ...mcpDenies:'deny' }`（无 `write` 键）；
   * - `guard.roles` key 与 `agents[].name` 完全一致；
   * - `tools` = `toolAllows`（真实暴露名），`bashDeny` = 共享硬化清单，
   *   `correction` = `{ scopeSummary, handoff, denyTemplate }`。
   */
  buildAgentPolicies(): AgentPoliciesResponse {
    const agents = AGENT_POLICIES_ORDER.map((name) => {
      const boundary = ROLE_BOUNDARIES[name];
      return {
        name,
        description: boundary.scopeSummary,
        mode: 'primary' as const,
        permission: this.buildRolePermission(name),
      };
    });
    const roles = Object.fromEntries(
      AGENT_POLICIES_ORDER.map((name) => {
        const boundary = ROLE_BOUNDARIES[name];
        const role: AgentGuardRole = {
          permission: this.buildRolePermission(name),
          tools: { ...boundary.toolAllows },
          bashDeny: [...ROLE_BASH_DENY_PATTERNS],
          correction: {
            scopeSummary: boundary.scopeSummary,
            handoff: { ...boundary.handoffTo },
            denyTemplate: ROLE_POLICY_DENY_TEMPLATE,
          },
        };
        return [name, role];
      }),
    ) as Record<VteamAgentName, AgentGuardRole>;
    return { agents, guard: { enabled: true as const, roles } };
  }

  /**
   * config 合法性：必须为 `{ permission: object, correction: object }`
   *（两者均为非数组对象；旧 `{ permissions, writePaths }` 在此被拒绝）。
   */
  private assertValidConfig(config: unknown): void {
    const cfg = config as { permission?: unknown; correction?: unknown } | null;
    if (
      !this.isPlainObject(cfg) ||
      !this.isPlainObject(cfg.permission) ||
      !this.isPlainObject(cfg.correction)
    ) {
      throw new BadRequestException({
        code: 'POLICY_CONFIG_INVALID',
        message: 'config 非法：permission/correction 均须为对象',
      });
    }
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === 'object' && value !== null && !Array.isArray(value)
    );
  }

  /** 层① 原生 permission（与 seed 角色策略同形：edit glob + read + bash + task deny + MCP deny，无 `write` 键）。 */
  private buildRolePermission(name: VteamAgentName): Record<string, unknown> {
    const boundary = ROLE_BOUNDARIES[name];
    return {
      edit: buildEditPermission(boundary.writeGlobs),
      read: buildReadPermission(),
      bash: boundary.bashEffect,
      task: 'deny',
      ...Object.fromEntries(
        boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
      ),
    };
  }

  /** 模板策略写保护（seed 维护的平台内置角色策略只读）。 */
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
