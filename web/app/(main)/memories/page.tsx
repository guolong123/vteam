/**
 * /memories → /system/memories 重定向
 * =============================================
 * 记忆管理已收敛至 /system 二级导航（trigger-unification Todo 17），
 * 本路由保留仅用于 URL 直达兼容（书签/旧 e2e），访问即重定向到 /system/memories。
 */
import { redirect } from "next/navigation";

export default function MemoriesPage() {
  redirect("/system/memories");
}
