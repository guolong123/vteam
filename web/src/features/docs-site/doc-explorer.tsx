"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDocsRegistry, useDocContent, useDeleteArtifact, usePrototypes } from "./hooks";
import { DocsMarkdown } from "./docs-markdown";
import type { DocDef } from "./types";
import { neutral, surface, border, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const EMPTY_DOCS: DocDef[] = [];

/* 品牌蓝（对齐 roleText.product，双主题下保持可读） */
const ACCENT = "#0D9488";
const ACCENT_BG = "rgba(13,148,136,0.10)";

const TRASH_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

function FileContentCard({ fileUrl, fileExt, fileName }: { fileUrl: string; fileExt: string; fileName: string }) {
  const isImage = IMAGE_EXTS.has(fileExt);
  return (
    <div style={{ margin: "0 auto", width: "100%", maxWidth: 720, padding: `${space.xl * 2}px ${space.xl}px` }}>
      {isImage && (
        <img src={fileUrl} alt={fileName} loading="lazy" style={{ maxWidth: "100%", maxHeight: 480, objectFit: "contain", borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: neutral[50] }} />
      )}
      <div style={{ marginTop: space.lg, display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap", padding: space.lg, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: neutral[50] }}>
        <span style={{ display: "flex", width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: ACCENT_BG, fontSize: fontSize.sm, fontWeight: 700, color: ACCENT, fontFamily: fontFamily.body }}>{fileExt.slice(0, 4).toUpperCase()}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fileName}</div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>{fileExt.toUpperCase()} 文件</div>
        </div>
        <a href={fileUrl} download style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.sm, border: "none", backgroundColor: ACCENT, color: "#FFF", fontSize: fontSize.sm, fontWeight: 500, textDecoration: "none", cursor: "pointer", fontFamily: fontFamily.body }}>
          <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>↓</span>
          下载
        </a>
      </div>
    </div>
  );
}

export function DocExplorer({ taskId, initialDocId }: { taskId: string; initialDocId?: string }) {
  const [activeDocId, setActiveDocId] = useState<string>("");
  const [activeSection, setActiveSection] = useState<string>("");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const registryQuery = useDocsRegistry(taskId);
  const protosQuery = usePrototypes(taskId);
  const protos = protosQuery.data ?? [];
  const docs = registryQuery.data ?? EMPTY_DOCS;
  const deleteMutation = useDeleteArtifact(taskId);
  const rootDocs = useMemo(() => docs.filter((d) => !d.parent).sort((a, b) => a.order - b.order), [docs]);
  const childrenOf = (parentId: string) => docs.filter((d) => d.parent === parentId).sort((a, b) => a.order - b.order);
  const findDoc = (id: string) => docs.find((d) => d.id === id);
  const activeDoc = findDoc(activeDocId) ?? rootDocs[0];
  const initialAppliedRef = useRef(false);
  useEffect(() => {
    if (initialAppliedRef.current || rootDocs.length === 0) return;
    const target = initialDocId && findDoc(initialDocId) ? initialDocId : rootDocs[0].id;
    setActiveDocId(target);
    initialAppliedRef.current = true;
  }, [rootDocs, initialDocId]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (activeDoc?.parent) next.add(activeDoc.parent);
      if (activeDoc && childrenOf(activeDoc.id).length > 0) next.add(activeDoc.id);
      return next;
    });
  }, [activeDoc]);
  const toggleExpand = (id: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const contentQuery = useDocContent(taskId, activeDoc?.file ?? "", activeDoc?.fileExt, activeDoc?.fileUrl);
  const content = contentQuery.data ?? null;
  const isFileContent = content?.kind === "file";
  const mdContent = content?.kind === "markdown" ? content.content : null;
  const error = contentQuery.isError ? `加载文档失败：${activeDoc?.file}` : null;
  const toc = useMemo(() => {
    if (!mdContent) return [] as { text: string; id: string; level: number }[];
    const items: { text: string; id: string; level: number }[] = [];
    const seen = new Set<string>();
    for (const m of mdContent.matchAll(/^(##|###)\s+(.+)$/gm)) {
      const text = m[2].trim();
      const id = text.replace(/[`*_#[]()]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ text, id, level: m[1] === "##" ? 1 : 2 });
    }
    return items.slice(0, 80);
  }, [mdContent]);
  useEffect(() => {
    if (!mdContent) return;
    const headings = toc.map((t) => document.getElementById(t.id)).filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;
    const observer = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) setActiveSection(e.target.id); }, { root: mainRef.current, rootMargin: "-80px 0px -30% 0px" });
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [mdContent, toc]);
  const scrollToHeading = (id: string) => { const el = document.getElementById(id); if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); setActiveSection(id); } };
  return (
    <div data-testid="docs-explorer" style={{ display: "flex", minHeight: 0, flex: 1, backgroundColor: surface }}>
      <aside className="hidden lg:flex" style={{ width: 256, flexShrink: 0, flexDirection: "column", borderRight: `1px solid ${border}`, backgroundColor: neutral[50], fontFamily: fontFamily.body }}>
        <div style={{ flexShrink: 0, overflowY: "auto", borderBottom: `1px solid ${border}` }}>
          <p style={{ padding: `${space.lg}px ${space.lg}px ${space.sm}px`, fontSize: fontSize.xs, fontWeight: 600, color: neutral[400] }}>文档</p>
          {registryQuery.isError ? <p style={{ padding: `0 ${space.lg}px ${space.lg}px`, fontSize: fontSize.xs, color: "#DC2626" }}>文档列表加载失败</p> : rootDocs.length === 0 ? <p style={{ padding: `0 ${space.lg}px ${space.lg}px`, fontSize: fontSize.xs, color: neutral[400] }}>{registryQuery.isPending ? "加载中…" : "暂无产出物"}</p> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: `${space.xs}px ${space.sm}px ${space.lg}px` }}>
              {rootDocs.map((root) => {
                const kids = childrenOf(root.id);
                const isExpanded = expanded.has(root.id);
                const active = root.id === activeDoc?.id;
                const isHovered = hoverId === root.id;
                return (
                  <div key={root.id}>
                    <div
                      onMouseEnter={() => setHoverId(root.id)}
                      onMouseLeave={() => setHoverId(null)}
                      style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: radius.sm, ...(active ? { backgroundColor: ACCENT_BG } : {}) }}
                    >
                      {kids.length > 0 ? <button type="button" onClick={() => toggleExpand(root.id)} style={{ display: "flex", width: 20, height: 20, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, color: neutral[400], background: "transparent", cursor: "pointer" }}>{isExpanded ? "▾" : "▸"}</button> : <span style={{ width: 20, height: 20, flexShrink: 0 }} />}
                      <button type="button" onClick={() => setActiveDocId(root.id)} aria-current={active ? "page" : undefined} style={{ display: "flex", minWidth: 0, flex: 1, alignItems: "center", gap: space.sm, borderRadius: radius.sm, padding: `${space.sm}px ${space.sm + 2}px`, textAlign: "left", cursor: "pointer", background: "transparent", color: active ? ACCENT : neutral[600], border: "none", fontFamily: fontFamily.body }}>
                        <span style={{ display: "flex", width: 20, height: 20, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, fontSize: 9, fontWeight: 600, background: active ? "rgba(13,148,136,0.18)" : neutral[200], color: active ? ACCENT : neutral[500] }}>{root.fileExt ? root.fileExt.slice(0, 2).toUpperCase() : root.kind.slice(0, 2)}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fontSize.md, fontWeight: 500 }}>{root.name}</span>
                      </button>
                      {root.artifactId ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); if (confirm(`确定删除文档「${root.name}」？`)) deleteMutation.mutate(root.artifactId!); }}
                          style={{
                            flexShrink: 0, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center",
                            borderRadius: radius.sm, border: "none", cursor: "pointer",
                            backgroundColor: isHovered ? "rgba(220,38,38,0.10)" : "transparent",
                            color: isHovered ? "#DC2626" : neutral[300],
                            opacity: isHovered ? 1 : 0, transition: "opacity .15s, background-color .15s, color .15s",
                          }}
                          aria-label={`删除 ${root.name}`}
                        >{TRASH_ICON}</button>
                      ) : (
                        <span style={{ flexShrink: 0, width: 22 }} />
                      )}
                    </div>
                    {isExpanded && kids.length > 0 && (
                      <div style={{ marginTop: 4, marginLeft: space.sm, display: "flex", flexDirection: "column", gap: 4, borderLeft: `1px solid ${border}`, paddingLeft: space.lg }}>
                        {kids.map((kid) => {
                          const kidActive = kid.id === activeDoc?.id;
                          return <button key={kid.id} type="button" onClick={() => setActiveDocId(kid.id)} style={{ display: "flex", width: "100%", alignItems: "center", gap: space.sm, borderRadius: radius.sm, padding: `${space.sm}px ${space.sm + 2}px`, textAlign: "left", cursor: "pointer", background: kidActive ? ACCENT_BG : "transparent", color: kidActive ? ACCENT : neutral[500], border: "none", fontFamily: fontFamily.body }}><span style={{ width: 6, height: 6, flexShrink: 0, borderRadius: "50%", background: kidActive ? "#0D9488" : neutral[300] }} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{kid.name}</span></button>;
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
      <main ref={mainRef} style={{ minWidth: 0, flex: 1, overflowY: "auto", backgroundColor: surface, fontFamily: fontFamily.body }}>
        {registryQuery.isError ? <div style={{ display: "flex", height: "100%", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: space.md, padding: `0 ${space.xl}px`, textAlign: "center" }}><p style={{ fontSize: fontSize.md, color: "#DC2626" }}>文档列表加载失败</p><button type="button" onClick={() => registryQuery.refetch()} style={{ borderRadius: radius.sm, border: `1px solid ${border}`, backgroundColor: surface, padding: "6px 12px", fontSize: fontSize.md, cursor: "pointer", color: neutral[700] }}>重试</button></div> : rootDocs.length === 0 ? <div style={{ display: "flex", height: "100%", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: `0 ${space.xl}px`, textAlign: "center" }}><p style={{ fontSize: fontSize.md, color: neutral[500] }}>该任务暂无产出物</p></div> : error ? <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", fontSize: fontSize.md, color: "#DC2626" }}>{error}</div> : !content ? <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", fontSize: fontSize.md, color: neutral[400] }}>加载文档…</div> : isFileContent ? <FileContentCard fileUrl={content.fileUrl} fileExt={content.fileExt} fileName={activeDoc?.name ?? "file"} /> : (
          <article style={{ margin: "0 auto", width: "100%", maxWidth: 960, padding: `${space.xl * 2}px ${space.xl}px ${space.xl * 2}px` }}>
            <DocsMarkdown markdown={mdContent!} prototypes={protos} taskId={taskId} />
            <footer style={{ marginTop: space.xl * 2, borderTop: `1px solid ${border}`, paddingTop: space.lg, fontSize: fontSize.xs, color: neutral[400] }}>vteam docs · {activeDoc?.name}</footer>
          </article>
        )}
      </main>
      <aside className="hidden lg:block" style={{ width: 240, flexShrink: 0, overflowY: "auto", borderLeft: `1px solid ${border}`, backgroundColor: neutral[50], padding: `${space.lg}px 0`, fontFamily: fontFamily.body }}>
        <p style={{ padding: `0 ${space.lg}px ${space.md}px`, fontSize: fontSize.xs, fontWeight: 600, color: neutral[400] }}>章节</p>
        {!mdContent ? <p style={{ padding: `0 ${space.lg}px`, fontSize: fontSize.xs, color: neutral[400] }}>{isFileContent ? "非 md 文件无章节" : "加载中…"}</p> : toc.length === 0 ? <p style={{ padding: `0 ${space.lg}px`, fontSize: fontSize.xs, color: neutral[400] }}>暂无章节</p> : (
          <nav style={{ display: "flex", flexDirection: "column", gap: 4, padding: `0 ${space.sm}px ${space.lg}px` }}>
            {toc.map((t) => (
              <button key={t.id} type="button" onClick={() => scrollToHeading(t.id)} style={{ display: "block", width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", borderRadius: radius.sm, textAlign: "left", cursor: "pointer", border: "none", fontFamily: fontFamily.body, ...(t.level === 2 ? { marginLeft: space.md, borderLeft: `1px solid ${border}`, padding: `4px ${space.md}px`, fontSize: fontSize.xs, color: neutral[500] } : { padding: `${space.sm}px ${space.md}px`, fontSize: 13, fontWeight: 600, color: neutral[700] }), ...(activeSection === t.id ? { backgroundColor: ACCENT_BG, color: ACCENT } : {}) }}>{t.text}</button>
            ))}
          </nav>
        )}
      </aside>
    </div>
  );
}
