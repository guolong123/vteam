/**
 * 原型：Agent 管理
 * =============================================
 * 对应计划 agent-native-permission-editor（权限编辑器）+ agent-role-entity（Tab 结构）
 * 落地后的「Agent 管理」页（/agents 的 Tab 1）。
 *
 * ⚠️ 与 agent-role 的分工（两个不同实体，必须分清）：
 *   Agent（本页）—— 可执行单元：「用什么跑、怎么干、能做什么」
 *     属性：agentKey（引擎绑定名，= vteam-<key>）/ type（模板·自定义·克隆）
 *           baseAgentId（克隆来源）/ prompt（操作者提示词，"我该怎么干"）
 *           defaultModelId / workerId / persona / policyId（★ 能力：权限与工具）
 *   岗位 AgentRole（agent-role 页）—— 「这是一个什么岗位」：key/name/description/
 *           type/defaultAgentId/rolePrompt/sortOrder；**无能力字段**。
 *
 * 页面内容：
 * - Tab 条：Agent（本页激活）/ 岗位（指向 agent-role 页）。
 * - 左栏：Agent 列表（模板 / 自定义 / 克隆），支持搜索 + 类型筛选。
 * - 右栏：Agent 详情，按属性分组：
 *   · ① 身份：agentKey / 类型 / 绑定岗位 / 克隆来源
 *   · ② 运行参数：默认模型 / 首选 Worker / 性格
 *   · ③ 操作者提示词 prompt（"我该怎么干"）
 *   · ④ 能力（policyId）：原生权限 4 行 + MCP 工具三态矩阵（本次计划核心）
 * - 新建弹窗：能力档选择器（选档级即继承其权限与工具）。
 * - 克隆弹窗 / 删除确认（模板受保护）。
 * - mock：全部演示值；搜索/筛选/选中/弹窗/权限格切换均为前端状态。
 * - 复用 ../_shared/nav + ../_shared/styles token。
 * - ⚠️ T15 铁律：root height:100% + position:relative；弹窗 absolute；零 fixed / vh / vw。
 */
import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起态宽度（与 _shared/nav RAIL_W 对齐） */
const RAIL_W = 56;

/* ============================== 语义色 ============================== */
const roleTheme: Record<string, { label: string; color: string; bg: string; border: string }> = {
  product: { label: "产品经理", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  project_manager: { label: "项目经理", color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
  architect: { label: "架构师", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  developer: { label: "开发者", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  tester: { label: "测试", color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  plan: { label: "计划员", color: "#4F46E5", bg: "#EEF2FF", border: "#C7D2FE" },
  librarian: { label: "资料员", color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
  release_manager: { label: "发布管家", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  general: { label: "未分类", color: "#78716C", bg: "#FAFAF9", border: "#E7E5E4" },
};

const typeTheme = {
  template: { label: "模板", color: "#475569", bg: "#F1F5F9", border: "#E2E8F0" },
  custom: { label: "自定义", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  clone: { label: "克隆", color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
} as const;
type AgentType = keyof typeof typeTheme;

/** 工具三态（对齐 opencode PermissionV2：allow / ask / deny） */
const toolEffect = {
  allow: { label: "允许", mark: "✓", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  ask: { label: "询问", mark: "◐", color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  deny: { label: "拒绝", mark: "✕", color: "#94A3B8", bg: "#F8FAFC", border: "#E2E8F0" },
} as const;
type ToolEffect = keyof typeof toolEffect;

const PERSONA_LABEL: Record<string, string> = {
  "": "未配置",
  steady: "沉稳",
  strict: "苛刻",
  aggressive: "激进",
  conservative: "保守",
  innovative: "创新",
};

/* ============================== 岗位选择项（新建时继承策略） ==============================
 * 新建 Agent 的实际机制 = 选一个岗位、继承它的 ep_<role> 策略。
 * 刻意不含「计划员」：ep_plan 带 task:allow，会被守卫按字面名 vteam-plan 遮蔽，提供会误导。
 */
const TIER_CHOICES: { key: string | null; label: string; note: string }[] = [
  { key: null, label: "不指定（空骨架）", note: "仅基础读权限，能力为空；创建后可在本页逐项开启" },
  { key: "product", label: "产品经理", note: "可写 prototypes + docs" },
  { key: "project_manager", label: "项目经理", note: "无写权限 · 禁止执行命令 · 全套管理工具" },
  { key: "architect", label: "架构师", note: "仅 docs 可写" },
  { key: "developer", label: "开发者", note: "整个任务目录可写 · 含 git" },
  { key: "tester", label: "测试", note: "可写 tests + docs" },
];

/* ============================== Agent 数据 ==============================
 * 能力档由三根轴决定，取自 agent.constants.ts 的真实定义：
 * 写范围 writeGlobs / 命令执行 bashEffect / 管理类工具。
 * 结果：7 个岗位 → 5 个能力档 Agent（名称按能力取，不再叫岗位名）。
 */
interface AgentDef {
  id: string;
  name: string;
  /** 能力族标签（仅用于分组/显示，不代表能力相同） */
  family: "readonly" | "plan" | "document" | "coordinate" | "code";
  /** 该 Agent 出厂对应的岗位 key（能力以此为准） */
  roleKey: string;
  type: AgentType;
  agentKey: string;
  baseAgent?: string;
  model: string;
  worker: string;
  persona: string;
  prompt: string;
  /** 本 Agent 实际写范围一行说明 */
  tierNote: string;
  toolCount: number;
  pathCount: number;
  bash: ToolEffect;
  builtin: boolean;
}

const familyTheme: Record<string, { label: string; color: string; bg: string; border: string }> = {
  readonly: { label: "只读档", color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
  plan: { label: "计划档", color: "#4F46E5", bg: "#EEF2FF", border: "#C7D2FE" },
  document: { label: "文档档", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  coordinate: { label: "协调档", color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
  code: { label: "实现档", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
};
const AGENTS: AgentDef[] = [
  {
    id: "a_librarian",
    name: "资料员 Agent",
    family: "readonly",
    roleKey: "librarian",
    type: "template",
    agentKey: "librarian",
    model: "DeepSeek V4 Flash",
    worker: "自动调度",
    persona: "",
    prompt: "外部资料检索、文档归档与引用整理；不主动通知、不写文件。",
    tierNote: "无写权限 · 只读检索",
    toolCount: 11,
    pathCount: 0,
    bash: "allow",
    builtin: true,
  },
  {
    id: "a_plan",
    name: "计划员 Agent",
    family: "plan",
    roleKey: "plan",
    type: "template",
    agentKey: "plan",
    model: "DeepSeek V4 Pro",
    worker: "自动调度",
    persona: "steady",
    prompt: "起草计划文档、汇总评审意见、按轮次收敛；只写计划目录，不实现。",
    tierNote: "仅 .opencode/plans 可写",
    toolCount: 13,
    pathCount: 1,
    bash: "allow",
    builtin: true,
  },
  {
    id: "a_product",
    name: "产品经理 Agent",
    family: "document",
    roleKey: "product",
    type: "template",
    agentKey: "product",
    model: "DeepSeek V4 Pro",
    worker: "自动调度",
    persona: "steady",
    prompt: "澄清需求边界，产出需求文档与原型说明；不写实现代码。",
    tierNote: "可写 prototypes + docs",
    toolCount: 22,
    pathCount: 2,
    bash: "allow",
    builtin: true,
  },
  {
    id: "a_architect",
    name: "架构师 Agent",
    family: "document",
    roleKey: "architect",
    type: "template",
    agentKey: "architect",
    model: "DeepSeek V4 Pro",
    worker: "自动调度",
    persona: "conservative",
    prompt: "输出技术方案与设计文档；只读核对仓库现状，不改实现。",
    tierNote: "仅 docs 可写",
    toolCount: 22,
    pathCount: 1,
    bash: "allow",
    builtin: true,
  },
  {
    id: "a_tester",
    name: "测试 Agent",
    family: "document",
    roleKey: "tester",
    type: "template",
    agentKey: "tester",
    model: "DeepSeek V4 Flash",
    worker: "worker-linux-02",
    persona: "strict",
    prompt: "设计用例、执行验证、输出可复现的结论与缺陷；不改实现。",
    tierNote: "可写 tests + docs",
    toolCount: 25,
    pathCount: 2,
    bash: "allow",
    builtin: true,
  },
  {
    id: "a_pm",
    name: "项目经理 Agent",
    family: "coordinate",
    roleKey: "project_manager",
    type: "template",
    agentKey: "project_manager",
    model: "DeepSeek V4 Flash",
    worker: "worker-linux-01",
    persona: "strict",
    prompt: "编排任务节奏、维护计划状态、识别阻塞并推动收敛。",
    tierNote: "无写权限 · 禁止执行命令",
    toolCount: 27,
    pathCount: 0,
    bash: "deny",
    builtin: true,
  },
  {
    id: "a_developer",
    name: "开发者 Agent",
    family: "code",
    roleKey: "developer",
    type: "template",
    agentKey: "developer",
    model: "DeepSeek V4 Flash",
    worker: "worker-linux-01",
    persona: "aggressive",
    prompt: "按方案完成代码实现，提交产出物与实现说明；不做需求判定。",
    tierNote: "整个任务目录可写 · 含 git",
    toolCount: 26,
    pathCount: 1,
    bash: "allow",
    builtin: true,
  },
  {
    id: "c_release",
    name: "发布检查 Agent",
    family: "code",
    roleKey: "release_manager",
    type: "clone",
    agentKey: "release-checker",
    baseAgent: "开发者 Agent",
    model: "DeepSeek V4 Flash",
    worker: "worker-linux-02",
    persona: "conservative",
    prompt: "发布前检查清单、记录变更、核对回滚方案；不改业务实现。",
    tierNote: "克隆自开发者，能力再收窄",
    toolCount: 22,
    pathCount: 1,
    bash: "allow",
    builtin: false,
  },
  {
    id: "c_docbot",
    name: "文档助手",
    family: "document",
    roleKey: "general",
    type: "custom",
    agentKey: "doc-helper",
    model: "DeepSeek V4 Flash Free",
    worker: "自动调度",
    persona: "steady",
    prompt: "整理会议纪要与文档归档；只读代码，不提交实现。",
    tierNote: "自定义",
    toolCount: 9,
    pathCount: 1,
    bash: "deny",
    builtin: false,
  },
];

/* 原生权限 4 行 */
interface NativePerm {
  key: string;
  label: string;
  desc: string;
  kind: "glob" | "tri-state" | "readonly";
  globs?: { glob: string; effect: "allow" | "deny" }[];
  effect?: ToolEffect;
}
const NATIVE_PERMS: NativePerm[] = [
  {
    key: "edit", label: "写文件", kind: "glob", desc: "按路径规则允许 / 拒绝写入",
    globs: [
      { glob: "**tasks/*/docs/**", effect: "allow" },
      { glob: "*", effect: "deny" },
    ],
  },
  {
    key: "read", label: "读文件", kind: "glob", desc: "按路径规则允许 / 拒绝读取",
    globs: [{ glob: "*", effect: "allow" }],
  },
  { key: "bash", label: "执行命令", kind: "tri-state", desc: "允许 / 询问 / 拒绝", effect: "allow" },
  {
    key: "task", label: "派发子任务", kind: "readonly",
    desc: "执行引擎仅对内置计划员生效，故只读",
  },
];

const TOOL_GROUPS: { group: string; tools: string[] }[] = [
  { group: "任务", tools: ["task_context", "task_create", "task_transition", "question_confirm"] },
  { group: "计划", tools: ["plan_mode", "plan_complete"] },
  { group: "Issue", tools: ["issue_create", "issue_list", "issue_get", "issue_update", "issue_transition"] },
  { group: "协作", tools: ["group_post", "notify_agent", "chat_history", "team_view", "my_profile", "wecom_reply"] },
  { group: "知识", tools: ["memory_save", "memory_search", "memory_update", "skill_create"] },
  { group: "产出物", tools: ["submit_artifact", "doclib", "read_file"] },
];

function validateAgentKey(v: string): string | null {
  if (!v) return "标识不能为空";
  if (v.startsWith("vteam-")) return "不能以 vteam- 开头";
  if (!/^[a-z][a-z0-9_-]*$/.test(v)) return "小写字母开头，仅含小写字母/数字/_/-";
  if (v.length > 63) return "最多 63 字符";
  return null;
}

const CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉", active: true },
  { group: "操作", label: "新建 Agent", icon: "＋" },
  { group: "操作", label: "切换 岗位 Tab", icon: "⇄" },
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
  children, variant = "secondary", onClick, disabled,
}: {
  children: ReactNode; variant?: "primary" | "secondary" | "danger";
  onClick?: () => void; disabled?: boolean;
}) {
  const t = {
    primary: { bg: "#2563EB", color: "#FFFFFF", border: "#2563EB" },
    secondary: { bg: "#FFFFFF", color: neutral[600], border: neutral[200] },
    danger: { bg: "#FFFFFF", color: "#DC2626", border: "#FECACA" },
  }[variant];
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: space.xs,
        padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md,
        border: `1px solid ${t.border}`, backgroundColor: t.bg, color: t.color,
        fontSize: fontSize.md, fontWeight: 500, cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1, fontFamily: fontFamily.body, whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function Field({ label, value, mono, hint }: { label: string; value: string; mono?: boolean; hint?: string }) {
  return (
    <div
      style={{
        padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md,
        backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`,
      }}
    >
      <div style={{ fontSize: fontSize.xs, color: neutral[400], marginBottom: space.xs }}>{label}</div>
      <div
        style={{
          fontSize: fontSize.md, fontWeight: 600, color: neutral[800],
          fontFamily: mono ? fontFamily.mono : fontFamily.body,
        }}
      >
        {value}
      </div>
      {hint ? <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 3 }}>{hint}</div> : null}
    </div>
  );
}

function Section({ index, title, sub, children }: {
  index?: string; title: string; sub?: string; children: ReactNode;
}) {
  return (
    <div
      style={{
        padding: `${space.lg}px ${space.xl}px`, borderRadius: radius.lg,
        backgroundColor: "#FFFFFF", border: `1px solid ${neutral[200]}`,
      }}
    >
      <div style={{ marginBottom: space.lg }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          {index ? (
            <span
              aria-hidden
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 22, height: 22, borderRadius: radius.sm,
                backgroundColor: "#EFF6FF", color: "#2563EB",
                fontSize: fontSize.sm, fontWeight: 700,
              }}
            >
              {index}
            </span>
          ) : null}
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>{title}</span>
        </div>
        {sub ? (
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 3, marginLeft: index ? 30 : 0 }}>
            {sub}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Modal({ title, subtitle, onClose, children, footer, testid }: {
  title: string; subtitle?: string; onClose: () => void;
  children: ReactNode; footer: ReactNode; testid: string;
}) {
  return (
    <div
      data-testid={testid} onClick={onClose}
      style={{
        position: "absolute", inset: 0, zIndex: 60, display: "flex",
        alignItems: "center", justifyContent: "center",
        backgroundColor: "rgba(15,23,42,.38)", padding: space.xl,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 580, maxWidth: "100%", maxHeight: "100%",
          display: "flex", flexDirection: "column",
          borderRadius: radius.lg, backgroundColor: "#FFFFFF",
          boxShadow: shadow.lg, overflow: "hidden", ...baseFont,
        }}
      >
        <div
          style={{
            display: "flex", alignItems: "flex-start", justifyContent: "space-between",
            gap: space.md, padding: `${space.lg}px ${space.xl}px`,
            borderBottom: `1px solid ${neutral[200]}`,
          }}
        >
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900] }}>{title}</div>
            {subtitle ? (
              <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>{subtitle}</div>
            ) : null}
          </div>
          <button
            type="button" aria-label="关闭" onClick={onClose}
            style={{
              border: "none", background: "transparent", color: neutral[400],
              fontSize: fontSize.lg, cursor: "pointer", lineHeight: 1, padding: space.xs,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: `${space.lg}px ${space.xl}px`, overflowY: "auto" }}>{children}</div>
        <div
          style={{
            display: "flex", justifyContent: "flex-end", gap: space.sm,
            padding: `${space.md}px ${space.xl}px`,
            borderTop: `1px solid ${neutral[200]}`, backgroundColor: neutral[50],
          }}
        >
          {footer}
        </div>
      </div>
    </div>
  );
}

/* ============================== 页面主组件 ============================== */

function AgentManagePage() {
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(AGENTS[3].id);
  const [keyword, setKeyword] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | AgentType>("all");
  const [toolOverrides, setToolOverrides] = useState<Record<string, ToolEffect>>({});

  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState("");
  const [cKey, setCKey] = useState("");
  const [cRole, setCRole] = useState<string | null>("developer");
  const [cPrompt, setCPrompt] = useState("");
  const [cTouched, setCTouched] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneKey, setCloneKey] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const agent = AGENTS.find((a) => a.id === selectedId)!;
  const fam = familyTheme[agent.family];

  const filtered = useMemo(
    () =>
      AGENTS.filter((a) => {
        const byType = typeFilter === "all" || a.type === typeFilter;
        const kw = keyword.trim().toLowerCase();
        const kwRoles = (roleTheme[a.roleKey]?.label ?? a.roleKey).toLowerCase();
        const byKw =
          !kw ||
          a.name.toLowerCase().includes(kw) ||
          a.agentKey.toLowerCase().includes(kw) ||
          (familyTheme[a.family]?.label ?? "").toLowerCase().includes(kw) ||
          kwRoles.includes(kw);
        return byType && byKw;
      }),
    [keyword, typeFilter],
  );

  const cKeyError = validateAgentKey(cKey);
  const cCanSubmit = cName.trim() !== "" && cKeyError === null;
  const cloneKeyError = validateAgentKey(cloneKey);
  const cloneCanSubmit = cloneKey !== "" && cloneKeyError === null;

  const openCreate = () => {
    setCName(""); setCKey(""); setCRole("developer"); setCPrompt(""); setCTouched(false);
    setCreateOpen(true);
  };

  const toggleTool = (tool: string) => {
    setToolOverrides((prev) => {
      const cur = prev[tool] ?? "allow";
      const next: ToolEffect = cur === "deny" ? "allow" : cur === "allow" ? "ask" : "deny";
      return { ...prev, [tool]: next };
    });
  };

  return (
    <div
      data-testid="agent-manage-root"
      style={{
        height: "100%", minHeight: 720, position: "relative",
        display: "flex", flexDirection: "column",
        backgroundColor: neutral[50], fontFamily: fontFamily.body,
      }}
    >
      <NavTopBar
        title="Agent 管理"
        subtitle="可执行单元：引擎绑定 · 提示词 · 能力（权限与工具挂在 Agent 上）"
        userName="运营者" userRole="平台管理员"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      <main
        style={{
          flex: 1, minHeight: 0, overflowY: "auto",
          padding: `${space.xl}px ${space.xl}px ${space.xl}px ${RAIL_W + space.xl}px`,
        }}
      >
        {/* Tab 条 */}
        <div
          style={{
            display: "inline-flex", gap: 2, padding: 3,
            borderRadius: radius.pill, backgroundColor: neutral[100], marginBottom: space.lg,
          }}
        >
          {[
            { k: "agent", label: "Agent", active: true },
            { k: "role", label: "岗位", active: false },
          ].map((t) => (
            <span
              key={t.k} data-testid="agents-tab" data-tab={t.k} data-active={t.active ? "true" : "false"}
              style={{
                padding: `${space.xs + 1}px ${space.lg}px`, borderRadius: radius.pill,
                fontSize: fontSize.sm, fontWeight: t.active ? 600 : 500,
                color: t.active ? neutral[900] : neutral[500],
                backgroundColor: t.active ? "#FFFFFF" : "transparent",
                boxShadow: t.active ? shadow.sm : "none",
              }}
            >
              {t.label}
            </span>
          ))}
        </div>

        <div style={{ display: "flex", gap: space.xl, alignItems: "flex-start", maxWidth: 1240 }}>
          {/* ============ 左：列表 ============ */}
          <div style={{ width: 360, flexShrink: 0, display: "flex", flexDirection: "column", gap: space.md }}>
            <div style={{ display: "flex", gap: space.sm }}>
              <input
                data-testid="agent-search" type="text"
                placeholder="搜索名称 / 标识 / 岗位…"
                value={keyword} onChange={(e) => setKeyword(e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
              />
              <Btn variant="primary" onClick={openCreate}>＋ 新建</Btn>
            </div>

            <div style={{ display: "flex", gap: space.xs }}>
              {(
                [
                  { k: "all", label: "全部" },
                  { k: "template", label: "模板" },
                  { k: "custom", label: "自定义" },
                  { k: "clone", label: "克隆" },
                ] as const
              )
                .filter((t) => t.k === "all" || AGENTS.some((a) => a.type === t.k))
                .map((t) => {
                const active = typeFilter === t.k;
                const count = t.k === "all" ? AGENTS.length : AGENTS.filter((a) => a.type === t.k).length;
                return (
                  <button
                    key={t.k} type="button"
                    data-testid="type-filter" data-type={t.k} data-active={active ? "true" : "false"}
                    onClick={() => setTypeFilter(t.k)}
                    style={{
                      padding: `${space.xs}px ${space.md}px`, borderRadius: radius.pill,
                      border: `1px solid ${active ? "#BFDBFE" : neutral[200]}`,
                      backgroundColor: active ? "#EFF6FF" : "#FFFFFF",
                      color: active ? "#2563EB" : neutral[500],
                      fontSize: fontSize.sm, fontWeight: active ? 600 : 400,
                      cursor: "pointer", fontFamily: fontFamily.body,
                    }}
                  >
                    {t.label} {count}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              {filtered.length === 0 ? (
                <div
                  style={{
                    padding: `${space.xxl}px`, borderRadius: radius.lg,
                    border: `1px dashed ${neutral[300]}`, textAlign: "center",
                    color: neutral[400], fontSize: fontSize.md,
                  }}
                >
                  没有匹配的 Agent
                </div>
              ) : (
                filtered.map((a) => {
                  const active = a.id === selectedId;
                  const at = familyTheme[a.family];
                  const tt = typeTheme[a.type];
                  return (
                    <button
                      key={a.id} type="button"
                      data-testid="agent-list-item" data-agent-id={a.id} data-active={active ? "true" : "false"}
                      onClick={() => setSelectedId(a.id)}
                      style={{
                        width: "100%", textAlign: "left", cursor: "pointer",
                        border: `1px solid ${active ? at.border : neutral[200]}`,
                        borderRadius: radius.lg,
                        backgroundColor: active ? at.bg : "#FFFFFF",
                        boxShadow: active ? shadow.sm : "none",
                        padding: space.md, display: "flex", gap: space.md,
                        fontFamily: fontFamily.body,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 36, height: 36, flexShrink: 0, borderRadius: radius.md,
                          backgroundColor: at.bg, border: `1.5px solid ${at.border}`, color: at.color,
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          fontSize: fontSize.lg, fontWeight: 700,
                        }}
                      >
                        {a.name.charAt(0)}
                      </span>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: "flex", alignItems: "center", gap: space.xs }}>
                          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
                            {a.name}
                          </span>
                          <span
                            style={{
                              fontSize: fontSize.xs, fontWeight: 600, color: tt.color,
                              backgroundColor: tt.bg, border: `1px solid ${tt.border}`,
                              borderRadius: radius.pill, padding: "1px 7px",
                            }}
                          >
                            {tt.label}
                          </span>
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: space.xs, marginTop: 3 }}>
                          <span
                            style={{
                              fontSize: fontSize.xs, fontWeight: 600,
                              color: (roleTheme[a.roleKey] ?? roleTheme.general).color,
                              backgroundColor: (roleTheme[a.roleKey] ?? roleTheme.general).bg,
                              border: `1px solid ${(roleTheme[a.roleKey] ?? roleTheme.general).border}`,
                              borderRadius: radius.pill, padding: "1px 7px",
                            }}
                          >
                            岗位：{(roleTheme[a.roleKey] ?? roleTheme.general).label}
                          </span>
                          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                            {a.tierNote}
                          </span>
                        </span>
                        <span
                          style={{
                            display: "flex", alignItems: "center", gap: space.md,
                            marginTop: space.xs, fontSize: fontSize.xs, color: neutral[400],
                          }}
                        >
                          <span style={{ fontFamily: fontFamily.mono }}>vteam-{a.agentKey}</span>
                          <span>
                            能力 <strong style={{ color: neutral[600] }}>{a.toolCount}</strong> 项
                          </span>
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* ============ 右：详情 ============ */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
            <div
              style={{
                display: "flex", alignItems: "flex-start", gap: space.lg,
                padding: `${space.lg}px ${space.xl}px`, borderRadius: radius.lg,
                backgroundColor: "#FFFFFF", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 52, height: 52, flexShrink: 0, borderRadius: radius.lg,
                  backgroundColor: fam.bg, border: `1.5px solid ${fam.border}`, color: fam.color,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: fontSize.xxl, fontWeight: 700,
                }}
              >
                {agent.name.charAt(0)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                  <span style={{ fontSize: fontSize.xxl, fontWeight: 700, color: neutral[900] }}>
                    {agent.name}
                  </span>
                  <span
                    style={{
                      fontSize: fontSize.xs, fontWeight: 600, color: typeTheme[agent.type].color,
                      backgroundColor: typeTheme[agent.type].bg,
                      border: `1px solid ${typeTheme[agent.type].border}`,
                      borderRadius: radius.pill, padding: "2px 9px",
                    }}
                  >
                    {typeTheme[agent.type].label}
                  </span>
                  <span
                    style={{
                      fontSize: fontSize.xs, fontWeight: 500, color: neutral[500],
                      backgroundColor: neutral[100], border: `1px solid ${neutral[200]}`,
                      borderRadius: radius.pill, padding: "2px 9px",
                    }}
                  >
                    {fam.label}分组
                  </span>
                </div>
                <div style={{ fontSize: fontSize.sm, color: neutral[500], marginTop: 3, fontFamily: fontFamily.mono }}>
                  vteam-{agent.agentKey}
                </div>
                <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>{agent.tierNote}</div>
              </div>
              <div style={{ display: "flex", gap: space.sm }}>
                <Btn onClick={() => { setCloneKey(""); setCloneOpen(true); }}>⧉ 克隆</Btn>
                {agent.builtin ? (
                  <span
                    style={{
                      display: "inline-flex", alignItems: "center", fontSize: fontSize.sm,
                      color: neutral[400], padding: `${space.sm}px ${space.md}px`,
                    }}
                  >
                    ⓘ 模板不可删除
                  </span>
                ) : (
                  <Btn variant="danger" onClick={() => setDeleteOpen(true)}>删除</Btn>
                )}
              </div>
            </div>

            <Section index="①" title="身份" sub="能力档与引擎绑定 —— Agent 按能力划分，不再一个岗位一个 Agent">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: space.lg }}>
                <Field label="引擎绑定名 agentKey" value={`vteam-${agent.agentKey}`} mono
                  hint="引擎侧只认识这个名字；业务侧不再按名字做特判" />
                <Field label="Agent 类型 type" value={typeTheme[agent.type].label}
                  hint={agent.baseAgent ? `克隆来源：${agent.baseAgent}` : undefined} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: space.lg, marginTop: space.lg }}>
                <Field label="能力族（显示分组）" value={fam.label}
                  hint={`仅用于列表分组，不代表同族能力相同；本 Agent 实际写范围：${agent.tierNote}`} />
                <Field
                  label="出厂岗位"
                  value={(roleTheme[agent.roleKey] ?? roleTheme.general).label}
                  hint="本 Agent 的能力以该岗位策略为准；其它岗位若能力相同也可绑它"
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: space.lg, marginTop: space.lg }}>
                <Field label="克隆来源 baseAgentId" value={agent.baseAgent ?? "—"}
                  hint={agent.baseAgent ? "克隆体独立可写，不影响源 Agent" : "非克隆 Agent 无来源"} />
                <Field label="默认绑定岗位（TeamMember.roleId）" value={(roleTheme[agent.roleKey] ?? roleTheme.general).label}
                  hint="添加成员时按岗位预填 Agent；成员可改选能力相符的其它 Agent" />
              </div>
            </Section>

            <Section index="②" title="运行参数" sub="模型 / 执行节点 / 性格 —— 都是 Agent 自己的属性，不属于岗位">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: space.lg }}>
                <Field label="默认模型" value={agent.model} />
                <Field label="首选 Worker" value={agent.worker} hint="软绑定；离线自动回退" />
                <Field label="性格 persona" value={PERSONA_LABEL[agent.persona] ?? agent.persona} />
              </div>
            </Section>

            <Section index="③" title="操作者提示词 prompt" sub="答「我该怎么干」；与岗位职责提示词拼接，不是覆盖">
              <textarea
                data-testid="agent-prompt" rows={3} defaultValue={agent.prompt}
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.7 }}
              />
              <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: space.sm, lineHeight: 1.7 }}>
                下发顺序：平台公共块 → 身份 → <strong>【岗位职责】</strong>（来自绑定岗位的 rolePrompt）
                → <strong>【职责】</strong>（本字段）→ 边界。改动岗位提示词不影响这里。
              </div>
            </Section>

            <Section index="④" title="能力（policyId）" sub="权限与工具 —— 本次计划的核心：从只读展示改为可编辑">
              <div
                style={{
                  display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap",
                  padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md,
                  backgroundColor: "#FDF4E3", border: "1px solid #ECD9AB",
                  fontSize: fontSize.xs, color: "#8A6415", marginBottom: space.lg, lineHeight: 1.7,
                }}
              >
                <span aria-hidden>⚠</span>
                <span>
                  <strong>能力只在 Agent 上，不在岗位上。</strong>
                  岗位是「什么岗位」，能力是「能做什么」；编辑能力不影响岗位，改岗位描述也不影响能力。
                </span>
              </div>

              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[500], marginBottom: space.sm }}>
                原生权限（4 行）
              </div>
              <div
                style={{
                  display: "flex", flexDirection: "column", borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`, backgroundColor: "#FFFFFF", marginBottom: space.xl,
                }}
              >
                {NATIVE_PERMS.map((p, i) => (
                  <div
                    key={p.key} data-testid="native-perm-row" data-perm={p.key}
                    style={{
                      display: "flex", alignItems: "flex-start", justifyContent: "space-between",
                      gap: space.md, padding: `${space.md}px ${space.lg}px`,
                      borderBottom: i === NATIVE_PERMS.length - 1 ? "none" : `1px solid ${neutral[100]}`,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>{p.label}</div>
                      <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>{p.desc}</div>
                    </div>
                    <div style={{ flexShrink: 0 }}>
                      {p.kind === "glob" ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-end" }}>
                          {p.globs!.map((g) => (
                            <span
                              key={g.glob}
                              style={{
                                display: "inline-flex", alignItems: "center", gap: space.xs,
                                fontSize: fontSize.xs, fontFamily: fontFamily.mono,
                                color: g.effect === "allow" ? "#059669" : "#94A3B8",
                                backgroundColor: g.effect === "allow" ? "#ECFDF5" : "#F8FAFC",
                                border: `1px solid ${g.effect === "allow" ? "#A7F3D0" : "#E2E8F0"}`,
                                borderRadius: radius.sm, padding: "1px 6px",
                              }}
                            >
                              {g.glob}
                              <span style={{ fontWeight: 700 }}>{g.effect === "allow" ? "✓" : "✕"}</span>
                            </span>
                          ))}
                        </div>
                      ) : p.kind === "tri-state" ? (
                        <span
                          style={{
                            display: "inline-flex", alignItems: "center", gap: space.xs,
                            fontSize: fontSize.sm, fontWeight: 600,
                            color: toolEffect[p.effect!].color,
                            backgroundColor: toolEffect[p.effect!].bg,
                            border: `1px solid ${toolEffect[p.effect!].border}`,
                            borderRadius: radius.pill, padding: `${space.xs}px ${space.md}px`,
                          }}
                        >
                          {toolEffect[p.effect!].mark} {toolEffect[p.effect!].label}
                        </span>
                      ) : (
                        <span
                          style={{
                            display: "inline-flex", alignItems: "center", gap: space.xs,
                            fontSize: fontSize.xs, color: neutral[400],
                            backgroundColor: neutral[100], border: `1px solid ${neutral[200]}`,
                            borderRadius: radius.pill, padding: `${space.xs}px ${space.md}px`,
                          }}
                        >
                          🔒 只读
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[500], marginBottom: space.sm }}>
                MCP 工具权限（点击切换 允许 → 询问 → 拒绝）
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
                {TOOL_GROUPS.map((g) => (
                  <div key={g.group}>
                    <div style={{ fontSize: fontSize.xs, fontWeight: 600, color: neutral[500], marginBottom: space.xs }}>
                      {g.group}
                    </div>
                    <div
                      style={{
                        display: "flex", flexDirection: "column", borderRadius: radius.md,
                        border: `1px solid ${neutral[200]}`, backgroundColor: "#FFFFFF", overflow: "hidden",
                      }}
                    >
                      {g.tools.map((tool, i) => {
                        const eff = toolOverrides[tool] ?? "allow";
                        const t = toolEffect[eff];
                        return (
                          <div
                            key={tool} data-testid="tool-row" data-tool={tool}
                            style={{
                              display: "flex", alignItems: "center", justifyContent: "space-between",
                              gap: space.md, padding: `${space.sm}px ${space.md}px`,
                              borderBottom: i === g.tools.length - 1 ? "none" : `1px solid ${neutral[100]}`,
                            }}
                          >
                            <code style={{ fontFamily: fontFamily.mono, fontSize: fontSize.sm, color: neutral[700] }}>
                              {tool}
                            </code>
                            <button
                              type="button" onClick={() => toggleTool(tool)}
                              style={{
                                display: "inline-flex", alignItems: "center", gap: space.xs,
                                minWidth: 78, justifyContent: "center",
                                fontSize: fontSize.xs, fontWeight: 600,
                                color: t.color, backgroundColor: t.bg,
                                border: `1px solid ${t.border}`, borderRadius: radius.pill,
                                padding: `${space.xs}px ${space.sm}px`,
                                cursor: "pointer", fontFamily: fontFamily.body,
                              }}
                            >
                              {t.mark} {t.label}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: space.sm, marginTop: space.lg, alignItems: "center" }}>
                <Btn variant="primary">保存能力</Btn>
                <Btn>取消</Btn>
                <span style={{ fontSize: fontSize.xs, color: neutral[400], paddingLeft: space.sm }}>
                  ⓘ 保存后需重启 Worker 才会下发到执行端
                </span>
              </div>
            </Section>
          </div>
        </div>
      </main>

      {createOpen ? (
        <Modal
          testid="create-agent-modal"
          title="新建自定义 Agent"
          subtitle="选一个岗位即继承它的权限与工具；不选则为空骨架"
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <Btn onClick={() => setCreateOpen(false)}>取消</Btn>
              <Btn variant="primary" disabled={!cCanSubmit}>创建 Agent</Btn>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
            <div>
              <div style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs }}>
                Agent 名称 <span style={{ color: "#DC2626" }}>*</span>
              </div>
              <input
                data-testid="create-agent-name" type="text"
                placeholder="请输入自定义角色名（如 发布管家）"
                value={cName} onChange={(e) => setCName(e.target.value)} style={inputStyle}
              />
            </div>
            <div>
              <div style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs }}>
                标识 agentKey <span style={{ color: "#DC2626" }}>*</span>
              </div>
              <input
                data-testid="create-agent-key" type="text"
                placeholder="小写字母开头，如 release-manager"
                value={cKey} onChange={(e) => setCKey(e.target.value)} onBlur={() => setCTouched(true)}
                style={{
                  ...inputStyle, fontFamily: fontFamily.mono,
                  borderColor: cTouched && cKeyError ? "#DC2626" : neutral[200],
                }}
              />
              <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: space.xs }}>
                执行体名为 vteam-{"<标识>"}；小写字母开头，仅含小写字母/数字/_/-，最多 63 字符
              </div>
              {cTouched && cKeyError ? (
                <div data-testid="create-agent-key-error" style={{ fontSize: fontSize.xs, color: "#DC2626", marginTop: 2 }}>
                  {cKeyError}
                </div>
              ) : null}
            </div>

            <div>
              <div
                style={{
                  display: "flex", alignItems: "center", gap: space.sm,
                  fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs,
                }}
              >
                岗位（继承其策略）
                <span
                  style={{
                    fontSize: 10, fontWeight: 700, color: "#7C3AED",
                    backgroundColor: "#F5F3FF", border: "1px solid #DDD6FE",
                    borderRadius: radius.pill, padding: "1px 7px",
                  }}
                >
                  本次新增
                </span>
              </div>
              <div data-testid="create-agent-role-picker" style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                {TIER_CHOICES.map((r) => {
                  const active = cRole === r.key;
                  const rtt = r.key ? roleTheme[r.key] : null;
                  return (
                    <button
                      key={r.key ?? "none"} type="button"
                      data-testid="role-option" data-role={r.key ?? "none"} data-active={active ? "true" : "false"}
                      onClick={() => setCRole(r.key)}
                      style={{
                        display: "flex", alignItems: "flex-start", gap: space.sm,
                        padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md,
                        border: `1px solid ${active ? (rtt ? rtt.border : "#C7D2FE") : neutral[200]}`,
                        backgroundColor: active ? (rtt ? rtt.bg : "#EEF2FF") : "#FFFFFF",
                        cursor: "pointer", textAlign: "left", fontFamily: fontFamily.body,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 15, height: 15, marginTop: 3, flexShrink: 0, borderRadius: "50%",
                          border: `1.5px solid ${active ? (rtt ? rtt.color : "#4F46E5") : neutral[300]}`,
                          backgroundColor: active ? (rtt ? rtt.color : "#4F46E5") : "transparent",
                        }}
                      />
                      <span style={{ minWidth: 0 }}>
                        <span
                          style={{
                            display: "block", fontSize: fontSize.md, fontWeight: 600,
                            color: rtt ? rtt.color : neutral[700],
                          }}
                        >
                          {r.label}
                        </span>
                        <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>
                          {r.note}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: space.sm, lineHeight: 1.6 }}>
                说明：新建 Agent 的机制是<b>继承所选岗位的策略</b>（<code>ep_&lt;role&gt;</code>）。
                刻意不提供「计划员」：其策略含子任务调度权限，会被执行引擎按名字遮蔽，提供它会误导。
              </div>
            </div>

            <div>
              <div style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs }}>
                操作者提示词（可选）
              </div>
              <textarea
                data-testid="create-agent-prompt" rows={3}
                placeholder="描述该 Agent 怎么干活（可选，创建后可在本页编辑）"
                value={cPrompt} onChange={(e) => setCPrompt(e.target.value)}
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }}
              />
            </div>

            <div
              style={{
                padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md,
                backgroundColor: "#EFF6FF", border: "1px solid #BFDBFE",
                fontSize: fontSize.sm, color: "#1D4ED8", lineHeight: 1.7,
              }}
            >
              <strong>将继承的能力：</strong>
              {cRole === null
                ? "空骨架 —— 仅基础读权限，工具集为空（这是「不指定」的设计行为）"
                : `「${TIER_CHOICES.find((r) => r.key === cRole)?.label}」的既有能力 —— ${TIER_CHOICES.find((r) => r.key === cRole)?.note}`}
            </div>
          </div>
        </Modal>
      ) : null}

      {cloneOpen ? (
        <Modal
          testid="clone-agent-modal"
          title="克隆 Agent"
          subtitle={`以「${agent.name}」为模板创建副本，能力与提示词一并继承`}
          onClose={() => setCloneOpen(false)}
          footer={
            <>
              <Btn onClick={() => setCloneOpen(false)}>取消</Btn>
              <Btn variant="primary" disabled={!cloneCanSubmit}>克隆 Agent</Btn>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
            <div>
              <div style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs }}>
                副本名称
              </div>
              <input type="text" defaultValue={`${agent.name} 副本`} style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs }}>
                标识 agentKey <span style={{ color: "#DC2626" }}>*</span>
              </div>
              <input
                type="text" placeholder="小写字母开头，如 release-manager-2"
                value={cloneKey} onChange={(e) => setCloneKey(e.target.value)}
                style={{
                  ...inputStyle, fontFamily: fontFamily.mono,
                  borderColor: cloneKey && cloneKeyError ? "#DC2626" : neutral[200],
                }}
              />
              {cloneKey && cloneKeyError ? (
                <div style={{ fontSize: fontSize.xs, color: "#DC2626", marginTop: 2 }}>{cloneKeyError}</div>
              ) : null}
            </div>
            <div
              style={{
                padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md,
                backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`,
                fontSize: fontSize.sm, color: neutral[500],
              }}
            >
              克隆体是独立可写副本：可继续修改提示词与能力，不影响源 Agent。
            </div>
          </div>
        </Modal>
      ) : null}

      {deleteOpen ? (
        <Modal
          testid="delete-agent-modal"
          title="删除 Agent"
          onClose={() => setDeleteOpen(false)}
          footer={
            <>
              <Btn onClick={() => setDeleteOpen(false)}>取消</Btn>
              <Btn variant="danger">确认删除</Btn>
            </>
          }
        >
          <div style={{ fontSize: fontSize.md, color: neutral[700], lineHeight: 1.8 }}>
            确认删除「<strong>{agent.name}</strong>」（
            <code style={{ fontFamily: fontFamily.mono }}>vteam-{agent.agentKey}</code>）？
            <br />
            该操作不可撤销。若该 Agent 正被团队成员使用，请先解除绑定。
          </div>
        </Modal>
      ) : null}

      <NavDock activeKey="agents" projectName="Agent 协作平台" />
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "agent-manage",
    name: "Agent 管理",
    group: "平台",
    description:
      "Agent 可执行单元：列表 + 详情（身份/运行参数/操作者提示词/能力 policyId 可编辑）；新建含能力档选择器；与「岗位管理」是两个不同实体",
    device: "desktop",
  },
  Component: AgentManagePage,
};

export default def;
