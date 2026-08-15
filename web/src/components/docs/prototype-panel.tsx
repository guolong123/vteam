"use client";

/**
 * PrototypePanel：文档站「原型」tab 浏览器（is_0000000037）
 * =============================================================
 * 移植自 prototype-viewer（md-docs），展示 22 个 PRD 原型（registry 全量）：
 * - 左侧 PrototypeNav（按 meta.group 分组导航）
 * - 顶部 DeviceSwitcher（PC / 移动端）
 * - DeviceFrame 内渲染当前原型（设备外框），ErrorBoundary 兜底防单原型异常白屏
 * 样式保留原型 tailwind 工具类（globals.css 已引入 tailwind theme+utilities + brand 主题）；
 * 本组件由 /docs 页面 next/dynamic 懒加载（仅进入原型 tab 才拉取 registry/原型 chunk）。
 */
import { Component, type ReactNode } from "react";
import { useState } from "react";
import { PROTOTYPES } from "./prototypes/registry";
import { DEVICE_SPECS, type DeviceType } from "./prototypes/types";
import PrototypeNav from "./prototypes-viewer/PrototypeNav";
import DeviceSwitcher from "./prototypes-viewer/DeviceSwitcher";
import DeviceFrame from "./prototypes-viewer/DeviceFrame";

/** 原型渲染错误边界：单原型异常不白屏，展示降级提示。 */
class PrototypeErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-64 items-center justify-center px-6 text-center text-sm text-danger-700">
          该原型渲染失败，请切换其他原型或刷新重试
        </div>
      );
    }
    return this.props.children;
  }
}

export function PrototypePanel() {
  const [protoId, setProtoId] = useState<string>(PROTOTYPES[0]?.meta.id ?? "");
  const [device, setDevice] = useState<DeviceType>("desktop");
  const activeDef = PROTOTYPES.find((p) => p.meta.id === protoId) ?? PROTOTYPES[0];

  return (
    <div
      data-testid="docs-prototype-panel"
      className="flex h-full min-h-0 bg-slate-100 font-sans text-slate-900 antialiased"
    >
      {/* 左侧：原型导航 */}
      <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white md:block">
        <PrototypeNav defs={PROTOTYPES} activeId={protoId} onSelect={setProtoId} />
      </aside>

      {/* 主区：设备切换 + 原型渲染 */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="flex items-center justify-end border-b border-slate-200 bg-white/90 px-4 py-2">
          <DeviceSwitcher device={device} onChange={setDevice} />
        </div>
        <PrototypeErrorBoundary key={protoId}>
          {activeDef ? (
            <DeviceFrame device={device} label={`prototype.orchestra.local/#${activeDef.meta.id}`}>
              <activeDef.Component
                key={`${activeDef.meta.id}-${device}`}
                device={device}
                deviceWidth={DEVICE_SPECS[device].width}
              />
            </DeviceFrame>
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-400">
              暂无已注册的原型
            </div>
          )}
        </PrototypeErrorBoundary>
      </main>
    </div>
  );
}
