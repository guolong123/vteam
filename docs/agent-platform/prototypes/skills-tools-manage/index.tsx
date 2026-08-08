/**
 * 原型：Skills / Tools 管理（技能 / 工具二 Tab · 工具 Tab 内按来源三子 Tab：内置 · 自定义 · MCP）
 * =============================================
 * 对应 07 篇第 10.3 章（v1 阶段 skill/tool 变更流程）与平台能力管理设计方向：
 * 平台侧维护技能/工具的 manifest（name / version / description / role-bindings /
 * opencode-compat），分发时编译成 v1（.opencode 目录）或 v2（transform 注入），
 * 由 worker 节点承载运行（07 篇 11.x：控制面管理清单、worker 节点内生效）。
 *
 * 设计决策（用户确认方案 B + 子 Tab 细分）：MCP 是工具的一种来源类型（工具经 MCP
 * server 暴露，命名 <server>_<tool>），并非独立能力域 → 主 Tab 为二 Tab（技能/工具）；
 * 工具 Tab 内再以三子 Tab（内置 / 自定义 / MCP）互斥切换，避免三来源列表平铺过长。
 *
 * 页面内容：
 * - 二 Tab（技能 / 工具）+ 搜索框 + 随 Tab 切换的操作入口
 *   （技能→「上传技能」；工具→「注册工具」+「注册 MCP」）。
 * - 技能 Tab（skill-item 列表）：技能名 / 版本 / 描述 / 绑定角色（AgentBadge）/
 *   来源（内置/上传）/ 状态（启用/停用）。
 * - 工具 Tab 内三子 Tab（tool-subtab：builtin / custom / mcp，受控互斥）：
 *   · 内置工具（builtin）：平台预置，开箱即用（git-status / code-format / secret-scan）。
 *   · 自定义工具（custom）：用户注册的 代码/HTTP/CLI 工具，标注实现类型
 *     （代码=绿 / HTTP=橙 / CLI=紫）+ 依赖状态（依赖已安装 ✅ / 依赖缺失 ⚠️）。
 *   · MCP 工具（mcp）：MCP server 暴露的工具，标注「来自 MCP server，命名
 *     <server>_<tool>」，显示 server 类型（Local 本地蓝 / Remote 远程紫）
 *     与连接状态（已连接 ✅ / 未连接 ⚠️ / 连接中 ◐）——概念与 mcp-list 原型一致。
 *   ⚠️ jcli = Jenkins CLI（本机 jcli-build/jcli-job/jcli-pipeline 等 9 个 jcli 技能），
 *   jenkins 工具（jenkins-build / jenkins-job-list）依赖 jcli；jira 属远程 MCP 服务，
 *   在 MCP 工具子 Tab（Remote jira 未连接），与 jcli 无关。
 * - 复用 ../_shared/nav（NavDock / NavTopBar / CmdKPanel）+ ../_shared/components
 *   （AgentBadge）+ ../_shared/styles token。
 * - ⚠️ T15 铁律：root height:100% + minHeight:720 + position:relative，零 fixed/vh/vw；
 *   T20：CmdKPanel 受控开关默认关闭。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import { AgentBadge } from "../_shared/components";
import type { RoleKey } from "../_shared/styles";
import {
  neutral,
  roleText,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起态宽度（与 _shared/nav RAIL_W 对齐），内容区避让留白 */
const RAIL_W = 56;

/* Cmd+K 命令项：导航组图标与 Dock 一一对应，「技能与工具」高亮呼应当前页 */
const CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "导航", label: "技能与工具", icon: "◫", active: true },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "操作", label: "上传技能", icon: "⧉" },
  { group: "操作", label: "注册工具", icon: "✚" },
  { group: "操作", label: "注册 MCP", icon: "＋" },
  { group: "操作", label: "查看依赖状态", icon: "◷" },
];

/* ------------------------------ 页面内语义色（未入 _shared） ------------------------------
 * 技能/工具的「来源 / 启用状态 / 依赖状态 / 实现类型」语义独立于任务四态（statusColors）
 * 与角色色，遵循"扩展 token"范式在页面内定义具名常量并注释原因，不扩散共享层。
 */
const sourceColors = {
  内置: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  上传: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
} as const;

const enableColors = {
  启用: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  停用: { color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
} as const;

/** 工具依赖状态：ok=依赖已安装 ✅ / missing=依赖缺失 ⚠️（worker 节点需按安装命令下载） */
const depStateColors = {
  ok: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0", label: "依赖已安装", mark: "✅" },
  missing: { color: "#D97706", bg: "#FFFBEB", border: "#FDE68A", label: "依赖缺失", mark: "⚠️" },
} as const;

/** 自定义工具的实现类型：代码=绿 / HTTP=橙 / CLI=紫（与角色/状态色系区分） */
const toolKindTheme: Record<"代码" | "HTTP" | "CLI", { color: string; bg: string; border: string }> = {
  代码: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  HTTP: { color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  CLI: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
};

/* ------------------------------ 工具子 Tab 主题（页面内扩展 token） ------------------------------
 * 工具 Tab 按来源分三子 Tab：内置=平台预置（蓝系）/ 自定义=用户注册（紫系）/ MCP=MCP
 * server 暴露（青系），三子 Tab 图标/计数色与行内徽章（来源/类型/连接）语义一一对应。
 */
const groupTheme = {
  builtin: {
    icon: "⬢",
    title: "内置工具",
    desc: "平台预置，开箱即用",
    color: "#2563EB",
    bg: "#EFF6FF",
    border: "#BFDBFE",
  },
  custom: {
    icon: "✚",
    title: "自定义工具",
    desc: "用户注册的 代码 · HTTP · CLI 工具",
    color: "#7C3AED",
    bg: "#F5F3FF",
    border: "#DDD6FE",
  },
  mcp: {
    icon: "◈",
    title: "MCP 工具",
    desc: "MCP server 暴露的工具，命名 <server>_<tool>",
    color: "#0D9488",
    bg: "#F0FDFA",
    border: "#99F6E4",
  },
} as const;

/** 内置工具「开箱即用」徽章（平台预置语义，蓝系同内置来源） */
const builtinReadyTheme = { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" };

/* ------------------------------ MCP 语义主题（页面内扩展 token） ------------------------------
 * MCP 的「类型 / 连接状态」语义独立于任务四态与角色色，遵循"扩展 token"范式在页面内
 * 定义具名常量并注释原因；概念与 mcp-list 原型一致（07 篇 4 章 ConfigMCP schema：
 * Local{command[], cwd, environment, timeout} | Remote{url, headers, oauth}，
 * 连接状态对应 v2 connect / disconnect）。
 */
type McpType = "local" | "remote";

type McpStatus = "connected" | "disconnected" | "connecting";

/** 类型徽章主题：Local=本地二进制（蓝系）/ Remote=远程服务（紫系，与 v2 标识同族） */
const mcpTypeTheme: Record<McpType, { label: string; color: string; bg: string; border: string }> = {
  local: { label: "Local 本地", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  remote: { label: "Remote 远程", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
};

/** 连接状态三态：已连接=绿 ✅ / 未连接=琥珀 ⚠️ / 连接中=蓝 ◐（与 styles.statusColors 同族） */
const mcpStatusTheme: Record<
  McpStatus,
  { label: string; mark: string; color: string; bg: string; border: string }
> = {
  connected: { label: "已连接", mark: "✅", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  disconnected: { label: "未连接", mark: "⚠️", color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  connecting: { label: "连接中", mark: "◐", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
};

/* 连接中 ◐ 旋转动画（scoped：stmmcp 前缀避免污染其他原型） */
const mcpAnimCss = `
@keyframes stmmcpspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;

/* ------------------------------ mock 数据 ------------------------------ */

type SourceKey = keyof typeof sourceColors;
type EnableKey = keyof typeof enableColors;

interface SkillItem {
  id: string;
  name: string;
  version: string;
  desc: string;
  roles: RoleKey[];
  source: SourceKey;
  enabled: EnableKey;
  icon: string;
}

/** 技能 5 个：部分内置、部分上传，绑定不同角色 */
const skills: SkillItem[] = [
  {
    id: "code-review",
    name: "代码审查",
    version: "v2.3.1",
    desc: "PR 变更审查与合规检查，输出结构化修改建议",
    roles: ["developer"],
    source: "内置",
    enabled: "启用",
    icon: "✦",
  },
  {
    id: "requirement-analysis",
    name: "需求分析",
    version: "v1.8.0",
    desc: "用户故事拆解与优先级评估，产出验收要点",
    roles: ["product"],
    source: "内置",
    enabled: "启用",
    icon: "◈",
  },
  {
    id: "test-case-gen",
    name: "测试用例生成",
    version: "v1.2.0",
    desc: "按需求与边界条件自动生成可执行测试用例",
    roles: ["tester"],
    source: "上传",
    enabled: "启用",
    icon: "✔",
  },
  {
    id: "git-ops",
    name: "git 操作",
    version: "v3.0.2",
    desc: "提交、分支、PR 全流程，依赖 git 二进制",
    roles: ["developer", "architect"],
    source: "内置",
    enabled: "启用",
    icon: "⤴",
  },
  {
    id: "doc-gen",
    name: "文档生成",
    version: "v0.9.4",
    desc: "按会话记录与产出物自动整理需求文档",
    roles: ["product"],
    source: "上传",
    enabled: "停用",
    icon: "▦",
  },
];

interface BuiltinTool {
  id: string;
  name: string;
  version: string;
  desc: string;
  roles: RoleKey[];
  enabled: EnableKey;
  icon: string;
}

/** 内置工具 3 个：平台预置，随 worker 分发开箱即用（builtin-group） */
const builtinTools: BuiltinTool[] = [
  {
    id: "git-status",
    name: "git 状态",
    version: "v1.0.2",
    desc: "查询工作区变更与分支状态，平台预置工具",
    roles: ["developer"],
    enabled: "启用",
    icon: "⤴",
  },
  {
    id: "code-format",
    name: "代码格式化",
    version: "v1.0.0",
    desc: "统一格式化规范，随 worker 内置无需额外依赖",
    roles: ["developer"],
    enabled: "启用",
    icon: "≡",
  },
  {
    id: "secret-scan",
    name: "敏感信息扫描",
    version: "v0.6.1",
    desc: "扫描提交中的密钥与凭据，平台内置安全检查",
    roles: ["developer", "architect"],
    enabled: "启用",
    icon: "◈",
  },
];

interface CustomTool {
  id: string;
  name: string;
  version: string;
  desc: string;
  roles: RoleKey[];
  /** 实现类型：代码 / HTTP / CLI（决定 kind 徽章语义色） */
  kind: "代码" | "HTTP" | "CLI";
  /** 依赖的二进制清单（ok=false 即依赖缺失 ⚠️） */
  deps: { bin: string; ok: boolean }[];
  enabled: EnableKey;
  icon: string;
}

/** 自定义工具 5 个：jenkins 工具依赖 jcli（Jenkins CLI）未装 → 依赖缺失 ⚠️；
 * git/curl 已装 ✅；data-transform 纯代码无外部依赖。
 * 修正说明：jcli = Jenkins CLI（本机 jcli-build/jcli-job/jcli-pipeline 等 9 个 jcli 技能），
 * 原 jira-query 误用 jcli 已移除——jira 属远程 MCP 服务，见 MCP 工具组（Remote jira 未连接）。 */
const customTools: CustomTool[] = [
  {
    id: "jenkins-build",
    name: "jenkins 构建触发",
    version: "v1.2.0",
    desc: "触发 Jenkins Job 构建并返回构建状态与日志摘要",
    roles: ["architect"],
    kind: "CLI",
    deps: [{ bin: "jcli", ok: false }],
    enabled: "启用",
    icon: "▲",
  },
  {
    id: "jenkins-job-list",
    name: "jenkins 任务列表",
    version: "v1.0.3",
    desc: "查询 Jenkins 任务列表与最近构建结果",
    roles: ["developer"],
    kind: "CLI",
    deps: [{ bin: "jcli", ok: false }],
    enabled: "启用",
    icon: "☰",
  },
  {
    id: "slack-notify",
    name: "消息通知",
    version: "v0.8.3",
    desc: "向频道推送任务进展与验收结果（HTTP webhook）",
    roles: ["developer", "tester"],
    kind: "HTTP",
    deps: [{ bin: "curl", ok: true }],
    enabled: "启用",
    icon: "✉",
  },
  {
    id: "git-pr",
    name: "PR 创建",
    version: "v2.1.0",
    desc: "基于本地分支创建 PR 并关联任务编号",
    roles: ["developer"],
    kind: "CLI",
    deps: [{ bin: "git", ok: true }],
    enabled: "启用",
    icon: "⤴",
  },
  {
    id: "data-transform",
    name: "数据转换",
    version: "v0.4.2",
    desc: "自定义代码算子，转换采集数据字段格式",
    roles: ["developer", "tester"],
    kind: "代码",
    deps: [],
    enabled: "停用",
    icon: "↯",
  },
];

interface McpToolItem {
  /** 注册标识：<server>_<tool>（mono 展示，对应 opencode 权限命名） */
  id: string;
  /** 工具名（tool 部分，展示用） */
  name: string;
  /** 来源 MCP server 名 */
  server: string;
  version: string;
  desc: string;
  roles: RoleKey[];
  /** server 类型：Local 本地二进制 / Remote 远程服务 */
  type: McpType;
  /** 连接状态：对应 v2 connect / disconnect */
  status: McpStatus;
  enabled: EnableKey;
}

/** MCP 工具 4 个：与 mcp-list 原型同概念——filesystem/git Local 已连接、jira Remote
 * 未连接、search Remote 连接中；工具名即 <server>_<tool>（mcp-group） */
const mcpTools: McpToolItem[] = [
  {
    id: "filesystem_read_file",
    name: "read_file",
    server: "filesystem",
    version: "v1.0.4",
    desc: "读取本地文件内容",
    roles: ["developer"],
    type: "local",
    status: "connected",
    enabled: "启用",
  },
  {
    id: "git_status",
    name: "status",
    server: "git",
    version: "v0.9.2",
    desc: "查询仓库工作区状态",
    roles: ["developer", "architect"],
    type: "local",
    status: "connected",
    enabled: "启用",
  },
  {
    id: "jira_search_issues",
    name: "search_issues",
    server: "jira",
    version: "v2.1.0",
    desc: "按 JQL 检索 Jira 任务",
    roles: ["product"],
    type: "remote",
    status: "disconnected",
    enabled: "启用",
  },
  {
    id: "search_query",
    name: "query",
    server: "search",
    version: "v1.3.1",
    desc: "跨源检索平台知识内容",
    roles: ["product", "developer"],
    type: "remote",
    status: "connecting",
    enabled: "启用",
  },
];

/* ------------------------------ 子组件 ------------------------------ */

/** 通用 pill 徽章（仿 StatusBadge 视觉，颜色由调用方传 theme） */
function PillBadge({
  theme,
  mark,
  label,
  testid,
  status,
}: {
  theme: { color: string; bg: string; border: string };
  mark?: string;
  label: string;
  testid: string;
  status: string;
}) {
  return (
    <span
      data-testid={testid}
      data-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px ${space.sm + 2}px`,
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
      {mark && <span aria-hidden>{mark}</span>}
      {label}
    </span>
  );
}

/** 版本 pill（mono 小字） */
function VersionPill({ version }: { version: string }) {
  return (
    <span
      style={{
        fontSize: fontSize.xs,
        color: neutral[500],
        backgroundColor: neutral[100],
        border: `1px solid ${neutral[200]}`,
        padding: "1px 8px",
        borderRadius: radius.pill,
        fontFamily: fontFamily.mono,
        whiteSpace: "nowrap",
      }}
    >
      {version}
    </span>
  );
}

/** 列表项操作按钮（编辑 / 启停，纯展示无 onClick） */
function ActionButton({ label, danger }: { label: string; danger?: boolean }) {
  return (
    <button
      type="button"
      style={{
        padding: `${space.xs}px ${space.md}px`,
        borderRadius: radius.md,
        border: `1px solid ${neutral[200]}`,
        backgroundColor: "#FFFFFF",
        color: danger ? "#DC2626" : neutral[600],
        fontSize: fontSize.sm,
        cursor: "pointer",
        fontFamily: fontFamily.body,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

/** 技能行卡片：图标 + 名称/版本/描述（左），角色 + 来源 + 状态 + 操作（右） */
function SkillItemRow({ s }: { s: SkillItem }) {
  return (
    <div
      data-testid="skill-item"
      data-skill-id={s.id}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.lg,
        padding: `${space.lg}px ${space.xl}px`,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        ...baseFont,
      }}
    >
      {/* 图标块（角色色系） */}
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 40,
          height: 40,
          borderRadius: radius.md,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: roleText[s.roles[0]] + "14",
          color: roleText[s.roles[0]],
          fontSize: fontSize.xl,
          lineHeight: 1,
        }}
      >
        {s.icon}
      </span>

      {/* 信息区 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
            {s.name}
          </span>
          <VersionPill version={s.version} />
        </div>
        <span
          style={{
            fontSize: fontSize.md,
            color: neutral[500],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {s.desc}
        </span>
      </div>

      {/* 绑定角色 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        {s.roles.map((r) => (
          <AgentBadge key={r} role={r} />
        ))}
      </div>

      {/* 来源 */}
      <PillBadge
        theme={sourceColors[s.source]}
        label={s.source}
        testid="skill-source"
        status={s.source}
      />

      {/* 启用状态 */}
      <PillBadge
        theme={enableColors[s.enabled]}
        label={s.enabled}
        testid="skill-status"
        status={s.enabled}
      />

      {/* 操作 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        <ActionButton label="编辑" />
        <ActionButton label={s.enabled === "启用" ? "停用" : "启用"} danger={s.enabled === "启用"} />
      </div>
    </div>
  );
}

/** 工具子 Tab 类型：内置（平台预置）/ 自定义（用户注册）/ MCP（MCP server 暴露） */
type ToolTabKey = "builtin" | "custom" | "mcp";

const TOOL_SUBTABS: { key: ToolTabKey; label: string; icon: string; color: string }[] = [
  { key: "builtin", label: "内置工具", icon: groupTheme.builtin.icon, color: groupTheme.builtin.color },
  { key: "custom", label: "自定义工具", icon: groupTheme.custom.icon, color: groupTheme.custom.color },
  { key: "mcp", label: "MCP 工具", icon: groupTheme.mcp.icon, color: groupTheme.mcp.color },
];

/** 工具子 Tab 导航（次级样式，比主 Tab 小一号）：受控互斥切换 + 各来源计数 */
function ToolSubTabs({
  active,
  onChange,
  counts,
}: {
  active: ToolTabKey;
  onChange: (k: ToolTabKey) => void;
  counts: Record<ToolTabKey, number>;
}) {
  return (
    <div
      data-testid="tool-subtabs"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: 2,
        borderRadius: radius.lg,
        backgroundColor: neutral[100],
        border: `1px solid ${neutral[200]}`,
        alignSelf: "flex-start",
        ...baseFont,
      }}
    >
      {TOOL_SUBTABS.map((t) => {
        const isActive = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            data-testid="tool-subtab"
            data-kind={t.key}
            data-active={isActive ? "true" : "false"}
            onClick={() => onChange(t.key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.xs + 1}px ${space.md}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: isActive ? "#FFFFFF" : "transparent",
              boxShadow: isActive ? shadow.sm : "none",
              cursor: "pointer",
              fontFamily: fontFamily.body,
              fontSize: fontSize.sm,
              fontWeight: isActive ? 600 : 500,
              color: isActive ? neutral[800] : neutral[500],
              whiteSpace: "nowrap",
            }}
          >
            <span
              aria-hidden
              style={{ fontSize: fontSize.xs, lineHeight: 1, color: isActive ? t.color : neutral[400] }}
            >
              {t.icon}
            </span>
            {t.label}
            <span
              aria-hidden
              style={{
                fontSize: fontSize.xs,
                color: isActive ? t.color : neutral[400],
                backgroundColor: isActive ? t.color + "14" : neutral[100],
                padding: "0 6px",
                borderRadius: radius.pill,
                lineHeight: "15px",
                fontFamily: fontFamily.mono,
              }}
            >
              {counts[t.key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 内置工具行卡片：图标 + 名称/版本/描述（左），角色 + 开箱即用 + 状态 + 操作（右） */
function BuiltinToolRow({ t }: { t: BuiltinTool }) {
  return (
    <div
      data-testid="tool-item"
      data-group="builtin"
      data-tool-id={t.id}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.lg,
        padding: `${space.lg}px ${space.xl}px`,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        ...baseFont,
      }}
    >
      {/* 图标块（角色色系） */}
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 40,
          height: 40,
          borderRadius: radius.md,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: roleText[t.roles[0]] + "14",
          color: roleText[t.roles[0]],
          fontSize: fontSize.xl,
          lineHeight: 1,
        }}
      >
        {t.icon}
      </span>

      {/* 信息区 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
            {t.name}
          </span>
          <VersionPill version={t.version} />
        </div>
        <span
          style={{
            fontSize: fontSize.md,
            color: neutral[500],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {t.desc}
        </span>
      </div>

      {/* 绑定角色 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        {t.roles.map((r) => (
          <AgentBadge key={r} role={r} />
        ))}
      </div>

      {/* 开箱即用（内置语义） */}
      <PillBadge
        theme={builtinReadyTheme}
        mark="✓"
        label="开箱即用"
        testid="tool-ready"
        status="ready"
      />

      {/* 启用状态 */}
      <PillBadge
        theme={enableColors[t.enabled]}
        label={t.enabled}
        testid="tool-status"
        status={t.enabled}
      />

      {/* 操作 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        <ActionButton label="编辑" />
        <ActionButton label={t.enabled === "启用" ? "停用" : "启用"} danger={t.enabled === "启用"} />
      </div>
    </div>
  );
}

/** 自定义工具行卡片：在技能基础上多「实现类型 + 依赖状态」列 */
function CustomToolRow({ t }: { t: CustomTool }) {
  const missing = t.deps.some((d) => !d.ok);
  const depTheme = missing ? depStateColors.missing : depStateColors.ok;
  const depLabel = missing
    ? `${depStateColors.missing.label} ${t.deps.filter((d) => !d.ok).map((d) => d.bin).join("/")}`
    : depStateColors.ok.label;
  return (
    <div
      data-testid="tool-item"
      data-group="custom"
      data-tool-id={t.id}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.lg,
        padding: `${space.lg}px ${space.xl}px`,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        ...baseFont,
      }}
    >
      {/* 图标块（角色色系） */}
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 40,
          height: 40,
          borderRadius: radius.md,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: roleText[t.roles[0]] + "14",
          color: roleText[t.roles[0]],
          fontSize: fontSize.xl,
          lineHeight: 1,
        }}
      >
        {t.icon}
      </span>

      {/* 信息区 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
            {t.name}
          </span>
          <VersionPill version={t.version} />
        </div>
        <span
          style={{
            fontSize: fontSize.md,
            color: neutral[500],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {t.desc}
        </span>
      </div>

      {/* 绑定角色 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        {t.roles.map((r) => (
          <AgentBadge key={r} role={r} />
        ))}
      </div>

      {/* 实现类型（代码/HTTP/CLI） */}
      <PillBadge
        theme={toolKindTheme[t.kind]}
        label={t.kind}
        testid="tool-kind"
        status={t.kind}
      />

      {/* 依赖状态 */}
      <PillBadge
        theme={depTheme}
        mark={depTheme.mark}
        label={depLabel}
        testid="tool-dep-status"
        status={missing ? "missing" : "ok"}
      />

      {/* 启用状态 */}
      <PillBadge
        theme={enableColors[t.enabled]}
        label={t.enabled}
        testid="tool-status"
        status={t.enabled}
      />

      {/* 操作 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        <ActionButton label="编辑" />
        <ActionButton label={t.enabled === "启用" ? "停用" : "启用"} danger={t.enabled === "启用"} />
      </div>
    </div>
  );
}

/** MCP 类型徽章（Local 本地蓝 / Remote 远程紫，概念同 mcp-list 原型） */
function McpTypeBadge({ type }: { type: McpType }) {
  const theme = mcpTypeTheme[type];
  return (
    <span
      data-testid="mcp-type"
      data-type={type}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `2px ${space.sm}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.xs,
        fontWeight: 600,
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        flexShrink: 0,
        ...baseFont,
      }}
    >
      <span aria-hidden style={{ fontSize: fontSize.xs }}>◈</span>
      {theme.label}
    </span>
  );
}

/** MCP 连接状态徽章（三态：已连接 ✅ / 未连接 ⚠️ / 连接中 ◐，连接中 ◐ 旋转） */
function McpStatusBadge({ status }: { status: McpStatus }) {
  const theme = mcpStatusTheme[status];
  return (
    <span
      data-testid="mcp-status"
      data-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
        ...baseFont,
      }}
    >
      <span
        aria-hidden
        style={{
          fontSize: fontSize.xs,
          lineHeight: 1,
          animation: status === "connecting" ? "stmmcpspin 1.4s linear infinite" : undefined,
        }}
      >
        {theme.mark}
      </span>
      {theme.label}
    </span>
  );
}

/** MCP 工具行卡片：来源语义 = 「来自 MCP server，命名 <server>_<tool>」+
 * server 类型（Local/Remote）+ 连接状态（mcp-group） */
function McpToolRow({ t }: { t: McpToolItem }) {
  const typeTheme = mcpTypeTheme[t.type];
  return (
    <div
      data-testid="mcp-tool-item"
      data-group="mcp"
      data-tool-id={t.id}
      data-server={t.server}
      data-status={t.status}
      data-type={t.type}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.lg,
        padding: `${space.lg}px ${space.xl}px`,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        ...baseFont,
      }}
    >
      {/* 类型图标块（Local 蓝 ⬢ / Remote 紫 ↗） */}
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 40,
          height: 40,
          borderRadius: radius.md,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: typeTheme.color + "14",
          color: typeTheme.color,
          fontSize: fontSize.xl,
          lineHeight: 1,
        }}
      >
        {t.type === "local" ? "⬢" : "↗"}
      </span>

      {/* 信息区：<server>_<tool>（mono）+ 版本；desc 标注来源语义 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span
            data-testid="mcp-tool-name"
            style={{
              fontSize: fontSize.lg,
              fontWeight: 600,
              color: neutral[900],
              fontFamily: fontFamily.mono,
              letterSpacing: "-0.02em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {t.id}
          </span>
          <VersionPill version={t.version} />
        </div>
        <span
          style={{
            fontSize: fontSize.md,
            color: neutral[500],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          来自 MCP server，命名 {t.server}_{t.name} · 权限 {t.server}_*
        </span>
      </div>

      {/* 绑定角色 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        {t.roles.map((r) => (
          <AgentBadge key={r} role={r} />
        ))}
      </div>

      {/* server 类型徽章 */}
      <McpTypeBadge type={t.type} />

      {/* 连接状态徽章 */}
      <McpStatusBadge status={t.status} />

      {/* 启用状态 */}
      <PillBadge
        theme={enableColors[t.enabled]}
        label={t.enabled}
        testid="mcp-tool-status"
        status={t.enabled}
      />

      {/* 操作 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        <ActionButton label="编辑" />
        <ActionButton label={t.enabled === "启用" ? "停用" : "启用"} danger={t.enabled === "启用"} />
      </div>
    </div>
  );
}

/* ------------------------------ 页面主组件 ------------------------------ */

type TabKey = "skill" | "tool";

function SkillToolManagePage() {
  /* Cmd+K 命令面板受控开关（T20）：默认关闭 */
  const [cmdkOpen, setCmdkOpen] = useState(false);

  /* 二 Tab（受控）：技能 / 工具 */
  const [tab, setTab] = useState<TabKey>("skill");

  /* 工具 Tab 内子 Tab（受控互斥）：内置 / 自定义 / MCP，默认内置 */
  const [toolTab, setToolTab] = useState<ToolTabKey>("builtin");

  /* 搜索框（受控，纯展示不联动过滤） */
  const [keyword, setKeyword] = useState("");

  /* 工具总数 = 内置 + 自定义 + MCP（Tab 徽章计数） */
  const toolTotal = builtinTools.length + customTools.length + mcpTools.length;

  const tabs: { key: TabKey; label: string; icon: string; count: number }[] = [
    { key: "skill", label: "技能", icon: "✦", count: skills.length },
    { key: "tool", label: "工具", icon: "⚙", count: toolTotal },
  ];

  /** 列表头语义说明（随 Tab 切换） */
  const listMeta: Record<TabKey, { title: string; hint: string }> = {
    skill: {
      title: "平台技能",
      hint: "manifest 分发：v1 编译 .opencode 目录 / v2 transform 注入（07 篇 10.3）",
    },
    tool: {
      title: "平台工具",
      hint: "子 Tab 分来源：内置（平台预置）/ 自定义（代码·HTTP·CLI）/ MCP（<server>_<tool>）",
    },
  };

  return (
    <div
      data-testid="skills-tools-manage-root"
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
      <style>{mcpAnimCss}</style>

      {/* 浅色顶栏 */}
      <NavTopBar
        title="技能与工具"
        subtitle="平台 Skills / Tools 统一管理，工具按来源分组（内置 · 自定义 · MCP），绑定角色后分发到 worker 节点"
        userName="运营者"
        userRole="平台管理员"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：居中容器，左侧留白避让 Dock */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: `${space.xl}px ${space.xl}px ${space.xxl}px ${RAIL_W + space.xl}px`,
        }}
      >
        <div
          style={{
            maxWidth: 1080,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: space.lg,
          }}
        >
          {/* 工具条：二 Tab + 搜索框 + 右上操作按钮（随 Tab 切换） */}
          <div
            data-testid="manage-toolbar"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.lg,
              flexWrap: "wrap",
            }}
          >
            {/* 二 Tab（受控切换） */}
            <div
              data-testid="manage-tabs"
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.xs,
                padding: space.xs,
                borderRadius: radius.lg,
                backgroundColor: neutral[100],
                border: `1px solid ${neutral[200]}`,
              }}
            >
              {tabs.map((t) => {
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    data-testid="manage-tab"
                    data-kind={t.key}
                    data-active={active ? "true" : "false"}
                    onClick={() => setTab(t.key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.sm,
                      padding: `${space.sm + 1}px ${space.lg}px`,
                      borderRadius: radius.md,
                      border: "none",
                      backgroundColor: active ? "#FFFFFF" : "transparent",
                      boxShadow: active ? shadow.sm : "none",
                      cursor: "pointer",
                      fontFamily: fontFamily.body,
                      fontSize: fontSize.md,
                      fontWeight: active ? 600 : 500,
                      color: active ? neutral[900] : neutral[600],
                    }}
                  >
                    <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>
                      {t.icon}
                    </span>
                    {t.label}
                    <span
                      aria-hidden
                      style={{
                        fontSize: fontSize.xs,
                        color: active ? "#2563EB" : neutral[400],
                        backgroundColor: active ? "#EFF6FF" : neutral[100],
                        padding: "0 7px",
                        borderRadius: radius.pill,
                        lineHeight: "16px",
                        fontFamily: fontFamily.mono,
                      }}
                    >
                      {t.count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 搜索框 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                flex: 1,
                minWidth: 220,
                maxWidth: 320,
                padding: `${space.sm}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
                boxShadow: shadow.sm,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400], lineHeight: 1 }}>
                ⌕
              </span>
              <input
                data-testid="search-input"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索技能 / 工具（含 MCP 工具）名称…"
                aria-label="搜索技能或工具"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontSize: fontSize.md,
                  color: neutral[800],
                  fontFamily: fontFamily.body,
                }}
              />
            </div>

            {/* 右上操作：随 Tab 切换（上传技能 / 注册工具+注册 MCP，纯展示无 onClick） */}
            <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginLeft: "auto" }}>
              {tab === "skill" && (
                <button
                  type="button"
                  data-testid="upload-skill-button"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: space.xs,
                    padding: `${space.sm + 1}px ${space.lg}px`,
                    borderRadius: radius.pill,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "#FFFFFF",
                    color: neutral[700],
                    fontSize: fontSize.md,
                    cursor: "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  <span aria-hidden>⧉</span>
                  上传技能
                </button>
              )}
              {tab === "tool" && (
                <>
                  {/* 注册工具 = 主入口（自定义工具来源） */}
                  <button
                    type="button"
                    data-testid="register-tool-button"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: space.xs,
                      padding: `${space.sm + 1}px ${space.lg}px`,
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
                    <span aria-hidden>✚</span>
                    注册工具
                  </button>
                  {/* 注册 MCP = 工具来源之一（注册 MCP server 暴露工具） */}
                  <button
                    type="button"
                    data-testid="register-mcp-button"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: space.xs,
                      padding: `${space.sm + 1}px ${space.lg}px`,
                      borderRadius: radius.pill,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: "#FFFFFF",
                      color: neutral[700],
                      fontSize: fontSize.md,
                      cursor: "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>＋</span>
                    注册 MCP
                  </button>
                </>
              )}
            </div>
          </div>

          {/* 列表容器（白色卡片区） */}
          <div
            data-testid="manage-list"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: space.sm,
              padding: space.md,
              borderRadius: radius.lg,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.md,
            }}
          >
            {/* 列表头 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.md,
                padding: `${space.sm}px ${space.md}px`,
              }}
            >
              <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>
                {listMeta[tab].title}
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                {listMeta[tab].hint}
              </span>
            </div>

            {/* 技能列表 */}
            {tab === "skill" && skills.map((s) => <SkillItemRow key={s.id} s={s} />)}

            {/* 工具列表：三子 Tab 互斥切换（内置 / 自定义 / MCP） */}
            {tab === "tool" && (
              <>
                <ToolSubTabs
                  active={toolTab}
                  onChange={setToolTab}
                  counts={{
                    builtin: builtinTools.length,
                    custom: customTools.length,
                    mcp: mcpTools.length,
                  }}
                />
                {toolTab === "builtin" &&
                  builtinTools.map((t) => <BuiltinToolRow key={t.id} t={t} />)}
                {toolTab === "custom" &&
                  customTools.map((t) => <CustomToolRow key={t.id} t={t} />)}
                {toolTab === "mcp" && mcpTools.map((t) => <McpToolRow key={t.id} t={t} />)}
              </>
            )}
          </div>

          {/* 底部说明 */}
          <div
            data-testid="manage-hint"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.xs,
              fontSize: fontSize.xs,
              color: neutral[400],
            }}
          >
            <span aria-hidden style={{ fontSize: fontSize.sm }}>◷</span>
            skill/tool 变更生效路径：v1 写文件 + 重启实例；v2 由 worker 内 transform 热更新；
            MCP 工具经 v2 connect/disconnect 控制连接（07 篇 10.3 / 10.4 / 4 章）
          </div>
        </div>
      </main>

      {/* 左侧 Dock 悬浮导航：技能/工具 属 Agent 配置域，MCP 并入工具计数 */}
      <NavDock activeKey="skills" projectName="Agent 协作平台">
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>技能</span>
            <span style={{ fontFamily: fontFamily.mono }}>{skills.length}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>工具 · 内置</span>
            <span style={{ fontFamily: fontFamily.mono }}>{builtinTools.length}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>工具 · 自定义</span>
            <span style={{ fontFamily: fontFamily.mono }}>{customTools.length}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>工具 · MCP</span>
            <span style={{ fontFamily: fontFamily.mono }}>{mcpTools.length}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>依赖缺失</span>
            <span style={{ fontFamily: fontFamily.mono, color: "#D97706" }}>
              {customTools.filter((t) => t.deps.some((d) => !d.ok)).length}
            </span>
          </div>
        </div>
      </NavDock>

      {/* Cmd+K 命令面板：受控开关（T20）——初始关闭 */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "skills-tools-manage",
    name: "技能与工具管理",
    group: "平台",
    description:
      "技能 / 工具二 Tab 统一管理列表 + 搜索 + 上传技能/注册工具/注册 MCP 入口；工具按来源分组：内置（平台预置，开箱即用）/ 自定义（代码·HTTP·CLI，依赖状态）/ MCP（<server>_<tool>，Local/Remote 类型与连接状态）一目了然",
    device: "desktop",
  },
  Component: SkillToolManagePage,
};

export default def;
