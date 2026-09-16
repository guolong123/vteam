"use client";

/**
 * /docs/[taskId] 薄别名（docs-artifacts-merge T10，路由收敛）
 * ============================================================
 * 旧任务级文档站实现（DocExplorer + 原型双 tab + per-task 查询）已删除；
 * 本页直接渲染 T8 统一文档站默认导出（`../page` 的 DocsUnifiedPage），无二次跳转。
 *
 * 别名机制选择（T8 合同核查结论，见 T10 证据）：
 * T8 组件无 props（`export default function DocsUnifiedPage()`，纯 URL 驱动：
 * effect 内读 `window.location.search` 的 `?teamId=&taskId=&doc=`，且无 teamId 时只渲染
 * 团队选择器），故路径 `:taskId` 必须翻译为查询参数，且必须同时补齐 `teamId`
 * （否则别名页永远落在团队选择器，task 预填/doc 深链双双失效）。
 * 本别名在挂载统一组件前（deferred mount，SSR-safe）经 `window.history.replaceState`
 * 一次性注入 `?taskId=` + `?teamId=`（teamId 经 `GET /tasks/:id` 反查；`?doc=` 及其他
 * 参数原样保留，不覆盖调用方显式给的 teamId）——不经过 Next router、不产生导航、
 * 不增加历史记录。子组件挂载时读到的 search 已完整 → 任务预填 + doc 选中一次生效。
 * 任务反查失败（无权限/已删除）→ 仍挂载统一页（团队选择器兜底），绝不 404；
 * 未知 `?doc=` 由统一页按既有语义渲染 `docs-doc-missing` 空态，绝不 404。
 */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/authStore";
import DocsUnifiedPage from "../page";

export default function DocsTaskAliasPage() {
  const params = useParams<{ taskId: string }>();
  const taskId = params?.taskId ?? "";
  const userId = useAuthStore((s) => s.user?.id);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!taskId) {
      setReady(true);
      return;
    }
    // 等登录水合完成再反查（未登录由 AppShell 守卫跳 /login，本页届时已卸载）。
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const q = new URLSearchParams(window.location.search);
      if (!q.get("taskId")) q.set("taskId", taskId);
      if (!q.get("teamId")) {
        try {
          const t = await api.get<{ teamId?: string | null }>(`/tasks/${taskId}`);
          if (!cancelled && t?.teamId) q.set("teamId", t.teamId);
        } catch {
          /* 反查失败 → 统一页团队选择器兜底，不抛错 */
        }
      }
      if (!cancelled) {
        const qs = q.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, userId]);

  if (!ready) {
    return (
      <div
        data-testid="docs-loading"
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          color: "#94A3B8",
          fontFamily: "var(--font-body, system-ui, sans-serif)",
        }}
      >
        加载文档站…
      </div>
    );
  }

  return <DocsUnifiedPage />;
}
