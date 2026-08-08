import {
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
import { PrismaService } from '../prisma/prisma.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { McpStatusEntryDto } from '../mcp-servers/dto/mcp-status.dto';
import { HeartbeatWorkerDto } from './dto/heartbeat-worker.dto';
import { RegisterWorkerDto } from './dto/register-worker.dto';
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
}

/** 下行命令 type 枚举（T4a 命令通道；09 §3.9 预留 {command?}，pull 模型心跳携带）。 */
export const WORKER_COMMAND_TYPES = {
  /** 资源（skills/tools/mcp 配置）变更：worker 重拉 + 注入 + 重启（T4b/T4c 执行） */
  RELOAD_CONFIG: 'reload-config',
} as const;

export type WorkerCommandType =
  (typeof WORKER_COMMAND_TYPES)[keyof typeof WORKER_COMMAND_TYPES];

/**
 * 心跳响应携带的下行命令（T4a）。
 * 设计为通用 commands 数组（复用点：AgentsModule 配置变更重启也走此通道，09 §3.7），
 * 命令仅一次有效：心跳取出即清空，worker 离线期间的命令丢弃（上线后由注册/重拉对齐）。
 */
export interface WorkerCommand {
  type: WorkerCommandType;
  /** 资源版本号：T1/T2 变更时递增，worker 侧据此判断是否需重拉注入 */
  resourceVersion: string;
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
      status: WORKER_STATUS.ONLINE,
      tokenHash,
      lastHeartbeatAt: now,
    };
    const worker = await this.prisma.worker.upsert({
      where: { id: dto.workerId },
      create: { id: dto.workerId, ...data },
      update: data,
    });
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
      select: { id: true, tokenHash: true },
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
      .sort((a, b) => {
        const aOnline = a.worker.status === WORKER_STATUS.ONLINE ? 1 : 0;
        const bOnline = b.worker.status === WORKER_STATUS.ONLINE ? 1 : 0;
        if (aOnline !== bOnline) return bOnline - aOnline;
        return b.capacity - a.capacity;
      });
    return ranked[0]?.worker.id ?? null;
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
      mcpStatus: this.workerMcpStatus.get(worker.id) ?? [],
    };
  }
}
