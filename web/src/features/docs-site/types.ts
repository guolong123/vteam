export interface DocDef {
  id: string;
  name: string;
  kind: string;
  description?: string;
  file: string;
  parent?: string;
  order: number;
  artifactId?: string;
}

export interface TocItem {
  text: string;
  id: string;
  level: number;
}

export type DeviceType = "desktop" | "mobile";

export interface DeviceSpec {
  width: number;
  height: number;
  label: string;
}

export const DEVICE_SPECS: Record<DeviceType, DeviceSpec> = {
  desktop: { width: 1280, height: 800, label: "PC" },
  mobile: { width: 390, height: 844, label: "移动端" },
};

export interface PrototypeListItem {
  id: string;
  metaId?: string;
  name: string;
  file: string;
  description?: string;
  group?: string;
  artifactId?: string;
}

export interface PrototypeEmbedSpec {
  id: string;
  title?: string;
  device?: DeviceType;
  height?: number;
}

export interface PrototypeListSpec {
  embed?: boolean;
}

export interface ParsedPrd {
  markdown: string;
  embeds: Map<string, PrototypeEmbedSpec>;
  lists: Map<string, PrototypeListSpec>;
  inlineRefs: Map<string, string>;
}
