/**
 * 原型：任务详情 + 任务文档库（融合导航版）
 * =============================================
 * 对应 PRD 03/04 篇：任务信息头部 + Tab 区（群聊/产出物/文档库）+ 文档库视图 + 文档查看面板。
 * - 纯静态展示：不实现 Tab 切换 / 版本切换 / 交互逻辑，默认展示「文档库」Tab。
 * - 产出物协议与 04 篇一致：结论文本/文档/文件三类，版本 append 递增（v1→v2）。
 * - 导航改造（对齐 T16/T17 融合方案）：移除深色 Sidebar，改为
 *   `../_shared/nav` 的 NavDock（悬浮 Dock）+ NavTopBar（浅色顶栏）+ CmdKPanel（受控开关）。
 * - Cmd+K 接线（T19）：useState 管理 cmdkOpen（默认 false 关闭），NavTopBar 的
 *   cmdk-trigger（onCmdKClick）打开，✕ / 遮罩点击 / Esc 关闭（onClose）。
 * - ⚠️ T15 铁律：root `height:100%; position:relative`，全部浮层 absolute，
 *   严禁 fixed / 100vh / 100vw；内容区 `paddingLeft: 80px` 避让 Dock。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { AgentAvatar, AgentBadge, StatusBadge } from "../_shared/components";
import { NavDock, NavTopBar, CmdKPanel } from "../_shared/nav";
import {
  type RoleKey,
  neutral,
  roles,
  roleText,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起宽度 + 24px 留白（避让悬浮导航） */
const RAIL_W = 56;
const CONTENT_PAD_LEFT = RAIL_W + 24;

/* ------------------------------ 产出物类型色（原型局部，语义对齐 roleText） ------------------------------ */
/** 产出物类型：结论文本 / 文档 / 文件 */
type ArtifactType = "结论文本" | "文档" | "文件";

const artifactTypeTheme: Record<ArtifactType, { color: string; bg: string; border: string }> = {
  结论文本: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  文档: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  文件: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
};

interface ArtifactVersion {
  version: string;
  time: string;
}

interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  /** 当前版本号（列表展示） */
  version: string;
  author: RoleKey;
  time: string;
  /** 版本历史（append 递增），第一个为当前版本 */
  versions: ArtifactVersion[];
  /** 预览正文（markdown 风格纯文本示意） */
  preview: string;
}

/* ------------------------------ Mock 产出物（3 个，含多版本示例） ------------------------------ */
const artifacts: Artifact[] = [
  {
    id: "req-doc",
    type: "文档",
    title: "需求文档",
    version: "v2",
    author: "product",
    time: "2026-08-05 18:20",
    versions: [
      { version: "v2", time: "2026-08-05 18:20" },
      { version: "v1", time: "2026-08-05 10:05" },
    ],
    preview: [
      "# 智能报表模块 · 需求文档",
      "",
      "## 背景",
      "运营侧需要按日汇总各渠道接入数据，当前依赖人工导表，效率低且口径不一。",
      "",
      "## 需求清单",
      "- [x] 支持按渠道 / 时间维度聚合，输出日、周、月报表",
      "- [x] 报表可导出为 CSV，供下游平台消费",
      "- [ ] 支持自定义指标口径（P1，二期）",
      "",
      "## 验收标准",
      "1. 报表数据与源库抽样一致；2. 导出文件编码 UTF-8；3. 生成耗时 < 30s。",
      "",
      "> 变更记录：v2 补充「自定义指标口径」为二期排期，并修正导出编码要求。",
    ].join("\n"),
  },
  {
    id: "design-doc",
    type: "文档",
    title: "技术方案设计文档",
    version: "v1",
    author: "architect",
    time: "2026-08-05 14:40",
    versions: [{ version: "v1", time: "2026-08-05 14:40" }],
    preview: [
      "# 智能报表模块 · 技术方案",
      "",
      "## 模块划分",
      "- `report-aggregator`：按渠道/时间维度聚合计算",
      "- `report-exporter`：CSV 导出与编码处理",
      "- `report-api`：对外查询接口",
      "",
      "## 数据流",
      "源表 → 聚合任务（每日 02:00）→ 结果表 → 查询/导出服务",
      "",
      "## 风险",
      "单表数据量增长后聚合耗时线性上升，建议提前规划分区。",
    ].join("\n"),
  },
  {
    id: "impl-note",
    type: "结论文本",
    title: "实现说明",
    version: "v1",
    author: "developer",
    time: "2026-08-06 09:15",
    versions: [{ version: "v1", time: "2026-08-06 09:15" }],
    preview: [
      "## 实现说明（结论文本）",
      "",
      "已完成报表聚合与 CSV 导出功能，核心代码位于 `report-aggregator` 与 `report-exporter`。",
      "单测覆盖聚合口径与导出编码两条链路，关键文件已上传至文档库（文件类型）。",
      "",
      "后续可对接二期「自定义指标口径」扩展。",
    ].join("\n"),
  },
];

/* ------------------------------ 子组件 ------------------------------ */

/** 任务信息头部：标题 + 状态 + 优先级 + 参与 Agent */
function TaskInfoHeader() {
  const participants: RoleKey[] = ["product", "architect", "developer", "tester"];
  return (
    <section
      data-testid="task-info-header"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.md,
        padding: `${space.xl}px`,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.lg,
        boxShadow: shadow.sm,
        ...baseFont,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <span style={{ fontSize: fontSize.xs, color: neutral[400], fontWeight: 500 }}>T-1042</span>
        <h2 style={{ margin: 0, fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
          智能报表模块开发
        </h2>
        <StatusBadge status="待验收" />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: fontSize.sm,
            color: neutral[600],
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
          }}
        >
          <span aria-hidden style={{ color: "#D97706" }}>◆</span>优先级：高
        </span>
        <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>截止：2026-08-10</span>
        <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>更新于 2 小时前</span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          paddingTop: space.sm,
          borderTop: `1px dashed ${neutral[200]}`,
        }}
      >
        <span style={{ fontSize: fontSize.sm, color: neutral[500], fontWeight: 500 }}>
          参与 Agent
        </span>
        <div style={{ display: "flex", alignItems: "center" }}>
          {participants.map((role, i) => (
            <span key={role} style={{ marginLeft: i === 0 ? 0 : -6, borderRadius: "50%" }}>
              <AgentAvatar role={role} size="sm" />
            </span>
          ))}
        </div>
        {participants.map((role) => (
          <AgentBadge key={`label-${role}`} role={role} dot={false} />
        ))}
      </div>
    </section>
  );
}

/** Tab 区：群聊 / 产出物 / 文档库（纯展示，文档库为当前 Tab） */
const TABS = ["群聊", "产出物", "文档库"] as const;

function TabBar() {
  return (
    <div
      data-testid="artifact-tab"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px`,
        backgroundColor: neutral[50],
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.md,
        ...baseFont,
      }}
    >
      {TABS.map((tab) => {
        const isActive = tab === "文档库";
        return (
          <button
            key={tab}
            type="button"
            data-active={isActive ? "true" : "false"}
            style={{
              flex: 1,
              border: "none",
              cursor: "pointer",
              padding: `${space.sm + 2}px ${space.md}px`,
              borderRadius: radius.sm,
              backgroundColor: isActive ? "#FFFFFF" : "transparent",
              color: isActive ? neutral[900] : neutral[500],
              fontSize: fontSize.md,
              fontWeight: isActive ? 600 : 400,
              boxShadow: isActive ? shadow.sm : "none",
              fontFamily: fontFamily.body,
            }}
          >
            {tab}
            {isActive && (
              <span
                style={{
                  marginLeft: space.xs,
                  fontSize: fontSize.xs,
                  color: roleText.product,
                  backgroundColor: "#EFF6FF",
                  padding: "1px 6px",
                  borderRadius: radius.pill,
                }}
              >
                4
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** 产出物类型标签 */
function ArtifactTypeBadge({ type }: { type: ArtifactType }) {
  const t = artifactTypeTheme[type];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `2px ${space.sm}px`,
        borderRadius: radius.sm,
        backgroundColor: t.bg,
        border: `1px solid ${t.border}`,
        color: t.color,
        fontSize: fontSize.xs,
        fontWeight: 500,
        whiteSpace: "nowrap",
        fontFamily: fontFamily.body,
      }}
    >
      {type}
    </span>
  );
}

/** 产出物列表项 */
function ArtifactItem({ artifact }: { artifact: Artifact }) {
  const authorTheme = roles[artifact.author];
  return (
    <button
      type="button"
      data-testid="artifact-item"
      data-artifact-id={artifact.id}
      data-active={artifact.id === "req-doc" ? "true" : "false"}
      style={{
        width: "100%",
        textAlign: "left",
        cursor: "pointer",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.md,
        backgroundColor: artifact.id === "req-doc" ? "#FFFFFF" : neutral[50],
        boxShadow: artifact.id === "req-doc" ? shadow.sm : "none",
        padding: space.md,
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        fontFamily: fontFamily.body,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <ArtifactTypeBadge type={artifact.type} />
        <span
          style={{
            fontSize: fontSize.xs,
            fontWeight: 600,
            color: neutral[500],
            backgroundColor: neutral[200],
            padding: "1px 6px",
            borderRadius: radius.pill,
          }}
        >
          {artifact.version}
        </span>
        {artifact.versions.length > 1 && (
          <span style={{ fontSize: fontSize.xs, color: roleText.product }}>
            共 {artifact.versions.length} 个版本
          </span>
        )}
      </div>
      <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
        {artifact.title}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.xs,
          fontSize: fontSize.xs,
          color: neutral[400],
        }}
      >
        <AgentAvatar role={artifact.author} size="sm" dot={false} style={{ width: 18, height: 18, fontSize: 8 }} />
        <span style={{ color: authorTheme.color, fontWeight: 500 }}>{authorTheme.label}</span>
        <span>·</span>
        <span>{artifact.time}</span>
      </div>
    </button>
  );
}

/** 文档查看面板：内容预览 + 版本切换示意 */
function ArtifactViewer({ artifact }: { artifact: Artifact }) {
  return (
    <section
      data-testid="artifact-viewer"
      data-artifact-id={artifact.id}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.lg,
        boxShadow: shadow.sm,
        overflow: "hidden",
        ...baseFont,
      }}
    >
      {/* 查看器头部：标题 + 版本切换示意 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.md,
          padding: `${space.md}px ${space.xl}px`,
          borderBottom: `1px solid ${neutral[200]}`,
          backgroundColor: neutral[50],
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          <ArtifactTypeBadge type={artifact.type} />
          <span
            style={{
              fontSize: fontSize.lg,
              fontWeight: 600,
              color: neutral[900],
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {artifact.title}
          </span>
        </div>
        {/* 版本切换示意（纯展示，无交互） */}
        <div
          aria-label="版本切换示意"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            backgroundColor: "#FFFFFF",
            border: `1px solid ${neutral[200]}`,
            borderRadius: radius.pill,
            padding: `${space.xs}px ${space.sm}px`,
            fontSize: fontSize.xs,
            color: neutral[500],
          }}
        >
          <span aria-hidden style={{ color: neutral[300] }}>‹</span>
          {artifact.versions.map((v, i) => (
            <span
              key={v.version}
              style={{
                padding: "1px 7px",
                borderRadius: radius.pill,
                backgroundColor: i === 0 ? roleText.product : "transparent",
                color: i === 0 ? "#FFFFFF" : neutral[500],
                fontWeight: i === 0 ? 600 : 400,
              }}
            >
              {v.version}
            </span>
          ))}
          <span aria-hidden style={{ color: neutral[300] }}>›</span>
        </div>
      </div>

      {/* 内容预览 */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: `${space.xl}px`,
          fontSize: fontSize.md,
          lineHeight: 1.7,
          color: neutral[700],
          whiteSpace: "pre-wrap",
          fontFamily: fontFamily.body,
        }}
      >
        {artifact.preview}
      </div>

      {/* 底部元信息：作者 / 版本时间线 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.md,
          padding: `${space.md}px ${space.xl}px`,
          borderTop: `1px dashed ${neutral[200]}`,
          fontSize: fontSize.xs,
          color: neutral[400],
        }}
      >
        <span>
          当前版本：<strong style={{ color: neutral[600] }}>{artifact.version}</strong>（仅读，修改由
          Agent 重新产出新版本）
        </span>
        <span>
          {artifact.versions
            .map((v) => `${v.version} · ${v.time}`)
            .join("　→　")}
        </span>
      </div>
    </section>
  );
}

/* ------------------------------ 页面主组件 ------------------------------ */

function TaskDetailPage() {
  // Cmd+K 命令面板受控开关（T19）：默认关闭，trigger 打开，✕ / 遮罩 / Esc 关闭
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const active = artifacts[0];
  return (
    <div
      data-testid="task-detail-root"
      style={{
        height: "100%",
        minHeight: 720,
        position: "relative",
        backgroundColor: neutral[100],
        fontFamily: fontFamily.body,
      }}
    >
      {/* 浅色顶栏（文档流，height 60）；cmdk-trigger 点击打开命令面板 */}
      <NavTopBar
        title="任务详情"
        subtitle="T-1042 · 智能报表模块开发"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：任务信息头部 + Tab + 文档库；左侧 paddingLeft 80 避让 Dock，整体可滚动 */}
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 0,
          right: 0,
          bottom: 0,
          overflow: "auto",
          padding: space.xl,
          paddingLeft: CONTENT_PAD_LEFT,
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
        }}
      >
        <TaskInfoHeader />
        <TabBar />

        {/* 文档库视图：产出物列表 + 文档查看面板 */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: space.lg, alignItems: "stretch" }}>
          {/* 产出物列表 */}
          <div
            style={{
              width: 300,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              gap: space.sm,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: `0 ${space.xs}px`,
              }}
            >
              <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>
                产出物列表
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{artifacts.length} 项</span>
            </div>
            {artifacts.map((artifact) => (
              <ArtifactItem key={artifact.id} artifact={artifact} />
            ))}
          </div>

          {/* 文档查看面板 */}
          <ArtifactViewer artifact={active} />
        </div>
      </div>

      {/* 左侧 Dock 悬浮导航条：默认收起，hover 展开（z-index 50，浮于命令面板遮罩之上） */}
      <NavDock activeKey="board" projectName="Agent 协作平台" />

      {/* Cmd+K 命令面板：受控开关（T19），默认关闭；✕ / 遮罩 / Esc 关闭（z-index 40） */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
    </div>
  );
}

export default {
  meta: { id: "task-detail", name: "任务详情与文档库", device: "desktop" },
  Component: TaskDetailPage,
} satisfies PrototypeDef;
