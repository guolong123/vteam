"use client";

/**
 * 旧团队会话页入口（已合并到 /chat）。
 * 保留路由做兼容：直接重定向到 /chat 群聊态，避免两个聊天页面并存。
 */
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function TeamSessionRedirectPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const teamId = params?.id ?? "";

  useEffect(() => {
    if (teamId) {
      router.replace(`/chat?c=${encodeURIComponent(`group:${teamId}`)}`);
    }
  }, [teamId, router]);

  return null;
}
