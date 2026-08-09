"use client";

/**
 * 模型管理页（主入口 —— 双 Tab：模型目录 / Provider 管理）
 * =============================================
 * 用户需求：「主入口应该只有一个模型管理，进去后通过 tab 页管理两个页面，支持切换」。
 *
 * - Tab 1 模型目录（catalog）：纯展示列表（provider 列 + 模型名称列 + 模型ID列 +
 *   可用节点 + 凭据状态徽章 + enabled 只读徽章）+ 搜索（model-search，本地受控）。
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
import { useQuery } from "@tanstack/react-query";
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
import type { ApiModel, ApiWorker, CredentialView, ModelsResponse } from "@/src/types/models";
import ProvidersTab from "./providers-tab";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 页面内扩展 token（仿原型范式，不写 tokens.ts） ------------------------------ */

/** 凭据状态「已配置 / 未配置」语义独立于任务四态，遵循"扩展 token"范式页面内定义。 */
const credentialTheme = {
  configured: { label: "已配置", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  missing: { label: "未配置", color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
} as const;

/** 启用状态徽章主色（与导航高亮蓝同族） */
const activeBlue = "#2563EB";

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

/** 启用状态只读徽章：已启用=蓝 / 已停用=灰（替代原 model-toggle 写操作开关）。 */
function EnabledBadge({ enabled }: { enabled: boolean }) {
  const theme = enabled
    ? { label: "已启用", color: activeBlue, bg: "#EFF6FF", border: "#BFDBFE" }
    : { label: "已停用", color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" };
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

/** 模型行卡片：provider 列 + 名称列 + 模型ID列 + 可用节点 + 凭据状态 + 启用状态（只读）。 */
function ModelRow({
  m,
  nodes,
  credential,
  enabled,
}: {
  /** 目录行（id=md_xxx；展示 id 用 providerID/modelID 组合） */
  m: ApiModel;
  /** 可用节点数（在线 worker capabilities.models 含该模型） */
  nodes: number;
  credential: CredentialStatus;
  enabled: boolean;
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
        backgroundColor: "#FFFFFF",
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
    </div>
  );
}

/* ================================ 页面主组件 ================================ */

/** 双 Tab：模型目录（catalog）/ Provider 管理（providers） */
type TabKey = "catalog" | "providers";

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "catalog", label: "模型目录", icon: "◇" },
  { key: "providers", label: "Provider 管理", icon: "◈" },
];

export default function ModelsPage() {
  const user = useAuthStore((s) => s.user);

  /* 双 Tab（受控，对齐 skills 页 manage-tabs/manage-tab 模式） */
  const [tab, setTab] = useState<TabKey>("catalog");

  /* 搜索框（受控，按模型名 / provider / modelID 过滤；仅模型目录 Tab 展示） */
  const [keyword, setKeyword] = useState("");

  /* 列表：GET /models（分页 pageSize=100 一次拉全量，对齐 agents 页模式） */
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => api.get<ModelsResponse>("/models", { query: { page: 1, pageSize: 100 } }),
    enabled: !!user,
  });
  const models = modelsQuery.data?.items ?? [];

  /* worker 池：GET /workers（可用节点统计） */
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
  const credentialOf = (m: ApiModel): CredentialStatus =>
    credentialsQuery.data?.get(m.id)?.configured ? "configured" : "missing";

  const kw = keyword.trim().toLowerCase();
  const filtered =
    kw === ""
      ? models
      : models.filter((m) =>
          `${m.name} ${m.providerID} ${m.modelID}`.toLowerCase().includes(kw)
        );

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
          {/* ① 工具条：双 Tab 切换 + 搜索框（仅模型目录 Tab） */}
          <div
            data-testid="manage-toolbar"
            style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}
          >
            {/* 双 Tab（受控切换，对齐 skills 页 manage-tabs/manage-tab 模式） */}
            <div
              data-testid="manage-tabs"
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.xs,
                padding: space.xs,
                borderRadius: radius.lg,
                backgroundColor: neutral[100],
                border: `1px solid ${neutral[200]}`,
              }}
            >
              {TABS.map((t) => {
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    data-testid="manage-tab"
                    data-kind={t.key}
                    data-active={active ? "true" : "false"}
                    onClick={() => setTab(t.key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.sm,
                      padding: `${space.sm + 1}px ${space.lg}px`,
                      borderRadius: radius.md,
                      border: "none",
                      backgroundColor: active ? "#FFFFFF" : "transparent",
                      boxShadow: active ? shadow.sm : "none",
                      cursor: "pointer",
                      fontFamily: fontFamily.body,
                      fontSize: fontSize.md,
                      fontWeight: active ? 600 : 500,
                      color: active ? neutral[900] : neutral[600],
                    }}
                  >
                    <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>
                      {t.icon}
                    </span>
                    {t.label}
                  </button>
                );
              })}
            </div>

            {/* 搜索框（按模型名 / provider / modelID 过滤；仅模型目录 Tab 展示） */}
            {tab === "catalog" && (
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
                  marginLeft: "auto",
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
            )}
          </div>

          {/* ② Tab 内容：模型目录（catalog） / Provider 管理（providers，独立视图组件） */}
          {tab === "providers" ? (
            <ProvidersTab />
          ) : modelsQuery.isPending ? (
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
            /* ② 模型列表（白卡容器 + 表头行 + 数据行） */
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
                <span
                  style={{
                    fontSize: fontSize.xs,
                    color: neutral[500],
                    backgroundColor: neutral[50],
                    border: `1px solid ${neutral[200]}`,
                    borderRadius: radius.pill,
                    padding: "2px 10px",
                    fontFamily: fontFamily.mono,
                  }}
                >
                  {models.length} 个模型 · 已配置 {configuredCount} / 未配置 {missingCount}
                </span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  只读展示 · 凭证管理请切换到「Provider 管理」Tab
                </span>
                {kw !== "" && (
                  <span
                    style={{
                      fontSize: fontSize.xs,
                      color: activeBlue,
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
                <span style={{ width: 72, flexShrink: 0 }}>启用</span>
              </div>

              {/* 模型行 */}
              {filtered.map((m) => (
                <ModelRow
                  key={m.id}
                  m={m}
                  nodes={nodeCountByModel.get(`${m.providerID}/${m.modelID}`) ?? 0}
                  credential={credentialOf(m)}
                  enabled={m.enabled}
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
          )}

          {/* 底部说明（仅模型目录 Tab） */}
          {tab === "catalog" && (
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
          )}
        </div>
      </main>
    </div>
  );
}
