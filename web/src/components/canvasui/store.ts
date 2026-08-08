"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * 全局 Canvas UI 效果状态：右上角头像旁下拉选择器与 CanvasUIGlobal 共享。
 * 持久化到 localStorage（agent-platform-canvasui-effect），刷新后保持选择。
 * 3D 组件（*Object，需显式 src 渲染模型）暂不纳入全局效果选择器。
 */

export type CanvasUIEffectKey =
  | "glass"
  | "droplets"
  | "canvas"
  | "liquid"
  | "ripple"
  | "cloth"
  | "bubble"
  | "displacement"
  | "frost"
  | "magnify"
  | "bend"
  | "peel"
  | "clouds"
  | "blaze"
  | "flamewrap"
  | "forcefield"
  | "laser"
  | "glitch"
  | "retrodither"
  | "asciify"
  | "decryptreveal"
  | "glyphrain"
  | "vhs"
  | "particlereveal"
  | "particlescroll"
  | "shatter"
  | "grid"
  | "hexfloat"
  | "none";

interface CanvasUIState {
  effect: CanvasUIEffectKey;
  setEffect: (effect: CanvasUIEffectKey) => void;
}

export const useCanvasUIStore = create<CanvasUIState>()(
  persist(
    (set) => ({
      effect: "glass",
      setEffect: (effect) => set({ effect }),
    }),
    {
      name: "agent-platform-canvasui-effect",
    },
  ),
);
