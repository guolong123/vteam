"use client";
import { useState, useRef, useEffect } from "react";
import { PrototypeSandbox } from "./prototype-sandbox";
import { DeviceFrame } from "./device-frame";
import { DeviceSwitcher } from "./device-switcher";
import { DEVICE_SPECS, type DeviceType, type PrototypeEmbedSpec, type PrototypeListItem } from "./types";
import { neutral, surface, border, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

interface PrototypeEmbedProps {
  spec: PrototypeEmbedSpec;
  prototypes: PrototypeListItem[];
  taskId: string;
}

export function PrototypeEmbed({ spec, prototypes, taskId }: PrototypeEmbedProps) {
  const [device, setDevice] = useState<DeviceType>(spec.device ?? "desktop");
  const hit = prototypes.find((pr) => pr.id === spec.id || pr.metaId === spec.id);

  if (!hit) {
    return (
      <div
        style={{
          margin: `${space.md}px 0`,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          border: "1px solid #FDE68A",
          backgroundColor: "#FFFBEB",
          fontSize: fontSize.md,
          color: "#B45309",
          fontFamily: fontFamily.body,
        }}
      >
        原型 {spec.id} 未找到
      </div>
    );
  }

  const label = spec.title ?? hit.name ?? hit.id;

  return (
    <div
      data-proto="embed"
      style={{
        margin: `${space.md}px 0`,
        borderRadius: radius.md,
        border: `1px solid ${border}`,
        backgroundColor: surface,
        overflow: "hidden",
        fontFamily: fontFamily.body,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `${space.xs}px ${space.md}px`,
          borderBottom: `1px solid ${border}`,
          backgroundColor: neutral[50],
        }}
      >
        <span
          style={{
            fontSize: fontSize.sm,
            fontWeight: 600,
            color: neutral[700],
            fontFamily: fontFamily.body,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <DeviceSwitcher device={device} onChange={setDevice} />
      </div>

      <ScaledFrame device={device} label={label}>
        <PrototypeSandbox taskId={taskId} file={hit.file} name={hit.name} device={device} />
      </ScaledFrame>
    </div>
  );
}

function ScaledFrame({ device, label, children }: { device: DeviceType; label: string; children: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const spec = DEVICE_SPECS[device];
    const frameW = spec.width + 48;
    const compute = () => {
      const avail = el.clientWidth;
      if (avail <= 0) return;
      const s = Math.min(1, avail / frameW);
      setScale(s < 0.99 ? s : 1);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [device]);

  if (scale >= 1) {
    return (
      <div ref={wrapRef} style={{ padding: `${space.md}px`, display: "flex", justifyContent: "center" }}>
        <DeviceFrame device={device} label={label}>
          {children}
        </DeviceFrame>
      </div>
    );
  }

  const spec = DEVICE_SPECS[device];
  const scaledH = Math.round((spec.height + (device === "desktop" ? 44 : 38)) * scale);
  return (
    <div ref={wrapRef} style={{ padding: `${space.md}px 0`, overflow: "hidden" }}>
      <div style={{ height: scaledH, position: "relative" }}>
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 0,
            width: spec.width,
            transform: `translateX(-50%) scale(${scale})`,
            transformOrigin: "top center",
          }}
        >
          <DeviceFrame device={device} label={label}>
            {children}
          </DeviceFrame>
        </div>
      </div>
    </div>
  );
}
