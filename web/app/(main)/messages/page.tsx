"use client";

/**
 * 消息中心 · 会话列表页（Phase 2 私聊能力 · FR-14）
 * =============================================
 * 会话列表：GET /channels（不带 type → task_group + private 全部），按 type 分组展示：
 * - 私聊（private）：Agent 头像/名/角色徽章 + 所属任务标题（副标题），点击进入 /messages/:id
 * - 群聊（task_group）：任务标题 + 状态徽章 + 团队规模，点击进入 /messages/:id
 * 视觉对齐平台现有列表页（project-list 卡片范式）+ dm-chat 原型角色/状态语义。
 * 数据源：后端 ChatService.toChannelDto 已含 task/agent 关联（private 无需额外查 agents 表）。
 */
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { AgentAvatar, AgentBadge, EmptyState, StatusBadge } from "@/src/components/ui";
import type { RoleKey, StatusKey } from "@/src/theme/tokens";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont = { fontFamily: fontFamily.body } as const;

/* ------------------------------ API 数据模型（对齐后端 toChannelDto） ------------------------------ */

/** GET /channels 条目（ChatService.toChannelDto：private 带 agent，task_group 带 task）。 */
interface ChannelItem {
  id: string;
  type: "task_group" | "private";
  taskId: string;
  agentId: string | null;
  task?: { id: string; title: string; status: string; projectId: string } | null;
  agent?: { id: string; name: string; role: string | null } | null;
  createdAt: string;
}

/** GET /channels 响应：{items, total}。 */
interface ChannelsResponse {
  items: ChannelItem[];
  total: number;
}

/** 后端五态（TASK_STATUS）。 */
type TaskApiStatus =
  | "pending"
  | "in_progress"
  | "pending_review"
  | "completed"
  | "archived";

/** API 状态 → 中文状态（待开始不在 StatusKey，本地 Badge 处理）。 */
const STATUS_LABEL: Record<TaskApiStatus, string> = {
  pending: "待开始",
  in_progress: "进行中",
  pending_review: "待验收",
  completed: "已完成",
  archived: "已归档",
};

/** seed 模板 Agent id → 角色 key（对齐 board AGENT_ID_ROLE）。 */
const AGENT_ID_ROLE: Record<string, RoleKey> = {
  a_product: "product",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};

const ROLE_KEYS: readonly RoleKey[] = ["product", "architect", "developer", "tester"];

/** agent id / role 字符串 → RoleKey（未知/自定义跳过）。 */
function toRole(input: string): RoleKey | null {
  const direct = AGENT_ID_ROLE[input];
  if (direct) return direct;
  const rest = input.startsWith("a_") ? input.slice(2) : input;
  if ((ROLE_KEYS as readonly string[]).includes(rest)) return rest as RoleKey;
  return null;
}

/** Agent 名/role → 渲染角色（未知 Agent 用 developer 兜底，对齐聊天页）。 */
function resolveRole(agent?: { role: string | null } | null, id?: string | null): RoleKey {
  if (agent?.role) {
    const r = toRole(agent.role);
    if (r) return r;
  }
  if (id) {
    const r = toRole(id);
    if (r) return r;
  }
  return "developer";
}

/** 待开始徽章（仿 StatusBadge 视觉，仅用于「待开始」，对齐群聊页 WaitingBadge）。 */
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
        backgroundColor: "#F8FAFC",
        border: "1px solid #CBD5E1",
        color: "#475569",
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      <span
        aria-hidden
        style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: "#475569", flexShrink: 0 }}
      />
      待开始
    </span>
  );
}

/** 按状态渲染徽章：「待开始」用 WaitingBadge，其余复用共享 StatusBadge。 */
function renderStatusBadge(status: string) {
  return status === "待开始" ? <WaitingBadge /> : <StatusBadge status={status as StatusKey} />;
}

/* ============================== 会话条目 ============================== */

function ConversationItem({ channel }: { channel: ChannelItem }) {
  const router = useRouter();
  const isDm = channel.type === "private";
  const role = resolveRole(channel.agent, channel.agentId);
  const title = isDm ? (channel.agent?.name ?? channel.agentId ?? "私聊") : (channel.task?.title ?? "群聊");
  const subtitle = isDm
    ? (channel.task?.title ?? "任务会话")
    : `${channel.task?.status ? STATUS_LABEL[channel.task.status as TaskApiStatus] ?? "进行中" : "群聊"} · 任务会话`;

  return (
    <section
      data-testid="conversation-item"
      data-channel-id={channel.id}
      data-type={isDm ? "dm" : "group"}
      role="button"
      tabIndex={0}
      onClick={() => router.push(`/messages/${channel.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") router.push(`/messages/${channel.id}`);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.lg}px ${space.xl}px`,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        cursor: "pointer",
        transition: "border-color .15s ease, box-shadow .15s ease",
      }}
    >
      {/* 头像：私聊=Agent 角色 / 群聊=任务组图标 */}
      {isDm ? (
        <AgentAvatar role={role} size="lg" />
      ) : (
        <span
          aria-hidden
          style={{
            width: 40,
            height: 40,
            flexShrink: 0,
            borderRadius: radius.md,
            backgroundColor: neutral[100],
            color: neutral[500],
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: fontSize.lg,
          }}
        >
          💬
        </span>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], lineHeight: 1.4 }}>
            {title}
          </span>
          {isDm ? <AgentBadge role={role} /> : renderStatusBadge(channel.task?.status ? STATUS_LABEL[channel.task.status as TaskApiStatus] ?? "进行中" : "待开始")}
        </div>
        <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2, lineHeight: 1.5 }}>
          {isDm ? `与 ${title} 的私聊 · ${subtitle}` : subtitle}
        </div>
      </div>

      <span aria-hidden style={{ color: "#2563EB", fontSize: fontSize.lg, lineHeight: 1, flexShrink: 0 }}>
        ›
      </span>
    </section>
  );
}

/* ============================== 分组区块 ============================== */

function ConversationSection({
  title,
  channels,
  emptyText,
  testid,
}: {
  title: string;
  channels: ChannelItem[];
  emptyText: string;
  testid: string;
}) {
  return (
    <section data-testid={testid} style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.md,
          padding: `0 ${space.xs}px`,
        }}
      >
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[500], letterSpacing: "0.02em" }}>
          {title}
        </span>
        <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{channels.length}</span>
      </div>
      {channels.length === 0 ? (
        <div
          style={{
            padding: `${space.xl}px`,
            fontSize: fontSize.sm,
            color: neutral[400],
            textAlign: "center",
            backgroundColor: "#FFFFFF",
            border: `1px dashed ${neutral[200]}`,
            borderRadius: radius.lg,
          }}
        >
          {emptyText}
        </div>
      ) : (
        channels.map((c) => <ConversationItem key={c.id} channel={c} />)
      )}
    </section>
  );
}

/* ============================== 页面主体 ============================== */

export default function MessagesPage() {
  const user = useAuthStore((s) => s.user);
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["channels"],
    queryFn: () => api.get<ChannelsResponse>("/channels"),
    enabled: !!user?.id,
  });

  const items = data?.items ?? [];
  // private 在上、task_group 在下（私聊为旁路入口，优先可见）
  const dmChannels = items.filter((c) => c.type === "private");
  const groupChannels = items.filter((c) => c.type === "task_group");
  const total = data?.total ?? items.length;

  return (
    <div
      data-testid="messages-list-root"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`,
        fontFamily: fontFamily.body,
      }}
    >
      {/* 操作行 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: space.lg }}>
        <div>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>会话列表</div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
            {total} 个会话 · 私聊与任务群聊
          </div>
        </div>
      </div>

      {/* 加载 / 错误 / 空态 / 分组列表 */}
      {isPending ? (
        <div data-testid="messages-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}>
          加载中…
        </div>
      ) : isError ? (
        <div
          data-testid="messages-error"
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
            {isApiError(error) ? error.message : "加载会话列表失败"}
          </div>
          <button
            type="button"
            data-testid="messages-retry"
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
      ) : items.length === 0 ? (
        <EmptyState
          title="还没有会话"
          description="创建任务生成群聊，或在任务群聊成员面板点击成员发起私聊"
          icon={<span aria-hidden>✉</span>}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.xl }}>
          <ConversationSection
            title="私聊"
            testid="conversation-section-dm"
            channels={dmChannels}
            emptyText="暂无私聊会话"
          />
          <ConversationSection
            title="群聊"
            testid="conversation-section-group"
            channels={groupChannels}
            emptyText="暂无群聊会话"
          />
        </div>
      )}
    </div>
  );
}
