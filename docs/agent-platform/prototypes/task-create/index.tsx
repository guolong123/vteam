/**
 * 原型：任务创建（device: desktop）
 * =============================================
 * 对应 PRD 任务流转起点：任务表单（标题/描述/背景文档上传/优先级）+ Agent 选择区（4 角色可勾选，产品经理=主 Agent）
 * + 已选列表 + 创建按钮 + 待开始提示。
 * - 纯静态展示：勾选状态为静态 mock（产品经理、开发者已勾选；产品经理带「主 Agent」徽章），不实现联动/提交。
 * - 新需求（PRD 03 FR-17/18/19）：背景文档上传区（mock 3 个文件，虚线框上传入口 + 文件列表）；
 *   创建后进入「待开始」状态提示（create-hint）；多选 Agent 需指定主 Agent 作任务负责人（main-agent-tag）。
 * - 导航：融合方案（与已确认 nav-hybrid 一致）——左侧 Dock 悬浮导航 NavDock（activeKey=board）
 *   替换原深色 Sidebar + 浅色顶栏 NavTopBar（title=创建任务）+ Cmd+K 命令面板受控开关
 *   （T19：默认关闭，点击顶栏 cmdk-trigger 打开，✕/遮罩/Esc 关闭）。
 * - 复用 ../_shared/nav（NavDock/NavTopBar/CmdKPanel）与 ../_shared/components（AgentAvatar/AgentBadge）、../_shared/styles。
 * - ⚠️ T15 铁律：root `height:100%; position:relative`，浮层 absolute，禁 fixed/100vh/100vw；
 *   内容区 paddingLeft 80 避让 Dock（RAIL_W 56 + 24）。
 * - data-testid：task-title / task-description / priority-select / doc-upload / doc-upload-btn / doc-file /
 *   agent-option / main-agent-tag / create-task-button / create-hint
 *   （NavDock/NavTopBar/CmdKPanel 自带 rail-bar / topbar / cmdk-trigger / cmdk-panel / cmdk-close）。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import { AgentAvatar, AgentBadge } from "../_shared/components";
import {
  type RoleKey,
  neutral,
  roles,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起宽度（对齐 _shared/nav RAIL_W），内容区 paddingLeft = RAIL_W + 24 避让 */
const RAIL_W = 56;

/* ------------------------------ Mock：Agent 选择（静态勾选） ------------------------------ */
interface AgentOption {
  role: RoleKey;
  checked: boolean;
  desc: string;
  /** 主 Agent（任务负责人）：多选时须指定，默认产品经理（FR-19） */
  main?: boolean;
}

const agentOptions: AgentOption[] = [
  { role: "product", checked: true, desc: "需求拆解与验收标准", main: true },
  { role: "architect", checked: false, desc: "技术方案与架构设计" },
  { role: "developer", checked: true, desc: "编码实现与自测" },
  { role: "tester", checked: false, desc: "用例设计与质量验收" },
];

/** 已勾选角色（与上方静态勾选状态保持一致） */
const selectedRoles: RoleKey[] = agentOptions.filter((a) => a.checked).map((a) => a.role);

/* ------------------------------ Mock：背景文档（FR-17 上传入任务文档库，静态展示） ------------------------------ */
/** 文件类型语义色（图标底色，独立于角色/状态色避免语义混淆，本地收拢不散落） */
const docTypeColors = { pdf: "#EF4444", csv: "#10B981", docx: "#3B82F6" } as const;

const mockDocs: { name: string; size: string; ext: string; color: string }[] = [
  { name: "需求说明书.pdf", size: "2.4 MB", ext: "PDF", color: docTypeColors.pdf },
  { name: "历史工单数据.csv", size: "1.2 MB", ext: "CSV", color: docTypeColors.csv },
  { name: "接口文档.docx", size: "868 KB", ext: "DOCX", color: docTypeColors.docx },
];

/* ------------------------------ 「待开始」状态色（新状态未入 _shared statusColors，本地收敛与琥珀同族） ------------------------------ */
const pendingColor = "#D97706";
const pendingBg = "#FFFBEB";
const pendingBorder = "#FDE68A";

/* ------------------------------ 优先级（低/中/高，静态选中「中」） ------------------------------ */
const priorities = ["低", "中", "高"] as const;

/* ------------------------------ Cmd+K 命令面板数据（导航组与 Dock 图标对应；操作组高亮「新建任务」） ------------------------------ */
const cmdkItems: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "操作", label: "新建任务", icon: "＋", active: true },
  { group: "操作", label: "查看产出物", icon: "▦" },
  { group: "操作", label: "查看 Agent 会话", icon: "◷" },
];

/* ================================ 左栏：任务表单 ================================ */
function TaskForm() {
  const fieldLabel: CSSProperties = {
    fontSize: fontSize.sm,
    fontWeight: 500,
    color: neutral[600],
    marginBottom: space.xs,
  };
  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "#FFFFFF",
    fontSize: fontSize.md,
    color: neutral[800],
    outline: "none",
    fontFamily: fontFamily.body,
  };
  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        padding: space.xl,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
      }}
    >
      {/* 卡片标题 */}
      <div>
        <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
          任务信息
        </div>
        <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
          描述任务目标，平台将按需组队并分派给对应 Agent。
        </div>
      </div>

      {/* 任务标题 */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label htmlFor="task-title-input" style={fieldLabel}>
          任务标题 <span style={{ color: "#DC2626" }}>*</span>
        </label>
        <input
          id="task-title-input"
          data-testid="task-title"
          type="text"
          placeholder="例如：智能报表模块开发"
          aria-label="任务标题"
          defaultValue=""
          style={inputBase}
        />
      </div>

      {/* 任务描述 */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label htmlFor="task-desc-input" style={fieldLabel}>
          任务描述
        </label>
        <textarea
          id="task-desc-input"
          data-testid="task-description"
          rows={6}
          placeholder="描述任务背景、目标与验收预期，Agent 将基于此展开协作…"
          aria-label="任务描述"
          style={{ ...inputBase, resize: "none", lineHeight: 1.6 }}
        />
      </div>

      {/* 背景文档上传（FR-17：上传资料入任务文档库，参与 Agent 可见；纯静态示意） */}
      <div data-testid="doc-upload" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <label style={fieldLabel}>背景文档</label>

        {/* 上传入口：虚线框 + 上传图标 + 文案（不实现真实选择） */}
        <button
          type="button"
          data-testid="doc-upload-btn"
          aria-label="上传背景文档"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: space.xs,
            padding: `${space.xl}px ${space.lg}px`,
            borderRadius: radius.md,
            border: `1.5px dashed ${neutral[300]}`,
            backgroundColor: neutral[50],
            color: neutral[500],
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.xl, lineHeight: 1, color: "#2563EB" }}>
            ↑
          </span>
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[600] }}>
            点击或拖拽上传背景文档
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            支持 PDF / Word / CSV，文件将沉淀到任务文档库供 Agent 查看
          </span>
        </button>

        {/* 已上传文件列表（mock 3 个：PDF / CSV / DOCX，含移除按钮示意） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {mockDocs.map((doc) => (
            <div
              key={doc.name}
              data-testid="doc-file"
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.xs}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: radius.sm,
                  backgroundColor: doc.color,
                  color: "#FFFFFF",
                  fontSize: fontSize.xs,
                  fontWeight: 700,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {doc.ext}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: fontSize.md,
                  color: neutral[700],
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {doc.name}
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400], flexShrink: 0 }}>
                {doc.size}
              </span>
              <span
                aria-label={`移除 ${doc.name}`}
                style={{
                  fontSize: fontSize.sm,
                  color: neutral[400],
                  cursor: "pointer",
                  padding: space.xs,
                  flexShrink: 0,
                }}
              >
                ✕
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 优先级选择 */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label htmlFor="priority-select" style={fieldLabel}>
          优先级
        </label>
        <select
          id="priority-select"
          data-testid="priority-select"
          defaultValue="中"
          aria-label="优先级"
          style={{ ...inputBase, width: 200, cursor: "pointer" }}
        >
          {priorities.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {/* 提示条 */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: space.sm,
          padding: `${space.md}px ${space.lg}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[50],
          border: `1px solid ${neutral[200]}`,
          fontSize: fontSize.sm,
          color: neutral[500],
          lineHeight: 1.6,
        }}
      >
        <span aria-hidden style={{ color: "#2563EB", fontWeight: 700, lineHeight: 1.6 }}>
          i
        </span>
        任务创建后进入「待开始」状态；启动后群聊中仅被 @ 的 Agent 响应，产出物自动沉淀为任务文档。
      </div>
    </section>
  );
}

/* ================================ 右栏：Agent 选择区 ================================ */
function AgentOptionCard({ option, main }: { option: AgentOption; main?: boolean }) {
  const theme = roles[option.role];
  return (
    <div
      data-testid="agent-option"
      data-role={option.role}
      data-checked={option.checked ? "true" : "false"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.md}px ${space.lg}px`,
        borderRadius: radius.md,
        backgroundColor: option.checked ? theme.bg : "#FFFFFF",
        border: `1px solid ${option.checked ? theme.border : neutral[200]}`,
        boxShadow: option.checked ? shadow.sm : undefined,
        transition: "border-color .15s ease, background-color .15s ease",
      }}
    >
      <AgentAvatar role={option.role} size="md" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          <div
            style={{
              fontSize: fontSize.md,
              fontWeight: 600,
              color: neutral[800],
              whiteSpace: "nowrap",
            }}
          >
            {theme.label}
          </div>
          {/* 主 Agent（任务负责人）徽章：多选时须指定，默认产品经理（FR-19） */}
          {main ? (
            <span
              data-testid="main-agent-tag"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                padding: "1px 7px",
                borderRadius: radius.pill,
                backgroundColor: roles.product.color,
                color: "#FFFFFF",
                fontSize: fontSize.xs,
                fontWeight: 600,
                lineHeight: "16px",
                flexShrink: 0,
              }}
            >
              ★ 主 Agent
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: fontSize.xs,
            color: neutral[400],
            marginTop: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {option.desc}
        </div>
      </div>
      {/* 勾选框（静态展示） */}
      <span
        aria-label={option.checked ? "已勾选" : "未勾选"}
        style={{
          width: 20,
          height: 20,
          borderRadius: radius.sm,
          border: `1.5px solid ${option.checked ? theme.color : neutral[300]}`,
          backgroundColor: option.checked ? theme.color : "#FFFFFF",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#FFFFFF",
          fontSize: fontSize.sm,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {option.checked ? "✓" : ""}
      </span>
    </div>
  );
}

function AgentSelectPanel() {
  return (
    <section
      style={{
        width: 300,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
      }}
    >
      {/* Agent 选择区 */}
      <div
        style={{
          padding: space.xl,
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.sm,
          display: "flex",
          flexDirection: "column",
          gap: space.md,
        }}
      >
        <div>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
            选择协作 Agent
          </div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs, lineHeight: 1.6 }}>
            勾选参与任务的角色，可多选。多选时需指定{" "}
            <span style={{ fontWeight: 600, color: neutral[600] }}>主 Agent</span>{" "}
            作为任务负责人；简单任务可单选一个 Agent。
          </div>
        </div>
        {agentOptions.map((option) => (
          <AgentOptionCard key={option.role} option={option} main={option.main} />
        ))}
      </div>

      {/* 已选 Agent 列表 */}
      <div
        data-testid="selected-agents"
        style={{
          padding: space.xl,
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.sm,
          display: "flex",
          flexDirection: "column",
          gap: space.md,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: fontSize.md,
            fontWeight: 600,
            color: neutral[700],
          }}
        >
          <span>已选 Agent</span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400], fontWeight: 400 }}>
            {selectedRoles.length} 个
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: space.sm }}>
          {selectedRoles.map((role) => (
            <AgentBadge key={role} role={role} />
          ))}
        </div>
      </div>

      {/* 创建按钮 */}
      <button
        type="button"
        data-testid="create-task-button"
        style={{
          width: "100%",
          padding: `${space.md + 2}px ${space.lg}px`,
          borderRadius: radius.md,
          border: "none",
          backgroundColor: "#2563EB",
          color: "#FFFFFF",
          fontSize: fontSize.lg,
          fontWeight: 600,
          cursor: "pointer",
          boxShadow: "0 6px 16px rgba(37,99,235,.3)",
          fontFamily: fontFamily.body,
        }}
      >
        创建任务
      </button>

      {/* 创建后提示：任务进入「待开始」，确认团队后点击开始（FR-18） */}
      <div
        data-testid="create-hint"
        role="note"
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: space.sm,
          padding: `${space.md}px ${space.lg}px`,
          borderRadius: radius.md,
          backgroundColor: pendingBg,
          border: `1px solid ${pendingBorder}`,
          fontSize: fontSize.sm,
          color: neutral[600],
          lineHeight: 1.6,
        }}
      >
        <span aria-hidden style={{ color: pendingColor, fontWeight: 700, lineHeight: 1.6 }}>
          ⏱
        </span>
        <span>
          任务进入<span style={{ fontWeight: 600, color: pendingColor }}>「待开始」</span>
          状态，确认团队后点击「开始任务」正式启动。
        </span>
      </div>
    </section>
  );
}

/* ================================ 页面：融合导航（NavDock + NavTopBar + CmdKPanel） ================================ */
function TaskCreatePage() {
  // Cmd+K 命令面板受控开关（T19 新 API：默认关闭，点击触发框打开，✕/遮罩/Esc 关闭）
  const [cmdkOpen, setCmdkOpen] = useState(false);

  return (
    <div
      data-testid="task-create-root"
      style={{
        height: "100%",
        minHeight: 720,
        position: "relative",
        backgroundColor: neutral[100],
        fontFamily: fontFamily.body,
      }}
    >
      {/* 顶栏（文档流顶部，height 60） */}
      <NavTopBar
        title="创建任务"
        subtitle="提交需求，组建虚拟 AI 团队"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：左缘留白避开 Dock（RAIL_W + 24 = 80），内部可滚动 */}
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 0,
          right: 0,
          bottom: 0,
          overflow: "auto",
          padding: space.xl,
          paddingLeft: RAIL_W + 24,
          display: "flex",
          gap: space.xl,
          alignItems: "flex-start",
        }}
      >
        <TaskForm />
        <AgentSelectPanel />
      </div>

      {/* 左侧 Dock 悬浮导航条（absolute，z-index 50，浮于命令面板遮罩之上） */}
      <NavDock activeKey="board" projectName="Agent 协作平台" />

      {/* Cmd+K 命令面板（受控开关：默认关闭，点击触发框打开，✕/遮罩/Esc 关闭） */}
      <CmdKPanel items={cmdkItems} open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
    </div>
  );
}

export default {
  meta: {
    id: "task-create",
    name: "创建任务",
    group: "任务",
    description: "任务创建：表单 + 4 角色 Agent 选择（静态勾选）+ 已选列表 + 创建按钮（融合导航 Dock + 顶栏 + Cmd+K）",
    device: "desktop",
  },
  Component: TaskCreatePage,
} satisfies PrototypeDef;
