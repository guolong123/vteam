"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { ConfirmDialog, SegmentedTabs } from "@/src/components/ui";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";
import type {
  ApiAgent,
  AgentsResponse,
  CreateGitCredentialPayload,
  CreateGitRepoPayload,
  GitCredentialView,
  GitGrantInput,
  GitGrantView,
  GitRepoView,
  UpdateGitCredentialPayload,
  UpdateGitRepoPayload,
} from "@/src/types/git-repos";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

const authTypeTheme = {
  ssh_key: { label: "SSH", color: "#0D9488", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.22)" },
  https_token: { label: "HTTPS", color: "#7C3AED", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" },
} as const;

const permTheme = {
  read: { label: "read", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
  write: { label: "write", color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)" },
} as const;

const statusTheme = {
  configured: { label: "已配置", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
} as const;

const rowCss = `
.gr-repo-row { transition: border-color .15s ease, background-color .15s ease; }
.gr-repo-row:hover { background-color: var(--color-neutral-50); }
`;

function ActionButton({ testid, label, onClick, disabled, primary }: { testid: string; label: string; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button type="button" data-testid={testid} onClick={onClick} disabled={disabled} style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: `${space.xs + 2}px ${space.md + 2}px`, borderRadius: radius.pill, border: primary ? "none" : `1px solid ${neutral[200]}`, backgroundColor: primary ? "#0D9488" : "var(--color-surface)", color: primary ? "#FFFFFF" : neutral[600], fontSize: fontSize.sm, fontWeight: 500, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1, whiteSpace: "nowrap", fontFamily: fontFamily.body }}>
      {label}
    </button>
  );
}

function AuthTypeBadge({ authType }: { authType: GitRepoView["authType"] | GitCredentialView["authType"] }) {
  const theme = authTypeTheme[authType as keyof typeof authTypeTheme] ?? authTypeTheme.ssh_key;
  return (
    <span data-testid="git-repo-auth-type" data-auth-type={authType} style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: `${space.xs}px ${space.sm + 2}px`, borderRadius: radius.pill, backgroundColor: theme.bg, border: `1px solid ${theme.border}`, color: theme.color, fontSize: fontSize.sm, fontWeight: 600, lineHeight: 1.4, whiteSpace: "nowrap", flexShrink: 0, fontFamily: fontFamily.mono, ...baseFont }}>
      {theme.label}
    </span>
  );
}

const GRANT_VISIBLE_LIMIT = 3;

/** REPO_ROW_MIN_WIDTH 必须 ≥ ΣREPO_COLS + 72(gap) + 32(padding) + 3 个 chip + 「+N」的固有宽度（约 300px），否则窄屏下数据行被内容撑得比表头宽、列错位。改列宽需同步重算。 */
const REPO_COLS = {
  url: { width: 200, flexShrink: 0 },
  auth: { width: 68, flexShrink: 0 },
  cred: { width: 100, flexShrink: 0 },
  fingerprint: { width: 104, flexShrink: 0 },
  status: { width: 76, flexShrink: 0 },
  actions: { width: 140, flexShrink: 0 },
} as const;
const REPO_ROW_MIN_WIDTH = 1120;
const GRANTS_MIN_WIDTH = 260;

function matchGrant(g: GitGrantView, agentId: string | null, writeOnly: boolean) {
  if (agentId !== null && g.agentId !== agentId) return false;
  if (writeOnly && g.permission !== "write") return false;
  return true;
}

function selectGrants(grants: GitGrantView[], agentId: string | null, writeOnly: boolean) {
  if (agentId === null && !writeOnly) return grants;
  return grants.filter((g) => matchGrant(g, agentId, writeOnly));
}

function FilterChip({ active, label, count, onClick, testid }: { active: boolean; label: string; count?: number; onClick: () => void; testid?: string }) {
  return (
    <button type="button" data-testid={testid} aria-pressed={active} onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: "3px 10px", borderRadius: radius.pill, border: `1px solid ${active ? "rgba(13,148,136,0.28)" : neutral[200]}`, backgroundColor: active ? "rgba(13,148,136,0.10)" : "var(--color-surface)", color: active ? "#0D9488" : neutral[500], fontSize: fontSize.xs, fontWeight: active ? 600 : 500, lineHeight: 1.6, whiteSpace: "nowrap", cursor: "pointer", ...baseFont }}>
      {label}
      {count !== undefined && <span style={{ fontFamily: fontFamily.mono, opacity: 0.7 }}>{count}</span>}
    </button>
  );
}

function PermDot({ permission }: { permission: GitGrantView["permission"] }) {
  const theme = permTheme[permission];
  const write = permission === "write";
  return (
    <span
      data-testid="git-repo-grant-perm"
      data-permission={permission}
      aria-hidden
      style={{ boxSizing: "border-box", width: 6, height: 6, borderRadius: "50%", flexShrink: 0, backgroundColor: write ? theme.color : "transparent", border: write ? "none" : `1.5px solid ${theme.color}` }}
    />
  );
}

function GrantChip({ grant }: { grant: GitGrantView }) {
  const write = grant.permission === "write";
  const theme = permTheme[grant.permission];
  const label = grant.name ?? grant.agentId;
  return (
    <span
      data-agent-id={grant.agentId}
      data-permission={grant.permission}
      title={`${label} · ${write ? "write（可 push）" : "read（clone/pull）"}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: "2px 8px",
        borderRadius: radius.pill,
        backgroundColor: write ? theme.bg : "var(--color-surface)",
        border: `1px solid ${write ? theme.border : neutral[200]}`,
        color: write ? theme.color : neutral[600],
        fontSize: fontSize.xs,
        fontWeight: write ? 600 : 500,
        lineHeight: 1.6,
        whiteSpace: "nowrap",
        flexShrink: 0,
        ...baseFont,
      }}
    >
      <PermDot permission={grant.permission} />
      {label}
    </span>
  );
}

function GrantTags({ grants }: { grants: GitGrantView[] }) {
  const [expanded, setExpanded] = useState(false);
  if (grants.length === 0) return <span data-testid="git-repo-grants" data-empty="true" style={{ fontSize: fontSize.md, color: neutral[300] }}>—</span>;
  const visible = expanded ? grants : grants.slice(0, GRANT_VISIBLE_LIMIT);
  const hidden = grants.length - visible.length;
  return (
    <div
      data-testid="git-repo-grants"
      data-total={grants.length}
      data-expanded={expanded ? "true" : "false"}
      style={{ display: "flex", alignItems: "center", gap: space.xs, flexWrap: expanded ? "wrap" : "nowrap", overflow: "hidden", minWidth: 0 }}
    >
      {visible.map((g) => (<GrantChip key={g.agentId} grant={g} />))}
      {hidden > 0 && (
        <button type="button" data-testid="git-repo-grants-more" aria-expanded="false" title="展开全部授权 Agent" onClick={() => setExpanded(true)} style={{ display: "inline-flex", alignItems: "center", padding: "2px 6px", borderRadius: radius.pill, backgroundColor: "transparent", border: `1px dashed ${neutral[300]}`, color: neutral[500], fontSize: fontSize.xs, fontWeight: 600, lineHeight: 1.6, whiteSpace: "nowrap", flexShrink: 0, cursor: "pointer", ...baseFont }}>
          +{hidden}
        </button>
      )}
      {expanded && (
        <button type="button" data-testid="git-repo-grants-collapse" aria-expanded="true" onClick={() => setExpanded(false)} style={{ display: "inline-flex", alignItems: "center", padding: "2px 6px", borderRadius: radius.pill, backgroundColor: "transparent", border: `1px dashed ${neutral[300]}`, color: neutral[500], fontSize: fontSize.xs, fontWeight: 600, lineHeight: 1.6, whiteSpace: "nowrap", flexShrink: 0, cursor: "pointer", ...baseFont }}>
          收起
        </button>
      )}
    </div>
  );
}

function StatusBadge() {
  const theme = statusTheme.configured;
  return (
    <span data-testid="git-repo-status" data-status="configured" style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: `${space.xs}px ${space.sm + 2}px`, borderRadius: radius.pill, backgroundColor: theme.bg, border: `1px solid ${theme.border}`, color: theme.color, fontSize: fontSize.sm, fontWeight: 500, lineHeight: 1.4, whiteSpace: "nowrap", flexShrink: 0, ...baseFont }}>
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: theme.color, flexShrink: 0 }} />
      {theme.label}
    </span>
  );
}

function GitRepoRow({ repo, grants, isAdmin, onConfigure, onDelete }: { repo: GitRepoView; grants: GitGrantView[]; isAdmin: boolean; onConfigure: (repo: GitRepoView) => void; onDelete: (repo: GitRepoView) => void }) {
  return (
    <div data-testid="git-repo-item" data-repo-id={repo.id} data-auth-type={repo.authType} className="gr-repo-row" style={{ display: "flex", alignItems: "center", gap: space.md, minWidth: REPO_ROW_MIN_WIDTH, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, ...baseFont }}>
      <span data-testid="git-repo-url" data-repo-url={repo.repoUrl} title={repo.repoUrl} style={{ ...REPO_COLS.url, fontSize: fontSize.md, fontWeight: 600, color: neutral[800], fontFamily: fontFamily.mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{repo.repoUrl}</span>
      <span style={REPO_COLS.auth}><AuthTypeBadge authType={repo.authType} /></span>
      <span data-testid="git-repo-credential" title={repo.credentialName ?? repo.credentialId} style={{ ...REPO_COLS.cred, fontSize: fontSize.sm, color: neutral[600], whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{repo.credentialName ?? repo.credentialId}</span>
      <span data-testid="git-repo-fingerprint" data-fingerprint={repo.fingerprint ?? ""} style={{ ...REPO_COLS.fingerprint, fontSize: fontSize.sm, fontFamily: fontFamily.mono, color: repo.fingerprint ? neutral[500] : neutral[300], letterSpacing: "0.02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{repo.fingerprint ?? "—"}</span>
      <div style={{ flex: 1, minWidth: GRANTS_MIN_WIDTH }}><GrantTags grants={grants} /></div>
      <span style={REPO_COLS.status}><StatusBadge /></span>
      <div style={{ ...REPO_COLS.actions, display: "flex", justifyContent: "flex-end", gap: space.sm }}>
        {isAdmin && (<><ActionButton testid="git-repo-configure" label="配置" primary onClick={() => onConfigure(repo)} /><ActionButton testid="git-repo-delete" label="删除" onClick={() => onDelete(repo)} /></>)}
      </div>
    </div>
  );
}

function CredentialRow({ cred, isAdmin, onEdit, onDelete }: { cred: GitCredentialView; isAdmin: boolean; onEdit: (c: GitCredentialView) => void; onDelete: (c: GitCredentialView) => void }) {
  return (
    <div data-testid="git-credential-item" data-credential-id={cred.id} data-auth-type={cred.authType} className="gr-repo-row" style={{ display: "flex", alignItems: "center", gap: space.lg, minWidth: 1000, padding: `${space.lg}px ${space.xl}px`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, ...baseFont }}>
      <span data-testid="git-credential-name" style={{ width: 200, flexShrink: 0, fontSize: fontSize.md, fontWeight: 600, color: neutral[800], whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cred.name}</span>
      <span style={{ width: 84, flexShrink: 0 }}><AuthTypeBadge authType={cred.authType} /></span>
      <span data-testid="git-credential-fingerprint" style={{ width: 160, flexShrink: 0, fontSize: fontSize.sm, fontFamily: fontFamily.mono, color: cred.fingerprint ? neutral[500] : neutral[300] }}>{cred.fingerprint ?? "—"}</span>
      <span style={{ flex: 1, minWidth: 120, fontSize: fontSize.sm, color: neutral[500], whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cred.description ?? "—"}</span>
      <span style={{ width: 88, flexShrink: 0 }}><StatusBadge /></span>
      <div style={{ width: 160, flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: space.sm }}>
        {isAdmin && (<><ActionButton testid="git-credential-edit" label="编辑" primary onClick={() => onEdit(cred)} /><ActionButton testid="git-credential-delete" label="删除" onClick={() => onDelete(cred)} /></>)}
      </div>
    </div>
  );
}

interface GitRepoModalProps {
  state: { mode: "create" } | { mode: "edit"; repo: GitRepoView } | null;
  submitting: boolean;
  error: string | null;
  agents: ApiAgent[];
  credentials: GitCredentialView[];
  onClose: () => void;
  onSubmit: (payload: CreateGitRepoPayload | UpdateGitRepoPayload) => void;
}

function GitRepoModal({ state, submitting, error, agents, credentials, onClose, onSubmit }: GitRepoModalProps) {
  const open = state !== null;
  const editing = state !== null && state.mode === "edit" ? state.repo : null;
  const [repoUrl, setRepoUrl] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [writeAgents, setWriteAgents] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setRepoUrl(editing.repoUrl);
      setCredentialId(editing.credentialId);
      setSelectedAgents(new Set(editing.grantedAgents.map((g) => g.agentId)));
      setWriteAgents(new Set(editing.grantedAgents.filter((g) => g.permission === "write").map((g) => g.agentId)));
    } else {
      setRepoUrl("");
      setCredentialId(credentials[0]?.id ?? "");
      setSelectedAgents(new Set());
      setWriteAgents(new Set());
    }
  }, [open, editing, credentials]);

  if (!open) return null;
  const inputBase: CSSProperties = { width: "100%", boxSizing: "border-box", padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.md, color: neutral[800],fontFamily: fontFamily.body };
  const toggleAgent = (id: string) => {
    setSelectedAgents((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    if (selectedAgents.has(id)) setWriteAgents((prev) => { const next = new Set(prev); next.delete(id); return next; });
  };
  const toggleWrite = (id: string) => setWriteAgents((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const handleSave = () => {
    const grantedAgents: GitGrantInput[] = Array.from(selectedAgents).map((id) => ({ agentId: id, permission: writeAgents.has(id) ? "write" : "read", effect: writeAgents.has(id) ? "ask" : "allow" }));
    if (editing) onSubmit({ ...(credentialId ? { credentialId } : {}), grantedAgents } as UpdateGitRepoPayload);
    else onSubmit({ repoUrl: repoUrl.trim(), credentialId, grantedAgents } as CreateGitRepoPayload);
  };
  const canSave = submitting ? false : repoUrl.trim().length > 0 && !!credentialId;

  return (
    <div data-testid="git-repo-modal" style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "8%" }}>
      <div aria-hidden onClick={onClose} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }} />
      <div style={{ position: "relative", width: 520, maxWidth: "calc(100% - 48px)", maxHeight: "calc(100% - 64px)", overflowY: "auto", display: "flex", flexDirection: "column", gap: space.lg, padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.lg, fontFamily: fontFamily.body }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>{editing ? "配置仓库授权" : "新增仓库"}</div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>{editing ? "切换凭证或更新授权" : "选择已有凭证，凭证可在“凭证”Tab 中创建"}</div>
          </div>
          <button type="button" data-testid="git-repo-modal-cancel" aria-label="关闭" onClick={onClose} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, flexShrink: 0, borderRadius: "50%", border: "none", cursor: "pointer", backgroundColor: "transparent", color: neutral[400], fontSize: fontSize.lg, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>仓库地址 <span aria-hidden style={{ color: "#DC2626" }}>*</span></span>
          <input data-testid="git-repo-modal-url" type="text" placeholder="git@gitee.com:xishuhq/repo.git" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} disabled={submitting || !!editing} style={{ ...inputBase, fontFamily: fontFamily.mono, ...(editing ? { backgroundColor: neutral[50], color: neutral[500] } : {}) }} />
          {editing && <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>仓库地址创建后不可修改</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>关联凭证 <span aria-hidden style={{ color: "#DC2626" }}>*</span></span>
          <select data-testid="git-repo-modal-credential" value={credentialId} onChange={(e) => setCredentialId(e.target.value)} disabled={submitting} style={{ ...inputBase, cursor: "pointer" }}>
            {credentials.length === 0 && <option value="">暂无凭证，请先到“凭证”Tab 创建</option>}
            {credentials.map((c) => (<option key={c.id} value={c.id}>{c.name} · {c.authType === "ssh_key" ? "SSH" : "HTTPS"} · {c.fingerprint ?? ""}</option>))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>授权 Agent</span>
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>勾选可 clone/pull（read）；写权限额外允许 push</span>
          </div>
          <div data-testid="git-repo-modal-agents" style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}` }}>
            {agents.length === 0 ? <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>暂无 Agent</span> : agents.map((a) => {
              const checked = selectedAgents.has(a.id);
              const write = checked && writeAgents.has(a.id);
              return (
                <label key={a.id} data-agent-id={a.id} data-checked={checked ? "true" : "false"} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.xs + 2}px ${space.md}px`, borderRadius: radius.md, backgroundColor: checked ? "rgba(13,148,136,0.10)" : "var(--color-surface)", border: `1px solid ${checked ? "rgba(13,148,136,0.22)" : neutral[200]}`, cursor: "pointer", fontSize: fontSize.md, color: neutral[700] }}>
                  <input type="checkbox" checked={checked} onChange={() => toggleAgent(a.id)} style={{ accentColor: "#0D9488" }} />
                  {a.name}
                  <span style={{ display: "inline-flex", alignItems: "center", gap: space.xs, marginLeft: "auto", padding: "0 6px", borderRadius: radius.sm, backgroundColor: write ? "rgba(245,158,11,0.10)" : "var(--color-surface)", border: `1px solid ${write ? "rgba(245,158,11,0.28)" : neutral[200]}`, opacity: checked ? 1 : 0.45 }}>
                    <input type="checkbox" data-testid="git-repo-modal-write" checked={write} disabled={!checked || submitting} onChange={() => toggleWrite(a.id)} style={{ accentColor: "#D97706" }} />
                    <span style={{ fontSize: fontSize.xs, color: neutral[600] }}>写权限</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
        {error && <div data-testid="git-repo-modal-error" role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626", display: "flex", alignItems: "center", gap: space.xs }}><span aria-hidden style={{ fontWeight: 700 }}>!</span>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button type="button" data-testid="git-repo-modal-cancel" onClick={onClose} disabled={submitting} style={{ padding: `${space.sm + 2}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], fontSize: fontSize.md, fontWeight: 500, cursor: "pointer" }}>取消</button>
          <button type="button" data-testid="git-repo-modal-save" disabled={!canSave} onClick={handleSave} style={{ padding: `${space.sm + 2}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFFFFF", fontSize: fontSize.md, fontWeight: 500, cursor: canSave ? "pointer" : "default", opacity: canSave ? 1 : 0.6, boxShadow: "0 6px 16px rgba(13,148,136,.3)" }}>{submitting ? "保存中…" : editing ? "保存配置" : "创建并授权"}</button>
        </div>
      </div>
    </div>
  );
}

interface CredentialModalProps {
  state: { mode: "create" } | { mode: "edit"; cred: GitCredentialView } | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: CreateGitCredentialPayload | UpdateGitCredentialPayload) => void;
}

function CredentialModal({ state, submitting, error, onClose, onSubmit }: CredentialModalProps) {
  const open = state !== null;
  const editing = state !== null && state.mode === "edit" ? state.cred : null;
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<"ssh_key" | "https_token">("ssh_key");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    if (editing) { setName(editing.name); setAuthType(editing.authType); setKey(""); setDescription(editing.description ?? ""); }
    else { setName(""); setAuthType("ssh_key"); setKey(""); setDescription(""); }
  }, [open, editing]);
  if (!open) return null;
  const inputBase: CSSProperties = { width: "100%", boxSizing: "border-box", padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.md, color: neutral[800],fontFamily: fontFamily.body };
  const handleSave = () => {
    if (editing) onSubmit({ ...(name.trim() ? { name: name.trim() } : {}), ...(key.trim() ? { key: key.trim() } : {}), ...(description !== undefined ? { description: description.trim() } : {}) } as UpdateGitCredentialPayload);
    else onSubmit({ name: name.trim(), authType, key: key.trim(), description: description.trim() || undefined } as CreateGitCredentialPayload);
  };
  const canSave = submitting ? false : name.trim().length > 0 && (editing ? true : key.trim().length > 0);
  return (
    <div data-testid="git-credential-modal" style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "8%" }}>
      <div aria-hidden onClick={onClose} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }} />
      <div style={{ position: "relative", width: 520, maxWidth: "calc(100% - 48px)", maxHeight: "calc(100% - 64px)", overflowY: "auto", display: "flex", flexDirection: "column", gap: space.lg, padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.lg, fontFamily: fontFamily.body }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
          <div><div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>{editing ? "编辑凭证" : "新增凭证"}</div><div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>{editing ? "key 留空=保留原凭证" : "凭证创建后可被多仓库复用"}</div></div>
          <button type="button" onClick={onClose} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: "50%", border: "none", backgroundColor: "transparent", color: neutral[400], fontSize: fontSize.lg }}>✕</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>凭证名称 <span aria-hidden style={{ color: "#DC2626" }}>*</span></span>
          <input data-testid="git-credential-modal-name" type="text" placeholder="如 gitee-ssh-main" value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} style={inputBase} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>认证方式 <span aria-hidden style={{ color: "#DC2626" }}>*</span></span>
          <select data-testid="git-credential-modal-auth-type" value={authType} onChange={(e) => setAuthType(e.target.value as "ssh_key" | "https_token")} disabled={submitting || !!editing} style={{ ...inputBase, cursor: editing ? "default" : "pointer" }}>
            <option value="ssh_key">SSH 私钥</option>
            <option value="https_token">HTTPS Token</option>
          </select>
          {editing && <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>认证方式创建后不可修改</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>{authType === "ssh_key" ? "SSH 私钥" : "HTTPS Token"} {editing && <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>（留空=不更新）</span>}{!editing && <span aria-hidden style={{ color: "#DC2626" }}>*</span>}</span>
          {authType === "ssh_key" ? <textarea data-testid="git-credential-modal-key" rows={4} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={key} onChange={(e) => setKey(e.target.value)} disabled={submitting} style={{ ...inputBase, fontFamily: fontFamily.mono, resize: "vertical", minHeight: 96 }} /> : <input data-testid="git-credential-modal-key" type="password" placeholder="输入 HTTPS 访问 token" value={key} onChange={(e) => setKey(e.target.value)} disabled={submitting} style={{ ...inputBase, fontFamily: fontFamily.mono }} />}
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>明文仅提交一次，响应只返回脱敏 fingerprint</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>描述</span>
          <input data-testid="git-credential-modal-description" type="text" placeholder="可选说明" value={description} onChange={(e) => setDescription(e.target.value)} disabled={submitting} style={inputBase} />
        </div>
        {error && <div data-testid="git-credential-modal-error" role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626" }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button type="button" onClick={onClose} disabled={submitting} style={{ padding: `${space.sm + 2}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], fontSize: fontSize.md, fontWeight: 500, cursor: "pointer" }}>取消</button>
          <button type="button" data-testid="git-credential-modal-save" disabled={!canSave} onClick={handleSave} style={{ padding: `${space.sm + 2}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFFFFF", fontSize: fontSize.md, fontWeight: 500, cursor: canSave ? "pointer" : "default", opacity: canSave ? 1 : 0.6 }}> {submitting ? "保存中…" : editing ? "保存" : "创建"}</button>
        </div>
      </div>
    </div>
  );
}

export default function GitReposPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.roleName === "admin";
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"repos" | "credentials">("repos");
  const [repoModal, setRepoModal] = useState<{ mode: "create" } | { mode: "edit"; repo: GitRepoView } | null>(null);
  const [credModal, setCredModal] = useState<{ mode: "create" } | { mode: "edit"; cred: GitCredentialView } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [writeOnly, setWriteOnly] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GitRepoView | null>(null);
  const [deleteCredTarget, setDeleteCredTarget] = useState<GitCredentialView | null>(null);

  const reposQuery = useQuery({ queryKey: ["git-repos"], queryFn: () => api.get<GitRepoView[]>("/git-repos"), enabled: !!user });
  const repos = useMemo(() => reposQuery.data ?? [], [reposQuery.data]);
  const credsQuery = useQuery({ queryKey: ["git-credentials"], queryFn: () => api.get<GitCredentialView[]>("/git-credentials"), enabled: !!user });
  const credentials = credsQuery.data ?? [];
  const agentsQuery = useQuery({ queryKey: ["agents"], queryFn: () => api.get<AgentsResponse>("/agents", { query: { page: 1, pageSize: 100 } }), enabled: !!user });
  const agents = agentsQuery.data?.items ?? [];

  const saveRepoMutation = useMutation({
    mutationFn: ({ id, payload }: { id?: string; payload: CreateGitRepoPayload | UpdateGitRepoPayload }) => id ? api.patch<GitRepoView>(`/git-repos/${id}`, payload) : api.post<GitRepoView>("/git-repos", payload),
    onSuccess: () => { setRepoModal(null); setModalError(null); queryClient.invalidateQueries({ queryKey: ["git-repos"] }); },
    onError: (err) => setModalError(isApiError(err) ? err.message : "保存失败"),
  });
  const deleteRepoMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ id: string; revokedAt: string }>(`/git-repos/${id}`),
    onSuccess: () => { setDeleteTarget(null); queryClient.invalidateQueries({ queryKey: ["git-repos"] }); },
    onError: (err) => { setDeleteTarget(null); setModalError(isApiError(err) ? err.message : "删除失败"); },
  });
  const saveCredMutation = useMutation({
    mutationFn: ({ id, payload }: { id?: string; payload: CreateGitCredentialPayload | UpdateGitCredentialPayload }) => id ? api.patch<GitCredentialView>(`/git-credentials/${id}`, payload) : api.post<GitCredentialView>("/git-credentials", payload),
    onSuccess: () => { setCredModal(null); setModalError(null); queryClient.invalidateQueries({ queryKey: ["git-credentials"] }); queryClient.invalidateQueries({ queryKey: ["git-repos"] }); },
    onError: (err) => setModalError(isApiError(err) ? err.message : "保存失败"),
  });
  const deleteCredMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ id: string; revokedAt: string }>(`/git-credentials/${id}`),
    onSuccess: () => { setDeleteCredTarget(null); queryClient.invalidateQueries({ queryKey: ["git-credentials"] }); },
    onError: (err) => { setDeleteCredTarget(null); setModalError(isApiError(err) ? err.message : "删除失败，请确认无仓库引用"); },
  });

  const grantedAgentCount = useMemo(() => { const ids = new Set<string>(); for (const r of repos) for (const g of r.grantedAgents) ids.add(g.agentId); return ids.size; }, [repos]);

  const grantAgentOptions = useMemo(() => {
    const seen = new Map<string, { label: string; repos: number }>();
    for (const r of repos) for (const g of r.grantedAgents) {
      const cur = seen.get(g.agentId);
      if (cur) cur.repos += 1;
      else seen.set(g.agentId, { label: g.name ?? g.agentId, repos: 1 });
    }
    return Array.from(seen, ([id, v]) => ({ id, label: v.label, repos: v.repos }));
  }, [repos]);

  const writeRepoCount = useMemo(() => repos.filter((r) => r.grantedAgents.some((g) => g.permission === "write")).length, [repos]);

  const filteredRepos = useMemo(
    () => (agentFilter === null && !writeOnly ? repos : repos.map((repo) => ({ repo, grants: selectGrants(repo.grantedAgents, agentFilter, writeOnly) })).filter((r) => r.grants.length > 0).map((r) => r.repo)),
    [repos, agentFilter, writeOnly],
  );

  const grantsFor = useCallback((repo: GitRepoView) => selectGrants(repo.grantedAgents, agentFilter, writeOnly), [agentFilter, writeOnly]);
  const filterActive = agentFilter !== null || writeOnly;
  const clearFilter = () => { setAgentFilter(null); setWriteOnly(false); };
  const editingRepo = repoModal !== null && repoModal.mode === "edit" ? repoModal.repo : null;

  return (
    <div data-testid="git-repos-root" style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column", backgroundColor: neutral[50], fontFamily: fontFamily.body, overflow: "auto" }}>
      <style>{rowCss}</style>
      <main style={{ flex: 1, minHeight: 0, padding: space.xl }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", flexDirection: "column", gap: space.lg }}>
          <div data-testid="git-repos-toolbar" style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}>
            <span style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900] }}>仓库管理</span>
            <span data-testid="git-repos-count" style={{ fontSize: fontSize.xs, color: neutral[500], backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, borderRadius: radius.pill, padding: "2px 10px", fontFamily: fontFamily.mono }}>{filterActive ? `${filteredRepos.length} / ${repos.length} 个仓库` : `${repos.length} 个仓库`} · {credentials.length} 个凭证 · 已授权 {grantedAgentCount} 个 Agent</span>
            <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: "auto" }}>{isAdmin ? "凭证加密存储 · 按活跃 Agent 下发" : "成员只读"}</span>
          </div>

          {tab === "repos" && grantAgentOptions.length > 0 && (
            <div data-testid="git-repos-filters" style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>按 Agent 筛选</span>
              <FilterChip testid="git-repos-filter-all" active={!filterActive} label="全部" count={repos.length} onClick={clearFilter} />
              {grantAgentOptions.map((o) => (<FilterChip key={o.id} testid="git-repos-filter-agent" active={agentFilter === o.id} label={o.label} count={o.repos} onClick={() => { setWriteOnly(false); setAgentFilter((prev) => (prev === o.id ? null : o.id)); }} />))}
              <span aria-hidden style={{ width: 1, height: 16, backgroundColor: neutral[200], margin: "0 2px" }} />
              <FilterChip testid="git-repos-filter-write" active={writeOnly} label="仅看可写 push" count={writeRepoCount} onClick={() => { setAgentFilter(null); setWriteOnly((prev) => !prev); }} />
              {filterActive && (
                <button type="button" data-testid="git-repos-filter-clear" onClick={clearFilter} style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: "3px 10px", borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, backgroundColor: "transparent", color: neutral[500], fontSize: fontSize.xs, fontWeight: 500, lineHeight: 1.6, whiteSpace: "nowrap", cursor: "pointer", ...baseFont }}>
                  清除筛选
                </button>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: space.sm, alignItems: "center" }}>
            <SegmentedTabs
              items={[
                { key: "repos", label: "仓库", icon: "⌗" },
                { key: "credentials", label: "凭证", icon: "◈" },
              ]}
              active={tab}
              onChange={(k) => setTab(k as "repos" | "credentials")}
            />
            <div style={{ marginLeft: "auto", display: "flex", gap: space.sm, paddingBottom: 0 }}>
              {isAdmin && tab === "repos" && <ActionButton testid="git-repos-add" label="新增仓库" primary onClick={() => { setModalError(null); setRepoModal({ mode: "create" }); }} />}
              {isAdmin && tab === "credentials" && <ActionButton testid="git-credentials-add" label="新增凭证" primary onClick={() => { setModalError(null); setCredModal({ mode: "create" }); }} />}
            </div>
          </div>

          {tab === "repos" ? (
            reposQuery.isPending ? <div data-testid="git-repos-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xxl}px 0`, textAlign: "center" }}>加载中…</div> : reposQuery.isError ? <div data-testid="git-repos-error" role="alert" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: space.md, padding: space.xl }}><div style={{ color: "#DC2626" }}>{isApiError(reposQuery.error) ? reposQuery.error.message : "加载失败"}</div><button data-testid="git-repos-retry" onClick={() => reposQuery.refetch()} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)" }}>重试</button></div> : (
              <div data-testid="git-repos-list" style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: space.md, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.md, overflowX: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.sm}px ${space.md}px` }}><span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>已配置仓库</span><span style={{ fontSize: fontSize.xs, color: neutral[400] }}>凭证按仓库粒度复用 · 授权 Agent 可 clone/pull/push</span></div>
                <div aria-hidden style={{ display: "flex", alignItems: "center", gap: space.md, minWidth: REPO_ROW_MIN_WIDTH, padding: `${space.sm}px ${space.lg}px`, fontSize: fontSize.xs, fontWeight: 600, color: neutral[400] }}><span style={REPO_COLS.url}>仓库地址</span><span style={REPO_COLS.auth}>认证</span><span style={REPO_COLS.cred}>凭证</span><span style={REPO_COLS.fingerprint}>指纹</span><span style={{ flex: 1, minWidth: GRANTS_MIN_WIDTH }}>授权 Agent</span><span style={REPO_COLS.status}>状态</span><span style={{ ...REPO_COLS.actions, textAlign: "right" }}>操作</span></div>
                {filteredRepos.map((repo) => (<GitRepoRow key={repo.id} repo={repo} grants={grantsFor(repo)} isAdmin={isAdmin} onConfigure={(r) => { setModalError(null); setRepoModal({ mode: "edit", repo: r }); }} onDelete={(r) => { setModalError(null); setDeleteTarget(r); }} />))}
                {repos.length === 0 && <div style={{ padding: space.xxl, textAlign: "center", fontSize: fontSize.md, color: neutral[400] }}>暂无仓库，{isAdmin ? "点右上角“新增仓库”并选择已有凭证" : "请管理员配置"}</div>}
                {repos.length > 0 && filteredRepos.length === 0 && (
                  <div data-testid="git-repos-filter-empty" style={{ padding: space.xxl, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: space.md }}>
                    <span style={{ fontSize: fontSize.md, color: neutral[400] }}>没有匹配当前筛选的仓库</span>
                    <button type="button" data-testid="git-repos-filter-empty-clear" onClick={clearFilter} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], fontSize: fontSize.sm, fontWeight: 500, cursor: "pointer", ...baseFont }}>清除筛选</button>
                  </div>
                )}
              </div>
            )
          ) : (
            credsQuery.isPending ? <div data-testid="git-credentials-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xxl}px 0`, textAlign: "center" }}>加载中…</div> : credsQuery.isError ? <div data-testid="git-credentials-error" role="alert" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: space.md, padding: space.xl }}><div style={{ color: "#DC2626" }}>{isApiError(credsQuery.error) ? credsQuery.error.message : "加载失败"}</div><button data-testid="git-credentials-retry" onClick={() => credsQuery.refetch()} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>重试</button></div> : (
              <div data-testid="git-credentials-list" style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: space.md, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.md, overflowX: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.sm}px ${space.md}px` }}><span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>凭证池</span><span style={{ fontSize: fontSize.xs, color: neutral[400] }}>一个凭证可关联多仓库 · 名称全局唯一</span></div>
                <div aria-hidden style={{ display: "flex", alignItems: "center", gap: space.lg, minWidth: 1000, padding: `${space.sm}px ${space.xl}px`, fontSize: fontSize.xs, fontWeight: 600, color: neutral[400] }}><span style={{ width: 200, flexShrink: 0 }}>凭证名称</span><span style={{ width: 84, flexShrink: 0 }}>认证</span><span style={{ width: 160, flexShrink: 0 }}>指纹</span><span style={{ flex: 1, minWidth: 120 }}>描述</span><span style={{ width: 88, flexShrink: 0 }}>状态</span><span style={{ width: 160, flexShrink: 0, textAlign: "right" }}>操作</span></div>
                {credentials.map((c) => (<CredentialRow key={c.id} cred={c} isAdmin={isAdmin} onEdit={(cred) => { setModalError(null); setCredModal({ mode: "edit", cred }); }} onDelete={(cred) => { setModalError(null); setDeleteCredTarget(cred); }} />))}
                {credentials.length === 0 && <div style={{ padding: space.xxl, textAlign: "center", fontSize: fontSize.md, color: neutral[400] }}>暂无凭证，{isAdmin ? "点右上角“新增凭证”" : "请管理员创建"}</div>}
              </div>
            )
          )}

          <div data-testid="git-repos-hint" style={{ display: "flex", alignItems: "center", gap: space.xs, fontSize: fontSize.xs, color: neutral[400] }}>
            <span aria-hidden style={{ fontSize: fontSize.sm }}>◷</span>
            凭证经 AES-256-GCM 加密落库，响应仅 fingerprint · 按活跃 Agent 下发到 Worker · read=allow、write=ask
          </div>
        </div>
      </main>

      <GitRepoModal state={repoModal} submitting={saveRepoMutation.isPending} error={modalError} agents={agents} credentials={credentials} onClose={() => { setRepoModal(null); setModalError(null); }} onSubmit={(payload) => saveRepoMutation.mutate({ id: editingRepo?.id, payload })} />
      <CredentialModal state={credModal} submitting={saveCredMutation.isPending} error={modalError} onClose={() => { setCredModal(null); setModalError(null); }} onSubmit={(payload) => { const id = credModal && credModal.mode === "edit" ? credModal.cred.id : undefined; saveCredMutation.mutate({ id, payload }); }} />

      <ConfirmDialog testid="git-repo-delete" open={deleteTarget !== null} title="删除仓库" description={deleteTarget ? `确认删除 ${deleteTarget.repoUrl}？删除后授权一并撤销` : undefined} confirmLabel="确认删除" pendingLabel="删除中…" submitting={deleteRepoMutation.isPending} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (deleteTarget) deleteRepoMutation.mutate(deleteTarget.id); setDeleteTarget(null); }} />
      <ConfirmDialog testid="git-credential-delete" open={deleteCredTarget !== null} title="删除凭证" description={deleteCredTarget ? `确认删除凭证 ${deleteCredTarget.name}？被仓库引用时将 409 阻断` : undefined} confirmLabel="确认删除" pendingLabel="删除中…" submitting={deleteCredMutation.isPending} onClose={() => setDeleteCredTarget(null)} onConfirm={() => { if (deleteCredTarget) deleteCredMutation.mutate(deleteCredTarget.id); setDeleteCredTarget(null); }} />
    </div>
  );
}
