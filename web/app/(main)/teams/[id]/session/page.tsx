"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 团队会话页（任务与聊天分离后：团队唯一聊天入口）
 * =============================================
 * - 常驻团队群聊（team_group 频道一团队一群）+ 私聊 Tabs（teamMember 维度 /dm-channels）
 * - 左侧完整成员面板（model chip/启用禁用/重置会话/添加实例/更多菜单，共享 TeamMembersPanel）
 * - 可拖拽面板（useResizableWidth 左 224 / 右 300 + ResizeHandle，宽度持久化）
 * - 弹窗：QuestionModal / IssueDetailModal / TaskInfoEditModal（评审与计划内联于右侧三 Tab，不再单独成区）
 * - 右侧 TaskRightTabs（状态/配置/产出三 Tab，team.currentTaskId 驱动；队列与记忆已在状态 Tab 内展示）
 * - 实时：team: + channel:（群聊/私聊） + task:（当前任务） + global
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { useRealtimeEvents, type RealtimeChatMessage } from "@/hooks/use-realtime";
import type { AgentStatusEvent, RealtimeQuestionEvent, SessionUpdatedEvent } from "@/hooks/use-realtime";
import { AgentAvatar, ChatBubble, MessageInput } from "@/src/components/ui";
import type { MentionableAgent, SendMessagePayload } from "@/src/components/ui";
import { teamsApi, type TeamDto, type TeamMemberDto } from "@/src/api/teams";
import { LoadingIndicator, MsgError, QuestionModal, MsgParts } from "@/src/components/chat";
import type { QuestionModalData } from "@/src/components/chat";
import { IssueDetailModal } from "@/src/components/tasks/issue-detail-modal";
import { TaskInfoEditModal } from "@/src/components/tasks/TaskInfoEditModal";
import { TeamMembersPanel, roleOptionsOf, customAgentsOf, type AgentItem } from "@/src/components/teams/TeamMembersPanel";
import { ResizeHandle } from "@/src/components/teams/ResizeHandle";
import { TaskRightTabs } from "@/src/components/teams/TeamRightPanel";
import { useResizableWidth } from "@/src/hooks/use-resizable";
import type {
  TaskDetail,
  PlanWithTasks,
  ArtifactItem,
  ArtifactsResponse,
} from "@/src/components/tasks/task-detail-types";
import { docIdFor } from "@/src/components/tasks/task-detail-types";
import { type RoleKey, neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

const AGENT_ID_ROLE: Record<string, RoleKey> = {
  a_product: "product",
  a_project_manager: "project_manager",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};
const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];
function toRole(agentId: string): RoleKey | null {
  const direct = AGENT_ID_ROLE[agentId];
  if (direct) return direct;
  const rest = agentId.startsWith("a_") ? agentId.slice(2) : agentId;
  if ((ROLE_KEYS as readonly string[]).includes(rest)) return rest as RoleKey;
  return null;
}
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

interface ChannelItem {
  id: string;
  type: string;
  teamId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
}
interface MessagesResponse {
  items: RealtimeChatMessage[];
  nextCursor: string | null;
}
interface AgentsResponse {
  items: AgentItem[];
  total: number;
}

export default function TeamSessionPage() {
  const params = useParams<{ id: string }>();
  const teamId = params?.id ?? "";
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLDivElement | null>(null);

  const [input, setInput] = useState("");
  const [loadingByAgent, setLoadingByAgent] = useState<Record<string, string>>({});
  const [errorByAgent, setErrorByAgent] = useState<Record<string, string>>({});
  const [sessionByAgent, setSessionByAgent] = useState<Record<string, string>>({});
  const agentIdBySessionRef = useRef<Record<string, string>>({});
  const instanceIdBySessionRef = useRef<Record<string, string | null>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionModalData | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [detailIssueId, setDetailIssueId] = useState<string | null>(null);
  const [taskEditOpen, setTaskEditOpen] = useState(false);

  const membersPanel = useResizableWidth({
    storageKey: "team-session-members-width",
    defaultWidth: 224,
    min: 160,
    max: 400,
    direction: "normal",
  });
  const taskPanel = useResizableWidth({
    storageKey: "team-session-right-width",
    defaultWidth: 300,
    min: 240,
    max: 520,
    direction: "inverse",
  });

  /* ---------- 团队 + 当前任务 ---------- */
  const teamQuery = useQuery({
    queryKey: ["team", teamId],
    queryFn: () => teamsApi.get(teamId),
    enabled: !!teamId && !!user?.id,
  });
  const team: TeamDto | undefined = teamQuery.data;
  const currentTaskId = team?.currentTaskId ?? null;

  const currentTaskQuery = useQuery({
    queryKey: ["task", currentTaskId],
    queryFn: () => api.get<TaskDetail>(`/tasks/${currentTaskId}`),
    enabled: !!currentTaskId && !!user?.id,
  });
  const currentTask = currentTaskQuery.data ?? null;

  /* ---------- 群聊频道 ---------- */
  const channelsQuery = useQuery({
    queryKey: ["channels", "team_group", teamId],
    queryFn: () => api.get<{ items: ChannelItem[]; total: number }>("/channels", { query: { teamId } }),
    enabled: !!teamId && !!user?.id,
  });
  const channel = useMemo(() => {
    const items = channelsQuery.data?.items ?? [];
    const teamGroup = items.find((c) => c.type === "team_group" && (c.teamId ?? null) === teamId);
    if (teamGroup) return teamGroup;
    if (items.length === 1) return items[0];
    return items.find((c) => (c.teamId ?? null) === teamId) ?? items[0] ?? null;
  }, [channelsQuery.data, teamId]);
  const channelId = channel?.id ?? "";

  /* ---------- 私聊 Tabs（teamMember 维度） ---------- */
  const [activeTab, setActiveTab] = useState<string>("group");
  const [privateChannelMap, setPrivateChannelMap] = useState<Map<string, string>>(new Map());
  const [dmError, setDmError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const activePrivateId = activeTab.startsWith("private:") ? activeTab.slice(8) : null;
  const isGroupTab = activeTab === "group";

  /* ---------- 消息历史 ---------- */
  const messagesQuery = useQuery({
    queryKey: ["channel", channelId, "messages"],
    queryFn: () => api.get<MessagesResponse>(`/channels/${channelId}/messages`, { query: { limit: 50 } }),
    enabled: !!channelId && !!user?.id && isGroupTab,
    refetchInterval: 30_000,
  });
  const privateMessagesQuery = useQuery({
    queryKey: ["channel", activePrivateId, "messages"],
    queryFn: async () => {
      if (!activePrivateId) return { items: [], nextCursor: null } as MessagesResponse;
      try {
        const res = await api.get<{ items: RealtimeChatMessage[]; nextCursor: string | null }>(
          `/channels/${activePrivateId}/session-history`,
        );
        return { items: res.items, nextCursor: res.nextCursor ?? null } as MessagesResponse;
      } catch (e) {
        console.error("[TeamSession] session-history fallback to messages", { channelId: activePrivateId, error: e });
        return api.get<MessagesResponse>(`/channels/${activePrivateId}/messages`, { query: { limit: 50 } });
      }
    },
    enabled: !!activePrivateId && !!user?.id,
  });

  /* ---------- 当前任务派生查询（三 Tab 数据源） ---------- */
  const artifactsQuery = useQuery({
    queryKey: ["task", currentTaskId, "artifacts"],
    queryFn: () => api.get<ArtifactsResponse>(`/tasks/${currentTaskId}/artifacts`, { query: { pageSize: 10 } }),
    enabled: !!currentTaskId && !!user?.id,
    refetchInterval: 30_000,
  });
  const issuesQuery = useQuery({
    queryKey: ["task-issues", currentTaskId],
    queryFn: () => api.get("/issues", { query: { taskId: currentTaskId!, page: 1, pageSize: 100 } }),
    enabled: !!currentTaskId && !!user?.id,
    refetchInterval: 30_000,
  });
  const plansQuery = useQuery({
    queryKey: ["plans", currentTaskId],
    queryFn: () => api.get<PlanWithTasks>("/plans", { query: { taskId: currentTaskId! } }),
    enabled: !!currentTaskId && !!user?.id,
    refetchInterval: 30_000,
    retry: false,
  });

  /* ---------- 添加实例选项 ---------- */
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<AgentsResponse>("/agents"),
    enabled: !!user?.id,
  });

  /* ---------- 提问补拉 ---------- */
  const questionsQuery = useQuery({
    queryKey: ["questions", currentTaskId, "pending"],
    queryFn: () => api.get<QuestionModalData[]>(`/questions`, { query: { taskId: currentTaskId!, status: "pending" } }),
    enabled: !!currentTaskId && !!user?.id,
  });
  useEffect(() => {
    const pending = questionsQuery.data;
    if (!pending || pending.length === 0) return;
    setPendingQuestion((prev) => prev ?? (pending[0]?.managedMode ? null : pending[0]));
  }, [questionsQuery.data]);

  /* ---------- 成员（当前任务实例优先，成员管理回调挂当前任务） ---------- */
  const agentMembers = useMemo(() => {
    const instances = currentTask?.instances ?? [];
    if (instances.length > 0) {
      return instances.map((inst) => {
        const role = inst.role && (ROLE_KEYS as readonly string[]).includes(inst.role)
          ? (inst.role as RoleKey)
          : toRole(inst.agentId) ?? "developer";
        return {
          id: inst.agentId,
          instanceId: inst.id,
          name: inst.alias ?? inst.name,
          role,
          seq: inst.seq,
          main: inst.main || inst.id === currentTask?.mainAgentInstanceId,
          enabled: (inst as { enabled?: boolean | null }).enabled ?? true,
          overrideModelId: (inst as { overrideModelId?: string | null }).overrideModelId ?? null,
        };
      });
    }
    return (team?.members ?? []).map((m: TeamMemberDto) => {
      const role = m.agent?.role && (ROLE_KEYS as readonly string[]).includes(m.agent.role)
        ? (m.agent.role as RoleKey)
        : toRole(m.agentId) ?? "developer";
      const isMain = !!team?.mainAgentMemberId && team.mainAgentMemberId === m.id;
      return {
        id: m.agentId,
        instanceId: m.id,
        name: m.alias ?? m.agent?.name ?? m.agentId,
        role,
        seq: m.seq,
        main: isMain,
        enabled: true,
        overrideModelId: null,
      };
    });
  }, [currentTask, team]);

  const agentMap = useMemo(() => {
    const map = new Map<string, { name: string; role: RoleKey }>();
    for (const a of agentMembers) {
      if (!map.has(a.id)) map.set(a.id, { name: a.name, role: a.role });
    }
    return map;
  }, [agentMembers]);
  const instanceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agentMembers) {
      if (a.instanceId) map.set(a.instanceId, a.name);
    }
    return map;
  }, [agentMembers]);
  // 团队成员 id（tmm_）→ 别名/角色：worker 回执消息 senderId 可能直接是 teamMemberId，
  // agentMap（agentId 维度）与 instanceNameById（任务实例维度）都命中不到时兜底
  const teamMemberById = useMemo(() => {
    const map = new Map<string, { name: string; role: RoleKey }>();
    for (const m of team?.members ?? []) {
      const role = m.agent?.role && (ROLE_KEYS as readonly string[]).includes(m.agent.role)
        ? (m.agent.role as RoleKey)
        : toRole(m.agentId) ?? "developer";
      map.set(m.id, { name: m.alias ?? m.agent?.name ?? m.agentId, role });
    }
    return map;
  }, [team]);

  const handlePrivateTab = useCallback(
    async (instanceId: string) => {
      if (!user?.id) return;
      const cached = privateChannelMap.get(instanceId);
      if (cached) {
        setActiveTab(`private:${cached}`);
        return;
      }
      // 实例 id → 团队成员 id：任务实例（ta_）按 agentId+seq 匹配 team.members，
      // 团队成员来源时 id 本身即 tmm_ 可直接用
      const member = agentMembers.find((a) => (a.instanceId ?? a.id) === instanceId);
      const directTmm = instanceId.startsWith("tmm_") ? instanceId : null;
      const matched = directTmm
        ?? team?.members.find((m) => m.agentId === member?.id && m.seq === member?.seq)?.id
        ?? team?.members.find((m) => m.agentId === member?.id)?.id
        ?? instanceId;
      try {
        const ch = await api.post<{ id: string }>("/dm-channels", { teamId, teamMemberId: matched });
        setPrivateChannelMap((prev) => {
          const next = new Map(prev);
          next.set(instanceId, ch.id);
          return next;
        });
        setActiveTab(`private:${ch.id}`);
        setDmError(null);
      } catch (e) {
        console.error("[TeamSession] create dm channel failed", { teamId, instanceId, teamMemberId: matched, error: e });
        setDmError(isApiError(e) ? e.message : "发起私聊失败");
      }
    },
    [privateChannelMap, teamId, team, agentMembers, user?.id],
  );

  const mentionable: MentionableAgent[] = useMemo(
    () =>
      (isGroupTab ? agentMembers : [])
        .filter((a) => (a as { enabled?: boolean | null }).enabled !== false)
        .map((a) => ({ id: a.id, agentId: a.id, instanceId: a.instanceId, name: a.name, role: a.role })),
    [agentMembers, isGroupTab],
  );
  const issueModalAgents = useMemo(
    () =>
      (currentTask?.instances ?? []).map((i) => ({
        id: i.id,
        name: i.alias ?? i.name,
        role: i.role,
      })),
    [currentTask],
  );

  const nameByStateKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agentMembers) {
      map.set(a.instanceId ?? a.id, a.name);
      map.set(a.id, a.name);
    }
    // loading/session 事件 key 可能是团队成员 id（tmm_），一并建别名映射
    for (const m of team?.members ?? []) {
      map.set(m.id, m.alias ?? m.agent?.name ?? m.agentId);
    }
    return map;
  }, [agentMembers, team]);
  const stateName = useCallback(
    (key: string) => nameByStateKey.get(key) ?? key,
    [nameByStateKey],
  );
  const loadingAgentIds = useMemo(() => new Set(Object.keys(loadingByAgent)), [loadingByAgent]);
  const loadingLabel = useMemo(() => {
    const entries = Object.entries(loadingByAgent);
    if (entries.length === 0) return null;
    const [agentId, phase] = entries[0];
    const name = stateName(agentId);
    return phase === "operating" ? `${name} 操作中` : `${name} 思考中`;
  }, [loadingByAgent, stateName]);
  const errorLabel = useMemo<{ kind: "retry" | "quota"; detail: string } | null>(() => {
    const entries = Object.entries(errorByAgent);
    if (entries.length === 0) return null;
    const [agentId, detail] = entries[0];
    const name = stateName(agentId);
    return { kind: "retry", detail: `${name} 处理失败：${detail}` };
  }, [errorByAgent, stateName]);
  const sessionLabel = useMemo(() => {
    const entries = Object.entries(sessionByAgent).filter(
      ([agentId, status]) => (status === "active" || status === "running") && !(agentId in loadingByAgent),
    );
    if (entries.length === 0) return null;
    return `${stateName(entries[0][0])} 会话运行中`;
  }, [sessionByAgent, loadingByAgent, stateName]);

  /* ---------- 会话状态初始快照 ---------- */
  const sessionSeedRef = useRef(false);
  useEffect(() => {
    if (!currentTask?.instances?.length || sessionSeedRef.current) return;
    sessionSeedRef.current = true;
    setSessionByAgent((prev) => {
      let next: Record<string, string> | null = null;
      for (const inst of currentTask.instances) {
        if (inst.sessionStatus && !(inst.id in prev)) {
          if (!next) next = { ...prev };
          next[inst.id] = inst.sessionStatus;
        }
      }
      return next ?? prev;
    });
    for (const inst of currentTask.instances) {
      if (inst.sessionId) {
        agentIdBySessionRef.current[inst.sessionId] = inst.agentId;
        instanceIdBySessionRef.current[inst.sessionId] = inst.id;
      }
    }
  }, [currentTask]);

  /* ---------- 实时（team + channel + task + global） ---------- */
  // 初次加载/切换 Tab 时滚到底；加载更多（头部插入历史）不打断阅读位置
  const bottomTabRef = useRef<string | null>(null);
  useEffect(() => {
    const key = isGroupTab ? `group:${channelId}` : `private:${activePrivateId ?? ""}`;
    const items = isGroupTab ? (messagesQuery.data?.items ?? []) : (privateMessagesQuery.data?.items ?? []);
    if (items.length === 0 || !listRef.current) return;
    if (bottomTabRef.current === key) return;
    bottomTabRef.current = key;
    const el = listRef.current;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      setTimeout(() => { el.scrollTop = el.scrollHeight; }, 150);
    });
  }, [isGroupTab, channelId, activePrivateId, messagesQuery.data, privateMessagesQuery.data]);
  useRealtimeEvents({
    scope: `team:${teamId}${channelId ? `,channel:${channelId}` : ""}${activePrivateId ? `,channel:${activePrivateId}` : ""}${currentTaskId ? `,task:${currentTaskId}` : ""},global`,
    enabled: !!teamId && !!user?.id,
    onMessage: (payload) => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
      if (currentTaskId) queryClient.invalidateQueries({ queryKey: ["plans", currentTaskId] });
      const m = payload.message;
      if (m.senderType === "agent" && m.senderId) {
        const senderKey = (m as unknown as { senderInstanceId?: string }).senderInstanceId ?? m.senderId;
        setLoadingByAgent((prev) => {
          if (!(senderKey in prev)) return prev;
          const next = { ...prev };
          delete next[senderKey];
          return next;
        });
        setErrorByAgent((prev) => {
          if (!(senderKey in prev)) return prev;
          const next = { ...prev };
          delete next[senderKey];
          return next;
        });
        setSessionByAgent((prev) => {
          const st = prev[senderKey];
          if (st !== "active" && st !== "running") return prev;
          const next = { ...prev };
          delete next[senderKey];
          return next;
        });
      }
    },
    onAgentLoading: (payload) => {
      const sessionId = (payload as { sessionId?: string | null }).sessionId;
      if (sessionId) {
        agentIdBySessionRef.current[sessionId] = payload.agentId;
        instanceIdBySessionRef.current[sessionId] = payload.instanceId ?? null;
      }
      const key = payload.instanceId ?? payload.agentId;
      setLoadingByAgent((prev) => ({ ...prev, [key]: payload.phase }));
    },
    onAgentError: (payload) => {
      const p = payload as { sessionId?: string | null; error?: unknown; message?: unknown };
      if (p.sessionId) {
        agentIdBySessionRef.current[p.sessionId] = payload.agentId;
        instanceIdBySessionRef.current[p.sessionId] = payload.instanceId ?? null;
      }
      const detail = [p.error, p.message].map((x) => (typeof x === "string" && x.trim() ? x.trim() : null)).find(Boolean) ?? "agent error";
      const key = payload.instanceId ?? payload.agentId;
      setErrorByAgent((prev) => ({ ...prev, [key]: detail }));
    },
    onAgentStatus: (payload: AgentStatusEvent) => {
      if (currentTaskId && payload.taskId && payload.taskId !== currentTaskId) return;
      const agentId = payload.agentId;
      if (!agentId) return;
      if (payload.sessionId) {
        agentIdBySessionRef.current[payload.sessionId] = agentId;
        instanceIdBySessionRef.current[payload.sessionId] = payload.instanceId ?? null;
      }
      const key = payload.instanceId ?? agentId;
      if (payload.status === "running") {
        setLoadingByAgent((prev) => ({ ...prev, [key]: "operating" }));
      } else if (payload.status === "completed" || payload.status === "failed") {
        setLoadingByAgent((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    onSessionUpdated: (payload: SessionUpdatedEvent) => {
      if (!payload.sessionId) return;
      const agentId = agentIdBySessionRef.current[payload.sessionId];
      if (!agentId) return;
      const key = instanceIdBySessionRef.current[payload.sessionId] ?? agentId;
      setSessionByAgent((prev) => ({ ...prev, [key]: payload.status }));
      if (payload.status === "idle" || payload.status === "frozen" || payload.status === "archived") {
        setLoadingByAgent((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    onTeamChanged: (payload: any) => {
      if (payload.teamId === teamId || payload.teamId == null) {
        queryClient.invalidateQueries({ queryKey: ["team", teamId] });
      }
      if (currentTaskId && payload.taskId === currentTaskId) {
        queryClient.invalidateQueries({ queryKey: ["task", currentTaskId] });
      }
    },
    onTaskStatusChanged: (payload) => {
      if (currentTaskId && payload.taskId === currentTaskId) {
        queryClient.invalidateQueries({ queryKey: ["task", currentTaskId] });
        queryClient.invalidateQueries({ queryKey: ["team", teamId] });
      }
    },
    onArtifactSubmitted: (payload) => {
      if (currentTaskId && payload.taskId === currentTaskId) {
        queryClient.invalidateQueries({ queryKey: ["task", currentTaskId, "artifacts"] });
      }
    },
    onIssueChanged: (payload) => {
      if (currentTaskId && payload.taskId === currentTaskId) {
        queryClient.invalidateQueries({ queryKey: ["task-issues", currentTaskId] });
        queryClient.invalidateQueries({ queryKey: ["issues"] });
      }
    },
    onAgentQuestion: (payload: RealtimeQuestionEvent) => {
      if (payload.resolved) {
        setPendingQuestion((prev) => (prev && prev.id === payload.question.id ? null : prev));
        return;
      }
      if (payload.question.status !== "pending") return;
      if (currentTaskId && payload.taskId && payload.taskId !== currentTaskId) return;
      if (payload.question.managedMode) return;
      setPendingQuestion({
        id: payload.question.id,
        requestId: payload.question.requestId,
        kind: payload.question.kind,
        content: payload.question.content,
        status: payload.question.status,
        taskId: payload.question.taskId,
        agentId: payload.question.agentId,
        managedMode: payload.question.managedMode,
      });
    },
  });

  /* ---------- 提问回复 ---------- */
  const questionReplyMutation = useMutation({
    mutationFn: (payload: { answers?: string[][] | null; response?: "once" | "always" | "reject" }) =>
      api.post(`/questions/${pendingQuestion?.id}/reply`, payload),
    onSuccess: () => {
      setPendingQuestion(null);
      setQuestionSubmitting(false);
      queryClient.invalidateQueries({ queryKey: ["questions"] });
    },
    onError: (err) => {
      setQuestionSubmitting(false);
      if (isApiError(err) && (err.status === 410 || err.code === "QUESTION_EXPIRED")) {
        setPendingQuestion(null);
        queryClient.invalidateQueries({ queryKey: ["questions"] });
      } else {
        console.error("[TeamSession] question reply failed", { questionId: pendingQuestion?.id, error: err });
      }
    },
  });
  const handleQuestionSubmit = (payload: { answers?: string[][] | null; response?: "once" | "always" | "reject" }) => {
    if (!pendingQuestion) return;
    setQuestionSubmitting(true);
    questionReplyMutation.mutate(payload);
  };

  /* ---------- 发送（群聊/私聊路由） ---------- */
  const targetChannelId = isGroupTab ? channelId : (activePrivateId ?? channelId);
  const privateMentionTarget = !isGroupTab && activePrivateId
    ? agentMembers.find((a) => `private:${privateChannelMap.get(a.instanceId ?? a.id)}` === activeTab) ?? null
    : null;
  const sendMutation = useMutation({
    mutationFn: (payload: SendMessagePayload) =>
      api.post(`/channels/${targetChannelId}/messages`, {
        text: payload.text,
        mentions: isGroupTab
          ? [
              ...payload.mentions.map((m) => ({
                type: "agent" as const,
                agentId: m.id,
                ...(m.instanceId ? { instanceId: m.instanceId } : {}),
              })),
              ...(payload.text.includes("@all") ? [{ type: "all" as const }] : []),
            ]
          : privateMentionTarget
            ? [{ type: "agent" as const, agentId: privateMentionTarget.id }]
            : [],
        ...(payload.attachment
          ? {
              attachmentUrl: payload.attachment.url,
              attachmentName: payload.attachment.name,
              attachmentType: payload.attachment.ext,
            }
          : {}),
        ...(isGroupTab && currentTaskId ? { taskId: currentTaskId } : {}),
      }),
    onSuccess: () => {
      setInput("");
      setSendError(null);
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
      queryClient.invalidateQueries({ queryKey: ["channel", targetChannelId, "messages"] });
    },
    onError: (err) => {
      console.error("[TeamSession] send message failed", { teamId, channelId: targetChannelId, error: err });
      setSendError(isApiError(err) ? err.message : "发送失败，请稍后重试");
    },
  });
  const handleSend = (payload: SendMessagePayload) => {
    if (!targetChannelId) return;
    setSendError(null);
    const inst = privateMentionTarget;
    if (inst && (inst as { enabled?: boolean | null }).enabled === false) return;
    for (const m of payload.mentions) {
      const inst = agentMembers.find((a) => a.id === m.id && (m.instanceId ? a.instanceId === m.instanceId : true));
      if (inst && (inst as { enabled?: boolean | null }).enabled === false) return;
    }
    sendMutation.mutate(payload);
  };

  /* ---------- 加载更多（群聊/私聊各自独立游标） ---------- */
  const handleLoadMore = useCallback(async () => {
    const q = isGroupTab ? messagesQuery : privateMessagesQuery;
    const cid = isGroupTab ? channelId : activePrivateId;
    if (!cid || !q.data?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.get<MessagesResponse>(`/channels/${cid}/messages`, {
        query: { cursor: q.data.nextCursor, limit: 50 },
      });
      queryClient.setQueryData<MessagesResponse>(["channel", cid, "messages"], (old) =>
        old
          ? {
              items: [...next.items.filter((n) => !old.items.some((o) => o.id === n.id)), ...old.items],
              nextCursor: next.nextCursor,
            }
          : next,
      );
    } catch (e) {
      console.error("[TeamSession] load more messages failed", { teamId, channelId: cid, error: e });
    } finally {
      setLoadingMore(false);
    }
  }, [isGroupTab, messagesQuery, privateMessagesQuery, channelId, activePrivateId, loadingMore, queryClient, teamId]);

  /* ---------- 成员管理（挂当前任务实例维度；无当前任务时只读） ---------- */
  const hasCurrentTask = !!currentTaskId;
  const toggleEnabledMutation = useMutation({
    mutationFn: ({ instanceId, enabled }: { instanceId: string; enabled: boolean }) =>
      api.patch<TaskDetail>(`/tasks/${currentTaskId}/instances/${instanceId}`, { enabled }),
    onSuccess: (updated) => {
      queryClient.setQueryData<TaskDetail>(["task", currentTaskId], updated);
      queryClient.invalidateQueries({ queryKey: ["task", currentTaskId] });
    },
    onError: (err) => {
      console.error("[TeamSession] toggle instance failed", { teamId, taskId: currentTaskId, error: err });
    },
  });
  const instanceModelMutation = useMutation({
    mutationFn: ({ instanceId, modelId }: { instanceId: string; modelId: string | null }) =>
      api.patch<TaskDetail>(`/tasks/${currentTaskId}/instances/${instanceId}`, { overrideModelId: modelId ?? "" }),
    onSuccess: (updated) => {
      queryClient.setQueryData<TaskDetail>(["task", currentTaskId], updated);
      queryClient.invalidateQueries({ queryKey: ["task", currentTaskId] });
    },
    onError: (err) => {
      console.error("[TeamSession] change instance model failed", { teamId, taskId: currentTaskId, error: err });
    },
  });
  const resetSessionMutation = useMutation({
    mutationFn: (instanceId: string) =>
      api.post<{ task: TaskDetail; session: unknown }>(`/tasks/${currentTaskId}/instances/${instanceId}/reset-session`),
    onSuccess: (res) => {
      queryClient.setQueryData<TaskDetail>(["task", currentTaskId], res.task);
      queryClient.invalidateQueries({ queryKey: ["task", currentTaskId] });
    },
    onError: (err) => {
      console.error("[TeamSession] reset session failed", { teamId, taskId: currentTaskId, error: err });
    },
  });
  const addInstanceMutation = useMutation({
    mutationFn: (payload: { agentId: string; alias?: string }) =>
      api.post<TaskDetail>(`/tasks/${currentTaskId}/team`, {
        addInstances: [{ agentId: payload.agentId, ...(payload.alias ? { alias: payload.alias } : {}) }],
        removeInstanceIds: [],
      }),
    onSuccess: (updated) => {
      setAddError(null);
      queryClient.setQueryData<TaskDetail>(["task", currentTaskId], updated);
      queryClient.invalidateQueries({ queryKey: ["task", currentTaskId] });
    },
    onError: (err) => {
      console.error("[TeamSession] add instance failed", { teamId, taskId: currentTaskId, error: err });
      setAddError(isApiError(err) ? err.message : "添加实例失败，请稍后重试");
    },
  });
  const handleAddInstance = async (agentId: string, alias?: string): Promise<boolean> => {
    if (addInstanceMutation.isPending) return false;
    setAddError(null);
    return new Promise((resolve) => {
      addInstanceMutation.mutate(
        { agentId, alias },
        { onSuccess: () => resolve(true), onError: () => resolve(false) },
      );
    });
  };

  /* ---------- 当前任务开关 + 评审 ---------- */
  const managedModeMutation = useMutation({
    mutationFn: (managed: boolean) => api.patch<TaskDetail>(`/tasks/${currentTaskId}`, { managedMode: managed }),
    onSuccess: (updated) => {
      queryClient.setQueryData<TaskDetail>(["task", currentTaskId], updated);
      queryClient.invalidateQueries({ queryKey: ["task", currentTaskId] });
    },
    onError: (err) => {
      console.error("[TeamSession] toggle managed mode failed", { teamId, taskId: currentTaskId, error: err });
    },
  });
  const executionModeMutation = useMutation({
    mutationFn: (mode: "direct" | "plan") =>
      api.patch<TaskDetail>(`/tasks/${currentTaskId}/execution-mode`, { mode }),
    onSuccess: (updated) => {
      queryClient.setQueryData<TaskDetail>(["task", currentTaskId], updated);
      queryClient.invalidateQueries({ queryKey: ["task", currentTaskId] });
    },
    onError: (err) => {
      console.error("[TeamSession] toggle execution mode failed", { teamId, taskId: currentTaskId, error: err });
    },
  });

  const selectedMemberKey = useMemo(() => {
    if (!activePrivateId) return null;
    const hit = Array.from(privateChannelMap.entries()).find(([, cid]) => cid === activePrivateId)?.[0];
    return hit ?? null;
  }, [privateChannelMap, activePrivateId]);

  /* ---------- 渲染守卫 ---------- */
  if (teamQuery.isPending) {
    return <div data-testid="team-session-loading" style={{ padding: space.xl, color: neutral[400], ...baseFont }}>加载团队中…</div>;
  }
  if (teamQuery.isError || !team) {
    const msg = teamQuery.isError && isApiError(teamQuery.error) ? teamQuery.error.message : "加载团队失败";
    const is404 = teamQuery.isError && isApiError(teamQuery.error) && teamQuery.error.status === 404;
    return (
      <div data-testid="team-session-error" role="alert" style={{ padding: space.xl, ...baseFont }}>
        <div style={{ color: "#DC2626", fontSize: fontSize.md }}>{is404 ? "团队不存在" : msg}</div>
        <button type="button" onClick={() => router.push("/teams")} style={{ marginTop: space.md, padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", cursor: "pointer" }}>返回团队列表</button>
      </div>
    );
  }
  if (channelsQuery.isPending) {
    return <div data-testid="team-session-loading" style={{ padding: space.xl, color: neutral[400], ...baseFont }}>加载会话中…</div>;
  }
  if (!channel) {
    const isForbidden = channelsQuery.isError && isApiError(channelsQuery.error) && channelsQuery.error.status === 403;
    return (
      <div data-testid="team-session-empty" style={{ padding: space.xl, ...baseFont }}>
        <div style={{ color: neutral[600] }}>{isForbidden ? "无权访问该团队频道" : "暂无团队群聊频道（team_group）"}</div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: space.sm }}>{isForbidden ? "请联系团队管理员将您加入团队成员后重试" : "请确认团队已创建，稍后重试"}</div>
        <button type="button" onClick={() => channelsQuery.refetch()} style={{ marginTop: space.md, padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", cursor: "pointer" }}>重试</button>
      </div>
    );
  }

  const messages: RealtimeChatMessage[] = isGroupTab
    ? (messagesQuery.data?.items ?? [])
    : (privateMessagesQuery.data?.items ?? []);
  const nextCursor = isGroupTab
    ? (messagesQuery.data?.nextCursor ?? null)
    : (privateMessagesQuery.data?.nextCursor ?? null);
  const teamEditable = !!currentTask && (currentTask.status === "pending" || currentTask.status === "in_progress");

  return (
    <div data-testid="team-session-root" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", ...baseFont }}>
      {/* 顶栏：团队名 + 当前任务 + 队列 + 刷新 + 头像组 */}
      <header style={{ height: 64, flexShrink: 0, display: "flex", alignItems: "center", gap: space.md, padding: `0 ${space.xl}px`, backgroundColor: "var(--color-surface)", borderBottom: `1px solid ${neutral[200]}` }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>{team.name} · 团队会话</span>
            {currentTask ? (
              <button
                type="button"
                data-testid="team-session-current-task"
                data-task-id={currentTask.id}
                onClick={() => router.push(`/tasks/${currentTask.id}`)}
                title="打开任务详情（深度编辑）"
                style={{ fontSize: fontSize.xs, color: "#2563EB", backgroundColor: "rgba(37,99,235,0.08)", border: "1px solid rgba(37,99,235,0.22)", padding: "1px 8px", borderRadius: radius.pill, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 240 }}
              >
                {currentTask.title}
              </button>
            ) : (
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>团队空闲</span>
            )}
          </div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>常驻群聊 · 按团队复用，切任务不切群 · {(team.members ?? []).length} 成员 · 等待队列 {(team.queue ?? []).length} 个</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: space.sm }}>
          <button type="button" data-testid="team-session-refresh" aria-label="刷新会话" onClick={() => { queryClient.invalidateQueries({ queryKey: ["channel", channelId, "messages"] }); queryClient.invalidateQueries({ queryKey: ["channels", "team_group", teamId] }); queryClient.invalidateQueries({ queryKey: ["team", teamId] }); }} style={{ width: 32, height: 32, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", color: neutral[500], cursor: "pointer" }}>↻</button>
          <div style={{ display: "flex" }}>{agentMembers.slice(0, 5).map((a, i) => (<span key={a.instanceId ?? a.id} style={{ marginLeft: i === 0 ? 0 : -8 }}><AgentAvatar role={a.role} size="sm" style={{ border: "2px solid #FFF" }} /></span>))}</div>
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: "flex", position: "relative" }}>
        {/* 左侧完整成员面板 */}
        <TeamMembersPanel
          agents={agentMembers}
          loadingAgentIds={loadingAgentIds}
          sessionStatusByAgent={sessionByAgent}
          teamEditable={teamEditable}
          agentOptions={roleOptionsOf(agentsQuery.data?.items ?? [])}
          customAgents={customAgentsOf(agentsQuery.data?.items ?? [])}
          adding={addInstanceMutation.isPending}
          addError={addError}
          onAddInstance={handleAddInstance}
          width={membersPanel.width}
          onToggleEnabled={hasCurrentTask ? (instanceId: string, enabled: boolean) => toggleEnabledMutation.mutate({ instanceId, enabled }) : undefined}
          onResetSession={hasCurrentTask ? (instanceId: string) => resetSessionMutation.mutate(instanceId) : undefined}
          onChangeModel={hasCurrentTask ? (instanceId: string, modelId: string | null) => instanceModelMutation.mutate({ instanceId, modelId }) : undefined}
          onSelectMember={(instanceId) => handlePrivateTab(instanceId)}
          selectedKey={selectedMemberKey}
          footerText={dmError ?? (hasCurrentTask ? "点击成员进入与该实例的私聊" : "点击成员进入私聊（成员管理需有进行中任务）")}
        />
        <ResizeHandle label="调整成员面板宽度" onResizeStart={membersPanel.onResizeStart} />

        {/* 中央聊天区：私聊 Tabs + 消息列表 + 输入 */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", backgroundColor: neutral[50] }}>
          <div
            data-testid="dm-tabs"
            style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.sm}px ${space.xl}px`, borderBottom: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", overflowX: "auto", ...baseFont }}
          >
            <button
              type="button"
              data-testid="dm-tab-group"
              data-active={isGroupTab ? "true" : "false"}
              onClick={() => setActiveTab("group")}
              style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.pill, border: `1px solid ${isGroupTab ? "#2563EB" : neutral[200]}`, backgroundColor: isGroupTab ? "#2563EB" : "var(--color-surface)", color: isGroupTab ? "#FFFFFF" : neutral[600], fontSize: fontSize.sm, fontWeight: isGroupTab ? 600 : 400, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
            >
              群聊
            </button>
            {agentMembers.map((m) => {
              const chanId = privateChannelMap.get(m.instanceId ?? m.id);
              const isActive = chanId ? activeTab === `private:${chanId}` : false;
              return (
                <button
                  key={m.instanceId ?? m.id}
                  type="button"
                  data-testid={`dm-tab-private-${m.instanceId ?? m.id}`}
                  data-active={isActive ? "true" : "false"}
                  onClick={() => handlePrivateTab(m.instanceId ?? m.id)}
                  style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.pill, border: `1px solid ${isActive ? "#2563EB" : neutral[200]}`, backgroundColor: isActive ? "#2563EB" : "var(--color-surface)", color: isActive ? "#FFFFFF" : neutral[600], fontSize: fontSize.sm, fontWeight: isActive ? 600 : 400, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
                >
                  私聊: {m.name}
                </button>
              );
            })}
          </div>

          <div data-testid="chat-message-list" ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: `${space.xl}px`, display: "flex", flexDirection: "column", gap: space.lg }}>
            <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
              <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{isGroupTab ? "团队会话 · 历史跨任务可见" : "私聊 · 仅你与该成员可见"}</span>
              <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
            </div>
            {nextCursor && (
              <div style={{ display: "flex", justifyContent: "center" }}>
                <button type="button" data-testid="chat-load-more" disabled={loadingMore} onClick={handleLoadMore} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", color: neutral[600], fontSize: fontSize.sm, cursor: loadingMore ? "default" : "pointer", opacity: loadingMore ? 0.6 : 1 }}> {loadingMore ? "加载中…" : "加载更多历史消息"}</button>
              </div>
            )}
            {messages.map((msg) => {
              const agent = msg.senderId ? agentMap.get(msg.senderId) : undefined;
              const memberHit = msg.senderId ? teamMemberById.get(msg.senderId) : undefined;
              const role = agent?.role ?? memberHit?.role ?? (msg.senderId ? toRole(msg.senderId) : null) ?? "developer";
              const author = (msg as unknown as { senderInstanceId?: string }).senderInstanceId
                ? (instanceNameById.get((msg as unknown as { senderInstanceId?: string }).senderInstanceId as string) ?? agent?.name ?? memberHit?.name ?? msg.senderId ?? "")
                : (agent?.name ?? memberHit?.name ?? msg.senderId ?? "");
              // 过程片段：群聊（平台表，只有 group_post 发布的结论）仅保留 text；
              // 私聊（session-history，serve 完整会话）全量透传 reasoning/thinking/tool，
              // 与旧 messages/[id] 私聊页一致，后端已做 synthetic/过程 part 策展
              const rawParts = (msg as unknown as { content?: { parts?: unknown } })?.content?.parts;
              const parts = Array.isArray(rawParts)
                ? isGroupTab
                  ? (rawParts as unknown[]).filter(
                      (p) => (p as { type?: string; synthetic?: boolean }).type === "text"
                        && !(p as { type?: string; synthetic?: boolean }).synthetic,
                    )
                  : (rawParts as unknown[])
                : [];
              const isMentionMe = Array.isArray((msg as unknown as { mentions?: unknown }).mentions) &&
                (((msg as unknown as { mentions: { type?: string; userId?: string }[] }).mentions.some((m) => m.type === "user" && m.userId === useAuthStore.getState().user?.id) ||
                  (msg as unknown as { mentions: { type?: string }[] }).mentions.some((m) => m.type === "all")));
              const attachment = msg.attachmentUrl
                ? { url: msg.attachmentUrl, name: msg.attachmentName ?? msg.attachmentUrl, ext: msg.attachmentType ?? "" }
                : undefined;
              if ((msg as unknown as { senderType: string }).senderType === "external") {
                return (
                  <ChatBubble
                    key={msg.id}
                    text={(msg.content?.text ?? "") as string}
                    type="agent"
                    author={author}
                    role={role}
                    time={formatTime(msg.createdAt)}
                    senderType="external"
                    attachment={attachment}
                  />
                );
              }
              // Agent 消息：过程片段 + 正文置底（MsgParts）；status=processing 为流式中间态
              if (msg.senderType === "agent") {
                return (
                  <MsgParts
                    key={msg.id}
                    parts={parts}
                    bodyText={((msg as unknown as { content?: { text?: string } })?.content?.text ?? "") as string}
                    author={author}
                    role={role}
                    time={formatTime(msg.createdAt)}
                    streaming={msg.status === "processing"}
                    isMentionMe={isMentionMe}
                    attachment={attachment}
                  />
                );
              }
              if (msg.senderType === "system") {
                return <ChatBubble key={msg.id} text={(msg.content?.text ?? "") as string} type="system" time={formatTime(msg.createdAt)} />;
              }
              return <ChatBubble key={msg.id} text={(msg.content?.text ?? "") as string} type={msg.senderType === "user" ? "user" : "agent"} author={msg.senderType === "user" ? undefined : author} role={role} time={formatTime(msg.createdAt)} isMentionMe={isMentionMe} attachment={attachment} />;
            })}
            {loadingLabel && <LoadingIndicator label={loadingLabel} />}
            {errorLabel && <MsgError kind={errorLabel.kind} detail={errorLabel.detail} time={formatTime(new Date().toISOString())} />}
            {sessionLabel && (
              <div data-testid="session-status" style={{ display: "flex", alignItems: "center", gap: space.sm, color: neutral[500], fontSize: fontSize.sm, padding: `${space.xs}px ${space.sm}px`, ...baseFont }}>
                {sessionLabel}…
              </div>
            )}
          </div>

          <div style={{ padding: `${space.md}px ${space.xl}px`, backgroundColor: "var(--color-surface)", borderTop: `1px solid ${neutral[200]}` }}>
            {sendError && (
              <div data-testid="team-session-send-error" role="alert" style={{ marginBottom: space.sm, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: "1px solid rgba(220,38,38,0.35)", backgroundColor: "rgba(220,38,38,0.06)", color: "#DC2626", fontSize: fontSize.sm }}>
                发送失败：{sendError}
              </div>
            )}
            <MessageInput
              value={input}
              onChange={setInput}
              onSend={handleSend}
              mentionable={mentionable}
              sending={sendMutation.isPending}
              taskId={currentTaskId ?? undefined}
              placeholder={isGroupTab ? "输入消息，@ 成员或 @all 广播…" : `发送私聊给 ${agentMembers.find((m) => `private:${privateChannelMap.get(m.instanceId ?? m.id)}` === activeTab)?.name ?? "私聊对象"}…`}
            />
            <div style={{ marginTop: space.xs, fontSize: fontSize.xs, color: neutral[400] }}>按团队复用 · 群聊消息按当前任务分区归属 {team.name}</div>
          </div>
        </div>

        <ResizeHandle label="调整任务面板宽度" onResizeStart={taskPanel.onResizeStart} />

        {/* 右侧三 Tab（状态/配置/产出，队列与记忆已在状态 Tab 内展示） */}
        <div style={{ width: taskPanel.width, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden", backgroundColor: "var(--color-surface)", borderLeft: `1px solid ${neutral[200]}` }}>
          {currentTask ? (
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <TaskRightTabs
                team={team}
                task={currentTask}
                taskId={currentTask.id}
                artifactsQuery={artifactsQuery}
                issuesQuery={issuesQuery}
                plansQuery={plansQuery}
                agents={agentMembers}
                onEditTaskInfo={() => setTaskEditOpen(true)}
                onOpenArtifacts={() => router.push(`/artifacts?pid=${currentTask.projectId}`)}
                onOpenIssues={() => router.push(`/issues?taskId=${currentTask.id}`)}
                onToggleManagedMode={(v: boolean) => { if (!managedModeMutation.isPending) managedModeMutation.mutate(v); }}
                onToggleExecutionMode={(v: "direct" | "plan") => { if (!executionModeMutation.isPending) executionModeMutation.mutate(v); }}
                  onOpenIssueDetail={(issueId: string) => setDetailIssueId(issueId)}
                  onOpenArtifactDoc={(a: ArtifactItem) => {
                    const items = (artifactsQuery.data?.items ?? []) as { id: string; title: string }[];
                    router.push(`/docs/${currentTask.id}?doc=${docIdFor(a.title, a.id, items)}`);
                  }}
                />
            </div>
          ) : (
            <div data-testid="team-right-empty" style={{ padding: space.xl, fontSize: fontSize.sm, color: neutral[400], lineHeight: 1.6 }}>
              团队当前空闲，创建任务后此处展示队首任务的状态 / 配置 / 产出。
              <button type="button" onClick={() => router.push(`/tasks/new?teamId=${teamId}`)} style={{ display: "block", marginTop: space.md, padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#FFF", fontSize: fontSize.sm, cursor: "pointer" }}>创建任务</button>
            </div>
          )}
        </div>

        {/* 任务信息编辑弹窗 */}
        {currentTask ? (
          <TaskInfoEditModal
            task={currentTask}
            open={taskEditOpen}
            onClose={() => setTaskEditOpen(false)}
            onSaved={() => {
              queryClient.invalidateQueries({ queryKey: ["task", currentTaskId] });
              queryClient.invalidateQueries({ queryKey: ["team", teamId] });
            }}
          />
        ) : null}

        {/* Issue 详情弹窗 */}
        <IssueDetailModal
          issueId={detailIssueId}
          open={!!detailIssueId}
          onClose={() => setDetailIssueId(null)}
          agents={issueModalAgents}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ["task-issues", currentTaskId] })}
        />

        {/* Agent 提问/权限确认弹窗 */}
        <QuestionModal
          open={!!pendingQuestion}
          question={pendingQuestion}
          submitting={questionSubmitting}
          onClose={() => setPendingQuestion(null)}
          onSubmit={handleQuestionSubmit}
        />
      </div>
    </div>
  );
}
