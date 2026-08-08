/**
 * 原型：用户管理（平台管理员视角）
 * =============================================
 * 对应 02 篇「1.1 平台管理员」（管理平台账号与项目生命周期、成员维护、停用）
 * 与「1.2 项目成员」（用户归属项目、在项目内以成员身份参与任务）。
 *
 * 页面内容：
 * - 统计条（总用户 / 管理员 / 成员 / 已禁用）+ 「新增用户」按钮。
 * - 用户列表（user-item）：用户名 / 邮箱 / 角色（管理员 · 成员 徽章）/
 *   所属项目数 / 状态（启用 ✅ · 禁用 ⛔）/ 操作（编辑 · 禁用 · 重置密码）。
 * - 「新增用户」弹层（user-form）：用户名 / 邮箱 / 初始密码 / 角色选择 /
 *   所属项目（多选）——受控开关（默认关闭，点 add-user-button 打开，
 *   ✕ / 遮罩 / Esc 关闭），纯静态展示不实现真实 CRUD。
 * - mock 5 个用户：1 管理员 + 3 成员 + 1 禁用（对齐 02 篇「仅项目」组织模型）。
 * - 复用 ../_shared/nav（NavDock / NavTopBar / CmdKPanel）+ ../_shared/styles token。
 * - ⚠️ T15 铁律：root height:100% + minHeight:720 + position:relative，
 *   弹层 absolute，零 fixed/vh/vw；T20：CmdKPanel 受控开关默认关闭；
 *   T21：命令/配置区浅色主题。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起态宽度（与 _shared/nav RAIL_W 对齐），内容区避让留白 */
const RAIL_W = 56;

/* ------------------------------ 页面内语义色（未入 _shared） ------------------------------
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

/* ------------------------------ Mock 数据（对齐 02 篇用户角色） ------------------------------ */
type UserRole = keyof typeof roleTheme;
type UserStatus = keyof typeof statusTheme;

interface UserInfo {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  /** 所属项目列表（「仅项目」组织模型：用户归属项目，在项目内以成员身份参与任务） */
  projects: string[];
  status: UserStatus;
  createdAt: string;
}

const users: UserInfo[] = [
  {
    id: "u-01",
    username: "admin",
    email: "admin@ketaops.cc",
    role: "管理员",
    projects: ["全部项目"],
    status: "启用",
    createdAt: "2026-01-08",
  },
  {
    id: "u-02",
    username: "zhangwei",
    email: "zhangwei@ketaops.cc",
    role: "成员",
    projects: ["智能报表模块", "告警中心"],
    status: "启用",
    createdAt: "2026-02-15",
  },
  {
    id: "u-03",
    username: "liuyang",
    email: "liuyang@ketaops.cc",
    role: "成员",
    projects: ["数据采集平台"],
    status: "启用",
    createdAt: "2026-03-02",
  },
  {
    id: "u-04",
    username: "wangfang",
    email: "wangfang@ketaops.cc",
    role: "成员",
    projects: ["智能报表模块", "数据采集平台", "告警中心"],
    status: "启用",
    createdAt: "2026-04-20",
  },
  {
    id: "u-05",
    username: "chenhao",
    email: "chenhao@ketaops.cc",
    role: "成员",
    projects: ["告警中心"],
    status: "禁用",
    createdAt: "2026-05-11",
  },
];

/** 所属项目候选池（新增用户弹层多选） */
const projectPool = ["智能报表模块", "数据采集平台", "告警中心"];

/* 统计条数据 */
const stats = [
  { label: "总用户", value: users.length, theme: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" } },
  { label: "管理员", value: users.filter((u) => u.role === "管理员").length, theme: roleTheme["管理员"] },
  { label: "成员", value: users.filter((u) => u.role === "成员").length, theme: roleTheme["成员"] },
  { label: "已禁用", value: users.filter((u) => u.status === "禁用").length, theme: statusTheme["禁用"] },
];

/* Cmd+K 命令项：导航组图标与 Dock 一一对应，「用户管理」高亮呼应当前页 */
const CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "导航", label: "用户管理", icon: "☷", active: true },
  { group: "操作", label: "新增用户", icon: "＋" },
  { group: "操作", label: "重置密码", icon: "✎" },
  { group: "操作", label: "查看权限", icon: "▤" },
];

/* ------------------------------ 子组件 ------------------------------ */

/** 角色徽章（管理员蓝 / 成员绿） */
function RoleBadge({ role }: { role: UserRole }) {
  const theme = roleTheme[role];
  return (
    <span
      data-testid="user-role-badge"
      data-role={role}
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
      {role}
    </span>
  );
}

/** 状态徽章（启用 ✅ 绿 / 禁用 ⛔ 红） */
function StatusBadge({ status }: { status: UserStatus }) {
  const theme = statusTheme[status];
  return (
    <span
      data-testid="user-status-badge"
      data-status={status}
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
      {status}
    </span>
  );
}

/** 用户表格行 */
function UserRow({ user, onToggleDisable }: { user: UserInfo; onToggleDisable: (u: UserInfo) => void }) {
  return (
    <div
      data-testid="user-item"
      data-user-id={user.id}
      data-status={user.status}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.md}px ${space.lg}px`,
        borderBottom: `1px solid ${neutral[100]}`,
        backgroundColor: user.status === "禁用" ? neutral[50] : "#FFFFFF",
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
            color: roleTheme[user.role].color,
            backgroundColor: roleTheme[user.role].bg,
            border: `1.5px solid ${roleTheme[user.role].border}`,
            userSelect: "none",
          }}
        >
          {user.username.slice(0, 1).toUpperCase()}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800], fontFamily: fontFamily.mono }}>
              {user.username}
            </span>
            <RoleBadge role={user.role} />
          </div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.email}
          </div>
        </div>
      </div>

      {/* 所属项目数 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>{user.projects.length}</div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>所属项目</div>
      </div>

      {/* 状态 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <StatusBadge status={user.status} />
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
          onClick={() => onToggleDisable(user)}
          style={{
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${user.status === "禁用" ? neutral[200] : "#FECACA"}`,
            backgroundColor: user.status === "禁用" ? "#FFFFFF" : statusTheme["禁用"].bg,
            color: user.status === "禁用" ? neutral[600] : statusTheme["禁用"].color,
            fontSize: fontSize.md,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          {user.status === "启用" ? "禁用" : "启用"}
        </button>
        <button
          type="button"
          data-testid="user-reset-button"
          data-user-id={user.id}
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

/** 新增用户弹层（受控开关：默认关闭，✕ / 遮罩 / Esc 关闭） */
function UserFormModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  /* 表单受控状态（纯展示原型：不实现真实创建，仅演示表单结构） */
  const [role, setRole] = useState<"管理员" | "成员">("成员");
  const [projects, setProjects] = useState<string[]>(["智能报表模块"]);

  if (!open) return null;

  const toggleProject = (p: string) => {
    setProjects((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  };

  const formField: CSSProperties = {
    width: "100%",
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "#FFFFFF",
    fontSize: fontSize.md,
    color: neutral[800],
    outline: "none",
    fontFamily: fontFamily.body,
    boxSizing: "border-box",
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
        onSubmit={(e) => e.preventDefault()}
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
              创建平台账号并分配角色与所属项目（对齐 02 篇「仅项目」组织模型）
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
          <input data-testid="username-input" placeholder="如 zhangwei" style={formField} />
        </label>

        {/* 邮箱 */}
        <label style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>邮箱</span>
          <input data-testid="user-email-input" type="email" placeholder="name@ketaops.cc" style={formField} />
        </label>

        {/* 初始密码 */}
        <label style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>初始密码</span>
          <input data-testid="user-password-input" type="password" placeholder="首次登录后可修改" style={formField} />
        </label>

        {/* 角色选择 */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>角色</span>
          <div data-testid="user-role-select" style={{ display: "flex", gap: space.sm }}>
            {(["管理员", "成员"] as const).map((r) => (
              <button
                key={r}
                type="button"
                data-role={r}
                data-active={role === r ? "true" : "false"}
                onClick={() => setRole(r)}
                style={{
                  flex: 1,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: space.xs,
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${role === r ? roleTheme[r].border : neutral[200]}`,
                  backgroundColor: role === r ? roleTheme[r].bg : "#FFFFFF",
                  color: role === r ? roleTheme[r].color : neutral[600],
                  fontSize: fontSize.md,
                  fontWeight: role === r ? 600 : 500,
                  cursor: "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>{roleTheme[r].mark}</span>
                {r}
              </button>
            ))}
          </div>
          <span style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>
            管理员可管理账号 / 项目 / 角色模板 / 全局策略；成员在所属项目内协作（02 篇 1.1 / 1.2）
          </span>
        </div>

        {/* 所属项目（多选 chips） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>所属项目</span>
          <div
            data-testid="user-project-select"
            style={{
              display: "flex",
              gap: space.sm,
              flexWrap: "wrap",
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: neutral[50],
              border: `1px dashed ${neutral[300]}`,
            }}
          >
            {projectPool.map((p) => {
              const active = projects.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  data-project={p}
                  data-active={active ? "true" : "false"}
                  onClick={() => toggleProject(p)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: space.xs,
                    padding: `${space.xs + 1}px ${space.md}px`,
                    borderRadius: radius.pill,
                    border: `1px solid ${active ? "#BFDBFE" : neutral[200]}`,
                    backgroundColor: active ? "#EFF6FF" : "#FFFFFF",
                    color: active ? "#2563EB" : neutral[600],
                    fontSize: fontSize.md,
                    cursor: "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  {active && <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>✓</span>}
                  {p}
                </button>
              );
            })}
          </div>
        </div>

        {/* 底部：创建 / 取消 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm }}>
          <button
            type="button"
            data-testid="user-form-cancel"
            onClick={onClose}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.md,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            取消
          </button>
          <button
            type="submit"
            data-testid="user-form-submit"
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
              cursor: "pointer",
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            创建用户
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------ 页面主组件 ------------------------------ */

function UserManagementPage() {
  /* Cmd+K 命令面板受控开关（T20）：默认关闭 */
  const [cmdkOpen, setCmdkOpen] = useState(false);
  /* 新增用户弹层受控开关：默认关闭 */
  const [formOpen, setFormOpen] = useState(false);
  /* 禁用状态 mock：点击「禁用/启用」切换本地状态（纯展示演示，不落库） */
  const [userList, setUserList] = useState<UserInfo[]>(users);

  const toggleDisable = (u: UserInfo) => {
    setUserList((prev) =>
      prev.map((x) => (x.id === u.id ? { ...x, status: x.status === "启用" ? "禁用" : "启用" } : x))
    );
  };

  return (
    <div
      data-testid="user-management-root"
      style={{
        height: "100%",
        minHeight: 720,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
      }}
    >
      {/* 浅色顶栏（文档流顶部，height 60） */}
      <NavTopBar
        title="用户管理"
        subtitle="平台账号 · 角色分配 · 项目归属（02 篇 1.1 / 1.2）"
        userName="运营者"
        userRole="平台管理员"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：左侧 paddingLeft 80px 留白避让 Dock */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: `${space.xl}px ${space.xl}px ${space.xl}px ${RAIL_W + space.xl}px`,
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
              {userList.length} 个账号 · 平台内置账号体系 · 成员在所属项目内协作
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

        {/* 用户列表卡片 */}
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
          {userList.map((u) => (
            <UserRow key={u.id} user={u} onToggleDisable={toggleDisable} />
          ))}
        </div>

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
      </main>

      {/* 左侧 Dock 悬浮导航：activeKey="users"（用户管理域） */}
      <NavDock activeKey="users" projectName="Agent 协作平台" />

      {/* Cmd+K 命令面板：受控开关（T20）——初始关闭，trigger 打开，✕/遮罩/Esc 关闭 */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS} />

      {/* 新增用户弹层：受控开关（默认关闭） */}
      <UserFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "user-management",
    name: "用户管理",
    group: "平台",
    description:
      "用户列表（用户名/邮箱/角色/所属项目/状态/操作）+ 统计条 + 新增用户弹层（角色选择·项目多选）",
    device: "desktop",
  },
  Component: UserManagementPage,
};

export default def;
