/**
 * B3 跨天日期分隔纯逻辑（chat-ux-hierarchy-and-streaming 复选框 6）
 * =============================================
 * - localDateKey：按浏览器本地时区把 createdAt 归约为本地日历日键 `YYYY-MM-DD`（月/日补零）。
 *   与消息时间展示（formatTime 的本地 HH:MM）同口径；缺失、空串、不可解析 → null，永不抛异常。
 * - dateSeparatorFlags：长度恒等于入参长度，只回答「这条之前要不要插分隔」，不排序、不改数据。
 *   仅当「当前条日键」与「上一个已知日键」都存在且不同才为 true；时间缺失/非法的条自身永远为 false，
 *   也不清空已累积日键（这样跨缺失行的跨天仍能分隔，而单日列表恒为零分隔）。
 * - formatDateSeparatorLabel：日键 → `YYYY/MM/DD` 展示文案。
 */
export interface DatedMessage {
  createdAt?: string | null;
}

export function localDateKey(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  const d = new Date(time);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export function dateSeparatorFlags(messages: readonly DatedMessage[]): boolean[] {
  let lastKnownKey: string | null = null;
  return messages.map((message) => {
    const key = localDateKey(message.createdAt);
    if (key === null) return false;
    const changed = lastKnownKey !== null && key !== lastKnownKey;
    lastKnownKey = key;
    return changed;
  });
}

export function formatDateSeparatorLabel(key: string): string {
  return key.replace(/-/g, "/");
}
