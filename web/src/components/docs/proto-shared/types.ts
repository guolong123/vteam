import type { ComponentType } from "react";

/**
 * 原型页面（Prototype）注册契约
 * ============================================================
 * 每个原型页面是一个 React 组件，在 src/prototypes/registry.ts 中注册。
 * 模板（PrototypeViewer）会自动列出所有已注册原型，支持：
 *  - 页面内切换展示不同原型
 *  - PC / 移动端设备模拟展示
 *
 * 新增原型页面的步骤：
 *  1. 在 src/prototypes/<name>/ 下创建原型组件（自由实现，可用任何组件库/CSS）
 *  2. 在 src/prototypes/registry.ts 中导入并注册
 * 完成，无需改动模板代码。
 */

/** 设备类型：桌面 PC / 移动端 */
export type DeviceType = "desktop" | "mobile";

/**
 * 设备尺寸定义（用于 DeviceFrame 切换）
 * 后续可扩展：平板、折叠屏等
 */
export interface DeviceSpec {
  /** 展示宽度 px（内容区宽度） */
  width: number;
  /** 展示高度 px（内容区高度，0 表示自适应内容高度） */
  height: number;
  /** 设备名称（展示在切换器上） */
  label: string;
}

/** 设备规格表：模板内建 PC 与移动端两档 */
export const DEVICE_SPECS: Record<DeviceType, DeviceSpec> = {
  desktop: { width: 1280, height: 800, label: "PC" },
  mobile: { width: 390, height: 844, label: "移动端" },
};

/** 原型元信息 */
export interface PrototypeMeta {
  /** 唯一标识（用于 URL hash 定位，如 #agent-list） */
  id: string;
  /** 展示名称（导航/切换器上显示） */
  name: string;
  /** 分组（如 "管理页" / "编排" / "审批"，用于导航分组） */
  group?: string;
  /** 可选描述 */
  description?: string;
}

/** 原型定义：元信息 + 组件 */
export interface PrototypeDef {
  meta: PrototypeMeta;
  /** 原型页面组件（内部自行撑满高度，适配不同设备宽度） */
  Component: ComponentType<PrototypeRenderProps>;
}

/** 传给原型组件的渲染上下文 props */
export interface PrototypeRenderProps {
  /** 当前模拟的设备类型（原型内部可据此调整布局细节） */
  device: DeviceType;
  /** 当前模拟的设备宽度 px */
  deviceWidth: number;
}
