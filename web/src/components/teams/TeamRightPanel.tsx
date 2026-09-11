"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { teamsApi, type TeamDto, type TeamQueueDto } from "@/src/api/teams";
import { AgentAvatar } from "@/src/components/ui";
import { TaskStatusActions } from "@/src/components/tasks/task-status-actions";
import {
  type RoleKey,
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
const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];
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
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: `${space.md}px ${space.lg}px`, display: "flex", flexDirection: "column", gap: space.lg }}>
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
/* 任务子 Tab                                                          */
/* ------------------------------------------------------------------ */
type TaskSubTab = "status" | "config" | "output";

function TaskSubTabs({ team, task, taskId, artifactsQuery, issuesQuery, plansQuery, agents, onEditTaskInfo, onOpenArtifacts, onOpenIssues, onToggleExecutionMode, onOpenIssueDetail, onOpenArtifactDoc }: {
  team: any; task: any; taskId: string; artifactsQuery: any; issuesQuery: any; plansQuery: any; agents: any[];
  onEditTaskInfo: () => void; onOpenArtifacts: () => void; onOpenIssues: () => void;
  onToggleExecutionMode: (v: "direct" | "plan") => void;
  onOpenIssueDetail?: (issueId: string) => void; onOpenArtifactDoc?: (artifact: ArtifactItem) => void;
}) {
  const [subTab, setSubTab] = useState<TaskSubTab>("status");
  const waiting = (team?.queue ?? []).filter((q: TeamQueueDto) => q.taskStatus === "queued" || !q.taskStatus).length;
  const isCurrent = team?.currentTaskId === taskId;
  const statusLabel = task ? (task.status === "queued" ? "排队中" : task.status === "pending" ? "待开始" : task.status === "in_progress" ? "进行中" : task.status === "pending_review" ? "待验收" : task.status === "completed" ? "已完成" : "已归档") : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", borderBottom: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], flexShrink: 0, overflowX: "auto" }}>
        {([
          { key: "status" as const, label: "状态", badge: waiting > 0 ? String(waiting) : null },
          { key: "config" as const, label: "配置", badge: null },
          { key: "output" as const, label: "产出", badge: artifactsQuery.data?.total ? String(artifactsQuery.data.total) : null },
        ]).map((tab) => (
          <button key={tab.key} type="button" onClick={() => setSubTab(tab.key)} style={subTabStyle(subTab === tab.key)}>
            {tab.label}
            {tab.badge && <span style={{ fontSize: 10, color: "#FFF", backgroundColor: subTab === tab.key ? "#0D9488" : "#F59E0B", padding: "0 5px", borderRadius: radius.pill, fontWeight: 700, marginLeft: space.xs }}>{tab.badge}</span>}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: `${space.md}px ${space.lg}px`, display: "flex", flexDirection: "column", gap: space.lg }}>
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
            <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>执行模式</div>
            <select value={task.executionMode} onChange={(e) => onToggleExecutionMode(e.target.value as "direct" | "plan")} style={{ padding: `2px 8px`, borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, color: neutral[700] }}>
              <option value="direct">轻量执行</option>
              <option value="plan">计划驱动</option>
            </select>
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

/* ------------------------------------------------------------------ */
/* 主组件：团队 / 任务 双 Tab                                           */
/* ------------------------------------------------------------------ */
export function TaskRightTabs({ team, task, taskId, artifactsQuery, issuesQuery, plansQuery, agents, onEditTaskInfo, onOpenArtifacts, onOpenIssues, onToggleManagedMode, onToggleExecutionMode, onOpenIssueDetail, onOpenArtifactDoc }: {
  team: any; task: any; taskId: string; artifactsQuery: any; issuesQuery: any; plansQuery: any; agents: any[];
  onEditTaskInfo: () => void; onOpenArtifacts: () => void; onOpenIssues: () => void;
  onToggleManagedMode: (v: boolean) => void; onToggleExecutionMode: (v: "direct" | "plan") => void;
  onOpenIssueDetail?: (issueId: string) => void; onOpenArtifactDoc?: (artifact: ArtifactItem) => void;
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
      <div style={{ flex: 1, minHeight: 0, overflowY: "hidden" }}>
        {activeMainTab === "team" && <TeamSubTabs team={team} onToggleManagedMode={onToggleManagedMode} />}
        {activeMainTab === "task" && hasTask && (
          <TaskSubTabs
            team={team} task={task} taskId={taskId}
            artifactsQuery={artifactsQuery} issuesQuery={issuesQuery} plansQuery={plansQuery}
            agents={agents} onEditTaskInfo={onEditTaskInfo} onOpenArtifacts={onOpenArtifacts}
            onOpenIssues={onOpenIssues} onToggleExecutionMode={onToggleExecutionMode}
            onOpenIssueDetail={onOpenIssueDetail} onOpenArtifactDoc={onOpenArtifactDoc}
          />
        )}
      </div>
    </div>
  );
}
