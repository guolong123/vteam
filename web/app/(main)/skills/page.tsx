"use client";

/**
 * 技能与工具管理页（Phase 5 T4：skills-tools-manage 原型保真迁移）
 * =============================================
 * 唯一来源：docs/agent-platform/prototypes/skills-tools-manage/index.tsx
 * （布局/间距/文案/data-testid 零改动；token 统一走 src/theme/tokens.ts）。
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
 *     与连接状态（已连接 ✅ / 未连接 ⚠️ / 连接中 ◐，连接中 ◐ 旋转动画 stmmcp- scoped）。
 *   ⚠️ jcli = Jenkins CLI（本机 jcli-build/jcli-job/jcli-pipeline 等 9 个 jcli 技能），
 *   jenkins 工具（jenkins-build / jenkins-job-list）依赖 jcli；jira 属远程 MCP 服务，
 *   在 MCP 工具子 Tab（Remote jira 未连接），与 jcli 无关。
 * - 数据源（T5 对齐 09 §3.8 契约）：GET /api/v1/skills + GET /api/v1/tools 真实拉取
 *   （TanStack Query，对齐 agents 页模式）；上传技能 → POST /skills multipart
 *   （FormData file=SKILL.md，name/description/version 由后端 frontmatter 解析）、
 *   启停 → skill PATCH /skills/:id/status / tool PATCH /tools/:id {enabled}、
 *   注册工具 → 跳转 /tools/register 完整注册页（tool-register 原型保真迁移，5 区块表单）、
 *   注册 MCP → POST /tools 弹窗（MCP server 注册无独立页面）；**无编辑端点**（09 §3.8 仅 status/启停，
 *   编辑功能已移除）；skills/tools 管理为 [admin] 专属 → 非 admin（roleName≠admin）
 *   成员只读：隐藏上传/注册/启停按钮，仅浏览列表。
 *   - 后端字段映射：Skill{name/description/fileMeta/enabled}（source 由 fileMeta 推导：
 *     有 fileMeta=上传 / 无=内置；version 读 fileMeta.version 缺省 v1；roles 后端无绑定
 *     信息 → 显示「未绑定」）。
 *   - Tool{name/action/source/execution/mcpServer/schema/initCommand/enabled}：desc 显示
 *     「调用标识 <action>」；自定义工具 kind 由 execution 映射（code→代码/http→HTTP/cli→CLI）；
 *     MCP 工具展示 <server>_<action>，server type/连接状态（T8c）从 GET /mcp-servers 真实
 *     拉取（worker 心跳节流探测上报的三态 connected/failed/needs_auth，11 篇 §5.8）；
 *     无上报数据 → 中性默认 remote/未连接。
 * - 导航（NavTopBar/NavDock/CmdKPanel）由 AppShell 提供，本页仅渲染内容区；
 *   原型 NavDock 的统计子面板（技能/内置/自定义/MCP/依赖缺失计数）随 AppShell
 *   无 children 插槽不迁移（workers 页先例），关键计数已含于 Tab 徽章与子 Tab 徽章。
 * - 页面内扩展 token（仿原型 :72-153）：sourceColors / enableColors / depStateColors /
 *   toolKindTheme / groupTheme / builtinReadyTheme / mcpTypeTheme / mcpStatusTheme，
 *   遵循「扩展 token」范式不写 tokens.ts 基线。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；scoped 动画 stmmcp- 前缀防污染。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { AgentBadge } from "@/src/components/ui";
import {
  type RoleKey,
  neutral,
  roleText,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 页面内语义色（未入 tokens） ------------------------------
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

/**
 * MCP 连接状态五态（T8c 对齐 11 篇 §5.8 三态 + 前端过渡态）：
 * - 真实三态（来自 GET /mcp-servers 的 status，worker 心跳节流探测上报）：
 *   connected 已连接 / failed 连接失败 / needs_auth 待授权（OAuth 未授权，引导到 worker 本地执行 auth）
 * - 过渡/缺省态：connecting 连接中（原型保留）/ disconnected 未连接（后端无上报数据时的中性默认）
 */
type McpStatus = "connected" | "failed" | "needs_auth" | "disconnected" | "connecting";

/** 类型徽章主题：Local=本地二进制（蓝系）/ Remote=远程服务（紫系，与 v2 标识同族） */
const mcpTypeTheme: Record<McpType, { label: string; color: string; bg: string; border: string }> = {
  local: { label: "Local 本地", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  remote: { label: "Remote 远程", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
};

/**
 * 连接状态主题（T8c 五态）：
 * - connected=绿 ✅ 已连接 / failed=红 ✗ 连接失败 / needs_auth=琥珀 🔑 待授权（11 §5.8 三态）
 * - disconnected=灰 ⚠️ 未连接（无上报数据的中性默认）/ connecting=蓝 ◐ 连接中（过渡动画）
 */
const mcpStatusTheme: Record<
  McpStatus,
  { label: string; mark: string; color: string; bg: string; border: string }
> = {
  connected: { label: "已连接", mark: "✅", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  failed: { label: "连接失败", mark: "✗", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  needs_auth: { label: "待授权", mark: "🔑", color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  disconnected: { label: "未连接", mark: "⚠️", color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
  connecting: { label: "连接中", mark: "◐", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
};

/* 连接中 ◐ 旋转动画（scoped：stmmcp 前缀避免污染其他原型） */
const mcpAnimCss = `
@keyframes stmmcpspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;

/* ------------------------------ API 数据模型（对齐 SkillsModule / ToolsModule 返回） ------------------------------
 * GET /skills 与 GET /tools 均返回 {items, total, page, pageSize} 分页结构（对齐 agents 模式）；
 * 展示层模型（SkillItem/BuiltinTool/CustomTool/McpToolItem）保持原型语义，
 * 后端缺失的纯展示字段（version/roles/type/status 等）经适配器降级处理，见 to* 函数注释。
 */

type SourceKey = keyof typeof sourceColors;
type EnableKey = keyof typeof enableColors;

interface ApiSkill {
  id: string;
  name: string;
  description: string | null;
  fileMeta: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ApiTool {
  id: string;
  name: string;
  action: string;
  source: "builtin" | "custom" | "mcp";
  execution: "code" | "cli" | "http" | "mcp";
  mcpServer: string | null;
  schema: Record<string, unknown> | null;
  initCommand: Array<Record<string, unknown>> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /mcp-servers 记录（T8c：status 为 worker 心跳节流探测上报的三态；无上报 → null）。 */
interface ApiMcpServer {
  id: string;
  name: string;
  type: "local" | "remote";
  command: Record<string, unknown> | null;
  url: string | null;
  headers: Record<string, string> | null;
  oauth: unknown;
  enabled: boolean;
  /** T8c：connected / failed / needs_auth；未上报 → null */
  status: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PageResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

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

interface BuiltinTool {
  id: string;
  name: string;
  version: string;
  desc: string;
  roles: RoleKey[];
  enabled: EnableKey;
  icon: string;
}

interface CustomTool {
  id: string;
  name: string;
  version: string;
  desc: string;
  roles: RoleKey[];
  /** 实现类型：代码 / HTTP / CLI（决定 kind 徽章语义色，由 execution 映射） */
  kind: "代码" | "HTTP" | "CLI";
  /** 依赖的二进制清单（后端无依赖采集数据 → 恒空数组，视为已就绪） */
  deps: { bin: string; ok: boolean }[];
  enabled: EnableKey;
  icon: string;
}

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
  /** server 类型：Local 本地二进制 / Remote 远程服务（T8c 从 GET /mcp-servers 真实拉取） */
  type: McpType;
  /** 连接状态（T8c 真实三态 connected/failed/needs_auth；无上报 → disconnected 中性默认） */
  status: McpStatus;
  enabled: EnableKey;
}

/* ------------------------------ API → 展示模型适配器 ------------------------------
 * 后端字段与原型展示模型的映射决策：
 * - 技能 source：fileMeta 非空 =「上传」（上传技能时前端写入 fileMeta），否则「内置」；
 * - version：后端无版本字段，读 fileMeta.version（上传时可携带），缺省 "v1"；
 * - roles：Skill/Tool 表无角色绑定列（agent_skills 为技能反向引用），显示「未绑定」；
 * - 工具 desc：Tool 表无描述列，显示「调用标识 <action>」保留标识信息；
 * - 自定义工具 kind：execution code→代码 / http→HTTP / cli→CLI；
 * - MCP 工具（T8c）：type/status 从 GET /mcp-servers 真实拉取（worker 心跳节流探测三态），
 *   未上报（null）→ 中性默认 remote + disconnected，避免伪造已连接状态。
 */
const SKILL_ICON = "✦";

function toSkillItem(s: ApiSkill): SkillItem {
  const fileMeta = s.fileMeta as { version?: string } | null;
  return {
    id: s.id,
    name: s.name,
    version: fileMeta?.version ?? "v1",
    desc: s.description ?? "—",
    roles: [],
    source: s.fileMeta ? "上传" : "内置",
    enabled: s.enabled ? "启用" : "停用",
    icon: SKILL_ICON,
  };
}

const BUILTIN_ICON = "⬢";

function toBuiltinTool(t: ApiTool): BuiltinTool {
  return {
    id: t.id,
    name: t.name,
    version: "v1",
    desc: `调用标识 ${t.action}`,
    roles: [],
    enabled: t.enabled ? "启用" : "停用",
    icon: BUILTIN_ICON,
  };
}

const EXEC_TO_KIND: Record<ApiTool["execution"], CustomTool["kind"]> = {
  code: "代码",
  http: "HTTP",
  cli: "CLI",
  mcp: "代码",
};

const CUSTOM_ICON = "✚";

function toCustomTool(t: ApiTool): CustomTool {
  return {
    id: t.id,
    name: t.name,
    version: "v1",
    desc: `调用标识 ${t.action}`,
    roles: [],
    kind: EXEC_TO_KIND[t.execution],
    deps: [],
    enabled: t.enabled ? "启用" : "停用",
    icon: CUSTOM_ICON,
  };
}

/**
 * T8c：后端三态/缺省值 → 前端展示态。
 * connected/failed/needs_auth 直接透传（真实三态）；null（未上报）→ disconnected 中性默认。
 */
function toFrontendStatus(status: string | null | undefined): McpStatus {
  if (status === "connected" || status === "failed" || status === "needs_auth") {
    return status;
  }
  return "disconnected";
}

function toMcpTool(
  t: ApiTool,
  server?: { name: string; type: "local" | "remote"; status: string | null }
): McpToolItem {
  // T8c：展示 server 名取 GET /mcp-servers 反查结果（tool.mcpServer 存 server id，弱关联）；
  // 无记录时回退原始引用（用户输入的 server 名或 "mcp" 占位）
  const serverName = server?.name ?? t.mcpServer ?? "mcp";
  return {
    id: `${serverName}_${t.action}`,
    name: t.action,
    server: serverName,
    version: "v1",
    desc: "",
    roles: [],
    // T8c：server 类型/状态从 GET /mcp-servers 真实拉取（缺 server 记录 → remote/未连接兜底）
    type: server?.type ?? "remote",
    status: toFrontendStatus(server?.status),
    enabled: t.enabled ? "启用" : "停用",
  };
}

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

/**
 * 列表项操作按钮（启停真实 API：skill → PATCH /skills/:id/status、tool → PATCH /tools/:id，
 * 见页面主组件 mutations；09 §3.8 无编辑端点 → 无编辑按钮）
 */
function ActionButton({
  label,
  danger,
  onClick,
  testid,
}: {
  label: string;
  danger?: boolean;
  onClick?: () => void;
  testid?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
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
function SkillItemRow({
  s,
  onToggle,
  canManage,
}: {
  s: SkillItem;
  onToggle: () => void;
  canManage: boolean;
}) {
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

      {/* 绑定角色（后端 Skill/Tool 无角色列 → 空态显示「未绑定」） */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        {s.roles.length === 0 ? (
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>未绑定</span>
        ) : (
          s.roles.map((r) => (
            <AgentBadge key={r} role={r} />
          ))
        )}
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

      {/* 操作（[admin] 专属；成员只读不渲染） */}
      {canManage && (
        <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
          <ActionButton
            label={s.enabled === "启用" ? "停用" : "启用"}
            danger={s.enabled === "启用"}
            onClick={onToggle}
            testid="skill-toggle-button"
          />
        </div>
      )}
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
function BuiltinToolRow({
  t,
  onToggle,
  canManage,
}: {
  t: BuiltinTool;
  onToggle: () => void;
  canManage: boolean;
}) {
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

      {/* 绑定角色（后端 Tool 无角色列 → 空态显示「未绑定」） */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        {t.roles.length === 0 ? (
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>未绑定</span>
        ) : (
          t.roles.map((r) => (
            <AgentBadge key={r} role={r} />
          ))
        )}
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

      {/* 操作（[admin] 专属；成员只读不渲染） */}
      {canManage && (
        <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
          <ActionButton
            label={t.enabled === "启用" ? "停用" : "启用"}
            danger={t.enabled === "启用"}
            onClick={onToggle}
            testid="tool-toggle-button"
          />
        </div>
      )}
    </div>
  );
}

/** 自定义工具行卡片：在技能基础上多「实现类型 + 依赖状态」列 */
function CustomToolRow({
  t,
  onToggle,
  canManage,
}: {
  t: CustomTool;
  onToggle: () => void;
  canManage: boolean;
}) {
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

      {/* 绑定角色（后端 Tool 无角色列 → 空态显示「未绑定」） */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        {t.roles.length === 0 ? (
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>未绑定</span>
        ) : (
          t.roles.map((r) => (
            <AgentBadge key={r} role={r} />
          ))
        )}
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

      {/* 操作（[admin] 专属；成员只读不渲染） */}
      {canManage && (
        <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
          <ActionButton
            label={t.enabled === "启用" ? "停用" : "启用"}
            danger={t.enabled === "启用"}
            onClick={onToggle}
            testid="tool-toggle-button"
          />
        </div>
      )}
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
function McpToolRow({
  t,
  onToggle,
  canManage,
}: {
  t: McpToolItem;
  onToggle: () => void;
  canManage: boolean;
}) {
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

      {/* 绑定角色（后端 Tool 无角色列 → 空态显示「未绑定」） */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        {t.roles.length === 0 ? (
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>未绑定</span>
        ) : (
          t.roles.map((r) => (
            <AgentBadge key={r} role={r} />
          ))
        )}
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

      {/* 操作（[admin] 专属；成员只读不渲染） */}
      {canManage && (
        <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
          <ActionButton
            label={t.enabled === "启用" ? "停用" : "启用"}
            danger={t.enabled === "启用"}
            onClick={onToggle}
            testid="mcp-toggle-button"
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 页面主组件 ------------------------------ */

type TabKey = "skill" | "tool";

/**
 * 注册弹窗共享输入框样式（对齐 tool-register 的 inputStyle 浅色主题）。
 */
const modalInputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "#FFFFFF",
  color: neutral[800],
  fontSize: fontSize.md,
  fontFamily: fontFamily.body,
  outline: "none",
};

/** 注册弹窗字段行（标签 + 输入槽） */
function ModalFieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs + 2 }}>
      <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>{label}</span>
      {children}
    </div>
  );
}

export default function SkillToolManagePage() {
  const queryClient = useQueryClient();

  /* 权限判定：skills/tools 管理为 [admin] 专属（09 §3.8），成员只读列表。
   * roleName 取自登录响应 AuthUserView；旧持久化 user 无该字段 → 视为非 admin（只读）。 */
  const isAdmin = useAuthStore((s) => s.user?.roleName === "admin");

  /* 「注册工具」跳转 /tools/register 完整注册页（原型保真迁移，5 区块表单）；
   * 「注册 MCP」仍走本页弹窗（MCP server 注册无独立页面，与注册页内 MCP 执行形态语义不同） */
  const router = useRouter();

  /* 二 Tab（受控）：技能 / 工具 */
  const [tab, setTab] = useState<TabKey>("skill");

  /* 工具 Tab 内子 Tab（受控互斥）：内置 / 自定义 / MCP，默认内置 */
  const [toolTab, setToolTab] = useState<ToolTabKey>("builtin");

  /* 搜索框（受控，纯展示不联动过滤） */
  const [keyword, setKeyword] = useState("");

  /* 页面内反馈条（success=操作成功 / error=API 失败 / info=提示；3s 自动消失） */
  const [notice, setNotice] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(
    null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* 注册 MCP 弹窗（source=mcp）：工具注册已迁移至 /tools/register 独立页面，弹窗仅服务 MCP */
  const [registerKind, setRegisterKind] = useState<"mcp" | null>(null);
  const [regName, setRegName] = useState("");
  const [regAction, setRegAction] = useState("");
  const [regMcpServer, setRegMcpServer] = useState("");

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  const showNotice = (kind: "info" | "success" | "error", text: string) =>
    setNotice({ kind, text });

  /* 列表数据：GET /skills + GET /tools（分页 pageSize=100，一次拉全量；对齐 agents 页模式） */
  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: () =>
      api.get<PageResponse<ApiSkill>>("/skills", { query: { page: 1, pageSize: 100 } }),
  });
  const toolsQuery = useQuery({
    queryKey: ["tools"],
    queryFn: () =>
      api.get<PageResponse<ApiTool>>("/tools", { query: { page: 1, pageSize: 100 } }),
  });
  // T8c：MCP 服务器真实三态数据源（GET /mcp-servers 含 worker 心跳上报的 status）
  const mcpServersQuery = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () =>
      api.get<PageResponse<ApiMcpServer>>("/mcp-servers", {
        query: { page: 1, pageSize: 100 },
      }),
  });

  const skillsData = useMemo(
    () => (skillsQuery.data?.items ?? []).map(toSkillItem),
    [skillsQuery.data]
  );
  const builtinData = useMemo(
    () =>
      (toolsQuery.data?.items ?? [])
        .filter((t) => t.source === "builtin")
        .map(toBuiltinTool),
    [toolsQuery.data]
  );
  const customData = useMemo(
    () =>
      (toolsQuery.data?.items ?? [])
        .filter((t) => t.source === "custom")
        .map(toCustomTool),
    [toolsQuery.data]
  );
  // T8c：mcp-servers 建索引（type + 三态 status）。双键：tool.mcpServer 为弱关联
  // 存 server id（ms_xxx），用户注册时也可能直接写 server 名 → id/name 均可命中
  const mcpServerMap = useMemo(() => {
    const map = new Map<string, { name: string; type: "local" | "remote"; status: string | null }>();
    for (const s of mcpServersQuery.data?.items ?? []) {
      const value = { name: s.name, type: s.type, status: s.status };
      map.set(s.id, value);
      map.set(s.name, value);
    }
    return map;
  }, [mcpServersQuery.data]);
  const mcpData = useMemo(
    () =>
      (toolsQuery.data?.items ?? [])
        .filter((t) => t.source === "mcp")
        .map((t) => toMcpTool(t, mcpServerMap.get(t.mcpServer ?? "mcp"))),
    [toolsQuery.data, mcpServerMap]
  );

  const loadError = (() => {
    const err = skillsQuery.error ?? toolsQuery.error;
    if (!err) return null;
    return isApiError(err) ? err.message : "加载技能/工具列表失败";
  })();
  const isLoading = skillsQuery.isPending || toolsQuery.isPending;

  /* 启停：skill → PATCH /skills/:id/status、tool → PATCH /tools/:id {enabled}（09 §3.8）→ 刷新对应列表 */
  const toggleMutation = useMutation({
    mutationFn: ({ kind, id, enabled }: { kind: "skill" | "tool"; id: string; enabled: boolean }) =>
      kind === "skill"
        ? api.patch(`/skills/${id}/status`, { enabled })
        : api.patch(`/tools/${id}`, { enabled }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      showNotice("success", vars.enabled ? "已启用" : "已停用");
    },
    onError: (err) => showNotice("error", isApiError(err) ? err.message : "操作失败，请稍后重试"),
  });

  /* 上传技能：POST /skills multipart（FormData file=SKILL.md；name/description/version 由后端
   * frontmatter 解析，09 §3.8 契约对齐） */
  const uploadMutation = useMutation({
    mutationFn: (fd: FormData) => api.post<ApiSkill>("/skills", fd),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      showNotice("success", `技能「${created.name}」上传成功`);
    },
    onError: (err) => showNotice("error", isApiError(err) ? err.message : "上传失败，请稍后重试"),
  });

  /* 注册工具/MCP：POST /tools（复用 tool-register 载荷结构，source/execution 随注册形态） */
  const registerMutation = useMutation({
    mutationFn: (payload: {
      name: string;
      action: string;
      source: "custom" | "mcp";
      execution: "code" | "cli" | "http" | "mcp";
      mcpServer?: string;
      enabled: boolean;
    }) => api.post<ApiTool>("/tools", payload),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      setRegisterKind(null);
      showNotice("success", `工具「${created.name}」注册成功`);
    },
    onError: (err) => showNotice("error", isApiError(err) ? err.message : "注册失败，请稍后重试"),
  });

  /* 启停：PATCH 真实落库（currentlyEnabled=当前启用态，目标为取反） */
  const handleToggleEnabled = (
    kind: "skill" | "tool",
    id: string,
    currentlyEnabled: boolean
  ) => {
    toggleMutation.mutate({ kind, id, enabled: !currentlyEnabled });
  };

  /* 上传技能：触发隐藏文件选择 */
  const handleUploadSkillClick = () => fileInputRef.current?.click();

  const handleSkillFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // multipart：file 字段携带 SKILL.md（name/description/version 由后端 frontmatter 解析）
      const fd = new FormData();
      fd.append("file", file);
      uploadMutation.mutate(fd);
    }
    // 重置 value，允许重复选择同一文件
    e.target.value = "";
  };

  /* 注册 MCP：打开注册弹窗（重置表单与错误态） */
  const handleRegisterMcp = () => {
    registerMutation.reset();
    setRegName("");
    setRegAction("");
    setRegMcpServer("");
    setRegisterKind("mcp");
  };

  const handleRegisterSubmit = () => {
    const name = regName.trim();
    const action = regAction.trim() || name.toLowerCase().replace(/\s+/g, "-");
    if (!name || !/^[a-z0-9][a-z0-9-_.]*$/.test(action)) {
      showNotice("error", "工具名不能为空，且调用标识需为小写 slug（如 jira-query）");
      return;
    }
    registerMutation.mutate({
      name,
      action,
      source: "mcp",
      execution: "mcp",
      mcpServer: regMcpServer.trim() || "mcp-server",
      enabled: true,
    });
  };

  /* 工具总数 = 内置 + 自定义 + MCP（Tab 徽章计数） */
  const toolTotal = builtinData.length + customData.length + mcpData.length;

  const tabs: { key: TabKey; label: string; icon: string; count: number }[] = [
    { key: "skill", label: "技能", icon: "✦", count: skillsData.length },
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
      <style>{mcpAnimCss}</style>

      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          width: "100%",
        }}
      >
        {/* 页面内反馈条（编辑/启停/上传/注册 的操作反馈，3s 自动消失） */}
        {notice && (
          <div
            data-testid="skills-notice"
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              padding: `${space.sm + 2}px ${space.md}px`,
              borderRadius: radius.md,
              backgroundColor:
                notice.kind === "success" ? "#ECFDF5" : notice.kind === "error" ? "#FEF2F2" : "#EFF6FF",
              border:
                notice.kind === "success" ? "1px solid #A7F3D0" : notice.kind === "error" ? "1px solid #FECACA" : "1px solid #BFDBFE",
              color:
                notice.kind === "success" ? "#065F46" : notice.kind === "error" ? "#DC2626" : "#1E40AF",
              fontSize: fontSize.sm,
              fontWeight: 500,
              fontFamily: fontFamily.body,
            }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>
              {notice.kind === "success" ? "✓" : notice.kind === "error" ? "⚠" : "i"}
            </span>
            {notice.text}
          </div>
        )}

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

          {/* 右上操作：随 Tab 切换（上传技能 → POST /skills multipart；注册工具 → 跳转
           * /tools/register 完整注册页；注册 MCP → POST /tools 弹窗）。
           * [admin] 专属（09 §3.8）；成员只读不渲染操作入口。 */}
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginLeft: "auto" }}>
            {tab === "skill" && isAdmin && (
              <button
                type="button"
                data-testid="upload-skill-button"
                onClick={handleUploadSkillClick}
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
            {tab === "tool" && isAdmin && (
              <>
                {/* 注册工具 = 主入口（跳转完整注册页 /tools/register，原型保真 5 区块表单） */}
                <button
                  type="button"
                  data-testid="register-tool-button"
                  onClick={() => router.push("/tools/register")}
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
                {/* 注册 MCP = 工具来源之一（注册 MCP server 暴露工具，弹窗 POST /tools） */}
                <button
                  type="button"
                  data-testid="register-mcp-button"
                  onClick={handleRegisterMcp}
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
            {/* 隐藏文件选择（上传技能触发；选中后 POST /skills multipart 真实创建） */}
            <input
              ref={fileInputRef}
              type="file"
              data-testid="upload-skill-input"
              accept=".md,.markdown,text/markdown"
              onChange={handleSkillFileChange}
              style={{ display: "none" }}
            />
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

          {/* 技能列表（加载/错误/空态 + 真实 API 数据行） */}
          {tab === "skill" &&
            (isLoading ? (
              <div
                data-testid="skills-loading"
                style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}
              >
                加载中…
              </div>
            ) : loadError ? (
              <div
                data-testid="skills-error"
                role="alert"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: space.md,
                  padding: `${space.xl}px`,
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>{loadError}</div>
                <button
                  type="button"
                  data-testid="skills-retry"
                  onClick={() => {
                    skillsQuery.refetch();
                    toolsQuery.refetch();
                  }}
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
            ) : skillsData.length === 0 ? (
              <div
                data-testid="skill-empty"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: space.sm,
                  padding: `${space.xl}px`,
                  fontSize: fontSize.md,
                  color: neutral[400],
                  textAlign: "center",
                }}
              >
                <span aria-hidden style={{ fontSize: fontSize.xl }}>✦</span>
                <span>暂无技能，点击右上「上传技能」创建</span>
              </div>
            ) : (
              skillsData.map((s) => (
                <SkillItemRow
                  key={s.id}
                  s={s}
                  onToggle={() => handleToggleEnabled("skill", s.id, s.enabled === "启用")}
                  canManage={isAdmin}
                />
              ))
            ))}

          {/* 工具列表：三子 Tab 互斥切换（内置 / 自定义 / MCP） */}
          {tab === "tool" && (
            <>
              <ToolSubTabs
                active={toolTab}
                onChange={setToolTab}
                counts={{
                  builtin: builtinData.length,
                  custom: customData.length,
                  mcp: mcpData.length,
                }}
              />
              {isLoading ? (
                <div
                  data-testid="tools-loading"
                  style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}
                >
                  加载中…
                </div>
              ) : loadError ? (
                <div
                  data-testid="tools-error"
                  role="alert"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: space.md,
                    padding: `${space.xl}px`,
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>{loadError}</div>
                  <button
                    type="button"
                    data-testid="tools-retry"
                    onClick={() => {
                      skillsQuery.refetch();
                      toolsQuery.refetch();
                    }}
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
              ) : toolTab === "builtin" ? (
                builtinData.length === 0 ? (
                  <div
                    data-testid="tool-empty"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: space.sm,
                      padding: `${space.xl}px`,
                      fontSize: fontSize.md,
                      color: neutral[400],
                      textAlign: "center",
                    }}
                  >
                    <span aria-hidden style={{ fontSize: fontSize.xl }}>⬢</span>
                    <span>暂无内置工具（平台预置）</span>
                  </div>
                ) : (
                  builtinData.map((t) => (
                    <BuiltinToolRow
                      key={t.id}
                      t={t}
                      onToggle={() => handleToggleEnabled("tool", t.id, t.enabled === "启用")}
                      canManage={isAdmin}
                    />
                  ))
                )
              ) : toolTab === "custom" ? (
                customData.length === 0 ? (
                  <div
                    data-testid="tool-empty"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: space.sm,
                      padding: `${space.xl}px`,
                      fontSize: fontSize.md,
                      color: neutral[400],
                      textAlign: "center",
                    }}
                  >
                    <span aria-hidden style={{ fontSize: fontSize.xl }}>✚</span>
                    <span>暂无自定义工具，点击右上「注册工具」创建</span>
                  </div>
                ) : (
                  customData.map((t) => (
                    <CustomToolRow
                      key={t.id}
                      t={t}
                      onToggle={() => handleToggleEnabled("tool", t.id, t.enabled === "启用")}
                      canManage={isAdmin}
                    />
                  ))
                )
              ) : mcpData.length === 0 ? (
                <div
                  data-testid="tool-empty"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: space.sm,
                    padding: `${space.xl}px`,
                    fontSize: fontSize.md,
                    color: neutral[400],
                    textAlign: "center",
                  }}
                >
                  <span aria-hidden style={{ fontSize: fontSize.xl }}>◈</span>
                  <span>暂无 MCP 工具，点击右上「注册 MCP」创建</span>
                </div>
              ) : (
                mcpData.map((t) => (
                  <McpToolRow
                    key={t.id}
                    t={t}
                    onToggle={() => handleToggleEnabled("tool", t.id, t.enabled === "启用")}
                    canManage={isAdmin}
                  />
                ))
              )}
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

      {/* 注册 MCP 弹窗：POST /tools（复用 tool-register 载荷结构，source/execution=mcp） */}
      {registerKind && (
        <div
          data-testid="register-modal-root"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 40,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: "12%",
          }}
        >
          <div
            aria-hidden
            onClick={() => setRegisterKind(null)}
            style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
          />
          <div
            style={{
              position: "relative",
              width: 420,
              maxWidth: "calc(100% - 48px)",
              display: "flex",
              flexDirection: "column",
              gap: space.lg,
              padding: `${space.xl}px`,
              borderRadius: radius.lg,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.lg,
              fontFamily: fontFamily.body,
            }}
          >
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              注册 MCP 工具
            </div>
            <ModalFieldRow label="工具名">
              <input
                data-testid="register-name-input"
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
                spellCheck={false}
                placeholder="如 jira-query"
                style={modalInputStyle}
              />
            </ModalFieldRow>
            <ModalFieldRow label="调用标识（action）">
              <input
                data-testid="register-action-input"
                value={regAction}
                onChange={(e) => setRegAction(e.target.value)}
                spellCheck={false}
                placeholder="小写 slug，留空则取工具名"
                style={{ ...modalInputStyle, fontFamily: fontFamily.mono }}
              />
            </ModalFieldRow>
            <ModalFieldRow label="MCP server 标识">
              <input
                data-testid="register-mcp-server-input"
                value={regMcpServer}
                onChange={(e) => setRegMcpServer(e.target.value)}
                spellCheck={false}
                placeholder="如 filesystem"
                style={modalInputStyle}
              />
            </ModalFieldRow>
            {registerMutation.isError && (
              <div
                role="alert"
                style={{
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: radius.md,
                  backgroundColor: "#FEF2F2",
                  border: "1px solid #FECACA",
                  color: "#DC2626",
                  fontSize: fontSize.sm,
                  lineHeight: 1.6,
                }}
              >
                {isApiError(registerMutation.error)
                  ? registerMutation.error.message
                  : "注册失败，请稍后重试"}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
              <button
                type="button"
                data-testid="register-modal-cancel"
                onClick={() => setRegisterKind(null)}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "#FFFFFF",
                  color: neutral[600],
                  fontSize: fontSize.md,
                  cursor: "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="register-confirm-button"
                disabled={registerMutation.isPending}
                onClick={handleRegisterSubmit}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  fontSize: fontSize.md,
                  fontWeight: 500,
                  cursor: registerMutation.isPending ? "default" : "pointer",
                  opacity: registerMutation.isPending ? 0.6 : 1,
                  boxShadow: "0 6px 16px rgba(37,99,235,.3)",
                  fontFamily: fontFamily.body,
                }}
              >
                {registerMutation.isPending ? "注册中…" : "注册"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
