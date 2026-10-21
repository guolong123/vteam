/**
 * ServeEventStream：opencode serve **v2** `GET /api/event` SSE 总线的实时订阅客户端（裸 fetch，无依赖）。
 *
 * 背景：worker 原先生成「流式」靠 500ms 轮询 GET /session/{id}/message 拿累积快照做 diff
 * ——天然攒批（快照间的内容一波发出），思考/正文观感为「卡一会然后刷出一片」。serve 自帶
 * SSE 事件总线是实时源：订阅它即可把上游的产生节奏**原速**转发出去，轮询降级为记录/兜底路。
 *
 * v2 契约（**实机抓帧为准，不要以 OpenAPI schema 为准**）：
 * - **帧里没有 `event:` 行**。OpenAPI 声明 SSE data 为 `{id, event, data}` 且 `event` 必填，
 *   但 v2.0.28 运行时**根本不发出该行**——事件类型在 **JSON 载荷的 `type`** 里。
 *   故本解析器**不要求** `event:`，但若将来某个版本开始发它，则**优先取 `event:`**、
 *   缺失时回退 `data.type`（两种形态都接受）。
 * - 帧信封：`{id, created, type, location?, data, durable?}`——**data 是扁平的**
 *   （v1 把一切塞在 `properties` 下）；`durable = {aggregateID, seq, version}` 只在
 *   durable 事件上出现（`session.text.delta` / `session.usage.updated` 上**没有**）。
 * - 心跳以 SSE 注释行（`: heartbeat`）到达。
 * - **`/api/event` 是 volatile 契约**：「a slow consumer overflows and fails the stream,
 *   and events during disconnection are missed」——不重放历史帧，断线期间的事件会丢。
 *   ⇒ ① 重连后必须**清空增量缓冲**（续用旧缓冲会拼出一段从未存在过的正文）；
 *     ② 断线期间的权威状态只能**从驱动轮询重建**（见 exec-server 的重连重同步）。
 *
 * 其余约束（沿用 v1 口径）：
 * - `/api/event` 是**全局总线**：同一 serve 实例上所有会话的事件都涌到这条连接，
 *   调用方必须按会话过滤（本类只透传帧，过滤在调用方做）。
 * - 断线自动重连（退避 1s→2s→4s…封顶 10s）；连接错误/解析失败只记日志不抛出，
 *   绝不影响主流程（轮询兜底路独立运行）。
 * - fetch 响应体无超时（长连接语义）；AbortController 仅由 close() 触发。
 */

import { V2EventFrame } from './v2-event-map';

export interface ServeEventStreamOptions {
  /** serve baseUrl（http://127.0.0.1:<port>） */
  baseUrl: string;
  /** serve Basic Auth 密码（空 = 不鉴权） */
  serverPassword?: string;
  /** 收到一个已解析的 v2 事件帧（解析失败的帧不会走到这里）。 */
  onEvent?: (frame: V2EventFrame) => void;
  /** 帧解析失败（非 JSON / 无 type）：计数 + 告警，**不抛**、不中断流。 */
  onMalformed?: (info: { reason: string; sample: string; count: number }) => void;
  /** 连接成活（首帧 `server.connected` 或心跳注释行）。 */
  onOpen?: () => void;
  /** 连接断开（即将自动重连）。`frames` = 本连接收到的帧数。 */
  onClose?: (reason: string, info: { frames: number }) => void;
  /**
   * 重连成功（**不是**首次连接）。
   *
   * 可返回 Promise：返回的 Promise 兑现前**不派发新帧**——调用方在这里做「重连后状态
   * 重同步」（从驱动拉权威快照），保证补齐先于新帧到达，避免旧状态覆盖新状态。
   */
  onReconnect?: (info: { attempt: number }) => void | Promise<void>;
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

/** 一个 SSE 帧（`data:` 拼接结果 + 可选的 `event:` 行）。 */
export interface SseFrame {
  /** 帧的 data 载荷（多行 data 以 `\n` 拼接）。 */
  data: string;
  /** `event:` 行的值（v2 运行时不发；存在时优先于 data.type）。 */
  eventName?: string;
}

/** 一次 push 的结果：完整帧 + 心跳计数。 */
export interface SsePushResult {
  frames: SseFrame[];
  /** 心跳（`: heartbeat` 注释行）计数——心跳说明连接还活着。 */
  heartbeats: number;
}

/** SSE 帧累积器：按空行分帧，data: 行拼接（\n 连接），同时捕获 event: 行与心跳。 */
export class SseFrameBuffer {
  private dataLines: string[] = [];
  private eventName = '';
  private hasEventName = false;

  /** 喂入一段文本块，返回本轮完整的帧与心跳计数。 */
  push(chunk: string): SsePushResult {
    const frames: SseFrame[] = [];
    let heartbeats = 0;
    // 统一换行后按行处理；跨 chunk 的半行由缓冲区天然拼接（chunk 边界即行边界）
    const lines = chunk.split(/\r\n|\r|\n/);
    for (const line of lines) {
      if (line === '') {
        // 空行 = 帧结束
        if (this.dataLines.length > 0) {
          const frame: SseFrame = { data: this.dataLines.join('\n') };
          if (this.hasEventName) {
            frame.eventName = this.eventName;
          }
          frames.push(frame);
          this.dataLines = [];
          this.eventName = '';
          this.hasEventName = false;
        }
        continue;
      }
      if (line.startsWith(':')) {
        // 注释/心跳行：忽略内容，但**计入"连接成活"**（v2 用 `: heartbeat` 保活）
        heartbeats += 1;
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
      if (field === 'data') {
        this.dataLines.push(value);
        continue;
      }
      if (field === 'event') {
        // v2 运行时不发这一行；将来若发了，类型优先取它（缺失时回退 data.type）
        this.eventName = value;
        this.hasEventName = true;
      }
      // id:/retry: 行忽略
    }
    return { frames, heartbeats };
  }
}

/** 帧解析结果。 */
export type V2FrameParseResult =
  | { ok: true; frame: V2EventFrame; typeSource: 'event' | 'data'; dataType: string }
  | { ok: false; reason: string };

/**
 * 解析一帧 v2 事件。
 *
 * - 类型来源：`event:` 行优先，缺失时回退 `data.type`（**不要求** `event:` 行存在）。
 * - 载荷是**扁平**的 `data`（不是 v1 的 `properties`）。
 * - 解析失败（非 JSON / 不是对象 / 无 type）→ 返回失败原因，**绝不抛**（调用方计数 + 告警）。
 */
export function parseV2EventFrame(data: string, eventName?: string): V2FrameParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    return { ok: false, reason: `非 JSON 帧: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: '帧不是 JSON 对象' };
  }
  const envelope = parsed as Record<string, unknown>;
  const dataType = typeof envelope.type === 'string' ? envelope.type : '';
  const hasEvent = typeof eventName === 'string' && eventName !== '';
  const type = hasEvent ? (eventName as string) : dataType;
  if (type === '') {
    return { ok: false, reason: '帧缺少类型（既无 event: 行，data.type 也为空）' };
  }
  const rawData = envelope.data;
  const payload: Record<string, unknown> =
    rawData !== null && typeof rawData === 'object' && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : {};
  const frame: V2EventFrame = {
    id: typeof envelope.id === 'string' ? envelope.id : '',
    type,
    data: payload,
  };
  if (typeof envelope.created === 'number') {
    frame.created = envelope.created;
  }
  const location = envelope.location;
  if (location !== null && typeof location === 'object' && !Array.isArray(location)) {
    const record = location as Record<string, unknown>;
    frame.location = {
      ...(typeof record.directory === 'string' ? { directory: record.directory } : {}),
    };
  }
  const durable = envelope.durable;
  if (durable !== null && typeof durable === 'object' && !Array.isArray(durable)) {
    const record = durable as Record<string, unknown>;
    if (
      typeof record.aggregateID === 'string' &&
      typeof record.seq === 'number' &&
      Number.isFinite(record.seq)
    ) {
      frame.durable = {
        aggregateID: record.aggregateID,
        seq: record.seq,
        version: typeof record.version === 'number' ? record.version : 0,
      };
    }
  }
  return { ok: true, frame, typeSource: hasEvent ? 'event' : 'data', dataType };
}

export class ServeEventStream {
  private readonly opts: ServeEventStreamOptions;
  private readonly log: { info?: (m: string) => void; warn?: (m: string) => void };
  private controller: AbortController | null = null;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** 解析失败的帧计数（可观测：不静默丢帧）。 */
  private malformedCount = 0;
  /** 本连接收到的帧数。 */
  private framesThisConnection = 0;
  /** 本连接是否已经报过"成活"。 */
  private openedThisConnection = false;
  /**
   * 聚合 id → 最后收到的 durable 序号（断线补齐的锚点）。
   *
   * v2 的 `/api/event` 不重放历史帧 ⇒ 断线期间丢掉的 durable 事件只能靠「按 seq 补齐」
   * 或「轮询重建状态」找回。本类**记录**该游标（`lastSeq(aggregateID)`），补齐动作本身
   * 由调用方决定（当前实现走轮询重建，见 exec-server 的重连重同步）。
   */
  private readonly lastSeqByAggregate = new Map<string, number>();

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
  }

  /** 解析失败的帧累计数（可观测）。 */
  get malformedFrames(): number {
    return this.malformedCount;
  }

  /** 某聚合最后收到的 durable 序号（无则 undefined）。 */
  lastSeq(aggregateID: string): number | undefined {
    return this.lastSeqByAggregate.get(aggregateID);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const controller = new AbortController();
    this.controller = controller;
    this.framesThisConnection = 0;
    this.openedThisConnection = false;
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/api/event`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: authHeaders(this.opts.serverPassword),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      // 重连（不是首次连接）→ 通知调用方做状态重同步；**等它做完再派发新帧**，
      // 保证「补齐的旧状态」先于「重连后的新帧」到达（否则新帧可能被旧快照覆盖）。
      if (this.reconnectAttempt > 0 && this.opts.onReconnect) {
        try {
          await this.opts.onReconnect({ attempt: this.reconnectAttempt });
        } catch (err) {
          this.log.warn?.(
            `[sse-forward] 重连回调失败（不影响订阅）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      this.reconnectAttempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const buffer = new SseFrameBuffer();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const pushed = buffer.push(chunk);
        if (pushed.heartbeats > 0) {
          // 心跳说明连接还活着（v2 用 `: heartbeat` 保活）
          this.markOpen();
        }
        for (const frame of pushed.frames) {
          this.handleFrame(frame);
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
    this.opts.onClose?.(reason, { frames: this.framesThisConnection });
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** 连接成活（每条连接只报一次）。 */
  private markOpen(): void {
    if (this.openedThisConnection) {
      return;
    }
    this.openedThisConnection = true;
    this.opts.onOpen?.();
  }

  /** 解析单帧并分派。 */
  private handleFrame(sse: SseFrame): void {
    this.framesThisConnection += 1;
    const parsed = parseV2EventFrame(sse.data, sse.eventName);
    if (!parsed.ok) {
      // 计划 T11 的风险对策：**解析失败的帧必须计数并告警**，不静默丢（但绝不抛）。
      this.malformedCount += 1;
      this.opts.onMalformed?.({
        reason: parsed.reason,
        sample: sse.data.slice(0, 200),
        count: this.malformedCount,
      });
      this.log.warn?.(
        `[sse-forward] 事件帧解析失败（第 ${this.malformedCount} 次，丢弃该帧、不中断流）: ${parsed.reason}`,
      );
      return;
    }
    if (parsed.typeSource === 'event' && parsed.dataType !== '' && parsed.dataType !== parsed.frame.type) {
      // event: 行与 data.type 不一致 → 以 event: 为准（防御性口径），但记一条告警
      this.log.warn?.(
        `[sse-forward] 帧类型不一致（event: 行=${parsed.frame.type}，data.type=${parsed.dataType}），按 event: 行解析`,
      );
    }
    if (parsed.frame.durable) {
      const { aggregateID, seq } = parsed.frame.durable;
      const previous = this.lastSeqByAggregate.get(aggregateID);
      if (previous === undefined || seq > previous) {
        this.lastSeqByAggregate.set(aggregateID, seq);
      }
    }
    if (parsed.frame.type === 'server.connected') {
      // 连接成活信号：由客户端消费，不进事件映射
      this.markOpen();
      return;
    }
    this.opts.onEvent?.(parsed.frame);
  }
}
