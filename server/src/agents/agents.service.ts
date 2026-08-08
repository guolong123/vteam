import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AGENT_ERRORS,
  STATIC_AVAILABLE_MODELS,
} from '../common/constants/agent.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient } from '../workers/worker.client';
import { WorkersService } from '../workers/workers.service';
import { CloneAgentDto } from './dto/clone-agent.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import { QueryAgentsDto } from './dto/query-agents.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

/** Agent 域主键前缀（对齐 15 篇 §2.2：<prefix>_<零填充序号>）。 */
const ID_PREFIX = {
  agent: 'a',
  agentSkill: 'as',
  agentToolEffect: 'ate',
} as const;

/** 列表/详情共用的关联 include（agent_skills → skillId 数组、agent_tool_effects）。 */
const AGENT_INCLUDE = {
  skills: true,
  toolEffects: true,
} as const;

/** Agent 行（含关联，toAgentDto 输入）。 */
type AgentRow = {
  id: string;
  name: string;
  role: string | null;
  type: string;
  prompt: string;
  baseAgentId: string | null;
  defaultModelId: string | null;
  permissionScope: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  skills: { skillId: string }[];
  toolEffects: { toolAction: string; effect: string }[];
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
 * - create：custom 三表事务（Agent + agent_skills + agent_tool_effects）
 * - clone：深拷贝副本（baseAgentId 血缘指向源，同事务复制三表，不改源）
 * - update/remove：type=template → 403 PERMISSION_AGENT_READONLY；clone/custom 可写
 * - available-models：T11 起动态（WorkerClient.listModels），失败降级 STATIC_AVAILABLE_MODELS
 */
@Injectable()
export class AgentsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly workersService: WorkersService,
    private readonly workerClient: WorkerClient,
  ) {}

  /** 进程启动对齐 agent 域前缀序号（重启续号，对齐 tasks.seedPrefix 模式）。 */
  async onModuleInit(): Promise<void> {
    await this.seedPrefix(ID_PREFIX.agent, this.prisma.agent);
    await this.seedPrefix(ID_PREFIX.agentSkill, this.prisma.agentSkill);
    await this.seedPrefix(ID_PREFIX.agentToolEffect, this.prisma.agentToolEffect);
  }

  /**
   * GET /agents：type 过滤 + 分页（对齐 projects 的 {items, total, page, pageSize}）。
   * type 缺省返回全部类型（含 custom）；分页 page 从 1 起、pageSize 默认 20 上限 100。
   */
  async findAll(query: QueryAgentsDto = {}) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where = { type: query.type ? { equals: query.type } : undefined };

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

    const items = rows.map((agent) => this.toAgentDto(agent));

    return { items, total, page, pageSize };
  }

  /**
   * GET /agents/:id：详情（含 skills/toolEffects 完整关联）。
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
   * 三表事务：Agent（type=custom、baseAgentId=null、createdBy=当前用户）
   * + agent_skills 批量 + agent_tool_effects 批量，返回 toAgentDto 格式。
   */
  async create(userId: string, dto: CreateAgentDto) {
    return this.prisma.$transaction(async (tx) => {
      const agent = await tx.agent.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.agent),
          name: dto.name.trim(),
          type: dto.type,
          role: dto.role ?? null,
          prompt: dto.prompt ?? '',
          baseAgentId: null,
          defaultModelId: dto.defaultModelId ?? null,
          permissionScope: dto.permissionScope
            ? (dto.permissionScope as Prisma.InputJsonValue)
            : undefined,
          createdBy: userId,
        },
      });

      const skills = await this.createAssociations(
        tx,
        agent.id,
        dto.skillIds,
        dto.toolEffects,
      );

      return this.toAgentDto({ ...agent, ...skills });
    });
  }

  /**
   * POST /agents/:id/clone：深拷贝副本（FR-31）。
   * 源不存在 → 404；新行 type=clone、baseAgentId=源.id、name=请求名或「源名副本」；
   * 同事务复制三表（不含会话/任务关系），克隆不触碰源行。
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

    return this.prisma.$transaction(async (tx) => {
      const clone = await tx.agent.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.agent),
          name: newName,
          type: 'clone',
          baseAgentId: source.id,
          role: source.role,
          prompt: source.prompt,
          defaultModelId: source.defaultModelId,
          permissionScope: source.permissionScope as Prisma.InputJsonValue | undefined,
          createdBy: userId,
        },
      });

      await this.copyAssociations(tx, source, clone.id);

      return this.toAgentDto({
        ...clone,
        skills: source.skills.map((s) => ({ skillId: s.skillId })),
        toolEffects: source.toolEffects.map((t) => ({
          toolAction: t.toolAction,
          effect: t.effect,
        })),
      });
    });
  }

  /**
   * PATCH /agents/:id：type=template → 403 PERMISSION_AGENT_READONLY（14 篇 §2.2 第 4 条）；
   * 唯一例外：template 允许更新 defaultModelId（模型属部署环境适配，非角色定义，2026-08 决策）；
   * clone/custom → 更新标量字段（name/prompt/role/defaultModelId/permissionScope）
   * + skillIds/toolEffects 各自显式传入时单独重建对应关联（不传的一侧保持原关联，避免半更新清空另一张表）。
   */
  async update(id: string, dto: UpdateAgentDto) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      this.throwNotFound(id);
    }
    this.assertWritable(agent.type, dto);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.agent.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.role !== undefined ? { role: dto.role } : {}),
          ...(dto.prompt !== undefined ? { prompt: dto.prompt } : {}),
          ...(dto.defaultModelId !== undefined
            ? { defaultModelId: dto.defaultModelId }
            : {}),
          ...(dto.permissionScope !== undefined
            ? { permissionScope: dto.permissionScope as Prisma.InputJsonValue }
            : {}),
        },
      });

      if (dto.skillIds !== undefined) {
        await this.replaceSkills(tx, id, dto.skillIds);
      }
      if (dto.toolEffects !== undefined) {
        await this.replaceToolEffects(tx, id, dto.toolEffects);
      }

      const full = await tx.agent.findUnique({
        where: { id },
        include: AGENT_INCLUDE,
      });
      return this.toAgentDto(full!);
    });
  }

  /**
   * DELETE /agents/:id：type=template → 403 PERMISSION_AGENT_READONLY；
   * clone/custom → 事务删除 agent_skills + agent_tool_effects + agent 本体。
   */
  async remove(id: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      this.throwNotFound(id);
    }
    this.assertWritable(agent.type);

    return this.prisma.$transaction(async (tx) => {
      await tx.agentSkill.deleteMany({ where: { agentId: id } });
      await tx.agentToolEffect.deleteMany({ where: { agentId: id } });
      await tx.agent.delete({ where: { id } });
    });
  }

  /**
   * GET /agents/:id/available-models：模型列表（FR-47，T11 动态化）。
   * 经 Scheduler.assignWorker 取一个可用 worker → WorkerClient.listModels 返回 opencode
   * 真实模型（id=`providerID/modelID`，D7）；无 worker / 请求失败 / 空列表 → 降级
   * STATIC_AVAILABLE_MODELS 并标记 `source: 'fallback'`（14 篇 §3.5：worker 离线或换节点
   * 时列表随之变化，静态仅兜底）。
   */
  async getAvailableModels(_id: string): Promise<AvailableModelsResult> {
    try {
      const workerId = await this.workersService.assignWorker();
      if (!workerId) return this.fallbackModels();
      const models = await this.workerClient.listModels({ id: workerId });
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

  /** 行 → DTO：基本字段 + 扩展字段（关联表映射为扁平数组）。 */
  private toAgentDto(agent: AgentRow) {
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      type: agent.type,
      prompt: agent.prompt,
      baseAgentId: agent.baseAgentId,
      defaultModelId: agent.defaultModelId,
      permissionScope: agent.permissionScope,
      skillIds: agent.skills.map((s) => s.skillId),
      toolEffects: agent.toolEffects.map((t) => ({
        toolAction: t.toolAction,
        effect: t.effect,
      })),
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  }

  /**
   * 创建 Agent 关联（agent_skills + agent_tool_effects），仅 create/clone 使用（全量新建）。
   * 返回 {skills, toolEffects} 供 toAgentDto 直接使用（避免事务内二次查询）。
   */
  private async createAssociations(
    tx: Prisma.TransactionClient,
    agentId: string,
    skillIds: string[] | undefined,
    toolEffects: { toolAction: string; effect: string }[] | undefined,
  ): Promise<{ skills: { skillId: string }[]; toolEffects: { toolAction: string; effect: string }[] }> {
    return {
      skills: await this.createSkills(tx, agentId, skillIds),
      toolEffects: await this.createToolEffects(tx, agentId, toolEffects),
    };
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

  /** PATCH 语义：清空 agent_tool_effects 后按新配置重建（toolEffects 未传时调用方不触发）。 */
  private async replaceToolEffects(
    tx: Prisma.TransactionClient,
    agentId: string,
    toolEffects: { toolAction: string; effect: string }[],
  ): Promise<void> {
    await tx.agentToolEffect.deleteMany({ where: { agentId } });
    await this.createToolEffects(tx, agentId, toolEffects);
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

  /** 批量写入 agent_tool_effects（按 toolAction 去重，@@unique([agentId, toolAction]) 防冲突）。 */
  private async createToolEffects(
    tx: Prisma.TransactionClient,
    agentId: string,
    toolEffects: { toolAction: string; effect: string }[] | undefined,
  ): Promise<{ toolAction: string; effect: string }[]> {
    const effects: { toolAction: string; effect: string }[] = [];
    if (toolEffects) {
      const seen = new Set<string>();
      for (const t of toolEffects) {
        if (seen.has(t.toolAction)) continue;
        seen.add(t.toolAction);
        await tx.agentToolEffect.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.agentToolEffect),
            agentId,
            toolAction: t.toolAction,
            effect: t.effect,
          },
        });
        effects.push({ toolAction: t.toolAction, effect: t.effect });
      }
    }
    return effects;
  }

  /** 克隆时复制源关联（不重建，源保持只读语义）。 */
  private async copyAssociations(
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
    for (const t of source.toolEffects) {
      await tx.agentToolEffect.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.agentToolEffect),
          agentId: cloneId,
          toolAction: t.toolAction,
          effect: t.effect,
        },
      });
    }
  }

  /**
   * 模板只读校验：type=template 不可更新/删除（14 篇 §2.2 第 4 条）。
   * 例外：仅含 defaultModelId 的更新放行（模型=部署环境适配；其余字段仍 403）。
   */
  private assertWritable(type: string, dto?: UpdateAgentDto): void {
    if (type === 'template' && !(dto && this.isModelOnlyUpdate(dto))) {
      throw new ForbiddenException({
        code: AGENT_ERRORS.AGENT_READONLY,
        message: '模板 Agent 只读，请先克隆副本再编辑',
      });
    }
  }

  /** template 仅放行 defaultModelId 单字段更新（其余字段任一出现即视为越权）。 */
  private isModelOnlyUpdate(dto: UpdateAgentDto): boolean {
    const fields = [
      dto.name,
      dto.role,
      dto.prompt,
      dto.permissionScope,
      dto.skillIds,
      dto.toolEffects,
    ];
    const hasOtherField = fields.some((f) => f !== undefined);
    return !hasOtherField && dto.defaultModelId !== undefined;
  }

  /** 404：AGENT_NOT_FOUND（AGENT_ERRORS，值跨域一致）。 */
  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: AGENT_ERRORS.AGENT_NOT_FOUND,
      message: `Agent ${id} 不存在`,
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

  /** 对齐某前缀的起始序号（重启续号，last.id 非零填充格式则跳过）。 */
  private async seedPrefix(
    prefix: string,
    model: { findFirst: (args: object) => Promise<{ id: string } | null> },
  ): Promise<void> {
    const last = await model.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (last) {
      const seq = parseInt(last.id.slice(prefix.length + 1), 10);
      if (Number.isFinite(seq)) {
        this.idGen.seed(prefix, seq);
      }
    }
  }
}
