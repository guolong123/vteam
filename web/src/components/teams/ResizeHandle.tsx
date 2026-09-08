"use client";
/**
 * 面板拖拽分隔条（共享）：成员面板 / 任务面板宽度拖拽。
 */
import React from "react";

/* ================================ 面板拖拽分隔条（is_0000000017） ================================ */
export function ResizeHandle({
  label,
  onResizeStart,
}: {
  label: string;
  onResizeStart: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-testid="panel-resize-handle"
      title={label}
      onMouseDown={onResizeStart}
      style={{
        flexShrink: 0,
        width: 6,
        cursor: "col-resize",
        backgroundColor: "transparent",
        transition: "background-color .15s ease",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.backgroundColor = "rgba(13,148,136,0.22)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
      }}
    />
  );
}

