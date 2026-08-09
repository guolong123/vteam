"use client";

/**
 * 任务看板页（Task 14 保真迁移 + 真实数据接入）
 * =============================================
 * 唯一来源：docs/agent-platform/prototypes/task-board/index.tsx。
 * - 状态筛选条（全部/待开始/进行中/待验收/已完成/已归档，FR-03 五态）+ 任务卡片网格；
 *   数据源：GET /api/v1/projects/:pid/tasks?status=&page=&pageSize=（T6）→ TanStack Query，
 *   pid 取 URL ?pid=，缺省 p_seed_1（对齐 task-create 页模式）。
 * - 卡片：标题 / 状态徽章 / 参与 Agent 头像 / 产出物数量；「待开始」卡片带「开始任务」
 *   按钮（FR-18/19）：点击真实调用 POST /api/v1/tasks/:id/start（T7），乐观更新 + 失败提示；
 *   启动中/失败时展示「开始前检查」提示（data-testid=start-task-hint）。
 * - 实时联动：useSSE({ scope: "global" }) 订阅 task.status.changed（09 篇 §4.1 全局广播）→
 *   invalidateQueries(["tasks"]) 刷新看板。
 * - 卡片点击 → router.push(/tasks/[id])（群聊入口，T13 建路由，先跳转）。
 * - data-testid 与原型一致：status-filter / task-card / task-members /
 *   task-artifact-count / start-task-button / start-task-hint。
 * - 「待开始」配色在页面内本地定义（WAITING_STATUS 灰蓝 #475569 系），不扩散共享层；
 *   其余状态复用共享 StatusBadge。
 * - 融合导航（NavTopBar / NavDock / CmdKPanel / rail-bar / topbar / cmdk-trigger /
 *   cmdk-panel）由 AppShell 提供，本页仅渲染内容区。
 * - 铁律（T15）：无 fixed / 100vh / 100vw，浮层相对宿主；本页无浮层，高度由 AppShell
 *   main（flex column + overflow auto）接管。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { useSSE } from "@/hooks/use-sse";
import { TaskStatusActions } from "@/src/components/tasks/task-status-actions";
import { AgentAvatar, EmptyState, StatusBadge } from "@/src/components/ui";
import {
  type RoleKey,
  type StatusKey,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 待开始状态（页面内本地定义，不动共享层） ------------------------------ */
/** 看板状态 = 共享 StatusKey(4 态) + 新增「待开始」（PRD 03 FR-03 状态机 5 态） */
type BoardStatus = StatusKey | "待开始";

/** 「待开始」本地配色：灰蓝 #475569 系（与已归档灰 #64748B 区分，偏深偏冷） */
const WAITING_STATUS = {
  color: "#475569",
  bg: "#F8FAFC",
  border: "#CBD5E1",
} as const;

/** 待开始徽章（仿 StatusBadge 视觉，仅用于「待开始」，其余状态仍走共享 StatusBadge） */
function WaitingBadge() {
  return (
    <span
      data-testid="status-badge"
      data-status="待开始"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: WAITING_STATUS.bg,
        border: `1px solid ${WAITING_STATUS.border}`,
        color: WAITING_STATUS.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          backgroundColor: WAITING_STATUS.color,
          flexShrink: 0,
        }}
      />
      待开始
    </span>
  );
}

/** 按状态渲染徽章：「待开始」用本地 WaitingBadge，其余复用共享 StatusBadge */
function renderStatusBadge(status: BoardStatus) {
  return status === "待开始" ? <WaitingBadge /> : <StatusBadge status={status} />;
}

/* ------------------------------ API 数据模型（T6 DTO / 09 篇 §3.4） ------------------------------ */
/** 后端五态（TASK_STATUS）。 */
type TaskApiStatus =
  | "pending"
  | "in_progress"
  | "pending_review"
  | "completed"
  | "archived";

/** GET /projects/:pid/tasks 条目（对齐 TasksService.toTaskDto）。 */
interface TaskItem {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: string;
  status: TaskApiStatus;
  mainAgentId: string | null;
  backgroundDocs: unknown[];
  teamAgentIds: string[];
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  pendingReviewAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
}

/** GET /projects/:pid/tasks 分页响应。 */
interface TasksResponse {
  items: TaskItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /projects 分页响应（仅取项目名供看板标题）。 */
interface ProjectsResponse {
  items: { id: string; name: string }[];
  total: number;
  page: number;
  pageSize: number;
}

/** API 状态 → 看板中文状态（对齐原型筛选条文案）。 */
const STATUS_LABEL: Record<TaskApiStatus, BoardStatus> = {
  pending: "待开始",
  in_progress: "进行中",
  pending_review: "待验收",
  completed: "已完成",
  archived: "已归档",
};

function toBoardStatus(status: string): BoardStatus {
  return STATUS_LABEL[status as TaskApiStatus] ?? "待开始";
}

/** seed 模板 Agent id → 角色 key（T14 Agents 模块预置 a_product/a_architect/a_developer/a_tester）。 */
const AGENT_ID_ROLE: Record<string, RoleKey> = {
  a_product: "product",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};

/** 产出物数量（Phase 2 无产出物端点，0 为真实兜底值，对齐 project-list 页 EMPTY_TASK_COUNT 模式）。 */
const EMPTY_ARTIFACT_COUNT = 0;

const ROLE_KEYS: readonly RoleKey[] = ["product", "architect", "developer", "tester"];

/** teamAgentIds（agent id 列表）→ 头像可渲染的 RoleKey[]；未知/自定义 Agent 跳过不渲染。 */
function toRoles(agentIds: string[]): RoleKey[] {
  const roles: RoleKey[] = [];
  for (const id of agentIds) {
    const direct = AGENT_ID_ROLE[id];
    if (direct) {
      roles.push(direct);
      continue;
    }
    const rest = id.startsWith("a_") ? id.slice(2) : id;
    if ((ROLE_KEYS as readonly string[]).includes(rest)) {
      roles.push(rest as RoleKey);
    }
  }
  return roles;
}

/* ------------------------------ 项目上下文：URL ?pid= 必填，无 pid 重定向 /projects（父子层级，禁止缺省 seed） ------------------------------ */

/* ------------------------------ 状态筛选（默认「全部」激活，点击切换 query 重新 fetch） ------------------------------ */
interface StatusFilter {
  key: string;
  label: string;
  status?: TaskApiStatus;
}

const filters: StatusFilter[] = [
  { key: "all", label: "全部" },
  { key: "待开始", label: "待开始", status: "pending" },
  { key: "进行中", label: "进行中", status: "in_progress" },
  { key: "待验收", label: "待验收", status: "pending_review" },
  { key: "已完成", label: "已完成", status: "completed" },
  { key: "已归档", label: "已归档", status: "archived" },
];

/* ================================ 任务卡片 ================================ */
interface TaskCardProps {
  task: TaskItem;
  onOpen: (taskId: string) => void;
  /** 所属项目名（来自看板已查的 projects 缓存），渲染卡片项目徽章 */
  projectName?: string;
}

function TaskCard({ task, onOpen, projectName }: TaskCardProps) {
  return (
    <section
      data-testid="task-card"
      data-task-id={task.id}
      data-status={toBoardStatus(task.status)}
      onClick={() => onOpen(task.id)}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: space.md,
        padding: `${space.xl}px`,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        transition: "box-shadow .15s ease",
        cursor: "pointer",
        ...baseFont,
      }}
    >
      {/* 头部：项目徽章 + 编号 + 状态 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          {projectName && (
            <span
              data-testid="task-project-badge"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space.xs,
                fontSize: fontSize.xs,
                color: "#2563EB",
                fontWeight: 500,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 160,
              }}
            >
              📁 {projectName}
            </span>
          )}
          <span
            style={{
              fontSize: fontSize.xs,
              color: neutral[400],
              fontWeight: 500,
              fontFamily: fontFamily.mono,
            }}
          >
            {task.id}
          </span>
        </div>
        {renderStatusBadge(toBoardStatus(task.status))}
      </div>

      {/* 标题 + 描述 */}
      <div>
        <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
          {task.title}
        </div>
        <div
          style={{
            fontSize: fontSize.sm,
            color: neutral[400],
            marginTop: space.xs,
            lineHeight: 1.6,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {task.description || ""}
        </div>
      </div>

      {/* 底部：参与 Agent 头像组 + 产出物数量 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: space.md,
          borderTop: `1px solid ${neutral[100]}`,
        }}
      >
        <div data-testid="task-members" style={{ display: "flex", alignItems: "center" }}>
          {toRoles(task.teamAgentIds).map((role, idx) => (
            <span key={role} style={{ marginLeft: idx === 0 ? 0 : -6 }}>
              <AgentAvatar role={role} size="sm" />
            </span>
          ))}
        </div>
        <span
          data-testid="task-artifact-count"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            fontSize: fontSize.xs,
            color: neutral[500],
            fontWeight: 500,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>
            ▤
          </span>
          {EMPTY_ARTIFACT_COUNT} 项产出物
        </span>
      </div>

      {/* 状态流转操作（OBS-010：按状态渲染开始/提交验收/验收通过/驳回/归档，共享 TaskStatusActions） */}
      <TaskStatusActions taskId={task.id} status={task.status} />
    </section>
  );
}

/* ================================ 页面（AppShell 内容区） ================================ */
export default function TaskBoardPage() {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;
  const queryClient = useQueryClient();
  const router = useRouter();

  // pid：URL ?pid= 必填；无 pid 且已登录 → 重定向 /projects（effect 内读 window，避免 SSR 水合不一致）
  const [pid, setPid] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState("all");

  useEffect(() => {
    const urlPid = new URLSearchParams(window.location.search).get("pid");
    if (urlPid) {
      setPid(urlPid);
    } else if (userId) {
      router.replace("/projects");
    }
  }, [userId, router]);

  const activeFilter = filters.find((f) => f.key === activeKey) ?? filters[0];
  // queryKey 含 status 依赖：点击筛选 → key 变化 → 重新 fetch（不传 status=全部）
  const tasksKey = ["tasks", pid, activeFilter.status ?? "all"] as const;

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: tasksKey,
    queryFn: () =>
      api.get<TasksResponse>(`/projects/${pid}/tasks`, {
        query: { status: activeFilter.status, page: 1, pageSize: 100 },
      }),
    enabled: !!userId && !!pid,
  });

  // 实时联动：task.status.changed（T7/T6 广播，09 篇 §4.1 全局广播）→ 失效重取看板
  useSSE({
    scope: "global",
    onEvent: (ev) => {
      if (ev.type === "task.status.changed") {
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
      }
    },
  });

  const tasks = data?.items ?? [];

  // 看板标题：?pid= 对应项目名（复用 projects 列表缓存，缺失时回退固定标题，不破坏布局）
  const projectName = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<ProjectsResponse>("/projects"),
    enabled: !!userId && !!pid,
  }).data?.items.find((p) => p.id === pid)?.name;

  return (
    <div
      data-testid="task-board-root"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[100],
        ...baseFont,
      }}
    >
      {/* 看板标题：?pid= 命中项目名时显示「{项目名} · 任务看板」，否则保持固定标题 */}
      <div
        data-testid="board-title"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
          padding: `${space.lg}px ${space.xl}px 0`,
        }}
      >
        <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
          {projectName ? `${projectName} · 任务看板` : "任务看板"}
        </div>
        {/* 标题右侧操作：新建任务（主 CTA → /tasks/new?pid=，tasks/new 页读 URL ?pid=）+ 产出物入口（Phase 3） */}
        {pid && (
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <button
              type="button"
              data-testid="create-task-button"
              onClick={() => router.push(`/tasks/new?pid=${pid}`)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space.xs,
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.pill,
                border: "none",
                backgroundColor: "#2563EB",
                color: "#FFFFFF",
                fontSize: fontSize.md,
                fontWeight: 500,
                cursor: "pointer",
                boxShadow: "0 6px 16px rgba(37,99,235,.3)",
                transition: "background-color .15s ease",
                fontFamily: fontFamily.body,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>＋</span>
              新建任务
            </button>
            <button
              type="button"
              data-testid="artifacts-entry-button"
              onClick={() => router.push(`/artifacts?pid=${pid}`)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space.xs,
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.pill,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "#FFFFFF",
                color: neutral[700],
                fontSize: fontSize.md,
                fontWeight: 500,
                cursor: "pointer",
                transition: "border-color .15s ease, color .15s ease",
                fontFamily: fontFamily.body,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>▤</span>
              产出物
            </button>
          </div>
        )}
      </div>

      {/* 状态筛选条 */}
      <div
        data-testid="status-filter"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          flexWrap: "wrap",
          padding: `${space.lg}px ${space.xl}px 0`,
        }}
      >
        {filters.map((f) => {
          const isActive = f.key === activeKey;
          return (
            <button
              key={f.key}
              type="button"
              data-testid="status-filter-option"
              data-key={f.key}
              data-active={isActive ? "true" : "false"}
              onClick={() => setActiveKey(f.key)}
              style={{
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.pill,
                border: `1px solid ${isActive ? "#2563EB" : neutral[200]}`,
                backgroundColor: isActive ? "#2563EB" : "#FFFFFF",
                color: isActive ? "#FFFFFF" : neutral[600],
                fontSize: fontSize.md,
                fontWeight: isActive ? 600 : 400,
                cursor: "pointer",
                fontFamily: fontFamily.body,
                transition: "background-color .15s ease, color .15s ease",
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* 任务卡片列表（真实接口数据） */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: space.xl,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: space.lg,
          alignContent: "start",
        }}
      >
        {isPending ? (
          <div data-testid="board-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0`, gridColumn: "1 / -1" }}>
            加载中…
          </div>
        ) : isError ? (
          <div
            data-testid="board-error"
            role="alert"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: space.md,
              padding: `${space.xxl}px`,
              textAlign: "center",
              gridColumn: "1 / -1",
            }}
          >
            <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
              {isApiError(error) ? error.message : "加载任务看板失败"}
            </div>
            <button
              type="button"
              data-testid="board-retry"
              onClick={() => refetch()}
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
        ) : tasks.length === 0 ? (
          <EmptyState
            title="暂无任务"
            description="该项目下还没有任务，创建任务后即可在看板查看"
            icon={<span aria-hidden>▤</span>}
            style={{ gridColumn: "1 / -1" }}
            action={
              pid && (
                <button
                  type="button"
                  data-testid="empty-create-task-button"
                  onClick={() => router.push(`/tasks/new?pid=${pid}`)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: space.xs,
                    marginTop: space.xs,
                    padding: `${space.sm}px ${space.lg}px`,
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
                  <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>＋</span>
                  新建任务
                </button>
              )
            }
          />
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onOpen={(taskId) => router.push(`/tasks/${taskId}`)}
              projectName={projectName}
            />
          ))
        )}
      </div>
    </div>
  );
}
