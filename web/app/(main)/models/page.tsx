"use client";

/**
 * 模型管理页（主入口 —— Provider 管理单视图）
 * =============================================
 * 模型目录 Tab（catalog）已下线：所有模型浏览走 Provider Tab 的二级下钻
 * （provider 行 ▸ 展开查看其下模型）；单模型新增/编辑/删除随之下线（明确需求）。
 * 目录 Tab 的全局同步（POST /models/sync，sync-models-button + sync-hint）已迁入
 * providers-tab.tsx 头部，行为不变。
 * 本页仅保留 models-manage-root 薄壳（e2e 页面根断言）+ ProvidersTab 实视图。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；root flex:1 铺满（AppShell 提供导航）。
 */
import { neutral, fontFamily } from "@/src/theme/tokens";
import ProvidersTab from "./providers-tab";

/* ================================ 页面主组件 ================================ */

export default function ModelsPage() {
  return (
    <div
      data-testid="models-manage-root"
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
        overflow: "auto",
      }}
    >
      <ProvidersTab />
    </div>
  );
}
