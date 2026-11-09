"use client";

/**
 * /system/settings —— 全局设置（当前：聊天流式输出样式）。
 *
 * 私聊消息渲染保留两套实现：
 * - 原生：现有气泡 + 过程折叠（MsgParts variant="bubble"）
 * - DSH：DSH 风格的流式过程展示（MsgParts variant="dsh"）
 * 偏好存 localStorage（zustand persist），只影响本浏览器。
 */
import { useChatPrefsStore, type ChatStreamStyle } from "@/lib/stores/chat-prefs-store";
import { fontSize, fontFamily, neutral, space, radius } from "@/src/theme/tokens";

const OPTIONS: Array<{
  value: ChatStreamStyle;
  title: string;
  desc: string;
}> = [
  {
    value: "native",
    title: "原生气泡（默认）",
    desc: "消息按气泡展示，思考/工具过程合并为可折叠摘要。",
  },
  {
    value: "dsh",
    title: "DSH 流式样式",
    desc: "私聊按 DSH 风格渲染：过程与正文流式展开，适合观察执行过程。",
  },
];

export default function GlobalSettingsPage() {
  const streamStyle = useChatPrefsStore((s) => s.streamStyle);
  const setStreamStyle = useChatPrefsStore((s) => s.setStreamStyle);

  return (
    <div data-testid="global-settings-root" style={{ padding: space.xl, display: "flex", flexDirection: "column", gap: space.lg, fontFamily: fontFamily.body }}>
      <div>
        <div style={{ fontSize: fontSize.lg, fontWeight: 700, color: neutral[900] }}>全局设置</div>
        <div style={{ marginTop: 4, fontSize: fontSize.xs, color: neutral[400] }}>
          仅影响当前浏览器；不改变服务端数据。
        </div>
      </div>

      <section
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
          <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>流式输出样式</div>
          <div style={{ marginTop: 4, fontSize: fontSize.xs, color: neutral[400] }}>
            选择私聊消息的渲染风格，切换后重新打开会话生效。
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          {OPTIONS.map((opt) => {
            const active = streamStyle === opt.value;
            return (
              <label
                key={opt.value}
                data-testid={`stream-style-${opt.value}`}
                style={{
                  display: "flex",
                  gap: space.sm,
                  alignItems: "flex-start",
                  padding: `${space.md}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${active ? "#0D9488" : neutral[200]}`,
                  backgroundColor: active ? "rgba(13,148,136,0.06)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="stream-style"
                  checked={active}
                  onChange={() => setStreamStyle(opt.value)}
                  style={{ marginTop: 3 }}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>{opt.title}</span>
                  <span style={{ fontSize: fontSize.xs, color: neutral[500] }}>{opt.desc}</span>
                </span>
              </label>
            );
          })}
        </div>
      </section>
    </div>
  );
}
