/**
 * 团队用户成员管理（极简）
 * =============================================
 * 独立于 Agent 成员区（MemberRow）：用户成员是团队级概念，
 * 仅展示 TeamDto.userMembers（id/userId/role/joinedAt）+ 按用户 ID 添加/移除。
 * 无邀请/审批流；失败行内展示，不做路由跳转。
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { teamsApi, type TeamUserMemberDto } from "@/src/api/teams";
import { fontFamily, fontSize, neutral, radius, space } from "@/src/theme/tokens";

/**
 * `GET /users` 条目（只取选择器需要的字段）。
 *
 * 该端点由租户中间件按**当前空间**过滤，所以下拉里天然只有本空间成员
 * （「列出命名空间下的所有成员」）。
 */
interface WorkspaceUserItem {
  id: string;
  username: string;
  displayName: string;
  roleId: string;
  enabled: boolean;
}

interface WorkspaceUsersResponse {
  items: WorkspaceUserItem[];
  total: number;
}

function UserMemberRow({
  member,
  onRemove,
  removing,
}: {
  member: TeamUserMemberDto;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <div
      data-testid="user-member-row"
      data-user-id={member.userId}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.sm + 2}px ${space.md}px`,
        borderRadius: radius.md,
        backgroundColor: "var(--color-surface)",
        border: `1px solid ${neutral[200]}`,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: "50%",
          backgroundColor: neutral[100],
          color: neutral[600],
          fontSize: fontSize.sm,
          fontWeight: 700,
          flexShrink: 0,
          fontFamily: fontFamily.body,
        }}
      >
        {(member.userId.slice(0, 1) || "?").toUpperCase()}
      </span>
      <span
        data-testid="user-member-id"
        style={{
          fontSize: fontSize.xs,
          color: neutral[600],
          fontFamily: fontFamily.mono,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}
      >
        {member.userId}
      </span>
      <span
        data-testid="user-member-role"
        style={{
          fontSize: fontSize.xs,
          color: neutral[600],
          backgroundColor: neutral[100],
          border: `1px solid ${neutral[200]}`,
          padding: "0 6px",
          borderRadius: radius.pill,
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {member.role}
      </span>
      <span
        data-testid="user-member-joined"
        style={{ fontSize: 10, color: neutral[400], whiteSpace: "nowrap", flexShrink: 0 }}
      >
        {new Date(member.joinedAt).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      <button
        type="button"
        data-testid="user-member-remove"
        data-user-id={member.userId}
        disabled={removing}
        onClick={onRemove}
        title="移除用户成员"
        style={{
          border: "none",
          background: "none",
          color: neutral[300],
          cursor: removing ? "default" : "pointer",
          padding: space.xs,
          fontSize: fontSize.sm,
          fontFamily: fontFamily.body,
          flexShrink: 0,
          opacity: removing ? 0.5 : 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

export function UserMembersSection({
  teamId,
  members,
}: {
  teamId: string;
  members: TeamUserMemberDto[];
}) {
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);

  /**
   * 当前空间的用户清单（`GET /users` 由租户中间件按空间过滤）。
   * 供「选择用户」下拉使用——此前只能手输用户 ID，用户根本不知道别人的 ID 是什么。
   */
  const usersQuery = useQuery({
    queryKey: ["workspace-users"],
    queryFn: () =>
      api.get<WorkspaceUsersResponse>("/users", {
        query: { page: 1, pageSize: 200 },
      }),
    staleTime: 60_000,
  });

  /** 下拉候选：排除已在团队里的用户（避免选了必报「已是团队成员」）。 */
  const candidates = useMemo(() => {
    const joined = new Set(members.map((m) => m.userId));
    return (usersQuery.data?.items ?? []).filter((u) => !joined.has(u.id));
  }, [usersQuery.data, members]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["team", teamId] });
    queryClient.invalidateQueries({ queryKey: ["teams"] });
  };

  const addMutation = useMutation({
    mutationFn: () =>
      teamsApi.addUserMember(teamId, {
        userId: userId.trim(),
        role: role.trim() || undefined,
      }),
  });
  const removeMutation = useMutation({
    mutationFn: (targetUserId: string) => teamsApi.removeUserMember(teamId, targetUserId),
  });

  const handleAdd = async () => {
    if (!userId.trim()) {
      setError("用户 ID 不能为空");
      return;
    }
    setError(null);
    try {
      await addMutation.mutateAsync();
      setUserId("");
      setRole("");
      invalidate();
    } catch (err) {
      setError(isApiError(err) ? err.message : "添加失败");
    }
  };

  const handleRemove = (targetUserId: string) => {
    setError(null);
    removeMutation.mutate(targetUserId, {
      onSuccess: invalidate,
      onError: (err) => setError(isApiError(err) ? err.message : "移除失败"),
    });
  };

  return (
    <section data-testid="user-members-section" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[800] }}>
          用户成员{" "}
          <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[400] }}>
            {members.length} 人
          </span>
        </div>
      </div>

      <div
        data-testid="user-member-add-panel"
        style={{
          display: "flex",
          gap: space.md,
          alignItems: "flex-end",
          flexWrap: "wrap",
          padding: space.lg,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px dashed ${neutral[300]}`,
        }}
      >
        <div style={{ flex: 2, minWidth: 240, display: "flex", flexDirection: "column", gap: space.xs }}>
          <label
            htmlFor="user-member-userid-select"
            style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}
          >
            选择用户
          </label>
          <select
            id="user-member-userid-select"
            data-testid="user-member-userid-select"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            aria-label="选择用户"
            disabled={usersQuery.isLoading}
            style={{
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              fontSize: fontSize.md,
              color: neutral[800],
              fontFamily: fontFamily.body,
              cursor: usersQuery.isLoading ? "default" : "pointer",
            }}
          >
            <option value="">
              {usersQuery.isLoading
                ? "加载用户中…"
                : candidates.length === 0
                  ? "本空间没有可添加的用户"
                  : "请选择用户…"}
            </option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName || u.username}（{u.username}）
                {u.enabled ? "" : " · 已禁用"}
              </option>
            ))}
          </select>
          {usersQuery.isError && (
            <span
              data-testid="user-member-users-error"
              style={{ fontSize: fontSize.xs, color: "var(--color-danger-text)" }}
            >
              用户列表加载失败，请刷新重试
            </span>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 140, display: "flex", flexDirection: "column", gap: space.xs }}>
          <label style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>角色（可选）</label>
          <input
            data-testid="user-member-role-input"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="默认 member"
            aria-label="用户角色"
            style={{
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              fontSize: fontSize.md,
              color: neutral[800],

              fontFamily: fontFamily.body,
            }}
          />
        </div>
        <button
          type="button"
          data-testid="user-member-add-confirm"
          disabled={addMutation.isPending}
          onClick={handleAdd}
          style={{
            padding: `${space.sm + 2}px ${space.lg}px`,
            borderRadius: radius.md,
            border: "none",
            backgroundColor: "var(--color-brand-fill)",
            color: "#FFF",
            fontSize: fontSize.md,
            fontWeight: 500,
            cursor: addMutation.isPending ? "default" : "pointer",
            opacity: addMutation.isPending ? 0.6 : 1,
            fontFamily: fontFamily.body,
            alignSelf: "flex-end",
          }}
        >
          {addMutation.isPending ? "添加中…" : "确认添加"}
        </button>
      </div>

      {error && (
        <div
          data-testid="user-member-error"
          role="alert"
          style={{
            padding: `${space.md}px ${space.lg}px`,
            borderRadius: radius.md,
            backgroundColor: "rgba(239,68,68,0.10)",
            border: "1px solid rgba(239,68,68,0.22)",
            color: "var(--color-danger-text)",
            fontSize: fontSize.sm,
          }}
        >
          {error}
        </div>
      )}

      {members.length === 0 ? (
        <div
          data-testid="user-members-empty"
          style={{
            padding: space.xl,
            borderRadius: radius.lg,
            backgroundColor: "var(--color-surface)",
            border: `1px dashed ${neutral[300]}`,
            textAlign: "center",
            fontSize: fontSize.sm,
            color: neutral[400],
          }}
        >
          暂无用户成员，请添加
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          {members.map((m) => (
            <UserMemberRow
              key={m.id}
              member={m}
              removing={removeMutation.isPending}
              onRemove={() => handleRemove(m.userId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
