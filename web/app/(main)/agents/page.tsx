"use client";

/**
 * Agent 管理页（Phase 3 T9：agent-config 原型保真迁移 + 真实 API 接入）
 * =============================================
 * 唯一来源：docs/agent-platform/prototypes/agent-config/index.tsx（布局/间距/文案/data-testid 零改动）。
 * - 左 Agent 列表（320px，data-testid=agent-list-item）+ 右 ConfigPanel 五块配置面板：
 *   提示词（prompt-editor）/ 默认模型（model-select）/ 技能（skill-list）/
 *   工具（tool-permission-list + tool-effect-select + tool-wildcard-row）/ 权限范围（permission-config）。
 * - 数据源：GET /api/v1/agents（type 过滤 + 分页 + 扩展字段）→ TanStack Query；
 *   选中 Agent → GET /api/v1/agents/:id 详情（列表条目已含扩展字段，详情查询保证选中态最新）。
 * - 交互：
 *   · clone-template-button → POST /agents/:id/clone → 刷新列表并选中克隆体（可继续编辑）
 *   · 新建自定义 → 弹窗 POST /agents（type=custom）→ 刷新列表并选中新建
 *   · type=custom / clone → 可编辑（提示词 / 默认模型 / 工具 effect）→ PATCH 保存
 *   · type=template → 只读（表单控件禁用 + 隐藏保存/添加按钮），仅保留克隆入口
 * - 模板只读态：isTemplate = type === 'template'。后端 PATCH/DELETE 仅禁 template
 *   （403 PERMISSION_AGENT_READONLY），clone/custom 可写——克隆的意义就是编辑副本。
 * - 页面内扩展 token（仿原型 :156-170）：toolEffectMeta（allow/ask/deny 三态色）、
 *   toolSourceMeta（内置/自定义/MCP），不写 tokens.ts 基线。
 * - 技能面板静态展示勾选态（对齐原型「纯静态示意」）：skills 表无独立列表端点、
 *   agent_skills 对 skills.id 有外键约束（当前库无技能数据），故技能仅渲染不随 PATCH 提交。
 * - 工具 effect 可编辑：agent_tool_effects.toolAction 为自由字符串（无外键约束），
 *   PATCH 提交 toolEffects 重建关联；工具来源按命名启发式推断（含下划线 → MCP）。
 * - 导航（NavTopBar/NavDock/CmdKPanel）由 AppShell 提供，本页仅渲染内容区。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；新建弹窗 absolute 相对页面 root（flex:1 铺满）。
 */
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { AgentAvatar } from "@/src/components/ui";
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
  baseAgentId: string | null;
  defaultModelId: string | null;
  permissionScope: Record<string, unknown> | null;
  /** 技能 id 数组（关联 skills 表） */
  skillIds: string[];
  /** 工具 effect 配置（toolAction 自由字符串 + 三态） */
  toolEffects: { toolAction: string; effect: string }[];
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

/** GET /agents/:id/available-models 条目（FR-47，Phase 3 静态占位）。 */
interface AvailableModel {
  id: string;
  name: string;
}

/** PATCH /agents/:id 请求体（仅提交可编辑字段，不传则后端保持原值）。 */
interface UpdateAgentPayload {
  prompt?: string;
  defaultModelId?: string;
  toolEffects?: { toolAction: string; effect: string }[];
}

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

/** 工具来源徽章色。 */
type ToolSourceKey = "内置" | "自定义" | "MCP";
const toolSourceMeta: Record<ToolSourceKey, { color: string; bg: string; border: string }> = {
  内置: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  自定义: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  MCP: { color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
};

/** 技能池（对齐原型 skillPool；skills 表无列表端点，页面内静态兜底展示勾选态）。 */
const SKILL_POOL = ["文档撰写", "需求拆解", "用例设计", "代码审查", "代码生成", "缺陷分析", "方案评审"];

/** 基础内置工具 action（read/write/bash 等裸权限名）→ 来源=内置。 */
const BUILTIN_TOOL_ACTIONS = new Set([
  "read", "write", "bash", "execute", "edit", "search", "grep", "glob", "list", "view",
]);

/**
 * 工具来源启发式推断（后端 toolEffects 仅 toolAction+effect，无 source）：
 * - 基础裸权限名 → 内置
 * - 含下划线（<server>_<tool>，如 jira_query / github_create_issue）→ MCP
 * - 其余（含连字符等，如 jenkins-build）→ 自定义
 */
function inferToolSource(action: string): ToolSourceKey {
  if (BUILTIN_TOOL_ACTIONS.has(action)) return "内置";
  if (action.includes("_")) return "MCP";
  return "自定义";
}

/** 模型 id → 产品名（与后端 STATIC_AVAILABLE_MODELS 静态占位一致；未知 id 显示原始值）。 */
const MODEL_NAMES: Record<string, string> = {
  "gpt-4o": "GPT-4o",
  "claude-3-5-sonnet": "Claude 3.5 Sonnet",
  "deepseek-v3": "DeepSeek V3",
};

/** Agent 类型 → 徽章文案（模板只读 / 自定义 / 克隆副本）。 */
const TYPE_LABEL: Record<string, string> = {
  template: "模板",
  custom: "自定义",
  clone: "克隆",
};

const ROLE_KEYS: readonly RoleKey[] = ["product", "architect", "developer", "tester"];

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
  onClick: () => void;
}

function AgentListItem({ agent, active, onClick }: AgentListItemProps) {
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
            flexWrap: "wrap",
            gap: space.xs,
            marginTop: space.sm,
          }}
        >
          {agent.skillIds.slice(0, 3).map((skill) => (
            <span
              key={skill}
              style={{
                fontSize: fontSize.xs,
                color: neutral[500],
                backgroundColor: neutral[100],
                padding: "1px 6px",
                borderRadius: radius.pill,
              }}
            >
              {skill}
            </span>
          ))}
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
            {agent.defaultModelId ? (MODEL_NAMES[agent.defaultModelId] ?? agent.defaultModelId) : "未设置"}
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
  product: "#3B82F6", architect: "#8B5CF6", developer: "#10B981", tester: "#F59E0B",
};
const ROLE_BGS: Record<RoleKey, string> = {
  product: "#EFF6FF", architect: "#F5F3FF", developer: "#ECFDF5", tester: "#FFFBEB",
};
const ROLE_BORDERS: Record<RoleKey, string> = {
  product: "#BFDBFE", architect: "#DDD6FE", developer: "#A7F3D0", tester: "#FDE68A",
};

/* ================================ 工具权限列表（可编辑，对齐原型 ToolPermissionList） ================================ */

interface ToolEffectRow {
  toolAction: string;
  effect: ToolEffectKey;
}

interface ToolPermissionListProps {
  tools: ToolEffectRow[];
  /** 模板只读：effect 切换 / 添加 / 删除 全部禁用 */
  readOnly: boolean;
  onChange: (next: ToolEffectRow[]) => void;
}

function ToolPermissionList({ tools, readOnly, onChange }: ToolPermissionListProps) {
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

  return (
    <div
      data-testid="tool-permission-list"
      style={{ display: "flex", flexDirection: "column", gap: space.sm }}
    >
      {tools.map((tool) => {
        const effect = toolEffectMeta[tool.effect] ?? toolEffectMeta.allow;
        const source = toolSourceMeta[inferToolSource(tool.toolAction)];
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
                  {inferToolSource(tool.toolAction)}
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
                placeholder="工具 action（如 github_create_issue / jenkins-build）"
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

      {/* 通配符行：示例 jenkins-* → ask（静态示意，对齐原型） */}
      <div
        data-testid="tool-wildcard-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          border: `1px dashed ${neutral[300]}`,
          backgroundColor: neutral[50],
          fontSize: fontSize.xs,
          color: neutral[500],
        }}
      >
        <span style={{ fontFamily: fontFamily.mono, fontWeight: 600, color: neutral[700] }}>
          jenkins-*
        </span>
        <span aria-hidden style={{ color: neutral[300] }}>
          →
        </span>
        <span
          style={{
            color: toolEffectMeta.ask.color,
            backgroundColor: toolEffectMeta.ask.bg,
            border: `1px solid ${toolEffectMeta.ask.border}`,
            padding: "1px 6px",
            borderRadius: radius.pill,
            fontWeight: 500,
            fontFamily: fontFamily.mono,
          }}
        >
          ask
        </span>
        <span>可用通配符批量授权同类工具</span>
      </div>
    </div>
  );
}

/* ================================ 配置面板 ================================ */

interface ConfigPanelProps {
  agent: AgentItem;
  /** 是否只读（type=template） */
  readOnly: boolean;
  /** 可用模型列表（available-models） */
  models: AvailableModel[];
  saving: boolean;
  saveError: string | null;
  onSave: (payload: UpdateAgentPayload) => void;
  onClone: () => void;
  /** 当前已保存草稿回调（供页面保存时取最新值；由面板内部管理草稿） */
}

function ConfigPanel({ agent, readOnly, models, saving, saveError, onSave, onClone }: ConfigPanelProps) {
  const isTemplate = readOnly;
  const accent = isTemplate
    ? ROLE_COLORS[toAvatarRole(agent.role)]
    : CUSTOM_THEME.color;

  // 草稿：挂载时从 agent 初始化（父级 key=agent.id 保证切换重挂载）
  const [promptDraft, setPromptDraft] = useState(agent.prompt ?? "");
  const [modelDraft, setModelDraft] = useState<string | null>(agent.defaultModelId ?? null);
  const [toolDrafts, setToolDrafts] = useState<ToolEffectRow[]>(
    agent.toolEffects.map((t) => ({
      toolAction: t.toolAction,
      effect: (toolEffectMeta[t.effect as ToolEffectKey] ? t.effect : "allow") as ToolEffectKey,
    }))
  );

  const activeSkillCount = agent.skillIds.filter((s) => SKILL_POOL.includes(s)).length;

  const handleSave = () => {
    // template 仅允许保存 defaultModelId（后端 assertWritable 单字段放行）；其余字段只读不提交
    const payload: UpdateAgentPayload = isTemplate
      ? { defaultModelId: modelDraft ?? undefined }
      : {
          prompt: promptDraft.trim(),
          defaultModelId: modelDraft ?? undefined,
          toolEffects: toolDrafts.map((t) => ({ toolAction: t.toolAction, effect: t.effect })),
        };
    onSave(payload);
  };

  const currentModel = models.find((m) => m.id === modelDraft);
  const currentModelName = currentModel?.name ?? (modelDraft ? (MODEL_NAMES[modelDraft] ?? modelDraft) : null);

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
            {saving ? "保存中…" : "保存"}
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
            FR-33 · 即时生效于后续会话
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
            默认模型
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            FR-47 · 新会话默认使用
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
              width: 176,
              flexShrink: 0,
            }}
          >
            <option value="">未设置</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </div>
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
          模型列表来自 opencode 接口动态获取
        </div>
      </div>

      {/* ③ 技能列表（静态展示勾选态，对齐原型纯静态示意；skills 无独立端点 + 外键约束故不提交） */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            技能配置
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            FR-34 · 已启用 {activeSkillCount}/{SKILL_POOL.length}
          </span>
        </div>
        <div
          data-testid="skill-list"
          style={{ display: "flex", flexWrap: "wrap", gap: space.sm }}
        >
          {SKILL_POOL.map((skill) => {
            const checked = agent.skillIds.includes(skill);
            return (
              <label
                key={skill}
                data-skill={skill}
                data-checked={checked ? "true" : "false"}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: space.xs,
                  padding: `${space.xs}px ${space.sm + 2}px`,
                  borderRadius: radius.pill,
                  backgroundColor: checked ? "#EFF6FF" : neutral[50],
                  border: `1px solid ${checked ? "#BFDBFE" : neutral[200]}`,
                  color: checked ? "#2563EB" : neutral[500],
                  fontSize: fontSize.sm,
                  cursor: "default",
                  fontFamily: fontFamily.body,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: radius.sm,
                    backgroundColor: checked ? "#2563EB" : "#FFFFFF",
                    border: `1px solid ${checked ? "#2563EB" : neutral[300]}`,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#FFFFFF",
                    fontSize: 10,
                    lineHeight: 1,
                  }}
                >
                  {checked ? "✓" : ""}
                </span>
                {skill}
              </label>
            );
          })}
          {/* 池外技能（真实 skillId 未收录于池内时原样展示，保证数据不丢） */}
          {agent.skillIds
            .filter((s) => !SKILL_POOL.includes(s))
            .map((s) => (
              <span
                key={s}
                data-skill={s}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: `${space.xs}px ${space.sm + 2}px`,
                  borderRadius: radius.pill,
                  backgroundColor: "#EFF6FF",
                  border: `1px solid #BFDBFE`,
                  color: "#2563EB",
                  fontSize: fontSize.sm,
                  fontFamily: fontFamily.mono,
                }}
              >
                {s}
              </span>
            ))}
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
            FR-35 · 停用后 Agent 无法调用
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
          工具名即权限 action（如
          <span style={{ fontFamily: fontFamily.mono, color: neutral[600] }}>jenkins-build</span>
          ），支持通配符批量授权（如
          <span style={{ fontFamily: fontFamily.mono, color: neutral[600] }}>jenkins-*</span>
          ）
        </div>
        <ToolPermissionList
          tools={toolDrafts}
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
            FR-36 · 超出范围的操作转交用户确认
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
  onSubmit: (payload: { name: string; prompt?: string }) => void;
}

function CreateAgentModal({ open, submitting, error, onClose, onSubmit }: CreateAgentModalProps) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");

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
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    onSubmit({
      name: name.trim(),
      prompt: prompt.trim() ? prompt.trim() : undefined,
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
              完全自定义（FR-32），创建后可编辑提示词 / 模型 / 工具权限
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
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    mutationFn: (payload: { name: string; prompt?: string }) =>
      api.post<AgentItem>("/agents", { ...payload, type: "custom" }),
    onSuccess: (created) => {
      setCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setSelectedId(created.id);
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
              onClick={() => setSelectedId(agent.id)}
            />
          ))
        )}

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
      </div>

      {/* 右：配置面板 */}
      {selectedAgent ? (
        <ConfigPanel
          key={selectedAgent.id}
          agent={selectedAgent}
          readOnly={isTemplate}
          models={models}
          saving={saveMutation.isPending}
          saveError={saveError}
          onSave={(payload) => saveMutation.mutate({ id: selectedAgent.id, payload })}
          onClone={() => cloneMutation.mutate(selectedAgent.id)}
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
    </div>
  );
}
