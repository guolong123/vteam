/**
 * B2 连续同发送者消息分组谓词（chat-ux-hierarchy-and-streaming 复选框 5）
 * =============================================
 * 列表中的一条消息是否与「上一条」共享身份栏：仅当两条都是 agent、senderId 相同且非空、
 * 本地日历日相同、时间差 ≤ MESSAGE_GROUP_MAX_GAP_MS（5 分钟）时返回 true。
 * user/system/external、换发送者、空或缺失 senderId、缺失或不可解析 createdAt、跨日
 * 一律返回 false（独立渲染）。纯函数：不读数据源、不排序、不依赖组件与运行环境。
 */
export interface GroupableMessage {
  senderType?: string | null;
  senderId?: string | null;
  createdAt?: string | null;
}

/** 分组时间上界：恰好 5 分钟仍分组，5 分钟 + 1 毫秒即独立。 */
export const MESSAGE_GROUP_MAX_GAP_MS = 5 * 60 * 1000;

function toTime(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value === "") return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/** 本地日历日键（年-月-日）：跨日判定跟随浏览器本地时区，与消息时间展示口径一致。 */
function localDayKey(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function isGroupedWithPrevious(
  previous: GroupableMessage | undefined,
  current: GroupableMessage | undefined,
): boolean {
  if (!previous || !current) return false;
  if (previous.senderType !== "agent" || current.senderType !== "agent") return false;
  const prevId = previous.senderId;
  const currId = current.senderId;
  if (typeof prevId !== "string" || prevId === "") return false;
  if (typeof currId !== "string" || currId === "") return false;
  if (prevId !== currId) return false;
  const prevTime = toTime(previous.createdAt);
  const currTime = toTime(current.createdAt);
  if (prevTime === null || currTime === null) return false;
  if (localDayKey(prevTime) !== localDayKey(currTime)) return false;
  return Math.abs(currTime - prevTime) <= MESSAGE_GROUP_MAX_GAP_MS;
}
