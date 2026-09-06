"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";
import type { TaskDetail } from "@/src/components/tasks/task-detail-types";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ================================ 任务信息编辑弹窗（is_0000000011：描述/标题/背景文档） ================================ */

/** POST /uploads 响应（server FileStorageService.describe：{url, name, size, ext}）。 */
interface UploadedFileMeta {
  url: string;
  name: string;
  size: number;
  ext: string;
}

/** 背景文档条目（TaskDetail.backgroundDocs 元素 + 新增上传）。 */
interface BackgroundDocItem {
  name: string;
  url: string;
}

/** 解析 task.backgroundDocs（unknown[] → {name, url}[]，非法元素忽略）。 */
function parseBackgroundDocs(docs: unknown[]): BackgroundDocItem[] {
  if (!Array.isArray(docs)) return [];
  return docs.flatMap((d) => {
    if (typeof d !== "object" || d === null) return [];
    const { name, url } = d as { name?: unknown; url?: unknown };
    return typeof name === "string" && typeof url === "string" && name && url
      ? [{ name, url }]
      : [];
  });
}

export function TaskInfoEditModal({
  task,
  open,
  onClose,
  onSaved,
}: {
  task: TaskDetail;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [docs, setDocs] = useState<BackgroundDocItem[]>(() =>
    parseBackgroundDocs(task.backgroundDocs),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 打开时重置为最新任务数据
  useEffect(() => {
    if (!open) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
    setDocs(parseBackgroundDocs(task.backgroundDocs));
    setFormError(null);
    setUploadError(null);
  }, [open, task]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // 上传：POST /uploads multipart（file 字段）→ {url,name,size,ext} → 加入 docs
  const uploadMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.post<UploadedFileMeta>("/uploads", fd);
    },
    onSuccess: (meta) => {
      setDocs((prev) => [...prev, { name: meta.name, url: meta.url }]);
      setUploadError(null);
    },
    onError: (err) =>
      setUploadError(isApiError(err) ? err.message : "文档上传失败，请稍后重试"),
  });

  // 保存：PATCH /tasks/:id {title, description, backgroundDocs}
  const saveMutation = useMutation({
    mutationFn: (payload: { title: string; description: string; backgroundDocs: BackgroundDocItem[] }) =>
      api.patch<TaskDetail>(`/tasks/${task.id}`, payload),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => {
      setFormError(isApiError(err) ? err.message : "保存失败，请稍后重试");
    },
  });

  if (!open) return null;

  const handleSave = () => {
    if (saveMutation.isPending) return;
    if (!title.trim()) {
      setFormError("请填写任务标题");
      return;
    }
    setFormError(null);
    saveMutation.mutate({
      title: title.trim(),
      description: description.trim(),
      backgroundDocs: docs,
    });
  };

  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "var(--color-surface)",
    fontSize: fontSize.md,
    color: neutral[800],
    outline: "none",
    fontFamily: fontFamily.body,
  };

  return (
    <div
      data-testid="task-edit-overlay"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8%",
        ...baseFont,
      }}
    >
      {/* 轻遮罩：点击关闭 */}
      <div
        aria-hidden
        data-testid="task-edit-mask"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />

      <div
        data-testid="task-edit-modal"
        style={{
          position: "relative",
          width: 560,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "calc(100% - 16%)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
        }}
      >
        <div>
          <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
            编辑任务信息
          </div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
            修改任务标题 / 描述 / 背景文档，保存后任务详情即时刷新
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>
            任务标题 <span style={{ color: "#DC2626" }}>*</span>
          </span>
          <input
            data-testid="task-edit-title-input"
            value={title}
            maxLength={128}
            onChange={(e) => setTitle(e.target.value)}
            style={inputBase}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>任务描述</span>
          <textarea
            data-testid="task-edit-description-input"
            value={description}
            rows={5}
            onChange={(e) => setDescription(e.target.value)}
            style={{ ...inputBase, resize: "vertical", lineHeight: 1.6 }}
          />
        </label>

        {/* 背景文档：已有列表 + 上传 */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>背景文档</span>

          {docs.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
              {docs.map((doc) => (
                <div
                  key={doc.url}
                  data-testid="task-edit-doc-item"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    padding: `${space.xs}px ${space.md}px`,
                    borderRadius: radius.md,
                    backgroundColor: neutral[50],
                    border: `1px solid ${neutral[200]}`,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      backgroundColor: "#2563EB",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: fontSize.md,
                      color: neutral[700],
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {doc.name}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    data-testid="task-edit-doc-remove"
                    aria-label={`移除 ${doc.name}`}
                    onClick={() => setDocs((prev) => prev.filter((d) => d.url !== doc.url))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setDocs((prev) => prev.filter((d) => d.url !== doc.url));
                      }
                    }}
                    style={{
                      fontSize: fontSize.sm,
                      color: neutral[400],
                      cursor: "pointer",
                      padding: space.xs,
                      flexShrink: 0,
                    }}
                  >
                    ✕
                  </span>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            data-testid="task-edit-upload-btn"
            aria-label="上传背景文档"
            disabled={uploadMutation.isPending}
            onClick={() => fileInputRef.current?.click()}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: space.xs,
              padding: `${space.md}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1.5px dashed ${neutral[300]}`,
              backgroundColor: neutral[50],
              color: neutral[500],
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: uploadMutation.isPending ? "default" : "pointer",
              opacity: uploadMutation.isPending ? 0.7 : 1,
              fontFamily: fontFamily.body,
            }}
          >
            <span aria-hidden style={{ color: "#2563EB" }}>↑</span>
            {uploadMutation.isPending ? "上传中…" : "上传背景文档"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            data-testid="task-edit-file-input"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.gif,.md,.txt"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setUploadError(null);
                uploadMutation.mutate(file);
              }
              e.target.value = "";
            }}
            style={{ display: "none" }}
          />
          {uploadError && (
            <div role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626", fontWeight: 500 }}>
              {uploadError}
            </div>
          )}
        </div>

        {(formError || saveMutation.isError) && (
          <div role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626", fontWeight: 500 }}>
            {formError ?? (isApiError(saveMutation.error) ? saveMutation.error.message : "保存失败")}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm }}>
          <button
            type="button"
            data-testid="task-edit-cancel"
            onClick={onClose}
            disabled={saveMutation.isPending}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[600],
              fontSize: fontSize.md,
              cursor: saveMutation.isPending ? "default" : "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="task-edit-save"
            onClick={handleSave}
            disabled={saveMutation.isPending}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: "none",
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: saveMutation.isPending ? "default" : "pointer",
              opacity: saveMutation.isPending ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {saveMutation.isPending ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

