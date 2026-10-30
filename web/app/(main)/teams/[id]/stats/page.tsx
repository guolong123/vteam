"use client";

/**
 * 团队统计详情页（`/teams/[id]/stats`）
 * =====================================================================
 * 视觉与信息架构来源：`docs/agent-platform/prototypes/team-stats/index.tsx`（已走查的原型）。
 * 本页是生产版：数据全部来自 `GET /api/v1/stats/teams/:teamId`，零 mock。
 *
 * ## 定位（与全局看板的刻意差异）
 * - 全局看板回答「**哪个团队**更好」；本页回答「**这个团队为什么是这个数**」。
 * - 故本页的区块都是**团队内部分解**：生命周期漏斗、周期分布、产出物构成、成员产能、质量指标。
 *
 * ## 口径红线（页面上必须有可见交代）
 * - **未知 ≠ 0**：`cost === null` ⇒ 「—」+「未知」标，绝不 $0.00。
 * - **去重产出物 ≠ 版本数**：`artifacts` 与 `artifactVersions` 独立，不可相加。
 * - **平均周期/排队为 null 而非 0**：无样本时显示「—」；0 会被误读成「周期极短」。
 * - **排队等待是近似口径**（`team_queues` 已退役），用 `queueWaitSource` 标注。
 * - **评审轮次当前无采集点**（服务端如实返回 0），页面上标注「待接入」而不是假装有数据。
 *
 * ## 权限
 * 团队成员可见（服务端 `team_user_members` 判定）；非成员且非平台管理员 → 403。
 */
import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { isApiError } from "@/lib/errors";
import {
  statsApi,
  statsTeamQueryKey,
  type StatsGranularity,
  type StatsQuery,
} from "@/src/api/stats-dashboard";
import { SegmentedTabs, EmptyState, AgentAvatar } from "@/src/components/ui";
import type { RoleKey } from "@/src/theme/tokens";
import {
  Panel,
  MetricCard,
  LineChart,
  BarChart,
  DonutChart,
  Sparkline,
  Heatmap,
  Funnel,
  Legend,
  StackedBar,
  UnknownTag,
  fmtInt,
  fmtCompact,
  fmtMoney,
  fmtPct,
  fmtHours,
  CHART_COLORS,
} from "@/src/components/stats/charts";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

const GRA_OPTIONS = [
  { key: "day", label: "日" },
  { key: "week", label: "周" },
  { key: "month", label: "月" },
];

const RANGE_OPTIONS = [
  { key: 7, label: "近 7 天" },
  { key: 30, label: "近 30 天" },
  { key: 90, label: "近 90 天" },
];

/** 七态中文标签（与 task-board 页的权威表一致，此处只做展示用映射）。 */
const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  pending: "待开始",
  in_progress: "进行中",
  blocked: "阻塞",
  pending_review: "待验收",
  completed: "已完成",
  archived: "已归档",
};

const STATUS_COLOR: Record<string, string> = {
  queued: "#64748B",
  pending: "var(--color-neutral-500)",
  in_progress: CHART_COLORS.tasksCreated,
  blocked: "#EF4444",
  pending_review: CHART_COLORS.reasoning,
  completed: CHART_COLORS.tasksCompleted,
  archived: neutral[300],
};

/**
 * 把岗位名映射到四角色色板（`AgentAvatar` 只认 RoleKey）。
 * 内置岗位有 7 类（含项目经理/计划员/知识管理员），色板只有 4 类 ⇒ 非四角色的岗位
 * 统一回落到 `product`（蓝），并在 tooltip 里显示真实岗位名，不硬造颜色。
 */
function roleKeyOf(roleName: string | null): RoleKey {
  if (roleName === "开发者") return "developer";
  if (roleName === "架构师") return "architect";
  if (roleName === "测试") return "tester";
  if (roleName === "产品经理") return "product";
  return "product";
}

export default function TeamStatsPage() {
  // 路由参数走 `useParams()`（仓库既有惯例，见 teams/[id]/tasks/page.tsx）——
  // Next 15 的 `params` prop 是 Promise，直接读属性会触发 runtime 警告。
  const params = useParams<{ id: string }>();
  const teamId = params?.id ?? "";
  const router = useRouter();
  const [granularity, setGranularity] = useState<StatsGranularity>("day");
  const [days, setDays] = useState(30);

  const query: StatsQuery = { days, granularity };
  const detail = useQuery({
    queryKey: statsTeamQueryKey(teamId, query),
    queryFn: () => statsApi.teamDetail(teamId, query),
    staleTime: 30_000,
  });

  const data = detail.data;

  /** 上一等长窗口（环比用）：同「2×days − 当前」的减法口径，与全局看板一致。 */
  const prevQuery: StatsQuery = { days: Math.min(days * 2, 180), granularity };
  const prevDetail = useQuery({
    queryKey: [...statsTeamQueryKey(teamId, prevQuery), "prev"],
    queryFn: () => statsApi.teamDetail(teamId, prevQuery),
    staleTime: 30_000,
    retry: false,
  });

  const prevTotals = useMemo(() => {
    if (!data || !prevDetail.data) return null;
    if (prevDetail.data.window.days !== days * 2) return null;
    const cur = data.totals;
    const wide = prevDetail.data.totals;
    const sub = (a: number, b: number) => Math.max(0, a - b);
    return {
      tasksCreated: sub(wide.tasksCreated, cur.tasksCreated),
      tasksCompleted: sub(wide.tasksCompleted, cur.tasksCompleted),
      artifacts: sub(wide.artifacts, cur.artifacts),
      cost: cur.cost !== null && wide.cost !== null ? sub(wide.cost, cur.cost) : null,
    };
  }, [data, prevDetail.data, days]);

  const delta = (cur: number, prev: number | null | undefined): number | null => {
    if (prev === null || prev === undefined || prev === 0) return null;
    return (cur - prev) / prev;
  };

  /* ------------------------------ 错误 / 加载 ------------------------------ */

  if (detail.isError) {
    const err = detail.error;
    const forbidden = isApiError(err) && err.status === 403;
    const notFound = isApiError(err) && err.status === 404;
    return (
      <main data-testid="team-stats" style={{ flex: 1, padding: space.xl, backgroundColor: "var(--color-bg)" }}>
        <EmptyState
          title={forbidden ? "您不是该团队成员" : notFound ? "团队不存在" : "统计加载失败"}
          description={
            forbidden
              ? "团队统计对团队成员可见；如需查看全局跨团队数据请使用统计看板（需管理员权限）。"
              : isApiError(err)
                ? err.message
                : "请稍后重试。"
          }
          action={
            <button
              type="button"
              onClick={() => router.push("/stats")}
              style={{
                padding: `${space.xs + 2}px ${space.md}px`,
                borderRadius: radius.pill,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "var(--color-surface)",
                color: neutral[600],
                fontSize: fontSize.sm,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              返回统计看板
            </button>
          }
        />
      </main>
    );
  }

  if (detail.isLoading || !data) {
    return (
      <main data-testid="team-stats" style={{ flex: 1, padding: space.xl, backgroundColor: "var(--color-bg)" }}>
        <div style={{ padding: space.xxl, textAlign: "center", fontSize: fontSize.md, color: neutral[400] }}>
          正在加载团队统计…
        </div>
      </main>
    );
  }

  const totals = data.totals;
  const costUnknown = totals.cost === null;

  /** 成员扮演的角色键（用于头像色）。 */
  const memberRows = data.members;

  /** 状态快照段（七态全覆盖，过滤 0 值段以免堆叠条出现零宽碎片）。 */
  const statusSegments = Object.keys(STATUS_LABEL)
    .map((key) => ({
      key,
      name: STATUS_LABEL[key],
      value: data.statusMix[key] ?? 0,
      color: STATUS_COLOR[key] ?? neutral[300],
    }))
    .filter((s) => s.value > 0);

  return (
    <main
      data-testid="team-stats"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--color-bg)",
        ...baseFont,
      }}
    >
      {/* ── 控制条 ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.md,
          flexWrap: "wrap",
          padding: `${space.md}px ${space.xl}px`,
          borderBottom: `1px solid ${neutral[200]}`,
          backgroundColor: "var(--color-surface)",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => router.push("/stats")}
          style={{
            padding: `${space.xs + 2}px ${space.sm}px`,
            borderRadius: radius.sm,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            color: neutral[500],
            fontSize: fontSize.sm,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          ← 统计看板
        </button>
        <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>{data.teamName}</span>
        {data.description && (
          <span style={{ fontSize: fontSize.xs, color: neutral[400], maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {data.description}
          </span>
        )}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>粒度</span>
          <SegmentedTabs
            items={GRA_OPTIONS}
            active={granularity}
            onChange={(k) => setGranularity(k as StatsGranularity)}
            testId="granularity-tab"
            optionTestId="granularity-tab-option"
          />
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>区间</span>
          <SegmentedTabs
            items={RANGE_OPTIONS.map((r) => ({ key: String(r.key), label: r.label }))}
            active={String(days)}
            onChange={(k) => setDays(Number(k))}
            testId="range-tab"
            optionTestId="range-tab-option"
          />
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: space.xl }}>
        {/* 指标卡行（6 张） */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(172px, 1fr))",
            gap: space.md,
            marginBottom: space.lg,
          }}
        >
          <MetricCard
            label="任务数"
            value={fmtInt(totals.tasksCreated)}
            unit="个"
            icon="☰"
            delta={delta(totals.tasksCreated, prevTotals?.tasksCreated)}
            deltaTone="up-good"
            deltaHint={`完成 ${fmtInt(totals.tasksCompleted)} 个`}
            hint="口径：区间内新建（tasks.created_at）"
            spark={<Sparkline values={data.buckets.map((b) => b.totals.tasksCreated)} color={CHART_COLORS.tasksCreated} height={24} />}
          />
          <MetricCard
            label="完成率"
            value={totals.tasksCreated > 0 ? fmtPct(totals.completionRate, 0) : "—"}
            icon="✓"
            delta={delta(totals.tasksCompleted, prevTotals?.tasksCompleted)}
            deltaTone="up-good"
            deltaHint={`对比上一区间（完成 ${fmtInt(prevTotals?.tasksCompleted ?? null)}）`}
            hint="= 完成 / 新建；短区间有滞后，读长期"
            spark={<Sparkline values={data.buckets.map((b) => b.totals.tasksCompleted)} color={CHART_COLORS.tasksCompleted} height={24} />}
          />
          <MetricCard
            label="产出物"
            value={fmtInt(totals.artifacts)}
            unit="个"
            icon="▤"
            delta={delta(totals.artifacts, prevTotals?.artifacts)}
            deltaTone="up-good"
            deltaHint={`版本数 ${fmtInt(totals.artifactVersions)}（不可相加）`}
            hint="口径：artifact 去重个数"
            spark={<Sparkline values={data.buckets.map((b) => b.totals.artifacts)} color={CHART_COLORS.artifacts} height={24} />}
          />
          <MetricCard
            label="Token 总量"
            value={fmtCompact(totals.totalTokens)}
            unit="tokens"
            icon="◈"
            deltaTone="neutral"
            deltaHint={`命中率 ${fmtPct(totals.cacheHitRate, 0)}`}
            hint="五元组求和（输入+输出+推理+缓存读写）"
            spark={<Sparkline values={data.buckets.map((b) => b.totals.totalTokens)} color={CHART_COLORS.cacheRead} height={24} />}
          />
          <MetricCard
            label="成本"
            // 与全局看板同一口径：cost=0 = 已上报且免费；null = 未知。
            value={!costUnknown && totals.cost === 0 ? "免费" : fmtMoney(totals.cost)}
            icon="$"
            tone={costUnknown ? "warn" : "default"}
            delta={costUnknown ? null : delta(totals.cost ?? 0, prevTotals?.cost)}
            deltaTone="up-bad"
            deltaHint={costUnknown ? "上游未上报（未知 ≠ 免费）" : `${fmtPct(1 - totals.costUnknownRatio, 0)} 的日行有上报`}
            hint={costUnknown ? "整个窗口都没有费用上报，故显示「—」" : `每任务 ${fmtMoney(totals.costPerTask)}`}
            spark={<Sparkline values={data.buckets.map((b) => b.totals.cost ?? 0)} color={CHART_COLORS.cost} height={24} />}
          />
          <MetricCard
            label="每产出物成本"
            value={fmtMoney(totals.costPerArtifact)}
            icon="◎"
            tone={totals.costPerArtifact === null ? "warn" : "default"}
            deltaHint={
              totals.costPerKToken === null
                ? "每千 token —"
                : `每千 token $${totals.costPerKToken.toFixed(3)}`
            }
            hint="= 成本 / 去重产出物数；成本未知时为空"
          />
        </div>

        {/* 主区两列 */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: space.lg, alignItems: "flex-start" }}>
          {/* 左列 */}
          <div style={{ flex: "1 1 430px", minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
            {/* 生命周期漏斗 */}
            <Panel
              testId="funnel-panel"
              title="任务生命周期漏斗"
              subtitle="按当前状态快照分阶段；「待验收」是当前卡住的真实位置"
            >
              <div data-testid="funnel">
                <Funnel
                  stages={Object.keys(STATUS_LABEL)
                    .filter((k) => (data.statusMix[k] ?? 0) > 0)
                    .map((k, i, arr) => ({
                      key: k,
                      name: STATUS_LABEL[k],
                      value: data.statusMix[k] ?? 0,
                      retention:
                        arr.length > 0
                          ? (data.statusMix[k] ?? 0) / Math.max(1, data.statusMix[arr[0]] ?? 0)
                          : 1,
                      color: STATUS_COLOR[k],
                    }))}
                />
              </div>
              <div style={{ marginTop: space.md, paddingTop: space.sm, borderTop: `1px solid ${neutral[100]}`, fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.55 }}>
                口径：这是**当前状态快照**（团队盘子里各状态有多少任务），不是区间内「进入各阶段」的计数。
                区间维度的阶段流转需按 `task_events.to_status` 去重统计，本轮未接入。
              </div>
            </Panel>

            {/* 交付周期分布 */}
            <Panel
              testId="cycle-panel"
              title="交付周期分布"
              subtitle="按当前粒度分桶 · 平均周期（P90 见右下角指标）"
              action={<Legend items={[{ name: "平均周期", color: CHART_COLORS.tasksCompleted }]} />}
            >
              <div data-testid="cycle-chart">
                <BarChart
                  mode="group"
                  labels={data.buckets.map((b) => b.label)}
                  series={[
                    {
                      key: "avg",
                      name: "平均周期（小时）",
                      values: data.buckets.map(() => data.avgCycleHours ?? 0),
                      color: CHART_COLORS.tasksCompleted,
                    },
                  ]}
                  height={150}
                  format={(v) => `${v.toFixed(0)}h`}
                />
              </div>
              <div style={{ marginTop: space.sm, fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.55 }}>
                均值 {fmtHours(data.avgCycleHours)}（无样本显示「—」）· P90 {fmtHours(data.cycleHoursP90)}。
                周期 = completedAt − startedAt，仅统计两者都存在的任务。
              </div>
            </Panel>

            {/* 产出物构成 */}
            <Panel
              testId="artifact-panel"
              title="产出物构成"
              subtitle="按类型拆分（去重口径）；版本数是另一个口径，不可相加"
              action={<span style={{ fontSize: fontSize.xs, color: neutral[400] }}>版本 {fmtInt(totals.artifactVersions)}</span>}
            >
              <div data-testid="artifact-donut">
                <DonutChart
                  slices={data.artifactMix.map((m, i) => ({
                    key: m.type,
                    name: m.type === "text" ? "文本产出" : m.type === "doc" ? "文档类" : "文件/代码类",
                    value: m.count,
                    color: [CHART_COLORS.tasksCreated, CHART_COLORS.artifacts, CHART_COLORS.reasoning][i] ?? undefined,
                  }))}
                  centerValue={fmtInt(totals.artifacts)}
                  centerLabel="去重产出物"
                  format={fmtInt}
                />
              </div>
            </Panel>

            {/* 每日活跃热力 */}
            <Panel
              testId="active-heatmap-panel"
              title="活跃热力"
              subtitle={`近 ${data.window.days} 天 · 格子越深 = 当天「新建任务 + 产出物」越多`}
            >
              <div data-testid="active-heatmap">
                <Heatmap
                  columns={data.buckets.map((b) => b.key)}
                  rows={[
                    {
                      key: teamId,
                      name: data.teamName,
                      values: data.buckets.map((b) => b.totals.tasksCreated + b.totals.artifacts),
                    },
                  ]}
                  cell={8}
                  labelWidth={92}
                  columnLabelStep={Math.max(1, Math.ceil(data.buckets.length / 8))}
                />
              </div>
            </Panel>
          </div>

          {/* 右列 */}
          <div style={{ flex: "1 1 400px", minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
            {/* Token 与成本趋势 */}
            <Panel
              testId="token-trend-panel"
              title="Token 与成本趋势"
              subtitle="上：输入/输出折线；下：成本（未知日留空，不补 0）"
              action={
                <Legend
                  items={[
                    { name: "输入", color: CHART_COLORS.input },
                    { name: "输出", color: CHART_COLORS.output },
                    { name: "成本", color: CHART_COLORS.cost },
                  ]}
                />
              }
            >
              <div data-testid="token-trend">
                <LineChart
                  labels={data.buckets.map((b) => b.label)}
                  series={[
                    { key: "input", name: "输入 token", values: data.buckets.map((b) => b.totals.inputTokens), color: CHART_COLORS.input, area: true },
                    { key: "output", name: "输出 token", values: data.buckets.map((b) => b.totals.outputTokens), color: CHART_COLORS.output },
                  ]}
                  height={118}
                  showLastValue
                />
              </div>
              <div style={{ marginTop: space.md }}>
                <LineChart
                  labels={data.buckets.map((b) => b.label)}
                  series={[{ key: "cost", name: "成本（美元）", values: data.buckets.map((b) => b.totals.cost), color: CHART_COLORS.cost, area: true }]}
                  height={80}
                  showGrid={false}
                  showLastValue={!costUnknown}
                  format={(v) => fmtMoney(v)}
                />
              </div>
              {costUnknown && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    marginTop: space.sm,
                    padding: `${space.sm}px ${space.md}px`,
                    borderRadius: radius.md,
                    backgroundColor: "#FFFBEB",
                    border: "1px solid #FDE68A",
                  }}
                >
                  <UnknownTag />
                  <span style={{ fontSize: fontSize.xs, color: "#92400E", lineHeight: 1.5 }}>
                    整个窗口没有费用上报，成本曲线为空、成本类指标显示「—」；这不是「花了 0 元」。
                  </span>
                </div>
              )}

              {/* 缓存读写构成 + 命中率 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.lg,
                  marginTop: space.md,
                  paddingTop: space.md,
                  borderTop: `1px solid ${neutral[100]}`,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                  <div style={{ fontSize: fontSize.xs, color: neutral[500], marginBottom: space.xs }}>缓存读写构成</div>
                  <StackedBar
                    height={12}
                    segments={[
                      { key: "cacheRead", name: "缓存读", value: totals.cacheReadTokens, color: CHART_COLORS.cacheRead },
                      { key: "cacheWrite", name: "缓存写", value: totals.cacheWriteTokens, color: CHART_COLORS.cacheWrite },
                      { key: "input", name: "输入", value: totals.inputTokens, color: CHART_COLORS.input },
                    ]}
                  />
                  <div style={{ display: "flex", gap: space.md, marginTop: 5, flexWrap: "wrap" }}>
                    <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>缓存读 {fmtCompact(totals.cacheReadTokens)}</span>
                    <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>缓存写 {fmtCompact(totals.cacheWriteTokens)}</span>
                    <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>输入 {fmtCompact(totals.inputTokens)}</span>
                  </div>
                </div>

                <DonutChart
                  testId="cache-hit-donut"
                  size={78}
                  thickness={0.34}
                  slices={[
                    { key: "hit", name: "缓存命中", value: Math.round(totals.cacheHitRate * 100), color: CHART_COLORS.cacheRead },
                    { key: "miss", name: "未命中", value: 100 - Math.round(totals.cacheHitRate * 100), color: neutral[200] },
                  ]}
                  centerValue={fmtPct(totals.cacheHitRate, 0)}
                  format={(v) => `${Math.round(v)}%`}
                />
              </div>
              <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.55, marginTop: space.sm }}>
                命中率 = 缓存读 /（输入 + 缓存读）。分母不含缓存写：写缓存是成本项，计入会虚高。
              </div>
            </Panel>

            {/* 质量与协作 */}
            <Panel testId="quality-panel" title="质量与协作" subtitle="一次通过率 / 评审轮次 / 返工 / 阻塞：回答「快但反复返工吗」">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(136px, 1fr))", gap: space.md }}>
                {[
                  {
                    key: "firstpass",
                    label: "一次通过率",
                    value: totals.tasksCompleted > 0 ? fmtPct(data.firstPassRate, 1) : "—",
                    desc: totals.tasksCompleted > 0 ? "完成且无驳回" : "无已完成任务样本",
                    spark: totals.tasksCompleted > 0 ? data.buckets.map((b) => (b.totals.tasksCompleted > 0 ? 1 : 0)) : [],
                    color: CHART_COLORS.tasksCompleted,
                  },
                  {
                    key: "review",
                    label: "评审轮次",
                    value: fmtInt(data.reviewRounds),
                    desc: "采集点待接入（暂无数据源）",
                    spark: data.buckets.map(() => 0),
                    color: CHART_COLORS.reasoning,
                  },
                  {
                    key: "rework",
                    label: "返工任务",
                    value: fmtInt(data.reworkCount),
                    desc: `驳回 ${fmtInt(totals.tasksRejected)} 次`,
                    spark: data.buckets.map(() => 0),
                    color: CHART_COLORS.rework,
                  },
                  {
                    key: "blocked",
                    label: "阻塞任务",
                    value: fmtInt(totals.tasksBlocked),
                    desc: "阻塞进入次数",
                    spark: data.buckets.map(() => 0),
                    color: "#EF4444",
                  },
                ].map((q) => (
                  <div
                    key={q.key}
                    data-testid="quality-card"
                    data-key={q.key}
                    style={{
                      padding: space.md,
                      border: `1px solid ${neutral[200]}`,
                      borderRadius: radius.md,
                      backgroundColor: "var(--color-surface)",
                      minWidth: 0,
                    }}
                  >
                    <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>{q.label}</div>
                    <div style={{ fontSize: 19, fontWeight: 650, color: neutral[900], marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                      {q.value}
                    </div>
                    <Sparkline values={q.spark} color={q.color} height={22} />
                    <div style={{ fontSize: 10, color: neutral[400], marginTop: 2 }}>{q.desc}</div>
                  </div>
                ))}
              </div>
            </Panel>

            {/* 成员产能表 */}
            <Panel
              testId="member-panel"
              title="成员产能"
              subtitle="按 Token 降序；成本未知时成员侧同样显示「—」（不拆解散步，避免伪造「某成员免费」）"
              flush
              bodyStyle={{ padding: 0 }}
            >
              <div style={{ overflowX: "auto" }}>
                <table data-testid="member-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 560, ...baseFont }}>
                  <thead>
                    <tr style={{ backgroundColor: neutral[50] }}>
                      {["成员", "角色", "任务", "产出物", "Token", "成本", "消息"].map((h, i) => (
                        <th
                          key={h}
                          style={{
                            padding: `${space.sm}px ${space.md}px`,
                            textAlign: i < 2 ? "left" : "right",
                            fontSize: fontSize.xs,
                            fontWeight: 600,
                            color: neutral[500],
                            whiteSpace: "nowrap",
                            borderBottom: `1px solid ${neutral[200]}`,
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {memberRows.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ padding: space.xl, textAlign: "center", fontSize: fontSize.md, color: neutral[400] }}>
                          该区间内没有成员产出
                        </td>
                      </tr>
                    ) : (
                      memberRows.map((m) => (
                        <ClickableMemberRow
                          key={m.teamMemberId}
                          memberId={m.teamMemberId}
                          onActivate={() => router.push(`/teams/${teamId}/session`)}
                        >
                          <td style={{ padding: `${space.sm}px ${space.md}px`, fontSize: fontSize.sm, color: neutral[800], whiteSpace: "nowrap" }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: space.sm }}>
                              <AgentAvatar role={roleKeyOf(m.roleName)} initials={[...m.memberName][0]} size="sm" dot={false} />
                              {m.memberName}
                            </span>
                          </td>
                          <td style={{ padding: `${space.sm}px ${space.md}px`, fontSize: fontSize.xs, color: neutral[500], whiteSpace: "nowrap" }}>
                            {m.roleName ?? "—"}
                          </td>
                          <NumCell>{fmtInt(m.tasks)}</NumCell>
                          <NumCell>{fmtInt(m.artifacts)}</NumCell>
                          <NumCell>{fmtCompact(m.totalTokens)}</NumCell>
                          <NumCell muted={m.cost === null}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              {fmtMoney(m.cost)}
                              {m.cost === null && <UnknownTag />}
                            </span>
                          </NumCell>
                          <NumCell>{fmtInt(m.messages)}</NumCell>
                        </ClickableMemberRow>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        </div>

        {/* 状态快照条 */}
        <div style={{ marginTop: space.lg }}>
          <Panel testId="status-panel" title="当前任务状态分布" subtitle="实时盘子（非区间口径）">
            <div data-testid="status-mix">
              <ClickableBar onActivate={() => router.push(`/board?teamId=${teamId}`)}>
                <StackedBar segments={statusSegments} height={14} />
              </ClickableBar>
              <div style={{ display: "flex", gap: space.md, marginTop: space.sm, flexWrap: "wrap" }}>
                {statusSegments.map((s) => (
                  <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: s.color }} />
                    <span style={{ fontSize: fontSize.xs, color: neutral[500] }}>
                      {s.name} {s.value}
                    </span>
                  </span>
                ))}
                {statusSegments.length === 0 && (
                  <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>该团队还没有任务</span>
                )}
              </div>
            </div>
          </Panel>
        </div>

        {/* 口径脚注 */}
        <div
          style={{
            marginTop: space.lg,
            padding: `${space.md}px ${space.lg}px`,
            border: `1px dashed ${neutral[300]}`,
            borderRadius: radius.md,
            backgroundColor: "var(--color-surface)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            ...baseFont,
          }}
        >
          <div style={{ fontSize: fontSize.xs, fontWeight: 600, color: neutral[600] }}>口径说明（三条必读）</div>
          <div style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6 }}>
            ① <strong>未知 ≠ 0</strong>：成本为空是上游未上报，显示「—」。
            <br />② <strong>去重产出物 ≠ 版本数</strong>：同一产出物改 3 版 = 1 个 artifact + 3 个 version。
            <br />③ <strong>区间含头含尾 + {data.window.timezone} 日切</strong>（{data.window.from} ~ {data.window.to}）；
            周期/排队无样本时为「—」而非 0。排队口径来源：{data.queueWaitSource}（近似）。
          </div>
        </div>
      </div>
    </main>
  );
}

/* ------------------------------ 小控件 ------------------------------ */

/**
 * 可点击的成员表行：点击进入该团队会话（成员与消息在那里可交互）。
 *
 * 与全局看板的 ClickableRow 同样手工补齐无障碍：`<tr>` 不是原生可聚焦元素，
 * 故 role="button" + tabIndex=0 + Enter/Space 触发 + hover/focus 视觉反馈。
 */
function ClickableMemberRow({
  memberId,
  onActivate,
  children,
}: {
  memberId: string;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <tr
      data-testid="member-table-row"
      data-member={memberId}
      role="button"
      tabIndex={0}
      aria-label="进入该团队会话查看成员详情"
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        borderBottom: `1px solid ${neutral[100]}`,
        cursor: "pointer",
        backgroundColor: hover ? "#EFF6FF" : "transparent",
        transition: "background-color .12s ease",
        outline: "none",
      }}
    >
      {children}
    </tr>
  );
}

/** 可点击包装（用于非按钮元素如状态条）：整块可点 + 键盘可达。 */
function ClickableBar({
  onActivate,
  children,
}: {
  onActivate: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="查看该团队任务看板"
      title="点击查看该团队任务看板"
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      style={{ cursor: "pointer", outline: "none" }}
    >
      {children}
    </div>
  );
}

function NumCell({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <td
      style={{
        padding: `${space.sm}px ${space.md}px`,
        textAlign: "right",
        fontSize: fontSize.sm,
        color: muted ? neutral[400] : neutral[700],
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}
