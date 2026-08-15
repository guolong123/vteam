import { useEffect, useState } from "react";
import DeviceFrame from "./components/DeviceFrame";
import DeviceSwitcher from "./components/DeviceSwitcher";
import PrototypeNav from "./components/PrototypeNav";
import DocExplorer from "./prd/DocExplorer";
import { findDoc, docPath, ROOT_DOCS } from "./prd/docs";
import { PROTOTYPES } from "./prototypes/registry";
import { DEVICE_SPECS, type DeviceType } from "./prototypes/types";

/**
 * hash 路由约定
 * =====================================================
 * 空 / #protos            → 原型视图（默认，展示原型）
 * #docs                   → 文档视图（默认第一个文档）
 * #docs/<doc-id>          → 文档视图 + 顶级文档（如 #docs/requirements）
 * #docs/<parent>/<child>  → 文档视图 + 子文档（如 #docs/requirements/req-flow）
 * #<prototype-id>         → 原型视图 + 指定原型（如 #flow-editor）
 * #prd                    → 兼容旧 hash：跳转文档视图
 */

export type View = "protos" | "docs";

const PROTO_HASH = "protos";
const DOCS_HASH = "docs";

/** 兼容旧 hash：PRD 阅读器 */
const PRD_LEGACY_HASH = "prd";

/** 默认文档（第一个顶级文档） */
const DEFAULT_DOC_ID = ROOT_DOCS[0]?.id ?? "";

/** 解析 hash 为视图状态 */
function parseHash(hash: string): { view: View; protoId: string; docId: string } {
  const raw = hash.replace(/^#/, "").trim();

  if (raw === PRD_LEGACY_HASH) {
    return { view: "docs", protoId: "", docId: DEFAULT_DOC_ID };
  }

  if (raw === DOCS_HASH) {
    return { view: "docs", protoId: "", docId: DEFAULT_DOC_ID };
  }

  if (raw.startsWith(`${DOCS_HASH}/`)) {
    const parts = raw.slice(DOCS_HASH.length + 1).split("/");
    // 取路径最后一段作为文档 id（子文档场景：#docs/requirements/req-flow → req-flow）
    const docId = parts[parts.length - 1];
    return { view: "docs", protoId: "", docId: findDoc(docId) ? docId : DEFAULT_DOC_ID };
  }

  if (raw === PROTO_HASH) {
    return { view: "protos", protoId: PROTOTYPES[0]?.meta.id ?? "", docId: "" };
  }

  // 原型 id 或未知 → 原型视图
  const protoId = PROTOTYPES.some((p) => p.meta.id === raw) ? raw : (PROTOTYPES[0]?.meta.id ?? "");
  return { view: "protos", protoId, docId: "" };
}

function App() {
  const [view, setView] = useState<View>(() => parseHash(window.location.hash).view);
  const [protoId, setProtoId] = useState<string>(() => parseHash(window.location.hash).protoId);
  const [docId, setDocId] = useState<string>(() => parseHash(window.location.hash).docId);
  const [device, setDevice] = useState<DeviceType>("desktop");

  // 监听 hash 变化（含手动修改 URL），跟随切换视图
  useEffect(() => {
    const onHashChange = () => {
      const s = parseHash(window.location.hash);
      setView(s.view);
      setProtoId(s.protoId);
      setDocId(s.docId);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const activeDef = PROTOTYPES.find((p) => p.meta.id === protoId) ?? PROTOTYPES[0];

  /** 写入 hash（统一入口，避免重复触发） */
  const navigate = (hash: string) => {
    if (window.location.hash !== `#${hash}`) {
      window.location.hash = hash;
    } else {
      const s = parseHash(hash);
      setView(s.view);
      setProtoId(s.protoId);
      setDocId(s.docId);
    }
  };

  const switchView = (v: View) => {
    if (v === "docs") {
      const path = docPath(docId).join("/") || DEFAULT_DOC_ID;
      navigate(`docs/${path}`);
    } else {
      navigate(protoId || activeDef?.meta.id || PROTO_HASH);
    }
  };

  const selectProto = (id: string) => {
    setProtoId(id);
    navigate(id);
  };

  const selectDoc = (id: string) => {
    setDocId(id);
    const path = docPath(id).join("/");
    navigate(`docs/${path}`);
  };

  return (
    <div className="flex h-screen flex-col bg-slate-100 font-sans text-slate-900 antialiased">
      {/* 顶栏：品牌 + 顶层双入口 */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 items-center justify-center rounded-[--radius-control] bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm">
              <svg
                viewBox="0 0 24 24"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="16" rx="2.5" />
                <path d="M7 8h10M7 12h6" />
              </svg>
            </span>
            <div>
              <h1 className="text-sm font-semibold leading-tight">Orchestra 展示中心</h1>
              <p className="text-[11px] leading-tight text-slate-400">原型 & 文档</p>
            </div>
          </div>

          {/* 顶层入口切换 */}
          <nav aria-label="主入口" className="ml-2 flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-100/70 p-0.5">
            <button
              type="button"
              onClick={() => switchView("protos")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                view === "protos" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
              原型
            </button>
            <button
              type="button"
              onClick={() => switchView("docs")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                view === "docs" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                <path d="M14 2v6h6M9 13h6M9 17h6" />
              </svg>
              文档
            </button>
          </nav>
        </div>

        {view === "protos" && <DeviceSwitcher device={device} onChange={setDevice} />}
      </header>

      {view === "docs" ? (
        /* 文档视图 */
        <DocExplorer activeDocId={docId} onSelectDoc={selectDoc} />
      ) : (
        <>
          {/* 窄屏（< md）横向原型 tab，替代侧栏 */}
          <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 md:hidden">
            {PROTOTYPES.map((p) => {
              const active = p.meta.id === protoId;
              return (
                <button
                  key={p.meta.id}
                  type="button"
                  onClick={() => selectProto(p.meta.id)}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "bg-brand-600 font-medium text-white"
                      : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {p.meta.name}
                </button>
              );
            })}
          </div>

          {/* 主区：导航 + 设备外框 */}
          <div className="flex min-h-0 flex-1">
            <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white md:block">
              <PrototypeNav defs={PROTOTYPES} activeId={protoId} onSelect={selectProto} />
            </aside>

            <main className="min-w-0 flex-1 overflow-y-auto">
              {activeDef ? (
                <DeviceFrame device={device} label={`prototype.orchestra.local/#${activeDef.meta.id}`}>
                  <activeDef.Component
                    key={`${activeDef.meta.id}-${device}`}
                    device={device}
                    deviceWidth={DEVICE_SPECS[device].width}
                  />
                </DeviceFrame>
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-400">
                  暂无已注册的原型，请在 src/prototypes/registry.ts 中注册
                </div>
              )}
            </main>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
