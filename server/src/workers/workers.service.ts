import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { MODEL_ERRORS } from '../models/models.constants';
import { ModelsService } from '../models/models.service';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { McpStatusEntryDto } from '../mcp-servers/dto/mcp-status.dto';
import { HeartbeatWorkerDto } from './dto/heartbeat-worker.dto';
import { RegisterWorkerDto } from './dto/register-worker.dto';
import { UpdateWorkerModelDto } from './dto/update-worker-model.dto';
import {
  WORKER_ERRORS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_OFFLINE_TIMEOUT_MS,
  WORKER_STATUS,
  WORKER_TOKEN_BCRYPT_ROUNDS,
} from './workers.constants';

/** schema Worker.capabilities Json 形状。 */
interface WorkerCapabilitiesShape {
  maxInstances: number;
  skills?: string[];
  tools?: string[];
}

/** schema Worker.load Json 形状。 */
interface WorkerLoadShape {
  instances: number;
}

/** 调度需求声明（T10 WorkerDispatcher 分派时传入）。 */
export interface AssignmentRequirement {
  /** 要求的 opencode 版本（精确匹配；省略则接受任意版本） */
  opencodeVersion?: string;
  /** 需要的并发实例槽位（默认 1） */
  instances?: number;
  /**
   * C7：要求的模型 id（`providerID/modelID`，对齐 models 目录 id 格式；省略则不过滤）。
   * 候选 worker 须满足：availability 含该 enabled 模型 或 defaultModelId 匹配；从未上报
   * （availability 无行）降级不受过滤约束（过渡期兼容）。
   */
  modelId?: string;
}

/** 下行命令 type 枚举（T4a 命令通道；09 §3.9 预留 {command?}，pull 模型心跳携带）。 */
export const WORKER_COMMAND_TYPES = {
  /** 资源（skills/tools/mcp 配置）变更：worker 重拉 + 注入 + 重启（T4b/T4c 执行） */
  RELOAD_CONFIG: 'reload-config',
  /**
   * C5：模型凭据下发——worker 写 auth.json（XDG_DATA_HOME 覆盖）注入 + 重启生效。
   * 命令一次有效（心跳取出即清空）；token 只经下行命令明文传输，不落 worker 日志。
   */
  MODEL_CREDENTIALS: 'model-credentials',
  /**
   * UX-01：管理员远程重启——worker 心跳取出后经 RestartCoordinator 重启 serve
   * （无活跃会话立即执行 + reRegister，有活跃会话挂起等归零）。worker 是独立
   * 进程/容器，server 无进程控制能力，命令经心跳下行（T4a pull 模型）落地。
   */
  RESTART: 'restart',
  /**
   * UX-01：管理员远程下线——server 立即标 offline（调度器停止分配），命令经心跳
   * 下发后 worker 优雅退出进程（停心跳 + flush 事件 + stop serve + exit）；进程
   * 退出后心跳停止，30s 健康检查兜底维持 offline。
   */
  SHUTDOWN: 'shutdown',
} as const;

export type WorkerCommandType =
  (typeof WORKER_COMMAND_TYPES)[keyof typeof WORKER_COMMAND_TYPES];

/**
 * C5：模型凭据下发条目（provider → 明文 API key，server 解密后经下行命令下发）。
 * token 仅存在于下行命令（心跳取出即清空，一次性），worker 侧只写入 auth.json。
 */
export interface ModelCredentialEntry {
  providerID: string;
  key: string;
}

/**
 * C5：model-credentials 命令负载（对齐 worker ModelCredentialsPayload）。
 * targetWorkerIds 空 = 全量（定向走 enqueueCommand、全量走 broadcastCommand，
 * worker 侧仅消费 providerKeys，targetWorkerIds 为元数据）。
 */
export interface ModelCredentialsPayload {
  providerKeys: ModelCredentialEntry[];
  /** 定向 worker id 列表；空 = 全量下发 */
  targetWorkerIds?: string[];
}

/**
 * 心跳响应携带的下行命令（T4a）。
 * 设计为通用 commands 数组（复用点：AgentsModule 配置变更重启也走此通道，09 §3.7），
 * 命令仅一次有效：心跳取出即清空，worker 离线期间的命令丢弃（上线后由注册/重拉对齐）。
 */
export interface WorkerCommand {
  type: WorkerCommandType;
  /** 资源版本号：T1/T2 变更时递增，worker 侧据此判断是否需重拉注入 */
  resourceVersion: string;
  /** C5：model-credentials 命令携带的凭据负载（仅该 type 携带；reload-config 等不携带） */
  payload?: ModelCredentialsPayload;
}

/** 原生 setInterval 句柄（不引入 @nestjs/schedule 依赖，等价 @Interval 语义）。 */
type HealthTimer = ReturnType<typeof setInterval>;

/**
 * Worker 控制面服务（T7：WorkerRegistry + Heartbeat + Scheduler + LifecycleManager 骨架）。
 *
 * - register：X-Worker-Token 校验由 guard 完成，此处 upsert Worker 行 + tokenHash(bcrypt)
 * - heartbeat：刷新 load + lastHeartbeatAt + status；health=degraded → 降权态（不改变离线判定）
 * - HealthChecker：10s 周期 + 启动自愈，仅更新 `status != offline 且 30s 未心跳` 的行
 * - Scheduler.assignWorker：按 opencodeVersion 能力匹配 + 剩余容量（负载最少）选 worker，
 *   无可用返回 null（D3：调用方报错，不降级 mock）
 * - LifecycleManager：createInstance/abortSession/dispatchPrompt 仅骨架签名，T10 接 WorkerClient
 */
@Injectable()
export class WorkersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkersService.name);
  private healthTimer?: HealthTimer;
  /** T4a：待下发命令队列（workerId → commands），心跳取出即清空。 */
  private readonly pendingCommands = new Map<string, WorkerCommand[]>();
  /**
   * T9：worker 最近一次心跳上报的 MCP 三态（workerId → entries）。
   * 按 worker 维度保存（区别于 mcp-servers 全局合并展示的 statusByServer），
   * 供 worker 详情接口返回；worker 标记 offline 时同步清理（纯内存态，同 T8c）。
   */
  private readonly workerMcpStatus = new Map<string, McpStatusEntryDto[]>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => McpServersService))
    private readonly mcpServers: McpServersService,
    // C5：解密 ModelCredential.credentialRef 组装 providerKeys（AES-256-GCM，C4 导出）
    private readonly credentialCrypto: CredentialCryptoService,
    // C3：worker 注册上报 capabilities.models 合并入库（upsert 目录 + availability）
    private readonly modelsService: ModelsService,
  ) {}

  /**
   * 启动自愈（架构决策 T7 验收）：先扫描 `status != offline 且 lastHeartbeatAt 超过 30s`
   * （或从未上报）的 worker 标 offline，再启动 10s 周期健康检查定时器。
   * 用原生 setInterval 而非 `@Interval`（@nestjs/schedule 未安装），unref 防阻塞进程退出。
   */
  async onModuleInit(): Promise<void> {
    await this.markStaleWorkersOffline();
    this.healthTimer = setInterval(() => {
      void this.markStaleWorkersOffline().catch((err: unknown) =>
        this.logger.error(`健康检查失败: ${err}`),
      );
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }

  /**
   * POST /workers/register：worker 注册（D1 全 push 三通道之注册）。
   * upsert 语义：首次 create（含 tokenHash=bcrypt(token)），重复注册 update 覆盖
   * 版本/能力/负载并刷新心跳（worker 重启换 token 时 tokenHash 同步更新）。
   * 返回 { workerId, heartbeatIntervalMs, serverTime }（worker 侧 T6 依据该协议）。
   */
  async register(workerToken: string, dto: RegisterWorkerDto) {
    const tokenHash = await bcrypt.hash(workerToken, WORKER_TOKEN_BCRYPT_ROUNDS);
    const now = new Date();
    const data = {
      name: dto.name ?? null,
      opencodeVersion: dto.opencodeVersion,
      capabilities: dto.capabilities as unknown as Prisma.InputJsonValue,
      load: dto.load as unknown as Prisma.InputJsonValue,
      // C2：worker 上报默认模型——仅显式提供时更新（旧 worker 不携带时保留已有值，不误清 C8/PATCH 配置）
      ...(dto.defaultModelId !== undefined
        ? { defaultModelId: dto.defaultModelId || null }
        : {}),
      status: WORKER_STATUS.ONLINE,
      tokenHash,
      lastHeartbeatAt: now,
    };
    // B1（F3 CRITICAL 修复）：凭据循环重启防护——upsert 前查原状态，判断本次是
    // 首次注册（原不存在）还是已在线 reRegister（serve 重启触发）。仅前者或
    // 原 offline（离线恢复）时回放凭据，见下方回放条件注释。
    const existing = await this.prisma.worker.findUnique({
      where: { id: dto.workerId },
      select: { status: true },
    });
    const worker = await this.prisma.worker.upsert({
      where: { id: dto.workerId },
      create: { id: dto.workerId, ...data },
      update: data,
    });
    // C3（P2-1 集成验收）：worker 上报 capabilities.models 合并入库——拆解
    // providerID/modelID upsert 目录 + upsert availability。降级（未上报
    // undefined）→ sync 返回 0 不触碰；失败不阻断注册（warn 可观测）。
    try {
      await this.modelsService.syncFromWorkerCapabilities(
        worker.id,
        dto.capabilities?.models,
      );
    } catch (e) {
      this.logger.warn(
        `worker ${worker.id} 模型能力合并入库失败（不阻断注册）: ${e}`,
      );
    }
    // C5（R5）：新 worker 注册/重注册后回放全部未吊销凭据——补凭据保存后新注册
    // worker 缺凭据的缺口（worker 离线期间入队的命令会丢弃，注册即对齐）。
    // B1（F3 CRITICAL）：仅首次注册（原不存在）或原 offline 时回放——已在线 worker
    // 的 reRegister（serve 重启触发）不回放，切断凭据→重启→reRegister→再回放
    // 无限循环（F3 实测每 ~10s 重启一次，27+ 次循环）。与心跳路径 offline→online
    // 回放语义一致：凭据只在首次上线或离线恢复时下发一次。
    // 回放失败（解密错/DB 错）不阻断注册，只打 warn 日志。
    if (!existing || existing.status === WORKER_STATUS.OFFLINE) {
      await this.replayModelCredentials(worker.id);
    }
    return {
      workerId: worker.id,
      heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
      serverTime: now.toISOString(),
    };
  }

  /**
   * POST /workers/:id/heartbeat：刷新负载 + 心跳时间 + 状态。
   * health=ok → online；health=degraded → degraded（调度器降权，不改变离线判定）。
   * worker 未注册 → 404 WORKER_NOT_FOUND。
   * F2 M2（MAJOR）：token 比对——guard 已校验共享 token，此处再比对注册时落库的
   * tokenHash（bcrypt），不匹配 → 401（防共享 token 持有者冒充任意已注册 workerId）。
   */
  async heartbeat(id: string, dto: HeartbeatWorkerDto, token?: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id },
      select: { id: true, tokenHash: true, status: true },
    });
    if (!worker) {
      throw new NotFoundException({
        code: WORKER_ERRORS.WORKER_NOT_FOUND,
        message: `Worker ${id} 不存在`,
      });
    }
    if (token && worker.tokenHash) {
      const match = await bcrypt.compare(token, worker.tokenHash);
      if (!match) {
        throw new UnauthorizedException({
          code: WORKER_ERRORS.TOKEN_INVALID,
          message: `X-Worker-Token 与 worker ${id} 注册 token 不匹配`,
        });
      }
    }
    const status =
      dto.health === 'degraded'
        ? WORKER_STATUS.DEGRADED
        : WORKER_STATUS.ONLINE;
    // T8c：MCP 三态快照 → 内存状态存储（前端 GET /mcp-servers 合并展示）
    // T9：另按 workerId 关联保存，worker 详情接口返回（前端 worker 详情页展示）
    if (dto.mcpStatus && dto.mcpStatus.length > 0) {
      this.mcpServers.applyHeartbeatStatus(dto.mcpStatus);
      this.workerMcpStatus.set(id, dto.mcpStatus);
    }
    const lastHeartbeatAt = new Date();
    await this.prisma.worker.update({
      where: { id },
      data: {
        load: dto.load as unknown as Prisma.InputJsonValue,
        status,
        lastHeartbeatAt,
      },
    });
    // C5（R5）：worker 从 offline 恢复上线 → 回放未吊销凭据——补离线期间保存的
    // 凭据（broadcastCommand 只覆盖在线 worker，离线 worker 恢复心跳时此处对齐）。
    // 一直在线的心跳不重复回放（已下发过且 worker 侧幂等覆盖，避免每 10s 重启 serve）。
    // 新状态 status 只可能为 online/degraded（永不等于 offline），仅需判断旧状态。
    if (worker.status === WORKER_STATUS.OFFLINE) {
      await this.replayModelCredentials(id);
    }
    const commands = this.pendingCommands.get(id) ?? [];
    if (commands.length > 0) {
      this.pendingCommands.delete(id);
    }
    return {
      workerId: id,
      status,
      lastHeartbeatAt: lastHeartbeatAt.toISOString(),
      ...(commands.length > 0 ? { commands } : {}),
    };
  }

  /**
   * T4a：入队下行命令（pull 模型）。资源变更方（T1/T2 POST/PATCH 后）调用，
   * 该 worker 下一次心跳时携带并清空（命令一次有效）。worker 离线期间入队
   * 的命令在心跳恢复时照常下发；未注册的 workerId 入队不报错（上线后生效）。
   */
  enqueueCommand(workerId: string, command: WorkerCommand): void {
    const existing = this.pendingCommands.get(workerId) ?? [];
    existing.push(command);
    this.pendingCommands.set(workerId, existing);
  }

  /**
   * F1 MAJOR 修复：资源（skills/tools/mcp-servers）变更后的**广播**入口。
   * enqueueCommand 是精确 workerId 语义（不支持 '*' 通配），本方法为上层提供
   * 全量广播：查询全部在线 worker（status != offline）逐个入队——离线 worker 跳过
   * （恢复上线后由注册/心跳对齐注入，09 §3.7），与 assignWorker 的候选集语义一致。
   * 返回收到命令的 worker 数（调试/测试用；无在线 worker 时静默返回 0，不报错）。
   */
  async broadcastCommand(command: WorkerCommand): Promise<number> {
    const online = await this.prisma.worker.findMany({
      where: { status: { not: WORKER_STATUS.OFFLINE } },
      select: { id: true },
    });
    for (const worker of online) {
      this.enqueueCommand(worker.id, command);
    }
    return online.length;
  }

  /**
   * C5：模型凭据下发（唯一化分发入口）。
   * - targetWorkerIds 非空 → 定向：enqueueCommand 逐个精确下发（精确 workerId 语义）；
   * - 空 → 全量：broadcastCommand 原样广播（不改 broadcastCommand 签名，空=全量无需过滤）。
   * 返回下发目标 worker 数（定向=targetWorkerIds.length，全量=在线 worker 数）。
   * token 只经下行命令明文传输（心跳取出即清空），不落本服务日志。
   */
  async dispatchModelCredentials(
    providerKeys: ModelCredentialEntry[],
    targetWorkerIds?: string[],
  ): Promise<number> {
    const command: WorkerCommand = {
      type: WORKER_COMMAND_TYPES.MODEL_CREDENTIALS,
      resourceVersion: 'model-credentials',
      payload: {
        providerKeys,
        ...(targetWorkerIds && targetWorkerIds.length > 0 ? { targetWorkerIds } : {}),
      },
    };
    if (targetWorkerIds && targetWorkerIds.length > 0) {
      for (const id of targetWorkerIds) {
        this.enqueueCommand(id, command);
      }
      return targetWorkerIds.length;
    }
    return this.broadcastCommand(command);
  }

  /**
   * C5（R5）：回放全部未吊销凭据到指定 worker（注册/重注册后调用）。
   * 查 ModelCredential revokedAt=null 行 → decrypt credentialRef 组装 providerKeys →
   * enqueueCommand 下发（该 worker 下一次心跳携带并清空）。
   * 无未吊销凭据 → 静默跳过；解密/查询失败 → warn 不阻断（worker 仍可注册成功）。
   */
  private async replayModelCredentials(workerId: string): Promise<void> {
    try {
      const active = await this.prisma.modelCredential.findMany({
        where: { revokedAt: null },
        select: { providerID: true, credentialRef: true },
      });
      if (active.length === 0) {
        return;
      }
      const providerKeys = active.map((row) => ({
        providerID: row.providerID,
        key: this.credentialCrypto.decrypt(row.credentialRef),
      }));
      this.enqueueCommand(workerId, {
        type: WORKER_COMMAND_TYPES.MODEL_CREDENTIALS,
        resourceVersion: 'model-credentials',
        payload: { providerKeys },
      });
      this.logger.log(
        `模型凭据回放：worker=${workerId} providerKeys=${providerKeys.map((k) => k.providerID).join(', ')}`,
      );
    } catch (err) {
      this.logger.warn(
        `模型凭据回放失败（不阻断注册）: worker=${workerId} ${(err as Error).message}`,
      );
    }
  }

  /**
   * HealthChecker 核心：仅更新过期的行（`status != offline AND (lastHeartbeatAt IS NULL
   * OR lastHeartbeatAt < now-30s)`），不批量全扫。返回被标记 offline 的 worker 数。
   * 10s 周期 × 3 = 30s（09 篇 §5.3）。
   * T9：先查过期 worker 列表，标记 offline 后同步清理其 workerMcpStatus 内存态
   * （离线 worker 的详情页 MCP 状态不保留陈旧数据）。
   */
  async markStaleWorkersOffline(): Promise<number> {
    const cutoff = new Date(Date.now() - WORKER_OFFLINE_TIMEOUT_MS);
    const where: Prisma.WorkerWhereInput = {
      status: { not: WORKER_STATUS.OFFLINE },
      OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: cutoff } }],
    };
    const stale = await this.prisma.worker.findMany({
      where,
      select: { id: true },
    });
    if (stale.length === 0) {
      return 0;
    }
    const result = await this.prisma.worker.updateMany({
      where,
      data: { status: WORKER_STATUS.OFFLINE },
    });
    for (const worker of stale) {
      this.workerMcpStatus.delete(worker.id);
    }
    if (result.count > 0) {
      this.logger.log(
        `健康检查：${result.count} 个 worker 心跳超时标记 offline`,
      );
    }
    return result.count;
  }

  /**
   * Scheduler：按能力匹配 + 负载最少选 worker（D3：无可用返回 null，调用方报错）。
   * - 候选：status != offline（online 优先，degraded 降权排后）
   * - 匹配：opencodeVersion 精确匹配（req.opencodeVersion 提供时）+ 剩余容量 >= 需求槽位
   * - 排序：online 优先；同状态内剩余容量（maxInstances - instances）降序 → 负载最少者优先
   */
  async assignWorker(
    req: AssignmentRequirement = {},
  ): Promise<string | null> {
    const need = Math.max(1, req.instances ?? 1);
    const candidates = await this.prisma.worker.findMany({
      where: { status: { not: WORKER_STATUS.OFFLINE } },
      // C7：附带模型可用性（modelAvailabilities → 每个 enabled 模型），供 modelId 过滤；
      // availability 无行（该 worker 从未上报）→ 降级不受过滤约束。
      include: {
        modelAvailabilities: { include: { model: { select: { enabled: true } } } },
      },
    });
    const ranked = candidates
      .map((w) => ({ worker: w, capacity: this.remainingCapacity(w) }))
      // 防御式双保险：DB where 已过滤 offline，此处再兜底（单测 mock 不执行 where）
      .filter((x) => x.worker.status !== WORKER_STATUS.OFFLINE)
      .filter((x) => x.capacity >= need)
      .filter(
        (x) =>
          !req.opencodeVersion ||
          x.worker.opencodeVersion === req.opencodeVersion,
      )
      .filter((x) => this.matchesModelRequirement(x.worker, req.modelId))
      .sort((a, b) => {
        const aOnline = a.worker.status === WORKER_STATUS.ONLINE ? 1 : 0;
        const bOnline = b.worker.status === WORKER_STATUS.ONLINE ? 1 : 0;
        if (aOnline !== bOnline) return bOnline - aOnline;
        return b.capacity - a.capacity;
      });
    return ranked[0]?.worker.id ?? null;
  }

  /**
   * C7：worker 是否满足模型过滤（assignWorker 候选筛选）。
   * - modelId 省略/空 → 不过滤（回归现状：未配模型 agent 可调度任意 worker）
   * - worker.defaultModelId === modelId → 通过（默认模型匹配）
   * - availability 无行（该 worker 从未上报模型能力）→ 通过（过渡期兼容降级）
   * - 已上报但 availability 不含该 enabled 模型 → 排除
   */
  private matchesModelRequirement(
    worker: {
      defaultModelId: string | null;
      modelAvailabilities?: Array<{
        modelId: string;
        model?: { enabled: boolean };
      }>;
    },
    modelId: string | undefined,
  ): boolean {
    if (!modelId) {
      return true;
    }
    if (worker.defaultModelId === modelId) {
      return true;
    }
    const avail = worker.modelAvailabilities ?? [];
    if (avail.length === 0) {
      return true;
    }
    return avail.some((a) => a.modelId === modelId && a.model?.enabled !== false);
  }

  /** GET /workers：worker 列表（不含 tokenHash——敏感字段只存库不返回）。 */
  async findAll() {
    const rows = await this.prisma.worker.findMany({
      orderBy: { registeredAt: 'desc' },
    });
    return rows.map((w) => this.toWorkerView(w));
  }

  /** GET /workers/:id：单查，不存在 → 404 WORKER_NOT_FOUND。 */
  async findOne(id: string) {
    const worker = await this.prisma.worker.findUnique({ where: { id } });
    if (!worker) {
      throw new NotFoundException({
        code: WORKER_ERRORS.WORKER_NOT_FOUND,
        message: `Worker ${id} 不存在`,
      });
    }
    return this.toWorkerView(worker);
  }

  /**
   * C8：PATCH /workers/:id 配置/清除 worker 默认模型（管理员显式配置通道，
   * 区别于 C2 register 只显式上报才更新——本端点是确定性的覆写语义）。
   * - worker 不存在 → 404 WORKER_NOT_FOUND；
   * - defaultModelId 非空须存在于 models 目录且 enabled=true（findCatalogByRef 查
   *   providerID/modelID @@unique，defaultModelId 即该格式）→ 否则 400 MODEL_NOT_FOUND；
   * - null/缺省 → 清除/幂等跳过；返回更新后的 WorkerView（含 defaultModelId）。
   */
  async updateDefaultModel(id: string, dto: UpdateWorkerModelDto) {
    const existing = await this.prisma.worker.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({
        code: WORKER_ERRORS.WORKER_NOT_FOUND,
        message: `Worker ${id} 不存在`,
      });
    }
    const { defaultModelId } = dto;
    if (defaultModelId !== null && defaultModelId !== undefined && defaultModelId !== '') {
      const catalog = await this.modelsService.findCatalogByRef(defaultModelId);
      if (!catalog || catalog.enabled === false) {
        throw new BadRequestException({
          code: MODEL_ERRORS.MODEL_NOT_FOUND,
          message: `默认模型 ${defaultModelId} 不存在于可用模型目录（或已停用）`,
        });
      }
    }
    const row = await this.prisma.worker.update({
      where: { id },
      data:
        defaultModelId === undefined
          ? {}
          : { defaultModelId: defaultModelId || null },
    });
    return this.toWorkerView(row);
  }

  /**
   * UX-01：POST /workers/:id/restart 远程重启（workers.edit 保护）。
   * worker 独立进程/容器，server 无进程控制能力——命令经 T4a 心跳下行通道下发，
   * worker 侧 RestartCoordinator 执行真实 serve 重启 + reRegister。worker 不存在
   * → 404 WORKER_NOT_FOUND。命令一次有效（心跳取出即清空）；offline worker 命令
   * 排队（恢复上线后由心跳取出执行）。返回命令入队确认，不含状态变更。
   */
  async requestRestart(id: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!worker) {
      throw new NotFoundException({
        code: WORKER_ERRORS.WORKER_NOT_FOUND,
        message: `Worker ${id} 不存在`,
      });
    }
    this.enqueueCommand(id, {
      type: WORKER_COMMAND_TYPES.RESTART,
      resourceVersion: 'remote-restart',
    });
    return {
      workerId: id,
      command: WORKER_COMMAND_TYPES.RESTART,
      queued: true,
    };
  }

  /**
   * UX-01：POST /workers/:id/shutdown 远程下线（workers.edit 保护）。
   * 双管齐下：① 立即标 offline——调度器（assignWorker status != offline 过滤）
   * 停止分配新任务、前端列表即时反映；② enqueueCommand SHUTDOWN——worker 心跳
   * 取出后优雅退出进程（停心跳 + flush 事件 + stop serve + exit），进程退出后
   * 心跳停止不会再刷回 online（30s 健康检查兜底维持 offline）。
   * worker 不存在 → 404 WORKER_NOT_FOUND；同步清理该 worker 的 mcpStatus 内存态。
   */
  async requestShutdown(id: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!worker) {
      throw new NotFoundException({
        code: WORKER_ERRORS.WORKER_NOT_FOUND,
        message: `Worker ${id} 不存在`,
      });
    }
    this.enqueueCommand(id, {
      type: WORKER_COMMAND_TYPES.SHUTDOWN,
      resourceVersion: 'remote-shutdown',
    });
    await this.prisma.worker.update({
      where: { id },
      data: { status: WORKER_STATUS.OFFLINE },
    });
    this.workerMcpStatus.delete(id);
    return {
      workerId: id,
      command: WORKER_COMMAND_TYPES.SHUTDOWN,
      queued: true,
      status: WORKER_STATUS.OFFLINE,
    };
  }

  // ---- LifecycleManager 骨架（T10 WorkerDispatcher 接入 WorkerClient 后实现，本任务不接 T8） ----

  /** T10：在 worker 上创建 opencode 会话实例。 */
  async createInstance(_workerId: string, _sessionId: string): Promise<never> {
    throw new NotImplementedException({
      code: WORKER_ERRORS.NOT_IMPLEMENTED,
      message: 'createInstance 由 T10 WorkerDispatcher 接入 WorkerClient 后实现',
    });
  }

  /** T10：abort 正在执行的 worker 会话。 */
  async abortSession(_workerId: string, _instanceId: string): Promise<never> {
    throw new NotImplementedException({
      code: WORKER_ERRORS.NOT_IMPLEMENTED,
      message: 'abortSession 由 T10 WorkerDispatcher 接入 WorkerClient 后实现',
    });
  }

  /** T10：下发 prompt 到 worker 会话。 */
  async dispatchPrompt(
    _workerId: string,
    _instanceId: string,
    _prompt: string,
  ): Promise<never> {
    throw new NotImplementedException({
      code: WORKER_ERRORS.NOT_IMPLEMENTED,
      message: 'dispatchPrompt 由 T10 WorkerDispatcher 接入 WorkerClient 后实现',
    });
  }

  /** 剩余容量 = capabilities.maxInstances - load.instances（load 缺省按 0）。 */
  private remainingCapacity(worker: {
    capabilities: Prisma.JsonValue;
    load: Prisma.JsonValue | null;
  }): number {
    const caps = (worker.capabilities ?? {}) as Partial<WorkerCapabilitiesShape>;
    const load = (worker.load ?? {}) as Partial<WorkerLoadShape>;
    return (caps.maxInstances ?? 0) - (load.instances ?? 0);
  }

  /** Worker 行 → 对外视图（剔除 tokenHash；T9：合并该 worker 最近上报的 mcpStatus）。 */
  private toWorkerView(worker: {
    id: string;
    name: string | null;
    opencodeVersion: string;
    capabilities: Prisma.JsonValue;
    load: Prisma.JsonValue | null;
    status: string;
    lastHeartbeatAt: Date | null;
    registeredAt: Date;
    defaultModelId: string | null;
  }) {
    return {
      id: worker.id,
      name: worker.name,
      opencodeVersion: worker.opencodeVersion,
      capabilities: worker.capabilities,
      load: worker.load,
      status: worker.status,
      lastHeartbeatAt: worker.lastHeartbeatAt,
      registeredAt: worker.registeredAt,
      defaultModelId: worker.defaultModelId,
      mcpStatus: this.workerMcpStatus.get(worker.id) ?? [],
    };
  }
}
