"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, getAuthToken, API_BASE_URL } from "@/lib/api";
import type { DocDef, PrototypeListItem } from "./types";

export function useDocsRegistry(taskId: string) {
  return useQuery({
    queryKey: ["docs-registry", taskId],
    queryFn: () => api.get<DocDef[]>(`/docs-site/${taskId}/registry`),
    enabled: !!taskId,
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useDocContent(taskId: string, file: string) {
  return useQuery({
    queryKey: ["docs-content", taskId, file],
    queryFn: async () => {
      const token = getAuthToken();
      const url = `${API_BASE_URL}/docs-site/${encodeURIComponent(taskId)}/prd/${encodeURIComponent(file)}`;
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
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
