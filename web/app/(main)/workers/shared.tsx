"use client";

/**
 * Worker 节点共享定义（workers 列表页 + 详情页共用）
 * =====================================================
 * 从 workers/page.tsx（T13 原型保真迁移）提取的页面级共享层：
 * - worker 三态（在线/离线/维护中）标签与主题、负载档位色、相对时间格式化、
 *   脉冲动画 CSS、状态徽章组件——两页语义必须一致，避免复制漂移。
 * - API 数据模型：WorkerItem（列表条目）+ WorkerDetail（详情，含 mcpStatus）。
 * - MCP 三态主题（connected/failed/needs_auth）：对齐 skills 页 mcpStatusTheme
 *   （T8c 11 篇 §5.8 三态），语义独立于 worker 三态。
 * - 内置 git 工具清单（git_clone/git_pull/git_fetch/git_status/git_diff/git_log/
 *   git_push，17 篇 §4.1 七工具）：详情页区分「内置 git 工具 / 自定义工具」。
 * 这些均为 worker 域专属语义，遵循"扩展 token"范式不写 tokens.ts 基线。
 */
import type { CSSProperties, ReactNode } from "react";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ Worker 状态主题（原型 :40-44 逐 token，未入 tokens.ts） ------------------------------
 * 后端三态（online/offline/degraded）映射原型三态（在线/离线/维护中），色值同族于
 * statusColors：绿=在线 / 琥珀=维护中（degraded）/ 红=离线。语义独立于任务四态，
 * 遵循"扩展 token"范式在页面内定义具名常量并注释原因，不扩散共享层。
 */
export const WORKER_STATUS_LABEL = {
  online: "在线",
  offline: "离线",
  degraded: "维护中",
} as const;

export type WorkerStatusKey = keyof typeof WORKER_STATUS_LABEL;
export type WorkerStatusLabel = (typeof WORKER_STATUS_LABEL)[WorkerStatusKey];

export const workerStatusTheme: Record<
  WorkerStatusLabel,
  { color: string; bg: string; border: string }
> = {
  在线: { color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  维护中: { color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)" },
  离线: { color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
};

/** 负载档位色（原型 :47-51）：高（红）/ 中（琥珀）/ 低（绿） */
export function loadColor(pct: number): string {
  if (pct >= 75) return "#DC2626";
  if (pct >= 50) return "#D97706";
  return "#10B981";
}

/** 呼吸动画（scoped：workerpulse 前缀避免污染其他页面） */
export const pulseCss = `
@keyframes workerpulse-blink {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 currentColor; }
  50% { opacity: .55; }
}
@keyframes workerpulse-ring {
  0% { box-shadow: 0 0 0 0 rgba(16,185,129,.45); }
  70% { box-shadow: 0 0 0 6px rgba(16,185,129,0); }
  100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
}
`;

/* ------------------------------ API 数据模型（T7 toWorkerView：不含 tokenHash） ------------------------------ */

/** GET /workers 条目（对齐 schema Worker 对外视图；capabilities 为注册时上报的 Json）。
 *  列表接口不返回 capabilities（单行 300KB+，触发 MySQL filesort OOM）；详情接口仍返回。 */
export interface WorkerItem {
  id: string;
  name: string | null;
  opencodeVersion: string;
  capabilities?: {
    maxInstances?: number;
    /** T9：worker 侧注入的真实技能名清单（注册/reload-config 后刷新）。 */
    skills?: string[];
    /** T9：内置 git 7 工具 + 注入的自定义工具（去重）。 */
    tools?: string[];
    /** opencode serve 端口（T4c：随机端口重启后更新）。 */
    port?: number;
    /** opencode serve 对外基址（WORKER_ADVERTISE_HOST 语义）。 */
    baseUrl?: string;
    /** C2：serve 实际可用模型 id 列表（providerID/modelID；注册/reload-config 后刷新）。 */
    models?: string[];
  };
  load: { instances: number } | null;
  status: WorkerStatusKey;
  lastHeartbeatAt: string | null;
  registeredAt: string;
  /** C8：worker 默认模型 id（providerID/modelID；C2 register 上报或 PATCH 配置，null=未配置）。 */
  defaultModelId: string | null;
}

/** 心跳载荷中的单条 MCP 服务器状态（server McpStatusEntryDto，11 篇 §5.8 三态）。 */
export interface McpStatusEntry {
  serverName: string;
  status: "connected" | "failed" | "needs_auth";
}

/** GET /workers/:id 详情（T9：合并该 worker 最近上报的 mcpStatus，每次心跳刷新）。 */
export interface WorkerDetail extends WorkerItem {
  mcpStatus: McpStatusEntry[];
}

/* ------------------------------ 相对时间（原型 heartbeat 字段"3 秒前"格式） ------------------------------ */

/** ISO 时间 → 相对时间文案；null（从未上报）返回占位。 */
export function formatRelativeTime(iso: string | null, now: number): string {
  if (!iso) return "从未上报";
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/* ------------------------------ MCP 三态主题（对齐 skills 页 mcpStatusTheme） ------------------------------
 * worker 心跳探测上报的三态（11 篇 §5.8）：connected=已连接（绿）/ failed=连接失败（红）/
 * needs_auth=待授权（琥珀）。未上报 → 详情页空态提示（无 disconnected 过渡态，区别于
 * skills 页 MCP 工具五态——worker 详情只有探测真实结果）。
 */
export const MCP_STATUS_THEME: Record<
  McpStatusEntry["status"],
  { label: string; mark: string; color: string; bg: string; border: string }
> = {
  connected: { label: "已连接", mark: "✅", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  failed: { label: "连接失败", mark: "✗", color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
  needs_auth: { label: "待授权", mark: "🔑", color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)" },
};

/* ------------------------------ 内置 git 工具（17 篇 §4.1 七工具） ------------------------------ */

/** 内置 git 工具名（与 worker GIT_TOOLS 一致，工具名即权限 action）。 */
export const BUILTIN_GIT_TOOLS = new Set([
  "git_clone",
  "git_pull",
  "git_fetch",
  "git_status",
  "git_diff",
  "git_log",
  "git_push",
]);

/** capabilities.tools 中是否为内置 git 工具（否则为 T9 注入的自定义工具）。 */
export function isBuiltinGitTool(name: string): boolean {
  return BUILTIN_GIT_TOOLS.has(name);
}

/* ------------------------------ 状态徽章组件 ------------------------------ */

/** 状态徽章（worker 三态：在线 / 离线 / 维护中；在线带脉冲动画，原型 :167-204） */
export function WorkerStatusBadge({ status }: { status: WorkerStatusKey }) {
  const label = WORKER_STATUS_LABEL[status];
  const theme = workerStatusTheme[label];
  return (
    <span
      data-testid="worker-status"
      data-status={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs - 1}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          backgroundColor: theme.color,
          flexShrink: 0,
          color: theme.color,
          animation:
            status === "online" ? "workerpulse-ring 1.6s ease-out infinite" : undefined,
        }}
      />
      {label}
    </span>
  );
}

/** 卡片通用样式基（详情页白卡：列表页 WorkerCard 同源）。 */
export function cardStyle(options?: { border?: string; shadow?: string }): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: `${space.xl}px`,
    borderRadius: radius.lg,
    backgroundColor: "var(--color-surface)",
    border: `1px solid ${options?.border ?? neutral[200]}`,
    boxShadow: options?.shadow ?? undefined,
    ...baseFont,
  };
}

/** 区块标题行（详情页各能力卡共用：图标 + 标题 + 右侧计数）。 */
export function SectionHeader({
  icon,
  title,
  count,
  right,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        borderBottom: `1px solid ${neutral[100]}`,
        paddingBottom: space.sm,
      }}
    >
      <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1, color: neutral[400] }}>
        {icon}
      </span>
      <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>{title}</span>
      {count !== undefined && (
        <span
          style={{
            fontSize: fontSize.xs,
            fontWeight: 600,
            color: neutral[500],
            backgroundColor: neutral[100],
            border: `1px solid ${neutral[200]}`,
            padding: "1px 8px",
            borderRadius: radius.pill,
            fontFamily: fontFamily.mono,
          }}
        >
          {count}
        </span>
      )}
      {right}
    </div>
  );
}
