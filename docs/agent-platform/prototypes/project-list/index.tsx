import type { PrototypeDef, PrototypeRenderProps } from "@md-docs/prototypes/types";
import { useState } from "react";
import type { CSSProperties } from "react";
import { AgentAvatar, StatusBadge } from "../_shared/components";
import type { RoleKey, StatusKey } from "../_shared/styles";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";

/**
 * 原型：项目列表页（融合导航：Dock 悬浮导航 + 浅色顶栏 + Cmd+K 命令面板）
 * =========================================================================
 * 平台级工作区首页，替换原深色 Sidebar 为已确认的 nav-hybrid 融合导航方案：
 * - **左侧 NavDock 悬浮导航条**（activeKey="project" 高亮）：毛玻璃胶囊、
 *   hover 展开 56→248px、z-index 50 浮于命令面板遮罩之上。
 * - **浅色 NavTopBar**：左侧标题「项目列表」+ 居中 Cmd+K 触发框 + 右用户头像。
 * - **Cmd+K 命令面板**：受控开关（点击顶栏 ⌘K 触发框打开，✕/遮罩/Esc 关闭，
 *   z-index 40），「导航」组图标与 Dock 一一对应（▤ ☰ ◉），「切换项目」高亮呼应当前页。
 * - ⚠️ T15 铁律：root `height:100%; position:relative`，浮层全部 absolute，
 *   严禁 fixed / 100vh / 100vw；内容区左侧 paddingLeft 80px 避让 Dock。
 * - mock 3 个项目（智能报表模块 / 数据采集平台 / 告警中心），纯静态展示。
 * - 每个卡片 data-testid="project-card"，新建按钮 data-testid="create-project-button"。
 */

interface MockProject {
  id: string;
  name: string;
  description: string;
  taskCount: number;
  doneCount: number;
  status: StatusKey;
  members: RoleKey[];
}

const projects: MockProject[] = [
  {
    id: "p1",
    name: "智能报表模块",
    description: "基于多 Agent 协作的新功能开发：需求拆解、架构设计、编码实现与测试验收全流程。",
    taskCount: 12,
    doneCount: 4,
    status: "进行中",
    members: ["product", "architect", "developer", "tester"],
  },
  {
    id: "p2",
    name: "数据采集平台",
    description: "指标与日志数据采集管道：Agent 负责配置采集任务、校验数据上报与告警联动。",
    taskCount: 8,
    doneCount: 8,
    status: "已完成",
    members: ["architect", "developer"],
  },
  {
    id: "p3",
    name: "告警中心",
    description: "告警规则编排与通知触达，待验收任务等待产品经理与测试 Agent 复核确认。",
    taskCount: 6,
    doneCount: 3,
    status: "待验收",
    members: ["product", "tester"],
  },
];

/* 命令面板数据：导航组图标与 Dock 一一对应（▤ ☰ ◉），「切换项目」高亮呼应当前页 */
const cmdkItems: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤", active: true },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "操作", label: "新建项目", icon: "＋" },
  { group: "操作", label: "查看产出物", icon: "▦" },
  { group: "操作", label: "查看 Agent 会话", icon: "◷" },
];

function ProjectCard({ project }: { project: MockProject }) {
  const card: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: `${space.xl}px`,
    borderRadius: radius.lg,
    backgroundColor: "#FFFFFF",
    border: `1px solid ${neutral[200]}`,
    boxShadow: shadow.sm,
  };
  return (
    <section data-testid="project-card" data-project-id={project.id} style={card}>
      {/* 头部：项目名 + 状态 */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
        <div
          style={{
            fontSize: fontSize.lg,
            fontWeight: 600,
            color: neutral[900],
            lineHeight: 1.4,
          }}
        >
          {project.name}
        </div>
        <StatusBadge status={project.status} />
      </div>

      {/* 描述 */}
      <p
        style={{
          margin: 0,
          fontSize: fontSize.md,
          color: neutral[500],
          lineHeight: 1.7,
          flex: 1,
        }}
      >
        {project.description}
      </p>

      {/* 底部：任务统计 + 成员 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `1px solid ${neutral[100]}`,
          paddingTop: space.md,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.xs, fontSize: fontSize.sm, color: neutral[400] }}>
          <span aria-hidden style={{ fontWeight: 700, color: neutral[600] }}>{project.taskCount}</span>
          个任务
          <span style={{ marginLeft: space.xs, color: neutral[300] }}>·</span>
          <span style={{ color: "#059669" }}>{project.doneCount} 已完成</span>
        </div>
        {/* 成员 Agent 头像堆叠 */}
        <div style={{ display: "flex", alignItems: "center" }} aria-label={`${project.members.length} 个 Agent 成员`}>
          {project.members.map((role, idx) => (
            <span key={role} style={{ marginLeft: idx === 0 ? 0 : -space.sm - 2 }}>
              <AgentAvatar role={role} size="sm" />
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProjectListPage(_: PrototypeRenderProps) {
  /* Cmd+K 命令面板受控开关（T19）：默认关闭，⌘K 触发框打开，✕/遮罩/Esc 关闭 */
  const [cmdkOpen, setCmdkOpen] = useState(false);

  return (
    <div
      data-testid="project-list-root"
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
      {/* 浅色顶栏（文档流顶部，height 60） */}
      <NavTopBar
        title="项目列表"
        subtitle="选择项目进入 AI 协作工作区"
        userName="运营者"
        userRole="平台管理员"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：项目卡片网格，左侧 paddingLeft 80px 留白避开悬浮 Dock */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: `${space.xl}px ${space.xl}px ${space.xl}px 80px`,
        }}
      >
        {/* 操作行：新建项目 */}
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
              我的项目
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
              {projects.length} 个项目正在协作
            </div>
          </div>
          <button
            type="button"
            data-testid="create-project-button"
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
            新建项目
          </button>
        </div>

        {/* 项目卡片网格 */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))",
            gap: space.lg,
          }}
        >
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      </main>

      {/* 左侧 Dock 悬浮导航条：activeKey="project"，z-index 50 浮于命令面板遮罩之上 */}
      <NavDock activeKey="project" />

      {/* Cmd+K 命令面板：受控开关（T19），open 默认 false，点击 ⌘K 触发框打开 */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={cmdkItems} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "project-list",
    name: "项目列表",
    group: "平台",
    description: "项目列表页：Dock 悬浮导航 + 浅色顶栏 + Cmd+K 命令面板，项目卡片（任务数 / 成员 Agent）+ 新建项目入口",
    device: "desktop",
  },
  Component: ProjectListPage,
};

export default def;
