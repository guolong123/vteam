"use client";

/**
 * 首页（根路径 `/`）：登录守卫 + 角色分流。
 * - 未登录 → `/login`
 * - 平台管理员 → `/stats`（统计看板，进站第一眼是经营全貌）
 * - 普通成员 → `/teams`（团队工作台）
 *
 * 分流规则单点在 `lib/landing.ts`（登录页与根路由共用，避免两处各写一份）。
 * 为什么不在本文件导出该函数：Next.js page 文件只允许导出 default 与保留字段，
 * 多导出会触发 `OmitWithTag ... does not satisfy the constraint` 类型错误。
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/stores/authStore";
import { resolveLandingPath } from "@/lib/landing";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const { token, user } = useAuthStore.getState();
    router.replace(token ? resolveLandingPath(user) : "/login");
  }, [router]);

  return null;
}
