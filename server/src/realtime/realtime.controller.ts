import {
  BadRequestException,
  Controller,
  ForbiddenException,
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
import { PROJECT_MEMBERSHIP_ERRORS } from '../common/guards/project-membership.guard';
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
 * RealtimeController —— 统一 SSE 事件端点（09 篇 §4）。
 *
 * GET /api/v1/events（全局前缀 api/v1 + @Controller('events')）
 *  - EventSource 兼容：text/event-stream，事件带字符串 id（ev_<序号> 游标）
 *  - ?token=<jwt>：query 鉴权（EventSource 无法带 header），无效 → 401 AUTH_UNAUTHORIZED
 *  - ?scope=global|task:<id>|channel:<id>：订阅粒度；支持逗号分隔多 scope（如 channel:c1,task:t1,global），
 *    task/channel 逐 scope 校验调用者是该资源所属项目成员（project_members），非成员 → 403 PERMISSION_PROJECT_NOT_MEMBER
 *  - ?since=<eventId>：断线续拉，返回 id 大于 since 的历史事件后再续实时流（09 篇 §4.4）
 *  - 心跳保活：周期发送 heartbeat 事件（SSE 保活，09 篇 §4.4 retry 语义）
 */
@ApiTags('realtime')
@Controller('events')
export class RealtimeController {
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
    description: 'JWT access token（EventSource 无法携带 Authorization 头，改走 query）',
  })
  @ApiQuery({
    name: 'scope',
    required: false,
    description:
      '订阅粒度：global（缺省）| task:<taskId> | channel:<channelId> | all；逗号分隔可合并订阅多 scope（如 channel:c1,task:t1,global）；task/channel 需为项目成员；all = 全量订阅但仅收调用者成员项目的事件',
  })
  @ApiQuery({
    name: 'since',
    required: false,
    description:
      '断线续拉游标：返回 id 大于 since 的历史事件后续接实时流（对应 EventSource lastEventId）',
  })
  async events(
    @Query('since') since?: string,
    @Query('scope') scope?: string,
    @Query('token') token?: string,
  ): Promise<Observable<MessageEvent>> {
    const userId = await this.authenticate(token);
    // scope=all：全量订阅但仅收调用者成员项目的事件（projectMember 表推导可见项目集）
    const isAll = scope === 'all';
    const parsedScopes = isAll ? [] : this.parseScope(scope);
    if (!isAll) {
      await this.assertScopeAccess(parsedScopes, userId);
    }
    const visibleProjectIds = isAll
      ? await this.resolveVisibleProjectIds(userId)
      : null;

    return new Observable<MessageEvent>((subscriber) => {
      // 续拉期缓冲实时事件，避免「读历史 → 订阅实时」之间的事件缺口
      const liveBuffer: RealtimeEvent[] = [];
      let replaying = true;

      const unsubscribe = this.realtime.subscribe(
        (event) => {
          if (replaying) {
            liveBuffer.push(event);
          } else {
            subscriber.next(this.toMessageEvent(event));
          }
        },
        parsedScopes,
        visibleProjectIds,
      );

      // 1) 先补拉历史（id > since，以 DB 为准），再对齐续拉期缓冲
      void (async () => {
        const backlog = await this.realtime.getEventsSince(
          since !== undefined && since !== '' ? since : undefined,
          parsedScopes,
          visibleProjectIds,
        );
        replaying = false;
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
   * - 逗号分隔多 scope（如 `channel:c1,task:t1,global`），空段忽略
   * - 任一段非法 → 400（复用单 scope 错误消息格式）
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

  /** 解析单个 scope 段：global | task:<id> | channel:<id>；非法 → 400。 */
  private parseScopeSegment(raw: string): RealtimeScope {
    if (raw === 'global') {
      return { type: 'global' };
    }
    const colon = raw.indexOf(':');
    if (colon === -1) {
      throw new BadRequestException({
        code: 'SCOPE_INVALID',
        message: 'scope 格式非法，应为 global | task:<id> | channel:<id>',
      });
    }
    const type = raw.slice(0, colon) as RealtimeScopeType;
    const id = raw.slice(colon + 1);
    if (type !== 'task' && type !== 'channel') {
      throw new BadRequestException({
        code: 'SCOPE_INVALID',
        message: 'scope 类型非法，仅支持 task / channel',
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
   * task:<id> → tasks.projectId；channel:<id> → chat_channels.taskId → tasks.projectId。
   * 任一非 global scope 调用者非该项目成员 → 403 PERMISSION_PROJECT_NOT_MEMBER。
   */
  private async assertScopeAccess(
    scopes: RealtimeScope[],
    userId: string,
  ): Promise<void> {
    for (const scope of scopes) {
      if (scope.type === 'global') {
        continue;
      }
      const projectId = await this.resolveProjectId(scope);
      if (!projectId) {
        this.throwForbidden();
      }
      const member = await this.prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId, userId },
        },
        select: { id: true },
      });
      if (!member) {
        this.throwForbidden();
      }
    }
  }

  /** 解析 scope 对应的所属项目 id；资源不存在返回 null（统一按无权处理，防信息泄露）。 */
  private async resolveProjectId(scope: RealtimeScope): Promise<string | null> {
    if (scope.type === 'task') {
      const task = await this.prisma.task.findUnique({
        where: { id: scope.id },
        select: { projectId: true },
      });
      return task?.projectId ?? null;
    }
    const channel = await this.prisma.chatChannel.findUnique({
      where: { id: scope.id },
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

  /** scope=all：返回调用者作为成员的全部项目 id（projectMember 表，登录即查，无 403 语义）。 */
  private async resolveVisibleProjectIds(userId: string): Promise<string[]> {
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    return memberships.map((m) => m.projectId);
  }

  private throwForbidden(): never {
    throw new ForbiddenException({
      code: PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER,
      message: '您不是该资源所属项目的成员，无权订阅其事件',
    });
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
