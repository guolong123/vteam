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
}

export function DeviceFrame({ device, children, label }: DeviceFrameProps) {
  const spec = DEVICE_SPECS[device];
  return (
    <div style={{ display: "flex", maxWidth: "100%", justifyContent: "center", overflowX: "auto", padding: `${space.xl}px 0` }}>
      {device === "desktop" ? <DesktopFrame spec={spec} label={label}>{children}</DesktopFrame> : <MobileFrame spec={spec}>{children}</MobileFrame>}
    </div>
  );
}

function DesktopFrame({ spec, label, children }: { spec: DeviceSpec; label?: string; children: ReactNode }) {
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

function MobileFrame({ spec, children }: { spec: DeviceSpec; children: ReactNode }) {
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
