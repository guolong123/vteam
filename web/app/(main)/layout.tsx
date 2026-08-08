import type { ReactNode } from "react";
import { AppShell } from "@/src/components/layout/app-shell";

/**
 * (main) 路由组全局布局：AppShell（NavTopBar + NavDock + CmdKPanel + 登录守卫）。
 * 覆盖 /projects /board /agents /workers /skills /messages /users /roles。
 * 登录页 /login 位于本组之外（无导航 shell）。
 */
export default function MainLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}