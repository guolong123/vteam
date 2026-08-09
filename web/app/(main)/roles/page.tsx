"use client";

/**
 * 角色权限页（Phase 3 T11：原型 role-permission 迁移 + 自定义角色 CRUD）
 * =====================================================================
 * 保真迁移自 docs/agent-platform/prototypes/role-permission/index.tsx：
 * 左角色列表（240px，role-item）+ 右权限矩阵（8 资源 × 6 操作 ✓/◐/✗）+
 * PermissionScope（scope-project-select / scope-inner-role-select）+
 * permission-note，data-testid 与原型一致。
 *
 * - 接真实 API：GET /roles（数组 {id,name,permissions,scopes,isBuiltin}）、
 *   POST /roles、PATCH /roles/:id、DELETE /roles/:id（预置角色 403
 *   FORBIDDEN_BUILTIN_ROLE）。
 * - 补原型缺失交互（原型 add-role-button 无 onClick）：新建角色弹窗、
 *   自定义角色矩阵/范围编辑 + 保存、删除；预置 admin/member 只读。
 * - 页面内扩展 token（仿原型范式，不写 tokens.ts）：
 *   permCellTheme（✓ 允许 / ◐ 部分 / ✗ 禁止三态，对齐原型 :38-42）、
 *   roleThemes（admin 蓝 / member 绿 / custom 紫，对齐原型 :47-51）。
 * - permissions 结构对齐后端 Role.permissions：{资源: {操作: bool}}。
 *   预置 admin={all:true}→全允许、member={all:false}→全禁止（后端二态）；
 *   partial 三态 token 保留供原型语义（legend 展示），真实矩阵二态渲染。
 */
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
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

/* ------------------------------ 页面内语义色（未入 tokens.ts） ------------------------------
 * 权限格三态（允许绿 / 部分琥珀 / 禁止灰）语义独立于任务四态（statusColors），
 * 遵循"扩展 token"范式在页面内定义具名常量并注释原因，不扩散共享层（对齐原型 :38-42）。
 */
const permCellTheme = {
  allow: { mark: "✓", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  partial: { mark: "◐", color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  deny: { mark: "✗", color: "#94A3B8", bg: "#F8FAFC", border: "#E2E8F0" },
} as const;

type Perm = keyof typeof permCellTheme;

/** 角色主题色（管理员蓝 / 成员绿 / 自定义紫），对齐原型 :47-51 */
const roleThemes = {
  admin: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE", icon: "◈" },
  member: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0", icon: "●" },
  custom: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE", icon: "✦" },
} as const;

type RoleTheme = (typeof roleThemes)[keyof typeof roleThemes];

/* ------------------------------ 权限模型数据（对齐后端 PERMISSION_RESOURCES / ACTIONS） ------------------------------ */
/** 8 资源（key 对齐 server/src/users/roles.constants.ts，label/icon 对齐原型） */
const RESOURCES = [
  { key: "tasks", label: "任务", icon: "▤" },
  { key: "chats", label: "群聊", icon: "✉" },
  { key: "artifacts", label: "产出物", icon: "▦" },
  { key: "agents", label: "Agent 配置", icon: "◉" },
  { key: "workers", label: "Worker 节点", icon: "⚙" },
  { key: "skills", label: "技能工具", icon: "◫" },
  { key: "users", label: "用户管理", icon: "☷" },
  { key: "roles", label: "权限配置", icon: "◈" },
] as const;

/** 6 操作（key 对齐后端 PERMISSION_ACTIONS，label 对齐原型） */
const ACTIONS = [
  { key: "view", label: "查看" },
  { key: "create", label: "创建" },
  { key: "edit", label: "编辑" },
  { key: "delete", label: "删除" },
  { key: "review", label: "验收" },
  { key: "manage", label: "管理" },
] as const;

/** 权限范围（对齐后端 Role.scopes 契约） */
interface RoleScope {
  global: boolean;
  projects: string[];
  innerRoles: string[];
}

/** GET /roles 响应条目（对齐后端 RolesService.findAll 返回行） */
interface Role {
  id: string;
  name: string;
  permissions: Record<string, unknown>;
  scopes: RoleScope | null;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /projects 分页响应（仅取 id/name 供权限范围「指定项目」选择器，对齐 board 页同款类型） */
interface ProjectsResponse {
  items: { id: string; name: string }[];
  total: number;
  page: number;
  pageSize: number;
}

/** 项目内角色候选池（对齐原型，静态池——项目内分工岗位，非项目实体） */
const innerRolePool = ["产品经理", "架构师", "开发者", "测试", "验收"];

/* ------------------------------ 数据映射 ------------------------------ */

/** 后端 permissions → 8×6 矩阵。预置 {all:true}/{all:false} 全量映射，缺省格视为禁止。 */
function matrixFromPermissions(perms: unknown): Perm[][] {
  const p = (perms ?? {}) as Record<string, unknown>;
  if (p.all === true) {
    return RESOURCES.map(() => ACTIONS.map(() => "allow" as Perm));
  }
  if (p.all === false) {
    return RESOURCES.map(() => ACTIONS.map(() => "deny" as Perm));
  }
  return RESOURCES.map((r) =>
    ACTIONS.map((a) => {
      const row = p[r.key] as Record<string, unknown> | undefined;
      return row?.[a.key] === true ? "allow" : "deny";
    }),
  );
}

/** 8×6 矩阵 → PATCH/POST 请求体 permissions（后端二态 bool） */
function matrixToPermissions(m: Perm[][]): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  RESOURCES.forEach((r, ri) => {
    out[r.key] = {};
    ACTIONS.forEach((a, ci) => {
      out[r.key][a.key] = m[ri]?.[ci] === "allow";
    });
  });
  return out;
}

/** 全禁止初始矩阵（新建弹窗 / 兜底） */
function blankMatrix(): Perm[][] {
  return RESOURCES.map(() => ACTIONS.map(() => "deny" as Perm));
}

/** scopes 兜底归一化（后端缺省/旧数据可能缺字段） */
function normalizeScopes(s: RoleScope | null | undefined): RoleScope {
  return {
    global: s?.global ?? false,
    projects: Array.isArray(s?.projects) ? s.projects : [],
    innerRoles: Array.isArray(s?.innerRoles) ? s.innerRoles : [],
  };
}

/** 角色主题映射：admin/member 按内置名对齐原型 roleThemes，其余归 custom */
function roleThemeFor(role: Role): RoleTheme {
  if (role.name === "admin") return roleThemes.admin;
  if (role.name === "member") return roleThemes.member;
  return roleThemes.custom;
}

/** 角色显示名（对齐原型 label：平台管理员 / 项目成员 / 自定义角色名） */
function roleLabel(role: Role): string {
  if (role.name === "admin") return "平台管理员";
  if (role.name === "member") return "项目成员";
  return role.name;
}

/** 角色描述（对齐原型 desc；自定义角色用岗位化文案） */
function roleDesc(role: Role): string {
  if (role.name === "admin") {
    return "管理平台账号 / 项目生命周期 / 角色模板 / 全局安全与权限策略";
  }
  if (role.name === "member") {
    return "在所属项目内参与任务、群聊、产出物与 Agent 协作";
  }
  return "按需组合资源权限，如「验收员」「运维专员」等岗位化角色";
}

/* ------------------------------ 子组件 ------------------------------ */

/** 权限矩阵：行=资源，列=操作，格=✓/◐/✗；editable 时格子可点击循环 允许↔禁止 */
function PermissionMatrix({
  matrix,
  editable,
  onToggle,
}: {
  matrix: Perm[][];
  editable?: boolean;
  onToggle?: (ri: number, ci: number) => void;
}) {
  const th: CSSProperties = {
    padding: `${space.sm}px ${space.md}px`,
    fontSize: fontSize.sm,
    fontWeight: 600,
    color: neutral[500],
    textAlign: "center",
    whiteSpace: "nowrap",
    backgroundColor: neutral[50],
    borderBottom: `1px solid ${neutral[200]}`,
  };
  const cellBase = (perm: Perm): CSSProperties => {
    const t = permCellTheme[perm];
    return {
      minWidth: 44,
      padding: `${space.sm - 1}px ${space.sm}px`,
      fontSize: fontSize.md,
      fontWeight: 600,
      color: t.color,
      textAlign: "center",
      backgroundColor: t.bg,
      border: `1px solid ${t.border}`,
      borderRadius: radius.sm,
    };
  };

  return (
    <div
      data-testid="permission-matrix"
      style={{
        overflowX: "auto",
        borderRadius: radius.md,
        border: `1px solid ${neutral[200]}`,
        backgroundColor: "#FFFFFF",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, ...baseFont }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left", minWidth: 140 }}>资源</th>
            {ACTIONS.map((a) => (
              <th key={a.key} style={th}>{a.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {RESOURCES.map((r, ri) => (
            <tr key={r.key}>
              <td
                style={{
                  padding: `${space.sm}px ${space.md}px`,
                  fontSize: fontSize.md,
                  fontWeight: 600,
                  color: neutral[700],
                  whiteSpace: "nowrap",
                  borderBottom: `1px solid ${neutral[100]}`,
                }}
              >
                <span aria-hidden style={{ marginRight: space.sm, color: neutral[400] }}>{r.icon}</span>
                {r.label}
              </td>
              {ACTIONS.map((a, ci) => {
                const perm = matrix[ri]?.[ci] ?? "deny";
                const cellStyle = cellBase(perm);
                return (
                  <td
                    key={a.key}
                    style={{
                      padding: `${space.xs}px ${space.xs}px`,
                      textAlign: "center",
                      borderBottom: `1px solid ${neutral[100]}`,
                    }}
                  >
                    {editable && onToggle ? (
                      <button
                        type="button"
                        data-perm={perm}
                        aria-label={`${r.label} ${a.label} 权限：${perm === "allow" ? "允许" : "禁止"}（点击切换）`}
                        onClick={() => onToggle(ri, ci)}
                        style={{
                          ...cellStyle,
                          cursor: "pointer",
                          transition: "transform .12s ease, box-shadow .12s ease",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.transform = "scale(1.06)";
                          e.currentTarget.style.boxShadow = shadow.sm;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.transform = "none";
                          e.currentTarget.style.boxShadow = "none";
                        }}
                      >
                        {permCellTheme[perm].mark}
                      </button>
                    ) : (
                      <span style={cellStyle}>{permCellTheme[perm].mark}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 权限范围：全局 / 指定项目（多选）/ 项目内角色（受控版，自定义角色可编辑） */
function PermissionScope({
  value,
  theme,
  editable,
  projects,
  onChange,
}: {
  value: RoleScope;
  theme: RoleTheme;
  editable: boolean;
  /** 真实项目候选池（GET /projects 驱动；选择值存项目 id，渲染 name） */
  projects: { id: string; name: string }[];
  onChange?: (next: RoleScope) => void;
}) {
  const [scopeType, setScopeType] = useState<"global" | "projects">(
    value.global ? "global" : "projects",
  );

  const switchScope = (t: "global" | "projects") => {
    setScopeType(t);
    onChange?.({ ...value, global: t === "global" });
  };

  const toggleProject = (p: { id: string; name: string }) => {
    if (!editable || !onChange) return;
    const active = value.projects.includes(p.id) || value.projects.includes(p.name);
    onChange({
      ...value,
      projects: active
        ? value.projects.filter((x) => x !== p.id && x !== p.name)
        : [...value.projects, p.id],
    });
  };

  const toggleInnerRole = (r: string) => {
    if (!editable || !onChange) return;
    const active = value.innerRoles.includes(r);
    onChange({
      ...value,
      innerRoles: active
        ? value.innerRoles.filter((x) => x !== r)
        : [...value.innerRoles, r],
    });
  };

  return (
    <div
      data-testid="permission-scope"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        padding: `${space.lg}px`,
        borderRadius: radius.md,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      {/* 适用范围：全局 vs 指定项目（受控单选） */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>适用范围</span>
        <div style={{ display: "flex", gap: space.sm }}>
          <button
            type="button"
            data-scope-type="global"
            data-active={scopeType === "global" ? "true" : "false"}
            onClick={() => switchScope("global")}
            style={{
              flex: 1,
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              border: `1px solid ${scopeType === "global" ? theme.border : neutral[200]}`,
              backgroundColor: scopeType === "global" ? theme.bg : "#FFFFFF",
              color: scopeType === "global" ? theme.color : neutral[600],
              fontSize: fontSize.md,
              fontWeight: scopeType === "global" ? 600 : 500,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            全局（所有项目）
          </button>
          <button
            type="button"
            data-scope-type="projects"
            data-active={scopeType === "projects" ? "true" : "false"}
            onClick={() => switchScope("projects")}
            style={{
              flex: 1,
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              border: `1px solid ${scopeType === "projects" ? theme.border : neutral[200]}`,
              backgroundColor: scopeType === "projects" ? theme.bg : "#FFFFFF",
              color: scopeType === "projects" ? theme.color : neutral[600],
              fontSize: fontSize.md,
              fontWeight: scopeType === "projects" ? 600 : 500,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            指定项目
          </button>
        </div>
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
          {scopeType === "global" ? "全局角色对所有项目生效（如平台管理员）" : "角色仅对所选项目生效（如项目成员）"}
        </span>
      </div>

      {/* 指定项目（多选） */}
      <div
        data-testid="scope-project-select"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: space.sm,
          opacity: scopeType === "projects" ? 1 : 0.55,
        }}
      >
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>指定项目（多选）</span>
        <div style={{ display: "flex", gap: space.sm, flexWrap: "wrap" }}>
          {projects.length === 0 ? (
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
              暂无可用项目（当前账号未加入任何项目）
            </span>
          ) : (
            projects.map((p) => {
              const active =
                value.projects.includes(p.id) || value.projects.includes(p.name);
              return (
                <span
                  key={p.id}
                  data-project={p.id}
                  data-project-name={p.name}
                  data-active={active ? "true" : "false"}
                  onClick={editable ? () => toggleProject(p) : undefined}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: space.xs,
                    padding: `${space.xs + 1}px ${space.md}px`,
                    borderRadius: radius.pill,
                    border: `1px solid ${active ? theme.border : neutral[200]}`,
                    backgroundColor: active ? theme.bg : "#FFFFFF",
                    color: active ? theme.color : neutral[600],
                    fontSize: fontSize.md,
                    cursor: editable
                      ? scopeType === "projects"
                        ? "pointer"
                        : "not-allowed"
                      : "default",
                    fontFamily: fontFamily.body,
                  }}
                >
                  {active && <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>✓</span>}
                  {p.name}
                </span>
              );
            })
          )}
        </div>
      </div>

      {/* 项目内角色（多选，成员可在项目内承担多种分工） */}
      <div
        data-testid="scope-inner-role-select"
        style={{ display: "flex", flexDirection: "column", gap: space.sm }}
      >
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>项目内角色</span>
        <div style={{ display: "flex", gap: space.sm, flexWrap: "wrap" }}>
          {innerRolePool.map((r) => {
            const active = value.innerRoles.includes(r);
            return (
              <span
                key={r}
                data-inner-role={r}
                data-active={active ? "true" : "false"}
                onClick={editable ? () => toggleInnerRole(r) : undefined}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: space.xs,
                  padding: `${space.xs + 1}px ${space.md}px`,
                  borderRadius: radius.pill,
                  border: `1px solid ${active ? theme.border : neutral[200]}`,
                  backgroundColor: active ? theme.bg : "#FFFFFF",
                  color: active ? theme.color : neutral[600],
                  fontSize: fontSize.md,
                  cursor: editable ? "pointer" : "default",
                  fontFamily: fontFamily.body,
                }}
              >
                {active && <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>✓</span>}
                {r}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** 权限格图例条（三态，对齐原型） */
function PermLegend() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.lg,
        padding: `${space.sm}px ${space.md}px`,
        borderRadius: radius.md,
        backgroundColor: neutral[100],
        fontSize: fontSize.sm,
        color: neutral[500],
        ...baseFont,
      }}
    >
      {(["allow", "partial", "deny"] as const).map((k) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: space.xs }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
              borderRadius: radius.sm,
              fontSize: fontSize.sm,
              fontWeight: 600,
              color: permCellTheme[k].color,
              backgroundColor: permCellTheme[k].bg,
              border: `1px solid ${permCellTheme[k].border}`,
            }}
          >
            {permCellTheme[k].mark}
          </span>
          {k === "allow" ? "允许" : k === "partial" ? "部分允许" : "禁止"}
        </span>
      ))}
    </div>
  );
}

/** 新建角色弹窗（补原型 add-role-button 缺失交互）：名称 + 权限矩阵编辑 */
function CreateRoleModal({
  open,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: {
    name: string;
    permissions: Record<string, Record<string, boolean>>;
    scopes: RoleScope;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [matrix, setMatrix] = useState<Perm[][]>(() => blankMatrix());

  // 每次打开重置表单 + 矩阵
  useEffect(() => {
    if (open) {
      setName("");
      setMatrix(blankMatrix());
    }
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const toggle = (ri: number, ci: number) => {
    setMatrix((prev) => {
      const next = prev.map((row) => [...row]);
      next[ri][ci] = next[ri][ci] === "allow" ? "deny" : "allow";
      return next;
    });
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    onSubmit({
      name: name.trim(),
      permissions: matrixToPermissions(matrix),
      scopes: { global: false, projects: [], innerRoles: [] },
    });
  };

  return (
    <div
      data-testid="create-role-modal"
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
          width: 680,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "calc(100% - 96px)",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
          fontFamily: fontFamily.body,
          overflow: "auto",
        }}
      >
        {/* 头部：标题 + 关闭 */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>新建角色</div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
              按需组合资源权限，创建岗位化自定义角色（如「验收员」「运维专员」）
            </div>
          </div>
          <button
            type="button"
            data-testid="create-role-close"
            aria-label="关闭新建角色弹窗"
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

        {/* 角色名称 */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <label htmlFor="create-role-name" style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
            角色名称 <span aria-hidden style={{ color: "#DC2626" }}>*</span>
          </label>
          <input
            id="create-role-name"
            data-testid="create-role-name-input"
            type="text"
            placeholder="如：验收员 / 运维专员"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            style={{
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
            }}
          />
        </div>

        {/* 权限矩阵（默认全禁止，可编辑） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>权限矩阵</span>
            <PermLegend />
          </div>
          <PermissionMatrix matrix={matrix} editable onToggle={toggle} />
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            点击格子切换 允许 / 禁止；未允许的操作将对该角色禁止
          </span>
        </div>

        {/* 错误提示 */}
        {error && (
          <div
            data-testid="create-role-error"
            role="alert"
            style={{ fontSize: fontSize.sm, color: "#DC2626", display: "flex", alignItems: "center", gap: space.xs }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {error}
          </div>
        )}

        {/* 操作按钮 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button
            type="button"
            data-testid="create-role-cancel"
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
            data-testid="create-role-confirm"
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
            {submitting ? "创建中…" : "创建角色"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------ 页面主组件 ------------------------------ */

export default function RolePermissionPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  /* 当前选中角色 id（受控切换，对齐原型 activeRole） */
  const [activeId, setActiveId] = useState("");
  /* 自定义角色编辑草稿：矩阵 + 范围 */
  const [draftMatrix, setDraftMatrix] = useState<Perm[][] | null>(null);
  const [draftScopes, setDraftScopes] = useState<RoleScope>({
    global: false,
    projects: [],
    innerRoles: [],
  });
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  /* 删除角色确认弹窗（OBS-003：删除后不可恢复，原生 window.confirm 换项目 Modal 二次确认） */
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<Role[]>("/roles"),
    enabled: !!user?.id,
  });

  /* 真实项目池（GET /projects，成员可见项目；与看板/产出物页同 key 同 queryFn，缓存共享） */
  const { data: projectsData } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<ProjectsResponse>("/projects"),
    enabled: !!user?.id,
  });

  const rolesList = useMemo(() => data ?? [], [data]);
  const projectOptions = useMemo(() => projectsData?.items ?? [], [projectsData]);

  /* 默认选中第一个角色（seed 顺序 admin 在前） */
  useEffect(() => {
    if (!activeId && rolesList.length > 0) {
      setActiveId(rolesList[0].id);
    }
  }, [rolesList, activeId]);

  const activeRole = rolesList.find((r) => r.id === activeId) ?? null;

  /* 选中角色变化 → 重置草稿（对齐原型 key=def.key 重挂载语义） */
  useEffect(() => {
    if (!activeRole) {
      setDraftMatrix(null);
      return;
    }
    setDraftMatrix(matrixFromPermissions(activeRole.permissions));
    setDraftScopes(normalizeScopes(activeRole.scopes));
    setErrorHint(null);
    setSavedFlash(false);
  }, [activeRole]);

  /* 是否有未保存修改（矩阵或范围偏离服务器值） */
  const dirty = useMemo(() => {
    if (!activeRole || !draftMatrix) return false;
    const base = matrixFromPermissions(activeRole.permissions);
    const scopes = normalizeScopes(activeRole.scopes);
    return (
      JSON.stringify(base) !== JSON.stringify(draftMatrix) ||
      JSON.stringify(scopes) !== JSON.stringify(draftScopes)
    );
  }, [activeRole, draftMatrix, draftScopes]);

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: {
        permissions: Record<string, Record<string, boolean>>;
        scopes: RoleScope;
      };
    }) => api.patch<Role>(`/roles/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      setSavedFlash(true);
      setErrorHint(null);
    },
    onError: (err) =>
      setErrorHint(isApiError(err) ? err.message : "保存失败，请稍后重试"),
  });

  const createMutation = useMutation({
    mutationFn: (payload: {
      name: string;
      permissions: Record<string, Record<string, boolean>>;
      scopes: RoleScope;
    }) => api.post<Role>("/roles", payload),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      setCreateOpen(false);
      setActiveId(created.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete<{ deleted: boolean; id: string }>(`/roles/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      setErrorHint(null);
    },
    onError: (err) =>
      setErrorHint(isApiError(err) ? err.message : "删除失败，请稍后重试"),
  });

  /* 矩阵格子切换（仅自定义角色可编辑） */
  const handleToggle = (ri: number, ci: number) => {
    if (!activeRole || activeRole.isBuiltin || !draftMatrix) return;
    setDraftMatrix((prev) => {
      if (!prev) return prev;
      const next = prev.map((row) => [...row]);
      next[ri][ci] = next[ri][ci] === "allow" ? "deny" : "allow";
      return next;
    });
  };

  const handleSave = () => {
    if (!activeRole || !draftMatrix || !dirty) return;
    updateMutation.mutate({
      id: activeRole.id,
      payload: {
        permissions: matrixToPermissions(draftMatrix),
        scopes: draftScopes,
      },
    });
  };

  const handleDelete = () => {
    if (!activeRole) return;
    /* OBS-003：删除不可恢复，先弹项目 Modal 二次确认，确认后才 DELETE */
    setDeleteConfirmOpen(true);
  };

  const theme = activeRole ? roleThemeFor(activeRole) : roleThemes.custom;
  const matrix = activeRole && draftMatrix ? draftMatrix : blankMatrix();

  return (
    <div
      data-testid="role-permission-root"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`,
        fontFamily: fontFamily.body,
      }}
    >
      {isPending ? (
        <div data-testid="roles-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}>
          加载中…
        </div>
      ) : isError ? (
        <div
          data-testid="roles-error"
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: space.md,
            padding: `${space.xxl}px`,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
            {isApiError(error) ? error.message : "加载角色列表失败"}
          </div>
          <button
            type="button"
            data-testid="roles-retry"
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
      ) : rolesList.length === 0 ? (
        <EmptyState
          title="还没有角色"
          description="创建你的第一个自定义角色，配置资源权限矩阵"
          icon={<span aria-hidden>⚖</span>}
          action={
            <button
              type="button"
              data-testid="add-role-button"
              onClick={() => setCreateOpen(true)}
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
              新增角色
            </button>
          }
        />
      ) : (
        <div style={{ display: "flex", gap: space.xl, alignItems: "flex-start", maxWidth: 1200 }}>
          {/* 左：角色列表 */}
          <div
            style={{
              width: 240,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              gap: space.sm,
            }}
          >
            <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800], marginBottom: space.sm }}>
              角色
            </div>
            {rolesList.map((r) => {
              const active = r.id === activeId;
              const t = roleThemeFor(r);
              const allowCount = matrixFromPermissions(r.permissions)
                .flat()
                .filter((p) => p === "allow").length;
              return (
                <button
                  key={r.id}
                  type="button"
                  data-testid="role-item"
                  data-role={r.name}
                  data-active={active ? "true" : "false"}
                  onClick={() => setActiveId(r.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.md,
                    padding: `${space.md}px ${space.lg}px`,
                    borderRadius: radius.lg,
                    border: `1px solid ${active ? t.border : neutral[200]}`,
                    backgroundColor: active ? t.bg : "#FFFFFF",
                    boxShadow: active ? shadow.sm : undefined,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: fontFamily.body,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 30,
                      height: 30,
                      flexShrink: 0,
                      borderRadius: radius.md,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: fontSize.lg,
                      color: t.color,
                      backgroundColor: active ? "#FFFFFF" : neutral[100],
                      border: `1px solid ${active ? t.border : neutral[200]}`,
                    }}
                  >
                    {t.icon}
                  </span>
                  <span>
                    <span style={{ display: "block", fontSize: fontSize.md, fontWeight: active ? 600 : 500, color: active ? t.color : neutral[700] }}>
                      {roleLabel(r)}
                    </span>
                    <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>
                      {allowCount} 项允许 · {r.isBuiltin ? "内置角色 · 只读" : "自定义角色"}
                    </span>
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              data-testid="add-role-button"
              onClick={() => setCreateOpen(true)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: space.xs,
                padding: `${space.md}px ${space.lg}px`,
                borderRadius: radius.lg,
                border: `1px dashed ${neutral[300]}`,
                backgroundColor: "#FFFFFF",
                color: neutral[500],
                fontSize: fontSize.md,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>+</span>
              新增角色
            </button>
          </div>

          {/* 右：权限配置面板 */}
          {activeRole && (
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
              {/* 当前角色标题 */}
              <div style={{ display: "flex", alignItems: "flex-start", gap: space.md }}>
                <span
                  aria-hidden
                  style={{
                    width: 36,
                    height: 36,
                    flexShrink: 0,
                    borderRadius: radius.md,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: fontSize.xl,
                    color: theme.color,
                    backgroundColor: theme.bg,
                    border: `1px solid ${theme.border}`,
                  }}
                >
                  {theme.icon}
                </span>
                <div>
                  <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
                    {roleLabel(activeRole)}
                    {activeRole.isBuiltin && (
                      <span
                        style={{
                          marginLeft: space.sm,
                          padding: "1px 8px",
                          borderRadius: radius.pill,
                          fontSize: fontSize.xs,
                          fontWeight: 600,
                          color: neutral[500],
                          backgroundColor: neutral[100],
                          border: `1px solid ${neutral[200]}`,
                          verticalAlign: "middle",
                        }}
                      >
                        内置只读
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>{roleDesc(activeRole)}</div>
                </div>
              </div>

              {/* 权限矩阵 */}
              <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>权限矩阵</span>
                  <PermLegend />
                </div>
                <PermissionMatrix
                  matrix={matrix}
                  editable={!activeRole.isBuiltin}
                  onToggle={handleToggle}
                />
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  行 = 资源（对齐平台业务域：任务 / 群聊 / 产出物 / Agent 配置 / Worker 节点 / 技能工具 /
                  用户管理 / 权限配置）；列 = 操作（查看 / 创建 / 编辑 / 删除 / 验收 / 管理）
                  {!activeRole.isBuiltin && "；点击格子切换 允许 / 禁止"}
                </span>
              </div>

              {/* 权限范围 */}
              <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
                <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>权限范围</span>
                {/* key=activeRole.id：角色切换时重挂载，scopeType 初始值（global/projects）随角色重置 */}
                <PermissionScope
                  key={activeRole.id}
                  value={draftScopes}
                  theme={theme}
                  editable={!activeRole.isBuiltin}
                  projects={projectOptions}
                  onChange={(next) => setDraftScopes(next)}
                />
              </div>

              {/* 操作行（仅自定义角色：保存 / 删除） */}
              {!activeRole.isBuiltin && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    gap: space.sm,
                  }}
                >
                  {savedFlash && !dirty && (
                    <span
                      data-testid="roles-saved"
                      style={{
                        marginRight: "auto",
                        fontSize: fontSize.sm,
                        color: "#059669",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: space.xs,
                      }}
                    >
                      <span aria-hidden style={{ fontWeight: 700 }}>✓</span>
                      已保存
                    </span>
                  )}
                  <button
                    type="button"
                    data-testid="delete-role-button"
                    onClick={handleDelete}
                    disabled={deleteMutation.isPending}
                    style={{
                      padding: `${space.sm + 2}px ${space.lg}px`,
                      borderRadius: radius.md,
                      border: `1px solid #FCA5A5`,
                      backgroundColor: "#FEF2F2",
                      color: "#DC2626",
                      fontSize: fontSize.md,
                      fontWeight: 500,
                      cursor: deleteMutation.isPending ? "default" : "pointer",
                      opacity: deleteMutation.isPending ? 0.6 : 1,
                      fontFamily: fontFamily.body,
                    }}
                  >
                    {deleteMutation.isPending ? "删除中…" : "删除角色"}
                  </button>
                  <button
                    type="button"
                    data-testid="save-role-button"
                    onClick={handleSave}
                    disabled={!dirty || updateMutation.isPending}
                    style={{
                      padding: `${space.sm + 2}px ${space.lg}px`,
                      borderRadius: radius.md,
                      border: "none",
                      backgroundColor: "#2563EB",
                      color: "#FFFFFF",
                      fontSize: fontSize.md,
                      fontWeight: 500,
                      cursor: !dirty || updateMutation.isPending ? "default" : "pointer",
                      opacity: !dirty || updateMutation.isPending ? 0.6 : 1,
                      boxShadow: dirty ? "0 6px 16px rgba(37,99,235,.3)" : undefined,
                      fontFamily: fontFamily.body,
                    }}
                  >
                    {updateMutation.isPending ? "保存中…" : dirty ? "保存修改" : "已是最新"}
                  </button>
                </div>
              )}

              {/* 操作错误提示（保存 / 删除 / 预置角色 403 兜底） */}
              {errorHint && (
                <div
                  data-testid="roles-action-error"
                  role="alert"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.xs,
                    padding: `${space.sm}px ${space.md}px`,
                    borderRadius: radius.md,
                    backgroundColor: "#FEF2F2",
                    border: `1px solid #FCA5A5`,
                    fontSize: fontSize.sm,
                    color: "#DC2626",
                    fontFamily: fontFamily.body,
                  }}
                >
                  <span aria-hidden style={{ fontWeight: 700 }}>!</span>
                  {errorHint}
                </div>
              )}

              {/* 平台权限 vs opencode 权限 说明 */}
              <div
                data-testid="permission-note"
                style={{
                  padding: `${space.md}px ${space.lg}px`,
                  borderRadius: radius.md,
                  backgroundColor: "#EFF6FF",
                  border: `1px solid #BFDBFE`,
                  fontSize: fontSize.sm,
                  color: "#1D4ED8",
                  lineHeight: 1.7,
                  ...baseFont,
                }}
              >
                <span style={{ fontWeight: 600 }}>平台权限与 opencode 权限相互独立</span> ·
                平台权限管「用户能操作什么」（本页：谁能在控制面创建任务、查看产出物、管理账号），
                opencode 权限管「agent 能做什么」（Agent 运行时可用的工具 / 文件 / 命令，经 PermissionV2
                Ruleset 下发）。两条链路独立配置、互不干扰：即使用户被授予全部平台权限，agent 的能力
                边界仍由 opencode 权限单独约束。
              </div>
            </div>
          )}
        </div>
      )}

      {/* 新建角色弹窗 */}
      <CreateRoleModal
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

      {/* 删除角色二次确认弹窗（OBS-003：确认后才 DELETE） */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="删除角色"
        description={
          activeRole
            ? `确定删除角色「${roleLabel(activeRole)}」？删除后不可恢复，持有该角色的用户将失去对应权限。`
            : undefined
        }
        confirmLabel="确认删除"
        pendingLabel="删除中…"
        submitting={deleteMutation.isPending}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={() => {
          if (activeRole) deleteMutation.mutate(activeRole.id);
          setDeleteConfirmOpen(false);
        }}
      />
    </div>
  );
}
