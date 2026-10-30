/**
 * 原型：统计看板（全局 · 跨团队对比）— device: desktop
 * =====================================================================
 * 对应「团队统计看板」需求的**管理员视角**：一眼看出各团队在日/周/月粒度上的
 * 任务量、产出物量、token 用量、成本，以及效率/质量/协作/成本健康度四类补充维度。
 * 团队维度下钻到单团队详情页见同项目原型 `team-stats`（本页「团队对比表」行点击即其入口）。
 *
 * 页面骨架（与 task-board 同源，T15 铁律）：
 * - root `height:100%; position:relative`；所有浮层 absolute；**零 fixed / 100vh / 100vw**
 *   （md-docs 的 DeviceFrame 是固定 1280×800 的内滚动容器，用 fixed 会直接溢出到 frame 外）。
 * - 顶栏 NavTopBar（文档流）+ 内容区 absolute(top:60) + 左侧 NavDock（absolute）+
 *   Cmd+K 命令面板（absolute，受控开关）；内容区 `paddingLeft: 80` 避让 Dock。
 *
 * 数据口径（**全部取自 _shared/stats-data.ts，页面内不做任何二次累加**）：
 * - 日粒度是唯一事实源；周/月由 `bucketize()` 聚合 ⇒ 切换粒度后指标卡与趋势图不可能对不上。
 * - `cost === null` = 上游未上报「**未知**」，**不等于 0（免费）**：本页对未知成本一律显示「—」
 *   并附「未知」小标与脚注，绝不渲染 $0.00（报表中台整窗未知、告警中心前 60 天未知，用于走查该态）。
 * - 产出物 `artifacts` 是**去重**个数，`artifactVersions` 是版本数，两者不可相加、不可互换。
 * - 区间含头不含尾、按 Asia/Shanghai 日切；环比对比**上一个等长区间**。
 *
 * 布局：指标卡行（4）→ 两列主区（趋势 / token+成本、排行 / 对比表、热力图 / 健康度）→ 口径脚注。
 * 两列用 flexWrap + minWidth 实现「宽屏两列、窄屏单列」，不依赖 media query（DeviceFrame 内无窗口宽度钩子）。
 */

import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "../_shared/styles";
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
  EmptyChart,
  fmtInt,
  fmtCompact,
  fmtMoney,
  fmtPct,
  fmtHours,
  fmtSignedPct,
  CHART_COLORS,
} from "../_shared/charts";
import {
  TEAMS,
  dailyOf,
  aggregate,
  bucketize,
  rangeDays,
  windowOf,
  teamRollups,
  heatDates,
  activityHeat,
  deltaRate,
} from "../_shared/stats-data";
import type { DailyMetric, Granularity, RangeKey, Totals } from "../_shared/stats-data";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起宽度（与 _shared/nav.tsx 的 RAIL_W 一致），内容区据此避让。 */
const RAIL_W = 56;

/* ============================ 数据派生（页面内只做「取数 + 组合」，不做计数逻辑） ============================ */

/** 取选中团队在区间内的全部日行（跨团队合并成一张表再交给统计层聚合）。 */
function rowsFor(teamIds: string[], range: RangeKey): DailyMetric[] {
  return teamIds.flatMap((id) => windowOf(id, range));
}

/**
 * 上一个等长区间的合计（环比分母）。
 * `stats-data` 的 `compareToPrevious()` 只支持单团队 / 全量，而本页要支持**任意团队子集**，
 * 故这里按同一批团队从 90 天序列里切出前一段；任一段不足长度时返回 null（UI 显示「—」）。
 */
function prevTotalsFor(teamIds: string[], range: RangeKey): Totals | null {
  const days = rangeDays(range);
  const rows = teamIds.flatMap((id) => {
    const all = dailyOf(id);
    const prev = all.slice(Math.max(0, all.length - days * 2), all.length - days);
    return prev.length === days ? prev : [];
  });
  return rows.length > 0 ? aggregate(rows) : null;
}

/** 六个 token 口径之和（页面多处复用，避免各处各写一遍加法）。 */
function totalTokensOf(t: Totals): number {
  return t.inputTokens + t.outputTokens + t.reasoningTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

/** 环比比率（分母缺失或为 0 ⇒ null ⇒ 「—」，不伪造 +100%）。 */
function deltaOf(cur: number, prev: number | null | undefined): number | null {
  return deltaRate(cur, prev);
}

/* ============================ 小控件 ============================ */

/** 分段切换控件（粒度 / 区间 / 排行维度共用同一视觉，避免页面上出现三种「按钮长相」）。 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  testId,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: 2,
        gap: 2,
        borderRadius: radius.pill,
        backgroundColor: neutral[100],
        border: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            data-testid={`${testId}-option`}
            data-key={o.key}
            data-active={active ? "true" : "false"}
            onClick={() => onChange(o.key)}
            style={{
              padding: `${space.xs + 2}px ${space.md}px`,
              borderRadius: radius.pill,
              border: "none",
              backgroundColor: active ? "#FFFFFF" : "transparent",
              color: active ? neutral[900] : neutral[500],
              fontSize: fontSize.sm,
              fontWeight: active ? 600 : 500,
              cursor: "pointer",
              fontFamily: fontFamily.body,
              boxShadow: active ? shadow.sm : "none",
              transition: "background-color .15s ease, color .15s ease",
              whiteSpace: "nowrap",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** 「成本未知」小标：明确区分「未知」与「免费」，是本期最重要的口径可视化。 */
function UnknownTag({ title = "上游未上报成本（未知 ≠ 0）" }: { title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "1px 5px",
        borderRadius: radius.sm,
        backgroundColor: "#FFFBEB",
        border: "1px solid #FDE68A",
        color: "#B45309",
        fontSize: 10,
        fontWeight: 600,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      未知
    </span>
  );
}

/** 数值格：右对齐 + tabular-nums（表格里所有数字必须等宽，否则列会「跳动」）。 */
function Num({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
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

/* ============================ Cmd+K 命令项 ============================ */

const CMD_ITEMS: CmdKItem[] = [
  { group: "导航", label: "任务看板", icon: "☰", hint: "查看任务状态分布" },
  { group: "导航", label: "统计看板", icon: "▦", hint: "当前页面", highlight: true },
  { group: "维度", label: "按团队对比", icon: "◫", hint: "跨团队任务 / 产出 / 成本" },
  { group: "维度", label: "按时间趋势", icon: "▲", hint: "日 / 周 / 月粒度" },
  { group: "导出", label: "导出 CSV", icon: "⤓", hint: "当前筛选口径的快照" },
];

/* ============================ 页面 ============================ */

const GRA_OPTIONS: { key: Granularity; label: string }[] = [
  { key: "day", label: "日" },
  { key: "week", label: "周" },
  { key: "month", label: "月" },
];

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "90d", label: "近 90 天" },
];

type RankDimension = "completed" | "artifacts" | "tokens";

const RANK_OPTIONS: { key: RankDimension; label: string }[] = [
  { key: "completed", label: "按完成任务" },
  { key: "artifacts", label: "按产出物" },
  { key: "tokens", label: "按 Token" },
];

function StatsDashboardPage() {
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [range, setRange] = useState<RangeKey>("30d");
  /** 团队多选：空数组 = 全部（避免「全选」需要维护 N 个勾选态）。 */
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [rankDim, setRankDim] = useState<RankDimension>("completed");
  const [selectedRow, setSelectedRow] = useState<string | null>(null);

  const effectiveIds = activeIds.length > 0 ? activeIds : TEAMS.map((t) => t.id);
  const isAllTeams = activeIds.length === 0;

  /* ---- 取数：一次算好，所有区块共享同一批 rows ⇒ 数字天然自洽 ---- */
  const rows = rowsFor(effectiveIds, range);
  const totals = aggregate(rows);
  const prev = prevTotalsFor(effectiveIds, range);
  const buckets = bucketize(rows, granularity);
  const rollups = teamRollups(range).filter((r) => effectiveIds.includes(r.team.id));

  const sparkCreated = bucketize(rows, "day").map((b) => b.totals.tasksCreated);
  const sparkCompleted = bucketize(rows, "day").map((b) => b.totals.tasksCompleted);
  const sparkArtifacts = bucketize(rows, "day").map((b) => b.totals.artifacts);
  const sparkCost = bucketize(rows, "day").map((b) => b.totals.cost ?? 0);

  const tokenTotal = totalTokensOf(totals);
  const totalCostKnownDays = Math.round((1 - totals.costUnknownRatio) * rangeDays(range));

  /** 排行榜条目：按当前维度取真实聚合值。 */
  const rankItems = rollups
    .map((r) => {
      const tokens = totalTokensOf(r.totals);
      const value =
        rankDim === "completed"
          ? r.totals.tasksCompleted
          : rankDim === "artifacts"
            ? r.totals.artifacts
            : tokens;
      return {
        key: r.team.id,
        name: r.team.name,
        value,
        display: rankDim === "tokens" ? fmtCompact(value) : fmtInt(value),
        meta:
          rankDim === "completed"
            ? `完成率 ${fmtPct(r.totals.completionRate, 0)}`
            : rankDim === "artifacts"
              ? `周期 ${fmtHours(r.totals.avgCycleHours)}`
              : `成本 ${fmtMoney(r.totals.cost)}`,
        color: undefined,
      };
    })
    .sort((a, b) => b.value - a.value);

  const toggleTeam = (id: string) => {
    setActiveIds((cur) => {
      // 从「全部」点击某团队 ⇒ 进入单选该团队；再点「全部」恢复
      if (cur.length === 0) return [id];
      if (cur.includes(id)) {
        const next = cur.filter((x) => x !== id);
        return next.length === 0 ? [] : next;
      }
      const next = [...cur, id];
      // 选满全部团队 ⇒ 归为「全部」，避免出现「4 个都选中但显示全部」的语义重复
      return next.length === TEAMS.length ? [] : next;
    });
  };

  /* ---- 表格合计行：只对已知成本求和，并在表尾注明覆盖范围 ---- */
  const sumTasksCreated = rollups.reduce((a, r) => a + r.totals.tasksCreated, 0);
  const sumTasksCompleted = rollups.reduce((a, r) => a + r.totals.tasksCompleted, 0);
  const sumArtifacts = rollups.reduce((a, r) => a + r.totals.artifacts, 0);
  const sumTokens = rollups.reduce((a, r) => a + totalTokensOf(r.totals), 0);
  const knownCostSum = rollups.reduce((a, r) => a + (r.totals.cost ?? 0), 0);
  const hasUnknownCost = rollups.some((r) => r.totals.cost === null || r.totals.costUnknownRatio > 0);

  const heatCols = heatDates().slice(-rangeDays(range));

  return (
    <div
      data-testid="stats-dashboard"
      style={{
        height: "100%",
        minHeight: 720,
        position: "relative",
        backgroundColor: neutral[100],
        ...baseFont,
      }}
    >
      {/* 顶栏：标题 + 口径副标题 + Cmd+K 触发框 + 用户 */}
      <NavTopBar
        title="统计看板"
        subtitle={`跨团队 · ${isAllTeams ? `${TEAMS.length} 个团队` : `${effectiveIds.length} 个团队`} · ${RANGE_OPTIONS.find((r) => r.key === range)?.label} · ${GRA_OPTIONS.find((g) => g.key === granularity)?.label}粒度`}
        userName="运营者"
        userRole="平台管理员"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：absolute(top:60) + paddingLeft 避让 Dock + 内部纵向滚动 */}
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          paddingLeft: RAIL_W + space.xl,
        }}
      >
        {/* ── 筛选条（固定在滚动区之上，滚动内容时不跟着走） ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.md,
            flexWrap: "wrap",
            padding: `${space.md}px ${space.xl}px`,
            borderBottom: `1px solid ${neutral[200]}`,
            backgroundColor: "#FFFFFF",
            flexShrink: 0,
          }}
        >
          {/* 团队多选 chip：「全部」+ 4 团队 */}
          <div
            data-testid="team-filter"
            style={{ display: "flex", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}
          >
            <button
              type="button"
              data-testid="team-filter-chip"
              data-key="all"
              data-active={isAllTeams ? "true" : "false"}
              onClick={() => setActiveIds([])}
              style={{
                padding: `${space.xs + 2}px ${space.md}px`,
                borderRadius: radius.pill,
                border: `1px solid ${isAllTeams ? "#2563EB" : neutral[200]}`,
                backgroundColor: isAllTeams ? "#EFF6FF" : "#FFFFFF",
                color: isAllTeams ? "#2563EB" : neutral[500],
                fontSize: fontSize.sm,
                fontWeight: isAllTeams ? 600 : 500,
                cursor: "pointer",
                fontFamily: fontFamily.body,
                whiteSpace: "nowrap",
              }}
            >
              全部团队
            </button>
            {TEAMS.map((t) => {
              const active = activeIds.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  data-testid="team-filter-chip"
                  data-key={t.id}
                  data-active={active ? "true" : "false"}
                  onClick={() => toggleTeam(t.id)}
                  style={{
                    padding: `${space.xs + 2}px ${space.md}px`,
                    borderRadius: radius.pill,
                    border: `1px solid ${active ? "#2563EB" : neutral[200]}`,
                    backgroundColor: active ? "#EFF6FF" : "#FFFFFF",
                    color: active ? "#2563EB" : neutral[500],
                    fontSize: fontSize.sm,
                    fontWeight: active ? 600 : 500,
                    cursor: "pointer",
                    fontFamily: fontFamily.body,
                    whiteSpace: "nowrap",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      backgroundColor: active ? "#2563EB" : neutral[300],
                    }}
                  />
                  {t.name}
                </button>
              );
            })}
          </div>

          {/* 右侧：粒度 + 区间 */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: space.md }}>
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>粒度</span>
            <Segmented options={GRA_OPTIONS} value={granularity} onChange={setGranularity} testId="granularity-tab" />
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>区间</span>
            <Segmented options={RANGE_OPTIONS} value={range} onChange={setRange} testId="range-tab" />
          </div>
        </div>

        {/* ── 滚动主体 ── */}
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: space.xl }}>
          {/* 指标卡行：4 张，带环比 + 迷你趋势 */}
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
              delta={deltaOf(totals.tasksCreated, prev?.tasksCreated)}
              deltaTone="up-good"
              deltaHint={`对比上一个 ${RANGE_OPTIONS.find((r) => r.key === range)?.label}（${fmtInt(prev?.tasksCreated ?? 0)}）`}
              hint="口径：区间内 tasks.created_at 计数；不含归档回填"
              spark={<Sparkline values={sparkCreated} color={CHART_COLORS.tasksCreated} height={26} />}
            />
            <MetricCard
              label="已完成任务"
              value={fmtInt(totals.tasksCompleted)}
              unit="个"
              icon="✓"
              delta={deltaOf(totals.tasksCompleted, prev?.tasksCompleted)}
              deltaTone="up-good"
              deltaHint={`完成率 ${fmtPct(totals.completionRate, 0)} · 一次通过 ${fmtPct(totals.firstPassRate, 0)}`}
              hint="口径：tasks.completed_at 计数（验收通过才计完成）"
              spark={<Sparkline values={sparkCompleted} color={CHART_COLORS.tasksCompleted} height={26} />}
            />
            <MetricCard
              label="产出物"
              value={fmtInt(totals.artifacts)}
              unit="个"
              icon="▤"
              delta={deltaOf(totals.artifacts, prev?.artifacts)}
              deltaTone="up-good"
              deltaHint={`版本数 ${fmtInt(totals.artifactVersions)}（不同口径，不可相加）`}
              hint="口径：artifacts 去重个数；每产出物成本见对比表"
              spark={<Sparkline values={sparkArtifacts} color={CHART_COLORS.artifacts} height={26} />}
            />
            <MetricCard
              label="总成本"
              value={fmtMoney(totals.cost)}
              icon="$"
              tone={totals.cost === null ? "warn" : "default"}
              delta={totals.cost !== null && prev?.cost !== null && prev ? deltaOf(totals.cost, prev.cost) : null}
              deltaTone="up-bad"
              deltaHint={
                totals.costUnknownRatio > 0
                  ? `仅 ${fmtInt(totalCostKnownDays)}/${rangeDays(range)} 天有成本上报`
                  : `每任务 ${fmtMoney(totals.costPerTask)} · 每产出物 ${fmtMoney(totals.costPerArtifact)}`
              }
              hint={
                totals.cost === null
                  ? "成本未知 ≠ 0：上游（worker）未上报费用，展示「—」而非 $0.00"
                  : `缓存命中率 ${fmtPct(totals.cacheHitRate, 0)} · ${fmtCompact(tokenTotal)} tokens`
              }
              spark={<Sparkline values={sparkCost} color={CHART_COLORS.cost} height={26} />}
            />
          </div>

          {/* 主区：两列（宽屏 1.3:1，窄屏自动单列） */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: space.lg, alignItems: "flex-start" }}>
            {/* 左列 */}
            <div
              style={{
                flex: "1 1 460px",
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                gap: space.lg,
              }}
            >
              {/* ① 任务与产出趋势 */}
              <Panel
                testId="trend-panel"
                title="任务与产出趋势"
                subtitle={`粒度：${GRA_OPTIONS.find((g) => g.key === granularity)?.label} · 共 ${buckets.length} 个刻度 · 三条系列口径不同，读趋势不读绝对值`}
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
                    labels={buckets.map((b) => b.label)}
                    series={[
                      {
                        key: "created",
                        name: "新建任务（个）",
                        values: buckets.map((b) => b.totals.tasksCreated),
                        color: CHART_COLORS.tasksCreated,
                        area: true,
                      },
                      {
                        key: "completed",
                        name: "完成任务（个）",
                        values: buckets.map((b) => b.totals.tasksCompleted),
                        color: CHART_COLORS.tasksCompleted,
                      },
                      {
                        key: "artifacts",
                        name: "产出物（个）",
                        values: buckets.map((b) => b.totals.artifacts),
                        color: CHART_COLORS.artifacts,
                      },
                    ]}
                    height={210}
                    showLastValue
                    format={fmtCompact}
                    ariaLabel={`任务与产出趋势，${buckets.length} 个刻度`}
                  />
                </div>
                <div style={{ marginTop: space.sm, fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5 }}>
                  切线说明：新建与完成**不构成因果对**（完成回填的是更早期新建的任务），完成率只在足够长的区间才有意义。
                </div>
              </Panel>

              {/* ② Token 用量与成本 */}
              <Panel
                testId="token-panel"
                title="Token 用量与成本"
                subtitle="堆叠柱 = 四类 token；下方折线 = 同口径费用（未知区间留空，不补 0）"
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
                    labels={buckets.map((b) => b.label)}
                    series={[
                      {
                        key: "input",
                        name: "输入 token",
                        values: buckets.map((b) => b.totals.inputTokens),
                        color: CHART_COLORS.input,
                      },
                      {
                        key: "output",
                        name: "输出 token",
                        values: buckets.map((b) => b.totals.outputTokens),
                        color: CHART_COLORS.output,
                      },
                      {
                        key: "cacheRead",
                        name: "缓存读 token",
                        values: buckets.map((b) => b.totals.cacheReadTokens),
                        color: CHART_COLORS.cacheRead,
                      },
                      {
                        key: "cacheWrite",
                        name: "缓存写 token",
                        values: buckets.map((b) => b.totals.cacheWriteTokens),
                        color: CHART_COLORS.cacheWrite,
                      },
                    ]}
                    height={150}
                    showTotal
                    format={fmtCompact}
                    ariaLabel="token 用量堆叠柱"
                  />
                </div>

                <div style={{ marginTop: space.md }}>
                  <LineChart
                    labels={buckets.map((b) => b.label)}
                    series={[
                      {
                        key: "cost",
                        name: "成本（美元）",
                        values: buckets.map((b) => b.totals.cost),
                        color: CHART_COLORS.cost,
                        area: true,
                      },
                    ]}
                    height={96}
                    showGrid={false}
                    showLastValue
                    format={(v) => fmtMoney(v)}
                    ariaLabel="成本趋势折线"
                  />
                </div>

                {/* 成本覆盖度：已知 vs 未知天数（把「未知」这一维度本身也画出来） */}
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
                      { key: "known", name: "有成本上报", value: totalCostKnownDays, color: CHART_COLORS.cost },
                      {
                        key: "unknown",
                        name: "未知（未上报）",
                        value: Math.max(0, rangeDays(range) - totalCostKnownDays),
                        color: neutral[300],
                      },
                    ]}
                    centerValue={fmtPct(1 - totals.costUnknownRatio, 0)}
                    centerLabel="成本覆盖"
                    format={fmtInt}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: space.xs, minWidth: 0 }}>
                    <div style={{ fontSize: fontSize.sm, color: neutral[700], fontWeight: 600 }}>
                      缓存命中率 {fmtPct(totals.cacheHitRate, 1)}
                    </div>
                    <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.55, maxWidth: 300 }}>
                      命中率 = 缓存读 /（输入 + 缓存读）。分母**不含缓存写**：缓存写是成本项、不是命中收益，
                      混入会把命中率虚高。
                    </div>
                    {totals.costUnknownRatio > 0 && (
                      <div style={{ display: "inline-flex", alignItems: "center", gap: space.xs, marginTop: 2 }}>
                        <UnknownTag />
                        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                          {fmtPct(totals.costUnknownRatio, 0)} 的日行没有费用上报，成本曲线在该段留空
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>

              {/* ③ 活跃热力图 */}
              <Panel
                testId="heatmap-panel"
                title="活跃热力图"
                subtitle={`${heatCols.length} 天 × ${rollups.length} 个团队 · 格子越深 = 当天「新建任务 + 产出物」越多；虚线格 = 无数据`}
              >
                <div data-testid="heatmap">
                  <Heatmap
                    columns={heatCols}
                    rows={rollups.map((r) => ({
                      key: r.team.id,
                      name: r.team.name,
                      // 取该团队近 N 天的活跃（tasks + artifacts），长度与 heatCols 对齐
                      values: activityHeat(r.team.id).slice(-heatCols.length),
                    }))}
                    cell={7}
                    labelWidth={104}
                    columnLabelStep={Math.max(1, Math.ceil(heatCols.length / 8))}
                    ariaLabel={`活跃热力图，${rollups.length} 行 × ${heatCols.length} 列`}
                  />
                </div>
              </Panel>
            </div>

            {/* 右列 */}
            <div
              style={{
                flex: "1 1 380px",
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                gap: space.lg,
              }}
            >
              {/* ④ 团队产能排行 */}
              <Panel
                testId="rank-panel"
                title="团队产能排行"
                subtitle="同一区间内的横向比较；条长按当前维度归一"
                action={
                  <Segmented
                    options={RANK_OPTIONS}
                    value={rankDim}
                    onChange={setRankDim}
                    testId="rank-dimension"
                  />
                }
              >
                <div data-testid="rank-bar">
                  <RankBar
                    items={rankItems}
                    format={rankDim === "tokens" ? fmtCompact : fmtInt}
                    ariaLabel={`团队产能排行，维度 ${rankDim}`}
                  />
                </div>
              </Panel>

              {/* ⑥ 协作健康度 */}
              <Panel
                testId="health-panel"
                title="协作健康度"
                subtitle="效率与质量指标：看「快不快 / 顺不顺 / 返工多不多」"
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))",
                    gap: space.md,
                  }}
                >
                  {[
                    {
                      key: "cycle",
                      label: "平均交付周期",
                      value: fmtHours(totals.avgCycleHours),
                      desc: "startedAt → completedAt",
                      ratio: Math.min(1, totals.avgCycleHours / 80),
                      color: CHART_COLORS.tasksCompleted,
                    },
                    {
                      key: "queue",
                      label: "平均排队等待",
                      value: fmtHours(totals.avgQueueHours),
                      desc: "enqueuedAt → startedAt",
                      ratio: Math.min(1, totals.avgQueueHours / 40),
                      color: CHART_COLORS.cacheRead,
                    },
                    {
                      key: "review",
                      label: "评审轮次",
                      value: fmtInt(totals.reviewRounds),
                      desc: `每任务 ${(totals.tasksCreated > 0 ? totals.reviewRounds / totals.tasksCreated : 0).toFixed(1)} 轮`,
                      ratio: Math.min(1, totals.reviewRounds / Math.max(1, totals.tasksCreated * 2)),
                      color: CHART_COLORS.reasoning,
                    },
                    {
                      key: "rework",
                      label: "返工任务",
                      value: fmtInt(totals.reworkCount),
                      desc: `驳回 ${fmtInt(totals.tasksRejected)} 次`,
                      ratio: Math.min(1, totals.reworkCount / Math.max(1, totals.tasksCompleted)),
                      color: CHART_COLORS.rework,
                    },
                  ].map((h) => (
                    <div
                      key={h.key}
                      data-testid="health-card"
                      data-key={h.key}
                      style={{
                        padding: `${space.md}px ${space.md}px`,
                        border: `1px solid ${neutral[200]}`,
                        borderRadius: radius.md,
                        backgroundColor: "#FFFFFF",
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>{h.label}</div>
                      <div
                        style={{
                          fontSize: 19,
                          fontWeight: 650,
                          color: neutral[900],
                          marginTop: 2,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {h.value}
                      </div>
                      {/* 迷你条：把「相对好坏」可视化，绝对阈值写进 desc 里 */}
                      <div
                        style={{
                          marginTop: space.sm,
                          height: 4,
                          borderRadius: radius.pill,
                          backgroundColor: neutral[100],
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.max(3, h.ratio * 100)}%`,
                            height: "100%",
                            backgroundColor: h.color,
                          }}
                        />
                      </div>
                      <div style={{ fontSize: 10, color: neutral[400], marginTop: 5 }}>{h.desc}</div>
                    </div>
                  ))}
                </div>

                {/* 状态分布快照（当前盘子的任务处于什么状态，非区间口径） */}
                <div style={{ marginTop: space.lg, paddingTop: space.md, borderTop: `1px solid ${neutral[100]}` }}>
                  <div style={{ fontSize: fontSize.xs, color: neutral[500], marginBottom: space.sm }}>
                    当前状态快照（实时盘子，**非区间统计**）
                  </div>
                  <BarChart
                    mode="group"
                    labels={rollups.map((r) => r.team.name)}
                    series={[
                      {
                        key: "active",
                        name: "进行中",
                        values: rollups.map((r) =>
                          // 快照口径：只取「未完成」的活跃段（queued..pending_review）
                          r.totals.tasksQueued + r.totals.tasksBlocked,
                        ),
                        color: CHART_COLORS.tasksCreated,
                      },
                      {
                        key: "done",
                        name: "已完成（区间累计）",
                        values: rollups.map((r) => r.totals.tasksCompleted),
                        color: CHART_COLORS.tasksCompleted,
                      },
                    ]}
                    height={96}
                    format={fmtInt}
                    ariaLabel="团队状态快照分组柱"
                  />
                </div>
              </Panel>

              {/* 空态示范：当某维度无数据时的统一呈现（本页用 EmptyChart 说明规范） */}
              {buckets.length === 0 && (
                <Panel testId="empty-panel" title="空态" subtitle="该筛选组合下没有数据">
                  <EmptyChart height={120} />
                </Panel>
              )}
            </div>

          </div>

            {/* ⑤ 团队对比表 */}
            <Panel
              testId="compare-panel"
              title="团队对比"
              subtitle="点击任意行 = 下钻到该团队详情（team-stats）；数字右对齐、成本能耗比才是真正可比的分母"
              bodyStyle={{ padding: 0 }}
              flush
            >
              <div style={{ overflowX: "auto" }}>
                <table
                  data-testid="team-compare-table"
                  style={{ width: "100%", borderCollapse: "collapse", minWidth: 720, ...baseFont }}
                >
                  <thead>
                    <tr style={{ backgroundColor: neutral[50] }}>
                      {[
                        "团队",
                        "任务",
                        "完成率",
                        "产出物",
                        "Token",
                        "成本",
                        "每任务成本",
                        "每产出物成本",
                        "平均周期",
                        "一次通过",
                      ].map((h, i) => (
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
                    {rollups.map((r) => {
                      const active = selectedRow === r.team.id;
                      const costUnknown = r.totals.cost === null;
                      return (
                        <tr
                          key={r.team.id}
                          data-testid="team-compare-row"
                          data-team={r.team.id}
                          data-selected={active ? "true" : "false"}
                          onClick={() => setSelectedRow(active ? null : r.team.id)}
                          style={{
                            cursor: "pointer",
                            backgroundColor: active ? "#EFF6FF" : "transparent",
                            borderBottom: `1px solid ${neutral[100]}`,
                            transition: "background-color .12s ease",
                          }}
                        >
                          <td
                            style={{
                              padding: `${space.sm}px ${space.md}px`,
                              fontSize: fontSize.sm,
                              color: neutral[800],
                              fontWeight: active ? 600 : 500,
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span style={{ display: "inline-flex", alignItems: "center", gap: space.sm }}>
                              <span
                                aria-hidden
                                style={{
                                  width: 20,
                                  height: 20,
                                  borderRadius: radius.sm,
                                  backgroundColor: neutral[100],
                                  border: `1px solid ${neutral[200]}`,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  fontSize: 10,
                                  color: neutral[500],
                                  fontWeight: 600,
                                  flexShrink: 0,
                                }}
                              >
                                {r.team.initials}
                              </span>
                              {r.team.name}
                            </span>
                          </td>
                          <Num>{fmtInt(r.totals.tasksCreated)}</Num>
                          <Num>{fmtPct(r.totals.completionRate, 0)}</Num>
                          <Num>{fmtInt(r.totals.artifacts)}</Num>
                          <Num>{fmtCompact(totalTokensOf(r.totals))}</Num>
                          <Num>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              {fmtMoney(r.totals.cost)}
                              {(costUnknown || r.totals.costUnknownRatio > 0) && <UnknownTag />}
                            </span>
                          </Num>
                          <Num muted={costUnknown}>{fmtMoney(r.totals.costPerTask)}</Num>
                          <Num muted={costUnknown}>{fmtMoney(r.totals.costPerArtifact)}</Num>
                          <Num>{fmtHours(r.totals.avgCycleHours)}</Num>
                          <Num>{fmtPct(r.totals.firstPassRate, 0)}</Num>
                        </tr>
                      );
                    })}
                    {/* 合计行：只汇总已知成本 */}
                    <tr style={{ backgroundColor: neutral[50], fontWeight: 600 }}>
                      <td
                        style={{
                          padding: `${space.sm}px ${space.md}px`,
                          fontSize: fontSize.sm,
                          color: neutral[700],
                          whiteSpace: "nowrap",
                        }}
                      >
                        合计（{rollups.length} 个团队）
                      </td>
                      <Num>{fmtInt(sumTasksCreated)}</Num>
                      <Num>{sumTasksCreated > 0 ? fmtPct(sumTasksCompleted / sumTasksCreated, 0) : "—"}</Num>
                      <Num>{fmtInt(sumArtifacts)}</Num>
                      <Num>{fmtCompact(sumTokens)}</Num>
                      <Num>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          {fmtMoney(knownCostSum)}
                          {hasUnknownCost && <UnknownTag title="合计仅含已知成本，未知团队未计入" />}
                        </span>
                      </Num>
                      <Num>—</Num>
                      <Num>—</Num>
                      <Num>—</Num>
                      <Num>—</Num>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div
                style={{
                  padding: `${space.sm}px ${space.md}px`,
                  fontSize: fontSize.xs,
                  color: neutral[400],
                  lineHeight: 1.55,
                  borderTop: `1px solid ${neutral[100]}`,
                }}
              >
                合计行的成本是**已知部分之和**（有团队成本未知，故不等于真实总额）；
                「每任务/每产出物成本」与比率类指标不做跨团队加总（加总无意义）。
              </div>
            </Panel>
        </div>

          {/* ── 口径脚注（三条最容易被误读的口径必须写在页面上，而不是只写在文档里） ── */}
          <div
            style={{
              marginTop: space.lg,
              padding: `${space.md}px ${space.lg}px`,
              border: `1px dashed ${neutral[300]}`,
              borderRadius: radius.md,
              backgroundColor: "#FFFFFF",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              ...baseFont,
            }}
          >
            <div style={{ fontSize: fontSize.xs, fontWeight: 600, color: neutral[600] }}>口径说明（三条必读）</div>
            <div style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6 }}>
              ① <strong>未知 ≠ 0</strong>：成本列为空表示上游（worker）未上报，显示「—」；显示 $0.00 会让「没统计到」被误读为「不花钱」。
              <br />② <strong>去重产出物 ≠ 版本数</strong>：同一产出物改 3 版 = 1 个 artifact + 3 个 version，两个数不可相加。
              <br />③ <strong>区间含头不含尾 + Asia/Shanghai 日切</strong>；环比一律对比「上一个等长区间」，任务完成回填的是更早期新建的任务。
            </div>
          </div>

      </div>

      {/* 左侧 Dock 悬浮导航条：activeKey="stats"，展开面板放本期快照 */}
      <NavDock activeKey="stats" onNavClick={() => undefined}>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs + 2 }}>
          <div
            style={{
              fontSize: fontSize.xs,
              fontWeight: 600,
              color: neutral[400],
              letterSpacing: ".04em",
            }}
          >
            本期快照
          </div>
          {[
            { label: "新建任务", value: fmtInt(totals.tasksCreated), color: CHART_COLORS.tasksCreated },
            { label: "已完成", value: fmtInt(totals.tasksCompleted), color: CHART_COLORS.tasksCompleted },
            { label: "产出物", value: fmtInt(totals.artifacts), color: CHART_COLORS.artifacts },
            { label: "Token", value: fmtCompact(tokenTotal), color: CHART_COLORS.cacheRead },
            { label: "成本", value: fmtMoney(totals.cost), color: CHART_COLORS.cost },
            { label: "活跃团队", value: `${rollups.length}`, color: neutral[400] },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.xs}px 0`,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  backgroundColor: s.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: fontSize.sm, color: neutral[600] }}>{s.label}</span>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: fontSize.sm,
                  color: neutral[800],
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {s.value}
              </span>
            </div>
          ))}
          <div
            style={{
              marginTop: space.xs,
              paddingTop: space.sm,
              borderTop: `1px solid ${neutral[200]}`,
              fontSize: 10,
              color: neutral[400],
              lineHeight: 1.5,
            }}
          >
            环比：{prev ? `+${fmtSignedPct(deltaOf(totals.tasksCreated, prev.tasksCreated)).replace("+", "")}` : "—"}
            <br />
            {RANGE_OPTIONS.find((r) => r.key === range)?.label} · {GRA_OPTIONS.find((g) => g.key === granularity)?.label}粒度
          </div>
        </div>
      </NavDock>

      {/* Cmd+K 命令面板：受控开关（✕ / 遮罩 / Esc 关闭） */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMD_ITEMS} />
    </div>
  );
}

export default {
  meta: {
    id: "stats-dashboard",
    name: "统计看板（全局）",
    group: "统计",
    description:
      "跨团队统计看板：日/周/月粒度的任务量、产出物、Token 与成本，叠加效率/质量/协作/成本健康度与团队对比、活跃热力",
    device: "desktop",
  },
  Component: StatsDashboardPage,
} satisfies PrototypeDef;
