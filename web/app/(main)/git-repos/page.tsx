"use client";

/**
 * 仓库管理页 —— git 仓库凭证与 Agent 授权
 * =============================================
 * 管理员在此录入 git 仓库地址 + 认证方式（SSH 私钥 / HTTPS token）+ 授权给指定
 * Agent，凭证经 AES-256-GCM 加密落库、按 worker 活跃 agent 过滤下发（凭证面最小）。
 * 结构风格严格照 models 页（providers-tab）：
 *
 * - 数据源：GET /git-repos（成员只读，脱敏视图）→ useQuery(["git-repos"])；
 *   GET /agents（授权多选数据源，分页一次拉全量）→ useQuery(["agents"])。
 * - 列表行 GitRepoRow：repoUrl（mono）+ authType 徽章（SSH=蓝 / HTTPS=紫）+
 *   fingerprint（mono 脱敏）+ 授权 agents（tag 列表 + permission 小徽章）+ 状态
 *   徽章（已配置=绿，列表仅未吊销）+ 操作（配置/删除，isAdmin 专属）。
 * - 配置弹窗 GitRepoModal（仿 ConfigureModal 结构）：新建 = repoUrl 输入 +
 *   authType 下拉（切换 SSH textarea 私钥 / HTTPS password token）+ 授权 agent
 *   多选（checkbox，勾选默认 read/allow，额外「写权限」→ write/ask）；编辑 =
 *   同表单预填（key 留空 = 不更新凭证，仅更新授权）。
 * - 删除：ConfirmDialog 二次确认 → DELETE /git-repos/:id → invalidate ["git-repos"]。
 * - 权限：isAdmin（roleName==='admin'）控制新增/配置/删除，成员只读（后端
 *   AdminGuard 403 兜底）。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；root flex:1 铺满；token 引用
 *   @/src/theme/tokens；页面内扩展 authType 徽章 token（仿 credentialTheme 范式）。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { ConfirmDialog } from "@/src/components/ui";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";
import type {
  ApiAgent,
  AgentsResponse,
  CreateGitRepoPayload,
  GitGrantInput,
  GitGrantView,
  GitRepoView,
  UpdateGitRepoPayload,
} from "@/src/types/git-repos";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 页面内扩展 token（仿 credentialTheme 范式，不写 tokens.ts） ------------------------------ */

/** 认证方式徽章：SSH=蓝 / HTTPS=紫（页面内定义，语义独立于任务/凭据态）。 */
const authTypeTheme = {
  ssh_key: { label: "SSH", color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)" },
  https_token: { label: "HTTPS", color: "#7C3AED", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" },
} as const;

/** 授权权限小徽章：read=灰 / write=琥珀。 */
const permTheme = {
  read: { label: "read", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
  write: { label: "write", color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)" },
} as const;

/** 状态徽章（列表仅未吊销 → 已配置=绿常显）。 */
const statusTheme = {
  configured: { label: "已配置", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
} as const;

/** 行 hover / 过渡（scoped：gr 前缀避免污染） */
const rowCss = `
.gr-repo-row { transition: border-color .15s ease, background-color .15s ease; }
.gr-repo-row:hover { background-color: var(--color-neutral-50); }
`;

/* ------------------------------ 轻量按钮（仿 providers-tab ActionButton） ------------------------------ */

function ActionButton({
  testid,
  label,
  onClick,
  disabled,
  primary,
}: {
  testid: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs + 2}px ${space.md + 2}px`,
        borderRadius: radius.pill,
        border: primary ? "none" : `1px solid ${neutral[200]}`,
        backgroundColor: primary ? "#2563EB" : "var(--color-surface)",
        color: primary ? "#FFFFFF" : neutral[600],
        fontSize: fontSize.sm,
        fontWeight: 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
        fontFamily: fontFamily.body,
      }}
    >
      {label}
    </button>
  );
}

/* ------------------------------ 徽章子组件 ------------------------------ */

/** 认证方式徽章：SSH=蓝 / HTTPS=紫。 */
function AuthTypeBadge({ authType }: { authType: GitRepoView["authType"] }) {
  const theme = authTypeTheme[authType];
  return (
    <span
      data-testid="git-repo-auth-type"
      data-auth-type={authType}
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
        fontWeight: 600,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
        fontFamily: fontFamily.mono,
        ...baseFont,
      }}
    >
      {theme.label}
    </span>
  );
}

/** 授权 agent 权限小徽章：read=灰 / write=琥珀。 */
function PermBadge({ permission }: { permission: GitGrantView["permission"] }) {
  const theme = permTheme[permission];
  return (
    <span
      data-testid="git-repo-grant-perm"
      data-permission={permission}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "0 6px",
        borderRadius: radius.sm,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.xs,
        fontWeight: 600,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
        fontFamily: fontFamily.mono,
        ...baseFont,
      }}
    >
      {theme.label}
    </span>
  );
}

/** 授权 agents tag 列表：agent 名 + permission 小徽章；无授权显示「—」。 */
function GrantTags({ grants }: { grants: GitGrantView[] }) {
  if (grants.length === 0) {
    return (
      <span data-testid="git-repo-grants" data-empty="true" style={{ fontSize: fontSize.md, color: neutral[300] }}>
        —
      </span>
    );
  }
  return (
    <span
      data-testid="git-repo-grants"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.xs,
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      {grants.map((g) => (
        <span
          key={g.agentId}
          data-agent-id={g.agentId}
          data-permission={g.permission}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.xs}px ${space.sm}px`,
            borderRadius: radius.pill,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
            fontSize: fontSize.xs,
            color: neutral[700],
            whiteSpace: "nowrap",
            ...baseFont,
          }}
        >
          {g.name ?? g.agentId}
          <PermBadge permission={g.permission} />
        </span>
      ))}
    </span>
  );
}

/** 状态徽章：已配置=绿（列表仅未吊销，常显）。 */
function StatusBadge() {
  const theme = statusTheme.configured;
  return (
    <span
      data-testid="git-repo-status"
      data-status="configured"
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
        style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: theme.color, flexShrink: 0 }}
      />
      {theme.label}
    </span>
  );
}

/* ------------------------------ 数据行 ------------------------------ */

function GitRepoRow({
  repo,
  isAdmin,
  onConfigure,
  onDelete,
}: {
  repo: GitRepoView;
  isAdmin: boolean;
  onConfigure: (repo: GitRepoView) => void;
  onDelete: (repo: GitRepoView) => void;
}) {
  return (
    <div
      data-testid="git-repo-item"
      data-repo-id={repo.id}
      data-auth-type={repo.authType}
      className="gr-repo-row"
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
      {/* 仓库地址（mono） */}
      <span
        data-testid="git-repo-url"
        data-repo-url={repo.repoUrl}
        style={{
          width: 240,
          flexShrink: 0,
          fontSize: fontSize.md,
          fontWeight: 600,
          color: neutral[800],
          fontFamily: fontFamily.mono,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {repo.repoUrl}
      </span>

      {/* 认证方式徽章 */}
      <span style={{ width: 84, flexShrink: 0 }}>
        <AuthTypeBadge authType={repo.authType} />
      </span>

      {/* 指纹（mono，脱敏展示） */}
      <span
        data-testid="git-repo-fingerprint"
        data-fingerprint={repo.fingerprint ?? ""}
        style={{
          width: 160,
          flexShrink: 0,
          fontSize: fontSize.sm,
          fontFamily: fontFamily.mono,
          color: repo.fingerprint ? neutral[500] : neutral[300],
          letterSpacing: "0.02em",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {repo.fingerprint ?? "—"}
      </span>

      {/* 授权 agents（tag 列表 + permission 小徽章） */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <GrantTags grants={repo.grantedAgents} />
      </div>

      {/* 状态徽章（已配置常绿） */}
      <span style={{ width: 88, flexShrink: 0 }}>
        <StatusBadge />
      </span>

      {/* 操作：配置 / 删除（admin 专属；成员只读无操作） */}
      <div
        style={{
          width: 160,
          flexShrink: 0,
          display: "flex",
          justifyContent: "flex-end",
          gap: space.sm,
        }}
      >
        {isAdmin && (
          <>
            <ActionButton
              testid="git-repo-configure"
              label="配置"
              primary
              onClick={() => onConfigure(repo)}
            />
            <ActionButton
              testid="git-repo-delete"
              label="删除"
              onClick={() => onDelete(repo)}
            />
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ 配置弹窗（仿 ConfigureModal 结构） ------------------------------ */

interface GitRepoModalProps {
  /** null=关闭；{mode:"create"}=新建；{mode:"edit",repo}=编辑 */
  state: { mode: "create" } | { mode: "edit"; repo: GitRepoView } | null;
  submitting: boolean;
  error: string | null;
  agents: ApiAgent[];
  onClose: () => void;
  onSubmit: (payload: CreateGitRepoPayload | UpdateGitRepoPayload) => void;
}

/** 配置弹窗：新建（repoUrl+authType+key+授权多选）/ 编辑（同表单预填，key 留空=不更新凭证）。 */
function GitRepoModal({
  state,
  submitting,
  error,
  agents,
  onClose,
  onSubmit,
}: GitRepoModalProps) {
  const open = state !== null;
  const editing = state !== null && state.mode === "edit" ? state.repo : null;

  const [repoUrl, setRepoUrl] = useState("");
  const [authType, setAuthType] = useState<"ssh_key" | "https_token">("ssh_key");
  const [key, setKey] = useState("");
  /** 勾选的 agent（授权中）；勾选默认 read/allow */
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  /** 额外勾选「写权限」的 agent → write/ask */
  const [writeAgents, setWriteAgents] = useState<Set<string>>(new Set());

  /* Esc 关闭（对齐 ConfigureModal 模式） */
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  /* 打开时重置/预填表单：新建清空；编辑从 repo.grantedAgents 预填授权 */
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setRepoUrl(editing.repoUrl);
      setAuthType(editing.authType);
      setKey("");
      setSelectedAgents(new Set(editing.grantedAgents.map((g) => g.agentId)));
      setWriteAgents(
        new Set(
          editing.grantedAgents
            .filter((g) => g.permission === "write")
            .map((g) => g.agentId)
        )
      );
    } else {
      setRepoUrl("");
      setAuthType("ssh_key");
      setKey("");
      setSelectedAgents(new Set());
      setWriteAgents(new Set());
    }
  }, [open, editing]);

  if (!open) return null;

  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "var(--color-surface)",
    fontSize: fontSize.md,
    color: neutral[800],
    outline: "none",
    fontFamily: fontFamily.body,
  };

  const toggleAgent = (id: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    /* 取消授权时同步移除「写权限」 */
    if (selectedAgents.has(id)) {
      setWriteAgents((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const toggleWrite = (id: string) => {
    setWriteAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /* 保存 payload：授权全量重建（默认 read/allow；写权限 → write/ask，对齐 17 篇 §3.3） */
  const handleSave = () => {
    const grantedAgents: GitGrantInput[] = Array.from(selectedAgents).map((id) => {
      const write = writeAgents.has(id);
      return {
        agentId: id,
        permission: write ? "write" : "read",
        effect: write ? "ask" : "allow",
      };
    });
    if (editing) {
      onSubmit({
        ...(key.trim() ? { key: key.trim() } : {}),
        grantedAgents,
      } satisfies UpdateGitRepoPayload);
    } else {
      onSubmit({
        repoUrl: repoUrl.trim(),
        authType,
        key: key.trim(),
        grantedAgents,
      } satisfies CreateGitRepoPayload);
    }
  };

  const canSave = submitting
    ? false
    : repoUrl.trim().length > 0 && (editing ? true : key.trim().length > 0);

  return (
    <div
      data-testid="git-repo-modal"
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
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      <div
        style={{
          position: "relative",
          width: 520,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "calc(100% - 64px)",
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
              {editing ? "配置仓库授权" : "新增仓库"}
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
              {editing
                ? "key 留空 = 保留原凭证，仅更新 Agent 授权"
                : "凭证经 AES-256-GCM 加密落库，保存后按活跃 Agent 下发"}
            </div>
          </div>
          <button
            type="button"
            data-testid="git-repo-modal-cancel"
            aria-label="关闭配置弹窗"
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

        {/* 仓库地址 */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
            仓库地址 <span aria-hidden style={{ color: "#DC2626" }}>*</span>
          </span>
          <input
            data-testid="git-repo-modal-url"
            type="text"
            placeholder="git@gitee.com:xishuhq/repo.git 或 https://gitee.com/xishuhq/repo.git"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            disabled={submitting || !!editing}
            style={{ ...inputBase, fontFamily: fontFamily.mono, ...(editing ? { backgroundColor: neutral[50], color: neutral[500] } : {}) }}
          />
          {editing && (
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
              仓库地址创建后不可修改，仅更新凭证 / 授权
            </span>
          )}
        </div>

        {/* 认证方式下拉（SSH 切换私钥 textarea / HTTPS 切换 token password） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
            认证方式 <span aria-hidden style={{ color: "#DC2626" }}>*</span>
          </span>
          <select
            data-testid="git-repo-modal-auth-type"
            value={authType}
            onChange={(e) => setAuthType(e.target.value as "ssh_key" | "https_token")}
            disabled={submitting || !!editing}
            style={{ ...inputBase, cursor: editing ? "default" : "pointer" }}
          >
            <option value="ssh_key">SSH 私钥</option>
            <option value="https_token">HTTPS Token</option>
          </select>
        </div>

        {/* 凭证输入：SSH=textarea 私钥 / HTTPS=password token */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
            {authType === "ssh_key" ? "SSH 私钥" : "HTTPS Token"}{" "}
            {editing && <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>（留空 = 不更新）</span>}
            {!editing && <span aria-hidden style={{ color: "#DC2626" }}>*</span>}
          </span>
          {authType === "ssh_key" ? (
            <textarea
              data-testid="git-repo-modal-key"
              rows={4}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={submitting}
              style={{ ...inputBase, fontFamily: fontFamily.mono, resize: "vertical", minHeight: 96 }}
            />
          ) : (
            <input
              data-testid="git-repo-modal-key"
              type="password"
              placeholder="输入 HTTPS 访问 token"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={submitting}
              style={{ ...inputBase, fontFamily: fontFamily.mono }}
            />
          )}
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            明文仅提交一次，响应只返回脱敏 fingerprint，回显永远看不到 key
          </span>
        </div>

        {/* 授权 Agent 多选（checkbox：勾选默认 read/allow；「写权限」→ write/ask） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              授权 Agent
            </span>
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
              勾选后该 Agent 可 clone/pull/fetch（read）；「写权限」额外允许 push
            </span>
          </div>
          <div
            data-testid="git-repo-modal-agents"
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
            {agents.length === 0 ? (
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                暂无 Agent，先到「Agent 管理」创建
              </span>
            ) : (
              agents.map((a) => {
                const checked = selectedAgents.has(a.id);
                const write = checked && writeAgents.has(a.id);
                return (
                  <label
                    key={a.id}
                    data-agent-id={a.id}
                    data-checked={checked ? "true" : "false"}
                    data-write={write ? "true" : "false"}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.sm,
                      padding: `${space.xs + 2}px ${space.md}px`,
                      borderRadius: radius.md,
                      backgroundColor: checked ? "rgba(37,99,235,0.10)" : "var(--color-surface)",
                      border: `1px solid ${checked ? "rgba(37,99,235,0.22)" : neutral[200]}`,
                      cursor: "pointer",
                      fontSize: fontSize.md,
                      color: neutral[700],
                      fontFamily: fontFamily.body,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAgent(a.id)}
                      style={{ accentColor: "#2563EB", cursor: "pointer" }}
                    />
                    {a.name}
                    <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                      {a.role ? `· ${a.role}` : ""}
                    </span>
                    {/* 「写权限」副复选框（仅授权勾选后可勾） */}
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: space.xs,
                        marginLeft: "auto",
                        padding: "0 6px",
                        borderRadius: radius.sm,
                        backgroundColor: write ? "rgba(245,158,11,0.10)" : "var(--color-surface)",
                        border: `1px solid ${write ? "rgba(245,158,11,0.28)" : neutral[200]}`,
                        opacity: checked ? 1 : 0.45,
                      }}
                    >
                      <input
                        type="checkbox"
                        data-testid="git-repo-modal-write"
                        checked={write}
                        disabled={!checked || submitting}
                        onChange={() => toggleWrite(a.id)}
                        style={{ accentColor: "#D97706", cursor: checked ? "pointer" : "default" }}
                      />
                      <span style={{ fontSize: fontSize.xs, color: neutral[600] }}>写权限</span>
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>

        {error && (
          <div
            data-testid="git-repo-modal-error"
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

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button
            type="button"
            data-testid="git-repo-modal-cancel"
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
            type="button"
            data-testid="git-repo-modal-save"
            disabled={!canSave}
            onClick={handleSave}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: canSave ? "pointer" : "default",
              opacity: canSave ? 1 : 0.6,
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "保存中…" : editing ? "保存配置" : "创建并授权"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================ 页面主组件 ================================ */

export default function GitReposPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.roleName === "admin";
  const queryClient = useQueryClient();

  /* 配置弹窗（null=关闭；create=新建；edit=编辑指定仓库） */
  const [modal, setModal] = useState<{ mode: "create" } | { mode: "edit"; repo: GitRepoView } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  /* 删除确认弹窗（target=repo，非 null 即打开——OBS-003：删除不可恢复，需二次确认） */
  const [deleteTarget, setDeleteTarget] = useState<GitRepoView | null>(null);

  /* 列表：GET /git-repos（成员只读，脱敏视图） */
  const reposQuery = useQuery({
    queryKey: ["git-repos"],
    queryFn: () => api.get<GitRepoView[]>("/git-repos"),
    enabled: !!user,
  });
  const repos = reposQuery.data ?? [];

  /* Agent 数据源：GET /agents（授权多选，分页一次拉全量） */
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<AgentsResponse>("/agents", { query: { page: 1, pageSize: 100 } }),
    enabled: !!user,
  });
  const agents = agentsQuery.data?.items ?? [];

  /* 保存（新建 POST / 编辑 PATCH）：成功后刷新列表并关闭弹窗 */
  const saveMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id?: string;
      payload: CreateGitRepoPayload | UpdateGitRepoPayload;
    }) =>
      id
        ? api.patch<GitRepoView>(`/git-repos/${id}`, payload)
        : api.post<GitRepoView>("/git-repos", payload),
    onSuccess: () => {
      setModal(null);
      setModalError(null);
      queryClient.invalidateQueries({ queryKey: ["git-repos"] });
    },
    onError: (err) => {
      setModalError(isApiError(err) ? err.message : "保存失败，请稍后重试");
    },
  });

  /* 删除（软撤销）：DELETE /git-repos/:id → 刷新列表 */
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ id: string; revokedAt: string }>(`/git-repos/${id}`),
    onSuccess: () => {
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["git-repos"] });
    },
    onError: (err) => {
      setDeleteTarget(null);
      setModalError(isApiError(err) ? err.message : "删除失败，请稍后重试");
    },
  });

  /* 计数：仓库总数 + 去重授权 Agent 数 */
  const grantedAgentCount = useMemo(() => {
    const ids = new Set<string>();
    for (const r of repos) for (const g of r.grantedAgents) ids.add(g.agentId);
    return ids.size;
  }, [repos]);

  const editingRepo = modal !== null && modal.mode === "edit" ? modal.repo : null;

  return (
    <div
      data-testid="git-repos-root"
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
        overflow: "auto",
      }}
    >
      <style>{rowCss}</style>

      <main style={{ flex: 1, minHeight: 0, padding: `${space.xl}px` }}>
        <div
          style={{
            maxWidth: 1080,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: space.lg,
          }}
        >
          {/* ① 工具条：标题 + 计数徽章 + 说明 + 新增（admin 专属） */}
          <div
            data-testid="git-repos-toolbar"
            style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}
          >
            <span style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900] }}>
              仓库管理
            </span>
            <span
              data-testid="git-repos-count"
              style={{
                fontSize: fontSize.xs,
                color: neutral[500],
                backgroundColor: "var(--color-surface)",
                border: `1px solid ${neutral[200]}`,
                borderRadius: radius.pill,
                padding: "2px 10px",
                fontFamily: fontFamily.mono,
              }}
            >
              {repos.length} 个仓库 · 已授权 {grantedAgentCount} 个 Agent
            </span>
            <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: "auto" }}>
              {isAdmin
                ? "凭证加密存储 · 按活跃 Agent 过滤下发到 Worker"
                : "成员只读 · 配置需管理员权限"}
            </span>
            {isAdmin && (
              <ActionButton
                testid="git-repos-add"
                label="新增仓库"
                primary
                onClick={() => {
                  setModalError(null);
                  setModal({ mode: "create" });
                }}
              />
            )}
          </div>

          {/* 列表状态：loading / error */}
          {reposQuery.isPending ? (
            <div
              data-testid="git-repos-loading"
              style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xxl}px 0`, textAlign: "center" }}
            >
              加载中…
            </div>
          ) : reposQuery.isError ? (
            <div
              data-testid="git-repos-error"
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
                {isApiError(reposQuery.error) ? reposQuery.error.message : "加载仓库列表失败"}
              </div>
              <button
                type="button"
                data-testid="git-repos-retry"
                onClick={() => reposQuery.refetch()}
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
            /* ② 仓库列表（白卡容器 + 表头行 + 数据行） */
            <div
              data-testid="git-repos-list"
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
                  已配置仓库
                </span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  凭证按仓库粒度加密存储 · 授权 Agent 在任务中可直接 clone/pull/push（push 需写权限）
                </span>
              </div>

              {/* 表头行（列宽与数据行一致） */}
              <div
                aria-hidden
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.lg,
                  padding: `${space.sm}px ${space.xl}px`,
                  fontSize: fontSize.xs,
                  fontWeight: 600,
                  color: neutral[400],
                  letterSpacing: "0.03em",
                }}
              >
                <span style={{ width: 240, flexShrink: 0 }}>仓库地址</span>
                <span style={{ width: 84, flexShrink: 0 }}>认证方式</span>
                <span style={{ width: 160, flexShrink: 0 }}>指纹</span>
                <span style={{ flex: 1, minWidth: 0 }}>授权 Agent</span>
                <span style={{ width: 88, flexShrink: 0 }}>状态</span>
                <span style={{ width: 160, flexShrink: 0, textAlign: "right" }}>操作</span>
              </div>

              {/* 数据行 */}
              {repos.map((repo) => (
                <GitRepoRow
                  key={repo.id}
                  repo={repo}
                  isAdmin={isAdmin}
                  onConfigure={(r) => {
                    setModalError(null);
                    setModal({ mode: "edit", repo: r });
                  }}
                  onDelete={(r) => {
                    setModalError(null);
                    setDeleteTarget(r);
                  }}
                />
              ))}

              {/* 空态 */}
              {repos.length === 0 && (
                <div
                  style={{
                    padding: `${space.xxl}px`,
                    textAlign: "center",
                    fontSize: fontSize.md,
                    color: neutral[400],
                  }}
                >
                  暂无仓库，{isAdmin ? "点右上角「新增仓库」配置 git 仓库凭证与授权" : "请管理员配置 git 仓库凭证"}
                </div>
              )}
            </div>
          )}

          {/* 底部说明 */}
          <div
            data-testid="git-repos-hint"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.xs,
              fontSize: fontSize.xs,
              color: neutral[400],
            }}
          >
            <span aria-hidden style={{ fontSize: fontSize.sm }}>◷</span>
            凭证经 AES-256-GCM 加密落库，响应仅返回脱敏 fingerprint · 按活跃 Agent 过滤下发到
            Worker（凭证面=worker 级）· read=allow、write=ask（push 默认需成员确认）
          </div>
        </div>
      </main>

      {/* 配置弹窗（admin 专属：新增 / 编辑） */}
      <GitRepoModal
        state={modal}
        submitting={saveMutation.isPending}
        error={modalError}
        agents={agents}
        onClose={() => {
          setModal(null);
          setModalError(null);
        }}
        onSubmit={(payload) =>
          saveMutation.mutate({ id: editingRepo?.id, payload })
        }
      />

      {/* 删除二次确认弹窗（OBS-003：删除不可恢复，确认后才 DELETE） */}
      <ConfirmDialog
        testid="git-repo-delete"
        open={deleteTarget !== null}
        title="删除仓库凭证"
        description={
          deleteTarget
            ? `确认删除 ${deleteTarget.repoUrl}？删除后该仓库凭证与全部授权一并撤销，相关 Agent 将无法再 clone/pull/push，且不可恢复。`
            : undefined
        }
        confirmLabel="确认删除"
        pendingLabel="删除中…"
        submitting={deleteMutation.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
