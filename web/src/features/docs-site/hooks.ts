"use client";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, getAuthToken, API_BASE_URL } from "@/lib/api";
import type { DocDef, PrototypeListItem } from "./types";

/** 团队级原型条目（冻结契约：GET /api/v1/teams/:id/prototypes，T16）。 */
export interface TeamPrototypeListItem extends PrototypeListItem {
  taskId: string;
  taskName: string | null;
}

export function useDocsRegistry(taskId: string) {
  return useQuery({
    queryKey: ["docs-registry", taskId],
    queryFn: () => api.get<DocDef[]>(`/docs-site/${taskId}/registry`),
    enabled: !!taskId,
    refetchInterval: 30_000,
    retry: false,
  });
}

export interface DocContentMd {
  kind: "markdown";
  content: string;
}
export interface DocContentFile {
  kind: "file";
  fileUrl: string;
  fileExt: string;
}
export type DocContent = DocContentMd | DocContentFile;

export function useDocContent(taskId: string, file: string, fileExt?: string, fileUrl?: string) {
  return useQuery({
    queryKey: ["docs-content", taskId, file],
    queryFn: async (): Promise<DocContent> => {
      if (fileExt && fileUrl) {
        return { kind: "file", fileUrl, fileExt };
      }
      const token = getAuthToken();
      const url = `${API_BASE_URL}/docs-site/${encodeURIComponent(taskId)}/prd/${encodeURIComponent(file)}`;
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { kind: "markdown", content: await res.text() };
    },
    enabled: !!taskId && !!file,
    retry: false,
  });
}

export function usePrototypes(taskId: string) {
  return useQuery({
    queryKey: ["docs-prototypes", taskId],
    queryFn: async () => {
      const data = await api.get<{ items: PrototypeListItem[] }>(`/docs-site/${taskId}/prototypes`);
      const items = (data.items ?? []).sort((a, b) => a.id.localeCompare(b.id));
      return items;
    },
    enabled: !!taskId,
    retry: false,
  });
}

export interface TeamPrototypesResult {
  items: TeamPrototypeListItem[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  /** 主端点缺失（并行后端任务未部署）时回退到逐任务聚合；后端落地后自动走主端点。 */
  viaFallback: boolean;
}

export function useTeamPrototypes(
  teamId: string,
  tasks?: { id: string; title: string }[],
): TeamPrototypesResult {
  const teamQuery = useQuery({
    queryKey: ["team-prototypes", teamId],
    queryFn: async () => {
      const data = await api.get<{ items: TeamPrototypeListItem[] }>(`/teams/${teamId}/prototypes`);
      return (data.items ?? []).sort((a, b) => a.id.localeCompare(b.id));
    },
    enabled: !!teamId,
    retry: false,
  });
  const needFallback = !!teamId && teamQuery.isError;
  const perTask = useQueries({
    queries: (needFallback ? (tasks ?? []) : []).map((t) => ({
      queryKey: ["docs-prototypes", t.id],
      queryFn: async (): Promise<TeamPrototypeListItem[]> => {
        const data = await api.get<{ items: PrototypeListItem[] }>(`/docs-site/${t.id}/prototypes`);
        return (data.items ?? []).map((p) => ({ ...p, taskId: t.id, taskName: t.title }));
      },
      retry: false as const,
    })),
  });
  if (!needFallback) {
    return {
      items: teamQuery.data ?? [],
      isPending: teamQuery.isPending,
      isError: teamQuery.isError,
      error: teamQuery.error,
      refetch: () => { void teamQuery.refetch(); },
      viaFallback: false,
    };
  }
  const merged = perTask
    .flatMap((q) => q.data ?? [])
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    items: merged,
    isPending: perTask.some((q) => q.isPending),
    isError: perTask.some((q) => q.isError),
    error: perTask.find((q) => q.error)?.error,
    refetch: () => {
      void teamQuery.refetch();
      perTask.forEach((q) => { void q.refetch(); });
    },
    viaFallback: true,
  };
}

function encodeFile(file: string): string {
  return file.split("/").map((s) => encodeURIComponent(s)).join("/");
}

export function usePrototypeSource(taskId: string, file: string) {
  return useQuery({
    queryKey: ["proto-source", taskId, file],
    queryFn: async () => {
      const token = getAuthToken();
      const res = await fetch(`${API_BASE_URL}/docs-site/${taskId}/prototypes/${encodeFile(file)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    enabled: !!taskId && !!file,
    retry: false,
  });
}

export { encodeFile };

export function useDeleteArtifact(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (artifactId: string) => {
      await api.delete(`/artifacts/${artifactId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["docs-registry", taskId] });
      qc.invalidateQueries({ queryKey: ["docs-prototypes", taskId] });
    },
  });
}
