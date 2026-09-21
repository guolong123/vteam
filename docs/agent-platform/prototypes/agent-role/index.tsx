/**
 * 原型：岗位管理（AgentRole · 角色实体）
 * =============================================
 * 对应计划 agent-role-entity 的「角色」实体（`AgentRole`，挂在 /agents 的 Tab 2）。
 *
 * ⚠️ 与 role-permission 的区别：那个原型是【用户 RBAC 角色】（平台管理员 / 团队成员，
 * 管"人能操作什么"）；本原型是【岗位角色 AgentRole】（产品经理 / 开发者，管"这是
 * 一个什么岗位"）。两者是不同实体，命名刻意区分：AgentRole 不叫 Role（避免与
 * schema.prisma 的 RBAC Role 撞名），本页中文用「岗位」以免混淆。
 *
 * 岗位的属性（严格对齐计划，不得越界）：
 *   key            机器安全标识（唯一）
 *   name           岗位名称（给人看，如「产品经理」）
 *   description    一句话说明
 *   type           builtin（内置，只读+禁删）/ custom（可增删改）
 *   defaultAgentId 默认绑定的 Agent ← 选岗位即预填 Agent
 *   rolePrompt     岗位职责提示词（"这是个什么岗位"）
 *   sortOrder      排序
 *   ✗ 无能力字段 —— 权限/工具/模型/worker 都不属于岗位（明确禁止）
 *
 * 页面内容：
 * - 左栏：岗位列表（7 内置 + 自定义示例），支持搜索 + 类型筛选；每项展示岗位名 /
 *   内置-自定义徽章 / 默认 Agent / 职责摘要。
 * - 右栏：岗位详情编辑表单（名称 / 说明 / 默认 Agent / 岗位职责提示词 / 排序），
 *   内置岗位只读（顶部提示 + 无删除），自定义可编辑 / 克隆 / 删除。
 * - 明示「能力不在此处」：一个说明条指向 Agent 页（能力挂在 Agent 上）。
 * - 明示「岗位与 Agent 的关系」：岗位定义"是什么"，Agent 定义"怎么跑、能做什么"。
 * - mock：全部演示值；搜索/筛选/选中/编辑态均为前端状态，无服务端交互。
 * - 复用 ../_shared/nav + ../_shared/styles token。
 * - ⚠️ T15 铁律：root height:100% + position:relative，零 fixed / vh / vw。
 */
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起态宽度（与 _shared/nav RAIL_W 对齐） */
const RAIL_W = 56;

/* ============================== 语义色 ============================== */
/** 岗位主题色（按 role key；与 Agent 页保持一致的心智） */
const roleTheme: Record<string, { color: string; bg: string; border: string }> = {
  product: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  project_manager: { color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
  architect: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  developer: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  tester: { color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  plan: { color: "#4F46E5", bg: "#EEF2FF", border: "#C7D2FE" },
  librarian: { color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
  general: { color: "#78716C", bg: "#FAFAF9", border: "#E7E5E4" },
};

/** 类型徽章 */
const typeTheme = {
  builtin: { label: "内置", color: "#475569", bg: "#F1F5F9", border: "#E2E8F0" },
  custom: { label: "自定义", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
} as const;
type RoleType = keyof typeof typeTheme;

/* ============================== 岗位数据（mock） ============================== */
interface RoleDef {
  id: string;
  key: string;
  name: string;
  desc: string;
  type: RoleType;
  /** 默认绑定的 Agent（AgentRole.defaultAgentId → Agent.name） */
  defaultAgent: string;
  rolePrompt: string;
  sortOrder: number;
  /** 在队成员数（展示用，说明该岗位有人用 → 不可删） */
  usedBy: number;
}

const ROLES: RoleDef[] = [
  {
    id: "ar_product",
    key: "product",
    name: "产品经理",
    desc: "需求分析与原型设计",
    type: "builtin",
    defaultAgent: "产品经理 Agent",
    rolePrompt:
      "你是产品经理。职责：澄清并定义需求，输出需求文档与原型；\n不编写实现代码、不做技术方案、不替代测试判定。\n边界：以 ExecutionPolicy 与【职责边界】为准，越界会被拒绝。",
    sortOrder: 1,
    usedBy: 2,
  },
  {
    id: "ar_pm",
    key: "project_manager",
    name: "项目经理",
    desc: "流程协调与推进",
    type: "builtin",
    defaultAgent: "项目经理 Agent",
    rolePrompt:
      "你是项目经理。职责：编排任务节奏、维护计划状态、协调成员协作、推动收敛；\n不实现代码、不做技术方案。\n边界：以 ExecutionPolicy 与【职责边界】为准。",
    sortOrder: 2,
    usedBy: 1,
  },
  {
    id: "ar_architect",
    key: "architect",
    name: "架构师",
    desc: "技术方案与设计文档",
    type: "builtin",
    defaultAgent: "架构师 Agent",
    rolePrompt:
      "你是架构师。职责：基于需求产出架构与技术方案、设计文档，只读核对仓库现状；\n不编写实现代码。\n边界：以 ExecutionPolicy 与【职责边界】为准。",
    sortOrder: 3,
    usedBy: 1,
  },
  {
    id: "ar_developer",
    key: "developer",
    name: "开发者",
    desc: "编码与实现",
    type: "builtin",
    defaultAgent: "开发者 Agent",
    rolePrompt:
      "你是开发者。职责：按方案完成代码实现，提交产出物与实现说明；\n不做需求判定、不替代测试结论。\n边界：以 ExecutionPolicy 与【职责边界】为准。",
    sortOrder: 4,
    usedBy: 3,
  },
  {
    id: "ar_tester",
    key: "tester",
    name: "测试",
    desc: "验证与判据",
    type: "builtin",
    defaultAgent: "测试 Agent",
    rolePrompt:
      "你是测试。职责：设计用例、执行验证、给出可复现的结论与缺陷；\n不修改实现代码。\n边界：以 ExecutionPolicy 与【职责边界】为准。",
    sortOrder: 5,
    usedBy: 1,
  },
  {
    id: "ar_plan",
    key: "plan",
    name: "计划员",
    desc: "计划起草与修订",
    type: "builtin",
    defaultAgent: "计划员 Agent",
    rolePrompt:
      "你是计划员。职责：产出计划文档、汇总评审意见、按轮次收敛；\n只起草与汇总，不执行实现。\n边界：以 ExecutionPolicy 与【职责边界】为准；受收敛门约束。",
    sortOrder: 6,
    usedBy: 1,
  },
  {
    id: "ar_librarian",
    key: "librarian",
    name: "资料员",
    desc: "资料检索与整理",
    type: "builtin",
    defaultAgent: "资料员 Agent",
    rolePrompt:
      "你是资料员。职责：外部资料检索、文档归档与引用整理；\n不主动通知、不创建 Issue。\n边界：以 ExecutionPolicy 与【职责边界】为准。",
    sortOrder: 7,
    usedBy: 0,
  },
  {
    id: "ar_general",
    key: "general",
    name: "未分类",
    desc: "存量无角色成员的兜底岗位",
    type: "custom",
    defaultAgent: "（未绑定）",
    rolePrompt: "你是团队通用成员。职责：按派发任务工作。\n边界：以 ExecutionPolicy 与【职责边界】为准。",
    sortOrder: 90,
    usedBy: 1,
  },
  {
    id: "ar_release",
    key: "release_manager",
    name: "发布管家",
    desc: "发布检查与变更记录",
    type: "custom",
    defaultAgent: "发布检查 Agent",
    rolePrompt:
      "你是发布管家。职责：发布前检查清单、记录变更、核对回滚方案；\n不修改业务实现代码。\n边界：以 ExecutionPolicy 与【职责边界】为准。",
    sortOrder: 91,
    usedBy: 1,
  },
];

/* 可绑定的 Agent（defaultAgentId 选择项） */
/** 可绑定的 Agent（defaultAgentId 选择项）—— 按能力档命名，非一岗一个 Agent */
const AGENT_OPTIONS = [
  "（未绑定）",
  "资料员 Agent",
  "计划员 Agent",
  "产品经理 Agent",
  "架构师 Agent",
  "测试 Agent",
  "项目经理 Agent",
  "开发者 Agent",
  "发布检查 Agent",
  "文档助手",
];
const CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉", active: true },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "操作", label: "新建自定义岗位", icon: "＋" },
  { group: "操作", label: "复制岗位", icon: "⧉" },
  { group: "操作", label: "切换 Agent Tab", icon: "⇄" },
];

const inputStyle: CSSProperties = {
  width: "100%",
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "#FFFFFF",
  fontSize: fontSize.md,
  color: neutral[800],
  fontFamily: fontFamily.body,
  outline: "none",
};

function Btn({
  children,
  variant = "secondary",
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
}) {
  const themes = {
    primary: { bg: "#2563EB", color: "#FFFFFF", border: "#2563EB" },
    secondary: { bg: "#FFFFFF", color: neutral[600], border: neutral[200] },
    danger: { bg: "#FFFFFF", color: "#DC2626", border: "#FECACA" },
  } as const;
  const t = themes[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: space.xs,
        padding: `${space.sm}px ${space.lg}px`,
        borderRadius: radius.md,
        border: `1px solid ${t.border}`,
        backgroundColor: t.bg,
        color: t.color,
        fontSize: fontSize.md,
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: fontFamily.body,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

/* ============================== 页面主组件 ============================== */

function AgentRolePage() {
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(ROLES[0].id);
  const [keyword, setKeyword] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | RoleType>("all");

  const role = ROLES.find((r) => r.id === selectedId)!;
  const readOnly = role.type === "builtin";
  const theme = roleTheme[role.key] ?? roleTheme.general;

  const filtered = useMemo(
    () =>
      ROLES.filter((r) => {
        const byType = typeFilter === "all" || r.type === typeFilter;
        const kw = keyword.trim().toLowerCase();
        const byKw = !kw || r.name.toLowerCase().includes(kw) || r.key.toLowerCase().includes(kw);
        return byType && byKw;
      }),
    [keyword, typeFilter],
  );

  return (
    <div
      data-testid="agent-role-root"
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
      <NavTopBar
        title="岗位管理 · 角色"
        subtitle="岗位定义「这是一个什么岗位」；能力属于 Agent，不在此处"
        userName="运营者"
        userRole="平台管理员"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: `${space.xl}px ${space.xl}px ${space.xl}px ${RAIL_W + space.xl}px`,
        }}
      >
        {/* Tab 条：Agent / 岗位（对齐 /agents 页的 Tab 结构） */}
        <div
          style={{
            display: "inline-flex",
            gap: 2,
            padding: 3,
            borderRadius: radius.pill,
            backgroundColor: neutral[100],
            marginBottom: space.lg,
          }}
        >
          {[
            { k: "agent", label: "Agent", active: false },
            { k: "role", label: "岗位", active: true },
          ].map((t) => (
            <span
              key={t.k}
              data-testid="agents-tab"
              data-tab={t.k}
              data-active={t.active ? "true" : "false"}
              style={{
                padding: `${space.xs + 1}px ${space.lg}px`,
                borderRadius: radius.pill,
                fontSize: fontSize.sm,
                fontWeight: t.active ? 600 : 500,
                color: t.active ? neutral[900] : neutral[500],
                backgroundColor: t.active ? "#FFFFFF" : "transparent",
                boxShadow: t.active ? shadow.sm : "none",
              }}
            >
              {t.label}
            </span>
          ))}
        </div>

        <div style={{ display: "flex", gap: space.xl, alignItems: "flex-start", maxWidth: 1200 }}>
          {/* ============ 左：岗位列表 ============ */}
          <div style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column", gap: space.md }}>
            <div style={{ display: "flex", gap: space.sm }}>
              <input
                data-testid="role-search"
                type="text"
                placeholder="搜索岗位名 / 标识…"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
              />
              <Btn variant="primary">＋ 新建</Btn>
            </div>

            <div style={{ display: "flex", gap: space.xs }}>
              {(
                [
                  { k: "all", label: "全部" },
                  { k: "builtin", label: "内置" },
                  { k: "custom", label: "自定义" },
                ] as const
              ).map((t) => {
                const active = typeFilter === t.k;
                const count = t.k === "all" ? ROLES.length : ROLES.filter((r) => r.type === t.k).length;
                return (
                  <button
                    key={t.k}
                    type="button"
                    data-testid="role-type-filter"
                    data-type={t.k}
                    onClick={() => setTypeFilter(t.k)}
                    style={{
                      padding: `${space.xs}px ${space.md}px`,
                      borderRadius: radius.pill,
                      border: `1px solid ${active ? "#BFDBFE" : neutral[200]}`,
                      backgroundColor: active ? "#EFF6FF" : "#FFFFFF",
                      color: active ? "#2563EB" : neutral[500],
                      fontSize: fontSize.sm,
                      fontWeight: active ? 600 : 400,
                      cursor: "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    {t.label} {count}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              {filtered.map((r) => {
                const active = r.id === selectedId;
                const rt = roleTheme[r.key] ?? roleTheme.general;
                const tt = typeTheme[r.type];
                return (
                  <button
                    key={r.id}
                    type="button"
                    data-testid="role-item"
                    data-role-key={r.key}
                    data-role-type={r.type}
                    data-active={active ? "true" : "false"}
                    onClick={() => setSelectedId(r.id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      cursor: "pointer",
                      border: `1px solid ${active ? rt.border : neutral[200]}`,
                      borderRadius: radius.lg,
                      backgroundColor: active ? rt.bg : "#FFFFFF",
                      boxShadow: active ? shadow.sm : "none",
                      padding: space.md,
                      display: "flex",
                      gap: space.md,
                      fontFamily: fontFamily.body,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 34,
                        height: 34,
                        flexShrink: 0,
                        borderRadius: radius.md,
                        backgroundColor: rt.bg,
                        border: `1.5px solid ${rt.border}`,
                        color: rt.color,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: fontSize.lg,
                        fontWeight: 700,
                      }}
                    >
                      {r.name.charAt(0)}
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: space.xs }}>
                        <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
                          {r.name}
                        </span>
                        <span
                          style={{
                            fontSize: fontSize.xs,
                            fontWeight: 600,
                            color: tt.color,
                            backgroundColor: tt.bg,
                            border: `1px solid ${tt.border}`,
                            borderRadius: radius.pill,
                            padding: "1px 7px",
                          }}
                        >
                          {tt.label}
                        </span>
                      </span>
                      <span style={{ display: "block", fontSize: fontSize.sm, color: neutral[500], marginTop: 2 }}>
                        {r.desc}
                      </span>
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: space.sm,
                          marginTop: space.xs,
                          fontSize: fontSize.xs,
                          color: neutral[400],
                        }}
                      >
                        <span style={{ fontFamily: fontFamily.mono }}>{r.key}</span>
                        <span>· 默认 Agent：{r.defaultAgent}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ============ 右：岗位详情 ============ */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
            {/* 头部 */}
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: space.lg,
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
                  width: 48,
                  height: 48,
                  flexShrink: 0,
                  borderRadius: radius.lg,
                  backgroundColor: theme.bg,
                  border: `1.5px solid ${theme.border}`,
                  color: theme.color,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: fontSize.xxl,
                  fontWeight: 700,
                }}
              >
                {role.name.charAt(0)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                  <span style={{ fontSize: fontSize.xxl, fontWeight: 700, color: neutral[900] }}>
                    {role.name}
                  </span>
                  <span
                    style={{
                      fontSize: fontSize.xs,
                      fontWeight: 600,
                      color: typeTheme[role.type].color,
                      backgroundColor: typeTheme[role.type].bg,
                      border: `1px solid ${typeTheme[role.type].border}`,
                      borderRadius: radius.pill,
                      padding: "2px 9px",
                    }}
                  >
                    {typeTheme[role.type].label}
                  </span>
                  <span style={{ fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.mono }}>
                    {role.key}
                  </span>
                </div>
                <div style={{ fontSize: fontSize.sm, color: neutral[500], marginTop: 3 }}>
                  在队成员 {role.usedBy} 人 · 排序 {role.sortOrder}
                </div>
              </div>
              <div style={{ display: "flex", gap: space.sm }}>
                <Btn>⧉ 克隆</Btn>
                {readOnly ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      fontSize: fontSize.sm,
                      color: neutral[400],
                      padding: `${space.sm}px ${space.md}px`,
                    }}
                  >
                    ⓘ 内置岗位受保护
                  </span>
                ) : (
                  <Btn variant="danger">删除</Btn>
                )}
              </div>
            </div>

            {/* 内置只读提示 */}
            {readOnly ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.sm,
                  padding: `${space.md}px ${space.lg}px`,
                  borderRadius: radius.md,
                  backgroundColor: neutral[100],
                  border: `1px solid ${neutral[200]}`,
                  fontSize: fontSize.sm,
                  color: neutral[500],
                }}
              >
                ⓘ 内置岗位的字段只读；如需调整请「克隆」为自定义岗位后编辑。
              </div>
            ) : null}

            {/* 编辑表单 */}
            <div
              style={{
                padding: `${space.lg}px ${space.xl}px`,
                borderRadius: radius.lg,
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
              }}
            >
              <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800], marginBottom: space.lg }}>
                岗位属性
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.lg }}>
                <div>
                  <div style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs }}>
                    岗位名称
                  </div>
                  <input
                    data-testid="role-name"
                    type="text"
                    readOnly={readOnly}
                    value={role.name}
                    style={{ ...inputStyle, backgroundColor: readOnly ? neutral[50] : "#FFFFFF" }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs }}>
                    标识 key（机器安全，唯一）
                  </div>
                  <input
                    type="text"
                    readOnly
                    value={role.key}
                    style={{
                      ...inputStyle,
                      backgroundColor: neutral[50],
                      color: neutral[500],
                      fontFamily: fontFamily.mono,
                    }}
                  />
                </div>
              </div>

              <div style={{ marginTop: space.lg }}>
                <div style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs }}>
                  一句话说明
                </div>
                <input
                  type="text"
                  readOnly={readOnly}
                  value={role.desc}
                  style={{ ...inputStyle, backgroundColor: readOnly ? neutral[50] : "#FFFFFF" }}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: space.lg, marginTop: space.lg }}>
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.sm,
                      fontSize: fontSize.sm,
                      fontWeight: 500,
                      color: neutral[600],
                      marginBottom: space.xs,
                    }}
                  >
                    默认绑定 Agent
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: "#0891B2",
                        backgroundColor: "#ECFEFF",
                        border: "1px solid #A5F3FC",
                        borderRadius: radius.pill,
                        padding: "1px 7px",
                      }}
                    >
                      选岗位即预填
                    </span>
                  </div>
                  <select
                    data-testid="role-default-agent"
                    disabled={readOnly}
                    value={role.defaultAgent}
                    style={{
                      ...inputStyle,
                      backgroundColor: readOnly ? neutral[50] : "#FFFFFF",
                      color: readOnly ? neutral[500] : neutral[800],
                    }}
                  >
                    {AGENT_OPTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: space.xs, lineHeight: 1.6 }}>
                    添加团队成员时按岗位预填此 Agent；成员仍可显式改选别的 Agent（显式选择优先）。
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs }}>
                    排序
                  </div>
                  <input
                    type="number"
                    readOnly={readOnly}
                    value={role.sortOrder}
                    style={{ ...inputStyle, backgroundColor: readOnly ? neutral[50] : "#FFFFFF" }}
                  />
                </div>
              </div>

              <div style={{ marginTop: space.lg }}>
                <div style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs }}>
                  岗位职责提示词 rolePrompt
                </div>
                <textarea
                  data-testid="role-prompt"
                  rows={5}
                  readOnly={readOnly}
                  value={role.rolePrompt}
                  style={{
                    ...inputStyle,
                    resize: "vertical",
                    lineHeight: 1.7,
                    backgroundColor: readOnly ? neutral[50] : "#FFFFFF",
                  }}
                />
                <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: space.xs, lineHeight: 1.7 }}>
                  答「这是一个什么岗位」（身份 / 职责 / 边界声明）。与 Agent 的操作者提示词
                  <strong> 拼接 </strong>下发，不是覆盖关系；权限边界统一指向 ExecutionPolicy，不在此重复罗列。
                </div>
              </div>

              {!readOnly ? (
                <div style={{ display: "flex", gap: space.sm, marginTop: space.lg }}>
                  <Btn variant="primary">保存</Btn>
                  <Btn>取消</Btn>
                </div>
              ) : null}
            </div>

            {/* 明示：能力不在岗位 */}
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: space.md,
                padding: `${space.md}px ${space.lg}px`,
                borderRadius: radius.md,
                backgroundColor: "#FDF4E3",
                border: "1px solid #ECD9AB",
                fontSize: fontSize.sm,
                color: "#8A6415",
                lineHeight: 1.75,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1.2 }}>⚠</span>
              <div>
                <strong>能力不在这里。</strong>
                权限 / 工具 / 模型 / Worker 都<strong>不是岗位属性</strong>，它们挂在 Agent 上。
                岗位只回答「这是一个什么岗位」；「能做什么」由绑定 Agent 的
                <code style={{ fontFamily: fontFamily.mono }}> policyId </code>
                决定。这样换岗位描述不动能力，调能力不动岗位。
              </div>
            </div>
          </div>
        </div>
      </main>

      <NavDock activeKey="agents" projectName="Agent 协作平台" />
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "agent-role",
    name: "岗位管理（角色）",
    group: "平台",
    description:
      "AgentRole 角色实体：岗位列表 + 详情编辑（名称/说明/默认 Agent/岗位职责提示词/排序）；内置只读、自定义可克隆删除；明确能力不在岗位而在 Agent",
    device: "desktop",
  },
  Component: AgentRolePage,
};

export default def;
