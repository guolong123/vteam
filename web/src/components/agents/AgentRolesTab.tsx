"use client";

/**
 * AgentRole 岗位 Tab（agent-role-entity todo 7，挂载于 /agents 的 Tab 2「角色」）
 * =============================================
 * 唯一来源：docs/agent-platform/prototypes/agent-role/index.tsx（布局/文案/data-testid 对齐）。
 * - 左栏：岗位列表（7 内置 + 自定义），显示岗位名 / 内置-自定义徽章 / 默认 Agent /
 *   平台能力点摘要 / 职责摘要。
 * - 右栏：岗位详情编辑表单（name / description / 默认 Agent / 平台能力点 / rolePrompt）。
 * - 平台 `vteam_* MCP` 工具的调用授权归**岗位的业务能力点**（`capabilities`：
 *   `{ 能力点 key: boolean }`；false=拒绝、缺失=允许、null=未保存按出厂默认展示），
 *   由 RoleCapabilityEditor 直接编辑（分组 / 中文名 / 覆盖工具 / 二进制允许-拒绝）。
 * - 内置岗位（type=builtin）：身份字段只读 + 无删除入口（后端 DELETE 403
 *   AGENT_ROLE_BUILTIN_READONLY 兜底），但**能力点字段可编辑**（服务端仅放宽该字段，
 *   PATCH 只携带 capabilities）；自定义岗位可编辑 / 克隆 / 删除。
 * - ⚠️ 能力**载荷**（permission / tools / model / worker）仍不在本 Tab：它们属于 Agent，
 *   挂在 Tab 1（引擎原生权限）。本组件绝无 permission/tools 编辑器。
 * - 数据源：/api/v1/agent-roles（唯一数据路径，不另起并行来源）；
 *   默认 Agent 是**单一选择器**（issue 3/todo 7）：本平台 Agent 与引擎外部 Agent 同列，
 *   默认 Agent 只有 defaultAgentId 一个槽位（外部引擎名槽位已随该功能下线移除）。
 *   能力点目录（key / 中文名 / 覆盖工具）见 `src/api/role-capabilities.ts`。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { ConfirmDialog } from "@/src/components/ui";
import { agentRolesApi, type AgentRoleDto } from "@/src/api/agent-roles";
import {
  factoryCapabilityMap,
  normalizeCapabilities,
  summarizeCapabilities,
} from "@/src/api/role-capabilities";
import { RoleCapabilityEditor } from "@/src/components/agents/RoleCapabilityEditor";
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

interface RoleDraft {
  key: string;
  name: string;
  description: string;
  defaultAgentId: string;
  /** 完整能力点 map（目录键恒在 + 目录外键保留）；保存时整份提交（自描述）。 */
  capabilities: Record<string, boolean>;
  /** true = 服务端 `capabilities === null`（从未保存）→ 当前 map 为出厂默认。 */
  capabilitiesFromFactory: boolean;
  rolePrompt: string;
  /** 纪律固定提示：前置到 user 消息周期性重复注入的正文；空串 = 关闭。 */
  disciplinePrompt: string;
  /** 注入频率：0=关闭；1=每条；N≥2=每 N 条用户消息一次。 */
  disciplineEvery: number;
}

const EMPTY_DRAFT: RoleDraft = {
  key: "",
  name: "",
  description: "",
  defaultAgentId: "",
  capabilities: factoryCapabilityMap(),
  capabilitiesFromFactory: true,
  rolePrompt: "",
  disciplinePrompt: "",
  disciplineEvery: 3,
};

function draftOf(role: AgentRoleDto): RoleDraft {
  const caps = normalizeCapabilities(role.capabilities);
  return {
    key: role.key,
    name: role.name,
    description: role.description ?? "",
    defaultAgentId: role.defaultAgentId ?? "",
    capabilities: caps.map,
    capabilitiesFromFactory: caps.fromFactory,
    rolePrompt: role.rolePrompt ?? "",
    disciplinePrompt: role.disciplinePrompt ?? "",
    disciplineEvery: role.disciplineEvery ?? 3,
  };
}

/** 默认 Agent 选择器取值：空串 = 未设置，否则为平台 Agent id。 */
const SLOT_UNSET = "";

/**
 * 选择器取值 → draft（仅需写 defaultAgentId，不存在第二个槽位）。
 */
function applySlotValue(value: string): Pick<RoleDraft, "defaultAgentId"> {
  return { defaultAgentId: value };
}

/** 列表项文案：未绑定默认 Agent 时如实显示「未设置」。 */
function describeDefaultSlot(role: AgentRoleDto): string {
  return role.defaultAgentId || "未设置";
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

  const selected = roles.find((r) => r.id === selectedId) ?? null;
  const isBuiltin = selected?.type === "builtin";
  const readOnly = creating ? false : isBuiltin;
  const canRemoveSelected = !!selected && !isBuiltin && canDelete;
  const canEditSelected = creating ? canCreate : !!selected && !isBuiltin && canEdit;
  // 能力点独立于身份只读：内置岗位也可改能力点（服务端仅放宽该字段）；权限判据为 agents:edit。
  const capabilitiesReadOnly = creating ? !canCreate : !canEdit;
  const canSaveCapabilities = creating ? canCreate : !!selected && canEdit;

  const defaultSlotValue = draft.defaultAgentId || SLOT_UNSET;

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
      // 能力点整份提交（目录键恒在 + 目录外键保留）：存储值自描述，前端不依赖「缺失=允许」推断。
      const capabilities = draft.capabilities;
      if (creating) {
        const created = await agentRolesApi.create({
          name: draft.name.trim(),
          key: draft.key.trim(),
          type: "custom",
          description: draft.description.trim() || undefined,
          defaultAgentId: internal,
          capabilities,
          rolePrompt: draft.rolePrompt,
          disciplinePrompt: draft.disciplinePrompt.trim() || null,
          disciplineEvery: draft.disciplineEvery,
        });
        return created.id;
      }
      if (isBuiltin) {
        // 内置岗位：身份字段（key/name/…）只读；能力点与纪律固定提示可写
        // （服务端 PATCH 已放宽 rolePrompt / discipline*，仅 key 禁止改）。
        await agentRolesApi.update(selected!.id, {
          capabilities,
          disciplinePrompt: draft.disciplinePrompt.trim() || null,
          disciplineEvery: draft.disciplineEvery,
        });
        return selected!.id;
      }
      await agentRolesApi.update(selected!.id, {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        defaultAgentId: internal,
        capabilities,
        rolePrompt: draft.rolePrompt,
        disciplinePrompt: draft.disciplinePrompt.trim() || null,
        disciplineEvery: draft.disciplineEvery,
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
        // 克隆沿用来源岗位的**生效**能力点（含 null→出厂默认的情况），存储值自描述。
        capabilities: normalizeCapabilities(source.capabilities).map,
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
            <span style={{ fontSize: fontSize.md, color: "var(--color-danger-text)" }}>
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
                  <span
                    data-testid="role-item-capabilities"
                    data-source={normalizeCapabilities(role.capabilities).fromFactory ? "factory-default" : "stored"}
                    style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}
                  >
                    {(() => {
                      const caps = normalizeCapabilities(role.capabilities);
                      const { allowed, denied } = summarizeCapabilities(caps.map);
                      return `权限点：${allowed} 允许 / ${denied} 拒绝${caps.fromFactory ? "（出厂默认）" : ""}`;
                    })()}
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
                      color: "var(--color-danger-text)",
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
                内置角色：身份字段只读、不可删除；平台能力点可调整。
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
                data-slot={defaultSlotValue === SLOT_UNSET ? "unset" : "internal"}
                value={defaultSlotValue}
                disabled={readOnly || agentsQuery.isPending}
                onChange={(e) => setDraft((d) => ({ ...d, ...applySlotValue(e.target.value) }))}
                style={inputStyle}
              >
                <option value="">未设置</option>
                {agentOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}（{a.id}）</option>
                ))}
              </select>
              <span
                data-testid="role-default-agent-note"
                style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5, marginTop: space.xs }}
              >
                只选本平台 Agent：执行身份与权限由平台 Agent + 岗位能力点共同决定。
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={labelStyle}>平台能力点</span>
              <RoleCapabilityEditor
                value={draft.capabilities}
                fromFactory={draft.capabilitiesFromFactory}
                creating={creating}
                readOnly={capabilitiesReadOnly}
                pending={saveMutation.isPending}
                onChange={(key, allowed) =>
                  setDraft((d) => ({
                    ...d,
                    capabilities: { ...d.capabilities, [key]: allowed },
                    capabilitiesFromFactory: false,
                  }))
                }
              />
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

            <div style={{ display: "flex", flexDirection: "column" }}>
              <label htmlFor="role-discipline-prompt" style={labelStyle}>纪律固定提示（周期性强调，对抗遗忘）</label>
              <textarea
                id="role-discipline-prompt"
                data-testid="role-discipline-prompt"
                rows={4}
                value={draft.disciplinePrompt}
                disabled={saveMutation.isPending || !(creating || canSaveCapabilities)}
                onChange={(e) => setDraft((d) => ({ ...d, disciplinePrompt: e.target.value }))}
                placeholder={"例：任何请求先判定产出归属；归其他岗位就立刻派发，不自己下场产出内容。"}
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.xs }}>
                <label htmlFor="role-discipline-every" style={{ fontSize: fontSize.xs, color: neutral[500] }}>注入频率</label>
                <select
                  id="role-discipline-every"
                  data-testid="role-discipline-every"
                  value={draft.disciplineEvery}
                  disabled={saveMutation.isPending || !(creating || canSaveCapabilities)}
                  onChange={(e) => setDraft((d) => ({ ...d, disciplineEvery: Number(e.target.value) }))}
                  style={{ ...inputStyle, width: "auto", padding: `${space.xs}px ${space.sm}px` }}
                >
                  <option value={0}>关闭</option>
                  <option value={1}>每条用户消息</option>
                  <option value={2}>每 2 条</option>
                  <option value={3}>每 3 条</option>
                  <option value={5}>每 5 条</option>
                  <option value={10}>每 10 条</option>
                </select>
                <span style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5 }}>
                  只算真实用户消息，Agent 互派不计数；提示只前置到模型看到的消息，群里不可见。
                </span>
              </div>
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
                平台能力点（上方）决定本岗位成员调用平台工具（vteam_* MCP）的权限：缺省允许，
                出厂预设拒绝的敏感点以「拒绝」档位显示，放开需手动切换；引擎原生权限（edit/read/bash/task）、
                模型与技能属于 Agent，请到 Agent Tab 配置。
              </span>
              {!creating && !isBuiltin && canEditSelected && (
                <button
                  type="button"
                  data-testid="role-save-button"
                  data-scope="role"
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
              {!creating && isBuiltin && canSaveCapabilities && (
                <button
                  type="button"
                  data-testid="role-save-button"
                  data-scope="capabilities"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  style={{
                    padding: `${space.sm}px ${space.lg}px`,
                    borderRadius: radius.md,
                    border: "none",
                    backgroundColor: "#0D9488",
                    color: "#FFFFFF",
                    fontSize: fontSize.md,
                    fontWeight: 500,
                    cursor: saveMutation.isPending ? "default" : "pointer",
                    opacity: saveMutation.isPending ? 0.6 : 1,
                    fontFamily: fontFamily.body,
                  }}
                >
                  {saveMutation.isPending ? "保存中…" : "保存配置"}
                </button>
              )}
              {creating && (
                <button
                  type="button"
                  data-testid="role-save-button"
                  data-scope="create"
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
              <div data-testid="role-action-error" role="alert" style={{ fontSize: fontSize.sm, color: "var(--color-danger-text)" }}>
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
