import { useEffect, useRef, useState } from "react";
import { PROTOTYPES } from "../prototypes/registry";
import { DEVICE_SPECS, type DeviceType } from "../prototypes/types";
import type { PrototypeEmbedSpec } from "../prd/parser";

/**
 * PrototypeEmbed：在 PRD 阅读器中内嵌可交互原型
 * =====================================================
 * 根据 PrototypeEmbedSpec.id 从注册表查找原型组件，包一层设备外框：
 *  - 支持 device 切换（PC / 移动端）与内嵌高度；
 *  - **自动缩放适配**：内嵌时按容器宽度等比缩小（scale = 容器宽 / 原型宽，不超过 1），
 *    保证 PC 原型（1280px）在较窄文档内容区中完整展示；缩放保持可交互；
 *  - **高度自适应**：原型高度由内容撑开（自动测量），超出最大高度（默认 640px）内部滚动；
 *  - "全屏"：打开全屏遮罩展示原型（100% 原始尺寸，可切设备、可关闭）；
 *  - "跳转"：切换到原型视图（URL hash = id）。
 * 若 id 未注册，渲染占位提示。
 */
export default function PrototypeEmbed({ spec }: { spec: PrototypeEmbedSpec }) {
  const [device, setDevice] = useState<DeviceType>(spec.device ?? "desktop");
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const protoRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [rawHeight, setRawHeight] = useState(0);
  const def = PROTOTYPES.find((p) => p.meta.id === spec.id);

  // 监听内嵌容器宽度，用于自动缩放适配
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 测量原型实际内容高度（用于撑开缩放后的占位，避免截断/跳动）
  useEffect(() => {
    const el = protoRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setRawHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [device, spec.id]);

  if (!def) {
    return (
      <div className="rounded-lg border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700">
        原型 <code className="font-mono">{spec.id}</code> 未在注册表中找到，请检查
        <code className="font-mono">src/prototypes/registry.ts</code>
      </div>
    );
  }

  const specW = DEVICE_SPECS[device].width;
  // spec.height 作为最大高度（默认 640），超出内部滚动；内容不足则自适应完整显示
  const maxHeight = spec.height ?? 640;
  const title = spec.title ?? def.meta.name;

  // 缩放比例：适配容器宽度，不超过原始尺寸
  const scale = containerWidth > 0 ? Math.min(1, containerWidth / specW) : 1;
  // 缩放后的占位高度（内容实际高度被 maxHeight 截断后再缩放）
  const effectiveHeight = rawHeight > 0 ? Math.min(rawHeight, maxHeight) : maxHeight;
  const scaledHeight = Math.round(effectiveHeight * scale);

  const openInView = () => {
    if (window.location.hash !== `#${def.meta.id}`) {
      window.location.hash = def.meta.id;
    }
  };

  return (
    <>
      <div className="my-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {/* 内嵌原型头：标题 + 设备切换 + 操作 */}
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-slate-700">{title}</span>
            <span className="hidden rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 sm:inline">
              {def.meta.group} · {def.meta.id}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 p-0.5">
              {(["desktop", "mobile"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDevice(d)}
                  className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                    device === d ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {d === "desktop" ? "PC" : "移动端"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              title="全屏展示"
              className="flex size-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            </button>
            <button
              type="button"
              onClick={openInView}
              title="在原型视图打开"
              className="flex size-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              </svg>
            </button>
          </div>
        </div>

        {/* 原型展示区：按容器宽度自动缩放 + 高度自适应（内容不足自适应，超出最大高度内部滚动） */}
        <div ref={containerRef} className="bg-slate-100/60">
          <div className="flex justify-center py-5">
            <div style={{ width: containerWidth || "100%", height: scaledHeight }} className="relative">
              <div
                ref={protoRef}
                style={{
                  width: specW,
                  height: "auto",
                  maxHeight,
                  transform: `translateX(-50%) scale(${scale})`,
                  transformOrigin: "top center",
                  left: "50%",
                }}
                className="absolute top-0 overflow-y-auto border border-slate-200 bg-slate-50 shadow-sm"
              >
                <def.Component key={`${spec.id}-${device}-${scale}`} device={device} deviceWidth={specW} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 全屏遮罩（100% 原始尺寸） */}
      {fullscreen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`${title} 全屏展示`}>
          <div className="flex h-12 shrink-0 items-center justify-between px-4 text-white">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{title}</span>
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-slate-300">
                {def.meta.group} · {def.meta.id}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openInView}
                className="rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/20"
              >
                在原型视图打开
              </button>
              <button
                type="button"
                onClick={() => setFullscreen(false)}
                className="flex size-7 items-center justify-center rounded-md bg-white/10 text-white transition-colors hover:bg-white/20"
                aria-label="关闭全屏"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 justify-center overflow-auto py-6">
            <div className="flex h-full max-w-full flex-col items-center">
              <div className="mb-3 flex items-center gap-1 rounded-md border border-white/15 bg-white/5 p-0.5">
                {(["desktop", "mobile"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDevice(d)}
                    className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                      device === d ? "bg-white text-slate-900" : "text-slate-300 hover:text-white"
                    }`}
                  >
                    {d === "desktop" ? "PC 桌面" : "移动端"}
                  </button>
                ))}
              </div>
              <div
                style={{ width: specW, maxHeight: "calc(100vh - 120px)" }}
                className="shrink-0 overflow-y-auto border border-white/20 bg-slate-50 shadow-2xl"
              >
                <def.Component key={`fs-${spec.id}-${device}`} device={device} deviceWidth={specW} />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
