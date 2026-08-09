"use client";

/**
 * 任务创建页（Task 13 保真迁移）
 * =============================================
 * 唯一来源：docs/agent-platform/prototypes/task-create/index.tsx（device: desktop）。
 * - 左栏任务表单：标题* / 描述 / 背景文档上传（真实文件列表，初始为空）/ 优先级（低/中/高）+「待开始」提示条，对应 FR-01/FR-07。
 * - 右栏 Agent 选择：勾选来自 GET /agents（T4，role ↔ data-role 一一对应）+ 主 Agent（默认产品经理，FR-19）+ 已选列表 + 创建按钮 + create-hint。
 * - 交互增强（原型为静态勾选，本页实现联动）：
 *   · Agent 卡片可点击勾选/取消，「已选 Agent / N 个」与徽章列表实时联动；
 *   · 主 Agent 保持有效：取消勾选当前主 Agent → 自动转移至第一个勾选角色；
 *   · 创建按钮校验空标题（红色提示，与原型视觉语言一致），再提交。
 * - 提交：真实 POST /api/v1/projects/:pid/tasks（pid 取 URL ?pid=，缺省 seed 项目 p_seed_1）。
 *   成功 → router.push(/tasks/:id) 跳转任务详情（T13 路由）；失败 → isApiError 展示错误（09 篇 §3.4 契约）。
 * - 融合导航（NavTopBar / NavDock / CmdKPanel / topbar / rail-bar / cmdk-*）由 AppShell
 *   (main) 布局提供，本页仅渲染内容区；data-testid 与原型一致。
 * - 铁律（T15）：无 fixed / 100vh / 100vw，高度由 AppShell main（flex column + overflow auto）接管。
 */
import { useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AgentAvatar, AgentBadge } from "@/src/components/ui";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import {
  type RoleKey,
  neutral,
  roles,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 项目 ID：URL ?pid=，缺省 seed 项目 p_seed_1（对齐 task-board T12 模式） ------------------------------ */
const DEFAULT_PID = "p_seed_1";

function getProjectId(): string {
  if (typeof window === "undefined") return DEFAULT_PID;
  return new URLSearchParams(window.location.search).get("pid") || DEFAULT_PID;
}

/* ------------------------------ Agent 选择（勾选状态受控，初始对齐原型静态态：产品/开发已选，产品=主 Agent） ------------------------------ */
interface AgentOption {
  id: string;
  name: string;
  role: RoleKey;
  desc: string;
}

/** GET /agents 响应条目（T4：{items:[{id,name,role,type,prompt}]}） */
interface AgentItem {
  id: string;
  name: string;
  role: string;
  type: string;
  prompt: string | null;
}

interface AgentsResponse {
  items: AgentItem[];
  total: number;
}

/** 角色固定描述（原型文案，视觉唯一来源；Agent.prompt 缺失时兜底，避免截断变味） */
const FIXED_DESC: Record<RoleKey, string> = {
  product: "需求拆解与验收标准",
  architect: "技术方案与架构设计",
  developer: "编码实现与自测",
  tester: "用例设计与质量验收",
};

/** seed 模板 Agent 角色 → id 兜底（T14 预置 a_product/a_architect/a_developer/a_tester，API 未就绪时提交不中断） */
const ROLE_AGENT_ID: Record<RoleKey, string> = {
  product: "a_product",
  architect: "a_architect",
  developer: "a_developer",
  tester: "a_tester",
};

/** 初始勾选（与原型截图一致：产品经理、开发者已勾选） */
const INITIAL_CHECKED: RoleKey[] = ["product", "developer"];

/* ------------------------------ 背景文档（FR-17 上传入任务文档库：POST /uploads 真实上传 → {name, url} 列表） ------------------------------ */
/** 文件类型语义色（图标底色，独立于角色/状态色避免语义混淆，本地收拢不散落） */
const docTypeColors = { pdf: "#EF4444", csv: "#10B981", docx: "#3B82F6" } as const;

/** 未在语义色表内的扩展名兜底色（中性 slate，避免白底白字）。 */
const DEFAULT_DOC_COLOR = "#64748B";

/** POST /uploads 响应（server FileStorageService.describe：{url, name, size, ext}，size 为字节）。 */
interface UploadedFileMeta {
  url: string;
  name: string;
  size: number;
  ext: string;
}

/** 背景文档条目（仅由真实上传产生：POST /uploads 成功后入列表）。 */
interface BackgroundDoc {
  name: string;
  /** 可读文件大小（"868 KB"/"2.4 MB"，原型 mock 同格式）。 */
  size: string;
  /** 大写扩展名（图标角标文案，如 PDF/CSV/DOCX）。 */
  ext: string;
  /** 扩展名语义底色。 */
  color: string;
  /** /uploads/* 可访问 URL（提交任务时随 backgroundDocs 落库，供 Agent 拉取）。 */
  url: string;
}

/** 字节 → 可读大小（KB 取整、MB 一位小数，对齐原型 mockDocs 文案格式）。 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 扩展名（小写）→ 图标底色（命中语义色表用之，否则中性兜底）。 */
function colorOf(ext: string): string {
  return docTypeColors[ext as keyof typeof docTypeColors] ?? DEFAULT_DOC_COLOR;
}

/* ------------------------------ 「待开始」状态色（新状态未入共享 statusColors，本地收敛与琥珀同族） ------------------------------ */
const pendingColor = "#D97706";
const pendingBg = "#FFFBEB";
const pendingBorder = "#FDE68A";

/* ------------------------------ 优先级（低/中/高，默认选中「中」） ------------------------------ */
const priorities = ["低", "中", "高"] as const;
type Priority = (typeof priorities)[number];

/** 表单优先级（中文，原型文案）→ API 优先级（CreateTaskDto：high/medium/low） */
const PRIORITY_API: Record<Priority, string> = { 低: "low", 中: "medium", 高: "high" };

/* ================================ 左栏：任务表单 ================================ */
function TaskForm({
  title,
  onTitleChange,
  description,
  onDescriptionChange,
  priority,
  onPriorityChange,
  titleError,
  docs,
  onRemoveDoc,
  uploading,
  uploadError,
  onUploadFile,
  onDismissUploadError,
}: {
  title: string;
  onTitleChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  priority: Priority;
  onPriorityChange: (v: Priority) => void;
  titleError: string | null;
  docs: BackgroundDoc[];
  onRemoveDoc: (url: string) => void;
  uploading: boolean;
  uploadError: string | null;
  onUploadFile: (file: File) => void;
  onDismissUploadError: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fieldLabel: CSSProperties = {
    fontSize: fontSize.sm,
    fontWeight: 500,
    color: neutral[600],
    marginBottom: space.xs,
  };
  const inputBase: CSSProperties = {
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
  };
  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        padding: space.xl,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        ...baseFont,
      }}
    >
      {/* 卡片标题 */}
      <div>
        <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
          任务信息
        </div>
        <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
          描述任务目标，平台将按需组队并分派给对应 Agent。
        </div>
      </div>

      {/* 任务标题 */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label htmlFor="task-title-input" style={fieldLabel}>
          任务标题 <span style={{ color: "#DC2626" }}>*</span>
        </label>
        <input
          id="task-title-input"
          data-testid="task-title"
          type="text"
          placeholder="例如：智能报表模块开发"
          aria-label="任务标题"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          style={inputBase}
        />
        {/* 空标题校验（交互增强：与原型视觉语言一致——红色小字号提示） */}
        {titleError && (
          <div
            data-testid="title-error"
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.xs,
              marginTop: space.xs,
              fontSize: fontSize.sm,
              color: "#DC2626",
            }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {titleError}
          </div>
        )}
      </div>

      {/* 任务描述 */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label htmlFor="task-desc-input" style={fieldLabel}>
          任务描述
        </label>
        <textarea
          id="task-desc-input"
          data-testid="task-description"
          rows={6}
          placeholder="描述任务背景、目标与验收预期，Agent 将基于此展开协作…"
          aria-label="任务描述"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          style={{ ...inputBase, resize: "none", lineHeight: 1.6 }}
        />
      </div>

      {/* 背景文档上传（FR-17：POST /uploads 真实上传 → 文档入任务文档库供 Agent 查看） */}
      <div data-testid="doc-upload" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <label style={fieldLabel}>背景文档</label>

        {/* 上传入口：虚线框 + 上传图标 + 文案（点击触发隐藏 file input → POST /uploads） */}
        <button
          type="button"
          data-testid="doc-upload-btn"
          aria-label="上传背景文档"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: space.xs,
            padding: `${space.xl}px ${space.lg}px`,
            borderRadius: radius.md,
            border: `1.5px dashed ${neutral[300]}`,
            backgroundColor: neutral[50],
            color: neutral[500],
            cursor: uploading ? "default" : "pointer",
            opacity: uploading ? 0.7 : 1,
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.xl, lineHeight: 1, color: "#2563EB" }}>
            ↑
          </span>
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[600] }}>
            {uploading ? "上传中…" : "点击或拖拽上传背景文档"}
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            支持 PDF / Word / CSV，文件将沉淀到任务文档库供 Agent 查看
          </span>
        </button>

        {/* 隐藏文件选择（doc-upload-btn 触发；选中后 POST /uploads multipart，返回 {url,name,size,ext}） */}
        <input
          ref={fileInputRef}
          type="file"
          data-testid="doc-file-input"
          accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.gif,.md,.txt"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUploadFile(file);
            e.target.value = "";
          }}
          style={{ display: "none" }}
        />

        {/* 上传失败（接口错误，isApiError） */}
        {uploadError && (
          <div
            data-testid="doc-upload-error"
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              padding: `${space.md}px ${space.lg}px`,
              borderRadius: radius.md,
              backgroundColor: "#FEF2F2",
              border: "1px solid #FECACA",
              fontSize: fontSize.sm,
              color: "#B91C1C",
              lineHeight: 1.6,
            }}
          >
            <span aria-hidden style={{ flexShrink: 0 }}>!</span>
            <span style={{ flex: 1, minWidth: 0 }}>{uploadError}</span>
            <button
              type="button"
              data-testid="doc-upload-error-dismiss"
              aria-label="关闭上传错误提示"
              onClick={onDismissUploadError}
              style={{
                border: "none",
                background: "none",
                fontSize: fontSize.sm,
                color: neutral[400],
                cursor: "pointer",
                padding: space.xs,
                flexShrink: 0,
                fontFamily: fontFamily.body,
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* 已上传文件列表（真实上传 state 驱动，初始为空；仅渲染已存在文件） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {docs.map((doc) => (
            <div
              key={doc.url}
              data-testid="doc-file-item"
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.xs}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: radius.sm,
                  backgroundColor: doc.color,
                  color: "#FFFFFF",
                  fontSize: fontSize.xs,
                  fontWeight: 700,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {doc.ext}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: fontSize.md,
                  color: neutral[700],
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {doc.name}
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400], flexShrink: 0 }}>
                {doc.size}
              </span>
              <span
                role="button"
                data-testid="doc-file-remove"
                aria-label={`移除 ${doc.name}`}
                onClick={() => onRemoveDoc(doc.url)}
                style={{
                  fontSize: fontSize.sm,
                  color: neutral[400],
                  cursor: "pointer",
                  padding: space.xs,
                  flexShrink: 0,
                }}
              >
                ✕
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 优先级选择 */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label htmlFor="priority-select" style={fieldLabel}>
          优先级
        </label>
        <select
          id="priority-select"
          data-testid="priority-select"
          value={priority}
          onChange={(e) => onPriorityChange(e.target.value as Priority)}
          aria-label="优先级"
          style={{ ...inputBase, width: 200, cursor: "pointer" }}
        >
          {priorities.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {/* 提示条 */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: space.sm,
          padding: `${space.md}px ${space.lg}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[50],
          border: `1px solid ${neutral[200]}`,
          fontSize: fontSize.sm,
          color: neutral[500],
          lineHeight: 1.6,
        }}
      >
        <span aria-hidden style={{ color: "#2563EB", fontWeight: 700, lineHeight: 1.6 }}>
          i
        </span>
        任务创建后进入「待开始」状态；启动后群聊中仅被 @ 的 Agent 响应，产出物自动沉淀为任务文档。
      </div>
    </section>
  );
}

/* ================================ 右栏：Agent 选择区 ================================ */
function AgentOptionCard({
  role,
  desc,
  checked,
  isMain,
  onToggle,
}: {
  role: RoleKey;
  desc: string;
  checked: boolean;
  isMain: boolean;
  onToggle: () => void;
}) {
  const theme = roles[role];
  return (
    <div
      data-testid="agent-option"
      data-role={role}
      data-checked={checked ? "true" : "false"}
      role="checkbox"
      aria-checked={checked}
      aria-label={`${theme.label}${isMain ? "（主 Agent）" : ""}`}
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.md}px ${space.lg}px`,
        borderRadius: radius.md,
        backgroundColor: checked ? theme.bg : "#FFFFFF",
        border: `1px solid ${checked ? theme.border : neutral[200]}`,
        boxShadow: checked ? shadow.sm : undefined,
        cursor: "pointer",
        transition: "border-color .15s ease, background-color .15s ease",
      }}
    >
      <AgentAvatar role={role} size="md" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          <div
            style={{
              fontSize: fontSize.md,
              fontWeight: 600,
              color: neutral[800],
              whiteSpace: "nowrap",
            }}
          >
            {theme.label}
          </div>
          {/* 主 Agent（任务负责人）徽章：多选时须指定，默认产品经理（FR-19）；颜色跟随主 Agent 角色 */}
          {isMain ? (
            <span
              data-testid="main-agent-tag"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                padding: "1px 7px",
                borderRadius: radius.pill,
                backgroundColor: theme.color,
                color: "#FFFFFF",
                fontSize: fontSize.xs,
                fontWeight: 600,
                lineHeight: "16px",
                flexShrink: 0,
              }}
            >
              ★ 主 Agent
            </span>
          ) : null}
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
          {desc}
        </div>
      </div>
      {/* 勾选框 */}
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          borderRadius: radius.sm,
          border: `1.5px solid ${checked ? theme.color : neutral[300]}`,
          backgroundColor: checked ? theme.color : "#FFFFFF",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#FFFFFF",
          fontSize: fontSize.sm,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {checked ? "✓" : ""}
      </span>
    </div>
  );
}

function AgentSelectPanel({
  agentOptions,
  agentsLoading,
  agentsError,
  onRetryAgents,
  checkedAgents,
  mainAgent,
  onToggleAgent,
  submitting,
  created,
  createError,
  onCreate,
}: {
  agentOptions: AgentOption[];
  agentsLoading: boolean;
  agentsError: boolean;
  onRetryAgents: () => void;
  checkedAgents: RoleKey[];
  mainAgent: RoleKey;
  onToggleAgent: (role: RoleKey) => void;
  submitting: boolean;
  created: boolean;
  createError: string | null;
  onCreate: () => void;
}) {
  return (
    <section
      style={{
        width: 300,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        ...baseFont,
      }}
    >
      {/* Agent 选择区 */}
      <div
        style={{
          padding: space.xl,
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.sm,
          display: "flex",
          flexDirection: "column",
          gap: space.md,
        }}
      >
        <div>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
            选择协作 Agent
          </div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs, lineHeight: 1.6 }}>
            勾选参与任务的角色，可多选。多选时需指定{" "}
            <span style={{ fontWeight: 600, color: neutral[600] }}>主 Agent</span>{" "}
            作为任务负责人；简单任务可单选一个 Agent。
          </div>
        </div>
        {agentsLoading ? (
          <div data-testid="agents-loading" style={{ fontSize: fontSize.sm, color: neutral[400] }}>
            加载中…
          </div>
        ) : agentsError ? (
          <div
            data-testid="agents-error"
            role="alert"
            style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: space.sm }}
          >
            <div style={{ fontSize: fontSize.sm, color: "#DC2626" }}>Agent 列表加载失败</div>
            <button
              type="button"
              data-testid="agents-retry"
              onClick={onRetryAgents}
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
        ) : (
          agentOptions.map((option) => (
            <AgentOptionCard
              key={option.id}
              role={option.role}
              desc={option.desc}
              checked={checkedAgents.includes(option.role)}
              isMain={option.role === mainAgent}
              onToggle={() => onToggleAgent(option.role)}
            />
          ))
        )}
      </div>

      {/* 已选 Agent 列表 */}
      <div
        data-testid="selected-agents"
        style={{
          padding: space.xl,
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.sm,
          display: "flex",
          flexDirection: "column",
          gap: space.md,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: fontSize.md,
            fontWeight: 600,
            color: neutral[700],
          }}
        >
          <span>已选 Agent</span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400], fontWeight: 400 }}>
            {checkedAgents.length} 个
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: space.sm }}>
          {checkedAgents.map((role) => (
            <AgentBadge key={role} role={role} />
          ))}
        </div>
      </div>

      {/* 创建按钮 */}
      <button
        type="button"
        data-testid="create-task-button"
        disabled={submitting}
        onClick={onCreate}
        style={{
          width: "100%",
          padding: `${space.md + 2}px ${space.lg}px`,
          borderRadius: radius.md,
          border: "none",
          backgroundColor: "#2563EB",
          color: "#FFFFFF",
          fontSize: fontSize.lg,
          fontWeight: 600,
          cursor: submitting ? "default" : "pointer",
          opacity: submitting ? 0.7 : 1,
          boxShadow: "0 6px 16px rgba(37,99,235,.3)",
          fontFamily: fontFamily.body,
        }}
      >
        {submitting ? "创建中…" : "创建任务"}
      </button>

      {/* 创建结果：真实提交成功（随后跳转任务详情） */}
      {created && (
        <div
          data-testid="create-success"
          role="status"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.xs,
            alignItems: "flex-start",
            padding: `${space.md}px ${space.lg}px`,
            borderRadius: radius.md,
            backgroundColor: "#ECFDF5",
            border: `1px solid #A7F3D0`,
            fontSize: fontSize.sm,
            color: "#065F46",
            lineHeight: 1.6,
          }}
        >
          <span style={{ fontWeight: 600 }}>✓ 任务已创建</span>
          <span>进入「待开始」状态，确认团队后点击「开始任务」正式启动。</span>
        </div>
      )}

      {/* 创建失败：真实接口错误（isApiError） */}
      {createError && (
        <div
          data-testid="create-error"
          role="alert"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: space.xs,
            padding: `${space.md}px ${space.lg}px`,
            borderRadius: radius.md,
            backgroundColor: "#FEF2F2",
            border: "1px solid #FECACA",
            fontSize: fontSize.sm,
            color: "#B91C1C",
            lineHeight: 1.6,
          }}
        >
          <span aria-hidden style={{ fontWeight: 700 }}>!</span>
          {createError}
        </div>
      )}

      {/* 创建后提示：任务进入「待开始」，确认团队后点击开始（FR-18） */}
      <div
        data-testid="create-hint"
        role="note"
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: space.sm,
          padding: `${space.md}px ${space.lg}px`,
          borderRadius: radius.md,
          backgroundColor: pendingBg,
          border: `1px solid ${pendingBorder}`,
          fontSize: fontSize.sm,
          color: neutral[600],
          lineHeight: 1.6,
        }}
      >
        <span aria-hidden style={{ color: pendingColor, fontWeight: 700, lineHeight: 1.6 }}>
          ⏱
        </span>
        <span>
          任务进入<span style={{ fontWeight: 600, color: pendingColor }}>「待开始」</span>
          状态，确认团队后点击「开始任务」正式启动。
        </span>
      </div>
    </section>
  );
}

/* ================================ 页面（AppShell 内容区） ================================ */
export default function TaskCreatePage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("中");

  // 背景文档：真实上传列表（POST /uploads 成功后入列，禁止预置假数据）
  const [backgroundDocs, setBackgroundDocs] = useState<BackgroundDoc[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // 上传：POST /uploads multipart（file 字段）→ {url,name,size,ext} → 加入背景文档列表
  const uploadMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.post<UploadedFileMeta>("/uploads", fd);
    },
    onSuccess: (meta) => {
      setBackgroundDocs((prev) => [
        ...prev,
        {
          name: meta.name,
          size: formatFileSize(meta.size),
          ext: meta.ext.toUpperCase(),
          color: colorOf(meta.ext),
          url: meta.url,
        },
      ]);
    },
    onError: (err) =>
      setUploadError(isApiError(err) ? err.message : "文档上传失败，请稍后重试"),
  });

  // Agent 选择：勾选集合 + 主 Agent（默认产品经理，FR-19）
  const [checkedAgents, setCheckedAgents] = useState<RoleKey[]>(INITIAL_CHECKED);
  const [mainAgent, setMainAgent] = useState<RoleKey>("product");

  // 提交状态
  const [titleError, setTitleError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Agent 数据源：GET /agents（T4），role 与 data-role 一一对应（product/architect/developer/tester）
  const {
    data: agentsData,
    isPending: agentsLoading,
    isError: agentsError,
    refetch: refetchAgents,
  } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<AgentsResponse>("/agents"),
    enabled: !!user?.id,
  });
  const agentOptions: AgentOption[] = (agentsData?.items ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role as RoleKey,
    desc: FIXED_DESC[a.role as RoleKey] ?? a.prompt?.slice(0, 30) ?? "",
  }));

  /** 勾选切换：同步 checkedAgents；主 Agent 保持有效（取消当前主 Agent → 转移第一个勾选） */
  const handleToggleAgent = (role: RoleKey) => {
    setCheckedAgents((prev) => {
      let next: RoleKey[];
      if (prev.includes(role)) {
        next = prev.filter((r) => r !== role);
      } else {
        next = [...prev, role];
      }
      // 主 Agent 跟随：当前主 Agent 被取消或集合为空时转移
      if (!next.includes(mainAgent)) {
        setMainAgent(next[0] ?? role);
      }
      return next;
    });
  };

  /** 移除背景文档（按 url 唯一标识，同名文件互不干扰；仅影响本次创建提交） */
  const handleRemoveDoc = (url: string) => {
    setBackgroundDocs((prev) => prev.filter((d) => d.url !== url));
  };

  /** 创建任务：空标题校验 → 真实 POST /projects/:pid/tasks，成功跳转任务详情，失败展示接口错误 */
  const handleCreate = async () => {
    if (!title.trim()) {
      setTitleError("请输入任务标题");
      return;
    }
    setTitleError(null);
    setSubmitting(true);
    setCreateError(null);
    try {
      // 角色 → 真实 Agent id（优先 API 返回，兜底 seed 预置 id）
      const roleToId = new Map(agentOptions.map((o) => [o.role, o.id]));
      const toAgentId = (role: RoleKey): string =>
        roleToId.get(role) ?? ROLE_AGENT_ID[role];
      const res = await api.post<{ id: string }>(
        `/projects/${getProjectId()}/tasks`,
        {
          title: title.trim(),
          description: description || undefined,
          priority: PRIORITY_API[priority],
          agentIds: checkedAgents.map(toAgentId),
          mainAgentId: toAgentId(mainAgent),
          backgroundDocs: backgroundDocs.map((d) => ({ name: d.name, url: d.url })),
        }
      );
      setCreated(true);
      // 真实成功 → 跳转任务详情（T13 路由，先跳转即可）
      router.push(`/tasks/${res.id}`);
    } catch (err) {
      setCreateError(isApiError(err) ? err.message : "创建任务失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="task-create-root"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[100],
        ...baseFont,
      }}
    >
      {/* 内容区：左右两栏（表单 + Agent 选择），纵向可滚动 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`,
          display: "flex",
          gap: space.xl,
          alignItems: "flex-start",
        }}
      >
        <TaskForm
          title={title}
          onTitleChange={setTitle}
          description={description}
          onDescriptionChange={setDescription}
          priority={priority}
          onPriorityChange={setPriority}
          titleError={titleError}
          docs={backgroundDocs}
          onRemoveDoc={handleRemoveDoc}
          uploading={uploadMutation.isPending}
          uploadError={uploadError}
          onUploadFile={(file) => {
            setUploadError(null);
            uploadMutation.mutate(file);
          }}
          onDismissUploadError={() => setUploadError(null)}
        />
        <AgentSelectPanel
          agentOptions={agentOptions}
          agentsLoading={agentsLoading}
          agentsError={agentsError}
          onRetryAgents={() => refetchAgents()}
          checkedAgents={checkedAgents}
          mainAgent={mainAgent}
          onToggleAgent={handleToggleAgent}
          submitting={submitting}
          created={created}
          createError={createError}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}