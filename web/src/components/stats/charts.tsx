"use client";

/**
 * 统计看板图表原语（web 生产版）
 * =====================================================================
 * 由 `docs/agent-platform/prototypes/_shared/charts.tsx`（已验证的视觉原型）移植而来，
 * 两处关键差异（移植时不能照抄的地方）：
 *
 * 1. **配色改用 CSS 变量 token**（`neutral[i]` = `var(--color-neutral-i)`）：原型是固定
 *    浅色站，生产站是 light/dark 双主题，写死十六进制色在暗色主题下会「白卡片上贴灰字」。
 *    唯一的例外是 `CHART_COLORS` —— 它是**语义色板**（同一系列在所有图里必须同色），
 *    从 `src/theme/tokens.ts` 的 roles 色板取值，本身也是 CSS 变量。
 * 2. **不依赖任何图表库**：保持零第三方依赖（与原型的取舍一致），几何全用 SVG + HTML 层
 *    绝对定位，避免引入 recharts/echarts 的体积与暗色主题适配成本。
 *
 * 统一约定：
 * - `viewBox` + CSS 宽度 100% ⇒ 容器宽度变化自动缩放，不做 resize 监听；
 * - 文字层用 HTML 绝对定位（不随 viewBox 拉伸，避免字被拉扁）；
 * - 空数据一律渲染 `EmptyChart`，不画半张空轴；
 * - 根节点带 `data-testid` + `role="img"` + `aria-label`。
 */
import type { CSSProperties, ReactNode } from "react";
import { neutral, space, radius, fontSize, fontFamily, shadow, roles } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ============================================================
 * 一、格式化（全站统计只从这里取，避免各处各写一套 toFixed）
 * ============================================================ */

/** 整数千分位；null/undefined ⇒ 「—」（未知不显示 0）。 */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** 紧凑数值：1,234 → 1.2K；1,234,567 → 1.23M。 */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/**
 * 金额。**null ⇒ 「—」**，绝不渲染 $0.00 —— 服务端 cost=null 的语义是
 * 「上游未上报（未知）」，渲染成 0 会把「没统计到」误读成「不花钱」。
 */
export function fmtMoney(n: number | null | undefined, currency = "$"): string {
  if (n === null || n === undefined) return "—";
  if (Math.abs(n) >= 1000) return `${currency}${(n / 1000).toFixed(2)}K`;
  return `${currency}${n.toFixed(2)}`;
}

/** 百分比：0.7823 → 78.2%。 */
export function fmtPct(r: number | null | undefined, digits = 1): string {
  if (r === null || r === undefined) return "—";
  return `${(r * 100).toFixed(digits)}%`;
}

/** 带符号百分比：0.12 → +12.0%；null ⇒ 「—」。 */
export function fmtSignedPct(r: number | null | undefined, digits = 1): string {
  if (r === null || r === undefined) return "—";
  return `${r >= 0 ? "+" : ""}${(r * 100).toFixed(digits)}%`;
}

/** 时长：小时；≥24h 折算成天。 */
export function fmtHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return "—";
  return h >= 24 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
}

/* ============================================================
 * 二、语义色板（跨图同系列必须同色；引用 theme tokens 的 roles）
 * ============================================================ */

export const CHART_COLORS = {
  /** 任务相关：蓝（= 产品经理角色色） */
  tasksCreated: roles.product.color,
  /** 完成相关：绿（= 开发者角色色） */
  tasksCompleted: roles.developer.color,
  /** 产出物：紫（= 架构师角色色） */
  artifacts: roles.architect.color,
  artifactVersions: "#A78BFA",
  input: roles.product.color,
  output: roles.developer.color,
  reasoning: roles.tester.color,
  cacheRead: "#0EA5E9",
  cacheWrite: "var(--color-neutral-400)",
  /** 成本：红——它是「要盯住」的那条线 */
  cost: "#EF4444",
  messages: "#6366F1",
  review: roles.tester.color,
  rework: "#EF4444",
} as const;

/** 分类色板（RankBar / Donut 按索引取色）。 */
export const PALETTE: readonly string[] = [
  CHART_COLORS.tasksCreated,
  CHART_COLORS.tasksCompleted,
  CHART_COLORS.artifacts,
  CHART_COLORS.reasoning,
  CHART_COLORS.cacheRead,
  CHART_COLORS.messages,
  "#EC4899",
  "#14B8A6",
];

/* ============================================================
 * 三、容器：Panel / MetricCard / EmptyChart / UnknownTag
 * ============================================================ */

export interface PanelProps {
  title: ReactNode;
  /** 副标题：写**口径**（如「去重产出物 · 日粒度」），不要写营销语。 */
  subtitle?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  testId?: string;
  /** 去掉内容区默认内边距（图表贴边 / 表格用）。 */
  flush?: boolean;
}

/** 白底圆角面板（所有图表与表格的容器）。 */
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
        backgroundColor: "var(--color-surface)",
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
      <div style={{ padding: flush ? 0 : space.lg, flex: 1, minHeight: 0, ...bodyStyle }}>{children}</div>
    </section>
  );
}

export interface MetricCardProps {
  label: string;
  /** 主值（已格式化字符串；未知传「—」）。 */
  value: string;
  unit?: string;
  /** 环比变化率（0.12 = +12%）；null ⇒ 「—」。 */
  delta?: number | null;
  /** 环比语义：up-good = 涨了是好事；up-bad = 涨了要警惕（成本/返工）。 */
  deltaTone?: "up-good" | "up-bad" | "neutral";
  deltaHint?: string;
  hint?: string;
  icon?: ReactNode;
  spark?: ReactNode;
  tone?: "default" | "warn" | "danger";
  testId?: string;
  style?: CSSProperties;
  /** 点击跳转（如「新建任务」卡 → 任务看板）。缺省 = 纯展示。 */
  onClick?: () => void;
}

/** 指标卡：主值 + 环比 + 口径提示 + 迷你趋势。 */
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
  onClick,
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
  // 无环比时不画箭头，避免出现「→ —」这种自相矛盾符号
  const arrow = delta === null || delta === undefined ? "" : delta >= 0 ? "↑" : "↓";

  return (
    <div
      data-testid={testId}
      data-label={label}
      {...(onClick
        ? {
            role: "button",
            tabIndex: 0,
            onClick,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            },
          }
        : {})}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        padding: `${space.lg}px ${space.lg + 2}px`,
        backgroundColor: "var(--color-surface)",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.lg,
        boxShadow: shadow.sm,
        minWidth: 0,
        ...(onClick ? { cursor: "pointer", transition: "border-color .12s ease" } : {}),
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
        <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.45, marginTop: "auto" }}>{hint}</div>
      )}
    </div>
  );
}

/** 「成本未知」小标：把「未知」与「免费」在视觉上区分开（本期最重要的口径可视化）。 */
export function UnknownTag({ title = "上游未上报成本（未知 ≠ 0）" }: { title?: string }) {
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

/** 图表统一空态。 */
export function EmptyChart({
  title = "该区间没有数据",
  description = "换个区间，或等有数据后再看。",
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
 * 四、折线图
 * ============================================================ */

export interface Series {
  key: string;
  name: string;
  values: (number | null)[];
  color?: string;
  area?: boolean;
}

/** 左内边距（留给 y 轴刻度文字）。 */
const L_PAD = 40;
const R_PAD = 12;

export interface LineChartProps {
  labels: string[];
  series: Series[];
  height?: number;
  showGrid?: boolean;
  format?: (v: number | null) => string;
  showLastValue?: boolean;
  testId?: string;
  ariaLabel?: string;
  /** y 轴强制 0 基线（条数/token 类指标必须从 0 起才诚实）。 */
  zeroBased?: boolean;
}

/** 多系列折线图（可选面积填充）。 */
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

  // 只有 1 个桶时（如「近 7 天 + 月粒度」）折线退化成单点：明确提示粒度大于区间，
  // 而不是让用户对着一个点猜趋势。
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
          当前粒度大于所选区间，趋势不可读。请把区间调长或把粒度调细。
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
  const labelStep = Math.max(1, Math.ceil(n / 8));

  return (
    <div
      data-testid={testId}
      role="img"
      aria-label={ariaLabel ?? `折线图，共 ${n} 个刻度、${visible.length} 个系列`}
      style={{ position: "relative", height, width: "100%", ...baseFont }}
    >
      {/* y 轴刻度：几何必须与下方 svg 的绘图带（top=6/bottom=26）严格对齐，
          否则 0 刻度会掉进 x 轴标签区（原型阶段踩过的坑）。 */}
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

      {/* 末点圆点 + 末值标签（HTML 层，保证不被 viewBox 拉伸） */}
      {showLastValue &&
        visible.map((s, si) => {
          const color = s.color ?? PALETTE[si % PALETTE.length];
          const lastIdx = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
          const v = s.values[lastIdx];
          if (v === null || lastIdx < 0) return null;
          return (
            <div
              key={`dot-${s.key}`}
              title={`${s.name}: ${format(v)}`}
              style={{
                position: "absolute",
                left: `calc(${L_PAD}px + (100% - ${L_PAD + R_PAD}px) * ${xAt(lastIdx) / 100})`,
                bottom: `calc(26px + (100% - 32px) * ${yAt(v) / 100})`,
                transform: "translate(-50%, 50%)",
                display: "flex",
                alignItems: "center",
                gap: 3,
                whiteSpace: "nowrap",
                pointerEvents: "none",
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: color, flexShrink: 0 }} />
              {si === 0 && (
                <span style={{ fontSize: fontSize.xs, color: neutral[500], fontVariantNumeric: "tabular-nums" }}>
                  {format(v)}
                </span>
              )}
            </div>
          );
        })}

      {/* x 轴标签：首点左锚、末点右锚、其余居中；与末点贴太近的步长标签丢弃，
          否则会渲染成「10-29-30」两个文字压在一起（原型阶段踩过的坑）。 */}
      <div aria-hidden style={{ position: "absolute", left: L_PAD, right: R_PAD, bottom: 0, height: 20 }}>
        {labels.map((lb, i) => {
          const isLast = i === n - 1;
          const nearLast = n - 1 - i < Math.ceil(labelStep / 2);
          const show = isLast || (i % labelStep === 0 && !nearLast);
          if (!show) return null;
          return (
            <span
              key={i}
              style={{
                position: "absolute",
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

/** 图例。 */
export function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: `${space.xs}px ${space.md}px`,
        ...baseFont,
      }}
    >
      {items.map((it) => (
        <span key={it.name} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span aria-hidden style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: it.color, flexShrink: 0 }} />
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
  mode?: "group" | "stack";
  height?: number;
  format?: (v: number) => string;
  testId?: string;
  ariaLabel?: string;
  showTotal?: boolean;
}

/** 分组柱 / 堆叠柱（HTML flex + 百分比高度，宽度自适应用 flex）。 */
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
                {/* 总量标签只在柱子够宽时显示：30 根柱的日粒度下每根仅 ~14px，
                    标签（1.68M 约 30px）必然互相压住 —— 那比不显示更糟。 */}
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
      {/* x 轴标签：绝对定位而非 flex 均分 —— 均分给每格只有柱宽，标签一长就被截成「1…」 */}
      <div aria-hidden style={{ position: "relative", height: 16, margin: "0 -2px" }}>
        {labels.map((label, i) => {
          const step = Math.max(1, Math.ceil(n / 8));
          const isLast = i === n - 1;
          const nearLast = n - 1 - i < Math.ceil(step / 2);
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
 * 六、环形图
 * ============================================================ */

export interface DonutSlice {
  key: string;
  name: string;
  value: number;
  color?: string;
}

export interface DonutChartProps {
  slices: DonutSlice[];
  centerValue?: string;
  centerLabel?: string;
  size?: number;
  thickness?: number;
  format?: (v: number) => string;
  testId?: string;
  ariaLabel?: string;
}

/** 环形图（SVG circle + strokeDasharray，避免手算弧长）。 */
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
          <circle cx="60" cy="60" r={inner} fill="var(--color-surface)" />
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

      <div style={{ display: "flex", flexDirection: "column", gap: space.sm, minWidth: 0, flex: 1 }}>
        {slices.map((s, i) => {
          const frac = total > 0 ? s.value / total : 0;
          return (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
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
              <span style={{ fontSize: fontSize.sm, color: neutral[500], fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
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
 * 七、排行条 / 迷你折线 / 热力图 / 漏斗 / 堆叠状态条
 * ============================================================ */

export interface RankItem {
  key: string;
  name: string;
  value: number;
  display?: string;
  meta?: string;
  color?: string;
}

/** 横向排行条。 */
export function RankBar({
  items,
  format = fmtCompact,
  max,
  testId = "rank-bar",
  ariaLabel,
  /** 点击某条排行（传 key）——用于「点团队名跳转到该团队详情」。缺省 = 纯展示。 */
  onItemClick,
}: {
  items: RankItem[];
  format?: (v: number) => string;
  max?: number;
  testId?: string;
  ariaLabel?: string;
  onItemClick?: (key: string) => void;
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
        return (
          <div
            key={it.key}
            data-testid="rank-item"
            data-key={it.key}
            {...(onItemClick
              ? {
                  role: "button",
                  tabIndex: 0,
                  onClick: () => onItemClick(it.key),
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onItemClick(it.key);
                    }
                  },
                }
              : {})}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              minWidth: 0,
              cursor: onItemClick ? "pointer" : undefined,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: space.sm, minWidth: 0 }}>
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
                    width: `${Math.max(1.5, (it.value / peak) * 100)}%`,
                    height: "100%",
                    borderRadius: radius.pill,
                    backgroundColor: color,
                    opacity: i === 0 ? 1 : 0.82,
                  }}
                />
              </div>
              {it.meta && (
                <span style={{ fontSize: fontSize.xs, color: neutral[400], whiteSpace: "nowrap", flexShrink: 0 }}>
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

/** 迷你趋势线（指标卡内的 sparkline）。 */
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
        {showArea && <path d={`M 0,100 L ${pts.join(" L ")} L 100,100 Z`} fill={color} fillOpacity={0.12} stroke="none" />}
        <path d={`M ${pts.join(" L ")}`} stroke={color} strokeWidth={1.4} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export interface HeatRow {
  key: string;
  name: string;
  values: (number | null)[];
}

/** 热力图（行 = 团队/成员，列 = 日期）。 */
export function Heatmap({
  columns,
  rows,
  max,
  cell = 9,
  labelWidth = 108,
  testId = "heatmap",
  ariaLabel,
  columnLabelStep = 10,
  /** 点击行名（传 row.key）——用于「点团队名跳转到该团队详情」。缺省 = 纯展示。 */
  onRowClick,
}: {
  columns: string[];
  rows: HeatRow[];
  max?: number;
  cell?: number;
  labelWidth?: number;
  onRowClick?: (key: string) => void;
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
            {...(onRowClick
              ? {
                  role: "button",
                  tabIndex: 0,
                  onClick: () => onRowClick(row.key),
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onRowClick(row.key);
                    }
                  },
                }
              : {})}
            style={{
              width: labelWidth,
              flexShrink: 0,
              fontSize: fontSize.xs,
              color: onRowClick ? neutral[700] : neutral[600],
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              cursor: onRowClick ? "pointer" : undefined,
              textDecoration: onRowClick ? "underline" : undefined,
              textUnderlineOffset: 2,
            }}
            title={row.name}
          >
            {row.name}
          </div>
          <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            {row.values.map((v, i) => {
              const ratio = v === null || v === 0 ? 0 : Math.min(1, v / peak);
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
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
        <div style={{ width: labelWidth, flexShrink: 0 }} />
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          {columns.map((c, i) => (
            <div key={c} style={{ width: cell, fontSize: 9, color: neutral[400], whiteSpace: "nowrap", overflow: "visible" }}>
              {i % columnLabelStep === 0 ? c.slice(5) : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export interface FunnelStageView {
  key: string;
  name: string;
  value: number;
  retention: number;
  color?: string;
}

/** 漏斗（任务生命周期）。 */
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
        return (
          <div key={s.key} data-testid="funnel-stage" data-stage={s.key} style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
            <span style={{ width: 66, flexShrink: 0, fontSize: fontSize.sm, color: neutral[600], whiteSpace: "nowrap" }}>{s.name}</span>
            <div style={{ flex: 1, minWidth: 0, height: 26, display: "flex", alignItems: "center" }}>
              <div
                style={{
                  width: `${Math.max(12, (s.value / peak) * 100)}%`,
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
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: "#FFFFFF", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {format(s.value)}
                </span>
              </div>
            </div>
            {/* 留存率列宽 52：三位数百分比（100%）在 44px 里会被右侧裁掉（原型阶段踩过的坑） */}
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

/** 堆叠状态条（任务七态分布等）。 */
export function StackedBar({
  segments,
  height = 10,
  testId = "stacked-bar",
  ariaLabel,
}: {
  segments: { key: string; name: string; value: number; color: string }[];
  height?: number;
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
      style={{ display: "flex", width: "100%", height, overflow: "hidden", borderRadius: radius.pill, backgroundColor: neutral[100] }}
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
