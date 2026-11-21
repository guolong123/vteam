"use client";

/**
 * Worker 节点详情页（T10：GET /workers/:id 渲染）
 * =====================================================
 * 由 workers 列表页「查看详情」按钮进入（/workers/:id），展示该节点的完整注册+心跳快照：
 * - 基本信息：id / 名称 / 状态徽章（在线/离线/维护中）/ 注册时间 / 上次心跳（1s tick 重算）
 * - opencode 信息：版本 / serve 端口（capabilities.port）/ baseUrl / 并发上限（maxInstances）
 * - 负载：当前活跃会话数 load.instances + 占用率进度条（loadColor 档位，对齐列表页）
 * - skills：capabilities.skills 真实注入清单（T9），空态提示
 * - tools：capabilities.tools = 内置 git 7 工具 + 自定义工具（T9），内置/自定义徽章区分，空态提示
 * - MCP 状态：mcpStatus 每次心跳刷新（connected/pending/disabled/failed/needs_auth
 *   五态徽章，对齐 skills 页 mcpStatusTheme），空态提示
 * - 数据是注册+心跳快照：skills/tools 在注册/reload-config 后刷新，mcpStatus 每次心跳刷新
 * - 布局/文案/token 对齐列表页（白卡片 + neutral 色板 + 共享 ./shared.tsx 定义）
 * - 铁律（T15）：无 fixed / 100vh / 100vw，高度由 AppShell main 接管，本页 flex:1 + overflowY auto
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";
import {
  WORKER_STATUS_LABEL,
  workerStatusTheme,
  loadColor,
  pulseCss,
  formatRelativeTime,
  MCP_STATUS_THEME,
  isBuiltinGitTool,
  WorkerStatusBadge,
  cardStyle,
  SectionHeader,
  WORKER_UPDATE_STATE_LABEL,
  deriveServerBase,
  deriveWebBase,
  isNonReleasedVersion,
  isLoopbackHost,
  type WorkerDetail,
} from "../shared";
import { hasPermission } from "@/lib/permissions";
import { ConfirmDialog, UpgradeCommandDialog } from "@/src/components/ui";
import { OmoPanel, OpencodeAgentsPanel } from "./omo-panel";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 引擎文案：capabilities.engine 缺省 opencode（兼容没有该键的存量 worker）。 */
const ENGINE_LABEL: Record<"opencode" | "dsh", string> = {
  opencode: "opencode",
  dsh: "dsh（DeepSeek Harness）",
};

/* ------------------------------ 模型卡 API 数据模型（C3/C8 契约） ------------------------------ */

/** GET /models 目录条目（id=md_xxx 目录主键；providerID/modelID 为默认模型 ref 格式）。 */
interface CatalogModelRow {
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  enabled: boolean;
}

/** GET /models 分页响应（兜底数据源 + 模型名映射）。 */
interface ModelsPage {
  items: CatalogModelRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** 模型 ref（providerID/modelID）拆解：含 `/` 按首个 `/` 拆；不含（旧自由字符串）providerID 归 opencode。 */
function splitModelRef(ref: string): { providerID: string; modelID: string } {
  const idx = ref.indexOf("/");
  return idx > 0
    ? { providerID: ref.slice(0, idx), modelID: ref.slice(idx + 1) }
    : { providerID: "opencode", modelID: ref };
}

/* ------------------------------ 子组件 ------------------------------ */

/** MCP 服务器状态徽章（五态：已连接/连接中/已停用/连接失败/待授权，对齐 skills 页 mcpStatusTheme）。 */
function McpStatusBadge({ status }: { status: WorkerDetail["mcpStatus"][number]["status"] }) {
  const theme = MCP_STATUS_THEME[status];
  return (
    <span
      data-testid="worker-mcp-status"
      data-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs - 1}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      <span aria-hidden style={{ fontSize: fontSize.xs, lineHeight: 1 }}>{theme.mark}</span>
      {theme.label}
    </span>
  );
}

/** 工具名徽章：内置 git 工具（蓝系）/ 自定义工具（紫系，对齐 skills 页来源语义）。 */
function ToolBadge({ name }: { name: string }) {
  const builtin = isBuiltinGitTool(name);
  return (
    <span
      data-testid="worker-tool-badge"
      data-source={builtin ? "builtin" : "custom"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: "2px 10px",
        borderRadius: radius.pill,
        backgroundColor: builtin ? "rgba(13,148,136,0.10)" : "rgba(124,58,237,0.10)",
        border: `1px solid ${builtin ? "rgba(13,148,136,0.22)" : "rgba(124,58,237,0.22)"}`,
        color: builtin ? "#0D9488" : "#7C3AED",
        fontSize: fontSize.sm,
        fontWeight: 500,
        fontFamily: fontFamily.mono,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      {name}
      <span aria-hidden style={{ fontSize: fontSize.xs, opacity: 0.7 }}>
        {builtin ? "内置" : "自定义"}
      </span>
    </span>
  );
}

/** 空态提示（各能力区块共用：灰色虚线框）。 */
function SectionEmpty({ text }: { text: string }) {
  return (
    <div
      data-testid="worker-section-empty"
      style={{
        padding: `${space.lg}px`,
        borderRadius: radius.md,
        border: `1px dashed ${neutral[200]}`,
        backgroundColor: neutral[50],
        fontSize: fontSize.sm,
        color: neutral[400],
        textAlign: "center",
        ...baseFont,
      }}
    >
      {text}
    </div>
  );
}

/** 信息行（key-value 纵向布局，详情卡内统一样式）。 */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{label}</span>
      <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[800] }}>{value}</span>
    </div>
  );
}

/** 并发上限可选值（对齐 install 页能力声明下拉的候选集）。 */
const MAX_INSTANCE_PRESETS = [2, 4, 6, 8, 12, 16];

/** 内联下拉样式（对齐 install 页 inputStyle 色值/圆角，内联场景收紧间距与字号）。 */
const maxInstancesSelectStyle: CSSProperties = {
  padding: `${space.xs}px ${space.sm}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  color: neutral[800],
  fontSize: fontSize.sm,
  fontFamily: fontFamily.mono,
  cursor: "pointer",
};

/**
 * 并发上限行：只读值 + 内联下拉编辑（PATCH /workers/:id { maxInstances }）。
 * - capabilities 缺失（从未上报）仍允许设置，读显「未上报」（对齐列表页语义）；
 * - 提交中禁用下拉并乐观显示所选值；失败回退服务端值并内联报错；
 * - 成功后失效 ["worker", workerId]，联动基本信息、负载卡（instances/maxInstances）刷新。
 */
function MaxInstancesControl({
  workerId,
  reported,
  maxInstances,
}: {
  workerId: string;
  reported: boolean;
  maxInstances: number;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  /** 乐观值：提交后立即回显所选值，待 refetch 落地 / 出错回退后再清空。 */
  const [optimistic, setOptimistic] = useState<number | null>(null);

  const mutation = useMutation({
    mutationFn: (value: number) =>
      api.patch<WorkerDetail>(`/workers/${workerId}`, { maxInstances: value }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["worker", workerId] });
      setOptimistic(null);
    },
    onError: (err: unknown) => {
      setOptimistic(null);
      setError(isApiError(err) ? err.message : "保存失败，请稍后重试");
    },
  });

  const effective = optimistic ?? maxInstances;
  const valueReported = reported || optimistic !== null;
  /* 保留非预设当前值（如历史 5 并发 / 未上报的 0）为可选项，避免静默改写。 */
  const options = MAX_INSTANCE_PRESETS.includes(effective)
    ? [...MAX_INSTANCE_PRESETS]
    : reported
      ? [...MAX_INSTANCE_PRESETS, effective]
      : [effective, ...MAX_INSTANCE_PRESETS];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>并发上限</span>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <span
          data-testid="worker-max-instances-value"
          data-reported={reported ? "true" : "false"}
          data-max-instances={effective}
          title={reported ? undefined : "该节点本次未携带能力声明（可能从未上报），非 0 并发"}
          style={{
            fontSize: fontSize.md,
            fontWeight: 500,
            color: valueReported ? neutral[800] : neutral[400],
          }}
        >
          {valueReported ? `${effective} 并发` : "未上报"}
        </span>
        <select
          data-testid="worker-max-instances-select"
          aria-label="并发上限"
          value={effective}
          disabled={mutation.isPending}
          onChange={(e) => {
            setError(null);
            setOptimistic(Number(e.target.value));
            mutation.mutate(Number(e.target.value));
          }}
          style={{
            ...maxInstancesSelectStyle,
            cursor: mutation.isPending ? "not-allowed" : "pointer",
            opacity: mutation.isPending ? 0.6 : 1,
          }}
        >
          {options.map((n) => (
            <option key={n} value={n}>
              {n === 0 && !reported ? "未上报" : `${n} 并发`}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <span
          data-testid="worker-max-instances-error"
          role="alert"
          style={{ fontSize: fontSize.xs, color: "#DC2626" }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

/* ------------------------------ 页面主组件（AppShell 内容区） ------------------------------ */

export default function WorkerDetailPage() {
  const params = useParams<{ id: string }>();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const workerId = params.id;
  const queryClient = useQueryClient();

  /* 1s tick：驱动相对时间重算（数据本身由轮询刷新） */
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();

  const { data: worker, isPending, isError, error, refetch } = useQuery({
    queryKey: ["worker", workerId],
    queryFn: () => api.get<WorkerDetail>(`/workers/${workerId}`),
    enabled: !!token && !!workerId,
    /* 实时性：与列表页同频轮询（心跳周期 10s），捕捉状态翻转与 mcpStatus 刷新 */
    refetchInterval: 10_000,
  });

  /* 引擎判定：dsh 节点没有 opencode serve，卡片字段与文案都不同（缺省 opencode 兼容存量 worker） */
  const engine: "opencode" | "dsh" = worker?.capabilities?.engine === "dsh" ? "dsh" : "opencode";
  const isDsh = engine === "dsh";

  /* ── 升级入口（与列表页同一套二分逻辑，口径必须一致）─────────────────
     - canSelfUpdate === true ⇒「更新」按钮（下发 update-worker 指令）；
     - 否则（false / undefined=旧 worker）⇒「升级命令」弹窗（复制命令人工执行）。
     可见性**只看 `updateAvailable`**（= server 判定确实存在版本差异）。
     ⚠️ 不要把 `upgradeHint` 也算进去（曾这样做，是 bug）：那是"节点不能自更新"的
     说明，在版本已对齐时同样存在 ⇒ 升级完成后入口永远挂着。
     列表卡片与详情页共用同一判定口径，避免两处漂移。 */
  const canEdit = hasPermission(user?.permissions, "workers", "edit");
  const canSelfUpdate = worker?.canSelfUpdate === true;
  const detailUpdateEntryVisible = worker !== undefined && worker.updateAvailable;

  /* 控制面 server 基址：命令模板里的 {{SERVER_URL}} 由浏览器按**当前访问 origin** 替换
     （`deriveServerBase`：web 13001 → server 13000，与安装页同一套规则）。
     回环地址单独标记 —— 远程 worker 上的 127.0.0.1 指向它自己。 */
  const [serverBase, setServerBase] = useState("");
  const [webBase, setWebBase] = useState("");
  const [loopbackOrigin, setLoopbackOrigin] = useState(false);
  useEffect(() => {
    setServerBase(deriveServerBase(window.location.origin));
    setWebBase(deriveWebBase(window.location.origin));
    setLoopbackOrigin(isLoopbackHost(window.location.hostname));
  }, []);

  /* 两个对话框：一键更新（确认）/ 手动升级命令（复制）。互斥出现。 */
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false);

  /* 一键更新：POST /workers/:id/update（与列表页同一接口；目标版本由 server env 决定）。
     成功后刷新详情（updateState 会随心跳变成 pending → downloading → restarting）。 */
  const updateMutation = useMutation({
    mutationFn: () =>
      api.post<{ status: string; version: string | null }>(`/workers/${workerId}/update`),
    onSuccess: () => {
      setUpdateDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["worker", workerId] });
    },
  });
  const updateBusy = updateMutation.isPending;
  /* 依赖 updateBusy，故在 mutation 之后计算（避免 TDZ） */
  const detailUpdateDisabled =
    canSelfUpdate ? !canEdit || worker?.status === "offline" || updateBusy : !canEdit;

  /**
   * 模型目录：只取 **enabled** 的（与"可用模型"口径一致，也是模型名映射的数据源）。
   * 全量目录有 8000+ 条且多为无凭据的元数据，拉全量既慢又无意义。
   */
  const { data: catalog } = useQuery({
    queryKey: ["models", "catalog", "enabled"],
    queryFn: () =>
      api.get<ModelsPage>("/models", {
        query: { enabled: "true", pageSize: 500 },
      }),
    enabled: !!token,
    staleTime: 60_000,
  });

  /* providerID/modelID ref → 目录产品名（缺失回退 modelID 末段） */
  const catalogByRef = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of catalog?.items ?? []) {
      map.set(`${row.providerID}/${row.modelID}`, row.name);
    }
    return map;
  }, [catalog]);

  /**
   * 可用模型 = **真正可执行**的模型，按优先级取：
   *   1. capabilities.executableModels —— worker 用 CLI 探测（带鉴权过滤）的可执行清单，
   *      与 agent 模型下拉同源，是权威值；
   *   2. 目录中 enabled 的模型 —— 兜底（老 worker 未上报 executableModels 时）；
   *   3. 两者皆无 → 空（显示"未上报"，**不再退回全量目录**）。
   *
   * ⚠️ 不要用 capabilities.models：那是 serve 探测到的**全部模型目录**（实测 7699 条），
   * 绝大多数没有可用凭据，直接渲染会把页面撑爆且严重误导（实测踩坑）。
   */
  const modelRefs = useMemo(() => {
    const executable = worker?.capabilities?.executableModels ?? [];
    if (executable.length > 0) {
      return executable;
    }
    return (catalog?.items ?? [])
      .filter((m) => m.enabled)
      .map((m) => `${m.providerID}/${m.modelID}`);
  }, [worker, catalog]);

  if (!workerId) {
    return (
      <div data-testid="worker-detail-root" style={{ padding: space.xl, color: neutral[500], ...baseFont }}>
        缺少 Worker ID
      </div>
    );
  }

  return (
    <div
      data-testid="worker-detail-root"
      data-worker-id={workerId}
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        padding: `${space.xl}px`,
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
      }}
    >
      <style>{pulseCss}</style>

      {/* 返回 + 标题行 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.md,
          width: "100%",
          maxWidth: 960,
          margin: `${space.lg}px auto`,
        }}
      >
        <Link
          href="/workers"
          data-testid="worker-detail-back"
          aria-label="返回节点列表"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            color: neutral[600],
            fontSize: fontSize.md,
            textDecoration: "none",
            boxShadow: shadow.sm,
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>←</span>
          节点列表
        </Link>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
            Worker 详情
          </div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
            注册 + 心跳快照 · skills/tools 注册或 reload 后刷新，MCP 状态随心跳刷新
          </div>
        </div>
      </div>

      {isPending ? (
        <div
          data-testid="worker-detail-loading"
          style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0`, width: "100%", maxWidth: 960, margin: "0 auto", ...baseFont }}
        >
          加载中…
        </div>
      ) : isError || !worker ? (
        <div
          data-testid="worker-detail-error"
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: space.md,
            padding: `${space.xxl}px`,
            textAlign: "center",
            width: "100%",
            maxWidth: 960,
            margin: "0 auto",
            borderRadius: radius.lg,
            backgroundColor: "var(--color-surface)",
            border: `1px solid ${neutral[200]}`,
            ...baseFont,
          }}
        >
          <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
            {isApiError(error) ? error.message : "加载 Worker 详情失败"}
          </div>
          {/* 路由主键是节点 ID（w_xxx），主机名（name，如容器短哈希）不是路由主键：
              直接访问 /workers/<主机名> 会 404，这里给出可操作的指引避免误判为节点丢失。 */}
          <div
            data-testid="worker-detail-error-hint"
            style={{ fontSize: fontSize.sm, color: neutral[400], lineHeight: 1.7, maxWidth: 520 }}
          >
            <span style={{ fontFamily: fontFamily.mono }}>{workerId}</span> 不是有效的节点 ID。
            详情路由须使用「节点 ID」（形如 <span style={{ fontFamily: fontFamily.mono }}>w_xxx</span>），
            主机名（如容器短哈希）仅作展示标识——请在节点列表按节点 ID 进入，或确认该节点是否已被删除。
          </div>
          <button
            type="button"
            data-testid="worker-detail-retry"
            onClick={() => refetch()}
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
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.lg,
            width: "100%",
            maxWidth: 960,
            margin: "0 auto",
          }}
        >
          {/* 基本信息卡 */}
          <section data-testid="worker-detail-basic" style={cardStyle()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
              <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    flexShrink: 0,
                    backgroundColor: workerStatusTheme[WORKER_STATUS_LABEL[worker.status]].color,
                    color: workerStatusTheme[WORKER_STATUS_LABEL[worker.status]].color,
                    animation: worker.status === "online" ? "workerpulse-blink 2s ease-in-out infinite" : undefined,
                  }}
                />
                <span
                  data-testid="worker-detail-id"
                  style={{
                    fontSize: fontSize.xl,
                    fontWeight: 600,
                    color: neutral[900],
                    fontFamily: fontFamily.mono,
                    letterSpacing: "-0.02em",
                    wordBreak: "break-all",
                  }}
                >
                  {worker.id}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexShrink: 0 }}>
                {/* 引擎类型：dsh / opencode —— 详情页此前只有"opencode 运行时"区块，
                    dsh 节点被当成 opencode 展示（用户实测反馈） */}
                <span
                  data-testid="worker-detail-engine"
                  data-engine={engine}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: `2px ${space.sm}px`,
                    borderRadius: radius.pill,
                    backgroundColor: isDsh ? "rgba(124,58,237,0.10)" : "rgba(13,148,136,0.10)",
                    border: `1px solid ${isDsh ? "rgba(124,58,237,0.25)" : "rgba(13,148,136,0.22)"}`,
                    color: isDsh ? "#7C3AED" : "#0D9488",
                    fontSize: fontSize.sm,
                    fontWeight: 500,
                    ...baseFont,
                  }}
                >
                  {engine}
                </span>
                <WorkerStatusBadge status={worker.status} />
              </div>
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], fontFamily: fontFamily.mono }}>
              {worker.name ?? "未命名节点"}
            </div>
            <div
              data-testid="worker-detail-times"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: space.md,
                paddingTop: space.sm,
                borderTop: `1px solid ${neutral[100]}`,
              }}
            >
              <InfoRow label="注册时间" value={formatRelativeTime(worker.registeredAt, now)} />
              <InfoRow label="上次心跳" value={formatRelativeTime(worker.lastHeartbeatAt, now)} />
            </div>
          </section>

          {/* 版本与升级卡（2026-11-21 新增）
              ── 为什么详情页需要它 ────────────────────────────────────────
              列表卡片有「待更新」徽章与「更新/升级命令」按钮，但详情页**一个字都没有**
              ⇒ 用户进详情后无从判断"这台机器该不该升级、怎么升"。
              这里把 codeVersion ↔ expectedVersion 的对比、以及升级入口集中呈现；
              入口形态与列表页一致：能自更新 ⇒「更新」按钮，否则 ⇒「升级命令」弹窗。 */}
          <section data-testid="worker-detail-upgrade" style={cardStyle()}>
            <SectionHeader icon="⤒" title="版本与升级" />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: space.md,
              }}
            >
              <InfoRow
                label="运行版本"
                value={worker.codeVersion ?? "未上报"}
              />
              <InfoRow
                label="期望版本"
                value={
                  worker.expectedVersion === null || worker.expectedVersion === undefined
                    ? "未配置（server 未设 CODE_VERSION，无更新语义）"
                    : isNonReleasedVersion(worker.expectedVersion)
                      ? `${worker.expectedVersion}（占位值，不参与版本比对）`
                      : worker.expectedVersion
                }
              />
              <InfoRow
                label="自更新能力"
                value={
                  worker.canSelfUpdate === true
                    ? "支持（可一键更新）"
                    : worker.canSelfUpdate === false
                      ? "不支持（需手动升级）"
                      : "未上报（旧版本 worker）"
                }
              />
              {worker.updateState !== null && worker.updateState !== undefined && (
                <InfoRow
                  label="更新状态"
                  value={
                    WORKER_UPDATE_STATE_LABEL[worker.updateState] ?? worker.updateState
                  }
                />
              )}
            </div>

            {worker.rolledBack && (
              <div
                data-testid="worker-detail-rolled-back"
                style={{
                  fontSize: fontSize.sm,
                  color: "var(--color-warning-text)",
                  backgroundColor: "var(--color-warning-bg)",
                  border: "1px solid var(--color-warning-border)",
                  borderRadius: radius.md,
                  padding: space.sm,
                  lineHeight: 1.6,
                }}
              >
                ⚠ 该节点曾因新版本异常
                <strong>自动回滚</strong>
                。请确认问题已修复后再升级（回滚标志为粘滞，需人工处理后才会消失）。
              </div>
            )}

            {/* 升级入口：与列表页同一套二分逻辑（能自更新 → 按钮；否则 → 复制命令） */}
            {detailUpdateEntryVisible ? (
              <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                <button
                  type="button"
                  data-testid={
                    canSelfUpdate ? "worker-detail-update-button" : "worker-detail-upgrade-manual-button"
                  }
                  disabled={detailUpdateDisabled}
                  title={
                    !canEdit
                      ? "无 workers.edit 权限"
                      : worker.status === "offline"
                        ? "离线节点无法接收更新指令"
                        : !canSelfUpdate
                          ? "该节点不能自动升级，点开复制升级命令"
                          : "下载新版本并在空闲时重启生效"
                  }
                  onClick={() => {
                    if (canSelfUpdate) {
                      setUpdateDialogOpen(true);
                    } else {
                      setUpgradeDialogOpen(true);
                    }
                  }}
                  style={{
                    ...baseFont,
                    padding: `${space.sm - 1}px ${space.md}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${
                      detailUpdateDisabled ? neutral[100] : "var(--color-warning-border)"
                    }`,
                    backgroundColor: detailUpdateDisabled
                      ? neutral[100]
                      : "var(--color-warning-bg)",
                    color: detailUpdateDisabled ? neutral[400] : "var(--color-warning-text)",
                    fontSize: fontSize.md,
                    fontWeight: 600,
                    cursor: detailUpdateDisabled ? "not-allowed" : "pointer",
                  }}
                >
                  {canSelfUpdate ? "更新到期望版本" : "查看升级命令"}
                </button>
                <span style={{ fontSize: fontSize.sm, color: neutral[500], lineHeight: 1.5 }}>
                  {canSelfUpdate
                    ? "后台下载新版本，节点空闲时自动重启生效（不打断进行中的会话）"
                    : (worker.upgradeHint?.reason ?? "该节点需要手动升级")}
                </span>
              </div>
            ) : (
              <div style={{ fontSize: fontSize.sm, color: neutral[500] }}>
                {worker.expectedVersion === null ||
                worker.expectedVersion === undefined ||
                isNonReleasedVersion(worker.expectedVersion)
                  ? "无更新语义：server 的期望版本未配置或为占位值（如 local-compose / manual-*），不做版本比对"
                  : "运行版本与期望版本一致，无需升级"}
              </div>
            )}
          </section>

          {/* 运行时信息卡（按引擎分叉：dsh 没有 serve，控制面只连执行端点） */}
          <section data-testid="worker-detail-runtime" style={cardStyle()}>
            <SectionHeader icon="⬢" title={isDsh ? "dsh 运行时" : "opencode 运行时"} />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: space.md,
              }}
            >
              <InfoRow label="引擎" value={ENGINE_LABEL[engine]} />
              {isDsh ? (
                <>
                  {/* dsh 也有自己的引擎版本（含 `-rc.N`）；此前这个分支被整体跳过 ⇒ 详情页看不到版本。
                      ⚠️ 优先读 engineCapabilities.engineVersion：顶层 opencodeVersion 会被 server
                      归一化（会抹掉 `-rc.5`），那是调度过滤用的键，不是展示用的精确版本。 */}
                  <InfoRow
                    label="版本"
                    value={
                      (worker.capabilities as { engineCapabilities?: { engineVersion?: string } } | undefined)
                        ?.engineCapabilities?.engineVersion ??
                      (worker.opencodeVersion !== "unknown" ? worker.opencodeVersion : "未上报")
                    }
                  />
                  <InfoRow
                    label="执行端点"
                    value={`${worker.capabilities?.baseUrl ?? "未上报"}${worker.capabilities?.execPort !== undefined ? `:${worker.capabilities.execPort}` : ":4198"}`}
                  />
                </>
              ) : (
                <>
                  <InfoRow label="版本" value={worker.opencodeVersion} />
                  <InfoRow
                    label="serve 端口"
                    value={worker.capabilities?.port !== undefined ? String(worker.capabilities.port) : "未上报"}
                  />
                  <InfoRow label="baseUrl" value={worker.capabilities?.baseUrl ?? "未上报"} />
                </>
              )}
              <MaxInstancesControl
                workerId={workerId}
                reported={worker.capabilities !== undefined}
                maxInstances={worker.capabilities?.maxInstances ?? 0}
              />
            </div>
          </section>

          {/* 负载卡：实例数 + 占用率进度条（对齐列表页 load 语义） */}
          <section data-testid="worker-detail-load" style={cardStyle()}>
            <SectionHeader icon="▤" title="负载" />
            {(() => {
              const maxInstances = worker.capabilities?.maxInstances ?? 0;
              const instances = worker.load?.instances ?? 0;
              const loadPct = maxInstances > 0 ? Math.round((instances / maxInstances) * 100) : 0;
              // 满载是正常水位（并发上限），用橙色提示而非红色告警
              const barColor = loadPct >= 100 ? "#D97706" : loadColor(loadPct);
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>
                      当前活跃会话 · <span style={{ fontWeight: 600, color: neutral[800] }}>{instances}</span> 个
                    </span>
                    <span title={`并发上限 ${maxInstances}`} style={{ fontSize: fontSize.sm, fontWeight: 600, color: barColor }}>
                      {instances}/{maxInstances} 并发
                    </span>
                  </div>
                  <div
                    aria-hidden
                    style={{
                      width: "100%",
                      height: 6,
                      borderRadius: radius.pill,
                      backgroundColor: neutral[100],
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.min(loadPct, 100)}%`,
                        height: "100%",
                        borderRadius: radius.pill,
                        backgroundColor: barColor,
                        transition: "width .4s ease",
                      }}
                    />
                  </div>
                </div>
              );
            })()}
          </section>

          {/* skills 卡 */}
          <section data-testid="worker-detail-skills" style={cardStyle()}>
            <SectionHeader icon="❋" title="已注入技能" count={worker.capabilities?.skills?.length ?? 0} />
            {worker.capabilities && worker.capabilities.skills && worker.capabilities.skills.length > 0 ? (
              <div
                data-testid="worker-skill-list"
                style={{ display: "flex", flexWrap: "wrap", gap: space.sm }}
              >
                {worker.capabilities.skills.map((skill) => (
                  <span
                    key={skill}
                    data-testid="worker-skill-badge"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: space.xs,
                      padding: "2px 10px",
                      borderRadius: radius.pill,
                      backgroundColor: neutral[100],
                      border: `1px solid ${neutral[200]}`,
                      color: neutral[700],
                      fontSize: fontSize.sm,
                      fontWeight: 500,
                      fontFamily: fontFamily.mono,
                      whiteSpace: "nowrap",
                      ...baseFont,
                    }}
                  >
                    {skill}
                  </span>
                ))}
              </div>
            ) : (
              <SectionEmpty text="该节点暂无已注入技能" />
            )}
          </section>

          {/* tools 卡：内置 git 工具 + 自定义工具（T9 capabilities.tools 合并清单） */}
          <section data-testid="worker-detail-tools" style={cardStyle()}>
            <SectionHeader icon="✚" title="可用工具" count={worker.capabilities?.tools?.length ?? 0} />
            {worker.capabilities && worker.capabilities.tools && worker.capabilities.tools.length > 0 ? (
              <div
                data-testid="worker-tool-list"
                style={{ display: "flex", flexWrap: "wrap", gap: space.sm }}
              >
                {worker.capabilities.tools.map((tool) => (
                  <ToolBadge key={tool} name={tool} />
                ))}
              </div>
            ) : (
              <SectionEmpty text="该节点暂无可用工具" />
            )}
          </section>

          {/* MCP 状态卡：每次心跳刷新（connected/pending/disabled/failed/needs_auth 五态）；mcpStatus 为
              T9 字段，旧后端/未上报时缺省空数组（?. 防御，与列表页 WorkerItem 同源容错） */}
          <section data-testid="worker-detail-mcp" style={cardStyle()}>
            <SectionHeader icon="◈" title="MCP 服务器" count={worker.mcpStatus?.length ?? 0} />
            {(worker.mcpStatus?.length ?? 0) > 0 ? (
              <div
                data-testid="worker-mcp-list"
                style={{ display: "flex", flexDirection: "column", gap: space.sm }}
              >
                {worker.mcpStatus.map((entry) => (
                  <div
                    key={entry.serverName}
                    data-testid="worker-mcp-item"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: space.sm,
                      padding: `${space.sm}px ${space.md}px`,
                      borderRadius: radius.md,
                      backgroundColor: neutral[50],
                      border: `1px solid ${neutral[100]}`,
                    }}
                  >
                    <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[800], fontFamily: fontFamily.mono }}>
                      {entry.serverName}
                    </span>
                    <McpStatusBadge status={entry.status} />
                  </div>
                ))}
              </div>
            ) : (
              <SectionEmpty text="该节点无 MCP 服务器状态上报" />
            )}
          </section>

          {/* 可用模型卡（C8）：capabilities.models（C2 上报，注册/reload-config 后刷新）主选 +
              目录 enabled 模型兜底；显示 provider + 模型名 + defaultModelId 匹配的「默认」徽章 */}
          <section data-testid="worker-detail-models" style={cardStyle()}>
            <SectionHeader icon="◉" title="可用模型" count={modelRefs.length} />
            {modelRefs.length > 0 ? (
              <div
                data-testid="worker-model-list"
                style={{ display: "flex", flexWrap: "wrap", gap: space.sm }}
              >
                {modelRefs.map((ref) => {
                  const { providerID, modelID } = splitModelRef(ref);
                  const isDefault = worker.defaultModelId === ref;
                  const displayName = catalogByRef.get(ref) ?? modelID;
                  return (
                    <span
                      key={ref}
                      data-testid="worker-model-badge"
                      data-model-id={ref}
                      data-default={isDefault ? "true" : "false"}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: space.xs,
                        padding: "2px 10px",
                        borderRadius: radius.pill,
                        backgroundColor: isDefault ? "rgba(16,185,129,0.10)" : neutral[50],
                        border: `1px solid ${isDefault ? "rgba(16,185,129,0.28)" : neutral[200]}`,
                        whiteSpace: "nowrap",
                        ...baseFont,
                      }}
                    >
                      <span
                        style={{
                          fontSize: fontSize.sm,
                          color: isDefault ? "#059669" : neutral[500],
                          fontWeight: 500,
                        }}
                      >
                        {providerID}
                      </span>
                      <span
                        aria-hidden
                        style={{ fontSize: fontSize.sm, color: neutral[300] }}
                      >
                        /
                      </span>
                      <span
                        style={{
                          fontSize: fontSize.sm,
                          color: neutral[800],
                          fontWeight: 500,
                          fontFamily: fontFamily.mono,
                        }}
                      >
                        {displayName}
                      </span>
                      {isDefault && (
                        <span
                          data-testid="worker-model-default"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "0 6px",
                            borderRadius: radius.pill,
                            backgroundColor: "#059669",
                            color: "#FFFFFF",
                            fontSize: fontSize.xs,
                            fontWeight: 600,
                            lineHeight: "18px",
                          }}
                        >
                          默认
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            ) : (
              <SectionEmpty text="该节点未上报可用模型" />
            )}
          </section>

          {/* OmO 编排插件卡：开关 + agent 模型配置。
              放在这里而不是全局页面，因为 OmO 是**与 worker 绑定**的能力：
              插件装在镜像里、配置写在 worker workDir、开关只影响该 worker 的 serve 启动。
              镜像未内置 OmO 时该组件自身返回 null（不渲染空卡）。 */}
          <OmoPanel workerId={workerId} enabled={worker.status !== "offline"} />

          {/* opencode Agents 只读卡：与 OmO 面板平级，不受 OmO 开关影响 */}
          <OpencodeAgentsPanel workerId={workerId} />
        </div>
      )}

      {/* 一键更新二次确认（能自更新的节点；与列表页的「更新」按钮同语义） */}
      <ConfirmDialog
        testid="worker-detail-update"
        open={updateDialogOpen}
        title="更新 Worker"
        description={
          worker
            ? `确认把节点「${worker.name ?? worker.id}」更新到 ${worker.expectedVersion ?? "期望版本"}？` +
              "指令经心跳下发，worker 会在空闲时下载并重启（不打断进行中的会话）。"
            : undefined
        }
        confirmLabel="确认更新"
        pendingLabel="下发中…"
        danger={false}
        submitting={updateMutation.isPending}
        onClose={() => {
          if (!updateMutation.isPending) setUpdateDialogOpen(false);
        }}
        onConfirm={() => updateMutation.mutate()}
      />
      {updateMutation.isError && (
        <div
          role="alert"
          data-testid="worker-detail-update-error"
          style={{ fontSize: fontSize.sm, color: "#DC2626", maxWidth: 960, margin: "0 auto" }}
        >
          {isApiError(updateMutation.error) ? updateMutation.error.message : "下发更新失败，请稍后重试"}
        </div>
      )}

      {/* 手动升级命令：不能自更新的节点（Windows 缺省关闭 / 旧 worker）在这里复制命令。
          与上面的「更新」按钮互斥：能自更新的节点 upgradeHint 为 undefined，不会走到这里。 */}
      <UpgradeCommandDialog
        open={upgradeDialogOpen}
        workerLabel={worker?.name ?? worker?.id ?? workerId}
        summary={worker?.upgradeHint?.summary ?? ""}
        command={worker?.upgradeHint?.command ?? ""}
        serverBase={serverBase}
        webBase={webBase}
        loopback={loopbackOrigin}
        reason={worker?.upgradeHint?.reason}
        onClose={() => setUpgradeDialogOpen(false)}
      />
    </div>
  );
}
