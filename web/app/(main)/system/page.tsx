/**
 * /system 落地页 → 第一个二级导航项（trigger-unification Todo 14 占位的收尾）
 * =============================================
 * Dock「系统管理」/ Cmd+K 的导航目标都是 `/system` 本体。Todo 14 时子页面尚未
 * 上线，这里放的是「子导航即将上线」薄占位；Todo 16/17 交付后子页已可用，占位页
 * 就成了一进就空转的死页（文案也过期：只列用户/角色/记忆，漏了触发器）。
 *
 * 现改为服务端重定向到 SYSTEM_NAV_ITEMS 的**第一项**（触发器），与侧栏顺序同源
 * （system-nav.ts），避免两处各自硬编码导致调整顺序后落点漂移。
 * 同 `/users` → `/system/users`、`/roles` → `/system/roles` 的既有兼容模式。
 *
 * 直接落在子页而非渲染占位页，用户点「系统管理」即见真实内容，无中间空页。
 */
import { redirect } from "next/navigation";
import { SYSTEM_DEFAULT_HREF } from "@/src/lib/system-nav";

export default function SystemPage() {
  redirect(SYSTEM_DEFAULT_HREF ?? "/system/triggers");
}
