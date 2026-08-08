/**
 * 原型：任务看板（device: desktop）
 * =============================================
 * 对应 PRD 任务全貌：融合导航（Dock 悬浮导航 + 浅色顶栏 + Cmd+K 命令面板）+ 状态筛选
 * （全部/待开始/进行中/待验收/已完成/已归档）+ 任务卡片列表（标题 / 状态徽章 / 参与
 * Agent 头像 / 产出物数量）。
 * - 状态机 5 态（PRD 03 FR-03 已更新）：待开始 → 进行中 → 待验收 → 已完成 → 已归档；
 *   「待开始」为创建后默认状态，由成员点击「开始任务」触发进入「进行中」（FR-18）。
 * - 复用 _shared/nav.tsx：NavDock（activeKey="board"，任务看板高亮）/ NavTopBar
 *   （title="任务看板"，onCmdKClick 打开面板）/ CmdKPanel（受控开关：useState 管理
 *   open，默认关闭，点击 trigger 打开，✕ / 遮罩 / Esc 关闭）。
 * - 纯静态展示：筛选为静态 mock（默认「全部」激活），不实现筛选/排序逻辑。
 * - mock 5 个任务覆盖 5 种状态，与 PRD 状态机一致；「待开始」卡片带「开始任务」按钮，
 *   点击展示启动前检查提示（未选 Agent 先选 / 多 Agent 指定主 Agent，FR-18/19）。
 * - 「待开始」配色在页面内本地定义（灰蓝 #475569 系，WAITING_STATUS），不修改
 *   _shared/styles.ts；非待开始状态复用 _shared StatusBadge。
 * - data-testid：status-filter（筛选条）、task-card（每张卡片）、start-task-button /
 *   start-task-hint（待开始卡片）、rail-bar/topbar/cmdk-trigger/cmdk-panel（融合导航，
 *   来自 _shared/nav）。
 * - ⚠️ T15 铁律：root height:100% + position:relative，全部浮层 absolute 相对宿主，
 *   零 fixed / 100vh / 100vw。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { AgentAvatar, StatusBadge } from "../_shared/components";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import {
  type RoleKey,
  type StatusKey,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 待开始状态（页面内本地定义，不动 _shared） ------------------------------ */
/** 看板状态 = 共享 StatusKey(4 态) + 新增「待开始」（PRD 03 FR-03 状态机 5 态） */
type BoardStatus = StatusKey | "待开始";

/** 「待开始」本地配色：灰蓝 #475569 系（与已归档灰 #64748B 区分，偏深偏冷） */
const WAITING_STATUS = {
  color: "#475569",
  bg: "#F8FAFC",
  border: "#CBD5E1",
} as const;

/** 待开始徽章（仿 StatusBadge 视觉，仅用于「待开始」，其余状态仍走共享 StatusBadge） */
function WaitingBadge() {
  return (
    <span
      data-testid="status-badge"
      data-status="待开始"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: WAITING_STATUS.bg,
        border: `1px solid ${WAITING_STATUS.border}`,
        color: WAITING_STATUS.color,
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
          backgroundColor: WAITING_STATUS.color,
          flexShrink: 0,
        }}
      />
      待开始
    </span>
  );
}

/** 按状态渲染徽章：「待开始」用本地 WaitingBadge，其余复用共享 StatusBadge */
function renderStatusBadge(status: BoardStatus) {
  return status === "待开始" ? <WaitingBadge /> : <StatusBadge status={status} />;
}

/* ------------------------------ Mock 任务（覆盖 5 种状态） ------------------------------ */
interface MockTask {
  id: string;
  title: string;
  desc: string;
  status: BoardStatus;
  members: RoleKey[];
  artifactCount: number;
  updateTime: string;
}

const tasks: MockTask[] = [
  {
    id: "T-1044",
    title: "通知中心迭代",
    desc: "群聊消息聚合与已读状态同步，待确认 Agent 团队后人工启动。",
    status: "待开始",
    members: ["product", "architect", "developer"],
    artifactCount: 0,
    updateTime: "2026-08-06 14:05",
  },
  {
    id: "T-1042",
    title: "智能报表模块",
    desc: "按渠道 / 时间维度聚合生成日周月报表，支持 CSV 导出。",
    status: "待验收",
    members: ["product", "architect", "developer", "tester"],
    artifactCount: 3,
    updateTime: "2026-08-06 09:15",
  },
  {
    id: "T-1043",
    title: "数据采集优化",
    desc: "采集任务并发与断点续传优化，降低高峰时段的丢点率。",
    status: "进行中",
    members: ["developer", "architect"],
    artifactCount: 2,
    updateTime: "2026-08-06 11:40",
  },
  {
    id: "T-1041",
    title: "告警中心配置",
    desc: "告警规则编排与飞书通知触达，已完成全量联调。",
    status: "已完成",
    members: ["product", "tester"],
    artifactCount: 4,
    updateTime: "2026-08-05 18:02",
  },
  {
    id: "T-1012",
    title: "日志检索性能优化",
    desc: "检索索引重构与缓存策略落地，阶段性任务已归档。",
    status: "已归档",
    members: ["developer"],
    artifactCount: 1,
    updateTime: "2026-07-30 16:20",
  },
];

/* ------------------------------ 状态筛选（静态，默认「全部」激活） ------------------------------ */
const filters: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "待开始", label: "待开始" },
  { key: "进行中", label: "进行中" },
  { key: "待验收", label: "待验收" },
  { key: "已完成", label: "已完成" },
  { key: "已归档", label: "已归档" },
];

/* ------------------------------ 融合导航（复用 _shared/nav） ------------------------------ */
/** Dock 收起宽度（与 _shared/nav.tsx RAIL_W 一致），内容区用其 + 间距留白避让 */
const RAIL_W = 56;

/** Dock 展开面板底部：任务状态分布统计 */
const statusStats = tasks.reduce<Record<BoardStatus, number>>(
  (acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  },
  { "待开始": 0, "进行中": 0, "待验收": 0, "已完成": 0, "已归档": 0 },
);

/** Cmd+K 命令面板项：导航组图标与 Dock 一一对应，当前页「任务看板」高亮 */
const cmdkItems: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰", active: true },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "操作", label: "新建任务", icon: "＋" },
  { group: "操作", label: "查看产出物", icon: "▦" },
  { group: "操作", label: "查看 Agent 会话", icon: "◷" },
];

/* ================================ 任务卡片 ================================ */
function TaskCard({ task }: { task: MockTask }) {
  // 「开始任务」确认提示（FR-18/19 静态展示）：点击按钮展开/收起，仅待开始卡片渲染
  const [hintOpen, setHintOpen] = useState(false);
  const isWaiting = task.status === "待开始";
  return (
    <section
      data-testid="task-card"
      data-task-id={task.id}
      data-status={task.status}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.md,
        padding: `${space.xl}px`,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        transition: "box-shadow .15s ease",
      }}
    >
      {/* 头部：编号 + 状态 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <span
          style={{
            fontSize: fontSize.xs,
            color: neutral[400],
            fontWeight: 500,
            fontFamily: fontFamily.mono,
          }}
        >
          {task.id}
        </span>
        {renderStatusBadge(task.status)}
      </div>

      {/* 标题 + 描述 */}
      <div>
        <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
          {task.title}
        </div>
        <div
          style={{
            fontSize: fontSize.sm,
            color: neutral[400],
            marginTop: space.xs,
            lineHeight: 1.6,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {task.desc}
        </div>
      </div>

      {/* 底部：参与 Agent 头像组 + 产出物数量 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: space.md,
          borderTop: `1px solid ${neutral[100]}`,
        }}
      >
        <div data-testid="task-members" style={{ display: "flex", alignItems: "center" }}>
          {task.members.map((role, idx) => (
            <span key={role} style={{ marginLeft: idx === 0 ? 0 : -6 }}>
              <AgentAvatar role={role} size="sm" />
            </span>
          ))}
        </div>
        <span
          data-testid="task-artifact-count"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            fontSize: fontSize.xs,
            color: neutral[500],
            fontWeight: 500,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>
            ▤
          </span>
          {task.artifactCount} 项产出物
        </span>
      </div>

      {/* 待开始：开始任务（FR-18/19） */}
      {isWaiting && (
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <button
            type="button"
            data-testid="start-task-button"
            onClick={() => setHintOpen((v) => !v)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: space.xs,
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: WAITING_STATUS.color,
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: fontFamily.body,
              transition: "background-color .15s ease",
            }}
          >
            <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>▶</span>
            开始任务
          </button>
          {hintOpen && (
            <div
              data-testid="start-task-hint"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: space.xs,
                padding: `${space.sm + 2}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: WAITING_STATUS.bg,
                border: `1px solid ${WAITING_STATUS.border}`,
                fontSize: fontSize.sm,
                lineHeight: 1.6,
                color: neutral[600],
              }}
            >
              <div style={{ fontWeight: 600, color: WAITING_STATUS.color }}>
                开始前检查
              </div>
              <div>未选择 Agent 将先弹出 Agent 选择；多 Agent 需指定主 Agent 作为任务负责人（默认产品经理）。</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ================================ 页面 ================================ */
function TaskBoardPage() {
  // Cmd+K 命令面板受控开关（T19）：默认关闭，trigger 打开，✕ / 遮罩 / Esc 关闭
  const [cmdkOpen, setCmdkOpen] = useState(false);
  return (
    <div
      data-testid="task-board-root"
      style={{ height: "100%", minHeight: 720, position: "relative", backgroundColor: neutral[100], ...baseFont }}
    >
      {/* 顶栏（文档流顶部）：标题 + Cmd+K 触发框 + 用户 */}
      <NavTopBar
        title="任务看板"
        subtitle={`${tasks.length} 个任务 · 4 个 Agent 在线`}
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：状态筛选 + 任务卡片网格，paddingLeft 留白避开 Dock */}
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
        {/* 状态筛选条 */}
        <div
          data-testid="status-filter"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            flexWrap: "wrap",
            padding: `${space.lg}px ${space.xl}px 0`,
          }}
        >
          {filters.map((f) => {
            const isActive = f.key === "all";
            return (
              <button
                key={f.key}
                type="button"
                data-testid="status-filter-option"
                data-key={f.key}
                data-active={isActive ? "true" : "false"}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.pill,
                  border: `1px solid ${isActive ? "#2563EB" : neutral[200]}`,
                  backgroundColor: isActive ? "#2563EB" : "#FFFFFF",
                  color: isActive ? "#FFFFFF" : neutral[600],
                  fontSize: fontSize.md,
                  fontWeight: isActive ? 600 : 400,
                  cursor: "pointer",
                  fontFamily: fontFamily.body,
                  transition: "background-color .15s ease, color .15s ease",
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {/* 任务卡片列表 */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            padding: space.xl,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: space.lg,
            alignContent: "start",
          }}
        >
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      </div>

      {/* 左侧 Dock 悬浮导航条：activeKey="board"（任务看板），hover 展开（z-index 50） */}
      <NavDock activeKey="board" onNavClick={() => undefined}>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs + 2 }}>
          <div
            style={{
              fontSize: fontSize.xs,
              fontWeight: 600,
              color: neutral[400],
              letterSpacing: ".04em",
            }}
          >
            任务统计 · {tasks.length}
          </div>
          {(Object.keys(statusStats) as BoardStatus[]).map((status) => (
            <div
              key={status}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.xs + 1}px ${space.xs}px`,
                borderRadius: radius.md,
              }}
            >
              {renderStatusBadge(status)}
              <span style={{ fontSize: fontSize.sm, color: neutral[700], fontWeight: 500 }}>
                {status}
              </span>
              <span style={{ marginLeft: "auto", fontSize: fontSize.sm, color: neutral[400] }}>
                {statusStats[status]}
              </span>
            </div>
          ))}
        </div>
      </NavDock>

      {/* Cmd+K 命令面板：受控开关（z-index 40，Dock 50 仍浮于其上），open 由 useState 管理 */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={cmdkItems} />
    </div>
  );
}

export default {
  meta: {
    id: "task-board",
    name: "任务看板",
    group: "任务",
    description: "任务看板：状态筛选 + 任务卡片列表（状态 / 参与 Agent / 产出物数量），融合导航",
    device: "desktop",
  },
  Component: TaskBoardPage,
} satisfies PrototypeDef;
