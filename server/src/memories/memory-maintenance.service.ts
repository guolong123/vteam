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

/** 整理间隔默认 24h（env `MEMORY_MAINTENANCE_INTERVAL_MS`，0 = 禁用）。 */
export const DEFAULT_MEMORY_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 低频未引用判定阈值（天，env `MEMORY_ORG_UNUSED_DAYS`）。 */
export const DEFAULT_MEMORY_ORG_UNUSED_DAYS = 30;
/** 每团队候选清单上限（env `MEMORY_ORG_CANDIDATE_LIMIT`）。 */
export const DEFAULT_MEMORY_ORG_CANDIDATE_LIMIT = 50;
/** 派给 Agent 的单轮处理上限：超出留待下轮（prompt 内约束，不做服务端截断外的动作）。 */
export const MEMORY_MAINTENANCE_PROMPT_ITEM_LIMIT = 20;

/** 合法标签词表（复用既有约定，worker-dispatcher MEMORY_INSTRUCTION / web TYPE_TAGS 同值）。 */
export const MEMORY_ORG_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'howto',
  'pitfall',
  'constraint',
]);

/** 候选分组（三类，system 条与 /maintain 摘要同口径）。 */
export type MemoryCandidateGroup = 'duplicates' | 'unused' | 'untags';

/** 单条候选（服务端只列清单，不做合并/归档决策）。 */
export interface MemoryOrgCandidate {
  id: string;
  /** 内容摘要（截断至 80 字，供 Agent 判断，省其回查全文）。 */
  excerpt: string;
  tags: string[];
  refCount: number;
  group: MemoryCandidateGroup;
  /** 建议动作（中文短句，进 prompt；最终动作由 Agent 决定）。 */
  suggestedAction: string;
}

/** 单轮结果摘要（POST /memories/maintain 返回体 / 测试断言面）。 */
export interface MemoryMaintenanceSummary {
  teams: number;
  candidates: Record<MemoryCandidateGroup, number>;
}

const EXCERPT_MAX = 80;
const MS_PER_DAY = 86_400_000;

/**
 * 记忆定时整理管线（memory-enhancement Todo 9）。
 *
 * ## 分工边界（本服务刻意不做的事）
 * 平台**不调 LLM、不做合并/归档决策、不硬删**：服务端只做三件确定性的事——
 * ① 按规则列出候选清单；② 在团队群落一条灰色 system 条留痕；
 * ③ 给该团队主 Agent 派一条带清单的 prompt。判断与执行全在 Agent 侧
 * （`vteam_memory_search` 核对 → `vteam_memory_merge` / `vteam_memory_archive` /
 * `vteam_memory_update` 归一标签）。这是 plan 决策⑤与「平台不做 LLM 摘要/提取」护栏。
 *
 * ## 确定性保证
 * system 条里的「上轮实际结果」由 **DB 时间戳**统计（`lastRunAt` 以来 team 级记忆的
 * `mergedIntoId` 非空 / `deletedAt` 落点数），**不依赖 Agent 回传**——Agent 不回复、
 * 超时或崩了，留痕数字依然为真。首次运行无 `lastRunAt` → 省略该从句。
 *
 * ## 范围
 * 只处理 **team 级**记忆（决策⑤：global/role 无宿主团队，global 写操作仅管理员 UI 单条处理）。
 */
@Injectable()
export class MemoryMaintenanceService implements OnModuleInit {
  private readonly logger = new Logger(MemoryMaintenanceService.name);
  /** 上一轮派发起始时刻；冷却 guard 与「上轮结果」统计共用。进程内内存态（无新列）。 */
  private lastRunAt: Date | null = null;
  /** 上一轮是否已在执行（冷却 guard 用，重入即拒）。 */
  private running = false;

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

  /** handler 入口（trigger 消费）。内部即 `runOnce`，异常由基座落 failed。 */
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
   * - 既有 pending 行 → 原样保留（fireCount 不清零）；
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
          '团队记忆定时整理（服务端只列候选 + 派 prompt，执行在 agent 侧）',
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
   * a) 取有活跃 team 级记忆的团队；
   * b) 逐团队收集候选（同 hash 组 / 低频未引用 / 标签不规范，cap 后带摘要与建议动作）；
   * c) 落灰色 system 条（本轮检测 + 上轮实际结果）；
   * d) 派 prompt 给该团队主 Agent（kind='wake'、internal=true、private 频道优先）；
   * e) 记录 `lastRunAt`（下轮统计基准）。
   *
   * 逐团队 try/catch 隔离：单团队失败只 logger.error，不中断其他团队。
   */
  async runOnce(): Promise<MemoryMaintenanceSummary> {
    const summary: MemoryMaintenanceSummary = {
      teams: 0,
      candidates: { duplicates: 0, unused: 0, untags: 0 },
    };
    const previousRunAt = this.lastRunAt;
    this.running = true;
    try {
      const teamIds = await this.teamsWithActiveMemories();
      for (const teamId of teamIds) {
        try {
          await this.maintainTeam(teamId, previousRunAt, summary);
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
      `[memory-maintenance] 单轮完成 teams=${summary.teams} 候选 重复=${summary.candidates.duplicates} 未引用=${summary.candidates.unused} 标签=${summary.candidates.untags}`,
    );
    return summary;
  }

  /** (a) 有活跃 team 级记忆的团队（groupBy teamId，null 归属行跳过）。 */
  private async teamsWithActiveMemories(): Promise<string[]> {
    const rows = await this.prisma.memory.groupBy({
      by: ['teamId'],
      where: {
        level: MEMORY_LEVELS.team,
        deletedAt: null,
        teamId: { not: null },
      },
    });
    return rows
      .map((r) => (r as { teamId: string | null }).teamId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  /** 单团队一轮：候选 → system 条 → 派发。 */
  private async maintainTeam(
    teamId: string,
    previousRunAt: Date | null,
    summary: MemoryMaintenanceSummary,
  ): Promise<void> {
    const candidates = await this.collectCandidates(teamId);
    if (candidates.length === 0) {
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
    const lastResult = previousRunAt
      ? await this.lastRunResult(teamId, previousRunAt)
      : null;
    await this.postMaintenanceNotice(teamId, candidates, lastResult);
    await this.dispatcher.dispatchAgentMention({
      teamId,
      channelId,
      targetInstanceId: mainMemberId,
      kind: 'wake',
      text: this.buildPrompt(candidates),
      internal: true,
    });
    summary.teams += 1;
    for (const c of candidates) {
      summary.candidates[c.group] += 1;
    }
  }

  /**
   * (b) 候选收集（服务端只列清单）：
   * - `duplicates`：同 scope 内同 `contentHash` ≥2 条（精确重复，Agent 复核后合并）；
   * - `unused`：`refCount=0` 且 `lastUsedAt ?? createdAt` 早于 UNUSED_DAYS；
   * - `untags`：`tags` 缺失或含 `howto|pitfall|constraint` 之外的值（Json → 内存过滤）。
   *
   * 三组按「重复 → 未引用 → 标签」优先级去重（同一条只进一组，避免重复提示），
   * 组内按 id 排序保证确定性，整体 cap 到 CANDIDATE_LIMIT。
   */
  private async collectCandidates(
    teamId: string,
  ): Promise<MemoryOrgCandidate[]> {
    const rows = await this.prisma.memory.findMany({
      where: { level: MEMORY_LEVELS.team, teamId, deletedAt: null },
      select: {
        id: true,
        content: true,
        contentHash: true,
        tags: true,
        refCount: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { id: 'asc' },
    });
    const unusedBefore = Date.now() - this.unusedDays() * MS_PER_DAY;

    const byHash = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!row.contentHash) continue;
      const bucket = byHash.get(row.contentHash);
      if (bucket) bucket.push(row);
      else byHash.set(row.contentHash, [row]);
    }

    const picked = new Map<string, MemoryOrgCandidate>();
    const pick = (
      row: (typeof rows)[number],
      group: MemoryCandidateGroup,
      suggestedAction: string,
    ): void => {
      if (picked.has(row.id)) return;
      picked.set(row.id, {
        id: row.id,
        excerpt: (row.content ?? '').slice(0, EXCERPT_MAX),
        tags: this.tagsOf(row.tags),
        refCount: row.refCount,
        group,
        suggestedAction,
      });
    };

    for (const [, bucket] of byHash) {
      if (bucket.length < 2) continue;
      for (const row of bucket) {
        pick(
          row,
          'duplicates',
          `与本组另外 ${bucket.length - 1} 条内容完全相同（contentHash 一致）：核对后合并到信息最全的一条，其余归档`,
        );
      }
    }
    for (const row of rows) {
      if (picked.has(row.id) || row.refCount !== 0) continue;
      const recencyBase = row.lastUsedAt ?? row.createdAt;
      if (recencyBase.getTime() >= unusedBefore) continue;
      pick(
        row,
        'unused',
        `从未被引用且已 ${this.unusedDays()} 天未被检索命中：确认无价值后归档（不要直接删除）`,
      );
    }
    for (const row of rows) {
      if (picked.has(row.id)) continue;
      if (!this.tagsNeedNormalize(row.tags)) continue;
      pick(
        row,
        'untags',
        '标签缺失或不在 howto|pitfall|constraint 之内：归一化标签（内容不动）',
      );
    }

    const limit = this.candidateLimit();
    return [...picked.values()].slice(0, limit);
  }

  /** tags（Json）→ 字符串数组；非数组/非字符串项一律丢弃。 */
  private tagsOf(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    return tags.filter((t): t is string => typeof t === 'string');
  }

  /** 标签是否需要归一化：非数组/空数组（缺失）或含白名单外的值。 */
  private tagsNeedNormalize(tags: unknown): boolean {
    const list = this.tagsOf(tags);
    if (list.length === 0) return true;
    return list.some((t) => !MEMORY_ORG_ALLOWED_TAGS.has(t));
  }

  /** (c) 灰色 system 条：`senderType=system` 落 team_group 频道 + 广播（抄 postStallNoticeToTeamGroup）。 */
  private async postMaintenanceNotice(
    teamId: string,
    candidates: MemoryOrgCandidate[],
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
    const count = (g: MemoryCandidateGroup): number =>
      candidates.filter((c) => c.group === g).length;
    let text =
      `【记忆整理】本轮检测：疑似重复 ${count('duplicates')} · ` +
      `低频未引用 ${count('unused')} · 标签不规范 ${count('untags')}，已派发整理`;
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
   * 派给主 Agent 的 prompt（风格抄 triggerMemoryHarvest：任务说明 + 清单 + 步骤指令）。
   * 单轮上限 20 条：清单超长时截断并显式告知「余量留待下轮」，不诱导 Agent 赶工。
   */
  private buildPrompt(candidates: MemoryOrgCandidate[]): string {
    const shown = candidates.slice(0, MEMORY_MAINTENANCE_PROMPT_ITEM_LIMIT);
    const deferred = candidates.length - shown.length;
    const lines = shown.map((c, i) => {
      const tags = c.tags.length > 0 ? c.tags.join(',') : '（无）';
      return (
        `${i + 1}. [${c.id}] tags=${tags} refCount=${c.refCount}\n` +
        `   内容：${c.excerpt}\n   建议动作：${c.suggestedAction}`
      );
    });
    return (
      `【记忆整理】本轮平台按确定性规则筛出本团队 ${candidates.length} 条待整理记忆（下方清单）。` +
      '平台只负责「列出候选」，判断与执行全部由你决定——清单可能误报也可能漏报，请自行核实后再动手。\n' +
      '执行步骤：\n' +
      '① 逐条用 vteam_memory_search 按关键词检索，确认该条是否真的重复/真的无价值（不要只凭清单措辞下手）；\n' +
      '② 语义重复的一对：保留信息最全的一条作 target，用 vteam_memory_merge 把其余并入（引用计数自动累加，source 自动归档）；\n' +
      '③ 低价值、已过时、或已被更完整条目覆盖的：用 vteam_memory_archive 归档（可恢复，不是删除）；\n' +
      `④ 标签缺失或不合规的：用 vteam_memory_update 把 tags 归一到 ${[...MEMORY_ORG_ALLOWED_TAGS].join(' / ')}（只改标签，不动内容）；\n` +
      `⑤ 单轮最多处理 ${MEMORY_MAINTENANCE_PROMPT_ITEM_LIMIT} 条` +
      (deferred > 0
        ? `，本轮超出部分（${deferred} 条）留待下轮，不要赶工。`
        : '，本轮清单已全部列出。') +
      '\n只整理本团队的 team 级记忆，不要动 global/role 级。处理完简要汇报：合并几条、归档几条、改标签几条，以及你判断为「不该动」的条目及原因。\n' +
      '待整理清单：\n' +
      lines.join('\n')
    );
  }

  /** 整理间隔 ms（env `MEMORY_MAINTENANCE_INTERVAL_MS`；非法值回落默认；0 = 禁用）。 */
  private intervalMs(): number {
    return this.envNumber(
      'MEMORY_MAINTENANCE_INTERVAL_MS',
      DEFAULT_MEMORY_MAINTENANCE_INTERVAL_MS,
    );
  }

  /** 低频未引用阈值（天，env `MEMORY_ORG_UNUSED_DAYS`；非正数回落默认）。 */
  private unusedDays(): number {
    const n = this.envNumber(
      'MEMORY_ORG_UNUSED_DAYS',
      DEFAULT_MEMORY_ORG_UNUSED_DAYS,
    );
    return n > 0 ? n : DEFAULT_MEMORY_ORG_UNUSED_DAYS;
  }

  /** 候选上限（env `MEMORY_ORG_CANDIDATE_LIMIT`；非正数回落默认）。 */
  private candidateLimit(): number {
    const n = this.envNumber(
      'MEMORY_ORG_CANDIDATE_LIMIT',
      DEFAULT_MEMORY_ORG_CANDIDATE_LIMIT,
    );
    return n > 0 ? Math.floor(n) : DEFAULT_MEMORY_ORG_CANDIDATE_LIMIT;
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
