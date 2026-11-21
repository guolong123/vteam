import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AGENT_ERRORS,
  AGENT_KEY_PATTERN,
  POLICY_ID_PREFIX,
  ROLE_POLICY_DENY_TEMPLATE,
  STATIC_AVAILABLE_MODELS,
} from '../common/constants/agent.constants';
import { normalizePage, normalizePageSize } from '../common/pagination';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { ModelsService } from '../models/models.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient } from '../workers/worker.client';
import { WorkersService } from '../workers/workers.service';
import { CloneAgentDto } from './dto/clone-agent.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import { QueryAgentsDto } from './dto/query-agents.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import {
  ExecutionPolicyService,
  ResolvedExecutionPolicy,
  resolveConstantPolicySource,
} from '../execution-policies/execution-policy.service';

/** Agent 域主键前缀（对齐 15 篇 §2.2：<prefix>_<零填充序号>）。 */
const ID_PREFIX = {
  agent: 'a',
  agentSkill: 'as',
} as const;

/** agentKey 唯一冲突 → 409 的稳定错误码（覆盖 create/clone/update 三路径）。 */
const AGENT_KEY_CONFLICT = 'AGENT_KEY_CONFLICT' as const;

/** agentKey 非法 → 400 的稳定错误码（格式不符 / `vteam-` 前缀 / 缺失必填）。 */
const AGENT_KEY_INVALID = 'AGENT_KEY_INVALID' as const;

/** 列表/详情共用的关联 include（agent_skills → skillId 数组）。 */
const AGENT_INCLUDE = {
  skills: true,
} as const;

/**
 * Agent 行（含关联，toAgentDto 输入）。
 *
 * `role` 不再从行上读取（agent-role-decommission todo 6）：DTO 的 `role` 输出字段
 * 透传 `agentKey`（机器键，与 `AgentRole.key` 对齐），能力解析（策略/工具）与它无关。
 */
type AgentRow = {
  id: string;
  name: string;
  agentKey: string | null;
  type: string;
  prompt: string;
  baseAgentId: string | null;
  defaultModelId: string | null;
  persona: string | null;
  policyId: string | null;
  createdAt: Date;
  updatedAt: Date;
  skills: { skillId: string }[];
};

/** available-models 动态路径：纯数组（保持前端契约 [{id, name}]）。 */
type LiveModelsResult = { id: string; name: string }[];

/** available-models 降级路径：静态列表 + source 标记（无 worker / listModels 失败）。 */
type FallbackModelsResult = {
  models: readonly { id: string; name: string }[];
  source: 'fallback';
};

/** available-models 返回联合（正常=动态数组，降级=对象带 source）。 */
export type AvailableModelsResult = LiveModelsResult | FallbackModelsResult;

/**
 * Agent 服务：列表/详情 + 完整 CRUD（Phase 3 T5）。
 * - 列表（type 过滤 + 分页 + 扩展字段）、详情（404 AGENT_ERRORS.AGENT_NOT_FOUND）
 * - create：custom 二表事务（Agent + agent_skills）
 * - clone：深拷贝副本（baseAgentId 血缘指向源，同事务复制 skills，不改源）
 * - update/remove：type=template → 403 PERMISSION_AGENT_READONLY；clone/custom 可写
 * - 权限唯一来源：agent.policyId 绑定的 ExecutionPolicy（toAgentDto 返回
 *   effectivePermission，未绑定 → null）
 * - available-models：T11 起动态（WorkerClient.listModels），失败降级 STATIC_AVAILABLE_MODELS
 */
@Injectable()
export class AgentsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly workersService: WorkersService,
    private readonly workerClient: WorkerClient,
    private readonly modelsService: ModelsService,
    private readonly executionPolicyService: ExecutionPolicyService,
  ) {}

  /**
   * 进程启动对齐 agent 域前缀序号（重启续号）。
   * 只统计 a_<数字> 行的最大序号，忽略 a_architect/a_product 等命名 id
   * （原 findFirst orderBy id desc 取到命名 id → parseInt NaN → seed 失败 → 创建撞主键）。
   */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.agent, ID_PREFIX.agent, this.idGen);
    await resyncIdPrefix(
      this.prisma.agentSkill,
      ID_PREFIX.agentSkill,
      this.idGen,
    );
  }

  /**
   * GET /agents：type 过滤 + 分页（对齐 projects 的 {items, total, page, pageSize}）。
   * type 缺省返回全部**用户可见** Agent（template/custom/clone，排除平台占位 `type='system'`）；
   * 分页 page 从 1 起、pageSize 默认 20 上限 100。
   */
  async findAll(query: QueryAgentsDto = {}) {
    const page = normalizePage(query.page);
    const pageSize = normalizePageSize(query.pageSize);
    const where = query.type
      ? { type: { equals: query.type } }
      : { type: { not: 'system' } };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.agent.count({ where }),
      this.prisma.agent.findMany({
        where,
        include: AGENT_INCLUDE,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const items = await this.toAgentDtoList(rows);

    return { items, total, page, pageSize };
  }

  /**
   * GET /agents/:id：详情（含 skills 关联 + effectivePermission）。
   * 不存在 → 404 `AGENT_NOT_FOUND`（AGENT_ERRORS，值与 task/chat 域一致）。
   */
  async findOne(id: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: AGENT_INCLUDE,
    });
    if (!agent) {
      this.throwNotFound(id);
    }
    return this.toAgentDto(agent);
  }

  /**
   * POST /agents：完全自定义（FR-32）。
   * 二表事务：Agent（type=custom、baseAgentId=null、createdBy=当前用户）
   * + agent_skills 批量，返回 toAgentDto 格式。
   *
   * 起始能力三路径（`Agent.role` 已不参与，agent-role-decommission todo 4）：
   * - PATH 1 显式 `dto.policyId` → 原样绑定，不建策略（显式选择恒胜出）；
   * - PATH 2 无 policyId + `dto.agentRoleId` → 岗位默认 Agent 的绑定策略 config
   *   深拷贝为新 custom 策略（行缺失但默认 Agent 的 agentKey 命中内置角色时走常量派生）；
   * - PATH 3 两者皆无（或岗位无 defaultAgentId / 其 Agent 无 policyId）→
   *   deny-by-default 骨架 custom 策略。
   * 写操作全在同事务内（失败不留半装配行）；effectivePermission 在提交后解析，
   * 保证新建策略行提交可见（事务内经别连接读不到未提交行）。
   */
  async create(userId: string, dto: CreateAgentDto) {
    this.assertValidAgentKey(dto.agentKey);
    let created: AgentRow;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const name = dto.name.trim();
        let policyId: string | null = dto.policyId ?? null;
        if (!policyId) {
          const source = await this.resolveTemplateSource(tx, {
            agentRoleId: dto.agentRoleId ?? null,
          });
          const config = source?.config ?? this.buildSkeletonConfig(name);
          policyId = await this.provisionCustomPolicy(tx, {
            agentName: name,
            config,
            description: source?.description ?? null,
          });
        }
        const agent = await tx.agent.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.agent),
            name,
            type: dto.type,
            agentKey: dto.agentKey,
            prompt: dto.prompt ?? '',
            baseAgentId: null,
            defaultModelId: dto.defaultModelId ?? null,
            persona: dto.persona ?? null,
            policyId,
            createdBy: userId,
          },
        });

        const skills = await this.createSkills(tx, agent.id, dto.skillIds);

        return { ...agent, skills };
      });
    } catch (e) {
      this.throwOnAgentKeyConflict(e);
      throw e;
    }
    return this.toAgentDto(created);
  }

  /**
   * POST /agents/:id/clone：深拷贝副本（FR-31）。
   * 源不存在 → 404；新行 type=clone、baseAgentId=源.id、name=请求名或「源名副本」；
   * 同事务复制 skills（不含会话/任务关系），克隆不触碰源行。
   * 策略装配：恒为源策略 config 的深拷贝新 `type='custom'` 策略（源为 template/custom
   * 均不共享可写策略）；源无绑定策略时按 `dto.agentRoleId` 岗位模板深拷贝，仍无 → 骨架。
   * 写操作全在同事务内；effectivePermission 在提交后解析（理由同 create）。
   */
  async clone(userId: string, id: string, dto: CloneAgentDto) {
    const source = await this.prisma.agent.findUnique({
      where: { id },
      include: AGENT_INCLUDE,
    });
    if (!source) {
      this.throwNotFound(id);
    }

    const newName = dto.name?.trim() || `${source.name}副本`;
    this.assertValidAgentKey(dto.agentKey);

    let created: AgentRow;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const bound = source.policyId
          ? await tx.executionPolicy.findUnique({
              where: { id: source.policyId },
            })
          : null;
        const template = bound
          ? null
          : await this.resolveTemplateSource(tx, {
              agentRoleId: dto.agentRoleId ?? null,
            });
        const config =
          (bound ? (bound.config as unknown) : undefined) ??
          template?.config ??
          this.buildSkeletonConfig(newName);
        const description =
          (bound && typeof bound.description === 'string'
            ? bound.description
            : null) ??
          template?.description ??
          null;
        const policyId = await this.provisionCustomPolicy(tx, {
          agentName: newName,
          config,
          description,
        });
        const clone = await tx.agent.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.agent),
            name: newName,
            type: 'clone',
            baseAgentId: source.id,
            agentKey: dto.agentKey,
            prompt: source.prompt,
            defaultModelId: source.defaultModelId,
            persona: source.persona,
            policyId,
            createdBy: userId,
          },
        });

        await this.copySkills(tx, source, clone.id);

        return {
          ...clone,
          skills: source.skills.map((s) => ({ skillId: s.skillId })),
        };
      });
    } catch (e) {
      this.throwOnAgentKeyConflict(e);
      throw e;
    }
    return this.toAgentDto(created);
  }

  /**
   * PATCH /agents/:id（is_0000000030 放开内置 agent 设置修改）：
   * - template（内置）允许修改设置字段（name/prompt/defaultModelId/persona/
   *   policyId + skillIds 关联重建），使内置 agent 可自定义配置；
   *   agentId/type 不可改（不在 DTO，天然安全红线）；
   * - clone/custom → 同规则更新；
   * - 删除（remove）仍对 template 403（销毁性操作不在"设置修改"范围）。
   * skillIds 显式传入时重建关联（不传保持原关联）。
   *
   * 标签 vs 能力（agent-role-decommission todo 4，显式决策）：本方法**不接受标签字段**，
   * `policyId` 仅在显式传入时写入。改名（name）或改岗位标签（AgentRole / TeamMember.roleId，
   * 各自走 PATCH /agent-roles/:id 或团队端点）**不会**重配或重拷本 agent 的绑定策略——
   * 用户对策略的编辑必须存活于任何标签变更。因此"改了标签但没改策略"的结果是：
   * 展示名/岗位变化，`policyId` 与生效权限逐字节不变；要改能力必须显式 PATCH `policyId`
   * 或编辑 `PATCH /execution-policies/:policyId` 的 config。
   */
  async update(id: string, dto: UpdateAgentDto) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      this.throwNotFound(id);
    }

    if (dto.agentKey !== undefined) {
      this.assertValidAgentKey(dto.agentKey);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.agent.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.agentKey !== undefined ? { agentKey: dto.agentKey } : {}),
            ...(dto.prompt !== undefined ? { prompt: dto.prompt } : {}),
            ...(dto.defaultModelId !== undefined
              ? { defaultModelId: dto.defaultModelId }
              : {}),
            ...(dto.persona !== undefined
              ? { persona: dto.persona ?? null }
              : {}),
            ...(dto.policyId !== undefined ? { policyId: dto.policyId } : {}),
          },
        });

        if (dto.skillIds !== undefined) {
          await this.replaceSkills(tx, id, dto.skillIds);
        }

        const full = await tx.agent.findUnique({
          where: { id },
          include: AGENT_INCLUDE,
        });
        return this.toAgentDto(full!);
      });
    } catch (e) {
      this.throwOnAgentKeyConflict(e);
      throw e;
    }
  }

  /**
   * DELETE /agents/:id：type=template → 403 PERMISSION_AGENT_READONLY；
   * clone/custom → 事务删除 agent_skills + agent 本体。
   */
  async remove(id: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      this.throwNotFound(id);
    }
    this.assertWritable(agent.type);

    return this.prisma.$transaction(async (tx) => {
      await tx.agentSkill.deleteMany({ where: { agentId: id } });
      await tx.agent.delete({ where: { id } });
    });
  }

  /**
   * GET /agents/:id/available-models：模型列表（FR-47，C3 目录化）。
   * 三路径（Metis P1-2 优先级写死）：
   *   1. 目录优先——models 表 enabled=true（无在线 worker 也可查）；
   *   2. pull 兜底——目录为空且 worker 在线 → WorkerClient.listModels（T11 原逻辑）；
   *   3. STATIC fallback——两者皆空 → STATIC_AVAILABLE_MODELS 并标记 source: 'fallback'。
   * 正常路径返回纯数组 [{id, name}]（前端 agents/page.tsx:1565-1574 双形态兼容）。
   */
  async getAvailableModels(_id: string): Promise<AvailableModelsResult> {
    const catalog = await this.modelsService.listCatalogModels();
    if (catalog.length > 0) {
      return catalog;
    }
    try {
      const workerId = await this.workersService.assignWorker();
      if (!workerId) return this.fallbackModels();
      // 必须带 capabilities 才能解析到 worker 的 serve 基址，否则回退
      // WORKER_BASE_URL（localhost）在跨容器部署下必然失败并静默降级。
      const worker = await this.prisma.worker.findUnique({
        where: { id: workerId },
        select: { id: true, capabilities: true },
      });
      const models = await this.workerClient.listModels(
        worker ?? { id: workerId },
      );
      if (models.length === 0) return this.fallbackModels();
      return models.map((m) => ({ id: m.id, name: m.name }));
    } catch {
      return this.fallbackModels();
    }
  }

  /** 降级路径：静态列表 + source 标记（正常动态路径返回纯数组保持前端契约）。 */
  private fallbackModels(): FallbackModelsResult {
    return { models: STATIC_AVAILABLE_MODELS, source: 'fallback' };
  }

  private async toAgentDto(agent: AgentRow): Promise<{
    id: string;
    name: string;
    /** 透传 `agentKey`（机器键，对齐 `AgentRole.key`；不参与能力解析）。 */
    role: string | null;
    agentKey: string | null;
    type: string;
    prompt: string;
    baseAgentId: string | null;
    defaultModelId: string | null;
    persona: string | null;
    policyId: string | null;
    skillIds: string[];
    effectivePermission: ResolvedExecutionPolicy | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    const [effectivePermission] =
      await this.executionPolicyService.resolveManyByAgents([
        {
          policyId: agent.policyId,
          agentKey: agent.agentKey,
        },
      ]);
    return {
      id: agent.id,
      name: agent.name,
      role: agent.agentKey,
      agentKey: agent.agentKey,
      type: agent.type,
      prompt: agent.prompt,
      baseAgentId: agent.baseAgentId,
      defaultModelId: agent.defaultModelId,
      persona: agent.persona,
      policyId: agent.policyId,
      skillIds: agent.skills.map((s) => s.skillId),
      effectivePermission,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  }

  private async toAgentDtoList(rows: AgentRow[]) {
    const permissions = await this.executionPolicyService.resolveManyByAgents(
      rows.map((agent) => ({
        policyId: agent.policyId,
        agentKey: agent.agentKey,
      })),
    );
    return rows.map((agent, i) => ({
      id: agent.id,
      name: agent.name,
      role: agent.agentKey,
      agentKey: agent.agentKey,
      type: agent.type,
      prompt: agent.prompt,
      baseAgentId: agent.baseAgentId,
      defaultModelId: agent.defaultModelId,
      persona: agent.persona,
      policyId: agent.policyId,
      skillIds: agent.skills.map((s) => s.skillId),
      effectivePermission: permissions[i],
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    }));
  }

  /** PATCH 语义：清空 agent_skills 后按新列表重建（skillIds 未传时调用方不触发）。 */
  private async replaceSkills(
    tx: Prisma.TransactionClient,
    agentId: string,
    skillIds: string[],
  ): Promise<void> {
    await tx.agentSkill.deleteMany({ where: { agentId } });
    await this.createSkills(tx, agentId, skillIds);
  }

  /** 批量写入 agent_skills（去重，@@unique([agentId, skillId]) 防冲突）。 */
  private async createSkills(
    tx: Prisma.TransactionClient,
    agentId: string,
    skillIds: string[] | undefined,
  ): Promise<{ skillId: string }[]> {
    const skills: { skillId: string }[] = [];
    if (skillIds) {
      for (const skillId of [...new Set(skillIds)]) {
        await tx.agentSkill.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.agentSkill),
            agentId,
            skillId,
          },
        });
        skills.push({ skillId });
      }
    }
    return skills;
  }

  /** 克隆时复制源 skills（不重建，源保持只读语义）。 */
  private async copySkills(
    tx: Prisma.TransactionClient,
    source: AgentRow,
    cloneId: string,
  ): Promise<void> {
    for (const s of source.skills) {
      await tx.agentSkill.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.agentSkill),
          agentId: cloneId,
          skillId: s.skillId,
        },
      });
    }
  }

  /**
   * 新建可编辑 custom 策略（clone/create 装配用，不暴露 HTTP 端点）。
   * config 恒深拷贝（JSON 回环），两行永不共享同一对象引用；
   * name 取 `${agentName} 策略` 以便识别归属。
   */
  private async provisionCustomPolicy(
    tx: Prisma.TransactionClient,
    opts: {
      agentName: string;
      config: unknown;
      description: string | null;
    },
  ): Promise<string> {
    const policy = await tx.executionPolicy.create({
      data: {
        id: await this.idGen.nextId(POLICY_ID_PREFIX),
        name: `${opts.agentName} 策略`,
        description: opts.description,
        type: 'custom',
        config: JSON.parse(
          JSON.stringify(opts.config),
        ) as Prisma.InputJsonValue,
      },
    });
    return policy.id;
  }

  /**
   * 起始能力模板解析（create 无 policyId / clone 源无绑定时回退）——PATH 2。
   *
   * `AgentRole` 不携带任何能力字段，故岗位只作**选择器**：取其 `defaultAgentId`
   * 指向的 Agent，读该 Agent 的 `policyId`，返回其策略 config（行存在，用户编辑后的
   * 版本即模板）；行缺失但该 Agent 的 `agentKey` 命中内置角色常量时，经
   * `resolveConstantPolicySource('vteam-<agentKey>')` 派生同形 config（与
   * `resolveByAgent` 的行缺失回退共用同一常量推导，避免两处漂移）。
   *
   * 返回 null 的四种情形（调用方建 deny-by-default 骨架，PATH 3）：
   * 未传 `agentRoleId` / 岗位不存在 / 岗位无 `defaultAgentId` / 默认 Agent 无 `policyId`
   * 且 agentKey 非内置名。岗位**不会**在执行期持续绑定：本结果只在装配时深拷贝一次。
   */
  private async resolveTemplateSource(
    tx: Prisma.TransactionClient,
    opts: { agentRoleId: string | null },
  ): Promise<{ config: unknown; description: string | null } | null> {
    const agentRoleId = opts.agentRoleId;
    if (!agentRoleId) {
      return null;
    }
    const role = await tx.agentRole.findUnique({
      where: { id: agentRoleId },
      select: { defaultAgentId: true },
    });
    if (!role?.defaultAgentId) {
      return null;
    }
    const defaultAgent = await tx.agent.findUnique({
      where: { id: role.defaultAgentId },
      select: { policyId: true, agentKey: true },
    });
    if (!defaultAgent) {
      return null;
    }
    if (defaultAgent.policyId) {
      const stored = await tx.executionPolicy.findUnique({
        where: { id: defaultAgent.policyId },
      });
      if (stored) {
        return {
          config: stored.config as unknown,
          description:
            typeof stored.description === 'string' ? stored.description : null,
        };
      }
    }
    const constant = defaultAgent.agentKey
      ? resolveConstantPolicySource(`vteam-${defaultAgent.agentKey}`)
      : null;
    return constant
      ? { config: constant.config, description: constant.description }
      : null;
  }

  /**
   * 未配置 agent 的 deny-by-default 骨架 config（PATH 3：无显式 policyId 且岗位模板
   * 不可用时）的安全默认：不写文件、bash 禁用、tools 空矩阵（协作工具默认拒绝）。
   * 出厂值自 agent-native-permission-editor 起冻结，本 todo 不改动。
   */
  private buildSkeletonConfig(agentName: string): {
    permission: Record<string, unknown>;
    correction: Record<string, unknown>;
    tools: Record<string, never>;
  } {
    return {
      permission: {
        edit: { '*': 'deny' },
        read: { '*': 'allow' },
        bash: 'deny',
        task: 'deny',
      },
      correction: {
        scopeSummary: agentName,
        handoff: {},
        denyTemplate: ROLE_POLICY_DENY_TEMPLATE,
      },
      tools: {},
    };
  }

  /**
   * 删除只读校验（is_0000000030）：type=template 不可删除（销毁性操作不在"设置修改"范围，
   * 内置 agent 仍只读保护）。update 已放开设置修改，不再走本校验。
   */
  private assertWritable(type: string): void {
    if (type === 'template') {
      throw new ForbiddenException({
        code: AGENT_ERRORS.AGENT_READONLY,
        message: '模板 Agent 不可删除，请先克隆副本再操作',
      });
    }
  }

  /** 404：AGENT_NOT_FOUND（AGENT_ERRORS，值跨域一致）。 */
  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: AGENT_ERRORS.AGENT_NOT_FOUND,
      message: `Agent ${id} 不存在`,
    });
  }

  private assertValidAgentKey(agentKey: unknown): asserts agentKey is string {
    if (typeof agentKey !== 'string' || agentKey.length === 0) {
      throw new BadRequestException({
        code: AGENT_KEY_INVALID,
        message: 'agentKey 必填：自定义/克隆 Agent 须提供 machine-safe 标识',
      });
    }
    if (!new RegExp(AGENT_KEY_PATTERN).test(agentKey)) {
      throw new BadRequestException({
        code: AGENT_KEY_INVALID,
        message: `agentKey 格式非法：需匹配 ${AGENT_KEY_PATTERN}（小写字母开头，仅含小写字母/数字/_/-，最长 63 字符）`,
      });
    }
    if (agentKey.startsWith('vteam-')) {
      throw new BadRequestException({
        code: AGENT_KEY_INVALID,
        message:
          'agentKey 不能以 `vteam-` 开头，否则 opencode agent 名会变成 `vteam-vteam-<key>`',
      });
    }
  }

  private throwOnAgentKeyConflict(e: unknown): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      throw new ConflictException({
        code: AGENT_KEY_CONFLICT,
        message: 'agentKey 已被占用，请换一个 machine-safe 标识',
      });
    }
  }

  private normalizePageSize(pageSize?: number): number {
    return normalizePageSize(pageSize);
  }
}
