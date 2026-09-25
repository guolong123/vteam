"use client";

/**
 * TriggerDetailModal：触发器详情弹窗（触发 Tab 点击行弹出）。
 *
 * 纯展示组件：数据全部来自列表行（服务端 `toItem` 白名单即列表字段，无详情端点），
 * 故打开零请求、零延迟。行内只保留「来源 · 时间」两行（对齐改版原型），
 * 类型 / 范围 / 归属 / 任务 / 次数 / 跳过原因 等元信息收进本弹窗。
 *
 * 取消入口：仅 Agent 来源渲染（系统触发器只读，服务端有二次强制 403 TRIGGER_SYSTEM_READONLY）。
 */
import { DocModalShell } from "@/src/components/teams/DocModalShell";
import type { TriggerItem } from "@/src/components/teams/TeamRightPanel";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";

const TRIGGER_STATUS_LABEL: Record<string, string> = {
  pending: "待触发",
  firing: "触发中",
  fired: "已触发",
  cancelled: "已取消",
  failed: "失败",
};

const TRIGGER_KIND_LABEL: Record<string, string> = {
  receipt_nudge: "催办",
  review_round_timeout: "评审超时",
  progression_patrol: "进度巡检",
  session_idle_scan: "空闲扫描",
  hook_fire: "定时",
  hook_poll: "条件",
};

/** 绝对时间短标签（无效/缺失返回「—」）。 */
function at(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? new Date(t).toLocaleString("zh-CN") : "—";
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: space.sm,
        padding: `${space.xs}px 0`,
        borderBottom: `1px solid ${neutral[100]}`,
        fontSize: fontSize.sm,
      }}
    >
      <span style={{ flexShrink: 0, width: 72, color: neutral[400] }}>
        {label}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          color: neutral[700],
          wordBreak: "break-word",
          fontFamily: mono ? fontFamily.mono : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function TriggerDetailModal({
  trigger,
  onCancel,
  onClose,
}: {
  /** 当前展示的触发器（null=关闭）。 */
  trigger: TriggerItem | null;
  /** 取消该触发器（缺省或系统来源则不渲染取消入口）。 */
  onCancel?: (t: TriggerItem) => void;
  onClose: () => void;
}) {
  if (!trigger) return null;
  const t = trigger;
  const scope =
    t.display?.scopeTeam ??
    (t.scopeType && t.scopeId ? `${t.scopeType}/${t.scopeId}` : "全局");

  return (
    <DocModalShell
      testid="trigger-detail-modal"
      title={t.display?.description?.trim() || (TRIGGER_KIND_LABEL[t.kind] ?? "触发器")}
      subtitle={TRIGGER_STATUS_LABEL[t.status] ?? t.status}
      subtitleTestid="trigger-detail-status"
      closeTestid="trigger-detail-close"
      onClose={onClose}
    >
      <div data-testid="trigger-detail-body">
        <DetailRow
          label="类型"
          value={TRIGGER_KIND_LABEL[t.kind] ?? t.kind}
        />
        <DetailRow label="来源" value={t.source === "agent" ? "Agent" : "系统"} />
        <DetailRow label="归属" value={t.display?.ownerLabel ?? t.ownerInstanceId ?? "—"} />
        <DetailRow label="范围" value={scope} />
        {t.display?.taskLabel && (
          <DetailRow label="任务" value={t.display.taskLabel} />
        )}
        <DetailRow label="应触发" value={at(t.dueAt)} mono />
        <DetailRow
          label="下次触发"
          value={t.nextFireAt ? at(t.nextFireAt) : "—（一次性或已终态）"}
          mono
        />
        <DetailRow label="创建时间" value={at(t.createdAt)} mono />
        <DetailRow label="已触发" value={`${t.fireCount} 次`} />
        <DetailRow label="尝试次数" value={String(t.attempts)} />
        {t.skipReason && (
          <DetailRow
            label="跳过原因"
            value={<span style={{ color: "#B45309" }}>{t.skipReason}</span>}
          />
        )}
        {t.lastError && (
          <DetailRow
            label="最后错误"
            value={<span style={{ color: "#DC2626" }}>{t.lastError}</span>}
          />
        )}
        <DetailRow label="触发器 ID" value={t.id} mono />
      </div>
      {onCancel && t.source === "agent" && (
        <div style={{ display: "flex", marginTop: space.md }}>
          <button
            type="button"
            data-testid="trigger-detail-cancel"
            onClick={() => onCancel(t)}
            style={{
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              border: "1px solid rgba(239,68,68,0.22)",
              backgroundColor: "rgba(239,68,68,0.06)",
              color: "#DC2626",
              fontSize: fontSize.sm,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            取消该触发器
          </button>
        </div>
      )}
    </DocModalShell>
  );
}
