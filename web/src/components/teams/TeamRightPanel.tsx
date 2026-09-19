"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { teamsApi, type TeamDto, type TeamQueueDto } from "@/src/api/teams";
import { AgentAvatar, ConfirmDialog } from "@/src/components/ui";
import { TaskStatusActions } from "@/src/components/tasks/task-status-actions";
import { PlanDocModal, type PlanDocContent } from "@/src/components/teams/PlanDocModal";
import {
  type RoleKey,
  ROLE_KEYS,
  roles,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";
import type { TaskDetail, TaskApiStatus, ArtifactItem, TaskIssueItem } from "@/src/components/tasks/task-detail-types";
import { ARTIFACT_TYPE_THEME, ARTIFACT_TYPE_LABEL, ISSUE_STATUS_BADGE } from "@/src/components/tasks/task-detail-types";

/* ------------------------------------------------------------------ */
/* 团队队列卡片                                                         */
/* ------------------------------------------------------------------ */
export function TeamQueueCard({ team, taskId }: { team: TeamDto | null | undefined; taskId: string }) {
  const queryClient = useQueryClient();
  const [queueError, setQueueError] = useState<string | null>(null);
  const cancelMutation = useMutation({
    mutationFn: (tid: string) => teamsApi.cancelQueue(team!.id, tid),
    onSuccess: () => {
      setQueueError(null);
      if (team) {
        queryClient.invalidateQueries({ queryKey: ["team", team.id] });
        queryClient.invalidateQueries({ queryKey: ["teams"] });
      }
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "取消失败";
      const is409 = isApiError(err) && err.status === 409;
      setQueueError(is409 ? `${msg}（仅排队中的任务可取消）` : msg);
    },
  });
  if (!team) return null;
  const queuedEntry = team.queue.find((q) => q.taskId === taskId);
  const isQueued = !!queuedEntry;
  const isCurrent = team.currentTaskId === taskId;
  return (
    <div data-testid="team-queue-card" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: isQueued ? "rgba(245,158,11,0.10)" : isCurrent ? "rgba(13,148,136,0.08)" : neutral[50], border: `1px solid ${isQueued ? "rgba(245,158,11,0.28)" : isCurrent ? "rgba(13,148,136,0.22)" : neutral[200]}`, display: "flex", flexDirection: "column", gap: space.sm }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "flex", alignItems: "center", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>团队队列</span>
          <span style={{ fontSize: 10, color: "#D97706", backgroundColor: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.22)", padding: "0 5px", borderRadius: radius.pill, fontWeight: 600 }}>FIFO</span>
        </span>
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{team.queue.length} 排队 · {team.currentTaskId ? `当前 ${team.currentTaskId.slice(0, 8)}…` : "空闲"}</span>
      </div>
      <div style={{ fontSize: 10, color: neutral[400], lineHeight: 1.5 }}>按入队时间 FIFO，仅排队中可取消，不支持拖拽重排。</div>
      {isQueued && queuedEntry ? (
        <div data-testid="queue-position" style={{ display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.sm, color: "#D97706", fontWeight: 600, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: "50%", backgroundColor: "#F59E0B", color: "#FFF", fontSize: fontSize.xs, fontWeight: 700 }}>#{queuedEntry.position}</span>
          排队中 · 位置 {queuedEntry.position}
          <span style={{ fontSize: fontSize.xs, color: neutral[400], fontWeight: 400 }}>· 队列共 {team.queue.length} 个</span>
          <button type="button" data-testid="queue-cancel-current" data-task-id={taskId} disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate(taskId)} style={{ marginLeft: "auto", padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.pill, border: "1px solid rgba(239,68,68,0.22)", backgroundColor: "rgba(239,68,68,0.06)", color: "#DC2626", fontSize: fontSize.xs, fontWeight: 500, cursor: cancelMutation.isPending ? "default" : "pointer", opacity: cancelMutation.isPending ? 0.6 : 1, fontFamily: fontFamily.body }}>
            {cancelMutation.isPending ? "取消中…" : "取消排队"}
          </button>
        </div>
      ) : isCurrent ? (
        <div data-testid="queue-current" style={{ fontSize: fontSize.sm, color: "#0D9488", fontWeight: 500 }}>当前执行中（队首）</div>
      ) : (
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>未在队列中 · 群聊按团队复用，历史跨任务可见</div>
      )}
      {queueError && <div data-testid="queue-cancel-error" role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626", backgroundColor: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.14)", borderRadius: radius.sm, padding: `${space.xs}px ${space.sm}px` }}>{queueError}</div>}
      {team.queue.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs, marginTop: space.xs }}>
          {team.queue.map((q) => {
            const isSelf = q.taskId === taskId;
            const qTitle = q.taskTitle ?? null;
            const qStatus = q.taskStatus ?? "queued";
            const canCancel = qStatus === "queued";
            return (
              <div key={q.id} data-testid="team-queue-item" data-task-id={q.taskId} data-position={q.position} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.sm, backgroundColor: isSelf ? "rgba(245,158,11,0.12)" : "var(--color-surface)", border: `1px solid ${isSelf ? "rgba(245,158,11,0.28)" : neutral[200]}` }}>
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: "50%", backgroundColor: isSelf ? "#F59E0B" : neutral[400], color: "#FFF", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{q.position}</span>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: fontSize.xs, color: neutral[700], fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{qTitle ?? q.taskId}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: space.xs, minWidth: 0 }}>
                    <span data-testid="queue-item-status" style={{ flexShrink: 0, whiteSpace: "nowrap", fontSize: 10, color: canCancel ? "#D97706" : neutral[500], backgroundColor: canCancel ? "rgba(245,158,11,0.10)" : neutral[100], border: `1px solid ${canCancel ? "rgba(245,158,11,0.22)" : neutral[200]}`, borderRadius: radius.pill, padding: "0 4px", fontWeight: 600 }}>{canCancel ? "排队中" : qStatus}</span>
                    <span style={{ fontFamily: fontFamily.mono, fontSize: 10, color: neutral[400], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.taskId.slice(0, 10)}…</span>
                  </span>
                </div>
                <span style={{ fontSize: 10, color: neutral[400], flexShrink: 0 }}>{new Date(q.enqueuedAt).toLocaleDateString("zh-CN")}</span>
                <button type="button" data-testid="queue-cancel" data-task-id={q.taskId} disabled={!canCancel || cancelMutation.isPending} title={!canCancel ? "仅排队中的任务可取消" : "取消排队"} onClick={() => canCancel && cancelMutation.mutate(q.taskId)} style={{ padding: "2px 8px", borderRadius: radius.pill, border: `1px solid ${!canCancel ? neutral[200] : "rgba(239,68,68,0.22)"}`, backgroundColor: !canCancel ? neutral[100] : "rgba(239,68,68,0.06)", color: !canCancel ? neutral[400] : "#DC2626", fontSize: 10, fontWeight: 500, cursor: !canCancel || cancelMutation.isPending ? "not-allowed" : "pointer", opacity: !canCancel ? 0.6 : 1, fontFamily: fontFamily.body, flexShrink: 0 }}>
                  取消
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 团队记忆卡片                                                         */
/* ------------------------------------------------------------------ */
export function TeamMemoryCard({ team, onToggleReuse, pending, error }: {
  team: TeamDto | null | undefined;
  onToggleReuse?: (next: boolean) => void;
  pending?: boolean;
  error?: string | null;
}) {
  if (!team) return null;
  const reuse = !!team.reuseSession;
  const interactive = !!onToggleReuse;
  return (
    <div data-testid="team-memory-card" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, display: "flex", flexDirection: "column", gap: space.sm }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>记忆开关</span>
        <span style={{ fontSize: 10, color: reuse ? "#0D9488" : "#D97706", backgroundColor: reuse ? "rgba(13,148,136,0.08)" : "rgba(245,158,11,0.10)", border: `1px solid ${reuse ? "rgba(13,148,136,0.14)" : "rgba(245,158,11,0.22)"}`, padding: "0 6px", borderRadius: radius.pill, fontWeight: 600, flexShrink: 0 }}>{reuse ? "默认保留" : "每任务新会话"}</span>
      </div>
      <div data-testid="reuse-explain" style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, borderRadius: radius.md, padding: `${space.sm}px ${space.md}px` }}>
        {reuse ? (
          <span><span style={{ fontWeight: 600, color: "#0D9488" }}>团队默认保留</span>：会话跨任务复用，上下文与历史延续。</span>
        ) : (
          <span><span style={{ fontWeight: 600, color: "#D97706" }}>团队每任务新会话</span>：每任务独立会话，历史隔离。</span>
        )}
      </div>
      {interactive && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
          <span style={{ fontSize: fontSize.xs, color: neutral[500] }}>会话复用（团队默认）</span>
          <button
            type="button"
            role="switch"
            aria-checked={reuse}
            aria-label="会话复用"
            tabIndex={0}
            disabled={pending}
            onClick={() => onToggleReuse?.(!reuse)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleReuse?.(!reuse); } }}
            style={{ width: 36, height: 20, borderRadius: 10, backgroundColor: reuse ? "#0D9488" : neutral[300], position: "relative", cursor: pending ? "default" : "pointer", border: "none", padding: 0, flexShrink: 0, opacity: pending ? 0.6 : 1 }}
          >
            <span aria-hidden style={{ position: "absolute", top: 2, left: reuse ? 18 : 2, width: 16, height: 16, borderRadius: "50%", backgroundColor: "#FFF", transition: "left .2s" }} />
          </button>
        </div>
      )}
      {error && <span role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626" }}>{error}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 子 Tab 通用样式                                                     */
/* ------------------------------------------------------------------ */
const subTabStyle = (active: boolean): CSSProperties => ({
  padding: `${space.sm}px ${space.md}px`,
  border: "none",
  borderBottom: `2px solid ${active ? "#0D9488" : "transparent"}`,
  backgroundColor: active ? "var(--color-surface)" : "transparent",
  color: active ? "#0D9488" : neutral[500],
  fontSize: fontSize.sm,
  fontWeight: active ? 600 : 400,
  cursor: "pointer",
  fontFamily: fontFamily.body,
  whiteSpace: "nowrap",
  flexShrink: 0,
});

/* ------------------------------------------------------------------ */
/* 团队子 Tab                                                          */
/* ------------------------------------------------------------------ */
type TeamSubTab = "overview" | "settings" | "memory" | "channels" | "actions";

/** 角色字符串 → RoleKey（团队成员的角色在 m.agent.role，非法值归一 developer） */
function toRoleKey(role: string | null | undefined): RoleKey {
  return role && (ROLE_KEYS as readonly string[]).includes(role) ? (role as RoleKey) : "developer";
}

/** 渠道绑定卡片（消息 / 通知通用：已绑定列表 + 可选渠道勾选 + 保存 + 新增入口） */
function ChannelBindingCard({
  teamId, kind, title, hint, managePath,
}: { teamId: string; kind: "message" | "notification"; title: string; hint: string; managePath: string }) {
  const queryClient = useQueryClient();
  const listKey = kind === "message" ? ["team", teamId, "message-channels"] : ["team", teamId, "notification-channels"];
  const allKey = kind === "message" ? ["message-channels"] : ["notification-channels"];
  const path = kind === "message" ? "message-channels" : "notification-channels";
  const idField = kind === "message" ? "messageChannelIds" : "notificationChannelIds";

  const allQuery = useQuery({ queryKey: allKey, queryFn: () => api.get<any[]>(`/${path}`) });
  const boundQuery = useQuery({ queryKey: listKey, queryFn: () => api.get<any[]>(`/teams/${teamId}/${path}`) });

  const [selected, setSelected] = useState<string[] | null>(null);
  const boundIds = (boundQuery.data ?? []).map((c: any) => c.id);
  const current = selected ?? boundIds;

  const saveMutation = useMutation({
    mutationFn: (ids: string[]) => api.post(`/teams/${teamId}/${path}`, { [idField]: ids }),
    onSuccess: () => {
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: listKey });
    },
  });

  const all = allQuery.data ?? [];
  const dirty = selected !== null && JSON.stringify([...selected].sort()) !== JSON.stringify([...boundIds].sort());

  return (
    <div style={{ padding: `${space.md}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, display: "flex", flexDirection: "column", gap: space.sm }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>{title}</span>
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{current.length} 个</span>
      </div>
      <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5 }}>{hint}</div>

      {allQuery.isPending ? (
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>加载中…</div>
      ) : all.length === 0 ? (
        <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.sm}px`, border: `1px dashed ${neutral[200]}`, borderRadius: radius.sm, textAlign: "center" }}>
          暂无可用渠道
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {all.map((ch: any) => (
            <label key={ch.id} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.sm, cursor: "pointer", border: `1px solid ${current.includes(ch.id) ? "rgba(13,148,136,0.22)" : neutral[200]}`, backgroundColor: current.includes(ch.id) ? "rgba(13,148,136,0.06)" : "transparent" }}>
              <input
                type="checkbox"
                checked={current.includes(ch.id)}
                onChange={(e) => setSelected(e.target.checked ? [...current, ch.id] : current.filter((x) => x !== ch.id))}
                style={{ width: 16, height: 16, accentColor: "#0D9488", flexShrink: 0 }}
              />
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: fontSize.sm, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</span>
                <span style={{ fontSize: 10, color: neutral[400] }}>{ch.type}{ch.enabled === false ? " · 已停用" : ""}</span>
              </span>
            </label>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.xs }}>
        <button
          type="button"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate(current)}
          style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: "none", backgroundColor: dirty ? "#0D9488" : neutral[200], color: dirty ? "#FFF" : neutral[400], fontSize: fontSize.xs, fontWeight: 500, cursor: dirty && !saveMutation.isPending ? "pointer" : "default", fontFamily: fontFamily.body }}
        >
          {saveMutation.isPending ? "保存中…" : "保存绑定"}
        </button>
        <button type="button" onClick={() => window.location.href = managePath} style={{ fontSize: fontSize.xs, color: "#0D9488", background: "none", border: "none", cursor: "pointer", fontFamily: fontFamily.body }}>
          新增 / 管理渠道 →
        </button>
        {saveMutation.isError && <span role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626" }}>保存失败</span>}
      </div>
    </div>
  );
}

function TeamSubTabs({ team, task, onToggleManagedMode }: { team: any; task?: any; onToggleManagedMode: (v: boolean) => void }) {
  const [subTab, setSubTab] = useState<TeamSubTab>("overview");
  const queryClient = useQueryClient();
  const [settingError, setSettingError] = useState<string | null>(null);

  const reuseMutation = useMutation({
    mutationFn: (next: boolean) => teamsApi.update(team.id, { reuseSession: next }),
    onSuccess: () => {
      setSettingError(null);
      queryClient.invalidateQueries({ queryKey: ["team", team.id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
    onError: (err) => setSettingError(isApiError(err) ? err.message : "更新失败"),
  });

  const members: any[] = team?.members ?? [];
  const mainMember = members.find((m: any) => m.id === team?.mainAgentMemberId);
  const reuseSession = !!team?.reuseSession;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", borderBottom: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], flexShrink: 0, overflowX: "auto" }}>
        {([
          { key: "overview" as const, label: "概览" },
          { key: "settings" as const, label: "设置" },
          { key: "memory" as const, label: "记忆" },
          { key: "channels" as const, label: "渠道" },
          { key: "actions" as const, label: "操作" },
        ]).map((tab) => (
          <button key={tab.key} type="button" onClick={() => setSubTab(tab.key)} style={subTabStyle(subTab === tab.key)}>
            {tab.label}
          </button>
        ))}
      </div>
      <div data-testid="team-subtab-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: `${space.md}px ${space.lg}px`, display: "flex", flexDirection: "column", gap: space.lg }}>
        {subTab === "overview" && (
          <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
            <div style={{ padding: `${space.md}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}` }}>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700], marginBottom: space.sm }}>团队信息</div>
              <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>{team?.name ?? "未命名团队"}</div>
              {team?.description && <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: space.xs, lineHeight: 1.6 }}>{team.description}</div>}
            </div>
            <div style={{ padding: `${space.md}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}` }}>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700], marginBottom: space.sm }}>主 Agent（团队 Leader）</div>
              {mainMember ? (
                <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                  <AgentAvatar role={toRoleKey(mainMember.agent?.role)} size="md" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>{mainMember.alias ?? mainMember.agent?.name ?? "未命名"}</div>
                    <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>{roles[toRoleKey(mainMember.agent?.role)]?.label ?? "开发者"}</div>
                  </div>
                  <span style={{ fontSize: 10, color: "#FFF", backgroundColor: "#F59E0B", padding: "0 5px", borderRadius: radius.pill, fontWeight: 700, flexShrink: 0 }}>★ 主 Agent</span>
                </div>
              ) : (
                <div style={{ fontSize: fontSize.sm, color: neutral[400] }}>未指定主 Agent</div>
              )}
            </div>
            <div style={{ padding: `${space.md}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}` }}>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700], marginBottom: space.sm }}>成员（{members.length} 人）</div>
              <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                {members.map((m: any) => {
                  const rk = toRoleKey(m.agent?.role);
                  return (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                      <AgentAvatar role={rk} size="sm" />
                      <span style={{ flex: 1, minWidth: 0, fontSize: fontSize.sm, color: neutral[700], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.alias ?? m.agent?.name ?? m.id}
                      </span>
                      <span style={{ fontSize: 10, color: neutral[400], flexShrink: 0 }}>{roles[rk]?.label ?? rk}</span>
                      {m.enabled === false && <span style={{ fontSize: 10, color: "#D97706", flexShrink: 0 }}>已禁用</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        {subTab === "settings" && (
          <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
            <div style={{ padding: `${space.md}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}` }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>托管模式</div>
                  <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5 }}>{team?.managedMode ? "已开启：由主 Agent 自动响应群聊消息" : "已关闭：@ 消息由人工确认后再执行"}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={team?.managedMode ?? false}
                  aria-label="托管模式"
                  tabIndex={0}
                  onClick={() => onToggleManagedMode(!(team?.managedMode ?? false))}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleManagedMode(!(team?.managedMode ?? false)); } }}
                  style={{ width: 36, height: 20, borderRadius: 10, backgroundColor: (team?.managedMode ?? false) ? "#0D9488" : neutral[300], position: "relative", cursor: "pointer", border: "none", padding: 0, flexShrink: 0 }}
                >
                  <span aria-hidden style={{ position: "absolute", top: 2, left: (team?.managedMode ?? false) ? 18 : 2, width: 16, height: 16, borderRadius: "50%", backgroundColor: "#FFF", transition: "left .2s" }} />
                </button>
              </div>
            </div>
            <div style={{ padding: `${space.md}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}` }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>完成后重置会话</div>
                  <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5 }}>
                    {reuseSession ? "已关闭：任务完成后复用当前会话" : "已开启：任务完成后为下一任务开新会话"}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!reuseSession}
                  aria-label="完成后重置会话"
                  tabIndex={0}
                  disabled={reuseMutation.isPending}
                  onClick={() => reuseMutation.mutate(reuseSession)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); reuseMutation.mutate(reuseSession); } }}
                  style={{ width: 36, height: 20, borderRadius: 10, backgroundColor: !reuseSession ? "#0D9488" : neutral[300], position: "relative", cursor: reuseMutation.isPending ? "default" : "pointer", border: "none", padding: 0, flexShrink: 0, opacity: reuseMutation.isPending ? 0.6 : 1 }}
                >
                  <span aria-hidden style={{ position: "absolute", top: 2, left: !reuseSession ? 18 : 2, width: 16, height: 16, borderRadius: "50%", backgroundColor: "#FFF", transition: "left .2s" }} />
                </button>
              </div>
            </div>
            {settingError && <div role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626" }}>{settingError}</div>}
          </div>
        )}
        {subTab === "memory" && (
          <TeamMemoryCard team={team} onToggleReuse={(next: boolean) => reuseMutation.mutate(next)} pending={reuseMutation.isPending} error={settingError} />
        )}
        {subTab === "channels" && (
          <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
            <ChannelBindingCard
              teamId={team?.id ?? ""}
              kind="message"
              title="消息渠道（入站）"
              hint="绑定后接收该渠道的消息到团队群聊"
              managePath="/integrations"
            />
            <ChannelBindingCard
              teamId={team?.id ?? ""}
              kind="notification"
              title="通知渠道（出站）"
              hint="绑定后向该渠道发送任务通知"
              managePath="/integrations"
            />
          </div>
        )}
        {subTab === "actions" && (
          <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
            <button type="button" onClick={() => window.location.href = `/tasks/new?teamId=${team?.id ?? ""}`} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", fontSize: fontSize.sm, cursor: "pointer", fontFamily: fontFamily.body }}>创建任务</button>
            <button type="button" onClick={() => window.location.href = `/teams/${team?.id ?? ""}/tasks`} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[700], fontSize: fontSize.sm, cursor: "pointer", fontFamily: fontFamily.body }}>历史任务</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 计划状态块（todo12：DB 真值源 GET /tasks/:id/plan，文件仅展示）       */
/* ------------------------------------------------------------------ */
/** GET /tasks/:id/plan 响应（todo11：status 为 DB plans.status 真值）。 */
interface PlanStatusResponse {
  plan: { status?: string | null; confirmedBy?: string | null; confirmedAt?: string | null; finalizedBy?: string | null; finalizedAt?: string | null; rejectReason?: string | null; frozenVersion?: string | null; frozenHash?: string | null } | null;
  status: string | null;
  source?: string;
  warning?: string;
}

/** 计划五态徽标（草稿灰 / 修订中灰 / 待定稿琥珀闪烁 / 待执行琥珀闪烁 / 执行中蓝 / 完成绿；DB 状态映射。draft 为初始行零轮次，用草稿而非修订中，避免未评审即显示修订中误导）。 */
const PLAN_STATUS_BADGE: Record<string, { label: string; color: string; bg: string; border: string; flash: boolean }> = {
  draft: { label: "草稿", color: neutral[500], bg: neutral[100], border: neutral[200], flash: false },
  reviewing: { label: "修订中", color: neutral[500], bg: neutral[100], border: neutral[200], flash: false },
  rejected: { label: "修订中", color: neutral[500], bg: neutral[100], border: neutral[200], flash: false },
  pending_final: { label: "待定稿", color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)", flash: true },
  approved: { label: "待执行", color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)", flash: true },
  executing: { label: "执行中", color: "#0D9488", bg: "rgba(13,148,136,0.08)", border: "rgba(13,148,136,0.22)", flash: false },
  completed: { label: "完成", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)", flash: false },
};
const PLAN_STATUS_UNKNOWN = { label: "未知", color: neutral[500], bg: neutral[100], border: neutral[200], flash: false };

/** 评审轮次账本前端最小镜像（只读解析展示用；写口径见服务端 review-round-ledger.ts）。 */
interface RoundLedgerView {
  round: number;
  version: string;
  hash: string;
  expected: string[];
  received: Record<string, { verdict?: string; msgId?: string; version?: string }>;
  /** 归档回执（版本 ≠ 当前轮次版本的过期回执，仅备查；UI 归档入口数据源）。 */
  superseded: Array<{ member?: string; verdict?: string; msgId?: string; version?: string }>;
}
/** issue 描述内机器段分隔符（逐字节对齐服务端 REVIEW_ROUND_DELIMITER）。 */
const REVIEW_ROUND_DELIMITER = "<!-- REVIEW-ROUND-JSON -->";
function parseRoundLedger(description: unknown): RoundLedgerView | null {
  if (typeof description !== "string" || !description.includes(REVIEW_ROUND_DELIMITER)) return null;
  const tail = description.slice(description.indexOf(REVIEW_ROUND_DELIMITER) + REVIEW_ROUND_DELIMITER.length);
  const m = /```json\s*([\s\S]*?)```/.exec(tail);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]) as Partial<RoundLedgerView> & { schemaVersion?: unknown; planVersion?: { version?: unknown; hash?: unknown }; superseded?: unknown };
    if (raw?.schemaVersion !== 1 || typeof raw?.round !== "number") return null;
    if (!Array.isArray(raw?.expected) || typeof raw?.received !== "object" || !raw?.received) return null;
    const version = typeof raw?.planVersion?.version === "string" ? raw.planVersion.version : "v?";
    const hash = typeof raw?.planVersion?.hash === "string" ? raw.planVersion.hash : "";
    const superseded = Array.isArray(raw?.superseded) ? (raw.superseded as RoundLedgerView["superseded"]) : [];
    return { round: raw.round, version, hash, expected: raw.expected as string[], received: raw.received as RoundLedgerView["received"], superseded };
  } catch {
    return null;
  }
}
function shortMemberId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}

/**
 * 计划状态块（计划 Tab 顶部）：状态徽 + 版本轮次行 + 轮次进度条（缺席点名）
 * + pending_final 态成员定稿按钮（二次确认）+ approved 态成员确认按钮（二次确认）
 * + executing 态执行清单（issue 聚合）。
 * 状态一律读 GET /tasks/:id/plan（DB 真值）；文件列表仅展示，不参与状态判定。
 */
function PlanStatusBlock({ taskId, team, agents, issuesQuery }: {
  taskId: string; team: any; agents: any[]; issuesQuery: any;
}) {
  const queryClient = useQueryClient();
  const viewer = useAuthStore((s: any) => s.user);
  /** 成员可见性：与会话页成员操作同口径（登录用户即成员上下文；未登录不展示确认入口）。 */
  const isMember = !!viewer?.id;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  /** 归档入口展开态（默认收起，点击可达旧轮次回执）。 */
  const [showArchive, setShowArchive] = useState(false);

  const planQuery = useQuery({
    queryKey: ["task", taskId, "plan"],
    queryFn: () => api.get<PlanStatusResponse>(`/tasks/${taskId}/plan`),
    enabled: !!taskId && isMember,
    refetchInterval: 10_000,
  });
  const status: string | null = planQuery.data?.status ?? planQuery.data?.plan?.status ?? null;
  const badge = (status ? PLAN_STATUS_BADGE[status] : undefined) ?? PLAN_STATUS_UNKNOWN;

  const confirmMutation = useMutation({
    mutationFn: () => api.post(`/tasks/${taskId}/plan/confirm`, {}),
    onSuccess: () => {
      setConfirmError(null);
      setConfirmOpen(false);
      queryClient.invalidateQueries({ queryKey: ["task", taskId, "plan"] });
    },
    onError: (err) => setConfirmError(isApiError(err) ? err.message : "确认失败"),
  });

  const finalizeMutation = useMutation({
    mutationFn: () => api.post(`/tasks/${taskId}/plan/confirm`, { action: "finalize" }),
    onSuccess: () => {
      setFinalizeError(null);
      setFinalizeOpen(false);
      queryClient.invalidateQueries({ queryKey: ["task", taskId, "plan"] });
    },
    onError: (err) => setFinalizeError(isApiError(err) ? err.message : "确认定稿失败"),
  });

  /** 轮次账本：从 issue 描述机器段聚合，取最高轮次（同轮取回执最多者）。 */
  const issues: any[] = issuesQuery?.data?.items ?? [];
  let ledger: RoundLedgerView | null = null;
  /** 归档回执聚合：遍历全部 issue 账本的 superseded，按轮次倒序（旧轮次可达）。 */
  const archived: Array<{ member: string; verdict?: string; msgId?: string; version?: string; round: number }> = [];
  const seenArchive = new Set<string>();
  for (const it of issues) {
    const parsed = parseRoundLedger((it as { description?: unknown })?.description);
    if (!parsed) continue;
    for (const s of parsed.superseded ?? []) {
      const member = typeof s?.member === "string" ? s.member : "";
      const key = `${parsed.round}:${member}:${s?.msgId ?? ""}`;
      if (!member || seenArchive.has(key)) continue;
      seenArchive.add(key);
      archived.push({ member, verdict: s?.verdict, msgId: s?.msgId, version: s?.version, round: parsed.round });
    }
    const parsedN = Object.keys(parsed.received ?? {}).length;
    const curN = ledger ? Object.keys(ledger.received ?? {}).length : -1;
    if (!ledger || parsed.round > ledger.round || (parsed.round === ledger.round && parsedN > curN)) ledger = parsed;
  }
  archived.sort((a, b) => b.round - a.round);
  const expected: string[] = ledger?.expected ?? [];
  const receivedKeys = Object.keys(ledger?.received ?? {});
  const receivedN = receivedKeys.length;
  const expectedN = expected.length;
  const missing = expected.filter((m) => !receivedKeys.includes(m));
  const nameOf = (id: string): string => {
    const tm = (team?.members ?? []).find((m: any) => m?.id === id);
    if (tm) return tm.alias ?? tm.agent?.name ?? shortMemberId(id);
    const ag = (agents ?? []).find((a: any) => (a?.instanceId ?? a?.id) === id);
    if (ag) return ag.name ?? shortMemberId(id);
    return shortMemberId(id);
  };
  /** 版本轮次行：vX·RX·n/N（版本号/轮次/已收回执/期望评审人）。 */
  const versionLine = ledger ? `${ledger.version}·R${ledger.round}·${receivedN}/${expectedN}` : "暂无评审轮次";
  /** 定稿按钮仅 pending_final + 成员上下文渲染（隐藏而非禁用）。 */
  const showFinalize = status === "pending_final" && isMember;
  /** 确认按钮仅 approved + 成员上下文渲染（隐藏而非禁用）。 */
  const showConfirm = status === "approved" && isMember;
  /** 执行清单仅 executing 态渲染（读 issue 聚合）。 */
  const showChecklist = status === "executing";
  const issueCounts: Record<string, number> = { open: 0, in_progress: 0, resolved: 0, closed: 0, rejected: 0 };
  for (const it of issues) {
    const st = (it as { status?: string })?.status;
    if (st && st in issueCounts) issueCounts[st] += 1;
  }
  const progressPct = expectedN > 0 ? Math.round((receivedN / expectedN) * 100) : 0;
  const serverFrozenHash = planQuery.data?.plan?.frozenHash;
  const frozenHash: string | null = (typeof serverFrozenHash === "string" && serverFrozenHash ? serverFrozenHash : null) ?? (ledger?.hash ? ledger.hash : null);
  const serverFrozenVersion = planQuery.data?.plan?.frozenVersion;
  const frozenVersion: string | null = typeof serverFrozenVersion === "string" && serverFrozenVersion ? serverFrozenVersion : null;

  return (
    <>
      <div data-testid="plan-status-block" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, display: "flex", flexDirection: "column", gap: space.sm }}>
        <style>{`@keyframes plan-badge-flash {0%,100%{opacity:1}50%{opacity:.45}}`}</style>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>计划状态</span>
          {planQuery.isPending ? (
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>加载中…</span>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: space.xs }}>
              <span
                data-testid="plan-status-badge"
                data-status={status ?? "unknown"}
                style={{ fontSize: fontSize.xs, fontWeight: 600, color: badge.color, backgroundColor: badge.bg, border: `1px solid ${badge.border}`, padding: "1px 8px", borderRadius: radius.pill, whiteSpace: "nowrap", animation: badge.flash ? "plan-badge-flash 1.2s ease-in-out infinite" : undefined }}
              >
                {badge.label}
              </span>
              {frozenVersion ? (
                <span
                  data-testid="plan-frozen-version"
                  title={`冻结版本号 ${frozenVersion}`}
                  style={{ fontSize: fontSize.xs, color: neutral[700], fontFamily: fontFamily.mono, whiteSpace: "nowrap", fontWeight: 600 }}
                >
                  {frozenVersion}
                </span>
              ) : null}
              {frozenHash ? (
                <span
                  data-testid="plan-frozen-hash"
                  title={`冻结版本哈希 ${frozenHash}`}
                  style={{ fontSize: fontSize.xs, color: neutral[500], fontFamily: fontFamily.mono, whiteSpace: "nowrap" }}
                >
                  #{frozenHash}
                </span>
              ) : null}
            </span>
          )}
        </div>
        {planQuery.isError ? (
          <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>计划状态暂不可用（文件列表仅展示，不代表状态）</div>
        ) : (
          <div data-testid="plan-version-line" style={{ fontSize: fontSize.xs, color: neutral[500], fontFamily: fontFamily.mono }}>{versionLine}</div>
        )}
        {ledger ? (
          <div data-testid="plan-round-progress" data-received={receivedN} data-expected={expectedN} style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <div style={{ height: 6, borderRadius: radius.pill, backgroundColor: neutral[100], overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progressPct}%`, borderRadius: radius.pill, backgroundColor: "#0D9488" }} />
            </div>
            <div style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6 }}>
              {missing.length > 0
                ? `待 ${missing.map(nameOf).join("、")} 回执（${receivedN}/${expectedN}）`
                : expectedN > 0 ? `已收齐 ${expectedN}/${expectedN}，可修订` : "暂无评审人"}
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>暂无评审轮次账本（派发评审后自动出现）</div>
            {status === "draft" ? (
              <div data-testid="plan-review-pending" style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6, padding: `${space.xs}px ${space.sm}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.sm, backgroundColor: neutral[50] }}>等待主 Agent 派发评审：首轮评审派发后，评审轮次账本将自动出现</div>
            ) : null}
          </>
        )}
        {archived.length > 0 && (
          <div data-testid="plan-archive-block" style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <button
              type="button"
              data-testid="plan-archive-toggle"
              data-count={archived.length}
              onClick={() => setShowArchive((v) => !v)}
              style={{ alignSelf: "flex-start", padding: `2px ${space.sm}px`, borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[500], fontSize: fontSize.xs, cursor: "pointer", fontFamily: fontFamily.body }}
            >
              {showArchive ? "收起归档回执" : `归档回执（${archived.length}）`}
            </button>
            {showArchive && (
              <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                {archived.map((a) => (
                  <div key={`${a.round}:${a.member}:${a.msgId ?? ""}`} data-testid="plan-archive-item" data-member={a.member} data-version={a.version ?? ""} data-round={a.round} style={{ display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.xs, color: neutral[500], padding: `${space.xs}px ${space.sm}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.sm, backgroundColor: neutral[50] }}>
                    <span style={{ fontFamily: fontFamily.mono, flexShrink: 0 }}>R{a.round}·{a.version ?? "v?"}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nameOf(a.member)}</span>
                    <span style={{ flexShrink: 0, fontWeight: 600 }}>{a.verdict ?? ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {showFinalize && (
          <button
            type="button"
            data-testid="plan-finalize-btn"
            disabled={finalizeMutation.isPending}
            onClick={() => { setFinalizeError(null); setFinalizeOpen(true); }}
            style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", fontSize: fontSize.sm, fontWeight: 600, cursor: finalizeMutation.isPending ? "default" : "pointer", opacity: finalizeMutation.isPending ? 0.6 : 1, fontFamily: fontFamily.body }}
          >
            {finalizeMutation.isPending ? "定稿中…" : "确认定稿"}
          </button>
        )}
        {showConfirm && (
          <button
            type="button"
            data-testid="plan-confirm-btn"
            disabled={confirmMutation.isPending}
            onClick={() => { setConfirmError(null); setConfirmOpen(true); }}
            style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", fontSize: fontSize.sm, fontWeight: 600, cursor: confirmMutation.isPending ? "default" : "pointer", opacity: confirmMutation.isPending ? 0.6 : 1, fontFamily: fontFamily.body }}
          >
            {confirmMutation.isPending ? "确认中…" : "确认开始执行"}
          </button>
        )}
        {confirmError && <div role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626", backgroundColor: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.14)", borderRadius: radius.sm, padding: `${space.xs}px ${space.sm}px` }}>{confirmError}</div>}
        {finalizeError && <div role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626", backgroundColor: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.14)", borderRadius: radius.sm, padding: `${space.xs}px ${space.sm}px` }}>{finalizeError}</div>}
      </div>
      {showChecklist && (
        <div data-testid="plan-checklist" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, display: "flex", flexDirection: "column", gap: space.sm }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>执行清单</span>
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
              共 {issues.length} 项 · 待处理 {issueCounts.open} · 进行中 {issueCounts.in_progress} · 已解决 {issueCounts.resolved} · 已关闭 {issueCounts.closed} · 已拒绝 {issueCounts.rejected}
            </span>
          </div>
          {issues.length === 0 ? (
            <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px dashed ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>暂无 Issue（执行项将随派发自动出现）</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
              {issues.map((it: any) => {
                const st = (it?.status ?? "open") as keyof typeof ISSUE_STATUS_BADGE;
                const b = ISSUE_STATUS_BADGE[st] ?? ISSUE_STATUS_BADGE.open;
                return (
                  <div key={it?.id ?? it?.title} style={{ display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.sm, color: neutral[700], padding: `${space.xs}px ${space.sm}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, backgroundColor: "var(--color-surface)" }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it?.title ?? it?.id}</span>
                    <span style={{ flexShrink: 0, whiteSpace: "nowrap", fontSize: 10, color: b.color, backgroundColor: b.bg, border: `1px solid ${b.border}`, borderRadius: radius.pill, padding: "0 6px", fontWeight: 600 }}>{b.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {/* 二次确认：复用 ConfirmDialog（非危险走青色确认），遮罩/Esc 关闭对齐既有模式 */}
      <ConfirmDialog
        open={finalizeOpen}
        testid="plan-finalize"
        danger={false}
        title="确认定稿"
        description="确认后计划进入已定稿待执行态（pending_final → approved）。开始执行另需用户二次确认，该操作不可撤销。"
        confirmLabel="确认定稿"
        pendingLabel="定稿中…"
        submitting={finalizeMutation.isPending}
        onClose={() => { if (!finalizeMutation.isPending) setFinalizeOpen(false); }}
        onConfirm={() => finalizeMutation.mutate()}
      />
      <ConfirmDialog
        open={confirmOpen}
        testid="plan-confirm"
        danger={false}
        title="确认开始执行"
        description="确认后计划进入执行态（approved → executing），PM 将续推执行任务。该操作不可撤销。"
        confirmLabel="确认开始执行"
        pendingLabel="确认中…"
        submitting={confirmMutation.isPending}
        onClose={() => { if (!confirmMutation.isPending) setConfirmOpen(false); }}
        onConfirm={() => confirmMutation.mutate()}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 任务子 Tab                                                          */
/* ------------------------------------------------------------------ */
/** opencode todo 步骤项（对齐 GET /tasks/:id/plan-steps → steps[]）。 */
export interface PlanStepItem {
  id?: string;
  content: string;
  /** pending | in_progress | completed | cancelled（未知状态按未完成渲染）。 */
  status: string;
  priority?: string;
}

type TaskSubTab = "status" | "plan" | "config" | "output" | "triggers";

/** 任务优先级中文标签（对齐 tasks/new 与 teams/[id]/tasks 既有映射）。 */
const TASK_PRIORITY_LABEL: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

/**
 * GET /triggers 服务端展示富化（triggers-display 契约；字段缺失时逐项降级，老服务端兼容）。
 * 对齐 server `TriggerDisplay`（timers/triggers.service.ts）与
 * web/app/(main)/system/triggers/page.tsx 的同名接口。
 */
export interface TriggerDisplay {
  scopeLabel?: string | null;
  scopeTeam?: string | null;
  ownerLabel?: string | null;
  taskLabel?: string | null;
  description?: string | null;
}

/** 触发器行（对齐 GET /triggers → items[] 白名单字段 + 派生 source，todo-18 只读消费）。 */
export interface TriggerItem {
  id: string;
  kind: string;
  status: string;
  dueAt: string | null;
  nextFireAt: string | null;
  scopeType: string | null;
  scopeId: string | null;
  ownerInstanceId: string | null;
  fireCount: number;
  skipReason: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  /** 系统触发器只读，Agent 触发器可取消（plan decision 5，后端二次强制）。 */
  source: "agent" | "system";
  /** 服务端展示富化（缺失/为空时行内逐项降级，老服务端兼容）。 */
  display?: TriggerDisplay | null;
}

interface TriggersResponse {
  items: TriggerItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 触发器列表查询键（todo-18）：任务选中时按 taskId 作用域，否则回退 teamId。
 * 会话页实时桥尚无 trigger 事件族，沿用 30s 轮询与计划/产出查询同节奏。
 */
export function triggersQueryKey(taskId: string, teamId: string): string[] {
  return taskId ? ["task", taskId, "triggers"] : ["team", teamId, "triggers"];
}

/** 触发器列表共享查询（badge 与面板同 key，单次请求共享缓存）。 */
function useTaskTriggers(taskId: string, teamId: string) {
  return useQuery({
    queryKey: triggersQueryKey(taskId, teamId),
    queryFn: () => taskId
      ? api.get<TriggersResponse>("/triggers", { query: { taskId, page: 1, pageSize: 100 } })
      : api.get<TriggersResponse>("/triggers", { query: { teamId, page: 1, pageSize: 100 } }),
    enabled: !!(taskId || teamId),
    refetchInterval: 30_000,
    retry: false,
  });
}

/** 触发器状态主题（对齐 status ∈ pending|firing|fired|cancelled|failed）。 */
const TRIGGER_STATUS_THEME: Record<string, { label: string; color: string }> = {
  pending: { label: "待触发", color: "#F59E0B" },
  firing: { label: "触发中", color: "#0D9488" },
  fired: { label: "已触发", color: "#10B981" },
  cancelled: { label: "已取消", color: neutral[400] },
  failed: { label: "失败", color: "#DC2626" },
};

/** 触发时间短标签（nextFireAt 优先，无时间显示"—"）。 */
function triggerFireLabel(t: TriggerItem): string {
  const iso = t.nextFireAt ?? t.dueAt;
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("zh-CN");
}

/** 绝对时间短标签（无效/缺失返回 null，调用方跳过该行）。 */
function localDateTimeLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString("zh-CN");
}

/**
 * kind → 中文标签（未知 kind 原样，调用方 `?? kind`）。
 * 必须与 server/src/common/constants/trigger.constants.ts `TRIGGER_KIND_LABEL`
 * 及 web/app/(main)/system/triggers/page.tsx `KIND_LABEL` 同值，改一处同步另两处。
 */
const TRIGGER_KIND_LABEL: Record<string, string> = {
  receipt_nudge: "催办",
  review_round_timeout: "评审超时",
  progression_patrol: "进度巡检",
  session_idle_scan: "空闲扫描",
  hook_fire: "定时",
  hook_poll: "条件",
};

/** 行标题：display.description（人话）优先，缺失回退中文 kind 标签；永不为空、永不用 raw id/raw kind。 */
function triggerTitleOf(t: TriggerItem): string {
  const desc = t.display?.description?.trim();
  if (desc) return desc;
  return TRIGGER_KIND_LABEL[t.kind] ?? "触发器";
}

/** 范围文案：display 优先（team · label），taskLabel 与 scopeLabel 重复时去重；缺 display 回退 scope 列。 */
function triggerScopeText(t: TriggerItem): string | null {
  const label = t.display?.scopeLabel ?? (t.scopeType && t.scopeId ? `${t.scopeType}/${t.scopeId}` : "全局");
  const body = t.display?.taskLabel === label ? null : label;
  if (!body) return t.display?.scopeTeam ?? null;
  return t.display?.scopeTeam ? `${t.display.scopeTeam} · ${body}` : body;
}

/** 归属文案：display.ownerLabel 优先（"—" 视为缺失），缺 display 回退 owner 实例 id。 */
function triggerOwnerText(t: TriggerItem): string | null {
  const owner = t.display?.ownerLabel;
  if (owner && owner !== "—") return owner;
  return t.ownerInstanceId ?? null;
}

/** 任务文案：display.taskLabel（与范围重复与否由调用方按需展示）。 */
function triggerTaskText(t: TriggerItem): string | null {
  return t.display?.taskLabel ?? null;
}

/**
 * 触发 Tab 面板：当前任务/团队作用域的触发器只读列表。
 * 系统来源行只读（无取消按钮），Agent 来源行可经 ConfirmDialog 取消。
 */
function TaskTriggersBlock({ taskId, teamId }: { taskId: string; teamId: string }) {
  const queryClient = useQueryClient();
  const triggersQuery = useTaskTriggers(taskId, teamId);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/triggers/${id}`),
    onSuccess: () => {
      setConfirmId(null);
      setCancelError(null);
      queryClient.invalidateQueries({ queryKey: triggersQueryKey(taskId, teamId) });
    },
    onError: (err) => {
      setCancelError(isApiError(err) ? err.message : "取消失败");
    },
  });
  const items: TriggerItem[] = triggersQuery.data?.items ?? [];
  const confirmItem = confirmId ? items.find((t) => t.id === confirmId) ?? null : null;
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: space.sm }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>触发器</span>
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{triggersQuery.data?.total ?? items.length} 个</span>
      </div>
      {triggersQuery.isPending ? (
        <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>加载中…</div>
      ) : triggersQuery.isError ? (
        <div data-testid="trigger-list-error" role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626", backgroundColor: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.14)", borderRadius: radius.md, padding: `${space.sm}px ${space.md}px` }}>
          {isApiError(triggersQuery.error) ? triggersQuery.error.message : "触发器加载失败"}
        </div>
      ) : items.length === 0 ? (
        <div data-testid="trigger-empty" style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px dashed ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>暂无触发器</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {items.map((t) => {
            const st = TRIGGER_STATUS_THEME[t.status] ?? { label: t.status, color: neutral[500] };
            const title = triggerTitleOf(t);
            const kindLabel = TRIGGER_KIND_LABEL[t.kind] ?? t.kind;
            const scopeText = triggerScopeText(t);
            const ownerText = triggerOwnerText(t);
            const taskText = triggerTaskText(t);
            return (
              <div
                key={t.id}
                data-testid="trigger-row"
                data-trigger-id={t.id}
                data-kind={t.kind}
                data-source={t.source}
                data-status={t.status}
                style={{ display: "flex", alignItems: "center", gap: space.sm, width: "100%", boxSizing: "border-box", fontSize: fontSize.sm, color: neutral[700], padding: `${space.xs}px ${space.sm}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, backgroundColor: "var(--color-surface)" }}
              >
                <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: st.color, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <span style={{ display: "flex", alignItems: "baseline", gap: space.xs, minWidth: 0, fontWeight: 500 }}>
                    <span data-testid="trigger-title" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
                    <span aria-hidden style={{ color: neutral[300], flexShrink: 0 }}>·</span>
                    <span style={{ color: st.color, flexShrink: 0, whiteSpace: "nowrap" }}>{st.label}</span>
                  </span>
                  <span style={{ fontSize: 10, color: neutral[400] }}>
                    {triggerFireLabel(t)} · {t.source === "agent" ? "Agent" : "系统"} · 触发 {t.fireCount} 次 · 类型 {kindLabel}
                    {scopeText && <> · 范围 <span data-testid="trigger-scope">{scopeText}</span></>}
                    {ownerText && <> · 归属 <span data-testid="trigger-owner">{ownerText}</span></>}
                    {taskText && <> · 任务 <span data-testid="trigger-task">{taskText}</span></>}
                  </span>
                  {t.skipReason && (
                    <span data-testid="trigger-skip-reason" style={{ fontSize: 10, color: "#D97706", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>跳过原因：{t.skipReason}</span>
                  )}
                </span>
                {t.source === "agent" && (
                  <button
                    type="button"
                    data-testid="trigger-cancel"
                    data-trigger-id={t.id}
                    disabled={cancelMutation.isPending}
                    title="取消该触发器"
                    onClick={() => { setCancelError(null); setConfirmId(t.id); }}
                    style={{ padding: "2px 8px", borderRadius: radius.pill, border: "1px solid rgba(239,68,68,0.22)", backgroundColor: "rgba(239,68,68,0.06)", color: "#DC2626", fontSize: 10, fontWeight: 500, cursor: cancelMutation.isPending ? "default" : "pointer", opacity: cancelMutation.isPending ? 0.6 : 1, fontFamily: fontFamily.body, flexShrink: 0 }}
                  >
                    取消
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {cancelError && <div data-testid="trigger-cancel-error" role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626", backgroundColor: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.14)", borderRadius: radius.sm, padding: `${space.xs}px ${space.sm}px` }}>{cancelError}</div>}
      <ConfirmDialog
        open={!!confirmItem}
        testid="trigger-cancel"
        title="取消触发器"
        description={confirmItem ? `确定取消触发器「${triggerTitleOf(confirmItem)}」（${confirmItem.id}）吗？取消后不再触发。` : undefined}
        confirmLabel="确认取消"
        pendingLabel="取消中…"
        submitting={cancelMutation.isPending}
        onClose={() => { if (!cancelMutation.isPending) setConfirmId(null); }}
        onConfirm={() => confirmId && cancelMutation.mutate(confirmId)}
      />
    </div>
  );
}

function TaskSubTabs({ team, task, taskId, artifactsQuery, issuesQuery, agents, onEditTaskInfo, onOpenArtifacts, onOpenIssues, onOpenIssueDetail, onOpenArtifactDoc, onUploadPlanDoc, planDocsQuery, planStepsQuery }: {
  team: any; task: any; taskId: string; artifactsQuery: any; issuesQuery: any; agents: any[];
  onEditTaskInfo: () => void; onOpenArtifacts: () => void; onOpenIssues: () => void;
  onOpenIssueDetail?: (issueId: string) => void; onOpenArtifactDoc?: (artifact: ArtifactItem) => void;
  /** 上传计划文件（写进任务目录 .opencode/plans/）；缺省则不显示上传入口。 */
  onUploadPlanDoc?: () => void;
  /** 计划文档查询（GET tasks/:id/plan-docs，由会话页提供并轮询）。 */
  planDocsQuery?: any;
  /** 执行步骤查询（GET /tasks/:id/plan-steps，由会话页提供，30s 轮询）。 */
  planStepsQuery?: any;
}) {
  const [subTab, setSubTab] = useState<TaskSubTab>("status");
  /** 计划文档 Modal 选中的文件（null=关闭；正文随列表已下发，打开即渲染）。 */
  const [planDoc, setPlanDoc] = useState<PlanDocContent | null>(null);
  /**
   * 计划文档列表：来自 `GET /tasks/:id/plan-docs`——任务目录 `.opencode/plans/*.md`
   * 的实时同步（agent 写的 / 用户上传的），vteam 不维护计划状态。
   */
  const planFiles: PlanDocContent[] = planDocsQuery?.data?.files ?? [];
  const planDocsDegraded: boolean = planDocsQuery?.data?.degraded ?? false;
  const planDocsPending: boolean = !!planDocsQuery?.isPending;
  const planDocTotal = planFiles.length;
  /** 执行步骤（opencode todo 只读透传；degraded 时 steps 为空并提示不可用）。 */
  const planSteps: PlanStepItem[] = planStepsQuery?.data?.steps ?? [];
  const planStepsDegraded: boolean = planStepsQuery?.data?.degraded ?? false;
  const planStepsPending: boolean = !!planStepsQuery?.isPending;
  /** 任务计划模式开关（task.planMode；缺省 false=直接执行）。 */
  const planModeOn: boolean = !!(task?.effectivePlanMode ?? task?.planMode);
  const waiting = (team?.queue ?? []).filter((q: TeamQueueDto) => q.taskStatus === "queued" || !q.taskStatus).length;
  const isCurrent = team?.currentTaskId === taskId;
  const teamScopeId: string = team?.id ?? "";
  const triggersQuery = useTaskTriggers(taskId, teamScopeId);
  const pendingTriggers = (triggersQuery.data?.items ?? []).filter((t) => t.status === "pending").length;
  const statusLabel = task ? (task.status === "queued" ? "排队中" : task.status === "pending" ? "待开始" : task.status === "in_progress" ? "进行中" : task.status === "pending_review" ? "待验收" : task.status === "completed" ? "已完成" : "已归档") : "";
  const configRows = [
    { label: "标题", value: task?.title },
    { label: "描述", value: task?.description },
    { label: "优先级", value: task?.priority ? (TASK_PRIORITY_LABEL[task.priority] ?? task.priority) : null },
    { label: "状态", value: statusLabel || null },
    { label: "所属团队", value: team?.name ?? task?.teamId ?? null },
    { label: "创建人", value: task?.createdBy ?? null },
    { label: "创建时间", value: localDateTimeLabel(task?.createdAt) },
    { label: "计划模式", value: planModeOn ? "已开启（先出计划后执行）" : "已关闭（直接执行）" },
  ].filter((r) => r.value);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", borderBottom: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], flexShrink: 0, overflowX: "auto" }}>
        {([
          { key: "status" as const, label: "状态", badge: waiting > 0 ? String(waiting) : null },
          { key: "plan" as const, label: "计划", badge: planDocTotal ? String(planDocTotal) : null },
          { key: "config" as const, label: "配置", badge: null },
          { key: "output" as const, label: "产出", badge: artifactsQuery.data?.total ? String(artifactsQuery.data.total) : null },
          { key: "triggers" as const, label: "触发", badge: pendingTriggers > 0 ? String(pendingTriggers) : null },
        ]).map((tab) => (
          <button key={tab.key} type="button" data-testid={tab.key === "triggers" ? "task-subtab-triggers" : undefined} onClick={() => setSubTab(tab.key)} style={subTabStyle(subTab === tab.key)}>
            {tab.label}
            {tab.badge && <span style={{ fontSize: 10, color: "#FFF", backgroundColor: subTab === tab.key ? "#0D9488" : "#F59E0B", padding: "0 5px", borderRadius: radius.pill, fontWeight: 700, marginLeft: space.xs }}>{tab.badge}</span>}
          </button>
        ))}
      </div>
      <div data-testid="task-subtab-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: `${space.md}px ${space.lg}px`, display: "flex", flexDirection: "column", gap: space.lg }}>
        {subTab === "status" && (
          <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
            <div style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: isCurrent ? "rgba(13,148,136,0.06)" : waiting > 0 ? "rgba(245,158,11,0.06)" : "var(--color-surface)", border: `1px solid ${isCurrent ? "rgba(13,148,136,0.14)" : waiting > 0 ? "rgba(245,158,11,0.14)" : neutral[200]}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, backgroundColor: task.status === "in_progress" ? "#10B981" : task.status === "queued" ? "#F59E0B" : task.status === "pending" ? "#0D9488" : neutral[300] }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={task.title}>{task.title}</span>
                <span style={{ flexShrink: 0, whiteSpace: "nowrap", fontSize: fontSize.xs, color: "#FFF", backgroundColor: task.status === "queued" ? "#F59E0B" : task.status === "in_progress" ? "#10B981" : "#0D9488", padding: "1px 6px", borderRadius: radius.pill }}>{statusLabel}</span>
              </div>
              <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>
                {isCurrent ? "当前执行（队首）" : team?.currentTaskId ? `队首 ${team.currentTaskId.slice(0,8)}… 执行中` : "团队空闲"} · {waiting > 0 ? `等待中 ${waiting} 个` : "暂无等待"}
              </div>
              <div style={{ display: "flex", gap: space.sm, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 200px", minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <TaskStatusActions taskId={taskId} status={task.status as TaskApiStatus} />
                </div>
                <button type="button" onClick={onEditTaskInfo} style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>编辑</button>
              </div>
            </div>
            <TeamQueueCard team={team} taskId={taskId} />
          </div>
        )}
        {subTab === "config" && (
          <div style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: `${space.md}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, backgroundColor: "var(--color-surface)" }}>
            <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>任务信息</div>
            <div data-testid="task-config-fields" style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
              {configRows.map((r) => (
                <div key={r.label} style={{ display: "flex", alignItems: "flex-start", gap: space.sm, fontSize: fontSize.xs }}>
                  <span style={{ flexShrink: 0, width: 56, color: neutral[400] }}>{r.label}</span>
                  <span style={{ flex: 1, minWidth: 0, color: neutral[700], whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.value}</span>
                </div>
              ))}
            </div>
            <button type="button" onClick={onEditTaskInfo} style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, cursor: "pointer", fontFamily: fontFamily.body }}>编辑任务信息</button>
          </div>
        )}
        {subTab === "plan" && (
          <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: space.lg }}>
            {/* 计划状态（DB 真值源 GET tasks/:id/plan；文件列表仅展示，不参与状态判定） */}
            <PlanStatusBlock taskId={taskId} team={team} agents={agents} issuesQuery={issuesQuery} />
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: space.sm }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>计划文档</span>
                <span style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                  <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{planDocTotal} 个</span>
                  <button
                    type="button"
                    data-testid="plan-doc-upload"
                    disabled={!onUploadPlanDoc}
                    onClick={onUploadPlanDoc}
                    title="上传 Markdown 到任务目录 .opencode/plans/（agent 同目录可读）"
                    style={{ padding: "2px 8px", borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], fontSize: fontSize.xs, cursor: onUploadPlanDoc ? "pointer" : "not-allowed", fontFamily: fontFamily.body }}
                  >
                    上传
                  </button>
                </span>
              </div>
              {planDocsPending ? (
                <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>加载中…</div>
              ) : planDocsDegraded && planFiles.length === 0 ? (
                <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px dashed ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>暂不可用（主 Agent 会话未建立或 worker 离线）</div>
              ) : planFiles.length === 0 ? (
                <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px dashed ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>
                  {planModeOn ? "等待主 Agent 写入计划（.opencode/plans/）…" : "暂无计划文件（可上传，或让 agent 在计划模式下产出）"}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                  {planFiles.map((f) => (
                    <button
                      key={f.name}
                      type="button"
                      data-testid={`plan-doc-row-${f.name}`}
                      title="点击查看全文"
                      onClick={() => setPlanDoc(f)}
                      style={{ display: "flex", alignItems: "center", gap: space.sm, width: "100%", boxSizing: "border-box", fontSize: fontSize.sm, color: neutral[700], padding: `${space.xs}px ${space.sm}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", cursor: "pointer", textAlign: "left", fontFamily: fontFamily.body }}
                    >
                      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: "#0D9488", flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{f.name}</span>
                        <span style={{ fontSize: 10, color: neutral[400] }}>
                          {planDocUpdatedLabel(f.updatedAt)}{f.truncated ? " · 已截断" : ""}
                        </span>
                      </span>
                      <span aria-hidden style={{ color: neutral[300], fontSize: fontSize.xs, flexShrink: 0 }}>›</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: space.sm }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>执行步骤</span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{planSteps.length} 项</span>
              </div>
              {planStepsPending ? (
                <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>加载中…</div>
              ) : planStepsDegraded && planSteps.length === 0 ? (
                <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px dashed ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>暂不可用（主 Agent 会话未建立或 worker 离线）</div>
              ) : planSteps.length === 0 ? (
                <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px dashed ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>暂无执行步骤（agent 拆解后自动出现）</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                  {planSteps.map((s: PlanStepItem, i: number) => {
                    const st = PLAN_STEP_THEME[s.status] ?? PLAN_STEP_THEME.pending;
                    return (
                      <div
                        key={s.id ?? `${i}-${s.content}`}
                        data-testid={`plan-step-${s.status}`}
                        title={s.priority ? `优先级 ${s.priority}` : undefined}
                        style={{ display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.sm, color: neutral[700], padding: `${space.xs}px ${space.sm}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, backgroundColor: "var(--color-surface)" }}
                      >
                        <span aria-hidden style={{ color: st.color, fontSize: fontSize.sm, flexShrink: 0, width: 16, textAlign: "center" }}>{st.icon}</span>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: s.status === "cancelled" ? "line-through" : "none", color: s.status === "cancelled" ? neutral[400] : neutral[700] }}>
                          {s.content}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
        {subTab === "output" && (
          <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
            <div>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700], marginBottom: space.sm }}>任务详情</div>
              <div style={{ fontSize: fontSize.sm, color: neutral[700], backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, borderRadius: radius.md, padding: `${space.sm}px ${space.md}px` }}>{task.title}</div>
              {task.description && <div style={{ marginTop: space.xs, fontSize: fontSize.xs, color: neutral[500], backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, borderRadius: radius.md, padding: `${space.sm}px ${space.md}px`, whiteSpace: "pre-wrap" }}>{task.description}</div>}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: space.sm }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>产出物</span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{artifactsQuery.data?.total ?? 0} 个</span>
              </div>
              {(artifactsQuery.data?.items ?? []).length === 0 ? (
                <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px dashed ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>暂无产出物</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                  {(artifactsQuery.data?.items ?? []).slice(0, 5).map((a: ArtifactItem) => {
                    const typeTheme = ARTIFACT_TYPE_THEME[a.type] ?? ARTIFACT_TYPE_THEME.file;
                    const row = (
                      <>
                        <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: typeTheme.color, flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{a.title ?? a.id}</span>
                          <span style={{ fontSize: 10, color: neutral[400] }}>
                            {ARTIFACT_TYPE_LABEL[a.type] ?? a.type} · v{a.currentVersion}{a.acceptedFlag ? " · 已验收" : ""}
                          </span>
                        </span>
                        {onOpenArtifactDoc && <span aria-hidden style={{ color: neutral[300], fontSize: fontSize.xs, flexShrink: 0 }}>›</span>}
                      </>
                    );
                    const rowStyle = { display: "flex", alignItems: "center", gap: space.sm, width: "100%", boxSizing: "border-box" as const, fontSize: fontSize.sm, color: neutral[700], padding: `${space.xs}px ${space.sm}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, backgroundColor: "var(--color-surface)" };
                    return onOpenArtifactDoc ? (
                      <button key={a.id} type="button" title="在文档站中查看" onClick={() => onOpenArtifactDoc(a)} style={{ ...rowStyle, cursor: "pointer", textAlign: "left", fontFamily: fontFamily.body }}>{row}</button>
                    ) : (
                      <div key={a.id} style={rowStyle}>{row}</div>
                    );
                  })}
                  <button type="button" onClick={onOpenArtifacts} style={{ fontSize: fontSize.xs, color: "#0D9488", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>查看全部 →</button>
                </div>
              )}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: space.sm }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>待办 Issue</span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{issuesQuery.data?.total ?? 0} 个</span>
              </div>
              {(issuesQuery.data?.items ?? []).length === 0 ? (
                <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px dashed ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>暂无 Issue</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                  {(issuesQuery.data?.items ?? []).slice(0, 5).map((it: TaskIssueItem) => {
                    const badge = ISSUE_STATUS_BADGE[it.status] ?? ISSUE_STATUS_BADGE.open;
                    const row = (
                      <>
                        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{it.title}</span>
                          <span style={{ fontSize: 10, color: badge.color }}>{badge.label}</span>
                        </span>
                        {onOpenIssueDetail && <span aria-hidden style={{ color: neutral[300], fontSize: fontSize.xs, flexShrink: 0 }}>›</span>}
                      </>
                    );
                    const rowStyle = { display: "flex", alignItems: "center", gap: space.sm, width: "100%", boxSizing: "border-box" as const, fontSize: fontSize.xs, color: neutral[700], padding: `${space.xs}px ${space.sm}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, backgroundColor: "var(--color-surface)" };
                    return onOpenIssueDetail ? (
                      <button key={it.id} type="button" title="查看 Issue 详情" onClick={() => onOpenIssueDetail(it.id)} style={{ ...rowStyle, cursor: "pointer", textAlign: "left", fontFamily: fontFamily.body }}>{row}</button>
                    ) : (
                      <div key={it.id} style={rowStyle}>{row}</div>
                    );
                  })}
                  <button type="button" onClick={onOpenIssues} style={{ fontSize: fontSize.xs, color: "#0D9488", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>查看全部 →</button>
                </div>
              )}
            </div>
          </div>
        )}
        {subTab === "triggers" && (
          <TaskTriggersBlock taskId={taskId} teamId={teamScopeId} />
        )}
      </div>
      {/* 计划文档弹窗：正文随列表已下发，纯展示不取数 */}
      <PlanDocModal doc={planDoc} onClose={() => setPlanDoc(null)} />
    </div>
  );
}

/** 执行步骤状态主题（对齐 serve todo status：pending/in_progress/completed/cancelled）。 */
const PLAN_STEP_THEME: Record<string, { icon: string; color: string }> = {
  completed: { icon: "✓", color: "#10B981" },
  in_progress: { icon: "◐", color: "#0D9488" },
  cancelled: { icon: "✕", color: neutral[300] },
  pending: { icon: "○", color: neutral[400] },
};

/** 计划文件更新时间短标签（文件被 agent 反复覆盖写，绝对时间意义不大）。 */
function planDocUpdatedLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚更新";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前更新`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前更新`;
  return new Date(t).toLocaleString();
}

/* ------------------------------------------------------------------ */
/* 主组件：团队 / 任务 双 Tab                                           */
/* ------------------------------------------------------------------ */
export function TaskRightTabs({ team, task, taskId, artifactsQuery, issuesQuery, agents, onEditTaskInfo, onOpenArtifacts, onOpenIssues, onToggleManagedMode, onOpenIssueDetail, onOpenArtifactDoc, onUploadPlanDoc, planDocsQuery, planStepsQuery }: {
  team: any; task: any; taskId: string; artifactsQuery: any; issuesQuery: any; agents: any[];
  onEditTaskInfo: () => void; onOpenArtifacts: () => void; onOpenIssues: () => void;
  onToggleManagedMode: (v: boolean) => void;
  onOpenIssueDetail?: (issueId: string) => void; onOpenArtifactDoc?: (artifact: ArtifactItem) => void;
  /** 上传计划文件入口（计划 Tab）；缺省不显示。 */
  onUploadPlanDoc?: () => void;
  /** 计划文档/执行步骤查询（计划 Tab 用；会话页提供并轮询）。 */
  planDocsQuery?: any; planStepsQuery?: any;
}) {
  const [activeMainTab, setActiveMainTab] = React.useState<"team" | "task">("team");
  const hasTask = !!task;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* 一级 Tab：团队 / 任务 */}
      <div style={{ display: "flex", borderBottom: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], flexShrink: 0 }}>
        <button type="button" onClick={() => setActiveMainTab("team")} style={{ flex: 1, minWidth: 0, padding: `${space.sm}px ${space.md}px`, border: "none", borderBottom: `2px solid ${activeMainTab === "team" ? "#0D9488" : "transparent"}`, backgroundColor: activeMainTab === "team" ? "var(--color-surface)" : "transparent", color: activeMainTab === "team" ? "#0D9488" : neutral[500], fontSize: fontSize.sm, fontWeight: activeMainTab === "team" ? 600 : 400, cursor: "pointer", fontFamily: fontFamily.body, whiteSpace: "nowrap" }}>
          团队
        </button>
        {hasTask && (
          <button type="button" onClick={() => setActiveMainTab("task")} style={{ flex: 1, minWidth: 0, padding: `${space.sm}px ${space.md}px`, border: "none", borderBottom: `2px solid ${activeMainTab === "task" ? "#0D9488" : "transparent"}`, backgroundColor: activeMainTab === "task" ? "var(--color-surface)" : "transparent", color: activeMainTab === "task" ? "#0D9488" : neutral[500], fontSize: fontSize.sm, fontWeight: activeMainTab === "task" ? 600 : 400, cursor: "pointer", fontFamily: fontFamily.body, whiteSpace: "nowrap" }}>
            任务
          </button>
        )}
      </div>
      {/* 内容区 */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {activeMainTab === "team" && <TeamSubTabs team={team} onToggleManagedMode={onToggleManagedMode} />}
        {activeMainTab === "task" && hasTask && (
          <TaskSubTabs
            team={team} task={task} taskId={taskId}
            artifactsQuery={artifactsQuery} issuesQuery={issuesQuery}
            agents={agents} onEditTaskInfo={onEditTaskInfo} onOpenArtifacts={onOpenArtifacts}
            onOpenIssues={onOpenIssues}
            onOpenIssueDetail={onOpenIssueDetail} onOpenArtifactDoc={onOpenArtifactDoc}
            onUploadPlanDoc={onUploadPlanDoc}
            planDocsQuery={planDocsQuery} planStepsQuery={planStepsQuery}
          />
        )}
      </div>
    </div>
  );
}
