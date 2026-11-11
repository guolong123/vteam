"use client";

/**
 * 页面特效（CanvasUI）选择器
 * =============================================
 * 原先是 AppShell 顶栏右上角的下拉（仅演示模式 `?fx=on` 可见），用户反馈
 * 「这是配置项，应该放到全局设置里」⇒ 抽成本组件，由 `/system/settings` 承载。
 *
 * 与顶栏版本的关键差异：
 * - **不再依赖演示模式开关**：设置页本身就是配置入口，配置项不该藏在 URL 参数后面；
 * - 仍持久化到 localStorage（`agent-platform-canvasui-effect`），只影响当前浏览器；
 * - 顶部提供「关闭特效」入口（等价于原下拉的空值项），便于一键回到无特效。
 */
import { useCanvasUIStore, type CanvasUIEffectKey } from "./store";
import { fontSize, fontFamily, neutral, radius, space } from "@/src/theme/tokens";

/** 效果分组（与 store 的效果键对应；3D 组件 *Object 需显式 src，不纳入）。 */
export const CANVASUI_EFFECT_GROUPS: {
  label: string;
  items: { key: CanvasUIEffectKey; label: string }[];
}[] = [
  {
    label: "光学与玻璃",
    items: [
      { key: "glass", label: "玻璃球" },
      { key: "frost", label: "霜冻" },
      { key: "magnify", label: "放大镜" },
      { key: "bend", label: "弯曲" },
      { key: "peel", label: "剥落" },
      { key: "bubble", label: "气泡" },
      { key: "displacement", label: "位移" },
    ],
  },
  {
    label: "流体与天气",
    items: [
      { key: "droplets", label: "雨滴" },
      { key: "liquid", label: "流体" },
      { key: "ripple", label: "涟漪" },
      { key: "cloth", label: "布料" },
      { key: "clouds", label: "云层" },
    ],
  },
  {
    label: "火与能量",
    items: [
      { key: "blaze", label: "火焰" },
      { key: "flamewrap", label: "火焰环绕" },
      { key: "forcefield", label: "力场" },
      { key: "laser", label: "激光" },
    ],
  },
  {
    label: "复古与特效",
    items: [
      { key: "glitch", label: "故障" },
      { key: "vhs", label: "磁带" },
      { key: "retrodither", label: "复古点阵" },
      { key: "asciify", label: "字符化" },
      { key: "decryptreveal", label: "解密揭示" },
      { key: "glyphrain", label: "字符雨" },
    ],
  },
  {
    label: "粒子与结构",
    items: [
      { key: "canvas", label: "画布" },
      { key: "particlereveal", label: "粒子揭示" },
      { key: "particlescroll", label: "粒子滚动" },
      { key: "shatter", label: "碎裂" },
      { key: "grid", label: "网格" },
      { key: "hexfloat", label: "六边形" },
    ],
  },
];

/** 效果 key → 中文名（用于回显当前选择）。 */
export function canvasuiEffectLabel(key: CanvasUIEffectKey): string {
  if (!key || key === "none") return "已关闭";
  for (const g of CANVASUI_EFFECT_GROUPS) {
    const hit = g.items.find((i) => i.key === key);
    if (hit) return hit.label;
  }
  return String(key);
}

export function CanvasUIEffectPicker() {
  const effect = useCanvasUIStore((s) => s.effect);
  const setEffect = useCanvasUIStore((s) => s.setEffect);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.sm, fontFamily: fontFamily.body }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <select
          data-testid="canvasui-select"
          aria-label="页面特效"
          value={effect}
          onChange={(e) => setEffect(e.target.value as CanvasUIEffectKey)}
          style={{
            minWidth: 200,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            color: neutral[700],
            fontSize: fontSize.sm,
            fontFamily: fontFamily.body,
            cursor: "pointer",
          }}
        >
          <option value="none">关闭特效（无）</option>
          {CANVASUI_EFFECT_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span
          data-testid="canvasui-current"
          style={{ fontSize: fontSize.xs, color: neutral[400] }}
        >
          当前：{canvasuiEffectLabel(effect)}
        </span>
        {effect !== "none" && (
          <button
            type="button"
            data-testid="canvasui-reset"
            onClick={() => setEffect("none")}
            style={{
              padding: `${space.xs}px ${space.sm}px`,
              borderRadius: radius.sm,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[600],
              fontSize: fontSize.xs,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            关闭特效
          </button>
        )}
      </div>
    </div>
  );
}
