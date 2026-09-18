import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEvent, RealtimeService } from '../realtime/realtime.service';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { tryParseLedger, VerdictInput } from './review-round-ledger';
import {
  ConvergenceNotifyOpts,
  ReviewRoundGateService,
} from './review-round-gate.service';

/**
 * 评审 verdict 聚合器（inbound 半边，只做提取 + 定位 + 委托，零政策）。
 *
 * - 订阅 realtime bus 的 `CHAT_MESSAGE_NEW`，仅处理 `senderType === 'agent'`
 *   且正文命中 `VERDICT: APPROVE|REJECT` 的群聊消息；
 * - 按 taskId 遍历任务 issues，用 `tryParseLedger` 找轮次账本宿主
 *  （无宿主 = 本轮尚未派发，静默忽略，绝不建账）；
 * - 组装 `VerdictInput {member, verdict, msgId, version?}` 调
 *   `ReviewRoundGateService.recordVerdict`（缺版本也转发，由门层打回；
 *   收敛/通知/翻转全由门层裁决，本文件永不写账）。
 *
 * 幂等：同一消息重复投递 → 同一 `msgId` → 门层 `resolveVerdict` 按
 * `msgId` 合并，去重由门层拥有。
 */
export const VERDICT_PATTERN = /VERDICT:\s*(APPROVE|REJECT)/i;
export const VERDICT_VERSION_PATTERN = /@\s*v(\d+(?:\.\d+)?)/i;

/** 计划员模板 agent id（团队内 a_plan 实例即计划员成员）。 */
const PLANNER_AGENT_ID = 'a_plan';

@Injectable()
export class ReviewVerdictListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReviewVerdictListener.name);
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly realtime: RealtimeService,
    private readonly prisma: PrismaService,
    @Optional() private readonly gate?: ReviewRoundGateService | null,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.realtime.subscribe((event) => {
      void this.handle(event).catch((err: unknown) =>
        this.logger.warn(
          `verdict 聚合失败 type=${event.type}：${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });
  }

  onModuleDestroy(): void {
    try {
      this.unsubscribe?.();
    } catch {}
    this.unsubscribe = null;
  }

  /** bus 回调入口：永不向 bus 抛错（全程 try/catch + warn）。 */
  async handle(event: RealtimeEvent): Promise<void> {
    try {
      await this.route(event);
    } catch (err) {
      this.logger.warn(
        `verdict 聚合失败 type=${event.type}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async route(event: RealtimeEvent): Promise<void> {
    if (event.type !== EVENT_TYPES.CHAT_MESSAGE_NEW) return;
    if (!this.gate) {
      this.logger.warn('verdict 聚合跳过（收敛门未装配）');
      return;
    }
    const message = this.extractMessage(event);
    if (!message || message.senderType !== 'agent') return;
    const text = this.extractText(message);
    // 便宜前置过滤：无 VERDICT 令牌直接返回，不碰 DB。
    if (!text || !/VERDICT:/i.test(text)) return;
    const parsed = this.parseVerdict(text);
    if (!parsed) return;
    const member =
      typeof message.senderInstanceId === 'string' && message.senderInstanceId
        ? message.senderInstanceId
        : null;
    const msgId =
      typeof message.id === 'string' && message.id ? message.id : null;
    if (!member || !msgId) return;

    const channelId = this.resolveChannelId(event, message);
    const taskId = await this.resolveTaskId(event, message, channelId);
    if (!taskId) return;

    const issueId = await this.findHostIssueId(taskId);
    // 无账本宿主 = 本轮尚未派发（正常闲聊），静默忽略，绝不建账。
    if (!issueId) return;

    const input: VerdictInput = parsed.version
      ? {
          member,
          verdict: parsed.verdict,
          msgId,
          version: parsed.version,
        }
      : { member, verdict: parsed.verdict, msgId };
    const notify = await this.resolveNotifyOpts(taskId, channelId, event);
    await this.gate.recordVerdict(issueId, input, notify);
  }

  private extractMessage(event: RealtimeEvent): Record<string, any> | null {
    const payload = (event.payload ?? {}) as Record<string, any>;
    const candidate = payload.message ?? payload;
    if (!candidate || typeof candidate !== 'object') return null;
    return candidate as Record<string, any>;
  }

  private extractText(message: Record<string, any>): string | null {
    const content = message.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (content && typeof content === 'object') {
      const text = (content as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) return text;
      const parts = (content as { parts?: unknown }).parts;
      if (Array.isArray(parts)) {
        const joined = parts
          .filter(
            (p): p is { type?: string; text?: string } =>
              !!p && typeof p === 'object',
          )
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('');
        if (joined.trim()) return joined;
      }
    }
    const fallback = message.text;
    if (typeof fallback === 'string' && fallback.trim()) return fallback;
    return null;
  }

  /** verdict 首匹配胜出；版本缺失时返回无 version（由门层打回，不丢弃）。 */
  parseVerdict(text: string): {
    verdict: 'APPROVE' | 'REJECT';
    version?: string;
  } | null {
    const hit = VERDICT_PATTERN.exec(text);
    if (!hit) return null;
    const verdict = hit[1].toUpperCase() === 'REJECT' ? 'REJECT' : 'APPROVE';
    const versionHit = VERDICT_VERSION_PATTERN.exec(text);
    const version = versionHit ? `v${versionHit[1]}` : undefined;
    return version ? { verdict, version } : { verdict };
  }

  private resolveChannelId(
    event: RealtimeEvent,
    message: Record<string, any>,
  ): string | null {
    const payload = (event.payload ?? {}) as Record<string, any>;
    const candidates = [
      message.channelId,
      payload.channelId,
      event.scopeType === 'channel' ? event.scopeId : null,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c) return c;
    }
    return null;
  }

  private async resolveTaskId(
    event: RealtimeEvent,
    message: Record<string, any>,
    channelId: string | null,
  ): Promise<string | null> {
    const payload = (event.payload ?? {}) as Record<string, any>;
    // 1-2：DTO 自带（未来字段 / payload 透传）——零 DB，直接返回。
    const direct = [message.taskId, payload.taskId];
    for (const t of direct) {
      if (typeof t === 'string' && t) return t;
    }
    // 3：task scope。
    if (event.scopeType === 'task' && event.scopeId) return event.scopeId;
    // 4：消息落库行（team-group verdict 的权威 task 链接；事件 payload 不带 taskId，
    //    team-group 频道 task_id 又恒为 NULL，只能靠 messages.task_id 回查）。
    const msgId =
      typeof message.id === 'string' && message.id ? message.id : null;
    if (msgId) {
      try {
        const row = await (this.prisma as any).message.findUnique({
          where: { id: msgId },
          select: { taskId: true },
        });
        if (typeof row?.taskId === 'string' && row.taskId) {
          return row.taskId;
        }
      } catch (err) {
        this.logger.warn(
          `verdict 任务定位失败 msg=${msgId}（消息行读取）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // 5-6：团队 currentTaskId（team-group 无任务绑定时回退团队活跃任务），
    // 频道 taskId 兜底（任务绑定频道）。
    if (channelId) {
      try {
        const channel = await (this.prisma as any).chatChannel.findUnique({
          where: { id: channelId },
          select: { taskId: true, teamId: true },
        });
        const teamId =
          typeof channel?.teamId === 'string' && channel.teamId
            ? channel.teamId
            : null;
        if (teamId) {
          try {
            const team = await (this.prisma as any).team.findUnique({
              where: { id: teamId },
              select: { currentTaskId: true },
            });
            if (typeof team?.currentTaskId === 'string' && team.currentTaskId) {
              return team.currentTaskId;
            }
          } catch (err) {
            this.logger.warn(
              `verdict 任务定位失败 channel=${channelId}（团队活跃任务读取）：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (typeof channel?.taskId === 'string' && channel.taskId) {
          return channel.taskId;
        }
      } catch (err) {
        this.logger.warn(
          `verdict 任务定位失败 channel=${channelId}（频道读取）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return null;
  }

  /** 镜像 findHostIssueId：按更新倒序遍历任务 issues，首个可解析账本即宿主。 */
  private async findHostIssueId(taskId: string): Promise<string | null> {
    try {
      const rows = (await this.prisma.issue.findMany({
        where: { taskId },
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: { id: true, description: true },
      })) as unknown as Array<{ id: string; description?: string | null }>;
      for (const row of rows ?? []) {
        if (tryParseLedger(row?.description ?? null)) return row.id;
      }
      return null;
    } catch (err) {
      this.logger.warn(
        `verdict 宿主定位失败 task=${taskId}：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * 组装门层通知三元组（频道 + 计划员 + PM，外加 taskId/teamId）。
   * 任一必需 id 缺失 → warn 记 gap，但仍用尽力而为 opts 调用门层
   *（账本写绝不因通知接线不全而丢失）。
   */
  private async resolveNotifyOpts(
    taskId: string,
    channelId: string | null,
    event: RealtimeEvent,
  ): Promise<ConvergenceNotifyOpts> {
    let teamId: string | null =
      typeof (event as { teamId?: unknown }).teamId === 'string'
        ? ((event as { teamId?: unknown }).teamId as string)
        : null;
    try {
      const task = await (this.prisma as any).task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      if (typeof task?.teamId === 'string' && task.teamId) {
        teamId = task.teamId;
      }
    } catch (err) {
      this.logger.warn(
        `verdict 任务查团队失败 task=${taskId}（teamId 尽力而为）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let plannerMemberId: string | null = null;
    let pmMemberId: string | null = null;
    if (teamId) {
      try {
        const planner = await (this.prisma as any).teamMember.findFirst({
          where: { teamId, agentId: PLANNER_AGENT_ID },
          orderBy: [{ seq: 'asc' }, { id: 'asc' }],
          select: { id: true },
        });
        plannerMemberId =
          typeof planner?.id === 'string' && planner.id ? planner.id : null;
      } catch (err) {
        this.logger.warn(
          `verdict 计划员成员查找失败 task=${taskId} team=${teamId}（尽力而为转发）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        const team = await (this.prisma as any).team.findUnique({
          where: { id: teamId },
          select: { mainAgentMemberId: true },
        });
        pmMemberId =
          typeof team?.mainAgentMemberId === 'string' && team.mainAgentMemberId
            ? team.mainAgentMemberId
            : null;
      } catch (err) {
        this.logger.warn(
          `verdict PM成员查找失败 task=${taskId} team=${teamId}（尽力而为转发）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const gaps: string[] = [];
    if (!channelId) gaps.push('channelId');
    if (!plannerMemberId) gaps.push('plannerMemberId');
    if (!pmMemberId) gaps.push('pmMemberId');
    if (gaps.length > 0) {
      this.logger.warn(
        `verdict 通知接线不全 task=${taskId} 缺失=${gaps.join(',')}（尽力而为转发，账本写优先）`,
      );
    }
    return {
      channelId: channelId ?? '',
      plannerMemberId: plannerMemberId ?? '',
      pmMemberId: pmMemberId ?? '',
      taskId,
      ...(teamId ? { teamId } : {}),
    };
  }
}
