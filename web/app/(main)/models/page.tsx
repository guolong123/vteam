"use client";

/**
 * 模型管理页（主入口 —— 双 Tab：模型目录 / Provider 管理）
 * =============================================
 * 用户需求：「主入口应该只有一个模型管理，进去后通过 tab 页管理两个页面，支持切换」。
 *
 * - Tab 1 模型目录（catalog）：列表（provider 列 + 模型名称列 + 模型ID列 +
 *   可用节点 + 凭据状态徽章 + enabled 只读徽章）+ 搜索（model-search，本地受控）+
 *   行内「配置凭据」操作（admin 专属，复用 Provider Tab 的 ConfigureModal，CFG-04/
 *   UX-06：同 provider 模型直接配置 token，无需切 Tab；保存后 invalidate
 *   ["models"]/["workers"] 等实现可用节点联动）。
 * - Tab 2 Provider 管理（providers）：凭证管理 + worker 同步，逻辑迁移自
 *   providers-tab.tsx（原 /providers 页；/providers 路由已重定向到本页）。
 * - Tab 切换：manage-tabs / manage-tab（对齐 skills 页双 Tab 模式，TabKey state）；
 *   各 Tab 数据源独立 query（catalog=["models"]+["model-credentials"]，
 *   providers=["model-providers"]；["workers"] 双 Tab 共享同 queryFn 无污染）。
 * - 权限：模型目录全读（成员只读）；Provider 配置/删除 isAdmin 控制（后端
 *   AdminGuard 兜底）。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；root flex:1 铺满（AppShell 提供导航）。
 */
import { useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";
import type { ApiModel, ApiWorker, CredentialView, ModelsResponse, ProviderSummary } from "@/src/types/models";
import ProvidersTab, { ActionButton, ConfigureModal } from "./providers-tab";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 页面内扩展 token（仿原型范式，不写 tokens.ts） ------------------------------ */

/** 凭据状态「已配置 / 未配置」语义独立于任务四态，遵循"扩展 token"范式页面内定义。 */
const credentialTheme = {
  configured: { label: "已配置", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  missing: { label: "未配置", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
} as const;

/** 启用状态徽章主色（与导航高亮蓝同族） */
const activeBlue = "#2563EB";

/** 行 hover / 过渡（scoped：mmrow 前缀避免污染） */
const rowCss = `
.mm-model-row { transition: border-color .15s ease, background-color .15s ease; }
.mm-model-row:hover { background-color: var(--color-neutral-50); }
`;

type CredentialStatus = "configured" | "missing";

/* ------------------------------ 子组件 ------------------------------ */

/** 凭据状态徽章：已配置=绿 / 未配置=灰（对齐原型 CredentialBadge）。 */
function CredentialBadge({ status }: { status: CredentialStatus }) {
  const theme = credentialTheme[status];
  return (
    <span
      data-testid="model-credential-status"
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

/** 启用状态只读徽章：已启用=蓝 / 已停用=灰（替代原 model-toggle 写操作开关）。 */
function EnabledBadge({ enabled }: { enabled: boolean }) {
  const theme = enabled
    ? { label: "已启用", color: activeBlue, bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)" }
    : { label: "已停用", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" };
  return (
    <span
      data-testid="model-enabled-badge"
      data-enabled={enabled ? "true" : "false"}
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
      {theme.label}
    </span>
  );
}

/** 模型行卡片：provider 列 + 名称列 + 模型ID列 + 可用节点 + 凭据状态 + 启用状态 + 配置凭据/编辑操作（admin）。 */
function ModelRow({
  m,
  nodes,
  credential,
  enabled,
  isAdmin,
  onConfigure,
  onEdit,
}: {
  /** 目录行（id=md_xxx；展示 id 用 providerID/modelID 组合） */
  m: ApiModel;
  /** 可用节点数（在线 worker capabilities.models 含该模型） */
  nodes: number;
  credential: CredentialStatus;
  enabled: boolean;
  /** admin 专属：行内「配置/更新凭据」按钮（复用 Provider Tab 的 ConfigureModal，CFG-04） */
  isAdmin: boolean;
  onConfigure: (providerID: string) => void;
  onEdit: (m: ApiModel) => void;
}) {
  const modelRef = `${m.providerID}/${m.modelID}`;
  return (
    <div
      data-testid="model-item"
      data-model-id={modelRef}
      data-provider={m.providerID}
      data-enabled={enabled ? "true" : "false"}
      data-credential={credential}
      className="mm-model-row"
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
        data-testid="model-provider"
        data-provider={m.providerID}
        style={{
          width: 140,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: space.sm,
          fontSize: fontSize.md,
          fontWeight: 500,
          color: neutral[700],
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
        {m.providerID}
      </span>

      {/* 模型名称列（产品视角名） */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}
      >
        <span
          data-testid="model-name"
          data-model-id={modelRef}
          style={{
            fontSize: fontSize.lg,
            fontWeight: 600,
            color: neutral[900],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {m.name}
        </span>
        <span
          style={{
            fontSize: fontSize.md,
            color: neutral[500],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {m.modelID}
        </span>
      </div>

      {/* 模型ID列（providerID/modelID，mono） */}
      <span
        data-testid="model-id"
        data-model-id={modelRef}
        style={{
          width: 250,
          flexShrink: 0,
          fontSize: fontSize.sm,
          fontFamily: fontFamily.mono,
          color: neutral[500],
          letterSpacing: "-0.01em",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {modelRef}
      </span>

      {/* 可用节点数 */}
      <span
        style={{
          width: 72,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "baseline",
          gap: space.xs,
          fontSize: fontSize.md,
          color: neutral[700],
        }}
      >
        <span style={{ fontWeight: 600, fontFamily: fontFamily.mono }}>{nodes}</span>
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>节点</span>
      </span>

      {/* 凭据状态（展示；凭证管理在 /providers） */}
      <CredentialBadge status={credential} />

      {/* 启用状态（只读徽章；启停管理在 /models/:id PATCH，管理端操作） */}
      <div style={{ width: 72, flexShrink: 0, display: "flex", justifyContent: "center" }}>
        <EnabledBadge enabled={enabled} />
      </div>

      {/* 操作列：编辑 + 配置凭据（admin 专属） */}
      <div
        style={{
          width: 180,
          flexShrink: 0,
          display: "flex",
          justifyContent: "flex-end",
          gap: space.sm,
        }}
      >
        {isAdmin && (
          <>
            <ActionButton testid="model-edit-button" label="编辑" onClick={() => onEdit(m)} />
            <ActionButton
              testid="model-configure-button"
              label={credential === "configured" ? "更新凭据" : "配置"}
              primary
              onClick={() => onConfigure(m.providerID)}
            />
          </>
        )}
      </div>
    </div>
  );
}

/* ================================ 页面主组件 ================================ */

const BUILTIN_PROVIDERS = new Set([
  "opencode-go",
  "deepseek",
  "zhipu",
  "openai",
  "xai",
  "moonshot",
  "qwen",
  "opencode",
]);
const isBuiltinProvider = (pid: string) => BUILTIN_PROVIDERS.has(pid);
const isBuiltinModel = (m: ApiModel) => BUILTIN_PROVIDERS.has(m.providerID);

export default function ModelsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.roleName === "admin";
  const queryClient = useQueryClient();

  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [providerKeyword, setProviderKeyword] = useState("");

  const [configureOpen, setConfigureOpen] = useState<string | false>(false);
  const [configureError, setConfigureError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addProviderID, setAddProviderID] = useState("");
  const [addModelID, setAddModelID] = useState("");
  const [addName, setAddName] = useState("");
  const [addProviderType, setAddProviderType] = useState<"cloud" | "local" | "custom">("local");
  const [addBaseUrl, setAddBaseUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<ApiModel | null>(null);
  const [editName, setEditName] = useState("");
  const [editProviderType, setEditProviderType] = useState<"cloud" | "local" | "custom">("local");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);
  const [editError, setEditError] = useState<string | null>(null);

  const [providerEditTarget, setProviderEditTarget] = useState<string | null>(null);
  const [providerEditType, setProviderEditType] = useState<"cloud" | "local" | "custom">("local");
  const [providerEditBaseUrl, setProviderEditBaseUrl] = useState("");
  const [providerEditError, setProviderEditError] = useState<string | null>(null);
  const [providerDeleteTarget, setProviderDeleteTarget] = useState<string | null>(null);

  const openEdit = (m: ApiModel) => {
    if (isBuiltinModel(m)) return;
    setEditTarget(m);
    setEditName(m.name);
    setEditProviderType((m.providerType as never) ?? "cloud");
    setEditBaseUrl(m.baseUrl ?? "");
    setEditEnabled(m.enabled);
    setEditError(null);
  };

  const openProviderEdit = (providerID: string, providerType: string, baseUrl: string | null) => {
    if (isBuiltinProvider(providerID)) return;
    setProviderEditTarget(providerID);
    setProviderEditType((providerType as never) ?? "local");
    setProviderEditBaseUrl(baseUrl ?? "");
    setProviderEditError(null);
  };

  const updateModelMutation = useMutation({
    mutationFn: (payload: { id: string; name: string; providerType: string; baseUrl?: string | null; enabled: boolean }) =>
      api.patch<ApiModel>(`/models/${payload.id}`, {
        name: payload.name,
        providerType: payload.providerType,
        baseUrl: payload.baseUrl,
        enabled: payload.enabled,
      }),
    onSuccess: () => {
      setEditTarget(null);
      setEditError(null);
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
    },
    onError: (err) => setEditError(isApiError(err) ? err.message : "更新失败"),
  });

  const deleteModelMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/models/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      queryClient.invalidateQueries({ queryKey: ["workers"] });
    },
  });

  const updateProviderMutation = useMutation({
    mutationFn: async (payload: { providerID: string; providerType: string; baseUrl: string | null }) => {
      const list = models.filter((m) => m.providerID === payload.providerID);
      for (const m of list) {
        await api.patch(`/models/${m.id}`, { providerType: payload.providerType, baseUrl: payload.baseUrl });
      }
    },
    onSuccess: () => {
      setProviderEditTarget(null);
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
    },
    onError: (err) => setProviderEditError(isApiError(err) ? err.message : "更新失败"),
  });

  const deleteProviderMutation = useMutation({
    mutationFn: async (providerID: string) => {
      const list = models.filter((m) => m.providerID === providerID);
      for (const m of list) {
        await api.delete(`/models/${m.id}`);
      }
      try {
        await api.delete(`/models/providers/${providerID}/credentials`);
      } catch {}
    },
    onSuccess: () => {
      setProviderDeleteTarget(null);
      setSelectedProvider(null);
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      queryClient.invalidateQueries({ queryKey: ["model-credentials"] });
    },
  });

  const createModelMutation = useMutation({
    mutationFn: (payload: { providerID: string; modelID: string; name: string; providerType: string; baseUrl?: string }) =>
      api.post<ApiModel>("/models", payload),
    onSuccess: () => {
      setAddOpen(false);
      setAddProviderID("");
      setAddModelID("");
      setAddName("");
      setAddBaseUrl("");
      setAddError(null);
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      queryClient.invalidateQueries({ queryKey: ["workers"] });
    },
    onError: (err) => setAddError(isApiError(err) ? err.message : "创建失败"),
  });

  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => api.get<ModelsResponse>("/models", { query: { page: 1, pageSize: 100 } }),
    enabled: !!user,
  });
  const models = modelsQuery.data?.items ?? [];

  const providersQuery = useQuery({
    queryKey: ["model-providers"],
    queryFn: () => api.get<ProviderSummary[]>("/models/providers"),
    enabled: !!user,
  });
  const providers = providersQuery.data ?? [];

  const workersQuery = useQuery({
    queryKey: ["workers"],
    queryFn: () => api.get<ApiWorker[]>("/workers"),
    enabled: !!user,
  });
  const workers = workersQuery.data ?? [];

  const nodeCountByModel = useMemo(() => {
    const map = new Map<string, number>();
    for (const w of workers) {
      if (w.status === "offline") continue;
      for (const modelRef of w.capabilities?.models ?? []) {
        map.set(modelRef, (map.get(modelRef) ?? 0) + 1);
      }
    }
    return map;
  }, [workers]);

  const credentialsQuery = useQuery({
    queryKey: ["model-credentials"],
    queryFn: async () => {
      const entries = await Promise.all(
        models.map(async (m) => {
          try {
            return [m.id, await api.get<CredentialView>(`/models/${m.id}/credentials`)] as const;
          } catch {
            return [m.id, { configured: false, fingerprint: null } as CredentialView] as const;
          }
        })
      );
      return new Map(entries);
    },
    enabled: models.length > 0,
  });
  const credentialOf = (m: ApiModel): CredentialStatus =>
    credentialsQuery.data?.get(m.id)?.configured ? "configured" : "missing";

  const saveCredentialMutation = useMutation({
    mutationFn: async ({
      providerID,
      token,
      targetWorkerIds,
    }: {
      providerID: string;
      token: string;
      targetWorkerIds?: string[];
    }) => {
      // 目录 Tab 只加载前 100 个模型（老 opencode 系），worker 同步进来的数千个
      // provider 模型不在其中 —— 必须按 providerID 走 API 解析，不能用本地 models.find
      const res = await api.get<ModelsResponse>("/models", {
        query: { providerID, page: 1, pageSize: 1 },
      });
      const modelId = res.items[0]?.id;
      if (!modelId) throw new Error(`provider ${providerID} 无可用模型`);
      return api.post<CredentialView>(`/models/${modelId}/credentials`, {
        token,
        ...(targetWorkerIds && targetWorkerIds.length > 0 ? { targetWorkerIds } : {}),
      });
    },
    onSuccess: () => {
      setConfigureOpen(false);
      setConfigureError(null);
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["model-credentials"] });
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      queryClient.invalidateQueries({ queryKey: ["workers"] });
    },
    onError: (err) => {
      setConfigureError(
        isApiError(err)
          ? err.message
          : err instanceof Error
            ? err.message
            : "保存失败，请稍后重试"
      );
    },
  });

  const kw = keyword.trim().toLowerCase();
  const filteredModels = selectedProvider
    ? models.filter((m) => m.providerID === selectedProvider).filter((m) => kw === "" || `${m.name} ${m.modelID}`.toLowerCase().includes(kw))
    : [];
  const providerFiltered = providerKeyword.trim().toLowerCase() === "" ? providers : providers.filter((p) => p.providerID.toLowerCase().includes(providerKeyword.trim().toLowerCase()));
  const configuredCount = models.filter((m) => credentialOf(m) === "configured").length;
  const missingCount = models.length - configuredCount;

  return (
    <div
      data-testid="models-manage-root"
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
      <main style={{ flex: 1, minHeight: 0, padding: `${space.xl}px` }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", display: "flex", flexDirection: "column", gap: space.lg }}>
          {selectedProvider === null ? (
            <>
              <div data-testid="manage-toolbar" style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}>
                <span style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900] }}>Provider 列表</span>
                <span style={{ fontSize: fontSize.xs, color: neutral[500], backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, borderRadius: radius.pill, padding: "2px 10px", fontFamily: fontFamily.mono }}>{providers.length} 个 Provider</span>
                <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginLeft: "auto", flex: 1, maxWidth: 320, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm }}>
                  <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400] }}>⌕</span>
                  <input data-testid="provider-search" autoComplete="off" name="provider-search" value={providerKeyword} onChange={(e) => setProviderKeyword(e.target.value)} placeholder="搜索 provider…" style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: fontSize.md, color: neutral[800], fontFamily: fontFamily.body }} />
                </div>
                {isAdmin && (
                  <button type="button" data-testid="add-provider-button" onClick={() => { setAddProviderID(""); setAddModelID(""); setAddName(""); setAddProviderType("local"); setAddBaseUrl(""); setAddOpen(true); }} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#fff", fontSize: fontSize.md, fontWeight: 500, cursor: "pointer", fontFamily: fontFamily.body }}>+ 新增 Provider</button>
                )}
              </div>
              {providersQuery.isPending ? (
                <div data-testid="providers-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xxl}px 0`, textAlign: "center" }}>加载中…</div>
              ) : (
                <div data-testid="provider-list" style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: space.md, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.md }}>
                  <div aria-hidden style={{ display: "flex", alignItems: "center", gap: space.lg, padding: `${space.sm}px ${space.xl}px`, fontSize: fontSize.xs, fontWeight: 600, color: neutral[400], letterSpacing: "0.03em" }}>
                    <span style={{ width: 200, flexShrink: 0 }}>PROVIDER</span>
                    <span style={{ width: 80, flexShrink: 0 }}>模型数</span>
                    <span style={{ flex: 1 }}>BaseUrl</span>
                    <span style={{ width: 100, flexShrink: 0 }}>类型</span>
                    <span style={{ width: 100, flexShrink: 0 }}>凭据</span>
                    <span style={{ width: 200, flexShrink: 0, textAlign: "right" }}>操作</span>
                  </div>
                  {providerFiltered.map((p) => {
                    const builtin = isBuiltinProvider(p.providerID);
                    return (
                      <div key={p.providerID} data-testid="provider-item" data-provider={p.providerID} onClick={() => setSelectedProvider(p.providerID)} style={{ display: "flex", alignItems: "center", gap: space.lg, padding: `${space.lg}px ${space.xl}px`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, cursor: "pointer", ...baseFont }}>
                        <span data-testid="provider-id" style={{ width: 200, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: space.sm, fontWeight: 600, fontFamily: fontFamily.mono, color: neutral[800] }}><span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: activeBlue }} />{p.providerID}{builtin && <span style={{ fontSize: fontSize.xs, color: neutral[500], backgroundColor: neutral[100], border: `1px solid ${neutral[200]}`, borderRadius: radius.pill, padding: "1px 6px" }}>内置</span>}</span>
                        <span style={{ width: 80, flexShrink: 0, fontFamily: fontFamily.mono, fontWeight: 600 }}>{p.modelCount}</span>
                        <span style={{ flex: 1, fontSize: fontSize.sm, color: neutral[500], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.baseUrl ?? "—"}</span>
                        <span style={{ width: 100, flexShrink: 0, fontSize: fontSize.sm, color: neutral[600] }}>{p.providerType ?? "cloud"}</span>
                        <span style={{ width: 100, flexShrink: 0 }}><CredentialBadge status={p.configured ? "configured" : "missing"} /></span>
                        <div style={{ width: 200, flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: space.sm }} onClick={(e) => e.stopPropagation()}>
                          {isAdmin && !builtin && <ActionButton testid="provider-edit-button" label="编辑" onClick={() => openProviderEdit(p.providerID, p.providerType ?? "cloud", p.baseUrl ?? null)} />}
                          {isAdmin && !builtin && <ActionButton testid="provider-delete-button" label="删除" onClick={() => setProviderDeleteTarget(p.providerID)} />}
                          {isAdmin && <ActionButton testid="provider-configure-button" label={p.configured ? "更新凭据" : "配置"} primary onClick={() => setConfigureOpen(p.providerID)} />}
                        </div>
                      </div>
                    );
                  })}
                  {providerFiltered.length === 0 && <div style={{ padding: `${space.xxl}px`, textAlign: "center", color: neutral[400] }}>无匹配 Provider</div>}
                </div>
              )}
            </>
          ) : (
            <>
              <div data-testid="manage-toolbar" style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}>
                <button type="button" data-testid="back-to-providers" onClick={() => setSelectedProvider(null)} style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontFamily: fontFamily.body }}>← 返回 Provider</button>
                <span style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900] }}>{selectedProvider}</span>
                <span style={{ fontSize: fontSize.xs, color: neutral[500], backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, borderRadius: radius.pill, padding: "2px 10px", fontFamily: fontFamily.mono }}>{filteredModels.length} 个模型</span>
                <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginLeft: "auto", flex: 1, maxWidth: 320, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm }}>
                  <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400] }}>⌕</span>
                  <input data-testid="model-search" autoComplete="off" name="model-search" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索模型名…" style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: fontSize.md, color: neutral[800], fontFamily: fontFamily.body }} />
                </div>
                {isAdmin && (
                  <button type="button" data-testid="add-model-button" onClick={() => { setAddProviderID(selectedProvider); setAddModelID(""); setAddName(""); setAddProviderType("local"); setAddBaseUrl(providers.find(p=>p.providerID===selectedProvider)?.baseUrl ?? ""); setAddOpen(true); }} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#fff", fontSize: fontSize.md, fontWeight: 500, cursor: "pointer", fontFamily: fontFamily.body }}>+ 新增模型</button>
                )}
              </div>
              {modelsQuery.isPending ? (
                <div data-testid="models-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xxl}px 0`, textAlign: "center" }}>加载中…</div>
              ) : (
                <div data-testid="model-list" style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: space.md, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.md }}>
                  <div aria-hidden style={{ display: "flex", alignItems: "center", gap: space.lg, padding: `${space.sm}px ${space.xl}px`, fontSize: fontSize.xs, fontWeight: 600, color: neutral[400], letterSpacing: "0.03em" }}>
                    <span style={{ flex: 1 }}>模型名称</span>
                    <span style={{ width: 250, flexShrink: 0 }}>模型 ID</span>
                    <span style={{ width: 72, flexShrink: 0 }}>可用节点</span>
                    <span style={{ width: 88, flexShrink: 0 }}>凭据</span>
                    <span style={{ width: 72, flexShrink: 0 }}>启用</span>
                    <span style={{ width: 200, flexShrink: 0, textAlign: "right" }}>操作</span>
                  </div>
                  {filteredModels.map((m) => (
                    <div key={m.id} data-testid="model-item" data-model-id={`${m.providerID}/${m.modelID}`} style={{ display: "flex", alignItems: "center", gap: space.lg, padding: `${space.lg}px ${space.xl}px`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, ...baseFont }}>
                      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                        <span data-testid="model-name" style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                        <span style={{ fontSize: fontSize.md, color: neutral[500], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.modelID}{isBuiltinModel(m) && <span style={{ marginLeft: 6, fontSize: fontSize.xs, color: neutral[500], backgroundColor: neutral[100], border: `1px solid ${neutral[200]}`, borderRadius: radius.pill, padding: "1px 6px" }}>内置</span>}</span>
                      </div>
                      <span data-testid="model-id" style={{ width: 250, flexShrink: 0, fontSize: fontSize.sm, fontFamily: fontFamily.mono, color: neutral[500], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{`${m.providerID}/${m.modelID}`}</span>
                      <span style={{ width: 72, flexShrink: 0, display: "inline-flex", alignItems: "baseline", gap: space.xs, fontSize: fontSize.md, color: neutral[700] }}><span style={{ fontWeight: 600, fontFamily: fontFamily.mono }}>{nodeCountByModel.get(`${m.providerID}/${m.modelID}`) ?? 0}</span><span style={{ fontSize: fontSize.xs, color: neutral[400] }}>节点</span></span>
                      <CredentialBadge status={credentialOf(m)} />
                      <div style={{ width: 72, flexShrink: 0, display: "flex", justifyContent: "center" }}><EnabledBadge enabled={m.enabled} /></div>
                      <div style={{ width: 200, flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: space.sm }}>
                        {isAdmin && !isBuiltinModel(m) && <ActionButton testid="model-edit-button" label="编辑" onClick={() => openEdit(m)} />}
                        {isAdmin && !isBuiltinModel(m) && <ActionButton testid="model-delete-button" label="删除" onClick={() => deleteModelMutation.mutate(m.id)} />}
                        {isAdmin && <ActionButton testid="model-configure-button" label={credentialOf(m) === "configured" ? "更新凭据" : "配置"} primary onClick={() => setConfigureOpen(m.providerID)} />}
                      </div>
                    </div>
                  ))}
                  {filteredModels.length === 0 && <div style={{ padding: `${space.xxl}px`, textAlign: "center", color: neutral[400] }}>该 Provider 暂无模型</div>}
                </div>
              )}
            </>
          )}
        </div>
      </main>
      <ConfigureModal open={configureOpen !== false} provider={configureOpen === false ? "" : configureOpen} submitting={saveCredentialMutation.isPending} error={configureError} workers={workers} onClose={() => { setConfigureOpen(false); setConfigureError(null); }} onSubmit={(payload) => configureOpen !== false && saveCredentialMutation.mutate({ providerID: configureOpen, ...payload })} />
      {addOpen && (
        <div data-testid="add-model-modal" style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "10%" }}>
          <div aria-hidden onClick={() => setAddOpen(false)} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }} />
          <div style={{ position: "relative", width: 520, maxWidth: "calc(100% - 48px)", display: "flex", flexDirection: "column", gap: space.lg, padding: `${space.xl}px`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.lg }}>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>{selectedProvider ? `为 ${selectedProvider} 新增模型` : "添加本地/自定义模型"}</div>
            {addError && <div data-testid="add-model-error" role="alert" style={{ color: "#DC2626", fontSize: fontSize.sm }}>{addError}</div>}
            <input data-testid="add-model-provider" autoComplete="off" name="add-provider" placeholder="providerID (如 ollama-local)" value={addProviderID} onChange={(e) => setAddProviderID(e.target.value)} disabled={!!selectedProvider} style={{ padding: `${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: selectedProvider ? neutral[100] : "var(--color-surface)" }} />
            <input data-testid="add-model-modelid" autoComplete="off" name="add-modelid" placeholder="modelID (如 ornith-1.5:9b)" value={addModelID} onChange={(e) => setAddModelID(e.target.value)} style={{ padding: `${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }} />
            <input data-testid="add-model-name" autoComplete="off" name="add-name" placeholder="显示名 (如 Ornith 9B)" value={addName} onChange={(e) => setAddName(e.target.value)} style={{ padding: `${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }} />
            <select data-testid="add-model-providertype" value={addProviderType} onChange={(e) => setAddProviderType(e.target.value as never)} style={{ padding: `${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>
              <option value="local">local</option>
              <option value="custom">custom</option>
              <option value="cloud">cloud</option>
            </select>
            <input data-testid="add-model-baseurl" autoComplete="off" name="add-baseurl" placeholder="baseUrl (http://.../v1)" value={addBaseUrl} onChange={(e) => setAddBaseUrl(e.target.value)} style={{ padding: `${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
              <button type="button" onClick={() => setAddOpen(false)} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>取消</button>
              <button type="button" data-testid="add-model-submit" disabled={createModelMutation.isPending} onClick={() => { const payload: Record<string, string> = { providerID: addProviderID.trim(), modelID: addModelID.trim(), name: addName.trim(), providerType: addProviderType }; if (addBaseUrl.trim()) payload.baseUrl = addBaseUrl.trim(); createModelMutation.mutate(payload as never); }} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#fff" }}>{createModelMutation.isPending ? "创建中…" : "创建"}</button>
            </div>
          </div>
        </div>
      )}
      {editTarget && (
        <div data-testid="edit-model-modal" style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "10%" }}>
          <div aria-hidden onClick={() => setEditTarget(null)} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }} />
          <div style={{ position: "relative", width: 520, maxWidth: "calc(100% - 48px)", display: "flex", flexDirection: "column", gap: space.lg, padding: `${space.xl}px`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.lg }}>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>编辑模型 {editTarget.providerID}/{editTarget.modelID}</div>
            {editError && <div data-testid="edit-model-error" role="alert" style={{ color: "#DC2626", fontSize: fontSize.sm }}>{editError}</div>}
            <input data-testid="edit-model-name" autoComplete="off" name="edit-name" placeholder="显示名" value={editName} onChange={(e) => setEditName(e.target.value)} style={{ padding: `${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }} />
            <select data-testid="edit-model-providertype" value={editProviderType} onChange={(e) => setEditProviderType(e.target.value as never)} style={{ padding: `${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>
              <option value="cloud">cloud</option>
              <option value="local">local</option>
              <option value="custom">custom</option>
            </select>
            <input data-testid="edit-model-baseurl" autoComplete="off" name="edit-baseurl" placeholder="baseUrl (http://.../v1)" value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.target.value)} style={{ padding: `${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }} />
            <label style={{ display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.md }}>
              <input type="checkbox" checked={editEnabled} onChange={(e) => setEditEnabled(e.target.checked)} /> 已启用
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
              <button type="button" onClick={() => setEditTarget(null)} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>取消</button>
              <button type="button" data-testid="edit-model-submit" disabled={updateModelMutation.isPending} onClick={() => updateModelMutation.mutate({ id: editTarget.id, name: editName.trim(), providerType: editProviderType, baseUrl: editBaseUrl.trim() || null, enabled: editEnabled })} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#fff" }}>{updateModelMutation.isPending ? "保存中…" : "保存"}</button>
            </div>
          </div>
        </div>
      )}
      {providerEditTarget && (
        <div data-testid="edit-provider-modal" style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "10%" }}>
          <div aria-hidden onClick={() => setProviderEditTarget(null)} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }} />
          <div style={{ position: "relative", width: 520, maxWidth: "calc(100% - 48px)", display: "flex", flexDirection: "column", gap: space.lg, padding: `${space.xl}px`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.lg }}>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>编辑 Provider {providerEditTarget}</div>
            {providerEditError && <div data-testid="edit-provider-error" role="alert" style={{ color: "#DC2626", fontSize: fontSize.sm }}>{providerEditError}</div>}
            <select data-testid="edit-provider-providertype" value={providerEditType} onChange={(e) => setProviderEditType(e.target.value as never)} style={{ padding: `${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>
              <option value="cloud">cloud</option>
              <option value="local">local</option>
              <option value="custom">custom</option>
            </select>
            <input data-testid="edit-provider-baseurl" autoComplete="off" name="edit-provider-baseurl" placeholder="baseUrl (http://.../v1)" value={providerEditBaseUrl} onChange={(e) => setProviderEditBaseUrl(e.target.value)} style={{ padding: `${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
              <button type="button" onClick={() => setProviderEditTarget(null)} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>取消</button>
              <button type="button" data-testid="edit-provider-submit" disabled={updateProviderMutation.isPending} onClick={() => updateProviderMutation.mutate({ providerID: providerEditTarget, providerType: providerEditType, baseUrl: providerEditBaseUrl.trim() || null })} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#fff" }}>{updateProviderMutation.isPending ? "保存中…" : "保存"}</button>
            </div>
          </div>
        </div>
      )}
      {providerDeleteTarget && (
        <div data-testid="delete-provider-confirm" style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div aria-hidden onClick={() => setProviderDeleteTarget(null)} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }} />
          <div style={{ position: "relative", width: 420, padding: `${space.xl}px`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.lg }}>
            <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>确认删除 Provider {providerDeleteTarget}？</div>
            <div style={{ fontSize: fontSize.sm, color: neutral[500], marginTop: space.sm }}>将删除该 Provider 下所有模型及凭据，内置 Provider 不可删除。</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.lg }}>
              <button type="button" onClick={() => setProviderDeleteTarget(null)} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>取消</button>
              <button type="button" data-testid="confirm-delete-provider" disabled={deleteProviderMutation.isPending} onClick={() => deleteProviderMutation.mutate(providerDeleteTarget)} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#DC2626", color: "#fff" }}>{deleteProviderMutation.isPending ? "删除中…" : "确认删除"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
