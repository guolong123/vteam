"use client";

/**
 * Worker 节点列表页（Phase 4 T13：worker-list 原型保真迁移 + 接 GET /workers）
 * =====================================================
 * 保真迁移自 docs/agent-platform/prototypes/worker-list/index.tsx（07 篇 11.2 / 11.4）。
 * 导航由 AppShell（app/(main)/layout.tsx）提供（NavTopBar + NavDock + CmdKPanel），本页仅渲染内容区。
 *
 * - 数据源（T7 已完成）：GET /workers → WorkerItem[]（id/name/opencodeVersion/
 *   capabilities{maxInstances,skills[],tools[]}/load{instances}/status/lastHeartbeatAt/registeredAt）。
 * - 状态映射：后端 online/offline/degraded → 原型三态 在线/离线/维护中（workerStatusTheme 逐 token 迁移）。
 * - 负载条：后端无 CPU 上报 → 以 load.instances / maxInstances 实例占用率驱动进度条
 *   （对齐原型 cpuColor 档位：≥75 红 / ≥50 琥珀 / 低绿），这是 load 字段的真实语义。
 * - 版本徽章 isV2：opencodeVersion 以 v2/2. 开头 → 紫色 V2Runtime 标注（对齐原型 v2.0.0-beta.1）。
 * - 实时性：worker.heartbeat SSE 需 T9 事件回流（未实现，server 当前不 emit）→ 轮询 10s
 *   （与心跳周期同频，refetchInterval）+ 1s tick 重算相对心跳时间。
 * - 注册指引（MUST DO）：折叠面板展示 X_WORKER_TOKEN 配置 + start.sh 部署步骤（内容取自
 *   worker/.env.example 与 worker/scripts/start.sh）；「新增 Worker」按钮（原型 add-worker-button）
 *   展开/收起面板——后端无新增端点，注册由 worker 进程 outbound 完成（"注册即入池"架构）。
 * - 操作按钮（查看详情/重启/下线）：保持原型占位（无 onClick）——后端无对应端点，
 *   T10 LifecycleManager 接入 WorkerClient 后实现（对齐 users 页"编辑按钮占位"模式）。
 * - data-testid 与原型一致：worker-list-root/worker-stats/add-worker-button/worker-card/
 *   worker-status/worker-version/worker-capability/worker-load/worker-heartbeat/
 *   worker-actions/worker-detail-button/worker-restart-button/worker-offline-button/
 *   worker-pool-hint；注册指引为页面扩展：worker-guide。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { EmptyState } from "@/src/components/ui";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 轮询周期（ms）：与 worker 心跳周期（10s）同频，server 30s 判离线前可捕捉状态翻转。 */
const POLL_INTERVAL_MS = 10_000;

/* ------------------------------ Worker 状态主题（原型 :40-44 逐 token，未入 tokens.ts） ------------------------------
 * 后端三态（online/offline/degraded）映射原型三态（在线/离线/维护中），色值同族于
 * statusColors：绿=在线 / 琥珀=维护中（degraded）/ 红=离线。语义独立于任务四态，
 * 遵循"扩展 token"范式在页面内定义具名常量并注释原因，不扩散共享层。
 */
const WORKER_STATUS_LABEL = {
  online: "在线",
  offline: "离线",
  degraded: "维护中",
} as const;

type WorkerStatusKey = keyof typeof WORKER_STATUS_LABEL;
type WorkerStatusLabel = (typeof WORKER_STATUS_LABEL)[WorkerStatusKey];

const workerStatusTheme: Record<
  WorkerStatusLabel,
  { color: string; bg: string; border: string }
> = {
  在线: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  维护中: { color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  离线: { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
};

/** 负载档位色（原型 :47-51）：高（红）/ 中（琥珀）/ 低（绿） */
function loadColor(pct: number): string {
  if (pct >= 75) return "#DC2626";
  if (pct >= 50) return "#D97706";
  return "#10B981";
}

/** 呼吸动画（scoped：workerpulse 前缀避免污染其他页面） */
const pulseCss = `
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

/** GET /workers 条目（对齐 schema Worker 对外视图）。 */
interface WorkerItem {
  id: string;
  name: string | null;
  opencodeVersion: string;
  capabilities: { maxInstances: number; skills?: string[]; tools?: string[] };
  load: { instances: number } | null;
  status: WorkerStatusKey;
  lastHeartbeatAt: string | null;
  registeredAt: string;
}

/* ------------------------------ 相对时间（原型 heartbeat 字段"3 秒前"格式） ------------------------------ */

/** ISO 时间 → 相对时间文案；null（从未上报）返回占位。 */
function formatRelativeTime(iso: string | null, now: number): string {
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

/* ------------------------------ 子组件 ------------------------------ */

/** 状态徽章（worker 三态：在线 / 离线 / 维护中；在线带脉冲动画，原型 :167-204） */
function WorkerStatusBadge({ status }: { status: WorkerStatusKey }) {
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

/** Worker 卡片：对齐 07 篇 11.2 注册字段 + 11.4 生命周期操作（原型 :207-456） */
function WorkerCard({ worker, now }: { worker: WorkerItem; now: number }) {
  const label = WORKER_STATUS_LABEL[worker.status];
  const theme = workerStatusTheme[label];
  const isOnline = worker.status === "online";

  /* 能力声明（11.2）：并发上限 + skill/tool 数量 */
  const maxInstances = worker.capabilities.maxInstances ?? 0;
  const skillCount = worker.capabilities.skills?.length ?? 0;
  const toolCount = worker.capabilities.tools?.length ?? 0;

  /* 负载（11.2）：实例占用率驱动进度条（后端无 CPU 上报，取 load 真实语义） */
  const instances = worker.load?.instances ?? 0;
  const loadPct = maxInstances > 0 ? Math.round((instances / maxInstances) * 100) : 0;

  /* v2 标识：版本号 v2.x / 2.x 开头（对齐原型 v2.0.0-beta.1 → V2Runtime） */
  const isV2 = /^v?2\./.test(worker.opencodeVersion);

  const card: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: `${space.xl}px`,
    borderRadius: radius.lg,
    backgroundColor: "#FFFFFF",
    /* 原型笔误修正：`theme.status` 不存在恒取 theme.border；按意图离线卡片用灰边框淡化 */
    border: `1px solid ${worker.status === "offline" ? neutral[200] : theme.border}`,
    boxShadow: isOnline ? shadow.md : shadow.sm,
    opacity: isOnline ? 1 : 0.86,
    ...baseFont,
  };

  return (
    <section
      data-testid="worker-card"
      data-worker-id={worker.id}
      data-status={label}
      style={card}
    >
      {/* 头部：workerId（mono）+ 状态徽章 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              flexShrink: 0,
              backgroundColor: theme.color,
              color: theme.color,
              animation: isOnline ? "workerpulse-blink 2s ease-in-out infinite" : undefined,
            }}
          />
          <span
            style={{
              fontSize: fontSize.lg,
              fontWeight: 600,
              color: neutral[900],
              fontFamily: fontFamily.mono,
              letterSpacing: "-0.02em",
            }}
          >
            {worker.id}
          </span>
        </div>
        <WorkerStatusBadge status={worker.status} />
      </div>

      {/* 版本 + 节点名称（后端无 address 字段 → 展示注册名 name，缺省 hostname 语义） */}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <span
          data-testid="worker-version"
          data-v2={isV2 ? "true" : "false"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            fontSize: fontSize.sm,
            fontWeight: 600,
            color: isV2 ? "#7C3AED" : neutral[600],
            backgroundColor: isV2 ? "#F5F3FF" : neutral[100],
            border: `1px solid ${isV2 ? "#DDD6FE" : neutral[200]}`,
            padding: "2px 8px",
            borderRadius: radius.pill,
            fontFamily: fontFamily.mono,
          }}
        >
          {isV2 && <span aria-hidden style={{ fontSize: fontSize.xs }}>⬢</span>}
          {worker.opencodeVersion}
          {isV2 && (
            <span aria-hidden style={{ fontWeight: 400, opacity: 0.7 }}>· V2Runtime</span>
          )}
        </span>
        <span style={{ fontSize: fontSize.sm, color: neutral[400], fontFamily: fontFamily.mono }}>
          {worker.name ?? "未命名节点"}
        </span>
      </div>

      {/* 能力声明：并发上限 + skill/tool 数量（11.2 能力声明） */}
      <div data-testid="worker-capability" style={{ display: "flex", gap: space.md }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[100]}`,
          }}
        >
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>并发上限</span>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
            {maxInstances}
            <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[400], marginLeft: 2 }}>并发</span>
          </span>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[100]}`,
          }}
        >
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>可用能力</span>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
            {skillCount}
            <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[400], marginLeft: 2 }}>skill</span>
            <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[300], margin: "0 4px" }}>·</span>
            {toolCount}
            <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[400], marginLeft: 2 }}>tool</span>
          </span>
        </div>
      </div>

      {/* 负载：实例数 + 占用率进度条（11.2 负载上报） */}
      <div data-testid="worker-load" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>
            负载 · <span style={{ fontWeight: 600, color: neutral[800] }}>{instances}</span> 个实例
          </span>
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: loadColor(loadPct) }}>
            占用 {loadPct}%
          </span>
        </div>
        <div
          aria-hidden
          style={{
            width: "100%",
            height: 6,
            borderRadius: radius.pill,
            backgroundColor: neutral[100],
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${loadPct}%`,
              height: "100%",
              borderRadius: radius.pill,
              backgroundColor: loadColor(loadPct),
              transition: "width .4s ease",
            }}
          />
        </div>
      </div>

      {/* 心跳时间（11.4 心跳检测）：在线脉冲指示 */}
      <div
        data-testid="worker-heartbeat"
        data-online={isOnline ? "true" : "false"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.xs,
          fontSize: fontSize.sm,
          color: isOnline ? neutral[500] : neutral[400],
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            backgroundColor: isOnline ? "#10B981" : "#CBD5E1",
            color: "#10B981",
            animation: isOnline ? "workerpulse-ring 1.8s ease-out infinite" : undefined,
          }}
        />
        上次心跳 {formatRelativeTime(worker.lastHeartbeatAt, now)}
        <span style={{ marginLeft: "auto", color: neutral[300] }}>♥ {isOnline ? "活跃" : "失联"}</span>
      </div>

      {/* 操作：查看详情 / 重启 / 下线（原型占位；T10 LifecycleManager 接入 WorkerClient 后实现） */}
      <div
        data-testid="worker-actions"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          borderTop: `1px solid ${neutral[100]}`,
          paddingTop: space.md,
        }}
      >
        <button
          type="button"
          data-testid="worker-detail-button"
          data-worker-id={worker.id}
          style={{
            flex: 1,
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "#FFFFFF",
            color: neutral[700],
            fontSize: fontSize.md,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          查看详情
        </button>
        <button
          type="button"
          data-testid="worker-restart-button"
          disabled={!isOnline}
          style={{
            flex: 1,
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${isOnline ? neutral[300] : neutral[100]}`,
            backgroundColor: isOnline ? neutral[50] : neutral[100],
            color: isOnline ? neutral[700] : neutral[400],
            fontSize: fontSize.md,
            cursor: isOnline ? "pointer" : "not-allowed",
            fontFamily: fontFamily.body,
          }}
        >
          重启
        </button>
        <button
          type="button"
          data-testid="worker-offline-button"
          disabled={!isOnline}
          style={{
            flex: 1,
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: "1px solid transparent",
            backgroundColor: isOnline ? workerStatusTheme["离线"].bg : neutral[100],
            color: isOnline ? workerStatusTheme["离线"].color : neutral[400],
            fontSize: fontSize.md,
            cursor: isOnline ? "pointer" : "not-allowed",
            fontFamily: fontFamily.body,
          }}
        >
          下线
        </button>
      </div>
    </section>
  );
}

/** 注册指引（MUST DO）：X_WORKER_TOKEN 配置 + start.sh 部署步骤（worker/.env.example + scripts/start.sh）。 */
const GUIDE_STEPS: { title: string; body: string; code: string }[] = [
  {
    title: "配置 token",
    body: "复制 .env.example 为 .env 并填写 X_WORKER_TOKEN——注册鉴权 token，需与 server 侧约定一致（对应 X-Worker-Token header）。",
    code: "cd worker\ncp .env.example .env   # 填入 X_WORKER_TOKEN",
  },
  {
    title: "安装构建",
    body: "安装依赖并编译（Node >= 18，opencode CLI 需在 PATH 中）。",
    code: "npm install\nnpm run build",
  },
  {
    title: "启动注册",
    body: "start.sh 自动校验 opencode CLI、加载 .env、构建缺省 dist 后启动；启动即向控制面注册（POST /workers/register），随后每 10s 上报心跳，30s 未上报自动标记离线。",
    code: "./scripts/start.sh",
  },
];

function WorkerGuide() {
  return (
    <div
      data-testid="worker-guide"
      style={{
        marginBottom: space.lg,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        overflow: "hidden",
        ...baseFont,
      }}
    >
      {/* 头部 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          padding: `${space.md}px ${space.lg}px`,
          borderBottom: `1px solid ${neutral[200]}`,
          backgroundColor: neutral[50],
          fontSize: fontSize.md,
          fontWeight: 600,
          color: neutral[700],
        }}
      >
        <span aria-hidden style={{ color: "#2563EB" }}>⚙</span>
        部署指引 · 新节点注册即自动入池
      </div>

      {/* 步骤 */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.lg, padding: `${space.lg}px` }}>
        {GUIDE_STEPS.map((step, i) => (
          <div key={step.title} style={{ display: "flex", gap: space.md }}>
            <span
              aria-hidden
              style={{
                width: 24,
                height: 24,
                flexShrink: 0,
                borderRadius: "50%",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#EFF6FF",
                border: `1px solid ${"#BFDBFE"}`,
                color: "#2563EB",
                fontSize: fontSize.sm,
                fontWeight: 600,
              }}
            >
              {i + 1}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
                {step.title}
              </div>
              <div style={{ fontSize: fontSize.sm, color: neutral[400], lineHeight: 1.7, marginTop: 2 }}>
                {step.body}
              </div>
              <pre
                style={{
                  marginTop: space.sm,
                  marginBottom: 0,
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: radius.md,
                  backgroundColor: neutral[900],
                  color: "#E2E8F0",
                  fontSize: fontSize.sm,
                  lineHeight: 1.7,
                  overflowX: "auto",
                  fontFamily: fontFamily.mono,
                  whiteSpace: "pre",
                }}
              >
                {step.code}
              </pre>
            </div>
          </div>
        ))}
      </div>

      {/* 底部说明：SERVER_URL 与心跳参数 */}
      <div
        style={{
          padding: `${space.md}px ${space.lg}px`,
          borderTop: `1px dashed ${neutral[200]}`,
          fontSize: fontSize.sm,
          color: neutral[400],
          lineHeight: 1.7,
          backgroundColor: neutral[50],
        }}
      >
        <span style={{ fontWeight: 600, color: neutral[500] }}>参数说明</span> ·
        SERVER_URL 指向控制面地址（缺省 http://localhost:3000）；HEARTBEAT_INTERVAL_MS 缺省
        10000ms（server 30s=3 周期未收心跳判离线）；OPENCODE_SERVE_PORT=0 表示随机端口。
        完整环境变量见 worker/.env.example。
      </div>
    </div>
  );
}

/* ------------------------------ 页面主组件（AppShell 内容区） ------------------------------ */

export default function WorkersPage() {
  const token = useAuthStore((s) => s.token);

  /* 注册指引折叠面板受控开关：默认关闭；首次加载完成且无 worker 时自动展开 */
  const [guideOpen, setGuideOpen] = useState(false);

  /* 1s tick：驱动各卡片相对心跳时间重算（数据本身由轮询刷新） */
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["workers"],
    queryFn: () => api.get<WorkerItem[]>("/workers"),
    enabled: !!token,
    /* 实时性：worker.heartbeat SSE 需 T9 事件回流（未实现）→ 轮询与心跳周期同频 */
    refetchInterval: POLL_INTERVAL_MS,
  });

  const items = data ?? [];

  /* 首次加载完成且无 worker → 自动展开部署指引（空态下引导优先） */
  useEffect(() => {
    if (!isPending && items.length === 0) setGuideOpen(true);
  }, [isPending, items.length]);

  const onlineCount = items.filter((w) => w.status === "online").length;
  const offlineCount = items.filter((w) => w.status === "offline").length;
  const degradedCount = items.filter((w) => w.status === "degraded").length;

  /* 统计条（对齐原型 4 卡；在线卡带脉冲动画） */
  const stats = [
    { label: "在线节点", value: onlineCount, theme: workerStatusTheme["在线"], pulse: true },
    { label: "离线节点", value: offlineCount, theme: workerStatusTheme["离线"], pulse: false },
    { label: "维护中", value: degradedCount, theme: workerStatusTheme["维护中"], pulse: false },
    { label: "节点总数", value: items.length, theme: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" }, pulse: false },
  ];

  return (
    <div
      data-testid="worker-list-root"
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`,
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
      }}
    >
      <style>{pulseCss}</style>

      {/* 状态统计条（11.2：控制面可见在线节点列表） */}
      <div
        data-testid="worker-stats"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: space.md,
          marginBottom: space.xl,
        }}
      >
        {stats.map((s) => (
          <div
            key={s.label}
            data-stat={s.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.md,
              padding: `${space.lg}px ${space.xl}px`,
              borderRadius: radius.lg,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.sm,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                flexShrink: 0,
                backgroundColor: s.theme.color,
                color: s.theme.color,
                animation: s.pulse ? "workerpulse-ring 1.8s ease-out infinite" : undefined,
              }}
            />
            <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>{s.label}</span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: fontSize.xxl,
                fontWeight: 700,
                color: s.theme.color,
                lineHeight: 1,
              }}
            >
              {s.value}
            </span>
          </div>
        ))}
      </div>

      {/* 操作行：「新增 Worker」按钮展开注册指引（11.4 水平扩容：新 worker 注册即入池） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: space.lg,
        }}
      >
        <div>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
            Worker 节点池
          </div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
            {items.length} 个节点 · 在线 {onlineCount} 个 · 新节点注册即自动入池
          </div>
        </div>
        <button
          type="button"
          data-testid="add-worker-button"
          data-open={guideOpen ? "true" : "false"}
          aria-expanded={guideOpen}
          onClick={() => setGuideOpen((v) => !v)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm + 2}px ${space.lg}px`,
            borderRadius: radius.pill,
            border: "none",
            backgroundColor: "#2563EB",
            color: "#FFFFFF",
            fontSize: fontSize.md,
            fontWeight: 500,
            cursor: "pointer",
            boxShadow: "0 6px 16px rgba(37,99,235,.3)",
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>+</span>
          新增 Worker
        </button>
      </div>

      {/* 注册指引（可折叠面板）：空态自动展开，也可手动开关 */}
      {guideOpen && <WorkerGuide />}

      {/* Worker 卡片网格 / 空状态 */}
      {isPending ? (
        <div
          data-testid="workers-loading"
          style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}
        >
          加载中…
        </div>
      ) : isError ? (
        <div
          data-testid="workers-error"
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: space.md,
            padding: `${space.xxl}px`,
            textAlign: "center",
            borderRadius: radius.lg,
            backgroundColor: "#FFFFFF",
            border: `1px solid ${neutral[200]}`,
          }}
        >
          <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
            {isApiError(error) ? error.message : "加载 Worker 列表失败"}
          </div>
          <button
            type="button"
            data-testid="workers-retry"
            onClick={() => refetch()}
            style={{
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            重试
          </button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="暂无 Worker 节点"
          description="部署并注册第一个 worker，节点注册即自动入池（见上方部署指引）"
          icon={<span aria-hidden>⚙</span>}
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: space.lg,
          }}
        >
          {items.map((w) => (
            <WorkerCard key={w.id} worker={w} now={now} />
          ))}
        </div>
      )}

      {/* 底部说明（11.4：心跳超时标记离线，其上任务组进入待重调度） */}
      <div
        data-testid="worker-pool-hint"
        style={{
          marginTop: space.xl,
          padding: `${space.md}px ${space.lg}px`,
          borderRadius: radius.md,
          backgroundColor: "#FFFFFF",
          border: `1px dashed ${neutral[200]}`,
          fontSize: fontSize.sm,
          color: neutral[400],
          lineHeight: 1.7,
          ...baseFont,
        }}
      >
        <span style={{ fontWeight: 600, color: neutral[500] }}>生命周期提示</span> ·
        心跳超时（连续 30 秒 = 3 个心跳周期未上报）自动标记离线，其上的任务组按亲和与负载策略
        迁移到存活节点；新增节点无需重启控制面，注册即入池（水平扩容）。
      </div>
    </div>
  );
}
