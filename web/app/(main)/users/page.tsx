"use client";

/**
 * 用户管理页（Phase 3 T10：原型保真迁移 + 接真实 API）
 * =====================================================
 * 保真迁移自 docs/agent-platform/prototypes/user-management/index.tsx（平台管理员视角）。
 * 导航由 AppShell（app/(main)/layout.tsx）提供（NavTopBar + NavDock + CmdKPanel），本页仅渲染内容区。
 *
 * - 数据源（T8 已完成）：
 *   - GET /users?page=&pageSize= → {items,total,page,pageSize}（items 含 roleId，不含角色名）
 *   - GET /roles → 角色列表（roleId → 角色名映射 + 新增用户弹层角色选择）
 *   - POST /users {username,password,displayName,email?,roleId} → 创建
 *   - PATCH /users/:id/status {enabled} → 禁用/启用（FR-22）
 *   - POST /users/:id/reset-password {newPassword} → 重置密码
 *
 * - 页面内扩展 token（仿原型 :35-43，不扩散共享层）：roleTheme（管理员蓝/成员绿）
 *   + statusTheme（启用绿/禁用红），语义独立于任务四态 statusColors 与 Agent 角色色；
 *   自定义角色（GET /roles 返回 admin/member 之外的角色）走 ROLE_FALLBACK 兜底灰蓝。
 * - data-testid 与原型一致：user-management-root/user-stats/add-user-button/user-item/
 *   user-role-badge/user-status-badge/user-edit-button/user-toggle-button/user-reset-button/
 *   user-form-overlay/user-form/username-input/user-email-input/user-password-input/
 *   user-role-select/user-form-cancel/user-form-submit。
 * - 弹层铁律（T15）：absolute + 零 fixed/vh/vw，宿主 position:relative（对齐 projects 页 CreateProjectModal）。
 * - 所属项目数：GET /users 返回 _count.projectMembers 真实计数（MOCK-05，原硬编码 0）。
 * - 编辑按钮：PATCH /users/:id（UpdateUserDto）→ 编辑弹层预填用户名/邮箱/角色，
 *   保存后列表刷新（ISSUE-002 修复：原为无 onClick 占位）。
 */
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { EmptyState, ConfirmDialog } from "@/src/components/ui";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 页面内语义色（仿原型 :35-43，未入 tokens.ts） ------------------------------
 * 用户角色（管理员蓝 / 成员绿）与状态（启用绿 / 禁用红）语义独立于任务四态（statusColors）
 * 与 Agent 角色色，遵循"扩展 token"范式在页面内定义具名常量并注释原因，不扩散共享层。
 */
const roleTheme = {
  管理员: { color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)", mark: "◈" },
  成员: { color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)", mark: "●" },
} as const;

const statusTheme = {
  启用: { color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)", mark: "✅" },
  禁用: { color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)", mark: "⛔" },
} as const;

/** 自定义角色兜底主题（GET /roles 除 admin/member 外的角色）：灰蓝 var(--color-neutral-600) 系，仿 statusColors 已归档 */
const ROLE_FALLBACK = {
  color: "var(--color-neutral-600)",
  bg: "var(--color-neutral-50)",
  border: "var(--color-neutral-300)",
  mark: "◈",
} as const;

/** 内置角色英文名 → 原型中文文案（seed r_admin/admin / r_member/member） */
const ROLE_LABEL: Record<string, string> = {
  admin: "管理员",
  member: "成员",
};

function roleLabel(name: string): string {
  return ROLE_LABEL[name] ?? name;
}

/* ------------------------------ API 数据模型（T8 DTO / 09 篇 §3.2） ------------------------------ */

/** GET /users 条目（SAFE_USER_SELECT：不含 passwordHash，含 roleId、enabled 与 _count.projectMembers）。 */
interface UserItem {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  roleId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** 所属项目数（findAll _count 关联统计，MOCK-05）。可选：findOne 等单用户端点不带。 */
  _count?: { projectMembers: number };
}

/** GET /users 分页响应。 */
interface UsersResponse {
  items: UserItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /roles 条目（角色下拉 + roleId→角色名映射数据源）。 */
interface RoleItem {
  id: string;
  name: string;
  permissions: unknown;
  scopes: unknown;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST /users 请求体（CreateUserDto；displayName 后端必填，取 username 兜底）。 */
interface CreateUserPayload {
  username: string;
  password: string;
  displayName: string;
  email?: string;
  roleId: string;
}

/* ------------------------------ 角色 / 状态解析（列表行 + 统计条） ------------------------------ */

/** roleId → 中文角色名；roles 未加载或找不到时原样返回 roleId（不崩列表）。 */
function resolveRoleLabel(roleId: string, roles: RoleItem[]): string {
  const role = roles.find((r) => r.id === roleId);
  return role ? roleLabel(role.name) : roleId;
}

/** 中文角色名 → 主题；管理员/成员走 roleTheme，其余（自定义/未知）走兜底。 */
function resolveRoleTheme(label: string) {
  return roleTheme[label as keyof typeof roleTheme] ?? ROLE_FALLBACK;
}

/* ------------------------------ 子组件 ------------------------------ */

/** 角色徽章（管理员蓝 / 成员绿 / 自定义灰蓝） */
function RoleBadge({ label }: { label: string }) {
  const theme = resolveRoleTheme(label);
  return (
    <span
      data-testid="user-role-badge"
      data-role={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs - 1}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      <span aria-hidden style={{ fontSize: fontSize.xs, lineHeight: 1 }}>{theme.mark}</span>
      {label}
    </span>
  );
}

/** 状态徽章（启用 ✅ 绿 / 禁用 ⛔ 红） */
function StatusBadge({ enabled }: { enabled: boolean }) {
  const label = enabled ? "启用" : "禁用";
  const theme = statusTheme[label];
  return (
    <span
      data-testid="user-status-badge"
      data-status={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs - 1}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>{theme.mark}</span>
      {label}
    </span>
  );
}

/** 用户表格行 */
function UserRow({
  user,
  roleLabel: roleLabelOf,
  onEdit,
  onToggle,
  onReset,
}: {
  user: UserItem;
  roleLabel: string;
  onEdit: (u: UserItem) => void;
  onToggle: (u: UserItem) => void;
  onReset: (u: UserItem) => void;
}) {
  const enabled = user.enabled;
  const roleThemeOf = resolveRoleTheme(roleLabelOf);
  return (
    <div
      data-testid="user-item"
      data-user-id={user.id}
      data-status={enabled ? "启用" : "禁用"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.md}px ${space.lg}px`,
        borderBottom: `1px solid ${neutral[100]}`,
        backgroundColor: enabled ? "var(--color-surface)" : neutral[50],
        ...baseFont,
      }}
    >
      {/* 头像 + 用户名 + 邮箱 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.md, flex: 2, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 34,
            height: 34,
            flexShrink: 0,
            borderRadius: "50%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: fontSize.md,
            fontWeight: 600,
            color: roleThemeOf.color,
            backgroundColor: roleThemeOf.bg,
            border: `1.5px solid ${roleThemeOf.border}`,
            userSelect: "none",
          }}
        >
          {(user.displayName || user.username).slice(0, 1).toUpperCase()}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800], fontFamily: fontFamily.mono }}>
              {user.username}
            </span>
            <RoleBadge label={roleLabelOf} />
          </div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.email || user.displayName}
          </div>
        </div>
      </div>

      {/* 所属项目数（GET /users _count.projectMembers 真实计数，MOCK-05） */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>{user._count?.projectMembers ?? 0}</div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>所属项目</div>
      </div>

      {/* 状态 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <StatusBadge enabled={enabled} />
      </div>

      {/* 操作：编辑 / 禁用 / 重置密码 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, justifyContent: "flex-end" }}>
        <button
          type="button"
          data-testid="user-edit-button"
          data-user-id={user.id}
          onClick={() => onEdit(user)}
          style={{
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            color: neutral[700],
            fontSize: fontSize.md,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          编辑
        </button>
        <button
          type="button"
          data-testid="user-toggle-button"
          data-user-id={user.id}
          onClick={() => onToggle(user)}
          style={{
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${enabled ? "rgba(239,68,68,0.22)" : neutral[200]}`,
            backgroundColor: enabled ? statusTheme["禁用"].bg : "var(--color-surface)",
            color: enabled ? statusTheme["禁用"].color : neutral[600],
            fontSize: fontSize.md,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          {enabled ? "禁用" : "启用"}
        </button>
        <button
          type="button"
          data-testid="user-reset-button"
          data-user-id={user.id}
          onClick={() => onReset(user)}
          style={{
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: "1px solid transparent",
            backgroundColor: neutral[100],
            color: neutral[600],
            fontSize: fontSize.md,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          重置密码
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ 新增用户弹层（受控开关：✕ / 遮罩 / Esc 关闭） ------------------------------ */

const formField: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  fontSize: fontSize.md,
  color: neutral[800],
  outline: "none",
  fontFamily: fontFamily.body,
};

interface UserFormModalProps {
  open: boolean;
  roles: RoleItem[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: CreateUserPayload) => void;
}

function UserFormModal({ open, roles, submitting, error, onClose, onSubmit }: UserFormModalProps) {
  /* 表单受控状态（对齐原型；角色由 GET /roles 驱动，默认选中成员角色） */
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // 每次打开重置表单 + 默认角色（成员优先，无则第一个）
  useEffect(() => {
    if (!open) return;
    setUsername("");
    setEmail("");
    setPassword("");
    setFormError(null);
    setRoleId(
      roles.find((r) => r.name === "member")?.id ?? roles[0]?.id ?? ""
    );
  }, [open, roles]);

  if (!open) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!username.trim() || !password || !roleId) return;
    if (password.length < 6) {
      setFormError("密码至少 6 位");
      return;
    }
    setFormError(null);
    onSubmit({
      username: username.trim(),
      password,
      displayName: username.trim(),
      email: email.trim() ? email.trim() : undefined,
      roleId,
    });
  };

  return (
    <div
      data-testid="user-form-overlay"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10%",
        ...baseFont,
      }}
    >
      {/* 轻遮罩：点击关闭 */}
      <div
        aria-hidden
        data-testid="user-form-mask"
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />

      {/* 表单卡片：毛玻璃 + 圆角 + 阴影 */}
      <form
        data-testid="user-form"
        onSubmit={handleSubmit}
        noValidate
        style={{
          position: "relative",
          width: 520,
          maxWidth: "calc(100% - 48px)",
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
        }}
      >
        {/* 头部：标题 + 关闭 */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.md }}>
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
              新增用户
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
              创建平台账号并分配角色（角色数据来自 GET /roles）
            </div>
          </div>
          <button
            type="button"
            data-testid="user-form-close"
            aria-label="关闭新增用户弹层"
            onClick={onClose}
            style={{
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

        {/* 用户名 */}
        <label style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>用户名</span>
          <input
            data-testid="username-input"
            placeholder="如 zhangwei"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={submitting}
            style={formField}
          />
        </label>

        {/* 邮箱 */}
        <label style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>邮箱</span>
          <input
            data-testid="user-email-input"
            type="email"
            placeholder="name@ketaops.cc"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            style={formField}
          />
        </label>

        {/* 初始密码 */}
        <label style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>初始密码</span>
          <input
            data-testid="user-password-input"
            type="password"
            placeholder="至少 6 位，首次登录后可修改"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setFormError(null);
            }}
            disabled={submitting}
            style={formField}
          />
        </label>

        {/* 角色选择（GET /roles 驱动按钮组，对齐原型 user-role-select 结构） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>角色</span>
          <div data-testid="user-role-select" style={{ display: "flex", gap: space.sm, flexWrap: "wrap" }}>
            {roles.length === 0 ? (
              <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>角色加载中…</span>
            ) : (
              roles.map((r) => {
                const label = roleLabel(r.name);
                const theme = resolveRoleTheme(label);
                const active = roleId === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    data-role={r.name}
                    data-active={active ? "true" : "false"}
                    onClick={() => setRoleId(r.id)}
                    disabled={submitting}
                    style={{
                      flex: 1,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: space.xs,
                      padding: `${space.sm}px ${space.md}px`,
                      borderRadius: radius.md,
                      border: `1px solid ${active ? theme.border : neutral[200]}`,
                      backgroundColor: active ? theme.bg : "var(--color-surface)",
                      color: active ? theme.color : neutral[600],
                      fontSize: fontSize.md,
                      fontWeight: active ? 600 : 500,
                      cursor: submitting ? "default" : "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>{theme.mark}</span>
                    {label}
                  </button>
                );
              })
            )}
          </div>
          <span style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>
            管理员可管理账号 / 项目 / 角色模板 / 全局策略；成员在所属项目内协作（02 篇 1.1 / 1.2）
          </span>
        </div>

        {/* 错误提示（本地校验优先，其次 API 错误） */}
        {formError || error ? (
          <div
            role="alert"
            data-testid="user-form-error"
            style={{ fontSize: fontSize.sm, color: "#DC2626", display: "flex", alignItems: "center", gap: space.xs }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {formError || error}
          </div>
        ) : null}

        {/* 底部：创建 / 取消 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm }}>
          <button
            type="button"
            data-testid="user-form-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[600],
              fontSize: fontSize.md,
              cursor: submitting ? "default" : "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            取消
          </button>
          <button
            type="submit"
            data-testid="user-form-submit"
            disabled={submitting || !username.trim() || !password || !roleId}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: "none",
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: submitting ? "default" : "pointer",
              opacity: submitting || !username.trim() || !password || !roleId ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "创建中…" : "创建用户"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------ 重置密码弹层（新增：POST /users/:id/reset-password） ------------------------------ */

interface ResetPasswordModalProps {
  open: boolean;
  target: UserItem | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (userId: string, newPassword: string) => void;
}

function ResetPasswordModal({ open, target, submitting, error, onClose, onSubmit }: ResetPasswordModalProps) {
  const [newPassword, setNewPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // 每次打开清空
  useEffect(() => {
    if (open) {
      setNewPassword("");
      setFormError(null);
    }
  }, [open]);

  if (!open || !target) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (submitting || !newPassword) return;
    if (newPassword.length < 6) {
      setFormError("密码至少 6 位");
      return;
    }
    setFormError(null);
    onSubmit(target.id, newPassword);
  };

  return (
    <div
      data-testid="user-reset-overlay"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10%",
        ...baseFont,
      }}
    >
      {/* 轻遮罩：点击关闭 */}
      <div
        aria-hidden
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />

      <form
        data-testid="user-reset-form"
        onSubmit={handleSubmit}
        noValidate
        style={{
          position: "relative",
          width: 420,
          maxWidth: "calc(100% - 48px)",
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.md }}>
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
              重置密码
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
              为账号「{target.username}」设置新密码（重置后原密码立即失效）
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭重置密码弹层"
            onClick={onClose}
            style={{
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

        <label style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>新密码</span>
          <input
            data-testid="user-reset-password-input"
            type="password"
            placeholder="至少 6 位"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setFormError(null);
            }}
            disabled={submitting}
            style={formField}
          />
        </label>

        {formError || error ? (
          <div
            role="alert"
            data-testid="user-reset-form-error"
            style={{ fontSize: fontSize.sm, color: "#DC2626", display: "flex", alignItems: "center", gap: space.xs }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {formError || error}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm }}>
          <button
            type="button"
            data-testid="user-reset-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[600],
              fontSize: fontSize.md,
              cursor: submitting ? "default" : "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            取消
          </button>
          <button
            type="submit"
            data-testid="user-reset-submit"
            disabled={submitting || !newPassword}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: "none",
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: submitting ? "default" : "pointer",
              opacity: submitting || !newPassword ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "重置中…" : "确认重置"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------ 编辑用户弹层（ISSUE-002 修复：预填用户名/邮箱/角色 → PATCH /users/:id） ------------------------------ */

/** PATCH /users/:id 请求体（email null = 清空邮箱）。 */
interface UpdateUserPayload {
  username: string;
  displayName: string;
  email: string | null;
  roleId: string;
}

interface EditUserModalProps {
  open: boolean;
  target: UserItem | null;
  roles: RoleItem[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (userId: string, payload: UpdateUserPayload) => void;
}

function EditUserModal({ open, target, roles, submitting, error, onClose, onSubmit }: EditUserModalProps) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // 每次打开预填目标用户（对齐原型编辑语义：用户名/邮箱/角色可改，密码不在编辑范围）
  useEffect(() => {
    if (!open || !target) return;
    setUsername(target.username);
    setEmail(target.email ?? "");
    setRoleId(target.roleId);
  }, [open, target]);

  if (!open || !target) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (submitting || !username.trim() || !roleId) return;
    onSubmit(target.id, {
      username: username.trim(),
      displayName: username.trim(),
      email: email.trim() ? email.trim() : null,
      roleId,
    });
  };

  return (
    <div
      data-testid="edit-user-overlay"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10%",
        ...baseFont,
      }}
    >
      {/* 轻遮罩：点击关闭 */}
      <div
        aria-hidden
        data-testid="edit-user-mask"
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />

      <form
        data-testid="edit-user-form"
        onSubmit={handleSubmit}
        noValidate
        style={{
          position: "relative",
          width: 520,
          maxWidth: "calc(100% - 48px)",
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
        }}
      >
        {/* 头部：标题 + 关闭 */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.md }}>
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
              编辑用户
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
              修改账号「{target.username}」的信息（保存后立即生效）
            </div>
          </div>
          <button
            type="button"
            data-testid="edit-user-close"
            aria-label="关闭编辑用户弹层"
            onClick={onClose}
            style={{
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

        {/* 用户名 */}
        <label style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>用户名</span>
          <input
            data-testid="edit-username-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={submitting}
            style={formField}
          />
        </label>

        {/* 邮箱 */}
        <label style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>邮箱</span>
          <input
            data-testid="edit-user-email-input"
            type="email"
            placeholder="name@ketaops.cc"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            style={formField}
          />
        </label>

        {/* 角色选择（GET /roles 驱动按钮组，对齐新增用户弹层结构） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>角色</span>
          <div data-testid="edit-user-role-select" style={{ display: "flex", gap: space.sm, flexWrap: "wrap" }}>
            {roles.length === 0 ? (
              <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>角色加载中…</span>
            ) : (
              roles.map((r) => {
                const label = roleLabel(r.name);
                const theme = resolveRoleTheme(label);
                const active = roleId === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    data-role={r.name}
                    data-active={active ? "true" : "false"}
                    onClick={() => setRoleId(r.id)}
                    disabled={submitting}
                    style={{
                      flex: 1,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: space.xs,
                      padding: `${space.sm}px ${space.md}px`,
                      borderRadius: radius.md,
                      border: `1px solid ${active ? theme.border : neutral[200]}`,
                      backgroundColor: active ? theme.bg : "var(--color-surface)",
                      color: active ? theme.color : neutral[600],
                      fontSize: fontSize.md,
                      fontWeight: active ? 600 : 500,
                      cursor: submitting ? "default" : "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>{theme.mark}</span>
                    {label}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div
            role="alert"
            data-testid="edit-user-error"
            style={{ fontSize: fontSize.sm, color: "#DC2626", display: "flex", alignItems: "center", gap: space.xs }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {error}
          </div>
        )}

        {/* 底部：保存 / 取消 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm }}>
          <button
            type="button"
            data-testid="edit-user-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[600],
              fontSize: fontSize.md,
              cursor: submitting ? "default" : "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            取消
          </button>
          <button
            type="submit"
            data-testid="edit-user-submit"
            disabled={submitting || !username.trim() || !roleId}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: "none",
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: submitting ? "default" : "pointer",
              opacity: submitting || !username.trim() || !roleId ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "保存中…" : "保存修改"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------ 页面主组件（AppShell 内容区） ------------------------------ */

export default function UsersPage() {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;
  const queryClient = useQueryClient();

  /* 新增用户弹层受控开关：默认关闭 */
  const [formOpen, setFormOpen] = useState(false);
  /* 重置密码弹层：target 非空即打开 */
  const [resetTarget, setResetTarget] = useState<UserItem | null>(null);
  /* 编辑用户弹层：target 非空即打开（ISSUE-002 修复） */
  const [editTarget, setEditTarget] = useState<UserItem | null>(null);
  /* 禁用/启用二次确认弹窗：target 非空即打开（OBS-003：误触禁用会让用户立即失去登录能力） */
  const [toggleTarget, setToggleTarget] = useState<UserItem | null>(null);
  /* 列表操作（禁用/启用）失败提示 */
  const [actionError, setActionError] = useState<string | null>(null);
  /* 搜索关键词（本地受控，UX-11：按用户名/显示名/邮箱前端过滤） */
  const [keyword, setKeyword] = useState("");

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["users"],
    queryFn: () =>
      api.get<UsersResponse>("/users", { query: { page: 1, pageSize: 100 } }),
    enabled: !!userId,
  });

  /* 角色下拉 + roleId→角色名映射数据源 */
  const { data: rolesData } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<RoleItem[]>("/roles"),
    enabled: !!userId,
  });
  const roles = rolesData ?? [];

  /* 禁用/启用：PATCH /users/:id/status {enabled}（FR-22） */
  const toggleMutation = useMutation({
    mutationFn: (payload: { id: string; enabled: boolean }) =>
      api.patch<UserItem>(`/users/${payload.id}/status`, { enabled: payload.enabled }),
    onSuccess: () => setActionError(null),
    onError: (err) =>
      setActionError(isApiError(err) ? err.message : "操作失败，请稍后重试"),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  /* 新增用户：POST /users */
  const createMutation = useMutation({
    mutationFn: (payload: CreateUserPayload) => api.post<UserItem>("/users", payload),
    onSuccess: () => {
      setFormOpen(false);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  /* 重置密码：POST /users/:id/reset-password */
  const resetMutation = useMutation({
    mutationFn: (payload: { id: string; newPassword: string }) =>
      api.post<UserItem>(`/users/${payload.id}/reset-password`, { newPassword: payload.newPassword }),
    onSuccess: () => {
      setResetTarget(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  /* 编辑用户：PATCH /users/:id（ISSUE-002 修复） */
  const updateMutation = useMutation({
    mutationFn: (payload: { id: string } & UpdateUserPayload) =>
      api.patch<UserItem>(`/users/${payload.id}`, {
        username: payload.username,
        displayName: payload.displayName,
        email: payload.email,
        roleId: payload.roleId,
      }),
    onSuccess: () => {
      setEditTarget(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const handleToggle = (u: UserItem) => {
    /* OBS-003：禁用/启用均为关键状态变更，先弹二次确认，确认后才 PATCH /users/:id/status */
    setToggleTarget(u);
  };

  const handleCreate = (payload: CreateUserPayload) => {
    createMutation.mutate(payload);
  };

  const handleReset = (userId: string, newPassword: string) => {
    resetMutation.mutate({ id: userId, newPassword });
  };

  const handleUpdate = (userId: string, payload: UpdateUserPayload) => {
    updateMutation.mutate({ id: userId, ...payload });
  };

  const items = data?.items ?? [];

  /* UX-11 搜索：按用户名/显示名/邮箱本地模糊过滤（关键词清空 = 全量） */
  const kw = keyword.trim().toLowerCase();
  const visibleItems =
    kw === ""
      ? items
      : items.filter((u) =>
          `${u.username} ${u.displayName} ${u.email ?? ""}`.toLowerCase().includes(kw)
        );

  /* 统计条（对齐原型 4 卡；管理员/成员按角色名分组，已禁用按 enabled=false） */
  const stats = [
    { label: "总用户", value: data?.total ?? items.length, theme: { color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)" } },
    { label: "管理员", value: items.filter((u) => resolveRoleLabel(u.roleId, roles) === "管理员").length, theme: roleTheme["管理员"] },
    { label: "成员", value: items.filter((u) => resolveRoleLabel(u.roleId, roles) === "成员").length, theme: roleTheme["成员"] },
    { label: "已禁用", value: items.filter((u) => !u.enabled).length, theme: statusTheme["禁用"] },
  ];

  return (
    <div
      data-testid="user-management-root"
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`,
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
      }}
    >
      {/* 统计条（平台管理员视角：账号总量与角色分布） */}
      <div
        data-testid="user-stats"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: space.md,
          marginBottom: space.xl,
        }}
      >
        {stats.map((s) => (
          <div
            key={s.label}
            data-stat={s.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.md,
              padding: `${space.lg}px ${space.xl}px`,
              borderRadius: radius.lg,
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.sm,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                flexShrink: 0,
                borderRadius: "50%",
                backgroundColor: s.theme.color,
              }}
            />
            <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>{s.label}</span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: fontSize.xxl,
                fontWeight: 700,
                color: s.theme.color,
                lineHeight: 1,
              }}
            >
              {s.value}
            </span>
          </div>
        ))}
      </div>

      {/* 操作行：搜索框 + 「新增用户」按钮 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.lg, marginBottom: space.lg }}>
        <div>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>账号列表</div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
            {data?.total ?? items.length} 个账号 · 平台内置账号体系 · 成员在所属项目内协作
          </div>
        </div>

        {/* 搜索框（按用户名/显示名/邮箱过滤，样式对齐模型页 model-search） */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            flex: 1,
            minWidth: 220,
            maxWidth: 320,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: "var(--color-surface)",
            border: `1px solid ${neutral[200]}`,
            boxShadow: shadow.sm,
            marginLeft: "auto",
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400], lineHeight: 1 }}>
            ⌕
          </span>
          <input
            data-testid="users-search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索用户名 / 邮箱…"
            aria-label="搜索用户"
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: fontSize.md,
              color: neutral[800],
              fontFamily: fontFamily.body,
            }}
          />
        </div>

        <button
          type="button"
          data-testid="add-user-button"
          onClick={() => setFormOpen(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm + 2}px ${space.lg}px`,
            borderRadius: radius.pill,
            border: "none",
            backgroundColor: "#2563EB",
            color: "#FFFFFF",
            fontSize: fontSize.md,
            fontWeight: 500,
            cursor: "pointer",
            boxShadow: "0 6px 16px rgba(37,99,235,.3)",
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>+</span>
          新增用户
        </button>
      </div>

      {/* 列表操作失败提示（禁用/启用） */}
      {actionError && (
        <div
          role="alert"
          data-testid="users-action-error"
          style={{
            marginBottom: space.md,
            padding: `${space.md}px ${space.lg}px`,
            borderRadius: radius.md,
            backgroundColor: statusTheme["禁用"].bg,
            border: `1px solid ${statusTheme["禁用"].border}`,
            fontSize: fontSize.sm,
            color: statusTheme["禁用"].color,
            ...baseFont,
          }}
        >
          操作失败：{actionError}
        </div>
      )}

      {/* 用户列表卡片 */}
      {isPending ? (
        <div data-testid="users-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}>
          加载中…
        </div>
      ) : isError ? (
        <div
          data-testid="users-error"
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: space.md,
            padding: `${space.xxl}px`,
            textAlign: "center",
            borderRadius: radius.lg,
            backgroundColor: "var(--color-surface)",
            border: `1px solid ${neutral[200]}`,
          }}
        >
          <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
            {isApiError(error) ? error.message : "加载用户列表失败"}
          </div>
          <button
            type="button"
            data-testid="users-retry"
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
      ) : items.length === 0 ? (
        <EmptyState
          title="暂无用户"
          description="创建第一个平台账号，开始分配角色与项目协作"
          icon={<span aria-hidden>☷</span>}
        />
      ) : visibleItems.length === 0 ? (
        /* UX-11：搜索无命中（复用 EmptyState，不带动作） */
        <EmptyState
          title="无匹配用户"
          description="换个关键词试试，或清空搜索查看全部账号"
          icon={<span aria-hidden>⌕</span>}
        />
      ) : (
        <div
          style={{
            borderRadius: radius.lg,
            backgroundColor: "var(--color-surface)",
            border: `1px solid ${neutral[200]}`,
            boxShadow: shadow.sm,
            overflow: "hidden",
          }}
        >
          {/* 表头 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.md,
              padding: `${space.md}px ${space.lg}px`,
              borderBottom: `1px solid ${neutral[200]}`,
              backgroundColor: neutral[50],
              fontSize: fontSize.sm,
              fontWeight: 600,
              color: neutral[500],
              ...baseFont,
            }}
          >
            <span style={{ flex: 2, minWidth: 0 }}>用户</span>
            <span style={{ flex: 1, minWidth: 0 }}>所属项目数</span>
            <span style={{ flex: 1, minWidth: 0 }}>状态</span>
            <span style={{ flex: 2, minWidth: 0, textAlign: "right" }}>操作</span>
          </div>

          {/* 用户行 */}
          {visibleItems.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              roleLabel={resolveRoleLabel(u.roleId, roles)}
              onEdit={setEditTarget}
              onToggle={handleToggle}
              onReset={setResetTarget}
            />
          ))}
        </div>
      )}

      {/* 底部说明（02 篇组织模型） */}
      <div
        data-testid="user-pool-hint"
        style={{
          marginTop: space.xl,
          padding: `${space.md}px ${space.lg}px`,
          borderRadius: radius.md,
          backgroundColor: "var(--color-surface)",
          border: `1px dashed ${neutral[200]}`,
          fontSize: fontSize.sm,
          color: neutral[400],
          lineHeight: 1.7,
          ...baseFont,
        }}
      >
        <span style={{ fontWeight: 600, color: neutral[500] }}>组织模型</span> ·
        平台采用「仅项目」模型：用户归属项目，在项目内以成员身份参与任务；平台管理员维护账号、
        项目生命周期与角色模板（02 篇 1.1），成员承担产品 / 架构 / 开发 / 测试分工（02 篇 1.2）。
      </div>

      {/* 新增用户弹层：受控开关（默认关闭） */}
      <UserFormModal
        open={formOpen}
        roles={roles}
        submitting={createMutation.isPending}
        error={createMutation.isError ? (isApiError(createMutation.error) ? createMutation.error.message : "创建失败，请稍后重试") : null}
        onClose={() => setFormOpen(false)}
        onSubmit={handleCreate}
      />

      {/* 重置密码弹层：target 非空即打开 */}
      <ResetPasswordModal
        open={resetTarget !== null}
        target={resetTarget}
        submitting={resetMutation.isPending}
        error={resetMutation.isError ? (isApiError(resetMutation.error) ? resetMutation.error.message : "重置失败，请稍后重试") : null}
        onClose={() => setResetTarget(null)}
        onSubmit={handleReset}
      />

      {/* 编辑用户弹层：target 非空即打开（ISSUE-002 修复） */}
      <EditUserModal
        open={editTarget !== null}
        target={editTarget}
        roles={roles}
        submitting={updateMutation.isPending}
        error={updateMutation.isError ? (isApiError(updateMutation.error) ? updateMutation.error.message : "保存失败，请稍后重试") : null}
        onClose={() => setEditTarget(null)}
        onSubmit={handleUpdate}
      />

      {/* 禁用/启用二次确认弹窗（OBS-003：误触禁用会让用户立即失去登录能力，确认后才 PATCH） */}
      <ConfirmDialog
        testid="confirm-toggle"
        open={toggleTarget !== null}
        title={toggleTarget?.enabled ? "禁用该用户？" : "启用该用户？"}
        description={
          toggleTarget
            ? toggleTarget.enabled
              ? `禁用后「${toggleTarget.username}」将无法登录平台（可随时重新启用）。`
              : `启用后「${toggleTarget.username}」可重新登录平台。`
            : undefined
        }
        confirmLabel={toggleTarget?.enabled ? "确认禁用" : "确认启用"}
        pendingLabel="处理中…"
        danger={toggleTarget?.enabled ?? true}
        submitting={toggleMutation.isPending}
        onClose={() => setToggleTarget(null)}
        onConfirm={() => {
          if (toggleTarget) {
            toggleMutation.mutate({ id: toggleTarget.id, enabled: !toggleTarget.enabled });
          }
          setToggleTarget(null);
        }}
      />
    </div>
  );
}
