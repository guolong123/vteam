/**
 * DshToolIO：工具调用的「输入 / 输出」渲染
 * =============================================
 * 两件事：
 *
 * 1. **输入不能再是裸 JSON**。工具入参形如 `{"file_path":"/data/…"}`，直接抛给用户
 *    既难读又占宽；这里解析成 key → value 列表（单键时直接显示值）。
 *
 * 2. **输出要认 DSH 的读文件回执**。DSH 的 `read` 对有内容的文件返回
 *    `<path>…</path><type>image</type><content>image/png image, 1440x900 px, …</content>`
 *    （**只有描述，没有字节**）。其中 `type=image` 时说明读的是一张图 ——
 *    这里渲染成缩略图，点击打开灯箱看原图（字节经
 *    `GET /api/v1/workers/file?path=` 从 worker 工作区取）。
 *    非图片则把 `<content>` 里的正文解包出来，按代码块显示（不再带 XML 外壳）。
 *
 * 为什么单独成文件：`dsh-tool-card.tsx` 只管「折叠行 + 展开壳」，
 * 解析与渲染细节放这里，两者都保持可读。
 *
 * @module components/chat/dsh/dsh-tool-io
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { CodeBlock, ImageLightbox } from "@deepseek-ai/dsh-client-ui-primitives";
import { getAuthToken } from "@/lib/api";
import { DSH_COMMON_ZH } from "./dsh-labels";

/** 输入解析结果：对象 → 键值对；非对象 → 原样单值。 */
export interface ToolInputEntry {
  key: string | null;
  value: string;
}

/**
 * 把工具入参归一成可读条目。
 *
 * - JSON 对象 → 每个键一条（单键时 `key` 保留，由调用方决定是否省略标签）；
 * - JSON 数组 / 其他 → 一条 `key=null` 的值；
 * - 解析失败（本来就是纯文本，如 bash 的命令串）→ 一条值，原样显示。
 */
export function parseToolInput(input: string): ToolInputEntry[] {
  const raw = input.trim();
  if (raw.length === 0) return [];
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed as Record<string, unknown>)
          // 明显无信息量的字段不进 UI（DSH 的 description 是给模型看的冗余说明）
          .filter(([k, v]) => !(k === "description" && typeof v === "string"))
          .map(([key, value]) => ({
            key,
            value: typeof value === "string" ? value : JSON.stringify(value),
          }));
        if (entries.length > 0) return entries;
      }
    } catch {
      // 落到下面的原样分支
    }
  }
  return [{ key: null, value: raw }];
}

/** 工具输出渲染视图。 */
export type ToolOutputView =
  | { kind: "text"; text: string }
  | { kind: "image"; path: string; meta: string };

/** DSH 读文件回执的 `<path>…</path>`。 */
const PATH_RE = /<path>\s*([\s\S]*?)\s*<\/path>/i;
/** DSH 读文件回执的 `<type>…</type>`。 */
const TYPE_RE = /<type>\s*([\s\S]*?)\s*<\/type>/i;
/** DSH 读文件回执的 `<content>…</content>`。 */
const CONTENT_RE = /<content>\s*([\s\S]*?)\s*<\/content>/i;

/**
 * 解析工具输出。
 *
 * 认 DSH 的读文件回执外壳；认不出来就整段当文本（行为与改造前一致，不倒退）。
 */
export function parseToolOutput(output: string): ToolOutputView {
  const raw = output;
  const pathHit = PATH_RE.exec(raw);
  const typeHit = TYPE_RE.exec(raw);
  const contentHit = CONTENT_RE.exec(raw);
  const content = contentHit === null ? null : contentHit[1] ?? "";

  if (pathHit !== null && typeHit !== null && typeHit[1]?.toLowerCase().includes("image")) {
    return {
      kind: "image",
      path: (pathHit[1] ?? "").trim(),
      meta: (content ?? "").trim(),
    };
  }
  // 非图片回执：解包 <content>，去掉 XML 外壳（否则用户看到的是一堆标签）
  if (content !== null) {
    return { kind: "text", text: content.replace(/^\n+|\n+$/g, "") };
  }
  return { kind: "text", text: raw };
}

/** 输入区样式：键名小号弱化，值等宽。 */
const keyStyle: CSSProperties = {
  flex: "none",
  minWidth: 88,
  maxWidth: 160,
  color: "var(--dsw-alias-label-tertiary)",
  fontFamily: "var(--dsw-font-family)",
  fontSize: 12,
  lineHeight: "18px",
};

const valueStyle: CSSProperties = {
  flex: "auto",
  minWidth: 0,
  fontFamily: "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)",
  fontSize: 12,
  lineHeight: "18px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  color: "var(--dsw-alias-label-secondary)",
};

/** 图片预览尺寸：缩略图不抢版面，点击才看原图。 */
const THUMB_MAX_HEIGHT = 220;

/**
 * 带鉴权地取图 → objectURL。
 *
 * 为什么不能直接把 URL 丢给 `<img src>`：本系统的鉴权是 **localStorage 里的 Bearer
 * token**（不是 cookie），而 `<img>` 标签不会带 `Authorization` 头 —— 直接给 URL
 * 会 401、缩略图空白（实测 naturalWidth=0）。
 * 故先用带头的 fetch 取 blob，再转 objectURL；卸载时 revoke 防泄漏。
 */
function useAuthedImageUrl(filePath: string): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (filePath.length === 0) {
      setObjectUrl(null);
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    const token = getAuthToken();
    fetch(`/api/v1/workers/file?path=${encodeURIComponent(filePath)}`, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => {
        if (!cancelled) setObjectUrl(null);
      });
    return () => {
      cancelled = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [filePath]);
  return objectUrl;
}

export interface DshToolIOProps {
  input: string;
  output: string;
}

/**
 * 工具调用的输入/输出区。
 *
 * 输出是图片时：缩略图 + 元信息（尺寸/大小），点击开灯箱。
 * 输出是文本时：用 `CodeBlock`（无 header）显示，拿到 DSH 的代码排版与复制能力。
 */
export function DshToolIO({ input, output }: DshToolIOProps) {
  const inputEntries = useMemo(() => parseToolInput(input), [input]);
  const outputView = useMemo(() => parseToolOutput(output), [output]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  /** 图片 objectURL：经控制面端点从 worker 工作区取字节（带 Bearer 鉴权）。 */
  const imagePath = outputView.kind === "image" ? outputView.path : "";
  const imageSrc = useAuthedImageUrl(imagePath);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {inputEntries.length > 0 ? (
        <div data-testid="dsh-tool-input">
          <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 2 }}>输入</div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              padding: "6px 10px",
              borderRadius: 8,
              background: "var(--dsw-alias-markdown-code-block)",
            }}
          >
            {inputEntries.map((entry, i) => (
              <div
                key={`${entry.key ?? "value"}-${i}`}
                style={{ display: "flex", gap: 8, minWidth: 0 }}
              >
                {entry.key !== null && inputEntries.length > 1 ? (
                  <span style={keyStyle}>{entry.key}</span>
                ) : null}
                <span style={valueStyle}>{entry.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {outputView.kind === "image" ? (
        <div data-testid="dsh-tool-output">
          <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 2 }}>
            输出{outputView.meta.length > 0 ? ` · ${outputView.meta}` : ""}
          </div>
          <button
            type="button"
            data-testid="dsh-tool-image-thumb"
            onClick={() => setLightboxOpen(true)}
            style={{
              display: "block",
              padding: 0,
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 8,
              background: "transparent",
              cursor: "zoom-in",
              overflow: "hidden",
              maxWidth: "100%",
            }}
          >
            <div style={{ maxHeight: THUMB_MAX_HEIGHT, overflow: "hidden" }}>
              {/* thumbnail 用原生 img：primitives 只导出 ImageLightbox，
                  ImagePreview 未对外导出（其内部实现同理）。 */}
              {imageSrc !== null ? (
              <img
                src={imageSrc}
                alt={outputView.path}
                onError={() => setImageFailed(true)}
                style={{
                  display: "block",
                  maxWidth: "100%",
                  maxHeight: THUMB_MAX_HEIGHT,
                  objectFit: "contain",
                  borderRadius: 8,
                }}
              />
              ) : null}
              {imageFailed ? (
                <div
                  data-testid="dsh-tool-image-failed"
                  style={{
                    padding: "12px 14px",
                    fontSize: 12,
                    color: "var(--dsw-alias-label-tertiary)",
                  }}
                >
                  图片加载失败（worker 上可能已不存在，或节点不可用）
                </div>
              ) : null}
            </div>
          </button>
          {lightboxOpen && imageSrc !== null ? (
            <ImageLightbox
              src={imageSrc}
              alt={outputView.path}
              labels={{ dialog: "图片预览", close: "关闭" }}
              onClose={() => setLightboxOpen(false)}
            />
          ) : null}
        </div>
      ) : outputView.text.length > 0 ? (
        <div data-testid="dsh-tool-output">
          <div style={{ opacity: 0.6, fontSize: 11, margin: "0 0 2px" }}>输出</div>
          <CodeBlock
            code={outputView.text.slice(0, 2000)}
            showHeader={false}
            copyLabel={DSH_COMMON_ZH.copy}
            copiedLabel={DSH_COMMON_ZH.copied}
          />
        </div>
      ) : null}
    </div>
  );
}
