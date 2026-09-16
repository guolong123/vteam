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
  buildEditPermission,
  buildReadPermission,
  POLICY_ID_PREFIX,
  ROLE_BOUNDARIES,
  ROLE_POLICY_DENY_TEMPLATE,
  STATIC_AVAILABLE_MODELS,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { ModelsService } from '../models/models.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient, WorkerAgentInfo } from '../workers/worker.client';
import { WorkersService } from '../workers/workers.service';
import { CloneAgentDto } from './dto/clone-agent.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import { QueryAgentsDto } from './dto/query-agents.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import {
  ExecutionPolicyService,
  ResolvedExecutionPolicy,
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

/** Agent 行（含关联，toAgentDto 输入）。 */
type AgentRow = {
  id: string;
  name: string;
  role: string | null;
  agentKey: string | null;
  type: string;
  prompt: string;
  baseAgentId: string | null;
  defaultModelId: string | null;
  persona: string | null;
  workerId: string | null;
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
 * opencode 原生 agent 列表返回（GET /agents/opencode）。
 * degraded=true 表示未能取到真实清单（无在线 worker / worker 离线 / 旧版无端点），
 * agents 为空数组——前端据此提示"暂不可用"而非展示空列表误导用户。
 */
export interface OpencodeAgentsResult {
  agents: WorkerAgentInfo[];
  /** 实际取数的 worker id；降级且未选出 worker 时为 null。 */
  workerId: string | null;
  degraded: boolean;
}

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
   * 策略装配（custom agent 必有可编辑 custom 策略）：
   * - 显式 `dto.policyId` → 原样绑定，不建策略；
   * - 无 policyId + `dto.role` 命中模板策略（`ep_<role>`）→ 深拷贝为新 custom 策略并绑定；
   * - 无 policyId + 无命中 → 建 deny-by-default 骨架 custom 策略并绑定。
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
          const source = await this.resolveTemplateSource(tx, dto.role ?? null);
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
            role: dto.role ?? null,
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
   * 均不共享可写策略；源无策略时回退模板/骨架），写操作全在同事务内；
   * effectivePermission 在提交后解析（理由同 create）。
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
          : await this.resolveTemplateSource(tx, source.role);
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
            role: source.role,
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
   * - template（内置）允许修改全部**设置字段**（name/role/prompt/defaultModelId/
   *   workerId/policyId + skillIds 关联重建），
   *   使内置 agent 可自定义配置；agentId/type 不可改（不在 DTO，天然安全红线）；
   * - clone/custom → 同规则更新；
   * - 删除（remove）仍对 template 403（销毁性操作不在"设置修改"范围）。
   * skillIds 显式传入时重建关联（不传保持原关联）。
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
            ...(dto.role !== undefined ? { role: dto.role } : {}),
            ...(dto.agentKey !== undefined ? { agentKey: dto.agentKey } : {}),
            ...(dto.prompt !== undefined ? { prompt: dto.prompt } : {}),
            ...(dto.defaultModelId !== undefined
              ? { defaultModelId: dto.defaultModelId }
              : {}),
            ...(dto.persona !== undefined
              ? { persona: dto.persona ?? null }
              : {}),
            ...(dto.workerId !== undefined ? { workerId: dto.workerId } : {}),
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
      // 同 listOpencodeAgents：必须带 capabilities 才能解析到 worker 的 serve 基址，
      // 否则回退 WORKER_BASE_URL（localhost）在跨容器部署下必然失败并静默降级。
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

  /**
   * GET /agents/omo-config：读取 OmO 的 agent→模型配置（+ 可配置 agent 清单）。
   *
   * 数据源是 worker 侧 `<workDir>/.opencode/oh-my-openagent.jsonc`（OmO 按 cwd 读取的
   * 项目级配置）。vteam 不落库、不缓存——配置文件即真相，配置页只是它的编辑器。
   *
   * workerId 显式传入则用之；缺省经 assignWorker 选一个可用 worker。
   * 任一失败（无在线 worker / 离线 / 旧版无端点）→ `degraded:true`，不抛错。
   */
  async getOmoConfig(opts: { workerId?: string } = {}): Promise<{
    agents: Record<string, string>;
    available: string[];
    workerId: string | null;
    /** 实际生效的配置文件（相对 workDir）+ 命中位置。 */
    configPath?: string;
    configKind?: 'new' | 'legacy' | 'none';
    /** 用户开关：是否加载 OmO 插件（本镜像未内置时无意义）。 */
    enabled?: boolean;
    /** 本镜像是否内置 OmO；false → 前端不展示该区块。 */
    bundled?: boolean;
    /** 已注册到 serve 的 agent 基底名 + 元数据（描述/mode）。 */
    registered?: string[];
    runtime?: Record<
      string,
      { description?: string; mode?: string; native?: boolean }
    >;
    degraded: boolean;
  }> {
    try {
      const workerId =
        opts.workerId ?? (await this.workersService.assignWorker());
      if (!workerId) {
        return { agents: {}, available: [], workerId: null, degraded: true };
      }
      // ⚠️ 必须带 capabilities：exec baseUrl 从 capabilities 解析，只传 { id } 会回退
      // localhost 并在跨容器部署下静默降级（listOpencodeAgents 同类踩坑）。
      const worker = await this.prisma.worker.findUnique({
        where: { id: workerId },
        select: { id: true, capabilities: true },
      });
      const result = await this.workerClient.getOmoConfig(
        worker ?? { id: workerId },
      );
      return { ...result, workerId };
    } catch {
      return { agents: {}, available: [], workerId: null, degraded: true };
    }
  }

  /**
   * 写入 OmO 的 agent→模型配置（增量合并）。
   * 写路径：定位失败/worker 不可达一律抛错（用户需要明确的成败反馈）。
   */
  async setOmoConfig(
    agents: Record<string, string>,
    opts: { workerId?: string; enabled?: boolean } = {},
  ): Promise<{
    written: string;
    agents: Record<string, string>;
    workerId: string;
    configPath?: string;
    configKind?: 'new' | 'legacy' | 'none';
    enabled?: boolean;
    bundled?: boolean;
    /** serve 重启结果（配置需重启才生效）：executed / pending / skipped。 */
    restart?: 'executed' | 'pending' | 'skipped';
  }> {
    const workerId =
      opts.workerId ?? (await this.workersService.assignWorker());
    if (!workerId) {
      throw new ServiceUnavailableException(
        '未定位到可用的 worker（无在线 worker 节点）',
      );
    }
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: { id: true, capabilities: true },
    });
    if (!worker) {
      throw new ServiceUnavailableException('指定的 worker 不存在');
    }
    const result = await this.workerClient.setOmoConfig(
      worker,
      agents,
      opts.enabled,
    );
    return { ...result, workerId };
  }

  /**
   * 取单个 OmO agent 的系统提示词全文（配置页"查看提示词"弹窗的数据源）。
   * 按需拉取：prompt 体积大（合计约 106KB），不随列表下发。
   */
  async getOmoAgentPrompt(
    name: string,
    opts: { workerId?: string } = {},
  ): Promise<{
    name: string;
    description: string;
    mode?: string;
    prompt: string;
    empty: boolean;
  }> {
    const workerId =
      opts.workerId ?? (await this.workersService.assignWorker());
    if (!workerId) {
      throw new ServiceUnavailableException(
        '未定位到可用的 worker（无在线 worker 节点）',
      );
    }
    // 必须带 capabilities：exec baseUrl 由它解析（同类踩坑见 listOpencodeAgents）
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: { id: true, capabilities: true },
    });
    if (!worker) {
      throw new ServiceUnavailableException('指定的 worker 不存在');
    }
    return this.workerClient.getOmoAgentPrompt(worker, name);
  }

  /**
   * GET /agents/opencode：列出 opencode 原生 agent（vteam 同步/展示/切换的数据源）。
   *
   * 数据来自 worker 执行端点 `GET /agents`（→ opencode serve `GET /agent`），非硬编码：
   * vteam 只做「同步 + 展示 + 切换」，agent 的 prompt/permission 语义完全由 opencode 侧
   * 定义并强制执行（如内置 plan agent 的 edit/bash 受限）。
   *
   * - `directory` 必须与执行期 prompt_async 的 directory 同值：serve 按目录发现
   *   `opencode.json` 的 agent 节（per-directory 隔离，不需要重启 serve）。
   * - workerId 显式传入则用之；缺省经 assignWorker 选一个可用 worker。
   * - 任一失败（无在线 worker / worker 离线 / 旧版无该端点）→ `{agents: [], degraded: true}`，
   *   不抛错（列表类端点不阻断页面，对齐 getAvailableModels 的降级哲学）。
   */
  async listOpencodeAgents(opts: {
    workerId?: string;
    directory?: string;
  }): Promise<OpencodeAgentsResult> {
    try {
      const workerId =
        opts.workerId ?? (await this.workersService.assignWorker());
      if (!workerId) {
        return { agents: [], workerId: null, degraded: true };
      }
      // ⚠️ 必须查 worker 行取 capabilities 再传入：exec 端点 baseUrl 从
      // capabilities.execBaseUrl（或 capabilities.baseUrl + execPort）解析；只传 { id }
      // 会回退到 WORKER_BASE_URL（默认 localhost:4199）——server 与 worker 分处不同容器
      // 时必然连不上，而 listAgents 的降级 catch 会静默返回 []，症状只是 degraded=true，
      // 极难定位（本地部署实测踩坑）。
      const worker = await this.prisma.worker.findUnique({
        where: { id: workerId },
        select: { id: true, capabilities: true },
      });
      const agents = await this.workerClient.listAgents(
        worker ?? { id: workerId },
        opts.directory,
      );
      if (agents.length === 0) {
        return { agents: [], workerId, degraded: true };
      }
      return { agents, workerId, degraded: false };
    } catch {
      return { agents: [], workerId: null, degraded: true };
    }
  }

  /** 降级路径：静态列表 + source 标记（正常动态路径返回纯数组保持前端契约）。 */
  private fallbackModels(): FallbackModelsResult {
    return { models: STATIC_AVAILABLE_MODELS, source: 'fallback' };
  }

  private async toAgentDto(agent: AgentRow): Promise<{
    id: string;
    name: string;
    role: string | null;
    agentKey: string | null;
    type: string;
    prompt: string;
    baseAgentId: string | null;
    defaultModelId: string | null;
    persona: string | null;
    workerId: string | null;
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
          role: agent.role,
          agentKey: agent.agentKey,
        },
      ]);
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      agentKey: agent.agentKey,
      type: agent.type,
      prompt: agent.prompt,
      baseAgentId: agent.baseAgentId,
      defaultModelId: agent.defaultModelId,
      persona: agent.persona,
      workerId: agent.workerId,
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
        role: agent.role,
        agentKey: agent.agentKey,
      })),
    );
    return rows.map((agent, i) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      agentKey: agent.agentKey,
      type: agent.type,
      prompt: agent.prompt,
      baseAgentId: agent.baseAgentId,
      defaultModelId: agent.defaultModelId,
      persona: agent.persona,
      workerId: agent.workerId,
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
   * 按 role 解析模板策略来源（create 无 policyId / clone 源无绑定时回退）。
   * 优先库内 `ep_<role>` 行的 config（seed 已含 tools 矩阵）；行缺失但 role 命中
   * `ROLE_BOUNDARIES` 时按同一形状派生（与 seed 同源，保证 tools 非空）；
   * 均无 → null（调用方建骨架）。
   */
  private async resolveTemplateSource(
    tx: Prisma.TransactionClient,
    role: string | null,
  ): Promise<{ config: unknown; description: string | null } | null> {
    if (!role) {
      return null;
    }
    const stored = await tx.executionPolicy.findUnique({
      where: { id: `ep_${role}` },
    });
    if (stored) {
      return {
        config: stored.config as unknown,
        description:
          typeof stored.description === 'string' ? stored.description : null,
      };
    }
    const agentName = `vteam-${role}` as VteamAgentName;
    const boundary = (
      ROLE_BOUNDARIES as Record<
        string,
        (typeof ROLE_BOUNDARIES)[VteamAgentName] | undefined
      >
    )[agentName];
    if (!boundary) {
      return null;
    }
    return {
      config: {
        permission: {
          edit: buildEditPermission(boundary.writeGlobs),
          read: buildReadPermission(),
          bash: boundary.bashEffect,
          task: 'deny',
          ...Object.fromEntries(
            boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
          ),
        },
        correction: {
          scopeSummary: boundary.scopeSummary,
          handoff: boundary.handoffTo,
          denyTemplate: ROLE_POLICY_DENY_TEMPLATE,
        },
        tools: { ...boundary.toolAllows },
      },
      description: boundary.scopeSummary,
    };
  }

  /**
   * 未配置 agent 的 deny-by-default 骨架 config（无命中 role 时的安全默认）：
   * 不写文件、bash 禁用、tools 空矩阵（协作工具默认拒绝）。
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
