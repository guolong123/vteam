"use client";

/**
 * 记忆管理页（Todo 6：mem-web）
 * =============================================
 * - 级别筛选 tab（全部 / 任务 / 项目 / 全局）+ keyword 搜索（防抖 300ms）+ 分页列表 + 删除
 * - 数据源：GET /api/v1/memories（level / keyword / page / pageSize 过滤，AdminGuard）
 * - 对齐 agents/models 页面 TanStack Query + api 封装模式
 * - 铁律（T15）：无 fixed / 100vh / 100vw；root flex:1 铺满（AppShell 提供导航）
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { ConfirmDialog } from "@/src/components/ui";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ API 数据模型 ------------------------------ */

/** GET /memories 条目（对齐 MemoriesService.findAll 返回）。 */
interface MemoryItem {
  id: string;
  level: "task" | "project" | "global";
  content: string;
  description?: string | null;
  tags: string[] | null;
  createdBy: string;
  createdAt: string;
}

/** GET /memories 分页响应。 */
interface MemoriesResponse {
  items: MemoryItem[];
  total: number;
  page: number;
  pageSize: number;
}

/* ------------------------------ 级别筛选 Tab ------------------------------ */

type LevelFilter = "" | "task" | "project" | "global";

const LEVEL_TABS: { key: LevelFilter; label: string; icon: string }[] = [
  { key: "", label: "全部", icon: "◈" },
  { key: "task", label: "任务", icon: "◧" },
  { key: "project", label: "项目", icon: "◨" },
  { key: "global", label: "全局", icon: "◎" },
];

/** 级别 → 徽章配色（对齐 tokens 语义色系）。 */
const LEVEL_META: Record<
  MemoryItem["level"],
  { label: string; color: string; bg: string; border: string }
> = {
  task: { label: "任务", color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)" },
  project: { label: "项目", color: "#7C3AED", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" },
  global: { label: "全局", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
};

/* ------------------------------ 行 hover CSS ------------------------------ */

const rowCss = `
.mem-row { transition: border-color .15s ease, background-color .15s ease; }
.mem-row:hover { background-color: var(--color-neutral-50); }
`;

/* ================================ 页面组件 ================================ */

export default function MemoriesPage() {
  const queryClient = useQueryClient();

  /* ---------- 状态 ---------- */
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("");
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  /* ---------- 防抖 ---------- */
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedKeyword(keyword);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  /* ---------- 筛选切换重置页码 ---------- */
  useEffect(() => {
    setPage(1);
    setExpandedIds(new Set());
  }, [levelFilter]);

  useEffect(() => {
    setExpandedIds(new Set());
  }, [debouncedKeyword, page]);

  /* ---------- 数据查询 ---------- */
  const memoriesQuery = useQuery<MemoriesResponse>({
    queryKey: ["memories", { level: levelFilter || undefined, keyword: debouncedKeyword, page, pageSize }],
    queryFn: () =>
      api.get<MemoriesResponse>("/memories", {
        query: {
          ...(levelFilter ? { level: levelFilter } : {}),
          ...(debouncedKeyword ? { keyword: debouncedKeyword } : {}),
          page,
          pageSize,
        },
      }),
  });

  /* ---------- 展开/收起 ---------- */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* ---------- 删除 ---------- */
  const [deleteTarget, setDeleteTarget] = useState<MemoryItem | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/memories/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      setDeleteTarget(null);
    },
  });

  /* ---------- 分页 ---------- */
  const totalPages = useMemo(() => {
    const total = memoriesQuery.data?.total ?? 0;
    return Math.max(1, Math.ceil(total / pageSize));
  }, [memoriesQuery.data?.total, pageSize]);

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage >= 1 && newPage <= totalPages) setPage(newPage);
    },
    [totalPages]
  );

  /* ---------- 计算 ---------- */
  const items = memoriesQuery.data?.items ?? [];
  const total = memoriesQuery.data?.total ?? 0;

  return (
    <div
      data-testid="memories-page"
      style={{
        flex: 1,
        padding: `${space.xl}px ${space.xxl}px`,
        ...baseFont,
      }}
    >
      <style>{rowCss}</style>

      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
        }}
      >
        {/* ① 工具条：级别 Tab + 搜索框 */}
        <div
          data-testid="manage-toolbar"
          style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}
        >
          {/* 级别 Tab（对齐 models/manage-tabs/manage-tab 模式） */}
          <div
            data-testid="manage-tabs"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.xs,
              padding: space.xs,
              borderRadius: radius.lg,
              backgroundColor: neutral[100],
              border: `1px solid ${neutral[200]}`,
            }}
          >
            {LEVEL_TABS.map((t) => {
              const active = levelFilter === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  data-testid="manage-tab"
                  data-kind={t.key || "all"}
                  data-active={active ? "true" : "false"}
                  onClick={() => setLevelFilter(t.key)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    padding: `${space.sm + 1}px ${space.lg}px`,
                    borderRadius: radius.md,
                    border: "none",
                    backgroundColor: active ? "var(--color-surface)" : "transparent",
                    boxShadow: active ? shadow.sm : "none",
                    cursor: "pointer",
                    fontFamily: fontFamily.body,
                    fontSize: fontSize.md,
                    fontWeight: active ? 600 : 500,
                    color: active ? neutral[900] : neutral[600],
                  }}
                >
                  <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>
                    {t.icon}
                  </span>
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* 搜索框（防抖 300ms） */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              flex: 1,
              minWidth: 220,
              maxWidth: 320,
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.sm,
              marginLeft: "auto",
            }}
          >
            <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400], lineHeight: 1 }}>
              ⌕
            </span>
            <input
              data-testid="memory-search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索记忆内容…"
              aria-label="搜索记忆"
              style={{
                flex: 1,
                minWidth: 0,
                border: "none",
                outline: "none",
                background: "transparent",
                fontSize: fontSize.md,
                color: neutral[800],
                fontFamily: fontFamily.body,
              }}
            />
          </div>
        </div>

        {/* ② 列表区域 */}
        {memoriesQuery.isPending ? (
          <div
            data-testid="memories-loading"
            style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xxl}px 0`, textAlign: "center" }}
          >
            加载中…
          </div>
        ) : memoriesQuery.isError ? (
          <div
            data-testid="memories-error"
            role="alert"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: space.md,
              padding: `${space.xl}px`,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
              {isApiError(memoriesQuery.error) ? memoriesQuery.error.message : "加载记忆列表失败"}
            </div>
            <button
              type="button"
              data-testid="memories-retry"
              onClick={() => memoriesQuery.refetch()}
              style={{
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "var(--color-surface)",
                color: neutral[600],
                fontSize: fontSize.md,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <div
            data-testid="memories-empty"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: space.md,
              padding: `${space.xxl}px 0`,
              textAlign: "center",
            }}
          >
            <span style={{ fontSize: fontSize.xxl, color: neutral[300] }}>◈</span>
            <div style={{ fontSize: fontSize.md, color: neutral[500] }}>
              {debouncedKeyword ? "未找到匹配的记忆" : "暂无记忆数据"}
            </div>
          </div>
        ) : (
          <>
            {/* 计数 */}
            <div
              data-testid="memories-count"
              style={{ fontSize: fontSize.sm, color: neutral[400] }}
            >
              共 {total} 条记忆
            </div>

            {/* 列表 */}
            <div
              data-testid="memories-list"
              style={{ display: "flex", flexDirection: "column", gap: space.sm }}
            >
              {items.map((item) => {
                const levelMeta = LEVEL_META[item.level];
                return (
                  <div
                    key={item.id}
                    data-testid="memory-item"
                    data-memory-id={item.id}
                    data-level={item.level}
                    className="mem-row"
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: space.md,
                      padding: `${space.md}px ${space.lg}px`,
                      borderRadius: radius.lg,
                      backgroundColor: "var(--color-surface)",
                      border: `1px solid ${neutral[200]}`,
                      boxShadow: shadow.sm,
                      ...baseFont,
                    }}
                  >
                    {/* 级别徽章 */}
                    <span
                      data-testid="memory-level-badge"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: space.xs,
                        padding: `${space.xs}px ${space.sm + 2}px`,
                        borderRadius: radius.pill,
                        backgroundColor: levelMeta.bg,
                        border: `1px solid ${levelMeta.border}`,
                        color: levelMeta.color,
                        fontSize: fontSize.xs,
                        fontWeight: 500,
                        lineHeight: 1.4,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                        marginTop: 2,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          backgroundColor: levelMeta.color,
                          flexShrink: 0,
                        }}
                      />
                      {levelMeta.label}
                    </span>

                    {/* 内容区 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {(() => {
                        const expanded = expandedIds.has(item.id);
                        const preview = item.description?.trim() ? item.description!.trim() : item.content.slice(0, 120);
                        const hasFull = item.content !== preview;
                        const isExpandable = hasFull || item.content.length > 80;
                        const displayContent = expanded && hasFull ? item.content : preview;
                        return (
                          <>
                            <div
                              data-testid="memory-content"
                              role={isExpandable ? "button" : undefined}
                              tabIndex={isExpandable ? 0 : undefined}
                              aria-expanded={isExpandable ? expanded : undefined}
                              onClick={isExpandable ? () => toggleExpand(item.id) : undefined}
                              onKeyDown={
                                isExpandable
                                  ? (e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        toggleExpand(item.id);
                                      }
                                    }
                                  : undefined
                              }
                              style={{
                                fontSize: fontSize.md,
                                color: neutral[800],
                                lineHeight: 1.6,
                                wordBreak: "break-word",
                                whiteSpace: "pre-wrap",
                                cursor: isExpandable ? "pointer" : undefined,
                                ...(expanded && hasFull
                                  ? {}
                                  : {
                                      display: "-webkit-box",
                                      WebkitLineClamp: 2,
                                      WebkitBoxOrient: "vertical",
                                      overflow: "hidden",
                                    } as React.CSSProperties),
                              }}
                            >
                              {displayContent}
                            </div>
                            {isExpandable && (
                              <button
                                type="button"
                                data-testid="memory-expand-button"
                                data-memory-id={item.id}
                                data-expanded={expanded ? "true" : "false"}
                                onClick={() => toggleExpand(item.id)}
                                style={{
                                  marginTop: 4,
                                  padding: 0,
                                  border: "none",
                                  background: "transparent",
                                  color: "#2563EB",
                                  fontSize: fontSize.xs,
                                  fontWeight: 500,
                                  cursor: "pointer",
                                  fontFamily: fontFamily.body,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 2,
                                }}
                              >
                                {expanded ? "收起" : "展开"}
                                <span
                                  aria-hidden
                                  style={{
                                    display: "inline-block",
                                    fontSize: 10,
                                    lineHeight: 1,
                                    transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                                    transition: "transform .15s ease",
                                  }}
                                >
                                  ▾
                                </span>
                              </button>
                            )}
                          </>
                        );
                      })()}

                      {/* 底部：tags + createdBy + createdAt */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: space.sm,
                          marginTop: space.sm,
                          flexWrap: "wrap",
                        }}
                      >
                        {/* tags */}
                        {item.tags && item.tags.length > 0 && (
                          <div style={{ display: "flex", gap: space.xs, flexWrap: "wrap" }}>
                            {item.tags.map((tag) => (
                              <span
                                key={tag}
                                style={{
                                  fontSize: fontSize.xs,
                                  color: neutral[500],
                                  backgroundColor: neutral[100],
                                  padding: "1px 6px",
                                  borderRadius: radius.pill,
                                }}
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* createdBy */}
                        <span
                          data-testid="memory-created-by"
                          style={{ fontSize: fontSize.xs, color: neutral[400] }}
                        >
                          {item.createdBy}
                        </span>

                        {/* createdAt */}
                        <span
                          data-testid="memory-created-at"
                          style={{ fontSize: fontSize.xs, color: neutral[400] }}
                        >
                          {new Date(item.createdAt).toLocaleString("zh-CN")}
                        </span>
                      </div>
                    </div>

                    {/* 删除按钮 */}
                    <button
                      type="button"
                      data-testid="memory-delete-button"
                      data-memory-id={item.id}
                      onClick={() => setDeleteTarget(item)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 28,
                        height: 28,
                        flexShrink: 0,
                        borderRadius: radius.sm,
                        border: `1px solid ${neutral[200]}`,
                        backgroundColor: "var(--color-surface)",
                        color: neutral[400],
                        fontSize: fontSize.sm,
                        lineHeight: 1,
                        cursor: "pointer",
                        fontFamily: fontFamily.body,
                        marginTop: 2,
                        transition: "color .15s ease, border-color .15s ease",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "#DC2626";
                        e.currentTarget.style.borderColor = "rgba(239,68,68,0.22)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = neutral[400];
                        e.currentTarget.style.borderColor = neutral[200];
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>

            {/* 分页 */}
            {totalPages > 1 && (
              <div
                data-testid="memories-pagination"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: space.sm,
                  marginTop: space.md,
                }}
              >
                <button
                  type="button"
                  data-testid="page-prev"
                  disabled={page <= 1}
                  onClick={() => handlePageChange(page - 1)}
                  style={{
                    padding: `${space.sm}px ${space.md}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "var(--color-surface)",
                    color: page <= 1 ? neutral[300] : neutral[600],
                    fontSize: fontSize.sm,
                    cursor: page <= 1 ? "default" : "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  上一页
                </button>
                <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  data-testid="page-next"
                  disabled={page >= totalPages}
                  onClick={() => handlePageChange(page + 1)}
                  style={{
                    padding: `${space.sm}px ${space.md}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "var(--color-surface)",
                    color: page >= totalPages ? neutral[300] : neutral[600],
                    fontSize: fontSize.sm,
                    cursor: page >= totalPages ? "default" : "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  下一页
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        open={!!deleteTarget}
        testid="confirm-delete-memory"
        title="删除记忆"
        description={`确定要删除这条${deleteTarget ? LEVEL_META[deleteTarget.level].label : ""}级记忆吗？此操作不可恢复。`}
        confirmLabel="确认删除"
        pendingLabel="删除中…"
        danger
        submitting={deleteMutation.isPending}
        onClose={() => {
          setDeleteTarget(null);
          deleteMutation.reset();
        }}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />

      {/* 删除失败提示（内联，对齐 agents 页错误显示模式） */}
      {deleteMutation.isError && (
        <div
          data-testid="memory-delete-error"
          role="alert"
          style={{
            fontSize: fontSize.sm,
            color: "#DC2626",
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: "rgba(239,68,68,0.10)",
            border: `1px solid rgba(239,68,68,0.22)`,
          }}
        >
          <span aria-hidden style={{ fontWeight: 700 }}>!</span>
          {isApiError(deleteMutation.error)
            ? deleteMutation.error.message
            : "删除失败，请重试"}
        </div>
      )}
    </div>
  );
}
