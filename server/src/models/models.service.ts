import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ModelCredential, Prisma } from '@prisma/client';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { WORKER_STATUS } from '../workers/workers.constants';
import { WorkerClient } from '../workers/worker.client';
import { WorkersService } from '../workers/workers.service';
import {
  MODEL_ERRORS,
  MODEL_MODALITIES,
  MODEL_PROVIDER_TYPES,
  ModelCapabilities,
  ModelModality,
  ModelProviderConfigEntry,
  ProviderModelEntry,
} from './models.constants';
import { CreateModelDto } from './dto/create-model.dto';
import { QueryModelsDto } from './dto/query-models.dto';
import { UpdateModelDto } from './dto/update-model.dto';
import { UpdateProviderDto } from './dto/update-provider.dto';

/** 模型目录域主键前缀（C1：`md_<零填充序号>`，如 md_0000000001）。 */
const MODEL_ID_PREFIX = 'md';

/** 模型凭据域主键前缀（15 篇 §2.2：`mc_<零填充序号>`，如 mc_0000000001）。 */
const MODEL_CREDENTIAL_ID_PREFIX = 'mc';

/** C8：端点探测超时 ms（local/custom 端点常在容器网络内，短超时避免拖慢表单）。 */
const PROBE_TIMEOUT_MS = 6000;

/** 凭据对外视图（脱敏：绝不携带 credentialRef 明文，17 篇 §3.4 明文零接触）。 */
export interface ModelCredentialView {
  id: string;
  providerID: string;
  /** 是否已配置凭据（含已吊销——吊销保留 fingerprint 与轨迹）。 */
  configured: boolean;
  /** 脱敏标识（sk-a****89xz）；未配置时为 null。 */
  fingerprint: string | null;
  revokedAt: Date | null;
  createdAt: Date | null;
}

/** Provider 聚合视图（Provider 页数据源）：models 表按 providerID 聚合 + 凭据状态。 */
export interface ProviderSummary {
  providerID: string;
  /** 该 provider 下 enabled 模型数（models 表 groupBy _count）。 */
  modelCount: number;
  /** ModelCredential 表该 provider 存在且未 revoked。 */
  configured: boolean;
  /** 已配置时返回库内脱敏指纹；未配置/已吊销为 null（明文零接触）。 */
  fingerprint: string | null;
  revokedAt: Date | null;
  providerType?: string | null;
  baseUrl?: string | null;
}

/**
 * 模型凭据服务（C4）：provider token 的 AES-256-GCM 加密存储 + 脱敏查询 + 软吊销。
 *
 * - setCredential：按 model 的 providerID upsert（同 provider 重复 POST 覆盖更新，
 *   幂等决策——覆盖更新更实用）；加密只存 credentialRef，不落明文。
 * - getCredential：只返回 {configured, fingerprint, revokedAt}，绝不返回明文 token。
 * - revokeCredential：软撤销（revokedAt 标记，保留审计轨迹；不物理删除）。
 * - onModuleInit：mc_ 前缀续号（复用通用 resyncIdPrefix，对齐 md_ 模式）。
 *
 * 模块 CRUD（模型目录管理）属 C3，本服务当前只承载凭据端点。
 */
@Injectable()
export class ModelsService implements OnModuleInit {
  private readonly logger = new Logger(ModelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly crypto: CredentialCryptoService,
    // C5：凭据保存后触发 worker 下发（forwardRef——WorkersService 亦依赖 CredentialCryptoService）
    @Inject(forwardRef(() => WorkersService))
    private readonly workers: WorkersService,
    private readonly workerClient: WorkerClient,
  ) {}

  /** 进程启动对齐 md_/mc_ 前缀序号（重启续号，md_ 对齐 tools.service onModuleInit 模式）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.model, MODEL_ID_PREFIX, this.idGen);
    await resyncIdPrefix(
      this.prisma.modelCredential,
      MODEL_CREDENTIAL_ID_PREFIX,
      this.idGen,
    );
    await resyncIdPrefix(this.prisma.gitCredential, 'gc', this.idGen);
    await resyncIdPrefix(this.prisma.gitRepoGrant, 'gr', this.idGen);
  }

  // ==================================================================
  // C3 目录 CRUD（模型目录管理）
  // ==================================================================

  /**
   * GET /models：enabled 过滤 + providerID/modelID/name 搜索 + 分页。
   * ⚠️ providerID 精确匹配（根因 1）：contains 模糊匹配会让 `opencode` 误命中
   * `opencode-go`，前端按 provider 解析模型 id 时取到错误 provider 的模型；
   * modelID/name 保留 contains 搜索语义。返回 {items, total, page, pageSize}
   * （对齐 mcp-servers/tools findAll 模式）。
   */
  async findAll(query: QueryModelsDto = {}) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where: Prisma.ModelWhereInput = {
      enabled: query.enabled === undefined ? undefined : query.enabled,
      providerID: query.providerID ? query.providerID : undefined,
      modelID: query.modelID ? { contains: query.modelID } : undefined,
      name: query.name ? { contains: query.name } : undefined,
      providerType: query.providerType ? query.providerType : undefined,
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.model.count({ where }),
      this.prisma.model.findMany({
        where,
        // orderBy 加 id 第二键：同 createdAt 排序稳定（根因 2，前端取首个模型 id 不再漂移）
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { items: rows, total, page, pageSize };
  }

  /** GET /models/:id：详情；不存在 → 404 MODEL_NOT_FOUND。 */
  async findOne(id: string) {
    const row = await this.prisma.model.findUnique({ where: { id } });
    if (!row) {
      this.throwNotFound(id);
    }
    return row;
  }

  /**
   * GET /models/providers：provider 聚合（Provider 页数据源）。
   * - 数据源 1：models 表按 providerID groupBy（enabled 过滤）取 modelCount（一次查询）；
   * - 数据源 2：在线 worker 的 capabilities.models（string[]，id 格式 providerID/modelID）
   *   拆 providerID union 补全——worker 配置凭据后上报的模型含新 provider，Provider 页自动出现
   *   （D5：目录行与 worker 上报可能不同步，如 enabled=false 或尚未合并入库）；
   * - modelCount 合并：目录 count + worker 上报该 provider 的模型数（worker-only provider 也能显示计数）；
   * - ModelCredential 全量按 providerID 建索引取凭据状态（表很小，二次查询内存合并）；
   * - configured = 存在且未 revoked；fingerprint 取库内已脱敏指纹（不回明文）；
   * - 排序：providerID 字典序（简单稳定）。
   */
  async listProviders(): Promise<ProviderSummary[]> {
    const groups = await this.prisma.model.groupBy({
      by: ['providerID'],
      where: { enabled: true },
      _count: { _all: true },
    });
    const credentials = await this.prisma.modelCredential.findMany();
    const credByProvider = new Map(credentials.map((c) => [c.providerID, c]));

    // D5 数据源 2：在线 worker（status != offline）capabilities.models 拆 providerID。
    // modelCount 语义：目录 count 为主，worker 上报的该 provider 模型数累加（重复 id 不去重——
    // 与「可用模型数」展示一致，worker 侧就是各自可用模型集合）。仅当目录无该 provider 时
    // worker 计数也能让 provider 出现在结果中。
    const onlineWorkers = await this.prisma.worker.findMany({
      where: { status: { not: WORKER_STATUS.OFFLINE } },
      select: { capabilities: true },
    });
    const workerCountByProvider = new Map<string, number>();
    for (const w of onlineWorkers) {
      const models = (w.capabilities as { models?: string[] } | null)?.models;
      if (!Array.isArray(models)) {
        continue;
      }
      for (const raw of models) {
        if (!raw || typeof raw !== 'string') {
          continue;
        }
        const { providerID } = this.splitModelId(raw);
        workerCountByProvider.set(
          providerID,
          (workerCountByProvider.get(providerID) ?? 0) + 1,
        );
      }
    }

    // 元数据查询刻意不过滤 enabled：即使该 provider 全部目录行被停用，Provider 页仍需
    // 回显 providerType/baseUrl（Edit 弹窗不能空 URL）——modelCount 的 enabled 语义只由
    // 上面的 groupBy 承担，两者互不影响。
    const providerMetaRowsRaw = (await this.prisma.model.findMany({
      select: { providerID: true, providerType: true, baseUrl: true },
    } as never)) as unknown;
    const providerMetaRows = Array.isArray(providerMetaRowsRaw)
      ? (providerMetaRowsRaw as {
          providerID: string;
          providerType?: string;
          baseUrl?: string | null;
        }[])
      : [];
    const metaByProvider = new Map<
      string,
      { providerType: string; baseUrl: string | null }
    >();
    for (const r of providerMetaRows) {
      if (!metaByProvider.has(r.providerID)) {
        metaByProvider.set(r.providerID, {
          providerType: r.providerType ?? 'cloud',
          baseUrl: r.baseUrl ?? null,
        });
      }
    }
    const providerIds = new Set<string>([
      ...groups.map((g) => g.providerID),
      ...workerCountByProvider.keys(),
    ]);
    return [...providerIds]
      .map((providerID) => {
        const cred = credByProvider.get(providerID);
        const configured = !!cred && cred.revokedAt === null;
        const catalogCount =
          groups.find((g) => g.providerID === providerID)?._count._all ?? 0;
        const workerCount = workerCountByProvider.get(providerID) ?? 0;
        const meta = metaByProvider.get(providerID);
        return {
          providerID,
          modelCount: Math.max(catalogCount, workerCount),
          configured,
          fingerprint: configured ? (cred?.fingerprint ?? null) : null,
          revokedAt: cred?.revokedAt ?? null,
          providerType: meta?.providerType ?? 'cloud',
          baseUrl: meta?.baseUrl ?? null,
        };
      })
      .sort((a, b) => a.providerID.localeCompare(b.providerID));
  }

  /**
   * POST /models：创建目录条目。
   * providerID+modelID 撞 @@unique → 409 MODEL_EXISTS（先查后抛，对齐 mcp-servers assertNameAvailable）。
   */
  async create(dto: CreateModelDto) {
    await this.assertProviderModelAvailable(
      dto.providerID.trim(),
      dto.modelID.trim(),
    );
    const providerType = dto.providerType
      ? this.normalizeProviderType(dto.providerType)
      : undefined;
    const effectiveProviderType = providerType ?? 'cloud';
    const baseUrl = this.normalizeBaseUrl(dto.baseUrl, effectiveProviderType);
    await this.assertBaseUrlConsistent(dto.providerID.trim(), baseUrl);
    const row = await this.prisma.model.create({
      data: {
        id: await this.idGen.nextId(MODEL_ID_PREFIX),
        providerID: dto.providerID.trim(),
        modelID: dto.modelID.trim(),
        name: dto.name.trim(),
        capabilities: dto.capabilities as Prisma.InputJsonValue | undefined,
        enabled: dto.enabled ?? true,
        ...(providerType ? { providerType } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      },
    });
    // C6：带 baseUrl 的新模型且该 provider 已有活跃凭据 → 下发全量配置
    // （models map 立即含新模型，worker 重启后生效）；尚无凭据时不下发
    // （worker 无 key 该 provider 本不可用，首次配凭据的下发自然携带配置）
    if (baseUrl) {
      await this.maybeDispatchAfterShapeChange(dto.providerID.trim());
    }
    return row;
  }

  /**
   * C6：provider 形态变化（create/update 的 providerID/modelID/providerType/
   * baseUrl）后的下发门控——仅当该 provider 存在未吊销凭据时下发全量状态
   * （避免无凭据 provider 的无谓广播；首次配凭据的下发自然携带最新配置）。
   */
  private async maybeDispatchAfterShapeChange(
    providerID: string,
  ): Promise<void> {
    const credential = await this.prisma.modelCredential.findUnique({
      where: { providerID },
      select: { revokedAt: true },
    });
    if (credential && credential.revokedAt === null) {
      await this.dispatchCredentialState();
    }
  }

  /**
   * PATCH /models/:id：部分更新（编辑/启停）。
   * 不存在 → 404；改 providerID/modelID 撞唯一 → 409（排除自身）。
   */
  async update(id: string, dto: UpdateModelDto) {
    const existing = await this.prisma.model.findUnique({ where: { id } });
    if (!existing) {
      this.throwNotFound(id);
    }
    const effectiveProvider =
      dto.providerID !== undefined
        ? dto.providerID.trim()
        : existing.providerID;
    const effectiveModel =
      dto.modelID !== undefined ? dto.modelID.trim() : existing.modelID;
    if (
      effectiveProvider !== existing.providerID ||
      effectiveModel !== existing.modelID
    ) {
      await this.assertProviderModelAvailable(
        effectiveProvider,
        effectiveModel,
        id,
      );
    }
    const effectiveProviderType =
      dto.providerType !== undefined
        ? this.normalizeProviderType(dto.providerType)
        : ((existing as { providerType?: string }).providerType ?? 'cloud');
    const effectiveBaseUrlRaw =
      dto.baseUrl !== undefined
        ? dto.baseUrl
        : ((existing as { baseUrl?: string | null }).baseUrl ?? null);
    const effectiveBaseUrl = this.normalizeBaseUrl(
      effectiveBaseUrlRaw as string | undefined,
      effectiveProviderType,
    );
    if (
      dto.providerType !== undefined ||
      dto.baseUrl !== undefined ||
      dto.providerID !== undefined
    ) {
      await this.assertBaseUrlConsistent(
        effectiveProvider,
        effectiveBaseUrl,
        id,
      );
    }

    const row = await this.prisma.model.update({
      where: { id },
      data: {
        ...(dto.providerID !== undefined
          ? { providerID: dto.providerID.trim() }
          : {}),
        ...(dto.modelID !== undefined ? { modelID: dto.modelID.trim() } : {}),
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.capabilities !== undefined
          ? { capabilities: dto.capabilities as Prisma.InputJsonValue }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.providerType !== undefined
          ? { providerType: effectiveProviderType }
          : {}),
        ...(dto.baseUrl !== undefined ? { baseUrl: effectiveBaseUrl } : {}),
      },
    });
    // C6/C8：provider 形态字段（providerID/modelID/providerType/baseUrl）或
    // per-model 能力（capabilities）变化 → 门控下发
    // （见 maybeDispatchAfterShapeChange；baseUrl 改错路径、上下文长度等配置在此收敛）
    const shapeChanged =
      dto.providerID !== undefined ||
      dto.modelID !== undefined ||
      dto.providerType !== undefined ||
      dto.baseUrl !== undefined ||
      dto.capabilities !== undefined;
    if (shapeChanged && effectiveBaseUrl) {
      await this.maybeDispatchAfterShapeChange(effectiveProvider);
    }
    return row;
  }

  /**
   * C8：探测 OpenAI 兼容端点的模型元数据（自动预填上下文长度）。
   * `GET {baseUrl}/models` 的 vLLM 扩展字段 `max_model_len` 即上下文窗口 token 数
   * （实测 192.168.10.10:18020/v1 → qwen3.8-27b max_model_len=262144，与手写
   * `limit.context` 一致），OpenAI 官方端点无此字段 → 返回空列表（前端不预填）。
   * 为什么放 server 而非 worker：server 直接可达（实测 163ms），同步返回即可，
   * 免去命令往返与等待；探测失败不抛错——返回空结果，由前端提示手填。
   */
  async probeEndpoint(
    baseUrl: string,
  ): Promise<{ models: { id: string; context?: number }[] }> {
    const root = baseUrl.trim().replace(/\/+$/, '');
    try {
      const res = await fetch(`${root}/models`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        data?: { id?: unknown; max_model_len?: unknown }[];
      };
      const models: { id: string; context?: number }[] = [];
      for (const m of body.data ?? []) {
        const id = typeof m.id === 'string' ? m.id.trim() : '';
        if (!id) continue;
        const context = Number(m.max_model_len);
        models.push(
          Number.isFinite(context) && context > 0 ? { id, context } : { id },
        );
      }
      return { models };
    } catch (err) {
      this.logger.warn(
        `端点探测失败（${root}/models）: ${(err as Error).message}`,
      );
      return { models: [] };
    }
  }

  /**
   * PATCH /models/providers/:providerID：Provider 级配置更新（C7）。
   *
   * 为何需要 provider 级端点（逐行 PATCH /models/:id 走不通）：
   * - assertBaseUrlConsistent 只放行「与其余行相同」的值——把 A、B 两行从 /v1 改到 /v2 时，
   *   先 PATCH 任一行必然撞上另一行残留的 /v1 → 409（批量顺序更新无解）；
   * - UpdateModelDto.baseUrl 挂 @Matches(/^https?:\/\/.+/) 且 @IsOptional 只跳过
   *   undefined/null，空串直接 400 —— 清空 baseUrl 无路径。
   * 本方法用单条 updateMany 原子重写该 provider 全部模型行（消掉中间态冲突窗口），
   * 且 baseUrl 按「生效后的类型」归一化：local/custom 必填 http(s)、cloud 可空（null=清空）。
   *
   * C6：该 provider 有活跃（未吊销）凭据才全量下发——worker 据此重写 opencode.json
   * provider 段（baseUrl 配错在此收敛）；内容不变时 worker 侧幂等跳过（不重启）。
   */
  async updateProvider(
    providerID: string,
    dto: UpdateProviderDto,
  ): Promise<ProviderSummary> {
    if (dto.providerType === undefined && dto.baseUrl === undefined) {
      throw new BadRequestException({
        code: 'MODEL_PROVIDER_UPDATE_EMPTY',
        message: 'providerType 与 baseUrl 至少需提供一项',
      });
    }
    const rows = await this.prisma.model.findMany({
      where: { providerID },
      select: { providerType: true, baseUrl: true },
    });
    if (rows.length === 0) {
      throw new NotFoundException({
        code: MODEL_ERRORS.MODEL_NOT_FOUND,
        message: `provider ${providerID} 不存在`,
      });
    }
    const effectiveType =
      dto.providerType !== undefined
        ? this.normalizeProviderType(dto.providerType)
        : (rows[0].providerType ?? 'cloud');
    const rawBaseUrl =
      dto.baseUrl !== undefined ? dto.baseUrl : (rows[0].baseUrl ?? null);
    const effectiveBaseUrl = this.normalizeBaseUrl(
      rawBaseUrl ?? undefined,
      effectiveType,
    );
    await this.prisma.model.updateMany({
      where: { providerID },
      data: { providerType: effectiveType, baseUrl: effectiveBaseUrl },
    });
    await this.maybeDispatchAfterShapeChange(providerID);
    const summary = await this.listProviders();
    return (
      summary.find((p) => p.providerID === providerID) ?? {
        providerID,
        modelCount: 0,
        configured: false,
        fingerprint: null,
        revokedAt: null,
        providerType: effectiveType,
        baseUrl: effectiveBaseUrl,
      }
    );
  }

  /**
   * DELETE /models/:id：物理删除。
   * 决策：Model 无外键引用，但 WorkerModelAvailability 有 FK onDelete Restrict——
   * 先清理该模型的 availability 行，再物理删 model。
   */
  async remove(id: string) {
    const existing = await this.prisma.model.findUnique({ where: { id } });
    if (!existing) {
      this.throwNotFound(id);
    }
    const hadBaseUrl = !!(
      (existing as { baseUrl?: string | null }).baseUrl ?? ''
    ).trim();
    const result = await this.prisma.$transaction([
      this.prisma.workerModelAvailability.deleteMany({
        where: { modelId: id },
      }),
      this.prisma.model.delete({ where: { id } }),
    ]);
    // C6：删除带 baseUrl 的模型 → 门控下发（该 provider 最后一个模型删除时
    // provider 配置段随之消失）
    if (hadBaseUrl) {
      await this.maybeDispatchAfterShapeChange(
        (existing as { providerID: string }).providerID,
      );
    }
    return result;
  }

  /**
   * DELETE /models/providers/:providerID：Provider 粒度物理删除（重建场景）。
   * 语义（对齐 remove(id) 的单模型删除，扩展到该 provider 全部模型行）：
   * - 全无痕迹（无模型行 ∧ 无凭据 ∧ worker capabilities 无提及）→ 404 MODEL_NOT_FOUND
   *   （不新增错误码；仅此时 404）；
   * - 幽灵行（0 模型行 + 有 worker caps 提及）可删 → 200 + {providerID, deletedModels: 0,
   *   deletedCredential}，事务后 stripProviderFromWorkerCapabilities 剥离陈旧上报，
   *   listProviders 不再复活该行；
   * - 事务内先清 WorkerModelAvailability（FK onDelete Restrict）再删全部 model 行，
   *   最后删该 provider 的 ModelCredential（若存在）；ids 可能为空数组，
   *   deleteMany({ where: { modelId: { in: [] } } }) 幂等安全；
   * - 删除前只要任一模型行有 baseUrl → C6 门控下发（provider 配置段随之消失）；
   *   幽灵行无 baseUrl 自然不触发。
   */
  async removeProvider(providerID: string): Promise<{
    providerID: string;
    deletedModels: number;
    deletedCredential: boolean;
  }> {
    const rows = (await this.prisma.model.findMany({
      where: { providerID },
      select: { id: true, baseUrl: true },
    })) as { id: string; baseUrl?: string | null }[];
    const credential = await this.prisma.modelCredential.findUnique({
      where: { providerID },
      select: { id: true },
    });
    if (rows.length === 0 && !credential) {
      const mentioned =
        await this.providerMentionedInWorkerCapabilities(providerID);
      if (!mentioned) {
        this.throwNotFound(providerID);
      }
    }
    const ids = rows.map((r) => r.id);
    const hadBaseUrl = rows.some((r) => !!(r.baseUrl ?? '').trim());
    const result = await this.prisma.$transaction([
      this.prisma.workerModelAvailability.deleteMany({
        where: { modelId: { in: ids } },
      }),
      this.prisma.model.deleteMany({ where: { providerID } }),
      this.prisma.modelCredential.deleteMany({ where: { providerID } }),
    ]);
    const deletedCredential =
      ((result[2] as { count?: number } | undefined)?.count ?? 0) > 0;
    // Provider 删除后：剥离全部 worker capabilities.models 中该 provider 的
    // 陈旧上报（`providerID/...`），否则 listProviders 的目录 UNION worker 上报
    // 会把已删 provider 复活（models 行已空，但在线 worker 快照仍含该前缀）。
    // 仅触碰被删 providerID；其他 provider 上报原样保留（D5 非删除语义不动）。
    // worker 重启重注册后若再次上报该 provider，行会自然重现（符合预期）。
    await this.stripProviderFromWorkerCapabilities(providerID);
    // C6：删除带 baseUrl 的 provider → 门控下发（worker 侧 opencode.json 收敛）
    if (hadBaseUrl) {
      await this.maybeDispatchAfterShapeChange(providerID);
    }
    return { providerID, deletedModels: rows.length, deletedCredential };
  }

  /**
   * 只读判定：任一 worker 的 capabilities.models 是否提及该 provider。
   * 复用 splitModelId 拆分约定；非 string/空串跳过；不写库。
   */
  private async providerMentionedInWorkerCapabilities(
    providerID: string,
  ): Promise<boolean> {
    const workers = await this.prisma.worker.findMany({
      select: { capabilities: true },
    });
    for (const w of workers) {
      const models = (w.capabilities as { models?: unknown } | null)?.models;
      if (!Array.isArray(models)) {
        continue;
      }
      for (const raw of models) {
        if (typeof raw !== 'string' || !raw) {
          continue;
        }
        if (this.splitModelId(raw).providerID === providerID) {
          return true;
        }
      }
    }
    return false;
  }

  private async stripProviderFromWorkerCapabilities(
    providerID: string,
  ): Promise<void> {
    const workers = await this.prisma.worker.findMany({
      select: { id: true, capabilities: true },
    });
    for (const w of workers) {
      const caps = (w.capabilities ?? {}) as Record<string, unknown>;
      const models = (caps as { models?: unknown }).models;
      if (!Array.isArray(models)) {
        continue;
      }
      const kept = models.filter((raw) => {
        if (typeof raw !== 'string' || !raw) {
          return true;
        }
        return this.splitModelId(raw).providerID !== providerID;
      });
      if (kept.length === models.length) {
        continue;
      }
      await this.prisma.worker.update({
        where: { id: w.id },
        data: {
          capabilities: { ...caps, models: kept } as Prisma.InputJsonValue,
        },
      });
      this.logger.log(
        `provider ${providerID} 删除：已从 worker ${w.id} capabilities.models 剥离 ${models.length - kept.length} 条陈旧上报`,
      );
    }
  }

  /**
   * C3 核心集成：worker 注册/重注册上报 capabilities.models（string[]，id 格式 providerID/modelID）
   * → 逐条拆解 upsert 目录 + upsert WorkerModelAvailability（workerId+modelId 复合键）。
   * CONF-01 修复（第三次）：增加同步清理语义——本次上报即该 worker 当前权威模型列表，
   * 上次上报但本次未再出现的模型 availability（serve 预热期中间态假模型）一并删除，
   * 防止假模型在 worker 重启注册时反复回流入库。
   * 返回实际合并条数；modelIds 为空/缺省（undefined 降级未上报）→ 0（不触碰目录，保留旧数据）。
   */
  async syncFromWorkerCapabilities(
    workerId: string,
    modelIds: string[],
  ): Promise<number> {
    if (!modelIds || modelIds.length === 0) {
      return 0;
    }
    let merged = 0;
    const catalogIds: string[] = [];
    for (const raw of modelIds) {
      if (!raw || typeof raw !== 'string') {
        continue;
      }
      const { providerID, modelID } = this.splitModelId(raw);
      const catalogId = await this.upsertCatalogModel(providerID, modelID);
      catalogIds.push(catalogId);
      await this.prisma.workerModelAvailability.upsert({
        where: { workerId_modelId: { workerId, modelId: catalogId } },
        create: { workerId, modelId: catalogId },
        update: {},
      });
      merged++;
    }
    if (merged > 0) {
      // 同步清理：删除该 worker 本次未再上报的旧 availability（假模型随最新列表移除）。
      // catalogIds 去重：同一模型重复上报时 notIn 避免重复值。
      // models-sync 可见性权威：仅清理未启用行的 availability——已启用（live 确认/
      // admin 启用）行的 availability 即使不在某次 stale 快照中也保留，strip 权归
      // syncLiveModels 孤儿禁用（其删 availability 与 enabled:false 同步）。
      const removed = await this.prisma.workerModelAvailability.deleteMany({
        where: {
          workerId,
          modelId: { notIn: [...new Set(catalogIds)] },
          model: { enabled: false },
        },
      });
      this.logger.log(
        `worker ${workerId} 上报模型合并入库：${merged} 个（目录 + availability），清理未再上报的旧 availability ${removed.count} 条`,
      );
    }
    return merged;
  }

  /**
   * available-models 目录优先数据源：仅返回可用模型（免费或已配置 apikey）。
   * - 免费：providerID === 'opencode'（opencode 免费内置）或 providerType === 'local'/'custom'（本地模型无需凭据）
   * - 付费：需 ModelCredential 存在且 revokedAt === null
   * 未配置密钥的付费模型不返回，前端 agent 配置下拉仅展示可用模型。
   */
  async listCatalogModels(): Promise<{ id: string; name: string }[]> {
    const rowsRaw = (await this.prisma.model.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        providerID: true,
        modelID: true,
        name: true,
        providerType: true,
      },
    } as never)) as unknown as {
      id: string;
      providerID: string;
      modelID: string;
      name: string;
      providerType?: string | null;
    }[];
    const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
    const credentials = await this.prisma.modelCredential.findMany({
      where: { revokedAt: null },
      select: { providerID: true },
    });
    const configuredProviders = new Set(credentials.map((c) => c.providerID));
    const availRows = await this.prisma.workerModelAvailability.findMany({
      select: { modelId: true },
    });
    const availSet = new Set(availRows.map((r) => r.modelId));
    // 凭据即访问证明：已配未吊销凭据的 provider，其 enabled 行即使暂无
    // availability 行也可见（availability 由 setCredential 成功路径补齐；
    // live 探针未覆盖凭据模型时不以缺失的探针行隐藏）。opencode 免费与
    // local/custom 仍要求 availability（语义不变）。
    const filtered = rows.filter((m) => {
      const providerType = (m as { providerType?: string | null }).providerType;
      if (m.providerID === 'opencode') return availSet.has(m.id);
      if (providerType === 'local' || providerType === 'custom')
        return availSet.has(m.id);
      return configuredProviders.has(m.providerID);
    });
    return filtered.map((m) => ({
      id: `${m.providerID}/${m.modelID}`,
      name: m.name,
    }));
  }

  /**
   * Live 同步：worker 可执行集与目录校正（models-truth 真值源）。
   * - 无在线 worker → 不做剪枝，仅返回空结果（避免 offline 时误删）
   * - 真值优先级：worker 上报的 capabilities.executableModels（`opencode models`
   *   CLI 输出 = Provider.list() 鉴权过滤后的真实可用集，fresh 进程每次加载当前
   *   offering）> serve /api/model 拉取（serve 启动时加载的注册表快照，免费轮换
   *   后变 stale——旧逻辑唯一真值，致 5 个退市免费模型驻留 dropdown）。
   *   未上报 executableModels 的旧 worker 仍走 /api/model 拉取（兼容），与上报集 union。
   * - 可见性唯一归 sync：upsertAndEnable 授予 + 孤儿禁用；快照路径仍只做 enabled:false
   *   候选登记（不复活 stale 行）。
   */
  async syncLiveModels(): Promise<{
    synced: number;
    disabled: number;
    liveModels: string[];
  }> {
    const onlineWorkers = await this.prisma.worker.findMany({
      where: { status: { not: WORKER_STATUS.OFFLINE } },
      select: { id: true, capabilities: true },
    });
    if (onlineWorkers.length === 0) {
      return { synced: 0, disabled: 0, liveModels: [] };
    }
    const liveSet = new Set<string>();
    const legacyWorkers: typeof onlineWorkers = [];
    for (const w of onlineWorkers) {
      const caps =
        (w.capabilities as {
          baseUrl?: string;
          executableModels?: unknown;
        } | null) ?? null;
      const reported = caps?.executableModels;
      if (Array.isArray(reported)) {
        for (const raw of reported) {
          if (typeof raw === 'string') {
            const id = raw.trim();
            if (id.indexOf('/') > 0 && !/\s/.test(id)) liveSet.add(id);
          }
        }
      } else {
        legacyWorkers.push(w);
      }
    }
    for (const w of legacyWorkers) {
      const caps = (w.capabilities as { baseUrl?: string } | null) ?? null;
      const baseUrl = caps?.baseUrl ?? null;
      if (!baseUrl) continue;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/model`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) continue;
        const body = (await res.json()) as {
          data?: Array<{
            id?: string;
            providerID?: string;
            status?: string;
            enabled?: boolean;
          }>;
        };
        for (const m of body.data ?? []) {
          if (
            m?.id &&
            m?.providerID &&
            m.enabled !== false &&
            (m.status ?? 'active') === 'active'
          )
            liveSet.add(`${m.providerID}/${m.id}`);
        }
      } catch {
        try {
          const models = await this.workerClient.listModels(
            w as unknown as { id: string; capabilities: unknown },
          );
          for (const m of models) {
            if (m?.id) liveSet.add(m.id);
          }
        } catch {
          continue;
        }
      }
    }
    const liveModels = [...liveSet];
    if (liveModels.length === 0) {
      return { synced: 0, disabled: 0, liveModels: [] };
    }
    const liveCatalogIds: string[] = [];
    for (const raw of liveModels) {
      const { providerID, modelID } = this.splitModelId(raw);
      const catalogId = await this.upsertAndEnableCatalogModel(
        providerID,
        modelID,
      );
      liveCatalogIds.push(catalogId);
    }
    for (const cid of liveCatalogIds) {
      for (const w of onlineWorkers) {
        await this.prisma.workerModelAvailability.upsert({
          where: { workerId_modelId: { workerId: w.id, modelId: cid } },
          create: { workerId: w.id, modelId: cid },
          update: {},
        });
      }
    }
    const credentials = await this.prisma.modelCredential.findMany({
      where: { revokedAt: null },
      select: { providerID: true },
    });
    const configuredSet = new Set(credentials.map((c) => c.providerID));
    const orphansRaw = (await this.prisma.model.findMany({
      where: { enabled: true, id: { notIn: liveCatalogIds } },
      select: { id: true, providerID: true, providerType: true },
    } as never)) as unknown as {
      id: string;
      providerID: string;
      providerType?: string | null;
    }[];
    const orphans = Array.isArray(orphansRaw) ? orphansRaw : [];
    let disabled = 0;
    for (const o of orphans) {
      if (o.providerType === 'local' || o.providerType === 'custom') continue;
      // 凭据即访问证明，无条件跳过有未吊销凭据的 provider（best-effort live 探针
      // 未覆盖凭据模型是常态，不以探针缺席剪枝）。opencode 免费模型无凭据行，
      // 故其剪枝语义不变（特殊-case 保留）。
      if (configuredSet.has(o.providerID)) continue;
      await this.prisma.model.update({
        where: { id: o.id },
        data: { enabled: false },
      });
      await this.prisma.workerModelAvailability.deleteMany({
        where: { modelId: o.id },
      });
      disabled++;
    }
    if (disabled > 0) {
      this.logger.log(
        `live 同步剪枝：禁用孤儿模型 ${disabled} 个（无 worker 持有且未配置凭据）`,
      );
    }
    return { synced: liveCatalogIds.length, disabled, liveModels };
  }

  private async upsertAndEnableCatalogModel(
    providerID: string,
    modelID: string,
  ): Promise<string> {
    const existing = await this.prisma.model.findUnique({
      where: { providerID_modelID: { providerID, modelID } },
      select: { id: true, enabled: true },
    });
    if (existing) {
      if ((existing as { enabled?: boolean }).enabled === false) {
        await this.prisma.model.update({
          where: { id: existing.id },
          data: { enabled: true },
        });
      }
      return existing.id;
    }
    const row = await this.prisma.model.create({
      data: {
        id: await this.idGen.nextId(MODEL_ID_PREFIX),
        providerID,
        modelID,
        name: modelID,
        enabled: true,
      },
    });
    return row.id;
  }

  /**
   * C8：按 `providerID/modelID` 引用查询目录条目（worker defaultModelId 校验用）。
   * defaultModelId 是 providerID/modelID 格式（与 worker 上报 id 同构），非目录 md_ 主键，
   * 故不能用 findOne——此处复用 worker 上报 id 的拆解约定（splitModelId）查 @@unique。
   * 返回完整行（含 enabled）；引用非法/不存在 → null（调用方据此 400/404）。
   */
  async findCatalogByRef(ref: string): Promise<{
    id: string;
    providerID: string;
    modelID: string;
    name: string;
    enabled: boolean;
  } | null> {
    if (!ref || typeof ref !== 'string') {
      return null;
    }
    const { providerID, modelID } = this.splitModelId(ref);
    return this.prisma.model.findUnique({
      where: { providerID_modelID: { providerID, modelID } },
      select: {
        id: true,
        providerID: true,
        modelID: true,
        name: true,
        enabled: true,
      },
    });
  }

  /**
   * worker 上报 id 拆解（C1 learnings 约定）：含 `/` 按首个 `/` 拆 providerID/modelID；
   * 不含 `/`（如 deepseek-v4-pro 旧自由字符串）providerID 归为 opencode 默认 provider——
   * D5 后 seed 模型均携带前缀，该分支保留为存量/外部上报兼容路径。
   */
  private splitModelId(raw: string): { providerID: string; modelID: string } {
    const slash = raw.indexOf('/');
    return {
      providerID: slash > 0 ? raw.slice(0, slash) : 'opencode',
      modelID: slash > 0 ? raw.slice(slash + 1) : raw,
    };
  }

  /**
   * 目录 upsert（worker 注册快照路径专用）：按 (providerID, modelID) 唯一键查，
   * 存在复用（不碰 enabled）；否则新建。
   * models-sync 可见性权威：快照上报 ≠ live 确认——新建的 opencode/* 行
   * `enabled:false`（候选登记，不进 available-models/dropdown），可见性唯一由
   * syncLiveModels 经 upsertAndEnableCatalogModel 授予；非 opencode 行保持
   * `enabled` 缺省（local/custom/凭据模型的既有语义不动）。
   */
  private async upsertCatalogModel(
    providerID: string,
    modelID: string,
  ): Promise<string> {
    const existing = await this.prisma.model.findUnique({
      where: { providerID_modelID: { providerID, modelID } },
      select: { id: true },
    });
    if (existing) {
      return existing.id;
    }
    const row = await this.prisma.model.create({
      data: {
        id: await this.idGen.nextId(MODEL_ID_PREFIX),
        providerID,
        modelID,
        name: modelID,
        ...(providerID === 'opencode' ? { enabled: false } : {}),
      },
    });
    return row.id;
  }

  private normalizeProviderType(raw?: string): string {
    const v = (raw ?? 'cloud').trim().toLowerCase();
    if ((MODEL_PROVIDER_TYPES as readonly string[]).includes(v)) return v;
    throw new BadRequestException({
      code: 'MODEL_PROVIDER_TYPE_INVALID',
      message: `providerType 非法: ${raw}`,
    });
  }

  private normalizeBaseUrl(
    raw: string | undefined,
    providerType: string,
  ): string | null {
    const trimmed = raw?.trim() ?? '';
    if (providerType === 'local' || providerType === 'custom') {
      if (!trimmed)
        throw new BadRequestException({
          code: MODEL_ERRORS.MODEL_BASEURL_REQUIRED,
          message: `providerType=${providerType} 时 baseUrl 必填`,
        });
      if (!/^https?:\/\/.+/.test(trimmed))
        throw new BadRequestException({
          code: MODEL_ERRORS.MODEL_BASEURL_REQUIRED,
          message: 'baseUrl 需为 http(s) URL',
        });
      return trimmed;
    }
    return trimmed ? trimmed : null;
  }

  private async assertBaseUrlConsistent(
    providerID: string,
    baseUrl: string | null,
    excludeId?: string,
  ): Promise<void> {
    if (!baseUrl) return;
    const rows = await this.prisma.model.findMany({
      where: { providerID, id: excludeId ? { not: excludeId } : undefined },
      select: { baseUrl: true },
    });
    for (const r of rows) {
      const existing = (r as { baseUrl?: string | null }).baseUrl ?? null;
      if (existing && existing !== baseUrl) {
        throw new ConflictException({
          code: MODEL_ERRORS.MODEL_BASEURL_CONFLICT,
          message: `provider ${providerID} 已有不同 baseUrl=${existing}，同一 provider 的 baseUrl 需一致`,
        });
      }
    }
  }

  /** providerID+modelID 唯一冲突校验（PATCH 排除自身）：已存在 → 409 MODEL_EXISTS。 */
  private async assertProviderModelAvailable(
    providerID: string,
    modelID: string,
    excludeId?: string,
  ): Promise<void> {
    const hit = await this.prisma.model.findUnique({
      where: { providerID_modelID: { providerID, modelID } },
      select: { id: true },
    });
    if (hit && hit.id !== excludeId) {
      throw new ConflictException({
        code: MODEL_ERRORS.MODEL_EXISTS,
        message: `模型 ${providerID}/${modelID} 已存在`,
      });
    }
  }

  // ==================================================================
  // C4 凭据端点（既有实现）
  // ==================================================================

  /**
   * POST /models/:id/credentials：加密存储 provider token。
   * - model 不存在 → 404 MODEL_NOT_FOUND；
   * - body.providerID 可选：缺省取 model.providerID；显式提供时须与 model 一致
   *   （校验一致策略，冲突 → 400 MODEL_PROVIDER_MISMATCH，避免 GET 按 model.providerID 查不到）；
   * - 同 providerID 重复 POST → 覆盖更新（credentialRef/fingerprint 替换 + 清除 revokedAt）。
   * - C5/C6：保存成功后触发 worker 凭据 + provider 配置全量下发（targetWorkerIds
   *   非空定向 / 空全量）；下发失败不阻断保存（凭据已加密落库，worker
   *   注册/重注册回放可兜底）。
   * 返回脱敏视图（无明文 token）。
   */
  async setCredential(
    modelId: string,
    token?: string,
    providerID?: string,
    targetWorkerIds?: string[],
  ): Promise<ModelCredentialView> {
    const modelProviderID = await this.resolveProviderID(modelId);
    if (providerID && providerID.trim().length > 0) {
      if (providerID.trim() !== modelProviderID) {
        throw new BadRequestException({
          code: MODEL_ERRORS.MODEL_PROVIDER_MISMATCH,
          message: `body.providerID=${providerID} 与该模型 providerID=${modelProviderID} 不一致（凭据按 provider 粒度存储）`,
        });
      }
    }
    const modelRows = (await this.prisma.model.findMany({
      where: { providerID: modelProviderID },
      select: { providerType: true },
      take: 1,
    } as never)) as unknown[] | undefined;
    const providerType =
      ((modelRows ?? [])[0] as { providerType?: string } | undefined)
        ?.providerType ?? 'cloud';
    const isLocal = providerType === 'local' || providerType === 'custom';
    const trimmedToken = token?.trim() ?? '';
    if (!trimmedToken) {
      if (isLocal) {
        this.logger.log(
          `模型凭据本地无鉴权（空 token 视为已配置）：model=${modelId} provider=${modelProviderID} providerType=${providerType}`,
        );
        const placeholder = 'local-noop';
        const credentialRef = this.crypto.encrypt(placeholder);
        const fingerprint = this.crypto.fingerprint(placeholder);
        const existingLocal = await this.prisma.modelCredential.findUnique({
          where: { providerID: modelProviderID },
        });
        let row: ModelCredential;
        if (existingLocal) {
          row = await this.prisma.modelCredential.update({
            where: { providerID: modelProviderID },
            data: { credentialRef, fingerprint, revokedAt: null },
          });
        } else {
          row = await this.prisma.modelCredential.create({
            data: {
              id: await this.idGen.nextId(MODEL_CREDENTIAL_ID_PREFIX),
              providerID: modelProviderID,
              credentialRef,
              fingerprint,
            },
          });
        }
        await this.dispatchCredentialState(targetWorkerIds);
        await this.enableProviderModelsAfterCredential(
          modelProviderID,
          targetWorkerIds,
        );
        await this.resyncAfterCredentialChange();
        return this.toView(row);
      }
      throw new BadRequestException({
        code: 'MODEL_TOKEN_REQUIRED',
        message: 'token 必填（cloud 模型需配置凭据）',
      });
    }
    const credentialRef = this.crypto.encrypt(trimmedToken);
    const fingerprint = this.crypto.fingerprint(trimmedToken);

    const existing = await this.prisma.modelCredential.findUnique({
      where: { providerID: modelProviderID },
    });

    let row: ModelCredential;
    if (existing) {
      row = await this.prisma.modelCredential.update({
        where: { providerID: modelProviderID },
        data: { credentialRef, fingerprint, revokedAt: null },
      });
      this.logger.log(
        `模型凭据覆盖更新：model=${modelId} provider=${modelProviderID} fingerprint=${fingerprint}`,
      );
    } else {
      row = await this.prisma.modelCredential.create({
        data: {
          id: await this.idGen.nextId(MODEL_CREDENTIAL_ID_PREFIX),
          providerID: modelProviderID,
          credentialRef,
          fingerprint,
        },
      });
      this.logger.log(
        `模型凭据录入：model=${modelId} provider=${modelProviderID} fingerprint=${fingerprint}`,
      );
    }
    await this.dispatchCredentialState(targetWorkerIds);
    await this.enableProviderModelsAfterCredential(
      modelProviderID,
      targetWorkerIds,
    );
    await this.resyncAfterCredentialChange();
    return this.toView(row);
  }

  /**
   * C6：baseUrl provider 的 opencode 配置全量状态（providerID → baseUrl + models）。
   * 覆盖 local/custom 及带自定义 baseUrl 的 cloud provider——opencode 对 custom
   * 端点只认 opencode.json 的 options.baseURL，不带配置则 provider 在 worker 侧
   * 永远不可达（auth.json 只有 key 不建 provider）。
   * - 同 provider 多个不一致 baseUrl → 保留首个并 warn（create/update 已按
   *   MODEL_BASEURL_CONFLICT 拦截，此处为存量脏数据防御）；
   * - 无模型行的 provider 不产出条目（opencode provider 无 models map 是死配置）；
   * - 不按 enabled 过滤：opencode.json 只是引擎级注册，可用性由 server
   *   availability/目录 enabled 门控，避免启停模型还要重新下发配置。
   */
  async getLocalProviderConfigs(): Promise<
    Record<string, ModelProviderConfigEntry>
  > {
    const rows = (await this.prisma.model.findMany({
      where: { baseUrl: { not: null } },
      select: {
        providerID: true,
        modelID: true,
        name: true,
        baseUrl: true,
        capabilities: true,
      },
    } as never)) as unknown as {
      providerID: string;
      modelID: string;
      name: string;
      baseUrl: string | null;
      capabilities: unknown;
    }[];
    const map: Record<string, ModelProviderConfigEntry> = {};
    for (const row of rows) {
      const url = row.baseUrl?.trim();
      if (!row.providerID || !url) {
        continue;
      }
      let entry = map[row.providerID];
      if (!entry) {
        entry = { baseUrl: url, models: {} };
        map[row.providerID] = entry;
      } else if (entry.baseUrl !== url) {
        this.logger.warn(
          `模型 baseUrl 冲突（保留首个 ${entry.baseUrl}，忽略 ${url}）: provider=${row.providerID}`,
        );
      }
      if (!entry.models[row.modelID]) {
        entry.models[row.modelID] = this.toProviderModelEntry(row);
      }
    }
    return Object.fromEntries(
      Object.entries(map).filter(([, e]) => Object.keys(e.models).length > 0),
    );
  }

  /**
   * C8：DB 行 → 下发条目的单模型项（只带实际生效的键）。
   * capabilities 为历史遗留的任意 JSON——只挑白名单内的合法字段，
   * 非法/未知键静默丢弃（worker 侧还会再兜一层归一化）。
   */
  private toProviderModelEntry(row: {
    modelID: string;
    name: string;
    capabilities: unknown;
  }): ProviderModelEntry {
    const entry: ProviderModelEntry = {};
    const displayName = row.name?.trim();
    if (displayName && displayName !== row.modelID) {
      entry.name = displayName;
    }
    const caps = this.readModelCapabilities(row.capabilities);
    return caps ? { ...entry, capabilities: caps } : entry;
  }

  /**
   * C8：从 Model.capabilities Json 提取受支持的能力字段（白名单过滤）。
   * 全部字段均非法/缺失 → 返回 undefined（调用方据此省略 capabilities 键）。
   */
  private readModelCapabilities(raw: unknown): ModelCapabilities | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const src = raw as Record<string, unknown>;
    const caps: ModelCapabilities = {};
    const limit = src.limit as
      { context?: unknown; output?: unknown } | undefined;
    const context = Number(limit?.context);
    const output = Number(limit?.output);
    if (
      limit &&
      Number.isFinite(context) &&
      context > 0 &&
      Number.isFinite(output) &&
      output > 0
    ) {
      caps.limit = { context, output };
    }
    for (const key of [
      'reasoning',
      'toolCall',
      'temperature',
      'attachment',
    ] as const) {
      if (typeof src[key] === 'boolean') {
        caps[key] = src[key] as boolean;
      }
    }
    const modalities = src.modalities as
      { input?: unknown; output?: unknown } | undefined;
    if (modalities && typeof modalities === 'object') {
      const picked: { input?: ModelModality[]; output?: ModelModality[] } = {};
      for (const dir of ['input', 'output'] as const) {
        const list = modalities[dir];
        if (!Array.isArray(list)) continue;
        const valid = list.filter(
          (m): m is ModelModality =>
            typeof m === 'string' &&
            (MODEL_MODALITIES as readonly string[]).includes(m),
        );
        if (valid.length > 0) picked[dir] = valid;
      }
      if (picked.input || picked.output) caps.modalities = picked;
    }
    const options = src.options;
    if (
      options &&
      typeof options === 'object' &&
      !Array.isArray(options) &&
      Object.keys(options).length > 0
    ) {
      caps.options = options as Record<string, unknown>;
    }
    return Object.keys(caps).length > 0 ? caps : undefined;
  }

  /**
   * C5/C6：凭据 + provider 配置的全量状态下发（唯一触发面）。
   * - 凭据：全部未吊销 credentialRef 解密为 providerKeys（**全量**而非单条——
   *   worker 按负载整体重写 auth.json，单条下发会抹掉其他 provider 的 key）；
   * - 配置：getLocalProviderConfigs() 全量 providerConfigs（undefined 仅在
   *   查询失败时省略 = 不触碰配置）。
   * token 只经下行命令明文传输，本方法不落日志；失败只 warn 不阻断
   * （凭据已落库，worker 注册回放兜底收敛）。
   */
  private async dispatchCredentialState(
    targetWorkerIds?: string[],
  ): Promise<void> {
    try {
      const active = await this.prisma.modelCredential.findMany({
        where: { revokedAt: null },
        select: { providerID: true, credentialRef: true },
      });
      const providerKeys = active.map((row) => ({
        providerID: row.providerID,
        key: this.crypto.decrypt(row.credentialRef),
      }));
      let providerConfigs: Record<string, ModelProviderConfigEntry> | undefined;
      try {
        providerConfigs = await this.getLocalProviderConfigs();
      } catch (err) {
        this.logger.warn(
          `模型 provider 配置查询失败（下发降级为仅凭据）: ${(err as Error).message}`,
        );
      }
      await this.workers.dispatchModelCredentials(
        providerKeys,
        targetWorkerIds,
        providerConfigs,
      );
    } catch (err) {
      this.logger.warn(
        `模型凭据全量下发失败（worker 注册回放兜底）: ${(err as Error).message}`,
      );
    }
  }

  /**
   * 根因诊断（opencode-go 凭据未吊销但 36 行 enabled=false 且零 availability 行）：
   * 剪枝先于凭据保存执行——syncLiveModels 的 live 集来自 worker executableModels /
   * /api/model（仅含 live 可执行模型，不含凭据付费模型），剪枝把不在 live 集中的
   * opencode-go 行置 enabled=false 并删其 availability；configuredSet 守卫只保护
   * 剪枝时刻已配凭据的 enabled 行。凭据保存后的 resync 仍以同一 live 集为准，
   * 从不把凭据模型加回 live 集；已禁用的行既不在 orphans 查询（where enabled:true）
   * 中，也无 availability 行被重建；注册路径复用既有行时亦不碰 enabled——
   * 双重过滤致 available-models 归零。修复：凭据保存成功后显式回 enable 该
   * provider 全量目录行，并为在线 worker 补齐 availability 行（与
   * syncFromWorkerCapabilities upsert 同形）；失败只 warn 不阻断保存。
   */
  private async enableProviderModelsAfterCredential(
    providerID: string,
    targetWorkerIds?: string[],
  ): Promise<void> {
    try {
      await this.prisma.model.updateMany({
        where: { providerID, enabled: false },
        data: { enabled: true },
      });
      let workerIds = (targetWorkerIds ?? []).filter(
        (id) => typeof id === 'string' && id.length > 0,
      );
      if (workerIds.length === 0) {
        const online = await this.prisma.worker.findMany({
          where: { status: { not: WORKER_STATUS.OFFLINE } },
          select: { id: true },
        });
        workerIds = online.map((w) => w.id);
      }
      if (workerIds.length === 0) {
        return;
      }
      const rows = await this.prisma.model.findMany({
        where: { providerID },
        select: { id: true },
      });
      for (const r of rows as { id: string }[]) {
        for (const workerId of workerIds) {
          await this.prisma.workerModelAvailability.upsert({
            where: { workerId_modelId: { workerId, modelId: r.id } },
            create: { workerId, modelId: r.id },
            update: {},
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `凭据模型可见性回补失败（凭据已落库，手动 POST /models/sync 可补）: provider=${providerID} ${(err as Error).message}`,
      );
    }
  }

  /**
   * GET /models/:id/credentials：凭据状态查询。
   * 只返回 {configured, fingerprint, revokedAt}——明文零接触，绝不返回 credentialRef/token。
   */
  async getCredential(modelId: string): Promise<ModelCredentialView> {
    const providerID = await this.resolveProviderID(modelId);
    const row = await this.prisma.modelCredential.findUnique({
      where: { providerID },
    });
    if (!row) {
      return {
        id: '',
        providerID,
        configured: false,
        fingerprint: null,
        revokedAt: null,
        createdAt: null,
      };
    }
    return this.toView(row);
  }

  /**
   * DELETE /models/:id/credentials：软撤销（revokedAt 标记，保留审计轨迹）。
   * - 凭据不存在 → 404 MODEL_CREDENTIAL_NOT_FOUND。
   */
  async revokeCredential(modelId: string): Promise<ModelCredentialView> {
    const providerID = await this.resolveProviderID(modelId);
    const existing = await this.prisma.modelCredential.findUnique({
      where: { providerID },
    });
    if (!existing) {
      throw new NotFoundException({
        code: MODEL_ERRORS.MODEL_CREDENTIAL_NOT_FOUND,
        message: `模型 ${modelId}（provider=${providerID}）尚未配置凭据`,
      });
    }
    const row = await this.prisma.modelCredential.update({
      where: { providerID },
      data: { revokedAt: new Date() },
    });
    this.logger.log(
      `模型凭据吊销：model=${modelId} provider=${providerID} fingerprint=${row.fingerprint}`,
    );
    // C6：吊销后即刻全量下发（worker 移除 auth.json 条目；配置段按目录现状重算）
    await this.dispatchCredentialState();
    await this.resyncAfterCredentialChange();
    return this.toView(row);
  }

  /**
   * DELETE /models/providers/:providerID/credentials：按 provider 粒度软撤销。
   * - 直接以 providerID 查 ModelCredential，**不依赖 model 行存在**（修复
   *   worker-only provider 目录无该 provider 模型时无法删凭据的问题）；
   * - 凭据不存在 → 404 MODEL_CREDENTIAL_NOT_FOUND。
   */
  async revokeCredentialByProvider(
    providerID: string,
  ): Promise<ModelCredentialView> {
    const existing = await this.prisma.modelCredential.findUnique({
      where: { providerID },
    });
    if (!existing) {
      throw new NotFoundException({
        code: MODEL_ERRORS.MODEL_CREDENTIAL_NOT_FOUND,
        message: `provider ${providerID} 尚未配置凭据`,
      });
    }
    const row = await this.prisma.modelCredential.update({
      where: { providerID },
      data: { revokedAt: new Date() },
    });
    this.logger.log(
      `模型凭据吊销（provider 粒度）：provider=${providerID} fingerprint=${row.fingerprint}`,
    );
    // C6：同 revokeCredential——吊销后即刻全量下发收敛 worker 侧
    await this.dispatchCredentialState();
    await this.resyncAfterCredentialChange();
    return this.toView(row);
  }

  /**
   * 凭据变更后可见性重收敛（models-credential）：configuredSet 变化会改变孤儿禁用
   * 判定——未配前被禁用的凭据模型需回 enable，已吊销 provider 的模型需剪枝；两者都只
   * 有 syncLiveModels 能做（快照路径永不授可见性），故此处 best-effort 触发一次。
   * 失败只 warn 不抛错：凭据已落库生效，手动 POST /models/sync 可补收敛。
   */
  private async resyncAfterCredentialChange(): Promise<void> {
    try {
      await this.syncLiveModels();
    } catch (err) {
      this.logger.warn(
        `凭据变更后可见性重收敛失败（不阻断，手动 POST /models/sync 可补）: ${(err as Error).message}`,
      );
    }
  }

  /** 由 model id 解析 providerID；model 不存在 → 404 MODEL_NOT_FOUND。 */
  private async resolveProviderID(modelId: string): Promise<string> {
    const model = await this.prisma.model.findUnique({
      where: { id: modelId },
      select: { providerID: true },
    });
    if (!model) {
      throw new NotFoundException({
        code: MODEL_ERRORS.MODEL_NOT_FOUND,
        message: `模型 ${modelId} 不存在`,
      });
    }
    return model.providerID;
  }

  /** 行 → 脱敏视图（无 credentialRef）。 */
  private toView(row: ModelCredential): ModelCredentialView {
    return {
      id: row.id,
      providerID: row.providerID,
      configured: row.revokedAt === null,
      fingerprint: row.fingerprint,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }

  /** 404：MODEL_NOT_FOUND。 */
  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: MODEL_ERRORS.MODEL_NOT_FOUND,
      message: `模型 ${id} 不存在`,
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
