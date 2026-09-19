"use client";

/**
 * 外部 Agent Tab（third-party-agent-display todo 2，挂载于 /agents 的 Tab 3「外部 Agent」）
 * =============================================================
 * 外部 Agent = 执行引擎上报、但**不在 vteam 策略集合内**的 agent（`governed === false`）。
 * vteam 只做只读展示：名称 / 描述 / mode / 系统提示词全文。
 *
 * 诚实性约束（本组件存在的理由，违反即回归）：
 * - 每条目都带醒目警告：vteam 权限规则**不**管辖这些 agent（amber 警示块，非灰色小字）；
 * - 提示词**只读**（`<pre>` 全文展示）——绝不渲染任何可编辑控件
 *  （没有 textarea / contentEditable / prompt-editor / 保存 / 权限 / 工具 / 模型配置）；
 * - 绝不给外部 agent 绑定或暗示 vteam 策略（无 policyId、无 effectivePermission 入口）；
 * - 指令获取失败 → 显式「说明加载失败（暂不可用）」，绝不渲染空框（空框会被读成"无提示词"）。
 *
 * 数据源（两条既有端点，不新起并行来源）：
 * - 列表：`GET /agents/opencode`（workerId 缺省 → 服务端 assignWorker 自动选在线 worker），
 *   过滤 `!governed && !hidden`；`degraded:true` 或请求失败 → 不可用态（不是"没有外部 agent"）。
 * - 指令：`GET /agents/omo-agent-prompt?name=`（与 worker 详情页 AgentPromptModal 同一端点），
 *   **按需**拉取——全部 prompt 合计 ~106KB，不能随列表下发、也不预取全部。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/**
 * 非治理警告文案（本页的诚实性声明，逐字使用，不要改写成弱化版本）。
 * 测试与证据都锚定这句话；外部 agent 确实不受 vteam 权限管辖。
 */
export const NON_GOVERNANCE_WARNING =
  "此 Agent 来自外部（非 vteam 内置），不受 vteam 权限规则管辖。";

/** 外部 agent 列表不可用（worker 离线 / 旧版无端点 / 请求失败）——与"没有外部 agent"区分。 */
export const EXTERNAL_UNAVAILABLE_TEXT =
  "未获取到外部 Agent（worker 离线或版本不支持）";

/** 列表为空但未降级：引擎只返回了受治理 agent。 */
const EXTERNAL_EMPTY_TEXT = "暂无外部 Agent";

/** 指令获取失败（绝不留空框）。 */
export const EXTERNAL_INSTRUCTIONS_UNAVAILABLE_TEXT = "说明加载失败（暂不可用）";

/** 指令请求成功但引擎无该 agent 的提示词。 */
const EXTERNAL_INSTRUCTIONS_EMPTY_TEXT = "该 agent 未定义自定义提示词";

/** 警示色（amber：与任务"待验收"同族，语义为"注意/不适用"，不用红色以免读成报错）。 */
const warning = {
  text: "#B45309",
  bg: "#FFFBEB",
  border: "#FDE68A",
} as const;

/** GET /agents/opencode 条目（对齐服务端 WorkerAgentInfo + governed）。 */
interface ExternalAgentItem {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  native?: boolean;
  hidden?: boolean;
  governed: boolean;
}

/** GET /agents/opencode 响应（workerId 缺省时由服务端自动选 worker）。 */
interface OpencodeAgentsResponse {
  agents: ExternalAgentItem[];
  workerId: string | null;
  degraded: boolean;
}

/** GET /agents/omo-agent-prompt 响应（与 omo-panel AgentPromptModal 同形）。 */
interface OmoAgentPromptResponse {
  name: string;
  description: string;
  mode?: string;
  prompt: string;
  empty: boolean;
}

const MODE_META: Record<
  ExternalAgentItem["mode"],
  { text: string; title: string }
> = {
  primary: { text: "主Agent", title: "可作为会话主 agent" },
  subagent: { text: "子Agent", title: "仅由主 agent 派生，不可直接选择" },
  all: { text: "通用", title: "既可作主 agent，也可被派生" },
};

/** mode 徽章（中性灰，不抢警示的视觉层级）。 */
function ModeBadge({ mode }: { mode: ExternalAgentItem["mode"] }) {
  const meta = MODE_META[mode] ?? MODE_META.all;
  return (
    <span
      title={meta.title}
      style={{
        flexShrink: 0,
        fontSize: fontSize.xs,
        color: neutral[500],
        backgroundColor: neutral[100],
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.pill,
        padding: "1px 7px",
      }}
    >
      {meta.text}
    </span>
  );
}

/**
 * 非治理警告块。每行 + 详情各渲染一次；`data-testid` 由调用方给，
 * 使 e2e 能按条目/详情精确计数。
 */
function NonGovernanceWarning({
  testId,
  compact = false,
}: {
  testId: string;
  /** 列表行内紧凑排版（详情用完整排版）。 */
  compact?: boolean;
}) {
  return (
    <div
      data-testid={testId}
      role="note"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: space.xs,
        padding: compact ? `3px 6px` : `${space.sm}px ${space.md}px`,
        borderRadius: radius.sm,
        backgroundColor: warning.bg,
        border: `1px solid ${warning.border}`,
        color: warning.text,
        fontSize: compact ? fontSize.xs : fontSize.sm,
        lineHeight: 1.5,
        fontWeight: 500,
      }}
    >
      <span aria-hidden style={{ flexShrink: 0, fontWeight: 700 }}>
        !
      </span>
      <span>{NON_GOVERNANCE_WARNING}</span>
    </div>
  );
}

/** 空/降级态提示（灰虚线框，与页面其他区块一致）。 */
function PanelEmpty({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: `${space.lg}px`,
        borderRadius: radius.md,
        border: `1px dashed ${neutral[200]}`,
        backgroundColor: neutral[50],
        fontSize: fontSize.sm,
        color: neutral[400],
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}

export function ExternalAgentsPanel() {
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // 列表：不传 workerId（服务端 assignWorker 自动选在线 worker）
  const agentsQuery = useQuery({
    queryKey: ["external-agents"],
    queryFn: () =>
      api.get<OpencodeAgentsResponse>("/agents/opencode", { query: {} }),
    retry: false,
  });

  const externalAgents = useMemo(
    () => (agentsQuery.data?.agents ?? []).filter((a) => !a.governed && !a.hidden),
    [agentsQuery.data],
  );

  // 降级（worker 离线/版本不支持）或请求失败 → 不可用态；绝不当成"没有外部 agent"
  const unavailable =
    agentsQuery.isError || (agentsQuery.data?.degraded ?? false);

  // 默认选中第一个（列表就绪后），保证右侧有内容；不预取提示词，选中才拉
  useEffect(() => {
    if (agentsQuery.isPending || unavailable) return;
    if (selectedName && externalAgents.some((a) => a.name === selectedName)) return;
    setSelectedName(externalAgents[0]?.name ?? null);
  }, [agentsQuery.isPending, unavailable, externalAgents, selectedName]);

  const selected = useMemo(
    () => externalAgents.find((a) => a.name === selectedName) ?? null,
    [externalAgents, selectedName],
  );

  return (
    <div
      data-testid="external-agents-root"
      style={{ display: "flex", gap: space.lg, alignItems: "flex-start", ...baseFont }}
    >
      {/* 左：外部 agent 列表（320px，与 Agent Tab 同宽） */}
      <div
        style={{
          width: 320,
          flexShrink: 0,
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
            padding: `0 ${space.xs}px`,
          }}
        >
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>
            外部 Agent（不受 vteam 权限管辖）
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            {agentsQuery.isPending ? "…" : `${externalAgents.length} 个`}
          </span>
        </div>

        {agentsQuery.isPending ? (
          <div
            data-testid="external-agents-loading"
            style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}
          >
            加载中…
          </div>
        ) : unavailable ? (
          <div data-testid="external-agents-unavailable" role="alert">
            <PanelEmpty text={EXTERNAL_UNAVAILABLE_TEXT} />
          </div>
        ) : externalAgents.length === 0 ? (
          <div data-testid="external-agents-empty">
            <PanelEmpty text={EXTERNAL_EMPTY_TEXT} />
          </div>
        ) : (
          externalAgents.map((agent) => {
            const active = agent.name === selectedName;
            return (
              <button
                key={agent.name}
                type="button"
                data-testid="external-agent-item"
                data-agent-name={agent.name}
                data-active={active ? "true" : "false"}
                onClick={() => setSelectedName(agent.name)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  cursor: "pointer",
                  border: `1px solid ${active ? warning.border : neutral[200]}`,
                  borderRadius: radius.md,
                  backgroundColor: active ? "var(--color-surface)" : neutral[50],
                  padding: space.md,
                  display: "flex",
                  flexDirection: "column",
                  gap: space.xs,
                  fontFamily: fontFamily.body,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: space.xs, minWidth: 0 }}>
                  <span
                    title={agent.name}
                    style={{
                      fontFamily: fontFamily.mono,
                      fontSize: fontSize.md,
                      fontWeight: 600,
                      color: neutral[800],
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {agent.name}
                  </span>
                  <ModeBadge mode={agent.mode} />
                </span>
                <span
                  style={{
                    fontSize: fontSize.xs,
                    color: neutral[500],
                    lineHeight: 1.55,
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {agent.description || "（无描述）"}
                </span>
                {/* 每条目必带警告：这是本 Tab 的诚实性声明 */}
                <NonGovernanceWarning testId="external-agent-item-warning" compact />
              </button>
            );
          })
        )}
      </div>

      {/* 右：只读详情 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {selected ? (
          <ExternalAgentDetail key={selected.name} agent={selected} />
        ) : (
          <div
            data-testid="external-agent-detail-empty"
            style={{
              padding: `${space.xxl}px`,
              borderRadius: radius.lg,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: fontSize.md,
              color: neutral[400],
            }}
          >
            {agentsQuery.isPending ? "加载中…" : "请选择左侧外部 Agent 查看说明"}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 单个外部 agent 的只读详情。
 *
 * 注意：这里**没有**也不允许有任何写控件——外部 agent 的提示词由引擎侧定义，
 * vteam 既不编辑也不覆盖（要改请改引擎侧配置）。
 */
function ExternalAgentDetail({ agent }: { agent: ExternalAgentItem }) {
  // 指令按需拉取：选中才请求（与 AgentPromptModal 同一端点/同一 key 形状）
  const promptQuery = useQuery({
    queryKey: ["omo-agent-prompt", "external", agent.name],
    queryFn: () =>
      api.get<OmoAgentPromptResponse>("/agents/omo-agent-prompt", {
        query: { name: agent.name },
      }),
    retry: false,
  });

  const d = promptQuery.data;
  const stats = d?.prompt
    ? `${d.prompt.length.toLocaleString()} 字符 · ${d.prompt.split("\n").length} 行`
    : "";

  // 「刚切换 agent」的请求竞态：旧数据不得冒充新 agent 的说明
  const stale = d != null && d.name !== agent.name;
  const showPrompt = !!d && !d.empty && !stale;
  const showEmpty = !!d && d.empty && !stale;

  return (
    <div
      data-testid="external-agent-detail"
      data-agent-name={agent.name}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.md,
        padding: space.lg,
        borderRadius: radius.lg,
        border: `1px solid ${neutral[200]}`,
        backgroundColor: "var(--color-surface)",
      }}
    >
      {/* 头部：名称 + mode + 描述 */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          <span
            style={{
              fontFamily: fontFamily.mono,
              fontSize: fontSize.lg,
              fontWeight: 700,
              color: neutral[900],
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {agent.name}
          </span>
          <ModeBadge mode={agent.mode} />
          <span
            style={{
              flexShrink: 0,
              fontSize: fontSize.xs,
              color: neutral[500],
              backgroundColor: neutral[100],
              border: `1px solid ${neutral[200]}`,
              borderRadius: radius.pill,
              padding: "1px 7px",
            }}
          >
            外部
          </span>
        </div>
        <div style={{ fontSize: fontSize.sm, color: neutral[500], lineHeight: 1.6 }}>
          {agent.description || "（该 agent 未提供描述）"}
        </div>
      </div>

      {/* 醒目的非治理警告（详情处再次声明，且比列表行更大） */}
      <NonGovernanceWarning testId="external-agent-detail-warning" />

      {/* 系统提示词：只读全文 */}
      <div style={{ display: "flex", alignItems: "baseline", gap: space.sm }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>
          系统提示词（只读）
        </span>
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
          {stale ? "" : stats}
        </span>
      </div>

      <div
        style={{
          maxHeight: "56vh",
          overflowY: "auto",
          padding: space.md,
          borderRadius: radius.md,
          border: `1px solid ${neutral[200]}`,
          backgroundColor: neutral[50],
        }}
      >
        {promptQuery.isPending && (
          <span
            data-testid="external-agent-instructions-loading"
            style={{ fontSize: fontSize.sm, color: neutral[400] }}
          >
            加载中…
          </span>
        )}
        {promptQuery.isError && (
          <span
            data-testid="external-agent-instructions-unavailable"
            role="alert"
            style={{ fontSize: fontSize.sm, color: "#B91C1C", fontWeight: 500 }}
          >
            {EXTERNAL_INSTRUCTIONS_UNAVAILABLE_TEXT}
            {isApiError(promptQuery.error) ? `（${promptQuery.error.message}）` : ""}
          </span>
        )}
        {showEmpty && (
          <span
            data-testid="external-agent-instructions-empty"
            style={{ fontSize: fontSize.sm, color: neutral[400] }}
          >
            {EXTERNAL_INSTRUCTIONS_EMPTY_TEXT}
          </span>
        )}
        {showPrompt && (
          <pre
            data-testid="external-agent-instructions"
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
  );
}
