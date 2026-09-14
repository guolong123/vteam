"use client";

/**
 * Agent 管理页（Lane W：生效权限只读展示 + 真实 API 接入）
 * =============================================
 * 唯一来源：docs/agent-platform/prototypes/agent-config/index.tsx（布局/间距/文案/data-testid 零改动）。
 * - 左 Agent 列表（320px，data-testid=agent-list-item）+ 右 ConfigPanel 配置面板：
 *   提示词（prompt-editor）/ 默认模型（model-select）/
 *   权限（effective-permission-section 只读：执行策略生效权限）。
 * - 数据源：GET /api/v1/agents（type 过滤 + 分页 + 扩展字段）→ TanStack Query；
 *   选中 Agent → GET /api/v1/agents/:id 详情（列表条目已含扩展字段，详情查询保证选中态最新）。
 * - 权限区只读渲染 `effectivePermission`（ExecutionPolicy 解析：edit/read glob + bash/task
 *   + vteam_* MCP 工具 deny），不做任何编辑与保存；未绑定策略时中性提示，不做历史回退。
 * - MCP 工具按 `mcpServer` 分组（GET /mcp-servers + GET /tools?source=mcp&includeDisabled=true
 *   解析归属；匹配按工具 name/action 双键，vteam_ 前缀兼容裸名）；
 *   停用 server 的分组默认收起（aria-expanded 可展开），启用 server 默认展开。
 * - 交互：
 *   · clone-template-button → POST /agents/:id/clone → 刷新列表并选中克隆体（可继续编辑）
 *   · 新建自定义 → 弹窗 POST /agents（type=custom）→ 刷新列表并选中新建
 *   · type=custom / clone / template → 均可编辑设置（提示词 / 默认模型）→ PATCH 保存
 * - is_0000000030：内置（template）agent 设置可编辑（后端已放开，agentId/type 不可改）；
 *   删除仍对 template 隐藏（后端 DELETE 403 PERMISSION_AGENT_READONLY 兜底），
 *   isTemplate 仅用于主题色展示，不再作为只读态。
 * - 页面内扩展 token（仿原型 :156-170）：effectBadgeMeta（allow/ask/deny 三态色，
 *   与 opencode PermissionV2 对齐），不写 tokens.ts 基线。
 * - 技能注入为全局机制（worker 级全局注入，不按 agent 绑定），前端移除绑定配置。
 * - 导航（NavTopBar/NavDock/CmdKPanel）由 AppShell 提供，本页仅渲染内容区。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；新建弹窗 absolute 相对页面 root（flex:1 铺满）。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { hasPermission } from "@/lib/permissions";
import { useAuthStore } from "@/lib/stores/authStore";
import { AgentAvatar, ConfirmDialog, PageWindow } from "@/src/components/ui";
import { type OpencodeAgentItem, isSelectableOpencodeAgent } from "@/src/components/teams/TeamMembersPanel";
import { type AvailableModel } from "@/src/types/models";
import {
  type RoleKey,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ API 数据模型（T5/T3 契约） ------------------------------ */

/** 生效权限（GET /agents + GET /agents/:id 返回；ExecutionPolicy 按绑定策略解析）。 */
interface EffectivePermission {
  policyId: string;
  policyName: string;
  agentName: string;
  /** 层① opencode 原生 permission：edit/read 路径 glob map + bash/task + vteam_<action> deny */
  permission: Record<string, unknown>;
  /** 层② guard allowlist：tools 真实暴露名 → allow|ask（与 /agent-policies 同源；缺失时按空表处理） */
  tools?: Record<string, unknown>;
  /** 层② bash 硬化清单（展示不消费，保留供一致性校验） */
  bashDeny?: unknown;
  /** 层② guard 纠正：scopeSummary/handoff/denyTemplate */
  correction: Record<string, unknown>;
}

/** GET /agents 条目（对齐 AgentsService.toAgentDto 扩展字段）。 */
interface AgentItem {
  id: string;
  name: string;
  /** product | architect | developer | tester | null（自定义可为任意角色 key） */
  role: string | null;
  /** 机器安全标识（opencode agent 名 = vteam-<agentKey>；模板回填 role；自定义/克隆必填） */
  agentKey: string | null;
  /** template（只读）/ custom（自定义）/ clone（克隆副本，可写） */
  type: string;
  prompt: string;
  baseAgentId: string | null;
  defaultModelId: string | null;
  /** 首选 worker id（软绑定，可空 null=自动调度，C1/C6） */
  workerId: string | null;
  /** 绑定的 ExecutionPolicy id（ep_<role>；null=未绑定） */
  policyId: string | null;
  /** 技能 id 数组（关联 skills 表） */
  skillIds: string[];
  /** 生效权限（唯一事实来源；null=未绑定执行策略） */
  effectivePermission: EffectivePermission | null;
  /** Agent 性格 key（steady/strict/aggressive/conservative/innovative；null=未配置） */
  persona: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /agents 分页响应。 */
interface AgentsResponse {
  items: AgentItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** PATCH /agents/:id 请求体（仅提交可编辑字段，不传则后端保持原值）。 */
interface UpdateAgentPayload {
  prompt?: string;
  defaultModelId?: string;
  /** 首选 worker id（软绑定；显式 null=自动调度） */
  workerId?: string | null;
  /** Agent 性格（显式 null 清除） */
  persona?: string | null;
}

/** GET /tools 条目（对齐 ToolsService.findAll 返回；mcpServer 可空：builtin/custom 为 null）。 */
interface ApiTool {
  id: string;
  name: string;
  action: string;
  source: "builtin" | "custom" | "mcp";
  /** 所属 MCP server（name/id 双键其一；非 MCP 工具为 null） */
  mcpServer: string | null;
  enabled: boolean;
}

/** GET /mcp-servers 条目（对齐 McpServersService.findAll 返回；status 为心跳合并状态）。 */
interface ApiMcpServer {
  id: string;
  name: string;
  type: string;
  url: string | null;
  enabled: boolean;
  status: string | null;
}

/** 后端分页响应（skills/tools/agents 同构）。 */
interface PageResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /models 目录条目（C3 目录行；id=md_xxx，modelRef=providerID/modelID）。 */
interface CatalogRow {
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  enabled: boolean;
  providerType?: string | null;
  baseUrl?: string | null;
}

/** GET /workers 条目（toWorkerView 子集：首选 worker 选择 + 在线态）。 */
interface ApiWorkerRow {
  id: string;
  name: string | null;
  status: string;
}

/** GET /models/:id/credentials（脱敏视图，绝无明文 token）。 */
interface CredentialView {
  configured: boolean;
  fingerprint: string | null;
}

/** 模型 id（providerID/modelID）→ providerID（首个 '/' 前；无 '/' 原样返回）。 */
function providerOf(modelRef: string): string {
  const slash = modelRef.indexOf("/");
  return slash > 0 ? modelRef.slice(0, slash) : modelRef;
}

/** 性格 key → 中文名 + 预览文案（对齐 server persona.constants.ts PERSONA_LIBRARY）。 */
const PERSONA_OPTIONS = [
  { key: null, label: "未配置", preview: "" },
  { key: "steady", label: "沉稳", preview: "先复核信息再下结论，不确定时明确标注置信度，不贸然承诺超出把握的事项。" },
  { key: "strict", label: "苛刻", preview: "以高标准验收，主动挑出真实问题（只拦实质问题，不纠缠表达风格）；每条批评须附改进建议。" },
  { key: "aggressive", label: "激进", preview: "以快速推进为先，先跑通主路径再逐步优化；关键步骤仍保留验证，不跳过验收环节。" },
  { key: "conservative", label: "保守", preview: "稳扎稳打，优先复用既有模式与已验证方案；做出变更前先说明影响与风险。" },
  { key: "innovative", label: "创新", preview: "乐于探索新路径，主动提出替代方案；提出新方案时必须说明其权衡（收益/成本/风险）。" },
] as const;

/* ------------------------------ 页面内扩展 token（仿原型 :156-170，不写 tokens.ts） ------------------------------ */

/** 工具三态（与 opencode PermissionV2 对齐：allow/ask/deny；tools 矩阵唯一值域）。 */
type ToolEffect = "allow" | "ask" | "deny";

/** 三态分段控制元信息（复刻 ce3edd1^ toolEffectMeta 配色；标签按任务要求为 允许/询问/拒绝）。 */
const toolEffectMeta: Record<
  ToolEffect,
  { label: string; desc: string; color: string; bg: string; border: string }
> = {
  allow: { label: "允许", desc: "无需确认 · 只读/低风险", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  ask: { label: "询问", desc: "每次调用需确认 · 有副作用", color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)" },
  deny: { label: "拒绝", desc: "白名单排除", color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
};

/** 未知 effect 值归一化为 deny（effectOf 唯一出口之外不另设解析）。 */
function normalizeToolEffect(value: unknown): ToolEffect {
  return value === "allow" || value === "ask" || value === "deny" ? value : "deny";
}

/** agentKey 即时校验：返回错误文案，null=合法。 */
function validateAgentKey(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "标识不能为空";
  if (v.startsWith("vteam-")) return "标识不能以 vteam- 开头";
  if (v.length > 63) return "标识最多 63 个字符";
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(v)) return "小写字母开头，仅含小写字母/数字/_/-，最多63字符";
  return null;
}

/** 后端错误归一化：AGENT_KEY_* 映射中文，其余透传（validator 数组已由 api 层拼接）。 */
function formatAgentKeyError(err: unknown): string {
  if (isApiError(err)) {
    if (err.code === "AGENT_KEY_CONFLICT") return "该标识已被占用";
    if (err.code === "AGENT_KEY_INVALID") {
      return err.message && err.message !== "请求失败" ? `标识格式不正确：${err.message}` : "标识格式不正确：小写字母开头，仅含小写字母/数字/_/-，最多63字符，且不能以 vteam- 开头";
    }
    return err.message;
  }
  return "请求失败，请稍后重试";
}

/** 生效权限 effect 三态（与 opencode PermissionV2 对齐：allow/ask/deny）。 */
type PermissionEffectKey = "allow" | "ask" | "deny";

/** effect 语义与配色（只读徽章；allow 绿 / ask 琥珀 / deny 红）。 */
const effectBadgeMeta: Record<
  PermissionEffectKey,
  { label: string; color: string; bg: string; border: string }
> = {
  allow: { label: "允许", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  ask: { label: "确认", color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)" },
  deny: { label: "禁止", color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
};

/** 未知 effect 值兜底徽章（中性灰，原值直显）。 */
const unknownEffectMeta = { label: "", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" };

/** 只读 effect 徽章（allow/ask/deny 三态色；未知值灰底直显）。 */
function EffectBadge({ value }: { value: unknown }) {
  const meta = typeof value === "string" && value in effectBadgeMeta
    ? effectBadgeMeta[value as PermissionEffectKey]
    : unknownEffectMeta;
  const label = typeof value === "string" && value in effectBadgeMeta
    ? (effectBadgeMeta[value as PermissionEffectKey].label)
    : String(value);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `1px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: meta.bg,
        border: `1px solid ${meta.border}`,
        color: meta.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
        fontFamily: fontFamily.body,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: meta.color,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}

/** 三态分段控制（复刻 ce3edd1^ tool-effect-select 视觉；模板只读时 data-readonly，点击无操作）。 */
function ToolEffectSelect({ toolName, value, readOnly, pending, onChange }: { toolName: string; value: ToolEffect; readOnly: boolean; pending: boolean; onChange: (next: ToolEffect) => void }) {
  return (
    <div
      data-testid="tool-effect-select"
      data-tool={toolName}
      data-readonly={readOnly ? "true" : "false"}
      role="radiogroup"
      aria-label={`${toolName} 权限`}
      title={readOnly ? "模板只读" : undefined}
      style={{
        flexShrink: 0,
        display: "inline-flex",
        gap: 2,
        padding: 3,
        borderRadius: radius.pill,
        backgroundColor: neutral[50],
        border: `1px solid ${neutral[200]}`,
        opacity: pending ? 0.6 : 1,
      }}
    >
      {(Object.keys(toolEffectMeta) as ToolEffect[]).map((key) => {
        const meta = toolEffectMeta[key];
        const active = value === key;
        return (
          <span
            key={key}
            data-effect={key}
            aria-checked={active}
            role="radio"
            aria-disabled={readOnly || pending}
            onClick={readOnly || pending ? undefined : () => onChange(key)}
            style={{
              padding: `2px ${space.sm}px`,
              borderRadius: radius.pill,
              fontSize: fontSize.xs,
              fontWeight: 500,
              cursor: readOnly || pending ? "default" : "pointer",
              fontFamily: fontFamily.mono,
              color: active ? "#FFFFFF" : neutral[500],
              backgroundColor: active ? meta.color : "transparent",
            }}
          >
            {meta.label}
          </span>
        );
      })}
    </div>
  );
}

/** 凭据状态双态（与 models-manage 页内定义完全一致；"扩展 token"范式页面内定义）。 */
const credentialTheme = {
  configured: { label: "已配置", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  missing: { label: "未配置", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
} as const;

/** 凭据状态徽章：已配置=绿 / 未配置=灰（仿 StatusBadge 视觉）。 */
function CredentialBadge({ status }: { status: "configured" | "missing" }) {
  const theme = credentialTheme[status];
  return (
    <span
      data-testid="model-credential-status"
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
        fontFamily: fontFamily.body,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: theme.color,
          flexShrink: 0,
        }}
      />
      {theme.label}
    </span>
  );
}

/** 模型 id → 产品名（目录查询 modelNameById 提供；未知/存量 id 显示原始值）。 */

/** Agent 类型 → 徽章文案（模板只读 / 自定义 / 克隆副本）。 */
const TYPE_LABEL: Record<string, string> = {
  template: "模板",
  custom: "自定义",
  clone: "克隆",
};

const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];

/** 真实 role → AgentAvatar 可用 RoleKey（未知/自定义 → developer 兜底，对齐原型 custom 头像）。 */
function toAvatarRole(role: string | null): RoleKey {
  return role && (ROLE_KEYS as readonly string[]).includes(role) ? (role as RoleKey) : "developer";
}

/** 模板/自定义 徽章主题：模板按角色色，自定义/克隆用灰蓝系（对齐原型 AgentListItem）。 */
const CUSTOM_THEME = { color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" };

/* ================================ Agent 列表项 ================================ */

interface AgentListItemProps {
  agent: AgentItem;
  active: boolean;
  /** 模型 id（providerID/modelID）→ 产品名（目录查询）；未知/存量 id 返回 undefined */
  modelNameOf: (id: string) => string | undefined;
  onClick: () => void;
}

function AgentListItem({ agent, active, modelNameOf, onClick }: AgentListItemProps) {
  const isTemplate = agent.type === "template";
  const roleKey = toAvatarRole(agent.role);

  return (
    <button
      type="button"
      data-testid="agent-list-item"
      data-agent-id={agent.id}
      data-active={active ? "true" : "false"}
      onClick={onClick}
      style={{
        width: "100%",
        textAlign: "left",
        cursor: "pointer",
        border: `1px solid ${active ? (isTemplate ? roleBorder(roleKey) : CUSTOM_THEME.border) : neutral[200]}`,
        borderRadius: radius.md,
        backgroundColor: active ? "var(--color-surface)" : neutral[50],
        boxShadow: active ? shadow.sm : "none",
        padding: space.md,
        display: "flex",
        alignItems: "center",
        gap: space.md,
        fontFamily: fontFamily.body,
      }}
    >
      <AgentAvatar role={roleKey} initials={agent.name.slice(0, 1)} size="md" dot={false} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            fontSize: fontSize.md,
            fontWeight: 600,
            color: neutral[800],
          }}
        >
          {agent.name}
          <span
            style={{
              fontSize: fontSize.xs,
              color: isTemplate ? roleColor(roleKey) : CUSTOM_THEME.color,
              backgroundColor: isTemplate ? roleBg(roleKey) : CUSTOM_THEME.bg,
              border: `1px solid ${isTemplate ? roleBorder(roleKey) : CUSTOM_THEME.border}`,
              padding: "1px 6px",
              borderRadius: radius.pill,
            }}
          >
            {TYPE_LABEL[agent.type] ?? agent.type}
          </span>
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
          {agent.prompt || "暂无角色描述"}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            marginTop: space.xs,
            fontSize: fontSize.xs,
          }}
        >
          <span style={{ color: neutral[400] }}>默认模型</span>
          <span
            style={{
              color: isTemplate ? roleColor(roleKey) : CUSTOM_THEME.color,
              backgroundColor: isTemplate ? roleBg(roleKey) : CUSTOM_THEME.bg,
              border: `1px solid ${isTemplate ? roleBorder(roleKey) : CUSTOM_THEME.border}`,
              padding: "1px 6px",
              borderRadius: radius.pill,
            }}
          >
            {agent.defaultModelId ? (modelNameOf(agent.defaultModelId) ?? agent.defaultModelId) : "未设置"}
          </span>
        </div>
      </div>
      {/* 启用状态开关示意（原型静态示意） */}
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 34,
          height: 19,
          borderRadius: radius.pill,
          backgroundColor: "#10B981",
          position: "relative",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            right: 2,
            width: 15,
            height: 15,
            borderRadius: "50%",
            backgroundColor: "var(--color-surface)",
          }}
        />
      </span>
    </button>
  );
}

/* 角色主题辅助（tokens.roles 具名取值，避免组件内散布 magic color） */
function roleColor(role: RoleKey): string {
  return ROLE_COLORS[role];
}
function roleBg(role: RoleKey): string {
  return ROLE_BGS[role];
}
function roleBorder(role: RoleKey): string {
  return ROLE_BORDERS[role];
}
const ROLE_COLORS: Record<RoleKey, string> = {
  product: "#0D9488", project_manager: "#0EA5E9", architect: "#8B5CF6", developer: "#10B981", tester: "#F59E0B",
};
const ROLE_BGS: Record<RoleKey, string> = {
  product: "rgba(13,148,136,0.10)", project_manager: "rgba(14,165,233,0.10)", architect: "rgba(124,58,237,0.10)", developer: "rgba(16,185,129,0.10)", tester: "rgba(245,158,11,0.10)",
};
const ROLE_BORDERS: Record<RoleKey, string> = {
  product: "rgba(13,148,136,0.22)", project_manager: "rgba(14,165,233,0.22)", architect: "rgba(124,58,237,0.22)", developer: "rgba(16,185,129,0.28)", tester: "rgba(245,158,11,0.28)",
};

/* ================================ 生效权限（只读，执行策略唯一事实来源） ================================ */

/** 原生 permission key → 中文标签（edit/read 为 glob map，其余为三态字符串）。 */
const NATIVE_PERMISSION_KEYS = [
  { key: "edit", label: "文件写入" },
  { key: "read", label: "文件读取" },
  { key: "bash", label: "终端命令" },
  { key: "task", label: "子任务" },
] as const;

/** 未收录工具分组 key（permission 中 vteam_* 键在工具目录无匹配时保留展示）。 */
const UNKNOWN_MCP_GROUP = "__unknown";

interface EffectivePermissionSectionProps {
  effective: EffectivePermission | null;
  agentId: string;
  agentType: string;
  /** GET /mcp-servers 全量（含停用；分组标题 + 默认收起依据）。 */
  mcpServers: ApiMcpServer[];
  /** GET /tools?source=mcp&includeDisabled=true（含停用；解析条目归属 server）。 */
  mcpTools: ApiTool[];
  /** MCP 目录加载中（原生行照常渲染，分组区占位）。 */
  loading: boolean;
}

function EffectivePermissionSection({ effective, agentId, agentType, mcpServers, mcpTools, loading }: EffectivePermissionSectionProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const queryClient = useQueryClient();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const editable = agentType === "custom" || agentType === "clone";
  const permission = useMemo(() => effective?.permission ?? {}, [effective]);
  const guardTools = useMemo(() => {
    const raw = effective?.tools;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  }, [effective]);

  /** 分组以 MCP server 目录为准：每个 server 列出其全部工具行，effect 取策略值，未列出→默认 deny。 */
  const groups = useMemo(() => {
    const byServerId = new Map<string, ApiTool[]>();
    const unknown: ApiTool[] = [];
    for (const t of mcpTools) {
      const server = t.mcpServer
        ? mcpServers.find((s) => s.id === t.mcpServer || s.name === t.mcpServer)
        : undefined;
      if (server) {
        const list = byServerId.get(server.id) ?? [];
        list.push(t);
        byServerId.set(server.id, list);
      } else {
        unknown.push(t);
      }
    }
    const ordered: { server: ApiMcpServer | null; tools: ApiTool[] }[] = [...mcpServers]
      .sort((a, b) => Number(b.enabled) - Number(a.enabled))
      .map((server) => ({ server, tools: byServerId.get(server.id) ?? [] }));
    if (unknown.length > 0) ordered.push({ server: null, tools: unknown });
    return ordered;
  }, [mcpTools, mcpServers]);

  /** 工具在当前角色策略下的 effect：层① permission key 存在即胜出，否则层② tools allowlist，否则默认 deny。 */
  const effectOf = (tool: ApiTool): unknown => {
    if (tool.name in permission) return permission[tool.name];
    if (tool.action in permission) return permission[tool.action];
    const prefixed = `vteam_${tool.action}`;
    if (prefixed in permission) return permission[prefixed];
    if (tool.name in guardTools) return guardTools[tool.name];
    if (tool.action in guardTools) return guardTools[tool.action];
    if (prefixed in guardTools) return guardTools[prefixed];
    return "deny";
  };

  /** tools 矩阵写入键：命中现有键则复用，避免分叉；否则用真实暴露名（tool.name）。 */
  const matrixKeyOf = (tool: ApiTool): string => {
    if (tool.name in guardTools) return tool.name;
    if (tool.action in guardTools) return tool.action;
    const prefixed = `vteam_${tool.action}`;
    if (prefixed in guardTools) return prefixed;
    return tool.name;
  };

  /** 单工具切换：全量回写 { permission, correction, tools }（config 非部分合并）。 */
  const policyMutation = useMutation({
    mutationFn: ({ key, next }: { key: string; next: ToolEffect }) => {
      if (!effective) throw new Error("未绑定执行策略");
      const nextTools: Record<string, unknown> = { ...guardTools, [key]: next };
      return api.patch(`/execution-policies/${effective.policyId}`, {
        config: { permission: effective.permission, correction: effective.correction, tools: nextTools },
      });
    },
    onSuccess: () => {
      setPolicyError(null);
      setPendingKey(null);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
    },
    onError: (err) => {
      setPendingKey(null);
      setPolicyError(isApiError(err) ? err.message : "保存权限失败，请稍后重试");
    },
  });

  const handleToolChange = (tool: ApiTool, next: ToolEffect) => {
    if (!editable || !effective || pendingKey) return;
    const current = normalizeToolEffect(effectOf(tool));
    if (current === next) return;
    setPolicyError(null);
    setPendingKey(matrixKeyOf(tool));
    policyMutation.mutate({ key: matrixKeyOf(tool), next });
  };

  /** MCP 分组区块：停用 server 默认收起，启用默认展开；目录未就绪时占位。 */
  const renderMcpGroups = () => {
    if (loading) {
      return (
        <div
          data-testid="effective-mcp-loading"
          style={{ fontSize: fontSize.sm, color: neutral[400], padding: `${space.sm}px 0` }}
        >
          MCP 工具加载中…
        </div>
      );
    }
    if (groups.length === 0) {
      return (
        <div
          data-testid="effective-mcp-empty"
          style={{ fontSize: fontSize.sm, color: neutral[400], padding: `${space.sm}px 0` }}
        >
          暂无 MCP 工具条目
        </div>
      );
    }
    return groups.map(({ server, tools }) => {
      const groupKey = server?.id ?? UNKNOWN_MCP_GROUP;
      const isCollapsed = collapsed[groupKey] ?? (server ? !server.enabled : false);
      const title = server?.name ?? "未收录工具";
      return (
        <div
          key={groupKey}
          data-testid="effective-mcp-group"
          data-server={server?.name ?? UNKNOWN_MCP_GROUP}
          style={{
            borderRadius: radius.md,
            backgroundColor: "var(--color-surface)",
            border: `1px solid ${neutral[200]}`,
            overflow: "hidden",
          }}
        >
          <button
            type="button"
            data-testid="effective-mcp-group-toggle"
            aria-expanded={!isCollapsed}
            onClick={() => setCollapsed((prev) => ({ ...prev, [groupKey]: !isCollapsed }))}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              padding: `${space.sm}px ${space.md}px`,
              border: "none",
              backgroundColor: "transparent",
              cursor: "pointer",
              fontFamily: fontFamily.body,
              fontSize: fontSize.sm,
              textAlign: "left",
            }}
          >
            <span aria-hidden style={{ color: neutral[400], fontSize: fontSize.xs }}>
              {isCollapsed ? "▸" : "▾"}
            </span>
            <span style={{ fontFamily: fontFamily.mono, fontWeight: 600, color: neutral[800] }}>
              {title}
            </span>
            <span
              style={{
                fontSize: fontSize.xs,
                color: server && !server.enabled ? neutral[500] : "#0D9488",
                backgroundColor: server && !server.enabled ? neutral[100] : "rgba(13,148,136,0.10)",
                border: `1px solid ${server && !server.enabled ? neutral[200] : "rgba(13,148,136,0.22)"}`,
                padding: "1px 6px",
                borderRadius: radius.pill,
              }}
            >
              {server ? (server.enabled ? "启用" : "停用") : "未知来源"}
            </span>
            <span style={{ marginLeft: "auto", fontSize: fontSize.xs, color: neutral[400], flexShrink: 0 }}>
              {tools.length} 个工具
            </span>
          </button>
          {!isCollapsed && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: space.xs,
                padding: `0 ${space.md}px ${space.md}px`,
              }}
            >
              {tools.length === 0 ? (
                <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  该服务下暂无工具
                </div>
              ) : (
                tools.map((tool) => {
                  const effect = normalizeToolEffect(effectOf(tool));
                  const meta = toolEffectMeta[effect];
                  const key = matrixKeyOf(tool);
                  return (
                    <div
                      key={tool.id}
                      data-testid="effective-mcp-tool"
                      data-tool={tool.name}
                      data-enabled={String(tool.enabled)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: space.sm,
                        fontSize: fontSize.sm,
                      }}
                    >
                      <span
                        style={{
                          minWidth: 0,
                          flex: 1,
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: fontFamily.mono,
                            color: neutral[700],
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {tool.name}
                        </span>
                        <span style={{ fontSize: fontSize.xs }}>
                          <span style={{ color: meta.color, fontWeight: 500 }}>{meta.label}</span>
                          <span style={{ color: neutral[400] }}> · {meta.desc}</span>
                        </span>
                      </span>
                      <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
                        {!tool.enabled && (
                          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>已停用</span>
                        )}
                        <ToolEffectSelect
                          toolName={tool.name}
                          value={effect}
                          readOnly={!editable}
                          pending={pendingKey === key}
                          onChange={(next) => handleToolChange(tool, next)}
                        />
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      );
    });
  };

  if (!effective) {
    return (
      <div
        data-testid="effective-permission-section"
        style={{ display: "flex", flexDirection: "column", gap: space.sm }}
      >
        <div
          data-testid="effective-permission-empty"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: space.md,
            borderRadius: radius.md,
            border: `1px dashed ${neutral[300]}`,
            backgroundColor: neutral[50],
            fontSize: fontSize.sm,
            color: neutral[400],
          }}
        >
          未绑定执行策略
        </div>
        {renderMcpGroups()}
      </div>
    );
  }

  const scopeSummary = effective.correction?.scopeSummary;
  const nativeRows = NATIVE_PERMISSION_KEYS.filter(({ key }) => key in permission);

  return (
    <div
      data-testid="effective-permission-section"
      style={{ display: "flex", flexDirection: "column", gap: space.sm }}
    >
      {/* 策略元信息：策略名 · 执行体 + 生效范围 */}
      <div
        data-testid="effective-policy-meta"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          flexWrap: "wrap",
          fontSize: fontSize.sm,
        }}
      >
        <span style={{ fontFamily: fontFamily.mono, fontWeight: 600, color: neutral[800] }}>
          {effective.policyName}
        </span>
        <span aria-hidden style={{ color: neutral[300] }}>·</span>
        <span style={{ fontFamily: fontFamily.mono, color: neutral[500] }}>
          {effective.agentName}
        </span>
        {typeof scopeSummary === "string" && scopeSummary && (
          <span data-testid="effective-permission-scope" style={{ color: neutral[400], fontSize: fontSize.xs }}>
            {scopeSummary}
          </span>
        )}
      </div>

      {/* 原生权限行：glob map 可读渲染，其余三态徽章 */}
      {nativeRows.map(({ key, label }) => {
        const value = permission[key];
        return (
          <div
            key={key}
            data-testid="effective-permission-row"
            data-key={key}
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: space.md,
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              fontSize: fontSize.sm,
            }}
          >
            <span style={{ color: neutral[500], flexShrink: 0 }}>
              <span style={{ fontFamily: fontFamily.mono, fontWeight: 600, color: neutral[700] }}>{key}</span>
              <span style={{ color: neutral[300] }}> · </span>
              {label}
            </span>
            <span style={{ textAlign: "right", minWidth: 0 }}>
              {typeof value === "object" && value !== null && !Array.isArray(value) ? (
                <span style={{ lineHeight: 1.8 }}>
                  {Object.entries(value).map(([glob, eff], i) => (
                    <span key={glob}>
                      {i > 0 && <span style={{ color: neutral[300] }}>；</span>}
                      <span style={{ fontFamily: fontFamily.mono, color: neutral[700] }}>{glob}</span>
                      {" "}
                      <EffectBadge value={eff} />
                    </span>
                  ))}
                </span>
              ) : (
                <EffectBadge value={value} />
              )}
            </span>
          </div>
        );
      })}

      {/* MCP 工具分组（server 目录驱动）：停用 server 默认收起，启用默认展开 */}
      {renderMcpGroups()}
      {policyError && (
        <div
          data-testid="policy-save-error"
          role="alert"
          style={{
            fontSize: fontSize.sm,
            color: "#DC2626",
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: "rgba(239,68,68,0.10)",
            border: "1px solid rgba(239,68,68,0.22)",
          }}
        >
          <span aria-hidden style={{ fontWeight: 700 }}>!</span>
          {policyError}
        </div>
      )}
    </div>
  );
}

/* ================================ 配置面板 ================================ */

interface ConfigPanelProps {
  agent: AgentItem;
  /** 是否只读（type=template） */
  readOnly: boolean;
  /** 可用模型列表（available-models，目录读取） */
  models: AvailableModel[];
  /** MCP server 全量（GET /mcp-servers，权限分组标题 + 收起依据） */
  mcpServers: ApiMcpServer[];
  /** MCP 工具目录（GET /tools?source=mcp&includeDisabled=true，解析条目归属 server） */
  mcpTools: ApiTool[];
  /** MCP 目录加载中（分组区占位） */
  mcpLoading: boolean;
  /** 模型目录（GET /models）：名称查询 + 存量校验 + 凭据端点 md id 解析 */
  catalogByRef: Map<string, CatalogRow>;
  /** 可用 worker 列表（GET /workers，首选 worker 选择数据源） */
  workers: ApiWorkerRow[];
  saving: boolean;
  saveError: string | null;
  onSave: (payload: UpdateAgentPayload) => void;
  /** 保存模型凭据（POST /models/:mdId/credentials，页面级 mutation 统一 invalidate） */
  onSaveToken: (payload: { modelId: string; token: string }) => void;
  onClone: () => void;
  /** 是否具备 agents.create（克隆入口权限，对齐后端 PermissionGuard，REG-01） */
  canCreate: boolean;
  /** 是否可删除（type≠template 且具备 agents.delete，UX-14；template 后端 403 兜底） */
  canDelete: boolean;
  /** 点击删除（打开二次确认弹窗，确认后才 DELETE） */
  onDelete: () => void;
  /** 删除进行中（ConfirmDialog submitting 状态） */
  deleting: boolean;
  /** 删除失败提示（DELETE 非 2xx 时展示） */
  deleteError: string | null;
}

function ConfigPanel({ agent, readOnly, models, mcpServers, mcpTools, mcpLoading, catalogByRef, workers, saving, saveError, onSave, onSaveToken, onClone, canCreate, canDelete, onDelete, deleting, deleteError }: ConfigPanelProps) {
  // is_0000000030：readOnly 不再按 type 区分（template 也可编辑）；isTemplate 仅用于主题色
  const isTemplate = agent.type === "template";
  const accent = isTemplate
    ? ROLE_COLORS[toAvatarRole(agent.role)]
    : CUSTOM_THEME.color;

  // 草稿：挂载时从 agent 初始化（父级 key=agent.id 保证切换重挂载）
  const [promptDraft, setPromptDraft] = useState(agent.prompt ?? "");
  const [personaDraft, setPersonaDraft] = useState<string | null>(agent.persona ?? null);
  const [modelDraft, setModelDraft] = useState<string | null>(agent.defaultModelId ?? null);
  const [workerDraft, setWorkerDraft] = useState<string>(agent.workerId ?? "");

  // token 输入（POST /models/:mdId/credentials，type=password）
  const [tokenInput, setTokenInput] = useState("");

  // 凭据状态经目录行解析：modelDraft=providerID/modelID → catalogByRef 取 md id → GET 凭据端点；
  // 存量 defaultModelId 不在目录（catalog 无行）→ 无端点可查，视同未配置
  const selectedCatalog = modelDraft ? catalogByRef.get(modelDraft) : undefined;
  const tokenQuery = useQuery({
    queryKey: ["model-credential", selectedCatalog?.id],
    queryFn: () => api.get<CredentialView>(`/models/${selectedCatalog!.id}/credentials`),
    enabled: !!selectedCatalog,
  });
  const tokenConfigured = tokenQuery.data?.configured ?? false;
  const tokenFingerprint = tokenQuery.data?.fingerprint ?? null;

  const handleSave = () => {
    // is_0000000030：内置（template）agent 设置也可修改（后端已放开，agentId/type 不可改）；
    // 提交可编辑设置字段（prompt/模型/worker/性格）；权限由服务端执行策略拥有，前端只读
    const payload: UpdateAgentPayload = {
      prompt: promptDraft.trim(),
      defaultModelId: modelDraft ?? undefined,
      // 软绑定首选 worker：显式提交（空=自动调度，null 清除绑定）
      workerId: workerDraft || null,
      persona: personaDraft,
    };
    onSave(payload);
  };

  const currentModel = models.find((m) => m.id === modelDraft);
  const currentModelName =
    currentModel?.name ??
    (modelDraft ? (catalogByRef.get(modelDraft)?.name ?? modelDraft) : null);

  // 存量兼容校验：defaultModelId 非空但不在目录（停用/遗留）→ 警告保留不阻断保存
  const staleModel = !!modelDraft && !catalogByRef.has(modelDraft);

  // 在线 worker 优先排序（首选 worker 选择器选项顺序）
  const sortedWorkers = [...workers].sort((a, b) => {
    if (a.status !== "offline" && b.status === "offline") return -1;
    if (a.status === "offline" && b.status !== "offline") return 1;
    return (a.name ?? a.id).localeCompare(b.name ?? b.id);
  });

  return (
    <section
      data-testid="agent-config-panel"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        backgroundColor: "var(--color-surface)",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.lg,
        boxShadow: shadow.sm,
        padding: `${space.xl}px`,
        ...baseFont,
      }}
    >
      {/* 面板头部：Agent 名 + 类型徽章 + 克隆入口 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.md,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.md, minWidth: 0 }}>
          <AgentAvatar
            role={toAvatarRole(agent.role)}
            initials={agent.name.slice(0, 1)}
            size="lg"
          />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                fontSize: fontSize.xl,
                fontWeight: 600,
                color: neutral[900],
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {agent.name}
              </span>
              <span
                style={{
                  fontSize: fontSize.xs,
                  fontWeight: 500,
                  color: isTemplate ? roleColor(toAvatarRole(agent.role)) : CUSTOM_THEME.color,
                  backgroundColor: isTemplate ? roleBg(toAvatarRole(agent.role)) : CUSTOM_THEME.bg,
                  border: `1px solid ${isTemplate ? roleBorder(toAvatarRole(agent.role)) : CUSTOM_THEME.border}`,
                  padding: "1px 7px",
                  borderRadius: radius.pill,
                  flexShrink: 0,
                }}
              >
                {TYPE_LABEL[agent.type] ?? agent.type}
              </span>
              {isTemplate && (
                <span
                  data-testid="agent-readonly-badge"
                  style={{
                    fontSize: fontSize.xs,
                    fontWeight: 500,
                    color: neutral[400],
                    padding: "1px 7px",
                    borderRadius: radius.pill,
                    border: `1px solid ${neutral[200]}`,
                    flexShrink: 0,
                  }}
                >
                  只读
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: fontSize.sm,
                color: neutral[400],
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {agent.prompt || "暂无角色描述"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexShrink: 0 }}>
          {/* 删除入口（UX-14）：template 后端 403 只读 → 隐藏；custom/clone 且具备 agents.delete 才显示 */}
          {canDelete && !isTemplate && (
            <button
              type="button"
              data-testid="delete-agent-button"
              data-agent-id={agent.id}
              onClick={onDelete}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space.xs,
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.pill,
                border: "1px solid rgba(239,68,68,0.22)",
                backgroundColor: "var(--color-surface)",
                color: "#DC2626",
                fontSize: fontSize.md,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              删除
            </button>
          )}
          {canCreate && (
            <button
              type="button"
              data-testid="clone-template-button"
              data-agent-id={agent.id}
              onClick={onClone}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space.xs,
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.pill,
                border: `1px solid ${accent}`,
                backgroundColor: "var(--color-surface)",
                color: accent,
                fontSize: fontSize.md,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              ⧉ 克隆此 Agent
            </button>
          )}
          <button
            type="button"
            data-testid="save-agent-button"
            onClick={handleSave}
            disabled={saving}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: "none",
              backgroundColor: accent,
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: saving ? "default" : "pointer",
              opacity: saving ? 0.6 : 1,
              fontFamily: fontFamily.body,
            }}
          >
            {saving ? "保存中…" : "保存配置"}
          </button>
        </div>
      </div>

      {/* 保存错误提示 */}
      {saveError && (
        <div
          data-testid="agent-save-error"
          role="alert"
          style={{
            fontSize: fontSize.sm,
            color: "#DC2626",
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: "rgba(239,68,68,0.10)",
            border: `1px solid rgba(239,68,68,0.22)`,
          }}
        >
          <span aria-hidden style={{ fontWeight: 700 }}>!</span>
          {saveError}
        </div>
      )}

      {/* 删除失败提示（UX-14：DELETE 非 2xx 时展示） */}
      {deleteError && (
        <div
          data-testid="agent-delete-error"
          role="alert"
          style={{
            fontSize: fontSize.sm,
            color: "#DC2626",
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: "rgba(239,68,68,0.10)",
            border: `1px solid rgba(239,68,68,0.22)`,
          }}
        >
          <span aria-hidden style={{ fontWeight: 700 }}>!</span>
          {deleteError}
        </div>
      )}

      {/* ① 提示词编辑器（FR-33） */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            提示词配置
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            提示词 · 即时生效于后续会话
          </span>
        </div>
        <textarea
          data-testid="prompt-editor"
          readOnly={isTemplate}
          rows={4}
          spellCheck={false}
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)}
          placeholder="描述该 Agent 的角色定位与产出要求…"
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "none",
            border: `1px solid ${neutral[200]}`,
            borderRadius: radius.md,
            backgroundColor: isTemplate ? neutral[50] : "var(--color-surface)",
            padding: space.md,
            fontSize: fontSize.md,
            lineHeight: 1.6,
            color: neutral[700],
            fontFamily: fontFamily.mono,

          }}
        />
      </div>

      {/* ①c 性格配置（tc-persona：第五维性格，与角色提示词正交） */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            性格配置
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            影响 Agent 表达与协作风格
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
          <select
            data-testid="persona-select"
            value={personaDraft ?? ""}
            onChange={(e) => setPersonaDraft(e.target.value || null)}
            style={{
              fontFamily: fontFamily.body,
              fontSize: fontSize.sm,
              color: neutral[800],
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[300]}`,
              borderRadius: radius.md,
              padding: `${space.xs}px ${space.sm}px`,
              cursor: "pointer",
              width: 200,
              flexShrink: 0,
            }}
          >
            {PERSONA_OPTIONS.map((opt) => (
              <option key={opt.key ?? ""} value={opt.key ?? ""}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        {personaDraft && (
          <div
            style={{
              fontSize: fontSize.xs,
              color: neutral[500],
              lineHeight: 1.6,
              padding: `${space.sm}px ${space.md}px`,
              backgroundColor: neutral[50],
              borderRadius: radius.sm,
              border: `1px solid ${neutral[100]}`,
            }}
          >
            {PERSONA_OPTIONS.find((o) => o.key === personaDraft)?.preview}
          </div>
        )}
      </div>

      {/* ② 默认模型配置（FR-47） */}
      <div
        data-testid="model-config"
        style={{ display: "flex", flexDirection: "column", gap: space.sm }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            模型与工具配置
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            默认模型 · 凭据 · 首选 Worker
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.md,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              fontSize: fontSize.sm,
              minWidth: 0,
            }}
          >
            <span aria-hidden style={{ color: accent, fontSize: fontSize.lg, lineHeight: 1 }}>
              ◉
            </span>
            <span style={{ color: neutral[500] }}>当前</span>
            <span style={{ color: neutral[800], fontWeight: 500 }}>
              {currentModelName ?? "未设置"}
            </span>
            {currentModel && (
              <span style={{ color: neutral[400] }}>· {currentModel.id}</span>
            )}
          </div>
          <select
            data-testid="model-select"
            value={modelDraft ?? ""}
            disabled={false}
            onChange={(e) => setModelDraft(e.target.value || null)}
            style={{
              fontFamily: fontFamily.body,
              fontSize: fontSize.sm,
              color: neutral[800],
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[300]}`,
              borderRadius: radius.md,
              padding: `${space.xs}px ${space.sm}px`,
              cursor: "pointer",
              width: 240,
              flexShrink: 0,
            }}
          >
            <option value="">未设置</option>
            {models.map((model) => (
              <option
                key={model.id}
                value={model.id}
                data-testid="model-option-provider"
                data-model-id={model.id}
              >
                {providerOf(model.id)} / {model.name}
              </option>
            ))}
          </select>
        </div>

        {/* 模型凭据：已配置=绿徽章+fingerprint / 未配置=token 输入（P0.2 原型双态） */}
        <div
          data-testid="model-token-status"
          data-credential={tokenConfigured ? "configured" : "missing"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.md,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
          }}
        >
          <CredentialBadge status={tokenConfigured ? "configured" : "missing"} />
          {tokenConfigured ? (
            <span
              style={{
                fontFamily: fontFamily.mono,
                fontSize: fontSize.sm,
                color: neutral[600],
                letterSpacing: "0.02em",
              }}
            >
              {tokenFingerprint}
            </span>
          ) : (
            <>
              <input
                data-testid="model-token-input"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={
                  selectedCatalog
                    ? `输入 ${selectedCatalog.providerID} 的 API token（sk-…）`
                    : "输入 API token（sk-…）"
                }
                aria-label="模型 API Token"
                style={{
                  flex: 1,
                  minWidth: 0,
                  maxWidth: 320,
                  padding: `${space.xs}px ${space.sm}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[300]}`,
                  backgroundColor: "var(--color-surface)",
                  fontSize: fontSize.sm,
                  color: neutral[800],
                  fontFamily: fontFamily.mono,

                }}
              />
                <button
                  type="button"
                  disabled={
                    !selectedCatalog ||
                    ((selectedCatalog.providerType !== 'local' &&
                      selectedCatalog.providerType !== 'custom') &&
                      !tokenInput.trim())
                  }
                  onClick={() =>
                    selectedCatalog &&
                    onSaveToken({ modelId: selectedCatalog.id, token: tokenInput.trim() })
                  }
                  style={{
                    padding: `${space.xs + 1}px ${space.md}px`,
                    borderRadius: radius.pill,
                    border: "none",
                    backgroundColor: "#0D9488",
                    color: "#FFFFFF",
                    fontSize: fontSize.xs,
                    fontWeight: 500,
                    cursor:
                      !selectedCatalog ||
                      ((selectedCatalog.providerType !== 'local' &&
                        selectedCatalog.providerType !== 'custom') &&
                        !tokenInput.trim())
                        ? "default"
                        : "pointer",
                    opacity:
                      !selectedCatalog ||
                      ((selectedCatalog.providerType !== 'local' &&
                        selectedCatalog.providerType !== 'custom') &&
                        !tokenInput.trim())
                        ? 0.6
                        : 1,
                    fontFamily: fontFamily.body,
                  }}
                >
                  保存凭据
                </button>
            </>
          )}
          <span style={{ marginLeft: "auto", fontSize: fontSize.xs, color: neutral[400] }}>
            {tokenConfigured
              ? "凭据已配置 · 按服务商粒度生效"
              : "保存后即时下发到 Worker"}
          </span>
        </div>

        {/* 首选 Worker：软绑定（C1 字段，可空 null=自动调度，离线自动回退） */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.md,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
          }}
        >
          <span style={{ fontSize: fontSize.sm, color: neutral[600], flexShrink: 0 }}>
            首选 Worker
          </span>
          <select
            data-testid="agent-worker-select"
            value={workerDraft}
            disabled={readOnly}
            onChange={(e) => setWorkerDraft(e.target.value)}
            aria-label="首选 Worker（未选则自动调度）"
            style={{
              fontFamily: fontFamily.body,
              fontSize: fontSize.sm,
              color: neutral[800],
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[300]}`,
              borderRadius: radius.md,
              padding: `${space.xs}px ${space.sm}px`,
              cursor: "pointer",
              minWidth: 220,
            }}
          >
            <option value="">自动调度（默认）</option>
            {sortedWorkers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name ?? w.id} · {w.status !== "offline" ? "在线" : "离线"}
              </option>
            ))}
          </select>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            未选则自动调度到任意可用 worker（软绑定）
          </span>
        </div>

        {/* 存量兼容警告：defaultModelId 不在目录（停用/遗留）→ 保留展示不阻断保存 */}
        {staleModel && (
          <div
            data-testid="model-stale-warning"
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.xs,
              fontSize: fontSize.xs,
              color: "#D97706",
              backgroundColor: "rgba(245,158,11,0.10)",
              border: `1px solid rgba(245,158,11,0.28)`,
              borderRadius: radius.md,
              padding: `${space.sm}px ${space.md}px`,
            }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            当前默认模型不在模型目录中（可能已停用/遗留），保存后仍会保留该值，但新会话解析可能降级
          </div>
        )}

        <div
          data-testid="model-source-hint"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            fontSize: fontSize.xs,
            color: neutral[400],
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.xs }}>
            ↗
          </span>
          模型列表来自平台模型目录（Worker 上报合并入库）
        </div>
      </div>

      {/* ④ 权限（执行策略生效权限：原生行只读 + MCP 按 server 分组三态可配；模板只读） */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            权限
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            {agent.type === "custom" || agent.type === "clone" ? "执行策略 · 可编辑" : "执行策略 · 只读"}
          </span>
        </div>
        <EffectivePermissionSection
          effective={agent.effectivePermission ?? null}
          agentId={agent.id}
          agentType={agent.type}
          mcpServers={mcpServers}
          mcpTools={mcpTools}
          loading={mcpLoading}
        />
      </div>
    </section>
  );
}

/* ================================ 新建自定义 Agent 弹窗 ================================ */

interface CreateAgentModalProps {
  open: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: { name: string; prompt?: string; persona?: string | null; agentKey: string }) => void;
}

function CreateAgentModal({ open, submitting, error, onClose, onSubmit }: CreateAgentModalProps) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [persona, setPersona] = useState<string | null>(null);
  const [agentKey, setAgentKey] = useState("");
  const [touchedKey, setTouchedKey] = useState(false);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // 每次打开重置表单
  useEffect(() => {
    if (open) {
      setName("");
      setPrompt("");
      setPersona(null);
      setAgentKey("");
      setTouchedKey(false);
    }
  }, [open]);

  if (!open) return null;

  const keyError = validateAgentKey(agentKey);
  const showKeyError = touchedKey && keyError !== null;
  const canSubmit = name.trim() !== "" && keyError === null && !submitting;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouchedKey(true);
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      prompt: prompt.trim() ? prompt.trim() : undefined,
      persona: persona,
      agentKey: agentKey.trim(),
    });
  };

  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "var(--color-surface)",
    fontSize: fontSize.md,
    color: neutral[800],

    fontFamily: fontFamily.body,
  };

  return (
    <div
      data-testid="create-agent-modal"
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
      {/* 遮罩：点击关闭 */}
      <div
        aria-hidden
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      {/* 弹窗卡片 */}
      <form
        onSubmit={handleSubmit}
        noValidate
        style={{
          position: "relative",
          width: 420,
          maxWidth: "calc(100% - 48px)",
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
        {/* 头部：标题 + 关闭 */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              新建自定义 Agent
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
              完全自定义，创建后可编辑提示词 / 模型
            </div>
          </div>
          <button
            type="button"
            data-testid="create-agent-close"
            aria-label="关闭新建 Agent 弹窗"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              flexShrink: 0,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              backgroundColor: "transparent",
              color: neutral[400],
              fontSize: fontSize.lg,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* 字段 */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <label htmlFor="agent-name" style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              Agent 名称 <span aria-hidden style={{ color: "#DC2626" }}>*</span>
            </label>
            <input
              id="agent-name"
              data-testid="agent-name-input"
              type="text"
              placeholder="请输入自定义角色名（如 发布管家）"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              style={inputBase}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <label htmlFor="agent-key" style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              标识 agentKey <span aria-hidden style={{ color: "#DC2626" }}>*</span>
            </label>
            <input
              id="agent-key"
              data-testid="agent-key-input"
              type="text"
              placeholder="小写字母开头，如 release-manager"
              autoComplete="off"
              spellCheck={false}
              value={agentKey}
              onChange={(e) => setAgentKey(e.target.value)}
              onBlur={() => setTouchedKey(true)}
              disabled={submitting}
              aria-invalid={showKeyError}
              style={{
                ...inputBase,
                borderColor: showKeyError ? "#DC2626" : neutral[200],
                fontFamily: fontFamily.mono,
              }}
            />
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
              执行体名为 vteam-{"<标识>"}；小写字母开头，仅含小写字母/数字/_/-，最多63字符，且不能以 vteam- 开头
            </span>
            {showKeyError && (
              <span data-testid="agent-key-error" role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626" }}>
                {keyError}
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <label htmlFor="agent-prompt" style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              角色提示词
            </label>
            <textarea
              id="agent-prompt"
              data-testid="agent-prompt-input"
              placeholder="描述该 Agent 的角色定位与产出要求（可选，创建后可在配置面板编辑）"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={submitting}
              style={{ ...inputBase, resize: "vertical", lineHeight: 1.6 }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <label htmlFor="agent-persona" style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              性格
            </label>
            <select
              id="agent-persona"
              data-testid="create-agent-persona"
              value={persona ?? ""}
              onChange={(e) => setPersona(e.target.value || null)}
              disabled={submitting}
              style={{ ...inputBase, cursor: "pointer" }}
            >
              {PERSONA_OPTIONS.map((opt) => (
                <option key={opt.key ?? ""} value={opt.key ?? ""}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div
            data-testid="create-agent-error"
            role="alert"
            style={{
              fontSize: fontSize.sm,
              color: "#DC2626",
              display: "flex",
              alignItems: "center",
              gap: space.xs,
            }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {error}
          </div>
        )}

        {/* 操作按钮 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button
            type="button"
            data-testid="create-agent-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
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
            取消
          </button>
          <button
            type="submit"
            data-testid="create-agent-confirm"
            disabled={!canSubmit}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: "#0D9488",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: !canSubmit ? "default" : "pointer",
              opacity: !canSubmit ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(13,148,136,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "创建中…" : "创建 Agent"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ================================ 克隆 Agent 弹窗 ================================ */

interface CloneAgentModalProps {
  source: AgentItem | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: { name?: string; agentKey: string }) => void;
}

function CloneAgentModal({ source, submitting, error, onClose, onSubmit }: CloneAgentModalProps) {
  const [name, setName] = useState("");
  const [agentKey, setAgentKey] = useState("");
  const [touchedKey, setTouchedKey] = useState(false);

  useEffect(() => {
    if (source) {
      setName(`${source.name} 副本`);
      const base = (source.agentKey ?? "").trim();
      const candidate = base ? `${base}-copy` : "";
      setAgentKey(validateAgentKey(candidate) === null ? candidate : "");
      setTouchedKey(false);
    }
  }, [source]);

  useEffect(() => {
    if (!source) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [source, onClose]);

  if (!source) return null;

  const keyError = validateAgentKey(agentKey);
  const showKeyError = touchedKey && keyError !== null;
  const canSubmit = keyError === null && !submitting;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouchedKey(true);
    if (!canSubmit) return;
    const trimmedName = name.trim();
    onSubmit({
      ...(trimmedName && trimmedName !== source.name ? { name: trimmedName } : {}),
      agentKey: agentKey.trim(),
    });
  };

  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "var(--color-surface)",
    fontSize: fontSize.md,
    color: neutral[800],
    fontFamily: fontFamily.body,
  };

  return (
    <div
      data-testid="clone-agent-modal"
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
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      <form
        onSubmit={handleSubmit}
        noValidate
        style={{
          position: "relative",
          width: 420,
          maxWidth: "calc(100% - 48px)",
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
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              克隆 Agent
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
              来源：{source.name}（{source.agentKey ?? "无标识"}）
            </div>
          </div>
          <button
            type="button"
            data-testid="clone-agent-close"
            aria-label="关闭克隆 Agent 弹窗"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              flexShrink: 0,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              backgroundColor: "transparent",
              color: neutral[400],
              fontSize: fontSize.lg,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <label htmlFor="clone-name" style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              Agent 名称
            </label>
            <input
              id="clone-name"
              data-testid="clone-name-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              style={inputBase}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <label htmlFor="clone-key" style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              标识 agentKey <span aria-hidden style={{ color: "#DC2626" }}>*</span>
            </label>
            <input
              id="clone-key"
              data-testid="agent-key-input"
              type="text"
              placeholder="如 release-manager-copy"
              autoComplete="off"
              spellCheck={false}
              value={agentKey}
              onChange={(e) => setAgentKey(e.target.value)}
              onBlur={() => setTouchedKey(true)}
              disabled={submitting}
              aria-invalid={showKeyError}
              style={{ ...inputBase, borderColor: showKeyError ? "#DC2626" : neutral[200], fontFamily: fontFamily.mono }}
            />
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
              执行体名为 vteam-{"<标识>"}；小写字母开头，仅含小写字母/数字/_/-，最多63字符，且不能以 vteam- 开头
            </span>
            {showKeyError && (
              <span data-testid="agent-key-error" role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626" }}>
                {keyError}
              </span>
            )}
          </div>
        </div>
        {error && (
          <div data-testid="clone-agent-error" role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626", display: "flex", alignItems: "center", gap: space.xs }}>
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button
            type="button"
            data-testid="clone-agent-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
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
            取消
          </button>
          <button
            type="submit"
            data-testid="clone-agent-confirm"
            disabled={!canSubmit}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: "#0D9488",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: !canSubmit ? "default" : "pointer",
              opacity: !canSubmit ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(13,148,136,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "克隆中…" : "克隆 Agent"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ================================ 页面主组件 ================================ */

export default function AgentConfigPage() {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;
  // 写操作权限（对齐后端 PermissionGuard agents.create，REG-01）：all:true / 矩阵 true 放行
  const canCreateAgent = hasPermission(user?.permissions, "agents", "create");
  // 删除权限（对齐后端 PermissionGuard agents.delete，UX-14）；template 由 ConfigPanel 二次过滤
  const canDeleteAgent = hasPermission(user?.permissions, "agents", "delete");
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneTarget, setCloneTarget] = useState<AgentItem | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 列表：GET /agents（type 过滤 + 分页 + 扩展字段）
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<AgentsResponse>("/agents", { query: { page: 1, pageSize: 100 } }),
    enabled: !!userId,
  });

  const agents = data?.items ?? [];

  // 默认选中第一个（列表加载完成后），保证面板有内容
  useEffect(() => {
    if (!selectedId && (data?.items?.length ?? 0) > 0 && data) {
      setSelectedId(data.items[0].id);
    }
  }, [data, selectedId]);

  // 选中详情：GET /agents/:id（保证选中态最新；列表条目已含扩展字段，可用作即时渲染）
  const detailQuery = useQuery({
    queryKey: ["agent", selectedId],
    queryFn: () => api.get<AgentItem>(`/agents/${selectedId}`),
    enabled: !!userId && !!selectedId,
  });

  // 可用模型：GET /agents/:id/available-models（FR-47）
  // 后端返回联合类型（Phase 4 T11）：正常=数组；无 worker/listModels 失败降级={models, source:'fallback'}
  const modelsQuery = useQuery({
    queryKey: ["agent-models", selectedId],
    queryFn: () => api.get<AvailableModel[] | { models: AvailableModel[]; source?: string }>(`/agents/${selectedId}/available-models`),
    enabled: !!userId && !!selectedId,
  });
  const models: AvailableModel[] = Array.isArray(modelsQuery.data)
    ? modelsQuery.data
    : (modelsQuery.data?.models ?? []);

  // 模型目录：GET /models（名称查询 + 存量兼容校验 + 凭据端点 md id 解析；C3 目录）
  const catalogQuery = useQuery({
    queryKey: ["model-catalog"],
    queryFn: () =>
      api.get<PageResponse<CatalogRow>>("/models", { query: { page: 1, pageSize: 100 } }),
    enabled: !!userId,
  });
  const catalogByRef = useMemo(() => {
    const map = new Map<string, CatalogRow>();
    for (const r of catalogQuery.data?.items ?? []) {
      map.set(`${r.providerID}/${r.modelID}`, r);
      // 存量 defaultModelId 可能是不含 '/' 的旧自由字符串 → 裸 modelID 也纳入兼容校验
      map.set(r.modelID, r);
    }
    return map;
  }, [catalogQuery.data]);
  const modelNameOf = useCallback(
    (id: string) => catalogByRef.get(id)?.name,
    [catalogByRef]
  );

  /**
   * opencode 原生 agent 清单（GET /agents/opencode）。
   * 数据来自真实 worker 的 opencode 实例（serve GET /agent），非硬编码；degraded=true 时
   * （无在线 worker/旧版 serve）返回空清单，此处只做只读展示。隐藏系统 agent 已过滤。
   * 注意：与左侧「vteam Agent」（agents 表：模板/克隆/自定义）是两套独立机制——
   * vteam Agent 走 system 提示词注入，opencode agent 是 opencode 内核的执行体。
   */
  const opencodeAgentsQuery = useQuery({
    queryKey: ["opencode-agents", "agents-page"],
    queryFn: () =>
      api.get<{ agents: OpencodeAgentItem[]; workerId: string | null; degraded: boolean }>(
        "/agents/opencode",
      ),
    enabled: !!userId,
    staleTime: 60_000,
  });
  const opencodeAgents = (opencodeAgentsQuery.data?.agents ?? []).filter(isSelectableOpencodeAgent);

  // worker 列表：GET /workers（首选 worker 选择数据源，在线优先展示）
  const workersQuery = useQuery({
    queryKey: ["workers"],
    queryFn: () => api.get<ApiWorkerRow[]>("/workers"),
    enabled: !!userId,
  });
  const workers = workersQuery.data ?? [];

  // 模型凭据保存：POST /models/:mdId/credentials（按 provider 粒度加密落库 C4 + 下发 C5）
  const saveTokenMutation = useMutation({
    mutationFn: ({ modelId, token }: { modelId: string; token: string }) =>
      api.post(`/models/${modelId}/credentials`, { token }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model-credential"] });
    },
  });

  // MCP server 全量：GET /mcp-servers（含停用；权限分组标题 + 默认收起依据；
  // 分页拉全量：pageSize 100 循环直到 items 凑齐 total 或无更多页）
  const mcpServersQuery = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: async () => {
      const first = await api.get<PageResponse<ApiMcpServer>>("/mcp-servers", { query: { page: 1, pageSize: 100 } });
      const all = [...first.items];
      const total = first.total ?? first.items.length;
      let page = 1;
      while (all.length < total) {
        page += 1;
        if (page > 20) break;
        const next = await api.get<PageResponse<ApiMcpServer>>("/mcp-servers", { query: { page, pageSize: 100 } });
        if (next.items.length === 0) break;
        all.push(...next.items);
        if (all.length >= (next.total ?? total)) break;
      }
      return { items: all, total, page: 1, pageSize: all.length };
    },
    enabled: !!userId,
  });
  const mcpServers = mcpServersQuery.data?.items ?? [];

  // MCP 工具目录：GET /tools?source=mcp&includeDisabled=true（含停用；解析条目归属 server；
  // 分页拉全量：目录 194 行超单页 100 上限，pageSize 100 循环直到 items 凑齐 total 或无更多页）
  const mcpToolsQuery = useQuery({
    queryKey: ["mcp-tools"],
    queryFn: async () => {
      const baseQuery = { source: "mcp", includeDisabled: true };
      const first = await api.get<PageResponse<ApiTool>>("/tools", { query: { ...baseQuery, page: 1, pageSize: 100 } });
      const all = [...first.items];
      const total = first.total ?? first.items.length;
      let page = 1;
      while (all.length < total) {
        page += 1;
        if (page > 20) break;
        const next = await api.get<PageResponse<ApiTool>>("/tools", { query: { ...baseQuery, page, pageSize: 100 } });
        if (next.items.length === 0) break;
        all.push(...next.items);
        if (all.length >= (next.total ?? total)) break;
      }
      return { items: all, total, page: 1, pageSize: all.length };
    },
    enabled: !!userId,
  });
  const mcpTools = mcpToolsQuery.data?.items ?? [];

  // 选中 Agent：详情查询结果优先，未命中时回退列表条目（即时渲染）
  const selectedAgent: AgentItem | undefined =
    detailQuery.data ?? agents.find((a) => a.id === selectedId);

  // 克隆：POST /agents/:id/clone（必填 agentKey）→ 刷新列表并选中克隆体
  const cloneMutation = useMutation({
    mutationFn: ({ id, name, agentKey }: { id: string; name?: string; agentKey: string }) =>
      api.post<AgentItem>(`/agents/${id}/clone`, { ...(name ? { name } : {}), agentKey }),
    onSuccess: (clone) => {
      setCloneTarget(null);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setSelectedId(clone.id);
    },
  });

  // 保存：PATCH /agents/:id（template → 403 PERMISSION_AGENT_READONLY，UI 已只读避免触发）
  const saveMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateAgentPayload }) =>
      api.patch<AgentItem>(`/agents/${id}`, payload),
    onSuccess: () => {
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agent", selectedId] });
    },
    onError: (err) => {
      setSaveError(isApiError(err) ? err.message : "保存失败，请稍后重试");
    },
  });

  // 新建：POST /agents（type=custom，必填 agentKey）→ 刷新列表并选中新建
  const createMutation = useMutation({
    mutationFn: (payload: { name: string; prompt?: string; persona?: string | null; agentKey: string }) =>
      api.post<AgentItem>("/agents", { ...payload, type: "custom" }),
    onSuccess: (created) => {
      setCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setSelectedId(created.id);
    },
  });

  // 删除：DELETE /agents/:id → 刷新列表并清空选中（template 后端 403，UI 已隐藏入口）
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete<{ deleted: boolean; id: string }>(`/agents/${id}`),
    onSuccess: () => {
      setDeleteError(null);
      setDeleteConfirmOpen(false);
      setSelectedId(null);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (err) => {
      setDeleteError(isApiError(err) ? err.message : "删除失败，请稍后重试");
    },
  });

  const isTemplate = selectedAgent?.type === "template";

  return (
    <PageWindow
      testId="agent-config-root"
      style={{ position: "relative", backgroundColor: neutral[50], ...baseFont }}
    >
      {/* 窗口内保持左右双栏（列表 320px + 配置面板），原根容器行布局下移一层 */}
      <div style={{ display: "flex", gap: space.lg, alignItems: "flex-start" }}>
      {/* 左：Agent 列表（320px） */}
      <div
        style={{
          width: 320,
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
            Agent 列表
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            {isPending ? "…" : `${data?.total ?? agents.length} 个`}
          </span>
        </div>

        {isPending ? (
          <div data-testid="agents-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}>
            加载中…
          </div>
        ) : isError ? (
          <div
            data-testid="agents-error"
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
            <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
              {isApiError(error) ? error.message : "加载 Agent 列表失败"}
            </div>
            <button
              type="button"
              data-testid="agents-retry"
              onClick={() => refetch()}
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
        ) : (
          agents.map((agent) => (
            <AgentListItem
              key={agent.id}
              agent={agent}
              active={agent.id === selectedId}
              modelNameOf={modelNameOf}
              onClick={() => setSelectedId(agent.id)}
            />
          ))
        )}

        {canCreateAgent && (
          <button
            type="button"
            data-testid="create-agent-button"
            onClick={() => setCreateOpen(true)}
            style={{
              width: "100%",
              cursor: "pointer",
              border: `1px dashed ${neutral[300]}`,
              borderRadius: radius.md,
              backgroundColor: "transparent",
              padding: space.md,
              color: neutral[500],
              fontSize: fontSize.md,
              fontFamily: fontFamily.body,
            }}
          >
            + 新建自定义 Agent
          </button>
        )}

        {/* opencode 原生 agent（只读展示）：来自 worker 真实 opencode 实例。
            与上方 vteam Agent 是两套机制——此处列出的 agent 由 opencode 内核执行
            （选定后经团队成员面板的 agent 徽章切换，见团队会话页）。 */}
        <div
          data-testid="opencode-agent-section"
          style={{
            marginTop: space.md,
            paddingTop: space.md,
            borderTop: `1px solid ${neutral[200]}`,
            display: "flex",
            flexDirection: "column",
            gap: space.sm,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `0 ${space.xs}px` }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: space.xs, fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor: opencodeAgentsQuery.data?.degraded ? neutral[300] : "#0D9488",
                  flexShrink: 0,
                }}
              />
              opencode 原生 Agent
              {opencodeAgents.length > 0 && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: neutral[500],
                    backgroundColor: neutral[100],
                    border: `1px solid ${neutral[200]}`,
                    padding: "0 6px",
                    borderRadius: radius.pill,
                    lineHeight: "16px",
                  }}
                >
                  {opencodeAgents.length}
                </span>
              )}
            </span>
            {opencodeAgentsQuery.data?.degraded && (
              <span
                style={{
                  fontSize: 10,
                  color: "#B45309",
                  backgroundColor: "#FEF3C7",
                  border: "1px solid #FDE68A",
                  padding: "1px 6px",
                  borderRadius: radius.pill,
                }}
                title="无在线 worker 或 opencode 版本不支持"
              >
                暂不可用
              </span>
            )}
          </div>
          <span style={{ fontSize: fontSize.xs, color: neutral[400], padding: `0 ${space.xs}px`, lineHeight: 1.5 }}>
            由 opencode 内核执行（计划/构建等），在团队会话的成员面板切换
          </span>
          {opencodeAgentsQuery.isPending ? (
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }} aria-label="加载中">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    padding: space.sm,
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "var(--color-surface)",
                  }}
                >
                  <span style={{ width: 32, height: 32, borderRadius: radius.sm, backgroundColor: neutral[100], flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ height: 12, width: "45%", borderRadius: 6, backgroundColor: neutral[100] }} />
                    <span style={{ height: 10, width: "80%", borderRadius: 5, backgroundColor: neutral[100] }} />
                  </div>
                </div>
              ))}
            </div>
          ) : opencodeAgents.length === 0 ? (
            <div
              style={{
                padding: `${space.md}px ${space.sm}px`,
                borderRadius: radius.md,
                border: `1px dashed ${neutral[300]}`,
                backgroundColor: neutral[50],
                textAlign: "center",
                fontSize: fontSize.xs,
                color: neutral[400],
                lineHeight: 1.6,
              }}
            >
              未获取到（worker 离线或版本不支持）
            </div>
          ) : (
            opencodeAgents.map((ag) => {
              const isPrimary = ag.mode !== "subagent";
              const modeLabel = ag.mode === "primary" ? "主Agent" : ag.mode === "subagent" ? "子Agent" : "通用";
              return (
                <div
                  key={ag.name}
                  data-testid={`opencode-agent-item-${ag.name}`}
                  title={ag.description ?? ag.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    padding: `${space.sm}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "var(--color-surface)",
                    fontFamily: fontFamily.body,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      width: 32,
                      height: 32,
                      borderRadius: radius.sm,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: fontSize.md,
                      fontWeight: 700,
                      color: isPrimary ? "#0D9488" : neutral[500],
                      backgroundColor: isPrimary ? "rgba(13,148,136,0.12)" : neutral[100],
                      border: `1px solid ${isPrimary ? "rgba(13,148,136,0.35)" : neutral[200]}`,
                    }}
                  >
                    {ag.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: space.xs,
                        fontSize: fontSize.md,
                        fontWeight: 600,
                        color: neutral[800],
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {ag.name}
                      </span>
                      <span
                        style={{
                          fontSize: fontSize.xs,
                          fontWeight: 400,
                          color: isPrimary ? "#0D9488" : neutral[500],
                          backgroundColor: isPrimary ? "rgba(13,148,136,0.12)" : neutral[100],
                          border: `1px solid ${isPrimary ? "rgba(13,148,136,0.35)" : neutral[200]}`,
                          padding: "1px 6px",
                          borderRadius: radius.pill,
                          flexShrink: 0,
                        }}
                      >
                        {modeLabel}
                      </span>
                      {ag.native === false && (
                        <span
                          style={{
                            fontSize: fontSize.xs,
                            fontWeight: 400,
                            color: "#0D9488",
                            backgroundColor: "rgba(13,148,136,0.08)",
                            border: "1px dashed rgba(13,148,136,0.4)",
                            padding: "1px 6px",
                            borderRadius: radius.pill,
                            flexShrink: 0,
                          }}
                        >
                          自定义
                        </span>
                      )}
                    </div>
                    {ag.description && (
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
                        {ag.description}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 右：配置面板 */}
      {selectedAgent ? (
        <ConfigPanel
          key={selectedAgent.id}
          agent={selectedAgent}
          // is_0000000030：内置（template）agent 设置可编辑；删除仍对 template 隐藏（后端 403 兜底）
          readOnly={false}
          models={models}
          mcpServers={mcpServers}
          mcpTools={mcpTools}
          mcpLoading={mcpServersQuery.isPending || mcpToolsQuery.isPending}
          catalogByRef={catalogByRef}
          workers={workers}
          saving={saveMutation.isPending}
          saveError={saveError}
          onSave={(payload) => saveMutation.mutate({ id: selectedAgent.id, payload })}
          onSaveToken={(payload) => saveTokenMutation.mutate(payload)}
          onClone={() => setCloneTarget(selectedAgent)}
          canCreate={canCreateAgent}
          canDelete={isTemplate ? false : canDeleteAgent}
          deleting={deleteMutation.isPending}
          onDelete={() => setDeleteConfirmOpen(true)}
          deleteError={deleteError}
        />
      ) : (
        <div
          data-testid="agent-detail-loading"
          style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: `${space.xxl}px` }}
        >
          <span style={{ fontSize: fontSize.md, color: neutral[400] }}>
            {isPending ? "加载中…" : "请选择左侧 Agent 查看配置"}
          </span>
        </div>
      )}

      {/* 新建自定义 Agent 弹窗 */}
      <CreateAgentModal
        open={createOpen}
        submitting={createMutation.isPending}
        error={createMutation.isError ? formatAgentKeyError(createMutation.error) : null}
        onClose={() => setCreateOpen(false)}
        onSubmit={(payload) => createMutation.mutate(payload)}
      />

      {/* 克隆 Agent 弹窗（必填 agentKey，默认 <sourceKey>-copy） */}
      <CloneAgentModal
        source={cloneTarget}
        submitting={cloneMutation.isPending}
        error={cloneMutation.isError ? formatAgentKeyError(cloneMutation.error) : null}
        onClose={() => setCloneTarget(null)}
        onSubmit={(payload) => {
          if (cloneTarget) cloneMutation.mutate({ id: cloneTarget.id, ...payload });
        }}
      />

      {/* 删除 Agent 二次确认弹窗（UX-14：确认后才 DELETE，复用 confirm-delete-modal） */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="删除 Agent"
        description={
          selectedAgent
            ? `确定删除 Agent「${selectedAgent.name}」？删除后不可恢复，关联的技能与工具配置将一并清除。`
            : undefined
        }
        confirmLabel="确认删除"
        pendingLabel="删除中…"
        submitting={deleteMutation.isPending}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={() => {
          if (selectedAgent) deleteMutation.mutate(selectedAgent.id);
        }}
      />
      </div>
    </PageWindow>
  );
}
