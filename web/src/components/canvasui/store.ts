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
      // 默认关闭视觉效果：玻璃/流体等效果会在内容区叠加半透明气泡与「收起」控件，
      // 影响团队详情/会话页等信息密度高的页面阅读（用户反馈）。需要时从右上角选择器开启。
      effect: "none",
      setEffect: (effect) => set({ effect }),
    }),
    {
      name: "agent-platform-canvasui-effect",
      // v0 的出厂默认是 "glass"；升级后把"从未主动选择过"的 glass 迁移为 none
      // （用户主动选 glass 时 version 已是 1，不会被动到）。
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as { effect?: CanvasUIEffectKey } | undefined;
        if (version < 1 && state?.effect === "glass") {
          return { ...state, effect: "none" } as CanvasUIState;
        }
        return persisted as CanvasUIState;
      },
    },
  ),
);
