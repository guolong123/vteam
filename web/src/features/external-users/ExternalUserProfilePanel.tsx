"use client";

/**
 * 外部用户资料维护面板（契约 3.2）
 * =============================================
 * - 顶部只读信息：来源渠道 / 外部标识 / 首次发言 / 最近发言 / 消息数。
 * - 表单：姓名 / 岗位 / 所属公司 / 联系方式；保存走 PATCH /external-users/:id，
 *   成功后 invalidate ["external-users"] 与 ["external-user", id]（左列表 + 消息区头
 *   一起回显新名字），并提示「已保存」；空串提交 = 清空（后端存 null）。
 * - 下方「所在群聊」：点击跳 /chat?c=group:<teamId>，回到对应群聊查看上下文。
 * - 只维护资料，不提供发送/删除能力（契约 0 非目标）。
 */
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@/lib/errors";
import {
  externalUsersApi,
  type UpdateExternalUserPayload,
} from "@/src/api/external-users";
import {
  externalUserAvatarStyle,
  externalUserInitial,
  formatExternalUserTime,
} from "./ExternalUserList";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";

/** 契约 2.3 字段长度上限（与后端 class-validator 对齐）。 */
const MAX_LENGTH = {
  name: 64,
  position: 64,
  company: 128,
  contact: 191,
} as const;

const SOURCE_LABELS: Record<string, string> = {
  wecom_aibot: "企微用户",
  generic_webhook: "通用 Webhook",
  legacy: "历史消息",
};

function sourceLabel(source: string | null | undefined): string {
  if (!source) return "外部渠道";
  return SOURCE_LABELS[source] ?? source;
}

/**
 * 外部标识展示：后端 identity 键形如 `id:<企微 userid>` / `name:<展示名>`
 * （稳定 ID 优先，无 ID 回退展示名）。前缀是实现细节，面板只展示原始标识。
 */
function externalIdLabel(externalId: string | null | undefined): string {
  if (!externalId) return "—";
  return externalId.replace(/^(id|name):/, "");
}

function errorText(err: unknown): string {
  if (isApiError(err)) return err.message;
  return err instanceof Error ? err.message : "操作失败";
}

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: `6px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  fontSize: fontSize.sm,
  fontFamily: fontFamily.body,
  outline: "none",
  backgroundColor: neutral[50],
  color: neutral[800],
};

const readonlyRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "76px 1fr",
  gap: "4px 8px",
  fontSize: fontSize.xs,
};

/** 右侧面板外框：与成员私聊右栏（MemberContextPanel）同宽同构。 */
const panelStyle: CSSProperties = {
  width: 300,
  flexShrink: 0,
  minHeight: 0,
  overflow: "auto",
  backgroundColor: "var(--color-surface)",
  borderLeft: `1px solid ${neutral[200]}`,
  padding: space.lg,
  display: "flex",
  flexDirection: "column",
  gap: space.md,
};

export function ExternalUserProfilePanel({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["external-user", userId],
    queryFn: () => externalUsersApi.get(userId),
    enabled: !!userId,
  });
  const detail = detailQuery.data;

  // 表单草稿：跟随详情同步；用户手动编辑时重置「已保存」提示。
  const [name, setName] = useState("");
  const [position, setPosition] = useState("");
  const [company, setCompany] = useState("");
  const [contact, setContact] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 已同步的服务端版本号：只有详情真的更新（PATCH 回填）才回写表单，
   *  避免窗口重新聚焦触发的无变更 refetch 覆盖用户正在输入的内容。 */
  const syncedUpdatedAtRef = useRef<string | null>(null);

  // 切换用户：清空草稿与提示，避免把上一个人的资料带过来。
  useEffect(() => {
    syncedUpdatedAtRef.current = null;
    setName("");
    setPosition("");
    setCompany("");
    setContact("");
    setSaved(false);
    setError(null);
  }, [userId]);

  // 详情刷新（含 PATCH 后 invalidate 回填）时同步字段；不重置 saved，
  // 否则保存成功后立刻被 refetch 抹掉「已保存」。
  useEffect(() => {
    if (!detail) return;
    if (syncedUpdatedAtRef.current === detail.updatedAt) return;
    syncedUpdatedAtRef.current = detail.updatedAt;
    setName(detail.name ?? "");
    setPosition(detail.position ?? "");
    setCompany(detail.company ?? "");
    setContact(detail.contact ?? "");
  }, [detail]);

  const saveMutation = useMutation({
    mutationFn: (payload: UpdateExternalUserPayload) =>
      externalUsersApi.update(userId, payload),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      // 左列表 + 消息区头部 + 本面板共用这份缓存。
      queryClient.invalidateQueries({ queryKey: ["external-users"] });
      queryClient.invalidateQueries({ queryKey: ["external-user", userId] });
    },
    onError: (err) => {
      setSaved(false);
      setError(errorText(err));
    },
  });

  const submit = () => {
    setSaved(false);
    setError(null);
    saveMutation.mutate({
      name: name.trim(),
      position: position.trim(),
      company: company.trim(),
      contact: contact.trim(),
    });
  };

  /** 字段编辑：输入即取消旧的「已保存」提示。 */
  const editField =
    (setter: (value: string) => void) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      setter(event.target.value);
      setSaved(false);
    };

  if (detailQuery.isPending) {
    return (
      <aside
        data-testid="external-user-profile-panel"
        style={panelStyle}
      >
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>
          加载资料中…
        </div>
      </aside>
    );
  }

  if (detailQuery.isError || !detail) {
    return (
      <aside data-testid="external-user-profile-panel" style={panelStyle}>
        <div role="alert" style={{ fontSize: fontSize.xs, color: "#B91C1C" }}>
          {detailQuery.isError
            ? errorText(detailQuery.error)
            : "该外部用户不存在或不可见"}
        </div>
      </aside>
    );
  }

  return (
    <aside data-testid="external-user-profile-panel" style={panelStyle}>
      {/* 顶部：头像 + 名称 + 来源 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          padding: space.md,
          borderRadius: radius.lg,
          backgroundColor: neutral[50],
          border: `1px solid ${neutral[200]}`,
        }}
      >
        <span style={externalUserAvatarStyle(detail.name, 36)}>
          {externalUserInitial(detail.name)}
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: fontSize.md,
              fontWeight: 700,
              color: neutral[900],
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {detail.name}
          </div>
          <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>
            {sourceLabel(detail.source)} · 外部用户
          </div>
        </div>
      </div>

      {/* 只读信息 */}
      <div
        style={{
          borderTop: `1px solid ${neutral[100]}`,
          paddingTop: space.sm,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>渠道信息（只读）</div>
        <div style={readonlyRowStyle}>
          <span style={{ color: neutral[400] }}>来源渠道</span>
          <span style={{ color: neutral[700] }}>{sourceLabel(detail.source)}</span>
          <span style={{ color: neutral[400] }}>外部标识</span>
          <span
            style={{
              color: neutral[700],
              fontFamily: fontFamily.mono,
              wordBreak: "break-all",
            }}
          >
            {externalIdLabel(detail.externalId)}
          </span>
          <span style={{ color: neutral[400] }}>首次发言</span>
          <span style={{ color: neutral[700] }}>
            {detail.firstMessageAt
              ? new Date(detail.firstMessageAt).toLocaleString("zh-CN")
              : "—"}
          </span>
          <span style={{ color: neutral[400] }}>最近发言</span>
          <span style={{ color: neutral[700] }}>
            {detail.lastMessageAt
              ? new Date(detail.lastMessageAt).toLocaleString("zh-CN")
              : "—"}
          </span>
          <span style={{ color: neutral[400] }}>消息数</span>
          <span style={{ color: neutral[700] }}>
            {detail.messageCount} 条 · {detail.groupCount} 个群聊
          </span>
        </div>
      </div>

      {/* 资料表单 */}
      <div
        style={{
          borderTop: `1px solid ${neutral[100]}`,
          paddingTop: space.sm,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ fontSize: fontSize.xs, fontWeight: 700, color: neutral[700] }}>
          资料维护
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 10, color: neutral[400] }}>姓名</span>
          <input
            data-testid="external-user-name"
            value={name}
            maxLength={MAX_LENGTH.name}
            onChange={editField(setName)}
            placeholder="例如：宋工"
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 10, color: neutral[400] }}>岗位</span>
          <input
            data-testid="external-user-position"
            value={position}
            maxLength={MAX_LENGTH.position}
            onChange={editField(setPosition)}
            placeholder="例如：运维工程师"
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 10, color: neutral[400] }}>所属公司</span>
          <input
            data-testid="external-user-company"
            value={company}
            maxLength={MAX_LENGTH.company}
            onChange={editField(setCompany)}
            placeholder="例如：某某科技"
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 10, color: neutral[400] }}>联系方式</span>
          <input
            data-testid="external-user-contact"
            value={contact}
            maxLength={MAX_LENGTH.contact}
            onChange={editField(setContact)}
            placeholder="手机号 / 邮箱 / 企微号"
            style={inputStyle}
          />
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <button
            type="button"
            data-testid="external-user-save"
            disabled={saveMutation.isPending}
            onClick={submit}
            style={{
              padding: `6px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: saveMutation.isPending ? neutral[200] : "#0D9488",
              color: "#FFF",
              fontSize: fontSize.sm,
              fontWeight: 600,
              cursor: saveMutation.isPending ? "default" : "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            {saveMutation.isPending ? "保存中…" : "保存"}
          </button>
          {saved && (
            <span
              data-testid="external-user-saved"
              role="status"
              style={{ fontSize: fontSize.xs, color: "#0F766E" }}
            >
              已保存
            </span>
          )}
        </div>
        {error && (
          <div role="alert" style={{ fontSize: fontSize.xs, color: "#B91C1C" }}>
            {error}
          </div>
        )}
      </div>

      {/* 所在群聊 */}
      <div
        style={{
          borderTop: `1px solid ${neutral[100]}`,
          paddingTop: space.sm,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>
          所在群聊 · {detail.groups.length}
        </div>
        {detail.groups.length === 0 ? (
          <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            暂无可见群聊
          </div>
        ) : (
          detail.groups.map((group) => (
            <a
              key={`${group.teamId}-${group.channelId}`}
              href={`/chat?c=${encodeURIComponent(`group:${group.teamId}`)}`}
              title={`${group.teamName ?? group.teamId} · ${group.messageCount} 条消息`}
              style={{
                textDecoration: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: space.sm,
                fontSize: fontSize.xs,
                color: "#0F766E",
                padding: "4px 8px",
                borderRadius: radius.sm,
                backgroundColor: "rgba(13,148,136,0.06)",
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {group.teamName ?? group.teamId}
              </span>
              <span style={{ flexShrink: 0, color: neutral[400] }}>
                {group.messageCount} 条
                {group.lastMessageAt
                  ? ` · ${formatExternalUserTime(group.lastMessageAt)}`
                  : ""}
              </span>
            </a>
          ))
        )}
      </div>

      <div
        style={{
          marginTop: "auto",
          borderTop: `1px solid ${neutral[100]}`,
          paddingTop: space.sm,
          fontSize: 10,
          color: neutral[400],
          lineHeight: 1.6,
        }}
      >
        外部用户由渠道入站消息自动沉淀；资料仅在本平台维护，不回写外部系统。
      </div>
    </aside>
  );
}
