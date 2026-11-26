export interface StreamingPartLike {
  type?: string;
  synthetic?: boolean;
  text?: unknown;
  summary?: unknown;
  thoughts?: unknown;
  detail?: unknown;
  state?: unknown;
  time?: { end?: unknown };
}

function hasVisibleText(part: StreamingPartLike): boolean {
  return [part.text, part.summary, part.thoughts, part.detail].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function isReasoning(part: StreamingPartLike): boolean {
  return part.type === "reasoning" || part.type === "thinking";
}

function isTerminalReasoning(part: StreamingPartLike): boolean {
  return (
    part.state === "done" ||
    part.state === "completed" ||
    (typeof part.time?.end === "number" && part.time.end > 0)
  );
}

function hasLaterActivity(
  parts: StreamingPartLike[],
  index: number,
  activeType: "reasoning" | "text",
): boolean {
  for (let i = index + 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (activeType === "reasoning") {
      if (part.type === "tool" || part.type === "error" || part.type === "aborted") {
        return true;
      }
      if (part.type === "text" && !part.synthetic && hasVisibleText(part)) {
        return true;
      }
    } else if (isReasoning(part) || part.type === "tool" || part.type === "error" || part.type === "aborted") {
      return true;
    }
  }
  return false;
}

/**
 * 找出当前真正仍在生成的过程片段。
 *
 * 不能只看「是不是最后一条 reasoning/text」：模型输出 reasoning 后会继续调用工具，
 * 此时 reasoning 已完成；只有它后面没有其它可见活动时，才应显示思考中/生成中。
 */
export function findActiveStreamingPart<T extends StreamingPartLike>(
  parts: T[],
  streaming: boolean,
  activeType: "reasoning" | "text",
): T | undefined {
  if (!streaming) return undefined;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    const matches = activeType === "reasoning" ? isReasoning(part) : part.type === "text";
    if (!matches || !hasVisibleText(part) || part.synthetic === true) continue;
    if (activeType === "reasoning" && isTerminalReasoning(part)) continue;
    if (hasLaterActivity(parts, i, activeType)) continue;
    return part;
  }
  return undefined;
}
