"use client";

import dynamic from "next/dynamic";
import type { ComponentType, ReactNode } from "react";
import { useCanvasUIStore, type CanvasUIEffectKey } from "./store";

/**
 * 全局 Canvas UI 效果挂载层：
 * - 效果由右上角头像旁下拉选择器控制（见 app-shell NavTopBar children），
 *   状态存 zustand（localStorage 持久化），此处按 store 渲染对应效果。
 * - 用 next/dynamic + ssr:false 仅在客户端挂载效果组件——组件内部
 *   useSyncExternalStore server snapshot 恒 false、client 可能 true，
 *   直接 SSR 会导致 hydration 不匹配。
 * - 不支持 html-in-canvas 的浏览器（Chrome 实验 API）自动降级为普通内容，不影响页面。
 * - 3D 组件（*Object，需显式 src 渲染模型）暂不纳入全局效果。
 */

const Glass = dynamic(() => import("./Glass"), { ssr: false });
const Droplets = dynamic(() => import("./Droplets"), { ssr: false });
const Canvas = dynamic(() => import("./Canvas"), { ssr: false });
const Liquid = dynamic(() => import("./Liquid"), { ssr: false });
const Ripple = dynamic(() => import("./Ripple"), { ssr: false });
const Cloth = dynamic(() => import("./Cloth"), { ssr: false });
const Bubble = dynamic(() => import("./Bubble"), { ssr: false });
const Displacement = dynamic(() => import("./Displacement"), { ssr: false });
const Frost = dynamic(() => import("./Frost"), { ssr: false });
const Magnify = dynamic(() => import("./Magnify"), { ssr: false });
const Bend = dynamic(() => import("./Bend"), { ssr: false });
const Peel = dynamic(() => import("./Peel"), { ssr: false });
const Clouds = dynamic(() => import("./Clouds"), { ssr: false });
const Blaze = dynamic(() => import("./Blaze"), { ssr: false });
const FlameWrap = dynamic(() => import("./FlameWrap"), { ssr: false });
const ForceField = dynamic(() => import("./ForceField"), { ssr: false });
const Laser = dynamic(() => import("./Laser"), { ssr: false });
const Glitch = dynamic(() => import("./Glitch"), { ssr: false });
const RetroDither = dynamic(() => import("./RetroDither"), { ssr: false });
const Asciify = dynamic(() => import("./Asciify"), { ssr: false });
const DecryptReveal = dynamic(() => import("./DecryptReveal"), { ssr: false });
const GlyphRain = dynamic(() => import("./GlyphRain"), { ssr: false });
const VHS = dynamic(() => import("./VHS"), { ssr: false });
const ParticleReveal = dynamic(() => import("./ParticleReveal"), { ssr: false });
const ParticleScroll = dynamic(() => import("./ParticleScroll"), { ssr: false });
const Shatter = dynamic(() => import("./Shatter"), { ssr: false });
const Grid = dynamic(() => import("./Grid"), { ssr: false });
const HexFloat = dynamic(() => import("./HexFloat"), { ssr: false });

type EffectProps = Record<string, unknown>;

/** 效果键 → 组件 + 自定义参数（缺省参数由各组件 DEFAULTS 提供）。 */
const EFFECTS: Partial<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 各效果组件 props 类型各异，注册表统一收窄会破坏赋值兼容
  Record<CanvasUIEffectKey, { Comp: ComponentType<any>; props?: EffectProps }>
> = {
  glass: {
    Comp: Glass,
    props: {
      size: 120,
      aspect: 1.7,
      corner: 32,
      ior: 1.5,
      edge: 0.7,
      bevel: 4,
      depth: 250,
      aberration: 1,
      blur: 0,
      reflection: 1,
      shine: 0.01,
      zoom: 1.5,
      follow: 0.2,
      shape: "circle",
      targets: "h1, h2, h3, a, button, code",
    },
  },
  droplets: {
    Comp: Droplets,
    props: {
      intensity: 0.5,
      speed: 1,
      scale: 0.4,
      dropWidth: 1,
      dropLength: 1,
      refraction: 0.2,
      blur: 0,
      vignette: 0,
      fallSpeed: 1,
      wiggle: 1,
      staticDrops: 0.2,
      interactionRadius: 0.3,
      interactionStrength: 0.6,
      interactionDistortion: 3,
      tintStrength: 0,
      tint: [0.5608, 0.7059, 1],
    },
  },
  canvas: {
    Comp: Canvas,
    props: {
      threadSize: 2,
      threadWidth: 0.2,
      texture: 1,
      tintStrength: 0,
      grain: 0.5,
      halftone: 0.1,
      dotSize: 6,
      strength: 1,
      relief: 0.45,
      gloss: 0.35,
      bristle: 0.4,
      dry: 2.5,
      radius: 0.08,
      followSpeed: 3,
      tint: [0.8392, 0.8078, 0.7529],
    },
  },
  liquid: { Comp: Liquid },
  ripple: { Comp: Ripple },
  cloth: { Comp: Cloth },
  bubble: { Comp: Bubble },
  displacement: { Comp: Displacement },
  frost: { Comp: Frost },
  magnify: { Comp: Magnify },
  bend: { Comp: Bend },
  peel: { Comp: Peel },
  clouds: { Comp: Clouds },
  blaze: { Comp: Blaze },
  flamewrap: { Comp: FlameWrap },
  forcefield: { Comp: ForceField },
  laser: { Comp: Laser },
  glitch: { Comp: Glitch },
  retrodither: { Comp: RetroDither },
  asciify: { Comp: Asciify },
  decryptreveal: { Comp: DecryptReveal },
  glyphrain: { Comp: GlyphRain },
  vhs: { Comp: VHS },
  particlereveal: { Comp: ParticleReveal },
  particlescroll: { Comp: ParticleScroll },
  shatter: { Comp: Shatter },
  grid: { Comp: Grid },
  hexfloat: { Comp: HexFloat },
};

const commonStyle = { minHeight: "100vh" } as const;

export function CanvasUIGlobal({ children }: { children: ReactNode }) {
  const effect = useCanvasUIStore((s) => s.effect);

  const entry = EFFECTS[effect];
  if (!entry) {
    return <>{children}</>;
  }
  const { Comp, props } = entry;
  return (
    <Comp {...props} style={commonStyle}>
      {children}
    </Comp>
  );
}

export default CanvasUIGlobal;
