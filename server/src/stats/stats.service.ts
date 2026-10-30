import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { TASK_STATUS } from '../common/constants/task.constants';
import { ARTIFACT_TYPES } from '../artifacts/artifacts.constants';
import { PrismaService } from '../prisma/prisma.service';
import { isPlatformAdminByUserId } from '../users/admin-permission';
import {
  STATS_CACHE_TTL_MS,
  STATS_DEFAULT_GRANULARITY,
  STATS_DEFAULT_WINDOW_DAYS,
  STATS_ERRORS,
  STATS_MAX_WINDOW_DAYS,
  STATS_TIMEZONE,
  type StatsGranularity,
} from './stats.constants';
import {
  addDays,
  bucketKeyOf,
  bucketLabelOf,
  diffDays,
  enumerateBucketKeys,
  localDayOf,
  localDayStartUtc,
  resolveWindow,
} from './stats-time';
import type {
  StatsArtifactTypeSlice,
  StatsBucket,
  StatsMemberRow,
  StatsOverviewResponse,
  StatsTeamDetailResponse,
  StatsTeamRow,
  StatsTotals,
  StatsWindow,
} from './stats.types';

/** 调用方上下文（全局 JwtAuthGuard 填充的 request.user 之 userId）。 */
export interface StatsViewer {
  id: string;
}

/** 查询参数（已由 DTO 校验形状，service 再做窗口合法性复核）。 */
export interface StatsQuery {
  days?: number;
  granularity?: StatsGranularity;
  to?: string;
  teamIds?: string;
}

/** 零值总量（空团队 / 空窗口的统一返回，避免调用方处理 undefined）。 */
export function emptyTotals(): StatsTotals {
  return {
    tasksCreated: 0,
    tasksCompleted: 0,
    tasksBlocked: 0,
    tasksRejected: 0,
    artifacts: 0,
    artifactVersions: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: null,
    costUnknownRatio: 0,
    agentMessages: 0,
    activeMembers: 0,
    costPerTask: null,
    costPerArtifact: null,
    costPerKToken: null,
    cacheHitRate: 0,
    completionRate: 0,
  };
}

/** 日行原始聚合（DB 侧 groupBy 的返回形状，尚未派生比率）。 */
interface DayAgg {
  day: string;
  teamId: string;
  tasksCreated: number;
  tasksCompleted: number;
  tasksBlocked: number;
  tasksRejected: number;
  artifacts: number;
  artifactVersions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costSum: number;
  costKnown: number;
  agentMessages: number;
}

/**
 * 团队统计看板服务（**纯只读**）。
 *
 * ## 数据来源与口径（每个数字都能追到一张表的一列）
 *
 * | 指标 | 表.列 | 口径 |
 * |------|-------|------|
 * | tasksCreated | `tasks.created_at` | 落窗计数 |
 * | tasksCompleted | `tasks.completed_at` | 落窗计数（NULL 不计） |
 * | tasksBlocked / tasksRejected | `task_events` | blocked 按 `to_status`；reject 按 **`event_type='reject'`**（切记不能用 to_status，否则「首次开始」会被误算成驳回） |
 * | artifacts | `artifacts.created_at` | 落窗计数（**去重口径**） |
 * | artifactVersions | `artifact_versions.created_at` | 落窗计数（**版本口径**） |
 * | 六个 token | `model_usages` 六列 | 落窗求和 |
 * | cost | `model_usages.cost` | 落窗求和；NULL 行不计入已知部分 |
 * | agentMessages | `messages` | `sender_type='agent'` 落窗计数 |
 * | activeMembers | `model_usages.team_member_id` | 窗口内去重成员数 |
 *
 * ## 为什么全部走 DB 侧聚合
 *
 * `model_usages` 行数 = 模型调用次数（线上单会话可达 60 行，平台级会到十万级）；
 * `messages` 更是主力表。把这些原始行拉进 node 再累加，一次 90 天全局看板就能把
 * 内存与网络打满。故**所有 sum/count 一律在 MySQL 侧完成**，只回聚合行。
 * 日粒度聚合由 `$queryRaw` 的 `DATE(CONVERT_TZ(...))` 一次算完（见 `loadDailyRows`）。
 *
 * ## 缓存
 *
 * 只读重查询 + 运营者频繁切粒度 ⇒ 进程内 60s TTL 缓存（`STATS_CACHE_TTL_MS`）。
 * 缓存键含**全部**查询维度与查看者（团队详情有成员门，不能跨用户复用）。
 * 单实例部署；多实例各自缓存仍正确，仅命中率低。
 */
@Injectable()
export class StatsService {
  /** 进程内结果缓存：key → { at, value }。 */
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 全局看板：跨团队汇总 + 团队对比 + 时间趋势。
   *
   * 权限：**平台管理员**（AdminGuard 在 controller 层拦截）。
   * 理由：这是跨团队的全量经营数据（每个团队花了多少钱、产出多少），
   * 属于管理视角体检数据，不能对普通团队成员开放——与 `coordination-metrics` 同口径。
   */
  async overview(query: StatsQuery): Promise<StatsOverviewResponse> {
    const window = this.resolveQueryWindow(query);
    const teamIds = this.parseTeamIds(query.teamIds);
    const cacheKey = `overview:${window.from}:${window.to}:${window.granularity}:${teamIds.join(',')}`;
    const cached = this.readCache<StatsOverviewResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    const teams = await this.prisma.team.findMany({
      where: teamIds.length > 0 ? { id: { in: teamIds } } : {},
      select: {
        id: true,
        name: true,
        description: true,
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const dailyRows = await this.loadDailyRows({
      teamIds: teams.map((t) => t.id),
      from: window.from,
      to: window.to,
    });

    const teamsInWindow = teams.map((team) => {
      const rows = dailyRows.filter((r) => r.teamId === team.id);
      const totals = this.deriveTotals(rows);
      return {
        teamId: team.id,
        teamName: team.name,
        description: team.description ?? null,
        memberCount: team._count.members,
        totals,
        avgCycleHours: this.avgOf(this.cycleSamplesByTeam.get(team.id)),
        avgQueueWaitHours: this.avgOf(this.queueSamplesByTeam.get(team.id)),
        queueWaitSource: QUEUE_WAIT_SOURCE,
      } satisfies StatsTeamRow;
    });

    // 团队对比按 totalTokens 降序：运营者第一眼要看到「谁最费钱/最耗资源」。
    teamsInWindow.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens);

    const allRows = dailyRows;
    const totals = this.deriveTotals(allRows);
    // activeMembers 无法从「日 × 团队」稀疏矩阵推出（矩阵里没有成员维度），
    // 单独按窗口去重计数（一次 groupBy，成本极低）。
    totals.activeMembers = await this.countActiveMembers(
      teams.map((t) => t.id),
      window,
    );
    const buckets = this.buildBuckets(allRows, window);
    const completed = totals.tasksCompleted;
    const rework = await this.countRework(
      window,
      teams.map((t) => t.id),
    );

    const result: StatsOverviewResponse = {
      window,
      totals,
      buckets,
      teams: teamsInWindow,
      avgCycleHours: this.avgOf(
        teams.flatMap((t) => this.cycleSamplesByTeam.get(t.id) ?? []),
      ),
      firstPassRate:
        completed > 0 ? Math.max(0, (completed - rework) / completed) : 0,
      reworkCount: rework,
    };
    this.writeCache(cacheKey, result);
    return result;
  }

  /**
   * 单团队详情：窗口总量 + 时间桶 + 周期/质量指标 + 成员产能 + 产出物构成 + 状态快照。
   *
   * 权限：**团队成员可见**（复用 `team_user_members` 判定，非成员回落平台管理员，
   * 与 `usage.service` 的 `assertTeamReadable` 同一口径——全员可见、无 admin 门）。
   */
  async teamDetail(
    teamId: string,
    query: StatsQuery,
    viewer?: StatsViewer,
  ): Promise<StatsTeamDetailResponse> {
    await this.assertTeamReadable(teamId, viewer);

    const window = this.resolveQueryWindow(query);
    const cacheKey = `team:${teamId}:${window.from}:${window.to}:${window.granularity}:${viewer?.id ?? '-'}`;
    const cached = this.readCache<StatsTeamDetailResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true, description: true },
    });
    if (!team) {
      throw new NotFoundException({
        code: STATS_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }

    const dailyRows = await this.loadDailyRows({
      teamIds: [teamId],
      from: window.from,
      to: window.to,
    });
    const totals = this.deriveTotals(dailyRows);
    totals.activeMembers = await this.countActiveMembers([teamId], window);
    const buckets = this.buildBuckets(dailyRows, window);
    const cycleSamples = this.cycleSamplesByTeam.get(teamId) ?? [];
    const queueSamples = this.queueSamplesByTeam.get(teamId) ?? [];
    const rework = await this.countRework(window, [teamId]);

    const [artifactMix, members, statusMix] = await Promise.all([
      this.loadArtifactMix(teamId, window),
      this.loadMembers(teamId, window),
      this.loadStatusMix(teamId),
    ]);

    const completed = totals.tasksCompleted;
    const result: StatsTeamDetailResponse = {
      teamId,
      teamName: team.name,
      description: team.description ?? null,
      window,
      totals,
      buckets,
      avgCycleHours: this.avgOf(cycleSamples),
      cycleHoursP90: this.p90Of(cycleSamples),
      avgQueueWaitHours: this.avgOf(queueSamples),
      queueWaitSource: QUEUE_WAIT_SOURCE,
      firstPassRate:
        completed > 0 ? Math.max(0, (completed - rework) / completed) : 0,
      // 评审轮次当前**没有采集点**（task_events 里没有 round 事件，schema 也无该列）。
      // 如实返回 0 并在设计文档 §9 标注「待补采集」，绝不拿 reviewRounds 编数。
      reviewRounds: 0,
      reworkCount: rework,
      artifactMix,
      members,
      statusMix,
    };
    this.writeCache(cacheKey, result);
    return result;
  }

  /* ==================================================================
   * 日粒度原始聚合（唯一数据入口）
   * ================================================================== */

  /**
   * 周期/排队样本（按团队暂存）。
   *
   * 为什么放在实例字段而不是每次查询重建：`loadDailyRows` 一次查询会**顺带**把
   * 「已完成任务的 startedAt→completedAt」样本取回来（同一次扫表），
   * 后续 overview/teamDetail 直接读，避免为算均值再扫一遍 tasks。
   * 生命周期 = 单次请求内（查询前 clear）。
   */
  private cycleSamplesByTeam = new Map<string, number[]>();
  private queueSamplesByTeam = new Map<string, number[]>();

  /**
   * 载入窗口内**按 (团队, 日)** 聚合的原始行。
   *
   * 实现选型：`$queryRaw` 而不是多条 `groupBy`。
   * 理由：需要 5 张表（tasks / task_events / artifacts / artifact_versions /
   * model_usages / messages）在**同一窗口、同一日粒度**上对齐；用 Prisma `groupBy`
   * 会打 6 次往返再在 node 侧按日 join（还要处理缺失日期），而一条 SQL 的
   * `UNION ALL` + 外层 `GROUP BY` 一次就能把「日 × 团队」的稀疏矩阵补齐，
   * 且聚合完全在 MySQL 侧完成（只回 N 天 × M 团队行，量级极小）。
   *
   * 时区：全部用 `CONVERT_TZ(col, '+00:00', '+08:00')` 再 `DATE()` 取日，
   * 与 `stats-time.ts` 的固定偏移**逐字一致**（两处口径必须同源，改一处必改另一处）。
   */
  private async loadDailyRows(args: {
    teamIds: string[];
    from: string;
    to: string;
  }): Promise<DayAgg[]> {
    // 无团队（平台还没建团队）⇒ 直接空结果，避免发一条 `IN ()` 的非法 SQL。
    if (args.teamIds.length === 0) {
      return [];
    }

    /**
     * 参数绑定方式说明（**改这里之前先读完**）。
     *
     * 本 SQL 有 **7 个 `IN (...)` 子句**，每个都要绑定同一批 teamIds；而
     * `$queryRawUnsafe` 的 `?` 是**位置**占位符，无法「一次绑定多处复用」
     * （要么重复传 7 遍，要么顺序极易错位——错位的后果是把 A 团队的 token 算到 B 团队）。
     *
     * 故这里用两条正交的保证：
     * 1. **日期**仍走参数绑定（`?`）——它们是用户可控输入，必须绑参；
     * 2. **teamIds** 走**白名单转义后内联**——它们不是用户可控的任意字符串，而是
     *    `team.findMany()` 从库里查出来的**真实主键**（已存在性校验），且本函数的
     *    调用方传的是 `teams.map(t => t.id)`。再叠一层 `escapeSqlLiteral` 做字面量转义，
     *    即使未来有人把外部串传进来，也只会是「查不到数据」而不是注入。
     *
     * 为什么不干脆每处都传一遍参数：SQL 里 7 处 × N 个团队会让参数列表膨胀且极易错位，
     * 而这正是统计模块最不能出错的地方（错位 = 静默算错，比报错危险得多）。
     */
    const teamLiterals = args.teamIds
      .map((id) => `'${escapeSqlLiteral(id)}'`)
      .join(', ');

    /**
     * 日期同理走「校验后内联」，而不是 14 个 `?`。
     *
     * 为什么这里不绑参：本 SQL 有 7 个 UNION 分支 × 每分支 2 个日期条件 = 14 个日期位点，
     * 而 `?` 是位置占位符 ⇒ 必须按出现顺序手工铺 14 个相同的值（极易错位，且每次改 SQL
     * 都要数一遍）。日期在**进入本函数前**已经过 `resolveQueryWindow` 的双重校验：
     * 一是 DTO 的 `@Matches(/^\d{4}-\d{2}-\d{2}$/)`，二是 service 内的正则复核 +
     * 未来日期拒绝 ⇒ 其字符集被钉死为「数字与连字符」，不存在注入面。
     * 下面再叠一次形状断言，把「校验在别处、这里假设它成立」变成「这里也自证」。
     */
    for (const day of [args.from, addDays(args.to, 1)]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new BadRequestException({
          code: STATS_ERRORS.QUERY_INVALID,
          message: `非法日期：${day}（须为 YYYY-MM-DD）`,
        });
      }
    }
    const fromLiteral = `'${args.from}'`;
    const toExclusiveLiteral = `'${addDays(args.to, 1)}'`;

    const rows = await this.prisma.$queryRawUnsafe<DayAgg[]>(
      `
      SELECT
        DATE(CONVERT_TZ(x.created_at, '+00:00', '+08:00')) AS day,
        x.team_id AS teamId,
        SUM(x.tasksCreated) AS tasksCreated,
        SUM(x.tasksCompleted) AS tasksCompleted,
        SUM(x.tasksBlocked) AS tasksBlocked,
        SUM(x.tasksRejected) AS tasksRejected,
        SUM(x.artifacts) AS artifacts,
        SUM(x.artifactVersions) AS artifactVersions,
        SUM(x.inputTokens) AS inputTokens,
        SUM(x.outputTokens) AS outputTokens,
        SUM(x.reasoningTokens) AS reasoningTokens,
        SUM(x.cacheReadTokens) AS cacheReadTokens,
        SUM(x.cacheWriteTokens) AS cacheWriteTokens,
        SUM(x.costSum) AS costSum,
        SUM(x.costKnown) AS costKnown,
        SUM(x.agentMessages) AS agentMessages
      FROM (
        -- 任务新建
        SELECT t.team_id, t.created_at,
               1 AS tasksCreated, 0 AS tasksCompleted, 0 AS tasksBlocked, 0 AS tasksRejected,
               0 AS artifacts, 0 AS artifactVersions,
               0 AS inputTokens, 0 AS outputTokens, 0 AS reasoningTokens,
               0 AS cacheReadTokens, 0 AS cacheWriteTokens,
               0 AS costSum, 0 AS costKnown, 0 AS agentMessages
        FROM tasks t
        WHERE t.team_id IN (${teamLiterals})
          AND t.created_at >= CONVERT_TZ(${fromLiteral}, '+08:00', '+00:00')
          AND t.created_at <  CONVERT_TZ(${toExclusiveLiteral}, '+08:00', '+00:00')
        UNION ALL
        -- 任务完成（completed_at 落窗；NULL 不计）
        SELECT t.team_id, t.completed_at,
               0, 1, 0, 0,
               0, 0,
               0, 0, 0, 0, 0,
               0, 0, 0
        FROM tasks t
        WHERE t.team_id IN (${teamLiterals})
          AND t.completed_at IS NOT NULL
          AND t.completed_at >= CONVERT_TZ(${fromLiteral}, '+08:00', '+00:00')
          AND t.completed_at <  CONVERT_TZ(${toExclusiveLiteral}, '+08:00', '+00:00')
        UNION ALL
        -- 任务进入阻塞 / 被验收驳回。
        --
        -- 两条判定必须分别用不同字段，这是线上实测踩过的坑（反引号已换成中文引号：
        -- 本注释位于 TS 模板字符串内，反引号会提前终止模板）。
        -- - 阻塞：to_status='blocked'（block 动作的落点唯一，不会有歧义）；
        -- - 驳回：**event_type='reject'**，不能用 to_status='in_progress'。
        --   reject 的落点是 in_progress（from_status=pending_review），但「首次开始」
        --   （from_status=pending → to_status=in_progress）的落点**也是** in_progress。
        --   若按 to_status 判定，每一次正常开始都会被算成一次驳回 —— 实测线上 6 条
        --   status_change(pending→in_progress) 全被误算成 6 次驳回，返工数与一次通过率
        --   直接失真（一次通过率变成 (0-6)/0）。改为按 event_type 后只认真正的 reject。
        SELECT te_team.team_id, te.created_at,
               0, 0,
               CASE WHEN te.event_type = 'block' OR te.to_status = 'blocked' THEN 1 ELSE 0 END AS tasksBlocked,
               CASE WHEN te.event_type = 'reject' THEN 1 ELSE 0 END AS tasksRejected,
               0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        FROM task_events te
        JOIN tasks te_team ON te_team.id = te.task_id
        WHERE te_team.team_id IN (${teamLiterals})
          AND (
            te.event_type = 'reject'
            OR te.event_type = 'block'
            OR te.to_status = 'blocked'
          )
          AND te.created_at >= CONVERT_TZ(${fromLiteral}, '+08:00', '+00:00')
          AND te.created_at <  CONVERT_TZ(${toExclusiveLiteral}, '+08:00', '+00:00')
        UNION ALL
        -- 产出物（去重口径）
        SELECT a_team.team_id, a.created_at,
               0, 0, 0, 0,
               1, 0,
               0, 0, 0, 0, 0, 0, 0, 0
        FROM artifacts a
        JOIN tasks a_team ON a_team.id = a.task_id
        WHERE a_team.team_id IN (${teamLiterals})
          AND a.created_at >= CONVERT_TZ(${fromLiteral}, '+08:00', '+00:00')
          AND a.created_at <  CONVERT_TZ(${toExclusiveLiteral}, '+08:00', '+00:00')
        UNION ALL
        -- 产出物版本（版本口径，与去重口径独立）
        SELECT av_team.team_id, av.created_at,
               0, 0, 0, 0,
               0, 1,
               0, 0, 0, 0, 0, 0, 0, 0
        FROM artifact_versions av
        JOIN artifacts a2 ON a2.id = av.artifact_id
        JOIN tasks av_team ON av_team.id = a2.task_id
        WHERE av_team.team_id IN (${teamLiterals})
          AND av.created_at >= CONVERT_TZ(${fromLiteral}, '+08:00', '+00:00')
          AND av.created_at <  CONVERT_TZ(${toExclusiveLiteral}, '+08:00', '+00:00')
        UNION ALL
        -- token 与成本（cost 可为 NULL：未知，不计入 costSum 但计入 costKnown=0）
        SELECT mu.team_id, mu.created_at,
               0, 0, 0, 0, 0, 0,
               mu.input_tokens, mu.output_tokens, mu.reasoning_tokens,
               mu.cache_read_tokens, mu.cache_write_tokens,
               COALESCE(mu.cost, 0) AS costSum,
               CASE WHEN mu.cost IS NULL THEN 0 ELSE 1 END AS costKnown,
               0
        FROM model_usages mu
        WHERE mu.team_id IN (${teamLiterals})
          AND mu.created_at >= CONVERT_TZ(${fromLiteral}, '+08:00', '+00:00')
          AND mu.created_at <  CONVERT_TZ(${toExclusiveLiteral}, '+08:00', '+00:00')
        UNION ALL
        -- agent 消息
        SELECT ch.team_id, m.created_at,
               0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
               1
        FROM messages m
        JOIN chat_channels ch ON ch.id = m.channel_id
        WHERE ch.team_id IN (${teamLiterals})
          AND m.sender_type = 'agent'
          AND m.created_at >= CONVERT_TZ(${fromLiteral}, '+08:00', '+00:00')
          AND m.created_at <  CONVERT_TZ(${toExclusiveLiteral}, '+08:00', '+00:00')
      ) x
      GROUP BY DATE(CONVERT_TZ(x.created_at, '+00:00', '+08:00')), x.team_id
      ORDER BY day ASC
      `,
    );

    // 周期/排队样本：一次扫窗口内「已完成任务」，供 avg/P90 使用（不再单独打一次表）。
    await this.loadCycleSamples(args);

    return rows.map((r) => ({
      day: typeof r.day === 'string' ? r.day : localDayOf(new Date(r.day)),
      teamId: r.teamId,
      tasksCreated: Number(r.tasksCreated ?? 0),
      tasksCompleted: Number(r.tasksCompleted ?? 0),
      tasksBlocked: Number(r.tasksBlocked ?? 0),
      tasksRejected: Number(r.tasksRejected ?? 0),
      artifacts: Number(r.artifacts ?? 0),
      artifactVersions: Number(r.artifactVersions ?? 0),
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      reasoningTokens: Number(r.reasoningTokens ?? 0),
      cacheReadTokens: Number(r.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(r.cacheWriteTokens ?? 0),
      costSum: Number(r.costSum ?? 0),
      costKnown: Number(r.costKnown ?? 0),
      agentMessages: Number(r.agentMessages ?? 0),
    }));
  }

  /**
   * 载入窗口内「已完成任务」的采购周期与排队等待样本（按团队分组）。
   *
   * 口径：
   * - 周期 = `completed_at - started_at`（小时）。只取两者都非 NULL 的行——
   *   缺 started_at 的任务算不出周期，**不补 0**（0 会拉低均值，让周期「看起来很好」）。
   * - 排队等待 = `started_at - created_at`（小时）。**近似口径**：`team_queues` 表已随
   *   并行执行退役，真实的「入队时刻」不再落库，只能用创建→开始作为上界近似。
   *   故响应里带 `queueWaitSource`，前端必须标注「近似」。
   */
  private async loadCycleSamples(args: {
    teamIds: string[];
    from: string;
    to: string;
  }): Promise<void> {
    this.cycleSamplesByTeam = new Map();
    this.queueSamplesByTeam = new Map();
    if (args.teamIds.length === 0) {
      return;
    }
    const tasks = await this.prisma.task.findMany({
      where: {
        teamId: { in: args.teamIds },
        completedAt: {
          gte: localDayStartUtc(args.from),
          lt: localDayStartUtc(addDays(args.to, 1)),
        },
        startedAt: { not: null },
      },
      select: {
        teamId: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    });
    for (const t of tasks) {
      const teamId = t.teamId ?? '';
      if (!teamId || !t.completedAt || !t.startedAt) {
        continue;
      }
      const cycle =
        (t.completedAt.getTime() - t.startedAt.getTime()) / 3_600_000;
      if (Number.isFinite(cycle) && cycle >= 0) {
        const list = this.cycleSamplesByTeam.get(teamId) ?? [];
        list.push(cycle);
        this.cycleSamplesByTeam.set(teamId, list);
      }
      const queue = (t.startedAt.getTime() - t.createdAt.getTime()) / 3_600_000;
      if (Number.isFinite(queue) && queue >= 0) {
        const list = this.queueSamplesByTeam.get(teamId) ?? [];
        list.push(queue);
        this.queueSamplesByTeam.set(teamId, list);
      }
    }
  }

  /* ==================================================================
   * 派生：日行 → 总量 / 桶
   * ================================================================== */

  /** 日聚合行 → StatsTotals（比率与成本派生字段在此唯一计算，避免各处各算一遍）。 */
  private deriveTotals(rows: DayAgg[]): StatsTotals {
    if (rows.length === 0) {
      return emptyTotals();
    }
    const t = emptyTotals();
    let costSum = 0;
    let costKnownDays = 0;
    let costKnownRows = 0;
    let costAllRows = 0;

    for (const r of rows) {
      t.tasksCreated += r.tasksCreated;
      t.tasksCompleted += r.tasksCompleted;
      t.tasksBlocked += r.tasksBlocked;
      t.tasksRejected += r.tasksRejected;
      t.artifacts += r.artifacts;
      t.artifactVersions += r.artifactVersions;
      t.inputTokens += r.inputTokens;
      t.outputTokens += r.outputTokens;
      t.reasoningTokens += r.reasoningTokens;
      t.cacheReadTokens += r.cacheReadTokens;
      t.cacheWriteTokens += r.cacheWriteTokens;
      t.agentMessages += r.agentMessages;
      costSum += r.costSum;
      costKnownRows += r.costKnown;
      // 每行 = 一天（聚合后的日行），costKnown 为当日有费用上报的行数；
      // 「日级未知」用「当天一行都没上报」判定，故这里以行数累计后再比。
      costAllRows += 1;
      if (r.costKnown > 0) {
        costKnownDays += 1;
      }
    }

    t.totalTokens =
      t.inputTokens +
      t.outputTokens +
      t.reasoningTokens +
      t.cacheReadTokens +
      t.cacheWriteTokens;
    // 未知 ≠ 0：整窗一行费用都没有 ⇒ null；否则给已知部分之和 + 覆盖率。
    t.cost = costKnownRows > 0 ? Math.round(costSum * 1e6) / 1e6 : null;
    t.costUnknownRatio = costAllRows > 0 ? 1 - costKnownDays / costAllRows : 0;
    t.cacheHitRate =
      t.inputTokens + t.cacheReadTokens > 0
        ? t.cacheReadTokens / (t.inputTokens + t.cacheReadTokens)
        : 0;
    t.completionRate =
      t.tasksCreated > 0 ? Math.min(1, t.tasksCompleted / t.tasksCreated) : 0;
    if (t.cost !== null) {
      t.costPerTask =
        t.tasksCompleted > 0 ? round6(t.cost / t.tasksCompleted) : null;
      t.costPerArtifact = t.artifacts > 0 ? round6(t.cost / t.artifacts) : null;
      t.costPerKToken =
        t.totalTokens > 0 ? round6(t.cost / (t.totalTokens / 1000)) : null;

      /**
       * ⚠️ 成本覆盖率不足时，**每单位成本一律返回 null**（而不是给一个基于部分数据的数）。
       *
       * 理由：`cost` 是「**已知部分**之和」，当 `costUnknownRatio > 0` 时它**小于**真实总额。
       * 用它去除产出物，会得到一个「看起来精确、实则系统性偏小」的数字 —— 而
       * 「每产出物成本」恰恰是运营者用来做跨团队横向比较的**唯一可比分母**：
       * 一个偏小的假精确值比「—」危险得多（它会让人误判某团队很省钱）。
       *
       * 边界说明：**全窗已知**（ratio === 0）→ 正常返回；**全窗未知**（cost === null）→ 早已为 null；
       * 只有「部分已知」这一档需要在这里拦。
       */
      if (t.costUnknownRatio > 0) {
        t.costPerTask = null;
        t.costPerArtifact = null;
        t.costPerKToken = null;
      }
    }
    return t;
  }

  /**
   * 日行 → 时间桶序列。
   *
   * 关键：桶集合由 `enumerateBucketKeys` **枚举窗口内全部桶**（含无数据的桶），
   * 再把日行归并进去。缺桶补零，保证趋势图横轴连续、且各桶之和 == 窗口总量。
   */
  private buildBuckets(rows: DayAgg[], window: StatsWindow): StatsBucket[] {
    const g = window.granularity as StatsGranularity;
    const keys = enumerateBucketKeys(window.from, window.to, g);
    const byKey = new Map<string, DayAgg[]>();
    for (const key of keys) {
      byKey.set(key, []);
    }
    for (const r of rows) {
      const key = bucketKeyOf(r.day, g);
      const list = byKey.get(key);
      if (list) {
        list.push(r);
      }
    }
    return keys.map((key) => ({
      key,
      label: bucketLabelOf(key, g),
      totals: this.deriveTotals(byKey.get(key) ?? []),
    }));
  }

  /* ==================================================================
   * 成员 / 产出物构成 / 状态快照 / 返工
   * ================================================================== */

  /** 成员产能表（按 totalTokens 降序）。 */
  private async loadMembers(
    teamId: string,
    window: StatsWindow,
  ): Promise<StatsMemberRow[]> {
    const from = localDayStartUtc(window.from);
    const to = localDayStartUtc(addDays(window.to, 1));

    const usage = await this.prisma.modelUsage.groupBy({
      by: ['teamMemberId'],
      where: { teamId, createdAt: { gte: from, lt: to } },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        cost: true,
      },
    });
    if (usage.length === 0) {
      return [];
    }

    const memberIds = usage.map((u) => u.teamMemberId);
    const members = await this.prisma.teamMember.findMany({
      where: { id: { in: memberIds } },
      select: {
        id: true,
        alias: true,
        agent: { select: { name: true } },
        role: { select: { name: true } },
      },
    });
    const nameById = new Map(
      members.map((m) => [
        m.id,
        {
          alias: m.alias ?? '',
          agentName: m.agent?.name ?? '',
          roleName: m.role?.name ?? null,
        },
      ]),
    );

    // 成员消息数（按 sender_instance_id 归属实例；群聊/私聊都算）。
    const messageRows = await this.prisma.message.groupBy({
      by: ['senderInstanceId'],
      where: {
        senderType: 'agent',
        senderInstanceId: { in: memberIds },
        createdAt: { gte: from, lt: to },
      },
      _count: { _all: true },
    });
    const messagesById = new Map(
      messageRows.map((r) => [r.senderInstanceId ?? '', r._count._all]),
    );

    // 成员参与任务数：该成员的会话覆盖的去重任务（会话即团队成员的执行上下文）。
    const sessionRows = await this.prisma.session.findMany({
      where: { teamId, teamMemberId: { in: memberIds }, taskId: { not: null } },
      select: { teamMemberId: true, taskId: true },
    });
    const tasksById = new Map<string, Set<string>>();
    for (const s of sessionRows) {
      if (!s.teamMemberId || !s.taskId) {
        continue;
      }
      const set = tasksById.get(s.teamMemberId) ?? new Set<string>();
      set.add(s.taskId);
      tasksById.set(s.teamMemberId, set);
    }

    // 产出物归属：artifact_versions.author_agent_id → Agent，再经 team_members 反查实例。
    const agentToMembers = new Map<string, string[]>();
    const aliasRows = await this.prisma.teamMember.findMany({
      where: { teamId },
      select: { id: true, agentId: true },
    });
    for (const m of aliasRows) {
      const list = agentToMembers.get(m.agentId) ?? [];
      list.push(m.id);
      agentToMembers.set(m.agentId, list);
    }
    const versionRows = await this.prisma.artifactVersion.findMany({
      where: {
        authorAgentId: { not: null },
        createdAt: { gte: from, lt: to },
        artifact: { task: { teamId } },
      },
      select: { artifactId: true, authorAgentId: true },
    });
    const artifactsById = new Map<string, number>();
    for (const v of versionRows) {
      if (!v.authorAgentId) {
        continue;
      }
      const owners = agentToMembers.get(v.authorAgentId) ?? [];
      if (owners.length === 0) {
        continue;
      }
      // 同一 Agent 多实例时无法精确归属 ⇒ 均摊不会更准（会造假精度），故记给**首个**实例并
      // 在响应里保持「成员产出物之和可能小于团队总数」的诚实口径，由前端脚注说明。
      const owner = owners[0];
      artifactsById.set(owner, (artifactsById.get(owner) ?? 0) + 1);
    }

    const rows: StatsMemberRow[] = usage.map((u) => {
      const meta = nameById.get(u.teamMemberId);
      const input = u._sum.inputTokens ?? 0;
      const output = u._sum.outputTokens ?? 0;
      const cacheRead = u._sum.cacheReadTokens ?? 0;
      const cacheWrite = u._sum.cacheWriteTokens ?? 0;
      return {
        teamMemberId: u.teamMemberId,
        memberName: meta?.alias || meta?.agentName || u.teamMemberId,
        agentName: meta?.agentName ?? '',
        roleName: meta?.roleName ?? null,
        tasks: tasksById.get(u.teamMemberId)?.size ?? 0,
        artifacts: artifactsById.get(u.teamMemberId) ?? 0,
        totalTokens: input + output + cacheRead + cacheWrite,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        cost:
          u._sum.cost !== null && u._sum.cost !== undefined
            ? round6(u._sum.cost)
            : null,
        messages: messagesById.get(u.teamMemberId) ?? 0,
      };
    });
    rows.sort((a, b) => b.totalTokens - a.totalTokens);
    return rows;
  }

  /** 产出物类型构成（三态全覆盖，缺类型补 0）。 */
  private async loadArtifactMix(
    teamId: string,
    window: StatsWindow,
  ): Promise<StatsArtifactTypeSlice[]> {
    const grouped = await this.prisma.artifact.groupBy({
      by: ['type'],
      where: {
        task: { teamId },
        createdAt: {
          gte: localDayStartUtc(window.from),
          lt: localDayStartUtc(addDays(window.to, 1)),
        },
      },
      _count: { _all: true },
    });
    const countByType = new Map(grouped.map((g) => [g.type, g._count._all]));
    const total = [...countByType.values()].reduce((a, b) => a + b, 0);
    return ARTIFACT_TYPES.map((type) => {
      const count = countByType.get(type) ?? 0;
      return { type, count, share: total > 0 ? count / total : 0 };
    });
  }

  /** 任务状态快照（当前盘子，非窗口口径）。 */
  private async loadStatusMix(teamId: string): Promise<Record<string, number>> {
    const grouped = await this.prisma.task.groupBy({
      by: ['status'],
      where: { teamId },
      _count: { _all: true },
    });
    const mix: Record<string, number> = {};
    for (const status of Object.values(TASK_STATUS)) {
      mix[status] = 0;
    }
    for (const g of grouped) {
      mix[g.status] = g._count._all;
    }
    return mix;
  }

  /**
   * 窗口内有产出的成员数（去重 `model_usages.team_member_id`）。
   *
   * 口径说明：以「有模型调用」为「活跃」的判据（而不是「发过消息」）——
   * 统计看板关心的是**产能**（谁真的在干活），消息数另有 `agentMessages` 维度，
   * 两者不该混成一个「活跃」定义。无用量行的团队返回 0（不是 null：0 个活跃成员是事实）。
   */
  private async countActiveMembers(
    teamIds: string[],
    window: StatsWindow,
  ): Promise<number> {
    if (teamIds.length === 0) {
      return 0;
    }
    const rows = await this.prisma.modelUsage.groupBy({
      by: ['teamMemberId'],
      where: {
        teamId: { in: teamIds },
        createdAt: {
          gte: localDayStartUtc(window.from),
          lt: localDayStartUtc(addDays(window.to, 1)),
        },
      },
      _count: { _all: true },
    });
    return rows.length;
  }

  /**
   * 返工数：窗口内「被驳回后重新进入执行」的任务数（去重任务）。
   *
   * 判定：`task_events` 中 `to_status='in_progress'` 且该任务是先从 in_progress 出过
   * 的（即 reject 回退）——用 `from_status='pending_review'` 精确锁定驳回回退，
   * 避免把首次 start（from=pending）误算成返工。
   */
  private async countRework(
    window: StatsWindow,
    teamIds: string[],
  ): Promise<number> {
    if (teamIds.length === 0) {
      return 0;
    }
    const rows = await this.prisma.taskEvent.findMany({
      where: {
        createdAt: {
          gte: localDayStartUtc(window.from),
          lt: localDayStartUtc(addDays(window.to, 1)),
        },
        // 判定统一走 `event_type='reject'`（与 loadDailyRows 的 SQL 同一口径）：
        // 驳回的落点是 to_status=in_progress，而「首次开始」的落点**也是** in_progress，
        // 按状态判定会把每次正常开始都算成返工。event_type 是唯一的权威区分点。
        eventType: 'reject',
        task: { teamId: { in: teamIds } },
      },
      select: { taskId: true },
    });
    return new Set(rows.map((r) => r.taskId)).size;
  }

  /* ==================================================================
   * 查询参数 / 鉴权 / 缓存
   * ================================================================== */

  /** 解析并校验窗口（超上限直接 400，不静默截断）。 */
  private resolveQueryWindow(query: StatsQuery): StatsWindow {
    const days = query.days ?? STATS_DEFAULT_WINDOW_DAYS;
    const granularity = query.granularity ?? STATS_DEFAULT_GRANULARITY;
    if (!Number.isInteger(days) || days < 1 || days > STATS_MAX_WINDOW_DAYS) {
      throw new BadRequestException({
        code: STATS_ERRORS.QUERY_INVALID,
        message: `days 须为 1..${STATS_MAX_WINDOW_DAYS} 的整数（超上限不静默截断）`,
      });
    }
    if (query.to && !/^\d{4}-\d{2}-\d{2}$/.test(query.to)) {
      throw new BadRequestException({
        code: STATS_ERRORS.QUERY_INVALID,
        message: 'to 须为 YYYY-MM-DD 形状的本地日历日',
      });
    }
    const { from, to } = resolveWindow(query.to, days);
    // `to` 不能落在未来：未来窗口必然全空，返回空数字会误导「这几天没产出」。
    const today = localDayOf(new Date());
    if (diffDays(today, to) > 0) {
      throw new BadRequestException({
        code: STATS_ERRORS.QUERY_INVALID,
        message: 'to 不能是未来日期',
      });
    }
    return {
      from,
      to,
      days,
      granularity,
      timezone: STATS_TIMEZONE,
      maxDays: STATS_MAX_WINDOW_DAYS,
    };
  }

  /** 解析 `teamIds` 逗号串（去空、去重、保序）。 */
  private parseTeamIds(raw?: string): string[] {
    if (!raw) {
      return [];
    }
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return [...new Set(ids)];
  }

  /** 团队成员可见性判定（与 usage.service 的 assertTeamReadable 同一口径）。 */
  private async assertTeamReadable(
    teamId: string,
    viewer?: StatsViewer,
  ): Promise<void> {
    if (viewer?.id) {
      const membership = await this.prisma.teamUserMember.findUnique({
        where: { teamId_userId: { teamId, userId: viewer.id } },
        select: { id: true },
      });
      if (membership) {
        return;
      }
      if (await isPlatformAdminByUserId(this.prisma, viewer.id)) {
        return;
      }
    }
    throw new ForbiddenException({
      code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
      message: '您不是该团队成员',
    });
  }

  private readCache<T>(key: string): T | null {
    const hit = this.cache.get(key);
    if (!hit) {
      return null;
    }
    if (Date.now() - hit.at > STATS_CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    return hit.value as T;
  }

  private writeCache(key: string, value: unknown): void {
    // 简单容量护栏：统计缓存不该无限增长（键含日期/粒度/用户，本身有限，
    // 但长跑进程里仍会累积）。超过 200 条时清空最旧的一半。
    if (this.cache.size > 200) {
      const entries = [...this.cache.entries()].sort(
        (a, b) => a[1].at - b[1].at,
      );
      for (let i = 0; i < entries.length / 2; i++) {
        this.cache.delete(entries[i][0]);
      }
    }
    this.cache.set(key, { at: Date.now(), value });
  }

  /** 均值（空数组 ⇒ null，**不返回 0**——0 会把「没有样本」显示成「周期极短」）。 */
  private avgOf(samples: number[] | undefined): number | null {
    if (!samples || samples.length === 0) {
      return null;
    }
    const sum = samples.reduce((a, b) => a + b, 0);
    return round2(sum / samples.length);
  }

  /** P90（**最近秩法**：升序取 ceil(0.9*n)-1；样本不足时取最大值，保守不造假）。 */
  private p90Of(samples: number[] | undefined): number | null {
    if (!samples || samples.length === 0) {
      return null;
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil(0.9 * sorted.length) - 1);
    return round2(sorted[Math.min(idx, sorted.length - 1)]);
  }
}

/** 排队等待口径来源（回传给调用方标注「近似」）。 */
export const QUEUE_WAIT_SOURCE = 'created_to_started';

/**
 * SQL 单引号字面量转义（仅用于**非用户可控**的内部标识内联，见 loadDailyRows 注释）。
 * MySQL 标准做法：单引号 ×2；同时把反斜杠也转义以覆盖 `NO_BACKSLASH_ESCAPES` 关闭的场景。
 */
function escapeSqlLiteral(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
