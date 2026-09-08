"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { teamsApi, type TeamDto, type TeamQueueDto } from "@/src/api/teams";
import { AgentAvatar } from "@/src/components/ui";
import { TaskStatusActions } from "@/src/components/tasks/task-status-actions";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";
import type { TaskDetail, TaskApiStatus, ArtifactItem, TaskIssueItem } from "@/src/components/tasks/task-detail-types";
import { ARTIFACT_TYPE_THEME, ARTIFACT_TYPE_LABEL, ISSUE_STATUS_BADGE } from "@/src/components/tasks/task-detail-types";

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
    <div data-testid="team-queue-card" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: isQueued ? "rgba(245,158,11,0.10)" : isCurrent ? "rgba(37,99,235,0.08)" : neutral[50], border: `1px solid ${isQueued ? "rgba(245,158,11,0.28)" : isCurrent ? "rgba(37,99,235,0.22)" : neutral[200]}`, display: "flex", flexDirection: "column", gap: space.sm }}>
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
          <button
            type="button"
            data-testid="queue-cancel-current"
            data-task-id={taskId}
            disabled={cancelMutation.isPending}
            onClick={() => cancelMutation.mutate(taskId)}
            style={{ marginLeft: "auto", padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.pill, border: "1px solid rgba(239,68,68,0.22)", backgroundColor: "rgba(239,68,68,0.06)", color: "#DC2626", fontSize: fontSize.xs, fontWeight: 500, cursor: cancelMutation.isPending ? "default" : "pointer", opacity: cancelMutation.isPending ? 0.6 : 1, fontFamily: fontFamily.body }}
          >
            {cancelMutation.isPending ? "取消中…" : "取消排队"}
          </button>
        </div>
      ) : isCurrent ? (
        <div data-testid="queue-current" style={{ fontSize: fontSize.sm, color: "#2563EB", fontWeight: 500 }}>当前执行中（队首）</div>
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
                  <span style={{ display: "flex", alignItems: "center", gap: space.xs }}>
                    <span data-testid="queue-item-status" style={{ fontSize: 10, color: canCancel ? "#D97706" : neutral[500], backgroundColor: canCancel ? "rgba(245,158,11,0.10)" : neutral[100], border: `1px solid ${canCancel ? "rgba(245,158,11,0.22)" : neutral[200]}`, borderRadius: radius.pill, padding: "0 4px", fontWeight: 600 }}>{canCancel ? "排队中" : qStatus}</span>
                    <span style={{ fontFamily: fontFamily.mono, fontSize: 10, color: neutral[400], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.taskId.slice(0, 10)}…</span>
                  </span>
                </div>
                <span style={{ fontSize: 10, color: neutral[400], flexShrink: 0 }}>{new Date(q.enqueuedAt).toLocaleDateString()}</span>
                <button
                  type="button"
                  data-testid="queue-cancel"
                  data-task-id={q.taskId}
                  disabled={!canCancel || cancelMutation.isPending}
                  title={!canCancel ? "仅排队中的任务可取消" : "取消排队"}
                  onClick={() => canCancel && cancelMutation.mutate(q.taskId)}
                  style={{ padding: "2px 8px", borderRadius: radius.pill, border: `1px solid ${!canCancel ? neutral[200] : "rgba(239,68,68,0.22)"}`, backgroundColor: !canCancel ? neutral[100] : "rgba(239,68,68,0.06)", color: !canCancel ? neutral[400] : "#DC2626", fontSize: 10, fontWeight: 500, cursor: !canCancel || cancelMutation.isPending ? "not-allowed" : "pointer", opacity: !canCancel ? 0.6 : 1, fontFamily: fontFamily.body, flexShrink: 0 }}
                >
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

export function TeamMemoryCard({ team, task }: { team: TeamDto | null | undefined; task: TaskDetail }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const toggleMutation = useMutation({
    mutationFn: (next: boolean) => api.patch<TaskDetail>(`/tasks/${task.id}`, { resetAfterComplete: next }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["task", task.id], updated);
      setError(null);
    },
    onError: (err) => setError(isApiError(err) ? err.message : "更新失败"),
  });
  const effectiveNewSession = task.resetAfterComplete ? true : !team?.reuseSession ? true : false;
  return (
    <div data-testid="team-memory-card" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, display: "flex", flexDirection: "column", gap: space.sm }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>记忆开关</span>
        <span style={{ fontSize: 10, color: team?.reuseSession ? "#2563EB" : "#D97706", backgroundColor: team?.reuseSession ? "rgba(37,99,235,0.08)" : "rgba(245,158,11,0.10)", border: `1px solid ${team?.reuseSession ? "rgba(37,99,235,0.14)" : "rgba(245,158,11,0.22)"}`, padding: "0 6px", borderRadius: radius.pill, fontWeight: 600 }}>{team?.reuseSession ? "默认保留" : "每任务新会话"}</span>
      </div>
      <div data-testid="reuse-explain" style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, borderRadius: radius.md, padding: `${space.sm}px ${space.md}px` }}>
        {team?.reuseSession ? (
          <span><span style={{ fontWeight: 600, color: "#2563EB" }}>团队默认保留</span>：会话跨任务复用，上下文与历史延续。</span>
        ) : (
          <span><span style={{ fontWeight: 600, color: "#D97706" }}>团队每任务新会话</span>：每任务独立会话，历史隔离。</span>
        )}
        <span style={{ display: "block", marginTop: space.xs, color: neutral[400] }}>任务级勾选可覆盖团队默认。</span>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, backgroundColor: task.resetAfterComplete ? "rgba(37,99,235,0.06)" : neutral[50], border: `1px solid ${task.resetAfterComplete ? "rgba(37,99,235,0.14)" : neutral[200]}`, cursor: toggleMutation.isPending ? "default" : "pointer" }}>
        <input type="checkbox" data-testid="reset-after-complete-toggle" checked={!!task.resetAfterComplete} disabled={toggleMutation.isPending} onChange={(e) => toggleMutation.mutate(e.target.checked)} style={{ width: 16, height: 16, accentColor: "#2563EB" }} />
        <span style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>完成后为下一任务开新会话</span>
          <span style={{ fontSize: 10, color: neutral[400] }}>勾选后，本任务完成/归档时为团队所有成员开新会话，下一任务上下文全新</span>
        </span>
      </label>
      {effectiveNewSession && <span data-testid="memory-effective" style={{ fontSize: 10, color: "#D97706" }}>生效：下一任务将开新会话（{task.resetAfterComplete ? "任务级覆盖" : "团队设置"}）</span>}
      {!effectiveNewSession && <span style={{ fontSize: 10, color: neutral[400] }}>生效：下一任务复用当前会话</span>}
      {error && <span style={{ fontSize: fontSize.xs, color: "#DC2626" }}>{error}</span>}
      {toggleMutation.isPending && <span style={{ fontSize: 10, color: neutral[400] }}>更新中…</span>}
    </div>
  );
}

export function TaskRightTabs({ team, task, taskId, artifactsQuery, issuesQuery, plansQuery, agents, onEditTaskInfo, onOpenArtifacts, onOpenIssues, onToggleManagedMode, onToggleExecutionMode, onOpenIssueDetail, onOpenArtifactDoc }: { team: any; task: any; taskId: string; artifactsQuery: any; issuesQuery: any; plansQuery: any; agents: any[]; onEditTaskInfo: () => void; onOpenArtifacts: () => void; onOpenIssues: () => void; onToggleManagedMode: (v: boolean) => void; onToggleExecutionMode: (v: "direct" | "plan") => void; onOpenIssueDetail?: (issueId: string) => void; onOpenArtifactDoc?: (artifact: ArtifactItem) => void }) {
  const [active, setActive] = React.useState<"status" | "config" | "output">("status");
  const waiting = (team?.queue ?? []).filter((q: TeamQueueDto) => q.taskStatus === "queued" || !q.taskStatus).length;
  const isCurrent = team?.currentTaskId === taskId;
  const statusLabel = task ? (task.status === "queued" ? "排队中" : task.status === "pending" ? "待开始" : task.status === "in_progress" ? "进行中" : task.status === "pending_review" ? "待验收" : task.status === "completed" ? "已完成" : "已归档") : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", borderBottom: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], flexShrink: 0 }}>
        {[
          { key: "status" as const, label: "状态", badge: waiting > 0 ? String(waiting) : null },
          { key: "config" as const, label: "配置", badge: null },
          { key: "output" as const, label: "产出", badge: artifactsQuery.data?.total ? String(artifactsQuery.data.total) : null },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            data-testid={`right-tab-${tab.key}`}
            data-active={active === tab.key ? "true" : "false"}
            onClick={() => setActive(tab.key)}
            style={{
              flex: 1,
              padding: `${space.sm}px ${space.md}px`,
              border: "none",
              borderBottom: `2px solid ${active === tab.key ? "#2563EB" : "transparent"}`,
              backgroundColor: active === tab.key ? "var(--color-surface)" : "transparent",
              color: active === tab.key ? "#2563EB" : neutral[500],
              fontSize: fontSize.sm,
              fontWeight: active === tab.key ? 600 : 400,
              cursor: "pointer",
              fontFamily: fontFamily.body,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: space.xs,
            }}
          >
            {tab.label}
            {tab.badge && <span style={{ fontSize: 10, color: "#FFF", backgroundColor: active === tab.key ? "#2563EB" : "#F59E0B", padding: "0 5px", borderRadius: radius.pill, fontWeight: 700 }}>{tab.badge}</span>}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: `${space.md}px ${space.lg}px`, display: "flex", flexDirection: "column", gap: space.lg }}>
        {active === "status" && (
          <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
            <div style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: isCurrent ? "rgba(37,99,235,0.06)" : waiting > 0 ? "rgba(245,158,11,0.06)" : "var(--color-surface)", border: `1px solid ${isCurrent ? "rgba(37,99,235,0.14)" : waiting > 0 ? "rgba(245,158,11,0.14)" : neutral[200]}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: task.status === "in_progress" ? "#10B981" : task.status === "queued" ? "#F59E0B" : task.status === "pending" ? "#2563EB" : neutral[300] }} />
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>{task.title}</span>
                <span style={{ fontSize: fontSize.xs, color: "#FFF", backgroundColor: task.status === "queued" ? "#F59E0B" : task.status === "in_progress" ? "#10B981" : "#2563EB", padding: "1px 6px", borderRadius: radius.pill }}>{statusLabel}</span>
              </div>
              <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>
                {isCurrent ? "当前执行（队首）" : team?.currentTaskId ? `队首 ${team.currentTaskId.slice(0,8)}… 执行中` : "团队空闲"} · {waiting > 0 ? `等待中 ${waiting} 个` : "暂无等待"}
              </div>
              {team?.name && (
                <div style={{ fontSize: fontSize.xs, color: neutral[600], backgroundColor: "rgba(37,99,235,0.04)", border: `1px solid ${neutral[200]}`, borderRadius: radius.md, padding: `${space.sm}px ${space.md}px`, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                  {team.name}
                </div>
              )}
              <div style={{ display: "flex", gap: space.sm }}>
                <TaskStatusActions taskId={taskId} status={task.status as TaskApiStatus} />
                <button type="button" onClick={onEditTaskInfo} style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>编辑</button>
              </div>
            </div>
            <TeamQueueCard team={team} taskId={taskId} />
            <div style={{ fontSize: fontSize.xs, color: neutral[500], backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, borderRadius: radius.md, padding: `${space.sm}px ${space.md}px`, display: "flex", alignItems: "center", gap: space.xs }}>
              <span style={{ fontWeight: 600, color: team?.reuseSession ? "#2563EB" : "#D97706" }}>{team?.reuseSession ? "默认保留" : "每任务新会话"}</span>
              <span>· {team?.reuseSession ? "会话跨任务复用" : "每任务新会话"}，{task.resetAfterComplete ? "本任务完成后为下一任务开新会话" : "下一任务复用当前会话"}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>主 Agent</span>
              <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>{(team?.members?.find((m:any)=>m.id===team.mainAgentMemberId)?.alias ?? task.mainAgentId ?? "未指定")}</span>
              {team?.mainAgentMemberId && <span style={{ fontSize: 10, color: "#FFF", backgroundColor: "#F59E0B", padding: "0 5px", borderRadius: radius.pill }}>★ 主 Agent</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>团队</span>
              <span style={{ display: "flex" }}>{(agents ?? []).slice(0,5).map((a:any,i:number)=>(<span key={a.id} style={{ marginLeft: i===0?0:-6 }}><AgentAvatar role={a.role} size="sm" style={{ border: "2px solid #FFF" }} /></span>))}</span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{(agents ?? []).length} 人</span>
            </div>
          </div>
        )}
        {active === "config" && (
          <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
            <div style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: `${space.md}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, backgroundColor: "var(--color-surface)" }}>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>执行与托管</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: fontSize.sm, color: neutral[600] }}>执行模式</span>
                <select value={task.executionMode} onChange={(e)=>onToggleExecutionMode(e.target.value as "direct" | "plan")} style={{ padding: `2px 8px`, borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.xs, color: neutral[700] }}>
                  <option value="direct">轻量执行</option>
                  <option value="plan">计划驱动</option>
                </select>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: fontSize.sm, color: neutral[600] }}>托管模式</span>
                <span onClick={()=>onToggleManagedMode(!(team?.managedMode ?? false))} role="switch" aria-checked={team?.managedMode ?? false} style={{ width: 36, height: 20, borderRadius: 10, backgroundColor: (team?.managedMode ?? false) ? "#2563EB" : neutral[300], position: "relative", cursor: "pointer" }}><span style={{ position: "absolute", top: 2, left: (team?.managedMode ?? false) ? 18 : 2, width: 16, height: 16, borderRadius: "50%", backgroundColor: "#FFF", transition: "left .2s" }} /></span>
              </div>
            </div>
            <TeamMemoryCard team={team} task={task} />
            <div style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: `${space.md}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md }}>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>渠道绑定</div>
              <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>消息与通知渠道可在任务操作中配置，团队级记忆在状态 Tab 查看。</div>
              <button type="button" onClick={()=>{ const el=document.querySelector('[data-testid="task-channel-binding-section"]') as HTMLElement; el?.scrollIntoView({behavior:"smooth", block:"center"}); el?.focus(); }} style={{ alignSelf: "flex-start", fontSize: fontSize.xs, color: "#2563EB", background: "none", border: "none", cursor: "pointer" }}>去配置 →</button>
            </div>
          </div>
        )}
        {active === "output" && (
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
                    const rowStyle = {
                      display: "flex", alignItems: "center", gap: space.sm, width: "100%", boxSizing: "border-box" as const,
                      fontSize: fontSize.sm, color: neutral[700], padding: `${space.xs}px ${space.sm}px`,
                      border: `1px solid ${neutral[200]}`, borderRadius: radius.md, backgroundColor: "var(--color-surface)",
                    };
                    return onOpenArtifactDoc ? (
                      <button key={a.id} type="button" title="在文档站中查看" onClick={() => onOpenArtifactDoc(a)} style={{ ...rowStyle, cursor: "pointer", textAlign: "left", fontFamily: fontFamily.body }}>{row}</button>
                    ) : (
                      <div key={a.id} style={rowStyle}>{row}</div>
                    );
                  })}
                  <button type="button" onClick={onOpenArtifacts} style={{ fontSize: fontSize.xs, color: "#2563EB", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>查看全部 →</button>
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
                    const rowStyle = {
                      display: "flex", alignItems: "center", gap: space.sm, width: "100%", boxSizing: "border-box" as const,
                      fontSize: fontSize.xs, color: neutral[700], padding: `${space.xs}px ${space.sm}px`,
                      border: `1px solid ${neutral[200]}`, borderRadius: radius.md, backgroundColor: "var(--color-surface)",
                    };
                    return onOpenIssueDetail ? (
                      <button key={it.id} type="button" title="查看 Issue 详情" onClick={() => onOpenIssueDetail(it.id)} style={{ ...rowStyle, cursor: "pointer", textAlign: "left", fontFamily: fontFamily.body }}>{row}</button>
                    ) : (
                      <div key={it.id} style={rowStyle}>{row}</div>
                    );
                  })}
                  <button type="button" onClick={onOpenIssues} style={{ fontSize: fontSize.xs, color: "#2563EB", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>查看全部 →</button>
                </div>
              )}
            </div>
            <div>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700], marginBottom: space.sm }}>执行计划</div>
              {plansQuery.data ? (
                <div style={{ fontSize: fontSize.xs, color: neutral[600], padding: `${space.sm}px ${space.md}px`, border: `1px solid ${neutral[200]}`, borderRadius: radius.md }}>{plansQuery.data?.title ?? "已有计划"}</div>
              ) : (
                <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: `${space.md}px`, border: `1px dashed ${neutral[200]}`, borderRadius: radius.md, textAlign: "center" }}>暂无执行计划</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

