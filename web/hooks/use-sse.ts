"use client";

import { useEffect, useRef } from "react";
import { useAuthStore } from "@/lib/stores/authStore";

/**
 * SSE 事件帧（对齐 09 篇 §4 / server realtime.controller 契约）。
 * - id：事件游标（后端 RealtimeService number id，SSE 帧内为字符串）
 * - type：事件名（如 task.status.changed / chat.message.new）
 * - payload：业务数据
 * - timestamp：ISO 时间
 */
export interface SSEEvent<T = unknown> {
  id: string;
  type: string;
  payload: T;
  timestamp: string;
}

/** 断线重建延迟（ms）。后端心跳 15s，此间隔足以即时补拉且不打扰。 */
const RECONNECT_DELAY_MS = 1000;

/** 延迟关闭窗口（ms）：防 React StrictMode dev 双调用（mount→cleanup→mount）误关共享连接。 */
const CLOSE_DELAY_MS = 50;

/* ------------------------------------------------------------------ */
/* 模块级单例连接池：全站每个 token 至多 1 条 SSE 连接（scope 恒 all）， */
/* 所有订阅者共享连接与连接级游标，引用计数管理生命周期。               */
/* ------------------------------------------------------------------ */

interface SharedConnection {
  /** 连接标识 `${token}|all`（token 隔离：登出/切换账号自动分池）。 */
  key: string;
  es: EventSource | null;
  /** 订阅者回调集合（每个 useSSE 实例注册一个包装后的 listener）。 */
  listeners: Set<(e: SSEEvent<unknown>) => void>;
  /** 订阅者引用计数：归零且超过关闭窗口后释放连接。 */
  refCount: number;
  /** 连接级游标：断线重建时拼 since=<lastId> 补拉，补拉事件重放给全部订阅者。 */
  lastId: string;
  /** 首连是否跳过历史重放（连接级语义，由首个订阅者创建连接时决定）。 */
  skipHistory: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
}

const pool = new Map<string, SharedConnection>();

/**
 * 前端 scope 过滤规则（原 URL scope 语义保留为过滤规则；连接 URL 恒 scope=all）。
 * - 缺省 / 空 / "all" → 放行所有事件
 * - 逗号分隔多 scope，任一命中即放行：
 *   - `channel:<id>` → chat.message.new / message.part.delta 且 payload.message.channelId === id
 *                      （message.part.delta 为方案 A 流式增量事件，scope=channel）
 * - `task:<id>`    → agent.loading / agent.error / team.changed / agent.status 且 payload.taskId === id；
 *                    session.updated 例外无条件放行——后端 payload 仅 {sessionId, status, workerId}
 *                    不含 taskId，无法按 id 过滤，由页面经 sessionId→agentId 映射 + 团队成员集合二次过滤
 *   - `global`       → task.status.changed（09 篇 §4.1 全局广播）
 * 供 useSSE（传 scope 的调用方，如看板页 'global'）与 useRealtimeEvents（options.scope）共用。
 */
export function matchesScope(ev: SSEEvent<unknown>, scopeStr?: string): boolean {
  if (!scopeStr || scopeStr === "all") return true;
  const scopes = scopeStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (scopes.length === 0) return true;

  return scopes.some((scope) => {
    if (scope === "global") {
      return ev.type === "task.status.changed";
    }
    if (scope.startsWith("channel:")) {
      const id = scope.slice("channel:".length);
      return (
        (ev.type === "chat.message.new" || ev.type === "message.part.delta") &&
        (ev.payload as { message?: { channelId?: string } })?.message?.channelId === id
      );
    }
    if (scope.startsWith("task:")) {
      const id = scope.slice("task:".length);
      // session.updated payload 无 taskId（仅 {sessionId, status, workerId}），无法按 id 过滤，
      // 无条件放行——页面回调经 sessionId→agentId 映射 + 团队成员集合二次过滤，串扰被兜底。
      if (ev.type === "session.updated") return true;
      return (
        ["agent.loading", "agent.error", "team.changed", "agent.status"].includes(ev.type) &&
        (ev.payload as { taskId?: string })?.taskId === id
      );
    }
    return false;
  });
}

/** 建立 / 重建连接（首连按 skipHistory 决定是否跳过历史；重连 URL 携带连接级 lastId 补拉断线期事件）。 */
function connect(conn: SharedConnection): void {
  const token = conn.key.split("|")[0];
  const params = new URLSearchParams({ token, scope: "all" });
  if (conn.lastId) {
    params.set("since", conn.lastId);
  } else if (conn.skipHistory) {
    // 首连跳过历史重放：since=latest 令服务端仅推送连接时刻之后的新事件
    // （历史数据由各页 REST 加载，SSE 只负责实时增量，见 useSSE 文档）
    params.set("since", "latest");
  }

  conn.es = new EventSource(`/api/v1/events?${params.toString()}`);

  conn.es.onmessage = (ev) => {
    let parsed: SSEEvent<unknown>;
    try {
      parsed = JSON.parse(ev.data) as SSEEvent<unknown>;
    } catch {
      // 非 JSON 帧（异常数据）忽略，不推进游标
      return;
    }
    // 心跳保活帧（data.id 为 null）：不参与业务分发与游标推进
    if (parsed.id == null) return;
    conn.lastId = String(parsed.id);
    for (const listener of conn.listeners) {
      try {
        listener(parsed);
      } catch {
        // 订阅者异常不阻塞其余订阅者分发
      }
    }
  };

  conn.es.onerror = () => {
    // 原生 EventSource 自动重连只带 Last-Event-ID header（服务端不读），
    // 必须关闭后手动重建，并在 URL 中携带 since 游标补拉断线期事件
    conn.es?.close();
    conn.es = null;
    if (conn.refCount <= 0) return; // 已无订阅者，不重连（等待关闭）
    if (conn.retryTimer) clearTimeout(conn.retryTimer);
    conn.retryTimer = setTimeout(() => connect(conn), RECONNECT_DELAY_MS);
  };
}

export interface UseSSEOptions<T = unknown> {
  /** 前端过滤规则（不再拼 URL；连接 URL 恒 scope=all）。
   *  如 "channel:<id>,task:<id>,global"；缺省 / "all" = 放行全部。 */
  scope?: string;
  /** 事件分发回调（仅收到业务事件时调用，心跳帧被过滤）。 */
  onEvent: (event: SSEEvent<T>) => void;
  /** 是否启用连接，默认 true。false 时不注册订阅。 */
  enabled?: boolean;
  /** 首连是否跳过历史重放（默认 true）：true 时首连 URL 携带 since=latest，
   *  服务端仅从连接时刻开始推送新事件（历史由各页 REST 加载，SSE 仅实时增量，
   *  避免首连重放全部历史事件触发整页缓存失效刷请求）；断线重连仍按连接级
   *  lastId 补拉断线期事件。连接为全站单例，连接级行为由首个订阅者创建时决定。 */
  skipHistory?: boolean;
}

/**
 * 前端 SSE 订阅 hook（Phase 2 实时更新基础设施，全站单例连接）。
 *
 * 连接：GET /api/v1/events?token=<authToken>&scope=all&since=<lastId|latest>
 *  - token 通过 query 传递（EventSource 无法设置 header），走 next.config 同源代理
 *  - scope 恒为 all（全量订阅 + 后端按用户可见项目过滤权限）；
 *    options.scope 仅作前端过滤规则（见 matchesScope），语义从「URL scope」变为「过滤规则」
 *  - 首连默认 since=latest（skipHistory 可关）：服务端跳过历史重放，仅推送连接时刻之后的新事件，
 *    避免首连重放全部历史触发各页缓存失效刷请求；历史数据由各页 REST 加载，SSE 只做实时增量
 *  - 原生 EventSource 自动重连不带 since 补拉（服务端只读 ?since=），
 *    故 onerror 时关闭并按固定延迟重建，URL 显式携带连接级游标补拉断线期事件
 *
 * 连接池：模块级 Map<`${token}|all`, SharedConnection>——同 token 的所有订阅者
 * 共享 1 条连接（引用计数 refCount），最后一个订阅者退出且超过关闭窗口后才释放。
 * StrictMode dev 双调用期间 refCount 短暂归零，延迟关闭窗口内重新订阅即取消关闭。
 * 生命周期：token 变化（登出/切换账号）→ key 变化 → 旧连接在订阅者清空后延迟关闭、
 * 新连接按新 token 建立；enabled=false / !token 时不注册。
 */
export function useSSE<T = unknown>(options: UseSSEOptions<T>): void {
  const { onEvent, enabled = true, skipHistory = true } = options;
  const token = useAuthStore((s) => s.token);

  // 回调与过滤规则存 ref：父组件 re-render 不重建连接、不重注册 listener
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const scopeRef = useRef(options.scope);
  scopeRef.current = options.scope;

  useEffect(() => {
    if (!enabled || !token) return;

    const key = `${token}|all`;
    let conn = pool.get(key);
    if (!conn) {
      conn = {
        key,
        es: null,
        listeners: new Set(),
        refCount: 0,
        lastId: "",
        skipHistory,
        retryTimer: null,
        closeTimer: null,
      };
      pool.set(key, conn);
    }

    // 注册订阅者：listener 内部读 ref（scope 过滤 + onEvent 分发），re-render 即时生效
    const listener = (ev: SSEEvent<unknown>) => {
      if (!matchesScope(ev, scopeRef.current)) return;
      onEventRef.current(ev as SSEEvent<T>);
    };
    conn.listeners.add(listener);
    conn.refCount++;

    // 取消 pending 关闭（StrictMode cleanup→mount 或快速切页重挂时保活共享连接）
    if (conn.closeTimer) {
      clearTimeout(conn.closeTimer);
      conn.closeTimer = null;
    }

    // 首个订阅者 → 建立连接
    if (conn.refCount === 1 && !conn.es) {
      connect(conn);
    }

    return () => {
      conn!.listeners.delete(listener);
      conn!.refCount--;
      if (conn!.refCount <= 0) {
        // 延迟关闭：StrictMode 双调用期间 refCount 短暂归零，立即关闭会抖动共享连接；
        // 窗口内新订阅（clearTimeout）则取消关闭。窗口后仍归零 → 释放连接。
        conn!.closeTimer = setTimeout(() => {
          const c = pool.get(key);
          if (c && c.refCount <= 0) {
            c.es?.close();
            c.es = null;
            if (c.retryTimer) clearTimeout(c.retryTimer);
            pool.delete(key);
          }
        }, CLOSE_DELAY_MS);
      }
    };
  }, [token, enabled]);
}
