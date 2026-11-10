/**
 * 原型：新建群聊（group-create）· 从成员库选成员
 * ============================================================
 * 背景：成员从群聊解耦后，「建群」不再是「新建团队 + 创建成员」，而是
 * **从平台成员库勾选成员**成立一个群聊；同一成员可同时存在于多个群聊，
 * 因此选中成员时要显式提示「他已在哪些群聊里」。
 *
 * 三步式流程（单页 + 步骤条，可点击回退）：
 * ① 选成员 —— 成员库网格多选 + 搜索/角色筛选；右侧实时汇总「已选数量 / 角色分布 /
 *    主 Agent 指定」；成员选择区提供**双入口**：「从成员库选择」（当前网格）与「＋ 新建成员」
 *    （弹窗当场新建）。新建的成员会保存到成员库（平台级资产），可继续在成员库编辑/加入其他群。
 * ② 群设置 —— 群名 / 描述 / 群标识 / 只读的「全局会话」说明；已选成员可移除。
 * ③ 确认创建 —— 汇总群名、成员、主 Agent、全局会话；提示跨群成员；创建后成功态。
 *
 * 关键设计意图：
 * - 主 Agent 必须是「已选成员之一」（群内调度者），从已选列表里单选指定，默认第一位。
 * - 跨群提示：选中卡片直接展示「已在 N 个群聊」；确认页再次汇总，避免用户误以为「转移」。
 * - 全局会话（新版设计 §3.5）：**一个成员全局只有一个 session**，配置共享、会话跨群共享，
 *   不做按群隔离。因此建群不提供「复用会话」开关（按群复用/隔离已无意义），改为只读提示
 *   「成员使用其全局会话；本群任务会共享该成员已有上下文（不再按群隔离）」。
 * - 「推荐主 Agent」只是成员库里的推荐位（平台属性），真正的**主 Agent 席位在建群时从已选
 *   成员中指定（设计 D6），仅对本群生效**，不写回成员本身。
 *
 * 可交互：步骤前进/回退、成员多选、角色筛选/搜索、主 Agent 指定、移除成员、
 * 双入口（从成员库选择 / 当场新建成员）、创建成功态与「再建一个」重置。
 * 复用 ../_shared 的 AgentAvatar / AgentBadge 与 styles token。
 *
 * ⚠️ 铁律：root height:100% + position:relative，浮层（快速建成员 / 提示）一律 absolute，
 * 零 fixed / 100vh / 100vw（md-docs DeviceFrame 内会溢出）。
 */
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef, PrototypeRenderProps } from "@md-docs/prototypes/types";
import { AgentAvatar, AgentBadge } from "../_shared/components";
import { NavDock, NavTopBar, CmdKPanel } from "../_shared/nav";
import {
  type RoleKey,
  roles,
  roleText,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

/* ============================================================================
 * 一、mock 数据：平台成员库（与 member-manage 原型共享同一份语义）
 * ==========================================================================*/

interface LibMember {
  id: string;
  name: string;
  role: RoleKey;
  agentKey: string;
  model: string;
  /** 团队（席位）工作目录：可选、可切换（需授权）；默认在私有目录执行 */
  teamDir: string;
  /** 成员私有工作目录：默认工作目录（会话默认 cwd），个人工作台 */
  privateDir: string;
  /** ★ 解耦关键：成员已加入的群聊（可多个） */
  groups: string[];
  mainCandidate: boolean;
  online: boolean;
}

const LIB_MEMBERS: LibMember[] = [
  {
    id: "m-lin",
    name: "林知远",
    role: "product",
    agentKey: "vteam-product",
    model: "claude-sonnet-4.5",
    teamDir: "/data/vteam-worker/notify-center",
    privateDir: "~/work/linzhiyuan",
    groups: ["通知中心迭代", "增长实验 · 埋点"],
    mainCandidate: true,
    online: true,
  },
  {
    id: "m-chen",
    name: "陈默",
    role: "architect",
    agentKey: "vteam-architect",
    model: "deepseek-v3.2",
    teamDir: "/data/vteam-worker/arch",
    privateDir: "~/work/chenmo",
    groups: ["通知中心迭代", "客户端重构二期"],
    mainCandidate: true,
    online: true,
  },
  {
    id: "m-zhou",
    name: "周野",
    role: "developer",
    agentKey: "vteam-developer",
    model: "claude-sonnet-4.5",
    teamDir: "/data/vteam-worker/vteam-web",
    privateDir: "~/work/zhouye",
    groups: ["通知中心迭代", "增长实验 · 埋点", "客户端重构二期"],
    mainCandidate: false,
    online: true,
  },
  {
    id: "m-su",
    name: "苏打",
    role: "tester",
    agentKey: "vteam-tester",
    model: "gpt-5.2",
    teamDir: "/data/vteam-worker/qa",
    privateDir: "~/work/suda",
    groups: ["通知中心迭代"],
    mainCandidate: false,
    online: false,
  },
  {
    id: "m-jiang",
    name: "江禾",
    role: "product",
    agentKey: "vteam-product",
    model: "qwen3-max",
    teamDir: "/data/vteam-worker/growth",
    privateDir: "~/work/jianghe",
    groups: [],
    mainCandidate: false,
    online: false,
  },
  {
    id: "m-lu",
    name: "陆川",
    role: "developer",
    agentKey: "vteam-developer",
    model: "deepseek-v3.2",
    teamDir: "/data/vteam-worker/vteam-server",
    privateDir: "~/work/luchuan",
    groups: ["客户端重构二期"],
    mainCandidate: false,
    online: true,
  },
  {
    id: "m-he",
    name: "何星",
    role: "architect",
    agentKey: "vteam-architect",
    model: "claude-sonnet-4.5",
    teamDir: "/data/vteam-worker/design-system",
    privateDir: "~/work/hexing",
    groups: [],
    mainCandidate: false,
    online: false,
  },
  {
    id: "m-tong",
    name: "童童",
    role: "tester",
    agentKey: "vteam-tester",
    model: "qwen3-max",
    teamDir: "/data/vteam-worker/qa",
    privateDir: "~/work/tongtong",
    groups: ["增长实验 · 埋点"],
    mainCandidate: false,
    online: true,
  },
];

/** 群标识可选渐变色（与左栏群头像一致的设计语言） */
const GROUP_THEMES = [
  { key: "blue", from: "#3B82F6", to: "#8B5CF6", label: "蓝紫" },
  { key: "green", from: "#10B981", to: "#0EA5E9", label: "青绿" },
  { key: "orange", from: "#F59E0B", to: "#EF4444", label: "橙红" },
  { key: "violet", from: "#8B5CF6", to: "#EC4899", label: "紫玫" },
];

/* ============================================================================
 * 二、布局常量 / scoped 样式
 * ==========================================================================*/

const baseFont: CSSProperties = { fontFamily: fontFamily.body };
const RAIL_W = 56;

const gcCss = `
@keyframes gc-pop { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
@keyframes gc-check { from { transform: scale(.6); opacity: 0 } to { transform: scale(1); opacity: 1 } }
@keyframes gc-pulse { 0%,100% { opacity:.35 } 50% { opacity:1 } }
`;

/** 步骤定义 */
const STEPS = [
  { title: "选择成员", hint: "从成员库勾选" },
  { title: "群设置", hint: "群名 / 全局会话" },
  { title: "确认创建", hint: "核对后创建" },
] as const;

const inputStyle: CSSProperties = {
  width: "100%",
  height: 34,
  padding: `0 ${space.sm + 2}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "#FFFFFF",
  color: neutral[800],
  fontSize: fontSize.sm,
  outline: "none",
  boxSizing: "border-box",
  ...baseFont,
};

/* ============================================================================
 * 三、主组件
 * ==========================================================================*/

function GroupCreate(_: PrototypeRenderProps) {
  const [step, setStep] = useState(0);
  const [library, setLibrary] = useState<LibMember[]>(LIB_MEMBERS);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mainAgentId, setMainAgentId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleKey | "all">("all");

  // 群设置
  const [groupName, setGroupName] = useState("");
  const [groupDesc, setGroupDesc] = useState("");
  const [themeKey, setThemeKey] = useState(GROUP_THEMES[0].key);

  // 成功态 / 浮层 / 提示
  const [created, setCreated] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  /** 本次建群过程中新建的成员 id（成员卡显示「新建」徽章） */
  const [newlyCreated, setNewlyCreated] = useState<string[]>([]);
  const [quickName, setQuickName] = useState("");
  const [quickRole, setQuickRole] = useState<RoleKey>("developer");
  const [toast, setToast] = useState("");
  const [cmdkOpen, setCmdkOpen] = useState(false);

  const selectedMembers = useMemo(
    () => library.filter((m) => selectedIds.includes(m.id)),
    [library, selectedIds],
  );
  const mainAgent = selectedMembers.find((m) => m.id === mainAgentId) ?? selectedMembers[0] ?? null;
  const effectiveMainId = mainAgent?.id ?? null;

  const filtered = useMemo(
    () =>
      library.filter((m) => {
        if (roleFilter !== "all" && m.role !== roleFilter) return false;
        if (!query.trim()) return true;
        const q = query.trim();
        return m.name.includes(q) || m.agentKey.includes(q) || m.groups.some((g) => g.includes(q));
      }),
    [library, query, roleFilter],
  );

  /** 角色分布（已选成员的岗位构成） */
  const roleDist = useMemo(() => {
    const map: Partial<Record<RoleKey, number>> = {};
    selectedMembers.forEach((m) => (map[m.role] = (map[m.role] ?? 0) + 1));
    return (Object.keys(roles) as RoleKey[]).filter((r) => (map[r] ?? 0) > 0).map((r) => ({ role: r, count: map[r] ?? 0 }));
  }, [selectedMembers]);

  /** 已选成员中「已在其他群聊」的人数（解耦后重点提示） */
  const crossGroupCount = selectedMembers.filter((m) => m.groups.length > 0).length;

  const theme = GROUP_THEMES.find((t) => t.key === themeKey) ?? GROUP_THEMES[0];

  const canNext = step === 0 ? selectedIds.length >= 2 : step === 1 ? groupName.trim().length > 0 : true;

  const toggleMember = (id: string) => {
    setSelectedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      // 主 Agent 跟随：被移除的主 Agent 自动回退到剩余第一位
      if (mainAgentId === id && prev.includes(id)) {
        setMainAgentId(next[0] ?? null);
      }
      return next;
    });
  };

  const goStep = (target: number) => {
    // 只能回退，或在前置步骤合法时前进（避免跳过未校验的步骤）
    if (target < step) {
      setStep(target);
      return;
    }
    if (target === step + 1 && canNext) {
      setStep(target);
      return;
    }
    if (target > step + 1) {
      setToast("请先完成当前步骤（成员至少 2 位、群名必填）");
    }
  };

  const createGroup = () => {
    if (selectedIds.length < 2 || !groupName.trim()) {
      setToast("创建失败：至少 2 位成员且群名不能为空");
      return;
    }
    setCreated(true);
  };

  const resetAll = () => {
    setCreated(false);
    setStep(0);
    setSelectedIds([]);
    setMainAgentId(null);
    setGroupName("");
    setGroupDesc("");
    setThemeKey(GROUP_THEMES[0].key);
    setQuery("");
    setRoleFilter("all");
    setToast("");
  };

  /** 快速新建成员：写入成员库并自动勾选（体现「先建成员，再建群」） */
  const quickCreate = () => {
    if (!quickName.trim()) return;
    const member: LibMember = {
      id: `m-${library.length + 1}-${Date.now().toString().slice(-4)}`,
      name: quickName.trim(),
      role: quickRole,
      agentKey: `vteam-${quickRole}`,
      model: quickRole === "tester" ? "qwen3-max" : "claude-sonnet-4.5",
      teamDir: "/data/vteam-worker/<team>",
      privateDir: `~/work/${quickName.trim()}`,
      groups: [],
      mainCandidate: false,
      online: false,
    };
    setLibrary((prev) => [member, ...prev]);
    setSelectedIds((prev) => (prev.includes(member.id) ? prev : [...prev, member.id]));
    // 记录「本次新建」，成员卡显示「新建」徽章；后续可在成员库继续管理
    setNewlyCreated((prev) => [...prev, member.id]);
    setQuickName("");
    setQuickCreateOpen(false);
    setToast(`已创建「${member.name}」并加入本群；同时已保存到成员库，可继续在成员库编辑/加入其他群`);
  };

  /* ------------------------------ 成功态 ------------------------------ */
  if (created) {
    return (
      <div
        data-testid="group-create-root"
        style={{ height: "100%", minHeight: 720, position: "relative", backgroundColor: neutral[50], ...baseFont }}
      >
        <style>{gcCss}</style>
        <NavTopBar breadcrumb={["Agent 协作平台", "新建群聊"]} onCmdKClick={() => setCmdkOpen(true)} />
        <div
          style={{
            position: "absolute",
            top: 60,
            left: 0,
            right: 0,
            bottom: 0,
            paddingLeft: RAIL_W + 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            data-testid="create-success"
            style={{
              width: 560,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
              borderRadius: radius.lg,
              boxShadow: shadow.md,
              padding: space.xxl,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: space.md,
              animation: "gc-pop .2s ease-out",
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                backgroundColor: "#ECFDF5",
                border: "1px solid #A7F3D0",
                color: "#059669",
                fontSize: 26,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                animation: "gc-check .2s ease-out",
              }}
            >
              ✓
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
                群聊「{groupName.trim()}」已创建
              </div>
              <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs, lineHeight: 1.6 }}>
                {selectedMembers.length} 位成员已加入，主 Agent 为 {mainAgent?.name ?? "未指定"}；本群任务共享成员的全局会话上下文（跨群统一，不再按群隔离）
              </div>
            </div>

            {/* 跨群提示：解耦后最容易误解的点 */}
            {crossGroupCount > 0 && (
              <div
                style={{
                  width: "100%",
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: radius.md,
                  backgroundColor: "#FFFBEB",
                  border: "1px solid #FDE68A",
                  color: "#B45309",
                  fontSize: fontSize.xs,
                  lineHeight: 1.6,
                }}
              >
                其中 {crossGroupCount} 位成员此前已在其他群聊中，他们现在同时存在于多个群聊（不会从原群聊移除）。
              </div>
            )}

            <div style={{ display: "flex", gap: space.sm, marginTop: space.sm }}>
              <button
                type="button"
                data-testid="success-reset"
                onClick={resetAll}
                style={{
                  padding: `${space.xs + 2}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "#FFFFFF",
                  color: neutral[600],
                  fontSize: fontSize.sm,
                  cursor: "pointer",
                  ...baseFont,
                }}
              >
                再建一个
              </button>
              <button
                type="button"
                data-testid="success-enter"
                onClick={() => setToast("进入群聊会话：跳转微信式会话页（wechat-chat 原型）")}
                style={{
                  padding: `${space.xs + 2}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  fontSize: fontSize.sm,
                  fontWeight: 500,
                  cursor: "pointer",
                  ...baseFont,
                }}
              >
                进入群聊 →
              </button>
            </div>
          </div>
        </div>

        <NavDock activeKey="messages" projectName="Agent 协作平台" />

        {toast && <Toast text={toast} onClose={() => setToast("")} />}
        <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
      </div>
    );
  }

  /* ------------------------------ 主流程 ------------------------------ */
  return (
    <div
      data-testid="group-create-root"
      style={{ height: "100%", minHeight: 720, position: "relative", backgroundColor: neutral[50], ...baseFont }}
    >
      <style>{gcCss}</style>

      <NavTopBar breadcrumb={["Agent 协作平台", "新建群聊"]} onCmdKClick={() => setCmdkOpen(true)} />

      <div
        style={{
          position: "absolute",
          top: 60,
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          flexDirection: "column",
          padding: `${space.lg}px ${space.lg}px ${space.lg}px ${RAIL_W + 24}px`,
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            backgroundColor: "#FFFFFF",
            border: `1px solid ${neutral[200]}`,
            borderRadius: radius.lg,
            boxShadow: shadow.sm,
            overflow: "hidden",
          }}
        >
          {/* 卡片头：标题 + 步骤条 */}
          <div
            style={{
              flexShrink: 0,
              padding: `${space.md}px ${space.xl}px`,
              borderBottom: `1px solid ${neutral[200]}`,
              display: "flex",
              alignItems: "center",
              gap: space.xl,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
                新建群聊
              </div>
              <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>
                从成员库勾选成员组建群聊；成员属于平台，可同时加入多个群聊
              </div>
            </div>

            {/* 步骤条 */}
            <div
              data-testid="stepper"
              style={{ display: "flex", alignItems: "center", gap: space.sm, marginLeft: "auto" }}
            >
              {STEPS.map((s, i) => {
                const active = i === step;
                const done = i < step;
                return (
                  <div key={s.title} style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                    {i > 0 && (
                      <span
                        aria-hidden
                        style={{
                          width: 28,
                          height: 1,
                          backgroundColor: done || active ? "#93C5FD" : neutral[200],
                        }}
                      />
                    )}
                    <button
                      type="button"
                      data-testid="step-item"
                      data-index={i}
                      data-active={active ? "true" : "false"}
                      onClick={() => goStep(i)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: space.xs,
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        cursor: "pointer",
                        ...baseFont,
                      }}
                    >
                      <span
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: "50%",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 11,
                          fontWeight: 600,
                          backgroundColor: done ? "#059669" : active ? "#2563EB" : neutral[100],
                          color: done || active ? "#FFFFFF" : neutral[400],
                          border: `1px solid ${done ? "#059669" : active ? "#2563EB" : neutral[200]}`,
                        }}
                      >
                        {done ? "✓" : i + 1}
                      </span>
                      <span
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-start",
                          lineHeight: 1.25,
                        }}
                      >
                        <span
                          style={{
                            fontSize: fontSize.xs,
                            fontWeight: active ? 600 : 500,
                            color: active ? neutral[900] : done ? neutral[600] : neutral[400],
                          }}
                        >
                          {s.title}
                        </span>
                        <span style={{ fontSize: 10, color: neutral[400] }}>{s.hint}</span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 步骤内容区 */}
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            {/* ---------------- 步骤 ① 选成员 ---------------- */}
            {step === 0 && (
              <>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    padding: space.lg,
                    gap: space.md,
                  }}
                >
                  {/* 成员来源双入口：从成员库勾选 / 当场新建（新建会保存到成员库） */}
                  <div
                    data-testid="member-entry-row"
                    style={{ display: "flex", alignItems: "center", gap: space.sm, flexShrink: 0, flexWrap: "wrap" }}
                  >
                    <span
                      data-testid="entry-library"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: space.xs,
                        padding: `${space.xs}px ${space.sm + 2}px`,
                        borderRadius: radius.md,
                        border: "1px solid #BFDBFE",
                        backgroundColor: "#EFF6FF",
                        color: "#2563EB",
                        fontSize: fontSize.xs,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span aria-hidden>▤</span> 从成员库选择
                    </span>
                    <button
                      type="button"
                      data-testid="quick-create-member"
                      onClick={() => setQuickCreateOpen(true)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: space.xs,
                        padding: `${space.xs}px ${space.md}px`,
                        borderRadius: radius.md,
                        border: "none",
                        backgroundColor: "#2563EB",
                        color: "#FFFFFF",
                        fontSize: fontSize.xs,
                        fontWeight: 600,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        boxShadow: shadow.sm,
                        ...baseFont,
                      }}
                    >
                      <span aria-hidden>＋</span> 新建成员
                    </button>
                    <span style={{ fontSize: 10, color: neutral[400], lineHeight: 1.5 }}>
                      也可以从下方成员库勾选已有成员；新建的成员会保存到成员库，后续可统一管理
                    </span>
                  </div>

                  {/* 工具条：搜索 + 角色筛选 */}
                  <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexShrink: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: space.sm,
                        height: 32,
                        width: 260,
                        padding: `0 ${space.sm + 2}px`,
                        borderRadius: radius.md,
                        backgroundColor: neutral[50],
                        border: `1px solid ${neutral[200]}`,
                      }}
                    >
                      <span aria-hidden style={{ color: neutral[400], fontSize: fontSize.md, lineHeight: 1 }}>
                        ⌕
                      </span>
                      <input
                        data-testid="lib-search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="搜索成员 / Agent / 群聊"
                        aria-label="搜索成员"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          height: "100%",
                          border: "none",
                          outline: "none",
                          background: "transparent",
                          color: neutral[700],
                          fontSize: fontSize.sm,
                          ...baseFont,
                        }}
                      />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: space.xs }}>
                      {(["all", "product", "architect", "developer", "tester"] as const).map((r) => {
                        const on = roleFilter === r;
                        const label = r === "all" ? "全部" : roles[r].label;
                        return (
                          <button
                            key={r}
                            type="button"
                            data-testid="lib-role-filter"
                            data-active={on ? "true" : "false"}
                            onClick={() => setRoleFilter(r)}
                            style={{
                              padding: `${space.xs}px ${space.sm}px`,
                              borderRadius: radius.pill,
                              border: `1px solid ${on ? (r === "all" ? "#BFDBFE" : roles[r].border) : neutral[200]}`,
                              backgroundColor: on ? (r === "all" ? "#EFF6FF" : roles[r].bg) : "#FFFFFF",
                              color: on ? (r === "all" ? "#2563EB" : roleText[r]) : neutral[500],
                              fontSize: fontSize.xs,
                              fontWeight: on ? 600 : 500,
                              cursor: "pointer",
                              ...baseFont,
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 成员网格 */}
                  <div
                    data-testid="lib-grid"
                    style={{
                      flex: 1,
                      minHeight: 0,
                      overflowY: "auto",
                      display: "grid",
                      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                      gap: space.sm,
                      alignContent: "start",
                    }}
                  >
                    {filtered.map((m) => {
                      const on = selectedIds.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          data-testid="lib-member-card"
                          data-id={m.id}
                          data-selected={on ? "true" : "false"}
                          title={`默认工作目录（私有）：${m.privateDir} ｜ 团队目录（可切换 · 需授权）：${m.teamDir}`}
                          onClick={() => toggleMember(m.id)}
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: space.sm,
                            padding: space.sm,
                            borderRadius: radius.md,
                            border: `1px solid ${on ? "#93C5FD" : neutral[200]}`,
                            backgroundColor: on ? "#EFF6FF" : "#FFFFFF",
                            cursor: "pointer",
                            textAlign: "left",
                            boxShadow: on ? "inset 0 0 0 1px #93C5FD" : "none",
                            ...baseFont,
                          }}
                        >
                          <AgentAvatar role={m.role} size="md" initials={m.name.slice(0, 1)} />
                          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                            <span style={{ display: "flex", alignItems: "center", gap: space.xs }}>
                              <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>
                                {m.name}
                              </span>
                              {m.mainCandidate && (
                                <span
                                  title="仅表示推荐位：主 Agent 在建群时从已选成员中指定，仅对本群生效"
                                  style={{
                                    padding: "0 4px",
                                    height: 14,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    borderRadius: 3,
                                    backgroundColor: "#FFFBEB",
                                    border: "1px solid #FDE68A",
                                    color: "#B45309",
                                    fontSize: 9,
                                    fontWeight: 600,
                                    whiteSpace: "nowrap",
                                    flexShrink: 0,
                                  }}
                                >
                                  推荐主 Agent
                                </span>
                              )}
                              {newlyCreated.includes(m.id) && (
                                <span
                                  data-testid="new-member-badge"
                                  title="本次新建：已同时保存到成员库，可继续在成员库编辑/加入其他群"
                                  style={{
                                    padding: "0 4px",
                                    height: 14,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    borderRadius: 3,
                                    backgroundColor: "#ECFDF5",
                                    border: "1px solid #A7F3D0",
                                    color: "#059669",
                                    fontSize: 9,
                                    fontWeight: 600,
                                    whiteSpace: "nowrap",
                                    flexShrink: 0,
                                  }}
                                >
                                  新建
                                </span>
                              )}
                            </span>
                            <span style={{ display: "flex", alignItems: "center", gap: space.xs }}>
                              <AgentBadge role={m.role} style={{ fontSize: 10, padding: "0 5px" }} />
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 2,
                                  fontSize: 10,
                                  color: neutral[400],
                                }}
                              >
                                <span
                                  aria-hidden
                                  style={{
                                    width: 5,
                                    height: 5,
                                    borderRadius: "50%",
                                    backgroundColor: m.online ? "#10B981" : neutral[300],
                                  }}
                                />
                                {m.online ? "在线" : "空闲"}
                              </span>
                            </span>
                            <span
                              style={{
                                fontSize: 10,
                                fontFamily: fontFamily.mono,
                                color: neutral[400],
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {m.agentKey}
                            </span>
                            {/* 跨群提示：解耦后必须显式告知 */}
                            <span
                              data-testid="lib-member-groups"
                              style={{
                                fontSize: 10,
                                color: m.groups.length > 0 ? "#2563EB" : neutral[400],
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {m.groups.length > 0
                                ? `已在 ${m.groups.length} 个群聊 · ${m.groups[0]}`
                                : "未加入任何群聊"}
                            </span>
                          </span>
                          {/* 勾选指示 */}
                          <span
                            aria-hidden
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: 4,
                              border: `1.5px solid ${on ? "#2563EB" : neutral[300]}`,
                              backgroundColor: on ? "#2563EB" : "#FFFFFF",
                              color: "#FFFFFF",
                              fontSize: 10,
                              lineHeight: "13px",
                              textAlign: "center",
                              flexShrink: 0,
                            }}
                          >
                            {on ? "✓" : ""}
                          </span>
                        </button>
                      );
                    })}
                    {filtered.length === 0 && (
                      <div
                        style={{
                          gridColumn: "1 / -1",
                          padding: space.xxl,
                          textAlign: "center",
                          color: neutral[400],
                          fontSize: fontSize.sm,
                        }}
                      >
                        成员库中没有匹配成员，可「快速新建成员」
                      </div>
                    )}
                  </div>
                </div>

                {/* 右侧汇总栏：已选数量 / 角色分布 / 主 Agent 指定 */}
                <aside
                  data-testid="selection-panel"
                  style={{
                    width: 320,
                    flexShrink: 0,
                    borderLeft: `1px solid ${neutral[200]}`,
                    backgroundColor: neutral[50],
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                  }}
                >
                  <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: space.lg, display: "flex", flexDirection: "column", gap: space.lg }}>
                    {/* 已选数量 */}
                    <div
                      style={{
                        backgroundColor: "#FFFFFF",
                        border: `1px solid ${neutral[200]}`,
                        borderRadius: radius.md,
                        padding: space.md,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "baseline", gap: space.sm }}>
                        <span style={{ fontSize: fontSize.xxl, fontWeight: 600, color: neutral[900], lineHeight: 1.1 }}>
                          {selectedIds.length}
                        </span>
                        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                          位成员已选 · 至少 2 位
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedIds([]);
                            setMainAgentId(null);
                          }}
                          style={{
                            marginLeft: "auto",
                            border: "none",
                            background: "transparent",
                            color: neutral[400],
                            fontSize: 10,
                            cursor: "pointer",
                            textDecoration: "underline",
                            ...baseFont,
                          }}
                        >
                          清空
                        </button>
                      </div>
                      {/* 角色分布 */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: space.xs, marginTop: space.sm }}>
                        {roleDist.length === 0 ? (
                          <span style={{ fontSize: 10, color: neutral[400] }}>选择成员后显示角色分布</span>
                        ) : (
                          roleDist.map((d) => (
                            <span
                              key={d.role}
                              data-testid="role-dist"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 3,
                                padding: "1px 6px",
                                borderRadius: radius.pill,
                                backgroundColor: roles[d.role].bg,
                                border: `1px solid ${roles[d.role].border}`,
                                color: roleText[d.role],
                                fontSize: 10,
                                fontWeight: 500,
                              }}
                            >
                              {roles[d.role].label}
                              <strong>{d.count}</strong>
                            </span>
                          ))
                        )}
                      </div>
                    </div>

                    {/* 主 Agent 指定 */}
                    <div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: space.xs, marginBottom: space.xs }}>
                        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>主 Agent</span>
                        <span style={{ fontSize: 10, color: neutral[400] }}>
                          席位级 · 建群时从已选成员指定，仅对本群生效
                        </span>
                      </div>
                      {selectedMembers.length === 0 ? (
                        <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.6 }}>
                          先勾选成员，再从已选成员中指定主 Agent。
                        </div>
                      ) : (
                        <div data-testid="main-agent-list" style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                          {selectedMembers.map((m) => {
                            const on = effectiveMainId === m.id;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                data-testid="main-agent-option"
                                data-id={m.id}
                                data-active={on ? "true" : "false"}
                                onClick={() => setMainAgentId(m.id)}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: space.sm,
                                  padding: `${space.xs + 1}px ${space.sm}px`,
                                  borderRadius: radius.md,
                                  border: `1px solid ${on ? "#FDE68A" : neutral[200]}`,
                                  backgroundColor: on ? "#FFFBEB" : "#FFFFFF",
                                  cursor: "pointer",
                                  textAlign: "left",
                                  ...baseFont,
                                }}
                              >
                                <AgentAvatar role={m.role} size="sm" initials={m.name.slice(0, 1)} dot={false} />
                                <span style={{ flex: 1, minWidth: 0 }}>
                                  <span style={{ display: "block", fontSize: fontSize.sm, color: neutral[800], fontWeight: 500 }}>
                                    {m.name}
                                  </span>
                                  <span style={{ display: "block", fontSize: 10, color: neutral[400] }}>
                                    {roles[m.role].label} · {m.groups.length > 0 ? `已在 ${m.groups.length} 个群聊` : "未入群"}
                                  </span>
                                </span>
                                <span
                                  aria-hidden
                                  style={{
                                    width: 14,
                                    height: 14,
                                    borderRadius: "50%",
                                    border: `1.5px solid ${on ? "#F59E0B" : neutral[300]}`,
                                    backgroundColor: on ? "#F59E0B" : "#FFFFFF",
                                    flexShrink: 0,
                                  }}
                                />
                              </button>
                            );
                          })}
                          <div style={{ fontSize: 10, color: neutral[400], lineHeight: 1.6 }}>
                            默认选中第一位已选成员；主 Agent 是本群席位（负责 @ 分发与产出汇总），不写回成员库。
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 跨群提示 */}
                    <div
                      style={{
                        padding: space.md,
                        borderRadius: radius.md,
                        backgroundColor: crossGroupCount > 0 ? "#EFF6FF" : neutral[50],
                        border: `1px ${crossGroupCount > 0 ? "solid #BFDBFE" : "dashed " + neutral[300]}`,
                        fontSize: fontSize.xs,
                        color: crossGroupCount > 0 ? "#2563EB" : neutral[500],
                        lineHeight: 1.6,
                      }}
                    >
                      {crossGroupCount > 0 ? (
                        <>
                          已选成员中有 <strong>{crossGroupCount}</strong> 位已在其他群聊；创建后他们将
                          <strong>同时存在于多个群聊</strong>，不会从原群聊移除。
                        </>
                      ) : (
                        <>成员可先创建、后入群；加入新群聊不会影响其已有群聊。</>
                      )}
                    </div>
                  </div>
                </aside>
              </>
            )}

            {/* ---------------- 步骤 ② 群设置 ---------------- */}
            {step === 1 && (
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: space.xl }}>
                <div
                  style={{
                    maxWidth: 680,
                    margin: "0 auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: space.lg,
                  }}
                >
                  {/* 群标识 */}
                  <div style={{ display: "flex", alignItems: "center", gap: space.lg }}>
                    <div
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: 16,
                        background: `linear-gradient(135deg, ${theme.from}, ${theme.to})`,
                        color: "#FFFFFF",
                        fontSize: 24,
                        fontWeight: 600,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {(groupName.trim() || "群").slice(0, 1)}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700], marginBottom: space.xs }}>
                        群标识配色
                      </div>
                      <div style={{ display: "flex", gap: space.xs }}>
                        {GROUP_THEMES.map((t) => {
                          const on = t.key === themeKey;
                          return (
                            <button
                              key={t.key}
                              type="button"
                              data-testid="theme-option"
                              data-active={on ? "true" : "false"}
                              aria-label={`群标识配色 ${t.label}`}
                              onClick={() => setThemeKey(t.key)}
                              style={{
                                width: 28,
                                height: 28,
                                borderRadius: "50%",
                                border: `2px solid ${on ? neutral[900] : "transparent"}`,
                                background: `linear-gradient(135deg, ${t.from}, ${t.to})`,
                                cursor: "pointer",
                                padding: 0,
                              }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: space.xs }}>
                      <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>群名</span>
                      <span style={{ fontSize: 10, color: "#DC2626" }}>必填</span>
                    </div>
                    <input
                      data-testid="group-name"
                      value={groupName}
                      onChange={(e) => setGroupName(e.target.value)}
                      placeholder="如：消息中心重构"
                      style={inputStyle}
                    />
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                    <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>群描述</div>
                    <textarea
                      data-testid="group-desc"
                      value={groupDesc}
                      onChange={(e) => setGroupDesc(e.target.value)}
                      placeholder="这个群聊要做什么？一句话说明目标与范围"
                      rows={3}
                      style={{
                        ...inputStyle,
                        height: "auto",
                        padding: `${space.sm}px ${space.sm + 2}px`,
                        lineHeight: 1.6,
                        resize: "none",
                      }}
                    />
                  </div>

                  {/* 全局会话只读提示：成员全局唯一 session，本群任务共享其已有上下文（不再按群隔离） */}
                  <div
                    data-testid="global-session-note"
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: space.md,
                      padding: space.md,
                      borderRadius: radius.md,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: neutral[50],
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: radius.sm,
                        backgroundColor: "#EFF6FF",
                        border: "1px solid #BFDBFE",
                        color: "#2563EB",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: fontSize.md,
                        flexShrink: 0,
                      }}
                    >
                      ◉
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>
                        成员使用其全局会话
                      </span>
                      <span style={{ display: "block", fontSize: 10, color: neutral[500], lineHeight: 1.6, marginTop: 2 }}>
                        一个成员全局只有一个会话；本群任务会共享该成员已有上下文（不再按群隔离）。
                        成员在其他群聊里积累的上下文在本群同样生效，建群不会新建或切换会话。
                      </span>
                      <span
                        data-testid="workdir-note"
                        style={{ display: "block", fontSize: 10, color: neutral[500], lineHeight: 1.6, marginTop: 2 }}
                      >
                        工作目录：成员默认使用私有工作目录；建群后可按权限切换到团队目录（服务端按席位授权）。
                      </span>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: space.xs,
                          marginTop: space.xs,
                          fontSize: 9,
                          color: neutral[400],
                        }}
                      >
                        <span
                          style={{
                            padding: "0 4px",
                            height: 14,
                            display: "inline-flex",
                            alignItems: "center",
                            borderRadius: 3,
                            backgroundColor: "#EFF6FF",
                            border: "1px solid #BFDBFE",
                            color: "#2563EB",
                            fontWeight: 600,
                          }}
                        >
                          只读
                        </span>
                        建群不改变会话归属，也不新建会话
                      </span>
                    </span>
                  </div>

                  {/* 已选成员预览（可移除） */}
                  <div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: space.xs, marginBottom: space.sm }}>
                      <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>
                        群成员 · {selectedMembers.length}
                      </span>
                      <span style={{ fontSize: 10, color: neutral[400] }}>点击 × 移除（回到上一步可重新选择）</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: space.xs }}>
                      {selectedMembers.map((m) => (
                        <span
                          key={m.id}
                          data-testid="selected-chip"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: space.xs,
                            padding: `2px ${space.sm}px 2px 2px`,
                            borderRadius: radius.pill,
                            backgroundColor: "#FFFFFF",
                            border: `1px solid ${m.id === effectiveMainId ? "#FDE68A" : neutral[200]}`,
                            fontSize: fontSize.xs,
                            color: neutral[700],
                          }}
                        >
                          <AgentAvatar role={m.role} size="sm" initials={m.name.slice(0, 1)} dot={false} style={{ width: 20, height: 20, fontSize: 9 }} />
                          {m.name}
                          {m.id === effectiveMainId && (
                            <span style={{ fontSize: 9, color: "#B45309", fontWeight: 600 }}>主</span>
                          )}
                          <button
                            type="button"
                            aria-label={`移除 ${m.name}`}
                            onClick={() => toggleMember(m.id)}
                            style={{
                              border: "none",
                              background: "transparent",
                              color: neutral[400],
                              fontSize: fontSize.sm,
                              cursor: "pointer",
                              lineHeight: 1,
                              padding: 0,
                              ...baseFont,
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ---------------- 步骤 ③ 确认创建 ---------------- */}
            {step === 2 && (
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: space.xl }}>
                <div
                  style={{
                    maxWidth: 720,
                    margin: "0 auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: space.lg,
                  }}
                >
                  {/* 群信息摘要 */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.md,
                      padding: space.lg,
                      borderRadius: radius.lg,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: neutral[50],
                    }}
                  >
                    <div
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: 14,
                        background: `linear-gradient(135deg, ${theme.from}, ${theme.to})`,
                        color: "#FFFFFF",
                        fontSize: 22,
                        fontWeight: 600,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {(groupName.trim() || "群").slice(0, 1)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
                        {groupName.trim() || "（未命名群聊）"}
                      </div>
                      <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: 2, lineHeight: 1.5 }}>
                        {groupDesc.trim() || "未填写群描述"} · {selectedMembers.length} 位成员 · 主 Agent：
                        {mainAgent?.name ?? "未指定"}
                      </div>
                    </div>
                    <span
                      data-testid="global-session-chip"
                      title="成员全局只有一个会话：本群任务共享其已有上下文（不再按群隔离）"
                      style={{
                        padding: "1px 8px",
                        borderRadius: radius.pill,
                        backgroundColor: "#EFF6FF",
                        border: "1px solid #BFDBFE",
                        color: "#2563EB",
                        fontSize: 10,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      全局会话共享上下文
                    </span>
                  </div>

                  {/* 成员清单 */}
                  <div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: space.xs, marginBottom: space.sm }}>
                      <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>
                        成员清单 · {selectedMembers.length}
                      </span>
                      <span style={{ fontSize: 10, color: neutral[400] }}>★ 为主 Agent</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: space.xs }}>
                      {selectedMembers.map((m) => (
                        <div
                          key={m.id}
                          data-testid="confirm-member"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: space.sm,
                            padding: `${space.xs + 1}px ${space.sm}px`,
                            borderRadius: radius.md,
                            border: `1px solid ${m.id === effectiveMainId ? "#FDE68A" : neutral[200]}`,
                            backgroundColor: m.id === effectiveMainId ? "#FFFBEB" : "#FFFFFF",
                          }}
                        >
                          <AgentAvatar role={m.role} size="sm" initials={m.name.slice(0, 1)} dot={false} />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: "block", fontSize: fontSize.sm, color: neutral[800], fontWeight: 500 }}>
                              {m.name}
                              {m.id === effectiveMainId && <span style={{ color: "#B45309", marginLeft: 3 }}>★</span>}
                            </span>
                            <span style={{ display: "block", fontSize: 10, color: neutral[400] }}>
                              {roles[m.role].label} ·{" "}
                              {m.groups.length > 0 ? `已在 ${m.groups.length} 个群聊` : "未加入其他群聊"}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 跨群 / 会话提示 */}
                  {crossGroupCount > 0 && (
                    <div
                      data-testid="cross-group-note"
                      style={{
                        padding: space.md,
                        borderRadius: radius.md,
                        backgroundColor: "#FFFBEB",
                        border: "1px solid #FDE68A",
                        color: "#B45309",
                        fontSize: fontSize.xs,
                        lineHeight: 1.7,
                      }}
                    >
                      {crossGroupCount} 位成员已在其他群聊：
                      {selectedMembers
                        .filter((m) => m.groups.length > 0)
                        .map((m) => `${m.name}（${m.groups.join("、")}）`)
                        .join("；")}
                      。创建后他们同时存在于多个群聊，原群聊成员关系不受影响。
                    </div>
                  )}

                  <div
                    style={{
                      padding: space.md,
                      borderRadius: radius.md,
                      backgroundColor: neutral[50],
                      border: `1px dashed ${neutral[300]}`,
                      fontSize: fontSize.xs,
                      color: neutral[500],
                      lineHeight: 1.7,
                    }}
                  >
                    创建后可在会话页（wechat-chat 原型）看到该群聊；成员可在成员库（member-manage 原型）中继续维护。
                    主 Agent 为群内席位，可在群设置中更换；成员使用全局会话，本群任务共享其已有上下文（不再按群隔离）。
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 卡片底：提示 + 操作 */}
          <div
            style={{
              flexShrink: 0,
              padding: `${space.md}px ${space.xl}px`,
              borderTop: `1px solid ${neutral[200]}`,
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              backgroundColor: "#FFFFFF",
            }}
          >
            <span data-testid="step-hint" style={{ fontSize: fontSize.xs, color: neutral[400], flex: 1 }}>
              {step === 0
                ? selectedIds.length < 2
                  ? `还需选择 ${2 - selectedIds.length} 位成员才能进入下一步（至少 2 位）`
                  : `已选 ${selectedIds.length} 位成员，主 Agent：${mainAgent?.name ?? "未指定"}`
                : step === 1
                  ? groupName.trim()
                    ? "群设置已完成，可进入确认页"
                    : "请填写群名（必填）"
                  : "确认信息无误后创建群聊"}
            </span>
            <button
              type="button"
              data-testid="cancel-btn"
              onClick={() => setToast("取消创建：应返回会话页（原型内不跳转）")}
              style={{
                padding: `${space.xs + 2}px ${space.lg}px`,
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "#FFFFFF",
                color: neutral[600],
                fontSize: fontSize.sm,
                cursor: "pointer",
                ...baseFont,
              }}
            >
              取消
            </button>
            {step > 0 && (
              <button
                type="button"
                data-testid="prev-btn"
                onClick={() => setStep(step - 1)}
                style={{
                  padding: `${space.xs + 2}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "#FFFFFF",
                  color: neutral[600],
                  fontSize: fontSize.sm,
                  cursor: "pointer",
                  ...baseFont,
                }}
              >
                上一步
              </button>
            )}
            {step < 2 ? (
              <button
                type="button"
                data-testid="next-btn"
                disabled={!canNext}
                onClick={() => canNext && setStep(step + 1)}
                style={{
                  padding: `${space.xs + 2}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: canNext ? "#2563EB" : neutral[200],
                  color: canNext ? "#FFFFFF" : neutral[400],
                  fontSize: fontSize.sm,
                  fontWeight: 500,
                  cursor: canNext ? "pointer" : "not-allowed",
                  ...baseFont,
                }}
              >
                {step === 0 ? `下一步（${selectedIds.length}）` : "下一步"}
              </button>
            ) : (
              <button
                type="button"
                data-testid="create-btn"
                onClick={createGroup}
                style={{
                  padding: `${space.xs + 2}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  fontSize: fontSize.sm,
                  fontWeight: 500,
                  cursor: "pointer",
                  ...baseFont,
                }}
              >
                创建群聊
              </button>
            )}
          </div>
        </div>
      </div>

      <NavDock activeKey="messages" projectName="Agent 协作平台" />

      {/* ---------------- 快速新建成员（absolute 弹窗） ---------------- */}
      {quickCreateOpen && (
        <div
          data-testid="quick-create-overlay"
          onClick={() => setQuickCreateOpen(false)}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 40,
            backgroundColor: "rgba(15,23,42,.28)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: space.xl,
          }}
        >
          <div
            data-testid="quick-create-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 440,
              maxWidth: "100%",
              backgroundColor: "#FFFFFF",
              borderRadius: radius.lg,
              boxShadow: shadow.lg,
              padding: space.xl,
              display: "flex",
              flexDirection: "column",
              gap: space.md,
              animation: "gc-pop .16s ease-out",
              ...baseFont,
            }}
          >
            <div>
              <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>新建成员</div>
              <div data-testid="quick-create-hint" style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2, lineHeight: 1.6 }}>
                成员是平台级资产：保存后会出现在成员库，后续可在成员库统一管理（编辑、停用、绑定渠道、加入其他群）。
                创建后会自动勾选到本群。
              </div>
            </div>
            <input
              data-testid="quick-name"
              value={quickName}
              onChange={(e) => setQuickName(e.target.value)}
              placeholder="成员名称，如：沈舟"
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: space.xs, flexWrap: "wrap" }}>
              {(Object.keys(roles) as RoleKey[]).map((r) => {
                const on = quickRole === r;
                return (
                  <button
                    key={r}
                    type="button"
                    data-testid="quick-role"
                    data-active={on ? "true" : "false"}
                    onClick={() => setQuickRole(r)}
                    style={{
                      padding: `${space.xs}px ${space.md}px`,
                      borderRadius: radius.pill,
                      border: `1px solid ${on ? roles[r].border : neutral[200]}`,
                      backgroundColor: on ? roles[r].bg : "#FFFFFF",
                      color: on ? roleText[r] : neutral[600],
                      fontSize: fontSize.xs,
                      fontWeight: on ? 600 : 500,
                      cursor: "pointer",
                      ...baseFont,
                    }}
                  >
                    {roles[r].label}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
              <button
                type="button"
                onClick={() => setQuickCreateOpen(false)}
                style={{
                  padding: `${space.xs + 2}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "#FFFFFF",
                  color: neutral[600],
                  fontSize: fontSize.sm,
                  cursor: "pointer",
                  ...baseFont,
                }}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="quick-submit"
                disabled={!quickName.trim()}
                onClick={quickCreate}
                style={{
                  padding: `${space.xs + 2}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: quickName.trim() ? "#2563EB" : neutral[200],
                  color: quickName.trim() ? "#FFFFFF" : neutral[400],
                  fontSize: fontSize.sm,
                  fontWeight: 500,
                  cursor: quickName.trim() ? "pointer" : "not-allowed",
                  ...baseFont,
                }}
              >
                创建并勾选
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast text={toast} onClose={() => setToast("")} />}

      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
    </div>
  );
}

/** 轻提示（absolute 底中，原型内所有「示意」操作的反馈承载） */
function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div
      data-testid="toast"
      style={{
        position: "absolute",
        left: "50%",
        bottom: 24,
        transform: "translateX(-50%)",
        zIndex: 50,
        maxWidth: 560,
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        padding: `${space.sm}px ${space.md}px`,
        borderRadius: radius.pill,
        backgroundColor: "rgba(15,23,42,.9)",
        color: "#F8FAFC",
        fontSize: fontSize.xs,
        boxShadow: shadow.md,
        animation: "gc-pop .16s ease-out",
        ...baseFont,
      }}
    >
      <span>{text}</span>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={onClose}
        style={{
          border: "none",
          background: "transparent",
          color: neutral[400],
          fontSize: fontSize.sm,
          cursor: "pointer",
          lineHeight: 1,
          padding: 0,
          ...baseFont,
        }}
      >
        ✕
      </button>
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "group-create",
    name: "新建群聊",
    group: "成员与群聊",
    description: "三步式建群：从成员库多选成员、角色分布与主 Agent 席位指定、群设置与全局会话提示、确认创建（含跨群提示）",
    device: "desktop",
  },
  Component: GroupCreate,
};

export default def;
