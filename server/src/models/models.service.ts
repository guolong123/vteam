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
import { WorkersService } from '../workers/workers.service';
import { MODEL_ERRORS } from './models.constants';
import { CreateModelDto } from './dto/create-model.dto';
import { QueryModelsDto } from './dto/query-models.dto';
import { UpdateModelDto } from './dto/update-model.dto';

/** 模型目录域主键前缀（C1：`md_<零填充序号>`，如 md_0000000001）。 */
const MODEL_ID_PREFIX = 'md';

/** 模型凭据域主键前缀（15 篇 §2.2：`mc_<零填充序号>`，如 mc_0000000001）。 */
const MODEL_CREDENTIAL_ID_PREFIX = 'mc';

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
  ) {}

  /** 进程启动对齐 md_/mc_ 前缀序号（重启续号，md_ 对齐 tools.service onModuleInit 模式）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.model, MODEL_ID_PREFIX, this.idGen);
    await resyncIdPrefix(
      this.prisma.modelCredential,
      MODEL_CREDENTIAL_ID_PREFIX,
      this.idGen,
    );
  }

  // ==================================================================
  // C3 目录 CRUD（模型目录管理）
  // ==================================================================

  /**
   * GET /models：enabled 过滤 + providerID/modelID/name 模糊搜索 + 分页。
   * 返回 {items, total, page, pageSize}（对齐 mcp-servers/tools findAll 模式）。
   */
  async findAll(query: QueryModelsDto = {}) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where = {
      enabled: query.enabled === undefined ? undefined : query.enabled,
      providerID: query.providerID ? { contains: query.providerID } : undefined,
      modelID: query.modelID ? { contains: query.modelID } : undefined,
      name: query.name ? { contains: query.name } : undefined,
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.model.count({ where }),
      this.prisma.model.findMany({
        where,
        orderBy: { createdAt: 'asc' },
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
    const credByProvider = new Map(
      credentials.map((c) => [c.providerID, c]),
    );

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
        return {
          providerID,
          modelCount:
            catalogCount + (workerCountByProvider.get(providerID) ?? 0),
          configured,
          fingerprint: configured ? (cred?.fingerprint ?? null) : null,
          revokedAt: cred?.revokedAt ?? null,
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
    return this.prisma.model.create({
      data: {
        id: await this.idGen.nextId(MODEL_ID_PREFIX),
        providerID: dto.providerID.trim(),
        modelID: dto.modelID.trim(),
        name: dto.name.trim(),
        capabilities: dto.capabilities as Prisma.InputJsonValue | undefined,
        enabled: dto.enabled ?? true,
      },
    });
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
      dto.providerID !== undefined ? dto.providerID.trim() : existing.providerID;
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

    return this.prisma.model.update({
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
      },
    });
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
    return this.prisma.$transaction([
      this.prisma.workerModelAvailability.deleteMany({ where: { modelId: id } }),
      this.prisma.model.delete({ where: { id } }),
    ]);
  }

  /**
   * C3 核心集成：worker 注册/重注册上报 capabilities.models（string[]，id 格式 providerID/modelID）
   * → 逐条拆解 upsert 目录 + upsert WorkerModelAvailability（workerId+modelId 复合键）。
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
    for (const raw of modelIds) {
      if (!raw || typeof raw !== 'string') {
        continue;
      }
      const { providerID, modelID } = this.splitModelId(raw);
      const catalogId = await this.upsertCatalogModel(providerID, modelID);
      await this.prisma.workerModelAvailability.upsert({
        where: { workerId_modelId: { workerId, modelId: catalogId } },
        create: { workerId, modelId: catalogId },
        update: {},
      });
      merged++;
    }
    if (merged > 0) {
      this.logger.log(
        `worker ${workerId} 上报模型合并入库：${merged} 个（目录 + availability）`,
      );
    }
    return merged;
  }

  /** available-models 目录优先数据源：enabled=true 全部模型，id 拼回 providerID/modelID。 */
  async listCatalogModels(): Promise<{ id: string; name: string }[]> {
    const rows = await this.prisma.model.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
      select: { providerID: true, modelID: true, name: true },
    });
    return rows.map((m) => ({
      id: `${m.providerID}/${m.modelID}`,
      name: m.name,
    }));
  }

  /**
   * C8：按 `providerID/modelID` 引用查询目录条目（worker defaultModelId 校验用）。
   * defaultModelId 是 providerID/modelID 格式（与 worker 上报 id 同构），非目录 md_ 主键，
   * 故不能用 findOne——此处复用 worker 上报 id 的拆解约定（splitModelId）查 @@unique。
   * 返回完整行（含 enabled）；引用非法/不存在 → null（调用方据此 400/404）。
   */
  async findCatalogByRef(
    ref: string,
  ): Promise<{ id: string; providerID: string; modelID: string; name: string; enabled: boolean } | null> {
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

  /** 目录 upsert：按 (providerID, modelID) 唯一键查，存在复用；否则新建（name 缺省用 modelID 末段）。 */
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
      },
    });
    return row.id;
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
   * - C5：保存成功后触发 worker 凭据下发（targetWorkerIds 非空定向 / 空全量）；
   *   下发失败不阻断保存（凭据已加密落库，worker 注册/重注册回放可兜底）。
   * 返回脱敏视图（无明文 token）。
   */
  async setCredential(
    modelId: string,
    token: string,
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
    const credentialRef = this.crypto.encrypt(token);
    const fingerprint = this.crypto.fingerprint(token);

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
    await this.dispatchAfterSave(
      modelProviderID,
      token,
      targetWorkerIds,
    );
    return this.toView(row);
  }

  /** C5：凭据保存后触发下发（token 只经下行命令明文传输，本方法不落日志）。 */
  private async dispatchAfterSave(
    providerID: string,
    token: string,
    targetWorkerIds?: string[],
  ): Promise<void> {
    try {
      await this.workers.dispatchModelCredentials(
        [{ providerID, key: token }],
        targetWorkerIds,
      );
    } catch (err) {
      this.logger.warn(
        `模型凭据下发失败（凭据已落库，worker 注册回放兜底）: provider=${providerID} ${(err as Error).message}`,
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
    return this.toView(row);
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
