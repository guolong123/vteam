/**
 * /providers → /models 重定向
 * =============================================
 * 模型管理单一入口（用户需求：「主入口应该只有一个模型管理，进去后通过 tab 页
 * 管理两个页面，支持切换」）。Provider 管理已并入 /models 双 Tab（providers-tab.tsx），
 * 本路由保留仅用于 URL 直达兼容，访问即重定向到 /models。
 */
import { redirect } from "next/navigation";

export default function ProvidersPage() {
  redirect("/models");
}
