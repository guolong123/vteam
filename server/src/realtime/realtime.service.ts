import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import { Prisma } from '@prisma/client';
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

    await this.prisma.realtimeEvent.create({
      data: {
        id: event.id,
        type: event.type,
        scopeType: event.scopeType,
        scopeId: event.scopeId,
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
   * 以 DB 为准返回 id 大于 since 的历史事件（断线续拉，09 篇 §4.4）。
   * since 未指定时返回 scope 下的全部事件；since === 'latest' 时跳过历史重放，
   * 以当前最新已落库事件 id 为游标，仅返回其后新产生的事件（首连只订阅增量用，
   * 连接建立期间的竞态事件由 controller 续拉缓冲 + 去重兜底）；scope 未指定时不过滤。
   * 多 scope 以 OR 组合查询（任一 scope 命中即返回）。
   */
  async getEventsSince(
    since?: string,
    scopes?: RealtimeScope | RealtimeScope[],
    visibleTeamIds?: string[] | null,
  ): Promise<RealtimeEvent[]> {
    const where: Prisma.RealtimeEventWhereInput =
      this.buildScopeWhereList(scopes);
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
    let events = rows.map(this.fromRow);
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
