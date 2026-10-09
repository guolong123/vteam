"use client";

/**
 * 团队「记忆」子 Tab（会话页右侧面板 TeamSubTabs → memories）
 * =============================================================
 * 定位：**归档治理 + 只读浏览**，不是编辑器。
 * - 两组并列：团队级（团队成员可写）与全局级（平台级记忆，仅 admin 有操作按钮）。
 *   服务端 GET /memories 已做成员感知过滤（global ∪ 自己的团队），本组件不再自行过滤。
 * - 活跃视图：团队行「禁用」= memoriesApi.archive（软删 = 归档，可恢复）+「删除」= purge（硬删）；
 *   已归档视图：团队行「恢复」= restore（已合并行置灰，服务端亦 409 MEMORY_RESTORE_MERGED）
 *   +「永久删除」= purge。
 * - 不做内容/tags 编辑、不做合并操作 UI（编辑与合并归管理页 / Agent 工具）。
 * - 点卡片内容区弹出详情（TeamMemoryDetailModal，复用 DocModalShell 外壳）：看全文 + 元信息，
 *   底部操作与卡片同一套权限门。操作行在可点击区之外，点它不会开详情。
 *
 * 视觉语言复制 system/memories 管理页（类型芯片 / 自动注入 / 相对时间）。
 * 芯片/徽标/相对时间的**共用地基**在 memoryParts.tsx（卡片与详情弹窗共用一份，
 * 避免两处各写一份漂移）；这里只做卡片骨架 + 操作行 + 数据编排。
 *
 * 刷新联动：所有 mutation 成功后失效 `["memories"]` 前缀——`memoriesQueryKey(params)`
 * 是其下的精确子键，前缀失效连带刷新本 tab 的两组查询与 /system/memories 管理页。
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
import { isPlatformAdmin } from "@/lib/permissions";
import { useAuthStore } from "@/lib/stores/authStore";
import {
  memoriesApi,
  memoriesQueryKey,
  type MaintainResult,
  type MemoriesListParams,
  type MemoryItem,
} from "@/src/api/memories";
import {
  ConfirmDialog,
  EmptyState,
  SegmentedTabs,
} from "@/src/components/ui";
import { TeamMemoryDetailModal } from "@/src/components/teams/TeamMemoryDetailModal";
import {
  absoluteTime,
  AutoInjectBadge,
  formatRelativeTime,
  MergedMarker,
  RefCountBadge,
  TopicChips,
  TypeChips,
} from "@/src/components/teams/memoryParts";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  statusColors,
  surface,
} from "@/src/theme/tokens";

/** 单页条数（显式传，避免服务端改默认时本 tab 行为漂移）。 */
const PAGE_SIZE = 20;

/* ------------------------------ 局部样式常量 ------------------------------ */

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

/** 整理结果提示条：与 errorBannerStyle 同骨架，仅语义色换「已完成」绿 token。 */
const noticeBannerStyle: CSSProperties = {
  ...errorBannerStyle,
  color: statusColors["已完成"].color,
  backgroundColor: statusColors["已完成"].bg,
  border: `1px solid ${statusColors["已完成"].border}`,
};

/** 提示条内的「知道了」按钮（复用 actionButtonStyle 视觉，仅更紧凑）。 */
const dismissButtonStyle: CSSProperties = {
  ...actionButtonStyle,
  padding: `1px ${space.sm}px`,
};

/**
 * 把 POST /memories/maintain 的返回体拼成一句人话。
 * 注意 `teams` 语义 = 本轮**真正派发**的团队数（无候选 / 无主 Agent 的团队不计入），
 * 因此「teams>0 但候选全 0」是异常组合——文案需区分「跳过派发」与「已派发 + 有候选」。
 */
function maintainNoticeText(r: MaintainResult): string {
  const { duplicates, unused, untags } = r.candidates;
  if (r.teams <= 0) {
    return "无待整理候选，本轮跳过派发（没有团队筛出可整理的记忆）。";
  }
  if (duplicates + unused + untags === 0) {
    return `已派发整理：${r.teams} 个团队 · 无待整理候选`;
  }
  return (
    `已派发整理：${r.teams} 个团队 · 疑似重复 ${duplicates}` +
    ` · 低频未引用 ${unused} · 标签不规范 ${untags}`
  );
}

/* ------------------------------ 记忆行 ------------------------------ */

interface MemoryRowProps {
  memory: MemoryItem;
  /** 已归档视图（决定展示「恢复/永久删除」还是「禁用/删除」）。 */
  archived: boolean;
  /** 是否允许操作：团队行恒 true，全局行仅 admin（服务端仍会 per-row 复核）。 */
  canOperate: boolean;
  /** 该行有 mutation 在途。 */
  pending: boolean;
  /** 点击卡片打开详情弹窗。 */
  onOpenDetail: (memory: MemoryItem) => void;
  onArchive: (memory: MemoryItem) => void;
  onRestore: (memory: MemoryItem) => void;
  onRequestPurge: (memory: MemoryItem) => void;
}

/** 单条记忆卡片：芯片行 + 摘要 + 正文预览 + 时间 + 操作行（整卡点击看详情）。 */
function MemoryRow({
  memory,
  archived,
  canOperate,
  pending,
  onOpenDetail,
  onArchive,
  onRestore,
  onRequestPurge,
}: MemoryRowProps) {
  const title = memory.description?.trim() || "";
  const createdAtFull = absoluteTime(memory.createdAt);
  const lastUsed = memory.lastUsedAt
    ? `最近命中：${absoluteTime(memory.lastUsedAt)}`
    : null;
  // 已合并行不可恢复（refCount 已转移给目标行，再恢复会二次计数）；
  // 「永久删除」保留，作为清理误合并的出口。
  const merged = !!memory.mergedIntoId;

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
        transition: "border-color .15s ease, background-color .15s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "rgba(13,148,136,0.34)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = neutral[200];
      }}
    >
      {/* 内容区可点击打开详情；操作行在其外层，互不干扰（对齐管理页 memory-card-open 结构） */}
      <div
        data-testid="team-memory-open"
        role="button"
        tabIndex={0}
        aria-label={`查看记忆详情：${title || memory.content.slice(0, 40)}`}
        title="点击查看详情"
        onClick={() => onOpenDetail(memory)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenDetail(memory);
          }
        }}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: space.sm,
          cursor: "pointer",
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
      </div>

      {canOperate && (
        <div
          onClick={(e) => e.stopPropagation()}
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
                disabled={pending || merged}
                title={
                  merged
                    ? "该记忆已合并到其他记忆，无法恢复；如需使用请查看目标记忆"
                    : "恢复这条记忆，使其重新生效"
                }
                onClick={() => onRestore(memory)}
                style={
                  pending || merged
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
  onOpenDetail: (memory: MemoryItem) => void;
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
  onOpenDetail,
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
            onOpenDetail={onOpenDetail}
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
 * - 全局级记忆（平台级记忆）：仅 admin 显示操作按钮（口径 = isPlatformAdmin）。
 */
export function TeamMemoriesTab({ teamId, teamName }: TeamMemoriesTabProps) {
  const queryClient = useQueryClient();
  // 全局记忆的写操作门：与服务端 admin-permission.hasAdminPermission / AdminGuard
  // 同口径（permissions.all===true || permissions.users.manage===true），复用
  // lib/permissions 的共享谓词，不按 roleName 字符串另立一套。
  const isAdmin = isPlatformAdmin(useAuthStore((s) => s.user?.permissions));

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
  /** 详情弹窗选中的行 id（null = 关闭）。存 id 而非对象：失效刷新后内容自动跟最新数据。 */
  const [detailId, setDetailId] = useState<string | null>(null);
  /**
   * 整理结果提示（null = 不展示）。同时承载成功文案与失败文案，
   * 单槽位互斥：新一轮运行直接覆盖上一轮结果。
   */
  const [maintainNotice, setMaintainNotice] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  /* ---------- 搜索防抖 300ms（抄管理页 :1036-1042） ---------- */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  /* ---------- 筛选 / 搜索变化：两组各自回第一页，并关掉详情 ---------- */
  useEffect(() => {
    setTeamPage(1);
    setGlobalPage(1);
    setDetailId(null);
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

  /* ---------- 失效：["memories"] 前缀（覆盖本 tab 两组查询 + 管理页） ---------- */
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

  /* ---------- 手动跑一轮整理（AdminGuard：按钮仅 isAdmin 可见） ----------
   * 本轮服务端只筛候选 + 落灰色 system 条 + 派 prompt，**不改记忆内容**，
   * 故不失效 ["memories"]（避免无谓重拉）；仅回填提示文案。 */
  const maintainMutation = useMutation({
    mutationFn: () => memoriesApi.maintain(),
    onMutate: () => setMaintainNotice(null),
    onSuccess: (result) =>
      setMaintainNotice({ tone: "success", text: maintainNoticeText(result) }),
    onError: (err) =>
      setMaintainNotice({
        tone: "error",
        text: isApiError(err) ? err.message : "整理失败，请稍后重试",
      }),
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

  /* ---------- 详情目标：始终从列表数据里取，行被归档/删除后自然消失 ---------- */
  const detailMemory = useMemo(() => {
    if (!detailId) return null;
    return (
      teamItems.find((m) => m.id === detailId) ??
      globalItems.find((m) => m.id === detailId) ??
      null
    );
  }, [detailId, teamItems, globalItems]);

  /* ---------- 选中行从列表消失（如刚被归档/删除）→ 关闭详情 ---------- */
  useEffect(() => {
    if (!detailId) return;
    // 首次加载完成前不清（此时列表还空，误关）
    if (teamQuery.isLoading || globalQuery.isLoading) return;
    if (!detailMemory) setDetailId(null);
  }, [detailId, detailMemory, teamQuery.isLoading, globalQuery.isLoading]);

  const detailCanOperate = detailMemory
    ? detailMemory.level === "team"
      ? true
      : isAdmin
    : false;

  const closeDetail = useCallback(() => setDetailId(null), []);

  const archiveFromDetail = useCallback(
    (m: MemoryItem) => archiveMutation.mutate(m.id),
    [archiveMutation]
  );
  const restoreFromDetail = useCallback(
    (m: MemoryItem) => restoreMutation.mutate(m.id),
    [restoreMutation]
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
        {isAdmin && (
          <button
            type="button"
            data-testid="team-memory-maintain"
            disabled={maintainMutation.isPending}
            title="手动跑一轮记忆整理：筛出疑似重复 / 低频未引用 / 标签不规范的候选，派给各团队主 Agent 复核处理"
            onClick={() => maintainMutation.mutate()}
            style={
              maintainMutation.isPending
                ? { ...actionButtonStyle, ...disabledActionStyle }
                : actionButtonStyle
            }
          >
            {maintainMutation.isPending ? "正在整理…" : "整理记忆"}
          </button>
        )}
      </div>

      {maintainNotice && (
        <div
          role="status"
          data-testid="team-memory-maintain-notice"
          style={
            maintainNotice.tone === "error"
              ? errorBannerStyle
              : noticeBannerStyle
          }
        >
          <span aria-hidden style={{ fontWeight: 700 }}>
            {maintainNotice.tone === "error" ? "!" : "✓"}
          </span>
          <span style={{ flex: 1 }}>{maintainNotice.text}</span>
          <button
            type="button"
            onClick={() => setMaintainNotice(null)}
            style={dismissButtonStyle}
          >
            知道了
          </button>
        </div>
      )}

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
        onOpenDetail={(m) => setDetailId(m.id)}
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
        onOpenDetail={(m) => setDetailId(m.id)}
        onArchive={(m) => archiveMutation.mutate(m.id)}
        onRestore={(m) => restoreMutation.mutate(m.id)}
        onRequestPurge={setPurgeTarget}
      />

      {/* ---------- 记忆详情弹窗（点卡片打开；永久删除时先关详情再弹确认） ---------- */}
      <TeamMemoryDetailModal
        memory={detailMemory}
        archived={archived}
        canOperate={detailCanOperate}
        pending={!!detailMemory && pendingId === detailMemory.id}
        onArchive={archiveFromDetail}
        onRestore={restoreFromDetail}
        onRequestPurge={(m) => {
          closeDetail();
          setPurgeTarget(m);
        }}
        onClose={closeDetail}
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