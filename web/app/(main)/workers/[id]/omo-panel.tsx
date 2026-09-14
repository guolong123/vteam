"use client";

/**
 * OmO 面板（worker 详情页内的一张卡）
 * =============================================
 * OmO（oh-my-openagent）是**与 worker 绑定**的能力：插件装在 worker 镜像里，
 * 配置写在 worker 的 workDir 下，开关也只影响该 worker 的 serve 启动参数。
 * 所以它不应该是全局页面，而应放在 worker 详情里（用户诉求）。
 *
 * 三段式结构（先看懂现状，再动手改）：
 *   1. 总开关 —— 关掉 = serve 以 --pure 启动、不加载插件（省 token）；
 *   2. 概览 —— 当前生效配置/已配数量/重启结果，一眼看清"改的东西生不生效"；
 *   3. Agent 模型表 —— 每个 agent 一行，配了覆盖的才高亮，未配的显示 OmO 默认。
 *
 * 关键交互约束：
 * - **镜像未内置 OmO 时不展示本卡**（bundled=false）——没有插件，开关与配置都无意义；
 * - 开关只控制插件是否加载（关 = serve 以 --pure 启动），配置表始终可见、可编辑，
 *   关闭时仅提示回退语义，配置不丢，重新打开即恢复；
 * - 保存后自动重启 serve，结果（executed/pending/skipped）在概览区明示，
 *   避免用户以为"保存了却没生效"。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";
import { cardStyle, SectionHeader } from "../shared";

const accent = "#0D9488";

/** 空态提示（与详情页其他区块同款：灰虚线框）。 */
function SectionEmpty({ text }: { text: string }) {
  return (
    <div
      data-testid="omo-section-empty"
      style={{
        padding: `${space.lg}px`,
        borderRadius: radius.md,
        border: `1px dashed ${neutral[200]}`,
        backgroundColor: neutral[50],
        fontSize: fontSize.sm,
        color: neutral[400],
        textAlign: "center",
        fontFamily: fontFamily.body,
      }}
    >
      {text}
    </div>
  );
}

/** GET /agents/omo-config 响应。 */
interface OmoConfigResponse {
  agents: Record<string, string>;
  available: string[];
  workerId: string | null;
  degraded: boolean;
  configPath?: string;
  configKind?: "new" | "legacy" | "none";
  enabled?: boolean;
  bundled?: boolean;
  /** 已注册到 serve 的 agent 基底名（未含者当前模型下不会激活）。 */
  registered?: string[];
  /** agent 元数据：描述/mode/native。 */
  runtime?: Record<string, { description?: string; mode?: string; native?: boolean }>;
}

interface ModelOption {
  /** 模型目录主键（md_）——不是 OmO 需要的标识，勿直接当 value。 */
  id: string;
  providerID: string;
  modelID: string;
}

/**
 * agent 分组（仅用于可读性）。
 * 未列出的（OmO 未来新增）会归入"其他"，不会因为这张表而无法配置。
 */
const AGENT_GROUPS: Array<{ title: string; hint: string; names: string[] }> = [
  {
    title: "主 Agent",
    hint: "可作为会话主 agent（在对话框中直接选择）",
    names: ["sisyphus", "prometheus", "atlas", "hephaestus", "sisyphus-junior"],
  },
  {
    title: "专家 Agent",
    hint: "由主 agent 按需派生的只读/专项角色",
    names: ["oracle", "librarian", "explore", "multimodal-looker", "metis", "momus"],
  },
  {
    title: "opencode 原生",
    hint: "opencode 自带 agent（OmO 只覆盖其模型）",
    names: ["build", "plan", "OpenCode-Builder"],
  },
];

const RESTART_HINT: Record<string, string> = {
  executed: "已重启 serve，下个会话生效",
  pending: "有会话进行中，重启已排队",
  skipped: "未重启 serve，下次重启后生效",
};

export function OmoPanel({ workerId, enabled }: { workerId: string; enabled: boolean }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [restartHint, setRestartHint] = useState<string | null>(null);
  /** 正在查看提示词的 agent 名（null=关闭弹窗）。 */
  const [promptAgent, setPromptAgent] = useState<string | null>(null);

  const configQuery = useQuery({
    queryKey: ["omo-config", workerId],
    queryFn: () =>
      api.get<OmoConfigResponse>("/agents/omo-config", { query: { workerId } }),
    // worker 可能离线；这里失败由 degraded 承载，不重试打扰
    retry: false,
  });

  const modelsQuery = useQuery({
    queryKey: ["models", "omo-options"],
    queryFn: () =>
      api.get<{ items: ModelOption[] }>("/models", {
        query: { enabled: "true", pageSize: 500 },
      }),
    enabled,
    staleTime: 60_000,
  });

  const config = configQuery.data;

  const saveMutation = useMutation({
    mutationFn: (payload: { agents?: Record<string, string>; enabled?: boolean }) => {
      const qs = `?workerId=${encodeURIComponent(workerId)}`;
      return api.patch<{ restart?: string }>(`/agents/omo-config${qs}`, {
        agents: payload.agents ?? {},
        ...(payload.enabled === undefined ? {} : { enabled: payload.enabled }),
      });
    },
    onSuccess: (data) => {
      setError(null);
      setDraft({});
      const r = (data as { restart?: string })?.restart;
      setRestartHint(r ? (RESTART_HINT[r] ?? null) : null);
      void queryClient.invalidateQueries({ queryKey: ["omo-config", workerId] });
    },
    onError: (err: unknown) => {
      setError(isApiError(err) ? err.message : "保存失败，请稍后重试");
    },
  });

  /** 当前生效值 = 服务端值叠加本地草稿。 */
  const effective = useMemo(
    () => ({ ...(config?.agents ?? {}), ...draft }),
    [config?.agents, draft],
  );
  /**
   * 模型选项必须是 providerID/modelID。
   * ⚠️ 不能用 /models 的 id（那是 md_ 主键），写进 OmO 配置无法解析（实测踩坑）。
   */
  const modelOptions = useMemo(() => {
    const items = modelsQuery.data?.items ?? [];
    const ids = items
      .filter((m) => m?.providerID && m?.modelID)
      .map((m) => `${m.providerID}/${m.modelID}`);
    return Array.from(new Set(ids)).sort();
  }, [modelsQuery.data]);

  const enabledNow = config?.enabled ?? true;
  const dirtyCount = Object.keys(draft).length;
  const configuredCount = Object.values(config?.agents ?? {}).filter(Boolean).length;

  function setAgentModel(name: string, value: string): void {
    const serverValue = config?.agents?.[name] ?? "";
    setDraft((prev) => {
      const next = { ...prev };
      if (value === serverValue) delete next[name];
      else next[name] = value;
      return next;
    });
  }

  // 镜像未内置 OmO：不展示本卡（开关与配置都无意义）
  if (config?.bundled === false) {
    return null;
  }

  return (
    <section data-testid="worker-detail-omo" style={cardStyle()}>
      <SectionHeader
        icon="✦"
        title="OmO 编排插件"
        count={configuredCount > 0 ? configuredCount : undefined}
        right={
          <Toggle
            on={enabledNow}
            disabled={saveMutation.isPending}
            onChange={(next) => {
              // 关掉时不提交草稿（配置保留，重开即恢复）
              setRestartHint(null);
              saveMutation.mutate({ enabled: next });
            }}
            testId="omo-toggle"
          />
        }
      />

      {/* 概览行：开关状态 + 生效文件 + 保存反馈 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          flexWrap: "wrap",
          fontSize: fontSize.xs,
          color: neutral[500],
        }}
      >
        <span
          data-testid="omo-status"
          style={{
            padding: "1px 8px",
            borderRadius: radius.pill,
            border: `1px solid ${enabledNow ? "rgba(16,185,129,0.35)" : neutral[200]}`,
            backgroundColor: enabledNow ? "rgba(16,185,129,0.10)" : neutral[100],
            color: enabledNow ? "#059669" : neutral[500],
            fontWeight: 600,
          }}
        >
          {enabledNow ? "已开启" : "已关闭"}
        </span>
        {config?.configPath && (
          <span
            data-testid="omo-config-path"
            title="OmO 优先读取 .omo/omo.jsonc；不存在时才用 .opencode/oh-my-openagent.jsonc。本面板始终读写实际生效的那份。"
            style={{
              fontFamily: fontFamily.mono,
              color: config.configKind === "legacy" ? "#B45309" : neutral[500],
            }}
          >
            {config.configPath}
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0 }} />
        {restartHint && !dirtyCount && (
          <span data-testid="omo-restart-hint" style={{ color: "#059669" }}>
            {restartHint}
          </span>
        )}
        {dirtyCount > 0 && (
          <span data-testid="omo-dirty" style={{ color: "#B45309", fontWeight: 600 }}>
            {dirtyCount} 项待保存
          </span>
        )}
        {(dirtyCount > 0 || configQuery.isFetching) && (
          <button
            type="button"
            data-testid="omo-save"
            disabled={!dirtyCount || saveMutation.isPending}
            onClick={() => saveMutation.mutate({ agents: draft })}
            style={btn(true, !dirtyCount || saveMutation.isPending)}
          >
            {saveMutation.isPending ? "保存中…" : "保存"}
          </button>
        )}
        {dirtyCount > 0 && (
          <button
            type="button"
            data-testid="omo-reset"
            disabled={saveMutation.isPending}
            onClick={() => {
              setDraft({});
              setError(null);
            }}
            style={btn(false, saveMutation.isPending)}
          >
            重置
          </button>
        )}
      </div>

      {error && (
        <div
          data-testid="omo-error"
          style={{
            padding: `${space.sm}px ${space.md}px`,
            fontSize: fontSize.xs,
            color: "#B91C1C",
            backgroundColor: "rgba(220,38,38,0.08)",
            border: "1px solid rgba(220,38,38,0.20)",
            borderRadius: radius.md,
          }}
        >
          {error}
        </div>
      )}

      {!enabledNow && (
        <div
          data-testid="omo-disabled-hint"
          style={{
            padding: `${space.md}px`,
            borderRadius: radius.md,
            border: `1px dashed ${neutral[200]}`,
            backgroundColor: neutral[50],
            fontSize: fontSize.xs,
            color: neutral[500],
            lineHeight: 1.7,
          }}
        >
          已关闭：serve 启动时不加载 OmO 插件（等价 <code>--pure</code>），
          agent 列表只保留 opencode 原生 agent，可省去插件带来的上下文开销。
          {configuredCount > 0 && <> 已有 {configuredCount} 项模型配置保留，重新开启即恢复。</>}
        </div>
      )}

      {configQuery.isPending && <SectionEmpty text="加载中…" />}

      {config?.degraded && (
        <SectionEmpty text="暂不可用（worker 离线或未安装 OmO 插件）" />
      )}

      {!config?.degraded && config && (
        <>
          {/* 折叠开关：关掉时配置仍保留在服务端，这里只是不占版面 */}
          <button
            type="button"
            data-testid="omo-expand"
            onClick={() => setExpanded((v) => !v)}
            style={{
              alignSelf: "flex-start",
              display: "flex",
              alignItems: "center",
              gap: space.xs,
              padding: 0,
              border: "none",
              background: "none",
              color: accent,
              fontSize: fontSize.sm,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            <span aria-hidden style={{ fontSize: 10 }}>
              {expanded ? "▼" : "▶"}
            </span>
            {expanded ? "收起模型配置" : `配置 agent 模型${configuredCount > 0 ? `（已配 ${configuredCount}）` : ""}`}
          </button>

          {expanded && (
            <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
              {modelOptions.length === 0 && (
                <div style={{ fontSize: fontSize.xs, color: "#B45309" }}>
                  未取到可用模型目录，下拉仅显示当前值（请先在「模型管理」启用模型）
                </div>
              )}
              <AgentCards
                available={config.available ?? []}
                effective={effective}
                serverValues={config.agents ?? {}}
                modelOptions={modelOptions}
                runtime={config.runtime ?? {}}
                registered={new Set(config.registered ?? [])}
                onPick={setAgentModel}
                onViewPrompt={setPromptAgent}
              />
            </div>
          )}
        </>
      )}

      {/* 提示词弹窗：按需拉取（prompt 合计约 106KB，不随列表下发） */}
      {promptAgent && (
        <AgentPromptModal
          workerId={workerId}
          agentName={promptAgent}
          onClose={() => setPromptAgent(null)}
        />
      )}
    </section>
  );
}

/**
 * opencode 原生 agent 项（对齐 GET /agents/opencode）。
 * 注意：展示层只过滤 hidden（系统内部 agent 不出现），subagent 保留展示并标注。
 */
interface OpencodeAgentItem {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  native?: boolean;
  hidden?: boolean;
}

/** GET /agents/opencode 响应。 */
interface OpencodeAgentsResponse {
  agents: OpencodeAgentItem[];
  workerId: string | null;
  degraded: boolean;
}

const OPENCODE_MODE_META: Record<OpencodeAgentItem["mode"], { text: string; title: string; tone: "accent" | "muted" }> = {
  primary: { text: "主Agent", title: "可作为会话主 agent", tone: "accent" },
  subagent: { text: "子Agent", title: "仅由主 agent 派生，不可直接选择", tone: "muted" },
  all: { text: "通用", title: "既可作主 agent，也可被派生", tone: "muted" },
};

/**
 * opencode Agents 只读卡（worker 详情页内与 OmO 面板平级的独立卡）。
 * 数据源 GET /agents/opencode?workerId=…（worker 真实上报的 agent 清单），
 * 与 OmO 开关状态无关——开关只控制 OmO 插件是否加载，不影响本卡展示。
 */
export function OpencodeAgentsPanel({ workerId }: { workerId: string }) {
  const agentsQuery = useQuery({
    queryKey: ["opencode-agents", "worker", workerId],
    queryFn: () =>
      api.get<OpencodeAgentsResponse>("/agents/opencode", { query: { workerId } }),
    retry: false,
  });

  const visible = (agentsQuery.data?.agents ?? []).filter((a) => !a.hidden);
  const degraded = agentsQuery.data?.degraded ?? false;

  return (
    <section data-testid="worker-detail-opencode-agents" style={cardStyle()}>
      <SectionHeader
        icon="◍"
        title="opencode Agents"
        count={agentsQuery.data ? visible.length : undefined}
      />

      {agentsQuery.isPending && <SectionEmpty text="加载中…" />}

      {!agentsQuery.isPending &&
        (agentsQuery.isError || degraded || visible.length === 0) && (
          <SectionEmpty text="未获取到（worker 离线或版本不支持）" />
        )}

      {!agentsQuery.isPending &&
        !agentsQuery.isError &&
        !degraded &&
        visible.length > 0 && (
          <div
            data-testid="opencode-agent-list"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: space.sm,
            }}
          >
            {visible.map((agent) => {
              const modeMeta = OPENCODE_MODE_META[agent.mode];
              const native = agent.native === true;
              return (
                <div
                  key={agent.name}
                  data-testid={`opencode-agent-row-${agent.name}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: space.xs,
                    padding: `${space.sm}px ${space.md}px`,
                    height: "100%",
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "var(--color-surface)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.xs,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: fontFamily.mono,
                        fontSize: fontSize.sm,
                        fontWeight: 600,
                        color: neutral[800],
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={agent.name}
                    >
                      {agent.name}
                    </span>
                    <Badge text={modeMeta.text} title={modeMeta.title} tone={modeMeta.tone} />
                    <Badge
                      text={native ? "原生" : "自定义"}
                      title={native ? "opencode 自带 agent" : "worker 侧自定义 agent"}
                      tone="muted"
                    />
                  </div>
                  {agent.description && (
                    <div
                      style={{
                        fontSize: fontSize.xs,
                        color: neutral[500],
                        lineHeight: 1.55,
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                      title={agent.description}
                    >
                      {agent.description}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
    </section>
  );
}

/**
 * 提示词弹窗：展示单个 agent 的系统提示词全文。
 *
 * 数据按需拉取（点开才请求）——全部 agent 的 prompt 合计约 106KB（Sisyphus 单个 33KB），
 * 随列表下发会让配置页每次加载都背着这 100KB。
 */
function AgentPromptModal({
  workerId,
  agentName,
  onClose,
}: {
  workerId: string;
  agentName: string;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["omo-agent-prompt", workerId, agentName],
    queryFn: () =>
      api.get<{
        name: string;
        description: string;
        mode?: string;
        prompt: string;
        empty: boolean;
      }>("/agents/omo-agent-prompt", { query: { workerId, name: agentName } }),
    retry: false,
  });

  // Esc 关闭
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const d = q.data;
  /** 便于阅读的字符/行数统计（提示词动辄上万字，给个量级感）。 */
  const stats = d?.prompt
    ? `${d.prompt.length.toLocaleString()} 字符 · ${d.prompt.split("\n").length} 行`
    : "";

  return (
    <div
      data-testid="omo-prompt-modal"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        backgroundColor: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: space.xl,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(900px, 100%)",
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--color-surface)",
          borderRadius: radius.lg,
          boxShadow: "0 12px 32px rgba(0,0,0,.18)",
          overflow: "hidden",
          fontFamily: fontFamily.body,
        }}
      >
        {/* 头部：agent 名 + 描述 + 统计 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.md}px ${space.lg}px`,
            borderBottom: `1px solid ${neutral[200]}`,
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
            <span
              style={{
                fontFamily: fontFamily.mono,
                fontSize: fontSize.md,
                fontWeight: 600,
                color: neutral[800],
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {d?.name ?? agentName}
            </span>
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
              {[d?.description, d?.mode, stats].filter(Boolean).join(" · ") || "系统提示词"}
            </span>
          </div>
          <button
            type="button"
            data-testid="omo-prompt-close"
            onClick={onClose}
            aria-label="关闭"
            style={{
              border: "none",
              background: "transparent",
              color: neutral[400],
              cursor: "pointer",
              fontSize: fontSize.lg,
              lineHeight: 1,
              padding: 4,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
        {/* 正文 */}
        <div style={{ padding: `${space.md}px ${space.lg}px`, overflowY: "auto" }}>
          {q.isPending && <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>加载中…</span>}
          {q.isError && (
            <span style={{ fontSize: fontSize.sm, color: "#B91C1C" }}>
              {isApiError(q.error) ? q.error.message : "提示词加载失败"}
            </span>
          )}
          {d && d.empty && (
            <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>
              该 agent 未定义自定义提示词（opencode 原生 agent 通常沿用内置逻辑）
            </span>
          )}
          {d && !d.empty && (
            <pre
              data-testid="omo-prompt-body"
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: fontFamily.mono,
                fontSize: fontSize.xs,
                lineHeight: 1.7,
                color: neutral[700],
              }}
            >
              {d.prompt}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/** 开关（纯 CSS，避免引依赖）。 */
function Toggle({
  on,
  disabled,
  onChange,
  testId,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{
        position: "relative",
        width: 42,
        height: 22,
        flexShrink: 0,
        borderRadius: radius.pill,
        border: `1px solid ${on ? accent : neutral[300]}`,
        backgroundColor: on ? accent : neutral[200],
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        transition: "background-color .15s ease",
        padding: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          left: on ? 21 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          backgroundColor: "#FFF",
          boxShadow: "0 1px 2px rgba(0,0,0,.2)",
          transition: "left .15s ease",
        }}
      />
    </button>
  );
}

/** 分组表格：每个 agent 一行，已配覆盖的行高亮。 */
/**
 * Agent 卡片网格。
 *
 * 为什么用卡片而不是表格行：每个 agent 都有**描述**（说明它负责什么）以及
 * mode/是否已注册等属性，表格行塞不下这些信息，硬塞会非常拥挤。
 * 卡片可以纵向容纳「名称 + 徽标 + 描述 + 模型选择」，且便于按分组浏览。
 */
function AgentCards({
  available,
  effective,
  serverValues,
  modelOptions,
  runtime,
  registered,
  onPick,
  onViewPrompt,
}: {
  available: string[];
  effective: Record<string, string>;
  serverValues: Record<string, string>;
  modelOptions: string[];
  runtime: Record<string, { description?: string; mode?: string; native?: boolean }>;
  registered: Set<string>;
  onPick: (name: string, value: string) => void;
  onViewPrompt: (name: string) => void;
}) {
  const grouped = AGENT_GROUPS.map((g) => ({
    ...g,
    names: g.names.filter((n) => available.includes(n)),
  })).filter((g) => g.names.length > 0);
  const known = new Set(AGENT_GROUPS.flatMap((g) => g.names));
  const others = available.filter((n) => !known.has(n));
  if (others.length > 0) {
    grouped.push({ title: "其他", hint: "OmO 提供的其余 agent", names: others });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
      {grouped.map((group) => (
        <div key={group.title} style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          {/* 分组标题 + 语义说明（帮助用户理解这一组 agent 的角色定位） */}
          <div style={{ display: "flex", alignItems: "baseline", gap: space.sm, flexWrap: "wrap" }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>
              {group.title}
            </span>
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{group.hint}</span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: space.sm,
            }}
          >
            {group.names.map((name) => (
              <AgentCard
                key={name}
                name={name}
                value={effective[name] ?? ""}
                serverValue={serverValues[name] ?? ""}
                meta={runtime[name]}
                isRegistered={registered.has(name)}
                modelOptions={modelOptions}
                onPick={(v) => onPick(name, v)}
                onViewPrompt={() => onViewPrompt(name)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 单个 agent 卡片：名称 + 状态徽标 + 描述 + 模型选择。 */
function AgentCard({
  name,
  value,
  serverValue,
  meta,
  isRegistered,
  modelOptions,
  onPick,
  onViewPrompt,
}: {
  name: string;
  value: string;
  serverValue: string;
  meta?: { description?: string; mode?: string; native?: boolean };
  isRegistered: boolean;
  modelOptions: string[];
  onPick: (value: string) => void;
  onViewPrompt: () => void;
}) {
  const changed = serverValue !== value;
  const configured = !!value;
  /** 去掉 OmO 描述尾部的 "(Xxx - OhMyOpenCode)" 签名，避免卡片里冗余。 */
  const description = (meta?.description ?? "").replace(/\s*\([^)]*OhMyOpenCode\)\s*$/, "").trim();

  return (
    <div
      data-testid={`omo-agent-row-${name}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.xs,
        padding: `${space.sm}px ${space.md}px`,
        // 等高：同组内卡片高度一致，避免描述长短导致参差（视觉杂乱）
        height: "100%",
        borderRadius: radius.md,
        border: `1px solid ${changed ? "#F59E0B" : configured ? "rgba(13,148,136,0.35)" : neutral[200]}`,
        backgroundColor: changed
          ? "rgba(245,158,11,0.06)"
          : configured
            ? "rgba(13,148,136,0.03)"
            : "var(--color-surface)",
      }}
    >
      {/* 名称行 + 状态徽标 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: fontFamily.mono,
            fontSize: fontSize.sm,
            fontWeight: 600,
            color: neutral[800],
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={name}
        >
          {name}
        </span>
        {meta?.mode && (
          <Badge
            text={meta.mode === "primary" ? "主" : "子"}
            title={meta.mode === "primary" ? "可作为会话主 agent" : "由主 agent 派生"}
            tone={meta.mode === "primary" ? "accent" : "muted"}
          />
        )}
        {meta?.native && <Badge text="原生" title="opencode 自带 agent" tone="muted" />}
        {!isRegistered && (
          <Badge
            text="未激活"
            title="当前模型下未注册到 opencode（如 hephaestus 仅支持 GPT 系模型）；换模型后可能激活"
            tone="warn"
          />
        )}
        <span style={{ flex: 1, minWidth: 0 }} />
        {configured && !changed && (
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: accent }} />
        )}
      </div>

      {/* 描述：说明该 agent 负责什么（OmO 提供，缺失时说明未注册） */}
      <div
        style={{
          fontSize: fontSize.xs,
          color: description ? neutral[500] : neutral[300],
          lineHeight: 1.55,
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          // 固定 3 行高度：短描述也占满，卡片才等高
          height: 3 * 1.55 * fontSize.xs,
          flexShrink: 0,
        }}
        title={description || undefined}
      >
        {description || "（该 agent 当前未注册，无描述）"}
      </div>

      {/* 模型选择 + 查看提示词入口：marginTop auto 压到卡片底部，等高时对齐 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, marginTop: "auto" }}>
      <select
        data-testid={`omo-agent-model-${name}`}
        value={value}
        onChange={(e) => onPick(e.target.value)}
        style={{
          flex: 1,
          minWidth: 0,
          height: 26,
          padding: "0 6px",
          borderRadius: radius.sm,
          border: `1px solid ${changed ? "#F59E0B" : neutral[200]}`,
          backgroundColor: "var(--color-surface)",
          fontSize: fontSize.xs,
          color: configured ? neutral[700] : neutral[500],
          fontFamily: fontFamily.mono,
        }}
      >
        <option value="">（用 OmO 默认）</option>
        {modelOptions.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
        {/* 已配但不在目录里的值保留为可选项，避免静默改掉用户配置 */}
        {value && !modelOptions.includes(value) && (
          <option value={value}>{value}（当前值）</option>
        )}
      </select>
        <button
          type="button"
          data-testid={`omo-agent-prompt-${name}`}
          onClick={onViewPrompt}
          disabled={!isRegistered}
          title={
            isRegistered
              ? "查看该 agent 的系统提示词全文"
              : "该 agent 当前未注册到 opencode，无提示词可取"
          }
          style={{
            flexShrink: 0,
            height: 26,
            padding: "0 8px",
            borderRadius: radius.sm,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            color: isRegistered ? neutral[600] : neutral[300],
            fontSize: 11,
            cursor: isRegistered ? "pointer" : "not-allowed",
            fontFamily: fontFamily.body,
            whiteSpace: "nowrap",
          }}
        >
          提示词
        </button>
      </div>
    </div>
  );
}

/** 小徽标（mode/原生/未激活等状态标记）。 */
function Badge({
  text,
  title,
  tone,
}: {
  text: string;
  title?: string;
  tone: "accent" | "muted" | "warn";
}) {
  const theme = {
    accent: { color: "#0F766E", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.30)" },
    muted: { color: neutral[500], bg: neutral[100], border: neutral[200] },
    warn: { color: "#B45309", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.35)" },
  }[tone];
  return (
    <span
      title={title}
      style={{
        flexShrink: 0,
        fontSize: 10,
        lineHeight: 1.5,
        color: theme.color,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        padding: "0 5px",
        borderRadius: radius.pill,
        fontFamily: fontFamily.body,
      }}
    >
      {text}
    </span>
  );
}

function btn(primary: boolean, disabled: boolean): CSSProperties {
  return {
    padding: "3px 12px",
    borderRadius: radius.md,
    border: `1px solid ${primary ? accent : neutral[200]}`,
    backgroundColor: primary ? accent : "var(--color-surface)",
    color: primary ? "#FFF" : neutral[600],
    fontSize: fontSize.xs,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    fontFamily: fontFamily.body,
    whiteSpace: "nowrap",
  };
}
