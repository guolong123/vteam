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
 * - 删除凭据（provider-delete-button，admin 专属）→ DELETE
 *   /models/providers/:providerID/credentials（按 provider 粒度直删，
 *   revokedAt 软撤销，不依赖模型 id）→ 徽章变「未配置」。
 * - 数据源：GET /models/providers 后端聚合（C9：一次请求返回
 *   [{providerID, modelCount, configured, fingerprint, revokedAt}]）；GET /workers
 *   提供 worker 多选数据源（queryKey=["workers"] 与模型目录 Tab 共享，queryFn 相同
 *   无污染）。
 * - 保存凭据需模型 id（providers 响应不含 id）：保底
 *   GET /models?providerID=xxx 取该 provider 首个模型 id（凭据按 provider 粒度，
 *   C4：同 provider 下任一模型 id 均可操作）；删除凭据改按 provider 直删
 *   （不再解析模型 id——修复每次删除取到不同模型 id 的 bug）。
 * - 权限：isAdmin（roleName==='admin'）控制配置/删除，成员只读（后端 AdminGuard 403 兜底）。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；root flex:1 铺满（AppShell 提供导航）。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
const activeBlue = "#2563EB";

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

/** 导出供模型目录 Tab 复用（CFG-04：目录行「配置凭据」直接打开同一弹窗，无需切 Tab）。 */
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
    outline: "none",
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
                    backgroundColor: checked ? "rgba(37,99,235,0.10)" : "var(--color-surface)",
                    border: `1px solid ${checked ? "rgba(37,99,235,0.22)" : neutral[200]}`,
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
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
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

/* ================================ Tab 视图主组件 ================================ */

export default function ProvidersTab() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.roleName === "admin";
  const queryClient = useQueryClient();

  /* 配置弹窗（open=providerID，false=关闭） */
  const [configureOpen, setConfigureOpen] = useState<string | false>(false);
  const [configureError, setConfigureError] = useState<string | null>(null);
  /* 删除凭据确认弹窗（target=providerID，非空即打开——OBS-003：删除不可恢复，需二次确认） */
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
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
  const providers = providersQuery.data ?? [];

  /* worker 池：GET /workers（同步目标多选数据源；与模型目录 Tab 共享 queryKey 同 queryFn） */
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
      /* 与模型目录 Tab 共享的凭据态缓存一并失效（跨 Tab 一致性） */
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

  const configuringProviderRow = useMemo(
    () => providers.find((p) => p.providerID === configureOpen),
    [providers, configureOpen]
  );
  const configuringProvider = configuringProviderRow?.providerID;
  const configuringProviderType = configuringProviderRow?.providerType ?? null;

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
          </div>

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
                <span style={{ width: 200, flexShrink: 0, textAlign: "right" }}>操作</span>
              </div>

              {/* Provider 行 */}
              {providers.map((p) => {
                const status = toStatus(p);
                const fingerprint = p.fingerprint;
                return (
                  <div
                    key={p.providerID}
                    data-testid="provider-item"
                    data-provider={p.providerID}
                    data-credential={status}
                    className="pv-provider-row"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.lg,
                      padding: `${space.lg}px ${space.xl}px`,
                      borderRadius: radius.lg,
                      backgroundColor: "var(--color-surface)",
                      border: `1px solid ${neutral[200]}`,
                      boxShadow: shadow.sm,
                      ...baseFont,
                    }}
                  >
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

                    {/* 操作：配置 / 删除（admin 专属；成员只读无操作） */}
                    <div
                      style={{
                        width: 200,
                        flexShrink: 0,
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: space.sm,
                      }}
                    >
                      {isAdmin && (
                        <>
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
                );
              })}

              {/* 空结果 */}
              {providers.length === 0 && (
                <div
                  style={{
                    padding: `${space.xxl}px`,
                    textAlign: "center",
                    fontSize: fontSize.md,
                    color: neutral[400],
                  }}
                >
                  暂无 Provider，模型目录为空（worker 上报 capabilities.models 后将自动出现）
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
