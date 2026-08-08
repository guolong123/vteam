/**
 * 原型：权限设计（角色权限矩阵 + 权限范围）
 * =============================================
 * 对应 02 篇「1.1 平台管理员」（账号 / 项目 / 角色模板 / 全局策略）与
 * 「1.2 项目成员」（项目内任务 / 群聊 / 产出物 / Agent）的用户角色定义，
 * 将「用户能操作什么」收敛为平台侧权限模型。
 *
 * 页面内容：
 * - 左侧角色列表（role-item ×3：平台管理员 / 项目成员 / 自定义角色，受控切换）。
 * - 右侧权限配置面板：
 *   · 权限矩阵（permission-matrix）：行=资源（任务/群聊/产出物/Agent 配置/
 *     Worker 节点/技能工具/用户管理/权限配置，对齐现有业务原型域），
 *     列=操作（查看/创建/编辑/删除/验收/管理），格=✓ 允许 / ◐ 部分 / ✗ 禁止。
 *   · 权限范围（permission-scope）：全局（所有项目） / 指定项目（多选） /
 *     项目内角色。
 * - 说明文案：平台权限管「用户能操作什么」，与 opencode 权限（管 agent
 *   能做什么）相互独立——两条权限链路互不干扰。
 * - mock：平台管理员全 ✓；项目成员部分（任务查看/创建/验收 ✓、用户管理 ✗）。
 * - 复用 ../_shared/nav（NavDock / NavTopBar / CmdKPanel）+ ../_shared/styles token。
 * - ⚠️ T15 铁律：root height:100% + minHeight:720 + position:relative，零 fixed/vh/vw；
 *   T20：CmdKPanel 受控开关默认关闭；T21：浅色主题。
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
 * 权限格三态（允许绿 / 部分琥珀 / 禁止灰）语义独立于任务四态（statusColors），
 * 遵循"扩展 token"范式在页面内定义具名常量并注释原因，不扩散共享层。
 */
const permCellTheme = {
  allow: { mark: "✓", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  partial: { mark: "◐", color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  deny: { mark: "✗", color: "#94A3B8", bg: "#F8FAFC", border: "#E2E8F0" },
} as const;

type Perm = keyof typeof permCellTheme;

/** 角色主题色（管理员蓝 / 成员绿 / 自定义紫） */
const roleThemes = {
  admin: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE", icon: "◈" },
  member: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0", icon: "●" },
  custom: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE", icon: "✦" },
} as const;

type RoleKey = keyof typeof roleThemes;

/* ------------------------------ 权限模型数据 ------------------------------ */
/** 权限矩阵：行=资源（对齐现有业务原型域），列=操作（6 项） */
const RESOURCES = [
  { label: "任务", icon: "▤" },
  { label: "群聊", icon: "✉" },
  { label: "产出物", icon: "▦" },
  { label: "Agent 配置", icon: "◉" },
  { label: "Worker 节点", icon: "⚙" },
  { label: "技能工具", icon: "◫" },
  { label: "用户管理", icon: "☷" },
  { label: "权限配置", icon: "◈" },
] as const;

const ACTIONS = ["查看", "创建", "编辑", "删除", "验收", "管理"] as const;

interface RoleDef {
  key: RoleKey;
  label: string;
  desc: string;
  /** 矩阵：8 资源 × 6 操作 */
  matrix: Perm[][];
  /** 权限范围（permission-scope） */
  scope: {
    global: boolean;
    projects: string[];
    innerRoles: string[];
  };
}

/** 平台管理员：全 ✓（管理账号 / 项目 / 角色模板 / 全局策略） */
const adminMatrix: Perm[][] = RESOURCES.map(() => Array(ACTIONS.length).fill("allow"));

/** 项目成员：任务全协作（查看/创建/验收 ✓）、用户管理/权限配置 ✗、其余部分 */
const memberMatrix: Perm[][] = [
  ["allow", "allow", "allow", "deny", "allow", "deny"], // 任务
  ["allow", "allow", "partial", "partial", "deny", "deny"], // 群聊
  ["allow", "allow", "partial", "partial", "deny", "deny"], // 产出物
  ["allow", "partial", "partial", "deny", "deny", "deny"], // Agent 配置
  ["allow", "deny", "deny", "deny", "deny", "deny"], // Worker 节点
  ["allow", "partial", "partial", "deny", "deny", "deny"], // 技能工具
  ["deny", "deny", "deny", "deny", "deny", "deny"], // 用户管理
  ["deny", "deny", "deny", "deny", "deny", "deny"], // 权限配置
];

/** 自定义角色：按需组合（介于两者之间，如「验收员」可验收但不可管理账号） */
const customMatrix: Perm[][] = [
  ["allow", "allow", "allow", "deny", "allow", "deny"], // 任务
  ["allow", "allow", "partial", "deny", "deny", "deny"], // 群聊
  ["allow", "allow", "allow", "deny", "allow", "deny"], // 产出物
  ["allow", "deny", "deny", "deny", "deny", "deny"], // Agent 配置
  ["allow", "deny", "deny", "deny", "deny", "deny"], // Worker 节点
  ["allow", "partial", "partial", "deny", "deny", "deny"], // 技能工具
  ["deny", "deny", "deny", "deny", "deny", "deny"], // 用户管理
  ["deny", "deny", "deny", "deny", "deny", "deny"], // 权限配置
];

const ROLES: RoleDef[] = [
  {
    key: "admin",
    label: "平台管理员",
    desc: "管理平台账号 / 项目生命周期 / 角色模板 / 全局安全与权限策略（02 篇 1.1）",
    matrix: adminMatrix,
    scope: { global: true, projects: [], innerRoles: [] },
  },
  {
    key: "member",
    label: "项目成员",
    desc: "在所属项目内参与任务、群聊、产出物与 Agent 协作（02 篇 1.2）",
    matrix: memberMatrix,
    scope: {
      global: false,
      projects: ["智能报表模块", "数据采集平台", "告警中心"],
      innerRoles: ["产品经理", "架构师", "开发者", "测试"],
    },
  },
  {
    key: "custom",
    label: "自定义角色",
    desc: "按需组合资源权限，如「验收员」「运维专员」等岗位化角色",
    matrix: customMatrix,
    scope: { global: false, projects: ["智能报表模块"], innerRoles: ["验收"] },
  },
];

/** 项目候选池 + 项目内角色候选池 */
const projectPool = ["智能报表模块", "数据采集平台", "告警中心"];
const innerRolePool = ["产品经理", "架构师", "开发者", "测试", "验收"];

/* Cmd+K 命令项：导航组图标与 Dock 一一对应，「用户管理」高亮呼应当前页 */
const CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "导航", label: "用户管理", icon: "☷", active: true },
  { group: "操作", label: "新增角色", icon: "＋" },
  { group: "操作", label: "复制角色", icon: "⧉" },
  { group: "操作", label: "查看权限请求", icon: "◷" },
];

/* ------------------------------ 子组件 ------------------------------ */

/** 权限矩阵：行=资源，列=操作，格=✓/◐/✗ */
function PermissionMatrix({ matrix }: { matrix: Perm[][] }) {
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
  const cell = (perm: Perm): CSSProperties => {
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
              <th key={a} style={th}>{a}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {RESOURCES.map((r, ri) => (
            <tr key={r.label}>
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
              {matrix[ri].map((p, ci) => (
                <td
                  key={ci}
                  data-perm={p}
                  style={{
                    padding: `${space.xs}px ${space.xs}px`,
                    textAlign: "center",
                    borderBottom: `1px solid ${neutral[100]}`,
                  }}
                >
                  <span style={cell(p)}>{permCellTheme[p].mark}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 权限范围：全局 / 指定项目（多选）/ 项目内角色 */
function PermissionScope({ def }: { def: RoleDef }) {
  const [scopeType, setScopeType] = useState<"global" | "projects">(def.scope.global ? "global" : "projects");
  const theme = roleThemes[def.key];

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
            onClick={() => setScopeType("global")}
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
            onClick={() => setScopeType("projects")}
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
          {projectPool.map((p) => {
            const active = def.scope.projects.includes(p);
            return (
              <span
                key={p}
                data-project={p}
                data-active={active ? "true" : "false"}
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
                  cursor: scopeType === "projects" ? "pointer" : "not-allowed",
                  fontFamily: fontFamily.body,
                }}
              >
                {active && <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>✓</span>}
                {p}
              </span>
            );
          })}
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
            const active = def.scope.innerRoles.includes(r);
            return (
              <span
                key={r}
                data-inner-role={r}
                data-active={active ? "true" : "false"}
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

/** 权限格图例条 */
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

/* ------------------------------ 页面主组件 ------------------------------ */

function RolePermissionPage() {
  /* Cmd+K 命令面板受控开关（T20）：默认关闭 */
  const [cmdkOpen, setCmdkOpen] = useState(false);
  /* 当前选中角色（受控切换） */
  const [activeRole, setActiveRole] = useState<RoleKey>("admin");

  const def = ROLES.find((r) => r.key === activeRole)!;
  const theme = roleThemes[def.key];

  return (
    <div
      data-testid="role-permission-root"
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
        title="角色与权限"
        subtitle="平台权限 · 用户能操作什么（02 篇 1.1 / 1.2）"
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
            {ROLES.map((r) => {
              const active = r.key === activeRole;
              const t = roleThemes[r.key];
              return (
                <button
                  key={r.key}
                  type="button"
                  data-testid="role-item"
                  data-role={r.key}
                  data-active={active ? "true" : "false"}
                  onClick={() => setActiveRole(r.key)}
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
                      {r.label}
                    </span>
                    <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>
                      {r.matrix.flat().filter((p) => p === "allow").length} 项允许 · 角色模板
                    </span>
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              data-testid="add-role-button"
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
                  {def.label}
                </div>
                <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>{def.desc}</div>
              </div>
            </div>

            {/* 权限矩阵 */}
            <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>权限矩阵</span>
                <PermLegend />
              </div>
              <PermissionMatrix matrix={def.matrix} />
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                行 = 资源（对齐平台业务域：任务 / 群聊 / 产出物 / Agent 配置 / Worker 节点 / 技能工具 /
                用户管理 / 权限配置）；列 = 操作（查看 / 创建 / 编辑 / 删除 / 验收 / 管理）
              </span>
            </div>

            {/* 权限范围 */}
            <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
              <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>权限范围</span>
              {/* key=def.key：角色切换时重挂载，scopeType 初始值（global/projects）随角色重置 */}
              <PermissionScope def={def} key={def.key} />
            </div>

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
        </div>
      </main>

      {/* 左侧 Dock 悬浮导航：activeKey="users"（用户管理域） */}
      <NavDock activeKey="users" projectName="Agent 协作平台" />

      {/* Cmd+K 命令面板：受控开关（T20）——初始关闭，trigger 打开，✕/遮罩/Esc 关闭 */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "role-permission",
    name: "角色与权限",
    group: "平台",
    description:
      "角色列表（平台管理员/项目成员/自定义）+ 权限矩阵（资源×操作 ✓/◐/✗）+ 权限范围（全局/指定项目/项目内角色）",
    device: "desktop",
  },
  Component: RolePermissionPage,
};

export default def;
