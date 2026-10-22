import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SENDER_TYPE } from '../common/constants/event.constants';
import { BUILTIN_AGENT_ROLE_BY_KEY } from '../common/constants/agent-role.constants';
import { MESSAGE_RECEIPT_KINDS } from '../chat/message-receipt.constants';
import { PrismaService } from '../prisma/prisma.service';
import {
  COORDINATION_METRICS_DEFAULT_WINDOW_HOURS,
  COORDINATION_METRICS_ERRORS,
  COORDINATION_METRICS_MAX_WINDOW_HOURS,
} from './coordination-metrics.constants';
import { QueryCoordinationMetricsDto } from './dto/query-coordination-metrics.dto';

/**
 * 「项目经理」岗位的 role key —— **按岗位**识别 PM，不按写死的 agent id。
 *
 * 单一事实来源 = `common/constants/agent-role.constants.ts` 的内置岗位清单
 * （BUILTIN_AGENT_ROLES 的 key 字段）。写死 `a_project_manager` 会在「运营者把 PM
 * 成员换绑到另一个 Agent」时静默失配（指标会掉到 0 而不是报错）；按 role key 找，
 * 则永远认的是**岗位**。
 */
const PM_ROLE_KEY = BUILTIN_AGENT_ROLE_BY_KEY.project_manager.key;

/** 无法归属到任何岗位的 agent 消息桶 key（成员未绑岗位 / 发送方缺失）。 */
const UNASSIGNED_ROLE_KEY = 'unassigned';

/** 群聊频道类型（`chat_channels.type`；另一类型是 private）。 */
const CHANNEL_TYPE_TEAM_GROUP = 'team_group';
const CHANNEL_TYPE_PRIVATE = 'private';

/** 协调度指标窗口（已解析为绝对时间 + 口径描述）。 */
export interface CoordinationMetricsWindow {
  /** 窗口左端点（ISO-8601）。 */
  from: string;
  /** 窗口右端点（ISO-8601）。 */
  to: string;
  /** 窗口长度（小时）。 */
  hours: number;
  /** 本服务接受的最大窗口长度（小时）——回显给调用方，便于前端展示上限。 */
  maxHours: number;
}

/** 单岗位在本窗口内的协调画像。 */
export interface CoordinationRoleBreakdown {
  /** 岗位机器键（如 project_manager）；未归属桶为 'unassigned'。 */
  roleKey: string;
  /** 岗位展示名（如 项目经理）。 */
  roleName: string;
  /** 该岗位在本团队使用的执行 Agent id 集合。 */
  agentIds: string[];
  /** 该岗位在本团队的成员数。 */
  memberCount: number;
  /** 该岗位成员在窗口内发出的 agent 消息数。 */
  messages: number;
  /** 该岗位消息占全团队 agent 消息的比例（0..1）。 */
  messageShare: number;
  /** 该岗位在窗口内产出（author 过 artifact_versions）的产出物数（去重 artifact）。 */
  artifacts: number;
}

/** 单条指标（自描述：名字 / 值 / 单位 / 口径 / 覆盖窗口）。 */
export interface CoordinationMetric {
  /** 指标键（机器可读，dashboard 用）。 */
  key: string;
  /** 指标中文名。 */
  name: string;
  /** 指标口径说明（为什么这么算）。 */
  description: string;
  /** 指标主值（标量；复合口径的分解在 detail 里）。 */
  value: number;
  /** 值单位：count（个数）/ ratio（比例 0..1）。 */
  unit: 'count' | 'ratio';
  /** 目标值（计划/纪律给出的硬目标；无则 null）。 */
  target: { operator: string; value: number } | null;
  /** 是否达成目标（无目标则 null）。 */
  ok: boolean | null;
  /** 人读备注（口径提醒 / 已知偏差）。 */
  note: string;
  /** 分解明细（分子分母、原始计数、信号强度…）。 */
  detail: Record<string, unknown>;
  /** 该指标覆盖的窗口（与顶层 window 一致，便于单指标复用）。 */
  window: { from: string; to: string };
}

/** `GET /teams/:teamId/coordination-metrics` 响应契约。 */
export interface CoordinationMetricsResponse {
  teamId: string;
  teamName: string;
  /** 响应生成时刻（ISO-8601）。 */
  generatedAt: string;
  /** 统计窗口。 */
  window: CoordinationMetricsWindow;
  /** 窗口内全团队 agent 消息总数（分母）。 */
  totalAgentMessages: number;
  /** 岗位维度分解（按岗位序排列；末尾可能有 unassigned 桶）。 */
  roles: CoordinationRoleBreakdown[];
  /** 指标清单（每条自带名字/值/窗口）。 */
  metrics: CoordinationMetric[];
}

/** 已解析的窗口（内部用，携带 Date 供查询使用）。 */
interface ResolvedWindow {
  from: Date;
  to: Date;
  hours: number;
}

/** 岗位绑定（key / 展示名 / 岗位序）。 */
interface RoleBinding {
  key: string;
  name: string;
  sortOrder: number;
}

/** 岗位桶（本团队内的成员与执行 Agent）。 */
interface RoleBucket extends RoleBinding {
  memberIds: string[];
  agentIds: string[];
}

/** 成员 → 岗位索引（岗位维度 + Agent 归岗两个方向）。 */
interface RoleIndex {
  byRoleKey: Map<string, RoleBucket>;
  agentRoleOf: Map<string, RoleBinding>;
}

/**
 * 团队协调度指标服务（批次 E · pm-coordination-hardening「协调度指标」）。
 *
 * 【定位】**只读**观测面：把「PM 只协调不执行」这条纪律从 agent 自写的记忆
 * （散落 4 团队 6 处）变成可测量的数字。零写入、零状态、零定时任务。
 *
 * 【四条指标】
 * 1. PM 产出物数（目标恒 0）——「PM 亲自交付」的探测器；
 * 2. PM 消息占比 + 岗位分解——「谁在说话」（线上基线 68%）；
 * 3. 派发数 vs 亲做数——「PM 是在派活还是在自己答」（派发 = message_receipts 的
 *    dispatch 行；亲做 = PM 消息 − 派发通告）；
 * 4. 群聊 + 私聊双报——「同一结论既发群又发私」（PM 的协调输出有多少团队看不见）。
 *
 * 【归属口径（重要，写下来免得下一个人重算错）】
 * - 消息按 **sender_id（执行 Agent）** 归岗，**不**按 sender_instance_id：
 *   私聊回流时 sender_instance_id 可能是「收件实例」，按它归岗会把别人写进 PM 的
 *   私聊频道的话算成 PM 说的（线上实测：3 条 tester 的回信落在 PM 私聊频道，
 *   按实例归岗 PM 会虚高到 109，按 Agent 归岗才是 106 = 计划里的基线）。
 * - 一个 Agent 被多个岗位成员复用时（线上：a_developer 同时被 developer/plan
 *   两个岗位的成员使用），归到**岗位序最靠前**的那一个（sortOrder，再按 key 兜底），
 *   保证「岗位分解之和 == 全团队消息数」，不重复计数。
 * - 产出物按 `artifact_versions.author_agent_id` 归岗（产出物的作者记在版本行上，
 *   `artifacts` 本体没有作者列）；同一产出物被同岗位多版本命中 ⇒ 只算 1 个。
 *
 * 【有界性】
 * - 窗口硬上限 720h（见 constants 注释）；超限 400，绝不静默截断。
 * - 全部聚合在 DB 侧完成（`groupBy` / `count`），node 侧只拿聚合行：
 *   消息聚合行数 = 发送方数 × 频道数（小），产出物聚合行数 = 产出物数（小），
 *   回执行数 = 不同派发消息数（小）。**不把原始消息行拉进内存**。
 * - 唯一的逐行扫描是「同文重合」判定（GROUP BY 归一化文本），限定在
 *   「窗口内 + PM 发送方 + 本团队频道」三个条件下，DB 侧出单个计数。
 */
@Injectable()
export class CoordinationMetricsService {
  private readonly logger = new Logger(CoordinationMetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 团队协调度指标（一次算完四条）。
   *
   * @param teamId 团队 id
   * @param query 窗口参数（windowHours / to）
   */
  async getCoordinationMetrics(
    teamId: string,
    query: QueryCoordinationMetricsDto = {},
  ): Promise<CoordinationMetricsResponse> {
    const win = this.resolveWindow(query);

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true },
    });
    if (!team) {
      throw new NotFoundException({
        code: COORDINATION_METRICS_ERRORS.TEAM_NOT_FOUND,
        message: `team ${teamId} not found`,
      });
    }

    // ── ① 团队成员 → 岗位 → 执行 Agent ────────────────────────────────
    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      select: {
        id: true,
        agentId: true,
        role: { select: { key: true, name: true, sortOrder: true } },
      },
      orderBy: { id: 'asc' },
    });

    const roles = this.buildRoleIndex(members);
    const agentRole = roles.agentRoleOf; // agentId → {key,name,sortOrder}
    const pmAgentIds = [...agentRole.entries()]
      .filter(([, role]) => role.key === PM_ROLE_KEY)
      .map(([agentId]) => agentId);
    const pmMemberIds = members
      .filter((m) => m.role?.key === PM_ROLE_KEY)
      .map((m) => m.id);

    // ── ② 团队频道（软删频道不计入：软删后频道不可访问，其消息不在可见面上）──
    const channels = await this.prisma.chatChannel.findMany({
      where: { teamId, deletedAt: null },
      select: { id: true, type: true },
    });
    const channelIds = channels.map((c) => c.id);
    const channelTypeById = new Map(channels.map((c) => [c.id, c.type]));

    // ── ③ 窗口内 agent 消息：按 (发送方, 频道) 聚合 ───────────────────
    const messageRows = channelIds.length
      ? await this.prisma.message.groupBy({
          by: ['senderId', 'channelId'],
          where: {
            channelId: { in: channelIds },
            senderType: SENDER_TYPE.agent,
            createdAt: { gte: win.from, lte: win.to },
          },
          _count: { _all: true },
        })
      : [];

    /** 发送方 Agent → 消息数。 */
    const messagesByAgent = new Map<string, number>();
    /** 发送方 Agent → (频道 id → 消息数)。 */
    const messagesByAgentChannel = new Map<string, Map<string, number>>();
    let totalAgentMessages = 0;
    /** agent 消息缺 sender_id 的条数（理论上为 0；发生时归 unassigned 桶，不丢计数）。 */
    let senderlessMessages = 0;
    for (const row of messageRows) {
      const senderId = row.senderId;
      const count = row._count._all;
      totalAgentMessages += count;
      if (!senderId) {
        senderlessMessages += count;
        continue;
      }
      messagesByAgent.set(
        senderId,
        (messagesByAgent.get(senderId) ?? 0) + count,
      );
      const byChannel =
        messagesByAgentChannel.get(senderId) ?? new Map<string, number>();
      byChannel.set(row.channelId, (byChannel.get(row.channelId) ?? 0) + count);
      messagesByAgentChannel.set(senderId, byChannel);
    }

    // ── ④ 产出物：按 (产出物, 作者 Agent) 聚合 ─────────────────────────
    const artifactRows = await this.prisma.artifactVersion.groupBy({
      by: ['artifactId', 'authorAgentId'],
      where: {
        artifact: { task: { teamId } },
        createdAt: { gte: win.from, lte: win.to },
      },
    });
    /** 岗位 → 其产出的产出物 id 集合（去重）。 */
    const artifactsByRole = new Map<string, Set<string>>();
    for (const row of artifactRows) {
      const roleKey = row.authorAgentId
        ? (agentRole.get(row.authorAgentId)?.key ?? UNASSIGNED_ROLE_KEY)
        : UNASSIGNED_ROLE_KEY;
      const set = artifactsByRole.get(roleKey) ?? new Set<string>();
      set.add(row.artifactId);
      artifactsByRole.set(roleKey, set);
    }
    const totalArtifacts = await this.prisma.artifact.count({
      where: { task: { teamId } },
    });

    // ── ⑤ PM 派发：message_receipts 的 dispatch 行 ───────────────────
    const dispatchRows = pmMemberIds.length
      ? await this.prisma.messageReceipt.groupBy({
          by: ['messageId'],
          where: {
            teamId,
            kind: MESSAGE_RECEIPT_KINDS.dispatch,
            fromInstanceId: { in: pmMemberIds },
            createdAt: { gte: win.from, lte: win.to },
          },
          _count: { _all: true },
        })
      : [];
    /** 定向派发次数（一次 fan-out 多目标 = 多行回执 = 多次派发）。 */
    const dispatches = dispatchRows.reduce(
      (sum, row) => sum + row._count._all,
      0,
    );
    /** 派发通告消息数（同一 messageId 可能对应多目标 ⇒ 按 messageId 去重）。 */
    const dispatchMessages = dispatchRows.length;

    // ── ⑥ 岗位分解 ────────────────────────────────────────────────────
    const roleBreakdowns = this.buildRoleBreakdowns({
      members,
      roles,
      messagesByAgent,
      artifactsByRole,
      totalAgentMessages,
      senderlessMessages,
    });

    // ── ⑦ PM 各口径数字 ──────────────────────────────────────────────
    const pmMessages = sumOf(messagesByAgent, pmAgentIds);
    const pmGroupMessages = this.countByChannelType(
      messagesByAgentChannel,
      pmAgentIds,
      channelTypeById,
      CHANNEL_TYPE_TEAM_GROUP,
    );
    const pmPrivateMessages = this.countByChannelType(
      messagesByAgentChannel,
      pmAgentIds,
      channelTypeById,
      CHANNEL_TYPE_PRIVATE,
    );
    // 「亲做」= PM 自己发的消息 − 派发通告（派发通告本身就是「派活」，不是亲做）。
    const pmSelfConclusions = Math.max(0, pmMessages - dispatchMessages);
    const pmArtifacts = artifactsByRole.get(PM_ROLE_KEY)?.size ?? 0;
    const pmShare = ratio(pmMessages, totalAgentMessages);

    const windowEcho = {
      from: win.from.toISOString(),
      to: win.to.toISOString(),
    };

    // ── ⑧ 指标清单 ────────────────────────────────────────────────────
    const metrics: CoordinationMetric[] = [
      {
        key: 'pm_artifact_count',
        name: 'PM 产出物数（交付物）',
        description:
          '窗口内由项目经理岗位产出（artifact_versions.author_agent_id 命中 PM 岗位 Agent）的去重产出物数。' +
          'PM 只做传话人/流程协调，不亲自产出交付物 ⇒ 目标恒 0；>0 即越界。',
        value: pmArtifacts,
        unit: 'count',
        target: { operator: '=', value: 0 },
        ok: pmArtifacts === 0,
        note: '本地基线：0（tm_0000000001 的 7 个产出物作者均为 NULL / 非 PM 岗位）。',
        detail: {
          pmArtifacts,
          pmArtifactVersions: await this.countPmArtifactVersions(
            pmAgentIds,
            teamId,
            win,
          ),
          teamArtifacts: totalArtifacts,
          unassignedArtifacts:
            artifactsByRole.get(UNASSIGNED_ROLE_KEY)?.size ?? 0,
        },
        window: windowEcho,
      },
      {
        key: 'pm_message_share',
        name: 'PM 消息占比',
        description:
          '项目经理岗位在窗口内发出的 agent 消息数 ÷ 全团队 agent 消息数。' +
          '占比越高说明「谁在说话」越集中在一个岗位——健康团队里 PM 应是少数派。',
        value: pmShare,
        unit: 'ratio',
        target: null,
        ok: null,
        note:
          '本地基线：106/154 ≈ 68%（计划里记的全库口径 106/155 ≈ 68%；' +
          '差 1 条是落在另一个团队群聊频道的消息，不属本团队）。',
        detail: {
          pmMessages,
          totalAgentMessages,
          byRole: roleBreakdowns.map((r) => ({
            roleKey: r.roleKey,
            roleName: r.roleName,
            messages: r.messages,
            messageShare: r.messageShare,
          })),
        },
        window: windowEcho,
      },
      {
        key: 'pm_dispatch_vs_self_execution',
        name: 'PM 派发 vs 亲做',
        description:
          'PM 发出的定向派发次数（message_receipts 的 dispatch 行 = notify_agent 的账本）' +
          ' 对比 PM 亲自动手写下的结论数（PM 消息数 − 派发通告数）。' +
          '后者高 ⇒ PM 在自己答题而不是派活。',
        value: pmSelfConclusions,
        unit: 'count',
        target: null,
        ok: null,
        note: '本地基线：派发 12 次 / 亲做 94 条（PM 消息 106 − 派发通告 12）。',
        detail: {
          dispatches,
          dispatchMessages,
          pmMessages,
          pmGroupMessages,
          pmPrivateMessages,
          selfConclusions: pmSelfConclusions,
          dispatchShare: ratio(dispatches, pmMessages),
          selfConclusionShare: ratio(pmSelfConclusions, pmMessages),
        },
        window: windowEcho,
      },
      {
        key: 'pm_group_private_double_report',
        name: 'PM 群聊 + 私聊双报',
        description:
          'PM 在群聊与私聊两个面上发同一结论的比例。**主指标是粗口径**（私聊条数占比 + ' +
          '群私条数比）；**附精确同文重合**（归一化空白后逐字相同、且同时出现在群聊与私聊频道）' +
          '作为下界——线上 PM 的私聊多为「已在群聊回复：…」的转述，逐字相同必然测不出，' +
          '所以粗口径才是可用的信号。',
        value: ratio(pmPrivateMessages, pmGroupMessages + pmPrivateMessages),
        unit: 'ratio',
        target: null,
        ok: null,
        note: '本地基线：群聊 67 / 私聊 39 ⇒ 私聊占比 36.8%；逐字同文重合 0（转述体测不出）。',
        detail: {
          groupMessages: pmGroupMessages,
          privateMessages: pmPrivateMessages,
          privateShare: ratio(
            pmPrivateMessages,
            pmGroupMessages + pmPrivateMessages,
          ),
          balanceRatio:
            pmGroupMessages === 0 && pmPrivateMessages === 0
              ? 0
              : ratio(
                  Math.min(pmGroupMessages, pmPrivateMessages),
                  Math.max(pmGroupMessages, pmPrivateMessages),
                ),
          exactTextOverlapMessages: await this.countExactTextOverlap({
            agentIds: pmAgentIds,
            channelIds,
            win,
          }),
          signal: 'crude（粗口径为主）+ exact-text-overlap（精确同文为下界）',
        },
        window: windowEcho,
      },
    ];

    return {
      teamId: team.id,
      teamName: team.name,
      generatedAt: new Date().toISOString(),
      window: {
        from: win.from.toISOString(),
        to: win.to.toISOString(),
        hours: win.hours,
        maxHours: COORDINATION_METRICS_MAX_WINDOW_HOURS,
      },
      totalAgentMessages,
      roles: roleBreakdowns,
      metrics,
    };
  }

  /**
   * 窗口解析 + 校验（**双层防御**：DTO 层 class-validator 已挡一层，这里再挡一层，
   * 因为 service 也可能被内部调用/单测直接调用）。
   *
   * 越界一律 400，**不静默截断**——静默截断会让「我查了 30 天」与实际口径不一致，
   * 指标一旦不可信就没人看了。
   */
  private resolveWindow(query: QueryCoordinationMetricsDto): ResolvedWindow {
    const rawHours = query?.windowHours;
    const hours =
      rawHours === undefined || rawHours === null
        ? COORDINATION_METRICS_DEFAULT_WINDOW_HOURS
        : Number(rawHours);
    if (
      !Number.isInteger(hours) ||
      hours < 1 ||
      hours > COORDINATION_METRICS_MAX_WINDOW_HOURS
    ) {
      throw new BadRequestException({
        code: COORDINATION_METRICS_ERRORS.WINDOW_INVALID,
        message: `windowHours 必须是 1..${COORDINATION_METRICS_MAX_WINDOW_HOURS} 的整数（收到 ${String(rawHours)}）`,
      });
    }

    let to: Date;
    if (query?.to) {
      to = new Date(query.to);
      if (Number.isNaN(to.getTime())) {
        throw new BadRequestException({
          code: COORDINATION_METRICS_ERRORS.WINDOW_INVALID,
          message: `to 不是可解析的 ISO-8601 时间（收到 ${query.to}）`,
        });
      }
    } else {
      to = new Date();
    }

    return { from: new Date(to.getTime() - hours * 3_600_000), to, hours };
  }

  /**
   * 成员 → 岗位索引：
   * - `byRoleKey`：岗位 → 成员/Agent（岗位维度口径用）；
   * - `agentRoleOf`：Agent → 岗位（消息/产出物归岗用；一个 Agent 被多岗位复用时，
   *   归岗位序最靠前者，保证分解之和 == 总量，不重复计数）。
   */
  private buildRoleIndex(members: RoleMemberRow[]): RoleIndex {
    const byRoleKey = new Map<string, RoleBucket>();
    const candidates = new Map<string, RoleBinding[]>();

    for (const member of members) {
      if (!member.role) continue;
      const role = member.role;
      const bucket = byRoleKey.get(role.key) ?? {
        key: role.key,
        name: role.name,
        sortOrder: role.sortOrder,
        memberIds: [],
        agentIds: [],
      };
      bucket.memberIds.push(member.id);
      if (!bucket.agentIds.includes(member.agentId)) {
        bucket.agentIds.push(member.agentId);
      }
      byRoleKey.set(role.key, bucket);

      const list = candidates.get(member.agentId) ?? [];
      list.push({ key: role.key, name: role.name, sortOrder: role.sortOrder });
      candidates.set(member.agentId, list);
    }

    const agentRoleOf = new Map<string, RoleBinding>();
    for (const [agentId, list] of candidates) {
      const sorted = [...list].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key),
      );
      agentRoleOf.set(agentId, sorted[0]);
    }

    return { byRoleKey, agentRoleOf };
  }

  /** 岗位维度分解（消息数按 Agent 归岗求和；产出物数按岗位去重 artifact）。 */
  private buildRoleBreakdowns(args: {
    members: RoleMemberRow[];
    roles: RoleIndex;
    messagesByAgent: Map<string, number>;
    artifactsByRole: Map<string, Set<string>>;
    totalAgentMessages: number;
    senderlessMessages: number;
  }): CoordinationRoleBreakdown[] {
    const { roles, messagesByAgent, artifactsByRole, totalAgentMessages } =
      args;
    const out: CoordinationRoleBreakdown[] = [];

    for (const role of roles.byRoleKey.values()) {
      let messages = 0;
      for (const [agentId, roleKey] of roles.agentRoleOf.entries()) {
        if (roleKey.key !== role.key) continue;
        messages += messagesByAgent.get(agentId) ?? 0;
      }
      out.push({
        roleKey: role.key,
        roleName: role.name,
        agentIds: [...role.agentIds],
        memberCount: role.memberIds.length,
        messages,
        messageShare: ratio(messages, totalAgentMessages),
        artifacts: artifactsByRole.get(role.key)?.size ?? 0,
      });
    }

    // 未归属桶：有消息但归不到岗位的 Agent（成员未绑岗位）+ 缺发送方的消息 + 作者缺失的产出物。
    let unassignedMessages = args.senderlessMessages;
    for (const [agentId, count] of messagesByAgent.entries()) {
      if (!roles.agentRoleOf.has(agentId)) {
        unassignedMessages += count;
      }
    }
    if (unassignedMessages > 0) {
      out.push({
        roleKey: UNASSIGNED_ROLE_KEY,
        roleName: '未绑定岗位',
        agentIds: [...messagesByAgent.keys()].filter(
          (agentId) => !roles.agentRoleOf.has(agentId),
        ),
        memberCount: 0,
        messages: unassignedMessages,
        messageShare: ratio(unassignedMessages, totalAgentMessages),
        artifacts: artifactsByRole.get(UNASSIGNED_ROLE_KEY)?.size ?? 0,
      });
    }

    out.sort(
      (a, b) =>
        (roles.byRoleKey.get(a.roleKey)?.sortOrder ?? 999) -
          (roles.byRoleKey.get(b.roleKey)?.sortOrder ?? 999) ||
        a.roleKey.localeCompare(b.roleKey),
    );
    return out;
  }

  /** 若干 Agent 在指定频道类型上的消息数合计。 */
  private countByChannelType(
    messagesByAgentChannel: Map<string, Map<string, number>>,
    agentIds: string[],
    channelTypeById: Map<string, string>,
    channelType: string,
  ): number {
    let sum = 0;
    for (const agentId of agentIds) {
      const byChannel = messagesByAgentChannel.get(agentId);
      if (!byChannel) continue;
      for (const [channelId, count] of byChannel.entries()) {
        if (channelTypeById.get(channelId) === channelType) sum += count;
      }
    }
    return sum;
  }

  /** PM 岗位产出的**版本**数（明细用；主指标是去重的产出物数）。 */
  private async countPmArtifactVersions(
    pmAgentIds: string[],
    teamId: string,
    win: ResolvedWindow,
  ): Promise<number> {
    if (!pmAgentIds.length) return 0;
    return this.prisma.artifactVersion.count({
      where: {
        authorAgentId: { in: pmAgentIds },
        createdAt: { gte: win.from, lte: win.to },
        artifact: { task: { teamId } },
      },
    });
  }

  /**
   * 精确「同文双报」计数（DB 侧 GROUP BY 归一化文本，只回一个计数）。
   *
   * 归一化口径：折叠连续空白 + 去首尾空白（`REGEXP_REPLACE(text,'[[:space:]]+',' ')`）。
   * 命中条件：同一条归一化文本**同时**出现在 ≥2 种频道类型（群聊 + 私聊）。
   *
   * 边界与代价（必须知道，否则会误读）：
   * - 这是**下界**：线上 PM 的私聊多为「已在群聊回复：…」的转述 ⇒ 逐字不同 ⇒ 必然测不出。
   * - 真正的「同一结论」需要语义比对，平台没有这种记账能力（无「群帖→私帖」引用关系），
   *   本批不新建表/不改 schema（硬约束），故精确口径只能到「逐字相同」。
   * - 失败时降级为 null + WARN，不让整条指标 500（观测面不该因为补充信号挂掉）。
   */
  private async countExactTextOverlap(args: {
    agentIds: string[];
    channelIds: string[];
    win: ResolvedWindow;
  }): Promise<number | null> {
    const { agentIds, channelIds, win } = args;
    if (!agentIds.length || !channelIds.length) return 0;
    const agentMarks = agentIds.map(() => '?').join(',');
    const channelMarks = channelIds.map(() => '?').join(',');
    const sql =
      'SELECT COUNT(*) AS `overlapCount` FROM (' +
      "SELECT TRIM(REGEXP_REPLACE(m.content->>'$.\"text\"', '[[:space:]]+', ' ')) AS `t`" +
      ' FROM `messages` m JOIN `chat_channels` c ON c.id = m.channel_id' +
      ` WHERE m.sender_type = ? AND m.sender_id IN (${agentMarks})` +
      ' AND m.created_at >= ? AND m.created_at <= ?' +
      ` AND c.id IN (${channelMarks})` +
      ' AND m.content->>\'$."text"\' IS NOT NULL' +
      " AND TRIM(m.content->>'$.\"text\"') <> ''" +
      ' GROUP BY `t` HAVING COUNT(DISTINCT c.type) > 1' +
      ') `x`';
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{ overlapCount: bigint | number }>
      >(sql, SENDER_TYPE.agent, ...agentIds, win.from, win.to, ...channelIds);
      const raw = rows?.[0]?.overlapCount;
      return raw === undefined || raw === null ? 0 : Number(raw);
    } catch (err) {
      this.logger.warn(
        `[coordination-metrics] 同文双报判定失败，降级为 null（不影响其余指标）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
}

/** 成员行投影（buildRoleIndex / buildRoleBreakdowns 共用）。 */
interface RoleMemberRow {
  id: string;
  agentId: string;
  role: { key: string; name: string; sortOrder: number } | null;
}

/** 若干 key 的数值合计（缺失按 0）。 */
function sumOf(map: Map<string, number>, keys: string[]): number {
  let sum = 0;
  for (const key of keys) sum += map.get(key) ?? 0;
  return sum;
}

/** 比例（分母为 0 ⇒ 0，绝不产生 NaN/Infinity 污染响应）。 */
function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return numerator / denominator;
}
