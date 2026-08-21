"use client";
import { useState, useMemo } from "react";
import { usePrototypes, useDeleteArtifact } from "./hooks";
import { PrototypeSandbox } from "./prototype-sandbox";
import { DeviceFrame } from "./device-frame";
import { DeviceSwitcher } from "./device-switcher";
import type { DeviceType } from "./types";
import { neutral, surface, border, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const ACCENT = "#2563EB";
const ACCENT_BG = "rgba(37,99,235,0.10)";

const TRASH_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

export function PrototypePanel({ taskId, initialProtoId }: { taskId: string; initialProtoId?: string }) {
  const { data, isError, error, refetch } = usePrototypes(taskId);
  const prototypes = data ?? [];
  const [selectedId, setSelectedId] = useState<string>(() => initialProtoId ?? "");
  const [device, setDevice] = useState<DeviceType>("desktop");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const selected = useMemo(() => prototypes.find((p) => p.id === selectedId) ?? prototypes[0] ?? null, [prototypes, selectedId]);
  const effectiveId = selected?.id ?? "";
  const deleteMutation = useDeleteArtifact(taskId);
  if (prototypes.length > 0 && !selectedId) {
    const wanted = initialProtoId && prototypes.some((p) => p.id === initialProtoId) ? initialProtoId : prototypes[0].id;
    if (wanted !== selectedId) setSelectedId(wanted);
  }
  if (prototypes.length === 0) {
    return (
      <div data-testid="docs-prototype-panel" style={{ display: "flex", height: "100%", minHeight: 0, flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: neutral[50], padding: `0 ${space.xl}px`, fontFamily: fontFamily.body }}>
        <div style={{ maxWidth: 448, borderRadius: radius.md, border: `1px dashed ${neutral[300]}`, backgroundColor: surface, padding: `${space.xxl * 2}px ${space.xl}px`, textAlign: "center" }}>
          <p style={{ fontSize: fontSize.md, lineHeight: 1.6, color: neutral[500] }}>{isError ? String((error as Error)?.message ?? "原型列表加载失败") : "该任务暂无原型产出物，Agent 提交 <name>/index.tsx 后自动出现"}</p>
          {isError && <button type="button" onClick={() => refetch()} style={{ marginTop: space.lg, borderRadius: radius.sm, border: `1px solid ${border}`, backgroundColor: surface, padding: "6px 12px", fontSize: fontSize.xs, cursor: "pointer", color: neutral[700] }}>重试</button>}
        </div>
      </div>
    );
  }
  return (
    <div data-testid="docs-prototype-panel" className="flex-col md:flex-row" style={{ display: "flex", minHeight: 0, flex: 1, backgroundColor: surface, fontFamily: fontFamily.body }}>
      <div className="flex md:hidden" style={{ flexShrink: 0, gap: space.sm, overflowX: "auto", borderBottom: `1px solid ${border}`, backgroundColor: surface, padding: `${space.sm}px ${space.md}px` }}>
        {prototypes.map((p) => (
          <button key={p.id} type="button" onClick={() => setSelectedId(p.id)} style={{ flexShrink: 0, borderRadius: radius.pill, padding: "6px 12px", fontSize: fontSize.md, cursor: "pointer", border: "none", fontFamily: fontFamily.body, ...(p.id === effectiveId ? { backgroundColor: "#2563EB", color: "#FFFFFF" } : { border: `1px solid ${border}`, backgroundColor: surface, color: neutral[600] }) }}>{p.name}</button>
        ))}
      </div>
      <aside className="hidden md:flex" style={{ width: 256, flexShrink: 0, flexDirection: "column", borderRight: `1px solid ${border}`, backgroundColor: neutral[50] }}>
        <div style={{ flexShrink: 0, borderBottom: `1px solid ${border}`, padding: `${space.md}px ${space.lg}px` }}>
          <p style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>原型</p>
          <p style={{ marginTop: 2, fontSize: fontSize.xs, color: neutral[400] }}>{prototypes.length} 个原型 · 点击切换</p>
        </div>
        <div style={{ minHeight: 0, flex: 1, overflowY: "auto", padding: `${space.lg}px 0` }}>
          <nav aria-label="原型导航" style={{ display: "flex", flexDirection: "column", gap: space.lg, padding: `${space.lg}px ${space.md}px` }}>
            <div>
              <h3 style={{ padding: `0 ${space.md}px ${space.sm}px`, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.05, color: neutral[400] }}>全部原型</h3>
              <ul style={{ display: "flex", flexDirection: "column", gap: 2, listStyle: "none", margin: 0, padding: 0 }}>
                {prototypes.map((proto) => {
                  const active = proto.id === effectiveId;
                  const isHovered = hoverId === proto.id;
                  return (
                    <li
                      key={proto.id}
                      onMouseEnter={() => setHoverId(proto.id)}
                      onMouseLeave={() => setHoverId(null)}
                      style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: radius.sm, ...(active ? { backgroundColor: ACCENT_BG } : {}) }}
                    >
                      <button type="button" onClick={() => setSelectedId(proto.id)} aria-current={active ? "page" : undefined} style={{ display: "flex", minWidth: 0, flex: 1, alignItems: "flex-start", gap: 10, borderRadius: radius.sm, padding: `${space.sm}px ${space.md}px`, textAlign: "left", cursor: "pointer", border: "none", fontFamily: fontFamily.body, backgroundColor: "transparent", color: active ? ACCENT : neutral[600] }}>
                        <span style={{ marginTop: 4, width: 6, height: 6, flexShrink: 0, borderRadius: "50%", backgroundColor: active ? "#3B82F6" : neutral[300] }} />
                        <span style={{ minWidth: 0 }}><span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fontSize.md, fontWeight: 500 }}>{proto.name}</span><span style={{ marginTop: 2, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: fontFamily.mono, fontSize: 11, color: neutral[400] }}>{proto.id}</span></span>
                      </button>
                      {proto.artifactId ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); if (confirm(`确定删除原型「${proto.name}」？`)) deleteMutation.mutate(proto.artifactId!); }}
                          style={{
                            flexShrink: 0, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center",
                            borderRadius: radius.sm, border: "none", cursor: "pointer",
                            backgroundColor: isHovered ? "rgba(220,38,38,0.10)" : "transparent",
                            color: isHovered ? "#DC2626" : neutral[300],
                            opacity: isHovered ? 1 : 0, transition: "opacity .15s, background-color .15s, color .15s",
                          }}
                          aria-label={`删除 ${proto.name}`}
                        >{TRASH_ICON}</button>
                      ) : (
                        <span style={{ flexShrink: 0, width: 24 }} />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </nav>
        </div>
      </aside>
      <main style={{ minWidth: 0, flex: 1, overflowY: "auto", backgroundColor: surface }}>
        <div style={{ position: "sticky", top: 0, zIndex: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.md, borderBottom: `1px solid ${border}`, backgroundColor: surface, padding: "10px 16px" }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>{selected?.name ?? "原型预览"}</h3>
            <p className="hidden sm:block" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: fontFamily.mono, fontSize: fontSize.xs, color: neutral[400] }}>{selected ? `prototype.vteam.local/${selected.file}` : ""}</p>
          </div>
          <DeviceSwitcher device={device} onChange={setDevice} />
        </div>
        {selected ? (
          <div style={{ padding: `${space.xl}px ${space.lg}px` }}>
            <DeviceFrame device={device} label={`prototype.vteam.local/${selected.file}`}>
              <PrototypeSandbox key={`${selected.file}-${device}`} taskId={taskId} file={selected.file} name={selected.name} device={device} />
            </DeviceFrame>
          </div>
        ) : <div style={{ display: "flex", height: 256, alignItems: "center", justifyContent: "center", fontSize: fontSize.md, color: neutral[400] }}>选择左侧原型查看详情</div>}
      </main>
    </div>
  );
}
