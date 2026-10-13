/**
 * ServeEventStream：opencode serve `GET /event` SSE 总线的实时订阅客户端（裸 fetch，无依赖）。
 *
 * 背景：worker 原先生成「流式」靠 500ms 轮询 GET /session/{id}/message 拿累积快照做 diff
 * ——天然攒批（快照间的内容一波发出），思考/正文观感为「卡一会然后刷出一片」。serve 自帶
 * SSE 事件总线（opencode TUI/web UI 的实时源）：message.part.updated（整 part 快照，
 * properties.part）+ message.part.delta（流式增量，properties {partID, field, delta}）。
 * 订阅它即可把 serve 的产生节奏**原速**转发出去，轮询降级为记录/兜底路（见 exec-server）。
 *
 * 契约与约束：
 * - /event 是**全局总线**：同一 serve 实例上所有会话的事件都会涌到这条连接。调用方必须
 *   按 sessionID 过滤（本类只透传 part.sessionID，过滤在 onPart 回调外由调用方做）；
 *   assistant 消息集合由 message.updated 的 info.role 建立（part 本身不带 role）。
 * - message.part.delta 与 message.part.updated 可能并存（不同 opencode 版本行为不同：
 *   有的版本文本增量只走 delta）。两类都处理：delta 按 (partID,field) 累积成合成 part，
 *   part.updated 到达即清对应缓冲（整快照更新、权威覆盖）。
 * - 断线自动重连（退避 1s→2s→4s…封顶 10s）；连接错误/解析失败只记日志不抛出，
 *   绝不影响主流程（轮询兜底路独立运行）。
 * - fetch 响应体无超时（长连接语义）；AbortController 仅由 close() 触发。
 * - SSE 帧解析：`data:` 行可多行拼接；`event:`/`id:`/`:注释` 行忽略；空行分帧。
 *   帧 data 为 JSON：{type, properties}；server.connected 为首帧（用于判定连接成活）。
 */

/** serve 事件帧（宽松读取，未知字段忽略）。 */
export interface ServeEventFrame {
  type?: unknown;
  properties?: unknown;
}

/** 规范化后的 part 回调载荷（合成或快照，统一成 serve part 形状）。 */
export interface ServeStreamPart {
  id: string;
  type: string;
  sessionID?: string;
  messageID?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ServeEventStreamOptions {
  /** serve baseUrl（http://127.0.0.1:<port>） */
  baseUrl: string;
  /** serve Basic Auth 密码（空 = 不鉴权） */
  serverPassword?: string;
  /** part 更新回调（已按会话过滤由调用方负责） */
  onPart: (part: ServeStreamPart) => void;
  /** message.updated 回调：建立 assistant 消息集合（info.id + info.role） */
  onMessageInfo?: (info: { id?: unknown; role?: unknown }) => void;
  /** 连接成活（收到首帧 server.connected） */
  onOpen?: () => void;
  /** 连接断开（错误/对端关闭），即将自动重连 */
  onClose?: (reason: string) => void;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 10000] as const;

function authHeaders(serverPassword?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (serverPassword) {
    // serve Basic Auth：username 固定 opencode（对齐 v1-driver 口径）
    const token = Buffer.from(`opencode:${serverPassword}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  return headers;
}

/** SSE 帧累积器：按空行分帧，data: 行拼接（\n 连接）。 */
class SseFrameBuffer {
  private dataLines: string[] = [];

  /** 喂入一段文本块，返回本轮完整的帧 data 列表。 */
  push(chunk: string): string[] {
    const frames: string[] = [];
    // 统一换行后按行处理；跨 chunk 的半行由缓冲区天然拼接（chunk 边界即行边界）
    const lines = chunk.split(/\r\n|\r|\n/);
    for (const line of lines) {
      if (line === '') {
        // 空行 = 帧结束
        if (this.dataLines.length > 0) {
          frames.push(this.dataLines.join('\n'));
          this.dataLines = [];
        }
        continue;
      }
      if (line.startsWith(':')) {
        continue; // 注释/心跳行
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
      if (field === 'data') {
        this.dataLines.push(value);
      }
      // event:/id:/retry: 行忽略（data 自带 type 字段）
    }
    return frames;
  }
}

export class ServeEventStream {
  private readonly opts: ServeEventStreamOptions;
  private readonly log: { info?: (m: string) => void; warn?: (m: string) => void };
  private controller: AbortController | null = null;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** (partID) → 累积 delta 文本（message.part.delta 流式增量合成用；同 part 的 field 视为稳定）。 */
  private readonly deltaBuffers = new Map<string, { sessionID: string; messageID: string; field: string; text: string }>();

  constructor(opts: ServeEventStreamOptions) {
    this.opts = opts;
    this.log = opts.logger ?? {};
  }

  /** 开始订阅（幂等；重复调用在已运行时安全返回）。 */
  start(): void {
    if (this.closed) return;
    if (this.controller) return;
    void this.connect();
  }

  /** 停止订阅并取消重连。 */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.controller?.abort();
    this.controller = null;
    this.deltaBuffers.clear();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const controller = new AbortController();
    this.controller = controller;
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/event`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: authHeaders(this.opts.serverPassword),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      this.reconnectAttempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const buffer = new SseFrameBuffer();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const data of buffer.push(chunk)) {
          this.handleFrame(data);
        }
      }
      // 对端正常关闭（serve 退出等）
      this.onStreamEnd('stream-closed');
    } catch (err) {
      if (this.closed || controller.signal.aborted) {
        return; // 主动 close() 触发，不重连
      }
      this.onStreamEnd(`error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  /** 流结束：回调 + 退避重连。 */
  private onStreamEnd(reason: string): void {
    if (this.closed) return;
    this.opts.onClose?.(reason);
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** 解析单帧 data（JSON）并分派。 */
  private handleFrame(data: string): void {
    let frame: ServeEventFrame;
    try {
      frame = JSON.parse(data) as ServeEventFrame;
    } catch {
      return; // 非 JSON 帧（异常数据）忽略，不中断流
    }
    const type = typeof frame.type === 'string' ? frame.type : '';
    const props = (frame.properties ?? {}) as Record<string, unknown>;
    if (type === 'server.connected') {
      this.opts.onOpen?.();
      return;
    }
    if (type === 'message.updated') {
      const info = (props.info ?? {}) as Record<string, unknown>;
      this.opts.onMessageInfo?.(info);
      return;
    }
    if (type === 'message.part.updated') {
      const part = props.part as ServeStreamPart | undefined;
      if (part && typeof part.id === 'string' && typeof part.type === 'string') {
        // 整快照到达：清除该 part 的 delta 累积缓冲（权威覆盖，旧增量作废）
        this.deltaBuffers.delete(part.id);
        this.opts.onPart(part);
      }
      return;
    }
    if (type === 'message.part.delta') {
      const partID = typeof props.partID === 'string' ? props.partID : '';
      const field = typeof props.field === 'string' ? props.field : '';
      const delta = typeof props.delta === 'string' ? props.delta : '';
      if (!partID || !delta) return;
      const prev = this.deltaBuffers.get(partID);
      const buf =
        prev && prev.field === field
          ? prev
          : {
              sessionID: typeof props.sessionID === 'string' ? props.sessionID : '',
              messageID: typeof props.messageID === 'string' ? props.messageID : '',
              field,
              text: '',
            };
      buf.text += delta;
      this.deltaBuffers.set(partID, buf);
      // 合成 part：text/reasoning 的增量字段统一成 text（前端取 part.text）
      this.opts.onPart({
        id: partID,
        type: field === 'reasoning' ? 'reasoning' : 'text',
        sessionID: buf.sessionID,
        messageID: buf.messageID,
        text: buf.text,
      });
      return;
    }
    // 其余事件（session.idle / permission.asked / question.asked 等）本路不消费：
    // 完成判定与 question 探测仍走轮询兜底路（exec-server），不在此扩张职责。
  }
}
