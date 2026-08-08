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
 * - MCP 状态：mcpStatus 每次心跳刷新（connected/failed/needs_auth 三态徽章，对齐 skills 页
 *   mcpStatusTheme），空态提示
 * - 数据是注册+心跳快照：skills/tools 在注册/reload-config 后刷新，mcpStatus 每次心跳刷新
 * - 布局/文案/token 对齐列表页（白卡片 + neutral 色板 + 共享 ./shared.tsx 定义）
 * - 铁律（T15）：无 fixed / 100vh / 100vw，高度由 AppShell main 接管，本页 flex:1 + overflowY auto
 */
import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
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
  type WorkerDetail,
} from "../shared";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 子组件 ------------------------------ */

/** MCP 服务器状态徽章（三态：已连接/连接失败/待授权，对齐 skills 页 mcpStatusTheme）。 */
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
        backgroundColor: builtin ? "#EFF6FF" : "#F5F3FF",
        border: `1px solid ${builtin ? "#BFDBFE" : "#DDD6FE"}`,
        color: builtin ? "#2563EB" : "#7C3AED",
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

/* ------------------------------ 页面主组件（AppShell 内容区） ------------------------------ */

export default function WorkerDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const token = useAuthStore((s) => s.token);
  const workerId = params.id;

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
        padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`,
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
          marginBottom: space.lg,
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
            backgroundColor: "#FFFFFF",
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
          style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0`, ...baseFont }}
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
            borderRadius: radius.lg,
            backgroundColor: "#FFFFFF",
            border: `1px solid ${neutral[200]}`,
            ...baseFont,
          }}
        >
          <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
            {isApiError(error) ? error.message : "加载 Worker 详情失败"}
          </div>
          <button
            type="button"
            data-testid="worker-detail-retry"
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
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.lg,
            maxWidth: 960,
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
              <WorkerStatusBadge status={worker.status} />
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

          {/* opencode 信息卡 */}
          <section data-testid="worker-detail-runtime" style={cardStyle()}>
            <SectionHeader icon="⬢" title="opencode 运行时" />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: space.md,
              }}
            >
              <InfoRow label="版本" value={worker.opencodeVersion} />
              <InfoRow
                label="serve 端口"
                value={worker.capabilities.port !== undefined ? String(worker.capabilities.port) : "未上报"}
              />
              <InfoRow label="baseUrl" value={worker.capabilities.baseUrl ?? "未上报"} />
              <InfoRow label="并发上限" value={`${worker.capabilities.maxInstances ?? 0} 并发`} />
            </div>
          </section>

          {/* 负载卡：实例数 + 占用率进度条（对齐列表页 load 语义） */}
          <section data-testid="worker-detail-load" style={cardStyle()}>
            <SectionHeader icon="▤" title="负载" />
            {(() => {
              const maxInstances = worker.capabilities.maxInstances ?? 0;
              const instances = worker.load?.instances ?? 0;
              const loadPct = maxInstances > 0 ? Math.round((instances / maxInstances) * 100) : 0;
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>
                      当前活跃会话 · <span style={{ fontWeight: 600, color: neutral[800] }}>{instances}</span> 个
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
              );
            })()}
          </section>

          {/* skills 卡 */}
          <section data-testid="worker-detail-skills" style={cardStyle()}>
            <SectionHeader icon="❋" title="已注入技能" count={worker.capabilities.skills?.length ?? 0} />
            {worker.capabilities.skills && worker.capabilities.skills.length > 0 ? (
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
            <SectionHeader icon="✚" title="可用工具" count={worker.capabilities.tools?.length ?? 0} />
            {worker.capabilities.tools && worker.capabilities.tools.length > 0 ? (
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

          {/* MCP 状态卡：每次心跳刷新（connected/failed/needs_auth 三态）；mcpStatus 为
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
        </div>
      )}
    </div>
  );
}
