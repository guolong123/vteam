"use client";
import type { ReactNode } from "react";
import { DEVICE_SPECS, type DeviceSpec, type DeviceType } from "./types";
import { neutral, surface, border, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

function IconLock({ style }: { style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" style={style} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

interface DeviceFrameProps {
  device: DeviceType;
  children: ReactNode;
  label?: string;
  /**
   * 裸框架模式（2026-11-20）：去掉「窗口装饰」——桌面的三色圆点 + 地址栏、
   * 手机的灵动岛 + 状态栏 + Home 指示条，只留原型本身。
   *
   * 用于全屏预览：全屏的意义就是把空间给内容，再画一圈浏览器外壳纯属浪费
   * （用户实测反馈）。文档站内嵌预览仍用有装饰的框架（"这是一张原型稿"的语义）。
   */
  bare?: boolean;
}

export function DeviceFrame({ device, children, label, bare = false }: DeviceFrameProps) {
  const spec = DEVICE_SPECS[device];
  return (
    <div
      style={{
        display: "flex",
        maxWidth: "100%",
        justifyContent: "center",
        overflowX: "auto",
        // 裸框架（全屏）撑满父容器高度，让内容真正铺到底；带装饰时保留原内边距
        ...(bare
          ? {
              alignItems: "stretch",
              height: "100%",
              padding: 0,
              // 铺满视口宽度（内嵌模式仍居中限宽）
              width: "100%",
            }
          : { padding: `${space.xl}px 0` }),
      }}
    >
      {device === "desktop" ? <DesktopFrame spec={spec} label={label} bare={bare}>{children}</DesktopFrame> : <MobileFrame spec={spec} bare={bare}>{children}</MobileFrame>}
    </div>
  );
}

function DesktopFrame({
  spec,
  label,
  children,
  bare = false,
}: {
  spec: DeviceSpec;
  label?: string;
  children: ReactNode;
  bare?: boolean;
}) {
  /**
   * 裸框架（全屏用）：去掉圆点/地址栏/外框/阴影，只留内容。
   *
   * 尺寸也改为**自适应父容器**（宽度 100%，最小保持 spec.width 以免比设计稿更窄），
   * 高度撑满可用空间——全屏的意义就是把空间全部给原型；仍按固定 1280×800 会在
   * 大屏上留一圈空白（用户要的就是"直接显示原型本身"）。
   */
  if (bare) {
    return (
      <div
        style={{
          // 真正铺满：不再 maxWidth=spec.width（那会在宽屏上留两侧白边）
          width: "100%",
          height: "100%",
          minHeight: 320,
          overflow: "auto",
          backgroundColor: neutral[50],
        }}
      >
        {children}
      </div>
    );
  }
  return (
    <div style={{ overflow: "hidden", borderRadius: "var(--radius-frame)", border: `1px solid ${border}`, backgroundColor: surface, boxShadow: "var(--shadow-frame)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, borderBottom: `1px solid ${border}`, backgroundColor: neutral[50], padding: "10px 16px" }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#EF4444" }} />
        <span style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#F59E0B" }} />
        <span style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#10B981" }} />
        <div style={{ marginLeft: space.md, display: "flex", height: 28, flex: 1, alignItems: "center", gap: 6, borderRadius: radius.sm, border: `1px solid ${border}`, backgroundColor: surface, padding: `0 ${space.md}px`, fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.body }}>
          <IconLock style={{ width: 12, height: 12 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: fontFamily.mono }}>{label ?? "prototype.vteam.local"}</span>
        </div>
      </div>
      <div style={{ width: spec.width, height: spec.height, overflow: "auto", backgroundColor: neutral[50] }}>
        {children}
      </div>
    </div>
  );
}

function MobileFrame({
  spec,
  children,
  bare = false,
}: {
  spec: DeviceSpec;
  children: ReactNode;
  bare?: boolean;
}) {
  // 裸框架：去掉机身圆角外壳/灵动岛/状态栏/Home 条，只留内容区
  if (bare) {
    return (
      <div style={{ width: spec.width, height: spec.height, overflow: "auto", borderRadius: "0.75rem", backgroundColor: neutral[50] }}>
        {children}
      </div>
    );
  }
  return (
    <div style={{ borderRadius: "2.375rem", backgroundColor: neutral[800], padding: 6, boxShadow: "var(--shadow-frame)", outline: `1px solid ${neutral[900]}` }}>
      <div style={{ overflow: "hidden", borderRadius: "1.875rem", backgroundColor: surface }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", backgroundColor: surface, padding: "10px 24px 4px", fontSize: 11, fontWeight: 500, color: neutral[900], fontFamily: fontFamily.body }}>
          <span style={{ letterSpacing: 0.05 }}>9:41</span>
          <span style={{ position: "absolute", left: "50%", top: 6, height: 18, width: 80, transform: "translateX(-50%)", borderRadius: radius.pill, backgroundColor: neutral[900] }} />
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <svg viewBox="0 0 14 10" style={{ height: 10, width: 14, color: neutral[900] }} aria-hidden="true">
              <rect x="0" y="6" width="2.5" height="4" rx="0.75" fill="currentColor" />
              <rect x="3.8" y="3.5" width="2.5" height="6.5" rx="0.75" fill="currentColor" />
              <rect x="7.6" y="1.5" width="2.5" height="8.5" rx="0.75" fill="currentColor" />
              <rect x="11.4" y="0" width="2.5" height="10" rx="0.75" fill="currentColor" opacity="0.3" />
            </svg>
            <svg viewBox="0 0 24 11" style={{ height: 10, width: 24, color: neutral[900] }} aria-hidden="true">
              <rect x="1" y="1" width="19" height="9" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <rect x="2.5" y="2.5" width="13" height="6" rx="1.2" fill="currentColor" />
              <path d="M21.5 4v3a1.8 1.8 0 0 0 0-3Z" fill="currentColor" />
            </svg>
          </span>
        </div>
        <div style={{ width: spec.width, height: spec.height, overflow: "auto", backgroundColor: neutral[50] }}>
          {children}
        </div>
        <div style={{ display: "flex", justifyContent: "center", backgroundColor: surface, padding: `${space.sm}px 0` }}>
          <span style={{ height: 4, width: 96, borderRadius: radius.pill, backgroundColor: neutral[300] }} />
        </div>
      </div>
    </div>
  );
}
