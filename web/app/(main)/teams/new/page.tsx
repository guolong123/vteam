"use client";

/**
 * 团队创建页（Task 11）
 * =============================================
 * - 岗位卡本地组件 RoleInstanceCard：卡片来源 = GET /agent-roles（内置 + 自定义**单一来源**）
 * - 提交 POST /teams { name, description, reuseSession, members: {roleId?, agentId?, alias?, workDir?}[] }
 *   （ROLE-first：岗位实例只带 roleId（agentId 省略，服务端按规则 2/5 从角色默认槽预填）；
 *    仅外部-only 岗位（无内部默认 Agent）附加显式执行 Agent 的 agentId）
 * - reuseSession 开关（默认 true）
 * - 成员多实例：同一 agent 可重复，alias/workDir 行内可改
 * - 校验：团队名必填
 */
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AgentAvatar } from "@/src/components/ui";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { teamsApi } from "@/src/api/teams";
import { agentRolesApi, type AgentRoleDto } from "@/src/api/agent-roles";
import {
  type RoleKey,
  ROLE_KEYS,
  neutral,
  roles,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

interface AgentItem {
  id: string;
  name: string;
  role: string;
  type: string;
  prompt: string | null;
}
interface AgentsResponse { items: AgentItem[]; total: number; }

function isRoleKey(key: string): key is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(key);
}
/** 自定义岗位无内置语义色：中性灰兜底，不冒充任何内置角色色。 */
const FALLBACK_ROLE_PALETTE = { color: neutral[500], bg: neutral[50], border: neutral[200] };
function rolePaletteOf(roleKey: string): { color: string; bg: string; border: string } {
  return isRoleKey(roleKey) ? roles[roleKey] : FALLBACK_ROLE_PALETTE;
}

interface InstanceDraft {
  key: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  agentId: string;
  alias: string;
  seq: number;
  workDir: string;
}
/** bucket key = role.id：内置与每个自定义岗位各自一个实例桶，互不共用。 */
type InstancesByRole = Record<string, InstanceDraft[]>;

function defaultAliasOf(roleName: string, seq: number): string {
  return `${roleName}-${seq}`;
}
function defaultWorkDirOf(roleName: string, seq: number): string {
  return seq > 1 ? `/data/vteam-worker/${roleName}-${seq}` : `/data/vteam-worker/${roleName}`;
}
function findRoleOf(instancesByRole: InstancesByRole, key: string): string | null {
  for (const bucket of Object.keys(instancesByRole)) {
    if ((instancesByRole[bucket] ?? []).some((i) => i.key === key)) return bucket;
  }
  return null;
}
function allInstancesOf(m: InstancesByRole): InstanceDraft[] {
  return Object.values(m).flat();
}
/** 外部-only 岗位（defaultAgentId 空 + 外部引擎名）：其实例必须显式选内部执行 Agent。 */
function isExternalOnlyRole(role: AgentRoleDto): boolean {
  return !role.defaultAgentId && !!role.defaultOpencodeAgentName;
}
function bindingLabelOf(role: AgentRoleDto): string {
  if (role.defaultAgentId) return role.defaultAgentId;
  if (role.defaultOpencodeAgentName) return `${role.defaultOpencodeAgentName}（外部）`;
  return "未设置";
}

function RoleAvatar({ role }: { role: AgentRoleDto }) {
  if (isRoleKey(role.key)) return <AgentAvatar role={role.key} size="md" />;
  return (
    <span
      data-testid="agent-avatar"
      data-role={role.key}
      aria-hidden
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: "50%", backgroundColor: FALLBACK_ROLE_PALETTE.bg, border: `1.5px solid ${FALLBACK_ROLE_PALETTE.border}`, color: FALLBACK_ROLE_PALETTE.color, fontSize: fontSize.md, fontWeight: 600, lineHeight: 1, userSelect: "none", flexShrink: 0, ...baseFont }}
    >
      {role.name.charAt(0).toUpperCase()}
    </span>
  );
}

function RoleInstanceCard({
  role, bindingLabel, externalOnly, instances, executorOptions, onToggleRole, onAddInstance, onRenameInstance, onWorkDirChange, onRemoveInstance, onPickExecutor,
}: {
  role: AgentRoleDto; bindingLabel: string; externalOnly: boolean;
  instances: InstanceDraft[]; executorOptions: { id: string; name: string }[];
  onToggleRole: (r: AgentRoleDto) => void; onAddInstance: (r: AgentRoleDto) => void;
  onRenameInstance: (k: string, v: string) => void; onWorkDirChange: (k: string, v: string) => void; onRemoveInstance: (k: string) => void;
  onPickExecutor: (k: string, agentId: string) => void;
}) {
  const palette = rolePaletteOf(role.key);
  const label = role.name;
  const enabled = instances.length > 0;
  return (
    <div data-testid="role-card" data-role={role.key} data-enabled={enabled ? "true" : "false"} style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: enabled ? palette.bg : "var(--color-surface)", border: `1px solid ${enabled ? palette.border : neutral[200]}`, boxShadow: enabled ? shadow.sm : undefined, transition: "border-color .15s, background-color .15s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <RoleAvatar role={role} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>{label}</div>
            <span style={{ fontSize: fontSize.xs, color: neutral[400], backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, borderRadius: radius.pill, padding: "1px 8px" }}>{enabled ? `${instances.length} 个实例` : "未启用"}</span>
          </div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{role.description ?? "未设置"}</div>
          {/* ROLE-first：岗位绑定（与 AgentRolesTab.describeDefaultSlot 同约定：外部如实显示；data-role-id 供 e2e 断言 role-only 提交） */}
          <div data-testid="role-binding" data-role-id={role.id} style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>绑定：{bindingLabel}</div>
        </div>
        <span role="checkbox" aria-checked={enabled} data-testid="role-toggle" onClick={() => onToggleRole(role)} style={{ width: 20, height: 20, borderRadius: radius.sm, border: `1.5px solid ${enabled ? palette.color : neutral[300]}`, backgroundColor: enabled ? palette.color : "var(--color-surface)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#FFF", fontSize: fontSize.sm, fontWeight: 700, flexShrink: 0, cursor: "pointer" }}>{enabled ? "✓" : ""}</span>
      </div>
      {enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {instances.map((inst) => (
            <div key={inst.key} data-testid="instance-row" data-instance-key={inst.key} style={{ display: "flex", flexDirection: "column", gap: space.xs, padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: palette.color, flexShrink: 0 }} />
              <input data-testid="instance-alias-input" value={inst.alias} aria-label={`${label}别名`} onChange={(e) => onRenameInstance(inst.key, e.target.value)} style={{ flex: 1, minWidth: 0, border: "none",background: "transparent", fontSize: fontSize.md, fontWeight: 500, color: neutral[800], fontFamily: fontFamily.body, padding: `${space.xs}px 0` }} />
              <input data-testid="instance-workdir-input" value={inst.workDir} aria-label={`${label}工作目录`} onChange={(e) => onWorkDirChange(inst.key, e.target.value)} placeholder="/data/vteam-worker/…" style={{ flex: 1, minWidth: 0, border: "none",background: "transparent", fontSize: fontSize.xs, color: neutral[500], fontFamily: fontFamily.mono, padding: `${space.xs}px 0` }} />
              <span style={{ fontSize: fontSize.xs, color: neutral[400], flexShrink: 0 }}>#{inst.seq}</span>
              <button type="button" data-testid="instance-remove" aria-label={`移除 ${inst.alias}`} onClick={() => onRemoveInstance(inst.key)} style={{ border: "none", background: "none", fontSize: fontSize.sm, color: neutral[400], cursor: "pointer", padding: space.xs, fontFamily: fontFamily.body }}>✕</button>
              </div>
              {/* 外部-only 岗位：该实例须显式指定内部执行 Agent（agentId + roleId 走规则 1+5） */}
              {externalOnly && (
                <select data-testid="instance-executor-select" aria-label={`${label}执行 Agent（外部岗位必填）`} value={inst.agentId} onChange={(e) => onPickExecutor(inst.key, e.target.value)} style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${neutral[200]}`, borderRadius: radius.sm, padding: `${space.xs}px ${space.sm}px`, fontSize: fontSize.xs, color: neutral[600], background: neutral[50], fontFamily: fontFamily.body }}>
                  <option value="">请选择执行 Agent</option>
                  {executorOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>
      )}
      {externalOnly && enabled && (
        <div data-testid="role-external-hint" style={{ fontSize: fontSize.xs, color: "#B45309" }}>外部绑定岗位：实例需再选一个内部执行 Agent</div>
      )}
      <button type="button" data-testid="add-instance-btn" onClick={() => onAddInstance(role)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: space.xs, padding: `${space.sm - 1}px ${space.md}px`, borderRadius: radius.md, border: `1.5px dashed ${palette.border}`, backgroundColor: "color-mix(in srgb, var(--color-surface) 70%, transparent)", color: palette.color, fontSize: fontSize.sm, fontWeight: 500, cursor: "pointer", fontFamily: fontFamily.body }}><span aria-hidden>＋</span> 添加{label}实例</button>
    </div>
  );
}

export default function TeamNewPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [reuseSession, setReuseSession] = useState(true);
  const [nameError, setNameError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const [instancesByRole, setInstancesByRole] = useState<InstancesByRole>({});
  const [mainAgentKey, setMainAgentKey] = useState<string | null>(null);
  const keySeqRef = useRef(10);
  const nextKey = () => `inst-local-${keySeqRef.current++}`;
  const allInstances = useMemo(() => allInstancesOf(instancesByRole), [instancesByRole]);

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<AgentsResponse>("/agents"),
  });
  // 岗位列表：唯一来源 /agent-roles（内置 + 自定义同列）；卡片、实例桶、提交均以 role.id 为键
  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => agentRolesApi.list({ page: 1, pageSize: 100 }),
    retry: false,
  });
  const roleItems = useMemo<AgentRoleDto[]>(() => rolesQuery.data?.items ?? [], [rolesQuery.data]);
  const roleById = useMemo(() => new Map(roleItems.map((r) => [r.id, r])), [roleItems]);
  const executorOptions = useMemo(
    () => (agentsQuery.data?.items ?? []).map((a) => ({ id: a.id, name: a.name })),
    [agentsQuery.data],
  );

  const makeInstance = (role: AgentRoleDto, seq: number): InstanceDraft => ({
    key: nextKey(),
    roleId: role.id,
    roleKey: role.key,
    roleName: role.name,
    agentId: "",
    alias: defaultAliasOf(role.name, seq),
    workDir: defaultWorkDirOf(role.name, seq),
    seq,
  });
  const handleToggleRole = (role: AgentRoleDto) => {
    setInstancesByRole((prev) => {
      const enabled = (prev[role.id] ?? []).length > 0;
      if (enabled) {
        const removedKeys = new Set((prev[role.id] ?? []).map((i) => i.key));
        if (mainAgentKey && removedKeys.has(mainAgentKey)) setMainAgentKey(null);
        return { ...prev, [role.id]: [] };
      }
      return { ...prev, [role.id]: [makeInstance(role, 1)] };
    });
  };
  const handleAddInstance = (role: AgentRoleDto) => {
    setInstancesByRole((prev) => {
      const list = prev[role.id] ?? [];
      const seq = list.reduce((m, i) => Math.max(m, i.seq), 0) + 1;
      return { ...prev, [role.id]: [...list, makeInstance(role, seq)] };
    });
  };
  const handleRename = (key: string, alias: string) => {
    setInstancesByRole((prev) => {
      const bucket = findRoleOf(prev, key); if (!bucket) return prev;
      return { ...prev, [bucket]: (prev[bucket] ?? []).map((i) => i.key === key ? { ...i, alias } : i) };
    });
  };
  const handleWorkDir = (key: string, workDir: string) => {
    setInstancesByRole((prev) => {
      const bucket = findRoleOf(prev, key); if (!bucket) return prev;
      return { ...prev, [bucket]: (prev[bucket] ?? []).map((i) => i.key === key ? { ...i, workDir } : i) };
    });
  };
  const handlePickExecutor = (key: string, agentId: string) => {
    setInstancesByRole((prev) => {
      const bucket = findRoleOf(prev, key); if (!bucket) return prev;
      return { ...prev, [bucket]: (prev[bucket] ?? []).map((i) => i.key === key ? { ...i, agentId } : i) };
    });
  };
  const handleRemove = (key: string) => {
    if (mainAgentKey === key) setMainAgentKey(null);
    setInstancesByRole((prev) => {
      const bucket = findRoleOf(prev, key); if (!bucket) return prev;
      return { ...prev, [bucket]: (prev[bucket] ?? []).filter((i) => i.key !== key) };
    });
  };

  const createMutation = useMutation({
    mutationFn: () => {
      const members = allInstances.map((inst) => {
        const role = roleById.get(inst.roleId);
        // ROLE-first：岗位实例只提交 roleId（服务端按规则 2 从角色默认槽预填 agentId）；
        // 仅外部-only 岗位（无内部默认）才允许带显式执行 Agent（规则 1+5）。
        const executor = role && isExternalOnlyRole(role) && inst.agentId ? { agentId: inst.agentId } : {};
        return {
          roleId: inst.roleId,
          ...executor,
          ...(inst.alias !== defaultAliasOf(inst.roleName, inst.seq) ? { alias: inst.alias } : {}),
          ...(inst.workDir.trim() !== defaultWorkDirOf(inst.roleName, inst.seq) ? { workDir: inst.workDir.trim() } : {}),
        };
      });
      let mainAgentMemberId: string | undefined;
      if (mainAgentKey) {
        const idx = allInstances.findIndex((i) => i.key === mainAgentKey);
        if (idx >= 0) mainAgentMemberId = String(idx);
      }
      return teamsApi.create({ name: name.trim(), description: description.trim() || undefined, reuseSession, members, ...(mainAgentMemberId ? { mainAgentMemberId } : {}) });
    },
  });

  const handleCreate = async () => {
    if (!name.trim()) { setNameError("请输入团队名称"); return; }
    // 外部-only 岗位实例须已选内部执行 Agent，否则服务端报 ROLE_DEFAULT_AGENT_MISSING。
    const missingExecutor = allInstances.some((i) => {
      const role = roleById.get(i.roleId);
      return !!role && isExternalOnlyRole(role) && !i.agentId;
    });
    if (missingExecutor) { setCreateError("外部绑定岗位的实例需再选一个内部执行 Agent"); return; }
    setNameError(null); setCreateError(null);
    try {
      const res = await createMutation.mutateAsync();
      router.push(`/teams/${res.id}`);
    } catch (err) {
      setCreateError(isApiError(err) ? err.message : "创建失败");
    }
  };

  const inputBase: CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.md, color: neutral[800],fontFamily: fontFamily.body,
  };
  const labelStyle: CSSProperties = { fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs };

  return (
    <div data-testid="team-create-root" style={{ flex: 1, display: "flex", flexDirection: "column", backgroundColor: neutral[100], ...baseFont }}>
      <div style={{ flex: 1, overflow: "auto", padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`, display: "flex", gap: space.xl, alignItems: "flex-start" }}>
        {/* 左栏表单 */}
        <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg, padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm }}>
          <div>
            <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>创建团队</div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>团队全局复用，成员实例支持 alias/workDir 独立配置</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <label htmlFor="team-name" style={labelStyle}>团队名称 <span style={{ color: "#DC2626" }}>*</span></label>
            <input id="team-name" data-testid="team-name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：vteam开发团队" style={inputBase} />
            {nameError && <div data-testid="team-name-error" role="alert" style={{ marginTop: space.xs, fontSize: fontSize.sm, color: "#DC2626" }}>{nameError}</div>}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <label htmlFor="team-desc" style={labelStyle}>团队描述</label>
            <textarea id="team-desc" data-testid="team-desc-input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="团队职责与协作范围（可选）" style={{ ...inputBase, resize: "none", lineHeight: 1.6 }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
            <span role="switch" aria-checked={reuseSession} data-testid="reuse-session-toggle" onClick={() => setReuseSession(!reuseSession)} style={{ width: 40, height: 22, borderRadius: 11, border: "none", backgroundColor: reuseSession ? "#0D9488" : neutral[300], position: "relative", flexShrink: 0, cursor: "pointer", transition: "background-color .2s" }}>
              <span style={{ position: "absolute", top: 2, left: reuseSession ? 20 : 2, width: 18, height: 18, borderRadius: "50%", backgroundColor: "var(--color-surface)", transition: "left .2s", boxShadow: shadow.sm }} />
            </span>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>复用会话（reuseSession）</span>
              <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>开启后跨任务复用会话历史，关闭则每任务开新会话</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, fontSize: fontSize.sm, color: neutral[500], lineHeight: 1.6 }}>
            <span aria-hidden style={{ color: "#0D9488", fontWeight: 700 }}>i</span>
            团队成员支持多实例（同一 Agent 可添加多个实例，alias/workDir 独立）。
          </div>
          {createError && <div data-testid="team-create-error" role="alert" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.22)", fontSize: fontSize.sm, color: "#B91C1C" }}>{createError}</div>}
        </section>

        {/* 右栏成员选择 */}
        <section style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
          <div style={{ padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, display: "flex", flexDirection: "column", gap: space.md }}>
            <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>选择团队成员</div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], lineHeight: 1.6 }}>同一角色可多实例（如 开发者-1 / 开发者-2），alias/workDir 可行内编辑。</div>
            {rolesQuery.isPending ? (
              <div data-testid="roles-loading" style={{ fontSize: fontSize.sm, color: neutral[400] }}>岗位加载中…</div>
            ) : rolesQuery.isError ? (
              <div data-testid="roles-error" role="alert" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                <span style={{ fontSize: fontSize.sm, color: "#DC2626" }}>岗位加载失败</span>
                <button type="button" data-testid="roles-retry" onClick={() => rolesQuery.refetch()} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], cursor: "pointer", fontFamily: fontFamily.body }}>重试</button>
              </div>
            ) : agentsQuery.isPending ? (
              <div data-testid="agents-loading" style={{ fontSize: fontSize.sm, color: neutral[400] }}>加载中…</div>
            ) : agentsQuery.isError ? (
              <div data-testid="agents-error" role="alert" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                <span style={{ fontSize: fontSize.sm, color: "#DC2626" }}>Agent 加载失败</span>
                <button type="button" data-testid="agents-retry" onClick={() => agentsQuery.refetch()} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], cursor: "pointer", fontFamily: fontFamily.body }}>重试</button>
              </div>
            ) : (
              roleItems.map((role) => (
                <RoleInstanceCard key={role.id} role={role} bindingLabel={bindingLabelOf(role)} externalOnly={isExternalOnlyRole(role)} instances={instancesByRole[role.id] ?? []} executorOptions={executorOptions} onToggleRole={handleToggleRole} onAddInstance={handleAddInstance} onRenameInstance={handleRename} onWorkDirChange={handleWorkDir} onRemoveInstance={handleRemove} onPickExecutor={handlePickExecutor} />
              ))
            )}
          </div>

          <div style={{ padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, display: "flex", flexDirection: "column", gap: space.md }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>
              <span>已选成员</span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400], fontWeight: 400 }}>{allInstances.length} 个</span>
            </div>
            {allInstances.length > 0 && <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>选择主 Agent（单选 ★）：</div>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: space.sm }}>
              {allInstances.map((inst) => {
                const palette = rolePaletteOf(inst.roleKey);
                const isMain = mainAgentKey === inst.key;
                return (
                  <span key={inst.key} data-testid="selected-member" data-main={isMain ? "true" : "false"} onClick={() => setMainAgentKey(isMain ? null : inst.key)} style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: `${space.xs - 1}px ${space.sm}px`, borderRadius: radius.pill, backgroundColor: isMain ? "#FFF7ED" : palette.bg, border: `1px solid ${isMain ? "#F59E0B" : palette.border}`, color: isMain ? "#D97706" : palette.color, fontSize: fontSize.sm, fontWeight: 500, cursor: "pointer" }}>
                    <span aria-hidden style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: "50%", border: `1.5px solid ${isMain ? "#F59E0B" : neutral[300]}`, backgroundColor: isMain ? "#F59E0B" : "transparent", color: "#FFF", fontSize: 10 }}>{isMain ? "★" : ""}</span>
                    <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: palette.color }} />
                    {inst.alias}
                    {isMain && <span style={{ fontSize: 10, fontWeight: 700, color: "#D97706" }}>主 Agent</span>}
                  </span>
                );
              })}
              {allInstances.length === 0 && <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>尚未选择成员</span>}
            </div>
            {mainAgentKey && <div style={{ fontSize: fontSize.xs, color: "#D97706" }}>★ 已选主 Agent：{allInstances.find((i) => i.key === mainAgentKey)?.alias}</div>}
          </div>

          <button type="button" data-testid="create-team-submit" disabled={createMutation.isPending} onClick={handleCreate} style={{ width: "100%", padding: `${space.md + 2}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", fontSize: fontSize.lg, fontWeight: 600, cursor: createMutation.isPending ? "default" : "pointer", opacity: createMutation.isPending ? 0.7 : 1, boxShadow: "0 6px 16px rgba(13,148,136,.3)", fontFamily: fontFamily.body }}>
            {createMutation.isPending ? "创建中…" : "创建团队"}
          </button>
        </section>
      </div>
    </div>
  );
}
