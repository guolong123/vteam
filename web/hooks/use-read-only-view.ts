"use client";

import { useAuthStore } from "@/lib/stores/authStore";

/**
 * 管理员跨空间只读视图（返回被查看的空间；null = 正常可写）。
 * 页面用它禁用写入口：按钮置灰 + 提示，服务端 403 仍是最终兜底。
 */
export function useReadOnlyView(): { id: string; name: string } | null {
  return useAuthStore((s) => s.viewWorkspace);
}
