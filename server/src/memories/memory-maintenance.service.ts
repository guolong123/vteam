import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { IdGeneratorService } from '../common/id-generator';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { TRIGGER_KIND } from '../common/constants/trigger.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  TRIGGER_STATUS,
  TriggerService,
  type TriggerFireContext,
} from '../timers/trigger.service';
import { MEMORY_LEVELS } from './memory.constants';

/** 全局单行触发器 dedupKey（一域一行，mirror hook_poll / progression）。 */
export const MEMORY_MAINTENANCE_DEDUP_KEY = 'memory_maintenance:global:main';

/** 冷却 guard key：上一轮派发未落完时拒绝重入（避免慢轮叠轮）。 */
export const MEMORY_MAINTENANCE_COOLDOWN_GUARD = 'memory_maintenance_cooldown';

/** 整理间隔默认 7 天（env `MEMORY_MAINTENANCE_INTERVAL_MS`，0 = 禁用）。 */
export const DEFAULT_MEMORY_MAINTENANCE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** 派给 Agent 的单轮处理上限：超出留待下轮（游标续跑，见 `organizedAtByTeam`）。 */
export const MEMORY_MAINTENANCE_PROMPT_ITEM_LIMIT = 20;

/** 合法标签词表（复用既有约定，worker-dispatcher MEMORY_INSTRUCTION / web TYPE_TAGS 同值）。 */
export const MEMORY_ORG_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'howto',
  'pitfall',
  'constraint',
]);

/**
 * 单条新记忆的**事实**行（服务端只列事实，不做任何判断）。
 * 重复/低价值/标签是否规范一律由 Agent 侧判定（平台不做语义检测，见类注释）。
 */
export interface MemoryOrgFact {
  id: string;
  /** 内容节选（截断至 EXCERPT_MAX 字，供 Agent 判断，省其回查全文）。 */
  content: string;
  tags: string[];
  refCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** 单轮结果摘要（POST /memories/maintain 返回体 / 测试断言面）。 */
export interface MemoryMaintenanceSummary {
  /** 本轮真正派发的团队数。 */
  teams: number;
  /** 已派发团队的新记忆条数之和（同一团队跨轮只计新增部分）。 */
  newMemories: number;
}

const EXCERPT_MAX = 160;

/**
 * 记忆定时整理管线（memory-enhancement Todo 9）。
 *
 * ## 分工边界：服务端零检测（决策修订，替代原「服务端列候选」设计）
 * 平台**不调 LLM、不做语义相似/重复判定、不判断低价值与标签是否规范、不硬删**。
 * 服务端只做两件确定性的事——
 * ① **闸门**：「该团队自上次整理以来是否有新记忆」（每团队独立游标，无则静默跳过）；
 * ② **呈事实**：把新记忆的 id / 内容节选 / 标签 / 引用次数 / 时间列给 Agent。
 * 判断与执行全在 Agent 侧（`vteam_memory_search` 逐条核对 → `vteam_memory_merge` /
 * `vteam_memory_archive` / `vteam_memory_update`）。这是「平台不做 LLM 摘要/提取」护栏的延伸：
 * 代码做不了语义去重，硬做只会给出误导性的「疑似重复」清单。
 *
 * ## 每团队游标（`organizedAtByTeam`，进程内内存态，无新列）
 * 新记忆 = `team_id=X AND deleted_at IS NULL AND created_at > 游标`，按 `created_at ASC` 取。
 * - 无游标（该团队首轮）→ 全部活跃行都算「新」→ 首轮是有界全量扫描（受单轮 20 条上限约束）。
 * - 游标只在**成功派发后**推进：清单全量入 prompt → 游标 = now；被 20 条上限截断 →
 *   游标 = 末条已列入行的 `createdAt`，下轮从那里续跑（cap 之上的行不会被饿死）。
 *   *已知取舍*：若截断点恰好落在多条同毫秒记录的边界上，游标只认最后一条已列入者，
 *   同毫秒的其余行会被下一轮重新计入（重复呈现，幂等安全，不会漏）。
 * - 冷却 guard 另用全局 `lastRunAt`（与游标解耦：游标按团队走，冷却按进程走）。
 *
 * ## 确定性保证
 * system 条里的「上轮实际结果」由 **DB 时间戳**统计（该团队上轮游标以来 team 级记忆的
 * `mergedIntoId` 非空 / `deletedAt` 落点数），**不依赖 Agent 回传**——Agent 不回复、
 * 超时或崩了，留痕数字依然为真。该团队首轮无游标 → 省略该从句。
 *
 * ## 范围
 * 只处理 **team 级**记忆（决策⑤：global/role 无宿主团队，global 写操作仅管理员 UI 单条处理）。
 * 整理**范围**（整轮 vs 单团队）由 `runOnce(scopeTeamId?)` 决定：缺省=全局（定时触发器），
 * 传 teamId=只整理该团队（手动端点）；逐团队管线两种范围完全一致。
 */
@Injectable()
export class MemoryMaintenanceService implements OnModuleInit {
  private readonly logger = new Logger(MemoryMaintenanceService.name);
  /** 上一轮派发起始时刻；**仅供冷却 guard**（间隔内不重入）。进程内内存态（无新列）。 */
  private lastRunAt: Date | null = null;
  /** 上一轮是否已在执行（冷却 guard 用，重入即拒）。 */
  private running = false;
  /**
   * 每团队「已整理到」的游标（= 该团队上一轮整理覆盖到的记忆时间边界）。
   * 派发成功后推进；无条目的团队 = 首轮（全量活跃行都算新）。
   */
  private readonly organizedAtByTeam = new Map<string, Date>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
    private readonly triggers: TriggerService,
    private readonly dispatcher: WorkerDispatcher,
  ) {}

  /**
   * 接线三件事（幂等；TriggerService 缺席时 no-op 与 progression 同款）：
   * ① handler：`memory_maintenance` → 单轮整理；
   * ② guard：上一轮未跑完（或间隔内已跑过）拒绝重入；
   * ③ 全局单行 interval 排期（env 0 = 禁用 → 不排期并取消既有行）。
   *
   * handler/guard 注册失败只 warn 不抛：整理是后台优化，缺席不该让进程起不来。
   */
  async onModuleInit(): Promise<void> {
    try {
      this.triggers.registerHandler(TRIGGER_KIND.MEMORY_MAINTENANCE, (ctx) =>
        this.handleFire(ctx),
      );
      this.triggers.registerGuard(MEMORY_MAINTENANCE_COOLDOWN_GUARD, () =>
        this.cooldownGuard(),
      );
    } catch (err) {
      this.logger.warn(
        `[memory-maintenance] 触发器接线失败（定时整理不跑，其余功能不受影响）: ${this.describeError(err)}`,
      );
      return;
    }
    try {
      await this.ensureGlobalTrigger();
    } catch (err) {
      this.logger.warn(
        `[memory-maintenance] 全局行排期失败（下次启动重试）: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * handler 入口（trigger 消费）。内部即 `runOnce()` **全局变体**（不带 scope）——定时语义
   * 固定为「全平台每 7 天一轮（env 可改，0=禁用）」，scope 只由 `POST /memories/maintain`
   * 的 body 传入。异常由基座落 failed。
   */
  private async handleFire(_ctx: TriggerFireContext): Promise<void> {
    await this.runOnce();
  }

  /**
   * 冷却 guard：上一轮仍在执行 → 否决（留 pending 待下轮复核）。
   * 异常 fail-open 放行（对齐 progression guard 惯例：guard 不该把整理永久卡死）。
   */
  private async cooldownGuard(): Promise<boolean> {
    try {
      if (this.running) {
        this.logger.log('[memory-maintenance] 冷却中：上一轮未跑完，本轮跳过');
        return false;
      }
      const intervalMs = this.intervalMs();
      if (intervalMs > 0 && this.lastRunAt) {
        const elapsed = Date.now() - this.lastRunAt.getTime();
        if (elapsed < intervalMs) {
          return false;
        }
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `[memory-maintenance] 冷却判定异常，fail-open 放行: ${this.describeError(err)}`,
      );
      return true;
    }
  }

  /**
   * 全局单行排期（幂等，抄 hook.service ensureGlobalPoll）：
   * - `intervalMs <= 0`（env 0 = 禁用）→ 不排期，且把既有 pending 行 cancel 掉；
   * - 既有 pending 行 → **间隔一致时原样保留**（fireCount 不清零）；**间隔变更时就地改**
   *   `intervalMs` + `nextFireAt`（否则 dedupKey 幂等会把旧排期钉死，改 env 永不生效——
   *   生产上正躺着一条 24h 的 pending 行，新默认 7d 靠这条分支落地）；
   * - 既有终态行 → 先删后建（否则 dedupKey 幂等回旧行，改 env 后永不生效）；
   *   删失败 → 记 warn 并跳过本次重建（不排期）。
   */
  private async ensureGlobalTrigger(): Promise<void> {
    const intervalMs = this.intervalMs();
    const existing = await this.prisma.trigger.findUnique({
      where: { dedupKey: MEMORY_MAINTENANCE_DEDUP_KEY },
    });
    if (intervalMs <= 0) {
      if (existing && existing.status !== TRIGGER_STATUS.CANCELLED) {
        await this.triggers.cancel(existing.id);
        this.logger.log(
          '[memory-maintenance] interval=0（禁用），已取消既有全局行',
        );
      }
      return;
    }
    if (existing) {
      if (existing.status === TRIGGER_STATUS.PENDING) {
        if (existing.intervalMs !== intervalMs) {
          // 就地改排期：保留 id / fireCount / status，只把周期与下次触发时刻对齐新 env。
          await this.prisma.trigger.update({
            where: { id: existing.id },
            data: {
              intervalMs,
              nextFireAt: new Date(Date.now() + intervalMs),
            },
          });
          this.logger.log(
            `[memory-maintenance] 全局 pending 行间隔已更新 ${existing.intervalMs ?? 'null'}ms → ${intervalMs}ms（下次 ${new Date(Date.now() + intervalMs).toISOString()}）`,
          );
        }
        return;
      }
      // 旧行删不掉时必须整段放弃：schedule 会按 dedupKey 幂等返回那条旧行，
      // 继续往下走等于「静默沿用旧排期」，与日志宣称的「跳过本次重建」相反。
      try {
        await this.prisma.trigger.delete({
          where: { dedupKey: MEMORY_MAINTENANCE_DEDUP_KEY },
        });
      } catch (err) {
        this.logger.warn(
          `[memory-maintenance] 终态行删除失败，跳过本次重建: ${this.describeError(err)}`,
        );
        return;
      }
    }
    await this.triggers.schedule(
      TRIGGER_KIND.MEMORY_MAINTENANCE as string,
      new Date(Date.now() + intervalMs),
      {
        scope: 'global',
        purpose:
          '团队记忆定时整理（服务端只按「自上次整理以来的新记忆」派事实清单，判断与执行在 agent 侧）',
      },
      MEMORY_MAINTENANCE_DEDUP_KEY,
      { intervalMs, guardKey: MEMORY_MAINTENANCE_COOLDOWN_GUARD },
    );
    this.logger.log(
      `[memory-maintenance] 全局单行已排期 interval=${intervalMs}ms`,
    );
  }

  /**
   * 单轮整理（handler 与 `POST /memories/maintain` 共用同一入口，保证手动/定时口径一致）。
   *
   * @param scopeTeamId 整理范围：**缺省 = 全局一轮**（定时触发器固定走这个变体，行为不变）；
   *   传团队 id = 只整理该团队（「点谁整理谁」，手动端点 body.teamId）。范围只影响
   *   「迭代哪些团队」，逐团队管线与摘要口径完全一致。
   *
   * a) 取有活跃 team 级记忆的团队（指定范围时只取该团队）；
   * b) 逐团队按游标取新记忆事实（无新 → 静默跳过）；
   * c) 落灰色 system 条（新记忆条数 + 上轮实际结果）；
   * d) 派 prompt 给该团队主 Agent（kind='wake'、internal=true、private 频道优先）；
   * e) 推进该团队游标（cap 截断时落到末条已列入行，下轮续跑）。
   *
   * 逐团队 try/catch 隔离：单团队失败只 logger.error，不中断其他团队。
   */
  async runOnce(scopeTeamId?: string): Promise<MemoryMaintenanceSummary> {
    const summary: MemoryMaintenanceSummary = {
      teams: 0,
      newMemories: 0,
    };
    this.running = true;
    try {
      const teamIds = await this.teamsWithActiveMemories(scopeTeamId);
      for (const teamId of teamIds) {
        try {
          await this.maintainTeam(teamId, summary);
        } catch (err) {
          this.logger.error(
            `[memory-maintenance] 团队整理失败（已隔离，不影响其他团队）team=${teamId}: ${this.describeError(err)}`,
            (err as Error).stack,
          );
        }
      }
    } finally {
      this.running = false;
      this.lastRunAt = new Date();
    }
    this.logger.log(
      `[memory-maintenance] 单轮完成 teams=${summary.teams} 新记忆=${summary.newMemories}` +
        (scopeTeamId ? ` scope=${scopeTeamId}` : ''),
    );
    return summary;
  }

  /**
   * (a) 有活跃 team 级记忆的团队（groupBy teamId，null 归属行跳过）。
   * `scopeTeamId` 缺省 → `teamId: {not: null}`（全局，与既有查询逐字一致）；
   * 指定 → `teamId: scopeTeamId`（只回该团队一行；无活跃记忆则空集 → 本轮 teams=0、不派发）。
   */
  private async teamsWithActiveMemories(
    scopeTeamId?: string,
  ): Promise<string[]> {
    const rows = await this.prisma.memory.groupBy({
      by: ['teamId'],
      where: {
        level: MEMORY_LEVELS.team,
        deletedAt: null,
        teamId: scopeTeamId ?? { not: null },
      },
    });
    return rows
      .map((r) => (r as { teamId: string | null }).teamId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  /** 单团队一轮：闸门 → system 条 → 派发 → 推游标。 */
  private async maintainTeam(
    teamId: string,
    summary: MemoryMaintenanceSummary,
  ): Promise<void> {
    const cursor = this.organizedAtByTeam.get(teamId) ?? null;
    const facts = await this.listNewMemories(teamId, cursor);
    if (facts.length === 0) {
      this.logger.log(
        `[memory-maintenance] team=${teamId} 自上次整理无新记忆，本轮跳过派发`,
      );
      return;
    }
    const mainMemberId = await this.mainAgentMemberOf(teamId);
    if (!mainMemberId) {
      this.logger.warn(
        `[memory-maintenance] 跳过 team=${teamId}（未设置 mainAgentMemberId，无人可派发）`,
      );
      return;
    }
    const channelId = await this.resolveDispatchChannel(teamId, mainMemberId);
    if (!channelId) {
      this.logger.warn(
        `[memory-maintenance] 跳过 team=${teamId}（主 Agent 私聊与群聊频道均缺失）`,
      );
      return;
    }
    // 上轮实际结果的统计窗口 = 该团队本轮**之前**的游标（首轮无游标 → null → 省略从句）。
    const lastResult = cursor
      ? await this.lastRunResult(teamId, cursor)
      : null;
    const shown = facts.slice(0, MEMORY_MAINTENANCE_PROMPT_ITEM_LIMIT);
    await this.postMaintenanceNotice(teamId, facts.length, lastResult);
    await this.dispatcher.dispatchAgentMention({
      teamId,
      channelId,
      targetInstanceId: mainMemberId,
      kind: 'wake',
      text: this.buildPrompt(shown, facts.length),
      internal: true,
    });
    this.advanceCursor(teamId, facts, shown);
    summary.teams += 1;
    summary.newMemories += facts.length;
  }

  /**
   * 派发成功后推进游标：
   * - 清单全量入 prompt → 游标 = now（此后创建的记忆才算新）；
   * - 被单轮 20 条上限截断 → 游标 = 末条**已列入**行的 `createdAt`，下轮从那里续跑
   *   （cap 之上的行不会被饿死）。取舍：截断点若正落在多条同毫秒记录的边界上，
   *   同毫秒的其余行下一轮会被重新计入（重复呈现而非漏掉，幂等安全）。
   */
  private advanceCursor(
    teamId: string,
    facts: MemoryOrgFact[],
    shown: MemoryOrgFact[],
  ): void {
    const truncated = shown.length < facts.length;
    this.organizedAtByTeam.set(
      teamId,
      truncated ? shown[shown.length - 1].createdAt : new Date(),
    );
  }

  /**
   * (b) 新记忆事实行（服务端零检测：只按「游标之后创建」取行，不看内容/标签/引用数）：
   * `teamId=X AND level=team AND deletedAt IS NULL [AND createdAt > cursor]`，
   * 按 `createdAt ASC` 保证「先到先得」与截断续跑的稳定性。
   */
  private async listNewMemories(
    teamId: string,
    cursor: Date | null,
  ): Promise<MemoryOrgFact[]> {
    const rows = await this.prisma.memory.findMany({
      where: {
        level: MEMORY_LEVELS.team,
        teamId,
        deletedAt: null,
        // 游标缺省（该团队首轮）→ 不带时间条件 = 全部活跃行都算新（有界全量扫描）。
        ...(cursor ? { createdAt: { gt: cursor } } : {}),
      },
      select: {
        id: true,
        content: true,
        tags: true,
        refCount: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      content: (row.content ?? '').slice(0, EXCERPT_MAX),
      tags: this.tagsOf(row.tags),
      refCount: row.refCount,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    }));
  }

  /** tags（Json）→ 字符串数组；非数组/非字符串项一律丢弃。 */
  private tagsOf(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    return tags.filter((t): t is string => typeof t === 'string');
  }

  /** (c) 灰色 system 条：`senderType=system` 落 team_group 频道 + 广播（抄 postStallNoticeToTeamGroup）。 */
  private async postMaintenanceNotice(
    teamId: string,
    newCount: number,
    lastResult: { merged: number; archived: number } | null,
  ): Promise<void> {
    const channel = await this.prisma.chatChannel.findFirst({
      where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
      select: { id: true },
    });
    if (!channel) {
      this.logger.warn(
        `[memory-maintenance] system 条跳过 team=${teamId}（无 team_group 频道）`,
      );
      return;
    }
    let text = `【记忆整理】发现 ${newCount} 条新记忆，已派发整理`;
    if (lastResult) {
      text += `。上轮实际结果：合并 ${lastResult.merged} 条 · 归档 ${lastResult.archived} 条`;
    }
    const row = await this.prisma.message.create({
      data: {
        id: await this.idGen.nextId('m'),
        channelId: channel.id,
        senderType: SENDER_TYPE.system,
        senderId: null,
        content: { text, parts: [] },
        mentions: null,
        status: MESSAGE_STATUS.sent,
      },
      select: { id: true },
    });
    await this.realtime.broadcast(
      EVENT_TYPES.CHAT_MESSAGE_NEW,
      {
        message: {
          id: row.id,
          channelId: channel.id,
          senderType: SENDER_TYPE.system,
          senderId: null,
          content: { text, parts: [] },
          mentions: [],
          status: MESSAGE_STATUS.sent,
          createdAt: new Date().toISOString(),
        },
      },
      { type: 'channel', id: channel.id },
    );
  }

  /**
   * (c) 上轮实际结果：**服务端 DB 统计**（不依赖 Agent 回传）——
   * `since` 以来 team 级记忆中 `mergedIntoId` 非空（被合并）与 `deletedAt` 落点（被归档）的条数。
   */
  private async lastRunResult(
    teamId: string,
    since: Date,
  ): Promise<{ merged: number; archived: number }> {
    const base = {
      level: MEMORY_LEVELS.team,
      teamId,
      updatedAt: { gte: since },
    };
    const [merged, archived] = await this.prisma.$transaction([
      this.prisma.memory.count({
        where: { ...base, mergedIntoId: { not: null } },
      }),
      this.prisma.memory.count({
        where: { ...base, deletedAt: { gte: since } },
      }),
    ]);
    return { merged, archived };
  }

  /**
   * (d) 派发频道解析：主 Agent 私聊优先 → team_group 回退
   * （抄 task-progression.scheduler dispatchToMainAgent，避免整理 prompt 污染群聊）。
   */
  private async resolveDispatchChannel(
    teamId: string,
    mainMemberId: string,
  ): Promise<string | null> {
    const priv = await this.prisma.chatChannel.findFirst({
      where: { teamId, teamMemberId: mainMemberId, deletedAt: null },
      select: { id: true },
    });
    if (priv) return priv.id;
    const group = await this.prisma.chatChannel.findFirst({
      where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
      select: { id: true },
    });
    return group?.id ?? null;
  }

  /** 主 Agent 成员 id（`Team.mainAgentMemberId`；未设置 → null，调用方跳过该团队）。 */
  private async mainAgentMemberOf(teamId: string): Promise<string | null> {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { mainAgentMemberId: true },
    });
    return team?.mainAgentMemberId ?? null;
  }

  /**
   * 派给主 Agent 的 prompt：**只陈事实 + 把判断权完整交给 Agent**。
   *
   * @param facts 已按单轮上限截断的事实行（顺序 = createdAt ASC）。
   * @param teamNewCount 该团队本轮的新记忆总数（`facts` 可能只是其前 N 条）。
   */
  private buildPrompt(facts: MemoryOrgFact[], teamNewCount: number): string {
    const deferred = teamNewCount - facts.length;
    const lines = facts.map((f, i) => {
      const tags = f.tags.length > 0 ? f.tags.join(',') : '（无）';
      const lastHit = f.lastUsedAt ? this.factDate(f.lastUsedAt) : '从未';
      return (
        `${i + 1}. [${f.id}] tags=${tags} refCount=${f.refCount} ` +
        `建于=${this.factDate(f.createdAt)} 最近命中=${lastHit}\n` +
        `   内容：${f.content}`
      );
    });
    return (
      `【记忆整理】本团队自上次整理后新增 ${teamNewCount} 条记忆（下方清单）。\n` +
      '平台只负责**列事实**：下面每条仅是 id / 标签 / 被引用次数 / 建档与最近命中时间 / 内容节选。' +
      '平台不做任何判断——哪条重复、哪条过时、哪条该归档、标签是否规范，全部由你判断后再动手。\n' +
      '执行步骤：\n' +
      '① 逐条用 vteam_memory_search 检索本团队既有记忆，与这条新记忆逐条对比（不要只凭内容节选下手）；\n' +
      '② 语义重复（同一件事的不同说法、或被更完整表述覆盖）的：保留信息最全的一条作 target，' +
      '用 vteam_memory_merge 把其余并入（引用计数自动累加，source 自动归档）；\n' +
      `③ 标签缺失或不在 ${[...MEMORY_ORG_ALLOWED_TAGS].join(' / ')} 之内的：` +
      '用 vteam_memory_update 只改标签，不动内容；\n' +
      '④ 结合 refCount、建档与最近命中时间、内容本身，自行判断低价值或已过时的：' +
      '用 vteam_memory_archive 归档（可恢复，不是删除）；**拿不准就不动**——保持你已建立的「不该动就不动」纪律，' +
      '宁可下轮再判，也不要为凑数而改；\n' +
      '⑤ 清单是本轮新记忆的主体；处理清单之外你顺手发现的历史语义重复，也可一并处理。\n' +
      '只整理本团队的 team 级记忆，不要动 global/role 级。处理完简要汇报：' +
      '合并 X 条 / 归档 Y 条 / 改标签 Z 条 / 判断为不该动 W 条（附一句原因）。\n' +
      `本轮共 ${teamNewCount} 条新记忆，单轮上限 ${MEMORY_MAINTENANCE_PROMPT_ITEM_LIMIT} 条，` +
      (deferred > 0
        ? `已列出前 ${facts.length} 条，还有 ${deferred} 条留待下轮，不要赶工。\n`
        : '已全部列出。\n') +
      '新记忆清单：\n' +
      lines.join('\n')
    );
  }

  /** 事实行时间 → `YYYY-MM-DD`（prompt 里省 token；不做时区换算，够 Agent 判断新旧）。 */
  private factDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** 整理间隔 ms（env `MEMORY_MAINTENANCE_INTERVAL_MS`；非法值回落默认；0 = 禁用）。 */
  private intervalMs(): number {
    return this.envNumber(
      'MEMORY_MAINTENANCE_INTERVAL_MS',
      DEFAULT_MEMORY_MAINTENANCE_INTERVAL_MS,
    );
  }

  /** env 数值解析（抄 trigger.service scanIntervalMs 惯例：写错 env 降级默认，不让进程起不来）。 */
  private envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}