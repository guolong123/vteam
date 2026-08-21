"use client";

/**
 * 项目列表页（Task 12：原型保真迁移 + 真实数据接入）
 * =====================================================
 * 保真迁移自 docs/agent-platform/prototypes/project-list/index.tsx（卡片布局/间距/文案/空态/data-testid 零改动）。
 * - 导航由 AppShell（app/(main)/layout.tsx）提供（NavTopBar + NavDock + CmdKPanel），本页仅渲染内容区。
 * - 接入真实数据：GET /api/v1/projects（Task 17）→ TanStack Query 渲染列表。
 * - 新建项目弹窗 → POST /api/v1/projects → 成功后 invalidateQueries 刷新列表。
 * - 空态：EmptyState 组件（Task 9），与平台视觉语言一致。
 * - 认证适配：projects 端点依赖全局 JwtAuthGuard，api.ts 自动注入 Bearer token；
 *   不再透传 x-user-id（PlaceholderAuthGuard 占位守卫已清理）。
 */
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { AgentAvatar, EmptyState, StatusBadge } from "@/src/components/ui";
import type { RoleKey, StatusKey } from "@/src/theme/tokens";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

/** GET /projects 响应条目（对齐 09 篇 §3.3 / Task 17 service 返回结构）。 */
interface Project {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  /** active | archived */
  status: string;
  /** 当前调用者在此项目的成员角色：owner | member */
  role: string;
  /** 该项目下任务数（FR-25：后端 _count 关联统计） */
  taskCount: number;
  /** 已完成任务数（completed + archived，MOCK-04 后端聚合） */
  completedTaskCount: number;
  /** 项目 Agent 成员（任务团队未移除去重，MOCK-04） */
  agentMembers: ProjectAgentMember[];
  createdAt: string;
  updatedAt: string;
}

/** GET /projects agentMembers 条目（附角色供头像渲染）。 */
interface ProjectAgentMember {
  agentId: string;
  name: string | null;
  role: string | null;
}

/** GET /projects 分页响应（对齐 09 篇 §2 分页契约）。 */
interface ProjectsResponse {
  items: Project[];
  total: number;
  page: number;
  pageSize: number;
}

/** POST /projects 请求体（CreateProjectDto：name 必填 / description 可选）。 */
interface CreateProjectPayload {
  name: string;
  description?: string;
}

/** API 项目状态 → 原型 StatusKey（active=进行中 / archived=已归档）。 */
const STATUS_MAP: Record<string, StatusKey> = {
  active: "进行中",
  archived: "已归档",
};

const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];

/** 后端 agent.role → AgentAvatar 可用 RoleKey（未知/自定义 → developer 兜底，对齐 agents 页）。 */
function toAvatarRole(role: string | null): RoleKey {
  return role && (ROLE_KEYS as readonly string[]).includes(role) ? (role as RoleKey) : "developer";
}

function statusKey(status: string): StatusKey {
  return STATUS_MAP[status] ?? "进行中";
}

/* ============================== 项目卡片 ============================== */

/** 卡片可点击样式（视觉零改动：仅 cursor + 轻微阴影/边框加深，不触碰布局/间距/配色基线） */
const projectCardCss = `
.project-card-clickable { cursor: pointer; transition: box-shadow .18s ease, border-color .18s ease; }
.project-card-clickable:hover { box-shadow: ${shadow.md}; border-color: ${neutral[300]}; }
.project-card-clickable:focus-visible { outline: 2px solid #2563EB; outline-offset: 2px; }
.project-enter-btn { transition: background-color .15s ease, box-shadow .15s ease; }
.project-enter-btn:hover { background-color: #1D4ED8; box-shadow: 0 8px 20px rgba(37,99,235,.4); }
.project-enter-btn:focus-visible { outline: 2px solid #2563EB; outline-offset: 2px; }
`;

function ProjectCard({
  project,
  onOpen,
  onArtifacts,
  onIssues,
}: {
  project: Project;
  onOpen?: () => void;
  /** 次级入口：产出物页（stopPropagation 防触发卡片主跳转） */
  onArtifacts?: () => void;
  /** 次级入口：Issue 管理页（stopPropagation 防触发卡片主跳转） */
  onIssues?: () => void;
}) {
  const card: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: `${space.xl}px`,
    borderRadius: radius.lg,
    backgroundColor: "var(--color-surface)",
    border: `1px solid ${neutral[200]}`,
    boxShadow: shadow.sm,
  };
  return (
    <section
      data-testid="project-card"
      data-project-id={project.id}
      className="project-card-clickable"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (onOpen && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      style={card}
    >
      {/* 头部：项目名 + 状态 */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
        <div
          style={{
            fontSize: fontSize.lg,
            fontWeight: 600,
            color: neutral[900],
            lineHeight: 1.4,
          }}
        >
          {project.name}
        </div>
        <StatusBadge status={statusKey(project.status)} />
      </div>

      {/* 描述 */}
      <p
        style={{
          margin: 0,
          fontSize: fontSize.md,
          color: neutral[500],
          lineHeight: 1.7,
          flex: 1,
        }}
      >
        {project.description || "暂无描述"}
      </p>

      {/* 底部：任务统计 + 成员（Phase 1 API 无成员列表，头像区保留布局） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `1px solid ${neutral[100]}`,
          paddingTop: space.md,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.xs, fontSize: fontSize.sm, color: neutral[400] }}>
          <span aria-hidden style={{ fontWeight: 700, color: neutral[600] }}>{project.taskCount}</span>
          个任务
          <span style={{ marginLeft: space.xs, color: neutral[300] }}>·</span>
          <span style={{ color: "#059669" }}>{project.completedTaskCount} 已完成</span>
        </div>
        {/* 成员 Agent 头像堆叠（MOCK-04：真实成员，agentMembers 来自项目任务团队去重） */}
        <div style={{ display: "flex", alignItems: "center" }} aria-label={`${project.agentMembers.length} 个 Agent 成员`}>
          {project.agentMembers.map((m, idx) => (
            <span key={m.agentId} style={{ marginLeft: idx === 0 ? 0 : -space.sm - 2 }}>
              <AgentAvatar role={toAvatarRole(m.role)} size="sm" />
            </span>
          ))}
        </div>
      </div>

      {/* 操作行（UX-18：明确「进入项目」主入口，右下角；产出物保持次级入口） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `1px solid ${neutral[100]}`,
          paddingTop: space.md,
          marginTop: space.md,
        }}
      >
        {/* 次级入口：产出物（点击不冒泡，避免触发卡片主跳转 /board） */}
        <button
          type="button"
          data-testid="project-artifacts-entry"
          onClick={(e) => {
            e.stopPropagation();
            onArtifacts?.();
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.xs}px ${space.sm + 2}px`,
            borderRadius: radius.pill,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            color: neutral[600],
            fontSize: fontSize.xs,
            fontWeight: 500,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>▤</span>
          产出物
        </button>
        {/* 次级入口：Issue 管理（点击不冒泡，避免触发卡片主跳转 /board） */}
        <button
          type="button"
          data-testid="project-issues-entry"
          onClick={(e) => {
            e.stopPropagation();
            onIssues?.();
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.xs}px ${space.sm + 2}px`,
            borderRadius: radius.pill,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            color: neutral[600],
            fontSize: fontSize.xs,
            fontWeight: 500,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>☰</span>
          Issue 管理
        </button>
        {/* 主入口：进入项目（UX-18：与卡片 onClick 同目标 /board?pid=，stopPropagation 防双击跳转） */}
        <button
          type="button"
          data-testid="project-enter-button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen?.();
          }}
          className="project-enter-btn"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm}px ${space.lg}px`,
            borderRadius: radius.pill,
            border: "none",
            backgroundColor: "#2563EB",
            color: "#FFFFFF",
            fontSize: fontSize.sm,
            fontWeight: 500,
            cursor: "pointer",
            boxShadow: "0 6px 16px rgba(37,99,235,.3)",
            fontFamily: fontFamily.body,
          }}
        >
          进入项目
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>→</span>
        </button>
      </div>
    </section>
  );
}

/* ============================== 创建项目弹窗 ============================== */

interface CreateProjectModalProps {
  open: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: CreateProjectPayload) => void;
}

function CreateProjectModal({ open, submitting, error, onClose, onSubmit }: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // 每次打开重置表单
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    onSubmit({
      name: name.trim(),
      description: description.trim() ? description.trim() : undefined,
    });
  };

  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "var(--color-surface)",
    fontSize: fontSize.md,
    color: neutral[800],
    outline: "none",
    fontFamily: fontFamily.body,
  };

  return (
    <div
      data-testid="create-project-modal"
      style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12%" }}
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
          width: 420,
          maxWidth: "calc(100% - 48px)",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
          fontFamily: fontFamily.body,
        }}
      >
        {/* 头部：标题 + 关闭 */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>新建项目</div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
              创建后项目归属你，成为任务与成员协作的边界
            </div>
          </div>
          <button
            type="button"
            data-testid="create-project-close"
            aria-label="关闭新建项目弹窗"
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

        {/* 字段 */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <label htmlFor="project-name" style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              项目名称 <span aria-hidden style={{ color: "#DC2626" }}>*</span>
            </label>
            <input
              id="project-name"
              data-testid="project-name-input"
              type="text"
              placeholder="请输入项目名称"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              style={inputBase}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <label htmlFor="project-description" style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              项目描述
            </label>
            <textarea
              id="project-description"
              data-testid="project-description-input"
              placeholder="简单描述项目目标与协作范围（可选）"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
              style={{ ...inputBase, resize: "vertical", lineHeight: 1.6 }}
            />
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div
            data-testid="create-project-error"
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
            data-testid="create-project-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
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
            data-testid="create-project-confirm"
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
            {submitting ? "创建中…" : "创建项目"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ============================== 页面主体 ============================== */

export default function ProjectsPage() {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;
  const queryClient = useQueryClient();
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  /* 搜索关键词（本地受控，UX-11：按名称/描述前端过滤） */
  const [keyword, setKeyword] = useState("");

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<ProjectsResponse>("/projects"),
    enabled: !!userId,
  });

  const createMutation = useMutation({
    mutationFn: (payload: CreateProjectPayload) =>
      api.post<Project>("/projects", payload),
  });

  const handleCreate = (payload: CreateProjectPayload) => {
    createMutation.mutate(payload, {
      onSuccess: () => {
        setModalOpen(false);
        // 列表失效重取：新项目出现在网格
        queryClient.invalidateQueries({ queryKey: ["projects"] });
      },
    });
  };

  const projects = data?.items ?? [];
  const total = data?.total ?? projects.length;

  /* UX-11 搜索：按项目名/描述本地模糊过滤（关键词清空 = 全量） */
  const kw = keyword.trim().toLowerCase();
  const visibleProjects =
    kw === ""
      ? projects
      : projects.filter((p) => `${p.name} ${p.description ?? ""}`.toLowerCase().includes(kw));

  return (
    <div
      data-testid="project-list-root"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`,
        fontFamily: fontFamily.body,
      }}
    >
      {/* 卡片 hover 交互样式（仅 cursor + 轻微阴影，不改布局/配色） */}
      <style>{projectCardCss}</style>

      {/* 操作行：搜索框 + 新建项目 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.lg,
          marginBottom: space.lg,
        }}
      >
        <div>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
            我的项目
          </div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
            {total} 个项目正在协作
          </div>
        </div>

        {/* 搜索框（按项目名/描述过滤，样式对齐模型页 model-search） */}
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
            backgroundColor: "var(--color-surface)",
            border: `1px solid ${neutral[200]}`,
            boxShadow: shadow.sm,
            marginLeft: "auto",
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400], lineHeight: 1 }}>
            ⌕
          </span>
          <input
            data-testid="projects-search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索项目名 / 描述…"
            aria-label="搜索项目"
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

        <button
          type="button"
          data-testid="create-project-button"
          onClick={() => setModalOpen(true)}
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
          新建项目
        </button>
      </div>

      {/* 加载 / 错误 / 空态 / 网格 */}
      {isPending ? (
        <div data-testid="projects-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}>
          加载中…
        </div>
      ) : isError ? (
        <div
          data-testid="projects-error"
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
            {isApiError(error) ? error.message : "加载项目列表失败"}
          </div>
          <button
            type="button"
            data-testid="projects-retry"
            onClick={() => refetch()}
            style={{
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
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
      ) : projects.length === 0 ? (
        <EmptyState
          title="还没有项目"
          description="创建你的第一个项目，开始组建 AI 协作团队"
          icon={<span aria-hidden>▤</span>}
          action={
            <button
              type="button"
              data-testid="create-project-button"
              onClick={() => setModalOpen(true)}
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
              新建项目
            </button>
          }
        />
      ) : visibleProjects.length === 0 ? (
        /* UX-11：搜索无命中（复用 EmptyState，不带动作） */
        <EmptyState
          title="无匹配项目"
          description="换个关键词试试，或清空搜索查看全部项目"
          icon={<span aria-hidden>⌕</span>}
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))",
            gap: space.lg,
          }}
        >
          {visibleProjects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              onOpen={() => router.push(`/board?pid=${p.id}`)}
              onArtifacts={() => router.push(`/artifacts?pid=${p.id}`)}
              onIssues={() => router.push(`/issues?pid=${p.id}`)}
            />
          ))}
        </div>
      )}

      {/* 创建项目弹窗 */}
      <CreateProjectModal
        open={modalOpen}
        submitting={createMutation.isPending}
        error={createMutation.isError ? (isApiError(createMutation.error) ? createMutation.error.message : "创建失败，请稍后重试") : null}
        onClose={() => setModalOpen(false)}
        onSubmit={handleCreate}
      />
    </div>
  );
}