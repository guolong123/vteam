"use client";

/**
 * 团队「记忆」子 Tab（会话页右侧面板 TeamSubTabs → memories）
 * =============================================================
 * 定位：**归档治理 + 只读浏览**，不是编辑器。
 * - 两组并列：团队级（团队成员可写）与全局级（平台级记忆，仅 admin 有操作按钮）。
 *   服务端 GET /memories 已做成员感知过滤（global ∪ 自己的团队），本组件不再自行过滤。
 * - 活跃视图：团队行「禁用」= memoriesApi.archive（软删 = 归档，可恢复）+「删除」= purge（硬删）；
 *   已归档视图：团队行「恢复」= restore +「永久删除」= purge。
 * - 不做内容/tags 编辑、不做合并操作 UI（编辑与合并归管理页 / Agent 工具）。
 *
 * 视觉语言复制 system/memories 管理页（类型芯片 / 自动注入 / 相对时间），
 * 但**在本文件内局部实现**——管理页那些组件是页面私有函数，跨文件 import 会把整页耦合进面板。
 *
 * 刷新联动：所有 mutation 成功后同时失效 `memoriesQueryKey(params)` 与 `["memories"]`
 * 前缀 —— 前者精确刷新本 tab 的两组查询，后者连带刷新 /system/memories 管理页。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import {
  memoriesApi,
  memoriesQueryKey,
  type MemoriesListParams,
  type MemoryItem,
} from "@/src/api/memories";
import {
  ConfirmDialog,
  EmptyState,
  SegmentedTabs,
} from "@/src/components/ui";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  surface,
} from "@/src/theme/tokens";

/** 单页条数（显式传，避免服务端改默认时本 tab 行为漂移）。 */
const PAGE_SIZE = 20;

/** 主题标签最多渲染个数，超出折叠为 +N。 */
const MAX_TOPIC_TAGS = 6;

/** 品牌青：自动注入开启态 / 引用计数强调色（与管理页同源）。 */
const INJECT_ON = "#0D9488";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/* ------------------------------ 纯函数工具 ------------------------------ */

/** 平台记忆分类法的三个类型标签 → 实心着色；其余主题词 → 中性描边芯片。 */
const TYPE_TAGS = ["howto", "pitfall", "constraint"] as const;
type MemoryTypeTag = (typeof TYPE_TAGS)[number];

const TYPE_META: Record<
  MemoryTypeTag,
  { label: string; color: string; bg: string; border: string }
> = {
  howto: {
    label: "做法",
    color: "#0284C7",
    bg: "rgba(2,132,199,0.10)",
    border: "rgba(2,132,199,0.24)",
  },
  pitfall: {
    label: "坑",
    color: "#B45309",
    bg: "rgba(217,119,6,0.12)",
    border: "rgba(217,119,6,0.26)",
  },
  constraint: {
    label: "约束",
    color: "#BE123C",
    bg: "rgba(225,29,72,0.10)",
    border: "rgba(225,29,72,0.24)",
  },
};

const TYPE_TAG_SET: ReadonlySet<string> = new Set<string>(TYPE_TAGS);

/** 拆分 tags：类型标签（实心）与主题词（中性描边）；非法元素跳过而非崩溃。 */
function splitTags(tags: string[] | null | undefined): {
  types: MemoryTypeTag[];
  topics: string[];
} {
  const types: MemoryTypeTag[] = [];
  const topics: string[] = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = typeof raw === "string" ? raw.trim() : "";
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (TYPE_TAG_SET.has(key)) {
      const type = key as MemoryTypeTag;
      if (!types.includes(type)) types.push(type);
    } else if (!topics.includes(tag)) {
      topics.push(tag);
    }
  }
  return { types, topics };
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前（7 天内）/ M月D日。 */
function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "时间未知";
  const diff = now - ts;
  if (diff < MINUTE_MS) return "刚刚";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/* ------------------------------ 局部小组件 ------------------------------ */

/** 类型芯片（实心着色）；无类型标签则整块不渲染。 */
function TypeChips({ tags }: { tags: string[] | null | undefined }) {
  const { types } = splitTags(tags);
  if (types.length === 0) return null;
  return (
    <>
      {types.map((type) => {
        const meta = TYPE_META[type];
        return (
          <span
            key={type}
            data-testid="team-memory-type-badge"
            data-type={type}
            title={type}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: `${space.xs}px ${space.sm}px`,
              borderRadius: radius.pill,
              backgroundColor: meta.bg,
              border: `1px solid ${meta.border}`,
              color: meta.color,
              fontSize: fontSize.xs,
              fontWeight: 500,
              lineHeight: 1.4,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {meta.label}
          </span>
        );
      })}
    </>
  );
}

/** 主题标签芯片（中性描边），超出折叠为 +N。 */
function TopicChips({ tags }: { tags: string[] | null | undefined }) {
  const { topics } = splitTags(tags);
  if (topics.length === 0) return null;
  const shown = topics.slice(0, MAX_TOPIC_TAGS);
  const rest = topics.length - shown.length;
  const chip: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: `1px ${space.sm}px`,
    borderRadius: radius.pill,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "transparent",
    color: neutral[500],
    fontSize: fontSize.xs,
    lineHeight: 1.5,
    whiteSpace: "nowrap",
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: space.xs }}>
      {shown.map((tag) => (
        <span key={tag} style={chip}>
          {tag}
        </span>
      ))}
      {rest > 0 && (
        <span style={chip} title={topics.slice(MAX_TOPIC_TAGS).join("、")}>
          +{rest}
        </span>
      )}
    </div>
  );
}

/** 自动注入徽标（只读形态：本 tab 不提供编辑，开关在管理页）。 */
function AutoInjectBadge({ on }: { on: boolean }) {
  return (
    <span
      data-testid="team-memory-inject-badge"
      data-auto-inject={on ? "true" : "false"}
      title={on ? "每轮自动注入给 Agent" : "仅 memory_search 按需检索"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${space.xs}px ${space.sm}px`,
        borderRadius: radius.pill,
        backgroundColor: on ? "rgba(13,148,136,0.08)" : neutral[100],
        border: `1px solid ${on ? "rgba(13,148,136,0.22)" : neutral[200]}`,
        color: on ? INJECT_ON : neutral[500],
        fontSize: fontSize.xs,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {on ? "注入中" : "仅检索"}
    </span>
  );
}

/**
 * 引用次数徽标：refCount 是记忆重要度排序的核心指标（被检索/注入命中次数）。
 * 0 次 = 尚未被用到，用中性色弱化；≥1 用品牌青强调。
 */
function RefCountBadge({
  count,
  lastUsedAt,
}: {
  count: number;
  lastUsedAt?: string | null;
}) {
  const safe = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  const hot = safe > 0;
  const lastUsedText = lastUsedAt
    ? `，最近一次 ${formatRelativeTime(lastUsedAt)}`
    : "";
  return (
    <span
      data-testid="team-memory-refcount-badge"
      data-ref-count={safe}
      title={
        hot
          ? `被检索命中 ${safe} 次${lastUsedText}`
          : "尚未被检索命中"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${space.xs}px ${space.sm}px`,
        borderRadius: radius.pill,
        backgroundColor: hot ? "rgba(13,148,136,0.08)" : neutral[100],
        border: `1px solid ${hot ? "rgba(13,148,136,0.22)" : neutral[200]}`,
        color: hot ? INJECT_ON : neutral[400],
        fontSize: fontSize.xs,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      引用 {safe}
    </span>
  );
}

/** 「已合并至 <id>」只读标记（合并由 Agent 工具执行，本 tab 不提供操作）。 */
function MergedMarker({ mergedIntoId }: { mergedIntoId: string }) {
  return (
    <span
      data-testid="team-memory-merged-marker"
      title={`该记忆已被合并进 ${mergedIntoId}，不再参与注入与检索`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${space.xs}px ${space.sm}px`,
        borderRadius: radius.pill,
        backgroundColor: neutral[100],
        border: `1px solid ${neutral[200]}`,
        color: neutral[500],
        fontSize: fontSize.xs,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      已合并至 {mergedIntoId}
    </span>
  );
}

const actionButtonStyle: CSSProperties = {
  padding: `2px ${space.sm + 2}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: surface,
  color: neutral[600],
  fontSize: fontSize.xs,
  fontFamily: fontFamily.body,
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const dangerButtonStyle: CSSProperties = {
  ...actionButtonStyle,
  color: "#DC2626",
  border: "1px solid rgba(220,38,38,0.28)",
};

const disabledActionStyle: CSSProperties = {
  opacity: 0.6,
  cursor: "default",
};

const errorBannerStyle: CSSProperties = {
  fontSize: fontSize.sm,
  color: "#DC2626",
  display: "flex",
  alignItems: "center",
  gap: space.xs,
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  backgroundColor: "rgba(239,68,68,0.10)",
  border: `1px solid rgba(239,68,68,0.22)`,
};

/* ------------------------------ 记忆行 ------------------------------ */

interface MemoryRowProps {
  memory: MemoryItem;
  /** 已归档视图（决定展示「恢复/永久删除」还是「禁用/删除」）。 */
  archived: boolean;
  /** 是否允许操作：团队行恒 true，全局行仅 admin（服务端仍会 per-row 复核）。 */
  canOperate: boolean;
  /** 该行有 mutation 在途。 */
  pending: boolean;
  onArchive: (memory: MemoryItem) => void;
  onRestore: (memory: MemoryItem) => void;
  onRequestPurge: (memory: MemoryItem) => void;
}

/** 单条记忆卡片：芯片行 + 摘要 + 正文预览 + 时间 + 操作行。 */
function MemoryRow({
  memory,
  archived,
  canOperate,
  pending,
  onArchive,
  onRestore,
  onRequestPurge,
}: MemoryRowProps) {
  const title = memory.description?.trim() || "";
  const createdAtFull = new Date(memory.createdAt).toLocaleString("zh-CN");
  const lastUsed = memory.lastUsedAt
    ? `最近命中：${new Date(memory.lastUsedAt).toLocaleString("zh-CN")}`
    : null;

  return (
    <div
      data-testid="team-memory-row"
      data-memory-id={memory.id}
      data-archived={archived ? "true" : "false"}
      style={{
        padding: `${space.md}px`,
        borderRadius: radius.md,
        backgroundColor: surface,
        border: `1px solid ${neutral[200]}`,
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: space.xs,
            minWidth: 0,
          }}
        >
          <TypeChips tags={memory.tags} />
          <AutoInjectBadge on={!!memory.autoInject} />
          <RefCountBadge
            count={memory.refCount}
            lastUsedAt={memory.lastUsedAt}
          />
        </div>
        <span
          title={lastUsed ? `${createdAtFull}\n${lastUsed}` : createdAtFull}
          style={{
            fontSize: fontSize.xs,
            color: neutral[400],
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {formatRelativeTime(memory.createdAt)}
        </span>
      </div>

      {title && (
        <div
          style={{
            fontSize: fontSize.sm,
            fontWeight: 600,
            color: neutral[700],
            lineHeight: 1.5,
          }}
        >
          {title}
        </div>
      )}

      <div
        data-testid="team-memory-content"
        style={{
          fontSize: fontSize.sm,
          color: neutral[600],
          lineHeight: 1.6,
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          whiteSpace: "pre-wrap",
        }}
      >
        {memory.content}
      </div>

      <TopicChips tags={memory.tags} />

      {memory.mergedIntoId && (
        <MergedMarker mergedIntoId={memory.mergedIntoId} />
      )}

      {canOperate && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: space.sm,
          }}
        >
          {archived ? (
            <>
              <button
                type="button"
                data-testid="team-memory-restore"
                disabled={pending}
                title="恢复这条记忆，使其重新生效"
                onClick={() => onRestore(memory)}
                style={
                  pending
                    ? { ...actionButtonStyle, ...disabledActionStyle }
                    : actionButtonStyle
                }
              >
                恢复
              </button>
              <button
                type="button"
                data-testid="team-memory-purge"
                disabled={pending}
                title="永久删除，不可恢复"
                onClick={() => onRequestPurge(memory)}
                style={
                  pending
                    ? { ...dangerButtonStyle, ...disabledActionStyle }
                    : dangerButtonStyle
                }
              >
                永久删除
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                data-testid="team-memory-archive"
                disabled={pending}
                title="禁用（归档）这条记忆，归档后可恢复"
                onClick={() => onArchive(memory)}
                style={
                  pending
                    ? { ...actionButtonStyle, ...disabledActionStyle }
                    : actionButtonStyle
                }
              >
                禁用
              </button>
              <button
                type="button"
                data-testid="team-memory-purge"
                disabled={pending}
                title="永久删除，不可恢复"
                onClick={() => onRequestPurge(memory)}
                style={
                  pending
                    ? { ...dangerButtonStyle, ...disabledActionStyle }
                    : dangerButtonStyle
                }
              >
                删除
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 分组区块 ------------------------------ */

interface MemorySectionProps {
  title: string;
  /** 标题右侧补充说明（全局组提示平台级语义）。 */
  hint?: string;
  items: MemoryItem[];
  total: number;
  page: number;
  archived: boolean;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  pendingId: string | null;
  /** 非团队行（全局行）是否可操作：仅 admin 为 true。 */
  canOperateNonTeamRows: boolean;
  onPageChange: (page: number) => void;
  onRetry: () => void;
  onArchive: (memory: MemoryItem) => void;
  onRestore: (memory: MemoryItem) => void;
  onRequestPurge: (memory: MemoryItem) => void;
}

/** 一组记忆（团队组 / 全局组）：标题 + 行列表 + 独立分页。 */
function MemorySection({
  title,
  hint,
  items,
  total,
  page,
  archived,
  isLoading,
  isFetching,
  error,
  pendingId,
  canOperateNonTeamRows,
  onPageChange,
  onRetry,
  onArchive,
  onRestore,
  onRequestPurge,
}: MemorySectionProps) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <section
      data-testid="team-memory-section"
      style={{ display: "flex", flexDirection: "column", gap: space.md }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: space.sm,
        }}
      >
        <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>
          {title}
        </div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>
          {hint ?? `共 ${total} 条`}
        </div>
      </div>

      {error ? (
        <div role="alert" style={errorBannerStyle}>
          <span aria-hidden style={{ fontWeight: 700 }}>
            !
          </span>
          <span style={{ flex: 1 }}>
            {isApiError(error) ? error.message : "加载记忆失败，请重试"}
          </span>
          <button type="button" onClick={onRetry} style={actionButtonStyle}>
            重试
          </button>
        </div>
      ) : null}

      {!error && isLoading && (
        <div
          data-testid="team-memory-loading"
          style={{ fontSize: fontSize.sm, color: neutral[400] }}
        >
          加载中…
        </div>
      )}

      {!error && !isLoading && items.length === 0 && (
        <EmptyState
          title={archived ? "暂无已归档记忆" : "暂无记忆"}
          description={
            archived
              ? "被禁用（归档）的记忆会出现在这里，可随时恢复。"
              : "记忆由 Agent 在协作过程中自动积累。"
          }
          style={{ padding: `${space.lg}px` }}
        />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
        {items.map((memory) => (
          <MemoryRow
            key={memory.id}
            memory={memory}
            archived={archived}
            canOperate={
              memory.level === "team" ? true : canOperateNonTeamRows
            }
            pending={pendingId === memory.id}
            onArchive={onArchive}
            onRestore={onRestore}
            onRequestPurge={onRequestPurge}
          />
        ))}
      </div>

      {!error && total > PAGE_SIZE && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            第 {page} / {totalPages} 页{isFetching ? " · 刷新中" : ""}
          </span>
          <div style={{ display: "flex", gap: space.sm }}>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              style={
                page <= 1
                  ? { ...actionButtonStyle, ...disabledActionStyle }
                  : actionButtonStyle
              }
            >
              上一页
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
              style={
                page >= totalPages
                  ? { ...actionButtonStyle, ...disabledActionStyle }
                  : actionButtonStyle
              }
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------ 主组件 ------------------------------ */

export interface TeamMemoriesTabProps {
  teamId: string;
  /** 团队名（仅用于提示文案；未加载到时留空不渲染）。 */
  teamName?: string | null;
}

/**
 * 团队 tab 下的「记忆」子 tab 内容。
 *
 * 权限模型（服务端为准，本组件只控按钮显隐）：
 * - 团队级记忆：团队成员可归档 / 恢复 / 永久删除；
 * - 全局级记忆（平台级记忆）：仅 admin 显示操作按钮。
 */
export function TeamMemoriesTab({ teamId, teamName }: TeamMemoriesTabProps) {
  const queryClient = useQueryClient();
  const isAdmin = useAuthStore((s) => s.user?.roleName === "admin");

  /* ---------- 状态 ---------- */
  const [archived, setArchived] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [teamPage, setTeamPage] = useState(1);
  const [globalPage, setGlobalPage] = useState(1);
  /** 在途行 id（按钮禁用反馈）。 */
  const [pendingId, setPendingId] = useState<string | null>(null);
  /** 永久删除确认目标。 */
  const [purgeTarget, setPurgeTarget] = useState<MemoryItem | null>(null);

  /* ---------- 搜索防抖 300ms（抄管理页 :1036-1042） ---------- */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  /* ---------- 筛选 / 搜索变化：两组各自回第一页 ---------- */
  useEffect(() => {
    setTeamPage(1);
    setGlobalPage(1);
  }, [archived, debouncedKeyword]);

  /* ---------- 查询参数（两组各自独立翻页） ---------- */
  const teamParams: MemoriesListParams = useMemo(
    () => ({
      level: "team",
      teamId,
      archived,
      keyword: debouncedKeyword || undefined,
      page: teamPage,
      pageSize: PAGE_SIZE,
    }),
    [teamId, archived, debouncedKeyword, teamPage],
  );
  const globalParams: MemoriesListParams = useMemo(
    () => ({
      level: "global",
      archived,
      keyword: debouncedKeyword || undefined,
      page: globalPage,
      pageSize: PAGE_SIZE,
    }),
    [archived, debouncedKeyword, globalPage],
  );

  /* ---------- 数据查询 ---------- */
  const teamQuery = useQuery({
    queryKey: memoriesQueryKey(teamParams),
    queryFn: () => memoriesApi.list(teamParams),
    enabled: !!teamId,
  });
  const globalQuery = useQuery({
    queryKey: memoriesQueryKey(globalParams),
    queryFn: () => memoriesApi.list(globalParams),
  });

  /* ---------- 失效：精确 key + ["memories"] 前缀（管理页同步刷新） ---------- */
  const invalidateMemories = useCallback(() => {
    // ["memories"] 前缀覆盖本 tab 两组查询与 /system/memories 管理页（共享 key 形状）。
    queryClient.invalidateQueries({ queryKey: ["memories"] });
  }, [queryClient]);

  /* ---------- 归档（软删 = 禁用，可恢复） ---------- */
  const archiveMutation = useMutation({
    mutationFn: (id: string) => memoriesApi.archive(id),
    onMutate: (id: string) => setPendingId(id),
    onSuccess: invalidateMemories,
    onSettled: () => setPendingId(null),
  });

  /* ---------- 恢复 ---------- */
  const restoreMutation = useMutation({
    mutationFn: (id: string) => memoriesApi.restore(id),
    onMutate: (id: string) => setPendingId(id),
    onSuccess: invalidateMemories,
    onSettled: () => setPendingId(null),
  });

  /* ---------- 永久删除（硬删，不可恢复） ---------- */
  const purgeMutation = useMutation({
    mutationFn: (id: string) => memoriesApi.purge(id),
    onMutate: (id: string) => setPendingId(id),
    onSuccess: () => {
      invalidateMemories();
      setPurgeTarget(null);
    },
    onSettled: () => setPendingId(null),
  });

  /* ---------- 错误文案（403 等由服务端 per-row 鉴权返回） ---------- */
  const mutationError =
    archiveMutation.error ?? restoreMutation.error ?? purgeMutation.error;
  const mutationErrorText = mutationError
    ? isApiError(mutationError)
      ? mutationError.message
      : "操作失败，请重试"
    : null;

  const teamItems = useMemo(() => teamQuery.data?.items ?? [], [teamQuery.data]);
  const globalItems = useMemo(
    () => globalQuery.data?.items ?? [],
    [globalQuery.data],
  );

  if (!teamId) {
    return (
      <EmptyState
        title="未选择团队"
        description="记忆按团队归属，请在会话中选择一个团队后查看其记忆。"
      />
    );
  }

  return (
    <div
      data-testid="team-memories-tab"
      /* position:relative —— ConfirmDialog 用 absolute + inset:0 定位，宿主需作 containing block */
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
      }}
    >
      {/* ---------- 工具条：活跃/已归档切换 + 关键词搜索 ---------- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: space.sm,
        }}
      >
        <SegmentedTabs
          items={[
            { key: "active", label: "活跃" },
            { key: "archived", label: "已归档" },
          ]}
          active={archived ? "archived" : "active"}
          onChange={(key) => setArchived(key === "archived")}
          testId="team-memory-tabs"
          optionTestId="team-memory-tab"
        />
        <input
          type="search"
          value={keyword}
          data-testid="team-memory-keyword"
          placeholder="搜索记忆内容…"
          onChange={(e) => setKeyword(e.target.value)}
          style={{
            flex: 1,
            minWidth: 160,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: surface,
            color: neutral[800],
            fontSize: fontSize.sm,
            fontFamily: fontFamily.body,
          }}
        />
      </div>

      {teamName && (
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>
          浏览「{teamName}」的团队记忆与平台级记忆；编辑与合并请前往记忆管理页。
        </div>
      )}

      {mutationErrorText && (
        <div role="alert" style={errorBannerStyle}>
          <span aria-hidden style={{ fontWeight: 700 }}>
            !
          </span>
          {mutationErrorText}
        </div>
      )}

      {/* ---------- 本团队组 ---------- */}
      <MemorySection
        title="本团队"
        items={teamItems}
        total={teamQuery.data?.total ?? 0}
        page={teamPage}
        archived={archived}
        isLoading={teamQuery.isLoading}
        isFetching={teamQuery.isFetching}
        error={teamQuery.error}
        pendingId={pendingId}
        canOperateNonTeamRows
        onPageChange={setTeamPage}
        onRetry={() => void teamQuery.refetch()}
        onArchive={(m) => archiveMutation.mutate(m.id)}
        onRestore={(m) => restoreMutation.mutate(m.id)}
        onRequestPurge={setPurgeTarget}
      />

      {/* ---------- 全局组（平台级记忆） ---------- */}
      <MemorySection
        title="全局"
        hint="平台级记忆，对所有团队生效"
        items={globalItems}
        total={globalQuery.data?.total ?? 0}
        page={globalPage}
        archived={archived}
        isLoading={globalQuery.isLoading}
        isFetching={globalQuery.isFetching}
        error={globalQuery.error}
        pendingId={pendingId}
        canOperateNonTeamRows={isAdmin}
        onPageChange={setGlobalPage}
        onRetry={() => void globalQuery.refetch()}
        onArchive={(m) => archiveMutation.mutate(m.id)}
        onRestore={(m) => restoreMutation.mutate(m.id)}
        onRequestPurge={setPurgeTarget}
      />

      {/* ---------- 永久删除二次确认（不可恢复） ---------- */}
      <ConfirmDialog
        open={!!purgeTarget}
        testid="confirm-purge-memory"
        title="永久删除记忆"
        description={`确定要永久删除这条${purgeTarget?.level === "global" ? "全局" : "团队"}记忆吗？永久删除后不可恢复，也不会出现在已归档列表中。`}
        confirmLabel="永久删除"
        pendingLabel="删除中…"
        danger
        submitting={purgeMutation.isPending}
        onClose={() => {
          setPurgeTarget(null);
          purgeMutation.reset();
          archiveMutation.reset();
          restoreMutation.reset();
        }}
        onConfirm={() => {
          if (purgeTarget) purgeMutation.mutate(purgeTarget.id);
        }}
      />
    </div>
  );
}

export default TeamMemoriesTab;