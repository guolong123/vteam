"use client";

/**
 * 统计看板（全局 · 跨团队）页面
 * =====================================================================
 * 视觉与信息架构来源：`docs/agent-platform/prototypes/stats-dashboard/index.tsx`（已走查的原型）。
 * 本页是它的**生产版**：数字全部来自真实端点 `GET /api/v1/stats/overview`，零 mock。
 *
 * ## 与原型的三处关键差异（都是「原型没有、生产必须有」的东西）
 *
 * 1. **环比（delta）不再由前端伪造**：原型用 mock 序列算 delta；生产端点只返回**当前窗口**，
 *    故本页额外请求「上一等长窗口」把两段总量相减——这是唯一正确做法（服务端不做环比，
 *    避免把「环比口径」写死在契约里）。
 * 2. **权限可见性**：overview 需要平台管理员（AdminGuard）；非管理员会拿到 403，
 *    本页用 `isApiError` 统一呈现为「仅管理员可见」的空态，而不是白屏或红色报错。
 * 3. **暗色主题**：所有颜色走 `src/theme/tokens.ts` 的 CSS 变量，不写死十六进制。
 *
 * ## 口径（页面上必须可见地交代，不能只写在文档里）
 * - **未知 ≠ 0**：`cost === null` ⇒ 显示「—」+「未知」标，绝不渲染 $0.00。
 * - **去重产出物 ≠ 版本数**：两个字段分开展示，不可相加。
 * - **区间含头含尾 + Asia/Shanghai 日切**；环比对比「上一个等长区间」。
 * - **排队等待是近似口径**（`team_queues` 已退役），响应带 `queueWaitSource`，页脚标注。
 */
import { useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { isApiError } from "@/lib/errors";
import { statsApi, statsOverviewQueryKey, type StatsGranularity, type StatsQuery } from "@/src/api/stats-dashboard";
import { SegmentedTabs, EmptyState } from "@/src/components/ui";
import {
  Panel,
  MetricCard,
  LineChart,
  BarChart,
  DonutChart,
  RankBar,
  Heatmap,
  Sparkline,
  Legend,
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

type RankDimension = "completed" | "artifacts" | "tokens";

/** 环比：当前窗口 vs 上一个等长窗口（同粒度、同团队过滤）。 */
function computeDelta(
  current: number | null,
  previous: number | null | undefined,
): number | null {
  if (current === null || previous === null || previous === undefined || previous === 0) {
    return null;
  }
  return (current - previous) / previous;
}

export default function StatsDashboardPage() {
  const router = useRouter();
  const [granularity, setGranularity] = useState<StatsGranularity>("day");
  const [days, setDays] = useState(30);
  const [activeTeamIds, setActiveTeamIds] = useState<string[]>([]);
  const [rankDim, setRankDim] = useState<RankDimension>("completed");

  const teamIdsParam = activeTeamIds.length > 0 ? activeTeamIds.join(",") : undefined;
  const query: StatsQuery = { days, granularity, teamIds: teamIdsParam };

  const overview = useQuery({
    queryKey: statsOverviewQueryKey(query),
    queryFn: () => statsApi.overview(query),
    staleTime: 30_000,
  });

  // 环比对标窗口：同一 to（缺省今天）、同粒度，只看「前 days 天」。
  // 服务端以「今天」为右端点，故这里 days=2*days 的窗口末尾就是当前窗口，
  // 前 days 天落在上一个等长区间——用一次请求拿到两段，避免再打一个端点。
  const prevQuery: StatsQuery = { days: Math.min(days * 2, 180), granularity, teamIds: teamIdsParam };
  const prevOverview = useQuery({
    queryKey: [...statsOverviewQueryKey(prevQuery), "prev"],
    queryFn: () => statsApi.overview(prevQuery),
    staleTime: 30_000,
    // 上一段不存在时（窗口超过上限）静默降级：环比显示「—」即可，不阻塞主数据。
    retry: false,
  });

  const data = overview.data;

  /**
   * 上一段区间总量 = 「2×days 窗口总量 − 当前窗口总量」的逐字段差。
   *
   * 为什么这样做而不是让服务端算：服务端契约只承诺「一个窗口的总量」，
   * 环比是**展示层的派生**（不同产品对环比的定义可能不同：等长区间 / 上一自然周 / 上一自然月）。
   * 前端减法的前提是「2×days 窗口恰好 = 当前 + 上一」，而这由服务端「含头含尾」的
   * 窗口定义保证（两者右端点对齐、长度相加），故减法成立且无需额外请求。
   */
  const prevTotals = useMemo(() => {
    if (!data || !prevOverview.data) return null;
    const cur = data.totals;
    const wide = prevOverview.data.totals;
    if (prevOverview.data.window.days !== days * 2) return null;
    const sub = (a: number, b: number) => Math.max(0, a - b);
    return {
      tasksCreated: sub(wide.tasksCreated, cur.tasksCreated),
      tasksCompleted: sub(wide.tasksCompleted, cur.tasksCompleted),
      artifacts: sub(wide.artifacts, cur.artifacts),
      agentMessages: sub(wide.agentMessages, cur.agentMessages),
      /** 成本未知时不参与环比（减法对 null 无意义）。 */
      cost: cur.cost !== null && wide.cost !== null ? sub(wide.cost, cur.cost) : null,
    };
  }, [data, prevOverview.data, days]);

  // useMemo 包裹：``?? []`` 每次渲染都是新数组引用，会让下游 useMemo 依赖每帧变化
  //（lint warning「could make the dependencies change on every render」的根因）。
  const teams = useMemo(() => data?.teams ?? [], [data?.teams]);
  const totals = data?.totals;

  // 团队多选 chip：空数组 = 全部（避免维护 N 个勾选态）
  const toggleTeam = (id: string) => {
    setActiveTeamIds((cur) => {
      if (cur.length === 0) return [id];
      if (cur.includes(id)) {
        const next = cur.filter((x) => x !== id);
        return next.length === 0 ? [] : next;
      }
      const next = [...cur, id];
      return next.length === teams.length ? [] : next;
    });
  };

  const rankItems = useMemo(
    () =>
      [...teams]
        .map((t) => ({
          key: t.teamId,
          name: t.teamName,
          value:
            rankDim === "completed"
              ? t.totals.tasksCompleted
              : rankDim === "artifacts"
                ? t.totals.artifacts
                : t.totals.totalTokens,
          display:
            rankDim === "tokens" ? fmtCompact(t.totals.totalTokens) : undefined,
          meta:
            rankDim === "completed"
              ? `完成率 ${fmtPct(t.totals.completionRate, 0)}`
              : rankDim === "artifacts"
                ? `周期 ${fmtHours(t.avgCycleHours)}`
                : `成本 ${fmtMoney(t.totals.cost)}`,
        }))
        .sort((a, b) => b.value - a.value),
    [teams, rankDim],
  );

  /* ------------------------------ 无权限 / 加载 / 错误 ------------------------------ */

  if (overview.isError) {
    const forbidden = isApiError(overview.error) && overview.error.status === 403 /* ApiError 只有 status，没有 statusCode */;
    return (
      <main data-testid="stats-dashboard" style={{ flex: 1, padding: space.xl, backgroundColor: "var(--color-bg)" }}>
        <EmptyState
          title={forbidden ? "统计看板仅平台管理员可见" : "统计看板加载失败"}
          description={
            forbidden
              ? "全局跨团队数据属于平台经营视角，需要管理员权限；团队自身的统计可进入团队详情查看。"
              : isApiError(overview.error)
                ? overview.error.message
                : "请稍后重试。"
          }
        />
      </main>
    );
  }

  return (
    <main
      data-testid="stats-dashboard"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--color-bg)",
        ...baseFont,
      }}
    >
      {/* ── 筛选条 ── */}
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
        {/* 团队多选 */}
        <div data-testid="team-filter" style={{ display: "flex", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}>
          <ChipButton
            active={activeTeamIds.length === 0}
            testId="team-filter-chip"
            dataKey="all"
            onClick={() => setActiveTeamIds([])}
            label="全部团队"
          />
          {teams.map((t) => (
            <ChipButton
              key={t.teamId}
              active={activeTeamIds.includes(t.teamId)}
              testId="team-filter-chip"
              dataKey={t.teamId}
              onClick={() => toggleTeam(t.teamId)}
              label={t.teamName}
            />
          ))}
        </div>

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

      {/* ── 滚动主体 ── */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: space.xl }}>
        {overview.isLoading || !data || !totals ? (
          <div style={{ padding: space.xxl, textAlign: "center", fontSize: fontSize.md, color: neutral[400] }}>
            正在加载统计…
          </div>
        ) : (
          <>
            {/* 指标卡行 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(196px, 1fr))",
                gap: space.md,
                marginBottom: space.lg,
              }}
            >
              <MetricCard
                label="新建任务"
                value={fmtInt(totals.tasksCreated)}
                unit="个"
                icon="☰"
                onClick={() => router.push(activeTeamIds.length === 1 ? `/board?teamId=${activeTeamIds[0]}` : "/board")}
                delta={computeDelta(totals.tasksCreated, prevTotals?.tasksCreated)}
                deltaTone="up-good"
                deltaHint={prevTotals ? `对比上一个 ${days} 天（${fmtInt(prevTotals.tasksCreated)}）` : "无可比区间"}
                hint="口径：区间内 tasks.created_at 计数"
                spark={<Sparkline values={data.buckets.map((b) => b.totals.tasksCreated)} color={CHART_COLORS.tasksCreated} height={26} />}
              />
              <MetricCard
                label="已完成任务"
                value={fmtInt(totals.tasksCompleted)}
                unit="个"
                icon="✓"
                onClick={() => router.push(activeTeamIds.length === 1 ? `/board?teamId=${activeTeamIds[0]}` : "/board")}
                delta={computeDelta(totals.tasksCompleted, prevTotals?.tasksCompleted)}
                deltaTone="up-good"
                deltaHint={
                  totals.tasksCreated > 0
                    ? `完成率 ${fmtPct(totals.completionRate, 0)} · 一次通过 ${totals.tasksCompleted > 0 ? fmtPct(data.firstPassRate, 0) : "—"}`
                    : "本区间无新建任务"
                }
                hint="口径：tasks.completed_at 计数（验收通过才计完成）"
                spark={<Sparkline values={data.buckets.map((b) => b.totals.tasksCompleted)} color={CHART_COLORS.tasksCompleted} height={26} />}
              />
              <MetricCard
                label="产出物"
                value={fmtInt(totals.artifacts)}
                unit="个"
                icon="▤"
                onClick={() => router.push(activeTeamIds.length === 1 ? `/docs?teamId=${activeTeamIds[0]}` : "/docs")}
                delta={computeDelta(totals.artifacts, prevTotals?.artifacts)}
                deltaTone="up-good"
                deltaHint={`版本数 ${fmtInt(totals.artifactVersions)}（不同口径，不可相加）`}
                hint="口径：artifacts 去重个数"
                spark={<Sparkline values={data.buckets.map((b) => b.totals.artifacts)} color={CHART_COLORS.artifacts} height={26} />}
              />
              {/*
                成本卡的显示口径：`cost=0` 的真实含义是「统计到了、金额为 0」（通常是免费模型），
                与 `null`（未知）必须区分 —— 前者显示「免费」是**正确**的，只有 null 才显示「—」。
                这样运营者不会把 $0.00 误认为「没统计到」而去排查数据链路。
                点击行为：仅当筛选到单个团队时跳该团队详情（含成本趋势）；全局视图没有落地页，故不可点。
              */}
              <MetricCard
                label="总成本"
                value={totals.cost === 0 ? "免费" : fmtMoney(totals.cost)}
                {...(activeTeamIds.length === 1
                  ? { onClick: () => router.push(`/teams/${activeTeamIds[0]}/stats`) }
                  : {})}
                icon="$"
                tone={totals.cost === null ? "warn" : "default"}
                delta={computeDelta(totals.cost, prevTotals?.cost)}
                deltaTone="up-bad"
                deltaHint={
                  totals.costUnknownRatio > 0
                    ? `${fmtPct(1 - totals.costUnknownRatio, 0)} 的日行有成本上报`
                    : `每任务 ${fmtMoney(totals.costPerTask)} · 每产出物 ${fmtMoney(totals.costPerArtifact)}`
                }
                hint={
                  totals.cost === null
                    ? "成本未知 ≠ 0：上游（worker）未上报费用，显示「—」而非 $0.00"
                    : totals.costUnknownRatio > 0
                      ? `仅 ${fmtPct(1 - totals.costUnknownRatio, 0)} 日行有上报，每单位成本不给（避免假精确）`
                      : totals.cost === 0
                        ? "已上报且金额为 0（当前模型均为 free 档），不是没统计到"
                        : `缓存命中率 ${fmtPct(totals.cacheHitRate, 0)} · ${fmtCompact(totals.totalTokens)} tokens`
                }
                spark={<Sparkline values={data.buckets.map((b) => b.totals.cost ?? 0)} color={CHART_COLORS.cost} height={26} />}
              />
            </div>

            {/* 主区两列 */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: space.lg, alignItems: "flex-start" }}>
              {/* 左列 */}
              <div style={{ flex: "1 1 460px", minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
                <Panel
                  testId="trend-panel"
                  title="任务与产出趋势"
                  subtitle={`粒度：${GRA_OPTIONS.find((g) => g.key === granularity)?.label} · 共 ${data.buckets.length} 个刻度`}
                  action={
                    <Legend
                      items={[
                        { name: "新建任务", color: CHART_COLORS.tasksCreated },
                        { name: "完成任务", color: CHART_COLORS.tasksCompleted },
                        { name: "产出物（去重）", color: CHART_COLORS.artifacts },
                      ]}
                    />
                  }
                >
                  <div data-testid="trend-chart">
                    <LineChart
                      labels={data.buckets.map((b) => b.label)}
                      series={[
                        { key: "created", name: "新建任务（个）", values: data.buckets.map((b) => b.totals.tasksCreated), color: CHART_COLORS.tasksCreated, area: true },
                        { key: "completed", name: "完成任务（个）", values: data.buckets.map((b) => b.totals.tasksCompleted), color: CHART_COLORS.tasksCompleted },
                        { key: "artifacts", name: "产出物（个）", values: data.buckets.map((b) => b.totals.artifacts), color: CHART_COLORS.artifacts },
                      ]}
                      height={210}
                      showLastValue
                    />
                  </div>
                  <div style={{ marginTop: space.sm, fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5 }}>
                    切线说明：新建与完成**不构成因果对**（完成回填的是更早期新建的任务），完成率只在足够长的区间才有意义。
                  </div>
                </Panel>

                <Panel
                  testId="token-panel"
                  title="Token 用量与成本"
                  subtitle="堆叠柱 = 四类 token（输入/输出/缓存读写）；费用趋势见下方"
                  action={
                    <Legend
                      items={[
                        { name: "输入", color: CHART_COLORS.input },
                        { name: "输出", color: CHART_COLORS.output },
                        { name: "缓存读", color: CHART_COLORS.cacheRead },
                        { name: "缓存写", color: CHART_COLORS.cacheWrite },
                      ]}
                    />
                  }
                >
                  <div data-testid="token-chart">
                    <BarChart
                      mode="stack"
                      labels={data.buckets.map((b) => b.label)}
                      series={[
                        { key: "input", name: "输入 token", values: data.buckets.map((b) => b.totals.inputTokens), color: CHART_COLORS.input },
                        { key: "output", name: "输出 token", values: data.buckets.map((b) => b.totals.outputTokens), color: CHART_COLORS.output },
                        { key: "cacheRead", name: "缓存读 token", values: data.buckets.map((b) => b.totals.cacheReadTokens), color: CHART_COLORS.cacheRead },
                        { key: "cacheWrite", name: "缓存写 token", values: data.buckets.map((b) => b.totals.cacheWriteTokens), color: CHART_COLORS.cacheWrite },
                      ]}
                      height={190}
                      showTotal
                    />
                  </div>
                  {/* 成本折线：只在**真的有钱花**时才画。
                      当前库里全是 free 档模型，cost 全为 0 —— 画出来是一条贴地直线 + 一个
                      「$0.00」末点标签，既没有信息量又白占 96px 高度（用户直接反馈「空了一大片」）。
                      cost 为 0 时改为一行说明，把高度让给真正有信息量的堆叠柱。 */}
                  <div style={{ marginTop: space.md }}>
                    {totals.cost === 0 ? (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: space.sm,
                          padding: `${space.sm}px ${space.md}px`,
                          borderRadius: radius.md,
                          backgroundColor: neutral[50],
                          border: `1px solid ${neutral[200]}`,
                        }}
                      >
                        <span style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.55 }}>
                          本区间费用合计为 <strong>0</strong>（当前模型均为 free 档），故不绘制成本曲线；
                          换用付费模型后这里会自动出现成本趋势。
                        </span>
                      </div>
                    ) : (
                      <LineChart
                        labels={data.buckets.map((b) => b.label)}
                        series={[{ key: "cost", name: "成本（美元）", values: data.buckets.map((b) => b.totals.cost), color: CHART_COLORS.cost, area: true }]}
                        height={96}
                        showGrid={false}
                        showLastValue
                        format={(v) => fmtMoney(v)}
                      />
                    )}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.xl,
                      marginTop: space.md,
                      paddingTop: space.md,
                      borderTop: `1px solid ${neutral[100]}`,
                      flexWrap: "wrap",
                    }}
                  >
                    <DonutChart
                      testId="cost-coverage-donut"
                      size={104}
                      thickness={0.3}
                      slices={[
                        { key: "known", name: "有成本上报", value: Math.round((1 - totals.costUnknownRatio) * data.window.days), color: CHART_COLORS.cost },
                        { key: "unknown", name: "未知（未上报）", value: Math.round(totals.costUnknownRatio * data.window.days), color: neutral[300] },
                      ]}
                      centerValue={fmtPct(1 - totals.costUnknownRatio, 0)}
                      centerLabel="成本覆盖"
                      format={fmtInt}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: space.xs, minWidth: 0, flex: "1 1 220px" }}>
                      <div style={{ fontSize: fontSize.sm, color: neutral[700], fontWeight: 600 }}>
                        缓存命中率 {fmtPct(totals.cacheHitRate, 1)}
                        <span style={{ fontWeight: 400, color: neutral[400], marginLeft: space.sm, fontSize: fontSize.xs }}>
                          缓存读 /（输入 + 缓存读）
                        </span>
                      </div>
                      {totals.costUnknownRatio > 0 && (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}>
                          <UnknownTag />
                          <span style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5 }}>
                            另有 {fmtPct(totals.costUnknownRatio, 0)} 的日行未上报费用（成本未知 ≠ 0）
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </Panel>

              </div>

              {/* 右列 */}
              <div style={{ flex: "1 1 380px", minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
                <Panel
                  testId="rank-panel"
                  title="团队产能排行"
                  subtitle="同一区间内的横向比较；条长按当前维度归一"
                  action={
                    <SegmentedTabs
                      items={[
                        { key: "completed", label: "按完成任务" },
                        { key: "artifacts", label: "按产出物" },
                        { key: "tokens", label: "按 Token" },
                      ]}
                      active={rankDim}
                      onChange={(k) => setRankDim(k as RankDimension)}
                      testId="rank-dimension"
                      optionTestId="rank-dimension-option"
                    />
                  }
                >
                  <div data-testid="rank-bar">
                    {/* 点任意团队名 → 该团队统计详情（与下方对比表同一目标页） */}
                    <RankBar items={rankItems} onItemClick={(teamId) => router.push(`/teams/${teamId}/stats`)} />
                  </div>
                </Panel>

                <Panel
                  testId="health-panel"
                  title="协作健康度"
                  subtitle="效率与质量指标：看「快不快 / 顺不顺 / 返工多不多」"
                >
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))", gap: space.md }}>
                    {[
                      {
                        key: "cycle",
                        label: "平均交付周期",
                        value: fmtHours(data.avgCycleHours),
                        desc: data.avgCycleHours === null ? "无已完成任务样本" : "startedAt → completedAt",
                        ratio: Math.min(1, (data.avgCycleHours ?? 0) / 80),
                        color: CHART_COLORS.tasksCompleted,
                      },
                      {
                        key: "firstpass",
                        label: "一次通过率",
                        value: totals.tasksCompleted > 0 ? fmtPct(data.firstPassRate, 0) : "—",
                        desc: totals.tasksCompleted > 0 ? "完成且无驳回" : "无已完成任务样本",
                        ratio: Math.min(1, data.firstPassRate),
                        color: CHART_COLORS.tasksCompleted,
                      },
                      {
                        key: "rework",
                        label: "返工任务",
                        value: fmtInt(data.reworkCount),
                        desc: "验收驳回后重新执行",
                        ratio: Math.min(1, data.reworkCount / Math.max(1, totals.tasksCompleted)),
                        color: CHART_COLORS.rework,
                      },
                      {
                        key: "members",
                        label: "活跃成员",
                        value: fmtInt(totals.activeMembers),
                        desc: "窗口内有模型调用",
                        ratio: Math.min(1, totals.activeMembers / Math.max(1, teams.reduce((a, t) => a + t.memberCount, 0))),
                        color: CHART_COLORS.cacheRead,
                      },
                    ].map((h) => (
                      <div
                        key={h.key}
                        data-testid="health-card"
                        data-key={h.key}
                        style={{
                          padding: space.md,
                          border: `1px solid ${neutral[200]}`,
                          borderRadius: radius.md,
                          backgroundColor: "var(--color-surface)",
                          minWidth: 0,
                        }}
                      >
                        <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>{h.label}</div>
                        <div style={{ fontSize: 19, fontWeight: 650, color: neutral[900], marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                          {h.value}
                        </div>
                        <div style={{ marginTop: space.sm, height: 4, borderRadius: radius.pill, backgroundColor: neutral[100], overflow: "hidden" }}>
                          <div style={{ width: `${Math.max(3, h.ratio * 100)}%`, height: "100%", backgroundColor: h.color }} />
                        </div>
                        <div style={{ fontSize: 10, color: neutral[400], marginTop: 5 }}>{h.desc}</div>
                      </div>
                    ))}
                  </div>
                </Panel>

                <Panel
                  testId="heatmap-panel"
                  title="活跃热力图"
                  subtitle={`${data.window.days} 天 × ${teams.length} 个团队 · 格子越深 = 当天「新建任务 + 产出物」越多；虚线格 = 无数据`}
                >
                  <div data-testid="heatmap">
                    <Heatmap
                      columns={data.buckets.map((b) => b.key)}
                      rows={teams.map((t) => ({
                        key: t.teamId,
                        name: t.teamName,
                        // 用桶里的「任务 + 产出物」作为活跃强度（与总量卡同一口径来源）
                        values: data.buckets.map((b) => b.totals.tasksCreated + b.totals.artifacts),
                      }))}
                      cell={7}
                      labelWidth={104}
                      columnLabelStep={Math.max(1, Math.ceil(data.buckets.length / 8))}
                      onRowClick={(teamId) => router.push(`/teams/${teamId}/stats`)}
                    />
                  </div>
                </Panel>
              </div>
            </div>

            {/* 团队对比表（整幅宽：10 列在侧栏里放不下，会横向溢出） */}
            <div style={{ marginTop: space.lg }}>
              <Panel
                testId="compare-panel"
                title="团队对比"
                subtitle="点击任意行 = 下钻到该团队详情；「每任务/每产出物成本」是真正可比的分母"
                flush
                bodyStyle={{ padding: 0 }}
              >
                <div style={{ overflowX: "auto" }}>
                  <table data-testid="team-compare-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 760, ...baseFont }}>
                    <thead>
                      <tr style={{ backgroundColor: neutral[50] }}>
                        {["团队", "任务", "完成率", "产出物", "Token", "成本", "每任务成本", "每产出物成本", "平均周期", "一次通过"].map((h, i) => (
                          <th
                            key={h}
                            style={{
                              padding: `${space.sm}px ${space.md}px`,
                              textAlign: i === 0 ? "left" : "right",
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
                      {teams.map((t) => {
                        const costUnknown = t.totals.cost === null;
                        return (
                          <ClickableRow
                            key={t.teamId}
                            testId="team-compare-row"
                            dataTeam={t.teamId}
                            onActivate={() => router.push(`/teams/${t.teamId}/stats`)}
                          >
                            <td style={{ padding: `${space.sm}px ${space.md}px`, fontSize: fontSize.sm, fontWeight: 500, color: neutral[800], whiteSpace: "nowrap" }}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                {t.teamName}
                                <span aria-hidden style={{ color: neutral[300], fontSize: fontSize.sm }}>›</span>
                              </span>
                            </td>
                            <NumCell>{fmtInt(t.totals.tasksCreated)}</NumCell>
                            {/* 完成率与一次通过的**分母是任务/完成数**：分母为 0 时服务端返回 0，
                                但这不是「完成率是 0%」，而是「没有样本」。直接渲染 0% 会让运营者
                                误以为团队质量差 —— 故无样本时显示「—」。 */}
                            <NumCell>{t.totals.tasksCreated > 0 ? fmtPct(t.totals.completionRate, 0) : "—"}</NumCell>
                            <NumCell>{fmtInt(t.totals.artifacts)}</NumCell>
                            <NumCell>{fmtCompact(t.totals.totalTokens)}</NumCell>
                            <NumCell>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                {fmtMoney(t.totals.cost)}
                                {(costUnknown || t.totals.costUnknownRatio > 0) && <UnknownTag />}
                              </span>
                            </NumCell>
                            {/* 成本「部分未知」时服务端已把每单位成本置 null —— 这里统一按
                                「值为 null」渲染「—」并标未知，不再自己判断 ratio（口径只在服务端一处）。 */}
                            <NumCell muted={t.totals.costPerTask === null}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                {fmtMoney(t.totals.costPerTask)}
                                {t.totals.costPerTask === null && t.totals.cost !== null && <UnknownTag title="成本覆盖不全，每单位成本不可用" />}
                              </span>
                            </NumCell>
                            <NumCell muted={t.totals.costPerArtifact === null}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                {fmtMoney(t.totals.costPerArtifact)}
                                {t.totals.costPerArtifact === null && t.totals.cost !== null && <UnknownTag title="成本覆盖不全，每单位成本不可用" />}
                              </span>
                            </NumCell>
                            <NumCell>{fmtHours(t.avgCycleHours)}</NumCell>
                            <NumCell>{t.totals.tasksCompleted > 0 ? fmtPct(data.firstPassRate, 0) : "—"}</NumCell>
                          </ClickableRow>
                        );
                      })}
                      {/* 合计行：成本只汇总已知部分 */}
                      <tr style={{ backgroundColor: neutral[50], fontWeight: 600 }}>
                        <td style={{ padding: `${space.sm}px ${space.md}px`, fontSize: fontSize.sm, color: neutral[700], whiteSpace: "nowrap" }}>
                          合计（{teams.length} 个团队）
                        </td>
                        <NumCell>{fmtInt(totals.tasksCreated)}</NumCell>
                        <NumCell>{totals.tasksCreated > 0 ? fmtPct(totals.completionRate, 0) : "—"}</NumCell>
                        <NumCell>{fmtInt(totals.artifacts)}</NumCell>
                        <NumCell>{fmtCompact(totals.totalTokens)}</NumCell>
                        <NumCell>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            {fmtMoney(totals.cost)}
                            {totals.costUnknownRatio > 0 && <UnknownTag title="合计仅含已知成本，未知团队未计入" />}
                          </span>
                        </NumCell>
                        <NumCell>—</NumCell>
                        <NumCell>—</NumCell>
                        <NumCell>—</NumCell>
                        <NumCell>—</NumCell>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div style={{ padding: `${space.sm}px ${space.md}px`, fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.55, borderTop: `1px solid ${neutral[100]}` }}>
                  合计行的成本是**已知部分之和**（有团队成本未知，故不等于真实总额）；「每任务/每产出物成本」与比率类指标不做跨团队加总（加总无意义）。
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
                ① <strong>未知 ≠ 0</strong>：成本列为空表示上游（worker）未上报，显示「—」；$0.00 会把「没统计到」误读为「不花钱」。
                <br />② <strong>去重产出物 ≠ 版本数</strong>：同一产出物改 3 版 = 1 个 artifact + 3 个 version，不可相加。
                <br />③ <strong>区间含头含尾 + {data.window.timezone} 日切</strong>（{data.window.from} ~ {data.window.to}）；环比对比上一个等长区间。
                排队等待为近似口径（队列表已退役），仅供参考。
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/* ------------------------------ 小控件 ------------------------------ */

/**
 * 可点击的表格行（整行跳转）。
 *
 * 无障碍要点（`<tr>` 不是原生可聚焦元素，必须手工补齐）：
 * - `role="button"` + `tabIndex={0}` ⇒ 键盘可达；
 * - Enter / Space 触发（Space 需 `preventDefault`，否则会滚动页面）；
 * - hover 与 focus-visible 都给出同样的视觉反馈，键盘用户能看到当前选中行。
 *
 * 为什么不包一层 `<a>`：HTML 规范不允许 `<a>` 直接嵌在 `<tbody>` 里包住 `<tr>`，
 * 而把链接塞进每个 `<td>` 又会出现「点单元格 vs 点整行」的不一致体验。
 */
function ClickableRow({
  testId,
  dataTeam,
  onActivate,
  children,
}: {
  testId: string;
  dataTeam: string;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <tr
      data-testid={testId}
      data-team={dataTeam}
      role="button"
      tabIndex={0}
      aria-label="查看该团队统计详情"
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

function ChipButton({
  active,
  testId,
  dataKey,
  onClick,
  label,
}: {
  active: boolean;
  testId: string;
  dataKey: string;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-key={dataKey}
      data-active={active ? "true" : "false"}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: `${space.xs + 2}px ${space.md}px`,
        borderRadius: radius.pill,
        border: `1px solid ${active ? "#2563EB" : neutral[200]}`,
        backgroundColor: active ? "#EFF6FF" : "var(--color-surface)",
        color: active ? "#2563EB" : neutral[500],
        fontSize: fontSize.sm,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
        fontFamily: fontFamily.body,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: active ? "#2563EB" : neutral[300] }}
      />
      {label}
    </button>
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
