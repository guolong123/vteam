"use client";

/**
 * 首页（根路径 /）：登录守卫重定向。
 * - 已登录（authStore.token 存在）→ /projects（主工作台）
 * - 未登录 → /login（AppShell 守卫同源语义，登录页统一处理凭证错误）
 * 与 login 页的已登录跳转逻辑一致（useAuthStore.getState 同步读 token）。
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/stores/authStore";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const token = useAuthStore.getState().token;
    router.replace(token ? "/projects" : "/login");
  }, [router]);

  return null;
}
