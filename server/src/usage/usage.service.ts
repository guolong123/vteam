import { ForbiddenException, Injectable } from '@nestjs/common';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import { isPlatformAdminByUserId } from '../users/admin-permission';

/**
 * 调用方上下文（全局 JwtAuthGuard 填充的 request.user 之 userId）。
 * 管理员与否不在此处声明——由 service 内部按 AdminGuard 口径
 * （users/admin-permission.ts 单一事实来源）查库判定，
 * 避免「调用方自称 admin」成为提权面。
 */
export interface UsageViewer {
  id: string;
}

/** 单个成员 × 单个模型的用量桶（字段名与 Todo 5 的 web 类型逐字对齐——契约）。 */
export interface UsageModelBreakdown {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

/** 单个团队成员的用量小计 + 其模型维度展开行。 */
export interface UsageMemberSummary {
  teamMemberId: string;
  agentName: string;
  roleName: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  models: UsageModelBreakdown[];
}

/** 团队合计（与成员小计同 6 个字段）。 */
export interface UsageTotals {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

/**
 * `GET /teams/:teamId/usage` 响应契约（三层汇总一次算好，前端零派生查询）：
 * {members, teamTotal}。字段名与计划 Todo 4 逐字一致，Todo 5 的 web 类型镜像本形状。
 */
export interface TeamUsageResponse {
  members: UsageMemberSummary[];
  teamTotal: UsageTotals;
}

/** 空团队 / 无用量时的零值结构（cost 也是数字 0，见下方 cost 口径注释）。 */
function emptyTotals(): UsageTotals {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
}

/**
 * 团队 Token 用量聚合服务（token-usage-stats Todo 4，**纯只读**）。
 *
 * 口径（与计划 Scope Must have「usage-api」逐条对应）：
 * - 数据源 `model_usage`（worker 事件落库链路写入，本服务零写入）；
 * - 鉴权：`team_user_members` 有行 → 放行；无行 → 回落平台管理员判定
 *   （isPlatformAdminByUserId，AdminGuard 同一口径）；两者皆不满足 → 403
 *   PERMISSION_TEAM_NOT_MEMBER（复用 common/guards/team-membership.guard 的错误码常量，
 *   与 memories.service 的成员过滤同链）；
 * - `?model=` 精确匹配过滤（缺省/空串 = 不过滤）；
 * - 纯累计口径：不做时间序列切片、不分页（成员数量级小，一次全量）；
 * - 成员显示名**实时联表**（team_members → agents.name / agent_roles.name），
 *   表里不存名字快照——改名即时生效，不会出现陈旧名。
 */
@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 团队用量聚合：成员 × 模型分组求和 + 成员名联表 + 团队合计。
   *
   * **查询选型（单次 groupBy 的理由）**：`where: {teamId}`（可选再叠 `model` 精确等值）
   * 命中 `idx_usage_team_member(team_id, team_member_id)` 与
   * `idx_usage_team_model(team_id, model)` 的最左前缀——聚合在 DB 侧完成，
   * 只回「成员 × 模型」聚合行而非把团队全部原始用量行拉到 node 侧再累加
   * （行数量级 = 团队调用次数，比聚合行数高若干数量级）。
   * `by: ['teamMemberId', 'model']` 一次拿到两层维度，成员小计 = 其模型桶之和，
   * 团队合计 = 全部聚合行之和，三层口径同源、不会各算各的。
   *
   * 求和字段 = 响应契约的 5 个 token 口径 + cost；`reasoningTokens` **不入聚合**
   * （响应契约无该字段，模型侧已含在 totalTokens 口径内，单独暴露会诱导重复计数）。
   *
   * cost 口径：`cost` 列可空（NULL = 上游未上报「未知」，非 0 = 免费）。
   * 聚合时 NULL **按 0 参与求和**（Prisma `_sum` 对全 NULL 组返回 null → 归一为 0），
   * 即响应里的 cost 恒为数字、前端不需要处理 null 分支；
   * 「未知」与「免费」的区分保留在明细行（model_usage.cost），聚合层按显示口径并为 0。
   *
   * 排序（确定性，前端不必再排）：成员按 totalTokens 降序、同值按 teamMemberId 升序；
   * 模型桶按 totalTokens 降序、同值按 model 名升序。
   *
   * 空团队 / 无任何用量行 → `{members: [], teamTotal: 全 0}`（且不再查成员联表）。
   */
  async getTeamUsage(
    teamId: string,
    viewer?: UsageViewer,
    model?: string,
  ): Promise<TeamUsageResponse> {
    await this.assertTeamReadable(teamId, viewer);

    const exactModel = model?.trim();
    const rows = await this.prisma.modelUsage.groupBy({
      by: ['teamMemberId', 'model'],
      where: {
        teamId,
        ...(exactModel ? { model: exactModel } : {}),
      },
      _sum: {
        totalTokens: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        cost: true,
      },
    });

    if (rows.length === 0) {
      return { members: [], teamTotal: emptyTotals() };
    }

    // 成员显示名实时联表（团队成员数量级小，一次查全；不落任何名字快照）。
    const memberIds = [...new Set(rows.map((r) => r.teamMemberId))];
    const memberRows = await this.prisma.teamMember.findMany({
      where: { id: { in: memberIds } },
      select: {
        id: true,
        agent: { select: { name: true } },
        role: { select: { name: true } },
      },
    });
    // model_usage 不建 FK（软关联），成员被删除后其历史用量行仍在：
    // 查不到成员行时回落 agentName='' / roleName=null，聚合数字照常返回，不丢成员。
    const namesByMemberId = new Map(
      memberRows.map((m) => [
        m.id,
        { agentName: m.agent?.name ?? '', roleName: m.role?.name ?? null },
      ]),
    );

    const totals = emptyTotals();
    const byMember = new Map<string, UsageMemberSummary>();
    for (const row of rows) {
      const bucket = normalizeBucket(row.model, row._sum);
      addInto(totals, bucket);

      let member = byMember.get(row.teamMemberId);
      if (!member) {
        const names = namesByMemberId.get(row.teamMemberId);
        member = {
          teamMemberId: row.teamMemberId,
          agentName: names?.agentName ?? '',
          roleName: names?.roleName ?? null,
          ...emptyTotals(),
          models: [],
        };
        byMember.set(row.teamMemberId, member);
      }
      addInto(member, bucket);
      member.models.push(bucket);
    }

    const members = [...byMember.values()];
    for (const member of members) {
      member.models.sort(
        (a, b) =>
          b.totalTokens - a.totalTokens || a.model.localeCompare(b.model),
      );
    }
    members.sort(
      (a, b) =>
        b.totalTokens - a.totalTokens ||
        a.teamMemberId.localeCompare(b.teamMemberId),
    );

    return { members, teamTotal: totals };
  }

  /**
   * 团队可读门（**fail closed**）：`team_user_members` 有行即放行；无行回落平台管理员判定
   * （AdminGuard 同一口径，users/admin-permission.ts）；皆不满足 → 403。
   * 无 viewer（理论不可达：全局 JwtAuthGuard 已鉴权）按非成员处理，绝不 fail open。
   */
  private async assertTeamReadable(
    teamId: string,
    viewer?: UsageViewer,
  ): Promise<void> {
    const membership = viewer?.id
      ? await this.prisma.teamUserMember.findUnique({
          where: { teamId_userId: { teamId, userId: viewer.id } },
          select: { id: true },
        })
      : null;
    if (membership) {
      return;
    }
    if (viewer?.id && (await isPlatformAdminByUserId(this.prisma, viewer.id))) {
      return;
    }
    throw new ForbiddenException({
      code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
      message: '您不是该团队成员',
    });
  }
}

/**
 * 单个 (teamMemberId, model) 聚合行 → 用量桶。
 * `_sum` 各字段 Prisma 侧为 `number | null`（组内全 NULL 时返回 null）：一律归一为 0，
 * 「cost 未知」在聚合层按 0 参与（见 getTeamUsage 的 cost 口径注释）。
 * 不做四舍五入：累加原值，金额精度由展示层（web 侧 $ + 4 位小数）负责。
 */
function normalizeBucket(
  model: string,
  sum: {
    totalTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    cost: number | null;
  },
): UsageModelBreakdown {
  return {
    model,
    totalTokens: sum.totalTokens ?? 0,
    inputTokens: sum.inputTokens ?? 0,
    outputTokens: sum.outputTokens ?? 0,
    cacheReadTokens: sum.cacheReadTokens ?? 0,
    cacheWriteTokens: sum.cacheWriteTokens ?? 0,
    cost: sum.cost ?? 0,
  };
}

/** 把一个模型桶累加进成员小计或团队合计（同一口径函数，杜绝两处各写一遍加法）。 */
function addInto(
  target: UsageTotals | UsageMemberSummary,
  bucket: UsageModelBreakdown,
): void {
  target.totalTokens += bucket.totalTokens;
  target.inputTokens += bucket.inputTokens;
  target.outputTokens += bucket.outputTokens;
  target.cacheReadTokens += bucket.cacheReadTokens;
  target.cacheWriteTokens += bucket.cacheWriteTokens;
  target.cost += bucket.cost;
}
