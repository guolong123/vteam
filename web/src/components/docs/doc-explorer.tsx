"use client";

/**
 * DocExplorer：任务产出物文档阅读器（is_0000000024 v4，移植自 prototype-viewer）
 * =============================================================
 * - 数据源：registry（GET /docs-site/:taskId/registry，DocDef[]，api.get Authorization 头）
 *   与文档正文（GET /docs-site/:taskId/prd/<file>，纯文本，fetch Bearer 头）；
 * - 布局：左文档树 + 中文档内容 + 右章节菜单（与 prototype-viewer 一致）；
 * - 实时性：registry 30s refetchInterval（AC-1 新口径，is_0000000020 同模式）；
 * - 章节定位 scrollIntoView（不改 URL hash，避免与应用路由冲突）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, getAuthToken, API_BASE_URL } from "@/lib/api";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";
import { DocsMarkdown } from "./prd-markdown";

const baseFont = { fontFamily: fontFamily.body } as const;

/** 空注册表（稳定引用，避免每次渲染新建数组导致 useMemo 依赖抖动）。 */
const EMPTY_DOCS: DocDef[] = [];

/** 文档注册表条目（对齐 server buildRegistry / prototype-viewer DocDef）。 */
export interface DocDef {
  id: string;
  name: string;
  kind: string;
  description?: string;
  file: string;
  parent?: string;
  order: number;
}

interface TocItem {
  text: string;
  id: string;
  level: number;
}

export function DocExplorer({ taskId }: { taskId: string }) {
  const [activeDocId, setActiveDocId] = useState<string>("");
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string>("");
  const mainRef = useRef<HTMLElement | null>(null);

  // registry：30s 轮询（AC-1 新口径），api.get 自动带 Authorization
  const registryQuery = useQuery({
    queryKey: ["docs-registry", taskId],
    queryFn: () => api.get<DocDef[]>(`/docs-site/${taskId}/registry`),
    enabled: !!taskId,
    refetchInterval: 30_000,
    retry: false,
  });
  const docs = registryQuery.data ?? EMPTY_DOCS;

  const rootDocs = useMemo(
    () => docs.filter((d) => !d.parent).sort((a, b) => a.order - b.order),
    [docs],
  );
  const childrenOf = (parentId: string) =>
    docs.filter((d) => d.parent === parentId).sort((a, b) => a.order - b.order);
  const findDoc = (id: string) => docs.find((d) => d.id === id);
  const activeDoc = findDoc(activeDocId) ?? rootDocs[0];

  // 缺省选中第一文档
  useEffect(() => {
    if (!activeDocId && rootDocs.length > 0) {
      setActiveDocId(rootDocs[0].id);
    }
  }, [rootDocs, activeDocId]);

  // 默认展开包含当前文档的父节点
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (activeDoc?.parent) next.add(activeDoc.parent);
      if (activeDoc && childrenOf(activeDoc.id).length > 0) next.add(activeDoc.id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDoc]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 加载当前文档正文（prd 端点返回纯文本，fetch Bearer 头）
  useEffect(() => {
    if (!activeDoc || !taskId) return;
    let cancelled = false;
    setSource(null);
    setError(null);
    (async () => {
      try {
        const token = getAuthToken();
        const url = `${API_BASE_URL}/docs-site/${encodeURIComponent(taskId)}/prd/${encodeURIComponent(activeDoc.file)}`;
        const res = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
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
  }, [activeDoc, taskId]);

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

  // 滚动高亮当前章节
  useEffect(() => {
    if (!source) return;
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
  }, [source, toc]);

  const scrollToHeading = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveSection(id);
    }
  };

  const treeBtnBase: React.CSSProperties = {
    border: "none",
    background: "transparent",
    textAlign: "left",
    cursor: "pointer",
    fontFamily: fontFamily.body,
  };

  return (
    <div data-testid="docs-explorer" style={{ display: "flex", minHeight: 0, flex: 1, backgroundColor: "#FFFFFF", ...baseFont }}>
      {/* 左侧：文档树 */}
      <aside style={{ width: 240, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${neutral[200]}`, backgroundColor: neutral[50] }}>
        <div style={{ flexShrink: 0, overflowY: "auto", borderBottom: `1px solid ${neutral[200]}`, ...baseFont }}>
          <p style={{ margin: 0, padding: `${space.md}px ${space.lg}px ${space.sm}px`, fontSize: fontSize.xs, fontWeight: 600, color: neutral[400] }}>
            文档
          </p>
          {registryQuery.isError ? (
            <p style={{ padding: `0 ${space.md}px ${space.md}px`, fontSize: fontSize.sm, color: "#DC2626" }}>
              文档列表加载失败
            </p>
          ) : rootDocs.length === 0 ? (
            <p style={{ padding: `0 ${space.md}px ${space.md}px`, fontSize: fontSize.sm, color: neutral[400] }}>
              {registryQuery.isPending ? "加载中…" : "暂无 doc 产出物"}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: `0 ${space.sm}px ${space.md}px` }}>
              {rootDocs.map((root) => {
                const kids = childrenOf(root.id);
                const isExpanded = expanded.has(root.id);
                const active = root.id === activeDoc?.id;
                return (
                  <div key={root.id}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {kids.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleExpand(root.id)}
                          aria-label={isExpanded ? "折叠子文档" : "展开子文档"}
                          style={{ ...treeBtnBase, width: 20, height: 20, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: neutral[400] }}
                        >
                          <span aria-hidden style={{ transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</span>
                        </button>
                      ) : (
                        <span style={{ width: 20, flexShrink: 0 }} />
                      )}
                      <button
                        type="button"
                        onClick={() => setActiveDocId(root.id)}
                        aria-current={active ? "page" : undefined}
                        style={{
                          ...treeBtnBase,
                          flex: 1,
                          minWidth: 0,
                          display: "flex",
                          alignItems: "center",
                          gap: space.sm,
                          padding: `${space.xs}px ${space.sm}px`,
                          borderRadius: radius.sm,
                          backgroundColor: active ? "#EFF6FF" : "transparent",
                          color: active ? "#1D4ED8" : neutral[600],
                          fontSize: fontSize.md,
                          fontWeight: 500,
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 18,
                            height: 18,
                            borderRadius: 4,
                            fontSize: 9,
                            fontWeight: 600,
                            backgroundColor: active ? "#DBEAFE" : neutral[200],
                            color: active ? "#1D4ED8" : neutral[500],
                            flexShrink: 0,
                          }}
                        >
                          {root.kind}
                        </span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{root.name}</span>
                      </button>
                    </div>
                    {isExpanded && kids.length > 0 && (
                      <div style={{ marginTop: 2, marginLeft: 26, paddingLeft: 12, borderLeft: `1px solid ${neutral[200]}`, display: "flex", flexDirection: "column", gap: 2 }}>
                        {kids.map((kid) => {
                          const kidActive = kid.id === activeDoc?.id;
                          return (
                            <button
                              key={kid.id}
                              type="button"
                              onClick={() => setActiveDocId(kid.id)}
                              aria-current={kidActive ? "page" : undefined}
                              style={{
                                ...treeBtnBase,
                                width: "100%",
                                display: "flex",
                                alignItems: "center",
                                gap: space.sm,
                                padding: `${space.xs}px ${space.sm}px`,
                                borderRadius: radius.sm,
                                fontSize: fontSize.sm,
                                color: kidActive ? "#1D4ED8" : neutral[500],
                                backgroundColor: kidActive ? "#EFF6FF" : "transparent",
                              }}
                            >
                              <span aria-hidden style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: kidActive ? "#2563EB" : neutral[300], flexShrink: 0 }} />
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{kid.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* 中间：文档内容 */}
      <main ref={mainRef} style={{ minWidth: 0, flex: 1, overflowY: "auto", ...baseFont }}>
        {error ? (
          <div style={{ display: "flex", height: "100%", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: `0 ${space.xl}px`, textAlign: "center", fontSize: fontSize.md, color: "#DC2626" }}>
            <p>{error}</p>
          </div>
        ) : !source ? (
          <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", fontSize: fontSize.md, color: neutral[400] }}>
            加载文档…
          </div>
        ) : (
          <article style={{ maxWidth: 860, margin: "0 auto", padding: `${space.xl}px ${space.xl}px`, ...baseFont }}>
            <DocsMarkdown markdown={source} />
          </article>
        )}
      </main>

      {/* 右侧：章节菜单 */}
      <aside style={{ display: "none", width: 220, flexShrink: 0, overflowY: "auto", borderLeft: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], paddingTop: space.md, fontFamily: fontFamily.body }}>
        <p style={{ margin: 0, padding: `0 ${space.lg}px ${space.sm}px`, fontSize: fontSize.xs, fontWeight: 600, color: neutral[400] }}>章节</p>
        {error ? (
          <p style={{ margin: 0, padding: `0 ${space.lg}px`, fontSize: fontSize.xs, color: "#DC2626" }}>{error}</p>
        ) : !source ? (
          <p style={{ margin: 0, padding: `0 ${space.lg}px`, fontSize: fontSize.xs, color: neutral[400] }}>加载中…</p>
        ) : (
          <nav style={{ display: "flex", flexDirection: "column", gap: 2, padding: `0 ${space.sm}px ${space.md}px` }}>
            {toc.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => scrollToHeading(t.id)}
                title={t.text}
                style={{
                  ...treeBtnBase,
                  display: "block",
                  width: "100%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  paddingLeft: t.level === 2 ? 22 : 12,
                  paddingTop: 5,
                  paddingBottom: 5,
                  borderRadius: radius.sm,
                  fontSize: t.level === 2 ? fontSize.xs : fontSize.sm,
                  color: activeSection === t.id ? "#1D4ED8" : t.level === 2 ? neutral[500] : neutral[700],
                  fontWeight: activeSection === t.id ? 600 : t.level === 2 ? 400 : 500,
                  backgroundColor: activeSection === t.id ? "#EFF6FF" : "transparent",
                }}
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
