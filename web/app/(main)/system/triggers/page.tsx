"use client";

/**
 * /system/triggers — 触发器列表/管理页（trigger-unification Todo 16）
 * =============================================================
 * - 壳：/system 二级导航（layout.tsx + system-sidebar.tsx，pathname 自动高亮「触发器」，
 *   面包屑 `系统管理 › 触发器` 由 layout 派生，本页不渲染）。
 * - 骨架：照抄 web/app/(main)/system/memories/page.tsx（Tab + 300ms 防抖搜索 +
 *   TanStack Query + ConfirmDialog + 分页），容器换 PageWindow + Pagination +
 *   EmptyState 共享组件。
 * - 数据源：GET /api/v1/triggers（todo-22 已上线，本页只消费不实现）。
 *   item = {id,kind,status,dueAt,nextFireAt,scopeType,scopeId,ownerInstanceId,
 *   fireCount,skipReason,lastError,attempts,createdAt,source}，
 *   source 为服务端派生（system/agent），本页只读不重算。
 * - 筛选映射（filter→API）：
 *   - kind Tab：全部 → 不带 kind；定时 → kind=hook_fire；条件 → kind=hook_poll；
 *     事件 → 预留类型（本版本无事件触发器，后端无对应 kind 可查，传任意 kind 会 400，
 *     故该 Tab 不发请求，直接渲染 EmptyState，不报错）。
 *   - source 筛选：后端无 source 查询参数，故 source=system/agent 时取回全量
 *     （page=1&pageSize=100）后按服务端 source 字段客户端过滤 + 客户端分页；
 *     source=全部 时走服务端分页（page/pageSize=20）。
 *   - 搜索框：后端无 keyword 参数，输入关键字时同样取回全量后按
 *     id/kind/scopeType/scopeId/ownerInstanceId/skipReason/lastError 客户端过滤。
 * - 成员 team-scope 403：成员无 teamId 查列表 → 403 TRIGGER_TEAM_SCOPE_REQUIRED。
 *   非 admin 且未选团队时不发请求，渲染团队范围选择器（GET /teams 取候选）；
 *   选定后查询带 teamId。残留 403 仍兜底为可读提示 + 重试，不渲染 raw error。
 * - 取消：DELETE /triggers/:id（ConfirmDialog 二次确认）。非 admin 的 system-source
 *   行不渲染取消按钮（UI 隐藏仅为体验，服务端同样 403 SYSTEM_READONLY 强制执行，
 *   服务端错误码/文案经 isApiError 原样展示，不吞错）。
 * - 实时：useRealtimeEvents（receipt.acked/expired、round.complete/stale →
 *   invalidate ["triggers"]）+ 15s refetchInterval 兜底。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；PageWindow flex 容器。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { useRealtimeEvents } from "@/hooks/use-realtime";
import { teamsApi, type TeamDto } from "@/src/api/teams";
import {
  ConfirmDialog,
  EmptyState,
  PageWindow,
  Pagination,
  SegmentedTabs,
} from "@/src/components/ui";
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

/** GET /triggers 条目（对齐 todo-22 契约；source 为服务端派生，只读）。 */
interface TriggerItem {
  id: string;
  kind: string;
  status: "pending" | "firing" | "fired" | "cancelled" | "failed";
  dueAt: string | null;
  nextFireAt: string | null;
  scopeType: string | null;
  scopeId: string | null;
  ownerInstanceId: string | null;
  fireCount: number;
  skipReason: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  source: "system" | "agent";
}

/** GET /triggers 分页响应。 */
interface TriggersResponse {
  items: TriggerItem[];
  total: number;
  page: number;
  pageSize: number;
}

/* ------------------------------ 筛选 Tab ------------------------------ */

/** kind Tab：事件为预留类型（无后端 kind 可映射，见文件头注释）。 */
type KindTab = "" | "hook_fire" | "hook_poll" | "event";

const KIND_TABS: { key: KindTab; label: string; icon: string }[] = [
  { key: "", label: "全部", icon: "◷" },
  { key: "hook_fire", label: "定时", icon: "◔" },
  { key: "hook_poll", label: "条件", icon: "◑" },
  { key: "event", label: "事件", icon: "◈" },
];

/** source 筛选：后端无 source 参数，system/agent 走客户端过滤（见文件头）。 */
type SourceFilter = "" | "system" | "agent";

const SOURCE_TABS: { key: SourceFilter; label: string; icon: string }[] = [
  { key: "", label: "全部", icon: "◎" },
  { key: "system", label: "系统", icon: "⬡" },
  { key: "agent", label: "Agent", icon: "○" },
];

/** kind → 中文标签（未知 kind 原样展示，不崩）。 */
const KIND_LABEL: Record<string, string> = {
  receipt_nudge: "催办",
  review_round_timeout: "评审超时",
  progression_patrol: "进度巡检",
  session_idle_scan: "空闲扫描",
  hook_fire: "定时",
  hook_poll: "条件",
};

/** kind → 徽章配色（对齐 tokens 语义色系；字面量与 memories 页 LEVEL_META 同式）。 */
const KIND_META: Record<string, { color: string; bg: string; border: string }> = {
  receipt_nudge: { color: "#0D9488", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.22)" },
  review_round_timeout: { color: "#7C3AED", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" },
  progression_patrol: { color: "#0284C7", bg: "rgba(2,132,199,0.10)", border: "rgba(2,132,199,0.22)" },
  session_idle_scan: { color: "#D97706", bg: "rgba(251,191,36,0.12)", border: "rgba(251,191,36,0.32)" },
  hook_fire: { color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  hook_poll: { color: "#6D28D9", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" },
};

const KIND_META_FALLBACK = { color: neutral[500], bg: neutral[100], border: neutral[200] };

/** status → 中文 + 配色（共享 StatusBadge 只支持任务四态，故本页用同式本地徽章）。 */
const STATUS_META: Record<TriggerItem["status"], { label: string; color: string; bg: string; border: string }> = {
  pending: { label: "待触发", color: "#0D9488", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.22)" },
  firing: { label: "触发中", color: "#0284C7", bg: "rgba(2,132,199,0.10)", border: "rgba(2,132,199,0.22)" },
  fired: { label: "已触发", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  cancelled: { label: "已取消", color: neutral[500], bg: neutral[100], border: neutral[200] },
  failed: { label: "失败", color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
};

/** source → 中文 + 配色（服务端派生值，本页只读展示）。 */
const SOURCE_META: Record<TriggerItem["source"], { label: string; color: string; bg: string; border: string }> = {
  system: { label: "系统", color: "#7C3AED", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" },
  agent: { label: "Agent", color: "#0D9488", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.22)" },
};

/* ------------------------------ 时间展示 ------------------------------ */

/** 到期/下次触发的人性化文案（pending/firing 才算倒计时；终态直接给结论）。 */
function formatDue(item: TriggerItem, now: number): string {
  if (item.status === "fired") return "已触发";
  if (item.status === "cancelled") return "已取消";
  if (item.status === "failed") return "触发失败";
  const ref = item.nextFireAt ?? item.dueAt;
  if (!ref) return "时间未知";
  const target = new Date(ref).getTime();
  if (Number.isNaN(target)) return "时间未知";
  const diffMs = target - now;
  const abs = Math.abs(diffMs);
  const mins = Math.floor(abs / 60000);
  const span =
    mins < 1 ? "不到1分钟" : mins < 60 ? `${mins}分钟` : `${Math.floor(mins / 60)}h${mins % 60 === 0 ? "" : `${mins % 60}m`}`;
  if (diffMs >= 0) return `还有 ${span}`;
  return `已到期 ${span}`;
}

/* ------------------------------ 行 hover CSS ------------------------------ */

const rowCss = `
.trig-row { transition: border-color .15s ease, background-color .15s ease; }
.trig-row:hover { background-color: var(--color-neutral-50); }
`;

/* ------------------------------ 详情抽屉 ------------------------------ */

/** 行详情抽屉（照抄 integrations 页 DeliveryDrawer 的 absolute 右抽屉模式）。 */
function TriggerDetailDrawer({ item, onClose }: { item: TriggerItem; onClose: () => void }) {
  const kindMeta = KIND_META[item.kind] ?? KIND_META_FALLBACK;
  const statusMeta = STATUS_META[item.status];
  const sourceMeta = SOURCE_META[item.source];
  const rows: { label: string; value: string; testid?: string }[] = [
    { label: "ID", value: item.id },
    { label: "类型", value: `${KIND_LABEL[item.kind] ?? item.kind} (${item.kind})` },
    { label: "状态", value: statusMeta.label },
    { label: "来源", value: `${sourceMeta.label}（服务端派生）` },
    { label: "到期 / 下次触发", value: `${item.dueAt ?? "—"} / ${item.nextFireAt ?? "—"}` },
    { label: "范围", value: `${item.scopeType ?? "—"} / ${item.scopeId ?? "—"}` },
    { label: "归属实例", value: item.ownerInstanceId ?? "—" },
    { label: "触发次数 / 尝试次数", value: `${item.fireCount} / ${item.attempts}` },
    { label: "未触发原因", value: item.skipReason ?? "—", testid: "trigger-detail-skip-reason" },
    { label: "上次错误", value: item.lastError ?? "—", testid: "trigger-detail-last-error" },
    { label: "创建时间", value: new Date(item.createdAt).toLocaleString("zh-CN") },
  ];
  return (
    <div
      data-testid="trigger-detail-drawer"
      style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", justifyContent: "flex-end", ...baseFont }}
    >
      <div aria-hidden onClick={onClose} style={{ flex: 1, backgroundColor: "rgba(15,23,42,.32)" }} />
      <div
        style={{
          width: 440,
          maxWidth: "92%",
          backgroundColor: "var(--color-surface)",
          borderLeft: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.md,
            padding: `${space.lg}px ${space.xl}px`,
            borderBottom: `1px solid ${neutral[200]}`,
          }}
        >
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], flex: 1 }}>触发器详情</span>
          <button
            type="button"
            data-testid="trigger-detail-close"
            onClick={onClose}
            aria-label="关闭详情"
            style={{
              width: 32,
              height: 32,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[600],
              cursor: "pointer",
              fontSize: fontSize.lg,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: space.lg, display: "flex", flexDirection: "column", gap: space.md }}>
          <div style={{ display: "flex", gap: space.sm, flexWrap: "wrap" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: `${space.xs}px ${space.sm + 2}px`,
                borderRadius: radius.pill,
                backgroundColor: kindMeta.bg,
                border: `1px solid ${kindMeta.border}`,
                color: kindMeta.color,
                fontSize: fontSize.sm,
                fontWeight: 500,
              }}
            >
              {KIND_LABEL[item.kind] ?? item.kind}
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: `${space.xs}px ${space.sm + 2}px`,
                borderRadius: radius.pill,
                backgroundColor: statusMeta.bg,
                border: `1px solid ${statusMeta.border}`,
                color: statusMeta.color,
                fontSize: fontSize.sm,
                fontWeight: 500,
              }}
            >
              {statusMeta.label}
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: `${space.xs}px ${space.sm + 2}px`,
                borderRadius: radius.pill,
                backgroundColor: sourceMeta.bg,
                border: `1px solid ${sourceMeta.border}`,
                color: sourceMeta.color,
                fontSize: fontSize.sm,
                fontWeight: 500,
              }}
            >
              {sourceMeta.label}
            </span>
          </div>
          {rows.map((r) => (
            <div key={r.label} style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
              <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>{r.label}</span>
              <span
                {...(r.testid ? { "data-testid": r.testid } : {})}
                style={{
                  fontSize: fontSize.sm,
                  color: neutral[800],
                  wordBreak: "break-all",
                  whiteSpace: "pre-wrap",
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: radius.md,
                  backgroundColor: neutral[50],
                  border: `1px solid ${neutral[200]}`,
                }}
              >
                {r.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ================================ 页面组件 ================================ */

const PAGE_SIZE = 20;
/** 客户端过滤模式下的取回上限（后端最大 100）。 */
const FETCH_ALL_SIZE = 100;
/** 实时兜底轮询（workers/memories/团队会话既定 10-30s 模式，取中值 15s）。 */
const POLL_INTERVAL_MS = 15_000;

export default function TriggersPage() {
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.roleName === "admin";

  /* ---------- 筛选状态 ---------- */
  const [kindTab, setKindTab] = useState<KindTab>("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("");
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [page, setPage] = useState(1);
  /** 成员视角的团队范围（成员无 teamId 查列表会被 403，先选范围再查）。 */
  const [teamId, setTeamId] = useState("");

  /* ---------- 30s tick：驱动「还有 X」倒计时重算 ---------- */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  /* ---------- 搜索防抖 300ms（照抄 memories 页） ---------- */
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedKeyword(keyword.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  /* ---------- 筛选切换重置页码 ---------- */
  useEffect(() => {
    setPage(1);
  }, [kindTab, sourceFilter, teamId]);

  /* ---------- 客户端过滤模式：source 筛选或关键字搜索时取回全量再过滤 ---------- */
  const clientFilterActive = sourceFilter !== "" || debouncedKeyword !== "";

  /* ---------- 团队候选（仅非 admin 需要选范围时拉取） ---------- */
  const teamsQuery = useQuery({
    queryKey: ["teams", { scope: "trigger-picker" }],
    queryFn: () => teamsApi.list({ page: 1, pageSize: 100 }),
    enabled: !!token && !isAdmin,
  });
  const teamOptions: TeamDto[] = teamsQuery.data?.items ?? [];

  /* ---------- 事件 Tab：预留类型，不发请求 ---------- */
  const isEventTab = kindTab === "event";
  /* ---------- 成员未选团队范围：不发请求，渲染选择器 ---------- */
  const needsTeamScope = !isAdmin && teamId === "";

  /* ---------- 数据查询 ---------- */
  const triggersQuery = useQuery<TriggersResponse>({
    queryKey: [
      "triggers",
      {
        kind: kindTab === "event" ? undefined : kindTab || undefined,
        teamId: teamId || undefined,
        fetchAll: clientFilterActive,
        page: clientFilterActive ? 1 : page,
      },
    ],
    queryFn: () =>
      api.get<TriggersResponse>("/triggers", {
        query: {
          ...(kindTab && kindTab !== "event" ? { kind: kindTab } : {}),
          ...(teamId ? { teamId } : {}),
          page: clientFilterActive ? 1 : page,
          pageSize: clientFilterActive ? FETCH_ALL_SIZE : PAGE_SIZE,
        },
      }),
    enabled: !!token && !isEventTab && !needsTeamScope,
    refetchInterval: POLL_INTERVAL_MS,
  });

  /* ---------- 实时：receipt/round 事件 → 列表失效重取（+ 轮询兜底） ---------- */
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["triggers"] });
  useRealtimeEvents({
    onReceiptAcked: invalidate,
    onReceiptExpired: invalidate,
    onRoundComplete: invalidate,
    onRoundStale: invalidate,
  });

  /* ---------- 客户端过滤 + 分页 ---------- */
  const { displayItems, displayTotal, totalPages } = useMemo(() => {
    const fetched = triggersQuery.data?.items ?? [];
    const kw = debouncedKeyword.toLowerCase();
    const filtered = fetched.filter((item) => {
      if (sourceFilter !== "" && item.source !== sourceFilter) return false;
      if (kw) {
        const hay = [item.id, item.kind, item.scopeType ?? "", item.scopeId ?? "", item.ownerInstanceId ?? "", item.skipReason ?? "", item.lastError ?? ""]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    if (!clientFilterActive) {
      return { displayItems: filtered, displayTotal: triggersQuery.data?.total ?? 0, totalPages: Math.max(1, Math.ceil((triggersQuery.data?.total ?? 0) / PAGE_SIZE)) };
    }
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(page, pages);
    return {
      displayItems: filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
      displayTotal: filtered.length,
      totalPages: pages,
    };
  }, [triggersQuery.data, sourceFilter, debouncedKeyword, clientFilterActive, page]);

  /* ---------- 详情抽屉 ---------- */
  const [detailItem, setDetailItem] = useState<TriggerItem | null>(null);

  /* ---------- 取消 ---------- */
  const [cancelTarget, setCancelTarget] = useState<TriggerItem | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  useEffect(() => {
    if (!cancelError) return;
    const timer = setTimeout(() => setCancelError(null), 5000);
    return () => clearTimeout(timer);
  }, [cancelError]);

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.delete<TriggerItem>(`/triggers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["triggers"] });
      setCancelTarget(null);
      setCancelError(null);
    },
    onError: (err) => {
      // 服务端错误码/文案原样展示（如 TRIGGER_SYSTEM_READONLY / TRIGGER_FORBIDDEN / TRIGGER_NOT_FOUND）
      setCancelError(isApiError(err) ? `${err.code}：${err.message}` : "取消失败，请重试");
    },
  });

  /* ---------- 取消按钮可见性：仅 pending/firing 行；非 admin 的 system 行不渲染 ---------- */
  const canShowCancel = (item: TriggerItem): boolean => {
    if (item.status !== "pending" && item.status !== "firing") return false;
    if (item.source === "system" && !isAdmin) return false;
    return true;
  };

  /* ---------- 403 team-scope 的可读兜底 ---------- */
  const queryErrorCode = isApiError(triggersQuery.error) ? triggersQuery.error.code : null;
  const isScopeError = queryErrorCode === "TRIGGER_TEAM_SCOPE_REQUIRED";

  return (
    <PageWindow testId="triggers-root" style={{ ...baseFont, position: "relative" }}>
      <style>{rowCss}</style>

      {/* ① 工具条：kind Tab + source 筛选 + 搜索框 */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
        <div
          style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}
        >
          <SegmentedTabs
            testId="trigger-kind-tabs"
            optionTestId="trigger-kind-tab"
            items={KIND_TABS}
            active={kindTab}
            onChange={(k) => setKindTab(k as KindTab)}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              flex: 1,
              minWidth: 200,
              maxWidth: 300,
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
              data-testid="trigger-search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索 ID / 类型 / 范围 / 归属…"
              aria-label="搜索触发器"
              style={{
                flex: 1,
                minWidth: 0,
                border: "none",
                background: "transparent",
                fontSize: fontSize.md,
                color: neutral[800],
                fontFamily: fontFamily.body,
              }}
            />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
          <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>来源</span>
          <SegmentedTabs
            testId="trigger-source-tabs"
            optionTestId="trigger-source-tab"
            items={SOURCE_TABS}
            active={sourceFilter}
            onChange={(k) => setSourceFilter(k as SourceFilter)}
          />
          {/* 成员团队范围选择器 */}
          {!isAdmin && (
            <select
              data-testid="trigger-team-scope"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              aria-label="团队范围"
              style={{
                padding: `${space.sm}px ${space.md}px`,
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "var(--color-surface)",
                color: neutral[800],
                fontSize: fontSize.md,
                fontFamily: fontFamily.body,
                maxWidth: 280,
              }}
            >
              <option value="">选择团队范围…</option>
              {teamOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}（{t.id}）
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* ② 事件 Tab：预留类型空态（不发请求、不报错） */}
      {isEventTab ? (
        <EmptyState
          title="暂无事件触发器"
          description="事件触发器为预留类型，当前版本尚未接入，定时/条件触发器请切换上方 Tab 查看。"
          icon="◈"
        />
      ) : needsTeamScope ? (
        /* ③ 成员未选团队范围：明确提示而非 raw 403 */
        <EmptyState
          title="请选择团队范围"
          description="成员查看触发器列表需要按团队过滤（全局列表仅管理员可见），请在上方选择团队后再查看。"
          icon="⬡"
        />
      ) : triggersQuery.isPending ? (
        <div
          data-testid="triggers-loading"
          style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xxl}px 0`, textAlign: "center" }}
        >
          加载中…
        </div>
      ) : triggersQuery.isError ? (
        <div
          data-testid="triggers-error"
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
            {isScopeError
              ? "当前账号需要按团队范围查看，请在上方选择团队后再试。"
              : isApiError(triggersQuery.error)
                ? `${triggersQuery.error.code}：${triggersQuery.error.message}`
                : "加载触发器列表失败"}
          </div>
          <button
            type="button"
            data-testid="triggers-retry"
            onClick={() => triggersQuery.refetch()}
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
      ) : displayItems.length === 0 ? (
        <EmptyState
          title="暂无触发器"
          description={
            debouncedKeyword || sourceFilter || kindTab
              ? "当前筛选条件下没有匹配的触发器，换个条件试试。"
              : "当前还没有触发器，Agent 运行时创建后会显示在这里。"
          }
          icon="◷"
        />
      ) : (
        <>
          {/* 计数 */}
          <div data-testid="triggers-count" style={{ fontSize: fontSize.sm, color: neutral[400] }}>
            共 {displayTotal} 个触发器
          </div>

          {/* 列表 */}
          <div data-testid="triggers-list" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
            {displayItems.map((item) => {
              const kindMeta = KIND_META[item.kind] ?? KIND_META_FALLBACK;
              const statusMeta = STATUS_META[item.status];
              const sourceMeta = SOURCE_META[item.source];
              const scopeText = item.scopeType && item.scopeId ? `${item.scopeType}/${item.scopeId}` : "全局";
              return (
                <div
                  key={item.id}
                  data-testid="trigger-row"
                  data-trigger-id={item.id}
                  data-kind={item.kind}
                  data-status={item.status}
                  data-source={item.source}
                  className="trig-row"
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
                  {/* 类型徽章 */}
                  <span
                    data-testid="trigger-kind"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      padding: `${space.xs}px ${space.sm + 2}px`,
                      borderRadius: radius.pill,
                      backgroundColor: kindMeta.bg,
                      border: `1px solid ${kindMeta.border}`,
                      color: kindMeta.color,
                      fontSize: fontSize.xs,
                      fontWeight: 500,
                      lineHeight: 1.4,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  >
                    {KIND_LABEL[item.kind] ?? item.kind}
                  </span>

                  {/* 主体 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                      <span
                        data-testid="trigger-id"
                        style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800], fontFamily: fontFamily.mono }}
                      >
                        {item.id}
                      </span>
                      {/* 状态徽章（同 StatusBadge 视觉式；共享组件仅支持任务四态） */}
                      <span
                        data-testid="trigger-status"
                        data-status={item.status}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: space.xs,
                          padding: `${space.xs}px ${space.sm + 2}px`,
                          borderRadius: radius.pill,
                          backgroundColor: statusMeta.bg,
                          border: `1px solid ${statusMeta.border}`,
                          color: statusMeta.color,
                          fontSize: fontSize.xs,
                          fontWeight: 500,
                          lineHeight: 1.4,
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: statusMeta.color, flexShrink: 0 }} />
                        {statusMeta.label}
                      </span>
                      {/* 来源徽章（服务端派生值） */}
                      <span
                        data-testid="trigger-source"
                        data-source={item.source}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: `${space.xs}px ${space.sm + 2}px`,
                          borderRadius: radius.pill,
                          backgroundColor: sourceMeta.bg,
                          border: `1px solid ${sourceMeta.border}`,
                          color: sourceMeta.color,
                          fontSize: fontSize.xs,
                          fontWeight: 500,
                          lineHeight: 1.4,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {sourceMeta.label}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: space.md,
                        marginTop: space.xs,
                        flexWrap: "wrap",
                        fontSize: fontSize.sm,
                        color: neutral[500],
                      }}
                    >
                      <span data-testid="trigger-due">⏱ {formatDue(item, now)}</span>
                      <span data-testid="trigger-scope">范围 {scopeText}</span>
                      <span data-testid="trigger-owner">归属 {item.ownerInstanceId ?? "—"}</span>
                      <span data-testid="trigger-fire-count">触发 {item.fireCount} 次</span>
                    </div>
                    {/* skipReason：回答「为什么没醒」 */}
                    {item.skipReason && (
                      <div
                        data-testid="trigger-skip-reason"
                        style={{
                          marginTop: space.xs,
                          fontSize: fontSize.sm,
                          color: "#B45309",
                          backgroundColor: "#FFFBEB",
                          border: "1px solid #FDE68A",
                          padding: `${space.xs}px ${space.sm + 2}px`,
                          borderRadius: radius.md,
                          wordBreak: "break-word",
                        }}
                      >
                        未触发原因：{item.skipReason}
                      </div>
                    )}
                  </div>

                  {/* 操作区 */}
                  <div style={{ display: "flex", gap: space.sm, flexShrink: 0, marginTop: 2 }}>
                    <button
                      type="button"
                      data-testid="trigger-detail"
                      data-trigger-id={item.id}
                      onClick={() => setDetailItem(item)}
                      style={{
                        padding: `${space.xs}px ${space.md}px`,
                        borderRadius: radius.md,
                        border: `1px solid ${neutral[200]}`,
                        backgroundColor: "var(--color-surface)",
                        color: neutral[600],
                        fontSize: fontSize.sm,
                        cursor: "pointer",
                        fontFamily: fontFamily.body,
                      }}
                    >
                      详情
                    </button>
                    {canShowCancel(item) && (
                      <button
                        type="button"
                        data-testid="trigger-cancel"
                        data-trigger-id={item.id}
                        onClick={() => {
                          setCancelError(null);
                          setCancelTarget(item);
                        }}
                        style={{
                          padding: `${space.xs}px ${space.md}px`,
                          borderRadius: radius.md,
                          border: "1px solid rgba(239,68,68,0.22)",
                          backgroundColor: "var(--color-surface)",
                          color: "#DC2626",
                          fontSize: fontSize.sm,
                          cursor: "pointer",
                          fontFamily: fontFamily.body,
                        }}
                      >
                        取消
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 分页（共享 Pagination 组件） */}
          <div style={{ display: "flex", justifyContent: "center", marginTop: space.md }}>
            <Pagination
              page={clientFilterActive ? Math.min(page, totalPages) : page}
              totalPages={totalPages}
              onPageChange={(p) => setPage(p)}
              dataTestId="triggers-pagination"
            />
          </div>
        </>
      )}

      {/* 取消失败提示（服务端错误码原样展示） */}
      {cancelError && (
        <div
          data-testid="trigger-cancel-error"
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
            border: "1px solid rgba(239,68,68,0.22)",
          }}
        >
          <span aria-hidden style={{ fontWeight: 700 }}>!</span>
          {cancelError}
        </div>
      )}

      {/* 取消二次确认 */}
      <ConfirmDialog
        open={!!cancelTarget}
        testid="confirm-cancel-trigger"
        title="取消触发器"
        description={
          cancelTarget
            ? `确定要取消触发器 ${cancelTarget.id}（${KIND_LABEL[cancelTarget.kind] ?? cancelTarget.kind}）吗？已触发/已取消的行服务端会幂等返回，此操作不可恢复。`
            : undefined
        }
        confirmLabel="确认取消"
        pendingLabel="取消中…"
        danger
        submitting={cancelMutation.isPending}
        onClose={() => {
          setCancelTarget(null);
          cancelMutation.reset();
        }}
        onConfirm={() => {
          if (cancelTarget) cancelMutation.mutate(cancelTarget.id);
        }}
      />

      {/* 行详情抽屉 */}
      {detailItem && <TriggerDetailDrawer item={detailItem} onClose={() => setDetailItem(null)} />}
    </PageWindow>
  );
}
