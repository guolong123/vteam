import { useMemo, useRef, useState } from "react";
import type { PrototypeDef } from "../prototypes/types";

/**
 * PrototypeNav：原型导航
 * =====================================================
 * 按 meta.group 分组展示所有已注册原型，支持：
 *  - 点击切换
 *  - 键盘切换：方向键 ↑/↓ 移动焦点并选中，Enter/Space 确认，Home/End 跳转
 */
interface PrototypeNavProps {
  defs: PrototypeDef[];
  activeId: string;
  onSelect: (id: string) => void;
}

export default function PrototypeNav({ defs, activeId, onSelect }: PrototypeNavProps) {
  const groups = useMemo(() => {
    const map = new Map<string, PrototypeDef[]>();
    for (const def of defs) {
      const g = def.meta.group ?? "其他";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(def);
    }
    return Array.from(map.entries());
  }, [defs]);

  // 扁平索引（用于方向键导航）
  const flatIds = useMemo(() => defs.map((d) => d.meta.id), [defs]);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState(-1);

  const moveFocus = (next: number) => {
    const clamped = (next + flatIds.length) % flatIds.length;
    setFocusIndex(clamped);
    buttonRefs.current[clamped]?.focus();
    onSelect(flatIds[clamped]);
  };

  return (
    <nav
      aria-label="原型导航"
      className="flex h-full flex-col gap-4 overflow-y-auto py-4 pr-1"
      onKeyDown={(e) => {
        if (flatIds.length === 0) return;
        const idx = focusIndex >= 0 ? focusIndex : Math.max(0, flatIds.indexOf(activeId));
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveFocus(idx + 1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveFocus(idx - 1);
        } else if (e.key === "Home") {
          e.preventDefault();
          moveFocus(0);
        } else if (e.key === "End") {
          e.preventDefault();
          moveFocus(flatIds.length - 1);
        }
      }}
    >
      {groups.map(([group, items]) => (
        <div key={group}>
          <h3 className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {group}
          </h3>
          <ul className="space-y-0.5">
            {items.map((def) => {
              const active = def.meta.id === activeId;
              const flatIndex = flatIds.indexOf(def.meta.id);
              return (
                <li key={def.meta.id}>
                  <button
                    ref={(el) => {
                      buttonRefs.current[flatIndex] = el;
                    }}
                    type="button"
                    onClick={() => {
                      setFocusIndex(flatIndex);
                      onSelect(def.meta.id);
                    }}
                    aria-current={active ? "page" : undefined}
                    className={`group flex w-full items-start gap-2.5 rounded-[--radius-control] px-3 py-2 text-left transition-colors ${
                      active
                        ? "bg-brand-50 text-brand-700"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    }`}
                  >
                    <span
                      className={`mt-1 size-1.5 shrink-0 rounded-full ${
                        active ? "bg-brand-500" : "bg-slate-300 group-hover:bg-slate-400"
                      }`}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{def.meta.name}</span>
                      {def.meta.description && (
                        <span className="mt-0.5 block truncate text-xs text-slate-400">
                          {def.meta.description}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
