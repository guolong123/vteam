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
 * - 后端无「所属项目数」端点 → 列表展示兜底 0（对齐 project-list 页 EMPTY_TASK_COUNT 模式）。
 * - 编辑按钮：后端无 PATCH /users/:id → 保留原型占位（无 onClick）。
 */
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { EmptyState } from "@/src/components/ui";
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
  管理员: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE", mark: "◈" },
  成员: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0", mark: "●" },
} as const;

const statusTheme = {
  启用: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0", mark: "✅" },
  禁用: { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA", mark: "⛔" },
} as const;

/** 自定义角色兜底主题（GET /roles 除 admin/member 外的角色）：灰蓝 #475569 系，仿 statusColors 已归档 */
const ROLE_FALLBACK = {
  color: "#475569",
  bg: "#F8FAFC",
  border: "#CBD5E1",
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

/** GET /users 条目（SAFE_USER_SELECT：不含 passwordHash，含 roleId 与 enabled）。 */
interface UserItem {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  roleId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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

/** 后端无「所属项目数」端点 → 0 为真实兜底值（对齐 project-list 页 EMPTY_TASK_COUNT 模式）。 */
const EMPTY_PROJECT_COUNT = 0;

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
  onToggle,
  onReset,
}: {
  user: UserItem;
  roleLabel: string;
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
        backgroundColor: enabled ? "#FFFFFF" : neutral[50],
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

      {/* 所属项目数（后端无端点 → 兜底 0） */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>{EMPTY_PROJECT_COUNT}</div>
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
          style={{
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "#FFFFFF",
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
            border: `1px solid ${enabled ? "#FECACA" : neutral[200]}`,
            backgroundColor: enabled ? statusTheme["禁用"].bg : "#FFFFFF",
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
  backgroundColor: "#FFFFFF",
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
    setRoleId(
      roles.find((r) => r.name === "member")?.id ?? roles[0]?.id ?? ""
    );
  }, [open, roles]);

  if (!open) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!username.trim() || !password || !roleId) return;
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
          backgroundColor: "#FFFFFF",
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
            onChange={(e) => setPassword(e.target.value)}
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
                      backgroundColor: active ? theme.bg : "#FFFFFF",
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

        {/* 错误提示 */}
        {error && (
          <div
            role="alert"
            data-testid="user-form-error"
            style={{ fontSize: fontSize.sm, color: "#DC2626", display: "flex", alignItems: "center", gap: space.xs }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {error}
          </div>
        )}

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
              backgroundColor: "#FFFFFF",
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
    if (open) setNewPassword("");
  }, [open]);

  if (!open || !target) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (submitting || !newPassword) return;
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
          backgroundColor: "#FFFFFF",
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
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={submitting}
            style={formField}
          />
        </label>

        {error && (
          <div
            role="alert"
            style={{ fontSize: fontSize.sm, color: "#DC2626", display: "flex", alignItems: "center", gap: space.xs }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {error}
          </div>
        )}

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
              backgroundColor: "#FFFFFF",
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

/* ------------------------------ 页面主组件（AppShell 内容区） ------------------------------ */

export default function UsersPage() {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;
  const queryClient = useQueryClient();

  /* 新增用户弹层受控开关：默认关闭 */
  const [formOpen, setFormOpen] = useState(false);
  /* 重置密码弹层：target 非空即打开 */
  const [resetTarget, setResetTarget] = useState<UserItem | null>(null);
  /* 列表操作（禁用/启用）失败提示 */
  const [actionError, setActionError] = useState<string | null>(null);

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

  const handleToggle = (u: UserItem) => {
    toggleMutation.mutate({ id: u.id, enabled: !u.enabled });
  };

  const handleCreate = (payload: CreateUserPayload) => {
    createMutation.mutate(payload);
  };

  const handleReset = (userId: string, newPassword: string) => {
    resetMutation.mutate({ id: userId, newPassword });
  };

  const items = data?.items ?? [];

  /* 统计条（对齐原型 4 卡；管理员/成员按角色名分组，已禁用按 enabled=false） */
  const stats = [
    { label: "总用户", value: data?.total ?? items.length, theme: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" } },
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
              backgroundColor: "#FFFFFF",
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

      {/* 操作行：「新增用户」按钮 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: space.lg }}>
        <div>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>账号列表</div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
            {data?.total ?? items.length} 个账号 · 平台内置账号体系 · 成员在所属项目内协作
          </div>
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
            backgroundColor: "#FFFFFF",
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
      ) : items.length === 0 ? (
        <EmptyState
          title="暂无用户"
          description="创建第一个平台账号，开始分配角色与项目协作"
          icon={<span aria-hidden>☷</span>}
        />
      ) : (
        <div
          style={{
            borderRadius: radius.lg,
            backgroundColor: "#FFFFFF",
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
          {items.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              roleLabel={resolveRoleLabel(u.roleId, roles)}
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
          backgroundColor: "#FFFFFF",
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
    </div>
  );
}
