"use client";

/**
 * 全局团队列表页（Task 11）
 * =============================================
 * - 列表 GET /teams 分页 + name 搜索（server-side contains）
 * - 卡片：团队名 / reuseSession / 成员数 / 队列长度 / currentTaskId
 * - 分页 Pagination + 搜索防抖（300ms）
 * - 空态 / 错误 / 加载
 * - 跳转：点击卡片 → /teams/:id；新建 → /teams/new
 * - 复用 tokens / Pagination / AgentAvatar
 */
import { useState, useMemo, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { teamsApi, type TeamDto } from "@/src/api/teams";
import { isApiError } from "@/lib/errors";
import { AgentAvatar, EmptyState, Pagination } from "@/src/components/ui";
import {
  type RoleKey,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };
const PAGE_SIZE = 12;
const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];
function toAvatarRole(role: string | null): RoleKey {
  return role && (ROLE_KEYS as readonly string[]).includes(role) ? (role as RoleKey) : "developer";
}

function TeamCard({ team, onOpen }: { team: TeamDto; onOpen: () => void }) {
  const cardStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: space.xl,
    borderRadius: radius.lg,
    backgroundColor: "var(--color-surface)",
    border: `1px solid ${neutral[200]}`,
    boxShadow: shadow.sm,
    cursor: "pointer",
    transition: "box-shadow .18s ease, border-color .18s ease",
  };
  return (
    <section
      data-testid="team-card"
      data-team-id={team.id}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
      }}
      style={cardStyle}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = shadow.md;
        (e.currentTarget as HTMLElement).style.borderColor = neutral[300];
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = shadow.sm;
        (e.currentTarget as HTMLElement).style.borderColor = neutral[200];
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
        <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {team.name}
        </div>
        <span
          data-testid="team-reuse-badge"
          style={{
            fontSize: fontSize.xs,
            fontWeight: 500,
            color: team.reuseSession ? "#059669" : neutral[500],
            backgroundColor: team.reuseSession ? "rgba(16,185,129,0.10)" : neutral[50],
            border: `1px solid ${team.reuseSession ? "rgba(16,185,129,0.28)" : neutral[200]}`,
            padding: "2px 8px",
            borderRadius: radius.pill,
            flexShrink: 0,
          }}
        >
          {team.reuseSession ? "复用会话" : "隔离会话"}
        </span>
      </div>
      {team.description && (
        <p style={{ margin: 0, fontSize: fontSize.sm, color: neutral[500], lineHeight: 1.6, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {team.description}
        </p>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: `1px solid ${neutral[100]}`, paddingTop: space.md }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.xs, fontSize: fontSize.sm, color: neutral[400] }}>
          <span style={{ fontWeight: 700, color: neutral[700] }}>{team.members.length}</span> 成员
          <span style={{ color: neutral[300] }}>·</span>
          <span style={{ color: team.queue.length > 0 ? "#D97706" : neutral[400] }}>{team.queue.length} 排队</span>
          {team.currentTaskId && (
            <>
              <span style={{ color: neutral[300] }}>·</span>
              <span style={{ color: "#2563EB", fontSize: fontSize.xs, maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{team.currentTaskId}</span>
            </>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center" }}>
          {team.members.slice(0, 5).map((m, idx) => (
            <span key={m.id} style={{ marginLeft: idx === 0 ? 0 : -8 }}>
              <AgentAvatar role={toAvatarRole(m.agent?.role ?? null)} size="sm" />
            </span>
          ))}
          {team.members.length > 5 && (
            <span style={{ marginLeft: 4, fontSize: fontSize.xs, color: neutral[400] }}>+{team.members.length - 5}</span>
          )}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>v{team.version} · {new Date(team.updatedAt).toLocaleDateString()}</span>
        <span style={{ fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.mono }}>{team.id}</span>
      </div>
      <button
        type="button"
        data-testid="enter-team-session"
        data-team-id={team.id}
        onClick={(e) => {
          e.stopPropagation();
          window.location.href = `/teams/${team.id}/session`;
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: space.xs,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          border: `1px solid ${neutral[200]}`,
          backgroundColor: "var(--color-surface)",
          color: "#2563EB",
          fontSize: fontSize.sm,
          fontWeight: 500,
          cursor: "pointer",
          fontFamily: fontFamily.body,
        }}
      >
        进入会话 →
      </button>
    </section>
  );
}

export default function TeamsPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [debounced, setDebounced] = useState("");

  // debounce 300ms
  const handleSearch = (v: string) => {
    setKeyword(v);
    if ((handleSearch as unknown as { t?: ReturnType<typeof setTimeout> }).t) clearTimeout((handleSearch as unknown as { t: ReturnType<typeof setTimeout> }).t);
    (handleSearch as unknown as { t: ReturnType<typeof setTimeout> }).t = setTimeout(() => {
      setDebounced(v.trim());
      setPage(1);
    }, 300);
  };

  const query = useQuery({
    queryKey: ["teams", page, debounced],
    queryFn: () => teamsApi.list({ page, pageSize: PAGE_SIZE, name: debounced || undefined }),
  });

  const totalPages = useMemo(() => Math.max(1, Math.ceil((query.data?.total ?? 0) / PAGE_SIZE)), [query.data?.total]);
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  return (
    <div
      data-testid="teams-list-root"
      style={{ flex: 1, display: "flex", flexDirection: "column", padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`, ...baseFont }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.lg, marginBottom: space.lg }}>
        <div>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>团队管理</div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>{total} 个团队 · 全局复用</div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            flex: 1,
            minWidth: 180,
            maxWidth: 320,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: "var(--color-surface)",
            border: `1px solid ${neutral[200]}`,
            boxShadow: shadow.sm,
            marginLeft: "auto",
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400], lineHeight: 1 }}>⌕</span>
          <input
            data-testid="teams-search"
            value={keyword}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="搜索团队名…"
            aria-label="搜索团队"
            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: fontSize.md, color: neutral[800], fontFamily: fontFamily.body }}
          />
        </div>
        <button
          type="button"
          data-testid="create-team-button"
          onClick={() => router.push("/teams/new")}
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
            flexShrink: 0,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>+</span> 新建团队
        </button>
      </div>

      {query.isPending ? (
        <div data-testid="teams-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}>加载中…</div>
      ) : query.isError ? (
        <div data-testid="teams-error" role="alert" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: space.md, padding: space.xxl }}>
          <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>{isApiError(query.error) ? query.error.message : "加载失败"}</div>
          <button
            type="button"
            data-testid="teams-retry"
            onClick={() => query.refetch()}
            style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], fontSize: fontSize.md, cursor: "pointer", fontFamily: fontFamily.body }}
          >
            重试
          </button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title={debounced ? "无匹配团队" : "还没有团队"}
          description={debounced ? "换个关键词试试" : "创建一个全局团队，成员多实例复用于多个任务"}
          icon={<span aria-hidden>◉</span>}
          action={!debounced ? (
            <button
              type="button"
              data-testid="create-team-empty"
              onClick={() => router.push("/teams/new")}
              style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: `${space.sm + 2}px ${space.lg}px`, borderRadius: radius.pill, border: "none", backgroundColor: "#2563EB", color: "#FFF", fontSize: fontSize.md, fontWeight: 500, cursor: "pointer", fontFamily: fontFamily.body }}
            >
              新建团队
            </button>
          ) : undefined}
        />
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: space.lg }}>
            {items.map((t) => (
              <TeamCard key={t.id} team={t} onOpen={() => router.push(`/teams/${t.id}`)} />
            ))}
          </div>
          <div style={{ marginTop: space.xl, display: "flex", justifyContent: "center" }}>
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} dataTestId="teams-pagination" />
          </div>
        </>
      )}
    </div>
  );
}
