"use client";

/**
 * Provider 管理 Tab 视图（模型管理页内嵌 —— /models 双 Tab 的第二个 Tab）
 * =============================================
 * 用户需求：「主入口应该只有一个模型管理，进去后通过 tab 页管理两个页面，支持切换」。
 * 本组件由原 /providers 页（Provider 管理）原样迁移为 Tab 视图：
 *
 * - Provider 列表：行 = providerID + 模型数（modelCount）+ 凭据状态徽章
 *   （provider-credential-status：已配置=绿 / 未配置=灰 / 已撤销=琥珀）+ fingerprint
 *   （已配置时显示，脱敏）。
 * - 配置按钮（provider-configure-button，admin 专属）→ 配置弹窗：provider 预填 +
 *   key 输入（password）+ 同步到节点（worker 多选，未选=全部 worker）+ 保存。
 * - 保存 → POST /models/:id/credentials {token, targetWorkerIds?}（用该 provider 下
 *   任一模型 id；targetWorkerIds 非空 → 定向 enqueueCommand，空 → 全量广播，C5）→
 *   成功后列表刷新 + 徽章变「已配置」。
 * - 编辑配置（provider-edit-button，admin 专属）→ 编辑弹窗（provider-edit-modal）：
 *   类型（cloud/local/custom）+ Base URL（local/custom 必填；cloud 留空=清空回落官方端点），
 *   Provider ID 只读 → PATCH /models/providers/:providerID（provider 级原子重写全模型行
 *   + C6 下发；逐行 PATCH 会撞 baseUrl 一致性 409 且无法清空，故走独立端点）。
 * - 删除凭据（provider-delete-button，admin 专属）→ DELETE
 *   /models/providers/:providerID/credentials（按 provider 粒度直删，
 *   revokedAt 软撤销，不依赖模型 id）→ 徽章变「未配置」。
 * - 新增 Provider（provider-add-button，admin 专属）→ 新增弹窗（provider-add-modal）：
 *   Provider ID（slug）+ 类型（cloud/local/custom）+ Base URL（local/custom 必填）+
 *   锚点模型（modelID 必填 + name 可选）+ API Key（cloud 必填；local/custom 可空=占位 key）+
 *   同步到节点（worker 多选，未选=全部）。
 *   背景：模型目录 Tab 下线（其「新增模型」是唯一的 Provider 创建入口），而 Provider 列表是
 *   派生视图（models 表 groupBy ∪ worker 上报，无独立 provider 实体）——新 Provider 永远无法
 *   出现在列表中，且无模型行的 provider 连「配置凭据」都走不通（resolveModelId 抛"无可用模型"）。
 *   修复：复用既有端点恢复新增路径——POST /models {providerID, modelID, name, providerType,
 *   baseUrl} 创建锚点模型行（Provider 立即出现在 GET /models/providers 聚合）→
 *   POST /models/:id/credentials {token, targetWorkerIds?} 保存凭据并下发（C5）。
 *   输入的 Provider ID 命中已有 Provider 时预填其 type/baseUrl，保存语义变为
 *   「为其新增模型」（providerID+modelID 撞唯一 → 409 由后端报错）。
 * - 模型能力配置（provider-model-edit-button「配置」，admin 专属，展开 provider 后
 *   模型行尾）→ 能力弹窗（provider-model-capabilities-modal）：编辑 per-model 能力声明
 *   （limit.context/limit.output + reasoning/toolCall/temperature/attachment + 输入/输出
 *   模态 + options JSON，思考强度快速选择写 options.reasoningEffort）→
 *   PATCH /models/:id {capabilities}（整对象替换后 C6 门控下发；「清空配置」=
 *   {capabilities:{}}；limit 仅 context+output 均正整数时发送，半填会被校验丢弃；
 *   未触碰且原值没有的键不发送，避免误清原值）。
 *   limit.context 为何是最关键字段：opencode 1.18.31 实测——不配置 = 该模型视为
 *   上下文 0，isOverflow() 恒 false → 自动压缩永不触发（上下文静默溢出）且上下文
 *   meter 错误；打开弹窗时 context 未配置则自动探测一次（POST /models/probe-endpoint，
 *   vLLM max_model_len → context 预填；永不抛错，空结果 = 请手动填写），手动「探测」
 *   按钮可重跑。
 * - 数据源：GET /models/providers 后端聚合（C9：一次请求返回
 *   [{providerID, modelCount, configured, fingerprint, revokedAt}]）；GET /workers
 *   提供 worker 多选数据源（queryKey=["workers"]
 *   无污染）。
 * - 保存凭据需模型 id（providers 响应不含 id）：保底
 *   GET /models?providerID=xxx 取该 provider 首个模型 id（凭据按 provider 粒度，
 *   C4：同 provider 下任一模型 id 均可操作）；删除凭据改按 provider 直删
 *   （不再解析模型 id——修复每次删除取到不同模型 id 的 bug）。
 * - 权限：isAdmin（roleName==='admin'）控制配置/删除，成员只读（后端 AdminGuard 403 兜底）。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；root flex:1 铺满（AppShell 提供导航）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { ConfirmDialog } from "@/src/components/ui";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";
import type {
  ApiModel,
  ApiModelCapabilities,
  ApiWorker,
  CredentialView,
  ModelsResponse,
  ProviderSummary,
} from "@/src/types/models";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 页面内扩展 token（仿 models 页范式，不写 tokens.ts） ------------------------------ */

/** 凭据状态三态（已配置 / 未配置 / 已撤销），语义独立于任务四态，页面内定义。 */
const credentialTheme = {
  configured: { label: "已配置", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  missing: { label: "未配置", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
  revoked: { label: "已撤销", color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)" },
} as const;

/** Provider 列表主色（与导航高亮蓝同族） */
const activeBlue = "#0D9488";

/** 行 hover / 过渡（scoped：pv 前缀避免污染） */
const rowCss = `
.pv-provider-row { transition: border-color .15s ease, background-color .15s ease; }
.pv-provider-row:hover { background-color: var(--color-neutral-50); }
`;

type CredentialStatus = keyof typeof credentialTheme;

/** Provider 聚合 → 三态（configured=true 优先；revokedAt 已置 → 已撤销；否则未配置） */
function toStatus(p: ProviderSummary): CredentialStatus {
  if (p.configured) return "configured";
  return p.revokedAt ? "revoked" : "missing";
}

/* ------------------------------ 子组件 ------------------------------ */

/** 凭据状态徽章：已配置=绿 / 未配置=灰 / 已撤销=琥珀（对齐 models 页 CredentialBadge）。 */
function CredentialBadge({ status }: { status: CredentialStatus }) {
  const theme = credentialTheme[status];
  return (
    <span
      data-testid="provider-credential-status"
      data-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
        ...baseFont,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: theme.color,
          flexShrink: 0,
        }}
      />
      {theme.label}
    </span>
  );
}

/** 轻量按钮：次级（边框白底）与主操作（蓝底）共用。 */
export function ActionButton({
  testid,
  label,
  onClick,
  disabled,
  primary,
}: {
  testid: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs + 2}px ${space.md + 2}px`,
        borderRadius: radius.pill,
        border: primary ? "none" : `1px solid ${neutral[200]}`,
        backgroundColor: primary ? activeBlue : "var(--color-surface)",
        color: primary ? "#FFFFFF" : neutral[600],
        fontSize: fontSize.sm,
        fontWeight: 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
        fontFamily: fontFamily.body,
      }}
    >
      {label}
    </button>
  );
}

/* ================================ Provider 下钻模型列表（二级） ================================
 * 选用 agents 页 EffectivePermissionSection 的行内 expand/collapse 模式（而非 skills 页
 * McpServerSection + breadcrumb 下钻），原因：
 * - Provider 行的配置/删除凭据操作必须在 Level 1 常驻可见；breadcrumb 下钻会整 list 替换为
 *   详情视图，操作入口被藏进二级，回跳成本高；
 * - ~200 providers 下多行可同时展开对比，breadcrumb 一次只看一个 server；
 * - 改动最小：保留现有行卡片布局与全部 testids，仅行首加 toggle + 行下挂懒加载面板。
 * 数据源：GET /models?providerID=<id>（QueryModelsDto 已支持 providerID contains 过滤，
 * 前端再按 === 精确过滤防前缀误命中；与 resolveModelId 同一查询口径，pageSize 100）。
 * 行尾「配置」（provider-model-edit-button，admin 专属）→ ModelCapabilitiesModal
 * （C8 per-model 能力 → PATCH /models/:id {capabilities}；baseUrl 透传供探测）。 */

function ProviderModels({
  providerID,
  baseUrl,
  onEditModel,
}: {
  providerID: string;
  /** Provider 的 Base URL（探测 {baseUrl}/models 预填 context；null=无探测能力） */
  baseUrl?: string | null;
  /** admin 专属：打开模型能力配置弹窗（baseUrl 经本回调回传给弹窗探测用） */
  onEditModel?: (model: ApiModel, baseUrl?: string | null) => void;
}) {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.roleName === "admin";
  const modelsQuery = useQuery({
    queryKey: ["models", { providerID }],
    queryFn: () =>
      api.get<ModelsResponse>("/models", {
        query: { providerID, page: 1, pageSize: 100 },
      }),
    enabled: !!providerID,
  });
  const models: ApiModel[] = (modelsQuery.data?.items ?? []).filter(
    (m) => m.providerID === providerID
  );

  if (modelsQuery.isPending) {
    return (
      <div
        data-testid="provider-models-loading"
        style={{ fontSize: fontSize.sm, color: neutral[400], padding: `${space.sm}px 0` }}
      >
        模型加载中…
      </div>
    );
  }
  if (modelsQuery.isError) {
    return (
      <div
        data-testid="provider-models-error"
        role="alert"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          fontSize: fontSize.sm,
          color: "#DC2626",
          padding: `${space.sm}px 0`,
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>加载该 Provider 的模型失败</span>
        <button
          type="button"
          data-testid="provider-models-retry"
          onClick={() => modelsQuery.refetch()}
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
          重试
        </button>
      </div>
    );
  }
  if (models.length === 0) {
    return (
      <div
        data-testid="provider-models-empty"
        style={{ fontSize: fontSize.sm, color: neutral[400], padding: `${space.sm}px 0` }}
      >
        该 Provider 下暂无模型
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
      {models.map((m) => {
        const modelRef = `${m.providerID}/${m.modelID}`;
        return (
          <div
            key={m.id}
            data-testid="provider-model-item"
            data-model-id={modelRef}
            data-provider={m.providerID}
            data-enabled={m.enabled ? "true" : "false"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.md,
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              ...baseFont,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                flexShrink: 0,
                borderRadius: "50%",
                backgroundColor: m.enabled ? activeBlue : neutral[300],
              }}
            />
            <span
              data-testid="provider-model-name"
              data-model-id={modelRef}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: fontSize.sm,
                fontWeight: 600,
                color: neutral[800],
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {m.name}
            </span>
            <span
              data-testid="provider-model-id"
              data-model-id={modelRef}
              style={{
                flexShrink: 0,
                fontSize: fontSize.xs,
                fontFamily: fontFamily.mono,
                color: neutral[500],
                letterSpacing: "-0.01em",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 320,
              }}
            >
              {modelRef}
            </span>
            <span
              style={{
                flexShrink: 0,
                fontSize: fontSize.xs,
                color: m.enabled ? activeBlue : neutral[400],
                backgroundColor: m.enabled ? "rgba(13,148,136,0.10)" : neutral[100],
                border: `1px solid ${m.enabled ? "rgba(13,148,136,0.22)" : neutral[200]}`,
                padding: "1px 8px",
                borderRadius: radius.pill,
                whiteSpace: "nowrap",
              }}
            >
              {m.enabled ? "已启用" : "已停用"}
            </span>
            {isAdmin && onEditModel && (
              <ActionButton
                testid="provider-model-edit-button"
                label="配置"
                onClick={() => onEditModel(m, baseUrl)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ================================ 配置凭据弹窗（admin 专属） ================================ */

interface ConfigureModalProps {
  open: boolean;
  provider: string;
  providerType?: string | null;
  submitting: boolean;
  error: string | null;
  workers: ApiWorker[];
  onClose: () => void;
  onSubmit: (payload: { token: string; targetWorkerIds?: string[] }) => void;
}

/** 凭据配置弹窗（本 Tab 内复用）。 */
export function ConfigureModal({
  open,
  provider,
  providerType,
  submitting,
  error,
  workers,
  onClose,
  onSubmit,
}: ConfigureModalProps) {
  const [token, setToken] = useState("");
  const [targetWorkers, setTargetWorkers] = useState<Set<string>>(new Set());
  const isLocal = providerType === 'local' || providerType === 'custom';

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  /* 打开弹窗时清空上次输入 */
  useEffect(() => {
    if (open) {
      setToken("");
      setTargetWorkers(new Set());
    }
  }, [open]);

  if (!open) return null;

  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "var(--color-surface)",
    fontSize: fontSize.md,
    color: neutral[800],

    fontFamily: fontFamily.body,
  };

  const toggleWorker = (id: string) => {
    setTargetWorkers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sortedWorkers = [...workers].sort((a, b) => {
    if (a.status !== "offline" && b.status === "offline") return -1;
    if (a.status === "offline" && b.status !== "offline") return 1;
    return (a.name ?? a.id).localeCompare(b.name ?? b.id);
  });

  return (
    <div
      data-testid="provider-config-modal"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12%",
      }}
    >
      <div
        aria-hidden
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      <div
        style={{
          position: "relative",
          width: 480,
          maxWidth: "calc(100% - 48px)",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
          fontFamily: fontFamily.body,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              配置 Provider 凭据
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
              token 经 AES-256-GCM 加密落库，保存后下发到目标节点（C4/C5）
            </div>
          </div>
          <button
            type="button"
            data-testid="provider-modal-cancel"
            aria-label="关闭配置凭据弹窗"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              flexShrink: 0,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              backgroundColor: "transparent",
              color: neutral[400],
              fontSize: fontSize.lg,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Provider（预填该行，只读展示） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
            Provider
          </span>
          <div
            data-testid="provider-modal-provider"
            data-provider={provider}
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              padding: `${space.md}px ${space.lg}px`,
              borderRadius: radius.md,
              backgroundColor: neutral[50],
              border: `1px solid ${neutral[200]}`,
              fontSize: fontSize.md,
              fontWeight: 600,
              color: neutral[800],
              fontFamily: fontFamily.mono,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: activeBlue,
                flexShrink: 0,
              }}
            />
            {provider}
          </div>
        </div>

        {/* API key 输入（password；本地 provider 无鉴权可留空） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
            API Key {!isLocal && <span aria-hidden style={{ color: "#DC2626" }}>*</span>}
          </span>
          <input
            data-testid="provider-modal-key-input" autoComplete="new-password" name="api-token"
            type={isLocal ? "text" : "password"}
            placeholder={
              isLocal
                ? `本地 provider（${provider}）无需密钥，可留空`
                : `输入 ${provider} 的 API token`
            }
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={submitting}
            style={inputBase}
          />
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            {isLocal
              ? "本地模型无鉴权，留空保存即完成配置（worker 侧自动补占位 key）"
              : "按 provider 粒度保存，agent 选择该 provider 下模型时自动生效"}
          </span>
        </div>

        {/* 同步到节点（worker 多选，未选=全部 worker） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              同步到节点
            </span>
            <span style={{ fontSize: fontSize.xs, color: activeBlue }}>未选则同步到全部 worker</span>
            <button
              type="button"
              data-testid="provider-modal-select-all"
              onClick={() => setTargetWorkers(new Set(workers.map((w) => w.id)))}
              style={{
                fontSize: fontSize.xs,
                color: neutral[500],
                border: `1px solid ${neutral[200]}`,
                borderRadius: radius.sm,
                backgroundColor: "var(--color-surface)",
                padding: "2px 8px",
                cursor: "pointer",
                fontFamily: fontFamily.body,
                marginLeft: "auto",
              }}
            >
              全选
            </button>
          </div>
          <div
            data-testid="provider-modal-workers"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.md,
              flexWrap: "wrap",
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: neutral[50],
              border: `1px solid ${neutral[200]}`,
            }}
          >
            {sortedWorkers.map((w) => {
              const checked = targetWorkers.has(w.id);
              const online = w.status !== "offline";
              return (
                <label
                  key={w.id}
                  data-worker-id={w.id}
                  data-online={online ? "true" : "false"}
                  data-checked={checked ? "true" : "false"}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: space.sm,
                    padding: `${space.xs + 2}px ${space.md}px`,
                    borderRadius: radius.pill,
                    backgroundColor: checked ? "rgba(13,148,136,0.10)" : "var(--color-surface)",
                    border: `1px solid ${checked ? "rgba(13,148,136,0.22)" : neutral[200]}`,
                    cursor: "pointer",
                    fontSize: fontSize.md,
                    color: neutral[700],
                    fontFamily: fontFamily.body,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleWorker(w.id)}
                    style={{ accentColor: activeBlue, cursor: "pointer" }}
                  />
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      backgroundColor: online ? "#059669" : "var(--color-neutral-400)",
                      flexShrink: 0,
                    }}
                  />
                  {w.name ?? w.id}
                  <span style={{ fontSize: fontSize.xs, color: online ? "#059669" : neutral[400] }}>
                    {online ? "在线" : "离线"}
                  </span>
                </label>
              );
            })}
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
              定向下发走 enqueueCommand；未选任何 worker 时走 broadcastCommand 全量广播（C5）
            </span>
          </div>
        </div>

        {error && (
          <div
            data-testid="provider-modal-error"
            role="alert"
            style={{
              fontSize: fontSize.sm,
              color: "#DC2626",
              display: "flex",
              alignItems: "center",
              gap: space.xs,
            }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button
            type="button"
            data-testid="provider-modal-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
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
            取消
          </button>
          <button
            type="button"
            data-testid="provider-modal-save"
            disabled={submitting || (!isLocal && !token.trim())}
            onClick={() =>
              onSubmit({
                token: token.trim(),
                targetWorkerIds: targetWorkers.size > 0 ? Array.from(targetWorkers) : undefined,
              })
            }
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: activeBlue,
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: submitting || (!isLocal && !token.trim()) ? "default" : "pointer",
              opacity: submitting || (!isLocal && !token.trim()) ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(13,148,136,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "保存中…" : "保存并同步"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================ 新增 Provider 弹窗（admin 专属） ================================
 * 目录 Tab 下线后「新增模型」入口丢失，Provider 列表是派生视图（models 表 ∪ worker 上报，
 * 无独立 provider 实体）——缺此入口则新 Provider 永远无法出现（见文件头背景说明）。
 * 两步保存（复用既有端点，不新增后端契约）：
 * ① POST /models {providerID, modelID, name, providerType, baseUrl} → 创建锚点模型行
 *   （新 Provider 立即出现在 GET /models/providers 聚合；providerID+modelID 撞唯一 → 409）；
 * ② POST /models/:id/credentials {token, targetWorkerIds?} → 保存凭据（cloud 必填；
 *   local/custom 空 → 后端占位 local-noop，与 ConfigureModal「留空即可」语义一致）→ C5 下发。
 * 输入的 providerID 命中已有 Provider 时：预填其 type/baseUrl，保存语义变为「为其新增模型」。
 */

export interface AddProviderPayload {
  providerID: string;
  providerType: string;
  baseUrl: string;
  modelID: string;
  name: string;
  token: string;
  targetWorkerIds?: string[];
}

interface AddProviderModalProps {
  open: boolean;
  submitting: boolean;
  error: string | null;
  workers: ApiWorker[];
  /** 现有 Provider 聚合（providerID 命中时预填 type/baseUrl + 提示） */
  existing: ProviderSummary[];
  onClose: () => void;
  onSubmit: (payload: AddProviderPayload) => void;
}

/** providerID slug（对齐后端 CreateModelDto MODEL_SLUG_PATTERN：小写字母/数字开头 + 小写/数字/连字符/下划线/点） */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/;
/** modelID（对齐后端 MODEL_ID_PATTERN：允许冒号的本地标签，如 llama3:8b） */
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9-_.:]*$/;
/** baseUrl（对齐后端 normalizeBaseUrl：http(s) URL） */
const BASE_URL_PATTERN = /^https?:\/\/.+$/;

const PROVIDER_TYPE_OPTIONS = [
  { value: "cloud", label: "云端" },
  { value: "local", label: "本地" },
  { value: "custom", label: "自定义" },
] as const;

export function AddProviderModal({
  open,
  submitting,
  error,
  workers,
  existing,
  onClose,
  onSubmit,
}: AddProviderModalProps) {
  const [providerID, setProviderID] = useState("");
  const [providerType, setProviderType] = useState("cloud");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelID, setModelID] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [targetWorkers, setTargetWorkers] = useState<Set<string>>(new Set());

  const isLocal = providerType === "local" || providerType === "custom";

  /* 打开弹窗时清空上次输入（对齐 ConfigureModal） */
  useEffect(() => {
    if (open) {
      setProviderID("");
      setProviderType("cloud");
      setBaseUrl("");
      setModelID("");
      setName("");
      setToken("");
      setTargetWorkers(new Set());
    }
  }, [open]);

  /* Escape 关闭 */
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  /* providerID 命中已有 Provider → 预填其 type/baseUrl（保存语义变为「为其新增模型」） */
  const trimmedProvider = providerID.trim();
  const existingMatch = trimmedProvider
    ? existing.find((p) => p.providerID === trimmedProvider)
    : undefined;
  useEffect(() => {
    if (!open || !existingMatch) return;
    if (existingMatch.providerType) setProviderType(existingMatch.providerType);
    if (existingMatch.baseUrl) setBaseUrl(existingMatch.baseUrl);
  }, [open, existingMatch]);

  if (!open) return null;

  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "var(--color-surface)",
    fontSize: fontSize.md,
    color: neutral[800],
    fontFamily: fontFamily.body,
  };

  const labelStyle: CSSProperties = {
    fontSize: fontSize.sm,
    fontWeight: 500,
    color: neutral[600],
  };

  const hintStyle: CSSProperties = {
    fontSize: fontSize.xs,
    color: neutral[400],
  };

  const toggleWorker = (id: string) => {
    setTargetWorkers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sortedWorkers = [...workers].sort((a, b) => {
    if (a.status !== "offline" && b.status === "offline") return -1;
    if (a.status === "offline" && b.status !== "offline") return 1;
    return (a.name ?? a.id).localeCompare(b.name ?? a.id);
  });

  /* 客户端校验（与后端 DTO/normalize* 同规则，错误终由后端裁决并回显） */
  const trimmedModel = modelID.trim();
  const trimmedUrl = baseUrl.trim();
  const idValid =
    trimmedProvider.length > 0 &&
    trimmedProvider.length <= 64 &&
    PROVIDER_ID_PATTERN.test(trimmedProvider);
  const modelValid =
    trimmedModel.length > 0 &&
    trimmedModel.length <= 128 &&
    MODEL_ID_PATTERN.test(trimmedModel);
  const urlValid = isLocal
    ? trimmedUrl.length > 0 &&
      trimmedUrl.length <= 512 &&
      BASE_URL_PATTERN.test(trimmedUrl)
    : trimmedUrl.length === 0 ||
      (trimmedUrl.length <= 512 && BASE_URL_PATTERN.test(trimmedUrl));
  const keyValid = isLocal || token.trim().length > 0;
  const canSave = idValid && modelValid && urlValid && keyValid;

  return (
    <div
      data-testid="provider-add-modal"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8%",
      }}
    >
      <div
        aria-hidden
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      <div
        style={{
          position: "relative",
          width: 480,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "calc(100% - 64px)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
          fontFamily: fontFamily.body,
        }}
      >
        {/* 标题区 */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              新增 Provider
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
              创建锚点模型行使 Provider 入列，再保存凭据下发到节点（C4/C5）
            </div>
          </div>
          <button
            type="button"
            data-testid="provider-add-modal-cancel"
            aria-label="关闭新增 Provider 弹窗"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              flexShrink: 0,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              backgroundColor: "transparent",
              color: neutral[400],
              fontSize: fontSize.lg,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Provider ID */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>
            Provider ID <span aria-hidden style={{ color: "#DC2626" }}>*</span>
          </span>
          <input
            data-testid="provider-add-provider-input"
            autoComplete="off"
            name="provider-id"
            value={providerID}
            onChange={(e) => setProviderID(e.target.value)}
            disabled={submitting}
            placeholder="如 my-llm（小写字母/数字开头）"
            style={{ ...inputBase, fontFamily: fontFamily.mono }}
          />
          {existingMatch ? (
            <span style={{ ...hintStyle, color: "#D97706" }}>
              该 Provider 已存在（{existingMatch.modelCount} 个模型）——已预填其类型 / Base URL，
              保存将为其新增模型
            </span>
          ) : providerID.length > 0 && !idValid ? (
            <span style={{ ...hintStyle, color: "#DC2626" }}>
              需为小写字母/数字开头，仅含小写字母/数字/连字符/下划线/点
            </span>
          ) : (
            <span style={hintStyle}>同一 providerID+modelID 全局唯一，冲突时保存会报错</span>
          )}
        </div>

        {/* 类型（cloud/local/custom 三选一） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>类型</span>
          <div data-testid="provider-add-type" style={{ display: "flex", gap: space.sm }}>
            {PROVIDER_TYPE_OPTIONS.map((opt) => {
              const active = providerType === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  data-type={opt.value}
                  data-active={active ? "true" : "false"}
                  onClick={() => setProviderType(opt.value)}
                  disabled={submitting}
                  style={{
                    flex: 1,
                    padding: `${space.sm}px ${space.md}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${active ? activeBlue : neutral[200]}`,
                    backgroundColor: active ? "rgba(13,148,136,0.10)" : "var(--color-surface)",
                    color: active ? activeBlue : neutral[600],
                    fontSize: fontSize.sm,
                    fontWeight: 500,
                    cursor: submitting ? "default" : "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <span style={hintStyle}>
            {isLocal ? "本地/自定义：Base URL 必填，无需 API Key" : "云端：API Key 必填"}
          </span>
        </div>

        {/* Base URL（local/custom 必填；cloud 可选） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>
            Base URL {isLocal && <span aria-hidden style={{ color: "#DC2626" }}>*</span>}
          </span>
          <input
            data-testid="provider-add-baseurl-input"
            autoComplete="off"
            name="provider-base-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={submitting}
            placeholder={
              isLocal
                ? "如 http://host.docker.internal:11434/v1"
                : "可选（默认官方端点）"
            }
            style={{ ...inputBase, fontFamily: fontFamily.mono }}
          />
          {baseUrl.length > 0 && !urlValid && (
            <span style={{ ...hintStyle, color: "#DC2626" }}>需为 http(s) URL</span>
          )}
        </div>

        {/* 模型 ID（锚点模型，必填） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>
            模型 ID <span aria-hidden style={{ color: "#DC2626" }}>*</span>
          </span>
          <input
            data-testid="provider-add-model-id-input"
            autoComplete="off"
            name="provider-model-id"
            value={modelID}
            onChange={(e) => setModelID(e.target.value)}
            disabled={submitting}
            placeholder="如 gpt-4o / llama3:8b"
            style={{ ...inputBase, fontFamily: fontFamily.mono }}
          />
          {modelID.length > 0 && !modelValid && (
            <span style={{ ...hintStyle, color: "#DC2626" }}>
              需为小写字母/数字开头，可含连字符/下划线/点/冒号
            </span>
          )}
        </div>

        {/* 模型名称（可选，缺省同 modelID） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>模型名称</span>
          <input
            data-testid="provider-add-model-name-input"
            autoComplete="off"
            name="provider-model-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            placeholder="可选，缺省同模型 ID"
            style={inputBase}
          />
        </div>

        {/* API Key（cloud 必填；local/custom 可空=占位 key） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>
            API Key {!isLocal && <span aria-hidden style={{ color: "#DC2626" }}>*</span>}
          </span>
          <input
            data-testid="provider-add-key-input"
            autoComplete="new-password"
            name="provider-api-token"
            type={isLocal ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={submitting}
            placeholder={
              isLocal
                ? `本地 provider 无需密钥，可留空`
                : `输入 ${trimmedProvider || "provider"} 的 API token`
            }
            style={inputBase}
          />
          <span style={hintStyle}>
            {isLocal
              ? "本地模型无鉴权，留空保存即完成配置（worker 侧自动补占位 key）"
              : "token 经 AES-256-GCM 加密落库，按 provider 粒度保存"}
          </span>
        </div>

        {/* 同步到节点（worker 多选，未选=全部 worker） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
            <span style={labelStyle}>同步到节点</span>
            <span style={{ fontSize: fontSize.xs, color: activeBlue }}>未选则同步到全部 worker</span>
            <button
              type="button"
              data-testid="provider-add-select-all"
              onClick={() => setTargetWorkers(new Set(workers.map((w) => w.id)))}
              style={{
                fontSize: fontSize.xs,
                color: neutral[500],
                border: `1px solid ${neutral[200]}`,
                borderRadius: radius.sm,
                backgroundColor: "var(--color-surface)",
                padding: "2px 8px",
                cursor: "pointer",
                fontFamily: fontFamily.body,
                marginLeft: "auto",
              }}
            >
              全选
            </button>
          </div>
          <div
            data-testid="provider-add-workers"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.md,
              flexWrap: "wrap",
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: neutral[50],
              border: `1px solid ${neutral[200]}`,
            }}
          >
            {sortedWorkers.map((w) => {
              const checked = targetWorkers.has(w.id);
              const online = w.status !== "offline";
              return (
                <label
                  key={w.id}
                  data-worker-id={w.id}
                  data-online={online ? "true" : "false"}
                  data-checked={checked ? "true" : "false"}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: space.sm,
                    padding: `${space.xs + 2}px ${space.md}px`,
                    borderRadius: radius.pill,
                    backgroundColor: checked ? "rgba(13,148,136,0.10)" : "var(--color-surface)",
                    border: `1px solid ${checked ? "rgba(13,148,136,0.22)" : neutral[200]}`,
                    cursor: "pointer",
                    fontSize: fontSize.md,
                    color: neutral[700],
                    fontFamily: fontFamily.body,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleWorker(w.id)}
                    style={{ accentColor: activeBlue, cursor: "pointer" }}
                  />
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      backgroundColor: online ? "#059669" : "var(--color-neutral-400)",
                      flexShrink: 0,
                    }}
                  />
                  {w.name ?? w.id}
                  <span style={{ fontSize: fontSize.xs, color: online ? "#059669" : neutral[400] }}>
                    {online ? "在线" : "离线"}
                  </span>
                </label>
              );
            })}
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
              定向下发走 enqueueCommand；未选任何 worker 时走 broadcastCommand 全量广播（C5）
            </span>
          </div>
        </div>

        {error && (
          <div
            data-testid="provider-add-modal-error"
            role="alert"
            style={{
              fontSize: fontSize.sm,
              color: "#DC2626",
              display: "flex",
              alignItems: "center",
              gap: space.xs,
            }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {error}
          </div>
        )}

        {/* 底部操作 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button
            type="button"
            data-testid="provider-add-modal-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
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
            取消
          </button>
          <button
            type="button"
            data-testid="provider-add-modal-save"
            disabled={submitting || !canSave}
            onClick={() =>
              onSubmit({
                providerID: trimmedProvider,
                providerType,
                baseUrl: trimmedUrl,
                modelID: trimmedModel,
                name: name.trim(),
                token: token.trim(),
                targetWorkerIds:
                  targetWorkers.size > 0 ? Array.from(targetWorkers) : undefined,
              })
            }
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: activeBlue,
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: submitting || !canSave ? "default" : "pointer",
              opacity: submitting || !canSave ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(13,148,136,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "保存中…" : "保存并同步"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================ 编辑 Provider 配置弹窗（admin 专属） ================================ */

/**
 * Provider 级配置编辑（C7）：类型 + Base URL 一次改全（providerID 只读——它是凭据/配置段
 * 的身份键，改名等于换 provider）。
 * 保存走 PATCH /models/providers/:providerID（provider 级原子重写，逐行 PATCH 会撞
 * assertBaseUrlConsistent 409 且无法清空 baseUrl）；cloud 清空 Base URL = 回落官方端点。
 */
export interface EditProviderPayload {
  providerType: string;
  baseUrl: string;
}

interface EditProviderModalProps {
  open: boolean;
  provider: ProviderSummary | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: EditProviderPayload) => void;
}

export function EditProviderModal({
  open,
  provider,
  submitting,
  error,
  onClose,
  onSubmit,
}: EditProviderModalProps) {
  const [providerType, setProviderType] = useState("cloud");
  const [baseUrl, setBaseUrl] = useState("");

  const isLocal = providerType === "local" || providerType === "custom";

  useEffect(() => {
    if (!open || !provider) return;
    setProviderType(provider.providerType ?? "cloud");
    setBaseUrl(provider.baseUrl ?? "");
  }, [open, provider]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open || !provider) return null;

  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "var(--color-surface)",
    fontSize: fontSize.md,
    color: neutral[800],
    fontFamily: fontFamily.body,
  };

  const labelStyle: CSSProperties = {
    fontSize: fontSize.sm,
    fontWeight: 500,
    color: neutral[600],
  };

  const hintStyle: CSSProperties = {
    fontSize: fontSize.xs,
    color: neutral[400],
  };

  const trimmedUrl = baseUrl.trim();
  const urlValid = isLocal
    ? trimmedUrl.length > 0 &&
      trimmedUrl.length <= 512 &&
      BASE_URL_PATTERN.test(trimmedUrl)
    : trimmedUrl.length === 0 ||
      (trimmedUrl.length <= 512 && BASE_URL_PATTERN.test(trimmedUrl));
  const canSave = urlValid;

  return (
    <div
      data-testid="provider-edit-modal"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8%",
      }}
    >
      <div
        aria-hidden
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      <div
        style={{
          position: "relative",
          width: 480,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "calc(100% - 64px)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
          fontFamily: fontFamily.body,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              编辑 Provider 配置
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
              类型 / Base URL 对该 Provider 全部 {provider.modelCount} 个模型生效并下发到节点
            </div>
          </div>
          <button
            type="button"
            data-testid="provider-edit-modal-cancel"
            aria-label="关闭编辑 Provider 弹窗"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              flexShrink: 0,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              backgroundColor: "transparent",
              color: neutral[400],
              fontSize: fontSize.lg,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>Provider ID</span>
          <input
            data-testid="provider-edit-provider"
            value={provider.providerID}
            readOnly
            disabled
            style={{ ...inputBase, fontFamily: fontFamily.mono, color: neutral[400] }}
          />
          <span style={hintStyle}>Provider ID 为身份键，不可修改</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>类型</span>
          <div data-testid="provider-edit-type" style={{ display: "flex", gap: space.sm }}>
            {PROVIDER_TYPE_OPTIONS.map((opt) => {
              const active = providerType === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  data-type={opt.value}
                  data-active={active ? "true" : "false"}
                  onClick={() => setProviderType(opt.value)}
                  disabled={submitting}
                  style={{
                    flex: 1,
                    padding: `${space.sm}px ${space.md}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${active ? activeBlue : neutral[200]}`,
                    backgroundColor: active ? "rgba(13,148,136,0.10)" : "var(--color-surface)",
                    color: active ? activeBlue : neutral[600],
                    fontSize: fontSize.sm,
                    fontWeight: 500,
                    cursor: submitting ? "default" : "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <span style={hintStyle}>
            {isLocal
              ? "本地/自定义：Base URL 必填"
              : "云端：Base URL 留空即回落官方端点"}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>
            Base URL {isLocal && <span aria-hidden style={{ color: "#DC2626" }}>*</span>}
          </span>
          <input
            data-testid="provider-edit-baseurl-input"
            autoComplete="off"
            name="provider-edit-base-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={submitting}
            placeholder={isLocal ? "如 http://host:8000/v1" : "留空 = 官方端点"}
            style={{ ...inputBase, fontFamily: fontFamily.mono }}
          />
          {baseUrl.length > 0 && !urlValid && (
            <span style={{ ...hintStyle, color: "#DC2626" }}>需为 http(s) URL</span>
          )}
        </div>

        {error && (
          <div
            data-testid="provider-edit-modal-error"
            role="alert"
            style={{
              fontSize: fontSize.sm,
              color: "#DC2626",
              display: "flex",
              alignItems: "center",
              gap: space.xs,
            }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button
            type="button"
            data-testid="provider-edit-modal-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
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
            取消
          </button>
          <button
            type="button"
            data-testid="provider-edit-modal-save"
            disabled={submitting || !canSave}
            onClick={() =>
              onSubmit({ providerType, baseUrl: trimmedUrl })
            }
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: activeBlue,
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: submitting || !canSave ? "default" : "pointer",
              opacity: submitting || !canSave ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(13,148,136,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "保存中…" : "保存并同步"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================ 模型能力配置弹窗（admin 专属） ================================
 * C8：per-model 能力声明 → PATCH /models/:id {capabilities}（后端整 JSON 替换，随后 C6 门控下发）。
 * - limit.context 是最关键字段：opencode 1.18.31 实测——不配置 = 该模型视为上下文 0，
 *   isOverflow() 恒 false → 自动压缩永不触发（上下文静默溢出）且上下文 meter 错误；
 *   hint 必须写明该后果。
 * - limit 仅 context/output 均为正整数时发送（后端校验与 opencode 均要求成对；
 *   半填 limit 会被丢弃）；否则内联报错并禁用保存。
 * - 布尔（reasoning/toolCall/temperature/attachment）：toolCall 未配置时默认勾选
 *   （opencode 默认 true）。发送规则：原值中存在的键始终回送（整对象替换，漏发会被
 *   抹掉）+ 用户触碰过的键——未触碰且原值没有的键不发送（避免未配置时把
 *   toolCall:true 写进 DB，行为与 opencode 默认保持等价）。
 * - 「清空配置」= 发送 {capabilities:{}}（清空整对象）。
 * - options 为 JSON textarea + reasoningEffort 快速选择双向同步（思考强度只能经
 *   options 配置，opencode 无一等字段）；非法 JSON → 内联报错、不提交。
 * - 探测 POST /models/probe-endpoint {baseUrl} → {models:[{id,context?}]}
 *   （vLLM max_model_len → context）：打开弹窗且 context 未配置时自动探测一次
 *   （非阻塞、不覆盖用户已输入值）；「探测」按钮可重跑；端点永不抛错，
 *   空结果 = 「探测无结果，请手动填写」。
 */

/** 模态白名单（对齐后端 MODEL_MODALITIES 枚举） */
const MODALITY_OPTIONS = ["text", "audio", "image", "video", "pdf"] as const;

/** 思考强度快速选择（写入 options.reasoningEffort；""=无） */
const EFFORT_OPTIONS = [
  { value: "", label: "无" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "minimal", label: "minimal" },
] as const;

/** options JSON 解析（null=非法；空串 = 空对象） */
function parseOptionsJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 探测响应（vLLM max_model_len → context；无该字段的端点只回 id） */
interface ProbeEndpointResponse {
  models: { id: string; context?: number }[];
}

interface ModelCapabilitiesModalProps {
  open: boolean;
  model: ApiModel | null;
  /** Provider 的 Base URL（探测数据源 {baseUrl}/models）；null = 无探测能力 */
  baseUrl: string | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (capabilities: ApiModelCapabilities) => void;
}

export function ModelCapabilitiesModal({
  open,
  model,
  baseUrl,
  submitting,
  error,
  onClose,
  onSubmit,
}: ModelCapabilitiesModalProps) {
  const [contextStr, setContextStr] = useState("");
  const [outputStr, setOutputStr] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [toolCall, setToolCall] = useState(true);
  const [temperature, setTemperature] = useState(false);
  const [attachment, setAttachment] = useState(false);
  const [inputModalities, setInputModalities] = useState<Set<string>>(new Set());
  const [outputModalities, setOutputModalities] = useState<Set<string>>(new Set());
  const [optionsText, setOptionsText] = useState("");
  const [effort, setEffort] = useState("");
  const [probeResult, setProbeResult] = useState<{ text: string; ok: boolean } | null>(null);
  const [probePending, setProbePending] = useState(false);
  /** 原 capabilities 中存在哪些键（整对象替换 → 须回送，否则被抹掉） */
  const presentRef = useRef<{
    reasoning: boolean;
    toolCall: boolean;
    temperature: boolean;
    attachment: boolean;
    modalities: boolean;
    options: boolean;
  } | null>(null);
  /** 用户触碰过的字段（触碰 + 原值没有 → 发送） */
  const [touched, setTouched] = useState<Set<string>>(new Set());
  /** 「清空配置」标记：true=发送 {} 清空全部（用户再编辑任一字段即复位） */
  const [cleared, setCleared] = useState(false);
  /** 覆盖保护：用户已输入后，探测结果不再覆盖 context */
  const contextTypedRef = useRef(false);
  /** 探测请求序号（忽略重跑/关闭后的过期响应） */
  const probeSeqRef = useRef(0);

  const markTouched = (key: string) => {
    setCleared(false);
    setTouched((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const runProbe = useCallback(() => {
    if (!model) return;
    if (!baseUrl) {
      setProbeResult({
        text: "该 Provider 无 Base URL（官方端点），无法探测，请手动填写",
        ok: false,
      });
      return;
    }
    const seq = ++probeSeqRef.current;
    setProbePending(true);
    api
      .post<ProbeEndpointResponse>("/models/probe-endpoint", { baseUrl })
      .then(
        (res) => {
          if (seq !== probeSeqRef.current) return;
          setProbePending(false);
          const models = res?.models ?? [];
          const hit =
            models.find((m) => m.id === model.modelID && m.context != null) ??
            models.find((m) => m.context != null);
          if (hit && hit.context != null) {
            if (!contextTypedRef.current) setContextStr(String(hit.context));
            setProbeResult({
              text: `已从端点探测到上下文 ${hit.context}`,
              ok: true,
            });
          } else {
            setProbeResult({
              text: "探测无结果：端点未返回上下文长度，请手动填写",
              ok: false,
            });
          }
        },
        () => {
          if (seq !== probeSeqRef.current) return;
          setProbePending(false);
          setProbeResult({ text: "探测请求失败，请手动填写", ok: false });
        }
      );
  }, [model, baseUrl]);

  /* 打开时从模型行现有 capabilities 初始化（toolCall 未配置默认 true = opencode 默认）；
   * context 未配置且 baseUrl 可用 → 自动探测一次（非阻塞） */
  useEffect(() => {
    if (!open) return;
    const caps = model?.capabilities;
    const capCtx = caps?.limit?.context;
    const capOut = caps?.limit?.output;
    setContextStr(capCtx != null ? String(capCtx) : "");
    setOutputStr(capOut != null ? String(capOut) : "");
    setReasoning(!!caps?.reasoning);
    setToolCall(caps?.toolCall ?? true);
    setTemperature(!!caps?.temperature);
    setAttachment(!!caps?.attachment);
    setInputModalities(new Set(caps?.modalities?.input ?? []));
    setOutputModalities(new Set(caps?.modalities?.output ?? []));
    setOptionsText(caps?.options ? JSON.stringify(caps.options, null, 2) : "");
    const re = caps?.options?.reasoningEffort;
    setEffort(
      typeof re === "string" && re !== "" && EFFORT_OPTIONS.some((o) => o.value === re)
        ? re
        : ""
    );
    presentRef.current = {
      reasoning: !!caps && caps.reasoning !== undefined,
      toolCall: !!caps && caps.toolCall !== undefined,
      temperature: !!caps && caps.temperature !== undefined,
      attachment: !!caps && caps.attachment !== undefined,
      modalities: !!caps && caps.modalities != null,
      options: !!caps && caps.options != null,
    };
    setTouched(new Set());
    setCleared(false);
    setProbeResult(null);
    contextTypedRef.current = false;
    if (caps?.limit?.context == null && baseUrl) runProbe();
  }, [open, model, baseUrl, runProbe]);

  /* Escape 关闭 */
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open || !model) return null;

  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "var(--color-surface)",
    fontSize: fontSize.md,
    color: neutral[800],
    fontFamily: fontFamily.body,
  };

  const labelStyle: CSSProperties = {
    fontSize: fontSize.sm,
    fontWeight: 500,
    color: neutral[600],
  };

  const hintStyle: CSSProperties = {
    fontSize: fontSize.xs,
    color: neutral[400],
  };

  /* limit 成对校验：均正整数才可发送（半填会被后端校验丢弃） */
  const contextTrim = contextStr.trim();
  const outputTrim = outputStr.trim();
  const contextNum = Number(contextTrim);
  const outputNum = Number(outputTrim);
  const contextPos = contextTrim !== "" && Number.isInteger(contextNum) && contextNum > 0;
  const outputPos = outputTrim !== "" && Number.isInteger(outputNum) && outputNum > 0;
  const limitError: string | null =
    contextTrim === "" && outputTrim === ""
      ? null
      : contextPos && outputPos
        ? null
        : contextTrim !== "" && outputTrim !== ""
          ? "context / output 须均为正整数"
          : "context 与 output 需成对填写（半填的 limit 会被后端校验丢弃）";

  /* options JSON 校验（非法 → 内联报错、不提交） */
  const optionsObj = parseOptionsJson(optionsText);
  const optionsError =
    optionsObj === null
      ? 'options 需为合法 JSON 对象，如 {"reasoningEffort":"high"}'
      : null;

  const canSave = !limitError && !optionsError && !submitting;

  /** 组装 PATCH body：省略空/未定义值（发送规则见组件头注释） */
  const buildCapabilities = (): ApiModelCapabilities => {
    if (cleared) return {};
    const caps: ApiModelCapabilities = {};
    const present = presentRef.current;
    if (!present) return caps;
    if (contextPos && outputPos) {
      caps.limit = { context: contextNum, output: outputNum };
    }
    if (touched.has("reasoning") || present.reasoning) caps.reasoning = reasoning;
    if (touched.has("toolCall") || present.toolCall) caps.toolCall = toolCall;
    if (touched.has("temperature") || present.temperature) caps.temperature = temperature;
    if (touched.has("attachment") || present.attachment) caps.attachment = attachment;
    if (
      touched.has("modalities-input") ||
      touched.has("modalities-output") ||
      present.modalities
    ) {
      const modalities: { input?: string[]; output?: string[] } = {};
      if (inputModalities.size > 0) {
        modalities.input = MODALITY_OPTIONS.filter((m) => inputModalities.has(m));
      }
      if (outputModalities.size > 0) {
        modalities.output = MODALITY_OPTIONS.filter((m) => outputModalities.has(m));
      }
      if (modalities.input || modalities.output) caps.modalities = modalities;
    }
    if (
      optionsObj &&
      Object.keys(optionsObj).length > 0 &&
      (touched.has("options") || present.options)
    ) {
      caps.options = optionsObj;
    }
    return caps;
  };

  const toggleModality = (dir: "input" | "output", value: string) => {
    const setter = dir === "input" ? setInputModalities : setOutputModalities;
    markTouched(`modalities-${dir}`);
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  /* 快速选择 → 合并进 options 对象（保留其他键） */
  const onEffortChange = (value: string) => {
    setEffort(value);
    markTouched("options");
    const base = parseOptionsJson(optionsText) ?? {};
    const next = { ...base };
    if (value === "") delete next.reasoningEffort;
    else next.reasoningEffort = value;
    setOptionsText(JSON.stringify(next, null, 2));
  };

  /* textarea → 重解析，含合法 reasoningEffort 时回映快速选择 */
  const onOptionsTextChange = (text: string) => {
    setOptionsText(text);
    markTouched("options");
    const parsed = parseOptionsJson(text);
    if (parsed) {
      const re = parsed.reasoningEffort;
      setEffort(
        typeof re === "string" && re !== "" && EFFORT_OPTIONS.some((o) => o.value === re)
          ? re
          : ""
      );
    }
  };

  /** 清空配置：全部字段置空 → 保存发送 {capabilities:{}} */
  const handleClear = () => {
    setContextStr("");
    setOutputStr("");
    setReasoning(false);
    setToolCall(false);
    setTemperature(false);
    setAttachment(false);
    setInputModalities(new Set());
    setOutputModalities(new Set());
    setOptionsText("");
    setEffort("");
    setTouched(new Set());
    setCleared(true);
    contextTypedRef.current = false;
  };

  const boolToggles = [
    {
      testid: "provider-model-reasoning-toggle",
      key: "reasoning",
      label: "reasoning · 推理",
      checked: reasoning,
      onToggle: () => {
        markTouched("reasoning");
        setReasoning((v) => !v);
      },
    },
    {
      testid: "provider-model-toolcall-toggle",
      key: "toolCall",
      label: "toolCall · 工具调用",
      checked: toolCall,
      onToggle: () => {
        markTouched("toolCall");
        setToolCall((v) => !v);
      },
    },
    {
      testid: "provider-model-temperature-toggle",
      key: "temperature",
      label: "temperature · 温度",
      checked: temperature,
      onToggle: () => {
        markTouched("temperature");
        setTemperature((v) => !v);
      },
    },
    {
      testid: "provider-model-attachment-toggle",
      key: "attachment",
      label: "attachment · 附件",
      checked: attachment,
      onToggle: () => {
        markTouched("attachment");
        setAttachment((v) => !v);
      },
    },
  ];

  const modalityPillStyle = (checked: boolean): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    padding: "2px 8px",
    borderRadius: radius.pill,
    backgroundColor: checked ? "rgba(13,148,136,0.10)" : "var(--color-surface)",
    border: `1px solid ${checked ? "rgba(13,148,136,0.22)" : neutral[200]}`,
    cursor: "pointer",
    fontSize: fontSize.xs,
    color: neutral[700],
    fontFamily: fontFamily.body,
  });

  return (
    <div
      data-testid="provider-model-capabilities-modal"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8%",
      }}
    >
      <div
        aria-hidden
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      <div
        style={{
          position: "relative",
          width: 480,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "calc(100% - 64px)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
          fontFamily: fontFamily.body,
        }}
      >
        {/* 标题区 */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              配置模型能力
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
              保存后原样写入 worker 的 opencode.json 并下发到节点
            </div>
          </div>
          <button
            type="button"
            data-testid="provider-model-capabilities-cancel"
            aria-label="关闭模型能力配置弹窗"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              flexShrink: 0,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              backgroundColor: "transparent",
              color: neutral[400],
              fontSize: fontSize.lg,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* 只读：providerID/modelID + 模型名（目标行身份键） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>模型</span>
          <div
            data-testid="provider-model-capabilities-target"
            data-model-id={`${model.providerID}/${model.modelID}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              backgroundColor: neutral[50],
              border: `1px solid ${neutral[200]}`,
              fontSize: fontSize.sm,
              color: neutral[800],
              fontFamily: fontFamily.mono,
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {model.providerID}/{model.modelID}
            </span>
            <span style={{ color: neutral[400], flexShrink: 0 }}>{model.name}</span>
          </div>
        </div>

        {/* limit（最关键）：未配置 = 视为上下文 0 → 自动压缩永不触发 */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.xs,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: "rgba(13,148,136,0.05)",
            border: "1px solid rgba(13,148,136,0.25)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <span style={labelStyle}>limit · 上下文 / 输出 token</span>
            <button
              type="button"
              data-testid="provider-model-probe-button"
              disabled={probePending || submitting || !baseUrl}
              onClick={runProbe}
              style={{
                marginLeft: "auto",
                padding: "2px 10px",
                borderRadius: radius.pill,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "var(--color-surface)",
                color: probePending ? neutral[400] : activeBlue,
                fontSize: fontSize.xs,
                cursor: probePending || !baseUrl ? "default" : "pointer",
                opacity: probePending || !baseUrl ? 0.5 : 1,
                fontFamily: fontFamily.body,
                whiteSpace: "nowrap",
              }}
            >
              {probePending ? "探测中…" : "↻ 探测"}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.sm }}>
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
              <span style={hintStyle}>context · 上下文窗口</span>
              <input
                data-testid="provider-model-context-input"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                autoComplete="off"
                name="model-cap-context"
                value={contextStr}
                onChange={(e) => {
                  contextTypedRef.current = true;
                  setContextStr(e.target.value);
                }}
                disabled={submitting}
                placeholder="如 262144"
                style={{
                  ...inputBase,
                  padding: `${space.sm}px ${space.md}px`,
                  fontFamily: fontFamily.mono,
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
              <span style={hintStyle}>output · 最大输出</span>
              <input
                data-testid="provider-model-output-input"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                autoComplete="off"
                name="model-cap-output"
                value={outputStr}
                onChange={(e) => setOutputStr(e.target.value)}
                disabled={submitting}
                placeholder="如 32768"
                style={{
                  ...inputBase,
                  padding: `${space.sm}px ${space.md}px`,
                  fontFamily: fontFamily.mono,
                }}
              />
            </div>
          </div>
          {limitError ? (
            <span style={{ ...hintStyle, color: "#DC2626" }}>{limitError}</span>
          ) : (
            <span style={{ ...hintStyle, color: "#D97706" }}>
              最关键：不配置时 opencode 视为上下文 0——该模型的自动压缩不会触发
              （上下文静默溢出），上下文 meter 也不准确
            </span>
          )}
          {probeResult && (
            <span
              style={{ ...hintStyle, color: probeResult.ok ? activeBlue : "#D97706" }}
            >
              {probeResult.text}
            </span>
          )}
        </div>

        {/* 能力开关（opencode 默认：toolCall=true，其余 false） */}
        <div
          data-testid="provider-model-capabilities-toggles"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: `${space.sm}px ${space.md}px`,
          }}
        >
          {boolToggles.map((t) => (
            <label
              key={t.key}
              data-checked={t.checked ? "true" : "false"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.sm}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: t.checked ? "rgba(13,148,136,0.08)" : "var(--color-surface)",
                border: `1px solid ${t.checked ? "rgba(13,148,136,0.22)" : neutral[200]}`,
                cursor: "pointer",
                fontSize: fontSize.sm,
                color: neutral[700],
                fontFamily: fontFamily.body,
              }}
            >
              <input
                data-testid={t.testid}
                type="checkbox"
                checked={t.checked}
                onChange={t.onToggle}
                disabled={submitting}
                style={{ accentColor: activeBlue, cursor: "pointer" }}
              />
              {t.label}
            </label>
          ))}
        </div>

        {/* 输入模态（text/audio/image/video/pdf 白名单） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>输入模态</span>
          <div
            data-testid="provider-model-modalities-input"
            style={{ display: "flex", flexWrap: "wrap", gap: space.xs }}
          >
            {MODALITY_OPTIONS.map((m) => {
              const checked = inputModalities.has(m);
              return (
                <label
                  key={m}
                  data-modality={m}
                  data-checked={checked ? "true" : "false"}
                  style={modalityPillStyle(checked)}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleModality("input", m)}
                    disabled={submitting}
                    style={{ accentColor: activeBlue, cursor: "pointer" }}
                  />
                  {m}
                </label>
              );
            })}
          </div>
        </div>

        {/* 输出模态 */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={labelStyle}>输出模态</span>
          <div
            data-testid="provider-model-modalities-output"
            style={{ display: "flex", flexWrap: "wrap", gap: space.xs }}
          >
            {MODALITY_OPTIONS.map((m) => {
              const checked = outputModalities.has(m);
              return (
                <label
                  key={m}
                  data-modality={m}
                  data-checked={checked ? "true" : "false"}
                  style={modalityPillStyle(checked)}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleModality("output", m)}
                    disabled={submitting}
                    style={{ accentColor: activeBlue, cursor: "pointer" }}
                  />
                  {m}
                </label>
              );
            })}
          </div>
        </div>

        {/* options（透传 provider SDK 的 JSON）+ 思考强度快速选择（写 reasoningEffort） */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <span style={labelStyle}>options · 透传 SDK</span>
            <select
              data-testid="provider-model-effort-select"
              value={effort}
              onChange={(e) => onEffortChange(e.target.value)}
              disabled={submitting}
              style={{
                marginLeft: "auto",
                padding: "2px 8px",
                borderRadius: radius.sm,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "var(--color-surface)",
                color: neutral[700],
                fontSize: fontSize.xs,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              {EFFORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  思考 {o.label}
                </option>
              ))}
            </select>
          </div>
          <textarea
            data-testid="provider-model-options-input"
            value={optionsText}
            onChange={(e) => onOptionsTextChange(e.target.value)}
            disabled={submitting}
            rows={4}
            spellCheck={false}
            placeholder='{"reasoningEffort":"high"}'
            style={{
              ...inputBase,
              fontFamily: fontFamily.mono,
              resize: "vertical",
              minHeight: 72,
              lineHeight: 1.5,
            }}
          />
          {optionsError ? (
            <span style={{ ...hintStyle, color: "#DC2626" }}>{optionsError}</span>
          ) : (
            <span style={hintStyle}>
              思考强度只能经 options 配置（opencode 无一等字段）；留空 = 无 options
            </span>
          )}
        </div>

        {error && (
          <div
            data-testid="provider-model-capabilities-error"
            role="alert"
            style={{
              fontSize: fontSize.sm,
              color: "#DC2626",
              display: "flex",
              alignItems: "center",
              gap: space.xs,
            }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>!</span>
            {error}
          </div>
        )}

        {/* 底部操作：清空配置 = 发送 {capabilities:{}} */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: space.sm,
          }}
        >
          <button
            type="button"
            data-testid="provider-model-capabilities-clear"
            onClick={handleClear}
            disabled={submitting}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: "#DC2626",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: submitting ? "default" : "pointer",
              opacity: submitting ? 0.5 : 1,
              fontFamily: fontFamily.body,
            }}
          >
            清空配置
          </button>
          <div style={{ display: "flex", gap: space.sm }}>
            <button
              type="button"
              data-testid="provider-model-capabilities-cancel"
              onClick={onClose}
              disabled={submitting}
              style={{
                padding: `${space.sm + 2}px ${space.lg}px`,
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
              取消
            </button>
            <button
              type="button"
              data-testid="provider-model-capabilities-save"
              disabled={!canSave}
              onClick={() => onSubmit(buildCapabilities())}
              style={{
                padding: `${space.sm + 2}px ${space.lg}px`,
                borderRadius: radius.md,
                border: "none",
                backgroundColor: activeBlue,
                color: "#FFFFFF",
                fontSize: fontSize.md,
                fontWeight: 500,
                cursor: canSave ? "pointer" : "default",
                opacity: canSave ? 1 : 0.6,
                boxShadow: "0 6px 16px rgba(13,148,136,.3)",
                fontFamily: fontFamily.body,
              }}
            >
              {submitting ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================ Tab 视图主组件 ================================ */

export default function ProvidersTab() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.roleName === "admin";
  const queryClient = useQueryClient();

  /* 配置弹窗（open=providerID，false=关闭） */
  const [configureOpen, setConfigureOpen] = useState<string | false>(false);
  const [configureError, setConfigureError] = useState<string | null>(null);
  /* 新增 Provider 弹窗（admin 专属；true=打开）与弹窗内错误回显 */
  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  /* 删除凭据确认弹窗（target=providerID，非空即打开——OBS-003：删除不可恢复，需二次确认） */
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  /* 二级下钻：搜索关键字（provider id 大小写不敏感 contains 本地过滤）+ 展开态
   *（Record<providerID, true>，多行可同时展开，对齐 agents 页 collapsed map 模式） */
  const [keyword, setKeyword] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = (providerID: string) =>
    setExpanded((prev) => ({ ...prev, [providerID]: !prev[providerID] }));
  /* 列表级操作错误（删除凭据失败时弹窗未开，configureError 无处渲染——独立 state，
   * 列表顶部渲染错误条；对齐 skills 页 notice 模式） */
  const [providerError, setProviderError] = useState<string | null>(null);

  /* 列表级错误条 3s 自动消失（对齐 skills 页 notice 行为） */
  useEffect(() => {
    if (!providerError) return;
    const timer = setTimeout(() => setProviderError(null), 3000);
    return () => clearTimeout(timer);
  }, [providerError]);

  /* Provider 聚合：GET /models/providers（C9 后端端点一次请求：
   * providerID + enabled 模型数 + 凭据状态三态 + 脱敏 fingerprint，成员只读） */
  const providersQuery = useQuery({
    queryKey: ["model-providers"],
    queryFn: () => api.get<ProviderSummary[]>("/models/providers"),
    enabled: !!user,
  });
  const providers = useMemo(() => providersQuery.data ?? [], [providersQuery.data]);
  const kw = keyword.trim().toLowerCase();
  const filteredProviders =
    kw === "" ? providers : providers.filter((p) => p.providerID.toLowerCase().includes(kw));

  /* worker 池：GET /workers（同步目标多选数据源） */
  const workersQuery = useQuery({
    queryKey: ["workers"],
    queryFn: () => api.get<ApiWorker[]>("/workers"),
    enabled: !!user,
  });
  const workers = workersQuery.data ?? [];

  /* providers 响应不含模型 id（C9 只聚合计数/凭据态）——保存凭据前保底解析
   * 该 provider 首个模型 id（凭据按 provider 粒度，C4：同 provider 任一模型 id 均可）。
   * providerID 走 contains 模糊匹配，取回后前端精确过滤防前缀误命中。
   * （删除凭据已改按 provider 直删，不再走 resolveModelId——见 revokeMutation） */
  const resolveModelId = async (providerID: string): Promise<string> => {
    const res = await api.get<ModelsResponse>("/models", {
      query: { providerID, page: 1, pageSize: 100 },
    });
    const first = res.items.find((m) => m.providerID === providerID);
    if (!first) throw new Error(`provider ${providerID} 无可用模型`);
    return first.id;
  };

  const configuredCount = providers.filter((p) => toStatus(p) === "configured").length;

  /* 保存凭据：POST /models/:id/credentials（保底解析该 provider 模型 id）
   * 指定 worker → 定向 enqueueCommand；未选 → 全量 broadcastCommand（C5） */
  const saveCredentialMutation = useMutation({
    mutationFn: ({
      providerID,
      token,
      targetWorkerIds,
    }: {
      providerID: string;
      token: string;
      targetWorkerIds?: string[];
    }) =>
      resolveModelId(providerID).then((modelId) =>
        api.post<CredentialView>(`/models/${modelId}/credentials`, {
          token,
          ...(targetWorkerIds && targetWorkerIds.length > 0 ? { targetWorkerIds } : {}),
        })
      ),
    onError: (err) => {
      console.error("[providers-tab] save credential failed:", err);
      setConfigureError(
        isApiError(err)
          ? err.message
          : err instanceof Error
            ? err.message
            : "保存失败，请稍后重试"
      );
    },
    onSuccess: () => {
      setConfigureOpen(false);
      setConfigureError(null);
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      /* 凭据态缓存一并失效 */
      queryClient.invalidateQueries({ queryKey: ["model-credentials"] });
    },
  });

  /* 吊销凭据：DELETE /models/providers/:providerID/credentials
   * 按 provider 粒度直删（revokedAt 软撤销，不依赖模型 id）——修复原先
   * resolveModelId 每次裸 GET 取首个模型 id 导致每次 DELETE 命中不同模型 id、
   * 且 DELETE 404 静默失败（无 onError）的问题。 */
  const revokeMutation = useMutation({
    mutationFn: (providerID: string) =>
      api.delete<CredentialView>(
        `/models/providers/${providerID}/credentials`
      ),
    onSuccess: () => {
      setProviderError(null);
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      queryClient.invalidateQueries({ queryKey: ["model-credentials"] });
    },
    onError: (err) => {
      setProviderError(isApiError(err) ? err.message : "删除失败，请稍后重试");
    },
  });

  /* 新增 Provider：两步复用既有端点（详见 AddProviderModal 头注释）——
   * ① POST /models 创建锚点模型行（新 Provider 立即出现在 /models/providers 聚合）；
   * ② POST /models/:id/credentials 保存凭据（cloud 必填；local/custom 空=占位 key）+ C5 下发。
   * ② 失败时①已落库：Provider 已入列（徽章未配置），用户可经「配置」补救——错误在弹窗内回显。 */
  const addProviderMutation = useMutation({
    mutationFn: async (p: AddProviderPayload) => {
      const model = await api.post<ApiModel>("/models", {
        providerID: p.providerID,
        modelID: p.modelID,
        name: p.name || p.modelID,
        providerType: p.providerType,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      });
      return api.post<CredentialView>(`/models/${model.id}/credentials`, {
        token: p.token,
        ...(p.targetWorkerIds && p.targetWorkerIds.length > 0
          ? { targetWorkerIds: p.targetWorkerIds }
          : {}),
      });
    },
    onSuccess: () => {
      setAddOpen(false);
      setAddError(null);
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["model-credentials"] });
      queryClient.invalidateQueries({ queryKey: ["workers"] });
    },
    onError: (err) => {
      console.error("[providers-tab] add provider failed:", err);
      setAddError(
        isApiError(err)
          ? err.message
          : err instanceof Error
            ? err.message
            : "新增失败，请稍后重试"
      );
    },
  });

  const configuringProviderRow = useMemo(
    () => providers.find((p) => p.providerID === configureOpen),
    [providers, configureOpen]
  );
  const configuringProvider = configuringProviderRow?.providerID;
  const configuringProviderType = configuringProviderRow?.providerType ?? null;

  /* 编辑 Provider 配置（providerType/baseUrl）：PATCH /models/providers/:providerID
   * provider 级原子重写（逐行 PATCH 会撞 baseUrl 一致性 409 且无法清空 baseUrl）；
   * cloud 提交空串 → 后端归一化为 null（清空 = 回落官方端点）；成功后 C6 下发到节点。 */
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const editProviderRow = useMemo(
    () => providers.find((p) => p.providerID === editTarget) ?? null,
    [providers, editTarget]
  );
  const editProviderMutation = useMutation({
    mutationFn: ({ providerID, payload }: { providerID: string; payload: EditProviderPayload }) =>
      api.patch<ProviderSummary>(`/models/providers/${providerID}`, {
        providerType: payload.providerType,
        baseUrl: payload.baseUrl.length > 0 ? payload.baseUrl : null,
      }),
    onSuccess: () => {
      setEditTarget(null);
      setEditError(null);
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["model-credentials"] });
    },
    onError: (err) => {
      console.error("[providers-tab] edit provider failed:", err);
      setEditError(
        isApiError(err)
          ? err.message
          : err instanceof Error
            ? err.message
            : "保存失败，请稍后重试"
      );
    },
  });

  /* 模型能力配置（admin 专属）：target = 模型行（id=md_xxx + capabilities 预填源）
   * + 该 Provider 的 baseUrl（探测数据源）；保存 → PATCH /models/:id {capabilities}
   *（整对象替换，body 组装规则见 ModelCapabilitiesModal 头注释） */
  const [modelEditTarget, setModelEditTarget] = useState<{
    model: ApiModel;
    baseUrl: string | null;
  } | null>(null);
  const [modelEditError, setModelEditError] = useState<string | null>(null);
  const modelEditMutation = useMutation({
    mutationFn: ({
      modelId,
      capabilities,
    }: {
      modelId: string;
      capabilities: ApiModelCapabilities;
    }) => api.patch<ApiModel>(`/models/${modelId}`, { capabilities }),
    onSuccess: () => {
      setModelEditTarget(null);
      setModelEditError(null);
      /* ["models", {providerID}] 为 ["models"] 前缀，一并失效刷新下钻列表 */
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
    },
    onError: (err) => {
      console.error("[providers-tab] edit model capabilities failed:", err);
      setModelEditError(
        isApiError(err)
          ? err.message
          : err instanceof Error
            ? err.message
            : "保存失败，请稍后重试"
      );
    },
  });

  /* 模型同步：POST /models/sync（目录 Tab 下线后迁入本 Tab 头部，admin 专属）——
   * 按 worker 实时上报校正目录（live 模型补齐、孤儿禁用）；成功后刷新 providers 聚合
   * 与各 provider 下钻模型列表（["models", {providerID}] 为 ["models"] 前缀，一并失效）。 */
  const [syncHint, setSyncHint] = useState<string | null>(null);
  const syncMutation = useMutation({
    mutationFn: () => api.post<{ synced: number; disabled: number; liveModels: string[] }>("/models/sync", {}),
    onSuccess: (res) => {
      setSyncHint(`同步完成：live ${res.liveModels.length} 个，已校正 ${res.synced} 个，禁用孤儿 ${res.disabled} 个`);
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      queryClient.invalidateQueries({ queryKey: ["model-credentials"] });
      queryClient.invalidateQueries({ queryKey: ["workers"] });
      setTimeout(() => setSyncHint(null), 4000);
    },
    onError: (err) => {
      setSyncHint(isApiError(err) ? err.message : "同步失败");
      setTimeout(() => setSyncHint(null), 4000);
    },
  });

  return (
    <div
      data-testid="providers-root"
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
        overflow: "auto",
      }}
    >
      <style>{rowCss}</style>

      <main
        style={{
          flex: 1,
          minHeight: 0,
          padding: `${space.xl}px`,
        }}
      >
        <div
          style={{
            maxWidth: 1080,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: space.lg,
          }}
        >
          {/* ① 工具条：标题 + 计数 */}
          <div
            data-testid="providers-toolbar"
            style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}
          >
            <span style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900] }}>
              Provider 管理
            </span>
            <span
              style={{
                fontSize: fontSize.xs,
                color: neutral[500],
                backgroundColor: "var(--color-surface)",
                border: `1px solid ${neutral[200]}`,
                borderRadius: radius.pill,
                padding: "2px 10px",
                fontFamily: fontFamily.mono,
              }}
            >
              {providers.length} 个 Provider · 已配置 {configuredCount}
            </span>
            <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: "auto" }}>
              凭证管理 · 按 Provider 粒度配置，支持同步到节点（worker）
            </span>
            {isAdmin && (
              <>
                <button
                  type="button"
                  data-testid="sync-models-button"
                  disabled={syncMutation.isPending}
                  onClick={() => syncMutation.mutate()}
                  style={{
                    padding: `${space.sm}px ${space.lg}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "var(--color-surface)",
                    color: neutral[700],
                    fontSize: fontSize.md,
                    fontWeight: 500,
                    cursor: syncMutation.isPending ? "default" : "pointer",
                    opacity: syncMutation.isPending ? 0.6 : 1,
                    fontFamily: fontFamily.body,
                  }}
                >
                  {syncMutation.isPending ? "同步中…" : "↻ 同步"}
                </button>
                <button
                  type="button"
                  data-testid="provider-add-button"
                  onClick={() => {
                    setAddError(null);
                    setAddOpen(true);
                  }}
                  style={{
                    padding: `${space.sm}px ${space.lg}px`,
                    borderRadius: radius.md,
                    border: "none",
                    backgroundColor: activeBlue,
                    color: "#FFFFFF",
                    fontSize: fontSize.md,
                    fontWeight: 500,
                    cursor: "pointer",
                    boxShadow: "0 4px 12px rgba(13,148,136,.25)",
                    fontFamily: fontFamily.body,
                  }}
                >
                  ＋ 新增 Provider
                </button>
              </>
            )}
          </div>
          {syncHint && (
            <div
              data-testid="sync-hint"
              style={{
                fontSize: fontSize.sm,
                color: neutral[600],
                backgroundColor: "rgba(13,148,136,0.08)",
                border: "1px solid rgba(13,148,136,0.15)",
                borderRadius: radius.md,
                padding: `${space.sm}px ${space.md}px`,
              }}
            >
              {syncHint}
            </div>
          )}

          {/* 列表级操作错误条（删除凭据失败；role=alert + 手动关闭，3s 自动消失） */}
          {providerError && (
            <div
              data-testid="provider-error-banner"
              role="alert"
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.sm + 2}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: "rgba(239,68,68,0.10)",
                border: "1px solid rgba(239,68,68,0.22)",
                color: "#DC2626",
                fontSize: fontSize.sm,
                fontWeight: 500,
                fontFamily: fontFamily.body,
              }}
            >
              <span aria-hidden style={{ fontWeight: 700 }}>
                ⚠
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>{providerError}</span>
              <button
                type="button"
                data-testid="provider-error-dismiss"
                aria-label="关闭错误提示"
                onClick={() => setProviderError(null)}
                style={{
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  color: "#DC2626",
                  fontSize: fontSize.sm,
                  fontWeight: 700,
                  fontFamily: fontFamily.body,
                  padding: "0 2px",
                }}
              >
                ✕
              </button>
            </div>
          )}

          {/* 列表状态：loading / error */}
          {providersQuery.isPending ? (
            <div
              data-testid="providers-loading"
              style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xxl}px 0`, textAlign: "center" }}
            >
              加载中…
            </div>
          ) : providersQuery.isError ? (
            <div
              data-testid="providers-error"
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
                {isApiError(providersQuery.error) ? providersQuery.error.message : "加载 Provider 列表失败"}
              </div>
              <button
                type="button"
                data-testid="providers-retry"
                onClick={() => providersQuery.refetch()}
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
            /* ② Provider 列表（白卡容器 + 表头行 + 数据行） */
            <div
              data-testid="provider-list"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: space.sm,
                padding: space.md,
                borderRadius: radius.lg,
                backgroundColor: "var(--color-surface)",
                border: `1px solid ${neutral[200]}`,
                boxShadow: shadow.md,
              }}
            >
              {/* 列表头 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.md,
                  padding: `${space.sm}px ${space.md}px`,
                }}
              >
                <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>
                  全部 Provider
                </span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  凭据按 provider 粒度存储（C4）· 配置后即时下发到节点（C5）
                </span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: "auto" }}>
                  点击 ▸ 展开查看该 Provider 下的模型
                </span>
              </div>

              {/* 搜索框：provider id 大小写不敏感 contains 过滤 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.sm,
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: radius.md,
                  backgroundColor: neutral[50],
                  border: `1px solid ${neutral[200]}`,
                }}
              >
                <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400] }}>⌕</span>
                <input
                  data-testid="provider-search"
                  autoComplete="off"
                  name="provider-search"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索 Provider ID…"
                  style={{
                    flex: 1,
                    border: "none",
                    background: "transparent",
                    outline: "none",
                    fontSize: fontSize.md,
                    color: neutral[800],
                    fontFamily: fontFamily.body,
                  }}
                />
                {keyword.trim() !== "" && (
                  <span
                    style={{
                      fontSize: fontSize.xs,
                      color: neutral[400],
                      fontFamily: fontFamily.mono,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {filteredProviders.length} / {providers.length}
                  </span>
                )}
              </div>

              {/* 表头行（列宽与数据行一致） */}
              <div
                aria-hidden
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.lg,
                  padding: `${space.sm}px ${space.xl}px`,
                  fontSize: fontSize.xs,
                  fontWeight: 600,
                  color: neutral[400],
                  letterSpacing: "0.03em",
                }}
              >
                <span style={{ width: 220, flexShrink: 0 }}>PROVIDER</span>
                <span style={{ width: 100, flexShrink: 0 }}>模型数</span>
                <span style={{ flex: 1, minWidth: 0 }}>凭据状态</span>
                <span style={{ width: 220, flexShrink: 0 }}>FINGERPRINT</span>
                <span style={{ width: 240, flexShrink: 0, textAlign: "right" }}>操作</span>
              </div>

              {/* Provider 行（Level 1）+ 模型下钻面板（Level 2，行内展开） */}
              {filteredProviders.map((p) => {
                const status = toStatus(p);
                const fingerprint = p.fingerprint;
                const isOpen = !!expanded[p.providerID];
                return (
                  <div key={p.providerID}>
                  <div
                    data-testid="provider-item"
                    data-provider={p.providerID}
                    data-credential={status}
                    data-expanded={isOpen ? "true" : "false"}
                    className="pv-provider-row"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.lg,
                      padding: `${space.lg}px ${space.xl}px`,
                      borderRadius: isOpen ? `${radius.lg} ${radius.lg} 0 0` : radius.lg,
                      backgroundColor: "var(--color-surface)",
                      border: `1px solid ${neutral[200]}`,
                      borderBottom: isOpen ? "none" : `1px solid ${neutral[200]}`,
                      boxShadow: shadow.sm,
                      ...baseFont,
                    }}
                  >
                    {/* 展开 toggle（行内 expand/collapse，对齐 agents 页分组模式） */}
                    <button
                      type="button"
                      data-testid="provider-expand-toggle"
                      data-provider={p.providerID}
                      data-expanded={isOpen ? "true" : "false"}
                      aria-expanded={isOpen}
                      aria-label={isOpen ? `收起 ${p.providerID} 的模型` : `展开 ${p.providerID} 的模型`}
                      title={isOpen ? "收起模型列表" : "展开模型列表"}
                      onClick={() => toggleExpanded(p.providerID)}
                      style={{
                        width: 22,
                        height: 22,
                        flexShrink: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: radius.sm,
                        border: `1px solid ${neutral[200]}`,
                        backgroundColor: neutral[50],
                        color: neutral[500],
                        fontSize: fontSize.xs,
                        cursor: "pointer",
                        fontFamily: fontFamily.body,
                      }}
                    >
                      <span aria-hidden>{isOpen ? "▾" : "▸"}</span>
                    </button>
                    {/* provider 列 */}
                    <span
                      data-testid="provider-id"
                      data-provider={p.providerID}
                      style={{
                        width: 220,
                        flexShrink: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: space.sm,
                        fontSize: fontSize.md,
                        fontWeight: 600,
                        color: neutral[800],
                        fontFamily: fontFamily.mono,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 8,
                          height: 8,
                          flexShrink: 0,
                          borderRadius: "50%",
                          backgroundColor: activeBlue,
                        }}
                      />
                      {p.providerID}
                    </span>

                    {/* 模型数 */}
                    <span
                      data-testid="provider-model-count"
                      data-count={p.modelCount}
                      style={{
                        width: 100,
                        flexShrink: 0,
                        display: "inline-flex",
                        alignItems: "baseline",
                        gap: space.xs,
                        fontSize: fontSize.md,
                        color: neutral[700],
                      }}
                    >
                      <span style={{ fontWeight: 600, fontFamily: fontFamily.mono }}>
                        {p.modelCount}
                      </span>
                      <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>模型</span>
                    </span>

                    {/* 凭据状态徽章 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <CredentialBadge status={status} />
                    </div>

                    {/* fingerprint（已配置时显示，脱敏） */}
                    <span
                      data-testid="provider-fingerprint"
                      data-provider={p.providerID}
                      style={{
                        width: 220,
                        flexShrink: 0,
                        fontSize: fontSize.sm,
                        fontFamily: fontFamily.mono,
                        color: status === "configured" ? neutral[600] : neutral[300],
                        letterSpacing: "0.02em",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {status === "configured" ? (fingerprint ?? "—") : "—"}
                    </span>

                    {/* 操作：编辑配置 / 配置凭据 / 删除凭据（admin 专属；成员只读无操作） */}
                    <div
                      style={{
                        width: 240,
                        flexShrink: 0,
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: space.sm,
                      }}
                    >
                      {isAdmin && (
                        <>
                          <ActionButton
                            testid="provider-edit-button"
                            label="编辑"
                            onClick={() => {
                              setEditError(null);
                              setEditTarget(p.providerID);
                            }}
                          />
                          <ActionButton
                            testid="provider-configure-button"
                            label={status === "configured" ? "更新凭据" : "配置"}
                            primary
                            onClick={() => setConfigureOpen(p.providerID)}
                          />
                          {status === "configured" && (
                            <ActionButton
                              testid="provider-delete-button"
                              label="删除"
                              onClick={() => {
                                setProviderError(null);
                                setRevokeTarget(p.providerID);
                              }}
                              disabled={revokeMutation.isPending}
                            />
                          )}
                        </>
                      )}
                    </div>
                  </div>
                    {/* Level 2：该 Provider 下的模型（展开时懒加载 GET /models?providerID） */}
                    {isOpen && (
                      <div
                        data-testid="provider-models-panel"
                        data-provider={p.providerID}
                        style={{
                          padding: `0 ${space.xl}px ${space.lg}px ${space.xl}`,
                          borderRadius: `0 0 ${radius.lg} ${radius.lg}`,
                          backgroundColor: "var(--color-surface)",
                          border: `1px solid ${neutral[200]}`,
                          borderTop: `1px dashed ${neutral[200]}`,
                          boxShadow: shadow.sm,
                          ...baseFont,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: space.sm,
                            padding: `${space.sm}px 0`,
                          }}
                        >
                          <span style={{ fontSize: fontSize.xs, fontWeight: 600, color: neutral[400], letterSpacing: "0.03em" }}>
                            {p.providerID} 下的模型
                          </span>
                          <span
                            style={{
                              fontSize: fontSize.xs,
                              color: neutral[400],
                              backgroundColor: neutral[100],
                              padding: "0 7px",
                              borderRadius: radius.pill,
                              lineHeight: "16px",
                              fontFamily: fontFamily.mono,
                            }}
                          >
                            {p.modelCount}
                          </span>
                        </div>
                        <ProviderModels
                          providerID={p.providerID}
                          baseUrl={p.baseUrl ?? null}
                          onEditModel={(m, b) => {
                            setModelEditError(null);
                            /* b 来自 Provider 行透传（经 ProviderModels prop 回传）；
                             * 兜底用行内 p.baseUrl（同一数据源，双保险） */
                            setModelEditTarget({
                              model: m,
                              baseUrl: b ?? p.baseUrl ?? null,
                            });
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}

              {/* 空结果：无 Provider / 搜索无匹配 */}
              {providers.length === 0 && (
                <div
                  data-testid="providers-empty"
                  style={{
                    padding: `${space.xxl}px`,
                    textAlign: "center",
                    fontSize: fontSize.md,
                    color: neutral[400],
                  }}
                >
                    {isAdmin
                      ? "暂无 Provider——点击上方「＋ 新增 Provider」创建，或等待 worker 上报 capabilities.models 后自动出现"
                      : "暂无 Provider（worker 上报 capabilities.models 后将自动出现）"}
                </div>
              )}
              {providers.length > 0 && filteredProviders.length === 0 && (
                <div
                  data-testid="providers-empty-search"
                  style={{
                    padding: `${space.xxl}px`,
                    textAlign: "center",
                    fontSize: fontSize.md,
                    color: neutral[400],
                  }}
                >
                  无匹配的 Provider，换个关键字试试
                </div>
              )}
            </div>
          )}

          {/* 底部说明 */}
          <div
            data-testid="provider-hint"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.xs,
              fontSize: fontSize.xs,
              color: neutral[400],
            }}
          >
            <span aria-hidden style={{ fontSize: fontSize.sm }}>◷</span>
            token 经 AES-256-GCM 加密落库（17 篇 §3.4），响应仅返回脱敏 fingerprint ·
            下发后 worker 写入 auth.json（600 权限），token 不进日志 / 模型上下文（§5.4）
          </div>
        </div>
      </main>

      {/* 配置凭据弹窗（admin 专属，provider 预填） */}
      <ConfigureModal
        open={configuringProvider !== undefined}
        provider={configuringProvider ?? ""}
        providerType={configuringProviderType}
        submitting={saveCredentialMutation.isPending}
        error={configureError}
        workers={workers}
        onClose={() => {
          setConfigureOpen(false);
          setConfigureError(null);
        }}
        onSubmit={(payload) =>
          configuringProvider &&
          saveCredentialMutation.mutate({ providerID: configuringProvider, ...payload })
        }
      />

      {/* 新增 Provider 弹窗（admin 专属：锚点模型行 + 凭据两步保存） */}
      <AddProviderModal
        open={addOpen}
        submitting={addProviderMutation.isPending}
        error={addError}
        workers={workers}
        existing={providers}
        onClose={() => {
          setAddOpen(false);
          setAddError(null);
        }}
        onSubmit={(payload) => addProviderMutation.mutate(payload)}
      />

      {/* 编辑 Provider 配置弹窗（admin 专属：类型 / Base URL 全模型行生效） */}
      <EditProviderModal
        open={editProviderRow !== null}
        provider={editProviderRow}
        submitting={editProviderMutation.isPending}
        error={editError}
        onClose={() => {
          setEditTarget(null);
          setEditError(null);
        }}
        onSubmit={(payload) =>
          editProviderRow &&
          editProviderMutation.mutate({
            providerID: editProviderRow.providerID,
            payload,
          })
        }
      />

      {/* 模型能力配置弹窗（admin 专属：per-model capabilities → PATCH /models/:id） */}
      <ModelCapabilitiesModal
        open={modelEditTarget !== null}
        model={modelEditTarget?.model ?? null}
        baseUrl={modelEditTarget?.baseUrl ?? null}
        submitting={modelEditMutation.isPending}
        error={modelEditError}
        onClose={() => {
          setModelEditTarget(null);
          setModelEditError(null);
        }}
        onSubmit={(capabilities) =>
          modelEditTarget &&
          modelEditMutation.mutate({
            modelId: modelEditTarget.model.id,
            capabilities,
          })
        }
      />

      {/* 删除凭据二次确认弹窗（OBS-003：凭据不可恢复，确认后才 DELETE） */}
      <ConfirmDialog
        open={revokeTarget !== null}
        title="删除 Provider 凭据"
        description={
          revokeTarget
            ? `确认删除 ${revokeTarget} 的凭据？删除后该 Provider 下的模型将无法调用，且不可恢复。`
            : undefined
        }
        confirmLabel="确认删除"
        pendingLabel="删除中…"
        submitting={revokeMutation.isPending}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget);
          setRevokeTarget(null);
        }}
      />
    </div>
  );
}
