"use client";

/**
 * 会话压缩的平台配置面板（/system/settings 的一个分区）。
 *
 * 数据源：GET /platform-configs（仅管理员可读写，AdminGuard）。
 * 四个参数见 docs/agent-platform/context-compaction-idle.md：
 * - 不活跃天数（0 = 关闭特性）
 * - 上下文下限（token，低于该值不压）
 * - 等压缩完成上限（ms，超时放弃压缩、照常投递）
 * - 压缩超时预算（ms）
 *
 * 保存走批量端点 PATCH /platform-configs（单事务，任一非法整体回滚）。
 * 保存前本地校验一遍，减少无谓往返；服务端校验仍是最终口径。
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  platformConfigApi,
  SESSION_COMPACT_KEYS,
  type PlatformConfigDto,
} from "@/src/api/platform-config";
import { fontSize, fontFamily, neutral, space, radius } from "@/src/theme/tokens";

interface FieldSpec {
  key: string;
  label: string;
  unit: string;
  hint: string;
  min: number;
}

const FIELDS: FieldSpec[] = [
  {
    key: SESSION_COMPACT_KEYS.idleDays,
    label: "不活跃天数",
    unit: "天",
    hint: "超过该天数不活跃的会话，下次发消息前自动压缩；填 0 关闭该特性。",
    min: 0,
  },
  {
    key: SESSION_COMPACT_KEYS.minContextTokens,
    label: "上下文下限",
    unit: "token",
    hint: "上下文小于该值不压缩，避免小会话无谓压缩。",
    min: 0,
  },
  {
    key: SESSION_COMPACT_KEYS.awaitMs,
    label: "等待压缩上限",
    unit: "毫秒",
    hint: "等压缩完成的最长时间；超时则放弃压缩、照常投递消息。",
    min: 0,
  },
  {
    key: SESSION_COMPACT_KEYS.timeoutMs,
    label: "压缩超时预算",
    unit: "毫秒",
    hint: "压缩本身允许的最长执行时间。",
    min: 0,
  },
];

const QUERY_KEY = ["platform-configs"];

export function SessionCompactConfigPanel() {
  const queryClient = useQueryClient();
  const query = useQuery<PlatformConfigDto[]>({
    queryKey: QUERY_KEY,
    queryFn: () => platformConfigApi.list(),
  });

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 服务端数据到位后，初始化/同步输入框（保存成功后也会重新拉取）。
  useEffect(() => {
    if (!query.data) return;
    const byKey = new Map(query.data.map((c) => [c.key, c.value]));
    const next: Record<string, string> = {};
    for (const field of FIELDS) {
      next[field.key] = byKey.get(field.key) ?? "0";
    }
    setDrafts(next);
  }, [query.data]);

  const saveMutation = useMutation({
    mutationFn: (configs: Record<string, string>) =>
      platformConfigApi.updateMany(configs),
    onSuccess: async () => {
      setError(null);
      setNotice("已保存");
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err: unknown) => {
      setNotice(null);
      setError(err instanceof Error ? err.message : "保存失败");
    },
  });

  const handleSave = () => {
    setNotice(null);
    setError(null);
    // 本地校验：全部必须是非负整数。
    for (const field of FIELDS) {
      const raw = (drafts[field.key] ?? "").trim();
      if (raw === "" || !/^\d+$/.test(raw)) {
        setError(`「${field.label}」需要填写非负整数`);
        return;
      }
    }
    saveMutation.mutate(
      Object.fromEntries(FIELDS.map((f) => [f.key, drafts[f.key].trim()])),
    );
  };

  return (
    <section
      data-testid="session-compact-config"
      style={{
        padding: space.lg,
        borderRadius: radius.md,
        border: `1px solid ${neutral[200]}`,
        backgroundColor: "var(--color-surface)",
        display: "flex",
        flexDirection: "column",
        gap: space.md,
      }}
    >
      <div>
        <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
          会话上下文压缩
        </div>
        <div style={{ marginTop: 4, fontSize: fontSize.xs, color: neutral[400] }}>
          长期不活跃的会话，在用户下一次发消息前先压缩上下文再投递。仅管理员可修改，保存后对所有会话立即生效。
        </div>
      </div>

      {query.isLoading && (
        <div style={{ fontSize: fontSize.sm, color: neutral[400] }}>加载中…</div>
      )}
      {query.isError && (
        <div style={{ fontSize: fontSize.sm, color: "#dc2626" }}>
          加载失败：{query.error instanceof Error ? query.error.message : "请确认有管理员权限"}
        </div>
      )}

      {query.data && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
            {FIELDS.map((field) => (
              <label
                key={field.key}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  fontFamily: fontFamily.body,
                }}
              >
                <span style={{ fontSize: fontSize.sm, color: neutral[700], fontWeight: 500 }}>
                  {field.label}（{field.unit}）
                </span>
                <input
                  data-testid={`compact-config-${field.key}`}
                  type="number"
                  min={field.min}
                  step={1}
                  value={drafts[field.key] ?? ""}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  style={{
                    padding: `${space.sm}px ${space.md}px`,
                    borderRadius: radius.sm,
                    border: `1px solid ${neutral[200]}`,
                    fontFamily: fontFamily.body,
                    fontSize: fontSize.sm,
                    maxWidth: 320,
                  }}
                />
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  {field.hint}
                </span>
              </label>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
            <button
              type="button"
              data-testid="compact-config-save"
              onClick={handleSave}
              disabled={saveMutation.isPending}
              style={{
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.sm,
                border: "none",
                backgroundColor: saveMutation.isPending ? neutral[300] : "#0D9488",
                color: "#fff",
                cursor: saveMutation.isPending ? "not-allowed" : "pointer",
                fontWeight: 600,
                fontFamily: fontFamily.body,
              }}
            >
              {saveMutation.isPending ? "保存中…" : "保存"}
            </button>
            {notice && (
              <span style={{ fontSize: fontSize.sm, color: "#0D9488" }}>{notice}</span>
            )}
            {error && (
              <span style={{ fontSize: fontSize.sm, color: "#dc2626" }}>{error}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
