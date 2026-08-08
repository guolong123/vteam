"use client";

/**
 * 模型管理页（C6：模型目录中心化管理，P0 原型 models-manage 保真迁移 + 真实 API 接入）
 * =============================================
 * 唯一来源：docs/agent-platform/prototypes/models-manage/index.tsx（布局/间距/文案/data-testid 零改动）。
 * - 工具条（manage-toolbar）：标题 + 计数（总模型 / 已配置凭据）+ 搜索（model-search，
 *   按模型名 / provider / modelID 过滤，本地受控）+ 添加入口（model-add-button，admin 专属）。
 * - 模型列表（model-list）：行 = provider 列（model-provider）+ 名称列（model-name）+
 *   模型ID列（model-id，providerID/modelID mono）+ 可用节点数 + 凭据状态徽章
 *   （model-credential-status，已配置=绿/未配置=灰）+ 启用开关（model-toggle → PATCH 落库）。
 * - 凭据配置区（credential-section）：目标模型 select（model-credential-select）+
 *   token 输入（model-credential-input，AES-256-GCM 加密落库，仅回显脱敏 fingerprint）+
 *   目标 worker 多选（model-credential-target-workers，来自 GET /workers，未选=全部 worker
 *   全量广播 broadcastCommand / 指定=定向 enqueueCommand，C5）+
 *   保存（POST /models/:id/credentials {token, targetWorkerIds?}）。
 * - 数据源：
 *   · GET /models（分页）→ 目录行（id=md_xxx + providerID/modelID/name/enabled）
 *   · GET /workers → capabilities.models 统计「可用节点数」（在线 worker 上报含该模型）
 *   · GET /models/:id/credentials → 凭据状态 {configured, fingerprint}（脱敏）
 * - 权限：isAdmin（useAuthStore roleName==='admin'）控制写操作（新增/启停/凭据保存），
 *   成员只读（09 §3.8 对齐 skills 页范式；后端 AdminGuard 403 兜底）。
 * - 页面内扩展 token（仿原型 :59-62）：credentialTheme / toggleActive 页面内定义，
 *   不写 tokens.ts 基线。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；root flex:1 铺满（AppShell 提供导航）。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
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

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ API 数据模型（C3/C4/C5 契约） ------------------------------ */

/** GET /models 条目（Model 表行，id=md_xxx 目录行 id）。 */
interface ApiModel {
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /models 分页响应（对齐 mcp-servers/tools findAll 模式）。 */
interface ModelsResponse {
  items: ApiModel[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /workers 条目（toWorkerView；capabilities.models 为 C2 上报模型 id 数组）。 */
interface ApiWorker {
  id: string;
  name: string | null;
  status: string;
  capabilities: { models?: string[] } | null;
}

/** GET /models/:id/credentials（脱敏视图，绝无明文 token）。 */
interface CredentialView {
  id: string;
  providerID: string;
  configured: boolean;
  fingerprint: string | null;
  revokedAt: string | null;
  createdAt: string | null;
}

/* ------------------------------ 页面内扩展 token（仿原型 :59-62，不写 tokens.ts） ------------------------------ */

/** 凭据状态「已配置 / 未配置」语义独立于任务四态，遵循"扩展 token"范式页面内定义。 */
const credentialTheme = {
  configured: { label: "已配置", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  missing: { label: "未配置", color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
} as const;

/** 启用开关主色（与导航高亮蓝同族） */
const toggleActive = "#2563EB";

/** 行 hover / 过渡（scoped：mmrow 前缀避免污染） */
const rowCss = `
.mm-model-row { transition: border-color .15s ease, background-color .15s ease; }
.mm-model-row:hover { background-color: #F8FAFC; }
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

/** 启用/停用开关（受控）：滑动圆点 switch，PATCH 落库；非 admin 禁用。 */
function ToggleSwitch({
  modelId,
  checked,
  disabled,
  onToggle,
}: {
  modelId: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-testid="model-toggle"
      data-model-id={modelId}
      data-active={checked ? "true" : "false"}
      aria-label={checked ? "停用模型" : "启用模型"}
      disabled={disabled}
      onClick={onToggle}
      style={{
        position: "relative",
        width: 36,
        height: 20,
        flexShrink: 0,
        borderRadius: radius.pill,
        border: "none",
        cursor: disabled ? "default" : "pointer",
        backgroundColor: checked ? toggleActive : neutral[300],
        opacity: disabled && !checked ? 0.6 : 1,
        transition: "background-color .15s ease",
        fontFamily: fontFamily.body,
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          backgroundColor: "#FFFFFF",
          boxShadow: shadow.sm,
          transition: "left .15s ease",
        }}
      />
    </button>
  );
}

/** 模型行卡片：provider 列 + 名称列 + 模型ID列 + 可用节点 + 凭据状态 + 启用开关。 */
function ModelRow({
  m,
  nodes,
  credential,
  enabled,
  selected,
  disabled,
  onSelect,
  onToggle,
}: {
  /** 目录行（id=md_xxx；展示 id 用 providerID/modelID 组合） */
  m: ApiModel;
  /** 可用节点数（在线 worker capabilities.models 含该模型） */
  nodes: number;
  credential: CredentialStatus;
  enabled: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const modelRef = `${m.providerID}/${m.modelID}`;
  return (
    <div
      data-testid="model-item"
      data-model-id={modelRef}
      data-provider={m.providerID}
      data-enabled={enabled ? "true" : "false"}
      data-credential={credential}
      data-selected={selected ? "true" : "false"}
      onClick={onSelect}
      className="mm-model-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.lg,
        padding: `${space.lg}px ${space.xl}px`,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${selected ? toggleActive : neutral[200]}`,
        boxShadow: selected ? `0 0 0 1px ${toggleActive}33, ${shadow.sm}` : shadow.sm,
        cursor: "pointer",
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
            backgroundColor: toggleActive,
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

      {/* 凭据状态 */}
      <CredentialBadge status={credential} />

      {/* 启用/停用开关（点击行选中，点击开关切换，互不干扰） */}
      <div
        style={{
          width: 36,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <ToggleSwitch
          modelId={m.id}
          checked={enabled}
          disabled={disabled}
          onToggle={onToggle}
        />
      </div>
    </div>
  );
}

/* ================================ 新增模型弹窗（admin 专属） ================================ */

interface CreateModelModalProps {
  open: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: { providerID: string; modelID: string; name: string }) => void;
}

function CreateModelModal({ open, submitting, error, onClose, onSubmit }: CreateModelModalProps) {
  const [providerID, setProviderID] = useState("");
  const [modelID, setModelID] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      setProviderID("");
      setModelID("");
      setName("");
    }
  }, [open]);

  if (!open) return null;

  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "#FFFFFF",
    fontSize: fontSize.md,
    color: neutral[800],
    outline: "none",
    fontFamily: fontFamily.body,
  };

  return (
    <div
      data-testid="model-add-modal"
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
          width: 420,
          maxWidth: "calc(100% - 48px)",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
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
              登记新模型
            </div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
              平台模型目录中心化：登记后 worker 上报 capabilities.models 合并入库（C3）
            </div>
          </div>
          <button
            type="button"
            data-testid="model-add-cancel"
            aria-label="关闭新增模型弹窗"
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

        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              Provider ID <span aria-hidden style={{ color: "#DC2626" }}>*</span>
            </span>
            <input
              data-testid="model-provider-input"
              type="text"
              placeholder="如 opencode-go / zhipu"
              value={providerID}
              onChange={(e) => setProviderID(e.target.value)}
              disabled={submitting}
              style={{ ...inputBase, fontFamily: fontFamily.mono }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              模型 ID <span aria-hidden style={{ color: "#DC2626" }}>*</span>
            </span>
            <input
              data-testid="model-model-id-input"
              type="text"
              placeholder="如 deepseek-v4-flash"
              value={modelID}
              onChange={(e) => setModelID(e.target.value)}
              disabled={submitting}
              style={{ ...inputBase, fontFamily: fontFamily.mono }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>
              模型名称
            </span>
            <input
              data-testid="model-name-input"
              type="text"
              placeholder="产品视角名（缺省用模型 ID）"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              style={inputBase}
            />
          </div>
        </div>

        {error && (
          <div
            data-testid="model-add-error"
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
            data-testid="model-add-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
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
            取消
          </button>
          <button
            type="button"
            data-testid="model-add-confirm"
            disabled={submitting || !providerID.trim() || !modelID.trim()}
            onClick={() =>
              onSubmit({
                providerID: providerID.trim(),
                modelID: modelID.trim(),
                name: name.trim() || modelID.trim(),
              })
            }
            style={{
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: submitting || !providerID.trim() || !modelID.trim() ? "default" : "pointer",
              opacity: submitting || !providerID.trim() || !modelID.trim() ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "登记中…" : "登记模型"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================ 页面主组件 ================================ */

export default function ModelsManagePage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.roleName === "admin";
  const queryClient = useQueryClient();

  /* 搜索框（受控，按模型名 / provider / modelID 过滤） */
  const [keyword, setKeyword] = useState("");

  /* 选中模型（点击行联动凭据配置区；缺省首个模型 id） */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /* 凭据配置 mock：token 输入 + 目标 worker 多选（空=全部 worker） */
  const [token, setToken] = useState("");
  const [targetWorkers, setTargetWorkers] = useState<Set<string>>(new Set());

  /* 新增模型弹窗 */
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  /* 列表：GET /models（分页 pageSize=100 一次拉全量，对齐 agents 页模式） */
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => api.get<ModelsResponse>("/models", { query: { page: 1, pageSize: 100 } }),
    enabled: !!user,
  });
  const models = modelsQuery.data?.items ?? [];

  /* 选中模型回退：列表加载后默认选中首个 */
  useEffect(() => {
    if (!selectedId && models.length > 0) {
      setSelectedId(models[0].id);
    }
  }, [models, selectedId]);

  /* worker 池：GET /workers（目标 worker 多选数据源 + 可用节点统计） */
  const workersQuery = useQuery({
    queryKey: ["workers"],
    queryFn: () => api.get<ApiWorker[]>("/workers"),
    enabled: !!user,
  });
  const workers = workersQuery.data ?? [];

  /* 可用节点数：在线 worker（status != offline）capabilities.models 含该模型 id 的计数 */
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

  /* 凭据状态：GET /models/:id/credentials（脱敏 fingerprint；按 provider 粒度 C4） */
  const credentialsQuery = useQuery({
    queryKey: ["model-credentials"],
    queryFn: async () => {
      const entries = await Promise.all(
        models.map(async (m) => {
          try {
            return [m.id, await api.get<CredentialView>(`/models/${m.id}/credentials`)] as const;
          } catch {
            // 单模型凭据查询失败不阻断列表（未配置视同 missing）
            return [m.id, { configured: false, fingerprint: null } as CredentialView] as const;
          }
        })
      );
      return new Map(entries);
    },
    enabled: models.length > 0,
  });
  const credentialOf = (m: ApiModel): CredentialView =>
    credentialsQuery.data?.get(m.id) ?? {
      id: m.id,
      providerID: m.providerID,
      configured: false,
      fingerprint: null,
      revokedAt: null,
      createdAt: null,
    };

  const kw = keyword.trim().toLowerCase();
  const filtered =
    kw === ""
      ? models
      : models.filter((m) =>
          `${m.name} ${m.providerID} ${m.modelID}`.toLowerCase().includes(kw)
        );

  const configuredCount = models.filter((m) => credentialOf(m).configured).length;
  const missingCount = models.length - configuredCount;

  const selectedModel = models.find((m) => m.id === selectedId) ?? models[0];

  /* 启停：PATCH /models/:id {enabled}（AdminGuard；非 admin 前端禁用 + 403 兜底） */
  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`/models/${id}`, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });

  /* 凭据保存：POST /models/:id/credentials {token, targetWorkerIds?}
   * 指定 worker → 定向 enqueueCommand；未选 → 全量 broadcastCommand（C5） */
  const saveCredentialMutation = useMutation({
    mutationFn: ({
      id,
      token: tk,
      targetWorkerIds,
    }: {
      id: string;
      token: string;
      targetWorkerIds?: string[];
    }) =>
      api.post(`/models/${id}/credentials`, {
        token: tk,
        ...(targetWorkerIds && targetWorkerIds.length > 0 ? { targetWorkerIds } : {}),
      }),
    onSuccess: () => {
      setToken("");
      setTargetWorkers(new Set());
      queryClient.invalidateQueries({ queryKey: ["model-credentials"] });
    },
  });

  /* 登记新模型：POST /models（AdminGuard；撞唯一键 → 409 MODEL_EXISTS 由后端校验） */
  const createMutation = useMutation({
    mutationFn: (payload: { providerID: string; modelID: string; name: string }) =>
      api.post<ApiModel>("/models", payload),
    onSuccess: (created) => {
      setCreateOpen(false);
      setCreateError(null);
      queryClient.invalidateQueries({ queryKey: ["models"] });
      setSelectedId(created.id);
    },
    onError: (err) => {
      setCreateError(isApiError(err) ? err.message : "登记失败，请稍后重试");
    },
  });

  const toggleWorker = (id: string) => {
    setTargetWorkers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /* 在线 worker 优先排序（对齐原型：在线/离线混合展示） */
  const sortedWorkers = useMemo(
    () =>
      [...workers].sort((a, b) => {
        if (a.status !== "offline" && b.status === "offline") return -1;
        if (a.status === "offline" && b.status !== "offline") return 1;
        return (a.name ?? a.id).localeCompare(b.name ?? b.id);
      }),
    [workers]
  );

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
          {/* ① 工具条：标题 + 计数 + 搜索框 + 添加入口 */}
          <div
            data-testid="manage-toolbar"
            style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}
          >
            <span style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900] }}>
              模型目录
            </span>
            <span
              style={{
                fontSize: fontSize.xs,
                color: neutral[500],
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
                borderRadius: radius.pill,
                padding: "2px 10px",
                fontFamily: fontFamily.mono,
              }}
            >
              {models.length} 个模型 · 已配置 {configuredCount} / 未配置 {missingCount}
            </span>

            {/* 搜索框（按模型名 / provider / modelID 过滤） */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                flex: 1,
                minWidth: 220,
                maxWidth: 320,
                padding: `${space.sm}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
                boxShadow: shadow.sm,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400], lineHeight: 1 }}>
                ⌕
              </span>
              <input
                data-testid="model-search"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索模型名 / provider…"
                aria-label="搜索模型"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontSize: fontSize.md,
                  color: neutral[800],
                  fontFamily: fontFamily.body,
                }}
              />
            </div>

            {/* 添加入口（登记新模型，admin 专属；成员只读隐藏） */}
            {isAdmin && (
              <button
                type="button"
                data-testid="model-add-button"
                onClick={() => setCreateOpen(true)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: space.xs,
                  padding: `${space.sm + 1}px ${space.lg}px`,
                  borderRadius: radius.pill,
                  border: "none",
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  fontSize: fontSize.md,
                  fontWeight: 500,
                  cursor: "pointer",
                  boxShadow: "0 6px 16px rgba(37,99,235,.3)",
                  fontFamily: fontFamily.body,
                  marginLeft: "auto",
                }}
              >
                <span aria-hidden>✚</span>
                新增模型
              </button>
            )}
          </div>

          {/* 列表状态：loading / error */}
          {modelsQuery.isPending ? (
            <div
              data-testid="models-loading"
              style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xxl}px 0`, textAlign: "center" }}
            >
              加载中…
            </div>
          ) : modelsQuery.isError ? (
            <div
              data-testid="models-error"
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
                {isApiError(modelsQuery.error) ? modelsQuery.error.message : "加载模型目录失败"}
              </div>
              <button
                type="button"
                data-testid="models-retry"
                onClick={() => modelsQuery.refetch()}
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
            <>
              {/* ② 模型列表（白卡容器 + 表头行 + 数据行） */}
              <div
                data-testid="model-list"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: space.sm,
                  padding: space.md,
                  borderRadius: radius.lg,
                  backgroundColor: "#FFFFFF",
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
                    全部模型
                  </span>
                  <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                    目录中心化：worker 上报 capabilities.models 合并入库 · agent 模型选择从此拉取（C3/C6）
                  </span>
                  {kw !== "" && (
                    <span
                      style={{
                        fontSize: fontSize.xs,
                        color: "#2563EB",
                        backgroundColor: "#EFF6FF",
                        border: `1px solid #BFDBFE`,
                        borderRadius: radius.pill,
                        padding: "1px 8px",
                        marginLeft: "auto",
                      }}
                    >
                      过滤命中 {filtered.length} / {models.length}
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
                  <span style={{ width: 140, flexShrink: 0 }}>PROVIDER</span>
                  <span style={{ flex: 1, minWidth: 0 }}>模型名称</span>
                  <span style={{ width: 250, flexShrink: 0 }}>模型 ID</span>
                  <span style={{ width: 72, flexShrink: 0 }}>可用节点</span>
                  <span style={{ width: 88, flexShrink: 0 }}>凭据状态</span>
                  <span style={{ width: 36, flexShrink: 0 }}>启用</span>
                </div>

                {/* 模型行 */}
                {filtered.map((m) => (
                  <ModelRow
                    key={m.id}
                    m={m}
                    nodes={nodeCountByModel.get(`${m.providerID}/${m.modelID}`) ?? 0}
                    credential={credentialOf(m).configured ? "configured" : "missing"}
                    enabled={m.enabled}
                    selected={m.id === selectedId}
                    disabled={!isAdmin}
                    onSelect={() => setSelectedId(m.id)}
                    onToggle={() => toggleMutation.mutate({ id: m.id, enabled: !m.enabled })}
                  />
                ))}

                {/* 空结果（过滤无命中） */}
                {filtered.length === 0 && (
                  <div
                    style={{
                      padding: `${space.xxl}px`,
                      textAlign: "center",
                      fontSize: fontSize.md,
                      color: neutral[400],
                    }}
                  >
                    无匹配模型，换个关键词试试
                  </div>
                )}
              </div>

              {/* ③ 凭据配置区：token 输入 + 目标 worker 多选（未选=全部 worker） */}
              <div
                data-testid="credential-section"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: space.lg,
                  padding: `${space.xl}px`,
                  borderRadius: radius.lg,
                  backgroundColor: "#FFFFFF",
                  border: `1px solid ${neutral[200]}`,
                  boxShadow: shadow.md,
                  ...baseFont,
                }}
              >
                {/* 标题行 */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                    <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                      配置模型凭据
                    </span>
                    <span aria-hidden style={{ fontSize: fontSize.lg, color: "#D97706", lineHeight: 1 }}>
                      ◷
                    </span>
                  </div>
                  <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                    17 篇 §3.4 · token 经 AES-256-GCM 加密落库，响应仅返回脱敏 fingerprint
                  </span>
                </div>

                {/* 目标模型 select（provider / 模型名） */}
                <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                  <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>
                    目标模型
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
                    <select
                      data-testid="model-credential-select"
                      value={selectedModel?.id ?? ""}
                      onChange={(e) => setSelectedId(e.target.value)}
                      aria-label="选择目标模型"
                      style={{
                        fontFamily: fontFamily.body,
                        fontSize: fontSize.md,
                        color: neutral[800],
                        backgroundColor: "#FFFFFF",
                        border: `1px solid ${neutral[300]}`,
                        borderRadius: radius.md,
                        padding: `${space.sm}px ${space.md}px`,
                        cursor: "pointer",
                        minWidth: 300,
                      }}
                    >
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.providerID} / {m.name}
                        </option>
                      ))}
                    </select>
                    {selectedModel && (
                      <>
                        <CredentialBadge
                          status={credentialOf(selectedModel).configured ? "configured" : "missing"}
                        />
                        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                          {selectedModel.providerID}/{selectedModel.modelID}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* token 输入（POST 加密落库；已配置显示脱敏 fingerprint） */}
                <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                  <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>
                    API Token
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
                    {selectedModel && credentialOf(selectedModel).configured && (
                      <span
                        style={{
                          fontFamily: fontFamily.mono,
                          fontSize: fontSize.sm,
                          color: neutral[600],
                          letterSpacing: "0.02em",
                          flexShrink: 0,
                        }}
                      >
                        {credentialOf(selectedModel).fingerprint ?? ""}
                      </span>
                    )}
                    <input
                      data-testid="model-credential-input"
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder={
                        selectedModel ? `输入 ${selectedModel.providerID} 的 API token（sk-…）` : "输入 API token"
                      }
                      aria-label="API Token"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        maxWidth: 460,
                        padding: `${space.sm}px ${space.md}px`,
                        borderRadius: radius.md,
                        border: `1px solid ${neutral[300]}`,
                        backgroundColor: "#FFFFFF",
                        fontSize: fontSize.md,
                        color: neutral[800],
                        fontFamily: fontFamily.body,
                        outline: "none",
                      }}
                    />
                    <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                      按 provider 粒度保存，agent 选择该模型时自动生效
                    </span>
                  </div>
                </div>

                {/* 目标 worker 多选（未选=全部 worker） */}
                <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                  <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
                    <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[700] }}>
                      目标 Worker
                    </span>
                    <span style={{ fontSize: fontSize.xs, color: "#2563EB" }}>
                      未选则同步到全部 worker
                    </span>
                    <button
                      type="button"
                      data-testid="model-credential-select-all"
                      onClick={() => setTargetWorkers(new Set(workers.map((w) => w.id)))}
                      style={{
                        fontSize: fontSize.xs,
                        color: neutral[500],
                        border: `1px solid ${neutral[200]}`,
                        borderRadius: radius.sm,
                        backgroundColor: "#FFFFFF",
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
                    data-testid="model-credential-target-workers"
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
                            backgroundColor: checked ? "#EFF6FF" : "#FFFFFF",
                            border: `1px solid ${checked ? "#BFDBFE" : neutral[200]}`,
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
                            style={{ accentColor: "#2563EB", cursor: "pointer" }}
                          />
                          <span
                            aria-hidden
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              backgroundColor: online ? "#059669" : "#94A3B8",
                              flexShrink: 0,
                            }}
                          />
                          {w.name ?? w.id}
                          <span
                            style={{
                              fontSize: fontSize.xs,
                              color: online ? "#059669" : neutral[400],
                            }}
                          >
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

                {/* 底部：保存 + 取消 + 加密说明 */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.md,
                    paddingTop: space.sm,
                    borderTop: `1px solid ${neutral[100]}`,
                  }}
                >
                  <button
                    type="button"
                    data-testid="model-credential-save"
                    disabled={!isAdmin || !selectedModel || !token.trim()}
                    onClick={() =>
                      selectedModel &&
                      saveCredentialMutation.mutate({
                        id: selectedModel.id,
                        token: token.trim(),
                        targetWorkerIds:
                          targetWorkers.size > 0 ? Array.from(targetWorkers) : undefined,
                      })
                    }
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: space.xs,
                      padding: `${space.sm + 1}px ${space.xl}px`,
                      borderRadius: radius.pill,
                      border: "none",
                      backgroundColor: "#2563EB",
                      color: "#FFFFFF",
                      fontSize: fontSize.md,
                      fontWeight: 500,
                      cursor: !isAdmin || !selectedModel || !token.trim() ? "default" : "pointer",
                      opacity: !isAdmin || !selectedModel || !token.trim() ? 0.6 : 1,
                      boxShadow: "0 6px 16px rgba(37,99,235,.3)",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    {saveCredentialMutation.isPending ? "保存中…" : "保存凭据"}
                  </button>
                  <button
                    type="button"
                    data-testid="model-credential-cancel"
                    onClick={() => {
                      setToken("");
                      setTargetWorkers(new Set());
                    }}
                    style={{
                      padding: `${space.sm + 1}px ${space.xl}px`,
                      borderRadius: radius.pill,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: "#FFFFFF",
                      color: neutral[600],
                      fontSize: fontSize.md,
                      cursor: "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    取消
                  </button>
                  <span
                    style={{
                      marginLeft: "auto",
                      display: "flex",
                      alignItems: "center",
                      gap: space.xs,
                      fontSize: fontSize.xs,
                      color: neutral[400],
                    }}
                  >
                    <span aria-hidden style={{ fontSize: fontSize.sm }}>◈</span>
                    下发后 worker 写入 auth.json（600 权限），token 不进日志 / 模型上下文（17 篇 §5.4）
                  </span>
                </div>
              </div>

              {/* 底部说明 */}
              <div
                data-testid="model-hint"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.xs,
                  fontSize: fontSize.xs,
                  color: neutral[400],
                }}
              >
                <span aria-hidden style={{ fontSize: fontSize.sm }}>◷</span>
                模型解析优先级：Agent 显式配置 → 模板默认（baseAgentId 链）→ worker 默认模型 →
                不指定（serve 默认）· 凭据保存后即时下发（C7 / C5）
              </div>
            </>
          )}
        </div>
      </main>

      {/* 新增模型弹窗（admin 专属） */}
      <CreateModelModal
        open={createOpen}
        submitting={createMutation.isPending}
        error={createError}
        onClose={() => setCreateOpen(false)}
        onSubmit={(payload) => createMutation.mutate(payload)}
      />
    </div>
  );
}
