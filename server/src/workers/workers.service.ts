import {
  BadRequestException,
  ConflictException,
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
import { TASK_STATUS } from '../common/constants/task.constants';
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

/** P5：心跳 token 校验缓存 TTL ms（30s = 3 次心跳窗口，token 轮换后 30s 内旧结果过期）。 */
const TOKEN_CHECK_TTL_MS = 30_000;

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
  /**
   * 仓库凭证下发——worker 幂等写 ~/.keta-git-creds.json（600 权限，**不重启 serve**，
   * git 工具每次执行读文件）。命令一次有效（心跳取出即清空）；key 只经下行命令
   * 明文传输，不落 worker 日志。按 worker 承载活跃 agent 的授权仓库过滤打包。
   */
  GIT_CREDENTIALS: 'git-credentials',
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
 * 仓库凭证下发条目（repoUrl → 明文 SSH 私钥/HTTPS token，server 解密后经下行命令下发）。
 * 凭证面=worker 级：同 worker 承载的活跃 agent 共享已下发凭证（工具层按 repoUrl 白名单校验）。
 */
export interface GitCredentialEntry {
  repoUrl: string;
  authType: string;
  key: string;
  /** 脱敏标识（透传，worker 落盘供审计比对，不含明文）。 */
  fingerprint: string;
  /** 该仓库在 worker 凭证面上的最高授权权限（write > read；push 工具据此校验 write）。 */
  permission?: string;
}

/**
 * git-credentials 命令负载（对齐 worker GitCredentialsPayload，todo 3 双写）。
 * targetWorkerIds 空 = 全量；credentials 为空数组 = 清下发（吊销后 worker 移除条目）。
 */
export interface GitCredentialsPayload {
  credentials: GitCredentialEntry[];
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
  /** 命令负载：model-credentials 或 git-credentials 携带（其余 type 不携带） */
  payload?: ModelCredentialsPayload | GitCredentialsPayload;
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

  /** P5：心跳 token 校验结果缓存（workerId → 指纹+结果+时间）——避免每 10s 心跳重复
   *  bcrypt（CPU 密集，多 worker 并发/注册风暴时拖垮 DB 连接池，P5 心跳不稳定根因之一）。 */
  private readonly tokenCheckCache = new Map<
    string,
    { tokenHash: string; match: boolean; at: number }
  >();

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
    const tokenHash = await bcrypt.hash(
      workerToken,
      WORKER_TOKEN_BCRYPT_ROUNDS,
    );
    const now = new Date();
    // mcpUrl：worker 上报的内置 vteam MCP 地址覆盖（集群外 worker 用它替代
    // seed 的 PLATFORM_MCP_URL 内网名）；合并进 capabilities Json（不新增 DB 列），
    // McpServersService.findAll 按 x-worker-id 读取并覆盖内置 server url 下发。
    const capabilities = {
      ...(dto.capabilities as unknown as Record<string, unknown>),
      ...(dto.mcpUrl ? { mcpUrl: dto.mcpUrl } : {}),
    };
    const data = {
      name: dto.name ?? null,
      opencodeVersion: dto.opencodeVersion,
      capabilities: capabilities as Prisma.InputJsonValue,
      load: dto.load as unknown as Prisma.InputJsonValue,
      // C2：worker 上报默认模型——仅显式提供时更新（旧 worker 不携带时保留已有值，不误清 C8/PATCH 配置）
      ...(dto.defaultModelId !== undefined
        ? { defaultModelId: dto.defaultModelId || null }
        : {}),
      status: WORKER_STATUS.ONLINE,
      tokenHash,
      lastHeartbeatAt: now,
    };
    // C5b（容器重启凭据恢复）：worker 每次 register 都无条件回放全部未吊销凭据。
    // 容器重启后 auth.json 已被 worker 退出时 cleanupAuthJson 删除（明文零留存），
    // 但 DB worker 行 status 可能仍是 ONLINE（心跳 30s 才判 offline，重启注册远早于
    // 该窗口）→ 依赖 `existing.status === OFFLINE` 判断会漏回放 → opencode-go 等
    // 付费模型凭据永不恢复。故此处不再按状态区分，每次启动都回放。
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
    // C5（R5）：注册后回放全部未吊销凭据。无条件调用（见上方 C5b 说明：容器重启
    // 后 auth.json 已被删除且 DB status 仍 ONLINE，必须每次启动回放）。回放失败
    // （解密错/DB 错）不阻断注册，只打 warn 日志。
    await this.replayModelCredentials(worker.id);
    // 仓库凭证同理由：容器重启后 ~/.keta-git-creds.json 已随 homedir 消失（若容器
    // 重建）或 worker 侧退出清理，注册时一并回放当前活跃 agent 授权凭证。
    await this.replayGitCredentials(worker.id);
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
      select: { id: true, tokenHash: true, status: true, capabilities: true },
    });
    if (!worker) {
      throw new NotFoundException({
        code: WORKER_ERRORS.WORKER_NOT_FOUND,
        message: `Worker ${id} 不存在`,
      });
    }
    if (token && worker.tokenHash) {
      // P5：bcrypt 结果缓存（tokenHash 未变且 TTL 内复用）——worker 每 10s 心跳一次，
      // 免去每次 CPU 密集 bcrypt；token 轮换后 worker 重新注册更新 tokenHash → 指纹失效。
      const cached = this.tokenCheckCache.get(id);
      if (
        cached &&
        cached.tokenHash === worker.tokenHash &&
        Date.now() - cached.at < TOKEN_CHECK_TTL_MS
      ) {
        if (!cached.match) {
          throw new UnauthorizedException({
            code: WORKER_ERRORS.TOKEN_INVALID,
            message: `X-Worker-Token 与 worker ${id} 注册 token 不匹配`,
          });
        }
      } else {
        const match = await bcrypt.compare(token, worker.tokenHash);
        this.tokenCheckCache.set(id, {
          tokenHash: worker.tokenHash,
          match,
          at: Date.now(),
        });
        if (!match) {
          throw new UnauthorizedException({
            code: WORKER_ERRORS.TOKEN_INVALID,
            message: `X-Worker-Token 与 worker ${id} 注册 token 不匹配`,
          });
        }
      }
    }
    const status =
      dto.health === 'degraded' ? WORKER_STATUS.DEGRADED : WORKER_STATUS.ONLINE;
    // T8c：MCP 三态快照 → 内存状态存储（前端 GET /mcp-servers 合并展示）
    // T9：另按 workerId 关联保存，worker 详情接口返回（前端 worker 详情页展示）
    if (dto.mcpStatus && dto.mcpStatus.length > 0) {
      this.mcpServers.applyHeartbeatStatus(dto.mcpStatus);
      this.workerMcpStatus.set(id, dto.mcpStatus);
    }
    const lastHeartbeatAt = new Date();
    const caps = (worker.capabilities ?? {}) as Partial<{
      maxInstances: number;
    }>;
    const maxInstances = caps.maxInstances ?? 5;
    const rawInstances =
      (dto.load as Partial<{ instances: number }>)?.instances ?? 0;
    let safeInstances = rawInstances;
    if (rawInstances > maxInstances * 3) {
      this.logger.warn(
        `[workers] worker ${id} 上报异常负载 ${rawInstances}/${maxInstances} 已钳制为 ${maxInstances}（疑似计数泄漏）`,
      );
      safeInstances = maxInstances;
    }
    const safeLoad = {
      instances: safeInstances,
    } as unknown as Prisma.InputJsonValue;
    await this.prisma.worker.update({
      where: { id },
      data: {
        load: safeLoad,
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
      await this.replayGitCredentials(id);
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
        ...(targetWorkerIds && targetWorkerIds.length > 0
          ? { targetWorkerIds }
          : {}),
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
   * 仓库凭证下发（唯一化分发入口，凭证面=worker 级）。
   * - 活跃 agent 判定：taskAgent.removedAt=null 且关联 task 未终态（completed/archived，
   *   沿用 tasks 模块 TASK_STATUS 常量）——worker 单容器承载多任务多 agent，按活跃
   *   task 关联过滤，避免向已结束任务的 agent 下发凭证；
   * - 收集这些 agent 被授权且未吊销的 repoUrl 集合 → 过滤未吊销 GitCredential →
   *   解密 key 明文打包 GitCredentialsPayload → 对每个目标 worker enqueueCommand
   *   （**查库 orderBy repoUrl asc 保证幂等对比稳定**）；
   * - 目标 worker：targetWorkerIds 非空 → 定向；空 → 在线 worker（status != offline）；
   * - 返回下发目标 worker 数。key 明文只进命令 payload 内存，不落本服务日志。
   */
  async dispatchGitCredentials(targetWorkerIds?: string[]): Promise<number> {
    let workerIds: string[];
    if (targetWorkerIds && targetWorkerIds.length > 0) {
      workerIds = [...targetWorkerIds];
    } else {
      const online = await this.prisma.worker.findMany({
        where: { status: { not: WORKER_STATUS.OFFLINE } },
        select: { id: true },
      });
      workerIds = online.map((w) => w.id);
    }
    if (workerIds.length === 0) {
      return 0;
    }
    const repoUrls = await this.resolveWorkerActiveRepoUrls();
    const credentials = await this.buildGitCredentialsPayload(repoUrls);
    if (credentials === null) {
      // 从未配置任何 git 凭证 → 无命令可下发（对齐模型凭据「无未吊销凭据跳过」语义）
      return 0;
    }
    const command: WorkerCommand = {
      type: WORKER_COMMAND_TYPES.GIT_CREDENTIALS,
      resourceVersion: 'git-credentials',
      payload: {
        credentials,
        ...(targetWorkerIds && targetWorkerIds.length > 0
          ? { targetWorkerIds }
          : {}),
      },
    };
    for (const id of workerIds) {
      this.enqueueCommand(id, command);
    }
    this.logger.log(
      `git 凭证下发：worker=${workerIds.length} 个 credentials=${credentials.length}`,
    );
    return workerIds.length;
  }

  /**
   * 仓库凭证回放（注册/重注册、offline→online 心跳恢复时调用，仿 replayModelCredentials）。
   * 定向到单个 worker 复用 dispatchGitCredentials 的活跃 agent 过滤打包逻辑；
   * 失败不阻断注册/心跳，只打 warn。
   */
  async replayGitCredentials(workerId: string): Promise<void> {
    try {
      await this.dispatchGitCredentials([workerId]);
    } catch (err) {
      this.logger.warn(
        `git 凭证回放失败（不阻断）: worker=${workerId} ${(err as Error).message}`,
      );
    }
  }

  /**
   * 活跃 agent 授权仓库解析（dispatch/replay 复用，凭证池分离后）：
   * ① taskAgent（removedAt=null）+ 关联 task 未终态 → 活跃 agent 集合；
   * ② 这些 agent 的未吊销 GitRepoGrant(repoId) → repoId → 最高权限映射；
   * ③ GitRepo(repoId→repoUrl) 转换为 repoUrl→permission，供 build 阶段按 repoUrl 过滤。
   * 返回空 Map → 无任何授权仓库（打包结果为 credentials=[]，仍下发清 worker 侧条目）。
   */
  private async resolveWorkerActiveRepoUrls(): Promise<Map<string, string>> {
    const activeTaskAgents = await this.prisma.taskAgent.findMany({
      where: {
        removedAt: null,
        task: {
          status: { notIn: [TASK_STATUS.completed, TASK_STATUS.archived] },
        },
      },
      select: { agentId: true },
      distinct: ['agentId'],
    });
    if (activeTaskAgents.length === 0) {
      return new Map();
    }
    const agentIds = activeTaskAgents.map((t) => t.agentId);
    const grants = await this.prisma.gitRepoGrant.findMany({
      where: { agentId: { in: agentIds }, revokedAt: null },
      select: { repoId: true, permission: true },
    });
    // 同一仓库多 agent 授权时取最高权限（write > read）
    const permByRepoId = new Map<string, string>();
    for (const g of grants as any[]) {
      const current = permByRepoId.get(g.repoId);
      if (g.permission === 'write' || !current) {
        permByRepoId.set(g.repoId, g.permission);
      }
    }
    if (permByRepoId.size === 0) return new Map();
    const repoIds = Array.from(permByRepoId.keys());
    const repos = await (this.prisma as any).gitRepo.findMany({
      where: { id: { in: repoIds }, revokedAt: null },
      select: { id: true, repoUrl: true },
    });
    const permByRepoUrl = new Map<string, string>();
    for (const r of repos as any[]) {
      const perm = permByRepoId.get(r.id);
      if (perm) permByRepoUrl.set(r.repoUrl, perm);
    }
    return permByRepoUrl;
  }

  /**
   * 仓库凭证 → 解密打包（orderBy repoUrl asc 幂等；内存过滤到授权集合，凭证池分离后改为 Repo→Credential join）。
   * 返回 null 表示从未配置任何仓库（调用方跳过下发）；返回空数组表示有仓库但全部已吊销/无授权（下发空 payload 清 worker 侧条目）。
   * key 明文仅存在于返回数组（进命令 payload），不落日志。
   */
  private async buildGitCredentialsPayload(
    repoPerm: Map<string, string>,
  ): Promise<GitCredentialEntry[] | null> {
    const totalCount = await (this.prisma as any).gitRepo.count();
    if (totalCount === 0) {
      return null;
    }
    const repos = await (this.prisma as any).gitRepo.findMany({
      where: { revokedAt: null },
      orderBy: [{ repoUrl: 'asc' }],
      select: { repoUrl: true, credentialId: true },
    });
    if (repos.length === 0) return [];
    const credentialIds = [
      ...new Set((repos as any[]).map((r: any) => r.credentialId)),
    ];
    const credentials = await this.prisma.gitCredential.findMany({
      where: { id: { in: credentialIds }, revokedAt: null },
      select: {
        id: true,
        authType: true,
        credentialRef: true,
        fingerprint: true,
      },
    });
    const credById = new Map((credentials as any[]).map((c) => [c.id, c]));
    const result: GitCredentialEntry[] = [];
    for (const r of repos as any[]) {
      if (!repoPerm.has(r.repoUrl)) continue;
      const cred = credById.get(r.credentialId);
      if (!cred) continue;
      result.push({
        repoUrl: r.repoUrl,
        authType: cred.authType,
        key: this.credentialCrypto.decrypt(cred.credentialRef),
        fingerprint: cred.fingerprint,
        permission: repoPerm.get(r.repoUrl),
      });
    }
    return result;
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
  async assignWorker(req: AssignmentRequirement = {}): Promise<string | null> {
    const need = Math.max(1, req.instances ?? 1);
    const candidates = await this.prisma.worker.findMany({
      where: { status: { not: WORKER_STATUS.OFFLINE } },
      // C7：附带模型可用性（modelAvailabilities → 每个 enabled 模型），供 modelId 过滤；
      // availability 无行（该 worker 从未上报）→ 降级不受过滤约束。
      // model 需带回 providerID/modelID：availability.modelId 是 models 主键（md_），
      // 模型过滤按 `providerID/modelID` 拼接匹配（见 matchesModelRequirement）。
      include: {
        modelAvailabilities: {
          include: {
            model: {
              select: { enabled: true, providerID: true, modelID: true },
            },
          },
        },
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
   * - 已上报：availability 关联 Model 的 `providerID/modelID` 与 modelId 一致且 enabled → 通过
   *   （availability.modelId 是 models 表 md_ 主键，不可直接比对，须经关联 model 拼接 provider/model）
   */
  private matchesModelRequirement(
    worker: {
      defaultModelId: string | null;
      modelAvailabilities?: Array<{
        modelId: string;
        model?: { enabled: boolean; providerID?: string; modelID?: string };
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
    return avail.some(
      (a) =>
        a.model?.enabled !== false &&
        `${a.model?.providerID}/${a.model?.modelID}` === modelId,
    );
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
    if (
      defaultModelId !== null &&
      defaultModelId !== undefined &&
      defaultModelId !== ''
    ) {
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

  /**
   * DELETE /workers/:id 删除离线 worker（workers.delete 保护）。
   * - 不存在 → 404 WORKER_NOT_FOUND；
   * - 非 offline（online/degraded）→ 409 WORKER_ONLINE_NOT_REMOVABLE（防运行中误删，
   *   先经 shutdown/下线后再删）；
   * - offline → 事务内清理全部 workerId 外键引用（schema onDelete: Restrict，不依赖
   *   DB 级联）后物理删除：worker_model_availabilities 硬删、task_group_instances 硬删
   *   （软删 removedAt 不解除 FK Restrict，必须删行）、sessions.workerId/instanceRef 置空、
   *   agents.workerId 置空（软绑定"首选 worker"）；成功同步清理该 worker 的
   *   workerMcpStatus/pendingCommands 内存态。
   */
  async remove(id: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!worker) {
      throw new NotFoundException({
        code: WORKER_ERRORS.WORKER_NOT_FOUND,
        message: `Worker ${id} 不存在`,
      });
    }
    if (worker.status !== WORKER_STATUS.OFFLINE) {
      throw new ConflictException({
        code: WORKER_ERRORS.WORKER_ONLINE_NOT_REMOVABLE,
        message: '仅离线 Worker 可删除，请先停止/下线',
      });
    }
    await this.prisma.$transaction([
      this.prisma.workerModelAvailability.deleteMany({
        where: { workerId: id },
      }),
      this.prisma.taskGroupInstance.deleteMany({ where: { workerId: id } }),
      this.prisma.session.updateMany({
        where: { workerId: id },
        data: { workerId: null, instanceRef: null },
      }),
      this.prisma.agent.updateMany({
        where: { workerId: id },
        data: { workerId: null },
      }),
      this.prisma.worker.delete({ where: { id } }),
    ]);
    this.workerMcpStatus.delete(id);
    this.pendingCommands.delete(id);
    return { id, deleted: true };
  }

  // ---- LifecycleManager 骨架（T10 WorkerDispatcher 接入 WorkerClient 后实现，本任务不接 T8） ----

  /** T10：在 worker 上创建 opencode 会话实例。 */
  async createInstance(_workerId: string, _sessionId: string): Promise<never> {
    throw new NotImplementedException({
      code: WORKER_ERRORS.NOT_IMPLEMENTED,
      message:
        'createInstance 由 T10 WorkerDispatcher 接入 WorkerClient 后实现',
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
      message:
        'dispatchPrompt 由 T10 WorkerDispatcher 接入 WorkerClient 后实现',
    });
  }

  /** 剩余容量 = capabilities.maxInstances - load.instances（load 缺省按 0）。 */
  private remainingCapacity(worker: {
    capabilities: Prisma.JsonValue;
    load: Prisma.JsonValue | null;
  }): number {
    const caps = (worker.capabilities ??
      {}) as Partial<WorkerCapabilitiesShape>;
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
