"use client";

/**
 * 平台资源的「所属空间」展示与创建目标提示（多工作空间）。
 *
 * - 资源行：显示该资源归属空间（`ws_system` = 平台共享；当前空间显示「当前空间」）；
 * - 创建提示：告诉用户新建资源会落在当前空间；平台管理员可切换顶栏空间换目标，
 *   共享到所有空间则创建后到「工作空间」页迁移到平台空间。
 */
import { useQuery } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { api } from "@/lib/api";
import { isPlatformAdmin } from "@/lib/permissions";
import { useAuthStore } from "@/lib/stores/authStore";
import { neutral, radius, fontSize, fontFamily } from "@/src/theme/tokens";

interface WorkspaceOption {
  id: string;
  name: string;
  isSystem: boolean;
}

function useWorkspaceMap(): Map<string, WorkspaceOption> {
  const user = useAuthStore((s) => s.user);
  const admin = isPlatformAdmin(user?.permissions ?? {});
  const q = useQuery({
    queryKey: ["workspaces", "space-badge-map", admin],
    queryFn: async () => {
      try {
        return admin
          ? await api.get<WorkspaceOption[]>("/workspaces/all")
          : await api.get<WorkspaceOption[]>("/workspaces");
      } catch {
        return await api.get<WorkspaceOption[]>("/workspaces");
      }
    },
    staleTime: 60_000,
  });
  const map = new Map<string, WorkspaceOption>();
  for (const w of q.data ?? []) map.set(w.id, w);
  return map;
}

const pill = (tone: "current" | "system" | "other"): CSSProperties => {
  const palette = {
    current: { bg: "rgba(13,148,136,.10)", fg: "#0F766E", bd: "rgba(13,148,136,.25)" },
    system: { bg: "rgba(217,119,6,.10)", fg: "#B45309", bd: "rgba(217,119,6,.25)" },
    other: { bg: neutral[100], fg: neutral[600], bd: neutral[200] },
  }[tone];
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "1px 8px",
    borderRadius: radius.pill,
    backgroundColor: palette.bg,
    color: palette.fg,
    border: `1px solid ${palette.bd}`,
    fontSize: fontSize.xs,
    fontWeight: 500,
    whiteSpace: "nowrap",
    fontFamily: fontFamily.body,
  };
};

export interface SpaceBadgeProps {
  workspaceId?: string | null;
  /** 未提供时默认读登录用户当前空间 */
  currentWorkspaceId?: string | null;
}

export function SpaceBadge({ workspaceId, currentWorkspaceId }: SpaceBadgeProps) {
  const map = useWorkspaceMap();
  const storeCurrent = useAuthStore((s) => s.user?.currentWorkspaceId);
  const current = currentWorkspaceId ?? storeCurrent ?? null;
  if (!workspaceId) return null;
  const ws = map.get(workspaceId);
  const isSystem = ws?.isSystem === true || workspaceId === "ws_system";
  if (isSystem) {
    return (
      <span data-testid="space-badge" data-space-id={workspaceId} data-space-kind="system" style={pill("system")} title="平台空间资源：所有空间只读共享">
        平台共享
      </span>
    );
  }
  if (workspaceId === current) {
    return (
      <span data-testid="space-badge" data-space-id={workspaceId} data-space-kind="current" style={pill("current")} title={ws?.name ?? workspaceId}>
        当前空间
      </span>
    );
  }
  return (
    <span data-testid="space-badge" data-space-id={workspaceId} data-space-kind="other" style={pill("other")} title={workspaceId}>
      {ws?.name ?? workspaceId}
    </span>
  );
}

/** 创建目标提示：新建资源将落在当前空间。 */
export function CreateSpaceHint({ style }: { style?: CSSProperties }) {
  const user = useAuthStore((s) => s.user);
  const map = useWorkspaceMap();
  const current = user?.currentWorkspaceId ?? null;
  const name = (current && map.get(current)?.name) ?? current ?? "当前空间";
  const admin = isPlatformAdmin(user?.permissions ?? {});
  return (
    <span
      data-testid="create-space-hint"
      style={{
        fontSize: fontSize.xs,
        color: neutral[500],
        fontFamily: fontFamily.body,
        ...style,
      }}
    >
      创建到：<strong style={{ color: neutral[700], fontWeight: 600 }}>{name}</strong>
      {admin ? "（顶栏切换空间可换目标；需全空间共享请创建后迁移到平台空间）" : ""}
    </span>
  );
}
