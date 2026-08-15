"use client";

/**
 * 任务创建页（Task 13 保真迁移）
 * =============================================
 * 唯一来源：docs/agent-platform/prototypes/task-create/index.tsx（device: desktop）。
 * - 左栏任务表单：标题* / 描述 / 背景文档上传（真实文件列表，初始为空）/ 优先级（低/中/高）+「待开始」提示条，对应 FR-01/FR-07。
 * - 右栏 Agent 选择（T5 实例化）：角色卡片 = 实例列表 + 添加按钮（同一角色可多实例，
 *   默认别名 <角色中文名>-<seq>，行内可改名/移除）+ 主 Agent 下拉（默认项目经理，决策 1）
 *   + 已选实例徽章 + 创建按钮 + create-hint。
 * - 交互增强（原型为静态勾选，本页实现联动）：
 *   · 启用/停用角色（勾选切换）、添加实例（seq 自动递增）、行内改名、移除实例；
 *   · 主 Agent 保持有效：移除/停用当前主实例 → 自动转移（优先级：项目经理 → 产品 → 其余角色）；
 *   · 创建按钮校验空标题（红色提示，与原型视觉语言一致），再提交。
 * - 提交：真实 POST /api/v1/projects/:pid/tasks（pid 取 URL ?pid=，缺省 seed 项目 p_seed_1）。
 *   成功 → router.push(/tasks/:id) 跳转任务详情（T13 路由）；失败 → isApiError 展示错误（09 篇 §3.4 契约）。
 * - 融合导航（NavTopBar / NavDock / CmdKPanel / topbar / rail-bar / cmdk-*）由 AppShell
 *   (main) 布局提供，本页仅渲染内容区；data-testid 与原型一致。
 * - 铁律（T15）：无 fixed / 100vh / 100vw，高度由 AppShell main（flex column + overflow auto）接管。
 */
import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AgentAvatar } from "@/src/components/ui";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
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
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 项目 ID：URL ?pid=，缺省 seed 项目 p_seed_1（对齐 task-board T12 模式） ------------------------------ */
const DEFAULT_PID = "p_seed_1";

function getProjectId(): string {
  if (typeof window === "undefined") return DEFAULT_PID;
  return new URLSearchParams(window.location.search).get("pid") || DEFAULT_PID;
}

/* ------------------------------ Agent 选择（T5 实例列表：角色 → 实例，初始 项目经理+开发者 各 1 实例，主 Agent=项目经理） ------------------------------ */
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
  project_manager: "项目组织与进度推进",
  architect: "技术方案与架构设计",
  developer: "编码实现与自测",
  tester: "用例设计与质量验收",
};

/** seed 模板 Agent 角色 → id 兜底（T14 预置 a_product/a_project_manager/a_architect/a_developer/a_tester，API 未就绪时提交不中断） */
const ROLE_AGENT_ID: Record<RoleKey, string> = {
  product: "a_product",
  project_manager: "a_project_manager",
  architect: "a_architect",
  developer: "a_developer",
  tester: "a_tester",
};

/** 初始启用角色（决策 1：默认主 Agent=项目经理；项目经理+开发者各预置 1 实例） */
const INITIAL_ROLES: RoleKey[] = ["project_manager", "developer"];

/** 主实例转移优先级（FR-19 保留语义：项目经理 → 产品 → 其余角色） */
const MAIN_TRANSFER_ORDER: RoleKey[] = ["project_manager", "product", "architect", "developer", "tester"];

/** 角色展示顺序（卡片渲染/提交 agents 顺序一致，实例按序聚合） */
const ROLE_ORDER: RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];

/**
 * 实例草稿（T5 角色/实例分离）：
 * - key：本地临时唯一标识（实例 id 由服务端生成，创建前不可知）
 * - agentId：模板 agent id（seed 预置兜底，提交时用 GET /agents 返回覆盖）
 * - alias：实例别名（默认 `<角色中文名>-<seq>`，行内可改名）
 * - seq：同角色内序号（服务端生成逻辑同步：该 agent 已用最大 seq + 1）
 */
interface InstanceDraft {
  key: string;
  agentId: string;
  alias: string;
  seq: number;
  /** is_0000000010：实例独立持久化工作目录（缺省 `/data/worker/<sanitize(agent名称)>`，可改）。 */
  workDir: string;
  /** 所属角色（展平后主题色/徽章/提交聚合用）。 */
  roleKey: RoleKey;
}

/** 角色 → 实例列表（仅含已启用角色；同角色多实例 = 多开发者等） */
type InstancesByRole = Partial<Record<RoleKey, InstanceDraft[]>>;

/** 默认别名（与后端 seq 生成规则一致：<角色中文名>-<seq>） */
function defaultAliasOf(role: RoleKey, seq: number): string {
  return `${roles[role].label}-${seq}`;
}

/** is_0000000010：默认持久化工作目录 `/data/worker/<角色名>[-seq]`（对齐后端 sanitize 规则，
 *  仅作前端预填展示；提交时未改动则不传，由服务端按 agent 名称解析）。 */
function defaultWorkDirOf(role: RoleKey, seq: number): string {
  return seq > 1 ? `/data/worker/${roles[role].label}-${seq}` : `/data/worker/${roles[role].label}`;
}

/** 展平全部实例（按角色顺序）。 */
function allInstancesOf(instancesByRole: InstancesByRole): InstanceDraft[] {
  return ROLE_ORDER.flatMap((role) => instancesByRole[role] ?? []);
}

/** 实例所在角色（未找到返回 null）。 */
function findRoleOf(instancesByRole: InstancesByRole, key: string): RoleKey | null {
  for (const role of ROLE_ORDER) {
    if ((instancesByRole[role] ?? []).some((i) => i.key === key)) return role;
  }
  return null;
}

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
  managedMode,
  onManagedModeChange,
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
  managedMode: boolean;
  onManagedModeChange: (v: boolean) => void;
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

      {/* 托管模式开关：开启后成员 question/permission 请求由主 Agent 确认（不弹窗给用户） */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
          <span
            role="switch"
            aria-checked={managedMode}
            data-testid="managed-mode-toggle"
            onClick={() => onManagedModeChange(!managedMode)}
            style={{
              width: 40,
              height: 22,
              borderRadius: 11,
              border: "none",
              backgroundColor: managedMode ? "#2563EB" : neutral[300],
              position: "relative",
              flexShrink: 0,
              cursor: "pointer",
              transition: "background-color .2s",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: managedMode ? 20 : 2,
                width: 18,
                height: 18,
                borderRadius: "50%",
                backgroundColor: "#FFFFFF",
                transition: "left .2s",
                boxShadow: shadow.sm,
              }}
            />
          </span>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <label htmlFor="managed-mode-toggle" style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800], cursor: "pointer" }}>
              托管模式
            </label>
            <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>
              开启后，成员提问/权限请求由主 Agent 确认，不再弹窗打扰
            </span>
          </div>
        </div>
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

/* ================================ 右栏：Agent 选择区（T5 实例化：角色卡片 → 实例列表） ================================ */
function RoleInstanceCard({
  role,
  instances,
  mainKey,
  onToggleRole,
  onAddInstance,
  onRenameInstance,
  onWorkDirChange,
  onRemoveInstance,
  onSetMain,
}: {
  role: RoleKey;
  instances: InstanceDraft[];
  mainKey: string | null;
  onToggleRole: (role: RoleKey) => void;
  onAddInstance: (role: RoleKey) => void;
  onRenameInstance: (key: string, alias: string) => void;
  onWorkDirChange: (key: string, workDir: string) => void;
  onRemoveInstance: (key: string) => void;
  onSetMain: (key: string) => void;
}) {
  // 防御：role 非法/缺失时兜底 developer 主题（roles[非法] undefined → theme.label 崩溃）
  const theme = roles[role] ?? roles.developer;
  const enabled = instances.length > 0;
  return (
    <div
      data-testid="role-card"
      data-role={role}
      data-enabled={enabled ? "true" : "false"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        padding: `${space.md}px ${space.lg}px`,
        borderRadius: radius.md,
        backgroundColor: enabled ? theme.bg : "#FFFFFF",
        border: `1px solid ${enabled ? theme.border : neutral[200]}`,
        boxShadow: enabled ? shadow.sm : undefined,
        transition: "border-color .15s ease, background-color .15s ease",
      }}
    >
      {/* 卡片头部：角色名 + 启用勾选 + 描述 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
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
            <span
              style={{
                fontSize: fontSize.xs,
                color: neutral[400],
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
                borderRadius: radius.pill,
                padding: "1px 8px",
                whiteSpace: "nowrap",
              }}
            >
              {enabled ? `${instances.length} 个实例` : "未启用"}
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
            {FIXED_DESC[role]}
          </div>
        </div>
        {/* 启用/停用勾选（取消勾选 = 移除该角色全部实例；主实例在其中则自动转移） */}
        <span
          role="checkbox"
          aria-checked={enabled}
          aria-label={`${enabled ? "停用" : "启用"}${theme.label}`}
          data-testid="role-toggle"
          onClick={() => onToggleRole(role)}
          style={{
            width: 20,
            height: 20,
            borderRadius: radius.sm,
            border: `1.5px solid ${enabled ? theme.color : neutral[300]}`,
            backgroundColor: enabled ? theme.color : "#FFFFFF",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#FFFFFF",
            fontSize: fontSize.sm,
            fontWeight: 700,
            flexShrink: 0,
            cursor: "pointer",
          }}
        >
          {enabled ? "✓" : ""}
        </span>
      </div>

      {/* 实例列表：每实例一行（角色色点 + 别名 input + 序号 + 主标记 + 移除） */}
      {enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {instances.map((inst) => {
            const isMain = inst.key === mainKey;
            return (
              <div
                key={inst.key}
                data-testid="instance-row"
                data-instance-key={inst.key}
                data-main={isMain ? "true" : "false"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.sm,
                  padding: `${space.xs}px ${space.sm}px`,
                  borderRadius: radius.md,
                  backgroundColor: "#FFFFFF",
                  border: `1px solid ${isMain ? theme.border : neutral[200]}`,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: theme.color,
                    flexShrink: 0,
                  }}
                />
                <input
                  data-testid="instance-alias-input"
                  value={inst.alias}
                  aria-label={`${theme.label}实例 ${inst.seq} 别名`}
                  onChange={(e) => onRenameInstance(inst.key, e.target.value)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontSize: fontSize.md,
                    fontWeight: 500,
                    color: neutral[800],
                    fontFamily: fontFamily.body,
                    padding: `${space.xs}px 0`,
                  }}
                />
                <input
                  data-testid="instance-workdir-input"
                  value={inst.workDir}
                  aria-label={`${theme.label}实例 ${inst.seq} 工作目录`}
                  onChange={(e) => onWorkDirChange(inst.key, e.target.value)}
                  placeholder="/data/worker/<agent名称>"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontSize: fontSize.xs,
                    color: neutral[500],
                    fontFamily: fontFamily.mono ?? fontFamily.body,
                    padding: `${space.xs}px 0`,
                  }}
                />
                <span style={{ fontSize: fontSize.xs, color: neutral[400], flexShrink: 0 }}>#{inst.seq}</span>
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
                ) : (
                  <button
                    type="button"
                    data-testid="instance-set-main"
                    aria-label={`设 ${inst.alias} 为主 Agent`}
                    onClick={() => onSetMain(inst.key)}
                    style={{
                      border: "none",
                      background: "none",
                      fontSize: fontSize.sm,
                      color: neutral[300],
                      cursor: "pointer",
                      padding: space.xs,
                      flexShrink: 0,
                      fontFamily: fontFamily.body,
                    }}
                  >
                    ☆
                  </button>
                )}
                <button
                  type="button"
                  data-testid="instance-remove"
                  aria-label={`移除 ${inst.alias}`}
                  onClick={() => onRemoveInstance(inst.key)}
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
            );
          })}
        </div>
      )}

      {/* 添加实例：虚线按钮（对齐 doc-upload-btn 视觉语言：1.5px dashed） */}
      <button
        type="button"
        data-testid="add-instance-btn"
        aria-label={`添加${theme.label}实例`}
        onClick={() => onAddInstance(role)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: space.xs,
          padding: `${space.sm - 1}px ${space.md}px`,
          borderRadius: radius.md,
          border: `1.5px dashed ${theme.border}`,
          backgroundColor: "rgba(255,255,255,.6)",
          color: theme.color,
          fontSize: fontSize.sm,
          fontWeight: 500,
          cursor: "pointer",
          fontFamily: fontFamily.body,
        }}
      >
        <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>＋</span>
        添加{theme.label}实例
      </button>
    </div>
  );
}

function AgentSelectPanel({
  agentsLoading,
  agentsError,
  onRetryAgents,
  instancesByRole,
  mainKey,
  mainRole,
  allInstances,
  onToggleRole,
  onAddInstance,
  onRenameInstance,
  onWorkDirChange,
  onRemoveInstance,
  onSetMain,
  onSelectMain,
  submitting,
  created,
  createError,
  onCreate,
}: {
  agentsLoading: boolean;
  agentsError: boolean;
  onRetryAgents: () => void;
  instancesByRole: InstancesByRole;
  mainKey: string | null;
  mainRole: RoleKey | null;
  allInstances: InstanceDraft[];
  onToggleRole: (role: RoleKey) => void;
  onAddInstance: (role: RoleKey) => void;
  onRenameInstance: (key: string, alias: string) => void;
  onWorkDirChange: (key: string, workDir: string) => void;
  onRemoveInstance: (key: string) => void;
  onSetMain: (key: string) => void;
  onSelectMain: (key: string) => void;
  submitting: boolean;
  created: boolean;
  createError: string | null;
  onCreate: () => void;
}) {
  const mainTheme = mainRole ? roles[mainRole] ?? roles.developer : null;
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
            同一角色可添加多个实例（如 开发者-1 / 开发者-2）。多选时需指定{" "}
            <span style={{ fontWeight: 600, color: neutral[600] }}>主 Agent</span>{" "}
            作为任务负责人；简单任务可只启用一个角色。
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
          ROLE_ORDER.map((role) => (
            <RoleInstanceCard
              key={role}
              role={role}
              instances={instancesByRole[role] ?? []}
              mainKey={mainKey}
              onToggleRole={onToggleRole}
              onAddInstance={onAddInstance}
              onRenameInstance={onRenameInstance}
              onWorkDirChange={onWorkDirChange}
              onRemoveInstance={onRemoveInstance}
              onSetMain={onSetMain}
            />
          ))
        )}
      </div>

      {/* 主 Agent 选择：从实例列表选择（显示实例别名+角色） */}
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
        <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>主 Agent</div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5 }}>
          默认项目经理；任务负责人将承担主 Agent 职责（启动后注入职责指令）。
        </div>
        <select
          data-testid="main-agent-select"
          value={mainKey ?? ""}
          disabled={allInstances.length === 0}
          onChange={(e) => onSelectMain(e.target.value)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: `${space.md}px ${space.lg}px`,
            borderRadius: radius.md,
            border: `1px solid ${mainTheme ? mainTheme.border : neutral[200]}`,
            backgroundColor: mainTheme ? mainTheme.bg : "#FFFFFF",
            color: neutral[800],
            fontSize: fontSize.md,
            fontWeight: 500,
            outline: "none",
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          {allInstances.length === 0 && <option value="">未启用角色</option>}
          {allInstances.map((inst) => {
            const theme = roles[inst.roleKey] ?? roles.developer;
            return (
              <option key={inst.key} value={inst.key}>
                {inst.alias}（{theme.label}）
              </option>
            );
          })}
        </select>
      </div>

      {/* 已选实例列表 */}
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
          <span>已选实例</span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400], fontWeight: 400 }}>
            {allInstances.length} 个
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: space.sm }}>
          {allInstances.map((inst) => {
            const theme = roles[inst.roleKey] ?? roles.developer;
            const isMain = inst.key === mainKey;
            return (
              <span
                key={inst.key}
                data-testid="selected-instance"
                data-main={isMain ? "true" : "false"}
                title={isMain ? `${inst.alias}（主 Agent）` : inst.alias}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: space.xs,
                  padding: `${space.xs - 1}px ${space.sm}px`,
                  borderRadius: radius.pill,
                  backgroundColor: theme.bg,
                  border: `1px solid ${theme.border}`,
                  color: roleText[inst.roleKey] ?? roleText.developer,
                  fontSize: fontSize.sm,
                  fontWeight: 500,
                  lineHeight: 1.4,
                  whiteSpace: "nowrap",
                  fontFamily: fontFamily.body,
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
                {inst.alias}
                {isMain && <span aria-hidden>★</span>}
              </span>
            );
          })}
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
  const [managedMode, setManagedMode] = useState(false);

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

  // Agent 选择（T5 实例化）：角色 → 实例列表 + 主实例 key。
  // 初始状态（决策 1）：项目经理 + 开发者各 1 实例，主 Agent = 项目经理实例。
  const [instancesByRole, setInstancesByRole] = useState<InstancesByRole>(() => {
    const initial: InstancesByRole = {};
    for (const role of INITIAL_ROLES) {
      initial[role] = [
        {
          key: `inst-${role}-1`,
          agentId: ROLE_AGENT_ID[role],
          alias: defaultAliasOf(role, 1),
          workDir: defaultWorkDirOf(role, 1),
          seq: 1,
          roleKey: role,
        },
      ];
    }
    return initial;
  });
  const [mainKey, setMainKey] = useState<string | null>("inst-project_manager-1");

  /** 本地临时 key 自增器（实例 id 服务端生成，前端仅需本地唯一） */
  const keySeqRef = useRef(10);
  const nextKey = () => `inst-local-${keySeqRef.current++}`;

  /** 全部实例（按角色展示顺序聚合；提交顺序/主 Agent 下拉/已选徽章共用） */
  const allInstances: InstanceDraft[] = useMemo(
    () => ROLE_ORDER.flatMap((role) => instancesByRole[role] ?? []),
    [instancesByRole],
  );
  /** 主实例（未设置时 null） */
  const mainInstance = useMemo(
    () => allInstances.find((i) => i.key === mainKey) ?? null,
    [allInstances, mainKey],
  );

  /** 主实例转移（FR-19 保留）：按优先级 项目经理 → 产品 → 其余角色，取第一个剩余实例 */
  const transferMainKey = useCallback(
    (rolesByKey: InstancesByRole, excludeKey?: string): string | null => {
      for (const role of MAIN_TRANSFER_ORDER) {
        const insts = rolesByKey[role];
        if (insts && insts.length > 0) {
          const first = insts.find((i) => i.key !== excludeKey) ?? insts[0];
          if (first) return first.key;
        }
      }
      return null;
    },
    [],
  );

  /** 启用/停用角色：停用 = 移除该角色全部实例；主实例在其中 → 自动转移 */
  const handleToggleRole = (role: RoleKey) => {
    setInstancesByRole((prev) => {
      const enabled = (prev[role] ?? []).length > 0;
      const next: InstancesByRole = enabled
        ? { ...prev, [role]: [] }
        : {
            ...prev,
            [role]: [
              {
                key: nextKey(),
                agentId: ROLE_AGENT_ID[role],
                alias: defaultAliasOf(role, 1),
                workDir: defaultWorkDirOf(role, 1),
                seq: 1,
                roleKey: role,
              },
            ],
          };
      // 停用导致主实例消失 → 按优先级转移
      if (mainKey && !allInstancesOf(next).some((i) => i.key === mainKey)) {
        setMainKey(transferMainKey(next));
      }
      return next;
    });
  };

  /** 添加实例：seq = 该角色已用最大 seq + 1，默认别名 <角色中文名>-<seq> */
  const handleAddInstance = (role: RoleKey) => {
    setInstancesByRole((prev) => {
      const list = prev[role] ?? [];
      const maxSeq = list.reduce((m, i) => Math.max(m, i.seq), 0);
      const seq = maxSeq + 1;
      return {
        ...prev,
        [role]: [
          ...list,
          {
            key: nextKey(),
            agentId: ROLE_AGENT_ID[role],
            alias: defaultAliasOf(role, seq),
            workDir: defaultWorkDirOf(role, seq),
            seq,
            roleKey: role,
          },
        ],
      };
    });
  };

  /** 行内改名（alias 输入受控） */
  const handleRenameInstance = (key: string, alias: string) => {
    setInstancesByRole((prev) => {
      const role = findRoleOf(prev, key);
      if (!role) return prev;
      return {
        ...prev,
        [role]: (prev[role] ?? []).map((i) => (i.key === key ? { ...i, alias } : i)),
      };
    });
  };

  /** is_0000000010：行内修改工作目录（workDir 输入受控） */
  const handleWorkDirChange = (key: string, workDir: string) => {
    setInstancesByRole((prev) => {
      const role = findRoleOf(prev, key);
      if (!role) return prev;
      return {
        ...prev,
        [role]: (prev[role] ?? []).map((i) => (i.key === key ? { ...i, workDir } : i)),
      };
    });
  };

  /** 移除实例：主实例被移除 → 自动转移（优先级 project_manager → product → 其余） */
  const handleRemoveInstance = (key: string) => {
    setInstancesByRole((prev) => {
      const role = findRoleOf(prev, key);
      if (!role) return prev;
      const next = { ...prev, [role]: (prev[role] ?? []).filter((i) => i.key !== key) };
      if (key === mainKey) setMainKey(transferMainKey(next, key));
      return next;
    });
  };

  /** 设为主实例（行内 ☆ 或下拉） */
  const handleSetMain = (key: string) => {
    if (allInstances.some((i) => i.key === key)) setMainKey(key);
  };

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
          // T5 实例化契约：agents 可重复 agentId（=多实例）；alias 仅显式改名时提交（服务端缺省生成）
          agents: allInstances.map((inst) => ({
            agentId: toAgentId(inst.roleKey),
            ...(inst.alias !== defaultAliasOf(inst.roleKey, inst.seq)
              ? { alias: inst.alias }
              : {}),
            // is_0000000010：workDir 仅显式修改时提交（缺省由服务端解析 /data/worker/<agent名称>）
            ...(inst.workDir.trim() !== defaultWorkDirOf(inst.roleKey, inst.seq)
              ? { workDir: inst.workDir.trim() }
              : {}),
          })),
          // 主实例：实例 id 由服务端生成，前端无法预知——传 mainAgentId 由服务端映射该 agent 第一实例
          //（决策 1：默认主 Agent=项目经理；用户改主实例别名不影响——按 agent 映射）
          mainAgentId: mainInstance ? toAgentId(mainInstance.roleKey) : undefined,
          backgroundDocs: backgroundDocs.map((d) => ({ name: d.name, url: d.url })),
          // 托管模式：开启后成员 question/permission 请求改由主 Agent 确认（不弹窗给用户）
          managedMode,
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
          managedMode={managedMode}
          onManagedModeChange={setManagedMode}
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
          agentsLoading={agentsLoading}
          agentsError={agentsError}
          onRetryAgents={() => refetchAgents()}
          instancesByRole={instancesByRole}
          mainKey={mainKey}
          mainRole={mainInstance?.roleKey ?? null}
          allInstances={allInstances}
          onToggleRole={handleToggleRole}
          onAddInstance={handleAddInstance}
          onRenameInstance={handleRenameInstance}
          onWorkDirChange={handleWorkDirChange}
          onRemoveInstance={handleRemoveInstance}
          onSetMain={handleSetMain}
          onSelectMain={handleSetMain}
          submitting={submitting}
          created={created}
          createError={createError}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}