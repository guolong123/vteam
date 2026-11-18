"use client";

/**
 * PanelShell：侧栏外壳（收起 / 展开 / 拖拽调宽三合一）
 * =====================================================================
 * 会话页右栏有 4 种内容（群信息 / 成员信息 / 私聊成员 / 外部用户资料），
 * 外面那条「可以收起、可以拖宽」的边框行为完全一样。抽出外壳后：
 *
 * ```
 * 展开态： [ 面板内容 ][ 分隔条 + ‹收起 ]
 * 收起态： [ ›竖排恢复条 ]
 * ```
 *
 * 子组件用 render-prop 拿到实际宽度（面板内部不自己写死 300）。
 * 面板宽度上限由 `useSidePanel` 按视口比例封顶，窄屏拖不到溢出。
 */
import type { ReactNode } from "react";
import { PanelGutter } from "./panel-gutter";
import { PanelExpandRail } from "./panel-collapse";
import type { SidePanelController } from "@/src/hooks/use-side-panel";

export function PanelShell({
  side,
  controller,
  label,
  testId,
  railHint,
  children,
}: {
  side: "left" | "right";
  controller: SidePanelController;
  /** 分隔条的无障碍名称，如「调整群信息栏宽度」。 */
  label: string;
  testId: string;
  /** 收起态恢复条的竖排文字。 */
  railHint: string;
  children: (width: number) => ReactNode;
}) {
  if (controller.collapsed) {
    return (
      <PanelExpandRail
        side={side}
        label={`展开${railHint}`}
        hint={railHint}
        testId={`${testId}-rail`}
        onExpand={controller.expand}
      />
    );
  }
  return (
    <div data-testid={testId} style={{ display: "flex", minHeight: 0, flexShrink: 0 }}>
      {side === "right" && (
        <PanelGutter
          side="right"
          testId={`${testId}-gutter`}
          label={label}
          width={controller.width}
          onResizeStart={controller.onResizeStart}
          onNudge={controller.nudge}
          onCollapse={controller.collapse}
        />
      )}
      {children(controller.width)}
      {side === "left" && (
        <PanelGutter
          side="left"
          testId={`${testId}-gutter`}
          label={label}
          width={controller.width}
          onResizeStart={controller.onResizeStart}
          onNudge={controller.nudge}
          onCollapse={controller.collapse}
        />
      )}
    </div>
  );
}
