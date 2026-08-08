/**
 * 原型：Worker 节点列表（分布式 Worker 架构 · 07 篇 11.2 / 11.4）
 * =============================================
 * 对应 07 篇第 11 章分布式 Worker 架构：控制面（平台服务端）与数据面（Worker 节点池）分离，
 * worker 启动后主动 outbound 向控制面注册（POST /api/workers/register）并维持心跳，
 * 控制面通过 Worker 注册表 + 心跳检测 + 生命周期管理（启停 / 自愈 / 扩容）运维节点池。
 *
 * 页面内容：
 * - 状态统计条（在线 / 离线 / 维护中 / 总数）+ Worker 卡片网格 + 「新增 Worker」按钮。
 * - 每张 Worker 卡片对齐 11.2（注册上报字段）与 11.4（生命周期）：
 *   workerId / 运行状态（心跳检测）/ opencodeVersion（v1.18.14 与 v2 混合）/
 *   能力（并发上限 + 可用 skill/tool 数量）/ 负载（任务组数量 + CPU 使用率进度条）/
 *   心跳时间 / 操作（查看详情 / 重启 / 下线，对应 POST /stop 优雅、/kill 强制与下线）。
 * - mock 4 个 worker：在线×2（v2.0.0-beta.1 与 v1.18.14 混合）+ 离线×1 + 维护中×1。
 * - 复用 ../_shared/nav（NavDock / NavTopBar / CmdKPanel）+ ../_shared/styles token。
 * - ⚠️ T15 铁律：root height:100% + position:relative，浮层 absolute，零 fixed / vh / vw。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起态宽度（与 _shared/nav RAIL_W 对齐），内容区避让留白 */
const RAIL_W = 56;

/* ------------------------------ Worker 状态主题 ------------------------------ */
/** worker 运行状态（对齐 11.4 心跳检测；色值与 styles.statusColors 同族：绿=在线/琥珀=维护/红=离线） */
export type WorkerStatus = "在线" | "离线" | "维护中";

const workerStatusTheme: Record<WorkerStatus, { color: string; bg: string; border: string }> = {
  在线: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  维护中: { color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  离线: { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
};

/** CPU 负载档位色：低（绿）/ 中（琥珀）/ 高（红） */
function cpuColor(cpu: number): string {
  if (cpu >= 75) return "#DC2626";
  if (cpu >= 50) return "#D97706";
  return "#10B981";
}

/* ------------------------------ Mock 数据（对齐 07 篇 11.2 注册上报字段） ------------------------------ */
interface WorkerInfo {
  workerId: string;
  status: WorkerStatus;
  opencodeVersion: string;
  /** 能力声明：并发上限 */
  concurrency: number;
  /** 能力声明：可用 skill 数量 */
  skills: number;
  /** 能力声明：可用 tool 数量 */
  tools: number;
  /** 负载：任务组数量 */
  taskGroups: number;
  /** 负载：CPU 使用率（%） */
  cpu: number;
  /** 上次心跳（相对时间展示） */
  heartbeat: string;
  /** 节点地址（WorkerServer HTTP 端点） */
  address: string;
  /** v2 标识（v2.0.0-beta.1 节点标注 v2 runtime） */
  isV2: boolean;
}

const workers: WorkerInfo[] = [
  {
    workerId: "worker-01",
    status: "在线",
    opencodeVersion: "v2.0.0-beta.1",
    concurrency: 8,
    skills: 12,
    tools: 24,
    taskGroups: 3,
    cpu: 42,
    heartbeat: "3 秒前",
    address: "10.0.8.21:18080",
    isV2: true,
  },
  {
    workerId: "worker-02",
    status: "在线",
    opencodeVersion: "v1.18.14",
    concurrency: 6,
    skills: 9,
    tools: 18,
    taskGroups: 2,
    cpu: 28,
    heartbeat: "8 秒前",
    address: "10.0.8.22:18080",
    isV2: false,
  },
  {
    workerId: "worker-03",
    status: "离线",
    opencodeVersion: "v1.18.14",
    concurrency: 4,
    skills: 7,
    tools: 14,
    taskGroups: 0,
    cpu: 0,
    heartbeat: "12 分钟前",
    address: "10.0.8.23:18080",
    isV2: false,
  },
  {
    workerId: "worker-04",
    status: "维护中",
    opencodeVersion: "v1.18.14",
    concurrency: 4,
    skills: 7,
    tools: 14,
    taskGroups: 0,
    cpu: 0,
    heartbeat: "2 分钟前",
    address: "10.0.8.24:18080",
    isV2: false,
  },
];

/* 统计条数据 */
const stats = [
  { label: "在线节点", value: 2, theme: workerStatusTheme["在线"], pulse: true },
  { label: "离线节点", value: 1, theme: workerStatusTheme["离线"], pulse: false },
  { label: "维护中", value: 1, theme: workerStatusTheme["维护中"], pulse: false },
  { label: "节点总数", value: workers.length, theme: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" }, pulse: false },
];

/* Cmd+K 命令项：导航组图标与 Dock 一一对应，「Worker 节点」高亮呼应当前页 */
const CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙", active: true },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "操作", label: "新增 Worker", icon: "＋" },
  { group: "操作", label: "查看心跳日志", icon: "◷" },
];

/* 呼吸动画（scoped：workerpulse 前缀避免污染其他原型） */
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

/* ------------------------------ 子组件 ------------------------------ */

/** 状态徽章（worker 三态：在线 / 离线 / 维护中） */
function WorkerStatusBadge({ status }: { status: WorkerStatus }) {
  const theme = workerStatusTheme[status];
  return (
    <span
      data-testid="worker-status"
      data-status={status}
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
          animation: status === "在线" ? "workerpulse-ring 1.6s ease-out infinite" : undefined,
        }}
      />
      {status}
    </span>
  );
}

/** Worker 卡片：对齐 07 篇 11.2 注册字段 + 11.4 生命周期操作 */
function WorkerCard({ worker }: { worker: WorkerInfo }) {
  const theme = workerStatusTheme[worker.status];
  const isOnline = worker.status === "在线";

  const card: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: `${space.xl}px`,
    borderRadius: radius.lg,
    backgroundColor: "#FFFFFF",
    border: `1px solid ${theme.status === "离线" ? neutral[200] : theme.border}`,
    boxShadow: isOnline ? shadow.md : shadow.sm,
    opacity: isOnline ? 1 : 0.86,
    ...baseFont,
  };

  return (
    <section data-testid="worker-card" data-worker-id={worker.workerId} data-status={worker.status} style={card}>
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
            {worker.workerId}
          </span>
        </div>
        <WorkerStatusBadge status={worker.status} />
      </div>

      {/* 版本 + 节点地址 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <span
          data-testid="worker-version"
          data-v2={worker.isV2 ? "true" : "false"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            fontSize: fontSize.sm,
            fontWeight: 600,
            color: worker.isV2 ? "#7C3AED" : neutral[600],
            backgroundColor: worker.isV2 ? "#F5F3FF" : neutral[100],
            border: `1px solid ${worker.isV2 ? "#DDD6FE" : neutral[200]}`,
            padding: "2px 8px",
            borderRadius: radius.pill,
            fontFamily: fontFamily.mono,
          }}
        >
          {worker.isV2 && <span aria-hidden style={{ fontSize: fontSize.xs }}>⬢</span>}
          {worker.opencodeVersion}
          {worker.isV2 && (
            <span aria-hidden style={{ fontWeight: 400, opacity: 0.7 }}>· V2Runtime</span>
          )}
        </span>
        <span style={{ fontSize: fontSize.sm, color: neutral[400], fontFamily: fontFamily.mono }}>
          {worker.address}
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
            {worker.concurrency}
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
            {worker.skills}
            <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[400], marginLeft: 2 }}>skill</span>
            <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[300], margin: "0 4px" }}>·</span>
            {worker.tools}
            <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[400], marginLeft: 2 }}>tool</span>
          </span>
        </div>
      </div>

      {/* 负载：任务组数量 + CPU 使用率进度条（11.2 负载上报） */}
      <div data-testid="worker-load" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>
            负载 · <span style={{ fontWeight: 600, color: neutral[800] }}>{worker.taskGroups}</span> 个任务组
          </span>
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: cpuColor(worker.cpu) }}>
            CPU {worker.cpu}%
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
              width: `${worker.cpu}%`,
              height: "100%",
              borderRadius: radius.pill,
              backgroundColor: cpuColor(worker.cpu),
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
        上次心跳 {worker.heartbeat}
        <span style={{ marginLeft: "auto", color: neutral[300] }}>♥ {isOnline ? "活跃" : "失联"}</span>
      </div>

      {/* 操作：查看详情 / 重启 / 下线（11.4 生命周期：POST /stop 优雅、/kill 强制、下线） */}
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
          data-worker-id={worker.workerId}
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

/* ------------------------------ 页面主组件 ------------------------------ */

function WorkerListPage() {
  /* Cmd+K 命令面板受控开关（T20）：默认关闭，⌘K 触发框打开，✕/遮罩/Esc 关闭 */
  const [cmdkOpen, setCmdkOpen] = useState(false);

  return (
    <div
      data-testid="worker-list-root"
      style={{
        height: "100%",
        minHeight: 720,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
      }}
    >
      <style>{pulseCss}</style>

      {/* 浅色顶栏（文档流顶部，height 60） */}
      <NavTopBar
        title="Worker 节点管理"
        subtitle="控制面 / 数据面分离 · 节点池注册与心跳"
        userName="运营者"
        userRole="平台管理员"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：左侧 paddingLeft 80px 留白避让 Dock */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: `${space.xl}px ${space.xl}px ${space.xl}px ${RAIL_W + space.xl}px`,
        }}
      >
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

        {/* 操作行：「新增 Worker」按钮（11.4 水平扩容：新 worker 注册即入池） */}
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
              {workers.length} 个节点 · 在线 {workers.filter((w) => w.status === "在线").length} 个 · 新节点注册即自动入池
            </div>
          </div>
          <button
            type="button"
            data-testid="add-worker-button"
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

        {/* Worker 卡片网格 */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: space.lg,
          }}
        >
          {workers.map((w) => (
            <WorkerCard key={w.workerId} worker={w} />
          ))}
        </div>

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
          心跳超时（连续 N 个周期未上报）自动标记离线，其上的任务组按亲和与负载策略迁移到存活节点；
          新增节点无需重启控制面，注册即入池（水平扩容）。
        </div>
      </main>

{/* 左侧 Dock 悬浮导航：activeKey="workers"（Worker 运行节点域） */}
<NavDock activeKey="workers" projectName="Agent 协作平台" />

      {/* Cmd+K 命令面板：受控开关（T20）——初始关闭，trigger 打开，✕/遮罩/Esc 关闭 */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "worker-list",
    name: "Worker 节点管理",
    group: "平台",
    description:
      "Worker 节点列表：状态统计条（在线/离线/总数）+ 节点卡片（workerId/版本/能力/负载/心跳）+ 新增 Worker 入口",
    device: "desktop",
  },
  Component: WorkerListPage,
};

export default def;
