"use client";

/**
 * TeamMembersTab：团队右栏「成员」子页 —— 成员列表配置
 * =============================================================
 * 需求（2026-11-18）：团队子 Tab 里要有成员列表配置，支持
 *   1) 管理成员（改名/别名、设为主 Agent）
 *   2) 快速添加 / 移除成员
 *   3) 配置成员模型、节点（Worker）
 *   4) **移除走「踢出团队」**，绝不删除平台成员库记录
 *
 * 关键语义（与 /teams/:id 详情页那条「移除」保持同一后端口径）：
 * - 移除 = `DELETE /teams/:teamId/members/:seatId`（`teamsApi.removeMember`）
 *   只删**席位**（team_members 行），并把会话/频道/任务实例上的 teamMemberId 解绑；
 *   平台成员（members 表）原封不动 —— 之后还能加回来、还能在成员库里看到。
 * - **绝不**调用 `DELETE /members/:id`（那才是真删成员；`cascadeSeats` 甚至会把该成员
 *   从所有群聊里清掉）。为了不让后人再踩，本文件里没有任何 membersApi.remove 调用，
 *   e2e 里有一条断言锁死「移除只打 team members 端点」。
 *
 * 布局取舍：右栏只有 240~520px 宽，一行塞不下「模型 + 节点 + 更多操作」，
 * 所以每个成员是一张卡：第一行身份 + 状态 + 操作，第二行两个下拉（模型 / 节点）
 * 就地可改 —— 不需要像左侧面板那样先进「⋯ 菜单」再展开选择器。
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { teamsApi, type TeamDto, type TeamMemberDto } from "@/src/api/teams";
import { agentRolesApi } from "@/src/api/agent-roles";
import { membersApi, type MemberDto } from "@/src/api/members";
import { AgentAvatar, ConfirmDialog, SearchableSelect } from "@/src/components/ui";
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
import { PRESENCE_COLOR, resolveMemberPresence } from "@/lib/member-presence";

/** 席位 → 角色 key（未知 roleId / agent.role 回退 developer，和会话页同口径）。 */
function toRoleKey(value: string | null | undefined): RoleKey {
  return value && (ROLE_KEYS as readonly string[]).includes(value)
    ? (value as RoleKey)
    : "developer";
}

function errorText(err: unknown): string {
  if (isApiError(err)) return err.message;
  return err instanceof Error ? err.message : "操作失败";
}

/** GET /workers 条目（只取本页用得到的字段）。 */
interface WorkerRow {
  id: string;
  name: string | null;
  status: string;
}

/** GET /models 条目（available=1，仅可用模型）。 */
interface ModelRow {
  id: string;
  name: string;
  providerID: string;
}

export function TeamMembersTab({
  team,
  memberById,
  onToast,
}: {
  team: TeamDto;
  /** 平台成员投影（会话页已有的 ["members","directory"] 缓存；缺省也能工作）。 */
  memberById?: Map<string, MemberDto>;
  /** 操作结果提示（父级顶栏 toast；缺省静默）。 */
  onToast?: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const teamId = team.id;
  const [addOpen, setAddOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<TeamMemberDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seats = team.members ?? [];
  const mainSeatId = team.mainAgentMemberId ?? null;

  /* ---------------- 数据源 ---------------- */
  // 节点清单：复用 ["workers"] 缓存（团队详情/会话页同 key，不新造请求）
  const workersQuery = useQuery({
    queryKey: ["workers"],
    queryFn: () => api.get<WorkerRow[]>("/workers"),
  });
  // 模型目录：仅可用模型（与 TeamRuntimeConfig 的团队默认模型选择器同源同参）
  const modelsQuery = useQuery({
    queryKey: ["models", "team-members-tab"],
    queryFn: () =>
      api.get<{ items: ModelRow[] }>("/models", {
        query: { page: 1, pageSize: 200, available: 1 },
      }),
  });
  const roleQuery = useQuery({
    queryKey: ["agent-roles", "team-members-tab"],
    queryFn: () => agentRolesApi.list({ page: 1, pageSize: 100 }),
  });
  const roleKeyById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of roleQuery.data?.items ?? []) map.set(r.id, r.key);
    return map;
  }, [roleQuery.data]);

  const workers = useMemo<WorkerRow[]>(() => workersQuery.data ?? [], [workersQuery.data]);
  // 在线优先 + 名称排序（与团队详情页/左侧面板同一口径）
  const workerOptions = useMemo(() => {
    const sorted = [...workers].sort((a, b) => {
      if (a.status !== "offline" && b.status === "offline") return -1;
      if (a.status === "offline" && b.status !== "offline") return 1;
      return (a.name ?? a.id).localeCompare(b.name ?? b.id);
    });
    return [
      {
        value: "",
        // 面板窄：标签保持短，"跟随团队"本身就是完整语义，团队节点名放进 keywords
        // 供搜索命中，不再塞进 label（否则 240px 宽时被截成「跟随团队（keta-team…」）。
        label: "跟随团队",
        keywords: `跟随团队 自动调度 ${team.preferredWorkerId ? workerLabelOf(workers, team.preferredWorkerId) : ""}`,
      },
      ...sorted.map((w) => ({
        value: w.id,
        label: `${w.name ?? w.id}${w.status === "offline" ? "（离线）" : ""}`,
        keywords: `${w.name ?? ""} ${w.id}`,
      })),
    ];
  }, [workers, team.preferredWorkerId]);

  const modelOptions = useMemo(
    () => [
      {
        value: "",
        label: "跟随团队默认",
        keywords: `跟随团队 默认 ${team.defaultModelId ? modelLabelOf(modelsQuery.data?.items ?? [], team.defaultModelId) : ""}`,
      },
      ...(modelsQuery.data?.items ?? []).map((m) => ({
        value: m.id,
        label: `${m.providerID} · ${m.name}`,
        keywords: `${m.providerID} ${m.name}`,
      })),
    ],
    [modelsQuery.data, team.defaultModelId],
  );

  /* ---------------- 变更 ---------------- */
  /** 席位配置（别名/模型/节点/主 Agent 同一条 PATCH）。 */
  const patchSeat = useMutation({
    mutationFn: ({
      seatId,
      payload,
    }: {
      seatId: string;
      payload: {
        alias?: string;
        overrideModelId?: string | null;
        preferredWorkerId?: string | null;
      };
    }) => teamsApi.updateMember(teamId, seatId, payload),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["team", teamId] });
      // 会话页成员面板优先读聚焦任务实例（["task", id]），两处都要失效
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["task"] });
      queryClient.invalidateQueries({ queryKey: ["team-tasks", teamId] });
    },
    onError: (err) => setError(errorText(err)),
  });

  const setMainMutation = useMutation({
    mutationFn: (seatId: string) =>
      teamsApi.update(teamId, { mainAgentMemberId: seatId }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["team", teamId] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
    onError: (err) => setError(errorText(err)),
  });

  /**
   * 踢出团队：`DELETE /teams/:teamId/members/:seatId`。
   * 只删席位、解绑会话/频道/任务实例；平台成员记录保留（可再次加入）。
   */
  const kickMutation = useMutation({
    mutationFn: (seatId: string) => teamsApi.removeMember(teamId, seatId),
    onSuccess: () => {
      setError(null);
      setPendingRemove(null);
      queryClient.invalidateQueries({ queryKey: ["team", teamId] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["members"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      onToast?.("已将该成员移出团队（平台成员记录保留）");
    },
    onError: (err) => {
      setError(errorText(err));
      setPendingRemove(null);
    },
  });

  return (
    <div data-testid="team-members-tab" style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      {/* 顶部工具条：计数 + 添加 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: fontSize.sm, fontWeight: 700, color: neutral[800] }}>
            成员 · {seats.length}
          </div>
          <div style={{ fontSize: 10, color: neutral[400], lineHeight: 1.5 }}>
            模型 / 节点按席位生效，空白 = 跟随团队默认
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="members-tab-add"
          onClick={() => {
            setError(null);
            setAddOpen(true);
          }}
          style={{
            flexShrink: 0,
            padding: `5px ${space.md}px`,
            borderRadius: radius.md,
            border: "none",
            backgroundColor: "#0D9488",
            color: "#FFF",
            fontSize: fontSize.xs,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: fontFamily.body,
            whiteSpace: "nowrap",
          }}
        >
          ＋ 添加成员
        </button>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="members-tab-error"
          style={{
            padding: `${space.xs}px ${space.sm}px`,
            borderRadius: radius.sm,
            backgroundColor: "rgba(220,38,38,0.08)",
            border: "1px solid rgba(220,38,38,0.20)",
            color: "var(--color-danger-text)",
            fontSize: fontSize.xs,
          }}
        >
          {error}
        </div>
      )}

      {seats.length === 0 ? (
        <div
          data-testid="members-tab-empty"
          style={{
            padding: `${space.xl}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px dashed ${neutral[300]}`,
            textAlign: "center",
            fontSize: fontSize.xs,
            color: neutral[400],
            lineHeight: 1.7,
          }}
        >
          还没有成员。点右上角「＋ 添加成员」把平台成员加进这个团队。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          {seats.map((seat) => (
            <SeatCard
              key={seat.id}
              seat={seat}
              isMain={seat.id === mainSeatId}
              roleKey={toRoleKey(
                roleKeyById.get(seat.roleId ?? "") ?? seat.agent?.role ?? null,
              )}
              member={memberById?.get(seat.memberId ?? "") ?? null}
              teamPreferredWorkerId={team.preferredWorkerId ?? null}
              teamDefaultModelId={team.defaultModelId ?? null}
              workerOptions={workerOptions}
              modelOptions={modelOptions}
              models={modelsQuery.data?.items ?? []}
              workers={workers}
              busy={patchSeat.isPending}
              mainPending={setMainMutation.isPending}
              onPatch={(payload) => patchSeat.mutate({ seatId: seat.id, payload })}
              onSetMain={() => {
                if (!setMainMutation.isPending) setMainMutation.mutate(seat.id);
              }}
              onKick={() => {
                setError(null);
                setPendingRemove(seat);
              }}
            />
          ))}
        </div>
      )}

      {addOpen && (
        <AddMemberPanel
          team={team}
          onClose={() => setAddOpen(false)}
          onDone={() => {
            setAddOpen(false);
            queryClient.invalidateQueries({ queryKey: ["team", teamId] });
            queryClient.invalidateQueries({ queryKey: ["teams"] });
            queryClient.invalidateQueries({ queryKey: ["members"] });
            onToast?.("成员已加入团队");
          }}
          onError={(text) => setError(text)}
        />
      )}

      {/* 踢出确认：文案明确「移出团队，不删除成员」 */}
      <ConfirmDialog
        open={!!pendingRemove}
        testid="members-tab-kick-confirm"
        title="移出团队"
        description={`确认把「${seatDisplayName(pendingRemove)}」移出团队？该成员的会话与任务历史会保留，平台成员记录不会被删除，之后还可以重新加入。`}
        confirmLabel="移出团队"
        pendingLabel="移出中…"
        submitting={kickMutation.isPending}
        onConfirm={() => {
          if (pendingRemove) kickMutation.mutate(pendingRemove.id);
        }}
        onClose={() => setPendingRemove(null)}
      />
    </div>
  );
}

/* -------------------------------------------------------------- */
/* 席位卡片：身份 + 状态 + 模型/节点下拉 + 操作                     */
/* -------------------------------------------------------------- */

function SeatCard({
  seat,
  isMain,
  roleKey,
  member,
  teamPreferredWorkerId,
  teamDefaultModelId,
  workerOptions,
  modelOptions,
  models,
  workers,
  busy,
  mainPending,
  onPatch,
  onSetMain,
  onKick,
}: {
  seat: TeamMemberDto;
  isMain: boolean;
  roleKey: RoleKey;
  member: MemberDto | null;
  teamPreferredWorkerId: string | null;
  teamDefaultModelId: string | null;
  workerOptions: Array<{ value: string; label: string; keywords?: string }>;
  modelOptions: Array<{ value: string; label: string; keywords?: string }>;
  models: ModelRow[];
  workers: WorkerRow[];
  busy: boolean;
  mainPending: boolean;
  onPatch: (payload: {
    alias?: string;
    overrideModelId?: string | null;
    preferredWorkerId?: string | null;
  }) => void;
  onSetMain: () => void;
  onKick: () => void;
}) {
  const [alias, setAlias] = useState(seat.alias ?? "");
  const [editingAlias, setEditingAlias] = useState(false);

  const presence = resolveMemberPresence(
    seat.sessionStatus,
    member?.session ?? null,
    member?.session?.currentTeamId && member.session.currentTeamId !== seat.teamId
      ? "正在其他群执行"
      : "正在执行",
  );
  const theme = roles[roleKey];
  const displayName = seat.member?.name ?? seat.alias ?? seat.agent?.name ?? seat.agentId;

  /** 生效模型：席位覆盖 → 团队默认 → 未指定（与左侧成员面板 chip 同口径）。 */
  const effectiveModelId = seat.overrideModelId ?? teamDefaultModelId ?? "";
  const effectiveWorkerId = seat.preferredWorkerId ?? teamPreferredWorkerId ?? "";

  return (
    <div
      data-testid="members-tab-seat"
      data-seat-id={seat.id}
      data-main={isMain ? "true" : "false"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: "var(--color-surface)",
        border: `1px solid ${isMain ? "rgba(245,158,11,0.40)" : neutral[200]}`,
      }}
    >
      {/* 第 1 行：头像 + 名字/角色 + 状态 + 主 Agent + 操作 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <span style={{ position: "relative", flexShrink: 0, display: "inline-flex" }}>
          <AgentAvatar role={roleKey} size="sm" />
          {presence.tone !== "idle" && (
            <span
              data-testid={`members-tab-presence-${presence.tone}`}
              aria-label={presence.label}
              title={presence.label}
              style={{
                position: "absolute",
                right: -1,
                top: -1,
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: PRESENCE_COLOR[presence.tone],
                border: "1.5px solid #FFF",
              }}
            />
          )}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          {editingAlias ? (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                data-testid={`members-tab-alias-input-${seat.id}`}
                autoFocus
                value={alias}
                maxLength={64}
                onChange={(e) => setAlias(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setAlias(seat.alias ?? "");
                    setEditingAlias(false);
                  }
                  if (e.key === "Enter") {
                    onPatch({ alias: alias.trim() || undefined });
                    setEditingAlias(false);
                  }
                }}
                placeholder="群内别名"
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "3px 6px",
                  borderRadius: radius.sm,
                  border: `1px solid ${neutral[200]}`,
                  fontSize: fontSize.xs,
                  fontFamily: fontFamily.body,
                  color: neutral[800],
                }}
              />
              <button
                type="button"
                data-testid={`members-tab-alias-save-${seat.id}`}
                onClick={() => {
                  onPatch({ alias: alias.trim() || undefined });
                  setEditingAlias(false);
                }}
                style={miniBtn("#0D9488")}
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => {
                  setAlias(seat.alias ?? "");
                  setEditingAlias(false);
                }}
                style={miniBtn(neutral[500])}
              >
                取消
              </button>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
                /*
                 * 右侧面板只有 240~520px：角色徽章 + 主 Agent 徽章 + 长名字经常一行放不下。
                 * 原来 nowrap 的子项会把徽章挤出卡片外（截图里 ★主 Agent 被裁掉一半），
                 * 这里允许换行，徽章整体掉到第二行而不是横向溢出。
                 */
                flexWrap: "wrap",
                rowGap: 2,
              }}
            >
              <span
                title={displayName}
                style={{
                  fontSize: fontSize.sm,
                  fontWeight: 600,
                  color: neutral[800],
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "100%",
                  minWidth: 0,
                }}
              >
                {seat.alias ?? displayName}
              </span>
              {seat.alias && seat.member?.name && seat.alias !== seat.member.name && (
                <span
                  style={{
                    fontSize: 10,
                    color: neutral[400],
                    maxWidth: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={seat.member.name}
                >
                  （{seat.member.name}）
                </span>
              )}
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 10,
                  color: theme.color,
                  backgroundColor: theme.bg,
                  border: `1px solid ${theme.border}`,
                  padding: "0 5px",
                  borderRadius: radius.pill,
                }}
              >
                {theme.label}
              </span>
              {isMain && (
                <span
                  data-testid="members-tab-main-badge"
                  style={{
                    flexShrink: 0,
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#FFF",
                    backgroundColor: "#F59E0B",
                    padding: "0 5px",
                    borderRadius: radius.pill,
                  }}
                >
                  ★ 主 Agent
                </span>
              )}
            </div>
          )}
          <div
            style={{
              fontSize: 10,
              color: presence.tone === "idle" ? neutral[400] : PRESENCE_COLOR[presence.tone],
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            #{seat.seq} · {presence.label}
          </div>
        </div>
        <span style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        <button
          type="button"
          data-testid={`members-tab-edit-alias-${seat.id}`}
          title="修改群内别名"
          aria-label="修改群内别名"
          onClick={() => setEditingAlias(true)}
          style={iconBtn}
        >
          ✎
        </button>
        {!isMain && (
          <button
            type="button"
            data-testid={`members-tab-set-main-${seat.id}`}
            title="设为主 Agent"
            aria-label="设为主 Agent"
            disabled={mainPending || busy}
            onClick={onSetMain}
            style={{ ...iconBtn, opacity: mainPending || busy ? 0.5 : 1 }}
          >
            ★
          </button>
        )}
        <button
          type="button"
          data-testid={`members-tab-kick-${seat.id}`}
          title="移出团队（不删除成员）"
          aria-label="移出团队"
          onClick={onKick}
          style={{ ...iconBtn, color: "var(--color-danger-text)", borderColor: "rgba(185,28,28,0.28)" }}
        >
          ⨯
        </button>
        </span>
      </div>

      {/* 第 2 行：模型 / 节点（就地可改，空白=跟随团队） */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: space.sm }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 10, color: neutral[400] }}>模型</span>
          <SearchableSelect
            testId={`members-tab-model-${seat.id}`}
            value={seat.overrideModelId ?? ""}
            onChange={(v) => onPatch({ overrideModelId: v || null })}
            placeholder={effectiveModelId ? modelLabelOf(models, effectiveModelId) : "跟随团队默认"}
            /* 未覆盖时不显示当前值，只显示"跟随团队默认"，实际生效值在 title 里 */
            searchPlaceholder="搜索模型 / provider"
            options={modelOptions}
            disabled={busy}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 10, color: neutral[400] }}>节点</span>
          <SearchableSelect
            testId={`members-tab-worker-${seat.id}`}
            value={seat.preferredWorkerId ?? ""}
            onChange={(v) => onPatch({ preferredWorkerId: v || null })}
            placeholder={effectiveWorkerId ? workerLabelOf(workers, effectiveWorkerId) : "跟随团队"}
            searchPlaceholder="搜索节点"
            options={workerOptions}
            disabled={busy}
          />
        </label>
      </div>

      {/* 悬空提示：实际运行节点 ≠ 首选时（下一次派发才迁移） */}
      {seat.currentWorkerId &&
        seat.preferredWorkerId &&
        seat.currentWorkerId !== seat.preferredWorkerId && (
          <div style={{ fontSize: 10, color: "var(--color-warn-text)", lineHeight: 1.4 }}>
            当前运行在 {workerLabelOf(workers, seat.currentWorkerId)}，下次派发时切到{" "}
            {workerLabelOf(workers, seat.preferredWorkerId)}
          </div>
        )}
    </div>
  );
}

/* -------------------------------------------------------------- */
/* 添加成员（从成员库挑，排除已在团队的）                           */
/* -------------------------------------------------------------- */

function AddMemberPanel({
  team,
  onClose,
  onDone,
  onError,
}: {
  team: TeamDto;
  onClose: () => void;
  onDone: () => void;
  onError: (text: string) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [alias, setAlias] = useState("");
  const [selectedId, setSelectedId] = useState("");

  const candidatesQuery = useQuery({
    queryKey: ["members", "team-add-candidates"],
    queryFn: () => membersApi.list({ page: 1, pageSize: 200, status: "active" }),
  });
  const usedMemberIds = useMemo(
    () => new Set((team.members ?? []).map((m) => m.memberId).filter((v): v is string => !!v)),
    [team.members],
  );
  const candidates = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return (candidatesQuery.data?.items ?? [])
      .filter((m) => !usedMemberIds.has(m.id))
      .filter((m) => !kw || m.name.toLowerCase().includes(kw) || (m.role?.name ?? "").toLowerCase().includes(kw));
  }, [candidatesQuery.data, usedMemberIds, keyword]);

  const addMutation = useMutation({
    mutationFn: () =>
      teamsApi.addMember(team.id, {
        memberId: selectedId,
        alias: alias.trim() || undefined,
      }),
    onSuccess: () => onDone(),
    onError: (err) => onError(errorText(err)),
  });

  return (
    <div
      data-testid="members-tab-add-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        padding: space.md,
        borderRadius: radius.md,
        border: `1px solid ${neutral[200]}`,
        backgroundColor: neutral[50],
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>添加成员</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onClose} aria-label="关闭添加成员" style={{ ...iconBtn, border: "none" }}>
          ×
        </button>
      </div>
      <div style={{ fontSize: 10, color: neutral[400], lineHeight: 1.5 }}>
        从平台成员库选择（已在团队里的不再列出）。加入即建席位与会话绑定。
      </div>
      <input
        data-testid="members-tab-add-search"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="搜索成员名 / 岗位"
        style={inputStyle}
      />
      <div
        style={{
          maxHeight: 200,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {candidatesQuery.isPending ? (
          <span style={{ fontSize: fontSize.xs, color: neutral[400], padding: 6 }}>加载中…</span>
        ) : candidates.length === 0 ? (
          <span
            data-testid="members-tab-add-empty"
            style={{ fontSize: fontSize.xs, color: neutral[400], padding: 6, lineHeight: 1.6 }}
          >
            没有可添加的成员（成员库为空，或都已在团队里）。
          </span>
        ) : (
          candidates.map((m) => {
            const active = selectedId === m.id;
            return (
              <button
                key={m.id}
                type="button"
                data-testid="members-tab-add-candidate"
                data-member-id={m.id}
                onClick={() => setSelectedId(active ? "" : m.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.sm,
                  padding: `${space.xs + 2}px ${space.sm}px`,
                  borderRadius: radius.sm,
                  border: `1px solid ${active ? "#0D9488" : "transparent"}`,
                  backgroundColor: active ? "rgba(13,148,136,0.10)" : "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: fontFamily.body,
                }}
              >
                <AgentAvatar role={toRoleKey(m.role?.key ?? null)} size="sm" />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: fontSize.sm, color: neutral[700], fontWeight: active ? 600 : 500 }}>
                    {m.name}
                  </span>
                  <span style={{ display: "block", fontSize: 10, color: neutral[400] }}>
                    {m.role?.name ?? "成员"} · 已在 {m.groupCount} 个群
                  </span>
                </span>
                {active && <span aria-hidden style={{ color: "#0D9488", fontWeight: 700 }}>✓</span>}
              </button>
            );
          })
        )}
      </div>
      <input
        data-testid="members-tab-add-alias"
        value={alias}
        onChange={(e) => setAlias(e.target.value)}
        placeholder="群内别名（可选）"
        style={inputStyle}
      />
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <span style={{ fontSize: 10, color: neutral[400] }}>
          {selectedId ? "已选择成员" : "请选择一位成员"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onClose}
          style={{
            padding: `5px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            color: neutral[600],
            fontSize: fontSize.xs,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          取消
        </button>
        <button
          type="button"
          data-testid="members-tab-add-confirm"
          disabled={!selectedId || addMutation.isPending}
          onClick={() => addMutation.mutate()}
          style={{
            padding: `5px ${space.md}px`,
            borderRadius: radius.md,
            border: "none",
            backgroundColor: selectedId ? "#0D9488" : neutral[200],
            color: "#FFF",
            fontSize: fontSize.xs,
            fontWeight: 600,
            cursor: !selectedId || addMutation.isPending ? "default" : "pointer",
            opacity: addMutation.isPending ? 0.6 : 1,
            fontFamily: fontFamily.body,
          }}
        >
          {addMutation.isPending ? "添加中…" : "加入团队"}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- */
/* 小工具                                                          */
/* -------------------------------------------------------------- */

const iconBtn: React.CSSProperties = {
  flexShrink: 0,
  width: 22,
  height: 22,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  borderRadius: radius.sm,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  color: neutral[500],
  fontSize: fontSize.xs,
  lineHeight: 1,
  cursor: "pointer",
  fontFamily: fontFamily.body,
};

function miniBtn(color: string): React.CSSProperties {
  return {
    flexShrink: 0,
    padding: "3px 6px",
    borderRadius: radius.sm,
    border: "none",
    backgroundColor: "transparent",
    color,
    fontSize: 10,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: fontFamily.body,
  };
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "5px 8px",
  borderRadius: radius.sm,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  fontSize: fontSize.xs,
  color: neutral[800],
  fontFamily: fontFamily.body,
};

function seatDisplayName(seat: TeamMemberDto | null): string {
  if (!seat) return "该成员";
  return seat.member?.name ?? seat.alias ?? seat.agent?.name ?? seat.agentId;
}

function workerLabelOf(workers: WorkerRow[], id: string): string {
  const w = workers.find((x) => x.id === id);
  return w ? (w.name ?? w.id) : id;
}

function modelLabelOf(models: ModelRow[], id: string): string {
  const m = models.find((x) => x.id === id);
  return m ? m.name : id;
}
