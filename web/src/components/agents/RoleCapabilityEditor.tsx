"use client";

/**
 * 岗位业务能力点编辑器（角色 Tab 内嵌；data-testid=role-capability-editor）
 * =============================================
 * 把「平台能力点」直接做进角色配置：一行一个能力点 = 中文名（主） + 能力点 key 与覆盖工具
 * （次） + 二进制 允许/拒绝 分段控制。视觉/交互镜像 Agent Tab 的权限矩阵（三态分段
 * ToolEffectSelect、行卡片、mono key 次行），但本编辑器**只有两态**（无 ask）。
 *
 * 判定语义（与 SLICE 6a 契约一致）：
 * - `false` = 拒绝；缺失键 = 允许（缺省允许）；
 * - `fromFactory`（服务端 `capabilities === null`）→ 展示出厂默认并明示「尚未保存」；
 * - 目录外的存储键（服务端目录更新/历史键）单独成组渲染，保存时原样带回。
 *
 * 受控组件：不持有 state；每次点击经 onChange(key, allowed) 上抛，由父级 draft 落值。
 */
import { type CSSProperties } from "react";
import {
  ROLE_CAPABILITIES,
  ROLE_CAPABILITY_GROUPS,
  capabilityOf,
  type RoleCapability,
} from "@/src/api/role-capabilities";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

/** 二进制档位配色（与 Agent 权限矩阵 toolEffectMeta 的 allow / deny 同值）。 */
const ALLOWED_COLOR = "#059669";
const DENIED_COLOR = "#DC2626";

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: space.md,
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  backgroundColor: "var(--color-surface)",
  border: `1px solid ${neutral[200]}`,
  fontSize: fontSize.sm,
};

const toggleContainerStyle: CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  gap: 2,
  padding: 3,
  borderRadius: radius.pill,
  backgroundColor: neutral[50],
  border: `1px solid ${neutral[200]}`,
};

const hintChipStyle: CSSProperties = {
  fontSize: fontSize.xs,
  fontWeight: 600,
  color: "#D97706",
  backgroundColor: "rgba(245,158,11,0.10)",
  border: "1px solid rgba(245,158,11,0.28)",
  borderRadius: radius.pill,
  padding: "1px 7px",
  whiteSpace: "nowrap",
};

/** 单行：label（主）+ key · tools（次）+ 二进制开关。extra=目录外键（无中文名/无出厂语义）。 */
function CapabilityRow({
  capability,
  allowed,
  extra,
  disabled,
  pending,
  onChange,
}: {
  capability: RoleCapability;
  allowed: boolean;
  extra: boolean;
  disabled: boolean;
  pending: boolean;
  onChange: (key: string, allowed: boolean) => void;
}) {
  const isFactoryDenied = !extra && capability.factoryDefault === false;
  return (
    <div
      data-testid="role-capability-row"
      data-capability={capability.key}
      data-allowed={allowed ? "true" : "false"}
      data-factory-default={isFactoryDenied ? "deny" : "allow"}
      data-extra={extra ? "true" : undefined}
      style={rowStyle}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}>
          <span
            data-testid="capability-label"
            style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}
          >
            {capability.label}
          </span>
          {extra && (
            <span data-testid="capability-extra-hint" style={{ ...hintChipStyle, color: neutral[500], backgroundColor: neutral[100], border: `1px solid ${neutral[200]}` }}>
              清单未收录
            </span>
          )}
        </span>
        <span style={{ fontFamily: fontFamily.mono, fontSize: fontSize.xs, color: neutral[500], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {capability.key}
          {capability.tools.length > 0 && (
            <span style={{ color: neutral[400] }}> · {capability.tools.join(" / ")}</span>
          )}
        </span>
      </span>
      <span
        role="radiogroup"
        aria-label={`${capability.label} 能力`}
        style={{ ...toggleContainerStyle, opacity: pending ? 0.6 : 1 }}
      >
        {[
          { allowed: true, label: "允许", color: ALLOWED_COLOR },
          { allowed: false, label: "拒绝", color: DENIED_COLOR },
        ].map((option) => {
          const active = allowed === option.allowed;
          return (
            <span
              key={option.label}
              data-testid="capability-toggle"
              data-capability={capability.key}
              data-allow={option.allowed ? "true" : "false"}
              role="radio"
              aria-checked={active}
              aria-disabled={disabled}
              onClick={disabled ? undefined : () => onChange(capability.key, option.allowed)}
              style={{
                padding: `2px ${space.sm}px`,
                borderRadius: radius.pill,
                fontSize: fontSize.xs,
                fontWeight: 500,
                cursor: disabled ? "default" : "pointer",
                fontFamily: fontFamily.body,
                color: active ? "#FFFFFF" : neutral[500],
                backgroundColor: active ? option.color : "transparent",
              }}
            >
              {option.label}
            </span>
          );
        })}
      </span>
    </div>
  );
}

export function RoleCapabilityEditor({
  value,
  fromFactory,
  creating,
  readOnly,
  pending,
  onChange,
}: {
  /** 完整能力点 map（目录键恒在；目录外键也在此）。 */
  value: Record<string, boolean>;
  /** true = 服务端 `capabilities === null`（从未保存）→ 当前显示出厂默认。 */
  fromFactory: boolean;
  /** 新建岗位（无已保存值；note 文案区分「出厂预设」与「尚未保存」）。 */
  creating: boolean;
  readOnly: boolean;
  pending: boolean;
  onChange: (key: string, allowed: boolean) => void;
}) {
  const disabled = readOnly || pending;
  const extraKeys = Object.keys(value).filter((key) => !capabilityOf(key));

  const sourceNote = creating
    ? "新建岗位默认使用出厂预设（敏感点为拒绝）；保存时写入完整能力点表。"
    : fromFactory
      ? "该岗位尚未保存过能力点，当前显示出厂默认（敏感点为拒绝）；保存后以保存值为准。"
      : "已保存能力点矩阵；未在本表中的能力点按允许处理（缺省允许）。";

  return (
    <div
      data-testid="role-capability-editor"
      data-source={fromFactory ? "factory-default" : "stored"}
      data-readonly={readOnly ? "true" : "false"}
      data-creating={creating ? "true" : "false"}
      data-allowed-count={Object.values(value).filter((v) => v !== false).length}
      style={{ display: "flex", flexDirection: "column", gap: space.sm, width: "100%" }}
    >
      <span
        data-testid="role-capability-source-note"
        style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5 }}
      >
        {sourceNote}
      </span>

      {ROLE_CAPABILITY_GROUPS.map((group) => {
        const capabilities = ROLE_CAPABILITIES.filter((cap) => cap.group === group.key);
        if (capabilities.length === 0) return null;
        return (
          <div key={group.key} data-testid="capability-group" data-group={group.key} style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <span style={{ display: "flex", alignItems: "center", gap: space.xs, padding: `0 ${space.xs}px` }}>
              <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>{group.label}</span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{capabilities.length} 项</span>
            </span>
            {capabilities.map((capability) => (
              <CapabilityRow
                key={capability.key}
                capability={capability}
                allowed={value[capability.key] !== false}
                extra={false}
                disabled={disabled}
                pending={pending}
                onChange={onChange}
              />
            ))}
          </div>
        );
      })}

      {extraKeys.length > 0 && (
        <div data-testid="capability-group" data-group="extra" style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <span style={{ display: "flex", alignItems: "center", gap: space.xs, padding: `0 ${space.xs}px` }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>其他</span>
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{extraKeys.length} 项（当前清单未收录，保存时原样保留）</span>
          </span>
          {extraKeys.map((key) => (
            <CapabilityRow
              key={key}
              capability={{ key, label: key, group: "extra", tools: [], factoryDefault: true }}
              allowed={value[key] !== false}
              extra
              disabled={disabled}
              pending={pending}
              onChange={onChange}
            />
          ))}
        </div>
      )}

      <span style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5 }}>
        缺省允许：未保存/未列出的能力点按允许处理；出厂预设拒绝的敏感点以「拒绝」档位显示，放开需手动切换。
      </span>
    </div>
  );
}
