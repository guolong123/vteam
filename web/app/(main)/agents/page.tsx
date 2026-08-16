"use client";

/**
 * Agent 管理页（Phase 3 T9：agent-config 原型保真迁移 + 真实 API 接入）
 * =============================================
 * 唯一来源：docs/agent-platform/prototypes/agent-config/index.tsx（布局/间距/文案/data-testid 零改动）。
 * - 左 Agent 列表（320px，data-testid=agent-list-item）+ 右 ConfigPanel 四块配置面板：
 *   提示词（prompt-editor）/ 默认模型（model-select）/
 *   工具（tool-permission-list + tool-effect-select）/ 权限范围（permission-config）。
 * - 数据源：GET /api/v1/agents（type 过滤 + 分页 + 扩展字段）→ TanStack Query；
 *   选中 Agent → GET /api/v1/agents/:id 详情（列表条目已含扩展字段，详情查询保证选中态最新）。
 * - 交互：
 *   · clone-template-button → POST /agents/:id/clone → 刷新列表并选中克隆体（可继续编辑）
 *   · 新建自定义 → 弹窗 POST /agents（type=custom）→ 刷新列表并选中新建
 *   · type=custom / clone / template → 均可编辑设置（提示词 / 默认模型 / 工具 effect）→ PATCH 保存
 * - is_0000000030：内置（template）agent 设置可编辑（后端已放开，agentId/type 不可改）；
 *   删除仍对 template 隐藏（后端 DELETE 403 PERMISSION_AGENT_READONLY 兜底），
 *   isTemplate 仅用于主题色展示，不再作为只读态。
 * - 页面内扩展 token（仿原型 :156-170）：toolEffectMeta（allow/ask/deny 三态色）、
 *   toolSourceMeta（builtin/custom/mcp 真实 source 徽章色），不写 tokens.ts 基线。
 * - 技能注入为全局机制（worker 级全局注入，不按 agent 绑定），前端移除绑定配置。
 * - 工具区目录驱动（T7）：GET /tools?enabled=true 为工具行数据源（action + 真实 source 徽章
 *   + enabled 恒启用），effect 三态编辑 → PATCH 提交 toolEffects 重建 agent_tool_effects；
 *   手动添加/停用残留 action 不在目录时按命名启发式兜底标注来源。
 * - 导航（NavTopBar/NavDock/CmdKPanel）由 AppShell 提供，本页仅渲染内容区。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；新建弹窗 absolute 相对页面 root（flex:1 铺满）。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { hasPermission } from "@/lib/permissions";
import { useAuthStore } from "@/lib/stores/authStore";
import { AgentAvatar, ConfirmDialog } from "@/src/components/ui";
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

/** GET /agents 条目（对齐 AgentsService.toAgentDto 扩展字段）。 */
interface AgentItem {
  id: string;
  name: string;
  /** product | architect | developer | tester | null（自定义可为任意角色 key） */
  role: string | null;
  /** template（只读）/ custom（自定义）/ clone（克隆副本，可写） */
  type: string;
  prompt: string;
  /** 群聊 @Agent 收到确认文案（null=未定制，后端用默认文案；模板 Agent 也放行部署适配） */
  ackMessage: string | null;
  baseAgentId: string | null;
  defaultModelId: string | null;
  /** 首选 worker id（软绑定，可空 null=自动调度，C1/C6） */
  workerId: string | null;
  permissionScope: Record<string, unknown> | null;
  /** 技能 id 数组（关联 skills 表） */
  skillIds: string[];
  /** 工具 effect 配置（toolAction 自由字符串 + 三态） */
  toolEffects: { toolAction: string; effect: string }[];
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
  /** 群聊 @Agent 收到确认文案（空字符串提交 null=后端用默认文案；模板 Agent 也放行） */
  ackMessage?: string | null;
  defaultModelId?: string;
  /** 首选 worker id（软绑定；显式 null=自动调度） */
  workerId?: string | null;
  /** 工具 effect 配置（重建 agent_tool_effects 关联） */
  toolEffects?: { toolAction: string; effect: string }[];
  /** Agent 性格（显式 null 清除） */
  persona?: string | null;
}

/** GET /tools 条目（对齐 ToolsService.findAll 返回；source 为注册推导/seed 内置）。 */
interface ApiTool {
  id: string;
  name: string;
  action: string;
  source: "builtin" | "custom" | "mcp";
  enabled: boolean;
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

/** 工具 effect 三态（与 opencode PermissionV2 对齐）。 */
type ToolEffectKey = "allow" | "ask" | "deny";

/** effect 语义与配色（与 statusColors 同构）。 */
const toolEffectMeta: Record<
  ToolEffectKey,
  { label: string; desc: string; color: string; bg: string; border: string }
> = {
  allow: { label: "允许", desc: "无需确认 · 只读/低风险", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  ask: { label: "确认", desc: "每次调用需确认 · 有副作用", color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  deny: { label: "禁止", desc: "白名单排除", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
};

/** 工具来源徽章色（真实 source 值：builtin/custom/mcp，来自 GET /tools）。 */
type ToolSourceKey = "builtin" | "custom" | "mcp";
const toolSourceMeta: Record<ToolSourceKey, { label: string; color: string; bg: string; border: string }> = {
  builtin: { label: "内置", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  custom: { label: "自定义", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  mcp: { label: "MCP", color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
};

/** 基础内置工具 action（read/write/bash 等裸权限名）→ 来源=内置（仅兜底：未在工具目录的 action）。 */
const BUILTIN_TOOL_ACTIONS = new Set([
  "read", "write", "bash", "execute", "edit", "search", "grep", "glob", "list", "view",
]);

/** 凭据状态双态（与 models-manage 页内定义完全一致；"扩展 token"范式页面内定义）。 */
const credentialTheme = {
  configured: { label: "已配置", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  missing: { label: "未配置", color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
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

/**
 * 工具来源推断（**兜底路径**）：主路径 = GET /tools 真实 source；
 * 仅当 action 不在启用工具目录（手动添加的通配/残留）时使用：
 * - 基础裸权限名 → 内置
 * - 含下划线（<server>_<tool>，如 jira_query / github_create_issue）→ MCP
 * - 其余（含连字符等，如 my-custom-tool）→ 自定义
 */
function inferToolSource(action: string): ToolSourceKey {
  if (BUILTIN_TOOL_ACTIONS.has(action)) return "builtin";
  if (action.includes("_")) return "mcp";
  return "custom";
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
const CUSTOM_THEME = { color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" };

/** permissionScope 对象 → 权限范围面板三行可读文本（对齐原型 permission-config 行结构）。 */
function permissionRows(scope: Record<string, unknown> | null): { label: string; value: string }[] {
  const write = scope?.write === true;
  const ask = scope?.ask === true;
  return [
    {
      label: "可访问资源",
      value:
        scope?.projects === "*" || scope === null
          ? "本项目 · 任务文档库 · 关联仓库"
          : scope?.projects !== undefined
            ? String(scope.projects)
            : "本项目 · 任务文档库 · 关联仓库",
    },
    {
      label: "可执行操作",
      value: write ? "读取 + 写任务文档库" : "仅读取",
    },
    {
      label: "写操作确认",
      value: ask ? "默认开启，写操作需成员确认" : "默认关闭，首次写操作需成员确认",
    },
  ];
}

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
        backgroundColor: active ? "#FFFFFF" : neutral[50],
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
            backgroundColor: "#FFFFFF",
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
  product: "#3B82F6", project_manager: "#0EA5E9", architect: "#8B5CF6", developer: "#10B981", tester: "#F59E0B",
};
const ROLE_BGS: Record<RoleKey, string> = {
  product: "#EFF6FF", project_manager: "#F0F9FF", architect: "#F5F3FF", developer: "#ECFDF5", tester: "#FFFBEB",
};
const ROLE_BORDERS: Record<RoleKey, string> = {
  product: "#BFDBFE", project_manager: "#BAE6FD", architect: "#DDD6FE", developer: "#A7F3D0", tester: "#FDE68A",
};

/* ================================ 工具权限列表（可编辑，对齐原型 ToolPermissionList） ================================ */

interface ToolEffectRow {
  toolAction: string;
  effect: ToolEffectKey;
}

interface ToolPermissionListProps {
  tools: ToolEffectRow[];
  /** 启用工具目录（GET /tools?enabled=true）；action 命中目录 → 真实 source 徽章 */
  catalog: ApiTool[];
  /** 模板只读：effect 切换 / 添加 / 删除 全部禁用 */
  readOnly: boolean;
  onChange: (next: ToolEffectRow[]) => void;
}

function ToolPermissionList({ tools, catalog, readOnly, onChange }: ToolPermissionListProps) {
  const [adding, setAdding] = useState(false);
  const [draftAction, setDraftAction] = useState("");

  const setEffect = (action: string, effect: ToolEffectKey) => {
    onChange(tools.map((t) => (t.toolAction === action ? { ...t, effect } : t)));
  };

  const removeTool = (action: string) => {
    onChange(tools.filter((t) => t.toolAction !== action));
  };

  const commitAdd = () => {
    const action = draftAction.trim();
    if (!action) return;
    if (!tools.some((t) => t.toolAction === action)) {
      onChange([...tools, { toolAction: action, effect: "allow" as ToolEffectKey }]);
    }
    setDraftAction("");
    setAdding(false);
  };

  // 行集合 = 目录工具（catalog，effect 取当前配置或默认 allow）+ 未收录 action（手动添加/残留，原 effect）
  const catalogByAction = new Map(catalog.map((t) => [t.action, t]));
  const rows: ToolEffectRow[] = [
    ...catalog.map((t) => {
      const existing = tools.find((r) => r.toolAction === t.action);
      return { toolAction: t.action, effect: (existing?.effect ?? "allow") as ToolEffectKey };
    }),
    ...tools.filter((t) => !catalogByAction.has(t.toolAction)),
  ];

  return (
    <div
      data-testid="tool-permission-list"
      style={{ display: "flex", flexDirection: "column", gap: space.sm }}
    >
      {rows.map((tool) => {
        const effect = toolEffectMeta[tool.effect] ?? toolEffectMeta.allow;
        const inCatalog = catalogByAction.get(tool.toolAction);
        // 真实 source 优先；未收录 action（手动添加/停用残留）启发式兜底
        const sourceKey: ToolSourceKey = inCatalog ? inCatalog.source : inferToolSource(tool.toolAction);
        const source = toolSourceMeta[sourceKey];
        return (
          <div
            key={tool.toolAction}
            data-testid="tool-permission-item"
            data-tool={tool.toolAction}
            data-enabled="true"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.md,
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
            }}
          >
            {/* 启用开关（后端无 enabled 字段，真实数据恒启用；模板只读时禁点） */}
            <span
              data-testid="tool-toggle-item"
              aria-hidden
              style={{
                flexShrink: 0,
                width: 34,
                height: 19,
                borderRadius: radius.pill,
                backgroundColor: "#10B981",
                position: "relative",
                opacity: readOnly ? 0.85 : 1,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  left: 17,
                  width: 15,
                  height: 15,
                  borderRadius: "50%",
                  backgroundColor: "#FFFFFF",
                }}
              />
            </span>

            {/* 工具名（action）+ 来源徽章 + effect 说明 */}
            <div
              style={{
                minWidth: 0,
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <span
                  style={{
                    fontFamily: fontFamily.mono,
                    fontSize: fontSize.md,
                    fontWeight: 600,
                    color: neutral[800],
                  }}
                >
                  {tool.toolAction}
                </span>
                <span
                  style={{
                    fontSize: fontSize.xs,
                    color: source.color,
                    backgroundColor: source.bg,
                    border: `1px solid ${source.border}`,
                    padding: "1px 6px",
                    borderRadius: radius.pill,
                  }}
                >
                  {source.label}
                </span>
              </div>
              <span style={{ fontSize: fontSize.xs }}>
                <span style={{ color: effect.color, fontWeight: 500 }}>{effect.label}</span>
                <span style={{ color: neutral[400] }}> · {effect.desc}</span>
              </span>
            </div>

            {/* effect 三选（allow / ask / deny）+ 删除（可编辑态） */}
            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <div
                data-testid="tool-effect-select"
                role="radiogroup"
                aria-label={`${tool.toolAction} 权限`}
                style={{
                  flexShrink: 0,
                  display: "inline-flex",
                  gap: 2,
                  padding: 3,
                  borderRadius: radius.pill,
                  backgroundColor: neutral[50],
                  border: `1px solid ${neutral[200]}`,
                }}
              >
                {(Object.keys(toolEffectMeta) as ToolEffectKey[]).map((key) => {
                  const meta = toolEffectMeta[key];
                  const active = tool.effect === key;
                  return (
                    <span
                      key={key}
                      data-effect={key}
                      aria-checked={active}
                      role="radio"
                      onClick={readOnly ? undefined : () => setEffect(tool.toolAction, key)}
                      style={{
                        padding: `2px ${space.sm}px`,
                        borderRadius: radius.pill,
                        fontSize: fontSize.xs,
                        fontWeight: 500,
                        cursor: readOnly ? "default" : "pointer",
                        fontFamily: fontFamily.mono,
                        color: active ? "#FFFFFF" : neutral[500],
                        backgroundColor: active ? meta.color : "transparent",
                      }}
                    >
                      {key}
                    </span>
                  );
                })}
              </div>
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`移除工具 ${tool.toolAction}`}
                  onClick={() => removeTool(tool.toolAction)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 22,
                    height: 22,
                    flexShrink: 0,
                    borderRadius: radius.sm,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "#FFFFFF",
                    color: neutral[400],
                    fontSize: fontSize.sm,
                    lineHeight: 1,
                    cursor: "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* 工具为空：空态提示 */}
      {tools.length === 0 && (
        <div
          data-testid="tool-empty"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.md}px`,
            borderRadius: radius.md,
            border: `1px dashed ${neutral[300]}`,
            backgroundColor: neutral[50],
            fontSize: fontSize.sm,
            color: neutral[400],
          }}
        >
          {readOnly ? "模板未配置工具权限" : "暂无工具权限配置，可点击下方「添加工具」"}
        </div>
      )}

      {/* 添加工具（仅可编辑态） */}
      {!readOnly && (
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          {adding ? (
            <>
              <input
                data-testid="tool-action-input"
                autoFocus
                placeholder="工具 action（如 my_custom_tool）"
                value={draftAction}
                onChange={(e) => setDraftAction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitAdd();
                  if (e.key === "Escape") setAdding(false);
                }}
                style={{
                  flex: 1,
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[300]}`,
                  backgroundColor: "#FFFFFF",
                  fontSize: fontSize.sm,
                  fontFamily: fontFamily.mono,
                  color: neutral[800],
                  outline: "none",
                }}
              />
              <button
                type="button"
                data-testid="tool-add-confirm"
                onClick={commitAdd}
                disabled={!draftAction.trim()}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  fontSize: fontSize.sm,
                  fontWeight: 500,
                  cursor: draftAction.trim() ? "pointer" : "default",
                  opacity: draftAction.trim() ? 1 : 0.6,
                  fontFamily: fontFamily.body,
                }}
              >
                添加
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="tool-add-button"
              onClick={() => setAdding(true)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space.xs,
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.pill,
                border: `1px dashed ${neutral[300]}`,
                backgroundColor: "transparent",
                color: neutral[500],
                fontSize: fontSize.sm,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              + 添加工具
            </button>
          )}
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
  /** 启用工具目录（GET /tools?enabled=true，工具行 + 来源徽章） */
  tools: ApiTool[];
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

function ConfigPanel({ agent, readOnly, models, tools, catalogByRef, workers, saving, saveError, onSave, onSaveToken, onClone, canCreate, canDelete, onDelete, deleting, deleteError }: ConfigPanelProps) {
  // is_0000000030：readOnly 不再按 type 区分（template 也可编辑）；isTemplate 仅用于主题色
  const isTemplate = agent.type === "template";
  const accent = isTemplate
    ? ROLE_COLORS[toAvatarRole(agent.role)]
    : CUSTOM_THEME.color;

  // 草稿：挂载时从 agent 初始化（父级 key=agent.id 保证切换重挂载）
  const [promptDraft, setPromptDraft] = useState(agent.prompt ?? "");
  const [ackMessageDraft, setAckMessageDraft] = useState(agent.ackMessage ?? "");
  const [personaDraft, setPersonaDraft] = useState<string | null>(agent.persona ?? null);
  const [modelDraft, setModelDraft] = useState<string | null>(agent.defaultModelId ?? null);
  const [workerDraft, setWorkerDraft] = useState<string>(agent.workerId ?? "");
  const [toolDrafts, setToolDrafts] = useState<ToolEffectRow[]>(
    agent.toolEffects.map((t) => ({
      toolAction: t.toolAction,
      effect: (toolEffectMeta[t.effect as ToolEffectKey] ? t.effect : "allow") as ToolEffectKey,
    }))
  );

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

  // 工具目录加载完成后补入草稿（默认 allow）：目录 = agent 配置页工具行数据源，
  // 空 agent 也应展示全部启用工具；已存在/用户已删除的 action 不覆盖。
  useEffect(() => {
    if (tools.length === 0) return;
    setToolDrafts((prev) => {
      const merged = [...prev];
      for (const t of tools) {
        if (!merged.some((r) => r.toolAction === t.action)) {
          merged.push({ toolAction: t.action, effect: "allow" });
        }
      }
      return merged;
    });
  }, [tools]);

  const handleSave = () => {
    // is_0000000030：内置（template）agent 设置也可修改（后端已放开，agentId/type 不可改）；
    // 提交全部设置字段（prompt/模型/worker/技能/工具 effect/确认文案）
    const payload: UpdateAgentPayload = {
      prompt: promptDraft.trim(),
      defaultModelId: modelDraft ?? undefined,
      // 软绑定首选 worker：显式提交（空=自动调度，null 清除绑定）
      workerId: workerDraft || null,
      toolEffects: toolDrafts.map((t) => ({ toolAction: t.toolAction, effect: t.effect })),
      ackMessage: ackMessageDraft.trim() || null,
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
        backgroundColor: "#FFFFFF",
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
                border: "1px solid #FECACA",
                backgroundColor: "#FFFFFF",
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
                backgroundColor: "#FFFFFF",
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
            backgroundColor: "#FEF2F2",
            border: `1px solid #FECACA`,
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
            backgroundColor: "#FEF2F2",
            border: `1px solid #FECACA`,
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
            backgroundColor: isTemplate ? neutral[50] : "#FFFFFF",
            padding: space.md,
            fontSize: fontSize.md,
            lineHeight: 1.6,
            color: neutral[700],
            fontFamily: fontFamily.mono,
            outline: "none",
          }}
        />
      </div>

      {/* ①b 收到确认文案：群聊 @Agent 被调用时的自动回复（空=null 用默认文案；模板 Agent 也放行=部署适配） */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            收到确认文案
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            群聊 @Agent 被调用时自动回复
          </span>
        </div>
        <textarea
          data-testid="ack-message-editor"
          rows={2}
          spellCheck={false}
          value={ackMessageDraft}
          onChange={(e) => setAckMessageDraft(e.target.value)}
          placeholder="收到，正在处理…"
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "none",
            border: `1px solid ${neutral[200]}`,
            borderRadius: radius.md,
            backgroundColor: "#FFFFFF",
            padding: space.md,
            fontSize: fontSize.md,
            lineHeight: 1.6,
            color: neutral[700],
            fontFamily: fontFamily.mono,
            outline: "none",
          }}
        />
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
          {isTemplate ? "模板允许调整该文案（部署适配字段）" : "留空则使用默认文案「收到，正在处理…」"}
        </span>
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
              backgroundColor: "#FFFFFF",
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
              backgroundColor: "#FFFFFF",
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
                  backgroundColor: "#FFFFFF",
                  fontSize: fontSize.sm,
                  color: neutral[800],
                  fontFamily: fontFamily.mono,
                  outline: "none",
                }}
              />
                <button
                  type="button"
                  disabled={!selectedCatalog || !tokenInput.trim()}
                  onClick={() =>
                    selectedCatalog &&
                    onSaveToken({ modelId: selectedCatalog.id, token: tokenInput.trim() })
                  }
                  style={{
                    padding: `${space.xs + 1}px ${space.md}px`,
                    borderRadius: radius.pill,
                    border: "none",
                    backgroundColor: "#2563EB",
                    color: "#FFFFFF",
                    fontSize: fontSize.xs,
                    fontWeight: 500,
                    cursor: !selectedCatalog || !tokenInput.trim() ? "default" : "pointer",
                    opacity: !selectedCatalog || !tokenInput.trim() ? 0.6 : 1,
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
              backgroundColor: "#FFFFFF",
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
              backgroundColor: "#FFFBEB",
              border: `1px solid #FDE68A`,
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

      {/* ④ 工具配置（开关 + 权限矩阵，可编辑 effect） */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            工具配置
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            工具 · 停用后 Agent 无法调用
          </span>
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
          <span aria-hidden style={{ color: accent, fontSize: fontSize.xs }}>
            ◈
          </span>
          工具名即权限 action，支持通配符批量授权
        </div>
        <ToolPermissionList
          tools={toolDrafts}
          catalog={tools}
          readOnly={isTemplate}
          onChange={setToolDrafts}
        />
      </div>

      {/* ⑤ 权限范围配置（FR-36，从 permissionScope 渲染，静态展示） */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            权限范围
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            权限 · 超出范围的操作转交用户确认
          </span>
        </div>
        <div
          data-testid="permission-config"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.sm,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
          }}
        >
          {permissionRows(agent.permissionScope).map((row) => (
            <div
              key={row.label}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: space.md,
                fontSize: fontSize.sm,
              }}
            >
              <span style={{ color: neutral[500], flexShrink: 0 }}>{row.label}</span>
              <span style={{ color: neutral[800], textAlign: "right" }}>{row.value}</span>
            </div>
          ))}
        </div>
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
  onSubmit: (payload: { name: string; prompt?: string; persona?: string | null }) => void;
}

function CreateAgentModal({ open, submitting, error, onClose, onSubmit }: CreateAgentModalProps) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [persona, setPersona] = useState<string | null>(null);

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
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    onSubmit({
      name: name.trim(),
      prompt: prompt.trim() ? prompt.trim() : undefined,
      persona: persona,
    });
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
          backgroundColor: "#FFFFFF",
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
              完全自定义，创建后可编辑提示词 / 模型 / 工具权限
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
              backgroundColor: "#FFFFFF",
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
            disabled={submitting || !name.trim()}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: submitting || !name.trim() ? "default" : "pointer",
              opacity: submitting || !name.trim() ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
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

  // 工具目录：GET /tools?enabled=true（T3 成员只读过滤保证停用工具不可见）
  const toolsQuery = useQuery({
    queryKey: ["tools"],
    queryFn: () => api.get<PageResponse<ApiTool>>("/tools", { query: { page: 1, pageSize: 100, enabled: true } }),
    enabled: !!userId,
  });
  const tools = toolsQuery.data?.items ?? [];

  // 选中 Agent：详情查询结果优先，未命中时回退列表条目（即时渲染）
  const selectedAgent: AgentItem | undefined =
    detailQuery.data ?? agents.find((a) => a.id === selectedId);

  // 克隆：POST /agents/:id/clone → 刷新列表并选中克隆体
  const cloneMutation = useMutation({
    mutationFn: (id: string) => api.post<AgentItem>(`/agents/${id}/clone`, {}),
    onSuccess: (clone) => {
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

  // 新建：POST /agents（type=custom）→ 刷新列表并选中新建
  const createMutation = useMutation({
    mutationFn: (payload: { name: string; prompt?: string; persona?: string | null }) =>
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
    <div
      data-testid="agent-config-root"
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        gap: space.lg,
        alignItems: "flex-start",
        padding: space.xl,
        overflow: "auto",
        backgroundColor: neutral[50],
        ...baseFont,
      }}
    >
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
      </div>

      {/* 右：配置面板 */}
      {selectedAgent ? (
        <ConfigPanel
          key={selectedAgent.id}
          agent={selectedAgent}
          // is_0000000030：内置（template）agent 设置可编辑；删除仍对 template 隐藏（后端 403 兜底）
          readOnly={false}
          models={models}
          tools={tools}
          catalogByRef={catalogByRef}
          workers={workers}
          saving={saveMutation.isPending}
          saveError={saveError}
          onSave={(payload) => saveMutation.mutate({ id: selectedAgent.id, payload })}
          onSaveToken={(payload) => saveTokenMutation.mutate(payload)}
          onClone={() => cloneMutation.mutate(selectedAgent.id)}
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
        error={
          createMutation.isError
            ? isApiError(createMutation.error)
              ? createMutation.error.message
              : "创建失败，请稍后重试"
            : null
        }
        onClose={() => setCreateOpen(false)}
        onSubmit={(payload) => createMutation.mutate(payload)}
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
  );
}
