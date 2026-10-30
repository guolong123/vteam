/**
 * 原型：团队统计详情（下钻页）— device: desktop
 * =====================================================================
 * 从全局看板 `stats-dashboard` 的「团队对比表」点击某团队行后落地到这里，
 * 展示**单个团队**在日/周/月粒度上的任务、产出物、token、成本，以及效率/质量/协作四类维度。
 *
 * 与全局看板的差别（信息层级刻意不同，避免两页只是「多一个下拉」）：
 * - 全局看板回答「**哪个团队**更好」；本页回答「**这个团队为什么是这个数**」。
 * - 故本页有生命周期漏斗、周期分布、产出物构成、成员产能表、质量指标 —— 全部是**团队内部分解**。
 * - 本页所有数字同样来自 `_shared/stats-data.ts`，且与全局看板**同源可对账**
 *   （同一团队同一区间，两页的「任务数 / 产出物 / token / 成本」必然一致）。
 *
 * T15 铁律（与 task-board 一致）：root `height:100%; position:relative`，
 * 所有浮层 absolute，**零 fixed / 100vh / 100vw**；内容区 paddingLeft 80 避让 Dock。
 *
 * 语义红线（页面上必须有可见交代，不能只写在文档里）：
 * - **未知 ≠ 0**：`cost === null` = 上游未上报，显示「—」+「未知」标；绝不渲染 $0.00。
 * - **去重产出物 ≠ 版本数**：`artifacts` 与 `artifactVersions` 是两个口径，不可相加。
 * - 区间含头不含尾、Asia/Shanghai 日切；环比对比上一个等长区间。
 */

import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import { AgentAvatar, AgentBadge, EmptyState } from "../_shared/components";
import { neutral, space, radius, fontSize, fontFamily, shadow, roles } from "../_shared/styles";
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
  fmtInt,
  fmtCompact,
  fmtMoney,
  fmtPct,
  fmtHours,
  CHART_COLORS,
} from "../_shared/charts";
import {
  TEAMS,
  getTeam,
  windowOf,
  aggregate,
  bucketize,
  rangeDays,
  dailyOf,
  deltaRate,
  snapshotOf,
  funnelOf,
  artifactMixOf,
  memberSummaries,
  heatDates,
  activityHeat,
} from "../_shared/stats-data";
import type { Granularity, RangeKey, Totals } from "../_shared/stats-data";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起宽度（与 _shared/nav.tsx 的 RAIL_W 一致）。 */
const RAIL_W = 56;

/* ============================ 数据派生 ============================ */

/** 上一等长区间的团队合计（环比分母；不足一个区间时为 null ⇒ 「—」）。 */
function prevTotals(teamId: string, range: RangeKey): Totals | null {
  const days = rangeDays(range);
  const all = dailyOf(teamId);
  const prev = all.slice(Math.max(0, all.length - days * 2), all.length - days);
  return prev.length === days ? aggregate(prev) : null;
}

/** 六个 token 口径之和。 */
function totalTokensOf(t: Totals): number {
  return t.inputTokens + t.outputTokens + t.reasoningTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

/* ============================ 小控件 ============================ */

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
              whiteSpace: "nowrap",
              transition: "background-color .15s ease, color .15s ease",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** 「成本未知」小标：与「免费」在视觉上必须能区分。 */
function UnknownTag({ title = "上游未上报成本（未知 ≠ 0）" }: { title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
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

function Num({
  children,
  muted,
  strong,
}: {
  children: React.ReactNode;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <td
      style={{
        padding: `${space.sm}px ${space.md}px`,
        textAlign: "right",
        fontSize: fontSize.sm,
        color: muted ? neutral[400] : strong ? neutral[900] : neutral[700],
        fontWeight: strong ? 600 : 400,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}

const CMD_ITEMS: CmdKItem[] = [
  { group: "导航", label: "统计看板", icon: "▦", hint: "返回全局跨团队看板" },
  { group: "导航", label: "任务看板", icon: "☰", hint: "查看任务状态分布" },
  { group: "维度", label: "切换团队", icon: "◫", hint: "4 个团队可切换" },
  { group: "导出", label: "导出本团队报表", icon: "⤓", hint: "当前筛选口径" },
];

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

/* ============================ 页面 ============================ */

function TeamStatsPage() {
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [teamId, setTeamId] = useState<string>(TEAMS[0].id);
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [range, setRange] = useState<RangeKey>("30d");

  /* ---- 取数（团队切换 / 粒度 / 区间切换后全部真实重算） ---- */
  const team = getTeam(teamId);
  const rows = windowOf(teamId, range);
  const totals = aggregate(rows);
  const prev = prevTotals(teamId, range);
  const buckets = bucketize(rows, granularity);
  const dailyBuckets = bucketize(rows, "day");
  const snapshot = snapshotOf(teamId, range);
  const funnel = funnelOf(teamId, range);
  const mix = artifactMixOf(teamId, range);
  const members = memberSummaries(teamId, range);
  const heatCols = heatDates().slice(-rangeDays(range));
  const heatValues = activityHeat(teamId).slice(-rangeDays(range));

  const tokenTotal = totalTokensOf(totals);
  const knownDays = Math.round((1 - totals.costUnknownRatio) * rangeDays(range));
  const costUnknown = totals.cost === null;

  /* ---- 成员表合计（只对已知成本求和） ---- */
  const memberTasks = members.reduce((a, m) => a + m.tasks, 0);
  const memberArtifacts = members.reduce((a, m) => a + m.artifacts, 0);
  const memberTokens = members.reduce((a, m) => a + m.totalTokens, 0);
  const memberMessages = members.reduce((a, m) => a + m.messages, 0);
  const memberKnownCost = members.reduce((a, m) => a + (m.cost ?? 0), 0);
  const anyMemberCostUnknown = members.some((m) => m.cost === null);

  /** 团队成员头像组：按角色真实取值（同名角色多实例都画出来）。 */
  const avatars = team.members.map((m) => (
    <div key={m.id} style={{ marginLeft: -6 }} title={`${m.alias}（${roles[m.role].label}）`}>
      <AgentAvatar role={m.role} initials={[...m.alias][0]} size="sm" />
    </div>
  ));

  return (
    <div
      data-testid="team-stats"
      style={{
        height: "100%",
        minHeight: 720,
        position: "relative",
        backgroundColor: neutral[100],
        ...baseFont,
      }}
    >
      {/* 顶栏：面包屑随切换器变化（面包屑 = 返回入口，比标题更符合「下钻」语义） */}
      <NavTopBar
        breadcrumb={["统计看板", team.name]}
        userName="运营者"
        userRole="团队成员"
        onCmdKClick={() => setCmdkOpen(true)}
      />

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
        {/* ── 控制条：团队切换 + 粒度 + 区间 ── */}
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
          <div data-testid="team-switcher" style={{ display: "flex", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}>
            <span style={{ fontSize: fontSize.xs, color: neutral[400], marginRight: 2 }}>团队</span>
            {TEAMS.map((t) => {
              const active = t.id === teamId;
              return (
                <button
                  key={t.id}
                  type="button"
                  data-testid="team-switcher-option"
                  data-key={t.id}
                  data-active={active ? "true" : "false"}
                  onClick={() => setTeamId(t.id)}
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
                  }}
                >
                  {t.name}
                </button>
              );
            })}
          </div>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: space.md }}>
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>粒度</span>
            <Segmented options={GRA_OPTIONS} value={granularity} onChange={setGranularity} testId="granularity-tab" />
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>区间</span>
            <Segmented options={RANGE_OPTIONS} value={range} onChange={setRange} testId="range-tab" />
          </div>
        </div>

        {/* ── 滚动主体 ── */}
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: space.xl }}>
          {/* 概览条：团队身份 + 当前盘子 + 健康度 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.lg,
              flexWrap: "wrap",
              padding: `${space.md}px ${space.lg}px`,
              marginBottom: space.lg,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
              borderRadius: radius.lg,
              boxShadow: shadow.sm,
            }}
          >
            <div
              aria-hidden
              style={{
                width: 42,
                height: 42,
                borderRadius: radius.md,
                backgroundColor: "#EFF6FF",
                border: "1px solid #BFDBFE",
                color: "#2563EB",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: fontSize.lg,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {team.initials}
            </div>

            <div style={{ minWidth: 0, flex: "1 1 220px" }}>
              <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>{team.name}</div>
              <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: 2, lineHeight: 1.5 }}>
                {team.description}
              </div>
            </div>

            {/* 成员头像组 */}
            <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center" }}>{avatars}</div>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{team.members.length} 名成员</span>
            </div>

            {/* 当前任务 / 队列 */}
            <div style={{ display: "flex", gap: space.xl, flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>当前任务</div>
                <div style={{ fontSize: fontSize.sm, color: neutral[800], fontWeight: 500, marginTop: 1 }}>
                  {team.currentTask}
                </div>
              </div>
              <div>
                <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>队列</div>
                <div
                  style={{
                    fontSize: fontSize.sm,
                    color: neutral[800],
                    fontWeight: 600,
                    marginTop: 1,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {team.queueLength} 个排队中
                </div>
              </div>
            </div>

            {/* 健康度：环形 + 一句口径（分数口径写清楚，避免被当成官方 KPI） */}
            <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexShrink: 0 }}>
              <DonutChart
                testId="health-donut"
                size={62}
                thickness={0.34}
                slices={[
                  { key: "ok", name: "健康", value: snapshot.healthScore, color: CHART_COLORS.tasksCompleted },
                  {
                    key: "gap",
                    name: "缺口",
                    value: Math.max(0, 100 - snapshot.healthScore),
                    color: neutral[200],
                  },
                ]}
                centerValue={`${snapshot.healthScore}`}
                format={(v) => `${Math.round(v)}`}
              />
              <div>
                <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>健康度</div>
                <div style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.45, maxWidth: 130 }}>
                  完成率 46% + 一次通过 26% + 周期 18% + 阻塞 10% 加权
                </div>
              </div>
            </div>
          </div>

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
              delta={deltaRate(totals.tasksCreated, prev?.tasksCreated)}
              deltaTone="up-good"
              deltaHint={`完成 ${fmtInt(totals.tasksCompleted)} 个`}
              hint="口径：区间内新建（tasks.created_at）"
              spark={<Sparkline values={dailyBuckets.map((b) => b.totals.tasksCreated)} color={CHART_COLORS.tasksCreated} height={24} />}
            />
            <MetricCard
              label="完成率"
              value={fmtPct(totals.completionRate, 0)}
              icon="✓"
              delta={deltaRate(totals.tasksCompleted, prev?.tasksCompleted)}
              deltaTone="up-good"
              deltaHint={`对比上一区间（完成 ${fmtInt(prev?.tasksCompleted ?? 0)}）`}
              hint="= 完成 / 新建；短区间有滞后，读长期"
              spark={<Sparkline values={dailyBuckets.map((b) => b.totals.tasksCompleted)} color={CHART_COLORS.tasksCompleted} height={24} />}
            />
            <MetricCard
              label="产出物"
              value={fmtInt(totals.artifacts)}
              unit="个"
              icon="▤"
              delta={deltaRate(totals.artifacts, prev?.artifacts)}
              deltaTone="up-good"
              deltaHint={`版本数 ${fmtInt(totals.artifactVersions)}（不可相加）`}
              hint="口径：artifact 去重个数"
              spark={<Sparkline values={dailyBuckets.map((b) => b.totals.artifacts)} color={CHART_COLORS.artifacts} height={24} />}
            />
            <MetricCard
              label="Token 总量"
              value={fmtCompact(tokenTotal)}
              unit="tokens"
              icon="◈"
              delta={deltaRate(tokenTotal, prev ? totalTokensOf(prev) : null)}
              deltaTone="neutral"
              deltaHint={`命中率 ${fmtPct(totals.cacheHitRate, 0)}`}
              hint="六元组求和（输入+输出+推理+缓存读写）"
              spark={<Sparkline values={dailyBuckets.map((b) => totalTokensOf(b.totals))} color={CHART_COLORS.cacheRead} height={24} />}
            />
            <MetricCard
              label="成本"
              value={fmtMoney(totals.cost)}
              icon="$"
              tone={costUnknown ? "warn" : "default"}
              delta={costUnknown || prev?.cost === null || !prev ? null : deltaRate(totals.cost ?? 0, prev.cost)}
              deltaTone="up-bad"
              deltaHint={costUnknown ? "上游未上报（未知 ≠ 免费）" : `仅 ${knownDays}/${rangeDays(range)} 天有上报`}
              hint={
                costUnknown
                  ? "该团队整个窗口都没有费用上报，故显示「—」"
                  : `每任务 ${fmtMoney(totals.costPerTask)}`
              }
              spark={<Sparkline values={dailyBuckets.map((b) => b.totals.cost ?? 0)} color={CHART_COLORS.cost} height={24} />}
            />
            <MetricCard
              label="每产出物成本"
              value={fmtMoney(totals.costPerArtifact)}
              icon="◎"
              tone={totals.costPerArtifact === null ? "warn" : "default"}
              delta={null}
              deltaHint={
                // 每千 token 成本是「分级敏感」的指标：$0.0024 用 fmtMoney 会被切成 $0.00（看起来像免费）。
                // 故这里用 3 位小数单独格式化，未知时仍是「—」。
                totals.costPerKToken === null
                  ? "每千 token —"
                  : `每千 token $${totals.costPerKToken.toFixed(3)}`
              }
              hint="= 成本 / 去重产出物数；成本未知时为空"
            />
          </div>

          {/* 主区：两列 */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: space.lg, alignItems: "flex-start" }}>
            {/* 左列 */}
            <div style={{ flex: "1 1 430px", minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
              {/* ① 任务生命周期漏斗 */}
              <Panel
                testId="funnel-panel"
                title="任务生命周期漏斗"
                subtitle={`区间内进入各阶段的任务数 · ${RANGE_OPTIONS.find((r) => r.key === range)?.label}`}
              >
                <div data-testid="funnel">
                  <Funnel
                    stages={funnel.map((s) => ({
                      key: s.status,
                      name: s.label,
                      value: s.value,
                      retention: s.retention,
                      color:
                        s.status === "completed"
                          ? CHART_COLORS.tasksCompleted
                          : s.status === "pending_review"
                            ? CHART_COLORS.reasoning
                            : s.status === "in_progress"
                              ? CHART_COLORS.tasksCreated
                              : s.status === "pending"
                                ? CHART_COLORS.cacheRead
                                : neutral[400],
                    }))}
                    format={fmtInt}
                  />
                </div>
                <div
                  style={{
                    marginTop: space.md,
                    paddingTop: space.sm,
                    borderTop: `1px solid ${neutral[100]}`,
                    fontSize: fontSize.xs,
                    color: neutral[400],
                    lineHeight: 1.55,
                  }}
                >
                  阶段口径：进入排队 → 待开始 → 进行中 → 待验收 → 已完成，逐级留存率标在右侧；
                  真实实现按 `task_events.to_status` **按任务去重**计数（同一任务多次驳回只计一次）。
                </div>
              </Panel>

              {/* ② 交付周期分布 */}
              <Panel
                testId="cycle-panel"
                title="交付周期分布"
                subtitle="按当前粒度分桶 · 平均周期 vs P90（P90 取桶内日最大值，偏保守）"
                action={
                  <Legend
                    items={[
                      { name: "平均周期", color: CHART_COLORS.tasksCompleted },
                      { name: "P90", color: CHART_COLORS.reasoning },
                    ]}
                  />
                }
              >
                <div data-testid="cycle-chart">
                  <BarChart
                    mode="group"
                    labels={buckets.map((b) => b.label)}
                    series={[
                      {
                        key: "avg",
                        name: "平均周期（小时）",
                        values: buckets.map((b) => b.totals.avgCycleHours),
                        color: CHART_COLORS.tasksCompleted,
                      },
                      {
                        key: "p90",
                        name: "P90（小时）",
                        values: buckets.map((b) => b.totals.cycleHoursP90),
                        color: CHART_COLORS.reasoning,
                      },
                    ]}
                    height={150}
                    format={(v) => `${v.toFixed(0)}h`}
                    ariaLabel="交付周期分布分组柱"
                  />
                </div>
              </Panel>

              {/* ③ 产出物构成 */}
              <Panel
                testId="artifact-panel"
                title="产出物构成"
                subtitle="按类型拆分（去重口径）；版本数是另一个口径，不可相加"
                action={
                  <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                    版本 {fmtInt(totals.artifactVersions)}
                  </span>
                }
              >
                <div data-testid="artifact-donut">
                  <DonutChart
                    slices={mix.map((m) => ({
                      key: m.type,
                      name: m.label,
                      value: m.value,
                      color:
                        m.type === "text"
                          ? CHART_COLORS.tasksCreated
                          : m.type === "doc"
                            ? CHART_COLORS.artifacts
                            : CHART_COLORS.reasoning,
                    }))}
                    centerValue={fmtInt(totals.artifacts)}
                    centerLabel="去重产出物"
                    format={fmtInt}
                  />
                </div>
                <div style={{ marginTop: space.md, fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.55 }}>
                  每任务产出 {totals.tasksCompleted > 0 ? (totals.artifacts / totals.tasksCompleted).toFixed(2) : "—"} 个；
                  文件/代码类产出通常带更多版本迭代。
                </div>
              </Panel>

              {/* ④ 每日活跃热力 */}
              <Panel
                testId="active-heatmap-panel"
                title="每日活跃热力"
                subtitle={`该团队近 ${rangeDays(range)} 天 · 格子越深 = 当天「新建任务 + 产出物」越多；虚线 = 无数据`}
              >
                <div data-testid="active-heatmap">
                  <Heatmap
                    columns={heatCols}
                    rows={[{ key: teamId, name: team.name, values: heatValues }]}
                    cell={8}
                    labelWidth={92}
                    columnLabelStep={Math.max(1, Math.ceil(heatCols.length / 8))}
                    ariaLabel="团队每日活跃热力图"
                  />
                </div>
              </Panel>
            </div>

            {/* 右列 */}
            <div style={{ flex: "1 1 400px", minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
              {/* ⑤ Token 与成本趋势 */}
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
                    labels={buckets.map((b) => b.label)}
                    series={[
                      {
                        key: "input",
                        name: "输入 token",
                        values: buckets.map((b) => b.totals.inputTokens),
                        color: CHART_COLORS.input,
                        area: true,
                      },
                      {
                        key: "output",
                        name: "输出 token",
                        values: buckets.map((b) => b.totals.outputTokens),
                        color: CHART_COLORS.output,
                      },
                    ]}
                    height={118}
                    showLastValue
                    format={fmtCompact}
                    ariaLabel="输入输出 token 趋势"
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
                    height={80}
                    showGrid={false}
                    showLastValue={!costUnknown}
                    format={(v) => fmtMoney(v)}
                    ariaLabel="成本趋势折线"
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
                    <div style={{ fontSize: fontSize.xs, color: neutral[500], marginBottom: space.xs }}>
                      缓存读写构成
                    </div>
                    <StackedBar
                      height={12}
                      segments={[
                        { key: "cacheRead", name: "缓存读", value: totals.cacheReadTokens, color: CHART_COLORS.cacheRead },
                        {
                          key: "cacheWrite",
                          name: "缓存写",
                          value: totals.cacheWriteTokens,
                          color: CHART_COLORS.cacheWrite,
                        },
                        { key: "input", name: "输入", value: totals.inputTokens, color: CHART_COLORS.input },
                      ]}
                    />
                    <div style={{ display: "flex", gap: space.md, marginTop: 5, flexWrap: "wrap" }}>
                      <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                        缓存读 {fmtCompact(totals.cacheReadTokens)}
                      </span>
                      <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                        缓存写 {fmtCompact(totals.cacheWriteTokens)}
                      </span>
                      <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                        输入 {fmtCompact(totals.inputTokens)}
                      </span>
                    </div>
                  </div>

                  <DonutChart
                    testId="cache-hit-donut"
                    size={78}
                    thickness={0.34}
                    slices={[
                      {
                        key: "hit",
                        name: "缓存命中",
                        value: Math.round(totals.cacheHitRate * 100),
                        color: CHART_COLORS.cacheRead,
                      },
                      {
                        key: "miss",
                        name: "未命中",
                        value: 100 - Math.round(totals.cacheHitRate * 100),
                        color: neutral[200],
                      },
                    ]}
                    centerValue={fmtPct(totals.cacheHitRate, 0)}
                    format={(v) => `${Math.round(v)}%`}
                  />
                </div>
                <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.55, marginTop: space.sm }}>
                  命中率 = 缓存读 /（输入 + 缓存读）。分母不含缓存写：写缓存是成本项，计入会把命中率虚高。
                </div>
              </Panel>

              {/* ⑥ 质量与协作 */}
              <Panel
                testId="quality-panel"
                title="质量与协作"
                subtitle="一次通过率 / 评审轮次 / 返工 / 阻塞：回答「快但反复返工吗」"
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(136px, 1fr))",
                    gap: space.md,
                  }}
                >
                  {[
                    {
                      key: "firstpass",
                      label: "一次通过率",
                      value: fmtPct(totals.firstPassRate, 1),
                      desc: "完成且无驳回",
                      spark: dailyBuckets.map(
                        (b) =>
                          b.totals.tasksCompleted > 0
                            ? Math.max(0, b.totals.tasksCompleted - b.totals.reworkCount) / b.totals.tasksCompleted
                            : 0,
                      ),
                      color: CHART_COLORS.tasksCompleted,
                    },
                    {
                      key: "review",
                      label: "评审轮次",
                      value: fmtInt(totals.reviewRounds),
                      desc: `每任务 ${(totals.tasksCreated > 0 ? totals.reviewRounds / totals.tasksCreated : 0).toFixed(1)} 轮`,
                      spark: dailyBuckets.map((b) => b.totals.reviewRounds),
                      color: CHART_COLORS.reasoning,
                    },
                    {
                      key: "rework",
                      label: "返工任务",
                      value: fmtInt(totals.reworkCount),
                      desc: `驳回 ${fmtInt(totals.tasksRejected)} 次`,
                      spark: dailyBuckets.map((b) => b.totals.reworkCount),
                      color: CHART_COLORS.rework,
                    },
                    {
                      key: "blocked",
                      label: "平均阻塞时长",
                      value: fmtHours(totals.avgBlockedHours),
                      desc: `阻塞 ${fmtInt(totals.tasksBlocked)} 次`,
                      spark: dailyBuckets.map((b) => b.totals.blockedHours),
                      color: "#EF4444",
                    },
                  ].map((q) => (
                    <div
                      key={q.key}
                      data-testid="quality-card"
                      data-key={q.key}
                      style={{
                        padding: `${space.md}px ${space.md}px`,
                        border: `1px solid ${neutral[200]}`,
                        borderRadius: radius.md,
                        backgroundColor: "#FFFFFF",
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>{q.label}</div>
                      <div
                        style={{
                          fontSize: 19,
                          fontWeight: 650,
                          color: neutral[900],
                          marginTop: 2,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {q.value}
                      </div>
                      <Sparkline values={q.spark} color={q.color} height={22} />
                      <div style={{ fontSize: 10, color: neutral[400], marginTop: 2 }}>{q.desc}</div>
                    </div>
                  ))}
                </div>
              </Panel>

              {/* ⑦ 成员产能表 */}
              <Panel
                testId="member-panel"
                title="成员产能"
                subtitle="按 Token 降序；成本未知时成员侧同样显示「—」（不拆解散步，避免伪造「某成员免费」）"
                flush
                bodyStyle={{ padding: 0 }}
              >
                <div style={{ overflowX: "auto" }}>
                  <table
                    data-testid="member-table"
                    style={{ width: "100%", borderCollapse: "collapse", minWidth: 520, ...baseFont }}
                  >
                    <thead>
                      <tr style={{ backgroundColor: neutral[50] }}>
                        {["成员", "任务", "产出物", "Token", "成本", "消息", "活跃率"].map((h, i) => (
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
                      {members.map((m) => (
                        <tr key={m.memberId} data-testid="member-table-row" data-member={m.memberId}>
                          <td
                            style={{
                              padding: `${space.sm}px ${space.md}px`,
                              fontSize: fontSize.sm,
                              color: neutral[800],
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span style={{ display: "inline-flex", alignItems: "center", gap: space.sm }}>
                              <AgentAvatar role={m.role} initials={[...m.alias][0]} size="sm" dot={false} />
                              {m.alias}
                            </span>
                          </td>
                          <Num>{fmtInt(m.tasks)}</Num>
                          <Num>{fmtInt(m.artifacts)}</Num>
                          <Num>{fmtCompact(m.totalTokens)}</Num>
                          <Num muted={m.cost === null}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              {fmtMoney(m.cost)}
                              {m.cost === null && <UnknownTag />}
                            </span>
                          </Num>
                          <Num>{fmtInt(m.messages)}</Num>
                          <Num>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}>
                              <span
                                style={{
                                  width: 34,
                                  height: 4,
                                  borderRadius: radius.pill,
                                  backgroundColor: neutral[100],
                                  overflow: "hidden",
                                  display: "inline-block",
                                }}
                              >
                                <span
                                  style={{
                                    display: "block",
                                    width: `${Math.max(2, m.activeRate * 100)}%`,
                                    height: "100%",
                                    backgroundColor: roles[m.role].color,
                                  }}
                                />
                              </span>
                              {fmtPct(m.activeRate, 0)}
                            </span>
                          </Num>
                        </tr>
                      ))}
                      {/* 合计行：与团队总量对账（Token/任务/产出物必须等于顶部卡片） */}
                      <tr style={{ backgroundColor: neutral[50] }}>
                        <td
                          style={{
                            padding: `${space.sm}px ${space.md}px`,
                            fontSize: fontSize.sm,
                            fontWeight: 600,
                            color: neutral[700],
                            whiteSpace: "nowrap",
                          }}
                        >
                          成员合计
                        </td>
                        <Num strong>{fmtInt(memberTasks)}</Num>
                        <Num strong>{fmtInt(memberArtifacts)}</Num>
                        <Num strong>{fmtCompact(memberTokens)}</Num>
                        <Num strong={!anyMemberCostUnknown}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            {fmtMoney(anyMemberCostUnknown ? (memberKnownCost > 0 ? memberKnownCost : null) : memberKnownCost)}
                            {anyMemberCostUnknown && <UnknownTag title="合计仅含已知成本" />}
                          </span>
                        </Num>
                        <Num strong>{fmtInt(memberMessages)}</Num>
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
                    borderTop: `1px solid ${neutral[100]}`,
                    lineHeight: 1.55,
                  }}
                >
                  成员任务数之和 ({fmtInt(memberTasks)}) 与顶部「任务数」({fmtInt(totals.tasksCreated)})
                  {memberTasks === totals.tasksCreated ? "一致" : "不一致（多实例分摊口径不同，真实实现需在契约里明确）"}；
                  Token 之和 ({fmtCompact(memberTokens)}) 与顶部 Token 卡同一口径。
                </div>
              </Panel>
            </div>
          </div>

          {/* 空态示范（当该团队窗口内完全没有数据时）：用共享 EmptyState，保持与仓库其它页面一致 */}
          {rows.every((r) => r.tasksCreated === 0 && r.artifacts === 0 && r.agentMessages === 0) && (
            <Panel testId="empty-panel" title="该区间没有产出" subtitle="换区间、或等团队开始接活">
              <EmptyState
                title="没有可统计的活动"
                description="该团队在这个区间内没有任务、产出物与消息。换一个区间或切换到别的团队。"
              />
            </Panel>
          )}

          {/* 口径脚注 */}
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
              ① <strong>未知 ≠ 0</strong>：成本为空是上游未上报，显示「—」；$0.00 会把「没统计到」误读为「不花钱」。
              <br />② <strong>去重产出物 ≠ 版本数</strong>：同一产出物改 3 版 = 1 个 artifact + 3 个 version。
              <br />③ <strong>区间含头不含尾 + Asia/Shanghai 日切</strong>；环比对比上一个等长区间，完成数回填的是更早期新建的任务。
            </div>
          </div>
        </div>
      </div>

      {/* 左侧 Dock：activeKey="stats"，展开面板放本团队快照 */}
      <NavDock activeKey="stats" projectName={team.name} onNavClick={() => undefined}>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs + 2 }}>
          <div
            style={{
              fontSize: fontSize.xs,
              fontWeight: 600,
              color: neutral[400],
              letterSpacing: ".04em",
            }}
          >
            本团队快照
          </div>
          {[
            { label: "新建任务", value: fmtInt(totals.tasksCreated), color: CHART_COLORS.tasksCreated },
            { label: "已完成", value: fmtInt(totals.tasksCompleted), color: CHART_COLORS.tasksCompleted },
            { label: "产出物", value: fmtInt(totals.artifacts), color: CHART_COLORS.artifacts },
            { label: "Token", value: fmtCompact(tokenTotal), color: CHART_COLORS.cacheRead },
            { label: "成本", value: fmtMoney(totals.cost), color: CHART_COLORS.cost },
            { label: "健康度", value: `${snapshot.healthScore}`, color: CHART_COLORS.tasksCompleted },
          ].map((s) => (
            <div key={s.label} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.xs}px 0` }}>
              <span
                aria-hidden
                style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: s.color, flexShrink: 0 }}
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
            {team.members.length} 名成员 · {RANGE_OPTIONS.find((r) => r.key === range)?.label}
            <br />
            {GRA_OPTIONS.find((g) => g.key === granularity)?.label}粒度
          </div>
        </div>
      </NavDock>

      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMD_ITEMS} />
    </div>
  );
}

export default {
  meta: {
    id: "team-stats",
    name: "团队统计详情",
    group: "统计",
    description:
      "单团队统计详情：生命周期漏斗、交付周期分布、产出物构成、成员产能、Token/成本趋势、质量与协作、每日活跃热力",
    device: "desktop",
  },
  Component: TeamStatsPage,
} satisfies PrototypeDef;
