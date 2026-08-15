import type { ReactNode } from "react";
import { DEVICE_SPECS, type DeviceSpec, type DeviceType } from "../prototypes/types";
import { IconLock } from "../prototypes/_shared/ui";

/**
 * DeviceFrame：设备模拟器
 * =====================================================
 * 根据 device 类型按 DEVICE_SPECS 渲染"设备外框"：
 *  - desktop：桌面浏览器窗口（红黄绿控制点 + 地址栏占位）
 *  - mobile：手机边框（圆角外壳、状态栏 / 刘海 / Home 指示条）
 * 内容区固定设备宽高，允许内部滚动（overflow auto）。
 */
interface DeviceFrameProps {
  device: DeviceType;
  children: ReactNode;
  /** 地址栏占位文案（PC 模式展示） */
  label?: string;
}

export default function DeviceFrame({ device, children, label }: DeviceFrameProps) {
  const spec = DEVICE_SPECS[device];
  return (
    <div className="flex max-w-full justify-center overflow-x-auto py-6">
      {device === "desktop" ? (
        <DesktopFrame spec={spec} label={label}>
          {children}
        </DesktopFrame>
      ) : (
        <MobileFrame spec={spec}>{children}</MobileFrame>
      )}
    </div>
  );
}

/** PC：桌面浏览器窗口外框 */
function DesktopFrame({
  spec,
  label,
  children,
}: {
  spec: DeviceSpec;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-[--radius-frame] border border-slate-200 bg-white shadow-frame">
      {/* 窗口标题栏：控制点 + 地址栏占位 */}
      <div className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <span className="size-3 rounded-full bg-danger-500" />
        <span className="size-3 rounded-full bg-warning-500" />
        <span className="size-3 rounded-full bg-success-500" />
        <div className="ml-3 flex h-7 flex-1 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-400">
          <IconLock className="size-3" />
          <span className="truncate font-mono">{label ?? "prototype.orchestra.local"}</span>
        </div>
      </div>
      {/* 内容区：固定设备宽高，内部滚动 */}
      <div
        style={{ width: spec.width, height: spec.height }}
        className="overflow-auto bg-slate-50"
      >
        {children}
      </div>
    </div>
  );
}

/** 移动端：手机边框外框 */
function MobileFrame({ spec, children }: { spec: DeviceSpec; children: ReactNode }) {
  return (
    <div className="rounded-[2.375rem] bg-slate-800 p-1.5 shadow-frame ring-1 ring-slate-900/20">
      <div className="overflow-hidden rounded-[1.875rem] bg-white">
        {/* 状态栏 + 刘海（外框 chrome，不占内容区高度） */}
        <div className="relative flex items-center justify-between bg-white px-6 pb-1 pt-2.5 text-[11px] font-medium text-slate-900">
          <span className="tracking-wide">9:41</span>
          {/* 刘海 / 灵动岛 */}
          <span className="absolute left-1/2 top-1.5 h-[18px] w-20 -translate-x-1/2 rounded-full bg-slate-900" />
          <span className="flex items-center gap-1">
            {/* 信号 */}
            <svg viewBox="0 0 14 10" className="h-2.5 w-3.5 text-slate-900" aria-hidden="true">
              <rect x="0" y="6" width="2.5" height="4" rx="0.75" fill="currentColor" />
              <rect x="3.8" y="3.5" width="2.5" height="6.5" rx="0.75" fill="currentColor" />
              <rect x="7.6" y="1.5" width="2.5" height="8.5" rx="0.75" fill="currentColor" />
              <rect x="11.4" y="0" width="2.5" height="10" rx="0.75" fill="currentColor" opacity="0.3" />
            </svg>
            {/* 电池 */}
            <svg viewBox="0 0 24 11" className="h-2.5 w-6 text-slate-900" aria-hidden="true">
              <rect x="1" y="1" width="19" height="9" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <rect x="2.5" y="2.5" width="13" height="6" rx="1.2" fill="currentColor" />
              <path d="M21.5 4v3a1.8 1.8 0 0 0 0-3Z" fill="currentColor" />
            </svg>
          </span>
        </div>
        {/* 内容区：固定设备宽高，内部滚动 */}
        <div style={{ width: spec.width, height: spec.height }} className="overflow-auto bg-slate-50">
          {children}
        </div>
        {/* Home 指示条 */}
        <div className="flex justify-center bg-white py-2">
          <span className="h-1 w-24 rounded-full bg-slate-300" />
        </div>
      </div>
    </div>
  );
}
