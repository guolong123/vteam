"use client";

/**
 * 团队创建页（Task 11）
 * =============================================
 * - 复用 tasks/new 的 AgentSelectPanel 风格：RoleInstanceCard + CustomAgentCard 抽离为本地组件
 * - 提交 POST /teams { name, description, reuseSession, members: {agentId, alias?, workDir?}[] }
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

interface AgentItem {
  id: string;
  name: string;
  role: string;
  type: string;
  prompt: string | null;
}
interface AgentsResponse { items: AgentItem[]; total: number; }

const FIXED_DESC: Record<RoleKey, string> = {
  product: "需求拆解与验收标准",
  project_manager: "项目组织与进度推进",
  architect: "技术方案与架构设计",
  developer: "编码实现与自测",
  tester: "用例设计与质量验收",
};
const ROLE_AGENT_ID: Record<RoleKey, string> = {
  product: "a_product",
  project_manager: "a_project_manager",
  architect: "a_architect",
  developer: "a_developer",
  tester: "a_tester",
};
const ROLE_ORDER: RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];

interface InstanceDraft {
  key: string;
  agentId: string;
  alias: string;
  seq: number;
  workDir: string;
  roleKey: RoleKey | null;
  agentName?: string;
}
type InstanceBucketKey = RoleKey | "custom";
type InstancesByRole = Partial<Record<InstanceBucketKey, InstanceDraft[]>>;
const CUSTOM_THEME = { color: "#0D9488", bg: "#F0FDFA", border: "#99F6E4", label: "自定义" };

function defaultAliasOf(bucket: InstanceBucketKey, agentName: string | undefined, seq: number): string {
  if (bucket === "custom") return `${agentName ?? "自定义"}-${seq}`;
  return `${roles[bucket].label}-${seq}`;
}
function defaultWorkDirOf(bucket: InstanceBucketKey, agentName: string | undefined, seq: number): string {
  const base = bucket === "custom" ? agentName ?? "自定义" : roles[bucket].label;
  return seq > 1 ? `/data/vteam-worker/${base}-${seq}` : `/data/vteam-worker/${base}`;
}
function findRoleOf(instancesByRole: InstancesByRole, key: string): InstanceBucketKey | null {
  const buckets = [...ROLE_ORDER, "custom"] as InstanceBucketKey[];
  for (const bucket of buckets) if ((instancesByRole[bucket] ?? []).some((i) => i.key === key)) return bucket;
  return null;
}
function allInstancesOf(m: InstancesByRole): InstanceDraft[] {
  return [...ROLE_ORDER.flatMap((r) => m[r] ?? []), ...(m.custom ?? [])];
}

function RoleInstanceCard({
  role, instances, onToggleRole, onAddInstance, onRenameInstance, onWorkDirChange, onRemoveInstance,
}: {
  role: RoleKey; instances: InstanceDraft[];
  onToggleRole: (r: RoleKey) => void; onAddInstance: (r: RoleKey) => void;
  onRenameInstance: (k: string, v: string) => void; onWorkDirChange: (k: string, v: string) => void; onRemoveInstance: (k: string) => void;
}) {
  const theme = roles[role] ?? roles.developer;
  const enabled = instances.length > 0;
  return (
    <div data-testid="role-card" data-role={role} data-enabled={enabled ? "true" : "false"} style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: enabled ? theme.bg : "var(--color-surface)", border: `1px solid ${enabled ? theme.border : neutral[200]}`, boxShadow: enabled ? shadow.sm : undefined, transition: "border-color .15s, background-color .15s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <AgentAvatar role={role} size="md" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>{theme.label}</div>
            <span style={{ fontSize: fontSize.xs, color: neutral[400], backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, borderRadius: radius.pill, padding: "1px 8px" }}>{enabled ? `${instances.length} 个实例` : "未启用"}</span>
          </div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{FIXED_DESC[role]}</div>
        </div>
        <span role="checkbox" aria-checked={enabled} data-testid="role-toggle" onClick={() => onToggleRole(role)} style={{ width: 20, height: 20, borderRadius: radius.sm, border: `1.5px solid ${enabled ? theme.color : neutral[300]}`, backgroundColor: enabled ? theme.color : "var(--color-surface)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#FFF", fontSize: fontSize.sm, fontWeight: 700, flexShrink: 0, cursor: "pointer" }}>{enabled ? "✓" : ""}</span>
      </div>
      {enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {instances.map((inst) => (
            <div key={inst.key} data-testid="instance-row" data-instance-key={inst.key} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}` }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: theme.color, flexShrink: 0 }} />
              <input data-testid="instance-alias-input" value={inst.alias} aria-label={`${theme.label}别名`} onChange={(e) => onRenameInstance(inst.key, e.target.value)} style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: fontSize.md, fontWeight: 500, color: neutral[800], fontFamily: fontFamily.body, padding: `${space.xs}px 0` }} />
              <input data-testid="instance-workdir-input" value={inst.workDir} aria-label={`${theme.label}工作目录`} onChange={(e) => onWorkDirChange(inst.key, e.target.value)} placeholder="/data/vteam-worker/…" style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: fontSize.xs, color: neutral[500], fontFamily: fontFamily.mono, padding: `${space.xs}px 0` }} />
              <span style={{ fontSize: fontSize.xs, color: neutral[400], flexShrink: 0 }}>#{inst.seq}</span>
              <button type="button" data-testid="instance-remove" aria-label={`移除 ${inst.alias}`} onClick={() => onRemoveInstance(inst.key)} style={{ border: "none", background: "none", fontSize: fontSize.sm, color: neutral[400], cursor: "pointer", padding: space.xs, fontFamily: fontFamily.body }}>✕</button>
            </div>
          ))}
        </div>
      )}
      <button type="button" data-testid="add-instance-btn" onClick={() => onAddInstance(role)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: space.xs, padding: `${space.sm - 1}px ${space.md}px`, borderRadius: radius.md, border: `1.5px dashed ${theme.border}`, backgroundColor: "color-mix(in srgb, var(--color-surface) 70%, transparent)", color: theme.color, fontSize: fontSize.sm, fontWeight: 500, cursor: "pointer", fontFamily: fontFamily.body }}><span aria-hidden>＋</span> 添加{theme.label}实例</button>
    </div>
  );
}

function CustomAgentCard({
  agents, instances, onAdd, onRenameInstance, onWorkDirChange, onRemoveInstance,
}: {
  agents: AgentItem[]; instances: InstanceDraft[];
  onAdd: (a: AgentItem) => void; onRenameInstance: (k: string, v: string) => void; onWorkDirChange: (k: string, v: string) => void; onRemoveInstance: (k: string) => void;
}) {
  const theme = CUSTOM_THEME;
  const enabled = instances.length > 0;
  return (
    <div data-testid="custom-agent-card" data-enabled={enabled ? "true" : "false"} style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: enabled ? theme.bg : "var(--color-surface)", border: `1px solid ${enabled ? theme.border : neutral[200]}`, boxShadow: enabled ? shadow.sm : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <span aria-hidden style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: radius.md, backgroundColor: theme.bg, border: `1px solid ${theme.border}`, color: theme.color, fontSize: fontSize.sm, fontWeight: 700, flexShrink: 0 }}>自</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>自定义 Agent</div>
            <span style={{ fontSize: fontSize.xs, color: neutral[400], backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, borderRadius: radius.pill, padding: "1px 8px" }}>{enabled ? `${instances.length} 个实例` : "未选择"}</span>
          </div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>自定义/clone Agent，按名称展示</div>
        </div>
      </div>
      {enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {instances.map((inst) => (
            <div key={inst.key} data-testid="custom-instance-row" style={{ display: "flex", flexDirection: "column", gap: space.xs, padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: theme.color, flexShrink: 0 }} />
                <input data-testid="instance-alias-input" value={inst.alias} onChange={(e) => onRenameInstance(inst.key, e.target.value)} style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: fontSize.md, fontWeight: 500, color: neutral[800], fontFamily: fontFamily.body, padding: `${space.xs}px 0` }} />
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>#{inst.seq}</span>
                <button type="button" data-testid="instance-remove" onClick={() => onRemoveInstance(inst.key)} style={{ border: "none", background: "none", fontSize: fontSize.sm, color: neutral[400], cursor: "pointer", padding: space.xs, fontFamily: fontFamily.body }}>✕</button>
              </div>
              <input data-testid="instance-workdir-input" value={inst.workDir} onChange={(e) => onWorkDirChange(inst.key, e.target.value)} placeholder="/data/vteam-worker/…" style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${neutral[200]}`, borderRadius: radius.sm, padding: `${space.xs}px ${space.sm}px`, fontSize: fontSize.xs, color: neutral[600], outline: "none", background: neutral[50], fontFamily: fontFamily.mono }} />
            </div>
          ))}
        </div>
      )}
      {agents.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {agents.map((agent) => {
            const already = instances.some((i) => i.agentId === agent.id);
            return (
              <div key={agent.id} data-testid="custom-agent-item" data-agent-id={agent.id} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${already ? theme.border : neutral[200]}` }}>
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: already ? theme.color : neutral[300], flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fontSize.md, color: neutral[700] }}>{agent.name}</span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{agent.type}</span>
                <button type="button" data-testid="add-custom-agent-btn" disabled={already} onClick={() => onAdd(agent)} style={{ border: `1px solid ${already ? neutral[200] : theme.border}`, background: already ? neutral[50] : "var(--color-surface)", color: already ? neutral[400] : theme.color, fontSize: fontSize.sm, fontWeight: 500, borderRadius: radius.pill, padding: `${space.xs - 1}px ${space.sm}px`, cursor: already ? "default" : "pointer", fontFamily: fontFamily.body }}>{already ? "已添加" : "＋ 添加"}</button>
              </div>
            );
          })}
        </div>
      )}
      {agents.length === 0 && <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>暂无自定义 Agent</div>}
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
  const customAgents = useMemo(() => (agentsQuery.data?.items ?? []).filter((a) => a.type !== "template"), [agentsQuery.data]);

  const handleToggleRole = (role: RoleKey) => {
    setInstancesByRole((prev) => {
      const enabled = (prev[role] ?? []).length > 0;
      if (enabled) {
        const removedKeys = new Set((prev[role] ?? []).map((i) => i.key));
        if (mainAgentKey && removedKeys.has(mainAgentKey)) setMainAgentKey(null);
        return { ...prev, [role]: [] };
      }
      return { ...prev, [role]: [{ key: nextKey(), agentId: ROLE_AGENT_ID[role], alias: defaultAliasOf(role, undefined, 1), workDir: defaultWorkDirOf(role, undefined, 1), seq: 1, roleKey: role }] };
    });
  };
  const handleAddInstance = (role: RoleKey) => {
    setInstancesByRole((prev) => {
      const list = prev[role] ?? [];
      const seq = list.reduce((m, i) => Math.max(m, i.seq), 0) + 1;
      return { ...prev, [role]: [...list, { key: nextKey(), agentId: ROLE_AGENT_ID[role], alias: defaultAliasOf(role, undefined, seq), workDir: defaultWorkDirOf(role, undefined, seq), seq, roleKey: role }] };
    });
  };
  const handleAddCustomAgent = (agent: AgentItem) => {
    setInstancesByRole((prev) => {
      const list = prev.custom ?? [];
      const seq = list.reduce((m, i) => Math.max(m, i.seq), 0) + 1;
      return { ...prev, custom: [...list, { key: nextKey(), agentId: agent.id, alias: defaultAliasOf("custom", agent.name, seq), workDir: defaultWorkDirOf("custom", agent.name, seq), seq, roleKey: null, agentName: agent.name }] };
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
  const handleRemove = (key: string) => {
    if (mainAgentKey === key) setMainAgentKey(null);
    setInstancesByRole((prev) => {
      const bucket = findRoleOf(prev, key); if (!bucket) return prev;
      return { ...prev, [bucket]: (prev[bucket] ?? []).filter((i) => i.key !== key) };
    });
  };

  const createMutation = useMutation({
    mutationFn: () => {
      const members = allInstances.map((inst) => ({
        agentId: inst.agentId,
        ...(inst.alias !== defaultAliasOf(inst.roleKey ?? "custom", inst.agentName, inst.seq) ? { alias: inst.alias } : {}),
        ...(inst.workDir.trim() !== defaultWorkDirOf(inst.roleKey ?? "custom", inst.agentName, inst.seq) ? { workDir: inst.workDir.trim() } : {}),
      }));
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
    border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.md, color: neutral[800], outline: "none", fontFamily: fontFamily.body,
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
            <span role="switch" aria-checked={reuseSession} data-testid="reuse-session-toggle" onClick={() => setReuseSession(!reuseSession)} style={{ width: 40, height: 22, borderRadius: 11, border: "none", backgroundColor: reuseSession ? "#2563EB" : neutral[300], position: "relative", flexShrink: 0, cursor: "pointer", transition: "background-color .2s" }}>
              <span style={{ position: "absolute", top: 2, left: reuseSession ? 20 : 2, width: 18, height: 18, borderRadius: "50%", backgroundColor: "var(--color-surface)", transition: "left .2s", boxShadow: shadow.sm }} />
            </span>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>复用会话（reuseSession）</span>
              <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>开启后跨任务复用会话历史，关闭则每任务开新会话</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, fontSize: fontSize.sm, color: neutral[500], lineHeight: 1.6 }}>
            <span aria-hidden style={{ color: "#2563EB", fontWeight: 700 }}>i</span>
            团队成员支持多实例（同一 Agent 可添加多个实例，alias/workDir 独立）。
          </div>
          {createError && <div data-testid="team-create-error" role="alert" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.22)", fontSize: fontSize.sm, color: "#B91C1C" }}>{createError}</div>}
        </section>

        {/* 右栏成员选择 */}
        <section style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
          <div style={{ padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, display: "flex", flexDirection: "column", gap: space.md }}>
            <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>选择团队成员</div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], lineHeight: 1.6 }}>同一角色可多实例（如 开发者-1 / 开发者-2），alias/workDir 可行内编辑。</div>
            {agentsQuery.isPending ? (
              <div data-testid="agents-loading" style={{ fontSize: fontSize.sm, color: neutral[400] }}>加载中…</div>
            ) : agentsQuery.isError ? (
              <div data-testid="agents-error" role="alert" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                <span style={{ fontSize: fontSize.sm, color: "#DC2626" }}>Agent 加载失败</span>
                <button type="button" data-testid="agents-retry" onClick={() => agentsQuery.refetch()} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], cursor: "pointer", fontFamily: fontFamily.body }}>重试</button>
              </div>
            ) : (
              <>
                {ROLE_ORDER.map((role) => (
                  <RoleInstanceCard key={role} role={role} instances={instancesByRole[role] ?? []} onToggleRole={handleToggleRole} onAddInstance={handleAddInstance} onRenameInstance={handleRename} onWorkDirChange={handleWorkDir} onRemoveInstance={handleRemove} />
                ))}
                <CustomAgentCard agents={customAgents} instances={instancesByRole.custom ?? []} onAdd={handleAddCustomAgent} onRenameInstance={handleRename} onWorkDirChange={handleWorkDir} onRemoveInstance={handleRemove} />
              </>
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
                const theme = inst.roleKey === null ? CUSTOM_THEME : (roles[inst.roleKey] ?? roles.developer);
                const isMain = mainAgentKey === inst.key;
                return (
                  <span key={inst.key} data-testid="selected-member" data-main={isMain ? "true" : "false"} onClick={() => setMainAgentKey(isMain ? null : inst.key)} style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: `${space.xs - 1}px ${space.sm}px`, borderRadius: radius.pill, backgroundColor: isMain ? "#FFF7ED" : theme.bg, border: `1px solid ${isMain ? "#F59E0B" : theme.border}`, color: isMain ? "#D97706" : theme.color, fontSize: fontSize.sm, fontWeight: 500, cursor: "pointer" }}>
                    <span aria-hidden style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: "50%", border: `1.5px solid ${isMain ? "#F59E0B" : neutral[300]}`, backgroundColor: isMain ? "#F59E0B" : "transparent", color: "#FFF", fontSize: 10 }}>{isMain ? "★" : ""}</span>
                    <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: theme.color }} />
                    {inst.alias}
                    {isMain && <span style={{ fontSize: 10, fontWeight: 700, color: "#D97706" }}>主 Agent</span>}
                  </span>
                );
              })}
              {allInstances.length === 0 && <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>尚未选择成员</span>}
            </div>
            {mainAgentKey && <div style={{ fontSize: fontSize.xs, color: "#D97706" }}>★ 已选主 Agent：{allInstances.find((i) => i.key === mainAgentKey)?.alias}</div>}
          </div>

          <button type="button" data-testid="create-team-submit" disabled={createMutation.isPending} onClick={handleCreate} style={{ width: "100%", padding: `${space.md + 2}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#FFF", fontSize: fontSize.lg, fontWeight: 600, cursor: createMutation.isPending ? "default" : "pointer", opacity: createMutation.isPending ? 0.7 : 1, boxShadow: "0 6px 16px rgba(37,99,235,.3)", fontFamily: fontFamily.body }}>
            {createMutation.isPending ? "创建中…" : "创建团队"}
          </button>
        </section>
      </div>
    </div>
  );
}
