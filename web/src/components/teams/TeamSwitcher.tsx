"use client";
/**
 * 团队切换器（共享）：会话页顶栏团队名下拉，列出全部团队并跳转到对应团队会话页。
 * =============================================
 * 结构对照 `src/theme/theme-toggle.tsx`：mousedown 外点关闭 + role=menu / menuitemradio。
 * 团队身份由路由参数决定（URL 派生），切换即 `router.push('/teams/<id>/session')`。
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { teamsApi, type TeamDto } from "@/src/api/teams";
import { useAuthStore } from "@/lib/stores/authStore";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";

export function TeamSwitcher({
  currentTeamId,
  currentTeamName,
}: {
  currentTeamId: string;
  currentTeamName: string;
}) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data, isPending, isError } = useQuery({
    queryKey: ["teams", "switcher"],
    queryFn: () => teamsApi.list({ page: 1, pageSize: 100 }),
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const teams = data?.items ?? [];

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        data-testid="team-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="切换团队"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 6px",
          borderRadius: radius.md,
          border: "1px solid transparent",
          backgroundColor: hover ? neutral[100] : "transparent",
          color: neutral[900],
          fontSize: fontSize.lg,
          fontWeight: 600,
          fontFamily: fontFamily.body,
          cursor: "pointer",
          maxWidth: 220,
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {currentTeamName}
        </span>
        <span aria-hidden style={{ flexShrink: 0, fontSize: 10, opacity: 0.6 }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          data-testid="team-switcher-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            minWidth: 260,
            maxHeight: 360,
            overflowY: "auto",
            padding: 4,
            borderRadius: radius.md,
            backgroundColor: "var(--color-surface)",
            border: `1px solid ${neutral[200]}`,
            boxShadow: shadow.lg,
            zIndex: 100,
          }}
        >
          {isPending ? (
            <div style={{ padding: "6px 10px", fontSize: fontSize.md, color: neutral[400], fontFamily: fontFamily.body }}>
              加载中…
            </div>
          ) : isError ? (
            <div style={{ padding: "6px 10px", fontSize: fontSize.md, color: neutral[400], fontFamily: fontFamily.body }}>
              团队列表加载失败
            </div>
          ) : (
            teams.map((t: TeamDto) => {
              const active = t.id === currentTeamId;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  data-testid={`team-switcher-option-${t.id}`}
                  data-team-id={t.id}
                  onClick={() => {
                    setOpen(false);
                    if (!active) router.push(`/teams/${t.id}/session`);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    textAlign: "left",
                    padding: "6px 10px",
                    borderRadius: radius.sm,
                    border: "none",
                    backgroundColor: active ? "rgba(13,148,136,.10)" : "transparent",
                    cursor: "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: fontSize.md,
                        fontWeight: active ? 600 : 500,
                        color: active ? "#0D9488" : neutral[700],
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.name}
                    </span>
                    <span style={{ display: "block", marginTop: 2, fontSize: fontSize.xs, color: neutral[400] }}>
                      {`${(t.members ?? []).length} 成员 · ${t.currentTaskId ? "忙碌中" : "空闲"}`}
                    </span>
                  </span>
                  {active && (
                    <span aria-hidden style={{ fontSize: 12, color: "#0D9488" }}>
                      ✓
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
