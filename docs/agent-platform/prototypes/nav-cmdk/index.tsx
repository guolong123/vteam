/**
 * 原型：导航变体 B —— Command Palette 主导航
 * =============================================
 * 完全突破侧边栏范式（Raycast / Linear / Notion Cmd+K 方向）：
 * - **无侧边栏**。页面 = 顶栏（面包屑 + Cmd+K 搜索框 + 用户头像）+ 全屏内容区。
 * - 导航通过 **Cmd+K 命令面板**：居中浮层、毛玻璃、命令分组（导航/操作）+ 当前项高亮。
 * - 命令面板默认**可见**（静态展示"按下 ⌘K 后"的状态），主体内容在轻遮罩下正常展示。
 * - 内容区演示「任务详情 + 文档库」：智能报表模块任务 / 需求文档 v2 / 技术方案 v1 / 实现说明 v1。
 * - 纯静态展示：不执行真实命令、无交互逻辑。
 * - 复用 ../_shared/components（StatusBadge / AgentAvatar / AgentBadge），**不使用 Sidebar**。
 */
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { AgentAvatar, AgentBadge, StatusBadge } from "../_shared/components";
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

/* scoped 动画：仅作用于本原型（避免污染其他原型） */
const protoStyle = `
  @keyframes navcmdk-blink { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes navcmdk-pop { from{opacity:0; transform:translateY(8px) scale(.985)} to{opacity:1; transform:none} }
  @keyframes navcmdk-fade { from{opacity:0} to{opacity:1} }
`;

/* ------------------------------ 命令面板数据 ------------------------------ */
interface CommandItem {
  id: string;
  icon: string;
  label: string;
  desc: string;
  key: string;
}

interface CommandGroup {
  title: string;
  items: CommandItem[];
}

const commandGroups: CommandGroup[] = [
  {
    title: "导航",
    items: [
      { id: "switch-project", icon: "⇱", label: "切换项目", desc: "在项目之间快速跳转", key: "⌘1" },
      { id: "task-board", icon: "▤", label: "任务看板", desc: "查看全部任务与状态流转", key: "⌘2" },
      { id: "agent-manage", icon: "◉", label: "Agent 管理", desc: "配置角色、技能与权限", key: "⌘3" },
    ],
  },
  {
    title: "操作",
    items: [
      { id: "new-task", icon: "＋", label: "新建任务", desc: "创建任务并指派给 Agent 团队", key: "⌘N" },
      { id: "view-artifacts", icon: "▦", label: "查看产出物", desc: "浏览当前任务文档库与版本", key: "⌘⇧A" },
      { id: "view-sessions", icon: "◷", label: "查看 Agent 会话", desc: "实时查看协作过程与上下文", key: "⌘⇧S" },
    ],
  },
];

/* ------------------------------ 产出物数据（对齐 PRD 04：三类 + 版本 append） ------------------------------ */
type ArtifactType = "结论文本" | "文档" | "文件";

const artifactTypeTheme: Record<ArtifactType, { color: string; bg: string; border: string }> = {
  结论文本: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  文档: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  文件: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
};

interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  version: string;
  author: RoleKey;
  time: string;
  versions: { version: string; time: string }[];
  preview: string;
}

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

/* ------------------------------ 顶栏（无侧边栏：面包屑 + Cmd+K 触发 + 用户） ------------------------------ */
function CmdkTopBar() {
  return (
    <header
      style={{
        height: 60,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space.xl,
        padding: `0 ${space.xl}px`,
        backgroundColor: "#FFFFFF",
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      {/* 左侧面包屑：项目名 / 任务名 */}
      <nav
        data-testid="top-breadcrumb"
        aria-label="面包屑"
        style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}
      >
        <span
          style={{
            fontSize: fontSize.md,
            color: neutral[500],
            fontWeight: 500,
            whiteSpace: "nowrap",
            cursor: "pointer",
          }}
        >
          Agent 协作平台
        </span>
        <span aria-hidden style={{ color: neutral[300], fontSize: fontSize.lg, lineHeight: 1 }}>
          ›
        </span>
        <span
          style={{
            fontSize: fontSize.md,
            color: neutral[900],
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          T-1042 智能报表模块开发
        </span>
      </nav>

      {/* 中部：Cmd+K 搜索框（点击唤起命令面板） */}
      <button
        type="button"
        data-testid="cmdk-trigger"
        aria-label="打开命令面板（⌘K）"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          width: 280,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[50],
          border: `1px solid ${neutral[200]}`,
          cursor: "pointer",
          fontFamily: fontFamily.body,
          boxShadow: shadow.sm,
        }}
      >
        <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400], lineHeight: 1 }}>
          ⌕
        </span>
        <span
          style={{
            flex: 1,
            textAlign: "left",
            fontSize: fontSize.md,
            color: neutral[400],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          搜索或输入命令…
        </span>
        <span
          aria-hidden
          style={{
            fontSize: fontSize.xs,
            fontWeight: 600,
            color: neutral[500],
            backgroundColor: "#FFFFFF",
            border: `1px solid ${neutral[200]}`,
            padding: "1px 6px",
            borderRadius: radius.sm,
          }}
        >
          ⌘K
        </span>
      </button>

      {/* 右侧用户 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: fontSize.md, color: neutral[700], fontWeight: 500 }}>运营者</div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>项目管理员</div>
        </div>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: "50%",
            backgroundColor: neutral[900],
            color: "#FFFFFF",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: fontSize.md,
            fontWeight: 600,
            userSelect: "none",
          }}
        >
          运
        </span>
      </div>
    </header>
  );
}

/* ------------------------------ Cmd+K 命令面板（居中浮层 · 毛玻璃 · 默认可见） ------------------------------ */
function CmdItem({ item, active }: { item: CommandItem; active: boolean }) {
  return (
    <button
      type="button"
      data-testid="cmdk-item"
      data-command-id={item.id}
      data-active={active ? "true" : "false"}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.sm + 2}px ${space.md}px`,
        borderRadius: radius.md,
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        backgroundColor: active ? "#2563EB" : "transparent",
        fontFamily: fontFamily.body,
        transition: "background-color .1s ease",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: radius.sm,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: fontSize.lg,
          lineHeight: 1,
          backgroundColor: active ? "rgba(255,255,255,.18)" : neutral[100],
          color: active ? "#FFFFFF" : roleText.product,
        }}
      >
        {item.icon}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span
          style={{
            fontSize: fontSize.md,
            fontWeight: 600,
            color: active ? "#FFFFFF" : neutral[800],
          }}
        >
          {item.label}
        </span>
        <span
          style={{
            fontSize: fontSize.xs,
            color: active ? "rgba(255,255,255,.78)" : neutral[400],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.desc}
        </span>
      </span>
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          fontSize: fontSize.xs,
          fontWeight: 500,
          color: active ? "rgba(255,255,255,.88)" : neutral[400],
          backgroundColor: active ? "rgba(255,255,255,.16)" : neutral[100],
          padding: "2px 7px",
          borderRadius: radius.sm,
        }}
      >
        {item.key}
      </span>
    </button>
  );
}

function CmdKPanel() {
  return (
    <div
      data-testid="cmdk-panel"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12%",
        ...baseFont,
      }}
    >
      {/* 轻遮罩：主体内容仍然可辨 */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "rgba(15,23,42,.32)",
          animation: "navcmdk-fade .18s ease-out",
        }}
      />
      {/* 面板：毛玻璃 + 圆角 + 阴影 */}
      <div
        style={{
          position: "relative",
          width: 600,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "min(560px, 74%)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: radius.lg,
          backgroundColor: "rgba(255,255,255,.84)",
          backdropFilter: "blur(20px) saturate(1.5)",
          WebkitBackdropFilter: "blur(20px) saturate(1.5)",
          border: "1px solid rgba(255,255,255,.72)",
          boxShadow: "0 24px 64px rgba(15,23,42,.26), 0 4px 16px rgba(15,23,42,.10)",
          animation: "navcmdk-pop .16s ease-out",
        }}
      >
        {/* 搜索输入（focus 状态 + 光标闪烁） */}
        <div
          data-testid="cmdk-search"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.lg}px ${space.xl}px`,
            borderBottom: `1px solid ${neutral[200]}`,
            backgroundColor: "rgba(255,255,255,.55)",
          }}
        >
          <span aria-hidden style={{ fontSize: 18, color: neutral[400], lineHeight: 1 }}>
            ⌕
          </span>
          <input
            autoFocus
            readOnly
            value="任务"
            aria-label="搜索命令"
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: fontSize.xl,
              fontWeight: 500,
              color: neutral[900],
              fontFamily: fontFamily.body,
              padding: 0,
            }}
          />
          <span
            aria-hidden
            style={{
              width: 2,
              height: 18,
              flexShrink: 0,
              borderRadius: 1,
              backgroundColor: roleText.product,
              animation: "navcmdk-blink 1.05s step-end infinite",
            }}
          />
          <span
            style={{
              fontSize: fontSize.xs,
              color: neutral[400],
              border: `1px solid ${neutral[200]}`,
              borderRadius: radius.sm,
              padding: "1px 6px",
              flexShrink: 0,
            }}
          >
            ESC
          </span>
        </div>

        {/* 命令分组列表 */}
        <div style={{ flex: 1, overflow: "auto", padding: space.sm }}>
          {commandGroups.map((group) => (
            <div key={group.title}>
              <div
                style={{
                  padding: `${space.sm}px ${space.md}px ${space.xs}px`,
                  fontSize: fontSize.xs,
                  fontWeight: 600,
                  color: neutral[400],
                  textTransform: "uppercase",
                  letterSpacing: 0.06,
                }}
              >
                {group.title}
              </div>
              {group.items.map((item) => (
                <CmdItem key={item.id} item={item} active={item.id === "switch-project"} />
              ))}
            </div>
          ))}
        </div>

        {/* 底部提示 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.lg,
            padding: `${space.sm}px ${space.lg}px`,
            borderTop: `1px solid ${neutral[200]}`,
            backgroundColor: "rgba(255,255,255,.55)",
            fontSize: fontSize.xs,
            color: neutral[400],
          }}
        >
          <span>↑↓ 选择</span>
          <span>↵ 打开</span>
          <span>⌘K 唤起</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 内容区：任务详情 + 文档库（全屏工作区） ------------------------------ */
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
          flexWrap: "wrap",
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

function ArtifactItem({ artifact }: { artifact: Artifact }) {
  const authorTheme = roles[artifact.author];
  const isActive = artifact.id === "req-doc";
  return (
    <button
      type="button"
      data-testid="artifact-item"
      data-artifact-id={artifact.id}
      data-active={isActive ? "true" : "false"}
      style={{
        width: "100%",
        textAlign: "left",
        cursor: "pointer",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.md,
        backgroundColor: isActive ? "#FFFFFF" : neutral[50],
        boxShadow: isActive ? shadow.sm : "none",
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
        <AgentAvatar
          role={artifact.author}
          size="sm"
          dot={false}
          style={{ width: 18, height: 18, fontSize: 8 }}
        />
        <span style={{ color: authorTheme.color, fontWeight: 500 }}>{authorTheme.label}</span>
        <span>·</span>
        <span>{artifact.time}</span>
      </div>
    </button>
  );
}

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
        {/* 版本切换示意（纯展示） */}
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
        <span>{artifact.versions.map((v) => `${v.version} · ${v.time}`).join("　→　")}</span>
      </div>
    </section>
  );
}

/* ------------------------------ 页面主组件 ------------------------------ */
function NavCmdkPage() {
  const active = artifacts[0];
  return (
    <div
      style={{
        height: "100%",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[100],
        fontFamily: fontFamily.body,
      }}
    >
      <style>{protoStyle}</style>
      <CmdkTopBar />

      {/* 全屏内容区（无侧边栏） */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: space.xl,
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
        }}
      >
        <TaskInfoHeader />

        {/* 文档库：产出物列表 + 查看面板 */}
        <div style={{ display: "flex", gap: space.lg, alignItems: "stretch" }}>
          <div
            style={{
              width: 280,
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
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                {artifacts.length} 项
              </span>
            </div>
            {artifacts.map((artifact) => (
              <ArtifactItem key={artifact.id} artifact={artifact} />
            ))}
          </div>

          <ArtifactViewer artifact={active} />
        </div>
      </div>

      {/* 命令面板浮层：默认可见，模拟「按下 ⌘K 后」的状态 */}
      <CmdKPanel />
    </div>
  );
}

export default {
  meta: {
    id: "nav-cmdk",
    name: "导航变体B-命令面板主导航",
    group: "导航变体",
    description: "无侧边栏：Cmd+K 命令面板主导航 + 全屏任务工作区",
    device: "desktop",
  },
  Component: NavCmdkPage,
} satisfies PrototypeDef;
