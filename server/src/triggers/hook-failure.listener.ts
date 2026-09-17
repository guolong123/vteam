import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { RealtimeEvent, RealtimeService } from '../realtime/realtime.service';
import { HookService } from './hook.service';

/**
 * wake 执行失败记录器（trigger-unification todo-21 姊妹缝）。
 *
 * 缝：hook 落 `fired` 仅表示「分派被接受」；被唤醒会话随后
 * `agent.error` / `session.updated(failed)` 时，真失败与成功在库里不可分辨
 * （hook/trigger 的 lastError/skipReason 皆 NULL）。本监听器订阅既有 realtime
 * 事件流，按 `target.wakeSessionId == event.sessionId` 找回来源 hook 并**记录**
 * 真实下游原因（不改 `fired` 状态，不重试/不重排——记录 only）。
 *
 * 优先级：`agent.error` 为权威原因（worker 上送的 `message`/`error` 原文）；
 * `session.updated(failed)` 为兜底（无逐字原因，写通用文案）。两者都经
 * `HookService.recordWakeFailure` 的认领式幂等——同一会话多次事件只记首个。
 *
 * 永不向 bus 抛错（订阅者惯例：全程 catch + warn）；缺 sessionId/缺原因一律
 * 安全降级，不写半行、不打 500。
 */
@Injectable()
export class HookFailureListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HookFailureListener.name);
  private unsubscribe: (() => void) | null = null;

  /** 每会话串行链：同一会话的失败事件按到达序处理，避免并发竞态下
   *  「通用兜底原因」抢在「agent.error 真实原因」之前认领（live 抓到）。 */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly realtime: RealtimeService,
    private readonly hooks: HookService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.realtime.subscribe((event) => {
      void this.handle(event).catch((err: unknown) =>
        this.logger.warn(
          `wake 失败记录失败 type=${event.type}：${describeListenerError(err)}`,
        ),
      );
    });
  }

  onModuleDestroy(): void {
    try {
      this.unsubscribe?.();
    } catch {
      // 退订失败无害（进程退出）
    }
    this.unsubscribe = null;
  }

  /**
   * bus 回调入口：永不抛（记录失败只 warn，绝不影响事件流其他订阅者）。
   * 同会话事件串行（`agent.error` 先到 → 真实原因认领；`session.updated(failed)`
   * 后到 → 认领谓词已不成立，no-op 兜底）。
   */
  async handle(event: RealtimeEvent): Promise<void> {
    const sessionId = sessionIdOf(event);
    if (!sessionId) {
      await this.routeSafely(event);
      return;
    }
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.routeSafely(event));
    this.chains.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.chains.get(sessionId) === next) {
        this.chains.delete(sessionId);
      }
    }
  }

  private async routeSafely(event: RealtimeEvent): Promise<void> {
    try {
      await this.route(event);
    } catch (err) {
      this.logger.warn(
        `wake 失败记录失败 type=${event.type}：${describeListenerError(err)}`,
      );
    }
  }

  private async route(event: RealtimeEvent): Promise<void> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === EVENT_TYPES.AGENT_ERROR) {
      const sessionId = str(payload['sessionId']);
      if (!sessionId) {
        return;
      }
      await this.hooks.recordWakeFailure({
        sessionId,
        reason: extractAgentErrorReason(payload),
      });
      return;
    }
    if (event.type === EVENT_TYPES.SESSION_UPDATED) {
      if (payload['status'] !== 'failed') {
        return;
      }
      const sessionId = str(payload['sessionId']);
      if (!sessionId) {
        return;
      }
      await this.hooks.recordWakeFailure({
        sessionId,
        reason: '会话执行失败（session.updated status=failed）',
      });
    }
  }
}

/** 从事件载荷取平台会话主键（缺省 → 无键，直接处理不排队）。 */
function sessionIdOf(event: RealtimeEvent): string | undefined {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const raw = payload['sessionId'];
  return typeof raw === 'string' && raw ? raw : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** 真实原因优先级：`message`（dispatcher 广播）→ `error`（worker 上送）→ errorType 兜底。 */
function extractAgentErrorReason(payload: Record<string, unknown>): string {
  const direct = str(payload['message']) ?? str(payload['error']);
  if (direct) {
    return direct;
  }
  const errorType = str(payload['errorType']);
  return errorType
    ? `agent 执行失败（errorType=${errorType}）`
    : 'agent 执行失败（未携带原因）';
}

function describeListenerError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
