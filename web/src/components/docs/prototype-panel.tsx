"use client";

/**
 * PrototypePanel：文档站「原型」tab 浏览器（is_0000000037 动态渲染版 / TSX 渲染）
 * =============================================================
 * 从静态注册表改为动态拉取服务端原型列表渲染：
 * - 挂载时拉取原型列表（GET /docs-site/:taskId/prototypes）
 * - 左侧原型列表（名称）+ 右侧选中原型 TSX 渲染（PrototypeTsxViewer）
 * - 选中原型源码（GET /docs-site/:taskId/prototypes/<file>，file 为 `<name>/index.tsx`）
 *   由 PrototypeTsxViewer 拉取并 esbuild-wasm 编译 + iframe sandbox 渲染
 * - 空列表 → 空态提示；列表加载失败 → 错误态
 */
import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { PrototypeTsxViewer } from "./prototype-tsx-viewer";

interface PrototypeListItem {
  id: string;
  name: string;
  file: string;
}

interface PrototypePanelProps {
  taskId: string;
}

export function PrototypePanel({ taskId }: PrototypePanelProps) {
  const [prototypes, setPrototypes] = useState<PrototypeListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [listError, setListError] = useState<string | null>(null);

  // 拉取原型列表
  useEffect(() => {
    if (!taskId) return;

    const fetchPrototypes = async () => {
      setListError(null);
      try {
        const data = await api.get<{ items: PrototypeListItem[] }>(
          `/docs-site/${taskId}/prototypes`
        );
        setPrototypes(data.items ?? []);
        // 自动选中第一个
        if (data.items && data.items.length > 0) {
          setSelectedId(data.items[0].id);
        }
      } catch (err) {
        console.error("Failed to fetch prototypes:", err);
        // 404 或其他错误视为无原型（服务端可能尚未部署）
        setPrototypes([]);
        setListError("原型列表加载失败，请稍后重试");
      }
    };

    fetchPrototypes();
  }, [taskId]);

  const selected = prototypes.find((p) => p.id === selectedId) ?? null;

  // 空态
  if (prototypes.length === 0) {
    return (
      <div
        data-testid="docs-prototype-panel"
        className="flex h-full min-h-0 items-center justify-center bg-white p-6"
      >
        <div className="text-center">
          <div className="mb-3 text-4xl text-slate-300">📋</div>
          <p className="text-sm text-slate-500">
            {listError ??
              "该任务暂无原型产出物，Agent 提交 <name>/index.tsx 后自动出现"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="docs-prototype-panel"
      className="flex h-full min-h-0 bg-white font-sans text-slate-900 antialiased"
    >
      {/* 左侧：原型列表 */}
      <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-slate-200 bg-white md:block">
        <div className="p-3">
          <h3 className="mb-2 text-xs font-semibold text-slate-400">原型列表</h3>
          <nav className="space-y-0.5">
            {prototypes.map((proto) => (
              <button
                key={proto.id}
                type="button"
                onClick={() => setSelectedId(proto.id)}
                className={`w-full rounded-[--radius-control] px-3 py-2 text-left text-sm transition-colors ${
                  selectedId === proto.id
                    ? "bg-brand-50 font-medium text-brand-700"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                {proto.name}
              </button>
            ))}
          </nav>
        </div>
      </aside>

      {/* 主区：TSX 原型渲染 */}
      <main className="min-w-0 min-h-0 flex-1 overflow-y-auto">
        {selected ? (
          <PrototypeTsxViewer taskId={taskId} file={selected.file} name={selected.name} />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-400">
            选择左侧原型查看详情
          </div>
        )}
      </main>
    </div>
  );
}
