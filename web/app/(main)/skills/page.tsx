"use client";

/**
 * 技能与工具管理页（Phase 5 T4：skills-tools-manage 原型保真迁移）
 * =============================================
 * 唯一来源：docs/agent-platform/prototypes/skills-tools-manage/index.tsx
 * （布局/间距/文案/data-testid 零改动；token 统一走 src/theme/tokens.ts）。
 * - 二 Tab（技能 / 工具）+ 随 Tab 切换的操作入口
 *   （技能→「上传技能」/「新建技能」；工具→ MCP 子 Tab「新建服务器」）。
 * - 技能 Tab（skill-item 列表）：技能名 / 版本 / 描述 / 绑定角色（AgentBadge）/
 *   来源（内置/上传）/ 状态（启用/停用）。
 * - 工具 Tab 内二子 Tab（tool-subtab：builtin / mcp，受控互斥）：
 *   · 内置工具（builtin）：平台预置，开箱即用（git-status / code-format / secret-scan）。
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
 *   MCP server 本体由 MCP 子 Tab「新建服务器」弹窗管理（POST /mcp-servers，
 *   MCP 服务（含本地/远端）的唯一新增入口）；
 *   技能编辑 → PATCH /skills/:id
 *   {name?, description?, content?} 弹窗（UX-15 补齐：编辑元信息 + SKILL.md 全文，
 *   name/description 变更后端同步重写 content frontmatter）；skills/tools 管理为 [admin] 专属 → 非 admin
 *   （roleName≠admin）成员只读：隐藏上传/注册/编辑/启停按钮，仅浏览列表。
 *   - 后端字段映射：Skill{name/description/fileMeta/enabled}（source 由 fileMeta 推导：
 *     有 fileMeta=上传 / 无=内置；version 读 fileMeta.version 缺省 v1；roles 后端无绑定
 *     信息 → 显示「未绑定」）。
 *   - Tool{name/action/source/execution/mcpServer/schema/initCommand/enabled}：desc 显示
 *     「调用标识 <action>」；MCP 工具展示 <server>_<action>，server type/连接状态（T8c）从 GET /mcp-servers 真实
 *     拉取（worker 心跳节流探测上报的三态 connected/failed/needs_auth，11 篇 §5.8）；
 *     无上报数据 → 中性默认 remote/未连接。
 * - 导航（NavTopBar/NavDock/CmdKPanel）由 AppShell 提供，本页仅渲染内容区；
 *   原型 NavDock 的统计子面板（技能/内置/MCP/依赖缺失计数）随 AppShell
 *   无 children 插槽不迁移（workers 页先例），关键计数已含于 Tab 徽章与子 Tab 徽章。
 * - 页面内扩展 token（仿原型 :72-153）：sourceColors / enableColors /
 *   groupTheme / builtinReadyTheme / mcpTypeTheme / mcpStatusTheme，
 *   遵循「扩展 token」范式不写 tokens.ts 基线。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；scoped 动画 stmmcp- 前缀防污染。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { AgentBadge, ConfirmDialog, Pagination, SegmentedTabs } from "@/src/components/ui";
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
  内置: { color: "#0D9488", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.22)" },
  上传: { color: "#7C3AED", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" },
} as const;

const enableColors = {
  启用: { color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  停用: { color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
} as const;

/* ------------------------------ 工具子 Tab 主题（页面内扩展 token） ------------------------------
 * 工具 Tab 按来源分二子 Tab：内置=平台预置（蓝系）/ MCP=MCP server 暴露（青系），
 * 二子 Tab 图标/计数色与行内徽章（来源/类型/连接）语义一一对应。
 */
const groupTheme = {
  builtin: {
    icon: "⬢",
    title: "内置工具",
    desc: "平台预置，开箱即用",
    color: "#0D9488",
    bg: "rgba(13,148,136,0.10)",
    border: "rgba(13,148,136,0.22)",
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
const builtinReadyTheme = { color: "#0D9488", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.22)" };

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
  local: { label: "Local 本地", color: "#0D9488", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.22)" },
  remote: { label: "Remote 远程", color: "#7C3AED", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" },
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
  connected: { label: "已连接", mark: "✅", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  failed: { label: "连接失败", mark: "✗", color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
  needs_auth: { label: "待授权", mark: "🔑", color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)" },
  disconnected: { label: "未连接", mark: "⚠️", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
  connecting: { label: "连接中", mark: "◐", color: "#0D9488", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.22)" },
};

/* 连接中 ◐ 旋转动画（scoped：stmmcp 前缀避免污染其他原型） */
const mcpAnimCss = `
@keyframes stmmcpspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;

/* ------------------------------ API 数据模型（对齐 SkillsModule / ToolsModule 返回） ------------------------------
 * GET /skills 与 GET /tools 均返回 {items, total, page, pageSize} 分页结构（对齐 agents 模式）；
 * 展示层模型（SkillItem/BuiltinTool/McpToolItem）保持原型语义，
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
/** 内置 MCP server 判定：seed 预置的 vteam / vteam-api（seed.ts 固定 id=`ms_keta_platform`）。
 * 用 name 判定（比固定 id 更语义化，且 MCP 工具行只能拿到 server name，两端判定口径一致）；
 * 内置 server 只读：编辑/删除/启停禁用，仅可查看。 */
const BUILTIN_MCP_SERVER_NAMES = ["vteam", "vteam-api"];
const isBuiltinMcpServer = (name: string): boolean => BUILTIN_MCP_SERVER_NAMES.includes(name);

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
  /** 已同步物化的工具行数（后端聚合；老版本无此字段时按 undefined 容错） */
  toolCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface PageResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** POST /mcp-servers/:id/sync 响应（发现物化报告；跳过项即重复/冲突告警数据源） */
interface McpSyncResult {
  server?: { id: string; name: string; type: string };
  discovered?: number;
  created?: number;
  updated?: number;
  disabled?: number;
  skipped?: { action: string; reason: string }[];
  tools?: { id: string; name: string; action: string }[];
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

interface McpToolItem {
  /** 真实工具 id（ApiTool.id，反查原始 schema/initCommand 等详情字段用） */
  toolId: string;
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

/**
 * 前端组装 SKILL.md（交互式新建技能）：name/description 做 trim + 换行折叠为空格，
 * 避免换行/冒号后多行等特殊字符破坏 frontmatter 块（后端 parseSkillMarkdown 按首个冒号
 * 分割键值，单行标量安全）；version 缺省 v1（对齐后端 fileMeta.version 缺省语义，列表 v1 徽章）。
 */
function buildSkillMarkdown(
  name: string,
  description: string,
  version: string,
  body: string
): string {
  const safeName = name.trim().replace(/\r?\n/g, " ").trim();
  const safeDesc = description.trim().replace(/\r?\n/g, " ").trim();
  const v = version.trim() || "v1";
  return `---\nname: ${safeName}\ndescription: ${safeDesc}\nversion: ${v}\n---\n\n${body}`;
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
  // 描述优先级：内置 vteam 精选文案 > 同步的 swagger 摘要（schema.description，
  // "METHOD /path" 式无摘要回退视为无描述）> 空（行内回退来源语义）
  const rawSchemaDesc = t.schema && typeof (t.schema as Record<string, unknown>).description === "string"
    ? ((t.schema as Record<string, unknown>).description as string).trim()
    : "";
  const schemaDesc = rawSchemaDesc && !/^(GET|POST|PUT|PATCH|DELETE)\s+\//.test(rawSchemaDesc)
    ? rawSchemaDesc
    : "";
  return {
    toolId: t.id,
    id: `${serverName}_${t.action}`,
    name: t.action,
    server: serverName,
    version: "v1",
    desc: VTEAM_TOOL_DESC[t.action] ?? schemaDesc,
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
 * 编辑真实 API：skill → PATCH /skills/:id（UX-15），见页面主组件 mutations）
 */
function ActionButton({
  label,
  danger,
  onClick,
  testid,
  disabled,
  serverId,
}: {
  label: string;
  danger?: boolean;
  onClick?: () => void;
  testid?: string;
  disabled?: boolean;
  serverId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      data-server-id={serverId}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: `${space.xs}px ${space.md}px`,
        borderRadius: radius.md,
        border: `1px solid ${neutral[200]}`,
        backgroundColor: "var(--color-surface)",
        color: danger ? "#DC2626" : neutral[600],
        fontSize: fontSize.sm,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        fontFamily: fontFamily.body,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

/** MCP 操作下拉菜单项：整行左对齐 + 悬停高亮（行内局部 hover 态） */
function McpMenuItem({
  label,
  danger,
  onClick,
  testid,
  disabled,
  serverId,
}: {
  label: string;
  danger?: boolean;
  onClick?: () => void;
  testid?: string;
  disabled?: boolean;
  serverId?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid={testid}
      data-server-id={serverId}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: `${space.sm}px ${space.md}px`,
        borderRadius: radius.sm,
        border: "none",
        backgroundColor: hover && !disabled ? neutral[100] : "transparent",
        color: danger ? "#DC2626" : neutral[700],
        fontSize: fontSize.sm,
        fontWeight: 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
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
  onEdit,
  onToggle,
  canManage,
}: {
  s: SkillItem;
  onEdit: () => void;
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
        backgroundColor: "var(--color-surface)",
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
            label="编辑"
            onClick={onEdit}
            testid="skill-edit-button"
          />
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

/** 工具子 Tab 类型：内置（平台预置）/ MCP（MCP server 暴露） */
type ToolTabKey = "builtin" | "mcp";

const TOOL_SUBTABS: { key: ToolTabKey; label: string; icon: string; color: string }[] = [
  { key: "builtin", label: "内置工具", icon: groupTheme.builtin.icon, color: groupTheme.builtin.color },
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
              backgroundColor: isActive ? "var(--color-segment-active)" : "transparent",
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
  onView,
  onToggle,
  canManage,
}: {
  t: BuiltinTool;
  onView: () => void;
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
        backgroundColor: "var(--color-surface)",
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

      {/* 操作（查看全员放开；启停 [admin] 专属，成员只读不渲染） */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        <ActionButton label="查看" onClick={onView} testid="tool-view-button" />
        {canManage && (
          <ActionButton
            label={t.enabled === "启用" ? "停用" : "启用"}
            danger={t.enabled === "启用"}
            onClick={onToggle}
            testid="tool-toggle-button"
          />
        )}
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

/** 内置 vteam 工具功能描述（面向人的一句话说明；权威定义见 server/src/platform-mcp/platform-mcp.tools.ts）。
 * 非内置 server 的工具无映射时回退来源语义文案。 */
const VTEAM_TOOL_DESC: Record<string, string> = {
  chat_history: "查询任务群聊历史消息",
  doclib: "查询任务产出物文档库",
  task_context: "查询任务概览与团队成员",
  group_post: "向任务群聊发布消息",
  read_file: "读取任务文件内容",
  notify_agent: "定向通知并触发其他实例",
  submit_artifact: "提交任务产出物",
  issue_create: "创建任务 issue",
  issue_list: "查询任务 issue 列表",
  issue_get: "查看 issue 详情",
  issue_update: "编辑 issue",
  issue_transition: "流转 issue 状态",
  task_transition: "流转任务状态（开始/验收/归档）",
  question_confirm: "回复 Agent 提问或权限确认",
  memory_save: "保存可复用经验记忆",
  memory_search: "检索平台记忆",
  team_view: "查看团队信息与队列",
  my_profile: "查看自身实例信息",
  team_add_member: "添加团队成员",
  channel_send: "发送频道消息（私聊直发）",
  wecom_reply: "回复企微用户消息",
};

/** vteam-api 直挂路由（Express 注册、无装饰器摘要，只能前端映射）：全 id → 功能说明。 */
const VTEAM_API_TOOL_DESC: Record<string, string> = {
  "vteam-api_appcontroller_gethello": "服务存活探针",
  "vteam-api_migratecontroller_addenabled": "一次性迁移：补实例启用列",
  "vteam-api_docssitecontroller_registry": "文档站注册表：任务文档树",
  "vteam-api_docssitecontroller_prd": "读取任务镜像文档内容",
  "vteam-api_docssitecontroller_prototypes": "任务原型列表",
  "vteam-api_docssitecontroller_prototypecontent": "读取任务原型源码",
  "vteam-api_messagechannelscontroller_inbound_get": "查询消息渠道入站配置",
  "vteam-api_messagechannelscontroller_inbound_post": "创建消息渠道入站配置",
  "vteam-api_messagechannelscontroller_inbound_put": "全量更新消息渠道入站配置",
  "vteam-api_messagechannelscontroller_inbound_patch": "修改消息渠道入站配置",
  "vteam-api_messagechannelscontroller_inbound_delete": "删除消息渠道入站配置",
};

/** MCP 工具行卡片：来源语义 = 「来自 MCP server，命名 <server>_<tool>」+
 * server 类型（Local/Remote）+ 连接状态（mcp-group） */
function McpToolRow({
  t,
  onView,
  onToggle,
  canManage,
}: {
  t: McpToolItem;
  onView: () => void;
  onToggle: () => void;
  canManage: boolean;
}) {
  const typeTheme = mcpTypeTheme[t.type];
  const builtin = isBuiltinMcpServer(t.server);
  const funcDesc = t.desc || (builtin ? VTEAM_TOOL_DESC[t.name] : undefined) || VTEAM_API_TOOL_DESC[t.id];
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
        backgroundColor: "var(--color-surface)",
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
          data-testid="mcp-tool-desc"
          style={{
            fontSize: fontSize.md,
            color: neutral[500],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {funcDesc ?? `来自 MCP server，命名 ${t.server}_${t.name} · 权限 ${t.server}_*`}
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

      {/* 来源徽章：内置 server（vteam / vteam-api）只读 → 标注内置（蓝系） */}
      {builtin && (
        <PillBadge
          theme={sourceColors.内置}
          label="内置"
          testid="mcp-tool-builtin-badge"
          status="内置"
        />
      )}

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

      {/* 操作（查看全员放开；启停 [admin] 专属，成员只读不渲染；内置 server 工具只读无启停） */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        <ActionButton label="查看" onClick={onView} testid="mcp-view-button" />
        {canManage && !builtin && (
          <ActionButton
            label={t.enabled === "启用" ? "停用" : "启用"}
            danger={t.enabled === "启用"}
            onClick={onToggle}
            testid="mcp-toggle-button"
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------ MCP server 管理（工具 Tab → MCP 子 Tab） ------------------------------
 * MCP server 本体（POST /mcp-servers）管理：注册/编辑/查看/删除全生命周期。
 * - McpServerSection：MCP 子 Tab 顶部的 server 列表区块（name/type/status/enabled + endpoint 摘要）
 * - McpServerRow：server 行卡片（查看全员放开；编辑/删除 [admin]，内置 vteam / vteam-api 只读）
 * - McpServerModal：注册（POST /mcp-servers）/ 编辑（PATCH /mcp-servers/:id）/ 查看 三合一弹窗
 */

/** server endpoint 摘要：local 显示 command 数组（npx -y ...），remote 显示 url */
function mcpServerEndpoint(s: ApiMcpServer): string {
  if (s.type === "local") {
    const cmd = (s.command as { command?: unknown } | null)?.command;
    if (Array.isArray(cmd)) {
      const parts = (cmd as unknown[]).map(String);
      return parts.length ? parts.join(" ") : "—";
    }
    return "—";
  }
  return s.url ?? "—";
}

/** MCP server 行卡片：名称（mono）+ 来源徽章（内置/自定义）+ Local/Remote 类型 + 连接状态 +
 * 启用态 + endpoint 摘要 + 操作（内置 server 只读：仅查看；用户 server 查看/编辑/删除；
 * 启用态 [admin] 可点击切换，内置/自定义通用） */
function McpServerRow({
  server,
  canManage,
  onView,
  onEdit,
  onDelete,
  onToggle,
  onSelect,
  onSync,
  syncPending,
  actionsOpen,
  onToggleActions,
}: {
  server: ApiMcpServer;
  canManage: boolean;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (s: ApiMcpServer) => void;
  onSelect: () => void;
  onSync: (s: ApiMcpServer) => void;
  syncPending: boolean;
  actionsOpen: boolean;
  onToggleActions: (s: ApiMcpServer | null) => void;
}) {
  const builtin = isBuiltinMcpServer(server.name);
  const closeMenu = () => onToggleActions(null);
  return (
    <div
      data-testid="mcp-server-item"
      data-server-id={server.id}
      data-type={server.type}
      data-status={toFrontendStatus(server.status)}
      onClick={onSelect}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: space.lg,
        padding: `${space.md}px ${space.lg}px`,
        borderRadius: radius.md,
        backgroundColor: neutral[50],
        border: `1px solid ${neutral[200]}`,
        cursor: "pointer",
        ...baseFont,
      }}
    >
      {/* 信息区：名称 + endpoint 摘要 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span
          style={{
            fontSize: fontSize.md,
            fontWeight: 600,
            color: neutral[900],
            fontFamily: fontFamily.mono,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {server.name}
        </span>
        <span
          style={{
            fontSize: fontSize.xs,
            color: neutral[500],
            fontFamily: fontFamily.mono,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {mcpServerEndpoint(server)}
        </span>
      </div>

      {/* 来源徽章：内置=seed 预置（蓝系，只读）/ 自定义=用户注册（紫系） */}
      <PillBadge
        theme={builtin ? sourceColors.内置 : { color: "#7C3AED", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" }}
        label={builtin ? "内置" : "自定义"}
        testid={builtin ? "mcp-server-builtin-badge" : "mcp-server-custom-badge"}
        status={builtin ? "内置" : "自定义"}
      />

      {/* 类型徽章 */}
      <McpTypeBadge type={server.type} />

      {/* 连接状态徽章 */}
      <McpStatusBadge status={toFrontendStatus(server.status)} />

      {/* 工具数量（后端 toolCount 聚合，已同步物化的工具行数） */}
      <span
        data-testid="mcp-server-tool-count"
        data-count={server.toolCount ?? 0}
        title={`已同步工具 ${server.toolCount ?? 0} 个`}
        style={{
          fontSize: fontSize.xs,
          color: neutral[500],
          backgroundColor: "var(--color-neutral-200)",
          padding: "0 7px",
          borderRadius: radius.pill,
          lineHeight: "16px",
          fontFamily: fontFamily.mono,
          whiteSpace: "nowrap",
        }}
      >
        工具 {server.toolCount ?? 0}
      </span>

      {/* 启用态徽章（只展示；切换收进下方操作区，[admin] 可点，内置/自定义通用；成员只读） */}
      <PillBadge
        theme={enableColors[server.enabled ? "启用" : "停用"]}
        label={server.enabled ? "启用" : "停用"}
        testid="mcp-server-status"
        status={server.enabled ? "启用" : "停用"}
      />

      {/* 操作列：下拉触发器（徽章行只展示标签，按钮统一收进下拉菜单） */}
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          data-testid="mcp-server-actions-toggle"
          data-open={actionsOpen ? "true" : "false"}
          data-server-id={server.id}
          onClick={() => onToggleActions(actionsOpen ? null : server)}
          title={actionsOpen ? "收起操作" : "展开操作"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.xs}px ${space.sm + 2}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            color: neutral[600],
            fontSize: fontSize.sm,
            fontWeight: 500,
            cursor: "pointer",
            whiteSpace: "nowrap",
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden>{actionsOpen ? "▴" : "▾"}</span>
          操作
        </button>
      </div>

      {/* 操作下拉菜单：查看全员放开；同步工具/启停/编辑/删除 [admin] 专属；
       * 内置 server 只读（仅查看）；启停内置/自定义通用 */}
      {actionsOpen && (
        <>
          <div
            aria-hidden
            data-testid="mcp-server-actions-overlay"
            onClick={(e) => { e.stopPropagation(); closeMenu(); }}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            data-testid="mcp-server-actions-panel"
            data-server-id={server.id}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              right: 0,
              zIndex: 41,
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              gap: 2,
              minWidth: 148,
              padding: space.xs,
              borderRadius: radius.md,
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.lg,
            }}
            onClick={(e) => e.stopPropagation()}
          >
          <McpMenuItem label="查看" onClick={() => { closeMenu(); onView(); }} testid="mcp-server-view-button" />
          {canManage && !builtin && (
            <>
              <McpMenuItem
                label={syncPending ? "同步中…" : "同步工具"}
                onClick={() => { closeMenu(); onSync(server); }}
                testid="mcp-server-sync-button"
                disabled={syncPending}
                serverId={server.id}
              />
              <McpMenuItem label="编辑" onClick={() => { closeMenu(); onEdit(); }} testid="mcp-server-edit-button" />
              <McpMenuItem
                label="删除"
                danger
                onClick={() => { closeMenu(); onDelete(); }}
                testid="mcp-server-delete-button"
              />
            </>
          )}
          {canManage && (
            <McpMenuItem
              label={server.enabled ? "停用" : "启用"}
              onClick={() => { closeMenu(); onToggle(server); }}
              testid="mcp-server-toggle-button"
            />
          )}
          </div>
        </>
      )}
    </div>
  );
}

/** MCP server 管理区块：标题 + 新建按钮（[admin]）+ server 行列表（空态提示） */
function McpServerSection({
  servers,
  canManage,
  onView,
  onEdit,
  onCreate,
  onDelete,
  onToggle,
  onSelect,
  onSync,
  pendingSyncId,
}: {
  servers: ApiMcpServer[];
  canManage: boolean;
  onView: (s: ApiMcpServer) => void;
  onEdit: (s: ApiMcpServer) => void;
  onCreate: () => void;
  onDelete: (s: ApiMcpServer) => void;
  onToggle: (s: ApiMcpServer) => void;
  onSelect: (s: ApiMcpServer) => void;
  onSync: (s: ApiMcpServer) => void;
  pendingSyncId: string | null;
}) {
  /* 操作下拉菜单一次只开一个（行内无局部 state，由列表统一控制） */
  const [openActionsId, setOpenActionsId] = useState<string | null>(null);
  return (
    <div
      data-testid="mcp-server-section"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        padding: `${space.md}px ${space.md}px ${space.lg}px`,
        borderRadius: radius.md,
        backgroundColor: "var(--color-neutral-50)",
        border: `1px dashed ${neutral[200]}`,
        ...baseFont,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>
          MCP 服务器
        </span>
        <span
          style={{
            fontSize: fontSize.xs,
            color: neutral[400],
            backgroundColor: "var(--color-neutral-200)",
            padding: "0 7px",
            borderRadius: radius.pill,
            lineHeight: "16px",
            fontFamily: fontFamily.mono,
          }}
        >
          {servers.length}
        </span>
        <span style={{ fontSize: fontSize.xs, color: neutral[400], flex: 1 }}>
          工具可关联的 MCP server（worker 侧注入 opencode.json mcp 节）
        </span>
        {canManage && (
          <button
            type="button"
            data-testid="create-mcp-server-button"
            onClick={onCreate}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.xs}px ${space.md}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[700],
              fontSize: fontSize.sm,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>＋</span>
            新建服务器
          </button>
        )}
      </div>

      {servers.length === 0 ? (
        <div
          data-testid="mcp-server-empty"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.md}px`,
            fontSize: fontSize.sm,
            color: neutral[400],
            textAlign: "center",
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.lg }}>◈</span>
          <span>暂无 MCP 服务器，{canManage ? "点击右上「新建服务器」注册" : "请管理员注册"}</span>
        </div>
      ) : (
        servers.map((s) => (
          <McpServerRow
            key={s.id}
            server={s}
            canManage={canManage}
            onView={() => onView(s)}
            onEdit={() => onEdit(s)}
            onDelete={() => onDelete(s)}
            onToggle={onToggle}
            onSelect={() => onSelect(s)}
            onSync={onSync}
            syncPending={pendingSyncId === s.id}
            actionsOpen={openActionsId === s.id}
            onToggleActions={(t) => setOpenActionsId(t ? t.id : null)}
          />
        ))
      )}
    </div>
  );
}

/** JSON 输入/展示 textarea（mono，浅色主题，与 schema/initCommand 编辑统一） */
function ModalJsonTextArea({
  value,
  onChange,
  rows,
  placeholder,
  readOnly,
  testid,
}: {
  value: string;
  onChange?: (v: string) => void;
  rows: number;
  placeholder?: string;
  readOnly?: boolean;
  testid: string;
}) {
  return (
    <textarea
      data-testid={testid}
      value={value}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      readOnly={readOnly}
      rows={rows}
      spellCheck={false}
      placeholder={placeholder}
      style={{
        ...modalInputStyle,
        fontFamily: fontFamily.mono,
        lineHeight: 1.5,
        resize: "vertical",
      }}
    />
  );
}

/** 行列表小按钮（「＋ 添加」虚线 / 「× 删除」红系） */
const mcpRowAddBtnStyle: CSSProperties = {
  alignSelf: "flex-start",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: `${space.xs}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px dashed ${neutral[300]}`,
  backgroundColor: "var(--color-surface)",
  color: neutral[600],
  fontSize: fontSize.xs,
  cursor: "pointer",
  fontFamily: fontFamily.body,
};

const mcpRowRemoveBtnStyle: CSSProperties = {
  width: 30,
  flexShrink: 0,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "rgba(239,68,68,0.10)",
  color: "#DC2626",
  fontSize: fontSize.md,
  lineHeight: 1,
  cursor: "pointer",
  fontFamily: fontFamily.body,
};

/**
 * local 服务器 command 反解为结构化表单字段（防御旧数据/任意 JSON）：
 * - command 非数组 → 空行；cwd 非字符串 → 空；environment 非对象 → 空键值对；timeout 非有限数字 → 空
 */
function parseLocalCommand(
  command: Record<string, unknown> | null
): { commandLines: string[]; cwd: string; envPairs: { key: string; value: string }[]; timeout: string } {
  const raw = command ?? {};
  const env: Record<string, unknown> =
    raw.environment && typeof raw.environment === "object" && !Array.isArray(raw.environment)
      ? (raw.environment as Record<string, unknown>)
      : {};
  return {
    commandLines: Array.isArray(raw.command) ? raw.command.map((c) => String(c)) : [],
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    envPairs: Object.entries(env).map(([k, v]) => ({
      key: k,
      value: v == null ? "" : String(v),
    })),
    timeout:
      typeof raw.timeout === "number" && Number.isFinite(raw.timeout) ? String(raw.timeout) : "",
  };
}

/**
 * MCP server 注册/编辑/查看三合一弹窗。
 * - create：POST /mcp-servers（name/type/command 或 url/headers/enabled 全可填）
 * - edit：PATCH /mcp-servers/:id（预填当前配置；name 可改，撞唯一名 → 后端 409）
 * - view：只读展示全字段（成员可看）
 * local 配置为结构化表单（command 片段行 / cwd / environment 键值对 / timeout），
 * create/edit/view 三模式复用同一套字段；提交组装 {command[], cwd?, environment?, timeout?}。
 */
function McpServerModal({
  mode,
  server,
  submitting,
  error,
  onClose,
  onSave,
}: {
  mode: "create" | "edit" | "view";
  server?: ApiMcpServer;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (payload: {
    name: string;
    type: "local" | "remote";
    command?: Record<string, unknown>;
    url?: string | null;
    headers?: Record<string, unknown> | null;
    enabled: boolean;
  }) => void;
}) {
  const isView = mode === "view";
  const [name, setName] = useState("");
  const [type, setType] = useState<"local" | "remote">("local");
  const [commandLines, setCommandLines] = useState<string[]>([""]);
  const [cwd, setCwd] = useState("");
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>([]);
  const [timeoutVal, setTimeoutVal] = useState("");
  const [url, setUrl] = useState("");
  const [headersJson, setHeadersJson] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  /* 打开时按 server 预填（edit/view 有 server，create 空表单） */
  useEffect(() => {
    setFormError(null);
    if (server) {
      setName(server.name);
      setType(server.type);
      if (server.type === "local") {
        const parsed = parseLocalCommand(server.command);
        setCommandLines(parsed.commandLines);
        setCwd(parsed.cwd);
        setEnvPairs(parsed.envPairs);
        setTimeoutVal(parsed.timeout);
      }
      setUrl(server.url ?? "");
      setHeadersJson(server.headers ? JSON.stringify(server.headers, null, 2) : "");
      setEnabled(server.enabled);
    } else {
      setName("");
      setType("local");
      setCommandLines([""]);
      setCwd("");
      setEnvPairs([]);
      setTimeoutVal("");
      setUrl("");
      setHeadersJson("");
      setEnabled(true);
    }
  }, [server, mode]);

  /* 行列表操作：command 片段 / environment 键值对 */
  const addCommandLine = () => setCommandLines((prev) => [...prev, ""]);
  const updateCommandLine = (i: number, v: string) =>
    setCommandLines((prev) => prev.map((x, idx) => (idx === i ? v : x)));
  const removeCommandLine = (i: number) =>
    setCommandLines((prev) => prev.filter((_, idx) => idx !== i));
  const addEnvPair = () => setEnvPairs((prev) => [...prev, { key: "", value: "" }]);
  const updateEnvKey = (i: number, v: string) =>
    setEnvPairs((prev) => prev.map((p, idx) => (idx === i ? { ...p, key: v } : p)));
  const updateEnvVal = (i: number, v: string) =>
    setEnvPairs((prev) => prev.map((p, idx) => (idx === i ? { ...p, value: v } : p)));
  const removeEnvPair = (i: number) =>
    setEnvPairs((prev) => prev.filter((_, idx) => idx !== i));

  const handleSubmit = () => {
    const n = name.trim();
    if (!/^[a-z0-9][a-z0-9-_.]*$/.test(n)) {
      setFormError("name 需为小写字母/数字/连字符/下划线/点开头（如 gitee-ent）");
      return;
    }
    let command: Record<string, unknown> | undefined;
    let remoteUrl: string | null | undefined;
    let headers: Record<string, unknown> | null | undefined;
    if (type === "local") {
      // 每行按空白拆分为 argv 元素（spawn 按元素传参，带空格的单元素无法执行）
      const lines = commandLines.flatMap((l) => l.trim().split(/\s+/).filter(Boolean));
      if (lines.length === 0) {
        setFormError("Local 服务器必须至少填写一条 command 命令");
        return;
      }
      const localCmd: Record<string, unknown> = { command: lines };
      const c = cwd.trim();
      if (c) localCmd.cwd = c;
      const env: Record<string, string> = {};
      for (const p of envPairs) {
        const k = p.key.trim();
        if (!k) continue;
        env[k] = p.value;
      }
      if (Object.keys(env).length > 0) localCmd.environment = env;
      const t = timeoutVal.trim();
      if (t) {
        const num = Number(t);
        if (!Number.isFinite(num)) {
          setFormError("timeout 需为数字（毫秒）");
          return;
        }
        localCmd.timeout = num;
      }
      command = localCmd;
    } else {
      const u = url.trim();
      if (!/^https?:\/\/.+/.test(u)) {
        setFormError("URL 需为合法 http(s) 地址");
        return;
      }
      remoteUrl = u;
      const h = headersJson.trim();
      if (h) {
        try {
          headers = JSON.parse(h) as Record<string, unknown>;
        } catch {
          setFormError("headers 不是合法 JSON");
          return;
        }
      }
    }
    onSave({
      name: n,
      type,
      ...(command !== undefined ? { command } : {}),
      ...(remoteUrl !== undefined ? { url: remoteUrl } : {}),
      ...(headers !== undefined ? { headers } : {}),
      enabled,
    });
  };

  const title =
    mode === "create" ? "新建 MCP 服务器" : mode === "edit" ? `编辑 MCP 服务器 ${server?.name ?? ""}` : `MCP 服务器详情 ${server?.name ?? ""}`;

  return (
    <div
      data-testid="mcp-server-modal-root"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8%",
      }}
    >
      <div
        aria-hidden
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      <div
        style={{
          position: "relative",
          width: 480,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "72vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
          fontFamily: fontFamily.body,
        }}
      >
        <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>{title}</div>

        <ModalFieldRow label="名称">
          {isView ? (
            <div data-testid="mcp-server-view-name" style={modalInputStyle}>{name}</div>
          ) : (
            <input
              data-testid="mcp-server-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              placeholder="如 gitee-ent"
              style={{ ...modalInputStyle, fontFamily: fontFamily.mono }}
            />
          )}
        </ModalFieldRow>

        <ModalFieldRow label="类型">
          {isView ? (
            <div data-testid="mcp-server-view-type">
              <McpTypeBadge type={type} />
            </div>
          ) : (
            <div style={{ display: "flex", gap: space.sm }}>
              {(["local", "remote"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  data-testid={`mcp-server-type-${t}`}
                  data-active={type === t ? "true" : "false"}
                  onClick={() => setType(t)}
                  style={{
                    flex: 1,
                    padding: `${space.sm}px ${space.md}px`,
                    borderRadius: radius.md,
                    border: type === t ? `1px solid #0D9488` : `1px solid ${neutral[200]}`,
                    backgroundColor: type === t ? "rgba(13,148,136,0.10)" : "var(--color-surface)",
                    color: type === t ? "#1E40AF" : neutral[600],
                    fontSize: fontSize.sm,
                    fontWeight: type === t ? 600 : 500,
                    cursor: "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  {t === "local" ? "Local 本地（子进程）" : "Remote 远程（HTTP）"}
                </button>
              ))}
            </div>
          )}
        </ModalFieldRow>

        {type === "local" ? (
          <>
            <ModalFieldRow label="command（命令片段，必填）">
              {isView ? (
                commandLines.length === 0 ? (
                  <div data-testid="mcp-server-view-command" style={modalInputStyle}>
                    未配置
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                    {commandLines.map((line, i) => (
                      <div
                        key={i}
                        data-testid={`mcp-server-view-command-line-${i}`}
                        style={{ ...modalInputStyle, fontFamily: fontFamily.mono, whiteSpace: "pre-wrap" }}
                      >
                        {line || " "}
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <>
                  {commandLines.map((line, i) => (
                    <div key={i} style={{ display: "flex", gap: space.xs, marginBottom: space.xs }}>
                      <input
                        data-testid={`mcp-cmd-${i}`}
                        value={line}
                        onChange={(e) => updateCommandLine(i, e.target.value)}
                        spellCheck={false}
                        placeholder={i === 0 ? "如 npx" : "如 -y / @scope/mcp-server@latest"}
                        style={{ ...modalInputStyle, fontFamily: fontFamily.mono, flex: 1 }}
                      />
                      <button
                        type="button"
                        data-testid={`mcp-cmd-remove-${i}`}
                        onClick={() => removeCommandLine(i)}
                        title="删除该命令片段"
                        style={mcpRowRemoveBtnStyle}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    data-testid="mcp-cmd-add"
                    onClick={addCommandLine}
                    style={mcpRowAddBtnStyle}
                  >
                    ＋ 添加命令片段
                  </button>
                </>
              )}
            </ModalFieldRow>

            <ModalFieldRow label="cwd（工作目录，可选）">
              {isView ? (
                <div data-testid="mcp-server-view-cwd" style={modalInputStyle}>{cwd || "—"}</div>
              ) : (
                <input
                  data-testid="mcp-cwd-input"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  spellCheck={false}
                  placeholder="如 /app/mcp-server"
                  style={{ ...modalInputStyle, fontFamily: fontFamily.mono }}
                />
              )}
            </ModalFieldRow>

            <ModalFieldRow label="environment（环境变量，可选）">
              {isView ? (
                envPairs.length === 0 ? (
                  <div data-testid="mcp-server-view-env" style={modalInputStyle}>
                    未配置
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                    {envPairs.map((p, i) => (
                      <div key={i} style={{ display: "flex", gap: space.xs }}>
                        <div
                          data-testid={`mcp-server-view-env-key-${i}`}
                          style={{ ...modalInputStyle, fontFamily: fontFamily.mono, flex: 1 }}
                        >
                          {p.key}
                        </div>
                        <div
                          data-testid={`mcp-server-view-env-val-${i}`}
                          style={{ ...modalInputStyle, fontFamily: fontFamily.mono, flex: 1 }}
                        >
                          {p.value || " "}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <>
                  {envPairs.map((p, i) => (
                    <div key={i} style={{ display: "flex", gap: space.xs, marginBottom: space.xs }}>
                      <input
                        data-testid={`mcp-env-key-${i}`}
                        value={p.key}
                        onChange={(e) => updateEnvKey(i, e.target.value)}
                        spellCheck={false}
                        placeholder="KEY"
                        style={{ ...modalInputStyle, fontFamily: fontFamily.mono, flex: 1 }}
                      />
                      <input
                        data-testid={`mcp-env-val-${i}`}
                        value={p.value}
                        onChange={(e) => updateEnvVal(i, e.target.value)}
                        spellCheck={false}
                        placeholder="value"
                        style={{ ...modalInputStyle, fontFamily: fontFamily.mono, flex: 1 }}
                      />
                      <button
                        type="button"
                        data-testid={`mcp-env-remove-${i}`}
                        onClick={() => removeEnvPair(i)}
                        title="删除该环境变量"
                        style={mcpRowRemoveBtnStyle}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    data-testid="mcp-env-add"
                    onClick={addEnvPair}
                    style={mcpRowAddBtnStyle}
                  >
                    ＋ 添加环境变量
                  </button>
                </>
              )}
            </ModalFieldRow>

            <ModalFieldRow label="timeout（超时 ms，可选）">
              {isView ? (
                <div data-testid="mcp-server-view-timeout" style={modalInputStyle}>
                  {timeoutVal || "—"}
                </div>
              ) : (
                <input
                  data-testid="mcp-timeout-input"
                  value={timeoutVal}
                  onChange={(e) => setTimeoutVal(e.target.value)}
                  spellCheck={false}
                  placeholder="如 60"
                  style={{ ...modalInputStyle, fontFamily: fontFamily.mono }}
                />
              )}
            </ModalFieldRow>
          </>
        ) : (
          <>
            <ModalFieldRow label="URL">
              {isView ? (
                <div data-testid="mcp-server-view-url" style={modalInputStyle}>{url || "—"}</div>
              ) : (
                <input
                  data-testid="mcp-server-url-input"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  spellCheck={false}
                  placeholder="https://my-mcp-server.com"
                  style={{ ...modalInputStyle, fontFamily: fontFamily.mono }}
                />
              )}
            </ModalFieldRow>
            <ModalFieldRow label="headers（JSON，可选）">
              {isView ? (
                <ModalJsonTextArea
                  value={headersJson}
                  rows={4}
                  readOnly
                  testid="mcp-server-view-headers"
                  placeholder="未配置"
                />
              ) : (
                <ModalJsonTextArea
                  value={headersJson}
                  onChange={setHeadersJson}
                  rows={4}
                  placeholder={'{\n  "Authorization": "Bearer {env:API_KEY}"\n}'}
                  testid="mcp-server-headers-input"
                />
              )}
            </ModalFieldRow>
          </>
        )}

        <ModalFieldRow label="启用状态">
          {isView ? (
            <div data-testid="mcp-server-view-enabled">
              <PillBadge
                theme={enableColors[enabled ? "启用" : "停用"]}
                label={enabled ? "启用" : "停用"}
                testid="mcp-server-view-enabled-badge"
                status={enabled ? "启用" : "停用"}
              />
            </div>
          ) : (
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space.sm,
                cursor: "pointer",
                fontSize: fontSize.md,
                color: neutral[700],
                fontFamily: fontFamily.body,
              }}
            >
              <input
                type="checkbox"
                data-testid="mcp-server-enabled-input"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              启用该服务器
            </label>
          )}
        </ModalFieldRow>

        {(error || formError) && (
          <div
            role="alert"
            data-testid="mcp-server-modal-error"
            style={{
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              backgroundColor: "rgba(239,68,68,0.10)",
              border: "1px solid rgba(239,68,68,0.22)",
              color: "#DC2626",
              fontSize: fontSize.sm,
              lineHeight: 1.6,
            }}
          >
            {error ?? formError}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button
            type="button"
            data-testid="mcp-server-modal-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[600],
              fontSize: fontSize.md,
              cursor: submitting ? "default" : "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            {isView ? "关闭" : "取消"}
          </button>
          {!isView && (
            <button
              type="button"
              data-testid="mcp-server-modal-confirm"
              disabled={submitting}
              onClick={handleSubmit}
              style={{
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.md,
                border: "none",
                backgroundColor: "#0D9488",
                color: "#FFFFFF",
                fontSize: fontSize.md,
                fontWeight: 500,
                cursor: submitting ? "default" : "pointer",
                opacity: submitting ? 0.6 : 1,
                boxShadow: "0 6px 16px rgba(13,148,136,.3)",
                fontFamily: fontFamily.body,
              }}
            >
              {submitting
                ? mode === "create"
                  ? "注册中…"
                  : "保存中…"
                : mode === "create"
                ? "注册"
                : "保存"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 工具详情弹窗 ------------------------------
 * - ToolDetailModal：内置/MCP 通用的只读详情（全员放开）：
 *   基础信息 + MCP 工具 server 反查。
 */

/** 只读字段行（详情弹窗内 label + value 两栏） */
function DetailFieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs + 2 }}>
      <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>{label}</span>
      {children}
    </div>
  );
}

const EXEC_LABEL: Record<ApiTool["execution"], string> = {
  code: "代码",
  cli: "CLI",
  http: "HTTP",
  mcp: "MCP",
};

const SOURCE_LABEL: Record<ApiTool["source"], string> = {
  builtin: "内置",
  custom: "自定义",
  mcp: "MCP",
};

/** 工具来源三态徽章（内置=蓝 / 自定义=紫 / MCP=青，对齐 groupTheme 子 Tab 色系；
 * 后端 source 仍为三值联合，custom 主题内联保留以满足 Record 类型） */
const toolSourceTheme: Record<ApiTool["source"], { color: string; bg: string; border: string }> = {
  builtin: groupTheme.builtin,
  custom: { color: "#7C3AED", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" },
  mcp: groupTheme.mcp,
};

function ToolDetailModal({
  tool,
  mcpServer,
  onClose,
}: {
  tool: ApiTool;
  /** MCP 工具关联的 server（tool.mcpServer 弱关联，经 GET /mcp-servers 反查；无记录 → null） */
  mcpServer?: { name: string; type: "local" | "remote"; status: string | null };
  onClose: () => void;
}) {
  return (
    <div
      data-testid="tool-detail-modal-root"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8%",
      }}
    >
      <div
        aria-hidden
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      <div
        style={{
          position: "relative",
          width: 520,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "72vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
          fontFamily: fontFamily.body,
        }}
      >
        <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
          工具详情 {tool.name}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: `${space.md}px ${space.lg}px`,
          }}
        >
          <DetailFieldRow label="名称">
            <span data-testid="tool-detail-name" style={{ fontSize: fontSize.md, color: neutral[800] }}>
              {tool.name}
            </span>
          </DetailFieldRow>
          <DetailFieldRow label="调用标识（action）">
            <span
              data-testid="tool-detail-action"
              style={{
                fontSize: fontSize.md,
                color: neutral[800],
                fontFamily: fontFamily.mono,
              }}
            >
              {tool.action}
            </span>
          </DetailFieldRow>
          <DetailFieldRow label="来源">
            <PillBadge
              theme={toolSourceTheme[tool.source]}
              label={SOURCE_LABEL[tool.source]}
              testid="tool-detail-source"
              status={SOURCE_LABEL[tool.source]}
            />
          </DetailFieldRow>
          <DetailFieldRow label="执行方式">
            <span
              data-testid="tool-detail-execution"
              style={{ fontSize: fontSize.md, color: neutral[800] }}
            >
              {EXEC_LABEL[tool.execution]}
            </span>
          </DetailFieldRow>
          <DetailFieldRow label="启用状态">
            <PillBadge
              theme={enableColors[tool.enabled ? "启用" : "停用"]}
              label={tool.enabled ? "启用" : "停用"}
              testid="tool-detail-status"
              status={tool.enabled ? "启用" : "停用"}
            />
          </DetailFieldRow>
          <DetailFieldRow label="注册时间">
            <span
              data-testid="tool-detail-created"
              style={{ fontSize: fontSize.sm, color: neutral[500] }}
            >
              {new Date(tool.createdAt).toLocaleString()}
            </span>
          </DetailFieldRow>
        </div>

        {tool.source === "mcp" && (
          <DetailFieldRow label="关联 MCP server">
            {mcpServer ? (
              <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                <span
                  data-testid="tool-detail-mcp-server"
                  style={{
                    fontSize: fontSize.md,
                    color: neutral[800],
                    fontFamily: fontFamily.mono,
                  }}
                >
                  {mcpServer.name}
                </span>
                <McpTypeBadge type={mcpServer.type} />
                <McpStatusBadge status={toFrontendStatus(mcpServer.status)} />
              </div>
            ) : (
              <span
                data-testid="tool-detail-mcp-server"
                style={{ fontSize: fontSize.md, color: neutral[400] }}
              >
                {tool.mcpServer ?? "未关联（server 记录缺失）"}
              </span>
            )}
          </DetailFieldRow>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            data-testid="tool-detail-close"
            onClick={onClose}
            style={{
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[600],
              fontSize: fontSize.md,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 页面主组件 ------------------------------ */

type TabKey = "skill" | "tool";

/**
 * 注册弹窗共享输入框样式（浅色主题）。
 */
const modalInputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  color: neutral[800],
  fontSize: fontSize.md,
  fontFamily: fontFamily.body,

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

  /* MCP server 本体由 MCP 子 Tab 的「新建服务器」弹窗管理（POST /mcp-servers，
   * MCP 服务（含本地/远端）的唯一新增入口）。 */

  /* 二 Tab（受控）：技能 / 工具 */
  const [tab, setTab] = useState<TabKey>("skill");

  /* 工具 Tab 内子 Tab（受控互斥）：内置 / MCP，默认内置 */
  const [toolTab, setToolTab] = useState<ToolTabKey>("builtin");

  /* 服务端分页 state（每页 20 条） */
  const [skillPage, setSkillPage] = useState(1);
  const [mcpToolPage, setMcpToolPage] = useState(1);
  const [mcpServersPage, setMcpServersPage] = useState(1);
  const [serverToolsPage, setServerToolsPage] = useState(1);
  const [selectedServer, setSelectedServer] = useState<ApiMcpServer | null>(null);

  /* 页面内反馈条（success=操作成功 / error=API 失败 / info=提示；3s 自动消失） */
  const [notice, setNotice] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(
    null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* MCP server 管理弹窗（create=POST /mcp-servers / edit=PATCH /mcp-servers/:id / view=只读） */
  const [mcpServerModal, setMcpServerModal] = useState<{
    mode: "create" | "edit" | "view";
    server?: ApiMcpServer;
  } | null>(null);
  const [deletingMcpServer, setDeletingMcpServer] = useState<ApiMcpServer | null>(null);

  /* 工具详情弹窗（viewingTool 全员放开） */
  const [viewingTool, setViewingTool] = useState<ApiTool | null>(null);

  /* 新建技能弹窗（交互式创建）：字段 → 前端组装 SKILL.md → FormData 复用 POST /skills */
  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const [csName, setCsName] = useState("");
  const [csDescription, setCsDescription] = useState("");
  const [csVersion, setCsVersion] = useState("");
  const [csBody, setCsBody] = useState("");

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  // tab 切换时重置对应分页
  useEffect(() => {
    if (tab === "skill") setSkillPage(1);
  }, [tab]);
  useEffect(() => {
    if (tab === "tool" && toolTab === "mcp") {
      setMcpToolPage(1);
      setSelectedServer(null);
      setServerToolsPage(1);
    }
  }, [tab, toolTab]);

  const showNotice = (kind: "info" | "success" | "error", text: string) =>
    setNotice({ kind, text });

  /* 列表数据：GET /skills + GET /tools（分页 pageSize=20；MCP 服务器分页 + 全量反查） */
  const skillsQuery = useQuery({
    queryKey: ["skills", { page: skillPage }],
    queryFn: () =>
      api.get<PageResponse<ApiSkill>>("/skills", { query: { page: skillPage, pageSize: 20 } }),
  });
  const builtinToolsQuery = useQuery({
    queryKey: ["tools", { source: "builtin" }],
    queryFn: () =>
      api.get<PageResponse<ApiTool>>("/tools", { query: { source: "builtin", page: 1, pageSize: 100 } }),
  });
  const mcpToolsQuery = useQuery({
    queryKey: ["tools", { source: "mcp", page: mcpToolPage }],
    queryFn: () =>
      api.get<PageResponse<ApiTool>>("/tools", { query: { source: "mcp", page: mcpToolPage, pageSize: 20 } }),
  });
  // T8c：MCP 服务器真实三态数据源（GET /mcp-servers 含 worker 心跳上报的 status）
  const mcpServersQuery = useQuery({
    queryKey: ["mcp-servers", { page: mcpServersPage }],
    queryFn: () =>
      api.get<PageResponse<ApiMcpServer>>("/mcp-servers", {
        query: { page: mcpServersPage, pageSize: 20 },
      }),
  });
  // 全量 MCP 服务器（供 mcpServerMap 反查，分页查询只含当前页服务器）
  const allMcpServersQuery = useQuery({
    queryKey: ["mcp-servers-all"],
    queryFn: () =>
      api.get<PageResponse<ApiMcpServer>>("/mcp-servers", {
        query: { page: 1, pageSize: 100 },
      }),
    staleTime: 60_000,
  });
  // 二级视图：选中服务器的工具列表（工具表 mcpServer 存服务器名称，按 name 过滤）
  const serverToolsQuery = useQuery({
    queryKey: ["tools", { source: "mcp", mcpServer: selectedServer?.name, page: serverToolsPage }],
    queryFn: () =>
      api.get<PageResponse<ApiTool>>("/tools", {
        query: { source: "mcp", mcpServer: selectedServer!.name, page: serverToolsPage, pageSize: 20 },
      }),
    enabled: !!selectedServer,
  });

  const skillsData = useMemo(
    () => (skillsQuery.data?.items ?? []).map(toSkillItem),
    [skillsQuery.data]
  );
  const builtinData = useMemo(
    () => (builtinToolsQuery.data?.items ?? []).map(toBuiltinTool),
    [builtinToolsQuery.data]
  );
  // T8c：mcp-servers 建索引（type + 三态 status）。双键：tool.mcpServer 为弱关联
  // 存 server id（ms_xxx），用户注册时也可能直接写 server 名 → id/name 均可命中
  const mcpServerMap = useMemo(() => {
    const map = new Map<string, { name: string; type: "local" | "remote"; status: string | null }>();
    for (const s of allMcpServersQuery.data?.items ?? []) {
      const value = { name: s.name, type: s.type, status: s.status };
      map.set(s.id, value);
      map.set(s.name, value);
    }
    return map;
  }, [allMcpServersQuery.data]);
  // 合并工具查询 items 供 handleViewTool 反查
  const allToolsItems = useMemo(
    () => [
      ...(builtinToolsQuery.data?.items ?? []),
      ...(mcpToolsQuery.data?.items ?? []),
    ],
    [builtinToolsQuery.data, mcpToolsQuery.data]
  );
  // 二级视图用 serverToolsQuery items 补充反查
  const allToolsWithServer = useMemo(
    () => (selectedServer ? [...allToolsItems, ...(serverToolsQuery.data?.items ?? [])] : allToolsItems),
    [allToolsItems, selectedServer, serverToolsQuery.data]
  );

  // totalPages 计算
  const skillTotalPages = Math.max(1, Math.ceil((skillsQuery.data?.total ?? 0) / 20));
  const mcpServersTotalPages = Math.max(1, Math.ceil((mcpServersQuery.data?.total ?? 0) / 20));
  const serverToolsTotalPages = Math.max(1, Math.ceil((serverToolsQuery.data?.total ?? 0) / 20));
  // effectiveSelectedServer：allMcpServersQuery 数据重派生（防止 selectedServer 被删除后失效）
  const effectiveSelectedServer = selectedServer
    ? allMcpServersQuery.data?.items.find((s) => s.id === selectedServer.id) ?? selectedServer
    : null;

  const loadError = (() => {
    const err = skillsQuery.error ?? builtinToolsQuery.error ?? mcpToolsQuery.error ?? mcpServersQuery.error;
    if (!err) return null;
    return isApiError(err) ? err.message : "加载技能/工具列表失败";
  })();
  const isLoading = skillsQuery.isPending || builtinToolsQuery.isPending || mcpToolsQuery.isPending || mcpServersQuery.isPending;

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

  /* 新建技能（交互式）：FormData 携带前端组装的 SKILL.md（new File 包装，multipart file 字段），
   * 复用 POST /skills 契约零后端改动；成功刷新列表 + 关闭弹窗，失败（含 409 SKILL_NAME_EXISTS）在弹窗内展示 */
  const createSkillMutation = useMutation({
    mutationFn: (md: string) => {
      const fd = new FormData();
      fd.append("file", new File([md], "SKILL.md", { type: "text/markdown" }));
      return api.post<ApiSkill>("/skills", fd);
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      setCreateSkillOpen(false);
      showNotice("success", `技能「${created.name}」创建成功`);
    },
  });

  /* 编辑技能：PATCH /skills/:id {name?, description?, content?}（UX-15；name/description 变更
   * 后端同步重写 content frontmatter）→ 刷新技能列表并关闭弹窗 */
  const editMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { name: string; description: string; content: string } }) =>
      api.patch<ApiSkill>(`/skills/${id}`, payload),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      setEditingSkill(null);
      showNotice("success", `技能「${updated.name}」保存成功`);
    },
    onError: (err) => showNotice("error", isApiError(err) ? err.message : "保存失败，请稍后重试"),
  });

  /* MCP server 注册/编辑：create=POST /mcp-servers / edit=PATCH /mcp-servers/:id
   * （name 改撞唯一名 → 后端 409；成功刷新 mcp-servers + tools——MCP 工具行 server 反查依赖） */
  const mcpServerMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id?: string;
      payload: {
        name: string;
        type: "local" | "remote";
        command?: Record<string, unknown>;
        url?: string | null;
        headers?: Record<string, unknown> | null;
        enabled: boolean;
      };
    }) =>
      id
        ? api.patch<ApiMcpServer>(`/mcp-servers/${id}`, payload)
        : api.post<ApiMcpServer>("/mcp-servers", payload),
    onSuccess: (updated, vars) => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers-all"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      setMcpServerModal(null);
      showNotice("success", `MCP 服务器「${updated.name}」${vars.id ? "保存" : "注册"}成功`);
      /* 保存后自动同步：create 必触发（新服务工具数为 0）；edit 仅连接字段
       * （type/url/command/headers）变更时触发，改名/启停不触发 */
      if (pendingSyncId !== null) return;
      if (!vars.id) {
        syncMcpServerMutation.mutate({ id: updated.id, auto: true });
        return;
      }
      const baseline = editBaselineRef.current;
      editBaselineRef.current = null;
      if (!baseline) return;
      const norm = (v: unknown) => JSON.stringify(v ?? null);
      if (
        vars.payload.type !== baseline.type ||
        norm(vars.payload.url) !== norm(baseline.url) ||
        norm(vars.payload.command) !== norm(baseline.command) ||
        norm(vars.payload.headers) !== norm(baseline.headers)
      ) {
        syncMcpServerMutation.mutate({ id: vars.id, auto: true });
      }
    },
    onError: (err) => showNotice("error", isApiError(err) ? err.message : "保存失败，请稍后重试"),
  });

  /* MCP server 删除：DELETE /mcp-servers/:id（ConfirmDialog 确认；物理删除 + 级联删除其物化的工具行） */
  const deleteMcpServerMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/mcp-servers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers-all"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      setDeletingMcpServer(null);
      showNotice("success", "MCP 服务器已删除");
    },
    onError: (err) => showNotice("error", isApiError(err) ? err.message : "删除失败，请稍后重试"),
  });

  /* MCP server 启停：PATCH /mcp-servers/:id {enabled}（内置/自定义通用；worker 注入按 enabled
   * 过滤，切换后经 broadcastReloadConfig 广播自动重拉）→ 刷新 mcp-servers + tools */
  const toggleMcpServerMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<ApiMcpServer>(`/mcp-servers/${id}`, { enabled }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers-all"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      showNotice("success", vars.enabled ? "已启用" : "已停用");
    },
    onError: (err) => showNotice("error", isApiError(err) ? err.message : "操作失败，请稍后重试"),
  });

  /* MCP server 工具同步：POST /mcp-servers/:id/sync（将已发现的工具物化为 tools 表行，
   * serverToolsQuery 读的正是该表）→ 刷新 mcp-servers + tools（含选中 server 的二级工具列表）。
   * 保存后自动同步（create 必触发；edit 仅连接字段变更时触发，见 editBaselineRef），
   * 跳过项（重复/冲突）落 syncReport 告警卡常驻展示（3s 反馈条放不下）。 */
  const [pendingSyncId, setPendingSyncId] = useState<string | null>(null);
  const [syncReport, setSyncReport] = useState<{
    serverName: string;
    discovered: number;
    created: number;
    updated: number;
    disabled: number;
    skipped: { action: string; reason: string }[];
  } | null>(null);
  const syncMcpServerMutation = useMutation({
    mutationFn: (vars: { id: string; auto?: boolean }) =>
      api.post<McpSyncResult>(`/mcp-servers/${vars.id}/sync`, {}),
    onMutate: ({ id }) => setPendingSyncId(id),
    onSettled: () => setPendingSyncId(null),
    onSuccess: (res, vars) => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers-all"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      if (selectedServer) void serverToolsQuery.refetch();
      const discovered = res.discovered ?? 0;
      const created = res.created ?? 0;
      const updated = res.updated ?? 0;
      const disabled = res.disabled ?? 0;
      const skipped = res.skipped ?? [];
      const serverName = res.server?.name ?? "";
      if (skipped.length > 0) {
        setSyncReport({ serverName, discovered, created, updated, disabled, skipped });
      } else {
        setSyncReport(null);
      }
      showNotice(
        vars.auto ? "info" : "success",
        `${vars.auto ? "已保存并自动同步" : "同步完成"}${serverName ? `「${serverName}」` : ""}：发现${discovered} · 新增${created} · 更新${updated} · 停用${disabled} · 跳过${skipped.length}`
      );
    },
    onError: (err, vars) =>
      showNotice(
        "error",
        isApiError(err)
          ? vars.auto
            ? `已保存，自动同步失败：${err.message}（可在操作列手动同步）`
            : `同步失败：${err.message}`
          : "同步失败，请稍后重试"
      ),
  });

  /* 编辑弹窗 state：editingSkill=目标行；editContent 打开时经 GET /skills/:id/content 拉取
   * （列表接口不含 content 字段），editLoading 期间禁用保存 */
  const [editingSkill, setEditingSkill] = useState<SkillItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editLoading, setEditLoading] = useState(false);

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

  /* 新建技能：打开弹窗（重置表单与错误态，避免残留上一次输入） */
  const handleOpenCreateSkill = () => {
    createSkillMutation.reset();
    setCsName("");
    setCsDescription("");
    setCsVersion("");
    setCsBody("");
    setCreateSkillOpen(true);
  };

  /* 新建技能提交：name 需为小写 slug（与后端 assertSkillName 一致），组装 SKILL.md 后 multipart 创建 */
  const handleCreateSkillSubmit = () => {
    const name = csName.trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      showNotice("error", "技能名需为小写 slug（如 git-ops）");
      return;
    }
    createSkillMutation.mutate(buildSkillMarkdown(csName, csDescription, csVersion, csBody));
  };

  /* SKILL.md 实时预览：表单任一字段变化即重算（全空时返回 null → 预览区显示占位引导） */
  const skillMdPreview = useMemo(() => {
    if (!csName.trim() && !csDescription.trim() && !csBody.trim()) return null;
    return buildSkillMarkdown(csName, csDescription, csVersion, csBody);
  }, [csName, csDescription, csVersion, csBody]);

  /* 打开编辑弹窗：重置错误态 + 预填 name/description + 拉取 SKILL.md 全文填充 content */
  const handleOpenEdit = (s: SkillItem) => {
    editMutation.reset();
    setEditingSkill(s);
    setEditName(s.name);
    // 列表 desc 以「—」占位描述为 null 的技能，编辑回填时还原为空串
    const raw = skillsQuery.data?.items.find((x) => x.id === s.id);
    setEditDescription(raw?.description ?? "");
    setEditContent("");
    setEditLoading(true);
    api
      .get<{ id: string; name: string; content: string }>(`/skills/${s.id}/content`)
      .then((res) => setEditContent(res.content))
      .catch((err) =>
        showNotice("error", isApiError(err) ? err.message : "加载技能内容失败")
      )
      .finally(() => setEditLoading(false));
  };

  /* 打开 MCP server 弹窗：create 空表单 / edit·view 预填当前 server（重置 mutation 错误态）。
   * 内置 server（vteam / vteam-api）只读 → 强制 view，入口即使误传 edit 也降级为只读。 */
  const handleOpenMcpServerModal = (
    mode: "create" | "edit" | "view",
    server?: ApiMcpServer
  ) => {
    mcpServerMutation.reset();
    const effective = server && isBuiltinMcpServer(server.name) ? "view" : mode;
    setMcpServerModal({ mode: effective, server });
  };

  /* MCP server 保存：edit → PATCH /mcp-servers/:id / create → POST /mcp-servers。
   * editBaselineRef 记录编辑前快照，供保存成功后判定连接字段是否变更（自动同步依据） */
  const editBaselineRef = useRef<ApiMcpServer | null>(null);
  const handleMcpServerSave: Parameters<typeof McpServerModal>[0]["onSave"] = (payload) => {
    const target = mcpServerModal?.server;
    editBaselineRef.current =
      target && mcpServerModal?.mode === "edit" ? target : null;
    mcpServerMutation.mutate(
      target && mcpServerModal?.mode === "edit" ? { id: target.id, payload } : { payload }
    );
  };

  /* MCP server 启停：目标态为当前 enabled 取反（PATCH /mcp-servers/:id {enabled}） */
  const handleToggleMcpServer = (s: ApiMcpServer) => {
    toggleMcpServerMutation.mutate({ id: s.id, enabled: !s.enabled });
  };

  /* MCP server 工具同步：触发 POST /mcp-servers/:id/sync（逐行 pending，见 pendingSyncId） */
  const handleSyncMcpServer = (s: ApiMcpServer) => {
    if (pendingSyncId !== null) return;
    syncMcpServerMutation.mutate({ id: s.id });
  };

  /* 工具详情：从合并工具列表反查原始 ApiTool（含 schema/initCommand/mcpServer） */
  const handleViewTool = (toolId: string) => {
    const raw = allToolsWithServer.find((x) => x.id === toolId);
    if (raw) setViewingTool(raw);
  };

  /* 保存编辑：name 需为小写 slug（与后端 assertSkillName 一致），三个字段全量提交 */
  const handleEditSubmit = () => {
    const name = editName.trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      showNotice("error", "技能名需为小写 slug（如 git-ops）");
      return;
    }
    if (!editingSkill) return;
    editMutation.mutate({
      id: editingSkill.id,
      payload: { name, description: editDescription.trim(), content: editContent },
    });
  };

  /* 工具总数 = 内置 + MCP（Tab 徽章计数） */
  const toolTotal = (builtinToolsQuery.data?.total ?? 0) + (mcpToolsQuery.data?.total ?? 0);

  const tabs: { key: TabKey; label: string; icon: string; count: number }[] = [
    { key: "skill", label: "技能", icon: "✦", count: skillsQuery.data?.total ?? 0 },
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
      hint: "子 Tab 分来源：内置（平台预置）/ MCP（<server>_<tool>）",
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
                notice.kind === "success" ? "rgba(16,185,129,0.10)" : notice.kind === "error" ? "rgba(239,68,68,0.10)" : "rgba(13,148,136,0.10)",
              border:
                notice.kind === "success" ? "1px solid rgba(16,185,129,0.28)" : notice.kind === "error" ? "1px solid rgba(239,68,68,0.22)" : "1px solid rgba(13,148,136,0.22)",
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

        {/* 同步重复/冲突告警卡（sync 跳过项常驻展示，手动关闭；3s 反馈条放不下明细） */}
        {syncReport && syncReport.skipped.length > 0 && (
          <div
            data-testid="sync-report"
            role="alert"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: space.sm,
              padding: `${space.md}px ${space.lg}px`,
              borderRadius: radius.md,
              backgroundColor: "rgba(245,158,11,0.10)",
              border: "1px solid rgba(245,158,11,0.28)",
              color: "#92400E",
              fontSize: fontSize.sm,
              lineHeight: 1.6,
              ...baseFont,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>⚠️</span>
              <span style={{ fontWeight: 600 }}>
                「{syncReport.serverName}」同步发现 {syncReport.skipped.length} 个重复工具未入库（发现{syncReport.discovered} · 新增{syncReport.created} · 更新{syncReport.updated} · 停用{syncReport.disabled}）
              </span>
              <button
                type="button"
                data-testid="sync-report-dismiss"
                onClick={() => setSyncReport(null)}
                style={{
                  marginLeft: "auto",
                  padding: `${space.xs}px ${space.sm + 2}px`,
                  borderRadius: radius.md,
                  border: `1px solid rgba(245,158,11,0.35)`,
                  backgroundColor: "var(--color-surface)",
                  color: "#92400E",
                  fontSize: fontSize.sm,
                  cursor: "pointer",
                  fontFamily: fontFamily.body,
                  whiteSpace: "nowrap",
                }}
              >
                知道了
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {syncReport.skipped.slice(0, 8).map((sk) => (
                <div
                  key={sk.action}
                  data-testid="sync-report-skip-item"
                  data-action={sk.action}
                  style={{ display: "flex", gap: space.sm, alignItems: "baseline" }}
                >
                  <code
                    style={{
                      fontFamily: fontFamily.mono,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {sk.action}
                  </code>
                  <span style={{ color: "#B45309" }}>{sk.reason}</span>
                </div>
              ))}
              {syncReport.skipped.length > 8 && (
                <span>等另外 {syncReport.skipped.length - 8} 个（建议删除重复指向同一服务的 server 后重新同步）</span>
              )}
            </div>
          </div>
        )}

        {/* 工具条：二 Tab + 右上操作按钮（随 Tab 切换） */}
        <div
          data-testid="manage-toolbar"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.lg,
            flexWrap: "wrap",
          }}
        >
          {/* 二 Tab（受控切换，统一样式见 ui/SegmentedTabs） */}
          <SegmentedTabs items={tabs} active={tab} onChange={(k) => setTab(k as TabKey)} />

          {/* 右上操作：随 Tab 切换（新建/上传技能 → POST /skills multipart）。
           * [admin] 专属（09 §3.8）；成员只读不渲染操作入口。
           * 工具 Tab 无独立操作入口：MCP 服务的新增统一走 MCP 子 Tab「新建服务器」弹窗。 */}
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginLeft: "auto" }}>
            {tab === "skill" && isAdmin && (
              <>
                {/* 新建技能 = 交互式创建（弹窗表单 → 前端组装 SKILL.md → FormData 复用 POST /skills） */}
                <button
                  type="button"
                  data-testid="create-skill-button"
                  onClick={handleOpenCreateSkill}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: space.xs,
                    padding: `${space.sm + 1}px ${space.lg}px`,
                    borderRadius: radius.pill,
                    border: "none",
                    backgroundColor: "#0D9488",
                    color: "#FFFFFF",
                    fontSize: fontSize.md,
                    fontWeight: 500,
                    cursor: "pointer",
                    boxShadow: "0 6px 16px rgba(13,148,136,.3)",
                    fontFamily: fontFamily.body,
                  }}
                >
                  <span aria-hidden>✦</span>
                  新建技能
                </button>
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
                    backgroundColor: "var(--color-surface)",
                    color: neutral[700],
                    fontSize: fontSize.md,
                    cursor: "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  <span aria-hidden>⧉</span>
                  上传技能
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
            backgroundColor: "var(--color-surface)",
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
                    builtinToolsQuery.refetch();
                    mcpToolsQuery.refetch();
                    mcpServersQuery.refetch();
                  }}
                  style={{
                    padding: `${space.sm}px ${space.lg}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "var(--color-surface)",
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
                  onEdit={() => handleOpenEdit(s)}
                  onToggle={() => handleToggleEnabled("skill", s.id, s.enabled === "启用")}
                  canManage={isAdmin}
                />
              ))
            ))}
            {tab === "skill" && !isLoading && !loadError && skillsData.length > 0 && (
              <div style={{ display: "flex", justifyContent: "center", paddingTop: space.sm }}>
                <Pagination
                  page={skillPage}
                  totalPages={skillTotalPages}
                  onPageChange={setSkillPage}
                  dataTestId="skills-pagination"
                />
              </div>
            )}

          {/* 工具列表：二子 Tab 互斥切换（内置 / MCP） */}
          {tab === "tool" && (
            <>
              <ToolSubTabs
                active={toolTab}
                onChange={setToolTab}
                counts={{
                  builtin: builtinToolsQuery.data?.total ?? 0,
                  mcp: mcpToolsQuery.data?.total ?? 0,
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
                      builtinToolsQuery.refetch();
                      mcpToolsQuery.refetch();
                      mcpServersQuery.refetch();
                    }}
                    style={{
                      padding: `${space.sm}px ${space.lg}px`,
                      borderRadius: radius.md,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: "var(--color-surface)",
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
                      onView={() => handleViewTool(t.id)}
                      onToggle={() => handleToggleEnabled("tool", t.id, t.enabled === "启用")}
                      canManage={isAdmin}
                    />
                  ))
                )
              ) : (
                <>
                  {!effectiveSelectedServer ? (
                    <>
                      <McpServerSection
                        servers={mcpServersQuery.data?.items ?? []}
                        canManage={isAdmin}
                        onView={(s) => handleOpenMcpServerModal("view", s)}
                        onEdit={(s) => handleOpenMcpServerModal("edit", s)}
                        onCreate={() => handleOpenMcpServerModal("create")}
                        onDelete={(s) => setDeletingMcpServer(s)}
                        onToggle={(s) => handleToggleMcpServer(s)}
                        onSelect={(s) => { setSelectedServer(s); setServerToolsPage(1); }}
                        onSync={(s) => handleSyncMcpServer(s)}
                        pendingSyncId={pendingSyncId}
                      />
                      {mcpServersQuery.data?.items && mcpServersQuery.data.items.length > 0 && (
                        <div style={{ display: "flex", justifyContent: "center", paddingTop: space.sm }}>
                          <Pagination
                            page={mcpServersPage}
                            totalPages={mcpServersTotalPages}
                            onPageChange={setMcpServersPage}
                            dataTestId="mcp-servers-pagination"
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {/* 面包屑行 */}
                      <div
                        data-testid="mcp-server-breadcrumb"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: space.sm,
                          padding: `${space.sm}px 0`,
                        }}
                      >
                        <button
                          type="button"
                          data-testid="mcp-server-back-button"
                          onClick={() => setSelectedServer(null)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: space.xs,
                            padding: `${space.xs}px ${space.sm}px`,
                            borderRadius: radius.md,
                            border: `1px solid ${neutral[200]}`,
                            backgroundColor: "var(--color-surface)",
                            color: neutral[600],
                            fontSize: fontSize.sm,
                            cursor: "pointer",
                            fontFamily: fontFamily.body,
                          }}
                        >
                          ← 返回 MCP 服务器列表
                        </button>
                        <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900], fontFamily: fontFamily.mono }}>
                          {effectiveSelectedServer.name}
                        </span>
                        <span style={{ fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.mono }}>
                          {mcpServerEndpoint(effectiveSelectedServer)}
                        </span>
                      </div>
                      {serverToolsQuery.isPending ? (
                        <div
                          data-testid="server-tools-loading"
                          style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}
                        >
                          加载中…
                        </div>
                      ) : serverToolsQuery.error ? (
                        <div
                          data-testid="server-tools-error"
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
                          <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>加载服务器工具失败</div>
                          <button
                            type="button"
                            data-testid="server-tools-retry"
                            onClick={() => serverToolsQuery.refetch()}
                            style={{
                              padding: `${space.sm}px ${space.lg}px`,
                              borderRadius: radius.md,
                              border: `1px solid ${neutral[200]}`,
                              backgroundColor: "var(--color-surface)",
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
                      ) : (serverToolsQuery.data?.items ?? []).length === 0 ? (
                        <div
                          data-testid="server-tools-empty"
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
                          <span>该服务器暂无工具</span>
                        </div>
                      ) : (
                        <>
                          {(serverToolsQuery.data?.items ?? []).map((t) => {
                            const mapped = toMcpTool(t, mcpServerMap.get(t.mcpServer ?? "mcp"));
                            return (
                              <McpToolRow
                                key={t.id}
                                t={mapped}
                                onView={() => handleViewTool(t.id)}
                                onToggle={() => handleToggleEnabled("tool", t.id, !t.enabled)}
                                canManage={isAdmin}
                              />
                            );
                          })}
                          <div style={{ display: "flex", justifyContent: "center", paddingTop: space.sm }}>
                            <Pagination
                              page={serverToolsPage}
                              totalPages={serverToolsTotalPages}
                              onPageChange={setServerToolsPage}
                              dataTestId="mcp-server-tools-pagination"
                            />
                          </div>
                        </>
                      )}
                    </>
                  )}
                </>
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

      {/* 编辑技能弹窗（UX-15）：name/description 输入 + SKILL.md 全文 textarea，PATCH /skills/:id。
       * 列表接口不含 content → 打开时 GET /skills/:id/content 拉取原文预填。 */}
      {editingSkill && (
        <div
          data-testid="edit-skill-modal-root"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 40,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: "8%",
          }}
        >
          <div
            aria-hidden
            onClick={() => setEditingSkill(null)}
            style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
          />
          <div
            style={{
              position: "relative",
              width: 560,
              maxWidth: "calc(100% - 48px)",
              maxHeight: "70vh",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: space.lg,
              padding: `${space.xl}px`,
              borderRadius: radius.lg,
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.lg,
              fontFamily: fontFamily.body,
            }}
          >
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              编辑技能 {editingSkill.name}
            </div>
            <ModalFieldRow label="技能名（小写 slug）">
              <input
                data-testid="edit-skill-name-input"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                spellCheck={false}
                placeholder="如 git-ops"
                style={{ ...modalInputStyle, fontFamily: fontFamily.mono }}
              />
            </ModalFieldRow>
            <ModalFieldRow label="描述">
              <input
                data-testid="edit-skill-desc-input"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="技能用途说明"
                style={modalInputStyle}
              />
            </ModalFieldRow>
            <ModalFieldRow label="SKILL.md 内容">
              <textarea
                data-testid="edit-skill-content-input"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                disabled={editLoading}
                rows={14}
                spellCheck={false}
                placeholder={editLoading ? "加载中…" : "---\nname: git-ops\n---\n技能正文"}
                style={{
                  ...modalInputStyle,
                  fontFamily: fontFamily.mono,
                  lineHeight: 1.5,
                  resize: "vertical",
                }}
              />
            </ModalFieldRow>
            <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.6 }}>
              修改「技能名/描述」会同步写入 SKILL.md 的 frontmatter；内容可直接编辑全文（需保留 ---
              frontmatter 块）。
            </div>
            {editMutation.isError && (
              <div
                role="alert"
                style={{
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: radius.md,
                  backgroundColor: "rgba(239,68,68,0.10)",
                  border: "1px solid rgba(239,68,68,0.22)",
                  color: "#DC2626",
                  fontSize: fontSize.sm,
                  lineHeight: 1.6,
                }}
              >
                {isApiError(editMutation.error)
                  ? editMutation.error.message
                  : "保存失败，请稍后重试"}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
              <button
                type="button"
                data-testid="edit-skill-modal-cancel"
                onClick={() => setEditingSkill(null)}
                disabled={editMutation.isPending}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "var(--color-surface)",
                  color: neutral[600],
                  fontSize: fontSize.md,
                  cursor: editMutation.isPending ? "default" : "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="edit-skill-confirm-button"
                disabled={editMutation.isPending || editLoading}
                onClick={handleEditSubmit}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#0D9488",
                  color: "#FFFFFF",
                  fontSize: fontSize.md,
                  fontWeight: 500,
                  cursor: editMutation.isPending || editLoading ? "default" : "pointer",
                  opacity: editMutation.isPending || editLoading ? 0.6 : 1,
                  boxShadow: "0 6px 16px rgba(13,148,136,.3)",
                  fontFamily: fontFamily.body,
                }}
              >
                {editMutation.isPending ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建技能弹窗（交互式创建）：name/description/version/正文 → 前端组装 SKILL.md →
       * FormData 复用 POST /skills multipart（零后端改动）；预览区实时刷新生成的 frontmatter；
       * 必填校验禁用提交 + 后端 409 SKILL_NAME_EXISTS 在弹窗内展示 */}
      {createSkillOpen && (
        <div
          data-testid="create-skill-modal-root"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 40,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: "8%",
          }}
        >
          <div
            aria-hidden
            onClick={() => setCreateSkillOpen(false)}
            style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
          />
          <div
            style={{
              position: "relative",
              width: 560,
              maxWidth: "calc(100% - 48px)",
              maxHeight: "70vh",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: space.lg,
              padding: `${space.xl}px`,
              borderRadius: radius.lg,
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.lg,
              fontFamily: fontFamily.body,
            }}
          >
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              新建技能
            </div>
            <ModalFieldRow label="技能名称（小写 slug）">
              <input
                data-testid="create-skill-name-input"
                value={csName}
                onChange={(e) => setCsName(e.target.value)}
                spellCheck={false}
                placeholder="如 git-ops"
                style={{ ...modalInputStyle, fontFamily: fontFamily.mono }}
              />
            </ModalFieldRow>
            <ModalFieldRow label="描述">
              <input
                data-testid="create-skill-desc-input"
                value={csDescription}
                onChange={(e) => setCsDescription(e.target.value)}
                placeholder="技能用途说明"
                style={modalInputStyle}
              />
            </ModalFieldRow>
            <ModalFieldRow label="版本">
              <input
                data-testid="create-skill-version-input"
                value={csVersion}
                onChange={(e) => setCsVersion(e.target.value)}
                spellCheck={false}
                placeholder="如 v1.2，留空默认 v1"
                style={{ ...modalInputStyle, fontFamily: fontFamily.mono }}
              />
            </ModalFieldRow>
            <ModalFieldRow label="技能正文">
              <textarea
                data-testid="create-skill-body-input"
                value={csBody}
                onChange={(e) => setCsBody(e.target.value)}
                rows={8}
                spellCheck={false}
                placeholder="使用说明、操作步骤、示例等"
                style={{ ...modalInputStyle, lineHeight: 1.6, resize: "vertical" }}
              />
            </ModalFieldRow>
            {/* SKILL.md 实时预览（name/description/version/正文任一变化即刷新） */}
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs + 2 }}>
              <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>
                SKILL.md 预览
              </span>
              {skillMdPreview === null ? (
                <div
                  data-testid="create-skill-preview-empty"
                  style={{
                    padding: `${space.md}px`,
                    borderRadius: radius.md,
                    backgroundColor: neutral[50],
                    border: `1px dashed ${neutral[200]}`,
                    color: neutral[400],
                    fontSize: fontSize.sm,
                    fontFamily: fontFamily.mono,
                  }}
                >
                  填写上方字段后实时生成 SKILL.md 预览
                </div>
              ) : (
                <pre
                  data-testid="create-skill-preview"
                  style={{
                    margin: 0,
                    padding: `${space.md}px`,
                    borderRadius: radius.md,
                    backgroundColor: neutral[50],
                    border: `1px solid ${neutral[200]}`,
                    color: neutral[800],
                    fontSize: fontSize.sm,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    fontFamily: fontFamily.mono,
                    maxHeight: 180,
                    overflowY: "auto",
                  }}
                >
                  {skillMdPreview}
                </pre>
              )}
            </div>
            {createSkillMutation.isError && (
              <div
                role="alert"
                style={{
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: radius.md,
                  backgroundColor: "rgba(239,68,68,0.10)",
                  border: "1px solid rgba(239,68,68,0.22)",
                  color: "#DC2626",
                  fontSize: fontSize.sm,
                  lineHeight: 1.6,
                }}
              >
                {isApiError(createSkillMutation.error)
                  ? createSkillMutation.error.message
                  : "创建失败，请稍后重试"}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
              <button
                type="button"
                data-testid="create-skill-modal-cancel"
                onClick={() => setCreateSkillOpen(false)}
                disabled={createSkillMutation.isPending}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "var(--color-surface)",
                  color: neutral[600],
                  fontSize: fontSize.md,
                  cursor: createSkillMutation.isPending ? "default" : "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="create-skill-confirm-button"
                disabled={
                  !csName.trim() || !csDescription.trim() || !csBody.trim() || createSkillMutation.isPending
                }
                onClick={handleCreateSkillSubmit}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#0D9488",
                  color: "#FFFFFF",
                  fontSize: fontSize.md,
                  fontWeight: 500,
                  cursor:
                    !csName.trim() || !csDescription.trim() || !csBody.trim() || createSkillMutation.isPending
                      ? "default"
                      : "pointer",
                  opacity:
                    !csName.trim() || !csDescription.trim() || !csBody.trim() || createSkillMutation.isPending
                      ? 0.6
                      : 1,
                  boxShadow: "0 6px 16px rgba(13,148,136,.3)",
                  fontFamily: fontFamily.body,
                }}
              >
                {createSkillMutation.isPending ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MCP server 注册/编辑/查看弹窗（create=POST /mcp-servers / edit=PATCH /mcp-servers/:id / view=只读） */}
      {mcpServerModal && (
        <McpServerModal
          mode={mcpServerModal.mode}
          server={mcpServerModal.server}
          submitting={mcpServerMutation.isPending}
          error={
            mcpServerMutation.isError
              ? isApiError(mcpServerMutation.error)
                ? mcpServerMutation.error.message
                : "保存失败，请稍后重试"
              : null
          }
          onClose={() => setMcpServerModal(null)}
          onSave={handleMcpServerSave}
        />
      )}

      {/* MCP server 删除确认（物理删除 + 级联删除其物化的工具行，避免孤儿占 action） */}
      <ConfirmDialog
        open={deletingMcpServer !== null}
        testid="delete-mcp-server"
        title={`删除 MCP 服务器 ${deletingMcpServer?.name ?? ""}`}
        description={`删除后无法恢复；该服务器已同步的 ${deletingMcpServer?.toolCount ?? 0} 个工具将一并删除（释放 action 占用）。`}
        confirmLabel="删除"
        submitting={deleteMcpServerMutation.isPending}
        onClose={() => setDeletingMcpServer(null)}
        onConfirm={() =>
          deletingMcpServer && deleteMcpServerMutation.mutate(deletingMcpServer.id)
        }
      />

      {/* 工具详情弹窗（内置/MCP 通用，全员放开：基础信息 + MCP server 反查） */}
      {viewingTool && (
        <ToolDetailModal
          tool={viewingTool}
          mcpServer={
            viewingTool.source === "mcp"
              ? mcpServerMap.get(viewingTool.mcpServer ?? "mcp")
              : undefined
          }
          onClose={() => setViewingTool(null)}
        />
      )}
    </div>
  );
}
