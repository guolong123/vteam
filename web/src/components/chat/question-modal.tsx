/**
 * QuestionModal：模型提问 / 工具权限确认弹窗（worker 检测 serve pending → ingress 落库 → SSE → 本组件）。
 * =============================================
 * - kind=question：header + question + 选项列表（单选/多选按 multiple）+ 自定义输入（custom）+「拒绝」；
 * - kind=permission：title + pattern + 三个按钮「允许一次(once) / 总是允许(always) / 拒绝(reject)」；
 * - 确认调 reply API（POST /questions/:id/reply），成功关闭；拒绝调 replies=null / response=reject；
 * - 风格对齐 ConfirmDialog（token 引用 @/src/theme/tokens，absolute 相对宿主，无 fixed/100vh）；
 * - 弹窗不阻塞消息列表（仅视觉层覆盖，消息流 delta 照常滚动渲染）。
 */
import { useEffect, useState, type CSSProperties } from "react";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** serve question 选项/单条（对齐 use-realtime RealtimeQuestionInfo）。 */
export interface QuestionModalOption {
  label: string;
  description: string;
}
export interface QuestionModalItem {
  question: string;
  header: string;
  options: QuestionModalOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** AgentQuestion DTO（对齐 GET /questions 响应项 / agent.question 事件 payload.question）。 */
export interface QuestionModalData {
  id: string;
  requestId: string;
  kind: "question" | "permission";
  content:
    | { questions: QuestionModalItem[] }
    | { title?: string; pattern?: string | string[] | null; type?: string };
  status: string;
  taskId: string | null;
  agentId: string | null;
}

export interface QuestionModalProps {
  open: boolean;
  /** 当前待处理的 AgentQuestion（null 关闭）。 */
  question: QuestionModalData | null;
  submitting?: boolean;
  onClose: () => void;
  /** 提交回复（question: answers label 数组/null=拒绝；permission: response）。 */
  onSubmit: (payload: {
    answers?: string[][] | null;
    response?: "once" | "always" | "reject";
  }) => void;
}

/** 权限确认按钮（once/always/reject）。 */
const PERMISSION_ACTIONS: Array<{ value: "once" | "always" | "reject"; label: string }> = [
  { value: "once", label: "允许一次" },
  { value: "always", label: "总是允许" },
  { value: "reject", label: "拒绝" },
];

export function QuestionModal({
  open,
  question,
  submitting = false,
  onClose,
  onSubmit,
}: QuestionModalProps) {
  // question 多选/自定义输入的选择态（重开时重置）
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [customInput, setCustomInput] = useState("");

  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setCustomInput("");
    }
  }, [open]);

  // Esc 关闭（对齐 ConfirmDialog / reject-modal 模式）
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open || !question) return null;

  const isPermission = question.kind === "permission";
  const permissionContent =
    !isPermission || typeof question.content === "object" && "questions" in question.content
      ? null
      : (question.content as { title?: string; pattern?: string | string[] | null; type?: string });
  const questions =
    isPermission || !("questions" in (question.content ?? {}))
      ? []
      : ((question.content as { questions: QuestionModalItem[] }).questions ?? []);

  const toggleOption = (index: number, multiple?: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (multiple) {
        next.has(index) ? next.delete(index) : next.add(index);
      } else {
        next.clear();
        next.add(index);
      }
      return next;
    });
  };

  const buildAnswers = (): string[][] =>
    questions.map((q, i) => {
      const labels = [...selected].map((idx) => questions[idx]?.options[idx]?.label ?? "").filter(Boolean);
      const custom = q.custom && customInput.trim() ? [customInput.trim()] : [];
      // 单选：只保留当前 question 的选中项
      const own = q.multiple ? labels : i === [...selected][0] && [...selected].length > 0 && !q.multiple ? labels : [];
      return [...own, ...custom];
    });

  const canSubmit = isPermission || questions.every((q) => {
    if (q.custom && customInput.trim()) return true;
    if (!q.options.length) return false;
    return [...selected].length > 0;
  });

  return (
    <div
      data-testid="question-modal"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10%",
        ...baseFont,
      }}
    >
      {/* 遮罩：点击关闭（不阻塞底层消息流，仅视觉覆盖） */}
      <div
        aria-hidden
        data-testid="question-modal-mask"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      {/* 弹窗卡片 */}
      <div
        role="dialog"
        aria-label={isPermission ? "权限确认" : "Agent 提问"}
        style={{
          position: "relative",
          width: 440,
          maxWidth: "calc(100% - 48px)",
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
        }}
      >
        <div>
          <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
            {isPermission ? "工具权限确认" : "Agent 需要您的确认"}
          </div>
          {isPermission && permissionContent && (
            <div style={{ marginTop: space.sm, display: "flex", flexDirection: "column", gap: space.xs }}>
              <div style={{ fontSize: fontSize.md, color: neutral[700], fontWeight: 500 }}>
                {permissionContent.title ?? permissionContent.type ?? "权限请求"}
              </div>
              {permissionContent.pattern && (
                <code
                  style={{
                    fontSize: fontSize.sm,
                    color: neutral[600],
                    backgroundColor: neutral[50],
                    borderRadius: radius.sm,
                    padding: `${2}px ${space.sm}px`,
                    alignSelf: "flex-start",
                    fontFamily: fontFamily.mono,
                  }}
                >
                  {Array.isArray(permissionContent.pattern)
                    ? permissionContent.pattern.join(", ")
                    : permissionContent.pattern}
                </code>
              )}
            </div>
          )}
        </div>

        {!isPermission && (
          <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
            {questions.length === 0 && (
              <div style={{ fontSize: fontSize.sm, color: neutral[500] }}>（无详细问题内容）</div>
            )}
            {questions.map((q, qIdx) => (
              <div key={qIdx} style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
                  {q.header ? <span style={{ color: neutral[500], fontWeight: 500, marginRight: space.sm }}>{q.header}</span> : null}
                  {q.question}
                </div>
                {q.options.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                    {q.options.map((opt, optIdx) => {
                      const globalIdx = qIdx * 100 + optIdx;
                      const isSelected = selected.has(globalIdx);
                      return (
                        <button
                          key={optIdx}
                          type="button"
                          data-testid={`question-option-${qIdx}-${optIdx}`}
                          onClick={() => toggleOption(globalIdx, q.multiple)}
                          style={{
                            textAlign: "left",
                            padding: `${space.sm + 1}px ${space.md}px`,
                            borderRadius: radius.md,
                            border: `1px solid ${isSelected ? "#2563EB" : neutral[200]}`,
                            backgroundColor: isSelected ? "#EFF6FF" : "#FFFFFF",
                            color: neutral[800],
                            fontSize: fontSize.md,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "flex-start",
                            gap: space.sm,
                            fontFamily: fontFamily.body,
                          }}
                        >
                          <span style={{ color: isSelected ? "#2563EB" : neutral[400], fontWeight: 600, flexShrink: 0 }}>
                            {q.multiple ? (isSelected ? "☑" : "☐") : isSelected ? "◉" : "○"}
                          </span>
                          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <span>{opt.label}</span>
                            {opt.description && (
                              <span style={{ fontSize: fontSize.xs, color: neutral[500] }}>{opt.description}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {q.custom && (
                  <input
                    data-testid={`question-custom-${qIdx}`}
                    value={customInput}
                    onChange={(e) => setCustomInput(e.target.value)}
                    placeholder="输入自定义答案…"
                    style={{
                      padding: `${space.sm + 1}px ${space.md}px`,
                      borderRadius: radius.md,
                      border: `1px solid ${neutral[200]}`,
                      fontSize: fontSize.md,
                      fontFamily: fontFamily.body,
                      outline: "none",
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm }}>
          {isPermission ? (
            <>
              <button
                type="button"
                data-testid="question-modal-close"
                onClick={onClose}
                disabled={submitting}
                style={{
                  padding: `${space.sm + 1}px ${space.lg}px`,
                  borderRadius: radius.pill,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "#FFFFFF",
                  color: neutral[600],
                  fontSize: fontSize.md,
                  cursor: submitting ? "default" : "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                稍后决定
              </button>
              {PERMISSION_ACTIONS.map((action) => (
                <button
                  key={action.value}
                  type="button"
                  data-testid={`question-permission-${action.value}`}
                  onClick={() => onSubmit({ response: action.value })}
                  disabled={submitting}
                  style={{
                    padding: `${space.sm + 1}px ${space.lg}px`,
                    borderRadius: radius.pill,
                    border: "none",
                    backgroundColor:
                      action.value === "reject" ? "#DC2626" : action.value === "always" ? "#059669" : "#2563EB",
                    color: "#FFFFFF",
                    fontSize: fontSize.md,
                    fontWeight: 500,
                    cursor: submitting ? "default" : "pointer",
                    opacity: submitting ? 0.6 : 1,
                    fontFamily: fontFamily.body,
                  }}
                >
                  {submitting ? "处理中…" : action.label}
                </button>
              ))}
            </>
          ) : (
            <>
              <button
                type="button"
                data-testid="question-reject"
                onClick={() => onSubmit({ answers: null })}
                disabled={submitting}
                style={{
                  padding: `${space.sm + 1}px ${space.lg}px`,
                  borderRadius: radius.pill,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "#FFFFFF",
                  color: "#B91C1C",
                  fontSize: fontSize.md,
                  cursor: submitting ? "default" : "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                拒绝
              </button>
              <button
                type="button"
                data-testid="question-submit"
                onClick={() => onSubmit({ answers: buildAnswers() })}
                disabled={submitting || !canSubmit}
                style={{
                  padding: `${space.sm + 1}px ${space.lg}px`,
                  borderRadius: radius.pill,
                  border: "none",
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  fontSize: fontSize.md,
                  fontWeight: 500,
                  cursor: submitting || !canSubmit ? "default" : "pointer",
                  opacity: submitting || !canSubmit ? 0.6 : 1,
                  fontFamily: fontFamily.body,
                }}
              >
                {submitting ? "处理中…" : "确认"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
