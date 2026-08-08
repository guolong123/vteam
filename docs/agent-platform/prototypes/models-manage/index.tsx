/**
 * 原型：模型目录管理（模型目录中心化 · 凭据配置与 worker 定向下发）
 * =============================================
 * 对应 14 篇 FR-47（默认模型配置）、17 篇 §3.4（凭据 AES-256-GCM 加密落库基线）
 * 与 §5.4（凭据不进模型上下文/日志/审计事件）以及推进计划 C1~C6：
 * 平台侧维护模型目录（providerID / modelID / name / enabled），worker 上报
 * capabilities.models 合并入库（C2/C3），凭据按 provider 粒度保存（C4），
 * 经 auth.json 注入下发——可指定 worker 定向（enqueueCommand）或默认全量广播
 * （broadcastCommand，C5）；agent 模型选择从目录拉取（C6）。
 * 模型 mock 语义与 server STATIC_AVAILABLE_MODELS（agent.constants.ts:25-34，
 * providerID/modelID 格式）一致，采用产品视角命名。
 *
 * 页面内容（区块顺序）：
 * - ① 工具条：标题 + 计数（总模型 / 已配置凭据）+ 搜索框（model-search，
 *   按模型名 / provider 过滤，受控联动）+ 添加入口（model-add-button）。
 * - ② 模型列表（model-list）：8 个模型行（model-item）——provider 列
 *   （model-provider）+ 模型名称列（model-name）+ 模型ID列（model-id，
 *   providerID/modelID mono）+ 可用节点数 + 凭据状态徽章
 *   （model-credential-status：已配置=绿 / 未配置=灰）+ 启用/停用开关
 *   （model-toggle，受控切换）；点击行选中 → 联动下方凭据配置区。
 * - ③ 凭据配置区（credential-section）：目标模型 select（provider / 模型名）+
 *   token 输入（model-credential-input）+ 目标 worker 多选
 *   （model-credential-target-workers：3 个 mock worker，在线/离线混合，
 *   说明「未选则同步到全部 worker」）+ 保存（纯展示）。
 * - 复用 ../_shared/nav（NavDock / NavTopBar / CmdKPanel）+ ../_shared/styles token；
 *   共享 components 无模型/凭据语义组件，凭据徽章按"扩展 token"范式页面内定义。
 * - ⚠️ T15 铁律：root height:100% + minHeight:720 + position:relative，零 fixed/vh/vw；
 *   T20：CmdKPanel 受控开关默认关闭。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起态宽度（与 _shared/nav RAIL_W 对齐），内容区避让留白 */
const RAIL_W = 56;

/* Cmd+K 命令项：导航组图标与 Dock 一一对应，「Worker 节点」高亮呼应当前页
 * （模型由 worker 承载、凭据下发给 worker；实现期新增「模型管理」导航项） */
const CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙", active: true },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "导航", label: "用户管理", icon: "☷" },
  { group: "操作", label: "新增模型", icon: "✚" },
  { group: "操作", label: "配置凭据", icon: "◷" },
];

/* ------------------------------ 页面内语义色（未入 _shared） ------------------------------
 * 凭据状态「已配置 / 未配置」语义独立于任务四态（statusColors）与角色色，
 * 遵循"扩展 token"范式在页面内定义具名常量并注释原因，不扩散共享层。
 */
const credentialTheme = {
  configured: { label: "已配置", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  missing: { label: "未配置", color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
} as const;

/** 启用开关主色（与导航高亮蓝同族） */
const toggleActive = "#2563EB";

/* 行 hover / 过渡（scoped：mmrow 前缀避免污染其他原型） */
const rowCss = `
.mm-model-row { transition: border-color .15s ease, background-color .15s ease; }
.mm-model-row:hover { background-color: #F8FAFC; }
`;

/* ------------------------------ mock 数据 ------------------------------ */

interface ModelItem {
  /** 模型ID：providerID/modelID（与 STATIC_AVAILABLE_MODELS 同格式） */
  id: string;
  /** providerID（凭据按 provider 粒度配置） */
  provider: string;
  /** modelID */
  modelId: string;
  /** 产品视角模型名（展示列） */
  name: string;
  desc: string;
  /** 可用节点数（worker 上报 capabilities.models 合并统计） */
  nodes: number;
  /** 凭据状态：configured=已配置 token / missing=未配置 */
  credential: "configured" | "missing";
  enabled: boolean;
}

/** 模型目录 8 个：provider 分布 opencode-go×3 + zhipu/openai/xai/moonshot/qwen，
 * 已配置 5 / 未配置 3（语义对齐 STATIC_AVAILABLE_MODELS 8 模型 seed 源） */
const modelCatalog: ModelItem[] = [
  {
    id: "opencode-go/deepseek-v4-flash",
    provider: "opencode-go",
    modelId: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    desc: "轻量高速，日常任务默认",
    nodes: 3,
    credential: "configured",
    enabled: true,
  },
  {
    id: "opencode-go/deepseek-v4-pro",
    provider: "opencode-go",
    modelId: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    desc: "复杂推理与长文分析",
    nodes: 2,
    credential: "configured",
    enabled: true,
  },
  {
    id: "opencode-go/deepseek-v4-flash-free",
    provider: "opencode-go",
    modelId: "deepseek-v4-flash-free",
    name: "DeepSeek V4 Flash Free",
    desc: "免费档位，限速调用",
    nodes: 1,
    credential: "configured",
    enabled: true,
  },
  {
    id: "zhipu/glm-5.1",
    provider: "zhipu",
    modelId: "glm-5.1",
    name: "GLM 5.1",
    desc: "中文理解与代码生成",
    nodes: 2,
    credential: "missing",
    enabled: true,
  },
  {
    id: "openai/gpt-5.6-luna",
    provider: "openai",
    modelId: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    desc: "多模态通用旗舰",
    nodes: 2,
    credential: "configured",
    enabled: true,
  },
  {
    id: "xai/grok-4.5",
    provider: "xai",
    modelId: "grok-4.5",
    name: "Grok 4.5",
    desc: "实时信息与创意生成",
    nodes: 1,
    credential: "missing",
    enabled: false,
  },
  {
    id: "moonshot/kimi-k2.6",
    provider: "moonshot",
    modelId: "kimi-k2.6",
    name: "Kimi K2.6",
    desc: "长上下文阅读助手",
    nodes: 1,
    credential: "missing",
    enabled: true,
  },
  {
    id: "qwen/qwen3.6-plus",
    provider: "qwen",
    modelId: "qwen3.6-plus",
    name: "Qwen 3.6 Plus",
    desc: "通用能力均衡，性价比高",
    nodes: 2,
    credential: "configured",
    enabled: true,
  },
];

interface WorkerNode {
  id: string;
  name: string;
  online: boolean;
}

/** 目标 worker 池 3 个：在线 / 离线混合（mock 多选，未选=全部 worker） */
const workerPool: WorkerNode[] = [
  { id: "wkr-linux-01", name: "worker-linux-01", online: true },
  { id: "wkr-linux-02", name: "worker-linux-02", online: true },
  { id: "wkr-mac-01", name: "worker-mac-01", online: false },
];

/* ------------------------------ 子组件 ------------------------------ */

/** 凭据状态徽章：已配置=绿 / 未配置=灰（仿 StatusBadge 视觉，theme 页面内定义） */
function CredentialBadge({ status }: { status: "configured" | "missing" }) {
  const theme = credentialTheme[status];
  return (
    <span
      data-testid="model-credential-status"
      data-status={status}
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
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: theme.color,
          flexShrink: 0,
        }}
      />
      {theme.label}
    </span>
  );
}

/** 启用/停用开关（受控）：滑动圆点 switch，点击切换 */
function ToggleSwitch({
  modelId,
  checked,
  onToggle,
}: {
  modelId: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-testid="model-toggle"
      data-model-id={modelId}
      data-active={checked ? "true" : "false"}
      aria-label={checked ? "停用模型" : "启用模型"}
      onClick={onToggle}
      style={{
        position: "relative",
        width: 36,
        height: 20,
        flexShrink: 0,
        borderRadius: radius.pill,
        border: "none",
        cursor: "pointer",
        backgroundColor: checked ? toggleActive : neutral[300],
        transition: "background-color .15s ease",
        fontFamily: fontFamily.body,
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          backgroundColor: "#FFFFFF",
          boxShadow: shadow.sm,
          transition: "left .15s ease",
        }}
      />
    </button>
  );
}

/** 模型行卡片：provider 列 + 名称列 + 模型ID列 + 可用节点 + 凭据状态 + 启用开关 */
function ModelRow({
  m,
  enabled,
  selected,
  onSelect,
  onToggle,
}: {
  m: ModelItem;
  enabled: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      data-testid="model-item"
      data-model-id={m.id}
      data-provider={m.provider}
      data-enabled={enabled ? "true" : "false"}
      data-credential={m.credential}
      data-selected={selected ? "true" : "false"}
      onClick={onSelect}
      className="mm-model-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.lg,
        padding: `${space.lg}px ${space.xl}px`,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${selected ? toggleActive : neutral[200]}`,
        boxShadow: selected ? `0 0 0 1px ${toggleActive}33, ${shadow.sm}` : shadow.sm,
        cursor: "pointer",
        ...baseFont,
      }}
    >
      {/* provider 列 */}
      <span
        data-testid="model-provider"
        data-provider={m.provider}
        style={{
          width: 140,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: space.sm,
          fontSize: fontSize.md,
          fontWeight: 500,
          color: neutral[700],
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            flexShrink: 0,
            borderRadius: "50%",
            backgroundColor: toggleActive,
          }}
        />
        {m.provider}
      </span>

      {/* 模型名称列 + 描述 */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}
      >
        <span
          data-testid="model-name"
          data-model-id={m.id}
          style={{
            fontSize: fontSize.lg,
            fontWeight: 600,
            color: neutral[900],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {m.name}
        </span>
        <span
          style={{
            fontSize: fontSize.md,
            color: neutral[500],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {m.desc}
        </span>
      </div>

      {/* 模型ID列（providerID/modelID，mono） */}
      <span
        data-testid="model-id"
        data-model-id={m.id}
        style={{
          width: 250,
          flexShrink: 0,
          fontSize: fontSize.sm,
          fontFamily: fontFamily.mono,
          color: neutral[500],
          letterSpacing: "-0.01em",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {m.id}
      </span>

      {/* 可用节点数 */}
      <span
        style={{
          width: 72,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "baseline",
          gap: space.xs,
          fontSize: fontSize.md,
          color: neutral[700],
        }}
      >
        <span style={{ fontWeight: 600, fontFamily: fontFamily.mono }}>{m.nodes}</span>
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>节点</span>
      </span>

      {/* 凭据状态 */}
      <CredentialBadge status={m.credential} />

      {/* 启用/停用开关（点击行选中，点击开关切换，互不干扰） */}
      <div
        style={{
          width: 36,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <ToggleSwitch modelId={m.id} checked={enabled} onToggle={onToggle} />
      </div>
    </div>
  );
}

/* ------------------------------ 页面主组件 ------------------------------ */

function ModelsManagePage() {
  /* Cmd+K 命令面板受控开关（T20）：默认关闭 */
  const [cmdkOpen, setCmdkOpen] = useState(false);

  /* 搜索框（受控，按模型名 / provider / modelID 过滤） */
  const [keyword, setKeyword] = useState("");

  /* 启用状态（受控切换，mock 不落库） */
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(
    () => Object.fromEntries(modelCatalog.map((m) => [m.id, m.enabled])),
  );

  /* 选中模型（点击行联动凭据配置区） */
  const [selectedId, setSelectedId] = useState<string>(modelCatalog[0].id);

  /* 凭据配置 mock：token 输入 + 目标 worker 多选（空=全部 worker） */
  const [token, setToken] = useState("");
  const [targetWorkers, setTargetWorkers] = useState<Set<string>>(new Set());

  const kw = keyword.trim().toLowerCase();
  const filtered =
    kw === ""
      ? modelCatalog
      : modelCatalog.filter((m) =>
          `${m.name} ${m.provider} ${m.modelId}`.toLowerCase().includes(kw),
        );

  const configuredCount = modelCatalog.filter((m) => m.credential === "configured").length;
  const missingCount = modelCatalog.length - configuredCount;

  const selectedModel = modelCatalog.find((m) => m.id === selectedId) ?? modelCatalog[0];

  const toggleWorker = (id: string) => {
    setTargetWorkers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      data-testid="models-manage-root"
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
      <style>{rowCss}</style>

      {/* 浅色顶栏 */}
      <NavTopBar
        title="模型目录"
        subtitle="平台模型目录中心化管理：模型登记 / 凭据配置（指定 worker 定向下发） / 启用停用"
        userName="运营者"
        userRole="平台管理员"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：居中容器，左侧留白避让 Dock */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: `${space.xl}px ${space.xl}px ${space.xxl}px ${RAIL_W + space.xl}px`,
        }}
      >
        <div
          style={{
            maxWidth: 1080,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: space.lg,
          }}
        >
          {/* ① 工具条：标题 + 计数 + 搜索框 + 添加入口 */}
          <div
            data-testid="manage-toolbar"
            style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}
          >
            <span style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900] }}>
              模型目录
            </span>
            <span
              style={{
                fontSize: fontSize.xs,
                color: neutral[500],
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
                borderRadius: radius.pill,
                padding: "2px 10px",
                fontFamily: fontFamily.mono,
              }}
            >
              {modelCatalog.length} 个模型 · 已配置 {configuredCount} / 未配置 {missingCount}
            </span>

            {/* 搜索框（按模型名 / provider / modelID 过滤） */}
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
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
                boxShadow: shadow.sm,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400], lineHeight: 1 }}>
                ⌕
              </span>
              <input
                data-testid="model-search"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索模型名 / provider…"
                aria-label="搜索模型"
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

            {/* 添加入口（登记新模型，纯展示） */}
            <button
              type="button"
              data-testid="model-add-button"
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
                marginLeft: "auto",
              }}
            >
              <span aria-hidden>✚</span>
              新增模型
            </button>
          </div>

          {/* ② 模型列表（白卡容器 + 表头行 + 8 行） */}
          <div
            data-testid="model-list"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: space.sm,
              padding: space.md,
              borderRadius: radius.lg,
              backgroundColor: "#FFFFFF",
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
                全部模型
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                目录中心化：worker 上报 capabilities.models 合并入库 · agent 模型选择从此拉取（C3/C6）
              </span>
              {kw !== "" && (
                <span
                  style={{
                    fontSize: fontSize.xs,
                    color: "#2563EB",
                    backgroundColor: "#EFF6FF",
                    border: `1px solid #BFDBFE`,
                    borderRadius: radius.pill,
                    padding: "1px 8px",
                    marginLeft: "auto",
                  }}
                >
                  过滤命中 {filtered.length} / {modelCatalog.length}
                </span>
              )}
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
              <span style={{ width: 140, flexShrink: 0 }}>PROVIDER</span>
              <span style={{ flex: 1, minWidth: 0 }}>模型名称</span>
              <span style={{ width: 250, flexShrink: 0 }}>模型 ID</span>
              <span style={{ width: 72, flexShrink: 0 }}>可用节点</span>
              <span style={{ width: 88, flexShrink: 0 }}>凭据状态</span>
              <span style={{ width: 36, flexShrink: 0 }}>启用</span>
            </div>

            {/* 模型行 */}
            {filtered.map((m) => (
              <ModelRow
                key={m.id}
                m={m}
                enabled={enabledMap[m.id]}
                selected={m.id === selectedId}
                onSelect={() => setSelectedId(m.id)}
                onToggle={() =>
                  setEnabledMap((prev) => ({ ...prev, [m.id]: !prev[m.id] }))
                }
              />
            ))}

            {/* 空结果（过滤无命中） */}
            {filtered.length === 0 && (
              <div
                style={{
                  padding: `${space.xxl}px`,
                  textAlign: "center",
                  fontSize: fontSize.md,
                  color: neutral[400],
                }}
              >
                无匹配模型，换个关键词试试
              </div>
            )}
          </div>

          {/* ③ 凭据配置区：token 输入 + 目标 worker 多选（未选=全部 worker） */}
          <div
            data-testid="credential-section"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: space.lg,
              padding: `${space.xl}px`,
              borderRadius: radius.lg,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.md,
              ...baseFont,
            }}
          >
            {/* 标题行 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                  配置模型凭据
                </span>
                <span aria-hidden style={{ fontSize: fontSize.lg, color: "#D97706", lineHeight: 1 }}>
                  ◷
                </span>
              </div>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                17 篇 §3.4 · token 经 AES-256-GCM 加密落库，响应仅返回脱敏 fingerprint
              </span>
            </div>

            {/* 目标模型 select（provider / 模型名） */}
            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>
                目标模型
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
                <select
                  data-testid="model-credential-select"
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  aria-label="选择目标模型"
                  style={{
                    fontFamily: fontFamily.body,
                    fontSize: fontSize.md,
                    color: neutral[800],
                    backgroundColor: "#FFFFFF",
                    border: `1px solid ${neutral[300]}`,
                    borderRadius: radius.md,
                    padding: `${space.sm}px ${space.md}px`,
                    cursor: "pointer",
                    minWidth: 300,
                  }}
                >
                  {modelCatalog.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.provider} / {m.name}
                    </option>
                  ))}
                </select>
                <CredentialBadge status={selectedModel.credential} />
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  {selectedModel.id}
                </span>
              </div>
            </div>

            {/* token 输入（mock，不落库） */}
            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>
                API Token
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
                <input
                  data-testid="model-credential-input"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={`输入 ${selectedModel.provider} 的 API token（sk-…）`}
                  aria-label="API Token"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    maxWidth: 460,
                    padding: `${space.sm}px ${space.md}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[300]}`,
                    backgroundColor: "#FFFFFF",
                    fontSize: fontSize.md,
                    color: neutral[800],
                    fontFamily: fontFamily.body,
                    outline: "none",
                  }}
                />
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  按 provider 粒度保存，agent 选择该模型时自动生效
                </span>
              </div>
            </div>

            {/* 目标 worker 多选（未选=全部 worker） */}
            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
                <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>
                  目标 Worker
                </span>
                <span style={{ fontSize: fontSize.xs, color: "#2563EB" }}>
                  未选则同步到全部 worker
                </span>
                <button
                  type="button"
                  data-testid="model-credential-select-all"
                  onClick={() => setTargetWorkers(new Set(workerPool.map((w) => w.id)))}
                  style={{
                    fontSize: fontSize.xs,
                    color: neutral[500],
                    border: `1px solid ${neutral[200]}`,
                    borderRadius: radius.sm,
                    backgroundColor: "#FFFFFF",
                    padding: "2px 8px",
                    cursor: "pointer",
                    fontFamily: fontFamily.body,
                    marginLeft: "auto",
                  }}
                >
                  全选
                </button>
              </div>
              <div
                data-testid="model-credential-target-workers"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.md,
                  flexWrap: "wrap",
                  padding: space.md,
                  borderRadius: radius.md,
                  backgroundColor: neutral[50],
                  border: `1px solid ${neutral[200]}`,
                }}
              >
                {workerPool.map((w) => {
                  const checked = targetWorkers.has(w.id);
                  return (
                    <label
                      key={w.id}
                      data-worker-id={w.id}
                      data-online={w.online ? "true" : "false"}
                      data-checked={checked ? "true" : "false"}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: space.sm,
                        padding: `${space.xs + 2}px ${space.md}px`,
                        borderRadius: radius.pill,
                        backgroundColor: checked ? "#EFF6FF" : "#FFFFFF",
                        border: `1px solid ${checked ? "#BFDBFE" : neutral[200]}`,
                        cursor: "pointer",
                        fontSize: fontSize.md,
                        color: neutral[700],
                        fontFamily: fontFamily.body,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleWorker(w.id)}
                        style={{ accentColor: "#2563EB", cursor: "pointer" }}
                      />
                      <span
                        aria-hidden
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          backgroundColor: w.online ? "#059669" : "#94A3B8",
                          flexShrink: 0,
                        }}
                      />
                      {w.name}
                      <span
                        style={{
                          fontSize: fontSize.xs,
                          color: w.online ? "#059669" : neutral[400],
                        }}
                      >
                        {w.online ? "在线" : "离线"}
                      </span>
                    </label>
                  );
                })}
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  定向下发走 enqueueCommand；未选任何 worker 时走 broadcastCommand 全量广播（C5）
                </span>
              </div>
            </div>

            {/* 底部：保存 + 取消 + 加密说明 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.md,
                paddingTop: space.sm,
                borderTop: `1px solid ${neutral[100]}`,
              }}
            >
              <button
                type="button"
                data-testid="model-credential-save"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: space.xs,
                  padding: `${space.sm + 1}px ${space.xl}px`,
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
                保存凭据
              </button>
              <button
                type="button"
                data-testid="model-credential-cancel"
                style={{
                  padding: `${space.sm + 1}px ${space.xl}px`,
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
              <span
                style={{
                  marginLeft: "auto",
                  display: "flex",
                  alignItems: "center",
                  gap: space.xs,
                  fontSize: fontSize.xs,
                  color: neutral[400],
                }}
              >
                <span aria-hidden style={{ fontSize: fontSize.sm }}>◈</span>
                下发后 worker 写入 auth.json（600 权限），token 不进日志 / 模型上下文（17 篇 §5.4）
              </span>
            </div>
          </div>

          {/* 底部说明 */}
          <div
            data-testid="model-hint"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.xs,
              fontSize: fontSize.xs,
              color: neutral[400],
            }}
          >
            <span aria-hidden style={{ fontSize: fontSize.sm }}>◷</span>
            模型解析优先级：Agent 显式配置 → 模板默认（baseAgentId 链）→ worker 默认模型 →
            不指定（serve 默认）· 凭据保存后即时下发（C7 / C5）
          </div>
        </div>
      </main>

      {/* 左侧 Dock 悬浮导航：模型由 worker 承载、凭据下发到 worker → 高亮 Worker 节点 */}
      <NavDock activeKey="workers" projectName="Agent 协作平台">
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>模型</span>
            <span style={{ fontFamily: fontFamily.mono }}>{modelCatalog.length}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>凭据已配置</span>
            <span style={{ fontFamily: fontFamily.mono, color: "#059669" }}>{configuredCount}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>凭据未配置</span>
            <span style={{ fontFamily: fontFamily.mono, color: "#64748B" }}>{missingCount}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>在线节点</span>
            <span style={{ fontFamily: fontFamily.mono, color: "#059669" }}>
              {workerPool.filter((w) => w.online).length}
            </span>
          </div>
        </div>
      </NavDock>

      {/* Cmd+K 命令面板：受控开关（T20）——初始关闭 */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "models-manage",
    name: "模型目录管理",
    group: "平台",
    description:
      "模型目录中心化管理：模型列表（provider 列 + 模型名称列 + 模型ID列 providerID/modelID + 可用节点数 + 凭据状态徽章 已配置/未配置 + 启用/停用开关）+ 搜索（按模型名 / provider 过滤）+ 新增模型入口 + 凭据配置区（token 输入 + 目标 worker 多选，未选则同步到全部 worker）",
    device: "desktop",
  },
  Component: ModelsManagePage,
};

export default def;
