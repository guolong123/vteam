"use client";
import type { DeviceType } from "./types";
import { neutral, surface, border, radius, fontSize, fontFamily } from "@/src/theme/tokens";

interface DeviceSwitcherProps {
  device: DeviceType;
  onChange: (d: DeviceType) => void;
}

export function DeviceSwitcher({ device, onChange }: DeviceSwitcherProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: radius.sm, border: `1px solid ${border}`, backgroundColor: neutral[50], padding: 2, fontFamily: fontFamily.body }}>
      {(["desktop", "mobile"] as const).map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(d)}
          style={{
            borderRadius: radius.sm,
            padding: "4px 10px",
            fontSize: fontSize.xs,
            fontWeight: 500,
            cursor: "pointer",
            border: "none",
            fontFamily: fontFamily.body,
            transition: "background .15s, color .15s",
            ...(device === d
              ? { backgroundColor: surface, color: neutral[900], boxShadow: "0 1px 2px rgba(15,23,42,.06)" }
              : { backgroundColor: "transparent", color: neutral[500] }),
          }}
        >
          {d === "desktop" ? "PC" : "移动端"}
        </button>
      ))}
    </div>
  );
}