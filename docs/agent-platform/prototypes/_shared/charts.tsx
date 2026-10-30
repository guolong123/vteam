/**
 * 统计看板图表原语（纯 SVG，零第三方依赖）
 * =====================================================================
 * 供 stats-dashboard / team-stats 两个原型复用，也供后续真实前端实现时对照。
 * 为什么不引图表库：md-docs 原型的依赖解析走 `@md-docs` 与 md-docs 自身 node_modules，
 * 运行目录（vteam 仓库）并未安装 recharts/echarts；而原型只需要「看得出形状」的视觉稿，
 * 手写 SVG 反而让 token、间距、配色与 _shared/styles.ts 完全一致，且构建零风险。
 *
 * 统一约定（写新图表时请遵守，否则视觉会散）：
 * - 几何：`viewBox` + CSS 宽度 100% ⇒ 容器宽度变化时自动缩放，不做 resize 监听；
 *   `preserveAspectRatio="none"` 只用于面积/柱状这类「允许纵向拉伸」的图形，
 *   文字与折线点用 `xMidYMid meet` 的独立 svg 叠层或按比例换算，避免字被拉扁。
 * - 配色：一律取自 ./styles.ts 的 roles / neutral / statusColors，不在此文件写死新色值
 *   （唯一例外是图表专用色板 CHART_COLORS，它是对既有 token 的**有序引用**）。
 * - 空数据：任何图表 data 为空都必须渲染统一空态（EmptyChart），不允许画半张空轴。
 * - 可访问性：每个图表根节点带 data-testid + role="img" + aria-label。
 */
import type { CSSProperties, ReactNode } from "react";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "./styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ============================================================
 * 一、格式化（页面统一从这里取，避免各处各写一套 toFixed）
 * ============================================================ */

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

export function fmtMoney(n: number | null | undefined, currency = "$"): string {
  if (n === null || n === undefined) return "—";
  if (Math.abs(n) >= 1000) return `${currency}${(n / 1000).toFixed(2)}K`;
  return `${currency}${n.toFixed(2)}`;
}

export function fmtPct(r: number | null | undefined, digits = 1): string {
  if (r === null || r === undefined) return "—";
  return `${(r * 100).toFixed(digits)}%`;
}

export function fmtSignedPct(r: number | null | undefined, digits = 1): string {
  if (r === null || r === undefined) return "—";
  const s = (r * 100).toFixed(digits);
  return `${r >= 0 ? "+" : ""}${s}%`;
}

export function fmtHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return "—";
  return h >= 24 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
}

/* ============================================================
 * 二、图表色板（对既有 token 的有序引用，语义化命名）
 * ============================================================ */

/** 折线 / 柱状 / 环形共用的分类色板（顺序固定 ⇒ 同系列在多图里颜色一致）。 */
export const CHART_COLORS = {
  tasksCreated: "#3B82F6", // = roles.product.color 蓝
  tasksCompleted: "#10B981", // = roles.developer.color 绿
  artifacts: "#8B5CF6", // = roles.architect.color 紫
  artifactVersions: "#A78BFA", // 紫浅一档（去重 vs 版本口径）
  input: "#3B82F6",
  output: "#10B981",
  reasoning: "#F59E0B", // = roles.tester.color 橙
  cacheRead: "#0EA5E9", // 青（缓存读）
  cacheWrite: "#94A3B8", // 灰（缓存写，低成本）
  cost: "#EF4444", // 危险红：成本是「要盯住」的那条线
  messages: "#6366F1", // 靛（协作）
  review: "#F59E0B",
  rework: "#EF4444",
  neutral: neutral[400],
} as const;

/** 分类色板数组（RankBar / Donut 按索引取色）。 */
export const PALETTE: readonly string[] = [
  CHART_COLORS.tasksCreated,
  CHART_COLORS.tasksCompleted,
  CHART_COLORS.artifacts,
  CHART_COLORS.reasoning,
  CHART_COLORS.cacheRead,
  CHART_COLORS.messages,
  "#EC4899", // 粉（第 7 色，仅用于长尾分布）
  "#14B8A6", // 蓝绿（第 8 色）
];

/* ============================================================
 * 三、容器：Panel / MetricCard / EmptyChart
 * ============================================================ */

export interface PanelProps {
  title: ReactNode;
  /** 副标题：写口径（例如「去重产出物 · 日粒度」），不要写营销语。 */
  subtitle?: ReactNode;
  /** 右上角操作插槽（切换器 / 图例 / 链接）。 */
  action?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  /** 面板内容区额外样式（如固定高度、内边距归零）。 */
  bodyStyle?: CSSProperties;
  testId?: string;
  /** 是否去掉默认内边距（图表需要贴边时用）。 */
  flush?: boolean;
}

/** 白底圆角面板（所有图表 / 表格的容器）。 */
export function Panel({
  title,
  subtitle,
  action,
  children,
  style,
  bodyStyle,
  testId = "panel",
  flush = false,
}: PanelProps) {
  return (
    <section
      data-testid={testId}
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.lg,
        boxShadow: shadow.sm,
        overflow: "hidden",
        ...style,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: space.md,
          padding: `${space.md + 2}px ${space.lg}px`,
          borderBottom: `1px solid ${neutral[100]}`,
          flexShrink: 0,
          ...baseFont,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], lineHeight: 1.35 }}>
            {title}
          </div>
          {subtitle && (
            <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2, lineHeight: 1.4 }}>
              {subtitle}
            </div>
          )}
        </div>
        {action && <div style={{ flexShrink: 0 }}>{action}</div>}
      </header>
      <div style={{ padding: flush ? 0 : space.lg, flex: 1, minHeight: 0, ...bodyStyle }}>
        {children}
      </div>
    </section>
  );
}

export interface MetricCardProps {
  /** 指标中文名（如「已完成任务」）。 */
  label: string;
  /** 主值（已格式化字符串；未知传「—」）。 */
  value: string;
  /** 值的单位后缀（如「个」「K tokens」），与 value 同行小字。 */
  unit?: string;
  /** 环比变化率（0.12 = +12%）；`null` = 无可比区间或分母为 0 ⇒ 显示「—」。 */
  delta?: number | null;
  /** 环比方向语义：`up-good` 表示涨了是好事（完成任务数），`up-bad` 表示涨了要警惕（成本/返工）。 */
  deltaTone?: "up-good" | "up-bad" | "neutral";
  /** 环比对比对象说明（如「对比上一个 7 天」）。 */
  deltaHint?: string;
  /** 口径提示（如「去重产出物，非版本数」）。 */
  hint?: string;
  /** 顶部左侧图标字符（复用 _shared 的图标或纯文本符号）。 */
  icon?: ReactNode;
  /** 数值下方的迷你趋势。 */
  spark?: ReactNode;
  /** 强调整体（如成本/未知态）用；`warn` 会把值染成琥珀色。 */
  tone?: "default" | "warn" | "danger";
  testId?: string;
  style?: CSSProperties;
}

/** 四宫格 / 六宫格指标卡：主值 + 环比 + 口径提示 + 迷你趋势。 */
export function MetricCard({
  label,
  value,
  unit,
  delta,
  deltaTone = "up-good",
  deltaHint,
  hint,
  icon,
  spark,
  tone = "default",
  testId = "metric-card",
  style,
}: MetricCardProps) {
  const valueColor = tone === "danger" ? "#DC2626" : tone === "warn" ? "#B45309" : neutral[900];
  const deltaColor =
    delta === null || delta === undefined
      ? neutral[400]
      : deltaTone === "neutral"
        ? neutral[600]
        : deltaTone === "up-good"
          ? delta >= 0
            ? "#059669"
            : "#DC2626"
          : delta >= 0
            ? "#DC2626"
            : "#059669";
  // 方向箭头：无环比（delta 为 null/undefined，例如没有可比的上一区间）时**不画箭头**，
  // 由调用方决定显示「—」还是整行隐藏——避免出现「→ —」这种自相矛盾的默认符号。
  const arrow = delta === null || delta === undefined ? "" : delta >= 0 ? "↑" : "↓";

  return (
    <div
      data-testid={testId}
      data-label={label}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        padding: `${space.lg}px ${space.lg + 2}px`,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.lg,
        boxShadow: shadow.sm,
        minWidth: 0,
        ...baseFont,
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
        {icon && (
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              borderRadius: radius.sm,
              backgroundColor: neutral[100],
              color: neutral[500],
              fontSize: fontSize.md,
              flexShrink: 0,
            }}
          >
            {icon}
          </span>
        )}
        <span
          style={{
            fontSize: fontSize.md,
            color: neutral[500],
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: space.xs, minWidth: 0, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 26,
            fontWeight: 650,
            color: valueColor,
            letterSpacing: "-.01em",
            lineHeight: 1.15,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>
        {unit && <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>{unit}</span>}
      </div>

      {(delta !== undefined || deltaHint) && (
        <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 2,
              fontSize: fontSize.sm,
              fontWeight: 600,
              color: deltaColor,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {delta === null || delta === undefined ? "—" : `${arrow} ${fmtSignedPct(delta)}`}
          </span>
          {deltaHint && <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{deltaHint}</span>}
        </div>
      )}

      {spark}

      {hint && (
        <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.45, marginTop: "auto" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** 图表统一空态（数据为空 / 区间无产出时用，不做「画空轴」）。 */
export function EmptyChart({
  title = "该区间没有数据",
  description = "换个区间、或等下一天的数据。",
  height = 180,
}: {
  title?: string;
  description?: string;
  height?: number;
}) {
  return (
    <div
      data-testid="chart-empty"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: space.xs,
        height,
        border: `1px dashed ${neutral[300]}`,
        borderRadius: radius.md,
        backgroundColor: neutral[50],
        ...baseFont,
      }}
    >
      <span aria-hidden style={{ fontSize: 22, color: neutral[400], lineHeight: 1 }}>
        ◌
      </span>
      <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[500] }}>{title}</div>
      <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>{description}</div>
    </div>
  );
}

/* ============================================================
 * 四、折线图（多系列，可选面积）
 * ============================================================ */

export interface Series {
  key: string;
  /** 图例名（含单位更佳，如「完成（个）」）。 */
  name: string;
  values: (number | null)[];
  /** 颜色；缺省按 PALETTE 取色。 */
  color?: string;
  /** 是否填充面积（一般只给「主系列」开）。 */
  area?: boolean;
}

export interface LineChartProps {
  /** 横轴标签（与每个 series.values 等长）。 */
  labels: string[];
  series: Series[];
  height?: number;
  /** 是否显示横向网格与 y 轴刻度。 */
  showGrid?: boolean;
  /** 数值格式化（tooltip / 轴刻度共用）。 */
  format?: (v: number | null) => string;
  /** 是否在末点画圆点 + 末值标签。 */
  showLastValue?: boolean;
  testId?: string;
  ariaLabel?: string;
  /** y 轴最小值强制 0（内存/条数类指标要 0 基线才诚实）。 */
  zeroBased?: boolean;
}

/** 左内边距（留给 y 轴刻度文字）。 */
const L_PAD = 40;
const R_PAD = 12;

/**
 * 多系列折线图。
 * 几何说明：主 svg 用 viewBox + preserveAspectRatio="none" 只承载折线/面积，
 * 轴刻度与末点文字用 HTML 绝对定位覆盖层（避免文字随 viewBox 拉伸变形）。
 */
export function LineChart({
  labels,
  series,
  height = 220,
  showGrid = true,
  format = fmtCompact,
  showLastValue = false,
  testId = "line-chart",
  ariaLabel,
  zeroBased = true,
}: LineChartProps) {
  const n = labels.length;
  const visible = series.filter((s) => s.values.some((v) => v !== null));
  if (n === 0 || visible.length === 0) return <EmptyChart height={height} />;
  // 只有 1 个桶时（如「近 7 天 + 月粒度」）折线退化成单点，画出来是一根没有趋势可读的竖线。
  // 这种情况明确提示「粒度大于区间」，而不是让用户对着一个点猜。
  if (n === 1) {
    const v = visible[0].values[0];
    return (
      <div
        data-testid={`${testId}-degenerate`}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
          height,
          border: `1px dashed ${neutral[300]}`,
          borderRadius: radius.md,
          backgroundColor: neutral[50],
          ...baseFont,
        }}
      >
        <span style={{ fontSize: 20, color: neutral[400], lineHeight: 1 }}>◷</span>
        <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[500] }}>
          区间内只有 1 个「{labels[0]}」桶
        </div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400], textAlign: "center", padding: "0 12px" }}>
          当前粒度大于所选区间，趋势不可读。请把区间调长（如近 30/90 天）或把粒度调细（如日）。
          {v !== null && v !== undefined ? `（本例值 ${format(v)}）` : ""}
        </div>
      </div>
    );
  }

  const all = visible.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const rawMin = Math.min(...all);
  const rawMax = Math.max(...all);
  const min = zeroBased ? 0 : Math.min(rawMin, 0);
  const max = rawMax === min ? min + 1 : rawMax;
  const span = max - min;

  const xAt = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const yAt = (v: number) => 100 - ((v - min) / span) * 100;

  const ticks = 4;
  const tickValues = Array.from({ length: ticks + 1 }, (_, i) => min + (span * i) / ticks);
  // 横轴标签最多显示 ~8 个，避免密集重叠
  const labelStep = Math.max(1, Math.ceil(n / 8));

  return (
    <div
      data-testid={testId}
      role="img"
      aria-label={ariaLabel ?? `折线图，共 ${n} 个刻度、${visible.length} 个系列`}
      style={{ position: "relative", height, width: "100%", ...baseFont }}
    >
      {/* y 轴刻度（HTML 层，不随 viewBox 拉伸）。
          几何必须与下方 svg 的绘图带一致：svg 的 top=6 / bottom=26，
          故刻度线的 bottom 用 `calc(6px + (100% - 32px) * t)` 精确对齐，
          刻度文字再上移 8px 居中——否则 0 刻度会掉进 x 轴标签区（本次修复的 bug）。 */}
      {showGrid &&
        tickValues.map((v, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: `calc(6px + (100% - 32px) * ${i / ticks})`,
              height: 1,
              backgroundColor: neutral[100],
            }}
          >
            <span
              style={{
                position: "absolute",
                left: 0,
                top: -8,
                width: L_PAD - 6,
                fontSize: fontSize.xs,
                color: neutral[400],
                textAlign: "right",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {format(v)}
            </span>
          </div>
        ))}

      {/* 折线 + 面积 */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden
        style={{
          position: "absolute",
          left: L_PAD,
          right: R_PAD,
          top: 6,
          bottom: 26,
          width: `calc(100% - ${L_PAD + R_PAD}px)`,
          height: `calc(100% - 32px)`,
          overflow: "visible",
        }}
      >
        {visible.map((s, si) => {
          const color = s.color ?? PALETTE[si % PALETTE.length];
          const pts = s.values
            .map((v, i) => (v === null ? null : `${xAt(i)},${yAt(v)}`))
            .filter((p): p is string => p !== null);
          if (pts.length === 0) return null;
          const d = `M ${pts.join(" L ")}`;
          const firstIdx = s.values.findIndex((v) => v !== null);
          const lastIdx = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
          return (
            <g key={s.key}>
              {s.area && (
                <path
                  d={`M ${xAt(firstIdx)},100 L ${pts.join(" L ")} L ${xAt(lastIdx)},100 Z`}
                  fill={color}
                  fillOpacity={0.1}
                  stroke="none"
                />
              )}
              <path d={d} stroke={color} strokeWidth={0.55} fill="none" vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>

      {/* 末点圆点 + 末值标签（HTML 层，保证不被拉伸） */}
      {showLastValue &&
        visible.map((s, si) => {
          const color = s.color ?? PALETTE[si % PALETTE.length];
          const lastIdx = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
          const v = s.values[lastIdx];
          if (v === null || lastIdx < 0) return null;
          const left = `calc(${L_PAD}px + (100% - ${L_PAD + R_PAD}px) * ${xAt(lastIdx) / 100})`;
          const bottom = `calc(26px + (100% - 32px) * ${yAt(v) / 100})`;
          return (
            <div
              key={`dot-${s.key}`}
              title={`${s.name}: ${format(v)}`}
              style={{
                position: "absolute",
                left,
                bottom,
                transform: "translate(-50%, 50%)",
                display: "flex",
                alignItems: "center",
                gap: 3,
                whiteSpace: "nowrap",
                pointerEvents: "none",
              }}
            >
              <span
                style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: color, flexShrink: 0 }}
              />
              {si === 0 && (
                <span style={{ fontSize: fontSize.xs, color: neutral[500], fontVariantNumeric: "tabular-nums" }}>
                  {format(v)}
                </span>
              )}
            </div>
          );
        })}

      {/* x 轴标签 */}
      <div
        aria-hidden
        style={{ position: "absolute", left: L_PAD, right: R_PAD, bottom: 0, height: 20 }}
      >
        {labels.map((lb, i) => {
          const isLast = i === n - 1;
          // 末点单独锚定右边界；与末点「贴太近」的步长标签要丢弃，否则会渲染成
          // 「10-29-30」这种两个文字压在一起的串（n=30、步长 4 时 i=28 就是这个坑）。
          const nearLast = (n - 1 - i) < Math.ceil(labelStep / 2);
          const show = isLast || (i % labelStep === 0 && !nearLast);
          if (!show) return null;
          return (
            <span
              key={i}
              style={{
                position: "absolute",
                // 首点左锚、末点右锚、其余居中：否则首/末标签会各自向外溢出半个标签宽，
                // 首标签还会压到左侧 y 轴刻度文字上（0 刻度与 10-01 相叠就是这个问题）。
                left: isLast ? "100%" : i === 0 ? "0%" : `${xAt(i)}%`,
                transform: isLast ? "translateX(-100%)" : i === 0 ? "none" : "translateX(-50%)",
                fontSize: fontSize.xs,
                color: neutral[400],
                whiteSpace: "nowrap",
              }}
            >
              {lb}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** 图例（折线 / 柱状 / 环形共用）。 */
export function Legend({
  items,
  style,
}: {
  items: { name: string; color: string; dashed?: boolean }[];
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: `${space.xs}px ${space.md}px`,
        ...baseFont,
        ...style,
      }}
    >
      {items.map((it) => (
        <span key={it.name} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: it.dashed ? 0 : 3,
              backgroundColor: it.color,
              flexShrink: 0,
              border: it.dashed ? `1px dashed ${it.color}` : undefined,
            }}
          />
          <span style={{ fontSize: fontSize.xs, color: neutral[500] }}>{it.name}</span>
        </span>
      ))}
    </div>
  );
}

/* ============================================================
 * 五、柱状图（分组 / 堆叠）
 * ============================================================ */

export interface BarSeries {
  key: string;
  name: string;
  values: number[];
  color: string;
}

export interface BarChartProps {
  labels: string[];
  series: BarSeries[];
  /** `group` = 分组并列；`stack` = 堆叠（一个桶一条柱）。 */
  mode?: "group" | "stack";
  height?: number;
  format?: (v: number) => string;
  testId?: string;
  ariaLabel?: string;
  /** 堆叠时是否显示总量标签。 */
  showTotal?: boolean;
}

/** 分组柱 / 堆叠柱（HTML flex 实现，宽度自适应用百分比，不依赖 SVG 坐标换算）。 */
export function BarChart({
  labels,
  series,
  mode = "group",
  height = 220,
  format = fmtCompact,
  testId = "bar-chart",
  ariaLabel,
  showTotal = false,
}: BarChartProps) {
  const n = labels.length;
  if (n === 0 || series.length === 0) return <EmptyChart height={height} />;
  const max =
    mode === "stack"
      ? Math.max(...labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0)), 1)
      : Math.max(...series.flatMap((s) => s.values), 1);

  return (
    <div
      data-testid={testId}
      role="img"
      aria-label={ariaLabel ?? `${mode === "stack" ? "堆叠" : "分组"}柱状图，共 ${n} 组`}
      style={{ display: "flex", flexDirection: "column", gap: space.sm, ...baseFont }}
    >
      <div style={{ position: "relative", height, display: "flex", alignItems: "flex-end", gap: 4 }}>
        {/* 基线 */}
        <div
          aria-hidden
          style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 1, backgroundColor: neutral[200] }}
        />
        {labels.map((label, i) => {
          if (mode === "stack") {
            const total = series.reduce((a, s) => a + (s.values[i] ?? 0), 0);
            return (
              <div
                key={label}
                title={`${label}: ${format(total)}`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: "100%",
                  display: "flex",
                  flexDirection: "column-reverse",
                  justifyContent: "flex-start",
                  position: "relative",
                  zIndex: 1,
                }}
              >
                {series.map((s) => {
                  const v = s.values[i] ?? 0;
                  return (
                    <div
                      key={s.key}
                      style={{
                        height: `${(v / max) * 100}%`,
                        backgroundColor: s.color,
                        borderRadius: 2,
                        minHeight: v > 0 ? 2 : 0,
                      }}
                    />
                  );
                })}
                {/* 总量标签：只在「柱子够宽」时显示。
                    30 根柱子的日粒度下，每根只有 ~14px，标签（1.68M 约 30px）必然互相压住、
                    还会盖住相邻柱的顶——那比不显示更糟。故按柱宽阈值降级为「不标注」，
                    总量语义仍可由 y 轴刻度与 tooltip 获得。 */}
                {showTotal && total > 0 && n <= 14 && (
                  <span
                    title={`${label} 合计 ${format(total)}`}
                    style={{
                      position: "absolute",
                      bottom: `calc(${(total / max) * 100}% + 2px)`,
                      left: "50%",
                      transform: "translateX(-50%)",
                      fontSize: 9,
                      color: neutral[500],
                      whiteSpace: "nowrap",
                      fontVariantNumeric: "tabular-nums",
                      pointerEvents: "none",
                    }}
                  >
                    {format(total)}
                  </span>
                )}
              </div>
            );
          }
          return (
            <div
              key={label}
              style={{
                flex: 1,
                minWidth: 0,
                height: "100%",
                display: "flex",
                alignItems: "flex-end",
                gap: 2,
                position: "relative",
                zIndex: 1,
              }}
            >
              {series.map((s) => {
                const v = s.values[i] ?? 0;
                return (
                  <div
                    key={s.key}
                    title={`${s.name} · ${label}: ${format(v)}`}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      height: `${(v / max) * 100}%`,
                      backgroundColor: s.color,
                      borderRadius: "2px 2px 0 0",
                      minHeight: v > 0 ? 2 : 0,
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      {/* x 轴标签：**绝对定位**而不是 flex 均分。
          均分给每个格子只有「柱宽」那么宽，标签一长就被 textOverflow 截成「1…」；
          改成在容器上按百分比定位后，标签可以自由伸展（步长 10 次里只留必要几个）。
          与 LineChart 同一套锚点规则：首点左锚、末点右锚、其余居中。 */}
      <div aria-hidden style={{ position: "relative", height: 16, margin: "0 -2px" }}>
        {labels.map((label, i) => {
          const step = Math.max(1, Math.ceil(n / 8));
          const isLast = i === n - 1;
          const nearLast = (n - 1 - i) < Math.ceil(step / 2);
          const show = isLast || (i % step === 0 && !nearLast);
          if (!show) return null;
          const pct = n <= 1 ? 50 : ((i + 0.5) / n) * 100;
          return (
            <span
              key={label}
              style={{
                position: "absolute",
                left: isLast ? "100%" : i === 0 ? "0%" : `${pct}%`,
                transform: isLast ? "translateX(-100%)" : i === 0 ? "none" : "translateX(-50%)",
                fontSize: fontSize.xs,
                color: neutral[400],
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
 * 六、环形图（Donut）
 * ============================================================ */

export interface DonutSlice {
  key: string;
  name: string;
  value: number;
  color?: string;
}

export interface DonutChartProps {
  slices: DonutSlice[];
  /** 环中心主文案（缺省显示总量）。 */
  centerValue?: string;
  centerLabel?: string;
  size?: number;
  /** 环厚（相对半径的比例 0..1）。 */
  thickness?: number;
  format?: (v: number) => string;
  testId?: string;
  ariaLabel?: string;
}

/** 环形图：用 SVG circle + strokeDasharray 画（避免 path 弧长手算）。 */
export function DonutChart({
  slices,
  centerValue,
  centerLabel,
  size = 156,
  thickness = 0.32,
  format = fmtCompact,
  testId = "donut-chart",
  ariaLabel,
}: DonutChartProps) {
  const filtered = slices.filter((s) => s.value > 0);
  const total = filtered.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return <EmptyChart height={size} title="没有构成数据" />;

  const r = 50;
  const circumference = 2 * Math.PI * r;
  const inner = r * (1 - thickness);
  let acc = 0;

  return (
    <div
      data-testid={testId}
      role="img"
      aria-label={ariaLabel ?? `环形图，共 ${filtered.length} 个分片`}
      style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap", ...baseFont }}
    >
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
        <svg viewBox="0 0 120 120" style={{ width: "100%", height: "100%" }} aria-hidden>
          <circle cx="60" cy="60" r={r} fill="none" stroke={neutral[100]} strokeWidth={r * thickness} />
          {filtered.map((s, i) => {
            const color = s.color ?? PALETTE[i % PALETTE.length];
            const frac = s.value / total;
            const dash = `${frac * circumference} ${circumference}`;
            const offset = -acc * circumference;
            acc += frac;
            return (
              <circle
                key={s.key}
                cx="60"
                cy="60"
                r={r}
                fill="none"
                stroke={color}
                strokeWidth={r * thickness}
                strokeDasharray={dash}
                strokeDashoffset={offset}
                strokeLinecap="butt"
                transform="rotate(-90 60 60)"
              />
            );
          })}
          {/* 内圈白底：保证中心文字与环之间干净（同时遮住环的内侧圆弧） */}
          <circle cx="60" cy="60" r={inner} fill="#FFFFFF" />
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 1,
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              fontSize: 19,
              fontWeight: 650,
              color: neutral[900],
              lineHeight: 1.1,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {centerValue ?? format(total)}
          </span>
          {centerLabel && <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{centerLabel}</span>}
        </div>
      </div>

      {/* 图例 + 数值 */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm, minWidth: 0, flex: 1 }}>
        {slices.map((s, i) => {
          const frac = total > 0 ? s.value / total : 0;
          return (
            <div
              key={s.key}
              style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}
            >
              <span
                aria-hidden
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  backgroundColor: s.color ?? PALETTE[i % PALETTE.length],
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: fontSize.sm,
                  color: neutral[700],
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {s.name}
              </span>
              <span
                style={{
                  fontSize: fontSize.sm,
                  color: neutral[500],
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                }}
              >
                {format(s.value)}
              </span>
              <span
                style={{
                  fontSize: fontSize.xs,
                  color: neutral[400],
                  width: 38,
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                }}
              >
                {fmtPct(frac, 0)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
 * 七、横向排行条（RankBar）与迷你折线（Sparkline）
 * ============================================================ */

export interface RankItem {
  key: string;
  name: string;
  /** 主指标值（决定条长）。 */
  value: number;
  /** 主指标格式化后的展示文本；缺省用 format。 */
  display?: string;
  /** 右侧副文本（如「12 个任务 · 命中率 34%」）。 */
  meta?: string;
  /** 条色；缺省按 rank 取 PALETTE。 */
  color?: string;
}

export function RankBar({
  items,
  format = fmtCompact,
  /** 条最大值的参考值（缺省取 items 最大）；用于多图对齐同一量纲。 */
  max,
  testId = "rank-bar",
  ariaLabel,
  showRank = true,
}: {
  items: RankItem[];
  format?: (v: number) => string;
  max?: number;
  testId?: string;
  ariaLabel?: string;
  showRank?: boolean;
}) {
  if (items.length === 0) return <EmptyChart height={120} title="没有可排行的数据" />;
  const peak = Math.max(max ?? 0, ...items.map((i) => i.value), 1);

  return (
    <div
      data-testid={testId}
      role="img"
      aria-label={ariaLabel ?? `排行条，共 ${items.length} 项`}
      style={{ display: "flex", flexDirection: "column", gap: space.md, ...baseFont }}
    >
      {items.map((it, i) => {
        const color = it.color ?? PALETTE[i % PALETTE.length];
        const w = Math.max(1.5, (it.value / peak) * 100);
        return (
          <div
            key={it.key}
            data-testid="rank-item"
            data-key={it.key}
            style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: space.sm, minWidth: 0 }}>
              {showRank && (
                <span
                  style={{
                    fontSize: fontSize.xs,
                    fontWeight: 700,
                    color: i < 3 ? color : neutral[400],
                    width: 12,
                    flexShrink: 0,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {i + 1}
                </span>
              )}
              <span
                style={{
                  fontSize: fontSize.md,
                  color: neutral[800],
                  fontWeight: i === 0 ? 600 : 500,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {it.name}
              </span>
              <span
                style={{
                  fontSize: fontSize.sm,
                  fontWeight: 600,
                  color: neutral[700],
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                }}
              >
                {it.display ?? format(it.value)}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <div style={{ flex: 1, height: 7, borderRadius: radius.pill, backgroundColor: neutral[100], overflow: "hidden" }}>
                <div
                  style={{
                    width: `${w}%`,
                    height: "100%",
                    borderRadius: radius.pill,
                    backgroundColor: color,
                    opacity: i === 0 ? 1 : 0.82,
                  }}
                />
              </div>
              {it.meta && (
                <span
                  style={{
                    fontSize: fontSize.xs,
                    color: neutral[400],
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {it.meta}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Sparkline({
  values,
  color = CHART_COLORS.tasksCreated,
  height = 30,
  showArea = true,
  testId = "sparkline",
  ariaLabel,
}: {
  values: number[];
  color?: string;
  height?: number;
  showArea?: boolean;
  testId?: string;
  ariaLabel?: string;
}) {
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return <div style={{ height }} />;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${100 - ((v - min) / span) * 100}`);
  return (
    <div
      data-testid={testId}
      role="img"
      aria-label={ariaLabel ?? `迷你趋势（${vals.length} 个点）`}
      style={{ height, width: "100%", marginTop: 2 }}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: "100%", height: "100%" }} aria-hidden>
        {showArea && (
          <path d={`M 0,100 L ${pts.join(" L ")} L 100,100 Z`} fill={color} fillOpacity={0.12} stroke="none" />
        )}
        <path d={`M ${pts.join(" L ")}`} stroke={color} strokeWidth={1.4} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/* ============================================================
 * 八、热力图（日历格子）
 * ============================================================ */

export interface HeatRow {
  key: string;
  name: string;
  /** 与 columns 等长，值 0..max 表示强度；null = 无数据（画成浅灰斜纹）。 */
  values: (number | null)[];
}

export function Heatmap({
  columns,
  rows,
  /** 强度上限（缺省取全部值的最大值）。 */
  max,
  /** 单元格尺寸（宽 / 高 / 间隙）。 */
  cell = 9,
  labelWidth = 108,
  testId = "heatmap",
  ariaLabel,
  /** 每多少列显示一个横轴标签。 */
  columnLabelStep = 10,
}: {
  columns: string[];
  rows: HeatRow[];
  max?: number;
  cell?: number;
  labelWidth?: number;
  testId?: string;
  ariaLabel?: string;
  columnLabelStep?: number;
}) {
  if (rows.length === 0 || columns.length === 0) return <EmptyChart height={120} title="没有热力数据" />;
  const peak = Math.max(max ?? 0, ...rows.flatMap((r) => r.values.filter((v): v is number => v !== null)), 1);

  return (
    <div
      data-testid={testId}
      role="img"
      aria-label={ariaLabel ?? `热力图，${rows.length} 行 × ${columns.length} 列`}
      style={{ display: "flex", flexDirection: "column", gap: 4, overflowX: "auto", ...baseFont }}
    >
      {rows.map((row) => (
        <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <div
            style={{
              width: labelWidth,
              flexShrink: 0,
              fontSize: fontSize.xs,
              color: neutral[600],
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={row.name}
          >
            {row.name}
          </div>
          <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            {row.values.map((v, i) => {
              const ratio = v === null || v === 0 ? 0 : Math.min(1, v / peak);
              // 强度 → 不透明度（0.1 起步，避免「有一点」和「没有」在视觉上分不开）
              const alpha = v === null ? 0 : v === 0 ? 0.06 : 0.16 + 0.8 * ratio;
              return (
                <div
                  key={`${row.key}-${i}`}
                  title={`${row.name} · ${columns[i]}: ${v === null ? "无数据" : v}`}
                  style={{
                    width: cell,
                    height: cell,
                    borderRadius: 2,
                    backgroundColor: v === null ? "transparent" : CHART_COLORS.tasksCreated,
                    opacity: alpha,
                    border: v === null ? `1px dashed ${neutral[200]}` : "none",
                    boxSizing: "border-box",
                  }}
                />
              );
            })}
          </div>
        </div>
      ))}
      {/* 横轴：只显示少量日期，避免挤压 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
        <div style={{ width: labelWidth, flexShrink: 0 }} />
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          {columns.map((c, i) => (
            <div
              key={c}
              style={{
                width: cell,
                fontSize: 9,
                color: neutral[400],
                whiteSpace: "nowrap",
                overflow: "visible",
              }}
            >
              {i % columnLabelStep === 0 ? c.slice(5) : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * 九、漏斗（任务生命周期）
 * ============================================================ */

export interface FunnelStageView {
  key: string;
  name: string;
  value: number;
  /** 留存率 0..1（相对首阶段）。 */
  retention: number;
  color?: string;
}

export function Funnel({
  stages,
  testId = "funnel",
  ariaLabel,
  format = fmtInt,
}: {
  stages: FunnelStageView[];
  testId?: string;
  ariaLabel?: string;
  format?: (v: number) => string;
}) {
  if (stages.length === 0) return <EmptyChart height={140} title="没有漏斗数据" />;
  const peak = Math.max(...stages.map((s) => s.value), 1);
  return (
    <div
      data-testid={testId}
      role="img"
      aria-label={ariaLabel ?? `漏斗，共 ${stages.length} 个阶段`}
      style={{ display: "flex", flexDirection: "column", gap: space.sm, ...baseFont }}
    >
      {stages.map((s, i) => {
        const color = s.color ?? PALETTE[i % PALETTE.length];
        const w = Math.max(12, (s.value / peak) * 100);
        return (
          <div
            key={s.key}
            data-testid="funnel-stage"
            data-stage={s.key}
            style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}
          >
            <span
              style={{
                width: 66,
                flexShrink: 0,
                fontSize: fontSize.sm,
                color: neutral[600],
                whiteSpace: "nowrap",
              }}
            >
              {s.name}
            </span>
            <div style={{ flex: 1, minWidth: 0, height: 26, display: "flex", alignItems: "center" }}>
              <div
                style={{
                  width: `${w}%`,
                  height: 24,
                  borderRadius: radius.sm,
                  backgroundColor: color,
                  opacity: 0.9 - i * 0.08,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  paddingRight: space.sm,
                  minWidth: 54,
                  boxSizing: "border-box",
                }}
              >
                <span
                  style={{
                    fontSize: fontSize.sm,
                    fontWeight: 600,
                    color: "#FFFFFF",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                  }}
                >
                  {format(s.value)}
                </span>
              </div>
            </div>
            {/* 留存率列宽 44→52：三位数百分比（100%）在 44px 里会被右侧裁掉最后一位（本次修复） */}
            <span
              style={{
                width: 52,
                flexShrink: 0,
                textAlign: "right",
                fontSize: fontSize.xs,
                color: neutral[400],
                fontVariantNumeric: "tabular-nums",
                paddingRight: 2,
              }}
            >
              {fmtPct(s.retention, 0)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
 * 十、状态分布条（堆叠进度条，任务七态 / 任务盘子）
 * ============================================================ */

export function StackedBar({
  segments,
  height = 10,
  rounded = true,
  testId = "stacked-bar",
  ariaLabel,
}: {
  segments: { key: string; name: string; value: number; color: string }[];
  height?: number;
  rounded?: boolean;
  testId?: string;
  ariaLabel?: string;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return <div style={{ height, backgroundColor: neutral[100], borderRadius: radius.pill }} />;
  return (
    <div
      data-testid={testId}
      role="img"
      aria-label={ariaLabel ?? `状态分布条，共 ${segments.length} 段`}
      style={{
        display: "flex",
        width: "100%",
        height,
        overflow: "hidden",
        borderRadius: rounded ? radius.pill : 0,
        backgroundColor: neutral[100],
      }}
    >
      {segments.map((s) => (
        <div
          key={s.key}
          title={`${s.name}: ${s.value}`}
          style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color, minWidth: s.value > 0 ? 2 : 0 }}
        />
      ))}
    </div>
  );
}
