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
  /** 事件所属项目（scope=all 全量订阅时的可见项目过滤依据）；解析失败/无法归属 → null。 */
  projectId: string | null;
  /**
   * 团队域归属（scope=all 全量订阅时的可见团队过滤依据；内存路由字段，不落库、不下发）：
   * - team scope → scopeId；channel scope → 频道 teamId（团队频道）；
   * - task/global scope → null（走项目过滤）。
   * 零任务团队频道无项目归属（projectId null），靠此字段对团队成员放行。
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
      projectId: null,
    };

    event.projectId = await this.resolveProjectIdOfEvent(event);
    event.teamId = await this.resolveTeamIdOfEvent(event);

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
   * scope=all 全量订阅时调用方传入可见项目集（visibleProjectIds）叠加团队集
   * （visibleTeamIds，团队成员维度）：命中任一即放行；两者皆 null = 不过滤。
   */
  subscribe(
    listener: RealtimeEventListener,
    scopes?: RealtimeScope | RealtimeScope[],
    visibleProjectIds?: string[] | null,
    visibleTeamIds?: string[] | null,
  ): () => void {
    const scopeList = this.toScopeList(scopes);
    const projectFilter = this.toProjectFilter(visibleProjectIds);
    const teamFilter = this.toTeamFilter(visibleTeamIds);
    const needsFilter =
      scopeList.length > 0 || projectFilter !== null || teamFilter !== null;
    const wrapped: RealtimeEventListener = needsFilter
      ? (event) => {
          if (!this.passesVisibility(event, projectFilter, teamFilter)) {
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
    visibleTeamIds?: string[] | null,
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
    let events = rows.map(this.fromRow);
    if (visibleTeamIds === null || visibleTeamIds === undefined) {
      return events;
    }
    // scope=all 团队域补拉：projectId 为 null 的团队事件被主查询的项目过滤丢弃，
    // 按可见团队二次候选查询后合并（与 live 订阅同一可见性谓词精确过滤）。
    // 主查询行已有 DB 级项目授权，保持原样；仅候选行需 JS 过滤
    // （visibleProjectIds 为 null 时主查询无项目约束，则全部行参与过滤）。
    const teamRows = await this.prisma.realtimeEvent.findMany({
      where: this.buildTeamCandidateWhere(scopes, where.id, visibleTeamIds),
      orderBy: { id: 'asc' },
    });
    const seen = new Set(events.map((e) => e.id));
    const extras = teamRows.map(this.fromRow).filter((e) => {
      if (seen.has(e.id)) {
        return false;
      }
      seen.add(e.id);
      return true;
    });
    const projectFilter = this.toProjectFilter(visibleProjectIds);
    const teamFilter = this.toTeamFilter(visibleTeamIds);
    if (visibleProjectIds === null || visibleProjectIds === undefined) {
      events = events.concat(extras);
      await this.attachChannelTeams(events);
      events = events.filter((e) =>
        this.passesVisibility(e, projectFilter, teamFilter),
      );
    } else {
      await this.attachChannelTeams(extras);
      events = events.concat(
        extras.filter((e) =>
          this.passesVisibility(e, projectFilter, teamFilter),
        ),
      );
    }
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
    return (event) => event.projectId !== null && visible.has(event.projectId);
  }

  /**
   * 构造可见团队过滤谓词：null/undefined → null（不过滤，兼容现有调用）。
   * 显式空数组 → 恒 false（调用方无任何可见团队，团队事件一律不放行）；
   * 非空数组 → 仅放行 teamId ∈ 可见集合的团队域事件（teamId 为 null 的非团队事件一律不放行）。
   * 与项目过滤为 OR 关系（见 passesVisibility），只放宽、不收紧既有项目语义。
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
   * scope=all 可见性判定：项目过滤与团队过滤任一命中即放行；
   * 两者皆 null（非全量订阅调用）→ 不过滤。
   */
  private passesVisibility(
    event: RealtimeEvent,
    projectFilter: ((event: RealtimeEvent) => boolean) | null,
    teamFilter: ((event: RealtimeEvent) => boolean) | null,
  ): boolean {
    if (projectFilter === null && teamFilter === null) {
      return true;
    }
    return (projectFilter?.(event) ?? false) || (teamFilter?.(event) ?? false);
  }

  /**
   * 解析事件团队域归属（emit 落库时附带内存 teamId，供 scope=all 团队过滤）：
   * - team scope → scopeId 即团队 id；
   * - channel scope → 频道 teamId（团队频道；任务频道为 null，走项目过滤）；
   * - task/global scope → null。
   * 查询失败一律返回 null（不抛错，事件照常落库；null 仅意味着不走团队放行）。
   */
  private async resolveTeamIdOfEvent(
    event: RealtimeEvent,
  ): Promise<string | null> {
    try {
      if (event.scopeType === 'team') {
        return event.scopeId;
      }
      if (event.scopeType === 'channel' && event.scopeId) {
        const channel = await this.prisma.chatChannel.findUnique({
          where: { id: event.scopeId },
          select: { teamId: true },
        });
        return channel?.teamId ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 团队域补拉候选查询：可见团队的 team 事件 + 无项目归属的 channel 事件
   * （后者按频道→团队批量归属后由 passesVisibility 精确过滤）。
   * scope 约束与游标条件与主查询对齐（主查询已算好的 id 条件直接复用）。
   */
  private buildTeamCandidateWhere(
    scopes: RealtimeScope | RealtimeScope[] | undefined,
    idCond: Prisma.RealtimeEventWhereInput['id'],
    visibleTeamIds: string[],
  ): Prisma.RealtimeEventWhereInput {
    const scopeList = this.toScopeList(scopes);
    const and: Prisma.RealtimeEventWhereInput[] = [];
    if (scopeList.length > 0) {
      and.push({ OR: scopeList.map((scope) => this.buildScopeWhere(scope)) });
    }
    and.push({
      OR: [
        { scopeType: 'team', scopeId: { in: visibleTeamIds } },
        { scopeType: 'channel', projectId: null },
      ],
    });
    if (idCond !== undefined) {
      and.push({ id: idCond });
    }
    return and.length === 1 ? and[0] : { AND: and };
  }

  /**
   * 批量补齐 channel 事件的内存 teamId（补拉行无 teamId 时按频道查团队）；
   * 已附带（live 事件）的不重复查询；查询失败保持 null（不抛错）。
   */
  private async attachChannelTeams(events: RealtimeEvent[]): Promise<void> {
    const needy = events.filter(
      (e) => e.scopeType === 'channel' && e.teamId === undefined,
    );
    const ids = [
      ...new Set(
        needy
          .map((e) => e.scopeId)
          .filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) {
      return;
    }
    try {
      const rows = await this.prisma.chatChannel.findMany({
        where: { id: { in: ids } },
        select: { id: true, teamId: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r.teamId ?? null]));
      for (const e of needy) {
        e.teamId = byId.get(e.scopeId as string) ?? null;
      }
    } catch {
      return;
    }
  }

  /**
   * 解析事件所属项目 id（emit 落库时写入 project_id，供 scope=all 可见项目过滤）：
   * - task scope → tasks.projectId
   * - channel scope → chat_channels.taskId → tasks.projectId（两级）
   * - team scope → team 域全局资源，无 projectId → null（按 team 维度隔离，不以项目过滤）
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
          select: { taskId: true, teamId: true },
        });
        if (!channel) {
          return null;
        }
        // 团队频道（team_group/私聊）本身 taskId 为空：按消息 taskId → 团队当前任务 → 团队任一任务逐级回退解析项目，
        // 否则 scope=all 订阅的项目过滤（null 一律丢弃）会吞掉团队聊天的全部事件
        let taskId: string | null =
          channel.taskId ?? (event.payload as any)?.message?.taskId ?? null;
        if (!taskId && (channel as any).teamId) {
          const team = await (this.prisma as any).team.findUnique({
            where: { id: (channel as any).teamId },
            select: { currentTaskId: true },
          });
          taskId = team?.currentTaskId ?? null;
          if (!taskId) {
            const first = await this.prisma.task.findFirst({
              where: { teamId: (channel as any).teamId },
              select: { id: true },
              orderBy: { createdAt: 'desc' },
            });
            taskId = first?.id ?? null;
          }
        }
        if (!taskId) return null;
        const task = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { projectId: true },
        });
        return task?.projectId ?? null;
      }
      if (event.scopeType === 'team') {
        // team 域事件本身无项目归属：能从消息 taskId 反查到项目则归属之（否则 scope=all 订阅收不到），
        // 纯团队管理事件保持 null（按 team 维度隔离，不以项目放行）
        const msgTaskId = (event.payload as any)?.message?.taskId ?? null;
        if (!msgTaskId) return null;
        const msgTask = await this.prisma.task.findUnique({
          where: { id: msgTaskId },
          select: { projectId: true },
        });
        return msgTask?.projectId ?? null;
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
