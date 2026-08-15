import { useEffect, useMemo, useRef, useState } from "react";
import { parsePrdMarkdown } from "./parser";
import PrdMarkdown from "./PrdMarkdown";
import { ROOT_DOCS, childrenOf, findDoc } from "./docs";

/**
 * DocExplorer：文档阅读器（多文档，树形层级）
 * =====================================================
 * 布局：左侧文档树（父文档可展开/折叠，子文档缩进）+ 中间文档内容 + 右侧章节菜单。
 * 文档从 public/prd/ 加载（构建时同步自 docs/），解析原型标记并渲染。
 * 章节定位使用 scrollIntoView（不改变 URL hash，避免与应用路由冲突）。
 */

interface TocItem {
  text: string;
  id: string;
  /** 1 = ## 章节，2 = ### 子章节 */
  level: number;
}

interface DocExplorerProps {
  activeDocId: string;
  onSelectDoc: (id: string) => void;
}

export default function DocExplorer({ activeDocId, onSelectDoc }: DocExplorerProps) {
  const activeDoc = findDoc(activeDocId) ?? ROOT_DOCS[0];
  // 默认展开包含当前文档的父节点；若当前文档自身是父文档，也一并展开
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const parent = activeDoc?.parent;
    const self = activeDoc && childrenOf(activeDoc.id).length > 0 ? activeDoc.id : undefined;
    return new Set([parent, self].filter((x): x is string => !!x));
  });
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string>("");
  const mainRef = useRef<HTMLElement | null>(null);

  // 当 activeDoc 变化时，确保其父节点（或自身为父文档）展开
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (activeDoc?.parent) next.add(activeDoc.parent);
      if (activeDoc && childrenOf(activeDoc.id).length > 0) next.add(activeDoc.id);
      return next;
    });
  }, [activeDoc]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 加载当前文档
  useEffect(() => {
    if (!activeDoc) return;
    let cancelled = false;
    setSource(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/prd/${activeDoc.file}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setSource(text);
      } catch {
        if (!cancelled) setError(`加载文档失败：${activeDoc.file}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeDoc]);

  const parsed = useMemo(() => (source ? parsePrdMarkdown(source) : null), [source]);

  // 章节菜单：从 markdown 提取 ## / ### 标题
  const toc = useMemo<TocItem[]>(() => {
    if (!source) return [];
    const items: TocItem[] = [];
    for (const m of source.matchAll(/^(##|###)\s+(.+)$/gm)) {
      const text = m[2].trim();
      items.push({
        text,
        id: text
          .replace(/[`*_#[]()]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .toLowerCase(),
        level: m[1] === "##" ? 1 : 2,
      });
    }
    return items.slice(0, 80);
  }, [source]);

  // 滚动时高亮当前章节
  useEffect(() => {
    if (!parsed) return;
    const headings = toc
      .map((t) => document.getElementById(t.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveSection(entry.target.id);
        }
      },
      { root: mainRef.current, rootMargin: "-80px 0px -30% 0px" },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [parsed, toc]);

  const scrollToHeading = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveSection(id);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 bg-white">
      {/* 左侧：文档树 */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50/60">
        <div className="shrink-0 overflow-y-auto border-b border-slate-200">
          <p className="px-4 pb-2 pt-4 text-xs font-semibold text-slate-400">文档</p>
          <div className="space-y-0.5 px-2 pb-3">
            {ROOT_DOCS.map((root) => {
              const kids = childrenOf(root.id);
              const isExpanded = expanded.has(root.id);
              const active = root.id === activeDoc.id;
              return (
                <div key={root.id}>
                  {/* 顶级文档 */}
                  <div className="flex items-center gap-1">
                    {kids.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => toggleExpand(root.id)}
                        aria-label={isExpanded ? "折叠子文档" : "展开子文档"}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className={`size-3 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="m9 18 6-6-6-6" />
                        </svg>
                      </button>
                    ) : (
                      <span className="size-5 shrink-0" />
                    )}
                    <button
                      type="button"
                      onClick={() => onSelectDoc(root.id)}
                      aria-current={active ? "page" : undefined}
                      className={`flex min-w-0 flex-1 items-center gap-2 rounded-[--radius-control] px-2 py-1.5 text-left transition-colors ${
                        active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                      }`}
                    >
                      <span
                        className={`flex size-5 shrink-0 items-center justify-center rounded text-[9px] font-semibold ${
                          active ? "bg-brand-100 text-brand-700" : "bg-slate-200 text-slate-500"
                        }`}
                      >
                        {root.kind}
                      </span>
                      <span className="truncate text-sm font-medium">{root.name}</span>
                    </button>
                  </div>

                  {/* 子文档（展开时显示） */}
                  {isExpanded && kids.length > 0 && (
                    <div className="mt-0.5 space-y-0.5 border-l border-slate-200 pl-3.5 ml-2">
                      {kids.map((kid) => {
                        const kidActive = kid.id === activeDoc.id;
                        return (
                          <button
                            key={kid.id}
                            type="button"
                            onClick={() => onSelectDoc(kid.id)}
                            aria-current={kidActive ? "page" : undefined}
                            className={`flex w-full items-center gap-1.5 rounded-[--radius-control] px-2 py-1.5 text-left transition-colors ${
                              kidActive
                                ? "bg-brand-50 text-brand-700"
                                : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                            }`}
                          >
                            <span
                              className={`size-1.5 shrink-0 rounded-full ${
                                kidActive ? "bg-brand-500" : "bg-slate-300"
                              }`}
                            />
                            <span className="truncate text-[13px]">{kid.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </aside>

      {/* 右侧：文档内容 */}
      <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-danger-600">
            <p>{error}</p>
          </div>
        ) : !parsed ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">加载文档…</div>
        ) : (
          <article className="mx-auto max-w-5xl px-5 py-8 sm:px-8">
            <PrdMarkdown parsed={parsed} />
            <footer className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-400">
              Orchestra · {activeDoc.name} · 由 prototype-viewer 渲染（支持原型标记内嵌）
            </footer>
          </article>
        )}
      </main>

      {/* 右侧：章节菜单 */}
      <aside className="hidden w-60 shrink-0 overflow-y-auto border-l border-slate-200 bg-slate-50/60 py-4 lg:block">
        <p className="px-4 pb-2 text-xs font-semibold text-slate-400">章节</p>
        {error ? (
          <p className="px-4 text-xs text-danger-600">{error}</p>
        ) : !source ? (
          <p className="px-4 text-xs text-slate-400">加载中…</p>
        ) : (
          <nav className="space-y-0.5 px-2 pb-4">
            {toc.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => scrollToHeading(t.id)}
                className={`block w-full truncate rounded px-3 py-1.5 text-left transition-colors ${
                  t.level === 2 ? "pl-6 text-xs text-slate-500" : "text-[13px] font-medium text-slate-700"
                } ${
                  activeSection === t.id
                    ? "bg-brand-50 font-medium text-brand-700"
                    : "hover:bg-slate-100 hover:text-slate-900"
                }`}
                title={t.text}
              >
                {t.text}
              </button>
            ))}
          </nav>
        )}
      </aside>
    </div>
  );
}
