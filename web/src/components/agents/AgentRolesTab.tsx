"use client";

/**
 * AgentRole 岗位 Tab（agent-role-entity todo 7，挂载于 /agents 的 Tab 2「角色」）
 * =============================================
 * 唯一来源：docs/agent-platform/prototypes/agent-role/index.tsx（布局/文案/data-testid 对齐）。
 * - 左栏：岗位列表（7 内置 + 自定义），显示岗位名 / 内置-自定义徽章 / 默认 Agent / 职责摘要。
 * - 右栏：岗位详情编辑表单（name / description / 默认 Agent / rolePrompt）。
 * - 内置岗位（type=builtin）**只读 + 无删除入口**（后端 DELETE 403 AGENT_ROLE_BUILTIN_READONLY 兜底）；
 *   自定义岗位可编辑 / 克隆 / 删除。
 * - ⚠️ 能力（权限 / 工具 / 模型 / worker）**不在本 Tab**：它们属于 Agent，挂在 Tab 1。
 *   本组件只出现身份字段 + rolePrompt 文本，绝无 permission/tools 编辑器。
 * - 数据源：todo 6 的 /api/v1/agent-roles（唯一数据路径，不另起并行来源）；
 *   默认 Agent 是**单一选择器**（issue 3/todo 7）：本平台 Agent 与引擎外部 Agent 同列，
 *   互斥写入 defaultAgentId XOR defaultOpencodeAgentName（服务端同样强制「至多一个」）。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { ConfirmDialog } from "@/src/components/ui";
import {
  agentRolesApi,
  type AgentRoleDto,
} from "@/src/api/agent-roles";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 岗位主题色（按 role key；CSS 变量驱动，light/dark 跟随 globals.css；未知 key 回退 general 中性色）。 */
const roleTheme: Record<string, { color: string; bg: string; border: string }> = {
  product: { color: "var(--color-role-product-color)", bg: "var(--color-role-product-bg)", border: "var(--color-role-product-border)" },
  project_manager: { color: "var(--color-role-project-manager-color)", bg: "var(--color-role-project-manager-bg)", border: "var(--color-role-project-manager-border)" },
  architect: { color: "var(--color-role-architect-color)", bg: "var(--color-role-architect-bg)", border: "var(--color-role-architect-border)" },
  developer: { color: "var(--color-role-developer-color)", bg: "var(--color-role-developer-bg)", border: "var(--color-role-developer-border)" },
  tester: { color: "var(--color-role-tester-color)", bg: "var(--color-role-tester-bg)", border: "var(--color-role-tester-border)" },
  plan: { color: "var(--color-role-plan-color)", bg: "var(--color-role-plan-bg)", border: "var(--color-role-plan-border)" },
  librarian: { color: "var(--color-role-librarian-color)", bg: "var(--color-role-librarian-bg)", border: "var(--color-role-librarian-border)" },
  general: { color: "var(--color-role-general-color)", bg: "var(--color-role-general-bg)", border: "var(--color-role-general-border)" },
};
const FALLBACK_THEME = roleTheme.general;

const typeTheme: Record<string, { label: string; color: string; bg: string; border: string }> = {
  builtin: { label: "内置", color: "#475569", bg: "#F1F5F9", border: "#E2E8F0" },
  custom: { label: "自定义", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
};

interface AgentOption {
  id: string;
  name: string;
  role: string | null;
}

/** GET /agents/opencode 条目（对齐服务端 WorkerAgentInfo + governed）。 */
interface OpencodeAgentEntry {
  name: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  governed: boolean;
}

interface OpencodeAgentsResponse {
  agents: OpencodeAgentEntry[];
  workerId: string | null;
  degraded: boolean;
}

type EngineState = "loading" | "ready" | "unavailable";

interface RoleDraft {
  key: string;
  name: string;
  description: string;
  defaultAgentId: string;
  defaultOpencodeAgentName: string;
  rolePrompt: string;
}

const EMPTY_DRAFT: RoleDraft = {
  key: "",
  name: "",
  description: "",
  defaultAgentId: "",
  defaultOpencodeAgentName: "",
  rolePrompt: "",
};

function draftOf(role: AgentRoleDto): RoleDraft {
  return {
    key: role.key,
    name: role.name,
    description: role.description ?? "",
    defaultAgentId: role.defaultAgentId ?? "",
    defaultOpencodeAgentName: role.defaultOpencodeAgentName ?? "",
    rolePrompt: role.rolePrompt ?? "",
  };
}

/**
 * 单一选择器 ↔ 两个互斥槽位的编码（服务端 AGENT_ROLE_DEFAULT_SLOT_CONFLICT 约束「至多一个」）：
 *   "" → 未设置（两槽位都清空）；`internal:<agentId>` → defaultAgentId；
 *   `external:<name>` → defaultOpencodeAgentName。前缀让槽位归属在 DOM 值与 data 属性上可断言。
 */
const SLOT_UNSET = "";
const INTERNAL_SLOT_PREFIX = "internal:";
const EXTERNAL_SLOT_PREFIX = "external:";

function slotValueOf(draft: RoleDraft): string {
  if (draft.defaultAgentId) return `${INTERNAL_SLOT_PREFIX}${draft.defaultAgentId}`;
  if (draft.defaultOpencodeAgentName) return `${EXTERNAL_SLOT_PREFIX}${draft.defaultOpencodeAgentName}`;
  return SLOT_UNSET;
}

function applySlotValue(value: string): Pick<RoleDraft, "defaultAgentId" | "defaultOpencodeAgentName"> {
  if (value.startsWith(INTERNAL_SLOT_PREFIX)) {
    return {
      defaultAgentId: value.slice(INTERNAL_SLOT_PREFIX.length),
      defaultOpencodeAgentName: "",
    };
  }
  if (value.startsWith(EXTERNAL_SLOT_PREFIX)) {
    return {
      defaultAgentId: "",
      defaultOpencodeAgentName: value.slice(EXTERNAL_SLOT_PREFIX.length),
    };
  }
  return { defaultAgentId: "", defaultOpencodeAgentName: "" };
}

/** 列表项文案：外部绑定必须如实显示，绝不因 defaultAgentId 为空而谎报「未设置」。 */
function describeDefaultSlot(role: AgentRoleDto): string {
  if (role.defaultAgentId) return role.defaultAgentId;
  if (role.defaultOpencodeAgentName) return `${role.defaultOpencodeAgentName}（外部）`;
  return "未设置";
}

function deriveCloneKey(source: AgentRoleDto, existing: AgentRoleDto[]): string {
  const taken = new Set(existing.map((r) => r.key));
  for (let i = 1; i < 100; i += 1) {
    const candidate = `${source.key}-copy${i > 1 ? `-${i}` : ""}`;
    if (candidate.length <= 63 && !taken.has(candidate)) return candidate;
  }
  return `${source.key.slice(0, 50)}-copy-${Date.now().toString(36)}`;
}

export function AgentRolesTab({
  canCreate,
  canEdit,
  canDelete,
}: {
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<RoleDraft>(EMPTY_DRAFT);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentRoleDto | null>(null);

  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => agentRolesApi.list({ page: 1, pageSize: 100 }),
  });
  const roles = rolesQuery.data?.items ?? [];

  const agentsQuery = useQuery({
    queryKey: ["agents", "role-default-options"],
    queryFn: () => api.get<{ items: AgentOption[] }>("/agents", { query: { page: 1, pageSize: 100 } }),
  });
  const agentOptions = useMemo(
    () => (agentsQuery.data?.items ?? []).map((a) => ({ id: a.id, name: a.name })),
    [agentsQuery.data],
  );

  // 引擎外部 Agent 清单（与 ExternalAgentsPanel 同源同过滤；workerId 缺省由服务端自动选 worker）。
  // governed/hidden 条目不是外部选项；已保存但不在清单里的名字由 foreignExternalName 兜底展示。
  const opencodeAgentsQuery = useQuery({
    queryKey: ["agents", "opencode", "role-default-options"],
    queryFn: () => api.get<OpencodeAgentsResponse>("/agents/opencode", { query: {} }),
    retry: false,
  });
  const externalAgents = useMemo(
    () => (opencodeAgentsQuery.data?.agents ?? []).filter((a) => !a.governed && !a.hidden),
    [opencodeAgentsQuery.data],
  );
  const engineState: EngineState = opencodeAgentsQuery.isPending
    ? "loading"
    : opencodeAgentsQuery.isError || (opencodeAgentsQuery.data?.degraded ?? false)
      ? "unavailable"
      : "ready";

  const selected = roles.find((r) => r.id === selectedId) ?? null;
  const isBuiltin = selected?.type === "builtin";
  const readOnly = creating ? false : isBuiltin;
  const canRemoveSelected = !!selected && !isBuiltin && canDelete;
  const canEditSelected = creating ? canCreate : !!selected && !isBuiltin && canEdit;

  // 已保存的外部名若不在本次引擎回答里（引擎降级/条目下线/加载中），仍作为选中项展示——绝不静默丢弃。
  const draftExternalName = draft.defaultOpencodeAgentName;
  const externalNameKnown = externalAgents.some((a) => a.name === draftExternalName);
  const foreignExternalName = draftExternalName !== "" && !externalNameKnown ? draftExternalName : null;
  const defaultSlotValue = slotValueOf(draft);

  useEffect(() => {
    if (!creating && !selectedId && roles.length > 0) {
      setSelectedId(roles[0].id);
    }
  }, [roles, selectedId, creating]);

  useEffect(() => {
    if (creating || !selected) return;
    setDraft(draftOf(selected));
  }, [creating, selected]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["agent-roles"] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const internal = draft.defaultAgentId || null;
      const external = draft.defaultOpencodeAgentName || null;
      if (creating) {
        const created = await agentRolesApi.create({
          name: draft.name.trim(),
          key: draft.key.trim(),
          type: "custom",
          description: draft.description.trim() || undefined,
          defaultAgentId: internal,
          defaultOpencodeAgentName: external,
          rolePrompt: draft.rolePrompt,
        });
        return created.id;
      }
      await agentRolesApi.update(selected!.id, {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        defaultAgentId: internal,
        defaultOpencodeAgentName: external,
        rolePrompt: draft.rolePrompt,
      });
      return selected!.id;
    },
    onSuccess: (id) => {
      setActionError(null);
      setCreating(false);
      setSelectedId(id);
      invalidate();
    },
    onError: (err) => {
      setActionError(
        isApiError(err)
          ? err.code === "AGENT_ROLE_KEY_CONFLICT"
            ? "该标识已被占用"
            : err.code === "AGENT_ROLE_DEFAULT_SLOT_CONFLICT"
              ? "默认 Agent 槽位冲突：内部与外部只能二选一，请重新选择后再保存"
              : err.message
          : "保存失败，请稍后重试",
      );
    },
  });

  const cloneMutation = useMutation({
    mutationFn: (source: AgentRoleDto) =>
      agentRolesApi.create({
        name: `${source.name} 副本`,
        key: deriveCloneKey(source, roles),
        type: "custom",
        description: source.description ?? undefined,
        defaultAgentId: source.defaultAgentId,
        defaultOpencodeAgentName: source.defaultOpencodeAgentName,
        rolePrompt: source.rolePrompt ?? undefined,
      }),
    onSuccess: (clone) => {
      setActionError(null);
      setCreating(false);
      setSelectedId(clone.id);
      invalidate();
    },
    onError: (err) => setActionError(isApiError(err) ? err.message : "克隆失败，请稍后重试"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => agentRolesApi.remove(id),
    onSuccess: () => {
      setActionError(null);
      setDeleteTarget(null);
      setSelectedId(null);
      invalidate();
    },
    onError: (err) => {
      setDeleteTarget(null);
      setActionError(
        isApiError(err)
          ? err.code === "AGENT_ROLE_IN_USE"
            ? "角色已被团队成员引用，请先解绑成员再删除"
            : err.message
          : "删除失败，请稍后重试",
      );
    },
  });

  const beginCreate = () => {
    setActionError(null);
    setCreating(true);
    setSelectedId(null);
    setDraft(EMPTY_DRAFT);
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: readOnly ? neutral[50] : "var(--color-surface)",
    fontSize: fontSize.md,
    color: neutral[800],
    fontFamily: fontFamily.body,
  };
  const labelStyle: CSSProperties = {
    fontSize: fontSize.sm,
    fontWeight: 500,
    color: neutral[600],
    marginBottom: space.xs,
  };

  return (
    <div
      data-testid="agent-role-root"
      style={{ display: "flex", gap: space.xl, alignItems: "flex-start", ...baseFont }}
    >
      <div style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column", gap: space.sm }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `0 ${space.xs}px` }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>
            岗位列表
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            {rolesQuery.isPending ? "…" : `${roles.length} 个`}
          </span>
        </div>

        {canCreate && (
          <button
            type="button"
            data-testid="role-create-button"
            onClick={beginCreate}
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
            ＋ 新建角色
          </button>
        )}

        {rolesQuery.isPending ? (
          <div data-testid="agent-roles-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}>
            加载中…
          </div>
        ) : rolesQuery.isError ? (
          <div data-testid="agent-roles-error" role="alert" style={{ display: "flex", flexDirection: "column", gap: space.md }}>
            <span style={{ fontSize: fontSize.md, color: "#DC2626" }}>
              {isApiError(rolesQuery.error) ? rolesQuery.error.message : "加载角色列表失败"}
            </span>
            <button
              type="button"
              data-testid="agent-roles-retry"
              onClick={() => rolesQuery.refetch()}
              style={{
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "var(--color-surface)",
                color: neutral[600],
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              重试
            </button>
          </div>
        ) : (
          roles.map((role) => {
            const active = !creating && role.id === selectedId;
            const theme = roleTheme[role.key] ?? FALLBACK_THEME;
            const tt = typeTheme[role.type] ?? typeTheme.custom;
            return (
              <button
                key={role.id}
                type="button"
                data-testid="role-item"
                data-role-key={role.key}
                data-role-type={role.type}
                data-active={active ? "true" : "false"}
                onClick={() => {
                  setCreating(false);
                  setSelectedId(role.id);
                }}
                style={{
                  width: "100%",
                  textAlign: "left",
                  cursor: "pointer",
                  border: `1px solid ${active ? theme.border : neutral[200]}`,
                  borderRadius: radius.lg,
                  backgroundColor: active ? theme.bg : "var(--color-surface)",
                  boxShadow: active ? shadow.sm : "none",
                  padding: space.md,
                  display: "flex",
                  gap: space.md,
                  fontFamily: fontFamily.body,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 34,
                    height: 34,
                    flexShrink: 0,
                    borderRadius: radius.md,
                    backgroundColor: theme.bg,
                    border: `1.5px solid ${theme.border}`,
                    color: theme.color,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: fontSize.lg,
                    fontWeight: 700,
                  }}
                >
                  {role.name.charAt(0)}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: space.xs }}>
                    <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
                      {role.name}
                    </span>
                    <span
                      data-testid="role-type-badge"
                      data-role-type={role.type}
                      style={{
                        fontSize: fontSize.xs,
                        fontWeight: 600,
                        color: tt.color,
                        backgroundColor: tt.bg,
                        border: `1px solid ${tt.border}`,
                        borderRadius: radius.pill,
                        padding: "1px 7px",
                      }}
                    >
                      {tt.label}
                    </span>
                  </span>
                  <span style={{ display: "block", fontSize: fontSize.sm, color: neutral[500], marginTop: 2 }}>
                    {role.description || "无描述"}
                  </span>
                  <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], marginTop: space.xs }}>
                    默认 Agent：{describeDefaultSlot(role)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>

      <section
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          padding: space.xl,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.sm,
        }}
      >
        {!creating && !selected ? (
          <div data-testid="role-detail-empty" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xxl}px 0`, textAlign: "center" }}>
            {rolesQuery.isPending ? "加载中…" : "请选择左侧角色查看详情"}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
              <span style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900] }}>
                {creating ? "新建角色" : selected!.name}
              </span>
              {!creating && (
                <span
                  data-testid="role-detail-type-badge"
                  data-role-type={selected!.type}
                  style={{
                    fontSize: fontSize.xs,
                    fontWeight: 600,
                    color: (typeTheme[selected!.type] ?? typeTheme.custom).color,
                    backgroundColor: (typeTheme[selected!.type] ?? typeTheme.custom).bg,
                    border: `1px solid ${(typeTheme[selected!.type] ?? typeTheme.custom).border}`,
                    borderRadius: radius.pill,
                    padding: "2px 8px",
                  }}
                >
                  {(typeTheme[selected!.type] ?? typeTheme.custom).label}
                </span>
              )}
              <span style={{ marginLeft: "auto", display: "flex", gap: space.sm }}>
                {!creating && !isBuiltin && canCreate && (
                  <button
                    type="button"
                    data-testid="role-clone-button"
                    onClick={() => cloneMutation.mutate(selected!)}
                    disabled={cloneMutation.isPending}
                    style={{
                      padding: `${space.sm}px ${space.lg}px`,
                      borderRadius: radius.md,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: "var(--color-surface)",
                      color: neutral[600],
                      fontSize: fontSize.sm,
                      cursor: cloneMutation.isPending ? "default" : "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    克隆
                  </button>
                )}
                {!creating && canRemoveSelected && (
                  <button
                    type="button"
                    data-testid="role-delete-button"
                    onClick={() => setDeleteTarget(selected!)}
                    style={{
                      padding: `${space.sm}px ${space.lg}px`,
                      borderRadius: radius.md,
                      border: "1px solid rgba(239,68,68,0.28)",
                      backgroundColor: "rgba(239,68,68,0.08)",
                      color: "#DC2626",
                      fontSize: fontSize.sm,
                      cursor: "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    删除
                  </button>
                )}
              </span>
            </div>

            {isBuiltin && (
              <div
                data-testid="role-builtin-notice"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.xs,
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: radius.md,
                  backgroundColor: neutral[50],
                  border: `1px solid ${neutral[200]}`,
                  fontSize: fontSize.sm,
                  color: neutral[500],
                }}
              >
                <span aria-hidden style={{ fontWeight: 700 }}>i</span>
                内置角色只读，不可编辑或删除。
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column" }}>
              <label htmlFor="role-key" style={labelStyle}>标识（key）</label>
              <input
                id="role-key"
                data-testid="role-key-input"
                value={draft.key}
                readOnly={!creating}
                disabled={!creating || saveMutation.isPending}
                onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
                spellCheck={false}
                style={{ ...inputStyle, fontFamily: fontFamily.mono }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column" }}>
              <label htmlFor="role-name" style={labelStyle}>名称</label>
              <input
                id="role-name"
                data-testid="role-name-input"
                value={draft.name}
                readOnly={readOnly}
                disabled={readOnly || saveMutation.isPending}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                style={inputStyle}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column" }}>
              <label htmlFor="role-description" style={labelStyle}>描述</label>
              <input
                id="role-description"
                data-testid="role-description-input"
                value={draft.description}
                readOnly={readOnly}
                disabled={readOnly || saveMutation.isPending}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                style={inputStyle}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column" }}>
              <label htmlFor="role-default-agent" style={labelStyle}>默认 Agent</label>
              <select
                id="role-default-agent"
                data-testid="role-default-agent"
                data-slot={defaultSlotValue === SLOT_UNSET ? "unset" : defaultSlotValue.startsWith(INTERNAL_SLOT_PREFIX) ? "internal" : "external"}
                value={defaultSlotValue}
                disabled={readOnly || agentsQuery.isPending}
                onChange={(e) => setDraft((d) => ({ ...d, ...applySlotValue(e.target.value) }))}
                style={inputStyle}
              >
                <option value="">未设置</option>
                {foreignExternalName && (
                  <option value={`${EXTERNAL_SLOT_PREFIX}${foreignExternalName}`}>
                    {foreignExternalName}
                    {engineState === "ready"
                      ? "（引擎未上报）"
                      : engineState === "loading"
                        ? "（引擎列表加载中）"
                        : "（引擎列表不可用）"}
                  </option>
                )}
                <optgroup label="本平台 Agent">
                  {agentOptions.map((a) => (
                    <option key={a.id} value={`${INTERNAL_SLOT_PREFIX}${a.id}`}>{a.name}（{a.id}）</option>
                  ))}
                </optgroup>
                <optgroup label="外部 Agent（引擎原生）">
                  {externalAgents.map((a) => (
                    <option key={a.name} value={`${EXTERNAL_SLOT_PREFIX}${a.name}`}>{a.name}</option>
                  ))}
                </optgroup>
              </select>
              <span
                data-testid="role-default-agent-note"
                style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5, marginTop: space.xs }}
              >
                {engineState === "ready"
                  ? `${externalAgents.length} 个外部 Agent（引擎上报，不含 vteam 策略 Agent）；内部与外部只能选一个`
                  : engineState === "loading"
                    ? "引擎 Agent 列表加载中…（已保存的外部选择仍保留）"
                    : "引擎 Agent 列表不可用（worker 离线或版本不支持），当前仅显示已保存的选择。"}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column" }}>
              <label htmlFor="role-prompt" style={labelStyle}>岗位职责提示词</label>
              <textarea
                id="role-prompt"
                data-testid="role-prompt"
                rows={10}
                value={draft.rolePrompt}
                readOnly={readOnly}
                disabled={readOnly || saveMutation.isPending}
                onChange={(e) => setDraft((d) => ({ ...d, rolePrompt: e.target.value }))}
                placeholder="这个岗位是什么（职责与边界）；「怎么工作 / 能做什么」属于 Agent，不在此处"
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }}
              />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
              <span
                style={{
                  fontSize: fontSize.xs,
                  color: neutral[400],
                  lineHeight: 1.5,
                  flex: 1,
                }}
              >
                能力（权限 / 工具 / 模型）属于 Agent，请到 Agent Tab 配置；岗位只定义「这是一个什么岗位」。
              </span>
              {!creating && !isBuiltin && canEditSelected && (
                <button
                  type="button"
                  data-testid="role-save-button"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || !draft.name.trim()}
                  style={{
                    padding: `${space.sm}px ${space.lg}px`,
                    borderRadius: radius.md,
                    border: "none",
                    backgroundColor: "#0D9488",
                    color: "#FFFFFF",
                    fontSize: fontSize.md,
                    fontWeight: 500,
                    cursor: saveMutation.isPending ? "default" : "pointer",
                    opacity: saveMutation.isPending || !draft.name.trim() ? 0.6 : 1,
                    fontFamily: fontFamily.body,
                  }}
                >
                  {saveMutation.isPending ? "保存中…" : "保存"}
                </button>
              )}
              {creating && (
                <button
                  type="button"
                  data-testid="role-save-button"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || !draft.name.trim() || !draft.key.trim()}
                  style={{
                    padding: `${space.sm}px ${space.lg}px`,
                    borderRadius: radius.md,
                    border: "none",
                    backgroundColor: "#0D9488",
                    color: "#FFFFFF",
                    fontSize: fontSize.md,
                    fontWeight: 500,
                    cursor: saveMutation.isPending ? "default" : "pointer",
                    opacity: saveMutation.isPending || !draft.name.trim() || !draft.key.trim() ? 0.6 : 1,
                    fontFamily: fontFamily.body,
                  }}
                >
                  {saveMutation.isPending ? "创建中…" : "创建"}
                </button>
              )}
            </div>

            {actionError && (
              <div data-testid="role-action-error" role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626" }}>
                {actionError}
              </div>
            )}
          </>
        )}
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除角色"
        description={deleteTarget ? `确定删除自定义角色「${deleteTarget.name}」？删除后不可恢复。` : undefined}
        confirmLabel="确认删除"
        pendingLabel="删除中…"
        submitting={deleteMutation.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}
