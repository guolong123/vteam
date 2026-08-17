"use client";

/**
 * Worker 节点列表页（Phase 4 T13：worker-list 原型保真迁移 + 接 GET /workers）
 * =====================================================
 * 保真迁移自 docs/agent-platform/prototypes/worker-list/index.tsx（07 篇 11.2 / 11.4）。
 * 导航由 AppShell（app/(main)/layout.tsx）提供（NavTopBar + NavDock + CmdKPanel），本页仅渲染内容区。
 *
 * - 数据源（T7 已完成）：GET /workers → WorkerItem[]（id/name/opencodeVersion/
 *   capabilities{maxInstances,skills[],tools[]}/load{instances}/status/lastHeartbeatAt/registeredAt）。
 * - 状态映射：后端 online/offline/degraded → 原型三态 在线/离线/维护中（workerStatusTheme 逐 token 迁移）。
 * - 负载条：后端无 CPU 上报 → 以 load.instances / maxInstances 实例占用率驱动进度条
 *   （对齐原型 cpuColor 档位：≥75 红 / ≥50 琥珀 / 低绿），这是 load 字段的真实语义。
 * - 版本徽章 isV2：opencodeVersion 以 v2/2. 开头 → 紫色 V2Runtime 标注（对齐原型 v2.0.0-beta.1）。
 * - 实时性：worker.heartbeat SSE 需 T9 事件回流（未实现，server 当前不 emit）→ 轮询 10s
 *   （与心跳周期同频，refetchInterval）+ 1s tick 重算相对心跳时间。
 * - 安装入口（单一）：「安装 Worker」Link → /workers/install（独立安装向导页）——后端无新增
 *   端点，注册由 worker 进程 outbound 完成（"注册即入池"架构）。
 * - 操作按钮（查看详情/重启/下线）：查看详情已接线 → /workers/:id（T10 详情页）；
 *   重启/下线（UX-01）：后端新增 POST /workers/:id/restart、POST /workers/:id/shutdown
 *   ——worker 独立进程/容器，命令经心跳下行（T4a），重启由 worker 侧 RestartCoordinator
 *   执行、下线为立即标 offline + worker 优雅退出。按钮按 workers.edit 权限可用，
 *   offline 节点禁用（命令无心跳可取），busy 态显示进行中 + 页级错误条反馈。
 * - data-testid 与原型一致：worker-list-root/worker-stats/worker-card/
 *   worker-status/worker-version/worker-capability/worker-load/worker-heartbeat/
 *   worker-actions/worker-detail-button/worker-restart-button/worker-offline-button/
 *   worker-pool-hint；安装入口为 install-worker-link。
 * - 状态主题/数据模型/状态徽章等共享定义见 ./shared.tsx（与详情页共用，防漂移）。
 */
import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { hasPermission } from "@/lib/permissions";
import { useAuthStore } from "@/lib/stores/authStore";
import { ConfirmDialog, EmptyState } from "@/src/components/ui";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";
import {
  WORKER_STATUS_LABEL,
  workerStatusTheme,
  loadColor,
  pulseCss,
  formatRelativeTime,
  WorkerStatusBadge,
  type WorkerItem,
} from "./shared";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 轮询周期（ms）：与 worker 心跳周期（10s）同频，server 30s 判离线前可捕捉状态翻转。 */
const POLL_INTERVAL_MS = 10_000;

/* ------------------------------ 子组件 ------------------------------ */

/** Worker 卡片：对齐 07 篇 11.2 注册字段 + 11.4 生命周期操作（原型 :207-456） */
function WorkerCard({
  worker,
  now,
  canEdit,
  canDelete,
  busy,
  onRestart,
  onShutdown,
  onDelete,
  onSetDefault,
}: {
  worker: WorkerItem;
  now: number;
  /** workers.edit 权限（对齐后端 PermissionGuard；false 时操作按钮禁用 + 提示） */
  canEdit: boolean;
  /** workers.delete 权限（仅 offline 行显示删除入口） */
  canDelete: boolean;
  /** 当前进行中的操作（同一卡片任一操作 busy 时全部按钮禁用防并发） */
  busy: { workerId: string; action: "restart" | "shutdown" | "delete" | "set-default" } | null;
  onRestart: (id: string) => void;
  onShutdown: (id: string) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
}) {
  const router = useRouter();
  const label = WORKER_STATUS_LABEL[worker.status];
  const theme = workerStatusTheme[label];
  const isOnline = worker.status === "online";
  const isOffline = worker.status === "offline";

  /* 能力声明（11.2）：并发上限 + skill/tool 数量 */
  const maxInstances = worker.capabilities.maxInstances ?? 0;
  const skillCount = worker.capabilities.skills?.length ?? 0;
  const toolCount = worker.capabilities.tools?.length ?? 0;

  /* 负载（11.2）：实例占用率驱动进度条（后端无 CPU 上报，取 load 真实语义） */
  const instances = worker.load?.instances ?? 0;
  const loadPct = maxInstances > 0 ? Math.round((instances / maxInstances) * 100) : 0;

  /* v2 标识：版本号 v2.x / 2.x 开头（对齐原型 v2.0.0-beta.1 → V2Runtime） */
  const isV2 = /^v?2\./.test(worker.opencodeVersion);

  /* UX-01 操作可用性：workers.edit 权限 + 非 offline（命令需心跳下发）+ 非 busy */
  const isBusy = busy?.workerId === worker.id;
  const restartBusy = isBusy && busy?.action === "restart";
  const shutdownBusy = isBusy && busy?.action === "shutdown";
  const deleteBusy = isBusy && busy?.action === "delete";
  const setDefaultBusy = isBusy && busy?.action === "set-default";
  const opsDisabled = !canEdit || isOffline || isBusy;
  const opsTitle = !canEdit
    ? "无 workers.edit 权限"
    : isOffline
      ? "节点已离线，命令无法经心跳下发"
      : isBusy
        ? "操作进行中…"
        : "重启节点：经心跳命令下发，无活跃会话立即重启 serve";

  const card: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: `${space.xl}px`,
    borderRadius: radius.lg,
    backgroundColor: "#FFFFFF",
    /* 原型笔误修正：`theme.status` 不存在恒取 theme.border；按意图离线卡片用灰边框淡化 */
    border: `1px solid ${worker.status === "offline" ? neutral[200] : theme.border}`,
    boxShadow: isOnline ? shadow.md : shadow.sm,
    opacity: isOnline ? 1 : 0.86,
    ...baseFont,
  };

  return (
    <section
      data-testid="worker-card"
      data-worker-id={worker.id}
      data-status={label}
      style={card}
    >
      {/* 头部：workerId（mono）+ 状态徽章 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              flexShrink: 0,
              backgroundColor: theme.color,
              color: theme.color,
              animation: isOnline ? "workerpulse-blink 2s ease-in-out infinite" : undefined,
            }}
          />
          <span
            style={{
              fontSize: fontSize.lg,
              fontWeight: 600,
              color: neutral[900],
              fontFamily: fontFamily.mono,
              letterSpacing: "-0.02em",
            }}
          >
            {worker.id}
          </span>
        </div>
        <WorkerStatusBadge status={worker.status} />
        {worker.isDefault && (
          <span
            data-testid="worker-default-badge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              fontSize: fontSize.xs,
              fontWeight: 600,
              color: "#92400E",
              backgroundColor: "#FEF3C7",
              padding: "2px 8px",
              borderRadius: radius.pill,
              lineHeight: 1.4,
            }}
          >
            默认
          </span>
        )}
      </div>

      {/* 版本 + 节点名称（后端无 address 字段 → 展示注册名 name，缺省 hostname 语义） */}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <span
          data-testid="worker-version"
          data-v2={isV2 ? "true" : "false"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            fontSize: fontSize.sm,
            fontWeight: 600,
            color: isV2 ? "#7C3AED" : neutral[600],
            backgroundColor: isV2 ? "#F5F3FF" : neutral[100],
            border: `1px solid ${isV2 ? "#DDD6FE" : neutral[200]}`,
            padding: "2px 8px",
            borderRadius: radius.pill,
            fontFamily: fontFamily.mono,
          }}
        >
          {isV2 && <span aria-hidden style={{ fontSize: fontSize.xs }}>⬢</span>}
          {worker.opencodeVersion}
          {isV2 && (
            <span aria-hidden style={{ fontWeight: 400, opacity: 0.7 }}>· V2Runtime</span>
          )}
        </span>
        <span style={{ fontSize: fontSize.sm, color: neutral[400], fontFamily: fontFamily.mono }}>
          {worker.name ?? "未命名节点"}
        </span>
      </div>

      {/* 能力声明：并发上限 + skill/tool 数量（11.2 能力声明） */}
      <div data-testid="worker-capability" style={{ display: "flex", gap: space.md }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[100]}`,
          }}
        >
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>并发上限</span>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
            {maxInstances}
            <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[400], marginLeft: 2 }}>并发</span>
          </span>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[100]}`,
          }}
        >
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>可用能力</span>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
            {skillCount}
            <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[400], marginLeft: 2 }}>skill</span>
            <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[300], margin: "0 4px" }}>·</span>
            {toolCount}
            <span style={{ fontSize: fontSize.xs, fontWeight: 400, color: neutral[400], marginLeft: 2 }}>tool</span>
          </span>
        </div>
      </div>

      {/* 负载：实例数 + 占用率进度条（11.2 负载上报） */}
      <div data-testid="worker-load" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>
            负载 · <span style={{ fontWeight: 600, color: neutral[800] }}>{instances}</span> 个实例
          </span>
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: loadColor(loadPct) }}>
            占用 {loadPct}%
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
              width: `${loadPct}%`,
              height: "100%",
              borderRadius: radius.pill,
              backgroundColor: loadColor(loadPct),
              transition: "width .4s ease",
            }}
          />
        </div>
      </div>

      {/* 心跳时间（11.4 心跳检测）：在线脉冲指示 */}
      <div
        data-testid="worker-heartbeat"
        data-online={isOnline ? "true" : "false"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.xs,
          fontSize: fontSize.sm,
          color: isOnline ? neutral[500] : neutral[400],
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            backgroundColor: isOnline ? "#10B981" : "#CBD5E1",
            color: "#10B981",
            animation: isOnline ? "workerpulse-ring 1.8s ease-out infinite" : undefined,
          }}
        />
        上次心跳 {formatRelativeTime(worker.lastHeartbeatAt, now)}
        <span style={{ marginLeft: "auto", color: neutral[300] }}>♥ {isOnline ? "活跃" : "失联"}</span>
      </div>

      {/* 操作：查看详情（→ /workers/:id）/ 重启 / 下线（UX-01 真实调用，workers.edit 权限） */}
      <div
        data-testid="worker-actions"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          borderTop: `1px solid ${neutral[100]}`,
          paddingTop: space.md,
        }}
      >
        <button
          type="button"
          data-testid="worker-detail-button"
          data-worker-id={worker.id}
          onClick={() => router.push(`/workers/${worker.id}`)}
          style={{
            flex: 1,
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "#FFFFFF",
            color: neutral[700],
            fontSize: fontSize.md,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          查看详情
        </button>
        <button
          type="button"
          data-testid="worker-restart-button"
          data-worker-id={worker.id}
          disabled={opsDisabled}
          title={opsTitle}
          onClick={() => onRestart(worker.id)}
          style={{
            flex: 1,
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${opsDisabled ? neutral[100] : neutral[200]}`,
            backgroundColor: opsDisabled ? neutral[100] : "#FFFFFF",
            color: opsDisabled ? neutral[400] : neutral[700],
            fontSize: fontSize.md,
            cursor: opsDisabled ? "not-allowed" : "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          {restartBusy ? "重启中…" : "重启"}
        </button>
        <button
          type="button"
          data-testid="worker-offline-button"
          data-worker-id={worker.id}
          disabled={opsDisabled}
          title={opsTitle}
          onClick={() => onShutdown(worker.id)}
          style={{
            flex: 1,
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${opsDisabled ? "transparent" : "#FECACA"}`,
            backgroundColor: opsDisabled ? neutral[100] : "#FEF2F2",
            color: opsDisabled ? neutral[400] : "#DC2626",
            fontSize: fontSize.md,
            cursor: opsDisabled ? "not-allowed" : "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          {shutdownBusy ? "下线中…" : "下线"}
        </button>
        {/* 删除入口：仅 offline 显示（online 节点后端 409 拒绝，前端直接不暴露） */}
        {isOffline && (
          <button
            type="button"
            data-testid="worker-delete-button"
            data-worker-id={worker.id}
            disabled={!canDelete || isBusy}
            title={
              !canDelete
                ? "无 workers.delete 权限"
                : isBusy
                  ? "操作进行中…"
                  : "删除离线节点：清理其全部关联数据（不可恢复）"
            }
            onClick={() => onDelete(worker.id)}
            style={{
              flex: 1,
              padding: `${space.sm - 1}px ${space.md}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: !canDelete || isBusy ? neutral[100] : "#DC2626",
              color: !canDelete || isBusy ? neutral[400] : "#FFFFFF",
              fontSize: fontSize.md,
              cursor: !canDelete || isBusy ? "not-allowed" : "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            {deleteBusy ? "删除中…" : "删除"}
          </button>
        )}
        <button
          type="button"
          data-testid="worker-set-default-button"
          data-worker-id={worker.id}
          disabled={opsDisabled || worker.isDefault}
          title={
            !canEdit
              ? "无 workers.edit 权限"
              : isBusy
                ? "操作进行中…"
                : worker.isDefault
                  ? "已是默认节点"
                  : "设为默认节点：所有候选均不满足时以此节点兜底"
          }
          onClick={() => onSetDefault(worker.id)}
          style={{
            flex: 1,
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px solid ${opsDisabled || worker.isDefault ? neutral[100] : "#FEF3C7"}`,
            backgroundColor: opsDisabled || worker.isDefault ? neutral[100] : "#FEF3C7",
            color: opsDisabled || worker.isDefault ? neutral[400] : "#92400E",
            fontSize: fontSize.md,
            cursor: opsDisabled || worker.isDefault ? "not-allowed" : "pointer",
            fontFamily: fontFamily.body,
            opacity: opsDisabled ? 0.5 : 1,
          }}
        >
          {setDefaultBusy ? "设置中…" : worker.isDefault ? "已默认" : "设为默认"}
        </button>
      </div>
    </section>
  );
}

/* ------------------------------ 页面主组件（AppShell 内容区） ------------------------------ */

export default function WorkersPage() {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  /* 1s tick：驱动各卡片相对心跳时间重算（数据本身由轮询刷新） */
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["workers"],
    queryFn: () => api.get<WorkerItem[]>("/workers"),
    enabled: !!token,
    /* 实时性：worker.heartbeat SSE 需 T9 事件回流（未实现）→ 轮询与心跳周期同频 */
    refetchInterval: POLL_INTERVAL_MS,
  });

  /* UX-01：重启/下线操作权限（对齐后端 PermissionGuard workers.edit） */
  const canEditWorker = hasPermission(user?.permissions, "workers", "edit");
  /* 删除权限（对齐后端 PermissionGuard workers.delete；admin all:true 放行） */
  const canDeleteWorker = hasPermission(user?.permissions, "workers", "delete");

  /* 操作中的 worker（防并发：同一卡片任一操作 busy 时全部按钮均禁用） */
  const [busyWorker, setBusyWorker] = useState<{
    workerId: string;
    action: "restart" | "shutdown" | "delete" | "set-default";
  } | null>(null);
  /* 删除二次确认目标（null = 弹窗关闭） */
  const [deleteTarget, setDeleteTarget] = useState<WorkerItem | null>(null);
  /* 操作错误提示（页级，3s 自动消失，对齐 skills 页 notice 模式） */
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 3000);
    return () => clearTimeout(timer);
  }, [actionError]);

  /* 重启：POST /workers/:id/restart → 命令经心跳下发，worker 侧重启 serve */
  const restartMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<{ workerId: string; queued: boolean }>(`/workers/${id}/restart`),
    onMutate: (id) => setBusyWorker({ workerId: id, action: "restart" }),
    onSuccess: () => {
      setBusyWorker(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["workers"] });
    },
    onError: (err) => {
      setBusyWorker(null);
      setActionError(isApiError(err) ? err.message : "重启失败，请稍后重试");
    },
  });

  /* 下线：POST /workers/:id/shutdown → 立即标 offline + 心跳命令触发 worker 退出 */
  const shutdownMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<{ workerId: string; queued: boolean }>(`/workers/${id}/shutdown`),
    onMutate: (id) => setBusyWorker({ workerId: id, action: "shutdown" }),
    onSuccess: () => {
      setBusyWorker(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["workers"] });
    },
    onError: (err) => {
      setBusyWorker(null);
      setActionError(isApiError(err) ? err.message : "下线失败，请稍后重试");
    },
  });

  /* 删除：DELETE /workers/:id（仅 offline；后端 409 拒绝 online/degraded）
     → ConfirmDialog 确认后执行 → 刷新列表；失败走页级错误条 */
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete<{ id: string; deleted: boolean }>(`/workers/${id}`),
    onMutate: (id) => setBusyWorker({ workerId: id, action: "delete" }),
    onSuccess: () => {
      setBusyWorker(null);
      setDeleteTarget(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["workers"] });
    },
    onError: (err) => {
      setBusyWorker(null);
      setDeleteTarget(null);
      setActionError(isApiError(err) ? err.message : "删除失败，请稍后重试");
    },
  });

  /* 设为默认：PATCH /workers/:id {isDefault:true} → 全局唯一（后端自动取消其他）→ 刷新 */
  const setDefaultMutation = useMutation({
    mutationFn: (id: string) =>
      api.patch<WorkerItem>(`/workers/${id}`, { isDefault: true }),
    onMutate: (id) => setBusyWorker({ workerId: id, action: "set-default" }),
    onSuccess: () => {
      setBusyWorker(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["workers"] });
    },
    onError: (err) => {
      setBusyWorker(null);
      setActionError(isApiError(err) ? err.message : "设为默认失败，请稍后重试");
    },
  });

  const items = data ?? [];

  const onlineCount = items.filter((w) => w.status === "online").length;
  const offlineCount = items.filter((w) => w.status === "offline").length;
  const degradedCount = items.filter((w) => w.status === "degraded").length;

  /* 统计条（对齐原型 4 卡；在线卡带脉冲动画） */
  const stats = [
    { label: "在线节点", value: onlineCount, theme: workerStatusTheme["在线"], pulse: true },
    { label: "离线节点", value: offlineCount, theme: workerStatusTheme["离线"], pulse: false },
    { label: "维护中", value: degradedCount, theme: workerStatusTheme["维护中"], pulse: false },
    { label: "节点总数", value: items.length, theme: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" }, pulse: false },
  ];

  return (
    <div
      data-testid="worker-list-root"
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`,
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
      }}
    >
      <style>{pulseCss}</style>

      {/* 状态统计条（11.2：控制面可见在线节点列表） */}
      <div
        data-testid="worker-stats"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: space.md,
          marginBottom: space.xl,
        }}
      >
        {stats.map((s) => (
          <div
            key={s.label}
            data-stat={s.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.md,
              padding: `${space.lg}px ${space.xl}px`,
              borderRadius: radius.lg,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.sm,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                flexShrink: 0,
                backgroundColor: s.theme.color,
                color: s.theme.color,
                animation: s.pulse ? "workerpulse-ring 1.8s ease-out infinite" : undefined,
              }}
            />
            <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>{s.label}</span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: fontSize.xxl,
                fontWeight: 700,
                color: s.theme.color,
                lineHeight: 1,
              }}
            >
              {s.value}
            </span>
          </div>
        ))}
      </div>

      {/* UX-01：重启/下线操作错误条（页级，role=alert + 关闭按钮，3s 自动消失） */}
      {actionError && (
        <div
          data-testid="worker-action-error"
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            marginBottom: space.lg,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: "#FEF2F2",
            border: `1px solid #FECACA`,
            color: "#DC2626",
            fontSize: fontSize.sm,
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden style={{ flexShrink: 0 }}>⚠</span>
          <span style={{ flex: 1, minWidth: 0 }}>{actionError}</span>
          <button
            type="button"
            data-testid="worker-action-error-dismiss"
            aria-label="关闭提示"
            onClick={() => setActionError(null)}
            style={{
              flexShrink: 0,
              border: "none",
              background: "transparent",
              color: neutral[400],
              fontSize: fontSize.sm,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* 操作行：唯一入口「安装 Worker」→ /workers/install（11.4 水平扩容：新 worker 注册即入池） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: space.lg,
        }}
      >
        <div>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
            Worker 节点池
          </div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
            {items.length} 个节点 · 在线 {onlineCount} 个 · 新节点注册即自动入池
          </div>
        </div>
        <Link
          href="/workers/install"
          data-testid="install-worker-link"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm + 2}px ${space.lg}px`,
            borderRadius: radius.pill,
            border: `1px solid ${neutral[300]}`,
            backgroundColor: "#FFFFFF",
            color: neutral[700],
            fontSize: fontSize.md,
            fontWeight: 500,
            textDecoration: "none",
            boxShadow: shadow.sm,
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>⌥</span>
          安装 Worker
        </Link>
      </div>

      {/* Worker 卡片网格 / 空状态 */}
      {isPending ? (
        <div
          data-testid="workers-loading"
          style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}
        >
          加载中…
        </div>
      ) : isError ? (
        <div
          data-testid="workers-error"
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: space.md,
            padding: `${space.xxl}px`,
            textAlign: "center",
            borderRadius: radius.lg,
            backgroundColor: "#FFFFFF",
            border: `1px solid ${neutral[200]}`,
          }}
        >
          <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
            {isApiError(error) ? error.message : "加载 Worker 列表失败"}
          </div>
          <button
            type="button"
            data-testid="workers-retry"
            onClick={() => refetch()}
            style={{
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
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
        <EmptyState
          title="暂无 Worker 节点"
          description="点击右上角「安装 Worker」获取一键部署命令，节点注册即自动入池"
          icon={<span aria-hidden>⚙</span>}
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: space.lg,
          }}
        >
          {items.map((w) => (
            <WorkerCard
              key={w.id}
              worker={w}
              now={now}
              canEdit={canEditWorker}
              canDelete={canDeleteWorker}
              busy={busyWorker}
              onRestart={(id) => restartMutation.mutate(id)}
              onShutdown={(id) => shutdownMutation.mutate(id)}
              onDelete={(id) => {
                const target = items.find((x) => x.id === id);
                if (target) setDeleteTarget(target);
              }}
              onSetDefault={(id) => setDefaultMutation.mutate(id)}
            />
          ))}
        </div>
      )}

      {/* 底部说明（11.4：心跳超时标记离线，其上任务组进入待重调度） */}
      <div
        data-testid="worker-pool-hint"
        style={{
          marginTop: space.xl,
          padding: `${space.md}px ${space.lg}px`,
          borderRadius: radius.md,
          backgroundColor: "#FFFFFF",
          border: `1px dashed ${neutral[200]}`,
          fontSize: fontSize.sm,
          color: neutral[400],
          lineHeight: 1.7,
          ...baseFont,
        }}
      >
        <span style={{ fontWeight: 600, color: neutral[500] }}>生命周期提示</span> ·
        心跳超时（连续 30 秒 = 3 个心跳周期未上报）自动标记离线，其上的任务组按亲和与负载策略
        迁移到存活节点；新增节点无需重启控制面，注册即入池（水平扩容）。
      </div>

      {/* 删除离线 worker 二次确认（复用 ConfirmDialog，对齐 agents 页删除确认模式） */}
      <ConfirmDialog
        testid="worker-delete"
        open={deleteTarget !== null}
        title="删除 Worker"
        description={
          deleteTarget
            ? `确定删除离线节点「${deleteTarget.name ?? deleteTarget.id}」？删除后不可恢复，其模型可用性、会话实例与 worker 绑定数据将一并清理。`
            : undefined
        }
        confirmLabel="确认删除"
        pendingLabel="删除中…"
        submitting={deleteMutation.isPending}
        onClose={() => {
          if (!deleteMutation.isPending) setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}
