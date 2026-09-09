"use client";

/**
 * 团队成员面板（共享）：任务详情页 / 团队会话页复用。
 * 成员列表 + 状态 + model chip + 更多菜单（启用禁用/重置会话/设模型）+ 添加实例。
 * onSelectMember 提供时成员行可点击（团队会话私聊入口），缺省纯展示。
 */
import React, { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AgentAvatar } from "@/src/components/ui";
import {
  type RoleKey,
  neutral,
  roles,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** seed 模板 Agent id → 角色 key。 */
const AGENT_ID_ROLE: Record<string, RoleKey> = {
  a_product: "product",
  a_project_manager: "project_manager",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};

const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];

/** seed 模板 Agent 角色 → id 兜底。 */
const ROLE_AGENT_ID: Record<RoleKey, string> = {
  product: "a_product",
  project_manager: "a_project_manager",
  architect: "a_architect",
  developer: "a_developer",
  tester: "a_tester",
};

/** 自定义 agent 中性主题（teal）。 */
const CUSTOM_THEME = { color: "#0D9488", bg: "#F0FDFA", border: "#99F6E4", label: "自定义" };

/** 角色选择项。 */
export interface AgentOption {
  id: string;
  role: RoleKey;
}

/** GET /agents 响应条目。 */
export interface AgentItem {
  id: string;
  name: string;
  role: string;
  type: string;
  prompt: string | null;
}

/** 自定义/clone agent（type !== template）→ 添加实例可选。 */
export function customAgentsOf(items: AgentItem[]): AgentItem[] {
  return items.filter((a) => a.type !== "template");
}

/** GET /agents 结果 → 角色选择项。 */
export function roleOptionsOf(items: AgentItem[]): AgentOption[] {
  const byRole = new Map<RoleKey, AgentItem>();
  for (const a of items) {
    const role = a.role && (ROLE_KEYS as readonly string[]).includes(a.role)
      ? (a.role as RoleKey)
      : toRole(a.id);
    if (role && !byRole.has(role)) byRole.set(role, a);
  }
  return ROLE_KEYS.flatMap((role) => {
    const item = byRole.get(role);
    return item ? [{ id: item.id, role }] : [];
  });
}

/** 角色 → 模板 agent id。 */
export function agentIdForRole(role: RoleKey, options: AgentOption[]): string {
  return options.find((o) => o.role === role)?.id ?? ROLE_AGENT_ID[role];
}

/** agent id / role 字符串 → RoleKey。 */
export function toRole(agentId: string): RoleKey | null {
  const direct = AGENT_ID_ROLE[agentId];
  if (direct) return direct;
  const rest = agentId.startsWith("a_") ? agentId.slice(2) : agentId;
  if ((ROLE_KEYS as readonly string[]).includes(rest)) return rest as RoleKey;
  return null;
}

/* ================================ 成员面板（224px，T5 按实例展示） ================================ */
export function TeamMembersPanel({
  agents,
  loadingAgentIds,
  sessionStatusByAgent,
  teamEditable,
  agentOptions,
  customAgents,
  adding,
  addError,
  onAddInstance,
  width,
  onToggleEnabled,
  onResetSession,
  onChangeModel,
  onSetMainAgent,
  onSelectMember,
  selectedKey,
  footerText,
}: {
  agents: { id: string; instanceId?: string; name: string; role: RoleKey; seq?: number; main?: boolean; enabled?: boolean | null; overrideModelId?: string | null }[];
  loadingAgentIds: Set<string>;
  sessionStatusByAgent: Record<string, string>;
  teamEditable: boolean;
  agentOptions: AgentOption[];
  customAgents: AgentItem[];
  adding: boolean;
  addError: string | null;
  onAddInstance: (agentId: string, alias?: string) => Promise<boolean>;
  width?: number;
  onToggleEnabled?: (instanceId: string, enabled: boolean) => void;
  onResetSession?: (instanceId: string) => void;
  onChangeModel?: (instanceId: string, modelId: string | null) => void;
  onSetMainAgent?: (memberId: string) => void;
  onSelectMember?: (instanceId: string, agentId: string) => void;
  selectedKey?: string | null;
  footerText?: string;
}) {
  const [addOpen, setAddOpen] = useState(false);
  /** 选中项：内置角色 RoleKey 或自定义 agent id（is_0000000035）。 */
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [alias, setAlias] = useState("");
  /** 选中主题：内置角色主题；自定义 agent 用中性 CUSTOM_THEME（别名占位提示 agent 名）。 */
  const selectedCustom = customAgents.find((a) => a.id === selectedRole);
  const theme = selectedCustom
    ? { ...CUSTOM_THEME, label: selectedCustom.name }
    : selectedRole
      ? (roles[selectedRole as RoleKey] ?? roles.developer)
      : null;

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [modelPicker, setModelPicker] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");

  useEffect(() => {
    if (!openMenu && !modelPicker) return;
    const h = () => { setOpenMenu(null); setModelPicker(null); };
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [openMenu, modelPicker]);

  // 模型选择：与 Agent 配置同源（GET /agents/:id/available-models，仅可用模型；
  // 目录 enabled + worker 在线可用 + 凭据齐全，空目录时 worker pull/静态兜底）
  const pickerAgentId = modelPicker
    ? agents.find((a) => (a.instanceId ?? a.id) === modelPicker)?.id ?? null
    : null;
  const modelsQuery = useQuery({
    queryKey: ["models", "available", pickerAgentId],
    queryFn: () =>
      api.get<{ id: string; name: string }[] | { models: { id: string; name: string }[]; source?: string }>(
        `/agents/${pickerAgentId}/available-models`,
      ),
    enabled: !!modelPicker && !!pickerAgentId,
    retry: false,
  });
  const modelsData = modelsQuery.data;
  const allModels: { id: string; name: string }[] = Array.isArray(modelsData)
    ? modelsData
    : (modelsData?.models ?? []);

  // 模板默认模型：成员未单独设模型时 chip 显示模板实际生效模型（GET /agents，与添加页同 key 共享缓存）
  const agentsDirQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<{ items: { id: string; defaultModelId?: string | null }[] }>("/agents"),
    retry: false,
  });
  const templateModelByAgent = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of agentsDirQuery.data?.items ?? []) {
      if (item.defaultModelId) map.set(item.id, item.defaultModelId);
    }
    return map;
  }, [agentsDirQuery.data]);

  const openPanel = () => {
    if (!teamEditable || adding) return;
    setSelectedRole(null);
    setAlias("");
    setAddOpen(true);
  };
  const closePanel = () => {
    if (adding) return;
    setAddOpen(false);
  };
  const confirmAdd = async () => {
    if (!selectedRole || adding) return;
    // 内置角色 → 模板 agent id；自定义 agent id 直用
    const agentId = (ROLE_KEYS as readonly string[]).includes(selectedRole)
      ? agentIdForRole(selectedRole as RoleKey, agentOptions)
      : selectedRole;
    const ok = await onAddInstance(agentId, alias.trim() || undefined);
    if (ok) {
      setAddOpen(false);
      setSelectedRole(null);
      setAlias("");
    }
  };

  return (
    <aside
      data-testid="members-panel"
      style={{
        width: width ?? 224,
        flexShrink: 0,
        borderRight: `1px solid ${neutral[200]}`,
        backgroundColor: neutral[50],
        display: "flex",
        flexDirection: "column",
        ...baseFont,
      }}
    >
      <div
        style={{
          padding: `${space.lg}px ${space.md}px`,
          fontSize: fontSize.sm,
          fontWeight: 600,
          color: neutral[500],
          letterSpacing: "0.02em",
        }}
      >
        任务成员 · {agents.length}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: space.xs, padding: `0 ${space.sm}px ${space.md}px` }}>
        {agents.map((a) => {
          // T6 实例语义：loading/starting 状态按实例 key 匹配（同 agent 多实例各自 loading），
          // 会话运行状态保留 agentId 维度（session.updated 事件无实例 id，旧协议）
          const processing = loadingAgentIds.has(a.instanceId ?? a.id) || loadingAgentIds.has(a.id);
          const sessionStatus =
            sessionStatusByAgent[a.instanceId ?? a.id] ?? sessionStatusByAgent[a.id];
          const working = sessionStatus === "running";
          const idle = sessionStatus === "idle";
          const statusText = processing
              ? "处理中"
              : working
                ? "工作中"
                : idle
                  ? "空闲"
                  : "就绪";
          // 实际生效模型：实例覆盖优先，否则模板默认；都没有才回退"跟随模板"
          const effectiveModel = a.overrideModelId ?? templateModelByAgent.get(a.id) ?? null;
          return (
            <React.Fragment key={a.instanceId ?? a.id}>
              <div
                data-testid="member-item"
              data-role={a.role}
              data-main={a.main ? "true" : "false"}
              role={onSelectMember ? "button" : undefined} tabIndex={onSelectMember && a.enabled !== false ? 0 : undefined} title={a.enabled === false ? `${a.name} 已禁用` : onSelectMember ? `与 ${a.name} 发起私聊` : a.name}
              aria-disabled={a.enabled === false}
              onClick={onSelectMember ? () => { if (a.enabled === false) return; onSelectMember(a.instanceId ?? a.id, a.id); } : undefined}
              onKeyDown={onSelectMember ? (e) => { if (a.enabled === false) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectMember(a.instanceId ?? a.id, a.id); } } : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.sm}px ${space.sm}px`,
                borderRadius: radius.md,
                border: a.main ? `1px solid ${roles[a.role]?.border ?? neutral[200]}` : "none",
                background: selectedKey === (a.instanceId ?? a.id) || working || a.main ? neutral[100] : a.enabled === false ? neutral[50] : "transparent",
                textAlign: "left",
                fontFamily: fontFamily.body,
                cursor: onSelectMember && a.enabled !== false ? "pointer" : "default",
                opacity: a.enabled === false ? 0.5 : 1,
                transition: "background-color .15s ease, opacity .15s ease",
              }}
              onMouseEnter={(e) => {
                if (!working) e.currentTarget.style.backgroundColor = neutral[100];
              }}
              onMouseLeave={(e) => {
                if (!working) e.currentTarget.style.backgroundColor = a.main ? neutral[100] : "transparent";
              }}
              >
              <AgentAvatar role={a.role} size="sm" />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: fontSize.md,
                    color: neutral[800],
                    fontWeight: 500,
                    lineHeight: 1.3,
                  }}
                >
                  {a.name}
                  {/* 主 Agent 徽章：挂在实例上（非角色），对齐创建页 ★ 主 Agent 视觉 */}
                  {a.main && (
                    <span
                      data-testid="main-badge"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 2,
                        marginLeft: space.xs,
                        padding: "1px 6px",
                        borderRadius: radius.pill,
                        backgroundColor: "#F59E0B",
                        color: "#FFFFFF",
                        fontSize: fontSize.xs,
                        fontWeight: 700,
                        lineHeight: "15px",
                        verticalAlign: "1px",
                      }}
                    >
                      ★ 主 Agent
                    </span>
                  )}
                </span>
                <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.4 }}>
                  {typeof a.seq === "number" && `#${a.seq} · `}
                  {processing && (
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        backgroundColor: "#0D9488",
                        marginRight: space.xs - 1,
                        animation: "groupchat-pulse 1.2s ease-in-out infinite",
                      }}
                    />
                  )}
                  {working && (
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        border: "2px solid rgba(13,148,136,0.22)",
                        borderTopColor: "#0D9488",
                        marginRight: space.xs,
                        verticalAlign: "-2px",
                        animation: "groupchat-spin .8s linear infinite",
                      }}
                    />
                  )}
                  {idle && (
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        backgroundColor: neutral[400],
                        marginRight: space.xs - 1,
                      }}
                    />
                  )}
                  {statusText}
                </span>
                <button
                  type="button"
                  data-testid={`agent-model-chip-${a.instanceId ?? a.id}`}
                  aria-label="设置模型"
                  onClick={(e) => {
                    e.stopPropagation();
                    setModelPicker(modelPicker === (a.instanceId ?? a.id) ? null : (a.instanceId ?? a.id));
                    setOpenMenu(null);
                  }}
                  title={effectiveModel || "跟随模板（点击设置模型）"}
                  style={{
                    marginTop: 4,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "1px 6px",
                    borderRadius: radius.pill,
                    border: a.overrideModelId ? `1px solid rgba(13,148,136,0.35)` : `1px dashed ${neutral[300]}`,
                    backgroundColor: a.overrideModelId ? "rgba(13,148,136,0.12)" : "transparent",
                    color: a.overrideModelId ? "#0D9488" : neutral[500],
                    fontSize: 10,
                    maxWidth: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {effectiveModel ? String(effectiveModel).split("/").pop() : "跟随模板"}
                  </span>
                  <span style={{ fontSize: 8 }}>▼</span>
                </button>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, position: "relative" }}>
                <button
                  type="button"
                  data-testid={`agent-more-${a.instanceId ?? a.id}`}
                  aria-label="更多"
                  title="更多操作"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenu(openMenu === (a.instanceId ?? a.id) ? null : (a.instanceId ?? a.id));
                    setModelPicker(null);
                  }}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: radius.md,
                    border: "1px solid transparent",
                    backgroundColor: openMenu === (a.instanceId ?? a.id) ? neutral[100] : "transparent",
                    color: neutral[500],
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 14,
                  }}
                >
                  ⋯
                </button>
                {openMenu === (a.instanceId ?? a.id) && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: "absolute",
                      right: 0,
                      top: 28,
                      zIndex: 20,
                      minWidth: 160,
                      backgroundColor: "var(--color-surface)",
                      border: `1px solid ${neutral[200]}`,
                      borderRadius: radius.md,
                      boxShadow: shadow.lg,
                      padding: 4,
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    {onSetMainAgent && !a.main && (
                    <button
                      type="button"
                      data-testid={`agent-set-main-${a.instanceId ?? a.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSetMainAgent?.(a.instanceId ?? a.id);
                        setOpenMenu(null);
                      }}
                      style={{
                        textAlign: "left",
                        padding: `6px 8px`,
                        borderRadius: radius.sm,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        fontSize: fontSize.sm,
                        color: neutral[700],
                        fontWeight: 600,
                      }}
                    >
                      ★ 设为主 Agent
                    </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleEnabled?.(a.instanceId ?? a.id, a.enabled === false ? true : false);
                        setOpenMenu(null);
                      }}
                      style={{
                        textAlign: "left",
                        padding: `6px 8px`,
                        borderRadius: radius.sm,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        fontSize: fontSize.sm,
                        color: neutral[700],
                      }}
                    >
                      {a.enabled === false ? "启用" : "禁用"}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onResetSession?.(a.instanceId ?? a.id);
                        setOpenMenu(null);
                      }}
                      style={{
                        textAlign: "left",
                        padding: `6px 8px`,
                        borderRadius: radius.sm,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        fontSize: fontSize.sm,
                        color: neutral[700],
                      }}
                    >
                      重置会话
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setModelPicker(a.instanceId ?? a.id);
                        setOpenMenu(null);
                      }}
                      style={{
                        textAlign: "left",
                        padding: `6px 8px`,
                        borderRadius: radius.sm,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        fontSize: fontSize.sm,
                        color: "#0D9488",
                      }}
                    >
                      模型设置…
                    </button>
                  </div>
                )}
                <span style={{ color: "#0D9488", fontSize: fontSize.lg, lineHeight: 1 }} aria-hidden>
                  ›
                </span>
              </span>
            </div>
            {modelPicker === (a.instanceId ?? a.id) && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  margin: `0 ${space.sm}px`,
                  padding: 8,
                  border: `1px solid ${neutral[200]}`,
                  borderRadius: radius.md,
                  backgroundColor: "var(--color-surface)",
                  boxShadow: shadow.md,
                }}
              >
                <input
                  autoFocus
                  placeholder="搜索模型…"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: `6px 8px`,
                    borderRadius: radius.sm,
                    border: `1px solid ${neutral[200]}`,
                    fontSize: fontSize.sm,
                    marginBottom: 6,
                  }}
                />
                <div style={{ maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                  <button
                    type="button"
                    onClick={() => {
                      onChangeModel?.(a.instanceId ?? a.id, null);
                      setModelPicker(null);
                    }}
                    style={{
                      textAlign: "left",
                      padding: `6px 8px`,
                      borderRadius: radius.sm,
                      border: !a.overrideModelId ? `1px solid #0D9488` : `1px solid transparent`,
                      backgroundColor: !a.overrideModelId ? "rgba(13,148,136,0.12)" : "transparent",
                      cursor: "pointer",
                      fontSize: fontSize.sm,
                    }}
                  >
                    跟随模板 {!a.overrideModelId && "✓"}
                  </button>
                  {allModels
                    .filter((m) => !modelSearch || `${m.name} ${m.id}`.toLowerCase().includes(modelSearch.toLowerCase()))
                    .slice(0, 20)
                    .map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          onChangeModel?.(a.instanceId ?? a.id, m.id);
                          setModelPicker(null);
                        }}
                        style={{
                          textAlign: "left",
                          padding: `6px 8px`,
                          borderRadius: radius.sm,
                          border: a.overrideModelId === m.id ? `1px solid #0D9488` : `1px solid transparent`,
                          backgroundColor: a.overrideModelId === m.id ? "rgba(13,148,136,0.12)" : "transparent",
                          cursor: "pointer",
                          fontSize: fontSize.sm,
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 8,
                        }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {m.name} <span style={{ color: neutral[400], fontSize: 10 }}>{m.id.includes("/") ? m.id.split("/")[0] : m.id}</span>
                        </span>
                        {a.overrideModelId === m.id && "✓"}
                      </button>
                    ))}
                  {modelsQuery.isPending && <span style={{ fontSize: fontSize.xs, color: neutral[400], padding: 6 }}>加载中…</span>}
                  {!modelsQuery.isPending && allModels.length === 0 && (
                    <span style={{ fontSize: fontSize.xs, color: neutral[400], padding: 6 }}>暂无模型</span>
                  )}
                </div>
              </div>
            )}
            </React.Fragment>
           );
         })}

        {/* 添加实例：虚线入口（对齐创建页 add-instance-btn 视觉语言：1.5px dashed） */}
        <button
          type="button"
          data-testid="add-instance-entry"
          aria-label="添加实例"
          title={teamEditable ? "为任务添加 Agent 实例（自动建会话并绑定）" : "任务待验收/已完成/已归档后不允许调整团队"}
          onClick={openPanel}
          disabled={!teamEditable || adding}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: space.xs,
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1.5px dashed ${teamEditable ? neutral[300] : neutral[200]}`,
            backgroundColor: "color-mix(in srgb, var(--color-surface) 70%, transparent)",
            color: teamEditable ? "#0D9488" : neutral[300],
            fontSize: fontSize.sm,
            fontWeight: 500,
            cursor: teamEditable ? "pointer" : "not-allowed",
            fontFamily: fontFamily.body,
            transition: "border-color .15s ease, color .15s ease",
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>＋</span>
          添加实例
        </button>

        {/* 添加实例面板（内联展开：角色选择 + 别名输入 + 确认，窄面板紧凑布局） */}
        {addOpen && (
          <div
            data-testid="add-instance-panel"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: space.sm,
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.sm,
            }}
          >
            <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>添加实例</div>
            {/* 角色选择：五角色行（角色色点 + 中文名），点击选中（选中态 = 角色主题边框/背景） */}
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }} role="radiogroup" aria-label="选择角色">
              {ROLE_KEYS.map((role) => {
                const t = roles[role] ?? roles.developer;
                const selected = selectedRole === role;
                return (
                  <button
                    key={role}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid="add-instance-role"
                    data-role={role}
                    aria-label={`添加${t.label}实例`}
                    onClick={() => setSelectedRole(role)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.sm,
                      padding: `${space.xs}px ${space.sm}px`,
                      borderRadius: radius.sm,
                      border: `1px solid ${selected ? t.border : "transparent"}`,
                      backgroundColor: selected ? t.bg : "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: t.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: fontSize.md, color: neutral[700], fontWeight: selected ? 600 : 500 }}>
                      {t.label}
                    </span>
                    {selected && (
                      <span aria-hidden style={{ color: t.color, fontSize: fontSize.sm, fontWeight: 700 }}>✓</span>
                    )}
                  </button>
                );
              })}
              {/* is_0000000035：自定义/clone agent 可选（中性 teal 主题） */}
              {customAgents.length > 0 && (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.xs, padding: `0 ${space.sm}px` }}>
                    <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
                    <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>自定义 Agent</span>
                    <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
                  </div>
                  {customAgents.map((a) => {
                    const selected = selectedRole === a.id;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        data-testid="add-instance-custom-role"
                        data-agent-id={a.id}
                        aria-label={`添加自定义 Agent ${a.name}`}
                        onClick={() => setSelectedRole(a.id)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: space.sm,
                          padding: `${space.xs}px ${space.sm}px`,
                          borderRadius: radius.sm,
                          border: `1px solid ${selected ? CUSTOM_THEME.border : "transparent"}`,
                          backgroundColor: selected ? CUSTOM_THEME.bg : "transparent",
                          cursor: "pointer",
                          textAlign: "left",
                          fontFamily: fontFamily.body,
                        }}
                      >
                        <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: CUSTOM_THEME.color, flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, fontSize: fontSize.md, color: neutral[700], fontWeight: selected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {a.name}
                        </span>
                        <span style={{ fontSize: fontSize.xs, color: neutral[400], flexShrink: 0 }}>{a.type}</span>
                        {selected && (
                          <span aria-hidden style={{ color: CUSTOM_THEME.color, fontSize: fontSize.sm, fontWeight: 700 }}>✓</span>
                        )}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
            {/* 别名（可选，缺省服务端生成 <角色中文名>-<seq>） */}
            <input
              data-testid="add-instance-alias"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder={theme ? `别名（缺省 ${theme.label}-N）` : "别名（缺省自动生成）"}
              disabled={adding}
              aria-label="实例别名（可选）"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: `${space.sm}px ${space.sm}px`,
                borderRadius: radius.sm,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "var(--color-surface)",
                fontSize: fontSize.md,
                color: neutral[800],

                fontFamily: fontFamily.body,
              }}
            />
            {addError && (
              <div data-testid="add-instance-error" role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626", lineHeight: 1.5 }}>
                {addError}
              </div>
            )}
            {/* 操作：取消 / 添加 */}
            <div style={{ display: "flex", gap: space.sm }}>
              <button
                type="button"
                data-testid="add-instance-cancel"
                onClick={closePanel}
                disabled={adding}
                style={{
                  flex: 1,
                  padding: `${space.sm - 1}px ${space.md}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "var(--color-surface)",
                  color: neutral[600],
                  fontSize: fontSize.sm,
                  fontWeight: 500,
                  cursor: adding ? "default" : "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="add-instance-confirm"
                onClick={confirmAdd}
                disabled={!selectedRole || adding}
                style={{
                  flex: 1,
                  padding: `${space.sm - 1}px ${space.md}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#0D9488",
                  color: "#FFFFFF",
                  fontSize: fontSize.sm,
                  fontWeight: 500,
                  cursor: !selectedRole || adding ? "default" : "pointer",
                  opacity: !selectedRole || adding ? 0.5 : 1,
                  fontFamily: fontFamily.body,
                }}
              >
                {adding ? "添加中…" : "添加"}
              </button>
            </div>
          </div>
        )}
      </div>
      <div
        style={{
          marginTop: "auto",
          padding: space.md,
          fontSize: fontSize.xs,
          color: neutral[400],
          lineHeight: 1.5,
          borderTop: `1px dashed ${neutral[200]}`,
        }}
      >
        {footerText ?? "与成员私聊请前往团队会话"}
      </div>
    </aside>
  );
}
