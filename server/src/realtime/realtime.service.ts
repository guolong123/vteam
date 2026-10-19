import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'events';
import { Prisma } from '@prisma/client';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 事件作用域（09 篇 §4.2 订阅粒度）。
 * - task:<id> / channel:<id> / team:<id>：仅广播归属该资源的事件
 * - global：全局事件（scopeId 为 null）
 */
export type RealtimeScopeType = 'task' | 'channel' | 'team' | 'global';

export interface RealtimeScope {
  type: RealtimeScopeType;
  id?: string;
}

/**
 * 统一事件帧（09 篇 §4.1）。
 * id 为字符串主键（`ev_<零填充序号>`，数值序 == 字典序），断线续拉按此续接。
 * scopeType/scopeId 为订阅过滤元数据，SSE 下发帧仍为 {id, type, payload, timestamp}。
 */
export interface RealtimeEvent {
  id: string;
  type: string;
  payload: unknown;
  timestamp: string;
  scopeType: RealtimeScopeType;
  scopeId: string | null;
  /**
   * 团队域归属（scope=all 全量订阅时的可见团队过滤依据；内存路由字段，不落库、不下发）：
   * - team scope → scopeId；channel scope → 频道 teamId（团队频道）或其任务 teamId（任务频道）；
   * - task scope → 任务 teamId；global scope → payload taskId 反查的任务 teamId；
   * - 无法归属 → null（scope=all 团队过滤不放行，防信息泄露）。
   */
  teamId?: string | null;
}

export type RealtimeEventType = string;
export type RealtimeEventListener = (event: RealtimeEvent) => void;

/** 事件 id 域前缀（对齐 15 篇 §2.2 主键策略：<prefix>_<零填充序号>）。 */
export const EVENT_ID_PREFIX = 'ev';

const DEFAULT_MAX_LOG = 1000;

/**
 * 补拉单次返回的历史事件硬上限（incident-realtime-replay-fix）。
 *
 * 事故背景：realtime_events 曾涨到 460,481 行 / 26GB（payload 以 message.part.delta
 * 增量帧为主）且无保留策略；一个不带游标的订阅连接会走「整个 scope 全量重放」路径把
 * 整表读进内存，server 被反复 OOMKilled。无论有无游标，getEventsSince 的 findMany
 * 一律 take 到此上限——补拉内存占用有硬顶，杜绝无界读。
 */
export const REALTIME_REPLAY_MAX = 1000;

/**
 * realtime_events 保留窗口缺省 24h（env `REALTIME_EVENTS_RETENTION_WINDOW_MS` 覆盖，
 * 毫秒；≤0 = 停清理）。周期删除 createdAt 早于 `now - 窗口` 的行，把表按时间窗收敛,
 * 防止无限流的历史帧再次把表撑回 26GB。
 */
export const REALTIME_EVENTS_RETENTION_WINDOW_MS_DEFAULT = 24 * 60 * 60 * 1000;
export const REALTIME_EVENTS_RETENTION_WINDOW_MS_ENV =
  'REALTIME_EVENTS_RETENTION_WINDOW_MS';

/** 保留清理周期缺省 1h（env `REALTIME_EVENTS_RETENTION_INTERVAL_MS` 覆盖，毫秒；≤0 = 停周期）。 */
export const REALTIME_EVENTS_RETENTION_INTERVAL_MS_DEFAULT = 60 * 60 * 1000;
export const REALTIME_EVENTS_RETENTION_INTERVAL_MS_ENV =
  'REALTIME_EVENTS_RETENTION_INTERVAL_MS';

/**
 * 内存事件日志的**序列化字节预算**（incident-realtime-log-byte-cap）。
 *
 * 事故背景（2026-10 生产 OOM，2GiB cgroup 反复 OOMKilled）：内存日志原先只按
 * 条数收敛（DEFAULT_MAX_LOG=1000），但每条 message.part.delta 都带一份**全量
 * message 快照**（长流式回复单份 ~1MB），1000 条 × 1MB ≈ 1GB 常驻内存且被
 * GC 钉住（RSS 线性增长的主因之一）。条数上限对「单条巨大」完全失明。
 *
 * 本预算在条数上限之外追加**按字节**收敛：压入后若保留的序列化总字节
 * （Σ JSON.stringify(entry) 的 UTF-8 长度；与落库/下发同一 JSON 形态）超过
 * 预算，就从**头部淘汰最旧条目**直到低于预算。最坏保留量 = 预算 + 最新一条
 * 的体积（恒保留最新条目，latest-id 游标语义不因淘汰而丢失；单条即超预算时
 * 该条仍保留，日志长度 ≥ 1）。
 *
 * 取 8MiB：约为事故前最坏 ~1GB 保留量的 1/128，仍能容纳全部非 delta 事件
 * （delta 帧已不再进日志，见 REALTIME_NON_RETAINED_TYPES）。
 */
export const REALTIME_LOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * **不保留全量快照**的流式增量帧类型集合（incident-realtime-log-byte-cap）。
 *
 * message.part.delta 每帧携带累积后的全量 message 快照（toMessageDto 的
 * content.text/parts，长流式回复可到 1MB+）。若照常落库 + 进内存日志：
 *  - realtime_events 表：每 delta 一行全量快照（事故前 460,481 行 / 26GB，
 *    其中 100% 为 message.part.delta）；
 *  - 内存日志：最多保留 1000 份全量快照（~1GB 常驻，被 GC 钉住）。
 * 两者都被「每 delta 一份全量快照」线性撑大，是 OOM 的直接驱动。
 *
 * 选择（最小变更、SSE wire 契约不变）：该类型**只做实时广播**——bus.emit
 * 仍携带完整 payload，在线订阅者收到的帧逐字节不变——但
 *  - 不写 realtime_events：终帧 chat.message.new 由 worker-dispatcher / 用户
 *    发送路径落库广播，消息内容以 messages 表 + REST 历史为准；
 *  - 不进内存日志的全量形态，只保留识别字段（messageId/channelId，见
 *    toLogEntry / compactDeltaPayload），日志里一条 ≈ 200B（含帧头）。
 *
 * 代价（显式声明）：断线重连的客户端不再经 SSE 补拉到流式中遗漏的 delta 帧。
 * 重连后的收敛依赖：(1) **REST 历史路径**——ingress 每 delta 都把 messages
 * 行更新为最新累积内容，重连页面拉历史即得最新进度；(2) 终帧 chat.message.new
 * 的重放（该帧照常落库）。此外 delta 帧消耗的 ev_ 序号在表中留空洞，进程重启
 * 后 id 计数器按库内最大值重新起号（P2002 自愈兜底 DB 主键冲突），极端情况下
 * 落后客户端的游标去重可能跳过极少事件——在滚动更新 + 超长流式叠加时出现。
 *
 * 曾评估「落紧凑行 + 重放」并被否决：前端 use-realtime.ts 的
 * message.part.delta 分支要求 payload.message 是完整 RealtimeChatMessage
 * （upsertMessage 直读 channelId/id，缺失即抛），任何非全量重放帧都会击穿
 * UI，且 web/ 由其他 lane 持有、不能改。
 */
const REALTIME_NON_RETAINED_TYPES: ReadonlySet<string> = new Set<string>([
  EVENT_TYPES.MESSAGE_PART_DELTA,
]);

/**
 * RealtimeService —— 内部事件总线（EventEmitter）+ 事件持久化基座。
 *
 * 职责（08 §7.3 事件先落库后转发）：
 *  - emit/broadcast：分配字符串 id（ev_<序号>），先写 realtime_events 表再经总线广播
 *  - subscribe(listener, scopes?)：按 scope 数组过滤实时事件（任一命中即转发；无 scope = 全局全量）
 *  - getEventsSince(since, scopes?)：以 DB 为准按 since 补拉历史事件，scope 数组构造 OR 查询（09 篇 §4.4）
 *  - 内存环形缓冲保留为实时层（最近 maxLog 条，且序列化总字节 ≤
 *    REALTIME_LOG_MAX_BYTES），补拉以 DB 为准
 */
@Injectable()
export class RealtimeService implements OnModuleInit {
  private readonly bus = new EventEmitter();

  /** 已发出事件的内存环形缓冲（id 升序），供实时层快速感知游标位。 */
  private readonly log: RealtimeEvent[] = [];

  private readonly maxLog = DEFAULT_MAX_LOG;

  /**
   * 与 `log` 平行的「每条序列化字节数」（push/shift 严格同步），加运行总和
   * `logBytesTotal`——按字节收敛时的摊销 O(1) 记账，无需每次重算全量
   * （incident-realtime-log-byte-cap）。
   */
  private readonly logSizes: number[] = [];

  private logBytesTotal = 0;

  private readonly logger = new Logger(RealtimeService.name);

  /** 保留清理周期句柄（WorkersService healthTimer 同款：原生 setInterval + unref）。 */
  private retentionTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /** 进程启动：对齐库内 ev_ 前缀已有最大序号（重启续号），并起保留清理周期。 */
  async onModuleInit(): Promise<void> {
    const last = await this.prisma.realtimeEvent.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (last) {
      this.idGen.seed(EVENT_ID_PREFIX, this.parseSeq(last.id));
    }
    this.ensureRetentionInterval();
  }

  onModuleDestroy(): void {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = undefined;
    }
  }

  /**
   * 发布一条事件：先落库（Prisma realtime_events）后转发（08 §7.3）。
   * scope 缺省为 global；返回完整事件帧（含字符串 id 游标）。
   *
   * is_0000000040：k8s 滚动更新窗口内新旧 pod 并存，各自进程内计数器从相近 seed
   * 生成重叠 ev_ 序号 → realtimeEvent.create PRIMARY 冲突。代码自愈：
   * 捕获 P2002 唯一约束冲突 → 重新读取 DB 当前最大 ev_ 序号 seed 计数器 →
   * 重新生成 id 重试（限 3 次）。单实例设计下任何并存窗口自动收敛，不向上抛 500。
   */
  async emit(
    type: RealtimeEventType,
    payload: unknown,
    scope?: RealtimeScope,
  ): Promise<RealtimeEvent> {
    const resolved: RealtimeScope = scope ?? { type: 'global' };
    const maxRetries = 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.emitOnce(type, payload, resolved);
      } catch (err) {
        if (attempt >= maxRetries || !this.isPrimaryConflict(err)) {
          throw err;
        }
        // P2002 冲突：多实例并存窗口，重新对齐 DB 最大序号后重试
        await this.reseedFromDb();
      }
    }
  }

  /** 单次事件发布（id 生成 + 落库 + 内存缓冲 + 总线广播）。 */
  private async emitOnce(
    type: RealtimeEventType,
    payload: unknown,
    resolved: RealtimeScope,
  ): Promise<RealtimeEvent> {
    const event: RealtimeEvent = {
      id: await this.idGen.nextId(EVENT_ID_PREFIX),
      type,
      payload,
      timestamp: new Date().toISOString(),
      scopeType: resolved.type,
      scopeId: resolved.id ?? null,
    };

    event.teamId = await this.resolveTeamIdOfEvent(event);

    // delta 增量帧不落库：全量快照一个字都不进 realtime_events
    // （事故前 26GB 表的来源；终帧 chat.message.new 照常落库，见
    //  REALTIME_NON_RETAINED_TYPES 的取舍说明）。广播仍带完整 payload。
    if (!REALTIME_NON_RETAINED_TYPES.has(type)) {
      await this.prisma.realtimeEvent.create({
        data: {
          id: event.id,
          type: event.type,
          scopeType: event.scopeType,
          scopeId: event.scopeId,
          payload: event.payload as Prisma.InputJsonValue,
        },
      });
    }

    this.retainInLog(this.toLogEntry(event));
    this.bus.emit('event', event);
    return event;
  }

  /**
   * 构造进入**内存日志**的条目（incident-realtime-log-byte-cap）：非 delta
   * 事件原样入日志；delta 增量帧剥掉全量 message 快照，只留识别字段
   * （messageId/channelId）——否则 1000 条 × ~1MB 快照常驻 ≈ 1GB。
   * 广播与返回值始终用原始 `event`（全量载荷），不动 wire 契约。
   */
  private toLogEntry(event: RealtimeEvent): RealtimeEvent {
    if (!REALTIME_NON_RETAINED_TYPES.has(event.type)) {
      return event;
    }
    return { ...event, payload: this.compactDeltaPayload(event.payload) };
  }

  /** delta 帧的保留态载荷：只留目标消息识别字段（剥离 content 全量快照与 delta 正文）。 */
  private compactDeltaPayload(payload: unknown): {
    messageId: string | null;
    channelId: string | null;
  } {
    const message = (
      payload as
        { message?: { id?: unknown; channelId?: unknown } } | null | undefined
    )?.message;
    return {
      messageId: typeof message?.id === 'string' ? message.id : null,
      channelId:
        typeof message?.channelId === 'string' ? message.channelId : null,
    };
  }

  /**
   * 压入内存环形缓冲并按两个上限收敛（incident-realtime-log-byte-cap）：
   *  1) 条数上限 `maxLog`（既有语义）；
   *  2) 字节预算 REALTIME_LOG_MAX_BYTES：保留的序列化总字节超预算时，从
   *     **头部淘汰最旧条目**直到低于预算。
   * 正确性：淘汰只从头部删——数组其余项相对顺序不变（id 升序不被破坏），
   * 且恒保留最新条目 → `getLatestId()` 的最新 id 游标语义不丢失（单条即超
   * 预算时该条仍保留，日志长度 ≥ 1，日志永不为空除非从未 emit）。
   */
  private retainInLog(entry: RealtimeEvent): void {
    this.log.push(entry);
    const size = this.measureRetainedBytes(entry);
    this.logSizes.push(size);
    this.logBytesTotal += size;
    while (this.log.length > this.maxLog) {
      this.evictLogHead();
    }
    while (this.logBytesTotal > REALTIME_LOG_MAX_BYTES && this.log.length > 1) {
      this.evictLogHead();
    }
  }

  /** 从头部淘汰最旧条目，同步字节记账（log 与 logSizes 严格平行）。 */
  private evictLogHead(): void {
    const removed = this.log.shift();
    const size = this.logSizes.shift();
    if (removed !== undefined && size !== undefined) {
      this.logBytesTotal -= size;
    }
  }

  /** 序列化保留字节（UTF-8）：与落库 / SSE 下发同一 JSON 形态，作为保留占地。 */
  private measureRetainedBytes(value: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    } catch {
      // 不可 JSON 化的极端兜底：按 4KB 保守估算，绝不让计量抛错打断事件流
      return 4096;
    }
  }

  /** is_0000000040：P2002 PRIMARY 唯一约束冲突判定（Prisma 冲突错误）。 */
  private isPrimaryConflict(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const anyErr = err as { code?: string; meta?: { target?: unknown } };
    if (anyErr.code !== 'P2002') return false;
    const target = Array.isArray(anyErr.meta?.target) ? anyErr.meta.target : [];
    // 主键冲突（PRIMARY）才自愈重试；其他唯一约束冲突（如业务字段）不吞
    return target.includes('PRIMARY');
  }

  /** is_0000000040：重新读取 DB 当前最大 ev_ 序号 seed 计数器（多实例冲突后收敛）。 */
  private async reseedFromDb(): Promise<void> {
    const last = await this.prisma.realtimeEvent.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (last) {
      this.idGen.seed(EVENT_ID_PREFIX, this.parseSeq(last.id));
    }
  }

  /** broadcast 即 emit 的语义别名，供其他模块以「广播」语义注入事件。 */
  broadcast(
    type: RealtimeEventType,
    payload: unknown,
    scope?: RealtimeScope,
  ): Promise<RealtimeEvent> {
    return this.emit(type, payload, scope);
  }

  /**
   * 按 scope 数组订阅实时事件流，返回取消订阅函数。
   * 无 scope = 全局全量；有 scope 数组时仅推送命中任一 scope 的事件
   * （多 scope 合并订阅，如 channel:<id> + task:<id> + global 一条连接）。
   * scope=all 全量订阅时调用方传入可见团队集（visibleTeamIds，teamUserMember 推导）：
   * 命中即放行；null = 不过滤。
   */
  subscribe(
    listener: RealtimeEventListener,
    scopes?: RealtimeScope | RealtimeScope[],
    visibleTeamIds?: string[] | null,
  ): () => void {
    const scopeList = this.toScopeList(scopes);
    const teamFilter = this.toTeamFilter(visibleTeamIds);
    const needsFilter = scopeList.length > 0 || teamFilter !== null;
    const wrapped: RealtimeEventListener = needsFilter
      ? (event) => {
          if (!this.passesVisibility(event, teamFilter)) {
            return;
          }
          if (
            scopeList.length > 0 &&
            !scopeList.some((s) => this.scopeMatches(event, s))
          ) {
            return;
          }
          listener(event);
        }
      : listener;
    this.bus.on('event', wrapped);
    return () => this.bus.off('event', wrapped);
  }

  /**
   * 以 DB 为准补拉历史事件（断线续拉，09 篇 §4.4）。**至多返回 REALTIME_REPLAY_MAX 条**，
   * 事件帧按 id 升序下发。三种入参语义：
   *  - 显式游标 `since=<eventId>`（非空且非 latest）：返回 id 大于 since 的历史事件，至多
   *    硬上限 REALTIME_REPLAY_MAX 条且**优先最新**——降序 take 后 reverse 成升序，让落后
   *    太多的客户端从最新状态续接，而非顺序吐出巨量 backlog（26GB 表 OOM 止血）。
   *  - `since === 'latest'` 或 since 缺省/空串：**跳过历史重放**，以当前最新已落库事件 id
   *    为游标，仅返回其后新产生的事件（首连只订阅增量）。库空（无最新 id）→ 不设 id 条件,
   *    findMany 自然返回空，连接建立期间的竞态事件由 controller 续拉缓冲 + 去重兜底。
   *    **缺省与 latest 等价 ⇒ 无游标的「全量重放」路径被彻底消除。**
   *  - scope 未指定时不过滤；多 scope 以 OR 组合查询（任一 scope 命中即返回）。
   */
  async getEventsSince(
    since?: string,
    scopes?: RealtimeScope | RealtimeScope[],
    visibleTeamIds?: string[] | null,
  ): Promise<RealtimeEvent[]> {
    const where: Prisma.RealtimeEventWhereInput =
      this.buildScopeWhereList(scopes);
    // 无游标（缺省/空串）与 'latest' 一律「仅续增量」：以当前最新 id 为游标，绝不重放历史。
    const skipReplay =
      since === 'latest' ||
      since === undefined ||
      since === null ||
      since === '';
    if (skipReplay) {
      const latest = await this.prisma.realtimeEvent.findFirst({
        orderBy: { id: 'desc' },
        select: { id: true },
      });
      // 库空（无最新 id）→ 不设 id 条件，findMany 自然返回空，仅收之后新事件
      if (latest) {
        where.id = { gt: latest.id };
      }
    } else {
      where.id = { gt: since as string };
    }
    // skipReplay：升序（自然增量序）；显式游标：降序取最新 N 条（落后太多时从最新续接）。
    // 两条路径都 take 到 REALTIME_REPLAY_MAX 硬上限，杜绝无界读把进程 OOM。
    const rows = await this.prisma.realtimeEvent.findMany({
      where,
      orderBy: skipReplay ? { id: 'asc' } : { id: 'desc' },
      take: REALTIME_REPLAY_MAX,
    });
    let events = rows.map(this.fromRow);
    // 降序取 → reverse 成升序下发（skipReplay 路径本就是升序，无需 reverse）。
    if (!skipReplay) {
      events.reverse();
    }
    if (visibleTeamIds === null || visibleTeamIds === undefined) {
      return events;
    }
    // scope=all 团队域补拉：DB 行无团队归属列，按频道/任务批量归属后
    // 以同一可见性谓词（passesVisibility + teamFilter）精确过滤。
    await this.attachEventTeams(events);
    const teamFilter = this.toTeamFilter(visibleTeamIds);
    events = events.filter((e) => this.passesVisibility(e, teamFilter));
    events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return events;
  }

  /**
   * 保留清理（incident-realtime-replay-fix）：删除 realtime_events 中 createdAt 早于
   * cutoff = now - 保留窗口 的行，把表按时间窗收敛，防无限流历史帧（message.part.delta
   * 为主）把表撑回 26GB 再次 OOM。now 可注入以便测试固定 cutoff；窗口 ≤ 0 → 停清理返回 0。
   * 删除谓词 `created_at < cutoff` 由迁移建的 idx_realtime_events_created_at 支撑，
   * 否则每次清理退化为 26GB 全表扫描 + 删除，本身足以拖垮 DB。
   */
  async pruneExpiredEvents(now: Date = new Date()): Promise<number> {
    const windowMs = this.retentionWindowMs();
    if (windowMs <= 0) {
      return 0;
    }
    const cutoff = new Date(now.getTime() - windowMs);
    const { count } = await this.prisma.realtimeEvent.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }

  /** 起保留清理周期（WorkersService healthTimer 同款：原生 setInterval + unref，不引入 @nestjs/schedule）。 */
  private ensureRetentionInterval(): void {
    if (this.retentionIntervalMs() <= 0) {
      return;
    }
    if (this.retentionTimer) {
      return;
    }
    this.retentionTimer = setInterval(() => {
      void this.pruneExpiredEvents(new Date()).catch((err: unknown) =>
        this.logger.error(
          `[retention] realtime_events 旧事件清理失败: ${this.describeError(err)}`,
        ),
      );
    }, this.retentionIntervalMs());
    this.retentionTimer.unref?.();
  }

  private describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private retentionWindowMs(): number {
    return this.readMsEnv(
      REALTIME_EVENTS_RETENTION_WINDOW_MS_ENV,
      REALTIME_EVENTS_RETENTION_WINDOW_MS_DEFAULT,
    );
  }

  private retentionIntervalMs(): number {
    return this.readMsEnv(
      REALTIME_EVENTS_RETENTION_INTERVAL_MS_ENV,
      REALTIME_EVENTS_RETENTION_INTERVAL_MS_DEFAULT,
    );
  }

  /** env 覆盖读毫秒数：缺省/空/非数字 → fallback 默认值（trigger-reconciler 同款）。 */
  private readMsEnv(envKey: string, fallback: number): number {
    const raw = process.env[envKey];
    if (raw === undefined || raw === '') {
      return fallback;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  /** 当前游标（最新已发事件 id）；无事件时返回 null。 */
  getLatestId(): string | null {
    if (this.log.length === 0) {
      return null;
    }
    return this.log[this.log.length - 1].id;
  }

  /** 将 DB 行映射为统一事件帧（createdAt → ISO8601 timestamp；团队归属为内存字段，补拉时按需归属）。 */
  private fromRow(row: {
    id: string;
    type: string;
    scopeType: string;
    scopeId: string | null;
    payload: unknown;
    createdAt: Date;
  }): RealtimeEvent {
    return {
      id: row.id,
      type: row.type,
      payload: row.payload,
      timestamp: row.createdAt.toISOString(),
      scopeType: row.scopeType as RealtimeScopeType,
      scopeId: row.scopeId,
    };
  }

  /** 事件是否命中订阅 scope（type 匹配；task/channel 还要求 scopeId 相等）。 */
  private scopeMatches(event: RealtimeEvent, scope: RealtimeScope): boolean {
    if (event.scopeType !== scope.type) {
      return false;
    }
    if (scope.type === 'global') {
      return true;
    }
    return event.scopeId === scope.id;
  }

  /** 归一化 scope 参数：单 scope 包成数组；缺省 → 空数组（= 全量不过滤）。 */
  private toScopeList(
    scopes?: RealtimeScope | RealtimeScope[],
  ): RealtimeScope[] {
    if (scopes === undefined || scopes === null) {
      return [];
    }
    return Array.isArray(scopes) ? scopes : [scopes];
  }

  /**
   * 构造可见团队过滤谓词：null/undefined → null（不过滤，兼容现有调用）。
   * 显式空数组 → 恒 false（调用方无任何可见团队，任何事件都不放行，防信息泄露）；
   * 非空数组 → 仅放行 teamId ∈ 可见集合的团队域事件（teamId 为 null 的非归属事件一律不放行）。
   */
  private toTeamFilter(
    visibleTeamIds?: string[] | null,
  ): ((event: RealtimeEvent) => boolean) | null {
    if (visibleTeamIds === null || visibleTeamIds === undefined) {
      return null;
    }
    if (visibleTeamIds.length === 0) {
      return () => false;
    }
    const visible = new Set(visibleTeamIds);
    return (event) => {
      const teamId =
        event.teamId ?? (event.scopeType === 'team' ? event.scopeId : null);
      return teamId !== null && teamId !== undefined && visible.has(teamId);
    };
  }

  /**
   * scope=all 可见性判定：仅按团队过滤放行；
   * teamFilter 为 null（非全量订阅调用）→ 不过滤。
   */
  private passesVisibility(
    event: RealtimeEvent,
    teamFilter: ((event: RealtimeEvent) => boolean) | null,
  ): boolean {
    if (teamFilter === null) {
      return true;
    }
    return teamFilter(event);
  }

  /**
   * 解析事件团队域归属（emit 落库时附带内存 teamId，供 scope=all 团队过滤）：
   * - team scope → scopeId 即团队 id；
   * - task scope → 任务 teamId；
   * - channel scope → 频道 teamId（团队频道直取；任务频道经 taskId 回退查任务 teamId）；
   * - global scope → payload taskId/message.taskId 反查任务 teamId；无则 null。
   * 查询失败一律返回 null（不抛错，事件照常落库；null 仅意味着不走团队放行）。
   */
  private async resolveTeamIdOfEvent(
    event: RealtimeEvent,
  ): Promise<string | null> {
    try {
      if (event.scopeType === 'team') {
        return event.scopeId;
      }
      if (event.scopeType === 'task' && event.scopeId) {
        const task = await this.prisma.task.findUnique({
          where: { id: event.scopeId },
          select: { teamId: true },
        });
        return (task as { teamId?: string | null })?.teamId ?? null;
      }
      if (event.scopeType === 'channel' && event.scopeId) {
        const channel = await this.prisma.chatChannel.findUnique({
          where: { id: event.scopeId },
          select: { taskId: true, teamId: true },
        });
        if (!channel) {
          return null;
        }
        if ((channel as { teamId?: string | null }).teamId) {
          return (channel as { teamId?: string | null }).teamId as string;
        }
        const taskId = (channel as { taskId?: string | null }).taskId;
        if (!taskId) {
          return null;
        }
        const task = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { teamId: true },
        });
        return (task as { teamId?: string | null })?.teamId ?? null;
      }
      const payload = event.payload as {
        taskId?: string;
        message?: { taskId?: string };
      } | null;
      const taskId = payload?.taskId ?? payload?.message?.taskId ?? null;
      if (!taskId) {
        return null;
      }
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      return (task as { teamId?: string | null })?.teamId ?? null;
    } catch {
      return null;
    }
  }

  private async attachEventTeams(events: RealtimeEvent[]): Promise<void> {
    for (const e of events) {
      if (e.scopeType === 'team' && e.teamId === undefined) {
        e.teamId = e.scopeId;
      }
    }
    const channelNeedy = events.filter(
      (e) => e.scopeType === 'channel' && e.teamId === undefined,
    );
    const channelIds = [
      ...new Set(
        channelNeedy.map((e) => e.scopeId).filter((id): id is string => !!id),
      ),
    ];
    let teamByTask = new Map<string, string | null>();
    if (channelIds.length > 0) {
      try {
        const rows = (await this.prisma.chatChannel.findMany({
          where: { id: { in: channelIds } },
          select: { id: true, teamId: true, taskId: true },
        })) as { id: string; teamId?: string | null; taskId?: string | null }[];
        const byId = new Map(
          rows.map((r) => [
            r.id,
            { teamId: r.teamId ?? null, taskId: r.taskId ?? null },
          ]),
        );
        const fallbackTaskIds = [
          ...new Set(
            channelNeedy
              .map((e) => byId.get(e.scopeId as string))
              .filter((v) => v && !v.teamId && v.taskId)
              .map((v) => (v as { taskId: string }).taskId),
          ),
        ];
        if (fallbackTaskIds.length > 0) {
          teamByTask = await this.resolveTaskTeams(fallbackTaskIds);
        }
        for (const e of channelNeedy) {
          const v = byId.get(e.scopeId as string);
          e.teamId =
            v?.teamId ??
            (v?.taskId ? (teamByTask.get(v.taskId) ?? null) : null);
        }
      } catch {
        for (const e of channelNeedy) {
          e.teamId = null;
        }
      }
    }
    const taskNeedy = events.filter(
      (e) =>
        (e.scopeType === 'task' || e.scopeType === 'global') &&
        e.teamId === undefined,
    );
    if (taskNeedy.length === 0) {
      return;
    }
    const payloadTaskId = (e: RealtimeEvent): string | null => {
      if (e.scopeType === 'task') {
        return e.scopeId;
      }
      const payload = e.payload as {
        taskId?: string;
        message?: { taskId?: string };
      } | null;
      return payload?.taskId ?? payload?.message?.taskId ?? null;
    };
    const taskIds = [
      ...new Set(
        taskNeedy.map(payloadTaskId).filter((id): id is string => !!id),
      ),
    ];
    if (taskIds.length === 0) {
      for (const e of taskNeedy) {
        e.teamId = null;
      }
      return;
    }
    try {
      teamByTask = await this.resolveTaskTeams(taskIds);
      for (const e of taskNeedy) {
        const tid = payloadTaskId(e);
        e.teamId = (tid && teamByTask.get(tid)) ?? null;
      }
    } catch {
      for (const e of taskNeedy) {
        e.teamId = null;
      }
    }
  }

  private async resolveTaskTeams(
    taskIds: string[],
  ): Promise<Map<string, string | null>> {
    const byId = new Map<string, string | null>();
    const rows = (await this.prisma.task.findMany({
      where: { id: { in: taskIds } },
      select: { id: true, teamId: true },
    })) as { id: string; teamId?: string | null }[];
    for (const r of rows ?? []) {
      byId.set(r.id, r.teamId ?? null);
    }
    return byId;
  }

  /**
   * 按 scope 数组构造 Prisma where：无 scope 不过滤；有 scope 以 OR 组合
   * （global 仅匹配 scopeType='global' 的 null-scopeId 事件，task/channel 匹配对应 scopeId）。
   * 团队可见性（scope=all）在 JS 层按团队归属过滤（DB 行无团队列，见 attachEventTeams）。
   */
  private buildScopeWhereList(
    scopes?: RealtimeScope | RealtimeScope[],
  ): Prisma.RealtimeEventWhereInput {
    const scopeList = this.toScopeList(scopes);
    const where: Prisma.RealtimeEventWhereInput =
      scopeList.length === 0
        ? {}
        : { OR: scopeList.map((scope) => this.buildScopeWhere(scope)) };
    return where;
  }

  /** 按单 scope 构造 Prisma where：global 仅取 global 事件。 */
  private buildScopeWhere(
    scope: RealtimeScope,
  ): Prisma.RealtimeEventWhereInput {
    if (scope.type === 'global') {
      return { scopeType: 'global' };
    }
    return { scopeType: scope.type, scopeId: scope.id ?? null };
  }

  /** 解析 `ev_0000000001` → 序号 1（非 ev_ 前缀兜底按 0）。 */
  private parseSeq(id: string): number {
    const seq = parseInt(id.slice(EVENT_ID_PREFIX.length + 1), 10);
    return Number.isFinite(seq) ? seq : 0;
  }
}
