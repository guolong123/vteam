import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Logger,
  MessageEvent,
  Query,
  Sse,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { AUTH_ERRORS } from '../auth/auth.constants';
import { Public } from '../auth/decorators/public.decorator';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  RealtimeEvent,
  RealtimeScope,
  RealtimeScopeType,
  RealtimeService,
} from './realtime.service';

/** 心跳间隔（ms）：SSE 保活，防止代理/中间件超时断连。 */
export const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * 续拉期实时帧缓冲 liveBuffer 的**条数**硬顶（incident-livebuffer-bound，Path F）。
 *
 * 事故背景：events() 在「读历史 → 订阅实时」之间把实时帧推进 liveBuffer；
 * 一旦 getEventsSince 悬挂（hung query / 连接池耗尽 / DB stall），await 永不
 * settle——既不解注 replaying=false，finally 也不执行——realtime 帧便以全帧率
 * （25-44/s）被静默推进本缓冲，每帧含全量 accumulated message（~250KB-1MB），
 * 数分钟即可吃满堆且无任何日志（与「无 pino level>=40 记录」的事故症状吻合）。
 *
 * 取 1000（与 REALTIME_REPLAY_MAX 对齐的数值论证）：续拉缓冲只装「补拉执行
 * 期间新到达的实时帧」。正常补拉毫秒级返回、至多带回 1000 行 DB 事件：
 *  - 最坏正常（100ms 补拉窗）× 最高帧率 44/s ≈ 4.4 帧；
 *  - 即使退化到 1s 的「慢但正常」补拉也仅 ~44 帧。
 * 1000 条 ≈ 最坏正常路径的 227 倍、1s 退化路径的 22.7 倍余量——正常补拉绝无
 * 可能触顶；只有补拉悬挂（非正常路径）才会收敛。
 */
export const REALTIME_LIVE_BUFFER_MAX_FRAMES = 1000;

/**
 * 续拉期实时帧缓冲 liveBuffer 的**序列化字节预算**（incident-livebuffer-bound，Path F）。
 * 条数上限对「单条巨大」失明（1000 帧 × 1MB ≈ 1GB 常驻，正是事故量级），故并行
 * 按字节收敛：压入后保留的序列化总字节（Σ JSON.stringify(frame) 的 UTF-8 长度，
 * 与 SSE 下发同一 JSON 形态）超预算时，从**头部淘汰最旧帧**直到低于预算。
 * 最坏保留量 = 预算 + 最新一帧体积（恒保留最新帧；单条即超预算时仍保留该条）。
 *
 * 取 64MiB 的数值论证：最坏正常补拉 4.4 帧 × 1MB ≈ 4.4MB，64MiB ≈ 14.5 倍余量；
 * 即使 1s 退化补拉 44 帧 × 1MB ≈ 44MB < 64MiB 也不触发淘汰。而悬挂路径下
 * 44 帧/s × 1MB = 44MB/s 的无界增长被钉死在 ~65MiB（预算 + 一帧），
 * 相较事故前「每分钟 GB 级」收敛约 40000 倍。
 */
export const REALTIME_LIVE_BUFFER_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 补拉重放期死线（incident-livebuffer-bound，Path F）：subscribe 后即刻武装，
 * 超时仍未收到补拉结果即**强制结束重放期**——replaying=false，实时帧改直通，
 * 已累积的续拉缓冲立即下发。专治「getEventsSince 永不 settle」把实时帧无限期
 * 扣在缓冲里的悬挂路径。正常补拉毫秒级 settle（finally 内 clearTimeout 拆除），
 * 死线回调根本不会执行；30s ≈ 100ms 最坏正常耗时的 300 倍、2s「慢但正常」
 * 耗时的 15 倍，且 ≤ 2 个心跳周期（15s），legitimate slow-but-fine 补拉
 * 不可能触及。
 */
export const REALTIME_REPLAY_DEADLINE_MS = 30_000;

/**
 * RealtimeController —— 统一 SSE 事件端点（09 篇 §4）。
 *
 * GET /api/v1/events（全局前缀 api/v1 + @Controller('events')）
 *  - EventSource 兼容：text/event-stream，事件带字符串 id（ev_<序号> 游标）
 *  - ?token=<jwt>：query 鉴权（EventSource 无法带 header），无效 → 401 AUTH_UNAUTHORIZED
 *  - ?scope=global|task:<id>|channel:<id>：订阅粒度；支持逗号分隔多 scope（如 channel:c1,task:t1,global），
 *    task/channel 逐 scope 校验调用者是该资源所属团队成员（team_user_members），非成员 → 403 PERMISSION_TEAM_NOT_MEMBER
 *  - ?since=<eventId>：断线续拉，返回 id 大于 since 的历史事件后再续实时流（09 篇 §4.4）
 *  - 心跳保活：周期发送 heartbeat 事件（SSE 保活，09 篇 §4.4 retry 语义）
 */
@ApiTags('realtime')
@Controller('events')
export class RealtimeController {
  private readonly logger = new Logger(RealtimeController.name);

  constructor(
    private readonly realtime: RealtimeService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @Sse()
  @Public()
  @ApiOperation({
    summary:
      '统一 SSE 事件流（EventSource 可消费，query token 鉴权，scope 订阅 + since 断线续拉）',
  })
  @ApiQuery({
    name: 'token',
    required: true,
    description:
      'JWT access token（EventSource 无法携带 Authorization 头，改走 query）',
  })
  @ApiQuery({
    name: 'scope',
    required: false,
    description:
      '订阅粒度：global（缺省）| task:<taskId> | channel:<channelId> | team:<teamId> | all；逗号分隔可合并订阅多 scope（如 channel:c1,task:t1,team:tm_1,global）；task/channel/team 需为所属团队成员；all = 全量订阅但仅收调用者成员团队的事件',
  })
  @ApiQuery({
    name: 'since',
    required: false,
    description:
      '断线续拉游标（对应 EventSource lastEventId）：缺省/空或特殊值 latest 一律跳过历史重放、仅从连接时刻起推送新事件（首连只订阅增量用）；显式 since=<eventId> 时最多补拉该游标之后最近的 1000 条历史事件后续接实时流（有硬上限且优先最新，防止超大 backlog 拖垮内存）',
  })
  async events(
    @Query('since') since?: string,
    @Query('scope') scope?: string,
    @Query('token') token?: string,
  ): Promise<Observable<MessageEvent>> {
    const userId = await this.authenticate(token);
    // scope=all：全量订阅但仅收调用者成员团队的事件（teamUserMember 表推导可见团队集）
    const isAll = scope === 'all';
    const parsedScopes = isAll ? [] : this.parseScope(scope);
    if (!isAll) {
      await this.assertScopeAccess(parsedScopes, userId);
    }
    const visibleTeamIds = isAll
      ? await this.resolveVisibleTeamIds(userId)
      : null;

    return new Observable<MessageEvent>((subscriber) => {
      // 续拉期缓冲实时事件，避免「读历史 → 订阅实时」之间的事件缺口。
      // incident-livebuffer-bound（Path F）：getEventsSince 一旦悬挂（hung query /
      // 连接池耗尽 / DB stall），await 永不 settle——既不解注 replaying=false，
      // finally 也不执行——realtime 帧便以全帧率（25-44/s）被静默推进本缓冲，
      // 每帧含全量 accumulated message（~250KB-1MB），数分钟吃满堆且无任何日志。
      // 两道互补边界（正常路径均不可触及，数值论证见常量声明处）：
      //  1) 条数 + 字节双上限收敛：超限从头淘汰最旧帧并 warn（丢帧可见而非静默）；
      //  2) 重放期死线：超时强制结束重放期，实时帧改直通并立即下发已累积缓冲。
      const liveBuffer: RealtimeEvent[] = [];
      // 与 liveBuffer 平行的「每条序列化字节数」+ 运行总和：摊销 O(1) 记账，
      // 淘汰时同步 shift（realtime.service REALTIME_LOG_MAX_BYTES 同款）。
      const liveBufferSizes: number[] = [];
      let liveBufferBytes = 0;
      let replaying = true;
      /** 死线是否已释放续拉缓冲（仅补拉悬挂路径；正常补拉恒为 false）。 */
      let bufferReleasedByDeadline = false;
      /** 溢出 warn 只记首次（死线 30s 窗口内至多一行，避免 44 帧/s 刷屏）。 */
      let liveOverflowWarned = false;

      /** 从缓冲头部淘汰最旧帧，同步字节记账（liveBuffer 与 liveBufferSizes 严格平行）。 */
      const evictLiveHead = () => {
        const removed = liveBuffer.shift();
        const size = liveBufferSizes.shift();
        if (removed !== undefined && size !== undefined) {
          liveBufferBytes -= size;
        }
      };

      /**
       * 压入续拉缓冲并按双上限收敛（incident-livebuffer-bound）：条数
       * REALTIME_LIVE_BUFFER_MAX_FRAMES 或序列化字节
       * REALTIME_LIVE_BUFFER_MAX_BYTES 任一超限，即从头部淘汰最旧帧。
       * 恒保留最新帧（length > 1 才因字节淘汰，与 service 日志同款）；
       * 淘汰只删头部 → 缓冲内 id 升序不变，死线下发序 == 事件产生序。
       */
      const pushLive = (event: RealtimeEvent) => {
        liveBuffer.push(event);
        const size = this.measureFrameBytes(event);
        liveBufferSizes.push(size);
        liveBufferBytes += size;
        if (
          liveBuffer.length > REALTIME_LIVE_BUFFER_MAX_FRAMES ||
          liveBufferBytes > REALTIME_LIVE_BUFFER_MAX_BYTES
        ) {
          if (!liveOverflowWarned) {
            liveOverflowWarned = true;
            this.logger.warn(
              `[liveBuffer] 续拉期实时帧缓冲触顶（条数上限 ${REALTIME_LIVE_BUFFER_MAX_FRAMES} / 字节预算 ${REALTIME_LIVE_BUFFER_MAX_BYTES}B）：补拉疑似悬挂，开始从头淘汰最旧帧，实时帧按序收敛保留`,
            );
          }
          while (liveBuffer.length > REALTIME_LIVE_BUFFER_MAX_FRAMES) {
            evictLiveHead();
          }
          while (
            liveBufferBytes > REALTIME_LIVE_BUFFER_MAX_BYTES &&
            liveBuffer.length > 1
          ) {
            evictLiveHead();
          }
        }
      };

      const unsubscribe = this.realtime.subscribe(
        (event) => {
          if (replaying) {
            pushLive(event);
          } else {
            subscriber.next(this.toMessageEvent(event));
          }
        },
        parsedScopes,
        visibleTeamIds,
      );

      // 1) 先补拉历史（id > since，以 DB 为准），再对齐续拉期缓冲
      // incident-livebuffer-bound（Path F）：补拉死线在订阅成立后即刻武装。
      // 正常补拉毫秒级 settle → finally 里 clearTimeout 拆除，本回调永不执行；
      // 只有 getEventsSince 悬挂时触发：强制结束重放期，已累积缓冲立即下发
      // （hung 住的下游不被无限期扣帧），迟到补拉结果整体冗余、整体跳过
      // （论证见下方 bufferReleasedByDeadline 分支）。
      const replayDeadlineTimer = setTimeout(() => {
        if (!replaying) {
          return; // 补拉已（以任意方式）结束：死线无事可做（幂等）
        }
        replaying = false;
        bufferReleasedByDeadline = true;
        this.logger.warn(
          `[liveBuffer] 补拉重放期超过 ${REALTIME_REPLAY_DEADLINE_MS}ms 未返回（getEventsSince 疑似悬挂）：强制结束重放期，实时帧改为直通，已累积 ${liveBuffer.length} 帧立即下发；迟到的补拉结果与已送达内容完全重叠，不再重复下发`,
        );
        for (const event of liveBuffer) {
          subscriber.next(this.toMessageEvent(event));
        }
        liveBuffer.length = 0;
        liveBufferSizes.length = 0;
        liveBufferBytes = 0;
      }, REALTIME_REPLAY_DEADLINE_MS);
      // 死线句柄不持有事件循环（service retentionTimer 同款）；连接断开由
      // teardown clearTimeout，unref 兜防孤立悬挂连接把进程钉住。
      replayDeadlineTimer.unref?.();

      void (async () => {
        try {
          const backlog = await this.realtime.getEventsSince(
            since !== undefined && since !== '' ? since : undefined,
            parsedScopes,
            visibleTeamIds,
          );
          replaying = false;
          if (bufferReleasedByDeadline) {
            // 死线已先释放续拉期：缓冲帧已在死线处按序下发、其间实时帧已直通，
            // 迟到的 DB backlog ⊆ 已送达集合——事件先落库后广播 + Node 单线程
            // 微序保证：backlog 快照内的帧，要么广播早于死线（已随缓冲下发），
            // 要么其广播微任务必先于/紧随本 settle 续体执行而走直通。再下发
            // 只会重复（破坏去重语义），故整体跳过；顺序亦保持产生序不乱序。
            return;
          }
          const seen = new Set(backlog.map((e) => e.id));
          for (const event of backlog) {
            subscriber.next(this.toMessageEvent(event));
          }
          // 2) 续拉期间到达的事件（去重对齐历史游标）
          for (const event of liveBuffer) {
            if (!seen.has(event.id)) {
              subscriber.next(this.toMessageEvent(event));
            }
          }
        } finally {
          // 补拉尝试结束（无论 resolve / throw / 中途 return）都必须复位重放期标志。
          // incident-livebuffer-finally：原先仅成功路径置 false，一旦 getEventsSince 抛错，
          // catch 只负责 subscriber.error(err)，replaying 永久停在 true → 后续实时帧全被
          // 推进 liveBuffer 静默累积（帧含全量 accumulated message，~250KB-1MB/帧），
          // 且无任何日志（NestJS catchError 吞噬该 error），是无声无界内存增长路径。
          // 幂等赋值：成功路径语义与原先完全一致（false 已被提前置过，此处重复无副作用）。
          replaying = false;
          // incident-livebuffer-bound：拆除补拉死线（正常 settle 路径必到此处；
          // 悬挂路径由死线回调先行释放，此处 clearTimeout 对已触发句柄为空操作）。
          clearTimeout(replayDeadlineTimer);
        }
      })().catch((err) => subscriber.error(err));

      // 3) 心跳保活：周期发送 heartbeat 事件
      const heartbeatTimer = setInterval(() => {
        subscriber.next({
          type: 'heartbeat',
          data: {
            id: null,
            type: 'heartbeat',
            payload: null,
            timestamp: new Date().toISOString(),
          },
        });
      }, HEARTBEAT_INTERVAL_MS);

      return () => {
        unsubscribe();
        clearInterval(heartbeatTimer);
        // incident-livebuffer-bound：连接断开即拆死线，防补拉悬挂 + 客户端已走的
        // 组合把 30s 定时器（及其回调里的 warn/下发）留成孤儿。
        clearTimeout(replayDeadlineTimer);
      };
    });
  }

  /** 校验 query token：JWT 解析失败 / 非 access 类型 → 401 AUTH_UNAUTHORIZED，返回 userId。 */
  private async authenticate(token?: string): Promise<string> {
    if (!token) {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.UNAUTHORIZED,
        message: '缺少 token（SSE 事件流需 ?token=<jwt> 鉴权）',
      });
    }
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.UNAUTHORIZED,
        message: 'token 无效或已过期',
      });
    }
    if (payload.type !== 'access') {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.UNAUTHORIZED,
        message: '请使用 access token',
      });
    }
    return payload.sub;
  }

  /**
   * 解析 scope 参数为 scope 数组：
   * - 缺省/空 → [{ type: 'global' }]
   * - 逗号分隔多 scope（如 `channel:c1,task:t1,team:tm_1,global`），空段忽略
   * - 任一段非法 → 400（复用单 scope 错误消息格式）
   * - 双订阅过渡期兼容：task: 与 team: 可共存（如 task:t_1,team:tm_1）
   */
  private parseScope(raw?: string): RealtimeScope[] {
    if (raw === undefined || raw === null || raw === '') {
      return [{ type: 'global' }];
    }
    const segments = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (segments.length === 0) {
      return [{ type: 'global' }];
    }
    return segments.map((segment) => this.parseScopeSegment(segment));
  }

  /** 解析单个 scope 段：global | task:<id> | channel:<id> | team:<id>；非法 → 400。 */
  private parseScopeSegment(raw: string): RealtimeScope {
    if (raw === 'global') {
      return { type: 'global' };
    }
    const colon = raw.indexOf(':');
    if (colon === -1) {
      throw new BadRequestException({
        code: 'SCOPE_INVALID',
        message:
          'scope 格式非法，应为 global | task:<id> | channel:<id> | team:<id>',
      });
    }
    const type = raw.slice(0, colon) as RealtimeScopeType;
    const id = raw.slice(colon + 1);
    if (type !== 'task' && type !== 'channel' && type !== 'team') {
      throw new BadRequestException({
        code: 'SCOPE_INVALID',
        message: 'scope 类型非法，仅支持 task / channel / team',
      });
    }
    if (!id) {
      throw new BadRequestException({
        code: 'SCOPE_INVALID',
        message: 'scope 缺少资源 id',
      });
    }
    return { type, id };
  }

  /**
   * scope 数组权限校验：逐 scope 校验，global 无过滤（登录即可）。
   * task:<id> → tasks.teamId；channel:<id> → chat_channels.teamId（团队频道直取，
   * 任务频道经 taskId 回退查任务 teamId）；team:<id> → scopeId 即团队 id。
   * 归属团队解析失败/资源不存在/调用者非团队成员（team_user_members 无行）
   * → 403 PERMISSION_TEAM_NOT_MEMBER。
   */
  private async assertScopeAccess(
    scopes: RealtimeScope[],
    userId: string,
  ): Promise<void> {
    for (const scope of scopes) {
      if (scope.type === 'global') {
        continue;
      }
      const teamId = await this.resolveTeamId(scope);
      if (!teamId) {
        this.throwForbidden();
      }
      const member = await (this.prisma as any).teamUserMember.findUnique({
        where: {
          teamId_userId: { teamId, userId },
        },
        select: { id: true },
      });
      if (!member) {
        this.throwForbidden();
      }
    }
  }

  /** 解析 scope 对应的所属团队 id；资源不存在返回 null（统一按无权处理，防信息泄露）。 */
  private async resolveTeamId(scope: RealtimeScope): Promise<string | null> {
    if (scope.type === 'team') {
      return scope.id ?? null;
    }
    if (scope.type === 'task') {
      const task = await (this.prisma as any).task.findUnique({
        where: { id: scope.id },
        select: { teamId: true },
      });
      return task?.teamId ?? null;
    }
    const channel = await this.prisma.chatChannel.findUnique({
      where: { id: scope.id },
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
    const task = await (this.prisma as any).task.findUnique({
      where: { id: taskId },
      select: { teamId: true },
    });
    return task?.teamId ?? null;
  }

  /** scope=all：返回调用者作为成员的全部团队 id（teamUserMember 表，用户维度成员；建团队自动 owner 落行）。 */
  private async resolveVisibleTeamIds(userId: string): Promise<string[]> {
    const memberships: { teamId: string }[] =
      (await (this.prisma as any).teamUserMember.findMany({
        where: { userId },
        select: { teamId: true },
      })) ?? [];
    return [...new Set(memberships.map((m) => m.teamId))];
  }

  private throwForbidden(): never {
    throw new ForbiddenException({
      code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
      message: '您不是该资源所属团队的成员，无权订阅其事件',
    });
  }

  /**
   * 单帧序列化字节（UTF-8，与 SSE 下发同一 JSON 形态）——liveBuffer 字节预算的
   * 计量单位（realtime.service measureRetainedBytes 同款语义）。
   */
  private measureFrameBytes(event: RealtimeEvent): number {
    try {
      return Buffer.byteLength(JSON.stringify(event) ?? '', 'utf8');
    } catch {
      // 不可 JSON 化的极端兜底：按 4KB 保守估算，绝不让计量抛错打断事件流
      return 4096;
    }
  }

  /**
   * 将统一事件帧映射为 SSE MessageEvent：id 供 EventSource lastEventId 续拉。
   * 不设 type（不输出 `event:` 行）→ EventSource 按默认 message 事件派发，
   * 前端 onmessage 统一接收后按 data.type 分派（业务 type 在 data JSON 内）。
   * 心跳帧保留 type='heartbeat'（不进 message，仅保活，08/09 篇 §4.4）。
   */
  private toMessageEvent(event: RealtimeEvent): MessageEvent {
    return {
      id: event.id,
      data: {
        id: event.id,
        type: event.type,
        payload: event.payload,
        timestamp: event.timestamp,
      },
    };
  }
}
