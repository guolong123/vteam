import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import { Prisma } from '@prisma/client';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 事件作用域（09 篇 §4.2 订阅粒度）。
 * - task:<id> / channel:<id>：仅广播归属该资源的事件
 * - global：全局事件（scopeId 为 null）
 */
export type RealtimeScopeType = 'task' | 'channel' | 'global';

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
  /** 事件所属项目（scope=all 全量订阅时的可见项目过滤依据）；解析失败/无法归属 → null。 */
  projectId: string | null;
}

export type RealtimeEventType = string;
export type RealtimeEventListener = (event: RealtimeEvent) => void;

/** 事件 id 域前缀（对齐 15 篇 §2.2 主键策略：<prefix>_<零填充序号>）。 */
export const EVENT_ID_PREFIX = 'ev';

const DEFAULT_MAX_LOG = 1000;

/**
 * RealtimeService —— 内部事件总线（EventEmitter）+ 事件持久化基座。
 *
 * 职责（08 §7.3 事件先落库后转发）：
 *  - emit/broadcast：分配字符串 id（ev_<序号>），先写 realtime_events 表再经总线广播
 *  - subscribe(listener, scopes?)：按 scope 数组过滤实时事件（任一命中即转发；无 scope = 全局全量）
 *  - getEventsSince(since, scopes?)：以 DB 为准按 since 补拉历史事件，scope 数组构造 OR 查询（09 篇 §4.4）
 *  - 内存环形缓冲保留为实时层（最近 maxLog 条），补拉以 DB 为准
 */
@Injectable()
export class RealtimeService implements OnModuleInit {
  private readonly bus = new EventEmitter();

  /** 已发出事件的内存环形缓冲（id 升序），供实时层快速感知游标位。 */
  private readonly log: RealtimeEvent[] = [];

  private readonly maxLog = DEFAULT_MAX_LOG;

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /** 进程启动：对齐库内 ev_ 前缀已有最大序号（重启续号）。 */
  async onModuleInit(): Promise<void> {
    const last = await this.prisma.realtimeEvent.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (last) {
      this.idGen.seed(EVENT_ID_PREFIX, this.parseSeq(last.id));
    }
  }

  /**
   * 发布一条事件：先落库（Prisma realtime_events）后转发（08 §7.3）。
   * scope 缺省为 global；返回完整事件帧（含字符串 id 游标）。
   */
  async emit(
    type: RealtimeEventType,
    payload: unknown,
    scope?: RealtimeScope,
  ): Promise<RealtimeEvent> {
    const resolved: RealtimeScope = scope ?? { type: 'global' };
    const event: RealtimeEvent = {
      id: await this.idGen.nextId(EVENT_ID_PREFIX),
      type,
      payload,
      timestamp: new Date().toISOString(),
      scopeType: resolved.type,
      scopeId: resolved.id ?? null,
      projectId: null,
    };

    event.projectId = await this.resolveProjectIdOfEvent(event);

    await this.prisma.realtimeEvent.create({
      data: {
        id: event.id,
        type: event.type,
        scopeType: event.scopeType,
        scopeId: event.scopeId,
        projectId: event.projectId,
        payload: event.payload as Prisma.InputJsonValue,
      },
    });

    this.log.push(event);
    if (this.log.length > this.maxLog) {
      this.log.shift();
    }
    this.bus.emit('event', event);
    return event;
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
   */
  subscribe(
    listener: RealtimeEventListener,
    scopes?: RealtimeScope | RealtimeScope[],
    visibleProjectIds?: string[] | null,
  ): () => void {
    const scopeList = this.toScopeList(scopes);
    const projectFilter = this.toProjectFilter(visibleProjectIds);
    const needsFilter = scopeList.length > 0 || projectFilter !== null;
    const wrapped: RealtimeEventListener = needsFilter
      ? (event) => {
          if (projectFilter !== null && !projectFilter(event)) {
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
   * 以 DB 为准返回 id 大于 since 的历史事件（断线续拉，09 篇 §4.4）。
   * since 未指定时返回 scope 下的全部事件；since === 'latest' 时跳过历史重放，
   * 以当前最新已落库事件 id 为游标，仅返回其后新产生的事件（首连只订阅增量用，
   * 连接建立期间的竞态事件由 controller 续拉缓冲 + 去重兜底）；scope 未指定时不过滤。
   * 多 scope 以 OR 组合查询（任一 scope 命中即返回）。
   */
  async getEventsSince(
    since?: string,
    scopes?: RealtimeScope | RealtimeScope[],
    visibleProjectIds?: string[] | null,
  ): Promise<RealtimeEvent[]> {
    const where: Prisma.RealtimeEventWhereInput = this.buildScopeWhereList(
      scopes,
      visibleProjectIds,
    );
    if (since === 'latest') {
      const latest = await this.prisma.realtimeEvent.findFirst({
        orderBy: { id: 'desc' },
        select: { id: true },
      });
      if (latest) {
        where.id = { gt: latest.id };
      }
      // 库空（无最新 id）→ 不设 id 条件，findMany 自然返回空，仅收之后新事件
    } else if (since !== undefined && since !== null && since !== '') {
      where.id = { gt: since };
    }
    const rows = await this.prisma.realtimeEvent.findMany({
      where,
      orderBy: { id: 'asc' },
    });
    return rows.map(this.fromRow);
  }

  /** 当前游标（最新已发事件 id）；无事件时返回 null。 */
  getLatestId(): string | null {
    if (this.log.length === 0) {
      return null;
    }
    return this.log[this.log.length - 1].id;
  }

  /** 将 DB 行映射为统一事件帧（createdAt → ISO8601 timestamp）。 */
  private fromRow(row: {
    id: string;
    type: string;
    scopeType: string;
    scopeId: string | null;
    projectId: string | null;
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
      projectId: row.projectId ?? null,
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
   * 构造可见项目过滤谓词：null/undefined → null（不过滤，兼容现有调用）。
   * 显式空数组 → 恒 false（调用方无任何可见项目，任何事件都不放行，防信息泄露）；
   * 非空数组 → 仅放行 projectId ∈ 可见集合的事件（projectId 为 null 的事件一律不放行）。
   */
  private toProjectFilter(
    visibleProjectIds?: string[] | null,
  ): ((event: RealtimeEvent) => boolean) | null {
    if (visibleProjectIds === null || visibleProjectIds === undefined) {
      return null;
    }
    if (visibleProjectIds.length === 0) {
      return () => false;
    }
    const visible = new Set(visibleProjectIds);
    return (event) =>
      event.projectId !== null && visible.has(event.projectId);
  }

  /**
   * 解析事件所属项目 id（emit 落库时写入 project_id，供 scope=all 可见项目过滤）：
   * - task scope → tasks.projectId
   * - channel scope → chat_channels.taskId → tasks.projectId（两级）
   * - global scope → payload.taskId 反查 tasks.projectId；无 taskId → null
   * 查询失败/资源不存在一律返回 null（不抛错，事件照常落库）。
   */
  private async resolveProjectIdOfEvent(
    event: RealtimeEvent,
  ): Promise<string | null> {
    try {
      if (event.scopeType === 'task' && event.scopeId) {
        const task = await this.prisma.task.findUnique({
          where: { id: event.scopeId },
          select: { projectId: true },
        });
        return task?.projectId ?? null;
      }
      if (event.scopeType === 'channel' && event.scopeId) {
        const channel = await this.prisma.chatChannel.findUnique({
          where: { id: event.scopeId },
          select: { taskId: true },
        });
        if (!channel) {
          return null;
        }
        const task = await this.prisma.task.findUnique({
          where: { id: channel.taskId },
          select: { projectId: true },
        });
        return task?.projectId ?? null;
      }
      const taskId = (event.payload as { taskId?: string } | null)?.taskId;
      if (!taskId) {
        return null;
      }
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { projectId: true },
      });
      return task?.projectId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 按 scope 数组构造 Prisma where：无 scope 不过滤；有 scope 以 OR 组合
   * （global 仅匹配 scopeType='global' 的 null-scopeId 事件，task/channel 匹配对应 scopeId）。
   * visibleProjectIds 非 null 时叠加 projectId ∈ 集合过滤（scope=all 全量订阅的可见项目控制；
   * 显式空数组 → in [] 空结果，无可见项目时不误放行）。
   */
  private buildScopeWhereList(
    scopes?: RealtimeScope | RealtimeScope[],
    visibleProjectIds?: string[] | null,
  ): Prisma.RealtimeEventWhereInput {
    const scopeList = this.toScopeList(scopes);
    const where: Prisma.RealtimeEventWhereInput =
      scopeList.length === 0
        ? {}
        : { OR: scopeList.map((scope) => this.buildScopeWhere(scope)) };
    if (visibleProjectIds !== null && visibleProjectIds !== undefined) {
      where.projectId = { in: visibleProjectIds };
    }
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
