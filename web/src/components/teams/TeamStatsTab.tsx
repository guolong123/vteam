"use client";

/**
 * 团队「统计」子 Tab（会话页右侧面板 TeamSubTabs → stats）
 * =============================================================
 * 定位：**纯只读展示**，一个数据源 `GET /teams/:teamId/usage` 撑起整页，零额外请求。
 * - 数据源 server/src/usage/usage.service.ts 的 `TeamUsageResponse`：
 *   `{members: [{teamMemberId, agentName, roleName, 6 个数值, models:[…]}], teamTotal: {6 个数值}}`。
 *   三层汇总（成员小计 / 模型桶 / 团队合计）由**服务端同一个 addInto** 累加得出，
 *   前端因此可以把卡片、表尾合计、Top 条三处数字对到同一口径上（同一份 teamTotal/members 派生）。
 * - **全员可见，无 admin 门**：服务端成员门在 service（非成员且非平台管理员 → 403），
 *   本组件不做任何权限判断，只用 isApiError 把 403 呈现出来（对齐 memories 的错误面写法）。
 * - **纯累计口径**：服务端不提供时间序列与分页，本组件同样**不做分页、不做区间筛选**
 *   （成员数量级小，一次全量）。
 *
 * 三层汇总（全由 teamTotal / members[] 前端派生，不额外发请求）：
 *   ① 顶部四指标卡：Token 总数 / 输入·输出 / 缓存读·写（附命中率）/ 总费用；
 *   ② 表尾合计行：直接取 teamTotal，与卡片同源；
 *   ③ Top 分布条：按当前透视维度取 Top3 + 另一维度的迷你分布条（**纯 CSS 宽度条**，
 *      颜色取自 src/theme/tokens 的 roles 色板，跟随 light/dark 主题变量）。
 *
 * 透视切换（SegmentedTabs 按成员/按模型）：主行与展开行整体对调——
 *   按成员 = 每个成员一行，展开是该成员**逐模型**一行；
 *   按模型 = 每个模型一行，展开是**逐贡献成员**一行；Top 区跟随维度。
 *
 * 空数据是**正常初始状态**（用量自统计上线后才开始累积，不回填历史），故空态用 EmptyState
 * 而非错误态；错误只可能来自网络/403/5xx。
 *
 * 视觉语言：表格样式抄 `app/(main)/system/roles/page.tsx` 的权限矩阵表
 * （th 对象 + borderCollapse:"separate"/borderSpacing:0 + overflowX 包裹盒），
 * 差异仅在单元格语义——数值列右对齐 + fontFamily.mono + 千分位（权限矩阵是居中符号格）。
 */
import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { isApiError } from "@/lib/errors";
import {
  statsApi,
  statsQueryKey,
  type TeamStatsResponse,
  type UsageTotals,
} from "@/src/api/stats";
import { EmptyState, SegmentedTabs } from "@/src/components/ui";
import {
  roles,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  surface,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 透视维度：按成员（默认）/ 按模型。 */
type Dimension = "member" | "model";

/** 迷你分布条最多列出的条目数（Top3 条之后仍需一眼看到长尾，占位过密反而失真）。 */
const MINI_BAR_LIMIT = 6;
/** Top 条固定 3 名（计划口径「Top3 成员条」）。 */
const TOP_LIMIT = 3;

/* ------------------------------ 局部样式常量 ------------------------------ */

/** 表头单元格：逐字抄 system/roles/page.tsx:238-247 的 th 对象。 */
const th: CSSProperties = {
  padding: `${space.sm}px ${space.md}px`,
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: neutral[500],
  textAlign: "center",
  whiteSpace: "nowrap",
  backgroundColor: neutral[50],
  borderBottom: `1px solid ${neutral[200]}`,
};

/** 首列表头（名称列）：同 th，仅改左对齐 + 最小宽度（抄 roles 页 `<th style={{...th, textAlign:"left", minWidth:140}}>`）。 */
const thName: CSSProperties = { ...th, textAlign: "left", minWidth: 140 };

/** 数值列表头：同 th，改右对齐（数值列一律右对齐）。 */
const thNum: CSSProperties = { ...th, textAlign: "right" };

/**
 * 数值单元格基底：抄 roles 页 cellBase（:248-261）的骨架——字号/字重/圆角内衬/底色，
 * 语义差异是「右对齐 + mono + 弱化文字色」，让整列数字对齐成一条视觉线。
 */
const numCell: CSSProperties = {
  padding: `${space.sm}px ${space.md}px`,
  fontSize: fontSize.md,
  fontWeight: 600,
  color: neutral[700],
  textAlign: "right",
  whiteSpace: "nowrap",
  fontFamily: fontFamily.mono,
  borderBottom: `1px solid ${neutral[100]}`,
};

/** 名称单元格：数值基底改左对齐 + 正文字体（模型名等长串由渲染处再叠加 mono）。 */
const nameCell: CSSProperties = {
  ...numCell,
  textAlign: "left",
  minWidth: 140,
  fontFamily: fontFamily.body,
};

/** 表格横向滚动包裹盒：抄 roles 页 :275-283（overflowX + 圆角 + 边框 + 底色）。 */
const tableWrap: CSSProperties = {
  overflowX: "auto",
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: surface,
};

/** 指标卡：与权限矩阵同源的「盒」骨架（圆角 + 边框 + 底色）。 */
const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space.xs,
  padding: `${space.md}px ${space.lg}px`,
  borderRadius: radius.md,
  backgroundColor: surface,
  border: `1px solid ${neutral[200]}`,
  ...baseFont,
};

const errorBannerStyle: CSSProperties = {
  fontSize: fontSize.sm,
  color: "#DC2626",
  display: "flex",
  alignItems: "center",
  gap: space.xs,
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  backgroundColor: "rgba(239,68,68,0.10)",
  border: `1px solid rgba(239,68,68,0.22)`,
};

const refreshButtonStyle: CSSProperties = {
  padding: `${space.sm}px ${space.lg}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: surface,
  color: neutral[600],
  fontSize: fontSize.sm,
  fontFamily: fontFamily.body,
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

/** 展开行的标题缩进（视觉上挂在主行之下）。 */
const expandIndent = space.lg + space.sm + 10;

/**
 * 条形图配色：直接取 tokens 的 roles 色板（`--color-role-*` CSS 变量），
 * 跟随 light/dark 自动切换，不在本组件里硬编码 hex。
 */
const BAR_COLORS: readonly string[] = [
  roles.product.color,
  roles.project_manager.color,
  roles.architect.color,
  roles.developer.color,
  roles.tester.color,
  roles.plan.color,
];

/* ------------------------------ 数值格式 ------------------------------ */

/** 千分位整数（token 数动辄百万级，不加分隔符无法扫读）。 */
function fmtInt(n: number): string {
  return n.toLocaleString();
}

/** 费用：`$` + 4 位小数（服务端累加原值不四舍五入，精度交由展示层负责）。 */
function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** 比率：1 位小数百分比（计划口径「比率 1 位小数」）。 */
function fmtRatio(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** 安全除法：分母为 0（空团队 / 无缓存命中）返回 0，不产生 NaN/Infinity 展示。 */
function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** 成员首字头像（用量接口只给 agentName/roleName，不给 RoleKey，故不套 AgentAvatar）。 */
function initialsOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

/* ------------------------------ 派生结构 ------------------------------ */

function zeroTotals(): UsageTotals {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
}

/** 从成员小计/模型桶（两者同形）取六元组。 */
function toTotals(source: UsageTotals): UsageTotals {
  return {
    totalTokens: source.totalTokens,
    inputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
    cacheReadTokens: source.cacheReadTokens,
    cacheWriteTokens: source.cacheWriteTokens,
    cost: source.cost,
  };
}

function addInto(target: UsageTotals, addend: UsageTotals): void {
  target.totalTokens += addend.totalTokens;
  target.inputTokens += addend.inputTokens;
  target.outputTokens += addend.outputTokens;
  target.cacheReadTokens += addend.cacheReadTokens;
  target.cacheWriteTokens += addend.cacheWriteTokens;
  target.cost += addend.cost;
}

/** 展开行（维度二）条目：与主行同形，只是没有二级展开。 */
interface StatsChildRow {
  key: string;
  title: string;
  subtitle: string | null;
  totals: UsageTotals;
}

/** 主行条目。两种透视共用一个渲染分支，只在数据来源上分叉。 */
interface StatsRow extends StatsChildRow {
  children: StatsChildRow[];
}

/** 「模型」维度的聚合桶（前端按模型重排 + 汇总成员小计的 models[]）。 */
interface ModelBucket {
  model: string;
  totals: UsageTotals;
  contributors: Array<{
    teamMemberId: string;
    agentName: string;
    roleName: string | null;
    totals: UsageTotals;
  }>;
}

/**
 * 按模型透视的聚合：遍历 `members[].models[]` 重排成「模型 → 贡献成员」。
 *
 * 口径可信的前提（服务端保证，非本组件假设）：`models[]` 是 teamMemberId × model 的
 * groupBy 结果，故**同一成员对同一模型恰好一条**（无需去重），且成员小计 = 其 models 之和、
 * 团队合计 = 全部桶之和——所以按模型重排后的总和与 teamTotal 天然相等，
 * 顶部「按模型」汇总卡与表尾合计行可以互相校验。
 */
function aggregateByModel(members: TeamStatsResponse["members"]): ModelBucket[] {
  const byModel = new Map<string, ModelBucket>();
  for (const member of members) {
    for (const bucket of member.models) {
      let agg = byModel.get(bucket.model);
      if (!agg) {
        agg = { model: bucket.model, totals: zeroTotals(), contributors: [] };
        byModel.set(bucket.model, agg);
      }
      addInto(agg.totals, bucket);
      agg.contributors.push({
        teamMemberId: member.teamMemberId,
        agentName: member.agentName,
        roleName: member.roleName,
        totals: toTotals(bucket),
      });
    }
  }
  return [...byModel.values()].sort(
    (a, b) => b.totals.totalTokens - a.totals.totalTokens || a.model.localeCompare(b.model),
  );
}

/* ------------------------------ 主组件 ------------------------------ */

export interface TeamStatsTabProps {
  teamId: string;
  /** 团队名（仅用于提示文案；未加载到时留空不渲染）。 */
  teamName?: string;
}

/**
 * 团队 tab 下的「统计」子 tab 内容（成员用量表 + 三层汇总）。
 *
 * 权限模型：**全员可见、无 admin 门**——服务端 `UsageService.assertTeamReadable`
 * 做成员校验（非成员且非平台管理员 → 403 PERMISSION_TEAM_NOT_MEMBER），
 * 本组件只负责呈现错误，不复制一套权限判断。
 */
export function TeamStatsTab({ teamId, teamName }: TeamStatsTabProps) {
  /* ---------- 状态 ---------- */
  const [dimension, setDimension] = useState<Dimension>("member");
  /** 已展开的主行 key 集合（切维度不清空：两维度 key 空间不相交，互不污染）。 */
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);

  /* ---------- 数据查询（进入 tab 即查；不做轮询，仅手动刷新） ---------- */
  const query = useQuery({
    queryKey: statsQueryKey(teamId),
    queryFn: () => statsApi.summary(teamId),
    enabled: !!teamId,
  });

  const members = useMemo(() => query.data?.members ?? [], [query.data]);
  const teamTotal = useMemo(
    () => query.data?.teamTotal ?? zeroTotals(),
    [query.data],
  );
  const modelBuckets = useMemo(() => aggregateByModel(members), [members]);

  /* ---------- 主行 / 展开行：两种透视共用一个渲染分支 ---------- */
  const rows: StatsRow[] = useMemo(() => {
    if (dimension === "member") {
      return members.map((member) => ({
        key: `member:${member.teamMemberId}`,
        title: member.agentName,
        subtitle: member.roleName ?? "未绑定角色",
        totals: toTotals(member),
        children: member.models.map((model) => ({
          key: `member:${member.teamMemberId}:model:${model.model}`,
          title: model.model,
          subtitle: null,
          totals: toTotals(model),
        })),
      }));
    }
    return modelBuckets.map((bucket) => ({
      key: `model:${bucket.model}`,
      title: bucket.model,
      subtitle: `${bucket.contributors.length} 位成员使用`,
      totals: toTotals(bucket.totals),
      children: bucket.contributors.map((contributor) => ({
        key: `model:${bucket.model}:member:${contributor.teamMemberId}`,
        title: contributor.agentName,
        subtitle: contributor.roleName ?? "未绑定角色",
        totals: toTotals(contributor.totals),
      })),
    }));
  }, [dimension, members, modelBuckets]);

  /* ---------- Top 分布条：跟随当前透视维度 ---------- */
  const topRows = useMemo(
    () => [...rows].sort((a, b) => b.totals.totalTokens - a.totals.totalTokens).slice(0, TOP_LIMIT),
    [rows],
  );
  const miniRows = useMemo(
    () =>
      dimension === "member"
        ? modelBuckets
        : members.map((member) => ({
            model: member.teamMemberId,
            totals: toTotals(member),
          })),
    [dimension, modelBuckets, members],
  );

  /* ---------- 派生比率（卡片副标题口径，全部由 teamTotal / members[] 算） ---------- */
  const cacheHitRate = ratio(teamTotal.cacheReadTokens, teamTotal.totalTokens);
  const outputShare = ratio(teamTotal.outputTokens, teamTotal.totalTokens);
  const inputShare = ratio(teamTotal.inputTokens, teamTotal.totalTokens);
  const topTokens = topRows.reduce((sum, row) => sum + row.totals.totalTokens, 0);
  const topCost = topRows.reduce((sum, row) => sum + row.totals.cost, 0);

  const toggleRow = (key: string) => {
    setExpandedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  /* ---------- 错误 / 空值分流 ---------- */
  const errorText = query.error
    ? isApiError(query.error)
      ? query.error.message
      : "加载用量统计失败，请重试"
    : null;
  const isEmpty = !query.error && !query.isLoading && members.length === 0;

  if (!teamId) {
    return (
      <EmptyState
        title="未选择团队"
        description="用量按团队归属，请在会话中选择一个团队后查看其 Token 消耗。"
      />
    );
  }

  return (
    <div
      data-testid="team-stats-tab"
      style={{ display: "flex", flexDirection: "column", gap: space.lg }}
    >
      {/* ---------- 工具条：透视切换 + 手动刷新（无轮询） ---------- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: space.sm,
        }}
      >
        <SegmentedTabs
          items={[
            { key: "member", label: "按成员" },
            { key: "model", label: "按模型" },
          ]}
          active={dimension}
          onChange={(key) => setDimension(key === "model" ? "model" : "member")}
          testId="team-stats-pivot"
          optionTestId="team-stats-pivot-tab"
        />
        <button
          type="button"
          data-testid="team-stats-refresh"
          disabled={query.isFetching}
          title="重新拉取用量汇总（统计不自动轮询）"
          onClick={() => void query.refetch()}
          style={
            query.isFetching
              ? { ...refreshButtonStyle, opacity: 0.6, cursor: "default" }
              : refreshButtonStyle
          }
        >
          {query.isFetching ? "刷新中…" : "刷新"}
        </button>
      </div>

      {teamName && (
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>
          「{teamName}」的 Token 用量与费用累计：全员可见，纯只读，统计自用量开始累积起算（不回填历史）。
        </div>
      )}

      {errorText && (
        <div role="alert" style={errorBannerStyle}>
          <span aria-hidden style={{ fontWeight: 700 }}>
            !
          </span>
          <span style={{ flex: 1 }}>{errorText}</span>
          <button
            type="button"
            onClick={() => void query.refetch()}
            style={refreshButtonStyle}
          >
            重试
          </button>
        </div>
      )}

      {!errorText && query.isLoading && (
        <div data-testid="team-stats-loading" style={{ fontSize: fontSize.sm, color: neutral[400] }}>
          加载中…
        </div>
      )}

      {isEmpty && (
        <EmptyState
          title="暂无用量数据——新调用产生后自动统计"
          description="用量自统计上线后开始累计，不回填历史调用；团队成员产生新的调用后，点「刷新」即可看到分布。"
          style={{ padding: `${space.lg}px` }}
        />
      )}

      {!errorText && !isEmpty && (
        <>
          {/* ---------- 汇总层 ①：顶部四指标卡 ---------- */}
          <section
            data-testid="team-stats-cards"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: space.md,
            }}
          >
            <div data-testid="team-stats-card" data-metric="total" style={cardStyle}>
              <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>Token 总数</span>
              <span
                style={{
                  fontSize: fontSize.xxl,
                  fontWeight: 600,
                  color: neutral[800],
                  fontFamily: fontFamily.mono,
                }}
              >
                {fmtInt(teamTotal.totalTokens)}
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                输出占比 {fmtRatio(outputShare)} · {members.length} 位成员 · {modelBuckets.length} 个模型
              </span>
            </div>

            <div data-testid="team-stats-card" data-metric="io" style={cardStyle}>
              <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>输入 / 输出</span>
              <span
                style={{
                  fontSize: fontSize.xxl,
                  fontWeight: 600,
                  color: neutral[800],
                  fontFamily: fontFamily.mono,
                }}
              >
                {fmtInt(teamTotal.inputTokens)} / {fmtInt(teamTotal.outputTokens)}
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                输入占比 {fmtRatio(inputShare)} · 缓存写入 {fmtInt(teamTotal.cacheWriteTokens)}
              </span>
            </div>

            <div data-testid="team-stats-card" data-metric="cache" style={cardStyle}>
              <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>缓存读 / 写</span>
              <span
                style={{
                  fontSize: fontSize.xxl,
                  fontWeight: 600,
                  color: neutral[800],
                  fontFamily: fontFamily.mono,
                }}
              >
                {fmtInt(teamTotal.cacheReadTokens)} / {fmtInt(teamTotal.cacheWriteTokens)}
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                命中率 {fmtRatio(cacheHitRate)}（缓存读 ÷ 总数）
              </span>
            </div>

            <div data-testid="team-stats-card" data-metric="cost" style={cardStyle}>
              <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>总费用</span>
              <span
                style={{
                  fontSize: fontSize.xxl,
                  fontWeight: 600,
                  color: neutral[800],
                  fontFamily: fontFamily.mono,
                }}
              >
                {fmtCost(teamTotal.cost)}
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                Top{TOP_LIMIT} 合计 {fmtCost(topCost)} · 占比 {fmtRatio(ratio(topTokens, teamTotal.totalTokens))}
              </span>
            </div>
          </section>

          {/* ---------- 汇总层 ③：Top 条 + 另一维度迷你分布条（纯 CSS 宽度条） ---------- */}
          <section
            data-testid="team-stats-distribution"
            style={{ display: "flex", flexDirection: "column", gap: space.md }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: space.md,
              }}
            >
              {/* Top3（当前维度） */}
              <div
                data-testid="team-stats-top"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: space.sm,
                  padding: `${space.md}px ${space.lg}px`,
                  borderRadius: radius.md,
                  backgroundColor: surface,
                  border: `1px solid ${neutral[200]}`,
                  ...baseFont,
                }}
              >
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>
                  Top {TOP_LIMIT}
                  {dimension === "member" ? " 成员" : " 模型"}（按 Token 总数）
                </span>
                {topRows.map((row, index) => {
                  const max = topRows[0]?.totals.totalTokens ?? 0;
                  return (
                    <div
                      key={row.key}
                      data-testid="team-stats-top-item"
                      style={{ display: "flex", flexDirection: "column", gap: space.xs }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          justifyContent: "space-between",
                          gap: space.sm,
                        }}
                      >
                        <span
                          style={{
                            fontSize: fontSize.md,
                            color: neutral[800],
                            fontFamily: dimension === "model" ? fontFamily.mono : fontFamily.body,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {index + 1}. {row.title}
                        </span>
                        <span
                          style={{
                            fontSize: fontSize.sm,
                            color: neutral[500],
                            fontFamily: fontFamily.mono,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {fmtInt(row.totals.totalTokens)} · {fmtCost(row.totals.cost)}
                        </span>
                      </div>
                      <div
                        style={{
                          height: 6,
                          borderRadius: radius.pill,
                          backgroundColor: neutral[100],
                          overflow: "hidden",
                        }}
                      >
                        <div
                          data-testid="team-stats-bar"
                          style={{
                            height: "100%",
                            width: `${Math.min(100, ratio(row.totals.totalTokens, max) * 100).toFixed(1)}%`,
                            borderRadius: radius.pill,
                            backgroundColor: BAR_COLORS[index % BAR_COLORS.length],
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 另一维度的迷你分布条：按成员看模型 / 按模型看成员 */}
              <div
                data-testid="team-stats-mini"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: space.sm,
                  padding: `${space.md}px ${space.lg}px`,
                  borderRadius: radius.md,
                  backgroundColor: surface,
                  border: `1px solid ${neutral[200]}`,
                  ...baseFont,
                }}
              >
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>
                  {dimension === "member" ? "模型分布" : "成员分布"}（Token 总数占比）
                </span>
                {miniRows.slice(0, MINI_BAR_LIMIT).map((item, index) => {
                  const max = miniRows[0]?.totals.totalTokens ?? 0;
                  return (
                    <div
                      key={item.model}
                      data-testid="team-stats-mini-item"
                      style={{ display: "flex", alignItems: "center", gap: space.sm }}
                    >
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: fontSize.sm,
                          color: neutral[600],
                          fontFamily: dimension === "member" ? fontFamily.mono : fontFamily.body,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {dimension === "member" ? item.model : miniMemberName(members, item.model)}
                      </span>
                      <span
                        style={{
                          width: 96,
                          height: 6,
                          borderRadius: radius.pill,
                          backgroundColor: neutral[100],
                          overflow: "hidden",
                          flexShrink: 0,
                        }}
                      >
                        <span
                          data-testid="team-stats-bar"
                          style={{
                            display: "block",
                            height: "100%",
                            width: `${Math.min(100, ratio(item.totals.totalTokens, max) * 100).toFixed(1)}%`,
                            borderRadius: radius.pill,
                            backgroundColor: BAR_COLORS[index % BAR_COLORS.length],
                          }}
                        />
                      </span>
                      <span
                        style={{
                          width: 52,
                          textAlign: "right",
                          fontSize: fontSize.xs,
                          color: neutral[500],
                          fontFamily: fontFamily.mono,
                          flexShrink: 0,
                        }}
                      >
                        {fmtRatio(ratio(item.totals.totalTokens, teamTotal.totalTokens))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* ---------- 成员/模型表（无分页：服务端一次全量） ---------- */}
          <section
            data-testid="team-stats-table-section"
            style={{ display: "flex", flexDirection: "column", gap: space.sm }}
          >
            <div style={tableWrap} data-testid="team-stats-table">
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, ...baseFont }}>
                <thead>
                  <tr>
                    <th style={thName}>{dimension === "member" ? "成员" : "模型"}</th>
                    <th style={thNum}>总数</th>
                    <th style={thNum}>输入</th>
                    <th style={thNum}>输出</th>
                    <th style={thNum}>缓存读</th>
                    <th style={thNum}>缓存写</th>
                    <th style={thNum}>费用</th>
                    <th style={{ ...th, minWidth: 64 }}>明细</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const expanded = expandedKeys.includes(row.key);
                    return (
                      <StatsTableRows
                        key={row.key}
                        row={row}
                        expanded={expanded}
                        dimension={dimension}
                        onToggle={() => toggleRow(row.key)}
                      />
                    );
                  })}
                </tbody>
                {/* ---------- 汇总层 ②：表尾合计行（直接取 teamTotal，与卡片同源） ---------- */}
                <tfoot>
                  <tr data-testid="team-stats-total-row">
                    <td style={{ ...nameCell, fontWeight: 700, backgroundColor: neutral[50] }}>
                      合计（{members.length} 位成员）
                    </td>
                    <td style={{ ...numCell, fontWeight: 700, backgroundColor: neutral[50] }}>
                      {fmtInt(teamTotal.totalTokens)}
                    </td>
                    <td style={{ ...numCell, fontWeight: 700, backgroundColor: neutral[50] }}>
                      {fmtInt(teamTotal.inputTokens)}
                    </td>
                    <td style={{ ...numCell, fontWeight: 700, backgroundColor: neutral[50] }}>
                      {fmtInt(teamTotal.outputTokens)}
                    </td>
                    <td style={{ ...numCell, fontWeight: 700, backgroundColor: neutral[50] }}>
                      {fmtInt(teamTotal.cacheReadTokens)}
                    </td>
                    <td style={{ ...numCell, fontWeight: 700, backgroundColor: neutral[50] }}>
                      {fmtInt(teamTotal.cacheWriteTokens)}
                    </td>
                    <td style={{ ...numCell, fontWeight: 700, backgroundColor: neutral[50] }}>
                      {fmtCost(teamTotal.cost)}
                    </td>
                    <td style={{ ...numCell, backgroundColor: neutral[50] }} />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>
              数字为累计值（Token 千分位、费用 4 位小数），不随时间切片；点击行尾「▾」展开
              {dimension === "member" ? "该成员的逐模型用量" : "该模型的逐成员用量"}。
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** 迷你分布条里按模型维度时需要把 teamMemberId 还原成成员名（找不到 = 已删除成员）。 */
function miniMemberName(
  members: TeamStatsResponse["members"],
  teamMemberId: string,
): string {
  return members.find((m) => m.teamMemberId === teamMemberId)?.agentName ?? "已删除成员";
}

/* ------------------------------ 表格行 ------------------------------ */

interface StatsTableRowsProps {
  row: StatsRow;
  expanded: boolean;
  dimension: Dimension;
  onToggle: () => void;
}

/**
 * 一个主行 + （展开时）其明细行。
 * 明细行按维度二渲染：按成员透视 → 模型名（mono）；按模型透视 → 成员名 + 角色。
 */
function StatsTableRows({ row, expanded, dimension, onToggle }: StatsTableRowsProps) {
  const isModelName = dimension === "model";
  return (
    <>
      <tr data-testid="team-stats-row" data-row-key={row.key} data-expanded={expanded ? "true" : "false"}>
        <td style={nameCell}>
          <span style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
            {!isModelName && (
              <span
                aria-hidden
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  borderRadius: radius.pill,
                  backgroundColor: neutral[100],
                  border: `1px solid ${neutral[200]}`,
                  color: neutral[500],
                  fontSize: fontSize.xs,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {initialsOf(row.title)}
              </span>
            )}
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: fontSize.md,
                  fontWeight: 600,
                  color: neutral[800],
                  fontFamily: isModelName ? fontFamily.mono : fontFamily.body,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.title}
              </span>
              {row.subtitle && (
                <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400] }}>
                  {row.subtitle}
                </span>
              )}
            </span>
          </span>
        </td>
        <td style={numCell}>{fmtInt(row.totals.totalTokens)}</td>
        <td style={numCell}>{fmtInt(row.totals.inputTokens)}</td>
        <td style={numCell}>{fmtInt(row.totals.outputTokens)}</td>
        <td style={numCell}>{fmtInt(row.totals.cacheReadTokens)}</td>
        <td style={numCell}>{fmtInt(row.totals.cacheWriteTokens)}</td>
        <td style={numCell}>{fmtCost(row.totals.cost)}</td>
        <td style={{ ...numCell, textAlign: "center" }}>
          <button
            type="button"
            data-testid="team-stats-expand"
            aria-expanded={expanded}
            title={expanded ? "收起明细" : "展开明细"}
            onClick={onToggle}
            style={{
              border: "none",
              background: "none",
              color: "#0D9488",
              fontSize: fontSize.md,
              cursor: "pointer",
              padding: 0,
              fontFamily: fontFamily.body,
            }}
          >
            {expanded ? "▴" : "▾"}
          </button>
        </td>
      </tr>
      {expanded &&
        row.children.map((child) => (
          <tr key={child.key} data-testid="team-stats-detail-row" data-detail-key={child.key}>
            <td style={{ ...nameCell, paddingLeft: expandIndent }}>
              <span
                style={{
                  fontSize: fontSize.sm,
                  color: neutral[600],
                  fontFamily: isModelName ? fontFamily.body : fontFamily.mono,
                }}
              >
                {child.title}
              </span>
              {child.subtitle && (
                <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: space.sm }}>
                  {child.subtitle}
                </span>
              )}
            </td>
            <td style={{ ...numCell, fontSize: fontSize.sm, color: neutral[600] }}>
              {fmtInt(child.totals.totalTokens)}
            </td>
            <td style={{ ...numCell, fontSize: fontSize.sm, color: neutral[600] }}>
              {fmtInt(child.totals.inputTokens)}
            </td>
            <td style={{ ...numCell, fontSize: fontSize.sm, color: neutral[600] }}>
              {fmtInt(child.totals.outputTokens)}
            </td>
            <td style={{ ...numCell, fontSize: fontSize.sm, color: neutral[600] }}>
              {fmtInt(child.totals.cacheReadTokens)}
            </td>
            <td style={{ ...numCell, fontSize: fontSize.sm, color: neutral[600] }}>
              {fmtInt(child.totals.cacheWriteTokens)}
            </td>
            <td style={{ ...numCell, fontSize: fontSize.sm, color: neutral[600] }}>
              {fmtCost(child.totals.cost)}
            </td>
            <td style={numCell} />
          </tr>
        ))}
    </>
  );
}

export default TeamStatsTab;