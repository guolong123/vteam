/**
 * 原型：Agent 配置
 * =============================================
 * 对应 PRD 04 篇「Agent 管理」：Agent 列表（4 预置角色模板 + 自定义示例）+ 配置面板（提示词/默认模型/技能/工具/权限范围五类配置项）+ 模板克隆入口。
 * - 默认模型（FR-47）：模型下拉 mock 平台目录 enabled 模型（选项「provider / 模型名」，如
 *   "opencode-go / DeepSeek V4 Flash"），来源标注模型目录（worker 上报合并入库）；
 *   模型凭据行 mock 已配置（绿徽章 + 脱敏 fingerprint）/ 未配置（token 输入框）双态，
 *   联动模型选择切换（受控，mock 不落库）；首选 Worker 软绑定（未选自动调度）。
 * - 纯静态展示：勾选/开关/编辑均为示意，无交互逻辑（模型下拉联动凭据态除外）。
 * - 导航融合方案（T17）：深色 Sidebar 已替换为 NavDock 悬浮导航 + 浅色 NavTopBar + Cmd+K 命令面板，
 *   与 nav-hybrid 融合版心智一致（命令面板 z-40，Dock z-50，两者共存不冲突）。
 * - Cmd+K 面板为受控开关（T19）：useState 管理 cmdkOpen（初始关闭），trigger 打开，✕/遮罩点击/Esc 关闭。
 * - ⚠️ T15 铁律：root `height:100%; position:relative`，浮层 absolute，零 fixed / vh / vw。
 * - 复用 ../_shared/nav 与 ../_shared/styles。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { AgentAvatar } from "../_shared/components";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import {
  type RoleKey,
  neutral,
  roles,
  roleText,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起态宽度（与 _shared/nav RAIL_W 对齐），内容区避让留白 */
const RAIL_W = 56;

/* ------------------------------ Mock 数据 ------------------------------ */

interface AgentInfo {
  id: string;
  name: string;
  role: RoleKey | "custom";
  /** 角色模板 or 自定义 */
  kind: "模板" | "自定义";
  description: string;
  skills: string[];
  tools: string[];
  /** 权限范围（FR-36） */
  scope: string;
  /** 默认模型（FR-47）：模型目录 id（providerID/modelID），来源平台模型目录动态获取 */
  defaultModel: string;
}

const skillPool = ["文档撰写", "需求拆解", "用例设计", "代码审查", "代码生成", "缺陷分析", "方案评审"];

/** 模型目录（mock）：对齐 models-manage 原型 8 项语义（providerID/modelID 与 STATIC_AVAILABLE_MODELS 同格式）；
 * 凭据按 provider 粒度配置（C4/C5），agent 模型选择从目录拉取 enabled 模型（C6）。 */
interface ModelCatalogItem {
  /** 模型ID：providerID/modelID */
  id: string;
  /** providerID（凭据按 provider 粒度保存） */
  provider: string;
  /** 产品视角模型名（下拉「provider / 名称」展示） */
  name: string;
  note: string;
  /** 停用模型不出现在 agent 选择下拉（对齐目录 enabled 语义） */
  enabled: boolean;
  /** 凭据状态：configured=已配置 token（仅展示脱敏 fingerprint）/ missing=未配置（展示输入框） */
  credential: "configured" | "missing";
  /** 脱敏 fingerprint（mock）：token 本身永不展示（17 篇 §5.4） */
  fingerprint: string;
}

const modelCatalog: ModelCatalogItem[] = [
  {
    id: "opencode-go/deepseek-v4-flash",
    provider: "opencode-go",
    name: "DeepSeek V4 Flash",
    note: "轻量高速，日常任务默认",
    enabled: true,
    credential: "configured",
    fingerprint: "sk-****d2k9",
  },
  {
    id: "opencode-go/deepseek-v4-pro",
    provider: "opencode-go",
    name: "DeepSeek V4 Pro",
    note: "复杂推理与长文分析",
    enabled: true,
    credential: "configured",
    fingerprint: "sk-****p4r7",
  },
  {
    id: "opencode-go/deepseek-v4-flash-free",
    provider: "opencode-go",
    name: "DeepSeek V4 Flash Free",
    note: "免费档位，限速调用",
    enabled: true,
    credential: "configured",
    fingerprint: "sk-****f9m3",
  },
  {
    id: "zhipu/glm-5.1",
    provider: "zhipu",
    name: "GLM 5.1",
    note: "中文理解与代码生成",
    enabled: true,
    credential: "missing",
    fingerprint: "",
  },
  {
    id: "openai/gpt-5.6-luna",
    provider: "openai",
    name: "GPT-5.6 Luna",
    note: "多模态通用旗舰",
    enabled: true,
    credential: "configured",
    fingerprint: "sk-****l5t1",
  },
  {
    id: "xai/grok-4.5",
    provider: "xai",
    name: "Grok 4.5",
    note: "实时信息与创意生成",
    enabled: false,
    credential: "missing",
    fingerprint: "",
  },
  {
    id: "moonshot/kimi-k2.6",
    provider: "moonshot",
    name: "Kimi K2.6",
    note: "长上下文阅读助手",
    enabled: true,
    credential: "missing",
    fingerprint: "",
  },
  {
    id: "qwen/qwen3.6-plus",
    provider: "qwen",
    name: "Qwen 3.6 Plus",
    note: "通用能力均衡，性价比高",
    enabled: true,
    credential: "configured",
    fingerprint: "sk-****q7w6",
  },
];

/* 凭据状态语义色（"扩展 token"范式页面内定义：语义独立于任务四态/角色色，与 models-manage 页内
 * credentialTheme 完全一致，不扩散共享层） */
const credentialTheme = {
  configured: { label: "已配置", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  missing: { label: "未配置", color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
} as const;

/** 目录 lookup：按模型 id 取目录项（未知 id 兜底首个） */
const modelById = (id: string): ModelCatalogItem =>
  modelCatalog.find((m) => m.id === id) ?? modelCatalog[0];

/** 首选 worker 池（mock）：未选 = 自动调度到任意可用 worker（软绑定，离线自动回退） */
const workerPool = [
  { id: "wkr-linux-01", name: "worker-linux-01", online: true },
  { id: "wkr-linux-02", name: "worker-linux-02", online: true },
  { id: "wkr-mac-01", name: "worker-mac-01", online: false },
];

const agentTemplates: AgentInfo[] = [
  {
    id: "pm-template",
    name: "产品经理",
    role: "product",
    kind: "模板",
    description: "以产品视角拆解需求、输出验收标准，撰写需求文档。",
    skills: ["需求拆解", "文档撰写"],
    tools: ["读取文档库", "搜索", "读取仓库"],
    scope: "仅读取，可写任务文档库",
    defaultModel: "opencode-go/deepseek-v4-flash",
  },
  {
    id: "arch-template",
    name: "架构师",
    role: "architect",
    kind: "模板",
    description: "负责系统设计与技术选型，输出技术方案设计文档。",
    skills: ["方案评审", "代码审查"],
    tools: ["读取仓库", "搜索", "执行命令"],
    scope: "读取 + 写任务文档库",
    defaultModel: "opencode-go/deepseek-v4-pro",
  },
  {
    id: "dev-template",
    name: "开发者",
    role: "developer",
    kind: "模板",
    description: "按需求与设计实现功能，提交代码与实现说明。",
    skills: ["代码生成", "代码审查"],
    tools: ["读取仓库", "执行命令", "写入仓库"],
    scope: "读取 + 写任务文档库 + 提交代码",
    defaultModel: "zhipu/glm-5.1",
  },
  {
    id: "tester-template",
    name: "测试",
    role: "tester",
    kind: "模板",
    description: "设计测试用例、执行验证并输出验证结论。",
    skills: ["用例设计", "缺陷分析"],
    tools: ["读取仓库", "执行命令"],
    scope: "仅读取，可写任务文档库",
    defaultModel: "opencode-go/deepseek-v4-pro",
  },
  {
    id: "custom-qa",
    name: "发布管家",
    role: "custom",
    kind: "自定义",
    description: "从「开发者」模板克隆而来，聚焦发布检查与变更记录。",
    skills: ["代码审查", "缺陷分析"],
    tools: ["读取仓库", "执行命令"],
    scope: "仅读取，可写任务文档库",
    defaultModel: "zhipu/glm-5.1",
  },
];

/* 当前选中 Agent（默认选中产品经理模板） */
const activeAgent = agentTemplates[0];

/* Cmd+K 命令项：导航组图标与 Dock 一一对应，操作组贴合本页配置场景 */
const CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉", active: true },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "操作", label: "克隆当前 Agent", icon: "⧉" },
  { group: "操作", label: "编辑提示词", icon: "✎" },
  { group: "操作", label: "调整权限范围", icon: "⚙" },
];

/* ------------------------------ 子组件 ------------------------------ */

/** 凭据状态徽章：已配置=绿 / 未配置=灰（仿 models-manage CredentialBadge 视觉，theme 页面内定义） */
function CredentialBadge({ status }: { status: "configured" | "missing" }) {
  const theme = credentialTheme[status];
  return (
    <span
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

/** 工具权限模型：工具名即权限 action，effect ∈ {allow, ask, deny}（与 opencode PermissionV2 对齐） */
type ToolEffectKey = "allow" | "ask" | "deny";

interface ToolPermission {
  /** 工具名即权限 action（如 bash.ts 中 action: name） */
  name: string;
  /** 来源：内置 / 自定义 / MCP（jira_query = <server>_<tool>） */
  source: "内置" | "自定义" | "MCP";
  /** effect：allow 允许 / ask 每次确认 / deny 禁止 */
  effect: ToolEffectKey;
  /** 启用状态：停用 = 该工具对当前 agent 不可见 */
  enabled: boolean;
}

/** effect 语义与配色（与 statusColors 同构） */
const toolEffectMeta: Record<
  ToolEffectKey,
  { label: string; desc: string; color: string; bg: string; border: string }
> = {
  allow: { label: "允许", desc: "无需确认 · 只读/低风险", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  ask: { label: "确认", desc: "每次调用需确认 · 有副作用", color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  deny: { label: "禁止", desc: "白名单排除", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
};

/** 工具来源徽章色 */
const toolSourceMeta: Record<ToolPermission["source"], { color: string; bg: string; border: string }> = {
  内置: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  自定义: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  MCP: { color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
};

/** 工具权限 mock：read=allow、bash=ask、write=allow、jenkins-build=ask、jira_query=allow */
const toolPermissions: ToolPermission[] = [
  { name: "read", source: "内置", effect: "allow", enabled: true },
  { name: "write", source: "内置", effect: "allow", enabled: true },
  { name: "bash", source: "内置", effect: "ask", enabled: true },
  { name: "jenkins-build", source: "自定义", effect: "ask", enabled: true },
  { name: "jira_query", source: "MCP", effect: "allow", enabled: true },
];

/** 工具权限列表：每工具一行 = 启用开关 + 工具名（action）+ effect 三选 */
function ToolPermissionList() {
  return (
    <div
      data-testid="tool-permission-list"
      style={{ display: "flex", flexDirection: "column", gap: space.sm }}
    >
      {toolPermissions.map((tool) => {
        const effect = toolEffectMeta[tool.effect];
        const source = toolSourceMeta[tool.source];
        return (
          <div
            key={tool.name}
            data-testid="tool-permission-item"
            data-tool={tool.name}
            data-enabled={tool.enabled ? "true" : "false"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.md,
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              backgroundColor: tool.enabled ? "#FFFFFF" : neutral[50],
              border: `1px solid ${neutral[200]}`,
              opacity: tool.enabled ? 1 : 0.62,
            }}
          >
            {/* 启用开关（停用 = 该工具对当前 agent 不可见） */}
            <span
              data-testid="tool-toggle-item"
              aria-hidden
              style={{
                flexShrink: 0,
                width: 34,
                height: 19,
                borderRadius: radius.pill,
                backgroundColor: tool.enabled ? "#10B981" : neutral[300],
                position: "relative",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  left: tool.enabled ? 17 : 2,
                  width: 15,
                  height: 15,
                  borderRadius: "50%",
                  backgroundColor: "#FFFFFF",
                }}
              />
            </span>

            {/* 工具名（action）+ 来源徽章 + effect 说明 */}
            <div
              style={{
                minWidth: 0,
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <span
                  style={{
                    fontFamily: fontFamily.mono,
                    fontSize: fontSize.md,
                    fontWeight: 600,
                    color: neutral[800],
                  }}
                >
                  {tool.name}
                </span>
                <span
                  style={{
                    fontSize: fontSize.xs,
                    color: source.color,
                    backgroundColor: source.bg,
                    border: `1px solid ${source.border}`,
                    padding: "1px 6px",
                    borderRadius: radius.pill,
                  }}
                >
                  {tool.source}
                </span>
              </div>
              <span style={{ fontSize: fontSize.xs }}>
                <span style={{ color: effect.color, fontWeight: 500 }}>{effect.label}</span>
                <span style={{ color: neutral[400] }}> · {effect.desc}</span>
              </span>
            </div>

            {/* effect 三选（allow / ask / deny） */}
            <div
              data-testid="tool-effect-select"
              role="radiogroup"
              aria-label={`${tool.name} 权限`}
              style={{
                flexShrink: 0,
                display: "inline-flex",
                gap: 2,
                padding: 3,
                borderRadius: radius.pill,
                backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`,
              }}
            >
              {(Object.keys(toolEffectMeta) as ToolEffectKey[]).map((key) => {
                const meta = toolEffectMeta[key];
                const active = tool.effect === key;
                return (
                  <span
                    key={key}
                    data-effect={key}
                    aria-checked={active}
                    role="radio"
                    style={{
                      padding: `2px ${space.sm}px`,
                      borderRadius: radius.pill,
                      fontSize: fontSize.xs,
                      fontWeight: 500,
                      cursor: "pointer",
                      fontFamily: fontFamily.mono,
                      color: active ? "#FFFFFF" : neutral[500],
                      backgroundColor: active ? meta.color : "transparent",
                    }}
                  >
                    {key}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* 通配符行：示例 jenkins-* → ask */}
      <div
        data-testid="tool-wildcard-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          border: `1px dashed ${neutral[300]}`,
          backgroundColor: neutral[50],
          fontSize: fontSize.xs,
          color: neutral[500],
        }}
      >
        <span style={{ fontFamily: fontFamily.mono, fontWeight: 600, color: neutral[700] }}>
          jenkins-*
        </span>
        <span aria-hidden style={{ color: neutral[300] }}>
          →
        </span>
        <span
          style={{
            color: toolEffectMeta.ask.color,
            backgroundColor: toolEffectMeta.ask.bg,
            border: `1px solid ${toolEffectMeta.ask.border}`,
            padding: "1px 6px",
            borderRadius: radius.pill,
            fontWeight: 500,
            fontFamily: fontFamily.mono,
          }}
        >
          ask
        </span>
        <span>可用通配符批量授权同类工具</span>
      </div>
    </div>
  );
}

/** 配置面板：提示词 / 技能 / 工具 / 权限范围 */
function ConfigPanel({ agent }: { agent: AgentInfo }) {
  const isTemplate = agent.role !== "custom";
  const accent = isTemplate ? roles[agent.role as RoleKey].color : "#64748B";
  const activeSkills = new Set(agent.skills);

  /* 默认模型选择（受控）：联动凭据行 已配置/未配置 双态展示（mock 不落库） */
  const [selectedModelId, setSelectedModelId] = useState(agent.defaultModel);
  const selectedModel = modelById(selectedModelId);

  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.lg,
        boxShadow: shadow.sm,
        padding: `${space.xl}px`,
        ...baseFont,
      }}
    >
      {/* 面板头部：Agent 名 + 克隆入口 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.md,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
          <AgentAvatar
            role={isTemplate ? (agent.role as RoleKey) : "developer"}
            initials={agent.name.slice(0, 1)}
            size="lg"
          />
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                fontSize: fontSize.xl,
                fontWeight: 600,
                color: neutral[900],
              }}
            >
              {agent.name}
              <span
                style={{
                  fontSize: fontSize.xs,
                  fontWeight: 500,
                  color: neutral[500],
                  backgroundColor: neutral[100],
                  border: `1px solid ${neutral[200]}`,
                  padding: "1px 7px",
                  borderRadius: radius.pill,
                }}
              >
                {agent.kind}
              </span>
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
              {agent.description}
            </div>
          </div>
        </div>
        <button
          type="button"
          data-testid="clone-template-button"
          data-agent-id={agent.id}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm}px ${space.lg}px`,
            borderRadius: radius.pill,
            border: `1px solid ${accent}`,
            backgroundColor: "#FFFFFF",
            color: accent,
            fontSize: fontSize.md,
            fontWeight: 500,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          ⧉ 克隆此 Agent
        </button>
      </div>

      {/* ① 提示词编辑器 */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            提示词配置
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            FR-33 · 即时生效于后续会话
          </span>
        </div>
        <textarea
          data-testid="prompt-editor"
          readOnly
          rows={4}
          spellCheck={false}
          defaultValue={`你是一名产品经理。请以产品经理视角拆解需求，输出验收标准；产出物以结构化格式提交至任务文档库。`}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "none",
            border: `1px solid ${neutral[200]}`,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            padding: space.md,
            fontSize: fontSize.md,
            lineHeight: 1.6,
            color: neutral[700],
            fontFamily: fontFamily.mono,
          }}
        />
      </div>

      {/* ② 默认模型配置（FR-47） */}
      <div
        data-testid="model-config"
        style={{ display: "flex", flexDirection: "column", gap: space.sm }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            默认模型
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            FR-47 · 新会话默认使用
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.md,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              fontSize: fontSize.sm,
            }}
          >
            <span aria-hidden style={{ color: accent, fontSize: fontSize.lg, lineHeight: 1 }}>
              ◉
            </span>
            <span style={{ color: neutral[500] }}>当前</span>
            <span style={{ color: neutral[800], fontWeight: 500 }}>{selectedModel.name}</span>
            <span style={{ color: neutral[400] }}>· {selectedModel.note}</span>
          </div>
          <select
            data-testid="model-select"
            value={selectedModelId}
            onChange={(e) => setSelectedModelId(e.target.value)}
            aria-label="选择默认模型"
            style={{
              fontFamily: fontFamily.body,
              fontSize: fontSize.sm,
              color: neutral[800],
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[300]}`,
              borderRadius: radius.md,
              padding: `${space.xs}px ${space.sm}px`,
              cursor: "pointer",
              width: 240,
            }}
          >
            {modelCatalog
              .filter((m) => m.enabled)
              .map((m) => (
                <option
                  key={m.id}
                  value={m.id}
                  data-testid="model-option-provider"
                  data-model-id={m.id}
                  data-credential={m.credential}
                >
                  {m.provider} / {m.name}
                </option>
              ))}
          </select>
        </div>

        {/* 模型凭据：mock 已配置/未配置双态（联动模型选择）；token AES-256-GCM 加密落库，仅展示脱敏 fingerprint */}
        <div
          data-testid="model-token-status"
          data-credential={selectedModel.credential}
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.md,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
          }}
        >
          <CredentialBadge status={selectedModel.credential} />
          {selectedModel.credential === "configured" ? (
            <span
              style={{
                fontFamily: fontFamily.mono,
                fontSize: fontSize.sm,
                color: neutral[600],
                letterSpacing: "0.02em",
              }}
            >
              {selectedModel.fingerprint}
            </span>
          ) : (
            <>
              <input
                data-testid="model-token-input"
                type="password"
                placeholder={`输入 ${selectedModel.provider} 的 API token（sk-…）`}
                aria-label="模型 API Token"
                style={{
                  flex: 1,
                  minWidth: 0,
                  maxWidth: 320,
                  padding: `${space.xs}px ${space.sm}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[300]}`,
                  backgroundColor: "#FFFFFF",
                  fontSize: fontSize.sm,
                  color: neutral[800],
                  fontFamily: fontFamily.mono,
                  outline: "none",
                }}
              />
              <button
                type="button"
                style={{
                  padding: `${space.xs + 1}px ${space.md}px`,
                  borderRadius: radius.pill,
                  border: "none",
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  fontSize: fontSize.xs,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                保存
              </button>
            </>
          )}
          <span style={{ marginLeft: "auto", fontSize: fontSize.xs, color: neutral[400] }}>
            {selectedModel.credential === "configured"
              ? "凭据已配置 · 按 provider 粒度生效（C4）"
              : "保存后即时下发到 worker（C5）"}
          </span>
        </div>

        {/* 首选 Worker：软绑定，未选则自动调度到任意可用 worker（离线自动回退） */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.md,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
          }}
        >
          <span style={{ fontSize: fontSize.sm, color: neutral[600], flexShrink: 0 }}>
            首选 Worker
          </span>
          <select
            data-testid="agent-worker-select"
            defaultValue=""
            aria-label="首选 Worker（未选则自动调度）"
            style={{
              fontFamily: fontFamily.body,
              fontSize: fontSize.sm,
              color: neutral[800],
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[300]}`,
              borderRadius: radius.md,
              padding: `${space.xs}px ${space.sm}px`,
              cursor: "pointer",
              minWidth: 220,
            }}
          >
            <option value="">自动调度（默认）</option>
            {workerPool.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {w.online ? "在线" : "离线"}
              </option>
            ))}
          </select>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            未选则自动调度到任意可用 worker（软绑定）
          </span>
        </div>

        <div
          data-testid="model-source-hint"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            fontSize: fontSize.xs,
            color: neutral[400],
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.xs }}>
            ↗
          </span>
          模型列表来自平台模型目录（worker 上报合并入库，C3）
        </div>
      </div>

      {/* ③ 技能列表勾选 */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            技能配置
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            FR-34 · 已启用 {activeSkills.size}/{skillPool.length}
          </span>
        </div>
        <div
          data-testid="skill-list"
          style={{ display: "flex", flexWrap: "wrap", gap: space.sm }}
        >
          {skillPool.map((skill) => {
            const checked = activeSkills.has(skill);
            return (
              <label
                key={skill}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: space.xs,
                  padding: `${space.xs}px ${space.sm + 2}px`,
                  borderRadius: radius.pill,
                  backgroundColor: checked ? "#EFF6FF" : neutral[50],
                  border: `1px solid ${checked ? "#BFDBFE" : neutral[200]}`,
                  color: checked ? roleText.product : neutral[500],
                  fontSize: fontSize.sm,
                  cursor: "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: radius.sm,
                    backgroundColor: checked ? "#2563EB" : "#FFFFFF",
                    border: `1px solid ${checked ? "#2563EB" : neutral[300]}`,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#FFFFFF",
                    fontSize: 10,
                    lineHeight: 1,
                  }}
                >
                  {checked ? "✓" : ""}
                </span>
                {skill}
              </label>
            );
          })}
        </div>
      </div>

      {/* ④ 工具配置（开关 + 权限矩阵） */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            工具配置
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            FR-35 · 停用后 Agent 无法调用
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            fontSize: fontSize.xs,
            color: neutral[400],
          }}
        >
          <span aria-hidden style={{ color: accent, fontSize: fontSize.xs }}>
            ◈
          </span>
          工具名即权限 action（如
          <span style={{ fontFamily: fontFamily.mono, color: neutral[600] }}>jenkins-build</span>
          ），支持通配符批量授权（如
          <span style={{ fontFamily: fontFamily.mono, color: neutral[600] }}>jenkins-*</span>
          ）
        </div>
        <ToolPermissionList />
      </div>

      {/* ⑤ 权限范围配置 */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
            权限范围
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            FR-36 · 超出范围的操作转交用户确认
          </span>
        </div>
        <div
          data-testid="permission-config"
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
          {[
            { label: "可访问资源", value: "本项目 · 任务文档库 · 关联仓库" },
            { label: "可执行操作", value: agent.scope },
            { label: "写操作确认", value: "默认关闭，首次写操作需成员确认" },
          ].map((row) => (
            <div
              key={row.label}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: space.md,
                fontSize: fontSize.sm,
              }}
            >
              <span style={{ color: neutral[500], flexShrink: 0 }}>{row.label}</span>
              <span style={{ color: neutral[800], textAlign: "right" }}>{row.value}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Agent 列表项 */
function AgentListItem({ agent }: { agent: AgentInfo }) {
  const isActive = agent.id === activeAgent.id;
  const isTemplate = agent.role !== "custom";
  const theme = isTemplate ? roles[agent.role as RoleKey] : { color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0", label: "自定义" };

  return (
    <button
      type="button"
      data-testid="agent-list-item"
      data-agent-id={agent.id}
      data-active={isActive ? "true" : "false"}
      style={{
        width: "100%",
        textAlign: "left",
        cursor: "pointer",
        border: `1px solid ${isActive ? theme.border : neutral[200]}`,
        borderRadius: radius.md,
        backgroundColor: isActive ? "#FFFFFF" : neutral[50],
        boxShadow: isActive ? shadow.sm : "none",
        padding: space.md,
        display: "flex",
        alignItems: "center",
        gap: space.md,
        fontFamily: fontFamily.body,
      }}
    >
      <AgentAvatar
        role={isTemplate ? (agent.role as RoleKey) : "developer"}
        initials={agent.name.slice(0, 1)}
        size="md"
        dot={false}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            fontSize: fontSize.md,
            fontWeight: 600,
            color: neutral[800],
          }}
        >
          {agent.name}
          <span
            style={{
              fontSize: fontSize.xs,
              color: theme.color,
              backgroundColor: theme.bg,
              border: `1px solid ${theme.border}`,
              padding: "1px 6px",
              borderRadius: radius.pill,
            }}
          >
            {agent.kind}
          </span>
        </div>
        <div
          style={{
            fontSize: fontSize.xs,
            color: neutral[400],
            marginTop: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {agent.description}
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: space.xs,
            marginTop: space.sm,
          }}
        >
          {agent.skills.map((skill) => (
            <span
              key={skill}
              style={{
                fontSize: fontSize.xs,
                color: neutral[500],
                backgroundColor: neutral[100],
                padding: "1px 6px",
                borderRadius: radius.pill,
              }}
            >
              {skill}
            </span>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            marginTop: space.xs,
            fontSize: fontSize.xs,
          }}
        >
          <span style={{ color: neutral[400] }}>默认模型</span>
          <span
            style={{
              color: theme.color,
              backgroundColor: theme.bg,
              border: `1px solid ${theme.border}`,
              padding: "1px 6px",
              borderRadius: radius.pill,
            }}
          >
            {modelById(agent.defaultModel).name}
          </span>
        </div>
      </div>
      {/* 启用状态开关示意 */}
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 34,
          height: 19,
          borderRadius: radius.pill,
          backgroundColor: "#10B981",
          position: "relative",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            right: 2,
            width: 15,
            height: 15,
            borderRadius: "50%",
            backgroundColor: "#FFFFFF",
          }}
        />
      </span>
    </button>
  );
}

/* ------------------------------ 页面主组件 ------------------------------ */

function AgentConfigPage() {
  const [cmdkOpen, setCmdkOpen] = useState(false);
  return (
    <div
      data-testid="agent-config-root"
      style={{
        height: "100%",
        minHeight: 720,
        position: "relative",
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
      }}
    >
      {/* 浅色顶栏：面包屑 + Cmd+K 触发框 + 用户 */}
      <NavTopBar
        title="Agent 配置"
        subtitle="预置模板 · 自定义 Agent · 配置项"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：absolute 相对 root，左侧留白避开 Dock */}
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 0,
          right: 0,
          bottom: 0,
          overflow: "auto",
          paddingLeft: RAIL_W + 24,
        }}
      >
        <div
          style={{
            padding: space.xl,
            display: "flex",
            gap: space.lg,
            alignItems: "flex-start",
          }}
        >
          {/* 左：Agent 列表 */}
          <div
            style={{
              width: 320,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              gap: space.sm,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: `0 ${space.xs}px`,
              }}
            >
              <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>
                Agent 列表
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                {agentTemplates.length} 个
              </span>
            </div>
            {agentTemplates.map((agent) => (
              <AgentListItem key={agent.id} agent={agent} />
            ))}
            <button
              type="button"
              style={{
                width: "100%",
                cursor: "pointer",
                border: `1px dashed ${neutral[300]}`,
                borderRadius: radius.md,
                backgroundColor: "transparent",
                padding: space.md,
                color: neutral[500],
                fontSize: fontSize.md,
                fontFamily: fontFamily.body,
              }}
            >
              + 新建自定义 Agent
            </button>
          </div>

          {/* 右：配置面板 */}
          <ConfigPanel agent={activeAgent} />
        </div>
      </div>

      {/* 左侧 Dock 悬浮导航：activeKey=agents（z-50，浮于命令面板遮罩之上可 hover 展开） */}
      <NavDock activeKey="agents" projectName="Agent 协作平台" />

      {/* Cmd+K 命令面板：受控开关（T19）——初始关闭，trigger 打开，✕/遮罩/Esc 关闭 */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS} />
    </div>
  );
}

export default {
  meta: { id: "agent-config", name: "Agent 配置", device: "desktop" },
  Component: AgentConfigPage,
} satisfies PrototypeDef;
